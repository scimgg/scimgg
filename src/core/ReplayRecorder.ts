import type { GamePanelTab } from '../hooks/keybindStore';
import type { ReplayClickType } from '../input/replayClickFeedback';
import { freshReplayCapture, type ReplayCapture, type ReplayCaptureLimits } from '../replay/format/capture';
import { MAX_REPLAY_FRAME_TIMING_MS } from '../replay/format/limits';
import { type Coordinate, type DamageHistoryEntry, OSRS_TICK_MS, type SimulationState } from '../types/simulation';
import { BackgroundClock } from '../util/BackgroundClock';
import { type GameFrameRect, toReplayCursorPoint } from '../util/viewportBounds';
import type { FirstPartyPlayerAttackProjectionSummary } from './combat/player/firstPartyPlayerAttack';
import type { GameEvent } from './events/types';
import { decodeLegacyReplayFrames } from './legacyReplayEvents';
import { decodeLegacyPrayerState } from './legacyReplayState';
import { ReplayCaptureBudget } from './ReplayCaptureBudget';
import { replayCursorTailUpdate } from './replayCursorSampling';
import {
  buildReplayMenuTimeline,
  copyReplayMenuState,
  copyReplayMenuView,
  type ReplayMenuEntry,
  type ReplayMenuEvent,
  type ReplayMenuState,
  replayMenuViewsEqual,
} from './replayMenu';
import {
  type ReplayOverlays,
  type ReplayPresentationInsets,
  type ReplayPresentationSample,
  type ReplayPresentationState,
  replayPresentationStatesEqual,
} from './replayPresentation';
import { frameStartMs } from './replayTimeline';
import type { EngineAction, EngineRunConfig } from './SimulationEngine';

export type { ReplayClickType } from '../input/replayClickFeedback';
export type {
  ReplayCapture,
  ReplayCaptureLimits,
  ReplayCaptureTrack,
  TrackCapture,
} from '../replay/format/capture';

export interface ReplayUiState {
  readonly activeGamePanelTab: GamePanelTab;
}

export const DEFAULT_REPLAY_UI_STATE: ReplayUiState = {
  activeGamePanelTab: 'inventory',
};

/**
 * Modifier keys the simulator BELIEVED were held from `tMs` until the next
 * sample, as a `MODIFIER_BIT` mask — not a reading of the physical keyboard. A
 * stuck modifier is exactly a divergence between the two, so recording the belief
 * is what makes one visible in a replay; never "fix" this to re-derive the
 * real key state at playback time.
 *
 * A change log, not a per-tick field: modifiers flick several times WITHIN a tick
 * (shift-drop between two clicks) which a per-tick sample cannot represent, and
 * they are unchanged for most of a fight, which a per-tick field pays for anyway.
 */
export interface ReplayModifierSample {
  readonly tMs: number;
  readonly mask: number;
  /**
   * Held mouse buttons as a `MOUSE_BUTTON_BIT` mask, sharing the sample because they
   * change on the same human cadence and a chord like shift-click is one event across both.
   */
  readonly buttons: number;
}

export interface ReplayViewportState {
  readonly kind: 'orbit3d';
  readonly pitchDeg: number;
  readonly yawDeg: number;
  readonly fovScale: number;
  readonly target: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
}

/**
 * When the real-time tick loop actually ran a frame's tick. On the recorder's active
 * (suspension-excluding) clock already, so it is used as given, never normalized.
 */
export interface ReplayLiveTickClock {
  /** Active-clock time the tick actually ran: a late tick runs, and starts, late. */
  readonly ranAtMs: number;
  readonly speedMultiplier: number;
}

export interface ReplayRecordFrameOptions {
  readonly uiState?: ReplayUiState;
  readonly viewportState?: ReplayViewportState;
  readonly dpsProjection?: FirstPartyPlayerAttackProjectionSummary | null;
  readonly recordedAtMs?: number;
  /** Absent for a frame stepped outside the live loop (manual step, fast-forward, run start). */
  readonly liveTick?: ReplayLiveTickClock;
}

/**
 * Wall-clock milliseconds describing a tick the live loop ran late. Diagnostics for the viewer
 * only: deliberately outside `state`, so Take Over and determinism checks ignore it.
 */
export interface ReplayFrameTiming {
  /** When the tick actually ran minus when it was scheduled to. */
  readonly lateByMs: number;
  /** Time since the previous animation-frame callback; absent when no gap is known (first frame, resume). */
  readonly rafGapMs?: number;
  /** Synchronous work to advance, record and publish the tick. */
  readonly tickWorkMs?: number;
}

/** A tick's timing is kept only when it ran more than this late. */
export const REPLAY_LATE_TICK_THRESHOLD_MS = 50;

/** Where the replay clock stands on the live schedule: track time `trackMs` at active time `atMs`. */
interface LiveClockAnchor {
  readonly atMs: number;
  readonly trackMs: number;
  readonly speed: number;
}

export type ReplayDisplayFrame = Readonly<
  Pick<ReplayFrame, 'state' | 'events' | 'dpsProjection' | 'startMs' | 'timing'>
>;

/** Where an unadvanced fresh run actually starts; see {@link ReplayRecorder.finalizeUnadvancedStart}. */
export interface ReplayOpeningPosition {
  readonly position: Coordinate;
  readonly facingAngle: number;
  /** The camera as the fight starts, which replaces the countdown's camera history. */
  readonly viewportState?: ReplayViewportState;
}

export interface ReplayFrame {
  tick: number;
  input: Coordinate;
  state: SimulationState;
  uiState: ReplayUiState;
  viewportState?: ReplayViewportState;
  readonly dpsProjection?: FirstPartyPlayerAttackProjectionSummary | null;
  events: GameEvent[];
  actions: EngineAction[];
  /**
   * Length of the cumulative damage log at this frame's tick. damageHistory is
   * append-only and would be O(N^2) if deep-cloned per frame, so it is stored
   * ONCE in the recorder and reconstructed on read (see getFrame).
   */
  damageHistoryLength: number;
  /**
   * Replay-timeline ms (game time) at which this tick actually ran; read it through
   * `frameStartMs`. The recorder always stamps it; `frameStartMs` puts a frame without it (a
   * hand-built display frame) on the 600 ms grid.
   */
  readonly startMs?: number;
  /** Present only for a tick the live loop ran late; see {@link ReplayFrameTiming}. */
  readonly timing?: ReplayFrameTiming;
}

/**
 * Frame-local pixels. `insideFrame` means the point is on the game frame outside the
 * Settings/Plugins sidebar overlap (`ReplayPresentationState.insets`).
 */
export interface ReplayCursorSample {
  readonly tMs: number;
  readonly x: number;
  readonly y: number;
  readonly insideFrame: boolean;
  readonly pinned?: true;
  readonly breakBefore?: true;
  readonly viewportState?: ReplayViewportState;
  /**
   * The recorder's finger, not a mouse: a finger hovers nothing, so playback raises no hover
   * (and no hover tooltip) under it. Absent for a mouse.
   */
  readonly touch?: true;
}

export interface ReplayClickMarker {
  readonly tMs: number;
  readonly x: number;
  readonly y: number;
  /** Same meaning as on a sample: false for a click on a sidebar or on browser chrome. */
  readonly insideFrame: boolean;
  readonly type: ReplayClickType;
  readonly viewportState?: ReplayViewportState;
  /** Same meaning as on a sample. */
  readonly touch?: true;
}

export interface ReplayCursorTrack {
  readonly samples: readonly ReplayCursorSample[];
  readonly clicks: readonly ReplayClickMarker[];
  readonly presentationSamples?: readonly ReplayPresentationSample[];
}

export interface ReplayViewportSample {
  readonly tMs: number;
  readonly viewportState: ReplayViewportState;
}

export interface ReplayViewportTrack {
  readonly samples: readonly ReplayViewportSample[];
}

export interface ReplayRecorderData {
  readonly frames: readonly ReplayFrame[];
  readonly cursorSamples: readonly ReplayCursorSample[];
  readonly cursorClicks: readonly ReplayClickMarker[];
  readonly presentationSamples: readonly ReplayPresentationSample[];
  readonly viewportSamples: readonly ReplayViewportSample[];
  readonly modifierSamples: readonly ReplayModifierSample[];
  /** Omitted when the recording has no menu events. */
  readonly menuEvents?: readonly ReplayMenuEvent[];
  readonly damageHistory: readonly DamageHistoryEntry[];
  readonly runConfig: EngineRunConfig | null;
  /** Absent when the run started without a marker snapshot, or the snapshot exceeded the capture budget. */
  readonly overlays?: ReplayOverlays;
  readonly capture: ReplayCapture;
}

export interface ReplayRecorderOptions {
  /**
   * What the replay clock does while no live tick loop is timing the newest frame (a run start,
   * a stepped frame, a fork). `'running'`, the default, follows wall time up to the tick end, for
   * a recorder fed timestamps without a loop. `'held'` keeps it where it stopped: the start of a
   * stepped or opening frame, or where the loop released a frozen tick. Only the live loop then
   * moves replay time, so no idle or paused time reaches the replay, and events made meanwhile
   * share the held time.
   */
  readonly idleClock?: 'running' | 'held';
}

const VIEWPORT_SAMPLE_MIN_INTERVAL_MS = 16;
const VIEWPORT_SAMPLE_EPSILON = {
  pitchDeg: 0.05,
  yawDeg: 0.05,
  fovScale: 0.1,
  target: 0.005,
} as const;
export class ReplayRecorder {
  private readonly captureBudget: ReplayCaptureBudget;

  constructor(
    limits: Partial<ReplayCaptureLimits> = {},
    private readonly clock = new BackgroundClock(),
    private readonly options: ReplayRecorderOptions = {},
  ) {
    this.captureBudget = new ReplayCaptureBudget(limits);
  }

  getCapture = (): ReplayCapture => this.captureBudget.getCapture();
  subscribeCapture = (listener: () => void): (() => void) => this.captureBudget.subscribeCapture(listener);

  /** The capture budget's per-track entry counts and ancillary bytes. */
  getStats() {
    return this.captureBudget.getStats();
  }

  private frames: ReplayFrame[] = [];
  private engineRunConfig: EngineRunConfig | null = null;
  private pendingActions: EngineAction[] = [];
  private cursorSamples: ReplayCursorSample[] = [];
  private cursorClicks: ReplayClickMarker[] = [];
  private presentationSamples: ReplayPresentationSample[] = [];
  private pointerIsTouch = false;
  private cursorFrameRect: GameFrameRect | null = null;
  private viewportSamples: ReplayViewportSample[] = [];
  private modifierSamples: ReplayModifierSample[] = [];
  private menuEvents: ReplayMenuEvent[] = [];
  private menuState: ReplayMenuState | null = null;
  private menuEntriesReference: readonly ReplayMenuEntry[] | null = null;
  /**
   * The frame-anchored clock, in force whenever the live loop is not timing the newest frame
   * (run start, manual steps, a pause): time since the frame, in ms of game time, held at
   * `subTickCapMs` because nothing says when the next frame comes. With an `idleClock: 'held'`
   * recorder the cap is where the clock stopped, so it never moves on its own.
   */
  private trackClockAtMs = 0;
  private subTickElapsedMs = 0;
  private subTickCapMs = OSRS_TICK_MS - 1;
  private trackClockSegment: {
    readonly atMs: number;
    readonly elapsedMs: number;
    readonly speed: number;
  } | null = null;
  /**
   * The live loop's clock while it is timing the newest frame. Uncapped: the frame lasts until
   * the next tick actually runs, and that tick starts where this clock then stands.
   */
  private liveClock: LiveClockAnchor | null = null;
  /**
   * Latest track time handed out by {@link replayTrackTimeMs}. Switching from the frame-anchored
   * clock to the live one can compute an earlier time than one already stamped; time then holds
   * here instead of running backwards, and the next frame never starts before it.
   */
  private trackTimeFloorMs = 0;
  /**
   * Single shared, append-only copy of the run's damage log. Frames store a
   * length into this array instead of deep-cloning the whole log every tick
   * (which was O(N^2) and OOM'd long fights). Reconstructed per frame on read.
   */
  private cumulativeDamageHistory: DamageHistoryEntry[] = [];
  /**
   * Identity of the engine damage-log array we last synced from. A different
   * reference means the engine reset/swapped its log (e.g. a reset/takeover that
   * did not route through startRun); we then rebuild from scratch rather than
   * append onto a stale prefix.
   */
  private lastDamageHistoryRef: DamageHistoryEntry[] | null = null;
  /** Cached identity-stable wrappers returned by getCursorTrack / getViewportTrack. */
  private cursorTrackCache: ReplayCursorTrack | null = null;
  private viewportTrackCache: ReplayViewportTrack | null = null;
  /** Run-start snapshot; see `ReplayOverlays` for why this is not a track. */
  private overlays: ReplayOverlays | null = null;
  /** Frame 0 is still the untouched opening of a run started here; see {@link finalizeUnadvancedStart}. */
  private openingFinalizable = false;

  /**
   * `overlays` is taken HERE rather than left to the change-driven presentation
   * effect: it is a run-start snapshot, and a recorder whose markers never change
   * would otherwise never produce one.
   */
  startRun(runConfig: EngineRunConfig, overlays?: ReplayOverlays): void {
    this.frames = [];
    this.pendingActions = [];
    this.cursorSamples = [];
    this.cursorClicks = [];
    this.presentationSamples = [];
    this.cursorFrameRect = null;
    this.viewportSamples = [];
    this.modifierSamples = [];
    this.menuEvents = [];
    this.menuState = null;
    this.menuEntriesReference = null;
    this.resetTrackClock(0, 0);
    this.cumulativeDamageHistory = [];
    this.lastDamageHistoryRef = null;
    this.invalidateTrackCaches();
    this.engineRunConfig = structuredClone(runConfig);
    this.overlays = null;
    const capture = freshReplayCapture();
    this.captureBudget.reset(
      {},
      overlays === undefined
        ? capture
        : {
            ...capture,
            overlays: { provenance: 'bounded-v1', stoppedAtMs: null, reason: null },
          },
    );
    if (overlays && this.captureBudget.accept('overlays', { tMs: 0, value: overlays })) {
      this.overlays = structuredClone(overlays);
    }
    this.openingFinalizable = true;
  }

  /**
   * Start an unadvanced fresh run where countdown positioning left the player, as if it had been
   * recorded there: the bootstrap's start position, and frame 0's tile, move target and stationary
   * locomotion with the intro completed. Everything else in frame 0 stays the recorded opening
   * baseline (never live state, which countdown inputs may already have changed), actions queued for
   * the first tick stay pending for frame 1, and ancillary capture restarts here, so no countdown
   * camera, cursor, click, menu or layout history is kept. Refused once the run has advanced,
   * forked, loaded or been finalized.
   */
  finalizeUnadvancedStart(opening: ReplayOpeningPosition, nowMs = performance.now()): boolean {
    const frame = this.frames[0];
    const runConfig = this.engineRunConfig;
    if (!this.openingFinalizable || this.frames.length !== 1 || frame?.tick !== 0 || !runConfig?.bootstrap) {
      return false;
    }
    this.openingFinalizable = false;
    const position = (): Coordinate => [opening.position[0], opening.position[1]];
    this.engineRunConfig = { ...runConfig, bootstrap: { ...runConfig.bootstrap, startPosition: position() } };
    const viewportState = cloneViewportState(opening.viewportState);
    const start = position();
    this.frames[0] = {
      ...frame,
      input: position(),
      state: {
        ...frame.state,
        playerPosition: start,
        playerPreviousPosition: start,
        playerMovementPath: [],
        playerFacingAngle: opening.facingAngle,
        playerIsMoving: false,
        playerIsRunning: false,
        introActive: false,
      },
      ...(viewportState ? { viewportState } : {}),
    };

    this.cursorSamples = [];
    this.cursorClicks = [];
    this.presentationSamples = [];
    this.cursorFrameRect = null;
    this.viewportSamples = [];
    this.modifierSamples = [];
    this.menuEvents = [];
    this.menuState = null;
    this.menuEntriesReference = null;
    this.invalidateTrackCaches();
    this.captureBudget.reset(
      { overlays: this.overlays },
      { ...freshReplayCapture(), overlays: this.captureBudget.getCapture().overlays },
    );
    this.resetTrackClock(this.normalizeEventTimestamp(nowMs), 0);
    if (viewportState) this.storeViewportSample({ tMs: 0, viewportState });
    return true;
  }

  /**
   * Branch the recording at `frameIndex`: keep everything up to and including that frame, drop
   * the future, and keep recording onto the same timeline.
   *
   * Takeover must fork rather than {@link startRun}. A recording whose frame zero is a mid-fight
   * engine cannot be reconstructed at all: the encounter's state machine and every seeded RNG
   * cursor exist only as a function of the ticks that led up to that frame. Retaining the prefix
   * is what lets a taken-over recording be taken over again.
   *
   * Timestamps are deliberately NOT rebased. Track time is already absolute
   * (`frameStartMs(frames, frameIndex) + subTick`), so resuming at the boundary continues the same
   * clock; resetting the sub-tick clock to `nowMs` re-anchors it to the wall
   * clock the resumed run is about to advance on. Rebasing to zero instead would put the branch
   * behind its own retained prefix and break the ascending-`tMs` invariant the replay schema
   * enforces.
   */
  forkAt(frameIndex: number, nowMs = performance.now()): void {
    if (frameIndex < 0 || frameIndex >= this.frames.length) return;
    this.openingFinalizable = false;
    const boundaryMs = frameStartMs(this.frames, frameIndex);
    const retained = this.frames[frameIndex];

    this.frames = this.frames.slice(0, frameIndex + 1);
    this.cursorSamples = this.cursorSamples.filter((sample) => sample.tMs <= boundaryMs);
    this.cursorClicks = this.cursorClicks.filter((click) => click.tMs <= boundaryMs);
    this.presentationSamples = this.presentationSamples.filter((sample) => sample.tMs <= boundaryMs);
    this.viewportSamples = this.viewportSamples.filter((sample) => sample.tMs <= boundaryMs);
    this.modifierSamples = this.modifierSamples.filter((sample) => sample.tMs <= boundaryMs);
    this.menuEvents = this.menuEvents.filter((event) => event.tMs <= boundaryMs);
    this.menuState = buildReplayMenuTimeline(this.menuEvents).at(-1)?.state ?? null;
    this.menuEntriesReference = null;
    this.cumulativeDamageHistory = this.cumulativeDamageHistory.slice(0, retained?.damageHistoryLength ?? 0);

    this.pendingActions = [];
    this.cursorFrameRect = null;
    // The engine is being replaced, so the next frame's damage log is a different array. Holding
    // the old reference would let `syncCumulativeDamageHistory` treat it as a continuation.
    this.lastDamageHistoryRef = null;
    this.resetTrackClock(this.normalizeEventTimestamp(nowMs), boundaryMs);
    this.invalidateTrackCaches();
    this.captureBudget.fork(this.ancillaryData(), boundaryMs);
  }

  recordAction(action: EngineAction): void {
    this.pendingActions.push(action);
  }

  recordFrame(
    tick: number,
    input: Coordinate,
    state: SimulationState,
    events: GameEvent[],
    uiStateOrRecordedAtMs: ReplayUiState | number | ReplayRecordFrameOptions = DEFAULT_REPLAY_UI_STATE,
    recordedAtMs?: number,
  ): void {
    const frameOptions = resolveRecordFrameOptions(uiStateOrRecordedAtMs, recordedAtMs);
    if (this.frames.length > 0) this.openingFinalizable = false;
    const clonedViewportState = cloneViewportState(frameOptions.viewportState);
    const frameRecordedAtMs = frameOptions.recordedAtMs ?? performance.now();
    this.syncCumulativeDamageHistory(state.damageHistory);
    const startMs = this.nextFrameStartMs(frameOptions.liveTick);
    const frame: ReplayFrame = {
      tick,
      startMs,
      input: [...input] as Coordinate,
      state: snapshotStateForReplay(state),
      uiState: structuredClone(frameOptions.uiState),
      ...(clonedViewportState ? { viewportState: clonedViewportState } : {}),
      ...(frameOptions.dpsProjection === undefined
        ? {}
        : { dpsProjection: structuredClone(frameOptions.dpsProjection) }),
      events: structuredClone(events),
      actions: [...this.pendingActions],
      damageHistoryLength: this.cumulativeDamageHistory.length,
    };
    this.frames.push(shareFrameMetadata(frame, this.frames.at(-1)));
    if (clonedViewportState) {
      this.storeViewportSample({ tMs: startMs, viewportState: clonedViewportState });
    }
    this.pendingActions = [];
    this.resetTrackClock(this.normalizeEventTimestamp(frameRecordedAtMs), startMs);
    const liveTick = frameOptions.liveTick;
    if (liveTick && Number.isFinite(liveTick.ranAtMs)) {
      this.liveClock = { atMs: liveTick.ranAtMs, trackMs: startMs, speed: validSpeed(liveTick.speedMultiplier) };
    }
  }

  /**
   * Where the next frame starts on the replay timeline. A tick the live loop ran starts where
   * the live clock stands when it ran, so a late tick leaves the previous frame long. The loop
   * anchors the clock before every tick it times, so only a frame stepped outside it has no
   * real start; that keeps the 600 ms grid. Either way, never before time already stamped, and
   * always after the previous frame.
   */
  private nextFrameStartMs(liveTick: ReplayLiveTickClock | undefined): number {
    if (this.frames.length === 0) return 0;
    const previousStartMs = this.currentFrameStartMs();
    const live = this.liveClock;
    const startMs =
      liveTick && live && Number.isFinite(liveTick.ranAtMs)
        ? this.liveTimeAt(live, liveTick.ranAtMs)
        : previousStartMs + OSRS_TICK_MS;
    return Math.max(startMs, this.trackTimeFloorMs, previousStartMs + 1);
  }

  private currentFrameStartMs(): number {
    return frameStartMs(this.frames, this.frames.length - 1);
  }

  /**
   * Hand the newest frame to the live loop's clock at active time `atMs`, from where the replay
   * clock stands then. The loop does this whenever it starts or resumes timing a tick: when a
   * run or a takeover begins on it, and when it picks up a tick it froze. A frozen tick resumes
   * exactly where it was released, so the time it spent frozen is left out. A frame recorded
   * before the loop ran at all (an opening frame during an intro, a stepped frame) is picked up
   * where the idle clock stands: its start with `idleClock: 'held'`, otherwise at most its tick
   * end. Nothing already stamped moves.
   */
  anchorLiveClock(atMs: number, speedMultiplier: number): void {
    if (this.frames.length === 0 || !Number.isFinite(atMs)) return;
    const trackMs = this.trackTimeAt(speedMultiplier, atMs);
    this.liveClock = { atMs, trackMs, speed: validSpeed(speedMultiplier) };
  }

  /**
   * Freeze the newest frame's clock at active time `atMs`, where the live loop stopped timing
   * it: the loop stopped, or the engine cannot advance. The frame holds there, so events until
   * the loop picks the tick up again share that time, and the tick's length stays its real
   * running time. A frame stepped afterwards starts after it on the 600 ms grid.
   */
  releaseLiveClock(atMs: number): void {
    const live = this.liveClock;
    if (!live) return;
    this.liveClock = null;
    const positionMs = Number.isFinite(atMs)
      ? Math.max(this.liveTimeAt(live, atMs), this.trackTimeFloorMs)
      : this.trackTimeFloorMs;
    const subTickMs = positionMs - this.currentFrameStartMs();
    if (Number.isFinite(atMs)) this.trackClockAtMs = atMs;
    this.subTickElapsedMs = subTickMs;
    this.subTickCapMs = subTickMs;
    this.trackClockSegment = null;
  }

  /**
   * Keep late-tick diagnostics on the newest frame, if it ran more than
   * {@link REPLAY_LATE_TICK_THRESHOLD_MS} late. Values are clamped to the replay format's bound,
   * so a long stall can never make the recording invalid.
   */
  recordFrameTiming(timing: ReplayFrameTiming): void {
    const index = this.frames.length - 1;
    const frame = this.frames[index];
    if (!frame) return;
    // The threshold reads the measured lateness; only the stored value is rounded.
    if (!Number.isFinite(timing.lateByMs) || timing.lateByMs <= REPLAY_LATE_TICK_THRESHOLD_MS) return;
    const lateByMs = timingMs(timing.lateByMs) ?? 0;
    const rafGapMs = timingMs(timing.rafGapMs);
    const tickWorkMs = timingMs(timing.tickWorkMs);
    this.frames[index] = {
      ...frame,
      timing: {
        lateByMs,
        ...(rafGapMs === undefined ? {} : { rafGapMs }),
        ...(tickWorkMs === undefined ? {} : { tickWorkMs }),
      },
    };
  }

  private resetTrackClock(atMs: number, floorMs: number): void {
    this.trackClockAtMs = atMs;
    this.subTickElapsedMs = 0;
    this.subTickCapMs = this.options.idleClock === 'held' ? 0 : OSRS_TICK_MS - 1;
    this.trackClockSegment = null;
    this.liveClock = null;
    this.trackTimeFloorMs = floorMs;
  }

  /**
   * Whether the recorder's last pointer was a touch pointer (as the page's `isTouchPointer`
   * decides), from the page's pointer events. Stamped on every sample and click until the next
   * one, because the clicks the game code reports (a tap dispatched as a mousedown) do not know
   * which device made them.
   */
  notePointerIsTouch(isTouch: boolean): void {
    this.pointerIsTouch = isTouch;
  }

  recordCursorSample(
    clientX: number,
    clientY: number,
    speedMultiplier: number,
    frameRect: GameFrameRect,
    nowMs = performance.now(),
    viewportState?: ReplayViewportState,
    insets?: ReplayPresentationInsets,
  ): void {
    this.recordCursorPoint(clientX, clientY, speedMultiplier, frameRect, nowMs, viewportState, insets, false);
  }

  /**
   * Where a finger came down. A finger held still sends no moves, so without this the
   * cursor at a long-press's menu would still be wherever the previous gesture ended.
   * Pinned, like a click's sample, so tail compaction never drops or retimes it: playback
   * finds a hold's press point by this sample (see `projectActiveHolds`).
   */
  recordCursorPress(
    clientX: number,
    clientY: number,
    speedMultiplier: number,
    frameRect: GameFrameRect,
    nowMs = performance.now(),
    insets?: ReplayPresentationInsets,
  ): void {
    this.recordCursorPoint(clientX, clientY, speedMultiplier, frameRect, nowMs, undefined, insets, true);
  }

  private recordCursorPoint(
    clientX: number,
    clientY: number,
    speedMultiplier: number,
    frameRect: GameFrameRect,
    nowMs: number,
    viewportState: ReplayViewportState | undefined,
    insets: ReplayPresentationInsets | undefined,
    pinned: boolean,
  ): void {
    if (this.captureBudget.isStopped('cursorSamples')) return;
    const clonedViewportState = cloneViewportState(viewportState);
    const clientPoint = { clientX, clientY };
    const localPoint = toReplayCursorPoint(clientPoint, frameRect, insets);
    this.storeCursorSample(
      {
        tMs: this.cursorTrackTimeMs(speedMultiplier, nowMs),
        ...localPoint,
        ...(pinned ? { pinned: true as const } : {}),
        ...(clonedViewportState ? { viewportState: clonedViewportState } : {}),
        ...(this.pointerIsTouch ? { touch: true as const } : {}),
      },
      frameRect,
    );
  }

  /**
   * Snapshot of the layout the cursor is being recorded against.
   *
   * Only stored when something actually moved — layout changes are rare, so the
   * track is a handful of entries for a whole fight.
   */
  recordPresentationState(speedMultiplier: number, nowMs: number, state: ReplayPresentationState): void {
    if (this.captureBudget.isStopped('presentationSamples')) return;
    const previous = this.presentationSamples.at(-1);
    if (previous && replayPresentationStatesEqual(previous.state, state)) return;
    const tMs = this.replayTrackTimeMs(speedMultiplier, nowMs);
    if (
      !this.captureBudget.accept('presentationSamples', {
        tMs,
        value: { tMs, state },
        ...(previous?.tMs === tMs ? { previous } : {}),
      })
    )
      return;
    const sample: ReplayPresentationSample = { tMs, state: structuredClone(state) };
    if (previous && previous.tMs === tMs) {
      this.presentationSamples[this.presentationSamples.length - 1] = sample;
      return;
    }
    this.presentationSamples.push(sample);
  }

  getPresentationTrack(): readonly ReplayPresentationSample[] {
    return this.presentationSamples;
  }

  recordMenuState(speedMultiplier: number, nowMs: number, state: ReplayMenuState | null): void {
    if (this.captureBudget.isStopped('menuEvents')) return;
    const previous = this.menuState;
    if (state === null) {
      if (previous === null && this.menuEvents.length > 0) return;
      const event = { kind: 'close', tMs: this.replayTrackTimeMs(speedMultiplier, nowMs) } as const;
      if (!this.captureBudget.accept('menuEvents', { tMs: event.tMs, value: event })) return;
      this.menuEvents.push(event);
      this.menuState = null;
      this.menuEntriesReference = null;
      return;
    }
    if (previous === null || this.menuEntriesReference !== state.entries) {
      const captured = copyReplayMenuState(state);
      const event = { kind: 'open', tMs: this.replayTrackTimeMs(speedMultiplier, nowMs), state: captured } as const;
      if (!this.captureBudget.accept('menuEvents', { tMs: event.tMs, value: event })) return;
      this.menuEvents.push(event);
      this.menuState = captured;
      this.menuEntriesReference = state.entries;
      return;
    }
    if (replayMenuViewsEqual(previous, state)) return;
    const view = copyReplayMenuView(state);
    const event = { kind: 'update', tMs: this.replayTrackTimeMs(speedMultiplier, nowMs), view } as const;
    if (!this.captureBudget.accept('menuEvents', { tMs: event.tMs, value: event })) return;
    this.menuEvents.push(event);
    this.menuState = { ...view, entries: previous.entries };
  }

  getMenuTrack(): readonly ReplayMenuEvent[] {
    return this.menuEvents;
  }

  getOverlays(): ReplayOverlays | null {
    return this.overlays;
  }

  recordViewportSample(speedMultiplier: number, nowMs: number, viewportState: ReplayViewportState): void {
    if (this.captureBudget.isStopped('viewportSamples')) return;
    const sample: ReplayViewportSample = {
      tMs: this.replayTrackTimeMs(speedMultiplier, nowMs),
      viewportState,
    };
    this.storeViewportSample(sample);
  }

  /**
   * Appends only when the held state actually changes, so the whole track is a
   * handful of entries even for a fight spent flicking Shift.
   */
  recordModifierSample(speedMultiplier: number, nowMs: number, mask: number, buttons = 0): void {
    if (this.captureBudget.isStopped('modifierSamples')) return;
    const previous = this.modifierSamples.at(-1);
    if (previous?.mask === mask && previous.buttons === buttons) return;
    const tMs = this.replayTrackTimeMs(speedMultiplier, nowMs);
    if (previous && previous.tMs === tMs) {
      // Press and release inside the same recorded millisecond. The state at tMs is
      // whichever came last, and if that returns to the state before it, the pair
      // never happened as far as playback can tell. Nothing before the first sample
      // means nothing held, which is why the fallback is 0 rather than a skip.
      const prior = this.modifierSamples.at(-2);
      if ((prior?.mask ?? 0) === mask && (prior?.buttons ?? 0) === buttons) {
        this.captureBudget.remove('modifierSamples', previous);
        this.modifierSamples.pop();
        return;
      }
      const sample = { tMs, mask, buttons };
      if (!this.captureBudget.accept('modifierSamples', { tMs, value: sample, previous })) return;
      this.modifierSamples[this.modifierSamples.length - 1] = sample;
      return;
    }
    if (!this.captureBudget.accept('modifierSamples', { tMs, value: { tMs, mask, buttons } })) return;
    this.modifierSamples.push({ tMs, mask, buttons });
  }

  getModifierTrack(): readonly ReplayModifierSample[] {
    return this.modifierSamples;
  }

  private storeViewportSample(sample: ReplayViewportSample): void {
    if (this.captureBudget.isStopped('viewportSamples')) return;
    const previous = this.viewportSamples.at(-1);
    if (previous) {
      if (viewportStatesEquivalent(previous.viewportState, sample.viewportState)) return;
      if (previous.tMs !== sample.tMs && shouldCoalesceViewportSample(previous, sample)) return;
    }

    if (
      !this.captureBudget.accept('viewportSamples', {
        tMs: sample.tMs,
        value: sample,
        ...(previous?.tMs === sample.tMs ? { previous } : {}),
      })
    )
      return;
    const captured = { tMs: sample.tMs, viewportState: structuredClone(sample.viewportState) };
    if (previous?.tMs === sample.tMs) {
      this.viewportSamples[this.viewportSamples.length - 1] = captured;
      return;
    }
    this.viewportSamples.push(captured);
  }

  private storeCursorSample(sample: ReplayCursorSample, frameRect: GameFrameRect): void {
    if (this.captureBudget.isStopped('cursorSamples')) return;
    const previous = this.cursorSamples.at(-1);
    const sameFrame =
      this.cursorFrameRect?.left === frameRect.left &&
      this.cursorFrameRect.top === frameRect.top &&
      this.cursorFrameRect.width === frameRect.width &&
      this.cursorFrameRect.height === frameRect.height;
    const sameContext =
      sameFrame &&
      previous !== undefined &&
      previous.insideFrame === sample.insideFrame &&
      previous.touch === sample.touch &&
      (previous.viewportState === sample.viewportState ||
        (previous.viewportState !== undefined &&
          sample.viewportState !== undefined &&
          viewportStatesEquivalent(previous.viewportState, sample.viewportState)));
    const presentationTime = this.presentationSamples.at(-1)?.tMs ?? -1;
    const boundary =
      previous !== undefined && (!sameFrame || (presentationTime > previous.tMs && presentationTime <= sample.tMs));
    const candidate: ReplayCursorSample = boundary ? { ...sample, breakBefore: true } : sample;
    const repeated = sameContext && sample.pinned !== true && previous.x === sample.x && previous.y === sample.y;
    if (repeated && previous.tMs === sample.tMs) return;

    const update = sameContext && !boundary ? replayCursorTailUpdate(this.cursorSamples, candidate) : null;
    if (
      !this.captureBudget.accept('cursorSamples', {
        tMs: sample.tMs,
        value: candidate,
        ...(update && update.count > 0 ? { previous: this.cursorSamples.at(-update.fromEnd) } : {}),
      })
    )
      return;
    if (!sameFrame) this.cursorFrameRect = { ...frameRect };
    const captured = shareViewportMetadata(candidate, previous);
    if (update && update.count > 0) {
      const removed = this.cursorSamples.splice(this.cursorSamples.length - update.fromEnd, update.count);
      for (let index = 1; index < removed.length; index++) this.captureBudget.remove('cursorSamples', removed[index]);
    }

    this.cursorSamples.push(captured);
  }

  recordCursorClick(
    clientX: number,
    clientY: number,
    type: ReplayClickType,
    speedMultiplier: number,
    frameRect: GameFrameRect,
    nowMs = performance.now(),
    viewportState?: ReplayViewportState,
    insets?: ReplayPresentationInsets,
  ): void {
    if (this.captureBudget.isStopped('cursorClicks') && this.captureBudget.isStopped('cursorSamples')) return;
    const tMs = this.cursorTrackTimeMs(speedMultiplier, nowMs);
    const clientPoint = { clientX, clientY };
    const localPoint = toReplayCursorPoint(clientPoint, frameRect, insets);
    const click = {
      tMs,
      ...localPoint,
      type,
      ...(viewportState ? { viewportState } : {}),
      ...(this.pointerIsTouch ? { touch: true as const } : {}),
    };
    if (this.captureBudget.accept('cursorClicks', { tMs, value: click })) {
      this.cursorClicks.push(shareViewportMetadata(structuredClone(click), this.cursorClicks.at(-1)));
    }
    if (!this.captureBudget.isStopped('cursorSamples'))
      this.storeCursorSample(
        {
          tMs,
          ...localPoint,
          pinned: true,
          ...(viewportState ? { viewportState: structuredClone(viewportState) } : {}),
          ...(this.pointerIsTouch ? { touch: true as const } : {}),
        },
        frameRect,
      );
  }

  getCursorTrack(): ReplayCursorTrack {
    if (!this.cursorTrackCache) {
      this.cursorTrackCache = {
        samples: this.cursorSamples,
        clicks: this.cursorClicks,
        presentationSamples: this.presentationSamples,
      };
    }
    return this.cursorTrackCache;
  }

  getViewportTrack(): ReplayViewportTrack {
    if (!this.viewportTrackCache) {
      this.viewportTrackCache = { samples: this.viewportSamples };
    }
    return this.viewportTrackCache;
  }

  /** Invalidate track-derived caches wherever a track array is REASSIGNED. */
  private invalidateTrackCaches(): void {
    this.cursorTrackCache = null;
    this.viewportTrackCache = null;
  }

  /**
   * Like {@link replayTrackTimeMs}, but an input event delivered late keeps the time it carries,
   * as long as that is not before the current clock segment and does not reorder the cursor track.
   */
  private cursorTrackTimeMs(speedMultiplier: number, nowMs: number): number {
    const observedTimeMs = this.replayTrackTimeMs(speedMultiplier, nowMs);
    const normalizedNowMs = this.normalizeEventTimestamp(nowMs);
    const segment = this.trackClockSegment;
    const live = this.liveClock;
    let eventTimeMs = observedTimeMs;
    if (live) {
      if (Number.isFinite(normalizedNowMs) && normalizedNowMs >= live.atMs) {
        eventTimeMs = this.liveTimeAt(live, normalizedNowMs);
      }
    } else if (segment && Number.isFinite(normalizedNowMs) && normalizedNowMs >= segment.atMs) {
      eventTimeMs =
        this.currentFrameStartMs() +
        Math.min(segment.elapsedMs + (normalizedNowMs - segment.atMs) * segment.speed, this.subTickCapMs);
    }
    return Math.max(eventTimeMs, this.cursorSamples.at(-1)?.tMs ?? 0, this.cursorClicks.at(-1)?.tMs ?? 0);
  }

  /**
   * The live clock runs at its own rate, which the loop re-anchors when the speed changes, so
   * this only matters for the frame-anchored clock.
   */
  checkpointSpeedChange(previousSpeedMultiplier: number, nowMs = performance.now()): void {
    this.replayTrackTimeMs(previousSpeedMultiplier, nowMs);
    this.trackClockSegment = null;
  }

  private liveTimeAt(live: LiveClockAnchor, activeMs: number): number {
    return live.trackMs + Math.max(0, activeMs - live.atMs) * live.speed;
  }

  private replayTrackTimeMs(speedMultiplier: number, nowMs: number): number {
    return this.trackTimeAt(speedMultiplier, this.normalizeEventTimestamp(nowMs));
  }

  /** The replay clock at active time `activeMs`, never earlier than time already handed out. */
  private trackTimeAt(speedMultiplier: number, activeMs: number): number {
    const live = this.liveClock;
    if (live) {
      if (Number.isFinite(activeMs)) {
        this.trackTimeFloorMs = Math.max(this.trackTimeFloorMs, this.liveTimeAt(live, activeMs));
      }
      return this.trackTimeFloorMs;
    }
    const speed = validSpeed(speedMultiplier);
    if (Number.isFinite(activeMs) && activeMs > this.trackClockAtMs) {
      if (this.trackClockSegment?.speed !== speed) {
        this.trackClockSegment = { atMs: this.trackClockAtMs, elapsedMs: this.subTickElapsedMs, speed };
      }
      // Without a speed-change checkpoint, the supplied rate applies only since the last clock observation.
      const elapsedMs = activeMs - this.trackClockAtMs;
      this.subTickElapsedMs = Math.min(this.subTickElapsedMs + elapsedMs * speed, this.subTickCapMs);
      this.trackClockAtMs = activeMs;
    }
    this.trackTimeFloorMs = Math.max(this.trackTimeFloorMs, this.currentFrameStartMs() + this.subTickElapsedMs);
    return this.trackTimeFloorMs;
  }

  private normalizeEventTimestamp(timestampMs: number): number {
    const epochRelativeTimestamp = timestampMs - performance.timeOrigin;
    if (
      epochRelativeTimestamp >= 0 &&
      Math.abs(epochRelativeTimestamp - performance.now()) < Math.abs(timestampMs - performance.now())
    ) {
      return this.clock.now(epochRelativeTimestamp);
    }
    return this.clock.now(timestampMs);
  }

  /**
   * Append newly-added damage entries (cloned once) to the shared cumulative
   * log. damageHistory is append-only within a run and entries are immutable
   * after their tick, so cloning each once is identical to cloning the whole
   * log every frame — at O(N) total instead of O(N^2). If the engine reset or
   * swapped its log (new array identity, or a shorter live log), rebuild from
   * scratch so we never append onto a stale prefix.
   */
  private syncCumulativeDamageHistory(live: DamageHistoryEntry[] | undefined): void {
    if (!live) return;
    if (live !== this.lastDamageHistoryRef || live.length < this.cumulativeDamageHistory.length) {
      this.cumulativeDamageHistory = live.map((entry) => structuredClone(entry));
      this.lastDamageHistoryRef = live;
      return;
    }
    for (let i = this.cumulativeDamageHistory.length; i < live.length; i++) {
      this.cumulativeDamageHistory.push(structuredClone(live[i]));
    }
  }

  getFrame(index: number): ReplayFrame | undefined {
    const frame = this.frames[index];
    if (!frame) return undefined;
    // Rebuild the append-only damage log up to this frame's tick from the single
    // shared array (it was not deep-cloned into the frame). slice() shares entry
    // references — entries are immutable post-tick — so this is cheap and correct.
    return {
      ...frame,
      state: {
        ...frame.state,
        damageHistory: this.cumulativeDamageHistory.slice(0, frame.damageHistoryLength),
      },
    };
  }

  /**
   * Viewport state for a frame WITHOUT rebuilding its damage log.
   *
   * PERF: the playback loop needs only the camera, and it runs once per animation
   * frame. Going through {@link getFrame} there re-`slice`d the whole cumulative
   * damage history 60-144x/s and swapped the array identity on the live
   * `displayState` object, churning allocations and invalidating downstream memos
   * for a value the caller never reads.
   */
  getFrameViewportState(index: number): ReplayViewportState | undefined {
    return this.frames[index]?.viewportState;
  }

  getFrameCount(): number {
    return this.frames.length;
  }

  getDisplayFrames(): readonly ReplayDisplayFrame[] {
    return this.frames;
  }

  getReconstructionFrames(): readonly Readonly<ReplayFrame>[] {
    return this.frames;
  }

  getRunConfig(): EngineRunConfig | null {
    return this.engineRunConfig;
  }

  exportData(): ReplayRecorderData {
    return structuredClone({
      frames: this.frames,
      cursorSamples: this.cursorSamples,
      cursorClicks: this.cursorClicks,
      presentationSamples: this.presentationSamples,
      viewportSamples: this.viewportSamples,
      modifierSamples: this.modifierSamples,
      ...(this.menuEvents.length === 0 ? {} : { menuEvents: this.menuEvents }),
      damageHistory: this.cumulativeDamageHistory,
      runConfig: this.engineRunConfig,
      capture: this.getCapture(),
      ...(this.overlays === null ? {} : { overlays: this.overlays }),
    });
  }

  /**
   * Installs a recording. Events in the encounter wire shapes of older builds, and states with the
   * single offensive prayer slot, are converted to today's as they are read
   * (`decodeLegacyReplayFrames`, `decodeLegacyPrayerState`), so an export after a load writes the
   * current shapes; the caller's data is never modified. Throws, installing nothing, when a recognized
   * old event is malformed.
   */
  load(data: ReplayRecorderData): void {
    const copy = structuredClone({
      ...data,
      frames: decodeLegacyReplayFrames(data.frames).map((frame) => ({
        ...frame,
        state: { ...decodeLegacyPrayerState(frame.state), damageHistory: [] },
      })),
    });
    this.frames = [];
    for (const frame of copy.frames) {
      this.frames.push(shareFrameMetadata(frame, this.frames.at(-1)));
    }
    this.cursorSamples = shareViewportTrack(copy.cursorSamples);
    this.cursorClicks = shareViewportTrack(copy.cursorClicks);
    this.presentationSamples = [...copy.presentationSamples];
    this.viewportSamples = [...copy.viewportSamples];
    this.modifierSamples = [...copy.modifierSamples];
    this.menuEvents = [...(copy.menuEvents ?? [])];
    this.menuState = buildReplayMenuTimeline(this.menuEvents).at(-1)?.state ?? null;
    this.menuEntriesReference = null;
    this.cumulativeDamageHistory = [...copy.damageHistory];
    this.engineRunConfig = copy.runConfig;
    this.overlays = copy.overlays ?? null;
    this.pendingActions = [];
    this.cursorFrameRect = null;
    this.resetTrackClock(0, 0);
    this.lastDamageHistoryRef = null;
    this.invalidateTrackCaches();
    this.captureBudget.reset(this.ancillaryData(), copy.capture);
    this.openingFinalizable = false;
  }

  hasRecording(): boolean {
    return this.frames.length > 0;
  }

  clear(): void {
    this.frames = [];
    this.pendingActions = [];
    this.cursorSamples = [];
    this.cursorClicks = [];
    this.presentationSamples = [];
    this.cursorFrameRect = null;
    this.viewportSamples = [];
    this.modifierSamples = [];
    this.menuEvents = [];
    this.menuState = null;
    this.menuEntriesReference = null;
    this.resetTrackClock(0, 0);
    this.engineRunConfig = null;
    this.cumulativeDamageHistory = [];
    this.lastDamageHistoryRef = null;
    this.overlays = null;
    this.invalidateTrackCaches();
    this.captureBudget.reset();
    this.openingFinalizable = false;
  }

  private ancillaryData() {
    return {
      cursorSamples: this.cursorSamples,
      cursorClicks: this.cursorClicks,
      viewportSamples: this.viewportSamples,
      presentationSamples: this.presentationSamples,
      modifierSamples: this.modifierSamples,
      menuEvents: this.menuEvents,
      overlays: this.overlays,
    };
  }
}

// Only readonly frame metadata may be shared; SimulationState remains mutable to its readers.
function shareFrameMetadata(frame: ReplayFrame, previous: ReplayFrame | undefined): ReplayFrame {
  if (!previous) return frame;
  return {
    ...shareViewportMetadata(frame, previous),
    uiState: reuseMetadata(frame.uiState, previous.uiState),
    ...(frame.dpsProjection === undefined
      ? {}
      : { dpsProjection: reuseMetadata(frame.dpsProjection, previous.dpsProjection) }),
  };
}

function shareViewportMetadata<T extends { readonly viewportState?: ReplayViewportState }>(
  sample: T,
  previous: { readonly viewportState?: ReplayViewportState } | undefined,
): T {
  if (sample.viewportState === undefined) return sample;
  const viewportState = reuseMetadata(sample.viewportState, previous?.viewportState);
  return viewportState === sample.viewportState ? sample : { ...sample, viewportState };
}

function shareViewportTrack<T extends { readonly viewportState?: ReplayViewportState }>(samples: readonly T[]): T[] {
  const shared: T[] = [];
  for (const sample of samples) shared.push(shareViewportMetadata(sample, shared.at(-1)));
  return shared;
}

function reuseMetadata<T>(value: T, previous: T | undefined): T {
  if (previous === undefined) return value;
  const leftPairs = new WeakMap<object, object>();
  const rightPairs = new WeakMap<object, object>();
  const equal = (left: unknown, right: unknown): boolean => {
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
      return Object.is(left, right);
    }
    if (leftPairs.has(left) || rightPairs.has(right)) {
      return leftPairs.get(left) === right && rightPairs.get(right) === left;
    }
    leftPairs.set(left, right);
    rightPairs.set(right, left);
    if (Object.is(left, right)) return true;
    const prototype = Object.getPrototypeOf(left);
    if (prototype !== Object.getPrototypeOf(right) || (prototype !== Object.prototype && prototype !== Array.prototype))
      return false;
    const keys = Reflect.ownKeys(left);
    const rightKeys = Reflect.ownKeys(right);
    return (
      keys.length === rightKeys.length &&
      keys.every((key, index) => key === rightKeys[index] && equal(Reflect.get(left, key), Reflect.get(right, key)))
    );
  };
  return equal(value, previous) ? previous : value;
}

// Remove unused histories before cloning; damageHistory is stored once and reconstructed by getFrame().
function snapshotStateForReplay(state: SimulationState): SimulationState {
  const snapshot = structuredClone({
    ...state,
    eventLog: [],
    damageHistory: [],
    playerHistory: new Map(),
    primaryNpcHistory: new Map(),
  });
  // Clear these after cloning so references to the same NPC elsewhere in the snapshot stay aliases.
  for (const npc of snapshot.npcs ?? []) npc.history = new Map();
  return snapshot;
}

function resolveRecordFrameOptions(
  uiStateOrRecordedAtMs: ReplayUiState | number | ReplayRecordFrameOptions,
  recordedAtMs?: number,
): Required<Pick<ReplayRecordFrameOptions, 'uiState'>> & Omit<ReplayRecordFrameOptions, 'uiState'> {
  if (typeof uiStateOrRecordedAtMs === 'number') {
    return { uiState: DEFAULT_REPLAY_UI_STATE, recordedAtMs: uiStateOrRecordedAtMs };
  }
  if ('activeGamePanelTab' in uiStateOrRecordedAtMs) {
    return { uiState: uiStateOrRecordedAtMs, ...(recordedAtMs === undefined ? {} : { recordedAtMs }) };
  }
  return { uiState: uiStateOrRecordedAtMs.uiState ?? DEFAULT_REPLAY_UI_STATE, ...uiStateOrRecordedAtMs };
}

function validSpeed(speedMultiplier: number): number {
  return Number.isFinite(speedMultiplier) && speedMultiplier > 0 ? speedMultiplier : 1;
}

function timingMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(Math.round(Math.max(0, value)), MAX_REPLAY_FRAME_TIMING_MS);
}

function shouldCoalesceViewportSample(previous: ReplayViewportSample, sample: ReplayViewportSample): boolean {
  if (viewportStatesEquivalent(previous.viewportState, sample.viewportState)) return true;
  const elapsedMs = sample.tMs - previous.tMs;
  return (
    elapsedMs < VIEWPORT_SAMPLE_MIN_INTERVAL_MS &&
    viewportStatesNearlyEqual(previous.viewportState, sample.viewportState)
  );
}

function viewportStatesEquivalent(a: ReplayViewportState, b: ReplayViewportState): boolean {
  return viewportStatesWithin(a, b, 0);
}

function viewportStatesNearlyEqual(a: ReplayViewportState, b: ReplayViewportState): boolean {
  return viewportStatesWithin(a, b, 1);
}

function viewportStatesWithin(a: ReplayViewportState, b: ReplayViewportState, multiplier: number): boolean {
  return (
    Math.abs(a.pitchDeg - b.pitchDeg) <= VIEWPORT_SAMPLE_EPSILON.pitchDeg * multiplier &&
    Math.abs(a.yawDeg - b.yawDeg) <= VIEWPORT_SAMPLE_EPSILON.yawDeg * multiplier &&
    Math.abs(a.fovScale - b.fovScale) <= VIEWPORT_SAMPLE_EPSILON.fovScale * multiplier &&
    Math.abs(a.target.x - b.target.x) <= VIEWPORT_SAMPLE_EPSILON.target * multiplier &&
    Math.abs(a.target.y - b.target.y) <= VIEWPORT_SAMPLE_EPSILON.target * multiplier &&
    Math.abs(a.target.z - b.target.z) <= VIEWPORT_SAMPLE_EPSILON.target * multiplier
  );
}

function cloneViewportState(viewportState: ReplayViewportState | undefined): ReplayViewportState | undefined {
  return viewportState ? structuredClone(viewportState) : undefined;
}

/**
 * The sample in force at `playheadMs`, i.e. the last one at or before it, or -1 when the
 * playhead precedes the track. Both readers below run on every replay frame-store update,
 * so this must not be O(samples).
 */
function modifierSampleIndexAt(samples: readonly ReplayModifierSample[], playheadMs: number): number {
  const first = samples[0];
  if (!first || playheadMs < first.tMs) return -1;

  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const sample = samples[mid];
    if (sample && sample.tMs <= playheadMs) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function modifierMaskAt(samples: readonly ReplayModifierSample[], playheadMs: number): number {
  const index = modifierSampleIndexAt(samples, playheadMs);
  return index === -1 ? 0 : (samples[index]?.mask ?? 0);
}

export function mouseButtonMaskAt(samples: readonly ReplayModifierSample[], playheadMs: number): number {
  const index = modifierSampleIndexAt(samples, playheadMs);
  return index === -1 ? 0 : (samples[index]?.buttons ?? 0);
}
