import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmptyCombatSupplies } from '../../../../types/encounterLoadout';
import { createEmptyStats, type EquipmentStats } from '../../../../types/equipmentStats';
import { createDefaultSpecialAttack } from '../../../../types/playerState';
import type { NpcActor } from '../../../actors/NpcActor';
import type { PlayerActor } from '../../../actors/PlayerActor';
import { setArenaConfig } from '../../../constants';
import { TickEvents } from '../../../events/TickEvents';
import { isCoreEvent } from '../../../events/types';
import { WorldState } from '../../../WorldState';
import { CombatSystem, type DamageAppliedInfo } from '../../CombatSystem';
import { projectFirstPartyPlayerAttack } from '../firstPartyPlayerAttack';
import type { PlayerAutoAttackDeps } from '../PlayerAutoAttackSystem';
import { processPlayerAutoAttack } from '../PlayerAutoAttackSystem';

const VENATOR_BOW = 27610;
const DRAGON_ARROW = 11212;
const TICK = 10;
const STATS = {
  levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
  offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
  defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
} satisfies NonNullable<NpcActor['formulaStats']>;
const BOW_STATS: EquipmentStats = {
  ...createEmptyStats(),
  attackRanged: 90,
  rangedStrength: 25,
  attackSpeed: 5,
  attackRange: 6,
};
const ARROW_STATS: EquipmentStats = { ...createEmptyStats(), rangedStrength: 60 };

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

function player(): PlayerActor {
  return {
    id: 'player',
    kind: 'player',
    alive: true,
    position: [10, 9],
    previousPosition: [10, 9],
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
    equipment: { weapon: VENATOR_BOW },
    equipmentStats: BOW_STATS,
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    pendingInputOps: [],
    quickPrayersActive: false,
    activeEffects: [],
    attackTarget: 'primary',
    autoAttackPause: null,
    selectedAttackStyleIndex: 1, // Rapid
    pendingConflictionAttack: null,
    attackInteractionActive: true,
    xpCounters: {},
  } as unknown as PlayerActor;
}

function fixture(npcs: readonly NpcActor[], random: () => number = () => 0) {
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  const shooter = player();
  const world = new WorldState();
  world.tick = TICK;
  world.actors.set(shooter.id, shooter);
  for (const actor of npcs) world.actors.set(actor.id, actor);
  const landed: Array<{ tick: number; info: DamageAppliedInfo }> = [];
  const deps: PlayerAutoAttackDeps = {
    world,
    tickEvents: new TickEvents(),
    combatSystem: new CombatSystem(),
    infiniteHealth: true,
    onDamageApplied: (info) => landed.push({ tick: world.tick, info }),
    combatSupplies: { ...createEmptyCombatSupplies(), equippedAmmo: { id: DRAGON_ARROW } },
    lookupItemStats: (itemId) => (itemId === DRAGON_ARROW ? ARROW_STATS : null),
    random,
  };
  deps.tickEvents.setTick(TICK);
  const fire = () => {
    processPlayerAutoAttack(shooter, deps);
    return deps.tickEvents.flush().find((event) => isCoreEvent(event, 'attack_started'));
  };
  const land = (throughTick: number) => {
    for (let tick = TICK + 1; tick <= throughTick; tick++) {
      world.tick = tick;
      deps.combatSystem.processPendingHits(world, {
        events: deps.tickEvents,
        infiniteHealth: true,
        onDamageApplied: deps.onDamageApplied,
      });
    }
    return landed.map(({ tick, info }) => ({ tick: tick - TICK, targetId: info.targetId, damage: info.baseDamage }));
  };
  return { shooter, world, deps, fire, land };
}

describe('Venator bow ricochet', () => {
  it('chains two hops on the launch tick with the captured flight and hit timing', () => {
    // 1 tile away: primary endtime 48, hops 48->63 and 63->78, hits on T+2, T+2 and T+3. The second
    // hop takes `third`, the more recently spawned of it and the primary.
    const { fire, land } = fixture([npc('primary', [10, 10]), npc('second', [12, 10]), npc('third', [14, 10])]);

    const event = fire();

    expect(event).toMatchObject({
      targetId: 'primary',
      weaponId: VENATOR_BOW,
      ammoId: DRAGON_ARROW,
      impactDelayTicks: 2,
      ricochets: [
        {
          targetId: 'second',
          sourcePosition: [10, 10],
          targetPosition: [12, 10],
          targetSize: 1,
          startCycles: 48,
          endCycles: 63,
        },
        { targetId: 'third', sourcePosition: [12, 10], targetPosition: [14, 10], startCycles: 63, endCycles: 78 },
      ],
    });
    expect(land(TICK + 3).map(({ tick, targetId }) => ({ tick, targetId }))).toEqual([
      { tick: 2, targetId: 'primary' },
      { tick: 2, targetId: 'second' },
      { tick: 3, targetId: 'third' },
    ]);
  });

  it('may return to the primary target on the second hop, as its own later hit', () => {
    const { fire, land } = fixture([
      npc('third', [14, 10], { spawnTick: 1 }),
      npc('primary', [10, 10], { spawnTick: 2 }),
      npc('second', [12, 10], { spawnTick: 2 }),
    ]);

    expect(fire()).toMatchObject({ ricochets: [{ targetId: 'second' }, { targetId: 'primary' }] });
    expect(land(TICK + 3).map(({ tick, targetId }) => ({ tick, targetId }))).toEqual([
      { tick: 2, targetId: 'primary' },
      { tick: 2, targetId: 'second' },
      { tick: 3, targetId: 'primary' },
    ]);
  });

  it('caps each hop at two-thirds of the max hit, even on a target that always takes a max hit', () => {
    const weakness = { formulaStats: { ...STATS, alwaysMaximumPlayerHitStyles: ['range' as const] } };
    const { shooter, fire, land } = fixture([npc('primary', [10, 10], weakness), npc('second', [11, 10], weakness)]);
    const maximum = projectFirstPartyPlayerAttack({
      player: shooter,
      target: npc('probe', [10, 10], weakness),
      formulaStyle: 'ranged',
      resources: { kind: 'ammo', source: 'equipped', ammoId: DRAGON_ARROW },
      attackSpeedTicks: 4,
      delivery: { style: 'range', attackKind: 'range_arrow', impactDelayTicks: 2 },
      application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
      manualCast: false,
      isSpecialAttack: false,
      standardAccuracyMode: 'single_roll',
      lookupItemStats: () => ARROW_STATS,
    })?.maxHit;
    if (maximum === undefined) throw new Error('Expected a planned max hit');

    fire();

    expect(land(TICK + 3)).toEqual([
      { tick: 2, targetId: 'primary', damage: maximum },
      { tick: 2, targetId: 'second', damage: Math.floor((maximum * 2) / 3) },
      { tick: 3, targetId: 'primary', damage: Math.floor((maximum * 2) / 3) },
    ]);
  });

  it('leaves the encounter guaranteed max hit to the primary arrow alone', () => {
    const { deps, fire } = fixture([npc('primary', [10, 10]), npc('second', [11, 10])]);
    const consumePlayerGuaranteedMaxHit = vi.fn(() => true);
    deps.encounterRules = { consumePlayerGuaranteedMaxHit };

    expect(fire()?.ricochets).toHaveLength(2);
    expect(consumePlayerGuaranteedMaxHit).toHaveBeenCalledOnce();
  });

  it('does not return to a primary target its own arrow kills', () => {
    const { fire, land } = fixture([
      npc('primary', [10, 10], { vitals: { hp: 1, maxHp: 1 } }),
      npc('second', [11, 10]),
    ]);

    expect(fire()).toMatchObject({ ricochets: [{ targetId: 'second' }] });
    expect(land(TICK + 3).map(({ tick, targetId }) => ({ tick, targetId }))).toEqual([
      { tick: 2, targetId: 'primary' },
      { tick: 2, targetId: 'second' },
    ]);
  });

  it('never bounces to an NPC the encounter refuses to let the player attack', () => {
    const { deps, fire } = fixture([npc('primary', [10, 10]), npc('crystal', [11, 10]), npc('second', [10, 11])]);
    deps.encounterRules = { validateAttack: (_kind, targetId) => (targetId === 'crystal' ? false : null) };

    expect(fire()).toMatchObject({ ricochets: [{ targetId: 'second' }, { targetId: 'primary' }] });
  });

  it('never ricochets where the encounter models single combat', () => {
    const { deps, fire, land } = fixture([npc('primary', [10, 10]), npc('second', [11, 10])]);
    deps.encounterRules = { multiCombat: false };

    expect(fire()?.ricochets).toBeUndefined();
    expect(land(TICK + 3).map(({ targetId }) => targetId)).toEqual(['primary']);
  });

  it('skips targets more than two tiles out, dead, or without combat stats', () => {
    const { fire } = fixture([
      npc('primary', [10, 10], { size: 3 }),
      npc('far', [14, 10]),
      npc('dead', [9, 9], { alive: false }),
      npc('statless', [13, 13], { formulaStats: undefined }),
      npc('edge', [13, 12]),
    ]);

    // Reach counts from the 3x3's center tile (11, 11): `edge` is 2 tiles out, `far` 3. From `edge`,
    // `far` is in reach and spawned later than the primary.
    expect(fire()).toMatchObject({
      ricochets: [
        { targetId: 'edge', sourcePosition: [11, 11] },
        { targetId: 'far', sourcePosition: [13, 12] },
      ],
    });
  });

  it('fires a lone target as an ordinary bow shot', () => {
    const { fire } = fixture([npc('primary', [10, 10])]);

    const event = fire();

    expect(event).toMatchObject({ targetId: 'primary', impactDelayTicks: 2 });
    expect(event?.ricochets).toBeUndefined();
  });
});
