import type { NpcActor } from '../../../core/actors/NpcActor';
import { npcHitDelayFromEndTime } from '../../../core/combat/hitDelay';
import { applyNpcHealing } from '../../../core/combat/npcHealing';
import type { EncounterContext } from '../../../core/encounters/types';
import { emitEncounterVisual } from '../../../core/events/encounterVisual';
import { createNpcDefinition, type DefinedNpcActor } from '../../../core/npcs';
import { createColosseumActor } from '../../../npcs/colosseum/actors';
import { COLOSSEUM_SPOTANIMS, HEALING_TOTEM_PROJECTILE } from '../../../npcs/colosseum/constants';
import { actorVisualTarget, npcProjectileSource } from '../../../npcs/projectileCue';
import type { Coordinate } from '../../../types/simulation';

/**
 * Totemic's healing totem: a stationary 1-HP NPC that heals one enemy. Run A has 55 wave totems
 * (A:850–4832), none in its Sol fight; the rules below are fitted there. Encounters own when totems
 * appear and how much they heal; see `docs/encounters/sol-heredit-facts-spec.md#totemic`.
 */

/**
 * VERIFIED to headbar resolution: all 55 totems appear on the tick their target's headbar first
 * reaches 15/30 or 14/30, never while it shows 16+. Headbar fill is `1 + floor(29 * hp / max)`
 * (RuneLite `OpponentInfoOverlay`), so 15 straddles half HP: 3 totems came at 15, 4 targets waited
 * at 15 until 14. Whether exactly half counts is unresolved; the Wiki says "50% hitpoints or below".
 */
export const TOTEMIC_HP_THRESHOLD = 0.5;
/** VERIFIED: 35 of the 36 totems alive with a hurt target at spawn+7 launched then (A:3734 did not). */
export const TOTEM_FIRST_LAUNCH_TICKS = 7;
/** VERIFIED: 17/18 consecutive launches are 6 apart; the 18th waited for its full-HP target to be hit. */
export const TOTEM_LAUNCH_INTERVAL_TICKS = 6;
/**
 * A heal lands at launch+6, the projectile's `endtime` 180, when the totem's NPC index is above its
 * target's (16/16), and at launch+5 when below (3 heals, all from one totem: A:1599/1605/1611). Size and
 * distance do not explain it (all from 1 tile; another 3x3 Javelin took +6), so server NPC processing
 * order is the likely cause. The simulator has no NPC indices. MODEL: always +6. Listed with the other
 * index-order gaps in docs/architecture/npc-behaviors.md#npc-index-order-not-modeled. Wave totems took a higher index than 180 of
 * the 189 wave NPCs alive when they appeared, but Sol's later beam crystals took lower indices than
 * his (A:4976 Sol 63273, A:5133 crystal 33430), so a Sol totem's order is unknown.
 */
export const TOTEM_HEAL_FLIGHT_TICKS = npcHitDelayFromEndTime(HEALING_TOTEM_PROJECTILE.endDelayCycles);

interface HealingTotemState {
  readonly targetId: string;
  readonly healAmount: number;
  nextLaunchTick: number;
  /** Landing ticks of heals in flight. */
  readonly arrivals: number[];
}
export type HealingTotemActor = DefinedNpcActor<HealingTotemState>;

export const healingTotemDefinition = createNpcDefinition<HealingTotemState, undefined>({
  id: 'colosseum-healing-totem',
});

/**
 * VERIFIED: the tile diagonally south-west of the target's south-west tile (52/55), or, where a
 * pillar or wall blocks it, diagonally north-east of its footprint (3/3: A:889, A:1274, A:3007).
 * SINGLE-OBSERVATION: other NPCs do not block it (A:1592 spawned on a standing thrall). UNVERIFIED:
 * with both blocked (never captured) the Wiki says only "spawning elsewhere"; this takes the free
 * tile of the ring around the footprint nearest the south-west diagonal, scanning rows from the south.
 */
export function healingTotemSpawnTile(
  target: Pick<NpcActor, 'position' | 'size'>,
  canOccupy: (tile: Coordinate) => boolean,
): Coordinate | null {
  const [x, y] = target.position;
  const size = target.size;
  const southWest: Coordinate = [x - 1, y - 1];
  const northEast: Coordinate = [x + size, y + size];
  const ring: Coordinate[] = [];
  for (let ty = y - 1; ty <= y + size; ty++) {
    for (let tx = x - 1; tx <= x + size; tx++) {
      if (tx === x - 1 || tx === x + size || ty === y - 1 || ty === y + size) ring.push([tx, ty]);
    }
  }
  const distance = (tile: Coordinate) => Math.max(Math.abs(tile[0] - southWest[0]), Math.abs(tile[1] - southWest[1]));
  const isPreferred = ([tx, ty]: Coordinate) =>
    (tx === southWest[0] && ty === southWest[1]) || (tx === northEast[0] && ty === northEast[1]);
  // Array sort is stable, so equally near tiles keep the row-by-row scan order.
  const fallback = ring.filter((tile) => !isPreferred(tile)).sort((left, right) => distance(left) - distance(right));
  return [southWest, northEast, ...fallback].find((tile) => canOccupy(tile)) ?? null;
}

export function createHealingTotem(input: {
  readonly id: string;
  readonly position: Readonly<Coordinate>;
  readonly target: Pick<NpcActor, 'id'>;
  readonly healAmount: number;
  readonly tick: number;
}): HealingTotemActor {
  const actor = createColosseumActor('healing_totem', input.id, input.position);
  // The capture faces each new totem at its target (`facing npc=...` on the add tick).
  actor.combat.targetId = input.target.id;
  return healingTotemDefinition.createActor(
    { ...actor, spawnTick: input.tick },
    {
      targetId: input.target.id,
      healAmount: input.healAmount,
      nextLaunchTick: input.tick + TOTEM_FIRST_LAUNCH_TICKS,
      arrivals: [],
    },
  );
}

/**
 * Lands heals due this tick, then launches the next one. A heal needs the totem alive when it lands
 * (none of the 33 launches whose totem was gone by then healed) and is capped at the target's missing HP
 * (A:2283+19 heals 54, A:934+37 heals 27). Launches only while the target is missing HP: A:2283's
 * totem stops at full HP, and A:934's waits from +37 to +39, when its topped-up target is hit.
 */
export function advanceHealingTotem(
  totem: HealingTotemActor,
  ctx: Pick<EncounterContext, 'tick' | 'world' | 'tickEvents'>,
): void {
  const state = totem.state;
  const target = ctx.world.getNpc(state.targetId);
  if (!totem.alive || !target?.alive) return;
  const landed = state.arrivals.filter((tick) => tick <= ctx.tick);
  state.arrivals.splice(0, landed.length);
  for (const _ of landed) {
    if (applyNpcHealing(target, state.healAmount, ctx.tickEvents) <= 0) continue;
    emitEncounterVisual(ctx.tickEvents, {
      animations: [],
      projectiles: [],
      graphics: [
        {
          spotAnimId: COLOSSEUM_SPOTANIMS.totemImpact,
          target: { kind: 'attached', actorId: target.id },
          delayCycles: 0,
          height: 0,
        },
      ],
    });
  }
  if (ctx.tick < state.nextLaunchTick || target.vitals.hp >= target.vitals.maxHp) return;
  state.nextLaunchTick = ctx.tick + TOTEM_LAUNCH_INTERVAL_TICKS;
  state.arrivals.push(ctx.tick + TOTEM_HEAL_FLIGHT_TICKS);
  emitEncounterVisual(ctx.tickEvents, {
    animations: [{ actorId: totem.id, clipId: 'attack', delayCycles: 0 }],
    graphics: [],
    projectiles: [
      { ...HEALING_TOTEM_PROJECTILE, sourcePosition: npcProjectileSource(totem), target: actorVisualTarget(target) },
    ],
  });
}
