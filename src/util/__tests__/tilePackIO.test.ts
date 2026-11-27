import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EncounterDescriptor } from '../../core/encounters/encounterFactory';
import { encounterRegistry } from '../../encounters/registry';
import { exportRuneLiteMarkers, importRuneLiteMarkers } from '../tilePackIO';

const YAMA_REGION_ID = (23 << 8) | 157;

const CLIPBOARD_JSON = JSON.stringify([
  { regionId: YAMA_REGION_ID, regionX: 35, regionY: 37, z: 0, color: '#FF5D98AB', label: '1' },
  { regionId: YAMA_REGION_ID, regionX: 36, regionY: 35, z: 0, color: '#FF5D98AB', label: '2' },
  { regionId: 5789, regionX: 30, regionY: 43, z: 2, color: '#FFB312AA' },
]);

describe('importRuneLiteMarkers', () => {
  it('keeps only the encounter region and maps color, opacity and label', () => {
    const markers = importRuneLiteMarkers(CLIPBOARD_JSON, 'yama_p3');

    expect(markers).toEqual([
      { x: 35, y: 37, color: '#5D98AB', opacity: 1, label: '1' },
      { x: 36, y: 35, color: '#5D98AB', opacity: 1, label: '2' },
    ]);
  });

  it('imports into a contract variant, which has no descriptor of its own', () => {
    expect(importRuneLiteMarkers(CLIPBOARD_JSON, 'yama_p3_divine')).toEqual(
      importRuneLiteMarkers(CLIPBOARD_JSON, 'yama_p3'),
    );
  });

  it('returns null for an unknown encounter kind', () => {
    expect(importRuneLiteMarkers(CLIPBOARD_JSON, 'not_an_encounter')).toBeNull();
  });
});

describe('exportRuneLiteMarkers', () => {
  it('stamps a contract variant with its parent encounter region', () => {
    const json = exportRuneLiteMarkers([{ x: 31, y: 38, color: '#B61515', opacity: 1 }], 'yama_p3_forfeit_breath');
    if (json === null) throw new Error('export returned null for a contract variant');

    expect(JSON.parse(json)).toEqual([
      { regionId: YAMA_REGION_ID, regionX: 31, regionY: 38, z: 0, color: '#FFB61515' },
    ]);
  });
});

/**
 * main has no encounter spanning two squares, so these stand one in: a synthetic descriptor whose
 * arena is map square 35_47 (sim y 0-63, region 9007) and 35_48 north of it (sim y 64-127, region
 * 9008), with scenery-only squares east of the origin (36_47, region 9263) and south of it (35_46,
 * region 9006).
 */
const TWO_SQUARE_KIND = 'synthetic_two_square';
const TWO_SQUARE_DESCRIPTOR = {
  kind: TWO_SQUARE_KIND,
  displayName: 'Two squares',
  description: '',
  mapSquare: { x: 35, y: 47 },
  mapSquareOffsets: [
    { dx: 0, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 1, dy: 0, sceneryOnly: true },
    { dx: 0, dy: -1, sceneryOnly: true },
  ],
  playerStart: [28, 60],
} satisfies EncounterDescriptor;

describe('RuneLite markers across several map squares', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function useTwoSquareDescriptor(): void {
    const real = encounterRegistry.getDescriptorForKind.bind(encounterRegistry);
    vi.spyOn(encounterRegistry, 'getDescriptorForKind').mockImplementation((kind) =>
      kind === TWO_SQUARE_KIND ? TWO_SQUARE_DESCRIPTOR : real(kind),
    );
  }

  it('round-trips both sides of the seam between regions 9007 and 9008', () => {
    useTwoSquareDescriptor();
    const markers = [
      { x: 28, y: 63, color: '#B61515', opacity: 1 },
      { x: 28, y: 64, color: '#B61515', opacity: 1, label: 'north' },
    ];

    const json = exportRuneLiteMarkers(markers, TWO_SQUARE_KIND);
    if (json === null) throw new Error('export returned null');

    expect(JSON.parse(json)).toEqual([
      { regionId: 9007, regionX: 28, regionY: 63, z: 0, color: '#FFB61515' },
      { regionId: 9008, regionX: 28, regionY: 0, z: 0, color: '#FFB61515', label: 'north' },
    ]);
    expect(importRuneLiteMarkers(json, TWO_SQUARE_KIND)).toEqual(markers);
  });

  it('floors a marker south of the origin into the region below, never a negative local tile', () => {
    useTwoSquareDescriptor();
    const json = exportRuneLiteMarkers([{ x: 5, y: -1, color: '#00FF00', opacity: 1 }], TWO_SQUARE_KIND);
    if (json === null) throw new Error('export returned null');

    expect(JSON.parse(json)).toEqual([{ regionId: 9006, regionX: 5, regionY: 63, z: 0, color: '#FF00FF00' }]);
    // That square is scenery only, so the marker does not come back.
    expect(importRuneLiteMarkers(json, TWO_SQUARE_KIND)).toEqual([]);
  });

  it('drops markers from foreign regions and from scenery-only squares', () => {
    useTwoSquareDescriptor();
    const json = JSON.stringify([
      { regionId: 9008, regionX: 10, regionY: 2, z: 0, color: '#FF5D98AB' },
      // 35_49, north of the arena.
      { regionId: 9009, regionX: 10, regionY: 2, z: 0, color: '#FF5D98AB' },
      // 36_47, declared but scenery-only.
      { regionId: 9263, regionX: 10, regionY: 2, z: 0, color: '#FF5D98AB' },
      { regionId: YAMA_REGION_ID, regionX: 10, regionY: 2, z: 0, color: '#FF5D98AB' },
    ]);

    expect(importRuneLiteMarkers(json, TWO_SQUARE_KIND)).toEqual([{ x: 10, y: 66, color: '#5D98AB', opacity: 1 }]);
  });

  it("keeps the Inferno's interchange to its origin region: its neighbors are scenery only", () => {
    const infernoRegion = (35 << 8) | 83;
    const json = JSON.stringify([
      { regionId: infernoRegion, regionX: 30, regionY: 40, z: 0, color: '#FF5D98AB' },
      // 35_84, the Inferno's scenery-only north square.
      { regionId: infernoRegion + 1, regionX: 30, regionY: 2, z: 0, color: '#FF5D98AB' },
    ]);

    expect(importRuneLiteMarkers(json, 'inferno')).toEqual([{ x: 30, y: 40, color: '#5D98AB', opacity: 1 }]);
  });
});
