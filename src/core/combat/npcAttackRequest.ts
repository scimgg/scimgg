import type { NpcActor } from '../actors/NpcActor';
import type { PlayerActor } from '../actors/PlayerActor';
import type { DamageType } from '../actors/types';
import { type DecisionRandom, generatorDecisionRandom } from '../decisionRandom';
import type { NpcAttackRequest } from '../encounters/types';
import type { AttackKind } from '../events/types';
import { canNpcActThisTurn, canReceiveNewAttack } from '../npcDeath';
import { npcFootprintsOverlap } from '../npcOccupancy';
import type { PrayerCheckTiming, SourceDeathPolicy } from './CombatSystem';
import { isFootprintInAttackRange } from './distance';
import {
  type CombatFormulaStyle,
  lookupPrayerMultipliersFromState,
  type NpcFormulaActor,
  type PlayerFormulaActor,
} from './formulas';
import { calculateProjectileEndTime, npcHitDelayFromEndTime, type ProjAnimTiming } from './hitDelay';
import { type NpcAttackDecisions, resolveNpcAttack } from './npcAttackResolution';
import { selectedCombatStance } from './playerStance';

/**
 * Chebyshev distance OSRS uses when it computes a projectile's flight time: from the
 * ATTACKER's center tile to the TARGET's south-west base tile.
 *
 * The asymmetry is real and packet-proven. Jal-Zek's endtime is exactly
 * `28 + 8 * chebyshev(magerCentre, targetBase)`:
 *   - target base  -> 105/105 casts in `inferno-waves-69-zuk-packet-data.txt`
 *   - target center ->  89/105 (it fails on precisely the 16 casts aimed at the 3x3
 *     Ancestral Glyph, the only multi-tile target anything shoots at)
 * A raw SW-corner distance on the ATTACKER side matches 0/105, so the attacker really
 * does use its center. Single-tile targets make the two bases identical, which is why
 * every player-targeted sample agrees either way.
 */
export function projectileDistance(attacker: NpcActor, target: PlayerActor | NpcActor): number {
  const ax = attacker.position[0] + Math.floor(attacker.size / 2);
  const ay = attacker.position[1] + Math.floor(attacker.size / 2);
  return Math.max(Math.abs(ax - target.position[0]), Math.abs(ay - target.position[1]));
}

/**
 * The one timing rule for an NPC's projectile, onto the player or another NPC: it lands
 * `floor(endTime / 30)` ticks after launch, whatever order the two take their turns in.
 *
 * The receiver's place in the turn order is accounted for exactly once, by the hit queue: the hit
 * lands in the receiver's own turn on its impact tick. Both observed orders agree on the delay:
 * - target processed AFTER the attacker (NPC→player, see `npcHitDelayFromEndTime`);
 * - target processed BEFORE the attacker: Jal-Zek (index 46913) onto the glyph (46150),
 *   capture inferno-waves-69-zuk-packet-data.txt — endtime 140 at t104 lands t108, 108 at t108
 *   lands t111, 84 at t112 lands t114.
 * Player attacks are the exception (`hitDelayFromEndTime`, one tick later); they are not NPC producers.
 */
export function npcProjectileHitDelay(
  attacker: NpcActor,
  target: PlayerActor | NpcActor,
  projectile: ProjAnimTiming,
): number {
  return npcHitDelayFromEndTime(calculateProjectileEndTime(projectile, projectileDistance(attacker, target)));
}

export type AttackPlan = {
  readonly formulaStyle: CombatFormulaStyle;
  readonly damageType: DamageType;
  readonly attackKind: AttackKind;
  /** Used only when `projectile` is absent. */
  readonly impactDelayTicks: number;
  /** When set, the impact delay is derived from the flight distance instead. */
  readonly projectile?: ProjAnimTiming;
  /**
   * Ticks between the attack ANIMATION and the moment the attack is released (the
   * projectile leaves, or the ground telegraph lands). Added on top of the flight
   * time, so the total impact delay is `windupTicks + flight`.
   *
   * Most Zuk-wave mobs release on their animation tick and leave this at 0. JalTok-Jad
   * is the exception: both captures show a 3-tick gap between `jaltokjad_attack_*` and
   * the outgoing projectile record or `map_anim`.
   */
  readonly windupTicks?: number;
  /**
   * When the protection-prayer check runs for this attack. Omit for the OSRS default
   * (`'launch'`) — see {@link import('../encounters/types').NpcAttackRequest.prayerCheckAt}.
   */
  readonly prayerCheckAt?: PrayerCheckTiming;
  readonly maxHit?: number;
  readonly alwaysHits?: boolean;
  /** Required so every profile states it from evidence. See {@link SourceDeathPolicy}. */
  readonly sourceDeathPolicy: SourceDeathPolicy;
};

/** Labels the accuracy and damage draws (`npc.attack.*`) on `decisions`, which must share `random`'s stream. */
export type NpcAttackDecisionSource = {
  readonly decisions: DecisionRandom;
  readonly tick: number;
};

type AttackResolutionInput = {
  readonly attacker: NpcActor;
  readonly target: PlayerActor | NpcActor;
  readonly plan: AttackPlan;
  readonly random: () => number;
  readonly labelled?: NpcAttackDecisionSource;
};

export function resolveAttackRequest(input: AttackResolutionInput): NpcAttackRequest | null {
  const { attacker, target, plan, random } = input;
  const formulaAttacker = npcFormulaActor(attacker);
  if (!formulaAttacker) return null;
  const labelled = input.labelled
    ? {
        labelled: {
          decisions: input.labelled.decisions,
          key: { tick: input.labelled.tick, actorId: attacker.id, targetId: target.id },
        },
      }
    : {};
  const roll =
    target.kind === 'player'
      ? resolveNpcAttack({
          attacker: formulaAttacker,
          target: playerFormulaActor(target),
          targetEquipmentStats: target.equipmentStats,
          targetPrayerMultipliers: lookupPrayerMultipliersFromState(target.activePrayer, target.boostPrayers),
          style: plan.formulaStyle,
          random,
          ...labelled,
          ...(plan.maxHit === undefined ? {} : { maxHitOverride: plan.maxHit }),
        })
      : resolveNpcTarget({
          attacker: formulaAttacker,
          target,
          style: plan.formulaStyle,
          random,
          ...labelled,
          ...(plan.maxHit === undefined ? {} : { maxHitOverride: plan.maxHit }),
        });
  if (!roll) return null;
  return {
    attackerId: attacker.id,
    targetId: target.id,
    style: plan.damageType,
    attackKind: plan.attackKind,
    rolledDamage: roll.rolledDamage,
    accuracySucceeded: plan.alwaysHits === true || roll.accuracySucceeded,
    impactDelayTicks:
      (plan.windupTicks ?? 0) +
      (plan.projectile ? npcProjectileHitDelay(attacker, target, plan.projectile) : plan.impactDelayTicks),
    ...(plan.prayerCheckAt === undefined ? {} : { prayerCheckAt: plan.prayerCheckAt }),
    sourceDeathPolicy: plan.sourceDeathPolicy,
  };
}

export function canNpcAttack(
  attacker: NpcActor,
  target: PlayerActor | NpcActor,
  /** Reach depends only on the plan's shape, so an unclassified profile (Jad's, before release) can ask. */
  plan: Omit<AttackPlan, 'sourceDeathPolicy'>,
): boolean {
  return (
    !attacker.combat.startedTurnOverlappingTarget &&
    hasNpcAttackReach(attacker, target, plan.damageType === 'melee' ? 1 : attacker.combat.attackRange)
  );
}

export type WeightedNpcAttack = {
  readonly plan: AttackPlan;
  readonly weight: number;
};

/** Call after action readiness. Weights belong to the species, not the combat service. */
export function selectNpcAttack<T extends WeightedNpcAttack>(input: {
  readonly attacker: NpcActor;
  readonly target: PlayerActor | NpcActor;
  readonly choices: readonly T[];
  readonly random: () => number;
  /** Labels the draw `npc.attack.select`; must share `random`'s stream. */
  readonly decisions?: DecisionRandom;
  /** The tick it would act on: a queued NPC killed this tick may still act. */
  readonly tick: number;
}): T | null {
  const { attacker, target, choices, random } = input;
  if (!canNpcActThisTurn(attacker, input.tick) || !canReceiveNewAttack(target)) return null;
  const eligible = choices.filter((choice) => choice.weight > 0 && canNpcAttack(attacker, target, choice.plan));
  // A lone eligible attack is not drawn for.
  if (eligible.length <= 1) return eligible[0] ?? null;
  const decisions = input.decisions ?? generatorDecisionRandom(random);
  return decisions.choose(
    { site: 'npc.attack.select', tick: input.tick, actorId: attacker.id, targetId: target.id },
    eligible.map((choice) => ({ value: choice, weight: choice.weight })),
  );
}

export function hasNpcAttackReach(
  attacker: Pick<NpcActor, 'position' | 'size' | 'combat'>,
  target: Pick<NpcActor, 'position' | 'size'>,
  range: number,
): boolean {
  if (range <= 0 || npcFootprintsOverlap(attacker, target)) return false;
  // NPC LOS runs target-to-attacker: docs/architecture/npc-combat-movement.md#movement-evidence.
  return isFootprintInAttackRange(
    { southWest: target.position, width: target.size, height: target.size },
    { southWest: attacker.position, width: attacker.size, height: attacker.size },
    { attackRange: range, checkCollision: true, meleeReach: attacker.combat.meleeReach },
  );
}

export function isNpcInMeleeRange(attacker: NpcActor, target: PlayerActor | NpcActor): boolean {
  return isFootprintInAttackRange(
    { southWest: attacker.position, width: attacker.size, height: attacker.size },
    { southWest: target.position, width: target.size, height: target.size },
    { attackRange: 1, checkCollision: true },
  );
}

function resolveNpcTarget(input: {
  readonly attacker: NpcFormulaActor;
  readonly target: NpcActor;
  readonly style: CombatFormulaStyle;
  readonly random: () => number;
  readonly labelled?: NpcAttackDecisions;
  readonly maxHitOverride?: number;
}) {
  const formulaTarget = npcFormulaActor(input.target);
  return formulaTarget
    ? resolveNpcAttack({
        attacker: input.attacker,
        target: formulaTarget,
        style: input.style,
        random: input.random,
        ...(input.labelled ? { labelled: input.labelled } : {}),
        ...(input.maxHitOverride === undefined ? {} : { maxHitOverride: input.maxHitOverride }),
      })
    : null;
}

export function npcFormulaActor(npc: Pick<NpcActor, 'npcTypeId' | 'formulaStats' | 'debuffs'>): NpcFormulaActor | null {
  if (!npc.formulaStats) return null;
  const { levels } = npc.formulaStats;
  const actor = {
    kind: 'npc',
    id: npc.npcTypeId,
    ...npc.formulaStats,
    // Shadow spells drain the stat this NPC ATTACKS with, so the drain has to reach the roll from
    // here; `resolveTarget` in playerAttackRuntime.ts is the defensive half and covers Defence and
    // Magic drains against the player's own rolls.
    levels: {
      ...levels,
      attack: Math.max(0, levels.attack - (npc.debuffs?.attackDrain ?? 0)),
      strength: Math.max(0, levels.strength - (npc.debuffs?.strengthDrain ?? 0)),
      magic: Math.max(0, levels.magic - (npc.debuffs?.magicDrain ?? 0)),
      defence: Math.max(0, levels.defence - (npc.debuffs?.defenceDrain ?? 0)),
    },
  } satisfies NpcFormulaActor;
  return actor;
}

export function playerFormulaActor(
  player: Pick<PlayerActor, 'stats' | 'equipment' | 'selectedAttackStyleIndex'>,
): PlayerFormulaActor {
  return {
    kind: 'player',
    levels: {
      attack: player.stats.attack.current,
      strength: player.stats.strength.current,
      defence: player.stats.defence.current,
      ranged: player.stats.ranged.current,
      magic: player.stats.magic.current,
    },
    stance: selectedCombatStance(player),
  };
}
