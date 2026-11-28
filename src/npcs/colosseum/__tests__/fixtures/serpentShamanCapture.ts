/**
 * Facts extracted from private gameplay captures (A = colosseum-waves-1-12-damage-trials-solarflare3-volatility3-bees1-totemic-doom1-death-packet-data.txt,
 * B = colosseum-waves-bees-death(no-sol)-packet-data-1.txt, C = colosseum-no-sol-packet-data.txt).
 * Serpent shaman (npc 12811) episodes, as tiles relative to the Colosseum arena origin (world 1792,
 * 3072). Per tick: the player's start-of-tick tile, whether Protect from Magic was active after that
 * tick's input, the shaman's tile at the end of the tick, its cast (projectile `endtime` and whether
 * the impact spotanim 1460 was sent) and the values of the player's hitsplats on that tick, from any
 * source. `start` is the shaman's tile at the start of the first tick; `readyTick` is the first tick
 * its cast cooldown allowed (its previous cast + 5, or add+3); `blockers` are other NPCs whose tiles
 * held it, with the tick their `del` freed them.
 */
import type { Coordinate } from '../../../../types/simulation';

export interface ShamanCaptureTick {
  readonly tick: number;
  readonly playerStart: Coordinate;
  readonly protectMagic: boolean;
  readonly shaman: Coordinate;
  readonly cast?: { readonly endCycles: number; readonly impact: boolean };
  /** C:1864's jaguar warrior (npc 12810), spawned beside it: its tile at the end of the tick. */
  readonly jaguar?: Coordinate;
  readonly playerSplats: readonly number[];
}

export interface ShamanCaptureEpisode {
  readonly capture: 'A' | 'B' | 'C';
  readonly spawnTick: number;
  readonly start: Coordinate;
  readonly readyTick: number;
  /** The run's Relentless tier: B held Relentless III from B:2032. */
  readonly relentless: 0 | 3;
  readonly blockers: readonly {
    readonly npcId: number;
    readonly position: Coordinate;
    readonly size: number;
    readonly removedTick: number;
  }[];
  readonly jaguarStart?: Coordinate;
  readonly ticks: readonly ShamanCaptureTick[];
}

// biome-ignore format: one extracted record per line keeps the fixture reviewable
export const SERPENT_SHAMAN_CAPTURE = {
  /** A wave-start shaman from its add tick: walk-in, a pillar-blocked view, six casts at d 7-9. */
  pillarCasts: {
    capture: 'A', spawnTick: 1333, start: [29, 31], readyTick: 1336, relentless: 0, blockers: [],
    ticks: [
      {"tick":1333,"playerStart":[23,36],"protectMagic":false,"shaman":[29,31],"playerSplats":[]},
      {"tick":1334,"playerStart":[23,38],"protectMagic":false,"shaman":[28,32],"playerSplats":[]},
      {"tick":1335,"playerStart":[23,40],"protectMagic":false,"shaman":[28,32],"playerSplats":[]},
      {"tick":1336,"playerStart":[23,42],"protectMagic":true,"shaman":[27,33],"cast":{"endCycles":103,"impact":true},"playerSplats":[]},
      {"tick":1337,"playerStart":[23,42],"protectMagic":true,"shaman":[27,33],"playerSplats":[]},
      {"tick":1338,"playerStart":[23,42],"protectMagic":true,"shaman":[27,33],"playerSplats":[]},
      {"tick":1339,"playerStart":[23,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1340,"playerStart":[22,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[0]},
      {"tick":1341,"playerStart":[21,43],"protectMagic":true,"shaman":[26,34],"cast":{"endCycles":103,"impact":false},"playerSplats":[]},
      {"tick":1342,"playerStart":[20,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1343,"playerStart":[20,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1344,"playerStart":[20,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[0]},
      {"tick":1345,"playerStart":[19,42],"protectMagic":true,"shaman":[26,34],"playerSplats":[0,0]},
      {"tick":1346,"playerStart":[19,42],"protectMagic":true,"shaman":[26,34],"cast":{"endCycles":99,"impact":true},"playerSplats":[]},
      {"tick":1347,"playerStart":[21,42],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1348,"playerStart":[21,42],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1349,"playerStart":[22,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[0]},
      {"tick":1350,"playerStart":[20,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1351,"playerStart":[18,43],"protectMagic":true,"shaman":[26,34],"cast":{"endCycles":103,"impact":true},"playerSplats":[]},
      {"tick":1352,"playerStart":[18,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1353,"playerStart":[18,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1354,"playerStart":[18,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1355,"playerStart":[18,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[0]},
      {"tick":1356,"playerStart":[20,42],"protectMagic":true,"shaman":[26,34],"cast":{"endCycles":99,"impact":true},"playerSplats":[]},
      {"tick":1357,"playerStart":[20,42],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1358,"playerStart":[20,42],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1359,"playerStart":[18,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[0]},
      {"tick":1360,"playerStart":[18,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1361,"playerStart":[20,43],"protectMagic":true,"shaman":[26,34],"cast":{"endCycles":103,"impact":true},"playerSplats":[]},
      {"tick":1362,"playerStart":[22,43],"protectMagic":true,"shaman":[26,34],"playerSplats":[]},
      {"tick":1363,"playerStart":[23,43],"protectMagic":true,"shaman":[25,35],"playerSplats":[]},
      {"tick":1364,"playerStart":[23,43],"protectMagic":true,"shaman":[24,36],"playerSplats":[]},
      {"tick":1365,"playerStart":[23,43],"protectMagic":true,"shaman":[24,36],"playerSplats":[0]},
      {"tick":1366,"playerStart":[23,43],"protectMagic":true,"shaman":[24,36],"cast":{"endCycles":95,"impact":true},"playerSplats":[]},
    ],
  },
  /**
   * A reinforcement shaman above the north-west pillar, held by the pillar and a dying minotaur
   * (npc 12812) until the minotaur's `del` at A:3719 frees its west tile; it steps and casts that tick.
   */
  pillarMoveAndCast: {
    capture: 'A', spawnTick: 3627, start: [25, 44], readyTick: 3714, relentless: 0,
    blockers: [{ npcId: 12812, position: [22, 44], size: 3, removedTick: 3719 }],
    ticks: [
      {"tick":3714,"playerStart":[22,43],"protectMagic":false,"shaman":[25,44],"playerSplats":[]},
      {"tick":3715,"playerStart":[22,43],"protectMagic":false,"shaman":[25,44],"playerSplats":[]},
      {"tick":3716,"playerStart":[22,43],"protectMagic":false,"shaman":[25,44],"playerSplats":[]},
      {"tick":3717,"playerStart":[22,41],"protectMagic":true,"shaman":[25,44],"playerSplats":[]},
      {"tick":3718,"playerStart":[22,41],"protectMagic":true,"shaman":[25,44],"playerSplats":[]},
      {"tick":3719,"playerStart":[22,41],"protectMagic":true,"shaman":[24,44],"cast":{"endCycles":80,"impact":false},"playerSplats":[]},
      {"tick":3720,"playerStart":[22,41],"protectMagic":true,"shaman":[24,44],"playerSplats":[]},
      {"tick":3721,"playerStart":[22,41],"protectMagic":true,"shaman":[24,44],"playerSplats":[]},
      {"tick":3722,"playerStart":[22,41],"protectMagic":true,"shaman":[24,44],"playerSplats":[0]},
      {"tick":3723,"playerStart":[22,42],"protectMagic":true,"shaman":[24,44],"playerSplats":[]},
      {"tick":3724,"playerStart":[21,43],"protectMagic":true,"shaman":[24,44],"cast":{"endCycles":80,"impact":false},"playerSplats":[]},
    ],
  },
  /**
   * A reinforcement pair: the jaguar (lower index) steps first and holds the shaman's tiles at add+1;
   * the shaman's d-10 cast is unprayed and Protect from Magic goes up the next tick, before the splat.
   */
  unprayedCastPrayedLanding: {
    capture: 'C', spawnTick: 1864, start: [32, 48], readyTick: 1867, relentless: 0, blockers: [], jaguarStart: [31, 48],
    ticks: [
      {"tick":1864,"playerStart":[42,38],"protectMagic":false,"shaman":[32,48],"jaguar":[31,48],"playerSplats":[]},
      {"tick":1865,"playerStart":[42,38],"protectMagic":false,"shaman":[32,48],"jaguar":[32,47],"playerSplats":[]},
      {"tick":1866,"playerStart":[40,38],"protectMagic":false,"shaman":[32,48],"jaguar":[33,46],"playerSplats":[]},
      {"tick":1867,"playerStart":[38,38],"protectMagic":false,"shaman":[32,48],"jaguar":[34,45],"cast":{"endCycles":107,"impact":true},"playerSplats":[]},
      {"tick":1868,"playerStart":[36,38],"protectMagic":true,"shaman":[32,48],"jaguar":[35,44],"playerSplats":[]},
      {"tick":1869,"playerStart":[34,38],"protectMagic":true,"shaman":[32,48],"jaguar":[34,43],"playerSplats":[]},
      {"tick":1870,"playerStart":[32,38],"protectMagic":true,"shaman":[32,48],"jaguar":[33,42],"playerSplats":[]},
      // The 4 is a Doom splat.
      {"tick":1871,"playerStart":[30,38],"protectMagic":true,"shaman":[32,48],"jaguar":[32,41],"playerSplats":[4,28]},
      {"tick":1872,"playerStart":[28,38],"protectMagic":true,"shaman":[32,48],"jaguar":[31,40],"cast":{"endCycles":107,"impact":true},"playerSplats":[]},
    ],
  },
  /** Two d-1 casts under Relentless III, each prayed at the cast and unprayed when it lands. */
  prayedCastUnprayedLanding: {
    capture: 'B', spawnTick: 2037, start: [26, 40], readyTick: 2104, relentless: 3, blockers: [],
    ticks: [
      {"tick":2103,"playerStart":[27,40],"protectMagic":true,"shaman":[26,40],"playerSplats":[]},
      {"tick":2104,"playerStart":[27,40],"protectMagic":true,"shaman":[26,40],"cast":{"endCycles":80,"impact":true},"playerSplats":[]},
      {"tick":2105,"playerStart":[27,40],"protectMagic":false,"shaman":[26,40],"playerSplats":[]},
      {"tick":2106,"playerStart":[27,40],"protectMagic":false,"shaman":[26,40],"playerSplats":[44]},
      {"tick":2107,"playerStart":[25,40],"protectMagic":false,"shaman":[26,40],"playerSplats":[0]},
      {"tick":2108,"playerStart":[25,40],"protectMagic":false,"shaman":[26,40],"playerSplats":[]},
      {"tick":2109,"playerStart":[25,40],"protectMagic":true,"shaman":[26,40],"cast":{"endCycles":80,"impact":true},"playerSplats":[]},
      {"tick":2110,"playerStart":[25,40],"protectMagic":true,"shaman":[26,40],"playerSplats":[]},
      {"tick":2111,"playerStart":[25,40],"protectMagic":false,"shaman":[26,40],"playerSplats":[0]},
      {"tick":2112,"playerStart":[25,40],"protectMagic":false,"shaman":[26,40],"playerSplats":[0]},
      {"tick":2113,"playerStart":[25,40],"protectMagic":false,"shaman":[26,40],"playerSplats":[]},
    ],
  },
} as const satisfies Record<string, ShamanCaptureEpisode>;

/**
 * A:1967: the shaman at (23,40) casts at the player on (22,42) (d 2, protected) on the tick a player
 * hit takes it to 0 HP; its death sequence plays A:1968, its cast's 0 splat lands A:1970, `del` A:1971.
 */
export const SERPENT_SHAMAN_KILL_TICK_CAST = {
  killTick: 1967,
  shaman: [23, 40],
  playerStart: [22, 42],
  deathSequenceTick: 1968,
  castSplatTick: 1970,
  removedTick: 1971,
} as const;

/**
 * The cache's four 3x3 Colosseum pillars (map square 28_48, collision OBJECT | OBJECT_PROJECTILE_BLOCKER
 * on every tile), by south-west tile.
 */
export const COLOSSEUM_PILLAR_SOUTH_WEST_TILES: readonly Coordinate[] = [
  [24, 26],
  [39, 26],
  [24, 41],
  [39, 41],
];
