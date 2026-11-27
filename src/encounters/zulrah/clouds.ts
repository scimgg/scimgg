import { ZULRAH_CLOUD } from '../../npcs/zulrah/constants';
import type { Coordinate } from '../../types/simulation';
import { ZULRAH_ROTATIONS, type ZulrahPosition, type ZulrahRotationNumber } from './rotation';

/** A venom cloud: its 3x3 centre, the tick it lands, and the tick it is gone. */
export type ZulrahCloud = {
  readonly center: Coordinate;
  readonly landTick: number;
  readonly expireTick: number;
};

/**
 * The nine cloud sites, by the cloud loc's south-west tile (its 3x3 center is one tile north-east), in
 * order around the island's U from the west arm's tip to the east arm's tip. All 108 cloud orbs (54
 * barrages) in four private gameplay captures (zulrah-packet-data-1.txt to -4.txt) targeted these,
 * from every spot. Every barrage's two sites were at most two steps apart on the U: 49 neighbors, and
 * 5 one site apart, all in zulrah-packet-data-3.txt (e.g. t894: (22, 61) and (28, 60)).
 */
export const ZULRAH_CLOUD_SITES: readonly Coordinate[] = [
  [22, 67],
  [22, 64],
  [22, 61],
  [25, 60],
  [28, 60],
  [31, 60],
  [32, 63],
  [32, 66],
  [32, 69],
];

/** One barrage's sites (south-west tiles): the first orb's, landing 3 ticks after the spit, then the second's. */
export type ZulrahCloudBarrage = readonly [Coordinate, Coordinate];

/**
 * The 4-barrage fill, the same in every capture that has one: the opening (zulrah-packet-data-2.txt
 * t2984-t2993), rotation 3's last phase (zulrah-packet-data-1.txt t466-t475) and rotation 2's
 * (zulrah-packet-data-4.txt t2224-t2233). Rotation 4's last phase opened on its first barrage
 * (zulrah-packet-data-3.txt t1090, before the player left). It never uses (32, 69), so the arm
 * tips (24, 70) and (32, 70) stay clear, as the wiki says ("leaving the tips on the east and west
 * sides clear", https://oldschool.runescape.wiki/w/Zulrah/Strategies, All rotations).
 */
export const ZULRAH_CLOUD_FILL: readonly ZulrahCloudBarrage[] = [
  [
    [28, 60],
    [31, 60],
  ],
  [
    [22, 61],
    [25, 60],
  ],
  [
    [32, 63],
    [32, 66],
  ],
  [
    [22, 67],
    [22, 64],
  ],
];

/**
 * Captured barrage sequences by rotation and phase index (`ZULRAH_ROTATIONS`). A repeated phase
 * repeated its sequence wherever the player stood: zulrah-packet-data-1.txt's red middle phase, at its
 * start (clouds removed t250-t263) and from t516; zulrah-packet-data-4.txt's rotation 2 phases 3, 4, 7
 * and 8, each the same as zulrah-packet-data-2.txt's.
 */
export const ZULRAH_CLOUD_SEQUENCES: Readonly<
  Partial<Record<ZulrahRotationNumber, Readonly<Record<number, readonly ZulrahCloudBarrage[]>>>>
> = {
  2: {
    // Green west, zulrah-packet-data-2.txt t3042, t3045, t3048.
    3: [
      [
        [32, 63],
        [31, 60],
      ],
      [
        [32, 66],
        [32, 69],
      ],
      [
        [28, 60],
        [25, 60],
      ],
    ],
    // Blue south, t3086, t3089.
    4: [
      [
        [22, 61],
        [25, 60],
      ],
      [
        [31, 60],
        [32, 63],
      ],
    ],
    // Blue south, t3174, t3180.
    7: [
      [
        [25, 60],
        [28, 60],
      ],
      [
        [31, 60],
        [32, 63],
      ],
    ],
    // Jad west, t3223-t3232.
    8: [
      [
        [22, 61],
        [25, 60],
      ],
      [
        [28, 60],
        [31, 60],
      ],
      [
        [22, 64],
        [22, 67],
      ],
      [
        [32, 63],
        [32, 66],
      ],
    ],
    // The last phase: the fill, zulrah-packet-data-4.txt t2224-t2233.
    10: ZULRAH_CLOUD_FILL,
  },
  3: {
    // Red middle, zulrah-packet-data-1.txt t516, t522, t528.
    2: [
      [
        [32, 69],
        [32, 66],
      ],
      [
        [31, 60],
        [28, 60],
      ],
      [
        [22, 64],
        [22, 61],
      ],
    ],
    // Green middle, t313, t316, t319.
    6: [
      [
        [32, 66],
        [32, 69],
      ],
      [
        [31, 60],
        [32, 63],
      ],
      [
        [28, 60],
        [25, 60],
      ],
    ],
    // Blue middle, t373, t376.
    8: [
      [
        [22, 64],
        [22, 67],
      ],
      [
        [25, 60],
        [22, 61],
      ],
    ],
    // The last phase: the fill (t466-t475).
    11: ZULRAH_CLOUD_FILL,
  },
  4: {
    // Red middle, zulrah-packet-data-3.txt t894, t897.
    4: [
      [
        [22, 61],
        [28, 60],
      ],
      [
        [25, 60],
        [31, 60],
      ],
    ],
    // Green south, t944, t947, t950: the same as rotation 3's green middle phase 6.
    6: [
      [
        [32, 66],
        [32, 69],
      ],
      [
        [31, 60],
        [32, 63],
      ],
      [
        [28, 60],
        [25, 60],
      ],
    ],
    // Blue middle, t1018, t1021, t1024.
    9: [
      [
        [22, 64],
        [25, 60],
      ],
      [
        [22, 61],
        [22, 67],
      ],
      [
        [28, 60],
        [31, 60],
      ],
    ],
  },
};

/**
 * A phase's barrage sequence, or null where it falls back to `randomCloudBarrage`:
 * - a captured phase (`ZULRAH_CLOUD_SEQUENCES`);
 * - the opening phase and each rotation's last phase, the fill: captured for the opening and rotations
 *   2 and 3, its first barrage for rotation 4, and INFERENCE for the rest of rotation 4's and for
 *   rotation 1's last phase, since three fills matched exactly.
 */
export function zulrahCloudSequence(position: ZulrahPosition): readonly ZulrahCloudBarrage[] | null {
  if (position.rotation === null) return position.index === 0 ? ZULRAH_CLOUD_FILL : null;
  const captured = ZULRAH_CLOUD_SEQUENCES[position.rotation]?.[position.index];
  if (captured) return captured;
  return position.index === ZULRAH_ROTATIONS[position.rotation].length - 1 ? ZULRAH_CLOUD_FILL : null;
}

/** The site pairs a barrage can hit: two sites at most `MAX_SITE_STEPS` apart on the U (15 pairs). */
const MAX_SITE_STEPS = 2;
const CLOUD_SITE_PAIRS: readonly ZulrahCloudBarrage[] = ZULRAH_CLOUD_SITES.flatMap((a, i) =>
  ZULRAH_CLOUD_SITES.slice(i + 1, i + 1 + MAX_SITE_STEPS).map((b): ZulrahCloudBarrage => [a, b]),
);

/**
 * Simulator policy for an uncaptured phase (FOR DISCUSSION): one of the 15 pairs of sites at most two
 * steps apart on the U, as every captured barrage was (`ZULRAH_CLOUD_SITES`), each equally likely, and
 * either orb first.
 */
export function randomCloudBarrage(random: () => number): ZulrahCloudBarrage {
  const index = Math.min(CLOUD_SITE_PAIRS.length - 1, Math.floor(random() * CLOUD_SITE_PAIRS.length));
  const pair = CLOUD_SITE_PAIRS[index];
  if (!pair) throw new RangeError(`No cloud site pair ${index}`);
  const [a, b] = pair;
  return random() < 0.5 ? [a, b] : [b, a];
}

/** A cloud's 3x3 center, from its loc's south-west tile. */
export function cloudCenter(site: Coordinate): Coordinate {
  return [site[0] + ZULRAH_CLOUD.radius, site[1] + ZULRAH_CLOUD.radius];
}

export function isInCloud(position: Coordinate, cloud: ZulrahCloud, tick: number): boolean {
  return tick >= cloud.landTick && tick < cloud.expireTick && chebyshev(position, cloud.center) <= ZULRAH_CLOUD.radius;
}

/** Clouds still worth keeping: landed or in flight, and not yet expired. */
export function liveClouds(clouds: readonly ZulrahCloud[], tick: number): ZulrahCloud[] {
  return clouds.filter((cloud) => tick < cloud.expireTick);
}

function chebyshev(a: Coordinate, b: Coordinate): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}
