/**
 * Zul-Andra's shrine: map squares 35_47 (region 9007) and 35_48 (region 9008), from the wiki's
 * Zulrah tile-marker regions (https://oldschool.runescape.wiki/w/Zulrah/Strategies). The island's
 * base lies in 35_47 and its two arms run north into 35_48, so both are loaded.
 */
export const ZULRAH_MAP_X = 35;
export const ZULRAH_MAP_Y = 47;
export const ZULRAH_MAP_SQUARE = { x: ZULRAH_MAP_X, y: ZULRAH_MAP_Y } as const;
export const ZULRAH_MAP_SQUARE_OFFSETS = [
  { dx: 0, dy: 0 },
  { dx: 0, dy: 1 },
] as const;

/**
 * The island's walkable tiles, as rows `[y, minX, maxX]`: the 69 tiles the pinned cache's arena bake
 * flood-fills from the player's start (the base y 60-63 between the pillars (25, 63) and (31, 63), and
 * the two arms up to y 70). `__tests__/zulrahArenaSight.test.ts` checks them against the bake.
 */
const ZULRAH_ISLAND_ROWS: readonly (readonly [number, number, number])[] = [
  [60, 26, 30],
  [61, 24, 32],
  [62, 22, 33],
  [63, 22, 24],
  [63, 32, 34],
  ...[64, 65, 66, 67, 68].flatMap((y): [number, number, number][] => [
    [y, 22, 24],
    [y, 32, 34],
  ]),
  [69, 23, 24],
  [69, 32, 34],
  [70, 24, 24],
  [70, 32, 32],
];

/** The island's walkable tiles, as `x,y` keys. */
export function zulrahIslandTiles(): Set<string> {
  const tiles = new Set<string>();
  for (const [y, minX, maxX] of ZULRAH_ISLAND_ROWS) for (let x = minX; x <= maxX; x++) tiles.add(`${x},${y}`);
  return tiles;
}
