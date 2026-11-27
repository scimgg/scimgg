import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import { calculateProjectileEndTime } from '../../core/combat/hitDelay';
import { projectileDistance } from '../../core/combat/npcAttackRequest';
import type { EncounterVisualBatch, NpcProjectileCue } from '../../core/events/encounterVisual';
import { actorVisualTarget, npcProjectileSource } from '../projectileCue';
import { JAL_XIL_PROJECTILE_TIMING, JAL_ZEK_PROJECTILE_TIMING } from './projectileProfiles';

// Visual-only cues; packet fields are not autonomous attacks or HP changes (docs/encounters/zuk-projectile-evidence.md).

export function demonstrateJad(
  jad: NpcActor,
  target: PlayerActor | NpcActor,
  style: 'magic' | 'range',
): EncounterVisualBatch {
  faceInfernoAction(jad, target);
  const animations = [{ actorId: jad.id, clipId: style, delayCycles: 0 }];
  switch (style) {
    case 'range':
      return { animations, projectiles: [], graphics: [] };
    case 'magic': {
      const distance = projectileDistance(jad, target);
      return {
        animations,
        graphics: [],
        // capture inferno-waves-69-zuk-packet-data.txt, t827/t830: windup and distinct 448/449/450 windows.
        projectiles: [
          { spotAnimId: 448, start: 2, end: 2 },
          { spotAnimId: 449, start: 6, end: 6 },
          { spotAnimId: 450, start: 10, end: 12 },
        ].map((cue) => ({
          spotAnimId: cue.spotAnimId,
          sourcePosition: npcProjectileSource(jad),
          target: actorVisualTarget(target),
          startDelayCycles: 90 + cue.start,
          endDelayCycles: 90 + cue.end + 8 * distance,
          slope: 16,
          startOffset: 32,
          startHeight: 512,
          endHeight: 124,
        })),
      };
    }
    default:
      return assertNever(style);
  }
}

// Wave-69 and ordinary-wave types share models and projectiles (facts spec, NPCs).
const isMager = (actor: NpcActor) => actor.npcTypeId === 7703 || actor.npcTypeId === 7699;
const isRanger = (actor: NpcActor) => actor.npcTypeId === 7702 || actor.npcTypeId === 7698;

export function demonstrateSet(actors: readonly NpcActor[], target: NpcActor | PlayerActor): EncounterVisualBatch {
  for (const actor of actors) faceInfernoAction(actor, target);
  const magerProjectiles = actors.filter(isMager).map((actor) => ({
    spotAnimId: 1376,
    sourcePosition: npcProjectileSource(actor),
    target: actorVisualTarget(target),
    startDelayCycles: JAL_ZEK_PROJECTILE_TIMING.delay,
    endDelayCycles: calculateProjectileEndTime(JAL_ZEK_PROJECTILE_TIMING, projectileDistance(actor, target)),
    slope: 0,
    startOffset: JAL_ZEK_PROJECTILE_TIMING.progress,
    startHeight: 400,
    endHeight: 124,
  }));
  const rangerProjectiles = actors.filter(isRanger).flatMap<NpcProjectileCue>((actor) => {
    // Octant-relative muzzles, presentation only: two tiles out on the facing side, one either side of
    // the center line (one out on each adjacent side for a diagonal). Facing the target, this gives the
    // captured pair for 743/819 single-ranger volleys in P, Q and wave 69 (N: SW+(0,3)/(2,3) 318x,
    // E: (3,0)/(3,2) 158x, W: (-1,0)/(-1,2) 125x, NE: (1,3)/(3,1) 104x); the other 76 are unexplained.
    const angle = Math.round(actor.facing / 256) * (Math.PI / 4);
    const forwardX = -Math.round(Math.sin(angle));
    const forwardY = -Math.round(Math.cos(angle));
    const reach = forwardX === 0 || forwardY === 0 ? 2 : 1;
    const centre = npcProjectileSource(actor);
    const endDelayCycles = calculateProjectileEndTime(JAL_XIL_PROJECTILE_TIMING, projectileDistance(actor, target));
    // capture inferno-waves-69-zuk-packet-data.txt:3820-3825; both muzzles share the actor-based endtime.
    return [-1, 1].map((side) => ({
      spotAnimId: 1377,
      sourcePosition: [centre[0] + reach * forwardX + side * forwardY, centre[1] + reach * forwardY - side * forwardX],
      target: actorVisualTarget(target),
      // Overlapping targets can arrive before cycle 60; retain a valid one-cycle visual without delaying damage.
      startDelayCycles: Math.min(JAL_XIL_PROJECTILE_TIMING.delay, endDelayCycles),
      endDelayCycles,
      slope: 16,
      startOffset: JAL_XIL_PROJECTILE_TIMING.progress,
      startHeight: 256,
      endHeight: 124,
    }));
  });
  return {
    animations: actors.map((actor) => ({
      actorId: actor.id,
      clipId: isMager(actor) ? 'magic' : 'range',
      delayCycles: 0,
    })),
    projectiles: [...magerProjectiles, ...rangerProjectiles],
    graphics: magerProjectiles.map((projectile) => ({
      spotAnimId: 131,
      target: projectile.target,
      delayCycles: projectile.endDelayCycles,
      height: 124,
    })),
  };
}

export function demonstrateHeal(healers: readonly NpcActor[], zuk: NpcActor): EncounterVisualBatch {
  for (const actor of healers) faceInfernoAction(actor, zuk);
  return {
    animations: healers.map((actor) => ({ actorId: actor.id, clipId: 'heal', delayCycles: 0 })),
    // capture inferno-waves-69-zuk-packet-data.txt, t1069: four NPC-targeted 660 projectiles.
    projectiles: healers.map((actor) => ({
      spotAnimId: 660,
      sourcePosition: npcProjectileSource(actor),
      target: actorVisualTarget(zuk),
      startDelayCycles: 0,
      endDelayCycles: 90,
      slope: 16,
      startOffset: 64,
      startHeight: 70,
      endHeight: 128,
    })),
    // Same capture, t1073: 444 at height 256, four ticks after the volley; no healing roll is inferred.
    graphics: [{ spotAnimId: 444, target: actorVisualTarget(zuk), delayCycles: 120, height: 256 }],
  };
}

export function faceInfernoAction(actor: NpcActor, target: Pick<NpcActor | PlayerActor, 'position' | 'size'>): void {
  const deltaX = target.position[0] + target.size / 2 - actor.position[0] - actor.size / 2;
  const deltaY = target.position[1] + target.size / 2 - actor.position[1] - actor.size / 2;
  if (deltaX === 0 && deltaY === 0) return;
  actor.facing = (Math.round(Math.atan2(-deltaX, -deltaY) * (2048 / (2 * Math.PI))) + 2048) % 2048;
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown demonstration style: ${value}`);
}
