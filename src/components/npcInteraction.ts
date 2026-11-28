import type { PickedNpc } from '../render/scene/npcPick';
import type { NpcType } from '../rs/config/npctype/NpcType';
import type { NpcTypeLoader } from '../rs/config/npctype/NpcTypeLoader';
import { log } from '../util/Logger';

/** NPC actions supported by the viewport's actor-click path. */
export function isNpcClickAction(action: string | null | undefined): boolean {
  return action === 'Attack' || action === 'Feed';
}

export function hasNpcClickAction(npcType: Pick<NpcType, 'actions'>): boolean {
  return npcType.actions.some(isNpcClickAction);
}

// True when the NPC's cache type carries at least one op, i.e. it contributes a
// real menu entry. In game an NPC with no ops adds nothing to the menu (Examine
// alone never outranks "Walk here", let alone an Attack behind it), so an
// op-less NPC - the Zuk Ancestral Glyph, `NpcType 7707`, is `actions=[]` - is
// transparent to the cursor rather than swallowing the click.
function hasNpcMenuActions(npcType: Pick<NpcType, 'actions'>): boolean {
  return npcType.actions.some((action): action is string => action !== undefined && action !== null);
}

/** The NPC a hover or left-click acts on, with its cache type when it loaded. */
export interface ResolvedNpcPick {
  readonly picked: PickedNpc;
  /** Absent when the NPC's cache type failed to load. */
  readonly npcType?: NpcType;
}

/**
 * Reduce the NPCs under the cursor (nearest first) to the one the click belongs to.
 *
 * Op-less NPCs are skipped entirely, so a wall-like NPC in front - the Zuk shield -
 * never blocks an Attack on the healer behind it. The first NPC that does own ops
 * wins even if it is not attackable, matching the client: its entry heads the menu
 * and nothing further back can outrank it.
 */
export function resolveInteractiveNpcPick(
  picks: readonly PickedNpc[],
  npcTypeLoader: NpcTypeLoader | null | undefined,
): ResolvedNpcPick | null {
  if (!npcTypeLoader) return null;

  // A loader that throws leaves us unable to judge the NPC, which is not a design
  // signal: remember it as a fallback but keep looking for one we can read. Only
  // loaders that throw land here - `BaseTypeLoader` swallows a bad decode and hands
  // back a default, op-less type, which correctly reads as transparent.
  let unresolved: ResolvedNpcPick | null = null;

  for (const picked of picks) {
    let npcType: NpcType;
    try {
      npcType = npcTypeLoader.load(picked.npcTypeId);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      log.debug('UI', `Failed to load picked NPC type ${picked.npcTypeId}`, error);
      unresolved ??= { picked };
      continue;
    }
    if (hasNpcMenuActions(npcType)) return { picked, npcType };
  }

  return unresolved;
}
