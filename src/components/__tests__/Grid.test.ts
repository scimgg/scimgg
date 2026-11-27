import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocWithType } from '../../cache/CacheManager';
import { setArenaConfig } from '../../core/constants';
import { SOL_HEREDIT_RENDER_CONFIG } from '../../encounters/solHeredit/renderConfig';
import { resolveEffectiveLocs } from '../../render/environment/locRenderFilter';
import { resolveEncounterLocRenderOptions } from '../../render/scene/encounterLocRenderOptions';
import { getEncounterRenderConfig } from '../../render/scene/encounterRenderConfig';
import type { LocModelLoader } from '../../rs/config/loctype/LocModelLoader';
import { LocModelType } from '../../rs/config/loctype/LocModelType';
import type { LocType } from '../../rs/config/loctype/LocType';
import type { Coordinate } from '../../types/simulation';
import {
  buildViewportContextMenu,
  type Ray3D,
  rayFindInteractiveLoc,
  rayFindInteractiveLocWithCoord,
} from '../ContextMenu';
import { getSceneBuilderLifecycleKey } from '../Grid';
import { getEncounterMapFootprint } from '../gridEncounterMapSquare';

describe('getSceneBuilderLifecycleKey', () => {
  it('changes for same-encounter reloads', () => {
    expect(getSceneBuilderLifecycleKey('yama_p3', 1)).not.toBe(getSceneBuilderLifecycleKey('yama_p3', 2));
  });

  it('keeps variants distinct from the base encounter', () => {
    expect(getSceneBuilderLifecycleKey('yama_p3', 1)).not.toBe(getSceneBuilderLifecycleKey('yama_p3_divine', 1));
  });
});

describe('getEncounterMapFootprint', () => {
  it("returns the base encounter's own map square", () => {
    expect(getEncounterMapFootprint('yama_p3')?.origin).toEqual({ x: 23, y: 157 });
  });

  it('resolves variant kinds through their parent descriptor, to the same footprint', () => {
    expect(getEncounterMapFootprint('yama_p3_divine')).toBe(getEncounterMapFootprint('yama_p3'));
  });

  it('is undefined for a kind with no descriptor', () => {
    expect(getEncounterMapFootprint('not_an_encounter')).toBeUndefined();
  });
});

// Zuk's static Ancestral Glyph: the Inferno render config excludes it from the rendered scene
// because the wave respawns it as a moving NPC, so hover, left click and the right-click
// menu must not offer it either. Fixture geometry mirrors the real Inferno cache locs.
const ZUK_GLYPH_LOC_ID = 30338;

function makeLocType(overrides: Partial<LocType> = {}): LocType {
  return { name: 'Object', isInteractive: 1, actions: ['Examine'], sizeX: 1, sizeY: 1, ...overrides } as LocType;
}

function makeLoc(x: number, y: number, id: number, locType: LocType, rotation = 0): LocWithType {
  return {
    location: { id, localX: x, localY: y, level: 0, type: 10, rotation },
    locType,
    modelType: LocModelType.NORMAL,
    mapSquareOffset: { x: 0, y: 0 },
    terrainHeightPlanes: [],
    terrainContextOrigin: { x: 0, y: 0 },
  };
}

function makeLocLoader(locTypesById: Record<number, LocType> = {}): LocModelLoader {
  return { loadLocType: vi.fn((id: number) => locTypesById[id]) } as unknown as LocModelLoader;
}

/** Vertical ray down through (x, y), the shape the viewport pickers cast. */
function downRay(x: number, y: number): Ray3D {
  return { origin: { x, y, z: 10 }, direction: { x: 0, y: 0, z: -1 } };
}

/** The exact composition Grid's `interactionLocs` memo feeds to hover/click/menu. */
function zukInteractionLocs(locs: ReadonlyArray<LocWithType>, loader = makeLocLoader()): LocWithType[] {
  return resolveEffectiveLocs(locs, resolveEncounterLocRenderOptions(getEncounterRenderConfig('inferno')), loader);
}

function menuEntries(locs: ReadonlyArray<LocWithType>, ray: Ray3D, tile: Coordinate) {
  const menu = buildViewportContextMenu({ tile, entityContext: { locs: [...locs] }, ray, onTileClick: vi.fn() });
  return menu?.entries ?? [];
}

describe('interaction scenery — encounter render exclusions', () => {
  const glyph = makeLoc(30, 51, ZUK_GLYPH_LOC_ID, makeLocType({ name: 'Ancestral glyph', sizeX: 6, sizeY: 3 }), 3);
  const caveExit = makeLoc(29, 13, 30283, makeLocType({ name: 'Cave exit', sizeX: 5, sizeY: 4, actions: ['Enter'] }));
  const arenaClutter = makeLoc(30, 30, 30300, makeLocType({ name: 'Rubble' }));
  const rawLocs = [glyph, caveExit, arenaClutter];

  // Inside the glyph's rotated 3x6 footprint at (30, 51); the exit ray hits (29, 13)+5x4.
  const GLYPH_RAY = downRay(31.5, 53.5);
  const EXIT_RAY = downRay(30.5, 14.5);

  it("expands Zuk's map-square offsets into the same bounds the renderer filters by", () => {
    const options = resolveEncounterLocRenderOptions(getEncounterRenderConfig('inferno'));
    expect(options?.bounds).toEqual({ minX: -64, maxX: 127, minY: -64, maxY: 127 });
    expect(options?.marginTiles).toBe(0);
    expect(options?.excludedLocs).toContainEqual({ localX: 30, localY: 51, locId: ZUK_GLYPH_LOC_ID });
  });

  it('passes a declared filter through when the encounter spans only the center square', () => {
    const declared = { bounds: null, levels: [0] };
    expect(resolveEncounterLocRenderOptions({ locRender: declared })).toBe(declared);
    expect(resolveEncounterLocRenderOptions(undefined)).toBeUndefined();
  });

  it('drops the excluded glyph and arena clutter from interaction while ordinary scenery survives', () => {
    const resolved = zukInteractionLocs(rawLocs);
    expect(resolved.map((entry) => entry.location.id)).toEqual([30283]);

    // Fixture guard: against the RAW cache list the same ray and menu do surface the
    // glyph (the phantom bug), so the misses below are the filter's doing, not a misaim.
    expect(rayFindInteractiveLoc(GLYPH_RAY, rawLocs)?.name).toBe('Ancestral glyph');
    expect(menuEntries(rawLocs, GLYPH_RAY, [31, 53]).map((entry) => entry.target)).toContain('Ancestral glyph');

    // Hover tooltip and left-click pick over the glyph footprint find nothing...
    expect(rayFindInteractiveLoc(GLYPH_RAY, resolved)).toBeNull();
    expect(rayFindInteractiveLocWithCoord(GLYPH_RAY, resolved)).toBeNull();
    expect(menuEntries(resolved, GLYPH_RAY, [31, 53]).map((entry) => entry.target)).not.toContain('Ancestral glyph');

    // ...while the ordinary cave exit still hovers, picks and lists its cache ops.
    expect(rayFindInteractiveLoc(EXIT_RAY, resolved)?.name).toBe('Cave exit');
    expect(rayFindInteractiveLocWithCoord(EXIT_RAY, resolved)?.coord).toEqual([29, 13]);
    const exitMenu = menuEntries(resolved, EXIT_RAY, [30, 14]);
    expect(exitMenu.map((entry) => entry.target)).toContain('Cave exit');
    expect(exitMenu.map((entry) => entry.action)).toContain('Enter');
  });

  it('leaves the alcove walls to the scene controller, sparing the same id elsewhere', () => {
    // The six prison walls and the glyph change on wave 69, so the static scene (and so interaction)
    // leaves exactly those LOCs out; another 30324 elsewhere in the square stays.
    const sourceWall = makeLoc(27, 54, 30324, makeLocType({ name: 'Prison wall', sizeY: 3 }));
    const otherWall = makeLoc(20, 54, 30324, makeLocType({ name: 'Prison wall', sizeY: 3 }));
    const resolved = zukInteractionLocs([sourceWall, otherWall]);
    expect(resolved.map((entry) => [entry.location.localX, entry.location.localY])).toEqual([[20, 54]]);
  });
});

describe('interaction scenery — single-square encounters keep their own loc filter', () => {
  afterEach(() => setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true));

  it("clips Yama's scenery to its arena plus the default margin, not the whole map square", () => {
    // Yama declares no loc filter, so the default clip follows the installed arena (its baked bounds).
    setArenaConfig({
      bounds: { minX: 17, maxX: 44, minY: 1, maxY: 40, width: 28, height: 40 },
      walkableTiles: null,
      collisionMap: null,
    });
    const options = resolveEncounterLocRenderOptions(getEncounterRenderConfig('yama_p3'));
    expect(options).toBeUndefined();
    const nearArena = makeLoc(47, 20, 1, makeLocType({ name: 'Near' }));
    const beyondMargin = makeLoc(55, 20, 2, makeLocType({ name: 'Beyond' }));
    const northOfMargin = makeLoc(30, 50, 3, makeLocType({ name: 'North' }));
    const resolved = resolveEffectiveLocs([nearArena, beyondMargin, northOfMargin], options, makeLocLoader());
    expect(resolved.map((entry) => entry.location.id)).toEqual([1]);
  });

  it("keeps Sol Heredit's authored full-square filter as it is", () => {
    expect(resolveEncounterLocRenderOptions(getEncounterRenderConfig('sol_heredit'))).toBe(
      SOL_HEREDIT_RENDER_CONFIG.locRender,
    );
  });
});
