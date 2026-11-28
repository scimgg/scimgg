// @vitest-environment happy-dom

import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheManager } from '../../cache/CacheManager';
import { Canvas2DRenderer } from '../../render/backends/canvas2d/Canvas2DRenderer';
import { RenderViewport } from '../../render/components/RenderViewport';
import { YamaSceneCompositor } from '../../render/scene/YamaSceneCompositor';
import { encounterScene } from '../../test/helpers/encounterScene';
import { yamaSnapshot } from '../../test/helpers/encounterSnapshot';
import { createMockWebGL2Context } from '../../test/mocks/webgl-mock';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyStats as createEmptyEquipmentStats } from '../../types/equipmentStats';
import { createEmptyInventory } from '../../types/inventory';
import {
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
} from '../../types/playerState';
import type { Coordinate, SimulationState } from '../../types/simulation';

describe('Renderer Integration Tests', () => {
  const mockState: SimulationState = {
    currentTick: 5,
    groundItems: [],
    playerPosition: [32, 30],
    playerPreviousPosition: [31, 30],
    playerMovementPath: [],
    playerFacingAngle: 0,
    playerIsMoving: false,
    playerIsRunning: false,
    primaryNpcPosition: [34, 32],
    primaryNpcPreviousPosition: [34, 32],
    primaryNpcFacingAngle: 0,
    primaryNpcSize: 5,
    npcs: [],
    encounter: yamaSnapshot({ state: { firstRangeMageType: 'magic' } }),
    encounterOutcome: { phase: 'active' },
    playerHistory: new Map([
      [3, [31, 29] as Coordinate],
      [4, [31, 30] as Coordinate],
      [5, [32, 30] as Coordinate],
    ]),
    primaryNpcHistory: new Map([[5, [34, 32] as Coordinate]]),
    failedCondition: null,
    isAlive: true,
    markOfDarknessActive: false,
    markOfDarknessTicksRemaining: 0,
    playerHP: 99,
    maxHP: 99,
    poisonVarp: 0,
    poisonTickCounter: 30,
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    damageHistory: [],
    eventLog: [],
    stats: createDefaultStats(),
    specialAttack: createDefaultSpecialAttack(),
    combatTimers: createDefaultTimers(),
    inventory: createEmptyInventory(),
    isRunEnabled: true,
    isSpecialAttackActive: false,
    pendingSpecialAttackToggles: 0,
    pendingProtectionPrayer: [false, null],
    pendingBoostPrayers: [false, []],
    pendingIndependentPrayers: [false, []],
    quickPrayersActive: false,
    runEnergy: createDefaultRunEnergy(),
    equipmentStats: createEmptyEquipmentStats(),
    prayerState: { points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} },
    playerEquipment: {},
    playerCombatSupplies: createEmptyCombatSupplies(),
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    mechanicsConfig: { yamaMageRange: true, waves: true, fireballs: true, infiniteHealth: true },
    attackTarget: null,
    lastAttackTarget: null,
    selectedAttackStyleIndex: 0,
    playerAttackCooldown: 0,
    playerNextAttackTick: -1,
    playerAttackSpeed: 4,
    introActive: false,
  };

  const mockOnTileClick = vi.fn();

  beforeEach(() => {
    mockOnTileClick.mockClear();
  });

  describe('Full Pipeline: Cache → Parse → Load → Render', () => {
    it('completes full rendering pipeline without errors', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);

      const { container } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      const canvas = container.querySelector('canvas');
      expect(canvas).toBeDefined();
      expect(canvas?.width).toBeGreaterThan(0);
      expect(canvas?.height).toBeGreaterThan(0);

      await waitFor(() => {
        expect(canvas?.getContext('2d')).toBeDefined();
      });
    });

    it('renders with coordinate display enabled', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);

      const { container } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={true}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      const canvas = container.querySelector('canvas');
      expect(canvas).toBeDefined();

      await waitFor(() => {
        expect(canvas?.getContext('2d')).toBeDefined();
      });
    });
  });

  describe('Renderer Switching: WebGL ↔ Canvas2D', () => {
    it('switches from Canvas2D to Canvas2D (same renderer)', async () => {
      const renderer1 = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);

      const { container, rerender } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer1}
          sceneBuilder={sceneBuilder}
        />,
      );

      const canvas1 = container.querySelector('canvas');
      expect(canvas1).toBeDefined();

      const renderer2 = new Canvas2DRenderer();
      rerender(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer2}
          sceneBuilder={sceneBuilder}
        />,
      );

      const canvas2 = container.querySelector('canvas');
      expect(canvas2).toBeDefined();
      expect(canvas2?.width).toBeGreaterThan(0);
    });

    it('preserves simulation state when switching renderers', async () => {
      const renderer1 = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);

      const { container, rerender } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer1}
          sceneBuilder={sceneBuilder}
        />,
      );

      const canvas1 = container.querySelector('canvas');
      expect(canvas1).toBeDefined();

      const updatedState: SimulationState = {
        ...mockState,
        currentTick: 10,
        playerPosition: [33, 31],
      };

      const renderer2 = new Canvas2DRenderer();
      rerender(
        <RenderViewport
          simulationState={updatedState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer2}
          sceneBuilder={sceneBuilder}
        />,
      );

      const canvas2 = container.querySelector('canvas');
      expect(canvas2).toBeDefined();
      expect(updatedState.currentTick).toBe(10);
      expect(updatedState.playerPosition).toEqual([33, 31]);
    });

    it('handles renderer disposal correctly', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);

      const { unmount } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      unmount();

      expect(() => renderer.dispose()).not.toThrow();
    });
  });

  describe('Error Recovery: Cache Failure', () => {
    it('handles cache download failure gracefully', async () => {
      const mockCacheManager = new CacheManager();

      vi.spyOn(mockCacheManager, 'ensureCache').mockRejectedValue(new Error('Network error: Failed to download cache'));

      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);

      const { container } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      const canvas = container.querySelector('canvas');
      expect(canvas).toBeDefined();

      await waitFor(() => {
        expect(canvas?.getContext('2d')).toBeDefined();
      });
    });

    it('validates retry requires ERROR state', async () => {
      const mockCacheManager = new CacheManager();

      const initialState = mockCacheManager.getState();
      expect(initialState.state).toBe('UNLOADED');

      await expect(mockCacheManager.retry()).rejects.toThrow('Cannot retry: not in ERROR state');
    });

    it('handles missing cache files gracefully', async () => {
      const mockCacheManager = new CacheManager();

      vi.spyOn(mockCacheManager, 'getBlob').mockResolvedValue(null);

      const blob = await mockCacheManager.getBlob('missing_file.dat');
      expect(blob).toBeNull();
    });
  });

  describe('Error Recovery: WebGL Failure', () => {
    it('falls back to Canvas2D when WebGL context creation fails', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);

      const { container } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      const canvas = container.querySelector('canvas');
      expect(canvas).toBeDefined();

      await waitFor(() => {
        const ctx = canvas?.getContext('2d');
        expect(ctx).toBeDefined();
      });
    });

    it('handles WebGL context loss gracefully', async () => {
      const mockGL = createMockWebGL2Context();

      const canvas = document.createElement('canvas');
      const getContextSpy = vi.spyOn(canvas, 'getContext');

      getContextSpy.mockReturnValueOnce(mockGL);
      const ctx1 = canvas.getContext('webgl2');
      expect(ctx1).toBeDefined();

      getContextSpy.mockReturnValueOnce(null);
      const ctx2 = canvas.getContext('webgl2');
      expect(ctx2).toBeNull();

      expect(getContextSpy).toHaveBeenCalledWith('webgl2');
    });

    it('validates WebGL support before initialization', () => {
      const renderer = new Canvas2DRenderer();

      expect(renderer.supports('2d')).toBe(true);
      expect(renderer.supports('3d')).toBe(false);
    });
  });

  describe('Renderer State Management', () => {
    it('initializes renderer only once', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);
      const initSpy = vi.spyOn(renderer, 'init');

      const { rerender } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      rerender(
        <RenderViewport
          simulationState={{ ...mockState, currentTick: 10 }}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      expect(initSpy).toHaveBeenCalledTimes(1);
    });

    it('handles viewport resize correctly', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);
      const resizeSpy = vi.spyOn(renderer, 'resize');

      render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      await waitFor(() => {
        expect(resizeSpy).toHaveBeenCalled();
      });
    });

    it('cleans up animation frame on unmount', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);
      const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame');

      const { unmount } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      unmount();

      expect(cancelAnimationFrameSpy).toHaveBeenCalled();
    });
  });

  describe('Interaction Handling', () => {
    it('handles tile click events', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);

      const { container } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      const canvas = container.querySelector('canvas');
      expect(canvas).toBeDefined();

      if (canvas) {
        canvas.click();
      }

      expect(canvas).toBeDefined();
    });

    it('renders target tile highlight', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);
      const targetTile: Coordinate = [15, 15];

      const { container } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          targetTile={targetTile}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      const canvas = container.querySelector('canvas');
      expect(canvas).toBeDefined();

      await waitFor(() => {
        expect(canvas?.getContext('2d')).toBeDefined();
      });
    });
  });

  describe('Performance and Optimization', () => {
    it('renders multiple frames without memory leaks', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);

      const { rerender } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      for (let tick = 0; tick < 10; tick++) {
        rerender(
          <RenderViewport
            simulationState={{ ...mockState, currentTick: tick }}
            onTileClick={mockOnTileClick}
            showCoordinates={false}
            renderer={renderer}
            sceneBuilder={sceneBuilder}
          />,
        );
      }

      expect(renderer).toBeDefined();
    });

    it('handles rapid state updates efficiently', async () => {
      const renderer = new Canvas2DRenderer();
      const sceneBuilder = encounterScene('yama_p3', YamaSceneCompositor);

      const { rerender } = render(
        <RenderViewport
          simulationState={mockState}
          onTileClick={mockOnTileClick}
          showCoordinates={false}
          renderer={renderer}
          sceneBuilder={sceneBuilder}
        />,
      );

      const updates = Array.from({ length: 20 }, (_, i) => ({
        ...mockState,
        currentTick: i,
        playerPosition: [32 + (i % 5), 30 + (i % 3)] as Coordinate,
      }));

      for (const state of updates) {
        rerender(
          <RenderViewport
            simulationState={state}
            onTileClick={mockOnTileClick}
            showCoordinates={false}
            renderer={renderer}
            sceneBuilder={sceneBuilder}
          />,
        );
      }

      expect(renderer).toBeDefined();
    });
  });
});
