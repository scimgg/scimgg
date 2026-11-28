import { afterEach, expect, it } from 'vitest';
import type { NpcActor } from '../../../core/actors/NpcActor';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import type { NpcDefinitionContext } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { WorldState } from '../../../core/WorldState';
import { getMonsterHp } from '../../../data/monsterData';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { findProjectCacheZip, loadColosseumWaveArena } from '../../../test/helpers/colosseumCollision';
import { REAL_CACHE_TEST_TIMEOUT_MS, skipWithoutRealCache } from '../../../test/helpers/real-cache';
import { createMinotaur, MINOTAUR_REMOVAL_DELAY_TICKS, minotaurDefinition } from '../minotaur';
import { MINOTAUR_CAPTURE_LIVES, type MinotaurCaptureLife } from './fixtures/minotaurCapture';

/**
 * Replays every captured minotaur life through the production definition: its HP and passive
 * regeneration against every headbar, and (with the cache's pillars) its movement and its
 * melee/heal decisions on every tick before its killing hit. Other NPCs stand where the capture
 * has them; their HP is the top of their start-of-tick headbar bucket.
 */

const registration = minotaurDefinition.register(undefined);
// Cache NpcType sizes (research lane, RuneLite gameval names): jaguar 2, colossi/manticore/minotaur 3.
const SIZES: Readonly<Record<number, number>> = { 12810: 2, 12812: 3, 12817: 3, 12818: 3, 12819: 3 };
// Simulator policy for the warband (warband.ts): they do not block other NPCs.
const NON_BLOCKING = new Set([12814, 12815, 12816]);
const HEADBAR_WIDTH = 29;

const originalArena = getArenaConfig();
const originalUnbounded = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(originalArena, originalUnbounded));

/** RuneLite `OpponentInfoOverlay`'s headbar: `1 + floor(29 * hp / max)`, 0 when dead. */
function fillOf(hp: number, maxHp: number): number {
  return hp > 0 ? 1 + Math.floor((HEADBAR_WIDTH * hp) / maxHp) : 0;
}

/** The highest HP a headbar fill admits, so a threshold is never met on a guess. */
function topOfFill(fill: number, maxHp: number): number {
  if (fill >= HEADBAR_WIDTH + 1) return maxHp;
  return Math.ceil((fill * maxHp) / HEADBAR_WIDTH) - 1;
}

function stubNpc(index: number, npcId: number): NpcActor {
  const maxHp = getMonsterHp(npcId);
  if (maxHp === undefined) throw new TypeError(`Missing monster data for ${npcId}`);
  const npc: NpcActor = {
    id: `npc_${index}`,
    kind: 'npc',
    npcTypeId: npcId,
    archetypeId: 'capture_stub',
    size: SIZES[npcId] ?? 1,
    alive: true,
    position: [0, 0],
    previousPosition: [0, 0],
    facing: 0,
    vitals: { hp: maxHp, maxHp },
    history: new Map(),
    ...(NON_BLOCKING.has(npcId) ? { blocksNpcMovement: false } : {}),
    combat: {
      attackSpeed: 5,
      attackRange: 1,
      attackStyle: 'melee',
      nextActionTick: 0,
      targetId: null,
      lastAttackTick: null,
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
    },
  };
  // Server index order stands in for the engine's processing order.
  (npc as { processingOrder?: number }).processingOrder = index;
  return npc;
}

type Action = 'melee' | 'heal';
const label = (life: MinotaurCaptureLife, tick: number) => `${life.capture}:${tick}`;

/** Building an engine installs its own arena, so take the player before setting the Colosseum's. */
function lobbyPlayer() {
  return new SimulationEngine({ encounter: new LobbyEncounter() })['worldState'].getPlayer()!;
}

function replay(life: MinotaurCaptureLife, player = lobbyPlayer()) {
  const minotaur = createMinotaur({ id: 'minotaur', position: life.frames[0]!.end, spawnTick: life.addTick });
  const stubs = new Map<number, NpcActor>();
  const result = {
    hp: { checked: 0, mismatches: [] as string[], overkill: [] as string[], closedAtZero: false },
    movement: { scored: 0, mismatches: [] as string[] },
    actions: { observed: [] as string[], predicted: [] as string[] },
  };
  let killed = false;
  for (const frame of life.frames) {
    const { tick } = frame;
    const world = new WorldState();
    world.tick = tick;
    world.actors.set(player.id, player);
    player.position = [...frame.player];
    world.actors.set(minotaur.id, minotaur);
    for (const [index, npcId, start, end, fill] of frame.others) {
      const stub = stubs.get(index) ?? stubNpc(index, npcId);
      stubs.set(index, stub);
      // NPCs earlier in processing order have already moved this tick.
      stub.position = [...(index < life.index ? end : start)];
      stub.vitals = { ...stub.vitals, hp: topOfFill(fill, stub.vitals.maxHp) };
      stub.alive = fill > 0;
      world.actors.set(stub.id, stub);
    }
    world.occupancy.reconcile(world.getNpcs());

    // Its hits land first in its turn, as the engine's do.
    const fills: number[] = [];
    for (const [type, value] of frame.hits) {
      const { hp, maxHp } = minotaur.vitals;
      if (type !== 6 && value > hp) result.hp.overkill.push(label(life, tick));
      minotaur.vitals = { ...minotaur.vitals, hp: type === 6 ? Math.min(maxHp, hp + value) : Math.max(0, hp - value) };
      fills.push(fillOf(minotaur.vitals.hp, maxHp));
    }
    if (minotaur.vitals.hp === 0) killed = true;

    const context = (): NpcDefinitionContext => ({
      tick,
      world,
      tickEvents: new TickEvents(),
      random: () => 0.5,
      spawnNpc: () => undefined,
      despawnNpc: () => undefined,
      logEvent: () => undefined,
    });
    if (!killed && tick > life.addTick) {
      minotaur.position = [...frame.start];
      minotaur.previousPosition = [...frame.start];
      const step = registration.move(minotaur, context())[0]?.path.at(-1) ?? frame.start;
      result.movement.scored++;
      if (step[0] !== frame.end[0] || step[1] !== frame.end[1])
        result.movement.mismatches.push(`${label(life, tick)} ${frame.start}->${frame.end} model ${step}`);
    }
    minotaur.position = [...frame.end];
    if (!killed) {
      const tickContext = context();
      const attacks = registration.tick(minotaur, tickContext).npcAttacks ?? [];
      const healed = tickContext.tickEvents
        .flush()
        .filter(isEncounterVisualEvent)
        .some((event) => event.animations.some((cue) => cue.clipId === 'heal'));
      const predicted: Action | null = attacks.length > 0 ? 'melee' : healed ? 'heal' : null;
      const observed: Action | null = frame.seqs.includes(10843) ? 'melee' : frame.seqs.includes(10844) ? 'heal' : null;
      if (predicted) result.actions.predicted.push(`${label(life, tick)} ${predicted}`);
      if (observed) result.actions.observed.push(`${label(life, tick)} ${observed}`);
    }
    result.hp.checked += frame.fills.length;
    if (fills.join() !== frame.fills.join())
      result.hp.mismatches.push(`${label(life, tick)} model ${fills} capture ${frame.fills}`);
  }
  result.hp.closedAtZero = minotaur.vitals.hp === 0;
  return result;
}

it('closes every captured minotaur life at exactly 0 HP with +5 every 20 ticks from its spawn', () => {
  const results = MINOTAUR_CAPTURE_LIVES.map((life) => ({ life: label(life, life.addTick), ...replay(life).hp }));
  expect(results.reduce((sum, result) => sum + result.checked, 0)).toBe(340);
  expect(results.map(({ checked: _, ...result }) => result)).toEqual(
    MINOTAUR_CAPTURE_LIVES.map((life) => ({
      life: label(life, life.addTick),
      mismatches: [],
      overkill: [],
      closedAtZero: true,
    })),
  );
});

it('removes every captured minotaur four ticks after its death sequence', () => {
  expect(MINOTAUR_CAPTURE_LIVES.map((life) => life.removalTick - life.deathSeqTick)).toEqual(
    MINOTAUR_CAPTURE_LIVES.map(() => MINOTAUR_REMOVAL_DELAY_TICKS),
  );
});

const cachePath = findProjectCacheZip();

it.skipIf(skipWithoutRealCache())(
  'reproduces every captured melee and heal, and no other, around the real pillars',
  async () => {
    const player = lobbyPlayer();
    setArenaConfig(await loadColosseumWaveArena(cachePath!));
    const results = MINOTAUR_CAPTURE_LIVES.map((life) => replay(life, player).actions);
    // C:2478 is the one heal. The negative witnesses C:2707 (javelin at 1-19/30 for 24 ready ticks),
    // C:2929 (manticore at 2-5/30) and A:2711 are out of center line of sight; A:4311 and A:3314 are
    // 9-10 tiles from it.
    expect(results.flatMap((result) => result.predicted)).toEqual(results.flatMap((result) => result.observed));
    expect(results.flatMap((result) => result.observed).filter((entry) => entry.endsWith('heal'))).toEqual([
      'C:2478 heal',
    ]);
    expect(results.flatMap((result) => result.observed)).toHaveLength(67);
  },
  REAL_CACHE_TEST_TIMEOUT_MS,
);

it.skipIf(skipWithoutRealCache())(
  'walks every captured minotaur step with the generic greedy combat step',
  async () => {
    const player = lobbyPlayer();
    setArenaConfig(await loadColosseumWaveArena(cachePath!));
    const results = MINOTAUR_CAPTURE_LIVES.map((life) => replay(life, player).movement);
    const tally = results.reduce(
      (sum, result) => ({
        scored: sum.scored + result.scored,
        mismatches: [...sum.mismatches, ...result.mismatches],
      }),
      { scored: 0, mismatches: [] as string[] },
    );
    expect(tally).toEqual({ scored: 937, mismatches: [] });
  },
  REAL_CACHE_TEST_TIMEOUT_MS,
);
