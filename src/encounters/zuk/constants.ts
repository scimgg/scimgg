import type { Coordinate } from '../../types/simulation';

export { ZUK_SHIELD_SIZE, ZUK_SPARK_IMPACT_DELAY_TICKS } from '../../npcs/inferno/constants';

export const ZUK_ARENA_BOUNDS = { minX: 17, maxX: 45, minY: 17, maxY: 46 } as const;

// Local cache seq 7562 lasts 150 client cycles (5 game ticks); retain one extra tick for renderer interpolation.
export const ZUK_VICTORY_COMPLETION_DELAY_TICKS = 6;

// discoverCacheUsage.ts requires literal *_MAP_X / *_MAP_Y pairs; offsets alone lose terrain in production trims.
export const ZUK_MAP_X = 35;
export const ZUK_MAP_Y = 83;
export const ZUK_NORTH_MAP_X = 35;
export const ZUK_NORTH_MAP_Y = 84;
export const ZUK_EAST_MAP_X = 36;
export const ZUK_EAST_MAP_Y = 83;
export const ZUK_SOUTH_MAP_X = 35;
export const ZUK_SOUTH_MAP_Y = 82;
export const ZUK_WEST_MAP_X = 34;
export const ZUK_WEST_MAP_Y = 83;
export const ZUK_MAP_SQUARE = { x: ZUK_MAP_X, y: ZUK_MAP_Y } as const;
// The playable floor is all in the origin square (the bake's walkable tiles span x 17-45, y 17-46),
// so the four neighbors only carry the surrounding terrain and scenery.
export const ZUK_MAP_SQUARE_OFFSETS = [
  { dx: 0, dy: 0 },
  { dx: ZUK_NORTH_MAP_X - ZUK_MAP_X, dy: ZUK_NORTH_MAP_Y - ZUK_MAP_Y, sceneryOnly: true },
  { dx: ZUK_EAST_MAP_X - ZUK_MAP_X, dy: ZUK_EAST_MAP_Y - ZUK_MAP_Y, sceneryOnly: true },
  { dx: ZUK_SOUTH_MAP_X - ZUK_MAP_X, dy: ZUK_SOUTH_MAP_Y - ZUK_MAP_Y, sceneryOnly: true },
  { dx: ZUK_WEST_MAP_X - ZUK_MAP_X, dy: ZUK_WEST_MAP_Y - ZUK_MAP_Y, sceneryOnly: true },
] as const;

/** Where a run that starts on wave 69 opens, and where the intro teleports the player (facing north). */
export const ZUK_PLAYER_START: Coordinate = [31, 44];

/**
 * Wave 69's intro after wave 68, in ticks relative to control C (`Wave: 69`, busy cleared), as both
 * captures record it: inferno-waves-69-zuk t14-t26 (C = 26) and inferno-waves-tbow-69-zuk t15-t27
 * (C = 27). Busy at C-12, teleport to (31, 44) facing north at C-10, glyph (at its alcove tile) and
 * Zuk added with the wall changes and the static glyph's `loc_del` at C-8, the two collapsing-wall
 * animations at C-7, the glyph's three steps south C-6..C-4, and the last two walls at C. A run that
 * starts on wave 69 opens at C, with none of this. Facts: docs/encounters/zuk-facts-spec.md (Intro).
 */
export const ZUK_INTRO = {
  busyFrom: -12,
  teleport: -10,
  add: -8,
  wallAnimation: -7,
  glyphWalkFrom: -6,
  glyphWalkTo: -4,
} as const;
/** The `inferno_visual` clip id Zuk rises with at the intro's add (seq 7563, `ZUK_SEQS.zuk.spawn`). */
export const ZUK_INTRO_RISE_CLIP = 'rise';
/**
 * The intro's two lines, in chat: the mesbox at C-12 (inferno-waves-69-zuk L2756) and the
 * dialogue at C-8 (L2833, speaker as the dialogue names him). The game shows them in its dialogue
 * box; the simulator has none, so they go to chat.
 */
export const ZUK_INTRO_MESSAGES = {
  busy: 'A great power is starting to shake the cavern...',
  prisonSpeaker: 'Tzhaar-Ket-Keh',
  prison: "No! TzKal-Zuk's prison is breaking down. There's nothing I can do for you now, JalYt!",
} as const;
/** The glyph's add tile, (2270, 5363) in both captures; it walks south to the patrol row. */
export const ZUK_INTRO_GLYPH_TILE: Coordinate = [30, 51];

// The static glyph creates a projectile wall where the moving NPC belongs. Keep the flanking rock outcrops.
export const ZUK_EXCLUDED_STATIC_LOC_IDS: ReadonlySet<number> = new Set([30338]);

export const ZUK_SHADOW_MIN_Y = 44;

// capture inferno-waves-69-zuk-packet-data.txt: control t26, first set t98.
export const ZUK_SET_OPENING_TICK = 72;
export const ZUK_SET_TIMER_INTERVAL = 350;
/** Added to the clock when Jad releases the freeze: 795 + 259 + 175 = 1229, the observed third set. */
export const ZUK_SET_TIMER_JAD_BONUS = 175;
