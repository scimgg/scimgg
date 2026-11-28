import { fmix32, mulberry32 } from '../../../core/rng';
import type { ManticoreFirstStyle } from '../../../npcs/colosseum/manticore';
import { WARBAND_SLOT_OFFSETS, WARBANDER_ROLES, type WarbanderRole } from '../../../npcs/colosseum/warband';
import type { Coordinate } from '../../../types/simulation';
import { colosseumWaveFloorTiles } from './arena';
import type { ColosseumSpawnLayout } from './spawnLayout';
import { type ColosseumWaveSpecies, colosseumWave } from './waveTable';

/**
 * The Wiki's "12 default spawns" (W-Mod, W-Strat) as SW tiles, used by every species whatever its size.
 * The first nine are every tile a captured initial non-warband NPC was added on (85 spawns in the 28
 * waves of A, B and C; facts spec "Spawn points"). The last three, all on the west side, were observed
 * in third-party encounter recordings (not redistributed); they are placed by maintainer decision (open
 * question A2). The captures mostly started T0 on the Wiki's start tile (22/27), within the clearance of
 * all three, which is the Strategies page's "the west area" and why A, B and C never show them.
 */
export const COLOSSEUM_SPAWN_POINTS: readonly Readonly<Coordinate>[] = [
  [44, 32],
  [29, 37],
  [29, 31],
  [32, 27],
  [35, 37],
  [40, 35],
  [35, 31],
  [44, 37],
  [33, 42],
  // Observed in third-party encounter recordings (not redistributed); maintainer decision (A2).
  [19, 32],
  [25, 34],
  [19, 37],
];

/**
 * The berserker's spawn tile: captured formations (28/28) put it in x 29..35, y 34..40 (center one
 * south of it). Uniform over the box is policy (open question A3).
 */
export const WARBAND_BERSERKER_BOX = { minX: 29, maxX: 35, minY: 34, maxY: 40 } as const;

/**
 * Initial spawn points avoid the player. WIKI (Fortis_Colosseum/Strategies rev 15414089, "Wave clearing
 * procedure"): waiting on the start tile "prevents NPCs from spawning too close", and "By clicking towards
 * the pillar on the 5th tick, NPCs are prevented from spawning in the west area": the 5th tick after
 * the choice is T0, and a click on it moves the player during T0, after the tile that counts. CAPTURE
 * (fixture `CAPTURED_PLAYER_TILES`): B:1862 started Tk and T0-4 on (34,32), Chebyshev 1 from (35,31),
 * and T0-3 on (32,32), 3 from it, then walked off; (35,31) was used, so the tile is from T0-2 or later.
 * From the start tile (23,36) the points 6 away, (29,37) and (29,31), are used throughout A, B and C,
 * so the radius is under 6; the start tile keeping out the west area means the west points 4 away,
 * (19,32) and (19,37), are left out too, so it is at least 4. POLICY: the player's tile at the start of
 * T0 (T0-2 and T0-1 fit as well), and a point is left out when its SW tile is within Chebyshev 4 of it
 * (5 fits as well; open question A1). C's waves 1-4, the player north of center, drew only the three
 * points farthest from them (8 of 8 spawns), which no radius squares with (29,37) at 6; it is left to
 * chance (about 1 in 63,000 under this rule).
 */
export const SPAWN_POINT_PLAYER_CLEARANCE = 4;

/** Whether the spawn point `point` (an SW tile) is far enough from the player's tile `player` to be drawn. */
export function isSpawnPointClearOfPlayer(point: Readonly<Coordinate>, player: Readonly<Coordinate>): boolean {
  return Math.max(Math.abs(point[0] - player[0]), Math.abs(point[1] - player[1])) > SPAWN_POINT_PLAYER_CLEARANCE;
}

/**
 * Every captured reinforcement entered at the north gate: SW y = 48, x in {31, 32, 33}, two together on
 * distinct x (38/38 adds; no type-to-x mapping). Uniform is policy (A4); the south gate's are below.
 */
export const COLOSSEUM_REINFORCEMENT_TILES: readonly Readonly<Coordinate>[] = [
  [31, 48],
  [32, 48],
  [33, 48],
];
const REINFORCEMENT_COLUMNS = COLOSSEUM_REINFORCEMENT_TILES.map(([x]) => x);
const NORTH_GATE_ROW = 48;

export type ColosseumGate = 'north' | 'south';

/**
 * WIKI (Fortis_Colosseum rev 15404131): reinforcements "arrive from either the north or south gates,
 * depending on which one they are closest to"; the maintainer confirms it. Every captured add is north
 * (38/38 in 25 waves; fixture `CAPTURED_PLAYER_TILES`), with the player at the start of T0+66 nearer
 * the north gate in all but C:1600, where they stood on (42,34): 16 from the south gate's opening (x
 * 31-34, y 18) and 17 from the north's (y 51), yet the jaguar came north. Either the measure is not to
 * the openings or the tile is from earlier (they stood on (43,36) at the start of T0+64). Measuring to
 * the middle-column 3x3 spawn tile, the captured (32,48) and its footprint's mirror (32,19), puts y 34
 * north (14 against 15) and fits every capture; near the gate columns y >= 34 is north. POLICY: the gate whose
 * middle-column spawn tile is nearer (Chebyshev, SW tile to the player's tile at the start of T0+66),
 * the north one on a tie (open question C3).
 */
export function colosseumReinforcementGate(player: Readonly<Coordinate>): ColosseumGate {
  const to = ([x, y]: Readonly<Coordinate>) => Math.max(Math.abs(player[0] - x), Math.abs(player[1] - y));
  return to([32, southGateRow(3)]) < to([32, NORTH_GATE_ROW]) ? 'south' : 'north';
}

/**
 * POLICY (open question C3; no capture has a south add): the captured north tiles mirrored across the
 * arena's east-west axis. The floor is symmetric there (rows 18 and 51 are walls at x 31-34, rows 19-21
 * mirror 50-48), and a north footprint's top row lies `3 - size` rows inside the north wall, so a south
 * footprint's bottom row lies as far inside the south wall: SW y = 22 - size (19, 20, 21 for sizes 3, 2,
 * 1), clear of the floor's edge and of the south pillars (rows 26-28).
 */
function southGateRow(size: number): number {
  return 22 - size;
}

const LAYOUT_STREAM = 0x434c4159;
const OFFER_STREAM = 0x434f4646;
const NPC_STREAM = 0x434e5043;

function streamSeed(seed: number, wave: number, stream: number): number {
  return fmix32((seed ^ Math.imul(wave, 0x9e3779b1) ^ stream) >>> 0);
}

/**
 * The run's per-wave streams, each from `(encounterSeed, wave)` alone, so none of them shifts Sol's
 * stream or another's: the layout, the offers going into `wave`, and the wave's NPC rolls.
 */
export const colosseumStreams = {
  layout: (seed: number, wave: number) => mulberry32(streamSeed(seed, wave, LAYOUT_STREAM)),
  offers: (seed: number, wave: number) => mulberry32(streamSeed(seed, wave, OFFER_STREAM)),
  npcs: (seed: number, wave: number) => mulberry32(streamSeed(seed, wave, NPC_STREAM)),
} as const;

export interface WarbandSpawn {
  readonly role: WarbanderRole;
  readonly position: Coordinate;
  readonly slotOffset: Readonly<Coordinate>;
  /** The Quartet member; it keeps Sol's Quartet fallback (none) rather than the trio's. */
  readonly quartet: boolean;
}

export interface SpeciesSpawn {
  readonly species: ColosseumWaveSpecies;
  readonly position: Coordinate;
}

/** A reinforcement's species and its gate column, drawn at T0; the gate itself is chosen at T0+66. */
export interface ReinforcementDraw {
  readonly species: ColosseumWaveSpecies;
  readonly x: number;
}

export interface ColosseumWaveLayout {
  readonly warband: readonly WarbandSpawn[];
  readonly initial: readonly SpeciesSpawn[];
  /**
   * The spawn point (`COLOSSEUM_SPAWN_POINTS` index) of each of the composition's initial NPCs, in its
   * order: `initial` without Dynamic Duo's partners, which stand off the points.
   */
  readonly initialPoints: readonly number[];
  readonly reinforcements: readonly ReinforcementDraw[];
  /**
   * Every manticore of the wave throws in this order. Policy: all 6 captured pairs shared one order
   * (W-NPC Manticore describes copying), so one draw per wave stands in for the copy; 50/50 is policy
   * (10 magic-first vs 12 ranged-first captured).
   */
  readonly manticoreFirstStyle: ManticoreFirstStyle;
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)]!;
}

/** Draws `count` distinct items in draw order. */
function drawDistinct<T>(items: readonly T[], count: number, random: () => number): T[] {
  if (count > items.length) throw new RangeError(`Cannot draw ${count} of ${items.length}`);
  const pool = [...items];
  return Array.from({ length: count }, () => pool.splice(Math.floor(random() * pool.length), 1)[0]!);
}

/** Every wave species but the warband is 3x3, except the 1x1 shaman and the 2x2 jaguar. */
export const COLOSSEUM_SPECIES_SIZES: Readonly<Record<ColosseumWaveSpecies, number>> = {
  serpentShaman: 1,
  jaguarWarrior: 2,
  javelinColossus: 3,
  manticore: 3,
  shockwaveColossus: 3,
  minotaur: 3,
};
const SHOCKWAVE_SIZE = COLOSSEUM_SPECIES_SIZES.shockwaveColossus;

/** An NPC's square footprint: its SW tile and side. */
export interface SpawnFootprint {
  readonly position: Readonly<Coordinate>;
  readonly size: number;
}

const overlaps = (a: Readonly<Coordinate>, aSize: number, b: Readonly<Coordinate>, bSize: number): boolean =>
  a[0] < b[0] + bSize && b[0] < a[0] + aSize && a[1] < b[1] + bSize && b[1] < a[1] + aSize;

/**
 * Dynamic Duo's partner for the shockwave at `primary`: WIKI-ONLY, "The paired Colossus spawns near
 * the main Colossus, but not necessarily on one of the 12 default spawns" (Fortis_Colosseum/Modifiers
 * rev 15163385; Strategies rev 15414089: "around the location of the first"). No capture owns Dynamic
 * Duo. Policy: the nearest SW tile (squared distance from the primary's SW tile) whose 3x3 footprint
 * lies on the waves floor (no pillar, no wall) and overlaps neither the primary nor any of `others`,
 * every other NPC spawning with it (the warband included); ties go south, then west (lower y, then
 * lower x). Adjacent footprints therefore come first, the one south of the primary before west, east
 * and north. No stream draw, so owning it moves no other roll.
 */
export function dynamicDuoPartnerTile(
  primary: Readonly<Coordinate>,
  others: readonly SpawnFootprint[],
  floor: ReadonlySet<string> = colosseumWaveFloorTiles(),
): Coordinate {
  const onFloor = ([x, y]: Readonly<Coordinate>) => {
    for (let dx = 0; dx < SHOCKWAVE_SIZE; dx++)
      for (let dy = 0; dy < SHOCKWAVE_SIZE; dy++) if (!floor.has(`${x + dx},${y + dy}`)) return false;
    return true;
  };
  const blocked = (tile: Readonly<Coordinate>) =>
    overlaps(tile, SHOCKWAVE_SIZE, primary, SHOCKWAVE_SIZE) ||
    others.some((other) => overlaps(tile, SHOCKWAVE_SIZE, other.position, other.size));
  const candidates = [...floor]
    .map((key) => key.split(',').map(Number) as Coordinate)
    .filter((tile) => onFloor(tile) && !blocked(tile));
  const distance = ([x, y]: Coordinate) => (x - primary[0]) ** 2 + (y - primary[1]) ** 2;
  candidates.sort((a, b) => distance(a) - distance(b) || a[1] - b[1] || a[0] - b[0]);
  const partner = candidates[0];
  if (!partner) throw new RangeError(`No legal Dynamic Duo tile near ${primary.join(',')}`);
  return partner;
}

/**
 * Each shockwave followed by its Dynamic Duo partner, placed clear of everything spawning with it:
 * the other initial NPCs and the warband (Quartet included), whose members are one tile each.
 */
function withDynamicDuo(spawns: readonly SpeciesSpawn[], warband: readonly WarbandSpawn[]): SpeciesSpawn[] {
  const placed = [...spawns];
  const warbandFootprints = warband.map((member): SpawnFootprint => ({ position: member.position, size: 1 }));
  for (const spawn of spawns) {
    if (spawn.species !== 'shockwaveColossus') continue;
    const partner: SpeciesSpawn = {
      species: 'shockwaveColossus',
      position: dynamicDuoPartnerTile(spawn.position, [
        ...warbandFootprints,
        ...placed
          .filter((other) => other !== spawn)
          .map((other) => ({ position: other.position, size: COLOSSEUM_SPECIES_SIZES[other.species] })),
      ]),
    };
    placed.splice(placed.indexOf(spawn) + 1, 0, partner);
  }
  return placed;
}

/**
 * The reinforcements' tiles at the chosen gate. North: the captured row; south: `southGateRow` for each
 * footprint. No wave reinforces with a shockwave, so Dynamic Duo pairs none of them.
 */
export function placeReinforcements(draws: readonly ReinforcementDraw[], gate: ColosseumGate): SpeciesSpawn[] {
  return draws.map(({ species, x }) => ({
    species,
    position: [x, gate === 'north' ? NORTH_GATE_ROW : southGateRow(COLOSSEUM_SPECIES_SIZES[species])],
  }));
}

/**
 * The initial NPCs' spawn points (`COLOSSEUM_SPAWN_POINTS` indices) in composition order. Without a
 * layout, the drawn points in draw order. With one, each NPC it places takes its point (two of a
 * species fill theirs in point order), and the rest take the drawn points it leaves free, in draw
 * order: the drawn points outnumber the NPCs left by at least the chosen ones they include.
 */
function initialPointIndices(
  species: readonly ColosseumWaveSpecies[],
  drawn: readonly number[],
  layout: ColosseumSpawnLayout | null,
): number[] {
  if (!layout) return [...drawn];
  const taken = new Set<number>();
  const free = drawn.filter((index) => layout.points[index] === null);
  let nextFree = 0;
  const indices = species.map((wanted) => {
    const placed = layout.points.findIndex((chosen, index) => chosen === wanted && !taken.has(index));
    const index = placed >= 0 ? placed : free[nextFree++];
    if (index === undefined) throw new RangeError(`Wave ${layout.wave} has more initial NPCs than free points`);
    taken.add(index);
    return index;
  });
  if (layout.points.some((chosen, index) => chosen !== null && !taken.has(index))) {
    throw new RangeError(`Spawn layout places more NPCs than wave ${layout.wave} starts`);
  }
  return indices;
}

/**
 * The whole wave's layout, drawn at its start from the wave's layout stream in a fixed order:
 * berserker tile, Quartet role, initial points, manticore order, reinforcement columns. Drawing the
 * reinforcements up front keeps the stream's use independent of how the wave goes. The initial points
 * are drawn among those clear of `player`, the player's tile at the start of T0
 * (`isSpawnPointClearOfPlayer`); Dynamic Duo's partners draw nothing (`dynamicDuoPartnerTile`).
 *
 * A `spawnLayout` for this wave (a practice option, `spawnLayout.ts`) puts its NPCs on its chosen
 * points, even ones the player is too close to, and the rest on the drawn points it leaves free
 * (`initialPointIndices`). The points are drawn all the same, so every later draw is unchanged; a
 * layout for another wave changes nothing.
 */
export function planColosseumWave(input: {
  readonly wave: number;
  readonly quartet: boolean;
  readonly dynamicDuo: boolean;
  readonly player: Readonly<Coordinate>;
  readonly random: () => number;
  readonly spawnLayout?: ColosseumSpawnLayout | null;
}): ColosseumWaveLayout {
  const { random } = input;
  const composition = colosseumWave(input.wave);
  const box = WARBAND_BERSERKER_BOX;
  const berserker: Coordinate = [
    box.minX + Math.floor(random() * (box.maxX - box.minX + 1)),
    box.minY + Math.floor(random() * (box.maxY - box.minY + 1)),
  ];
  const center: Coordinate = [
    berserker[0] - WARBAND_SLOT_OFFSETS.berserker[0],
    berserker[1] - WARBAND_SLOT_OFFSETS.berserker[1],
  ];
  const at = (offset: Readonly<Coordinate>): Coordinate => [center[0] + offset[0], center[1] + offset[1]];
  const warband: WarbandSpawn[] = (['berserker', 'archer', 'seer'] as const).map((role) => ({
    role,
    position: at(WARBAND_SLOT_OFFSETS[role]),
    slotOffset: WARBAND_SLOT_OFFSETS[role],
    quartet: false,
  }));
  // W-Mod: "An extra random Fremennik Warbander"; uniform over the three roles is policy.
  if (input.quartet) {
    warband.push({
      role: pick(WARBANDER_ROLES, random),
      position: at(WARBAND_SLOT_OFFSETS.quartet),
      slotOffset: WARBAND_SLOT_OFFSETS.quartet,
      quartet: true,
    });
  }
  // From any floor tile at least five points stay clear (at most four lie within the clearance), and a
  // wave starts at most four initial NPCs, so the draw never runs short (layout.test.ts).
  const eligible = COLOSSEUM_SPAWN_POINTS.flatMap((point, index) =>
    isSpawnPointClearOfPlayer(point, input.player) ? [index] : [],
  );
  const drawn = drawDistinct(eligible, composition.initial.length, random);
  const layout = input.spawnLayout?.wave === input.wave ? input.spawnLayout : null;
  const points = initialPointIndices(composition.initial, drawn, layout);
  const initial = composition.initial.map((species, index) => ({
    species,
    position: [...COLOSSEUM_SPAWN_POINTS[points[index]!]!] as Coordinate,
  }));
  const manticoreFirstStyle: ManticoreFirstStyle = random() < 0.5 ? 'ranged' : 'magic';
  const columns = drawDistinct(REINFORCEMENT_COLUMNS, composition.reinforcements.length, random);
  const reinforcements = composition.reinforcements.map((species, index) => ({ species, x: columns[index]! }));
  return {
    warband,
    initial: input.dynamicDuo ? withDynamicDuo(initial, warband) : initial,
    initialPoints: points,
    reinforcements,
    manticoreFirstStyle,
  };
}
