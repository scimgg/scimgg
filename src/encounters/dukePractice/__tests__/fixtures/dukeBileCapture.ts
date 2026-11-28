import type { Coordinate } from '../../../../types/simulation';

// 20261126-232238-Duke.jsonl, lines 6554–6590 and 7537–7579.
// Cycles are relative to the warning and animation start at encounter ticks 119 and 161.
export const DUKE_BILE_CAPTURE = {
  sequenceId: 10178,
  projectile: {
    id: 1354,
    startCycle: 32,
    endCycle: 51,
    startHeight: 130,
    endHeight: 160,
    startOffset: 32,
  },
  sounds: [
    { id: 1784, cycle: 0, channel: 'sfx' },
    { id: 7179, cycle: 1, channel: 'area' },
    { id: 7248, cycle: 35, channel: 'area' },
  ],
} as const;

// 20261127-002024-Duke-Sucellus_1.jsonl:8472. Varp 102 after the first pool hit at tick 229.
export const DUKE_BILE_POISON_VARP = 10;

// 20261127-002024-Duke-Sucellus_1.jsonl:8380 and :8508.
export const DUKE_BILE_RECOVERY_CAPTURE = { warningTick: 225, nextBasicTick: 230 } as const;

// 20261127-192944-Duke-Sucellus_12.jsonl:4708–4828. The cast tick run passes
// [28, 51], but the first pool is at the endpoint. A later return creates that pool.
export const DUKE_BILE_CAST_RUN_CAPTURE = {
  castTick: 24,
  beforeCast: [29, 51],
  moves: [
    [27, 51],
    [27, 51],
    [28, 50],
    [28, 51],
    [28, 51],
    [29, 50],
  ] satisfies Coordinate[],
  pools: [
    { tick: 25, tile: [27, 51] },
    { tick: 27, tile: [28, 50] },
    { tick: 28, tile: [28, 51] },
  ],
  hits: [26, 29],
} as const;

export const DUKE_BILE_MELEE_CAPTURES = [
  // 20261127-025030-Duke-Sucellus_10.jsonl:6442–6910.
  {
    phase: 'bile',
    firstFlareTick: 123,
    beforeFirstFlare: [27, 51],
    warningTick: 134,
    moves: [
      [27, 51],
      [27, 51],
      [28, 49],
      [29, 47],
      [29, 47],
      [31, 47],
      [33, 47],
      [33, 47],
      [33, 49],
      [33, 51],
      [33, 51],
      [33, 51],
      [34, 50],
      [34, 49],
      [34, 51],
      [34, 51],
      [33, 50],
      [33, 49],
      [32, 50],
      [32, 51],
      [32, 51],
    ] satisfies Coordinate[],
    hits: [
      { tick: 139, source: 'Bile pool' },
      { tick: 139, source: 'Icicles' },
    ],
  },
  // 20261127-012348-Duke-Sucellus_3.jsonl:11791–12239.
  {
    phase: 'enrage',
    firstFlareTick: 389,
    beforeFirstFlare: [28, 51],
    warningTick: 399,
    moves: [
      [28, 49],
      [29, 47],
      [29, 47],
      [29, 47],
      [29, 47],
      [31, 47],
      [33, 47],
      [33, 47],
      [33, 49],
      [33, 51],
      [33, 51],
      [34, 50],
      [32, 49],
      [32, 51],
      [32, 51],
      [31, 49],
      [30, 50],
      [30, 51],
      [30, 51],
      [29, 50],
    ] satisfies Coordinate[],
    hits: [
      { tick: 403, source: 'Icicles' },
      { tick: 404, source: 'Bile pool' },
      { tick: 407, source: 'Icicles' },
      { tick: 408, source: 'Bile pool' },
    ],
  },
] as const;
