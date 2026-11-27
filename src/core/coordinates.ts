import type { Coordinate, TileString } from '../types/simulation';
import { GRID_SIZE, getArenaBounds, isInArena } from './constants';

export function strToCoord(tile: TileString): Coordinate {
  const parts = tile.split(',');
  if (parts.length === 2) {
    const x = parseInt(parts[0], 10);
    const y = parseInt(parts[1], 10);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [0, 0];
    return [x, y];
  }
  const col = tile.charCodeAt(0) - 'A'.charCodeAt(0) + 20;
  const row = parseInt(tile.slice(1), 10) + 19;
  if (!Number.isFinite(col) || !Number.isFinite(row)) return [0, 0];
  return [col, row];
}

export function coordToStr(coord: Coordinate): TileString {
  return `${coord[0]},${coord[1]}`;
}

export function chebyshevDistance(a: Coordinate, b: Coordinate): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
}

export function isValidCoordinate(coord: Coordinate): boolean {
  const [x, y] = coord;
  return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE;
}

/**
 * Whether the player may stand on `coord`. Movement belongs to the arena config: with bounds (the
 * baked walkable region's), those decide, so an arena reaching into a neighboring map square is
 * walkable there. Not every installed config has bounds (Yama's placeholder until the cache's
 * arena analysis succeeds, the module's initial state); those keep the origin map square.
 */
export function isValidArenaCoordinate(coord: Coordinate): boolean {
  const [x, y] = coord;
  return (getArenaBounds() !== null || isValidCoordinate(coord)) && isInArena(x, y);
}
