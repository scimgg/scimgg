import { describe, expect, it } from 'vitest';
import { tileMarkerKey } from '../../types/tileMarkers';
import { exportRuneLiteMarkers, importRuneLiteMarkers } from '../../util/tilePackIO';
import { getPresetsForEncounter } from '../tilePackPresets';

describe('Zuk tile-marker preset', () => {
  it('registers the Zuk Inferno markers with the shared semantic colors', () => {
    const presets = getPresetsForEncounter('zuk');

    const preset = presets.find((candidate) => candidate.id === 'zuk_inferno');

    expect(preset).toBeDefined();
    expect(preset?.description).toBe('Zuk safe columns, danger tiles, and positional references');
    expect(preset?.markers).toHaveLength(14);
    expect(preset?.markers.map(({ x, y }) => [x, y])).toEqual([
      [36, 46],
      [42, 46],
      [26, 46],
      [20, 46],
      [40, 46],
      [39, 46],
      [38, 46],
      [31, 45],
      [23, 46],
      [22, 46],
      [24, 46],
      [33, 43],
      [32, 29],
      [26, 34],
    ]);
    expect(preset?.markers.filter((marker) => marker.color === '#00BFA5')).toHaveLength(4);
    expect(preset?.markers.filter((marker) => marker.color === '#FF6B35')).toHaveLength(7);
    expect(preset?.markers.filter((marker) => marker.color === '#90A4AE')).toHaveLength(3);
    expect(preset?.markers).toContainEqual({ x: 31, y: 45, color: '#FF6B35', opacity: 0.8, label: 'UNSAFE' });
  });
});

describe('Colosseum tile-marker preset', () => {
  function colosseumPack() {
    const preset = getPresetsForEncounter('sol_heredit').find((candidate) => candidate.id === 'sol_heredit_colosseum');
    if (!preset) throw new Error('the Colosseum pack is not registered for sol_heredit');
    return preset;
  }

  it('is registered for the Colosseum and on by default', () => {
    expect(colosseumPack()).toMatchObject({
      encounterKind: 'sol_heredit',
      defaultActive: true,
      link: 'https://oldschool.runescape.wiki/w/Guide:Colosseum_tile_markers?oldid=14689691',
    });
  });

  // Wiki revision 14689691: 116 dead-zone, 64 Solarflare-path, 3 start, 4 off-tick/stall and
  // 8 destack/jaguar-trap tiles, each listed once.
  it('carries every tile and label of the Wiki revision, one marker per tile', () => {
    const { markers } = colosseumPack();

    expect(markers).toHaveLength(195);
    expect(new Set(markers.map(({ x, y }) => tileMarkerKey(x, y))).size).toBe(195);
    expect(markers.filter((marker) => marker.color === '#90A4AE')).toHaveLength(116);
    expect(markers.filter((marker) => marker.color === '#FF6B35')).toHaveLength(64);
    expect(markers.filter((marker) => marker.color === '#00BFA5')).toHaveLength(3);
    expect(markers.filter((marker) => marker.color === '#FFAB00')).toHaveLength(4);
    expect(markers.filter((marker) => marker.color === '#9B59B6')).toHaveLength(8);
    expect(markers.filter((marker) => marker.label === 'destack')).toHaveLength(6);
    // Nothing is left at the Wiki's transparent alpha, which would draw no outline.
    expect(markers.every((marker) => marker.opacity > 0)).toBe(true);

    for (const anchor of [
      { x: 23, y: 36, color: '#00BFA5', label: 'start NW' },
      { x: 21, y: 33, color: '#00BFA5', label: 'start SW' },
      { x: 23, y: 43, color: '#FFAB00', label: 'A' },
      { x: 23, y: 42, color: '#FFAB00', label: 'B' },
      { x: 21, y: 43, color: '#FFAB00', label: 'offtick' },
      { x: 21, y: 26, color: '#FFAB00', label: 'stall' },
      { x: 26, y: 50, color: '#9B59B6', label: 'jaguar trap' },
    ]) {
      expect(markers).toContainEqual({ ...anchor, opacity: 0.8 });
    }
  });

  it('lands every marker on a tile the RuneLite importer accepts for the Colosseum', () => {
    const { markers } = colosseumPack();
    const json = exportRuneLiteMarkers(markers, 'sol_heredit');
    if (json === null) throw new Error('export returned null for sol_heredit');

    // Region 7216 is map square 28_48, the encounter's origin, so the Wiki's region-local tiles
    // are the pack's tiles unchanged.
    expect(new Set(JSON.parse(json).map((point: { regionId: number }) => point.regionId))).toEqual(new Set([7216]));
    expect(importRuneLiteMarkers(json, 'sol_heredit')).toEqual(markers);
  });
});
