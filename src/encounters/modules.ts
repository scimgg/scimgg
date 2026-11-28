/**
 * The simulation-side encounter manifest: one entry per encounter, listing everything the
 * SIMULATION needs to know about it.
 *
 * This manifest reaches node-environment consumers — engine tests and anything importing the
 * composition root ({@link ./registry}) — so it must stay free of render and UI imports: one
 * scene-builder import here would pull picogl, which needs a browser global, into all of them.
 *
 * Everything presentational therefore lives outside it. Register the simulation here. Register its
 * render config by base kind in {@link ./renderConfigs}. Add a {@link ./presentationModules} row
 * only for picker art, camera settings, event-audio rules or a custom scene; that manifest expands
 * its variant kinds from the list here.
 *
 * Identity (kind, parent/variant, slug, availability) lives in {@link ./catalog}, and
 * `encounterModules.test.ts` pins this manifest, the presentation manifest, the SEO slugs, and
 * the lobby metadata to it — withholding or shipping an encounter is the catalog flag plus the
 * manifest entries those tests demand, not a hand-walk of four registries.
 */
import { z } from 'zod';
import type { EncounterDescriptor } from '../core/encounters/encounterFactory';
import type { Encounter, EncounterControls, MechanicsToggleInfo } from '../core/encounters/types';
import type { MechanicsConfig } from '../types/simulation';
import { START_TILE as DUKE_PRACTICE_START } from './dukePractice/arena';
import { DUKE_MAP_SQUARE } from './dukePractice/constants';
import { DUKE_PRACTICE_CONTROLS, DUKE_PRACTICE_KIND } from './dukePractice/controls';
import { DukePracticeEncounter } from './dukePractice/DukePracticeEncounter';
import { INFERNO_LANDING_TILE, INFERNO_MAP_SQUARE, INFERNO_MAP_SQUARE_OFFSETS, ZUK_WAVE } from './inferno/constants';
import { buildInfernoControls, INFERNO_START_WAVE_KEY, resolveInfernoRunSetup } from './inferno/controls';
import { InfernoEncounter } from './inferno/InfernoEncounter';
import { INFERNO_PILLAR_COLLISION_LOCS } from './inferno/pillars';
import { LobbyEncounter } from './lobby/LobbyEncounter';
import { SOL_BOUNDARY_WARRIORS } from './solHeredit/arenaBoundary';
import { SOL_MAP_SQUARE, SOL_PLAYER_START } from './solHeredit/constants';
import { buildSolHereditControls } from './solHeredit/controls';
import { SOL_HEREDIT_MODIFIERS, SOL_HEREDIT_SETUP_NOTES } from './solHeredit/modifiers';
import { SolHereditEncounter } from './solHeredit/SolHereditEncounter';
import {
  BLOODIED_BLOWS_CONFIG,
  DIVINE_SEVERANCE_CONFIG,
  FORFEIT_BREATH_CONFIG,
  GLYPHIC_ATTENUATION_CONFIG,
  SENSORY_CLOUDING_CONFIG,
} from './yamaP3/contractConfig';
import { YAMA_CONTRACTS } from './yamaP3/contracts';
import { buildYamaControls } from './yamaP3/controls';
import { YamaEncounter } from './yamaP3/YamaEncounter';
import { ZUK_EXCLUDED_STATIC_LOC_IDS } from './zuk/constants';

export interface EncounterCoreModule {
  readonly kind: string;
  readonly factory: (config?: Record<string, unknown>) => Encounter;
  readonly descriptor: EncounterDescriptor;
  /**
   * Extra encounter kinds built from the same class with a different config (Yama's contracts).
   *
   * They get their own factory but deliberately NO descriptor of their own: a variant is
   * selected through its parent, so `getDescriptor(variantKind)` stays undefined while
   * `getDescriptorForKind(variantKind)` resolves to the parent.
   *
   * Both registries derive their variant kinds from this map, so REGISTRATION happens in one
   * place — but the kind string itself also appears in the encounter's `variants` list
   * (`YAMA_CONTRACTS`), which is what the picker reads. `encounterModules.test.ts` pins the
   * two against each other.
   */
  readonly variantFactories?: Readonly<Record<string, () => Encounter>>;
  /** Play the encounter's intro animation when entering it. Defaults to false. */
  readonly enableIntro?: boolean;
  /**
   * Static control surface the UI renders without instantiating a fight. The Infinite Health and
   * Infinite Special Attack aids are appended by {@link encounterControlsForKind}; listing either
   * here again renders it twice.
   */
  readonly controls: EncounterControls;
  /** Per-variant control surfaces; a variant kind absent here inherits {@link controls}. */
  readonly variantControls?: Readonly<Record<string, EncounterControls>>;
  /**
   * Where entering one of this kind's retired kinds (catalog `retiredKinds`) starts: the run setup it
   * stands for, saved over the player's own as a pick in the setup would be. `zuk` is wave 69.
   */
  readonly retiredEntries?: Readonly<Record<string, Readonly<Partial<MechanicsConfig>>>>;
  /**
   * Opts run setups into walking to their start tile during the fight-start countdown.
   * Encounters without this hook, or whose hook returns false, keep their opening position.
   */
  readonly countdownMovement?: (mechanics: Readonly<Partial<MechanicsConfig>>) => boolean;
}

/**
 * Options are refused, not ignored the way Yama's factory ignores them: a recorded run whose
 * bootstrap carries options was built by an encounter that read them, so rebuilding it here
 * without them would replay a different fight under the recording's name. The run setup is
 * mechanics and the run seed an encounter seed.
 */
function createInfernoEncounter(options?: Record<string, unknown>): Encounter {
  const unsupported = Object.keys(options ?? {});
  if (unsupported.length > 0) {
    throw new TypeError(`Encounter 'inferno' accepts no constructor options; got: ${unsupported.join(', ')}`);
  }
  return new InfernoEncounter();
}

function createSolHereditEncounter(options?: Record<string, unknown>): Encounter {
  const parsed = solOptionsSchema.parse(options ?? {});
  return new SolHereditEncounter(undefined, parsed.modifiers);
}

const solOptionsSchema = z
  .object({
    modifiers: z
      .record(
        z.string().refine((id) => SOL_HEREDIT_MODIFIERS.some((modifier) => modifier.id === id)),
        z.union([z.literal(1), z.literal(2), z.literal(3)]),
      )
      .optional(),
  })
  .strict();

export const ENCOUNTER_CORE_MODULES: readonly EncounterCoreModule[] = [
  {
    kind: 'yama_p3',
    factory: () => new YamaEncounter(),
    enableIntro: true,
    descriptor: {
      kind: 'yama_p3',
      displayName: 'Yama - Phase 3',
      description: 'The Yama boss encounter',
      mapSquare: { x: 23, y: 157 },
      playerStart: [31, 37],
      loadsMapLocs: true,
      variants: YAMA_CONTRACTS,
      variantLabel: 'Contract',
      collision: { mode: 'auto', seed: [32, 30] },
      victory: {
        eyebrow: 'Triumphant',
        title: 'VICTORY',
        narrative: 'YAMA DEFEATED',
        accent: 'blood',
      },
    },
    variantFactories: {
      yama_p3_divine: () => new YamaEncounter(DIVINE_SEVERANCE_CONFIG),
      yama_p3_forfeit_breath: () => new YamaEncounter(FORFEIT_BREATH_CONFIG),
      yama_p3_sensory: () => new YamaEncounter(SENSORY_CLOUDING_CONFIG),
      yama_p3_bloodied: () => new YamaEncounter(BLOODIED_BLOWS_CONFIG),
      yama_p3_glyphic: () => new YamaEncounter(GLYPHIC_ATTENUATION_CONFIG),
    },
    controls: buildYamaControls(),
    variantControls: {
      yama_p3_divine: buildYamaControls(DIVINE_SEVERANCE_CONFIG),
      yama_p3_forfeit_breath: buildYamaControls(FORFEIT_BREATH_CONFIG),
      yama_p3_sensory: buildYamaControls(SENSORY_CLOUDING_CONFIG),
      yama_p3_bloodied: buildYamaControls(BLOODIED_BLOWS_CONFIG),
      yama_p3_glyphic: buildYamaControls(GLYPHIC_ATTENUATION_CONFIG),
    },
  },
  {
    kind: 'lobby',
    factory: () => new LobbyEncounter(),
    descriptor: {
      kind: 'lobby',
      displayName: 'Lobby',
      description: 'Prifddinas lobby area',
      mapSquare: { x: 25, y: 73 },
      playerStart: [31, 25],
      collision: { mode: 'custom' },
    },
    controls: {
      defaultMechanicsConfig: { infiniteHealth: false },
      mechanicsToggles: [],
      debugActions: [],
    },
  },
  {
    kind: 'sol_heredit',
    factory: createSolHereditEncounter,
    descriptor: {
      kind: 'sol_heredit',
      displayName: 'Sol Heredit',
      description: 'The final wave of the Fortis Colosseum.',
      mapSquare: SOL_MAP_SQUARE,
      playerStart: [...SOL_PLAYER_START],
      modifiers: SOL_HEREDIT_MODIFIERS,
      setupNotes: SOL_HEREDIT_SETUP_NOTES,
      // The Sol practice setup defaults to Blasphemy III.
      defaultModifierSelection: { blasphemy: 3 },
      loadsMapLocs: true,
      isWorkInProgress: true,
      collision: { mode: 'auto', seed: [...SOL_PLAYER_START], dynamicLocs: SOL_BOUNDARY_WARRIORS },
      victory: {
        eyebrow: 'Triumphant',
        title: 'VICTORY',
        narrative: 'SOL HEREDIT DEFEATED',
        accent: 'gold',
      },
    },
    controls: buildSolHereditControls(),
  },
  {
    kind: 'inferno',
    factory: createInfernoEncounter,
    // Only a run started on wave 1 has an intro, the landing (`InfernoEncounter.getIntroConfig`).
    enableIntro: true,
    descriptor: {
      kind: 'inferno',
      displayName: 'The Inferno',
      description:
        'Start from any wave. Each cleared wave leads straight into the next, through to TzKal-Zuk at wave 69.',
      mapSquare: INFERNO_MAP_SQUARE,
      mapSquareOffsets: INFERNO_MAP_SQUARE_OFFSETS,
      playerStart: [...INFERNO_LANDING_TILE],
      loadsMapLocs: true,
      isWorkInProgress: true,
      // The Rocky supports are packet-added locs: baked in here, opened at runtime as they collapse.
      // The static glyph (north of the arena, outside every wave's reach) is left out, as wave 69
      // replaces it with the moving NPC: the same single loc the scene leaves to its controller.
      collision: {
        mode: 'auto',
        seed: [...INFERNO_LANDING_TILE],
        dynamicLocs: INFERNO_PILLAR_COLLISION_LOCS,
        excludedStaticLocIds: ZUK_EXCLUDED_STATIC_LOC_IDS,
      },
      // The run is won on wave 69.
      victory: {
        eyebrow: 'Triumphant',
        title: 'VICTORY',
        narrative: 'TZKAL-ZUK DEFEATED',
        accent: 'gold',
      },
    },
    controls: buildInfernoControls(),
    retiredEntries: { zuk: { [INFERNO_START_WAVE_KEY]: '69' } },
    // A practice start on waves 2-68 spawns its wave on GO, so the countdown is where the player sets
    // up (behind a pillar, say); wave 1 also gets it after its landing. Wave 69 opens on its fixed
    // start facing Zuk.
    countdownMovement: (mechanics) => resolveInfernoRunSetup(mechanics).startWave !== ZUK_WAVE,
  },
  {
    kind: DUKE_PRACTICE_KIND,
    factory: () => new DukePracticeEncounter(),
    descriptor: {
      kind: DUKE_PRACTICE_KIND,
      displayName: 'Awakened Duke Practice',
      description: 'Practise step-backs, pillar cover, gas vents, bile and orb dodges against Duke Sucellus.',
      mapSquare: DUKE_MAP_SQUARE,
      playerStart: [...DUKE_PRACTICE_START],
      loadsMapLocs: true,
      collision: { mode: 'custom' },
      victory: {
        eyebrow: 'Practice complete',
        title: 'VICTORY',
        narrative: 'DUKE SUCELLUS DEFEATED',
        accent: 'gold',
      },
    },
    controls: DUKE_PRACTICE_CONTROLS,
  },
];

/** Every kind a module contributes: its base kind followed by its variant kinds. */
export function encounterKindsOf(module: EncounterCoreModule): readonly string[] {
  return [module.kind, ...Object.keys(module.variantFactories ?? {})];
}

const MODULE_BY_KIND: ReadonlyMap<string, EncounterCoreModule> = new Map(
  ENCOUNTER_CORE_MODULES.flatMap((module) => encounterKindsOf(module).map((kind) => [kind, module] as const)),
);

/** The module owning `kind`, whether `kind` is a base encounter or one of its variants. */
export function encounterModuleForKind(kind: string): EncounterCoreModule | undefined {
  return MODULE_BY_KIND.get(kind);
}

/**
 * Appended to every kind's own list rather than declared beside the other aids in
 * `GLOBAL_MECHANICS_TOGGLES`: in-fight Practice renders the encounter list raw, and only the setup
 * panel splices the globals around it, so a global aid declared only there would vanish
 * mid-fight. Every encounter gets both infinite cheats through this one path.
 */
const INFINITE_HEALTH_TOGGLE: MechanicsToggleInfo = { key: 'infiniteHealth', label: 'Infinite Health', group: 'aid' };
const INFINITE_SPECIAL_ATTACK_TOGGLE: MechanicsToggleInfo = {
  key: 'infiniteSpecialAttack',
  label: 'Infinite Special Attack',
  group: 'aid',
};

const CONTROLS_BY_KIND: ReadonlyMap<string, EncounterControls> = new Map(
  ENCOUNTER_CORE_MODULES.flatMap((module) =>
    encounterKindsOf(module).map((kind) => {
      const controls = module.variantControls?.[kind] ?? module.controls;
      return [
        kind,
        {
          ...controls,
          mechanicsToggles: [...controls.mechanicsToggles, INFINITE_HEALTH_TOGGLE, INFINITE_SPECIAL_ATTACK_TOGGLE],
        },
      ] as const;
    }),
  ),
);

/**
 * The control surface for `kind`: its variant-specific entry, else its base encounter's, with the
 * two infinite aids appended. Precomputed because Practice memoizes on the toggle list's identity.
 */
export function encounterControlsForKind(kind: string): EncounterControls | undefined {
  return CONTROLS_BY_KIND.get(kind);
}

/**
 * Whether entering `kind` plays the encounter's intro animation. Variants inherit their parent's
 * setting, which is how all Yama contracts stay in step with the base fight.
 */
export function encounterEnablesIntro(kind: string): boolean {
  return encounterModuleForKind(kind)?.enableIntro === true;
}

/** Whether a `kind` run with `mechanics` offers countdown start positioning without the setting. */
export function encounterOffersCountdownMovement(kind: string, mechanics: Readonly<Partial<MechanicsConfig>>): boolean {
  return encounterModuleForKind(kind)?.countdownMovement?.(mechanics) === true;
}

/**
 * Where entering `kind` lands: a live kind enters itself; a retired one (`zuk`) enters the kind that
 * owns it with the run setup it stands for (wave 69). Undefined for a kind nothing registers.
 */
export function resolveEncounterEntry(
  kind: string,
): { readonly kind: string; readonly mechanics: Readonly<Partial<MechanicsConfig>> } | undefined {
  const module = encounterModuleForKind(kind);
  if (module) return { kind, mechanics: {} };
  for (const candidate of ENCOUNTER_CORE_MODULES) {
    const mechanics = candidate.retiredEntries?.[kind];
    if (mechanics) return { kind: candidate.kind, mechanics };
  }
  return undefined;
}
