import { afterEach, describe, expect, it } from 'vitest';
import { getArenaAllowUnboundedFallback, getArenaConfig, setArenaConfig } from '../../../../core/constants';
import type { EncounterModifierSelection } from '../../../../core/encounters/encounterFactory';
import type {
  EncounterEngineContext,
  EncounterEngineRules,
  EncounterPlayerDamageInfo,
} from '../../../../core/encounters/types';
import { SimulationEngine } from '../../../../core/SimulationEngine';
import { createUnusedPlayerControlOps } from '../../../../test/helpers/playerControlStubs';
import { createDefaultStats } from '../../../../types/playerState';
import { type Coordinate, type MechanicsConfig, PrayerType } from '../../../../types/simulation';
import { LobbyEncounter } from '../../../lobby/LobbyEncounter';
import { BEES_DAMAGE_SOURCE } from '../bees';
import { ColosseumModifierState } from '../rules';
import { SOLARFLARE_DAMAGE_SOURCE } from '../solarflare';
import { VOLATILITY_DAMAGE_SOURCE } from '../volatility';

const arena = getArenaConfig();
const unbounded = getArenaAllowUnboundedFallback();
afterEach(() => setArenaConfig(arena, unbounded));

class ModifierEncounter extends LobbyEncounter {
  readonly modifiers: ColosseumModifierState;
  constructor(selection: EncounterModifierSelection) {
    super();
    this.modifiers = new ColosseumModifierState(selection);
  }
  getEngineRules(): EncounterEngineRules {
    return this.modifiers.getEngineRules();
  }
  configureRunStart(mechanics: Readonly<Partial<MechanicsConfig>>): void {
    this.modifiers.configureRunStart(mechanics);
  }
  override reset(): void {
    this.modifiers.reset();
  }
}

function setup(selection: EncounterModifierSelection = {}, hp = 99) {
  const encounter = new ModifierEncounter(selection);
  const stats = createDefaultStats();
  stats.hitpoints = { current: hp, max: hp };
  const engine = new SimulationEngine({ encounter, stats, enableIntro: false });
  const world = engine['worldState'];
  const player = world.getPlayer()!;
  const ctx: EncounterEngineContext = { tick: 1, player, world };
  const hit = (damage: number) => engine['applyDamage'](damage, 'typeless', 'TestHazard', world.tick);
  return { encounter, engine, world, player, ctx, hit };
}

function damage(effectiveDamage: number): EncounterPlayerDamageInfo {
  return {
    sourceKind: 'combat',
    source: 'TestEnemy',
    tick: 1,
    attackType: 'typeless',
    baseDamage: effectiveDamage,
    effectiveDamage,
    prayedCorrectly: null,
    hpBefore: 99,
    hpAfter: 99 - effectiveDamage,
  };
}

describe('Doom', () => {
  it('counts each positive hit, including multiple hits on one tick, but not zeroes', () => {
    const { encounter, hit, engine } = setup({ doom: 1 });
    hit(0);
    hit(1);
    hit(2);
    hit(0);
    expect(encounter.modifiers.doomStacks).toBe(2);
    expect(engine['tickEvents'].flush().filter((event) => event.type === 'hitsplat_spawned')).toMatchObject([
      { amount: 0, hitsplatType: 'block' },
      { amount: 1, hitsplatType: 'damage' },
      { amount: 1, hitsplatType: 'doom' },
      { amount: 2, hitsplatType: 'damage' },
      { amount: 2, hitsplatType: 'doom' },
      { amount: 0, hitsplatType: 'block' },
    ]);
    encounter.reset();
    expect(encounter.modifiers.doomStacks).toBe(0);
  });

  it.each([
    [1, 15],
    [2, 10],
    [3, 5],
  ] as const)('Doom %i reports each stack out of %i in chat', (doom, lethal) => {
    const { hit, engine } = setup({ doom });
    hit(0);
    hit(3);
    hit(4);
    const lines = engine['tickEvents'].flush().filter((event) => event.type === 'game_message');
    expect(lines).toMatchObject(
      [1, 2].map((stacks) => ({
        kind: 'game',
        segments: [
          { text: 'You now have ' },
          { text: `${stacks}/${lethal} points`, color: '#ff3045' },
          { text: ' of ' },
          { text: 'doom!', color: '#ff3045' },
        ],
      })),
    );
  });

  it.each([
    [1, 15],
    [2, 10],
    [3, 5],
  ] as const)('kills at tier %i threshold %i', (doom, threshold) => {
    const { engine, hit, player } = setup({ doom });
    for (let n = 1; n < threshold; n++) hit(1);
    expect(player.alive).toBe(true);
    hit(1);
    expect(player.alive).toBe(false);
    expect(engine.getState().failedCondition).toBe('Doom');
  });

  it.each(['poison', 'venom'] as const)('ignores %s pulses for both Doom and Blasphemy', (type) => {
    const { encounter, engine, world, player } = setup({ doom: 1, blasphemy: 3 });
    player.prayerState.points = 99;
    engine['applyDamage'](6, 'typeless', 'Poison', world.tick, undefined, undefined, type);
    expect(encounter.modifiers.doomStacks).toBe(0);
    expect(player.prayerState.points).toBe(99);
    expect(player.vitals.hp).toBe(93);
  });

  it('keeps stacking without killing when infinite health is enabled', () => {
    const { encounter, engine, hit, player } = setup({ doom: 3 });
    engine.setMechanicsConfig({ infiniteHealth: true });
    for (let n = 0; n < 8; n++) hit(10);
    expect(encounter.modifiers.doomStacks).toBe(8);
    expect(player.alive).toBe(true);
    expect(player.vitals.hp).toBe(99);
  });
});

describe('Blasphemy', () => {
  it.each([
    SOLARFLARE_DAMAGE_SOURCE,
    VOLATILITY_DAMAGE_SOURCE,
    BEES_DAMAGE_SOURCE,
  ])('excludes %s prayer drain without excluding Doom (A:3487/4026)', (source) => {
    const { engine, encounter, player } = setup({ doom: 1, blasphemy: 3 });
    engine['applyEnvironmentalDamage']({ baseDamage: 20, attackType: 'typeless', source }, 0);
    expect(player.prayerState.points).toBe(99);
    expect(encounter.modifiers.doomStacks).toBe(1);
  });

  it.each([
    [1, 33, 6],
    [2, 33, 12],
    [3, 33, 18],
    [3, 36, 21],
    [3, 44, 24],
    [3, 7, 3],
    [3, 9, 3],
    [3, 23, 12],
    [3, 20, 12],
    [3, 13, 6],
    [3, 15, 9],
    [3, 35, 21],
    [3, 25, 15],
    [3, 3, 0],
    [3, 0, 0],
  ] as const)('tier %i drains %i damage as %i prayer', (blasphemy, dealt, drain) => {
    const { hit, player } = setup({ blasphemy });
    player.prayerState.points = 99;
    hit(dealt);
    expect(player.prayerState.points).toBe(99 - drain);
    expect(player.stats.prayer.current).toBe(99 - drain);
  });

  it('runs normal prayer depletion once and clears all prayer/quick-prayer state', () => {
    const { engine, hit, player } = setup({ blasphemy: 3 });
    player.prayerState.points = 9;
    player.activePrayer = PrayerType.ProtectMelee;
    player.boostPrayers = [PrayerType.Piety];
    player.independentPrayers = [PrayerType.Preserve];
    player.quickPrayersActive = true;
    hit(15);
    hit(1);
    expect(player.prayerState).toMatchObject({
      points: 0,
      drainCounter: 0,
      activePrayers: [],
      prayerActivationTicks: {},
    });
    expect(player.activePrayer).toBeNull();
    expect(player.boostPrayers).toEqual([]);
    expect(player.independentPrayers).toEqual([]);
    expect(player.quickPrayersActive).toBe(false);
    expect(engine['tickEvents'].flush().filter((event) => event.type === 'prayer_depleted')).toHaveLength(1);
  });
});

describe('Frailty', () => {
  it.each([
    [1, 99, 90],
    [2, 99, 80],
    [3, 99, 60],
    [1, 100, 90],
  ] as const)('tier %i reduces base %i HP to %i and blocks overheal', (frailty, base, expected) => {
    const { encounter, player } = setup({ frailty }, base);
    expect(player.vitals).toEqual({ hp: expected, maxHp: expected });
    expect(player.stats.hitpoints).toEqual({ current: expected, max: expected });
    expect(encounter.getEngineRules().itemRestrictions?.blockOverheal).toBe(true);
  });
});

describe('Myopia', () => {
  it.each([1, 2, 3] as const)('reduces ranged and autocast reach at tier %i with a minimum of one', (myopia) => {
    const { encounter, player, ctx } = setup({ myopia });
    const modify = encounter.getEngineRules().modifyPlayerCombatParams!;
    for (const [weapon, style] of [
      [12926, 0],
      [4675, 4],
      [27275, 0],
    ]) {
      player.equipment.weapon = weapon;
      player.selectedAttackStyleIndex = style!;
      expect(modify({ attackSpeed: 5, attackRange: 10 }, ctx)).toEqual({
        attackSpeed: 5,
        attackRange: 10 - 2 * myopia,
      });
      expect(modify({ attackSpeed: 5, attackRange: 2 }, ctx).attackRange).toBe(1);
    }
  });

  it('does not reduce manual casts or non-halberd melee reach', () => {
    const { encounter, player, ctx } = setup({ myopia: 3 });
    const modify = encounter.getEngineRules().modifyPlayerCombatParams!;
    player.equipment.weapon = 12926;
    player.manualCastSpell = 'Wind Strike';
    expect(modify({ attackSpeed: 5, attackRange: 10 }, ctx).attackRange).toBe(10);
    player.manualCastSpell = null;
    player.equipment.weapon = 4151;
    expect(modify({ attackSpeed: 4, attackRange: 2 }, ctx).attackRange).toBe(2);
  });

  it.each([1, 2, 3] as const)('gives halberds diagonal-capable range 1 at tier %i from any tile', (myopia) => {
    const { encounter, player, ctx } = setup({ myopia });
    const modify = encounter.getEngineRules().modifyPlayerCombatParams!;
    for (const weapon of [23987, 29796]) {
      player.equipment.weapon = weapon;
      for (const position of [
        [29, 29],
        [28, 28],
        [29, 30],
      ] as Coordinate[]) {
        player.position = position;
        expect(modify({ attackSpeed: 7, attackRange: 2 }, ctx)).toEqual({
          attackSpeed: 7,
          attackRange: 1,
          meleeReach: 'diagonal',
        });
      }
    }
  });
});

it('has no rules or per-hit state when no simulated modifiers are selected', () => {
  expect(new ColosseumModifierState({ solarflare: 1, volatility: 3 }).getEngineRules()).toEqual({});
});

it('counts combat and environment events alike without coupling rules to an encounter', () => {
  const { lockPlayerActionsUntil } = createUnusedPlayerControlOps();
  const ctx = { ...setup().ctx, lockPlayerActionsUntil };
  const modifiers = new ColosseumModifierState({ doom: 1, blasphemy: 3 });
  const hook = modifiers.getEngineRules().onPlayerDamageTaken!;
  expect(hook(damage(15), ctx)).toMatchObject({ prayerPointsDelta: -9, playerHitsplats: [{ amount: 1 }] });
  expect(hook({ ...damage(35), sourceKind: 'environment' }, ctx)).toMatchObject({
    prayerPointsDelta: -21,
    playerHitsplats: [{ amount: 2 }],
  });
});
