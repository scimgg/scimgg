import { describe, expect, it } from 'vitest';
import { PRAYER_CATEGORIES, PrayerType } from '../../../types/simulation';
import { getSlotIndexFromPoint, isPrayerHighlighted, prayerSlotOrigin } from '../PrayerContent';

// Redemption is an overhead prayer (RuneLite `HeadIcon.REDEMPTION`), so it shares the Protect
// prayers' exclusive slot even though it grants no damage reduction.
const PROTECTION_PRAYERS = [
  PrayerType.ProtectMagic,
  PrayerType.ProtectRange,
  PrayerType.ProtectMelee,
  PrayerType.Redemption,
] as const;
const INDEPENDENT_PRAYERS = [PrayerType.Preserve, PrayerType.RapidRestore, PrayerType.RapidHeal] as const;
/** The boost prayers that conflict with every other one: they span both offence rows. */
const OFFENSIVE_PRAYERS = [
  PrayerType.Augury,
  PrayerType.Rigour,
  PrayerType.Piety,
  PrayerType.Zeal,
  PrayerType.EagleEye,
  PrayerType.MysticMight,
  PrayerType.Deadeye,
  PrayerType.MysticVigour,
] as const;
const BOOST_PRAYERS = [
  ...OFFENSIVE_PRAYERS,
  PrayerType.ThickSkin,
  PrayerType.BurstOfStrength,
  PrayerType.ClarityOfThought,
  PrayerType.SharpEye,
  PrayerType.MysticWill,
  PrayerType.RockSkin,
  PrayerType.SuperhumanStrength,
  PrayerType.ImprovedReflexes,
  PrayerType.HawkEye,
  PrayerType.MysticLore,
  PrayerType.SteelSkin,
  PrayerType.UltimateStrength,
  PrayerType.IncredibleReflexes,
  PrayerType.Chivalry,
] as const;

function orderedConflicts(prayers: readonly PrayerType[]): Array<[PrayerType, PrayerType]> {
  return prayers.flatMap((active) =>
    prayers.filter((clicked) => clicked !== active).map((clicked) => [active, clicked]),
  );
}

describe('prayer grid geometry', () => {
  // Origins are the client's, plus the 7px panel inset: the 34x34 button at (11, 16),
  // stepped by the client's derived pitch of 37. Reorder drop targets are the
  // full pitch cells, so a drop in the slack between buttons still lands on one.
  const SLOT_COUNT = 29;
  const rect = (left = 0, top = 0) => ({ left, top }) as DOMRect;
  const at = (x: number, y: number, scale = 1) => getSlotIndexFromPoint(x, y, rect(), scale, SLOT_COUNT);

  it('places slot 0 on the cache origin and steps by the pitch', () => {
    expect(prayerSlotOrigin(0)).toEqual({ x: 11, y: 16 });
    expect(prayerSlotOrigin(4)).toEqual({ x: 11 + 4 * 37, y: 16 });
    expect(prayerSlotOrigin(5)).toEqual({ x: 11, y: 16 + 37 });
  });

  it('resolves a click on a button to its own slot', () => {
    expect(at(prayerSlotOrigin(0).x + 1, prayerSlotOrigin(0).y + 1)).toBe(0);
    expect(at(prayerSlotOrigin(12).x + 1, prayerSlotOrigin(12).y + 1)).toBe(12);
  });

  it('resolves a drop in the slack between two buttons to the nearer slot', () => {
    const gutterX = prayerSlotOrigin(1).x - 1;
    expect(at(gutterX, prayerSlotOrigin(1).y + 1)).toBe(1);
  });

  it('rejects a point outside the grid rather than clamping into it', () => {
    expect(at(-50, 0)).toBeNull();
    expect(at(0, -50)).toBeNull();
    expect(at(10_000, 0)).toBeNull();
  });

  it('rejects a cell past the last prayer', () => {
    expect(at(prayerSlotOrigin(SLOT_COUNT).x + 1, prayerSlotOrigin(SLOT_COUNT).y + 1)).toBeNull();
  });

  it('divides out the panel scale before indexing', () => {
    const origin = prayerSlotOrigin(7);
    expect(at((origin.x + 1) * 2, (origin.y + 1) * 2, 2)).toBe(7);
  });
});

describe('prayer click highlighting', () => {
  it('stores every current prayer in the expected place', () => {
    expect(Object.values(PrayerType).filter((prayer) => PRAYER_CATEGORIES[prayer] === 'protection')).toEqual(
      PROTECTION_PRAYERS,
    );
    expect(Object.values(PrayerType).filter((prayer) => PRAYER_CATEGORIES[prayer] === 'boost')).toEqual(BOOST_PRAYERS);
    expect(Object.values(PrayerType).filter((prayer) => PRAYER_CATEGORIES[prayer] === 'independent')).toEqual(
      INDEPENDENT_PRAYERS,
    );
  });

  it('highlights an independent prayer from set membership rather than a slot', () => {
    expect(isPrayerHighlighted(PrayerType.Preserve, null, [], undefined, [PrayerType.Preserve])).toBe(true);
    expect(isPrayerHighlighted(PrayerType.Preserve, null, [], undefined, [])).toBe(false);
    // An overhead and an offensive prayer being lit neither lights nor darkens it.
    expect(
      isPrayerHighlighted(PrayerType.Preserve, PrayerType.ProtectMelee, [PrayerType.Piety], undefined, [
        PrayerType.Preserve,
      ]),
    ).toBe(true);
  });

  it('highlights every lit boost prayer at once, and only those', () => {
    const lit = [PrayerType.ThickSkin, PrayerType.BurstOfStrength, PrayerType.ClarityOfThought];
    for (const prayer of BOOST_PRAYERS) {
      expect(isPrayerHighlighted(prayer, null, lit, undefined)).toBe(lit.includes(prayer));
    }
  });

  it('keeps the old protection prayer highlighted while the new click awaits server receipt', () => {
    const overrides = { [PrayerType.ProtectMelee]: true };

    expect(isPrayerHighlighted(PrayerType.ProtectRange, PrayerType.ProtectRange, [], overrides)).toBe(true);
    expect(isPrayerHighlighted(PrayerType.ProtectMelee, PrayerType.ProtectRange, [], overrides)).toBe(true);
  });

  it('shows only the predicted protection prayer when Instant Prayer replaces the active slot', () => {
    const overrides = { [PrayerType.ProtectMelee]: true };

    expect(isPrayerHighlighted(PrayerType.ProtectRange, PrayerType.ProtectMelee, [], overrides)).toBe(false);
    expect(isPrayerHighlighted(PrayerType.ProtectMelee, PrayerType.ProtectMelee, [], overrides)).toBe(true);
  });

  it.each(
    orderedConflicts(PROTECTION_PRAYERS),
  )('keeps protection conflict %s + %s highlighted before server receipt', (active, clicked) => {
    const overrides = { [clicked]: true };

    expect(isPrayerHighlighted(active, active, [], overrides)).toBe(true);
    expect(isPrayerHighlighted(clicked, active, [], overrides)).toBe(true);
  });

  it.each(
    orderedConflicts(OFFENSIVE_PRAYERS),
  )('keeps offensive conflict %s + %s highlighted before server receipt', (active, clicked) => {
    const overrides = { [clicked]: true };

    expect(isPrayerHighlighted(active, null, [active], overrides)).toBe(true);
    expect(isPrayerHighlighted(clicked, null, [active], overrides)).toBe(true);
  });

  it.each(
    orderedConflicts(PROTECTION_PRAYERS),
  )('Instant Prayer replaces protection conflict %s with %s immediately', (active, clicked) => {
    const overrides = { [clicked]: true };

    expect(isPrayerHighlighted(active, clicked, [], overrides)).toBe(false);
    expect(isPrayerHighlighted(clicked, clicked, [], overrides)).toBe(true);
  });

  it.each(
    orderedConflicts(OFFENSIVE_PRAYERS),
  )('Instant Prayer replaces offensive conflict %s with %s immediately', (active, clicked) => {
    const overrides = { [clicked]: true };

    expect(isPrayerHighlighted(active, null, [clicked], overrides)).toBe(false);
    expect(isPrayerHighlighted(clicked, null, [clicked], overrides)).toBe(true);
  });
});
