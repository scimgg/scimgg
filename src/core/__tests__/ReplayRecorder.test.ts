import { afterEach, describe, expect, it, vi } from 'vitest';
import { interpolateCursor } from '../../components/replayCursorProjection';
import { YamaEncounter } from '../../encounters/yamaP3/YamaEncounter';
import type { WorkspacePresentationGeometry } from '../../layout/workspaceLayout';
import { interpolateReplayViewportState } from '../../render/projections/replayViewportMapper';
import type { ReplayCaptureTrack } from '../../replay/format/capture';
import { MAX_REPLAY_FRAME_TIMING_MS } from '../../replay/format/limits';
import { ReplayPresentationStateSchema } from '../../replay/format/presentationFormat';
import { yamaSnapshot } from '../../test/helpers/encounterSnapshot';
import {
  LEGACY_INFERNO_EVENTS,
  LEGACY_SOL_EVENTS,
  LEGACY_YAMA,
  LEGACY_YAMA_EVENTS,
  legacyInfernoRecording,
  legacySolRecording,
  legacyYamaRecording,
} from '../../test/helpers/legacyEncounterRecordings';
import { compactReplayCursorSamples } from '../../test/helpers/replayCursorCompaction';
import { validPresentationSample } from '../../test/helpers/replayFixtures';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyStats as createEmptyEquipmentStats } from '../../types/equipmentStats';
import { createEmptyInventory } from '../../types/inventory';
import {
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
  POISON_TICK_INTERVAL,
} from '../../types/playerState';
import {
  type Coordinate,
  createDefaultPrayerState,
  type DamageHistoryEntry,
  type SimulationState,
} from '../../types/simulation';
import { BackgroundClock } from '../../util/BackgroundClock';
import type { GameFrameRect } from '../../util/viewportBounds';
import type { ActorId } from '../actors/types';
import { isYamaSnapshot } from '../encounters/snapshot';
import { isActorPresentationsRemovedEvent, isEncounterVisualEvent } from '../events/encounterVisual';
import type { GameEvent } from '../events/types';
import { LegacyReplayEventError } from '../legacyReplayEvents';
import {
  DEFAULT_REPLAY_UI_STATE,
  modifierMaskAt,
  mouseButtonMaskAt,
  ReplayRecorder,
  type ReplayViewportState,
} from '../ReplayRecorder';
import { ReplayFrameStore } from '../replayFrameStore';
import { buildReplayMenuTimeline, type ReplayMenuState, replayMenuStateAt } from '../replayMenu';
import type { ReplayOverlays } from '../replayPresentation';
import { type EngineAction, type EngineRunConfig, SimulationEngine } from '../SimulationEngine';

const RUN_CONFIG: EngineRunConfig = {
  completionOwnership: 'encounter-owned',
  encounter: { kind: 'yama_p3', seeds: {} },
};
const FRAME: GameFrameRect = { left: 100, top: 50, width: 400, height: 200 };
const VIEWPORT_STATE: ReplayViewportState = {
  kind: 'orbit3d',
  pitchDeg: -45,
  yawDeg: 180,
  fovScale: 512,
  target: { x: 31.5, y: 37.5, z: 0.9 },
};

describe('ReplayRecorder capture budgets', () => {
  const menu: ReplayMenuState = {
    entries: [{ action: 'Cancel' }],
    x: 0,
    y: 0,
    scale: 1,
    hoveredIndex: -1,
    submenuParentIndex: -1,
    hoveredSubmenuIndex: -1,
    submenuPosition: null,
  };
  const presentation = ReplayPresentationStateSchema.parse(validPresentationSample().state);
  const tracks: readonly {
    track: Exclude<ReplayCaptureTrack, 'overlays'>;
    write: (recorder: ReplayRecorder, index: number) => void;
    read: (recorder: ReplayRecorder) => readonly unknown[];
  }[] = [
    {
      track: 'cursorSamples',
      write: (recorder, index) => recorder.recordCursorSample(110 + index * 10, 60, 1, FRAME, index * 20),
      read: (recorder) => recorder.getCursorTrack().samples,
    },
    {
      track: 'cursorClicks',
      write: (recorder, index) => recorder.recordCursorClick(110, 60, 'ui', 1, FRAME, index * 20),
      read: (recorder) => recorder.getCursorTrack().clicks,
    },
    {
      track: 'viewportSamples',
      write: (recorder, index) =>
        recorder.recordViewportSample(1, index * 20, { ...VIEWPORT_STATE, yawDeg: index * 10 }),
      read: (recorder) => recorder.getViewportTrack().samples,
    },
    {
      track: 'modifierSamples',
      write: (recorder, index) => recorder.recordModifierSample(1, index * 20, index % 4),
      read: (recorder) => recorder.getModifierTrack(),
    },
    {
      track: 'presentationSamples',
      write: (recorder, index) =>
        recorder.recordPresentationState(1, index * 20, { ...presentation, uiScale: index + 1 }),
      read: (recorder) => recorder.getPresentationTrack(),
    },
    {
      track: 'menuEvents',
      write: (recorder, index) => recorder.recordMenuState(1, index * 20, index % 2 === 0 ? null : menu),
      read: (recorder) => recorder.getMenuTrack(),
    },
  ];

  it.each(tracks)('preserves the exact $track limit and its prefix after overflow', ({ track, write, read }) => {
    const recorder = new ReplayRecorder({ [track]: 2 });
    recorder.startRun(RUN_CONFIG);
    write(recorder, 0);
    write(recorder, 1);
    const before = structuredClone(read(recorder));
    expect(read(recorder)).toHaveLength(2);
    expect(recorder.getCapture()[track].stoppedAtMs).toBeNull();

    write(recorder, 2);
    write(recorder, 3);

    expect(read(recorder)).toEqual(before);
    expect(recorder.getCapture()[track]).toEqual({ provenance: 'bounded-v1', stoppedAtMs: 40, reason: 'entry-limit' });
  });

  it('marks what a finger recorded, including the clicks its taps report, until a mouse moves again', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);

    recorder.recordCursorSample(110, 60, 1, FRAME, 0);
    recorder.notePointerIsTouch(true);
    recorder.recordCursorSample(150, 60, 1, FRAME, 100);
    // A tap reaches the game as a mousedown, which reports the click without its device.
    recorder.recordCursorClick(150, 60, 'yellow', 1, FRAME, 120);
    recorder.notePointerIsTouch(false);
    recorder.recordCursorSample(190, 60, 1, FRAME, 200);

    const { samples, clicks } = recorder.getCursorTrack();
    expect(samples.map((sample) => sample.touch === true)).toEqual([false, true, true, false]);
    expect(clicks.map((click) => click.touch === true)).toEqual([true]);
  });

  it('keeps a switch from finger to mouse at the same point through recording and compaction', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.notePointerIsTouch(true);
    recorder.recordCursorSample(150, 60, 1, FRAME, 0);
    recorder.notePointerIsTouch(false);
    recorder.recordCursorSample(150, 60, 1, FRAME, 100);
    recorder.recordCursorSample(150, 60, 1, FRAME, 200);

    const recorded = recorder.getCursorTrack();
    for (const samples of [recorded.samples, compactReplayCursorSamples(recorded)]) {
      expect(samples.map((sample) => [sample.tMs, sample.touch === true])).toEqual([
        [0, true],
        [100, false],
        [200, false],
      ]);
      expect(interpolateCursor({ samples, clicks: [] }, 150)).toEqual({ x: 50, y: 10 });
    }
  });

  it.each([
    ['a press, pinned, survives', true],
    ['an ordinary sample there is compacted away', false],
  ])('where a finger comes down: %s the next sample in its 60Hz bucket', (_name, asPress) => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.notePointerIsTouch(true);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);
    if (asPress) recorder.recordCursorPress(150, 60, 1, FRAME, 10);
    else recorder.recordCursorSample(150, 60, 1, FRAME, 10);
    recorder.recordCursorSample(152, 60, 1, FRAME, 12);
    recorder.recordCursorSample(170, 60, 1, FRAME, 40);

    const press = { tMs: 10, x: 50, y: 10, insideFrame: true, pinned: true, touch: true };
    const { samples } = recorder.getCursorTrack();
    if (asPress) {
      expect(samples).toContainEqual(press);
      // Compacting the whole track in one pass keeps it too.
      expect(compactReplayCursorSamples(recorder.getCursorTrack())).toContainEqual(press);
    } else {
      expect(samples.map((sample) => sample.tMs)).not.toContain(10);
    }
  });

  it('retains the exact cursor limit and stops at the first omitted sample without rewriting history', () => {
    const recorder = new ReplayRecorder({ cursorSamples: 2 });
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);
    recorder.recordCursorSample(120, 60, 1, FRAME, 20);
    const before = structuredClone(recorder.getCursorTrack().samples);

    recorder.recordCursorSample(130, 60, 1, FRAME, 40);
    recorder.recordCursorSample(140, 60, 1, FRAME, 60);

    expect(recorder.getCursorTrack().samples).toEqual(before);
    expect(recorder.getCapture().cursorSamples).toEqual({
      provenance: 'bounded-v1',
      stoppedAtMs: 40,
      reason: 'entry-limit',
    });
  });

  it('allows stationary tail replacement and duplicate suppression at the cursor limit', () => {
    const recorder = new ReplayRecorder({ cursorSamples: 2 });
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);
    recorder.recordCursorSample(110, 60, 1, FRAME, 1);

    recorder.recordCursorSample(110, 60, 1, FRAME, 2);
    recorder.recordCursorSample(110, 60, 1, FRAME, 2);

    expect(recorder.getCursorTrack().samples.map(({ tMs }) => tMs)).toEqual([0, 2]);
    expect(recorder.getCapture().cursorSamples.stoppedAtMs).toBeNull();
  });

  it('preserves the exact prefix when rapid distinct samples exhaust the byte budget', () => {
    const samples = [
      { tMs: 0, x: 10, y: 10, insideFrame: true },
      { tMs: 1, x: 10.5, y: 10, insideFrame: true },
    ];
    const byteLimit =
      new ReplayRecorder().getStats().ancillaryBytes + new TextEncoder().encode(JSON.stringify(samples)).byteLength - 2;
    const recorder = new ReplayRecorder({ ancillaryBytes: byteLimit });
    recorder.startRun(RUN_CONFIG);
    for (const { tMs, x, y } of samples) recorder.recordCursorSample(x, y, 1, CURSOR_FRAME, tMs);

    recorder.recordCursorSample(10.25, 10, 1, CURSOR_FRAME, 2);
    recorder.recordCursorSample(10.75, 10, 1, CURSOR_FRAME, 3);

    expect(recorder.getCursorTrack().samples).toEqual(samples);
    expect(recorder.getStats().ancillaryBytes).toBe(byteLimit);
    expect(recorder.getCapture().cursorSamples).toEqual({
      provenance: 'bounded-v1',
      stoppedAtMs: 2,
      reason: 'byte-limit',
    });
  });

  it('allows same-time state replacements and modifier reversals at capacity', () => {
    const recorder = new ReplayRecorder({ viewportSamples: 1, presentationSamples: 1, modifierSamples: 1 });
    recorder.startRun(RUN_CONFIG);
    recorder.recordViewportSample(1, 0, VIEWPORT_STATE);
    recorder.recordPresentationState(1, 0, presentation);
    recorder.recordModifierSample(1, 0, 0);

    recorder.recordViewportSample(1, 0, { ...VIEWPORT_STATE, yawDeg: 90 });
    recorder.recordPresentationState(1, 0, { ...presentation, uiScale: 2 });
    recorder.recordModifierSample(1, 0, 1);
    recorder.recordModifierSample(1, 0, 0);
    recorder.recordViewportSample(1, 10, { ...VIEWPORT_STATE, yawDeg: 90 });
    recorder.recordPresentationState(1, 10, { ...presentation, uiScale: 2 });

    expect(recorder.getViewportTrack().samples).toHaveLength(1);
    expect(recorder.getPresentationTrack()).toHaveLength(1);
    expect(recorder.getModifierTrack()).toHaveLength(0);
    expect(recorder.getCapture().viewportSamples.stoppedAtMs).toBeNull();
    expect(recorder.getCapture().presentationSamples.stoppedAtMs).toBeNull();
    expect(recorder.getCapture().modifierSamples.stoppedAtMs).toBeNull();
  });

  it.each([
    { cursorSamples: 1, cursorClicks: 3 },
    { cursorSamples: 3, cursorClicks: 1 },
  ])('records pins and clicks independently with limits %j', (limits) => {
    const recorder = new ReplayRecorder(limits);
    recorder.startRun(RUN_CONFIG);

    for (const time of [0, 20, 40, 60]) recorder.recordCursorClick(110, 60, 'ui', 1, FRAME, time);

    expect(recorder.getCursorTrack().samples).toHaveLength(limits.cursorSamples);
    expect(recorder.getCursorTrack().samples.every((sample) => sample.pinned)).toBe(true);
    expect(recorder.getCursorTrack().clicks).toHaveLength(limits.cursorClicks);
    expect(recorder.getCursorTrack().clicks[0]?.tMs).toBe(0);
  });

  it('performs no clones or serialization on stopped track calls', () => {
    const recorder = new ReplayRecorder({
      cursorSamples: 0,
      cursorClicks: 0,
      menuEvents: 0,
      viewportSamples: 0,
      presentationSamples: 0,
      modifierSamples: 0,
    });
    recorder.startRun(RUN_CONFIG);
    for (const { write } of tracks) write(recorder, 0);
    const clone = vi.spyOn(globalThis, 'structuredClone');
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      for (const { write } of tracks) write(recorder, 1);
      expect(clone).not.toHaveBeenCalled();
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      clone.mockRestore();
      stringify.mockRestore();
    }
  });

  it('publishes capture transitions only with stable snapshots and unsubscribe support', () => {
    const recorder = new ReplayRecorder({ modifierSamples: 1 });
    const changed = vi.fn();
    const unsubscribe = recorder.subscribeCapture(changed);
    const initial = recorder.getCapture();
    recorder.recordModifierSample(1, 0, 0);
    expect(recorder.getCapture()).toBe(initial);

    recorder.recordModifierSample(1, 10, 1);
    recorder.recordModifierSample(1, 20, 2);
    const stopped = recorder.getCapture();
    unsubscribe();
    recorder.clear();

    expect(changed).toHaveBeenCalledTimes(1);
    expect(stopped).not.toBe(initial);
    expect(stopped.modifierSamples.stoppedAtMs).toBe(10);
    expect(initial.modifierSamples.stoppedAtMs).toBeNull();
  });

  it.each(['startRun', 'clear'] as const)('resets counts and cutoffs on %s', (operation) => {
    const recorder = new ReplayRecorder({ modifierSamples: 1 });
    recorder.recordModifierSample(1, 0, 0);
    recorder.recordModifierSample(1, 10, 1);

    if (operation === 'startRun') recorder.startRun(RUN_CONFIG);
    else recorder.clear();
    recorder.recordModifierSample(1, 0, 2);

    expect(recorder.getCapture().modifierSamples.stoppedAtMs).toBeNull();
    expect(recorder.getStats().counts.modifierSamples).toBe(1);
    expect(recorder.getModifierTrack()[0]?.mask).toBe(2);
  });

  it.each([
    { cutoff: 601, reopened: true },
    { cutoff: 600, reopened: false },
    { cutoff: 599, reopened: false },
  ])('reopens only a fork strictly before cutoff $cutoff', ({ cutoff, reopened }) => {
    const recorder = new ReplayRecorder({ modifierSamples: 1 });
    recorder.startRun(RUN_CONFIG);
    seedFrame(recorder, 0, 0);
    recorder.recordModifierSample(1, 0, 0);
    if (cutoff >= 600) seedFrame(recorder, 1, 600);
    recorder.recordModifierSample(1, cutoff, 1);
    if (cutoff < 600) seedFrame(recorder, 1, 600);
    const loaded = new ReplayRecorder({ modifierSamples: 1 });
    loaded.load(recorder.exportData());
    expect(loaded.getCapture()).toEqual(recorder.getCapture());
    expect(loaded.getStats().ancillaryBytes).toBe(recorder.getStats().ancillaryBytes);

    loaded.forkAt(1, 1000);

    expect(loaded.getCapture().modifierSamples.stoppedAtMs).toBe(reopened ? null : cutoff);
    expect(loaded.getStats().counts.modifierSamples).toBe(1);
  });

  it('recomputes ancillary usage when a loaded recording forks, keeping its provenance', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    seedFrame(recorder, 0, 0);
    recorder.recordModifierSample(1, 0, 0);
    seedFrame(recorder, 1, 600);
    recorder.recordModifierSample(1, 600, 1);
    const loaded = new ReplayRecorder();
    loaded.load(recorder.exportData());
    const before = loaded.getStats().ancillaryBytes;

    loaded.forkAt(0, 1000);

    expect(loaded.getStats().ancillaryBytes).toBeLessThan(before);
    expect(loaded.getCapture()).toEqual(recorder.getCapture());
    expect(loaded.getCapture().modifierSamples.provenance).toBe('bounded-v1');
    expect(loaded.getCapture().overlays.provenance).toBe('not-recorded');
  });

  it('omits an oversized run-start overlay with explicit coverage instead of cloning it', () => {
    const overlays: ReplayOverlays = {
      tileMarkers: [],
      lineMarkers: [],
      showTileMarkers: true,
      showTileMarkerLabels: true,
      showLineMarkers: true,
      showLineMarkerLabels: true,
      lineMarkerWidth: 1,
    };
    const baseline = new ReplayRecorder().getStats().ancillaryBytes;
    const recorder = new ReplayRecorder({ ancillaryBytes: baseline });

    recorder.startRun(RUN_CONFIG, overlays);

    expect(recorder.getOverlays()).toBeNull();
    expect(recorder.exportData()).not.toHaveProperty('overlays');
    expect(recorder.getCapture().overlays).toEqual({ provenance: 'bounded-v1', stoppedAtMs: 0, reason: 'byte-limit' });
    expect(recorder.getStats().ancillaryBytes).toBe(baseline);
  });

  it('accounts an accepted overlay snapshot before admitting other tracks', () => {
    const overlays: ReplayOverlays = {
      tileMarkers: [],
      lineMarkers: [],
      showTileMarkers: true,
      showTileMarkerLabels: true,
      showLineMarkers: true,
      showLineMarkerLabels: true,
      lineMarkerWidth: 1,
    };
    const limit =
      new ReplayRecorder().getStats().ancillaryBytes +
      new TextEncoder().encode(JSON.stringify(overlays)).byteLength -
      4;
    const recorder = new ReplayRecorder({ ancillaryBytes: limit });
    recorder.startRun(RUN_CONFIG, overlays);

    recorder.recordModifierSample(1, 0, 0);

    expect(recorder.getOverlays()).toEqual(overlays);
    expect(recorder.getOverlays()).not.toBe(overlays);
    expect(recorder.getCapture().overlays).toEqual({ provenance: 'bounded-v1', stoppedAtMs: null, reason: null });
    expect(recorder.getCapture().modifierSamples.reason).toBe('byte-limit');
    expect(recorder.getStats().ancillaryBytes).toBe(limit);
  });
});

describe('ReplayRecorder menu track', () => {
  const menu: ReplayMenuState = {
    entries: [{ action: 'Cancel' }],
    x: 40,
    y: 50,
    scale: 1.25,
    hoveredIndex: -1,
    submenuParentIndex: -1,
    hoveredSubmenuIndex: -1,
    submenuPosition: null,
  };

  it('records a baseline, sanitized open, scalar hover update and close without copying callbacks', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    const entries = [
      {
        action: 'Take',
        target: 'Shark',
        targetColor: '#fff',
        disabled: false,
        clickType: 'yellow' as const,
        onClick: vi.fn(),
        submenu: [{ action: 'Examine', onClick: vi.fn(), submenu: [{ action: 'Never recorded' }] }],
      },
    ];
    const opened = { ...menu, entries };

    recorder.recordMenuState(1, 1000, null);
    recorder.recordMenuState(1, 1010, opened);
    recorder.recordMenuState(1, 1020, { ...opened, hoveredIndex: 0 });
    recorder.recordMenuState(1, 1030, { ...opened, hoveredIndex: 0 });
    recorder.recordMenuState(1, 1040, null);
    recorder.recordMenuState(1, 1050, null);

    const events = recorder.getMenuTrack();
    expect(events.map((event) => [event.kind, event.tMs])).toEqual([
      ['close', 0],
      ['open', 10],
      ['update', 20],
      ['close', 40],
    ]);
    expect(events[1]).toMatchObject({
      state: {
        entries: [
          {
            action: 'Take',
            target: 'Shark',
            targetColor: '#fff',
            disabled: false,
            clickType: 'yellow',
            submenu: [{ action: 'Examine' }],
          },
        ],
      },
    });
    expect(events[1]?.kind === 'open' && events[1].state.entries).not.toBe(entries);
    expect(events[2]).not.toHaveProperty('state');
    expect(events[2]).not.toHaveProperty('view.entries');
    expect(() => recorder.exportData()).not.toThrow();
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('onClick');
    expect(serialized).not.toContain('Never recorded');
  });

  it('opens again on content identity changes even when the geometry is unchanged', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);

    recorder.recordMenuState(1, 1000, menu);
    recorder.recordMenuState(1, 1000, { ...menu, entries: [{ action: 'Walk here' }] });

    expect(recorder.getMenuTrack().map((event) => event.kind)).toEqual(['open', 'open']);
    expect(replayMenuStateAt(buildReplayMenuTimeline(recorder.getMenuTrack()), 0)?.entries).toEqual([
      { action: 'Walk here' },
    ]);
  });

  it('restores the retained menu tail when forking and closing a loaded recording', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    recorder.recordMenuState(1, 1010, menu);
    seedFrame(recorder, 1, 1600);
    recorder.recordMenuState(1, 1600, { ...menu, hoveredIndex: 0 });
    recorder.recordMenuState(1, 1700, null);
    const loaded = new ReplayRecorder();
    loaded.load(recorder.exportData());

    loaded.forkAt(1, 2000);
    loaded.recordMenuState(1, 2050, null);

    expect(loaded.getMenuTrack().map((event) => [event.kind, event.tMs])).toEqual([
      ['open', 10],
      ['update', 600],
      ['close', 650],
    ]);
    expect(recorder.getMenuTrack().at(-1)?.tMs).toBe(700);
  });

  it.each(['clear', 'startRun', 'loadWithoutMenus'] as const)('resets menu capture state on %s', (operation) => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    recorder.recordMenuState(1, 1000, menu);
    const { menuEvents: _events, ...withoutMenus } = recorder.exportData();

    switch (operation) {
      case 'clear':
        recorder.clear();
        break;
      case 'startRun':
        recorder.startRun(RUN_CONFIG);
        break;
      case 'loadWithoutMenus':
        recorder.load(withoutMenus);
        break;
    }
    recorder.recordMenuState(1, 0, menu);

    expect(recorder.getMenuTrack()).toEqual([{ kind: 'open', tMs: 0, state: menu }]);
  });
});

describe('ReplayRecorder frame-local cursor track', () => {
  const frame = { left: 258, top: 109, width: 765, height: 503 };
  const workspace: WorkspacePresentationGeometry = { width: 765, height: 503 };
  const insets = { left: 20, right: 20 };

  it.each([
    { name: 'game frame', clientX: 300, clientY: 209, x: 42, y: 100, insideFrame: true },
    { name: 'left sidebar', clientX: 268, clientY: 209, x: 10, y: 100, insideFrame: false },
    { name: 'right sidebar', clientX: 1008, clientY: 209, x: 750, y: 100, insideFrame: false },
    { name: 'left of the frame', clientX: 250, clientY: 209, x: -8, y: 100, insideFrame: false },
    { name: 'above the frame', clientX: 300, clientY: 100, x: 42, y: -9, insideFrame: false },
  ])('records sample and click eligibility for $name', ({ clientX, clientY, x, y, insideFrame }) => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);

    recorder.recordCursorSample(clientX, clientY, 1, frame, 10, VIEWPORT_STATE, insets);
    recorder.recordCursorClick(clientX, clientY, 'ui', 1, frame, 20, VIEWPORT_STATE, insets);

    expect(recorder.getCursorTrack().samples).toEqual([
      { tMs: 10, x, y, insideFrame, viewportState: VIEWPORT_STATE },
      { tMs: 20, x, y, insideFrame, viewportState: VIEWPORT_STATE, pinned: true },
    ]);
    expect(recorder.getCursorTrack().clicks).toEqual([
      { tMs: 20, x, y, insideFrame, viewportState: VIEWPORT_STATE, type: 'ui' },
    ]);
    expect(interpolateCursor(recorder.getCursorTrack(), 20)).toEqual(insideFrame ? { x, y } : null);
  });

  it('clones workspace metadata and samples only changed geometry', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    const state = {
      ...ReplayPresentationStateSchema.parse(validPresentationSample().state),
      frame: { width: 765, height: 503 },
      workspace,
    };
    const changed = { ...state, frame: { width: 765, height: 400 }, workspace: { width: 765, height: 400 } };

    recorder.recordPresentationState(1, 0, state);
    recorder.recordPresentationState(1, 10, structuredClone(state));
    recorder.recordPresentationState(1, 20, changed);

    expect(recorder.getPresentationTrack()).toEqual([
      { tMs: 0, state },
      { tMs: 20, state: changed },
    ]);
    expect(recorder.getPresentationTrack()[0]?.state.workspace).not.toBe(workspace);
    const loaded = new ReplayRecorder();
    loaded.load(recorder.exportData());
    expect(loaded.getPresentationTrack()).toEqual(recorder.getPresentationTrack());
    expect(loaded.getPresentationTrack()[0]?.state.workspace).not.toBe(
      recorder.getPresentationTrack()[0]?.state.workspace,
    );
  });
});

describe('ReplayRecorder logical-frame cursor track', () => {
  it.each([1000, 8000])('bounds quantized %i Hz recording and agrees with after-the-fact compaction', (rate) => {
    const recorder = new ReplayRecorder({ cursorSamples: 63 });
    const frame = { left: 0, top: 0, width: 1000, height: 1000 };
    const state = makeState(0);
    recorder.startRun(RUN_CONFIG);
    const incoming = Array.from({ length: rate + 1 }, (_, index) => {
      const tMs = (index * 1000) / rate;
      if (tMs % 600 === 0) recorder.recordFrame(tMs / 600, START, state, [], tMs);
      const x = Math.floor(tMs / 2);
      recorder.recordCursorSample(x, 10, 1, frame, tMs);
      return { tMs: Math.floor(tMs / 600) * 600 + Math.min(tMs % 600, 599), x, y: 10, insideFrame: true };
    });
    const recorded = recorder.getCursorTrack().samples;
    expect(recorded.length).toBeLessThanOrEqual(63);
    expect(recorded).toEqual(compactReplayCursorSamples({ samples: incoming, clicks: [] }));
    expect(recorded[0]).toEqual(incoming[0]);
    expect(recorded.at(-1)).toEqual(incoming.at(-1));
    expect(recorder.getStats().counts.cursorSamples).toBe(recorded.length);
    expect(recorder.getStats().ancillaryBytes).toBe(
      new ReplayRecorder().getStats().ancillaryBytes +
        new TextEncoder().encode(JSON.stringify(recorded)).byteLength -
        2,
    );
    expect(recorder.getCapture().cursorSamples.stoppedAtMs).toBeNull();
  });

  it.each([1000, 8000])('retains real pauses amid quantized %i Hz motion in both sampling paths', (rate) => {
    const recorder = new ReplayRecorder();
    const frame = { left: 0, top: 0, width: 1000, height: 1000 };
    const state = makeState(0);
    recorder.startRun(RUN_CONFIG);
    const incoming = Array.from({ length: (rate * 1800) / 1000 + 1 }, (_, index) => {
      const tMs = (index * 1000) / rate;
      if (tMs % 600 === 0) recorder.recordFrame(tMs / 600, START, state, [], tMs);
      const x =
        tMs < 200
          ? Math.floor(tMs / 2)
          : tMs <= 300
            ? 100
            : tMs < 500
              ? 100 + Math.ceil((tMs - 300) / 2)
              : tMs <= 1500
                ? 201
                : 201 + Math.ceil((tMs - 1500) / 2);
      recorder.recordCursorSample(x, 10, 1, frame, tMs);
      return { tMs, x, y: 10, insideFrame: true };
    });
    const recorded = recorder.getCursorTrack().samples;
    expect(recorded.length).toBeLessThanOrEqual(55);
    expect(recorded).toEqual(compactReplayCursorSamples({ samples: incoming, clicks: [] }));
    for (const tMs of [200, 300, 300 + 1000 / rate, 500, 1500, 1500 + 1000 / rate]) {
      expect(recorded).toContainEqual(incoming.find((sample) => sample.tMs === tMs));
    }
    expect(recorded.at(-1)).toEqual(incoming.at(-1));
  });

  it.each([1000, 8000])('samples %i Hz movement at 60 Hz while keeping rapid clicks exact', (rate) => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    for (let index = 0; index <= rate / 2; index++) {
      const time = (index * 1000) / rate;
      recorder.recordCursorSample(110 + time / 10, 60, 1, FRAME, time);
    }
    for (let index = 0; index < 10; index++) recorder.recordCursorClick(120 + index, 60, 'ui', 1, FRAME, 501);
    const track = recorder.getCursorTrack();
    expect(track.samples.length).toBeLessThanOrEqual(42);
    expect(track.samples[0]?.tMs).toBe(0);
    expect(track.samples.at(-11)?.tMs).toBe(500);
    expect(track.clicks.map(({ x, tMs }) => ({ x, tMs }))).toEqual(
      Array.from({ length: 10 }, (_, index) => ({ x: 20 + index, tMs: 501 })),
    );
    expect(interpolateCursor(track, 250)?.x).toBeCloseTo(35);
  });
  it('retains first and final positions when sub-frame movement reverses direction', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    const delivered = [
      { tMs: 0, x: 10, y: 10 },
      { tMs: 1, x: 10.5, y: 10.25 },
      { tMs: 2, x: 10.25, y: 10.5 },
      { tMs: 3, x: 10.75, y: 10 },
      { tMs: 4, x: 10, y: 10.25 },
    ];

    for (const { tMs, x, y } of delivered) {
      recorder.recordCursorSample(x, y, 1, CURSOR_FRAME, 1000 + tMs);
    }

    const endpoints = [delivered[0], delivered.at(-1)].filter((sample) => sample !== undefined);
    expect(recorder.getCursorTrack().samples).toEqual(endpoints.map((sample) => ({ ...sample, insideFrame: true })));
    for (const { tMs, x, y } of endpoints) {
      expect(interpolateCursor(recorder.getCursorTrack(), tMs)).toEqual({ x, y });
    }
  });

  it('stores samples as pixels in the frame, not fractions of it', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);

    recorder.recordCursorSample(300, 150, 1, FRAME, 10, VIEWPORT_STATE);

    expect(recorder.getCursorTrack()).toMatchObject({
      samples: [{ tMs: 10, x: 200, y: 100, insideFrame: true, viewportState: VIEWPORT_STATE }],
      clicks: [],
    });
  });

  it('marks samples outside the frame so playback can hide the cursor there', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);

    recorder.recordCursorSample(20, 60, 1, FRAME, 0);
    recorder.recordCursorSample(300, 150, 1, FRAME, 20);

    expect(recorder.getCursorTrack().samples).toEqual([
      { tMs: 0, x: -80, y: 10, insideFrame: false },
      { tMs: 20, x: 200, y: 100, insideFrame: true },
    ]);
  });

  it('retains frame-local changes when the frame moves during tiny client movement', () => {
    const recorder = new ReplayRecorder();
    const shiftedFrame: GameFrameRect = { left: 100, top: 0, width: 100, height: 100 };
    recorder.startRun(RUN_CONFIG);

    recorder.recordCursorSample(10, 10, 1, { left: 0, top: 0, width: 100, height: 100 }, 0);
    recorder.recordCursorSample(11, 10, 1, shiftedFrame, 10);
    recorder.recordCursorSample(12, 10, 1, shiftedFrame, 10);

    expect(recorder.getCursorTrack().samples).toEqual([
      { tMs: 0, x: 10, y: 10, insideFrame: true },
      { tMs: 10, x: -89, y: 10, insideFrame: false, breakBefore: true },
      { tMs: 10, x: -88, y: 10, insideFrame: false },
    ]);
  });

  it('resets transient raw coalescing state when a new run starts', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(10, 10, 1, FRAME, 0);

    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(11, 10, 1, FRAME, 10);

    expect(recorder.getCursorTrack().samples).toEqual([{ tMs: 10, x: -89, y: -40, insideFrame: false }]);
  });

  it('retains the last movement when several movements share an event timestamp', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);

    recorder.recordCursorSample(10, 10, 1, FRAME, 0);
    recorder.recordCursorSample(10.5, 10, 1, FRAME, 10);
    recorder.recordCursorSample(12, 10, 1, FRAME, 10);
    recorder.recordCursorSample(12, 10, 1, FRAME, 26);

    expect(recorder.getCursorTrack().samples).toEqual([
      { tMs: 0, x: -90, y: -40, insideFrame: false },
      { tMs: 10, x: -88, y: -40, insideFrame: false },
      { tMs: 26, x: -88, y: -40, insideFrame: false },
    ]);
  });

  it.each([
    { movementPerMs: 0, maximumSamples: 2 },
    { movementPerMs: 0.01, maximumSamples: 2000 },
  ])('bounds storage when 30k observations move $movementPerMs pixels per millisecond', ({
    movementPerMs,
    maximumSamples,
  }) => {
    const recorder = new ReplayRecorder({ cursorSamples: maximumSamples });
    const state = makeState(0);

    for (let index = 0; index < 30_000; index++) {
      if (index % 600 === 0) recorder.recordFrame(index / 600, START, state, [], index);
      recorder.recordCursorSample(100 + index * movementPerMs, 60, 1, FRAME, index);
    }

    const { samples } = recorder.getCursorTrack();
    expect(samples.length).toBeLessThanOrEqual(maximumSamples);
    expect(samples[0]).toEqual({ tMs: 0, x: 0, y: 10, insideFrame: true });
    const lastAcceptedTime = 29_999;
    expect(samples.at(-1)).toEqual({
      tMs: lastAcceptedTime,
      x: 100 + lastAcceptedTime * movementPerMs - FRAME.left,
      y: 10,
      insideFrame: true,
    });
    expect(recorder.getCapture().cursorSamples.stoppedAtMs).toBeNull();
  });

  it('retains first and latest bucket endpoints when small movements span a sampling interval', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);

    for (const time of [0, 1, 2, 15, 16, 17, 18]) {
      recorder.recordCursorSample(110 + time / 100, 60, 1, FRAME, time);
    }

    expect(recorder.getCursorTrack().samples.map(({ tMs }) => tMs)).toEqual([0, 16, 18]);
  });

  it('preserves a pending endpoint and pinned click when movement continues after a click', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);
    recorder.recordCursorSample(110.1, 60, 1, FRAME, 1);

    recorder.recordCursorClick(110.2, 60, 'ui', 1, FRAME, 2);
    for (const time of [3, 4]) recorder.recordCursorSample(110 + time / 10, 60, 1, FRAME, time);

    expect(recorder.getCursorTrack().samples.map(({ tMs, pinned }) => ({ tMs, pinned }))).toEqual([
      { tMs: 0, pinned: undefined },
      { tMs: 1, pinned: undefined },
      { tMs: 2, pinned: true },
      { tMs: 4, pinned: undefined },
    ]);
  });

  it.each([
    { name: 'frame size', frameRect: { ...FRAME, width: 500 }, insets: undefined },
    { name: 'visibility', frameRect: FRAME, insets: { left: 20, right: 0 } },
  ])('preserves both sides of a $name transition when a moving endpoint is pending', ({ frameRect, insets }) => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);
    recorder.recordCursorSample(110.1, 60, 1, FRAME, 1);

    for (const time of [2, 3, 4]) {
      recorder.recordCursorSample(110 + time / 10, 60, 1, frameRect, time, undefined, insets);
    }

    expect(recorder.getCursorTrack().samples.map(({ tMs }) => tMs)).toEqual([0, 1, 2, 4]);
  });

  it('commits the arrival timestamp when pending motion becomes a stationary hold', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);
    recorder.recordCursorSample(110.1, 60, 1, FRAME, 1);

    for (const time of [2, 20, 40]) recorder.recordCursorSample(110.1, 60, 1, FRAME, time);
    recorder.recordCursorSample(110.2, 60, 1, FRAME, 41);

    expect(recorder.getCursorTrack().samples.map(({ tMs }) => tMs)).toEqual([0, 1, 40, 41]);
  });

  it('leaves loaded endpoints untouched when capture starts a new pending tail', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);
    recorder.recordCursorSample(110.1, 60, 1, FRAME, 1);
    const loaded = new ReplayRecorder();
    loaded.load(recorder.exportData());

    for (const time of [2, 3, 4]) loaded.recordCursorSample(110 + time / 10, 60, 1, FRAME, time);

    expect(loaded.getCursorTrack().samples.map(({ tMs }) => tMs)).toEqual([0, 1, 2, 4]);
  });

  it('retains the final tiny movement immediately when no later input flushes it', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);

    recorder.recordCursorSample(110.5, 60, 1, FRAME, 5);

    expect(recorder.getCursorTrack().samples.at(-1)).toEqual({ tMs: 5, x: 10.5, y: 10, insideFrame: true });
    expect(interpolateCursor(recorder.getCursorTrack(), 5)).toEqual({ x: 10.5, y: 10 });
  });

  it('retains visibility transitions when a tiny movement crosses the frame edge', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(100, 60, 1, FRAME, 0);

    recorder.recordCursorSample(99.5, 60, 1, FRAME, 1);
    recorder.recordCursorSample(100, 60, 1, FRAME, 2);

    expect(recorder.getCursorTrack().samples.map(({ tMs, insideFrame }) => ({ tMs, insideFrame }))).toEqual([
      { tMs: 0, insideFrame: true },
      { tMs: 1, insideFrame: false },
      { tMs: 2, insideFrame: true },
    ]);
  });

  it('retains a visibility transition when sidebar insets change under a stationary cursor', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);

    recorder.recordCursorSample(110, 60, 1, FRAME, 1, undefined, { left: 20, right: 0 });

    expect(interpolateCursor(recorder.getCursorTrack(), 1)).toBeNull();
  });

  it('retains idle endpoints and the first resumed movement when repeated observations are coalesced', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);

    for (const time of [0, 20, 40, 60]) recorder.recordCursorSample(110, 60, 1, FRAME, time);
    recorder.recordCursorSample(110.5, 60, 1, FRAME, 61);

    expect(recorder.getCursorTrack().samples).toEqual([
      { tMs: 0, x: 10, y: 10, insideFrame: true },
      { tMs: 60, x: 10, y: 10, insideFrame: true },
      { tMs: 61, x: 10.5, y: 10, insideFrame: true },
    ]);
  });

  it('preserves the coordinate-space boundary when identical local points are observed after a resize', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);
    recorder.recordCursorSample(110, 60, 1, FRAME, 20);
    const resizedFrame = { ...FRAME, width: 500 };

    recorder.recordCursorSample(110, 60, 1, resizedFrame, 21);
    recorder.recordCursorSample(110, 60, 1, resizedFrame, 22);
    recorder.recordCursorSample(110, 60, 1, resizedFrame, 23);

    expect(recorder.getCursorTrack().samples.map(({ tMs }) => tMs)).toEqual([0, 20, 21, 23]);
  });

  it('preserves pinned click timestamps when identical cursor observations extend the tail', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorSample(110, 60, 1, FRAME, 0);
    recorder.recordCursorSample(110, 60, 1, FRAME, 20);
    recorder.recordCursorClick(110, 60, 'ui', 1, FRAME, 21);

    for (const time of [22, 23, 24]) recorder.recordCursorSample(110, 60, 1, FRAME, time);

    expect(recorder.getCursorTrack().samples).toEqual([
      { tMs: 0, x: 10, y: 10, insideFrame: true },
      { tMs: 20, x: 10, y: 10, insideFrame: true },
      { tMs: 21, x: 10, y: 10, insideFrame: true, pinned: true },
      { tMs: 24, x: 10, y: 10, insideFrame: true },
    ]);
  });

  it('does not mutate track contents or identity when exporting a coalesced tail', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    for (const time of [0, 1, 2]) recorder.recordCursorSample(110, 60, 1, FRAME, time);
    const track = recorder.getCursorTrack();
    const before = [...track.samples];

    const exported = recorder.exportData();

    expect(exported.cursorSamples).toEqual(before);
    expect(recorder.getCursorTrack()).toBe(track);
    expect(track.samples).toEqual(before);
  });

  it.each([
    { name: 'startRun', reset: (recorder: ReplayRecorder) => recorder.startRun(RUN_CONFIG) },
    { name: 'clear', reset: (recorder: ReplayRecorder) => recorder.clear() },
    { name: 'load', reset: (recorder: ReplayRecorder) => recorder.load(new ReplayRecorder().exportData()) },
  ])('resets the duplicate tail when $name replaces the recording', ({ reset }) => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    for (const time of [0, 20, 40]) recorder.recordCursorSample(110, 60, 1, FRAME, time);

    reset(recorder);
    for (const time of [0, 1, 2]) recorder.recordCursorSample(110, 60, 1, FRAME, time);

    expect(recorder.getCursorTrack().samples.map(({ tMs }) => tMs)).toEqual([0, 2]);
  });

  it('leaves the retained prefix untouched when a fork resumes at an identical cursor position', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    seedFrame(recorder, 1, 1600);
    for (const time of [1600, 1601, 1602]) recorder.recordCursorSample(110, 60, 1, FRAME, time);

    recorder.forkAt(1, 5000);
    for (const time of [5001, 5002, 5003]) recorder.recordCursorSample(110, 60, 1, FRAME, time);

    expect(recorder.getCursorTrack().samples.map(({ tMs }) => tMs)).toEqual([600, 601, 603]);
  });

  it('caps samples and clicks without evicting early entries', () => {
    const recorder = new ReplayRecorder({ cursorSamples: 30, cursorClicks: 5 });
    recorder.startRun(RUN_CONFIG);

    for (let index = 0; index < 100; index += 1) {
      if (index % 10 === 0) seedFrame(recorder, index / 10, index * 34);
      recorder.recordCursorSample(index * 3, 0, 1, FRAME, index * 34);
    }
    for (let index = 0; index < 10; index += 1) {
      recorder.recordCursorClick(index, 0, 'yellow', 1, FRAME, index);
    }

    expect(recorder.getCursorTrack().samples).toHaveLength(30);
    expect(recorder.getCursorTrack().clicks).toHaveLength(5);
  });

  it('keeps the sample a click was taken from when capture stops', () => {
    const recorder = new ReplayRecorder({ cursorSamples: 30 });
    recorder.startRun(RUN_CONFIG);
    recorder.recordCursorClick(220, 90, 'yellow', 1, FRAME, 0);

    for (let index = 0; index < 100; index += 1) {
      recorder.recordCursorSample(index * 3, 0, 1, FRAME, index * 34);
    }

    const track = recorder.getCursorTrack();
    expect(track.samples).toContainEqual({ tMs: 0, x: 120, y: 40, insideFrame: true, pinned: true });
    expect(track.clicks[0]).toEqual({ tMs: 0, x: 120, y: 40, insideFrame: true, type: 'yellow' });
  });
});

const START: Coordinate = [31, 37];
const CURSOR_FRAME: GameFrameRect = { left: 0, top: 0, width: 100, height: 100 };
const TEST_VIEWPORT_STATE: ReplayViewportState = {
  kind: 'orbit3d',
  pitchDeg: -45,
  yawDeg: 180,
  fovScale: 512,
  target: { x: 31.5, y: 37.5, z: 0.9 },
};

function makeRunConfig(): EngineRunConfig {
  return { completionOwnership: 'encounter-owned', encounter: { kind: 'yama_p3', seeds: {} } };
}

function makeState(tick: number): SimulationState {
  return {
    currentTick: tick,
    groundItems: [],
    playerPosition: START,
    playerPreviousPosition: START,
    playerMovementPath: [],
    playerFacingAngle: 0,
    playerIsMoving: false,
    playerIsRunning: false,
    primaryNpcPosition: [29, 28],
    primaryNpcPreviousPosition: [29, 28],
    primaryNpcFacingAngle: 0,
    primaryNpcSize: 5,
    npcs: [],
    encounter: yamaSnapshot(),
    encounterOutcome: { phase: 'active' },
    isAlive: true,
    markOfDarknessActive: false,
    markOfDarknessTicksRemaining: 0,
    activePrayer: null,
    offensivePrayer: null,
    independentPrayers: [],
    failedCondition: null,
    playerHistory: new Map(),
    primaryNpcHistory: new Map(),
    playerHP: 99,
    maxHP: 99,
    poisonVarp: 0,
    poisonTickCounter: POISON_TICK_INTERVAL,
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
    pendingOffensivePrayer: [false, null],
    pendingIndependentPrayers: [false, []],
    quickPrayersActive: false,
    runEnergy: createDefaultRunEnergy(),
    equipmentStats: createEmptyEquipmentStats(),
    prayerState: createDefaultPrayerState(),
    playerEquipment: {},
    playerCombatSupplies: createEmptyCombatSupplies(),
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    mechanicsConfig: { infiniteHealth: false },
    attackTarget: null,
    lastAttackTarget: null,
    selectedAttackStyleIndex: 0,
    playerAttackCooldown: 0,
    playerNextAttackTick: -1,
    playerAttackSpeed: 4,
    introActive: false,
  };
}

function seedFrame(recorder: ReplayRecorder, tick: number, nowMs: number): void {
  recorder.recordFrame(tick, START, makeState(tick), [], nowMs);
}

describe('ReplayRecorder DPS projection', () => {
  it('keeps the captured calculation when live equipment and target health change', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: START });
    engine.setEquipment({ weapon: 31113 });
    const projection = engine.getAdjustedTheoreticalDps();
    expect(projection?.dps).toBeGreaterThan(0);
    const state = engine.getState();
    const recorder = new ReplayRecorder();
    recorder.startRun(engine.getRunConfig());
    recorder.recordFrame(state.currentTick, state.playerPosition, state, [], { dpsProjection: projection });

    engine.setEquipment({});
    engine.setBossHp(0);

    expect(engine.getAdjustedTheoreticalDps()).toBeNull();
    expect(recorder.getFrame(0)?.dpsProjection).toEqual(projection);
    expect(recorder.getFrame(0)?.dpsProjection).not.toBe(projection);
    expect(recorder.getFrame(0)?.dpsProjection?.hits).not.toBe(projection?.hits);
    const loaded = new ReplayRecorder();
    loaded.load(recorder.exportData());
    expect(loaded.getFrame(0)?.dpsProjection).toEqual(projection);
  });

  it('preserves an explicitly unavailable calculation through export and load', () => {
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, START, makeState(0), [], { dpsProjection: null });
    const loaded = new ReplayRecorder();

    loaded.load(recorder.exportData());

    expect(loaded.getFrame(0)?.dpsProjection).toBeNull();
  });

  it('leaves frames recorded without projection data unchanged after export and load', () => {
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, START, makeState(0), []);
    const loaded = new ReplayRecorder();

    loaded.load(recorder.exportData());

    expect(loaded.getFrame(0)).not.toHaveProperty('dpsProjection');
  });
});

describe('ReplayRecorder damage history storage', () => {
  it('does not traverse discarded per-frame damage histories while loading', () => {
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, START, makeState(0), []);
    const data = recorder.exportData();
    let reads = 0;
    const history: DamageHistoryEntry[] = [];
    Object.defineProperty(history, 0, {
      enumerable: true,
      get: () => {
        reads++;
        return undefined;
      },
    });
    const loaded = new ReplayRecorder();

    loaded.load({
      ...data,
      frames: data.frames.map((frame) => ({ ...frame, state: { ...frame.state, damageHistory: history } })),
    });

    expect(reads).toBe(0);
    expect(loaded.getFrame(0)?.state.damageHistory).toEqual([]);
    expect(history).toHaveLength(1);
  });

  it('retains recorder history when a scrub preview is published', () => {
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, [0, 0], makeState(0), []);
    const store = new ReplayFrameStore();
    const history = recorder.getDisplayFrames();
    store.setHistory(history);

    store.setPreview({ frameIndex: 0, state: makeState(0), events: [] });

    expect(store.getSnapshot().history).toBe(history);
    expect(store.getSnapshot().preview?.frameIndex).toBe(0);
  });

  it('exposes identity-stable display history when frames are appended', () => {
    const recorder = new ReplayRecorder();
    const history = recorder.getDisplayFrames();

    recorder.recordFrame(0, [0, 0], makeState(0), []);

    expect(recorder.getDisplayFrames()).toBe(history);
    expect(history[0]?.state.currentTick).toBe(0);
    expect(history[0]?.events).toEqual([]);
  });

  it('replaces display history identity when a recording is forked or loaded', () => {
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, [0, 0], makeState(0), []);
    recorder.recordFrame(1, [0, 0], makeState(1), []);
    const history = recorder.getDisplayFrames();

    recorder.forkAt(0);
    const fork = recorder.getDisplayFrames();
    recorder.load(recorder.exportData());

    expect(fork).not.toBe(history);
    expect(fork).toHaveLength(1);
    expect(history).toHaveLength(2);
    expect(recorder.getDisplayFrames()).not.toBe(fork);
  });

  it('reconstructs playback histories without repopulating exported frame snapshots', () => {
    const recorder = new ReplayRecorder();
    const damageHistory: DamageHistoryEntry[] = [];
    recorder.startRun(makeRunConfig());

    for (let tick = 0; tick < 3; tick += 1) {
      damageHistory.push({
        tick,
        source: 'yama_melee',
        targetId: 'player',
        baseDamage: tick + 1,
        attackType: 'melee',
        activePrayer: null,
        prayedCorrectly: null,
        effectiveDamage: tick + 1,
        hpBefore: 99 - tick,
        hpAfter: 98 - tick,
      });
      recorder.recordFrame(tick, START, { ...makeState(tick), damageHistory }, []);
    }

    const playbackFrames = Array.from({ length: recorder.getFrameCount() }, (_, index) => recorder.getFrame(index));
    const exported = recorder.exportData();

    expect(playbackFrames.map((frame) => frame?.state.damageHistory.map((entry) => entry.tick))).toEqual([
      [0],
      [0, 1],
      [0, 1, 2],
    ]);
    expect(exported.frames.map((frame) => frame.state.damageHistory)).toEqual([[], [], []]);
    expect(exported.damageHistory.map((entry) => entry.tick)).toEqual([0, 1, 2]);
  });

  it('discards per-frame histories on load while preserving shared-log playback', () => {
    const recorder = new ReplayRecorder();
    const damageHistory: DamageHistoryEntry[] = [];
    recorder.startRun(makeRunConfig());
    for (let tick = 0; tick < 2; tick += 1) {
      damageHistory.push({
        tick,
        source: 'yama_melee',
        targetId: 'player',
        baseDamage: tick + 1,
        attackType: 'melee',
        activePrayer: null,
        prayedCorrectly: null,
        effectiveDamage: tick + 1,
        hpBefore: 99 - tick,
        hpAfter: 98 - tick,
      });
      recorder.recordFrame(tick, START, { ...makeState(tick), damageHistory }, []);
    }
    const current = recorder.exportData();
    const withFrameHistories = {
      ...current,
      frames: current.frames.map((frame, index) => ({
        ...frame,
        state: { ...frame.state, damageHistory: current.damageHistory.slice(0, index + 1) },
      })),
    };
    const loaded = new ReplayRecorder();

    loaded.load(withFrameHistories);

    expect(loaded.exportData().frames.map((frame) => frame.state.damageHistory)).toEqual([[], []]);
    expect(loaded.getFrame(1)?.state.damageHistory.map((entry) => entry.tick)).toEqual([0, 1]);
  });
});

describe('ReplayRecorder snapshot memory', () => {
  const extendedUi = (extension: unknown) => ({ activeGamePanelTab: 'inventory' as const, extension });

  it('shares equal readonly metadata without sharing mutable simulation state or live inputs', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(undefined, 17), startPos: START });
    const recorder = new ReplayRecorder();
    const state = engine.getState();
    const camera = { ...VIEWPORT_STATE, target: { ...VIEWPORT_STATE.target } };
    const options = { viewportState: camera, dpsProjection: engine.getAdjustedTheoreticalDps(), recordedAtMs: 0 };
    recorder.recordFrame(0, START, state, [], options);

    recorder.recordFrame(1, START, state, [], structuredClone(options));

    const first = recorder.getFrame(0);
    const second = recorder.getFrame(1);
    if (!first || !second) throw new Error('Missing recorded frames');
    expect(second.uiState).toBe(first.uiState);
    expect(second.viewportState).toBe(first.viewportState);
    expect(second.dpsProjection).not.toBeNull();
    expect(second.dpsProjection).toBe(first.dpsProjection);
    expect(first.dpsProjection).not.toBe(options.dpsProjection);
    expect(second.state.stats).not.toBe(first.state.stats);
    first.state.stats.attack.current = 1;
    camera.target.x = 100;
    expect(second.state.stats.attack.current).toBe(state.stats.attack.current);
    expect(first.viewportState).toEqual(VIEWPORT_STATE);
  });

  it.each([
    { kind: 'new nested fields', before: { extra: [1] }, after: { extra: [2] } },
    { kind: 'absent fields', before: { extra: undefined }, after: {} },
    { kind: 'object key order', before: { first: 1, second: 2 }, after: { second: 2, first: 1 } },
    { kind: 'signed zero', before: -0, after: 0 },
    { kind: 'nonfinite values', before: NaN, after: null },
    { kind: 'sparse arrays', before: new Array(2), after: [] },
    { kind: 'native dates', before: new Date(0), after: new Date(1) },
    { kind: 'native maps', before: new Map([['value', 1]]), after: new Map([['value', 2]]) },
  ])('preserves distinct $kind in newly captured metadata', ({ before, after }) => {
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, START, makeState(0), [], { uiState: extendedUi(before) });

    recorder.recordFrame(1, START, makeState(1), [], { uiState: extendedUi(after) });

    expect(recorder.getFrame(1)?.uiState).not.toBe(recorder.getFrame(0)?.uiState);
    expect(recorder.getFrame(0)?.uiState).toEqual(extendedUi(before));
    expect(recorder.getFrame(1)?.uiState).toEqual(extendedUi(after));
  });

  it('preserves cyclic metadata supported by native cloning', () => {
    const cycle: { value: number; self?: unknown } = { value: 1 };
    cycle.self = cycle;
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, START, makeState(0), [], { uiState: extendedUi(cycle) });

    recorder.recordFrame(1, START, makeState(1), [], { uiState: extendedUi(cycle) });

    expect(recorder.getFrame(1)?.uiState).toBe(recorder.getFrame(0)?.uiState);
    const exported = recorder.exportData();
    expect(exported.frames[1]?.uiState).toEqual(extendedUi(cycle));
    expect(exported.frames[1]?.uiState).not.toBe(recorder.getFrame(1)?.uiState);
  });

  it('preserves different alias patterns across metadata loaded in a single clone', () => {
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, START, makeState(0), []);
    recorder.recordFrame(1, START, makeState(1), []);
    const data = recorder.exportData();
    const child = { value: 1 };

    recorder.load({
      ...data,
      frames: data.frames.map((frame, index) => ({
        ...frame,
        uiState: extendedUi(index === 0 ? [child, child] : [child, { value: 1 }]),
      })),
    });

    const first = recorder.getFrame(0)?.uiState;
    const second = recorder.getFrame(1)?.uiState;
    if (!first || !second || !('extension' in first) || !('extension' in second)) {
      throw new Error('Missing metadata extension');
    }
    if (!Array.isArray(first.extension) || !Array.isArray(second.extension)) {
      throw new Error('Expected alias arrays');
    }
    expect(second).not.toBe(first);
    expect(first.extension[0]).toBe(first.extension[1]);
    expect(second.extension[0]).not.toBe(second.extension[1]);
  });

  it('shares imported readonly metadata while leaving input data and writable frame state isolated', () => {
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, START, makeState(0), [], { viewportState: VIEWPORT_STATE });
    recorder.recordFrame(1, START, makeState(1), [], { viewportState: VIEWPORT_STATE });
    const exported = recorder.exportData();
    const input = {
      ...exported,
      frames: exported.frames.map((frame) => structuredClone(frame)),
    };
    const loaded = new ReplayRecorder();

    loaded.load(input);

    const first = loaded.getFrame(0);
    const second = loaded.getFrame(1);
    if (!first || !second) throw new Error('Missing loaded frames');
    expect(second.viewportState).toBe(first.viewportState);
    expect(first.viewportState).not.toBe(input.frames[0]?.viewportState);
    expect(loaded.exportData()).toEqual(input);
    first.state.stats.attack.current = 1;
    expect(second.state.stats.attack.current).toBe(99);
    expect(input.frames[0]?.state.stats.attack.current).toBe(99);
  });

  it('compares a resumed frame with the retained fork prefix rather than discarded metadata', () => {
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, START, makeState(0), [], { uiState: extendedUi(1) });
    recorder.recordFrame(1, START, makeState(1), [], { uiState: extendedUi(2) });
    recorder.forkAt(0);

    recorder.recordFrame(1, START, makeState(1), [], { uiState: extendedUi(1) });

    expect(recorder.getFrame(1)?.uiState).toBe(recorder.getFrame(0)?.uiState);
  });

  it('does not retain metadata from a cleared recording', () => {
    const recorder = new ReplayRecorder();
    recorder.recordFrame(0, START, makeState(0), [], { uiState: extendedUi(1) });
    const previous = recorder.getFrame(0)?.uiState;
    recorder.clear();

    recorder.recordFrame(0, START, makeState(0), [], { uiState: extendedUi(1) });

    expect(recorder.getFrame(0)?.uiState).toEqual(previous);
    expect(recorder.getFrame(0)?.uiState).not.toBe(previous);
  });

  it('does not traverse discarded player histories or mutate their live maps', () => {
    const recorder = new ReplayRecorder();
    const state = makeState(0);
    const position: Coordinate = [1, 2];
    let reads = 0;
    Object.defineProperty(position, 0, {
      enumerable: true,
      get: () => {
        reads++;
        return 1;
      },
    });
    state.playerHistory.set(0, position);
    state.primaryNpcHistory.set(0, position);

    recorder.recordFrame(0, START, state, []);

    expect(reads).toBe(0);
    expect(state.playerHistory.get(0)).toBe(position);
    expect(state.primaryNpcHistory.get(0)).toBe(position);
    expect(recorder.getFrame(0)?.state.playerHistory.size).toBe(0);
    expect(recorder.getFrame(0)?.state.primaryNpcHistory.size).toBe(0);
  });

  it('preserves NPC aliases in additional snapshot fields when clearing their histories', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(undefined, 17), startPos: START });
    const state = engine.getState();
    const npc = state.npcs[0];
    if (!npc) throw new Error('Missing snapshot NPC');
    npc.history.set(0, [1, 2]);
    const recorder = new ReplayRecorder();
    const extended = { ...state, npcAlias: npc };

    recorder.recordFrame(0, START, extended, []);

    const stored = recorder.getFrame(0)?.state;
    if (!stored || !('npcAlias' in stored)) throw new Error('Missing snapshot alias');
    expect(stored.npcAlias).toBe(stored.npcs[0]);
    expect(stored.primaryNpcPosition).toBe(stored.npcs[0]?.position);
    expect(stored.npcs[0]?.history.size).toBe(0);
    expect(npc.history.size).toBe(1);
  });
});

describe('ReplayRecorder recording clock', () => {
  it('keeps frame and fork anchors in the same active domain as epoch events after a paused speed checkpoint', () => {
    const clock = new BackgroundClock();
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const recorder = new ReplayRecorder({}, clock);
    seedFrame(recorder, 0, 1000);
    now.mockReturnValue(1100);
    clock.setSuspended(true);
    now.mockReturnValue(61_100);
    recorder.checkpointSpeedChange(2);
    now.mockReturnValue(121_100);
    clock.setSuspended(false);
    recorder.recordCursorClick(10, 20, 'ui', 0.5, CURSOR_FRAME, 121_200);
    seedFrame(recorder, 1, 121_300);
    recorder.recordCursorClick(20, 20, 'ui', 0.5, CURSOR_FRAME, performance.timeOrigin + 121_350);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([250, 625]);

    recorder.forkAt(1, 121_400);
    recorder.recordCursorClick(30, 20, 'ui', 0.5, CURSOR_FRAME, performance.timeOrigin + 121_500);
    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([250, 650]);
  });

  it.each([
    { name: 'modifiers', record: (recorder: ReplayRecorder) => recorder.recordModifierSample(1, 1020, 1) },
    { name: 'menu', record: (recorder: ReplayRecorder) => recorder.recordMenuState(1, 1020, null) },
    { name: 'viewport', record: (recorder: ReplayRecorder) => recorder.recordViewportSample(1, 1020, VIEWPORT_STATE) },
    {
      name: 'presentation',
      record: (recorder: ReplayRecorder) =>
        recorder.recordPresentationState(1, 1020, ReplayPresentationStateSchema.parse(validPresentationSample().state)),
    },
  ])('preserves delivered event times and click pins when $name metadata is observed later', ({ record }) => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    record(recorder);

    recorder.recordCursorSample(10, 20, 1, CURSOR_FRAME, 1004);
    recorder.recordCursorSample(11, 21, 1, CURSOR_FRAME, 1008);
    recorder.recordCursorClick(12, 22, 'ui', 1, CURSOR_FRAME, 1012);
    recorder.recordCursorSample(13, 23, 1, CURSOR_FRAME, 1016);

    expect(recorder.getCursorTrack().samples).toEqual([
      { tMs: 4, x: 10, y: 20, insideFrame: true },
      { tMs: 8, x: 11, y: 21, insideFrame: true },
      { tMs: 12, x: 12, y: 22, insideFrame: true, pinned: true },
      { tMs: 16, x: 13, y: 23, insideFrame: true },
    ]);
    expect(recorder.getCursorTrack().clicks).toEqual([{ tMs: 12, x: 12, y: 22, insideFrame: true, type: 'ui' }]);
    expect(interpolateCursor(recorder.getCursorTrack(), 8)).toEqual({ x: 11, y: 21 });
    expect(interpolateCursor(recorder.getCursorTrack(), 12)).toEqual({ x: 12, y: 22 });
  });

  it('preserves event-time progress after a speed checkpoint when newer metadata arrives first', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    recorder.checkpointSpeedChange(2, 1100);
    recorder.recordModifierSample(0.5, 1160, 1);

    recorder.recordCursorClick(10, 20, 'ui', 0.5, CURSOR_FRAME, 1120);
    recorder.recordCursorClick(20, 20, 'ui', 0.5, CURSOR_FRAME, 1140);
    recorder.recordCursorClick(30, 20, 'ui', 0.5, CURSOR_FRAME, 1180);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([210, 220, 240]);
    expect(recorder.getModifierTrack()).toEqual([{ tMs: 230, mask: 1, buttons: 0 }]);
  });

  it('preserves pre-cap event times when newer metadata has already reached the tick end', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    recorder.recordModifierSample(1, 1800, 1);

    recorder.recordCursorClick(10, 20, 'ui', 1, CURSOR_FRAME, 1590);
    recorder.recordCursorClick(20, 20, 'ui', 1, CURSOR_FRAME, 1700);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([590, 599]);
  });

  it('uses the shared rate interval when metadata changes speed without an explicit checkpoint', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    recorder.recordModifierSample(2, 1100, 1);
    recorder.recordModifierSample(0.5, 1140, 0);

    recorder.recordCursorClick(10, 20, 'ui', 0.5, CURSOR_FRAME, 1120);
    recorder.recordCursorClick(20, 20, 'ui', 0.5, CURSOR_FRAME, 1160);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([210, 230]);
  });

  it('preserves elapsed progress when direct sample rates drop from 2x to 0.5x midtick', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(RUN_CONFIG);
    seedFrame(recorder, 0, 1000);
    recorder.recordCursorClick(10, 20, 'yellow', 2, CURSOR_FRAME, 1100);

    recorder.recordCursorClick(30, 40, 'red', 0.5, CURSOR_FRAME, 1110);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([200, 205]);
    expect(recorder.getCursorTrack().clicks.map(({ x }) => x)).toEqual([10, 30]);
  });

  it('accounts for an unsampled old-rate interval when a speed change is checkpointed', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);

    recorder.checkpointSpeedChange(2, 1120);
    recorder.recordCursorClick(10, 20, 'yellow', 0.5, CURSOR_FRAME, 1140);
    recorder.checkpointSpeedChange(0.5, 1160);
    recorder.recordCursorClick(30, 40, 'red', 1, CURSOR_FRAME, 1180);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([250, 280]);
    expect(recorder.getCursorTrack().samples).toHaveLength(2);
  });

  it('holds at the tick end until a new frame anchors ordinary scaled timestamps', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    recorder.checkpointSpeedChange(2, 1100);
    recorder.recordCursorClick(10, 20, 'yellow', 0.5, CURSOR_FRAME, 1900);
    recorder.recordCursorClick(20, 20, 'yellow', 0.5, CURSOR_FRAME, 2290);

    seedFrame(recorder, 1, 2300);
    recorder.recordCursorClick(30, 20, 'yellow', 0.5, CURSOR_FRAME, 2350);
    recorder.checkpointSpeedChange(0.5, 2370);
    recorder.recordCursorClick(40, 20, 'yellow', 1, CURSOR_FRAME, 2390);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([599, 599, 625, 655]);
  });

  it('anchors a fork at its retained boundary without carrying old sub-tick progress', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    seedFrame(recorder, 1, 1300);
    recorder.recordCursorClick(10, 20, 'yellow', 2, CURSOR_FRAME, 1400);
    seedFrame(recorder, 2, 1600);
    recorder.checkpointSpeedChange(2, 1700);

    recorder.forkAt(1, 5000);
    recorder.recordCursorClick(20, 20, 'yellow', 0.5, CURSOR_FRAME, 5050);
    recorder.checkpointSpeedChange(0.5, 5070);
    recorder.recordCursorClick(30, 20, 'yellow', 1, CURSOR_FRAME, 5090);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([625, 655]);
  });

  it.each([
    { name: 'startRun', reset: (recorder: ReplayRecorder) => recorder.startRun(RUN_CONFIG) },
    { name: 'clear', reset: (recorder: ReplayRecorder) => recorder.clear() },
    { name: 'load', reset: (recorder: ReplayRecorder) => recorder.load(new ReplayRecorder().exportData()) },
  ])('resets the recording clock when $name replaces a recording', ({ reset }) => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    recorder.checkpointSpeedChange(2, 1100);

    reset(recorder);
    recorder.recordCursorClick(10, 20, 'yellow', 2, CURSOR_FRAME, 10);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([20]);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1090,
  ])('preserves the clock when an unusable or delayed timestamp arrives: %s', (timestamp) => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    recorder.recordCursorClick(10, 20, 'yellow', 2, CURSOR_FRAME, 1100);

    recorder.recordCursorClick(20, 20, 'yellow', 0.5, CURSOR_FRAME, timestamp);
    recorder.recordCursorClick(30, 20, 'yellow', 0.5, CURSOR_FRAME, 1140);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([200, 200, 220]);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -1,
  ])('uses ordinary speed for an invalid sample rate without losing elapsed time: %s', (speed) => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 1000);
    recorder.recordCursorClick(10, 20, 'yellow', 2, CURSOR_FRAME, 1100);

    recorder.recordCursorClick(20, 20, 'yellow', speed, CURSOR_FRAME, 1110);

    expect(recorder.getCursorTrack().clicks.map(({ tMs }) => tMs)).toEqual([200, 210]);
  });
});

describe('ReplayRecorder cursor track', () => {
  it('shares unchanged camera snapshots without losing cursor samples, clicks, or camera changes', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 0);
    const camera = { ...VIEWPORT_STATE, target: { ...VIEWPORT_STATE.target } };
    recorder.recordCursorSample(210, 80, 1, FRAME, 10, camera);
    recorder.recordCursorSample(220, 80, 1, FRAME, 20, camera);
    recorder.recordCursorClick(230, 80, 'red', 1, FRAME, 30, camera);
    recorder.recordCursorClick(240, 80, 'ui', 1, FRAME, 40, camera);

    camera.target.x = 100;
    recorder.recordCursorSample(250, 80, 1, FRAME, 50, camera);
    recorder.recordCursorSample(260, 80, 1, FRAME, 60);

    const { samples, clicks } = recorder.getCursorTrack();
    expect(samples.map(({ tMs, x }) => [tMs, x])).toEqual([
      [10, 110],
      [20, 120],
      [30, 130],
      [40, 140],
      [50, 150],
      [60, 160],
    ]);
    expect(clicks.map(({ tMs, type }) => [tMs, type])).toEqual([
      [30, 'red'],
      [40, 'ui'],
    ]);
    expect(samples[3]?.viewportState).toBe(samples[0]?.viewportState);
    expect(clicks[1]?.viewportState).toBe(clicks[0]?.viewportState);
    expect(samples[0]?.viewportState).toEqual(VIEWPORT_STATE);
    expect(samples[4]?.viewportState).toEqual(camera);
    expect(samples[4]?.viewportState).not.toBe(camera);
    expect(samples[4]?.viewportState).not.toBe(samples[0]?.viewportState);
    expect(samples[5]).not.toHaveProperty('viewportState');
  });

  it('deduplicates imported camera snapshots without modifying supplied tracks', () => {
    const recorder = new ReplayRecorder();
    seedFrame(recorder, 0, 0);
    for (let index = 1; index <= 4; index++) {
      recorder.recordCursorClick(200 + index, 80, 'ui', 1, FRAME, index * 10, VIEWPORT_STATE);
    }
    const data = recorder.exportData();
    const input = {
      ...data,
      cursorSamples: data.cursorSamples.map((sample) => structuredClone(sample)),
      cursorClicks: data.cursorClicks.map((click) => structuredClone(click)),
    };
    const loaded = new ReplayRecorder();

    loaded.load(input);

    expect(loaded.exportData()).toEqual(input);
    const { samples, clicks } = loaded.getCursorTrack();
    expect(samples.at(-1)?.viewportState).toBe(samples[0]?.viewportState);
    expect(clicks.at(-1)?.viewportState).toBe(clicks[0]?.viewportState);
    expect(samples[0]?.viewportState).not.toBe(input.cursorSamples[0]?.viewportState);
    expect(input.cursorSamples[0]?.viewportState).not.toBe(input.cursorSamples.at(-1)?.viewportState);
  });

  it('stores cursor samples in a side-channel with scaled sub-tick times', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);

    recorder.recordCursorSample(10, 20, 2, CURSOR_FRAME, 1010, TEST_VIEWPORT_STATE);

    expect(recorder.getFrame(0)).not.toHaveProperty('cursorTrack');
    expect(recorder.getCursorTrack()).toMatchObject({
      samples: [{ tMs: 20, x: 10, y: 20, insideFrame: true, viewportState: TEST_VIEWPORT_STATE }],
      clicks: [],
    });
  });

  it('stores cloned viewport states on cursor samples and clicks', () => {
    const recorder = new ReplayRecorder();
    const target = { x: 31.5, y: 37.5, z: 0.9 };
    const viewportState: ReplayViewportState = {
      kind: 'orbit3d',
      pitchDeg: -45,
      yawDeg: 180,
      fovScale: 512,
      target,
    };
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);

    recorder.recordCursorClick(30, 40, 'yellow', 1, CURSOR_FRAME, 1010, viewportState);
    target.x = 99;

    expect(recorder.getCursorTrack().clicks[0]?.viewportState).toEqual(TEST_VIEWPORT_STATE);
    expect(recorder.getCursorTrack().samples[0]?.viewportState).toEqual(TEST_VIEWPORT_STATE);
  });

  it('records click type, clamps subtick time, and resets on a new run', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);
    seedFrame(recorder, 1, 1600);
    seedFrame(recorder, 2, 2200);

    recorder.recordCursorClick(30, 40, 'red', 10, CURSOR_FRAME, 2300);
    recorder.recordCursorSample(50, 60, 10, CURSOR_FRAME, 2300);
    expect(recorder.getCursorTrack().clicks[0]).toEqual({ tMs: 1799, x: 30, y: 40, insideFrame: true, type: 'red' });
    expect(recorder.getCursorTrack().samples).toEqual([
      { tMs: 1799, x: 30, y: 40, insideFrame: true, pinned: true },
      { tMs: 1799, x: 50, y: 60, insideFrame: true },
    ]);

    recorder.startRun(makeRunConfig());
    expect(recorder.getCursorTrack().clicks).toHaveLength(0);
    expect(recorder.getCursorTrack().samples).toHaveLength(0);

    seedFrame(recorder, 0, 1000);
    recorder.recordCursorClick(1, 2, 'yellow', 1, CURSOR_FRAME, 1600);
    expect(recorder.getCursorTrack().clicks).toHaveLength(1);
    expect(recorder.getCursorTrack().samples).toEqual([{ tMs: 599, x: 1, y: 2, insideFrame: true, pinned: true }]);
    recorder.recordCursorClick(1, 2, 'yellow', 1, CURSOR_FRAME, 1600);
    recorder.clear();
    expect(recorder.getCursorTrack()).toMatchObject({ samples: [], clicks: [] });
  });

  it('shows the exact click when later movement shares its capped tick-end timestamp', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);

    recorder.recordCursorClick(110, 60, 'yellow', 1, FRAME, 1600);
    recorder.recordCursorSample(142, 60, 1, FRAME, 1601);

    expect(recorder.getCursorTrack().clicks[0]).toMatchObject({ tMs: 599, x: 10, y: 10 });
    expect(interpolateCursor(recorder.getCursorTrack(), 599)).toEqual({ x: 10, y: 10 });
  });

  it('persists neutral UI click types in the cursor track', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);

    recorder.recordCursorClick(30, 40, 'ui', 1, CURSOR_FRAME, 1010);

    expect(recorder.getCursorTrack().clicks).toEqual([{ tMs: 10, x: 30, y: 40, insideFrame: true, type: 'ui' }]);
  });

  it('normalizes epoch-based DOM event timestamps before sub-tick math', () => {
    const recorder = new ReplayRecorder();
    const timeOriginSpy = vi.spyOn(performance, 'timeOrigin', 'get').mockReturnValue(10_000);
    const nowSpy = vi.spyOn(performance, 'now').mockReturnValue(2_300);

    try {
      recorder.startRun(makeRunConfig());
      seedFrame(recorder, 0, 1_400);
      seedFrame(recorder, 1, 2_000);

      recorder.recordCursorClick(30, 40, 'yellow', 1, CURSOR_FRAME, 12_250);

      expect(recorder.getCursorTrack().clicks).toEqual([{ tMs: 850, x: 30, y: 40, insideFrame: true, type: 'yellow' }]);
      expect(recorder.getCursorTrack().samples.at(-1)).toEqual({
        tMs: 850,
        x: 30,
        y: 40,
        insideFrame: true,
        pinned: true,
      });
    } finally {
      timeOriginSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });

  it('keeps DOMHighResTimeStamp values unchanged for accelerated sub-tick timing', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 700);
    seedFrame(recorder, 1, 1_300);

    recorder.recordCursorClick(30, 40, 'yellow', 2, CURSOR_FRAME, 1_375);

    expect(recorder.getCursorTrack().clicks).toEqual([{ tMs: 750, x: 30, y: 40, insideFrame: true, type: 'yellow' }]);
    expect(recorder.getCursorTrack().samples.at(-1)).toEqual({
      tMs: 750,
      x: 30,
      y: 40,
      insideFrame: true,
      pinned: true,
    });
  });

  it('stores cloned viewport samples in a dedicated side-channel with scaled sub-tick times', () => {
    const recorder = new ReplayRecorder();
    const target = { x: 31.5, y: 37.5, z: 0.9 };
    const viewportState: ReplayViewportState = {
      ...TEST_VIEWPORT_STATE,
      target,
    };
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);

    recorder.recordViewportSample(2, 1010, viewportState);
    target.x = 99;

    expect(recorder.getFrame(0)).not.toHaveProperty('viewportTrack');
    expect(recorder.getViewportTrack().samples).toEqual([{ tMs: 20, viewportState: TEST_VIEWPORT_STATE }]);
  });

  it('adds frame viewport snapshots to the continuous viewport track at tick boundaries', () => {
    const recorder = new ReplayRecorder();
    const frame1ViewportState: ReplayViewportState = { ...TEST_VIEWPORT_STATE, yawDeg: 190 };
    recorder.startRun(makeRunConfig());

    recorder.recordFrame(0, START, makeState(0), [], { viewportState: TEST_VIEWPORT_STATE, recordedAtMs: 1000 });
    recorder.recordFrame(1, START, makeState(1), [], { viewportState: frame1ViewportState, recordedAtMs: 1600 });

    expect(recorder.getViewportTrack().samples).toEqual([
      { tMs: 0, viewportState: TEST_VIEWPORT_STATE },
      { tMs: 600, viewportState: frame1ViewportState },
    ]);
  });

  it('holds A at 600 ms when unchanged A at 600 is discarded before B at 900', () => {
    const recorder = new ReplayRecorder();
    const moved = { ...TEST_VIEWPORT_STATE, yawDeg: 270 };
    recorder.recordFrame(0, START, makeState(0), [], { viewportState: TEST_VIEWPORT_STATE, recordedAtMs: 1000 });
    recorder.recordFrame(1, START, makeState(1), [], { viewportState: TEST_VIEWPORT_STATE, recordedAtMs: 1600 });
    recorder.recordViewportSample(1, 1900, moved);

    const camera = interpolateReplayViewportState(recorder.getViewportTrack().samples, 600, undefined);

    expect(camera).toEqual(TEST_VIEWPORT_STATE);
  });

  it('does not clone the camera when an unchanged viewport observation is rejected', () => {
    const recorder = new ReplayRecorder();
    recorder.recordViewportSample(1, 0, TEST_VIEWPORT_STATE);
    const cloneSpy = vi.spyOn(globalThis, 'structuredClone');
    try {
      recorder.recordViewportSample(1, 20, TEST_VIEWPORT_STATE);

      expect(cloneSpy).not.toHaveBeenCalled();
    } finally {
      cloneSpy.mockRestore();
    }
  });

  it('replaces same-time viewport samples instead of keeping duplicate timestamps', () => {
    const recorder = new ReplayRecorder();
    const updatedViewportState: ReplayViewportState = { ...TEST_VIEWPORT_STATE, yawDeg: 190 };
    recorder.startRun(makeRunConfig());

    recorder.recordFrame(0, START, makeState(0), [], { viewportState: TEST_VIEWPORT_STATE, recordedAtMs: 1000 });
    recorder.recordViewportSample(1, 1000, updatedViewportState);

    expect(recorder.getViewportTrack().samples).toEqual([{ tMs: 0, viewportState: updatedViewportState }]);
  });

  it('coalesces unchanged and tiny viewport samples without dropping meaningful camera changes', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);

    recorder.recordViewportSample(1, 1000, TEST_VIEWPORT_STATE);
    recorder.recordViewportSample(1, 1010, { ...TEST_VIEWPORT_STATE });
    recorder.recordViewportSample(1, 1012, { ...TEST_VIEWPORT_STATE, yawDeg: 180.01 });
    recorder.recordViewportSample(1, 1013, { ...TEST_VIEWPORT_STATE, yawDeg: 182 });
    recorder.recordViewportSample(1, 1029, { ...TEST_VIEWPORT_STATE, yawDeg: 182 });

    expect(recorder.getViewportTrack().samples).toEqual([
      { tMs: 0, viewportState: TEST_VIEWPORT_STATE },
      { tMs: 13, viewportState: { ...TEST_VIEWPORT_STATE, yawDeg: 182 } },
    ]);
  });
  it('caps samples and clicks after a seeded frame', () => {
    const recorder = new ReplayRecorder({ cursorSamples: 30, cursorClicks: 5 });
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 0);

    for (let i = 0; i < 100; i += 1) {
      recorder.recordCursorSample(i * 3, 0, 1, CURSOR_FRAME, i * 34);
    }
    for (let i = 0; i < 10; i += 1) {
      recorder.recordCursorClick(i, 0, 'yellow', 1, CURSOR_FRAME, i);
    }

    expect(recorder.getCursorTrack().samples).toHaveLength(30);
    expect(recorder.getCursorTrack().clicks).toHaveLength(5);
  });

  it('preserves the last accepted cursor sample when an odd-sized sequence exceeds capacity', () => {
    const recorder = new ReplayRecorder({ cursorSamples: 30 });
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 0);

    const OVER_CAP = 31;
    for (let i = 0; i < OVER_CAP; i += 1) {
      if (i > 0 && i % 10 === 0) seedFrame(recorder, i / 10, i * 34);
      recorder.recordCursorSample(i * 3, i * 5, 1, CURSOR_FRAME, i * 34);
    }

    const { samples } = recorder.getCursorTrack();
    expect(samples).toHaveLength(30);
    expect(samples.at(-1)).toEqual({
      tMs: 1506,
      x: (OVER_CAP - 2) * 3,
      y: (OVER_CAP - 2) * 5,
      insideFrame: false,
    });
  });
});

describe('ReplayRecorder core recording', () => {
  function makeRunConfig(): EngineRunConfig {
    return {
      completionOwnership: 'encounter-owned',
      encounter: {
        kind: 'yama_p3',
        seeds: { phaseSeed: 1234 },
      },
    };
  }

  function makeState(tick: number): SimulationState {
    return {
      currentTick: tick,
      playerPosition: [31, 37],
      encounterOutcome: {
        phase: 'victory',
        decisiveTick: 5,
        completionTick: 14,
        primaryActorId: 'yama',
        completionActorIds: ['yama'],
      },
      nested: { hp: 99, buffs: ['a'] },
      playerHistory: new Map([[tick, [31, 37]]]),
    } as unknown as SimulationState;
  }

  function makeEvent(tick: number): GameEvent {
    return {
      eventId: tick,
      tick,
      type: 'encounter_custom_event',
    };
  }

  function makeOrbitViewportState(): ReplayViewportState {
    return {
      kind: 'orbit3d',
      pitchDeg: -45,
      yawDeg: 180,
      fovScale: 512,
      target: { x: 31.5, y: 37.5, z: 0.9 },
    };
  }

  describe('ReplayRecorder', () => {
    it('records frames and exposes frame accessors', () => {
      const recorder = new ReplayRecorder();
      const runConfig = makeRunConfig();
      const state0 = makeState(0);
      const state1 = makeState(1);

      recorder.startRun(runConfig);
      recorder.recordFrame(0, [31, 37], state0, []);
      recorder.recordFrame(1, [32, 37], state1, [makeEvent(1)]);

      expect(recorder.getFrameCount()).toBe(2);
      expect(recorder.getFrame(0)?.tick).toBe(0);
      expect(recorder.getFrame(1)?.events).toHaveLength(1);
      expect(recorder.getFrame(2)).toBeUndefined();
    });

    it('attaches pending actions to the next frame only', () => {
      const recorder = new ReplayRecorder();
      recorder.startRun(makeRunConfig());

      const actionA: EngineAction = { type: 'runToggle' };
      const actionB: EngineAction = { type: 'itemAction', inventoryIndex: 4 };

      recorder.recordAction(actionA);
      recorder.recordAction(actionB);
      recorder.recordFrame(1, [31, 37], makeState(1), []);
      recorder.recordFrame(2, [31, 38], makeState(2), []);

      expect(recorder.getFrame(0)?.actions).toEqual([actionA, actionB]);
      expect(recorder.getFrame(1)?.actions).toEqual([]);
    });

    it('records Guzzle distinctly and retains the health target when seeking snapshots', () => {
      const recorder = new ReplayRecorder();
      recorder.startRun(makeRunConfig());
      recorder.recordAction({ type: 'itemAction', inventoryIndex: 4, option: 'guzzle' });
      recorder.recordFrame(1, [31, 37], { ...makeState(1), lastAttackTarget: 'ranger' }, []);
      recorder.recordFrame(2, [31, 38], { ...makeState(2), lastAttackTarget: 'mager' }, []);

      expect(recorder.getFrame(1)?.state.lastAttackTarget).toBe('mager');
      expect(recorder.getFrame(0)?.state.lastAttackTarget).toBe('ranger');
      expect(recorder.getFrame(0)?.actions).toEqual([{ type: 'itemAction', inventoryIndex: 4, option: 'guzzle' }]);
    });

    it('clear resets frames, run config, pending actions, and the overlay snapshot', () => {
      const recorder = new ReplayRecorder();
      recorder.startRun(makeRunConfig(), {
        tileMarkers: [{ x: 31, y: 37, color: '#3BA9FF', opacity: 1 }],
        showTileMarkers: true,
        showTileMarkerLabels: true,
        lineMarkers: [],
        showLineMarkers: true,
        showLineMarkerLabels: true,
        lineMarkerWidth: 1,
      });
      recorder.recordAction({ type: 'runToggle' });
      recorder.recordFrame(0, [31, 37], makeState(0), []);

      recorder.clear();

      expect(recorder.getFrameCount()).toBe(0);
      expect(recorder.getRunConfig()).toBeNull();
      expect(recorder.hasRecording()).toBe(false);
      // A stale snapshot here would replay the previous run's markers over the next one.
      expect(recorder.getOverlays()).toBeNull();

      recorder.recordFrame(1, [31, 38], makeState(1), []);
      expect(recorder.getFrame(0)?.actions).toEqual([]);
    });

    it('reports hasRecording based on frame availability', () => {
      const recorder = new ReplayRecorder();
      expect(recorder.hasRecording()).toBe(false);

      recorder.startRun(makeRunConfig());
      expect(recorder.hasRecording()).toBe(false);

      recorder.recordFrame(0, [31, 37], makeState(0), []);
      expect(recorder.hasRecording()).toBe(true);
    });

    it('isolates stored frame data from later mutations', () => {
      const recorder = new ReplayRecorder();
      const runConfig = makeRunConfig();
      recorder.startRun(runConfig);

      const input: Coordinate = [31, 37];
      const state = makeState(5) as unknown as {
        currentTick: number;
        playerPosition: Coordinate;
        nested: { hp: number; buffs: string[] };
        playerHistory: Map<number, Coordinate>;
      };
      const events: GameEvent[] = [makeEvent(5)];

      recorder.recordFrame(5, input, state as unknown as SimulationState, events);

      input[0] = 99;
      state.nested.hp = 1;
      state.nested.buffs.push('mutated');
      state.playerHistory.set(99, [99, 99]);
      runConfig.encounter.kind = 'lobby';

      const stored = recorder.getFrame(0);
      expect(stored?.input).toEqual([31, 37]);
      expect((stored?.state as unknown as { nested: { hp: number; buffs: string[] } }).nested.hp).toBe(99);
      expect((stored?.state as unknown as { nested: { hp: number; buffs: string[] } }).nested.buffs).toEqual(['a']);
      expect((stored?.state as unknown as { playerHistory: Map<number, Coordinate> }).playerHistory.has(99)).toBe(
        false,
      );
      expect(recorder.getRunConfig()?.encounter.kind).toBe('yama_p3');
    });

    it('deep clones encounter outcome actor identities for replay snapshots', () => {
      const recorder = new ReplayRecorder();
      const state = makeState(14);
      const completionActorIds: ActorId[] = ['yama'];
      state.encounterOutcome = {
        phase: 'victory',
        decisiveTick: 5,
        completionTick: 14,
        primaryActorId: 'yama',
        completionActorIds,
      };
      recorder.startRun(makeRunConfig());

      recorder.recordFrame(14, [31, 37], state, []);
      completionActorIds.push('mutated-actor');

      expect(recorder.getFrame(0)?.state.encounterOutcome).toEqual({
        phase: 'victory',
        decisiveTick: 5,
        completionTick: 14,
        primaryActorId: 'yama',
        completionActorIds: ['yama'],
      });
    });

    it('stores a cloned replay viewport state on each frame', () => {
      const recorder = new ReplayRecorder();
      const target = { x: 31.5, y: 37.5, z: 0.9 };
      const viewportState: ReplayViewportState = {
        ...makeOrbitViewportState(),
        target,
      };

      recorder.startRun(makeRunConfig());
      recorder.recordFrame(5, [31, 37], makeState(5), [], {
        uiState: DEFAULT_REPLAY_UI_STATE,
        viewportState,
        recordedAtMs: 1200,
      });
      target.x = 99;

      expect(recorder.getFrame(0)?.viewportState).toEqual(makeOrbitViewportState());
    });
  });
});

describe('ReplayRecorder modifier track', () => {
  function recorderAtFrame(): ReplayRecorder {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    recorder.recordFrame(0, [31, 37], makeState(0), [], { uiState: DEFAULT_REPLAY_UI_STATE, recordedAtMs: 0 });
    return recorder;
  }

  it('appends only when the mask changes', () => {
    const recorder = recorderAtFrame();
    recorder.recordModifierSample(1, 10, 1);
    recorder.recordModifierSample(1, 20, 1);
    recorder.recordModifierSample(1, 30, 0);

    expect(recorder.getModifierTrack().map((s) => s.mask)).toEqual([1, 0]);
  });

  it('drops a press and release that land in the same recorded millisecond', () => {
    const recorder = recorderAtFrame();
    recorder.recordModifierSample(1, 10, 1);
    recorder.recordModifierSample(1, 10, 0);

    expect(recorder.getModifierTrack()).toEqual([]);
  });

  it('keeps sub-tick transitions that a per-tick field would collapse', () => {
    const recorder = recorderAtFrame();
    recorder.recordModifierSample(1, 10, 1);
    recorder.recordModifierSample(1, 200, 0);
    recorder.recordModifierSample(1, 400, 1);

    const track = recorder.getModifierTrack();
    expect(track.length).toBe(3);
    expect(modifierMaskAt(track, track[0].tMs)).toBe(1);
    expect(modifierMaskAt(track, track[1].tMs)).toBe(0);
    expect(modifierMaskAt(track, track[2].tMs + 5)).toBe(1);
  });

  it('reports nothing held before the first sample', () => {
    expect(modifierMaskAt([], 500)).toBe(0);
    expect(modifierMaskAt([{ tMs: 100, mask: 3, buttons: 1 }], 50)).toBe(0);
    expect(modifierMaskAt([{ tMs: 100, mask: 3, buttons: 1 }], 100)).toBe(3);
    expect(mouseButtonMaskAt([{ tMs: 100, mask: 3, buttons: 1 }], 50)).toBe(0);
  });

  it('round-trips the track through export and load', () => {
    const recorder = recorderAtFrame();
    recorder.recordModifierSample(1, 10, 1);
    recorder.recordModifierSample(1, 300, 0);

    const loaded = new ReplayRecorder();
    loaded.load(recorder.exportData());
    expect(loaded.getModifierTrack()).toEqual(recorder.getModifierTrack());
  });

  it('appends a sample when only the buttons change', () => {
    const recorder = recorderAtFrame();
    recorder.recordModifierSample(1, 10, 0, 0);
    recorder.recordModifierSample(1, 100, 0, 1);
    recorder.recordModifierSample(1, 200, 0, 1);
    recorder.recordModifierSample(1, 300, 0, 0);

    expect(recorder.getModifierTrack().map((s) => s.buttons)).toEqual([0, 1, 0]);
  });

  it('resolves the button held at a playhead, and its release', () => {
    const track = [
      { tMs: 0, mask: 0, buttons: 0 },
      { tMs: 500, mask: 0, buttons: 2 },
      { tMs: 900, mask: 0, buttons: 0 },
    ];
    expect(mouseButtonMaskAt(track, 0)).toBe(0);
    expect(mouseButtonMaskAt(track, 700)).toBe(2);
    expect(mouseButtonMaskAt(track, 900)).toBe(0);
    expect(mouseButtonMaskAt(track, 5_000)).toBe(0);
  });
});

describe('ReplayRecorder live tick timeline', () => {
  afterEach(() => vi.restoreAllMocks());

  function liveFrame(recorder: ReplayRecorder, tick: number, ranAtMs: number, speedMultiplier = 1): void {
    recorder.recordFrame(tick, START, makeState(tick), [], {
      recordedAtMs: ranAtMs,
      liveTick: { ranAtMs, speedMultiplier },
    });
  }

  function liveRun(): ReplayRecorder {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);
    recorder.anchorLiveClock(1000, 1);
    return recorder;
  }

  const clickTimes = (recorder: ReplayRecorder) => recorder.getCursorTrack().clicks.map(({ tMs }) => tMs);

  it('starts each frame when its tick actually ran, so a late tick leaves the frame before it long', () => {
    const recorder = liveRun();
    liveFrame(recorder, 1, 1600);
    liveFrame(recorder, 2, 2300);
    liveFrame(recorder, 3, 2900);

    expect(recorder.getDisplayFrames().map((frame) => frame.startMs)).toEqual([0, 600, 1300, 1900]);
  });

  it('stamps events past 599 ms into a late tick, continuously and in order across its frame', () => {
    const recorder = liveRun();
    liveFrame(recorder, 1, 1600);
    recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 2150);
    recorder.recordCursorClick(2, 1, 'ui', 1, CURSOR_FRAME, 2250);
    recorder.recordModifierSample(1, 2260, 1);
    liveFrame(recorder, 2, 2300);
    recorder.recordCursorClick(3, 1, 'ui', 1, CURSOR_FRAME, 2310);
    recorder.recordModifierSample(1, 2320, 0);

    expect(clickTimes(recorder)).toEqual([1150, 1250, 1310]);
    expect(recorder.getModifierTrack().map(({ tMs }) => tMs)).toEqual([1260, 1320]);
    expect(recorder.getDisplayFrames()[2]?.startMs).toBe(1300);
  });

  it('keeps the true time of a late-delivered event, but never before the tick it arrived in', () => {
    const recorder = liveRun();
    liveFrame(recorder, 1, 1600);
    recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 1700);
    recorder.recordCursorClick(2, 1, 'ui', 1, CURSOR_FRAME, 1650);
    liveFrame(recorder, 2, 2200);
    recorder.recordModifierSample(1, 2300, 1);
    recorder.recordCursorClick(3, 1, 'ui', 1, CURSOR_FRAME, 2100);

    expect(clickTimes(recorder)).toEqual([700, 700, 1300]);
  });

  it('excludes suspended time from frame starts and event times', () => {
    const clock = new BackgroundClock();
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000);
    const recorder = new ReplayRecorder({}, clock);
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);
    recorder.anchorLiveClock(1000, 1);
    now.mockReturnValue(1300);
    clock.setSuspended(true);
    now.mockReturnValue(61_300);
    clock.setSuspended(false);
    recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 61_400);
    liveFrame(recorder, 1, clock.now(61_600));

    expect(clickTimes(recorder)).toEqual([400]);
    expect(recorder.getDisplayFrames()[1]?.startMs).toBe(600);
  });

  it('measures ticks in game time at the speed they ran, and stays continuous across a re-anchor', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);
    recorder.anchorLiveClock(1000, 2);
    liveFrame(recorder, 1, 1300, 2);
    recorder.releaseLiveClock(1450);
    recorder.anchorLiveClock(1450, 0.5);
    recorder.recordCursorClick(1, 1, 'ui', 0.5, CURSOR_FRAME, 1650);
    liveFrame(recorder, 2, 2050, 0.5);

    // 300 ms at 2x, then 150 ms at 2x and 600 ms at 0.5x: one 600 ms tick each in game time.
    expect(recorder.getDisplayFrames().map((frame) => frame.startMs)).toEqual([0, 600, 1200]);
    expect(clickTimes(recorder)).toEqual([1000]);
  });

  it('holds an opening frame recorded before the loop at its tick end, then runs on without jumping back', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);
    recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 6000);

    recorder.anchorLiveClock(6000, 1);
    recorder.recordCursorClick(2, 1, 'ui', 1, CURSOR_FRAME, 6100);
    liveFrame(recorder, 1, 6600);
    recorder.recordCursorClick(3, 1, 'ui', 1, CURSOR_FRAME, 6650);

    expect(clickTimes(recorder)).toEqual([599, 699, 1249]);
    expect(recorder.getDisplayFrames()[1]?.startMs).toBe(1199);
  });

  it('holds a released frame where it stood, and starts the next stepped frame after it', () => {
    const recorder = liveRun();
    liveFrame(recorder, 1, 1600);
    recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 2300);
    recorder.releaseLiveClock(2300);
    recorder.recordCursorClick(2, 1, 'ui', 1, CURSOR_FRAME, 9000);
    seedFrame(recorder, 2, 9100);
    seedFrame(recorder, 3, 9200);

    expect(clickTimes(recorder)).toEqual([1300, 1300]);
    expect(recorder.getDisplayFrames().map((frame) => frame.startMs)).toEqual([0, 600, 1300, 1900]);
  });

  it('leaves out the time a tick was frozen when the loop picks it up again', () => {
    const recorder = liveRun();
    liveFrame(recorder, 1, 1600);
    recorder.releaseLiveClock(1900);
    recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 5000);
    recorder.anchorLiveClock(5000, 1);
    recorder.recordCursorClick(2, 1, 'ui', 1, CURSOR_FRAME, 5100);
    liveFrame(recorder, 2, 5400);

    expect(clickTimes(recorder)).toEqual([900, 1000]);
    expect(recorder.getDisplayFrames().map((frame) => frame.startMs)).toEqual([0, 600, 1300]);
  });

  it('keeps frames stepped outside the loop on the 600 ms grid, held at the tick end', () => {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    seedFrame(recorder, 0, 1000);
    seedFrame(recorder, 1, 5000);
    recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 9000);

    expect(recorder.getDisplayFrames().map((frame) => frame.startMs)).toEqual([0, 600]);
    expect(clickTimes(recorder)).toEqual([1199]);
  });

  describe("with idleClock: 'held'", () => {
    const heldRun = () => {
      const recorder = new ReplayRecorder({}, undefined, { idleClock: 'held' });
      recorder.startRun(makeRunConfig());
      seedFrame(recorder, 0, 1000);
      return recorder;
    };

    it('holds every track at the opening frame until the live loop anchors it', () => {
      const recorder = heldRun();
      recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 9000);
      recorder.recordModifierSample(1, 9100, 1);
      recorder.recordMenuState(1, 9200, null);
      recorder.recordViewportSample(1, 9300, {
        kind: 'orbit3d',
        pitchDeg: 30,
        yawDeg: 90,
        fovScale: 1,
        target: { x: 0, y: 0, z: 0 },
      });

      expect(clickTimes(recorder)).toEqual([0]);
      expect(recorder.getModifierTrack().map(({ tMs }) => tMs)).toEqual([0]);
      expect(recorder.getViewportTrack().samples.map(({ tMs }) => tMs)).toEqual([0]);
      recorder.anchorLiveClock(60_000, 1);
      liveFrame(recorder, 1, 60_600);
      expect(recorder.getDisplayFrames().map((frame) => frame.startMs)).toEqual([0, 600]);
    });

    it('steps frames on the 600 ms grid, holds idle events at the newest step in order, and resumes live from it', () => {
      const recorder = heldRun();
      seedFrame(recorder, 1, 5000);
      recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 9000);
      recorder.recordCursorClick(2, 1, 'ui', 1, CURSOR_FRAME, 30_000);
      seedFrame(recorder, 2, 40_000);
      recorder.recordCursorClick(3, 1, 'ui', 1, CURSOR_FRAME, 50_000);

      expect(clickTimes(recorder)).toEqual([600, 600, 1200]);
      recorder.anchorLiveClock(60_000, 1);
      recorder.recordCursorClick(4, 1, 'ui', 1, CURSOR_FRAME, 60_250);
      liveFrame(recorder, 3, 60_600);
      expect(clickTimes(recorder)).toEqual([600, 600, 1200, 1450]);
      expect(recorder.getDisplayFrames().map((frame) => frame.startMs)).toEqual([0, 600, 1200, 1800]);
    });

    it('holds a released tick where the loop froze it', () => {
      const recorder = heldRun();
      recorder.anchorLiveClock(1000, 1);
      liveFrame(recorder, 1, 1600);
      recorder.releaseLiveClock(1900);
      recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 50_000);
      recorder.anchorLiveClock(60_000, 1);
      liveFrame(recorder, 2, 60_300);

      expect(clickTimes(recorder)).toEqual([900]);
      expect(recorder.getDisplayFrames().map((frame) => frame.startMs)).toEqual([0, 600, 1200]);
    });
  });

  it('forks at the retained frame start and continues the timeline from there', () => {
    const recorder = liveRun();
    liveFrame(recorder, 1, 1600);
    liveFrame(recorder, 2, 2300);
    recorder.recordCursorClick(1, 1, 'ui', 1, CURSOR_FRAME, 2400);
    liveFrame(recorder, 3, 2900);

    recorder.forkAt(2, 10_000);
    recorder.anchorLiveClock(10_000, 1);
    recorder.recordCursorClick(2, 1, 'ui', 1, CURSOR_FRAME, 10_100);
    liveFrame(recorder, 3, 10_600);

    expect(recorder.getDisplayFrames().map((frame) => frame.startMs)).toEqual([0, 600, 1300, 1900]);
    expect(clickTimes(recorder)).toEqual([1400]);
    expect(recorder.exportData().frames.every((frame) => frame.timing === undefined)).toBe(true);
  });

  it('keeps timing only for a tick more than 50 ms late, clamped to the format bound', () => {
    const recorder = liveRun();
    liveFrame(recorder, 1, 1600);
    recorder.recordFrameTiming({ lateByMs: 50, rafGapMs: 400, tickWorkMs: 300 });
    liveFrame(recorder, 2, 2300);
    // Over the threshold as measured, even though it is stored rounded down to it.
    recorder.recordFrameTiming({ lateByMs: 50.3, tickWorkMs: Number.NaN });
    liveFrame(recorder, 3, 2900 + MAX_REPLAY_FRAME_TIMING_MS);
    recorder.recordFrameTiming({ lateByMs: MAX_REPLAY_FRAME_TIMING_MS * 2, rafGapMs: -5 });

    expect(recorder.getDisplayFrames().map((frame) => frame.timing)).toEqual([
      undefined,
      undefined,
      { lateByMs: 50 },
      { lateByMs: MAX_REPLAY_FRAME_TIMING_MS, rafGapMs: 0 },
    ]);
  });
});

describe('ReplayRecorder forkAt', () => {
  const TICK_MS = 600;

  function recorderWithRun(frameCount: number): ReplayRecorder {
    const recorder = new ReplayRecorder();
    recorder.startRun(makeRunConfig());
    recorder.recordFrame(0, START, makeState(0), [], 0);
    for (let tick = 1; tick < frameCount; tick++) {
      seedFrame(recorder, tick, tick * TICK_MS);
    }
    return recorder;
  }

  it('keeps the prefix through the fork point and drops the future', () => {
    const recorder = recorderWithRun(10);

    recorder.forkAt(4, 4 * TICK_MS);

    // Then: the branch is rooted at the ORIGINAL frame zero, which is what a later
    // reconstruction replays from.
    expect(recorder.getFrameCount()).toBe(5);
    expect(recorder.getFrame(0)?.tick).toBe(0);
    expect(recorder.getFrame(4)?.tick).toBe(4);
    expect(recorder.getFrame(5)).toBeUndefined();
  });

  it('keeps the run config, so the forked branch is still reconstructable', () => {
    const recorder = recorderWithRun(6);

    recorder.forkAt(2, 2 * TICK_MS);

    expect(recorder.getRunConfig()?.encounter.kind).toBe('yama_p3');
  });

  it('truncates the time tracks at the fork boundary', () => {
    const recorder = recorderWithRun(6);
    recorder.recordCursorSample(150, 80, 1, FRAME, 1 * TICK_MS + 100);
    recorder.recordCursorSample(160, 90, 1, FRAME, 5 * TICK_MS + 100);

    recorder.forkAt(2, 2 * TICK_MS);

    // Then: nothing beyond the boundary survives to be replayed against a branch that
    // never happened.
    const boundaryMs = 2 * TICK_MS;
    expect(recorder.getCursorTrack().samples.every((sample) => sample.tMs <= boundaryMs)).toBe(true);
    expect(recorder.getViewportTrack().samples.every((sample) => sample.tMs <= boundaryMs)).toBe(true);
  });

  it('keeps recording forward from the boundary without breaking ascending time', () => {
    const recorder = recorderWithRun(6);
    recorder.forkAt(2, 2 * TICK_MS);

    recorder.recordFrame(3, START, makeState(3), [], 2 * TICK_MS + 120);
    recorder.recordCursorSample(150, 80, 1, FRAME, 2 * TICK_MS + 200);

    // Then: the replay schema requires every track to ascend by tMs, and a branch that rebased
    // to zero would sit behind its own retained prefix.
    const samples = recorder.getCursorTrack().samples;
    expect(recorder.getFrameCount()).toBe(4);
    expect(samples.every((sample, i) => i === 0 || sample.tMs >= (samples[i - 1]?.tMs ?? 0))).toBe(true);
  });

  it('ignores a fork point outside the recording', () => {
    const recorder = recorderWithRun(3);

    recorder.forkAt(99, 0);

    expect(recorder.getFrameCount()).toBe(3);
  });
});

describe('ReplayRecorder finalizeUnadvancedStart', () => {
  const MOVED: Coordinate = [27, 41];
  const OVERLAYS: ReplayOverlays = {
    tileMarkers: [],
    lineMarkers: [],
    showTileMarkers: true,
    showTileMarkerLabels: true,
    showLineMarkers: true,
    showLineMarkerLabels: true,
    lineMarkerWidth: 1,
  };
  const CAMERA_AT_GO: ReplayViewportState = { ...VIEWPORT_STATE, target: { x: 27.5, y: 41.5, z: 0.9 } };

  function bootstrapped(): EngineRunConfig {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(undefined, 1234), startPos: START });
    return engine.getRunConfig();
  }

  /** A fresh run's opening, with the countdown's capture and inputs on top of it. */
  function openingWithCountdown(runConfig = bootstrapped()) {
    const recorder = new ReplayRecorder({}, new BackgroundClock(), { idleClock: 'held' });
    recorder.startRun(runConfig, OVERLAYS);
    recorder.recordFrame(0, START, { ...makeState(0), introActive: true, playerFacingAngle: 512 }, [], {
      viewportState: VIEWPORT_STATE,
      recordedAtMs: 0,
    });
    recorder.recordCursorSample(150, 80, 1, FRAME, 100);
    recorder.recordCursorClick(160, 90, 'yellow', 1, FRAME, 200);
    recorder.recordViewportSample(1, 300, CAMERA_AT_GO);
    recorder.recordModifierSample(1, 300, 1);
    recorder.recordAction({ type: 'ctrlClick', ctrlKey: false });
    recorder.recordAction({ type: 'attackTarget', targetId: null });
    return recorder;
  }

  it('moves only the opening: bootstrap start, frame 0 tile, target and stationary locomotion, intro completed', () => {
    const runConfig = bootstrapped();
    const recorder = openingWithCountdown(runConfig);
    const before = structuredClone(recorder.getFrame(0));

    expect(
      recorder.finalizeUnadvancedStart({ position: MOVED, facingAngle: 1024, viewportState: CAMERA_AT_GO }, 500),
    ).toBe(true);

    expect(recorder.getRunConfig()).toEqual({
      ...runConfig,
      bootstrap: { ...runConfig.bootstrap, startPosition: MOVED },
    });
    expect(recorder.getFrameCount()).toBe(1);
    const frame = recorder.getFrame(0);
    expect(frame).toEqual({
      ...before,
      input: MOVED,
      viewportState: CAMERA_AT_GO,
      state: {
        ...before?.state,
        playerPosition: MOVED,
        playerPreviousPosition: MOVED,
        playerMovementPath: [],
        playerFacingAngle: 1024,
        playerIsMoving: false,
        playerIsRunning: false,
        introActive: false,
      },
    });
  });

  it("drops the countdown's ancillary capture, keeps the run-start overlays, and restarts from GO", () => {
    const recorder = openingWithCountdown();
    recorder.finalizeUnadvancedStart({ position: MOVED, facingAngle: 1024, viewportState: CAMERA_AT_GO }, 500);

    expect(recorder.getCursorTrack().samples).toEqual([]);
    expect(recorder.getCursorTrack().clicks).toEqual([]);
    expect(recorder.getModifierTrack()).toEqual([]);
    expect(recorder.getMenuTrack()).toEqual([]);
    expect(recorder.getViewportTrack().samples).toEqual([{ tMs: 0, viewportState: CAMERA_AT_GO }]);
    expect(recorder.getOverlays()).toEqual(OVERLAYS);
    expect(recorder.getCapture().overlays.provenance).toBe('bounded-v1');
    expect(recorder.getStats().counts).toMatchObject({
      cursorSamples: 0,
      cursorClicks: 0,
      viewportSamples: 1,
      overlays: 1,
    });
    // Held at frame 0's start until the live loop picks it up at GO.
    recorder.recordCursorSample(150, 80, 1, FRAME, 900);
    expect(recorder.getCursorTrack().samples.map((sample) => sample.tMs)).toEqual([0]);
  });

  it('keeps the countdown inputs pending for frame 1, never on frame 0', () => {
    const recorder = openingWithCountdown();
    recorder.finalizeUnadvancedStart({ position: MOVED, facingAngle: 1024 }, 500);
    recorder.recordFrame(1, MOVED, { ...makeState(1), playerPosition: MOVED }, [], 600);

    expect(recorder.getFrame(0)?.actions).toEqual([]);
    expect(recorder.getFrame(1)?.actions).toEqual([
      { type: 'ctrlClick', ctrlKey: false },
      { type: 'attackTarget', targetId: null },
    ]);
  });

  it('refuses once the opening is no longer an unadvanced fresh start', () => {
    const position = { position: MOVED, facingAngle: 1024 };
    const finalized = openingWithCountdown();
    expect(finalized.finalizeUnadvancedStart(position)).toBe(true);
    expect(finalized.finalizeUnadvancedStart(position)).toBe(false);

    const advanced = openingWithCountdown();
    advanced.recordFrame(1, START, makeState(1), [], 600);
    expect(advanced.finalizeUnadvancedStart(position)).toBe(false);

    const forked = openingWithCountdown();
    forked.forkAt(0, 0);
    expect(forked.finalizeUnadvancedStart(position)).toBe(false);

    const loaded = new ReplayRecorder();
    loaded.load(openingWithCountdown().exportData());
    expect(loaded.finalizeUnadvancedStart(position)).toBe(false);

    const withRunConfig = openingWithCountdown(makeRunConfig());
    expect(withRunConfig.finalizeUnadvancedStart(position)).toBe(false);

    for (const recorder of [advanced, forked, loaded, withRunConfig]) {
      expect(recorder.getFrame(0)?.state.playerPosition).toEqual(START);
    }
  });
});

/**
 * The intake of recordings in the old encounter visual-event shapes (`inferno_visual`,
 * `colosseum_visual`): every batch keeps its identity, tick and frame, Yama's semantic events are
 * untouched, and the caller's data is never rewritten.
 */
describe('ReplayRecorder legacy encounter recordings', () => {
  const identities = (frames: readonly { readonly events: readonly GameEvent[] }[]) =>
    frames.map(({ events }) => events.map(({ eventId, tick }) => [eventId, tick]));

  it.each([
    ['Inferno', legacyInfernoRecording],
    ['Sol Heredit', legacySolRecording],
    ['Yama', legacyYamaRecording],
  ] as const)('publishes every %s batch on its own frame with its id and tick', (_, record) => {
    const { data, frames } = record();
    const written = structuredClone(data.frames.map(({ events }) => events));

    expect(frames).toHaveLength(data.frames.length);
    expect(frames.map(({ state }) => state.currentTick)).toEqual(data.frames.map(({ tick }) => tick));
    expect(identities(frames)).toEqual(identities(data.frames));
    expect(data.frames.map(({ events }) => events)).toEqual(written);
  });

  it('publishes the old inferno_visual and colosseum_visual batches where they were written', () => {
    expect(identities(legacyInfernoRecording().frames).flat()).toEqual([
      [LEGACY_INFERNO_EVENTS.delayedClip.eventId, 1],
      [LEGACY_INFERNO_EVENTS.zukRise.eventId, 2],
      [LEGACY_INFERNO_EVENTS.barrage.eventId, 2],
      [LEGACY_INFERNO_EVENTS.clearMinions.eventId, 8],
    ]);
    expect(identities(legacySolRecording().frames).flat()).toEqual([
      [LEGACY_SOL_EVENTS.telegraph.eventId, 1],
      [LEGACY_SOL_EVENTS.attached.eventId, 2],
      [LEGACY_SOL_EVENTS.beams.eventId, 3],
    ]);
  });

  // Read-time conversion may change what `exportData` writes, but a second load must change nothing.
  it.each([
    ['Inferno', legacyInfernoRecording],
    ['Sol Heredit', legacySolRecording],
    ['Yama', legacyYamaRecording],
  ] as const)('publishes the same %s frames when its loaded recording is exported and loaded again', (_, record) => {
    const first = new ReplayRecorder();
    first.load(record().data);
    const exported = first.exportData();
    const again = new ReplayRecorder();
    again.load(structuredClone(exported));

    expect(again.getDisplayFrames()).toEqual(first.getDisplayFrames());
    expect(again.exportData().frames).toEqual(exported.frames);
  });

  it("leaves Yama's semantic events and attack snapshot exactly as recorded", () => {
    const { frames } = legacyYamaRecording();

    expect(frames[LEGACY_YAMA.magicTick]?.events).toEqual([LEGACY_YAMA_EVENTS.magic, LEGACY_YAMA_EVENTS.fireballs]);
    expect(frames[LEGACY_YAMA.magicTick + 1]?.events).toEqual([LEGACY_YAMA_EVENTS.wave]);
    const melee = frames[LEGACY_YAMA.meleeTick]?.state.encounter;
    if (!melee || !isYamaSnapshot(melee)) expect.fail('Expected a Yama snapshot');
    expect([melee.state.lastAttackTick, melee.state.lastAttackKind]).toEqual([LEGACY_YAMA.meleeTick, 'melee_crush']);
  });
});

describe('ReplayRecorder reading older encounter event shapes', () => {
  it('reads each inferno_visual batch as the same encounter_visual batch, and a type clear as a presentation removal', () => {
    const { data, frames } = legacyInfernoRecording();
    const renamed: Record<string, string> = {
      inferno_visual: 'encounter_visual',
      inferno_clear_minions: 'actor_presentations_removed',
    };

    // Frame by frame and in order: ids, ticks, ordinals, delays and heights all as written.
    expect(frames.map(({ events }) => events)).toEqual(
      data.frames.map(({ events }) => events.map((event) => ({ ...event, type: renamed[event.type] }))),
    );
    const read = frames.flatMap(({ events }) => events);
    expect(read.filter(isEncounterVisualEvent).map(({ eventId }) => eventId)).toEqual([
      LEGACY_INFERNO_EVENTS.delayedClip.eventId,
      LEGACY_INFERNO_EVENTS.zukRise.eventId,
      LEGACY_INFERNO_EVENTS.barrage.eventId,
    ]);
    expect(read.filter(isActorPresentationsRemovedEvent)).toEqual([
      { type: 'actor_presentations_removed', eventId: 81, tick: 8, npcTypeIds: [7701] },
    ]);
  });

  it('reads each colosseum_visual batch as an encounter_visual batch, anchoring each graphic as written', () => {
    const { frames } = legacySolRecording();
    const read = frames.flatMap(({ events }) => events);
    const tile = (position: readonly [number, number]) => ({ kind: 'tile', position });
    const attached = (actorId: string) => ({ kind: 'attached', actorId });

    expect(read).toEqual([
      {
        ...LEGACY_SOL_EVENTS.telegraph,
        type: 'encounter_visual',
        projectiles: [],
        graphics: [
          { spotAnimId: 2698, target: tile([28, 30]), delayCycles: 0, height: 0 },
          { spotAnimId: 2698, target: tile([29, 30]), delayCycles: 2, height: 0 },
          { spotAnimId: 2698, target: tile([30, 30]), delayCycles: 4, height: 0 },
        ],
      },
      {
        ...LEGACY_SOL_EVENTS.attached,
        type: 'encounter_visual',
        graphics: [
          { spotAnimId: 2668, target: attached('sol_heredit'), delayCycles: 6, height: 64 },
          { spotAnimId: 2667, target: attached('absent'), delayCycles: 6, height: 0 },
          { spotAnimId: 131, target: attached('player'), delayCycles: 30, height: 124 },
        ],
      },
      {
        ...LEGACY_SOL_EVENTS.beams,
        type: 'encounter_visual',
        projectiles: [],
        graphics: LEGACY_SOL_EVENTS.beams.graphics.map(({ spotAnimId, position, delayCycles, height }) => ({
          spotAnimId,
          target: tile(position),
          delayCycles,
          height,
        })),
      },
    ]);
    expect(read.every(isEncounterVisualEvent)).toBe(true);
  });

  it('passes events of every other shape through as written', () => {
    const { data, frames } = legacyYamaRecording();
    expect(frames.map(({ events }) => events)).toEqual(data.frames.map(({ events }) => events));
  });

  it.each([
    [
      'inferno_visual graphic without a height',
      (event: GameEvent): GameEvent =>
        event.type === 'inferno_visual' && Array.isArray(event.graphics) && event.graphics.length > 0
          ? { ...event, graphics: [{ ...event.graphics[0], height: undefined }] }
          : event,
    ],
    [
      'inferno_visual flight that lands before it launches',
      (event: GameEvent): GameEvent =>
        event.type === 'inferno_visual' && Array.isArray(event.projectiles) && event.projectiles.length > 0
          ? { ...event, projectiles: [{ ...event.projectiles[0], startDelayCycles: 80 }] }
          : event,
    ],
    [
      'inferno_clear_minions with a non-integer type',
      (event: GameEvent): GameEvent =>
        event.type === 'inferno_clear_minions' ? { ...event, npcTypeIds: [7701, '7702'] } : event,
    ],
    [
      'colosseum_visual graphic with both a tile and an actor',
      (event: GameEvent): GameEvent =>
        event.type === 'colosseum_visual' &&
        event.eventId === LEGACY_SOL_EVENTS.attached.eventId &&
        Array.isArray(event.graphics)
          ? { ...event, graphics: [{ ...event.graphics[0], position: [30, 30] }] }
          : event,
    ],
    [
      'colosseum_visual graphic with neither a tile nor an actor',
      (event: GameEvent): GameEvent =>
        event.type === 'colosseum_visual' && event.eventId === LEGACY_SOL_EVENTS.telegraph.eventId
          ? { ...event, graphics: [{ spotAnimId: 2698, delayCycles: 0 }] }
          : event,
    ],
    [
      'colosseum_visual graphic attached to an empty actor id',
      (event: GameEvent): GameEvent =>
        event.type === 'colosseum_visual' &&
        event.eventId === LEGACY_SOL_EVENTS.attached.eventId &&
        Array.isArray(event.graphics)
          ? { ...event, graphics: [{ spotAnimId: 2668, actorId: '', delayCycles: 6 }] }
          : event,
    ],
    [
      'colosseum_visual flight that lands before it launches',
      (event: GameEvent): GameEvent =>
        event.type === 'colosseum_visual' &&
        event.eventId === LEGACY_SOL_EVENTS.attached.eventId &&
        Array.isArray(event.graphics)
          ? { ...event, projectiles: [{ ...LEGACY_SOL_EVENTS.attached.projectiles[0], startDelayCycles: 80 }] }
          : event,
    ],
  ] as const)('refuses a recording with a malformed %s, installing none of it', (label, corrupt) => {
    const recorder = new ReplayRecorder();
    recorder.load(legacyYamaRecording().data);
    const installed = recorder.getDisplayFrames();
    const { data } = label.startsWith('colosseum_visual') ? legacySolRecording() : legacyInfernoRecording();
    const malformed = {
      ...data,
      frames: data.frames.map((frame) => ({
        ...frame,
        events: frame.events.map(corrupt),
      })),
    };
    const written = structuredClone(malformed);

    expect(() => recorder.load(malformed)).toThrow(LegacyReplayEventError);
    expect(recorder.getDisplayFrames()).toEqual(installed);
    expect(malformed).toEqual(written);
  });
});
