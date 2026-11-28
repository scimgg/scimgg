import type { EncounterControls, MechanicsToggleContext, MechanicsToggleInfo } from '../../core/encounters/types';
import { getMonsterHp } from '../../data/monsterData';
import { SOL_NPC_ID } from '../../npcs/colosseum/constants';
import type { Coordinate, MechanicsConfig } from '../../types/simulation';
import {
  COLOSSEUM_WAVE_START_TILE,
  type ColosseumSpawnLayout,
  parseColosseumSpawnLayout,
  resolveColosseumStartTile,
  serializeColosseumSpawnLayout,
  serializeColosseumStartTile,
} from '../colosseum/waves/spawnLayout';
import { SOL_HEREDIT_DEBUG_ACTIONS } from './commands';
import { SOL_PLAYER_START } from './constants';
import { SOL_PHASE_TRANSITIONS } from './phases';

/** Setup choice pinning Sol's regular attack style: `random`, `spear` or `shield`. */
export const SOL_HEREDIT_ATTACK_STYLE_KEY = 'solHereditAttackStyle';

/** The Fortis Colosseum wave the run starts on, `'1'`-`'12'`; 12 is Sol Heredit himself. */
export const COLOSSEUM_START_WAVE_KEY = 'colosseumStartWave';
const DIRECT_SOL_WAVE = 12;

/**
 * The start wave's practice spawn layout (`serializeColosseumSpawnLayout`), '' for random spawns.
 * Like the start tile, drawn by the Colosseum's setup control alone, so it is deliberately not a
 * mechanics toggle: no generic row renders it, while it is still persisted, carried into replays and
 * kept by reconstruction (`runStartMechanicsKeys`).
 */
export const COLOSSEUM_SPAWN_LAYOUT_KEY = 'colosseumSpawnLayout';
/** Where a wave start opens (`serializeColosseumStartTile`, `"x,y"`), '' for the default. Waves 1-11 only. */
export const COLOSSEUM_START_TILE_KEY = 'colosseumStartTile';

/** A missing or unreadable stored value (a hand edit, an older save) is a direct Sol start. */
export function resolveColosseumStartWave(mechanics: Readonly<Partial<MechanicsConfig>>): number {
  const raw = mechanics[COLOSSEUM_START_WAVE_KEY];
  const wave = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  return wave >= 1 && wave <= DIRECT_SOL_WAVE ? wave : DIRECT_SOL_WAVE;
}

/** The stored layout when it is for the start wave; null (random) otherwise, a direct Sol start included. */
export function resolveColosseumSpawnLayout(
  mechanics: Readonly<Partial<MechanicsConfig>>,
): ColosseumSpawnLayout | null {
  const layout = parseColosseumSpawnLayout(mechanics[COLOSSEUM_SPAWN_LAYOUT_KEY]);
  return layout?.wave === resolveColosseumStartWave(mechanics) ? layout : null;
}

/** Where a fresh run opens: Sol's start for a direct start, else the stored or default wave start tile. */
export function resolveColosseumPlayerStart(mechanics: Readonly<Partial<MechanicsConfig>>): Coordinate {
  return resolveColosseumStartWave(mechanics) === DIRECT_SOL_WAVE
    ? [...SOL_PLAYER_START]
    : resolveColosseumStartTile(mechanics[COLOSSEUM_START_TILE_KEY]);
}

/** A run's practice setup, resolved: what the setup control saves and a restart applies. */
export interface ColosseumRunSetup {
  /** 1-12; 12 is a direct Sol start, which ignores the other two. */
  readonly startWave: number;
  /** The start wave's layout, or null for random spawns. */
  readonly spawnLayout: ColosseumSpawnLayout | null;
  readonly startTile: Readonly<Coordinate>;
}

export function resolveColosseumRunSetup(mechanics: Readonly<Partial<MechanicsConfig>>): ColosseumRunSetup {
  return {
    startWave: resolveColosseumStartWave(mechanics),
    spawnLayout: resolveColosseumSpawnLayout(mechanics),
    startTile: resolveColosseumPlayerStart(mechanics),
  };
}

/**
 * The setup a running fight cannot take without restarting, as a comparable key, as the Inferno's
 * `infernoRunSetupKey`: built from the saved config on one side and from the run's published start
 * (`ColosseumRunSetupState`) on the other, both RESOLVED, so an unset tile and the default agree. A
 * direct Sol start is its wave alone; a wave start adds its layout and a moved start tile.
 */
export function colosseumRunSetupKey({ startWave, spawnLayout, startTile }: ColosseumRunSetup): string {
  if (startWave === DIRECT_SOL_WAVE) return String(startWave);
  const layout = spawnLayout ? `;${serializeColosseumSpawnLayout(spawnLayout)}` : '';
  const moved = startTile[0] !== COLOSSEUM_WAVE_START_TILE[0] || startTile[1] !== COLOSSEUM_WAVE_START_TILE[1];
  return `${startWave}${layout}${moved ? `;start=${serializeColosseumStartTile(startTile)}` : ''}`;
}

/** The mechanics that save `setup`: its start wave, its layout or random spawns, and its start tile ('' for the default). */
export function colosseumSetupMechanics(setup: ColosseumRunSetup): Partial<MechanicsConfig> {
  const [x, y] = setup.startTile;
  const moved = x !== COLOSSEUM_WAVE_START_TILE[0] || y !== COLOSSEUM_WAVE_START_TILE[1];
  return {
    [COLOSSEUM_START_WAVE_KEY]: String(setup.startWave),
    [COLOSSEUM_SPAWN_LAYOUT_KEY]: setup.spawnLayout ? serializeColosseumSpawnLayout(setup.spawnLayout) : '',
    [COLOSSEUM_START_TILE_KEY]: moved ? serializeColosseumStartTile(setup.startTile) : '',
  };
}

/**
 * Sol is on the field: a direct start, or a wave run from his control tick C. Sol's stage publishes
 * `visuals.solControlTick` only once he is added (null through waves 1-11 and wave 12's jump; absent,
 * meaning 0, in older recordings). Before a run, the saved start wave decides.
 */
export function isSolOnField({ config, encounterSnapshot }: MechanicsToggleContext): boolean {
  if (encounterSnapshot?.kind !== 'sol_heredit') return resolveColosseumStartWave(config) === DIRECT_SOL_WAVE;
  return encounterSnapshot.visuals.solControlTick !== null;
}

/** The section Sol Heredit's own controls are listed under, in the configurer and in Practice. */
export const SOL_SECTION = 'Sol Heredit';

/**
 * A control of Sol's own, grouped under his name as the Inferno groups TzKal-Zuk's. A run started
 * before wave 12 carries into him, so the control is deferred, never inapplicable: it keeps its
 * value and the section says when it lands, until 12 is the wave chosen or Sol is on the field.
 */
function appliesFromSolWave(toggle: MechanicsToggleInfo): MechanicsToggleInfo {
  return {
    ...toggle,
    section: SOL_SECTION,
    visibleInPractice: isSolOnField,
    appliesLater: (context) => (isSolOnField(context) ? null : `From wave ${DIRECT_SOL_WAVE}`),
  };
}

export function buildSolHereditControls(): EncounterControls {
  const maxHp = getMonsterHp(SOL_NPC_ID);
  if (maxHp === undefined) throw new TypeError('Missing Sol Heredit monster HP');
  return {
    // 25% only adds the fourth beam crystal, so it is left out to keep the presets on one row.
    bossHpPresets: [
      { label: 'Start', hp: maxHp, hint: 'Spear and shield only.' },
      ...[
        { threshold: 0.9, hint: 'Adds triple attack and beams.' },
        { threshold: 0.75, hint: 'Adds grapple. Faster attacks.' },
        { threshold: 0.5, hint: 'Harder triple attack.' },
        { threshold: 0.1, hint: 'Enrage.' },
      ].map(({ threshold, hint }) => {
        if (!SOL_PHASE_TRANSITIONS.some((transition) => transition.threshold === threshold))
          throw new TypeError(`No Sol phase at ${threshold}`);
        return { label: `${Math.round(threshold * 100)}%`, hp: Math.floor(maxHp * threshold), hint };
      }),
    ],
    defaultMechanicsConfig: {
      infiniteHealth: false,
      solHereditAttacks: true,
      solHereditSand: true,
      solHereditBeams: true,
      solHereditTelegraph: false,
      [SOL_HEREDIT_ATTACK_STYLE_KEY]: 'random',
      [COLOSSEUM_START_WAVE_KEY]: String(DIRECT_SOL_WAVE),
      [COLOSSEUM_SPAWN_LAYOUT_KEY]: '',
      [COLOSSEUM_START_TILE_KEY]: '',
    },
    mechanicsToggles: [
      {
        key: COLOSSEUM_START_WAVE_KEY,
        label: 'Start Wave',
        setup: true,
        choices: Array.from({ length: DIRECT_SOL_WAVE }, (_, index) => ({
          value: String(index + 1),
          label: index + 1 === DIRECT_SOL_WAVE ? `${DIRECT_SOL_WAVE} · Sol Heredit` : String(index + 1),
        })),
        info: 'The wave the run starts on. Each cleared wave offers a modifier and continues into the next, through Sol Heredit on wave 12. Your chosen modifiers are in force from the start wave. Applies from your next attempt.',
      },
      ...(
        [
          { key: 'solHereditAttacks', label: 'Sol Attacks' },
          {
            key: SOL_HEREDIT_ATTACK_STYLE_KEY,
            label: 'Attack Style',
            dependsOn: 'solHereditAttacks',
            setup: true,
            choices: [
              { value: 'random', label: 'Random' },
              { value: 'spear', label: 'Spear' },
              { value: 'shield', label: 'Shield' },
            ],
          },
          { key: 'solHereditSand', label: 'Molten Sand' },
          { key: 'solHereditBeams', label: 'Light Beams' },
          {
            key: 'solHereditTelegraph',
            label: 'Attack Telegraphs',
            group: 'aid',
            info: 'Shows where his next attack will land.',
          },
        ] satisfies MechanicsToggleInfo[]
      ).map(appliesFromSolWave),
    ],
    // Each acts on Sol's stage, so practice offers them only while he is there.
    debugActions: SOL_HEREDIT_DEBUG_ACTIONS.map((action) => ({ ...action, visibleInPractice: isSolOnField })),
    debugFlags: [{ key: 'beamDamageTiles', label: 'Beam Damage Tiles' }],
  };
}
