import type { ArenaBounds, CollisionMap } from '../rs/collision/WalkabilityAnalyzer';
import type { ArenaConfig } from './arena/ArenaConfig';
import { TileKeySetCache } from './tileKeySet';

export const GRID_SIZE = 64;
export const SIMULATION_START_TICK = 0;

let _arenaConfig: ArenaConfig = {
  bounds: null,
  walkableTiles: null,
  collisionMap: null,
};
let _allowUnboundedFallback = true;

/**
 * Zero-allocation mirror of `_arenaConfig.walkableTiles`. Rebuilt only when the
 * set is replaced or resized, so the pathfinder's per-node probes never build a
 * `${x},${y}` key.
 */
const _walkableLookup = new TileKeySetCache();

function buildArenaConfig(overrides: Partial<ArenaConfig>): ArenaConfig {
  return {
    bounds: overrides.bounds === undefined ? _arenaConfig.bounds : overrides.bounds,
    walkableTiles: overrides.walkableTiles === undefined ? _arenaConfig.walkableTiles : overrides.walkableTiles,
    collisionMap: overrides.collisionMap === undefined ? _arenaConfig.collisionMap : overrides.collisionMap,
  };
}

export function setArenaConfig(config: ArenaConfig, allowUnboundedFallback: boolean = false): void {
  _arenaConfig = {
    bounds: config.bounds,
    walkableTiles: config.walkableTiles,
    collisionMap: config.collisionMap,
  };
  if (!config.walkableTiles) {
    // Nothing left to mirror; drop the previous arena's packed copy rather than
    // holding it until some later arena installs a set.
    _walkableLookup.clear();
  }
  _allowUnboundedFallback = allowUnboundedFallback;
}

export function setArenaBounds(bounds: ArenaBounds): void {
  _arenaConfig = buildArenaConfig({ bounds });
}

export function getArenaBounds(): ArenaBounds | null {
  return _arenaConfig.bounds;
}

/**
 * The tiles the simulation and its picking may use: the core map square (0 to GRID_SIZE - 1 on each
 * axis), widened to cover the arena's bounds when the arena reaches past it. An arena built from
 * several map squares (`mapSquareOffsets`) can lie partly outside the core square: Zulrah's island
 * runs from map square 35_47 into 35_48, local y 64-70.
 */
export function getTileSpaceBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
  const bounds = _arenaConfig.bounds;
  return {
    minX: Math.min(0, bounds?.minX ?? 0),
    maxX: Math.max(GRID_SIZE - 1, bounds?.maxX ?? 0),
    minY: Math.min(0, bounds?.minY ?? 0),
    maxY: Math.max(GRID_SIZE - 1, bounds?.maxY ?? 0),
  };
}

export function isInTileSpace(x: number, y: number): boolean {
  const space = getTileSpaceBounds();
  return x >= space.minX && x <= space.maxX && y >= space.minY && y <= space.maxY;
}

export function setWalkableTiles(tiles: Set<string>): void {
  _arenaConfig = buildArenaConfig({ walkableTiles: tiles });
}

export function getWalkableTiles(): Set<string> | null {
  return _arenaConfig.walkableTiles;
}

export function isWalkableTile(x: number, y: number): boolean {
  const tiles = _arenaConfig.walkableTiles;
  if (!tiles) {
    return _allowUnboundedFallback;
  }
  return _walkableLookup.get(tiles).has(x, y);
}

export function isInArena(x: number, y: number): boolean {
  if (!_arenaConfig.bounds) {
    return _allowUnboundedFallback;
  }

  return (
    x >= _arenaConfig.bounds.minX &&
    x <= _arenaConfig.bounds.maxX &&
    y >= _arenaConfig.bounds.minY &&
    y <= _arenaConfig.bounds.maxY
  );
}

export function setCollisionMap(map: CollisionMap): void {
  _arenaConfig = buildArenaConfig({ collisionMap: map });
}

export function getCollisionMap(): CollisionMap | null {
  return _arenaConfig.collisionMap;
}

export function getArenaConfig(): ArenaConfig {
  return buildArenaConfig({});
}

export function getArenaAllowUnboundedFallback(): boolean {
  return _allowUnboundedFallback;
}

let _defaultArenaConfig: ArenaConfig | null = null;

export function setDefaultArenaConfig(config: ArenaConfig): void {
  _defaultArenaConfig = config;
}

export function getDefaultArenaConfig(): ArenaConfig {
  if (_defaultArenaConfig) return _defaultArenaConfig;
  return {
    bounds: null,
    walkableTiles: null,
    collisionMap: null,
  };
}

/**
 * Rolling window (in ticks) for per-actor position-history maps
 * (player.history / npc.history). Every tick's SimulationState references them
 * and the replay recorder deep-clones that state. Left unbounded they grow one
 * entry per tick forever, making each replay-frame clone O(N) and the whole
 * recording O(N^2) — the primary cause of the long-session out-of-memory crash.
 * 50 ticks (~30s) is far beyond any current reader; raise it only if a feature
 * genuinely needs a longer trail.
 */
export const ACTOR_HISTORY_WINDOW_TICKS = 50;

/**
 * Ticks a dead, non-boss transient actor (e.g. an exploded void flare) lingers
 * in worldState.actors after death before being pruned. The renderer captures
 * the death/fade animation into its own dyingInstances map the first frame it
 * sees alive=false, so a small grace window preserves the visual while
 * preventing dead actors — and the per-frame replay snapshots that deep-clone
 * state.npcs — from accumulating without bound over a long session.
 */
export const DEAD_ACTOR_PRUNE_GRACE_TICKS = 10;

const _resolvedArenaConfigs = new Map<string, ArenaConfig>();

export function setResolvedArenaConfig(kind: string, config: ArenaConfig): void {
  _resolvedArenaConfigs.set(kind, config);
}

export function getResolvedArenaConfig(kind: string): ArenaConfig | null {
  return _resolvedArenaConfigs.get(kind) ?? null;
}

export function clearResolvedArenaConfigs(): void {
  _resolvedArenaConfigs.clear();
}
