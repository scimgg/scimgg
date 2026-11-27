import { ZULRAH_CLOUD } from '../../npcs/zulrah/constants';
import type { Coordinate } from '../../types/simulation';

/** A venom cloud: its 3x3 centre, the tick it lands, and the tick it is gone. */
export type ZulrahCloud = {
  readonly center: Coordinate;
  readonly landTick: number;
  readonly expireTick: number;
};

/**
 * Where clouds land: 3x3 sites over the island, leaving the arm tips (x 22-24 and 32-34, y 68-70)
 * clear, as the wiki says the opening fill does ("leaving the tips on the east and west sides
 * clear", https://oldschool.runescape.wiki/w/Zulrah/Strategies, All rotations). The sites are
 * simulator policy read off the cache's island geometry (`rotation.ts` `ZULRAH_SPOTS`).
 */
export const ZULRAH_CLOUD_SITES: readonly Coordinate[] = [
  [23, 61],
  [26, 62],
  [29, 61],
  [32, 62],
  [27, 60],
  [31, 60],
  [23, 65],
  [33, 65],
];

/**
 * The fill: the wiki describes a phase of 4 cloud barrages (the opening, the end of rotations 1-2's
 * jad phase, and each rotation's last phase) as filling the shrine "leaving the tips on the east and
 * west sides clear" (Zulrah/Strategies, All rotations and Rotations). Four barrages of two cover the
 * eight sites. Simulator policy for the order: the south of the base first and the arms last, so a
 * player on the base has time to run up an arm to its tip.
 */
export const ZULRAH_CLOUD_FILL_ORDER: readonly Coordinate[] = [
  [27, 60],
  [31, 60],
  [26, 62],
  [29, 61],
  [23, 61],
  [32, 62],
  [23, 65],
  [33, 65],
];

/** The barrages in a phase that fills the shrine. */
export const ZULRAH_FILL_BARRAGES = ZULRAH_CLOUD_FILL_ORDER.length / 2;

/** One fill barrage's sites, by its index within the phase. */
export function fillCloudSites(barrageIndex: number): Coordinate[] {
  const start = (barrageIndex % ZULRAH_FILL_BARRAGES) * 2;
  return ZULRAH_CLOUD_FILL_ORDER.slice(start, start + 2).map((site): Coordinate => [site[0], site[1]]);
}

/**
 * Picks one barrage's sites. Simulator policy: the first cloud lands on the site nearest the player,
 * so standing still is never safe, and the rest on other sites drawn at random.
 */
export function pickCloudSites(player: Coordinate, random: () => number): Coordinate[] {
  const byDistance = [...ZULRAH_CLOUD_SITES].sort(
    (a, b) => chebyshev(a, player) - chebyshev(b, player) || a[0] - b[0] || a[1] - b[1],
  );
  const [nearest, ...others] = byDistance;
  if (!nearest) return [];
  const picked: Coordinate[] = [nearest];
  const pool = [...others];
  while (picked.length < ZULRAH_CLOUD.perBarrage && pool.length > 0) {
    const index = Math.floor(random() * pool.length);
    const [site] = pool.splice(index, 1);
    if (site) picked.push(site);
  }
  return picked;
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
