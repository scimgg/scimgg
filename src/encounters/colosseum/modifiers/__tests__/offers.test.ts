import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../../../core/rng';
import { COLOSSEUM_MODIFIER_IDS, type ColosseumModifierId, colosseumModifierTierCount } from '../definitions';
import {
  COLOSSEUM_FIRST_OFFERS,
  type ColosseumModifierOffer,
  colosseumModifierOfferCandidates,
  drawColosseumModifierOffers,
  eligibleColosseumModifierPicks,
  SUPPORTED_WAVE_MODIFIERS,
} from '../offers';
import { CAPTURED_MODIFIER_OFFERS, type CapturedModifierOffer } from './fixtures/modifierOfferCapture';

const ALL: ReadonlySet<ColosseumModifierId> = new Set(COLOSSEUM_MODIFIER_IDS);
const ownedMap = (record: CapturedModifierOffer['owned']) =>
  new Map(Object.entries(record) as [ColosseumModifierId, number][]);

/** A stream that makes the draw pick `wanted` in order, or null when one of them is not a candidate. */
function streamFor(
  wanted: readonly ColosseumModifierOffer[],
  input: {
    nextWave: number;
    owned: ReadonlyMap<ColosseumModifierId, number>;
    supported: ReadonlySet<ColosseumModifierId>;
  },
): (() => number) | null {
  const pool = [...colosseumModifierOfferCandidates(input)];
  const values: number[] = [];
  for (const offer of wanted) {
    const index = pool.findIndex((candidate) => candidate.id === offer.id && candidate.tier === offer.tier);
    if (index < 0) return null;
    const total = pool.reduce((sum, candidate) => sum + candidate.weight, 0);
    const before = pool.slice(0, index).reduce((sum, candidate) => sum + candidate.weight, 0);
    values.push((before + pool[index]!.weight / 2) / total);
    pool.splice(index, 1);
  }
  return () => {
    const value = values.shift();
    if (value === undefined) throw new Error('Drew more often than once per offer');
    return value;
  };
}

/** Simulator policy withholds Volatility III, which the game does offer. */
const POLICY_EXCEPTIONS = [{ capture: 'A', tick: 4184, id: 'volatility' }] as const;

describe('captured intermission offers', () => {
  it('chain within each run: every pick raises the next record by one tier', () => {
    for (const capture of ['A', 'B', 'C'] as const) {
      const records = CAPTURED_MODIFIER_OFFERS.filter((record) => record.capture === capture);
      for (const [index, record] of records.entries()) {
        expect(new Set(record.offers).size).toBe(3);
        const next = records[index + 1];
        if (!next || !record.picked) continue;
        expect(next.completedWave).toBe(record.completedWave + 1);
        expect(record.offers).toContain(record.picked);
        expect(next.owned).toEqual({ ...record.owned, [record.picked]: (record.owned[record.picked] ?? 0) + 1 });
      }
    }
  });

  it('opens wave 1 with the captured Blasphemy, Relentless, Frailty without drawing', () => {
    const opening = CAPTURED_MODIFIER_OFFERS.filter((record) => record.completedWave === 0);
    expect(opening.map((record) => record.capture)).toEqual(['B', 'C']);
    for (const record of opening) {
      expect(COLOSSEUM_FIRST_OFFERS.map((offer) => offer.id)).toEqual(record.offers);
    }
    const random = () => {
      throw new Error('Wave 1 offers are fixed');
    };
    expect(drawColosseumModifierOffers({ nextWave: 1, owned: new Map(), random, supported: ALL })).toEqual([
      { id: 'blasphemy', tier: 1 },
      { id: 'relentless', tier: 1 },
      { id: 'frailty', tier: 1 },
    ]);
  });

  it.each(
    CAPTURED_MODIFIER_OFFERS.filter((record) => record.completedWave > 0).map((record) => ({
      ...record,
      label: `${record.capture}:${record.tick}`,
    })),
  )('can draw $label exactly, in button order, with every effect simulated', (record) => {
    const owned = ownedMap(record.owned);
    const input = { nextWave: record.completedWave + 1, owned, supported: ALL };
    const offers = record.offers.map((id) => ({ id, tier: (owned.get(id) ?? 0) + 1 }));
    const withheld = POLICY_EXCEPTIONS.filter(
      ({ capture, tick }) => capture === record.capture && tick === record.tick,
    );
    const candidates = colosseumModifierOfferCandidates(input);
    for (const offer of offers) {
      const isWithheld = withheld.some(({ id }) => id === offer.id);
      expect(candidates.some(({ id, tier }) => id === offer.id && tier === offer.tier)).toBe(!isWithheld);
    }
    if (withheld.length > 0) return;
    const random = streamFor(offers, input)!;
    expect(drawColosseumModifierOffers({ ...input, random })).toEqual(offers);
  });

  it('withholds Volatility III only, and only it, at A:4184', () => {
    const record = CAPTURED_MODIFIER_OFFERS.find((candidate) => candidate.tick === 4184 && candidate.capture === 'A')!;
    const ids = colosseumModifierOfferCandidates({ nextWave: 11, owned: ownedMap(record.owned), supported: ALL }).map(
      ({ id }) => id,
    );
    expect(ids).not.toContain('volatility');
    expect(ids).toEqual(expect.arrayContaining(['doom', 'frailty']));
  });
});

describe('offer policy', () => {
  it('lists candidates in cache key order, upgrades at weight 2 and new modifiers at weight 1', () => {
    const candidates = colosseumModifierOfferCandidates({
      nextWave: 4,
      owned: new Map<ColosseumModifierId, number>([
        ['bees', 2],
        ['quartet', 1],
        ['doom', 3],
        ['blasphemy', 1],
      ]),
      supported: SUPPORTED_WAVE_MODIFIERS,
    });
    expect(candidates).toEqual([
      { id: 'bees', tier: 3, weight: 2 },
      { id: 'volatility', tier: 1, weight: 1 },
      { id: 'blasphemy', tier: 2, weight: 2 },
      { id: 'relentless', tier: 1, weight: 1 },
      { id: 'totemic', tier: 1, weight: 1 },
      { id: 'solarflare', tier: 1, weight: 1 },
      { id: 'myopia', tier: 1, weight: 1 },
      { id: 'frailty', tier: 1, weight: 1 },
    ]);
  });

  it('gates Dynamic Duo and Red Flag to waves 7–11 and keeps Mantimayhem and Reentry out of wave 12', () => {
    const idsFor = (nextWave: number) =>
      colosseumModifierOfferCandidates({ nextWave, owned: new Map(), supported: ALL }).map(({ id }) => id);
    for (let nextWave = 2; nextWave <= 12; nextWave++) {
      const ids = idsFor(nextWave);
      expect(ids.includes('dynamicDuo')).toBe(nextWave >= 7 && nextWave <= 11);
      expect(ids.includes('redFlag')).toBe(nextWave >= 7 && nextWave <= 11);
      expect(ids.includes('mantimayhem')).toBe(nextWave < 12);
      expect(ids.includes('reentry')).toBe(nextWave < 12);
    }
  });

  it('returns fewer than three offers when fewer are eligible', () => {
    const supported = new Set<ColosseumModifierId>(['quartet', 'doom']);
    const random = mulberry32(7);
    expect(drawColosseumModifierOffers({ nextWave: 5, owned: new Map(), random, supported })).toHaveLength(2);
    const owned = new Map<ColosseumModifierId, number>([
      ['quartet', 1],
      ['doom', 3],
    ]);
    expect(drawColosseumModifierOffers({ nextWave: 5, owned, random, supported })).toEqual([]);
  });

  it('rejects waves outside 2–12 for draws and impossible owned tiers', () => {
    const base = { owned: new Map<ColosseumModifierId, number>(), random: mulberry32(1), supported: ALL };
    for (const nextWave of [0, 13, 2.5]) {
      expect(() => drawColosseumModifierOffers({ ...base, nextWave })).toThrow(RangeError);
    }
    expect(() => drawColosseumModifierOffers({ ...base, nextWave: 3, owned: new Map([['quartet', 2]]) })).toThrow(
      RangeError,
    );
    expect(() => drawColosseumModifierOffers({ ...base, nextWave: 3, owned: new Map([['doom', 4]]) })).toThrow(
      RangeError,
    );
  });

  it('holds every exclusion over random runs and repeats a run from the same stream', () => {
    const lateOnly: ReadonlySet<ColosseumModifierId> = new Set(['dynamicDuo', 'redFlag']);
    for (let seed = 1; seed <= 300; seed++) {
      const setup = mulberry32(seed);
      const supported = seed % 2 === 0 ? SUPPORTED_WAVE_MODIFIERS : ALL;
      const owned = new Map<ColosseumModifierId, number>();
      for (const id of COLOSSEUM_MODIFIER_IDS) {
        const tier = Math.floor(setup() * (colosseumModifierTierCount(id) + 1));
        if (tier > 0) owned.set(id, tier);
      }
      const nextWave = 2 + Math.floor(setup() * 11);
      let draws = 0;
      const stream = mulberry32(seed * 7919);
      const random = () => {
        draws++;
        return stream();
      };
      const offers = drawColosseumModifierOffers({ nextWave, owned, random, supported });
      const eligible = colosseumModifierOfferCandidates({ nextWave, owned, supported });
      expect(offers).toHaveLength(Math.min(3, eligible.length));
      expect(draws).toBe(offers.length);
      expect(new Set(offers.map(({ id }) => id)).size).toBe(offers.length);
      for (const { id, tier } of offers) {
        expect(supported.has(id)).toBe(true);
        expect(tier).toBe((owned.get(id) ?? 0) + 1);
        expect(tier).toBeLessThanOrEqual(colosseumModifierTierCount(id));
        if (lateOnly.has(id)) expect(nextWave >= 7 && nextWave <= 11).toBe(true);
        if (id === 'mantimayhem' || id === 'reentry') expect(nextWave).toBeLessThan(12);
        expect(id === 'volatility' && tier === 3).toBe(false);
      }
      const replayed = drawColosseumModifierOffers({ nextWave, owned, random: mulberry32(seed * 7919), supported });
      expect(replayed).toEqual(offers);
    }
  });

  it('offers the simulated Dynamic Duo and Red Flag going into waves 7-11 only (first offered B:2925)', () => {
    for (let nextWave = 2; nextWave <= 12; nextWave++) {
      const ids = colosseumModifierOfferCandidates({
        nextWave,
        owned: new Map(),
        supported: SUPPORTED_WAVE_MODIFIERS,
      }).map(({ id }) => id);
      expect([nextWave, ids.includes('dynamicDuo'), ids.includes('redFlag')]).toEqual([
        nextWave,
        nextWave >= 7 && nextWave <= 11,
        nextWave >= 7 && nextWave <= 11,
      ]);
    }
  });

  it('never offers an unsupported effect in waves', () => {
    expect([...SUPPORTED_WAVE_MODIFIERS].sort()).toEqual([
      'bees',
      'blasphemy',
      'doom',
      'dynamicDuo',
      'frailty',
      'myopia',
      'quartet',
      'redFlag',
      'relentless',
      'solarflare',
      'totemic',
      'volatility',
    ]);
    for (let nextWave = 2; nextWave <= 12; nextWave++) {
      const ids = colosseumModifierOfferCandidates({
        nextWave,
        owned: new Map(),
        supported: SUPPORTED_WAVE_MODIFIERS,
      }).map(({ id }) => id);
      expect(ids.filter((id) => !SUPPORTED_WAVE_MODIFIERS.has(id))).toEqual([]);
    }
  });
});

describe('the first offer after a configured set (policy)', () => {
  const random = () => {
    throw new Error('Wave 1 offers are fixed');
  };
  const first = (owned: Record<string, number>) =>
    drawColosseumModifierOffers({
      nextWave: 1,
      owned: new Map(Object.entries(owned) as [ColosseumModifierId, number][]),
      random,
      supported: SUPPORTED_WAVE_MODIFIERS,
    });

  it('offers each of the three at the tier above the set, in the fixed order, without drawing', () => {
    expect(first({ blasphemy: 2, frailty: 1, doom: 3 })).toEqual([
      { id: 'blasphemy', tier: 3 },
      { id: 'relentless', tier: 1 },
      { id: 'frailty', tier: 2 },
    ]);
  });

  it('leaves out the tiers the set has maxed, keeping the order of the rest', () => {
    expect(first({ blasphemy: 3, frailty: 1 })).toEqual([
      { id: 'relentless', tier: 1 },
      { id: 'frailty', tier: 2 },
    ]);
    expect(first({ relentless: 3 })).toEqual([
      { id: 'blasphemy', tier: 1 },
      { id: 'frailty', tier: 1 },
    ]);
  });

  it('offers nothing once all three are maxed, and rejects a tier the modifier lacks', () => {
    expect(first({ blasphemy: 3, relentless: 3, frailty: 3 })).toEqual([]);
    expect(() => first({ frailty: 4 })).toThrow(RangeError);
  });
});

describe('eligible picks (the offer rules, and a specific pick)', () => {
  it('are the draw candidates without their weights, in cache key order', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const setup = mulberry32(seed);
      const owned = new Map<ColosseumModifierId, number>();
      for (const id of COLOSSEUM_MODIFIER_IDS) {
        const tier = Math.floor(setup() * (colosseumModifierTierCount(id) + 1));
        if (tier > 0) owned.set(id, tier);
      }
      const input = { nextWave: 2 + Math.floor(setup() * 11), owned, supported: SUPPORTED_WAVE_MODIFIERS };
      expect(eligibleColosseumModifierPicks(input)).toEqual(
        colosseumModifierOfferCandidates(input).map(({ id, tier }) => ({ id, tier })),
      );
    }
  });

  it("hold wave 1's fixed offer, under the same gates as any wave", () => {
    const eligible = eligibleColosseumModifierPicks({
      nextWave: 1,
      owned: new Map(),
      supported: SUPPORTED_WAVE_MODIFIERS,
    });
    for (const offer of COLOSSEUM_FIRST_OFFERS) expect(eligible).toContainEqual(offer);
    const ids = eligible.map(({ id }) => id);
    expect(ids).toContain('bees');
    expect(ids).not.toContain('dynamicDuo');
    expect(ids).not.toContain('redFlag');
  });

  it('leave out maxed, wave-gated, withheld and unsupported modifiers', () => {
    const owned = new Map<ColosseumModifierId, number>([
      ['doom', 3],
      ['volatility', 2],
      ['quartet', 1],
    ]);
    const ids = (nextWave: number, supported = SUPPORTED_WAVE_MODIFIERS) =>
      eligibleColosseumModifierPicks({ nextWave, owned, supported }).map(({ id }) => id);
    for (const id of ['doom', 'volatility', 'quartet', 'dynamicDuo', 'redFlag', 'mantimayhem', 'reentry'])
      expect(ids(4)).not.toContain(id);
    expect(ids(7)).toEqual(expect.arrayContaining(['dynamicDuo', 'redFlag']));
    expect(ids(11, ALL)).toEqual(expect.arrayContaining(['mantimayhem', 'reentry']));
    expect(ids(12, ALL)).not.toContain('mantimayhem');
    for (const nextWave of [0, 13, 1.5]) {
      expect(() => eligibleColosseumModifierPicks({ nextWave, owned, supported: ALL })).toThrow(RangeError);
    }
  });
});
