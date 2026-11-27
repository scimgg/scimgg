import { startTransition, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { MechanicsConfig } from '../components/MechanicsSettings';
import type { GameEvent } from '../core/events/types';
import {
  DEFAULT_REPLAY_UI_STATE,
  type ReplayClickType,
  type ReplayCursorTrack,
  type ReplayDisplayFrame,
  type ReplayFrameTiming,
  type ReplayModifierSample,
  type ReplayOpeningPosition,
  ReplayRecorder,
  type ReplayRecorderData,
  type ReplayRecordFrameOptions,
  type ReplayUiState,
  type ReplayViewportState,
  type ReplayViewportTrack,
} from '../core/ReplayRecorder';
import { isReplayTrackAvailable } from '../core/replayCaptureCoverage';
import { getReplayDurationMs } from '../core/replayDuration';
import { type ReplayFramePreview, ReplayFrameStore, type ReplayRenderFailure } from '../core/replayFrameStore';
import { presentationIndexAt, type ReplayOverlays, type ReplayPresentationState } from '../core/replayPresentation';
import { ReplaySafetyError } from '../core/replaySafety';
import {
  frameIndexAtMs,
  frameSlotAtMs,
  frameStartMs,
  getReplayLateTicks,
  type ReplayChapterSet,
  type ReplayLateTick,
} from '../core/replayTimeline';
import type { EngineAction, EngineRunConfig, SimulationEngine } from '../core/SimulationEngine';
import { encounterReplayChapters } from '../encounters/practiceChrome';
import { reconstructReplayPrefix } from '../encounters/simulationEngineFactory';
import { isSyntheticInput } from '../input/inputProvenance';
import {
  getModifiers,
  getMouseButtons,
  modifierMask,
  mouseButtonMask,
  subscribeModifiers,
  subscribeMouseButtons,
} from '../input/keyState';
import { createPrimaryUiPointerDownListener } from '../input/replayClickFeedback';
import { getLiveReplayMenuState, subscribeLiveReplayMenuState } from '../input/replayMenuState';
import { isTouchPointer } from '../input/touchHold';
import { interpolateReplayViewportState } from '../render/projections/replayViewportMapper';
import type { ReplayCapture } from '../replay/format/capture';
import { diffResumableState } from '../replay/resumableState';
import type { ObjTypeLoader } from '../rs/config/objtype/ObjTypeLoader';
import type { ReplayPracticeControls } from '../types/replayPractice';
import type { RestoredPresentation } from '../types/restoredPresentation';
import { type Coordinate, OSRS_TICK_MS, type SimulationState } from '../types/simulation';
import { animationFrames } from '../util/animationFrames';
import { log } from '../util/Logger';
import { getGameFrameRect } from '../util/viewportBounds';

const defaultGetReplayUiState = (): ReplayUiState => DEFAULT_REPLAY_UI_STATE;
const EMPTY_REPLAY_OVERLAYS: ReplayOverlays = {
  tileMarkers: [],
  showTileMarkers: false,
  showTileMarkerLabels: false,
  lineMarkers: [],
  showLineMarkers: false,
  showLineMarkerLabels: false,
  lineMarkerWidth: 1,
};

/**
 * Why the selected tick cannot be played from. Lives with the hook that decides it rather than
 * with the bootstrap it partly derives from: most reasons are properties of the selected frame
 * and the recorded frame before it, not of the recording's serialized form.
 */
export type TakeOverUnavailableReason =
  | 'first-tick'
  | 'intro-frame'
  | 'fight-start'
  | 'nonconsecutive-tick'
  | 'terminal-predecessor';
export const TAKE_OVER_UNAVAILABLE_TEXT: Record<TakeOverUnavailableReason, string> = {
  'first-tick': 'This is the first recorded tick. Restart the fight to play it.',
  'intro-frame': 'The fight has not started yet',
  'fight-start': 'This is the first tick of the fight. Restart the fight to play it.',
  'nonconsecutive-tick': 'The tick before this one was not recorded',
  'terminal-predecessor': 'The run was already over before this tick',
};

const NO_FRAME_TICKS: readonly number[] = Object.freeze([]);

/**
 * Playing tick T means restoring the state just before it: the recorded frame at
 * `restoreFrameIndex` (tick T−1) is rebuilt and forked, so T itself executes on the viewer's
 * own inputs. `selectedFrameIndex`/`startTick` are the boundary the viewer chose; the anchor is
 * what is actually reconstructed and retained.
 */
interface RestoreBoundary {
  readonly selectedFrameIndex: number;
  readonly startTick: number;
  readonly restoreFrameIndex: number;
}

const isPlayablePracticeState = (state: SimulationState): boolean =>
  state.isAlive && state.encounterOutcome.phase !== 'victory' && !state.introActive;

/**
 * The one place a selected frame becomes a restore anchor. The predecessor is found by index,
 * never by searching tick numbers, and must be exactly the tick before; a duplicate or gapped
 * tick is refused rather than reinterpreted. A terminal selected frame is fine: the viewer is
 * replaying that tick, so only the predecessor has to be playable.
 */
function resolveRestoreBoundary(
  frames: readonly { readonly state: SimulationState }[],
  selectedFrameIndex: number,
): RestoreBoundary | TakeOverUnavailableReason {
  const selected = frames[selectedFrameIndex];
  if (selectedFrameIndex <= 0 || !selected) return 'first-tick';
  if (selected.state.introActive) return 'intro-frame';
  const predecessor = frames[selectedFrameIndex - 1].state;
  if (predecessor.introActive) return 'fight-start';
  if (selected.state.currentTick !== predecessor.currentTick + 1) return 'nonconsecutive-tick';
  if (!isPlayablePracticeState(predecessor)) return 'terminal-predecessor';
  return {
    selectedFrameIndex,
    startTick: selected.state.currentTick,
    restoreFrameIndex: selectedFrameIndex - 1,
  };
}

export interface UseReplayParams {
  readonly practiceHeld?: { readonly current: boolean };
  readonly practiceUnavailableReason?: string | null;
  readonly onRetryFight?: () => void;
  /**
   * Hold playback without changing whether it is playing (focus suspension, a covering modal): the
   * playhead and audio stop, and both carry on from there once released. A pause or play made while
   * held is kept.
   */
  readonly playbackHeld?: boolean;
  engineRef: { current: SimulationEngine };
  simulationState: SimulationState;
  /** Read at execution time, so a tab change reaches the recorder without a render. */
  getReplayUiState?: () => ReplayUiState;
  getReplayViewportState?: () => ReplayViewportState | undefined;
  getReplayDpsProjection?: () => ReturnType<SimulationEngine['getAdjustedTheoreticalDps']>;
  /** Reads the layout to snapshot at run start, so a run that never changes it still has one. */
  getPresentationState?: () => ReplayPresentationState | null;
  /** Reads the markers to snapshot at run start. Overlays are not tracked over time. */
  getOverlays?: () => ReplayOverlays | null;
  speedMultiplier: number;
  mechanicsConfig: MechanicsConfig;
  objTypeLoader: ObjTypeLoader | null;
  /**
   * `state` is the restored anchor (the tick before the one the viewer chose), and
   * `resumeTarget` is the move target that anchor tick was advanced with, or null when that tick
   * discarded it (`SimulationEngine.didLastTickDiscardWalkTarget`), as live play would have. The
   * live tick loop reads its own target ref on the very next tick, so without it a takeover
   * inherits whatever tile the viewer had queued before entering replay and walks the player off
   * on resume.
   */
  onTakeOver: (
    engine: SimulationEngine,
    state: SimulationState,
    uiState: ReplayUiState,
    resumeTarget: Coordinate | null,
  ) => void;
  onEnterReplay?: () => void;
  onExitReplay?: () => void;
  onSeek?: (frameIndex: number) => void;
  /** Stop audio when replay playback is paused (delayed/long sounds keep playing otherwise). */
  onPause?: () => void;
  onResume?: () => void;
  onPlaybackEnd?: () => void;
}

export interface UseReplayReturn {
  restoredPresentation: RestoredPresentation | null;
  replayPractice: ReplayPracticeControls;
  replayMode: boolean;
  capture: ReplayCapture;
  displayState: SimulationState;
  displayUiState: ReplayUiState;
  displayDpsProjection: ReturnType<SimulationEngine['getAdjustedTheoreticalDps']> | undefined;
  displayViewportState?: ReplayViewportState;
  /** Recorder's layout at the playhead. Null while recording, or when the recording has none. */
  displayPresentationState: ReplayPresentationState | null;
  /** Recorder's markers for the whole run. Null while recording, or when the recording has none. */
  displayOverlays: ReplayOverlays | null;
  displayEvents: GameEvent[] | undefined;
  /**
   * The recorder's own frame array, never a copy. Its identity is what the frame store publishes
   * on replay entry and what history-derived overlays key their indexes on: live recording
   * appends to it in place, and only a run start, fork or load swaps it.
   */
  displayHistory: readonly ReplayDisplayFrame[];
  cursorTrack: ReplayCursorTrack;
  viewportTrack: ReplayViewportTrack;
  modifierTrack: readonly ReplayModifierSample[];
  replayPlayheadMs: number;
  /** External store the two per-frame replay consumers subscribe to (camera + cursor). */
  replayFrameStore: ReplayFrameStore;

  startRun: (runConfig: EngineRunConfig, initialState: SimulationState, uiState?: ReplayUiState) => void;
  /**
   * The unadvanced fresh run now starts at `opening` (countdown positioning finished): rebases the
   * recording onto it and restarts ancillary capture from now. False when the recording is no longer
   * that run's untouched opening; see {@link ReplayRecorder.finalizeUnadvancedStart}.
   */
  finalizeFreshStart: (opening: Pick<ReplayOpeningPosition, 'position' | 'facingAngle'>) => boolean;
  recordFrame: (
    tick: number,
    input: Coordinate,
    state: SimulationState,
    events: GameEvent[],
    uiStateOrOptionsOrRecordedAtMs?: ReplayUiState | ReplayRecordFrameOptions | number,
    recordedAtMs?: number,
  ) => void;
  /** Put the newest frame on the live tick loop's schedule; see {@link ReplayRecorder.anchorLiveClock}. */
  anchorLiveClock: (tickStartMs: number, speedMultiplier: number) => void;
  /** Take the newest frame off the live schedule; see {@link ReplayRecorder.releaseLiveClock}. */
  releaseLiveClock: (atMs: number) => void;
  /** Keep slow-delivery diagnostics on the newest frame; see {@link ReplayRecorder.recordFrameTiming}. */
  recordFrameTiming: (timing: ReplayFrameTiming) => void;
  recordAction: (action: EngineAction) => void;
  recordCursorClick: (
    clientX: number,
    clientY: number,
    type: ReplayClickType,
    nowMs?: number,
    viewportState?: ReplayViewportState,
  ) => void;
  recordViewportSample: (nowMs?: number, viewportState?: ReplayViewportState) => void;
  recordPresentationState: (state: ReplayPresentationState, nowMs?: number) => void;
  loadExternalReplay: (data: ReplayRecorderData) => void;

  controlProps: {
    capture: ReplayCapture;
    isReplaying: boolean;
    replayFrameIndex: number;
    totalFrames: number;
    frameTicks: readonly number[];
    /** Ticks that ran late while recording, for the replay bar's warning. Empty outside replay. */
    lateTicks: readonly ReplayLateTick[];
    /**
     * The recording's encounter's named stretches (the Inferno), indexed like `replayFrameIndex`.
     * Null outside replay and for encounters that name none.
     */
    chapters: ReplayChapterSet | null;
    hasRecording: boolean;
    onEnterReplay: () => void;
    onExitReplay: () => void;
    onStepBack: () => void;
    onStepForward: () => void;
    onJumpToStart: () => void;
    onJumpToEnd: () => void;
    onSeek: (frameIndex: number) => void;
    /** Show a tick during a drag without committing it to React state. */
    onPreviewSeek: (frameIndex: number) => void;
    onPlayPause: () => void;
    isPlaying: boolean;
    onTakeOver: () => Promise<void>;
    /** Non-null disables Take Over and Practice: the selected tick cannot be played from. */
    takeOverUnavailableReason: TakeOverUnavailableReason | null;
    /** Set when a Take Over attempt was refused; the replay is left untouched. */
    takeOverError: string | null;
    playbackError: string | null;
    replayCursorVisible: boolean;
    onReplayCursorVisibleChange: (visible: boolean) => void;
  };

  resetReplay: () => void;
  /** A detached copy of the whole recording. */
  exportReplayData: () => ReplayRecorderData;
}

const NO_LATE_TICKS: readonly ReplayLateTick[] = [];

export function useReplay({
  practiceHeld,
  practiceUnavailableReason = null,
  onRetryFight,
  playbackHeld = false,
  engineRef,
  simulationState,
  getReplayUiState = defaultGetReplayUiState,
  getReplayViewportState,
  getReplayDpsProjection,
  getPresentationState,
  getOverlays,
  speedMultiplier,
  mechanicsConfig,
  objTypeLoader,
  onTakeOver,
  onEnterReplay,
  onExitReplay,
  onSeek,
  onPause,
  onResume,
  onPlaybackEnd,
}: UseReplayParams): UseReplayReturn {
  // Only the live tick loop moves replay time: idle, stepped and paused time never reaches it.
  const recorderRef = useRef(new ReplayRecorder({}, animationFrames.clock, { idleClock: 'held' }));
  const externalReplayLoadedRef = useRef(false);
  const recordingGenerationRef = useRef(0);
  const [practiceStart, setPracticeStart] = useState<RestoreBoundary | null>(null);
  const practiceStartRef = useRef<RestoreBoundary | null>(null);
  const [restoredPresentation, setRestoredPresentation] = useState<RestoredPresentation | null>(null);
  const [practiceBusy, setPracticeBusy] = useState(false);
  const practiceBusyRef = useRef(false);
  const [practiceMessage, setPracticeMessage] = useState<string | null>(null);
  const [practiceError, setPracticeError] = useState<string | null>(null);
  const practicePolicyRef = useRef(practiceUnavailableReason);
  practicePolicyRef.current = practiceUnavailableReason;
  const clearPractice = useCallback(() => {
    recordingGenerationRef.current += 1;
    practiceStartRef.current = null;
    setPracticeStart(null);
    setRestoredPresentation(null);
    setPracticeMessage(null);
    setPracticeError(null);
  }, []);
  useEffect(
    () => () => {
      recordingGenerationRef.current += 1;
    },
    [],
  );
  const capture = useSyncExternalStore(
    recorderRef.current.subscribeCapture,
    recorderRef.current.getCapture,
    recorderRef.current.getCapture,
  );
  const recordingSpeedRef = useRef(speedMultiplier);
  // Synchronous play-loop guard. A manual control (step/jump/seek/pause)
  // sets this false immediately so an already-scheduled RAF callback can't
  // advance the frame once more past the seeked target before React re-runs the
  // play-loop effect and cancels the RAF.
  const playLoopActiveRef = useRef(false);
  const heldPlaybackPausedRef = useRef(false);
  const [replayMode, setReplayMode] = useState(false);
  const [replayFrameIndex, setReplayFrameIndex] = useState(0);
  const [replayPlaying, setReplayPlayingState] = useState(false);
  const replayPlayingRef = useRef(false);
  const setReplayPlaying = useCallback((playing: boolean) => {
    replayPlayingRef.current = playing;
    if (!playing) playLoopActiveRef.current = false;
    setReplayPlayingState(playing);
  }, []);
  const [replayPlayheadMs, setReplayPlayheadMsState] = useState(0);
  const [replayCursorVisible, setReplayCursorVisible] = useState(true);
  /**
   * Tied to the frame it describes. A bare string outlives its cause: playback moves to another
   * tick, or the viewer re-enters a different replay, and a stale refusal is still on screen.
   */
  const [takeOverError, setTakeOverError] = useState<{ frameIndex: number; message: string } | null>(null);
  const clearReplayRestoreErrors = useCallback(() => {
    setTakeOverError(null);
    setPracticeError(null);
  }, []);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const handledRenderFailureRef = useRef<ReplayRenderFailure | undefined>(undefined);
  const [, setCursorTrackVersion] = useState(0);
  const getReplayUiStateRef = useRef(getReplayUiState);
  const getReplayViewportStateRef = useRef(getReplayViewportState);
  const getReplayDpsProjectionRef = useRef(getReplayDpsProjection);
  const getPresentationStateRef = useRef(getPresentationState);
  const getOverlaysRef = useRef(getOverlays);
  const replayModeRef = useRef(replayMode);
  /**
   * The frame index actually on screen, updated synchronously by every control that moves the
   * playhead. `setReplayFrameIndex` commits inside `startTransition`, so React's copy can still
   * be showing the pre-scrub tick when a click handler runs — a takeover reading it resumes from
   * a tick the viewer already scrubbed away from. Never mirror React state back onto this.
   */
  const replayFrameIndexRef = useRef(replayFrameIndex);
  // Unlike the transport ref, this never follows an uncommitted drag preview.
  const committedReplayFrameIndexRef = useRef(replayFrameIndex);
  const mechanicsConfigRef = useRef(mechanicsConfig);
  mechanicsConfigRef.current = mechanicsConfig;
  const replayPlayheadMsRef = useRef(replayPlayheadMs);
  const onPauseRef = useRef(onPause);
  const onResumeRef = useRef(onResume);
  const onPlaybackEndRef = useRef(onPlaybackEnd);
  onPauseRef.current = onPause;
  onResumeRef.current = onResume;
  onPlaybackEndRef.current = onPlaybackEnd;
  getReplayUiStateRef.current = getReplayUiState;
  getReplayViewportStateRef.current = getReplayViewportState;
  getReplayDpsProjectionRef.current = getReplayDpsProjection;
  getPresentationStateRef.current = getPresentationState;
  getOverlaysRef.current = getOverlays;
  replayModeRef.current = replayMode;

  const replayFrameStoreRef = useRef(new ReplayFrameStore());
  useEffect(() => {
    const store = replayFrameStoreRef.current;
    const handleFailure = () => {
      const failure = store.getRenderFailure();
      if (failure === handledRenderFailureRef.current) return;
      handledRenderFailureRef.current = failure;
      if (!failure) {
        setPlaybackError(null);
        return;
      }
      setReplayPlaying(false);
      setReplayPlayheadMsState(replayPlayheadMsRef.current);
      setPlaybackError('Replay playback stopped because this recording could not be rendered.');
      onPauseRef.current?.();
    };
    const unsubscribe = store.subscribe(handleFailure);
    handleFailure();
    return unsubscribe;
  }, [setReplayPlaying]);

  const recordedRunConfig = recorderRef.current.getRunConfig();
  // Index into the presentation track, advanced from the RAF loop below.
  const [presentationIndex, setPresentationIndex] = useState(-1);
  const presentationIndexRef = useRef(presentationIndex);

  // Push a playhead + interpolated camera to the external ReplayFrameStore and
  // update the playhead ref, WITHOUT any React setState. The play-loop RAF calls
  // this every frame; because it never setState's, App/Grid/chrome do NOT re-render
  // per frame — only the store's subscribers (the 3D viewport + replay cursor).
  const commitReplayFrame = useCallback((playheadMs: number) => {
    replayPlayheadMsRef.current = playheadMs;
    const frameIndex = frameIndexAtMs(recorderRef.current.getDisplayFrames(), playheadMs);
    const frameViewport = recorderRef.current.getFrameViewportState(frameIndex);
    const viewportState = isReplayTrackAvailable(recorderRef.current.getCapture(), 'viewportSamples', playheadMs)
      ? interpolateReplayViewportState(recorderRef.current.getViewportTrack().samples, playheadMs, frameViewport)
      : frameViewport;
    replayFrameStoreRef.current.set(playheadMs, viewportState);
    // Layout is the ONE thing here that cannot ride the store: it drives React
    // layout, not a canvas. Resolving it from the React playhead instead left it
    // frozen at whatever it was when playback started, because this loop
    // deliberately never setState's — so a panel move or resize made mid-recording
    // never applied while the replay was actually playing. Only the sample INDEX
    // is state, and layout changes are rare, so this re-renders at transitions
    // rather than per frame.
    const nextPresentationIndex = isReplayTrackAvailable(
      recorderRef.current.getCapture(),
      'presentationSamples',
      playheadMs,
    )
      ? presentationIndexAt(recorderRef.current.getPresentationTrack(), playheadMs)
      : -1;
    if (nextPresentationIndex !== presentationIndexRef.current) {
      presentationIndexRef.current = nextPresentationIndex;
      setPresentationIndex(nextPresentationIndex);
    }
  }, []);

  // Discrete playhead changes (start/enter/seek/step/jump/pause-restart). These
  // legitimately re-render (they swap the displayed tick), so they also bump the
  // React playhead state in addition to committing to the store.
  const setReplayPlayheadMs = useCallback(
    (playheadMs: number) => {
      commitReplayFrame(playheadMs);
      setReplayPlayheadMsState(playheadMs);
    },
    [commitReplayFrame],
  );

  // Unchanged live settings emit no events, so every new recording branch needs a baseline.
  const recordLivePresentationBaseline = useCallback(
    (nowMs: number) => {
      const recorder = recorderRef.current;
      recorder.recordMenuState(speedMultiplier, nowMs, getLiveReplayMenuState());
      recorder.recordModifierSample(
        speedMultiplier,
        nowMs,
        modifierMask(getModifiers()),
        mouseButtonMask(getMouseButtons()),
      );
      const presentation = getPresentationStateRef.current?.();
      if (presentation) recorder.recordPresentationState(speedMultiplier, nowMs, presentation);
    },
    [speedMultiplier],
  );

  const startRun = useCallback(
    (runConfig: EngineRunConfig, initialState: SimulationState, uiState?: ReplayUiState) => {
      clearPractice();
      const initialUiState = uiState ?? getReplayUiStateRef.current();
      const initialViewportState = getReplayViewportStateRef.current?.();
      const dpsProjection = getReplayDpsProjectionRef.current?.();
      const runStartMs = performance.now();
      recorderRef.current.startRun(runConfig, getOverlaysRef.current?.() ?? undefined);
      replayFrameStoreRef.current.setHistory(undefined);
      externalReplayLoadedRef.current = false;
      recorderRef.current.recordFrame(initialState.currentTick, initialState.playerPosition, initialState, [], {
        uiState: initialUiState,
        ...(dpsProjection === undefined ? {} : { dpsProjection }),
        ...(initialViewportState ? { viewportState: initialViewportState } : {}),
        recordedAtMs: runStartMs,
      });
      recordLivePresentationBaseline(runStartMs);
      if (initialViewportState) {
        recorderRef.current.recordViewportSample(speedMultiplier, runStartMs, initialViewportState);
      }
      setCursorTrackVersion((version) => version + 1);
      setReplayPlayheadMs(0);
    },
    [setReplayPlayheadMs, speedMultiplier, recordLivePresentationBaseline, clearPractice],
  );

  const finalizeFreshStart = useCallback(
    (opening: Pick<ReplayOpeningPosition, 'position' | 'facingAngle'>): boolean => {
      const nowMs = performance.now();
      const viewportState = getReplayViewportStateRef.current?.();
      if (
        !recorderRef.current.finalizeUnadvancedStart({ ...opening, ...(viewportState ? { viewportState } : {}) }, nowMs)
      ) {
        return false;
      }
      recordLivePresentationBaseline(nowMs);
      setCursorTrackVersion((version) => version + 1);
      return true;
    },
    [recordLivePresentationBaseline],
  );

  const recordFrame = useCallback(
    (
      tick: number,
      input: Coordinate,
      state: SimulationState,
      events: GameEvent[],
      uiStateOrOptionsOrRecordedAtMs?: ReplayUiState | ReplayRecordFrameOptions | number,
      recordedAtMs?: number,
    ) => {
      const explicitOptions =
        typeof uiStateOrOptionsOrRecordedAtMs === 'object' && !('activeGamePanelTab' in uiStateOrOptionsOrRecordedAtMs)
          ? uiStateOrOptionsOrRecordedAtMs
          : undefined;
      const uiState =
        explicitOptions?.uiState ??
        (typeof uiStateOrOptionsOrRecordedAtMs === 'object' && 'activeGamePanelTab' in uiStateOrOptionsOrRecordedAtMs
          ? uiStateOrOptionsOrRecordedAtMs
          : getReplayUiStateRef.current());
      const viewportState = explicitOptions?.viewportState ?? getReplayViewportStateRef.current?.();
      const dpsProjection =
        explicitOptions?.dpsProjection === undefined
          ? getReplayDpsProjectionRef.current?.()
          : explicitOptions.dpsProjection;
      const frameRecordedAtMs =
        explicitOptions?.recordedAtMs ??
        (typeof uiStateOrOptionsOrRecordedAtMs === 'number' ? uiStateOrOptionsOrRecordedAtMs : recordedAtMs);
      recorderRef.current.recordFrame(tick, input, state, events, {
        uiState,
        ...(dpsProjection === undefined ? {} : { dpsProjection }),
        ...(viewportState ? { viewportState } : {}),
        ...(frameRecordedAtMs === undefined ? {} : { recordedAtMs: frameRecordedAtMs }),
        ...(explicitOptions?.liveTick === undefined ? {} : { liveTick: explicitOptions.liveTick }),
      });
    },
    [],
  );

  const anchorLiveClock = useCallback((tickStartMs: number, speedMultiplier: number) => {
    recorderRef.current.anchorLiveClock(tickStartMs, speedMultiplier);
  }, []);

  const releaseLiveClock = useCallback((atMs: number) => {
    recorderRef.current.releaseLiveClock(atMs);
  }, []);

  const recordFrameTiming = useCallback((timing: ReplayFrameTiming) => {
    recorderRef.current.recordFrameTiming(timing);
  }, []);

  const recordAction = useCallback((action: EngineAction) => {
    // Suppress replay recording for tutorial synthetic input (the demo cursor
    // drives real handlers; the engine effect still runs, but the action must
    // not be recorded as a user input). Single chokepoint for every caller.
    if (isSyntheticInput()) return;
    recorderRef.current.recordAction(action);
  }, []);

  const recordCursorClick = useCallback(
    (clientX: number, clientY: number, type: ReplayClickType, nowMs?: number, viewportState?: ReplayViewportState) => {
      if (replayModeRef.current) return;
      if (!recorderRef.current.hasRecording()) return;
      if (isSyntheticInput()) return;
      const frameRect = getGameFrameRect();
      // No frame means nothing to record against: a click's coordinates are only
      // meaningful relative to the frame playback will rebuild.
      if (!frameRect) return;
      const presentation = getPresentationStateRef.current?.();
      recorderRef.current.recordCursorClick(
        clientX,
        clientY,
        type,
        speedMultiplier,
        frameRect,
        nowMs,
        viewportState ?? getReplayViewportStateRef.current?.(),
        presentation?.insets,
      );
      // No re-render: the track is read from the recorder when replay is entered or exported,
      // and a notification here would re-render the whole App on every click and tap.
    },
    [speedMultiplier],
  );

  const recordViewportSample = useCallback(
    (nowMs = performance.now(), viewportState?: ReplayViewportState) => {
      if (replayModeRef.current) return;
      if (!recorderRef.current.hasRecording()) return;
      if (recorderRef.current.getCapture().viewportSamples.stoppedAtMs !== null) return;
      const resolvedViewportState = viewportState ?? getReplayViewportStateRef.current?.();
      if (!resolvedViewportState) return;
      recorderRef.current.recordViewportSample(speedMultiplier, nowMs, resolvedViewportState);
    },
    [speedMultiplier],
  );

  const recordPresentationState = useCallback(
    (state: ReplayPresentationState, nowMs = performance.now()) => {
      if (replayModeRef.current) return;
      if (!recorderRef.current.hasRecording()) return;
      recorderRef.current.recordPresentationState(speedMultiplier, nowMs, state);
    },
    [speedMultiplier],
  );

  useEffect(() => {
    if (recordingSpeedRef.current !== speedMultiplier) {
      if (!replayModeRef.current && recorderRef.current.hasRecording()) {
        recorderRef.current.checkpointSpeedChange(recordingSpeedRef.current);
      }
      recordingSpeedRef.current = speedMultiplier;
    }
  }, [speedMultiplier]);

  useEffect(
    () =>
      subscribeLiveReplayMenuState((state) => {
        if (replayModeRef.current || !recorderRef.current.hasRecording()) return;
        recorderRef.current.recordMenuState(speedMultiplier, performance.now(), state);
      }),
    [speedMultiplier],
  );

  useEffect(() => {
    if (replayMode) return;
    // Event-driven, not per frame: the mask is unchanged for most of a fight, and
    // when it does change it can change twice inside one tick (a shift-drop between
    // two clicks), which a per-tick sample cannot represent either way.
    // Both stores are re-read on either store's change rather than trusting the
    // callback's own argument, so the pair written to a sample is always the state at
    // one instant — a shift-click otherwise records the button against the modifier
    // mask from before Shift landed.
    const record = () => {
      if (replayModeRef.current || !recorderRef.current.hasRecording()) return;
      recorderRef.current.recordModifierSample(
        speedMultiplier,
        performance.now(),
        modifierMask(getModifiers()),
        mouseButtonMask(getMouseButtons()),
      );
    };
    const stopModifiers = subscribeModifiers(record);
    const stopMouseButtons = subscribeMouseButtons(record);
    return () => {
      stopModifiers();
      stopMouseButtons();
    };
  }, [replayMode, speedMultiplier]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      if (replayMode || !recorderRef.current.hasRecording()) return;
      recorderRef.current.notePointerIsTouch(isTouchPointer(event));
      if (recorderRef.current.getCapture().cursorSamples.stoppedAtMs !== null) return;
      const frameRect = getGameFrameRect();
      if (!frameRect) return;
      // The sidebars overlay the frame rather than resize it, so their overlap has
      // to be excluded before a point counts as being on the reproducible surface.
      const presentation = getPresentationStateRef.current?.();
      const coalescedEvents = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : [];
      const samples = coalescedEvents.length > 0 ? coalescedEvents : [event];
      for (const sample of samples) {
        recorderRef.current.recordCursorSample(
          sample.clientX,
          sample.clientY,
          speedMultiplier,
          frameRect,
          sample.timeStamp,
          undefined,
          presentation?.insets,
        );
      }
    };

    let uiClickRecorded = false;
    const recordUiPointerDown = createPrimaryUiPointerDownListener(({ clientX, clientY, timeStamp }) => {
      uiClickRecorded = true;
      recordCursorClick(clientX, clientY, 'ui', timeStamp);
    });
    // Noted on every press, before anything it triggers reports a click of its own.
    const handlePointerDown = (event: PointerEvent) => {
      if (!replayMode) recorderRef.current.notePointerIsTouch(isTouchPointer(event));
      uiClickRecorded = false;
      recordUiPointerDown(event);
      // A finger held still sends no moves, so record where it came down: playback marks a
      // long-press there. A UI click above already pinned a sample at this point.
      if (!isTouchPointer(event) || uiClickRecorded) return;
      if (replayMode || !recorderRef.current.hasRecording()) return;
      if (recorderRef.current.getCapture().cursorSamples.stoppedAtMs !== null) return;
      const frameRect = getGameFrameRect();
      if (!frameRect) return;
      const presentation = getPresentationStateRef.current?.();
      recorderRef.current.recordCursorPress(
        event.clientX,
        event.clientY,
        speedMultiplier,
        frameRect,
        event.timeStamp,
        presentation?.insets,
      );
    };
    const pointerDownOptions = { capture: true, passive: true } as const;

    window.addEventListener('pointermove', handlePointerMove, { passive: true });
    window.addEventListener('pointerdown', handlePointerDown, pointerDownOptions);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerdown', handlePointerDown, pointerDownOptions);
    };
  }, [recordCursorClick, replayMode, speedMultiplier]);

  useEffect(() => {
    if (!replayMode || !replayPlaying) {
      heldPlaybackPausedRef.current = false;
      return;
    }
    playLoopActiveRef.current = true;

    let basePlayheadMs = replayPlayheadMsRef.current;
    let basePerfMs = performance.now();
    // The duration-derived end, which cursor/viewport tracks can push past the last frame.
    const maxPlayheadMs = getReplayDurationMs(
      recorderRef.current.getDisplayFrames(),
      recorderRef.current.getCursorTrack(),
      recorderRef.current.getViewportTrack(),
      recorderRef.current.getModifierTrack(),
      recorderRef.current.getMenuTrack(),
      recorderRef.current.getPresentationTrack(),
      recorderRef.current.getCapture(),
    );
    let animationFrameId: number | undefined;
    let cancelled = false;

    const pause = () => {
      if (!playLoopActiveRef.current) return;
      setReplayPlaying(false);
      setReplayPlayheadMsState(replayPlayheadMsRef.current);
      if (replayModeRef.current) onPauseRef.current?.();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') pause();
    };

    const tick = (currentTime: number) => {
      if (cancelled || !playLoopActiveRef.current) return;
      if (document.visibilityState === 'hidden') {
        pause();
        return;
      }
      // `currentTime` is the frame's start timestamp, which the browser is free
      // to report as EARLIER than the `performance.now()` sampled when this
      // effect ran. Without the lower clamp the first frame after pressing Play
      // nudges the playhead a hair below the tick boundary a seek parked it on,
      // which floors to the PREVIOUS frame index — the renderer reads that as a
      // rewind, wipes its transient state and visibly pops before playing on.
      const elapsedMs = Math.max(0, currentTime - basePerfMs);
      const elapsedPlayheadMs = basePlayheadMs + elapsedMs * speedMultiplier;
      const frames = recorderRef.current.getDisplayFrames();
      // A frame gap long enough to skip a whole tick, in a late tick or the tail past the last frame
      // alike, pauses rather than jumping.
      if (frameSlotAtMs(frames, elapsedPlayheadMs) > frameSlotAtMs(frames, replayPlayheadMsRef.current) + 1) {
        pause();
        return;
      }
      const nextPlayheadMs = Math.min(maxPlayheadMs, elapsedPlayheadMs);
      const nextFrameIndex = frameIndexAtMs(frames, nextPlayheadMs);
      const currentFrameIndex = replayFrameIndexRef.current;
      const store = replayFrameStoreRef.current;
      if (
        (nextFrameIndex > currentFrameIndex && !store.isFrameRendered(currentFrameIndex)) ||
        (replayPlayheadMsRef.current >= maxPlayheadMs && !store.isPlayheadRendered(maxPlayheadMs))
      ) {
        basePlayheadMs = replayPlayheadMsRef.current;
        basePerfMs = currentTime;
        animationFrameId = requestAnimationFrame(tick);
        return;
      }
      commitReplayFrame(nextPlayheadMs);
      if (nextFrameIndex !== currentFrameIndex) {
        clearReplayRestoreErrors();
        replayFrameIndexRef.current = nextFrameIndex;
        committedReplayFrameIndexRef.current = nextFrameIndex;
        setReplayFrameIndex(nextFrameIndex);
      }
      if (nextPlayheadMs >= maxPlayheadMs && store.isPlayheadRendered(maxPlayheadMs)) {
        // Sync the React playhead state to the final value as playback stops.
        setReplayPlayheadMsState(nextPlayheadMs);
        setReplayPlaying(false);
        onPlaybackEndRef.current?.();
        return;
      }
      animationFrameId = requestAnimationFrame(tick);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    handleVisibilityChange();
    if (replayPlayingRef.current) {
      if (playbackHeld) {
        if (!heldPlaybackPausedRef.current) onPauseRef.current?.();
        heldPlaybackPausedRef.current = true;
        setReplayPlayheadMsState(replayPlayheadMsRef.current);
      } else {
        if (heldPlaybackPausedRef.current) onResumeRef.current?.();
        heldPlaybackPausedRef.current = false;
        animationFrameId = requestAnimationFrame(tick);
      }
    }
    return () => {
      cancelled = true;
      playLoopActiveRef.current = false;
      if (animationFrameId !== undefined) cancelAnimationFrame(animationFrameId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [
    replayMode,
    replayPlaying,
    playbackHeld,
    commitReplayFrame,
    clearReplayRestoreErrors,
    speedMultiplier,
    setReplayPlaying,
  ]);

  const handleEnterReplay = useCallback(() => {
    if (practiceBusyRef.current) return;
    if (replayFrameStoreRef.current.getRenderFailure()) return;
    if (!recorderRef.current.hasRecording()) return;
    setReplayPlaying(false);
    onEnterReplay?.();
    replayModeRef.current = true;
    setReplayMode(true);
    const lastFrameIndex = recorderRef.current.getFrameCount() - 1;
    replayFrameIndexRef.current = lastFrameIndex;
    committedReplayFrameIndexRef.current = lastFrameIndex;
    setReplayFrameIndex(lastFrameIndex);
    clearReplayRestoreErrors();
    // The recorder's own frame array, never a copy of it: the store dedups on identity, and
    // the renderer keys its per-replay work on that identity holding across playback.
    replayFrameStoreRef.current.setHistory(
      recorderRef.current.getDisplayFrames(),
      recorderRef.current.getMenuTrack(),
      recorderRef.current.getCapture(),
    );
    setReplayPlayheadMs(
      getReplayDurationMs(
        recorderRef.current.getDisplayFrames(),
        recorderRef.current.getCursorTrack(),
        recorderRef.current.getViewportTrack(),
        recorderRef.current.getModifierTrack(),
        recorderRef.current.getMenuTrack(),
        recorderRef.current.getPresentationTrack(),
        recorderRef.current.getCapture(),
      ),
    );
  }, [onEnterReplay, setReplayPlayheadMs, setReplayPlaying, clearReplayRestoreErrors]);

  const handleExitReplay = useCallback(() => {
    recordingGenerationRef.current += 1;
    setPracticeMessage(null);
    setPracticeError(null);
    setReplayPlaying(false);
    setReplayMode(false);
    replayModeRef.current = false;
    replayFrameStoreRef.current.setHistory(undefined);
    onExitReplay?.();
    if (externalReplayLoadedRef.current) {
      startRun(engineRef.current.getRunConfig(), engineRef.current.getState());
    }
    recorderRef.current.recordMenuState(speedMultiplier, performance.now(), getLiveReplayMenuState());
  }, [onExitReplay, setReplayPlaying, speedMultiplier, startRun, engineRef]);

  // Single chokepoint for every scrub control (step/jump/seek). It always runs
  // the onSeek reset path, so audio + frame-sound + event trackers are reset on
  // ANY scrub — not only slider drags.
  const seekTo = useCallback(
    (frameIndex: number) => {
      if (!Number.isInteger(frameIndex) || practiceBusyRef.current) return;
      if (replayFrameStoreRef.current.getRenderFailure()) return;
      playLoopActiveRef.current = false;
      const clamped = Math.max(0, Math.min(frameIndex, recorderRef.current.getFrameCount() - 1));
      replayFrameStoreRef.current.resetRenderProgress();

      // Camera + playhead go straight to the external store: no React work, so
      // the viewport can follow the scrub on the very next animation frame.
      replayFrameIndexRef.current = clamped;
      committedReplayFrameIndexRef.current = clamped;
      clearReplayRestoreErrors();
      commitReplayFrame(frameStartMs(recorderRef.current.getDisplayFrames(), clamped));
      replayFrameStoreRef.current.setPreview(undefined);
      onSeek?.(clamped);

      // Swapping the displayed tick re-renders the whole simulator tree (App ->
      // GridProviders -> Grid -> chrome/panels), measured at ~40ms per tick change.
      // As a transition it becomes interruptible: React time-slices it so the
      // browser keeps painting, and a newer scrub position supersedes an
      // in-flight render instead of queueing behind it.
      startTransition(() => {
        setReplayPlaying(false);
        setReplayFrameIndex(clamped);
        setReplayPlayheadMsState(frameStartMs(recorderRef.current.getDisplayFrames(), clamped));
      });
    },
    [onSeek, commitReplayFrame, setReplayPlaying, clearReplayRestoreErrors],
  );

  /**
   * Scrub preview: show a tick WITHOUT committing it to React.
   *
   * Dragging the seek bar emits one value per pointer sample. Routing each one
   * through `seekTo` re-renders the entire simulator tree per sample, which is
   * what makes a drag lag. This publishes the previewed tick to the external
   * frame store instead, so only the 3D viewport re-renders and it can track the
   * pointer at full frame rate. `seekTo` on release clears the preview and lets
   * the chrome/panels catch up in one commit.
   */
  const previewSeekTo = useCallback(
    (frameIndex: number) => {
      if (!Number.isInteger(frameIndex) || practiceBusyRef.current) return;
      if (replayFrameStoreRef.current.getRenderFailure()) return;
      playLoopActiveRef.current = false;
      const recorder = recorderRef.current;
      const clamped = Math.max(0, Math.min(frameIndex, recorder.getFrameCount() - 1));
      const frame = recorder.getFrame(clamped);
      if (!frame) return;
      if (replayPlayingRef.current) {
        setReplayPlaying(false);
        onPause?.();
      }
      replayFrameIndexRef.current = clamped;
      commitReplayFrame(frameStartMs(recorderRef.current.getDisplayFrames(), clamped));
      replayFrameStoreRef.current.setPreview({
        frameIndex: clamped,
        state: frame.state,
        events: frame.events,
      });
    },
    [commitReplayFrame, onPause, setReplayPlaying],
  );

  const handleStepBack = useCallback(() => seekTo(replayFrameIndexRef.current - 1), [seekTo]);

  const handleStepForward = useCallback(() => seekTo(replayFrameIndexRef.current + 1), [seekTo]);

  const handleJumpToStart = useCallback(() => seekTo(0), [seekTo]);

  const handleJumpToEnd = useCallback(() => seekTo(recorderRef.current.getFrameCount() - 1), [seekTo]);

  const handleSeek = useCallback((frameIndex: number) => seekTo(frameIndex), [seekTo]);

  const handlePlayPause = useCallback(() => {
    if (practiceBusyRef.current) return;
    if (replayFrameStoreRef.current.getRenderFailure()) return;
    const willPlay = !replayPlayingRef.current;
    if (willPlay) {
      replayFrameStoreRef.current.resetRenderProgress();
      if (replayFrameStoreRef.current.getSnapshot().preview) seekTo(replayFrameIndexRef.current);
      const replayEndMs = getReplayDurationMs(
        recorderRef.current.getDisplayFrames(),
        recorderRef.current.getCursorTrack(),
        recorderRef.current.getViewportTrack(),
        recorderRef.current.getModifierTrack(),
        recorderRef.current.getMenuTrack(),
        recorderRef.current.getPresentationTrack(),
        recorderRef.current.getCapture(),
      );
      // Parked at the true replay end: Play would otherwise no-op, so restart from 0.
      if (replayPlayheadMsRef.current >= replayEndMs) {
        clearReplayRestoreErrors();
        replayFrameIndexRef.current = 0;
        committedReplayFrameIndexRef.current = 0;
        setReplayFrameIndex(0);
        setReplayPlayheadMs(0);
        onSeek?.(0);
      }
      if (replayFrameStoreRef.current.getRenderFailure()) return;
      if (!playbackHeld) onResume?.();
    } else {
      // Pausing must stop already-playing/delayed audio.
      onPause?.();
      playLoopActiveRef.current = false;
      // The play loop advanced the playhead/camera via the store + ref only (no
      // per-frame setState). Pausing is discrete, so sync the React playhead state
      // from the ref now to preserve the exact sub-tick position on the next render.
      setReplayPlayheadMsState(replayPlayheadMsRef.current);
    }
    setReplayPlaying(willPlay);
  }, [
    onSeek,
    onPause,
    onResume,
    playbackHeld,
    setReplayPlayheadMs,
    setReplayPlaying,
    seekTo,
    clearReplayRestoreErrors,
  ]);

  const handleReplayCursorVisibleChange = useCallback((visible: boolean) => {
    setReplayCursorVisible(visible);
  }, []);

  const restoreFrame = useCallback(
    (boundary: RestoreBoundary, establishStart: boolean): boolean => {
      if (replayFrameStoreRef.current.getRenderFailure()) return false;
      const recorder = recorderRef.current;
      const runConfig = recorder.getRunConfig();
      if (!runConfig) return false;

      // Everything below reconstructs, validates and forks at the anchor. The selected frame may
      // not exist any more (a retry right after a fork) and is never what gets rebuilt.
      const frameIndex = boundary.restoreFrameIndex;
      // Refusals describe the tick the viewer chose (where the playhead is).
      const { selectedFrameIndex } = boundary;
      const targetFrame = recorder.getFrame(frameIndex);
      if (!targetFrame || !isPlayablePracticeState(targetFrame.state)) return false;

      let newEngine: SimulationEngine | null;
      try {
        newEngine = reconstructReplayPrefix(runConfig, recorder.getReconstructionFrames(), frameIndex, objTypeLoader);
      } catch (error) {
        setTakeOverError({
          frameIndex: selectedFrameIndex,
          message:
            error instanceof ReplaySafetyError
              ? 'Take Over stopped because this recording exceeds supported reconstruction limits.'
              : 'Take Over could not rebuild this recording.',
        });
        return false;
      }
      if (!newEngine) {
        // The factory found no usable bootstrap, or logged why the rebuild failed.
        setTakeOverError({ frameIndex: selectedFrameIndex, message: 'Take Over could not rebuild this recording.' });
        return false;
      }

      // Captured before any viewer policy is applied, and this exact object is what gets published.
      // Publishing a post-policy read instead hands the app a state that differs from the one just
      // validated, which is the whole guarantee takeover is making.
      const reconstructed = newEngine.getState();
      const diffs = diffResumableState(targetFrame.state, reconstructed);
      if (diffs.length > 0) {
        log.warn('Replay', 'Take Over reconstruction diverged from the recorded frame', {
          frameIndex,
          encounter: runConfig.encounter.kind,
          diffs,
        });
        setTakeOverError({
          frameIndex: selectedFrameIndex,
          message: 'Take Over could not rebuild this tick exactly, so the replay was left as it is.',
        });
        return false;
      }

      // Only past the check: the prefix is history and had to run on the recorded settings, but
      // from this boundary the viewer is playing their own run. Applying these earlier would make
      // the comparison above validate a state the recording never contained.
      newEngine.releaseReplayTakeoverLimits();
      newEngine.reapplyArenaConfig();
      // The viewer may change policy while the queued restore yields for a paint.
      newEngine.setMechanicsConfig(mechanicsConfigRef.current);

      // Branch the recording instead of restarting it, so the resumed run keeps the prefix that a
      // later takeover needs to reconstruct from.
      const forkTimeMs = performance.now();
      recorder.forkAt(frameIndex, forkTimeMs);
      externalReplayLoadedRef.current = false;

      engineRef.current = newEngine;
      setRestoredPresentation({
        engine: newEngine,
        tick: reconstructed.currentTick,
        timeMs: (reconstructed.currentTick + 1) * OSRS_TICK_MS,
        history: { frames: recorder.getDisplayFrames(), throughFrameIndex: frameIndex },
      });
      // The point keeps the boundary the viewer chose (tick T), not the reconstructed T−1. A plain
      // takeover keeps it while its anchor is still in the retained prefix.
      if (establishStart) {
        practiceStartRef.current = boundary;
        setPracticeStart(boundary);
      } else if (practiceStartRef.current && frameIndex < practiceStartRef.current.restoreFrameIndex) {
        practiceStartRef.current = null;
        setPracticeStart(null);
      }
      setPracticeMessage(null);
      setPracticeError(null);
      setTakeOverError(null);
      setReplayMode(false);
      replayModeRef.current = false;
      replayFrameStoreRef.current.setHistory(undefined);
      setReplayPlaying(false);
      // The frame records the target its tick was given, even one that tick discarded.
      const resumeTarget = newEngine.didLastTickDiscardWalkTarget() ? null : targetFrame.input;
      onTakeOver(newEngine, reconstructed, targetFrame.uiState, resumeTarget);
      recordLivePresentationBaseline(forkTimeMs);
      return true;
    },
    [engineRef, objTypeLoader, onTakeOver, setReplayPlaying, recordLivePresentationBaseline],
  );

  const recordingUnavailableReason = useCallback((): string | null => {
    if (practiceHeld?.current || engineRef.current.isTutorialPaused())
      return 'Replay practice is unavailable during tutorials.';
    if (practicePolicyRef.current) return practicePolicyRef.current;
    if (replayFrameStoreRef.current.getRenderFailure()) return 'This recording could not be rendered.';
    if (!recorderRef.current.hasRecording()) return 'No playable recording yet.';
    return null;
  }, [practiceHeld, engineRef]);

  /** One restore in flight, with a paint opportunity before bounded synchronous reconstruction.
   * The timeout also releases a request in a background tab where RAF is suspended.
   */
  const requestRestore = useCallback(
    (boundary: RestoreBoundary | TakeOverUnavailableReason, establishStart = false): Promise<void> => {
      if (practiceBusyRef.current) return Promise.resolve();
      const reason = recordingUnavailableReason();
      if (reason) {
        setPracticeMessage(reason);
        return Promise.resolve();
      }
      // The controls are disabled for an unresolvable boundary; a programmatic request is a no-op.
      if (typeof boundary === 'string') return Promise.resolve();
      const frameIndex = boundary.restoreFrameIndex;
      const frame = recorderRef.current.getDisplayFrames()[frameIndex];
      if (!frame || !isPlayablePracticeState(frame.state)) return Promise.resolve();
      // Restore even when live on this anchor's tick: inputs applied, queued or buffered since
      // adoption do not advance the tick, and only adoption discards them.
      const generation = recordingGenerationRef.current;
      practiceBusyRef.current = true;
      setPracticeBusy(true);
      setPracticeError(null);
      setTakeOverError(null);
      setPracticeMessage('Restoring tick…');
      // Stop transport immediately, before yielding, so the requested boundary stays on screen.
      setReplayPlaying(false);
      setReplayPlayheadMsState(replayPlayheadMsRef.current);
      if (replayModeRef.current) onPauseRef.current?.();
      // The completed anchor (T−1) with its own event cutoff. It ends exactly where the selected
      // tick starts, so the paused playhead stays put and nothing from tick T leaks in early.
      let ownedPreview: ReplayFramePreview | undefined;
      if (replayModeRef.current) {
        const target = recorderRef.current.getFrame(frameIndex);
        if (target) {
          ownedPreview = { frameIndex, state: target.state, events: target.events, completedBoundary: true };
          replayFrameStoreRef.current.setPreview(ownedPreview);
        }
      }
      return new Promise<void>((resolve) => {
        let done = false;
        let secondFrame: number | undefined;
        const finish = () => {
          if (done) return;
          done = true;
          cancelAnimationFrame(firstFrame);
          if (secondFrame !== undefined) cancelAnimationFrame(secondFrame);
          clearTimeout(fallback);
          try {
            if (generation !== recordingGenerationRef.current) return;
            const unavailable = recordingUnavailableReason();
            if (unavailable) {
              setPracticeMessage(unavailable);
              return;
            }
            if (!restoreFrame(boundary, establishStart)) {
              setPracticeMessage(null);
              setPracticeError('This tick could not be restored exactly. The recording was left unchanged.');
            }
          } finally {
            if (
              generation === recordingGenerationRef.current &&
              ownedPreview &&
              replayFrameStoreRef.current.getSnapshot().preview === ownedPreview
            ) {
              replayFrameStoreRef.current.setPreview(undefined);
            }
            practiceBusyRef.current = false;
            setPracticeBusy(false);
            resolve();
          }
        };
        const firstFrame = requestAnimationFrame(() => {
          secondFrame = requestAnimationFrame(finish);
        });
        const fallback = setTimeout(finish, 100);
      });
    },
    [recordingUnavailableReason, restoreFrame, setReplayPlaying],
  );
  const handleTakeOver = useCallback(
    (): Promise<void> =>
      requestRestore(
        resolveRestoreBoundary(recorderRef.current.getDisplayFrames(), committedReplayFrameIndexRef.current),
      ),
    [requestRestore],
  );
  const getPracticeUnavailableReason = (): string | null => {
    if (!replayModeRef.current) return 'Open replay to start practice.';
    const reason = recordingUnavailableReason();
    if (reason) return reason;
    const boundary = resolveRestoreBoundary(
      recorderRef.current.getDisplayFrames(),
      committedReplayFrameIndexRef.current,
    );
    return typeof boundary === 'string' ? TAKE_OVER_UNAVAILABLE_TEXT[boundary] : null;
  };
  const replayPractice: ReplayPracticeControls = {
    startTick: practiceStart?.startTick ?? null,
    startFrameIndex: practiceStart?.selectedFrameIndex ?? null,
    busy: practiceBusy,
    message: practiceMessage,
    error: practiceError,
    retryUnavailableReason: practicePolicyRef.current ?? (practiceStart === null ? null : recordingUnavailableReason()),
    practiceUnavailableReason: getPracticeUnavailableReason(),
    onRetry: () => {
      if (
        practiceBusyRef.current ||
        practicePolicyRef.current ||
        practiceHeld?.current ||
        engineRef.current.isTutorialPaused()
      )
        return;
      if (practiceStartRef.current === null) {
        onRetryFight?.();
        return;
      }
      // From the saved anchor: tick T need not exist yet in this branch.
      void requestRestore(practiceStartRef.current);
    },
    onChangeStart: () => {
      if (practiceBusyRef.current || recordingUnavailableReason() || practiceStartRef.current === null) return;
      const point = practiceStartRef.current;
      if (!replayModeRef.current) handleEnterReplay();
      // Until the branch records tick T again, its retained boundary is the anchor before it.
      seekTo(
        point.selectedFrameIndex < recorderRef.current.getFrameCount()
          ? point.selectedFrameIndex
          : point.restoreFrameIndex,
      );
    },
    onClearStart: () => {
      if (practiceBusyRef.current || recordingUnavailableReason()) return;
      practiceStartRef.current = null;
      setPracticeStart(null);
      setPracticeMessage(null);
      setPracticeError(null);
      setTakeOverError(null);
    },
    onStartPractice: () => {
      if (practiceBusyRef.current) return Promise.resolve();
      const reason = getPracticeUnavailableReason();
      if (reason) {
        setPracticeMessage(reason);
        return Promise.resolve();
      }
      return requestRestore(
        resolveRestoreBoundary(recorderRef.current.getDisplayFrames(), committedReplayFrameIndexRef.current),
        true,
      );
    },
  };

  const resetReplay = useCallback(() => {
    clearPractice();
    if (externalReplayLoadedRef.current) {
      recorderRef.current.clear();
      externalReplayLoadedRef.current = false;
    }
    setReplayPlaying(false);
    setReplayMode(false);
    replayModeRef.current = false;
    replayFrameStoreRef.current.setHistory(undefined);
    setTakeOverError(null);
    replayFrameIndexRef.current = 0;
    committedReplayFrameIndexRef.current = 0;
    setReplayFrameIndex(0);
    setReplayPlayheadMs(0);
  }, [setReplayPlayheadMs, setReplayPlaying, clearPractice]);
  const exportReplayData = useCallback(() => recorderRef.current.exportData(), []);

  const loadExternalReplay = useCallback(
    (data: ReplayRecorderData) => {
      clearPractice();
      setReplayPlaying(false);
      recorderRef.current.load(data);
      externalReplayLoadedRef.current = true;
      onEnterReplay?.();
      setReplayMode(true);
      replayModeRef.current = true;
      replayFrameIndexRef.current = 0;
      committedReplayFrameIndexRef.current = 0;
      setReplayFrameIndex(0);
      setCursorTrackVersion((version) => version + 1);
      setTakeOverError(null);
      replayFrameStoreRef.current.setHistory(
        recorderRef.current.getDisplayFrames(),
        recorderRef.current.getMenuTrack(),
        recorderRef.current.getCapture(),
      );
      setReplayPlayheadMs(0);
    },
    [onEnterReplay, setReplayPlayheadMs, setReplayPlaying, clearPractice],
  );

  // getFrame() rebuilds the frame's damage log (an O(damage entries) slice), so
  // memoize it: without this it re-ran on EVERY render of this hook, including
  // every unrelated App re-render and every play-loop tick.
  const displayFrames = recorderRef.current.getDisplayFrames();
  const presentationTrack = recorderRef.current.getPresentationTrack();
  // biome-ignore lint/correctness/useExhaustiveDependencies: getFrame reads this recording array through the recorder ref.
  const replayFrame = useMemo(
    () => (replayMode ? (recorderRef.current.getFrame(replayFrameIndex) ?? null) : null),
    [replayMode, replayFrameIndex, displayFrames],
  );

  /**
   * Why the tick on screen cannot be played from, or null when it can. The shared boundary
   * resolver decides it, so Take over, Practice and their availability always agree on the anchor.
   */
  const takeOverUnavailableReason = useMemo((): TakeOverUnavailableReason | null => {
    if (!replayFrame) return null;
    const boundary = resolveRestoreBoundary(displayFrames, replayFrameIndex);
    return typeof boundary === 'string' ? boundary : null;
  }, [replayFrame, displayFrames, replayFrameIndex]);
  const displayState = replayFrame?.state ?? simulationState;
  const displayUiState = replayFrame?.uiState ?? getReplayUiState();
  const displayDpsProjection = replayMode ? (replayFrame?.dpsProjection ?? null) : undefined;
  // Allocates a fresh interpolated camera object, so memoize it too: an unstable
  // identity here churns the viewport's replay-camera props every render.
  const displayViewportState = useMemo(
    () =>
      replayMode
        ? isReplayTrackAvailable(capture, 'viewportSamples', replayPlayheadMs)
          ? interpolateReplayViewportState(
              recorderRef.current.getViewportTrack().samples,
              replayPlayheadMs,
              replayFrame?.viewportState,
            )
          : replayFrame?.viewportState
        : getReplayViewportState?.(),
    [replayMode, replayPlayheadMs, replayFrame, getReplayViewportState, capture],
  );
  // The layout the recorder was looking at, which playback rebuilds so the
  // replayed cursor lands on the same thing they were pointing at. Null while
  // recording, before the first sample and once the track has hit its capture limit.
  const displayPresentationState =
    replayMode &&
    presentationIndex >= 0 &&
    isReplayTrackAvailable(capture, 'presentationSamples', replayPlayheadMsRef.current)
      ? (presentationTrack[presentationIndex]?.state ?? null)
      : null;
  // Markers are a run-start snapshot, so unlike the layout there is no playhead to
  // resolve against — the whole replay shows the set the recorder started with.
  const displayOverlays = replayMode
    ? capture.overlays.stoppedAtMs !== null
      ? EMPTY_REPLAY_OVERLAYS
      : recorderRef.current.getOverlays()
    : null;
  const displayEvents = replayMode ? (replayFrame?.events ?? []) : undefined;

  // Memoized so its identity is stable between animation frames. During replay
  // playback the play-loop re-renders this hook on every RAF; an inline object
  // literal here would get a fresh reference each frame, invalidating the broad
  // SimulationContext memo (which depends on controlProps) and re-rendering the
  // whole Grid/chrome/panel tree 60×/s. These fields only actually change per tick
  // (frame index) or on discrete transport actions.
  const displayedTakeOverError =
    takeOverError !== null && takeOverError.frameIndex === replayFrameIndex ? takeOverError.message : null;
  const totalFrames = recorderRef.current.getFrameCount();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the recorder appends frames in place.
  const frameTicks = useMemo(
    () => (replayMode ? displayFrames.map((frame) => frame.state.currentTick) : NO_FRAME_TICKS),
    [replayMode, displayFrames, totalFrames],
  );
  const hasRecording = recorderRef.current.hasRecording();
  const frameTimeline = recorderRef.current.getDisplayFrames();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the recorder grows its frame array in place, so the count marks a change.
  const lateTicks = useMemo(
    () => (replayMode ? getReplayLateTicks(frameTimeline) : NO_LATE_TICKS),
    [replayMode, frameTimeline, totalFrames],
  );
  // The recording's own encounter, which a loaded replay need not share with the live scene; a
  // recording without a run config still names it in its first frame's snapshot.
  const recordedEncounterKind = recordedRunConfig?.encounter.kind ?? frameTimeline[0]?.state.encounter?.kind;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the recorder grows its frame array in place, so the count marks a change.
  const chapters = useMemo(
    () => (replayMode ? encounterReplayChapters(recordedEncounterKind, frameTimeline) : null),
    [replayMode, recordedEncounterKind, frameTimeline, totalFrames],
  );
  const controlProps = useMemo(
    () => ({
      capture,
      isReplaying: replayMode,
      replayFrameIndex,
      totalFrames,
      frameTicks,
      lateTicks,
      chapters,
      hasRecording,
      onEnterReplay: handleEnterReplay,
      onExitReplay: handleExitReplay,
      onStepBack: handleStepBack,
      onStepForward: handleStepForward,
      onJumpToStart: handleJumpToStart,
      onJumpToEnd: handleJumpToEnd,
      onSeek: handleSeek,
      onPreviewSeek: previewSeekTo,
      onPlayPause: handlePlayPause,
      isPlaying: replayPlaying,
      onTakeOver: handleTakeOver,
      takeOverUnavailableReason,
      takeOverError: displayedTakeOverError,
      playbackError,
      replayCursorVisible,
      onReplayCursorVisibleChange: handleReplayCursorVisibleChange,
    }),
    [
      replayMode,
      capture,
      replayFrameIndex,
      totalFrames,
      frameTicks,
      lateTicks,
      chapters,
      hasRecording,
      handleEnterReplay,
      handleExitReplay,
      handleStepBack,
      handleStepForward,
      handleJumpToStart,
      handleJumpToEnd,
      handleSeek,
      previewSeekTo,
      handlePlayPause,
      replayPlaying,
      handleTakeOver,
      takeOverUnavailableReason,
      displayedTakeOverError,
      playbackError,
      replayCursorVisible,
      handleReplayCursorVisibleChange,
    ],
  );

  // ReplayRecorder now hands back identity-stable track wrappers (invalidated
  // only when it reassigns the underlying arrays), so these are safe to read on
  // every render without churning consumer props.
  const cursorTrack = recorderRef.current.getCursorTrack();
  const viewportTrack = recorderRef.current.getViewportTrack();
  const modifierTrack = recorderRef.current.getModifierTrack();

  return {
    restoredPresentation,
    replayPractice,
    replayMode,
    capture,
    displayState,
    displayUiState,
    displayDpsProjection,
    displayViewportState,
    displayPresentationState,
    displayOverlays,
    displayEvents,
    displayHistory: displayFrames,
    cursorTrack,
    viewportTrack,
    modifierTrack,
    replayPlayheadMs,
    replayFrameStore: replayFrameStoreRef.current,

    startRun,
    finalizeFreshStart,
    recordFrame,
    anchorLiveClock,
    releaseLiveClock,
    recordFrameTiming,
    recordAction,
    recordCursorClick,
    recordViewportSample,
    recordPresentationState,
    loadExternalReplay,

    controlProps,

    resetReplay,
    exportReplayData,
  };
}
