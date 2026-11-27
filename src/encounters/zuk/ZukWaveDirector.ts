import type { NpcActor } from '../../core/actors/NpcActor';
import { isInArena, isWalkableTile } from '../../core/constants';
import { chooseDistinct, type DecisionRandom, generatorDecisionRandom } from '../../core/decisionRandom';
import type { EncounterCommand } from '../../core/encounters/commands';
import type { EncounterOutcome } from '../../core/encounters/outcome';
import type { EncounterSnapshotContext } from '../../core/encounters/snapshot';
import type {
  EncounterCommandContext,
  EncounterCommandResult,
  EncounterCompletionOwnership,
  EncounterContext,
  EncounterNpcDefeat,
  EnvironmentalDamage,
  NpcMovementRequest,
} from '../../core/encounters/types';
import {
  actorPresentationsRemoved,
  type EncounterVisualBatch,
  emitEncounterVisual,
  encounterVisual,
} from '../../core/events/encounterVisual';
import { markNpcDead } from '../../core/npcDeath';
import type { NpcDefinitionCollection, NpcDefinitionContext, NpcDefinitionRegistration } from '../../core/npcs';
import { calculateLinearPatrolMove, type LinearPatrolRoute } from '../../core/npcs/linearPatrol';
import { fmix32, mulberry32 } from '../../core/rng';
import { createInfernoActor, type InfernoActorKind } from '../../npcs/inferno/actors';
import { ZUK_HEALER_NPC_ID, ZUK_MAGER_NPC_ID, ZUK_RANGER_NPC_ID } from '../../npcs/inferno/constants';
import { demonstrateHeal, demonstrateJad, demonstrateSet } from '../../npcs/inferno/demonstrations';
import { createGlyph, glyphDefinition } from '../../npcs/inferno/glyph';
import { createHealer, healerDefinition } from '../../npcs/inferno/healer';
import { createJad, jadDefinition, removeJadIfDue } from '../../npcs/inferno/jad';
import { createJadHealer } from '../../npcs/inferno/jadHealer';
import type { ParentHealPresentation } from '../../npcs/inferno/presentation';
import { createMager, createRanger } from '../../npcs/inferno/setMonsters';
import { createZuk, zukCastTickSyncedToShield, zukDefinition } from '../../npcs/inferno/zuk';
import type { Coordinate, MechanicsConfig } from '../../types/simulation';
import type { ZukEncounterCommand } from './commands';
import { ZUK_INTRO, ZUK_INTRO_GLYPH_TILE, ZUK_VICTORY_COMPLETION_DELAY_TICKS } from './constants';
import { ZukSetScheduler } from './setScheduler';
import type { ZukPublicState } from './snapshot';
import { generateSparkVolley, ZukSparkLandings } from './sparks';
import { zukTargetsPlayer } from './targeting';

type SpawnContext = Pick<EncounterContext, 'tick' | 'world' | 'spawnNpc' | 'despawnNpc'>;
type ZukBoss = ReturnType<typeof createZuk>;
type ZukGlyph = ReturnType<typeof createGlyph>;

export type ZukShieldStart = MechanicsConfig['zukShieldStart'];

const GLYPH_PATROL = {
  endpoints: [
    [17, 48],
    [43, 48],
  ],
  endpointPauseTicks: 4,
} as const satisfies LinearPatrolRoute;
const GLYPH_START = { position: [30, 48] } as const;
const ZUK_ID = 'zuk';
const ZUK_START_POSITION = [28, 52] as const satisfies Coordinate;
const ZUK_OPENING_DELAY_TICKS = 13;
const ZUK_GLYPH_ID = 'zuk_shield';

/**
 * Wave 69's Yt-HurKot spawn box, offsets from the Jad's SW tile: north of him, toward Zuk. Simulator
 * policy fitted to the 6 captured healers (both wave-69 captures fall in it; zuk-policy.md, Jad healer
 * placement), with W JalTok-Jad's "always spawn north of it"; the exact box is not verified.
 */
const JAD_HEALER_BOX = { minDx: 0, maxDx: 2, minDy: 5, maxDy: 8 } as const;
const JAD_HEALERS_PER_JAD = 3;
const JAD_HEALER_STREAM = 0x4a484c52;

// capture inferno-waves-69-zuk-packet-data.txt: spawn t98, openings t104/t106.
// Observed capture distances are lower bounds, not reach limits.
const RECORDED_SET_CONFIGURATION = {
  mager: { position: [26, 39], initialDelayTicks: 6, attackRange: 15 },
  ranger: { position: [35, 39], initialDelayTicks: 8 },
} as const;

/**
 * Ticks from the death sequence to removal; the corpse keeps blocking NPC movement until then. Jal-Xil
 * Z:156→158, Z:592→594, T:140→142; Jal-Zek Z:242→244, Z:681→683, T:237→239; healers Z:1139→1141,
 * Z:1140→1142, Z:1144→1146, Z:1152→1154, T:465→467 (Z = inferno-waves-69-zuk-packet-data.txt,
 * T = inferno-waves-tbow-69-zuk-packet-data.txt). JalTok-Jad's +6 lives in `jad.ts`.
 */
const ZUK_REMOVAL_DELAY_TICKS: Readonly<Record<number, number>> = {
  [ZUK_RANGER_NPC_ID]: 2,
  [ZUK_MAGER_NPC_ID]: 2,
  [ZUK_HEALER_NPC_ID]: 2,
};

/**
 * The definitions only wave 69 uses (glyph, Jal-MejJak, Zuk), routed to the live director. The
 * Inferno registers the species wave 69 shares with the ordinary waves (Jal-Zek, Jal-Xil, JalTok-Jad,
 * Yt-HurKot) once for both, because a collection holds one registration per definition.
 */
export function zukWaveRegistrations(
  director: () => ZukWaveDirector,
  presentParentHeal: ParentHealPresentation,
): NpcDefinitionRegistration[] {
  // https://oldschool.runescape.wiki/w/Jal-MejJak gives 15-24; uniform sampling is simulator policy, not a proved distribution.
  const sampleHeal = ({ context }: { readonly context: NpcDefinitionContext }) =>
    15 + Math.floor(context.random() * 10);
  return [
    glyphDefinition.register(GLYPH_PATROL),
    healerDefinition.register({
      sampleHeal,
      presentHeal: presentParentHeal,
      castSparks: ({ actor, target, context }) => director().castSparks(actor, target, context),
    }),
    zukDefinition.register({
      attacksEnabled: () => director().attacksEnabled,
      targetsPlayer: zukTargetsPlayer,
      spawnJad: (sourceActorId, ctx) => {
        director().spawnJad(sourceActorId, ctx);
      },
      spawnHealers: (sourceActorId, ctx) => {
        director().spawnHealers(sourceActorId, ctx);
      },
    }),
  ];
}

/**
 * Wave 69: TzKal-Zuk's glyph, cast clock, sets, Jad, healers, sparks and outcome, from one control
 * tick C. A run that starts on wave 69 opens at C = 0 with the actors in place; a run reaching it
 * from wave 68 adds them at C-8 and plays the recorded intro (`ZUK_INTRO`). Every clock is relative
 * to C, so the two are the same fight from C on. The Inferno owns when wave 69 starts and the
 * engine hooks; this owns what happens on it.
 */
export class ZukWaveDirector {
  readonly controlTick: number;
  attacksEnabled = true;
  private random: () => number;
  /** Its own stream, so placing Jad's healers shifts no other wave-69 draw. */
  private jadHealerDecisions: DecisionRandom;
  private nextActorId = 0;
  private outcome: EncounterOutcome = { phase: 'active' };
  private boss: ZukBoss | null = null;
  private glyph: ZukGlyph | null = null;
  private initialGlyphTargetEndpoint: 0 | 1;
  private readonly seed: number;
  private readonly sparks = new ZukSparkLandings();
  private readonly sets = new ZukSetScheduler();

  /**
   * `seed` is the run's and picks a random shield start, which a retry repeats; `npcSeed` is the
   * attempt's NPC decision seed (`npcDecisionSeed`), from which the director draws its own streams.
   * Both are recorded, so wave 69 replays exactly.
   */
  constructor(seed: number, npcSeed: number, controlTick: number, shieldStart: ZukShieldStart | undefined) {
    this.seed = seed;
    this.random = mulberry32(npcSeed);
    this.jadHealerDecisions = generatorDecisionRandom(mulberry32(fmix32((npcSeed ^ JAD_HEALER_STREAM) >>> 0)));
    this.controlTick = controlTick;
    this.initialGlyphTargetEndpoint = this.resolveShieldStart(shieldStart);
  }

  /**
   * The glyph and Zuk. The glyph comes first, so it takes its turn (and its step) before Zuk aims:
   * both captures give it the index just below Zuk's (inferno-waves-69-zuk 46150/46151, tbow
   * 57610/57611), and Zuk's shot reads where the glyph stands after it moves. Their `spawnTick` is C,
   * the epoch of the glyph's patrol and Zuk's cast clock, even when the intro adds them at C-8.
   */
  createOpeningActors(): NpcActor[] {
    const intro = this.controlTick > 0;
    this.boss = createZuk({
      id: ZUK_ID,
      position: [...ZUK_START_POSITION],
      spawnTick: this.controlTick,
      openingDelayTicks: ZUK_OPENING_DELAY_TICKS,
      glyphId: ZUK_GLYPH_ID,
    });
    this.glyph = createGlyph({
      id: ZUK_GLYPH_ID,
      position: intro ? [...ZUK_INTRO_GLYPH_TILE] : GLYPH_START.position,
      targetEndpoint: this.initialGlyphTargetEndpoint,
      spawnTick: this.controlTick,
    });
    return [this.glyph, this.boss];
  }

  /** A tick-zero change of the starting side, for actors not yet moved. */
  configureShieldStart(choice: ZukShieldStart | undefined): void {
    this.initialGlyphTargetEndpoint = this.resolveShieldStart(choice);
    if (this.glyph) this.glyph.state.targetEndpoint = this.initialGlyphTargetEndpoint;
  }

  get openingActorIds(): readonly string[] {
    return [this.glyph?.id, this.boss?.id].filter((id): id is string => id !== undefined);
  }

  getOutcome(): EncounterOutcome {
    return this.outcome;
  }

  resolveHazards(ctx: EncounterContext): EnvironmentalDamage[] {
    return this.sparks.resolve(ctx);
  }

  prepareNpcBand(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): void {
    if (this.outcome.phase === 'resolving' && ctx.tick >= this.outcome.completionTick) {
      this.outcome = { ...this.outcome, phase: 'victory' };
    }
    this.attacksEnabled = mechanics.zukAttacks !== false;
  }

  /** The set clock runs from the tick after control, so its opening set lands at C + 72. */
  processPostTick(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): void {
    if (ctx.tick <= this.controlTick) return;
    if (!this.boss?.alive) this.sets.stop();
    else if (this.sets.advance(this.boss.vitals.hp, this.boss.state.jadSpawned, mechanics.zukSets !== false))
      this.spawnSet(ctx);
  }

  /** Removal is part of the removed NPC's own turn (`Encounter.removeNpcIfDue`). */
  removeNpcIfDue(npc: NpcActor, ctx: EncounterContext): void {
    if (removeJadIfDue(npc, ctx)) return;
    const delay = ZUK_REMOVAL_DELAY_TICKS[npc.npcTypeId];
    if (delay === undefined || npc.death?.status !== 'started' || npc.deathAnimationTick === undefined) return;
    if (ctx.tick >= npc.deathAnimationTick + delay) ctx.despawnNpc(npc.id);
  }

  /**
   * Nothing moves once Zuk has died. During the intro the glyph walks from its alcove tile to the
   * patrol row (C-6..C-4); its patrol starts at C + 1, as on a fresh start.
   */
  moveNpc(actor: NpcActor, ctx: EncounterContext, definitions: NpcDefinitionCollection): NpcMovementRequest[] {
    if (!this.boss?.alive) return [];
    const walk = ctx.tick - this.controlTick;
    if (actor === this.glyph && walk >= ZUK_INTRO.glyphWalkFrom && walk <= ZUK_INTRO.glyphWalkTo) {
      return [{ npcId: actor.id, path: [[actor.position[0], actor.position[1] - 1]] }];
    }
    return definitions.move(actor, this.npcContext(ctx));
  }

  npcContext(ctx: EncounterContext): NpcDefinitionContext {
    return { ...ctx, random: this.random };
  }

  getSnapshotState(ctx: EncounterSnapshotContext): ZukPublicState {
    const bossLive = this.boss?.alive === true && ctx.world.getNpc(this.boss.id) === this.boss;
    const glyph = bossLive && this.glyph?.alive && ctx.world.getNpc(this.glyph.id) === this.glyph ? this.glyph : null;
    const nextStep = glyph && calculateLinearPatrolMove(glyph, GLYPH_PATROL, ctx.tick + 1)?.movement.path.at(-1);
    return {
      ...this.sets.getSnapshot(ctx.mechanics.zukSets !== false && this.boss !== null && this.boss.alive),
      enraged: this.boss !== null && this.boss.state.enragedAt !== null,
      jadSpawned: this.boss?.state.jadSpawned ?? false,
      shieldX: this.glyph?.position[0] ?? GLYPH_START.position[0],
      shieldMovingEast: (this.glyph?.state.targetEndpoint ?? this.initialGlyphTargetEndpoint) === 1,
      shieldNextX: glyph === null ? null : (nextStep?.[0] ?? glyph.position[0]),
    };
  }

  /** Whether a living Zuk stands in the world: the boss-HP presets act on him alone. */
  hasLivingBoss(ctx: Pick<EncounterContext, 'world'>): boolean {
    return this.boss?.alive === true && ctx.world.getNpc(this.boss.id) === this.boss;
  }

  /** Skip crossed spawn thresholds without changing actors or the actual enrage cast clock. */
  syncBossHp(hp: number, ctx: Pick<EncounterContext, 'world'>): void {
    const boss = this.boss;
    if (!boss || !this.hasLivingBoss(ctx)) return;
    boss.state.jadSpawned = hp < 480;
    boss.state.healersSpawned = hp < 240;
  }

  enterBossHpPhase(hp: number, ctx: SpawnContext): void {
    const boss = this.boss;
    const player = ctx.world.getPlayer();
    if (!boss?.alive || !player || hp <= 0) return;
    for (const npc of ctx.world.getNpcs()) ctx.world.removePendingHitsBySource(npc.id);
    this.clearMinions(ctx);
    this.sparks.clear();
    if (this.glyph?.alive && ctx.world.getNpc(this.glyph.id)) {
      this.glyph.vitals.hp = this.glyph.vitals.maxHp;
    } else {
      if (this.glyph) ctx.despawnNpc(this.glyph.id);
      this.glyph = createGlyph({
        id: this.allocateId('shield'),
        ...GLYPH_START,
        targetEndpoint: this.initialGlyphTargetEndpoint,
        spawnTick: ctx.tick,
      });
      ctx.spawnNpc(this.glyph);
    }
    // This preset clears enrage below, so restoring the shield's pre-enrage cast schedule is valid.
    this.syncZukCastClockToShield(boss, ctx);
    boss.state.glyphId = this.glyph.id;
    boss.combat.targetId = null;
    this.syncBossHp(hp, ctx);
    boss.state.enragedAt = null;
    this.sets.reset();
    this.sets.advance(hp, boss.state.jadSpawned, false);
  }

  onNpcDefeated(
    defeat: EncounterNpcDefeat,
    ctx: EncounterContext,
    ownership: EncounterCompletionOwnership,
    definitions: NpcDefinitionCollection,
  ): void {
    if (defeat.npcId !== ZUK_ID) return;
    this.sparks.clear();
    this.sets.stop();
    const completionActorIds = [ZUK_ID];
    for (const npc of ctx.world.getNpcs()) {
      if (npc.role !== 'minion' || !npc.alive) continue;
      npc.vitals.hp = 0;
      markNpcDead(npc, defeat.tick);
      // A scripted death is processed and animates at once; this also delivers its death presentation.
      definitions.notifyDeathStarted(npc, this.npcContext(ctx));
      // These deaths are scripted, not observed: no capture shows a minion's shot landing after Zuk
      // dies, so their queued hits end with them, as they did before hits could outlive a source.
      ctx.world.removePendingHitsBySource(npc.id);
      ctx.tickEvents.emit({ type: 'actor_died', actorId: npc.id });
      definitions.notifyDefeated(npc, { npcId: npc.id, tick: defeat.tick }, ownership, this.npcContext(ctx));
      completionActorIds.push(npc.id);
    }
    if (ownership === 'encounter-owned')
      this.outcome = {
        phase: 'resolving',
        decisiveTick: defeat.tick,
        completionTick: defeat.tick + ZUK_VICTORY_COMPLETION_DELAY_TICKS,
        primaryActorId: ZUK_ID,
        completionActorIds,
      };
  }

  executeCommand(command: ZukEncounterCommand, ctx: EncounterCommandContext): EncounterCommandResult {
    const boss = this.boss;
    if (!boss?.alive) return {};
    let cue: EncounterVisualBatch | undefined;
    switch (command.type) {
      case 'emit-spark-volley':
        cue = this.sparks.emit(command, ctx.tick);
        break;
      case 'spawn-set':
        this.spawnSet(ctx);
        break;
      case 'replace-set':
        this.clearMinions(ctx, [7703, 7702]);
        this.spawnSet(ctx);
        return { gameEvents: [actorPresentationsRemoved([7703, 7702])] };
      case 'spawn-mager':
        this.spawnSetMonster('mager', ctx);
        break;
      case 'spawn-ranger':
        this.spawnSetMonster('ranger', ctx);
        break;
      case 'spawn-jad':
        this.spawnJad(boss.id, ctx);
        break;
      case 'spawn-healers':
        this.spawnHealers(boss.id, ctx);
        break;
      case 'spawn-jad-healers': {
        const jad =
          ctx.world.getNpcs().find((npc) => jadDefinition.isActor(npc) && npc.alive) ?? this.spawnJad(boss.id, ctx);
        this.spawnJadHealers(jad.id, ctx);
        break;
      }
      case 'respawn-glyph': {
        const previousGlyphId = this.glyph?.id;
        if (this.glyph) ctx.despawnNpc(this.glyph.id);
        this.glyph = createGlyph({
          id: this.allocateId('shield'),
          ...GLYPH_START,
          targetEndpoint: this.initialGlyphTargetEndpoint,
          spawnTick: ctx.tick,
        });
        boss.state.glyphId = this.glyph.id;
        // Manual reset also re-anchors Zuk's cast clock to the new shield, matching a real
        // encounter open (see the comment on syncZukCastClockToShield) - a reset that only moved
        // the glyph would otherwise desync the two clocks. Only valid pre-enrage: an already
        // enraged clock keeps its own faster cadence untouched rather than being silently
        // reset to the slower pre-enrage schedule this command was never meant to change.
        if (boss.state.enragedAt === null) this.syncZukCastClockToShield(boss, ctx);
        ctx.spawnNpc(this.glyph);
        for (const npc of ctx.world.getNpcs()) {
          if (npc.combat.targetId === previousGlyphId) npc.combat.targetId = this.glyph.id;
        }
        break;
      }
      case 'clear-spawns':
        this.clearMinions(ctx);
        return { gameEvents: [actorPresentationsRemoved([7703, 7702, 7704, 7705, 7708])] };
      case 'demonstrate-jad': {
        const player = ctx.world.getPlayer();
        if (player) cue = demonstrateJad(this.spawnDemoActor('jad', [30, 35], ctx), player, command.style);
        break;
      }
      case 'demonstrate-set': {
        if (this.glyph?.alive) {
          cue = demonstrateSet(
            [this.spawnDemoActor('mager', [26, 39], ctx), this.spawnDemoActor('ranger', [35, 39], ctx)],
            this.glyph,
          );
        }
        break;
      }
      case 'demonstrate-heal': {
        cue = demonstrateHeal(
          [22, 26, 36, 40].map((x) => this.spawnDemoActor('healer', [x, 51], ctx)),
          boss,
        );
        break;
      }
      case 'inspect-ranged-graphic':
        cue = {
          animations: [],
          projectiles: [],
          graphics: [
            { spotAnimId: 451, target: { kind: 'tile', position: [...ctx.playerPos] }, height: 92, delayCycles: 0 },
          ],
        };
        break;
      default:
        return assertNever(command);
    }
    return cue ? { gameEvents: [encounterVisual(cue)] } : {};
  }

  castSparks(actor: NpcActor, target: { readonly position: Coordinate }, context: NpcDefinitionContext): void {
    const cue = this.sparks.emit(
      { sparks: generateSparkVolley({ source: actor.position, player: target.position, random: context.random }) },
      context.tick,
    );
    if (cue) emitEncounterVisual(context.tickEvents, cue);
  }

  spawnJad(sourceActorId: string, ctx: SpawnContext): NpcActor {
    const source = ctx.world.getNpc(sourceActorId);
    const sourceState = source && zukDefinition.getState(source);
    if (!sourceState) throw new TypeError(`Missing Zuk spawn source ${sourceActorId}`);
    const actor = createJad({
      id: this.allocateId('jad'),
      position: [30, 35],
      spawnTick: ctx.tick,
      targetId: sourceState.glyphId,
    });
    ctx.spawnNpc(actor);
    return actor;
  }

  spawnHealers(sourceActorId: string, ctx: SpawnContext): NpcActor[] {
    return [22, 26, 36, 40].map((x) => {
      const actor = createHealer({
        id: this.allocateId('healer'),
        position: [x, 51],
        spawnTick: ctx.tick,
        supportTargetId: sourceActorId,
      });
      ctx.spawnNpc(actor);
      return actor;
    });
  }

  /**
   * Wave 69's three Jad healers on distinct tiles of `JAD_HEALER_BOX`, never the player's, drawn
   * uniformly without replacement from the open ones (from the whole box if fewer than three are open).
   */
  spawnJadHealers(parentId: string, ctx: SpawnContext): NpcActor[] {
    const parent = ctx.world.getNpc(parentId);
    if (!parent) return [];
    const [jx, jy] = parent.position;
    const player = ctx.world.getPlayer()?.position;
    const box: Coordinate[] = [];
    for (let x = jx + JAD_HEALER_BOX.minDx; x <= jx + JAD_HEALER_BOX.maxDx; x++) {
      for (let y = jy + JAD_HEALER_BOX.minDy; y <= jy + JAD_HEALER_BOX.maxDy; y++) {
        if (!player || player[0] !== x || player[1] !== y) box.push([x, y]);
      }
    }
    const open = box.filter(([x, y]) => isInArena(x, y) && isWalkableTile(x, y));
    const positions = chooseDistinct(
      this.jadHealerDecisions,
      { site: 'zuk.jad_healer.tile', tick: ctx.tick, actorId: parentId },
      open.length >= JAD_HEALERS_PER_JAD ? open : box,
      JAD_HEALERS_PER_JAD,
    );
    const actors = positions.map((position) => {
      const actor = createJadHealer({ id: this.allocateId('jad_healer'), position, spawnTick: ctx.tick, parentId });
      ctx.spawnNpc(actor);
      return actor;
    });
    const state = jadDefinition.getState(parent);
    if (state) state.healersSpawned = true;
    return actors;
  }

  private resolveShieldStart(choice: ZukShieldStart | undefined): 0 | 1 {
    return choice === 'left' ? 0 : choice === 'right' ? 1 : (fmix32(this.seed) & 1) === 0 ? 0 : 1;
  }

  /**
   * Reconciles Zuk's cast clock to `this.glyph`'s own spawn tick (see zukCastTickSyncedToShield),
   * so his cadence always stays phase-locked to wherever the shield actually is. Callers are
   * responsible for only invoking this pre-enrage - see the comments at each call site.
   */
  private syncZukCastClockToShield(boss: ZukBoss, ctx: SpawnContext): void {
    const glyph = this.glyph;
    if (!glyph) throw new TypeError('Cannot sync Zuk cast clock without a shield');
    if (glyph.spawnTick === undefined) throw new TypeError('Shield is missing its spawn tick');
    boss.state.lastCastTick = null;
    boss.state.firstCastTick = zukCastTickSyncedToShield(glyph.spawnTick, ZUK_OPENING_DELAY_TICKS, ctx.tick);
  }

  private allocateId(kind: InfernoActorKind): string {
    return `zuk_${kind}_${this.nextActorId++}`;
  }

  private spawnDemoActor(kind: InfernoActorKind, position: Coordinate, ctx: SpawnContext): NpcActor {
    const actor = createInfernoActor(kind, this.allocateId(kind), position);
    actor.spawnTick = ctx.tick;
    ctx.spawnNpc(actor);
    return actor;
  }

  private spawnSet(ctx: SpawnContext): NpcActor[] {
    return [this.spawnSetMonster('mager', ctx), this.spawnSetMonster('ranger', ctx)];
  }

  private spawnSetMonster(kind: 'mager' | 'ranger', ctx: SpawnContext): NpcActor {
    const spawnOptions = {
      id: this.allocateId(kind),
      position: [...RECORDED_SET_CONFIGURATION[kind].position] satisfies Coordinate,
      spawnTick: ctx.tick,
      initialTargetId: this.glyph?.id ?? null,
    };
    let actor: NpcActor;
    switch (kind) {
      case 'mager':
        actor = createMager({ ...RECORDED_SET_CONFIGURATION.mager, ...spawnOptions });
        break;
      case 'ranger':
        actor = createRanger({ variant: 'zuk', ...RECORDED_SET_CONFIGURATION.ranger, ...spawnOptions });
        break;
      default:
        return assertNever(kind);
    }
    ctx.spawnNpc(actor);
    return actor;
  }

  private clearMinions(ctx: SpawnContext, types?: readonly number[]): void {
    for (const npc of ctx.world.getNpcs()) {
      if (npc.role === 'minion' && (!types || types.includes(npc.npcTypeId))) ctx.despawnNpc(npc.id);
    }
  }
}

/** Zuk's commands keep the `encounter: 'zuk'` namespace (`baseEncounterKind` routes them here). */
export function isZukWaveCommand(command: EncounterCommand): command is ZukEncounterCommand {
  return command.encounter === 'zuk';
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown Zuk command: ${JSON.stringify(value)}`);
}
