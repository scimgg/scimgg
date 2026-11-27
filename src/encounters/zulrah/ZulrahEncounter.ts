import { type NpcActor, submergeNpc } from '../../core/actors/NpcActor';
import type { ArenaConfig } from '../../core/arena/ArenaConfig';
import { getDefaultArenaConfig, isWalkableTile } from '../../core/constants';
import { ACTIVE_ENCOUNTER_OUTCOME, type EncounterOutcome } from '../../core/encounters/outcome';
import type { EncounterSnapshotContext, ZulrahSnapshot } from '../../core/encounters/snapshot';
import type {
  Encounter,
  EncounterCompletionOwnership,
  EncounterContext,
  EncounterEngineRules,
  EncounterNpcDefeat,
  EncounterTickResult,
  EnvironmentalDamage,
} from '../../core/encounters/types';
import { NpcDefinitionCollection, type NpcDefinitionContext } from '../../core/npcs';
import { mulberry32 } from '../../core/rng';
import { getMonsterHp } from '../../data/monsterData';
import { emitInfernoVisual } from '../../npcs/inferno/visualEvents';
import { SNAKELING, ZULRAH_CLOUD, ZULRAH_RANGED_NPC_ID } from '../../npcs/zulrah/constants';
import {
  createSnakeling,
  type SnakelingStyle,
  snakelingDefinition,
  snakelingExpireTick,
} from '../../npcs/zulrah/snakeling';
import { createZulrahActor, getZulrahState, transformZulrah, zulrahDefinition } from '../../npcs/zulrah/zulrah';
import type { Coordinate, MechanicsConfig } from '../../types/simulation';
import {
  fillCloudSites,
  isInCloud,
  liveClouds,
  pickCloudSites,
  ZULRAH_FILL_BARRAGES,
  type ZulrahCloud,
} from './clouds';
import {
  buildZulrahControls,
  ZULRAH_ATTACKS_KEY,
  ZULRAH_CLOUDS_KEY,
  ZULRAH_ROTATION_KEY,
  ZULRAH_SNAKELINGS_KEY,
  ZULRAH_VENOM_KEY,
  zulrahRotationPin,
} from './controls';
import {
  nextZulrahPosition,
  ZULRAH_DIVE_TICKS,
  ZULRAH_EMERGE_TICKS,
  ZULRAH_OPENING_PAUSE_TICKS,
  ZULRAH_OPENING_POSITION,
  ZULRAH_OPENING_RISE_TICKS,
  ZULRAH_ROTATION_NUMBERS,
  ZULRAH_ROTATIONS,
  ZULRAH_SPOTS,
  ZULRAH_SURFACE_PAUSE_TICKS,
  ZULRAH_UNDERWATER_TICKS,
  type ZulrahPosition,
  type ZulrahRotationNumber,
  zulrahPhaseActions,
  zulrahPhaseAt,
} from './rotation';
import type { ZulrahStage } from './snapshot';

/** Zulrah is one actor for the whole fight; each form change transforms it in place. */
export const ZULRAH_ACTOR_ID = 'zulrah';

/** On the island's base, centred between the arms. Wiki tile-marker (28, 61) in region 9007. */
export const ZULRAH_PLAYER_START: Coordinate = [28, 61];
const VICTORY_COMPLETION_DELAY_TICKS = 4;
/**
 * Tanzanite's magic share. Simulator policy: the wiki says only "uses magic much more frequently"
 * (https://oldschool.runescape.wiki/w/Zulrah/Strategies).
 */
const TANZANITE_MAGIC_CHANCE = 0.75;

type PhaseRuntime = {
  /** Phases surfaced since the fight began, counting from 0. */
  index: number;
  position: ZulrahPosition;
  /** Cloud barrages spat so far this phase. */
  cloudBarrages: number;
  actorId: string;
  stage: ZulrahStage;
  /** Tick the current stage ends: emerge → active, idle phase → dive, dive → next form. */
  stageEndTick: number | null;
  hp: number;
};

/** Keep the rotation and cloud-site draws on their own streams, apart from the attack rolls. */
const ROTATION_STREAM_SALT = 0x5a55_4c52;
const CLOUD_STREAM_SALT = 0x434c_4f55;
const SNAKELING_STREAM_SALT = 0x534e_414b;

/** A snakeling orb in flight: where it lands, when, and what comes out. */
type PendingSnakeling = { readonly tile: Coordinate; readonly landTick: number; readonly style: SnakelingStyle };

/**
 * Zulrah: the four rotations with ranged, magic, jad and tail phases. Zulrah is one actor that dives,
 * stays hidden underwater, and transforms into its next form at its next spot (`transformZulrah`), so
 * its HP and any hits still in flight carry across forms.
 */
export class ZulrahEncounter implements Encounter {
  public readonly kind = 'zulrah';

  private readonly maxHp: number;
  private encounterSeed: number;
  private random: () => number;
  private rotationRandom: () => number;
  private cloudRandom: () => number;
  /** Clouds in flight or on the island. */
  private clouds: ZulrahCloud[] = [];
  private cloudsEnabled = true;
  private snakelingRandom: () => number;
  private pendingSnakelings: PendingSnakeling[] = [];
  private snakelingsEnabled = true;
  private venomEnabled = true;
  /** Whether the opening form's rise (SNAKEBOSS_SPAWN) has been cued. */
  private openingRiseCued = false;
  /** Where the player stood when the fight was built: moving off it counts as acting. */
  private snakelingCounter = 0;
  /** The setup's rotation pin; null picks each rotation at random. */
  private rotationPin: ZulrahRotationNumber | null = null;
  private phase: PhaseRuntime;
  private outcome: EncounterOutcome = ACTIVE_ENCOUNTER_OUTCOME;
  private attacksEnabled = true;
  /** The player is stunned (no moving or attacking) through the tick before this one. */
  private stunUntilTick = 0;
  private readonly engineRules: EncounterEngineRules = {
    playerStunned: (ctx) => ctx.tick < this.stunUntilTick,
  };
  private npcDefinitions: NpcDefinitionCollection;

  constructor(encounterSeed = Math.floor(Math.random() * 0x100000000)) {
    const maxHp = getMonsterHp(ZULRAH_RANGED_NPC_ID);
    if (maxHp === undefined) throw new TypeError('Missing Zulrah monster HP');
    this.maxHp = maxHp;
    this.encounterSeed = encounterSeed >>> 0;
    this.random = mulberry32(this.encounterSeed);
    this.rotationRandom = mulberry32(this.encounterSeed ^ ROTATION_STREAM_SALT);
    this.cloudRandom = mulberry32(this.encounterSeed ^ CLOUD_STREAM_SALT);
    this.snakelingRandom = mulberry32(this.encounterSeed ^ SNAKELING_STREAM_SALT);
    this.phase = this.initialPhase();
    this.npcDefinitions = this.createNpcDefinitions();
  }

  readonly runStartMechanicsKeys = [ZULRAH_ROTATION_KEY] as const;

  /** Stores the rotation pin. Phase 1 is shared by all four, so nothing is rebuilt and no draw is made. */
  configureRunStart(mechanics: Readonly<Partial<MechanicsConfig>>): void {
    this.rotationPin = zulrahRotationPin(mechanics);
  }

  getDefaultPlayerStart(): Coordinate {
    return [...ZULRAH_PLAYER_START];
  }

  getIntroConfig(): null {
    return null;
  }

  /**
   * Zulrah starts underwater, hidden and untargetable, and `processPostTick` raises it on the fight's
   * first tick. Reported from play: it rises without waiting for the player to act (the wiki's "as soon
   * as the player continues the dialogue or performs an action" is the boat dialogue, which the
   * simulator skips).
   */
  createNpcs(_playerStart: Coordinate): NpcActor[] {
    this.openingRiseCued = false;
    this.phase = { ...this.initialPhase(), stage: 'submerged', stageEndTick: null };
    const zulrah = this.createPhaseActor(ZULRAH_OPENING_POSITION, 0, this.maxHp);
    zulrah.hidden = true;
    submergeNpc(zulrah, Number.MAX_SAFE_INTEGER);
    zulrah.combat.nextActionTick = Number.MAX_SAFE_INTEGER;
    return [zulrah];
  }

  /** Raises the opening form on SNAKEBOSS_SPAWN, as if it had surfaced this tick. */
  private riseForOpening(actor: NpcActor, ctx: EncounterContext): void {
    const phase = zulrahPhaseAt(ZULRAH_OPENING_POSITION);
    transformZulrah(actor, {
      form: phase.form,
      mode: phase.mode,
      actions: zulrahPhaseActions(phase),
      position: [...ZULRAH_SPOTS[phase.spot]],
      spawnTick: ctx.tick,
      emergeTicks: ZULRAH_OPENING_RISE_TICKS,
    });
    // It stays up, targetable, for the opening pause before its first barrage.
    actor.combat.nextActionTick = ctx.tick + ZULRAH_OPENING_RISE_TICKS + ZULRAH_OPENING_PAUSE_TICKS;
    this.phase.stage = 'emerging';
    this.phase.stageEndTick = ctx.tick + ZULRAH_OPENING_RISE_TICKS;
    this.openingRiseCued = true;
    emitInfernoVisual(ctx.tickEvents, {
      animations: [{ actorId: actor.id, clipId: 'spawn', delayCycles: 0 }],
      projectiles: [],
      graphics: [],
    });
  }

  reset(seeds?: Record<string, unknown>): void {
    const seed = seeds?.encounterSeed;
    this.encounterSeed =
      typeof seed === 'number' && Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff
        ? seed
        : Math.floor(Math.random() * 0x100000000);
    this.random = mulberry32(this.encounterSeed);
    this.rotationRandom = mulberry32(this.encounterSeed ^ ROTATION_STREAM_SALT);
    this.cloudRandom = mulberry32(this.encounterSeed ^ CLOUD_STREAM_SALT);
    this.snakelingRandom = mulberry32(this.encounterSeed ^ SNAKELING_STREAM_SALT);
    this.pendingSnakelings = [];
    this.snakelingCounter = 0;
    this.clouds = [];
    this.phase = this.initialPhase();
    this.outcome = ACTIVE_ENCOUNTER_OUTCOME;
    this.attacksEnabled = true;
    this.stunUntilTick = 0;
    this.npcDefinitions = this.createNpcDefinitions();
  }

  getSeeds(): { encounterSeed: number } {
    return { encounterSeed: this.encounterSeed };
  }

  getNpcDefinitions(): NpcDefinitionCollection {
    return this.npcDefinitions;
  }

  /** One cloud hit per tick while the player stands in any landed cloud. */
  resolveHazards(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): EnvironmentalDamage[] {
    this.clouds = liveClouds(this.clouds, ctx.tick);
    if (this.phase.stage === 'defeated' || mechanics[ZULRAH_CLOUDS_KEY] === false) return [];
    if (!this.clouds.some((cloud) => isInCloud(ctx.playerPos, cloud, ctx.tick))) return [];
    return [
      {
        baseDamage: ZULRAH_CLOUD.damage,
        attackType: 'typeless',
        source: 'Zulrah venom cloud',
        playerPosition: [...ctx.playerPos],
      },
    ];
  }

  processNpcTick(actor: NpcActor, ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): EncounterTickResult {
    this.attacksEnabled = mechanics[ZULRAH_ATTACKS_KEY] !== false;
    this.cloudsEnabled = mechanics[ZULRAH_CLOUDS_KEY] !== false;
    this.snakelingsEnabled = mechanics[ZULRAH_SNAKELINGS_KEY] !== false;
    this.venomEnabled = mechanics[ZULRAH_VENOM_KEY] !== false;
    if (this.phase.stage === 'defeated') return { environmentalDamages: [] };
    if (actor.id !== this.phase.actorId && !snakelingDefinition.isActor(actor)) return { environmentalDamages: [] };
    return this.npcDefinitions.tick(actor, this.toDefinitionContext(ctx));
  }

  /** A snakeling that has lingered `SNAKELING.lifetimeTicks` dies off. */
  removeNpcIfDue(actor: NpcActor, ctx: EncounterContext): void {
    const expireTick = snakelingExpireTick(actor);
    if (expireTick !== null && ctx.tick >= expireTick) ctx.despawnNpc(actor.id);
  }

  /** Advances the phase machine once the tick's attacks are out. */
  processPostTick(ctx: EncounterContext, _mechanics: Partial<MechanicsConfig>): EnvironmentalDamage[] {
    if (this.outcome.phase === 'resolving' && ctx.tick >= this.outcome.completionTick) {
      this.outcome = { ...this.outcome, phase: 'victory' };
    }
    const phase = this.phase;
    if (phase.stage === 'defeated') return [];
    this.landSnakelings(ctx);
    const actor = ctx.world.getNpc(phase.actorId);
    if (actor && !this.openingRiseCued) {
      // The fight's first tick; later forms surface on EMERGEFAST instead.
      this.riseForOpening(actor, ctx);
      return [];
    }
    if (actor) phase.hp = actor.vitals.hp;

    switch (phase.stage) {
      case 'emerging':
        if (phase.stageEndTick !== null && ctx.tick >= phase.stageEndTick) {
          phase.stage = 'active';
          phase.stageEndTick = null;
          // Reported from play: after a form change she plays her attack animation with no attack
          // (the "bob"), the visual cue that she can be clicked again. Not on the opening rise, and
          // not as the melee (magma) form, which only plays it for a cloud or snakeling spit.
          if (actor && phase.index > 0 && getZulrahState(actor)?.form !== 'magma') {
            emitInfernoVisual(ctx.tickEvents, {
              animations: [{ actorId: actor.id, clipId: 'attack', delayCycles: 0 }],
              projectiles: [],
              graphics: [],
            });
          }
        }
        break;
      case 'active':
        if (this.isPhaseDone(actor, ctx.tick)) this.startDive(actor, ctx);
        break;
      case 'diving':
        if (phase.stageEndTick !== null && ctx.tick >= phase.stageEndTick) this.goUnderwater(ctx);
        break;
      case 'submerged':
        if (phase.stageEndTick !== null && ctx.tick >= phase.stageEndTick) this.surfaceNextForm(ctx);
        break;
      default:
        break;
    }
    return [];
  }

  getSnapshot(_ctx: Pick<EncounterSnapshotContext, 'tick' | 'mechanics'>): ZulrahSnapshot {
    const { position } = this.phase;
    const current = zulrahPhaseAt(position);
    return {
      kind: 'zulrah',
      state: {
        phaseIndex: this.phase.index,
        rotation: position.rotation,
        phaseInRotation: position.index + 1,
        rotationLength: ZULRAH_ROTATIONS[position.rotation ?? 1].length,
        form: current.form,
        spot: current.spot,
        stage: this.phase.stage,
        hp: this.phase.hp,
      },
      visuals: {
        clouds: this.clouds.map((cloud) => ({
          center: [cloud.center[0], cloud.center[1]] as const,
          landTick: cloud.landTick,
          expireTick: cloud.expireTick,
        })),
      },
    };
  }

  onNpcDefeated(defeat: EncounterNpcDefeat, ctx: EncounterContext, ownership: EncounterCompletionOwnership): void {
    if (defeat.npcId !== this.phase.actorId || this.phase.stage === 'defeated') return;
    // Its snakelings die with it (wiki, Zulrah/Strategies), and no more land.
    this.pendingSnakelings = [];
    for (const npc of ctx.world.getNpcs()) {
      if (snakelingDefinition.isActor(npc)) ctx.despawnNpc(npc.id);
    }
    this.phase.stage = 'defeated';
    this.phase.hp = 0;
    this.phase.stageEndTick = null;
    ctx.world.removePendingHitsBySource(defeat.npcId);
    if (ownership === 'encounter-owned') {
      this.outcome = {
        phase: 'resolving',
        decisiveTick: defeat.tick,
        completionTick: defeat.tick + VICTORY_COMPLETION_DELAY_TICKS,
        primaryActorId: defeat.npcId,
        completionActorIds: [defeat.npcId],
      };
    }
  }

  getOutcome(): EncounterOutcome {
    return this.outcome;
  }

  getEngineRules(): EncounterEngineRules {
    return this.engineRules;
  }

  getDefaultMechanicsConfig(): Partial<MechanicsConfig> {
    return buildZulrahControls().defaultMechanicsConfig;
  }

  getNpcDamageSourceLabel(): string {
    return 'ZulrahAttack';
  }

  getArenaConfig(): ArenaConfig {
    return getDefaultArenaConfig();
  }

  private initialPhase(): PhaseRuntime {
    return {
      index: 0,
      position: ZULRAH_OPENING_POSITION,
      cloudBarrages: 0,
      actorId: ZULRAH_ACTOR_ID,
      stage: 'emerging',
      stageEndTick: ZULRAH_OPENING_RISE_TICKS,
      hp: this.maxHp,
    };
  }

  private isPhaseDone(actor: NpcActor | null, tick: number): boolean {
    if (!actor) return true;
    const state = getZulrahState(actor);
    if (!state || state.actions.length > 0 || state.pendingTail) return false;
    // Dive once the last turn's effect has landed, so the dive never hides a hit still in the air.
    return tick >= (state.lastImpactTick ?? tick);
  }

  private startDive(actor: NpcActor | null, ctx: EncounterContext): void {
    const diveEnd = ctx.tick + ZULRAH_DIVE_TICKS;
    if (actor) {
      submergeNpc(actor, diveEnd + 1);
      emitInfernoVisual(ctx.tickEvents, {
        animations: [{ actorId: actor.id, clipId: 'dive', delayCycles: 0 }],
        projectiles: [],
        graphics: [],
      });
    }
    this.phase.stage = 'diving';
    this.phase.stageEndTick = diveEnd;
  }

  /**
   * The dive is over: Zulrah is underwater, so it is not drawn and cannot be targeted, but it stays in
   * the world, so hits already in flight still land.
   */
  private goUnderwater(ctx: EncounterContext): void {
    const zulrah = ctx.world.getNpc(this.phase.actorId);
    if (zulrah) {
      zulrah.hidden = true;
      submergeNpc(zulrah, ctx.tick + ZULRAH_UNDERWATER_TICKS + ZULRAH_EMERGE_TICKS + 1);
    }
    this.phase.stage = 'submerged';
    this.phase.stageEndTick = ctx.tick + ZULRAH_UNDERWATER_TICKS;
  }

  /** The next form surfaces: the same actor, transformed, at its next spot. */
  private surfaceNextForm(ctx: EncounterContext): void {
    const position = nextZulrahPosition(this.phase.position, () => this.chooseRotation());
    const zulrah = ctx.world.getNpc(this.phase.actorId);
    if (zulrah) {
      const phase = zulrahPhaseAt(position);
      transformZulrah(zulrah, {
        form: phase.form,
        mode: phase.mode,
        actions: zulrahPhaseActions(phase),
        jadOpening: phase.jadOpening,
        position: [...ZULRAH_SPOTS[phase.spot]],
        spawnTick: ctx.tick,
        emergeTicks: ZULRAH_EMERGE_TICKS,
        firstTurnDelayTicks: ZULRAH_SURFACE_PAUSE_TICKS,
      });
      this.phase.hp = zulrah.vitals.hp;
    }
    this.phase = {
      index: this.phase.index + 1,
      position,
      cloudBarrages: 0,
      actorId: this.phase.actorId,
      stage: 'emerging',
      stageEndTick: ctx.tick + ZULRAH_EMERGE_TICKS,
      hp: this.phase.hp,
    };
  }

  /** The setup's pin, else a uniform draw: the wiki says only that the rotation is "chosen at random". */
  private chooseRotation(): ZulrahRotationNumber {
    if (this.rotationPin !== null) return this.rotationPin;
    const pick = ZULRAH_ROTATION_NUMBERS[Math.floor(this.rotationRandom() * ZULRAH_ROTATION_NUMBERS.length)];
    if (pick === undefined) throw new TypeError('Rotation draw out of range');
    return pick;
  }

  private createPhaseActor(position: ZulrahPosition, tick: number, hp: number): NpcActor {
    const phase = zulrahPhaseAt(position);
    const id = ZULRAH_ACTOR_ID;
    return createZulrahActor({
      id,
      form: phase.form,
      mode: phase.mode,
      actions: zulrahPhaseActions(phase),
      jadOpening: phase.jadOpening,
      position: [...ZULRAH_SPOTS[phase.spot]],
      hp,
      maxHp: this.maxHp,
      spawnTick: tick,
      emergeTicks: tick === 0 ? ZULRAH_OPENING_RISE_TICKS : ZULRAH_EMERGE_TICKS,
    });
  }

  /** Snakeling orbs that have landed become snakelings on their tiles. */
  private landSnakelings(ctx: EncounterContext): void {
    const landed = this.pendingSnakelings.filter((orb) => ctx.tick >= orb.landTick);
    if (landed.length === 0) return;
    this.pendingSnakelings = this.pendingSnakelings.filter((orb) => ctx.tick < orb.landTick);
    for (const orb of landed) {
      ctx.spawnNpc(
        createSnakeling({
          id: `zulrah-snakeling-${this.snakelingCounter++}`,
          style: orb.style,
          position: [orb.tile[0], orb.tile[1]],
          spawnTick: ctx.tick,
        }),
      );
    }
  }

  /**
   * Where a snakeling orb lands. Simulator policy: a walkable tile 1-3 tiles from the player that no
   * orb is already headed for, drawn at random.
   */
  private pickSnakelingTile(player: Coordinate): Coordinate | null {
    const taken = new Set(this.pendingSnakelings.map((orb) => `${orb.tile[0]},${orb.tile[1]}`));
    const candidates: Coordinate[] = [];
    const { landingMinDistance: min, landingMaxDistance: max } = SNAKELING;
    for (let dx = -max; dx <= max; dx++) {
      for (let dy = -max; dy <= max; dy++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy));
        if (distance < min || distance > max) continue;
        const tile: Coordinate = [player[0] + dx, player[1] + dy];
        if (isWalkableTile(tile[0], tile[1]) && !taken.has(`${tile[0]},${tile[1]}`)) candidates.push(tile);
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(this.snakelingRandom() * candidates.length)] ?? null;
  }

  private createNpcDefinitions(): NpcDefinitionCollection {
    return new NpcDefinitionCollection([
      zulrahDefinition.register({
        tanzaniteMagicChance: TANZANITE_MAGIC_CHANCE,
        attacksEnabled: () => this.attacksEnabled,
        venomEnabled: () => this.venomEnabled,
        stunPlayer: (untilTick) => {
          this.stunUntilTick = Math.max(this.stunUntilTick, untilTick);
        },
        launchCloudBarrage: (_actor, context) => {
          if (!this.cloudsEnabled) return [];
          const player = context.world.getPlayer();
          if (!player) return [];
          const phase = zulrahPhaseAt(this.phase.position);
          const barrages = [...(phase.before ?? []), ...(phase.after ?? [])].filter((s) => s === 'cloud').length;
          const index = this.phase.cloudBarrages++;
          const sites =
            barrages === ZULRAH_FILL_BARRAGES
              ? fillCloudSites(index)
              : pickCloudSites(player.position, this.cloudRandom);
          const landTick = context.tick + ZULRAH_CLOUD.flightTicks;
          for (const center of sites) {
            this.clouds.push({ center, landTick, expireTick: landTick + ZULRAH_CLOUD.durationTicks });
          }
          return sites;
        },
        launchSnakelingOrb: (_actor, context) => {
          if (!this.snakelingsEnabled) return null;
          const player = context.world.getPlayer();
          if (!player) return null;
          const tile = this.pickSnakelingTile(player.position);
          if (!tile) return null;
          // Simulator policy: each style equally likely; the wiki says only that each has one.
          const style: SnakelingStyle = this.snakelingRandom() < 0.5 ? 'melee' : 'magic';
          this.pendingSnakelings.push({ tile, landTick: context.tick + SNAKELING.orbFlightTicks, style });
          return tile;
        },
      }),
      snakelingDefinition.register({
        attacksEnabled: () => this.attacksEnabled,
        venomEnabled: () => this.venomEnabled,
      }),
    ]);
  }

  private toDefinitionContext(ctx: EncounterContext): NpcDefinitionContext {
    return { ...ctx, random: this.random };
  }
}
