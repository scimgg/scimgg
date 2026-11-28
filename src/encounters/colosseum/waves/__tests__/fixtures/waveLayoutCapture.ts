/**
 * Facts extracted from private gameplay captures:
 * A = colosseum-waves-1-12-damage-trials-solarflare3-volatility3-bees1-totemic-doom1-death-packet-data.txt,
 * B = colosseum-waves-bees-death(no-sol)-packet-data-1.txt, C = colosseum-no-sol-packet-data.txt.
 * One record per captured wave start (T0, the `Wave: N` tick): the formation center (one south of the
 * berserker), the Quartet member when there was one, each initial non-warband NPC's species and SW
 * tile, the reinforcements added at T0+66, and the completion tick as an offset from T0 (null: the
 * player died). Tiles relative to the arena origin (world 1792, 3072).
 */
import type { Coordinate } from '../../../../../types/simulation';
import type { ColosseumWaveSpecies } from '../../waveTable';

export interface CapturedWaveStart {
  readonly capture: 'A' | 'B' | 'C';
  readonly wave: number;
  readonly waveStart: number;
  readonly completedAfter: number | null;
  readonly center: Coordinate;
  readonly quartet?: Coordinate;
  readonly initial: readonly (readonly [ColosseumWaveSpecies, number, number])[];
  readonly reinforcements: readonly (readonly [ColosseumWaveSpecies, number, number])[];
}

// biome-ignore format: one extracted record per line keeps the fixture reviewable
export const CAPTURED_WAVE_STARTS: readonly CapturedWaveStart[] = [
  {"capture":"B","wave":1,"waveStart":1862,"completedAfter":51,"center":[33,37],"initial":[["serpentShaman",35,31]],"reinforcements":[]},
  {"capture":"C","wave":1,"waveStart":1451,"completedAfter":28,"center":[29,34],"initial":[["serpentShaman",44,32]],"reinforcements":[]},
  {"capture":"B","wave":2,"waveStart":1931,"completedAfter":95,"center":[35,33],"initial":[["javelinColossus",29,37],["serpentShaman",29,31]],"reinforcements":[["jaguarWarrior",32,48]]},
  {"capture":"C","wave":2,"waveStart":1534,"completedAfter":96,"center":[35,33],"initial":[["javelinColossus",44,32],["serpentShaman",44,37]],"reinforcements":[["jaguarWarrior",32,48]]},
  {"capture":"A","wave":3,"waveStart":837,"completedAfter":267,"center":[31,34],"initial":[["javelinColossus",29,31],["javelinColossus",29,37],["serpentShaman",32,27]],"reinforcements":[["jaguarWarrior",33,48]]},
  {"capture":"B","wave":3,"waveStart":2037,"completedAfter":141,"center":[31,37],"initial":[["javelinColossus",32,27],["javelinColossus",40,35],["serpentShaman",29,37]],"reinforcements":[["jaguarWarrior",31,48]]},
  {"capture":"C","wave":3,"waveStart":1641,"completedAfter":134,"center":[33,38],"initial":[["javelinColossus",44,32],["javelinColossus",44,37],["serpentShaman",32,27]],"reinforcements":[["jaguarWarrior",32,48]]},
  {"capture":"A","wave":4,"waveStart":1127,"completedAfter":165,"center":[33,33],"initial":[["manticore",29,31],["serpentShaman",29,37]],"reinforcements":[["jaguarWarrior",31,48],["serpentShaman",32,48]]},
  {"capture":"B","wave":4,"waveStart":2201,"completedAfter":132,"center":[34,38],"quartet":[34,37],"initial":[["manticore",44,32],["serpentShaman",40,35]],"reinforcements":[["jaguarWarrior",32,48],["serpentShaman",31,48]]},
  {"capture":"C","wave":4,"waveStart":1798,"completedAfter":132,"center":[35,36],"initial":[["manticore",44,37],["serpentShaman",44,32]],"reinforcements":[["jaguarWarrior",31,48],["serpentShaman",32,48]]},
  {"capture":"A","wave":5,"waveStart":1333,"completedAfter":394,"center":[29,36],"initial":[["javelinColossus",33,42],["manticore",44,32],["serpentShaman",29,31]],"reinforcements":[["jaguarWarrior",32,48],["serpentShaman",33,48]]},
  {"capture":"B","wave":5,"waveStart":2361,"completedAfter":203,"center":[30,37],"quartet":[30,36],"initial":[["javelinColossus",29,37],["manticore",35,37],["serpentShaman",44,32]],"reinforcements":[["jaguarWarrior",33,48],["serpentShaman",31,48]]},
  {"capture":"C","wave":5,"waveStart":1961,"completedAfter":153,"center":[33,33],"initial":[["javelinColossus",29,31],["manticore",35,37],["serpentShaman",32,27]],"reinforcements":[["jaguarWarrior",31,48],["serpentShaman",32,48]]},
  {"capture":"A","wave":6,"waveStart":1779,"completedAfter":353,"center":[35,38],"initial":[["javelinColossus",33,42],["javelinColossus",35,31],["manticore",44,32],["serpentShaman",35,37]],"reinforcements":[["jaguarWarrior",32,48],["serpentShaman",33,48]]},
  {"capture":"B","wave":6,"waveStart":2630,"completedAfter":292,"center":[31,36],"quartet":[31,35],"initial":[["javelinColossus",35,37],["javelinColossus",40,35],["manticore",44,37],["serpentShaman",29,31]],"reinforcements":[["jaguarWarrior",33,48],["serpentShaman",31,48]]},
  {"capture":"C","wave":6,"waveStart":2125,"completedAfter":267,"center":[33,39],"initial":[["javelinColossus",33,42],["javelinColossus",35,37],["manticore",29,37],["serpentShaman",44,32]],"reinforcements":[["jaguarWarrior",31,48],["serpentShaman",33,48]]},
  {"capture":"A","wave":7,"waveStart":2182,"completedAfter":336,"center":[30,34],"initial":[["javelinColossus",32,27],["manticore",40,35],["shockwaveColossus",29,37]],"reinforcements":[["minotaur",33,48]]},
  {"capture":"B","wave":7,"waveStart":2975,"completedAfter":324,"center":[35,37],"quartet":[35,36],"initial":[["javelinColossus",40,35],["manticore",35,31],["shockwaveColossus",44,37]],"reinforcements":[["minotaur",33,48]]},
  {"capture":"C","wave":7,"waveStart":2409,"completedAfter":205,"center":[35,36],"initial":[["javelinColossus",35,37],["manticore",44,32],["shockwaveColossus",29,31]],"reinforcements":[["minotaur",33,48]]},
  {"capture":"A","wave":8,"waveStart":2645,"completedAfter":406,"center":[32,35],"initial":[["javelinColossus",29,31],["javelinColossus",40,35],["manticore",35,31],["shockwaveColossus",32,27]],"reinforcements":[["minotaur",32,48]]},
  {"capture":"B","wave":8,"waveStart":3347,"completedAfter":null,"center":[31,33],"quartet":[31,32],"initial":[["javelinColossus",29,31],["javelinColossus",44,37],["manticore",35,37],["shockwaveColossus",32,27]],"reinforcements":[]},
  {"capture":"C","wave":8,"waveStart":2641,"completedAfter":188,"center":[32,36],"initial":[["javelinColossus",32,27],["javelinColossus",44,32],["manticore",35,37],["shockwaveColossus",29,37]],"reinforcements":[["minotaur",31,48]]},
  {"capture":"A","wave":9,"waveStart":3248,"completedAfter":296,"center":[30,33],"initial":[["javelinColossus",32,27],["manticore",29,37],["manticore",40,35]],"reinforcements":[["minotaur",32,48]]},
  {"capture":"C","wave":9,"waveStart":2863,"completedAfter":188,"center":[29,38],"initial":[["javelinColossus",29,37],["manticore",33,42],["manticore",44,32]],"reinforcements":[["minotaur",33,48]]},
  {"capture":"A","wave":10,"waveStart":3561,"completedAfter":620,"center":[33,39],"initial":[["javelinColossus",33,42],["javelinColossus",35,31],["manticore",29,37],["manticore",44,32]],"reinforcements":[["minotaur",31,48],["serpentShaman",33,48]]},
  {"capture":"C","wave":10,"waveStart":3064,"completedAfter":367,"center":[33,34],"initial":[["javelinColossus",35,31],["javelinColossus",35,37],["manticore",33,42],["manticore",44,32]],"reinforcements":[["minotaur",33,48],["serpentShaman",31,48]]},
  {"capture":"A","wave":11,"waveStart":4245,"completedAfter":623,"center":[31,35],"initial":[["javelinColossus",40,35],["manticore",32,27],["manticore",35,37],["shockwaveColossus",35,31]],"reinforcements":[["minotaur",32,48],["serpentShaman",33,48]]},
  {"capture":"C","wave":11,"waveStart":3445,"completedAfter":275,"center":[29,38],"initial":[["javelinColossus",35,31],["manticore",40,35],["manticore",44,32],["shockwaveColossus",29,31]],"reinforcements":[["minotaur",32,48],["serpentShaman",33,48]]},
];

/**
 * Where the player stood in each record of {@link CAPTURED_WAVE_STARTS} (same order): `startTiles` are
 * the player's tiles at the start of each tick from Tk (T0-5, the accepted choice) to T0, before that
 * tick's move (null: A opens on T0-1 with no earlier position); `reinforcementTile` is the tile at the
 * start of T0+66 for the waves that reinforced (null otherwise).
 */
export interface CapturedPlayerTiles {
  readonly capture: 'A' | 'B' | 'C';
  readonly wave: number;
  readonly startTiles: readonly Coordinate[] | null;
  readonly reinforcementTile: Coordinate | null;
}

// biome-ignore format: one extracted record per line keeps the fixture reviewable
export const CAPTURED_PLAYER_TILES: readonly CapturedPlayerTiles[] = [
  {"capture":"B","wave":1,"startTiles":[[34,32],[34,32],[32,32],[30,32],[28,33],[28,33]],"reinforcementTile":null},
  {"capture":"C","wave":1,"startTiles":[[30,43],[30,43],[30,43],[30,43],[30,43],[30,43]],"reinforcementTile":null},
  {"capture":"B","wave":2,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[27,42]},
  {"capture":"C","wave":2,"startTiles":[[31,41],[31,41],[31,41],[31,41],[31,41],[31,41]],"reinforcementTile":[42,34]},
  {"capture":"A","wave":3,"startTiles":null,"reinforcementTile":[26,45]},
  {"capture":"B","wave":3,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[27,40]},
  {"capture":"C","wave":3,"startTiles":[[30,41],[30,41],[30,41],[30,41],[30,41],[30,41]],"reinforcementTile":[43,37]},
  {"capture":"A","wave":4,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[23,41]},
  {"capture":"B","wave":4,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[27,40]},
  {"capture":"C","wave":4,"startTiles":[[32,41],[32,41],[32,41],[31,41],[31,41],[31,41]],"reinforcementTile":[42,38]},
  {"capture":"A","wave":5,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[22,42]},
  {"capture":"B","wave":5,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[23,41]},
  {"capture":"C","wave":5,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[23,42]},
  {"capture":"A","wave":6,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[23,41]},
  {"capture":"B","wave":6,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[23,41]},
  {"capture":"C","wave":6,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[22,42]},
  {"capture":"A","wave":7,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[22,42]},
  {"capture":"B","wave":7,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[23,42]},
  {"capture":"C","wave":7,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[25,40]},
  {"capture":"A","wave":8,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[22,42]},
  {"capture":"B","wave":8,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":null},
  {"capture":"C","wave":8,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[23,41]},
  {"capture":"A","wave":9,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[22,41]},
  {"capture":"C","wave":9,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[23,41]},
  {"capture":"A","wave":10,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[22,42]},
  {"capture":"C","wave":10,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[23,43]},
  {"capture":"A","wave":11,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[22,42]},
  {"capture":"C","wave":11,"startTiles":[[23,36],[23,36],[23,36],[23,36],[23,36],[23,36]],"reinforcementTile":[25,40]},
];

/**
 * The wave-12 hand-off in A and in C's continuation (colosseum-sol-heredit-packet-data.txt, K), as
 * offsets from that wave's start (the `colosseum_wave_start_time` write): the jump message, the
 * player's relocation and Sol's add with the fence, and where the player was put.
 */
export const CAPTURED_SOL_HANDOFFS = [
  { capture: 'A', waveStart: 4970, jumpMessage: 1, relocate: 4, control: 6, playerTile: [33, 31] },
  { capture: 'K', waveStart: 3992, jumpMessage: 1, relocate: 4, control: 6, playerTile: [33, 31] },
] as const;

/**
 * Solarflare in A's waves 5-11: four orbs added at T0 in this order on these tiles, each stepping
 * first at T0+1, in every wave (`waveStarts`). `firstOrbTrack` is the first orb's tile at offsets
 * from T0 in wave 5 (tier I, A:1333-1386): its moves land on the odd offsets, so the even ones
 * repeat the tile before.
 */
export const CAPTURED_WAVE_SOLARFLARE = {
  capture: 'A',
  waveStarts: [1333, 1779, 2182, 2645, 3248, 3561, 4245],
  spawns: [
    [38, 40],
    [27, 40],
    [27, 29],
    [38, 29],
  ],
  firstStep: 1,
  firstOrbTrack: [
    [1, [38, 41]],
    [6, [38, 43]],
    [7, [38, 44]],
    [13, [38, 44]],
    [14, [39, 44]],
    [46, [38, 40]],
    [53, [38, 41]],
  ],
} as const;
