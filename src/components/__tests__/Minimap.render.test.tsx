// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulationEngine } from '../../core/SimulationEngine';
import { LobbyEncounter } from '../../encounters/lobby/LobbyEncounter';
import { PlayerVisualTracker } from '../../render/core/interpolation';
import { MINIMAP } from '../../resourcePack';
import type { CacheInfo } from '../../rs/cache/CacheInfo';
import { OverlayType } from '../../rs/config/flotype/FloType';
import type { OverlayTypeLoader } from '../../rs/config/flotype/FloTypeLoader';
import { NpcType } from '../../rs/config/npctype/NpcType';
import type { NpcTypeLoader } from '../../rs/config/npctype/NpcTypeLoader';
import type { MapLoader, MapSquareData } from '../../rs/map/MapLoader';
import { getMapSquareBlock, type MapSquareBlockEntry } from '../../rs/map/mapSquareBlock';
import { type NpcState, PrayerType, type SimulationState } from '../../types/simulation';
import { animationFrames } from '../../util/animationFrames';
import { ContextMenuProvider } from '../ContextMenu';
import { getEncounterMapFootprint } from '../gridEncounterMapSquare';
import { Minimap, minimapCssScale } from '../Minimap';
import { TooltipProvider } from '../Tooltip';

function renderMinimap(compactOrbs: boolean, fixedLayout = false) {
  const simulationState = new SimulationEngine({ encounter: new LobbyEncounter() }).getState();
  return render(
    <TooltipProvider>
      <ContextMenuProvider>
        <Minimap
          simulationState={simulationState}
          hasSpecialAttack
          onRunToggle={() => {}}
          onSpecialAttackToggle={() => {}}
          compactOrbs={compactOrbs}
          fixedLayout={fixedLayout}
        />
      </ContextMenuProvider>
    </TooltipProvider>,
  );
}

const TEST_CACHE_INFO = {
  name: 'test',
  game: 'oldschool',
  environment: 'live',
  revision: 225,
  timestamp: '2025-01-01T00:00:00Z',
  size: 0,
} satisfies CacheInfo;

function npcSnapshot(id: string, npcTypeId: number, alive = true): NpcState {
  return {
    id,
    npcTypeId,
    archetypeId: id,
    role: 'npc',
    alive,
    position: [10, 10],
    previousPosition: [10, 10],
    facingAngle: 0,
    size: 1,
    hp: alive ? 1 : 0,
    maxHp: 1,
    history: new Map(),
  };
}

function simulationStateWithNpcs(npcs: NpcState[]): SimulationState {
  const state = new SimulationEngine({ encounter: new LobbyEncounter() }).getState();
  return { ...state, npcs };
}

function npcType(id: number, drawMapDot: boolean, isInteractable: boolean): NpcType {
  const type = new NpcType(id, TEST_CACHE_INFO);
  type.drawMapDot = drawMapDot;
  type.isInteractable = isInteractable;
  return type;
}

function renderNpcMinimap(simulationState: SimulationState, npcTypeLoader?: NpcTypeLoader) {
  return render(
    <TooltipProvider>
      <ContextMenuProvider>
        <Minimap
          simulationState={simulationState}
          npcTypeLoader={npcTypeLoader}
          minimapNpcDotUrl="/npc-dot.png"
          hasSpecialAttack
          onRunToggle={() => {}}
          onSpecialAttackToggle={() => {}}
        />
      </ContextMenuProvider>
    </TooltipProvider>,
  );
}

function minimapParts(container: HTMLElement) {
  const mapContainer = container.querySelector<HTMLElement>('[data-tutorial="minimap-circle"]');
  return {
    mapContainer,
    canvas: mapContainer?.querySelector('canvas') ?? null,
    compass: container.querySelector<HTMLCanvasElement>('[role="img"][aria-label="Compass"]'),
    frame: container.querySelector<HTMLCanvasElement>(`canvas[data-src="${MINIMAP.fixedFrame}"]`),
  };
}

/**
 * The wheel-zoom listener and the terrain paint are both bound once, to the
 * nodes present at mount. Unmounting the map subtree when Compact Orbs is
 * enabled therefore left the minimap blank with dead wheel zoom once it was
 * switched back on, so the subtree must stay mounted and merely hidden.
 */
describe('Minimap background work', () => {
  it('instantly names the XP drops icon on pointer hover', async () => {
    renderMinimap(false, true);
    const button = screen.getByRole('button', { name: /XP drops/ });
    fireEvent.pointerEnter(button, { pointerType: 'mouse' });
    expect(await waitFor(() => screen.getByRole('tooltip'))).toHaveTextContent(button.getAttribute('aria-label') ?? '');
  });

  afterEach(() => {
    cleanup();
    animationFrames.setSuspended(false);
    animationFrames.clock.reset();
    vi.restoreAllMocks();
  });

  it('stops frame updates while suspended and resumes without remounting', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const frames = new Map<number, FrameRequestCallback>();
    let nextId = 0;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(++nextId, callback);
      return nextId;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id);
    });
    const advance = vi.spyOn(PlayerVisualTracker.prototype, 'advance');
    const { container } = renderMinimap(false);
    const canvas = minimapParts(container).canvas;
    const flush = (time: number) => {
      now.mockReturnValue(time);
      const pending = [...frames.values()];
      frames.clear();
      act(() => {
        for (const callback of pending) callback(time);
      });
    };
    flush(16);
    expect(advance).toHaveBeenCalledOnce();

    animationFrames.setSuspended(true);
    expect(frames.size).toBe(0);
    flush(10000);
    expect(advance).toHaveBeenCalledOnce();

    animationFrames.setSuspended(false);
    flush(10016);
    expect(advance).toHaveBeenCalledTimes(2);
    expect(advance.mock.lastCall?.[0]).toBe(16);
    expect(minimapParts(container).canvas).toBe(canvas);
  });
});

describe('Minimap page translation', () => {
  // A browser page translation rewriting text nodes React owns tears the live HUD down mid-render,
  // and the orb readouts change every tick.
  it('opts the minimap and its orbs out of browser page translation', () => {
    const { container } = renderMinimap(false);
    expect(container.querySelector('.panel-surface')?.getAttribute('translate')).toBe('no');
  });
});

describe('Minimap compact orbs toggle', () => {
  it('keeps the map, canvas and compass mounted when compact orbs is on', () => {
    const { container } = renderMinimap(true);
    const { mapContainer, canvas, compass } = minimapParts(container);

    expect(mapContainer).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(compass).not.toBeNull();
  });

  it('hides the map and compass instead of unmounting them', () => {
    const { container } = renderMinimap(true);
    const { mapContainer, compass } = minimapParts(container);

    expect(mapContainer?.style.display).toBe('none');
    expect(compass?.closest('div')?.style.display).toBe('none');
  });

  it('shows the map and compass when compact orbs is off', () => {
    const { container } = renderMinimap(false);
    const { mapContainer, compass } = minimapParts(container);

    expect(mapContainer?.style.display).toBe('');
    expect(compass?.closest('div')?.style.display).toBe('');
  });

  it('reuses the same canvas and map nodes across a toggle', () => {
    const { container, rerender } = renderMinimap(false);
    const before = minimapParts(container);

    const simulationState = new SimulationEngine({ encounter: new LobbyEncounter() }).getState();
    const tree = (compactOrbs: boolean) => (
      <TooltipProvider>
        <ContextMenuProvider>
          <Minimap
            simulationState={simulationState}
            hasSpecialAttack
            onRunToggle={() => {}}
            onSpecialAttackToggle={() => {}}
            compactOrbs={compactOrbs}
          />
        </ContextMenuProvider>
      </TooltipProvider>
    );

    rerender(tree(true));
    rerender(tree(false));
    const after = minimapParts(container);

    // Identity, not just presence: a remounted canvas would be blank and a
    // remounted container would have no wheel listener.
    expect(after.canvas).toBe(before.canvas);
    expect(after.mapContainer).toBe(before.mapContainer);
    expect(after.mapContainer?.style.display).toBe('');
  });
});

describe('Minimap compact orbs in the fixed layout', () => {
  it('keeps the map, compass and frame visible with compact orbs on', () => {
    const { container } = renderMinimap(true, true);
    const { mapContainer, compass, frame } = minimapParts(container);

    expect(mapContainer?.style.display).toBe('');
    expect(compass?.closest('div')?.style.display).toBe('');
    expect(frame?.style.display).toBe('');
  });

  it('still hides them for compact orbs outside the fixed layout', () => {
    const { container } = renderMinimap(true, false);
    expect(minimapParts(container).mapContainer?.style.display).toBe('none');
  });
});

describe('Minimap NPC dots', () => {
  it('adds and removes one keyed dot for every live NPC when the cache loader is unavailable', () => {
    const initialState = simulationStateWithNpcs([
      npcSnapshot('boss', 1),
      npcSnapshot('add', 2),
      npcSnapshot('dead', 3, false),
    ]);
    const { container, rerender } = renderNpcMinimap(initialState);
    const initialDots = container.querySelectorAll<HTMLImageElement>('img[src="/npc-dot.png"]');
    const bossDot = initialDots[0];
    const addDot = initialDots[1];

    expect(initialDots).toHaveLength(2);

    rerender(
      <TooltipProvider>
        <ContextMenuProvider>
          <Minimap
            simulationState={simulationStateWithNpcs([npcSnapshot('boss', 1), npcSnapshot('spawn', 4)])}
            minimapNpcDotUrl="/npc-dot.png"
            hasSpecialAttack
            onRunToggle={() => {}}
            onSpecialAttackToggle={() => {}}
          />
        </ContextMenuProvider>
      </TooltipProvider>,
    );

    const updatedDots = container.querySelectorAll<HTMLImageElement>('img[src="/npc-dot.png"]');
    expect(updatedDots).toHaveLength(2);
    expect(updatedDots[0]).toBe(bossDot);
    expect(addDot?.isConnected).toBe(false);
  });

  // A queued death reports alive: false from its killing tick but stands until its death animation;
  // its dot goes when that starts, as an ordinary dead NPC's does on its defeat tick.
  it.each([
    { tick: 10, dots: 1 },
    { tick: 11, dots: 0 },
  ])('keeps a standing queued death on the minimap until its death animation (tick $tick)', ({ tick, dots }) => {
    const dying = { ...npcSnapshot('dying', 1, false), deathAnimationTick: 11 };
    const { container } = renderNpcMinimap({ ...simulationStateWithNpcs([dying]), currentTick: tick });

    expect(container.querySelectorAll('img[src="/npc-dot.png"]')).toHaveLength(dots);
  });

  it('uses cached NPC type eligibility and skips a failed type without suppressing later NPCs', () => {
    const types = new Map([
      [1, npcType(1, true, true)],
      [2, npcType(2, false, true)],
      [3, npcType(3, true, false)],
      [5, npcType(5, true, true)],
    ]);
    const load = vi.fn((id: number): NpcType => {
      if (id === 4) throw new Error('cache read failed');
      const type = types.get(id);
      if (!type) throw new Error(`Missing NPC type ${id}`);
      return type;
    });
    const loader = {
      load,
      getCount: () => types.size,
      clearCache: () => {},
    } satisfies NpcTypeLoader;
    const state = simulationStateWithNpcs([
      npcSnapshot('eligible-1', 1),
      npcSnapshot('hidden', 2),
      npcSnapshot('non-interactable', 3),
      npcSnapshot('failed', 4),
      npcSnapshot('eligible-2', 5),
    ]);
    const { container, rerender } = renderNpcMinimap(state, loader);

    expect(container.querySelectorAll('img[src="/npc-dot.png"]')).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(5);

    rerender(
      <TooltipProvider>
        <ContextMenuProvider>
          <Minimap
            simulationState={{ ...state, currentTick: state.currentTick + 1 }}
            npcTypeLoader={loader}
            minimapNpcDotUrl="/npc-dot.png"
            hasSpecialAttack
            onRunToggle={() => {}}
            onSpecialAttackToggle={() => {}}
          />
        </ContextMenuProvider>
      </TooltipProvider>,
    );

    expect(container.querySelectorAll('img[src="/npc-dot.png"]')).toHaveLength(2);
    expect(load).toHaveBeenCalledTimes(5);
  });
});

/**
 * The prayer orb reads TWO prayer states and must not confuse them. The orb's
 * activated icon follows the client prediction, so a click lights it instantly,
 * exactly as the orb lights in game. The flick sweep follows
 * the prediction OR the engine-committed state, because a flick is an off-click
 * and an on-click inside ONE tick: the prediction dips to "no prayer" between
 * them while the prayer is still burning, and a sweep that unmounts there blinks
 * off the orb every tick, precisely while flicking.
 *
 * Driven through a real SimulationEngine rather than hand-fed booleans, so the
 * derivation in Minimap itself is what is under test.
 */
describe('Minimap prayer orb state wiring', () => {
  const renderWithEngine = (engine: SimulationEngine) =>
    render(
      <TooltipProvider>
        <ContextMenuProvider>
          <Minimap
            simulationState={engine.getState()}
            hasSpecialAttack
            onRunToggle={() => {}}
            onSpecialAttackToggle={() => {}}
            prayerEnabled
            prayerFlickOrbEnabled
          />
        </ContextMenuProvider>
      </TooltipProvider>,
    );

  const orbState = (container: HTMLElement) => ({
    sweep: container.querySelector('.prayer-orb-flick-sweep'),
    iconActivated:
      container.querySelector<HTMLCanvasElement>('[role="img"][aria-label="Prayer"]')?.getAttribute('data-src') ===
      MINIMAP.orbPrayerIconActivated,
  });

  it('shows no sweep and no activated icon with no prayer on', () => {
    const { container } = renderWithEngine(new SimulationEngine({ encounter: new LobbyEncounter() }));
    const { sweep, iconActivated } = orbState(container);

    expect(sweep).toBeNull();
    expect(iconActivated).toBe(false);
  });

  it('lights both on the click that turns a prayer on, before the tick commits it', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    const { container } = renderWithEngine(engine);
    const { sweep, iconActivated } = orbState(container);

    expect(sweep).not.toBeNull();
    expect(iconActivated).toBe(true);
  });

  it('keeps the sweep through a flick, where the prediction dips mid-tick', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(engine.getState().playerPosition);
    // The off-click of a flick. Committed state still has the prayer burning for
    // the rest of this tick; only the prediction reads empty.
    engine.queueProtectionPrayer(null);

    const { container } = renderWithEngine(engine);
    const { sweep, iconActivated } = orbState(container);

    expect(sweep).not.toBeNull();
    // The icon is prediction-only on purpose: the click has to register visually.
    expect(iconActivated).toBe(false);
  });

  it('lights both on the click that turns on Rapid Heal alone', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    engine.queueIndependentPrayer(PrayerType.RapidHeal);
    const { container } = renderWithEngine(engine);

    expect(orbState(container)).toEqual({ sweep: expect.anything(), iconActivated: true });
  });

  it('keeps the sweep through a flick of Rapid Heal alone', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    engine.queueIndependentPrayer(PrayerType.RapidHeal);
    engine.advanceTick(engine.getState().playerPosition);
    engine.queueIndependentPrayer(PrayerType.RapidHeal);

    const { container } = renderWithEngine(engine);
    expect(orbState(container)).toEqual({ sweep: expect.anything(), iconActivated: false });
  });

  it('drops the sweep once the off-click commits', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(engine.getState().playerPosition);
    engine.queueProtectionPrayer(null);
    engine.advanceTick(engine.getState().playerPosition);

    const { container } = renderWithEngine(engine);
    expect(orbState(container).sweep).toBeNull();
  });
});

/** A map square whose every tile is overlay `overlayId`, flat and unlit, so each square paints one color. */
function uniformMapSquare(mapX: number, mapY: number, overlayId: number): MapSquareData {
  const tiles = <T,>(make: () => T): T[][] => [Array.from({ length: 64 }, make)];
  const corners = <T,>(make: () => T): T[][] => [Array.from({ length: 65 }, make)];
  return {
    mapX,
    mapY,
    tileHeights: corners(() => new Int32Array(65)),
    tileUnderlays: tiles(() => new Uint16Array(64)),
    tileOverlays: tiles(() => new Int16Array(64).fill(overlayId)),
    tileShapes: tiles(() => new Uint8Array(64)),
    tileRotations: tiles(() => new Uint8Array(64)),
    tileRenderFlags: tiles(() => new Uint8Array(64)),
    tileLightOcclusions: corners(() => new Uint8Array(65)),
  };
}

/** Overlay 1 a dark red, overlay 2 a light green: two squares told apart by their pixels. */
const OVERLAY_LOADER: OverlayTypeLoader = {
  load: (id: number) => {
    const type = new OverlayType(id, TEST_CACHE_INFO);
    type.color = 1;
    [type.hue, type.saturation, type.lightness] = id === 0 ? [0, 200, 60] : [20, 200, 180];
    return type;
  },
  getCount: () => 2,
  clearCache: () => {},
};

describe('Minimap terrain across map squares', () => {
  const NORTH_ARENA = getMapSquareBlock([
    { dx: 0, dy: 0 },
    { dx: 0, dy: 1 },
  ]);
  const painted: ImageData[] = [];

  afterEach(() => {
    cleanup();
    painted.length = 0;
    vi.restoreAllMocks();
  });

  /** Records every bitmap the minimap puts on its canvas; the rest of the 2D context is inert. */
  function capturePaints(): void {
    const context = new Proxy({} as CanvasRenderingContext2D, {
      get: (_target, key) => (key === 'putImageData' ? (image: ImageData) => painted.push(image) : () => {}),
      set: () => true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
  }

  function renderTerrain(
    loadMapSquare: (mapX: number, mapY: number) => Promise<MapSquareData | null>,
    mapSquare?: { x: number; y: number },
    arenaBlock?: readonly MapSquareBlockEntry[],
  ) {
    const simulationState = new SimulationEngine({ encounter: new LobbyEncounter() }).getState();
    const tree = (square = mapSquare, block = arenaBlock) => (
      <TooltipProvider>
        <ContextMenuProvider>
          <Minimap
            simulationState={{ ...simulationState, playerPosition: [28, 63] }}
            mapLoader={{ loadMapSquare } as unknown as MapLoader}
            overlayLoader={OVERLAY_LOADER}
            mapSquare={square}
            arenaBlock={block}
            hasSpecialAttack
            onRunToggle={() => {}}
            onSpecialAttackToggle={() => {}}
          />
        </ContextMenuProvider>
      </TooltipProvider>
    );
    const view = render(tree());
    return {
      ...view,
      canvas: minimapParts(view.container).canvas,
      rerenderWith: (square = mapSquare, block = arenaBlock) => view.rerender(tree(square, block)),
    };
  }

  const pixelAt = (image: ImageData, x: number, y: number) => new Uint32Array(image.data.buffer)[y * image.width + x];

  it('loads only the arena squares and composes them north up into one 256x512 bitmap', async () => {
    capturePaints();
    const loadMapSquare = vi.fn(async (mapX: number, mapY: number) =>
      uniformMapSquare(mapX, mapY, mapY === 48 ? 1 : 2),
    );
    const { canvas } = renderTerrain(loadMapSquare, { x: 35, y: 47 }, NORTH_ARENA);

    await waitFor(() => expect(painted).toHaveLength(1));
    expect(loadMapSquare.mock.calls).toEqual([
      [35, 47],
      [35, 48],
    ]);
    expect([canvas?.width, canvas?.height]).toEqual([256, 512]);
    // Laid out at the single square's CSS px per pixel, so it is twice the aperture's height, not squeezed into it.
    expect([canvas?.style.width, canvas?.style.height]).toEqual(['100%', '200%']);

    const [image] = painted;
    const north = pixelAt(image, 114, 0);
    const south = pixelAt(image, 114, 511);
    expect(north).not.toBe(south);
    expect(north >>> 24).toBe(0xff);
    // Adjacent rows across the seam: tile y 64's last pixel row, then tile y 63's first.
    expect(pixelAt(image, 114, 255)).toBe(north);
    expect(pixelAt(image, 114, 256)).toBe(south);
  });

  it('leaves a missing square black and transparent rather than shifting the other', async () => {
    capturePaints();
    const loadMapSquare = vi.fn(async (mapX: number, mapY: number) =>
      mapY === 48 ? null : uniformMapSquare(mapX, mapY, 2),
    );
    renderTerrain(loadMapSquare, { x: 35, y: 47 }, NORTH_ARENA);

    await waitFor(() => expect(painted).toHaveLength(1));
    expect(pixelAt(painted[0], 114, 255)).toBe(0);
    expect(pixelAt(painted[0], 114, 256) >>> 24).toBe(0xff);
  });

  it('never paints a load that finishes after the footprint changed', async () => {
    capturePaints();
    let finishFirst: (() => void) | undefined;
    const loadMapSquare = vi.fn((mapX: number, mapY: number) =>
      mapX === 23
        ? new Promise<MapSquareData>((resolve) => {
            finishFirst = () => resolve(uniformMapSquare(mapX, mapY, 1));
          })
        : Promise.resolve(uniformMapSquare(mapX, mapY, 2)),
    );
    const { rerenderWith } = renderTerrain(loadMapSquare, { x: 23, y: 157 });
    rerenderWith({ x: 35, y: 47 }, NORTH_ARENA);
    await waitFor(() => expect(painted).toHaveLength(1));
    await act(async () => finishFirst?.());

    expect(painted).toHaveLength(1);
    expect([painted[0].width, painted[0].height]).toEqual([256, 512]);
  });

  it("keeps the previous encounter's terrain off the new map while the new one loads", async () => {
    capturePaints();
    const pendingNorthArena: (() => void)[] = [];
    const loadMapSquare = vi.fn((mapX: number, mapY: number) =>
      mapX === 35
        ? new Promise<MapSquareData>((resolve) => {
            pendingNorthArena.push(() => resolve(uniformMapSquare(mapX, mapY, 2)));
          })
        : Promise.resolve(uniformMapSquare(mapX, mapY, 1)),
    );
    const { rerenderWith } = renderTerrain(loadMapSquare, { x: 23, y: 157 });
    await waitFor(() => expect(painted).toHaveLength(1));

    rerenderWith({ x: 35, y: 47 }, NORTH_ARENA);
    // The new raster shows its placeholder grid, not the old square's terrain in the new layout.
    expect(painted).toHaveLength(1);
    await act(async () => {
      for (const finish of pendingNorthArena) finish();
    });

    await waitFor(() => expect(painted).toHaveLength(2));
    expect([painted[1].width, painted[1].height]).toEqual([256, 512]);
  });

  it('requests only the Inferno origin square, though its scene has five', async () => {
    capturePaints();
    const footprint = getEncounterMapFootprint('inferno');
    if (!footprint) throw new Error('no Inferno footprint');
    expect(footprint.sceneOffsets).toHaveLength(5);
    const loadMapSquare = vi.fn(async (mapX: number, mapY: number) => uniformMapSquare(mapX, mapY, 1));
    const { canvas } = renderTerrain(loadMapSquare, footprint.origin, footprint.arenaBlock);

    await waitFor(() => expect(painted).toHaveLength(1));
    expect(loadMapSquare.mock.calls).toEqual([[35, 83]]);
    expect([canvas?.width, canvas?.height]).toEqual([256, 256]);
  });

  it('keeps the default single square at its exact geometry', async () => {
    capturePaints();
    const loadMapSquare = vi.fn(async (mapX: number, mapY: number) => uniformMapSquare(mapX, mapY, 1));
    const { canvas } = renderTerrain(loadMapSquare);

    await waitFor(() => expect(painted).toHaveLength(1));
    expect(loadMapSquare.mock.calls).toEqual([[23, 157]]);
    expect([canvas?.width, canvas?.height, canvas?.style.width, canvas?.style.height]).toEqual([
      256,
      256,
      '100%',
      '100%',
    ]);
    // The player (28, 63) at the 154 px aperture's center, at the default zoom 4, by the pre-multi-square formula.
    const px = 28 * 4 + 2;
    const py = (63 - 63) * 4 + 2;
    expect(canvas?.style.transform).toBe(
      `translate(${77 - (px / 256) * 154}px, ${77 - (py / 256) * 154}px) scale(${minimapCssScale(4, 154)}) rotate(180deg)`,
    );
    expect(canvas?.style.transformOrigin).toBe(`${(px / 256) * 100}% ${(py / 256) * 100}%`);
  });
});
