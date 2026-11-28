import type { LocWithType } from '../../cache/CacheManager';
import { isEquipInventoryAction } from '../../data/equipInventoryActions';
import { resolveEquipmentItemName, resolveInventoryActions } from '../../data/equipmentCatalog';
import type { ItemActionOption } from '../../data/itemEffects';
import type { PickedNpc, Ray3D } from '../../render/scene/npcPick';
import type { LocType } from '../../rs/config/loctype/LocType';
import type { NpcType } from '../../rs/config/npctype/NpcType';
import type { NpcTypeLoader } from '../../rs/config/npctype/NpcTypeLoader';
import type { ObjTypeLoader } from '../../rs/config/objtype/ObjTypeLoader';
import { type CustomMenuSwap, findCustomMenuSwapIndex } from '../../types/customMenuSwaps';
import type { TileEdge, TileEdgeRef } from '../../types/lineMarkers';
import type { NpcHighlightMode } from '../../types/npcHighlight';
import type { Coordinate } from '../../types/simulation';
import { log } from '../../util/Logger';
import { isNpcClickAction } from '../npcInteraction';
import type { ContextMenuContent, ContextMenuEntry } from './contextMenuTypes';

const TARGET_COLORS = {
  npc: '#f8e868', // vivid gold (OSRS: #ffff00)
  loc: '#78e8e0', // vivid teal (OSRS: #00ffff)
  item: '#f8c070', // vivid amber (OSRS: #ff9040)
} as const;

const EDGE_LABELS: Record<TileEdge, string> = {
  north: 'North',
  east: 'East',
  south: 'South',
  west: 'West',
};

export type { PickedNpc, Ray3D };

const NPC_AABB_HEIGHT = 4;
const LOC_AABB_HEIGHT = 2;
const AABB_FLOOR_OFFSET = -0.5;

export function rayIntersectsAABB(
  ray: Ray3D,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  const { origin: o, direction: d } = ray;

  let tmin = -Infinity;
  let tmax = Infinity;

  if (d.x !== 0) {
    const t1 = (minX - o.x) / d.x;
    const t2 = (maxX - o.x) / d.x;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  } else if (o.x < minX || o.x > maxX) {
    return false;
  }

  if (d.y !== 0) {
    const t1 = (minY - o.y) / d.y;
    const t2 = (maxY - o.y) / d.y;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  } else if (o.y < minY || o.y > maxY) {
    return false;
  }

  if (d.z !== 0) {
    const t1 = (minZ - o.z) / d.z;
    const t2 = (maxZ - o.z) / d.z;
    tmin = Math.max(tmin, Math.min(t1, t2));
    tmax = Math.min(tmax, Math.max(t1, t2));
  } else if (o.z < minZ || o.z > maxZ) {
    return false;
  }

  return tmax >= Math.max(tmin, 0);
}

export function rayHitsNpc(ray: Ray3D, npcPos: Coordinate, npcSize: number): boolean {
  const [nx, ny] = npcPos;
  return rayIntersectsAABB(ray, nx, ny, AABB_FLOOR_OFFSET, nx + npcSize, ny + npcSize, NPC_AABB_HEIGHT);
}

export function rayFindInteractiveLoc(ray: Ray3D, locs: LocWithType[]): LocType | null {
  const result = rayFindInteractiveLocWithCoord(ray, locs);
  return result ? result.locType : null;
}

export function rayFindInteractiveLocWithCoord(
  ray: Ray3D,
  locs: LocWithType[],
): { locType: LocType; coord: Coordinate } | null {
  for (const { location, locType } of locs) {
    if (location.level !== 0) continue;
    if (!locType.isInteractive) continue;
    if (locType.name === 'null') continue;
    if (!locType.actions.some((a): a is string => a !== undefined && a !== null)) continue;

    const locX = location.localX;
    const locY = location.localY;
    const rotation = location.rotation;
    const effectiveSizeX = rotation === 1 || rotation === 3 ? locType.sizeY : locType.sizeX;
    const effectiveSizeY = rotation === 1 || rotation === 3 ? locType.sizeX : locType.sizeY;

    if (
      rayIntersectsAABB(
        ray,
        locX,
        locY,
        AABB_FLOOR_OFFSET,
        locX + effectiveSizeX,
        locY + effectiveSizeY,
        LOC_AABB_HEIGHT,
      )
    ) {
      return { locType, coord: [locX, locY] };
    }
  }
  return null;
}

export interface ViewportEntityContext {
  npcPosition?: Coordinate;
  npcSize?: number;
  npcTypeLoader?: NpcTypeLoader | null;
  npcId?: number;
  npcActorId?: string;
  locs?: LocWithType[];
  /** Every NPC under the cursor, nearest first — one right-click menu block each. */
  pickNpcs?: (ray: Ray3D, screenPx: { x: number; y: number }) => PickedNpc[];
  /** Actor the player is currently attacking — its menu entries get a `*` before the name. */
  attackTargetActorId?: string | null;
  /** Every ground-item pile under the cursor, nearest first. Model-picked, not tile-picked. */
  pickGroundItems?: (screenPx: { x: number; y: number }) => GroundItemMenuItem[];
  objTypeLoader?: ObjTypeLoader | null;
  /**
   * The NPC's menu-entry and hover-text color, when a plugin paints it: NPC Highlights by type, TzHaar
   * HP Tracker by the actor's alive or dead state. `actorId` is the simulation id.
   */
  npcMenuColor?: (npcTypeId: number, actorId?: string) => string | undefined;
}

export interface TileMarkerMenuCallbacks {
  onMark: (tile: Coordinate) => void;
  onUnmark: (tile: Coordinate) => void;
  onLabel: (tile: Coordinate) => void;
  onColor: (tile: Coordinate) => void;
}

export interface TileMarkerContext {
  shiftKey: boolean;
  hasMarker: (tile: Coordinate) => boolean;
  callbacks: TileMarkerMenuCallbacks;
}

export interface LineMarkerMenuCallbacks {
  onMark: (ref: TileEdgeRef) => void;
  onUnmark: (ref: TileEdgeRef) => void;
  onLabel: (ref: TileEdgeRef) => void;
  onColor: (ref: TileEdgeRef) => void;
}

export interface LineMarkerContext {
  shiftKey: boolean;
  /** The edge nearest the cursor at menu-open time, or null if none. */
  edge: TileEdgeRef | null;
  hasEdge: (ref: TileEdgeRef) => boolean;
  callbacks: LineMarkerMenuCallbacks;
}

export interface NpcHighlightMenuContext {
  shiftKey: boolean;
  isHighlighted: (npcTypeId: number, mode: NpcHighlightMode) => boolean;
  getHighlightColor: (npcTypeId: number, mode: NpcHighlightMode) => string | undefined;
  onToggleHighlight: (npcName: string, npcTypeId: number, mode: NpcHighlightMode) => void;
  onOpenColorPicker?: (npcName: string, npcTypeId: number, mode: NpcHighlightMode, currentColor: string) => void;
}

export interface InventoryTagMenuContext {
  shiftKey: boolean;
  getTag: (itemId: number) => string | undefined;
  onRemoveTag: (itemId: number) => void;
  onPickColor: (itemId: number, initialColor?: string) => void;
}

export function buildInventoryTagSubmenu(
  itemId: number,
  itemName: string,
  tagContext: InventoryTagMenuContext,
): ContextMenuEntry | null {
  if (!tagContext.shiftKey) return null;

  const currentTag = tagContext.getTag(itemId);
  const submenu: ContextMenuEntry[] = [
    {
      action: 'Pick color',
      onClick: () => tagContext.onPickColor(itemId, currentTag),
    },
  ];

  if (currentTag) {
    submenu.push(
      {
        action: 'swatch',
        targetColor: currentTag,
        onClick: () => tagContext.onPickColor(itemId, currentTag),
      },
      {
        action: 'Reset inventory tag',
        onClick: () => tagContext.onRemoveTag(itemId),
      },
    );
  }

  return {
    action: 'Inventory tag',
    target: itemName,
    targetColor: TARGET_COLORS.item,
    submenu,
  };
}

/** One pile under the cursor. Mirrors `GroundItem` minus the fields a menu never reads. */
export interface GroundItemMenuItem {
  readonly groundItemId: string;
  readonly itemId: number;
}

export interface GroundItemMenuContext {
  /** Piles under the cursor, most recently dropped first — the order OSRS lists them in. */
  readonly items: readonly GroundItemMenuItem[];
  readonly objTypeLoader?: ObjTypeLoader | null;
  readonly onTake: (groundItemId: string) => void;
}

/**
 * `Take` is guaranteed: an item lying on the floor always offers it, and the cache
 * leaves the slot empty for plenty of ids the player can still pick up.
 */
export function buildGroundItemEntries(ctx: GroundItemMenuContext): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [];

  for (const item of ctx.items) {
    let name = 'Item';
    let actions: string[] = [];

    if (ctx.objTypeLoader) {
      try {
        const objType = ctx.objTypeLoader.load(item.itemId);
        name = resolveEquipmentItemName(item.itemId, objType.name);
        actions = objType.groundActions.filter((action): action is string => action !== undefined && action !== null);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        log.debug('UI', `Failed to load ground item type ${item.itemId}`, error);
      }
    }

    if (!actions.some((action) => action.toLowerCase() === 'take')) {
      actions = ['Take', ...actions];
    }

    for (const action of actions) {
      const isTake = action.toLowerCase() === 'take';
      entries.push({
        action,
        target: name,
        targetColor: TARGET_COLORS.item,
        onClick: isTake ? () => ctx.onTake(item.groundItemId) : undefined,
        clickType: isTake ? ('red' as const) : undefined,
      });
    }

    entries.push({ action: 'Examine', target: name, targetColor: TARGET_COLORS.item });
  }

  return entries;
}

/**
 * The marker contexts are read only by the menu: `resolveViewportLeftClickSwap` is the plain
 * left click, and both of its call sites return before shift, which is what gates a marker entry.
 */
export interface ViewportMenuInputs {
  tile: Coordinate | null;
  onTileClick?: (coord: Coordinate) => void;
  entityContext?: ViewportEntityContext;
  ray?: Ray3D | null;
  screenPx?: { x: number; y: number };
  onNpcAction?: (coord: Coordinate) => void;
  onNpcActionByTarget?: (actorId: string, position: Coordinate) => void;
  groundItemContext?: GroundItemMenuContext;
  customMenuSwaps?: readonly CustomMenuSwap[];
  tileMarkerContext?: TileMarkerContext;
  lineMarkerContext?: LineMarkerContext;
  npcHighlightContext?: NpcHighlightMenuContext;
}

interface ViewportMenuParts {
  actions: ContextMenuEntry[];
  /** Absent off-map. Kept apart from `actions` because it sits below the marker entries. */
  walkHere: ContextMenuEntry | null;
  examines: ContextMenuEntry[];
  /** Index into `[...actions, walkHere]`, or -1 when no swap rule promotes an entry. */
  swapIndex: number;
}

export type ViewportRightClickResolution =
  | { readonly kind: 'menu'; readonly content: ContextMenuContent }
  | { readonly kind: 'camera-drag' }
  | { readonly kind: 'none' };

function buildViewportMenuParts(inputs: ViewportMenuInputs): ViewportMenuParts {
  const {
    tile,
    onTileClick,
    entityContext,
    ray,
    screenPx,
    onNpcAction,
    onNpcActionByTarget,
    groundItemContext,
    npcHighlightContext,
  } = inputs;
  const actions: ContextMenuEntry[] = [];
  const examines: ContextMenuEntry[] = [];

  if (entityContext) {
    splitEntries(
      buildNpcEntriesForRay(
        ray ?? null,
        tile,
        entityContext,
        screenPx,
        onTileClick,
        onNpcAction,
        npcHighlightContext,
        onNpcActionByTarget,
      ),
      actions,
      examines,
    );
    splitEntries(buildLocEntriesForRay(ray ?? null, tile, entityContext, onTileClick), actions, examines);
  }

  if (groundItemContext && groundItemContext.items.length > 0) {
    splitEntries(buildGroundItemEntries(groundItemContext), actions, examines);
  }

  const walkHere: ContextMenuEntry | null = tile
    ? { action: 'Walk here', onClick: () => onTileClick?.(tile), clickType: 'yellow' }
    : null;

  const swaps = inputs.customMenuSwaps;
  const swapIndex =
    swaps && swaps.length > 0 ? findCustomMenuSwapIndex(walkHere ? [...actions, walkHere] : actions, swaps) : -1;

  return { actions, walkHere, examines, swapIndex };
}

/**
 * The entry a Custom Menu Swaps rule promotes to the left click, or null when no rule
 * matches. A rule naming what already leads the menu resolves here too, so the click
 * follows the menu rather than falling back to a priority order that differs from it.
 */
export function resolveViewportLeftClickSwap(
  inputs: ViewportMenuInputs,
): { kind: 'walk' | 'action'; entry: ContextMenuEntry } | null {
  const { actions, walkHere, swapIndex } = buildViewportMenuParts(inputs);
  if (swapIndex < 0) return null;
  const entry = (walkHere ? [...actions, walkHere] : actions)[swapIndex];
  if (!entry) return null;
  return { kind: entry === walkHere ? 'walk' : 'action', entry };
}

function assembleViewportContextMenu(
  inputs: ViewportMenuInputs,
  parts: ViewportMenuParts,
): { readonly content: ContextMenuContent | null; readonly hasActionEntries: boolean } {
  const { tile, tileMarkerContext, lineMarkerContext } = inputs;
  const { actions, walkHere, examines, swapIndex } = parts;

  const markerEntries: ContextMenuEntry[] = [];
  if (tile && tileMarkerContext?.shiftKey) {
    const isMarked = tileMarkerContext.hasMarker(tile);
    if (isMarked) {
      markerEntries.push(
        {
          action: 'Unmark',
          target: 'tile',
          targetColor: TARGET_COLORS.loc,
          onClick: () => tileMarkerContext.callbacks.onUnmark(tile),
        },
        {
          action: 'Label',
          target: 'tile',
          targetColor: TARGET_COLORS.loc,
          onClick: () => tileMarkerContext.callbacks.onLabel(tile),
        },
        {
          action: 'Color',
          target: 'tile',
          targetColor: TARGET_COLORS.loc,
          onClick: () => tileMarkerContext.callbacks.onColor(tile),
        },
      );
    } else {
      markerEntries.push({
        action: 'Mark',
        target: 'tile',
        targetColor: TARGET_COLORS.loc,
        onClick: () => tileMarkerContext.callbacks.onMark(tile),
      });
    }
  }

  const lineEntries: ContextMenuEntry[] = [];
  if (lineMarkerContext?.shiftKey && lineMarkerContext.edge) {
    const edge = lineMarkerContext.edge;
    const isMarked = lineMarkerContext.hasEdge(edge);
    const edgeLabel = EDGE_LABELS[edge.edge];
    if (isMarked) {
      lineEntries.push(
        {
          action: 'Unmark',
          target: `${edgeLabel} line`,
          targetColor: TARGET_COLORS.loc,
          onClick: () => lineMarkerContext.callbacks.onUnmark(edge),
        },
        {
          action: 'Label',
          target: `${edgeLabel} line`,
          targetColor: TARGET_COLORS.loc,
          onClick: () => lineMarkerContext.callbacks.onLabel(edge),
        },
        {
          action: 'Color',
          target: `${edgeLabel} line`,
          targetColor: TARGET_COLORS.loc,
          onClick: () => lineMarkerContext.callbacks.onColor(edge),
        },
      );
    } else {
      lineEntries.push({
        action: 'Mark',
        target: `${edgeLabel} line`,
        targetColor: TARGET_COLORS.loc,
        onClick: () => lineMarkerContext.callbacks.onMark(edge),
      });
    }
  }

  if (!tile && actions.length === 0 && examines.length === 0 && markerEntries.length === 0 && lineEntries.length === 0)
    return { content: null, hasActionEntries: false };

  const entries: ContextMenuEntry[] = [
    ...actions,
    ...markerEntries,
    ...lineEntries,
    ...(walkHere ? [walkHere] : []),
    ...examines,
    { action: 'Cancel' },
  ];

  // Exchange inside the assembled menu, not inside the clickable block on its own: the
  // marker entries sit between the actions and Walk here, so swapping a shorter list and
  // re-appending them afterwards moved markers below an entry they had been above.
  if (swapIndex > 0) {
    const clickable = walkHere ? [...actions, walkHere] : actions;
    const winnerEntry = clickable[swapIndex];
    const topEntry = clickable[0];
    if (winnerEntry && topEntry) {
      const winner = entries.indexOf(winnerEntry);
      const top = entries.indexOf(topEntry);
      if (winner >= 0 && top >= 0) {
        entries[top] = winnerEntry;
        entries[winner] = topEntry;
      }
    }
  }

  return {
    content: { entries },
    hasActionEntries: actions.length > 0 || markerEntries.length > 0 || lineEntries.length > 0,
  };
}

export function buildViewportContextMenu(inputs: ViewportMenuInputs): ContextMenuContent | null {
  return assembleViewportContextMenu(inputs, buildViewportMenuParts(inputs)).content;
}

export function resolveViewportRightClick(
  inputs: ViewportMenuInputs,
  rightClickMovesCamera: boolean,
): ViewportRightClickResolution {
  const { content, hasActionEntries } = assembleViewportContextMenu(inputs, buildViewportMenuParts(inputs));
  if (!rightClickMovesCamera) {
    return content ? { kind: 'menu', content } : { kind: 'none' };
  }
  return content && hasActionEntries ? { kind: 'menu', content } : { kind: 'camera-drag' };
}

function splitEntries(entries: ContextMenuEntry[], actions: ContextMenuEntry[], examines: ContextMenuEntry[]): void {
  for (const entry of entries) {
    if (entry.action === 'Examine') {
      examines.push(entry);
    } else {
      actions.push(entry);
    }
  }
}

export function isTileOnNpc(tile: Coordinate, npcPos: Coordinate, npcSize: number): boolean {
  const [tx, ty] = tile;
  const [nx, ny] = npcPos;
  return tx >= nx && tx < nx + npcSize && ty >= ny && ty < ny + npcSize;
}

export function findInteractiveLocAtTile(tile: Coordinate, locs: LocWithType[]): LocType | null {
  const [tx, ty] = tile;
  for (const { location, locType } of locs) {
    if (location.level !== 0) continue;
    if (!locType.isInteractive) continue;
    if (locType.name === 'null') continue;
    if (!locType.actions.some((a): a is string => a !== undefined && a !== null)) continue;

    const locX = location.localX;
    const locY = location.localY;
    const rotation = location.rotation;
    const effectiveSizeX = rotation === 1 || rotation === 3 ? locType.sizeY : locType.sizeX;
    const effectiveSizeY = rotation === 1 || rotation === 3 ? locType.sizeX : locType.sizeY;

    if (tx >= locX && tx < locX + effectiveSizeX && ty >= locY && ty < locY + effectiveSizeY) {
      return locType;
    }
  }
  return null;
}

function buildNpcEntriesForRay(
  ray: Ray3D | null,
  tile: Coordinate | null,
  ctx: ViewportEntityContext,
  screenPx?: { x: number; y: number },
  onTileClick?: (coord: Coordinate) => void,
  onNpcAction?: (coord: Coordinate) => void,
  npcHighlightContext?: NpcHighlightMenuContext,
  onNpcActionByTarget?: (actorId: string, position: Coordinate) => void,
): ContextMenuEntry[] {
  const pickNpcs = ctx.pickNpcs;
  const npcTypeLoader = ctx.npcTypeLoader;
  if (ray && screenPx && pickNpcs && npcTypeLoader) {
    const entries: ContextMenuEntry[] = [];

    for (const picked of pickNpcs(ray, screenPx)) {
      let npcType: NpcType;
      try {
        npcType = npcTypeLoader.load(picked.npcTypeId);
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        log.debug('UI', `Failed to load picked NPC type ${picked.npcTypeId}`, error);
        continue;
      }

      const clickHandler = onNpcActionByTarget
        ? (_coord: Coordinate) => onNpcActionByTarget(picked.actorId, picked.position)
        : onNpcAction;
      const isAttackTarget = ctx.attackTargetActorId === picked.actorId;
      const targetColor = ctx.npcMenuColor?.(picked.npcTypeId, picked.actorId) ?? TARGET_COLORS.npc;
      entries.push(
        ...buildNpcContextEntries(npcType, targetColor, picked.position, onTileClick, clickHandler, isAttackTarget),
      );
      const highlightEntry = buildNpcHighlightEntry(npcType, picked.npcTypeId, targetColor, npcHighlightContext);
      if (highlightEntry) entries.push(highlightEntry);
    }

    // Ray path is authoritative: a miss is a miss (matches OSRS + left-click);
    // never fall through to the coarse footprint-tile test below.
    return entries;
  }

  // No ray (2D / canvas2d mode): coarse primary-NPC footprint-tile test.
  if (tile && ctx.npcPosition && ctx.npcSize && ctx.npcTypeLoader && ctx.npcId !== undefined) {
    if (isTileOnNpc(tile, ctx.npcPosition, ctx.npcSize)) {
      try {
        const npcType = ctx.npcTypeLoader.load(ctx.npcId);
        const isAttackTarget = ctx.npcActorId !== undefined && ctx.attackTargetActorId === ctx.npcActorId;
        const targetColor = ctx.npcMenuColor?.(ctx.npcId, ctx.npcActorId) ?? TARGET_COLORS.npc;
        const entries = buildNpcContextEntries(
          npcType,
          targetColor,
          ctx.npcPosition,
          onTileClick,
          onNpcAction,
          isAttackTarget,
        );
        const highlightEntry = buildNpcHighlightEntry(npcType, ctx.npcId, targetColor, npcHighlightContext);
        if (highlightEntry) entries.push(highlightEntry);
        return entries;
      } catch (error) {
        if (!(error instanceof Error)) {
          throw error;
        }
        log.debug('UI', `Failed to load NPC type ${ctx.npcId}`, error);
      }
    }
  }

  return [];
}

function npcMenuName(name: string, defaultColor: string): { name: string; color: string } {
  const tagged = /^<col=([0-9a-f]{6})>([^<>]+)<\/col>$/i.exec(name);
  if (tagged?.[1] && tagged[2] !== undefined) return { name: tagged[2], color: `#${tagged[1]}` };
  return { name, color: defaultColor };
}

function buildNpcContextEntries(
  npcType: NpcType,
  targetColor: string,
  npcPosition?: Coordinate,
  onTileClick?: (coord: Coordinate) => void,
  onNpcAction?: (coord: Coordinate) => void,
  /** Marks the NPC the player is already attacking, so stacked NPCs stay distinguishable. */
  isAttackTarget = false,
): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [];
  const { name, color } = npcMenuName(npcType.name || 'NPC', targetColor);
  const levelSuffix = npcType.combatLevel > 0 ? `  (level-${npcType.combatLevel})` : '';
  const target = `${isAttackTarget ? '*' : ''}${name}${levelSuffix}`;

  for (const action of npcType.actions) {
    if (action === undefined || action === null) continue;
    const clickHandler = isNpcClickAction(action) ? (onNpcAction ?? onTileClick) : undefined;
    entries.push({
      action,
      target,
      targetColor: color,
      onClick: npcPosition && clickHandler ? () => clickHandler(npcPosition) : undefined,
      clickType: npcPosition && clickHandler ? ('red' as const) : undefined,
    });
  }

  entries.push({
    action: 'Examine',
    target,
    targetColor: color,
  });

  return entries;
}

function buildNpcHighlightEntry(
  npcType: NpcType,
  npcTypeId: number,
  targetColor: string,
  npcHighlightContext?: NpcHighlightMenuContext,
): ContextMenuEntry | null {
  if (!npcHighlightContext?.shiftKey) return null;

  const { name, color } = npcMenuName(npcType.name || 'NPC', targetColor);
  const levelSuffix = npcType.combatLevel > 0 ? `  (level-${npcType.combatLevel})` : '';
  const target = name + levelSuffix;

  const modes: Array<{ mode: NpcHighlightMode; label: string }> = [
    { mode: 'trueTile', label: 'True Tile' },
    { mode: 'swTile', label: 'SW Tile' },
    { mode: 'clickbox', label: 'Clickbox' },
  ];

  return {
    action: 'Tag',
    target,
    targetColor: color,
    submenu: modes.flatMap(({ mode, label }) => {
      const highlighted = npcHighlightContext.isHighlighted(npcTypeId, mode);
      const currentColor = npcHighlightContext.getHighlightColor(npcTypeId, mode);

      const entries: ContextMenuEntry[] = [
        {
          action: highlighted ? 'Untag' : 'Tag',
          target: label,
          targetColor: TARGET_COLORS.npc,
          onClick: () => npcHighlightContext.onToggleHighlight(name, npcTypeId, mode),
        },
      ];

      const openColorPicker = npcHighlightContext.onOpenColorPicker;
      if (highlighted && currentColor && openColorPicker) {
        entries.push({
          action: 'swatch',
          targetColor: currentColor,
          onClick: () => openColorPicker(name, npcTypeId, mode, currentColor),
        });
      }

      return entries;
    }),
  };
}

function buildLocEntriesForRay(
  ray: Ray3D | null,
  tile: Coordinate | null,
  ctx: ViewportEntityContext,
  onTileClick?: (coord: Coordinate) => void,
): ContextMenuEntry[] {
  if (!ctx.locs || ctx.locs.length === 0) return [];

  const entries: ContextMenuEntry[] = [];

  for (const locWithType of ctx.locs) {
    const { location, locType } = locWithType;
    if (location.level !== 0) continue;
    if (!locType.isInteractive) continue;

    const locX = location.localX;
    const locY = location.localY;
    const rotation = location.rotation;
    const effectiveSizeX = rotation === 1 || rotation === 3 ? locType.sizeY : locType.sizeX;
    const effectiveSizeY = rotation === 1 || rotation === 3 ? locType.sizeX : locType.sizeY;

    let hit: boolean;
    if (ray) {
      hit = rayIntersectsAABB(
        ray,
        locX,
        locY,
        AABB_FLOOR_OFFSET,
        locX + effectiveSizeX,
        locY + effectiveSizeY,
        LOC_AABB_HEIGHT,
      );
    } else if (tile) {
      const [tx, ty] = tile;
      hit = tx >= locX && tx < locX + effectiveSizeX && ty >= locY && ty < locY + effectiveSizeY;
    } else {
      hit = false;
    }

    if (hit) {
      const locCoord: Coordinate = [locX, locY];
      entries.push(...buildLocContextEntries(locType, locCoord, onTileClick));
    }
  }

  return entries;
}

function buildLocContextEntries(
  locType: LocType,
  locCoord?: Coordinate,
  onTileClick?: (coord: Coordinate) => void,
): ContextMenuEntry[] {
  const entries: ContextMenuEntry[] = [];
  const name = locType.name || 'Object';

  if (name === 'null') return entries;

  for (const action of locType.actions) {
    if (action === undefined || action === null) continue;
    entries.push({
      action,
      target: name,
      targetColor: TARGET_COLORS.loc,
      onClick: locCoord && onTileClick ? () => onTileClick(locCoord) : undefined,
      clickType: locCoord && onTileClick ? ('red' as const) : undefined,
    });
  }

  entries.push({
    action: 'Examine',
    target: name,
    targetColor: TARGET_COLORS.loc,
  });

  return entries;
}

export interface InventoryMenuCallbacks {
  onUseItem?: (index: number, option?: ItemActionOption) => void;
  onEquipFromInventory?: (index: number) => void;
  onDropItem?: (index: number) => void;
}

export function buildInventoryContextMenu(
  itemId: number,
  index: number,
  objTypeLoader: ObjTypeLoader | undefined,
  callbacks: InventoryMenuCallbacks,
  tagContext?: InventoryTagMenuContext,
): ContextMenuContent | null {
  if (!objTypeLoader) return null;

  try {
    const objType = objTypeLoader.load(itemId);
    const name = resolveEquipmentItemName(itemId, objType.name);
    const entries: ContextMenuEntry[] = [];

    for (const action of resolveInventoryActions(itemId, objType.inventoryActions)) {
      if (action === undefined || action === null) continue;

      let onClick: (() => void) | undefined;

      if (action === 'Eat' || action === 'Drink' || action === 'Invigorate' || action === 'Use') {
        onClick = () => callbacks.onUseItem?.(index);
      } else if (action === 'Guzzle') {
        onClick = () => callbacks.onUseItem?.(index, 'guzzle');
      } else if (isEquipInventoryAction(action)) {
        onClick = () => callbacks.onEquipFromInventory?.(index);
      } else if (action === 'Drop') {
        onClick = () => callbacks.onDropItem?.(index);
      }

      entries.push({ action, target: name, onClick });
    }

    if (!entries.some((e) => e.action === 'Use')) {
      entries.push({ action: 'Use', target: name });
    }

    // Drop is a client-side op in OSRS, not cache data — no item carries it in
    // `inventoryActions`.
    if (!entries.some((e) => e.action === 'Drop')) {
      entries.push({ action: 'Drop', target: name, onClick: () => callbacks.onDropItem?.(index) });
    }

    const tagEntry = tagContext ? buildInventoryTagSubmenu(itemId, name, tagContext) : null;
    if (tagEntry) entries.push(tagEntry);

    entries.push({ action: 'Cancel' });
    return { entries };
  } catch {
    return null;
  }
}

export interface EquipmentMenuCallbacks {
  onUnequipSlot?: (slot: string) => void;
}

export function buildEquipmentContextMenu(
  itemId: number,
  slot: string,
  objTypeLoader: ObjTypeLoader | undefined,
  callbacks: EquipmentMenuCallbacks,
): ContextMenuContent | null {
  if (!objTypeLoader) return null;

  try {
    const objType = objTypeLoader.load(itemId);
    const name = resolveEquipmentItemName(itemId, objType.name);

    const entries: ContextMenuEntry[] = [
      {
        action: 'Remove',
        target: name,
        onClick: () => callbacks.onUnequipSlot?.(slot),
      },
      { action: 'Examine', target: name },
      { action: 'Cancel' },
    ];

    return { entries };
  } catch {
    return null;
  }
}

export interface PrayerMenuCallbacks {
  onToggle?: () => void;
}

export function buildPrayerContextMenu(
  label: string,
  isActive: boolean,
  callbacks: PrayerMenuCallbacks,
): ContextMenuContent {
  const action = isActive ? 'Deactivate' : 'Activate';
  return {
    entries: [{ action, target: label, onClick: callbacks.onToggle }, { action: 'Cancel' }],
  };
}

export function buildSpellContextMenu(label: string): ContextMenuContent {
  return {
    entries: [{ action: 'Cast', target: label }, { action: 'Cancel' }],
  };
}

export function buildRunOrbContextMenu(isEnabled: boolean, onToggle: () => void): ContextMenuContent {
  return {
    entries: [
      {
        action: 'Toggle Run',
        target: isEnabled ? '(on)' : '(off)',
        onClick: onToggle,
      },
      { action: 'Cancel' },
    ],
  };
}

export function buildSpecialOrbContextMenu(isActive: boolean, onToggle: () => void): ContextMenuContent {
  return {
    entries: [
      {
        action: isActive ? 'Turn Off' : 'Use',
        target: 'Special Attack',
        onClick: onToggle,
      },
      { action: 'Cancel' },
    ],
  };
}

export function buildPrayerOrbContextMenu(
  isActive: boolean,
  callbacks: { onToggle: () => void; onSetup: () => void },
): ContextMenuContent {
  return {
    entries: [
      {
        action: isActive ? 'Deactivate' : 'Activate',
        target: 'Quick-prayers',
        onClick: callbacks.onToggle,
      },
      {
        action: 'Setup',
        target: 'Quick-prayers',
        onClick: callbacks.onSetup,
      },
      { action: 'Cancel' },
    ],
  };
}

export function buildPrayerReorderContextMenu(
  label: string,
  isActive: boolean,
  isHidden: boolean,
  callbacks: PrayerMenuCallbacks & { onToggleHidden?: () => void },
): ContextMenuContent {
  const entries: ContextMenuEntry[] = [];
  const action = isActive ? 'Deactivate' : 'Activate';
  entries.push({ action, target: label, onClick: callbacks.onToggle });
  entries.push({
    action: isHidden ? 'Unhide' : 'Hide',
    target: label,
    onClick: callbacks.onToggleHidden,
  });
  entries.push({ action: 'Cancel' });
  return { entries };
}

export function buildSpellReorderContextMenu(
  label: string,
  isHidden: boolean,
  callbacks: { onToggleHidden?: () => void; onCast?: () => void },
): ContextMenuContent {
  const entries: ContextMenuEntry[] = [];
  if (callbacks.onCast) {
    entries.push({ action: 'Cast', target: label, onClick: callbacks.onCast });
  }
  entries.push({
    action: isHidden ? 'Unhide' : 'Hide',
    target: label,
    onClick: callbacks.onToggleHidden,
  });
  entries.push({ action: 'Cancel' });
  return { entries };
}

export function buildTabReorderToggleMenu(
  tabLabel: string,
  isReordering: boolean,
  onToggle: () => void,
): ContextMenuContent {
  return {
    entries: [
      {
        action: isReordering ? 'Disable' : 'Enable',
        target: `${tabLabel} reordering`,
        onClick: onToggle,
      },
      { action: 'Cancel' },
    ],
  };
}
