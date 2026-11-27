import type { Coordinate } from '../../types/simulation';
import { cloudCenter, ZULRAH_CLOUD_SITES } from './clouds';
import type { ZulrahPosition, ZulrahRotationNumber } from './rotation';

/**
 * Where snakeling orbs land: the centers of the nine cloud sites (`ZULRAH_CLOUD_SITES`, south-west
 * tile + 1), in the same order around the U. All 51 snakeling orbs (1047) in four private gameplay
 * captures (zulrah-packet-data-1.txt to -4.txt) targeted one of these, wherever the player stood, and
 * each became a snakeling on its tile. Six landed on (33, 70), a tile the pinned cache's
 * walkable island leaves out (e.g. zulrah-packet-data-3.txt t944, walking off it on t947), so a site
 * is not checked for walkability.
 */
export const ZULRAH_SNAKELING_SITES: readonly Coordinate[] = ZULRAH_CLOUD_SITES.map(cloudCenter);

/**
 * Captured orb sequences by rotation and phase index (`ZULRAH_ROTATIONS`), in launch order. Rotation 3
 * phase 2 came round twice in zulrah-packet-data-1.txt and its last orb landed on (23, 68) both times
 * (t232, t531); zulrah-packet-data-4.txt repeated rotation 2's phases 4 and 7 exactly. Rotation 4 phase
 * 3's last orb (zulrah-packet-data-3.txt t813, (29, 61)) is the only one of its four captured, so that
 * phase stays on the fallback.
 */
export const ZULRAH_SNAKELING_SEQUENCES: Readonly<
  Partial<Record<ZulrahRotationNumber, Readonly<Record<number, readonly Coordinate[]>>>>
> = {
  2: {
    // Green west, zulrah-packet-data-2.txt t3052-t3061.
    3: [
      [26, 61],
      [23, 62],
      [23, 65],
      [23, 68],
    ],
    // Blue south, t3080, t3083, t3092, t3095.
    4: [
      [23, 68],
      [23, 65],
      [33, 67],
      [33, 70],
    ],
    // Blue south, t3171, t3177, t3183.
    7: [
      [23, 62],
      [23, 68],
      [23, 65],
    ],
  },
  3: {
    // Green east, zulrah-packet-data-1.txt t500, t503, t506.
    1: [
      [33, 70],
      [33, 67],
      [33, 64],
    ],
    // Red middle, t519, t525, t531.
    2: [
      [33, 64],
      [26, 61],
      [23, 68],
    ],
    // Green middle, t323, t326, t329.
    6: [
      [23, 62],
      [23, 68],
      [23, 65],
    ],
    // Blue middle, t379, t382, t385.
    8: [
      [29, 61],
      [32, 61],
      [33, 64],
    ],
    // Blue middle, t431-t440.
    10: [
      [23, 68],
      [23, 62],
      [33, 64],
      [33, 70],
    ],
  },
  4: {
    // Green south, zulrah-packet-data-3.txt t925-t940.
    6: [
      [23, 68],
      [23, 65],
      [23, 62],
      [33, 64],
      [33, 67],
      [33, 70],
    ],
    // Blue west, t975-t984.
    7: [
      [23, 68],
      [23, 65],
      [23, 62],
      [26, 61],
    ],
    // Blue middle, t1064-t1073.
    11: [
      [23, 68],
      [23, 65],
      [33, 67],
      [33, 70],
    ],
  },
};

/** A phase's captured orb sequence, or null where it falls back to `randomSnakelingSite`. */
export function zulrahSnakelingSequence(position: ZulrahPosition): readonly Coordinate[] | null {
  if (position.rotation === null) return null;
  return ZULRAH_SNAKELING_SEQUENCES[position.rotation]?.[position.index] ?? null;
}

/**
 * Simulator policy for an uncaptured orb (FOR DISCUSSION): a site at random among those the phase has
 * not used yet, as no captured phase used a site twice.
 */
export function randomSnakelingSite(random: () => number, used: readonly Coordinate[]): Coordinate {
  const unused = ZULRAH_SNAKELING_SITES.filter((site) => !used.some((u) => u[0] === site[0] && u[1] === site[1]));
  const candidates = unused.length > 0 ? unused : ZULRAH_SNAKELING_SITES;
  const site = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
  if (!site) throw new RangeError('No snakeling site');
  return site;
}
