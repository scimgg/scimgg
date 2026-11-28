import { npcHitDelayFromEndTime } from '../../core/combat/hitDelay';
import { type AttackPlan, resolveAttackRequest } from '../../core/combat/npcAttackRequest';
import type { EnvironmentalDamage, NpcAttackRequest } from '../../core/encounters/types';
import {
  type EncounterClipCue,
  type EncounterGraphicCue,
  emitEncounterVisual,
  type NpcProjectileCue,
} from '../../core/events/encounterVisual';
import { canNpcActThisTurn } from '../../core/npcDeath';
import { createNpcDefinition, type DefinedNpcActor, type NpcDefinitionContext } from '../../core/npcs';
import type { Coordinate } from '../../types/simulation';
import { actorVisualTarget, npcProjectileSource } from '../projectileCue';
import {
  type ColossusActorInput,
  canColossusLaunch,
  createColossusActor,
  moveColossus,
  scheduleColossusAttack,
} from './colossusReach';
import { COLOSSEUM_SPOTANIMS, type ColosseumRelentlessRank } from './constants';
import { withRelentlessDefence, withRelentlessPlan } from './relentless';

/**
 * Fortis Colosseum Javelin Colossus. Capture facts and labels: `docs/encounters/fortis-colosseum-facts-spec.md`
 * §6.2 and §6.6; stats are the Wiki infobox (/w/Javelin_Colossus?oldid=15411467) as synced into `monsters.json`.
 *
 * Wave-owner contract: route `move`/`tick` as for any definition, call {@link landJavelinArtillery} once per
 * tick for every registered javelin actor, dying or not, from `resolveHazards`, and remove it
 * `JAVELIN_DEATH_TO_REMOVAL_TICKS` after its `deathAnimationTick`.
 */
export const JAVELIN_COLOSSUS_NPC_ID = 12817; // COLOSSEUM_JAVELIN_COLOSSUS

/** RuneLite gameval names; idle and walk are the cache NpcType's (rev 232). */
export const JAVELIN_COLOSSUS_SEQS = {
  idle: 10889, // NPC_COLOSSI_JAVELIN_01_IDLE
  walk: 10879, // NPC_COLOSSI_JAVELIN_WALK
  attack: 10892, // NPC_COLOSSI_JAVELIN_01_RANGE_ATTACK, every ranged throw (370)
  artillery: 10893, // NPC_COLOSSI_JAVELIN_01_ARTILLERY_ATTACK, every artillery cast (74)
  death: 10894, // NPC_COLOSSI_JAVELIN_01_DEATH
} as const;

export const JAVELIN_COLOSSUS_SPOTANIMS = {
  javelin: COLOSSEUM_SPOTANIMS.javelinSpearhead,
  artilleryFire: COLOSSEUM_SPOTANIMS.javelinArtilleryFire, // A:865
  artillerySlow: COLOSSEUM_SPOTANIMS.javelinArtilleryFalling,
  artilleryShadow: COLOSSEUM_SPOTANIMS.javelinArtilleryShadow, // map_anim beside the falling javelin
  artilleryBlast: COLOSSEUM_SPOTANIMS.javelinArtilleryBlast, // map_anim at T+6
} as const;

/** VERIFIED: removed three ticks after the death sequence starts (32/32). Removal belongs to the wave owner. */
export const JAVELIN_DEATH_TO_REMOVAL_TICKS = 3;

/** VERIFIED: every fifth attack is the artillery (R R R R A in 34/34 instances; Wiki "every five attacks"). */
export const JAVELIN_ATTACKS_PER_ARTILLERY = 5;

/** VERIFIED: 370/370 ranged projectiles carry these fields at every distance 1..15 (A:842). */
export const JAVELIN_PROJECTILE = {
  spotAnimId: JAVELIN_COLOSSUS_SPOTANIMS.javelin,
  startDelayCycles: 58,
  endDelayCycles: 90,
  slope: 16,
  startOffset: 0,
  startHeight: 200,
  endHeight: 138,
} as const satisfies Omit<NpcProjectileCue, 'sourcePosition' | 'target'>;

/** VERIFIED: cast seq and NPC spotanim 2676 `delay=60` on the cast tick (A:865; 70/74, the rest slot-displaced). */
const ARTILLERY_FIRE_DELAY_CYCLES = 60;
/** VERIFIED (74/74): the target is the player's tile at the start of T+2 (A:1811 (21,42), not T's (22,41)). */
export const ARTILLERY_TARGET_TICKS = 2;
/**
 * VERIFIED: the shadow and falling javelin arrive as map_anims on T+3 with `delay=30` (A 37/37, B 15/15,
 * C 22/22). They are emitted from the T+2 turn that takes the target, 60 cycles out: the same client
 * moment, and it keeps the witnessed death on T+3 (A:915, killed and death sequence A:918), whose shadow
 * was still sent, while a death processed on T+2 (B:2559, death sequence B:2561) sends none.
 */
const ARTILLERY_WARNING_DELAY_CYCLES = 60;
/**
 * CAPTURE-FIT (n=4): the falling javelin is the colossus's until its T+3 turn releases it; a death before
 * then cancels the landing (A:915, killed on T+3: shadow, no blast; B:2559), a later one does not (A:2124
 * and C:3359, both killed on T+5, still blast on T+6). T+4 would fit as well.
 */
export const ARTILLERY_RELEASE_TICKS = 3;
/** VERIFIED: the blast map_anim 2265 lands on T+6 on the same single tile, no delay (A:865 → A:871). */
export const ARTILLERY_LANDING_TICKS = 6;
/**
 * WIKI-ONLY (/w/Fortis_Colosseum/Strategies?oldid=15414089): "up to 40 typeless damage", ignoring Protect
 * from Missiles. No captured cast damaged the player (0/74). POLICY: one uniform 0..40 roll with no accuracy
 * check, not raised by Relentless (as Sol's typeless area hits are not), on a 1×1 check of the player's
 * start-of-T+6 tile, the only window consistent with every captured miss (open question C2).
 */
export const ARTILLERY_MAX_HIT = 40;
/** The environmental damage source, so modifiers (Doom's two stacks, Wiki) can tell it apart. */
export const JAVELIN_ARTILLERY_SOURCE = 'JavelinArtillery';

/** VERIFIED: the splat lands launch+3 at every distance (A 173/173, C 121/121) = `npcHitDelayFromEndTime(90)`. */
const RANGED_PLAN = {
  formulaStyle: 'ranged',
  damageType: 'range',
  attackKind: 'range_arrow',
  impactDelayTicks: npcHitDelayFromEndTime(JAVELIN_PROJECTILE.endDelayCycles),
  // Wiki infobox; observed unprayed max 46 (A:3874) over 9 samples.
  maxHit: 48,
  // VERIFIED: thrown javelins land after the colossus dies (B:1995 → 1998, C:2732 → 2735).
  sourceDeathPolicy: 'persist',
  // Protection is read at launch (the default): 25/25 prayed at launch and off on landing were 0, and
  // 3/3 the reverse hit (A:2651 → 2654 35).
} as const satisfies AttackPlan;

type Artillery =
  | { readonly phase: 'aiming'; readonly castTick: number }
  | { readonly phase: 'falling' | 'released'; readonly castTick: number; readonly target: Coordinate };

interface JavelinColossusState {
  /** Attacks launched this life, artillery included: the RRRRA counter survives line-of-sight gaps (A:842 → A:1029). */
  attacksLaunched: number;
  artillery: Artillery | null;
  readonly relentless: ColosseumRelentlessRank;
}
export type JavelinColossusActor = DefinedNpcActor<JavelinColossusState>;

/** The artillery steps the colossus itself takes in its turn: aiming on T+2, releasing on T+3. */
function advanceArtillery(
  actor: JavelinColossusActor,
  context: NpcDefinitionContext,
  graphics: EncounterGraphicCue[],
): void {
  const { tick } = context;
  const aiming = actor.state.artillery;
  if (aiming?.phase === 'aiming' && tick >= aiming.castTick + ARTILLERY_TARGET_TICKS) {
    const player = context.world.getPlayer();
    // A turn missed on T+2 (or no living player) leaves nothing to aim at.
    if (tick > aiming.castTick + ARTILLERY_TARGET_TICKS || !player?.alive) {
      actor.state.artillery = null;
      return;
    }
    const target: Coordinate = [player.position[0], player.position[1]];
    actor.state.artillery = { phase: 'falling', castTick: aiming.castTick, target };
    for (const spotAnimId of [JAVELIN_COLOSSUS_SPOTANIMS.artilleryShadow, JAVELIN_COLOSSUS_SPOTANIMS.artillerySlow]) {
      graphics.push({
        spotAnimId,
        target: { kind: 'tile', position: target },
        delayCycles: ARTILLERY_WARNING_DELAY_CYCLES,
        height: 0,
      });
    }
  }
  const falling = actor.state.artillery;
  if (falling?.phase === 'falling' && tick >= falling.castTick + ARTILLERY_RELEASE_TICKS) {
    actor.state.artillery = { ...falling, phase: 'released' };
  }
}

/**
 * A released javelin landing on T+6: the blast on its tile, and the hit when the player's start-of-tick tile
 * is that tile. Called by the wave owner from `resolveHazards` each tick for every registered javelin actor,
 * because the colossus may have died since releasing it and so has no turn of its own.
 */
export function landJavelinArtillery(
  actor: JavelinColossusActor,
  context: Pick<NpcDefinitionContext, 'tick' | 'world' | 'tickEvents' | 'random'>,
): EnvironmentalDamage[] {
  const { artillery } = actor.state;
  if (artillery?.phase !== 'released' || context.tick < artillery.castTick + ARTILLERY_LANDING_TICKS) return [];
  actor.state.artillery = null;
  const { target } = artillery;
  emitEncounterVisual(context.tickEvents, {
    animations: [],
    projectiles: [],
    graphics: [
      {
        spotAnimId: JAVELIN_COLOSSUS_SPOTANIMS.artilleryBlast,
        target: { kind: 'tile', position: target },
        delayCycles: 0,
        height: 0,
      },
    ],
  });
  const player = context.world.getPlayer();
  if (!player?.alive || player.position[0] !== target[0] || player.position[1] !== target[1]) return [];
  return [
    {
      baseDamage: Math.floor(context.random() * (ARTILLERY_MAX_HIT + 1)),
      attackType: 'typeless',
      source: JAVELIN_ARTILLERY_SOURCE,
      playerPosition: [target[0], target[1]],
    },
  ];
}

export const javelinColossusDefinition = createNpcDefinition<JavelinColossusState, undefined>({
  id: 'colosseum-javelin-colossus',
  /**
   * CAPTURE-FIT (32/32 deaths): the death sequence starts on the killing tick when another hit is serviced
   * after the lethal one (A:918 [1, 0, 3, 0]) and a tick later otherwise (A:2249 → 2250), the queued rule.
   * Its killing-tick turn launches nothing (`canColossusLaunch`).
   */
  deathPolicy: 'queued',
  move: ({ actor, context }) => moveColossus(actor, context),
  tick: ({ actor, context }) => {
    const { tick } = context;
    if (!canNpcActThisTurn(actor, tick)) return { environmentalDamages: [] };
    const player = context.world.getPlayer();
    const animations: EncounterClipCue[] = [];
    const graphics: EncounterGraphicCue[] = [];
    const projectiles: NpcProjectileCue[] = [];
    const npcAttacks: NpcAttackRequest[] = [];
    advanceArtillery(actor, context, graphics);
    if (canColossusLaunch(actor, player, tick)) {
      scheduleColossusAttack(actor, tick);
      actor.state.attacksLaunched += 1;
      if (actor.state.attacksLaunched % JAVELIN_ATTACKS_PER_ARTILLERY === 0) {
        actor.state.artillery = { phase: 'aiming', castTick: tick };
        animations.push({ actorId: actor.id, clipId: 'artillery', delayCycles: 0 });
        graphics.push({
          spotAnimId: JAVELIN_COLOSSUS_SPOTANIMS.artilleryFire,
          target: { kind: 'attached', actorId: actor.id },
          delayCycles: ARTILLERY_FIRE_DELAY_CYCLES,
          height: 0,
        });
      } else {
        const { relentless } = actor.state;
        const attack = resolveAttackRequest({
          attacker: actor,
          target: relentless === 0 ? player : withRelentlessDefence(player, relentless),
          plan: relentless === 0 ? RANGED_PLAN : withRelentlessPlan(RANGED_PLAN, relentless),
          random: context.random,
        });
        if (attack === null) throw new TypeError(`Missing formula stats for ${actor.id}`);
        npcAttacks.push(attack);
        animations.push({ actorId: actor.id, clipId: 'attack', delayCycles: 0 });
        // VERIFIED: it flies from the post-move center to the player's start-of-tick tile (370/370).
        projectiles.push({
          ...JAVELIN_PROJECTILE,
          sourcePosition: npcProjectileSource(actor),
          target: actorVisualTarget(player),
        });
      }
    }
    emitEncounterVisual(context.tickEvents, { animations, graphics, projectiles });
    return { environmentalDamages: [], ...(npcAttacks.length > 0 ? { npcAttacks } : {}) };
  },
  // Death processing cancels an artillery it has not released yet (`ARTILLERY_RELEASE_TICKS`).
  onDeathStarted: ({ actor }) => {
    if (actor.state.artillery?.phase !== 'released') actor.state.artillery = null;
  },
});

export function createJavelinColossus(
  input: ColossusActorInput & {
    /** The run's Relentless tier; omitted means the modifier is off. */
    readonly relentless?: ColosseumRelentlessRank;
  },
): JavelinColossusActor {
  const actor = createColossusActor(input, {
    npcTypeId: JAVELIN_COLOSSUS_NPC_ID,
    archetypeId: 'colosseum_javelin_colossus',
    attackStyle: 'range',
    seqs: JAVELIN_COLOSSUS_SEQS,
  });
  return javelinColossusDefinition.createActor(actor, {
    attacksLaunched: 0,
    artillery: null,
    relentless: input.relentless ?? 0,
  });
}
