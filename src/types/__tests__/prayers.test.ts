import { describe, expect, it } from 'vitest';
import { PRAYER_GRID } from '../../components/GamePanel/prayerFilterUtils';
import {
  PRAYER_CATEGORIES,
  PRAYER_DRAIN_EFFECTS,
  PRAYER_STAT_MULTIPLIERS,
  PrayerType,
  prayersConflict,
} from '../simulation';
import {
  WIKI_CONFLICT_CELLS,
  WIKI_TIERED_PRAYER_ROWS,
  WIKI_UNCONFLICTED_PRAYERS,
  type WikiConflictRow,
} from './fixtures/wikiPrayerTable';

const ALL_PRAYERS = Object.values(PrayerType);

function wikiRows(prayer: PrayerType): readonly WikiConflictRow[] {
  return WIKI_CONFLICT_CELLS.find((cell) => cell.prayers.includes(prayer))?.rows ?? [];
}

function wikiConflict(a: PrayerType, b: PrayerType): boolean {
  return a !== b && wikiRows(a).some((row) => wikiRows(b).includes(row));
}

describe('prayer conflicts', () => {
  it('places every modeled prayer in exactly one cell of the wiki table, or among the unconflicted', () => {
    const placed = [...WIKI_CONFLICT_CELLS.flatMap((cell) => cell.prayers), ...WIKI_UNCONFLICTED_PRAYERS];
    expect([...placed].sort()).toEqual([...ALL_PRAYERS].sort());
  });

  it('makes every pair of prayers conflict exactly as the wiki table says', () => {
    const mismatches = ALL_PRAYERS.flatMap((a) =>
      ALL_PRAYERS.filter((b) => prayersConflict(a, b) !== wikiConflict(a, b)).map((b) => `${a} + ${b}`),
    );
    expect(mismatches).toEqual([]);
  });

  it('is symmetric and never lets a prayer conflict with itself', () => {
    for (const a of ALL_PRAYERS) {
      expect(prayersConflict(a, a)).toBe(false);
      for (const b of ALL_PRAYERS) expect(prayersConflict(a, b)).toBe(prayersConflict(b, a));
    }
  });

  it('lets Deadeye and Mystic Vigour stand beside every skin prayer', () => {
    for (const upgrade of [PrayerType.Deadeye, PrayerType.MysticVigour]) {
      for (const skin of [PrayerType.ThickSkin, PrayerType.RockSkin, PrayerType.SteelSkin]) {
        expect(prayersConflict(upgrade, skin)).toBe(false);
      }
    }
  });

  it('keeps the three single-stat rows apart from one another', () => {
    expect(prayersConflict(PrayerType.BurstOfStrength, PrayerType.ClarityOfThought)).toBe(false);
    expect(prayersConflict(PrayerType.BurstOfStrength, PrayerType.ThickSkin)).toBe(false);
    expect(prayersConflict(PrayerType.ClarityOfThought, PrayerType.ThickSkin)).toBe(false);
  });

  it('has the ranged and magic lines spanning both offence rows but not the defence row', () => {
    expect(prayersConflict(PrayerType.SharpEye, PrayerType.BurstOfStrength)).toBe(true);
    expect(prayersConflict(PrayerType.SharpEye, PrayerType.ClarityOfThought)).toBe(true);
    expect(prayersConflict(PrayerType.SharpEye, PrayerType.ThickSkin)).toBe(false);
    expect(prayersConflict(PrayerType.HawkEye, PrayerType.MysticLore)).toBe(true);
  });

  it('has Chivalry conflict with every row it spans', () => {
    for (const prayer of [PrayerType.ThickSkin, PrayerType.BurstOfStrength, PrayerType.ClarityOfThought]) {
      expect(prayersConflict(PrayerType.Chivalry, prayer)).toBe(true);
    }
    expect(prayersConflict(PrayerType.Chivalry, PrayerType.Piety)).toBe(true);
    expect(prayersConflict(PrayerType.Chivalry, PrayerType.ProtectMelee)).toBe(false);
    expect(prayersConflict(PrayerType.Chivalry, PrayerType.Preserve)).toBe(false);
  });

  // The single offensive slot this replaced held exactly these eight, each evicting all the others.
  it('keeps every pair of the formerly slotted offensive prayers in conflict', () => {
    const slotted = [
      PrayerType.Augury,
      PrayerType.Rigour,
      PrayerType.Piety,
      PrayerType.Zeal,
      PrayerType.EagleEye,
      PrayerType.MysticMight,
      PrayerType.Deadeye,
      PrayerType.MysticVigour,
    ];
    for (const a of slotted) {
      for (const b of slotted) expect(prayersConflict(a, b)).toBe(a !== b);
    }
  });

  it('stores overhead prayers in the protection slot and unconflicted ones as independent', () => {
    for (const prayer of ALL_PRAYERS) {
      const rows = wikiRows(prayer);
      const expected = rows.includes('overhead') ? 'protection' : rows.length > 0 ? 'boost' : 'independent';
      expect(PRAYER_CATEGORIES[prayer]).toBe(expected);
    }
  });
});

describe('tiered prayers and Chivalry', () => {
  it.each(WIKI_TIERED_PRAYER_ROWS)('$prayer has the wiki drain effect and boost', ({ prayer, drainEffect, boost }) => {
    expect(PRAYER_DRAIN_EFFECTS[prayer]).toBe(drainEffect);
    expect(PRAYER_STAT_MULTIPLIERS[prayer]).toEqual(boost);
  });

  it.each(WIKI_TIERED_PRAYER_ROWS)('$prayer sits in the book at its wiki level', ({ prayer, level }) => {
    expect(PRAYER_GRID.find((slot) => slot.prayer === prayer)?.level).toBe(level);
  });
});
