/**
 * Facts extracted from private gameplay captures. Ticks are each capture's own, and no two overlap:
 * - zulrah-packet-data-1.txt (ticks 229-605, contiguous) covers rotation 3 from its magma phase, then
 *   the next rotation's phases 1-4, also rotation 3, the player dying at t567;
 * - zulrah-packet-data-2.txt (ticks 2957-3260) covers rotation 2 from the opening spawn through phase 10;
 * - zulrah-packet-data-3.txt (ticks 810-1094) covers rotation 4 from phase 3's last orb through phase 12's
 *   first barrage, with one phase the wiki's table does not list (`ZULRAH_CAPTURE_EXTRA_PHASE`);
 * - zulrah-packet-data-4.txt (ticks 2006-2301) covers rotation 2 from phase 3's last orb through phase 10,
 *   then the next rotation, rotation 2 again, through phase 3's barrages; the player uses a blowpipe,
 *   then a noxious halberd.
 * Phases are 0-based indexes into `ZULRAH_ROTATIONS`. Tiles are sim tiles, world - (2240, 3008) (map
 * square 35_47), and an NPC's tile is its south-west tile.
 */
import type { Coordinate } from '../../../../types/simulation';

/**
 * Projectile spotanims by what launches them. Capture 1: all 67 SNAKEBOSS_ATTACK_ACIDX1 (5069)
 * animations carry one: 1044 x27 and 1046 x11 at the player, 1045 in pairs at tiles (12 barrages), 1047
 * at a tile x17. t258: 1044 at the player, blocked to 0 by Protect from Missiles at t261; t313: two
 * 1045 aimed at tiles become clouds at t316 and t317. Captures 2, 3 and 4: the same mapping, 15, 12 and
 * 15 barrages.
 */
export const ZULRAH_CAPTURE_PROJECTILES = { ranged: 1044, cloudOrb: 1045, magic: 1046, snakelingOrb: 1047 } as const;

/** Flight in client cycles (30 a tick), the same on every launch of each kind and at every distance. */
export const ZULRAH_CAPTURE_FLIGHTS = {
  attack: { startCycle: 40, endCycle: 90 },
  /** The barrage's first and second orb. */
  cloudOrbs: [
    { startCycle: 40, endCycle: 90 },
    { startCycle: 45, endCycle: 120 },
  ],
  snakelingOrb: { startCycle: 40, endCycle: 120 },
} as const;

/** An attack launched on t258 lands its hit on t261. */
export const ZULRAH_CAPTURE_ATTACK_HIT = { launch: 258, hit: 261 } as const;

export type ZulrahCaptureFormChange = {
  /** SNAKEBOSS_SINKFAST (5072) at the old spot. */
  readonly sink: number;
  /** Moved, transformed and SNAKEBOSS_EMERGEFAST (5073), all on this tick. */
  readonly emerge: number;
  /** The new form's first action, or null where it made none (the t298 form attacked nothing). */
  readonly firstAction: number | null;
  readonly to: Coordinate;
};

/** All 12 form changes of capture 1, all 10 of capture 2, all 10 of capture 3, then all 10 of capture 4. */
export const ZULRAH_CAPTURE_FORM_CHANGES: readonly ZulrahCaptureFormChange[] = [
  { sink: 252, emerge: 255, firstAction: 258, to: [16, 63] },
  { sink: 273, emerge: 276, firstAction: 280, to: [26, 54] },
  { sink: 295, emerge: 298, firstAction: null, to: [36, 63] },
  { sink: 307, emerge: 310, firstAction: 313, to: [26, 65] },
  { sink: 333, emerge: 336, firstAction: 339, to: [16, 63] },
  { sink: 354, emerge: 357, firstAction: 360, to: [26, 65] },
  { sink: 389, emerge: 392, firstAction: 395, to: [36, 63] },
  { sink: 425, emerge: 428, firstAction: 431, to: [26, 65] },
  // Same spot: a transform with no move.
  { sink: 444, emerge: 447, firstAction: 450, to: [26, 65] },
  { sink: 479, emerge: 482, firstAction: 485, to: [36, 63] },
  { sink: 510, emerge: 513, firstAction: 516, to: [26, 65] },
  { sink: 552, emerge: 555, firstAction: 558, to: [16, 63] },
  // Capture 2. Same spot: a transform with no move.
  { sink: 2997, emerge: 3000, firstAction: 3003, to: [26, 65] },
  { sink: 3018, emerge: 3021, firstAction: 3024, to: [26, 65] },
  { sink: 3036, emerge: 3039, firstAction: 3042, to: [16, 63] },
  // E+6: the player was out of sight at E+3.
  { sink: 3065, emerge: 3068, firstAction: 3074, to: [26, 54] },
  { sink: 3099, emerge: 3102, firstAction: 3105, to: [26, 65] },
  { sink: 3122, emerge: 3125, firstAction: 3128, to: [36, 63] },
  { sink: 3145, emerge: 3148, firstAction: 3151, to: [26, 54] },
  { sink: 3187, emerge: 3190, firstAction: 3193, to: [16, 63] },
  { sink: 3236, emerge: 3239, firstAction: 3242, to: [26, 65] },
  // The capture ends on the emerge.
  { sink: 3257, emerge: 3260, firstAction: null, to: [26, 65] },
  // Capture 3. Blue west to blue middle: the extra phase, a move with no form change.
  { sink: 829, emerge: 832, firstAction: 835, to: [26, 65] },
  { sink: 872, emerge: 875, firstAction: 878, to: [26, 65] },
  { sink: 901, emerge: 904, firstAction: 907, to: [36, 63] },
  // South: the decoded move tile reads (38, 53) here; projectiles leave from (27-29, 57).
  { sink: 919, emerge: 922, firstAction: 925, to: [26, 54] },
  { sink: 954, emerge: 957, firstAction: 960, to: [16, 63] },
  { sink: 988, emerge: 991, firstAction: 994, to: [26, 65] },
  // E+8 and E+10: the player was out of sight behind the east pillar, (32, 62).
  { sink: 1007, emerge: 1010, firstAction: 1018, to: [26, 65] },
  { sink: 1028, emerge: 1031, firstAction: 1034, to: [36, 63] },
  { sink: 1058, emerge: 1061, firstAction: 1064, to: [26, 65] },
  { sink: 1077, emerge: 1080, firstAction: 1090, to: [26, 65] },
  // Capture 4. South's decoded move tile reads (33, 50) here.
  { sink: 2012, emerge: 2015, firstAction: 2018, to: [26, 54] },
  { sink: 2052, emerge: 2055, firstAction: 2058, to: [26, 65] },
  { sink: 2074, emerge: 2077, firstAction: 2080, to: [36, 63] },
  { sink: 2095, emerge: 2098, firstAction: 2101, to: [26, 54] },
  { sink: 2132, emerge: 2135, firstAction: 2138, to: [16, 63] },
  { sink: 2181, emerge: 2184, firstAction: 2187, to: [26, 65] },
  { sink: 2202, emerge: 2205, firstAction: 2208, to: [26, 65] },
  { sink: 2237, emerge: 2240, firstAction: 2243, to: [26, 65] },
  { sink: 2259, emerge: 2262, firstAction: 2265, to: [26, 65] },
  { sink: 2277, emerge: 2280, firstAction: 2283, to: [16, 63] },
];

/**
 * Zulrah's south-west tile at each spot. Middle, west and east are the tracked NPC tiles. South is
 * derived: the tracked tile after the t276 move reads (33, 50), but Zulrah's projectiles leave from
 * (27, 57), the player's spells at it (t281, t286, t291) target (28, 56) = SW + 2, as at every other
 * spot, and the facing angles both ways (Zulrah 872 at t280; the player 1897 at t281 from (24, 64),
 * 1879 at t286 from (24, 63)) are exact for a center of (28.5, 56.5). Hence (26, 54). Capture 2 agrees
 * on every signal but the decoded move, which reads (34, 54) there (t3068, t3148): projectiles leave
 * from (27-29, 57), spells target (28, 56) (t3164, t3169), and Zulrah faces (24, 64) at 872 (t3074).
 */
export const ZULRAH_CAPTURE_SPOTS = {
  middle: [26, 65],
  west: [16, 63],
  east: [36, 63],
  south: [26, 54],
} as const satisfies Record<string, Coordinate>;

/** Every emergence between forms faces this tile (capture 1, 12/12; capture 2, 10/10). */
export const ZULRAH_CAPTURE_EMERGE_FACING_TILE: Coordinate = [28, 62];

export type ZulrahCaptureDive = {
  readonly after: 'attack' | 'cloud' | 'snakeling' | 'tailHit';
  /** The last attack, barrage or orb launch, or the last tail's hit. */
  readonly tick: number;
  readonly dive: number;
};

/** The dive comes on the tick the phase's last projectile lands, or 3 ticks after the last tail hit. */
export const ZULRAH_CAPTURE_DIVES: readonly ZulrahCaptureDive[] = [
  { after: 'attack', tick: 270, dive: 273 },
  { after: 'attack', tick: 292, dive: 295 },
  { after: 'attack', tick: 351, dive: 354 },
  { after: 'attack', tick: 422, dive: 425 },
  { after: 'cloud', tick: 475, dive: 479 },
  { after: 'snakeling', tick: 329, dive: 333 },
  { after: 'snakeling', tick: 385, dive: 389 },
  { after: 'snakeling', tick: 440, dive: 444 },
  { after: 'snakeling', tick: 506, dive: 510 },
  { after: 'tailHit', tick: 249, dive: 252 },
  { after: 'tailHit', tick: 549, dive: 552 },
  // Capture 2.
  { after: 'cloud', tick: 2993, dive: 2997 },
  { after: 'cloud', tick: 3232, dive: 3236 },
  { after: 'attack', tick: 3033, dive: 3036 },
  { after: 'snakeling', tick: 3061, dive: 3065 },
  { after: 'snakeling', tick: 3095, dive: 3099 },
  { after: 'snakeling', tick: 3183, dive: 3187 },
  { after: 'tailHit', tick: 3015, dive: 3018 },
  { after: 'tailHit', tick: 3119, dive: 3122 },
  { after: 'tailHit', tick: 3254, dive: 3257 },
  // Capture 3. Not listed: the extra phase dived 4 ticks after its last attack (t868 to t872).
  { after: 'attack', tick: 826, dive: 829 },
  { after: 'attack', tick: 916, dive: 919 },
  { after: 'attack', tick: 1055, dive: 1058 },
  { after: 'cloud', tick: 897, dive: 901 },
  { after: 'cloud', tick: 950, dive: 954 },
  { after: 'cloud', tick: 1024, dive: 1028 },
  { after: 'snakeling', tick: 984, dive: 988 },
  { after: 'snakeling', tick: 1073, dive: 1077 },
  // Capture 4.
  { after: 'attack', tick: 2092, dive: 2095 },
  { after: 'attack', tick: 2274, dive: 2277 },
  { after: 'cloud', tick: 2177, dive: 2181 },
  { after: 'cloud', tick: 2233, dive: 2237 },
  { after: 'snakeling', tick: 2048, dive: 2052 },
  { after: 'snakeling', tick: 2128, dive: 2132 },
  { after: 'tailHit', tick: 2071, dive: 2074 },
  { after: 'tailHit', tick: 2199, dive: 2202 },
  { after: 'tailHit', tick: 2256, dive: 2259 },
];

/**
 * One barrage: each orb's target tile is the cloud LOC's south-west tile (11700, 3x3); the cloud
 * appears on its orb's landing tick and is removed 30 ticks later (17/17 clouds that landed in
 * time). Zulrah faces the first cloud's center, (33, 67), as it spits.
 */
export const ZULRAH_CAPTURE_CLOUD_BARRAGE = {
  launch: 313,
  facing: [33, 67],
  orbs: [
    { target: [32, 66], lands: 316, removed: 346 },
    { target: [32, 69], lands: 317, removed: 347 },
  ],
} as const;

/** Snakeling orbs that landed before a dive: the snakeling appears on the orb's tile as it lands. */
export const ZULRAH_CAPTURE_SNAKELING_ORBS: readonly { readonly launch: number; readonly lands: number }[] = [
  { launch: 232, lands: 236 },
  { launch: 323, lands: 327 },
  { launch: 326, lands: 330 },
  { launch: 379, lands: 383 },
  { launch: 382, lands: 386 },
  { launch: 431, lands: 435 },
  { launch: 434, lands: 438 },
  { launch: 437, lands: 441 },
  { launch: 500, lands: 504 },
  { launch: 503, lands: 507 },
  { launch: 519, lands: 523 },
  { launch: 525, lands: 529 },
  { launch: 531, lands: 535 },
  // Capture 3.
  { launch: 813, lands: 817 },
  { launch: 925, lands: 929 },
  { launch: 928, lands: 932 },
  { launch: 931, lands: 935 },
  { launch: 934, lands: 938 },
  { launch: 937, lands: 941 },
  { launch: 940, lands: 944 },
  { launch: 975, lands: 979 },
  { launch: 978, lands: 982 },
  { launch: 981, lands: 985 },
  { launch: 1064, lands: 1068 },
  { launch: 1067, lands: 1071 },
  { launch: 1070, lands: 1074 },
  // Capture 4.
  { launch: 2033, lands: 2037 },
  { launch: 2036, lands: 2040 },
  { launch: 2045, lands: 2049 },
  { launch: 2116, lands: 2120 },
  { launch: 2122, lands: 2126 },
];

/** Zulrah faces the snakeling orb's target tile as it spits: t323, orb at (23, 62), facing (23, 62). */
export const ZULRAH_CAPTURE_SNAKELING_FACING = { launch: 323, target: [23, 62], facing: [23, 62] } as const;

/**
 * Orbs whose landing tick is the dive (SINKFAST) tick: the effect comes on the next form's first-action
 * tick (emerge + 3) instead, even where that form first acts later (t3068, emerge; snakeling t3071;
 * first attack t3074). The barrages' first orbs (t475, landing t478; t2993; t3232) appeared on time.
 */
export const ZULRAH_CAPTURE_DEFERRED: readonly {
  readonly kind: 'snakeling' | 'cloud';
  readonly launch: number;
  readonly dive: number;
  readonly appears: number;
  readonly removed?: number;
}[] = [
  { kind: 'snakeling', launch: 329, dive: 333, appears: 339 },
  { kind: 'snakeling', launch: 385, dive: 389, appears: 395 },
  { kind: 'snakeling', launch: 440, dive: 444, appears: 450 },
  { kind: 'snakeling', launch: 506, dive: 510, appears: 516 },
  { kind: 'cloud', launch: 475, dive: 479, appears: 485, removed: 515 },
  // Capture 2.
  { kind: 'snakeling', launch: 3061, dive: 3065, appears: 3071 },
  { kind: 'snakeling', launch: 3095, dive: 3099, appears: 3105 },
  { kind: 'snakeling', launch: 3183, dive: 3187, appears: 3193 },
  { kind: 'cloud', launch: 2993, dive: 2997, appears: 3003 },
  { kind: 'cloud', launch: 3232, dive: 3236, appears: 3242 },
  // Capture 3: each barrage's second orb.
  { kind: 'snakeling', launch: 984, dive: 988, appears: 994 },
  { kind: 'snakeling', launch: 1073, dive: 1077, appears: 1083 },
  { kind: 'cloud', launch: 897, dive: 901, appears: 907 },
  { kind: 'cloud', launch: 950, dive: 954, appears: 960 },
  { kind: 'cloud', launch: 1024, dive: 1028, appears: 1034 },
  // Capture 4.
  { kind: 'snakeling', launch: 2008, dive: 2012, appears: 2018 },
  { kind: 'snakeling', launch: 2048, dive: 2052, appears: 2058 },
  { kind: 'snakeling', launch: 2128, dive: 2132, appears: 2138 },
  { kind: 'cloud', launch: 2177, dive: 2181, appears: 2187 },
  { kind: 'cloud', launch: 2233, dive: 2237, appears: 2243 },
];

/**
 * A tail hit with no knockback (capture 2, t3015): the stun graphic (spotanim 245, stunned_thieving,
 * height 124) plays, "You're stunned!" answers clicks on t3016-t3021, and the player first moves on
 * t3022; capture 4 the same, hit t2064, stunned t2065-t2070, first move t2071. A knockback (not
 * modeled) adds a tick: t3119 to t3127; capture 1, t549 to t557. Capture 4's east knockback, hit
 * t2256, first moved t2265, an upper bound, as stunned clicks were not made every tick.
 */
export const ZULRAH_CAPTURE_TAIL_STUN = {
  hit: 3015,
  lastStunnedTick: 3021,
  firstMove: 3022,
  spotAnimId: 245,
} as const;

/**
 * The opening (capture 2): Zulrah is added at the middle spot on SNAKEBOSS_SPAWN (5071) on t2973,
 * facing south; the player's attack click on t2977 casts at once and hits on t2981; Zulrah keeps facing
 * south until its first action, a barrage, on t2984.
 */
export const ZULRAH_CAPTURE_OPENING = {
  spawn: 2973,
  spawnFacing: 0,
  firstCast: 2977,
  hit: 2981,
  firstAction: 2984,
} as const;

/**
 * Attacking a fresh form (capture 2): emerge t3239; three attack clicks on each of t3241 and t3242 made
 * no attack; it went off on t3243, with no weapon cooldown pending (the last cast was t3186).
 */
export const ZULRAH_CAPTURE_FIRST_ATTACKABLE = { emerge: 3239, refused: [3241, 3242], attack: 3243 } as const;

/**
 * Snakelings left alone, never hit, die off (SNAKEBOSS_PET_DEATH 2408) 50-53 ticks after appearing, 51
 * in 4 of 8, and are removed 2 ticks later.
 */
export const ZULRAH_CAPTURE_SNAKELING_DEATHS: readonly {
  readonly capture: 1 | 2 | 3;
  readonly appears: number;
  readonly death: number;
  readonly removed: number;
}[] = [
  { capture: 1, appears: 435, death: 485, removed: 487 },
  { capture: 1, appears: 438, death: 488, removed: 490 },
  { capture: 2, appears: 3096, death: 3147, removed: 3149 },
  { capture: 2, appears: 3105, death: 3156, removed: 3158 },
  { capture: 2, appears: 3181, death: 3232, removed: 3234 },
  { capture: 2, appears: 3193, death: 3244, removed: 3246 },
  { capture: 3, appears: 929, death: 981, removed: 983 },
  { capture: 3, appears: 935, death: 988, removed: 990 },
];

/** A snakeling killed by recoil (capture 2): the hit on t3197, the death animation t3198, removed t3200. */
export const ZULRAH_CAPTURE_SNAKELING_KILL = { hit: 3197, death: 3198, removed: 3200 } as const;

export type ZulrahCaptureSightTile = {
  readonly spot: 'middle' | 'east' | 'south';
  /** The player's tile at the start of the tick (where it ended the previous one). */
  readonly tile: Coordinate;
  readonly visible: boolean;
  /** The capture, and the turns seen from this tile: attacks if visible, due and unmade if not. */
  readonly capture: 1 | 2 | 3;
  readonly ticks: readonly number[];
};

/**
 * Line of sight from the player's tile to Zulrah at each spot, by its due ranged and magic turns. The
 * pillars that hide the player are the single tiles (25, 63) and (31, 63) (the pinned cache's only
 * projectile blockers on the island).
 */
export const ZULRAH_CAPTURE_SIGHT: readonly ZulrahCaptureSightTile[] = [
  { spot: 'east', tile: [24, 63], visible: false, capture: 1, ticks: [301, 304] },
  { spot: 'east', tile: [24, 63], visible: false, capture: 2, ticks: [3137, 3140, 3143] },
  { spot: 'east', tile: [24, 64], visible: true, capture: 2, ticks: [3131, 3134] },
  { spot: 'east', tile: [23, 66], visible: true, capture: 2, ticks: [3128] },
  { spot: 'south', tile: [24, 68], visible: false, capture: 2, ticks: [3071] },
  { spot: 'south', tile: [24, 66], visible: false, capture: 2, ticks: [3073] },
  { spot: 'south', tile: [24, 65], visible: false, capture: 2, ticks: [3160, 3163] },
  { spot: 'south', tile: [24, 64], visible: true, capture: 2, ticks: [3074, 3077, 3157, 3168] },
  { spot: 'south', tile: [24, 63], visible: true, capture: 2, ticks: [3151, 3154, 3165] },
  { spot: 'middle', tile: [24, 62], visible: false, capture: 1, ticks: [363, 366, 369, 372] },
  { spot: 'middle', tile: [24, 67], visible: true, capture: 1, ticks: [360] },
  // Behind the east pillar: the extra phase, rotation 4 phases 8, 9 and 12.
  {
    spot: 'middle',
    tile: [32, 62],
    visible: false,
    capture: 3,
    ticks: [844, 847, 997, 1000, 1003, 1006, 1013, 1016, 1083, 1086, 1089],
  },
  { spot: 'middle', tile: [32, 63], visible: true, capture: 3, ticks: [849, 994] },
];

/**
 * A due attack waiting off its 3-tick grid (capture 2, blue south): an attack on t3157 from (24, 64);
 * hidden at (24, 65) t3160-t3164; the player reached (24, 63) at the end of t3164 and the attack went
 * off on t3165, then t3168. The phase made all 5 of its attacks.
 */
export const ZULRAH_CAPTURE_SIGHT_RESUME = {
  attack: 3157,
  hidden: [24, 65],
  hiddenThrough: 3164,
  seenFrom: [24, 63],
  resumed: 3165,
  next: 3168,
} as const satisfies Record<string, number | Coordinate>;

/**
 * The give-up the policy reproduces (capture 2, green east, rotation 2 phase 7, no specials after): the
 * third attack on t3134, its next due and blocked from t3137 on, the dive on t3145.
 */
export const ZULRAH_CAPTURE_SIGHT_GIVE_UP = { lastAttack: 3134, blockedFrom: 3137, dive: 3145 } as const;

/**
 * Cloud barrages by phase: each barrage's two SNAKEBOSS_DOUBLE_ORB (1045) targets, the cloud locs'
 * south-west tiles, the 40-90 cycle orb first and the 45-120 one second. `index` is the phase's index
 * in `ZULRAH_ROTATIONS[rotation]`; the opening is rotation 2's phase 0 here. A `partial` phase's capture
 * ends before its last barrage.
 */
export const ZULRAH_CAPTURE_CLOUD_SEQUENCES: readonly {
  readonly capture: 1 | 2 | 3 | 4;
  readonly rotation: 2 | 3 | 4;
  readonly index: number;
  readonly launches: readonly number[];
  readonly barrages: readonly (readonly [Coordinate, Coordinate])[];
  readonly partial?: true;
}[] = [
  {
    capture: 2,
    rotation: 2,
    index: 0,
    launches: [2984, 2987, 2990, 2993],
    barrages: [
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
    ],
  },
  {
    capture: 2,
    rotation: 2,
    index: 3,
    launches: [3042, 3045, 3048],
    barrages: [
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
  },
  {
    capture: 2,
    rotation: 2,
    index: 4,
    launches: [3086, 3089],
    barrages: [
      [
        [22, 61],
        [25, 60],
      ],
      [
        [31, 60],
        [32, 63],
      ],
    ],
  },
  {
    capture: 2,
    rotation: 2,
    index: 7,
    launches: [3174, 3180],
    barrages: [
      [
        [25, 60],
        [28, 60],
      ],
      [
        [31, 60],
        [32, 63],
      ],
    ],
  },
  {
    capture: 2,
    rotation: 2,
    index: 8,
    launches: [3223, 3226, 3229, 3232],
    barrages: [
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
  },
  {
    capture: 1,
    rotation: 3,
    index: 2,
    launches: [516, 522, 528],
    barrages: [
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
  },
  {
    capture: 1,
    rotation: 3,
    index: 6,
    launches: [313, 316, 319],
    barrages: [
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
  },
  {
    capture: 1,
    rotation: 3,
    index: 8,
    launches: [373, 376],
    barrages: [
      [
        [22, 64],
        [22, 67],
      ],
      [
        [25, 60],
        [22, 61],
      ],
    ],
  },
  {
    capture: 1,
    rotation: 3,
    index: 11,
    launches: [466, 469, 472, 475],
    barrages: [
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
    ],
  },
  {
    capture: 3,
    rotation: 4,
    index: 4,
    launches: [894, 897],
    barrages: [
      [
        [22, 61],
        [28, 60],
      ],
      [
        [25, 60],
        [31, 60],
      ],
    ],
  },
  {
    capture: 3,
    rotation: 4,
    index: 6,
    launches: [944, 947, 950],
    barrages: [
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
  },
  {
    capture: 3,
    rotation: 4,
    index: 9,
    launches: [1018, 1021, 1024],
    barrages: [
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
  // Capture 4: rotation 2 again, each the same as capture 2's, and phase 10's fill.
  {
    capture: 4,
    rotation: 2,
    index: 3,
    launches: [2283, 2286, 2289],
    barrages: [
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
  },
  {
    capture: 4,
    rotation: 2,
    index: 4,
    launches: [2039, 2042],
    barrages: [
      [
        [22, 61],
        [25, 60],
      ],
      [
        [31, 60],
        [32, 63],
      ],
    ],
  },
  {
    capture: 4,
    rotation: 2,
    index: 7,
    launches: [2119, 2125],
    barrages: [
      [
        [25, 60],
        [28, 60],
      ],
      [
        [31, 60],
        [32, 63],
      ],
    ],
  },
  {
    capture: 4,
    rotation: 2,
    index: 8,
    launches: [2168, 2171, 2174, 2177],
    barrages: [
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
  },
  {
    capture: 4,
    rotation: 2,
    index: 10,
    launches: [2224, 2227, 2230, 2233],
    barrages: [
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
    ],
  },
  // The player teleported out after the first barrage.
  {
    capture: 3,
    rotation: 4,
    index: 12,
    launches: [1090],
    barrages: [
      [
        [28, 60],
        [31, 60],
      ],
    ],
    partial: true,
  },
];

/** The cloud sites every capture barrage used (78 orbs), around the U from the west arm's tip. */
export const ZULRAH_CAPTURE_CLOUD_SITES: readonly Coordinate[] = [
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

/**
 * Snakeling orbs (SNAKEBOSS_EGG 1047) by phase: each orb's target tile, where its snakeling appears, in
 * launch order. All 51 orbs of four captures targeted one of the nine cloud sites' centers. A `partial`
 * phase's capture begins after its first orbs.
 */
export const ZULRAH_CAPTURE_SNAKELING_SEQUENCES: readonly {
  readonly capture: 1 | 2 | 3 | 4;
  readonly rotation: 2 | 3 | 4;
  readonly index: number;
  readonly launches: readonly number[];
  readonly sites: readonly Coordinate[];
  readonly partial?: true;
}[] = [
  {
    capture: 1,
    rotation: 3,
    index: 1,
    launches: [500, 503, 506],
    sites: [
      [33, 70],
      [33, 67],
      [33, 64],
    ],
  },
  {
    capture: 1,
    rotation: 3,
    index: 2,
    launches: [519, 525, 531],
    sites: [
      [33, 64],
      [26, 61],
      [23, 68],
    ],
  },
  // The same phase's previous round, from its last orb (the capture began at t229).
  { capture: 1, rotation: 3, index: 2, launches: [232], sites: [[23, 68]], partial: true },
  {
    capture: 1,
    rotation: 3,
    index: 6,
    launches: [323, 326, 329],
    sites: [
      [23, 62],
      [23, 68],
      [23, 65],
    ],
  },
  {
    capture: 1,
    rotation: 3,
    index: 8,
    launches: [379, 382, 385],
    sites: [
      [29, 61],
      [32, 61],
      [33, 64],
    ],
  },
  {
    capture: 1,
    rotation: 3,
    index: 10,
    launches: [431, 434, 437, 440],
    sites: [
      [23, 68],
      [23, 62],
      [33, 64],
      [33, 70],
    ],
  },
  {
    capture: 2,
    rotation: 2,
    index: 3,
    launches: [3052, 3055, 3058, 3061],
    sites: [
      [26, 61],
      [23, 62],
      [23, 65],
      [23, 68],
    ],
  },
  {
    capture: 2,
    rotation: 2,
    index: 4,
    launches: [3080, 3083, 3092, 3095],
    sites: [
      [23, 68],
      [23, 65],
      [33, 67],
      [33, 70],
    ],
  },
  {
    capture: 2,
    rotation: 2,
    index: 7,
    launches: [3171, 3177, 3183],
    sites: [
      [23, 62],
      [23, 68],
      [23, 65],
    ],
  },
  // Capture 4: rotation 2 again, each the same as capture 2's.
  { capture: 4, rotation: 2, index: 3, launches: [2008], sites: [[23, 68]], partial: true },
  {
    capture: 4,
    rotation: 2,
    index: 4,
    launches: [2033, 2036, 2045, 2048],
    sites: [
      [23, 68],
      [23, 65],
      [33, 67],
      [33, 70],
    ],
  },
  {
    capture: 4,
    rotation: 2,
    index: 7,
    launches: [2116, 2122, 2128],
    sites: [
      [23, 62],
      [23, 68],
      [23, 65],
    ],
  },
  { capture: 3, rotation: 4, index: 3, launches: [813], sites: [[29, 61]], partial: true },
  {
    capture: 3,
    rotation: 4,
    index: 6,
    launches: [925, 928, 931, 934, 937, 940],
    sites: [
      [23, 68],
      [23, 65],
      [23, 62],
      [33, 64],
      [33, 67],
      [33, 70],
    ],
  },
  {
    capture: 3,
    rotation: 4,
    index: 7,
    launches: [975, 978, 981, 984],
    sites: [
      [23, 68],
      [23, 65],
      [23, 62],
      [26, 61],
    ],
  },
  {
    capture: 3,
    rotation: 4,
    index: 11,
    launches: [1064, 1067, 1070, 1073],
    sites: [
      [23, 68],
      [23, 65],
      [33, 67],
      [33, 70],
    ],
  },
];

/**
 * A phase the wiki's rotation 4 table does not list (capture 3), between phases 3 and 4: after blue
 * west, Zulrah surfaced blue at the middle (t832, moved and transformed with no form change), spat 3
 * barrages, made 7 attacks from t849, the first tick it saw the player after t844-t848 behind the east
 * pillar (one 4-tick gap, t855 to t859), and dived 4 ticks after the last. One observation; the table
 * is unchanged.
 */
export const ZULRAH_CAPTURE_EXTRA_PHASE = {
  emerge: 832,
  launches: [835, 838, 841],
  barrages: [
    [
      [22, 67],
      [22, 64],
    ],
    [
      [32, 66],
      [32, 69],
    ],
    [
      [25, 60],
      [31, 60],
    ],
  ],
  attacks: [849, 852, 855, 859, 862, 865, 868],
  styles: ['magic', 'magic', 'range', 'range', 'magic', 'magic', 'magic'],
  dive: 872,
} as const;
