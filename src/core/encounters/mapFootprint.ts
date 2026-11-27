import {
  getMapSquareBlock,
  getMapSquareBlockTileBounds,
  type MapSquareBlockEntry,
  type MapSquareOffset,
  type MapSquareOffsets,
} from '../../rs/map/mapSquareBlock';

/**
 * One map square an encounter declares, relative to its origin square (`EncounterDescriptor.mapSquare`).
 * The origin is the arena's south-west square: every arena square has `dx >= 0` and `dy >= 0`, and
 * some arena square has `dx === 0` and some `dy === 0`. Scenery-only squares may lie anywhere, the
 * origin itself included (an L-shaped arena declares its empty corner scenery only).
 */
export interface EncounterMapSquareOffset extends MapSquareOffset {
  /**
   * Loaded, drawn and baked like any other declared square, but not part of the arena: the minimap,
   * the Debug view, picking and tile-marker interchange leave it out. Omitted: an arena square.
   */
  readonly sceneryOnly?: boolean;
}

export type EncounterMapSquareOffsets = readonly [EncounterMapSquareOffset, ...EncounterMapSquareOffset[]];

/** The descriptor fields the footprint is resolved from. */
export interface EncounterMapFootprintSource {
  readonly kind: string;
  readonly mapSquare: { readonly x: number; readonly y: number };
  readonly mapSquareOffsets?: EncounterMapSquareOffsets;
}

/**
 * An encounter's map squares, split by role. Simulation (0, 0) is the south-west tile of `origin`,
 * so each block entry's tile offset is where that square starts in simulation coordinates, and the
 * arena's tiles all lie in 0 <= x < width, 0 <= y < height of `arenaTileExtent`.
 *
 * - The scene (every declared square) is what terrain, locs, the cache trim and the collision bake
 *   read.
 * - The arena (squares not marked `sceneryOnly`) is what presentation and picking cover: the
 *   minimap, the 2D Debug view's extent, 3D picking and tile-space overlays, and RuneLite marker
 *   regions. Movement is still the baked walkable region's (`ArenaConfig`), never this.
 */
export interface EncounterMapFootprint {
  readonly origin: { readonly x: number; readonly y: number };
  readonly sceneOffsets: MapSquareOffsets;
  readonly arenaOffsets: MapSquareOffsets;
  readonly arenaBlock: readonly MapSquareBlockEntry[];
  /** The arena block's tile rectangle from tile (0, 0), for projection extents. Holes in it are not arena. */
  readonly arenaTileExtent: ArenaTileExtent;
}

/** Tiles along each axis of an arena rectangle that starts at simulation tile (0, 0). */
export interface ArenaTileExtent {
  readonly width: number;
  readonly height: number;
}

/** The rectangle from tile (0, 0) covering an arena block whose south-west square is the origin. */
export function getArenaTileExtent(arenaBlock: readonly MapSquareBlockEntry[]): ArenaTileExtent {
  const { maxX, maxY } = getMapSquareBlockTileBounds(arenaBlock);
  return { width: maxX + 1, height: maxY + 1 };
}

const ORIGIN_ONLY: EncounterMapSquareOffsets = [{ dx: 0, dy: 0 }];
const resolved = new WeakMap<EncounterMapFootprintSource, EncounterMapFootprint>();

const plainOffset = ({ dx, dy }: MapSquareOffset): MapSquareOffset => ({ dx, dy });

/** Resolved once per descriptor object, so every consumer shares the same blocks by identity. */
export function resolveEncounterMapFootprint(descriptor: EncounterMapFootprintSource): EncounterMapFootprint {
  const cached = resolved.get(descriptor);
  if (cached) return cached;
  const [first, ...rest] = descriptor.mapSquareOffsets ?? ORIGIN_ONLY;
  const sceneOffsets: MapSquareOffsets = [plainOffset(first), ...rest.map(plainOffset)];
  const [firstArena, ...otherArena] = [first, ...rest].filter((offset) => !offset.sceneryOnly).map(plainOffset);
  if (!firstArena) throw new Error(`Encounter '${descriptor.kind}' declares no arena map square`);
  const arenaOffsets: MapSquareOffsets = [firstArena, ...otherArena];
  // Any arena shape is expressible with its south-west square as the origin, so the arena never needs
  // negative coordinates and its consumers never carry a tile origin.
  const southWestDx = Math.min(...arenaOffsets.map(({ dx }) => dx));
  const southWestDy = Math.min(...arenaOffsets.map(({ dy }) => dy));
  if (southWestDx !== 0 || southWestDy !== 0) {
    throw new Error(
      `Encounter '${descriptor.kind}': its arena's south-west corner is map square offset ` +
        `(${southWestDx}, ${southWestDy}), not the origin; choose the arena's south-west map square as mapSquare`,
    );
  }
  const arenaBlock = getMapSquareBlock(arenaOffsets);
  const footprint: EncounterMapFootprint = {
    origin: descriptor.mapSquare,
    sceneOffsets,
    arenaOffsets,
    arenaBlock,
    arenaTileExtent: getArenaTileExtent(arenaBlock),
  };
  resolved.set(descriptor, footprint);
  return footprint;
}
