import { describe, expect, it } from 'vitest';
import type { PickedNpc } from '../../render/scene/npcPick';
import type { CacheInfo } from '../../rs/cache/CacheInfo';
import { NpcType } from '../../rs/config/npctype/NpcType';
import type { NpcTypeLoader } from '../../rs/config/npctype/NpcTypeLoader';
import { hasNpcClickAction, resolveInteractiveNpcPick } from '../npcInteraction';

describe('hasNpcClickAction', () => {
  it('rejects an NPC with no options besides the implicit Examine entry', () => {
    const actions = new Array<string>(5);

    expect(hasNpcClickAction({ actions })).toBe(false);
  });

  it('accepts an NPC exposing the Attack option', () => {
    const actions = new Array<string>(5);
    actions[1] = 'Attack';

    expect(hasNpcClickAction({ actions })).toBe(true);
  });

  it('rejects an NPC whose only options are non-combat (e.g. Talk-to)', () => {
    const actions = new Array<string>(5);
    actions[0] = 'Talk-to';
    actions[2] = 'Trade';

    expect(hasNpcClickAction({ actions })).toBe(false);
  });

  it('accepts an NPC that carries Attack alongside non-combat options', () => {
    const actions = new Array<string>(5);
    actions[0] = 'Talk-to';
    actions[1] = 'Attack';

    expect(hasNpcClickAction({ actions })).toBe(true);
  });
});

function makePick(actorId: string, npcTypeId: number, distance: number): PickedNpc {
  return { actorId, npcTypeId, position: [10, 10], distance };
}

const MOCK_CACHE_INFO: CacheInfo = {
  name: 'test',
  game: 'oldschool',
  environment: 'test',
  revision: 1,
  timestamp: '2024-01-01T00:00:00Z',
  size: 0,
};

/**
 * The cache leaves `actions` as five slots with holes for the ops an NPC does not
 * define, so fixtures are built the same way - a dense array would let a wrong
 * `actions.length` check pass while the real op-less glyph still blocked clicks.
 */
function sparseActions(slots: Record<number, string>): string[] {
  const actions = new Array<string>(5);
  for (const [slot, action] of Object.entries(slots)) {
    actions[Number(slot)] = action;
  }
  return actions;
}

/** Loader over `id -> actions`; an id absent from the map throws like a bad cache read. */
function makeLoader(actionsById: Record<number, string[]>): NpcTypeLoader {
  return {
    load(id: number): NpcType {
      const actions = actionsById[id];
      if (!actions) throw new Error(`no NpcType ${id}`);
      const npc = new NpcType(id, MOCK_CACHE_INFO);
      npc.name = `npc-${id}`;
      npc.combatLevel = 100;
      npc.actions = actions;
      return npc;
    },
    getCount: () => Object.keys(actionsById).length,
    clearCache() {},
  };
}

// The Zuk Ancestral Glyph (`NpcType 7707`) has no ops at all; the healer behind it does.
const GLYPH = makePick('zuk_shield', 7707, 100);
const HEALER = makePick('healer-1', 7706, 400);
const LOADER = makeLoader({ 7707: sparseActions({}), 7706: sparseActions({ 1: 'Attack' }) });

describe('resolveInteractiveNpcPick', () => {
  it('skips an op-less NPC in front and resolves the attackable NPC behind it', () => {
    const resolved = resolveInteractiveNpcPick([GLYPH, HEALER], LOADER);

    expect(resolved?.picked.actorId).toBe('healer-1');
    expect(hasNpcClickAction(resolved?.npcType ?? { actions: [] })).toBe(true);
  });

  it('resolves nothing when the only NPC under the cursor is op-less', () => {
    expect(resolveInteractiveNpcPick([GLYPH], LOADER)).toBeNull();
  });

  it('stops at the nearest NPC that owns ops even when it cannot be attacked', () => {
    const banker = makePick('banker-1', 8000, 100);
    const loader = makeLoader({ 8000: sparseActions({ 0: 'Talk-to' }), 7706: sparseActions({ 1: 'Attack' }) });

    const resolved = resolveInteractiveNpcPick([banker, HEALER], loader);

    expect(resolved?.picked.actorId).toBe('banker-1');
    expect(hasNpcClickAction(resolved?.npcType ?? { actions: [] })).toBe(false);
  });

  it('prefers a loadable NPC over one whose loader throws', () => {
    const broken = makePick('broken-1', 9999, 100);

    expect(resolveInteractiveNpcPick([broken, HEALER], LOADER)?.picked.actorId).toBe('healer-1');
  });

  it('falls back to the NPC whose loader threw when nothing else owns ops', () => {
    const broken = makePick('broken-1', 9999, 100);

    const resolved = resolveInteractiveNpcPick([broken, GLYPH], LOADER);

    expect(resolved?.picked.actorId).toBe('broken-1');
    expect(resolved?.npcType).toBeUndefined();
  });

  it('resolves nothing without a type loader', () => {
    expect(resolveInteractiveNpcPick([HEALER], undefined)).toBeNull();
  });
});
