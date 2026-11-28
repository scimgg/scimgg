import type { NpcActor } from '../../core/actors/NpcActor';
import type { EncounterCommand } from '../../core/encounters/commands';
import type { EncounterModifierSelection } from '../../core/encounters/encounterFactory';
import type { EncounterOutcome } from '../../core/encounters/outcome';
import type { EncounterSnapshotContext } from '../../core/encounters/snapshot';
import type {
  EncounterCommandContext,
  EncounterCommandResult,
  EncounterCompletionOwnership,
  EncounterContext,
  EncounterInput,
  EncounterNpcDefeat,
  EncounterTickResult,
  EnvironmentalDamage,
  NpcMovementRequest,
} from '../../core/encounters/types';
import { emitEncounterVisual, encounterVisual } from '../../core/events/encounterVisual';
import { CHAT_HIGHLIGHT_COLORS } from '../../core/events/gameMessages';
import type { EmittableGameEvent } from '../../core/events/TickEvents';
import type { OverheadTextSegment } from '../../core/events/types';
import type { NpcDefinitionCollection } from '../../core/npcs';
import { solAttackReady, solGroundTiles } from '../../npcs/colosseum/attackScheduler';
import {
  BEAM_CRYSTAL_ACTOR_PREFIX,
  COLOSSEUM_SPOTANIMS,
  SOL_ACTOR_ID,
  SOL_CHAT_NAME,
} from '../../npcs/colosseum/constants';
import { createCrystal, crystalBeamDirection, crystalDefinition } from '../../npcs/colosseum/crystal';
import {
  acceptsSolParry,
  GRAPPLE_TAUNT_COLOR,
  type GrappleTarget,
  grappleTauntSegments,
  grappleWarningMessage,
} from '../../npcs/colosseum/grapple';
import {
  cancelSolAttacks,
  clearSolAbilities,
  consumeSolParryReward,
  createSol,
  launchSolIfReady,
  resetSolForPreset,
  resolveSolParries,
  type SolActor,
  solDefinition,
  solLaunchesThisTick,
} from '../../npcs/colosseum/sol';
import type { SolAttackStyle } from '../../npcs/colosseum/solAttacks';
import { colosseumBeamGraphics } from '../../npcs/colosseum/visualEvents';
import { warbanderDefinition } from '../../npcs/colosseum/warband';
import type { Coordinate, MechanicsConfig } from '../../types/simulation';
import { beesDefinition } from '../colosseum/modifiers/bees';
import { solarflareDefinition } from '../colosseum/modifiers/solarflare';
import { SolBeamRounds } from './beams';
import type { SolHereditEncounterCommand } from './commands';
import {
  ENRAGE_SAND_BATCH_SIZE,
  ENRAGE_SAND_FIRST_SINGLE_DELAY_TICKS,
  ENRAGE_SAND_INTERVAL_TICKS,
  SAND_BATCH_SIZE,
  SOL_ARENA,
  SOL_BEAM_PREPARED_EVENT,
  SOL_DEATH_CLEANUP_DELAY_TICKS,
  SOL_DEATH_SAND_REMOVAL_DELAY_TICKS,
  SOL_ENTRY_MESSAGE_TICK,
  SOL_FIRST_ATTACK_TICK,
  SOL_OPENING_HOLD_UNTIL_TICK,
  SOL_OPENING_TAUNT_TICK,
  SOL_SOLARFLARE_ACTOR_PREFIX,
  SOL_START_POSITION,
  SOL_VICTORY_COMPLETION_DELAY_TICKS,
  TRANSITION_ATTACK_RESUME_TICKS,
  TRANSITION_CRYSTAL_DELAY_TICKS,
  TRANSITION_SAND_DELAY_TICKS,
} from './constants';
import { SOL_HEREDIT_ATTACK_STYLE_KEY } from './controls';
import { SolModifierEffects } from './modifierEffects';
import { MoltenSand, type SandStrike } from './moltenSand';
import {
  isEnraged,
  phaseForHp,
  SOL_OPENING_TAUNT,
  SOL_PHASE_TRANSITIONS,
  type SolPhase,
  solVictoryTaunt,
} from './phases';
import type { SolHereditPublicState } from './snapshot';

type SpawnContext = Pick<EncounterContext, 'tick' | 'world' | 'spawnNpc' | 'despawnNpc'> & {
  tickEvents?: EncounterContext['tickEvents'];
};

/** The Sol-stage part of the published state; the run owner adds modifiers, Doom and the run. */
export type SolStagePublicState = Omit<SolHereditPublicState, 'modifiers' | 'doomStacks' | 'run'>;

export interface SolWaveDirectorInput {
  /** C: the world tick Sol is added. 0 for a direct wave-12 start. */
  readonly controlTick: number;
  readonly encounterSeed: number;
  /** Sol's own seeded stream, read through the owner so it stays the one stream for the whole fight. */
  readonly random: () => number;
  /** The modifiers in force when Sol arrives; no choice follows wave 12's. */
  readonly modifiers: EncounterModifierSelection;
  readonly definitions: NpcDefinitionCollection;
}

/**
 * Wave 12: Sol Heredit's fight from C, the tick he is added. Opening deadlines are `C + offset`; every
 * later timer is scheduled from its own event's tick, so a shifted fight plays the direct one's rules.
 */
export class SolWaveDirector {
  readonly controlTick: number;
  readonly beams = new SolBeamRounds();
  private readonly encounterSeed: number;
  private readonly random: () => number;
  private readonly modifiers: EncounterModifierSelection;
  private readonly definitions: NpcDefinitionCollection;
  private outcome: EncounterOutcome = { phase: 'active' };
  private boss: SolActor | null = null;
  private readonly sand = new MoltenSand();
  private phase: SolPhase = 0;
  /** Last tick's Sol Attacks toggle; switching it off cancels his attacks in flight. */
  private attacksWereEnabled = true;
  private enrageSandTick: number | null = null;
  /** World tick a raw HP set last started the drip; a preset applied on that tick reuses its roll. */
  private rawEnrageArmTick: number | null = null;
  private pendingTransitions: { readonly tick: number; readonly kind: 'sand' | 'crystal' }[] = [];
  private deathCleanupTick: number | null = null;
  /** From Sol's death the pools play their despawn until they are removed on this tick. */
  private sandRemovalTick: number | null = null;
  private readonly modifierEffects: SolModifierEffects;

  constructor(input: SolWaveDirectorInput) {
    this.controlTick = input.controlTick;
    this.encounterSeed = input.encounterSeed;
    this.random = input.random;
    this.modifiers = input.modifiers;
    this.definitions = input.definitions;
    this.modifierEffects = new SolModifierEffects(this.modifiers, this.controlTick);
  }

  get nextEnrageSandTick(): number | null {
    return this.enrageSandTick;
  }

  get sol(): SolActor | null {
    return this.boss;
  }

  configureRunStart(mechanics: Readonly<Partial<MechanicsConfig>>): void {
    // A run that starts with his attacks off has nothing to cancel on its first tick.
    this.attacksWereEnabled = mechanics.solHereditAttacks !== false;
  }

  createSol(): SolActor {
    this.boss = createSol({
      id: SOL_ACTOR_ID,
      position: SOL_START_POSITION,
      targetId: 'player',
      addedTick: this.controlTick,
      firstAttackTick: this.controlTick + SOL_FIRST_ATTACK_TICK,
      holdUntilTick: this.controlTick + SOL_OPENING_HOLD_UNTIL_TICK,
      relentless: this.modifiers.relentless ?? 0,
    });
    return this.boss;
  }

  getOutcome(): EncounterOutcome {
    return this.outcome;
  }

  validateAttack(targetId: string): boolean | null {
    return targetId.startsWith(BEAM_CRYSTAL_ACTOR_PREFIX) || targetId.startsWith(SOL_SOLARFLARE_ACTOR_PREFIX)
      ? false
      : null;
  }

  consumePlayerGuaranteedMaxHit(tick: number): boolean {
    return this.boss !== null && consumeSolParryReward(this.boss, tick);
  }

  acceptsInput(input: EncounterInput): boolean {
    return input.kind === 'equipmentSlotClick' && this.boss !== null && acceptsSolParry(this.boss.state.grapple);
  }

  /*
   * NPC band. Sol is created first, so he takes the first turn: his own hits land before his turn
   * decides the beam hold, which therefore still precedes every crystal's step. Everything else he
   * owns (phases, transitions, beams, parries, his attacks, totems, Bees' stings, Solarflare,
   * Volatility and the death cleanup) stays in `completeNpcBand`, after every NPC's damage has
   * landed, in the order it always ran. The Quartet warbander alone acts in its own turn.
   */
  prepareNpcBand(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): void {
    // A round switched off is canceled before anything moves, Sol or no Sol.
    if (mechanics.solHereditBeams === false) this.beams.cancelRound(this.crystals(ctx.world));
  }

  /** Sol's stage actors' steps; null for an actor that is not his stage's. */
  moveNpc(actor: NpcActor, ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): NpcMovementRequest[] | null {
    const context = { ...ctx, random: this.random };
    const boss = this.boss && ctx.world.actors.get(this.boss.id) === this.boss ? this.boss : null;
    if (actor === boss) {
      const phasePending = phaseForHp(boss.vitals.hp, boss.vitals.maxHp) > this.phase;
      // A pending transition's taunt takes Sol's attack slot, so no warning goes out on that tick
      // (M 8501: enrage taunt where the warning was due, crystals keep patrolling). Asked from the tile
      // Sol starts his turn on, before his own step.
      const crystals = this.crystals(ctx.world);
      if (
        mechanics.solHereditBeams !== false &&
        !phasePending &&
        this.beams.isReady(crystals, ctx.tick) &&
        this.solAttacks(boss, ctx, mechanics)
      )
        this.beams.holdForWarning(crystals);
      // Capture analysis section 9: hold a pending phase without moving its processing stage.
      return phasePending ? [] : this.definitions.move(boss, context);
    }
    if (crystalDefinition.isActor(actor)) return this.definitions.move(actor, context);
    if (solarflareDefinition.isActor(actor)) {
      return this.modifierEffects.shouldMoveOrbs(ctx.tick) ? this.definitions.move(actor, context) : [];
    }
    if (beesDefinition.isActor(actor) || warbanderDefinition.isActor(actor)) {
      return boss?.alive ? this.definitions.move(actor, context) : [];
    }
    return null;
  }

  /** Like Bees' stings, the Quartet warbander only attacks while Sol is alive. */
  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    if (!warbanderDefinition.isActor(actor) || this.boss?.alive !== true) return { environmentalDamages: [] };
    return this.definitions.tick(actor, { ...ctx, random: this.random });
  }

  resolveHazards(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): EnvironmentalDamage[] {
    this.modifierEffects.advanceRespawns(ctx);
    // Sand checks the tile the player starts the tick on, so it resolves before movement. Switched
    // off, the pools keep forming out of sight and burn again once it is back on.
    this.sand.advance(ctx.tick);
    if (mechanics.solHereditSand === false || !this.boss?.alive || ctx.world.actors.get(this.boss.id) !== this.boss)
      return [];
    return this.sand.resolve(ctx);
  }

  completeNpcBand(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): EnvironmentalDamage[] {
    const attacksEnabled = mechanics.solHereditAttacks !== false;
    // Switching his attacks off stops their damage at once; one queued while they were off is kept.
    if (this.attacksWereEnabled && !attacksEnabled && this.boss) cancelSolAttacks(this.boss);
    this.attacksWereEnabled = attacksEnabled;
    // D+9 modifier damage must resolve before post-tick decides whether the player won.
    const bossAlive = this.boss?.alive === true;
    const environmentalDamages = this.modifierEffects.processTick(ctx, bossAlive, this.random);
    // A heal lands before this tick's phase check, so HP healed back above a threshold Sol is still
    // waiting to announce defers that transition; one already announced never repeats.
    this.modifierEffects.advanceTotemic(ctx, bossAlive ? this.boss : null);
    const context = { ...ctx, random: this.random };
    if (this.deathCleanupTick !== null && ctx.tick >= this.deathCleanupTick) {
      this.deathCleanupTick = null;
      for (const crystal of ctx.world.getNpcs().filter(crystalDefinition.isActor)) ctx.despawnNpc(crystal.id);
      this.modifierEffects.cleanupNpcs(ctx);
      this.say(ctx, solVictoryTaunt(this.encounterSeed));
    }
    if (this.sandRemovalTick !== null && ctx.tick >= this.sandRemovalTick) {
      this.sandRemovalTick = null;
      this.sand.clear();
    }
    const boss = this.boss;
    if (!boss?.alive || ctx.world.actors.get(boss.id) !== boss) return environmentalDamages;
    // A run that came through the waves announced the jump from wave 12's start instead.
    if (this.controlTick === 0 && ctx.tick === SOL_ENTRY_MESSAGE_TICK)
      ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: SOL_ENTRY_MESSAGE });
    if (ctx.tick === this.controlTick + SOL_OPENING_TAUNT_TICK) this.say(ctx, SOL_OPENING_TAUNT);
    this.advancePhase(ctx, boss);
    this.runTransitionSchedule(ctx, mechanics);
    this.runEnrageSand(ctx, mechanics);
    environmentalDamages.push(...this.runBeams(ctx, mechanics));
    environmentalDamages.push(...resolveSolParries(boss, ctx, this.random));
    environmentalDamages.push(...this.definitions.resolveLocalEffects(boss, context));
    const launch = launchSolIfReady(boss, ctx, {
      phase: this.phase,
      random: this.random,
      enabled: attacksEnabled,
      stylePin: solHereditStylePin(mechanics),
    });
    const grappleTarget = boss.state.grapple.pending?.target;
    if (launch.taunt !== null && grappleTarget) {
      ctx.tickEvents.emit(this.grappleTauntEvent(grappleTarget));
      ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: grappleWarningMessage(grappleTarget) });
    } else if (launch.taunt !== null) this.say(ctx, launch.taunt);
    // With his attacks switched off there is no telegraph to key to, so a ready round warns at once.
    if (mechanics.solHereditBeams !== false && (launch.launched || !attacksEnabled)) {
      const fireInTicks = this.beams.prepare(this.crystals(ctx.world), ctx.tick, isEnraged(this.phase));
      if (fireInTicks !== null) ctx.tickEvents.emit({ type: SOL_BEAM_PREPARED_EVENT, fireInTicks });
    }
    return environmentalDamages;
  }

  processPostTick(ctx: EncounterContext): void {
    // NPC-phase explosion damage, Doom and player timers have all resolved by this point.
    // A lethal D+9 blast therefore loses the reward (Wiki Strategies oldid=15354864).
    if (this.outcome.phase === 'resolving' && ctx.tick >= this.outcome.completionTick && ctx.world.getPlayer()?.alive) {
      this.outcome = { ...this.outcome, phase: 'victory' };
    }
  }

  onNpcDefeated(defeat: EncounterNpcDefeat, ctx: EncounterContext, ownership: EncounterCompletionOwnership): void {
    this.modifierEffects.onNpcDefeated(defeat, ctx.world);
    if (defeat.npcId !== SOL_ACTOR_ID) return;
    if (this.boss) this.modifierEffects.onSolDefeated(defeat.tick, this.boss.position, this.boss.size);
    if (this.boss) clearSolAbilities(this.boss);
    // Stop attacks immediately; the retained pools/crystals are harmless behind the alive guards.
    this.beams.reset();
    // The crystals play their despawn on the death tick and are removed at the cleanup tick.
    emitEncounterVisual(ctx.tickEvents, {
      projectiles: [],
      animations: this.crystals(ctx.world).map((crystal) => ({
        actorId: crystal.id,
        clipId: 'despawn',
        delayCycles: 0,
      })),
      graphics: [],
    });
    this.deathCleanupTick = defeat.tick + SOL_DEATH_CLEANUP_DELAY_TICKS;
    this.sand.stopForming(defeat.tick);
    this.sandRemovalTick = defeat.tick + SOL_DEATH_SAND_REMOVAL_DELAY_TICKS;
    this.enrageSandTick = null;
    this.pendingTransitions = [];
    if (ownership !== 'encounter-owned') return;
    this.outcome = {
      phase: 'resolving',
      decisiveTick: defeat.tick,
      completionTick: defeat.tick + SOL_VICTORY_COMPLETION_DELAY_TICKS,
      primaryActorId: SOL_ACTOR_ID,
      completionActorIds: [SOL_ACTOR_ID],
    };
  }

  getSnapshotState(ctx: EncounterSnapshotContext): SolStagePublicState {
    const state = this.boss ? solDefinition.getState(this.boss) : null;
    const grapple = state?.grapple.pending;
    const player = ctx.world.getPlayer();
    return {
      phase: this.phase,
      solarflareTiles: this.modifierEffects.orbs(ctx.world).map((orb) => [...orb.position] as Coordinate),
      beeTiles: this.modifierEffects.bees(ctx.world).map((bee) => [...bee.position] as Coordinate),
      // Previews where the pending attack would land from the player's current tile; spears only
      // pick their direction on the landing tick.
      dangerTiles:
        state?.scheduler.pendingGround && this.boss && player
          ? solGroundTiles(state.scheduler.pendingGround, {
              position: this.boss.position,
              target: player.position,
              arena: SOL_ARENA,
            }).tiles.map(([x, y]): Coordinate => [x, y])
          : [],
      beamTiles: this.beams.getChargingLines().map(([x, y]): Coordinate => [x, y]),
      beamFiredTiles: this.beams.getFiredLines(ctx.tick).map(([x, y]): Coordinate => [x, y]),
      sandTiles: ctx.mechanics.solHereditSand === false ? [] : this.sand.getActivePools(),
      sandDespawning: this.sandRemovalTick !== null,
      grapple: grapple
        ? { slot: grapple.target.slot, taunt: grapple.target.taunt, resolveTick: grapple.startTick + 4 }
        : null,
      tripleHitTicks: state?.scheduler.pendingTriple.map((hit) => hit.tick) ?? [],
      crystalCount: this.crystals(ctx.world).length,
    };
  }

  /** Sol's practice aids; they act only while he is up. */
  executeCommand(
    command: SolStageCommand,
    ctx: EncounterCommandContext,
    mechanics: Readonly<Partial<MechanicsConfig>>,
  ): EncounterCommandResult {
    if (!this.boss?.alive || ctx.world.actors.get(this.boss.id) !== this.boss) return {};
    switch (command.type) {
      case 'spawn-crystal':
        this.addCrystal(ctx);
        break;
      // Queued for his next ready, in-reach slot so the special keeps his real cadence, telegraph and
      // bookkeeping and never overlaps an attack in flight. The latest request replaces a queued one.
      case 'trigger-grapple':
        this.boss.state.scheduler.forcedSpecial = 'grapple';
        break;
      case 'trigger-triple':
        this.boss.state.scheduler.forcedSpecial = 'triple';
        break;
      case 'strike-sand': {
        const strike = this.sand.strike(ctx.playerPos, SAND_BATCH_SIZE, ctx.tick, this.random);
        return { gameEvents: mechanics.solHereditSand === false ? [] : [sandVisualEvent(strike)] };
      }
      case 'clear-sand':
        this.sand.clear();
        break;
      default:
        return assertNever(command);
    }
    return {};
  }

  syncBossHp(hp: number, ctx: Pick<EncounterContext, 'world'>): void {
    if (!this.boss) return;
    this.phase = phaseForHp(hp, this.boss.vitals.maxHp);
    // Entering enrage starts the drip as a preset does; a drip already running keeps its rhythm.
    if (!isEnraged(this.phase) || hp <= 0) this.enrageSandTick = null;
    else if (this.enrageSandTick === null) {
      this.enrageSandTick = ctx.world.tick + this.rollFirstEnrageSandDelay();
      this.rawEnrageArmTick = ctx.world.tick;
      this.beams.enrage(ctx.world.tick);
    }
  }

  enterBossHpPhase(hp: number, ctx: SpawnContext): void {
    if (!this.boss?.alive || hp <= 0) return;
    this.phase = phaseForHp(hp, this.boss.vitals.maxHp);
    resetSolForPreset(this.boss, ctx.tick + TRANSITION_ATTACK_RESUME_TICKS);
    this.pendingTransitions = [];
    this.sand.clear();
    for (const crystal of ctx.world.getNpcs().filter(crystalDefinition.isActor)) ctx.despawnNpc(crystal.id);
    this.modifierEffects.resetTotemic(ctx);
    this.beams.reset();
    const count = SOL_PHASE_TRANSITIONS.slice(0, this.phase).filter((transition) => transition.addsCrystal).length;
    for (let index = 0; index < count; index++) this.addCrystal(ctx);
    // The engine syncs the HP first. A drip that sync started on this tick is already a fresh preset
    // roll; any other running drip is restarted so the same preset always lands on the same state.
    if (!isEnraged(this.phase)) this.enrageSandTick = null;
    else if (this.enrageSandTick === null || this.rawEnrageArmTick !== ctx.tick)
      this.enrageSandTick = ctx.tick + this.rollFirstEnrageSandDelay();
  }

  /** Every taunt is also NPC public chat (`npc_say` "Sol Heredit|<text>" at L's phase and death taunts). */
  private say(ctx: Pick<EncounterContext, 'tickEvents'>, text: string): void {
    ctx.tickEvents.emit(this.tauntEvent(text));
    ctx.tickEvents.emit({ type: 'game_message', kind: 'public', speaker: SOL_CHAT_NAME, segments: [{ text }] });
  }
  private tauntEvent(text: string): EmittableGameEvent {
    return {
      type: 'overhead_text',
      anchor: { kind: 'actor', actorId: SOL_ACTOR_ID },
      overheadText: text,
      overheadCycle: 5,
    };
  }
  private grappleTauntEvent(target: GrappleTarget): EmittableGameEvent {
    return {
      ...this.tauntEvent(target.taunt),
      overheadTextColor: GRAPPLE_TAUNT_COLOR,
      overheadTextSegments: grappleTauntSegments(target),
    };
  }
  /**
   * A crossed HP threshold waits for Sol's next attack slot: the attack in flight still lands, then
   * the taunt takes the slot an attack would have used and the next attack follows seven ticks
   * later. All 15 captured transitions fall exactly on the previous telegraph plus its cooldown
   * (e.g. K shield 4100 -> taunt 4105; M long triple 8489 -> 8501 after its 8499 hit; analysis
   * section 11). The player was in reach at every one, so whether reach gates it is unrecorded;
   * here it does not. PROVISIONAL: two thresholds crossed at once take consecutive slots.
   */
  private advancePhase(ctx: EncounterContext, boss: SolActor): void {
    if (
      phaseForHp(boss.vitals.hp, boss.vitals.maxHp) <= this.phase ||
      boss.state.grapple.pending !== null ||
      !solAttackReady(boss.state.scheduler, ctx.tick)
    )
      return;
    const transition = SOL_PHASE_TRANSITIONS[this.phase];
    const phases = [0, 1, 2, 3, 4, 5] as const;
    this.phase = phases[this.phase + 1];
    this.say(ctx, transition.taunt);
    // PROVISIONAL overlap policy: preserve longer locks (capture analysis section 9).
    boss.state.immobileUntilTick = Math.max(boss.state.immobileUntilTick, ctx.tick + 5);
    boss.state.scheduler.nextAttackTick = ctx.tick + TRANSITION_ATTACK_RESUME_TICKS;
    boss.state.scheduler.forceSpearNext = true;
    this.pendingTransitions.push({ tick: ctx.tick + TRANSITION_SAND_DELAY_TICKS, kind: 'sand' });
    if (transition.addsCrystal)
      this.pendingTransitions.push({ tick: ctx.tick + TRANSITION_CRYSTAL_DELAY_TICKS, kind: 'crystal' });
    if (isEnraged(this.phase)) {
      this.enrageSandTick = ctx.tick + TRANSITION_SAND_DELAY_TICKS + this.rollFirstEnrageSandDelay();
      this.beams.enrage(ctx.tick);
    }
  }
  private runTransitionSchedule(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): void {
    const due = this.pendingTransitions.filter((entry) => entry.tick === ctx.tick);
    this.pendingTransitions = this.pendingTransitions.filter((entry) => entry.tick > ctx.tick);
    for (const entry of due) {
      switch (entry.kind) {
        case 'sand':
          this.strikeSand(
            ctx,
            mechanics,
            this.sand.strike(
              ctx.playerPos,
              isEnraged(this.phase) ? ENRAGE_SAND_BATCH_SIZE : SAND_BATCH_SIZE,
              ctx.tick,
              this.random,
            ),
          );
          break;
        case 'crystal':
          if (mechanics.solHereditBeams !== false) this.addCrystal(ctx);
          break;
        default:
          assertNever(entry.kind);
      }
    }
  }
  private rollFirstEnrageSandDelay(): number {
    const [min, max] = ENRAGE_SAND_FIRST_SINGLE_DELAY_TICKS;
    return min + Math.floor(this.random() * (max - min + 1));
  }
  private runEnrageSand(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): void {
    if (this.enrageSandTick === null || ctx.tick < this.enrageSandTick) return;
    this.enrageSandTick = ctx.tick + ENRAGE_SAND_INTERVAL_TICKS;
    this.strikeSand(ctx, mechanics, this.sand.strike(ctx.playerPos, 1, ctx.tick, this.random, false));
  }
  /**
   * Strikes roll and form whatever the Molten Sand toggle says, so switching it never shifts the
   * seeded stream; switched off, only the bolt is hidden (the snapshot hides the pools).
   */
  private strikeSand(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>, strike: SandStrike): void {
    if (mechanics.solHereditSand !== false) ctx.tickEvents.emit(sandVisualEvent(strike));
  }
  private crystals(world: EncounterContext['world']) {
    return world
      .getNpcs()
      .filter(crystalDefinition.isActor)
      .filter((actor) => actor.alive)
      .sort((left, right) => left.state.index - right.state.index);
  }
  /** Whether Sol attacks this tick, asked before his launch runs; see `solLaunchesThisTick`. */
  private solAttacks(boss: SolActor, ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): boolean {
    return mechanics.solHereditAttacks === false || solLaunchesThisTick(boss, ctx, boss.position);
  }
  private runBeams(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): EnvironmentalDamage[] {
    const crystals = this.crystals(ctx.world);
    if (mechanics.solHereditBeams === false) {
      this.beams.cancelRound(crystals);
      return [];
    }
    // Last tick's fire tested the tile the player started that tick on; its hit lands now.
    const damages = this.beams.takeHitIfDue(ctx.tick, ctx.playerPos, {
      random: this.random,
      relentless: this.modifiers.relentless ?? 0,
    });
    const charging = this.beams.startChargeIfDue(crystals, ctx.tick);
    if (charging)
      emitEncounterVisual(ctx.tickEvents, {
        projectiles: [],
        animations: charging.lines.map((line) => ({ actorId: line.actorId, clipId: 'charge', delayCycles: 0 })),
        graphics: charging.lines.flatMap((line) =>
          colosseumBeamGraphics(crystalBeamDirection(line.index), line.tiles, 'charge'),
        ),
      });
    const fired = this.beams.fireIfDue(crystals, {
      tick: ctx.tick,
      playerPos: ctx.playerPos,
      phase: this.phase,
      random: this.random,
    });
    if (fired)
      emitEncounterVisual(ctx.tickEvents, {
        projectiles: [],
        animations: fired.round.lines.map((line) => ({ actorId: line.actorId, clipId: 'attack', delayCycles: 0 })),
        graphics: fired.round.lines.flatMap((line) =>
          colosseumBeamGraphics(crystalBeamDirection(line.index), line.tiles, 'fire'),
        ),
      });
    return damages;
  }
  private addCrystal(ctx: SpawnContext): void {
    const existing = ctx.world.getNpcs().filter(crystalDefinition.isActor);
    const index = [0, 1, 2, 3].find((candidate) => existing.every((actor) => actor.state.index !== candidate));
    if (index === undefined) return;
    const actor = createCrystal({
      id: `${BEAM_CRYSTAL_ACTOR_PREFIX}_${index}`,
      index,
      tick: ctx.tick,
      charging: this.beams.isHolding(),
    });
    this.beams.enroll(ctx.tick);
    ctx.spawnNpc(actor);
    if (ctx.tickEvents)
      emitEncounterVisual(ctx.tickEvents, {
        projectiles: [],
        animations: [{ actorId: actor.id, clipId: 'spawn', delayCycles: 0 }],
        graphics: [],
      });
  }
}

/** The run owner's commands: the intermission's Continue and the practice restart. */
type SolRunCommand = Extract<SolHereditEncounterCommand, { type: 'confirm-modifier' | 'go-to-wave' }>;
export type SolStageCommand = Exclude<SolHereditEncounterCommand, SolRunCommand>;

/** Sol's own commands, so the run owner can route the rest. */
export function isSolStageCommand(command: EncounterCommand): command is SolStageCommand {
  return command.encounter === 'sol_heredit' && command.type !== 'confirm-modifier' && command.type !== 'go-to-wave';
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown Sol Heredit action: ${JSON.stringify(value)}`);
}
/** The Attack Style practice pin; anything but a known style (including a stale stored value) is random. */
function solHereditStylePin(mechanics: Readonly<Partial<MechanicsConfig>>): SolAttackStyle | undefined {
  const pin = mechanics[SOL_HEREDIT_ATTACK_STYLE_KEY];
  return pin === 'spear' || pin === 'shield' ? pin : undefined;
}
/**
 * "Sol Heredit jumps down from his seat..." arrives at T0+1 of wave 12 (A:4971, K:3993), five ticks
 * before control; a direct start has no earlier tick, so it goes out on the first simulated one.
 */
export const SOL_ENTRY_MESSAGE: readonly OverheadTextSegment[] = [
  { text: `${SOL_CHAT_NAME} jumps down from his seat...`, color: CHAT_HIGHLIGHT_COLORS.red },
];
/** A sand strike's lightning on each struck tile; emitted even when it struck none, as it always was. */
function sandVisualEvent(strike: SandStrike): EmittableGameEvent {
  return encounterVisual({
    animations: [],
    projectiles: [],
    graphics: strike.tiles.map(([x, y]) => ({
      spotAnimId: COLOSSEUM_SPOTANIMS.sunfireLightning,
      target: { kind: 'tile', position: [x, y] },
      delayCycles: 30,
      height: 0,
    })),
  });
}
