import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ELYSIAN_SPIRIT_SHIELD_ID } from '../../../core/combat/elysian';
import { applySpecialAttackEffects } from '../../../core/combat/player/specialAttacks/postHitEffects';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import { ReplayRecorder, type ReplayRecorderData } from '../../../core/ReplayRecorder';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { ARDER_MUSCA_POISON_ITEM_ID } from '../../../data/itemIds';
import { DUKE_ASLEEP_NPC_ID, DUKE_NPC_ID, WARDEN_ID, WARDEN_MAX_HP } from '../../../npcs/duke/duke';
import { ObjType } from '../../../rs/config/objtype/ObjType';
import { startAwakeDukeOpening } from '../../../test/helpers/dukeOpening';
import { DUKE_ALWAYS_BILE_KEY, DUKE_AUDIO_EVENT, DUKE_START_PHASE_KEY } from '../../../types/duke';
import { createEmptyCombatSupplies } from '../../../types/encounterLoadout';
import { PARAM_ATTACK_SPEED } from '../../../types/equipmentStats';
import { createEmptyInventory } from '../../../types/inventory';
import { RESTORABLE_STATS } from '../../../types/playerState';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { DUKE_KIND } from '../../catalog';
import { reconstructReplayPrefix } from '../../simulationEngineFactory';
import { SLUG_TO_KIND } from '../../slugs';
import { ORB_LANE, START_TILE, VENTS } from '../arena';
import { BILE_HP, DUKE_CONTROLS, dukeStartHp, ENRAGE_HP, ORB_HP } from '../controls';
import { DukeEncounter } from '../DukeEncounter';
import { DUKE_RENDER_CONFIG } from '../renderConfig';
import {
  DUKE_BILE_CAST_RUN_CAPTURE,
  DUKE_BILE_MELEE_CAPTURES,
  DUKE_BILE_POISON_VARP,
  DUKE_BILE_RECOVERY_CAPTURE,
} from './fixtures/dukeBileCapture';
import {
  DUKE_BASIC_WINDUP_STEPS,
  DUKE_CONSECUTIVE_BILE_DELAY,
  DUKE_ENRAGE_VOLLEY_CAPTURE,
  DUKE_ENRAGED_BILE_CAPTURE,
  DUKE_ENRAGED_LATE_STEP,
  DUKE_ENRAGED_MAGIC_CAPTURE,
  DUKE_ENRAGED_MAGIC_TO_MELEE_CAPTURE,
  DUKE_FAILED_GAZE_CAPTURE,
  DUKE_HIT_SOUND_CAPTURES,
  DUKE_ORB_ACTIVATION_CAPTURE,
  DUKE_ORB_CONTACT_CAPTURE,
  DUKE_ORB_DAMAGE_CAPTURE,
  DUKE_PHASE_VOLLEY_CAPTURES,
  DUKE_PROTECTED_CHIP_CAPTURE,
  DUKE_SLAM_REENTRIES,
  DUKE_UNPROTECTED_CHIP_CAPTURE,
  DUKE_VENT_DAMAGE_CAPTURE,
  DUKE_VENT_PULSE_CAPTURES,
  DUKE_VENT_TIE_CAPTURE,
  DUKE_WEST_ORB_CAPTURE,
  REGULAR_DUKE_LATE_STEPS,
} from './fixtures/dukeCombatCapture';

let arena = getArenaConfig();
let allowUnbounded = getArenaAllowUnboundedFallback();
beforeEach(() => {
  arena = getArenaConfig();
  allowUnbounded = getArenaAllowUnboundedFallback();
});
afterEach(() => {
  setArenaConfig(arena, allowUnbounded);
  vi.restoreAllMocks();
});

function createDukeRun(startPhase = 'opening', infiniteHealth = true, encounterSeed = 71) {
  return new SimulationEngine({
    encounter: new DukeEncounter(encounterSeed),
    mechanics: { [DUKE_START_PHASE_KEY]: startPhase, infiniteHealth },
    combatSeed: 42,
  });
}

function startOpeningAtHp(phase: string, infiniteHealth = true, encounterSeed = 71) {
  const engine = createDukeRun('opening', infiniteHealth, encounterSeed);
  engine.setBossHp(dukeStartHp(phase));
  return engine;
}

function snapshot(engine: SimulationEngine) {
  const state = engine.getState().encounter;
  if (state.kind !== DUKE_KIND) throw new Error(`Unexpected encounter ${state.kind}`);
  return state;
}

function advanceTo(engine: SimulationEngine, tick: number, target: Coordinate = START_TILE): void {
  while (engine.currentTick < tick) {
    const before = engine.currentTick;
    engine.advanceTick(target);
    if (engine.currentTick === before) throw new Error(`Simulation stopped at tick ${before}`);
  }
}

function received(engine: SimulationEngine, source: string): boolean {
  return engine.getState().damageHistory.some((hit) => hit.source === source && hit.targetId === 'player');
}

function audioCues(engine: SimulationEngine) {
  return engine.getLastTickEvents().filter((event) => event.type === DUKE_AUDIO_EVENT);
}

function advanceThroughFlareLaunches(engine: SimulationEngine, endTick: number): number[] {
  const launches: number[] = [];
  for (let tick = engine.currentTick + 1; tick <= endTick; tick++) {
    advanceTo(engine, tick);
    if (audioCues(engine).some((event) => 'cue' in event && event.cue === 'ventLaunch')) launches.push(tick);
  }
  return launches;
}

function mockCombatRolls(engine: SimulationEngine) {
  return vi.spyOn(engine as unknown as { combatRandom: () => number }, 'combatRandom');
}

// HP thresholds and relative timing from https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode
// See the timing ledger and practice setup in docs/encounters/duke-facts-spec.md.
describe('Awakened Duke', () => {
  it('spawns the sleeping cache NPC and leaves its hazards inactive while the player waits', () => {
    const engine = createDukeRun();
    const [boss] = engine.getState().npcs;
    expect(boss.npcTypeId).toBe(DUKE_ASLEEP_NPC_ID);
    expect(DUKE_RENDER_CONFIG.primaryNpc?.npcTypeId).toBe(DUKE_NPC_ID);
    advanceTo(engine, 20);
    expect(engine.getState().npcs[0].npcTypeId).toBe(DUKE_ASLEEP_NPC_ID);
    expect(snapshot(engine).visuals).toEqual({ hazards: [], orbTile: null, usesVisualEvents: true });
  });

  // Cache 2772, map square (47, 100). The floor at y=52 and 53 blocks access under Duke.
  it('keeps sleeping Duke on the map and rejects attack and manual-cast inputs', () => {
    const engine = createDukeRun();
    const front: Coordinate = [31, 51];
    const underDuke: Coordinate = [31, 52];
    advanceTo(engine, 2, underDuke);
    expect(engine.getState().playerPosition).toEqual(front);
    expect(engine.getState().npcs[0].npcTypeId).toBe(12167);
    expect(engine.acceptsEncounterInput({ kind: 'npcInteraction', targetId: WARDEN_ID })).toBe(true);
    const inventory = createEmptyInventory();
    inventory[0] = { id: 556 }; // Air rune
    inventory[1] = { id: 558 }; // Mind rune
    engine.setInventory(inventory);
    engine.setCombatSupplies({ ...createEmptyCombatSupplies(), spellbook: 'standard' });

    for (const action of [
      { type: 'attackTarget', targetId: WARDEN_ID },
      { type: 'manualCast', spellName: 'Wind Strike', targetId: WARDEN_ID },
    ] as const) {
      engine.applyAction(action);
      engine.advanceTick(underDuke);
      expect(engine.getAttackTarget()).toBeNull();
      expect(engine.getLastTickEvents()).not.toContainEqual(expect.objectContaining({ type: 'attack_started' }));
      expect(engine.getLastTickEvents()).not.toContainEqual(expect.objectContaining({ type: 'spell_cast' }));
    }
    advanceTo(engine, 12, underDuke);
    expect(engine.getState().playerPosition).toEqual(front);
    expect(engine.getState().npcs[0]).toMatchObject({ npcTypeId: 12167, hp: 1697 });
    expect(engine.getState().damageHistory).toHaveLength(0);
    expect(snapshot(engine).state.poisonToleranceFilled).toBe(0);
    expect(snapshot(engine).visuals.pose).toBeUndefined();
  });

  it('uses the Awakened formula stats before and after the NPC wakes', () => {
    const engine = createDukeRun();
    const duke = engine['worldState'].getNpc(WARDEN_ID)!;
    const expected = {
      levels: { attack: 435, strength: 500, defence: 316, magic: 465, ranged: 0 },
      offensive: { atk: 200, str: 38, magic: 150, magicStr: 32, ranged: 0, rangedStr: 0 },
      defensive: {
        stab: 255,
        slash: 65,
        crush: 190,
        magic: 440,
        rangedLight: 320,
        rangedStandard: 320,
        rangedHeavy: 320,
      },
      attributes: ['demon'],
      demonbaneVulnerability: 0.7,
    };
    expect(duke.formulaStats).toMatchObject(expected);

    startAwakeDukeOpening(engine);
    advanceTo(engine, 6);
    expect(duke.npcTypeId).toBe(DUKE_NPC_ID);
    expect(duke.formulaStats).toMatchObject(expected);
  });

  it.each([
    { source: 'Slam', tile: [31, 51] as Coordinate, impactTick: 8, levels: { strength: 300 }, bonuses: { str: 0 } },
    { source: 'Magic bolt', tile: START_TILE, impactTick: 10, levels: { magic: 300 }, bonuses: { magicStr: 0 } },
  ])('uses the actor’s offensive stats for the $source damage cap', ({ source, tile, impactTick, levels, bonuses }) => {
    const engine = createDukeRun();
    startAwakeDukeOpening(engine);
    advanceTo(engine, impactTick - 1, tile);
    const duke = engine['worldState'].getNpc(WARDEN_ID)!;
    const stats = duke.formulaStats!;
    duke.formulaStats = {
      ...stats,
      levels: { ...stats.levels, ...levels },
      offensive: { ...stats.offensive, ...bonuses },
    };

    const roll = mockCombatRolls(engine).mockReturnValue(0.999);
    if (source === 'Magic bolt') roll.mockReturnValueOnce(0);
    try {
      engine.advanceTick(tile);
    } finally {
      roll.mockRestore();
    }
    expect(engine.getDamageHistory()).toContainEqual(
      expect.objectContaining({ source, tick: impactTick, baseDamage: 31, effectiveDamage: 31 }),
    );
  });

  it('keeps the Awakened levels when stat-draining effects hit Duke', () => {
    const engine = createDukeRun();
    startAwakeDukeOpening(engine);
    advanceTo(engine, 6);
    const world = engine['worldState'];
    const duke = world.getNpc(WARDEN_ID)!;
    const player = world.getPlayer()!;
    applySpecialAttackEffects(
      player,
      duke,
      30,
      [
        { effect: 'weaken' },
        { effect: 'condemn' },
        { effect: 'drain_defence', flat: true },
        { effect: 'drain_magic', base: 5, percentOfDamage: 10 },
        { effect: 'drain_attack', percent: 15 },
      ],
      engine.currentTick,
    );
    expect(duke.debuffs).toEqual({});
  });

  it.each(DUKE_HIT_SOUND_CAPTURES)('plays $hitSounds Duke hit cues for the Scythe swing on capture tick $tick', ({
    firstHitBlocked,
    hitSounds,
  }) => {
    const engine = createDukeRun();
    engine.setEquipment({ weapon: 22325 }); // Scythe of vitur
    const random = mockCombatRolls(engine)
      .mockReturnValueOnce(firstHitBlocked ? 0.999 : 0)
      .mockReturnValue(0);
    try {
      startAwakeDukeOpening(engine);
      advanceTo(engine, 2, [31, 51]);
      const hits = engine.getState().damageHistory.filter(({ targetId }) => targetId === WARDEN_ID);
      expect(hits).toHaveLength(3);
      expect(hits[0].effectiveDamage === 0).toBe(firstHitBlocked);
      expect(hits.slice(1).every(({ effectiveDamage }) => effectiveDamage > 0)).toBe(true);
      expect(audioCues(engine).filter((event) => 'cue' in event && event.cue === 'dukeHit')).toHaveLength(hitSounds);
    } finally {
      random.mockRestore();
    }
  });

  it('feeds three doses and lands the second swing of a six-tick opener without taking the first slam', () => {
    const engine = createDukeRun('opening', false);
    const openingWeapon = 11806;
    const secondWeapon = 29589;
    engine.setObjTypeLoader({
      load: (id) => {
        const item = new ObjType(id, {
          name: 'test',
          game: 'oldschool',
          environment: 'test',
          revision: 242,
          timestamp: '',
          size: 0,
        });
        item.params = new Map([[PARAM_ATTACK_SPEED, id === openingWeapon ? 6 : 4]]);
        return item;
      },
      getCount: () => 2,
      clearCache: () => {},
    });
    engine.setEquipment({ weapon: openingWeapon });
    const frontTile: Coordinate = [28, 51];
    const coverTile: Coordinate = [27, 51];
    const feed = { type: 'npcInteraction', targetId: WARDEN_ID } as const;
    const input = { kind: 'npcInteraction', targetId: WARDEN_ID } as const;
    const inventory = createEmptyInventory();
    inventory[0] = { id: ARDER_MUSCA_POISON_ITEM_ID };
    engine.setInventory(inventory);

    advanceTo(engine, 2, frontTile);
    expect(engine.acceptsEncounterInput(input)).toBe(true);
    for (const [index, tolerance] of [125, 250, 370].entries()) {
      engine.applyAction(feed);
      engine.applyAction(feed); // Repeated same-tick clicks make one feed.
      advanceTo(engine, 3 + index, frontTile);
      expect(engine.getState().inventory[0]).toEqual({ id: ARDER_MUSCA_POISON_ITEM_ID });
      expect(snapshot(engine).state.poisonToleranceFilled).toBe(tolerance);
      expect(engine.getState().npcs[0]).toMatchObject({ hp: 1697, npcTypeId: 12167 });
      expect(engine.getState().npcs[0].attackTimer).toBeUndefined();
      expect(snapshot(engine).visuals.pose).toBeUndefined();
    }

    // The regular capture starts sequence 10179 one tick after the final dose,
    // then 10176 five ticks after that (105–106–111, 211–212–217, 337–338–343).
    engine.applyAction(feed);
    advanceTo(engine, 6, frontTile);
    expect(engine.getState().npcs[0]).toMatchObject({
      npcTypeId: 12191,
      attackTimer: { nextAttackTick: 11, attackSpeed: 5 },
    });
    expect(engine.getState().inventory[0]).toEqual({ id: ARDER_MUSCA_POISON_ITEM_ID });
    expect(engine.acceptsEncounterInput(input)).toBe(false);
    expect(snapshot(engine).visuals.pose).toEqual({ clip: 'wake', startTick: 6 });
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'wake', tick: 6 }));
    expect(audioCues(engine)).not.toContainEqual(expect.objectContaining({ cue: 'feed' }));

    engine.applyAction({ type: 'attackTarget', targetId: WARDEN_ID });
    advanceTo(engine, 7, frontTile);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({ type: 'attack_started', weaponId: openingWeapon, tick: 7 }),
    );
    engine.setEquipment({ weapon: secondWeapon });
    engine.applyAction({ type: 'attackTarget', targetId: null });
    advanceTo(engine, 10, coverTile);
    expect(snapshot(engine).visuals.hazards).toHaveLength(0);
    advanceTo(engine, 11, coverTile);
    expect(snapshot(engine).visuals.pose).toEqual({ clip: 'slam', startTick: 11 });
    expect(engine.getState().npcs[0].attackTimer).toEqual({ nextAttackTick: 16, attackSpeed: 5 });
    expect(engine.getState().damageHistory).toContainEqual(expect.objectContaining({ source: 'Icicles', tick: 11 }));

    advanceTo(engine, 12, coverTile);
    engine.applyAction({ type: 'attackTarget', targetId: WARDEN_ID });
    advanceTo(engine, 13, coverTile);
    expect(engine.getState().playerPosition).toEqual(frontTile);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({ type: 'attack_started', weaponId: secondWeapon, tick: 13 }),
    );
    expect(received(engine, 'Slam')).toBe(false);
  });

  it('walks to Duke to feed and reports a missing poison stack', () => {
    const engine = createDukeRun();
    const inventory = createEmptyInventory();
    inventory[5] = { id: ARDER_MUSCA_POISON_ITEM_ID };
    engine.setInventory(inventory);
    const farTile: Coordinate = [31, 45];
    advanceTo(engine, 3, farTile);
    const feed = { type: 'npcInteraction', targetId: WARDEN_ID } as const;

    engine.applyAction(feed);
    advanceTo(engine, 4, farTile);
    expect(engine.getState().playerPosition).toEqual([31, 47]);
    expect(engine.getState().inventory[5]).toEqual({ id: ARDER_MUSCA_POISON_ITEM_ID });
    advanceTo(engine, 6, farTile);
    expect(engine.getState().playerPosition).toEqual([31, 51]);
    expect(engine.getState().inventory[5]).toEqual({ id: ARDER_MUSCA_POISON_ITEM_ID });
    expect(snapshot(engine).state.poisonToleranceFilled).toBe(125);
    expect(engine.getAttackTarget()).toBeNull();

    engine.setInventory(createEmptyInventory());
    engine.applyAction(feed);
    advanceTo(engine, 7, [31, 51]);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({
        type: 'game_message',
        segments: [{ text: 'You need Arder-musca poison to feed Duke.' }],
      }),
    );
    advanceTo(engine, 13, [31, 51]);
    expect(snapshot(engine).state.poisonToleranceFilled).toBe(125);
    expect(snapshot(engine).visuals.hazards).toHaveLength(0);
  });

  it.each([
    ['opening', 1697],
    ['vents', 1289],
    ['bile', 1103],
    ['orbs', 560],
    ['enrage', 440],
    ['stale', 1697],
  ])('opens the %s checkpoint at %d / 1697 HP', (phase, hp) => {
    expect(SLUG_TO_KIND.get('awakened-duke')).toBe(DUKE_KIND);
    const engine = createDukeRun(phase);
    expect(engine.getState().npcs[0]).toMatchObject({
      id: WARDEN_ID,
      hp,
      maxHp: WARDEN_MAX_HP,
      role: 'boss',
      npcTypeId: hp === WARDEN_MAX_HP ? DUKE_ASLEEP_NPC_ID : DUKE_NPC_ID,
    });
    expect(snapshot(engine).state.enraged).toBe(phase === 'enrage');
  });

  it('plays back a recording written before the rename and refuses its draft seed', () => {
    const engine = createDukeRun('enrage');
    engine.setMechanicsConfig({ [DUKE_START_PHASE_KEY]: 'enrage', [DUKE_ALWAYS_BILE_KEY]: true });
    const recorder = new ReplayRecorder();
    const runConfig = engine.getRunConfig();
    const opening = engine.getState();
    recorder.startRun(runConfig);
    recorder.recordFrame(0, START_TILE, opening, []);
    for (let tick = 1; tick <= 3; tick++) {
      engine.advanceTick(START_TILE);
      recorder.recordFrame(tick, START_TILE, engine.getState(), engine.getLastTickEvents());
    }

    const current = recorder.exportData();
    const { [DUKE_START_PHASE_KEY]: phase, [DUKE_ALWAYS_BILE_KEY]: alwaysBile, ...mechanics } = opening.mechanicsConfig;
    const legacyMechanics = { ...mechanics, dukePracticeStartPhase: phase, dukePracticeAlwaysBile: alwaysBile };
    const legacy = {
      ...current,
      runConfig: {
        ...runConfig,
        encounter: { kind: 'duke_practice', seeds: { encounterSeed: 71, awakePhaseStarts: true } },
        bootstrap: { ...runConfig.bootstrap, mechanicsConfig: legacyMechanics },
      },
      frames: current.frames.map((frame) => ({
        ...frame,
        state: {
          ...frame.state,
          encounter: { ...frame.state.encounter, kind: 'duke_practice' },
          mechanicsConfig: legacyMechanics,
        },
        events: frame.events.map((event) =>
          event.type === DUKE_AUDIO_EVENT ? { ...event, type: 'duke_practice_audio' } : event,
        ),
      })),
    };
    expect(legacy.frames.at(-1)?.events).toContainEqual(
      expect.objectContaining({ type: 'duke_practice_audio', cue: 'orbSpawn' }),
    );

    recorder.load(legacy as ReplayRecorderData);
    expect(recorder.exportData().frames).toEqual(current.frames);
    expect(legacy.frames[0].state.encounter.kind).toBe('duke_practice');
    const config = recorder.getRunConfig();
    if (!config) throw new Error('Missing Duke replay configuration');
    expect(config.encounter.kind).toBe('duke');
    expect(reconstructReplayPrefix(config, recorder.getReconstructionFrames(), 3, null)).toBeNull();
  });

  it('applies a checkpoint change before tick one and opens a clean retry', () => {
    const engine = createDukeRun();
    engine.setMechanicsConfig({ [DUKE_START_PHASE_KEY]: 'enrage' });
    expect(engine.getState().npcs[0].hp).toBe(440);
    advanceTo(engine, 3);
    expect(snapshot(engine).visuals.orbTile).not.toBeNull();
    engine.reset();
    expect(engine.getState().npcs[0].hp).toBe(440);
    expect(engine.getState().npcs[0].npcTypeId).toBe(DUKE_NPC_ID);
    expect(snapshot(engine).visuals).toEqual({ hazards: [], orbTile: null, usesVisualEvents: true });
  });

  it('jumps to each HP breakpoint in the current attempt', () => {
    const engine = createDukeRun();
    startAwakeDukeOpening(engine);
    advanceTo(engine, 6);
    for (const preset of DUKE_CONTROLS.bossHpPresets ?? []) {
      engine.applyAction({ type: 'applyBossHpPreset', hp: preset.hp });
      expect(engine.currentTick).toBe(6);
      expect(engine.getState().npcs[0]).toMatchObject({ hp: preset.hp, npcTypeId: DUKE_NPC_ID });
    }
    expect(snapshot(engine).state.enraged).toBe(true);
    expect(advanceThroughFlareLaunches(engine, 29)).toEqual([22, 25, 27, 29]);
  });

  it.each(
    DUKE_PHASE_VOLLEY_CAPTURES.flatMap((capture) => [
      { ...capture, entry: 'Start at' },
      { ...capture, entry: 'Jump to phase' },
    ]),
  )('opens $label on its captured volley rotation via $entry', (capture) => {
    const { phase, hp, label, entry, flareTicks, nextVolleyTick, bileTick } = capture;
    const engine = createDukeRun(entry === 'Start at' ? phase : 'opening', true, bileTick === null ? 28 : 71);
    if (entry === 'Jump to phase') {
      const preset = DUKE_CONTROLS.bossHpPresets?.find((preset) => preset.label === label);
      expect(preset?.hp).toBe(hp);
      engine.applyAction({ type: 'applyBossHpPreset', hp });
    }
    expect(engine.getState().npcs[0]).toMatchObject({ hp, npcTypeId: DUKE_NPC_ID });
    expect(engine.acceptsEncounterInput({ kind: 'npcInteraction', targetId: WARDEN_ID })).toBe(false);

    advanceTo(engine, 2);
    expect(snapshot(engine).visuals.orbTile).toBeNull();
    advanceTo(engine, 3);
    expect(snapshot(engine).visuals.orbTile !== null).toBe(phase === 'orbs');
    advanceTo(engine, 4);
    expect(snapshot(engine).visuals.pose).toBeUndefined();

    const relativeTick = (tick: number) => tick - flareTicks[0] + 5;
    expect(advanceThroughFlareLaunches(engine, relativeTick(flareTicks[3]))).toEqual(flareTicks.map(relativeTick));
    advanceTo(engine, relativeTick(flareTicks[3]) + 4);
    if (bileTick !== null) {
      expect(snapshot(engine).visuals.pose).toEqual({ clip: 'bile', startTick: relativeTick(bileTick) });
    } else {
      expect(snapshot(engine).state.bileTicksRemaining).toBe(0);
    }
    expect(advanceThroughFlareLaunches(engine, relativeTick(nextVolleyTick))).toEqual([relativeTick(nextVolleyTick)]);
  });

  it('jumps from sleeping Duke into the four-tick enrage rotation without an opener', () => {
    const engine = createDukeRun();
    const preset = DUKE_CONTROLS.bossHpPresets?.find(({ label }) => label === 'Enrage');
    expect(preset?.hp).toBe(440);
    const inventory = createEmptyInventory();
    inventory[0] = { id: ARDER_MUSCA_POISON_ITEM_ID };
    engine.setInventory(inventory);
    engine.applyAction({ type: 'applyBossHpPreset', hp: preset!.hp });
    expect(engine.getState().npcs[0]).toMatchObject({ hp: 440, npcTypeId: DUKE_NPC_ID });
    expect(engine.acceptsEncounterInput({ kind: 'npcInteraction', targetId: WARDEN_ID })).toBe(false);

    const { basicTicks, flareTicks } = DUKE_ENRAGE_VOLLEY_CAPTURE;
    const cadence = basicTicks[1] - basicTicks[0];
    const relativeTick = (tick: number) => tick - basicTicks[0] + cadence;
    const cover: Coordinate = [27, 51];
    advanceTo(engine, 1, cover);
    expect(engine.getLastTickEvents()).not.toContainEqual(
      expect.objectContaining({ segments: [{ text: 'Feed Duke three Arder-musca poisons to wake him.' }] }),
    );
    advanceTo(engine, cadence - 1, cover);
    expect(snapshot(engine).visuals.pose).toBeUndefined();
    expect(snapshot(engine).visuals.orbTile).not.toBeNull();
    for (const recordedTick of basicTicks) {
      const tick = relativeTick(recordedTick);
      advanceTo(engine, tick, cover);
      expect(snapshot(engine).visuals.pose).toEqual({ clip: 'slam', startTick: tick });
    }
    expect(advanceThroughFlareLaunches(engine, relativeTick(flareTicks[3]))).toEqual(flareTicks.map(relativeTick));
    expect(engine.getState().inventory[0]).toEqual(inventory[0]);
  });

  it('replaces the queued enrage attack when jumping to Opening before the first windup', () => {
    const engine = createDukeRun();
    const cover: Coordinate = [27, 51];
    engine.applyAction({ type: 'applyBossHpPreset', hp: 440 });
    advanceTo(engine, 1, cover);
    engine.applyAction({ type: 'applyBossHpPreset', hp: 1697 });
    advanceTo(engine, 5, cover);
    expect(snapshot(engine).visuals).toEqual({ hazards: [], orbTile: null, usesVisualEvents: true });
    advanceTo(engine, 6, cover);
    expect(snapshot(engine).visuals.pose).toEqual({ clip: 'slam', startTick: 6 });
  });

  it.each([undefined, -1, 2.5, 0x100000000])('refuses replay takeover with invalid Duke seed %s', (dukeSeed) => {
    const engine = createDukeRun('enrage');
    const recorder = new ReplayRecorder();
    const config = engine.getRunConfig();
    recorder.startRun(config);
    recorder.recordFrame(0, START_TILE, engine.getState(), []);
    const invalid = { ...config, encounter: { kind: 'duke', seeds: dukeSeed === undefined ? {} : { dukeSeed } } };
    const frames = recorder.getReconstructionFrames();

    expect(reconstructReplayPrefix(config, frames, 0, null)).not.toBeNull();
    expect(reconstructReplayPrefix(invalid, frames, 0, null)).toBeNull();
  });

  it('clears the current volley and starts a single-flare cycle when jumping back to Opening', () => {
    const engine = startOpeningAtHp('orbs');
    startAwakeDukeOpening(engine);
    advanceTo(engine, 61);
    expect(snapshot(engine).visuals.hazards.filter(({ kind }) => kind === 'vent')).toHaveLength(4);
    expect(snapshot(engine).visuals.orbTile).not.toBeNull();

    engine.applyAction({ type: 'applyBossHpPreset', hp: 1697 });
    expect(snapshot(engine).visuals).toEqual({ hazards: [], orbTile: null, usesVisualEvents: true });
    expect(advanceThroughFlareLaunches(engine, 116)).toEqual([112]);
  });

  it.each([
    { hp: 1697, chipTicks: [6, 11, 16], slamTicks: [8, 13, 18] },
    { hp: 440, chipTicks: [6, 10, 14], slamTicks: [8, 12, 16] },
  ])('lands chip two ticks before each slam at $hp HP', ({ hp, chipTicks, slamTicks }) => {
    const engine = createDukeRun();
    engine.setBossHp(hp);
    startAwakeDukeOpening(engine);
    advanceTo(engine, slamTicks[2], [31, 51]);

    const history = engine.getState().damageHistory;
    expect(history.filter(({ source }) => source === 'Icicles').map(({ tick }) => tick)).toEqual(chipTicks);
    expect(history.filter(({ source }) => source === 'Slam').map(({ tick }) => tick)).toEqual(slamTicks);
  });

  it.each(DUKE_SLAM_REENTRIES)('matches the capture step-back and re-entry at tick $windupTick', ({
    beforeWindup,
    cover,
    reentry,
  }) => {
    const engine = createDukeRun('opening', false);
    startAwakeDukeOpening(engine);
    advanceTo(engine, 5, beforeWindup);
    advanceTo(engine, 6, cover);
    expect(engine.getState().playerPosition).toEqual(cover);
    expect(snapshot(engine).visuals.hazards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'spikes', impactTick: 6 }),
        expect.objectContaining({ kind: 'slam', impactTick: 8 }),
      ]),
    );
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'slamWindup', tick: 6 }));
    expect(engine.getState().damageHistory).toContainEqual(expect.objectContaining({ source: 'Icicles', tick: 6 }));

    advanceTo(engine, 7, cover);
    engine.applyAction({ type: 'attackTarget', targetId: WARDEN_ID });
    advanceTo(engine, 8, reentry);
    expect(engine.getState().playerPosition).toEqual(reentry);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({ type: 'attack_started', sourceId: 'player', targetId: WARDEN_ID, tick: 8 }),
    );
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'slam', tick: 8 }));
    advanceTo(engine, 9, reentry);
    expect(received(engine, 'Slam')).toBe(false);
    expect(snapshot(engine).state.perfectKillEligible).toBe(true);

    engine.setBossHp(0);
    advanceTo(engine, 11);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({ type: 'game_message', segments: [{ text: 'Perfect kill.' }] }),
    );
  });

  it.each([
    { prayer: null, roll: 0.999, base: 81, damage: 81 },
    { prayer: PrayerType.ProtectMelee, roll: 0.999, base: 81, damage: 60 },
    { prayer: null, roll: 0.25, base: 20, damage: 20 },
    { prayer: PrayerType.ProtectMagic, roll: 0.25, base: 20, damage: 20 },
    { prayer: PrayerType.ProtectMelee, roll: 0.25, base: 20, damage: 15 },
  ])('deals $damage slam damage for a base roll of $base with $prayer at impact', ({ prayer, roll, base, damage }) => {
    const engine = createDukeRun('opening', false);
    const front: Coordinate = [31, 51];
    startAwakeDukeOpening(engine);
    advanceTo(engine, 7, front);
    if (prayer) engine.queueProtectionPrayer(prayer);
    const random = mockCombatRolls(engine).mockReturnValue(roll);
    try {
      advanceTo(engine, 8, front);
    } finally {
      random.mockRestore();
    }
    expect(snapshot(engine).state.perfectKillEligible).toBe(false);
    advanceTo(engine, 10, START_TILE);
    expect(engine.getState().damageHistory.filter(({ source }) => source === 'Slam')).toEqual([
      expect.objectContaining({ tick: 8, baseDamage: base, effectiveDamage: damage, activePrayer: prayer }),
    ]);
  });

  it.each([
    { bait: [31, 51] as Coordinate, front: [32, 51] as Coordinate },
    { bait: [27, 51] as Coordinate, front: [28, 51] as Coordinate },
  ])('hits the front row at impact when baited from $bait', ({ bait, front }) => {
    const engine = createDukeRun('opening', false);
    startAwakeDukeOpening(engine);
    advanceTo(engine, 6, bait);
    advanceTo(engine, 7, front);
    expect(engine.getState().playerPosition).toEqual(front);
    advanceTo(engine, 8, front);
    expect(engine.getState().damageHistory).toContainEqual(expect.objectContaining({ source: 'Slam', tick: 8 }));
  });

  it.each(DUKE_BASIC_WINDUP_STEPS)('selects $clip before movement on capture tick $windupTick', ({
    phase,
    beforeMove,
    afterMove,
    clip,
  }) => {
    const engine = startOpeningAtHp(phase, false);
    startAwakeDukeOpening(engine);
    advanceTo(engine, 5, beforeMove);
    expect(engine.getState().playerPosition).toEqual(beforeMove);
    advanceTo(engine, 6, afterMove);
    expect(engine.getState().playerPosition).toEqual(afterMove);
    expect(snapshot(engine).visuals.pose).toEqual({ clip, startTick: 6 });
    expect(received(engine, 'Icicles')).toBe(clip === 'slam');

    advanceTo(engine, 9, afterMove);
    expect(received(engine, 'Slam')).toBe(false);
    expect(received(engine, 'Magic bolt')).toBe(false);
  });

  it.each([
    { prayer: null, accuracyRoll: 0, damageRoll: 0.999, expected: 16 },
    { prayer: PrayerType.ProtectMagic, accuracyRoll: 0, damageRoll: 0.8, expected: DUKE_UNPROTECTED_CHIP_CAPTURE },
    { prayer: PrayerType.ProtectMelee, accuracyRoll: 0, damageRoll: 0.8, expected: 6 },
    { prayer: PrayerType.ProtectMelee, accuracyRoll: 0, damageRoll: 0.999, expected: DUKE_PROTECTED_CHIP_CAPTURE },
    { prayer: PrayerType.ProtectMelee, accuracyRoll: 0.999, damageRoll: 0.999, expected: 0 },
  ])('rolls icicle accuracy and can deal $expected chip damage with $prayer', ({
    prayer,
    accuracyRoll,
    damageRoll,
    expected,
  }) => {
    const engine = createDukeRun('opening', false);
    startAwakeDukeOpening(engine);
    advanceTo(engine, 5, [31, 51]);
    if (prayer) engine.queueProtectionPrayer(prayer);
    const random = mockCombatRolls(engine).mockReturnValueOnce(accuracyRoll).mockReturnValueOnce(damageRoll);
    try {
      advanceTo(engine, 6, START_TILE);
      expect(engine.getState().damageHistory).toContainEqual(
        expect.objectContaining({ source: 'Icicles', tick: 6, effectiveDamage: expected }),
      );
      expect(snapshot(engine).state.perfectKillEligible).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  it.each<Coordinate>([
    [27, 51],
    [35, 51],
  ])('still triggers melee but only takes icicle chip behind the pillar at (%i, %i)', (x, y) => {
    const engine = createDukeRun('opening', false);
    const cover: Coordinate = [x, y];
    startAwakeDukeOpening(engine);
    advanceTo(engine, 6, cover);
    const slam = snapshot(engine).visuals.hazards.find(({ kind }) => kind === 'slam');
    expect(slam?.impactTick).toBe(8);
    expect(slam?.tiles).not.toContainEqual(cover);

    advanceTo(engine, 8, cover);
    expect(engine.getState().playerPosition).toEqual(cover);
    expect(received(engine, 'Icicles')).toBe(true);
    expect(received(engine, 'Slam')).toBe(false);
  });

  it.each([
    ...REGULAR_DUKE_LATE_STEPS.map((step) => ({ ...step, phase: 'opening' })),
    { ...DUKE_ENRAGED_LATE_STEP, phase: 'enrage' },
  ])('matches the $phase capture slam at tick $hitTick before a late step from $front to $step', ({
    phase,
    windupTick,
    hitTick,
    front,
    step,
  }) => {
    const engine = startOpeningAtHp(phase, false);
    startAwakeDukeOpening(engine);
    const simWindup = 6;
    const simHit = simWindup + hitTick - windupTick;
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    advanceTo(engine, simHit - 1, front);
    expect(engine.getState().playerPosition).toEqual(front);
    expect(received(engine, 'Slam')).toBe(false);

    const random = mockCombatRolls(engine).mockReturnValueOnce(0.5);
    try {
      advanceTo(engine, simHit, step);
      expect(engine.getState().playerPosition).toEqual(step);
      expect(engine.getState().damageHistory).toContainEqual(
        expect.objectContaining({ source: 'Slam', tick: simHit, activePrayer: PrayerType.ProtectMelee }),
      );
    } finally {
      random.mockRestore();
    }
  });

  it('uses the captured magic animation and arrival timing during enrage', () => {
    const { windupTick, nextWindupTick, arrivalCycle } = DUKE_ENRAGED_MAGIC_CAPTURE;
    const engine = startOpeningAtHp('enrage');
    startAwakeDukeOpening(engine);
    const simWindup = 6;
    const arrivalTick = simWindup + arrivalCycle / 30;
    const nextAttackTick = simWindup + nextWindupTick - windupTick;
    const outsideMelee: Coordinate = [31, 46];
    advanceTo(engine, simWindup, outsideMelee);
    expect(snapshot(engine).visuals.pose).toEqual({ clip: 'magic', startTick: simWindup });
    expect(snapshot(engine).visuals.hazards).toContainEqual(
      expect.objectContaining({ kind: 'magic', windupTick: simWindup, impactTick: arrivalTick }),
    );
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'magicLaunch', tick: simWindup }));
    advanceTo(engine, arrivalTick - 1, outsideMelee);
    expect(received(engine, 'Magic bolt')).toBe(false);

    const random = mockCombatRolls(engine).mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    try {
      advanceTo(engine, arrivalTick, outsideMelee);
      expect(engine.getState().damageHistory).toContainEqual(
        expect.objectContaining({ source: 'Magic bolt', tick: arrivalTick }),
      );
      expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'magic', tick: arrivalTick }));
      expect(snapshot(engine).visuals.pose).toEqual({ clip: 'magic', startTick: nextAttackTick });
    } finally {
      random.mockRestore();
    }
  });

  it('lands the enraged bolt on a player who returned to melee range as Duke starts his next attack', () => {
    const { windupTick, nextWindupTick, castFrom, followUpFrom } = DUKE_ENRAGED_MAGIC_TO_MELEE_CAPTURE;
    const engine = startOpeningAtHp('enrage');
    startAwakeDukeOpening(engine);
    const simWindup = 6;
    const simFollowUp = simWindup + nextWindupTick - windupTick;
    advanceTo(engine, simWindup, castFrom);
    expect(snapshot(engine).visuals.pose).toEqual({ clip: 'magic', startTick: simWindup });
    advanceTo(engine, simFollowUp - 1, followUpFrom);
    expect(received(engine, 'Magic bolt')).toBe(false);

    const random = mockCombatRolls(engine).mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    try {
      advanceTo(engine, simFollowUp, followUpFrom);
      expect(engine.getState().damageHistory).toContainEqual(
        expect.objectContaining({ source: 'Magic bolt', tick: simFollowUp, targetId: 'player' }),
      );
      expect(snapshot(engine).visuals.pose).toEqual({ clip: 'slam', startTick: simFollowUp });
      expect(audioCues(engine).map((event) => ('cue' in event ? event.cue : null))).toEqual(['magic', 'slamWindup']);
    } finally {
      random.mockRestore();
    }
  });

  it.each([
    { prayer: null, roll: 0.999, expected: 71 },
    { prayer: PrayerType.ProtectMagic, roll: 0.999, expected: 36 },
    { prayer: PrayerType.ProtectMagic, roll: 0, expected: 0 },
  ])('resolves the bolt on impact with $prayer active and $expected damage', ({ prayer, roll, expected }) => {
    const engine = createDukeRun('opening', false);
    startAwakeDukeOpening(engine);
    const hpBefore = engine.getState().stats.hitpoints.current;
    advanceTo(engine, 6, START_TILE);
    expect(snapshot(engine).visuals.hazards).toEqual([
      { kind: 'magic', tiles: [START_TILE], windupTick: 6, impactTick: 10, expiresTick: 11 },
    ]);
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'magicLaunch' }));
    const meleeTile: Coordinate = [31, 51];
    advanceTo(engine, 9, meleeTile);
    expect(engine.getState().stats.hitpoints.current).toBe(hpBefore);
    expect(received(engine, 'Magic bolt')).toBe(false);
    expect(snapshot(engine).state.perfectKillEligible).toBe(true);
    if (prayer) engine.queueProtectionPrayer(prayer);

    const random = mockCombatRolls(engine).mockReturnValueOnce(0).mockReturnValueOnce(roll);
    try {
      advanceTo(engine, 10, START_TILE);
      expect(engine.getState().stats.hitpoints.current).toBe(hpBefore - expected);
      expect(engine.getState().damageHistory).toContainEqual(
        expect.objectContaining({ source: 'Magic bolt', tick: 10, targetId: 'player', effectiveDamage: expected }),
      );
      expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'magic', tick: 10 }));
      expect(snapshot(engine).visuals.hazards).toContainEqual(
        expect.objectContaining({ kind: 'magic', tiles: [meleeTile] }),
      );
      expect(snapshot(engine).state.perfectKillEligible).toBe(false);
      engine.setBossHp(0);
      advanceTo(engine, 12);
      expect(engine.getState().encounterOutcome.phase).toBe('victory');
      expect(engine.getLastTickEvents()).not.toContainEqual(
        expect.objectContaining({ type: 'game_message', segments: [{ text: 'Perfect kill.' }] }),
      );
      engine.reset();
      expect(snapshot(engine).state.perfectKillEligible).toBe(true);
    } finally {
      random.mockRestore();
    }
  });

  it('caps a bolt at the player’s HP before Elysian mitigation on the arrival tick', () => {
    const engine = createDukeRun('opening', false);
    engine.setEquipment({ shield: ELYSIAN_SPIRIT_SHIELD_ID });
    startAwakeDukeOpening(engine);
    advanceTo(engine, 9);
    engine['worldState'].getPlayer()!.vitals.hp = 20;
    // Accurate, maximum damage, Elysian proc.
    mockCombatRolls(engine).mockReturnValueOnce(0).mockReturnValueOnce(0.999).mockReturnValueOnce(0);
    advanceTo(engine, 10);
    expect(engine.getDamageHistory()).toContainEqual(
      expect.objectContaining({ source: 'Magic bolt', tick: 10, baseDamage: 71, effectiveDamage: 15 }),
    );
    expect(engine.getState().stats.hitpoints.current).toBe(5);
  });

  // Capture tick 128: block hitsplat without the 2435 spot or the 7197 sound.
  it('blocks an inaccurate bolt at arrival without spoiling a perfect kill', () => {
    const engine = createDukeRun();
    startAwakeDukeOpening(engine);
    advanceTo(engine, 9);
    mockCombatRolls(engine).mockReturnValueOnce(0.999);
    advanceTo(engine, 10);
    expect(engine.getState().damageHistory).toContainEqual(
      expect.objectContaining({ source: 'Magic bolt', tick: 10, effectiveDamage: 0 }),
    );
    expect(audioCues(engine)).not.toContainEqual(expect.objectContaining({ cue: 'magic' }));
    expect(engine.getLastTickEvents()).not.toContainEqual(
      expect.objectContaining({
        type: 'encounter_visual',
        graphics: expect.arrayContaining([expect.objectContaining({ spotAnimId: 2435 })]),
      }),
    );
    expect(snapshot(engine).visuals.hazards).toContainEqual(expect.objectContaining({ kind: 'magic', missed: true }));
    expect(snapshot(engine).state.perfectKillEligible).toBe(true);
  });

  it('uses magic behind a rear pillar outside melee range', () => {
    const engine = createDukeRun();
    startAwakeDukeOpening(engine);
    advanceTo(engine, 6, [27, 47]);
    expect(engine.getState().playerPosition).toEqual([27, 47]);
    expect(snapshot(engine).visuals.pose).toEqual({ clip: 'magic', startTick: 6 });
  });

  it('leaves two tiles between vents across each row and three between each pair of pillars', () => {
    const engine = createDukeRun();
    const { bounds, walkableTiles } = getArenaConfig();
    expect(bounds).toMatchObject({ width: 11, height: 20 });
    expect(engine.getState().npcs[0].size).toBe(7);
    for (const y of [42, 46, 50]) {
      expect(VENTS.filter(([, ventY]) => ventY === y).map(([x]) => x)).toEqual([28, 31, 34]);
    }
    for (const x of [27, 35]) {
      expect([48, 49, 50, 51, 52].map((y) => walkableTiles?.has(`${x},${y}`))).toEqual([
        false,
        true,
        true,
        true,
        false,
      ]);
    }
  });

  it.each<Coordinate>([
    [27, 51],
    [35, 51],
    [27, 47],
    [35, 47],
  ])('gives four ticks of gaze warning and protects the tile (%i, %i) behind a pillar', (x, y) => {
    const engine = createDukeRun();
    expect(getArenaConfig().walkableTiles?.has(`${x},${y + 1}`)).toBe(false);
    startAwakeDukeOpening(engine);
    advanceTo(engine, 31);
    expect(snapshot(engine).visuals.hazards.find((hazard) => hazard.kind === 'gaze')?.impactTick).toBe(36);
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'gazeWindup', tick: 31 }));
    advanceTo(engine, 35, [x, y]);
    expect(engine.getState().playerPosition).toEqual([x, y]);
    expect(received(engine, 'Freezing Gaze')).toBe(false);
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'gaze', tick: 35 }));
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({
        type: 'game_message',
        segments: [{ text: "You manage to avoid Duke Sucellus' gaze." }],
      }),
    );
    advanceTo(engine, 36);
    expect(received(engine, 'Freezing Gaze')).toBe(false);
  });

  it('reports failed cover one tick before gaze damage even when the player moves into cover late', () => {
    const { windupTick, messageTick, hitTick, beforeCover, cover } = DUKE_FAILED_GAZE_CAPTURE;
    const engine = startOpeningAtHp('enrage');
    const simWindup = 26;
    const simCheck = simWindup + messageTick - windupTick;
    const simHit = simWindup + hitTick - windupTick;
    startAwakeDukeOpening(engine);
    advanceTo(engine, simCheck - 1, beforeCover);
    expect(engine.getState().playerPosition).toEqual(beforeCover);
    advanceTo(engine, simCheck, cover);
    expect(engine.getState().playerPosition).toEqual(cover);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({
        type: 'game_message',
        segments: [{ text: "You failed to avoid Duke Sucellus' gaze." }],
      }),
    );
    expect(received(engine, 'Freezing Gaze')).toBe(false);

    const random = mockCombatRolls(engine).mockReturnValue(0.999);
    try {
      advanceTo(engine, simHit, cover);
      expect(engine.getState().damageHistory).toContainEqual(
        expect.objectContaining({ source: 'Freezing Gaze', tick: simHit, effectiveDamage: 121 }),
      );
    } finally {
      random.mockRestore();
    }
  });

  it.each(DUKE_VENT_PULSE_CAPTURES)('matches the recorded $phase smoke pulses and expiry', ({
    phase,
    pulses,
    fade,
  }) => {
    const engine = createDukeRun();
    if (phase === 'enrage') engine.applyAction({ type: 'applyBossHpPreset', hp: ENRAGE_HP });
    else startAwakeDukeOpening(engine);
    const launch = phase === 'enrage' ? 16 : 52;
    advanceTo(engine, launch - 1);
    expect(snapshot(engine).visuals.hazards.some(({ kind }) => kind === 'vent')).toBe(false);
    advanceTo(engine, launch + 3);
    expect(snapshot(engine).visuals.hazards).toContainEqual(
      expect.objectContaining({ kind: 'vent', landingTick: launch + 3, expiresTick: launch + fade }),
    );
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'vent', tick: launch + 3 }));
    expect(received(engine, 'Gas flare')).toBe(false);
    advanceTo(engine, launch + fade);
    const hits = engine.getDamageHistory().filter(({ source }) => source === 'Gas flare');
    expect(hits.map(({ tick }) => tick - launch)).toEqual(pulses);
    expect(
      snapshot(engine).visuals.hazards.some(({ kind, windupTick }) => kind === 'vent' && windupTick === launch),
    ).toBe(false);
  });

  it.each([
    DUKE_VENT_DAMAGE_CAPTURE,
    DUKE_VENT_TIE_CAPTURE,
  ])('matches grate targets and damage for the enrage volley at capture tick $firstTick', (capture) => {
    const engine = createDukeRun('enrage');
    engine.applyAction({ type: 'applyBossHpPreset', hp: ENRAGE_HP });
    const simLaunch = 16;
    const offset = capture.firstTick - simLaunch;
    advanceTo(engine, simLaunch - 1, [...capture.beforeLaunch]);
    for (const tile of capture.moves) {
      engine.advanceTick(tile);
      expect(engine.getState().playerPosition, `true tile at capture tick ${engine.currentTick + offset}`).toEqual(
        tile,
      );
    }
    const launches = snapshot(engine)
      .visuals.hazards.filter(({ kind }) => kind === 'vent')
      .map(({ windupTick, tiles }) => ({ tick: windupTick! + offset, grate: tiles[4] }));
    expect(launches).toEqual(capture.launches);
    const hits = engine.getDamageHistory().filter(({ source }) => source === 'Gas flare');
    expect(hits.map(({ tick }) => tick + offset)).toEqual(capture.hits);
  });

  // Spit windups at 3:24–3:29: https://www.youtube.com/watch?v=h-Pqf0Y0td4&t=203s
  it.each([
    { phase: 'vents', expectedLaunches: [52, 55, 57, 59] },
    { phase: 'enrage', expectedLaunches: [44, 47, 49, 51] },
  ])('spaces the four flare launches by three, two, and two ticks in $phase', ({ phase, expectedLaunches }) => {
    const engine = startOpeningAtHp(phase);
    startAwakeDukeOpening(engine);
    expect(advanceThroughFlareLaunches(engine, expectedLaunches[3])).toEqual(expectedLaunches);
  });

  it.each([
    {
      phase: 'bile',
      lastFlareTick: 59,
      bileTick: 63,
      recovery: DUKE_BILE_RECOVERY_CAPTURE.nextBasicTick - DUKE_BILE_RECOVERY_CAPTURE.warningTick,
      flareImpacts: [56, 59, 61, 63],
    },
    {
      phase: 'enrage',
      lastFlareTick: 51,
      bileTick: 51 + DUKE_ENRAGED_BILE_CAPTURE.warningTick - DUKE_ENRAGED_BILE_CAPTURE.lastFlareTick,
      recovery: DUKE_ENRAGED_BILE_CAPTURE.nextBasicTick - DUKE_ENRAGED_BILE_CAPTURE.warningTick,
      flareImpacts: [48, 51, 53, 55],
    },
  ])('delays bile until tick $bileTick after the last flare in $phase', ({
    phase,
    lastFlareTick,
    bileTick,
    recovery,
    flareImpacts,
  }) => {
    const engine = startOpeningAtHp(phase);
    startAwakeDukeOpening(engine);
    advanceTo(engine, lastFlareTick);
    const flares = snapshot(engine).visuals.hazards.filter((hazard) => hazard.kind === 'vent');
    expect(flares.map(({ impactTick }) => impactTick)).toEqual(flareImpacts);
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'ventLaunch', tick: lastFlareTick }));
    for (let tick = lastFlareTick; tick < bileTick; tick++) {
      advanceTo(engine, tick);
      expect(audioCues(engine)).not.toContainEqual(expect.objectContaining({ cue: 'bile' }));
      expect(snapshot(engine).state.bileTicksRemaining).toBe(0);
    }
    advanceTo(engine, bileTick);
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'bile', tick: bileTick }));
    expect(snapshot(engine).visuals.pose).toEqual({ clip: 'bile', startTick: bileTick });
    expect(snapshot(engine).state.bileTicksRemaining).toBe(15);
    expect(snapshot(engine).visuals.hazards.some((hazard) => hazard.kind === 'bile')).toBe(false);
    advanceTo(engine, bileTick + 1, [31, 49]);
    expect(snapshot(engine).visuals.hazards).toContainEqual(
      expect.objectContaining({
        kind: 'bile',
        tiles: [START_TILE],
        impactTick: bileTick + 2,
      }),
    );
    const nextAttackTick = bileTick + recovery;
    for (let tick = bileTick + 2; tick < nextAttackTick; tick++) {
      advanceTo(engine, tick, [31, START_TILE[1] - (tick - bileTick)]);
    }
    expect(received(engine, 'Bile pool')).toBe(false);
    expect(snapshot(engine).visuals.pose).toEqual({ clip: 'bile', startTick: bileTick });
    advanceTo(engine, nextAttackTick, [31, 45]);
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'magicLaunch', tick: nextAttackTick }));
  });

  it.each(DUKE_BILE_MELEE_CAPTURES)('matches the recorded $phase bile and melee damage ticks', (capture) => {
    const enraged = capture.phase === 'enrage';
    const engine = createDukeRun('opening', true, 70); // The orb during the enrage window enters from the west.
    engine.setMechanicsConfig({ ...engine.getState().mechanicsConfig, [DUKE_ALWAYS_BILE_KEY]: true });
    engine.applyAction({ type: 'applyBossHpPreset', hp: enraged ? ENRAGE_HP : BILE_HP });

    const simFlare = enraged ? 16 : 5;
    const tickOffset = capture.firstFlareTick - simFlare;
    advanceTo(engine, simFlare - 1, [...capture.beforeFirstFlare]);
    const historyStart = engine.getDamageHistory().length;
    const roll = mockCombatRolls(engine).mockReturnValue(0.1);
    try {
      for (const tile of capture.moves) {
        engine.advanceTick(tile);
        const tick = engine.currentTick + tickOffset;
        expect(engine.getState().playerPosition, `true tile at capture tick ${tick}`).toEqual(tile);
        if (tick === capture.warningTick) {
          expect(snapshot(engine).visuals.pose).toEqual({ clip: 'bile', startTick: engine.currentTick });
        }
      }
    } finally {
      roll.mockRestore();
    }
    const hits = engine
      .getDamageHistory()
      .slice(historyStart)
      // The capture starts with poison left over from before this sequence.
      .filter(
        ({ targetId, source, effectiveDamage }) => targetId === 'player' && source !== 'Poison' && effectiveDamage > 0,
      )
      .map(({ source, tick }) => ({ source, tick: tick + tickOffset }));
    expect(hits).toEqual(capture.hits);
  });

  it.each([
    { phase: 'opening', expected: [56, 96] },
    { phase: 'bile', expected: [63, 105] },
  ])('forces bile after consecutive $phase volleys with Always Bile enabled', ({ phase, expected }) => {
    const engine = startOpeningAtHp(phase);
    startAwakeDukeOpening(engine);
    engine.setMechanicsConfig({ [DUKE_START_PHASE_KEY]: phase, infiniteHealth: true, [DUKE_ALWAYS_BILE_KEY]: true });
    const casts: number[] = [];
    for (let tick = 2; tick <= expected[1]; tick++) {
      advanceTo(engine, tick);
      if (audioCues(engine).some((event) => 'cue' in event && event.cue === 'bile')) casts.push(tick);
    }
    expect(casts).toEqual(expected);
  });

  it.each([
    { seed: 57, expected: [true, true, false] },
    { seed: 28, expected: [false, false, false, false, true] },
  ])('allows successive or skipped bile casts without Always Bile (seed $seed)', ({ seed, expected }) => {
    const engine = createDukeRun('enrage', true, seed);
    const volleyCasts: boolean[] = [];
    let launchCount = 0;
    let warningTick = 0;
    for (let tick = 1; tick <= 250 && volleyCasts.length < expected.length; tick++) {
      advanceTo(engine, tick);
      const cues = audioCues(engine);
      if (cues.some((event) => 'cue' in event && event.cue === 'ventLaunch')) {
        launchCount++;
        if (launchCount % 4 === 0) warningTick = tick + DUKE_CONSECUTIVE_BILE_DELAY;
      }
      if (tick === warningTick) volleyCasts.push(cues.some((event) => 'cue' in event && event.cue === 'bile'));
    }
    expect(volleyCasts).toEqual(expected);
  });

  it('cancels queued bile when jumping to a different phase after the last flare', () => {
    const engine = startOpeningAtHp('bile');
    startAwakeDukeOpening(engine);
    advanceTo(engine, 60);
    engine.applyAction({ type: 'applyBossHpPreset', hp: 1697 });
    advanceTo(engine, 63);
    expect(audioCues(engine)).not.toContainEqual(expect.objectContaining({ cue: 'bile' }));
    expect(snapshot(engine).state.bileTicksRemaining).toBe(0);
  });

  it('retargets subsequent flares south when the player retreats between shots', () => {
    const engine = startOpeningAtHp('vents');
    startAwakeDukeOpening(engine);
    advanceTo(engine, 52);
    const firstFlare = snapshot(engine).visuals.hazards.find(({ kind }) => kind === 'vent');
    expect(firstFlare?.tiles[4]).toEqual([31, 50]);
    const retreat: Coordinate = [31, 47];
    advanceTo(engine, 59, retreat);
    const flares = snapshot(engine).visuals.hazards.filter((hazard) => hazard.kind === 'vent');
    expect(flares.map(({ tiles }) => tiles[4])).toEqual([
      [31, 50],
      [31, 46],
      [31, 46],
      [28, 46],
    ]);
    expect(
      flares
        .slice(1)
        .flatMap(({ tiles }) => tiles)
        .every(([, y]) => y < ORB_LANE.y),
    ).toBe(true);
    // The second shot for the middle grate cancels the previous cloud's pulse.
    expect(audioCues(engine)).not.toContainEqual(expect.objectContaining({ cue: 'ventIdle', position: [31, 46] }));
    expect(received(engine, 'Gas flare')).toBe(false);
    advanceTo(engine, 61, retreat);
    expect(audioCues(engine)).toEqual([expect.objectContaining({ cue: 'ventIdle', position: [31, 46], tick: 61 })]);
    expect(received(engine, 'Gas flare')).toBe(true);
    advanceTo(engine, 62, retreat);
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'vent', position: [28, 46], tick: 62 }));
    advanceTo(engine, 63, retreat);
    expect(audioCues(engine)).toContainEqual(
      expect.objectContaining({ cue: 'ventIdle', position: [31, 46], tick: 63 }),
    );
  });

  // 20261126-232238-Duke.jsonl ticks 139–157: gaze, one basic, then the due grate volley.
  it('uses a due grate volley one basic after gaze below the bile breakpoint', () => {
    const engine = startOpeningAtHp('bile');
    startAwakeDukeOpening(engine);
    const gazeTick = 120;
    advanceTo(engine, gazeTick, [27, 51]);
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'gazeWindup' }));
    advanceTo(engine, gazeTick + 6, [27, 51]);
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'slamWindup' }));
    expect(advanceThroughFlareLaunches(engine, gazeTick + 18)).toEqual([131, 134, 136, 138]);
    const hazards = snapshot(engine).visuals.hazards;
    expect(hazards.filter(({ kind }) => kind === 'vent')).toHaveLength(4);
    expect(hazards).not.toContainEqual(expect.objectContaining({ kind: 'gasSpit' }));
  });

  // 20261126-232238-Duke.jsonl:6586 and :6606–6607. The next drip covers both run steps.
  it('drops the first bile pool at the endpoint of a run on the cast tick', () => {
    const capture = DUKE_BILE_CAST_RUN_CAPTURE;
    const engine = createDukeRun();
    engine.setMechanicsConfig({ ...engine.getState().mechanicsConfig, [DUKE_ALWAYS_BILE_KEY]: true });
    engine.applyAction({ type: 'applyBossHpPreset', hp: BILE_HP });
    const simCast = 16;
    const offset = capture.castTick - simCast;
    advanceTo(engine, simCast - 1, [...capture.beforeCast]);
    for (const tile of capture.moves) {
      engine.advanceTick(tile);
      expect(engine.getState().playerPosition).toEqual(tile);
      if (engine.currentTick === simCast)
        expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'bile' }));
    }
    const pools = snapshot(engine)
      .visuals.hazards.filter(({ kind }) => kind === 'bile')
      .map(({ impactTick, tiles }) => ({ tick: impactTick - 1 + offset, tile: tiles[0] }));
    expect(pools).toEqual(capture.pools);
    const hits = engine.getDamageHistory().filter(({ source }) => source === 'Bile pool');
    expect(hits.map(({ tick }) => tick + offset)).toEqual(capture.hits);
  });

  it('leaves pools on both running tiles and keeps the original nine-tick lifetime', () => {
    const engine = startOpeningAtHp('bile');
    const cover: Coordinate = [27, 51];
    const turn: Coordinate = [29, 51];
    startAwakeDukeOpening(engine);
    advanceTo(engine, 63, cover);
    advanceTo(engine, 64, turn);
    expect(engine.getState().playerPosition).toEqual(turn);
    const pools = () => snapshot(engine).visuals.hazards.filter(({ kind }) => kind === 'bile');
    expect(pools()).toEqual([expect.objectContaining({ tiles: [cover], expiresTick: 73 })]);
    advanceTo(engine, 65, turn);
    expect(pools()).toEqual([
      expect.objectContaining({ tiles: [cover], expiresTick: 73 }),
      expect.objectContaining({ tiles: [turn], expiresTick: 74 }),
      expect.objectContaining({ tiles: [[28, 51]], expiresTick: 74 }),
    ]);
    advanceTo(engine, 72, turn);
    expect(pools()).toContainEqual(expect.objectContaining({ tiles: [turn], expiresTick: 74 }));
    advanceTo(engine, 73, turn);
    expect(pools()).not.toContainEqual(expect.objectContaining({ tiles: [cover] }));
  });

  it('applies the captured bile poison severity while still damaging a player with poison immunity', () => {
    const cover: Coordinate = [27, 51];
    const bare = startOpeningAtHp('bile');
    startAwakeDukeOpening(bare);
    advanceTo(bare, 65, cover);
    expect(received(bare, 'Bile pool')).toBe(true);
    expect(bare.getState().poisonVarp).toBe(DUKE_BILE_POISON_VARP);

    const protectedPlayer = startOpeningAtHp('bile');
    startAwakeDukeOpening(protectedPlayer);
    const inventory = createEmptyInventory();
    inventory[0] = { id: 5952 }; // Antidote++(4)
    protectedPlayer.setInventory(inventory);
    protectedPlayer.applyAction({ type: 'itemAction', inventoryIndex: 0 });
    advanceTo(protectedPlayer, 65, cover);
    expect(received(protectedPlayer, 'Bile pool')).toBe(true);
    expect(protectedPlayer.getState().poisonVarp).toBeLessThan(0);
  });

  it('starts the orb delay on the threshold hit, including a player attack late in that tick', () => {
    const engine = createDukeRun();
    const front: Coordinate = [31, 51];
    startAwakeDukeOpening(engine);
    advanceTo(engine, 7, front);
    engine.setBossHp(ORB_HP + 1);
    engine.setAttackTarget(WARDEN_ID);
    const random = mockCombatRolls(engine).mockReturnValueOnce(0.5).mockReturnValueOnce(0).mockReturnValueOnce(0.95);
    try {
      advanceTo(engine, 8, front);
    } finally {
      random.mockRestore();
    }
    engine.setAttackTarget(null);
    advanceTo(engine, 9, front);
    expect(engine.getState().npcs[0].hp).toBeGreaterThanOrEqual(DUKE_ORB_ACTIVATION_CAPTURE.hpAfterHit);
    expect(engine.getState().npcs[0].hp).toBeLessThanOrEqual(ORB_HP);
    const simSpawn = 9 + DUKE_ORB_ACTIVATION_CAPTURE.spawnTick - DUKE_ORB_ACTIVATION_CAPTURE.thresholdTick;
    advanceTo(engine, simSpawn - 1);
    expect(snapshot(engine).visuals.orbTile).toBeNull();
    advanceTo(engine, simSpawn);
    expect(snapshot(engine).visuals.orbTile).toEqual([ORB_LANE.east, ORB_LANE.y]);
  });

  it.each([
    { roll: 0, expectedDamage: DUKE_ORB_DAMAGE_CAPTURE.min },
    { roll: 0.999, expectedDamage: DUKE_ORB_DAMAGE_CAPTURE.max },
  ])('hits for $expectedDamage and despawns the orb on the tick after contact', ({ roll, expectedDamage }) => {
    const { spawnTick, spawnTile, contactTick, contactTile, hitTick, nextSpawnTick, nextSpawnTile } =
      DUKE_ORB_CONTACT_CAPTURE;
    const engine = createDukeRun('orbs');
    const simSpawn = 3;
    const simHit = simSpawn + hitTick - spawnTick;
    const simNextSpawn = simSpawn + nextSpawnTick - spawnTick;
    advanceTo(engine, simSpawn, contactTile);
    expect(snapshot(engine).visuals.orbTile).toEqual(spawnTile);
    expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'orbSpawn', position: spawnTile }));
    advanceTo(engine, simSpawn + contactTick - spawnTick, contactTile);
    expect(snapshot(engine).visuals.orbTile).toEqual(contactTile);
    expect(received(engine, 'Orb of Darkness')).toBe(false);
    const random = mockCombatRolls(engine).mockReturnValue(roll);
    try {
      advanceTo(engine, simHit, START_TILE);
    } finally {
      random.mockRestore();
    }
    expect(snapshot(engine).visuals.orbTile).toBeNull();
    expect(snapshot(engine).visuals.orbBursts).toContainEqual({ tick: simHit, tile: contactTile });
    expect(audioCues(engine)).toContainEqual(
      expect.objectContaining({ cue: 'orbHit', tick: simHit, position: [33, 51] }),
    );
    expect(engine.getState().damageHistory).toContainEqual(
      expect.objectContaining({ source: 'Orb of Darkness', tick: simHit, baseDamage: expectedDamage }),
    );
    const { stats, prayerState } = engine.getState();
    for (const skill of RESTORABLE_STATS) expect(stats[skill].current).toBe(stats[skill].max - 8);
    expect(prayerState.points).toBe(prayerState.maxPoints - 8);
    advanceTo(engine, simNextSpawn - 1);
    expect(snapshot(engine).visuals.orbTile).toBeNull();
    advanceTo(engine, simNextSpawn);
    expect(snapshot(engine).visuals.orbTile).toEqual(nextSpawnTile);
  });

  it('can start and repeat from the west and restores those rolls from a saved seed', () => {
    const engine = createDukeRun('orbs', true, 19);
    const runConfig = engine.getRunConfig();
    expect(runConfig.encounter.seeds).toEqual({ dukeSeed: 19 });
    const { tile, repeatInterval } = DUKE_WEST_ORB_CAPTURE;
    const expectedTiles = [tile, tile, tile, [ORB_LANE.east, ORB_LANE.y]];

    for (let attempt = 0; attempt < 2; attempt++) {
      for (const [index, expectedTile] of expectedTiles.entries()) {
        const tick = 3 + index * repeatInterval;
        advanceTo(engine, tick);
        expect(snapshot(engine).visuals.orbTile).toEqual(expectedTile);
        expect(audioCues(engine)).toContainEqual(expect.objectContaining({ cue: 'orbSpawn', position: expectedTile }));
      }
      if (attempt === 0) engine.reset(undefined, runConfig);
    }
  });

  it('winds up again four ticks after a basic attack in enrage', () => {
    const engine = createDukeRun('enrage');
    advanceTo(engine, 4, [31, 51]);
    expect(snapshot(engine).visuals.hazards).toContainEqual(expect.objectContaining({ kind: 'slam', impactTick: 6 }));
    advanceTo(engine, 7, [31, 51]);
    expect(snapshot(engine).visuals.pose).toEqual({ clip: 'slam', startTick: 4 });
    advanceTo(engine, 8, [31, 51]);
    expect(snapshot(engine).visuals.pose).toEqual({ clip: 'slam', startTick: 8 });
  });

  it('allows standard attack targeting and clears encounter hazards on victory', () => {
    const engine = createDukeRun('enrage');
    engine.setEquipment({ weapon: 29589 });
    engine.setAttackTarget(WARDEN_ID);
    advanceTo(engine, 1);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({ type: 'attack_started', sourceId: 'player', targetId: WARDEN_ID, weaponId: 29589 }),
    );
    advanceTo(engine, 12);
    expect(snapshot(engine).visuals.hazards.length).toBeGreaterThan(0);
    engine.setBossHp(0);
    advanceTo(engine, 14);
    expect(engine.getState().encounterOutcome.phase).toBe('victory');
    expect(snapshot(engine).visuals).toEqual({ hazards: [], orbTile: null, usesVisualEvents: true });
  });
});
