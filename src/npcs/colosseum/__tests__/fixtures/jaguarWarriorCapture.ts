/**
 * Facts extracted from private gameplay captures (A = colosseum-waves-1-12-damage-trials-solarflare3-volatility3-bees1-totemic-doom1-death-packet-data.txt,
 * C = colosseum-no-sol-packet-data.txt). Jaguar warrior (npc 12810, size 2) episodes, as south-west
 * tiles relative to the Colosseum arena origin (world 1792, 3072). Per tick: the player's start-of-tick
 * tile, whether Protect from Melee was active after that tick's input, the jaguar's tile at the end of
 * the tick, whether it played its attack (10847) or death (10849) sequence, and the values of the
 * player's hitsplats on that tick, from any source. `start` is its tile at the start of the first
 * tick; every episode starts long after its add (A:1399, C:1707), with its attack ready. `blockers`
 * are other NPCs standing in its way.
 */
import type { Coordinate } from '../../../../types/simulation';

export interface JaguarCaptureTick {
  readonly tick: number;
  readonly playerStart: Coordinate;
  readonly protectMelee: boolean;
  readonly jaguar: Coordinate;
  readonly attack: boolean;
  readonly death: boolean;
  readonly playerSplats: readonly number[];
}

export interface JaguarCaptureEpisode {
  readonly capture: 'A' | 'C';
  readonly spawnTick: number;
  readonly start: Coordinate;
  readonly blockers: readonly { readonly npcId: number; readonly position: Coordinate; readonly size: number }[];
  readonly ticks: readonly JaguarCaptureTick[];
}

// biome-ignore format: one extracted record per line keeps the fixture reviewable
export const JAGUAR_WARRIOR_CAPTURE = {
  /**
   * Held by a Javelin Colossus (npc 12817) south-east of it, then a diagonal step into cardinal reach
   * and the attack on the same tick (C:1732, unprotected: three 0s plus a 0 from another source).
   */
  moveAndAttack: {
    capture: 'C', spawnTick: 1707, start: [42, 40], blockers: [{ npcId: 12817, position: [44, 38], size: 3 }],
    ticks: [
      {"tick":1731,"playerStart":[45,40],"protectMelee":false,"jaguar":[42,40],"attack":false,"death":false,"playerSplats":[]},
      {"tick":1732,"playerStart":[45,41],"protectMelee":false,"jaguar":[43,41],"attack":true,"death":false,"playerSplats":[0,0,0,0]},
    ],
  },
  /** It steps diagonally adjacent to the player and does not attack, then steps cardinal and does. */
  diagonalThenCardinal: {
    capture: 'C', spawnTick: 1707, start: [45, 41], blockers: [],
    ticks: [
      {"tick":1763,"playerStart":[43,39],"protectMelee":true,"jaguar":[44,40],"attack":false,"death":false,"playerSplats":[]},
      {"tick":1764,"playerStart":[43,39],"protectMelee":true,"jaguar":[43,40],"attack":true,"death":false,"playerSplats":[0,0,0]},
    ],
  },
  /**
   * Round a Javelin Colossus (npc 12817) south of it, diagonal to the player beside the north-west
   * pillar (A:1407), then stalled by the pillar. The colossus's later step (A:1408) is clear of it.
   */
  pillarDiagonal: {
    capture: 'A', spawnTick: 1399, start: [28, 46], blockers: [{ npcId: 12817, position: [27, 43], size: 3 }],
    ticks: [
      {"tick":1404,"playerStart":[23,43],"protectMelee":true,"jaguar":[27,46],"attack":false,"death":false,"playerSplats":[]},
      {"tick":1405,"playerStart":[23,43],"protectMelee":true,"jaguar":[26,46],"attack":false,"death":false,"playerSplats":[]},
      // The 17 is another NPC's.
      {"tick":1406,"playerStart":[23,43],"protectMelee":true,"jaguar":[25,45],"attack":false,"death":false,"playerSplats":[17]},
      {"tick":1407,"playerStart":[23,43],"protectMelee":true,"jaguar":[24,44],"attack":false,"death":false,"playerSplats":[]},
      {"tick":1408,"playerStart":[23,42],"protectMelee":true,"jaguar":[23,44],"attack":false,"death":false,"playerSplats":[]},
      {"tick":1409,"playerStart":[23,42],"protectMelee":true,"jaguar":[23,44],"attack":false,"death":false,"playerSplats":[]},
    ],
  },
} as const satisfies Record<string, JaguarCaptureEpisode>;

/**
 * A:1443: the jaguar at (23,44), cardinally adjacent to the player on (23,43), swings on the tick the
 * player's three hits (3, 30, 7, the last lethal) kill it; no splat on the player. Its previous attack
 * was A:1438. Death sequence A:1444, `del` A:1447.
 */
export const JAGUAR_WARRIOR_KILL_TICK_SWING = {
  killTick: 1443,
  previousAttackTick: 1438,
  jaguar: [23, 44],
  playerStart: [23, 43],
  deathSequenceTick: 1444,
  removedTick: 1447,
} as const;
