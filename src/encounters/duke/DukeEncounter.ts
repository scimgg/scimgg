import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import {
  calculateAccuracy,
  calculateNpcMaxHit,
  lookupPrayerMultipliersFromState,
  type NpcFormulaActor,
} from '../../core/combat/formulas';
import { npcFormulaActor, playerFormulaActor } from '../../core/combat/npcAttackRequest';
import { SIMULATION_START_TICK } from '../../core/constants';
import { ACTIVE_ENCOUNTER_OUTCOME, type EncounterOutcome } from '../../core/encounters/outcome';
import type { EncounterSnapshot, EncounterSnapshotContext } from '../../core/encounters/snapshot';
import type {
  Encounter,
  EncounterCompletionOwnership,
  EncounterContext,
  EncounterEngineContext,
  EncounterEngineRules,
  EncounterInput,
  EncounterNpcDefeat,
  EncounterNpcInteraction,
  EncounterPlayerAttackContext,
  EncounterPlayerAttackInfo,
  EncounterPlayerAttackStartedInfo,
  EncounterRunStartContext,
  EncounterTickResult,
  EnvironmentalDamage,
} from '../../core/encounters/types';
import {
  type EncounterVisualBatch,
  emitEncounterVisual,
  type NpcVisualTarget,
} from '../../core/events/encounterVisual';
import type { TickEvents } from '../../core/events/TickEvents';
import { mulberry32 } from '../../core/rng';
import {
  createWarden,
  createWardenPlan,
  DUKE_ASLEEP_NPC_ID,
  DUKE_NPC_ID,
  getWardenPlan,
  WARDEN_ID,
  WARDEN_MAX_HP,
  type WardenPlan,
  wardenDefinitions,
} from '../../npcs/duke/duke';
import { DUKE_ALWAYS_BILE_KEY, DUKE_START_PHASE_KEY } from '../../types/duke';
import { ARDER_MUSCA_POISON_ITEM_ID, getFiniteStackQuantity } from '../../types/inventory';
import type { Coordinate, MechanicsConfig } from '../../types/simulation';
import { DUKE_KIND } from '../catalog';
import {
  buildArena,
  COVER_TILES,
  DUKE_CENTER_TILE,
  DUKE_MOUTH_POSITION,
  isInMeleeLane,
  ORB_LANE,
  SLAM_TILES,
  START_TILE,
  sameTile,
  square,
  VENTS,
  WARDEN_TILE,
} from './arena';
import { emitDukeAudio } from './audioCues';
import {
  DUKE_ENRAGED_VENT_ACTIVE_TICKS,
  DUKE_FIRST_ATTACK_DELAY_TICKS,
  DUKE_GAS_FLIGHT_TICKS,
  DUKE_GAZE_COVER_CHECK_TICKS,
  DUKE_GAZE_DURATION_TICKS,
  DUKE_GAZE_HIT_DELAY_TICKS,
  DUKE_GROUND_ICICLES,
  DUKE_MAGIC_FLIGHT_TICKS,
  DUKE_MAGIC_PROJECTILE,
  DUKE_POISON_PER_DOSE,
  DUKE_POISON_TOLERANCE,
  DUKE_SLAM_IMPACT_DELAY_TICKS,
  DUKE_SPOT_ANIMS,
  DUKE_VENT_ACTIVE_TICKS,
  DUKE_VENT_ARM_TICKS,
  DUKE_VENT_FADE_TICKS,
  DUKE_VENT_SMOKE_CYCLE_TICKS,
  DUKE_WAKE_AFTER_FEED_TICKS,
  DUKE_WAKE_ANIMATION_TICKS,
} from './constants';
import { BILE_HP, DUKE_CONTROLS, dukeStartHp, ENRAGE_HP, ORB_HP, VENTS_HP } from './controls';
import type { DukeOrbBurst, DukePose, WardenHazard, WardenHazardKind } from './snapshot';

// 20261127-005253-Duke-Sucellus_2.jsonl, first spawn tick 228 and every 12 ticks through 432.
const ORB_PERIOD = 12;
const ORB_SPAWN_DELAY_TICKS = 3;
// Graphic 379's cache sequence 1973 lasts 48 client cycles.
const ORB_BURST_TICKS = 2;
const BILE_TICKS = 15;
// Practice rate from the eight Awakened recordings in docs/encounters/duke-unverified.md.
const BILE_CHANCE = 27 / 58;
// All 23 complete pool lifetimes in 20261126-232238-Duke.jsonl (lines 6586–6824 and 7575–7937).
const BILE_POOL_TICKS = 9;
const ORB_DAMAGE_SOURCE = 'Orb of Darkness';

// 20261126-232238-Duke.jsonl and 20261127-005253-Duke-Sucellus_2.jsonl (ticks 258–270).
function wardenCadence(hp: number): number {
  return hp <= ENRAGE_HP ? 4 : 5;
}

// The post-volley countdown model is documented in docs/encounters/duke-unverified.md.
function wardenGasInterval(hp: number): number {
  return hp <= ENRAGE_HP ? 3 : hp <= VENTS_HP ? 4 : 5;
}

function newEncounterSeed(): number {
  return Math.floor(Math.random() * 0x100000000);
}

// The associated cache effects finish within two ticks after the damage window.
function visualEndTick({ kind, expiresTick }: WardenHazard): number {
  if (kind === 'vent') return expiresTick + DUKE_VENT_FADE_TICKS;
  return kind === 'spikes' || kind === 'magic' ? expiresTick + 2 : expiresTick;
}

// The NPC formula gives Awakened caps of 81 (slam) and 71 (bolt).
// https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode
const SLAM_DAMAGE = {
  source: 'Slam',
  attackType: 'melee',
  prayerReduction: { type: 'reduce', value: 0.75 },
} satisfies Omit<EnvironmentalDamage, 'baseDamage'>;
const BOLT_DAMAGE = {
  source: 'Magic bolt',
  attackType: 'magic',
  // Whole-percent penetration that gives the documented protected cap of 36 after flooring.
  prayerReduction: { type: 'reduce', value: 0.51 },
} satisfies Omit<EnvironmentalDamage, 'baseDamage'>;

const HAZARD_DAMAGE = {
  spikes: {
    source: 'Icicles',
    attackType: 'melee',
    // 20261127-012348-Duke-Sucellus_3.jsonl:8445–8472 records 8 with Protect from Melee.
    // 16 is the smallest cap consistent with that hit and the documented 50% reduction.
    // https://oldschool.runescape.wiki/w/Duke_Sucellus#Mechanics
    baseDamage: [0, 16],
    prayerReduction: { type: 'reduce', value: 0.5 },
  },
  // 20261127-014756-Duke-Sucellus_5.jsonl:11238–11350 records a hit of 93.
  // The 65 minimum is modeled. https://oldschool.runescape.wiki/w/Duke_Sucellus#Awakened
  gaze: { source: 'Freezing Gaze', attackType: 'typeless', baseDamage: [65, 121] },
  // 20261127-192944-Duke-Sucellus_12.jsonl:7245 and :7303 record hits of 26 and 25.
  // The 16 minimum is modeled. See docs/encounters/duke-unverified.md#damage-and-hazard-boundaries.
  vent: { source: 'Gas flare', attackType: 'typeless', baseDamage: [16, 27] },
  // 20261127-002024-Duke-Sucellus_1.jsonl:8472. Poison varp 10 starts at 2 damage per pulse.
  bile: { source: 'Bile pool', attackType: 'typeless', baseDamage: [9, 12], applyPoison: 10 },
} satisfies Record<Exclude<WardenHazardKind, 'gasSpit' | 'slam' | 'magic'>, EnvironmentalDamage>;

// https://oldschool.runescape.wiki/w/Duke_Sucellus#Mechanics
const AVOIDABLE_DAMAGE_SOURCES = new Set([
  SLAM_DAMAGE.source,
  HAZARD_DAMAGE.gaze.source,
  HAZARD_DAMAGE.vent.source,
  HAZARD_DAMAGE.bile.source,
  ORB_DAMAGE_SOURCE,
]);

function message(ctx: EncounterContext, text: string): void {
  ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: [{ text }] });
}

function dukeFormulaActor(duke: NpcActor): NpcFormulaActor {
  const attacker = npcFormulaActor(duke);
  if (!attacker) throw new TypeError('Missing Awakened Duke formula stats');
  return attacker;
}

function attackAccuracy(attacker: NpcFormulaActor, ctx: EncounterContext, style: 'melee_crush' | 'magic'): number {
  const player = ctx.world.getPlayer();
  if (!player) return 0;
  return calculateAccuracy(
    attacker,
    playerFormulaActor(player),
    style,
    player.equipmentStats,
    lookupPrayerMultipliersFromState(player.activePrayer, player.boostPrayers),
  );
}

function targetedVent([x, y]: Coordinate, smokingVents: ReadonlySet<string>): Coordinate {
  let nearest = VENTS[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const vent of VENTS) {
    if (smokingVents.has(vent.join(','))) continue;
    const [vx, vy] = vent;
    const distance = (vx - x) ** 2 + (vy - y) ** 2;
    // 20261127-192944-Duke-Sucellus_12.jsonl:7142–7181. The northern grate wins the distance tie.
    if (distance < bestDistance || (distance === bestDistance && vy > nearest[1])) {
      nearest = vent;
      bestDistance = distance;
    }
  }
  return nearest;
}

function boltTarget(player: PlayerActor): NpcVisualTarget {
  return { kind: 'actor', actorId: player.id, size: player.size, position: player.position };
}

export class DukeEncounter implements Encounter {
  readonly kind = DUKE_KIND;
  readonly runStartMechanicsKeys = [DUKE_START_PHASE_KEY];
  private readonly arena = buildArena();
  private startHp = WARDEN_MAX_HP;
  private phaseStartMode: 'legacy' | 'enrage-jump' | 'awake' = 'awake';
  private outcome: EncounterOutcome = ACTIVE_ENCOUNTER_OUTCOME;
  private perfectKillEligible = true;
  private lastIncomingHitTick: number | null = null;
  private hazards: WardenHazard[] = [];
  private pose: DukePose | undefined;
  private bileThroughTick = 0;
  private nextOrbTick: number | null = null;
  private orb: { startTick: number; eastbound: boolean } | null = null;
  private orbBursts: DukeOrbBurst[] = [];
  private orbRandom: () => number;
  private bileRandom: () => number;

  constructor(private encounterSeed = newEncounterSeed()) {
    this.orbRandom = mulberry32(encounterSeed);
    this.bileRandom = mulberry32(~encounterSeed);
  }

  getDefaultPlayerStart(): Coordinate {
    return [...START_TILE];
  }

  getIntroConfig(): null {
    return null;
  }

  getArenaConfig() {
    return this.arena;
  }

  getDefaultMechanicsConfig() {
    return DUKE_CONTROLS.defaultMechanicsConfig;
  }

  getNpcDefinitions() {
    return wardenDefinitions;
  }

  getSeeds() {
    return {
      encounterSeed: this.encounterSeed,
      ...(this.phaseStartMode === 'awake' ? { awakePhaseStarts: true } : {}),
      ...(this.phaseStartMode === 'enrage-jump' ? { awakeEnrageJump: true } : {}),
    };
  }

  reset(seeds?: Record<string, unknown>): void {
    const seed = seeds?.encounterSeed;
    // Replays recorded before the two decisions were seeded use a fixed fallback.
    this.encounterSeed =
      typeof seed === 'number' && Number.isInteger(seed) ? seed >>> 0 : seeds ? 0 : newEncounterSeed();
    // Restore the phase setup used by the recording, including the earlier Enrage-only jump.
    this.phaseStartMode =
      seeds === undefined || seeds.awakePhaseStarts === true
        ? 'awake'
        : seeds.awakeEnrageJump === true
          ? 'enrage-jump'
          : 'legacy';
    this.orbRandom = mulberry32(this.encounterSeed);
    this.bileRandom = mulberry32(~this.encounterSeed);
    this.outcome = ACTIVE_ENCOUNTER_OUTCOME;
    this.perfectKillEligible = true;
    this.lastIncomingHitTick = null;
    this.clearHazards();
  }

  private clearHazards(): void {
    this.hazards = [];
    this.pose = undefined;
    this.bileThroughTick = 0;
    this.nextOrbTick = null;
    this.orb = null;
    this.orbBursts = [];
  }

  configureRunStart(mechanics: Readonly<Partial<MechanicsConfig>>, ctx: EncounterRunStartContext): void {
    const hp = dukeStartHp(mechanics[DUKE_START_PHASE_KEY]);
    if (hp === this.startHp) return;
    this.startHp = hp;
    if (ctx.world.getNpc(WARDEN_ID)) {
      ctx.despawnNpc(WARDEN_ID);
      this.clearHazards();
      ctx.spawnNpc(this.createStartWarden());
    }
  }

  enterBossHpPhase(hp: number, ctx: Pick<EncounterContext, 'tick' | 'world'>): void {
    const duke = ctx.world.getNpc(WARDEN_ID);
    if (!duke?.alive) return;
    const awake =
      this.phaseStartMode === 'awake' ? hp <= VENTS_HP : this.phaseStartMode === 'enrage-jump' && hp <= ENRAGE_HP;
    this.restartWardenPhase(duke, hp, ctx.tick, awake);
  }

  private restartWardenPhase(duke: NpcActor, hp: number, tick: number, awake: boolean): void {
    const plan = getWardenPlan(duke);
    if (!plan) return;

    const cadence = wardenCadence(hp);
    const nextAttackTick = tick + cadence;
    Object.assign(plan, createWardenPlan(awake ? tick : plan.openingAttackTick), {
      poisonToleranceFilled: plan.poisonToleranceFilled,
    });
    const wakePose = this.pose?.clip === 'wake' ? this.pose : undefined;
    this.clearHazards();
    duke.combat.attackSpeed = cadence;
    if (awake) {
      duke.npcTypeId = DUKE_NPC_ID;
      duke.combat.nextActionTick = nextAttackTick;
      if (hp <= ENRAGE_HP) {
        // 20261127-025030-Duke-Sucellus_10.jsonl ticks 346–358 show three basics before the volley.
        plan.autosUntilGas = wardenGasInterval(hp);
      } else {
        // Begin at a volley. In the same capture, ticks 86, 123 and 254 have 3, 2 and 1 basics since Gaze.
        plan.autosUntilGas = 0;
        plan.autosSinceGaze = hp > BILE_HP ? 3 : hp > ORB_HP ? 2 : 1;
      }
      if (hp <= ORB_HP) this.nextOrbTick = tick + ORB_SPAWN_DELAY_TICKS;
      return;
    }

    this.pose = wakePose;
    if (plan.openingAttackTick !== null && tick >= plan.openingAttackTick) {
      duke.combat.nextActionTick = nextAttackTick;
    }
  }

  createNpcs(): NpcActor[] {
    return [this.createStartWarden()];
  }

  private createStartWarden(): NpcActor {
    const duke = createWarden(WARDEN_TILE, this.startHp, wardenCadence(this.startHp));
    if (this.phaseStartMode === 'awake' && this.startHp <= VENTS_HP) {
      this.restartWardenPhase(duke, this.startHp, SIMULATION_START_TICK, true);
    }
    return duke;
  }

  getNpcDamageSourceLabel(): string {
    return 'Duke Sucellus';
  }

  getEngineRules(): EncounterEngineRules {
    return {
      onPlayerDamageTaken: (info) => {
        if (
          info.effectiveDamage > 0 &&
          (AVOIDABLE_DAMAGE_SOURCES.has(info.source) || info.damageOverTime === 'poison')
        ) {
          this.perfectKillEligible = false;
        }
        return info.source === ORB_DAMAGE_SOURCE && info.effectiveDamage > 0
          ? {
              // https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode
              playerStatDrains: { attack: 8, strength: 8, defence: 8, ranged: 8, magic: 8, agility: 8 },
              prayerPointsDelta: -8,
            }
          : null;
      },
    };
  }

  getOutcome(): EncounterOutcome {
    return this.outcome;
  }

  onNpcDefeated(defeat: EncounterNpcDefeat, ctx: EncounterContext, ownership: EncounterCompletionOwnership): void {
    if (defeat.npcId !== WARDEN_ID) return;
    this.clearHazards();
    emitDukeAudio(ctx.tickEvents, 'defeat', DUKE_CENTER_TILE);
    if (ownership !== 'encounter-owned') return;
    this.outcome = {
      phase: 'resolving',
      decisiveTick: defeat.tick,
      completionTick: defeat.tick + 2,
      primaryActorId: WARDEN_ID,
      completionActorIds: [WARDEN_ID],
    };
  }

  resolveHazards(ctx: EncounterContext): EnvironmentalDamage[] {
    const warden = ctx.world.getNpc(WARDEN_ID);
    if (!warden?.alive) return [];

    this.hazards = this.hazards.filter((hazard) => ctx.tick < visualEndTick(hazard));
    const damages: EnvironmentalDamage[] = [];
    const ventClouds = new Map<string, WardenHazard>();
    for (const [index, hazard] of this.hazards.entries()) {
      const { kind, impactTick, expiresTick, tiles } = hazard;
      if (kind === 'vent') {
        // The replacement smoke NPC spawns a tick before landing and cancels the previous pulse.
        // 20261126-232238-Duke.jsonl:5736–5800.
        if (ctx.tick >= (hazard.landingTick ?? impactTick) - 1) ventClouds.set(tiles[4].join(','), hazard);
        continue;
      }
      if (kind === 'gaze') {
        if (ctx.tick === impactTick - DUKE_GAZE_HIT_DELAY_TICKS) {
          const covered = tiles.some((tile) => sameTile(ctx.playerPos, tile));
          this.hazards[index] = { ...hazard, missed: covered };
          emitDukeAudio(ctx.tickEvents, 'gaze');
          message(
            ctx,
            covered ? "You manage to avoid Duke Sucellus' gaze." : "You failed to avoid Duke Sucellus' gaze.",
          );
        } else if (ctx.tick === impactTick && hazard.missed === false) {
          damages.push(HAZARD_DAMAGE.gaze);
        }
        continue;
      }
      if (kind === 'spikes' || kind === 'gasSpit' || ctx.tick < impactTick || ctx.tick >= expiresTick) continue;
      if (kind === 'magic') {
        const attacker = dukeFormulaActor(warden);
        damages.push({
          ...BOLT_DAMAGE,
          baseDamage: [0, calculateNpcMaxHit(attacker, 'magic')],
          accuracy: attackAccuracy(attacker, ctx, 'magic'),
          onHitRoll: (hit) => {
            this.hazards[index] = { ...hazard, tiles: [ctx.playerPos], missed: !hit };
            // A connected bolt invalidates a perfect kill even if the damage roll is zero.
            if (hit) {
              this.perfectKillEligible = false;
              emitDukeAudio(ctx.tickEvents, 'magic');
              const player = ctx.world.getPlayer();
              if (player) {
                // 20261127-002024-Duke-Sucellus_1.jsonl:8637 attaches graphic 2435 to the player.
                emitEncounterVisual(ctx.tickEvents, {
                  animations: [],
                  projectiles: [],
                  graphics: [
                    { spotAnimId: DUKE_SPOT_ANIMS.magicImpact, target: boltTarget(player), delayCycles: 0, height: 0 },
                  ],
                });
              }
            }
          },
        });
        continue;
      }
      if (kind === 'slam') emitDukeAudio(ctx.tickEvents, kind);
      if (tiles.some((tile) => sameTile(ctx.playerPos, tile))) {
        damages.push(
          kind === 'slam'
            ? { ...SLAM_DAMAGE, baseDamage: [0, calculateNpcMaxHit(dukeFormulaActor(warden), 'melee_crush')] }
            : HAZARD_DAMAGE[kind],
        );
      }
    }
    for (const { tiles, landingTick, impactTick, expiresTick } of ventClouds.values()) {
      if (ctx.tick === landingTick) {
        emitDukeAudio(ctx.tickEvents, 'vent', tiles[4]);
      } else if (
        ctx.tick >= impactTick &&
        ctx.tick < expiresTick &&
        (ctx.tick - impactTick) % DUKE_VENT_SMOKE_CYCLE_TICKS === 0
      ) {
        emitDukeAudio(ctx.tickEvents, 'ventIdle', tiles[4]);
        // 20261127-022231-Duke-Sucellus_7.jsonl:5529–5607. Only the smoke pulses hit.
        if (tiles.some((tile) => sameTile(ctx.playerPos, tile))) damages.push(HAZARD_DAMAGE.vent);
      }
    }

    const bileCastTick = this.bileThroughTick - BILE_TICKS;
    if (ctx.tick > bileCastTick && ctx.tick <= this.bileThroughTick) {
      this.dropBile(ctx, ctx.playerPos);
      const path = ctx.world.getPlayer()?.movementPath;
      // 20261127-192944-Duke-Sucellus_12.jsonl:4708–4732. Movement on the cast tick precedes the trail.
      if (ctx.tick > bileCastTick + 1 && path && path.length > 1) this.dropBile(ctx, path[0]);
    }

    const orbDamage = this.resolveOrb(ctx, warden.vitals.hp);
    if (orbDamage) damages.push(orbDamage);
    return damages;
  }

  acceptsInput(input: EncounterInput, ctx: EncounterEngineContext): boolean {
    return (
      input.kind === 'npcInteraction' &&
      input.targetId === WARDEN_ID &&
      ctx.world.getNpc(WARDEN_ID)?.npcTypeId === DUKE_ASLEEP_NPC_ID
    );
  }

  onNpcInteraction({ targetId }: EncounterNpcInteraction, ctx: EncounterContext): void {
    const player = ctx.world.getPlayer();
    const duke = ctx.world.getNpc(targetId);
    if (!player?.alive || !duke?.alive || duke.npcTypeId !== DUKE_ASLEEP_NPC_ID) return;
    const plan = getWardenPlan(duke);
    if (!plan || plan.openingAttackTick !== null) return;

    const slot = player.inventory.findIndex((item) => item?.id === ARDER_MUSCA_POISON_ITEM_ID);
    const quantity = getFiniteStackQuantity(player.inventory[slot]);
    if (quantity === undefined) {
      message(ctx, 'You need Arder-musca poison to feed Duke.');
      return;
    }
    const inventory = [...player.inventory];
    inventory[slot] = quantity > 1 ? { id: ARDER_MUSCA_POISON_ITEM_ID, quantity: quantity - 1 } : null;
    player.inventory = inventory;
    plan.poisonToleranceFilled = Math.min(DUKE_POISON_TOLERANCE, plan.poisonToleranceFilled + DUKE_POISON_PER_DOSE);
    emitDukeAudio(ctx.tickEvents, 'feed');
    if (plan.poisonToleranceFilled === DUKE_POISON_TOLERANCE) {
      plan.openingAttackTick = ctx.tick + DUKE_WAKE_AFTER_FEED_TICKS + DUKE_FIRST_ATTACK_DELAY_TICKS;
      message(ctx, 'Duke is waking up.');
    } else {
      message(ctx, `Poison tolerance ${plan.poisonToleranceFilled}/${DUKE_POISON_TOLERANCE}.`);
    }
  }

  // Attack-only replays and combat drivers use the original quick start.
  onPlayerAttackStarted(info: EncounterPlayerAttackStartedInfo, ctx: EncounterPlayerAttackContext): void {
    if (info.targetId !== WARDEN_ID) return;
    const duke = ctx.world.getNpc(WARDEN_ID);
    if (!duke?.alive || duke.npcTypeId !== DUKE_ASLEEP_NPC_ID) return;
    const plan = getWardenPlan(duke);
    if (!plan || plan.openingAttackTick !== null) return;
    plan.openingAttackTick = info.tick + DUKE_FIRST_ATTACK_DELAY_TICKS;
    this.playPose(ctx.tickEvents, info.tick, 'wake');
    emitDukeAudio(ctx.tickEvents, 'wake', DUKE_CENTER_TILE);
  }

  onPlayerAttackResolved(info: EncounterPlayerAttackInfo, { tickEvents }: EncounterPlayerAttackContext): void {
    if (info.targetId !== WARDEN_ID || this.lastIncomingHitTick === info.tick) return;
    this.lastIncomingHitTick = info.tick;
    // The first splat decides the cue, even when it blocks and the later Scythe splats land.
    // 20261127-025030-Duke-Sucellus_10.jsonl:6165–6167 and :6674–6680.
    if (info.effectiveDamage > 0) emitDukeAudio(tickEvents, 'dukeHit', DUKE_CENTER_TILE);
  }

  processNpcTick(actor: NpcActor, ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): EncounterTickResult {
    const plan = getWardenPlan(actor);
    if (!plan || plan.openingAttackTick === null) return { environmentalDamages: [] };
    const wakeTick = plan.openingAttackTick - DUKE_FIRST_ATTACK_DELAY_TICKS;
    if (actor.npcTypeId === DUKE_ASLEEP_NPC_ID) {
      if (plan.poisonToleranceFilled === DUKE_POISON_TOLERANCE && ctx.tick >= wakeTick) {
        actor.npcTypeId = DUKE_NPC_ID;
        this.playPose(ctx.tickEvents, wakeTick, 'wake');
        emitDukeAudio(ctx.tickEvents, 'wake', DUKE_CENTER_TILE);
      } else if (ctx.tick >= wakeTick + DUKE_WAKE_ANIMATION_TICKS) {
        actor.npcTypeId = DUKE_NPC_ID;
        this.pose = undefined;
      }
    }
    if (ctx.tick < plan.openingAttackTick || ctx.tick < actor.combat.nextActionTick) {
      return { environmentalDamages: [] };
    }

    const hp = actor.vitals.hp;
    const alwaysBile = mechanics[DUKE_ALWAYS_BILE_KEY] === true;
    actor.combat.attackSpeed = wardenCadence(hp);
    actor.combat.nextActionTick = ctx.tick + actor.combat.attackSpeed;
    if (plan.bileQueued) {
      plan.bileQueued = false;
      this.beginBile(ctx);
      return { environmentalDamages: [] };
    }

    if (plan.flaresRemaining > 0) {
      this.launchFlare(actor, plan, ctx, alwaysBile);
    } else if (plan.autosSinceGaze === 5) {
      // The gaze comes after five basics and takes six ticks from windup to next action.
      // https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Fight_overview
      this.schedule('gaze', COVER_TILES, ctx.tick + DUKE_GAZE_COVER_CHECK_TICKS + DUKE_GAZE_HIT_DELAY_TICKS);
      this.playPose(ctx.tickEvents, ctx.tick, 'gaze');
      emitDukeAudio(ctx.tickEvents, 'gazeWindup', DUKE_CENTER_TILE);
      actor.combat.nextActionTick = ctx.tick + DUKE_GAZE_DURATION_TICKS;
      plan.autosSinceGaze = 0;
      // The first flare follows three basics after the first Gaze.
      // 20261127-002024-Duke-Sucellus_1.jsonl:5148–5470 (ticks 41–62).
      plan.autosUntilGas ??= 3;
      plan.basicAfterGaze = true;
      message(ctx, 'Freezing gaze. Move behind a pillar onto a teal tile.');
    } else if (plan.autosUntilGas === 0 && !plan.basicAfterGaze) {
      // A basic follows Gaze and then the due volley begins.
      // 20261126-232238-Duke.jsonl, ticks 139–150.
      plan.flaresRemaining = hp <= VENTS_HP ? 4 : 1;
      plan.autosUntilGas = wardenGasInterval(hp);
      this.launchFlare(actor, plan, ctx, alwaysBile);
    } else {
      plan.autosSinceGaze++;
      if (plan.autosUntilGas !== null) plan.autosUntilGas = Math.max(0, plan.autosUntilGas - 1);
      plan.basicAfterGaze = false;
      // A same-tick step into cover is too late: 20261126-232238-Duke.jsonl:6911–6937.
      if (isInMeleeLane(ctx.playerPos)) {
        this.schedule('spikes', square(ctx.playerPos, 1), ctx.tick);
        this.schedule('slam', SLAM_TILES, ctx.tick + DUKE_SLAM_IMPACT_DELAY_TICKS);
        this.playPose(ctx.tickEvents, ctx.tick, 'slam', {
          graphics: [
            // Graphic 2439 has its frontal offset baked relative to Duke's center.
            {
              spotAnimId: DUKE_SPOT_ANIMS.npcIcicles,
              target: { kind: 'tile', position: DUKE_CENTER_TILE },
              delayCycles: 0,
              height: 0,
            },
            ...SLAM_TILES.map((position, index) => ({
              spotAnimId: DUKE_GROUND_ICICLES[index],
              target: { kind: 'tile' as const, position },
              delayCycles: 0,
              height: 0,
            })),
          ],
        });
        emitDukeAudio(ctx.tickEvents, 'slamWindup', DUKE_CENTER_TILE);
        const accuracy = attackAccuracy(dukeFormulaActor(actor), ctx, 'melee_crush');
        return { environmentalDamages: [{ ...HAZARD_DAMAGE.spikes, accuracy }] };
      } else {
        const impactTick = ctx.tick + DUKE_MAGIC_FLIGHT_TICKS;
        this.hazards.push({
          kind: 'magic',
          tiles: [ctx.playerPos],
          impactTick,
          expiresTick: impactTick + 1,
          windupTick: ctx.tick,
        });
        const player = ctx.world.getPlayer();
        const { startCycle, endCycle, ...flight } = DUKE_MAGIC_PROJECTILE;
        this.playPose(ctx.tickEvents, ctx.tick, 'magic', {
          projectiles: player
            ? [
                {
                  ...flight,
                  spotAnimId: DUKE_SPOT_ANIMS.magicProjectile,
                  sourcePosition: DUKE_MOUTH_POSITION,
                  target: boltTarget(player),
                  startDelayCycles: startCycle,
                  endDelayCycles: endCycle,
                },
              ]
            : [],
        });
        emitDukeAudio(ctx.tickEvents, 'magicLaunch', DUKE_CENTER_TILE);
      }
    }
    return { environmentalDamages: [] };
  }

  private playPose(
    tickEvents: TickEvents,
    tick: number,
    clip: DukePose['clip'],
    { graphics = [], projectiles = [] }: Partial<Pick<EncounterVisualBatch, 'graphics' | 'projectiles'>> = {},
  ): void {
    this.pose = { clip, startTick: tick };
    emitEncounterVisual(tickEvents, {
      animations: [{ actorId: WARDEN_ID, clipId: clip, delayCycles: 0 }],
      projectiles,
      graphics,
    });
  }

  private launchFlare(actor: NpcActor, plan: WardenPlan, ctx: EncounterContext, alwaysBile: boolean): void {
    const landingTick = ctx.tick + DUKE_GAS_FLIGHT_TICKS;
    const impactTick = landingTick + DUKE_VENT_ARM_TICKS;
    const hp = actor.vitals.hp;
    const activeTicks = hp <= ENRAGE_HP ? DUKE_ENRAGED_VENT_ACTIVE_TICKS : DUKE_VENT_ACTIVE_TICKS;
    // A grate is blocked from landing through the last active smoke tick.
    // In-flight shots can share it (20261126-232238-Duke.jsonl:5694–5746).
    // A grate is eligible again during the fade (20261127-005253-Duke-Sucellus_2.jsonl:11672–12060).
    const smokingVents = new Set(
      this.hazards
        .filter(
          ({ kind, landingTick, expiresTick }) =>
            kind === 'vent' && landingTick !== undefined && landingTick <= ctx.tick && ctx.tick < expiresTick,
        )
        .map(({ tiles }) => tiles[4].join(',')),
    );
    this.hazards.push({
      kind: 'vent',
      tiles: square(targetedVent(ctx.playerPos, smokingVents), 1),
      windupTick: ctx.tick,
      landingTick,
      impactTick,
      expiresTick: impactTick + activeTicks,
    });
    this.playPose(ctx.tickEvents, ctx.tick, 'fastMagic');
    emitDukeAudio(ctx.tickEvents, 'ventLaunch', DUKE_CENTER_TILE);
    const firstOfFour = plan.flaresRemaining === 4;
    if (firstOfFour) message(ctx, 'Gas flares. Run south to bait the rest of the volley.');
    plan.flaresRemaining--;
    if (plan.flaresRemaining > 0) {
      // Awakened spit windups around 3:24–3:29: https://www.youtube.com/watch?v=h-Pqf0Y0td4&t=203s
      actor.combat.nextActionTick = ctx.tick + (firstOfFour ? 3 : 2);
      return;
    }
    plan.bileQueued = alwaysBile || (hp <= BILE_HP && this.bileRandom() < BILE_CHANCE);
    if (hp <= VENTS_HP) message(ctx, 'Last flare launched.');
    if (hp <= VENTS_HP || plan.bileQueued) {
      // 20261127-005253-Duke-Sucellus_2.jsonl: bile follows the last flare at 123–127 and 423–426.
      actor.combat.nextActionTick = ctx.tick + actor.combat.attackSpeed - 1;
    }
  }

  private beginBile(ctx: EncounterContext): void {
    this.bileThroughTick = ctx.tick + BILE_TICKS;
    // 20261126-232238-Duke.jsonl:6554–6590 and :7537–7579.
    this.playPose(ctx.tickEvents, ctx.tick, 'bile');
    emitDukeAudio(ctx.tickEvents, 'bile', DUKE_CENTER_TILE);
    message(ctx, 'Bile is dripping onto the floor. Keep moving to leave the pools behind.');
  }

  private dropBile(ctx: EncounterContext, tile: Coordinate): void {
    if (this.hazards.some((hazard) => hazard.kind === 'bile' && sameTile(hazard.tiles[0], tile))) return;
    this.schedule('bile', [tile], ctx.tick + 1, BILE_POOL_TICKS - 1);
  }

  private schedule(kind: WardenHazardKind, tiles: readonly Coordinate[], impactTick: number, duration = 1): void {
    this.hazards.push({ kind, tiles, impactTick, expiresTick: impactTick + duration });
  }

  private resolveOrb(ctx: EncounterContext, hp: number): EnvironmentalDamage | undefined {
    this.orbBursts = this.orbBursts.filter(({ tick }) => ctx.tick < tick + ORB_BURST_TICKS);
    if (hp > ORB_HP) {
      this.nextOrbTick = null;
      this.orb = null;
      return;
    }

    // Contact at the end of one tick deals damage and removes the orb on the next.
    // 20261127-005253-Duke-Sucellus_2.jsonl, ticks 266–267 and 332–333.
    const previousTile = this.orbTile(ctx.tick - 1);
    if (previousTile) {
      const hit = sameTile(ctx.playerPos, previousTile);
      const nextTile = this.orbTile(ctx.tick);
      if (hit || !nextTile) {
        this.orb = null;
        this.orbBursts.push({ tick: ctx.tick, tile: previousTile });
      }
      if (hit) {
        // The contact sound originates one tile ahead of the burst (20261127-023028-Duke-Sucellus_8.jsonl:9004–9005).
        emitDukeAudio(ctx.tickEvents, 'orbHit', nextTile ?? previousTile);
        // 35 isolated nonlethal contacts span 25–27. See docs/encounters/duke-unverified.md.
        return { source: ORB_DAMAGE_SOURCE, attackType: 'typeless', baseDamage: [25, 27] };
      }
    }

    if (ctx.tick !== this.nextOrbTick) return;
    // Both openers and repeated sides are observed. Practice rolls an even chance each spawn.
    const eastbound = this.orbRandom() < 0.5;
    const tile: Coordinate = [eastbound ? ORB_LANE.west : ORB_LANE.east, ORB_LANE.y];
    this.orb = { startTick: ctx.tick, eastbound };
    this.orbBursts.push({ tick: ctx.tick, tile });
    emitDukeAudio(ctx.tickEvents, 'orbSpawn', tile);
    this.nextOrbTick = ctx.tick + ORB_PERIOD;
  }

  private orbTile(tick: number): Coordinate | null {
    if (!this.orb) return null;
    const distance = tick - this.orb.startTick;
    if (distance < 0 || distance > ORB_LANE.east - ORB_LANE.west) return null;
    return [this.orb.eastbound ? ORB_LANE.west + distance : ORB_LANE.east - distance, ORB_LANE.y];
  }

  processPostTick(ctx: EncounterContext): EnvironmentalDamage[] {
    if (this.outcome.phase === 'resolving' && ctx.tick >= this.outcome.completionTick && ctx.world.getPlayer()?.alive) {
      this.outcome = { ...this.outcome, phase: 'victory' };
      if (this.perfectKillEligible) message(ctx, 'Perfect kill.');
    }
    const warden = ctx.world.getNpc(WARDEN_ID);
    if (ctx.tick === 1 && warden?.npcTypeId === DUKE_ASLEEP_NPC_ID) {
      message(ctx, 'Feed Duke three Arder-musca poisons to wake him.');
    }
    if (warden?.alive && warden.vitals.hp <= ORB_HP && this.nextOrbTick === null) {
      const openingAttackTick = getWardenPlan(warden)?.openingAttackTick;
      if (openingAttackTick != null && ctx.tick > openingAttackTick) {
        // Count from the HP change, including hits after the NPC band.
        // 20261127-005253-Duke-Sucellus_2.jsonl, ticks 225–228.
        this.nextOrbTick = ctx.tick + ORB_SPAWN_DELAY_TICKS;
        message(ctx, 'Orbs of darkness will sweep across the front lane.');
      }
    }
    return [];
  }

  getSnapshot(ctx: EncounterSnapshotContext): Extract<EncounterSnapshot, { kind: typeof DUKE_KIND }> {
    const warden = ctx.world.getNpc(WARDEN_ID);
    const plan = warden ? getWardenPlan(warden) : undefined;
    const fadingEffects = this.hazards.filter(({ expiresTick }) => ctx.tick >= expiresTick);
    const orbTile = this.orbTile(ctx.tick);
    // 20261127-022231-Duke-Sucellus_7.jsonl:9385–9404 shows visible positions between true tiles.
    const orbPreviousTile = orbTile && this.orbTile(ctx.tick - 1);
    return {
      kind: this.kind,
      state: {
        ...(warden?.npcTypeId === DUKE_ASLEEP_NPC_ID
          ? { poisonToleranceFilled: plan?.poisonToleranceFilled ?? 0 }
          : {}),
        bileTicksRemaining: Math.max(0, this.bileThroughTick - ctx.tick),
        enraged: !!warden?.alive && warden.vitals.hp <= ENRAGE_HP,
        perfectKillEligible: this.perfectKillEligible,
      },
      visuals: {
        hazards: this.hazards.filter(({ expiresTick }) => ctx.tick < expiresTick),
        orbTile,
        usesVisualEvents: true,
        ...(orbPreviousTile ? { orbPreviousTile } : {}),
        ...(this.orbBursts.length ? { orbBursts: [...this.orbBursts] } : {}),
        ...(this.pose ? { pose: this.pose } : {}),
        ...(fadingEffects.length ? { fadingEffects } : {}),
      },
    };
  }
}
