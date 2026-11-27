import { afterEach, describe, expect, it, vi } from 'vitest';
import { setArenaConfig } from '../../../../core/constants';
import { SimulationEngine } from '../../../../core/SimulationEngine';
import { LobbyEncounter } from '../../../../encounters/lobby/LobbyEncounter';
import type { SimulationState } from '../../../../types/simulation';
import { animationFrames } from '../../../../util/animationFrames';
import type { Projection2D } from '../../../core/camera';
import { SceneCompositor } from '../../SceneCompositor';
import type { RenderContext } from '../../types';
import { LobbySceneCompositor } from '../LobbySceneCompositor';

const projection: Projection2D = {
  tileToScreen: (tile) => tile,
  tileDeltaToScreen: (delta) => delta,
  screenToTile: () => null,
  tilePolygonScreen: (tile) => [tile, tile, tile, tile],
};

const scenes: SceneCompositor[] = [];
afterEach(() => {
  for (const scene of scenes.splice(0)) scene.dispose();
  vi.restoreAllMocks();
  animationFrames.setSuspended(false);
  animationFrames.clock.reset();
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

/** `scene` drawn live at `interpolatedTick`, its simulation on `currentTick`. */
function drawing<Scene extends SceneCompositor>(scene: Scene) {
  scenes.push(scene);
  const state: SimulationState = new SimulationEngine({ encounter: new LobbyEncounter(), combatSeed: 1 }).getState();
  const draw = (currentTick: number, interpolatedTick: number, overrides: Partial<RenderContext> = {}) =>
    scene.build(
      {
        simulationState: { ...state, currentTick, npcs: [] },
        events: [],
        options: {
          renderMode: '3d',
          showCoordinates: false,
          showNpcClickbox: false,
          showTileMarkers: false,
          showTileMarkerLabels: false,
          showLineMarkers: false,
          showLineMarkerLabels: false,
          smoothTerrain: false,
          brightness: 1,
          contrast: 1,
          saturation: 1,
          encounterDebugFlags: {},
        },
        interaction: { hoveredTile: null, targetTile: null },
        interpolatedTick,
        speedMultiplier: 1,
        ...overrides,
      },
      projection,
      { width: 800, height: 600, dpr: 1 },
    );
  const animations = vi.spyOn(scene['npcInstanceManager'], 'updateAnimations');
  const advancedMs = () => animations.mock.calls.reduce((total, [deltaMs, speed]) => total + deltaMs * speed, 0);
  return { scene, draw, animations, advancedMs };
}

describe('lobby NPC presentation by frame time', () => {
  // The run's tick holds through the landing intro and while a modal pauses it, and the viewport's
  // interpolation stops a tick past it. An encounter's NPCs hold there on the NPC clock; the lobby's
  // display bosses keep idling.
  it('keeps the display bosses animating while the simulation tick is held, where an encounter scene holds', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const lobby = drawing(new LobbySceneCompositor(0, 0, 0));
    const encounter = drawing(new SceneCompositor());
    for (const [index, timeMs] of [1000, 1400, 1800, 2200, 2600].entries()) {
      now.mockReturnValue(timeMs);
      const interpolatedTick = Math.min(1, index * 0.5);
      lobby.draw(0, interpolatedTick);
      encounter.draw(0, interpolatedTick);
    }

    expect(lobby.advancedMs()).toBe(1600);
    expect(encounter.advancedMs()).toBe(600);
  });

  it.each([500, 60_000])('excludes a %s ms pause at the animation and facing consumers', (pauseMs) => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const { scene, draw, animations } = drawing(new LobbySceneCompositor(0, 0, 0));
    const facing = vi.fn(scene['updateEncounterNpcFacing'].bind(scene));
    scene['updateEncounterNpcFacing'] = facing;
    const at = () => draw(0, 0, { speedMultiplier: 2 });

    at();
    now.mockReturnValue(1100);
    at();
    now.mockReturnValue(1150);
    animationFrames.setSuspended(true);
    now.mockReturnValue(1150 + pauseMs);
    animationFrames.setSuspended(false);
    now.mockReturnValue(1250 + pauseMs);
    at();
    now.mockReturnValue(1275 + pauseMs);
    at();

    expect(animations.mock.calls.map(([deltaMs, speed]) => [deltaMs, speed])).toEqual([
      [0, 2],
      [100, 2],
      [150, 2],
      [25, 2],
    ]);
    expect(facing.mock.calls.map(([, deltaMs]) => deltaMs)).toEqual([0, 200, 300, 50]);
  });

  it('retains the zero sentinel, active-time stall guard and dispose reset', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const { scene, draw, animations } = drawing(new LobbySceneCompositor(0, 0, 0));

    for (const timeMs of [0, 100, 1100, 2101, 2201, 2201, 2190]) {
      now.mockReturnValue(timeMs);
      draw(0, 0);
    }
    expect(animations.mock.calls.map(([deltaMs]) => deltaMs)).toEqual([0, 0, 0, 0, 100, 0, 0]);

    scene.dispose();
    now.mockReturnValue(2300);
    draw(0, 0);
    expect(animations.mock.lastCall?.[0]).toBe(0);
  });
});
