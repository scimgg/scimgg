import { z } from 'zod';
import type { NpcActor } from '../../core/actors/NpcActor';
import type { ActorId } from '../../core/actors/types';
import type { ArenaConfig } from '../../core/arena/ArenaConfig';
import { enableNpcHitpointRegen } from '../../core/combat/npcRegeneration';
import {
  getArenaAllowUnboundedFallback,
  getCollisionMap,
  isInArena,
  isWalkableTile,
  SIMULATION_START_TICK,
  setArenaConfig,
} from '../../core/constants';
import { contextDecisions, type DecisionRandom, generatorDecisionRandom } from '../../core/decisionRandom';
import type { EncounterCommand } from '../../core/encounters/commands';
import { ACTIVE_ENCOUNTER_OUTCOME, type EncounterOutcome } from '../../core/encounters/outcome';
import type { EncounterSnapshotContext, InfernoSnapshot } from '../../core/encounters/snapshot';
import type {
  Encounter,
  EncounterCommandContext,
  EncounterCommandResult,
  EncounterCompletionOwnership,
  EncounterContext,
  EncounterEngineRules,
  EncounterIntroConfig,
  EncounterNpcDefeat,
  EncounterPracticeRestart,
  EncounterRestartContext,
  EncounterRunStartContext,
  EncounterTickResult,
  EnvironmentalDamage,
  NpcMovementRequest,
} from '../../core/encounters/types';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { isNpcLiving } from '../../core/npcDeath';
import { NpcDefinitionCollection, type NpcDefinitionContext } from '../../core/npcs';
import type { WorldState } from '../../core/WorldState';
import { ZUK_ACTOR_ID, ZUK_JAD_NPC_ID, ZUK_SHIELD_NPC_ID } from '../../npcs/inferno/constants';
import {
  INFERNO_WAVE_JAD_SCHEDULE,
  type InfernoCorpse,
  jalMejRahDrainEffect,
  removeInfernoNpcIfDue,
  resurrectableSpecies,
} from '../../npcs/inferno/waveNpcs';
import { CollisionFlag } from '../../rs/collision/CollisionFlag';
import type { Coordinate, MechanicsConfig } from '../../types/simulation';
import { ZUK_INTRO, ZUK_INTRO_MESSAGES, ZUK_INTRO_RISE_CLIP, ZUK_PLAYER_START } from '../zuk/constants';
import { isZukWaveCommand, ZukWaveDirector, zukWaveRegistrations } from '../zuk/ZukWaveDirector';
import {
  FIRST_INFERNO_WAVE,
  INFERNO_ARENA_BOUNDS,
  INFERNO_KIND,
  INFERNO_LANDING_MESSAGE,
  INFERNO_LANDING_SEQ_ID,
  INFERNO_LANDING_TILE,
  INFERNO_PILLAR_COLLAPSE_NPC_ID,
  INFERNO_PILLAR_NPC_ID,
  INFERNO_PRACTICE_START_TILE,
  LAST_ORDINARY_WAVE,
  LAST_PILLAR_WAVE,
  NEXT_WAVE_DELAY_TICKS,
  PILLAR_COLLAPSE_SOUND_ID,
  startWaveDelayTicks,
  WAVE_MESSAGE_COLOR,
  ZUK_INTRO_DELAY_TICKS,
  ZUK_WAVE,
} from './constants';
import {
  buildInfernoControls,
  INFERNO_DESTROYED_PILLAR_KEYS,
  INFERNO_PINNED_WAVE_KEY,
  INFERNO_SPAWN_LAYOUT_KEY,
  INFERNO_START_TILE_KEY,
  INFERNO_START_WAVE_KEY,
  type InfernoRunSetup,
  resolveInfernoRunSetup,
} from './controls';
import { npcDecisionSeed, pickJadHealerTiles, pickWaveNibblerTarget, planWaveSpawns, waveNpcRandom } from './layout';
import {
  composePillarArena,
  createPillarCollapse,
  createPillarProxy,
  INFERNO_PILLARS,
  type InfernoPillar,
  PILLAR_COLLAPSE_REMOVAL_TICKS,
  PILLAR_MAX_HP,
  type PillarKey,
  pillarCollapseDefinition,
  pillarCollapseHits,
  pillarFootprint,
  pillarProxyDefinition,
} from './pillars';
import type { InfernoWavePhase } from './snapshot';
import {
  INFERNO_WAVE_SPAWNERS,
  type InfernoSpawnOrigin,
  type InfernoWaveNpcKind,
  type InfernoWaveServices,
  type InfernoWaveSpawnRequest,
  infernoWaveRegistrations,
} from './spawners';
import { layoutFromPlacements, serializeSpawnLayout } from './spawnLayout';
import { serializeInfernoStartTile, startTileApplies, validateInfernoStartTile } from './startTile';
// Pure wave facts, shared with the setup control that sends `go-to-wave`, so the clamp a replayed
// command lands on is the same one the picker applied.
import { clampWave } from './waveInfo';

export { buildInfernoControls } from './controls';

const seedSchema = z.number().int().min(0).max(0xffffffff);
/**
 * `attemptSeed` belongs to a restart that keeps the run seed (`npcDecisionSeed`); a run's first
 * attempt, and any restart that draws a new run seed, has none (see inferno-policy.md#seeds).
 */
const seedsSchema = z.object({ runSeed: seedSchema, attemptSeed: seedSchema.optional() }).strict();

type SpawnContext = Pick<EncounterContext, 'tick' | 'world' | 'spawnNpc' | 'despawnNpc' | 'tickEvents' | 'queueNpcHit'>;
type Combatant = { readonly kind: InfernoWaveNpcKind; readonly origin: InfernoSpawnOrigin };
type PillarRuntime = { readonly pillar: InfernoPillar; intact: boolean; proxyId: ActorId | null };

/**
 * The encounter's seeded streams, each opened per wave: the layout and nibbler target from
 * `(runSeed, wave)`, the NPCs' from the attempt's `npcDecisionSeed` and the wave.
 */
export type InfernoDecisionStream = 'layout' | 'nibbler_target' | 'npc';

export interface InfernoEncounterOptions {
  /**
   * Turns each stream the encounter opens into labeled decisions. The default draws them plainly;
   * capture replays substitute constrained decisions over the same streams. Never persisted.
   */
  readonly decisionRandom?: (stream: InfernoDecisionStream, wave: number, next: () => number) => DecisionRandom;
}

type InfernoStage = 'waves' | 'zuk';

function stageOf(wave: number): InfernoStage {
  return wave === ZUK_WAVE ? 'zuk' : 'waves';
}

/** OSRS facing angle: the intro teleport faces the player north, toward Zuk. */
const FACING_NORTH = 1024;
const MELEE_KINDS: ReadonlySet<string> = new Set(['melee_slash', 'melee_stab', 'melee_crush']);

const BLOCKING_FLAGS = CollisionFlag.OBJECT | CollisionFlag.FLOOR_BLOCKED;

function newSeed(): number {
  return Math.floor(Math.random() * 0x100000000);
}

function isTileOpen(x: number, y: number): boolean {
  return isInArena(x, y) && isWalkableTile(x, y) && getCollisionMap()?.hasFlag(x, y, BLOCKING_FLAGS) !== true;
}

/**
 * The Inferno, waves 1-69, as one run (docs/encounters/inferno-facts-spec.md, -policy.md).
 *
 * Owns the wave director (batches, completion on the last removal, transitions), the pillars, the
 * corpse ledger and every dynamic add of waves 1-68, then wave 68 -> 69: the intro and, from it,
 * TzKal-Zuk's wave through {@link ZukWaveDirector}. The player, their loadout, timers, combat clocks,
 * ground items and every random stream carry straight through; nothing is reset or rebuilt. A run may
 * also start on wave 69, which opens at its control tick with no intro. Species behavior belongs to
 * the definitions registered through {@link infernoWaveRegistrations} and {@link zukWaveRegistrations};
 * the ordinary waves' spawn paths are {@link INFERNO_WAVE_SPAWNERS}.
 */
export class InfernoEncounter implements Encounter {
  readonly kind = INFERNO_KIND;
  readonly runStartMechanicsKeys = [
    INFERNO_START_WAVE_KEY,
    ...Object.values(INFERNO_DESTROYED_PILLAR_KEYS),
    INFERNO_SPAWN_LAYOUT_KEY,
    INFERNO_START_TILE_KEY,
    INFERNO_PINNED_WAVE_KEY,
    'zukShieldStart',
  ];
  /** The run's layouts and nibbler pillars; a retry keeps it. */
  private runSeed: number;
  /** A retry's own NPC rolls (`npcDecisionSeed`); undefined on a run's first attempt. */
  private attemptSeed: number | undefined = undefined;
  private readonly openStream: NonNullable<InfernoEncounterOptions['decisionRandom']>;
  /** This wave's NPC decision stream; `random` is its plain draw. */
  private decisions: DecisionRandom;
  private readonly random = (): number => this.decisions.next();
  private nextActorId = 0;
  private setup: InfernoRunSetup = resolveInfernoRunSetup({});
  private wave = 1;
  private phase: InfernoWavePhase = 'countdown';
  private nextWaveTick: number | null = null;
  private readonly combatants = new Map<ActorId, Combatant>();
  /** This wave's resurrectable corpses not yet revived (policy: each at most once). */
  private corpses: InfernoCorpse[] = [];
  private pillars: PillarRuntime[] = [];
  /** The pillar this wave's nibblers share, chosen when the wave spawns (null: none stood). */
  private waveNibblerPillar: PillarKey | null = null;
  /** The slots this wave's batch spawned on, serialized; '' until it spawns or with none to place. */
  private waveSpawnLayout = '';
  /** The pillars already down when this wave spawned; the run's setup until its first wave does. */
  private waveStartDestroyedPillars: Readonly<Record<PillarKey, boolean>> = this.setup.destroyedPillars;
  /** The player's tile when this wave spawned; null until it does. */
  private waveStartPlayerTile: Coordinate | null = null;
  private pillarsMaterialized = false;
  private arenaBase: ArenaConfig | null = null;
  private parentHealTick: number | null = null;
  private readonly healedParents = new Set<ActorId>();
  /**
   * Wave 69's control tick C once the run is headed there (0 for a run started on 69); the intro and
   * the wave's clocks are relative to it. Null on the ordinary waves.
   */
  private zukControlTick: number | null = null;
  /** Wave 69, from the tick its actors are added. */
  private zuk: ZukWaveDirector | null = null;
  /**
   * The stage whose opening actors the world holds: set by `createNpcs`, cleared on reset. A
   * tick-zero edit that changes it rebuilds them (`configureRunStart`).
   */
  private openedStage: InfernoStage | null = null;
  private readonly services: InfernoWaveServices = {
    waveNibblerTarget: (context) => this.waveNibblerTarget(context.world),
    resurrection: {
      // Wave 69's magers never resurrect: its corpse ledger is always empty.
      eligibleCorpses: () => (this.zuk ? [] : this.corpses),
      revive: (corpse, position, context) => this.revive(corpse, position, context),
    },
    spawnJadHealers: (parentId, context) => {
      if (context.world.getNpc(parentId)?.npcTypeId === ZUK_JAD_NPC_ID)
        this.requireZuk().spawnJadHealers(parentId, context);
      else this.spawnJadHealers(parentId, context);
    },
    presentParentHeal: (target, context) => this.presentParentHeal(target, context),
  };
  private readonly definitions: NpcDefinitionCollection;

  constructor(runSeed = newSeed(), options: InfernoEncounterOptions = {}) {
    this.runSeed = seedsSchema.parse({ runSeed }).runSeed;
    this.openStream = options.decisionRandom ?? ((_stream, _wave, next) => generatorDecisionRandom(next));
    this.decisions = this.openStream('npc', this.wave, waveNpcRandom(this.npcSeed(), this.wave));
    this.configureRunStart({});
    // One registration per definition, stable for the run: the engine caches the collection.
    this.definitions = new NpcDefinitionCollection([
      pillarProxyDefinition.register({
        collapse: (pillar, context) => this.collapsePillar(pillar, context, PILLAR_COLLAPSE_REMOVAL_TICKS.natural),
      }),
      pillarCollapseDefinition.register(undefined),
      ...infernoWaveRegistrations(this.services),
      ...zukWaveRegistrations(
        () => this.requireZuk(),
        (target, context) => this.presentParentHeal(target, context),
      ),
    ]);
  }

  /**
   * Wave 1 lands on the landing tile and wave 69 opens on its own start; waves 2-68 on the practice
   * start tile (`startTile.ts`), or its default where this arena's terrain closes the chosen one.
   */
  getDefaultPlayerStart(mechanics: Readonly<Partial<MechanicsConfig>> = {}): Coordinate {
    return this.openingStart(this.resolveSetup(mechanics));
  }
  /**
   * A run started on wave 1 lands as the game's entry does (P:229-233): the landing animation, then
   * its message on the first tick (the engine's). The capture records no facing for the teleport, so
   * the player keeps the run's usual northward opening facing (policy). Every other start has none.
   */
  getIntroConfig(mechanics: Readonly<Partial<MechanicsConfig>> = {}): EncounterIntroConfig | null {
    if (this.resolveSetup(mechanics).startWave !== FIRST_INFERNO_WAVE) return null;
    return { facingAngle: FACING_NORTH, animationSeqId: INFERNO_LANDING_SEQ_ID, message: INFERNO_LANDING_MESSAGE };
  }
  getNpcDefinitions(): NpcDefinitionCollection {
    return this.definitions;
  }
  /**
   * A run started on wave 69 opens with its glyph and Zuk in place. Pillar proxies wait for the first
   * tick: the pillar toggles may still change at tick 0.
   */
  createNpcs(): NpcActor[] {
    this.openedStage = stageOf(this.wave);
    return this.zuk?.createOpeningActors() ?? [];
  }
  /**
   * The run setup, from tick 0. A tick-zero edit that keeps wave 69 only re-sides the glyph; one that
   * moves the start between the ordinary waves and wave 69 swaps the opening actors and start tile.
   */
  configureRunStart(mechanics: Readonly<Partial<MechanicsConfig>>, ctx?: EncounterRunStartContext): void {
    const setup = this.resolveSetup(mechanics);
    const previous = this.openedStage;
    const stage = stageOf(setup.startWave);
    if (previous === 'zuk' && stage === 'zuk' && this.zuk) {
      this.setup = setup;
      this.zuk.configureShieldStart(setup.zukShieldStart);
      return;
    }
    if (previous !== null && ctx) for (const id of this.zuk?.openingActorIds ?? []) ctx.despawnNpc(id);
    this.setup = setup;
    this.nextActorId = 0;
    this.wave = this.setup.startWave;
    this.phase = stage === 'zuk' ? 'active' : 'countdown';
    // Only the entry (wave 1, after its landing) waits the capture's +11; a practice start does not.
    this.nextWaveTick = stage === 'zuk' ? null : SIMULATION_START_TICK + startWaveDelayTicks(this.wave);
    this.zukControlTick = stage === 'zuk' ? SIMULATION_START_TICK : null;
    this.zuk =
      stage === 'zuk'
        ? new ZukWaveDirector(this.runSeed, this.npcSeed(), SIMULATION_START_TICK, this.setup.zukShieldStart)
        : null;
    this.combatants.clear();
    this.corpses = [];
    this.waveSpawnLayout = '';
    this.waveStartDestroyedPillars = { ...this.setup.destroyedPillars };
    this.waveStartPlayerTile = null;
    this.pillars = INFERNO_PILLARS.map((pillar) => ({
      pillar,
      intact: this.wave <= LAST_PILLAR_WAVE && !this.setup.destroyedPillars[pillar.key],
      proxyId: null,
    }));
    this.pillarsMaterialized = false;
    this.decisions = this.openStream('npc', this.wave, waveNpcRandom(this.npcSeed(), this.wave));
    this.parentHealTick = null;
    this.healedParents.clear();
    this.installArena();
    if (previous === null || !ctx) return;
    this.openedStage = stage;
    for (const actor of this.createNpcs()) ctx.spawnNpc(actor);
    // Only across the 68/69 line. Within the ordinary waves the player stays where the run opened
    // (a restart's kept tile, a step taken in the countdown, or a capture's own tile): a changed start
    // tile or start wave takes its tile from the next fresh start, Go included.
    if (previous !== stage) ctx.placePlayer(this.getDefaultPlayerStart(mechanics));
  }
  getSeeds(): Record<string, unknown> {
    return { runSeed: this.runSeed, ...(this.attemptSeed === undefined ? {} : { attemptSeed: this.attemptSeed }) };
  }
  /** Restores exactly the seeds given (a replay, or a retry's `planPracticeRestart` seeds); none, a new run. */
  reset(seeds?: Record<string, unknown>): void {
    const parsed = seedsSchema.parse(seeds ?? { runSeed: newSeed() });
    this.runSeed = parsed.runSeed;
    this.attemptSeed = parsed.attemptSeed;
    this.openedStage = null;
    this.configureRunStart({});
  }
  refineArenaConfig(base: ArenaConfig): ArenaConfig {
    this.arenaBase = base;
    return composePillarArena(base, this.intactPillarKeys());
  }
  resolveHazards(ctx: EncounterContext): EnvironmentalDamage[] {
    return this.zuk?.resolveHazards(ctx) ?? [];
  }
  prepareNpcBand(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): void {
    if (this.zukControlTick !== null && this.phase === 'countdown') this.advanceZukIntro(ctx);
    if (this.zuk) {
      this.zuk.prepareNpcBand(ctx, mechanics);
      return;
    }
    if (!this.pillarsMaterialized) this.materializePillars(ctx);
    this.checkWaveCompletion(ctx);
  }
  /**
   * In the NPC's own turn (`Encounter.removeNpcIfDue`): the species own their removal delays
   * (`removeInfernoNpcIfDue`); a Jad's removal takes his healers along, and a Jal-Ak adds its three
   * children just before it leaves, on that same tick (P:2484-2540). The wave completes in `processPostTick`.
   */
  removeNpcIfDue(actor: NpcActor, ctx: EncounterContext): void {
    const removeAt = pillarCollapseDefinition.getState(actor)?.removeAt;
    if (removeAt !== undefined) {
      if (ctx.tick >= removeAt) ctx.despawnNpc(actor.id);
      return;
    }
    if (!this.combatants.has(actor.id)) {
      this.zuk?.removeNpcIfDue(actor, ctx);
      return;
    }
    const removal = removeInfernoNpcIfDue(actor, ctx, (split) =>
      this.spawnCombatant(split.species, { position: [...split.position], origin: 'split' }, ctx),
    );
    if (!removal) return;
    this.combatants.delete(actor.id);
  }
  moveNpc(actor: NpcActor, ctx: EncounterContext): NpcMovementRequest[] {
    if (this.zuk) return this.zuk.moveNpc(actor, ctx, this.definitions);
    return this.definitions.move(actor, this.npcContext(ctx));
  }
  resolveNpcLocalEffects(actor: NpcActor, ctx: EncounterContext): EnvironmentalDamage[] {
    return this.definitions.resolveLocalEffects(actor, this.npcContext(ctx));
  }
  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    return this.definitions.tick(actor, this.npcContext(ctx));
  }
  /** A batch spawned here takes its first turn next tick, as the captures' `add` ticks show. */
  processPostTick(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): EnvironmentalDamage[] {
    if (this.zuk) {
      this.zuk.processPostTick(ctx, mechanics);
      return [];
    }
    this.checkWaveCompletion(ctx);
    if (
      this.phase === 'countdown' &&
      this.wave <= LAST_ORDINARY_WAVE &&
      this.nextWaveTick !== null &&
      ctx.tick >= this.nextWaveTick
    )
      this.spawnWave(ctx);
    return [];
  }
  onNpcDefeated(defeat: EncounterNpcDefeat, ctx: EncounterContext, ownership: EncounterCompletionOwnership): void {
    this.zuk?.onNpcDefeated(defeat, ctx, ownership, this.definitions);
    const combatant = this.combatants.get(defeat.npcId);
    const npc = ctx.world.getNpc(defeat.npcId);
    const species = npc ? resurrectableSpecies(npc) : null;
    // Each corpse at most once: a revived NPC's second death leaves nothing to revive (policy).
    if (combatant && species && combatant.origin !== 'resurrection') {
      this.corpses.push({ id: defeat.npcId, species });
    }
  }
  getSnapshot(ctx: EncounterSnapshotContext): InfernoSnapshot {
    return {
      kind: INFERNO_KIND,
      state: {
        wave: this.wave,
        startWave: this.setup.startWave,
        startDestroyedPillars: { ...this.setup.destroyedPillars },
        startSpawnLayout: this.setup.spawnLayout ? serializeSpawnLayout(this.setup.spawnLayout) : '',
        startPlayerTile: this.runStartTile(),
        ...(this.setup.pinnedWave === undefined ? {} : { pinnedWave: this.setup.pinnedWave }),
        waveSpawnLayout: this.waveSpawnLayout,
        waveStartDestroyedPillars: { ...this.waveStartDestroyedPillars },
        waveStartPlayerTile: this.waveStartPlayerTile
          ? [this.waveStartPlayerTile[0], this.waveStartPlayerTile[1]]
          : null,
        phase: this.phase,
        nextWaveTick: this.nextWaveTick,
        zuk: this.zuk?.getSnapshotState(ctx) ?? null,
        pillars: this.pillars.map(({ pillar, intact, proxyId }) => {
          const proxy = proxyId === null ? null : ctx.world.getNpc(proxyId);
          return {
            key: pillar.key,
            locId: pillar.locId,
            position: [pillar.position[0], pillar.position[1]],
            intact,
            hp: intact ? (proxy?.vitals.hp ?? PILLAR_MAX_HP) : 0,
          };
        }),
      },
      visuals: {
        pillarLocs: this.pillars
          .filter((runtime) => runtime.intact)
          .map(({ pillar }) => ({
            key: pillar.key,
            locId: pillar.locId,
            position: [pillar.position[0], pillar.position[1]],
          })),
        zukControlTick: this.zukControlTick,
      },
    };
  }
  /** Active through wave 68; the run ends with Zuk's defeat. */
  getOutcome(): EncounterOutcome {
    return this.zuk?.getOutcome() ?? ACTIVE_ENCOUNTER_OUTCOME;
  }
  syncBossHp(hp: number, ctx: Pick<EncounterContext, 'world'>): void {
    this.zuk?.syncBossHp(hp, ctx);
  }
  /** TzKal-Zuk's named phases; nothing to do before wave 69 (no boss stands then). */
  enterBossHpPhase(hp: number, ctx: Pick<EncounterContext, 'tick' | 'world' | 'spawnNpc' | 'despawnNpc'>): void {
    if (!this.zuk?.hasLivingBoss(ctx)) return;
    this.parentHealTick = null;
    this.healedParents.clear();
    this.zuk.enterBossHpPhase(hp, ctx);
  }
  getDefaultMechanicsConfig(): Partial<MechanicsConfig> {
    return buildInfernoControls().defaultMechanicsConfig;
  }
  getNpcDamageSourceLabel(): string {
    return this.zuk ? 'ZukAttack' : 'InfernoAttack';
  }
  /** Pre-cache placeholder; the cache bake replaces it (see the descriptor's collision spec). */
  getArenaConfig(): ArenaConfig {
    return {
      bounds: { ...INFERNO_ARENA_BOUNDS, width: 29, height: 30 },
      walkableTiles: null,
      collisionMap: null,
    };
  }
  getEngineRules(): EncounterEngineRules {
    return {
      // Jal-MejRah run-energy and stat drain (policy, Bat drain).
      onPlayerDamageTaken: (info) => jalMejRahDrainEffect(info),
      // The pillars and wave 69's glyph are never the player's targets, and Zuk cannot be meleed.
      validateAttack: (kind, targetId, ctx) => {
        const typeId = ctx.world.getNpc(targetId)?.npcTypeId;
        if (typeId === INFERNO_PILLAR_NPC_ID || typeId === INFERNO_PILLAR_COLLAPSE_NPC_ID) return false;
        if (typeId === ZUK_SHIELD_NPC_ID) return false;
        if (targetId === ZUK_ACTOR_ID && MELEE_KINDS.has(kind)) return false;
        return null;
      },
      // Wave 69's intro: busy from C-12 through control (ZUK_INTRO).
      playerInputLocked: (ctx) =>
        this.zukControlTick !== null &&
        ctx.tick >= this.zukControlTick + ZUK_INTRO.busyFrom &&
        ctx.tick <= this.zukControlTick,
    };
  }
  /** Inferno's restarts are the caller's to perform; Zuk's practice actions act on wave 69 only. */
  executeCommand(command: EncounterCommand, ctx: EncounterCommandContext): EncounterCommandResult | undefined {
    if (isZukWaveCommand(command)) return this.zuk ? this.zuk.executeCommand(command, ctx) : {};
    return command.encounter === INFERNO_KIND ? {} : undefined;
  }
  planPracticeRestart(
    command: EncounterCommand,
    mechanics: Readonly<Partial<MechanicsConfig>>,
    ctx: EncounterRestartContext,
  ): EncounterPracticeRestart | undefined {
    if (command.encounter !== INFERNO_KIND) return undefined;
    // A restart that keeps the spawns keeps the run seed under a fresh attempt seed: the same spawns
    // and nibbler pillar, with the monsters' hits and placements rolled afresh
    // (docs/encounters/inferno-policy.md). The others draw new seeds altogether.
    const restart = (
      wave: number,
      keepSpawns: boolean,
      layout: Partial<MechanicsConfig> = {},
      fromStoodTile = true,
    ): EncounterPracticeRestart => {
      const runMechanics = { [INFERNO_START_WAVE_KEY]: String(clampWave(wave)), ...layout };
      const startPosition = fromStoodTile
        ? this.restartStart({ ...mechanics, ...runMechanics }, ctx.playerPos)
        : undefined;
      return {
        ...(keepSpawns ? { encounterSeeds: { runSeed: this.runSeed, attemptSeed: newSeed() } } : {}),
        runMechanics,
        ...(startPosition ? { startPosition } : {}),
      };
    };
    const runLayout = this.setup.spawnLayout ? serializeSpawnLayout(this.setup.spawnLayout) : '';
    const saved = this.resolveSetup(mechanics).spawnLayout;
    // This run's own layout where the saved one differs (a Random spawns dropped it, or the setup was
    // edited since; Go applies an edit), so a Retry never swaps in a layout the run was not using.
    const runLayoutOverride =
      runLayout === (saved ? serializeSpawnLayout(saved) : '') ? {} : { [INFERNO_SPAWN_LAYOUT_KEY]: runLayout };
    // Retry and Random spawns keep the player's tile, so they keep this run's start tile too where an
    // edit since differs (a run override, like the layout): only Go applies a new one, and the
    // setup control keeps saying so. A run with none (started on wave 1) takes the saved one.
    const savedTile = serializeInfernoStartTile(
      this.resolveSetup({ ...mechanics, [INFERNO_START_WAVE_KEY]: String(this.wave) }).startTile,
    );
    const runTile =
      startTileApplies(this.wave) && this.runStartTile() !== '' && this.runStartTile() !== savedTile
        ? { [INFERNO_START_TILE_KEY]: this.runStartTile() }
        : {};
    // The run seed and wave alone place a wave's spawns (`planWaveSpawns`), whichever wave the run
    // started on, so keeping them is the run seed plus this run-only pin. Each plan replaces the last
    // run's overrides, so a Retry re-emits it; Go, Restart fight and Random spawns leave it out.
    const pin = { [INFERNO_PINNED_WAVE_KEY]: String(this.wave) };
    const pinned = this.setup.pinnedWave === this.wave;
    switch (command.type) {
      // The current wave again. With a custom layout for it or its spawns kept, the same spawns as
      // this attempt (the run seed fills any slots a layout leaves random); otherwise new random
      // spawns, so practicing a random wave meets a new one each time
      // (docs/encounters/inferno-policy.md).
      case 'retry-wave':
        return restart(this.wave, pinned || this.setup.spawnLayout?.wave === this.wave, {
          ...runLayoutOverride,
          ...runTile,
          ...(pinned ? pin : {}),
        });
      case 'keep-spawns':
        return restart(this.wave, true, { ...runLayoutOverride, ...runTile, ...pin });
      // Different spawns: no pin, and on the wave the run's custom layout is for, that run drops it
      // and rolls at random. A run override, never a save (`EncounterPracticeRestart.runMechanics`):
      // the saved layout stays the player's, and Go or Restart fight bring it back. A layout for
      // another wave stays the run's, never one saved since.
      case 'reroll-wave':
        return restart(this.wave, false, {
          ...(this.setup.spawnLayout?.wave === this.wave ? { [INFERNO_SPAWN_LAYOUT_KEY]: '' } : runLayoutOverride),
          ...runTile,
        });
      // A different wave is a new attempt, so it gets fresh seeds and a layout of its own. The
      // same wave (only the pillar setup changed) keeps its spawns, random or not, so the change is
      // tried against the wave it was made on. Go starts from the
      // setup's own start tile, not where the player stood (docs/encounters/inferno-policy.md).
      case 'go-to-wave': {
        const wave = clampWave(command.wave);
        return restart(wave, wave === this.wave, {}, false);
      }
      default:
        return assertNever(command);
    }
  }
  /** Restart fight: the player's own start wave, opened where they stand, as the practice restarts are. */
  planRestartStart(
    mechanics: Readonly<Partial<MechanicsConfig>>,
    ctx: EncounterRestartContext,
  ): Coordinate | undefined {
    return this.restartStart(mechanics, ctx.playerPos);
  }

  private intactPillarKeys(): ReadonlySet<PillarKey> {
    return new Set(this.pillars.filter((runtime) => runtime.intact).map((runtime) => runtime.pillar.key));
  }
  /** Reinstall the arena the engine last gave us, with the current pillars. */
  private installArena(): void {
    if (this.arenaBase === null) return;
    setArenaConfig(composePillarArena(this.arenaBase, this.intactPillarKeys()), getArenaAllowUnboundedFallback());
  }
  private npcSeed(): number {
    return npcDecisionSeed(this.runSeed, this.attemptSeed);
  }
  private allocateId(kind: string): ActorId {
    return `inferno_${kind}_${this.nextActorId++}`;
  }
  /** Wave 69 draws from its own director's stream, as TzKal-Zuk always has. */
  private npcContext(ctx: EncounterContext): NpcDefinitionContext {
    if (this.zuk) return this.zuk.npcContext(ctx);
    return { ...ctx, random: this.random, decisions: this.decisions };
  }
  private resolveSetup(mechanics: Readonly<Partial<MechanicsConfig>>): InfernoRunSetup {
    // A start wave the mechanics do not name is the setup's default (`INFERNO_DEFAULT_START_WAVE`).
    return resolveInfernoRunSetup(mechanics);
  }
  /**
   * `InfernoPublicState.startPlayerTile`: from the run's setup alone, so a run rebuilt from its
   * recorded config publishes the same.
   */
  private runStartTile(): string {
    return startTileApplies(this.setup.startWave) ? serializeInfernoStartTile(this.setup.startTile) : '';
  }
  /** Where a fresh run of `setup` opens (`getDefaultPlayerStart`). */
  private openingStart(setup: InfernoRunSetup): Coordinate {
    if (setup.startWave === ZUK_WAVE) return [...ZUK_PLAYER_START];
    if (!startTileApplies(setup.startWave)) return [...INFERNO_LANDING_TILE];
    const base = this.arenaBase;
    // The bake's terrain, pillars aside (`validateInfernoStartTile` has those): before the cache, none.
    const isOpen = (x: number, y: number) =>
      base === null ||
      ((base.walkableTiles?.has(`${x},${y}`) ?? true) && base.collisionMap?.hasFlag(x, y, BLOCKING_FLAGS) !== true);
    return validateInfernoStartTile(setup.startTile, setup, isOpen).ok
      ? [...setup.startTile]
      : [...INFERNO_PRACTICE_START_TILE];
  }
  /**
   * Every restart opens where the player stood (docs/encounters/inferno-policy.md), except that
   * wave 1 opens on the landing tile, wave 69 on its own start, and a restart out of wave 69's stage
   * uses the destination setup's default, including its configured practice start tile for waves 2-68.
   * A tile the restarted run would close (closed terrain, or a pillar it stands up again) also opens
   * on the default. Undefined: the default start for `mechanics`.
   */
  private restartStart(mechanics: Readonly<Partial<MechanicsConfig>>, at: Coordinate): Coordinate | undefined {
    const { startWave, destroyedPillars } = this.resolveSetup(mechanics);
    if (startWave === FIRST_INFERNO_WAVE || stageOf(startWave) === 'zuk' || stageOf(this.wave) === 'zuk') {
      return undefined;
    }
    const [x, y] = at;
    const [defaultX, defaultY] = this.getDefaultPlayerStart(mechanics);
    if ((x === defaultX && y === defaultY) || !isTileOpen(x, y)) return undefined;
    // The installed arena is this run's: a pillar that has collapsed in it stands again in the new one.
    const blockedByPillar =
      startWave <= LAST_PILLAR_WAVE &&
      INFERNO_PILLARS.some(
        (pillar) => !destroyedPillars[pillar.key] && pillarFootprint(pillar).some(([px, py]) => px === x && py === y),
      );
    return blockedByPillar ? undefined : [x, y];
  }
  private requireZuk(): ZukWaveDirector {
    if (!this.zuk) throw new TypeError('A wave-69 NPC acted before wave 69 began');
    return this.zuk;
  }
  /**
   * Wave 68 -> 69 (`ZUK_INTRO`, relative to control C): the shaking-cavern message at C-12; teleport at
   * C-10; glyph and Zuk (rising) at C-8, which starts wave 69's director, with TzHaar-Ket-Keh's line;
   * `Wave: 69` and control at C. The busy window is an engine rule; the fade and cutscene camera are
   * the renderer's (`zukIntroCutsceneFrame`).
   */
  private advanceZukIntro(ctx: EncounterContext): void {
    const controlTick = this.zukControlTick;
    if (controlTick === null) return;
    const offset = ctx.tick - controlTick;
    if (offset === ZUK_INTRO.busyFrom) {
      ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: [{ text: ZUK_INTRO_MESSAGES.busy }] });
    }
    if (offset === ZUK_INTRO.teleport) {
      if (!ctx.teleportPlayer) throw new TypeError("Wave 69's intro needs the engine's player teleport");
      ctx.teleportPlayer([...ZUK_PLAYER_START], FACING_NORTH);
    }
    if (offset === ZUK_INTRO.add) {
      this.zuk = new ZukWaveDirector(this.runSeed, this.npcSeed(), controlTick, this.setup.zukShieldStart);
      for (const actor of this.zuk.createOpeningActors()) ctx.spawnNpc(actor);
      // Zuk rises with seq 7563 as he is added (W69 L2840). His spawn tick is C, the cast clock's
      // epoch, so the clip is cued here rather than played from it as a spawn clip.
      emitEncounterVisual(ctx.tickEvents, {
        animations: [{ actorId: ZUK_ACTOR_ID, clipId: ZUK_INTRO_RISE_CLIP, delayCycles: 0 }],
        projectiles: [],
        graphics: [],
      });
      ctx.tickEvents.emit({
        type: 'game_message',
        kind: 'public',
        speaker: ZUK_INTRO_MESSAGES.prisonSpeaker,
        segments: [{ text: ZUK_INTRO_MESSAGES.prison }],
      });
    }
    if (offset === 0) {
      this.phase = 'active';
      this.nextWaveTick = null;
      ctx.tickEvents.emit({
        type: 'game_message',
        kind: 'game',
        segments: [{ text: `Wave: ${ZUK_WAVE}`, color: WAVE_MESSAGE_COLOR }],
      });
    }
  }

  private materializePillars(ctx: SpawnContext): void {
    this.pillarsMaterialized = true;
    for (const runtime of this.pillars) {
      if (!runtime.intact) continue;
      const proxy = createPillarProxy({
        pillar: runtime.pillar,
        id: `inferno_pillar_${runtime.pillar.key}`,
        spawnTick: ctx.tick,
      });
      ctx.spawnNpc(proxy);
      runtime.proxyId = proxy.id;
    }
  }
  /** The wave's chosen pillar while it stands; once it collapses its nibblers turn on the player. */
  private waveNibblerTarget(world: Readonly<WorldState>): NpcActor | null {
    const runtime = this.pillars.find((candidate) => candidate.pillar.key === this.waveNibblerPillar);
    const proxy = runtime?.intact && runtime.proxyId !== null ? world.getNpc(runtime.proxyId) : null;
    return proxy && isNpcLiving(proxy) ? proxy : null;
  }
  /**
   * Collapse: remove the proxy and the LOC (collision included), add 7710 playing the collapse, and
   * queue its hits on the nibblers beside the footprint now, before anything else moves.
   */
  private collapsePillar(key: PillarKey, ctx: SpawnContext, removalDelay: number): void {
    const runtime = this.pillars.find((candidate) => candidate.pillar.key === key);
    if (!runtime?.intact) return;
    runtime.intact = false;
    if (runtime.proxyId !== null) ctx.despawnNpc(runtime.proxyId);
    runtime.proxyId = null;
    this.installArena();
    const { pillar } = runtime;
    const rubble = createPillarCollapse({
      pillar,
      id: `inferno_pillar_${key}_collapse`,
      spawnTick: ctx.tick,
      removeAt: ctx.tick + removalDelay,
    });
    ctx.spawnNpc(rubble);
    const hits = pillarCollapseHits(
      ctx.world,
      pillar,
      rubble.id,
      (npc) => this.combatants.get(npc.id)?.kind === 'nibbler',
    );
    if (hits.length > 0 && !ctx.queueNpcHit) throw new TypeError('A pillar collapse needs the engine hit queue');
    for (const hit of hits) ctx.queueNpcHit?.(hit);
    ctx.tickEvents.emit({
      type: 'inferno_pillar_collapse',
      pillar: key,
      position: [pillar.position[0], pillar.position[1]],
      soundId: PILLAR_COLLAPSE_SOUND_ID,
      soundPosition: [pillar.position[0] + 1, pillar.position[1] + 1],
    });
  }

  private spawnCombatant(
    kind: InfernoWaveNpcKind,
    request: Omit<InfernoWaveSpawnRequest, 'id' | 'spawnTick'>,
    ctx: Pick<SpawnContext, 'tick' | 'spawnNpc'>,
  ): NpcActor {
    const actor = INFERNO_WAVE_SPAWNERS[kind]({ ...request, id: this.allocateId(kind), spawnTick: ctx.tick });
    // 1 HP per 100 ticks from add+101 (the existing NPC clock): replaying every captured kill's splats
    // leaves 0 HP for 872/886 lives with it (P 535/544, Q 337/342) against 806 without (P t4959 meleer:
    // killing splat 5 after one regeneration at t4918).
    enableNpcHitpointRegen(actor, ctx.tick);
    ctx.spawnNpc(actor);
    this.combatants.set(actor.id, { kind, origin: request.origin });
    return actor;
  }
  private spawnWave(ctx: SpawnContext): void {
    this.decisions = this.openStream('npc', this.wave, waveNpcRandom(this.npcSeed(), this.wave));
    const standing = this.pillars.filter((runtime) => runtime.intact).map((runtime) => runtime.pillar.key);
    const wave = this.wave;
    this.waveNibblerPillar = pickWaveNibblerTarget(
      this.runSeed,
      wave,
      standing,
      (next) => this.openStream('nibbler_target', wave, next),
      ctx.tick,
    );
    this.corpses = [];
    ctx.tickEvents.emit({
      type: 'game_message',
      kind: 'game',
      segments: [{ text: `Wave: ${this.wave}`, color: WAVE_MESSAGE_COLOR }],
    });
    const placements = planWaveSpawns(
      this.runSeed,
      wave,
      (next) => this.openStream('layout', wave, next),
      ctx.tick,
      this.setup.spawnLayout,
    );
    const spawned = layoutFromPlacements(wave, placements);
    this.waveSpawnLayout = spawned ? serializeSpawnLayout(spawned) : '';
    const down = (key: PillarKey) => !this.pillars.some((runtime) => runtime.pillar.key === key && runtime.intact);
    this.waveStartDestroyedPillars = { west: down('west'), south: down('south'), northEast: down('northEast') };
    const player = ctx.world.getPlayer();
    this.waveStartPlayerTile = player ? [player.position[0], player.position[1]] : null;
    for (const placement of placements) {
      this.spawnCombatant(
        placement.kind,
        { position: placement.position, origin: 'wave', ...(placement.jad ? { jad: placement.jad } : {}) },
        ctx,
      );
    }
    this.phase = 'active';
    this.nextWaveTick = null;
  }
  /** Wave completes on the tick its last NPC is removed; the next batch follows 6 ticks later. */
  private checkWaveCompletion(ctx: SpawnContext): void {
    if (this.phase !== 'active') return;
    for (const id of [...this.combatants.keys()]) if (!ctx.world.getNpc(id)) this.combatants.delete(id);
    if (this.combatants.size > 0) return;
    ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: [{ text: 'Wave completed!' }] });
    if (this.wave === LAST_PILLAR_WAVE) {
      for (const runtime of this.pillars) {
        if (runtime.intact) this.collapsePillar(runtime.pillar.key, ctx, PILLAR_COLLAPSE_REMOVAL_TICKS.scripted);
      }
    }
    this.wave += 1;
    this.phase = 'countdown';
    this.waveSpawnLayout = '';
    this.waveStartPlayerTile = null;
    if (this.wave === ZUK_WAVE) {
      // Straight on into wave 69: its intro starts ZUK_INTRO_DELAY_TICKS after this clear (policy).
      this.corpses = [];
      this.zukControlTick = ctx.tick + ZUK_INTRO_DELAY_TICKS - ZUK_INTRO.busyFrom;
      this.nextWaveTick = this.zukControlTick;
      return;
    }
    this.nextWaveTick = ctx.tick + NEXT_WAVE_DELAY_TICKS;
  }

  /** Consumes the corpse; the mager definition chose it and its free tile, and presents the cast. */
  private revive(corpse: InfernoCorpse, position: Coordinate, context: NpcDefinitionContext): void {
    this.corpses = this.corpses.filter((candidate) => candidate !== corpse);
    this.spawnCombatant(corpse.species, { position: [...position], origin: 'resurrection' }, context);
  }
  /** Policy fitted to captures, not a verified rule: `pickJadHealerTiles` (layout.ts). */
  private spawnJadHealers(parentId: ActorId, context: NpcDefinitionContext): NpcActor[] {
    const parent = context.world.getNpc(parentId);
    if (!parent) return [];
    const count = INFERNO_WAVE_JAD_SCHEDULE[this.wave === LAST_ORDINARY_WAVE ? 68 : 67].healersPerJad;
    const tiles = pickJadHealerTiles(parent, count, {
      isOpen: isTileOpen,
      player: context.world.getPlayer()?.position ?? null,
      decisions: contextDecisions(context),
      key: { site: 'inferno.jad_healer.tile', tick: context.tick, actorId: parentId },
    });
    return tiles.map((position) =>
      this.spawnCombatant('jad_healer', { position: [...position], origin: 'healer', parentId }, context),
    );
  }
  /** One parent graphic per healed parent per tick, as on wave 69 (docs/encounters/zuk-policy.md). */
  private presentParentHeal(target: NpcActor, context: NpcDefinitionContext): void {
    if (this.parentHealTick !== context.tick) {
      this.parentHealTick = context.tick;
      this.healedParents.clear();
    }
    if (this.healedParents.has(target.id)) return;
    this.healedParents.add(target.id);
    emitEncounterVisual(context.tickEvents, {
      animations: [],
      projectiles: [],
      graphics: [
        {
          spotAnimId: 444,
          target: { kind: 'actor', actorId: target.id, size: target.size, position: [...target.position] },
          height: 256,
          delayCycles: 0,
        },
      ],
    });
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown Inferno command: ${JSON.stringify(value)}`);
}
