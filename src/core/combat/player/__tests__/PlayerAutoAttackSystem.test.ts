import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNE } from '../../../../data/spellRunes';
import { getDefaultLoadout } from '../../../../hooks/encounterLoadoutStorage';
import type { PlayerEquipment } from '../../../../rs/model/PlayerModelLoader';
import { enqueueTestPendingHit } from '../../../../test/helpers/pendingHits';
import type { AutocastSpellInfo } from '../../../../types/attackStyles';
import { createEmptyCombatSupplies } from '../../../../types/encounterLoadout';
import { createEmptyStats } from '../../../../types/equipmentStats';
import { createDefaultSpecialAttack } from '../../../../types/playerState';
import { type NpcActor, submergeNpc } from '../../../actors/NpcActor';
import type { PlayerActor } from '../../../actors/PlayerActor';
import type { DamageType } from '../../../actors/types';
import { TickEvents } from '../../../events/TickEvents';
import { type AttackKind, isCoreEvent } from '../../../events/types';
import { recordNpcLethalTransition, startNpcDeath } from '../../../npcDeath';
import { WorldState } from '../../../WorldState';
import { BURN_PERIOD_TICKS } from '../../burnStacks';
import { CombatSystem } from '../../CombatSystem';
import type { CombatFormulaStyle } from '../../formulas';
import type { EffectiveCombatParams } from '../../weaponCombatData';
import { AMULET_OF_BLOOD_FURY } from '../onHitPassives';
import type { PlayerAutoAttackDeps } from '../PlayerAutoAttackSystem';
import { processPlayerAutoAttack } from '../PlayerAutoAttackSystem';
import { facePlayerTowardNpc } from '../playerFacing';
import { resolveSpellHitEffects } from '../spellHitEffects';

const {
  mockGetPlayerEffectiveCombatParams,
  mockCalculateHitDelay,
  mockGetFormulaStyle,
  mockFormulaStyleToDamageType,
  mockFormulaStyleToAttackKind,
  mockIsInAttackRange,
  mockResolveActiveSpell,
  mockHitDelayFromEndTime,
} = vi.hoisted(() => ({
  mockGetPlayerEffectiveCombatParams: vi.fn(() => ({ attackSpeed: 4, attackRange: 1 })),
  mockCalculateHitDelay: vi.fn(() => 0),
  mockGetFormulaStyle: vi.fn<() => CombatFormulaStyle>(() => 'melee_slash'),
  mockFormulaStyleToDamageType: vi.fn<(style: CombatFormulaStyle) => DamageType>(() => 'melee'),
  mockFormulaStyleToAttackKind: vi.fn<(style: CombatFormulaStyle) => AttackKind>(() => 'melee_crush'),
  mockIsInAttackRange: vi.fn(() => true),
  mockResolveActiveSpell: vi.fn<() => AutocastSpellInfo | null>(() => null),
  mockHitDelayFromEndTime: vi.fn(() => 0),
}));

vi.mock('../../weaponCombatData', async (importOriginal) => ({
  getPoweredStaffBaseMaxHit: (await importOriginal<typeof import('../../weaponCombatData')>())
    .getPoweredStaffBaseMaxHit,
  getPlayerEffectiveCombatParams: mockGetPlayerEffectiveCombatParams,
  getHitDelayModel: () => 'melee',
  getProjectileTiming: () => null,
  getFormulaStyle: mockGetFormulaStyle,
  formulaStyleToDamageType: mockFormulaStyleToDamageType,
  formulaStyleToAttackKind: mockFormulaStyleToAttackKind,
  // `types/attackStyles` is stubbed below, so the real category lookup has nothing to read.
  getRangedDefenceType: () => 'standard',
}));

vi.mock('../../distance', () => ({
  isInAttackRange: mockIsInAttackRange,
  isUnderNpc: () => false,
  chebyshevDistanceToRect: () => 1,
}));

vi.mock('../../hitDelay', () => ({
  calculateHitDelay: mockCalculateHitDelay,
  calculateProjectileEndTime: () => 0,
  // Controllable because it is the ONLY delay a spell reads: `calculateHitDelay` never runs for a
  // magic cast, so a hard-coded 0 here would land every spell instantly and hide launch-vs-impact.
  hitDelayFromEndTime: mockHitDelayFromEndTime,
  PROJ_ANIM_TIMINGS: { magic_spell: { startTime: 51, speed: 5, slope: 15 } },
}));

vi.mock('../../../../types/attackStyles', () => ({
  getAutocastSpell: () => null,
  resolveActiveSpell: mockResolveActiveSpell,
  getWeaponCategory: () => ({
    name: '2h Sword',
    styles: [{ name: 'Chop', attackType: 'Slash', combatStyle: 'Accurate', icon: '' }],
  }),
}));

const AGS = 11802;
const DRAGON_DAGGER = 1215;
const DRAGON_WARHAMMER = 13576;
const SCYTHE_OF_VITUR = 22325;
const DUAL_MACUAHUITL = 28997;
const TOXIC_BLOWPIPE = 12926;
// Dragon longsword: an animation-only registry entry, so its special plans as unsupported.
const UNSUPPORTED_SPECIAL_WEAPON = 1305;
// /w/Accursed_sceptre#Special_attack: Condemn, a powered special that replaces the spell cast.
const ACCURSED_SCEPTRE = 27665;
const BURNING_CLAWS = 29577;
const FIRST_PARTY_TARGET_STATS = {
  levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
  offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
  defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
} satisfies NonNullable<NpcActor['formulaStats']>;
const NON_WEAPON_EQUIPMENT_SLOTS = [
  'head',
  'cape',
  'amulet',
  'body',
  'shield',
  'legs',
  'hands',
  'boots',
  'ring',
] as const satisfies readonly Exclude<keyof PlayerEquipment, 'weapon'>[];

beforeEach(() => {
  vi.clearAllMocks();
  mockCalculateHitDelay.mockReturnValue(0);
  mockHitDelayFromEndTime.mockReturnValue(0);
  mockGetFormulaStyle.mockReturnValue('melee_slash');
  mockFormulaStyleToDamageType.mockReturnValue('melee');
  mockFormulaStyleToAttackKind.mockReturnValue('melee_crush');
  mockResolveActiveSpell.mockReturnValue(null);
});

function makePlayer(_overrides: Partial<PlayerActor> = {}): PlayerActor {
  return {
    id: 'player',
    kind: 'player',
    alive: true,
    position: [31, 25],
    previousPosition: [31, 25],
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
    stats: {
      attack: { current: 99, max: 99 },
      strength: { current: 99, max: 99 },
      defence: { current: 99, max: 99 },
      ranged: { current: 99, max: 99 },
      magic: { current: 99, max: 99 },
      prayer: { current: 99, max: 99 },
      hitpoints: { current: 99, max: 99 },
      agility: { current: 99, max: 99 },
    },
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
    equipment: { weapon: AGS },
    equipmentStats: createEmptyStats(),
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    pendingInputOps: [],
    quickPrayersActive: false,
    activeEffects: [],
    attackTarget: 'yama',
    autoAttackPause: null,
    selectedAttackStyleIndex: 0,
    pendingConflictionAttack: null,
    attackInteractionActive: true,
    xpCounters: {},
  } as unknown as PlayerActor;
}

function makeNpc(overrides: Partial<NpcActor> = {}): NpcActor {
  return {
    id: 'yama',
    kind: 'npc',
    alive: true,
    position: [29, 28],
    previousPosition: [29, 28],
    facing: 0,
    size: 5,
    vitals: { hp: 1000, maxHp: 1000 },
    combat: {
      attackSpeed: 4,
      attackStyle: 'magic',
      attackRange: 10,
      nextActionTick: 0,
      targetId: 'player',
      animations: {},
    },
    npcTypeId: 1,
    formulaStats: FIRST_PARTY_TARGET_STATS,
    ...overrides,
  } as NpcActor;
}

function makeWorld(tick: number, npcOverrides: Partial<NpcActor> = {}): WorldState {
  const npc = makeNpc(npcOverrides);
  const player = makePlayer();
  const actors = new Map();
  actors.set('player', player);
  actors.set('yama', npc);

  return {
    tick,
    actors,
    pendingHits: [],
    nextHitSequence: 0,
    areaEffects: [],
    getPlayer: () => player,
    getNpcs: () => [npc],
    getNpc: (id: string) => (id === 'yama' ? npc : null),
  } as unknown as WorldState;
}

function makeMultiNpcWorld(tick: number, npcs: readonly NpcActor[]): WorldState {
  const player = makePlayer();
  player.attackTarget = npcs[0]?.id ?? null;
  const world = new WorldState();
  world.tick = tick;
  world.actors.set(player.id, player);
  for (const npc of npcs) world.actors.set(npc.id, npc);

  return world;
}

function getRequiredPlayer(world: WorldState): PlayerActor {
  const player = world.getPlayer();
  if (!player) {
    throw new Error('Expected test world to contain a player');
  }
  return player;
}

function makeDeps(world: WorldState, combatSystem: CombatSystem): PlayerAutoAttackDeps {
  let randomIndex = 0;
  return {
    world,
    tickEvents: new TickEvents(),
    combatSystem,
    infiniteHealth: true,
    onDamageApplied: vi.fn(),
    combatSupplies: createEmptyCombatSupplies(),
    lookupItemStats: () => createEmptyStats(),
    random: () => (randomIndex++ % 2 === 0 ? 0 : 0.999),
  };
}

/** The attack this tick emitted, if any. Drains the tick's event queue. */
function launchedAttack(deps: PlayerAutoAttackDeps) {
  return deps.tickEvents.flush().find((event) => isCoreEvent(event, 'attack_started'));
}

describe('processPlayerAutoAttack — first-party ordinary attack route', () => {
  it('pays the ruby bolt proc cost from current HP without allowing self-kill', () => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: 9185 };
    player.equipmentStats = { ...createEmptyStats(), attackRanged: 100, rangedStrength: 100 };
    mockGetFormulaStyle.mockReturnValue('ranged');
    mockFormulaStyleToDamageType.mockReturnValue('range');
    mockFormulaStyleToAttackKind.mockReturnValue('range_arrow');
    mockCalculateHitDelay.mockReturnValue(2);
    const deps = makeDeps(world, new CombatSystem());
    deps.combatSupplies = {
      ...deps.combatSupplies,
      equippedAmmo: { id: 9242 },
    };
    deps.random = () => 0;

    processPlayerAutoAttack(player, deps);

    expect(player.vitals.hp).toBe(99);
    const pendingHit = world.pendingHits[0];
    if (pendingHit === undefined) throw new Error('Expected a pending Ruby bolt hit');
    world.tick = pendingHit.impactTick;
    deps.combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    expect(player.vitals.hp).toBe(90);
    expect(player.stats.hitpoints.current).toBe(90);
    expect(deps.tickEvents.flush()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'hitsplat_spawned', targetId: player.id, amount: 9 })]),
    );
  });

  it('does not pay the ruby bolt proc cost when encounter rules force the hit to miss', () => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: 9185 };
    player.equipmentStats = { ...createEmptyStats(), attackRanged: 100, rangedStrength: 100 };
    mockGetFormulaStyle.mockReturnValue('ranged');
    mockFormulaStyleToDamageType.mockReturnValue('range');
    mockFormulaStyleToAttackKind.mockReturnValue('range_arrow');
    mockCalculateHitDelay.mockReturnValue(2);
    const deps = makeDeps(world, new CombatSystem());
    deps.combatSupplies = {
      ...deps.combatSupplies,
      equippedAmmo: { id: 9242 },
    };
    deps.encounterRules = { validateAttack: () => false };
    deps.random = () => 0;

    processPlayerAutoAttack(player, deps);

    const pendingHit = world.pendingHits[0];
    if (pendingHit === undefined) throw new Error('Expected a pending forced-miss bolt hit');
    world.tick = pendingHit.impactTick;
    deps.combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    expect(player.vitals.hp).toBe(99);
    expect(player.stats.hitpoints.current).toBe(99);
    expect(deps.tickEvents.flush()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'hitsplat_spawned', targetId: player.id })]),
    );
  });

  it('rolls Burst and Barrage damage independently for nearby true-tile targets', () => {
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30], size: 3 });
    const secondary = makeNpc({ id: 'secondary', position: [31, 30], previousPosition: [31, 30] });
    const secondaryLarge = makeNpc({
      id: 'secondary-large',
      position: [29, 29],
      previousPosition: [29, 29],
      size: 3,
    });
    const footprintOnly = makeNpc({
      id: 'footprint-only',
      position: [32, 30],
      previousPosition: [32, 30],
    });
    const world = makeMultiNpcWorld(10, [primary, secondary, secondaryLarge, footprintOnly]);
    const player = getRequiredPlayer(world);
    player.equipment.weapon = SCYTHE_OF_VITUR;
    player.manualCastSpell = 'Ice Barrage';
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
    const rolls = [0, 0, 0.999, 0, 0, 0];
    const random = vi.fn(() => rolls.shift() ?? 0);
    const deps = { ...makeDeps(world, new CombatSystem()), random };
    const consumePlayerGuaranteedMaxHit = vi.fn(() => false);
    deps.encounterRules = { consumePlayerGuaranteedMaxHit };
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: {
        kind: 'standard',
        slots: [{ id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.death }],
      },
    };
    const onDamageApplied = vi.fn();
    deps.onDamageApplied = onDamageApplied;
    deps.onPlayerAttackStarted = vi.fn();
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    const events = deps.tickEvents.flush();
    expect(onDamageApplied.mock.calls.map(([info]) => info.targetId)).toEqual([
      primary.id,
      secondary.id,
      secondaryLarge.id,
    ]);
    expect(onDamageApplied.mock.calls.map(([info]) => info.baseDamage)).toEqual([1, 0, 1]);
    expect(random).toHaveBeenCalledTimes(5);
    expect(consumePlayerGuaranteedMaxHit).toHaveBeenCalledOnce();
    expect(events.filter((event) => isCoreEvent(event, 'attack_started'))).toHaveLength(1);
    expect(events.filter((event) => event.type === 'spell_targeted')).toMatchObject([
      {
        sourceId: 'player',
        targetId: secondary.id,
        spellId: 'Ice Barrage',
        spellCast: { sourcePosition: [31, 25], targetPosition: [31, 30], targetSize: 5, accurate: false },
      },
      {
        sourceId: 'player',
        targetId: secondaryLarge.id,
        spellId: 'Ice Barrage',
        spellCast: { sourcePosition: [31, 25], targetPosition: [29, 29], targetSize: 3, accurate: true },
      },
    ]);
    expect(deps.combatSystem.getNextAttackTick(player.id)).toBe(15);
    expect(deps.onPlayerAttackStarted).toHaveBeenCalledOnce();
    const totalDamage = onDamageApplied.mock.calls.reduce((sum, [info]) => sum + info.baseDamage, 0);
    expect(events.find((event) => isCoreEvent(event, 'xp_drop'))).toMatchObject({ predictedHit: totalDamage });
    expect(player.manualCastSpell).toBeNull();
  });

  it('leaves a submerged NPC out of a Barrage until it surfaces', () => {
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30], size: 3 });
    const buried = makeNpc({ id: 'buried', position: [31, 30], previousPosition: [31, 30] });
    submergeNpc(buried, 11);
    const world = makeMultiNpcWorld(10, [primary, buried]);
    const player = getRequiredPlayer(world);
    player.equipment.weapon = SCYTHE_OF_VITUR;
    player.manualCastSpell = 'Ice Barrage';
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
    const deps = { ...makeDeps(world, new CombatSystem()), random: () => 0 };
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: { kind: 'standard', slots: [{ id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.death }] },
    };
    const onDamageApplied = vi.fn();
    deps.onDamageApplied = onDamageApplied;
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    expect(onDamageApplied.mock.calls.map(([info]) => info.targetId)).toEqual([primary.id]);
    expect(buried.blocksNpcMovement).toBeUndefined();
  });

  it.each([
    {
      label: 'manual Barrage special',
      manual: true,
      special: true,
      energy: 100,
      multiCombat: true,
      targets: 1,
      heals: 1,
    },
    {
      label: 'single-combat hybrid control',
      manual: true,
      special: true,
      energy: 100,
      multiCombat: false,
      targets: 1,
      heals: 1,
    },
    {
      label: 'normal SGS special',
      manual: false,
      special: true,
      energy: 100,
      multiCombat: true,
      targets: 1,
      heals: 1,
    },
    {
      label: 'ordinary manual Barrage',
      manual: true,
      special: false,
      energy: 100,
      multiCombat: true,
      targets: 2,
      heals: 0,
    },
    {
      label: 'Barrage with insufficient special energy',
      manual: true,
      special: true,
      energy: 0,
      multiCombat: true,
      targets: 2,
      heals: 0,
    },
  ])('applies only the selected attack at impact when using $label', (scenario) => {
    const { manual, special, energy, multiCombat, targets, heals } = scenario;
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30] });
    const secondary = makeNpc({ id: 'secondary', position: [31, 30], previousPosition: [31, 30] });
    const world = makeMultiNpcWorld(10, [primary, secondary]);
    const player = getRequiredPlayer(world);
    player.equipment.weapon = 11806;
    player.manualCastSpell = manual ? 'Ice Barrage' : null;
    player.isSpecialAttackActive = special;
    player.specialAttack.energy = energy;
    player.vitals.hp = 10;
    player.stats.hitpoints.current = 10;
    player.prayerState.points = 0;
    player.stats.prayer.current = 0;
    mockFormulaStyleToDamageType.mockImplementation((style) => (style === 'magic' ? 'magic' : 'melee'));
    mockFormulaStyleToAttackKind.mockImplementation((style) => (style === 'magic' ? 'magic_shadow' : 'melee_crush'));
    mockCalculateHitDelay.mockReturnValue(2);
    const random = vi.fn(() => 0);
    const deps = { ...makeDeps(world, new CombatSystem()), random };
    deps.encounterRules = { multiCombat };
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: {
        kind: 'standard',
        slots: [{ id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.death }],
      },
    };

    processPlayerAutoAttack(player, deps);
    world.tick = 20;
    deps.combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    expect({ hp: player.vitals.hp, prayer: player.prayerState.points }).toEqual({
      hp: 10 + 10 * heals,
      prayer: 5 * heals,
    });
    expect(player.stats.hitpoints.current).toBe(player.vitals.hp);
    expect(player.stats.prayer.current).toBe(player.prayerState.points);
    expect(primary.vitals.hp).toBe(999);
    expect(secondary.vitals.hp).toBe(targets === 2 ? 999 : 1000);
    expect(random).toHaveBeenCalledTimes(2 * targets);
    expect(player.specialAttack.energy).toBe(energy - 50 * heals);
    expect(deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'attack_started'))).toHaveLength(1);
  });

  it('preserves the magic drain at impact when an Eye of ayak special is selected', () => {
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30] });
    const secondary = makeNpc({ id: 'secondary', position: [31, 30], previousPosition: [31, 30] });
    const world = makeMultiNpcWorld(10, [primary, secondary]);
    const player = getRequiredPlayer(world);
    player.equipment.weapon = 31113;
    player.manualCastSpell = null;
    player.isSpecialAttackActive = true;
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
    mockCalculateHitDelay.mockReturnValue(2);
    const deps = { ...makeDeps(world, new CombatSystem()), random: () => 0 };
    deps.encounterRules = { multiCombat: true };

    processPlayerAutoAttack(player, deps);
    world.tick = 20;
    deps.combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    expect(primary.vitals.hp).toBe(999);
    expect(primary.debuffs?.magicDrain).toBe(1);
    expect(secondary.vitals.hp).toBe(1000);
    expect(secondary.debuffs?.magicDrain).toBeUndefined();
    expect(player.specialAttack.energy).toBe(50);
  });

  it('keeps ordinary castable spells single-target', () => {
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30] });
    const secondary = makeNpc({ id: 'secondary', position: [31, 30], previousPosition: [31, 30] });
    const world = makeMultiNpcWorld(10, [primary, secondary]);
    const player = getRequiredPlayer(world);
    player.manualCastSpell = 'Fire Strike';
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_fire');
    const deps = makeDeps(world, new CombatSystem());
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: {
        kind: 'standard',
        slots: [{ id: RUNE.fire }, { id: RUNE.air }, { id: RUNE.mind }],
      },
    };
    const onDamageApplied = vi.fn();
    deps.onDamageApplied = onDamageApplied;
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    expect(onDamageApplied).toHaveBeenCalledTimes(1);
    expect(onDamageApplied).toHaveBeenCalledWith(expect.objectContaining({ targetId: primary.id }));
  });

  it('fans out an autocast Burst or Barrage through the same target selection', () => {
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30] });
    const secondary = makeNpc({ id: 'secondary', position: [31, 30], previousPosition: [31, 30] });
    const world = makeMultiNpcWorld(10, [primary, secondary]);
    const player = getRequiredPlayer(world);
    mockResolveActiveSpell.mockReturnValue({
      name: 'Ice Barrage',
      spellbook: 'ancient',
      icon: 'ice_barrage',
      attackRange: 10,
    });
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
    const deps = makeDeps(world, new CombatSystem());
    deps.combatSupplies = {
      ...deps.combatSupplies,
      selectedSpell: 'Ice Barrage',
      spellbook: 'ancient',
      runePouch: {
        kind: 'standard',
        slots: [{ id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.death }],
      },
    };
    const onDamageApplied = vi.fn();
    deps.onDamageApplied = onDamageApplied;
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    expect(onDamageApplied.mock.calls.map(([info]) => info.targetId)).toEqual([primary.id, secondary.id]);
  });

  it('freezes every target an Ancient Barrage hits, from the tick after the cast', () => {
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30] });
    const secondary = makeNpc({ id: 'secondary', position: [31, 30], previousPosition: [31, 30] });
    const world = makeMultiNpcWorld(10, [primary, secondary]);
    const player = getRequiredPlayer(world);
    player.manualCastSpell = 'Ice Barrage';
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
    const deps = makeDeps(world, new CombatSystem());
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: {
        kind: 'standard',
        slots: [{ id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.death }],
      },
    };
    deps.random = () => 0;
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    // Each square of the Barrage freezes on its own, at launch: the NPCs already had their cast-tick
    // step, and the window opens on the next one (capture inferno-waves-1-68-packet-data.txt
    // t581 cast, targets still from t582, splats t586).
    for (const target of [primary, secondary]) {
      expect(target.debuffs, target.id).toMatchObject({ boundFromTick: 11, boundUntilTick: 43 });
    }
  });

  it.each([
    { label: 'sceptre equipped at launch', weapon: 28262, until: 46 },
    { label: 'no sceptre at launch', weapon: undefined, until: 43 },
  ])('commits the $label freeze duration to every target, ignoring a later swap', ({ weapon, until }) => {
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30] });
    const secondary = makeNpc({ id: 'secondary', position: [31, 30], previousPosition: [31, 30] });
    const world = makeMultiNpcWorld(10, [primary, secondary]);
    const player = getRequiredPlayer(world);
    player.manualCastSpell = 'Ice Barrage';
    if (weapon === undefined) delete player.equipment.weapon;
    else player.equipment.weapon = weapon;
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
    const deps = makeDeps(world, new CombatSystem());
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: {
        kind: 'standard',
        slots: [{ id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.death }],
      },
    };
    deps.random = () => 0;
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);
    // Swapping weapons after the cast must not retune an effect already in flight, in either
    // direction — the amount was read from the equipment at launch.
    if (weapon === undefined) player.equipment.weapon = 28262;
    else delete player.equipment.weapon;

    for (const target of [primary, secondary]) {
      expect(target.debuffs, target.id).toMatchObject({ boundFromTick: 11, boundUntilTick: until });
    }
  });

  // capture ancient-spells-casts-anims-sounds-packet-data.txt t650: "You drain some of your
  // opponent's health." lands on the tick Blood Barrage FIRES, while that tick only schedules the
  // impact spotanim (delay=66). The heal must therefore be banked before any damage resolves, and
  // a Barrage draws one per target it rolled against.
  it('heals a Blood Barrage on the cast tick, once per target, before any damage lands', () => {
    // Guaranteed accurate maximum hits, so the 25% leech is an exact number rather than a
    // by-product of whichever way the shared RNG alternates across two targets.
    const certain = { ...FIRST_PARTY_TARGET_STATS, alwaysAccuratePlayerHit: true, alwaysMaximumPlayerHit: true };
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30], formulaStats: certain });
    const secondary = makeNpc({
      id: 'secondary',
      position: [31, 30],
      previousPosition: [31, 30],
      formulaStats: certain,
    });
    const world = makeMultiNpcWorld(10, [primary, secondary]);
    const player = getRequiredPlayer(world);
    player.manualCastSpell = 'Blood Barrage';
    player.vitals.hp = 20;
    player.stats.hitpoints.current = 20;
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
    const deps = makeDeps(world, new CombatSystem());
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: {
        kind: 'standard',
        slots: [{ id: RUNE.blood }, { id: RUNE.death }, { id: RUNE.soul }],
      },
    };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    // 20 + floor(29 * 0.25) twice = 20 + 7 + 7.
    expect({ hp: player.vitals.hp, mirrored: player.stats.hitpoints.current }).toEqual({ hp: 34, mirrored: 34 });
    // Blood contributes no post-hit effect at all, so nothing can double-pay when the splats land.
    expect(resolveSpellHitEffects('Blood Barrage', () => 0, {})).toBeUndefined();
  });

  it('turns to the target but casts, spends and attacks with nothing when a manual cast lacks its runes', () => {
    // Adjacent, so the weapon could swing if the refused cast fell back to it.
    const npc = makeNpc({ id: 'target', position: [31, 26], previousPosition: [31, 26], size: 1 });
    const world = makeMultiNpcWorld(10, [npc]);
    const player = getRequiredPlayer(world);
    player.manualCastSpell = 'Blood Barrage';
    player.facing = 0;
    const expectedFacing = structuredClone(player);
    facePlayerTowardNpc(expectedFacing, npc);
    const deps = makeDeps(world, new CombatSystem());
    // No soul runes.
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: { kind: 'standard', slots: [{ id: RUNE.blood }, { id: RUNE.death }, null] },
    };
    const supplies = structuredClone(deps.combatSupplies);
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);
    world.tick = 11;
    deps.tickEvents.setTick(11);
    processPlayerAutoAttack(player, deps);

    expect(player.facing).toBe(expectedFacing.facing);
    expect(player).toMatchObject({ attackTarget: null, attackInteractionActive: false, manualCastSpell: null });
    expect(deps.combatSystem.getNextAttackTick(player.id)).toBeUndefined();
    expect(deps.combatSupplies).toEqual(supplies);
    expect(world.pendingHits).toEqual([]);
    expect(deps.tickEvents.flush()).toEqual([]);
  });

  // The sibling case runs with the hit delay mocked to 0, where launch and impact collapse onto one
  // call and a heal wired to the hitsplat would pass it too. Flying the spell is what separates them.
  it('banks the Blood heal while the spell is still airborne, and adds nothing when it lands', () => {
    const certain = { ...FIRST_PARTY_TARGET_STATS, alwaysAccuratePlayerHit: true, alwaysMaximumPlayerHit: true };
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30], formulaStats: certain });
    const secondary = makeNpc({
      id: 'secondary',
      position: [31, 30],
      previousPosition: [31, 30],
      formulaStats: certain,
    });
    const world = makeMultiNpcWorld(10, [primary, secondary]);
    const player = getRequiredPlayer(world);
    player.manualCastSpell = 'Blood Barrage';
    player.vitals.hp = 20;
    player.stats.hitpoints.current = 20;
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
    mockHitDelayFromEndTime.mockReturnValue(2);
    const deps = makeDeps(world, new CombatSystem());
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: { kind: 'standard', slots: [{ id: RUNE.blood }, { id: RUNE.death }, { id: RUNE.soul }] },
    };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    const pendingHit = world.pendingHits[0];
    if (pendingHit === undefined) throw new Error('Expected Blood Barrage to fly rather than land instantly');
    expect(pendingHit.impactTick).toBeGreaterThan(10);
    // Healed in full with both splats still in the air.
    expect(player.vitals.hp).toBe(34);

    world.tick = pendingHit.impactTick;
    deps.combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    expect({ hp: player.vitals.hp, mirrored: player.stats.hitpoints.current }).toEqual({ hp: 34, mirrored: 34 });
  });

  // Phantom barrage, OBSERVED in capture inferno-waves-(35ish)-to-68-packet-data.txt t1214→t1219:
  // an NPC killed in this tick's NPC band, its death not yet processed, still takes a manual cast and
  // a Barrage's area. The roll heals at launch; XP stays capped by the 0 HP left.
  describe("on an NPC's kill tick", () => {
    const certain = { ...FIRST_PARTY_TARGET_STATS, alwaysAccuratePlayerHit: true, alwaysMaximumPlayerHit: true };

    function npcAt(id: string, x: number, death?: 'pending' | 'started'): NpcActor {
      const npc = makeNpc({ id, position: [x, 30], previousPosition: [x, 30], size: 1, formulaStats: certain });
      if (death === undefined) return npc;
      npc.deathPolicy = 'queued';
      npc.vitals.hp = 0;
      recordNpcLethalTransition(npc, 10, 'hit-queue');
      if (death === 'started') startNpcDeath(npc);
      return npc;
    }

    function castBloodBarrage(npcs: readonly NpcActor[], mode: 'manual' | 'autocast') {
      const world = makeMultiNpcWorld(10, npcs);
      const player = getRequiredPlayer(world);
      player.vitals.hp = 20;
      player.stats.hitpoints.current = 20;
      mockGetFormulaStyle.mockReturnValue('magic');
      mockFormulaStyleToDamageType.mockReturnValue('magic');
      mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
      mockHitDelayFromEndTime.mockReturnValue(5);
      player.manualCastSpell = mode === 'manual' ? 'Blood Barrage' : null;
      if (mode === 'autocast') {
        mockResolveActiveSpell.mockReturnValue({
          name: 'Blood Barrage',
          spellbook: 'ancient',
          icon: 'blood_barrage',
          attackRange: 10,
        });
      }
      const deps = makeDeps(world, new CombatSystem());
      deps.combatSupplies = {
        ...deps.combatSupplies,
        ...(mode === 'autocast' ? { selectedSpell: 'Blood Barrage', spellbook: 'ancient' as const } : {}),
        runePouch: { kind: 'standard', slots: [{ id: RUNE.blood }, { id: RUNE.death }, { id: RUNE.soul }] },
      };
      deps.tickEvents.setTick(10);

      processPlayerAutoAttack(player, deps);

      const events = deps.tickEvents.flush();
      return {
        player,
        attacked: events.some((event) => isCoreEvent(event, 'attack_started') && event.sourceId === player.id),
        xpDrops: events.flatMap((event) => (isCoreEvent(event, 'xp_drop') ? [event.predictedHit] : [])),
        queued: world.pendingHits.map((hit) => ({ targetId: hit.targetId, impactTick: hit.impactTick })),
      };
    }

    it('lets a manual cast launch on a pending death: it heals off the roll, drops no XP and queues its hit', () => {
      const killed = npcAt('primary', 30, 'pending');

      const cast = castBloodBarrage([killed], 'manual');

      expect(cast.attacked).toBe(true);
      // 20 + floor(29 * 0.25).
      expect(cast.player.vitals.hp).toBe(27);
      expect(cast.xpDrops).toEqual([]);
      expect(cast.queued).toEqual([{ targetId: 'primary', impactTick: 15 }]);
      // Queuing it moves nothing about the death: still processed at K+1.
      expect(killed.death).toEqual({ status: 'pending', killTick: 10, processTick: 11, causeStage: 'hit-queue' });
    });

    it.each([
      { mode: 'autocast', death: 'pending' },
      { mode: 'manual', death: 'started' },
    ] as const)('refuses a $mode cast on a $death death and drops the target', ({ mode, death }) => {
      const cast = castBloodBarrage([npcAt('primary', 30, death)], mode);

      expect(cast).toMatchObject({ attacked: false, xpDrops: [], queued: [] });
      expect(cast.player.vitals.hp).toBe(20);
      expect(cast.player.attackTarget).toBeNull();
    });

    it.each([
      'manual',
      'autocast',
    ] as const)('takes a pending-death neighbor into a %s Barrage: its roll heals, and gives no XP', (mode) => {
      const killed = npcAt('killed', 31, 'pending');

      const cast = castBloodBarrage([npcAt('primary', 30), killed, npcAt('processed', 29, 'started')], mode);

      expect(cast.queued.map((hit) => hit.targetId)).toEqual(['primary', 'killed']);
      // 20 + floor(29 * 0.25) per target rolled against.
      expect(cast.player.vitals.hp).toBe(34);
      // The primary's 29 alone: the neighbor had no HP left to lose.
      expect(cast.xpDrops).toEqual([29]);
      expect(killed.death).toMatchObject({ status: 'pending', processTick: 11 });
    });

    /** A manual Blood Barrage clicked with the special toggled on and an Accursed sceptre wielded. */
    function castWithCondemnArmed(primary: NpcActor) {
      const world = makeMultiNpcWorld(10, [primary]);
      const player = getRequiredPlayer(world);
      player.equipment = { weapon: ACCURSED_SCEPTRE };
      player.manualCastSpell = 'Blood Barrage';
      player.isSpecialAttackActive = true;
      mockGetFormulaStyle.mockReturnValue('magic');
      mockFormulaStyleToDamageType.mockReturnValue('magic');
      mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
      // Both delays flown, so either attack's hit is still queued to read: the spell's, and Condemn's.
      mockHitDelayFromEndTime.mockReturnValue(5);
      mockCalculateHitDelay.mockReturnValue(5);
      const deps = makeDeps(world, new CombatSystem());
      deps.combatSupplies = {
        ...deps.combatSupplies,
        runePouch: { kind: 'standard', slots: [{ id: RUNE.blood }, { id: RUNE.death }, { id: RUNE.soul }] },
      };
      deps.tickEvents.setTick(10);

      processPlayerAutoAttack(player, deps);

      const attacks = deps.tickEvents
        .flush()
        .flatMap((event) =>
          isCoreEvent(event, 'attack_started') && event.sourceId === player.id
            ? [{ spellId: event.spellId, usingSpecialAttack: event.usingSpecialAttack }]
            : [],
        );
      return {
        player,
        attacks,
        queued: world.pendingHits.map((hit) => ({
          usingSpecialAttack: hit.usingSpecialAttack,
          postHitEffects: hit.postHitEffects,
        })),
      };
    }

    it('casts the manual spell, not Condemn, at a pending death, and spends no special energy', () => {
      const cast = castWithCondemnArmed(npcAt('primary', 30, 'pending'));

      expect(cast.attacks).toEqual([{ spellId: 'Blood Barrage', usingSpecialAttack: false }]);
      expect(cast.queued).toEqual([{ usingSpecialAttack: false, postHitEffects: undefined }]);
      expect(cast.player.specialAttack.energy).toBe(100);
      // As for any refused special: the toggle is put down, and an ordinary attack is made instead.
      expect(cast.player.isSpecialAttackActive).toBe(false);
    });

    // Existing behavior, pinned: Condemn is a powered special that replaces the manual spell.
    it('fires Condemn in place of the manual spell at a living target, as before', () => {
      const cast = castWithCondemnArmed(npcAt('primary', 30));

      expect(cast.attacks).toEqual([{ spellId: undefined, usingSpecialAttack: true }]);
      expect(cast.queued).toEqual([{ usingSpecialAttack: true, postHitEffects: [{ effect: 'condemn' }] }]);
      expect(cast.player.specialAttack.energy).toBe(50);
      expect(cast.player.isSpecialAttackActive).toBe(false);
    });

    it('freezes only the living targets of a manual Ice Barrage cast on a kill tick', () => {
      const primary = npcAt('primary', 30, 'pending');
      const dyingNeighbour = npcAt('dying', 31, 'pending');
      const livingNeighbour = npcAt('living', 29);
      const world = makeMultiNpcWorld(10, [primary, dyingNeighbour, livingNeighbour]);
      const player = getRequiredPlayer(world);
      player.manualCastSpell = 'Ice Barrage';
      mockGetFormulaStyle.mockReturnValue('magic');
      mockFormulaStyleToDamageType.mockReturnValue('magic');
      mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
      mockHitDelayFromEndTime.mockReturnValue(5);
      const deps = makeDeps(world, new CombatSystem());
      deps.combatSupplies = {
        ...deps.combatSupplies,
        runePouch: { kind: 'standard', slots: [{ id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.death }] },
      };
      deps.tickEvents.setTick(10);

      processPlayerAutoAttack(player, deps);

      // Every square was hit (the stats make each roll accurate), but a dying NPC is not frozen.
      expect(world.pendingHits.map((hit) => [hit.targetId, hit.accuracySucceeded])).toEqual([
        ['primary', true],
        ['dying', true],
        ['living', true],
      ]);
      expect([primary.debuffs, dyingNeighbour.debuffs].map((debuffs) => debuffs?.boundUntilTick)).toEqual([
        undefined,
        undefined,
      ]);
      expect(livingNeighbour.debuffs).toMatchObject({ boundFromTick: 11, boundUntilTick: 43 });
      // Nothing is left to freeze at impact either: the freeze is stripped from what the hits carry.
      expect(world.pendingHits.some((hit) => hit.postHitEffects?.some((effect) => effect.effect === 'freeze'))).toBe(
        false,
      );
    });
  });

  it('keeps Burst and Barrage single-target when the encounter explicitly models single combat', () => {
    const primary = makeNpc({ id: 'primary', position: [30, 30], previousPosition: [30, 30] });
    const secondary = makeNpc({ id: 'secondary', position: [31, 30], previousPosition: [31, 30] });
    const world = makeMultiNpcWorld(10, [primary, secondary]);
    const player = getRequiredPlayer(world);
    player.manualCastSpell = 'Ice Barrage';
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
    const deps = makeDeps(world, new CombatSystem());
    deps.encounterRules = { multiCombat: false };
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: {
        kind: 'standard',
        slots: [{ id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.death }],
      },
    };
    const onDamageApplied = vi.fn();
    deps.onDamageApplied = onDamageApplied;
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    expect(onDamageApplied.mock.calls.map(([info]) => info.targetId)).toEqual([primary.id]);
  });

  it('resolves an eligible naked attack without the theoretical calculator or samplers', () => {
    const world = makeWorld(10, {
      formulaStats: {
        levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
        offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
        defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
      },
    });
    const player = getRequiredPlayer(world);
    player.equipment = {};
    player.equipmentStats = createEmptyStats();
    const random = vi.fn(() => 0);
    const deps = { ...makeDeps(world, new CombatSystem()), random };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    const events = deps.tickEvents.flush();
    expect(random).toHaveBeenCalledTimes(2);
    expect(events.find((event) => isCoreEvent(event, 'attack_started'))).toMatchObject({
      style: 'melee',
      attackKind: 'melee_crush',
    });
    expect(events.find((event) => isCoreEvent(event, 'hit_applied'))).toMatchObject({ damage: 1 });
    expect(deps.onDamageApplied).toHaveBeenCalledWith(
      expect.objectContaining({
        attackType: 'melee',
        baseDamage: 1,
        effectiveDamage: 1,
        expectedHit: expect.any(Number),
      }),
    );
  });

  it('resolves a weapon-only Scythe swing as three independently sampled hits against a 3x3 target', () => {
    const world = makeWorld(10, { size: 3, formulaStats: FIRST_PARTY_TARGET_STATS });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: SCYTHE_OF_VITUR };
    player.equipmentStats = createEmptyStats();
    const random = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999);
    const combatSystem = new CombatSystem();
    const deps = { ...makeDeps(world, combatSystem), random };

    processPlayerAutoAttack(player, deps);

    expect(random).toHaveBeenCalledTimes(6);
    expect(world.pendingHits).toMatchObject([
      { impactTick: 10, rolledDamage: 5, accuracySucceeded: true },
      { impactTick: 10, rolledDamage: 2, accuracySucceeded: true },
    ]);

    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    const hits = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(hits.map(({ damage, accurate }) => ({ damage, accurate }))).toEqual([
      { damage: 11, accurate: true },
      { damage: 5, accurate: true },
      { damage: 2, accurate: true },
    ]);
  });

  it('resolves Dual macuahuitl hit one at base impact and queues hit two one tick later with its own accuracy', () => {
    const world = makeWorld(10, { size: 3, formulaStats: FIRST_PARTY_TARGET_STATS });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: DUAL_MACUAHUITL };
    player.equipmentStats = createEmptyStats();
    mockCalculateHitDelay.mockReturnValue(2);
    const random = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0.999_999);
    const combatSystem = new CombatSystem();
    const deps = { ...makeDeps(world, combatSystem), random };

    processPlayerAutoAttack(player, deps);

    expect(random).toHaveBeenCalledTimes(3);
    expect(world.pendingHits).toMatchObject([
      {
        style: 'melee',
        attackKind: 'melee_crush',
        launchTick: 10,
        impactTick: 12,
        rolledDamage: 5,
        accuracySucceeded: true,
      },
      {
        style: 'melee',
        attackKind: 'melee_crush',
        launchTick: 10,
        impactTick: 13,
        rolledDamage: 0,
        accuracySucceeded: false,
      },
    ]);

    world.tick = 12;
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });
    world.tick = 13;
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    const hits = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(hits.map(({ tick, damage, accurate }) => ({ tick, damage, accurate }))).toEqual([
      { tick: 12, damage: 5, accurate: true },
      { tick: 13, damage: 0, accurate: false },
    ]);
  });

  // A player's committed hits persist (spec section 4): a replaced TARGET instance still voids them, but a
  // replaced source does not — the instance that launched them delivers them, never the newcomer.
  it.each([
    'source',
    'target',
  ] as const)('resolves remaining multi-hit damage by launch-time instance when the %s is replaced', (replaced) => {
    const target = makeNpc({ size: 3, formulaStats: FIRST_PARTY_TARGET_STATS });
    const world = makeMultiNpcWorld(10, [target]);
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: SCYTHE_OF_VITUR };
    player.equipmentStats = createEmptyStats();
    const random = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999);
    const combatSystem = new CombatSystem();
    const deps = { ...makeDeps(world, combatSystem), random };
    processPlayerAutoAttack(player, deps);
    deps.tickEvents.flush();
    vi.mocked(deps.onDamageApplied).mockClear();
    const replacement = replaced === 'source' ? makePlayer() : makeNpc();
    world.actors.set(replacement.id, replacement);
    const damageTarget = world.actors.get(target.id);
    if (!damageTarget) throw new TypeError('Missing multi-hit target');
    const hpBefore = damageTarget.vitals.hp;

    combatSystem.processPendingHits(world, { events: deps.tickEvents, onDamageApplied: deps.onDamageApplied });

    expect(world.pendingHits).toEqual([]);
    if (replaced === 'target') {
      expect(damageTarget.vitals.hp).toBe(hpBefore);
      expect(deps.onDamageApplied).not.toHaveBeenCalled();
      expect(deps.tickEvents.flush()).toEqual([]);
      return;
    }
    expect(damageTarget.vitals.hp).toBe(hpBefore - 7);
    expect(vi.mocked(deps.onDamageApplied).mock.calls.map(([info]) => [info.sourceId, info.effectiveDamage])).toEqual([
      [player.id, 5],
      [player.id, 2],
    ]);
  });

  it('queues each delayed Scythe hitsplat as its own consecutive entry and lands them in order', () => {
    const target = makeNpc({ size: 3, formulaStats: FIRST_PARTY_TARGET_STATS });
    const world = makeMultiNpcWorld(10, [target]);
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: SCYTHE_OF_VITUR };
    player.equipmentStats = createEmptyStats();
    mockCalculateHitDelay.mockReturnValue(2);
    const random = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999);
    const combatSystem = new CombatSystem();
    const deps = { ...makeDeps(world, combatSystem), random };
    // An older hit due on the same tick goes first, though it was launched later in game time.
    const older = enqueueTestPendingHit(world, combatSystem, {
      sourceId: player.id,
      targetId: target.id,
      style: 'magic',
      attackKind: 'magic_fire',
      launchTick: 11,
      impactTick: 12,
      rolledDamage: 7,
      accuracySucceeded: true,
    });

    processPlayerAutoAttack(player, deps);

    const scythe = world.pendingHits.filter((hit) => hit !== older);
    expect(scythe.map((hit) => hit.enqueueSequence)).toEqual([1, 2, 3]);
    deps.tickEvents.flush();
    world.tick = 12;
    combatSystem.processPendingHits(world, { events: deps.tickEvents, onDamageApplied: deps.onDamageApplied }, 'npc');

    const landed = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(landed.map((event) => event.damage)).toEqual([7, ...scythe.map((hit) => hit.rolledDamage)]);
    expect(scythe.map((hit) => hit.rolledDamage)).toEqual([11, 5, 2]);
    expect(world.pendingHits).toEqual([]);
  });

  it('lands the Scythe hitsplats after a killing first one as zeros, with one death (C:1606 45,0,0)', () => {
    const target = makeNpc({ size: 3, formulaStats: FIRST_PARTY_TARGET_STATS });
    target.vitals = { hp: 11, maxHp: 11 };
    const world = makeMultiNpcWorld(10, [target]);
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: SCYTHE_OF_VITUR };
    player.equipmentStats = createEmptyStats();
    mockCalculateHitDelay.mockReturnValue(2);
    const random = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999);
    const combatSystem = new CombatSystem();
    const deps = { ...makeDeps(world, combatSystem), random };
    processPlayerAutoAttack(player, deps);
    expect(world.pendingHits.map((hit) => hit.rolledDamage)).toEqual([11, 5, 2]);
    deps.tickEvents.flush();

    world.tick = 12;
    combatSystem.processPendingHits(world, { events: deps.tickEvents, onDamageApplied: deps.onDamageApplied }, 'npc');

    const events = deps.tickEvents.flush();
    expect(
      events.flatMap((event) => (isCoreEvent(event, 'hitsplat_spawned') ? [[event.amount, event.hitsplatType]] : [])),
    ).toEqual([
      [11, 'damage'],
      [0, 'block'],
      [0, 'block'],
    ]);
    expect(events.filter((event) => isCoreEvent(event, 'actor_died'))).toHaveLength(1);
    expect(world.pendingHits).toEqual([]);
  });

  it('suppresses Dual macuahuitl hit two without another random sample when hit one misses', () => {
    const world = makeWorld(10, { formulaStats: FIRST_PARTY_TARGET_STATS });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: DUAL_MACUAHUITL };
    player.equipmentStats = createEmptyStats();
    const random = vi.fn<() => number>(() => 0.999_999);
    const deps = { ...makeDeps(world, new CombatSystem()), random };

    processPlayerAutoAttack(player, deps);

    expect(random).toHaveBeenCalledOnce();
    expect(world.pendingHits).toMatchObject([{ rolledDamage: 0, accuracySucceeded: false }]);
    const firstHit = deps.tickEvents.flush().find((event) => isCoreEvent(event, 'hit_applied'));
    expect(firstHit).toMatchObject({ damage: 0, accurate: false });
  });

  it('resolves a weapon-only Dragon warhammer special first party and preserves its defence drain', () => {
    const world = makeWorld(10, {
      formulaStats: {
        ...FIRST_PARTY_TARGET_STATS,
        levels: { ...FIRST_PARTY_TARGET_STATS.levels, defence: 100 },
      },
      debuffs: {},
    });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: DRAGON_WARHAMMER };
    player.equipmentStats = createEmptyStats();
    player.isSpecialAttackActive = true;
    player.specialAttack = { ...player.specialAttack, energy: 100 };
    const random = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    const deps = { ...makeDeps(world, new CombatSystem()), random };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    expect(random).toHaveBeenCalledTimes(2);
    expect(player.specialAttack.energy).toBe(50);
    expect(deps.tickEvents.flush().find((event) => isCoreEvent(event, 'hit_applied'))).toMatchObject({
      damage: 16,
      accurate: true,
    });
    expect(world.getNpcs()[0]?.debuffs?.defenceDrain).toBe(30);
  });

  // /w/Soulreaper_axe: a stack per axe attack, added after that attack's damage is rolled, up to
  // five; Behead costs nothing, spends every stack and plans from the un-stacked Strength level.
  it('stacks the Soulreaper axe after each roll and spends the stacks on a free Behead', () => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: 28338 };
    player.equipmentStats = { ...createEmptyStats(), meleeStrength: 100 };
    const combatSystem = new CombatSystem();
    const swing = (): number | undefined => {
      const random = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(0.999);
      const deps = { ...makeDeps(world, combatSystem), random };
      deps.tickEvents.setTick(world.tick);
      processPlayerAutoAttack(player, deps);
      const hit = deps.tickEvents.flush().find((event) => isCoreEvent(event, 'hit_applied'));
      world.tick += 4;
      return hit?.damage;
    };

    // Max hits at 99 Strength, +100 strength bonus, 0..5 stacks of +6%: 27, 29, 30, 32, 33, 35.
    expect(swing()).toBe(27);
    expect(player.soulreaper).toEqual({ stacks: 1, decayTick: 60 });
    expect([swing(), swing(), swing(), swing(), swing()]).toEqual([29, 30, 32, 33, 35]);
    expect(player.soulreaper?.stacks).toBe(5);

    player.isSpecialAttackActive = true;
    player.specialAttack = { ...player.specialAttack, energy: 0 };
    // floor(27 x 1.30), not floor(35 x 1.30) = 45: the stacks' Strength boost is spent first.
    expect(swing()).toBe(35);
    expect(player.soulreaper).toBeUndefined();
    expect(player.specialAttack.energy).toBe(0);
    expect(player.isSpecialAttackActive).toBe(false);
  });

  it('resolves a Burning claws special into three hitsplats and charges 35% energy', () => {
    const world = makeWorld(10, { size: 1, formulaStats: FIRST_PARTY_TARGET_STATS });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: BURNING_CLAWS };
    player.equipmentStats = createEmptyStats();
    player.isSpecialAttackActive = true;
    player.specialAttack = { ...player.specialAttack, energy: 100 };
    const random = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(0).mockReturnValue(0.999);
    const combatSystem = new CombatSystem();
    const deps = { ...makeDeps(world, combatSystem), random };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    expect(player.specialAttack.energy).toBe(65);
    const damages = deps.tickEvents
      .flush()
      .filter((event) => isCoreEvent(event, 'hit_applied'))
      .map((hit) => hit.damage);
    expect(damages).toEqual([2, 2, 4]);
    expect(damages[0]).toBe(damages[1]);
    expect(damages[2]).toBe(damages[0] + damages[1]);
  });

  it('lays one burn stack per Burning claws hitsplat that rolls its branch chance', () => {
    const world = makeWorld(10, { size: 1, formulaStats: FIRST_PARTY_TARGET_STATS });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: BURNING_CLAWS };
    player.equipmentStats = createEmptyStats();
    player.isSpecialAttackActive = true;
    player.specialAttack = { ...player.specialAttack, energy: 100 };
    const combatSystem = new CombatSystem();
    const deps = { ...makeDeps(world, combatSystem), random: () => 0 };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    expect(world.getNpcs()[0]?.burnStacks).toHaveLength(3);
    expect(world.getNpcs()[0]?.burnStacks?.[0]).toMatchObject({
      origin: 'special-attack',
      pulsesRemaining: 10,
    });
    // All three land on one tick, so they share one clock and pulse as a single 3 rather than
    // three 1s — the whole point of the barrage burning harder than three separate burns.
    expect(world.getNpcs()[0]?.burnNextPulseTick).toBe(world.tick + BURN_PERIOD_TICKS);
  });

  it('resolves Dragon dagger special hits independently without the transitional calculator', () => {
    const world = makeWorld(10, { size: 1, formulaStats: FIRST_PARTY_TARGET_STATS });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: DRAGON_DAGGER };
    player.equipmentStats = createEmptyStats();
    player.isSpecialAttackActive = true;
    player.specialAttack = { ...player.specialAttack, energy: 100 };
    const random = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0.999_999);
    const combatSystem = new CombatSystem();
    const deps = { ...makeDeps(world, combatSystem), random };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    expect(random).toHaveBeenCalledTimes(3);
    expect(world.pendingHits).toMatchObject([{ rolledDamage: 0, accuracySucceeded: false }]);

    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    const hits = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(hits.map(({ damage, accurate }) => ({ damage, accurate }))).toEqual([
      { damage: 12, accurate: true },
      { damage: 0, accurate: false },
    ]);
  });

  it.each(NON_WEAPON_EQUIPMENT_SLOTS)('uses the first-party Dragon warhammer route with %s equipped', (slot) => {
    const world = makeWorld(10, { formulaStats: FIRST_PARTY_TARGET_STATS });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: DRAGON_WARHAMMER, [slot]: 1 };
    player.equipmentStats = createEmptyStats();
    player.isSpecialAttackActive = true;
    player.specialAttack = { ...player.specialAttack, energy: 100 };
    const deps = makeDeps(world, new CombatSystem());

    processPlayerAutoAttack(player, deps);

    expect(player.specialAttack.energy).toBe(50);
  });

  it('refuses an unsupported special before energy or attack events', () => {
    const world = makeWorld(10, { formulaStats: FIRST_PARTY_TARGET_STATS });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: UNSUPPORTED_SPECIAL_WEAPON };
    player.equipmentStats = createEmptyStats();
    player.isSpecialAttackActive = true;
    player.specialAttack = { ...player.specialAttack, energy: 100 };
    const deps = makeDeps(world, new CombatSystem());
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    expect(player.specialAttack.energy).toBe(100);
    expect(deps.tickEvents.flush().some((event) => isCoreEvent(event, 'attack_started'))).toBe(false);
    expect(world.pendingHits).toEqual([]);
  });

  it.each([
    TOXIC_BLOWPIPE,
    28688,
  ])('heals at launch for %i using the loaded-ammo Toxic Siphon roll before delayed impact', (weaponId) => {
    const world = makeWorld(10, { size: 1, formulaStats: FIRST_PARTY_TARGET_STATS });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: weaponId };
    player.equipmentStats = createEmptyStats();
    player.vitals.hp = 40;
    player.stats.hitpoints.current = 40;
    player.isSpecialAttackActive = true;
    player.specialAttack = { ...player.specialAttack, energy: 100 };
    mockGetFormulaStyle.mockReturnValue('ranged');
    mockCalculateHitDelay.mockReturnValueOnce(3);
    const dartId = 11230;
    const lookupItemStats = vi.fn((itemId: number) =>
      itemId === dartId ? { ...createEmptyStats(), attackRanged: 10, rangedStrength: 20 } : null,
    );
    const random = vi.fn<() => number>().mockReturnValueOnce(0).mockReturnValueOnce(0.999);
    const deps = { ...makeDeps(world, new CombatSystem()), lookupItemStats, random };
    deps.combatSupplies = { ...deps.combatSupplies, blowpipe: { id: dartId } };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    expect(lookupItemStats).toHaveBeenCalledWith(dartId);
    expect(random).toHaveBeenCalledTimes(2);
    expect(player.vitals.hp).toBe(50);
    expect(player.stats.hitpoints.current).toBe(50);
    expect(world.pendingHits).toMatchObject([{ rolledDamage: 21, impactTick: 13 }]);
    expect(deps.tickEvents.flush().some((event) => isCoreEvent(event, 'hit_applied'))).toBe(false);
    world.tick = 13;
    deps.combatSystem.processPendingHits(world, { events: deps.tickEvents });
    expect(deps.tickEvents.flush().find((event) => isCoreEvent(event, 'hit_applied'))).toMatchObject({ damage: 21 });
    expect(player.vitals.hp).toBe(50);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it.each(['range', 'cooldown'] as const)('does not heal Toxic Siphon when rejected by %s', (rejection) => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    const deps = makeDeps(world, new CombatSystem());
    player.equipment = { weapon: TOXIC_BLOWPIPE };
    player.vitals.hp = 40;
    player.stats.hitpoints.current = 40;
    player.isSpecialAttackActive = true;
    player.specialAttack = { ...player.specialAttack, energy: 100 };
    mockGetFormulaStyle.mockReturnValue('ranged');
    deps.combatSupplies = { ...deps.combatSupplies, blowpipe: { id: 11230 } };
    if (rejection === 'range') {
      mockIsInAttackRange.mockReturnValueOnce(false);
    } else {
      deps.combatSystem.processAttack(world, player, makeNpc(), {
        events: deps.tickEvents,
        getAttackSpeed: () => 4,
        resolveAttack: () => ({ accuracySucceeded: false }),
      });
      deps.tickEvents.flush();
    }

    processPlayerAutoAttack(player, deps);

    expect(player.vitals.hp).toBe(40);
    expect(player.stats.hitpoints.current).toBe(40);
    expect(player.specialAttack.energy).toBe(100);
    expect(deps.tickEvents.flush().some((event) => isCoreEvent(event, 'attack_started'))).toBe(false);
    expect(world.pendingHits).toEqual([]);
  });

  it.each(NON_WEAPON_EQUIPMENT_SLOTS)('uses the first-party Scythe route with %s equipped', (slot) => {
    const world = makeWorld(10, { size: 3, formulaStats: FIRST_PARTY_TARGET_STATS });
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: SCYTHE_OF_VITUR, [slot]: 1 };
    player.equipmentStats = createEmptyStats();
    const random = vi.fn(() => 0);
    const deps = { ...makeDeps(world, new CombatSystem()), random };

    processPlayerAutoAttack(player, deps);

    expect(random).toHaveBeenCalledTimes(6);
  });
});

describe('processPlayerAutoAttack — attack resources', () => {
  it('does not start an attack with a profiled external-ammo weapon and no ammo', () => {
    const world = makeWorld(0);
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: 11785 };
    mockGetFormulaStyle.mockReturnValue('ranged');
    const deps = makeDeps(world, new CombatSystem({ defaultAttackSpeedTicks: 4 }));

    processPlayerAutoAttack(player, deps);

    expect(launchedAttack(deps)).toBeUndefined();
  });

  it('keeps launching blowpipe attacks - darts are modeled as infinite', () => {
    const world = makeWorld(0);
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: 12926 };
    mockGetFormulaStyle.mockReturnValue('ranged');
    const combatSupplies = { ...createEmptyCombatSupplies(), blowpipe: { id: 11230 } };
    const deps = makeDeps(world, new CombatSystem({ defaultAttackSpeedTicks: 4 }));
    deps.combatSupplies = combatSupplies;

    processPlayerAutoAttack(player, deps);

    expect(combatSupplies.blowpipe).toEqual({ id: 11230 });
    expect(launchedAttack(deps)).toMatchObject({ ammoId: 11230, ammoSource: 'blowpipe' });
  });

  it('starts an attack with an unprofiled ranged weapon and no ammo', () => {
    const world = makeWorld(0);
    const player = getRequiredPlayer(world);
    player.equipment = { weapon: 999_999 };
    mockGetFormulaStyle.mockReturnValue('ranged');
    const deps = makeDeps(world, new CombatSystem({ defaultAttackSpeedTicks: 4 }));

    processPlayerAutoAttack(player, deps);

    expect(launchedAttack(deps)).toMatchObject({ ammoSource: 'none' });
  });

  it('plans an ordinary equipped attack without the transitional calculator', () => {
    const world = makeWorld(0, { npcTypeId: 7706, vitals: { hp: 437, maxHp: 1200 } });
    const player = getRequiredPlayer(world);
    const deps = makeDeps(world, new CombatSystem({ defaultAttackSpeedTicks: 4 }));

    processPlayerAutoAttack(player, deps);

    expect(launchedAttack(deps)).toBeDefined();
  });

  it.each([
    { label: 'normal attack', weaponId: AGS, usingSpecialAttack: false, effectiveSpeed: 4, expectedDamage: 13 },
    { label: 'Eye of ayak special', weaponId: 31113, usingSpecialAttack: true, effectiveSpeed: 3, expectedDamage: 18 },
  ])('records distribution expected damage for a $label', ({
    weaponId,
    usingSpecialAttack,
    effectiveSpeed,
    expectedDamage: _expectedDamage,
  }) => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    player.equipment.weapon = weaponId;
    player.isSpecialAttackActive = usingSpecialAttack;
    player.specialAttack = { energy: 100, regenTickCounter: 0, lightbearerEquipped: false };
    mockGetPlayerEffectiveCombatParams.mockReturnValue({ attackSpeed: effectiveSpeed, attackRange: 10 });
    const deps = makeDeps(world, new CombatSystem());

    processPlayerAutoAttack(player, deps);

    expect(deps.onDamageApplied).toHaveBeenCalledWith(expect.objectContaining({ expectedHit: expect.any(Number) }));
  });

  it.each([{ encounterKind: 'yama_p3', formulaStyle: 'melee_slash' }] satisfies ReadonlyArray<{
    encounterKind: string;
    formulaStyle: CombatFormulaStyle;
  }>)('starts the $encounterKind default attack without a consumable attack resource', ({
    encounterKind,
    formulaStyle,
  }) => {
    const loadout = getDefaultLoadout(encounterKind);
    const world = makeWorld(0);
    const player = getRequiredPlayer(world);
    player.equipment = loadout.equipment;
    mockGetFormulaStyle.mockReturnValue(formulaStyle);
    const deps = makeDeps(world, new CombatSystem({ defaultAttackSpeedTicks: 4 }));
    deps.combatSupplies = loadout.supplies;

    processPlayerAutoAttack(player, deps);

    expect(launchedAttack(deps)).toMatchObject({ ammoSource: 'none' });
  });
});

describe('processPlayerAutoAttack — Eclipse burn attack identity', () => {
  const eclipseEquipment = { head: 29035, body: 29031, legs: 29033, weapon: 29000 } as const;

  it('does not add a burn stack when the equipped atlatl launches a manual spell cast', () => {
    const world = makeWorld(0);
    const player = getRequiredPlayer(world);
    const target = world.getNpcs()[0];
    if (!target) throw new Error('Expected target NPC');
    player.equipment = eclipseEquipment;
    player.manualCastSpell = 'Fire Strike';
    player.inventory[0] = { id: RUNE.fire, quantity: 3 };
    player.inventory[1] = { id: RUNE.air, quantity: 2 };
    player.inventory[2] = { id: RUNE.mind, quantity: 1 };
    mockGetFormulaStyle.mockReturnValue('ranged');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);

    processPlayerAutoAttack(player, makeDeps(world, new CombatSystem()));

    expect(target.burnStacks).toBeUndefined();
    random.mockRestore();
  });

  it('can add a burn stack when the equipped atlatl launches an accurate ranged attack', () => {
    const world = makeWorld(0);
    const player = getRequiredPlayer(world);
    const target = world.getNpcs()[0];
    if (!target) throw new Error('Expected target NPC');
    player.equipment = eclipseEquipment;
    mockGetFormulaStyle.mockReturnValue('ranged');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const deps = makeDeps(world, new CombatSystem());
    deps.combatSupplies = { ...deps.combatSupplies, equippedAmmo: { id: 28991 } };

    processPlayerAutoAttack(player, deps);

    expect(target.burnStacks).toHaveLength(1);
    random.mockRestore();
  });
});

describe('processPlayerAutoAttack — spec drain timing', () => {
  let combatSystem: CombatSystem;

  beforeEach(() => {
    combatSystem = new CombatSystem({ defaultAttackSpeedTicks: 4 });
    mockGetPlayerEffectiveCombatParams.mockReturnValue({ attackSpeed: 4, attackRange: 1 });
    mockIsInAttackRange.mockReturnValue(true);
  });

  it('should drain spec energy when attack cooldown is ready', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };

    const deps = makeDeps(world, combatSystem);
    processPlayerAutoAttack(player, deps);

    expect(player.specialAttack.energy).toBe(50);
    expect(player.isSpecialAttackActive).toBe(false);
  });

  it('should NOT drain spec energy when attack cooldown is not ready', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    const deps = makeDeps(world, combatSystem);

    // Fire a normal attack at tick 10 to set cooldown (next attack at tick 14)
    processPlayerAutoAttack(player, deps);

    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };

    // Try to attack at tick 11 — cooldown not ready
    world.tick = 11;
    processPlayerAutoAttack(player, deps);

    expect(player.specialAttack.energy).toBe(100);
    expect(player.isSpecialAttackActive).toBe(true);
  });

  it('should drain spec energy once cooldown expires after previously being blocked', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    const deps = makeDeps(world, combatSystem);

    // First attack at tick 10 — sets cooldown to tick 14
    processPlayerAutoAttack(player, deps);

    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };

    // Tick 12 — still on cooldown, should not drain
    world.tick = 12;
    processPlayerAutoAttack(player, deps);
    expect(player.specialAttack.energy).toBe(100);
    expect(player.isSpecialAttackActive).toBe(true);

    // Tick 14 — cooldown expired, should drain
    world.tick = 14;
    processPlayerAutoAttack(player, deps);
    expect(player.specialAttack.energy).toBe(50);
    expect(player.isSpecialAttackActive).toBe(false);
  });

  it('should preserve spec toggle across multiple non-attack ticks', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    const deps = makeDeps(world, combatSystem);

    processPlayerAutoAttack(player, deps);

    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };

    // Ticks 11, 12, 13 — all on cooldown
    for (const tick of [11, 12, 13]) {
      world.tick = tick;
      processPlayerAutoAttack(player, deps);
      expect(player.specialAttack.energy).toBe(100);
      expect(player.isSpecialAttackActive).toBe(true);
    }

    // Tick 14 — cooldown ready, spec fires
    world.tick = 14;
    processPlayerAutoAttack(player, deps);
    expect(player.specialAttack.energy).toBe(50);
    expect(player.isSpecialAttackActive).toBe(false);
  });

  it('should drain on first attack with no prior cooldown', () => {
    const world = makeWorld(1);
    const player = world.getPlayer()!;
    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };

    const deps = makeDeps(world, combatSystem);
    processPlayerAutoAttack(player, deps);

    expect(player.specialAttack.energy).toBe(50);
    expect(player.isSpecialAttackActive).toBe(false);
  });

  it('applies encounter special attack energy cost multiplier before spending energy', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };

    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: {
        specialAttacks: { energyCostMultiplier: 0.5 },
      },
    };

    processPlayerAutoAttack(player, deps);

    expect(player.specialAttack.energy).toBe(75);
    expect(player.isSpecialAttackActive).toBe(false);
  });

  it('uses encounter-modified combat params for range checks and attack speed', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: {
        modifyPlayerCombatParams: (params: EffectiveCombatParams) => ({
          ...params,
          attackSpeed: 7,
          attackRange: 9,
          meleeReach: 'diagonal' as const,
        }),
      },
    };

    processPlayerAutoAttack(player, deps);

    expect(mockIsInAttackRange).toHaveBeenCalledWith(
      player.position,
      expect.anything(),
      expect.anything(),
      9,
      true,
      'diagonal',
    );
    expect(combatSystem.getNextAttackTick(player.id)).toBe(17);
  });

  it('uses an encounter guaranteed max-hit grant on the next launched attack', () => {
    const world = makeWorld(10);
    const consumePlayerGuaranteedMaxHit = vi.fn(() => true);
    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: { consumePlayerGuaranteedMaxHit },
    };
    deps.tickEvents.setTick(10);

    const player = getRequiredPlayer(world);
    processPlayerAutoAttack(player, deps);

    const hitEvents = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(consumePlayerGuaranteedMaxHit).toHaveBeenCalledOnce();
    expect(hitEvents.map((event) => event.damage)).toEqual([11]);
  });

  it('forces a target maximum hit for standard ranged attacks', () => {
    mockGetFormulaStyle.mockReturnValue('ranged');
    mockFormulaStyleToDamageType.mockReturnValue('range');
    mockFormulaStyleToAttackKind.mockReturnValue('range_arrow');
    const world = makeWorld(10, {
      formulaStats: { ...FIRST_PARTY_TARGET_STATS, alwaysMaximumPlayerHit: true },
    });
    const deps = { ...makeDeps(world, combatSystem), random: vi.fn(() => 0) };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(getRequiredPlayer(world), deps);

    const hitEvents = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(hitEvents.map((event) => event.damage)).toEqual([11]);
  });

  it.each([
    { style: 'melee', attackKind: 'melee_crush' },
    { style: 'range', attackKind: 'range_shadow' },
  ] as const)('does not force a target maximum hit for $attackKind attacks', ({ style, attackKind }) => {
    mockGetFormulaStyle.mockReturnValue(style === 'range' ? 'ranged' : 'melee_crush');
    mockFormulaStyleToDamageType.mockReturnValue(style);
    mockFormulaStyleToAttackKind.mockReturnValue(attackKind);
    const world = makeWorld(10, {
      formulaStats: { ...FIRST_PARTY_TARGET_STATS, alwaysMaximumPlayerHit: true },
    });
    const deps = { ...makeDeps(world, combatSystem), random: vi.fn(() => 0) };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(getRequiredPlayer(world), deps);

    const hitEvents = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(hitEvents.map((event) => event.damage)).toEqual([1]);
  });

  it.each([
    { style: 'melee', attackKind: 'melee_crush', weakness: 'melee', forced: true },
    { style: 'range', attackKind: 'range_shadow', weakness: 'range', forced: true },
    { style: 'range', attackKind: 'range_arrow', weakness: 'magic', forced: false },
  ] as const)('forces a maximum only for the per-style weakness: $attackKind into $weakness', ({
    style,
    attackKind,
    weakness,
    forced,
  }) => {
    mockGetFormulaStyle.mockReturnValue(style === 'range' ? 'ranged' : 'melee_crush');
    mockFormulaStyleToDamageType.mockReturnValue(style);
    mockFormulaStyleToAttackKind.mockReturnValue(attackKind);
    const world = makeWorld(10, {
      formulaStats: { ...FIRST_PARTY_TARGET_STATS, alwaysMaximumPlayerHitStyles: [weakness] },
    });
    const deps = { ...makeDeps(world, combatSystem), random: vi.fn(() => 0) };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(getRequiredPlayer(world), deps);

    const [damage] = deps.tickEvents
      .flush()
      .filter((event) => isCoreEvent(event, 'hit_applied'))
      .map((event) => event.damage);
    if (forced) expect(damage).toBeGreaterThan(1);
    else expect(damage).toBe(1);
  });

  it('does not consume an encounter guaranteed max-hit grant while attack cooldown is blocked', () => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    processPlayerAutoAttack(player, makeDeps(world, combatSystem));
    const consumePlayerGuaranteedMaxHit = vi.fn(() => true);
    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: { consumePlayerGuaranteedMaxHit },
    };

    world.tick = 11;
    processPlayerAutoAttack(player, deps);

    expect(consumePlayerGuaranteedMaxHit).not.toHaveBeenCalled();
  });

  it('keeps an encounter guaranteed max-hit grant when an unsupported special is refused', () => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    player.equipment.weapon = UNSUPPORTED_SPECIAL_WEAPON;
    player.isSpecialAttackActive = true;
    player.specialAttack = { ...player.specialAttack, energy: 100 };
    const consumePlayerGuaranteedMaxHit = vi.fn(() => true);
    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: { consumePlayerGuaranteedMaxHit },
    };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    const hitEvents = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(consumePlayerGuaranteedMaxHit).not.toHaveBeenCalled();
    expect(hitEvents).toEqual([]);
    expect(player.specialAttack.energy).toBe(100);
  });

  it('applies an encounter guaranteed max-hit grant to every natural multi-hit hitsplat', () => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    player.equipment.weapon = 22325;
    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: { consumePlayerGuaranteedMaxHit: vi.fn(() => true) },
    };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    const hitEvents = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(hitEvents.map((event) => event.damage)).toEqual([11, 5, 2]);
  });

  it('floors an accurate hit at the encounter minimum, and leaves a bigger roll alone', () => {
    const playerMinimumHit = vi.fn((maxHit: number) => Math.floor(maxHit * 0.9));
    const damageOf = (accuracySample: number, damageSample: number): number[] => {
      const world = makeWorld(10);
      const deps = {
        ...makeDeps(world, new CombatSystem({ defaultAttackSpeedTicks: 4 })),
        encounterRules: { playerMinimumHit },
        random: vi.fn<() => number>().mockReturnValueOnce(accuracySample).mockReturnValueOnce(damageSample),
      };
      deps.tickEvents.setTick(10);
      processPlayerAutoAttack(getRequiredPlayer(world), deps);
      return deps.tickEvents
        .flush()
        .filter((event) => isCoreEvent(event, 'hit_applied'))
        .map((event) => event.damage);
    };

    expect(damageOf(0, 0)).toEqual([9]);
    expect(damageOf(0, 0.999)).toEqual([11]);
    expect(damageOf(0.999_999, 0)).toEqual([0]);
  });

  it('never misses a target that forces accuracy, and still rolls damage below the maximum', () => {
    const damageOf = (alwaysAccuratePlayerHit: boolean, sample: number): number[] => {
      const world = makeWorld(10, { formulaStats: { ...FIRST_PARTY_TARGET_STATS, alwaysAccuratePlayerHit } });
      const deps = {
        ...makeDeps(world, new CombatSystem({ defaultAttackSpeedTicks: 4 })),
        random: vi.fn(() => sample),
      };
      deps.tickEvents.setTick(10);
      processPlayerAutoAttack(getRequiredPlayer(world), deps);
      return deps.tickEvents
        .flush()
        .filter((event) => isCoreEvent(event, 'hit_applied'))
        .map((event) => event.damage);
    };

    expect(damageOf(false, 0.999_999)).toEqual([0]);
    expect(damageOf(true, 0.999_999)).toEqual([11]);
    expect(damageOf(true, 0.5)).toEqual([6]);
  });

  it('floors every multi-hit hitsplat against its own maximum, not the first one', () => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    player.equipment.weapon = 22325;
    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: { playerMinimumHit: (maxHit: number) => Math.floor(maxHit * 0.5) },
      random: vi.fn(() => 0),
    };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    const hitEvents = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(hitEvents.map((event) => event.damage)).toEqual([5, 2, 1]);
  });

  it('floors a single hit against its maximum', () => {
    const world = makeWorld(10);
    const deps = {
      ...makeDeps(world, new CombatSystem({ defaultAttackSpeedTicks: 4 })),
      encounterRules: { playerMinimumHit: (maxHit: number) => Math.floor(maxHit * 0.5) },
      random: vi.fn(() => 0),
    };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(getRequiredPlayer(world), deps);

    const hitEvents = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(hitEvents.map((event) => event.damage)).toEqual([5]);
  });

  it('does not floor or launch unsupported specials', () => {
    const damageFor = (): number[] => {
      const world = makeWorld(10);
      const player = getRequiredPlayer(world);
      player.equipment.weapon = UNSUPPORTED_SPECIAL_WEAPON;
      player.isSpecialAttackActive = true;
      player.specialAttack = { ...player.specialAttack, energy: 100 };
      const deps = {
        ...makeDeps(world, new CombatSystem({ defaultAttackSpeedTicks: 4 })),
        encounterRules: { playerMinimumHit: (maxHit: number) => Math.floor(maxHit * 0.5) },
      };
      deps.tickEvents.setTick(10);
      processPlayerAutoAttack(player, deps);
      return deps.tickEvents
        .flush()
        .filter((event) => isCoreEvent(event, 'hit_applied'))
        .map((event) => event.damage);
    };

    expect(damageFor()).toEqual([]);
  });

  it('does not queue hits for an unsupported special', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    player.equipment.weapon = UNSUPPORTED_SPECIAL_WEAPON;
    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };
    const deps = makeDeps(world, combatSystem);
    processPlayerAutoAttack(player, deps);

    expect(world.pendingHits).toHaveLength(0);
    expect(player.specialAttack.energy).toBe(100);
  });

  it('lands dragon claws Slice and Dice as four hitsplats for half the special bar', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    player.equipment.weapon = 13652;
    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };
    const deps = makeDeps(world, combatSystem);
    processPlayerAutoAttack(player, deps);
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    const hitsplats = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hitsplat_spawned'));
    expect(hitsplats).toHaveLength(4);
    expect(player.specialAttack.energy).toBe(50);
  });

  it('rolls blood fury per scythe hitsplat on the swing tick and shows one graphic on the target', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    player.equipment.weapon = 22325;
    player.equipment.amulet = AMULET_OF_BLOOD_FURY;
    player.vitals.hp = 50;
    player.vitals.maxHp = 99;
    // 0.1 lands every accuracy roll and procs every blood fury roll (20%).
    const deps = { ...makeDeps(world, combatSystem), random: () => 0.1 };
    processPlayerAutoAttack(player, deps);

    // Swing tick: the hits are still queued, yet the heal and the graphic are already out (N 7572).
    const rolled = world.pendingHits.map((hit) => hit.rolledDamage);
    const launchEvents = deps.tickEvents.flush();
    expect(rolled.length).toBeGreaterThan(0);
    const expectedHeal = [
      ...rolled,
      ...launchEvents.filter((event) => isCoreEvent(event, 'hit_applied')).map((event) => event.damage),
    ].reduce((total, damage) => total + Math.floor(damage * 0.3), 0);
    expect(player.vitals.hp).toBe(50 + expectedHeal);
    expect(launchEvents.filter((event) => isCoreEvent(event, 'npc_graphic_applied'))).toEqual([
      expect.objectContaining({ targetId: 'yama', spotAnimId: 1542, height: 92 }),
    ]);

    // Impact adds nothing further.
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });
    expect(player.vitals.hp).toBe(50 + expectedHeal);
  });

  it('shows no blood fury graphic when no hitsplat procs', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    player.equipment.weapon = 22325;
    player.equipment.amulet = 6585; // amulet of fury
    const deps = { ...makeDeps(world, combatSystem), random: () => 0.1 };
    processPlayerAutoAttack(player, deps);
    expect(deps.tickEvents.flush().some((event) => isCoreEvent(event, 'npc_graphic_applied'))).toBe(false);
  });

  it('preserves normal Scythe multi-hit distributions as three hitsplats', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    player.equipment.weapon = 22325;

    const deps = makeDeps(world, combatSystem);
    processPlayerAutoAttack(player, deps);
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    const hitsplats = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hitsplat_spawned'));
    expect(hitsplats.map((event) => event.amount)).toEqual([11, 5, 2]);
    expect(world.pendingHits).toHaveLength(0);
  });
});

describe('processPlayerAutoAttack — interaction facing', () => {
  let combatSystem: CombatSystem;

  beforeEach(() => {
    combatSystem = new CombatSystem({ defaultAttackSpeedTicks: 4 });
    mockGetPlayerEffectiveCombatParams.mockReturnValue({ attackSpeed: 4, attackRange: 10 });
    mockIsInAttackRange.mockReturnValue(true);
  });

  it('faces the target when the player is stationary this tick', () => {
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    player.isMoving = false;
    player.facing = 0; // south
    const deps = makeDeps(world, combatSystem);

    processPlayerAutoAttack(player, deps);

    // Yama (size 5 at [29,28]) is centered due north of the player at [31,25] -> facing 1024.
    expect(player.facing).toBe(1024);
  });

  it('faces the target center while the player is moving (OSRS faceEntity re-faces every tick)', () => {
    // rev-228 EntityEvent.processAfterMovement re-applies setFaceEntity(target) each tick within
    // 15 tiles, so an interacting player faces the NPC center even while moving (e.g. stepping out
    // from under it). In game the player is drawn turned toward the interacting entity, overriding
    // the movement-direction facing.
    const world = makeWorld(10);
    const player = world.getPlayer()!;
    player.isMoving = true;
    player.facing = 256; // SW — the engine's movement-direction facing for this tick
    const deps = makeDeps(world, combatSystem);

    processPlayerAutoAttack(player, deps);

    // Yama (size 5 at [29,28]) is centered due north of the player at [31,25] -> facing 1024.
    expect(player.facing).toBe(1024);
  });
});

describe('processPlayerAutoAttack - NPC initiation lockout', () => {
  it('cancels ordinary attack intent without RNG, launch events or cooldown when the target is locked', () => {
    const world = makeWorld(17, { attackBlockedUntilTick: 19 });
    const player = getRequiredPlayer(world);
    const random = vi.fn(() => 0);
    const combatSystem = new CombatSystem({ random });
    const deps = { ...makeDeps(world, combatSystem), random };
    deps.onPlayerAttackStarted = vi.fn();
    mockCalculateHitDelay.mockReturnValue(1);

    processPlayerAutoAttack(player, deps);

    expect(random).not.toHaveBeenCalled();
    expect(combatSystem.getNextAttackTick(player.id)).toBeUndefined();
    expect(world.pendingHits).toEqual([]);
    expect(deps.tickEvents.flush()).toEqual([]);
    expect(deps.onPlayerAttackStarted).not.toHaveBeenCalled();
    expect(player).toMatchObject({
      attackTarget: null,
      attackInteractionActive: false,
      manualCastSpell: null,
      autoAttackPause: null,
    });
  });

  it('preserves special energy and the armed toggle when the target is locked', () => {
    const world = makeWorld(17, { attackBlockedUntilTick: 19 });
    const player = getRequiredPlayer(world);
    player.isSpecialAttackActive = true;
    const specialAttack = { ...player.specialAttack };
    const deps = makeDeps(world, new CombatSystem());

    processPlayerAutoAttack(player, deps);

    expect(player.specialAttack).toEqual(specialAttack);
    expect(player.isSpecialAttackActive).toBe(true);
    expect(deps.tickEvents.flush()).toEqual([]);
  });

  it.each([
    false,
    true,
  ])('discards the manual spell without spending resources when locked, runes available: %s', (runesAvailable) => {
    const world = makeWorld(17, { attackBlockedUntilTick: 19 });
    const player = getRequiredPlayer(world);
    player.manualCastSpell = 'Ice Barrage';
    const random = vi.fn(() => 0);
    const consumePlayerGuaranteedMaxHit = vi.fn(() => true);
    const deps = { ...makeDeps(world, new CombatSystem()), random };
    deps.encounterRules = { consumePlayerGuaranteedMaxHit };
    if (runesAvailable) {
      deps.combatSupplies = {
        ...deps.combatSupplies,
        runePouch: {
          kind: 'standard',
          slots: [{ id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.death }],
        },
      };
    }
    const inventory = structuredClone(player.inventory);
    const supplies = structuredClone(deps.combatSupplies);

    processPlayerAutoAttack(player, deps);

    expect(player.manualCastSpell).toBeNull();
    expect(player.attackTarget).toBeNull();
    expect(player.attackInteractionActive).toBe(false);
    expect(player.inventory).toEqual(inventory);
    expect(deps.combatSupplies).toEqual(supplies);
    expect(consumePlayerGuaranteedMaxHit).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(deps.combatSystem.getNextAttackTick(player.id)).toBeUndefined();
    expect(world.pendingHits).toEqual([]);
    expect(deps.tickEvents.flush()).toEqual([]);
  });

  it('cancels through a target-specific pause and stays idle after both deadlines expire', () => {
    const world = makeWorld(17, { attackBlockedUntilTick: 19 });
    const player = getRequiredPlayer(world);
    player.manualCastSpell = 'Ice Barrage';
    player.autoAttackPause = { targetId: 'yama', resumeTick: 25 };
    const deps = makeDeps(world, new CombatSystem());

    processPlayerAutoAttack(player, deps);
    world.tick = 26;
    processPlayerAutoAttack(player, deps);

    expect(player).toMatchObject({ attackTarget: null, attackInteractionActive: false, manualCastSpell: null });
    expect(deps.tickEvents.flush()).toEqual([]);
    expect(deps.combatSystem.getNextAttackTick(player.id)).toBeUndefined();
  });

  it('retains independent deadlines when switching A-B-back and allows attacks at exact expiry', () => {
    const first = makeNpc({ id: 'first', attackBlockedUntilTick: 19 });
    const second = makeNpc({ id: 'second', attackBlockedUntilTick: 18 });
    const other = makeNpc({ id: 'other' });
    const world = makeMultiNpcWorld(17, [first, second, other]);
    const player = getRequiredPlayer(world);
    const deps = makeDeps(world, new CombatSystem());
    deps.combatParamOverrides = { attackSpeed: 1, attackRange: 10 };
    const attempts = [
      [17, first],
      [17, second],
      [17, first],
      [17, other],
      [18, first],
      [18, second],
      [19, first],
    ] as const;

    for (const [tick, target] of attempts) {
      world.tick = tick;
      player.attackTarget = target.id;
      player.attackInteractionActive = true;
      processPlayerAutoAttack(player, deps);
    }

    expect(
      deps.tickEvents
        .flush()
        .filter((event) => isCoreEvent(event, 'attack_started'))
        .map((event) => [event.tick, event.targetId]),
    ).toEqual([
      [17, 'other'],
      [18, 'second'],
      [19, 'first'],
    ]);
    expect(first.attackBlockedUntilTick).toBe(19);
    expect(second.attackBlockedUntilTick).toBe(18);
  });

  it('skips locked secondaries before the Barrage target cap and admits an expired secondary', () => {
    const primary = makeNpc({ id: 'primary', position: [30, 30] });
    const locked = makeNpc({ id: 'locked', position: [30, 30], attackBlockedUntilTick: 19 });
    const eligible = Array.from({ length: 8 }, (_, index) =>
      makeNpc({ id: `eligible-${index}`, position: [30, 30], attackBlockedUntilTick: 17 }),
    );
    const world = makeMultiNpcWorld(17, [primary, locked, ...eligible]);
    const player = getRequiredPlayer(world);
    player.manualCastSpell = 'Ice Barrage';
    mockGetFormulaStyle.mockReturnValue('magic');
    mockFormulaStyleToDamageType.mockReturnValue('magic');
    mockFormulaStyleToAttackKind.mockReturnValue('magic_shadow');
    const random = vi.fn(() => 0);
    const deps = { ...makeDeps(world, new CombatSystem()), random };
    deps.combatSupplies = {
      ...deps.combatSupplies,
      runePouch: {
        kind: 'standard',
        slots: [{ id: RUNE.water }, { id: RUNE.blood }, { id: RUNE.death }],
      },
    };

    processPlayerAutoAttack(player, deps);

    expect(
      deps.tickEvents
        .flush()
        .filter((event) => isCoreEvent(event, 'hit_applied'))
        .map((event) => event.targetId),
    ).toEqual([primary.id, ...eligible.map((target) => target.id)]);
    expect(locked.vitals.hp).toBe(1000);
    expect(random).toHaveBeenCalledTimes(18);
  });

  it('resolves already queued damage when its target becomes locked before impact', () => {
    const target = makeNpc();
    const world = makeMultiNpcWorld(16, [target]);
    const player = getRequiredPlayer(world);
    const deps = makeDeps(world, new CombatSystem());
    mockCalculateHitDelay.mockReturnValue(1);
    processPlayerAutoAttack(player, deps);
    target.attackBlockedUntilTick = 19;
    world.tick = 17;

    deps.combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      onDamageApplied: deps.onDamageApplied,
    });

    expect(deps.onDamageApplied).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: target.id, tick: 17, effectiveDamage: 11 }),
    );
    expect(world.pendingHits).toEqual([]);
  });
});

describe('processPlayerAutoAttack — target-specific pause', () => {
  it('blocks only the paused target before attack work on R+1 and R+2', () => {
    const world = makeWorld(11);
    const player = getRequiredPlayer(world);
    player.autoAttackPause = { targetId: 'yama', resumeTick: 13 };
    player.movementPath = [
      [31, 26],
      [31, 27],
    ];
    player.manualCastSpell = 'Fire Strike';
    player.selectedAttackStyleIndex = 0;
    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };
    const combatSystem = new CombatSystem({ defaultAttackSpeedTicks: 4 });
    const deps = makeDeps(world, combatSystem);
    const inventoryBefore = [...player.inventory];
    const suppliesBefore = structuredClone(deps.combatSupplies);
    deps.tickEvents.setTick(11);

    processPlayerAutoAttack(player, deps);
    world.tick = 12;
    deps.tickEvents.setTick(12);
    processPlayerAutoAttack(player, deps);

    expect(player.attackTarget).toBe('yama');
    expect(player.attackInteractionActive).toBe(true);
    expect(player.movementPath).toEqual([
      [31, 26],
      [31, 27],
    ]);
    expect(player.facing).toBe(1024);
    expect(player.manualCastSpell).toBe('Fire Strike');
    expect(player.selectedAttackStyleIndex).toBe(0);
    expect(player.isSpecialAttackActive).toBe(true);
    expect(player.specialAttack.energy).toBe(100);
    expect(player.inventory).toEqual(inventoryBefore);
    expect(deps.combatSupplies).toEqual(suppliesBefore);
    expect(combatSystem.getNextAttackTick(player.id)).toBeUndefined();
    expect(world.pendingHits).toEqual([]);
    expect(deps.tickEvents.flush().some((event) => isCoreEvent(event, 'attack_started'))).toBe(false);
  });

  it('resumes against the paused target exactly at resumeTick R+3', () => {
    const world = makeWorld(11);
    const player = getRequiredPlayer(world);
    player.autoAttackPause = { targetId: 'yama', resumeTick: 13 };
    const combatSystem = new CombatSystem({ defaultAttackSpeedTicks: 4 });
    const deps = makeDeps(world, combatSystem);

    for (const tick of [11, 12, 13]) {
      world.tick = tick;
      deps.tickEvents.setTick(tick);
      processPlayerAutoAttack(player, deps);
    }

    const attacks = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'attack_started'));
    expect(attacks.map((event) => event.tick)).toEqual([13]);
    expect(player.autoAttackPause).toBeNull();
    expect(combatSystem.getNextAttackTick(player.id)).toBe(17);
  });

  it('allows another target while retaining the unexpired target-specific pause', () => {
    const world = makeWorld(11);
    const player = getRequiredPlayer(world);
    const otherNpc = makeNpc({ id: 'other-target', position: [32, 25], size: 1 });
    world.actors.set(otherNpc.id, otherNpc);
    player.attackTarget = otherNpc.id;
    player.autoAttackPause = { targetId: 'yama', resumeTick: 13 };
    const combatSystem = new CombatSystem({ defaultAttackSpeedTicks: 4 });
    const deps = makeDeps(world, combatSystem);
    deps.tickEvents.setTick(11);

    processPlayerAutoAttack(player, deps);

    expect(deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'attack_started'))).toEqual([
      expect.objectContaining({ tick: 11, targetId: 'other-target' }),
    ]);
    expect(player.autoAttackPause).toEqual({ targetId: 'yama', resumeTick: 13 });
  });
});

describe('processPlayerAutoAttack — xp drops', () => {
  let combatSystem: CombatSystem;

  beforeEach(() => {
    combatSystem = new CombatSystem();
    mockIsInAttackRange.mockReturnValue(true);
    mockGetPlayerEffectiveCombatParams.mockReturnValue({ attackSpeed: 4, attackRange: 1 });
  });

  it('emits a grouped xp_drop with predicted hit on the attack tick', () => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    const deps = makeDeps(world, combatSystem);
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    const events = deps.tickEvents.flush();
    const drop = events.find((e) => e.type === 'xp_drop');
    expect(drop).toBeDefined();
    expect(drop).toMatchObject({
      type: 'xp_drop',
      predictedHit: 11,
      skills: [
        { skill: 'attack', amount: 44 },
        { skill: 'hitpoints', amount: 14 },
      ],
    });
    expect(player.xpCounters.attack).toBe(44);
    expect(player.xpCounters.hitpoints).toBeCloseTo(14.6667, 3);
  });

  it('does not emit xp_drop when the attack is on cooldown', () => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    const deps = makeDeps(world, combatSystem);
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps); // first attack sets cooldown
    deps.tickEvents.flush();
    world.tick = 11;
    deps.tickEvents.setTick(11);
    processPlayerAutoAttack(player, deps); // still on cooldown

    const events = deps.tickEvents.flush();
    expect(events.find((e) => e.type === 'xp_drop')).toBeUndefined();
  });

  it('scales predicted XP damage by the encounter outgoing damage multiplier', () => {
    const world = makeWorld(10);
    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: {
        outgoingDamageMultiplier: 1.5,
      },
    };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(getRequiredPlayer(world), deps);

    const events = deps.tickEvents.flush();
    const hit = events.find((e) => e.type === 'hit_applied');
    const drop = events.find((e) => e.type === 'xp_drop');
    expect(hit).toMatchObject({ type: 'hit_applied', damage: 16 });
    expect(drop).toMatchObject({
      type: 'xp_drop',
      predictedHit: 16,
      skills: [
        { skill: 'attack', amount: 64 },
        { skill: 'hitpoints', amount: 21 },
      ],
    });
  });

  it('scales predicted XP damage by the special attack damage multiplier', () => {
    const world = makeWorld(10);
    const player = getRequiredPlayer(world);
    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };
    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: {
        specialAttacks: { damageMultiplier: 1.25 },
      },
    };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);

    const events = deps.tickEvents.flush();
    const hit = events.find((e) => e.type === 'hit_applied');
    const drop = events.find((e) => e.type === 'xp_drop');
    expect(hit).toMatchObject({ type: 'hit_applied', damage: 18 });
    expect(drop).toMatchObject({
      type: 'xp_drop',
      predictedHit: 18,
      skills: [
        { skill: 'attack', amount: 72 },
        { skill: 'hitpoints', amount: 24 },
      ],
    });
  });

  it('caps predicted XP damage by target HP', () => {
    const world = makeWorld(10, { vitals: { hp: 5, maxHp: 1000 } });
    const deps = makeDeps(world, combatSystem);
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(getRequiredPlayer(world), deps);

    const events = deps.tickEvents.flush();
    const drop = events.find((e) => e.type === 'xp_drop');
    expect(drop).toMatchObject({
      type: 'xp_drop',
      predictedHit: 5,
      skills: [
        { skill: 'attack', amount: 20 },
        { skill: 'hitpoints', amount: 6 },
      ],
    });
  });
});

describe('processPlayerAutoAttack — encounter damage multipliers', () => {
  let combatSystem: CombatSystem;

  beforeEach(() => {
    combatSystem = new CombatSystem();
    mockIsInAttackRange.mockReturnValue(true);
    mockGetPlayerEffectiveCombatParams.mockReturnValue({ attackSpeed: 4, attackRange: 1 });
  });

  it('applies encounter outgoing damage multiplier to normal auto-attacks', () => {
    const world = makeWorld(10);
    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: {
        outgoingDamageMultiplier: 1.5,
      },
    };
    deps.tickEvents.setTick(10);

    const player = world.getPlayer();
    expect(player).not.toBeNull();
    if (player === null) return;
    processPlayerAutoAttack(player, deps);

    const events = deps.tickEvents.flush();
    expect(events.find((event) => isCoreEvent(event, 'hit_applied'))).toMatchObject({
      type: 'hit_applied',
      damage: 16,
    });
  });

  it('applies encounter outgoing and special damage multipliers to each multi-hit auto-attack hitsplat', () => {
    const world = makeWorld(10);
    const player = world.getPlayer();
    expect(player).not.toBeNull();
    if (player === null) return;
    player.equipment.weapon = DRAGON_DAGGER;
    player.isSpecialAttackActive = true;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };
    const deps = {
      ...makeDeps(world, combatSystem),
      encounterRules: {
        outgoingDamageMultiplier: 1.5,
        specialAttacks: { damageMultiplier: 2 },
      },
    };
    deps.tickEvents.setTick(10);

    processPlayerAutoAttack(player, deps);
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      outgoingDamageMultiplier: deps.encounterRules.outgoingDamageMultiplier,
      specDamageMultiplier: deps.encounterRules.specialAttacks.damageMultiplier,
      onDamageApplied: deps.onDamageApplied,
    });

    const hitEvents = deps.tickEvents.flush().filter((event) => isCoreEvent(event, 'hit_applied'));
    expect(hitEvents).toHaveLength(2);
    expect(hitEvents.map((event) => event.damage)).toEqual([36, 36]);
  });

  it('applies Elder maul defence drain when its delayed hit resolves', () => {
    const world = makeWorld(10);
    const player = world.getPlayer();
    const npc = world.getNpcs()[0];
    if (!player || !npc) throw new Error('Expected combat actors');
    player.equipment.weapon = 21003;
    player.equipmentStats = createEmptyStats();
    player.isSpecialAttackActive = true;
    npc.formulaStats = {
      levels: { attack: 1, strength: 1, defence: 100, ranged: 1, magic: 1 },
      offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
      defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
    };
    npc.debuffs = {};
    mockCalculateHitDelay.mockReturnValue(1);
    const deps = { ...makeDeps(world, combatSystem), random: vi.fn(() => 0) };

    processPlayerAutoAttack(player, deps);
    expect(npc.debuffs.defenceDrain).toBeUndefined();
    const pendingHit = world.pendingHits[0];
    if (!pendingHit) throw new Error('Expected delayed Elder maul hit');
    world.tick = pendingHit.impactTick;
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    expect(npc.debuffs.defenceDrain).toBe(35);
  });

  it('heals and spends energy on the Saradomin godsword special', () => {
    const world = makeWorld(10);
    const player = world.getPlayer();
    if (!player) throw new Error('Expected player');
    player.equipment.weapon = 11806;
    player.isSpecialAttackActive = true;
    player.vitals.hp = 50;
    player.stats.hitpoints.current = 50;
    player.prayerState.points = 0;
    const deps = makeDeps(world, combatSystem);

    processPlayerAutoAttack(player, deps);
    combatSystem.processPendingHits(world, {
      events: deps.tickEvents,
      infiniteHealth: deps.infiniteHealth,
      onDamageApplied: deps.onDamageApplied,
    });

    expect(player.specialAttack.energy).toBe(50);
    expect(player.vitals.hp).toBeGreaterThan(50);
    expect(player.prayerState.points).toBeGreaterThan(0);
  });

  it('does not restore defence when Elder maul follows an excessive flat drain', () => {
    const world = makeWorld(10);
    const player = world.getPlayer();
    const npc = world.getNpcs()[0];
    if (!player || !npc) throw new Error('Expected combat actors');
    npc.formulaStats = {
      levels: { attack: 1, strength: 1, defence: 10, ranged: 1, magic: 1 },
      offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
      defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
    };
    npc.debuffs = {};
    player.equipmentStats = createEmptyStats();
    const random = vi
      .fn<() => number>()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999);
    const deps = { ...makeDeps(world, combatSystem), random };
    player.equipment.weapon = 11804;
    player.isSpecialAttackActive = true;
    processPlayerAutoAttack(player, deps);
    expect(npc.debuffs.defenceDrain).toBe(13);

    world.tick = 14;
    player.equipment.weapon = 21003;
    player.isSpecialAttackActive = true;
    processPlayerAutoAttack(player, deps);

    expect(npc.debuffs.defenceDrain).toBe(13);
  });
});

describe('special attack target eligibility', () => {
  const SCORCHING_BOW = 29591;
  const DRAGON_ARROW = 11212;
  const SCORCHING_WORLD_TICK = 10;

  /** Fire the scorching bow special at a target carrying `attributes` (omit for no stat data). */
  function fireScorchingSpec(
    attributes?: readonly string[],
    manualCastSpell?: string,
  ): {
    player: PlayerActor;
    npc: NpcActor;
    world: WorldState;
  } {
    const world = makeWorld(SCORCHING_WORLD_TICK);
    const player = getRequiredPlayer(world);
    const npc = world.getNpcs()[0];
    if (!npc) throw new Error('Expected a target');
    if (attributes) {
      npc.formulaStats = {
        attributes,
        levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
        offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
        defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
      } as NpcActor['formulaStats'];
    }
    player.equipment.weapon = SCORCHING_BOW;
    player.specialAttack = { energy: 100, regenTickCounter: 50, lightbearerEquipped: false };
    player.isSpecialAttackActive = true;
    if (manualCastSpell) {
      player.manualCastSpell = manualCastSpell;
      player.inventory[0] = { id: RUNE.fire, quantity: 3 };
      player.inventory[1] = { id: RUNE.air, quantity: 2 };
      player.inventory[2] = { id: RUNE.mind, quantity: 1 };
    }

    const deps = makeDeps(world, new CombatSystem());
    // A bow with an empty ammo slot resolves to `unavailable` and returns before the spec block, so
    // the arrows are what make this a test of eligibility rather than of ammo.
    deps.combatSupplies = { ...createEmptyCombatSupplies(), equippedAmmo: { id: DRAGON_ARROW } };
    processPlayerAutoAttack(player, deps);
    return { player, npc, world };
  }

  it('fires the special and binds when the target has the required attribute', () => {
    const { player, npc } = fireScorchingSpec(['demon']);

    expect(player.specialAttack.energy).toBe(75);
    expect(npc.debuffs?.boundUntilTick).toBeGreaterThan(0);
  });

  // The absurd 99 is the point: the registry's `hitDelayTicks` has to WIN over the weapon's own
  // projectile timing, which the captures falsify for this special at footprint distances 1-2.
  it('takes its hit delay from the registry rather than the weapon', () => {
    mockCalculateHitDelay.mockReturnValue(99);

    const { world } = fireScorchingSpec(['demon']);

    expect(world.pendingHits.map((hit) => hit.impactTick)).toEqual([SCORCHING_WORLD_TICK + 3]);
  });

  // ...but a manual cast is not the weapon's attack, so the SPELL's timing outranks the registry.
  // The mocked spell delay is 0, which lands the hit outright; ordering `hitDelayTicks` above the
  // spell branches instead queues it on the bow's 3-tick schedule.
  it("yields to a manual cast's own hit delay", () => {
    const { player, world } = fireScorchingSpec(['demon'], 'Fire Strike');

    expect(player.specialAttack.energy, 'the special still fired').toBe(75);
    expect(world.pendingHits).toEqual([]);
  });

  // Scheduled AHEAD, at the cast, because the engine moves NPCs before it resolves pending hits —
  // writing the same window when the projectile lands would stop Yama two ticks late.
  it('schedules the bind window from cast+2 at the moment the special is fired', () => {
    const { npc } = fireScorchingSpec(['demon']);

    expect(npc.debuffs?.boundFromTick).toBe(SCORCHING_WORLD_TICK + 2);
    expect(npc.debuffs?.boundUntilTick).toBe(SCORCHING_WORLD_TICK + 2 + 21);
  });

  // The wiki refuses the special outright against a non-demon rather than firing an inert one, so
  // the 25% must survive. Guarding only inside the effects spends it and binds nothing.
  it('spends nothing and binds nothing when the target lacks it', () => {
    const { player, npc } = fireScorchingSpec(['dragon']);

    expect(player.specialAttack.energy).toBe(100);
    expect(npc.debuffs?.boundUntilTick).toBeUndefined();
  });

  it('treats a target with no attribute data as ineligible rather than crashing', () => {
    const { player, npc } = fireScorchingSpec();

    expect(player.specialAttack.energy).toBe(100);
    expect(npc.debuffs?.boundUntilTick).toBeUndefined();
  });
});
