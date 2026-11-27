import { describe, expect, it } from 'vitest';
import {
  type CombatTimers,
  createDefaultStats,
  createDefaultTimers,
  type PlayerStats,
  PRESERVE_QUALIFY_TICKS,
  STAT_DECAY_CYCLE_TICKS,
} from '../../types/playerState';
import { PRAYER_DRAIN_EFFECTS, type PrayerState, PrayerType } from '../../types/simulation';
import { expireStatDecayLocks, tickNaturalHitpoints, tickNaturalStatChange } from '../statLevels';
import { isPreserveQualified, isRapidRestoreDue, tickPrayerDrain } from '../timers';

function createState(overrides: Partial<PrayerState> = {}): PrayerState {
  return {
    points: 99,
    maxPoints: 99,
    drainCounter: 0,
    activePrayers: [],
    prayerActivationTicks: {},
    ...overrides,
  };
}

describe('tickPrayerDrain', () => {
  describe('basic drain behavior', () => {
    it('does not drain when no prayers are active', () => {
      const state = createState();
      const result = tickPrayerDrain(state, 0, 10);
      expect(result.drained).toBe(false);
      expect(result.state.points).toBe(99);
    });

    it('does not drain when prayer points are already 0', () => {
      const state = createState({
        points: 0,
        activePrayers: [PrayerType.ProtectMagic],
        prayerActivationTicks: { [PrayerType.ProtectMagic]: 5 },
      });
      const result = tickPrayerDrain(state, 0, 10);
      expect(result.drained).toBe(false);
    });

    it('accumulates drain for prayers active from a previous tick', () => {
      const state = createState({
        activePrayers: [PrayerType.ProtectMagic],
        prayerActivationTicks: { [PrayerType.ProtectMagic]: 5 },
      });
      // drainEffect = 12, resistance = 60 (no prayer bonus)
      // After 1 tick: counter = 12, < 60 → no point lost yet
      const result = tickPrayerDrain(state, 0, 10);
      expect(result.state.points).toBe(99);
      expect(result.state.drainCounter).toBe(12);
    });

    it('drains a point when counter exceeds resistance', () => {
      const state = createState({
        drainCounter: 55, // Just under 60
        activePrayers: [PrayerType.ProtectMagic],
        prayerActivationTicks: { [PrayerType.ProtectMagic]: 5 },
      });
      // counter = 55 + 12 = 67, >= 60 → drain 1 point, counter = 67 - 60 = 7
      const result = tickPrayerDrain(state, 0, 10);
      expect(result.state.points).toBe(98);
      expect(result.state.drainCounter).toBe(7);
    });

    it('deactivates all prayers when points reach 0', () => {
      const state = createState({
        points: 1,
        drainCounter: 55,
        activePrayers: [PrayerType.ProtectMagic, PrayerType.Piety],
        prayerActivationTicks: { [PrayerType.ProtectMagic]: 1, [PrayerType.Piety]: 1 },
      });
      // drain = 12 + 24 = 36; counter = 55 + 36 = 91; >= 60 → drain 1 → points = 0
      const result = tickPrayerDrain(state, 0, 10);
      expect(result.drained).toBe(true);
      expect(result.state.points).toBe(0);
      expect(result.state.activePrayers).toEqual([]);
      expect(result.state.prayerActivationTicks).toEqual({});
    });
  });

  describe('activation-tick grace period', () => {
    it('does NOT drain a prayer activated on the current tick', () => {
      const currentTick = 10;
      const state = createState({
        activePrayers: [PrayerType.ProtectMagic],
        prayerActivationTicks: { [PrayerType.ProtectMagic]: currentTick },
      });

      const result = tickPrayerDrain(state, 0, currentTick);
      expect(result.state.points).toBe(99);
      expect(result.state.drainCounter).toBe(0);
      expect(result.drained).toBe(false);
    });

    it('drains a prayer activated on the PREVIOUS tick', () => {
      const currentTick = 11;
      const state = createState({
        activePrayers: [PrayerType.ProtectMagic],
        prayerActivationTicks: { [PrayerType.ProtectMagic]: 10 },
      });

      const result = tickPrayerDrain(state, 0, currentTick);
      // drainEffect = 12, should be applied
      expect(result.state.drainCounter).toBe(12);
    });

    it('skips drain for ALL prayers activated on the current tick', () => {
      const currentTick = 10;
      const state = createState({
        activePrayers: [PrayerType.ProtectMagic, PrayerType.Piety],
        prayerActivationTicks: {
          [PrayerType.ProtectMagic]: currentTick,
          [PrayerType.Piety]: currentTick,
        },
      });

      const result = tickPrayerDrain(state, 0, currentTick);
      expect(result.state.points).toBe(99);
      expect(result.state.drainCounter).toBe(0);
    });

    it('only grace-skips prayers activated this tick; older prayers still drain', () => {
      const currentTick = 10;
      const state = createState({
        activePrayers: [PrayerType.ProtectMagic, PrayerType.Piety],
        prayerActivationTicks: {
          [PrayerType.ProtectMagic]: currentTick, // Freshly activated → grace
          [PrayerType.Piety]: 5, // Old → drains
        },
      });

      const result = tickPrayerDrain(state, 0, currentTick);
      // Only Piety's drain effect (24) should be applied
      expect(result.state.drainCounter).toBe(PRAYER_DRAIN_EFFECTS[PrayerType.Piety]);
    });

    it('grace period lasts exactly one tick', () => {
      const activationTick = 10;

      // Tick 10: activated this tick → no drain
      const state1 = createState({
        activePrayers: [PrayerType.Piety],
        prayerActivationTicks: { [PrayerType.Piety]: activationTick },
      });
      const r1 = tickPrayerDrain(state1, 0, activationTick);
      expect(r1.state.drainCounter).toBe(0);

      // Tick 11: one tick later → drains
      const r2 = tickPrayerDrain(r1.state, 0, activationTick + 1);
      expect(r2.state.drainCounter).toBe(PRAYER_DRAIN_EFFECTS[PrayerType.Piety]);
    });

    it('prayer with no activation tick entry drains normally', () => {
      const state = createState({
        activePrayers: [PrayerType.ProtectMagic],
        prayerActivationTicks: {},
      });

      const result = tickPrayerDrain(state, 0, 10);
      expect(result.state.drainCounter).toBe(PRAYER_DRAIN_EFFECTS[PrayerType.ProtectMagic]);
    });
  });

  describe('ranged and magic offensive prayers', () => {
    it.each([
      [PrayerType.EagleEye],
      [PrayerType.MysticMight],
      [PrayerType.Deadeye],
      [PrayerType.MysticVigour],
    ])('drains %s at 12 per tick', (prayer) => {
      expect(PRAYER_DRAIN_EFFECTS[prayer]).toBe(12);
    });

    it('accumulates that rate through a real drain tick', () => {
      const state = createState({
        activePrayers: [PrayerType.Deadeye],
        prayerActivationTicks: { [PrayerType.Deadeye]: 5 },
      });

      const result = tickPrayerDrain(state, 0, 10);
      expect(result.state.drainCounter).toBe(12);
      expect(result.state.points).toBe(99);
    });
  });

  it('drains Zeal at the same effect of 24 as Piety', () => {
    expect(PRAYER_DRAIN_EFFECTS[PrayerType.Zeal]).toBe(24);
    const state = createState({
      activePrayers: [PrayerType.Zeal],
      prayerActivationTicks: { [PrayerType.Zeal]: 5 },
    });
    const result = tickPrayerDrain(state, 0, 10);
    expect(result.state.drainCounter).toBe(24);
    expect(result.state.points).toBe(99);
  });

  describe('1-tick prayer flicking (multi-tick simulation)', () => {
    it('flicking every tick results in zero drain across many ticks', () => {
      let state = createState();
      const prayerBonus = 0;

      for (let tick = 1; tick <= 20; tick++) {
        // Simulate flick: prayer is activated on this tick (off→on between ticks)
        state = {
          ...state,
          activePrayers: [PrayerType.ProtectMagic, PrayerType.Piety],
          prayerActivationTicks: {
            [PrayerType.ProtectMagic]: tick,
            [PrayerType.Piety]: tick,
          },
        };

        const result = tickPrayerDrain(state, prayerBonus, tick);
        state = result.state;

        expect(result.state.points).toBe(99);
        expect(result.state.drainCounter).toBe(0);
      }
    });

    it('NOT flicking (prayer stays on) causes drain over time', () => {
      const activationTick = 1;
      let state = createState({
        activePrayers: [PrayerType.ProtectMagic, PrayerType.Piety],
        prayerActivationTicks: {
          [PrayerType.ProtectMagic]: activationTick,
          [PrayerType.Piety]: activationTick,
        },
      });
      const prayerBonus = 0;

      // Tick 1: grace period → no drain
      const r1 = tickPrayerDrain(state, prayerBonus, 1);
      expect(r1.state.points).toBe(99);
      expect(r1.state.drainCounter).toBe(0);

      // Tick 2+: drain accumulates (12 + 24 = 36 per tick, resistance = 60)
      state = r1.state;
      const r2 = tickPrayerDrain(state, prayerBonus, 2);
      expect(r2.state.drainCounter).toBe(36);
      expect(r2.state.points).toBe(99);

      state = r2.state;
      const r3 = tickPrayerDrain(state, prayerBonus, 3);
      // 36 + 36 = 72 >= 60 → drain 1 point, counter = 12
      expect(r3.state.points).toBe(98);
      expect(r3.state.drainCounter).toBe(12);
    });

    it('partial flick: only toggled prayers avoid drain', () => {
      const currentTick = 10;
      const state = createState({
        activePrayers: [PrayerType.ProtectMagic, PrayerType.Piety],
        prayerActivationTicks: {
          [PrayerType.ProtectMagic]: currentTick, // Flicked this tick
          [PrayerType.Piety]: 5, // NOT flicked
        },
        drainCounter: 50,
      });

      const result = tickPrayerDrain(state, 0, currentTick);
      // Only Piety drains: counter = 50 + 24 = 74 >= 60 → drain 1, counter = 14
      expect(result.state.points).toBe(98);
      expect(result.state.drainCounter).toBe(14);
    });
  });

  describe('encounter modifiers with grace period', () => {
    it('drain multiplier applies only to non-grace prayers', () => {
      const currentTick = 10;
      const state = createState({
        activePrayers: [PrayerType.ProtectMagic, PrayerType.Piety],
        prayerActivationTicks: {
          [PrayerType.ProtectMagic]: currentTick, // Grace
          [PrayerType.Piety]: 5, // Drains
        },
      });

      const result = tickPrayerDrain(state, 0, currentTick, { drainMultiplier: 2 });
      // Piety drain = 24, after multiplier = floor(24 * 2) = 48
      expect(result.state.drainCounter).toBe(48);
    });

    it('all prayers in grace period → zero drain even with encounter modifiers', () => {
      const currentTick = 10;
      const state = createState({
        activePrayers: [PrayerType.ProtectMagic, PrayerType.Piety],
        prayerActivationTicks: {
          [PrayerType.ProtectMagic]: currentTick,
          [PrayerType.Piety]: currentTick,
        },
      });

      const result = tickPrayerDrain(state, 0, currentTick, { drainMultiplier: 3 });
      // All in grace → totalDrainEffect = 0 → early return
      expect(result.state.points).toBe(99);
      expect(result.state.drainCounter).toBe(0);
    });
  });

  describe('prayer bonus interaction', () => {
    it('prayer bonus increases resistance, slowing drain', () => {
      const state = createState({
        activePrayers: [PrayerType.Piety],
        prayerActivationTicks: { [PrayerType.Piety]: 1 },
        drainCounter: 55,
      });

      // No bonus: resistance = 60, counter = 55 + 24 = 79 >= 60 → drain
      const r1 = tickPrayerDrain(state, 0, 10);
      expect(r1.state.points).toBe(98);

      // With +20 prayer bonus: resistance = 2*20+60 = 100
      // counter = 55 + 24 = 79 < 100 → no drain
      const r2 = tickPrayerDrain(state, 20, 10);
      expect(r2.state.points).toBe(99);
      expect(r2.state.drainCounter).toBe(79);
    });
  });
});

describe('prayer drain rates', () => {
  // OSRS drain effects on the wiki's scale, where a Protect prayer is 12 and Piety is 24.
  // Redemption 6 = 1 point per 10 ticks; Preserve 2 = 1 point per 30 ticks, both at 0 bonus.
  it.each([
    [PrayerType.Redemption, 6, 10],
    [PrayerType.Preserve, 2, 30],
  ])('drains %s one point every %i-effect tick cycle', (prayer, effect, ticksPerPoint) => {
    expect(PRAYER_DRAIN_EFFECTS[prayer]).toBe(effect);

    let state = createState({ activePrayers: [prayer], prayerActivationTicks: { [prayer]: 0 } });
    for (let tick = 1; tick < ticksPerPoint; tick += 1) {
      state = tickPrayerDrain(state, 0, tick).state;
      expect(state.points).toBe(99);
    }
    expect(tickPrayerDrain(state, 0, ticksPerPoint).state.points).toBe(98);
  });

  it('drains an independent prayer alongside an overhead and an offensive prayer', () => {
    const state = createState({
      drainCounter: 21,
      activePrayers: [PrayerType.ProtectMelee, PrayerType.Piety, PrayerType.Preserve],
      prayerActivationTicks: {
        [PrayerType.ProtectMelee]: 0,
        [PrayerType.Piety]: 0,
        [PrayerType.Preserve]: 0,
      },
    });

    // 12 + 24 + 2 = 38; 21 + 38 = 59 < 60, so the extra 2 is the whole of what Preserve adds.
    expect(tickPrayerDrain(state, 0, 5).state.drainCounter).toBe(59);
  });

  it('sums every lit boost prayer: three single-stat prayers beside an overhead', () => {
    const lit = [
      PrayerType.ProtectMelee,
      PrayerType.SteelSkin,
      PrayerType.SuperhumanStrength,
      PrayerType.ClarityOfThought,
    ];
    const state = createState({
      activePrayers: lit,
      prayerActivationTicks: Object.fromEntries(lit.map((prayer) => [prayer, 0])),
    });

    // 12 + 12 + 6 + 1 = 31 per tick (https://oldschool.runescape.wiki/w/Prayer?oldid=15411470).
    const first = tickPrayerDrain(state, 0, 5).state;
    expect(first.drainCounter).toBe(31);
    const second = tickPrayerDrain(first, 0, 6).state;
    expect(second.points).toBe(98);
    expect(second.drainCounter).toBe(2);
  });
});

describe('isPreserveQualified', () => {
  const lit = (activationTick: number): PrayerState =>
    createState({
      activePrayers: [PrayerType.Preserve],
      prayerActivationTicks: { [PrayerType.Preserve]: activationTick },
    });

  it('requires Preserve to be lit at all', () => {
    expect(isPreserveQualified(createState(), 500)).toBe(false);
  });

  it('qualifies only once it has burned for the full 25 ticks', () => {
    expect(isPreserveQualified(lit(0), PRESERVE_QUALIFY_TICKS - 1)).toBe(false);
    expect(isPreserveQualified(lit(0), PRESERVE_QUALIFY_TICKS)).toBe(true);
  });

  it('restarts the 25 ticks after a flick, so a late toggle cannot buy the extension', () => {
    // Lit at 90 and checked at 100: 10 ticks of credit, not the 100 a naive "is it on" read gives.
    expect(isPreserveQualified(lit(90), 100)).toBe(false);
    expect(isPreserveQualified(lit(75), 100)).toBe(true);
  });
});

describe('isRapidRestoreDue', () => {
  const lit = (activationTick: number): PrayerState =>
    createState({
      activePrayers: [PrayerType.RapidRestore],
      prayerActivationTicks: { [PrayerType.RapidRestore]: activationTick },
    });

  it('fires every 100 ticks counted from the tick it was lit, never on the activation tick', () => {
    expect(isRapidRestoreDue(lit(37), 37)).toBe(false);
    expect(isRapidRestoreDue(lit(37), 136)).toBe(false);
    expect(isRapidRestoreDue(lit(37), 137)).toBe(true);
    expect(isRapidRestoreDue(lit(37), 237)).toBe(true);
    expect(isRapidRestoreDue(lit(37), 200)).toBe(false);
  });

  it('does not fire while dark, or when the stamp is missing', () => {
    expect(isRapidRestoreDue(createState(), 100)).toBe(false);
    expect(isRapidRestoreDue(createState({ activePrayers: [PrayerType.RapidRestore] }), 100)).toBe(false);
  });

  it('drains one point every 60 ticks at +0 prayer bonus, half as fast as Preserve', () => {
    expect(PRAYER_DRAIN_EFFECTS[PrayerType.RapidRestore]).toBe(1);
    let state = lit(0);
    for (let tick = 1; tick < 60; tick += 1) state = tickPrayerDrain(state, 0, tick).state;
    expect(state.points).toBe(99);
    expect(tickPrayerDrain(state, 0, 60).state.points).toBe(98);
  });
});

describe('Rapid Heal drain', () => {
  it('drains one point every 30 ticks at +0 prayer bonus, the same as Preserve', () => {
    expect(PRAYER_DRAIN_EFFECTS[PrayerType.RapidHeal]).toBe(2);
    let state = createState({
      activePrayers: [PrayerType.RapidHeal],
      prayerActivationTicks: { [PrayerType.RapidHeal]: 0 },
    });
    for (let tick = 1; tick < 30; tick += 1) state = tickPrayerDrain(state, 0, tick).state;
    expect(state.points).toBe(99);
    expect(tickPrayerDrain(state, 0, 30).state.points).toBe(98);
  });
});

describe('tickNaturalHitpoints', () => {
  it('moves Hitpoints 1 toward max when due and books the next deadline from this tick', () => {
    expect(tickNaturalHitpoints(50, 99, 101, 101, false)).toEqual({ hp: 51, regenTick: 201 });
    expect(tickNaturalHitpoints(110, 99, 101, 101, false)).toEqual({ hp: 109, regenTick: 201 });
  });

  it('changes nothing at max, but still moves the deadline on', () => {
    expect(tickNaturalHitpoints(99, 99, 101, 101, false)).toEqual({ hp: 99, regenTick: 201 });
  });

  it('waits for the deadline', () => {
    expect(tickNaturalHitpoints(50, 99, 101, 100, false)).toEqual({ hp: 50, regenTick: 101 });
  });

  it('books a 50-tick interval while Rapid Heal is lit, for healing and overheal loss alike', () => {
    expect(tickNaturalHitpoints(50, 99, 80, 80, true)).toEqual({ hp: 51, regenTick: 130 });
    expect(tickNaturalHitpoints(110, 99, 80, 80, true)).toEqual({ hp: 109, regenTick: 130 });
  });

  it('uses the live max, whatever it is', () => {
    expect(tickNaturalHitpoints(15, 15, 101, 101, false).hp).toBe(15);
    expect(tickNaturalHitpoints(16, 15, 101, 101, false).hp).toBe(15);
  });
});

describe('tickNaturalStatChange', () => {
  function statsWith(levels: Partial<Record<keyof PlayerStats, number>>): PlayerStats {
    const stats = createDefaultStats();
    for (const [stat, current] of Object.entries(levels)) {
      stats[stat as keyof PlayerStats] = { current: current as number, max: 99 };
    }
    return stats;
  }

  function run(
    stats: PlayerStats,
    fromTick: number,
    toTick: number,
    options: { preserve?: boolean; rapidRestoreDueAt?: (tick: number) => boolean; timers?: CombatTimers } = {},
  ): { stats: PlayerStats; timers: CombatTimers; changes: Map<number, PlayerStats> } {
    let timers = options.timers ?? createDefaultTimers();
    const changes = new Map<number, PlayerStats>();
    for (let tick = fromTick; tick <= toTick; tick += 1) {
      const result = tickNaturalStatChange(
        stats,
        timers,
        tick,
        options.preserve ?? false,
        options.rapidRestoreDueAt?.(tick) ?? false,
      );
      if (COMBAT.some((skill) => result.stats[skill].current !== stats[skill].current)) changes.set(tick, result.stats);
      stats = result.stats;
      timers = result.timers;
    }
    return { stats, timers, changes };
  }

  const COMBAT = ['attack', 'strength', 'defence', 'ranged', 'magic'] as const;

  it('decays a boost and recovers a drain by one on the same 100-tick boundary', () => {
    const result = tickNaturalStatChange(
      statsWith({ strength: 118, ranged: 55 }),
      createDefaultTimers(),
      100,
      false,
      false,
    );

    expect(result.stats.strength.current).toBe(117);
    expect(result.stats.ranged.current).toBe(56);
    expect(result.timers.statBoostDecayTick).toBe(100 + STAT_DECAY_CYCLE_TICKS);
    expect(result.timers.statRecoveryTick).toBe(200);
    expect(result.timers.statBoostDecayExtended).toBe(false);
  });

  it('decays an Agility boost on the combat decay cycle, and Preserve postpones it', () => {
    const plain = tickNaturalStatChange(statsWith({ agility: 104 }), createDefaultTimers(), 100, false, false);
    const preserved = tickNaturalStatChange(statsWith({ agility: 104 }), createDefaultTimers(), 100, true, false);

    expect(plain.stats.agility.current).toBe(103);
    expect(preserved.stats.agility.current).toBe(104);
    expect(preserved.timers.statBoostDecayTick).toBe(150);
  });

  it('decays a boosted Agility while a drained combat skill recovers on the same boundary', () => {
    const result = tickNaturalStatChange(
      statsWith({ agility: 104, ranged: 60 }),
      createDefaultTimers(),
      100,
      false,
      false,
    );

    expect(result.stats.agility.current).toBe(103);
    expect(result.stats.ranged.current).toBe(61);
  });

  it('keeps decay locks combat-only: a divine lock does not hold an Agility boost', () => {
    const timers: CombatTimers = {
      ...createDefaultTimers(),
      statDecayLocks: { attack: { ticksRemaining: 300, source: 'divine' } },
    };

    const result = tickNaturalStatChange(statsWith({ attack: 118, agility: 104 }), timers, 100, false, false);

    expect(result.stats.attack.current).toBe(118);
    expect(result.stats.agility.current).toBe(103);
  });

  it('recovers drained Agility on the recovery cycle', () => {
    const result = tickNaturalStatChange(statsWith({ agility: 70 }), createDefaultTimers(), 100, false, false);

    expect(result.stats.agility.current).toBe(71);
  });

  it('adds Rapid Restore to a coincident Agility recovery, capped at base', () => {
    const result = tickNaturalStatChange(
      statsWith({ agility: 70, attack: 98 }),
      createDefaultTimers(),
      100,
      false,
      true,
    );

    expect(result.stats.agility.current).toBe(72);
    expect(result.stats.attack.current).toBe(99);
  });

  it('never touches Hitpoints or Prayer, drained or boosted, even with recovery and Rapid Restore due', () => {
    for (const levels of [
      { hitpoints: 120, prayer: 40 },
      { hitpoints: 50, prayer: 105 },
    ]) {
      const result = tickNaturalStatChange(statsWith(levels), createDefaultTimers(), 100, false, true);

      expect(result.stats.hitpoints.current).toBe(levels.hitpoints);
      expect(result.stats.prayer.current).toBe(levels.prayer);
    }
  });

  it('keeps both cycles running while nothing needs moving', () => {
    const result = run(createDefaultStats(), 0, 250);

    expect(result.timers.statBoostDecayTick).toBe(300);
    expect(result.timers.statRecoveryTick).toBe(300);
  });

  it('postpones the DUE decay by 50 under a qualified Preserve instead of taking the level', () => {
    // Wiki rev 15227349: for a boosted stat "that would normally drain, Preserve will extend the
    // time to drain by another 30 seconds". The level survives this check entirely.
    const result = tickNaturalStatChange(statsWith({ strength: 118 }), createDefaultTimers(), 100, true, false);

    expect(result.stats.strength.current).toBe(118);
    expect(result.timers.statBoostDecayTick).toBe(150);
    expect(result.timers.statBoostDecayExtended).toBe(true);
  });

  it('takes the level at the postponed check, then books a fresh 100-tick cycle', () => {
    const timers = { ...createDefaultTimers(), statBoostDecayTick: 150, statBoostDecayExtended: true };

    const result = tickNaturalStatChange(statsWith({ strength: 118 }), timers, 150, true, false);

    expect(result.stats.strength.current).toBe(117);
    expect(result.timers.statBoostDecayTick).toBe(250);
    expect(result.timers.statBoostDecayExtended).toBe(false);
  });

  it('spaces decays 150 ticks apart under Preserve while recovery keeps its plain 100', () => {
    const result = run(statsWith({ strength: 118, attack: 80 }), 0, 320, { preserve: true });

    expect(result.changes.get(150)?.strength.current).toBe(117);
    expect(result.stats.strength.current).toBe(116); // decays at 150 and 300
    expect(result.stats.attack.current).toBe(83); // recovers at 100, 200 and 300
    expect([...result.changes.keys()]).toEqual([100, 150, 200, 300]);
  });

  it('leaves levels alone before the scheduled tick', () => {
    const result = tickNaturalStatChange(
      statsWith({ strength: 118, ranged: 55 }),
      createDefaultTimers(),
      99,
      true,
      false,
    );

    expect(result.stats.strength.current).toBe(118);
    expect(result.stats.ranged.current).toBe(55);
    expect(result.timers.statBoostDecayTick).toBe(100);
    expect(result.timers.statRecoveryTick).toBe(100);
  });

  it('adds Rapid Restore on top of a recovery on the same tick, capped at base', () => {
    const result = tickNaturalStatChange(statsWith({ ranged: 55, magic: 98 }), createDefaultTimers(), 100, false, true);

    expect(result.stats.ranged.current).toBe(57);
    expect(result.stats.magic.current).toBe(99);
  });

  it('lets Rapid Restore raise drained skills off the normal cycle and never lower a boost', () => {
    const result = tickNaturalStatChange(
      statsWith({ ranged: 55, strength: 118 }),
      createDefaultTimers(),
      42,
      false,
      true,
    );

    expect(result.stats.ranged.current).toBe(56);
    expect(result.stats.strength.current).toBe(118);
    expect(result.timers.statRecoveryTick).toBe(100);
  });

  it('stops decay of a locked skill but still recovers it when drained', () => {
    const timers: CombatTimers = {
      ...createDefaultTimers(),
      statDecayLocks: {
        attack: { ticksRemaining: 300, source: 'divine' },
        defence: { ticksRemaining: 300, source: 'divine' },
      },
    };

    const result = tickNaturalStatChange(
      statsWith({ attack: 118, defence: 60, strength: 118 }),
      timers,
      100,
      false,
      false,
    );

    expect(result.stats.attack.current).toBe(118);
    expect(result.stats.defence.current).toBe(61);
    expect(result.stats.strength.current).toBe(117);
  });
});

describe('expireStatDecayLocks', () => {
  const locked = (ticksRemaining: number): CombatTimers => ({
    ...createDefaultTimers(),
    statDecayLocks: {
      attack: { ticksRemaining, source: 'divine' },
      strength: { ticksRemaining, source: 'divine' },
      magic: { ticksRemaining, source: 'saturated_heart' },
    },
  });

  it('counts every lock down one tick', () => {
    const result = expireStatDecayLocks(createDefaultStats(), locked(10));

    expect(result.timers.statDecayLocks.attack?.ticksRemaining).toBe(9);
    expect(result.timers.statDecayLocks.magic).toEqual({ ticksRemaining: 9, source: 'saturated_heart' });
    expect(result.expired).toEqual([]);
  });

  it('drops a skill still above base to base on release, and leaves one at or below base alone', () => {
    const stats = createDefaultStats();
    stats.attack = { current: 118, max: 99 };
    stats.strength = { current: 80, max: 99 };
    stats.magic = { current: 99, max: 99 };

    const result = expireStatDecayLocks(stats, locked(1));

    expect(result.stats.attack.current).toBe(99);
    expect(result.stats.strength.current).toBe(80);
    expect(result.stats.magic.current).toBe(99);
    expect(result.timers.statDecayLocks).toEqual({});
    expect(result.expired).toEqual(['divine', 'saturated_heart']);
  });

  it('is a no-op without locks', () => {
    const stats = createDefaultStats();
    const timers = createDefaultTimers();

    const result = expireStatDecayLocks(stats, timers);

    expect(result.stats).toBe(stats);
    expect(result.timers).toBe(timers);
  });
});
