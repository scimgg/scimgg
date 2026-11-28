import type { Coordinate } from '../../../../types/simulation';

// 20261127-024405-Duke-Sucellus_9.jsonl:8217–8541. At 201 Duke aims away
// from the armed west grate. At 203 and 208 the player is in gas between pulses.
export const DUKE_VENT_DAMAGE_CAPTURE = {
  beforeLaunch: [29, 51],
  firstTick: 198,
  moves: [
    [28, 50],
    [28, 50],
    [27, 51],
    [27, 51],
    [28, 49],
    [30, 47],
    [30, 47],
    [32, 47],
    [32, 49],
    [32, 51],
    [32, 51],
    [33, 49],
  ] satisfies Coordinate[],
  launches: [
    { tick: 198, grate: [28, 50] },
    { tick: 201, grate: [31, 50] },
    { tick: 203, grate: [28, 46] },
    { tick: 205, grate: [31, 46] },
  ],
  hits: [202, 207, 209],
} as const;

// 20261127-192944-Duke-Sucellus_12.jsonl:6972–7313. At 146 the player
// is equally far from two available west grates, and Duke targets the northern one.
export const DUKE_VENT_TIE_CAPTURE = {
  beforeLaunch: [35, 51],
  firstTick: 139,
  moves: [
    [35, 51],
    [35, 51],
    [34, 49],
    [33, 47],
    [33, 47],
    [31, 47],
    [29, 48],
    [29, 48],
    [29, 50],
    [29, 51],
    [29, 51],
    [29, 50],
    [29, 49],
    [29, 49],
  ] satisfies Coordinate[],
  launches: [
    { tick: 139, grate: [34, 50] },
    { tick: 142, grate: [34, 46] },
    { tick: 144, grate: [34, 46] },
    { tick: 146, grate: [28, 50] },
  ],
  hits: [150, 152],
} as const;

// 20261127-022231-Duke-Sucellus_7.jsonl:5340–5664 and
// 20261127-012348-Duke-Sucellus_3.jsonl:12795–13086. Smoke NPC spot 2432 is
// renewed at each pulse. The final pulse is two ticks before spot 2433 (fade).
export const DUKE_VENT_PULSE_CAPTURES = [
  { phase: 'opening', pulses: [4, 6, 8, 10, 12, 14, 16], fade: 18 },
  { phase: 'enrage', pulses: [4, 6, 8, 10, 12, 14], fade: 16 },
] as const;

// 20261126-232238-Duke.jsonl, ticks 44–48 and 97–101. Tiles are local to the arena.
export const DUKE_SLAM_REENTRIES: ReadonlyArray<{
  windupTick: number;
  beforeWindup: Coordinate;
  cover: Coordinate;
  reentry: Coordinate;
}> = [
  { windupTick: 45, beforeWindup: [28, 51], cover: [27, 51], reentry: [28, 51] },
  { windupTick: 98, beforeWindup: [35, 51], cover: [35, 51], reentry: [34, 51] },
];

// 20261126-232238-Duke.jsonl:4695–4704 and the area sounds following that windup.
export const DUKE_SLAM_CAPTURE = {
  frontRowGraphics: [2440, 2441, 2442, 2443, 2442, 2441, 2440],
  sounds: [
    { id: 2707, cycle: 0 },
    { id: 7177, cycle: 5 },
    { id: 7168, cycle: 39 },
    { id: 7224, cycle: 40 },
  ],
};

// 20261127-002024-Duke-Sucellus_1.jsonl:8637, :8663–8667 and :8716–8751.
export const DUKE_MAGIC_AIM_CAPTURE = {
  launch: { visibleTile: [30, 50] as Coordinate, trueTile: [29, 50] as Coordinate },
  impact: { visibleTile: [29, 51] as Coordinate, trueTile: [27, 51] as Coordinate },
};

// 20261127-005253-Duke-Sucellus_2.jsonl:12874–12932, :12983 and :12991.
export const DUKE_ENRAGED_MAGIC_CAPTURE = {
  windupTick: 430,
  nextWindupTick: 434,
  launchCycle: 50,
  arrivalCycle: 120,
  sounds: [
    { id: 7161, cycle: 1 },
    { id: 7214, cycle: 50 },
  ],
};

// 20261127-025030-Duke-Sucellus_10.jsonl:11185–11632. Three enraged basics between volleys.
export const DUKE_ENRAGE_VOLLEY_CAPTURE = {
  basicTicks: [346, 350, 354],
  flareTicks: [358, 361, 363, 365],
};

// 20261127-025030-Duke-Sucellus_10.jsonl. Each example starts on a four-flare windup.
export const DUKE_PHASE_VOLLEY_CAPTURES = [
  // Lines 5782–6462, above the bile threshold.
  { phase: 'vents', label: 'Vents', hp: 1289, flareTicks: [86, 89, 91, 93], nextVolleyTick: 123, bileTick: null },
  // Lines 6462–7350, below the bile threshold and above the orb threshold.
  { phase: 'bile', label: 'Bile', hp: 1103, flareTicks: [123, 126, 128, 130], nextVolleyTick: 165, bileTick: 134 },
  // Lines 9146–10065, with the orb active and Duke above enrage.
  { phase: 'orbs', label: 'Orbs', hp: 560, flareTicks: [254, 257, 259, 261], nextVolleyTick: 296, bileTick: null },
] as const;

// 20261127-025030-Duke-Sucellus_10.jsonl:5069–5087. The warning arrives at windup.
export const DUKE_FLARE_SOUNDS = [
  { id: 5002, cycle: 0, channel: 'sfx' },
  { id: 7179, cycle: 1, channel: 'area' },
  { id: 7248, cycle: 35, channel: 'area' },
];

// 20261127-025030-Duke-Sucellus_10.jsonl:6165–6167 and :6674–6680.
export const DUKE_HIT_SOUND_CAPTURES = [
  { firstHitBlocked: true, tick: 106, hitSounds: 0 },
  { firstHitBlocked: false, tick: 133, hitSounds: 1 },
];

// 20261127-022231-Duke-Sucellus_7.jsonl:9307–9382. Boss HP from damage since wakeup.
export const DUKE_ORB_ACTIVATION_CAPTURE = { thresholdTick: 252, spawnTick: 255, hpAfterHit: 547 };

// 20261127-025030-Duke-Sucellus_10.jsonl:11893–12031.
export const DUKE_FAILED_GAZE_CAPTURE = {
  windupTick: 376,
  messageTick: 380,
  hitTick: 381,
  beforeCover: [33, 49] as Coordinate,
  cover: [35, 51] as Coordinate,
};

// 20261127-023028-Duke-Sucellus_8.jsonl:10279–10413. Magic arrives as Duke starts melee.
export const DUKE_ENRAGED_MAGIC_TO_MELEE_CAPTURE = {
  windupTick: 311,
  nextWindupTick: 315,
  castFrom: [34, 50] as Coordinate,
  followUpFrom: [35, 51] as Coordinate,
};

export const DUKE_BASIC_WINDUP_STEPS: ReadonlyArray<{
  phase: 'opening' | 'enrage';
  windupTick: number;
  beforeMove: Coordinate;
  afterMove: Coordinate;
  clip: 'magic' | 'slam';
}> = [
  // 20261126-232238-Duke.jsonl:6911–6937. The player reaches front-pillar cover as Duke selects magic.
  { phase: 'opening', windupTick: 134, beforeMove: [34, 50], afterMove: [35, 51], clip: 'magic' },
  // 20261127-005253-Duke-Sucellus_2.jsonl:11783–11815. Duke starts melee and chips as the player steps south.
  { phase: 'enrage', windupTick: 380, beforeMove: [34, 51], afterMove: [34, 50], clip: 'slam' },
];

// 20261127-005253-Duke-Sucellus_2.jsonl:9276–9357 and :9546–9551.
export const DUKE_ORB_CONTACT_CAPTURE = {
  spawnTick: 264,
  spawnTile: [36, 51] as Coordinate,
  contactTick: 266,
  contactTile: [34, 51] as Coordinate,
  hitTick: 267,
  nextSpawnTick: 276,
  nextSpawnTile: [26, 51] as Coordinate,
};

// 20261127-012348-Duke-Sucellus_3.jsonl:8861 and :10913–12576.
export const DUKE_WEST_ORB_CAPTURE = {
  tile: [26, 51] as Coordinate,
  repeatInterval: 12,
};

// 20261127-012348-Duke-Sucellus_3.jsonl:9657, :10373, :10632, :12362, :13576 and :13873.
export const DUKE_ORB_DAMAGE_CAPTURE = { min: 25, max: 27 };

// 20261127-005253-Duke-Sucellus_2.jsonl:12731, :12773 and :12874.
export const DUKE_ENRAGED_BILE_CAPTURE = { lastFlareTick: 423, warningTick: 426, nextBasicTick: 430 };

// 20261127-012348-Duke-Sucellus_3.jsonl:11933–11979 and :12818–12874.
export const DUKE_CONSECUTIVE_BILE_DELAY = 3;

// 20261127-012348-Duke-Sucellus_3.jsonl:8445–8472, with Protect from Melee.
// Also observed in 20261127-013711-Duke-Sucellus_4.jsonl:9049 and 20261127-020616-Duke-Sucellus_6.jsonl:6180.
export const DUKE_PROTECTED_CHIP_CAPTURE = 8;

// 20261127-005253-Duke-Sucellus_2.jsonl:12482–12511, with Protect from Magic.
export const DUKE_UNPROTECTED_CHIP_CAPTURE = 13;

// 20261127-005253-Duke-Sucellus_2.jsonl:12991 and :13039–13072.
export const DUKE_ENRAGED_LATE_STEP = {
  windupTick: 434,
  hitTick: 436,
  front: [32, 51] as Coordinate,
  step: [31, 50] as Coordinate,
};

// 20261126-235612-Duke-Sucellus.jsonl:4858–4930 and :5460–5543.
// Regular Duke hits before the player's south step on the shatter tick.
export const REGULAR_DUKE_LATE_STEPS: ReadonlyArray<{
  windupTick: number;
  hitTick: number;
  front: Coordinate;
  step: Coordinate;
}> = [
  { windupTick: 31, hitTick: 33, front: [31, 51], step: [31, 50] },
  { windupTick: 55, hitTick: 57, front: [29, 51], step: [29, 50] },
];
