import { describe, expect, it } from 'vitest';
import {
  KIND_TO_SLUG,
  LEGACY_SLUG_TO_KIND,
  RETIRED_SLUG_TO_KIND,
  SLUG_TO_KIND,
  slugToVariantId,
  variantIdToSlug,
} from '../slugs';

describe('slugs', () => {
  it('SLUG_TO_KIND and KIND_TO_SLUG are inverses', () => {
    for (const [slug, kind] of SLUG_TO_KIND) {
      expect(KIND_TO_SLUG.get(kind)).toBe(slug);
    }
    for (const [kind, slug] of KIND_TO_SLUG) {
      expect(SLUG_TO_KIND.get(slug)).toBe(kind);
    }
    expect(SLUG_TO_KIND.size).toBe(KIND_TO_SLUG.size);
  });

  it.each([
    ['no_contract', 'no-contract'],
    ['forfeit_breath', 'forfeit-breath'],
    ['glyphic_attenuation', 'glyphic-attenuation'],
    ['simple', 'simple'],
  ])('variantIdToSlug(%s) === %s and round-trips', (id, expectedSlug) => {
    const slug = variantIdToSlug(id);
    expect(slug).toBe(expectedSlug);
    expect(slugToVariantId(slug)).toBe(id);
  });

  it('SLUG_TO_KIND maps yama to yama_p3 (the canonical base)', () => {
    expect(SLUG_TO_KIND.get('yama')).toBe('yama_p3');
  });

  it('routes the inferno slug to the Inferno encounter', () => {
    expect(SLUG_TO_KIND.get('inferno')).toBe('inferno');
    expect(KIND_TO_SLUG.get('inferno')).toBe('inferno');
  });

  it('keeps the retired zuk slug as an entry, not a canonical route', () => {
    expect(SLUG_TO_KIND.get('zuk')).toBeUndefined();
    expect(KIND_TO_SLUG.get('zuk')).toBeUndefined();
    expect(RETIRED_SLUG_TO_KIND.get('zuk')).toBe('zuk');
  });

  it('routes the Colosseum at /colosseum and keeps its former sol-heredit slug as an entry only', () => {
    expect(SLUG_TO_KIND.get('colosseum')).toBe('sol_heredit');
    expect(KIND_TO_SLUG.get('sol_heredit')).toBe('colosseum');
    expect(SLUG_TO_KIND.get('sol-heredit')).toBeUndefined();
    expect(LEGACY_SLUG_TO_KIND.get('sol-heredit')).toBe('sol_heredit');
  });

  it('gives every canonical, retired and legacy slug one meaning', () => {
    const slugs = [...SLUG_TO_KIND.keys(), ...RETIRED_SLUG_TO_KIND.keys(), ...LEGACY_SLUG_TO_KIND.keys()];
    expect(slugs).toEqual([...new Set(slugs)]);
  });

  it.each([
    'toString',
    'constructor',
    '__proto__',
    'hasOwnProperty',
  ])('knows nothing about the inherited object name %s', (name) => {
    expect(SLUG_TO_KIND.get(name)).toBeUndefined();
    expect(KIND_TO_SLUG.get(name)).toBeUndefined();
    expect(RETIRED_SLUG_TO_KIND.get(name)).toBeUndefined();
    expect(LEGACY_SLUG_TO_KIND.get(name)).toBeUndefined();
  });
});
