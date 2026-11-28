import type { NpcActor } from '../../core/actors/NpcActor';
import type { NpcFormulaStats } from '../../core/actors/types';
import type { PrayerReduction } from '../../core/combat/CombatSystem';
import type { DamageValue } from '../../core/combat/damageCalculation';
import { chebyshevDistanceToRect } from '../../core/combat/distance';
import { calculateAccuracy, lookupPrayerMultipliersFromState } from '../../core/combat/formulas';
import { npcFormulaActor, playerFormulaActor } from '../../core/combat/npcAttackRequest';
import type { NpcAttackRequest } from '../../core/encounters/types';
import type { AttackKind } from '../../core/events/types';
import { createNpcDefinition } from '../../core/npcs';
import type { WorldState } from '../../core/WorldState';
import { getMonsterFormulaStats } from '../../data/monsterData';
import type { Coordinate, TickNumber } from '../../types/simulation';
import {
  getAttackKindForStyle,
  getYamaBeatInfo,
  nextYamaBeatTick,
  type ResolvedYamaAttackPattern,
  YAMA_NPC_ID,
  YAMA_SIZE,
} from './timing';
import { wretchedDamageBonusPercent } from './wretchedStrength';

export { YAMA_NPC_ID } from './timing';

export type QueuedYamaAttack = {
  readonly style: 'magic' | 'range' | 'melee';
  readonly attackKind: AttackKind;
};

export type YamaActorState = {
  openingStyle: 'magic' | 'range';
  queuedAttack: QueuedYamaAttack | null;
  windup: {
    readonly style: 'magic' | 'range';
    readonly attackKind: AttackKind;
    readonly releaseTick: number;
  } | null;
  latestAttackKind: AttackKind | 'fireball' | null;
  latestAttackTick: TickNumber | null;
  alternatingAttackCount: number;
  didPlanMelee: boolean;
};

export type YamaAttackMechanics = {
  readonly meleeEnabled: boolean;
  readonly rangedMagicEnabled: boolean;
};

export type YamaDefinitionConfig = {
  readonly attackPattern: ResolvedYamaAttackPattern;
  readonly meleeDamage: DamageValue;
  readonly rangedMagicDamage: DamageValue;
  readonly meleePrayerReduction: PrayerReduction;
  readonly rangedMagicPrayerReduction: PrayerReduction;
  readonly wretchedStrength: boolean;
  readonly accuracyRandom: () => number;
  readonly getMechanics: () => YamaAttackMechanics;
};

export type CreateYamaActorInput = {
  readonly position: Coordinate;
  readonly hp: number;
  readonly maxHp: number;
  readonly openingStyle: 'magic' | 'range';
  readonly levelOverrides?: Readonly<Partial<NpcFormulaStats['levels']>>;
  readonly defenceDrainFloor?: number;
};

const YAMA_ACTOR_ID = 'yama';
const YAMA_MELEE_POISON_VARP = 100;

export const yamaDefinition = createNpcDefinition<YamaActorState, YamaDefinitionConfig>({
  id: 'yama',
  move: false,
  tick: ({ actor, config, context }) => {
    const queuedAttack = actor.state.queuedAttack;
    actor.state.queuedAttack = null;
    actor.state.latestAttackKind = null;
    actor.state.latestAttackTick = null;
    if (!actor.alive || !context.world.getPlayer()?.alive) {
      resetYamaAttackState(actor);
      return { environmentalDamages: [] };
    }

    const npcAttacks: NpcAttackRequest[] = [];
    const windup = actor.state.windup;
    if (windup && context.tick >= windup.releaseTick) {
      actor.state.windup = null;
      npcAttacks.push(resolveYamaAttack(actor, windup, { config, world: context.world }));
    }
    if (!queuedAttack) return { npcAttacks, environmentalDamages: [] };

    const mechanics = config.getMechanics();
    const enabled = queuedAttack.style === 'melee' ? mechanics.meleeEnabled : mechanics.rangedMagicEnabled;
    if (!enabled) return { npcAttacks, environmentalDamages: [] };

    actor.state.latestAttackKind = queuedAttack.attackKind;
    actor.state.latestAttackTick = context.tick;
    if (queuedAttack.style === 'melee') {
      npcAttacks.push(resolveYamaAttack(actor, queuedAttack, { config, world: context.world }));
    } else {
      actor.state.windup = {
        style: queuedAttack.style,
        attackKind: queuedAttack.attackKind,
        releaseTick: context.tick + 3,
      };
      actor.combat.lastAttackTick = context.tick;
      context.tickEvents.emit({
        type: 'attack_started',
        sourceId: actor.id,
        targetId: 'player',
        style: queuedAttack.style,
        attackKind: queuedAttack.attackKind,
        impactDelayTicks: 3,
      });
    }
    return { npcAttacks, environmentalDamages: [] };
  },
  postTick: ({ actor, config, context }) => {
    if (!actor.alive || !context.world.getPlayer()?.alive) {
      resetYamaAttackState(actor);
      return [];
    }
    actor.state.didPlanMelee = false;
    const mechanics = config.getMechanics();
    const beatInfo = getYamaBeatInfo(context.tick, config.attackPattern);
    if ((!mechanics.meleeEnabled && !mechanics.rangedMagicEnabled) || !beatInfo.isBeat) return [];

    if (mechanics.meleeEnabled && isPlayerInMeleeRange(actor, context.world)) {
      actor.state.queuedAttack = { style: 'melee', attackKind: 'melee_crush' };
      actor.state.didPlanMelee = true;
    } else if (mechanics.rangedMagicEnabled && beatInfo.fireballBeatKind !== 'snap') {
      queueAlternatingAttack(actor.state);
    }
    return [];
  },
  attackTimer: ({ actor, config, context }) => {
    const mechanics = config.getMechanics();
    if (!mechanics.meleeEnabled && !mechanics.rangedMagicEnabled) return null;
    if (actor.combat.targetId === null) return null;
    return {
      nextAttackTick: nextYamaBeatTick(context.tick, config.attackPattern),
      attackSpeed: config.attackPattern.beatIntervalTicks,
    };
  },
  onDefeated: ({ actor }) => resetYamaAttackState(actor),
});

export function createYamaActor(input: CreateYamaActorInput) {
  const baseStats = getMonsterFormulaStats(YAMA_NPC_ID, 'Phase 3');
  if (baseStats === undefined) throw new TypeError('Missing Phase 3 Yama formula stats');
  const formulaStats = input.levelOverrides
    ? { ...baseStats, levels: { ...baseStats.levels, ...input.levelOverrides } }
    : baseStats;
  const actor: NpcActor = {
    id: YAMA_ACTOR_ID,
    kind: 'npc',
    role: 'boss',
    alive: true,
    position: input.position,
    previousPosition: input.position,
    facing: 0,
    size: YAMA_SIZE,
    vitals: { hp: input.hp, maxHp: input.maxHp },
    npcTypeId: YAMA_NPC_ID,
    archetypeId: 'yama',
    history: new Map<TickNumber, Coordinate>(),
    combat: {
      attackSpeed: 1,
      attackRange: 10,
      attackStyle: 'magic',
      nextActionTick: 0,
      targetId: 'player',
      lastAttackTick: null,
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
    },
    formulaStats: { ...formulaStats, demonbaneVulnerability: 1.2 },
    defenceDrainFloor: input.defenceDrainFloor,
  };
  return yamaDefinition.createActor(actor, {
    openingStyle: input.openingStyle,
    queuedAttack: null,
    windup: null,
    latestAttackKind: null,
    latestAttackTick: null,
    alternatingAttackCount: 0,
    didPlanMelee: false,
  });
}

export function getYamaState(actor: NpcActor): YamaActorState | null {
  return yamaDefinition.getState(actor);
}

export function setYamaOpeningStyle(actor: NpcActor, style: 'magic' | 'range'): void {
  const state = yamaDefinition.getState(actor);
  if (!state) return;
  state.openingStyle = style;
  state.alternatingAttackCount = 0;
}

export function markYamaFireballAttack(actor: NpcActor, tick: number): void {
  const state = yamaDefinition.getState(actor);
  if (!state) return;
  state.latestAttackKind = 'fireball';
  state.latestAttackTick = tick;
}

export function resetYamaAttackState(actor: NpcActor): void {
  const state = yamaDefinition.getState(actor);
  if (!state) return;
  state.queuedAttack = null;
  state.windup = null;
  state.latestAttackKind = null;
  state.latestAttackTick = null;
  state.didPlanMelee = false;
  state.alternatingAttackCount = 0;
}

/** Yama swings at a player touching his footprint. P3 autos have no line-of-sight gate. */
function isPlayerInMeleeRange(actor: NpcActor, world: Readonly<WorldState>): boolean {
  const player = world.getPlayer();
  if (!player) return false;
  return (
    chebyshevDistanceToRect(player.position[0], player.position[1], actor.position[0], actor.position[1], YAMA_SIZE) <=
    1
  );
}

function queueAlternatingAttack(state: YamaActorState): void {
  const oppositeStyle = state.openingStyle === 'magic' ? 'range' : 'magic';
  const style = state.alternatingAttackCount % 2 === 0 ? state.openingStyle : oppositeStyle;
  state.queuedAttack = { style, attackKind: getAttackKindForStyle(style) };
  state.alternatingAttackCount += 1;
}

function resolveYamaAttack(
  actor: NpcActor,
  attack: QueuedYamaAttack,
  input: { readonly config: YamaDefinitionConfig; readonly world: Readonly<WorldState> },
): NpcAttackRequest {
  const { config } = input;
  const isMelee = attack.style === 'melee';
  return {
    attackerId: actor.id,
    targetId: 'player',
    style: attack.style,
    attackKind: attack.attackKind,
    rolledDamage: isMelee ? config.meleeDamage : config.rangedMagicDamage,
    damageBonusPercent: config.wretchedStrength
      ? wretchedDamageBonusPercent(actor.vitals.hp, actor.vitals.maxHp)
      : undefined,
    accuracySucceeded: rollAccuracy(actor, attack.style, input),
    impactDelayTicks: isMelee ? 1 : 0,
    applyPoison: isMelee ? YAMA_MELEE_POISON_VARP : undefined,
    prayerReduction: isMelee ? config.meleePrayerReduction : config.rangedMagicPrayerReduction,
    prayerCheckAt: isMelee ? 'launch' : 'impact',
    isContinuation: !isMelee,
    // The magic/range release lands the tick it is released, so it is never queued; the melee hit
    // lands a tick later with no captured Yama death between, so it keeps the pre-classification
    // default. Yama's defeat also clears its queued hits outright (`YamaEncounter.onNpcDefeated`).
    sourceDeathPolicy: isMelee ? 'cancel-before-impact' : 'persist',
  };
}

function rollAccuracy(
  actor: NpcActor,
  style: 'melee' | 'magic' | 'range',
  input: { readonly config: YamaDefinitionConfig; readonly world: Readonly<WorldState> },
): boolean {
  const attacker = npcFormulaActor(actor);
  if (!attacker) throw new TypeError('Yama cannot roll accuracy without formula stats');
  const player = input.world.getPlayer();
  if (!player) throw new TypeError('Yama cannot roll accuracy with no player in the world');
  const attackStyle = style === 'melee' ? 'melee_slash' : style === 'range' ? 'ranged' : 'magic';
  const accuracy = calculateAccuracy(
    attacker,
    playerFormulaActor(player),
    attackStyle,
    player.equipmentStats,
    lookupPrayerMultipliersFromState(player.activePrayer, player.boostPrayers),
  );
  return input.config.accuracyRandom() < accuracy;
}
