import { describe, expect, it } from 'vitest';
import { PrayerType } from '../../types/simulation';
import {
  type PrayerInputState,
  prayerSetChanges,
  prayerSetLogChanges,
  type QueuedPrayerAction,
  resolvePrayerActions,
} from '../prayerInput';

const NOTHING_ON: PrayerInputState = { protection: null, boost: [], independent: [], quickPrayersActive: false };

const QUICK_SET = [PrayerType.ProtectMagic, PrayerType.Augury] as const;

function quick(): QueuedPrayerAction {
  return { type: 'quickPrayers', selections: [...QUICK_SET] };
}

describe('resolvePrayerActions', () => {
  describe('ordering', () => {
    it.each([
      PrayerType.Piety,
      PrayerType.Rigour,
      PrayerType.Augury,
      PrayerType.EagleEye,
      PrayerType.MysticMight,
      PrayerType.Deadeye,
      PrayerType.MysticVigour,
    ])('makes Zeal mutually exclusive with %s, including quick prayers', (other) => {
      const start = {
        ...NOTHING_ON,
        boost: [other],
        protection: PrayerType.ProtectMelee,
        independent: [PrayerType.Preserve],
      };
      const zeal = resolvePrayerActions(start, [{ type: 'boost', prayer: PrayerType.Zeal }], true);
      expect(zeal.boost).toEqual([PrayerType.Zeal]);
      expect(zeal.protection).toBe(PrayerType.ProtectMelee);
      expect(zeal.independent).toEqual([PrayerType.Preserve]);
      expect(resolvePrayerActions(zeal, [{ type: 'boost', prayer: other }], true).boost).toEqual([other]);
      expect(
        resolvePrayerActions(NOTHING_ON, [{ type: 'quickPrayers', selections: [other, PrayerType.Zeal] }], true).boost,
      ).toEqual([PrayerType.Zeal]);
    });

    it('toggles the same clicked protection prayer twice back to the starting state', () => {
      const outcome = resolvePrayerActions(
        NOTHING_ON,
        [
          { type: 'protection', prayer: PrayerType.ProtectMelee },
          { type: 'protection', prayer: PrayerType.ProtectMelee },
        ],
        true,
      );

      expect(outcome.protection).toBeNull();
      expect(outcome.transitions).toEqual([
        { slot: 'protection', from: null, to: PrayerType.ProtectMelee },
        { slot: 'protection', from: PrayerType.ProtectMelee, to: null },
      ]);
    });

    it('applies every action in arrival order rather than keeping only the last', () => {
      const outcome = resolvePrayerActions(
        NOTHING_ON,
        [
          { type: 'protection', prayer: PrayerType.ProtectMelee },
          { type: 'protection', prayer: null },
          { type: 'protection', prayer: PrayerType.ProtectMagic },
        ],
        true,
      );

      expect(outcome.protection).toBe(PrayerType.ProtectMagic);
      expect(outcome.protectionTouched).toBe(true);
      expect(outcome.transitions).toEqual([
        { slot: 'protection', from: null, to: PrayerType.ProtectMelee },
        { slot: 'protection', from: PrayerType.ProtectMelee, to: null },
        { slot: 'protection', from: null, to: PrayerType.ProtectMagic },
      ]);
    });

    it('turning a prayer on and back off inside one batch ends off', () => {
      const outcome = resolvePrayerActions(
        NOTHING_ON,
        [
          { type: 'protection', prayer: PrayerType.ProtectMelee },
          { type: 'protection', prayer: null },
        ],
        true,
      );

      expect(outcome.protection).toBeNull();
      expect(outcome.activated).toEqual([]);
    });

    it('keeps the protection slot and the boost set independent', () => {
      const outcome = resolvePrayerActions(
        NOTHING_ON,
        [
          { type: 'boost', prayer: PrayerType.Piety },
          { type: 'protection', prayer: PrayerType.ProtectMelee },
        ],
        true,
      );

      expect(outcome.protection).toBe(PrayerType.ProtectMelee);
      expect(outcome.boost).toEqual([PrayerType.Piety]);
    });
  });

  describe('drain grace period', () => {
    it('counts a genuine off→on flick as an activation', () => {
      const outcome = resolvePrayerActions(
        { protection: PrayerType.ProtectMelee, boost: [], independent: [], quickPrayersActive: false },
        [
          { type: 'protection', prayer: null },
          { type: 'protection', prayer: PrayerType.ProtectMelee },
        ],
        true,
      );

      expect(outcome.protection).toBe(PrayerType.ProtectMelee);
      expect(outcome.activated).toEqual([PrayerType.ProtectMelee]);
    });

    it('turns off a clicked prayer that is already active', () => {
      const outcome = resolvePrayerActions(
        { protection: PrayerType.ProtectMelee, boost: [], independent: [], quickPrayersActive: false },
        [{ type: 'protection', prayer: PrayerType.ProtectMelee }],
        true,
      );

      expect(outcome.protection).toBeNull();
      expect(outcome.activated).toEqual([]);
      expect(outcome.transitions).toEqual([{ slot: 'protection', from: PrayerType.ProtectMelee, to: null }]);
    });

    it('does not report an activation for a prayer that ends the batch switched off', () => {
      const outcome = resolvePrayerActions(
        NOTHING_ON,
        [
          { type: 'protection', prayer: PrayerType.ProtectMelee },
          { type: 'protection', prayer: PrayerType.ProtectMagic },
        ],
        true,
      );

      expect(outcome.activated).toEqual([PrayerType.ProtectMagic]);
    });
  });

  describe('quick prayers', () => {
    it('an even number of orb toggles is a no-op', () => {
      const start: PrayerInputState = {
        protection: PrayerType.ProtectMagic,
        boost: [PrayerType.Augury],
        independent: [],
        quickPrayersActive: true,
      };

      const outcome = resolvePrayerActions(start, [quick(), quick()], true);

      expect(outcome.quickPrayersActive).toBe(true);
      expect(outcome.protection).toBe(PrayerType.ProtectMagic);
      expect(outcome.boost).toEqual([PrayerType.Augury]);
      expect(outcome.transitions).toEqual([
        { slot: 'protection', from: PrayerType.ProtectMagic, to: null },
        { slot: 'boost', from: PrayerType.Augury, to: null },
        { slot: 'protection', from: null, to: PrayerType.ProtectMagic },
        { slot: 'boost', from: null, to: PrayerType.Augury },
      ]);
    });

    it('an even number of orb toggles from off is also a no-op', () => {
      const outcome = resolvePrayerActions(NOTHING_ON, [quick(), quick()], true);

      expect(outcome.quickPrayersActive).toBe(false);
      expect(outcome.protection).toBeNull();
      expect(outcome.boost).toEqual([]);
    });

    it('an odd number of orb toggles flips the set on', () => {
      const outcome = resolvePrayerActions(NOTHING_ON, [quick(), quick(), quick()], true);

      expect(outcome.quickPrayersActive).toBe(true);
      expect(outcome.protection).toBe(PrayerType.ProtectMagic);
      expect(outcome.boost).toEqual([PrayerType.Augury]);
    });

    it('an off→on orb pair counts as an activation, so a flick avoids drain', () => {
      const start: PrayerInputState = {
        protection: PrayerType.ProtectMagic,
        boost: [PrayerType.Augury],
        independent: [],
        quickPrayersActive: true,
      };

      const outcome = resolvePrayerActions(start, [quick(), quick()], true);

      expect([...outcome.activated].sort()).toEqual([PrayerType.Augury, PrayerType.ProtectMagic].sort());
    });

    it('an individual prayer click drops the quick-prayer flag', () => {
      const start: PrayerInputState = {
        protection: PrayerType.ProtectMagic,
        boost: [PrayerType.Augury],
        independent: [],
        quickPrayersActive: true,
      };

      const outcome = resolvePrayerActions(start, [{ type: 'protection', prayer: PrayerType.ProtectMelee }], true);

      expect(outcome.quickPrayersActive).toBe(false);
      expect(outcome.protection).toBe(PrayerType.ProtectMelee);
      expect(outcome.boost).toEqual([PrayerType.Augury]);
    });

    it('activating an empty quick-prayer set changes nothing', () => {
      const outcome = resolvePrayerActions(NOTHING_ON, [{ type: 'quickPrayers', selections: [] }], true);

      expect(outcome.quickPrayersActive).toBe(false);
      expect(outcome.protectionTouched).toBe(false);
    });
  });

  describe('no prayer points', () => {
    it('refuses an activation and reports it as rejected', () => {
      const outcome = resolvePrayerActions(
        NOTHING_ON,
        [{ type: 'protection', prayer: PrayerType.ProtectMelee }],
        false,
      );

      expect(outcome.protection).toBeNull();
      expect(outcome.rejected).toEqual([PrayerType.ProtectMelee]);
    });

    it('still allows deactivation', () => {
      const outcome = resolvePrayerActions(
        { protection: PrayerType.ProtectMelee, boost: [], independent: [], quickPrayersActive: false },
        [{ type: 'protection', prayer: null }],
        false,
      );

      expect(outcome.protection).toBeNull();
      expect(outcome.rejected).toEqual([]);
    });

    it('refuses to engage quick prayers', () => {
      const outcome = resolvePrayerActions(NOTHING_ON, [quick()], false);

      expect(outcome.quickPrayersActive).toBe(false);
      expect(outcome.rejected).toEqual([PrayerType.ProtectMagic]);
    });
  });
});

describe('independent prayers', () => {
  const PRESERVE_ON: PrayerInputState = { ...NOTHING_ON, independent: [PrayerType.Preserve] };

  it('toggles membership without touching either exclusive slot', () => {
    const outcome = resolvePrayerActions(
      { protection: PrayerType.ProtectMelee, boost: [PrayerType.Piety], independent: [], quickPrayersActive: false },
      [{ type: 'independent', prayer: PrayerType.Preserve }],
      true,
    );

    expect(outcome.independent).toEqual([PrayerType.Preserve]);
    expect(outcome.protection).toBe(PrayerType.ProtectMelee);
    expect(outcome.boost).toEqual([PrayerType.Piety]);
    expect(outcome.transitions).toEqual([{ slot: 'independent', from: null, to: PrayerType.Preserve }]);
  });

  it('clicking a lit independent prayer turns it off', () => {
    const outcome = resolvePrayerActions(PRESERVE_ON, [{ type: 'independent', prayer: PrayerType.Preserve }], true);

    expect(outcome.independent).toEqual([]);
    expect(outcome.transitions).toEqual([{ slot: 'independent', from: PrayerType.Preserve, to: null }]);
  });

  it('lighting an overhead leaves an independent prayer burning', () => {
    const outcome = resolvePrayerActions(PRESERVE_ON, [{ type: 'protection', prayer: PrayerType.Redemption }], true);

    expect(outcome.protection).toBe(PrayerType.Redemption);
    expect(outcome.independent).toEqual([PrayerType.Preserve]);
  });

  it('refuses activation with no prayer points but still allows deactivation', () => {
    const refused = resolvePrayerActions(NOTHING_ON, [{ type: 'independent', prayer: PrayerType.Preserve }], false);
    expect(refused.independent).toEqual([]);
    expect(refused.rejected).toEqual([PrayerType.Preserve]);

    const off = resolvePrayerActions(PRESERVE_ON, [{ type: 'independent', prayer: PrayerType.Preserve }], false);
    expect(off.independent).toEqual([]);
    expect(off.rejected).toEqual([]);
  });

  it('counts a genuine off→on flick as an activation but a no-op click pair as none', () => {
    const flick = resolvePrayerActions(
      PRESERVE_ON,
      [
        { type: 'independent', prayer: PrayerType.Preserve },
        { type: 'independent', prayer: PrayerType.Preserve },
      ],
      true,
    );

    expect(flick.independent).toEqual([PrayerType.Preserve]);
    expect(flick.activated).toEqual([PrayerType.Preserve]);
  });

  describe('quick prayers', () => {
    it('treats a Preserve-only set as non-empty and engages it', () => {
      const outcome = resolvePrayerActions(
        NOTHING_ON,
        [{ type: 'quickPrayers', selections: [PrayerType.Preserve] }],
        true,
      );

      expect(outcome.quickPrayersActive).toBe(true);
      expect(outcome.independent).toEqual([PrayerType.Preserve]);
    });

    it('does not re-stamp an independent prayer the set merely retains', () => {
      const outcome = resolvePrayerActions(
        { ...PRESERVE_ON, quickPrayersActive: false },
        [{ type: 'quickPrayers', selections: [PrayerType.Preserve, PrayerType.Piety] }],
        true,
      );

      expect(outcome.independent).toEqual([PrayerType.Preserve]);
      // Preserve was already burning, so only Piety earns the drain-grace stamp.
      expect(outcome.activated).toEqual([PrayerType.Piety]);
    });

    it('turning quick prayers off clears independent membership too', () => {
      const outcome = resolvePrayerActions(
        { ...PRESERVE_ON, boost: [PrayerType.Piety], quickPrayersActive: true },
        [{ type: 'quickPrayers', selections: [PrayerType.Preserve, PrayerType.Piety] }],
        true,
      );

      expect(outcome.quickPrayersActive).toBe(false);
      expect(outcome.independent).toEqual([]);
      expect(outcome.boost).toEqual([]);
    });
  });
});

describe('boost prayers', () => {
  const click = (prayer: PrayerType | null): QueuedPrayerAction => ({ type: 'boost', prayer });
  const SINGLE_STATS: PrayerInputState = {
    ...NOTHING_ON,
    boost: [PrayerType.ThickSkin, PrayerType.BurstOfStrength, PrayerType.ClarityOfThought],
  };

  it('lights Thick Skin, Burst of Strength and Clarity of Thought together', () => {
    const outcome = resolvePrayerActions(
      NOTHING_ON,
      [click(PrayerType.ThickSkin), click(PrayerType.BurstOfStrength), click(PrayerType.ClarityOfThought)],
      true,
    );

    expect(outcome.boost).toEqual([PrayerType.ThickSkin, PrayerType.BurstOfStrength, PrayerType.ClarityOfThought]);
    expect(outcome.activated).toEqual(outcome.boost);
  });

  it('lets Sharp Eye turn off Burst of Strength and Clarity of Thought but keep Thick Skin', () => {
    const outcome = resolvePrayerActions(SINGLE_STATS, [click(PrayerType.SharpEye)], true);

    expect(outcome.boost).toEqual([PrayerType.ThickSkin, PrayerType.SharpEye]);
    // One click, one change: the first prayer it displaced, as a slot swap always reported.
    expect(outcome.transitions).toEqual([{ slot: 'boost', from: PrayerType.BurstOfStrength, to: PrayerType.SharpEye }]);
  });

  it('lets Chivalry turn off every single-stat row', () => {
    const outcome = resolvePrayerActions(SINGLE_STATS, [click(PrayerType.Chivalry)], true);

    expect(outcome.boost).toEqual([PrayerType.Chivalry]);
    expect(outcome.activated).toEqual([PrayerType.Chivalry]);
    expect(outcome.transitions).toEqual([{ slot: 'boost', from: PrayerType.ThickSkin, to: PrayerType.Chivalry }]);
  });

  it('keeps a skin prayer beside Deadeye, and drops Deadeye when Rigour lights', () => {
    const deadeye = resolvePrayerActions(NOTHING_ON, [click(PrayerType.SteelSkin), click(PrayerType.Deadeye)], true);
    expect(deadeye.boost).toEqual([PrayerType.SteelSkin, PrayerType.Deadeye]);

    const rigour = resolvePrayerActions(deadeye, [click(PrayerType.Rigour)], true);
    expect(rigour.boost).toEqual([PrayerType.Rigour]);
  });

  it('swaps the ranged line for the magic line', () => {
    const outcome = resolvePrayerActions(
      { ...NOTHING_ON, boost: [PrayerType.HawkEye] },
      [click(PrayerType.MysticLore)],
      true,
    );

    expect(outcome.boost).toEqual([PrayerType.MysticLore]);
  });

  it('turns only the clicked prayer off when it is lit', () => {
    const outcome = resolvePrayerActions(SINGLE_STATS, [click(PrayerType.BurstOfStrength)], true);

    expect(outcome.boost).toEqual([PrayerType.ThickSkin, PrayerType.ClarityOfThought]);
    expect(outcome.transitions).toEqual([{ slot: 'boost', from: PrayerType.BurstOfStrength, to: null }]);
  });

  it('turns every boost prayer off for a null click, as it cleared the old offensive slot', () => {
    const outcome = resolvePrayerActions(SINGLE_STATS, [click(null)], false);

    expect(outcome.boost).toEqual([]);
    expect(outcome.transitions).toEqual([
      { slot: 'boost', from: PrayerType.ThickSkin, to: null },
      { slot: 'boost', from: PrayerType.BurstOfStrength, to: null },
      { slot: 'boost', from: PrayerType.ClarityOfThought, to: null },
    ]);
  });

  it('refuses a new boost prayer with no points, leaving the lit ones alone', () => {
    const outcome = resolvePrayerActions(SINGLE_STATS, [click(PrayerType.Chivalry)], false);

    expect(outcome.boost).toEqual(SINGLE_STATS.boost);
    expect(outcome.rejected).toEqual([PrayerType.Chivalry]);
  });

  it('lights a quick-prayer set of non-conflicting boosts together', () => {
    const outcome = resolvePrayerActions(
      NOTHING_ON,
      [{ type: 'quickPrayers', selections: [PrayerType.ProtectMelee, PrayerType.ThickSkin, PrayerType.Deadeye] }],
      true,
    );

    expect(outcome.protection).toBe(PrayerType.ProtectMelee);
    expect(outcome.boost).toEqual([PrayerType.ThickSkin, PrayerType.Deadeye]);
  });

  it('lets a later quick-prayer selection win a conflict, as a later protection selection does', () => {
    const outcome = resolvePrayerActions(
      NOTHING_ON,
      [{ type: 'quickPrayers', selections: [PrayerType.ThickSkin, PrayerType.BurstOfStrength, PrayerType.Piety] }],
      true,
    );

    expect(outcome.boost).toEqual([PrayerType.Piety]);
  });

  it('pairs each prayer a quick-prayer set lights with what it displaced, after the plain removals', () => {
    const outcome = resolvePrayerActions(
      { ...NOTHING_ON, boost: [PrayerType.ThickSkin, PrayerType.BurstOfStrength] },
      [{ type: 'quickPrayers', selections: [PrayerType.SharpEye] }],
      true,
    );

    expect(outcome.boost).toEqual([PrayerType.SharpEye]);
    expect(outcome.transitions).toEqual([
      { slot: 'boost', from: PrayerType.ThickSkin, to: null },
      { slot: 'boost', from: PrayerType.BurstOfStrength, to: PrayerType.SharpEye },
    ]);
  });
});

describe('prayerSetChanges', () => {
  it('reports a single-prayer swap as one change, as the offensive slot did', () => {
    expect(prayerSetChanges([PrayerType.Piety], [PrayerType.Rigour])).toEqual([
      { from: PrayerType.Piety, to: PrayerType.Rigour },
    ]);
  });

  it('reports unconflicted prayers as removals before additions', () => {
    expect(prayerSetChanges([PrayerType.Preserve], [PrayerType.RapidHeal])).toEqual([
      { from: PrayerType.Preserve, to: null },
      { from: null, to: PrayerType.RapidHeal },
    ]);
  });

  it('pairs each displaced prayer with at most one arrival', () => {
    expect(prayerSetChanges([PrayerType.Piety], [PrayerType.BurstOfStrength, PrayerType.ClarityOfThought])).toEqual([
      { from: PrayerType.Piety, to: PrayerType.BurstOfStrength },
      { from: null, to: PrayerType.ClarityOfThought },
    ]);
  });
});

describe('prayerSetLogChanges', () => {
  it('adds a removal for each further prayer an arrival displaced', () => {
    const before = [PrayerType.ThickSkin, PrayerType.BurstOfStrength, PrayerType.ClarityOfThought];
    expect(prayerSetLogChanges(before, [PrayerType.Chivalry])).toEqual([
      { from: PrayerType.ThickSkin, to: PrayerType.Chivalry },
      { from: PrayerType.BurstOfStrength, to: null },
      { from: PrayerType.ClarityOfThought, to: null },
    ]);
  });

  it('matches prayerSetChanges when nothing extra was displaced', () => {
    expect(prayerSetLogChanges([PrayerType.Piety], [PrayerType.Rigour])).toEqual(
      prayerSetChanges([PrayerType.Piety], [PrayerType.Rigour]),
    );
  });
});
