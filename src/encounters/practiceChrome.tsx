/**
 * The presentation-side encounter chrome: the setup controls an encounter draws itself, the
 * session bar its run offers, the infobox tile its run publishes, and the chapters its replays
 * are navigated by.
 *
 * Kept apart from {@link ./presentationModules} on purpose. That manifest reaches the render
 * layer, and these are read by settings panels, the infobox selector and the replay hook, which
 * must not pull scene builders in behind them. Lookups resolve a variant to the kind that owns it, as the
 * other per-encounter manifests do.
 */
import type React from 'react';
import type { PlayInterfaceSound } from '../audio/interfaceSounds';
import type { InfoBoxData } from '../components/InfoBox/infoboxTypes';
import type { LauncherGlyph } from '../components/launcher/launcherIcons';
import type { EncounterCommand } from '../core/encounters/commands';
import type { EncounterModifierSelection } from '../core/encounters/encounterFactory';
import { type EncounterSnapshot, isSolHereditSnapshot } from '../core/encounters/snapshot';
import type { ReplayDisplayFrame } from '../core/ReplayRecorder';
import type { ReplayChapterSet } from '../core/replayTimeline';
import type { OsmFrame } from '../layout/osmFrame';
import type { Rect } from '../layout/osrsClientLayout';
import type { PracticeSessionState } from '../types/practiceSession';
import type { MechanicsConfig } from '../types/simulation';
import { baseEncounterKind } from './catalog';
import { ColosseumIntermission } from './colosseum/ColosseumIntermission';
import { ColosseumLayoutTool } from './colosseum/ColosseumLayoutTool';
import { COLOSSEUM_SETUP_KEYS, ColosseumSetup, colosseumSetupSummary } from './colosseum/ColosseumSetup';
import { intermissionScenePlacement, intermissionSheetPlacement } from './colosseum/intermissionPlacement';
import { colosseumCurrentSetup, colosseumRunStartedWith, colosseumWaveInfobox } from './colosseum/runChrome';
import { colosseumModifierHeading, colosseumModifierResetLabel } from './colosseum/setupModifiers';
import { colosseumRunState } from './colosseum/waves/snapshot';
import { SOL_WAVE } from './colosseum/waves/waveTable';
import { INFERNO_KIND, ZUK_WAVE } from './inferno/constants';
import { InfernoLayoutTool } from './inferno/InfernoLayoutTool';
import { INFERNO_SETUP_KEYS, InfernoSetup, infernoSetupSummary } from './inferno/InfernoSetup';
import {
  infernoCurrentSetup,
  infernoCurrentWave,
  infernoRunStartedWith,
  infernoSession,
  infernoWaveInfobox,
} from './inferno/practiceChrome';
import { infernoWaveChapters } from './inferno/replayChapters';

/**
 * The run a setup control can act on, where one is live.
 *
 * `stage` is the encounter's own number for where the run has got to (Inferno's wave). It is a
 * primitive rather than the snapshot on purpose: the Mobile tool window keeps its Practice pane
 * mounted and skips re-rendering it while its props hold identity, and a snapshot changes every
 * tick. `execute` is the app's ordinary command route, so applying the setup takes exactly the
 * path the Actions list and the session bar take.
 */
export interface EncounterSetupRun {
  readonly stage: number;
  /**
   * An opaque key for the setup this run was STARTED with. The control builds the same key from
   * the saved setup, and a difference is a choice the running fight cannot take without
   * restarting. Published by the run rather than remembered by the control, so a pane that is
   * closed and reopened still knows there is something to apply.
   */
  readonly startedWith: string;
  readonly execute: (command: EncounterCommand) => void;
  /**
   * Encounter-owned configuration reproducing the current stage. Absent before it spawns. Only the
   * encounter tool's run (`useEncounterTool`) carries it; Practice setup controls never read it.
   */
  readonly currentSetup?: Partial<MechanicsConfig>;
}

/** A focused encounter editor, launched from desktop chrome or one mobile Tools entry. */
export interface EncounterToolProps {
  readonly config: MechanicsConfig;
  readonly onChange: (config: MechanicsConfig) => void;
  readonly run?: EncounterSetupRun;
  readonly onClose: () => void;
  /** Selected loadout, not depleted in-fight supplies. Exported only when the player chooses to include gear in a setup link. */
  readonly exportGear?: () => string;
}

export interface EncounterTool {
  readonly label: string;
  readonly icon: LauncherGlyph;
  /**
   * Whether this run offers the tool at all, read from its snapshot; absent, every run does. A run
   * that can never use it (a Colosseum run started on Sol) leaves its launcher out of the row.
   */
  readonly offered?: (snapshot: EncounterSnapshot) => boolean;
  /** Why the offered tool cannot open now (a fixed wave), shown on its disabled launcher. */
  readonly disabledReason: (run: EncounterSetupRun | undefined) => string | undefined;
  readonly render: (props: EncounterToolProps) => React.ReactNode;
}

const ENCOUNTER_TOOLS: Readonly<Record<string, EncounterTool>> = {
  [INFERNO_KIND]: {
    label: 'Edit layout',
    icon: 'layout',
    disabledReason: (run) => (run?.stage === ZUK_WAVE ? 'Wave 69 has a fixed layout.' : undefined),
    render: (props) => <InfernoLayoutTool {...props} />,
  },
  // The same tool and rules as the Inferno's, for the start wave's layout. Sol's arena is fixed: a
  // wave run reaching him disables it, as wave 69 does, and a direct Sol start never offers it.
  sol_heredit: {
    label: 'Edit layout',
    icon: 'layout',
    offered: (snapshot) => isSolHereditSnapshot(snapshot) && colosseumRunState(snapshot.state).startWave < SOL_WAVE,
    disabledReason: (run) => (run?.stage === SOL_WAVE ? `Wave ${SOL_WAVE} has a fixed layout.` : undefined),
    render: (props) => <ColosseumLayoutTool {...props} />,
  },
};

/** The tool the run's encounter offers it, where it has one (`EncounterTool.offered`). */
export function encounterToolFor(snapshot: EncounterSnapshot): EncounterTool | undefined {
  const tool = ENCOUNTER_TOOLS[baseEncounterKind(snapshot.kind)];
  return tool && (tool.offered?.(snapshot) ?? true) ? tool : undefined;
}

export interface EncounterSetupControlsProps {
  readonly config: MechanicsConfig;
  readonly onChange: (config: MechanicsConfig) => void;
  /** `rail` is the pre-fight encounter card; `practice` is the in-fight pane and mobile window. */
  readonly surface: 'rail' | 'practice';
  /** Absent before the fight, where Start Encounter is what applies the setup. */
  readonly run?: EncounterSetupRun;
  /** Selected loadout, not depleted in-fight supplies. Exported only when the player chooses to include gear in a setup link. */
  readonly exportGear?: () => string;
  /** Configurer footer destination for encounter-owned transfer actions. */
  readonly actionFooter?: HTMLElement | null;
}

export interface EncounterSetupControls {
  /**
   * The mechanics keys this control draws. The generic settings list drops its own rows for them,
   * so a key is never offered twice.
   */
  readonly keys: readonly string[];
  /**
   * The name of the rail section the pre-fight card draws this control in, after the shared
   * encounter selection and before Preparation. The card places the section and names it for
   * assistive technology; the control draws its own visible label, because its primary value sits
   * on that label's row. No generic code has to know which encounter it is.
   */
  readonly railSection: string;
  /** Practice destination name when its controls differ from the pre-fight rail; defaults to railSection. */
  readonly practiceSection?: string;
  /**
   * The setup about to be committed, in the encounter's own terms ("Wave 35"), for the pre-fight
   * footer's line beside Start. Absent where the encounter's phase metadata already says it.
   */
  readonly summary?: (config: MechanicsConfig, modifiers: EncounterModifierSelection) => string;
  /** Reserve a configurer footer destination only for encounters that use it. */
  readonly hasFooterActions?: boolean;
  readonly render: (props: EncounterSetupControlsProps) => React.ReactNode;
  /** What Practice's Options disclosure holds for this run, replacing the generic summary. */
  readonly optionsSummary?: (props: EncounterSetupControlsProps) => string;
  /**
   * How the configurer names run modifiers whose default follows this setup (a Colosseum start
   * wave's). The default itself is the descriptor's `defaultModifiers`.
   */
  readonly modifierLabels?: EncounterModifierLabels;
}

export interface EncounterModifierLabels {
  /** The configurer's name for the set ("Modifiers going into wave 8"), in place of "Modifiers". */
  readonly heading: (config: MechanicsConfig) => string;
  /** The action that drops the saved set for the setup's default ("Reset to wave 8 default"). */
  readonly resetLabel: (config: MechanicsConfig) => string;
}

const SETUP_CONTROLS: Readonly<Record<string, EncounterSetupControls>> = {
  [INFERNO_KIND]: {
    keys: INFERNO_SETUP_KEYS,
    railSection: 'Wave & arena',
    practiceSection: 'Start wave',
    summary: infernoSetupSummary,
    hasFooterActions: true,
    render: (props) => <InfernoSetup {...props} />,
    optionsSummary: ({ run }) => (run?.stage === ZUK_WAVE ? 'Zuk & aids' : 'Practice aids'),
  },
  sol_heredit: {
    keys: COLOSSEUM_SETUP_KEYS,
    railSection: 'Wave & modifiers',
    practiceSection: 'Start wave',
    summary: colosseumSetupSummary,
    render: (props) => <ColosseumSetup {...props} />,
    // Sol's section shows in Practice only once the run reaches him, as Zuk's does at wave 69.
    optionsSummary: ({ run }) => (run?.stage === SOL_WAVE ? 'Sol & aids' : 'Practice aids'),
    modifierLabels: { heading: colosseumModifierHeading, resetLabel: colosseumModifierResetLabel },
  },
};

/** The setup control `kind` draws in place of plain toggle rows, where it has one. */
export function encounterSetupControlsForKind(kind: string | undefined): EncounterSetupControls | undefined {
  return kind === undefined ? undefined : SETUP_CONTROLS[baseEncounterKind(kind)];
}

/**
 * How far the run has got, in the encounter's own terms, or null where it publishes no stage.
 * Hosts memoize their {@link EncounterSetupRun} on it, so it must stay a primitive.
 */
export function encounterSetupStage(snapshot: EncounterSnapshot): number | null {
  if (isSolHereditSnapshot(snapshot)) return colosseumRunState(snapshot.state).wave;
  return infernoCurrentWave(snapshot);
}

/** The run's own {@link EncounterSetupRun.startedWith} key. A primitive, for the same reason. */
export function encounterSetupStartedWith(snapshot: EncounterSnapshot): string {
  if (isSolHereditSnapshot(snapshot)) return colosseumRunStartedWith(snapshot);
  return infernoRunStartedWith(snapshot);
}

/** Hosts memoize this small encounter-owned payload on its serialized value, not snapshot identity. */
export function encounterCurrentSetup(snapshot: EncounterSnapshot): Partial<MechanicsConfig> | undefined {
  return infernoCurrentSetup(snapshot) ?? colosseumCurrentSetup(snapshot);
}

/**
 * The session controls the run offers, or null where the encounter has none. `run` is the app's
 * own command route, so a session restart takes exactly the path the Actions list takes.
 */
export function encounterPracticeSession(
  snapshot: EncounterSnapshot,
  run: (command: EncounterCommand) => void,
): PracticeSessionState | null {
  return infernoSession(snapshot, run);
}

/** The run-state tile an encounter publishes to the infobox strip, or null for most of them. */
export function encounterInfobox(snapshot: EncounterSnapshot): InfoBoxData | null {
  return infernoWaveInfobox(snapshot) ?? colosseumWaveInfobox(snapshot);
}

/**
 * The run's own in-fight prompt, where it has one: the Fortis Colosseum's choice of modifier between
 * waves. `execute` is the app's command route, so the choice is queued and recorded like any other
 * encounter command. Mount it only for a live fight, never over a replay.
 */
export function EncounterRunPrompt({
  snapshot,
  attempt,
  currentTick,
  execute,
  mobileLayout,
  mobileFrame,
  sceneRect,
  playSound,
}: {
  readonly snapshot: EncounterSnapshot;
  /** The live run's identity (`useSimulationWiring.runAttempt`): a restart is a new attempt. */
  readonly attempt: number;
  readonly currentTick: number;
  readonly execute: (command: EncounterCommand) => boolean | undefined;
  readonly mobileLayout?: boolean;
  /** The Mobile layout's gameframe, which places a prompt clear of its native chrome. */
  readonly mobileFrame?: OsmFrame | null;
  /** A desktop's visible scene in window CSS pixels (Grid's), which a prompt centers on. */
  readonly sceneRect?: Rect | null;
  /** The client's interface sounds for the prompt's own presses; live fights only, never a replay. */
  readonly playSound?: PlayInterfaceSound;
}): React.ReactNode {
  if (!isSolHereditSnapshot(snapshot)) return null;
  const run = colosseumRunState(snapshot.state);
  if (run.stage !== 'intermission' || run.offer === null) return null;
  return (
    <ColosseumIntermission
      run={run}
      attempt={attempt}
      currentTick={currentTick}
      execute={execute}
      mobileLayout={mobileLayout}
      sheetPlacement={mobileLayout && mobileFrame ? intermissionSheetPlacement(mobileFrame) : undefined}
      scenePlacement={!mobileLayout && sceneRect ? intermissionScenePlacement(sceneRect) : undefined}
      playSound={playSound}
    />
  );
}

/** Derives the chapters a replay is navigated by from its display frames, in one pass. */
export type EncounterReplayChapters = (frames: readonly ReplayDisplayFrame[]) => ReplayChapterSet | null;

const REPLAY_CHAPTERS: Readonly<Record<string, EncounterReplayChapters>> = {
  [INFERNO_KIND]: infernoWaveChapters,
};

/**
 * The chapters of a replay of `kind` (the recording's own encounter, not the live one), or null
 * where the encounter names none. Frame indices are the display frames' own.
 */
export function encounterReplayChapters(
  kind: string | undefined,
  frames: readonly ReplayDisplayFrame[],
): ReplayChapterSet | null {
  const derive = kind === undefined ? undefined : REPLAY_CHAPTERS[baseEncounterKind(kind)];
  return derive ? derive(frames) : null;
}
