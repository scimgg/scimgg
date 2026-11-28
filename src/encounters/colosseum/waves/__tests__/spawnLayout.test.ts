import { describe, expect, it } from 'vitest';
import { COLOSSEUM_SPAWN_POINTS } from '../layout';
import {
  COLOSSEUM_WAVE_START_TILE,
  type ColosseumLayoutSpecies,
  type ColosseumSpawnLayout,
  colosseumLayoutSpeciesForWave,
  colosseumSpawnLayoutWarnings,
  isColosseumStartTileOpen,
  isCompleteColosseumSpawnLayout,
  parseColosseumSpawnLayout,
  parseColosseumStartTile,
  resolveColosseumStartTile,
  serializeColosseumSpawnLayout,
  serializeColosseumStartTile,
  validateColosseumSpawnLayout,
} from '../spawnLayout';
import { COLOSSEUM_WAVES } from '../waveTable';

/** Twelve points, `placed` by index. */
const points = (placed: Readonly<Record<number, ColosseumLayoutSpecies>> = {}) =>
  COLOSSEUM_SPAWN_POINTS.map((_, index) => placed[index] ?? null);

function layout(wave: number, placed: Readonly<Record<number, ColosseumLayoutSpecies>>): ColosseumSpawnLayout {
  const result = validateColosseumSpawnLayout(wave, points(placed));
  if (!result.ok) throw new Error(result.message);
  return result.layout;
}

describe('validateColosseumSpawnLayout', () => {
  it("accepts any part of the wave's initial NPCs, complete or not", () => {
    const partial = layout(8, { 0: 'javelinColossus', 6: 'shockwaveColossus' });
    expect(isCompleteColosseumSpawnLayout(partial)).toBe(false);
    const complete = layout(8, { 0: 'javelinColossus', 1: 'javelinColossus', 2: 'manticore', 6: 'shockwaveColossus' });
    expect(isCompleteColosseumSpawnLayout(complete)).toBe(true);
    for (const wave of Object.keys(COLOSSEUM_WAVES).map(Number)) {
      const species = colosseumLayoutSpeciesForWave(wave);
      const full = Object.fromEntries(species.map((kind, index) => [index, kind]));
      expect(isCompleteColosseumSpawnLayout(layout(wave, full)), `wave ${wave}`).toBe(true);
    }
  });

  it('names the structural problem: the wave, the point count, an empty layout, a species too many', () => {
    const error = (wave: number, slots: readonly (ColosseumLayoutSpecies | null)[]) => {
      const result = validateColosseumSpawnLayout(wave, slots);
      return result.ok ? null : result.error;
    };
    const one = points({ 0: 'serpentShaman' });
    for (const wave of [0, 12, 2.5, Number.NaN]) expect(error(wave, one)).toBe('bad-wave');
    expect(error(1, one.slice(0, 11))).toBe('bad-points');
    expect(error(1, [...one, null])).toBe('bad-points');
    expect(error(1, points())).toBe('empty');
    // Wave 1 starts one shaman: two, or a species it lacks, do not fit.
    expect(error(1, points({ 0: 'serpentShaman', 1: 'serpentShaman' }))).toBe('composition-mismatch');
    expect(error(1, points({ 0: 'javelinColossus' }))).toBe('composition-mismatch');
    // A reinforcement species never spawns on a point.
    expect(error(1, points({ 0: 'jaguarWarrior' as ColosseumLayoutSpecies }))).toBe('composition-mismatch');
    expect(error(1, one)).toBeNull();
  });
});

describe('the colosseumSpawnLayout mechanics value', () => {
  it('round-trips every layout one char per point', () => {
    const value = serializeColosseumSpawnLayout(
      layout(11, { 1: 'javelinColossus', 4: 'manticore', 8: 'manticore', 11: 'shockwaveColossus' }),
    );
    expect(value).toBe('11:-j--m---m--w');
    expect(parseColosseumSpawnLayout(value)).toEqual(
      layout(11, { 1: 'javelinColossus', 4: 'manticore', 8: 'manticore', 11: 'shockwaveColossus' }),
    );
    expect(serializeColosseumSpawnLayout(layout(1, { 9: 'serpentShaman' }))).toBe('1:---------s--');
  });

  it('reads garbage and invalid layouts as random', () => {
    for (const value of [
      undefined,
      true,
      '',
      '1',
      '1:s',
      '1:s----------',
      '1:s-----------x',
      '0:s-----------',
      '12:s-----------',
      '1:ss----------',
      '1:j-----------',
      '1:------------',
      ' 1:s-----------',
    ])
      expect(parseColosseumSpawnLayout(value), String(value)).toBeNull();
    expect(parseColosseumSpawnLayout('1:s-----------')).toEqual(layout(1, { 0: 'serpentShaman' }));
  });
});

describe('the colosseumStartTile mechanics value', () => {
  it('opens on a chosen floor tile, else the default', () => {
    expect(COLOSSEUM_WAVE_START_TILE).toEqual([23, 38]);
    expect(serializeColosseumStartTile([30, 40])).toBe('30,40');
    expect(parseColosseumStartTile('30,40')).toEqual([30, 40]);
    expect(resolveColosseumStartTile('30,40')).toEqual([30, 40]);
    for (const value of [undefined, '', '30', '30,40,1', '-1,4', 'x,y', '30, 40'])
      expect(resolveColosseumStartTile(value), String(value)).toEqual([23, 38]);
    // A pillar (SW 39,26, 3x3) and past the wall are not floor.
    expect(isColosseumStartTileOpen([40, 27])).toBe(false);
    expect(resolveColosseumStartTile('40,27')).toEqual([23, 38]);
    expect(resolveColosseumStartTile('5,5')).toEqual([23, 38]);
    expect(isColosseumStartTileOpen([16, 31])).toBe(true);
    expect(isColosseumStartTileOpen([16, 30])).toBe(false);
  });
});

describe('colosseumSpawnLayoutWarnings', () => {
  it('flags only chosen points the game leaves out from the start tile, with the distance', () => {
    // From the default start (23,38), (25,34) and (19,37) are within 4; (19,32) is 6 away.
    const west = layout(4, { 9: 'serpentShaman', 11: 'manticore' });
    expect(colosseumSpawnLayoutWarnings(west, COLOSSEUM_WAVE_START_TILE)).toEqual([
      { kind: 'spawn-too-close', point: 11, position: [19, 37], species: 'manticore', distance: 4 },
    ]);
    // Five away is clear.
    expect(colosseumSpawnLayoutWarnings(west, [24, 38])).toEqual([]);
    expect(colosseumSpawnLayoutWarnings(layout(4, { 0: 'manticore' }), COLOSSEUM_WAVE_START_TILE)).toEqual([]);
  });

  it("adds a start tile under the NPC's footprint, sized by species", () => {
    // The manticore on (25,34) covers x 25-27, y 34-36.
    const manticore = layout(4, { 10: 'manticore' });
    expect(colosseumSpawnLayoutWarnings(manticore, [27, 36])).toEqual([
      { kind: 'spawn-too-close', point: 10, position: [25, 34], species: 'manticore', distance: 2 },
      { kind: 'start-in-footprint', point: 10, position: [25, 34], species: 'manticore' },
    ]);
    expect(colosseumSpawnLayoutWarnings(manticore, [28, 36]).map(({ kind }) => kind)).toEqual(['spawn-too-close']);
    // The 1x1 shaman covers its own tile only.
    const shaman = layout(4, { 10: 'serpentShaman' });
    expect(colosseumSpawnLayoutWarnings(shaman, [25, 34]).map(({ kind }) => kind)).toEqual([
      'spawn-too-close',
      'start-in-footprint',
    ]);
    expect(colosseumSpawnLayoutWarnings(shaman, [26, 34]).map(({ kind }) => kind)).toEqual(['spawn-too-close']);
  });
});
