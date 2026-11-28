import { isNpcFreezeImmune, type NpcActor, setNpcDefenceDrain } from '../../../actors/NpcActor';
import type { PlayerActor } from '../../../actors/PlayerActor';
import { layBurnStack } from '../../burnStacks';
import { applyNpcPoison } from '../../npcPoison';
import type { SpecialAttackEffect } from './types';

export function applySpecialAttackEffects(
  player: PlayerActor,
  target: NpcActor,
  damage: number,
  effects: readonly SpecialAttackEffect[],
  tick: number,
): void {
  applyEffects(player, target, damage, effects, tick, 'on-hit');
}

export function applyOnFireSpecialAttackEffects(
  player: PlayerActor,
  target: NpcActor,
  effects: readonly SpecialAttackEffect[],
  tick: number,
): void {
  applyEffects(player, target, 0, effects, tick, 'on-fire');
}

/**
 * Whether an effect rides a hit that CONNECTED, rather than one that dealt damage.
 *
 * The two are not the same for a player cast. `CombatSystem` floors an accurate roll to 1 BEFORE
 * it applies `outgoingDamageMultiplier`, so an encounter that damps outgoing damage turns a landed
 * 1 into a 0 and would silently cancel these. /w/Shadow_spells and /w/Ice_spells both key off the
 * spell hitting, so they must survive that; Smoke's poison explicitly needs a DAMAGING hit, and
 * every other special-attack effect keeps its damage requirement.
 */
export function appliesOnAccurateHit(effect: SpecialAttackEffect): boolean {
  return (
    effect.effect === 'drain_attack' ||
    effect.effect === 'freeze' ||
    effect.effect === 'weaken' ||
    effect.effect === 'condemn'
  );
}

/**
 * Only `bind` reads this, and only to decide whether freeze immunity applies to it.
 *
 * OSRS runs binds and freezes off one immunity, so a Zamorak godsword landing on a frozen target
 * must be refused exactly as a second Ice spell would be. Scorching shackles are exempt: they are
 * SCHEDULED at launch with their own refresh policy (see {@link SpecialAttackDef.onFireEffects}),
 * and subjecting a reservation to a window that has not started yet would reject binds the capture
 * says land.
 */
type EffectTiming = 'on-hit' | 'on-fire';

const STAT_DRAIN_EFFECTS = new Set<SpecialAttackEffect['effect']>([
  'weaken',
  'condemn',
  'drain_defence',
  'drain_magic',
  'drain_attack',
]);

function applyEffects(
  player: PlayerActor,
  target: NpcActor,
  damage: number,
  effects: readonly SpecialAttackEffect[],
  tick: number,
  timing: EffectTiming,
): void {
  if (!target.debuffs) target.debuffs = {};

  for (const effect of effects) {
    if (target.formulaStats?.statDrainImmune && STAT_DRAIN_EFFECTS.has(effect.effect)) continue;
    switch (effect.effect) {
      case 'weaken': {
        // /w/Emberlight#Special_attack: additive drains from BASE levels, even on an accurate zero.
        const percent = target.formulaStats?.attributes?.includes('demon') ? 15 : 5;
        const levels = target.formulaStats?.levels;
        target.debuffs.attackDrain =
          (target.debuffs.attackDrain ?? 0) + Math.floor(((levels?.attack ?? 1) * percent) / 100) + 1;
        target.debuffs.strengthDrain =
          (target.debuffs.strengthDrain ?? 0) + Math.floor(((levels?.strength ?? 1) * percent) / 100) + 1;
        setNpcDefenceDrain(
          target,
          (target.debuffs.defenceDrain ?? 0) + Math.floor(((levels?.defence ?? 1) * percent) / 100) + 1,
        );
        break;
      }
      case 'condemn': {
        // /w/Accursed_sceptre#Special_attack: does not stack or undo a stronger existing drain.
        setNpcDefenceDrain(
          target,
          Math.max(
            target.debuffs.defenceDrain ?? 0,
            Math.floor(((target.formulaStats?.levels.defence ?? 1) * 15) / 100),
          ),
        );
        target.debuffs.magicDrain = Math.max(
          target.debuffs.magicDrain ?? 0,
          Math.floor(((target.formulaStats?.levels.magic ?? 1) * 15) / 100),
        );
        break;
      }
      case 'heal_hp': {
        const heal = Math.max(effect.minimumHeal ?? 10, Math.floor((damage * effect.percentOfDamage) / 100));
        player.vitals.hp = Math.min(player.vitals.maxHp, player.vitals.hp + heal);
        player.stats.hitpoints.current = player.vitals.hp;
        break;
      }
      case 'restore_prayer': {
        const restore = Math.max(5, Math.floor((damage * effect.percentOfDamage) / 100));
        player.prayerState.points = Math.min(player.prayerState.maxPoints, player.prayerState.points + restore);
        player.stats.prayer.current = player.prayerState.points;
        break;
      }
      case 'drain_defence': {
        if (effect.flat) {
          setNpcDefenceDrain(target, (target.debuffs.defenceDrain ?? 0) + damage);
        } else if (effect.percent) {
          const drain = drainOfCurrentLevel(
            target.formulaStats?.levels.defence ?? 1,
            target.debuffs.defenceDrain ?? 0,
            effect.percent,
          );
          setNpcDefenceDrain(target, (target.debuffs.defenceDrain ?? 0) + drain);
        }
        break;
      }
      case 'drain_magic': {
        const drain = effect.base + Math.floor((damage * effect.percentOfDamage) / 100);
        target.debuffs.magicDrain = (target.debuffs.magicDrain ?? 0) + drain;
        break;
      }
      case 'drain_attack': {
        // /w/Shadow_spells: refused outright once Attack is already down rather than stacking
        // toward zero. Keyed to Attack alone — a Defence or Magic drain from another source is a
        // different stat and must not block this.
        if (target.debuffs.attackDrain) break;
        target.debuffs.attackDrain = drainOfCurrentLevel(target.formulaStats?.levels.attack ?? 1, 0, effect.percent);
        break;
      }
      case 'poison': {
        applyNpcPoison({ target, sourceId: player.id, severity: effect.severity, tick });
        break;
      }
      case 'freeze': {
        // `tick` is the attack's LAUNCH tick (`CombatSystem.applyFreezeAtLaunch`, or an on-fire
        // effect). The target holds for `durationTicks` ticks starting the tick after: Burst targets
        // first move again at cast + 17, Barrage at cast + 33 (cast + 36 with a sceptre's 35) in
        // inferno-waves-1-68 and the ToB captures.
        // Covers both halves of /w/Ice_spells' rule, judged on the launch tick: a live freeze cannot
        // be refreshed, and the target stays immune for five ticks after one ends (captured casts on
        // the thaw tick and the tick after it freeze nothing: inferno-waves-1-68 t5661, t6422).
        if (isNpcFreezeImmune(target, tick)) break;
        const resistance = target.formulaStats?.freezeResistance ?? 0;
        const durationTicks = Math.floor((effect.durationTicks * Math.max(0, 100 - resistance)) / 100);
        if (durationTicks <= 0) break;
        target.debuffs.boundFromTick = tick + 1;
        target.debuffs.boundUntilTick = tick + 1 + durationTicks;
        break;
      }
      case 'bind': {
        // A bind landing ON a hit is a freeze and answers to the shared immunity, or a Zamorak
        // godsword could refresh a live Ice freeze by extending its window, and re-bind during the
        // five ticks an Ice thaw is supposed to protect.
        if (timing === 'on-hit' && isNpcFreezeImmune(target, tick)) break;
        const from = tick + (effect.delayTicks ?? 0);
        const until = from + effect.durationTicks;
        const existingFrom = target.debuffs.boundFromTick;
        const existingUntil = target.debuffs.boundUntilTick;
        const overlaps = existingUntil !== undefined && (existingFrom ?? 0) <= until && from <= existingUntil;
        target.debuffs.boundFromTick = overlaps ? Math.min(existingFrom ?? 0, from) : from;
        target.debuffs.boundUntilTick = overlaps ? Math.max(existingUntil, until) : until;
        break;
      }
      case 'burn': {
        layBurnStack({
          target,
          sourceId: player.id,
          origin: 'special-attack',
          severity: effect.severity,
          pulses: effect.pulses,
          tick,
          firstPulseDelayTicks: effect.firstPulseDelayTicks,
        });
        break;
      }
      default:
        assertNever(effect);
    }
  }
}

function drainOfCurrentLevel(baseLevel: number, existingDrain: number, percent: number): number {
  return Math.floor((Math.max(0, baseLevel - existingDrain) * percent) / 100);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled special attack effect: ${JSON.stringify(value)}`);
}
