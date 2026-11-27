import { getSpecialAttackDef } from '../../core/combat/player/specialAttacks/registry';
import { type AttackKind, isCoreEvent } from '../../core/events/types';
import { getSpellVisuals } from '../../data/spellVisuals';
import {
  getPlayerBlockAnimations,
  getWeaponAnimationSetWithFallbacks,
  getWeaponStyleAttackAnimation,
  PLAYER_EAT_SEQ_ID,
} from '../../data/weaponAnimations';
import { getWeaponCombatVisuals } from '../../data/weaponCombatVisuals';
import type { AnimationSequence } from './animation';
import type { ReplayEffectSourceFrame } from './replayEffectContext';
import type { PrimarySpec } from './replayPrimaryIndex';

export type PlayerPrimaryKind = 'attack' | 'consume' | 'block' | 'intro';
export type PlayerPrimaryClip = { readonly sequence: AnimationSequence; readonly kind: PlayerPrimaryKind };
export type PlayerPrimaryCue = {
  readonly tick: number;
  readonly kind: PlayerPrimaryKind;
  readonly sequenceIds: readonly number[];
};
export type PlayerAttackIntent =
  | { readonly kind: 'spell'; readonly castAnimationId: number; readonly fallbackAnimationId: number | undefined }
  | {
      readonly kind: 'weapon';
      readonly weaponId: number | undefined;
      readonly attackKind?: AttackKind;
      readonly specAnimationId?: number;
    };

export function playerAttackSequenceIds(intent: PlayerAttackIntent): number[] {
  switch (intent.kind) {
    case 'spell':
      return [intent.castAnimationId, intent.fallbackAnimationId].filter((id) => id !== undefined);
    case 'weapon':
      return [
        intent.specAnimationId,
        getWeaponStyleAttackAnimation(intent.weaponId, intent.attackKind),
        getWeaponCombatVisuals(intent.weaponId)?.attackAnimation,
        ...getWeaponAnimationSetWithFallbacks(intent.weaponId).map((set) => set.attack),
      ].filter((id): id is number => id !== undefined && id >= 0);
    default: {
      const exhaustive: never = intent;
      throw exhaustive;
    }
  }
}

export function playerPrimarySpec(
  sequence: AnimationSequence,
  kind: PlayerPrimaryKind,
): PrimarySpec<PlayerPrimaryClip> {
  return {
    clip: { sequence, kind },
    priority: sequence.forcedPriority,
    duration: sequence.frameLengths.reduce((total, length) => total + length, 0),
    delay: 0,
    replaces: kind !== 'block',
  };
}

export function describePlayerPrimaries(frame: ReplayEffectSourceFrame): readonly PlayerPrimaryCue[] {
  const cues: PlayerPrimaryCue[] = [];
  let attack: PlayerPrimaryCue | undefined;
  let intro: PlayerPrimaryCue | undefined;
  const equipment = frame.state.playerEquipment;
  for (const event of frame.events) {
    if (event.type === 'item_consumed')
      cues.push({ tick: event.tick, kind: 'consume', sequenceIds: [PLAYER_EAT_SEQ_ID] });
    if (isCoreEvent(event, 'hit_applied') && event.targetId === 'player')
      cues.push({
        tick: event.tick,
        kind: 'block',
        sequenceIds: getPlayerBlockAnimations(equipment.weapon, equipment.shield),
      });
    if (
      event.type === 'spell_self_cast' &&
      typeof event.animationId === 'number' &&
      typeof event.spotAnimId === 'number'
    )
      cues.push({ tick: event.tick, kind: 'attack', sequenceIds: [event.animationId] });
    if (event.type === 'intro_started' && typeof event.animationSeqId === 'number')
      intro = { tick: event.tick, kind: 'intro', sequenceIds: [event.animationSeqId] };
    if (event.type === 'intro_completed') intro = undefined;
    if (!isCoreEvent(event, 'attack_started') || event.sourceId !== 'player') continue;
    const spell = event.spellId === undefined ? undefined : getSpellVisuals(event.spellId);
    const weaponId = event.weaponId ?? equipment.weapon;
    const intent: PlayerAttackIntent =
      event.spellId !== undefined
        ? {
            kind: 'spell',
            castAnimationId: spell?.castAnimationId ?? 1162,
            fallbackAnimationId: spell?.fallbackAnimationId,
          }
        : {
            kind: 'weapon',
            weaponId,
            attackKind: event.attackKind,
            specAnimationId: event.usingSpecialAttack ? getSpecialAttackDef(weaponId ?? 0)?.animationId : undefined,
          };
    attack = { tick: event.tick, kind: 'attack', sequenceIds: playerAttackSequenceIds(intent) };
  }
  if (intro) cues.push(intro);
  if (attack) cues.push(attack);
  return cues;
}
