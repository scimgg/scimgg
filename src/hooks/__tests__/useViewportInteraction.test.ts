// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import type { SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '../../core/events/types';
import type { SimulationEngine } from '../../core/SimulationEngine';
import { LOBBY_NPC_ENCOUNTERS } from '../../encounters/lobby/metadata';
import { tickBus } from '../../tutorial/runtime/tickBus';
import type { GroundItem } from '../../types/groundItems';
import type { Coordinate, SimulationState } from '../../types/simulation';
import type { UseReplayReturn } from '../useReplay';
import type { SceneState } from '../useSimulationWiring';
import { useViewportInteraction } from '../useViewportInteraction';

const TEST_REPLAY_UI_STATE = { activeGamePanelTab: 'inventory' } as const;

function makeState(
  tick: number,
  playerPosition: Coordinate = [31, 37],
  groundItems: GroundItem[] = [],
): SimulationState {
  return {
    currentTick: tick,
    playerPosition,
    inventory: [],
    playerEquipment: {},
    groundItems,
  } as unknown as SimulationState;
}

function makePile(id: string, position: Coordinate): GroundItem {
  return { id, itemId: 385, quantity: 1, position, droppedTick: 0 };
}

function makeReplay(): UseReplayReturn {
  return {
    replayMode: false,
    recordAction: vi.fn(),
    recordFrame: vi.fn(),
  } as unknown as UseReplayReturn;
}

function makeEngine(paused: boolean, events: GameEvent[] = []): SimulationEngine {
  const state = makeState(1);
  return {
    applyAction: vi.fn(),
    acceptsEncounterInput: vi.fn(() => false),
    advanceTick: vi.fn(),
    canAdvance: vi.fn(() => true),
    didLastTickDiscardWalkTarget: vi.fn(() => false),
    getLastTickEvents: vi.fn(() => events),
    getState: vi.fn(() => state),
    isTutorialPaused: vi.fn(() => paused),
    setCtrlClickOverride: vi.fn(),
  } as unknown as SimulationEngine;
}

interface RenderInteractionOptions {
  replay?: UseReplayReturn;
  groundItems?: GroundItem[];
  sceneState?: SceneState;
  armedSpell?: string | null;
  initialTargetTile?: Coordinate | null;
  dispatchInput?: (apply: () => void) => void;
  previewTargetTile?: (target: Coordinate | null) => () => void;
  setArmedSpell?: (value: SetStateAction<string | null>) => void;
  graphicsHeld?: boolean;
}

function renderInteraction(engine: SimulationEngine, options: RenderInteractionOptions = {}) {
  const replay = options.replay ?? makeReplay();
  const groundItems = options.groundItems ?? [];
  const sceneState = options.sceneState ?? ({ kind: 'encounter', encounterKind: 'yama_p3' } as SceneState);
  const targetTileRef = { current: options.initialTargetTile ?? null };
  const setSimulationState = vi.fn();
  const publishEngineState = vi.fn();
  // Applies updaters as React's setter would, so a test can read what was committed.
  const committedTargetTile: { current: Coordinate | null } = { current: options.initialTargetTile ?? null };
  const setTargetTile = vi.fn((value: SetStateAction<Coordinate | null>) => {
    committedTargetTile.current = typeof value === 'function' ? value(committedTargetTile.current) : value;
  });
  const onSelectLobbyEncounter = vi.fn();
  const onEnterEncounter = vi.fn();
  const setArmedSpell = options.setArmedSpell ?? vi.fn();
  const previewTargetTile = options.previewTargetTile ?? vi.fn(() => vi.fn());

  const hook = renderHook(
    ({ graphicsHeld }: { graphicsHeld: boolean }) =>
      useViewportInteraction({
        autoAdvance: false,
        graphicsHeld,
        engineRef: { current: engine },
        dispatchInput: options.dispatchInput ?? ((apply: () => void) => apply()),
        onEnterEncounter,
        onSelectLobbyEncounter,
        replay,
        getReplayUiState: () => TEST_REPLAY_UI_STATE,
        sceneState,
        publishEngineState,
        setSimulationState,
        setTargetTile,
        simulationState: makeState(0, [31, 37], groundItems),
        targetTileRef,
        armedSpell: options.armedSpell ?? null,
        setArmedSpell,
        previewTargetTile,
      }),
    { initialProps: { graphicsHeld: options.graphicsHeld ?? false } },
  );

  return {
    ...hook,
    replay,
    setSimulationState,
    publishEngineState,
    setTargetTile,
    committedTargetTile,
    targetTileRef,
    onSelectLobbyEncounter,
    onEnterEncounter,
    setArmedSpell,
    previewTargetTile,
  };
}

const LOBBY_SCENE = { kind: 'lobby' } as SceneState;

const STATUE_WITH_CARD = Object.keys(LOBBY_NPC_ENCOUNTERS)[0];

/**
 * A lobby statue backed by no card. Every shipped statue currently has one, so this is synthetic:
 * the guard it exercises is what keeps a future card-less statue (a withheld or teaser boss) from
 * being attacked as an NPC.
 */
const STATUE_WITHOUT_CARD = { actorId: 'lobby-npc-99', position: [20, 30] as Coordinate };

describe('useViewportInteraction', () => {
  it('does not manually advance ticks while tutorials are paused', () => {
    const engine = makeEngine(true);
    const { result, replay, publishEngineState } = renderInteraction(engine);

    act(() => {
      result.current.handleTileClick([32, 37]);
    });

    expect(engine.advanceTick).not.toHaveBeenCalled();
    expect(replay.recordFrame).not.toHaveBeenCalled();
    expect(publishEngineState).not.toHaveBeenCalled();
  });

  it('publishes tickBus events after an unpaused manual tick', () => {
    const events = [{ eventId: 1, tick: 1, type: 'manual_tick' } satisfies GameEvent];
    const engine = makeEngine(false, events);
    const { result, replay, publishEngineState } = renderInteraction(engine);
    const listener = vi.fn();
    const unsubscribe = tickBus.subscribe(listener);

    try {
      act(() => {
        result.current.handleTileClick([32, 37]);
      });

      expect(engine.advanceTick).toHaveBeenCalledWith([32, 37]);
      expect(replay.recordFrame).toHaveBeenCalledWith(1, [32, 37], makeState(1), events, TEST_REPLAY_UI_STATE);
      expect(publishEngineState).toHaveBeenCalledWith(makeState(1));
      expect(listener).toHaveBeenCalledWith(1, events);
    } finally {
      unsubscribe();
    }
  });

  it('walks to the pile and queues the take, in that order', () => {
    const engine = makeEngine(false);
    const pile = makePile('gi-1', [20, 25]);
    const { result, replay, setTargetTile, targetTileRef } = renderInteraction(engine, {
      replay: makeReplay(),
      groundItems: [pile],
    });

    act(() => {
      result.current.handleTakeGroundItem('gi-1');
    });

    expect(setTargetTile).toHaveBeenCalledWith([20, 25]);
    expect(targetTileRef.current).toEqual([20, 25]);

    // Clearing the attack target also drops any pickup already in flight, so the
    // take has to be queued AFTER it or it would cancel itself.
    const applied = vi.mocked(engine.applyAction).mock.calls.map(([action]) => action);
    expect(applied).toEqual([
      { type: 'attackTarget', targetId: null },
      { type: 'pickupGroundItem', groundItemId: 'gi-1' },
    ]);
    // Recorded in the same order, so a replay reproduces the click exactly.
    const recordedTypes = vi
      .mocked(replay.recordAction)
      .mock.calls.map(([action]) => (action as { type: string }).type);
    expect(recordedTypes).toEqual(['ctrlClick', 'attackTarget', 'pickupGroundItem']);
  });

  it('ignores a take for a pile that is no longer on the floor', () => {
    const engine = makeEngine(false);
    const { result, setTargetTile } = renderInteraction(engine, { replay: makeReplay() });

    act(() => {
      result.current.handleTakeGroundItem('gi-gone');
    });

    expect(engine.applyAction).not.toHaveBeenCalled();
    expect(setTargetTile).not.toHaveBeenCalled();
  });

  it('ignores a take while replaying', () => {
    const engine = makeEngine(false);
    const replay = { ...makeReplay(), replayMode: true } as UseReplayReturn;
    const pile = makePile('gi-1', [20, 25]);
    const { result } = renderInteraction(engine, { replay, groundItems: [pile] });

    act(() => {
      result.current.handleTakeGroundItem('gi-1');
    });

    expect(engine.applyAction).not.toHaveBeenCalled();
  });

  it('opens the encounter card for a lobby statue that still has one', () => {
    const engine = makeEngine(false);
    const { result, onSelectLobbyEncounter } = renderInteraction(engine, {
      replay: makeReplay(),
      sceneState: LOBBY_SCENE,
    });

    act(() => {
      result.current.handleTileClick([20, 30], false, STATUE_WITH_CARD);
    });

    expect(onSelectLobbyEncounter).toHaveBeenCalledWith(LOBBY_NPC_ENCOUNTERS[STATUE_WITH_CARD]);
    expect(engine.applyAction).not.toHaveBeenCalled();
    expect(engine.advanceTick).not.toHaveBeenCalled();
  });

  it('swallows a click on a card-less lobby statue instead of opening a card or attacking it', () => {
    expect(LOBBY_NPC_ENCOUNTERS[STATUE_WITHOUT_CARD.actorId]).toBeUndefined();

    const engine = makeEngine(false);
    const { result, onSelectLobbyEncounter } = renderInteraction(engine, {
      replay: makeReplay(),
      sceneState: LOBBY_SCENE,
    });

    act(() => {
      result.current.handleTileClick(STATUE_WITHOUT_CARD.position, false, STATUE_WITHOUT_CARD.actorId);
    });

    expect(onSelectLobbyEncounter).not.toHaveBeenCalled();
    expect(engine.applyAction).not.toHaveBeenCalled();
    expect(engine.advanceTick).not.toHaveBeenCalled();
  });

  it('still attacks a clicked NPC outside the lobby', () => {
    const engine = makeEngine(false);
    const { result } = renderInteraction(engine);

    act(() => {
      result.current.handleTileClick([32, 37], false, 'yama');
    });

    expect(engine.applyAction).toHaveBeenCalledWith({ type: 'attackTarget', targetId: 'yama' });
  });

  it('records a claimed NPC interaction from an ordinary click', () => {
    const engine = makeEngine(false);
    vi.mocked(engine.acceptsEncounterInput).mockReturnValue(true);
    const { result, replay } = renderInteraction(engine);

    act(() => result.current.handleTileClick([28, 52], false, 'duke'));

    const action = { type: 'npcInteraction', targetId: 'duke' };
    expect(engine.applyAction).toHaveBeenCalledExactlyOnceWith(action);
    expect(replay.recordAction).toHaveBeenLastCalledWith(action);
  });

  it('preserves the armed spell when a clicked NPC only offers a claimed interaction', () => {
    const engine = makeEngine(false);
    vi.mocked(engine.acceptsEncounterInput).mockReturnValue(true);
    const { result, replay, setArmedSpell } = renderInteraction(engine, { armedSpell: 'Fire Surge' });

    act(() => result.current.handleTileClick([28, 52], false, 'duke'));

    expect(setArmedSpell).not.toHaveBeenCalled();
    expect(engine.applyAction).not.toHaveBeenCalled();
    expect(replay.recordAction).not.toHaveBeenCalled();
  });

  it('shows a walk destination immediately while movement remains buffered', () => {
    const engine = makeEngine(false);
    const pendingInputs: Array<() => void> = [];
    const retireTargetPreview = vi.fn();
    const previewTargetTile = vi.fn(() => retireTargetPreview);
    const { result, setTargetTile, committedTargetTile, targetTileRef } = renderInteraction(engine, {
      dispatchInput: (apply) => pendingInputs.push(apply),
      previewTargetTile,
    });

    act(() => result.current.handleTileClick([32, 37]));

    expect(previewTargetTile).toHaveBeenCalledWith([32, 37]);
    expect(setTargetTile).not.toHaveBeenCalled();
    expect(targetTileRef.current).toBeNull();
    expect(pendingInputs).toHaveLength(1);
    expect(engine.applyAction).not.toHaveBeenCalled();

    act(() => pendingInputs[0]());

    expect(targetTileRef.current).toEqual([32, 37]);
    expect(setTargetTile).toHaveBeenCalledOnce();
    expect(committedTargetTile.current).toEqual([32, 37]);
    expect(retireTargetPreview).toHaveBeenCalledOnce();
  });

  it('keeps the committed destination for a re-tapped tile while still sending every click', () => {
    const engine = makeEngine(false);
    const retireTargetPreview = vi.fn();
    const previewTargetTile = vi.fn(() => retireTargetPreview);
    const { result, replay, committedTargetTile } = renderInteraction(engine, { previewTargetTile });

    act(() => result.current.handleTileClick([32, 37]));
    const committed = committedTargetTile.current;
    act(() => result.current.handleTileClick([32, 37], true));
    act(() => result.current.handleTileClick([32, 37]));

    // An equal destination keeps the committed array, so nothing downstream sees a new tile.
    expect(committedTargetTile.current).toBe(committed);
    // Every tap still previews, overrides, records and reaches the engine.
    expect(previewTargetTile).toHaveBeenCalledTimes(3);
    expect(retireTargetPreview).toHaveBeenCalledTimes(3);
    expect(vi.mocked(engine.setCtrlClickOverride).mock.calls).toEqual([[false], [true], [false]]);
    expect(engine.applyAction).toHaveBeenCalledTimes(3);
    expect(engine.advanceTick).toHaveBeenCalledTimes(3);
    expect(replay.recordAction).toHaveBeenCalledTimes(6);

    act(() => result.current.handleTileClick([33, 37]));

    expect(committedTargetTile.current).toEqual([33, 37]);
    expect(committedTargetTile.current).not.toBe(committed);
  });

  it('clears the walk destination immediately when targeting an NPC', () => {
    const engine = makeEngine(false);
    const pendingInputs: Array<() => void> = [];
    const retireTargetPreview = vi.fn();
    const previewTargetTile = vi.fn(() => retireTargetPreview);
    const { result, setTargetTile, targetTileRef } = renderInteraction(engine, {
      initialTargetTile: [33, 37],
      dispatchInput: (apply) => pendingInputs.push(apply),
      previewTargetTile,
    });

    act(() => result.current.handleTileClick([32, 37], false, 'yama'));

    expect(previewTargetTile).toHaveBeenCalledWith(null);
    expect(setTargetTile).not.toHaveBeenCalled();
    expect(targetTileRef.current).toEqual([33, 37]);
    expect(pendingInputs).toHaveLength(1);
    expect(engine.applyAction).not.toHaveBeenCalled();

    act(() => pendingInputs[0]());

    expect(targetTileRef.current).toBeNull();
    expect(setTargetTile).toHaveBeenCalledWith(null);
    expect(retireTargetPreview).toHaveBeenCalledOnce();
  });

  it('shows a ground-item walk destination immediately while the take remains buffered', () => {
    const engine = makeEngine(false);
    const pendingInputs: Array<() => void> = [];
    const pile = makePile('gi-1', [20, 25]);
    const retireTargetPreview = vi.fn();
    const previewTargetTile = vi.fn(() => retireTargetPreview);
    const { result, setTargetTile, targetTileRef } = renderInteraction(engine, {
      groundItems: [pile],
      dispatchInput: (apply) => pendingInputs.push(apply),
      previewTargetTile,
    });

    act(() => result.current.handleTakeGroundItem('gi-1'));

    expect(previewTargetTile).toHaveBeenCalledWith([20, 25]);
    expect(setTargetTile).not.toHaveBeenCalled();
    expect(targetTileRef.current).toBeNull();
    expect(pendingInputs).toHaveLength(1);
    expect(engine.applyAction).not.toHaveBeenCalled();

    act(() => pendingInputs[0]());

    expect(targetTileRef.current).toEqual([20, 25]);
    expect(setTargetTile).toHaveBeenCalledWith([20, 25]);
    expect(retireTargetPreview).toHaveBeenCalledOnce();
  });

  it('disarms a manual spell immediately while the cast remains buffered', () => {
    const engine = makeEngine(false);
    const pendingInputs: Array<() => void> = [];
    const setArmedSpell = vi.fn<(value: SetStateAction<string | null>) => void>();
    const { result } = renderInteraction(engine, {
      armedSpell: 'Ice Barrage',
      dispatchInput: (apply) => pendingInputs.push(apply),
      setArmedSpell,
    });

    act(() => result.current.handleTileClick([32, 37], false, 'yama'));

    expect(setArmedSpell).toHaveBeenCalledWith(null);
    expect(pendingInputs).toHaveLength(1);
    expect(engine.applyAction).not.toHaveBeenCalled();
  });

  it('publishes the post-tick engine state so a landed gear swap reaches React', () => {
    // Auto-advance off: the RAF loop is not running, so this manual tick is the
    // only place the swap can be published. publishEngineState owns pushing both
    // the state and the live equipment (see useSimulationWiring).
    const swapped = { weapon: 2001, body: 2002 };
    const engine = makeEngine(false);
    const swappedState = { ...makeState(1), playerEquipment: swapped };
    vi.mocked(engine.getState).mockReturnValue(swappedState);
    const { result, publishEngineState, setSimulationState } = renderInteraction(engine);

    act(() => {
      result.current.handleTileClick([32, 37]);
    });

    expect(publishEngineState).toHaveBeenCalledWith(swappedState);
    // The raw setter is reserved for non-tick updates (the intro fade fallback).
    expect(setSimulationState).not.toHaveBeenCalled();
  });

  describe('while the 3D view cannot draw', () => {
    it.each<{ name: string; click: (result: { current: ReturnType<typeof useViewportInteraction> }) => void }>([
      { name: 'a walk', click: (result) => result.current.handleTileClick([32, 37]) },
      { name: 'an attack', click: (result) => result.current.handleTileClick([32, 37], false, 'yama') },
      { name: 'a take', click: (result) => result.current.handleTakeGroundItem('gi-1') },
    ])('refuses $name into the unseen world, with no manual step', ({ click }) => {
      const engine = makeEngine(false);
      const dispatchInput = vi.fn((apply: () => void) => apply());
      const previewTargetTile = vi.fn(() => vi.fn());
      const { result, replay, setTargetTile, publishEngineState } = renderInteraction(engine, {
        graphicsHeld: true,
        groundItems: [makePile('gi-1', [20, 25])],
        dispatchInput,
        previewTargetTile,
      });

      act(() => click(result));

      expect(dispatchInput).not.toHaveBeenCalled();
      expect(previewTargetTile).not.toHaveBeenCalled();
      expect(setTargetTile).not.toHaveBeenCalled();
      expect(engine.applyAction).not.toHaveBeenCalled();
      expect(engine.advanceTick).not.toHaveBeenCalled();
      expect(replay.recordAction).not.toHaveBeenCalled();
      expect(replay.recordFrame).not.toHaveBeenCalled();
      expect(publishEngineState).not.toHaveBeenCalled();
    });

    it('opens no lobby card or portal it cannot show', () => {
      const engine = makeEngine(false);
      const { result, onSelectLobbyEncounter, onEnterEncounter } = renderInteraction(engine, {
        graphicsHeld: true,
        sceneState: LOBBY_SCENE,
      });

      act(() => result.current.handleTileClick([20, 30], false, STATUE_WITH_CARD));

      expect(onSelectLobbyEncounter).not.toHaveBeenCalled();
      expect(onEnterEncounter).not.toHaveBeenCalled();
    });

    it('takes no manual step for a click sent before the view went, applied after', () => {
      const engine = makeEngine(false);
      const pendingInputs: Array<() => void> = [];
      const { result, rerender, replay } = renderInteraction(engine, {
        dispatchInput: (apply) => pendingInputs.push(apply),
      });

      act(() => result.current.handleTileClick([32, 37]));
      rerender({ graphicsHeld: true });
      act(() => pendingInputs[0]());

      // The click itself still lands, as any input sent before a hold does; only the step waits.
      expect(engine.applyAction).toHaveBeenCalledWith({ type: 'attackTarget', targetId: null });
      expect(engine.advanceTick).not.toHaveBeenCalled();
      expect(replay.recordFrame).not.toHaveBeenCalled();
    });

    it('steps again once the view is back', () => {
      const engine = makeEngine(false);
      const { result, rerender } = renderInteraction(engine, { graphicsHeld: true });
      rerender({ graphicsHeld: false });

      act(() => result.current.handleTileClick([32, 37]));

      expect(engine.advanceTick).toHaveBeenCalledWith([32, 37]);
    });
  });
});
