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
