import type { NpcType } from '../../rs/config/npctype/NpcType';

/** A scene's idle and walk overrides for an NPC type, as a render config declares them. */
export interface NpcBaseSeqOverrides {
  readonly idleSeqId?: number;
  readonly walkSeqId?: number;
}

/**
 * The idle and walk seqs an NPC type plays: the scene's overrides, else its cache type's own (-1 is
 * none). Frame-sound extraction resolves every loaded type through this as the renderer does, so a
 * cache clip the scene falls back to cannot ship with its frame sounds missing from the trim.
 */
export function npcBaseSeqIds(
  npcType: Pick<NpcType, 'idleSeqId' | 'walkSeqId'>,
  overrides: NpcBaseSeqOverrides | undefined,
): { readonly idleSeqId: number; readonly walkSeqId: number } {
  return {
    idleSeqId: overrides?.idleSeqId ?? npcType.idleSeqId,
    walkSeqId: overrides?.walkSeqId ?? npcType.walkSeqId,
  };
}
