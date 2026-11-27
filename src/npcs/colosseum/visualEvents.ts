import type { EncounterGraphicCue } from '../../core/events/encounterVisual';
import type { Coordinate } from '../../types/simulation';
import { COLOSSEUM_SPOTANIMS } from './constants';
import type { CardinalDirection } from './solAttacks';

/**
 * The Fortis Colosseum's visual cues, emitted as `encounter_visual` batches: which clip an actor
 * plays, which cache effect burns on which tile or rides which actor, and which projectiles fly.
 *
 * Sol's attacks ARE their telegraphs, so this is not decoration — the animation and the ground
 * effect are the only warning a player gets. Both are capture-observed (`sequence` lines for the
 * clips, `map_anim` lines for the tiles); see `docs/encounters/sol-heredit-capture-analysis.md`.
 *
 * Sol himself throws nothing (no projectile record in any Sol capture); the projectiles are the
 * warband's and the healing totems'. Tile effects take a `tile` target; effects on an actor ride it
 * (`attached`), as the client draws a spotanim on an entity.
 */

/** Every spotanim this encounter can spawn, for preloading. */
export const COLOSSEUM_SPOT_ANIM_IDS: readonly number[] = [
  ...COLOSSEUM_SPOTANIMS.solMelee,
  COLOSSEUM_SPOTANIMS.solLand,
  COLOSSEUM_SPOTANIMS.solDeath,
  COLOSSEUM_SPOTANIMS.tripleTelegraphShort,
  COLOSSEUM_SPOTANIMS.tripleTelegraphLong,
  ...COLOSSEUM_SPOTANIMS.crystalCharge,
  ...COLOSSEUM_SPOTANIMS.crystalFire,
  COLOSSEUM_SPOTANIMS.crystalImpact,
  COLOSSEUM_SPOTANIMS.sunfireLightning,
  COLOSSEUM_SPOTANIMS.finalBossExplosion,
  COLOSSEUM_SPOTANIMS.fireblastImpact,
  COLOSSEUM_SPOTANIMS.warbandArrow,
  COLOSSEUM_SPOTANIMS.warbandFireblast,
  COLOSSEUM_SPOTANIMS.totemProjectile,
  COLOSSEUM_SPOTANIMS.totemImpact,
];

// Direction of travel, not the crystal's edge (K:4032 south, K:4073 west).
// visualEvents.test.ts checks all four against all three colosseum-sol-heredit captures.
const BEAM_EFFECTS = {
  south: { charge: COLOSSEUM_SPOTANIMS.crystalCharge[0], fire: COLOSSEUM_SPOTANIMS.crystalFire[0], dx: 0, dy: -1 },
  west: { charge: COLOSSEUM_SPOTANIMS.crystalCharge[1], fire: COLOSSEUM_SPOTANIMS.crystalFire[1], dx: -1, dy: 0 },
  north: { charge: COLOSSEUM_SPOTANIMS.crystalCharge[2], fire: COLOSSEUM_SPOTANIMS.crystalFire[2], dx: 0, dy: 1 },
  east: { charge: COLOSSEUM_SPOTANIMS.crystalCharge[3], fire: COLOSSEUM_SPOTANIMS.crystalFire[3], dx: 1, dy: 0 },
} as const satisfies Record<CardinalDirection, { charge: number; fire: number; dx: number; dy: number }>;

/** The captures use 13 directional segments and a separate impact beyond the final segment. */
export function colosseumBeamGraphics(
  direction: CardinalDirection,
  tiles: readonly Coordinate[],
  stage: 'charge' | 'fire',
): EncounterGraphicCue[] {
  const effect = BEAM_EFFECTS[direction];
  const graphics: EncounterGraphicCue[] = tiles.map(([x, y], index) => ({
    spotAnimId: effect[stage],
    target: { kind: 'tile', position: [x, y] },
    delayCycles: (index + 1) * 3,
    height: 128,
  }));
  const last = tiles.at(-1);
  if (stage === 'fire' && last) {
    graphics.push({
      spotAnimId: COLOSSEUM_SPOTANIMS.crystalImpact,
      target: { kind: 'tile', position: [last[0] + effect.dx, last[1] + effect.dy] },
      delayCycles: tiles.length * 3,
      height: 128,
    });
  }
  return graphics;
}
