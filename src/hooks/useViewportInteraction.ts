import { type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useRef, useState } from 'react';
import type { ReplayUiState } from '../core/ReplayRecorder';
import type { SimulationEngine } from '../core/SimulationEngine';
import { LOBBY_NPC_ENCOUNTERS, LOBBY_PORTALS, type LobbyEncounterCard } from '../encounters/lobby/metadata';
import { tickBus } from '../tutorial/runtime/tickBus';
import type { Coordinate, SimulationState } from '../types/simulation';
import type { UseReplayReturn } from './useReplay';
import type { SceneState } from './useSimulationWiring';

interface UseViewportInteractionArgs {
  autoAdvance: boolean;
  /**
   * The 3D view cannot draw (see useSimulationWiring's `graphicsHeld`). The world is invisible, so
   * clicks into it (walks, attacks, takes, portals) and the manual step they make are refused.
   */
  graphicsHeld: boolean;
  engineRef: MutableRefObject<SimulationEngine>;
  dispatchInput: (apply: () => void) => void;
  onEnterEncounter: (encounterKind: string) => void;
  onSelectLobbyEncounter: (card: LobbyEncounterCard) => void;
  replay: UseReplayReturn;
  getReplayUiState: () => ReplayUiState;
  sceneState: SceneState;
  /** Publishes a post-`advanceTick()` engine state to React (state + live equipment). Owned by useSimulationWiring. */
  publishEngineState: (state: SimulationState) => void;
  setSimulationState: Dispatch<SetStateAction<SimulationState>>;
  setTargetTile: Dispatch<SetStateAction<Coordinate | null>>;
  simulationState: SimulationState;
  targetTileRef: MutableRefObject<Coordinate | null>;
  armedSpell: string | null;
  setArmedSpell: Dispatch<SetStateAction<string | null>>;
  previewTargetTile: (target: Coordinate | null) => () => void;
}

interface UseViewportInteractionReturn {
  handleTileClick: (coord: Coordinate, ctrlKey?: boolean, hoveredNpcActorId?: string | null) => void;
  handleTakeGroundItem: (groundItemId: string) => void;
  introFadeFading: boolean;
}

export function useViewportInteraction({
  autoAdvance,
  graphicsHeld,
  engineRef,
  dispatchInput,
  onEnterEncounter,
  onSelectLobbyEncounter,
  replay,
  getReplayUiState,
  sceneState,
  publishEngineState,
  setSimulationState,
  setTargetTile,
  simulationState,
  targetTileRef,
  armedSpell,
  setArmedSpell,
  previewTargetTile,
}: UseViewportInteractionArgs): UseViewportInteractionReturn {
  const [introFadeFading, setIntroFadeFading] = useState(false);
  // Read when a dispatched input is applied, which can be after the render that sent it.
  const graphicsHeldRef = useRef(graphicsHeld);
  graphicsHeldRef.current = graphicsHeld;

  const advanceManualTick = (moveTarget: Coordinate) => {
    if (
      autoAdvance ||
      graphicsHeldRef.current ||
      !engineRef.current.canAdvance() ||
      engineRef.current.isTutorialPaused()
    )
      return;
    engineRef.current.advanceTick(moveTarget);
    // As in the live loop: a click dropped while busy must not stay queued (and marked) for the next
    // step or for auto-advance to walk to.
    if (engineRef.current.didLastTickDiscardWalkTarget()) {
      setTargetTile(null);
      targetTileRef.current = null;
    }
    const newState = engineRef.current.getState();
    const tickEvents = engineRef.current.getLastTickEvents();
    replay.recordFrame(newState.currentTick, moveTarget, newState, tickEvents, getReplayUiState());
    // Manual (auto-advance off) ticks land queued gear swaps just like the RAF
    // loop, so they publish through the same path — otherwise the player model
    // keeps showing the pre-swap gear.
    publishEngineState(newState);
    tickBus.publish(newState.currentTick, tickEvents);
  };

  useEffect(() => {
    if (!simulationState.introActive) {
      setIntroFadeFading(false);
      return;
    }

    setIntroFadeFading(false);
    const frameId = requestAnimationFrame(() => {
      setIntroFadeFading(true);
    });

    const fallbackTimeout = window.setTimeout(() => {
      if (engineRef.current.getIntroActive()) {
        engineRef.current.completeIntro();
        setSimulationState(engineRef.current.getState());
      }
    }, 5000);

    return () => {
      cancelAnimationFrame(frameId);
      window.clearTimeout(fallbackTimeout);
    };
  }, [engineRef, setSimulationState, simulationState.introActive]);

  const handleTileClick = (coord: Coordinate, ctrlKey?: boolean, hoveredNpcActorId?: string | null) => {
    if (replay.replayMode || graphicsHeld) return;

    if (hoveredNpcActorId) {
      if (sceneState.kind === 'lobby') {
        const encounter = LOBBY_NPC_ENCOUNTERS[hoveredNpcActorId];
        if (encounter) {
          onSelectLobbyEncounter(encounter);
        }
        // A lobby statue with no encounter card is scenery: swallow the click rather than
        // letting it fall through and queue an attack on it.
        return;
      }

      const manualSpell = armedSpell;
      if (manualSpell) setArmedSpell(null);
      const retireTargetPreview = previewTargetTile(null);

      // Lag-buffer the whole click (run/walk override + target/attack) so it
      // reaches the engine together at the tick boundary after it "arrives".
      dispatchInput(() => {
        replay.recordAction({ type: 'ctrlClick', ctrlKey: ctrlKey ?? false });
        engineRef.current.setCtrlClickOverride(ctrlKey ?? false);
        setTargetTile(null);
        targetTileRef.current = null;
        retireTargetPreview();
        if (manualSpell) {
          // Manual cast: the armed spell is spent on this one target and put away,
          // matching OSRS where casting again needs another spell + target click.
          replay.recordAction({ type: 'manualCast', spellName: manualSpell, targetId: hoveredNpcActorId });
          engineRef.current.applyAction({
            type: 'manualCast',
            spellName: manualSpell,
            targetId: hoveredNpcActorId,
          });
        } else {
          replay.recordAction({ type: 'attackTarget', targetId: hoveredNpcActorId });
          engineRef.current.applyAction({ type: 'attackTarget', targetId: hoveredNpcActorId });
        }
        advanceManualTick(simulationState.playerPosition);
      });

      return;
    }

    // Clicking the ground is a walk action, which replaces an armed spell.
    if (armedSpell) setArmedSpell(null);

    if (sceneState.kind === 'lobby') {
      const clickedPortal = LOBBY_PORTALS.find(
        (portal) => portal.position[0] === coord[0] && portal.position[1] === coord[1],
      );

      if (clickedPortal) {
        const encounterMeta = Object.values(LOBBY_NPC_ENCOUNTERS).find(
          (encounter) => encounter.encounterKind === clickedPortal.encounterKind,
        );

        if (encounterMeta) {
          onSelectLobbyEncounter(encounterMeta);
        } else {
          onEnterEncounter(clickedPortal.encounterKind);
        }
        return;
      }
    }

    const retireTargetPreview = previewTargetTile(coord);
    dispatchInput(() => {
      replay.recordAction({ type: 'ctrlClick', ctrlKey: ctrlKey ?? false });
      engineRef.current.setCtrlClickOverride(ctrlKey ?? false);
      // React paints the destination immediately; this ref drives movement and
      // must not change until the click reaches the fake server. Re-tapping the same tile keeps
      // the committed array, so a destination that did not move is not published again.
      setTargetTile((prev) => (prev && prev[0] === coord[0] && prev[1] === coord[1] ? prev : coord));
      targetTileRef.current = coord;
      retireTargetPreview();
      replay.recordAction({ type: 'attackTarget', targetId: null });
      engineRef.current.applyAction({ type: 'attackTarget', targetId: null });
      advanceManualTick(coord);
    });
  };

  /**
   * OSRS "Take": walk to the pile's tile, then pick it up on the tick after arrival
   * (the engine resolves pickups before movement). The walk target and the pickup
   * interaction are queued together so a single lag-buffered click reaches the
   * engine as one input, exactly like a walk click.
   */
  const handleTakeGroundItem = (groundItemId: string) => {
    if (replay.replayMode || graphicsHeld) return;
    const target = simulationState.groundItems.find((item) => item.id === groundItemId);
    if (!target) return;
    const tile: Coordinate = [target.position[0], target.position[1]];

    if (armedSpell) setArmedSpell(null);

    const retireTargetPreview = previewTargetTile(tile);
    dispatchInput(() => {
      replay.recordAction({ type: 'ctrlClick', ctrlKey: false });
      engineRef.current.setCtrlClickOverride(false);
      setTargetTile(tile);
      targetTileRef.current = tile;
      retireTargetPreview();
      // Clearing the attack target also drops any pickup already in flight, so the
      // new take has to be queued after it, not before.
      replay.recordAction({ type: 'attackTarget', targetId: null });
      engineRef.current.applyAction({ type: 'attackTarget', targetId: null });
      replay.recordAction({ type: 'pickupGroundItem', groundItemId });
      engineRef.current.applyAction({ type: 'pickupGroundItem', groundItemId });
      advanceManualTick(tile);
    });
  };

  return {
    handleTileClick,
    handleTakeGroundItem,
    introFadeFading,
  };
}
