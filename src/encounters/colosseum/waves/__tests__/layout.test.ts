import { describe, expect, it } from 'vitest';
import { WARBAND_SLOT_OFFSETS } from '../../../../npcs/colosseum/warband';
import type { Coordinate } from '../../../../types/simulation';
import { colosseumWaveFloorTiles } from '../arena';
import type { SpeciesSpawn } from '../layout';
import {
  COLOSSEUM_REINFORCEMENT_TILES,
  COLOSSEUM_SPAWN_POINTS,
  colosseumReinforcementGate,
  colosseumStreams,
  dynamicDuoPartnerTile,
  isSpawnPointClearOfPlayer,
  placeReinforcements,
  planColosseumWave,
  WARBAND_BERSERKER_BOX,
} from '../layout';
import { type ColosseumLayoutSpecies, type ColosseumSpawnLayout, validateColosseumSpawnLayout } from '../spawnLayout';
import { COLOSSEUM_WAVES, colosseumWave } from '../waveTable';
import { CAPTURED_PLAYER_TILES, CAPTURED_WAVE_STARTS } from './fixtures/waveLayoutCapture';

const key = ([x, y]: readonly number[]) => `${x},${y}`;
/** The Wiki's NW-pillar start tile, where every capture's player waited (A, B, C). */
const START: [number, number] = [23, 36];
/** The three default spawns no capture shows (third-party recordings; open question A2). */
const WEST_POINTS = ['19,32', '25,34', '19,37'];
const sorted = <T>(items: readonly T[]) => [...items].map(String).sort();

describe('the wave table against the captures', () => {
  it.each(CAPTURED_WAVE_STARTS)('$capture wave $wave starts and reinforces as the table says', (start) => {
    const composition = colosseumWave(start.wave);
    expect(sorted(start.initial.map(([species]) => species))).toEqual(sorted(composition.initial));
    // A death before T0+66 (B wave 8) or a clear before it (both wave 1s) records none.
    if (start.completedAfter !== null && start.completedAfter > 66) {
      expect(sorted(start.reinforcements.map(([species]) => species))).toEqual(sorted(composition.reinforcements));
    }
  });

  it('places every captured spawn on the pools the layout draws from', () => {
    const points = new Set(COLOSSEUM_SPAWN_POINTS.map(key));
    const gates = new Set(COLOSSEUM_REINFORCEMENT_TILES.map(key));
    for (const start of CAPTURED_WAVE_STARTS) {
      const tiles = start.initial.map(([, x, y]) => key([x, y]));
      expect(
        tiles.every((tile) => points.has(tile)),
        `${start.capture} wave ${start.wave}`,
      ).toBe(true);
      expect(new Set(tiles).size).toBe(tiles.length);
      expect(start.reinforcements.every(([, x, y]) => gates.has(key([x, y])))).toBe(true);
      const [bx, by] = [
        start.center[0] + WARBAND_SLOT_OFFSETS.berserker[0],
        start.center[1] + WARBAND_SLOT_OFFSETS.berserker[1],
      ];
      expect(bx >= WARBAND_BERSERKER_BOX.minX && bx <= WARBAND_BERSERKER_BOX.maxX).toBe(true);
      expect(by >= WARBAND_BERSERKER_BOX.minY && by <= WARBAND_BERSERKER_BOX.maxY).toBe(true);
      if (start.quartet) {
        expect(start.quartet).toEqual([
          start.center[0] + WARBAND_SLOT_OFFSETS.quartet[0],
          start.center[1] + WARBAND_SLOT_OFFSETS.quartet[1],
        ]);
      }
    }
    // The captures used every point but the three west ones.
    expect(new Set(CAPTURED_WAVE_STARTS.flatMap((start) => start.initial.map(([, x, y]) => key([x, y]))))).toEqual(
      new Set([...points].filter((tile) => !WEST_POINTS.includes(tile))),
    );
  });
});

describe('planColosseumWave', () => {
  const floor = colosseumWaveFloorTiles();
  const footprintOnFloor = ([x, y]: readonly number[], size: number) => {
    for (let dx = 0; dx < size; dx++)
      for (let dy = 0; dy < size; dy++) if (!floor.has(key([x + dx, y + dy]))) return false;
    return true;
  };

  it('is a pure function of the wave stream', () => {
    for (let wave = 1; wave <= 11; wave++) {
      const plan = () =>
        planColosseumWave({
          wave,
          quartet: true,
          dynamicDuo: false,
          player: START,
          random: colosseumStreams.layout(99, wave),
        });
      expect(plan()).toEqual(plan());
    }
    expect(
      planColosseumWave({
        wave: 5,
        quartet: false,
        dynamicDuo: false,
        player: START,
        random: colosseumStreams.layout(1, 5),
      }),
    ).not.toEqual(
      planColosseumWave({
        wave: 5,
        quartet: false,
        dynamicDuo: false,
        player: START,
        random: colosseumStreams.layout(2, 5),
      }),
    );
  });

  it('draws legal layouts: the formation, distinct clear points, distinct gate columns and one manticore order', () => {
    const points = new Set(COLOSSEUM_SPAWN_POINTS.map(key));
    const columns = new Set(COLOSSEUM_REINFORCEMENT_TILES.map(([x]) => x));
    const floorTiles = [...floor].map((tile) => tile.split(',').map(Number) as [number, number]);
    const berserkers = new Set<string>();
    const styles = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      // Anywhere on the floor: the draw never runs short of clear points.
      const player = floorTiles[(seed * 7919) % floorTiles.length]!;
      for (const wave of Object.keys(COLOSSEUM_WAVES).map(Number)) {
        const layout = planColosseumWave({
          wave,
          quartet: seed % 2 === 0,
          dynamicDuo: false,
          player,
          random: colosseumStreams.layout(seed, wave),
        });
        const [berserker, archer, seer, quartet] = layout.warband;
        expect(berserker!.role).toBe('berserker');
        berserkers.add(key(berserker!.position));
        const center = [berserker!.position[0], berserker!.position[1] - 1];
        expect(archer!.position).toEqual([center[0]! - 1, center[1]]);
        expect(seer!.position).toEqual([center[0]! + 1, center[1]]);
        if (seed % 2 === 0) expect(quartet).toMatchObject({ quartet: true, position: [center[0], center[1]! - 1] });
        else expect(quartet).toBeUndefined();
        const tiles = layout.initial.map((spawn) => key(spawn.position));
        expect(new Set(tiles).size).toBe(tiles.length);
        expect(tiles.every((tile) => points.has(tile))).toBe(true);
        for (const spawn of layout.initial) expect(isSpawnPointClearOfPlayer(spawn.position, player)).toBe(true);
        expect(layout.initial.map((spawn) => spawn.species)).toEqual(colosseumWave(wave).initial);
        for (const spawn of layout.initial) expect(footprintOnFloor(spawn.position, 3)).toBe(true);
        const gateColumns = layout.reinforcements.map((draw) => draw.x);
        expect(new Set(gateColumns).size).toBe(gateColumns.length);
        expect(gateColumns.every((x) => columns.has(x))).toBe(true);
        expect(layout.reinforcements.map((draw) => draw.species)).toEqual(colosseumWave(wave).reinforcements);
        styles.add(layout.manticoreFirstStyle);
      }
    }
    // Uniform over the 7x7 box: every tile turns up.
    expect(berserkers.size).toBe(49);
    expect(styles).toEqual(new Set(['ranged', 'magic']));
  });
});

describe('initial spawn points avoid the player', () => {
  const T0 = 5;
  const captured = CAPTURED_PLAYER_TILES.map((tiles, index) => ({ ...tiles, start: CAPTURED_WAVE_STARTS[index]! }));

  it('lines the player fixture up with the wave starts', () => {
    expect(captured.map(({ capture, wave }) => [capture, wave])).toEqual(
      CAPTURED_WAVE_STARTS.map(({ capture, wave }) => [capture, wave]),
    );
  });

  it.each(
    captured.filter(({ startTiles }) => startTiles !== null),
  )("$capture wave $wave used only points clear of the player's tile at the start of T0", ({ startTiles, start }) => {
    const player = startTiles![T0]!;
    for (const [, x, y] of start.initial) expect(isSpawnPointClearOfPlayer([x, y], player)).toBe(true);
  });

  it('is decided after B wave 1 walked off (35,31): at T0-3 that point was not yet clear', () => {
    const b1 = captured.find(({ capture, wave }) => capture === 'B' && wave === 1)!;
    expect(b1.start.initial.map(([, x, y]) => key([x, y]))).toContain('35,31');
    expect(isSpawnPointClearOfPlayer([35, 31], b1.startTiles![T0 - 3]!)).toBe(false);
    for (const tick of [T0 - 2, T0 - 1, T0])
      expect(isSpawnPointClearOfPlayer([35, 31], b1.startTiles![tick]!)).toBe(true);
  });

  it('keeps the west area clear from the start tile, and never leaves fewer points than a wave needs', () => {
    expect(COLOSSEUM_SPAWN_POINTS).toHaveLength(12);
    expect(
      COLOSSEUM_SPAWN_POINTS.filter((point) => !isSpawnPointClearOfPlayer(point, START))
        .map(key)
        .sort(),
    ).toEqual([...WEST_POINTS].sort());
    // Initial NPCs are the 1x1 shaman or 3x3: both footprints lie on the floor at each west point.
    const floor = colosseumWaveFloorTiles();
    for (const tile of WEST_POINTS) {
      const [x, y] = tile.split(',').map(Number) as [number, number];
      for (const size of [1, 3])
        for (let dx = 0; dx < size; dx++)
          for (let dy = 0; dy < size; dy++) expect(floor.has(key([x + dx, y + dy])), `${tile} size ${size}`).toBe(true);
    }
    const most = Math.max(...Object.keys(COLOSSEUM_WAVES).map((wave) => colosseumWave(Number(wave)).initial.length));
    for (const tile of colosseumWaveFloorTiles()) {
      const player = tile.split(',').map(Number) as [number, number];
      const clear = COLOSSEUM_SPAWN_POINTS.filter((point) => isSpawnPointClearOfPlayer(point, player));
      expect(clear.length, tile).toBeGreaterThanOrEqual(most + 1);
    }
  });

  it('excludes a point within Chebyshev 4 of the player and keeps one 5 away', () => {
    expect(isSpawnPointClearOfPlayer([35, 31], [31, 35])).toBe(false);
    expect(isSpawnPointClearOfPlayer([35, 31], [39, 27])).toBe(false);
    expect(isSpawnPointClearOfPlayer([35, 31], [30, 33])).toBe(true);
    expect(isSpawnPointClearOfPlayer([35, 31], [35, 36])).toBe(true);
  });

  it('draws among the clear points only, from the same stream', () => {
    // Among the four center points: every seed avoids them all.
    const player: [number, number] = [32, 34];
    const near = COLOSSEUM_SPAWN_POINTS.filter((point) => !isSpawnPointClearOfPlayer(point, player)).map(key);
    expect(near.sort()).toEqual(['29,31', '29,37', '35,31', '35,37']);
    const used = new Set<string>();
    for (let seed = 0; seed < 200; seed++) {
      const layout = planColosseumWave({
        wave: 6,
        quartet: false,
        dynamicDuo: false,
        player,
        random: colosseumStreams.layout(seed, 6),
      });
      for (const spawn of layout.initial) used.add(key(spawn.position));
    }
    expect([...used].sort()).toEqual(
      COLOSSEUM_SPAWN_POINTS.map(key)
        .filter((tile) => !near.includes(tile))
        .sort(),
    );
  });
});

describe('the reinforcements gate', () => {
  const floor = colosseumWaveFloorTiles();
  const SIZES = { serpentShaman: 1, jaguarWarrior: 2, minotaur: 3 } as const;

  it.each(
    CAPTURED_PLAYER_TILES.filter(({ reinforcementTile }) => reinforcementTile !== null),
  )('$capture wave $wave reinforced north with the player nearer it at the start of T0+66', ({ reinforcementTile }) => {
    expect(colosseumReinforcementGate(reinforcementTile!)).toBe('north');
  });

  it('picks the gate nearer the player, north on a tie', () => {
    expect(colosseumReinforcementGate([32, 32])).toBe('south');
    expect(colosseumReinforcementGate([32, 33])).toBe('south');
    expect(colosseumReinforcementGate([32, 34])).toBe('north');
    expect(colosseumReinforcementGate([44, 22])).toBe('south');
    expect(colosseumReinforcementGate([20, 46])).toBe('north');
    // 15 from both gate tiles: x outweighs y.
    expect(floor.has('17,33')).toBe(true);
    expect(colosseumReinforcementGate([17, 33])).toBe('north');
  });

  it('stands on a floor that mirrors north to south', () => {
    for (const tile of floor) {
      const [x, y] = tile.split(',').map(Number) as [number, number];
      expect(floor.has(key([x, 69 - y])), tile).toBe(true);
    }
  });

  it('keeps the drawn column and puts each footprint as far inside the south wall as the north one', () => {
    for (const [species, size] of Object.entries(SIZES) as [keyof typeof SIZES, number][]) {
      for (const [x] of COLOSSEUM_REINFORCEMENT_TILES) {
        const [north] = placeReinforcements([{ species, x }], 'north');
        const [south] = placeReinforcements([{ species, x }], 'south');
        expect(north!.position).toEqual([x, 48]);
        expect(south!.position[0]).toBe(x);
        // The floor mirrors across y = 34.5 (row 18 <-> 51; checked below), so rows mirror as y -> 69 - y.
        const rows = (y: number) => Array.from({ length: size }, (_, dy) => y + dy);
        expect(rows(south!.position[1]).sort()).toEqual(
          rows(48)
            .map((y) => 69 - y)
            .sort(),
        );
        for (const gate of [north!, south!])
          for (let dx = 0; dx < size; dx++)
            for (let dy = 0; dy < size; dy++)
              expect(
                floor.has(key([gate.position[0] + dx, gate.position[1] + dy])),
                `${species} ${gate.position}`,
              ).toBe(true);
      }
    }
  });
});

describe('Dynamic Duo', () => {
  const floor = colosseumWaveFloorTiles();
  const sizes: Record<string, number> = { serpentShaman: 1, jaguarWarrior: 2 };
  const size = (species: string) => sizes[species] ?? 3;
  const overlap = (a: SpeciesSpawn, b: SpeciesSpawn) =>
    a.position[0] < b.position[0] + size(b.species) &&
    b.position[0] < a.position[0] + size(a.species) &&
    a.position[1] < b.position[1] + size(b.species) &&
    b.position[1] < a.position[1] + size(a.species);
  /** A warband member as a spawn of the 1x1 size the overlap check reads. */
  const warbander = (position: readonly [number, number]): SpeciesSpawn => ({
    species: 'serpentShaman',
    position: [...position],
  });

  it('follows each shockwave with a partner on the nearest clear floor footprint, drawing nothing extra', () => {
    let pairs = 0;
    for (let seed = 0; seed < 200; seed++) {
      for (const wave of Object.keys(COLOSSEUM_WAVES).map(Number)) {
        const plan = (dynamicDuo: boolean) =>
          planColosseumWave({
            wave,
            quartet: seed % 2 === 0,
            dynamicDuo,
            // The start tile, and the opening tile, from which the west points are drawn too.
            player: seed % 2 === 0 ? START : [32, 32],
            random: colosseumStreams.layout(seed, wave),
          });
        const single = plan(false);
        const duo = plan(true);
        // The same draws: everything else in the layout is unchanged.
        expect(duo.warband).toEqual(single.warband);
        expect(duo.manticoreFirstStyle).toBe(single.manticoreFirstStyle);
        expect(duo.reinforcements).toEqual(single.reinforcements);
        {
          const [solo, paired] = [single.initial, duo.initial];
          const shockwaves = solo.filter((spawn) => spawn.species === 'shockwaveColossus').length;
          expect(paired).toHaveLength(solo.length + shockwaves);
          // Each original spawn keeps its tile, and a shockwave's partner comes right after it.
          let cursor = 0;
          for (const spawn of solo) {
            expect(paired[cursor]).toEqual(spawn);
            cursor += 1;
            if (spawn.species !== 'shockwaveColossus') continue;
            const partner = paired[cursor]!;
            cursor += 1;
            pairs += 1;
            expect(partner.species).toBe('shockwaveColossus');
            for (let dx = 0; dx < 3; dx++)
              for (let dy = 0; dy < 3; dy++)
                expect(floor.has(key([partner.position[0] + dx, partner.position[1] + dy]))).toBe(true);
            for (const other of paired) if (other !== partner) expect(overlap(partner, other)).toBe(false);
            for (const member of duo.warband) expect(overlap(partner, warbander(member.position))).toBe(false);
            const [dx, dy] = [0, 1].map((axis) => Math.abs(partner.position[axis]! - spawn.position[axis]!));
            // Sharing an edge with the primary's footprint.
            expect((dx === 3 && dy! <= 2) || (dy === 3 && dx! <= 2)).toBe(true);
          }
        }
      }
    }
    // Waves 7, 8 and 11 have one shockwave each.
    expect(pairs).toBe(200 * 3);
  });

  it.each([
    // The seer on (35,34), south of the primary on (35,37).
    { seed: 7, quartet: false, blocker: 'seer' },
    { seed: 230, quartet: true, blocker: 'quartet' },
  ])('keeps the partner off the warband (seed $seed, wave 7, $blocker), drawing the same', ({ seed, quartet }) => {
    let draws = 0;
    const plan = (dynamicDuo: boolean) => {
      draws = 0;
      const random = colosseumStreams.layout(seed, 7);
      const layout = planColosseumWave({
        wave: 7,
        quartet,
        dynamicDuo,
        player: [32, 32],
        random: () => {
          draws += 1;
          return random();
        },
      });
      return { layout, draws };
    };
    const single = plan(false);
    const duo = plan(true);
    expect(duo.draws).toBe(single.draws);
    const index = duo.layout.initial.findIndex((spawn) => spawn.species === 'shockwaveColossus');
    const [primary, partner] = duo.layout.initial.slice(index, index + 2);
    expect({ ...duo.layout, initial: duo.layout.initial.filter((spawn) => spawn !== partner) }).toEqual(single.layout);
    const members = duo.layout.warband.map((member) => warbander(member.position));
    // Placed among the other initial NPCs alone, the partner would stand on a warbander.
    const initialOnly = dynamicDuoPartnerTile(
      primary!.position,
      single.layout.initial
        .filter((spawn) => spawn.species !== 'shockwaveColossus')
        .map((spawn) => ({ position: spawn.position, size: size(spawn.species) })),
    );
    expect(members.some((member) => overlap({ species: 'shockwaveColossus', position: initialOnly }, member))).toBe(
      true,
    );
    expect(members.some((member) => overlap(partner!, member))).toBe(false);
    if (quartet) expect(duo.layout.warband.filter((member) => member.quartet)).toHaveLength(1);
  });

  it('breaks ties south, then west, and steps past pillars, walls and the other spawns', () => {
    // Open floor all round (35,31) -> adjacent south (35,28).
    expect(dynamicDuoPartnerTile([35, 31], [])).toEqual([35, 28]);
    // South taken by another spawn: west next.
    expect(dynamicDuoPartnerTile([35, 31], [{ position: [35, 28], size: 3 }])).toEqual([32, 31]);
    // A one-tile warbander there blocks it just the same.
    expect(dynamicDuoPartnerTile([35, 31], [{ position: [36, 30], size: 1 }])).toEqual([32, 31]);
    // (44,32) on the east wall: its east footprint is off the floor, so the next nearest is chosen.
    expect(dynamicDuoPartnerTile([44, 32], [])).toEqual([44, 29]);
    // (40,35)'s south neighbour (40,32) is clear, but (39,26)'s pillar never is.
    const partner = dynamicDuoPartnerTile([40, 27], []);
    expect(
      overlap({ species: 'shockwaveColossus', position: partner }, { species: 'minotaur', position: [39, 26] }),
    ).toBe(false);
  });
});

describe('a practice spawn layout', () => {
  const floor = colosseumWaveFloorTiles();
  const sizes: Record<string, number> = { serpentShaman: 1, jaguarWarrior: 2 };
  const size = (species: string) => sizes[species] ?? 3;
  const overlapping = (a: SpeciesSpawn, b: { position: readonly number[]; species?: string }, bSize?: number) => {
    const other = bSize ?? size(b.species ?? '');
    return (
      a.position[0] < b.position[0]! + other &&
      b.position[0]! < a.position[0] + size(a.species) &&
      a.position[1] < b.position[1]! + other &&
      b.position[1]! < a.position[1] + size(a.species)
    );
  };
  /** The wave's layout and how many draws it took. */
  const plan = (
    seed: number,
    wave: number,
    spawnLayout: ColosseumSpawnLayout | null | undefined,
    options: { player?: Coordinate; dynamicDuo?: boolean; quartet?: boolean } = {},
  ) => {
    let draws = 0;
    const stream = colosseumStreams.layout(seed, wave);
    const layout = planColosseumWave({
      wave,
      quartet: options.quartet ?? seed % 2 === 0,
      dynamicDuo: options.dynamicDuo ?? false,
      player: options.player ?? START,
      random: () => {
        draws += 1;
        return stream();
      },
      ...(spawnLayout === undefined ? {} : { spawnLayout }),
    });
    return { layout, draws };
  };
  const at = (placed: Readonly<Record<number, ColosseumLayoutSpecies>>, wave: number) => {
    const result = validateColosseumSpawnLayout(
      wave,
      COLOSSEUM_SPAWN_POINTS.map((_, index) => placed[index] ?? null),
    );
    if (!result.ok) throw new Error(result.message);
    return result.layout;
  };

  it('changes nothing without one, or with one for another wave', () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const wave of Object.keys(COLOSSEUM_WAVES).map(Number)) {
        const base = plan(seed, wave, undefined);
        expect(plan(seed, wave, null)).toEqual(base);
        const other = wave === 1 ? at({ 0: 'javelinColossus' }, 2) : at({ 0: 'serpentShaman' }, 1);
        expect(plan(seed, wave, other)).toEqual(base);
      }
    }
  });

  it('puts its NPCs on their points and the rest on the drawn points it leaves free, drawing the same', () => {
    // Wave 8: javelin, javelin, manticore, shockwave. One javelin and the shockwave chosen.
    const layout = at({ 4: 'javelinColossus', 0: 'shockwaveColossus' }, 8);
    const chosen = ['35,37', '44,32'];
    for (let seed = 0; seed < 200; seed++) {
      const base = plan(seed, 8, null);
      const custom = plan(seed, 8, layout);
      expect(custom.draws).toBe(base.draws);
      expect({ ...custom.layout, initial: [], initialPoints: [] }).toEqual({
        ...base.layout,
        initial: [],
        initialPoints: [],
      });
      // The points it reports are the ones the NPCs stand on.
      expect(custom.layout.initialPoints.map((point) => key(COLOSSEUM_SPAWN_POINTS[point]!))).toEqual(
        custom.layout.initial.map((spawn) => key(spawn.position)),
      );
      expect(custom.layout.initial.map((spawn) => spawn.species)).toEqual(colosseumWave(8).initial);
      const [firstJavelin, secondJavelin, manticore, shockwave] = custom.layout.initial.map((spawn) => spawn.position);
      expect([key(firstJavelin!), key(shockwave!)]).toEqual(chosen);
      // The remainder: today's draws in draw order, less the chosen points.
      const free = base.layout.initial.map((spawn) => key(spawn.position)).filter((tile) => !chosen.includes(tile));
      expect([key(secondJavelin!), key(manticore!)]).toEqual(free.slice(0, 2));
      for (const position of [secondJavelin!, manticore!])
        expect(isSpawnPointClearOfPlayer(position, START)).toBe(true);
    }
  });

  it('honors a chosen point the player is too close to; the drawn ones stay clear', () => {
    // (25,34) is 2 from the start tile.
    const layout = at({ 10: 'manticore' }, 4);
    expect(isSpawnPointClearOfPlayer([25, 34], START)).toBe(false);
    for (let seed = 0; seed < 50; seed++) {
      const [shaman, manticore] = plan(seed, 4, layout).layout.initial;
      expect(manticore).toEqual({ species: 'manticore', position: [25, 34] });
      expect(isSpawnPointClearOfPlayer(shaman!.position, START)).toBe(true);
    }
  });

  it('pairs a chosen shockwave under Dynamic Duo, every partner clear of the chosen points and the warband', () => {
    // Wave 11: javelin, manticore, manticore, shockwave; the shockwave and a manticore chosen.
    const layout = at({ 6: 'shockwaveColossus', 3: 'manticore' }, 11);
    for (let seed = 0; seed < 200; seed++) {
      const single = plan(seed, 11, layout);
      const duo = plan(seed, 11, layout, { dynamicDuo: true });
      expect(duo.draws).toBe(single.draws);
      const index = duo.layout.initial.findIndex((spawn) => spawn.species === 'shockwaveColossus');
      const [primary, partner] = duo.layout.initial.slice(index, index + 2);
      expect(primary!.position).toEqual([35, 31]);
      expect(partner!.species).toBe('shockwaveColossus');
      expect({ ...duo.layout, initial: duo.layout.initial.filter((spawn) => spawn !== partner) }).toEqual(
        single.layout,
      );
      for (let dx = 0; dx < 3; dx++)
        for (let dy = 0; dy < 3; dy++)
          expect(floor.has(key([partner!.position[0] + dx, partner!.position[1] + dy]))).toBe(true);
      for (const other of duo.layout.initial) if (other !== partner) expect(overlapping(partner!, other)).toBe(false);
      for (const member of duo.layout.warband) expect(overlapping(partner!, member, 1)).toBe(false);
    }
  });
});
