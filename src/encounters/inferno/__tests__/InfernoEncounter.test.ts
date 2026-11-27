import { afterEach, describe, expect, it, vi } from 'vitest';
import { isNpcTargetable, type NpcActor } from '../../../core/actors/NpcActor';
import type { ArenaConfig } from '../../../core/arena/ArenaConfig';
import { hasLineOfSight } from '../../../core/combat/distance';
import {
  clearResolvedArenaConfigs,
  getArenaConfig,
  getCollisionMap,
  isWalkableTile,
  SIMULATION_START_TICK,
  setArenaConfig,
  setDefaultArenaConfig,
  setResolvedArenaConfig,
} from '../../../core/constants';
import { generatorDecisionRandom } from '../../../core/decisionRandom';
import type { InfernoSnapshot } from '../../../core/encounters/snapshot';
import type { EncounterPracticeRestart } from '../../../core/encounters/types';
import type { EngineRunConfig } from '../../../core/engineRunConfig';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import type { GameEvent } from '../../../core/events/types';
import type { NpcDefinitionContext } from '../../../core/npcs';
import { canMoveInDirection } from '../../../core/pathfinder';
import { ReplayRecorder, type ReplayRecorderData } from '../../../core/ReplayRecorder';
import { SimulationEngine } from '../../../core/SimulationEngine';
import type { WorldState } from '../../../core/WorldState';
import { INFERNO_WAVE_NPC_IDS } from '../../../npcs/inferno/constants';
import { jadDefinition } from '../../../npcs/inferno/jad';
import type { Projection2D } from '../../../render/core/camera';
import { createQueue } from '../../../render/core/commands';
import { UIOverlayRenderer } from '../../../render/overlay/UIOverlayRenderer';
import { ReplayPresentationStateSchema } from '../../../replay/format/presentationFormat';
import { diffResumableState } from '../../../replay/resumableState';
import { CacheSystem } from '../../../rs/cache/CacheSystem';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { Bzip2 } from '../../../rs/compression/Bzip2';
import { ArchiveLocTypeLoader } from '../../../rs/config/loctype/LocTypeLoader';
import { readCacheZipFiles } from '../../../test/helpers/cacheZipFiles';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { findProjectCacheZip, skipWithoutRealCache } from '../../../test/helpers/real-cache';
import { validPresentationSample } from '../../../test/helpers/replayFixtures';
import { type Coordinate, type MechanicsConfig, PrayerType, type SimulationState } from '../../../types/simulation';
import { encounterRegistry } from '../../registry';
import { createSimulationEngineFromRunConfig, reconstructReplayPrefix } from '../../simulationEngineFactory';
import { ZUK_INTRO, ZUK_INTRO_MESSAGES, ZUK_INTRO_RISE_CLIP } from '../../zuk/constants';
import { buildZukControls } from '../../zuk/controls';
import { INFERNO_DEBUG_ACTIONS, type InfernoCommand } from '../commands';
import {
  FIRST_INFERNO_WAVE,
  FIRST_WAVE_DELAY_TICKS,
  INFERNO_DEFAULT_START_WAVE,
  INFERNO_PRACTICE_START_TILE,
  INFERNO_SPAWN_SLOTS,
  PRACTICE_START_WAVE_DELAY_TICKS,
  ZUK_INTRO_DELAY_TICKS,
  ZUK_WAVE,
} from '../constants';
import {
  buildInfernoControls,
  INFERNO_DESTROYED_PILLAR_KEYS,
  INFERNO_PINNED_WAVE_KEY,
  INFERNO_SPAWN_LAYOUT_KEY,
  INFERNO_START_TILE_KEY,
  INFERNO_START_WAVE_KEY,
  infernoPillarKey,
  infernoRunSetupKey,
  resolveInfernoRunSetup,
} from '../controls';
import { InfernoEncounter } from '../InfernoEncounter';
import { npcDecisionSeed, pickWaveNibblerTarget, planWaveSpawns, waveNpcRandom } from '../layout';
import { composePillarArena, INFERNO_PILLARS, pillarFootprint } from '../pillars';
import { infernoRunStartedWith, infernoSession } from '../practiceChrome';
import { INFERNO_RENDER_CONFIG } from '../renderConfig';
import { InfernoSceneObjectController } from '../sceneObjects';
import type { InfernoWaveServices } from '../spawners';
import { parseSpawnLayout } from '../spawnLayout';
import { waveSpawnKinds } from '../waves';

const EMPTY_ARENA: ArenaConfig = { bounds: null, walkableTiles: null, collisionMap: null };

afterEach(() => {
  vi.restoreAllMocks();
  clearResolvedArenaConfigs();
  setDefaultArenaConfig(EMPTY_ARENA);
  setArenaConfig(EMPTY_ARENA, true);
});

/** The arena floor, walkable everywhere, as a cache bake would give it without the pillars. */
function openArena(): ArenaConfig {
  const walkableTiles = new Set<string>();
  for (let x = 17; x <= 45; x++) for (let y = 17; y <= 46; y++) walkableTiles.add(`${x},${y}`);
  return {
    bounds: { minX: 17, maxX: 45, minY: 17, maxY: 46, width: 29, height: 30 },
    walkableTiles,
    collisionMap: null,
  };
}

/**
 * A run opened on wave 1 (on its landing tile), then given `mechanics` at tick 0 as the practice
 * pane's edits are: these suites name wave 1 rather than lean on the default start (wave 69).
 */
function setup(mechanics: Partial<MechanicsConfig> = {}, seed = 7) {
  setResolvedArenaConfig('inferno', openArena());
  const encounter = new InfernoEncounter(seed);
  const waveOne = { [INFERNO_START_WAVE_KEY]: String(FIRST_INFERNO_WAVE) };
  const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5, mechanics: waveOne });
  engine.setMechanicsConfig({ infiniteHealth: true, ...waveOne, ...mechanics });
  const world = Reflect.get(engine, 'worldState') as WorldState;
  return { encounter, engine, world };
}

type Run = ReturnType<typeof setup>;

/** A run started on wave 1 spawns it 11 ticks after control, as the captured entry does. */
const ENTRY_SPAWN = SIMULATION_START_TICK + FIRST_WAVE_DELAY_TICKS;
/** A run started on waves 2-68 spawns its wave on the first tick after GO (a practice convenience). */
const SPAWN = SIMULATION_START_TICK + PRACTICE_START_WAVE_DELAY_TICKS;

/** Advances to `tick`, returning each tick's events. */
function advanceTo({ engine }: Run, tick: number): Map<number, readonly GameEvent[]> {
  const events = new Map<number, readonly GameEvent[]>();
  while (engine.currentTick < tick) {
    const before = engine.currentTick;
    engine.advanceTick(engine.getState().playerPosition);
    // A run that cannot advance (the player died, the run ended) would otherwise spin forever.
    if (engine.currentTick === before) throw new Error(`the run stopped at tick ${before}, short of ${tick}`);
    events.set(engine.currentTick, engine.getLastTickEvents());
  }
  return events;
}

function messages(events: readonly GameEvent[] | undefined): string[] {
  return (events ?? []).flatMap((event) =>
    event.type === 'game_message' && event.kind === 'game'
      ? [(event.segments as readonly { text: string }[]).map((segment) => segment.text).join('')]
      : [],
  );
}

function waveNpcs({ world }: Run): NpcActor[] {
  return world.getNpcs().filter((npc) => npc.id.startsWith('inferno_') && !npc.id.startsWith('inferno_pillar'));
}

function pillarProxies({ world }: Run): NpcActor[] {
  return world.getNpcs().filter((npc) => npc.npcTypeId === 7709);
}

/** A lethal hit from the player, landing on the target's next turn. */
function kill(run: Run, npc: NpcActor, damage = npc.vitals.hp): void {
  const tick = run.engine.currentTick;
  enqueueEnginePendingHit(run.engine, {
    sourceId: 'player',
    targetId: npc.id,
    style: 'typeless',
    attackKind: 'typeless',
    launchTick: tick,
    impactTick: tick + 1,
    rolledDamage: damage,
    accuracySucceeded: true,
  });
}

/** Freezes NPCs in place (binds hold movement engine-side). */
function bind(npcs: readonly NpcActor[]): void {
  for (const npc of npcs) npc.debuffs = { ...npc.debuffs, boundFromTick: 0, boundUntilTick: 100_000 };
}

/** Kills everything in the wave that is alive, then advances until the wave completes. */
function clearWave(run: Run, limit = 200): number {
  const start = run.engine.currentTick;
  while (run.engine.currentTick < start + limit) {
    for (const npc of waveNpcs(run)) if (npc.alive) kill(run, npc);
    const events = advanceTo(run, run.engine.currentTick + 1);
    if (messages(events.get(run.engine.currentTick)).includes('Wave completed!')) return run.engine.currentTick;
  }
  throw new Error('Wave did not complete');
}

describe('Inferno director', () => {
  it('starts a later wave on the landing tile and spawns its whole batch with its message on the first tick', () => {
    const run = setup({ infernoStartWave: '30' });
    expect(run.engine.getState().playerPosition).toEqual([30, 32]);
    expect(SPAWN).toBe(1);
    const events = advanceTo(run, SPAWN);
    expect(messages(events.get(SPAWN))).toEqual(['Wave: 30']);
    const message = events.get(SPAWN)?.find((event) => event.type === 'game_message');
    expect(message).toMatchObject({ segments: [{ text: 'Wave: 30', color: '#ef1020' }] });
    const npcs = waveNpcs(run);
    expect(npcs.map((npc) => npc.npcTypeId)).toEqual(waveSpawnKinds(30).map((kind) => INFERNO_WAVE_NPC_IDS[kind]));
    expect(npcs.map((npc) => npc.position)).toEqual(planWaveSpawns(7, 30).map((placement) => placement.position));
    expect(npcs.every((npc) => npc.spawnTick === SPAWN)).toBe(true);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 30, phase: 'active', startWave: 30 } });
    // Nothing more at the entry's +11: the wave came once, on GO.
    const later = advanceTo(run, ENTRY_SPAWN);
    expect([...later.values()].flatMap((tickEvents) => messages(tickEvents))).toEqual([]);
    expect(waveNpcs(run)).toHaveLength(npcs.length);
  });

  it('spawns wave 1 of a run started there 11 ticks after control, as the captured entry does', () => {
    const run = setup({ infernoStartWave: '1' });
    const events = advanceTo(run, ENTRY_SPAWN);
    expect(ENTRY_SPAWN).toBe(11);
    expect([...events].filter(([, tickEvents]) => messages(tickEvents).length > 0).map(([tick]) => tick)).toEqual([
      ENTRY_SPAWN,
    ]);
    expect(messages(events.get(ENTRY_SPAWN))).toEqual(['Wave: 1']);
    expect(waveNpcs(run).every((npc) => npc.spawnTick === ENTRY_SPAWN)).toBe(true);
  });

  it('completes on the tick the last NPC is removed and spawns the next wave 6 ticks later', () => {
    const run = setup({ infernoStartWave: '1' });
    advanceTo(run, ENTRY_SPAWN);
    const [bat, ...nibblers] = waveNpcs(run);
    for (const nibbler of nibblers) kill(run, nibbler);
    advanceTo(run, 25);
    expect(nibblers.every((nibbler) => run.world.getNpc(nibbler.id) === null)).toBe(true);
    kill(run, bat);
    let removedAt: number | null = null;
    let completedAt: number | null = null;
    for (let tick = 26; tick < 50 && completedAt === null; tick++) {
      const events = advanceTo(run, tick);
      if (removedAt === null && run.world.getNpc(bat.id) === null) removedAt = tick;
      if (messages(events.get(tick)).includes('Wave completed!')) completedAt = tick;
    }
    expect(bat.deathAnimationTick).toBeDefined();
    expect(removedAt).toBe((bat.deathAnimationTick ?? 0) + 2);
    expect(completedAt).toBe(removedAt);
    const completion = completedAt ?? 0;
    expect(run.engine.getEncounterSnapshot()).toMatchObject({
      state: { wave: 2, phase: 'countdown', nextWaveTick: completion + 6 },
    });
    const events = advanceTo(run, completion + 6);
    expect(messages(events.get(completion + 5))).toEqual([]);
    expect(messages(events.get(completion + 6))).toEqual(['Wave: 2']);
    expect(waveNpcs(run)).toHaveLength(5);
  });

  it('waits for blob children added on the blob removal tick', () => {
    const run = setup({ infernoStartWave: '4' });
    advanceTo(run, SPAWN);
    const blob = waveNpcs(run).find((npc) => npc.npcTypeId === INFERNO_WAVE_NPC_IDS.blob);
    if (!blob) throw new Error('missing blob');
    for (const npc of waveNpcs(run)) kill(run, npc);
    let children: NpcActor[] = [];
    for (let tick = SPAWN + 1; tick < SPAWN + 19 && children.length === 0; tick++) {
      const events = advanceTo(run, tick);
      expect(messages(events.get(tick))).not.toContain('Wave completed!');
      children = waveNpcs(run).filter((npc) => [7694, 7695, 7696].includes(npc.npcTypeId));
      if (children.length > 0) {
        expect(run.world.getNpc(blob.id)).toBeNull();
        expect(tick).toBe((blob.deathAnimationTick ?? 0) + 2);
        expect(children.every((child) => child.spawnTick === tick)).toBe(true);
      }
    }
    expect(children.map((child) => child.npcTypeId).sort()).toEqual([7694, 7695, 7696]);
    const completedAt = clearWave(run);
    expect(children.every((child) => run.world.getNpc(child.id) === null)).toBe(true);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 5, nextWaveTick: completedAt + 6 } });
  });

  it('removes a Jad with his healers and continues from 67 to 68, then on into wave 69', () => {
    const run = setup({ infernoStartWave: '67' });
    advanceTo(run, SPAWN);
    const [jad] = waveNpcs(run);
    expect(jad).toMatchObject({ npcTypeId: INFERNO_WAVE_NPC_IDS.jad, position: [25, 35] });
    kill(run, jad, 200);
    advanceTo(run, SPAWN + 1);
    const healers = waveNpcs(run).filter((npc) => npc.npcTypeId === INFERNO_WAVE_NPC_IDS.jad_healer);
    expect(healers).toHaveLength(5);
    // The fitted policy: distinct tiles 4-8 from the Jad's center (27,37), never the player's.
    expect(new Set(healers.map((healer) => String(healer.position))).size).toBe(5);
    const player = run.world.getPlayer()?.position;
    for (const healer of healers) {
      const [x, y] = healer.position;
      const distance = Math.hypot(x - 27, y - 37);
      expect(distance).toBeGreaterThanOrEqual(4);
      expect(distance).toBeLessThanOrEqual(8);
      expect(healer.position).not.toEqual(player);
    }
    kill(run, jad, 400);
    let completedAt: number | null = null;
    for (let tick = SPAWN + 2; tick < SPAWN + 29 && completedAt === null; tick++) {
      const events = advanceTo(run, tick);
      if (messages(events.get(tick)).includes('Wave completed!')) completedAt = tick;
    }
    expect(completedAt).toBe((jad.deathAnimationTick ?? 0) + 6);
    expect(healers.every((healer) => run.world.getNpc(healer.id) === null)).toBe(true);
    expect(run.engine.getEncounterOutcome().phase).toBe('active');

    advanceTo(run, (completedAt ?? 0) + 6);
    const jads = waveNpcs(run);
    expect(jads.map((npc) => npc.position)).toEqual(planWaveSpawns(7, 68).map((placement) => placement.position));
    expect(jads.map((npc) => jadDefinition.getState(npc))).toMatchObject(
      [4, 7, 10].map((initialDelayTicks) => ({ initialDelayTicks, rangedMagicPeriod: 9 })),
    );
    const clearedAt = clearWave(run);
    // Wave 68 is not the end: the run goes on to wave 69, whose control is 18 ticks later.
    expect(run.engine.getEncounterOutcome().phase).toBe('active');
    expect(run.engine.getEncounterSnapshot()).toMatchObject({
      state: { wave: 69, phase: 'countdown', nextWaveTick: clearedAt + 18, zuk: null },
      visuals: { zukControlTick: clearedAt + 18 },
    });
  });

  it.each([
    { wave: '1', nibblers: 3 },
    { wave: '3', nibblers: 6 },
  ])('sends every nibbler of wave $wave to the one pillar the wave drew', ({ wave, nibblers }) => {
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const run = setup({ infernoStartWave: wave }, seed);
      advanceTo(run, (wave === '1' ? ENTRY_SPAWN : SPAWN) + 1);
      const batch = waveNpcs(run).filter((npc) => npc.npcTypeId === INFERNO_WAVE_NPC_IDS.nibbler);
      expect(batch).toHaveLength(nibblers);
      const expected = pickWaveNibblerTarget(seed, Number(wave), ['west', 'south', 'northEast']);
      expect(new Set(batch.map((npc) => npc.combat.targetId))).toEqual(new Set([`inferno_pillar_${expected}`]));
    }
    // Independent uniform rolls off the wave's NPC stream would have split at least one of those batches.
    const splits = [1, 2, 3, 4, 5, 6, 7, 8].some((seed) => {
      const random = waveNpcRandom(seed, Number(wave));
      return new Set(Array.from({ length: nibblers }, () => Math.floor(random() * 3))).size > 1;
    });
    expect(splits).toBe(true);
  });

  it('draws the shared pillar per wave, among the pillars still standing', () => {
    const picks = Array.from({ length: 20 }, (_, index) =>
      pickWaveNibblerTarget(7, index + 1, ['west', 'south', 'northEast']),
    );
    expect(new Set(picks).size).toBe(3);
    expect(pickWaveNibblerTarget(7, 5, [])).toBeNull();
    const run = setup({ infernoStartWave: '1', [INFERNO_DESTROYED_PILLAR_KEYS.south]: true }, 7);
    const chosen: string[] = [];
    for (let wave = 1; wave <= 6; wave++) {
      while (waveNpcs(run).length === 0) advanceTo(run, run.engine.currentTick + 1);
      // One turn after the add tick, every nibbler has resolved its target.
      advanceTo(run, run.engine.currentTick + 1);
      const targets = new Set(
        waveNpcs(run)
          .filter((npc) => npc.npcTypeId === INFERNO_WAVE_NPC_IDS.nibbler)
          .map((npc) => npc.combat.targetId),
      );
      expect(targets).toEqual(new Set([`inferno_pillar_${pickWaveNibblerTarget(7, wave, ['west', 'northEast'])}`]));
      chosen.push([...targets][0] ?? '');
      clearWave(run);
    }
    expect(chosen).not.toContain('inferno_pillar_south');
    expect(new Set(chosen).size).toBe(2);
  });

  it("turns a wave's surviving nibblers on the player once their pillar collapses", () => {
    const run = setup({
      infernoStartWave: '3',
      [INFERNO_DESTROYED_PILLAR_KEYS.west]: true,
      [INFERNO_DESTROYED_PILLAR_KEYS.northEast]: true,
    });
    advanceTo(run, SPAWN + 1);
    const nibblers = waveNpcs(run);
    expect(nibblers.every((npc) => npc.combat.targetId === 'inferno_pillar_south')).toBe(true);
    const south = run.world.getNpc('inferno_pillar_south');
    if (!south) throw new Error('missing pillar');
    enqueueEnginePendingHit(run.engine, {
      sourceId: nibblers[0].id,
      targetId: south.id,
      style: 'melee',
      attackKind: 'melee_crush',
      launchTick: SPAWN + 1,
      impactTick: SPAWN + 2,
      rolledDamage: 255,
      accuracySucceeded: true,
    });
    advanceTo(run, SPAWN + 3);
    const survivors = nibblers.filter((npc) => npc.alive);
    expect(survivors.length).toBeGreaterThan(0);
    expect(survivors.every((npc) => npc.combat.targetId === 'player')).toBe(true);
  });

  it('never moves or heals the player between waves', () => {
    const run = setup({ infernoStartWave: '3' });
    advanceTo(run, SPAWN);
    const player = run.world.getPlayer();
    if (!player) throw new Error('missing player');
    player.vitals.hp = 50;
    const completedAt = clearWave(run);
    advanceTo(run, completedAt + 6);
    expect(run.engine.getState().playerPosition).toEqual([30, 32]);
    expect(player.vitals.hp).toBeLessThanOrEqual(50);
  });

  it('preloads every projectile and graphic the waves draw', () => {
    const preloaded = new Set(INFERNO_RENDER_CONFIG.spotAnimIds);
    const emitted = new Set<number>();
    // Wave 62 fields every non-Jad species; 67 is a Jad.
    for (const wave of ['62', '67']) {
      for (const events of advanceTo(setup({ infernoStartWave: wave }), 150).values()) {
        for (const event of events) {
          if (!isEncounterVisualEvent(event)) continue;
          for (const { spotAnimId } of [...event.projectiles, ...event.graphics]) emitted.add(spotAnimId);
        }
      }
    }
    expect(emitted.size).toBeGreaterThan(5);
    expect([...emitted].filter((id) => !preloaded.has(id))).toEqual([]);
  });
});

describe('Inferno pillars', () => {
  function pillarFlags(x: number, y: number) {
    return getCollisionMap()?.hasFlag(x, y, CollisionFlag.OBJECT | CollisionFlag.OBJECT_PROJECTILE_BLOCKER) ?? false;
  }

  it('stands three invisible 255 HP proxies with collidable, sight-blocking LOCs', () => {
    const run = setup();
    for (const pillar of INFERNO_PILLARS) {
      for (const [x, y] of pillarFootprint(pillar)) {
        expect(pillarFlags(x, y)).toBe(true);
        expect(isWalkableTile(x, y)).toBe(false);
      }
    }
    expect(canMoveInDirection(26, 24, 27, 24)).toBe(false);
    expect(hasLineOfSight(30, 24, 24, 24)).toBe(false);
    advanceTo(run, 1);
    const proxies = pillarProxies(run);
    expect(proxies.map((proxy) => [proxy.position, proxy.size, proxy.vitals.hp])).toEqual(
      INFERNO_PILLARS.map((pillar) => [pillar.position, 3, 255]),
    );
    const rules = run.encounter.getEngineRules();
    for (const proxy of proxies) {
      expect(proxy.untargetable).toBe(true);
      expect(isNpcTargetable(proxy, 1_000_000)).toBe(false);
      expect(
        rules.validateAttack?.('melee_crush', proxy.id, { tick: 1, player: run.world.getPlayer()!, world: run.world }),
      ).toBe(false);
    }
    const controller = new InfernoSceneObjectController();
    const specs = controller
      .update({ state: run.engine.getState(), currentTick: run.engine.currentTick } as never)
      .filter((spec) => spec.id.startsWith('inferno-pillar-'));
    expect(specs.map((spec) => [spec.id, spec.classification, spec.data?.locId])).toEqual([
      ['inferno-pillar-west', 'sceneMesh', 30353],
      ['inferno-pillar-south', 'sceneMesh', 30354],
      ['inferno-pillar-northEast', 'sceneMesh', 30355],
    ]);
  });

  it('keeps pillar damage across waves', () => {
    const run = setup({ infernoStartWave: '3' });
    advanceTo(run, SPAWN);
    const [nibbler] = waveNpcs(run);
    const south = run.world.getNpc('inferno_pillar_south');
    if (!south) throw new Error('missing pillar');
    const hpBefore = south.vitals.hp;
    enqueueEnginePendingHit(run.engine, {
      sourceId: nibbler.id,
      targetId: south.id,
      style: 'melee',
      attackKind: 'melee_crush',
      launchTick: SPAWN,
      impactTick: SPAWN + 1,
      rolledDamage: 40,
      accuracySucceeded: true,
    });
    advanceTo(run, SPAWN + 1);
    const damaged = south.vitals.hp;
    expect(damaged).toBe(hpBefore - 40);
    const completedAt = clearWave(run);
    advanceTo(run, completedAt + 8);
    expect(run.world.getNpc('inferno_pillar_south')).toBe(south);
    expect(south.vitals.hp).toBeLessThanOrEqual(damaged);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 4 } });
  });

  it('shows nibbler hits on a pillar with a 255 HP health bar, though the pillar stays untargetable', () => {
    const run = setup({ infernoStartWave: '3' });
    advanceTo(run, SPAWN);
    const [nibbler] = waveNpcs(run);
    const overlay = new UIOverlayRenderer();
    overlay.setTerrainHeights(null);
    const projection: Projection2D = {
      tileToScreen: (tile) => ({ x: tile.x * 32, y: tile.y * 32 }),
      tileDeltaToScreen: (delta) => delta,
      screenToTile: () => null,
      tilePolygonScreen: () => [],
    };
    const overlaysAt = (tick: number) => {
      const state = run.engine.getState();
      const queue = createQueue();
      overlay.update(tick, [...run.engine.getLastTickEvents()]);
      overlay.buildNpcHitsplats(queue, projection, state.npcs, tick);
      overlay.buildNpcHealthBars(queue, projection, state.npcs, tick, new Set());
      return { state, splats: queue.hitsplats ?? [], bars: queue.healthBars ?? [] };
    };
    const hitPillar = (tick: number, rolledDamage: number) =>
      enqueueEnginePendingHit(run.engine, {
        sourceId: nibbler.id,
        targetId: 'inferno_pillar_south',
        style: 'melee',
        attackKind: 'melee_crush',
        launchTick: tick,
        impactTick: tick + 1,
        rolledDamage,
        accuracySucceeded: true,
      });

    // P:582-593: a nibbler's 4 on the south support's proxy, with its headbar.
    hitPillar(SPAWN, 4);
    advanceTo(run, SPAWN + 1);
    const hit = overlaysAt(SPAWN + 1);
    const proxy = hit.state.npcs.find((npc) => npc.id === 'inferno_pillar_south');
    expect(proxy).toMatchObject({ hp: 251, maxHp: 255, healthBarWhenUntargetable: true });
    // Still not clickable or attackable: the viewport's pick and menus gate on targetability.
    if (!proxy) expect.fail('missing proxy');
    expect(isNpcTargetable(proxy, SPAWN + 1)).toBe(false);
    expect(hit.splats.map(({ key, amount }) => [key, amount])).toEqual([['hitsplat-inferno_pillar_south-slot-0', 4]]);
    expect(hit.bars).toEqual([
      expect.objectContaining({ key: 'npc-healthbar-inferno_pillar_south', ratio: 251 / 255 }),
    ]);

    // A collapse removes the proxy and its bar with it.
    hitPillar(SPAWN + 1, 251);
    advanceTo(run, SPAWN + 2);
    const collapsed = overlaysAt(SPAWN + 2);
    expect(collapsed.state.npcs.some((npc) => npc.id === 'inferno_pillar_south')).toBe(false);
    expect(collapsed.bars.map(({ key }) => key)).not.toContain('npc-healthbar-inferno_pillar_south');
  });

  it('collapses at 0 HP: proxy and LOC go, 7710 plays for 2 ticks and kills only adjacent nibblers', () => {
    const run = setup({ infernoStartWave: '3' });
    advanceTo(run, SPAWN);
    const nibblers = waveNpcs(run);
    // South pillar footprint x 27-29, y 23-25: one nibbler on its north edge, one on its far corner,
    // the rest away from it.
    nibblers[0].position = [27, 26];
    nibblers[1].position = [30, 22];
    nibblers.slice(2).forEach((npc, index) => {
      npc.position = [22 + index, 30];
    });
    bind(nibblers);
    const south = run.world.getNpc('inferno_pillar_south');
    if (!south) throw new Error('missing pillar');
    const playerHp = run.world.getPlayer()?.vitals.hp;
    enqueueEnginePendingHit(run.engine, {
      sourceId: nibblers[0].id,
      targetId: south.id,
      style: 'melee',
      attackKind: 'melee_crush',
      launchTick: SPAWN,
      impactTick: SPAWN + 1,
      rolledDamage: 255,
      accuracySucceeded: true,
    });
    const events = advanceTo(run, SPAWN + 1);
    expect(run.world.getNpc(south.id)).toBeNull();
    const collapse = run.world.getNpc('inferno_pillar_south_collapse');
    expect(collapse).toMatchObject({ npcTypeId: 7710, position: [27, 23], spawnTick: SPAWN + 1 });
    expect(events.get(SPAWN + 1)).toContainEqual(
      expect.objectContaining({
        type: 'inferno_pillar_collapse',
        pillar: 'south',
        soundId: 1021,
        soundPosition: [28, 24],
      }),
    );
    expect(nibblers.slice(0, 2).map((npc) => npc.vitals.hp)).toEqual([0, 0]);
    expect(nibblers.slice(2).every((npc) => npc.vitals.hp === npc.vitals.maxHp)).toBe(true);
    expect(run.world.getPlayer()?.vitals.hp).toBe(playerHp);
    for (const [x, y] of pillarFootprint(INFERNO_PILLARS[1])) {
      expect(pillarFlags(x, y)).toBe(false);
      expect(isWalkableTile(x, y)).toBe(true);
    }
    expect(canMoveInDirection(26, 24, 27, 24)).toBe(true);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({
      state: { pillars: [{ key: 'west', intact: true }, { key: 'south', intact: false, hp: 0 }, { key: 'northEast' }] },
      visuals: { pillarLocs: [{ key: 'west' }, { key: 'northEast' }] },
    });

    // An engine reinstall (cache resolution, takeover) keeps the collapse.
    run.engine.reapplyArenaConfig();
    expect(pillarFlags(28, 24)).toBe(false);
    expect(pillarFlags(18, 38)).toBe(true);

    advanceTo(run, SPAWN + 2);
    expect(run.world.getNpc('inferno_pillar_south_collapse')).not.toBeNull();
    advanceTo(run, SPAWN + 3);
    expect(run.world.getNpc('inferno_pillar_south_collapse')).toBeNull();
  });

  it('kills every nibbler beside a naturally collapsing pillar, in hit-queue order, however it moves', () => {
    // Unbound and unscripted: seed 7, wave 3, the player standing on the landing tile.
    const run = setup({ infernoStartWave: '3' });
    let collapse: { tick: number; pillar: string } | null = null;
    let beside: NpcActor[] = [];
    while (collapse === null && run.engine.currentTick < 800) {
      const proxies = new Map(pillarProxies(run).map((proxy) => [proxy.id, proxy]));
      // Living nibblers beside a pillar at the end of the tick before (they may still move this tick).
      const before = waveNpcs(run).filter((npc) => npc.alive);
      const tick = run.engine.currentTick + 1;
      const events = advanceTo(run, tick).get(tick) ?? [];
      const event = events.find((candidate) => candidate.type === 'inferno_pillar_collapse');
      if (!event) continue;
      collapse = { tick, pillar: String(Reflect.get(event, 'pillar')) };
      const pillar = INFERNO_PILLARS.find((candidate) => candidate.key === collapse?.pillar);
      if (!pillar) throw new Error('unknown pillar');
      const proxyId = `inferno_pillar_${pillar.key}`;
      expect(proxies.has(proxyId)).toBe(true);
      beside = before.filter((npc) => {
        const [x, y] = npc.position;
        const [px, py] = pillar.position;
        return x >= px - 1 && x <= px + 3 && y >= py - 1 && y <= py + 3;
      });
    }
    if (!collapse) throw new Error('no pillar collapsed');
    advanceTo(run, collapse.tick + 1);
    const collapseHits = run.engine
      .getDamageHistory()
      .filter((entry) => entry.sourceNpcTypeId === 7710 && entry.tick >= collapse.tick);
    expect(beside.length).toBeGreaterThan(0);
    for (const npc of beside) {
      expect(npc.vitals.hp, npc.id).toBe(0);
      expect(collapseHits.some((entry) => entry.targetId === npc.id)).toBe(true);
    }
    // The hit queue's order: a victim acting after the collapse takes it that tick, one before it next tick.
    expect(collapseHits.every((entry) => entry.tick === collapse.tick || entry.tick === collapse.tick + 1)).toBe(true);
    expect(collapseHits.map((entry) => entry.targetId).sort()).toEqual(
      [...new Set(collapseHits.map((entry) => entry.targetId))].sort(),
    );
  });

  it('hits a victim whose turn already passed one tick after the collapse', () => {
    // Only the south pillar stands, so it is the wave's nibbler target.
    const run = setup({
      infernoStartWave: '3',
      [INFERNO_DESTROYED_PILLAR_KEYS.west]: true,
      [INFERNO_DESTROYED_PILLAR_KEYS.northEast]: true,
    });
    advanceTo(run, SPAWN);
    const [early, collapser, late] = waveNpcs(run);
    early.position = [27, 26];
    collapser.position = [28, 26];
    late.position = [29, 26];
    bind(waveNpcs(run));
    for (const npc of waveNpcs(run).slice(3)) npc.position = [22, 30];
    const south = run.world.getNpc('inferno_pillar_south');
    if (!south) throw new Error('missing pillar');
    south.vitals.hp = 1;
    // Only the middle nibbler swings; its hit empties the proxy inside its own turn.
    early.combat.nextActionTick = 1000;
    late.combat.nextActionTick = 1000;
    let collapseTick: number | null = null;
    for (let tick = SPAWN + 1; tick < SPAWN + 49 && collapseTick === null; tick++) {
      const events = advanceTo(run, tick);
      if (events.get(tick)?.some((event) => event.type === 'inferno_pillar_collapse')) collapseTick = tick;
    }
    if (collapseTick === null) throw new Error('no collapse');
    const hitTick = (npc: NpcActor) =>
      run.engine.getDamageHistory().find((entry) => entry.sourceNpcTypeId === 7710 && entry.targetId === npc.id)?.tick;
    advanceTo(run, collapseTick + 1);
    expect([hitTick(early), hitTick(collapser), hitTick(late)]).toEqual([
      collapseTick + 1,
      collapseTick + 1,
      collapseTick,
    ]);
  });

  it('collapses every standing pillar on the wave-66 completion tick and removes the rubble after 3 ticks', () => {
    const run = setup({ infernoStartWave: '66', [INFERNO_DESTROYED_PILLAR_KEYS.west]: true });
    advanceTo(run, SPAWN);
    const completedAt = clearWave(run);
    expect(pillarProxies(run)).toEqual([]);
    expect(run.world.getNpc('inferno_pillar_south_collapse')?.spawnTick).toBe(completedAt);
    expect(run.world.getNpc('inferno_pillar_northEast_collapse')?.spawnTick).toBe(completedAt);
    expect(run.world.getNpc('inferno_pillar_west_collapse')).toBeNull();
    advanceTo(run, completedAt + 2);
    expect(run.world.getNpc('inferno_pillar_south_collapse')).not.toBeNull();
    advanceTo(run, completedAt + 3);
    expect(run.world.getNpc('inferno_pillar_south_collapse')).toBeNull();
    for (const pillar of INFERNO_PILLARS)
      for (const [x, y] of pillarFootprint(pillar)) expect(pillarFlags(x, y)).toBe(false);
    const events = advanceTo(run, completedAt + 6);
    expect(messages(events.get(completedAt + 6))).toEqual(['Wave: 67']);
  });

  it('starts configured pillars destroyed, and has none from wave 67', () => {
    const run = setup({ [INFERNO_DESTROYED_PILLAR_KEYS.west]: true, [INFERNO_DESTROYED_PILLAR_KEYS.northEast]: true });
    advanceTo(run, 1);
    expect(pillarProxies(run).map((proxy) => proxy.id)).toEqual(['inferno_pillar_south']);
    expect(pillarFlags(17, 37)).toBe(false);
    expect(isWalkableTile(17, 37)).toBe(true);
    expect(pillarFlags(27, 23)).toBe(true);

    const late = setup({ infernoStartWave: '67' });
    advanceTo(late, 1);
    expect(pillarProxies(late)).toEqual([]);
    expect(late.engine.getEncounterSnapshot().visuals).toEqual({ pillarLocs: [], zukControlTick: null });
  });

  it('applies tick-zero pillar edits and opens or closes either kind of base arena', () => {
    const run = setup();
    run.engine.setMechanicsConfig({ infiniteHealth: true, [INFERNO_DESTROYED_PILLAR_KEYS.south]: true });
    expect(pillarFlags(28, 24)).toBe(false);
    const baked = composePillarArena(openArena(), new Set(['west', 'south', 'northEast']));
    const opened = composePillarArena(baked, new Set(['west']));
    expect(opened.walkableTiles?.has('28,24')).toBe(true);
    expect(opened.collisionMap?.hasFlag(28, 24, CollisionFlag.OBJECT)).toBe(false);
    expect(opened.collisionMap?.hasFlag(18, 38, CollisionFlag.OBJECT)).toBe(true);
    expect(baked.collisionMap?.hasFlag(28, 24, CollisionFlag.OBJECT)).toBe(true);
    const unbounded = composePillarArena(EMPTY_ARENA, new Set(['south']));
    expect(unbounded.walkableTiles).toBeNull();
    expect(unbounded.collisionMap?.hasFlag(28, 24, CollisionFlag.OBJECT_PROJECTILE_BLOCKER)).toBe(true);
  });
});

describe('Inferno corpse ledger', () => {
  function definitionContext(run: Run): NpcDefinitionContext {
    return (Reflect.get(run.engine, 'buildNpcDefinitionContext') as () => NpcDefinitionContext).call(run.engine);
  }

  it('offers eligible corpses killed this wave once, and revives at half HP as a fresh spawn', () => {
    const run = setup({ infernoStartWave: '1' });
    advanceTo(run, ENTRY_SPAWN);
    const [bat, nibbler] = waveNpcs(run);
    kill(run, bat);
    kill(run, nibbler);
    advanceTo(run, 13);
    const services = Reflect.get(run.encounter, 'services') as InfernoWaveServices;
    const corpses = services.resurrection.eligibleCorpses(definitionContext(run));
    expect(corpses).toEqual([{ id: bat.id, species: 'bat' }]);
    services.resurrection.revive(corpses[0], [32, 30], definitionContext(run));
    expect(services.resurrection.eligibleCorpses(definitionContext(run))).toEqual([]);
    const revived = waveNpcs(run).find((npc) => npc.alive && npc.npcTypeId === INFERNO_WAVE_NPC_IDS.bat);
    expect(revived).toMatchObject({ position: [32, 30], spawnTick: 13, vitals: { hp: 13, maxHp: 25 } });
    if (!revived) throw new Error('missing revived bat');
    kill(run, revived);
    advanceTo(run, 16);
    expect(services.resurrection.eligibleCorpses(definitionContext(run))).toEqual([]);
  });
});

describe('Inferno practice setup', () => {
  it('reads the start wave and pillar toggles, falling back to the default, wave 69', () => {
    expect(resolveInfernoRunSetup({ infernoStartWave: '42', infernoSouthPillarDestroyed: true })).toEqual({
      startWave: 42,
      destroyedPillars: { west: false, south: true, northEast: false },
      spawnLayout: null,
      startTile: [34, 44],
    });
    expect(buildInfernoControls().defaultMechanicsConfig[INFERNO_START_TILE_KEY]).toBe('');
    expect(buildInfernoControls().mechanicsToggles.map(({ key }) => key)).not.toContain(INFERNO_START_TILE_KEY);
    expect(resolveInfernoRunSetup({ [INFERNO_SPAWN_LAYOUT_KEY]: '6:-b-l----b' }).spawnLayout).toEqual({
      wave: 6,
      slots: [null, 'bat', null, 'blob', null, null, null, null, 'bat'],
    });
    expect(buildInfernoControls().defaultMechanicsConfig[INFERNO_SPAWN_LAYOUT_KEY]).toBe('');
    // Drawn by the setup control alone: no generic row offers it.
    expect(buildInfernoControls().mechanicsToggles.map(({ key }) => key)).not.toContain(INFERNO_SPAWN_LAYOUT_KEY);
    // The default start is TzKal-Zuk: the controls' default, the encounter's, and any missing or
    // unreadable saved value (Reset to defaults clears the saved entry, so it resolves the same).
    expect(INFERNO_DEFAULT_START_WAVE).toBe(ZUK_WAVE);
    expect(buildInfernoControls().defaultMechanicsConfig[INFERNO_START_WAVE_KEY]).toBe('69');
    expect(new InfernoEncounter(1).getDefaultMechanicsConfig()[INFERNO_START_WAVE_KEY]).toBe('69');
    for (const value of ['0', '70', 'x', '1.5', undefined]) {
      expect(resolveInfernoRunSetup({ infernoStartWave: value }).startWave).toBe(69);
    }
    // An engine given no start wave opens on it.
    setResolvedArenaConfig('inferno', openArena());
    const untouched = new SimulationEngine({ encounter: new InfernoEncounter(1), combatRandom: () => 0.5 });
    expect(untouched.getEncounterSnapshot()).toMatchObject({ state: { wave: 69, startWave: 69 } });
    const controls = buildInfernoControls();
    expect(controls.mechanicsToggles[0].choices).toHaveLength(69);
    expect(controls.mechanicsToggles[0].choices?.at(-1)).toEqual({ value: '69', label: '69 · TzKal-Zuk' });
    // One control set: wave 69's actions follow the waves' own restarts.
    const restarts = controls.debugActions.slice(0, INFERNO_DEBUG_ACTIONS.length);
    expect(restarts.map(({ visibleInPractice: _visibility, ...action }) => action)).toEqual(INFERNO_DEBUG_ACTIONS);
    // Retry is always listed; the other two exactly where the session bar offers them, read from the
    // run's snapshot whatever the saved setup says (`infernoSecondaryRestart`).
    const [retryAction] = restarts;
    expect(retryAction.visibleInPractice).toBeUndefined();
    const LAYOUT_6 = '6:-b-l----b';
    const offered = (run: Run | null, saved: string) => {
      const encounterSnapshot = run?.engine.getEncounterSnapshot();
      const context = {
        config: { [INFERNO_SPAWN_LAYOUT_KEY]: saved },
        stage: encounterSnapshot?.kind === 'inferno' ? encounterSnapshot.state.wave : undefined,
        encounterSnapshot,
      };
      const listed = restarts.slice(1).filter((action) => action.visibleInPractice?.(context) !== false);
      const barRun = vi.fn();
      if (encounterSnapshot) infernoSession(encounterSnapshot, barRun)?.secondary?.onClick();
      // The list and the bar always offer the same restart. Not always in the same words: the list's
      // labels are static, so its Random Spawns is the bar's New spawns once spawns are kept.
      expect(listed.map(({ command }) => command)).toEqual(barRun.mock.calls.map(([command]) => command));
      return listed.map(({ command }) => command.type);
    };
    // The run places wave 6 from its layout; the saved setup has since gone random.
    expect(offered(setup({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT_6 }), '')).toEqual([
      'reroll-wave',
    ]);
    // A random run on 6, with a layout for it saved since (an unapplied edit).
    expect(offered(setup({ infernoStartWave: '6' }), LAYOUT_6)).toEqual(['keep-spawns']);
    // A layout for another wave leaves this one random.
    expect(offered(setup({ infernoStartWave: '5', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT_6 }), LAYOUT_6)).toEqual([
      'keep-spawns',
    ]);
    // A run keeping this wave's spawns offers the way back to random; a pin for another wave is inert.
    expect(offered(setup({ infernoStartWave: '6', [INFERNO_PINNED_WAVE_KEY]: '6' }), '')).toEqual(['reroll-wave']);
    expect(offered(setup({ infernoStartWave: '6', [INFERNO_PINNED_WAVE_KEY]: '5' }), '')).toEqual(['keep-spawns']);
    // 67's lone Jad always spawns alike, 69's run seed picks only a shield start; 68 shuffles its Jads.
    expect(offered(setup({ infernoStartWave: '67' }), '')).toEqual([]);
    expect(offered(setup({ infernoStartWave: '67', [INFERNO_PINNED_WAVE_KEY]: '67' }), '')).toEqual([]);
    expect(offered(setup({ infernoStartWave: '68' }), '')).toEqual(['keep-spawns']);
    expect(offered(setup({ infernoStartWave: '68', [INFERNO_PINNED_WAVE_KEY]: '68' }), '')).toEqual(['reroll-wave']);
    expect(offered(setup({ infernoStartWave: '69' }), '')).toEqual([]);
    expect(offered(setup({ infernoStartWave: '69', [INFERNO_PINNED_WAVE_KEY]: '69' }), '')).toEqual([]);
    // No run, no snapshot: neither.
    expect(offered(null, LAYOUT_6)).toEqual([]);
    const zukActions = controls.debugActions.slice(INFERNO_DEBUG_ACTIONS.length);
    expect(zukActions.map(({ visibleInPractice: _visibility, ...action }) => action)).toEqual(
      buildZukControls().debugActions,
    );
    for (const action of zukActions) {
      expect(action.visibleInPractice?.({ stage: 35, config: { infernoStartWave: '69' } })).toBe(false);
      expect(action.visibleInPractice?.({ stage: 69, config: { infernoStartWave: '35' } })).toBe(true);
    }
    expect(controls.bossHpPresets).toEqual(buildZukControls().bossHpPresets);
    expect(infernoPillarKey({ west: true, south: false, northEast: true })).toBe('west,northEast');
    expect(infernoPillarKey({ west: false, south: false, northEast: false })).toBe('');
  });

  it('publishes the pillars the run STARTED with, apart from the ones the fight takes down', () => {
    // The setup control reads this to tell a choice the player changed from the run's own damage;
    // `pillars` cannot answer, because nibblers collapse those mid-wave.
    const run = setup({ infernoStartWave: '5', infernoSouthPillarDestroyed: true });
    advanceTo(run, SPAWN);
    const started = { west: false, south: true, northEast: false };
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { startDestroyedPillars: started } });

    // It belongs to the RUN, not the wave: clearing into the next wave leaves it alone, so the
    // setup control reads the same answer however far the run has got.
    const completedAt = clearWave(run);
    advanceTo(run, completedAt + 6);
    const after = run.engine.getEncounterSnapshot();
    if (after.kind !== 'inferno') throw new Error('wrong encounter');
    expect(after.state.wave).toBe(6);
    expect(after.state.startDestroyedPillars).toEqual(started);

    // A restart carries the saved setup, so the key the control compares against moves with it.
    run.engine.reset(undefined, undefined, { infernoStartWave: '9' });
    const restarted = run.engine.getEncounterSnapshot();
    if (restarted.kind !== 'inferno') throw new Error('wrong encounter');
    expect(infernoPillarKey(restarted.state.startDestroyedPillars)).toBe('south');
  });

  it('retries a random wave with new random spawns, as Random spawns does', () => {
    const run = setup({ infernoStartWave: '5' }, 99);
    advanceTo(run, SPAWN);
    const completedAt = clearWave(run);
    advanceTo(run, completedAt + 6);
    const wave6 = waveNpcs(run).map((npc) => npc.position);
    expect(wave6).toEqual(planWaveSpawns(99, 6).map(({ position }) => position));
    const [retry, reroll] = INFERNO_DEBUG_ACTIONS.map(({ command }) => run.engine.planPracticeRestart(command));
    // (Where they open is the next suite's: the player stands on the landing tile, kept.)
    // No custom layout for wave 6, so neither keeps the run seed: both draw new spawns.
    expect(retry).toMatchObject({ runMechanics: { infernoStartWave: '6' } });
    expect(retry?.encounterSeeds).toBeUndefined();
    expect(reroll).toMatchObject({ runMechanics: { infernoStartWave: '6' } });
    expect(reroll?.encounterSeeds).toBeUndefined();
    expect(run.engine.planPracticeRestart({ encounter: 'zuk', type: 'spawn-set' })).toBeNull();

    // What the UI's practice restart does: reset on the plan's seeds (none: fresh), with the run's own mechanics.
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    run.engine.reset(undefined, practiceRunConfig(run.engine, retry), retry?.runMechanics);
    expect(run.engine.getRunConfig().encounter.seeds).toEqual({ runSeed: 0x40000000 });
    advanceTo(run, SPAWN);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 6, startWave: 6 } });
    const rolled = planWaveSpawns(0x40000000, 6).map(({ position }) => position);
    expect(rolled).not.toEqual(wave6);
    expect(waveNpcs(run).map((npc) => npc.position)).toEqual(rolled);
  });

  describe('a retry’s attempt seed', () => {
    // Retry keeps the run seed only on a wave the run places from a custom layout.
    const CUSTOM_WAVE_6 = { infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: '6:-b-l----b' };
    /** A run whose NPC streams log every draw taken from them, one list per stream opened. */
    function tappedSetup(seed: number) {
      const npcDraws: number[][] = [];
      setResolvedArenaConfig('inferno', openArena());
      const encounter = new InfernoEncounter(seed, {
        decisionRandom: (stream, _wave, next) => {
          if (stream !== 'npc') return generatorDecisionRandom(next);
          const draws: number[] = [];
          npcDraws.push(draws);
          return generatorDecisionRandom(() => {
            const value = next();
            draws.push(value);
            return value;
          });
        },
      });
      const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
      engine.setMechanicsConfig({ infiniteHealth: true, ...CUSTOM_WAVE_6 });
      const run: Run = { encounter, engine, world: Reflect.get(engine, 'worldState') as WorldState };
      return { run, npcDraws };
    }
    /** Fights the wave a while from its spawn: where it spawned, its nibblers' pillar, its NPC draws. */
    function fight({ run, npcDraws }: ReturnType<typeof tappedSetup>) {
      advanceTo(run, SPAWN);
      const spawned = waveNpcs(run).map((npc) => [npc.npcTypeId, [...npc.position]]);
      advanceTo(run, SPAWN + 1);
      const pillars = new Set(
        waveNpcs(run)
          .filter((npc) => npc.npcTypeId === INFERNO_WAVE_NPC_IDS.nibbler)
          .map((npc) => npc.combat.targetId),
      );
      advanceTo(run, SPAWN + 60);
      return { spawned, pillars, draws: [...(npcDraws.at(-1) ?? [])] };
    }
    const stream = (random: () => number, length: number) => Array.from({ length }, () => random());

    it('keeps the spawns and nibbler pillar, rolls the monsters afresh, and replays exactly', () => {
      const tapped = tappedSetup(99);
      const first = fight(tapped);
      expect(first.pillars.size).toBe(1);
      expect(first.draws.length).toBeGreaterThan(0);
      // A first attempt has no attempt seed: its NPCs draw the run seed's own stream, as before.
      expect(tapped.run.engine.getRunConfig().encounter.seeds).toEqual({ runSeed: 99 });
      expect(first.draws).toEqual(stream(waveNpcRandom(99, 6), first.draws.length));

      const retry = practiceRestart(tapped.run, RETRY);
      const attemptSeed = retry.encounterSeeds?.attemptSeed;
      if (typeof attemptSeed !== 'number') throw new Error('expected an attempt seed');
      const recorded = tapped.run.engine.getRunConfig();
      expect(recorded.encounter.seeds).toEqual({ runSeed: 99, attemptSeed });
      const second = fight(tapped);
      expect(second.spawned).toEqual(first.spawned);
      expect(second.pillars).toEqual(first.pillars);
      expect(second.draws.length).toBeGreaterThan(0);
      expect(second.draws).toEqual(stream(waveNpcRandom(npcDecisionSeed(99, attemptSeed), 6), second.draws.length));
      expect(second.draws).not.toEqual(stream(waveNpcRandom(99, 6), second.draws.length));

      // Its recording rebuilds both seeds, so a replay of the retry draws exactly what it drew.
      const replay = tappedSetup(1);
      replay.run.engine.reset(undefined, recorded);
      expect(replay.run.engine.getRunConfig().encounter.seeds).toEqual(recorded.encounter.seeds);
      expect(fight(replay)).toEqual(second);
      expect(replay.run.engine.getState()).toEqual(tapped.run.engine.getState());
    });

    it('rolls a new attempt seed for every Retry', () => {
      const run = setup(CUSTOM_WAVE_6, 99);
      vi.spyOn(Math, 'random').mockReturnValueOnce(0.25).mockReturnValueOnce(0.5);
      expect(run.engine.planPracticeRestart(RETRY)?.encounterSeeds).toEqual({ runSeed: 99, attemptSeed: 0x40000000 });
      expect(run.engine.planPracticeRestart(RETRY)?.encounterSeeds).toEqual({ runSeed: 99, attemptSeed: 0x80000000 });
    });
  });

  describe('a custom spawn layout', () => {
    // Wave 6 is 1 blob, 2 bats and 3 nibblers: bats on slots 1 and 8, the blob on slot 3.
    const LAYOUT = '6:-b-l----b';
    const CHOSEN = [
      ['blob', [22, 23]],
      ['bat', [20, 35]],
      ['bat', [39, 41]],
    ];
    const kindOf = (npc: NpcActor) =>
      Object.entries(INFERNO_WAVE_NPC_IDS).find(([, id]) => id === npc.npcTypeId)?.[0] ?? String(npc.npcTypeId);
    const placed = (run: Run) => waveNpcs(run).map((npc) => [kindOf(npc), npc.position]);

    it('places its wave’s slot NPCs on the chosen slots, nibblers as the seed would have', () => {
      const run = setup({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT }, 99);
      advanceTo(run, SPAWN);
      const random = planWaveSpawns(99, 6);
      expect(placed(run)).toEqual([
        ...CHOSEN,
        ...random.filter((placement) => placement.kind === 'nibbler').map(({ position }) => ['nibbler', position]),
      ]);
      expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { startSpawnLayout: LAYOUT } });
    });

    it('waits for its own wave in a run started earlier, and leaves the next wave seeded-random', () => {
      const run = setup({ infernoStartWave: '5', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT }, 99);
      advanceTo(run, SPAWN);
      expect(waveNpcs(run).map((npc) => npc.position)).toEqual(planWaveSpawns(99, 5).map(({ position }) => position));
      advanceTo(run, clearWave(run) + 6);
      expect(placed(run).slice(0, 3)).toEqual(CHOSEN);
      advanceTo(run, clearWave(run) + 6);
      expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 7 } });
      expect(waveNpcs(run).map((npc) => npc.position)).toEqual(planWaveSpawns(99, 7).map(({ position }) => position));
    });

    it('holds through a retry; Random spawns on its wave rolls at random for that run alone', () => {
      const run = setup({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT }, 99);
      advanceTo(run, SPAWN);
      const plan = () => INFERNO_DEBUG_ACTIONS.map(({ command }) => run.engine.planPracticeRestart(command));
      const [retry, reroll] = plan();
      // Retry on the custom wave keeps the run seed, so the seeded part (the nibblers) repeats too.
      expect(retry?.encounterSeeds).toEqual({ runSeed: 99, attemptSeed: expect.any(Number) });
      expect(retry?.runMechanics).toEqual({ infernoStartWave: '6' });
      expect(reroll?.encounterSeeds).toBeUndefined();
      expect(reroll?.runMechanics).toEqual({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: '' });
      run.engine.reset(undefined, practiceRunConfig(run.engine, retry), retry?.runMechanics);
      advanceTo(run, SPAWN);
      expect(placed(run).slice(0, 3)).toEqual(CHOSEN);

      vi.spyOn(Math, 'random').mockReturnValue(0.25);
      run.engine.reset(undefined, undefined, reroll?.runMechanics);
      advanceTo(run, SPAWN);
      const rolled = planWaveSpawns(0x40000000, 6).map(({ position }) => position);
      expect(waveNpcs(run).map((npc) => npc.position)).toEqual(rolled);
      expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { startSpawnLayout: '' } });
      // The saved layout is untouched (a run override), so a tick-zero re-apply of it changes nothing.
      run.engine.setMechanicsConfig({
        infiniteHealth: true,
        infernoStartWave: '6',
        [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT,
      });
      expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { startSpawnLayout: '' } });

      // The run is random on this wave now, so Retry rolls new random spawns rather than bringing the
      // saved layout back; Random spawns again stays random too.
      const [retryRolled, rerollAgain] = plan();
      expect(retryRolled?.encounterSeeds).toBeUndefined();
      expect(retryRolled?.runMechanics).toEqual({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: '' });
      expect(rerollAgain?.runMechanics).toEqual({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: '' });
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      run.engine.reset(undefined, practiceRunConfig(run.engine, retryRolled), retryRolled?.runMechanics);
      advanceTo(run, SPAWN);
      const rolledAgain = planWaveSpawns(0x80000000, 6).map(({ position }) => position);
      expect(rolledAgain).not.toEqual(rolled);
      expect(waveNpcs(run).map((npc) => npc.position)).toEqual(rolledAgain);
      expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { startSpawnLayout: '' } });

      // Go to the wave, and Restart fight, start from the saved setup: the custom layout is back.
      const go = run.engine.planPracticeRestart({ encounter: 'inferno', type: 'go-to-wave', wave: 6 });
      run.engine.reset(undefined, practiceRunConfig(run.engine, go), go?.runMechanics);
      advanceTo(run, SPAWN);
      expect(placed(run).slice(0, 3)).toEqual(CHOSEN);

      const garbage = setup({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: '6:bbbl-----' }, 99);
      advanceTo(garbage, SPAWN);
      expect(waveNpcs(garbage).map((npc) => npc.position)).toEqual(
        planWaveSpawns(99, 6).map(({ position }) => position),
      );
      expect(garbage.engine.getEncounterSnapshot()).toMatchObject({ state: { startSpawnLayout: '' } });
    });

    it('keeps the layout through restarts on another wave, and offers Random spawns only on its own, Lock layout elsewhere', () => {
      const earlier = setup({ infernoStartWave: '5', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT }, 99);
      advanceTo(earlier, SPAWN);
      expect(earlier.engine.planPracticeRestart(REROLL)?.runMechanics).toEqual({ infernoStartWave: '5' });
      // Retry on a random wave draws new seeds, and the layout still waits for wave 6.
      const retry = earlier.engine.planPracticeRestart(RETRY);
      expect(retry?.runMechanics).toEqual({ infernoStartWave: '5' });
      expect(retry?.encounterSeeds).toBeUndefined();
      const session = (run: Run) => infernoSession(run.engine.getEncounterSnapshot(), () => {});
      expect(session(earlier)?.primary.hint).toBe('Start wave 5 again with new random spawns. Ctrl+R does the same.');
      const keep = {
        label: 'Lock layout',
        hint: 'Restart wave 5 with this spawn layout and lock it for retries. Retry and Ctrl+R repeat it until you leave the wave. Go and Restart fight clear the lock. Your saved custom layout is unchanged.',
      };
      expect(session(earlier)?.secondary).toMatchObject(keep);
      const own = setup({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT });
      expect(session(own)?.primary.hint).toBe('Start wave 6 again with your custom layout. Ctrl+R does the same.');
      expect(session(own)?.secondary).toMatchObject({
        label: 'Random spawns',
        hint: 'Restart wave 6 with random spawns instead of your custom layout for this run. Retry and Ctrl+R generate new spawns on each attempt. Your custom layout stays saved for Go and Restart fight.',
      });
      // Once Random spawns has dropped the layout for the run, the wave is random: Lock layout instead.
      practiceRestart(own, REROLL);
      expect(session(own)?.secondary).toMatchObject({ ...keep, hint: keep.hint.replace('wave 5', 'wave 6') });
    });

    describe('placing only part of the wave', () => {
      // One bat, on slot 1; the blob and the other bat spawn at random.
      const PARTIAL = '6:-b-------';
      const expected = (seed: number) =>
        planWaveSpawns(seed, 6, undefined, -1, parseSpawnLayout(PARTIAL)).map(({ position }) => position);
      const positions = (run: Run) => waveNpcs(run).map((npc) => npc.position);

      it('keeps the placed bat and fills the rest from the run seed: Retry repeats it, a fresh run redraws it', () => {
        const run = setup({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: PARTIAL }, 99);
        advanceTo(run, SPAWN);
        expect(positions(run)).toEqual(expected(99));
        expect(positions(run)[1]).toEqual([20, 35]);
        // What spawned is published whole, the random part included.
        const spawned = run.engine.getEncounterSnapshot();
        expect(
          spawned.kind === 'inferno' && parseSpawnLayout(spawned.state.waveSpawnLayout)?.slots.filter(Boolean),
        ).toHaveLength(3);
        expect(spawned).toMatchObject({ state: { startSpawnLayout: PARTIAL } });

        const [retry, reroll] = INFERNO_DEBUG_ACTIONS.map(({ command }) => run.engine.planPracticeRestart(command));
        expect(retry?.runMechanics).toEqual({ infernoStartWave: '6' });
        run.engine.reset(undefined, practiceRunConfig(run.engine, retry), retry?.runMechanics);
        advanceTo(run, SPAWN);
        expect(positions(run)).toEqual(expected(99));

        // Restart fight: the saved partial layout again, under a new run seed.
        const fills = new Set<string>();
        for (const random of [0.25, 0.5, 0.75]) {
          vi.spyOn(Math, 'random').mockReturnValue(random);
          run.engine.reset();
          advanceTo(run, SPAWN);
          expect(positions(run)).toEqual(expected(Math.floor(random * 2 ** 32)));
          expect(positions(run)[1]).toEqual([20, 35]);
          fills.add(JSON.stringify(positions(run)));
        }
        expect(fills.size).toBeGreaterThan(1);

        // Random spawns drops it for that run alone.
        expect(reroll?.runMechanics).toEqual({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: '' });
      });
    });

    it('counts as a setup the running fight started with, beside the pillars', () => {
      const config = { infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT, infernoWestPillarDestroyed: true };
      const run = setup(config);
      const startedWith = infernoRunStartedWith(run.engine.getEncounterSnapshot());
      expect(startedWith).toBe(`west;${LAYOUT}`);
      expect(infernoRunSetupKey(resolveInfernoRunSetup(config))).toBe(startedWith);
      expect(infernoRunSetupKey(resolveInfernoRunSetup({ ...config, [INFERNO_SPAWN_LAYOUT_KEY]: '' }))).toBe('west');
      // Kept by reconstruction: a recording replays its own layout, not the viewer's.
      expect(run.engine.getRunConfig().bootstrap?.mechanicsConfig[INFERNO_SPAWN_LAYOUT_KEY]).toBe(LAYOUT);
      expect(new InfernoEncounter(1).runStartMechanicsKeys).toContain(INFERNO_SPAWN_LAYOUT_KEY);
    });
  });

  describe('the spawned layout', () => {
    const published = (run: Run): string => {
      const snapshot = run.engine.getEncounterSnapshot();
      if (snapshot.kind !== 'inferno') throw new Error('wrong encounter');
      return snapshot.state.waveSpawnLayout;
    };
    /** The wave's slot NPCs as they stand in the world, read back onto the nine slots. */
    const standing = (run: Run): (string | null)[] => {
      const slots: (string | null)[] = Array(INFERNO_SPAWN_SLOTS.length).fill(null);
      for (const npc of waveNpcs(run)) {
        const kind = Object.entries(INFERNO_WAVE_NPC_IDS).find(([, id]) => id === npc.npcTypeId)?.[0];
        const index = INFERNO_SPAWN_SLOTS.findIndex(([x, y]) => x === npc.position[0] && y === npc.position[1]);
        if (kind !== 'nibbler' && index >= 0) slots[index] = kind ?? null;
      }
      return slots;
    };
    const parsedSlots = (run: Run) => parseSpawnLayout(published(run))?.slots;

    it('publishes the random slots a wave spawned on, and nothing before or after it', () => {
      const run = setup({ infernoStartWave: '30' }, 7);
      expect(published(run)).toBe('');
      advanceTo(run, SPAWN);
      expect(parseSpawnLayout(published(run))?.wave).toBe(30);
      expect(parsedSlots(run)).toEqual(standing(run));
      // The countdown to the next wave publishes nothing until that wave is up.
      const completedAt = clearWave(run);
      expect(published(run)).toBe('');
      advanceTo(run, completedAt + 6);
      expect(parseSpawnLayout(published(run))?.wave).toBe(31);
      expect(parsedSlots(run)).toEqual(standing(run));
    });

    it('publishes a custom layout exactly as it was applied', () => {
      const run = setup({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: '6:-b-l----b' });
      advanceTo(run, SPAWN);
      expect(published(run)).toBe('6:-b-l----b');
    });

    it('changes with Retry and Random spawns on a random wave, and stays with Retry on a custom one', () => {
      const run = setup({ infernoStartWave: '40' }, 99);
      advanceTo(run, SPAWN);
      const first = published(run);
      const [retry, reroll] = INFERNO_DEBUG_ACTIONS.map(({ command }) => run.engine.planPracticeRestart(command));
      vi.spyOn(Math, 'random').mockReturnValue(0.25);
      run.engine.reset(undefined, practiceRunConfig(run.engine, retry), retry?.runMechanics);
      expect(published(run)).toBe('');
      advanceTo(run, SPAWN);
      const retried = published(run);
      expect(retried).not.toBe(first);
      expect(parsedSlots(run)).toEqual(standing(run));

      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      run.engine.reset(undefined, undefined, reroll?.runMechanics);
      advanceTo(run, SPAWN);
      expect(published(run)).not.toBe(first);
      expect(published(run)).not.toBe(retried);
      expect(parsedSlots(run)).toEqual(standing(run));

      const custom = setup({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: '6:-b-l----b' }, 99);
      advanceTo(custom, SPAWN);
      const placed = published(custom);
      practiceRestart(custom, RETRY);
      advanceTo(custom, SPAWN);
      expect(published(custom)).toBe(placed);
    });

    it.each(['3', '67', '68'])('publishes nothing for wave %s, which has nothing to place', (wave) => {
      const run = setup({ infernoStartWave: wave });
      advanceTo(run, SPAWN);
      expect(waveNpcs(run).length).toBeGreaterThan(0);
      expect(published(run)).toBe('');
    });

    it('publishes nothing on wave 69', () => {
      const run = setup({ infernoStartWave: '69' });
      advanceTo(run, SPAWN);
      expect(published(run)).toBe('');
    });

    const downAtSpawn = (run: Run) => {
      const snapshot = run.engine.getEncounterSnapshot();
      if (snapshot.kind !== 'inferno') throw new Error('wrong encounter');
      return snapshot.state.waveStartDestroyedPillars;
    };

    it('publishes the pillars down when the wave spawned, not the ones it took down since', () => {
      const run = setup({ infernoStartWave: '30', infernoSouthPillarDestroyed: true });
      const started = { west: false, south: true, northEast: false };
      // Before the first wave: the run's own setup.
      expect(downAtSpawn(run)).toEqual(started);
      advanceTo(run, SPAWN);
      expect(downAtSpawn(run)).toEqual(started);

      const west = run.world.getNpc('inferno_pillar_west');
      if (!west) throw new Error('missing pillar');
      kill(run, west);
      advanceTo(run, SPAWN + 2);
      expect(run.world.getNpc(west.id)).toBeNull();
      // The live pillars say it fell; the wave still spawned with it standing.
      expect(run.engine.getEncounterSnapshot()).toMatchObject({
        state: { pillars: [{ key: 'west', intact: false }, { key: 'south' }, { key: 'northEast', intact: true }] },
      });
      expect(downAtSpawn(run)).toEqual(started);

      // The next wave spawns with it down.
      const completedAt = clearWave(run);
      expect(downAtSpawn(run)).toEqual(started);
      advanceTo(run, completedAt + 6);
      expect(downAtSpawn(run)).toEqual({ west: true, south: true, northEast: false });

      // A retry is a fresh run of the setup: the pillar stands again.
      const retry = run.engine.planPracticeRestart({ encounter: 'inferno', type: 'retry-wave' });
      run.engine.reset(undefined, practiceRunConfig(run.engine, retry), retry?.runMechanics);
      advanceTo(run, SPAWN);
      expect(downAtSpawn(run)).toEqual(started);
    });

    it('publishes every pillar down from wave 67, where none stands', () => {
      const run = setup({ infernoStartWave: '67' });
      expect(downAtSpawn(run)).toEqual({ west: false, south: false, northEast: false });
      advanceTo(run, SPAWN);
      expect(downAtSpawn(run)).toEqual({ west: true, south: true, northEast: true });
    });
  });

  describe('Lock layout', () => {
    const inferno = (run: Run) => {
      const snapshot = run.engine.getEncounterSnapshot();
      if (snapshot.kind !== 'inferno') throw new Error('wrong encounter');
      return snapshot.state;
    };
    const session = (run: Run) => infernoSession(run.engine.getEncounterSnapshot(), () => {});
    const spawned = (run: Run) => waveNpcs(run).map((npc) => [npc.npcTypeId, [...npc.position]]);

    it('keeps a random wave reached from an earlier start through Retry after Retry', () => {
      const run = setup({ infernoStartWave: '39' }, 99);
      advanceTo(run, SPAWN);
      advanceTo(run, clearWave(run) + 6);
      expect(inferno(run)).toMatchObject({ wave: 40, startWave: 39 });
      expect(inferno(run)).not.toHaveProperty('pinnedWave');
      expect(session(run)?.secondary?.label).toBe('Lock layout');
      const first = spawned(run);
      const firstLayout = inferno(run).waveSpawnLayout;
      // The run seed and the wave alone place it: the same as a run started on 40 would spawn.
      expect(first.map(([, position]) => position)).toEqual(planWaveSpawns(99, 40).map(({ position }) => position));

      const keep = practiceRestart(run, KEEP);
      expect(keep.encounterSeeds).toEqual({ runSeed: 99, attemptSeed: expect.any(Number) });
      expect(keep.runMechanics).toEqual({ infernoStartWave: '40', [INFERNO_PINNED_WAVE_KEY]: '40' });
      expect(inferno(run)).toMatchObject({ wave: 40, startWave: 40, pinnedWave: 40 });
      expect(session(run)?.title).toBe('Wave 40 · spawn layout locked');
      expect(session(run)?.primary.hint).toBe(
        'Start wave 40 again with the locked spawn layout. Ctrl+R does the same.',
      );
      expect(session(run)?.secondary).toMatchObject({
        label: 'New spawns',
        hint: 'Restart wave 40 with new random spawns and clear the layout lock. Retry and Ctrl+R generate new spawns on each attempt.',
      });
      advanceTo(run, SPAWN);
      expect(spawned(run)).toEqual(first);

      // Each Retry re-emits the pin, since a plan replaces the run's overrides, under a new attempt seed.
      const attemptSeeds = new Set([keep.encounterSeeds?.attemptSeed]);
      for (const attempt of [1, 2]) {
        const retry = practiceRestart(run, RETRY);
        expect(retry.encounterSeeds).toEqual({ runSeed: 99, attemptSeed: expect.any(Number) });
        expect(retry.runMechanics).toEqual(keep.runMechanics);
        expect(run.engine.getRunConfig().encounter.seeds).toEqual(retry.encounterSeeds);
        attemptSeeds.add(retry.encounterSeeds?.attemptSeed);
        expect(inferno(run).pinnedWave).toBe(40);
        advanceTo(run, SPAWN);
        expect(spawned(run), `retry ${attempt}`).toEqual(first);
        expect(inferno(run).waveSpawnLayout).toBe(firstLayout);
      }
      expect(attemptSeeds.size).toBe(3);
    });

    it.each([3, 68])('keeps wave %s, which publishes no layout, as it spawned', (wave) => {
      const run = setup({ infernoStartWave: String(wave) }, 99);
      advanceTo(run, SPAWN);
      expect(inferno(run).waveSpawnLayout).toBe('');
      // Wave 68's openings follow its Jads' spawn order (`planWaveSpawns`), so the order is kept too.
      const opened = () =>
        waveNpcs(run).map((npc) => [npc.npcTypeId, [...npc.position], jadDefinition.getState(npc)?.initialDelayTicks]);
      const first = opened();
      expect(first.length).toBeGreaterThan(0);
      expect(first.map(([, position]) => position)).toEqual(planWaveSpawns(99, wave).map(({ position }) => position));
      for (const command of [KEEP, RETRY]) {
        practiceRestart(run, command);
        expect(inferno(run).pinnedWave).toBe(wave);
        advanceTo(run, SPAWN);
        expect(opened(), command.type).toEqual(first);
      }
    });

    it('covers only its own wave: the next is seeded as usual, and Retry there drops the pin', () => {
      const run = setup({ infernoStartWave: '30' }, 99);
      practiceRestart(run, KEEP);
      advanceTo(run, SPAWN);
      advanceTo(run, clearWave(run) + 6);
      expect(inferno(run)).toMatchObject({ wave: 31, startWave: 30, pinnedWave: 30 });
      expect(waveNpcs(run).map((npc) => npc.position)).toEqual(planWaveSpawns(99, 31).map(({ position }) => position));
      expect(session(run)?.secondary?.label).toBe('Lock layout');
      expect(session(run)?.primary.hint).toBe('Start wave 31 again with new random spawns. Ctrl+R does the same.');
      const retry = practiceRestart(run, RETRY);
      expect(retry.encounterSeeds).toBeUndefined();
      expect(retry.runMechanics).toEqual({ infernoStartWave: '31' });
      expect(inferno(run)).not.toHaveProperty('pinnedWave');
    });

    it('stops with New spawns, after which Retry rolls new spawns again', () => {
      const run = setup({ infernoStartWave: '40' }, 99);
      practiceRestart(run, KEEP);
      vi.spyOn(Math, 'random').mockReturnValue(0.25);
      const reroll = practiceRestart(run, REROLL);
      expect(reroll.encounterSeeds).toBeUndefined();
      expect(reroll.runMechanics).toEqual({ infernoStartWave: '40' });
      expect(run.engine.getRunConfig().encounter.seeds).toEqual({ runSeed: 0x40000000 });
      expect(inferno(run)).not.toHaveProperty('pinnedWave');
      expect(session(run)?.secondary?.label).toBe('Lock layout');
      const retry = run.engine.planPracticeRestart(RETRY);
      expect(retry?.encounterSeeds).toBeUndefined();
      expect(retry?.runMechanics).toEqual({ infernoStartWave: '40' });
    });

    it('is cleared by Go to wave, the same wave included, and by Restart fight', () => {
      const run = setup({ infernoStartWave: '40' }, 99);
      practiceRestart(run, KEEP);
      // Go to the same wave keeps the run seed (only the pillars can have changed), not the pin.
      const sameWave = practiceRestart(run, goTo(40));
      expect(sameWave.encounterSeeds).toEqual({ runSeed: 99, attemptSeed: expect.any(Number) });
      expect(sameWave.runMechanics).toEqual({ infernoStartWave: '40' });
      expect(inferno(run)).not.toHaveProperty('pinnedWave');
      practiceRestart(run, KEEP);
      expect(practiceRestart(run, goTo(41)).runMechanics).toEqual({ infernoStartWave: '41' });
      expect(inferno(run)).not.toHaveProperty('pinnedWave');
      practiceRestart(run, KEEP);
      expect(inferno(run)).toMatchObject({ wave: 41, pinnedWave: 41 });
      run.engine.reset();
      expect(inferno(run)).toMatchObject({ wave: 40, startWave: 40 });
      expect(inferno(run)).not.toHaveProperty('pinnedWave');
      expect(run.engine.getMechanicsConfig()).not.toHaveProperty(INFERNO_PINNED_WAVE_KEY);
    });

    it('carries the run’s own layout and start tile over anything saved since, Random spawns included', () => {
      const LAYOUT = '6:-b-l----b';
      // A layout for a later wave, saved away mid-run: the run's own still waits for wave 6.
      const offWave = setup({ infernoStartWave: '5', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT }, 99);
      advanceTo(offWave, SPAWN);
      offWave.engine.setMechanicsConfig({
        infiniteHealth: true,
        infernoStartWave: '5',
        [INFERNO_SPAWN_LAYOUT_KEY]: '',
      });
      const kept = { infernoStartWave: '5', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT };
      expect(practiceRestart(offWave, KEEP).runMechanics).toEqual({ ...kept, [INFERNO_PINNED_WAVE_KEY]: '5' });
      expect(practiceRestart(offWave, RETRY).runMechanics).toEqual({ ...kept, [INFERNO_PINNED_WAVE_KEY]: '5' });
      expect(practiceRestart(offWave, REROLL).runMechanics).toEqual(kept);
      expect(inferno(offWave)).toMatchObject({ startSpawnLayout: LAYOUT });
      expect(inferno(offWave)).not.toHaveProperty('pinnedWave');

      // The run's layout dropped by Random spawns while the saved one still names this wave.
      const suppressed = setup({ infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: LAYOUT }, 99);
      practiceRestart(suppressed, REROLL);
      expect(session(suppressed)?.secondary?.label).toBe('Lock layout');
      const random = { infernoStartWave: '6', [INFERNO_SPAWN_LAYOUT_KEY]: '' };
      expect(practiceRestart(suppressed, KEEP).runMechanics).toEqual({ ...random, [INFERNO_PINNED_WAVE_KEY]: '6' });
      expect(inferno(suppressed)).toMatchObject({ startSpawnLayout: '', pinnedWave: 6 });
      // Not the custom layout's wording: these are random spawns kept.
      expect(session(suppressed)?.primary.hint).toBe(
        'Start wave 6 again with the locked spawn layout. Ctrl+R does the same.',
      );
      expect(practiceRestart(suppressed, RETRY).runMechanics).toEqual({ ...random, [INFERNO_PINNED_WAVE_KEY]: '6' });
      expect(practiceRestart(suppressed, REROLL).runMechanics).toEqual(random);

      // A start tile changed since waits for Go.
      const tiled = setup({ infernoStartWave: '30', [INFERNO_START_TILE_KEY]: '24,30' }, 99);
      advanceTo(tiled, 5);
      tiled.engine.setMechanicsConfig({
        infiniteHealth: true,
        infernoStartWave: '30',
        [INFERNO_START_TILE_KEY]: '40,30',
      });
      const tile = { infernoStartWave: '30', [INFERNO_START_TILE_KEY]: '24,30' };
      expect(practiceRestart(tiled, KEEP).runMechanics).toEqual({ ...tile, [INFERNO_PINNED_WAVE_KEY]: '30' });
      expect(practiceRestart(tiled, RETRY).runMechanics).toEqual({ ...tile, [INFERNO_PINNED_WAVE_KEY]: '30' });
      expect(practiceRestart(tiled, REROLL).runMechanics).toEqual(tile);
    });

    it('is a run override alone: no toggle or default, outside the setup key, recorded and kept at tick 0', () => {
      const controls = buildInfernoControls();
      expect(controls.defaultMechanicsConfig).not.toHaveProperty(INFERNO_PINNED_WAVE_KEY);
      expect(controls.mechanicsToggles.map(({ key }) => key)).not.toContain(INFERNO_PINNED_WAVE_KEY);
      expect(new InfernoEncounter(1).runStartMechanicsKeys).toContain(INFERNO_PINNED_WAVE_KEY);
      // Any whole wave with spawns to keep; anything else is no pin, never a clamped one.
      expect(resolveInfernoRunSetup({ [INFERNO_PINNED_WAVE_KEY]: '1' }).pinnedWave).toBe(1);
      expect(resolveInfernoRunSetup({ [INFERNO_PINNED_WAVE_KEY]: '66' }).pinnedWave).toBe(66);
      expect(resolveInfernoRunSetup({ [INFERNO_PINNED_WAVE_KEY]: '68' }).pinnedWave).toBe(68);
      for (const raw of ['0', '67', '69', '70', '4.5', ' 40', 'x', '', undefined]) {
        expect(resolveInfernoRunSetup({ [INFERNO_PINNED_WAVE_KEY]: raw }), String(raw)).not.toHaveProperty(
          'pinnedWave',
        );
      }

      const run = setup({ infernoStartWave: '40' }, 99);
      const startedWith = infernoRunStartedWith(run.engine.getEncounterSnapshot());
      practiceRestart(run, KEEP);
      expect(infernoRunStartedWith(run.engine.getEncounterSnapshot())).toBe(startedWith);
      expect(
        infernoRunSetupKey(resolveInfernoRunSetup({ infernoStartWave: '40', [INFERNO_PINNED_WAVE_KEY]: '40' })),
      ).toBe(infernoRunSetupKey(resolveInfernoRunSetup({ infernoStartWave: '40' })));
      expect(run.engine.getRunConfig().bootstrap?.mechanicsConfig[INFERNO_PINNED_WAVE_KEY]).toBe('40');
      // The app re-applies the saved setup, which never has it, at tick 0: the run keeps it.
      run.engine.setMechanicsConfig({ infiniteHealth: true, infernoStartWave: '40' });
      expect(inferno(run).pinnedWave).toBe(40);
    });
  });

  it('goes to a wave the setup asked for, clamped, without disturbing retry or reroll', () => {
    const run = setup({ infernoStartWave: '5' });
    advanceTo(run, SPAWN);
    const go = (wave: number) => run.engine.planPracticeRestart({ encounter: 'inferno', type: 'go-to-wave', wave });
    // A wave the player picked is a new attempt, so it gets a layout of its own.
    expect(go(35)).toEqual({ runMechanics: { infernoStartWave: '35' } });
    // The command carries the number, so a replayed or hand-made one cannot name a wave that is
    // not in the fight.
    expect(go(0)).toEqual({ runMechanics: { infernoStartWave: '1' } });
    expect(go(999)).toEqual({ runMechanics: { infernoStartWave: '69' } });
    // The wave being fought is not a new attempt: only the pillar setup can have changed, so it
    // keeps its layout the way Retry does, with the monsters rolling afresh.
    const kept = { runSeed: 7, attemptSeed: expect.any(Number) };
    expect(go(5)).toEqual({ encounterSeeds: kept, runMechanics: { infernoStartWave: '5' } });

    run.engine.reset(undefined, undefined, go(35)?.runMechanics);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 35, startWave: 35 } });
    // Retry and reroll still answer for the wave the run is on, not the one the setup names (a
    // random wave, so Retry draws new seeds).
    expect(run.engine.planPracticeRestart({ encounter: 'inferno', type: 'retry-wave' })).toEqual({
      runMechanics: { infernoStartWave: '35' },
    });
    // The jump is a run override, never a save: a plain restart is still the player's own setup.
    run.engine.reset();
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 5, startWave: 5 } });
  });

  it('keeps a restart’s wave for that run only, through tick-zero edits, and records it', () => {
    const run = setup({ infernoStartWave: '5' });
    run.engine.reset(undefined, undefined, { infernoStartWave: '6' });
    // The app re-applies the player's saved setup at tick 0 (any setting change does).
    run.engine.setMechanicsConfig({ infiniteHealth: true, infernoStartWave: '5' });
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 6, startWave: 6 } });
    const recorded = run.engine.getRunConfig();
    expect(recorded.bootstrap?.mechanicsConfig.infernoStartWave).toBe('6');

    // A reconstruction from the recording starts where the run did.
    const replayed = setup();
    replayed.engine.reset(undefined, recorded);
    expect(replayed.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 6, startWave: 6 } });

    run.engine.reset();
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 5, startWave: 5 } });
    expect(run.engine.getMechanicsConfig().infernoStartWave).toBe('5');
  });

  it('refuses constructor options and rejects malformed seeds', () => {
    expect(() => encounterRegistry.create('inferno', { startWave: 5 })).toThrow(/accepts no constructor options/);
    const encounter = new InfernoEncounter(1);
    expect(() => encounter.reset({ runSeed: -1 })).toThrow();
    expect(() => encounter.reset({ runSeed: 12, attemptSeed: 0x100000000 })).toThrow();
    expect(() => encounter.reset({ runSeed: 12, attemptSeed: '3' })).toThrow();
    encounter.reset({ runSeed: 12, attemptSeed: 3 });
    expect(encounter.getSeeds()).toEqual({ runSeed: 12, attemptSeed: 3 });
    // A first attempt, and any recording without an attempt seed, has none to restore.
    encounter.reset({ runSeed: 12 });
    expect(encounter.getSeeds()).toEqual({ runSeed: 12 });
    expect(
      structuredClone(
        encounter.getSnapshot({ world: Reflect.get(setup().engine, 'worldState'), tick: 0, mechanics: {} }),
      ),
    ).toBeTruthy();
  });
});

/** The run config the wiring's practice restart resets with (`useSimulationWiring.resetRun`). */
function practiceRunConfig(
  engine: SimulationEngine,
  plan: EncounterPracticeRestart | null | undefined,
): EngineRunConfig | undefined {
  if (!plan?.encounterSeeds) return undefined;
  const { completionOwnership, encounter } = engine.getRunConfig();
  return { completionOwnership, encounter: { kind: encounter.kind, seeds: { ...plan.encounterSeeds } } };
}

/** What the wiring's practice restart does with the encounter's plan (`useSimulationWiring.resetRun`). */
function practiceRestart(run: Run, command: InfernoCommand): EncounterPracticeRestart {
  const plan = run.engine.planPracticeRestart(command);
  if (!plan) throw new Error('expected a practice restart');
  run.engine.reset(
    plan.startPosition ? [...plan.startPosition] : undefined,
    practiceRunConfig(run.engine, plan),
    plan.runMechanics,
  );
  return plan;
}

const RETRY = { encounter: 'inferno', type: 'retry-wave' } as const;
const REROLL = { encounter: 'inferno', type: 'reroll-wave' } as const;
const KEEP = { encounter: 'inferno', type: 'keep-spawns' } as const;
const goTo = (wave: number) => ({ encounter: 'inferno', type: 'go-to-wave', wave }) as const;
/** South of the south pillar (SW 27,23), out of sight of the arena's middle. */
const BEHIND_SOUTH_PILLAR: Coordinate = [28, 22];

function standOn({ world }: Run, tile: Coordinate): void {
  const player = world.getPlayer();
  if (!player) throw new Error('missing player');
  player.position = [...tile];
  player.previousPosition = [...tile];
}

describe('Inferno landing intro', () => {
  function landing(mechanics: Partial<MechanicsConfig>): Run {
    setResolvedArenaConfig('inferno', openArena());
    const encounter = new InfernoEncounter(7);
    const engine = new SimulationEngine({
      encounter,
      combatRandom: () => 0.5,
      enableIntro: true,
      mechanics: { infiniteHealth: true, ...mechanics },
    });
    return { encounter, engine, world: Reflect.get(engine, 'worldState') };
  }
  const LANDED = 'You hit the ground in the centre of The Inferno.';

  it('lands a run started on wave 1 with seq 4367, then says so on its first tick, with wave 1 still at +11', () => {
    const run = landing({ infernoStartWave: '1' });
    expect(run.engine.getState()).toMatchObject({
      introActive: true,
      playerPosition: [30, 32],
      playerFacingAngle: 1024,
    });
    expect(run.engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({ type: 'intro_started', animationSeqId: 4367, landingPosition: [30, 32] }),
    );
    // Held until the animation completes: nothing runs during the landing.
    expect(run.engine.canAdvance()).toBe(false);
    run.engine.completeIntro();
    const events = advanceTo(run, ENTRY_SPAWN);
    expect(messages(events.get(1))).toEqual([LANDED]);
    expect([...events].filter(([, tickEvents]) => messages(tickEvents).includes(LANDED)).map(([tick]) => tick)).toEqual(
      [1],
    );
    expect(messages(events.get(ENTRY_SPAWN))).toEqual(['Wave: 1']);
  });

  it('has no intro or landing line on any other start, nor with intros off', () => {
    for (const mechanics of [{ infernoStartWave: '30' }, { infernoStartWave: '69' }]) {
      const run = landing(mechanics);
      expect(run.engine.getState().introActive).toBe(false);
      expect(run.engine.getLastTickEvents().some((event) => event.type === 'intro_started')).toBe(false);
      expect(messages(advanceTo(run, 1).get(1))).not.toContain(LANDED);
    }
    const quiet = setup({ infernoStartWave: '1' });
    expect(quiet.engine.getState().introActive).toBe(false);
    expect(messages(advanceTo(quiet, 1).get(1))).not.toContain(LANDED);
  });

  it('keeps the landing through tick-zero edits only while the setup still opens with it, never starting one', () => {
    /**
     * Each case edits the start wave at tick 0 as the practice pane's field does, then plays tick 1 live
     * and from a recording (which applies the first frame's setup at tick 0, as the live edit did).
     */
    const firstTick = (start: string, edits: readonly string[], completeFirst: boolean) => {
      const run = landing({ infernoStartWave: start });
      const recorder = new ReplayRecorder();
      recorder.startRun(run.engine.getRunConfig());
      recorder.recordFrame(0, run.engine.getState().playerPosition, run.engine.getState(), [], 0);
      const playing = run.engine.getState().introActive;
      if (completeFirst) run.engine.completeIntro();
      for (const wave of edits) run.engine.setMechanicsConfig({ infiniteHealth: true, infernoStartWave: wave });
      const intro = { playing: run.engine.getState().introActive, started: playing };
      run.engine.completeIntro();
      run.engine.advanceTick(run.engine.getState().playerPosition);
      const state = run.engine.getState();
      recorder.recordFrame(1, state.playerPosition, state, run.engine.getLastTickEvents(), 600);
      const runConfig = recorder.getRunConfig();
      if (!runConfig) throw new Error('missing run config');
      const replayed = reconstructReplayPrefix(runConfig, recorder.getReconstructionFrames(), 1, null);
      expect(messages(replayed?.getLastTickEvents())).toEqual(messages(run.engine.getLastTickEvents()));
      expect(replayed?.getState().playerFacingAngle).toBe(state.playerFacingAngle);
      return { intro, messages: messages(run.engine.getLastTickEvents()), facing: state.playerFacingAngle };
    };

    // Off wave 1 while the landing plays: it plays out (the countdown waits on it), unannounced.
    expect(firstTick('1', ['30'], false)).toEqual({
      intro: { started: true, playing: true },
      messages: ['Wave: 30'],
      facing: 1024,
    });
    // Off wave 1 after it, during the countdown; and typing "12", which passes through 1.
    expect(firstTick('1', ['30'], true).messages).toEqual(['Wave: 30']);
    expect(firstTick('1', ['12'], true).messages).toEqual(['Wave: 12']);
    // Back on wave 1 before tick 1: the run opens with its landing again.
    expect(firstTick('1', ['30', '1'], true).messages).toEqual([LANDED]);
    // Onto wave 1 from a run that had no landing: none starts mid-countdown, and none is announced.
    expect(firstTick('30', ['1'], false)).toEqual({
      intro: { started: false, playing: false },
      messages: [],
      facing: 1024,
    });
    expect(firstTick('30', ['1', '12'], false).messages).toEqual(['Wave: 12']);
  });

  it('lands again on every restart into wave 1, and reconstructs the landing from its run config', () => {
    const run = landing({ infernoStartWave: '30' });
    advanceTo(run, 11);
    practiceRestart(run, goTo(1));
    expect(run.engine.getState()).toMatchObject({ introActive: true, playerPosition: [30, 32] });
    run.engine.completeIntro();
    advanceTo(run, 3);
    practiceRestart(run, RETRY);
    expect(run.engine.getState().introActive).toBe(true);

    const rebuilt = createSimulationEngineFromRunConfig(run.engine.getRunConfig(), null);
    if (!rebuilt) throw new Error('missing rebuilt engine');
    expect(rebuilt.getState().introActive).toBe(true);
    rebuilt.completeIntro();
    rebuilt.advanceTick(rebuilt.getState().playerPosition);
    expect(messages(rebuilt.getLastTickEvents())).toEqual([LANDED]);
  });
});

describe('Inferno practice restart start tile', () => {
  it('restarts Retry and Random spawns on the tile the player stands on, and records it; Go opens on the start tile', () => {
    const run = setup({ infernoStartWave: '30' });
    advanceTo(run, 11);
    standOn(run, BEHIND_SOUTH_PILLAR);
    expect(practiceRestart(run, RETRY).startPosition).toEqual(BEHIND_SOUTH_PILLAR);
    expect(run.engine.getState().playerPosition).toEqual(BEHIND_SOUTH_PILLAR);
    expect(run.engine.getRunConfig().bootstrap?.startPosition).toEqual(BEHIND_SOUTH_PILLAR);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 30, startWave: 30 } });
    // The app re-applies the saved setup at tick 0; the run keeps its start as well as its wave.
    run.engine.setMechanicsConfig({ infiniteHealth: true, infernoStartWave: '30' });
    expect(run.engine.getState().playerPosition).toEqual(BEHIND_SOUTH_PILLAR);

    advanceTo(run, 15);
    standOn(run, [24, 30]);
    expect(practiceRestart(run, REROLL).startPosition).toEqual([24, 30]);
    expect(run.engine.getState().playerPosition).toEqual([24, 30]);

    // A dead player's tile is kept as well.
    advanceTo(run, 15);
    const player = run.world.getPlayer();
    if (!player) throw new Error('missing player');
    player.alive = false;
    expect(practiceRestart(run, RETRY).startPosition).toEqual([24, 30]);
    expect(run.engine.getState().playerPosition).toEqual([24, 30]);

    // Go to wave is a fresh start: the setup's start tile, wherever the player stood.
    advanceTo(run, 15);
    expect(practiceRestart(run, goTo(45)).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([34, 44]);
    expect(run.engine.getRunConfig().bootstrap?.startPosition).toEqual([34, 44]);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 45, startWave: 45 } });
    standOn(run, [24, 30]);
    expect(practiceRestart(run, goTo(45)).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([34, 44]);
  });

  it('opens wave 1 on the landing tile and wave 69 on its own start, and leaves wave 69 for the landing tile', () => {
    const run = setup({ infernoStartWave: '1' });
    advanceTo(run, 11);
    standOn(run, [25, 30]);
    expect(practiceRestart(run, RETRY).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([30, 32]);

    standOn(run, [25, 30]);
    expect(practiceRestart(run, goTo(30)).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([34, 44]);
    standOn(run, [26, 30]);
    expect(practiceRestart(run, goTo(1)).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([30, 32]);

    standOn(run, [26, 30]);
    expect(practiceRestart(run, goTo(69)).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([31, 44]);
    expect(run.engine.getRunConfig().bootstrap?.startPosition).toEqual([31, 44]);
    expect(run.world.getNpc('zuk')).not.toBeNull();

    advanceTo(run, 5);
    standOn(run, [33, 40]);
    expect(practiceRestart(run, RETRY).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([31, 44]);
    standOn(run, [33, 40]);
    expect(practiceRestart(run, goTo(30)).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([34, 44]);
  });

  it('opens on the start tile where the restarted run would block the remembered one', () => {
    const run = setup({ infernoStartWave: '30' });
    advanceTo(run, 11);
    const south = run.world.getNpc('inferno_pillar_south');
    if (!south) throw new Error('missing pillar');
    kill(run, south);
    advanceTo(run, 13);
    expect(run.world.getNpc(south.id)).toBeNull();
    // On the collapsed pillar's footprint, which the restart stands up again.
    standOn(run, [28, 24]);
    expect(practiceRestart(run, RETRY).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([34, 44]);
    advanceTo(run, 11);
    expect(run.world.getNpc('inferno_pillar_south')).not.toBeNull();

    // No pillars stand from wave 67, so the same tile is kept by a Retry there.
    practiceRestart(run, goTo(67));
    standOn(run, [28, 24]);
    expect(practiceRestart(run, RETRY).startPosition).toEqual([28, 24]);

    // Closed terrain: off the arena floor.
    standOn(run, [10, 10]);
    expect(practiceRestart(run, RETRY).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([34, 44]);
  });

  it('opens a plain restart, at the saved start wave, by the same rules', () => {
    const restartAt = (run: Run) => {
      const start = run.engine.planRestartStart();
      run.engine.reset(start ?? undefined);
      return start;
    };
    const run = setup({ infernoStartWave: '30' });
    advanceTo(run, 11);
    standOn(run, BEHIND_SOUTH_PILLAR);
    expect(restartAt(run)).toEqual(BEHIND_SOUTH_PILLAR);
    expect(run.engine.getState().playerPosition).toEqual(BEHIND_SOUTH_PILLAR);
    expect(run.engine.getRunConfig().bootstrap?.startPosition).toEqual(BEHIND_SOUTH_PILLAR);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 30, startWave: 30 } });

    // After a jump to another wave, the plain restart goes back to the saved one, from the same tile.
    practiceRestart(run, goTo(45));
    advanceTo(run, 5);
    standOn(run, [24, 30]);
    expect(restartAt(run)).toEqual([24, 30]);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 30, startWave: 30 } });

    // Out of wave 69's stage: the start tile of the saved wave 30.
    practiceRestart(run, goTo(69));
    standOn(run, [33, 40]);
    expect(restartAt(run)).toBeNull();
    expect(run.engine.getState().playerPosition).toEqual([34, 44]);

    const zukSetup = setup({ infernoStartWave: '69' });
    advanceTo(zukSetup, 5);
    standOn(zukSetup, [33, 40]);
    expect(restartAt(zukSetup)).toBeNull();
    expect(zukSetup.engine.getState().playerPosition).toEqual([31, 44]);

    const waveOne = setup({ infernoStartWave: '1' });
    advanceTo(waveOne, 11);
    standOn(waveOne, BEHIND_SOUTH_PILLAR);
    expect(restartAt(waveOne)).toBeNull();
    expect(waveOne.engine.getState().playerPosition).toEqual([30, 32]);
  });

  it('keeps a tile on a pillar the setup has destroyed', () => {
    const run = setup({ infernoStartWave: '30', infernoSouthPillarDestroyed: true });
    advanceTo(run, 11);
    standOn(run, [28, 24]);
    expect(practiceRestart(run, RETRY).startPosition).toEqual([28, 24]);
    expect(run.engine.getState().playerPosition).toEqual([28, 24]);
  });
});

describe('Inferno practice start tile', () => {
  /** A fresh entry as the app makes one: the engine built with the saved setup. */
  function enter(mechanics: Partial<MechanicsConfig>, arena: ArenaConfig = openArena()): Run {
    setResolvedArenaConfig('inferno', arena);
    const encounter = new InfernoEncounter(7);
    const engine = new SimulationEngine({
      encounter,
      combatRandom: () => 0.5,
      mechanics: { infiniteHealth: true, ...mechanics },
    });
    return { encounter, engine, world: Reflect.get(engine, 'worldState') as WorldState };
  }
  const opensOn = (mechanics: Partial<MechanicsConfig>, arena?: ArenaConfig) =>
    enter(mechanics, arena).engine.getState().playerPosition;

  it('opens waves 2-68 on the start tile, two north of the north-east pillar, and waves 1 and 69 on their own', () => {
    expect(INFERNO_PRACTICE_START_TILE).toEqual([34, 44]);
    for (const wave of ['2', '30', '66', '67', '68'])
      expect(opensOn({ infernoStartWave: wave }), wave).toEqual([34, 44]);
    expect(opensOn({ infernoStartWave: '1' })).toEqual([30, 32]);
    expect(opensOn({ infernoStartWave: '69' })).toEqual([31, 44]);
    // A chosen tile changes only waves 2-68.
    const tile = { [INFERNO_START_TILE_KEY]: '24,30' };
    expect(opensOn({ infernoStartWave: '30', ...tile })).toEqual([24, 30]);
    expect(opensOn({ infernoStartWave: '68', ...tile })).toEqual([24, 30]);
    expect(opensOn({ infernoStartWave: '1', ...tile })).toEqual([30, 32]);
    expect(opensOn({ infernoStartWave: '69', ...tile })).toEqual([31, 44]);
    const recorded = enter({ infernoStartWave: '30', ...tile }).engine.getRunConfig();
    expect(recorded.bootstrap?.startPosition).toEqual([24, 30]);
    expect(recorded.bootstrap?.mechanicsConfig[INFERNO_START_TILE_KEY]).toBe('24,30');
    expect(new InfernoEncounter(1).runStartMechanicsKeys).toContain(INFERNO_START_TILE_KEY);
  });

  it('falls back to the default on a tile the run would not let the player stand on', () => {
    const at = (tile: string, extra: Partial<MechanicsConfig> = {}, arena?: ArenaConfig) =>
      opensOn({ infernoStartWave: '30', [INFERNO_START_TILE_KEY]: tile, ...extra }, arena);
    // Under the standing south pillar (SW 27,23); open once the setup has it down, or from wave 67.
    expect(at('28,24')).toEqual([34, 44]);
    expect(at('28,24', { infernoSouthPillarDestroyed: true })).toEqual([28, 24]);
    expect(at('28,24', { infernoStartWave: '67' })).toEqual([28, 24]);
    // Outside the arena, unreadable, or closed terrain in this arena.
    for (const tile of ['10,10', '46,30', 'x', '24, 30', '']) expect(at(tile), tile).toEqual([34, 44]);
    const walled = openArena();
    walled.walkableTiles?.delete('24,30');
    expect(at('24,30', {}, walled)).toEqual([34, 44]);
  });

  it('opens Go to wave on the chosen tile; Retry still keeps the tile the player stood on', () => {
    const run = enter({ infernoStartWave: '30', [INFERNO_START_TILE_KEY]: '24,30' });
    advanceTo(run, 5);
    standOn(run, [40, 30]);
    expect(practiceRestart(run, goTo(40)).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([24, 30]);
    standOn(run, [40, 30]);
    expect(practiceRestart(run, RETRY).startPosition).toEqual([40, 30]);
    expect(practiceRestart(run, REROLL).startPosition).toEqual([40, 30]);
    // On the chosen tile, Retry opens there as the default.
    standOn(run, [24, 30]);
    expect(practiceRestart(run, RETRY).startPosition).toBeUndefined();
    expect(run.engine.getState().playerPosition).toEqual([24, 30]);
  });

  it('never moves the player for a tick-zero edit within the ordinary waves, nor when a wave is cleared', () => {
    const run = enter({ infernoStartWave: '30' });
    run.engine.setMechanicsConfig({ infiniteHealth: true, infernoStartWave: '30', [INFERNO_START_TILE_KEY]: '24,30' });
    expect(run.engine.getState().playerPosition).toEqual([34, 44]);
    // The setup takes it, as it takes pillars (so a rebuilt run publishes the same): no Go prompt.
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { startPlayerTile: '24,30' } });
    advanceTo(run, SPAWN);
    standOn(run, [40, 30]);
    const completedAt = clearWave(run);
    advanceTo(run, completedAt + 6);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 31 } });
    expect(run.engine.getState().playerPosition).toEqual([40, 30]);
  });

  it('publishes the player’s tile when the wave spawned', () => {
    const tileAtSpawn = (run: Run) => {
      const snapshot = run.engine.getEncounterSnapshot();
      if (snapshot.kind !== 'inferno') throw new Error('wrong encounter');
      return snapshot.state.waveStartPlayerTile;
    };
    const run = enter({ infernoStartWave: '30' });
    expect(tileAtSpawn(run)).toBeNull();
    advanceTo(run, SPAWN);
    expect(tileAtSpawn(run)).toEqual([34, 44]);
    standOn(run, [40, 30]);
    expect(tileAtSpawn(run)).toEqual([34, 44]);
    const completedAt = clearWave(run);
    expect(tileAtSpawn(run)).toBeNull();
    advanceTo(run, completedAt + 6);
    expect(tileAtSpawn(run)).toEqual(run.engine.getState().playerPosition);
    expect(tileAtSpawn(enter({ infernoStartWave: '69' }))).toBeNull();
  });

  it('publishes the start tile the run was started with, so a changed one waits for Go', () => {
    const startTile = (run: Run) => {
      const snapshot = run.engine.getEncounterSnapshot();
      if (snapshot.kind !== 'inferno') throw new Error('wrong encounter');
      return snapshot.state.startPlayerTile;
    };
    const savedKey = (config: Partial<MechanicsConfig>) => infernoRunSetupKey(resolveInfernoRunSetup(config));
    const startedWith = (run: Run) => infernoRunStartedWith(run.engine.getEncounterSnapshot());
    const saved = { infiniteHealth: true, infernoStartWave: '30', infernoSouthPillarDestroyed: true };

    // Unset and the default resolve alike, and leave the key as it was without a start tile.
    const plain = enter(saved);
    expect(startTile(plain)).toBe('34,44');
    expect(startedWith(plain)).toBe('south');
    expect(savedKey({ ...saved, [INFERNO_START_TILE_KEY]: '34,44' })).toBe('south');
    // Waves 1 and 69 use none: '' and no tile in the key, whatever is saved.
    for (const wave of ['1', '69']) {
      const other = enter({ ...saved, infernoStartWave: wave, [INFERNO_START_TILE_KEY]: '24,30' });
      expect(startTile(other)).toBe('');
      expect(startedWith(other)).toBe(
        savedKey({ ...saved, infernoStartWave: wave, [INFERNO_START_TILE_KEY]: '24,30' }),
      );
    }

    const first = { ...saved, [INFERNO_START_TILE_KEY]: '24,30' };
    const run = enter(first);
    expect(startTile(run)).toBe('24,30');
    expect(startedWith(run)).toBe('south;start=24,30');
    expect(savedKey(first)).toBe(startedWith(run));

    // A change saved mid-fight is pending until Go.
    advanceTo(run, 5);
    const edited = { ...saved, [INFERNO_START_TILE_KEY]: '40,30' };
    run.engine.setMechanicsConfig(edited);
    expect(startTile(run)).toBe('24,30');
    expect(savedKey(edited)).not.toBe(startedWith(run));

    // Retry and Random spawns keep the attempt's tile as a run override; the change stays pending.
    expect(practiceRestart(run, RETRY).runMechanics).toEqual({
      infernoStartWave: '30',
      [INFERNO_START_TILE_KEY]: '24,30',
    });
    expect(startTile(run)).toBe('24,30');
    expect(practiceRestart(run, REROLL).runMechanics).toEqual({
      infernoStartWave: '30',
      [INFERNO_START_TILE_KEY]: '24,30',
    });
    expect(startTile(run)).toBe('24,30');
    expect(savedKey(edited)).not.toBe(startedWith(run));

    // Go applies it.
    practiceRestart(run, goTo(30));
    expect(run.engine.getState().playerPosition).toEqual([40, 30]);
    expect(startTile(run)).toBe('40,30');
    expect(savedKey(edited)).toBe(startedWith(run));
    // With nothing pending, Retry adds no override.
    expect(practiceRestart(run, RETRY).runMechanics).toEqual({ infernoStartWave: '30' });
  });
});

const cachePath = findProjectCacheZip('pinned') ?? '';

it.skipIf(skipWithoutRealCache('pinned'))(
  'bakes the Rocky supports as 3x3 movement and sight blockers from the cache',
  async () => {
    await Bzip2.initWasm();
    const files = await readCacheZipFiles(cachePath);
    const cache = CacheSystem.fromMap('dat2', files, [2]);
    const locs = new ArchiveLocTypeLoader(
      { name: 'osrs-test', game: 'oldschool', environment: 'live', revision: 232, timestamp: '2024-01-01', size: 0 },
      cache.getIndex(2).getArchive(6),
    );
    for (const pillar of INFERNO_PILLARS) {
      expect(locs.load(pillar.locId)).toMatchObject({ sizeX: 3, sizeY: 3, clipType: 1, blocksProjectile: true });
    }
    expect(getArenaConfig()).toBeDefined();
  },
  60000,
);

describe('Inferno replay reconstruction', () => {
  /** A recording made the way the live wiring makes one: run start, then one frame per tick. */
  function recordRun(engine: SimulationEngine) {
    const recorder = new ReplayRecorder();
    recorder.startRun(engine.getRunConfig());
    recorder.recordPresentationState(1, 0, ReplayPresentationStateSchema.parse(validPresentationSample().state));
    recorder.recordFrame(0, engine.getState().playerPosition, engine.getState(), [], 0);
    const step = () => {
      engine.advanceTick(engine.getState().playerPosition);
      const state = engine.getState();
      recorder.recordFrame(
        state.currentTick,
        state.playerPosition,
        state,
        engine.getLastTickEvents(),
        state.currentTick * 600,
      );
      return engine.getLastTickEvents();
    };
    return { recorder, step };
  }

  /**
   * Fights the wave a while (its NPCs attack), then kills it and plays on into the next one. Returns
   * the last tick before the test's own kills, which are not recorded inputs and so not replayable.
   */
  function fightThroughWave(run: Run, step: () => readonly GameEvent[]): number {
    for (let guard = 0; guard < 60 && run.engine.currentTick < 25; guard++) step();
    const replayableThrough = run.engine.currentTick;
    for (let guard = 0; guard < 200; guard++) {
      for (const npc of waveNpcs(run)) if (npc.alive) kill(run, npc);
      if (messages(step()).includes('Wave completed!')) break;
    }
    for (let guard = 0; guard < 20; guard++) step();
    return replayableThrough;
  }

  /** The recording as a fresh recorder loads it: a detached export. */
  function exportedRecording(recorder: ReplayRecorder): ReplayRecorderData {
    return recorder.exportData();
  }

  function expectReconstructs(data: ReplayRecorderData, last: number): void {
    const loaded = new ReplayRecorder();
    loaded.load(data);
    const runConfig = loaded.getRunConfig();
    if (!runConfig) throw new Error('missing run config');
    const engine = reconstructReplayPrefix(runConfig, loaded.getReconstructionFrames(), last, null);
    expect(
      diffResumableState(loaded.getFrame(last)?.state as SimulationState, engine?.getState() as SimulationState),
    ).toEqual([]);
  }

  it('replays a run through a wave transition, and its Retry Wave restart, with never-targetable supports', () => {
    setResolvedArenaConfig('inferno', openArena());
    const engine = new SimulationEngine({ encounter: new InfernoEncounter(7), combatSeed: 1234 });
    // A custom layout for wave 2 (one bat placed), so its Retry keeps the run seed under an attempt seed.
    const layout = '2:b--------';
    engine.setMechanicsConfig({ infiniteHealth: true, infernoStartWave: '1', [INFERNO_SPAWN_LAYOUT_KEY]: layout });
    const run: Run = { encounter: Reflect.get(engine, 'encounter'), engine, world: Reflect.get(engine, 'worldState') };
    const first = recordRun(engine);
    const firstReplayable = fightThroughWave(run, first.step);
    const wave = (engine.getEncounterSnapshot() as InfernoSnapshot).state.wave;
    expect(wave).toBe(2);
    expectReconstructs(exportedRecording(first.recorder), firstReplayable);
    // The Rocky supports are in every frame's snapshot: untargetable for good, with finite ticks.
    expect(engine.getState().npcs.filter((npc) => npc.npcTypeId === 7709)).toHaveLength(3);
    expect(
      engine.getState().npcs.every((npc) => npc.targetableFromTick === undefined || npc.targetableFromTick < 1e6),
    ).toBe(true);

    // Retry Wave: the wiring's practice restart, a fresh recording of the run seed under a new
    // attempt seed at this wave.
    const retry = engine.planPracticeRestart({ encounter: 'inferno', type: 'retry-wave' });
    if (!retry) throw new Error('expected a practice restart');
    expect(retry.encounterSeeds).toEqual({ runSeed: 7, attemptSeed: expect.any(Number) });
    engine.reset(undefined, practiceRunConfig(engine, retry), retry.runMechanics);
    expect(engine.getEncounterSnapshot()).toMatchObject({ state: { wave, startSpawnLayout: layout } });
    const second = recordRun(engine);
    const secondReplayable = fightThroughWave(run, second.step);
    const recording = exportedRecording(second.recorder);
    expect(recording.runConfig?.bootstrap?.mechanicsConfig.infernoStartWave).toBe(String(wave));
    expect(recording.runConfig?.encounter.seeds).toEqual(retry.encounterSeeds);
    expectReconstructs(recording, secondReplayable);
  });

  it('replays a Retry Wave restart from the tile the player walked to, and replays it from there', () => {
    setResolvedArenaConfig('inferno', openArena());
    const engine = new SimulationEngine({ encounter: new InfernoEncounter(7), combatSeed: 1234 });
    engine.setMechanicsConfig({ infiniteHealth: true, infernoStartWave: '30' });
    const run: Run = { encounter: Reflect.get(engine, 'encounter'), engine, world: Reflect.get(engine, 'worldState') };
    // Round the south pillar to its far side.
    for (let guard = 0; guard < 20 && engine.getState().playerPosition.join() !== BEHIND_SOUTH_PILLAR.join(); guard++) {
      engine.advanceTick(BEHIND_SOUTH_PILLAR);
    }
    expect(engine.getState().playerPosition).toEqual(BEHIND_SOUTH_PILLAR);

    expect(practiceRestart(run, RETRY).startPosition).toEqual(BEHIND_SOUTH_PILLAR);
    const restarted = recordRun(engine);
    for (let guard = 0; guard < 20; guard++) restarted.step();
    const recording = exportedRecording(restarted.recorder);
    expect(recording.runConfig?.bootstrap?.startPosition).toEqual(BEHIND_SOUTH_PILLAR);
    expect(recording.frames[0]?.state.playerPosition).toEqual(BEHIND_SOUTH_PILLAR);
    expectReconstructs(recording, 0);
    expectReconstructs(recording, 20);
  });

  it('replays a Lock layout restart, whose takeover keeps the spawns for Retry', () => {
    setResolvedArenaConfig('inferno', openArena());
    const engine = new SimulationEngine({ encounter: new InfernoEncounter(7), combatSeed: 1234 });
    const saved = { infiniteHealth: true, infernoStartWave: '30' };
    engine.setMechanicsConfig(saved);
    const run: Run = { encounter: Reflect.get(engine, 'encounter'), engine, world: Reflect.get(engine, 'worldState') };
    const keep = practiceRestart(run, KEEP);
    const recorded = recordRun(engine);
    for (let guard = 0; guard < 20; guard++) recorded.step();
    const recording = exportedRecording(recorded.recorder);
    expect(recording.runConfig?.bootstrap?.mechanicsConfig[INFERNO_PINNED_WAVE_KEY]).toBe('30');
    expect(recording.runConfig?.encounter.seeds).toEqual(keep.encounterSeeds);
    expect(recording.frames.at(-1)?.state.encounter.state).toMatchObject({ wave: 30, pinnedWave: 30 });
    expectReconstructs(recording, 0);
    expectReconstructs(recording, 20);

    // A takeover at tick 0, whose viewer's own setup has no pin, keeps the run's.
    const loaded = new ReplayRecorder();
    loaded.load(recording);
    const runConfig = loaded.getRunConfig();
    if (!runConfig) throw new Error('missing run config');
    const takeover = reconstructReplayPrefix(runConfig, loaded.getReconstructionFrames(), 0, null);
    if (!takeover) throw new Error('expected a reconstruction');
    takeover.setMechanicsConfig(saved);
    expect(takeover.getEncounterSnapshot()).toMatchObject({ state: { wave: 30, pinnedWave: 30 } });
    expect(takeover.planPracticeRestart(RETRY)).toMatchObject({
      encounterSeeds: { runSeed: 7, attemptSeed: expect.any(Number) },
      runMechanics: { infernoStartWave: '30', [INFERNO_PINNED_WAVE_KEY]: '30' },
    });
  });
});

describe('Inferno wave 68 into wave 69', () => {
  /** Clears wave 68; returns its completion tick K and wave 69's control tick C = K + 18. */
  function clearWave68(run: Run): { cleared: number; control: number } {
    advanceTo(run, SPAWN);
    const cleared = clearWave(run);
    return { cleared, control: cleared + ZUK_INTRO_DELAY_TICKS - ZUK_INTRO.busyFrom };
  }
  const zukActors = ({ world }: Run) => world.getNpcs().filter((npc) => npc.id === 'zuk' || npc.id === 'zuk_shield');

  it('plays the recorded intro around control C, then opens wave 69 on its own clocks', () => {
    const run = setup({ infernoStartWave: '68', infiniteHealth: true });
    const { cleared, control } = clearWave68(run);
    expect(control).toBe(cleared + 18);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({
      state: { wave: 69, phase: 'countdown', nextWaveTick: control, zuk: null },
      visuals: { zukControlTick: control },
    });
    const locked = new Map<number, boolean>();
    const glyphY = new Map<number, number>();
    const events = new Map<number, readonly GameEvent[]>();
    while (run.engine.currentTick < control + 80) {
      const tick = run.engine.currentTick + 1;
      if (tick < control - 8) expect(zukActors(run)).toEqual([]);
      for (const [at, tickEvents] of advanceTo(run, tick)) events.set(at, tickEvents);
      locked.set(tick, run.engine.didLastTickDiscardWalkTarget());
      const glyph = run.world.getNpc('zuk_shield');
      if (glyph) glyphY.set(tick, glyph.position[1]);
      if (tick === control - 10) {
        const player = run.world.getPlayer();
        expect(player?.position).toEqual([31, 44]);
        expect(player?.facing).toBe(1024);
      }
    }
    // Busy from C-12 through control; free in the gap before and from C+1.
    expect([...locked].filter(([, value]) => value).map(([tick]) => tick)).toEqual(
      Array.from({ length: 13 }, (_, index) => control - 12 + index),
    );
    // Added at C-8 on the alcove tile, three steps south C-6..C-4, patrol from C+1.
    expect(glyphY.get(control - 8)).toBe(51);
    expect([control - 6, control - 5, control - 4].map((tick) => glyphY.get(tick))).toEqual([50, 49, 48]);
    expect(glyphY.get(control)).toBe(48);
    expect(run.world.getNpc('zuk')).toMatchObject({ position: [28, 52], spawnTick: control });
    expect(run.world.getNpc('zuk_shield')?.spawnTick).toBe(control);
    expect(messages(events.get(control))).toEqual(['Wave: 69']);
    // The intro's lines go to chat: the mesbox at C-12, TzHaar-Ket-Keh's dialogue at C-8 (W69 L2756, L2833).
    expect(messages(events.get(control - 12))).toEqual([ZUK_INTRO_MESSAGES.busy]);
    expect(events.get(control - 8)?.filter((event) => event.type === 'game_message')).toMatchObject([
      { kind: 'public', speaker: 'Tzhaar-Ket-Keh', segments: [{ text: ZUK_INTRO_MESSAGES.prison }] },
    ]);
    // Zuk rises (seq 7563) as he is added at C-8, cued there: his spawn tick is C, the cast clock's epoch.
    const riseCues = [...events].flatMap(([tick, tickEvents]) =>
      tickEvents
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations.filter((cue) => cue.clipId === ZUK_INTRO_RISE_CLIP).map(() => tick)),
    );
    expect(riseCues).toEqual([control - 8]);
    const zukCasts = [...events]
      .flatMap(([, tickEvents]) => tickEvents)
      .filter((event) => event.type === 'zuk_attack' && (event as { attack?: string }).attack === 'zuk_blast');
    expect(zukCasts[0]?.tick).toBe(control + 13);
    expect(run.world.getNpcs().filter((npc) => npc.npcTypeId === 7703 || npc.npcTypeId === 7702)).toHaveLength(2);
    const setTicks = run.world
      .getNpcs()
      .filter((npc) => npc.npcTypeId === 7703)
      .map((npc) => npc.spawnTick);
    expect(setTicks).toEqual([control + 72]);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({ state: { wave: 69, phase: 'active' } });
    expect(run.engine.getEncounterOutcome().phase).toBe('active');
    // Same kind throughout: the opening camera, re-read only on a kind change, is never reset here.
    expect(run.engine.getState().encounter.kind).toBe('inferno');
  });

  it('carries the player, loadout, ground items and clocks straight through, with no prepot, heal or reset', () => {
    const run = setup({ infernoStartWave: '68', infiniteHealth: false, autoPrepot: true });
    const engine = run.engine;
    const inventory = engine.getState().inventory.slice();
    inventory[0] = { id: 6685 };
    inventory[1] = { id: 3024 };
    engine.setInventory(inventory);
    const { control } = clearWave68(run);
    const player = run.world.getPlayer();
    if (!player) throw new Error('missing player');
    // Deliberately altered state the transition must not touch.
    player.vitals.hp = 57;
    player.stats = { ...player.stats, hitpoints: { ...player.stats.hitpoints, current: 57 } };
    player.prayerState = { ...player.prayerState, points: 33 };
    player.stats = { ...player.stats, prayer: { ...player.stats.prayer, current: 33 } };
    player.specialAttack = { ...player.specialAttack, energy: 450 };
    engine.applyAction({ type: 'dropItem', inventoryIndex: 1 });
    advanceTo(run, engine.currentTick + 1);
    const dropped = engine.getState().groundItems;
    expect(dropped).toHaveLength(1);
    const combatRandom = Reflect.get(engine, 'combatRandom');
    const eventIdBefore = engine.getLastTickEvents().at(-1)?.eventId ?? 0;
    const statsBefore = structuredClone(player.stats);

    advanceTo(run, control + 1);
    const after = run.world.getPlayer();
    expect(after).toBe(player);
    expect(after?.vitals.hp).toBeLessThanOrEqual(57);
    expect(after?.inventory[0]).toEqual({ id: 6685 });
    expect(after?.inventory[1]).toBeNull();
    expect(after?.stats.attack).toEqual(statsBefore.attack);
    expect(after?.stats.strength).toEqual(statsBefore.strength);
    expect(after?.specialAttack.energy).toBeGreaterThanOrEqual(450);
    expect(engine.getState().groundItems).toEqual(dropped);
    expect(Reflect.get(engine, 'combatRandom')).toBe(combatRandom);
    expect(engine.currentTick).toBe(control + 1);
    expect(engine.getLastTickEvents().every((event) => event.eventId > eventIdBefore)).toBe(true);
    expect(after?.position).toEqual([31, 44]);
  });

  it('drops a busy player’s inputs and walk, and takes them again from C+1', () => {
    const run = setup({ infernoStartWave: '68' });
    const { control } = clearWave68(run);
    // The busy window's first tick, C-12, already drops the inputs queued for it.
    advanceTo(run, control - 13);
    const before = run.world.getPlayer()?.position;
    run.engine.applyAction({ type: 'protectionPrayer', prayer: PrayerType.ProtectMagic });
    run.engine.advanceTick([31, 40]);
    expect(run.engine.currentTick).toBe(control - 12);
    expect(run.engine.didLastTickDiscardWalkTarget()).toBe(true);
    expect(run.world.getPlayer()?.activePrayer).toBeNull();
    expect(run.world.getPlayer()?.position).toEqual(before);
    advanceTo(run, control - 9);
    run.engine.applyAction({ type: 'protectionPrayer', prayer: PrayerType.ProtectMagic });
    run.engine.advanceTick([31, 40]);
    expect(run.world.getPlayer()?.activePrayer).toBeNull();
    expect(run.world.getPlayer()?.position).toEqual([31, 44]);
    advanceTo(run, control);
    run.engine.applyAction({ type: 'protectionPrayer', prayer: PrayerType.ProtectMagic });
    run.engine.advanceTick([31, 40]);
    expect(run.engine.didLastTickDiscardWalkTarget()).toBe(false);
    expect(run.world.getPlayer()?.activePrayer).toBe(PrayerType.ProtectMagic);
    expect(run.world.getPlayer()?.position).not.toEqual([31, 44]);
  });

  it('reproduces the run across the boundary from its run config and the same inputs', () => {
    const live = setup({ infernoStartWave: '68' });
    const rebuilt = createSimulationEngineFromRunConfig(live.engine.getRunConfig(), null);
    if (!rebuilt) throw new Error('missing rebuilt engine');
    const twin: Run = {
      encounter: Reflect.get(rebuilt, 'encounter'),
      engine: rebuilt,
      world: Reflect.get(rebuilt, 'worldState'),
    };
    advanceTo(live, SPAWN);
    advanceTo(twin, SPAWN);
    let control: number | null = null;
    let discardingTicks = 0;
    for (let guard = 0; guard < 400 && (control === null || live.engine.currentTick < control + 30); guard++) {
      // The same (unrecorded) kills on both, so the two runs see identical inputs.
      for (const run of [live, twin]) for (const npc of waveNpcs(run)) if (npc.alive) kill(run, npc);
      for (const run of [live, twin]) run.engine.advanceTick(run.engine.getState().playerPosition);
      const snapshot = live.engine.getEncounterSnapshot() as InfernoSnapshot;
      control ??= snapshot.visuals.zukControlTick;
      expect(diffResumableState(live.engine.getState(), rebuilt.getState())).toEqual([]);
      // A takeover reads this off the rebuilt engine to decide whether the anchor's walk survives.
      expect(rebuilt.didLastTickDiscardWalkTarget()).toBe(live.engine.didLastTickDiscardWalkTarget());
      if (live.engine.didLastTickDiscardWalkTarget()) discardingTicks++;
    }
    expect(control).not.toBeNull();
    // Busy from C-12 through C.
    expect(discardingTicks).toBe(1 - ZUK_INTRO.busyFrom);
    expect(live.engine.getEncounterSnapshot()).toEqual(rebuilt.getEncounterSnapshot());
  });

  it('starts a fresh run on wave 69 at its control tick, with no intro', () => {
    const run = setup({ infernoStartWave: '69' });
    expect(run.engine.getState().playerPosition).toEqual([31, 44]);
    expect(zukActors(run).map((npc) => [npc.id, npc.position, npc.spawnTick])).toEqual([
      ['zuk_shield', [30, 48], 0],
      ['zuk', [28, 52], 0],
    ]);
    expect(run.engine.getEncounterSnapshot()).toMatchObject({
      state: { wave: 69, startWave: 69, phase: 'active', nextWaveTick: null },
      visuals: { zukControlTick: 0, pillarLocs: [] },
    });
    const events = [...advanceTo(run, 3)].flatMap(([, tickEvents]) => tickEvents);
    expect(run.engine.didLastTickDiscardWalkTarget()).toBe(false);
    // Zuk is already up: no rise, and none of the intro's lines.
    expect(
      events
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations.filter((cue) => cue.clipId === ZUK_INTRO_RISE_CLIP)),
    ).toEqual([]);
    expect(messages(events)).not.toContain(ZUK_INTRO_MESSAGES.busy);
  });

  it('swaps the opening actors and start tile when a tick-zero edit crosses into or out of wave 69', () => {
    const run = setup({ infernoStartWave: '30' });
    expect(zukActors(run)).toEqual([]);
    run.engine.setMechanicsConfig({ infiniteHealth: true, infernoStartWave: '69' });
    expect(zukActors(run).map((npc) => npc.id)).toEqual(['zuk_shield', 'zuk']);
    expect(run.engine.getState().playerPosition).toEqual([31, 44]);
    expect(run.engine.getRunConfig().bootstrap?.startPosition).toEqual([31, 44]);
    run.engine.setMechanicsConfig({ infiniteHealth: true, infernoStartWave: '69', zukShieldStart: 'left' });
    expect(zukActors(run).map((npc) => npc.id)).toEqual(['zuk_shield', 'zuk']);
    run.engine.setMechanicsConfig({ infiniteHealth: true, infernoStartWave: '12' });
    expect(zukActors(run)).toEqual([]);
    // Out of 69 onto wave 12's own start: the practice start tile.
    expect(run.engine.getState().playerPosition).toEqual([34, 44]);
  });
});
