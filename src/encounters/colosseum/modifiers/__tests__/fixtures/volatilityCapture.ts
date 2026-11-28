/**
 * Facts extracted from a private gameplay capture (colosseum-waves-1-12-damage-trials-solarflare3-volatility3-bees1-totemic-doom1-death-packet-data.txt).
 * Every Volatility death in its waves 8–11 (33): the removal tick of the dying NPC (cache id; the
 * berserker's own `del` is not printed, so it is identified by its tile), its south-west tile and size,
 * the Volatility tier then (I from wave 8, II from wave 10, III from wave 11), the gib NPC added on that
 * tile and the explosion spotanim on its center, the explosion tiles that got no fireblast impact
 * (offsets from the south-west tile; every other one's delay is 2 per ring from the center), how
 * many ticks the gib lived, the player's tile at the start of the tick, and the 16–24 damage splat
 * the player took that tick, if any.
 */
import type { Coordinate } from '../../../../../types/simulation';

export interface CapturedVolatilityDeath {
  readonly tick: number;
  readonly npcTypeId: number;
  readonly size: number;
  readonly position: Coordinate;
  readonly tier: 1 | 2 | 3;
  readonly gibNpcTypeId: number;
  readonly explosionSpotAnimId: number;
  readonly omitted: readonly Coordinate[];
  readonly gibTicks: number;
  readonly playerStart: Coordinate;
  readonly damage: number | null;
}

// biome-ignore format: one extracted record per line keeps the fixture reviewable
export const CAPTURED_VOLATILITY_DEATHS: readonly CapturedVolatilityDeath[] = [
  { tick: 2662, npcTypeId: 12816, size: 1, position: [25, 46], tier: 1, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [], gibTicks: 3, playerStart: [23, 44], damage: null },
  { tick: 2683, npcTypeId: 12814, size: 1, position: [19, 42], tier: 1, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [], gibTicks: 3, playerStart: [23, 42], damage: null },
  { tick: 2702, npcTypeId: 12815, size: 1, position: [22, 42], tier: 1, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [], gibTicks: 3, playerStart: [19, 42], damage: null },
  { tick: 2725, npcTypeId: 12819, size: 3, position: [24, 35], tier: 1, gibNpcTypeId: 12831, explosionSpotAnimId: 2722, omitted: [], gibTicks: 3, playerStart: [22, 42], damage: null },
  { tick: 2800, npcTypeId: 12817, size: 3, position: [23, 38], tier: 1, gibNpcTypeId: 12831, explosionSpotAnimId: 2722, omitted: [[1,3],[2,3],[3,3]], gibTicks: 3, playerStart: [23, 41], damage: 17 },
  { tick: 2852, npcTypeId: 12812, size: 3, position: [22, 44], tier: 1, gibNpcTypeId: 12830, explosionSpotAnimId: 2723, omitted: [[2,-1],[3,-1]], gibTicks: 3, playerStart: [22, 43], damage: 24 },
  { tick: 2979, npcTypeId: 12817, size: 3, position: [27, 25], tier: 1, gibNpcTypeId: 12831, explosionSpotAnimId: 2722, omitted: [[-1,1],[-1,2],[-1,3]], gibTicks: 3, playerStart: [24, 25], damage: null },
  { tick: 3051, npcTypeId: 12818, size: 3, position: [26, 29], tier: 1, gibNpcTypeId: 12829, explosionSpotAnimId: 2721, omitted: [[-1,-1],[0,-1]], gibTicks: 3, playerStart: [23, 36], damage: null },
  { tick: 3260, npcTypeId: 12816, size: 1, position: [21, 44], tier: 1, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [], gibTicks: 3, playerStart: [21, 43], damage: 16 },
  { tick: 3264, npcTypeId: 12815, size: 1, position: [22, 43], tier: 1, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [], gibTicks: 3, playerStart: [20, 42], damage: null },
  { tick: 3275, npcTypeId: 12814, size: 1, position: [19, 42], tier: 1, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [], gibTicks: 3, playerStart: [22, 43], damage: null },
  { tick: 3350, npcTypeId: 12817, size: 3, position: [24, 35], tier: 1, gibNpcTypeId: 12831, explosionSpotAnimId: 2722, omitted: [], gibTicks: 3, playerStart: [22, 41], damage: null },
  { tick: 3398, npcTypeId: 12812, size: 3, position: [22, 44], tier: 1, gibNpcTypeId: 12830, explosionSpotAnimId: 2723, omitted: [[2,-1],[3,-1]], gibTicks: 3, playerStart: [22, 41], damage: null },
  { tick: 3487, npcTypeId: 12818, size: 3, position: [27, 41], tier: 1, gibNpcTypeId: 12829, explosionSpotAnimId: 2721, omitted: [[-1,0],[-1,1],[-1,2]], gibTicks: 3, playerStart: [29, 41], damage: 20 },
  { tick: 3544, npcTypeId: 12818, size: 3, position: [30, 41], tier: 1, gibNpcTypeId: 12829, explosionSpotAnimId: 2721, omitted: [], gibTicks: 3, playerStart: [23, 36], damage: null },
  { tick: 3575, npcTypeId: 12816, size: 1, position: [20, 42], tier: 2, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [], gibTicks: 3, playerStart: [17, 41], damage: null },
  { tick: 3592, npcTypeId: 12815, size: 1, position: [22, 42], tier: 2, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [[2,-1],[2,0],[2,1]], gibTicks: 3, playerStart: [21, 42], damage: 22 },
  { tick: 3608, npcTypeId: 12814, size: 1, position: [20, 42], tier: 2, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [], gibTicks: 3, playerStart: [22, 41], damage: 22 },
  { tick: 3719, npcTypeId: 12812, size: 3, position: [22, 44], tier: 2, gibNpcTypeId: 12830, explosionSpotAnimId: 2723, omitted: [[-2,4],[2,-2],[2,-1],[3,-2],[3,-1],[4,-2],[4,-1]], gibTicks: 3, playerStart: [22, 41], damage: null },
  { tick: 3757, npcTypeId: 12811, size: 1, position: [24, 44], tier: 2, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [[0,-2],[0,-1],[1,-2],[1,-1],[2,-2],[2,-1]], gibTicks: 3, playerStart: [21, 43], damage: null },
  { tick: 3962, npcTypeId: 12818, size: 3, position: [27, 26], tier: 2, gibNpcTypeId: 12829, explosionSpotAnimId: 2721, omitted: [[-2,0],[-2,1],[-2,2],[-1,0],[-1,1],[-1,2]], gibTicks: 3, playerStart: [24, 25], damage: null },
  { tick: 4026, npcTypeId: 12817, size: 3, position: [27, 25], tier: 2, gibNpcTypeId: 12831, explosionSpotAnimId: 2722, omitted: [[-2,1],[-2,2],[-2,3],[-1,1],[-1,2],[-1,3]], gibTicks: 3, playerStart: [25, 24], damage: 21 },
  { tick: 4094, npcTypeId: 12817, size: 3, position: [23, 29], tier: 2, gibNpcTypeId: 12831, explosionSpotAnimId: 2722, omitted: [[1,-2],[1,-1],[2,-2],[2,-1],[3,-2],[3,-1]], gibTicks: 3, playerStart: [24, 35], damage: null },
  { tick: 4181, npcTypeId: 12818, size: 3, position: [24, 32], tier: 2, gibNpcTypeId: 12829, explosionSpotAnimId: 2721, omitted: [], gibTicks: 3, playerStart: [23, 38], damage: null },
  { tick: 4257, npcTypeId: 12816, size: 1, position: [22, 44], tier: 3, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [[2,-2],[2,-1]], gibTicks: 3, playerStart: [19, 43], damage: null },
  { tick: 4270, npcTypeId: 12815, size: 1, position: [18, 41], tier: 3, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [[-2,-2],[-2,-1],[-2,0],[-2,1],[-2,2],[-1,2]], gibTicks: 3, playerStart: [22, 42], damage: null },
  { tick: 4282, npcTypeId: 12814, size: 1, position: [21, 42], tier: 3, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [], gibTicks: 3, playerStart: [18, 42], damage: null },
  { tick: 4379, npcTypeId: 12818, size: 3, position: [24, 35], tier: 3, gibNpcTypeId: 12829, explosionSpotAnimId: 2721, omitted: [], gibTicks: 3, playerStart: [22, 42], damage: null },
  { tick: 4490, npcTypeId: 12812, size: 3, position: [22, 44], tier: 3, gibNpcTypeId: 12830, explosionSpotAnimId: 2723, omitted: [[-2,4],[2,-2],[2,-1],[3,-2],[3,-1],[4,-2],[4,-1]], gibTicks: 3, playerStart: [18, 43], damage: null },
  { tick: 4602, npcTypeId: 12817, size: 3, position: [27, 25], tier: 3, gibNpcTypeId: 12831, explosionSpotAnimId: 2722, omitted: [[-2,1],[-2,2],[-2,3],[-1,1],[-1,2],[-1,3]], gibTicks: 3, playerStart: [24, 24], damage: null },
  { tick: 4638, npcTypeId: 12811, size: 1, position: [27, 26], tier: 3, gibNpcTypeId: 12828, explosionSpotAnimId: 2713, omitted: [[-2,0],[-2,1],[-2,2],[-1,0],[-1,1],[-1,2]], gibTicks: 3, playerStart: [25, 24], damage: 21 },
  { tick: 4811, npcTypeId: 12819, size: 3, position: [23, 29], tier: 3, gibNpcTypeId: 12831, explosionSpotAnimId: 2722, omitted: [[1,-2],[1,-1],[2,-2],[2,-1],[3,-2],[3,-1]], gibTicks: 3, playerStart: [23, 34], damage: null },
  { tick: 4868, npcTypeId: 12818, size: 3, position: [24, 32], tier: 3, gibNpcTypeId: 12829, explosionSpotAnimId: 2721, omitted: [], gibTicks: 3, playerStart: [18, 36], damage: null },
];
