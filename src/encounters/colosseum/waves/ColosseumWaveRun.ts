import type { NpcActor } from '../../../core/actors/NpcActor';
import { isWalkableTile, SIMULATION_START_TICK } from '../../../core/constants';
import type { EncounterModifierSelection, EncounterModifierTier } from '../../../core/encounters/encounterFactory';
import type {
  EncounterContext,
  EncounterTickResult,
  EnvironmentalDamage,
  NpcAttackRequest,
  NpcMovementRequest,
} from '../../../core/encounters/types';
import { emitEncounterVisual } from '../../../core/events/encounterVisual';
import { CHAT_HIGHLIGHT_COLORS } from '../../../core/events/gameMessages';
import type { OverheadTextSegment } from '../../../core/events/types';
import type { NpcDefinitionCollection } from '../../../core/npcs';
import type { ColosseumRelentlessRank } from '../../../npcs/colosseum/constants';
import { javelinColossusDefinition, landJavelinArtillery } from '../../../npcs/colosseum/javelinColossus';
import { manticoreDefinition, releaseManticoreKillTurn } from '../../../npcs/colosseum/manticore';
import { createWarbander } from '../../../npcs/colosseum/warband';
import type { Coordinate } from '../../../types/simulation';
import { COLOSSEUM_MODIFIER_IDS, type ColosseumModifierId, colosseumModifierTierCount } from '../modifiers/definitions';
import {
  drawColosseumModifierOffers,
  eligibleColosseumModifierPicks,
  SUPPORTED_WAVE_MODIFIERS,
} from '../modifiers/offers';
import type { ColosseumModifierState } from '../modifiers/rules';
import {
  volatilityExplosionDamage,
  volatilityExplosionGraphics,
  volatilityGibForNpcType,
} from '../modifiers/volatility';
import { createVolatilityGib, VOLATILITY_GIB_ACTOR_PREFIX, volatilityGibDefinition } from './gibs';
import {
  COLOSSEUM_SPAWN_POINTS,
  colosseumReinforcementGate,
  colosseumStreams,
  placeReinforcements,
  planColosseumWave,
  type ReinforcementDraw,
  type SpeciesSpawn,
} from './layout';
import type {
  ColosseumModifierOfferState,
  ColosseumPick,
  ColosseumRunPublicState,
  ColosseumRunSetupState,
  ColosseumStage,
} from './snapshot';
import {
  COLOSSEUM_WAVE_START_TILE,
  type ColosseumLayoutSpecies,
  type ColosseumSpawnLayout,
  colosseumLayoutSpeciesForWave,
  serializeColosseumSpawnLayout,
  serializeColosseumStartTile,
} from './spawnLayout';
import { COLOSSEUM_WAVE_SPECIES, WARBAND_DAMAGE_LABEL, WARBAND_REMOVAL_DELAY_TICKS } from './species';
import { ColosseumWaveModifiers } from './waveModifiers';
import {
  COLOSSEUM_OFFER_DELAY_TICKS,
  COLOSSEUM_REINFORCEMENT_DELAY_TICKS,
  COLOSSEUM_WAVE_START_DELAY_TICKS,
  FIRST_COLOSSEUM_WAVE,
  LAST_COLOSSEUM_WAVE,
  SOL_WAVE,
  SOL_WAVE_SCHEDULE,
} from './waveTable';

/** C:334 `<col=ff3045>Wave: 1</col>`. */
function waveMessage(wave: number): readonly OverheadTextSegment[] {
  return [{ text: `Wave: ${wave}`, color: CHAT_HIGHLIGHT_COLORS.red }];
}

/** C:955 `Wave 1 completed! Wave duration: <col=ff3045>0:16.80</col>` for 28 ticks. */
export function waveCompletedMessage(wave: number, ticks: number): readonly OverheadTextSegment[] {
  const centiseconds = ticks * 60;
  const minutes = Math.floor(centiseconds / 6000);
  const seconds = Math.floor((centiseconds % 6000) / 100);
  const hundredths = centiseconds % 100;
  return [
    { text: `Wave ${wave} completed! Wave duration: ` },
    {
      text: `${minutes}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`,
      color: CHAT_HIGHLIGHT_COLORS.red,
    },
  ];
}

/**
 * A run's configured modifier set, checked once: only modifiers the waves simulate (every
 * `SUPPORTED_WAVE_MODIFIERS` id; Mantimayhem and Reentry are not), each at one of its own tiers.
 * Volatility III is allowed here; the offers withhold it, but a chosen set plays it as implemented
 * (its center pool is not simulated).
 */
export function validateColosseumRunModifiers(selection: EncounterModifierSelection): EncounterModifierSelection {
  for (const [id, tier] of Object.entries(selection)) {
    if (!SUPPORTED_WAVE_MODIFIERS.has(id as ColosseumModifierId))
      throw new RangeError(`Modifier ${id} is not simulated in Colosseum waves`);
    const max = colosseumModifierTierCount(id as ColosseumModifierId);
    if (!Number.isInteger(tier) || tier < 1 || tier > max)
      throw new RangeError(`${id} has tiers 1-${max}, not ${tier}`);
  }
  return selection;
}

interface Fighter {
  readonly actor: NpcActor;
  readonly removalDelayTicks: number;
}

export interface ColosseumWaveRunInput {
  readonly encounterSeed: number;
  /** 1-11. */
  readonly startWave: number;
  /**
   * The run's configured modifier set, owned going into the start wave and in force from its T0
   * (`validateColosseumRunModifiers`).
   */
  readonly configured: EncounterModifierSelection;
  /** The run's live modifiers, empty until the start wave's T0; this run takes the set and every pick into it. */
  readonly modifierState: ColosseumModifierState;
  readonly definitions: NpcDefinitionCollection;
  /** Wave 12's control tick C: the owner adds Sol and closes his fence. */
  readonly onSolControl: (ctx: EncounterContext, controlTick: number) => void;
}

/**
 * Waves 1-11 and the hand-off to Sol: intermissions and offers, each wave's spawns and
 * reinforcements, completion on the last required fighter's removal, wave-stage modifier effects and
 * wave 12's jump to Sol's arena. Times are world ticks; see `waveTable.ts` for the anchors.
 */
export class ColosseumWaveRun {
  readonly startWave: number;
  private readonly seed: number;
  private readonly modifierState: ColosseumModifierState;
  private readonly definitions: NpcDefinitionCollection;
  private readonly onSolControl: ColosseumWaveRunInput['onSolControl'];
  private stage: ColosseumStage = 'intermission';
  private wave: number;
  private waveStartTick: number | null = null;
  private waveCompletedTick: number | null = null;
  private reinforcementTick: number | null = null;
  private reinforcements: readonly ReinforcementDraw[] = [];
  /**
   * The player's tile at the start of this tick, before they move: what the wave start's spawn points
   * and the reinforcements' gate are decided from (`layout.ts`). Set each tick in `resolveHazards`, so
   * it needs no snapshot.
   */
  private tickStart: { readonly tick: number; readonly tile: Coordinate } | null = null;
  private manticoreFirstStyle: 'ranged' | 'magic' = 'ranged';
  private solControlTick: number | null = null;
  private solStarted = false;
  private offer: ColosseumModifierOfferState | null = null;
  /** The practice layout of the start wave's initial NPCs (`configureSetup`); null for random. */
  private spawnLayout: ColosseumSpawnLayout | null = null;
  /** The setup's start tile (`configureSetup`): published only, the engine places the player. */
  private startPlayerTile: Coordinate = [...COLOSSEUM_WAVE_START_TILE];
  /** What the wave being fought spawned on, for `ColosseumRunSetupState`; null outside a wave 1-11. */
  private spawned: { readonly layout: ColosseumSpawnLayout; readonly playerTile: Coordinate } | null = null;
  /** Accepted, taking effect at the wave's start. */
  private pendingPick: ColosseumPick | null = null;
  /** The configured set until the start wave's T0 puts it in force; then null. */
  private pendingSet: readonly ColosseumPick[] | null;
  private readonly picks: ColosseumPick[] = [];
  private readonly fighters = new Map<string, Fighter>();
  /** Every fighter's damage label, kept after removal for hits still in flight. */
  private readonly labels = new Map<string, string>();
  private npcRandom: () => number;
  private spawnCount = 0;
  private gibCount = 0;
  private pendingDamages: EnvironmentalDamage[] = [];
  private readonly effects: ColosseumWaveModifiers;

  constructor(input: ColosseumWaveRunInput) {
    if (
      !Number.isInteger(input.startWave) ||
      input.startWave < FIRST_COLOSSEUM_WAVE ||
      input.startWave > LAST_COLOSSEUM_WAVE
    )
      throw new RangeError(`A wave run starts on waves 1-11, not ${input.startWave}`);
    this.seed = input.encounterSeed;
    this.startWave = input.startWave;
    this.modifierState = input.modifierState;
    this.effects = new ColosseumWaveModifiers(input.modifierState);
    this.definitions = input.definitions;
    this.onSolControl = input.onSolControl;
    this.wave = input.startWave;
    this.npcRandom = colosseumStreams.npcs(this.seed, this.wave);
    // The player's chosen set stands for whatever came before the start wave, in catalog order.
    const configured = validateColosseumRunModifiers(input.configured);
    this.pendingSet = COLOSSEUM_MODIFIER_IDS.flatMap((id): ColosseumPick[] => {
      const tier = configured[id];
      return tier ? [{ origin: 'set', wave: null, id, tier, tick: null }] : [];
    });
    this.picks.push(...this.pendingSet);
    // Wave 1 opens directly on its choice (no entry walk or Minimus).
    this.openIntermission(SIMULATION_START_TICK);
  }

  get atSolControl(): boolean {
    return this.solStarted;
  }

  getPublicState(): ColosseumRunPublicState {
    return {
      startWave: this.startWave,
      wave: this.wave,
      stage: this.stage,
      waveStartTick: this.waveStartTick,
      waveCompletedTick: this.waveCompletedTick,
      reinforcementTick: this.reinforcementTick,
      solControlTick: this.solControlTick,
      offer: this.offer && {
        wave: this.offer.wave,
        options: this.offer.options.map((option) => ({ ...option })),
        eligible: this.offer.eligible.map((option) => ({ ...option })),
      },
      picks: this.picks.map((pick) => ({ ...pick })),
    };
  }

  /** The tick Sol appears, once wave 12 has started; null before. */
  get controlTick(): number | null {
    return this.solControlTick;
  }

  damageLabel(sourceId: string | undefined): string | undefined {
    return sourceId === undefined ? undefined : this.labels.get(sourceId);
  }

  /** The practice setup this run was started with, and what the wave being fought spawned. */
  getSetupState(): ColosseumRunSetupState {
    return {
      startSpawnLayout: this.spawnLayout ? serializeColosseumSpawnLayout(this.spawnLayout) : '',
      startPlayerTile: serializeColosseumStartTile(this.startPlayerTile),
      waveSpawnLayout: this.spawned ? serializeColosseumSpawnLayout(this.spawned.layout) : '',
      waveStartPlayerTile: this.spawned ? [this.spawned.playerTile[0], this.spawned.playerTile[1]] : null,
    };
  }

  /**
   * The run setup at tick 0 (`spawnLayout.ts`): the start wave's practice spawn layout, where one for
   * any other wave is ignored, and the start tile it opens on. The layout is read when the start wave
   * begins, so it draws nothing; the tile is only published, as the engine places the player.
   */
  configureSetup(layout: ColosseumSpawnLayout | null, startTile: Readonly<Coordinate>): void {
    this.spawnLayout = layout?.wave === this.startWave ? layout : null;
    this.startPlayerTile = [startTile[0], startTile[1]];
  }

  /**
   * The intermission's Continue. Accepted only for the open choice: right stage, right wave and one of
   * its eligible picks, once: an option, or as a practice option any other modifier the offer rules
   * allow here (`eligibleColosseumModifierPicks`). Either draws nothing, so later offers and layouts
   * are the same whichever is taken. The pick takes effect at the wave's start, five ticks later.
   */
  confirm(input: { readonly wave: number; readonly modifierId: ColosseumModifierId }, tick: number): boolean {
    const offer = this.offer;
    if (this.stage !== 'intermission' || offer === null || this.pendingPick !== null || input.wave !== offer.wave)
      return false;
    const option = offer.eligible.find((candidate) => candidate.id === input.modifierId);
    if (!option) return false;
    this.pendingPick = { origin: 'live', wave: offer.wave, id: option.id, tier: option.tier, tick };
    this.picks.push(this.pendingPick);
    this.offer = null;
    this.waveStartTick = tick + COLOSSEUM_WAVE_START_DELAY_TICKS;
    return true;
  }

  /**
   * Before player movement: Bees' respawns, then every falling javelin that lands this tick. A javelin
   * released before its colossus died still lands (A:2124, C:3359), so corpses are included.
   */
  resolveHazards(ctx: EncounterContext): EnvironmentalDamage[] {
    this.tickStart = { tick: ctx.tick, tile: [ctx.playerPos[0], ctx.playerPos[1]] };
    this.effects.resolveHazards(ctx);
    return ctx.world
      .getNpcs()
      .filter(javelinColossusDefinition.isActor)
      .flatMap((javelin) => landJavelinArtillery(javelin, this.npcContext(ctx)));
  }

  prepareNpcBand(ctx: EncounterContext, jumpMessage: readonly OverheadTextSegment[], solStart: Coordinate): void {
    const control = this.solControlTick;
    if (control === null) return;
    const start = control - SOL_WAVE_SCHEDULE.control;
    if (ctx.tick === start + SOL_WAVE_SCHEDULE.jumpMessage)
      ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: jumpMessage });
    // Before the player band, so the player's turn starts on Sol's arena tile (facing north, as a
    // direct start opens).
    if (ctx.tick === start + SOL_WAVE_SCHEDULE.relocate) ctx.teleportPlayer(solStart, 1024);
  }

  /** A required fighter leaves at its death sequence + its delay, in its own turn; so does a gib. */
  removeNpcIfDue(actor: NpcActor, ctx: EncounterContext): void {
    const gib = volatilityGibDefinition.getState(actor);
    if (gib) {
      if (ctx.tick >= gib.removeAt) ctx.despawnNpc(actor.id);
      return;
    }
    const fighter = this.fighters.get(actor.id);
    const death = actor.death;
    if (!fighter || fighter.actor !== actor || death?.status !== 'started') return;
    if (ctx.tick < (actor.deathAnimationTick ?? death.processTick) + fighter.removalDelayTicks) return;
    const position: Coordinate = [...actor.position];
    ctx.despawnNpc(actor.id);
    this.fighters.delete(actor.id);
    this.explode(ctx, actor, position);
  }

  moveNpc(actor: NpcActor, ctx: EncounterContext): NpcMovementRequest[] {
    if (this.fighters.get(actor.id)?.actor === actor) return this.definitions.move(actor, this.npcContext(ctx));
    if (this.stage === 'wave' && this.effects.moves(actor)) return this.definitions.move(actor, this.npcContext(ctx));
    return [];
  }

  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    if (this.fighters.get(actor.id)?.actor !== actor) return { environmentalDamages: [] };
    return this.definitions.tick(actor, this.npcContext(ctx));
  }

  /** A fighter's promoted kill turn: a Manticore's due orb, drawn from the wave stream as its turn would draw it. */
  releaseNpcKillTurn(actor: NpcActor, ctx: EncounterContext): readonly NpcAttackRequest[] {
    if (this.fighters.get(actor.id)?.actor !== actor || !manticoreDefinition.isActor(actor)) return [];
    return releaseManticoreKillTurn(actor, this.npcContext(ctx));
  }

  completeNpcBand(ctx: EncounterContext): EnvironmentalDamage[] {
    const damages = this.pendingDamages;
    this.pendingDamages = [];
    if (this.stage === 'wave') {
      const fighters = [...this.fighters.values()].map((fighter) => fighter.actor);
      damages.push(...this.effects.completeNpcBand(ctx, fighters, this.npcRandom));
    }
    return damages;
  }

  /**
   * After the player band, in order: completion (so a clear on T0+66 wins the tie), the offers at
   * Tc+3, a wave start at T0 (its spawns first act next tick), reinforcements, Bees, and Sol's control.
   */
  processPostTick(ctx: EncounterContext): void {
    const { tick } = ctx;
    if (this.stage === 'wave') {
      for (const [id, fighter] of this.fighters)
        if (ctx.world.actors.get(id) !== fighter.actor) this.fighters.delete(id);
      if (this.fighters.size === 0) this.completeWave(ctx);
    }
    if (
      this.stage === 'intermission' &&
      this.offer === null &&
      this.waveStartTick === null &&
      this.waveCompletedTick !== null &&
      tick >= this.waveCompletedTick + COLOSSEUM_OFFER_DELAY_TICKS
    )
      this.openIntermission(tick);
    if (this.stage === 'intermission' && this.waveStartTick !== null && tick >= this.waveStartTick) this.beginWave(ctx);
    if (this.stage === 'wave' && this.reinforcementTick !== null && tick >= this.reinforcementTick) {
      this.reinforcementTick = null;
      const gate = colosseumReinforcementGate(this.startTile(ctx));
      for (const spawn of placeReinforcements(this.reinforcements, gate)) this.spawnSpecies(ctx, spawn);
    }
    if (this.stage === 'wave') this.effects.processPostTick(ctx, this.npcRandom);
    if (this.stage === 'sol' && !this.solStarted && this.solControlTick !== null && tick >= this.solControlTick) {
      this.solStarted = true;
      this.onSolControl(ctx, this.solControlTick);
    }
  }

  private startTile(ctx: EncounterContext): Coordinate {
    if (this.tickStart?.tick !== ctx.tick) throw new Error(`No start-of-tick player tile on tick ${ctx.tick}`);
    return this.tickStart.tile;
  }

  private npcContext(ctx: EncounterContext) {
    return { ...ctx, random: this.npcRandom };
  }

  /**
   * The choice going into `this.wave`, opened on `tick`. Policy: with nothing left to offer (every
   * modifier maxed or owned), there is nothing to choose, and the wave starts as if a choice had been
   * accepted on `tick`.
   */
  private openIntermission(tick: number): void {
    const input = { nextWave: this.wave, owned: this.ownedTiers(), supported: SUPPORTED_WAVE_MODIFIERS };
    const options = drawColosseumModifierOffers({ ...input, random: colosseumStreams.offers(this.seed, this.wave) });
    if (options.length > 0) {
      this.offer = { wave: this.wave, options, eligible: eligibleColosseumModifierPicks(input) };
    } else {
      this.offer = null;
      this.waveStartTick = tick + COLOSSEUM_WAVE_START_DELAY_TICKS;
    }
  }

  /** The tiers owned going into the next wave: the live ones, plus the configured set before it applies. */
  private ownedTiers(): Map<ColosseumModifierId, number> {
    const owned = new Map<ColosseumModifierId, number>();
    for (const [id, tier] of Object.entries(this.modifierState.selection))
      if (tier) owned.set(id as ColosseumModifierId, tier);
    for (const pick of this.pendingSet ?? []) owned.set(pick.id, pick.tier);
    return owned;
  }

  private completeWave(ctx: EncounterContext): void {
    const start = this.waveStartTick ?? ctx.tick;
    ctx.tickEvents.emit({
      type: 'game_message',
      kind: 'game',
      segments: waveCompletedMessage(this.wave, ctx.tick - start),
    });
    // Swarms, orbs and totems go on the completion tick; gibs run out on their own.
    this.effects.completeWave(ctx);
    this.stage = 'intermission';
    this.waveCompletedTick = ctx.tick;
    this.waveStartTick = null;
    this.reinforcementTick = null;
    this.reinforcements = [];
    this.spawned = null;
    this.wave += 1;
  }

  private beginWave(ctx: EncounterContext): void {
    const tick = ctx.tick;
    const pick = this.pendingPick;
    const set = this.pendingSet;
    if (set) {
      // The configured set takes effect with the start wave's pick, as owned tiers do.
      this.pendingSet = null;
      for (const entry of set) {
        for (let tier = 1; tier <= entry.tier; tier++) this.modifierState.acceptModifier(entry.id, tier);
      }
    }
    if (pick) {
      this.pendingPick = null;
      this.modifierState.acceptModifier(pick.id, pick.tier);
    }
    // B:2975, C:3064, K:3992: Frailty's new maximum shows on this tick, not on the confirm.
    if (set || pick) ctx.refreshEngineRules?.();
    this.waveCompletedTick = null;
    this.npcRandom = colosseumStreams.npcs(this.seed, this.wave);
    const doomReset = this.modifierState.startWave();
    if (this.wave === SOL_WAVE) {
      // No `Wave: 12` message; Sol follows at C (A:4970-4976, K:3992-3998).
      if (doomReset) ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: doomReset });
      this.stage = 'sol';
      this.solControlTick = tick + SOL_WAVE_SCHEDULE.control;
      // The jump keeps the player busy from T0+1 through C (A:4970 busy on, A:4976 off). Locked after
      // T0's movement, so T0's step stands and C+1 takes input again.
      ctx.lockPlayerActionsUntil(this.solControlTick + 1);
      return;
    }
    ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: waveMessage(this.wave) });
    if (doomReset) ctx.tickEvents.emit({ type: 'game_message', kind: 'game', segments: doomReset });
    const selection = this.modifierState.selection;
    const player = this.startTile(ctx);
    const layout = planColosseumWave({
      wave: this.wave,
      quartet: Boolean(selection.quartet),
      dynamicDuo: Boolean(selection.dynamicDuo),
      player,
      random: colosseumStreams.layout(this.seed, this.wave),
      spawnLayout: this.wave === this.startWave ? this.spawnLayout : null,
    });
    const points: (ColosseumLayoutSpecies | null)[] = COLOSSEUM_SPAWN_POINTS.map(() => null);
    const initial = colosseumLayoutSpeciesForWave(this.wave);
    layout.initialPoints.forEach((point, index) => {
      points[point] = initial[index]!;
    });
    this.spawned = { layout: { wave: this.wave, points }, playerTile: player };
    this.manticoreFirstStyle = layout.manticoreFirstStyle;
    this.stage = 'wave';
    this.waveStartTick = tick;
    for (const member of layout.warband) {
      const actor = createWarbander({
        id: this.nextId(member.quartet ? 'quartet' : member.role),
        role: member.role,
        position: member.position,
        spawnTick: tick,
        slotOffset: member.slotOffset,
        // As Sol's Quartet member: UNVERIFIED fallback with its south slot blocked.
        ...(member.quartet ? { fallbackOffsets: [] } : {}),
        relentless: this.relentless(),
      });
      this.admit(ctx, actor, WARBAND_REMOVAL_DELAY_TICKS, WARBAND_DAMAGE_LABEL);
    }
    for (const spawn of layout.initial) this.spawnSpecies(ctx, spawn);
    this.reinforcements = layout.reinforcements;
    this.reinforcementTick = tick + COLOSSEUM_REINFORCEMENT_DELAY_TICKS;
    this.effects.startWave(ctx, this.wave);
  }

  private spawnSpecies(ctx: EncounterContext, spawn: SpeciesSpawn): void {
    const species = COLOSSEUM_WAVE_SPECIES[spawn.species];
    const actor = species.create({
      id: this.nextId(spawn.species),
      position: spawn.position,
      spawnTick: ctx.tick,
      relentless: this.relentless(),
      manticoreFirstStyle: this.manticoreFirstStyle,
      redFlag: Boolean(this.modifierState.selection.redFlag),
    });
    this.admit(ctx, actor, species.removalDelayTicks, species.damageLabel);
  }

  private admit(ctx: EncounterContext, actor: NpcActor, removalDelayTicks: number, label: string): void {
    ctx.spawnNpc(actor);
    this.fighters.set(actor.id, { actor, removalDelayTicks });
    this.labels.set(actor.id, label);
  }

  private nextId(key: string): string {
    return `colosseum_w${this.wave}_${key}_${this.spawnCount++}`;
  }

  private relentless(): ColosseumRelentlessRank {
    return (this.modifierState.selection.relentless ?? 0) as ColosseumRelentlessRank;
  }

  /**
   * Volatility: on the removal tick, the explosion around its last footprint hits the player's
   * start-of-tick tile, and its gib is added on its south-west tile for three ticks (Run A, 33/33).
   */
  private explode(ctx: EncounterContext, actor: NpcActor, position: Coordinate): void {
    const tier = this.modifierState.selection.volatility as EncounterModifierTier | undefined;
    const gib = volatilityGibForNpcType(actor.npcTypeId);
    if (!tier || !gib) return;
    this.pendingDamages.push(...volatilityExplosionDamage(position, actor.size, tier, ctx.playerPos));
    emitEncounterVisual(ctx.tickEvents, {
      animations: [],
      projectiles: [],
      graphics: volatilityExplosionGraphics({
        npcPosition: position,
        npcSize: actor.size,
        tier,
        explosionSpotAnimId: gib.explosionSpotAnimId,
        isWalkable: ([x, y]) => isWalkableTile(x, y),
      }),
    });
    ctx.spawnNpc(
      createVolatilityGib({ id: `${VOLATILITY_GIB_ACTOR_PREFIX}_${this.gibCount++}`, gib, position, tick: ctx.tick }),
    );
  }
}
