/**
 * The presentation-side encounter manifest: what the renderer and UI need beyond an encounter's
 * render config. A row is optional: an encounter without one gets the common scene, the default
 * camera and no encounter-specific event rules (core events and frame-embedded sounds need no row).
 *
 * Sibling of {@link ./modules}, which carries the simulation side. The split exists because
 * the core manifest reaches node-environment consumers through the composition root
 * ({@link ./registry}), and everything below reaches into the render layer — so it lives here
 * instead.
 *
 * Variant kinds are expanded from the core manifest, so Yama's contracts inherit this
 * entry's scene builder, camera, and audio without being listed again. Render configs are
 * registered in `ENCOUNTER_RENDER_CONFIGS`, not here.
 *
 */
import { dukePracticeAudioRules } from '../audio/dukePracticeAudio';
import type { SoundRules } from '../audio/EventAudioPlayer';
import { solHereditAudioRules } from '../audio/solHereditAudioRules';
import { yamaAudioRules } from '../audio/yamaAudioRules';
import { zukAudioRules } from '../audio/zukAudioRules';
import { SOL_NPC_ID } from '../npcs/colosseum/constants';
import { ZUK_NPC_ID, ZUK_SEQS } from '../npcs/inferno/constants';
import type { BossPortraitConfig } from '../render/preview/bossPortraitFraming';
import { OSRS_DEFAULT_PITCH } from '../render/projections/Projection3D';
import {
  createDukePracticeSceneBuilder,
  DUKE_ASLEEP_MENU_TYPE,
  LEGACY_DUKE_MENU_TYPE,
} from '../render/scene/dukePracticeSceneBuilder';
import { createLobbySceneBuilder } from '../render/scene/lobbySceneBuilder';
import type { SceneBuilderFactory } from '../render/scene/sceneBuilderFactory';
import { createSolHereditSceneBuilder } from '../render/scene/solHereditSceneBuilder';
import { createYamaSceneBuilder } from '../render/scene/yamaSceneBuilder';
import { createZukSceneBuilder } from '../render/scene/zukSceneBuilder';
import type { NpcType } from '../rs/config/npctype/NpcType';
import { YAMA_NPC_ID } from '../rs/model/NpcModelLoader';
import type { Coordinate, MechanicsConfig } from '../types/simulation';
import { DUKE_PRACTICE_KIND } from './dukePractice/controls';
import { FIRST_INFERNO_WAVE, INFERNO_PRACTICE_START_TILE, WAVE_67_JAD_TILE, ZUK_WAVE } from './inferno/constants';
import { INFERNO_START_WAVE_KEY } from './inferno/controls';
import { ENCOUNTER_CORE_MODULES, encounterKindsOf } from './modules';

/** Orbit camera the scene opens on. Omit to accept the default south-facing view. */
export interface EncounterCameraConfig {
  readonly yaw: number;
  readonly pitch: number;
  /**
   * Opening zoom, in the client's fov units — the value the scroll wheel moves, 128 (out) to
   * 896 (in). Omit for the game's default 512. An encounter frames a large boss by opening
   * zoomed out, never by moving the camera: its distance always follows pitch as in the game.
   */
  readonly zoom?: number;
}

/** Display-only chrome for the encounter picker (hero art, thumbnails, taglines). */
export interface EncounterPresentation {
  /** Short title for the rail entry and detail headline (falls back to descriptor displayName). */
  readonly title?: string;
  /** Full hero render (transparent PNG), shown in the detail pane. */
  readonly heroArt?: string;
  /** When true, render the hero as a full standing figure anchored right (vs. a centered bust). */
  readonly heroArtFull?: boolean;
  readonly thumb?: string;
  /** How the thumbnail fills its frame: a chathead is contained, a splash is cover-cropped. */
  readonly thumbFit?: 'contain' | 'cover';
  /** Kicker under the detail headline, e.g. "Phase 3 · The Judge of the Dead". */
  readonly tagline?: string;
  /** Short phase/wave identity retained when setup hides the descriptive copy. */
  readonly setupContext?: string;
  /** One short sentence in the detail hero. */
  readonly blurb?: string;
  /** Wiki page for the fight, offered from the encounter panel. Prefer the strategy guide. */
  readonly wikiUrl?: string;
  /**
   * The live model `BossPortrait` draws in place of {@link thumb}. Its NPC must be one the
   * encounter's render config loads, and an `idleSeqId` one it declares, so the trimmed cache
   * keeps both (`encounterModules.test.ts`).
   */
  readonly portrait?: BossPortraitConfig;
}

/** An opening view for runs whose setup has every one of `mechanics`' values. */
export interface EncounterSetupCamera {
  readonly mechanics: Readonly<Partial<MechanicsConfig>>;
  readonly camera: EncounterCameraConfig;
}

export interface EncounterPresentationModule {
  readonly kind: string;
  /** A scene of its own, for presentation the common `SceneCompositor` lacks. Omit for that scene. */
  readonly sceneBuilder?: SceneBuilderFactory;
  /** Encounter-supplied NPC interaction data, such as the Feed action on sleeping Duke. */
  readonly localNpcTypes?: ReadonlyMap<number, NpcType>;
  readonly defaultCamera?: EncounterCameraConfig;
  /**
   * Opening views for particular run setups, tried in order before {@link defaultCamera}: an
   * encounter whose start setup puts the player somewhere else (the Inferno started on wave 69)
   * opens on that start's view. Applied at scene entry and when a restart's opening view differs from
   * the last one applied; a run that reaches the same stage mid-fight, or restarts on the same view,
   * keeps the player's camera.
   */
  readonly setupCameras?: readonly EncounterSetupCamera[];
  /** Sounds for the encounter's own events, dispatched only while it is displayed (before core's). */
  readonly audioRules?: SoundRules;
  readonly presentation?: EncounterPresentation;
}

/**
 * Orbit pitch every encounter camera opens at unless it overrides it. The value itself lives
 * with the rest of the OSRS camera constants in the render layer — this manifest may import
 * from there, but not the other way round.
 */
export const DEFAULT_ORBIT_PITCH = OSRS_DEFAULT_PITCH;

/**
 * The orbit yaw that looks from tile `from` toward point `to`. The orbit camera sits at
 * target + d·(sin yaw, −cos yaw) (`Projection3D.getOrbitCameraWorldPosition`), so it looks along
 * (−sin yaw, cos yaw): 0 faces north, 90 west, 180 south, 270 east.
 */
export function orbitYawToward(from: Readonly<Coordinate>, to: Readonly<Coordinate>): number {
  const yaw = (Math.atan2(-(to[0] - from[0]), to[1] - from[1]) * 180) / Math.PI;
  // Rounded past float noise, so a diagonal reads as the whole angle it is.
  return Math.round((((yaw % 360) + 360) % 360) * 1e6) / 1e6;
}

/** The center of a `size`-tile footprint whose SW tile is `sw`. */
function footprintCentre(sw: Readonly<Coordinate>, size: number): Coordinate {
  return [sw[0] + (size - 1) / 2, sw[1] + (size - 1) / 2];
}

/** JalTok-Jad's footprint (`src/npcs/inferno/actors.ts`: size 5). */
const JAD_SIZE = 5;
/** The ordinary waves' opening zoom, in fov units (128 out to 896 in; the game opens at 512). */
const INFERNO_WAVES_ZOOM = 300;
/** The ordinary waves' opening pitch: about halfway between the game's level default and top-down. */
export const INFERNO_WAVES_PITCH = -50;

/** The view an encounter opens on when it declares no camera of its own. */
export const FALLBACK_ENCOUNTER_CAMERA: EncounterCameraConfig = { yaw: 180, pitch: DEFAULT_ORBIT_PITCH };

/**
 * Event audio dispatches through the displayed encounter's rules, then the engine's own core rules
 * (`eventAudioRulesFor`), so one encounter's rules never answer another's events.
 */
export const ENCOUNTER_PRESENTATION_MODULES: readonly EncounterPresentationModule[] = [
  {
    kind: 'yama_p3',
    sceneBuilder: (opts) => createYamaSceneBuilder(opts),
    audioRules: yamaAudioRules,
    defaultCamera: { yaw: 180, pitch: -62, zoom: 220 },
    presentation: {
      title: 'Yama',
      tagline: 'Phase 3 · The Judge of the Dead',
      setupContext: 'Phase 3',
      blurb: 'Face Yama in the final phase of the fight.',
      wikiUrl: 'https://oldschool.runescape.wiki/w/Yama/Strategies',
      // Negative yaw orbits the camera west of the NPC's southward facing, which turns the face
      // toward screen right, into the header's text rather than off the card's left edge, and
      // keeps the silhouette narrower than the mirrored angle does. focusHeight is each boss's
      // head height (horns, crests and pits make it differ), and span fits head and shoulders.
      // Yama's horns need headroom; the tighter span keeps his face readable beside the wings.
      portrait: { npcTypeId: YAMA_NPC_ID, framing: { yaw: -30, pitch: -12, focusHeight: 0.73, span: 0.58 } },
    },
  },
  {
    kind: 'lobby',
    sceneBuilder: (opts) => createLobbySceneBuilder(opts),
    defaultCamera: { yaw: 0, pitch: -26.5, zoom: 200 },
  },
  {
    kind: 'sol_heredit',
    sceneBuilder: (opts) => createSolHereditSceneBuilder(opts),
    audioRules: solHereditAudioRules,
    // The server runs `cam_forceangle(181, 0)` (pitch, yaw in JAU) as the player lands in the
    // arena (capture colosseum-sol-heredit-packet-data-2.txt, tick 7301). It sets no zoom,
    // so the player's own zoom carries over; we open at the game's default.
    defaultCamera: { yaw: 0, pitch: (-181 * 360) / 2048 },
    presentation: {
      title: 'Sol Heredit',
      tagline: 'Fortis Colosseum · Wave 12',
      setupContext: 'Wave 12',
      blurb: "Face Sol Heredit in the Fortis Colosseum's final wave, accessible now.",
      wikiUrl: 'https://oldschool.runescape.wiki/w/Fortis_Colosseum/Strategies',
      // Include the tall crest while centering the face and shoulders, not the helmet alone.
      portrait: { npcTypeId: SOL_NPC_ID, framing: { yaw: -30, pitch: -12, focusHeight: 0.74, span: 0.58 } },
    },
  },
  {
    kind: 'inferno',
    // One scene for waves 1-69: the stage-dependent scenery is the render config's scene controller.
    sceneBuilder: (opts) => createZukSceneBuilder(opts),
    // Every Inferno NPC's sounds, the ordinary waves' and wave 69's.
    audioRules: zukAudioRules,
    // Waves 2-66 open facing south over the arena from the practice start tile, somewhat zoomed out
    // (docs/encounters/inferno-policy.md).
    defaultCamera: { yaw: 180, pitch: INFERNO_WAVES_PITCH, zoom: INFERNO_WAVES_ZOOM },
    // A run started on wave 69 opens facing Zuk, north of its start tile, as TzKal-Zuk's own entry
    // did. One started on wave 1 opens facing south (yaw 180) from the landing tile, zoomed well out
    // over the arena. Wave 67 turns from the default start tile toward its Jad; wave
    // 68 looks south, further out, to hold all three Jads (all south of that tile). The Jad views
    // assume the default start tile: a moved one keeps the same view.
    setupCameras: [
      { mechanics: { [INFERNO_START_WAVE_KEY]: String(ZUK_WAVE) }, camera: { yaw: 0, pitch: -55, zoom: 185 } },
      {
        mechanics: { [INFERNO_START_WAVE_KEY]: String(FIRST_INFERNO_WAVE) },
        camera: { yaw: 180, pitch: DEFAULT_ORBIT_PITCH, zoom: 160 },
      },
      {
        mechanics: { [INFERNO_START_WAVE_KEY]: '67' },
        camera: {
          yaw: orbitYawToward(INFERNO_PRACTICE_START_TILE, footprintCentre(WAVE_67_JAD_TILE, JAD_SIZE)),
          pitch: INFERNO_WAVES_PITCH,
          zoom: INFERNO_WAVES_ZOOM,
        },
      },
      { mechanics: { [INFERNO_START_WAVE_KEY]: '68' }, camera: { yaw: 180, pitch: INFERNO_WAVES_PITCH, zoom: 220 } },
    ],
    presentation: {
      title: 'The Inferno',
      // Its parts are the quick search's words for it, so "zuk" finds the Inferno.
      tagline: 'Inferno · Waves 1–68 · TzKal-Zuk',
      setupContext: 'Waves 1–69',
      blurb: 'Practice the Inferno from any wave, or go straight to TzKal-Zuk at wave 69.',
      wikiUrl: 'https://oldschool.runescape.wiki/w/Inferno',
      // TzKal-Zuk stays the encounter's face. The idle is the one the render config loads, named so
      // the portrait cannot drift from it.
      portrait: {
        npcTypeId: ZUK_NPC_ID,
        idleSeqId: ZUK_SEQS.zuk.idle,
        // Raise the bust out of the bottom fade, with headroom for the idle's upward movement.
        framing: { yaw: -30, pitch: -12, focusHeight: 0.79, span: 0.58 },
      },
    },
  },
  {
    kind: DUKE_PRACTICE_KIND,
    sceneBuilder: createDukePracticeSceneBuilder,
    localNpcTypes: new Map([
      [DUKE_ASLEEP_MENU_TYPE.id, DUKE_ASLEEP_MENU_TYPE],
      [LEGACY_DUKE_MENU_TYPE.id, LEGACY_DUKE_MENU_TYPE],
    ]),
    audioRules: dukePracticeAudioRules,
    defaultCamera: { yaw: 0, pitch: -57, zoom: 235 },
    presentation: {
      tagline: 'Duke Sucellus · Awakened practice',
      blurb: 'Start at full health or jump straight to vents, bile, orbs, or enrage.',
      wikiUrl: 'https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode',
    },
  },
];

const MODULE_BY_KIND: ReadonlyMap<string, EncounterPresentationModule> = new Map(
  ENCOUNTER_PRESENTATION_MODULES.flatMap((presentation) => {
    const core = ENCOUNTER_CORE_MODULES.find((module) => module.kind === presentation.kind);
    const kinds = core ? encounterKindsOf(core) : [presentation.kind];
    return kinds.map((kind) => [kind, presentation] as const);
  }),
);

/** The presentation module for `kind`, resolving variant kinds to their parent's entry. */
export function encounterPresentationModuleForKind(kind: string): EncounterPresentationModule | undefined {
  return MODULE_BY_KIND.get(kind);
}

/** Every encounter's audio rules, in manifest order: the sounds the app's event-audio player preloads. */
export function encounterAudioRules(): readonly SoundRules[] {
  return ENCOUNTER_PRESENTATION_MODULES.flatMap((module) => (module.audioRules ? [module.audioRules] : []));
}

/**
 * The orbit view `kind` opens on for a run with `mechanics`: the first of its setup cameras that
 * setup matches, else its default, else the default south-facing view.
 */
export function encounterDefaultCamera(
  kind: string,
  mechanics: Readonly<Partial<MechanicsConfig>> = {},
): EncounterCameraConfig {
  const presentation = encounterPresentationModuleForKind(kind);
  const setup = presentation?.setupCameras?.find((entry) =>
    Object.entries(entry.mechanics).every(([key, value]) => mechanics[key] === value),
  );
  return setup?.camera ?? presentation?.defaultCamera ?? FALLBACK_ENCOUNTER_CAMERA;
}
