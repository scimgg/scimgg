import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyCombatSupplies } from '../../../../types/encounterLoadout';
import { createEmptyStats, type EquipmentStats } from '../../../../types/equipmentStats';
import { createDefaultSpecialAttack } from '../../../../types/playerState';
import type { NpcActor } from '../../../actors/NpcActor';
import type { PlayerActor } from '../../../actors/PlayerActor';
import { setArenaConfig } from '../../../constants';
import { TickEvents } from '../../../events/TickEvents';
import { isCoreEvent } from '../../../events/types';
import { recordNpcLethalTransition } from '../../../npcDeath';
import { WorldState } from '../../../WorldState';
import { CombatSystem } from '../../CombatSystem';
import { projectFirstPartyPlayerAttack } from '../firstPartyPlayerAttack';
import type { PlayerAutoAttackDeps } from '../PlayerAutoAttackSystem';
import { processPlayerAutoAttack } from '../PlayerAutoAttackSystem';

// Real category, range, timing and distance modules: this is the chinchompa's whole throw.
const CHINCHOMPA = 10033;
const RED_CHINCHOMPA = 10034;
const BLACK_CHINCHOMPA = 11959;
const TICK = 10;
const SHORT_FUSE = 0;
const STATS = {
  levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
  offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
  defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
} satisfies NonNullable<NpcActor['formulaStats']>;
/** The black chinchompa's cache stats (+80 ranged attack, +30 ranged strength, 4 ticks, 9 tiles). */
const BLACK_CHINCHOMPA_STATS: EquipmentStats = {
  ...createEmptyStats(),
  attackRanged: 80,
  rangedStrength: 30,
  attackSpeed: 4,
  attackRange: 9,
};

afterEach(() => setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true));

function npc(id: string, position: [number, number], overrides: Partial<NpcActor> = {}): NpcActor {
  return {
    id,
    kind: 'npc',
    alive: true,
    position,
    previousPosition: position,
    facing: 0,
    size: 1,
    vitals: { hp: 1000, maxHp: 1000 },
    combat: { attackSpeed: 4, attackStyle: 'melee', attackRange: 1, nextActionTick: 0, targetId: null, animations: {} },
    npcTypeId: 1,
    formulaStats: STATS,
    ...overrides,
  } as NpcActor;
}

function thrower(weaponId: number, position: [number, number]): PlayerActor {
  return {
    id: 'player',
    kind: 'player',
    alive: true,
    position,
    previousPosition: position,
    facing: 0,
    size: 1,
    vitals: { hp: 99, maxHp: 99 },
    movementPath: [],
    isMoving: false,
    isRunning: false,
    history: new Map(),
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    prayerState: { points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} },
    stats: Object.fromEntries(
      ['attack', 'strength', 'defence', 'ranged', 'magic', 'prayer', 'hitpoints', 'agility'].map((skill) => [
        skill,
        { current: 99, max: 99 },
      ]),
    ),
    specialAttack: createDefaultSpecialAttack(),
    combatTimers: {
      saturatedHeartCooldownTicks: 0,
      markOfDarknessCooldownTicks: 0,
      markOfDarknessActiveTicks: 0,
      statBoostDecayTick: 100,
    },
    inventory: Array(28).fill(null),
    combatSupplies: createEmptyCombatSupplies(),
    isRunEnabled: true,
    isSpecialAttackActive: false,
    runEnergy: { energy: 10000 },
    ctrlClickOverride: false,
    equipment: { weapon: weaponId },
    equipmentStats: BLACK_CHINCHOMPA_STATS,
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    pendingInputOps: [],
    quickPrayersActive: false,
    activeEffects: [],
    attackTarget: 'primary',
    autoAttackPause: null,
    selectedAttackStyleIndex: SHORT_FUSE,
    pendingConflictionAttack: null,
    attackInteractionActive: true,
    xpCounters: {},
  } as unknown as PlayerActor;
}

/** Records every draw so a test can tell which rolls a throw made. */
function scripted(values: readonly number[], fallback = 0.5) {
  const queue = [...values];
  const draws: number[] = [];
  const random = () => {
    const value = queue.shift() ?? fallback;
    draws.push(value);
    return value;
  };
  return { random, draws };
}

function fixture(
  npcs: readonly NpcActor[],
  options: {
    readonly weaponId?: number;
    readonly position?: [number, number];
    readonly random?: () => number;
    readonly styleIndex?: number;
  } = {},
) {
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  const player = thrower(options.weaponId ?? BLACK_CHINCHOMPA, options.position ?? [10, 5]);
  player.selectedAttackStyleIndex = options.styleIndex ?? SHORT_FUSE;
  const world = new WorldState();
  world.tick = TICK;
  world.actors.set(player.id, player);
  for (const actor of npcs) world.actors.set(actor.id, actor);
  const deps: PlayerAutoAttackDeps = {
    world,
    tickEvents: new TickEvents(),
    combatSystem: new CombatSystem(),
    infiniteHealth: true,
    onDamageApplied: () => {},
    // No ammunition anywhere: chinchompas throw themselves, and nothing is ever spent.
    combatSupplies: createEmptyCombatSupplies(),
    lookupItemStats: () => null,
    random: options.random ?? (() => 0),
  };
  deps.tickEvents.setTick(TICK);
  const fire = () => {
    processPlayerAutoAttack(player, deps);
    return deps.tickEvents.flush();
  };
  /** Each target's launched hit, in the order the throw committed them. */
  const hits = () =>
    world.pendingHits.map((hit) => ({
      targetId: hit.targetId,
      delay: hit.impactTick - TICK,
      accurate: hit.accuracySucceeded,
      damage: hit.rolledDamage,
    }));
  return { player, world, deps, fire, hits };
}

/** The throw's max hit and accuracy against `target` at `targetDistance`, as the DPS projection plans it. */
function projected(player: PlayerActor, target: NpcActor, targetDistance: number) {
  const summary = projectFirstPartyPlayerAttack({
    player,
    target,
    formulaStyle: 'ranged',
    resources: { kind: 'none', source: 'none' },
    attackSpeedTicks: 4,
    delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
    application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
    manualCast: false,
    isSpecialAttack: false,
    standardAccuracyMode: 'single_roll',
    lookupItemStats: () => null,
    targetDistance,
  });
  if (summary === null) throw new Error('Expected a planned throw');
  return summary;
}

/** `count` NPCs stacked on the primary's tile, in spawn order. */
function crowd(count: number, position: [number, number]): NpcActor[] {
  return Array.from({ length: count }, (_, index) => npc(`secondary-${index}`, position));
}

describe('chinchompa throw', () => {
  it('throws without ammunition and lands 2 ticks out at 4 tiles, as captured', () => {
    const { fire, hits } = fixture([npc('primary', [10, 9])]);

    const events = fire();

    expect(events.find((event) => isCoreEvent(event, 'attack_started'))).toMatchObject({
      targetId: 'primary',
      weaponId: BLACK_CHINCHOMPA,
      style: 'range',
      impactDelayTicks: 2,
    });
    expect(hits()).toMatchObject([{ targetId: 'primary', delay: 2 }]);
  });

  it('lands every target of a 9-tile throw 3 ticks out, the primary and its neighbors alike', () => {
    const { fire, hits } = fixture([npc('primary', [10, 14]), npc('beside', [11, 15])]);

    fire();

    expect(hits().map(({ targetId, delay }) => ({ targetId, delay }))).toEqual([
      { targetId: 'primary', delay: 3 },
      { targetId: 'beside', delay: 3 },
    ]);
  });

  it('explodes over the 3x3 around the primary true tile only', () => {
    const { fire, hits } = fixture([
      npc('primary', [10, 9]),
      npc('corner', [11, 10]),
      npc('edge', [9, 9]),
      npc('two-out', [12, 9]),
      npc('dead', [10, 10], { alive: false }),
    ]);

    fire();

    expect(hits().map(({ targetId }) => targetId)).toEqual(['primary', 'corner', 'edge']);
  });

  it('leaves a neighbor on its kill tick out of the explosion, unlike a Barrage', () => {
    const killed = npc('killed', [10, 10], { deathPolicy: 'queued', vitals: { hp: 0, maxHp: 1000 } });
    recordNpcLethalTransition(killed, TICK, 'hit-queue');
    const { fire, hits } = fixture([npc('primary', [10, 9]), killed]);

    fire();

    expect(killed.death?.status).toBe('pending');
    expect(hits().map(({ targetId }) => targetId)).toEqual(['primary']);
  });

  it.each([
    { name: 'Chinchompa', weaponId: CHINCHOMPA, targets: 11 },
    { name: 'Red chinchompa', weaponId: RED_CHINCHOMPA, targets: 11 },
    { name: 'Black chinchompa', weaponId: BLACK_CHINCHOMPA, targets: 12 },
  ])('$name hits at most $targets targets, the primary included', ({ weaponId, targets }) => {
    const { fire, hits } = fixture([npc('primary', [10, 9]), ...crowd(15, [10, 9])], { weaponId });

    fire();

    expect(hits()).toHaveLength(targets);
    expect(hits()[0]?.targetId).toBe('primary');
  });

  it('hits only the primary where the encounter models single combat', () => {
    const { deps, fire, hits } = fixture([npc('primary', [10, 9]), ...crowd(3, [10, 9])]);
    deps.encounterRules = { multiCombat: false };

    fire();

    expect(hits().map(({ targetId }) => targetId)).toEqual(['primary']);
  });

  it('misses every target when the primary misses, without rolling the others', () => {
    // A secondary that the encounter says is never missed still follows the primary's roll.
    const sure = { formulaStats: { ...STATS, alwaysAccuratePlayerHit: true } };
    const { random, draws } = scripted([0.999]);
    const { fire, hits } = fixture([npc('primary', [10, 9]), npc('a', [10, 9], sure), npc('b', [11, 10])], {
      random,
    });

    fire();

    expect(hits().map(({ accurate, damage }) => ({ accurate, damage }))).toEqual([
      { accurate: false, damage: 0 },
      { accurate: false, damage: 0 },
      { accurate: false, damage: 0 },
    ]);
    expect(draws).toEqual([0.999]);
  });

  it('hits every target when the primary hits, each rolling its own damage up to the primary max hit', () => {
    // Out-defended secondaries are still hit: only the primary's accuracy is rolled.
    const armoured = {
      formulaStats: {
        ...STATS,
        levels: { ...STATS.levels, defence: 999 },
        defensive: { ...STATS.defensive, rangedHeavy: 999 },
      },
    };
    const { random, draws } = scripted([0, 0.999, 0.999, 0.5]);
    const primary = npc('primary', [10, 9]);
    const { player, fire, hits } = fixture([primary, npc('a', [10, 9], armoured), npc('b', [9, 8], armoured)], {
      random,
    });
    const { maxHit } = projected(player, primary, 4);

    fire();

    // One accuracy draw, then one damage draw per target.
    expect(draws).toEqual([0, 0.999, 0.999, 0.5]);
    expect(hits().map(({ targetId, accurate, damage }) => ({ targetId, accurate, damage }))).toEqual([
      { targetId: 'primary', accurate: true, damage: maxHit },
      { targetId: 'a', accurate: true, damage: maxHit },
      { targetId: 'b', accurate: true, damage: Math.floor(0.5 * (maxHit + 1)) },
    ]);
  });

  it('drops one XP total for the whole explosion', () => {
    const { random } = scripted([0, 0.999, 0.999, 0.999]);
    const { fire } = fixture([npc('primary', [10, 9]), npc('a', [10, 9]), npc('b', [11, 8])], { random });

    const xpDrops = fire().filter((event) => isCoreEvent(event, 'xp_drop'));

    expect(xpDrops).toHaveLength(1);
    const { maxHit } = projected(thrower(BLACK_CHINCHOMPA, [10, 5]), npc('probe', [10, 9]), 4);
    expect(xpDrops[0]).toMatchObject({ predictedHit: 3 * maxHit });
  });

  it("judges the fuse by the distance to a large target's nearest tile, not its south-west tile", () => {
    // A 3x3 target whose nearest tile is 3 away (Short fuse: 100%) and its south-west tile 5 (75%).
    const primary = npc('primary', [10, 8], { size: 3 });
    const player = thrower(BLACK_CHINCHOMPA, [10, 13]);
    const near = projected(player, primary, 3).accuracy;
    const southWest = projected(player, primary, 5).accuracy;
    expect(near).toBeGreaterThan(southWest);
    const between = (near + southWest) / 2;
    const { fire, hits } = fixture([primary], { position: [10, 13], random: scripted([between]).random });

    fire();

    expect(hits()).toMatchObject([{ targetId: 'primary', accurate: true }]);
  });
});
