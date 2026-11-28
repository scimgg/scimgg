/**
 * The practice setup of a wave start (waves 1-11; docs/encounters/fortis-colosseum-policy.md): a
 * player-chosen placement of the start wave's initial NPCs on the 12 spawn points, and the tile the
 * run opens on. Both are simulator practice options, never a game rule; the warband, the
 * reinforcements and the manticores' first style stay random.
 *
 * The API:
 * - {@link ColosseumSpawnLayout}: `points[i]` is the species on `COLOSSEUM_SPAWN_POINTS[i]`, or null.
 * - {@link validateColosseumSpawnLayout}: the only way to build a layout; it is valid iff the wave is
 *   1-11 and it places some of that wave's initial NPCs, none more often than the wave has them.
 *   {@link isCompleteColosseumSpawnLayout}: it places all of them; a partial layout's other initial
 *   NPCs are drawn at random (`planColosseumWave`).
 * - {@link serializeColosseumSpawnLayout} / {@link parseColosseumSpawnLayout}: the
 *   `colosseumSpawnLayout` mechanics value, `"<wave>:<one char per point>"` (`s` serpent shaman, `j`
 *   javelin colossus, `m` manticore, `w` shockwave colossus, `-` empty), e.g. `"7:-j---m--w---"`.
 *   Anything unreadable or invalid parses to null (random).
 * - {@link parseColosseumStartTile} / {@link serializeColosseumStartTile} /
 *   {@link resolveColosseumStartTile}: the `colosseumStartTile` mechanics value, `"x,y"`, '' for
 *   {@link COLOSSEUM_WAVE_START_TILE}.
 * - {@link colosseumSpawnLayoutWarnings}: what a layout asks for that the game cannot produce from
 *   the start tile. These are warnings, not errors: the run honors the layout anyway.
 */
import type { Coordinate } from '../../../types/simulation';
import { colosseumWaveFloorTiles } from './arena';
import { COLOSSEUM_SPAWN_POINTS, COLOSSEUM_SPECIES_SIZES, isSpawnPointClearOfPlayer } from './layout';
import { type ColosseumWaveSpecies, colosseumWave, FIRST_COLOSSEUM_WAVE, LAST_COLOSSEUM_WAVE } from './waveTable';

/** The species a wave starts with on the spawn points; the jaguar and minotaur only reinforce. */
export type ColosseumLayoutSpecies = Exclude<ColosseumWaveSpecies, 'jaguarWarrior' | 'minotaur'>;

export interface ColosseumSpawnLayout {
  /** The start wave, 1-11. */
  readonly wave: number;
  /** Length 12, indexed as `COLOSSEUM_SPAWN_POINTS`. */
  readonly points: readonly (ColosseumLayoutSpecies | null)[];
}

export type ColosseumSpawnLayoutError = 'bad-wave' | 'bad-points' | 'empty' | 'composition-mismatch';

export type ColosseumSpawnLayoutResult =
  | { readonly ok: true; readonly layout: ColosseumSpawnLayout }
  | { readonly ok: false; readonly error: ColosseumSpawnLayoutError; readonly message: string };

const POINT_COUNT = COLOSSEUM_SPAWN_POINTS.length;

/** The wave's initial NPCs, one entry each, in spawn order (`ColosseumWaveComposition.initial`). */
export function colosseumLayoutSpeciesForWave(wave: number): ColosseumLayoutSpecies[] {
  return colosseumWave(wave).initial as ColosseumLayoutSpecies[];
}

/**
 * Checks a placement for `wave`, returning the layout or a short message a player can act on. It may
 * place any of the wave's initial NPCs, at least one, each species no more often than the wave starts
 * it: the rest are drawn at random. One point holds one NPC by construction.
 */
export function validateColosseumSpawnLayout(
  wave: number,
  points: readonly (ColosseumLayoutSpecies | null)[],
): ColosseumSpawnLayoutResult {
  if (!Number.isInteger(wave) || wave < FIRST_COLOSSEUM_WAVE || wave > LAST_COLOSSEUM_WAVE) {
    return {
      ok: false,
      error: 'bad-wave',
      message: `Spawn layouts are for waves ${FIRST_COLOSSEUM_WAVE} to ${LAST_COLOSSEUM_WAVE}.`,
    };
  }
  if (points.length !== POINT_COUNT) {
    return { ok: false, error: 'bad-points', message: `A spawn layout has ${POINT_COUNT} spawn points.` };
  }
  const placed = points.filter((species): species is ColosseumLayoutSpecies => species !== null);
  if (placed.length === 0) return { ok: false, error: 'empty', message: 'Place at least one monster.' };
  const expected = colosseumLayoutSpeciesForWave(wave);
  const count = (list: readonly string[], species: string) => list.filter((entry) => entry === species).length;
  if (placed.some((species) => count(placed, species) > count(expected, species))) {
    return {
      ok: false,
      error: 'composition-mismatch',
      message: `Those spawns do not fit wave ${wave}.`,
    };
  }
  return { ok: true, layout: { wave, points: [...points] } };
}

/** Whether `layout` places every one of its wave's initial NPCs, leaving none to the draw. */
export function isCompleteColosseumSpawnLayout(layout: ColosseumSpawnLayout): boolean {
  return layout.points.filter(Boolean).length === colosseumLayoutSpeciesForWave(layout.wave).length;
}

const SPECIES_CHAR: Readonly<Record<ColosseumLayoutSpecies, string>> = {
  serpentShaman: 's',
  javelinColossus: 'j',
  manticore: 'm',
  shockwaveColossus: 'w',
};
const CHAR_SPECIES: Readonly<Record<string, ColosseumLayoutSpecies>> = Object.fromEntries(
  Object.entries(SPECIES_CHAR).map(([species, char]) => [char, species as ColosseumLayoutSpecies]),
);
const SERIALIZED = new RegExp(`^([1-9]\\d?):([-sjmw]{${POINT_COUNT}})$`);

/** The `colosseumSpawnLayout` mechanics value for `layout`. */
export function serializeColosseumSpawnLayout(layout: ColosseumSpawnLayout): string {
  return `${layout.wave}:${layout.points.map((species) => (species === null ? '-' : SPECIES_CHAR[species])).join('')}`;
}

/** A stored `colosseumSpawnLayout` value: null (random spawns) for '', garbage or an invalid layout. */
export function parseColosseumSpawnLayout(value: unknown): ColosseumSpawnLayout | null {
  if (typeof value !== 'string') return null;
  const match = SERIALIZED.exec(value);
  if (!match) return null;
  const points = [...match[2]!].map((char) => (char === '-' ? null : CHAR_SPECIES[char]!));
  const result = validateColosseumSpawnLayout(Number(match[1]), points);
  return result.ok ? result.layout : null;
}

/**
 * Policy (maintainer's choice): a start on waves 1-11 opens on (23,38), on the west side of the
 * arena, unless the player picks another floor tile (`colosseumStartTile`).
 */
export const COLOSSEUM_WAVE_START_TILE: Readonly<Coordinate> = [23, 38];

const FLOOR = colosseumWaveFloorTiles();

/** Whether a run can open on `tile`: a tile of the waves floor (pillars and walls excluded). */
export function isColosseumStartTileOpen([x, y]: Readonly<Coordinate>): boolean {
  return FLOOR.has(`${x},${y}`);
}

/** `"x,y"`, integers; null for '' or anything else. Openness is {@link isColosseumStartTileOpen}'s. */
export function parseColosseumStartTile(value: unknown): Coordinate | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{1,3}),(\d{1,3})$/.exec(value);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

export function serializeColosseumStartTile(tile: Readonly<Coordinate>): string {
  return `${tile[0]},${tile[1]}`;
}

/** The stored start tile, or the default where it is unset, unreadable or off the floor. */
export function resolveColosseumStartTile(value: unknown): Coordinate {
  const tile = parseColosseumStartTile(value);
  return tile && isColosseumStartTileOpen(tile) ? tile : [...COLOSSEUM_WAVE_START_TILE];
}

/**
 * Something a layout asks for that the game would not produce with the player waiting on the start
 * tile, keyed by the point (`COLOSSEUM_SPAWN_POINTS` index) and its species:
 * - `spawn-too-close`: the point is within `SPAWN_POINT_PLAYER_CLEARANCE` (Chebyshev, SW tile) of
 *   the start tile, so the game leaves it out of the draw (`isSpawnPointClearOfPlayer`).
 * - `start-in-footprint`: the start tile is under the NPC's footprint. Always too close as well.
 */
export type ColosseumSpawnLayoutIssue =
  | {
      readonly kind: 'spawn-too-close';
      readonly point: number;
      readonly position: Coordinate;
      readonly species: ColosseumLayoutSpecies;
      /** Chebyshev, from the point's SW tile to the start tile. */
      readonly distance: number;
    }
  | {
      readonly kind: 'start-in-footprint';
      readonly point: number;
      readonly position: Coordinate;
      readonly species: ColosseumLayoutSpecies;
    };

/**
 * The warnings for `layout` with the run opening on `startTile`, in point order (a point's
 * `start-in-footprint` after its `spawn-too-close`). The game decides from the player's tile at the
 * start of T0 (`layout.ts`), which is the start tile only while the player waits on it; the warnings
 * assume they do. The random remainder always obeys the rule, so only chosen points can warn.
 *
 * Nothing else can be impossible here. The draw never runs short (at least five points are clear of
 * any floor tile and a wave starts at most four, so the chosen points leave enough), and Dynamic Duo
 * adds nothing: a partner always finds a floor footprint (`dynamicDuoPartnerTile`, which throws
 * otherwise), and one beside a clear primary never covers the start tile; beside a too-close one,
 * the primary already warns.
 */
export function colosseumSpawnLayoutWarnings(
  layout: ColosseumSpawnLayout,
  startTile: Readonly<Coordinate>,
): readonly ColosseumSpawnLayoutIssue[] {
  return layout.points.flatMap((species, point): ColosseumSpawnLayoutIssue[] => {
    if (species === null) return [];
    const position: Coordinate = [...COLOSSEUM_SPAWN_POINTS[point]!];
    if (isSpawnPointClearOfPlayer(position, startTile)) return [];
    const dx = startTile[0] - position[0];
    const dy = startTile[1] - position[1];
    const distance = Math.max(Math.abs(dx), Math.abs(dy));
    const size = COLOSSEUM_SPECIES_SIZES[species];
    const issues: ColosseumSpawnLayoutIssue[] = [{ kind: 'spawn-too-close', point, position, species, distance }];
    if (dx >= 0 && dx < size && dy >= 0 && dy < size) {
      issues.push({ kind: 'start-in-footprint', point, position: [...position], species });
    }
    return issues;
  });
}
