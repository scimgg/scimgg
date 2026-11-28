import { describe, expect, it, vi } from 'vitest';
import type { CacheInfo } from '../../../rs/cache/CacheInfo';
import { NpcType } from '../../../rs/config/npctype/NpcType';
import type { NpcTypeLoader } from '../../../rs/config/npctype/NpcTypeLoader';
import { ObjType } from '../../../rs/config/objtype/ObjType';
import type { ObjTypeLoader } from '../../../rs/config/objtype/ObjTypeLoader';
import { parseCustomMenuSwaps } from '../../../types/customMenuSwaps';
import type { TileEdgeRef } from '../../../types/lineMarkers';
import type { Coordinate } from '../../../types/simulation';
import {
  buildEquipmentContextMenu,
  buildGroundItemEntries,
  buildInventoryContextMenu,
  buildInventoryTagSubmenu,
  buildViewportContextMenu,
  type InventoryTagMenuContext,
  type LineMarkerContext,
  type PickedNpc,
  type Ray3D,
  resolveViewportLeftClickSwap,
  resolveViewportRightClick,
  type TileMarkerContext,
  type ViewportEntityContext,
} from '../contextMenuBuilders';

const TILE: Coordinate = [30, 32];

function actions(content: ReturnType<typeof buildViewportContextMenu>): string[] {
  return (content?.entries ?? []).map((entry) => entry.action);
}

function tileMarkerContext(overrides: Partial<TileMarkerContext> = {}): TileMarkerContext {
  return {
    shiftKey: true,
    hasMarker: () => false,
    callbacks: { onMark: vi.fn(), onUnmark: vi.fn(), onLabel: vi.fn(), onColor: vi.fn() },
    ...overrides,
  };
}

function lineMarkerContext(overrides: Partial<LineMarkerContext> = {}): LineMarkerContext {
  const edge: TileEdgeRef = { x: 30, y: 32, edge: 'south' };
  return {
    shiftKey: true,
    edge,
    hasEdge: () => false,
    callbacks: { onMark: vi.fn(), onUnmark: vi.fn(), onLabel: vi.fn(), onColor: vi.fn() },
    ...overrides,
  };
}

// Coverage for the plugin-enabled gate: when a marker plugin is off,
// the Grid bridge supplies no marker context, so the builder must not surface a
// "Mark" entry — matching how shiftKey gates it.
describe('buildViewportContextMenu — tile marker gating', () => {
  it('omits the Mark entry when no tile-marker context is supplied (plugin disabled)', () => {
    const content = buildViewportContextMenu({ tile: TILE });
    expect(actions(content)).not.toContain('Mark');
    expect(actions(content)).toContain('Walk here');
  });

  it('adds a Mark entry when the plugin is enabled and the tile is unmarked', () => {
    const content = buildViewportContextMenu({
      tile: TILE,
      tileMarkerContext: tileMarkerContext({ hasMarker: () => false }),
    });
    const entry = content?.entries.find((candidate) => candidate.action === 'Mark');
    expect(entry).toBeDefined();
    expect(entry?.target).toBe('tile');
  });

  it('adds Unmark/Label/Color (not Mark) when the tile is already marked', () => {
    const content = buildViewportContextMenu({
      tile: TILE,
      tileMarkerContext: tileMarkerContext({ hasMarker: () => true }),
    });
    const acts = actions(content);
    expect(acts).toEqual(expect.arrayContaining(['Unmark', 'Label', 'Color']));
    expect(acts).not.toContain('Mark');
  });

  it('omits the Mark entry when shiftKey is false even if a context is supplied', () => {
    const content = buildViewportContextMenu({
      tile: TILE,
      tileMarkerContext: tileMarkerContext({ shiftKey: false }),
    });
    expect(actions(content)).not.toContain('Mark');
  });
});

describe('buildViewportContextMenu — line marker gating', () => {
  it('omits the line Mark entry when no line-marker context is supplied (plugin disabled)', () => {
    const content = buildViewportContextMenu({ tile: TILE });
    expect(actions(content)).not.toContain('Mark');
  });

  it('adds a "Mark <edge> line" entry when the plugin is enabled and the edge is unmarked', () => {
    const content = buildViewportContextMenu({
      tile: TILE,
      lineMarkerContext: lineMarkerContext({ hasEdge: () => false }),
    });
    const entry = content?.entries.find((candidate) => candidate.action === 'Mark');
    expect(entry).toBeDefined();
    expect(entry?.target).toBe('South line');
  });

  it('adds Unmark/Label/Color (not Mark) for an already-marked edge', () => {
    const content = buildViewportContextMenu({
      tile: TILE,
      lineMarkerContext: lineMarkerContext({ hasEdge: () => true }),
    });
    const acts = actions(content);
    expect(acts).toEqual(expect.arrayContaining(['Unmark', 'Label', 'Color']));
    expect(acts).not.toContain('Mark');
  });

  it('omits the line Mark entry when no edge is under the cursor', () => {
    const content = buildViewportContextMenu({
      tile: TILE,
      lineMarkerContext: lineMarkerContext({ edge: null }),
    });
    expect(actions(content)).not.toContain('Mark');
  });
});

// A ray + screenPx + pickNpcs is what puts an NPC's cache options into the menu;
// without all three the builder falls back to the coarse footprint-tile path.
const RAY = { origin: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: 1 } };
const SCREEN_PX = { x: 100, y: 100 };

const TEST_CACHE_INFO = {
  name: 'test',
  game: 'oldschool',
  environment: 'live',
  revision: 225,
  timestamp: '2025-01-01T00:00:00Z',
  size: 0,
} satisfies CacheInfo;

function npcType(id: number, name: string, combatLevel: number, actions: string[]): NpcType {
  const type = new NpcType(id, TEST_CACHE_INFO);
  type.name = name;
  type.combatLevel = combatLevel;
  type.actions = actions;
  return type;
}

function loaderFor(byId: Record<number, NpcType>): NpcTypeLoader {
  return {
    load: (id: number) => {
      const type = byId[id];
      if (!type) throw new Error(`no test NpcType for ${id}`);
      return type;
    },
    getCount: () => Object.keys(byId).length,
    clearCache: () => {},
  } satisfies NpcTypeLoader;
}

function npcEntityContext(actions: string[]): ViewportEntityContext {
  return {
    npcTypeLoader: loaderFor({ 14176: npcType(14176, 'Yama', 700, actions) }),
    pickNpcs: () => [{ actorId: 'npc-1', npcTypeId: 14176, position: [30, 32] as Coordinate, distance: 1 }],
  };
}

function swapMenu(rules: string, npcActions = ['Attack']) {
  return buildViewportContextMenu({
    tile: TILE,
    onTileClick: vi.fn(),
    entityContext: npcEntityContext(npcActions),
    ray: RAY,
    screenPx: SCREEN_PX,
    customMenuSwaps: parseCustomMenuSwaps(rules),
  });
}

describe('buildViewportContextMenu — custom menu swaps', () => {
  it('leaves the menu order untouched when no rule matches', () => {
    expect(actions(swapMenu('use,*'))).toEqual(['Attack', 'Walk here', 'Examine', 'Cancel']);
  });

  it('promotes a matching entry to the top of the menu', () => {
    expect(actions(swapMenu('walk here'))).toEqual(['Walk here', 'Attack', 'Examine', 'Cancel']);
  });

  it('exchanges rather than reorders, so lower entries keep their slots', () => {
    const acts = actions(swapMenu('attack,*', ['Talk-to', 'Attack']));
    expect(acts).toEqual(['Attack', 'Talk-to', 'Walk here', 'Examine', 'Cancel']);
  });
});

describe('resolveViewportRightClick', () => {
  it('keeps ordinary Walk here menus when right-click camera movement is disabled', () => {
    const resolution = resolveViewportRightClick({ tile: TILE }, false);

    expect(resolution.kind).toBe('menu');
  });

  it('gives actionable entity entries ownership over camera drag', () => {
    const resolution = resolveViewportRightClick(
      {
        tile: TILE,
        entityContext: npcEntityContext(['Attack']),
        ray: RAY,
        screenPx: SCREEN_PX,
      },
      true,
    );

    expect(resolution.kind).toBe('menu');
  });

  it.each([
    ['Walk here only', { tile: TILE }],
    [
      'Examine only',
      {
        tile: null,
        entityContext: npcEntityContext([]),
        ray: RAY,
        screenPx: SCREEN_PX,
      },
    ],
    ['no content', { tile: null }],
  ])('starts camera drag for %s', (_caseName, inputs) => {
    const resolution = resolveViewportRightClick(inputs, true);

    expect(resolution.kind).toBe('camera-drag');
  });

  it('does not let a custom swap make a passive menu actionable', () => {
    const resolution = resolveViewportRightClick(
      {
        tile: TILE,
        customMenuSwaps: parseCustomMenuSwaps('walk here'),
      },
      true,
    );

    expect(resolution.kind).toBe('camera-drag');
  });

  it.each([
    ['tile marker', { tileMarkerContext: tileMarkerContext() }],
    ['line marker', { lineMarkerContext: lineMarkerContext() }],
  ])('gives Shift/Ctrl %s extras ownership over camera drag', (_caseName, extraInputs) => {
    const resolution = resolveViewportRightClick({ tile: TILE, ...extraInputs }, true);

    expect(resolution.kind).toBe('menu');
  });

  it('gives Shift/Ctrl NPC highlight actions ownership over camera drag', () => {
    const resolution = resolveViewportRightClick(
      {
        tile: null,
        entityContext: npcEntityContext([]),
        ray: RAY,
        screenPx: SCREEN_PX,
        npcHighlightContext: {
          shiftKey: true,
          isHighlighted: () => false,
          getHighlightColor: () => undefined,
          onToggleHighlight: vi.fn(),
        },
      },
      true,
    );

    expect(resolution.kind).toBe('menu');
  });
});

describe('resolveViewportLeftClickSwap', () => {
  it('routes Feed on a sleeping NPC to the clicked actor', () => {
    const onNpcActionByTarget = vi.fn();
    const content = buildViewportContextMenu({
      tile: TILE,
      entityContext: npcEntityContext(['Feed']),
      ray: RAY,
      screenPx: SCREEN_PX,
      onNpcActionByTarget,
    });
    const feed = content?.entries.find(({ action }) => action === 'Feed');
    expect(feed?.clickType).toBe('red');
    feed?.onClick?.();
    expect(onNpcActionByTarget).toHaveBeenCalledWith('npc-1', TILE, 'Feed');
    expect(actions(content)).not.toContain('Attack');
  });

  it('returns nothing when no rule promotes an entry', () => {
    expect(
      resolveViewportLeftClickSwap({
        tile: TILE,
        entityContext: npcEntityContext(['Attack']),
        ray: RAY,
        screenPx: SCREEN_PX,
        customMenuSwaps: parseCustomMenuSwaps('use,*'),
      }),
    ).toBeNull();
  });

  it('reports a promoted Walk here so the click walks instead of attacking', () => {
    expect(
      resolveViewportLeftClickSwap({
        tile: TILE,
        entityContext: npcEntityContext(['Attack']),
        ray: RAY,
        screenPx: SCREEN_PX,
        customMenuSwaps: parseCustomMenuSwaps('walk here'),
      })?.kind,
    ).toBe('walk');
  });

  it('hands back the promoted action with its click handler attached', () => {
    const onNpcActionByTarget = vi.fn();
    const swapped = resolveViewportLeftClickSwap({
      tile: TILE,
      onTileClick: vi.fn(),
      entityContext: npcEntityContext(['Talk-to', 'Attack']),
      ray: RAY,
      screenPx: SCREEN_PX,
      onNpcActionByTarget,
      customMenuSwaps: parseCustomMenuSwaps('attack,*'),
    });
    expect(swapped?.kind).toBe('action');
    expect(swapped?.entry.action).toBe('Attack');
    swapped?.entry.onClick?.();
    expect(onNpcActionByTarget).toHaveBeenCalledWith('npc-1', [30, 32], 'Attack');
  });
});

// The case the plugin exists for: two entities under one cursor, where the one a rule names
// is NOT the nearest. Yama's footprint sits in front of a void flare behind it.
function stackedEntityContext(): ViewportEntityContext {
  return {
    npcTypeLoader: loaderFor({
      14176: npcType(14176, 'Yama', 700, ['Attack']),
      14180: npcType(14180, 'Void flare', 1, ['Attack']),
    }),
    pickNpcs: () => [
      { actorId: 'yama', npcTypeId: 14176, position: [30, 32] as Coordinate, distance: 1 },
      { actorId: 'flare', npcTypeId: 14180, position: [31, 33] as Coordinate, distance: 4 },
    ],
  };
}

describe('resolveViewportLeftClickSwap — an entity behind the nearest one', () => {
  const resolveStacked = (rules: string) =>
    resolveViewportLeftClickSwap({
      tile: TILE,
      entityContext: stackedEntityContext(),
      ray: RAY,
      screenPx: SCREEN_PX,
      onNpcActionByTarget: vi.fn(),
      customMenuSwaps: parseCustomMenuSwaps(rules),
    });

  it('picks the further entity when a rule names it', () => {
    const swapped = resolveStacked('attack,void flare*');
    expect(swapped?.entry.action).toBe('Attack');
    expect(swapped?.entry.target).toContain('Void flare');
  });

  it('routes the click at the further entity, not the nearest one', () => {
    const onNpcActionByTarget = vi.fn();
    resolveViewportLeftClickSwap({
      tile: TILE,
      entityContext: stackedEntityContext(),
      ray: RAY,
      screenPx: SCREEN_PX,
      onNpcActionByTarget,
      customMenuSwaps: parseCustomMenuSwaps('attack,void flare*'),
    })?.entry.onClick?.();
    expect(onNpcActionByTarget).toHaveBeenCalledWith('flare', [31, 33], 'Attack');
  });

  it('still resolves when the rule names what already leads, so the click cannot fall back', () => {
    // Not null: the fallback order in Grid puts ground items above locs while the menu puts
    // locs first, so returning null here let a rule matching the top entry run a different one.
    const swapped = resolveStacked('attack,yama*');
    expect(swapped?.kind).toBe('action');
    expect(swapped?.entry.target).toContain('Yama');
  });

  it('reports nothing when no rule matches any entry under the cursor', () => {
    expect(resolveStacked('use,*')).toBeNull();
  });
});

describe('buildViewportContextMenu — swaps alongside marker entries', () => {
  const markerMenu = (rules: string) =>
    buildViewportContextMenu({
      tile: TILE,
      onTileClick: vi.fn(),
      entityContext: npcEntityContext(['Attack']),
      ray: RAY,
      screenPx: SCREEN_PX,
      tileMarkerContext: tileMarkerContext({ hasMarker: () => false }),
      customMenuSwaps: parseCustomMenuSwaps(rules),
    });

  it('keeps the marker entry in its own slot when a swap promotes Walk here', () => {
    // Exchange, not rotation: Mark sits between the actions and Walk here, so only the two
    // exchanged entries move and Mark stays where it was.
    expect(actions(markerMenu('walk here'))).toEqual(['Walk here', 'Mark', 'Attack', 'Examine', 'Cancel']);
  });

  it('leaves the marker layout untouched when no rule matches', () => {
    expect(actions(markerMenu('use,*'))).toEqual(['Attack', 'Mark', 'Walk here', 'Examine', 'Cancel']);
  });
});

// Right-click lists every pile on the tile; the click and hover paths must be handed the
// same stack, or a rule promotes an entry in the menu that neither of them can ever see.
describe('resolveViewportLeftClickSwap — ground items', () => {
  const groundItemContext = {
    items: [
      { groundItemId: 'pile-top', itemId: 1 },
      { groundItemId: 'pile-under', itemId: 2 },
    ],
    onTake: vi.fn(),
  };

  it('reaches a pile below the top one when a rule names it', () => {
    const onTake = vi.fn();
    const swapped = resolveViewportLeftClickSwap({
      tile: TILE,
      entityContext: npcEntityContext(['Attack']),
      ray: RAY,
      screenPx: SCREEN_PX,
      groundItemContext: { ...groundItemContext, onTake },
      customMenuSwaps: parseCustomMenuSwaps('take,*'),
    });

    expect(swapped?.entry.action).toBe('Take');
    swapped?.entry.onClick?.();
    expect(onTake).toHaveBeenCalledWith('pile-top');
  });

  it('finds nothing to promote when the stack is withheld', () => {
    expect(
      resolveViewportLeftClickSwap({
        tile: TILE,
        entityContext: npcEntityContext(['Attack']),
        ray: RAY,
        screenPx: SCREEN_PX,
        customMenuSwaps: parseCustomMenuSwaps('take,*'),
      }),
    ).toBeNull();
  });
});

function createNamedObjTypeLoader(name: string): ObjTypeLoader {
  return {
    load(id: number): ObjType {
      const obj = new ObjType(id, TEST_CACHE_INFO);
      obj.name = name;
      return obj;
    },
    getCount() {
      return 1;
    },
    clearCache() {},
  };
}

describe('buildInventoryTagSubmenu', () => {
  it('passes the current inventory tag color to picker entries', () => {
    const onPickColor = vi.fn<(itemId: number, initialColor?: string) => void>();
    const tagContext = {
      shiftKey: true,
      getTag: () => '#4a90e2',
      onRemoveTag: vi.fn<(itemId: number) => void>(),
      onPickColor,
    } satisfies InventoryTagMenuContext;

    const submenu = buildInventoryTagSubmenu(4151, 'Abyssal whip', tagContext);

    expect(submenu?.submenu?.[0]?.action).toBe('Pick color');
    submenu?.submenu?.[0]?.onClick?.();

    expect(onPickColor).toHaveBeenCalledWith(4151, '#4a90e2');
    expect(submenu?.submenu?.[1]?.action).toBe('swatch');
    submenu?.submenu?.[1]?.onClick?.();
    expect(onPickColor).toHaveBeenLastCalledWith(4151, '#4a90e2');
  });
});

describe('buildInventoryContextMenu', () => {
  it.each([
    'null',
    'Cache necklace',
  ])('resolves necklace names across menus when the cache contains %s', (cacheName) => {
    const loader = createNamedObjTypeLoader(cacheName);

    const inventory = buildInventoryContextMenu(33639, 0, loader, {});
    const equipment = buildEquipmentContextMenu(33639, 'amulet', loader, {});
    const ground = buildGroundItemEntries({
      items: [{ groundItemId: 'necklace', itemId: 33639 }],
      objTypeLoader: loader,
      onTake: vi.fn(),
    });

    const expected = cacheName === 'null' ? 'Necklace of rupture' : cacheName;
    expect(inventory?.entries[0]?.target).toBe(expected);
    expect(equipment?.entries[0]?.target).toBe(expected);
    expect(ground[0]?.target).toBe(expected);
  });

  /** Mirrors the real cache: item ops carry Eat/Wield, never Drop. */
  function createCachedObjTypeLoader(name: string, inventoryActions: (string | undefined)[]): ObjTypeLoader {
    return {
      load(id: number): ObjType {
        const obj = new ObjType(id, TEST_CACHE_INFO);
        obj.name = name;
        obj.inventoryActions = inventoryActions;
        return obj;
      },
      getCount() {
        return 1;
      },
      clearCache() {},
    };
  }

  it('offers Drop even though no cache item carries a Drop op', () => {
    const onDropItem = vi.fn<(index: number) => void>();
    const loader = createCachedObjTypeLoader('Shark', ['Eat', undefined, undefined, undefined, undefined]);

    const menu = buildInventoryContextMenu(385, 7, loader, { onDropItem });

    // Drop is present and wired because it is a client-side op in OSRS.
    const drop = menu?.entries.find((entry) => entry.action === 'Drop');
    expect(drop).toBeDefined();
    expect(drop?.target).toBe('Shark');
    drop?.onClick?.();
    expect(onDropItem).toHaveBeenCalledWith(7);
  });

  it('dispatches Guzzle separately from the default Eat action', () => {
    const onUseItem = vi.fn();
    const loader = createCachedObjTypeLoader('Dwarven rock cake', ['Eat', 'Guzzle']);
    const menu = buildInventoryContextMenu(7510, 7, loader, { onUseItem });

    menu?.entries.find((entry) => entry.action === 'Guzzle')?.onClick?.();
    expect(onUseItem).toHaveBeenLastCalledWith(7, 'guzzle');
    menu?.entries.find((entry) => entry.action === 'Eat')?.onClick?.();
    expect(onUseItem).toHaveBeenLastCalledWith(7);
  });

  it.each([
    [4151, 'Abyssal whip', 'Wield'],
    [11832, 'Bandos chestplate', 'Wear'],
    [20220, 'Holy blessing', 'Equip'],
    [4024, 'Ninja monkey greegree', 'Hold'],
    [4084, 'Sled', 'Ride'],
  ])('equips %i (%s) from its cache %s op', (itemId, name, op) => {
    const onEquipFromInventory = vi.fn<(index: number) => void>();
    const loader = createCachedObjTypeLoader(name, [undefined, op, undefined, undefined, undefined]);

    const menu = buildInventoryContextMenu(itemId, 3, loader, { onEquipFromInventory });
    menu?.entries.find((entry) => entry.action === op)?.onClick?.();

    expect(onEquipFromInventory).toHaveBeenCalledExactlyOnceWith(3);
  });

  it('puts Drop after Use, the way the real client orders them', () => {
    const loader = createCachedObjTypeLoader('Shark', ['Eat', undefined, undefined, undefined, undefined]);
    const menu = buildInventoryContextMenu(385, 0, loader, {});
    const acts = menu?.entries.map((entry) => entry.action) ?? [];

    expect(acts).toEqual(['Eat', 'Use', 'Drop', 'Cancel']);
  });

  it('does not duplicate Drop when a cache op already provides it', () => {
    const loader = createCachedObjTypeLoader('Oddity', ['Drop', undefined, undefined, undefined, undefined]);
    const menu = buildInventoryContextMenu(1, 0, loader, {});

    expect(menu?.entries.filter((entry) => entry.action === 'Drop')).toHaveLength(1);
  });
});

describe('buildGroundItemEntries', () => {
  /** The real cache leaves groundActions empty for every item; Take is client-side. */
  function createGroundObjTypeLoader(name: string, groundActions: (string | undefined)[] = []): ObjTypeLoader {
    return {
      load(id: number): ObjType {
        const obj = new ObjType(id, TEST_CACHE_INFO);
        obj.name = name;
        obj.groundActions = groundActions;
        return obj;
      },
      getCount() {
        return 1;
      },
      clearCache() {},
    };
  }

  it('offers Take even though the cache lists no ground op', () => {
    const onTake = vi.fn<(groundItemId: string) => void>();
    const entries = buildGroundItemEntries({
      items: [{ groundItemId: 'gi-1', itemId: 385 }],
      objTypeLoader: createGroundObjTypeLoader('Shark'),
      onTake,
    });

    const take = entries.find((entry) => entry.action === 'Take');
    expect(take?.target).toBe('Shark');
    take?.onClick?.();
    expect(onTake).toHaveBeenCalledWith('gi-1');
  });

  it('gives every pile on the tile its own Take and Examine', () => {
    const entries = buildGroundItemEntries({
      items: [
        { groundItemId: 'gi-1', itemId: 385 },
        { groundItemId: 'gi-2', itemId: 995 },
      ],
      objTypeLoader: createGroundObjTypeLoader('Thing'),
      onTake: vi.fn(),
    });

    expect(entries.map((entry) => entry.action)).toEqual(['Take', 'Examine', 'Take', 'Examine']);
  });

  it('routes each Take at its own pile', () => {
    const onTake = vi.fn<(groundItemId: string) => void>();
    const entries = buildGroundItemEntries({
      items: [
        { groundItemId: 'gi-1', itemId: 385 },
        { groundItemId: 'gi-2', itemId: 995 },
      ],
      objTypeLoader: createGroundObjTypeLoader('Thing'),
      onTake,
    });

    entries
      .filter((entry) => entry.action === 'Take')
      .at(-1)
      ?.onClick?.();

    expect(onTake).toHaveBeenCalledWith('gi-2');
  });

  it('does not duplicate Take when a cache ground op already provides it', () => {
    const entries = buildGroundItemEntries({
      items: [{ groundItemId: 'gi-1', itemId: 385 }],
      objTypeLoader: createGroundObjTypeLoader('Shark', [undefined, undefined, 'Take']),
      onTake: vi.fn(),
    });

    expect(entries.filter((entry) => entry.action === 'Take')).toHaveLength(1);
  });

  it('still offers Take with no cache at all', () => {
    const onTake = vi.fn<(groundItemId: string) => void>();
    const entries = buildGroundItemEntries({
      items: [{ groundItemId: 'gi-1', itemId: 385 }],
      onTake,
    });

    entries.find((entry) => entry.action === 'Take')?.onClick?.();
    expect(onTake).toHaveBeenCalledWith('gi-1');
  });
});

describe('buildEquipmentContextMenu', () => {
  it('calls unequip callback from explicit Remove entry', () => {
    const onUnequipSlot = vi.fn<(slot: string) => void>();
    const menu = buildEquipmentContextMenu(4151, 'weapon', createNamedObjTypeLoader('Abyssal whip'), { onUnequipSlot });

    const removeEntry = menu?.entries.find((entry) => entry.action === 'Remove');
    removeEntry?.onClick?.();

    expect(onUnequipSlot).toHaveBeenCalledWith('weapon');
  });
});

interface NpcTypeSpec {
  name: string;
  combatLevel: number;
  actions: string[];
}

const STACK_TILE: Coordinate = [10, 10];
const STACK_RAY: Ray3D = { origin: { x: 0, y: 0, z: 5 }, direction: { x: 0, y: 0, z: -1 } };
const STACK_SCREEN_PX = { x: 400, y: 300 };

function buildStackedNpcMenu(
  picked: PickedNpc[],
  specs: Record<number, NpcTypeSpec>,
  onNpcActionByTarget?: (actorId: string, position: Coordinate) => void,
  attackTargetActorId?: string | null,
) {
  const byId: Record<number, NpcType> = {};
  for (const [id, spec] of Object.entries(specs)) {
    byId[Number(id)] = npcType(Number(id), spec.name, spec.combatLevel, spec.actions);
  }
  return buildViewportContextMenu({
    tile: STACK_TILE,
    entityContext: { npcTypeLoader: loaderFor(byId), pickNpcs: () => picked, attackTargetActorId },
    ray: STACK_RAY,
    screenPx: STACK_SCREEN_PX,
    onNpcActionByTarget,
  });
}

describe('buildViewportContextMenu NPC stacking', () => {
  const ZEK: PickedNpc = { actorId: 'jal-zek-1', npcTypeId: 7705, position: STACK_TILE, distance: 3 };
  const XIL: PickedNpc = { actorId: 'jal-xil-1', npcTypeId: 7704, position: STACK_TILE, distance: 3 };
  const ZEK_SPEC: NpcTypeSpec = { name: 'Jal-Zek', combatLevel: 490, actions: ['Attack'] };
  const XIL_SPEC: NpcTypeSpec = { name: 'Jal-Xil', combatLevel: 370, actions: ['Attack'] };
  const SPECS: Record<number, NpcTypeSpec> = { 7705: ZEK_SPEC, 7704: XIL_SPEC };

  it('lists an Attack entry for every NPC under the cursor, pick order preserved', () => {
    const content = buildStackedNpcMenu([ZEK, XIL], SPECS);

    const attacks = content?.entries.filter((entry) => entry.action === 'Attack').map((entry) => entry.target);
    expect(attacks).toEqual(['Jal-Zek  (level-490)', 'Jal-Xil  (level-370)']);
  });

  it('stars the NPC the player is already attacking', () => {
    const content = buildStackedNpcMenu([ZEK, XIL], SPECS, undefined, XIL.actorId);

    const labels = content?.entries
      .filter((entry) => entry.action === 'Attack' || entry.action === 'Examine')
      .map((entry) => entry.target);
    expect(labels).toEqual([
      'Jal-Zek  (level-490)',
      '*Jal-Xil  (level-370)',
      'Jal-Zek  (level-490)',
      '*Jal-Xil  (level-370)',
    ]);
  });

  it('stars nothing while the player has no target', () => {
    const content = buildStackedNpcMenu([ZEK, XIL], SPECS, undefined, null);

    expect(content?.entries.every((entry) => !entry.target?.startsWith('*'))).toBe(true);
  });

  it('groups every Examine below Walk here, like OSRS', () => {
    const content = buildStackedNpcMenu([ZEK, XIL], SPECS);

    const order = content?.entries.map((entry) => `${entry.action}:${entry.target ?? ''}`) ?? [];
    expect(order).toEqual([
      'Attack:Jal-Zek  (level-490)',
      'Attack:Jal-Xil  (level-370)',
      'Walk here:',
      'Examine:Jal-Zek  (level-490)',
      'Examine:Jal-Xil  (level-370)',
      'Cancel:',
    ]);
  });

  it('routes each Attack entry at its own actor', () => {
    const onNpcActionByTarget = vi.fn<(actorId: string, position: Coordinate) => void>();
    const content = buildStackedNpcMenu([ZEK, XIL], SPECS, onNpcActionByTarget);

    const xilAttack = content?.entries.find(
      (entry) => entry.action === 'Attack' && entry.target === 'Jal-Xil  (level-370)',
    );
    xilAttack?.onClick?.();

    expect(onNpcActionByTarget).toHaveBeenCalledTimes(1);
    expect(onNpcActionByTarget).toHaveBeenCalledWith('jal-xil-1', STACK_TILE, 'Attack');
  });

  it('skips only the NPC whose cache type fails to load', () => {
    const content = buildStackedNpcMenu([ZEK, XIL], { 7704: XIL_SPEC });

    const attacks = content?.entries.filter((entry) => entry.action === 'Attack').map((entry) => entry.target);
    expect(attacks).toEqual(['Jal-Xil  (level-370)']);
  });

  it('does not route a non-Attack action (Talk-to) through the attack callback', () => {
    const onNpcActionByTarget = vi.fn<(actorId: string, position: Coordinate) => void>();
    const BANKER: PickedNpc = { actorId: 'banker-1', npcTypeId: 8000, position: STACK_TILE, distance: 3 };
    const BANKER_SPEC: NpcTypeSpec = { name: 'Banker', combatLevel: 0, actions: ['Talk-to', 'Attack'] };
    const content = buildStackedNpcMenu([BANKER], { 8000: BANKER_SPEC }, onNpcActionByTarget);

    // Talk-to is present but inert: no red-X click handler, no attack routing.
    const talk = content?.entries.find((entry) => entry.action === 'Talk-to');
    expect(talk).toBeDefined();
    expect(talk?.onClick).toBeUndefined();
    expect(talk?.clickType).toBeUndefined();
    talk?.onClick?.();
    expect(onNpcActionByTarget).not.toHaveBeenCalled();

    // Attack on the same NPC still routes at that actor.
    const attack = content?.entries.find((entry) => entry.action === 'Attack');
    attack?.onClick?.();
    expect(onNpcActionByTarget).toHaveBeenCalledTimes(1);
    expect(onNpcActionByTarget).toHaveBeenCalledWith('banker-1', STACK_TILE, 'Attack');
  });

  it('leaves an NPC with no cache actions unclickable (the Zuk shield case)', () => {
    const onNpcActionByTarget = vi.fn<(actorId: string, position: Coordinate) => void>();
    const SHIELD: PickedNpc = { actorId: 'shield-1', npcTypeId: 8001, position: STACK_TILE, distance: 3 };
    const SHIELD_SPEC: NpcTypeSpec = { name: "Zuk's shield", combatLevel: 0, actions: [] };
    const content = buildStackedNpcMenu([SHIELD], { 8001: SHIELD_SPEC }, onNpcActionByTarget);

    // No red-X (attack) entries at all; only the implicit Examine survives.
    expect(content?.entries.some((entry) => entry.clickType === 'red')).toBe(false);
    for (const entry of content?.entries ?? []) entry.onClick?.();
    expect(onNpcActionByTarget).not.toHaveBeenCalled();
  });

  it('renders the glyph cache color wrapper as a cyan name rather than literal tags', () => {
    const glyph: PickedNpc = { actorId: 'glyph', npcTypeId: 7707, position: STACK_TILE, distance: 3 };
    const content = buildStackedNpcMenu([glyph], {
      7707: { name: '<col=00ffff>Ancestral Glyph</col>', combatLevel: 0, actions: [] },
    });

    expect(content?.entries.find((entry) => entry.action === 'Examine')).toMatchObject({
      target: 'Ancestral Glyph',
      targetColor: '#00ffff',
    });
    expect(content?.entries.some((entry) => entry.action === 'Attack')).toBe(false);
  });

  it('preserves the target marker and combat level around a color-wrapped NPC name', () => {
    const picked: PickedNpc = { actorId: 'coloured-npc', npcTypeId: 8001, position: STACK_TILE, distance: 3 };
    const content = buildStackedNpcMenu(
      [picked],
      { 8001: { name: '<col=00FFFF>Example</col>', combatLevel: 20, actions: ['Attack'] } },
      undefined,
      picked.actorId,
    );

    expect(content?.entries.find((entry) => entry.action === 'Attack')).toMatchObject({
      target: '*Example  (level-20)',
      targetColor: '#00FFFF',
    });
  });
});
