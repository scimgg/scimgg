import { getWeaponCategory } from '../../../types/attackStyles';
import type { NpcActor } from '../../actors/NpcActor';
import type { PlayerActor } from '../../actors/PlayerActor';
import type { RicochetFlight } from '../../events/types';
import type { ResolvedAttackResources } from '../attackResources';
import type { AttackResolution, DamageAppliedInfo } from '../CombatSystem';
import type { CombatFormulaStyle } from '../formulas';
import { notifyNpcOfPlayerAttack } from '../retaliation';
import { accumulateXpDeltas, computeXpGains } from '../xp';
import type { PendingConflictionAttack } from './confliction';
import { updatePendingConflictionAttack } from './confliction';
import { captureEquipmentHitEffects } from './equipmentHitEffects';
import type { FirstPartyPlayerAttackResult } from './firstPartyPlayerAttack';
import { BLOOD_FURY_SPOTANIM, rollBloodFury } from './onHitPassives';
import type { PlayerAutoAttackDeps } from './PlayerAutoAttackSystem';
import { clearPlayerAttackIntent } from './playerAttackIntent';
import { applyOnFireSpecialAttackEffects } from './specialAttacks/postHitEffects';
import type { LaunchHeal, SpecialAttackDef, SpecialAttackEffect } from './specialAttacks/types';
import { resolveSpellHitEffects, resolveSpellLaunchHeal } from './spellHitEffects';

export interface ResolvedSupplementalPlayerTarget {
  readonly target: NpcActor;
  readonly hits: FirstPartyPlayerAttackResult['hits'];
  readonly expectedHit: number;
}

type PlayerAttackLaunchInput = {
  readonly player: PlayerActor;
  readonly target: NpcActor;
  readonly deps: PlayerAutoAttackDeps;
  readonly hits: FirstPartyPlayerAttackResult['hits'];
  readonly expectedHit: number;
  readonly supplementalTargets?: readonly ResolvedSupplementalPlayerTarget[];
  readonly formulaStyle: CombatFormulaStyle;
  readonly styleIndex: number;
  readonly finalStyle: FirstPartyPlayerAttackResult['hits'][number]['style'];
  readonly finalSpeed: number;
  readonly resources: ResolvedAttackResources;
  readonly conflictionAttack: PendingConflictionAttack | null;
  readonly spellId: string | undefined;
  /**
   * The spell-on-NPC op: the one attack that still starts on an NPC's kill tick (`canPlayerStartAttackOn`),
   * and one that ends the attack interaction once launched.
   */
  readonly manualCast: boolean;
  readonly isSpecialAttack: boolean;
  readonly specialAttackDef: SpecialAttackDef | undefined;
  readonly outgoingDamageMultiplier: number;
  readonly specialAttackDamageMultiplier: number;
  readonly selectedBranchIndex: number | null;
  readonly onLaunchEffects?: readonly SpecialAttackEffect[];
  /** Presentation of a ricocheting shot; its hops' hits are already in the targets above. */
  readonly ricochets?: readonly RicochetFlight[];
};

/**
 * Rolls every branch-scaled chance ONCE PER HITSPLAT, here at launch, off the engine's seeded
 * stream. Deferring the roll to impact would put it on `Math.random` inside `CombatSystem`, which
 * a replay cannot reconstruct; hoisting it to one roll for the whole swing would make Burning
 * barrage's three burns all-or-nothing instead of independent.
 */
function rollBranchedEffects(
  effects: readonly SpecialAttackEffect[] | undefined,
  selectedBranchIndex: number | null,
  random: () => number,
): readonly SpecialAttackEffect[] | undefined {
  if (effects === undefined) return undefined;
  return effects.filter((effect) => {
    if (effect.effect === 'poison' && effect.chancePercent !== undefined) return random() * 100 < effect.chancePercent;
    if (effect.effect !== 'burn' || effect.chancePercentByBranch === undefined) return true;
    if (selectedBranchIndex === null) return false;
    const chancePercent = effect.chancePercentByBranch[selectedBranchIndex];
    return chancePercent !== undefined && random() * 100 < chancePercent;
  });
}

export function launchPlayerAttack(input: PlayerAttackLaunchInput): void {
  const [firstHit, ...remainingHits] = input.hits;
  const random = input.deps.random ?? Math.random;
  const specialPostHitEffects = input.isSpecialAttack ? input.specialAttackDef?.postHitEffects : undefined;
  // A special attack overrides the cast it was fired from, so the two never contribute effects to
  // the same swing: a spec thrown with an autocast set still resolves as the spec.
  const rollPostHitEffects = (): readonly SpecialAttackEffect[] | undefined =>
    input.isSpecialAttack
      ? rollBranchedEffects(specialPostHitEffects, input.selectedBranchIndex, random)
      : resolveSpellHitEffects(input.spellId, random, input.player.equipment);
  const forcedMiss = isForcedMiss(input, input.target, firstHit);
  const supplementalLaunches = (input.supplementalTargets ?? []).map((supplemental) => ({
    ...supplemental,
    hpAtLaunch: supplemental.target.vitals.hp,
    forcedMisses: supplemental.hits.map((hit) => isForcedMiss(input, supplemental.target, hit)),
  }));
  const onKillEffect = input.isSpecialAttack ? input.specialAttackDef?.onKillEffect : undefined;
  const targetHpAtLaunch = input.target.vitals.hp;
  const equipmentHitEffects = captureEquipmentHitEffects(input.player.equipment, input.formulaStyle);
  const accuracySucceeded = !forcedMiss && firstHit.accurate;
  const resolveTargetHitRule = input.deps.encounterRules?.resolveTargetHitDamage;
  const resolveTargetHitDamage =
    resolveTargetHitRule === undefined
      ? undefined
      : (
          target: Readonly<NpcActor>,
          style: FirstPartyPlayerAttackResult['hits'][number]['style'],
          attackKind: FirstPartyPlayerAttackResult['hits'][number]['attackKind'],
          damage: number,
          accurate: boolean,
        ) =>
          resolveTargetHitRule(
            { target, style, attackKind, damage, accurate },
            { tick: input.deps.world.tick, player: input.player, world: input.deps.world },
          );
  const playerAttackBridge = {
    events: input.deps.tickEvents,
    infiniteHealth: input.deps.infiniteHealth,
    enablePendingHits: firstHit.impactDelayTicks > 0,
    outgoingDamageMultiplier: input.outgoingDamageMultiplier,
    specDamageMultiplier: input.specialAttackDamageMultiplier,
    ...(resolveTargetHitDamage === undefined ? {} : { resolveTargetHitDamage }),
    getAttackSpeed: () => input.finalSpeed,
    resolveAttack: (): Partial<AttackResolution> => ({
      style: firstHit.style,
      attackKind: firstHit.attackKind,
      rolledDamage: firstHit.damage,
      accuracySucceeded,
      impactDelayTicks: firstHit.impactDelayTicks,
      spellId: input.spellId,
      usingSpecialAttack: input.isSpecialAttack,
      onKillEffect,
      postHitEffects: rollPostHitEffects(),
      equipmentHitEffects,
      weaponId: input.player.equipment.weapon,
      ammoId: input.resources.kind === 'ammo' ? input.resources.ammoId : undefined,
      ammoSource: input.resources.source,
      expectedHit: input.expectedHit,
      sourceSelfDamageRatio: accuracySucceeded ? firstHit.procSelfDamageRatio : undefined,
      ...(input.ricochets === undefined ? {} : { ricochets: input.ricochets }),
    }),
    onDamageApplied: (info: DamageAppliedInfo): void => input.deps.onDamageApplied(info),
    onAttackStarted: (): void => {
      // Healing resolves HERE, on the fire tick, not on the hitsplat — see {@link LaunchHeal}. For
      // a Blood Burst/Barrage that means one heal per target the cast rolled against, all of them
      // before any of the damage lands.
      const launchHeal = input.isSpecialAttack
        ? input.specialAttackDef?.launchHeal
        : resolveSpellLaunchHeal(input.spellId);
      if (launchHeal !== undefined) {
        if (accuracySucceeded && firstHit.damage > 0) healAtLaunch(input, launchHeal, firstHit.damage);
        for (const supplemental of supplementalLaunches) {
          for (const [hitIndex, hit] of supplemental.hits.entries()) {
            if (supplemental.forcedMisses[hitIndex] !== true && hit.accurate && hit.damage > 0) {
              healAtLaunch(input, launchHeal, hit.damage);
            }
          }
        }
      }
      rollBloodFuryAtLaunch(input, [
        { hit: firstHit, landed: accuracySucceeded },
        ...remainingHits.map((hit) => ({ hit, landed: !forcedMiss && hit.accurate })),
      ]);
      if (input.onLaunchEffects && input.onLaunchEffects.length > 0) {
        applyOnFireSpecialAttackEffects(
          input.player,
          input.target,
          rollBranchedEffects(input.onLaunchEffects, input.selectedBranchIndex, random) ?? [],
          input.deps.world.tick,
        );
      }
      input.deps.onPlayerAttackStarted?.({
        tick: input.deps.world.tick,
        sourceId: input.player.id,
        targetId: input.target.id,
        attackType: firstHit.style,
        attackKind: firstHit.attackKind,
        accurate: accuracySucceeded,
        rolledDamage: firstHit.damage,
      });
    },
  };

  if (
    !input.deps.combatSystem.processAttack(input.deps.world, input.player, input.target, playerAttackBridge, {
      acceptKillTickTarget: input.manualCast,
    })
  )
    return;

  for (const supplemental of supplementalLaunches) {
    for (const [hitIndex, hit] of supplemental.hits.entries()) {
      input.deps.combatSystem.processSupplementalHitRequest(
        input.deps.world,
        {
          attacker: input.player,
          target: supplemental.target,
          attack: {
            style: hit.style,
            attackKind: hit.attackKind,
            rolledDamage: hit.damage,
            accuracySucceeded: supplemental.forcedMisses[hitIndex] !== true && hit.accurate,
            impactDelayTicks: hit.impactDelayTicks,
            spellId: input.spellId,
            usingSpecialAttack: input.isSpecialAttack,
            onKillEffect,
            // Rolled per supplemental target, so each square of a Burst/Barrage gets its own
            // independent Smoke chance and its own freeze (judged at launch) and drain eligibility.
            postHitEffects: input.isSpecialAttack
              ? input.specialAttackDef?.postHitEffects
              : resolveSpellHitEffects(input.spellId, random, input.player.equipment),
            equipmentHitEffects,
            weaponId: input.player.equipment.weapon,
            ammoId: input.resources.kind === 'ammo' ? input.resources.ammoId : undefined,
            ammoSource: input.resources.source,
            expectedHit: supplemental.expectedHit,
          },
        },
        {
          events: input.deps.tickEvents,
          infiniteHealth: input.deps.infiniteHealth,
          enablePendingHits: hit.impactDelayTicks > 0,
          outgoingDamageMultiplier: input.outgoingDamageMultiplier,
          specDamageMultiplier: input.specialAttackDamageMultiplier,
          ...(resolveTargetHitDamage === undefined ? {} : { resolveTargetHitDamage }),
          onDamageApplied: (info): void => input.deps.onDamageApplied(info),
        },
      );
    }
  }

  input.player.pendingConflictionAttack = updatePendingConflictionAttack(
    input.player.pendingConflictionAttack,
    input.conflictionAttack,
    accuracySucceeded,
  );
  // A manual cast is a single action: the attack interaction ends with it, with or without an
  // autocast set (confirmed in game), so the player neither attacks again nor walks to the target.
  // The cooldown, `lastAttackTarget` and this cast's hits are untouched.
  if (input.manualCast) clearPlayerAttackIntent(input.player);

  // One queue entry per splat, enqueued in landing order: the victim applies them in that order.
  for (const hit of remainingHits) {
    const pendingHit = input.deps.combatSystem.queuePendingHit(
      input.deps.world,
      {
        sourceId: input.player.id,
        targetId: input.target.id,
        style: hit.style,
        attackKind: hit.attackKind,
        launchTick: input.deps.world.tick,
        impactTick: input.deps.world.tick + hit.impactDelayTicks,
        rolledDamage: hit.damage,
        accuracySucceeded: !forcedMiss && hit.accurate,
        usingSpecialAttack: input.isSpecialAttack,
        onKillEffect,
        postHitEffects: rollPostHitEffects(),
        equipmentHitEffects,
        sourceSelfDamageRatio: !forcedMiss && hit.accurate ? hit.procSelfDamageRatio : undefined,
        launchDamageMultipliers: {
          incomingDamageMultiplier: undefined,
          outgoingDamageMultiplier: input.outgoingDamageMultiplier,
          specDamageMultiplier: input.specialAttackDamageMultiplier,
        },
        sourceDeathPolicy: 'persist',
      },
      {
        source: input.player,
        target: input.target,
      },
    );
    notifyNpcOfPlayerAttack(input.target, pendingHit);
  }

  emitPlayerAttackXp(input, [
    { hits: input.hits, forcedMiss, hpAtLaunch: targetHpAtLaunch },
    ...supplementalLaunches.map((supplemental) => ({
      hits: supplemental.hits,
      forcedMiss: supplemental.forcedMisses.every(Boolean),
      hpAtLaunch: supplemental.hpAtLaunch,
    })),
  ]);
}

/**
 * Amulet of blood fury, resolved on the swing tick like {@link LaunchHeal}: every captured proc heals
 * and shows its graphic on the swing, a tick before the hitsplats land (e.g. N 7572 heal, 7573
 * splats). One roll per landed hitsplat off the seeded stream, and one graphic for the whole swing.
 */
function rollBloodFuryAtLaunch(
  input: PlayerAttackLaunchInput,
  hits: readonly { readonly hit: FirstPartyPlayerAttackResult['hits'][number]; readonly landed: boolean }[],
): void {
  const random = input.deps.random ?? Math.random;
  let procced = false;
  let healed = 0;
  for (const { hit, landed } of hits) {
    if (!landed) continue;
    const heal = rollBloodFury({
      amuletId: input.player.equipment.amulet,
      attackType: hit.style,
      damage: scaledOutgoingDamage(input, hit.damage),
      roll: random,
    });
    if (heal === null) continue;
    procced = true;
    healed += heal;
  }
  if (!procced) return;
  input.player.vitals.hp = Math.min(input.player.vitals.maxHp, input.player.vitals.hp + healed);
  input.player.stats.hitpoints.current = input.player.vitals.hp;
  input.deps.tickEvents.emit({ type: 'npc_graphic_applied', targetId: input.target.id, ...BLOOD_FURY_SPOTANIM });
}

/** A hit's rolled damage scaled exactly as the hit itself will be when it lands. */
function scaledOutgoingDamage(input: PlayerAttackLaunchInput, rolledDamage: number): number {
  const outgoingDamage = Math.max(0, Math.floor(Math.floor(rolledDamage) * input.outgoingDamageMultiplier));
  return Math.max(0, Math.floor(outgoingDamage * input.specialAttackDamageMultiplier));
}

/**
 * Heals off ONE hit's rolled damage. Scales that roll exactly as the hit itself will be scaled, so
 * an encounter that damps outgoing damage damps the leech with it rather than paying out on a
 * number the target never takes.
 */
function healAtLaunch(input: PlayerAttackLaunchInput, heal: LaunchHeal, rolledDamage: number): void {
  if (input.player.vitals.hp >= input.player.vitals.maxHp) return;
  const scaledDamage = scaledOutgoingDamage(input, rolledDamage);
  const healed = Math.max(heal.minimumHeal, Math.floor((scaledDamage * heal.percentOfDamage) / 100));
  input.player.vitals.hp = Math.min(input.player.vitals.maxHp, input.player.vitals.hp + healed);
  input.player.stats.hitpoints.current = input.player.vitals.hp;
}

function isForcedMiss(
  input: PlayerAttackLaunchInput,
  target: NpcActor,
  hit: FirstPartyPlayerAttackResult['hits'][number],
): boolean {
  return (
    input.deps.encounterRules?.validateAttack?.(hit.attackKind, target.id, {
      tick: input.deps.world.tick,
      player: input.player,
      world: input.deps.world,
    }) === false
  );
}

interface XpTargetProjection {
  readonly hits: FirstPartyPlayerAttackResult['hits'];
  readonly forcedMiss: boolean;
  readonly hpAtLaunch: number;
}

function emitPlayerAttackXp(input: PlayerAttackLaunchInput, targets: readonly XpTargetProjection[]): void {
  const xpDamage = targets.reduce((castTotal, target) => {
    let projectedHpLost = 0;
    const targetDamage = target.hits.reduce((targetTotal, hit) => {
      if (target.forcedMiss || !hit.accurate) return targetTotal;
      const rolledDamage = Math.max(1, Math.max(0, Math.floor(hit.damage)));
      const outgoingDamage = Math.max(0, Math.floor(rolledDamage * input.outgoingDamageMultiplier));
      const scaledDamage = Math.max(0, Math.floor(outgoingDamage * input.specialAttackDamageMultiplier));
      const remainingHp = Math.max(0, target.hpAtLaunch - projectedHpLost);
      const appliedDamage = Math.min(scaledDamage, remainingHp);
      projectedHpLost += appliedDamage;
      return targetTotal + appliedDamage;
    }, 0);
    return castTotal + targetDamage;
  }, 0);
  if (xpDamage === 0) return;

  const styles = getWeaponCategory(input.player.equipment.weapon).styles;
  const combatStyle = (styles[input.styleIndex] ?? styles[0]).combatStyle;
  const deltas = accumulateXpDeltas(input.player.xpCounters, computeXpGains(input.finalStyle, combatStyle, xpDamage));
  if (deltas.length > 0) {
    input.deps.tickEvents.emit({ type: 'xp_drop', skills: deltas, predictedHit: xpDamage });
  }
}
