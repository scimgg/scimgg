import type { NpcActor } from '../../core/actors/NpcActor';
import { scheduleNpcAction } from '../../core/combat/npcActionClock';
import { contextDecisions, uniformOptions } from '../../core/decisionRandom';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { isNpcLiving } from '../../core/npcDeath';
import { npcFootprintsOverlap } from '../../core/npcOccupancy';
import type { NpcDefinitionContext } from '../../core/npcs';
import type { Coordinate } from '../../types/simulation';
import { infernoIdentity } from './actors';
import { INFERNO_WAVE_NPC_IDS } from './constants';
import { faceInfernoAction } from './demonstrations';
import { emitInfernoAbility } from './events';
import { isInfernoFootprintLegal } from './waveCombat';

/**
 * docs/encounters/inferno-policy.md (Mager resurrection): bat, blob, meleer, ranger and mager
 * corpses killed this wave, each original monster at most once (two of one species can each be revived:
 * P wave 44's two bats, Q wave 49's two meleers); never nibblers, split blobs, Jads or healers.
 */
export type ResurrectableSpecies = 'bat' | 'blob' | 'meleer' | 'ranger' | 'mager';

const RESURRECTABLE_TYPES: Readonly<Record<number, ResurrectableSpecies>> = {
  [INFERNO_WAVE_NPC_IDS.bat]: 'bat',
  [INFERNO_WAVE_NPC_IDS.blob]: 'blob',
  [INFERNO_WAVE_NPC_IDS.meleer]: 'meleer',
  [INFERNO_WAVE_NPC_IDS.ranger]: 'ranger',
  [INFERNO_WAVE_NPC_IDS.mager]: 'mager',
};

/** The species a dead ordinary-wave NPC could be revived as, or null when it is never eligible. */
export function resurrectableSpecies(npc: Pick<NpcActor, 'npcTypeId'>): ResurrectableSpecies | null {
  return RESURRECTABLE_TYPES[npc.npcTypeId] ?? null;
}

/** One entry of the encounter's corpse ledger. */
export type InfernoCorpse = { readonly id: string; readonly species: ResurrectableSpecies };

/**
 * The encounter owns the corpse ledger and the spawn. `eligibleCorpses` lists this wave's corpses not
 * yet revived; `revive` must consume the corpse and add the NPC at `position` this tick, built with
 * `createInfernoWaveNpc(corpse.species, { ..., origin: 'resurrection' })`.
 */
export type MagerResurrection = {
  readonly eligibleCorpses: (context: NpcDefinitionContext) => readonly InfernoCorpse[];
  readonly revive: (corpse: InfernoCorpse, position: Coordinate, context: NpcDefinitionContext) => void;
};

// Policy (Mager resurrection): 1/10 when it would attack (captures 34/318 = 10.7%; Wiki Jal-Zek cites
// Mod Ash's 1/10). The birth SW tile is uniform over local x 31-37, y 28-34: every captured birth tile
// (the caster's facing tile, P:85377) lies there and all 49 are legal in all 34 captured scenes. A
// footprint may overlap living NPCs (12/34, often the mager, P t4869, Q t3505); excluding the player's
// tile and corpses is policy (none was ever chosen).
const RESURRECTION_CHANCE = 0.1;
const RESURRECTION_BOX = { minX: 31, maxX: 37, minY: 28, maxY: 34 } as const;
// Facts spec (Jal-Zek): next magic attack rez+8; message, seq 7611 and graphic 444 at height 150.
const NEXT_ATTACK_AFTER_RESURRECTION_TICKS = 8;
const RESURRECTION_MESSAGE = 'Jal-Zek uses his power to trigger the rebirth of a fallen foe.';

/** Legal terrain (no standing pillar) clear of the player and of corpses; living NPCs may be overlapped. */
function canReviveAt(world: NpcDefinitionContext['world'], southWest: Coordinate, size: number): boolean {
  if (!isInfernoFootprintLegal(southWest, size)) return false;
  const footprint = { position: southWest, size };
  const player = world.getPlayer();
  if (player && npcFootprintsOverlap(footprint, player)) return false;
  // A corpse occupies tiles until it is removed; a nibbler's or a pillar stand-in's never do.
  return !world
    .getNpcs()
    .some((npc) => npc.blocksNpcMovement !== false && !isNpcLiving(npc) && npcFootprintsOverlap(footprint, npc));
}

function freeResurrectionTiles(context: NpcDefinitionContext, size: number): Coordinate[] {
  const tiles: Coordinate[] = [];
  for (let y = RESURRECTION_BOX.minY; y <= RESURRECTION_BOX.maxY; y++) {
    for (let x = RESURRECTION_BOX.minX; x <= RESURRECTION_BOX.maxX; x++) {
      if (canReviveAt(context.world, [x, y], size)) tiles.push([x, y]);
    }
  }
  return tiles;
}

/**
 * Called when the mager would attack. Returns true when it resurrected instead, having scheduled its
 * next attack. Draws nothing without an eligible corpse.
 */
export function tryMagerResurrection(
  actor: NpcActor,
  resurrection: MagerResurrection,
  context: NpcDefinitionContext,
): boolean {
  const corpses = resurrection.eligibleCorpses(context);
  if (corpses.length === 0) return false;
  const decisions = contextDecisions(context);
  const key = { tick: context.tick, actorId: actor.id };
  if (!decisions.chance({ ...key, site: 'inferno.mager.rez' }, RESURRECTION_CHANCE)) return false;
  const corpse = decisions.choose({ ...key, site: 'inferno.mager.rez.corpse' }, uniformOptions(corpses));
  const size = infernoIdentity(corpse.species).size;
  const tiles = freeResurrectionTiles(context, size);
  if (tiles.length === 0) return false;
  const position = decisions.choose({ ...key, site: 'inferno.mager.rez.tile' }, uniformOptions(tiles));
  // The caster faces the birth SW tile, and graphic 444 sits at birth SW + (size - 2, size - 2): bat +0,
  // blob/ranger +1, meleer/mager +2. The revived NPC then takes its ordinary first turn (engine rule),
  // so the captured `add` tile is where that step ended (20/34 step; 34/34 reproduced).
  const graphicTile: Coordinate = [position[0] + size - 2, position[1] + size - 2];
  faceInfernoAction(actor, { position, size: 1 });
  resurrection.revive(corpse, position, context);
  emitEncounterVisual(context.tickEvents, {
    animations: [{ actorId: actor.id, clipId: 'resurrect', delayCycles: 0 }],
    projectiles: [],
    graphics: [{ spotAnimId: 444, target: { kind: 'tile', position: graphicTile }, delayCycles: 0, height: 150 }],
  });
  emitInfernoAbility(context, { ability: 'mager_resurrect', actorId: actor.id, position: actor.position });
  context.tickEvents.emit({ type: 'game_message', kind: 'spam', segments: [{ text: RESURRECTION_MESSAGE }] });
  scheduleNpcAction(actor.combat, context.tick, NEXT_ATTACK_AFTER_RESURRECTION_TICKS);
  return true;
}
