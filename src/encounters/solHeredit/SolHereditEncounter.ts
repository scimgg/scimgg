import { z } from 'zod';
import type { NpcActor } from '../../core/actors/NpcActor';
import type { ArenaConfig } from '../../core/arena/ArenaConfig';
import { getArenaAllowUnboundedFallback, setArenaConfig } from '../../core/constants';
import type { EncounterCommand } from '../../core/encounters/commands';
import type { EncounterModifierSelection } from '../../core/encounters/encounterFactory';
import type { EncounterOutcome } from '../../core/encounters/outcome';
import type { EncounterSnapshotContext, SolHereditSnapshot } from '../../core/encounters/snapshot';
import type {
  Encounter,
  EncounterCommandContext,
  EncounterCommandResult,
  EncounterCompletionOwnership,
  EncounterContext,
  EncounterEngineRules,
  EncounterInput,
  EncounterNpcDefeat,
  EncounterPracticeRestart,
  EncounterRunStartContext,
  EncounterTickResult,
  EnvironmentalDamage,
  NpcAttackRequest,
  NpcMovementRequest,
} from '../../core/encounters/types';
import { NpcDefinitionCollection } from '../../core/npcs';
import { mulberry32 } from '../../core/rng';
import { BEAM_CRYSTAL_ACTOR_PREFIX } from '../../npcs/colosseum/constants';
import { crystalDefinition } from '../../npcs/colosseum/crystal';
import { manticoreDefinition, manticoreHeldOrbs } from '../../npcs/colosseum/manticore';
import { solDefinition } from '../../npcs/colosseum/sol';
import { isInsideArena } from '../../npcs/colosseum/solAttacks';
import { warbanderDefinition } from '../../npcs/colosseum/warband';
import type { Coordinate, MechanicsConfig } from '../../types/simulation';
import { beesDefinition } from '../colosseum/modifiers/bees';
import { ColosseumModifierState } from '../colosseum/modifiers/rules';
import { solarflareDefinition } from '../colosseum/modifiers/solarflare';
import { healingTotemDefinition } from '../colosseum/modifiers/totemic';
import { colosseumWaveArenaPlaceholder } from '../colosseum/waves/arena';
import { ColosseumWaveRun } from '../colosseum/waves/ColosseumWaveRun';
import { VOLATILITY_GIB_ACTOR_PREFIX, volatilityGibDefinition } from '../colosseum/waves/gibs';
import { type ColosseumRunPublicState, DIRECT_SOL_RUN_STATE } from '../colosseum/waves/snapshot';
import { colosseumWaveSpeciesRegistrations } from '../colosseum/waves/species';
import { COLOSSEUM_MODIFIER_CONFIRMED_EVENT, FIRST_COLOSSEUM_WAVE, SOL_WAVE } from '../colosseum/waves/waveTable';
import { composeSolStageArena } from './arenaBoundary';
import type { SolBeamRounds } from './beams';
import { SOL_ARENA, SOL_PLAYER_START, SOL_QUARTET_ACTOR_ID, SOL_SOLARFLARE_ACTOR_PREFIX } from './constants';
import {
  buildSolHereditControls,
  COLOSSEUM_SPAWN_LAYOUT_KEY,
  COLOSSEUM_START_TILE_KEY,
  COLOSSEUM_START_WAVE_KEY,
  resolveColosseumPlayerStart,
  resolveColosseumSpawnLayout,
  resolveColosseumStartWave,
} from './controls';
import { isSolStageCommand, SOL_ENTRY_MESSAGE, type SolStagePublicState, SolWaveDirector } from './SolWaveDirector';

const seedsSchema = z.object({ encounterSeed: z.number().int().min(0).max(0xffffffff) }).strict();
type SpawnContext = Pick<EncounterContext, 'tick' | 'world' | 'spawnNpc' | 'despawnNpc'> & {
  tickEvents?: EncounterContext['tickEvents'];
};

/**
 * Policy (maintainer's choice): a start on waves 1-11 faces east, from its start tile on the west side
 * of the arena by default (`COLOSSEUM_WAVE_START_TILE`; docs/encounters/fortis-colosseum-policy.md).
 */
const WAVE_START_FACING = 1536;

/** Sol's stage before he arrives: nothing of his fight is on the floor. */
const NO_SOL_STAGE: SolStagePublicState = {
  phase: 0,
  solarflareTiles: [],
  beeTiles: [],
  dangerTiles: [],
  beamTiles: [],
  beamFiredTiles: [],
  sandTiles: [],
  sandDespawning: false,
  grapple: null,
  tripleHitTicks: [],
  crystalCount: 0,
};

/**
 * One Fortis Colosseum run: waves 1-11 (`ColosseumWaveRun`) flowing into Sol Heredit's wave 12
 * (`SolWaveDirector`), or Sol alone for a direct start (`colosseumStartWave` 12, the default), which
 * keeps the preset modifiers, spawn, seeded stream and timing it always had (C = 0).
 */
export class SolHereditEncounter implements Encounter {
  readonly kind = 'sol_heredit';
  readonly runStartMechanicsKeys = [
    COLOSSEUM_START_WAVE_KEY,
    COLOSSEUM_SPAWN_LAYOUT_KEY,
    COLOSSEUM_START_TILE_KEY,
  ] as const;
  /**
   * The run's configured modifier set, one for every start wave: in force from tick 0 for a direct
   * start, and from the start wave's T0 for a wave run, which adds its live picks to it.
   */
  readonly modifiers: EncounterModifierSelection;
  private encounterSeed: number;
  /** Sol's seeded stream. Wave runs draw everything else from their own per-wave streams. */
  private random: () => number;
  private readonly definitions = new NpcDefinitionCollection([
    solDefinition.register({ arena: SOL_ARENA }),
    crystalDefinition.register(undefined),
    solarflareDefinition.register(undefined),
    beesDefinition.register(undefined),
    warbanderDefinition.register(undefined),
    healingTotemDefinition.register(undefined),
    volatilityGibDefinition.register(undefined),
    ...colosseumWaveSpeciesRegistrations(),
  ]);
  private modifierState: ColosseumModifierState;
  private startWave = SOL_WAVE;
  private run: ColosseumWaveRun | null = null;
  private director: SolWaveDirector | null = null;
  /** Set once `createNpcs` has put the opening in the world; a start-wave change after it is an edit. */
  private openingInstalled = false;
  /** The arena the engine installed, before Sol's fence; wave 12 encloses it at C. */
  private arenaBase: ArenaConfig | null = null;

  constructor(encounterSeed = Math.floor(Math.random() * 0x100000000), modifiers: EncounterModifierSelection = {}) {
    this.encounterSeed = seedsSchema.parse({ encounterSeed }).encounterSeed;
    this.random = mulberry32(this.encounterSeed);
    this.modifierState = new ColosseumModifierState(modifiers);
    this.modifiers = this.modifierState.selection;
    this.director = this.createDirector(0);
  }

  /** Sol's beam rounds, for tests that stage a round; only while his stage runs. */
  get beams(): SolBeamRounds {
    if (!this.director) throw new Error('Sol Heredit has not arrived');
    return this.director.beams;
  }
  /** When Sol's enrage drip next strikes, for tests; null before he arrives. */
  get nextEnrageSandTick(): number | null {
    return this.director?.nextEnrageSandTick ?? null;
  }

  /**
   * A changed start wave (tick 0 only) swaps the opening: Sol for a wave run's first choice, or back.
   * An edit of an installed opening that crosses between the waves and Sol opens on the new start's
   * tile, as a fresh start would. The setup applied before `createNpcs` is not an edit: the run keeps
   * the tile it was given (a replay bootstrap's included). A changed start tile alone moves no one, as
   * in the Inferno: it applies from the next fresh start. The spawn layout is the run's from here.
   */
  configureRunStart(mechanics: Readonly<Partial<MechanicsConfig>>, ctx?: EncounterRunStartContext): void {
    const startWave = resolveColosseumStartWave(mechanics);
    if (startWave !== this.startWave) {
      const crossesToOrFromSol = (startWave === SOL_WAVE) !== (this.startWave === SOL_WAVE);
      if (this.director?.sol) ctx?.despawnNpc(this.director.sol.id);
      this.startWave = startWave;
      this.openRun();
      if (this.director) ctx?.spawnNpc(this.director.createSol());
      ctx?.world.occupancy.reconcile(ctx.world.actors.values());
      if (this.openingInstalled && crossesToOrFromSol) ctx?.placePlayer(this.getDefaultPlayerStart(mechanics));
    }
    this.run?.configureSetup(resolveColosseumSpawnLayout(mechanics), resolveColosseumPlayerStart(mechanics));
    this.director?.configureRunStart(mechanics);
    this.modifierState.configureRunStart(mechanics);
  }

  /** Sol's start for a direct start; a wave start's chosen tile (`colosseumStartTile`) or its default. */
  getDefaultPlayerStart(mechanics: Readonly<Partial<MechanicsConfig>>): Coordinate {
    return resolveColosseumPlayerStart(mechanics);
  }
  /** A wave start faces east; a direct Sol start keeps the engine's north. */
  getDefaultPlayerFacing(mechanics: Readonly<Partial<MechanicsConfig>>): number | undefined {
    return resolveColosseumStartWave(mechanics) === SOL_WAVE ? undefined : WAVE_START_FACING;
  }
  getIntroConfig(): null {
    return null;
  }
  getNpcDefinitions(): NpcDefinitionCollection {
    return this.definitions;
  }
  /** A start-wave edit that already added Sol (`configureRunStart`) leaves nothing to add. */
  createNpcs(): NpcActor[] {
    this.openingInstalled = true;
    return this.director && !this.director.sol ? [this.director.createSol()] : [];
  }
  getSeeds(): Record<string, unknown> {
    return { encounterSeed: this.encounterSeed };
  }
  reset(seeds?: Record<string, unknown>): void {
    this.encounterSeed = seedsSchema.parse(
      seeds ?? { encounterSeed: Math.floor(Math.random() * 0x100000000) },
    ).encounterSeed;
    this.random = mulberry32(this.encounterSeed);
    this.openingInstalled = false;
    this.openRun();
  }

  /** The run the current start wave opens: Sol at C = 0 with the set, or a wave run's first choice. */
  private openRun(): void {
    if (this.startWave === SOL_WAVE) {
      this.modifierState = new ColosseumModifierState(this.modifiers);
      this.run = null;
      this.director = this.createDirector(0);
      return;
    }
    this.modifierState = new ColosseumModifierState();
    this.director = null;
    this.run = new ColosseumWaveRun({
      encounterSeed: this.encounterSeed,
      startWave: this.startWave,
      configured: this.modifiers,
      modifierState: this.modifierState,
      definitions: this.definitions,
      onSolControl: (ctx, controlTick) => this.startSol(ctx, controlTick),
    });
  }

  private createDirector(controlTick: number): SolWaveDirector {
    return new SolWaveDirector({
      controlTick,
      encounterSeed: this.encounterSeed,
      // Read through the field, so the stream is the encounter's own whatever replaces it.
      random: () => this.random(),
      modifiers: this.modifierState.selection,
      definitions: this.definitions,
    });
  }

  /** Wave 12's control tick: Sol is added with the modifiers now owned, and the fence closes. */
  private startSol(ctx: EncounterContext, controlTick: number): void {
    this.director = this.createDirector(controlTick);
    ctx.spawnNpc(this.director.createSol());
    setArenaConfig(this.refineArenaConfig(this.arenaBase ?? this.getArenaConfig()), getArenaAllowUnboundedFallback());
  }

  /** Before the cache bake: Sol's floor once his fence stands, else the waves arena's. */
  getArenaConfig(): ArenaConfig {
    if (this.director === null) return colosseumWaveArenaPlaceholder();
    const walkableTiles = new Set<string>();
    for (let x = SOL_ARENA.minX; x <= SOL_ARENA.maxX; x++) {
      for (let y = SOL_ARENA.minY; y <= SOL_ARENA.maxY; y++) {
        if (isInsideArena([x, y], SOL_ARENA)) walkableTiles.add(`${x},${y}`);
      }
    }
    return { bounds: { ...SOL_ARENA, width: 14, height: 14 }, walkableTiles, collisionMap: null };
  }
  /** The descriptor bakes the open waves arena; Sol's fence encloses it from C (A:4976, K:3998). */
  refineArenaConfig(base: ArenaConfig): ArenaConfig {
    this.arenaBase = base;
    return this.director ? composeSolStageArena(base) : base;
  }
  getNpcDamageSourceLabel(sourceId?: string): string {
    if (sourceId === SOL_QUARTET_ACTOR_ID) return 'FremennikWarbandAttack';
    return this.run?.damageLabel(sourceId) ?? 'SolHereditAttack';
  }
  getDefaultMechanicsConfig(): Partial<MechanicsConfig> {
    return buildSolHereditControls().defaultMechanicsConfig;
  }
  getOutcome(): EncounterOutcome {
    return this.director?.getOutcome() ?? { phase: 'active' };
  }
  getEngineRules(): EncounterEngineRules {
    return {
      ...this.modifierState.getEngineRules(),
      validateAttack: (_kind, targetId) =>
        targetId.startsWith(BEAM_CRYSTAL_ACTOR_PREFIX) ||
        targetId.startsWith(SOL_SOLARFLARE_ACTOR_PREFIX) ||
        targetId.startsWith(VOLATILITY_GIB_ACTOR_PREFIX)
          ? false
          : null,
      consumePlayerGuaranteedMaxHit: (ctx) => this.director?.consumePlayerGuaranteedMaxHit(ctx.tick) ?? false,
    };
  }
  acceptsInput(input: EncounterInput): boolean {
    return this.director?.acceptsInput(input) ?? false;
  }

  prepareNpcBand(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): void {
    this.director?.prepareNpcBand(ctx, mechanics);
    this.run?.prepareNpcBand(ctx, SOL_ENTRY_MESSAGE, SOL_PLAYER_START);
  }
  removeNpcIfDue(actor: NpcActor, ctx: EncounterContext): void {
    this.run?.removeNpcIfDue(actor, ctx);
  }
  moveNpc(actor: NpcActor, ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): NpcMovementRequest[] {
    return this.director?.moveNpc(actor, ctx, mechanics) ?? this.run?.moveNpc(actor, ctx) ?? [];
  }
  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    if (this.director) return this.director.processNpcTick(actor, ctx);
    return this.run?.processNpcTick(actor, ctx) ?? { environmentalDamages: [] };
  }
  releaseNpcKillTurn(actor: NpcActor, ctx: EncounterContext): readonly NpcAttackRequest[] {
    return this.run?.releaseNpcKillTurn(actor, ctx) ?? [];
  }
  resolveHazards(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): EnvironmentalDamage[] {
    // Refresh practice aids before any tick damage, including when toggled during a run.
    this.modifierState.configureRunStart(mechanics);
    if (this.director) return this.director.resolveHazards(ctx, mechanics);
    return this.run?.resolveHazards(ctx) ?? [];
  }
  completeNpcBand(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): EnvironmentalDamage[] {
    const damages = this.run?.completeNpcBand(ctx) ?? [];
    if (this.director) damages.push(...this.director.completeNpcBand(ctx, mechanics));
    return damages;
  }
  processPostTick(ctx: EncounterContext): EnvironmentalDamage[] {
    this.run?.processPostTick(ctx);
    this.director?.processPostTick(ctx);
    return [];
  }
  onNpcDefeated(defeat: EncounterNpcDefeat, ctx: EncounterContext, ownership: EncounterCompletionOwnership): void {
    this.director?.onNpcDefeated(defeat, ctx, ownership);
  }

  getSnapshot(ctx: EncounterSnapshotContext): SolHereditSnapshot {
    const tiles = (npcs: readonly NpcActor[]) => npcs.map((npc) => [...npc.position] as Coordinate);
    const sol = this.director?.getSnapshotState(ctx) ?? {
      ...NO_SOL_STAGE,
      solarflareTiles: tiles(ctx.world.getNpcs().filter(solarflareDefinition.isActor)),
      beeTiles: tiles(ctx.world.getNpcs().filter(beesDefinition.isActor)),
    };
    const heldOrbs = ctx.world
      .getNpcs()
      .filter(manticoreDefinition.isActor)
      .flatMap((manticore) => manticoreHeldOrbs(manticore, ctx.tick));
    return {
      kind: 'sol_heredit',
      state: {
        ...sol,
        modifiers: this.modifierState.selection,
        doomStacks: this.modifierState.doomStacks,
        run: this.runState(),
        // Omitted for a direct Sol start, so its snapshots stay as they were.
        ...(this.run ? { runSetup: this.run.getSetupState() } : {}),
      },
      visuals: {
        solControlTick: this.director?.controlTick ?? null,
        // Omitted while no orb is held, so a direct Sol start's snapshots stay as they were.
        ...(heldOrbs.length > 0 ? { heldOrbs } : {}),
      },
    };
  }
  private runState(): ColosseumRunPublicState {
    return this.run?.getPublicState() ?? DIRECT_SOL_RUN_STATE;
  }

  executeCommand(
    command: EncounterCommand,
    ctx: EncounterCommandContext,
    mechanics: Readonly<Partial<MechanicsConfig>>,
  ): EncounterCommandResult | undefined {
    if (command.encounter !== 'sol_heredit') return undefined;
    if (command.type === 'confirm-modifier') {
      const accepted = this.run?.confirm(command, ctx.tick) ?? false;
      // The game's confirm sound (synth 8010) plays on Tk for every accepted choice, never a rejected one.
      return accepted ? { gameEvents: [{ type: COLOSSEUM_MODIFIER_CONFIRMED_EVENT, wave: command.wave }] } : {};
    }
    if (!isSolStageCommand(command) || !this.director) return {};
    return this.director.executeCommand(command, ctx, mechanics);
  }
  /**
   * The layout tool's Start (`go-to-wave`): a fresh run of the saved setup from the wave it names, on
   * the setup's own start tile. As the Inferno's Go, the wave being fought again keeps the run's seed,
   * so an edited layout is tried against the same wave (its warband, reinforcements, offer and the rest
   * of a partial layout); another wave is a new attempt with new seeds. A plain restart (Restart fight,
   * Ctrl+R) always draws new seeds, so a saved layout repeats and random spawns stay random.
   */
  planPracticeRestart(command: EncounterCommand): EncounterPracticeRestart | undefined {
    if (command.encounter !== 'sol_heredit' || command.type !== 'go-to-wave') return undefined;
    const wave = Math.min(SOL_WAVE, Math.max(FIRST_COLOSSEUM_WAVE, Math.round(command.wave)));
    const current = this.run?.getPublicState().wave ?? SOL_WAVE;
    return {
      ...(wave === current ? { encounterSeeds: { encounterSeed: this.encounterSeed } } : {}),
      runMechanics: { [COLOSSEUM_START_WAVE_KEY]: String(wave) },
    };
  }
  syncBossHp(hp: number, ctx: Pick<EncounterContext, 'world'>): void {
    this.director?.syncBossHp(hp, ctx);
  }
  enterBossHpPhase(hp: number, ctx: SpawnContext): void {
    this.director?.enterBossHpPhase(hp, ctx);
  }
}
