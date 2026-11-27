import { describe, expect, it } from 'vitest';
import { resolveEncounterMapFootprint } from '../mapFootprint';

describe('resolveEncounterMapFootprint', () => {
  it('treats omitted offsets as the origin square alone', () => {
    const footprint = resolveEncounterMapFootprint({ kind: 'one', mapSquare: { x: 23, y: 157 } });
    expect(footprint.sceneOffsets).toEqual([{ dx: 0, dy: 0 }]);
    expect(footprint.arenaBlock).toEqual([{ dx: 0, dy: 0, tileOffsetX: 0, tileOffsetY: 0 }]);
    expect(footprint.arenaTileExtent).toEqual({ width: 64, height: 64 });
  });

  it('makes every declared square an arena square unless it is scenery only', () => {
    const footprint = resolveEncounterMapFootprint({
      kind: 'two',
      mapSquare: { x: 35, y: 47 },
      mapSquareOffsets: [
        { dx: 0, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: -1, dy: 0, sceneryOnly: true },
      ],
    });
    expect(footprint.sceneBlock).toEqual([
      { dx: 0, dy: 0, tileOffsetX: 0, tileOffsetY: 0 },
      { dx: 0, dy: 1, tileOffsetX: 0, tileOffsetY: 64 },
      { dx: -1, dy: 0, tileOffsetX: -64, tileOffsetY: 0 },
    ]);
    // The scene offsets carry no role, so the terrain, loc and bake callers see plain squares.
    expect(footprint.sceneOffsets).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: -1, dy: 0 },
    ]);
    expect(footprint.arenaOffsets).toEqual([
      { dx: 0, dy: 0 },
      { dx: 0, dy: 1 },
    ]);
    expect(footprint.arenaTileExtent).toEqual({ width: 64, height: 128 });
  });

  it.each([
    [
      'south',
      [
        { dx: 0, dy: 0 },
        { dx: 0, dy: -1 },
      ],
      '(0, -1)',
    ],
    [
      'west',
      [
        { dx: 0, dy: 0 },
        { dx: -1, dy: 0 },
      ],
      '(-1, 0)',
    ],
    // The origin is scenery only and the arena starts a square east of it.
    [
      'east of a scenery-only origin',
      [
        { dx: 0, dy: 0, sceneryOnly: true },
        { dx: 1, dy: 0 },
      ],
      '(1, 0)',
    ],
  ] as const)('rejects an arena whose south-west square is not the origin (%s)', (_label, offsets, corner) => {
    const descriptor = { kind: 'misplaced', mapSquare: { x: 35, y: 47 }, mapSquareOffsets: offsets };
    expect(() => resolveEncounterMapFootprint(descriptor)).toThrow(
      `Encounter 'misplaced': its arena's south-west corner is map square offset ${corner}, not the origin; ` +
        "choose the arena's south-west map square as mapSquare",
    );
  });

  it('accepts an L-shaped arena around a scenery-only origin, and scenery squares anywhere', () => {
    const footprint = resolveEncounterMapFootprint({
      kind: 'l-shape',
      mapSquare: { x: 35, y: 47 },
      mapSquareOffsets: [
        { dx: 0, dy: 0, sceneryOnly: true },
        { dx: 1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 1, dy: 1 },
        { dx: -1, dy: -1, sceneryOnly: true },
      ],
    });
    expect(footprint.arenaOffsets).toEqual([
      { dx: 1, dy: 0 },
      { dx: 0, dy: 1 },
      { dx: 1, dy: 1 },
    ]);
    expect(footprint.arenaTileExtent).toEqual({ width: 128, height: 128 });
    expect(footprint.sceneBlock).toHaveLength(5);
  });

  it('resolves once per descriptor, so consumers share the blocks by identity', () => {
    const descriptor = { kind: 'memo', mapSquare: { x: 1, y: 2 } };
    expect(resolveEncounterMapFootprint(descriptor)).toBe(resolveEncounterMapFootprint(descriptor));
  });

  it('rejects a footprint with no arena square', () => {
    expect(() =>
      resolveEncounterMapFootprint({
        kind: 'scenery',
        mapSquare: { x: 1, y: 2 },
        mapSquareOffsets: [{ dx: 0, dy: 0, sceneryOnly: true }],
      }),
    ).toThrow("Encounter 'scenery' declares no arena map square");
  });
});
