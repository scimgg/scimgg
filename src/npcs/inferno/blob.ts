import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import { isFootprintInAttackRange } from '../../core/combat/distance';
import { calculateProjectileEndTime, npcHitDelayFromEndTime } from '../../core/combat/hitDelay';
import { isNpcActionReady, scheduleNpcAction } from '../../core/combat/npcActionClock';
import {
  type AttackPlan,
  canNpcAttack,
  projectileDistance,
  resolveAttackRequest,
} from '../../core/combat/npcAttackRequest';
import { createNpcRetaliation } from '../../core/combat/retaliation';
import { contextAttackDecisions, contextDecisions } from '../../core/decisionRandom';
import type { EncounterTickResult } from '../../core/encounters/types';
import type { NpcProjectileCue } from '../../core/events/encounterVisual';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { canNpcActThisTurn, canReceiveNewAttack } from '../../core/npcDeath';
import { createNpcDefinition, type NpcDefinitionContext } from '../../core/npcs';
import { type Coordinate, PrayerType } from '../../types/simulation';
import { createInfernoActor } from './actors';
import { INFERNO_WAVE_NPC_IDS } from './constants';
import { emitZukAttack, emitZukDeath, type ZukAttackKind } from './events';
import { presentInfernoDamage } from './presentation';
import {
  type InfernoWaveProjectile,
  JAL_AK_MAGIC_PROJECTILE,
  JAL_AK_RANGED_PROJECTILE,
  JAL_AKREK_MEJ_PROJECTILE,
  JAL_AKREK_XIL_PROJECTILE,
} from './projectileProfiles';
import { resolveReadyTarget } from './targetResolution';
import { emitInfernoWaveAttack, infernoWaveProjectileCue } from './waveCombat';

// docs/encounters/inferno-facts-spec.md (Behavior, Jal-Ak): it reads the protection prayer on a
// decision tick with reach and releases the answering style 3 ticks later (446/446 emissions); the next
// decision is 3 ticks after that release, or 6 after an immediate melee swing.
const BLOB_WINDUP_TICKS = 3;
const BLOB_DECISION_AFTER_RELEASE_TICKS = 3;
const BLOB_DECISION_AFTER_MELEE_TICKS = 6;
// W Jal-Ak max 29 (timed maxima: ranged 29, magic 24). Reach 15 matches the 16-tile packet-source
// distances observed from its center tile.
const BLOB_MAX_HIT = 29;
const BLOB_ATTACK_RANGE = 15;
// Children: W Jal-AkRek-* max 18 each, reach 15; every 4 ticks (facts spec, Split blobs).
const CHILD_ATTACK_SPEED = 4;
const CHILD_MAX_HIT = 18;
const CHILD_ATTACK_RANGE = 15;

type BlobStyle = 'magic' | 'range' | 'melee';
type ProjectileStyle = Exclude<BlobStyle, 'melee'>;

type StyleProfile = {
  readonly clipId: BlobStyle;
  readonly sound: Extract<ZukAttackKind, `blob_${string}`>;
  readonly plan: AttackPlan;
  readonly projectile?: InfernoWaveProjectile;
};

function rangedProfile(projectile: InfernoWaveProjectile, maxHit: number): StyleProfile {
  return {
    clipId: 'range',
    sound: 'blob_range',
    projectile,
    // Released projectiles land after their source dies (Inferno 1-68: 1312→1313, 5091→5093).
    plan: {
      formulaStyle: 'ranged',
      damageType: 'range',
      attackKind: 'range_arrow',
      impactDelayTicks: 0,
      projectile: projectile.timing,
      maxHit,
      sourceDeathPolicy: 'persist',
    },
  };
}

function magicProfile(projectile: InfernoWaveProjectile, maxHit: number): StyleProfile {
  return {
    clipId: 'magic',
    sound: 'blob_magic',
    projectile,
    plan: {
      formulaStyle: 'magic',
      damageType: 'magic',
      attackKind: 'magic_fire',
      impactDelayTicks: 0,
      projectile: projectile.timing,
      maxHit,
      sourceDeathPolicy: 'persist',
    },
  };
}

// The melee type is unpublished; crush matches the Jal-AkRek-Ket child (W).
function meleeProfile(maxHit: number): StyleProfile {
  return {
    clipId: 'melee',
    sound: 'blob_melee',
    plan: {
      formulaStyle: 'melee_crush',
      damageType: 'melee',
      attackKind: 'melee_crush',
      impactDelayTicks: 0,
      maxHit,
      // Lands on the swing tick, so it is never queued.
      sourceDeathPolicy: 'cancel-before-impact',
    },
  };
}

const BLOB_PROFILES: Readonly<Record<BlobStyle, StyleProfile>> = {
  magic: magicProfile(JAL_AK_MAGIC_PROJECTILE, BLOB_MAX_HIT),
  range: rangedProfile(JAL_AK_RANGED_PROJECTILE, BLOB_MAX_HIT),
  melee: meleeProfile(BLOB_MAX_HIT),
};

function commitStyledAttack(
  actor: NpcActor,
  target: PlayerActor | NpcActor,
  profile: StyleProfile,
  context: NpcDefinitionContext,
  attackSpeed: number,
): EncounterTickResult {
  const attack = resolveAttackRequest({
    attacker: actor,
    target,
    plan: profile.plan,
    random: context.random,
    labelled: contextAttackDecisions(context),
  });
  if (!attack) throw new TypeError(`Missing formula stats for ${actor.id} or ${target.id}`);
  const projectiles: NpcProjectileCue[] = profile.projectile
    ? [
        infernoWaveProjectileCue(
          actor,
          target,
          profile.projectile,
          calculateProjectileEndTime(profile.projectile.timing, projectileDistance(actor, target)),
        ),
      ]
    : [];
  emitInfernoWaveAttack(context, {
    actor,
    target,
    clipId: profile.clipId,
    kind: profile.sound,
    impactDelayTicks: attack.impactDelayTicks,
    projectiles,
  });
  actor.combat.attackStyle = profile.plan.damageType;
  actor.combat.lastAttackTick = context.tick;
  scheduleNpcAction(actor.combat, context.tick, attackSpeed);
  return { environmentalDamages: [], npcAttacks: [attack] };
}

export type BlobState = {
  /** First tick the next decision may happen; it waits there until the player is in reach. */
  nextDecisionTick: number;
  /** The style locked by the last read, released on `releaseTick`. */
  pendingRelease: { readonly style: ProjectileStyle; readonly releaseTick: number } | null;
};

type BlobActor = NpcActor & { readonly state: BlobState };

/** Policy (Blob style): Protect from Melee alone, or none, is a 50/50; otherwise the opposite style. */
function readStyle(actor: NpcActor, target: PlayerActor | NpcActor, context: NpcDefinitionContext): ProjectileStyle {
  const prayer = target.kind === 'player' ? target.activePrayer : null;
  // A prayer-determined style is not a draw.
  if (prayer === PrayerType.ProtectMagic) return 'range';
  if (prayer === PrayerType.ProtectRange) return 'magic';
  const key = { site: 'inferno.blob.style', tick: context.tick, actorId: actor.id, targetId: target.id };
  return contextDecisions(context).chance(key, 0.5) ? 'range' : 'magic';
}

/**
 * The windup ends: the projectile leaves from where the blob stood at the start of this tick (source
 * and distance 446/446, 38 of them on a tick it stepped), with no line of sight needed (50/446 fired
 * through lost LoS). It is dropped when the player started the tick more than 15 tiles from that
 * footprint (Q t24, Q:4895-4909). Prayer is checked now, at launch, as for every NPC projectile.
 */
function releaseProjectile(
  actor: BlobActor,
  style: ProjectileStyle,
  context: NpcDefinitionContext,
  dying = false,
): EncounterTickResult {
  const empty = { environmentalDamages: [] };
  // A corpse keeps its last target rather than reacquiring one.
  const target = dying ? deathReleaseTarget(actor, context) : resolveReadyTarget(actor, context.world);
  if (!target) return empty;
  const source = { position: actor.previousPosition, size: actor.size };
  if (
    !isFootprintInAttackRange(
      { southWest: source.position, width: source.size, height: source.size },
      { southWest: target.position, width: target.size, height: target.size },
      { attackRange: BLOB_ATTACK_RANGE, checkCollision: false },
    )
  )
    return empty;
  const profile = BLOB_PROFILES[style];
  const projectile = profile.projectile;
  if (!projectile) throw new TypeError(`Jal-Ak ${style} has no projectile`);
  const centre = Math.floor(source.size / 2);
  const distance = Math.max(
    Math.abs(source.position[0] + centre - target.position[0]),
    Math.abs(source.position[1] + centre - target.position[1]),
  );
  const endCycles = calculateProjectileEndTime(projectile.timing, distance);
  const { projectile: _flight, ...flightless } = profile.plan;
  const attack = resolveAttackRequest({
    attacker: actor,
    target,
    plan: { ...flightless, impactDelayTicks: npcHitDelayFromEndTime(endCycles) },
    random: context.random,
    labelled: contextAttackDecisions(context),
  });
  if (!attack) throw new TypeError(`Missing formula stats for ${actor.id} or ${target.id}`);
  const cue = infernoWaveProjectileCue(actor, target, projectile, endCycles, source);
  if (dying) {
    // The death sequence owns the model: only the projectile and its sounds (Q:82067-82110).
    emitEncounterVisual(context.tickEvents, { animations: [], projectiles: [cue], graphics: [] });
    emitZukAttack(context, {
      attack: profile.sound,
      sourceId: actor.id,
      targetId: target.id,
      sourcePosition: actor.position,
      targetPosition: target.position,
      launchTick: context.tick,
      impactTick: context.tick + attack.impactDelayTicks,
      projectileArrivalCycles: endCycles,
    });
    return { environmentalDamages: [], npcAttacks: [attack] };
  }
  emitInfernoWaveAttack(context, {
    actor,
    target,
    clipId: profile.clipId,
    kind: profile.sound,
    impactDelayTicks: attack.impactDelayTicks,
    projectiles: [cue],
  });
  actor.combat.attackStyle = profile.plan.damageType;
  actor.combat.lastAttackTick = context.tick;
  return { environmentalDamages: [], npcAttacks: [attack] };
}

function deathReleaseTarget(actor: BlobActor, context: NpcDefinitionContext): PlayerActor | NpcActor | null {
  const targetId = actor.combat.targetId;
  if (targetId === null) return null;
  const target = context.world.getPlayers().find((player) => player.id === targetId) ?? context.world.getNpc(targetId);
  return target && canReceiveNewAttack(target) ? target : null;
}

function tickBlob(actor: BlobActor, context: NpcDefinitionContext): EncounterTickResult {
  const empty = { environmentalDamages: [] };
  const state = actor.state;
  const pending = state.pendingRelease;
  if (pending) {
    if (context.tick < pending.releaseTick) return empty;
    state.pendingRelease = null;
    state.nextDecisionTick = pending.releaseTick + BLOB_DECISION_AFTER_RELEASE_TICKS;
    return releaseProjectile(actor, pending.style, context);
  }
  if (context.tick < state.nextDecisionTick) return empty;
  const target = resolveReadyTarget(actor, context.world);
  // A decision needs the player outside the footprint, within 15 tiles and in LoS after this tick's
  // step (before the player's); without it the blob waits, with no spawn-based phase.
  if (!target || !canNpcAttack(actor, target, BLOB_PROFILES.range.plan)) return empty;
  const protectingMelee = target.kind === 'player' && target.activePrayer === PrayerType.ProtectMelee;
  // Policy (Blob melee): when adjacent, cardinally or diagonally, and not protecting from Melee, half
  // the decisions swing at once (P t3661, Q t250 diagonal).
  if (
    !protectingMelee &&
    canNpcAttack(actor, target, BLOB_PROFILES.melee.plan) &&
    contextDecisions(context).chance(
      { site: 'inferno.blob.melee', tick: context.tick, actorId: actor.id, targetId: target.id },
      0.5,
    )
  ) {
    state.nextDecisionTick = context.tick + BLOB_DECISION_AFTER_MELEE_TICKS;
    const attack = resolveAttackRequest({
      attacker: actor,
      target,
      plan: BLOB_PROFILES.melee.plan,
      random: context.random,
      labelled: contextAttackDecisions(context),
    });
    if (!attack) throw new TypeError(`Missing formula stats for ${actor.id} or ${target.id}`);
    emitInfernoWaveAttack(context, { actor, target, clipId: 'melee', kind: 'blob_melee', impactDelayTicks: 0 });
    actor.combat.attackStyle = 'melee';
    actor.combat.lastAttackTick = context.tick;
    return { environmentalDamages: [], npcAttacks: [attack] };
  }
  // The style is locked now; no animation until the release.
  state.pendingRelease = { style: readStyle(actor, target, context), releaseTick: context.tick + BLOB_WINDUP_TICKS };
  return empty;
}

export const blobDefinition = createNpcDefinition<BlobState, undefined>({
  id: 'inferno-jal-ak',
  deathPolicy: 'queued',
  onDamageResolved: presentInfernoDamage,
  // Facts spec (NPCs table) death sequence; its sound rides the same tick (zukAudioRules).
  onDeathAnimation: ({ actor, context }) =>
    emitZukDeath(context, { actorId: actor.id, npcKind: 'blob', position: actor.position }),
  // A read scheduled before death still releases on the death-animation tick (Q t1083, Q t3860:
  // Q:82067-82110); one due on any other tick after death is lost.
  releaseOnDeathAnimation: ({ actor, context }) => {
    const pending = actor.state.pendingRelease;
    actor.state.pendingRelease = null;
    if (pending?.releaseTick !== context.tick) return [];
    return releaseProjectile(actor, pending.style, context, true).npcAttacks ?? [];
  },
  tick: ({ actor, context }) =>
    canNpcActThisTurn(actor, context.tick) ? tickBlob(actor, context) : { environmentalDamages: [] },
  attackTimer: ({ actor }) =>
    actor.alive && actor.state.pendingRelease
      ? { nextAttackTick: actor.state.pendingRelease.releaseTick, attackSpeed: BLOB_WINDUP_TICKS }
      : null,
});

export type SplitBlobSpecies = 'blob_range' | 'blob_melee' | 'blob_mage';

const CHILD_PROFILES: Readonly<Record<SplitBlobSpecies, StyleProfile>> = {
  blob_mage: magicProfile(JAL_AKREK_MEJ_PROJECTILE, CHILD_MAX_HIT),
  blob_range: rangedProfile(JAL_AKREK_XIL_PROJECTILE, CHILD_MAX_HIT),
  blob_melee: meleeProfile(CHILD_MAX_HIT),
};

export type SplitBlobState = { readonly species: SplitBlobSpecies; readonly firstActionTick: number };

/** Fixed styles, no prayer read (facts spec, Split blobs). */
export const splitBlobDefinition = createNpcDefinition<SplitBlobState, undefined>({
  id: 'inferno-jal-akrek',
  deathPolicy: 'queued',
  onDamageResolved: presentInfernoDamage,
  // Facts spec (NPCs table) death sequence; its sound rides the same tick (zukAudioRules).
  onDeathAnimation: ({ actor, context }) =>
    emitZukDeath(context, { actorId: actor.id, npcKind: 'blob_child', position: actor.position }),
  tick: ({ actor, context }) => {
    const empty = { environmentalDamages: [] };
    if (!canNpcActThisTurn(actor, context.tick) || context.tick < actor.state.firstActionTick) return empty;
    if (!isNpcActionReady(actor.combat, context.tick)) return empty;
    const target = resolveReadyTarget(actor, context.world);
    if (!target) return empty;
    const profile = CHILD_PROFILES[actor.state.species];
    if (!canNpcAttack(actor, target, profile.plan)) return empty;
    return commitStyledAttack(actor, target, profile, context, CHILD_ATTACK_SPEED);
  },
});

/**
 * Facts spec (Jal-Ak, split): the children are born at fixed offsets from the parent's last SW tile —
 * Jal-AkRek-Xil (1,1), Jal-AkRek-Ket (0,0), Jal-AkRek-Mej (2,2) — added in that order, and take an
 * ordinary first step in their add tick, so a captured `add` tile is where that step ended. With this
 * birth layout the generic movement reproduces all 198 captured add tiles (125 after a hidden step; Q
 * t895's Ket, born under the player, escapes south). No parent moves while dying (0/66).
 */
export const SPLIT_BLOB_OFFSETS: readonly { readonly species: SplitBlobSpecies; readonly offset: Coordinate }[] = [
  { species: 'blob_range', offset: [1, 1] },
  { species: 'blob_melee', offset: [0, 0] },
  { species: 'blob_mage', offset: [2, 2] },
];

export type SplitBlobSpawn = { readonly species: SplitBlobSpecies; readonly position: Coordinate };

export function splitBlobSpawns(parent: Pick<NpcActor, 'position'>): readonly SplitBlobSpawn[] {
  return SPLIT_BLOB_OFFSETS.map(({ species, offset }) => ({
    species,
    position: [parent.position[0] + offset[0], parent.position[1] + offset[1]],
  }));
}

export function isBlob(actor: NpcActor): boolean {
  return actor.npcTypeId === INFERNO_WAVE_NPC_IDS.blob && blobDefinition.isActor(actor);
}

type BlobSpawnOptions = {
  readonly id: string;
  readonly position: Coordinate;
  readonly spawnTick: number;
  readonly targetId: string | null;
  readonly initialDelayTicks?: number;
};

export function createBlob(options: BlobSpawnOptions) {
  const actor = createInfernoActor('blob', options.id, options.position);
  actor.spawnTick = options.spawnTick;
  actor.combat.attackSpeed = BLOB_WINDUP_TICKS;
  actor.combat.attackRange = BLOB_ATTACK_RANGE;
  actor.combat.attackStyle = 'range';
  // The parent swings at diagonal neighbors (Q t250, Q:9497-9505); its children stay cardinal.
  actor.combat.meleeReach = 'diagonal';
  actor.combat.targetId = options.targetId;
  actor.combat.retaliation = createNpcRetaliation();
  // First decision on its first turn, add+1; first emission then add+4 (facts spec, Jal-Ak).
  return blobDefinition.createActor(actor, {
    nextDecisionTick: options.spawnTick + (options.initialDelayTicks ?? 1),
    pendingRelease: null,
  });
}

export function createSplitBlob(options: BlobSpawnOptions & { readonly species: SplitBlobSpecies }) {
  const actor = createInfernoActor(options.species, options.id, options.position);
  actor.spawnTick = options.spawnTick;
  actor.combat.attackSpeed = CHILD_ATTACK_SPEED;
  actor.combat.attackRange = options.species === 'blob_melee' ? 1 : CHILD_ATTACK_RANGE;
  actor.combat.attackStyle = CHILD_PROFILES[options.species].plan.damageType;
  actor.combat.targetId = options.targetId;
  actor.combat.retaliation = createNpcRetaliation();
  // Siblings added together all act first at spawn+3 (P:2586-2599, Q:5760-5770). They are born in combat
  // with the player, ready at spawn+3: a hit or splash before then does not flinch them (P t610 ice blitz
  // on Xil and splash on Mej, both still attack at t612, P:2540-2600).
  const firstActionTick = options.spawnTick + (options.initialDelayTicks ?? 3);
  actor.combat.nextActionTick = firstActionTick;
  return splitBlobDefinition.createActor(actor, { species: options.species, firstActionTick });
}
