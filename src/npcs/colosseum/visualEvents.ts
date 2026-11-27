import { z } from 'zod';
import { type NpcProjectileCue, npcProjectileCueSchema } from '../../core/events/encounterVisual';
import type { TickEvents } from '../../core/events/TickEvents';
import type { GameEvent } from '../../core/events/types';
import type { Coordinate } from '../../types/simulation';
import { COLOSSEUM_SPOTANIMS } from './constants';
import type { CardinalDirection } from './solAttacks';

/**
 * The Fortis Colosseum's one-shot visual transitions: which clip an actor plays, which cache effect
 * burns on which tile or actor, and which projectiles fly.
 *
 * Sol's attacks ARE their telegraphs, so this is not decoration — the animation and the ground
 * effect are the only warning a player gets. Both are capture-observed (`sequence` lines for the
 * clips, `map_anim` lines for the tiles); see `docs/encounters/sol-heredit-capture-analysis.md`.
 *
 * Sol himself throws nothing (no projectile record in any Sol capture); the projectiles are the
 * warband's and the healing totems', flown by the same `NpcProjectileCue` path as the Inferno's.
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

export interface ColosseumAnimationCue {
  readonly actorId: string;
  /** Key into the render config's `attackClips`, not a raw sequence id. */
  readonly clipId: string;
  readonly delayCycles: number;
}

interface ColosseumGraphicTiming {
  readonly spotAnimId: number;
  /** Client cycles after the emitting tick, 30 per tick. Carries the per-tile ripple. */
  readonly delayCycles: number;
  /** OSRS height above terrain. Omitted for ground-level effects. */
  readonly height?: number;
}

export interface ColosseumGroundGraphicCue extends ColosseumGraphicTiming {
  readonly position: Coordinate;
}

export type ColosseumGraphicCue = ColosseumGroundGraphicCue | (ColosseumGraphicTiming & { readonly actorId: string });

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
): ColosseumGroundGraphicCue[] {
  const effect = BEAM_EFFECTS[direction];
  const graphics: ColosseumGroundGraphicCue[] = tiles.map(([x, y], index) => ({
    spotAnimId: effect[stage],
    position: [x, y],
    delayCycles: (index + 1) * 3,
    height: 128,
  }));
  const last = tiles.at(-1);
  if (stage === 'fire' && last) {
    graphics.push({
      spotAnimId: COLOSSEUM_SPOTANIMS.crystalImpact,
      position: [last[0] + effect.dx, last[1] + effect.dy],
      delayCycles: tiles.length * 3,
      height: 128,
    });
  }
  return graphics;
}

export interface ColosseumVisualCue {
  readonly animations: readonly ColosseumAnimationCue[];
  readonly graphics: readonly ColosseumGraphicCue[];
  /** Omitted by the many cues that launch nothing. */
  readonly projectiles?: readonly NpcProjectileCue[];
}

export type ColosseumVisualEvent = GameEvent & ColosseumVisualCue & { readonly type: 'colosseum_visual' };

const cycles = z.number().int().nonnegative();
const coordinate = z.tuple([z.number(), z.number()]);
const visualEventSchema = z.object({
  type: z.literal('colosseum_visual'),
  eventId: cycles,
  tick: cycles,
  animations: z.array(z.object({ actorId: z.string().min(1), clipId: z.string().min(1), delayCycles: cycles })),
  graphics: z.array(
    z.union([
      z.object({ spotAnimId: cycles, position: coordinate, delayCycles: cycles, height: cycles.optional() }).strict(),
      z
        .object({ spotAnimId: cycles, actorId: z.string().min(1), delayCycles: cycles, height: cycles.optional() })
        .strict(),
    ]),
  ),
  projectiles: z.array(npcProjectileCueSchema).optional(),
});

export function isColosseumVisualEvent(event: GameEvent): event is ColosseumVisualEvent {
  return visualEventSchema.safeParse(event).success;
}

/** No-ops on an empty cue so callers can build one unconditionally. */
export function emitColosseumVisual(events: TickEvents, cue: ColosseumVisualCue): void {
  if (cue.animations.length === 0 && cue.graphics.length === 0 && (cue.projectiles?.length ?? 0) === 0) return;
  events.emit({ type: 'colosseum_visual', ...structuredClone(cue) });
}
