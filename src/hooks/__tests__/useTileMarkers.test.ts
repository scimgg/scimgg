// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getListedPresetsForEncounter, getPresetById, getPresetsForEncounter } from '../../data/tilePackPresets';
import {
  clampTileWidth,
  DEFAULT_MARKER_FILL_OPACITY,
  DEFAULT_TILE_MARKER_WIDTH,
  TILE_MARKER_WIDTH_MAX,
  TILE_MARKER_WIDTH_MIN,
} from '../../types/tileMarkers';
import { useTileMarkers } from '../useTileMarkers';

const STORAGE_KEY = 'osrs-tile-markers';

function clearTileMarkerStorage(): void {
  localStorage.removeItem(STORAGE_KEY);
}

describe('useTileMarkers', () => {
  beforeEach(() => {
    clearTileMarkerStorage();
  });

  it('enables the Zuk Inferno preset on a fresh install', () => {
    const preset = getPresetById('zuk_inferno');
    expect(preset).toBeDefined();
    if (!preset) return;

    const { result } = renderHook(() => useTileMarkers('zuk'));

    expect(result.current.activePresetIds).toEqual(['zuk_inferno']);
    expect(result.current.effectiveMarkers).toEqual(preset.markers);
  });

  it('enables the Colosseum pack on a fresh install and keeps it off once switched off', () => {
    const preset = getPresetById('sol_heredit_colosseum');
    expect(preset).toBeDefined();
    if (!preset) return;

    const first = renderHook(() => useTileMarkers('sol_heredit'));
    expect(first.result.current.activePresetIds).toEqual(['sol_heredit_colosseum']);
    expect(first.result.current.effectiveMarkers).toEqual(preset.markers);

    act(() => {
      first.result.current.togglePreset('sol_heredit_colosseum');
    });
    expect(first.result.current.activePresetIds).toEqual([]);
    first.unmount();

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').presetOverrides).toEqual({
      sol_heredit: { sol_heredit_colosseum: false },
    });
    const { result } = renderHook(() => useTileMarkers('sol_heredit'));
    expect(result.current.activePresetIds).toEqual([]);
    expect(result.current.effectiveMarkers).toEqual([]);
  });

  it("loads the encounter's markers and the display settings from localStorage", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        markersByEncounter: { yama_p3: [{ x: 30, y: 34, color: '#123456', opacity: 0.4, label: 'stored' }] },
        showMarkers: false,
        showLabels: false,
        lastColor: '#654321',
        lastOpacity: 0.3,
        presetOverrides: { yama_p3: { yama_p3_donofly: true } },
      }),
    );

    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    expect(result.current.markers).toEqual([{ x: 30, y: 34, color: '#123456', opacity: 0.4, label: 'stored' }]);
    expect(result.current.showMarkers).toBe(false);
    expect(result.current.showLabels).toBe(false);
    expect(result.current.lastColor).toBe('#654321');
    expect(result.current.lastOpacity).toBe(0.3);
    expect(result.current.activePresetIds).toEqual(['yama_p3_donofly']);
  });

  it('supports add/remove/update/clear marker CRUD operations', () => {
    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    act(() => {
      result.current.addMarker(31, 35);
    });

    expect(result.current.hasMarker(31, 35)).toBe(true);
    expect(result.current.getMarker(31, 35)).toEqual(expect.objectContaining({ x: 31, y: 35 }));

    act(() => {
      result.current.updateMarkerColor(31, 35, '#00ffcc', 0.6, 0);
      result.current.updateMarkerLabel(31, 35, 'safe');
    });

    expect(result.current.getMarker(31, 35)).toEqual({
      x: 31,
      y: 35,
      color: '#00ffcc',
      opacity: 0.6,
      label: 'safe',
    });

    act(() => {
      result.current.removeMarker(31, 35);
    });

    expect(result.current.markers).toEqual([]);

    act(() => {
      result.current.addMarker(28, 33);
      result.current.addMarker(29, 33);
      result.current.clearAllMarkers();
    });

    expect(result.current.markers).toEqual([]);
  });

  it('saves/applies preset selection and includes preset markers in effective markers', () => {
    const presetId = 'yama_p3_donofly';
    const preset = getPresetById(presetId);
    expect(preset).toBeDefined();
    if (!preset) return;

    const presetTile = preset.markers[0];
    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    act(() => {
      result.current.togglePreset(presetId);
    });

    expect(result.current.activePresetIds).toEqual([presetId]);
    expect(result.current.effectiveMarkers).toEqual(
      expect.arrayContaining([expect.objectContaining({ x: presetTile.x, y: presetTile.y })]),
    );

    act(() => {
      result.current.addMarker(presetTile.x, presetTile.y);
      result.current.updateMarkerColor(presetTile.x, presetTile.y, '#ff00ff', 0.8, 0);
    });

    const effectiveAtPresetTile = result.current.effectiveMarkers.find(
      (m) => m.x === presetTile.x && m.y === presetTile.y,
    );
    expect(effectiveAtPresetTile).toEqual(expect.objectContaining({ color: '#ff00ff', opacity: 0.8 }));
  });

  it('isolates markers per encounter kind', () => {
    const { result, rerender } = renderHook(
      ({ encounterKind }: { encounterKind: string }) => useTileMarkers(encounterKind),
      { initialProps: { encounterKind: 'yama_p3' } },
    );

    act(() => {
      result.current.addMarker(30, 30);
    });
    expect(result.current.markers).toEqual([expect.objectContaining({ x: 30, y: 30 })]);

    rerender({ encounterKind: 'lobby' });
    expect(result.current.markers).toEqual([]);

    act(() => {
      result.current.addMarker(40, 40);
    });
    expect(result.current.markers).toEqual([expect.objectContaining({ x: 40, y: 40 })]);

    rerender({ encounterKind: 'yama_p3' });
    expect(result.current.markers).toEqual([expect.objectContaining({ x: 30, y: 30 })]);
    expect(result.current.markers).not.toEqual(expect.arrayContaining([expect.objectContaining({ x: 40, y: 40 })]));
  });

  it('offers the base fight packs on a Yama contract variant', () => {
    const preset = getPresetById('yama_p3_donofly');
    expect(preset).toBeDefined();
    if (!preset) return;

    expect(getPresetsForEncounter('yama_p3_glyphic')).toEqual(getPresetsForEncounter('yama_p3'));

    const { result } = renderHook(() => useTileMarkers('yama_p3_glyphic'));
    act(() => {
      result.current.togglePreset('yama_p3_donofly');
    });

    expect(result.current.activePresetIds).toEqual(['yama_p3_donofly']);
    expect(result.current.effectiveMarkers).toEqual(preset.markers);
  });

  it('remembers a pack choice per variant, not across the whole encounter', () => {
    const { result, rerender } = renderHook(
      ({ encounterKind }: { encounterKind: string }) => useTileMarkers(encounterKind),
      { initialProps: { encounterKind: 'yama_p3' } },
    );

    act(() => {
      result.current.togglePreset('yama_p3_donofly');
    });
    expect(result.current.activePresetIds).toEqual(['yama_p3_donofly']);

    rerender({ encounterKind: 'yama_p3_glyphic' });
    expect(result.current.activePresetIds).toEqual([]);

    act(() => {
      result.current.togglePreset('yama_p3_no_fly');
    });
    expect(result.current.activePresetIds).toEqual(['yama_p3_no_fly']);

    rerender({ encounterKind: 'yama_p3' });
    expect(result.current.activePresetIds).toEqual(['yama_p3_donofly']);
  });
});

describe('useTileMarkers retired Zuk data', () => {
  const zukTile = { x: 30, y: 30, color: '#111111', opacity: 0.5, label: 'zuk' };
  const infernoSameTile = { x: 30, y: 30, color: '#222222', opacity: 0.6, label: 'inferno' };
  const infernoTile = { x: 31, y: 31, color: '#333333', opacity: 0.7 };

  function storeTileMarkers(value: unknown): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  }

  beforeEach(() => {
    clearTileMarkerStorage();
  });

  afterEach(() => {
    clearTileMarkerStorage();
  });

  it("shows a Zuk-only player's markers and pack choice on the Inferno", () => {
    storeTileMarkers({ markersByEncounter: { zuk: [zukTile] }, presetOverrides: { zuk: { zuk_inferno: false } } });

    const { result } = renderHook(() => useTileMarkers('inferno'));

    expect(result.current.markers).toEqual([zukTile]);
    expect(result.current.activePresetIds).toEqual([]);
  });

  it("merges both kinds' markers, Zuk winning a shared tile, whatever the stored key order", () => {
    for (const markersByEncounter of [
      { inferno: [infernoSameTile, infernoTile], zuk: [zukTile] },
      { zuk: [zukTile], inferno: [infernoSameTile, infernoTile] },
    ]) {
      storeTileMarkers({ markersByEncounter });
      const { result, unmount } = renderHook(() => useTileMarkers('inferno'));
      expect(result.current.markers).toEqual([zukTile, infernoTile]);
      unmount();
    }
  });
});

describe('clampTileWidth', () => {
  it('clamps into the shared 0.5-10 UI scale', () => {
    expect(clampTileWidth(0)).toBe(TILE_MARKER_WIDTH_MIN);
    expect(clampTileWidth(99)).toBe(TILE_MARKER_WIDTH_MAX);
    expect(clampTileWidth(4)).toBe(4);
    expect(clampTileWidth(1.5)).toBe(1.5);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampTileWidth(Number.NaN)).toBe(DEFAULT_TILE_MARKER_WIDTH);
    expect(clampTileWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_TILE_MARKER_WIDTH);
    expect(clampTileWidth(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_TILE_MARKER_WIDTH);
  });
});

describe('useTileMarkers marker width', () => {
  beforeEach(() => {
    clearTileMarkerStorage();
  });

  it('starts at the default marker weight when the setting is absent', () => {
    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    expect(result.current.markerWidth).toBe(DEFAULT_TILE_MARKER_WIDTH);
  });

  it('persists a width the user picks', () => {
    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    act(() => {
      result.current.setMarkerWidth(4.5);
    });

    expect(result.current.markerWidth).toBe(4.5);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}').markerWidth).toBe(4.5);
  });

  it('clamps a width the caller pushes out of range', () => {
    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    act(() => {
      result.current.setMarkerWidth(99);
    });
    expect(result.current.markerWidth).toBe(TILE_MARKER_WIDTH_MAX);

    act(() => {
      result.current.setMarkerWidth(Number.NaN);
    });
    expect(result.current.markerWidth).toBe(DEFAULT_TILE_MARKER_WIDTH);
  });

  it('reads a stored width back, clamping what another build may have written', () => {
    for (const [stored, expected] of [
      [3, 3],
      [99, TILE_MARKER_WIDTH_MAX],
      [0, TILE_MARKER_WIDTH_MIN],
      ['3', DEFAULT_TILE_MARKER_WIDTH],
      [null, DEFAULT_TILE_MARKER_WIDTH],
    ] as const) {
      clearTileMarkerStorage();
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ markerWidth: stored }));

      const { result, unmount } = renderHook(() => useTileMarkers('yama_p3'));
      expect(result.current.markerWidth).toBe(expected);
      unmount();
    }
  });

  // Stored settings can lack the width entirely, so a missing width must load
  // as the default rather than undefined.
  it('defaults the width when stored settings lack the setting', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ showMarkers: false, lastOpacity: 0.3 }));

    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    expect(result.current.markerWidth).toBe(DEFAULT_TILE_MARKER_WIDTH);
    expect(result.current.showMarkers).toBe(false);
  });
});

describe('useTileMarkers fill opacity', () => {
  beforeEach(() => {
    clearTileMarkerStorage();
  });

  // A marked tile is an outline until you ask for a fill, so a fresh marker must
  // carry no fillOpacity at all rather than a zero one — absent is the shape that
  // replays and RuneLite exports round-trip.
  it('gives a newly marked tile no fill', () => {
    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    act(() => {
      result.current.addMarker(31, 35);
    });

    expect(result.current.lastFillOpacity).toBe(DEFAULT_MARKER_FILL_OPACITY);
    expect(result.current.getMarker(31, 35)).toEqual({ x: 31, y: 35, color: expect.any(String), opacity: 1 });
    expect(result.current.getMarker(31, 35)).not.toHaveProperty('fillOpacity');
  });

  it('stores a fill the picker applies, and remembers it for the next marker', () => {
    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    act(() => {
      result.current.addMarker(31, 35);
      result.current.updateMarkerColor(31, 35, '#00FFCC', 1, 0.35);
    });

    expect(result.current.getMarker(31, 35)?.fillOpacity).toBe(0.35);
    expect(result.current.lastFillOpacity).toBe(0.35);

    act(() => {
      result.current.addMarker(32, 35);
    });
    expect(result.current.getMarker(32, 35)?.fillOpacity).toBe(0.35);
  });

  it('drops the fill back off rather than storing a zero', () => {
    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    act(() => {
      result.current.addMarker(31, 35);
      result.current.updateMarkerColor(31, 35, '#00FFCC', 1, 0.5);
      result.current.updateMarkerColor(31, 35, '#00FFCC', 1, 0);
    });

    expect(result.current.getMarker(31, 35)).not.toHaveProperty('fillOpacity');
  });

  it('clamps a stored fill another build may have written', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        markersByEncounter: { yama_p3: [{ x: 30, y: 30, color: '#FFFFFF', opacity: 1, fillOpacity: 9 }] },
      }),
    );

    const { result } = renderHook(() => useTileMarkers('yama_p3'));

    expect(result.current.getMarker(30, 30)?.fillOpacity).toBe(1);
  });
});

describe('tutorial-owned tile packs', () => {
  beforeEach(() => {
    clearTileMarkerStorage();
  });

  const WAVE_LANE = 'yama_p3_wave_cross';

  it('keeps the wave dodge lane out of the list a player picks from', () => {
    expect(getListedPresetsForEncounter('yama_p3').map((p) => p.id)).not.toContain(WAVE_LANE);
    expect(getPresetById(WAVE_LANE)?.hidden).toBe(true);
  });

  // The Shadow Waves tutorial activates this pack by id, and `effectiveMarkers`
  // resolves active ids against `getPresetsForEncounter`. Hiding it there too
  // would let the tutorial's `activate-tile-preset` report success while none of
  // its four lane tiles ever reach the renderer — a failure no test would catch,
  // because `presetId` is an unvalidated string.
  it('still renders the hidden pack once a tutorial switches it on', () => {
    const preset = getPresetById(WAVE_LANE);
    expect(preset).toBeDefined();
    if (!preset) return;

    expect(getPresetsForEncounter('yama_p3').map((p) => p.id)).toContain(WAVE_LANE);

    const { result } = renderHook(() => useTileMarkers('yama_p3'));
    act(() => {
      result.current.activateAllPresets([WAVE_LANE]);
    });

    expect(result.current.activePresetIds).toContain(WAVE_LANE);
    expect(result.current.effectiveMarkers).toEqual(preset.markers);
  });

  // The pack has no row to switch off, so the paths that clear packs wholesale
  // are a player's only way back out of it.
  it('lets the clear-all path switch the hidden pack back off', () => {
    const { result } = renderHook(() => useTileMarkers('yama_p3'));
    act(() => {
      result.current.activateAllPresets([WAVE_LANE]);
    });
    expect(result.current.activePresetIds).toContain(WAVE_LANE);

    act(() => {
      result.current.deactivateAllPresets(getPresetsForEncounter('yama_p3').map((p) => p.id));
    });

    expect(result.current.activePresetIds).not.toContain(WAVE_LANE);
    expect(result.current.effectiveMarkers).toEqual([]);
  });
});
