import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NpcActor } from '../core/actors/NpcActor';
import type { PlayerActor } from '../core/actors/PlayerActor';
import type { ArenaConfig } from '../core/arena/ArenaConfig';
import { layBurnStack } from '../core/combat/burnStacks';
import type { CombatSystem } from '../core/combat/CombatSystem';
import { isUnderNpc } from '../core/combat/distance';
import { npcProjectileHitDelay } from '../core/combat/npcAttackRequest';
import { applyNpcHealing } from '../core/combat/npcHealing';
import { AMULET_OF_BLOOD_FURY } from '../core/combat/player/onHitPassives';
import { getSpecialAttackDef } from '../core/combat/player/specialAttacks/registry';
import { getArenaConfig, isWalkableTile, SIMULATION_START_TICK, setArenaConfig } from '../core/constants';
import type { EncounterOutcome } from '../core/encounters/outcome';
import type {
  Encounter,
  EncounterCompletionOwnership,
  EncounterContext,
  EncounterNpcDefeat,
  EncounterPlayerAttackContext,
  EncounterPlayerAttackInfo,
  EncounterPlayerAttackResolvedContext,
  EncounterTickResult,
  EnvironmentalDamage,
  EquipmentClickSlot,
  NpcMovementRequest,
} from '../core/encounters/types';
import { TickEvents } from '../core/events/TickEvents';
import { isCoreEvent } from '../core/events/types';
import { reviveNpc } from '../core/npcDeath';
import { createNpcStepOccupancyPredicate } from '../core/npcOccupancy';
import { createNpcDefinition, NpcDefinitionCollection } from '../core/npcs';
import { SimulationEngine } from '../core/SimulationEngine';
import type { WorldState } from '../core/WorldState';
import { RUNE } from '../data/spellRunes';
import {
  YAMA_SET_OPENING_MAGIC_COMMAND,
  YAMA_SET_OPENING_RANGE_COMMAND,
  YAMA_SPAWN_FIREBALL_COMMAND,
} from '../encounters/yamaP3/commands';
import {
  DEFAULT_YAMA_ATTACK_PATTERN,
  getFireballBurstCycleTicks,
  YAMA_START_POS,
} from '../encounters/yamaP3/constants';
import { DIVINE_SEVERANCE_CONFIG } from '../encounters/yamaP3/contractConfig';
import { YamaEncounter } from '../encounters/yamaP3/YamaEncounter';
import { getYamaState } from '../npcs/yama/yama';
import { ObjType } from '../rs/config/objtype/ObjType';
import { lobbySnapshot } from '../test/helpers/encounterSnapshot';
import { enqueueEnginePendingHit } from '../test/helpers/pendingHits';
import { getWeaponCategory } from '../types/attackStyles';
import type { CombatSupplies } from '../types/encounterLoadout';
import { createEmptyCombatSupplies } from '../types/encounterLoadout';
import { createEmptyStats } from '../types/equipmentStats';
import { type Inventory, parseInventoryFromSetup } from '../types/inventory';
import { POISON_TICK_INTERVAL } from '../types/playerState';
import type { Coordinate, MechanicsConfig } from '../types/simulation';
import { EventType, PrayerType } from '../types/simulation';

/**
 * Production code never uses a fixed start — the player lands at a random tile
 * within [29,35] → [33,39] via randomLandingPosition() in yamaP3/constants.ts.
 * This constant exists only to give the SimulationEngine a deterministic startPos.
 */
const PLAYER_START_POS: Coordinate = [31, 37];

const offset = (pos: Coordinate, dx: number, dy: number): Coordinate => [pos[0] + dx, pos[1] + dy];

/** Nearby position reachable in 1 tick with run (2 tiles NE of start) */
const NEAR_POS_1: Coordinate = offset(PLAYER_START_POS, 2, 2);
const NEAR_POS_2: Coordinate = offset(NEAR_POS_1, -1, 2);
const FAR_SAFE_POS: Coordinate = [39, 35];

const getWorldState = (simulation: SimulationEngine): WorldState => {
  return Reflect.get(simulation, 'worldState') as WorldState;
};

const OPEN_ARENA_CONFIG: ArenaConfig = {
  bounds: null,
  walkableTiles: null,
  collisionMap: null,
};

let previousArena = getArenaConfig();
let previousUnboundedFallback = false;
beforeEach(() => {
  previousArena = getArenaConfig();
  previousUnboundedFallback = previousArena.walkableTiles === null && isWalkableTile(0, 0);
});
afterEach(() => {
  setArenaConfig(previousArena, previousUnboundedFallback);
  vi.restoreAllMocks();
});

function createTrackingNpc(position: Coordinate, facing: number): NpcActor {
  return {
    id: 'tracking-npc',
    kind: 'npc',
    role: 'boss',
    alive: true,
    position,
    previousPosition: position,
    facing,
    size: 1,
    vitals: { hp: 100, maxHp: 100 },
    npcTypeId: 1,
    archetypeId: 'test-tracker',
    history: new Map(),
    combat: {
      attackSpeed: 4,
      attackRange: 1,
      attackStyle: 'melee',
      nextActionTick: 0,
      lastAttackTick: null,
      targetId: 'player',
      animations: {
        idle: null,
        walk: null,
        run: null,
        attack: null,
        death: null,
      },
    },
  };
}

const TOXIC_BLOWPIPE = 12926;

/**
 * Wields a blowpipe, whose own 5-tile reach is short of a cast at 8, and fills the rune pouch for Blood
 * Barrage. Its speed and range are set by hand: these engines have no item loader.
 */
function holdBlowpipeWithBloodRunes(testEngine: SimulationEngine): PlayerActor {
  testEngine.setEquipment({ weapon: TOXIC_BLOWPIPE });
  testEngine.setCombatSupplies({
    ...createEmptyCombatSupplies(),
    runePouch: { kind: 'standard', slots: [{ id: RUNE.blood }, { id: RUNE.death }, { id: RUNE.soul }] },
  });
  const player = getWorldState(testEngine).getPlayer();
  if (!player) throw new Error('Expected player');
  player.equipmentStats = { ...createEmptyStats(), attackSpeed: 3, attackRange: 5 };
  return player;
}

class TrackingNpcEncounter implements Encounter {
  readonly kind: string = 'lobby';
  readonly defeatedNpcs: {
    readonly defeat: EncounterNpcDefeat;
    readonly ownership: EncounterCompletionOwnership;
    readonly playerAlive: boolean;
    readonly playerHp: number;
  }[] = [];
  outcome: EncounterOutcome = { phase: 'active' };

  constructor(
    private readonly npc: NpcActor,
    private readonly movementPath: Coordinate[] = [],
  ) {}

  getDefaultPlayerStart(): Coordinate {
    return [10, 12];
  }

  getIntroConfig(): { facingAngle: number; animationSeqId: number } | null {
    return null;
  }

  createNpcs(): NpcActor[] {
    return [this.npc];
  }

  reset(): void {}

  onNpcDefeated(defeat: EncounterNpcDefeat, ctx: EncounterContext, ownership: EncounterCompletionOwnership): void {
    const player = ctx.world.getPlayer();
    this.defeatedNpcs.push({
      defeat,
      ownership,
      playerAlive: player?.alive ?? false,
      playerHp: player?.vitals.hp ?? 0,
    });
    if (defeat.npcId === this.npc.id && this.npc.role === 'boss' && ownership === 'encounter-owned') {
      this.outcome = {
        phase: 'resolving',
        decisiveTick: defeat.tick,
        completionTick: defeat.tick + 9,
        primaryActorId: defeat.npcId,
        completionActorIds: [defeat.npcId],
      };
    }
  }

  getSeeds(): Record<string, unknown> {
    return {};
  }

  resolveHazards(): EnvironmentalDamage[] {
    return [];
  }

  processPostTick(_ctx: EncounterContext): EnvironmentalDamage[] {
    return [];
  }

  getOutcome(): EncounterOutcome {
    return this.outcome;
  }

  getSnapshot() {
    return lobbySnapshot();
  }

  getDefaultMechanicsConfig(): Partial<MechanicsConfig> {
    return {};
  }

  getArenaConfig(): ArenaConfig {
    return OPEN_ARENA_CONFIG;
  }

  getNpcDamageSourceLabel(): string {
    return 'TrackingNpcTest';
  }

  moveNpc(actor: NpcActor, _ctx: EncounterContext): Iterable<NpcMovementRequest> {
    return actor === this.npc && this.movementPath.length > 0 ? [{ npcId: this.npc.id, path: this.movementPath }] : [];
  }
}

class InputProbeEncounter extends TrackingNpcEncounter {
  readonly kind = 'input-probe-test';
  readonly npcBandInputs: EquipmentClickSlot[][] = [];

  constructor(onNpcBand?: (ctx: EncounterContext) => void) {
    super(createTrackingNpc([20, 20], 0));
    this.onNpcBand = onNpcBand;
  }

  private readonly onNpcBand?: (ctx: EncounterContext) => void;

  override createNpcs(): NpcActor[] {
    return [];
  }

  completeNpcBand(ctx: EncounterContext): EnvironmentalDamage[] {
    this.npcBandInputs.push([...(ctx.inputs?.equipmentSlotClicks ?? [])]);
    this.onNpcBand?.(ctx);
    return [];
  }
}

interface TickPhaseObservation {
  readonly phase: 'moveNpc' | 'processNpcTick';
  readonly playerPos: Coordinate;
  readonly worldPlayerPos: Coordinate;
  readonly npcPos: Coordinate;
}

/** Drops the protection prayer once armed, under a timed-protection rule so the expiry clock runs. */
class ProtectionDropProbeEncounter extends TrackingNpcEncounter {
  readonly kind = 'protection-drop-test';
  armed = false;

  constructor(private readonly drop: (ctx: EncounterContext) => EnvironmentalDamage[]) {
    super(createTrackingNpc([20, 20], 0));
  }

  override createNpcs(): NpcActor[] {
    return [];
  }

  getEngineRules() {
    return { prayerRestrictions: { protection: { expiresAfterTicks: 10 } } };
  }

  completeNpcBand(ctx: EncounterContext): EnvironmentalDamage[] {
    return this.armed ? this.drop(ctx) : [];
  }
}

class TickOrderProbeEncounter extends TrackingNpcEncounter {
  readonly observations: TickPhaseObservation[] = [];

  constructor(private readonly trackedNpc: NpcActor) {
    super(trackedNpc);
  }

  override moveNpc(actor: NpcActor, ctx: EncounterContext): NpcMovementRequest[] {
    if (actor !== this.trackedNpc) return [];
    this.observe('moveNpc', ctx);
    return [{ npcId: this.trackedNpc.id, path: [[11, 10]] }];
  }

  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    if (actor !== this.trackedNpc) return { environmentalDamages: [] };
    this.observe('processNpcTick', ctx);
    ctx.tickEvents.emit({ type: 'process_tick_probe' });
    return { environmentalDamages: [] };
  }

  private observe(phase: TickPhaseObservation['phase'], ctx: EncounterContext): void {
    const player = ctx.world.getPlayer();
    const npc = ctx.world.getNpc(this.trackedNpc.id);
    if (!player || !npc) throw new Error('Tick-order probe actors missing from world state');
    this.observations.push({ phase, playerPos: ctx.playerPos, worldPlayerPos: player.position, npcPos: npc.position });
  }
}

/**
 * Fires one ranged shot at the player on `launchTick` with the given source-death policy, and can
 * remove its NPC from the world on `despawnTick` (an engine-level stand-in for a pruned corpse).
 */
class SingleShotEncounter extends TrackingNpcEncounter {
  constructor(
    private readonly shooter: NpcActor,
    private readonly shot: {
      readonly launchTick: number;
      readonly impactDelayTicks: number;
      readonly damage: number;
      readonly sourceDeathPolicy: 'persist' | 'cancel-before-impact';
      readonly despawnTick?: number;
    },
  ) {
    super(shooter);
  }

  prepareNpcBand(ctx: EncounterContext): void {
    if (ctx.tick === this.shot.despawnTick) ctx.despawnNpc(this.shooter.id);
  }

  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    if (actor !== this.shooter || ctx.tick !== this.shot.launchTick) return { environmentalDamages: [] };
    return {
      environmentalDamages: [],
      npcAttacks: [
        {
          attackerId: this.shooter.id,
          targetId: 'player',
          style: 'range',
          attackKind: 'range_arrow',
          rolledDamage: this.shot.damage,
          accuracySucceeded: true,
          impactDelayTicks: this.shot.impactDelayTicks,
          sourceDeathPolicy: this.shot.sourceDeathPolicy,
        },
      ],
    };
  }
}

/**
 * An NPC that steps where `steps` says on each tick and attacks the player every tick it is allowed
 * to, so a test can read exactly which turns the engine granted it.
 */
class TurnProbeEncounter extends TrackingNpcEncounter {
  constructor(
    private readonly probe: NpcActor,
    private readonly steps: ReadonlyMap<number, Coordinate> = new Map(),
  ) {
    super(probe);
  }

  override moveNpc(actor: NpcActor, ctx: EncounterContext): NpcMovementRequest[] {
    const step = this.steps.get(ctx.tick);
    return actor === this.probe && step ? [{ npcId: this.probe.id, path: [step] }] : [];
  }

  processNpcTick(actor: NpcActor, _ctx?: EncounterContext): EncounterTickResult {
    if (actor !== this.probe) return { environmentalDamages: [] };
    return {
      environmentalDamages: [],
      npcAttacks: [
        {
          attackerId: this.probe.id,
          targetId: 'player',
          style: 'magic',
          attackKind: 'magic_fire',
          rolledDamage: 1,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          sourceDeathPolicy: 'persist',
        },
      ],
    };
  }
}

/** A one-tick projectile (endtime 30): `npcProjectileHitDelay` gives it impact = launch + 1 at any range. */
const THRALL_PROJECTILE = { delay: 30, lengthAdjustment: 0, stepMultiplier: 0, progress: 0 };

/**
 * A thrall-like producer: on each of `attackTicks` it shoots `targetId` through the production path —
 * its definition tick returns the request, the engine commits it in this NPC's turn, and the hit is
 * enqueued with the shared NPC→NPC delay. Its processing order is wherever its encounter registers it.
 */
const thrallDefinition = createNpcDefinition<
  { readonly targetId: string; readonly attackTicks: readonly number[]; readonly damage: number },
  undefined
>({
  id: 'test-thrall',
  move: false,
  tick: ({ actor, context }) => {
    const target = context.world.getNpc(actor.state.targetId);
    if (!target || !actor.state.attackTicks.includes(context.tick)) return { environmentalDamages: [] };
    return {
      environmentalDamages: [],
      npcAttacks: [
        {
          attackerId: actor.id,
          targetId: target.id,
          style: 'magic',
          attackKind: 'magic_fire',
          rolledDamage: actor.state.damage,
          accuracySucceeded: true,
          impactDelayTicks: npcProjectileHitDelay(actor, target, THRALL_PROJECTILE),
          sourceDeathPolicy: 'persist',
        },
      ],
    };
  },
});

/** A {@link TurnProbeEncounter} victim plus a thrall, registered before or after it. */
class ThrallFixtureEncounter extends TurnProbeEncounter {
  private readonly definitions = new NpcDefinitionCollection([thrallDefinition.register(undefined)]);

  constructor(
    private readonly victim: NpcActor,
    readonly thrall: NpcActor,
    private readonly thrallFirst: boolean,
  ) {
    super(victim);
  }

  override createNpcs(): NpcActor[] {
    return this.thrallFirst ? [this.thrall, this.victim] : [this.victim, this.thrall];
  }

  getNpcDefinitions(): NpcDefinitionCollection {
    return this.definitions;
  }

  override processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    return thrallDefinition.isActor(actor)
      ? this.definitions.tick(actor, { ...ctx, random: () => 0 })
      : super.processNpcTick(actor);
  }
}

/** Registers a fresh NPC through `ctx.spawnNpc` on the first tick of every run. */
class FirstTickSpawnEncounter extends TrackingNpcEncounter {
  completeNpcBand(ctx: EncounterContext): EnvironmentalDamage[] {
    if (ctx.tick === 1) ctx.spawnNpc({ ...createTrackingNpc([12, 10], 0), id: 'spawned-npc', role: 'npc' });
    return [];
  }
}

class ZeroDelayNpcAttackEncounter extends TrackingNpcEncounter {
  processNpcTick(actor: NpcActor): EncounterTickResult {
    if (actor.id !== 'tracking-npc') return { environmentalDamages: [] };
    return {
      npcAttacks: [
        {
          attackerId: 'tracking-npc',
          targetId: 'player',
          style: 'magic',
          attackKind: 'magic_fire',
          rolledDamage: 4,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          sourceDeathPolicy: 'cancel-before-impact',
        },
      ],
      environmentalDamages: [],
    };
  }
}

class PostTickOrderingEncounter extends TrackingNpcEncounter {
  readonly postTickObservations: { readonly npcAlive: boolean; readonly playerHp: number; readonly tick: number }[] =
    [];

  override processPostTick(ctx: EncounterContext): EnvironmentalDamage[] {
    const npc = ctx.world.getNpc('tracking-npc');
    const player = ctx.world.getPlayer();
    if (!npc || !player) throw new Error('Post-tick ordering probe actors missing from world state');
    this.postTickObservations.push({ npcAlive: npc.alive, playerHp: player.vitals.hp, tick: ctx.tick });
    return [{ baseDamage: 99, attackType: 'typeless', source: 'TookDamage' }];
  }
}

class PlayerHitProbeEncounter extends TrackingNpcEncounter {
  readonly phaseOrder: string[] = [];
  readonly resolvedPlayerAttacks: {
    readonly contextKeys: readonly string[];
    readonly info: EncounterPlayerAttackInfo;
    readonly targetHp: number;
  }[] = [];

  onPlayerAttackResolved(info: EncounterPlayerAttackInfo, ctx: EncounterPlayerAttackContext): void {
    const target = ctx.world.getNpc(info.targetId);
    if (!target) throw new Error('Player-attack probe target missing from world state');
    this.phaseOrder.push('attackResolved');
    this.resolvedPlayerAttacks.push({
      contextKeys: Object.keys(ctx).sort(),
      info,
      targetHp: target.vitals.hp,
    });
  }

  override processPostTick(): EnvironmentalDamage[] {
    this.phaseOrder.push('processPostTick');
    return [];
  }
}

class AutoAttackPauseProbeEncounter extends TrackingNpcEncounter {
  getEngineRules() {
    return {
      modifyPlayerCombatParams: () => ({ attackSpeed: 1, attackRange: 1 }),
    };
  }

  onPlayerAttackResolved(info: EncounterPlayerAttackInfo, ctx: EncounterPlayerAttackResolvedContext): void {
    if (info.baseDamage !== 77) return;
    ctx.pausePlayerAutoAttack(info.targetId, info.tick + 3);
    ctx.pausePlayerAutoAttack(info.targetId, info.tick + 2);
  }
}

class SurvivingPostTickEncounter extends TrackingNpcEncounter {
  override processPostTick(): EnvironmentalDamage[] {
    return [{ baseDamage: 4, attackType: 'typeless', source: 'TookDamage' }];
  }
}

describe('SimulationEngine', () => {
  let engine: SimulationEngine;

  beforeEach(() => {
    engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
  });

  describe('infinite special attack toggle', () => {
    it('pins special attack energy to full each tick when enabled', () => {
      engine.setMechanicsConfig({ infiniteSpecialAttack: true, infiniteHealth: true });
      engine['worldState'].getPlayer()!.specialAttack = {
        energy: 30,
        regenTickCounter: 50,
        lightbearerEquipped: false,
      };

      engine.advanceTick(PLAYER_START_POS);

      expect(engine.getState().specialAttack.energy).toBe(100);
    });

    it('leaves energy to normal regen when the toggle is off', () => {
      engine.setMechanicsConfig({ infiniteHealth: true });
      engine['worldState'].getPlayer()!.specialAttack = {
        energy: 30,
        regenTickCounter: 50,
        lightbearerEquipped: false,
      };

      engine.advanceTick(PLAYER_START_POS);

      // regenTickCounter 50 -> 49, no 10% regen cycle yet, so energy is unchanged.
      expect(engine.getState().specialAttack.energy).toBe(30);
    });
  });

  describe('NPC and player turn ordering', () => {
    it('gives an NPC added during the NPC turns its turn that tick, and one added before or after them none', () => {
      const first = createTrackingNpc([10, 10], 0);
      const turns: [string, number][] = [];
      const added = (id: string): NpcActor => ({ ...createTrackingNpc([20, 20], 0), id, role: 'minion' });
      class SpawningEncounter extends TrackingNpcEncounter {
        prepareNpcBand(ctx: EncounterContext): void {
          if (ctx.tick === 3) ctx.spawnNpc(added('before-turns'));
        }
        override moveNpc(actor: NpcActor, ctx: EncounterContext): NpcMovementRequest[] {
          turns.push([actor.id, ctx.tick]);
          if (actor === first && ctx.tick === 2) ctx.spawnNpc(added('during-turns'));
          return [];
        }
        override processPostTick(ctx: EncounterContext) {
          if (ctx.tick === 1) ctx.spawnNpc(added('after-turns'));
          return super.processPostTick(ctx);
        }
      }
      const testEngine = new SimulationEngine({ encounter: new SpawningEncounter(first), startPos: [10, 14] });
      for (let tick = 0; tick < 4; tick++) testEngine.advanceTick([10, 14]);

      const firstTurn = (id: string) => turns.find(([actor]) => actor === id)?.[1];
      // Inferno split children and revived NPCs step in their add tick; wave spawns first move next tick.
      expect([firstTurn('after-turns'), firstTurn('during-turns'), firstTurn('before-turns')]).toEqual([2, 2, 4]);
    });

    it.each([
      'moving',
      'bound',
      'red-x',
    ] as const)('plans the second mover against the first applied position when the first is %s', (mode) => {
      const first = createTrackingNpc([10, 10], 0);
      const second: NpcActor = { ...createTrackingNpc([9, 10], 0), id: 'second-mover', role: 'minion' };
      const observed: Coordinate[] = [];
      class LazyMovementEncounter extends TrackingNpcEncounter {
        override createNpcs(): NpcActor[] {
          return [first, second];
        }
        override *moveNpc(actor: NpcActor, ctx: EncounterContext): Iterable<NpcMovementRequest> {
          if (actor === first) {
            yield { npcId: first.id, path: [[11, 10]] };
            return;
          }
          observed.push([...first.position]);
          const canStep = createNpcStepOccupancyPredicate(ctx.world.occupancy);
          yield { npcId: second.id, path: canStep(second.position, [10, 10], 1) ? [[10, 10]] : [] };
        }
      }
      const startPos: Coordinate = mode === 'red-x' ? [10, 10] : [10, 14];
      const testEngine = new SimulationEngine({ encounter: new LazyMovementEncounter(first), startPos });
      if (mode === 'bound') first.debuffs = { boundFromTick: 1, boundUntilTick: 3 };
      if (mode === 'red-x') testEngine.setAttackTarget(first.id);

      testEngine.advanceTick(startPos);

      expect(observed).toEqual([mode === 'moving' ? [11, 10] : [10, 10]]);
      expect(second.position).toEqual(mode === 'moving' ? [10, 10] : [9, 10]);
      expect(
        testEngine
          .getLastTickEvents()
          .filter((event) => isCoreEvent(event, 'movement') && [first.id, second.id].includes(event.actorId)),
      ).toHaveLength(mode === 'moving' ? 2 : 0);
    });

    it('notifies the encounter exactly once for an immediate player attack before post-tick processing', () => {
      // Given: an adjacent encounter NPC and a player attack forced through the immediate CombatSystem path.
      const npc = createTrackingNpc([10, 10], 0);
      npc.vitals.hp = 10;
      npc.vitals.maxHp = 10;
      const encounter = new PlayerHitProbeEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 11] });
      testEngine.setAttackTarget(npc.id);
      const combatSystem = Reflect.get(testEngine, 'combatSystem') as CombatSystem;
      const processAttack = combatSystem.processAttack.bind(combatSystem);
      const processAttackSpy = vi
        .spyOn(combatSystem, 'processAttack')
        .mockImplementation((world, attacker, target, bridge) =>
          processAttack(world, attacker, target, {
            ...bridge,
            resolveAttack: () => ({
              style: 'melee',
              attackKind: 'melee_slash',
              rolledDamage: 4,
              accuracySucceeded: true,
              impactDelayTicks: 0,
            }),
          }),
        );

      // When: the player turn resolves its zero-delay attack.
      testEngine.advanceTick([10, 11]);

      // Then: the hook receives the complete post-damage record through only truthful capabilities.
      expect(processAttackSpy).toHaveBeenCalledOnce();
      expect(encounter.resolvedPlayerAttacks).toEqual([
        {
          contextKeys: ['despawnNpc', 'pausePlayerAutoAttack', 'spawnNpc', 'tickEvents', 'world'],
          info: {
            tick: 1,
            sourceId: 'player',
            targetId: npc.id,
            attackType: 'melee',
            baseDamage: 4,
            effectiveDamage: 4,
            hpBefore: 10,
            hpAfter: 6,
          },
          targetHp: 6,
        },
      ]);
      expect(encounter.phaseOrder).toEqual(['attackResolved', 'processPostTick']);
    });

    it('applies the due hit before the attack, so the pause it raises blocks that same tick', () => {
      // Given: one-tick autoattacks and a player hit due to resolve after autoattack on R=2.
      const npc = createTrackingNpc([10, 10], 0);
      npc.vitals = { hp: 1000, maxHp: 1000 };
      const testEngine = new SimulationEngine({
        encounter: new AutoAttackPauseProbeEncounter(npc),
        startPos: [10, 11],
      });
      testEngine.setAttackTarget(npc.id);
      const world = getWorldState(testEngine);
      const attackTicks: number[] = [];
      const advanceAndRecord = (): void => {
        testEngine.advanceTick([10, 11]);
        for (const event of testEngine.getLastTickEvents()) {
          if (isCoreEvent(event, 'attack_started') && event.sourceId === 'player') attackTicks.push(event.tick);
        }
      };
      advanceAndRecord();
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: npc.id,
        style: 'range',
        attackKind: 'range_arrow',
        launchTick: 1,
        impactTick: 2,
        rolledDamage: 77,
        accuracySucceeded: true,
      });

      // When: R and the three following ticks execute through the real engine pipeline.
      advanceAndRecord();
      expect(world.getPlayer()?.autoAttackPause).toEqual({ targetId: npc.id, resumeTick: 5 });
      advanceAndRecord();
      advanceAndRecord();
      advanceAndRecord();

      // Then: the hit resolves in the player queue stage, ahead of the interaction
      // stage that launches attacks, so the pause it raises already covers R itself.
      // Ticks 2-4 are blocked and the attack resumes on the recorded resumeTick.
      expect(attackTicks).toEqual([1, 5]);
      expect(world.getPlayer()?.autoAttackPause).toBeNull();
    });

    it('notifies the encounter exactly once when a delayed player projectile misses before post-tick processing', () => {
      // Given: a delayed player projectile miss is due against an encounter NPC.
      const npc = createTrackingNpc([10, 10], 0);
      npc.vitals.hp = 10;
      npc.vitals.maxHp = 10;
      const encounter = new PlayerHitProbeEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 11] });
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: npc.id,
        style: 'range',
        attackKind: 'range_arrow',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 0,
        accuracySucceeded: false,
      });

      // When: the impact tick is processed.
      testEngine.advanceTick([10, 11]);

      // Then: the miss still resolves once with unchanged post-damage HP before processPostTick.
      expect(encounter.resolvedPlayerAttacks).toEqual([
        {
          contextKeys: ['despawnNpc', 'pausePlayerAutoAttack', 'spawnNpc', 'tickEvents', 'world'],
          info: {
            tick: 1,
            sourceId: 'player',
            targetId: npc.id,
            attackType: 'range',
            baseDamage: 0,
            effectiveDamage: 0,
            hpBefore: 10,
            hpAfter: 10,
          },
          targetHp: 10,
        },
      ]);
      expect(encounter.phaseOrder).toEqual(['attackResolved', 'processPostTick']);
    });

    it('leaves blood fury to the swing: a landing melee hit neither heals nor rolls for it', () => {
      // Given: blood fury is equipped and a melee hit lands. The proc is rolled and healed on the
      // swing tick instead (playerAttackLaunch), a tick before the hitsplat, as every capture shows.
      const npc = createTrackingNpc([10, 10], 0);
      let combatRolls = 0;
      const testEngine = new SimulationEngine({
        encounter: new TrackingNpcEncounter(npc),
        startPos: [10, 11],
        combatRandom: () => {
          combatRolls += 1;
          return 0;
        },
      });
      const world = getWorldState(testEngine);
      const player = world.getPlayer();
      if (!player) throw new Error('Expected player actor');
      player.equipment.amulet = AMULET_OF_BLOOD_FURY;
      player.vitals.hp = 50;
      player.stats.hitpoints.current = 50;
      enqueueEnginePendingHit(testEngine, {
        sourceId: player.id,
        targetId: npc.id,
        style: 'melee',
        attackKind: 'melee_slash',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 50,
        accuracySucceeded: true,
      });
      testEngine.advanceTick([10, 11]);

      expect(testEngine.getState().playerHP).toBe(50);
      expect(combatRolls).toBe(0);
    });

    it('characterizes post-tick damage after pending-hit resolution on the same tick', () => {
      // Given: a lethal NPC hit and lethal post-tick player damage both resolve on tick 1.
      const npc = createTrackingNpc([10, 10], 0);
      npc.vitals.hp = 3;
      npc.vitals.maxHp = 3;
      const encounter = new PostTickOrderingEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 11] });
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: npc.id,
        style: 'magic',
        attackKind: 'magic_shadow',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 3,
        accuracySucceeded: true,
      });

      // When: the tick runs through pending hits and post-player encounter work.
      testEngine.advanceTick([10, 11]);

      // Then: processPostTick sees the NPC dead before its returned damage kills the player.
      expect(encounter.postTickObservations).toEqual([{ npcAlive: false, playerHp: 99, tick: 1 }]);
      expect(testEngine.getState()).toMatchObject({ currentTick: 1, isAlive: false, failedCondition: 'Death' });
    });

    it('does not apply Elysian mitigation to environmental post-tick damage', () => {
      const npc = createTrackingNpc([10, 10], 0);
      const testEngine = new SimulationEngine({ encounter: new SurvivingPostTickEncounter(npc), startPos: [10, 11] });
      testEngine.setEquipment({ shield: 12817 });
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

      try {
        testEngine.advanceTick([10, 11]);

        expect(testEngine.getState().playerHP).toBe(95);
        expect(randomSpy).not.toHaveBeenCalled();
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('notifies the encounter on the impact tick when a player hit defeats a real NPC', () => {
      // Given: a live NPC and a lethal player pending hit due on tick 1.
      const npc = createTrackingNpc([10, 10], 0);
      npc.vitals.hp = 3;
      npc.vitals.maxHp = 3;
      const encounter = new TrackingNpcEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 11] });
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: npc.id,
        style: 'magic',
        attackKind: 'magic_shadow',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 3,
        accuracySucceeded: true,
      });

      // When: the lethal hit resolves.
      testEngine.advanceTick([10, 11]);

      // Then: the encounter observes the real NPC defeat after all tick damage, retaining the impact tick.
      expect(encounter.defeatedNpcs).toEqual([
        { defeat: { npcId: npc.id, tick: 1 }, ownership: 'encounter-owned', playerAlive: true, playerHp: 99 },
      ]);
      expect(testEngine.getEncounterOutcome()).toMatchObject({ phase: 'resolving', decisiveTick: 1 });
    });

    it('dispatches a surviving defeat only after nonlethal post-tick damage', () => {
      // Given: a lethal NPC pending hit and nonlethal player damage share tick 1.
      const npc = createTrackingNpc([10, 10], 0);
      npc.vitals.hp = 1;
      npc.vitals.maxHp = 1;
      const encounter = new SurvivingPostTickEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 11] });
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: npc.id,
        style: 'melee',
        attackKind: 'melee_slash',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 1,
        accuracySucceeded: true,
      });

      // When: the complete damage phase resolves.
      testEngine.advanceTick([10, 11]);

      // Then: callback context contains post-damage HP while the defeat fact retains D.
      expect(encounter.defeatedNpcs).toEqual([
        { defeat: { npcId: npc.id, tick: 1 }, ownership: 'encounter-owned', playerAlive: true, playerHp: 95 },
      ]);
    });

    it('suppresses defeat dispatch when post-tick damage kills the player on the lethal NPC tick', () => {
      // Given: the NPC dies from a pending hit before lethal post-tick player damage.
      const npc = createTrackingNpc([10, 10], 0);
      npc.vitals.hp = 3;
      npc.vitals.maxHp = 3;
      const encounter = new PostTickOrderingEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 11] });
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: npc.id,
        style: 'magic',
        attackKind: 'magic_shadow',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 3,
        accuracySucceeded: true,
      });

      // When: both lethal transitions resolve on tick 1.
      testEngine.advanceTick([10, 11]);

      // Then: player death wins without shifting the NPC damage-history tick.
      expect(encounter.defeatedNpcs).toEqual([]);
      expect(testEngine.getEncounterOutcome()).toEqual({ phase: 'active' });
      expect(testEngine.getState().damageHistory.find((entry) => entry.targetId === npc.id)?.tick).toBe(1);
    });

    it('dispatches noncritical NPC deaths without forcing shared completion', () => {
      // Given: the only NPC is a noncritical add.
      const npc = createTrackingNpc([10, 10], 0);
      npc.role = 'minion';
      npc.vitals.hp = 1;
      npc.vitals.maxHp = 1;
      const encounter = new TrackingNpcEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 11] });
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: npc.id,
        style: 'melee',
        attackKind: 'melee_slash',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 1,
        accuracySucceeded: true,
      });

      // When: the add dies.
      testEngine.advanceTick([10, 11]);

      // Then: the fact is delivered but the encounter remains active.
      expect(encounter.defeatedNpcs).toHaveLength(1);
      expect(testEngine.getEncounterOutcome()).toEqual({ phase: 'active' });
    });

    it('runs external-owned cleanup without entering shared completion and preserves actor_died', () => {
      // Given: tutorial ownership is active for a boss kill.
      const npc = createTrackingNpc([10, 10], 0);
      npc.vitals.hp = 1;
      npc.vitals.maxHp = 1;
      const encounter = new TrackingNpcEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 11] });
      testEngine.setCompletionOwnership('external-owned');
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: npc.id,
        style: 'melee',
        attackKind: 'melee_slash',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 1,
        accuracySucceeded: true,
      });

      // When: the tutorial-owned boss dies.
      testEngine.advanceTick([10, 11]);

      // Then: local cleanup receives the fact, shared completion stays active, and actor_died remains observable.
      expect(encounter.defeatedNpcs).toEqual([
        { defeat: { npcId: npc.id, tick: 1 }, ownership: 'external-owned', playerAlive: true, playerHp: 99 },
      ]);
      expect(testEngine.getEncounterOutcome()).toEqual({ phase: 'active' });
      expect(testEngine.getLastTickEvents()).toContainEqual(
        expect.objectContaining({ type: 'actor_died', actorId: npc.id }),
      );
      expect(testEngine.canAdvance()).toBe(true);
    });

    it('preserves external ownership on ordinary reset and serializes external replay ownership', () => {
      // Given: an engine configured for external completion ownership.
      const npc = createTrackingNpc([10, 10], 0);
      const encounter = new TrackingNpcEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 11] });
      testEngine.setCompletionOwnership('external-owned');
      const externalRunConfig = testEngine.getRunConfig();

      // When: ordinary reset and replay-config reset are applied in sequence.
      testEngine.reset([10, 11]);
      const ordinaryRunConfig = testEngine.getRunConfig();
      const resetWorld = getWorldState(testEngine);
      const resetNpc = resetWorld.getNpc(npc.id);
      if (!resetNpc) throw new Error('Expected reset NPC');
      resetNpc.vitals.hp = 1;
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: resetNpc.id,
        style: 'melee',
        attackKind: 'melee_slash',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 1,
        accuracySucceeded: true,
      });
      testEngine.advanceTick([10, 11]);
      const outcomeAfterDefeat = testEngine.getEncounterOutcome();
      testEngine.reset([10, 11], externalRunConfig);

      // Then: a mounted external owner survives ordinary reset, and replay takeover restores its recorded owner.
      expect(ordinaryRunConfig.completionOwnership).toBe('external-owned');
      expect(outcomeAfterDefeat).toEqual({ phase: 'active' });
      expect(testEngine.getRunConfig().completionOwnership).toBe('external-owned');
    });

    it('runs the complete NPC turn against the start-of-tick player before the player turn', () => {
      // Given: both actors have a movement step to perform during their respective turns.
      const npc = createTrackingNpc([10, 10], 0);
      const encounter = new TickOrderProbeEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 12] });
      testEngine.setAttackTarget(npc.id);

      // When: one tick advances both turns.
      testEngine.advanceTick([10, 10]);
      const turnOrder = testEngine.getLastTickEvents().flatMap((event) => {
        if (isCoreEvent(event, 'movement') && event.actorId === npc.id) return ['npcMovement'];
        if (event.type === 'process_tick_probe') return ['npcAction'];
        if (isCoreEvent(event, 'movement') && event.actorId === 'player') return ['playerMovement'];
        return [];
      });

      // Then: NPC hooks see the pre-move player, and the NPC's action completes before player movement.
      expect({ observations: encounter.observations, turnOrder }).toEqual({
        observations: [
          { phase: 'moveNpc', playerPos: [10, 12], worldPlayerPos: [10, 12], npcPos: [10, 10] },
          { phase: 'processNpcTick', playerPos: [10, 12], worldPlayerPos: [10, 12], npcPos: [11, 10] },
        ],
        turnOrder: ['npcMovement', 'npcAction', 'playerMovement'],
      });
    });

    it('drains due hits in two owner passes: NPC-targeted before the NPC turn, player-targeted after it', () => {
      // Given: adjacent actors plus two due hits queued NPC-first, then player-second.
      const npc = createTrackingNpc([10, 10], 0);
      const testEngine = new SimulationEngine({
        encounter: new ZeroDelayNpcAttackEncounter(npc),
        startPos: [10, 11],
      });
      testEngine.setAttackTarget(npc.id);
      const world = getWorldState(testEngine);
      enqueueEnginePendingHit(testEngine, {
        sourceId: npc.id,
        targetId: 'player',
        style: 'range',
        attackKind: 'range_shadow',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 2,
        accuracySucceeded: true,
      });
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: npc.id,
        style: 'magic',
        attackKind: 'magic_shadow',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: 3,
        accuracySucceeded: true,
      });

      // When: the NPC and player both attack on the due-hit tick.
      testEngine.advanceTick([10, 11]);
      const combatOrder = testEngine.getLastTickEvents().flatMap((event) => {
        if (isCoreEvent(event, 'attack_started') && (event.sourceId === npc.id || event.sourceId === 'player')) {
          return [`attack:${event.sourceId}`];
        }
        if (
          isCoreEvent(event, 'hit_applied') &&
          (event.attackKind === 'magic_fire' ||
            event.attackKind === 'range_shadow' ||
            event.attackKind === 'magic_shadow')
        ) {
          return [`hit:${event.targetId}:${event.attackKind}`];
        }
        return [];
      });

      // Then: the NPC's incoming hit lands before it can act, its own immediate damage leads the
      // player's queue, and each owner's pass keeps insertion order — hits resolve from the
      // TARGET's queue stage in rsmod (`hit_queues`), which precedes that entity's interaction,
      // and NPCs are processed before players.
      expect({ combatOrder, remainingPendingHitKinds: world.pendingHits.map((hit) => hit.attackKind) }).toEqual({
        combatOrder: [
          'hit:tracking-npc:magic_shadow',
          'attack:tracking-npc',
          'hit:player:magic_fire',
          'hit:player:range_shadow',
          'attack:player',
        ],
        remainingPendingHitKinds: ['melee_crush'],
      });
    });

    // capture inferno-waves-1-68-packet-data.txt t581: the Ice Burst's targets step on the cast
    // tick, stand still from t582, and take the splats at t586.
    it('lets an NPC take its step on the cast tick and freezes it from the next, before the spell lands', () => {
      // Given: an NPC stepping toward the player, which steps on tick 1.
      const npc = createTrackingNpc([10, 10], 0);
      const path: Coordinate[] = [[10, 11]];
      const testEngine = new SimulationEngine({ encounter: new TrackingNpcEncounter(npc, path), startPos: [10, 14] });
      testEngine.advanceTick([10, 14]);
      const world = getWorldState(testEngine);
      const player = world.getPlayer();
      if (!player) throw new Error('Expected the player');

      // When: the player's Ice Barrage is cast after that NPC turn, landing four ticks later, and the
      // NPC wants another step on tick 2.
      const combatSystem = Reflect.get(testEngine, 'combatSystem') as CombatSystem;
      combatSystem.processAttackRequest(
        world,
        {
          attacker: player,
          target: npc,
          attack: {
            style: 'magic',
            attackKind: 'magic_shadow',
            rolledDamage: 1,
            accuracySucceeded: true,
            impactDelayTicks: 4,
            spellId: 'Ice Barrage',
            postHitEffects: [{ effect: 'freeze', durationTicks: 32 }],
          },
        },
        { events: new TickEvents(), enablePendingHits: true, infiniteHealth: true },
      );
      path[0] = [10, 12];
      testEngine.advanceTick([10, 14]);

      // Then: the cast-tick step stands, the next is lost, and the window runs 32 ticks from tick 2.
      expect({ position: npc.position, debuffs: npc.debuffs }).toEqual({
        position: [10, 11],
        debuffs: { boundFromTick: 2, boundUntilTick: 34 },
      });
    });

    it.each([
      { label: 'a due hit', lethal: 'hit' },
      { label: 'a due poison pulse', lethal: 'poison' },
    ] as const)('stops an NPC moving and attacking on the tick $label kills it', ({ lethal }) => {
      // Given: an NPC that would both step and swing, and lethal damage queued against it.
      const npc = createTrackingNpc([10, 10], 0);
      npc.vitals.hp = 4;
      const encounter = new ZeroDelayNpcAttackEncounter(npc, [[10, 11]]);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 12] });
      if (lethal === 'hit') {
        enqueueEnginePendingHit(testEngine, {
          sourceId: 'player',
          targetId: npc.id,
          style: 'magic',
          attackKind: 'magic_shadow',
          launchTick: 0,
          impactTick: 1,
          rolledDamage: 9,
          accuracySucceeded: true,
        });
      } else {
        npc.poison = { sourceId: 'player', severity: 20, nextPulseTick: 1 };
      }

      // When: the tick that damage comes due on runs.
      testEngine.advanceTick([10, 12]);

      // Then: it died in the NPC queue band, ahead of its own movement and attack.
      expect({
        alive: npc.alive,
        position: npc.position,
        attacked: testEngine
          .getLastTickEvents()
          .some((event) => isCoreEvent(event, 'attack_started') && event.sourceId === npc.id),
      }).toEqual({ alive: false, position: [10, 10], attacked: false });
    });
  });

  describe('committed hits and overkill', () => {
    const JAL_MEJ_RAH = 7692;

    function shooter(): NpcActor {
      return { ...createTrackingNpc([10, 10], 0), role: 'npc', npcTypeId: JAL_MEJ_RAH, vitals: { hp: 1, maxHp: 1 } };
    }

    /** The player's own hit killing the shooter in the NPC queue band of `tick`. */
    function killOn(testEngine: SimulationEngine, tick: number): void {
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: 'tracking-npc',
        style: 'range',
        attackKind: 'range_arrow',
        launchTick: 0,
        impactTick: tick,
        rolledDamage: 1,
        accuracySucceeded: true,
      });
    }

    it.each([
      { sourceDeathPolicy: 'persist', taken: 9 },
      { sourceDeathPolicy: 'cancel-before-impact', taken: 0 },
    ] as const)('a $sourceDeathPolicy shot whose source dies before impact deals $taken (Inferno 1-68: 1312→1313)', ({
      sourceDeathPolicy,
      taken,
    }) => {
      // Given: a shot released on tick 1 that lands on tick 2, the tick the player's hit kills its source.
      const npc = shooter();
      const testEngine = new SimulationEngine({
        encounter: new SingleShotEncounter(npc, { launchTick: 1, impactDelayTicks: 1, damage: 9, sourceDeathPolicy }),
        startPos: [10, 12],
      });
      killOn(testEngine, 2);

      // When: both ticks run.
      testEngine.advanceTick([10, 12]);
      testEngine.advanceTick([10, 12]);

      // Then: the source died in the NPC band, and its shot landed (or not) in the player band after.
      expect(npc.alive).toBe(false);
      expect(testEngine.getState().playerHP).toBe(99 - taken);
    });

    it('lands a released shot after its source has left the world, attributed to it (Inferno 1-68: 5091→5093)', () => {
      // Given: a two-tick shot whose source is killed on the next tick and removed the tick after.
      const npc = shooter();
      const testEngine = new SimulationEngine({
        encounter: new SingleShotEncounter(npc, {
          launchTick: 1,
          impactDelayTicks: 2,
          damage: 14,
          sourceDeathPolicy: 'persist',
          despawnTick: 3,
        }),
        startPos: [10, 12],
      });
      killOn(testEngine, 2);

      // When: it lands.
      for (let tick = 1; tick <= 3; tick++) testEngine.advanceTick([10, 12]);

      // Then: the player takes it from an NPC no longer in the world, and the record keeps its type.
      expect(getWorldState(testEngine).getNpc(npc.id)).toBeNull();
      expect(testEngine.getState().playerHP).toBe(85);
      expect(testEngine.getDamageHistory().filter((entry) => entry.targetId === 'player')).toEqual([
        expect.objectContaining({
          tick: 3,
          source: 'TrackingNpcTest',
          sourceNpcTypeId: JAL_MEJ_RAH,
          effectiveDamage: 14,
        }),
      ]);
    });

    it('pays a kill reward, death and defeat once when overkill hits land on the same tick', () => {
      // Given: two queued hits, both carrying a spec refund, on a 1-HP NPC.
      const npc = { ...createTrackingNpc([10, 10], 0), vitals: { hp: 1, maxHp: 1 } };
      const encounter = new TrackingNpcEncounter(npc);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 12] });
      const player = getWorldState(testEngine).getPlayer();
      if (!player) throw new Error('Expected player');
      player.specialAttack = { ...player.specialAttack, energy: 50 };
      for (const rolledDamage of [1, 20]) {
        enqueueEnginePendingHit(testEngine, {
          sourceId: 'player',
          targetId: npc.id,
          style: 'melee',
          attackKind: 'melee_slash',
          launchTick: 0,
          impactTick: 1,
          rolledDamage,
          accuracySucceeded: true,
          onKillEffect: { refundSpecEnergy: 10 },
        });
      }

      // When: they land.
      testEngine.advanceTick([10, 12]);

      // Then: the second is a zero impact, and nothing tied to the kill repeats.
      const events = testEngine.getLastTickEvents();
      expect(
        events.filter((event) => isCoreEvent(event, 'hitsplat_spawned') && event.targetId === npc.id),
      ).toMatchObject([
        { amount: 1, hitsplatType: 'damage' },
        { amount: 0, hitsplatType: 'block' },
      ]);
      expect(events.filter((event) => isCoreEvent(event, 'actor_died') && event.actorId === npc.id)).toHaveLength(1);
      expect(testEngine.getState().specialAttack.energy).toBe(60);
      expect(encounter.defeatedNpcs.map(({ defeat }) => defeat)).toEqual([{ npcId: npc.id, tick: 1 }]);
    });
  });

  describe('queued NPC death', () => {
    /** A 4-HP probe NPC opted in to queued death, and what it did on each tick that runs. */
    function queuedProbe(
      options: { readonly steps?: ReadonlyMap<number, Coordinate>; readonly policy?: 'queued' } = {},
    ) {
      const npc: NpcActor = {
        ...createTrackingNpc([10, 10], 0),
        vitals: { hp: 4, maxHp: 4 },
        ...(options.policy === undefined ? {} : { deathPolicy: options.policy }),
      };
      const encounter = new TurnProbeEncounter(npc, options.steps);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 13] });
      const turns: { tick: number; moved: boolean; attacked: boolean }[] = [];
      const run = (ticks: number) => {
        for (let i = 0; i < ticks; i++) {
          testEngine.advanceTick([10, 13]);
          const events = testEngine.getLastTickEvents();
          turns.push({
            tick: testEngine.currentTick,
            moved: events.some((event) => isCoreEvent(event, 'movement') && event.actorId === npc.id),
            attacked: events.some((event) => isCoreEvent(event, 'attack_started') && event.sourceId === npc.id),
          });
        }
      };
      const hit = (impactTick: number, rolledDamage: number) =>
        enqueueEnginePendingHit(testEngine, {
          sourceId: 'player',
          targetId: npc.id,
          style: 'magic',
          attackKind: 'magic_shadow',
          launchTick: 0,
          impactTick,
          rolledDamage,
          accuracySucceeded: true,
        });
      return { npc, encounter, testEngine, turns, run, hit };
    }

    it('keeps a lethal-last kill acting on K, with death processing and the animation at K+1 and one defeat at K', () => {
      const { npc, encounter, testEngine, turns, run, hit } = queuedProbe({ policy: 'queued' });
      hit(1, 9);

      run(1);
      expect(turns.at(-1)).toEqual({ tick: 1, moved: false, attacked: true });
      expect(npc).toMatchObject({ alive: false, death: { status: 'pending', killTick: 1, processTick: 2 } });
      expect(testEngine.getState().npcs[0]).toMatchObject({ alive: false, deathAnimationTick: 2 });

      run(3);
      expect(turns.slice(1).every((turn) => !turn.attacked && !turn.moved)).toBe(true);
      expect(npc.death).toEqual({ status: 'started', killTick: 1, processTick: 2, causeStage: 'hit-queue' });
      expect(npc.deathAnimationTick).toBe(2);
      expect(encounter.defeatedNpcs.map(({ defeat }) => defeat)).toEqual([{ npcId: npc.id, tick: 1 }]);
    });

    it('lets the killing tick carry its final step, flooring the animation at that step + 3', () => {
      const { npc, turns, run, hit } = queuedProbe({
        policy: 'queued',
        steps: new Map([
          [1, [11, 10]],
          [2, [12, 10]],
        ]),
      });
      hit(1, 9);

      run(3);

      expect(turns).toEqual([
        { tick: 1, moved: true, attacked: true },
        { tick: 2, moved: false, attacked: false },
        { tick: 3, moved: false, attacked: false },
      ]);
      expect(npc.position).toEqual([11, 10]);
      expect(npc.history.get(1)).toEqual([11, 10]);
      expect(npc).toMatchObject({ lastStepTick: 1, deathAnimationTick: 4 });
    });

    it('waits for the last step + 3 without extra turns (B:2210: still kill 2210, step 2209, death 2212)', () => {
      const { npc, turns, run, hit } = queuedProbe({ policy: 'queued', steps: new Map([[1, [11, 10]]]) });
      hit(2, 9);

      run(4);

      expect(turns.map((turn) => turn.attacked)).toEqual([true, true, false, false]);
      expect(npc.death).toMatchObject({ killTick: 2, processTick: 3, status: 'started' });
      expect(npc.deathAnimationTick).toBe(4);
    });

    it('processes an overkill death on K: no move or attack (C:1606 45,0,0)', () => {
      const { npc, turns, run, hit } = queuedProbe({ policy: 'queued', steps: new Map([[1, [11, 10]]]) });
      hit(1, 4);
      hit(1, 6);

      run(1);

      expect(turns).toEqual([{ tick: 1, moved: false, attacked: false }]);
      expect(npc.death).toMatchObject({ status: 'started', killTick: 1, processTick: 1 });
      expect(npc.deathAnimationTick).toBe(1);
    });

    it('promotes the death to K when an accepted hit is still queued after the pass (C:2142 shape)', () => {
      const { npc, testEngine, turns, run, hit } = queuedProbe({ policy: 'queued' });
      hit(1, 9);
      hit(3, 6);

      run(3);

      expect(turns.map((turn) => turn.attacked)).toEqual([false, false, false]);
      expect(npc.death).toMatchObject({ processTick: 1 });
      expect(
        testEngine.getDamageHistory().flatMap((entry) => (entry.targetId === npc.id ? [entry.effectiveDamage] : [])),
      ).toEqual([4, 0]);
    });

    it('keeps a burn kill acting on K and processes it at K+1 though a hit is pending (Inferno 1-68: 7288)', () => {
      const { npc, testEngine, turns, run, hit } = queuedProbe({ policy: 'queued' });
      npc.vitals.hp = 1;
      layBurnStack({
        target: npc,
        sourceId: 'player',
        origin: 'eclipse',
        severity: 'normal',
        pulses: 1,
        tick: 0,
        firstPulseDelayTicks: 1,
      });
      hit(2, 5);

      run(1);
      expect(turns[0]).toEqual({ tick: 1, moved: false, attacked: true });
      expect(npc.death).toEqual({ status: 'pending', killTick: 1, processTick: 2, causeStage: 'timer' });

      run(1);
      expect(turns[1]?.attacked).toBe(false);
      expect(npc.death?.status).toBe('started');
      expect(
        testEngine
          .getLastTickEvents()
          .filter((event) => isCoreEvent(event, 'hitsplat_spawned') && event.targetId === npc.id),
      ).toMatchObject([{ amount: 0, hitsplatType: 'block' }]);
    });

    it('runs no timer pulse on an NPC a due hit killed first', () => {
      const { npc, testEngine, run, hit } = queuedProbe({ policy: 'queued' });
      layBurnStack({
        target: npc,
        sourceId: 'player',
        origin: 'eclipse',
        severity: 'normal',
        pulses: 3,
        tick: 0,
        firstPulseDelayTicks: 1,
      });
      hit(1, 9);

      run(1);

      expect(npc.death?.causeStage).toBe('hit-queue');
      expect(
        testEngine
          .getLastTickEvents()
          .flatMap((event) =>
            isCoreEvent(event, 'hitsplat_spawned') && event.targetId === npc.id ? [event.hitsplatType] : [],
          ),
      ).toEqual(['damage']);
    });

    it('leaves an immediate-policy NPC exactly as before: no turn on K', () => {
      const { npc, encounter, turns, run, hit } = queuedProbe({ steps: new Map([[1, [11, 10]]]) });
      hit(1, 9);

      run(2);

      expect(turns.map(({ moved, attacked }) => moved || attacked)).toEqual([false, false]);
      expect(npc.death).toEqual({ status: 'started', killTick: 1, processTick: 1, causeStage: 'hit-queue' });
      expect(npc.deathAnimationTick).toBeUndefined();
      expect(npc.history.has(1)).toBe(false);
      expect(encounter.defeatedNpcs).toHaveLength(1);
    });

    it('starts a new life on revival: the death state goes and hits queued against the old life never land', () => {
      const { npc, testEngine, run, hit } = queuedProbe({ policy: 'queued' });
      hit(1, 9);
      hit(3, 2);
      run(1);

      reviveNpc(npc);
      npc.vitals.hp = 4;
      run(2);

      expect(npc).toMatchObject({ alive: true, lifeGeneration: 1, vitals: { hp: 4 } });
      expect(npc.death).toBeUndefined();
      expect(getWorldState(testEngine).pendingHits).toEqual([]);
      hit(4, 1);
      run(1);
      expect(npc.vitals.hp).toBe(3);
    });

    it('retains the corpse for the prune grace from the death animation, not the kill', () => {
      const { npc, testEngine, run, hit } = queuedProbe({ policy: 'queued', steps: new Map([[1, [11, 10]]]) });
      npc.role = 'npc';
      hit(1, 9);
      const world = getWorldState(testEngine);

      run(13);
      expect(npc.deathAnimationTick).toBe(4);
      expect(world.getNpc(npc.id)).toBe(npc);
      run(1);
      expect(world.getNpc(npc.id)).toBeNull();
    });

    it('neither targets nor heals a pending-death NPC', () => {
      const { npc, testEngine, turns, run, hit } = queuedProbe({ policy: 'queued' });
      npc.hitpointRegenNextTick = 1;
      testEngine.setAttackTarget(npc.id);
      hit(1, 9);

      run(1);

      const player = getWorldState(testEngine).getPlayer();
      expect(turns[0]?.attacked).toBe(true);
      expect(npc.death?.status).toBe('pending');
      expect(player?.attackTarget).toBeNull();
      expect(
        testEngine
          .getLastTickEvents()
          .some((event) => isCoreEvent(event, 'attack_started') && event.sourceId === 'player'),
      ).toBe(false);
      expect(applyNpcHealing(npc, 5, new TickEvents())).toBe(0);
      expect(npc.vitals.hp).toBe(0);
    });

    // Phantom barrage (inferno-waves-(35ish)-to-68 t1214→t1219): a manual cast fired on the tick the
    // previous one killed still launches. The chain only lines up when the spell's flight equals the
    // Barrage's 5-tick speed: 1 + floor((46 + 10d) / 30) is 5 at d=8 but 4 at d=7, where the death is
    // processed in the NPC band before the next cast can fire.
    describe('manual Blood Barrage chain on a queued kill', () => {
      const CERTAIN_STATS = {
        levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
        offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
        defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
        alwaysAccuratePlayerHit: true,
        alwaysMaximumPlayerHit: true,
      } satisfies NonNullable<NpcActor['formulaStats']>;

      /** Casts once on tick 1 (a 29, lethal on the 20-HP NPC), and clicks the next cast on tick 2 if `chain`. */
      function runChain(distance: number, chain: boolean) {
        const npc: NpcActor = {
          ...createTrackingNpc([10, 10], 0),
          role: 'npc',
          vitals: { hp: 20, maxHp: 20 },
          deathPolicy: 'queued',
          formulaStats: CERTAIN_STATS,
        };
        const startPos: Coordinate = [10, 10 + distance];
        const testEngine = new SimulationEngine({
          encounter: new TrackingNpcEncounter(npc),
          startPos,
          combatRandom: () => 0,
        });
        const player = holdBlowpipeWithBloodRunes(testEngine);
        player.vitals.hp = 50;
        player.stats.hitpoints.current = 50;
        const ticks: { tick: number; cast: boolean; hp: number; xp: number[]; moved: boolean; splats: number[] }[] = [];
        for (let tick = 1; tick <= 12; tick++) {
          if (tick === 1 || (tick === 2 && chain)) {
            testEngine.applyAction({ type: 'manualCast', targetId: npc.id, spellName: 'Blood Barrage' });
          }
          // Clicked on the NPC, so a player who has lost the target walks at it.
          testEngine.advanceTick([10, 10]);
          const events = testEngine.getLastTickEvents();
          ticks.push({
            tick,
            cast: events.some((event) => isCoreEvent(event, 'attack_started') && event.sourceId === 'player'),
            hp: player.vitals.hp,
            xp: events.flatMap((event) => (isCoreEvent(event, 'xp_drop') ? [event.predictedHit] : [])),
            moved: player.position[1] !== startPos[1],
            splats: events.flatMap((event) =>
              isCoreEvent(event, 'hitsplat_spawned') && event.targetId === npc.id ? [event.amount] : [],
            ),
          });
        }
        return { npc, player, ticks };
      }

      it('launches the next cast on the kill tick at d=8: it heals and gives no XP, and the death keeps K+1', () => {
        const chained = runChain(8, true);
        const control = runChain(8, false);

        // Cast on 1 lands on 6 (K); the next, ready on 6, still fires at the 0-HP NPC.
        expect(chained.ticks.filter((tick) => tick.cast).map((tick) => tick.tick)).toEqual([1, 6]);
        // Its target still attackable on K, the caster stands at range rather than walking to the click.
        expect(chained.ticks.slice(0, 6).some((tick) => tick.moved)).toBe(false);
        expect(chained.ticks[0]).toMatchObject({ hp: 57, xp: [20] });
        expect(chained.ticks[5]).toMatchObject({ hp: 64, xp: [], splats: [20] });
        // It lands on the corpse as a zero impact.
        expect(chained.ticks.flatMap((tick) => (tick.splats.length > 0 ? [[tick.tick, tick.splats]] : []))).toEqual([
          [6, [20]],
          [11, [0]],
        ]);
        expect(chained.npc.death).toEqual({ status: 'started', killTick: 6, processTick: 7, causeStage: 'hit-queue' });
        expect({ death: chained.npc.death, animation: chained.npc.deathAnimationTick }).toEqual({
          death: control.npc.death,
          animation: control.npc.deathAnimationTick,
        });
        expect(chained.npc.deathAnimationTick).toBe(7);
        expect(control.ticks.filter((tick) => tick.cast).map((tick) => tick.tick)).toEqual([1]);
        expect(control.player.attackTarget).toBeNull();
      });

      it('refuses the next cast at d=7: the kill lands a tick early and its death is processed first', () => {
        const { npc, player, ticks } = runChain(7, true);

        expect(ticks.filter((tick) => tick.cast).map((tick) => tick.tick)).toEqual([1]);
        expect(ticks.at(-1)?.hp).toBe(57);
        expect(npc.death).toEqual({ status: 'started', killTick: 5, processTick: 6, causeStage: 'hit-queue' });
        expect(player).toMatchObject({ attackTarget: null });
      });
    });
  });

  describe('NPC→NPC hits through the turn order', () => {
    /** A queued-policy victim, a thrall shooting it on `attackTicks`, and one older player hit. */
    function thrallFixture(options: {
      readonly thrallFirst: boolean;
      readonly victimHp: number;
      readonly attackTicks: readonly number[];
      readonly thrallDamage: number;
      readonly playerHit: { readonly impactTick: number; readonly damage: number };
    }) {
      const victim: NpcActor = {
        ...createTrackingNpc([10, 10], 0),
        vitals: { hp: options.victimHp, maxHp: options.victimHp },
        deathPolicy: 'queued',
      };
      const thrall = thrallDefinition.createActor(
        { ...createTrackingNpc([14, 10], 0), id: 'thrall', role: 'npc' },
        { targetId: victim.id, attackTicks: options.attackTicks, damage: options.thrallDamage },
      );
      const encounter = new ThrallFixtureEncounter(victim, thrall, options.thrallFirst);
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 13] });
      enqueueEnginePendingHit(testEngine, {
        sourceId: 'player',
        targetId: victim.id,
        style: 'magic',
        attackKind: 'magic_shadow',
        launchTick: 0,
        impactTick: options.playerHit.impactTick,
        rolledDamage: options.playerHit.damage,
        accuracySucceeded: true,
      });
      const victimAttacked: boolean[] = [];
      const run = (ticks: number) => {
        for (let i = 0; i < ticks; i++) {
          testEngine.advanceTick([10, 13]);
          victimAttacked.push(
            testEngine
              .getLastTickEvents()
              .some((event) => isCoreEvent(event, 'attack_started') && event.sourceId === victim.id),
          );
        }
      };
      return { victim, thrall, testEngine, victimAttacked, run };
    }

    it('promotes the death to K when a lower-order thrall queues its hit before the victim turns (C:2142, C:2432)', () => {
      const { victim, thrall, testEngine, victimAttacked, run } = thrallFixture({
        thrallFirst: true,
        victimHp: 4,
        attackTicks: [2],
        thrallDamage: 7,
        playerHit: { impactTick: 2, damage: 9 },
      });
      expect((thrall.processingOrder ?? 0) < (victim.processingOrder ?? 0)).toBe(true);

      run(3);

      // Killed on K = 2 by the older due hit, with the thrall's hit (due K+1) queued before its pass.
      expect(victimAttacked).toEqual([true, false, false]);
      expect(victim.death).toMatchObject({ killTick: 2, processTick: 2, status: 'started' });
      expect(
        testEngine
          .getDamageHistory()
          .flatMap((entry) => (entry.targetId === victim.id ? [[entry.tick, entry.effectiveDamage]] : [])),
      ).toEqual([
        [2, 4],
        [3, 0],
      ]);
    });

    it('cannot reach back into a turn already taken: a higher-order thrall leaves the victim acting on K (counter case)', () => {
      const { victim, thrall, testEngine, victimAttacked, run } = thrallFixture({
        thrallFirst: false,
        victimHp: 4,
        attackTicks: [2],
        thrallDamage: 7,
        playerHit: { impactTick: 2, damage: 9 },
      });
      expect((thrall.processingOrder ?? 0) > (victim.processingOrder ?? 0)).toBe(true);

      run(3);

      // The victim's pass ended lethal-last, so it keeps its K turn; the thrall shoots after it, at a
      // pending-death target, and nothing it does reopens that pass.
      expect(victimAttacked).toEqual([true, true, false]);
      expect(victim.death).toMatchObject({ killTick: 2, processTick: 3, status: 'started' });
      expect(testEngine.getDamageHistory().filter((entry) => entry.targetId === victim.id)).toHaveLength(1);
    });

    it('applies an older hit before a newer NPC→NPC hit due the same tick (B:2210: Shadow 48, then thrall 0)', () => {
      const { victim, testEngine, run } = thrallFixture({
        thrallFirst: false,
        victimHp: 48,
        attackTicks: [2],
        thrallDamage: 7,
        playerHit: { impactTick: 3, damage: 48 },
      });

      run(3);

      expect(
        testEngine
          .getDamageHistory()
          .flatMap((entry) =>
            entry.targetId === victim.id ? [[entry.sourceNpcTypeId ?? 'player', entry.effectiveDamage]] : [],
          ),
      ).toEqual([
        ['player', 48],
        [1, 0],
      ]);
    });
  });

  describe('constructor', () => {
    it('throws when no encounter is provided', () => {
      expect(() => new SimulationEngine({})).toThrow('SimulationEngine requires an explicit encounter');
    });

    it(`initializes at tick ${SIMULATION_START_TICK} with default player position`, () => {
      const state = engine.getState();
      expect(state.currentTick).toBe(SIMULATION_START_TICK);
      expect(state.playerPosition).toEqual(PLAYER_START_POS);
      expect(state.primaryNpcPosition).toEqual(YAMA_START_POS);
      expect(state.isAlive).toBe(true);
      expect(state.failedCondition).toBeNull();
      expect(state.playerHP).toBe(99);
      expect(state.maxHP).toBe(99);
      expect(state.activePrayer).toBeNull();
    });

    it('records initial positions in history', () => {
      const state = engine.getState();
      expect(state.playerHistory.get(SIMULATION_START_TICK)).toEqual(PLAYER_START_POS);
      expect(state.primaryNpcHistory.get(SIMULATION_START_TICK)).toEqual(YAMA_START_POS);
    });

    it('accepts custom start position', () => {
      const customEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
      const state = customEngine.getState();
      expect(state.playerPosition).toEqual([34, 26]);
    });

    it('takes no damage at tick 0 regardless of position', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [10, 10] as Coordinate });
      const state = testEngine.getState();
      expect(state.playerHP).toBe(99);
      expect(state.isAlive).toBe(true);
    });
  });

  describe('encounter input pipeline', () => {
    it('surfaces equipmentSlotClick in ctx.inputs for exactly one tick', () => {
      const encounter = new InputProbeEncounter();
      const testEngine = new SimulationEngine({ encounter, startPos: PLAYER_START_POS });

      testEngine.applyAction({ type: 'equipmentSlotClick', slot: 'weapon' });
      testEngine.advanceTick(PLAYER_START_POS);
      testEngine.advanceTick(PLAYER_START_POS);

      expect(encounter.npcBandInputs).toEqual([['weapon'], []]);
    });

    it('lets an encounter clear protection prayer through ctx.setProtectionPrayer and emits prayer_changed', () => {
      const encounter = new InputProbeEncounter((ctx) => ctx.setProtectionPrayer?.(null));
      const testEngine = new SimulationEngine({ encounter, startPos: PLAYER_START_POS });

      testEngine.queueQuickPrayerToggle([PrayerType.ProtectMagic]);
      testEngine.advanceTick(PLAYER_START_POS);

      expect(testEngine.getState().activePrayer).toBeNull();
      expect(testEngine.getState().quickPrayersActive).toBe(false);
      expect(testEngine.getLastTickEvents()).toContainEqual(
        expect.objectContaining({
          type: 'prayer_changed',
          actorId: 'player',
          from: PrayerType.ProtectMagic,
          to: null,
        }),
      );
    });

    it('keeps the same protection-drop bookkeeping for callbacks and disabling hits', () => {
      const dropVia = (drop: (ctx: EncounterContext) => EnvironmentalDamage[]) => {
        const encounter = new ProtectionDropProbeEncounter(drop);
        const testEngine = new SimulationEngine({ encounter, startPos: PLAYER_START_POS });
        testEngine.queueQuickPrayerToggle([PrayerType.ProtectMagic]);
        testEngine.advanceTick(PLAYER_START_POS);
        expect(testEngine['protectionPrayerActivatedTick']).not.toBeNull();
        encounter.armed = true;
        testEngine.advanceTick(PLAYER_START_POS);
        const state = testEngine.getState();
        return {
          tick: state.currentTick,
          activePrayer: state.activePrayer,
          quickPrayersActive: state.quickPrayersActive,
          drainingPrayers: testEngine['player']().prayerState.activePrayers,
          activationClock: testEngine['protectionPrayerActivatedTick'],
          logged: testEngine
            .getEventLog()
            .filter((event) => event.type === EventType.PRAYER_CHANGE && event.tick === state.currentTick),
          // Event IDs differ only because the hit also emits its hitsplat events.
          emitted: testEngine
            .getLastTickEvents()
            .filter((event) => event.type === 'prayer_changed')
            .map(({ eventId: _eventId, ...event }) => event),
        };
      };

      const callback = dropVia((ctx) => {
        ctx.setProtectionPrayer?.(null);
        return [];
      });
      const disablingHit = dropVia(() => [
        { baseDamage: 0, attackType: 'typeless', source: 'ProbeHit', disablesProtectionPrayersForTicks: 0 },
      ]);

      expect(callback).toEqual({
        tick: callback.tick,
        activePrayer: null,
        quickPrayersActive: false,
        drainingPrayers: [],
        activationClock: null,
        logged: [{ tick: callback.tick, type: EventType.PRAYER_CHANGE, from: PrayerType.ProtectMagic, to: null }],
        emitted: [
          { type: 'prayer_changed', tick: callback.tick, actorId: 'player', from: PrayerType.ProtectMagic, to: null },
        ],
      });
      expect(disablingHit).toEqual(callback);
    });
  });

  describe('golden integration test (3-tick sequence)', () => {
    it('produces correct positions for movement sequence', () => {
      const state0 = engine.getState();
      expect(state0.currentTick).toBe(SIMULATION_START_TICK);
      expect(state0.playerPosition).toEqual(PLAYER_START_POS);
      expect(state0.primaryNpcPosition).toEqual(YAMA_START_POS);
      expect(state0.isAlive).toBe(true);
      expect(state0.playerHistory.get(SIMULATION_START_TICK)).toEqual(PLAYER_START_POS);
      expect(state0.primaryNpcHistory.get(SIMULATION_START_TICK)).toEqual(YAMA_START_POS);

      engine.advanceTick(NEAR_POS_1);
      const state1 = engine.getState();
      expect(state1.currentTick).toBe(SIMULATION_START_TICK + 1);
      expect(state1.playerPosition).toEqual(NEAR_POS_1);
      expect(state1.primaryNpcPosition).toEqual(YAMA_START_POS);
      expect(state1.isAlive).toBe(true);

      engine.advanceTick(NEAR_POS_2);
      const state2 = engine.getState();
      expect(state2.currentTick).toBe(SIMULATION_START_TICK + 2);
      expect(state2.playerPosition).toEqual(NEAR_POS_2);
      expect(state2.primaryNpcPosition).toEqual(YAMA_START_POS);
      expect(state2.isAlive).toBe(true);
    });
  });

  describe('advanceTick', () => {
    it('increments tick number after successful advance', () => {
      engine.advanceTick(NEAR_POS_1);
      expect(engine.getState().currentTick).toBe(SIMULATION_START_TICK + 1);
    });

    it('records positions in history for each tick', () => {
      engine.advanceTick(NEAR_POS_1);
      engine.advanceTick(NEAR_POS_2);

      const state = engine.getState();
      expect(state.playerHistory.get(SIMULATION_START_TICK + 1)).toEqual(NEAR_POS_1);
      expect(state.primaryNpcHistory.get(SIMULATION_START_TICK + 1)).toEqual(YAMA_START_POS);
      expect(state.playerHistory.get(SIMULATION_START_TICK + 2)).toEqual(NEAR_POS_2);
      expect(state.primaryNpcHistory.get(SIMULATION_START_TICK + 2)).toEqual(YAMA_START_POS);
    });

    it('does not advance when dead', () => {
      const badEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [35, 27] as Coordinate });
      badEngine.setMechanicsConfig({
        yamaMageRange: true,
        waves: true,
        fireballs: true,
        infiniteHealth: false,
      });

      for (let i = 0; i < 72; i++) {
        badEngine.advanceTick([34, 26]);
        if (!badEngine.getState().isAlive) break;
      }

      expect(badEngine.getState().isAlive).toBe(false);

      const tickBefore = badEngine.getState().currentTick;
      badEngine.advanceTick([31, 32]);
      expect(badEngine.getState().currentTick).toBe(tickBefore);
    });

    it('can advance indefinitely when mechanics disabled and health infinite', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter() });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        infiniteHealth: true,
      });
      for (let i = 0; i < 100; i++) {
        testEngine.advanceTick([39, 35]);
      }
      expect(testEngine.getState().currentTick).toBe(100);
    });

    it('stays in place when clicking current position', () => {
      engine.advanceTick(PLAYER_START_POS);
      const state = engine.getState();
      expect(state.playerPosition).toEqual(PLAYER_START_POS);
    });

    it('moves toward Yama when clicking its position', () => {
      const startPos: Coordinate = [YAMA_START_POS[0] + 2, YAMA_START_POS[1] - 3];
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos });
      testEngine.advanceTick(YAMA_START_POS);
      const state = testEngine.getState();
      expect(state.playerPosition[1]).toBeGreaterThan(startPos[1]);
    });
  });

  describe('NPC combat target facing', () => {
    it('faces an active combat target after the target moves when the NPC did not move', () => {
      // Given: a stationary NPC in combat with the player, initially facing east.
      const npc = createTrackingNpc([10, 10], 1536);
      const testEngine = new SimulationEngine({ encounter: new TrackingNpcEncounter(npc), startPos: [10, 12] });

      // When: the player moves farther north while the NPC remains stationary.
      testEngine.advanceTick([10, 13]);

      // Then: the NPC tracks the target instead of keeping the stale movement-facing angle.
      expect(testEngine.getState().npcs.find((state) => state.id === npc.id)?.facingAngle).toBe(1024);
    });

    it('faces the start-of-tick player tile when the stationary target crosses to another side', () => {
      // Given: the player starts north of a stationary NPC and will run to its east side.
      const npc = createTrackingNpc([10, 10], 0);
      const testEngine = new SimulationEngine({ encounter: new TrackingNpcEncounter(npc), startPos: [10, 12] });

      // When: the player crosses to the east during the player turn.
      testEngine.advanceTick([12, 10]);

      // Then: the earlier NPC turn faced north toward the player's pre-move tile.
      expect(testEngine.getState().npcs.find((state) => state.id === npc.id)?.facingAngle).toBe(1024);
    });

    it('keeps movement-direction facing when a combat NPC moves and has a target', () => {
      // Given: a combat NPC with a northward player target but an eastward move this tick.
      const npc = createTrackingNpc([10, 10], 0);
      const testEngine = new SimulationEngine({
        encounter: new TrackingNpcEncounter(npc, [[11, 10]]),
        startPos: [10, 14],
      });

      // When: the NPC moves east while still targeting the player.
      testEngine.advanceTick([10, 14]);

      // Then: movement direction wins over target-facing for that tick.
      expect(testEngine.getState().npcs.find((state) => state.id === npc.id)?.facingAngle).toBe(1536);
    });
  });

  describe('player interaction facing — stepping out from under the NPC', () => {
    // 5x5 NPC (footprint [10,10]-[14,14]); player buried on the west edge at [10,12].
    const makeUnderNpcEngine = (attack: boolean): SimulationEngine => {
      const npc: NpcActor = { ...createTrackingNpc([10, 10], 0), size: 5 };
      const testEngine = new SimulationEngine({ encounter: new TrackingNpcEncounter(npc), startPos: [10, 12] });
      if (attack) testEngine.setAttackTarget(npc.id);
      return testEngine;
    };

    it('faces the attacked NPC (its center), not the outward walk direction', () => {
      const testEngine = makeUnderNpcEngine(true);

      testEngine.advanceTick([10, 12]);

      const state = testEngine.getState();
      // Escapes one tile west, clear of the footprint...
      expect(state.playerPosition).toEqual([9, 12]);
      // ...and faces EAST toward the NPC center (1536), not WEST (512, the step-out direction).
      expect(state.playerFacingAngle).toBe(1536);
    });

    it('keeps the walk-out direction when there is no attack interaction', () => {
      const testEngine = makeUnderNpcEngine(false);

      // Manual walk one tile west, off the footprint, with no attack target.
      testEngine.advanceTick([9, 12]);

      const state = testEngine.getState();
      expect(state.playerPosition).toEqual([9, 12]);
      // No interaction -> movement facing wins: WEST (512).
      expect(state.playerFacingAngle).toBe(512);
    });
  });

  // Confirmed in game: a manual cast is a single action. The interaction ends with it, even with an
  // autocast set, so nothing follows it until the next click.
  describe('manual cast ends the interaction', () => {
    const KODAI_WAND = 21006;

    /** A manual Blood Barrage at d=8, clicked as the UI does (the click target is the player's tile), over eight ticks. */
    function castOnceAndWatch(testEngine: SimulationEngine, npc: NpcActor) {
      const player = getWorldState(testEngine).getPlayer();
      if (!player) throw new Error('Expected player');
      const startPos: Coordinate = [...player.position];
      testEngine.applyAction({ type: 'manualCast', targetId: npc.id, spellName: 'Blood Barrage' });
      const ticks = Array.from({ length: 8 }, () => {
        testEngine.advanceTick(startPos);
        return {
          attacks: testEngine
            .getLastTickEvents()
            .flatMap((event) =>
              isCoreEvent(event, 'attack_started') && event.sourceId === player.id ? [event.spellId] : [],
            ),
          distance: player.position[1] - npc.position[1],
          facing: player.facing,
        };
      });
      return { player, ticks };
    }

    function farTarget(): NpcActor {
      return { ...createTrackingNpc([10, 10], 0), role: 'npc', vitals: { hp: 1000, maxHp: 1000 } };
    }

    it('casts once from a blowpipe at d=8 without walking, then neither attacks nor walks to the target', () => {
      const npc = farTarget();
      const testEngine = new SimulationEngine({ encounter: new TrackingNpcEncounter(npc), startPos: [10, 18] });
      holdBlowpipeWithBloodRunes(testEngine);

      const { player, ticks } = castOnceAndWatch(testEngine, npc);

      // Cast on tick 1, from where it was clicked. The blowpipe's 5-tile reach never applies after it.
      expect(ticks.map((tick) => tick.attacks)).toEqual([['Blood Barrage'], [], [], [], [], [], [], []]);
      expect(ticks.every((tick) => tick.distance === 8)).toBe(true);
      expect(player).toMatchObject({
        attackTarget: null,
        attackInteractionActive: false,
        manualCastSpell: null,
        lastAttackTarget: npc.id,
      });
      // What is not the interaction stays: the cast's cooldown and its hit (1 + floor(126 / 30) = 5 ticks).
      expect(testEngine.getState().playerNextAttackTick).toBe(6);
      expect(testEngine.getDamageHistory().filter((entry) => entry.targetId === npc.id)).toMatchObject([{ tick: 6 }]);
      // Turned to the target (south) on the cast tick, and still facing it once the interaction is over.
      expect(ticks.every((tick) => tick.facing === 0)).toBe(true);
    });

    it('makes no autocast after a manual cast, though the staff has one set', () => {
      const npc = farTarget();
      const testEngine = new SimulationEngine({ encounter: new TrackingNpcEncounter(npc), startPos: [10, 18] });
      testEngine.setEquipment({ weapon: KODAI_WAND });
      testEngine.setSelectedAttackStyleIndex(
        getWeaponCategory(KODAI_WAND).styles.findIndex((style) => style.combatStyle === 'Casting'),
      );
      testEngine.setCombatSupplies({
        ...createEmptyCombatSupplies(),
        selectedSpell: 'Blood Blitz',
        spellbook: 'ancient',
        runePouch: { kind: 'standard', slots: [{ id: RUNE.blood }, { id: RUNE.death }, { id: RUNE.soul }] },
      });

      const { player, ticks } = castOnceAndWatch(testEngine, npc);

      // The Blitz autocast (10 tiles, ready on tick 6) never follows the manual Barrage.
      expect(ticks.map((tick) => tick.attacks)).toEqual([['Blood Barrage'], [], [], [], [], [], [], []]);
      expect(player.attackTarget).toBeNull();

      // A fresh click starts a new interaction, and the autocast carries it on.
      testEngine.applyAction({ type: 'attackTarget', targetId: npc.id });
      testEngine.advanceTick(player.position);
      expect(
        testEngine
          .getLastTickEvents()
          .flatMap((event) =>
            isCoreEvent(event, 'attack_started') && event.sourceId === player.id ? [event.spellId] : [],
          ),
      ).toEqual(['Blood Blitz']);
    });
  });

  describe('Red-X: a red-X interaction from underneath suppresses NPC movement', () => {
    // 5x5 NPC at [10,10] (footprint [10,10]-[14,14]) whose moveNpcs always steps its SW
    // corner east to [11,10] and targets the player. Red-X stalls that step only when the
    // player is BOTH under the footprint AND has an active red-X interaction (an attack or a
    // pending Take).
    const makeRedXEngine = (opts: { attack: boolean; under: boolean }): SimulationEngine => {
      const npc: NpcActor = { ...createTrackingNpc([10, 10], 0), size: 5 };
      const testEngine = new SimulationEngine({
        encounter: new TrackingNpcEncounter(npc, [[11, 10]]),
        startPos: opts.under ? [12, 12] : [10, 20],
      });
      if (opts.attack) testEngine.setAttackTarget(npc.id);
      return testEngine;
    };
    const npcPosition = (testEngine: SimulationEngine): Coordinate | undefined =>
      getWorldState(testEngine).getNpc('tracking-npc')?.position;

    it('stalls the NPC when the player is under it AND attacking it', () => {
      const testEngine = makeRedXEngine({ attack: true, under: true });
      testEngine.advanceTick([12, 12]);
      expect(npcPosition(testEngine)).toEqual([10, 10]); // did not move
    });

    it('lets the NPC move when the player is under it but NOT attacking', () => {
      const testEngine = makeRedXEngine({ attack: false, under: true });
      testEngine.advanceTick([12, 12]);
      expect(npcPosition(testEngine)).toEqual([11, 10]); // moved
    });

    it('lets the NPC move when the player is attacking but NOT under it', () => {
      const testEngine = makeRedXEngine({ attack: true, under: false });
      testEngine.advanceTick([10, 20]);
      expect(npcPosition(testEngine)).toEqual([11, 10]); // moved
    });

    // The fixture NPC keeps targeting the player after the Take clears the player's attack.
    const placePile = (testEngine: SimulationEngine, position: Coordinate): string => {
      const world = getWorldState(testEngine);
      const id = world.nextGroundItemId();
      world.groundItems.push({ id, itemId: 385, quantity: 1, position, droppedTick: world.tick });
      return id;
    };
    // Mirrors the UI: a Take clears the attack target before queueing the pickup.
    const take = (testEngine: SimulationEngine, pileId: string): void => {
      testEngine.applyAction({ type: 'attackTarget', targetId: null });
      testEngine.applyAction({ type: 'pickupGroundItem', groundItemId: pileId });
    };

    it('holds the NPC through a pending Take and its pickup tick, then releases it', () => {
      const testEngine = makeRedXEngine({ attack: true, under: true });
      const pileTile: Coordinate = [14, 12];
      const pileId = placePile(testEngine, pileTile);

      take(testEngine, pileId);
      testEngine.advanceTick(pileTile);
      expect(npcPosition(testEngine)).toEqual([10, 10]);
      expect(testEngine.getState().playerPosition).toEqual(pileTile);
      expect(testEngine.getState().groundItems).toHaveLength(1);

      // Pickup resolves after the NPC band, so the NPC is still held on this tick.
      testEngine.advanceTick(pileTile);
      expect(testEngine.getState().groundItems).toHaveLength(0);
      expect(npcPosition(testEngine)).toEqual([10, 10]);

      testEngine.advanceTick(pileTile);
      expect(npcPosition(testEngine)).toEqual([11, 10]);
    });

    it('releases the NPC on the tick a walk click replaces a pending Take', () => {
      const testEngine = makeRedXEngine({ attack: true, under: true });
      const pileTile: Coordinate = [12, 30];
      const pileId = placePile(testEngine, pileTile);

      take(testEngine, pileId);
      testEngine.advanceTick(pileTile);
      expect(npcPosition(testEngine)).toEqual([10, 10]);
      // Still under the footprint after this tick's step, so only the walk click can release it.
      expect(isUnderNpc(testEngine.getState().playerPosition, [10, 10], 5)).toBe(true);

      testEngine.applyAction({ type: 'attackTarget', targetId: null });
      testEngine.advanceTick([12, 12]);
      expect(npcPosition(testEngine)).toEqual([11, 10]);
    });
  });

  describe('Yama stationary behavior', () => {
    it('Yama stays at start position throughout the fight', () => {
      engine.advanceTick(NEAR_POS_1);
      const state = engine.getState();
      expect(state.primaryNpcPosition).toEqual(YAMA_START_POS);
    });

    it('Yama position never changes across multiple ticks', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
      testEngine.advanceTick(NEAR_POS_1);
      testEngine.advanceTick(NEAR_POS_2);
      testEngine.advanceTick(FAR_SAFE_POS);
      const state = testEngine.getState();
      expect(state.primaryNpcPosition).toEqual(YAMA_START_POS);
      expect(state.primaryNpcHistory.get(SIMULATION_START_TICK + 1)).toEqual(YAMA_START_POS);
      expect(state.primaryNpcHistory.get(SIMULATION_START_TICK + 2)).toEqual(YAMA_START_POS);
      expect(state.primaryNpcHistory.get(SIMULATION_START_TICK + 3)).toEqual(YAMA_START_POS);
    });
  });

  describe('Yama calculation and windup lifecycle', () => {
    function fixture(style: 'melee' | 'magic' | 'range') {
      const position: Coordinate = style === 'melee' ? [31, 33] : [31, 37];
      const random = vi.fn(() => 0.999);
      const simulation = new SimulationEngine({
        encounter: new YamaEncounter(undefined, 1),
        startPos: position,
        combatRandom: random,
      });
      simulation.setMechanicsConfig({
        yamaMelee: true,
        yamaMageRange: true,
        fireballs: false,
        waves: false,
        voidFlares: false,
      });
      simulation.executeEncounterCommand(
        style === 'range' ? YAMA_SET_OPENING_RANGE_COMMAND : YAMA_SET_OPENING_MAGIC_COMMAND,
      );
      simulation.setInventory([{ id: 13441 }]);
      const world = simulation['worldState'];
      const player = world.getPlayer();
      const yama = world.getNpc('yama');
      if (!player || !yama) throw new TypeError('Expected Yama and player');
      const actorState = getYamaState(yama);
      if (!actorState) throw new TypeError('Expected Yama state');
      const cueTick = style === 'melee' ? 5 : 12;
      while (world.tick < cueTick - 1) simulation.advanceTick(position);
      player.vitals.hp = 10;
      player.stats.hitpoints.current = 10;
      return { simulation, world, player, yama, actorState, position, random, cueTick };
    }

    it.each([true, false])('uses the melee swing HP cap when eating at impact is %s', (eat) => {
      const { simulation, world, position, cueTick } = fixture('melee');
      simulation.advanceTick(position);
      expect(world.pendingHits).toContainEqual(
        expect.objectContaining({ launchTick: 5, impactTick: 6, rolledDamage: 46, damageCapAtCalculation: 10 }),
      );
      if (eat) simulation.queueItemAction(0);

      simulation.advanceTick(position);

      expect(simulation.getState()).toMatchObject({ playerHP: eat ? 22 : 0, isAlive: eat });
      expect(simulation.getState().damageHistory).toContainEqual(
        expect.objectContaining({ tick: cueTick + 1, baseDamage: 46, effectiveDamage: 10 }),
      );
    });

    it.each(['magic', 'range'] as const)('does not commit %s damage or draw damage RNG at the windup cue', (style) => {
      const { simulation, world, position, random } = fixture(style);
      random.mockClear();

      simulation.advanceTick(position);

      expect(world.pendingHits).toHaveLength(0);
      expect(random).not.toHaveBeenCalled();
      expect(simulation.getLastTickEvents()).toContainEqual(
        expect.objectContaining({ type: 'attack_started', tick: 12, style, impactDelayTicks: 3 }),
      );
    });

    it.each([
      'magic',
      'range',
    ] as const)('calculates %s against healed release-time HP with no tick-eating window', (style) => {
      const { simulation, position } = fixture(style);
      while (simulation.getState().currentTick < 14) simulation.advanceTick(position);
      simulation.queueItemAction(0);

      simulation.advanceTick(position);

      expect(simulation.getState()).toMatchObject({ playerHP: 0, isAlive: false });
      expect(simulation.getState().damageHistory).toContainEqual(
        expect.objectContaining({ tick: 15, baseDamage: 46, effectiveDamage: 32 }),
      );
    });

    it.each([
      'magic',
      'range',
    ] as const)('uses release-time %s accuracy after changing defensive equipment', (style) => {
      const { simulation, player, position } = fixture(style);
      simulation.advanceTick(position);
      player.equipmentStats.defenceMagic = 1_000_000;
      player.equipmentStats.defenceRanged = 1_000_000;
      while (simulation.getState().currentTick < 14) simulation.advanceTick(position);

      simulation.advanceTick(position);

      expect(simulation.getState()).toMatchObject({ playerHP: 10, isAlive: true });
      expect(simulation.getLastTickEvents()).toContainEqual(
        expect.objectContaining({ type: 'hit_applied', accurate: false, damage: 0 }),
      );
    });

    it.each([
      'magic',
      'range',
    ] as const)('can hit with %s after high cue-time defence is removed before release', (style) => {
      const { simulation, player, position } = fixture(style);
      player.equipmentStats.defenceMagic = 1_000_000;
      player.equipmentStats.defenceRanged = 1_000_000;
      simulation.advanceTick(position);
      player.equipmentStats.defenceMagic = 0;
      player.equipmentStats.defenceRanged = 0;
      while (simulation.getState().currentTick < 14) simulation.advanceTick(position);

      simulation.advanceTick(position);

      expect(simulation.getState()).toMatchObject({ playerHP: 0, isAlive: false });
      expect(simulation.getLastTickEvents()).toContainEqual(
        expect.objectContaining({ type: 'hit_applied', accurate: true, damage: 10 }),
      );
    });

    it.each([
      { style: 'melee', prayer: PrayerType.ProtectMelee, impactTick: 6, expected: 0 },
      { style: 'magic', prayer: PrayerType.ProtectMagic, impactTick: 15, expected: 7 },
      { style: 'range', prayer: PrayerType.ProtectRange, impactTick: 15, expected: 7 },
    ] as const)('checks $style prayer on its calculation tick when switching on at impact', ({
      style,
      prayer,
      impactTick,
      expected,
    }) => {
      const { simulation, position } = fixture(style);
      while (simulation.getState().currentTick < impactTick - 1) simulation.advanceTick(position);
      simulation.queueProtectionPrayer(prayer);

      simulation.advanceTick(position);

      expect(simulation.getState().playerHP).toBe(expected);
      expect(simulation.getLastTickEvents()).toContainEqual(
        expect.objectContaining({ type: 'hit_applied', prayedCorrectly: style !== 'melee' }),
      );
    });

    it.each([
      'magic',
      'range',
    ] as const)('emits exactly one %s cue at tick 12 and keeps release at tick 15', (style) => {
      const { simulation, player, yama, position } = fixture(style);
      player.vitals.hp = 99;
      player.stats.hitpoints.current = 99;
      const events = [];
      const snapshots = [];

      while (simulation.getState().currentTick < 15) {
        simulation.advanceTick(position);
        events.push(...simulation.getLastTickEvents());
        snapshots.push({
          tick: simulation.getState().currentTick,
          kind: getYamaState(yama)?.latestAttackKind,
          attackTick: getYamaState(yama)?.latestAttackTick,
        });
      }

      expect(events.filter((event) => event.type === 'attack_started' && event.sourceId === 'yama')).toMatchObject([
        { tick: 12, style, impactDelayTicks: 3 },
      ]);
      expect(events.filter((event) => event.type === 'hit_applied')).toMatchObject([{ tick: 15, damage: 46 }]);
      expect(snapshots).toEqual([
        { tick: 12, kind: style === 'magic' ? 'magic_fire' : 'range_shadow', attackTick: 12 },
        { tick: 13, kind: null, attackTick: null },
        { tick: 14, kind: null, attackTick: null },
        { tick: 15, kind: null, attackTick: null },
      ]);
      expect(yama.combat.lastAttackTick).toBe(12);
    });

    it.each([
      { style: 'melee', prayer: PrayerType.ProtectMelee, impactTick: 6, expected: 0 },
      { style: 'magic', prayer: PrayerType.ProtectMagic, impactTick: 15, expected: 0 },
      { style: 'range', prayer: PrayerType.ProtectRange, impactTick: 15, expected: 0 },
    ] as const)('keeps the correct $style prayer check when switching away before impact', ({
      style,
      prayer,
      impactTick,
      expected,
    }) => {
      const { simulation, position } = fixture(style);
      simulation.queueProtectionPrayer(prayer);
      simulation.advanceTick(position);
      simulation.queueProtectionPrayer(null);

      while (simulation.getState().currentTick < impactTick) simulation.advanceTick(position);

      expect(simulation.getState().playerHP).toBe(expected);
      expect(simulation.getLastTickEvents()).toContainEqual(
        expect.objectContaining({ type: 'hit_applied', prayedCorrectly: style === 'melee' }),
      );
    });

    it.each(['magic', 'range'] as const)('keeps a zero %s release roll at zero and draws damage only once', (style) => {
      const { simulation, position, random } = fixture(style);
      random.mockReturnValue(0);
      random.mockClear();

      while (simulation.getState().currentTick < 15) simulation.advanceTick(position);

      expect(simulation.getState()).toMatchObject({ playerHP: 10, isAlive: true });
      expect(random).toHaveBeenCalledTimes(1);
      expect(simulation.getLastTickEvents()).toContainEqual(
        expect.objectContaining({ type: 'hit_applied', accurate: true, damage: 0 }),
      );
    });

    it('clears a windup when Yama dies before release', () => {
      const { simulation, world, yama, actorState, position } = fixture('magic');
      simulation.advanceTick(position);
      enqueueEnginePendingHit(simulation, {
        sourceId: 'player',
        targetId: yama.id,
        style: 'melee',
        attackKind: 'melee_crush',
        launchTick: 12,
        impactTick: 13,
        rolledDamage: yama.vitals.hp,
        accuracySucceeded: true,
      });

      simulation.advanceTick(position);

      expect(actorState).toMatchObject({ windup: null, queuedAttack: null });
      expect(world.pendingHits).toHaveLength(0);
    });

    it('clears a windup when the player dies before release', () => {
      const { simulation, actorState, position } = fixture('magic');
      simulation.advanceTick(position);
      enqueueEnginePendingHit(simulation, {
        sourceId: 'yama',
        targetId: 'player',
        style: 'melee',
        attackKind: 'melee_crush',
        launchTick: 12,
        impactTick: 13,
        rolledDamage: 10,
        accuracySucceeded: true,
      });

      simulation.advanceTick(position);

      expect(simulation.getState().isAlive).toBe(false);
      expect(actorState).toMatchObject({ windup: null, queuedAttack: null });
    });

    it('starts a reset run without a pending windup or its old release', () => {
      const { simulation, position } = fixture('magic');
      simulation.advanceTick(position);

      simulation.reset(position);

      const yama = simulation['worldState'].getNpc('yama');
      if (!yama) throw new TypeError('Expected reset Yama');
      expect(getYamaState(yama)).toMatchObject({ windup: null, queuedAttack: null });
      for (let tick = 0; tick < 3; tick++) simulation.advanceTick(position);
      expect(simulation.getState().damageHistory).toHaveLength(0);
    });
  });

  describe('combat mechanics', () => {
    it('takes damage from YamaAttack at tick 15 when outside melee range', () => {
      // Pin the [0,40] NPC roll away from zero so this test covers attack timing,
      // not the legitimate zero-damage hit case.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
        testEngine.setMechanicsConfig({
          yamaMageRange: true,
          waves: false,
          fireballs: false,
          infiniteHealth: false,
        });
        while (testEngine.getState().currentTick < 15) {
          testEngine.advanceTick([34, 26]);
        }
        expect(testEngine.getState().currentTick).toBe(15);

        const state = testEngine.getState();
        expect(state.playerHP).toBeLessThan(99);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('takes reduced damage with correct prayer for magic attack', () => {
      // NPC rolls can remain 0; pin [0,40] away from the 1/41 zero-roll flake.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
        testEngine.executeEncounterCommand(YAMA_SET_OPENING_MAGIC_COMMAND);
        testEngine.setMechanicsConfig({
          yamaMageRange: true,
          waves: false,
          fireballs: false,
          infiniteHealth: false,
        });
        testEngine.queueProtectionPrayer(PrayerType.ProtectMagic);

        for (let tick = 0; tick < 20; tick++) {
          testEngine.advanceTick([34, 26]);
        }

        const state = testEngine.getState();
        expect(state.playerHP).toBeLessThan(99);
        expect(state.playerHP).toBeGreaterThan(55);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('takes reduced damage with correct prayer for range attack', () => {
      // Same [0,40] first-hit roll: wrong-prayer damage should be tested without RNG flake.
      const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
        testEngine.executeEncounterCommand(YAMA_SET_OPENING_RANGE_COMMAND);
        testEngine.setMechanicsConfig({
          yamaMageRange: true,
          waves: false,
          fireballs: false,
          infiniteHealth: false,
        });
        testEngine.queueProtectionPrayer(PrayerType.ProtectRange);

        for (let tick = 0; tick < 15; tick++) {
          testEngine.advanceTick([34, 26]);
        }

        const state = testEngine.getState();
        expect(state.playerHP).toBeLessThan(99);
        expect(state.playerHP).toBeGreaterThan(55);
      } finally {
        randomSpy.mockRestore();
      }
    });

    it('takes Yama attack damage regardless of distance', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [35, 28] as Coordinate });

      for (let tick = 0; tick < 15; tick++) {
        testEngine.advanceTick([35, 28]);
      }

      const state = testEngine.getState();
      const yamaAttacks = state.damageHistory.filter((d) => d.source === 'YamaAttack');
      expect(yamaAttacks.length).toBeGreaterThan(0);
    });

    it('dies when HP reaches 0 from Yama attacks', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
      testEngine.setMechanicsConfig({
        yamaMageRange: true,
        waves: false,
        fireballs: false,
        infiniteHealth: false,
      });

      for (let i = 0; i < 200; i++) {
        testEngine.advanceTick([34, 26]);
        if (!testEngine.getState().isAlive) break;
      }

      const finalState = testEngine.getState();
      expect(finalState.isAlive).toBe(false);
      expect(finalState.playerHP).toBe(0);
    });

    it('takes fireball damage when standing on fireball at impact', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: true,
        infiniteHealth: false,
      });
      for (let i = 0; i < 15; i++) {
        testEngine.advanceTick([34, 26]);
      }

      const state = testEngine.getState();
      expect(state.playerHP).toBeLessThan(99);
    });

    it('records fireball damage in damage history', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: true,
        infiniteHealth: false,
      });
      for (let i = 0; i < 15; i++) {
        testEngine.advanceTick([34, 26]);
      }

      const state = testEngine.getState();
      const fireballDamage = state.damageHistory.find((d) => d.source === 'Fireball');
      expect(fireballDamage).toBeDefined();
      // "up to 20 damage per explosion" is a roll, so assert the band rather than a value.
      expect(fireballDamage?.baseDamage).toBeGreaterThanOrEqual(0);
      expect(fireballDamage?.baseDamage).toBeLessThanOrEqual(20);
      expect(fireballDamage?.attackType).toBe('typeless');
      expect(fireballDamage?.prayedCorrectly).toBeNull();
    });

    it('fires fireballs across multiple cycles', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: true,
        infiniteHealth: true,
      });
      while (testEngine.getState().currentTick < 150) {
        testEngine.advanceTick([34, 26]);
      }
      const state = testEngine.getState();
      const fireballDamage = state.damageHistory.filter((d) => d.source === 'Fireball');
      expect(fireballDamage.length).toBeGreaterThan(1);
    });

    it('cycles attack timing correctly across multiple cycles', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
      testEngine.executeEncounterCommand(YAMA_SET_OPENING_MAGIC_COMMAND);
      testEngine.setMechanicsConfig({
        yamaMageRange: true,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });

      while (testEngine.getState().currentTick < 85 && testEngine.canAdvance()) {
        testEngine.advanceTick([34, 26]);
      }

      const state = testEngine.getState();
      expect(state.currentTick).toBe(85);
      // Beat 81 (4 + 7 * 11) queues the swing for 82; its 3-tick
      // range/mage projectile lands on 85.
      const rangedImpact = state.damageHistory.find((d) => d.tick === 85);
      expect(rangedImpact).toBeDefined();
      expect(rangedImpact?.attackType).toBe('range');
    });
  });

  describe('reset', () => {
    it(`resets to tick ${SIMULATION_START_TICK} and full HP`, () => {
      engine.advanceTick(NEAR_POS_1);
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
      testEngine.reset();
      const state = testEngine.getState();
      expect(state.currentTick).toBe(SIMULATION_START_TICK);
      expect(state.playerHP).toBe(99);
      expect(state.isAlive).toBe(true);
    });

    it('clears history and starts fresh', () => {
      engine.advanceTick(NEAR_POS_1);
      engine.reset();
      const state = engine.getState();
      expect(state.playerHistory.size).toBe(1);
      expect(state.primaryNpcHistory.size).toBe(1);
      expect(state.playerHistory.get(SIMULATION_START_TICK)).toEqual(state.playerPosition);
    });

    it('resets active prayer', () => {
      engine.queueProtectionPrayer(PrayerType.ProtectMagic);
      engine.advanceTick([34, 26]);
      expect(engine.getState().activePrayer).toBe(PrayerType.ProtectMagic);
      engine.reset();
      expect(engine.getState().activePrayer).toBeNull();
    });

    it('restarts hit sequencing and NPC registration order, so a rerun queues identically', () => {
      const testEngine = new SimulationEngine({
        encounter: new FirstTickSpawnEncounter(createTrackingNpc([10, 10], 0)),
        startPos: [10, 12],
      });
      const run = () => {
        const queued = [5, 6].map(
          (impactTick) =>
            enqueueEnginePendingHit(testEngine, {
              sourceId: 'player',
              targetId: 'tracking-npc',
              style: 'magic',
              attackKind: 'magic_fire',
              launchTick: 0,
              impactTick,
              rolledDamage: 1,
              accuracySucceeded: true,
            }).enqueueSequence,
        );
        testEngine.advanceTick([10, 12]);
        const world = getWorldState(testEngine);
        return {
          queued,
          stillQueued: world.pendingHits.map((hit) => hit.enqueueSequence),
          npcs: world.getNpcs().map((npc) => [npc.id, npc.processingOrder]),
        };
      };

      const first = run();
      testEngine.advanceTick([10, 12]);
      testEngine.reset([10, 12]);

      expect(getWorldState(testEngine).pendingHits).toEqual([]);
      expect(first).toEqual({
        queued: [0, 1],
        stillQueued: [0, 1],
        npcs: [
          ['tracking-npc', 0],
          ['spawned-npc', 1],
        ],
      });
      expect(run()).toEqual(first);
    });
  });

  describe('canAdvance', () => {
    it('returns true when alive and tick < 72', () => {
      expect(engine.canAdvance()).toBe(true);
    });

    it('returns false when dead', () => {
      const badEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [35, 27] as Coordinate });
      badEngine.setMechanicsConfig({
        yamaMageRange: true,
        waves: true,
        fireballs: true,
        infiniteHealth: false,
      });
      for (let i = 0; i < 50; i++) {
        badEngine.advanceTick([35, 27]);
        if (!badEngine.getState().isAlive) break;
      }
      expect(badEngine.canAdvance()).toBe(false);
    });

    it('returns false when the shared encounter outcome is victory', () => {
      // Given: a living player whose encounter publishes a terminal shared outcome.
      const encounter = new TrackingNpcEncounter(createTrackingNpc([10, 10], 0));
      const testEngine = new SimulationEngine({ encounter, startPos: [10, 11] });
      encounter.outcome = {
        phase: 'victory',
        decisiveTick: 1,
        completionTick: 10,
        primaryActorId: encounter.createNpcs()[0]?.id ?? 'tracking-npc',
        completionActorIds: ['tracking-npc'],
      };

      // When: the engine evaluates whether another live tick may run.
      const canAdvance = testEngine.canAdvance();

      // Then: shared victory is the lifecycle authority that closes advancement.
      expect(canAdvance).toBe(false);
    });
  });

  describe('getState', () => {
    it('returns complete state snapshot', () => {
      const state = engine.getState();
      expect(state).toHaveProperty('currentTick');
      expect(state).toHaveProperty('playerPosition');
      expect(state).toHaveProperty('primaryNpcPosition');
      expect(state).toHaveProperty('isAlive');
      expect(state).toHaveProperty('failedCondition');
      expect(state).toHaveProperty('playerHistory');
      expect(state).toHaveProperty('primaryNpcHistory');
      expect(state).toHaveProperty('playerHP');
      expect(state).toHaveProperty('maxHP');
      expect(state).toHaveProperty('activePrayer');
    });
  });

  describe('item healing interactions', () => {
    it('does not drop angler overheal when eating moonlight antelope (immediate or delayed heal)', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter() });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        infiniteHealth: true,
      });

      const inventory = testEngine.getState().inventory.map((slot) => (slot ? { ...slot } : null));
      inventory[0] = { id: 13441 }; // Anglerfish
      inventory[1] = { id: 29143 }; // Cooked moonlight antelope
      testEngine.setInventory(inventory);

      // Tick 0: eat anglerfish -> should overheal to 121 at level 99
      testEngine.queueItemAction(0);
      testEngine.advanceTick(PLAYER_START_POS);
      expect(testEngine.getState().playerHP).toBe(121);

      // Tick 1: eat moonlight antelope -> should not reduce overhealed HP
      testEngine.queueItemAction(1);
      testEngine.advanceTick(PLAYER_START_POS);
      expect(testEngine.getState().playerHP).toBe(121);

      // Delayed moonlight heal lands after 7 ticks and must not reduce overheal either
      for (let i = 0; i < 7; i++) {
        testEngine.advanceTick(PLAYER_START_POS);
      }
      expect(testEngine.getState().playerHP).toBe(121);
    });

    it('anglerfish overheals to 121 at 99 HP with default mechanics (no infiniteHealth override)', () => {
      // Reproduce the exact user scenario: default P3, no special config,
      // disable only combat to isolate the heal effect.
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        yamaMelee: false,
        waves: false,
        fireballs: false,
        infiniteHealth: false,
      });

      const inventory = testEngine.getState().inventory.map((slot) => (slot ? { ...slot } : null));
      inventory[0] = { id: 13441 }; // Anglerfish
      testEngine.setInventory(inventory);

      testEngine.queueItemAction(0);
      testEngine.advanceTick(PLAYER_START_POS);

      expect(testEngine.getState().playerHP).toBe(121);
    });
  });

  describe('Saturated Heart integration', () => {
    beforeEach(() => {
      engine.setMechanicsConfig({ infiniteHealth: true });
    });

    it('should apply heart boost when item action is queued and tick advances', () => {
      const inventory = [
        { id: 27641 },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
      engine.setInventory(inventory);

      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);

      const state = engine.getState();
      expect(state.stats.magic.current).toBe(112); // 99 + 13
      expect(state.combatTimers.statDecayLocks.magic?.source).toBe('saturated_heart');
      expect(state.combatTimers.statDecayLocks.magic?.ticksRemaining).toBeGreaterThan(0);
    });

    it('should not consume the heart item after use', () => {
      const inventory = [
        { id: 27641 },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
      engine.setInventory(inventory);

      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);

      const state = engine.getState();
      expect(state.inventory[0]).toEqual({ id: 27641 });
    });

    it('should not allow re-use while active', () => {
      const inventory = [
        { id: 27641 },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
      engine.setInventory(inventory);

      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);
      const firstState = engine.getState();
      const firstActive = firstState.combatTimers.statDecayLocks.magic?.ticksRemaining ?? 0;

      // Advance a few ticks to get past potion cooldown
      for (let i = 0; i < 5; i++) {
        engine.advanceTick(engine.getState().playerPosition);
      }

      // Try second use (should fail - still active)
      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);

      // Should still have original timer counting down, not reset to 500
      const state = engine.getState();
      expect(state.combatTimers.statDecayLocks.magic?.ticksRemaining).toBeLessThan(firstActive);
    });

    it('should reset magic to base when timer expires', () => {
      const inventory = [
        { id: 27641 },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
      engine.setInventory(inventory);

      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);

      expect(engine.getState().stats.magic.current).toBe(112);

      // Advance 500+ ticks to expire the heart
      for (let i = 0; i < 501; i++) {
        engine.advanceTick(engine.getState().playerPosition);
      }

      const state = engine.getState();
      expect(state.stats.magic.current).toBe(99);
      expect(state.combatTimers.statDecayLocks.magic).toBeUndefined();
    });

    it('holds the boost without decay, then expires 500 ticks on from the drink tick with one event', () => {
      engine.setInventory([{ id: 27641 }]);
      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);
      const drinkTick = engine.getState().currentTick;

      const expiryTicks: number[] = [];
      let magicBeforeExpiry: number | null = null;
      for (let i = 0; i < 600; i++) {
        const magicBefore = engine.getState().stats.magic.current;
        engine.advanceTick(engine.getState().playerPosition);
        const expired = engine
          .getLastTickEvents()
          .some((event) => event.type === 'status_effect_expired' && event.effect === 'saturated_heart');
        if (expired) {
          expiryTicks.push(engine.getState().currentTick);
          magicBeforeExpiry ??= magicBefore;
        }
      }

      // The drink tick counts as the first of the 500, exactly as the heart's own countdown did.
      expect(expiryTicks).toEqual([drinkTick + 499]);
      // Two natural-decay boundaries passed while locked, and neither took a level.
      expect(magicBeforeExpiry).toBe(112);
      expect(engine.getState().stats.magic.current).toBe(99);
    });

    it('keeps Magic where a drain left it when the lock expires below base', () => {
      engine.setInventory([{ id: 27641 }]);
      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);
      const drinkTick = engine.getState().currentTick;
      // A brew-style drain lands mid-lock; the lock never stops the drain or the recovery.
      engine.stats.magic.current = 60;

      while (engine.getState().currentTick < drinkTick + 499) {
        engine.advanceTick(engine.getState().playerPosition);
      }

      expect(engine.combatTimers.statDecayLocks.magic).toBeUndefined();
      // Recovered +1 at each of the natural boundaries it crossed (ticks 101, 201, 301 and 401).
      expect(engine.getState().stats.magic.current).toBe(64);
    });

    it('can be used again once its cooldown has run out', () => {
      engine.setInventory([{ id: 27641 }]);
      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);
      const drinkTick = engine.getState().currentTick;
      while (engine.getState().currentTick < drinkTick + 499) {
        engine.advanceTick(engine.getState().playerPosition);
      }
      expect(engine.combatTimers.saturatedHeartCooldownTicks).toBe(0);

      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);

      expect(engine.getState().stats.magic.current).toBe(112);
      expect(engine.combatTimers.statDecayLocks.magic?.ticksRemaining).toBe(499);
    });

    it('emits status_effect_expired when saturated heart ends', () => {
      const inventory = [
        { id: 27641 },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
      engine.setInventory(inventory);

      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);

      let expired = false;
      for (let i = 0; i < 600; i++) {
        engine.advanceTick(engine.getState().playerPosition);
        expired = engine
          .getLastTickEvents()
          .some((event) => event.type === 'status_effect_expired' && event.effect === 'saturated_heart');
        if (expired) break;
      }

      expect(expired).toBe(true);
    });
  });

  describe('Mark of Darkness expiry event', () => {
    it('emits status_effect_expired when mark of darkness ends', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });

      // The engine gates the cast on the spell's runes; this bare harness carries none otherwise.
      testEngine.setInventory(parseInventoryFromSetup([{ id: RUNE.cosmic }, { id: RUNE.soul }]));
      testEngine.castMarkOfDarkness();

      const playerPos = testEngine.getState().playerPosition;
      let expired = false;
      for (let i = 0; i < 2000; i++) {
        testEngine.advanceTick(playerPos);
        expired = testEngine
          .getLastTickEvents()
          .some((event) => event.type === 'status_effect_expired' && event.effect === 'mark_of_darkness');
        if (expired) break;
      }

      expect(expired).toBe(true);
    });
  });

  describe('getNpcHistory', () => {
    it('stores NPC history on the actor and getNpcHistory returns actor.history', () => {
      const worldState = getWorldState(engine);
      const yama = worldState.getNpc('yama');
      expect(yama).not.toBeNull();
      if (yama === null) {
        throw new Error('Expected yama NPC to exist');
      }

      const actorHistory = Reflect.get(yama, 'history') as Map<number, Coordinate>;
      expect(actorHistory).toBeInstanceOf(Map);
      expect(actorHistory.get(SIMULATION_START_TICK)).toEqual(YAMA_START_POS);

      const engineHistory = engine.getNpcHistory('yama');
      expect(engineHistory).toBe(actorHistory);
    });

    it('should return history for the requested npcId, not a hardcoded single map', () => {
      const state = engine.getState();
      expect(state.primaryNpcHistory.get(SIMULATION_START_TICK)).toEqual(YAMA_START_POS);

      const fakeHistory = engine.getNpcHistory('nonexistent_npc_12345');
      expect(fakeHistory.size).toBe(0);
    });

    it('should track NPC position history per-NPC after advancing ticks', () => {
      engine.advanceTick(engine.getState().playerPosition);
      engine.advanceTick(engine.getState().playerPosition);

      const worldState = getWorldState(engine);
      const yama = worldState.getNpc('yama');
      expect(yama).not.toBeNull();
      if (yama === null) {
        throw new Error('Expected yama NPC to exist');
      }
      const actorHistory = Reflect.get(yama, 'history') as Map<number, Coordinate>;

      const yamaHistory = engine.getNpcHistory('yama');
      expect(yamaHistory).toBe(actorHistory);
      expect(yamaHistory.size).toBeGreaterThanOrEqual(2);
      expect(yamaHistory.get(SIMULATION_START_TICK)).toEqual(YAMA_START_POS);
      expect(yamaHistory.get(SIMULATION_START_TICK + 1)).toEqual(YAMA_START_POS);
      expect(yamaHistory.get(SIMULATION_START_TICK + 2)).toEqual(YAMA_START_POS);
    });

    it('does not keep an external npcHistories map on SimulationEngine', () => {
      expect(Object.getOwnPropertyNames(engine)).not.toContain('npcHistories');
    });
  });

  describe('processAreaEffects fireball tick', () => {
    it('emits wave_activated game events when waves mechanic is enabled', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 37] as Coordinate });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: true,
        fireballs: false,
        infiniteHealth: true,
      });

      let waveEvent: ReturnType<SimulationEngine['getLastTickEvents']>[number] | undefined;
      // Shadow waves start ~tick 30 of the encounter (startDelay), so advance past that.
      for (let i = 0; i < 40; i++) {
        testEngine.advanceTick([31, 37]);
        waveEvent = testEngine.getLastTickEvents().find((event) => event.type === 'wave_activated');
        if (waveEvent) break;
      }

      expect(waveEvent).toBeDefined();
      expect(waveEvent && Array.isArray((waveEvent as Record<string, unknown>).wavePositions)).toBe(true);
      expect(((waveEvent as Record<string, unknown>).wavePositions as unknown[]).length).toBeGreaterThan(0);
      expect(Array.isArray((waveEvent as Record<string, unknown>).position)).toBe(true);
    });

    it('should emit fireball_spawned GameEvent at the same tick as FIREBALL_SPAWN SimulationEvent', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: true,
        infiniteHealth: true,
      });

      const firstFireballStartTick = getFireballBurstCycleTicks(DEFAULT_YAMA_ATTACK_PATTERN)[0];
      // The position is captured a tick early (startTick - 1) but the event is held back to
      // startTick, because the audio layer measures the barrage's capture delays from the
      // flush it arrives on and not from the tick field. Delivering it on the capture tick
      // plays every fireball sound, the crash included, a tick early.
      while (testEngine.getState().currentTick < firstFireballStartTick - 1) {
        testEngine.advanceTick([34, 26]);
      }
      expect(testEngine.getLastTickEvents().some((event) => event.type === 'fireball_spawned')).toBe(false);

      testEngine.advanceTick([34, 26]);
      expect(testEngine.getState().currentTick).toBe(firstFireballStartTick);

      const spawnEvent = testEngine.getLastTickEvents().find((event) => event.type === 'fireball_spawned');
      expect(spawnEvent).toBeDefined();

      const simulationSpawnEvent = testEngine.getEventLog().find((event) => event.type === 'FIREBALL_SPAWN');
      expect(simulationSpawnEvent).toBeDefined();

      expect(spawnEvent?.tick).toBe(simulationSpawnEvent?.tick);
      expect(spawnEvent?.tick).toBe(firstFireballStartTick);
    });

    it('emits fireball_impact GameEvent on the impact tick (startTick + 3), exactly once per fireball', () => {
      // Tutorials key their progress beats off fireball_impact — it marks the
      // tick the crash visually lands and the dodge resolves. The event must
      // fire on the impact tick of the very first fireball in the first burst,
      // and only one of the burst's three fireballs is at impact phase on that
      // tick (fireballs are spaced 3 ticks apart within a burst).
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: true,
        infiniteHealth: true,
      });

      const firstFireballStartTick = getFireballBurstCycleTicks(DEFAULT_YAMA_ATTACK_PATTERN)[0];
      // Impact phase is reached 3 ticks after startTick (see getFireballFallProgress).
      const impactTick = firstFireballStartTick + 3;
      while (testEngine.getState().currentTick < impactTick) {
        testEngine.advanceTick([34, 26]);
      }

      const impactEvents = testEngine.getLastTickEvents().filter((event) => event.type === 'fireball_impact');
      expect(impactEvents).toHaveLength(1);
      expect(impactEvents[0].tick).toBe(impactTick);
      expect(impactEvents[0]).toMatchObject({ type: 'fireball_impact' });
    });

    it('emits fireball hit_applied events with typeless attackKind', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [34, 26] as Coordinate });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: true,
        infiniteHealth: false,
      });

      let fireballHitEvent = null as ReturnType<SimulationEngine['getLastTickEvents']>[number] | null;
      for (let i = 0; i < 30; i++) {
        testEngine.advanceTick([34, 26]);
        const state = testEngine.getState();
        const tookFireballDamageThisTick = state.damageHistory.some(
          (entry) => entry.source === 'Fireball' && entry.tick === state.currentTick,
        );
        if (!tookFireballDamageThisTick) {
          continue;
        }

        fireballHitEvent = testEngine.getLastTickEvents().find((event) => event.type === 'hit_applied') ?? null;
        break;
      }

      expect(fireballHitEvent).toBeDefined();
      expect(fireballHitEvent).not.toBeNull();
      expect(fireballHitEvent).toMatchObject({ type: 'hit_applied', attackKind: 'typeless', prayedCorrectly: null });
    });

    it('each fireball set captures the player position independently when player moves', () => {
      const testEngine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 37] as Coordinate });
      testEngine.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: true,
        infiniteHealth: true,
      });

      const firstFireballStartTick = getFireballBurstCycleTicks(DEFAULT_YAMA_ATTACK_PATTERN)[0];
      const captureTicks = [firstFireballStartTick - 1, firstFireballStartTick + 2, firstFireballStartTick + 5];

      const captureAtTick = (captureTick: number, clickTarget: Coordinate): Coordinate => {
        while (testEngine.getState().currentTick < captureTick) {
          testEngine.advanceTick(clickTarget);
        }

        const playerPositionAtCaptureTick = testEngine.getState().playerPosition;
        testEngine.advanceTick(clickTarget);

        const spawnEvent = testEngine.getLastTickEvents().find((event) => event.type === 'fireball_spawned');
        expect(spawnEvent).toBeDefined();
        if (!spawnEvent || spawnEvent.type !== 'fireball_spawned') {
          throw new Error('Expected fireball_spawned event on the set start tick');
        }

        const targetPosition = (spawnEvent as Record<string, unknown>).targetPosition;
        expect(Array.isArray(targetPosition)).toBe(true);
        expect(targetPosition).toEqual(playerPositionAtCaptureTick);
        if (!Array.isArray(targetPosition) || targetPosition.length !== 2) {
          throw new Error('Expected fireball_spawned targetPosition to be a coordinate tuple');
        }

        return [targetPosition[0] as number, targetPosition[1] as number] as Coordinate;
      };

      const firstSetTargetPosition = captureAtTick(captureTicks[0], [44, 45]);
      const secondSetTargetPosition = captureAtTick(captureTicks[1], [17, 0]);
      const thirdSetTargetPosition = captureAtTick(captureTicks[2], [44, 0]);

      expect(firstSetTargetPosition).not.toEqual(secondSetTargetPosition);
      expect(firstSetTargetPosition).not.toEqual(thirdSetTargetPosition);
      expect(secondSetTargetPosition).not.toEqual(thirdSetTargetPosition);
    });
  });

  describe('inventory actions cancel attack cycle', () => {
    const ANGLERFISH_ID = 13441;
    const SANFEW_4_ID = 10925;
    const KARAMBWAN_ID = 3144;
    const SATURATED_HEART_ID = 27641;
    const YAMA_ACTOR_ID = 'yama';

    function makeEngineWithAttackTarget(): SimulationEngine {
      const eng = new SimulationEngine({ encounter: new YamaEncounter() });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setAttackTarget(YAMA_ACTOR_ID);
      return eng;
    }

    function makeInventory(items: (number | null)[]): Inventory {
      const inv: Inventory = Array(28).fill(null);
      items.forEach((id, i) => {
        inv[i] = id !== null ? { id } : null;
      });
      return inv;
    }

    function tick(eng: SimulationEngine): void {
      eng.advanceTick(eng.getState().playerPosition);
    }

    it('eating food cancels the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([ANGLERFISH_ID]));

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);

      eng.queueItemAction(0);
      tick(eng);

      // Non-same-tick: interface action clears the weak queue entirely
      expect(eng.getAttackTarget()).toBeNull();
    });

    it('drinking a potion cancels the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([SANFEW_4_ID]));

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);

      eng.queueItemAction(0);
      tick(eng);

      expect(eng.getAttackTarget()).toBeNull();
    });

    it('eating combo food (karambwan) cancels the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([KARAMBWAN_ID]));

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);

      eng.queueItemAction(0);
      tick(eng);

      expect(eng.getAttackTarget()).toBeNull();
    });

    it('using saturated heart cancels the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([SATURATED_HEART_ID]));

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);

      eng.queueItemAction(0);
      tick(eng);

      expect(eng.getAttackTarget()).toBeNull();
    });

    it('item action blocked by cooldown does NOT cancel the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([ANGLERFISH_ID, ANGLERFISH_ID]));

      // First eat: consumes food, clears target
      eng.queueItemAction(0);
      tick(eng);
      expect(eng.getAttackTarget()).toBeNull();

      // Restore target for next test
      eng.setAttackTarget(YAMA_ACTOR_ID);
      // Second eat: blocked by cooldown — action doesn't execute, target persists
      eng.queueItemAction(1);
      tick(eng);

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('unequipping equipment does NOT cancel the attack target', () => {
      const eng = makeEngineWithAttackTarget();

      eng.applyAction({ type: 'unequip', slot: 'cape' });
      tick(eng);

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('equipping from inventory cancels the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([50001]));

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);

      eng.applyAction({ type: 'equipFromInventory', inventoryIndex: 0, itemId: 50001, slot: 'head' });
      tick(eng);

      expect(eng.getAttackTarget()).toBeNull();
    });

    it('equipping a weapon from inventory cancels the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([4151]));

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);

      eng.applyAction({ type: 'equipFromInventory', inventoryIndex: 0, itemId: 4151, slot: 'weapon' });
      tick(eng);

      expect(eng.getAttackTarget()).toBeNull();
    });

    it('changing protection prayer does NOT cancel the attack target', () => {
      const eng = makeEngineWithAttackTarget();

      eng.applyAction({ type: 'protectionPrayer', prayer: PrayerType.ProtectMagic });
      tick(eng);

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('changing offensive prayer does NOT cancel the attack target', () => {
      const eng = makeEngineWithAttackTarget();

      eng.applyAction({ type: 'offensivePrayer', prayer: PrayerType.Augury });
      tick(eng);

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('changing attack style does NOT cancel the attack target', () => {
      const eng = makeEngineWithAttackTarget();

      eng.applyAction({ type: 'attackStyleChange', index: 1 });
      tick(eng);

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('toggling special attack does NOT cancel the attack target', () => {
      const eng = makeEngineWithAttackTarget();

      eng.applyAction({ type: 'specialAttackToggle' });
      tick(eng);

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('swapping inventory slots does NOT cancel the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([ANGLERFISH_ID, SANFEW_4_ID]));

      eng.applyAction({ type: 'swapInventory', from: 0, to: 1 });
      tick(eng);

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('toggling run does NOT cancel the attack target', () => {
      const eng = makeEngineWithAttackTarget();

      eng.applyAction({ type: 'runToggle' });
      tick(eng);

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('equipping weapon + clicking attack same tick preserves the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([4151]));

      // Equip cancels existing target, but a new attack click in the same tick should win.
      eng.applyAction({ type: 'equipFromInventory', inventoryIndex: 0, itemId: 4151, slot: 'weapon' });
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      tick(eng);

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('eating food + clicking attack same tick preserves the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([ANGLERFISH_ID]));

      eng.queueItemAction(0);
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      tick(eng);

      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('clicking attack + then equipping weapon same tick cancels the attack interaction (OSRS ordering)', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([4151]));

      // OSRS ordering: attack first, then equip. The equip cancels the attack interaction
      // but the attack target persists for movement toward the NPC.
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      eng.applyAction({ type: 'equipFromInventory', inventoryIndex: 0, itemId: 4151, slot: 'weapon' });
      tick(eng);

      // Attack target persists (for movement), but interaction is canceled
      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
      const player = getWorldState(eng).getPlayer()!;
      expect(player.attackInteractionActive).toBe(false);
    });

    it('clicking attack with null target after equip clears the attack target', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([4151]));

      eng.applyAction({ type: 'equipFromInventory', inventoryIndex: 0, itemId: 4151, slot: 'weapon' });
      eng.applyAction({ type: 'attackTarget', targetId: null });
      tick(eng);

      expect(eng.getAttackTarget()).toBeNull();
    });

    it('attack→equip same tick: player still moves toward NPC that tick', () => {
      // Place player far from Yama so movement would occur
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 40] as Coordinate });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setInventory(makeInventory([4151]));

      const posBefore = eng.getState().playerPosition;

      // Attack → Equip: equip cancels attack, but movement should still happen
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      eng.applyAction({ type: 'equipFromInventory', inventoryIndex: 0, itemId: 4151, slot: 'weapon' });
      tick(eng);

      const posAfter = eng.getState().playerPosition;
      // Player should have moved toward Yama (south), not stayed in place
      expect(posAfter[1]).toBeLessThan(posBefore[1]);
      // Attack target persists (for continued movement), but interaction canceled
      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
      const player = getWorldState(eng).getPlayer()!;
      expect(player.attackInteractionActive).toBe(false);
    });
    it('equip→attack same tick: attack goes through, attack target persists', () => {
      // Place player adjacent to Yama so attack fires immediately
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 33] as Coordinate });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setInventory(makeInventory([4151]));

      // Equip first, then attack — attack should go through with new weapon
      eng.applyAction({ type: 'equipFromInventory', inventoryIndex: 0, itemId: 4151, slot: 'weapon' });
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      tick(eng);

      // Attack target should persist (attack went through)
      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('emits item_equipped with helmet equipSound for head slot equip', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([50001]));

      eng.applyAction({ type: 'equipFromInventory', inventoryIndex: 0, itemId: 50001, slot: 'head' });
      tick(eng);

      const equipEvent = eng.getLastTickEvents().find((event) => event.type === 'item_equipped');

      expect(equipEvent).toMatchObject({
        type: 'item_equipped',
        slot: 'head',
        itemId: 50001,
        equipSound: 'helmet',
      });
    });

    it('emits item_equipped with staff equipSound for staff weapon equip', () => {
      const eng = makeEngineWithAttackTarget();
      eng.setInventory(makeInventory([29594]));

      eng.applyAction({ type: 'equipFromInventory', inventoryIndex: 0, itemId: 29594, slot: 'weapon' });
      tick(eng);

      const equipEvent = eng.getLastTickEvents().find((event) => event.type === 'item_equipped');

      expect(equipEvent).toMatchObject({
        type: 'item_equipped',
        slot: 'weapon',
        itemId: 29594,
        equipSound: 'staff',
      });
    });

    it('attack→eat same tick: eats food but does NOT attack (OSRS ordering)', () => {
      // Place player adjacent to Yama so attack would fire if not canceled
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 33] as Coordinate });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setInventory(makeInventory([ANGLERFISH_ID]));

      // Attack first, then eat. The eat cancels the attack interaction.
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      eng.queueItemAction(0);
      tick(eng);

      // Food should have been consumed
      expect(eng.getState().inventory[0]).toBeNull();
      // Attack target persists (for movement), but interaction canceled
      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
      const player = getWorldState(eng).getPlayer()!;
      expect(player.attackInteractionActive).toBe(false);
    });
    it('eat→attack same tick: eats food AND attacks normally', () => {
      // Place player adjacent to Yama so attack fires immediately
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 33] as Coordinate });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setInventory(makeInventory([ANGLERFISH_ID]));

      // Eat first, then attack — attack should go through
      eng.queueItemAction(0);
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      tick(eng);

      // Food should have been consumed
      expect(eng.getState().inventory[0]).toBeNull();
      // Attack target should persist (attack went through)
      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
    });

    it('attack→eat same tick: player moves toward NPC but does not attack', () => {
      // Place player far from Yama so movement would occur
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 40] as Coordinate });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setInventory(makeInventory([ANGLERFISH_ID]));

      const posBefore = eng.getState().playerPosition;

      // Attack → Eat: eat cancels attack interaction, but movement persists
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      eng.queueItemAction(0);
      tick(eng);

      const posAfter = eng.getState().playerPosition;
      // Player should have moved toward Yama (south)
      expect(posAfter[1]).toBeLessThan(posBefore[1]);
      // Attack target persists (for movement), but interaction canceled
      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
      const player = getWorldState(eng).getPlayer()!;
      expect(player.attackInteractionActive).toBe(false);
      // Food should have been consumed
      expect(eng.getState().inventory[0]).toBeNull();
    });

    it('attack→equip: player continues moving across multiple ticks', () => {
      // Place player far from Yama so multi-tick movement is needed
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 42] as Coordinate });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setInventory(makeInventory([4151]));

      // Attack → Equip: equip cancels attack interaction, movement persists
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      eng.applyAction({ type: 'equipFromInventory', inventoryIndex: 0, itemId: 4151, slot: 'weapon' });

      const posTick0 = eng.getState().playerPosition;
      tick(eng);
      const posTick1 = eng.getState().playerPosition;
      expect(posTick1[1]).toBeLessThan(posTick0[1]);

      // Tick 2: player should continue moving (attackTarget still set for pathing)
      tick(eng);
      const posTick2 = eng.getState().playerPosition;
      expect(posTick2[1]).toBeLessThan(posTick1[1]);

      // Tick 3: still moving
      tick(eng);
      const posTick3 = eng.getState().playerPosition;
      expect(posTick3[1]).toBeLessThan(posTick2[1]);
    });

    it('attack→drink potion same tick: cancels attack, preserves movement', () => {
      // Place player far from Yama so movement occurs
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 40] as Coordinate });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setInventory(makeInventory([SANFEW_4_ID]));

      const posBefore = eng.getState().playerPosition;

      // Attack → Drink: potion cancels attack interaction, movement persists
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      eng.queueItemAction(0);
      tick(eng);

      const posAfter = eng.getState().playerPosition;
      // Player should have moved toward Yama (south)
      expect(posAfter[1]).toBeLessThan(posBefore[1]);
      // Attack target persists (for movement), but interaction canceled
      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
      const player = getWorldState(eng).getPlayer()!;
      expect(player.attackInteractionActive).toBe(false);
    });

    it('attack then eat-on-cooldown same tick: drag to melee (interface click still cancels interaction)', () => {
      // Place player far from Yama so movement would occur
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 40] as Coordinate });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setInventory(makeInventory([ANGLERFISH_ID, ANGLERFISH_ID]));

      // Eat first food to put food track on cooldown
      eng.queueItemAction(0);
      tick(eng);
      expect(eng.getState().inventory[0]).toBeNull();

      const posBefore = eng.getState().playerPosition;

      // Same tick: attack then eat-on-cooldown. Even though the food is blocked,
      // the interface click still cancels the attack interaction (OSRS behavior).
      eng.applyAction({ type: 'attackTarget', targetId: YAMA_ACTOR_ID });
      eng.queueItemAction(1);
      tick(eng);

      const posAfter = eng.getState().playerPosition;
      // Player should have moved toward Yama (south) - drag to melee
      expect(posAfter[1]).toBeLessThan(posBefore[1]);
      // Food should NOT have been consumed (on cooldown)
      expect(eng.getState().inventory[1]).not.toBeNull();
      // Attack target persists (for movement), but interaction canceled
      expect(eng.getAttackTarget()).toBe(YAMA_ACTOR_ID);
      const player = getWorldState(eng).getPlayer()!;
      expect(player.attackInteractionActive).toBe(false);
    });
  });

  describe('on-kill attack delay reduction tick ordering', () => {
    const KILL_TICK = 3;

    interface OnKillFixture {
      eng: SimulationEngine;
      combatSystem: CombatSystem;
      worldState: ReturnType<typeof getWorldState>;
      dummyNpc: NpcActor;
      launchTick: number;
      postAttackTick: number;
    }

    function setupPendingOnKillReduction(): OnKillFixture {
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 27] as Coordinate });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setAttackTarget('yama');

      const worldState = getWorldState(eng);
      const combatSystem = Reflect.get(eng, 'combatSystem') as CombatSystem;

      eng.advanceTick([31, 27]);
      const launchTick = worldState.tick;
      const postAttackTick = combatSystem.getNextAttackTick('player')!;
      expect(postAttackTick).toBeGreaterThan(KILL_TICK);

      const dummyNpc: NpcActor = {
        id: 'test_dummy',
        kind: 'npc',
        alive: true,
        position: [40, 40],
        previousPosition: [40, 40],
        facing: 0,
        size: 1,
        vitals: { hp: 1, maxHp: 1 },
        history: new Map(),
        npcTypeId: 14179,
        archetypeId: 'none',
        combat: {
          attackSpeed: 4,
          attackStyle: 'magic',
          attackRange: 10,
          nextActionTick: 0,
          lastAttackTick: null,
          targetId: 'player',
          animations: { idle: null, walk: null, run: null, attack: null, death: null },
        },
      };
      worldState.registerNpc(dummyNpc);

      enqueueEnginePendingHit(eng, {
        sourceId: 'player',
        targetId: 'test_dummy',
        style: 'magic',
        attackKind: 'magic_fire',
        launchTick,
        impactTick: KILL_TICK,
        rolledDamage: 100,
        accuracySucceeded: true,
        onKillEffect: { reduceAttackDelayTicks: 3 },
      });

      return { eng, combatSystem, worldState, dummyNpc, launchTick, postAttackTick };
    }

    it('pending hit on-kill effect cannot bring the next attack forward to the kill tick', () => {
      const { eng, combatSystem, worldState, dummyNpc, launchTick, postAttackTick } = setupPendingOnKillReduction();

      while (worldState.tick < KILL_TICK) {
        eng.advanceTick([31, 27]);
      }

      expect(dummyNpc.alive).toBe(false);

      // Queued hits resolve before the auto-attack band, so the kill tick is a live attack
      // opportunity here and only the floor in reduceNextAttackTick keeps the player off it.
      expect(combatSystem.getNextAttackTick('player')).toBe(KILL_TICK + 1);

      const attackSpeed = postAttackTick - launchTick;
      eng.advanceTick([31, 27]);
      expect(combatSystem.getNextAttackTick('player')).toBe(KILL_TICK + 1 + attackSpeed);
    });

    it('eating on the kill tick nets the food delay against the reduction', () => {
      const ANGLERFISH_ID = 13441;
      const { eng, combatSystem, worldState, dummyNpc, postAttackTick } = setupPendingOnKillReduction();

      const inventory: Inventory = Array(28).fill(null);
      inventory[0] = { id: ANGLERFISH_ID };
      eng.setInventory(inventory);

      while (worldState.tick < KILL_TICK - 1) {
        eng.advanceTick([31, 27]);
      }

      // Food is an input-band op and lands ahead of the queued hit, so the kill tick nets +3
      // then -3 back to the original cooldown. This is what fails if the reduction is ever
      // reimplemented as "clamp the gap to 3" instead of a true -3 with a floor.
      eng.queueItemAction(0);
      eng.advanceTick([31, 27]);

      expect(worldState.tick).toBe(KILL_TICK);
      expect(dummyNpc.alive).toBe(false);
      expect(eng.getState().inventory[0]).toBeNull();
      expect(combatSystem.getNextAttackTick('player')).toBe(postAttackTick);
    });
  });

  // capture yama_divine_severance.txt tick 3214: a Purging staff kill puts
  // vfx_ignite_staff_01_2x2 (2812) on the killed npc, on the killing-blow tick.
  describe('Purging staff "Scatter ashes" kill graphic', () => {
    const KILL_TICK = 3;
    const SCATTER_ASHES = getSpecialAttackDef(29594)?.onKillEffect;

    function killGraphics(options: { size: number; hp: number; onKillEffect: typeof SCATTER_ASHES }) {
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 27] as Coordinate });
      eng.setMechanicsConfig({ yamaMageRange: false, waves: false, fireballs: false, voidFlares: false });
      const worldState = getWorldState(eng);
      const target: NpcActor = {
        id: 'target',
        kind: 'npc',
        alive: true,
        position: [40, 40],
        previousPosition: [40, 40],
        facing: 0,
        size: options.size,
        vitals: { hp: options.hp, maxHp: options.hp },
        history: new Map(),
        npcTypeId: 14179,
        archetypeId: 'none',
        combat: {
          attackSpeed: 4,
          attackStyle: 'magic',
          attackRange: 10,
          nextActionTick: 0,
          lastAttackTick: null,
          targetId: null,
          animations: { idle: null, walk: null, run: null, attack: null, death: null },
        },
      };
      worldState.registerNpc(target);
      enqueueEnginePendingHit(eng, {
        sourceId: 'player',
        targetId: 'target',
        style: 'magic',
        attackKind: 'magic_fire',
        launchTick: 0,
        impactTick: KILL_TICK,
        rolledDamage: 100,
        accuracySucceeded: true,
        onKillEffect: options.onKillEffect,
      });
      const graphics: Array<{ tick: number; targetId: string; spotAnimId: number; height: number }> = [];
      for (let tick = 0; tick < KILL_TICK + 2; tick++) {
        eng.advanceTick([31, 27]);
        for (const event of eng.getLastTickEvents()) {
          if (isCoreEvent(event, 'npc_graphic_applied'))
            graphics.push({
              tick: event.tick,
              targetId: event.targetId,
              spotAnimId: event.spotAnimId,
              height: event.height,
            });
        }
      }
      return graphics;
    }

    it.each([
      [1, 2811],
      [2, 2812],
      [5, 2813],
    ])('puts the size-%i variant (%i) on the npc the special kills', (size, spotAnimId) => {
      expect(killGraphics({ size, hp: 50, onKillEffect: SCATTER_ASHES })).toEqual([
        { tick: KILL_TICK, targetId: 'target', spotAnimId, height: 0 },
      ]);
    });

    it('shows nothing for a kill without the special or a special that does not kill', () => {
      expect(killGraphics({ size: 2, hp: 50, onKillEffect: undefined })).toEqual([]);
      expect(killGraphics({ size: 2, hp: 500, onKillEffect: SCATTER_ASHES })).toEqual([]);
    });
  });

  describe('food eat delay extends attack cooldown', () => {
    // OSRS Wiki (https://oldschool.runescape.wiki/w/Food/Fast_foods):
    //   - Standard food: +3 tick attack delay
    //   - Karambwan / fast food: +2 tick attack delay
    //   - Potions: +0 tick attack delay
    //   - Combo eating stacks additively (shark + karambwan = +5)
    //   - Eating with a ready weapon adds NO delay
    const ANGLERFISH_ID = 13441;
    const SANFEW_4_ID = 10925;
    const KARAMBWAN_ID = 3144;
    const SATURATED_HEART_ID = 27641;
    const LOCATOR_ORB_ID = 22081;

    function makeEngineAdjacentToYama(): {
      eng: SimulationEngine;
      combatSystem: CombatSystem;
    } {
      const eng = new SimulationEngine({
        encounter: new YamaEncounter(),
        startPos: [31, 27] as Coordinate,
      });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      eng.setAttackTarget('yama');
      const combatSystem = Reflect.get(eng, 'combatSystem') as CombatSystem;
      return { eng, combatSystem };
    }

    function setInventoryAt(eng: SimulationEngine, items: (number | null)[]): void {
      const inv: Inventory = Array(28).fill(null);
      items.forEach((id, i) => {
        inv[i] = id !== null ? { id } : null;
      });
      eng.setInventory(inv);
    }

    function tickHere(eng: SimulationEngine): void {
      eng.advanceTick(eng.getState().playerPosition);
    }

    it('eating standard food extends next attack tick by 3 while mid-cooldown', () => {
      const { eng, combatSystem } = makeEngineAdjacentToYama();
      setInventoryAt(eng, [ANGLERFISH_ID]);

      // Tick 1: player auto-attacks Yama, sets cooldown
      tickHere(eng);
      const postAttackTick = combatSystem.getNextAttackTick('player')!;
      expect(postAttackTick).toBeGreaterThan(eng.getState().currentTick);

      // Tick 2: queue eat. processItemActions runs before auto-attack.
      eng.queueItemAction(0);
      tickHere(eng);

      // The food track has +3 tick attack delay.
      expect(combatSystem.getNextAttackTick('player')).toBe(postAttackTick + 3);
    });

    it('eating karambwan (combo_food) extends by 2 ticks while mid-cooldown', () => {
      const { eng, combatSystem } = makeEngineAdjacentToYama();
      setInventoryAt(eng, [KARAMBWAN_ID]);

      tickHere(eng);
      const postAttackTick = combatSystem.getNextAttackTick('player')!;

      eng.queueItemAction(0);
      tickHere(eng);

      expect(combatSystem.getNextAttackTick('player')).toBe(postAttackTick + 2);
    });

    it('drinking a potion does NOT extend the attack cooldown', () => {
      const { eng, combatSystem } = makeEngineAdjacentToYama();
      setInventoryAt(eng, [SANFEW_4_ID]);

      tickHere(eng);
      const postAttackTick = combatSystem.getNextAttackTick('player')!;

      eng.queueItemAction(0);
      tickHere(eng);

      // Wiki: "Potions do not incur the standard 3 tick attack or eat delay"
      expect(combatSystem.getNextAttackTick('player')).toBe(postAttackTick);
    });

    it('using saturated heart (potion track, bypasses cooldown) does NOT extend attack', () => {
      const { eng, combatSystem } = makeEngineAdjacentToYama();
      setInventoryAt(eng, [SATURATED_HEART_ID]);

      tickHere(eng);
      const postAttackTick = combatSystem.getNextAttackTick('player')!;

      eng.queueItemAction(0);
      tickHere(eng);

      expect(combatSystem.getNextAttackTick('player')).toBe(postAttackTick);
    });

    it('locator orb does NOT extend the attack cooldown, and lands once per tick', () => {
      const { eng, combatSystem } = makeEngineAdjacentToYama();
      setInventoryAt(eng, [LOCATOR_ORB_ID]);

      tickHere(eng);
      const postAttackTick = combatSystem.getNextAttackTick('player')!;
      const hpBefore = eng.getState().playerHP;

      // The orb is an inventory option, not food: no cooldown track and no attack delay, so it
      // is usable again on the NEXT tick. Three clicks in one tick still only land one.
      eng.queueItemAction(0);
      eng.queueItemAction(0);
      tickHere(eng);
      eng.queueItemAction(0);
      tickHere(eng);

      expect(combatSystem.getNextAttackTick('player')).toBe(postAttackTick);
      expect(eng.getState().playerHP).toBe(hpBefore - 20);
    });

    it('combo-eat food + karambwan in the same tick stacks additively (+5)', () => {
      const { eng, combatSystem } = makeEngineAdjacentToYama();
      setInventoryAt(eng, [ANGLERFISH_ID, KARAMBWAN_ID]);

      tickHere(eng);
      const postAttackTick = combatSystem.getNextAttackTick('player')!;

      // Queue both in the same tick — cooldown tracks allow food+combo_food combo
      eng.queueItemAction(0); // anglerfish (food, +3)
      eng.queueItemAction(1); // karambwan (combo_food, +2)
      tickHere(eng);

      // Wiki: "eating a shark with a karambwan results in a 5 tick attack delay"
      expect(combatSystem.getNextAttackTick('player')).toBe(postAttackTick + 5);
    });

    it('combo-eat food + potion + karambwan stacks to +5 (potion contributes 0)', () => {
      const { eng, combatSystem } = makeEngineAdjacentToYama();
      setInventoryAt(eng, [ANGLERFISH_ID, SANFEW_4_ID, KARAMBWAN_ID]);

      tickHere(eng);
      const postAttackTick = combatSystem.getNextAttackTick('player')!;

      eng.queueItemAction(0); // anglerfish (food, +3)
      eng.queueItemAction(1); // sanfew serum (potion, +0)
      eng.queueItemAction(2); // karambwan (combo_food, +2)
      tickHere(eng);

      expect(combatSystem.getNextAttackTick('player')).toBe(postAttackTick + 5);
    });

    it('eating when player has never attacked does NOT seed a cooldown', () => {
      const { eng, combatSystem } = makeEngineAdjacentToYama();
      setInventoryAt(eng, [ANGLERFISH_ID]);

      // No prior attack — nextAttackTick is undefined for the player.
      // Eating in this state must NOT seed a new cooldown.
      expect(combatSystem.getNextAttackTick('player')).toBeUndefined();

      eng.queueItemAction(0);
      tickHere(eng);

      expect(combatSystem.getNextAttackTick('player')).toBeUndefined();
    });
  });

  describe('1-tick prayer flicking', () => {
    const safePos: Coordinate = [39, 35];

    /** Advance one tick without moving (stay at safePos). */
    function tickHere(eng: SimulationEngine): void {
      eng.advanceTick(safePos);
    }

    /** Create an engine with all damage disabled so we can isolate prayer drain. */
    function makeSafeEngine(): SimulationEngine {
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: safePos });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        infiniteHealth: true,
      });
      return eng;
    }

    function prayerChanges(eng: SimulationEngine): { from: PrayerType | null; to: PrayerType | null }[] {
      return eng
        .getLastTickEvents()
        .filter((event) => isCoreEvent(event, 'prayer_changed'))
        .map(({ from, to }) => ({ from, to }));
    }

    it('prayer activated and left on drains over time', () => {
      const eng = makeSafeEngine();
      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      tickHere(eng); // Tick 1: activate prayer

      const pointsAfterActivation = eng.prayerState.points;
      expect(pointsAfterActivation).toBe(99); // Grace period: no drain on activation tick
      expect(eng.prayerState.prayerActivationTicks[PrayerType.ProtectMagic]).toBe(eng.getState().currentTick);
      expect(eng.prayerState.drainCounter).toBe(0);

      tickHere(eng);
      expect(eng.prayerState.drainCounter).toBeGreaterThan(0);

      for (let i = 0; i < 19; i++) {
        tickHere(eng);
      }

      expect(eng.prayerState.points).toBeLessThan(99);
    });

    it('flicking protection prayer off→on each tick avoids all drain', () => {
      const eng = makeSafeEngine();

      // First tick: activate prayer
      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      tickHere(eng);
      expect(eng.prayerState.points).toBe(99);

      // Subsequent ticks: flick off→on between each tick
      for (let i = 0; i < 20; i++) {
        eng.queueProtectionPrayer(null); // OFF
        if (i === 0) expect(eng.getState().pendingProtectionPrayer).toEqual([true, null]);
        eng.queueProtectionPrayer(PrayerType.ProtectMagic); // ON (refreshes activation tick)
        if (i === 0) {
          expect(eng.getState().pendingProtectionPrayer).toEqual([true, PrayerType.ProtectMagic]);
        }
        tickHere(eng);
        expect(eng.prayerState.prayerActivationTicks[PrayerType.ProtectMagic]).toBe(eng.getState().currentTick);
      }

      // Zero drain across 20+ ticks
      expect(eng.prayerState.points).toBe(99);
      expect(eng.prayerState.drainCounter).toBe(0);
    });

    it('double-clicking an individual prayer from off emits both transitions and ends off', () => {
      const eng = makeSafeEngine();

      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      tickHere(eng);

      expect(prayerChanges(eng)).toEqual([
        { from: null, to: PrayerType.ProtectMagic },
        { from: PrayerType.ProtectMagic, to: null },
      ]);
      expect(eng.activePrayer).toBeNull();
    });

    it('emits both prayer changes for an explicit off→on flick inside one tick', () => {
      const eng = makeSafeEngine();
      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      tickHere(eng);
      const replayChangesBefore = eng.getEventLog().filter((event) => event.type === EventType.PRAYER_CHANGE).length;

      eng.queueProtectionPrayer(null);
      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      tickHere(eng);

      expect(prayerChanges(eng)).toEqual([
        { from: PrayerType.ProtectMagic, to: null },
        { from: null, to: PrayerType.ProtectMagic },
      ]);
      expect(eng.activePrayer).toBe(PrayerType.ProtectMagic);
      expect(eng.getEventLog().filter((event) => event.type === EventType.PRAYER_CHANGE)).toHaveLength(
        replayChangesBefore,
      );
    });

    it('emits no prayer change for an explicit clear when the slot is already empty', () => {
      const eng = makeSafeEngine();

      eng.queueProtectionPrayer(null);
      tickHere(eng);

      expect(prayerChanges(eng)).toEqual([]);
      expect(eng.activePrayer).toBeNull();
    });

    it('preserves explicit clear semantics after an activation in the same tick', () => {
      const eng = makeSafeEngine();

      eng.queueProtectionPrayer(PrayerType.ProtectMelee);
      eng.queueProtectionPrayer(null);
      tickHere(eng);

      expect(eng.activePrayer).toBeNull();
    });

    it('flicking offensive prayer off→on each tick avoids all drain', () => {
      const eng = makeSafeEngine();

      eng.queueBoostPrayer(PrayerType.Piety);
      tickHere(eng);
      expect(eng.prayerState.points).toBe(99);

      for (let i = 0; i < 20; i++) {
        eng.queueBoostPrayer(null);
        eng.queueBoostPrayer(PrayerType.Piety);
        tickHere(eng);
      }

      expect(eng.prayerState.points).toBe(99);
      expect(eng.prayerState.drainCounter).toBe(0);
    });

    it('flicking both protection + offensive simultaneously avoids all drain', () => {
      const eng = makeSafeEngine();

      // Activate both
      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      eng.queueBoostPrayer(PrayerType.Piety);
      tickHere(eng);
      expect(eng.prayerState.points).toBe(99);

      // Flick both every tick (simulates quick prayer toggle off→on)
      for (let i = 0; i < 20; i++) {
        eng.queueProtectionPrayer(null);
        eng.queueBoostPrayer(null);
        eng.queueProtectionPrayer(PrayerType.ProtectMagic);
        eng.queueBoostPrayer(PrayerType.Piety);
        tickHere(eng);
      }

      expect(eng.prayerState.points).toBe(99);
      expect(eng.prayerState.drainCounter).toBe(0);
    });

    it('partial flick: only toggled prayer avoids drain, untoggled one drains', () => {
      const eng = makeSafeEngine();

      // Activate both prayers on tick 1
      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      eng.queueBoostPrayer(PrayerType.Piety);
      tickHere(eng);
      expect(eng.prayerState.points).toBe(99);

      // Only flick protection; leave offensive untouched
      for (let i = 0; i < 20; i++) {
        eng.queueProtectionPrayer(null);
        eng.queueProtectionPrayer(PrayerType.ProtectMagic);
        // NOT toggling Piety — it will drain
        tickHere(eng);
      }

      // Piety (drain 24) should have caused some drain
      expect(eng.prayerState.points).toBeLessThan(99);
    });

    it('prayer still provides protection during flick tick', () => {
      // A flicked prayer is still active during the tick (processPrayerChanges
      // runs before combat), even though it avoids drain.
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: safePos });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        infiniteHealth: true,
      });

      // Flick protection prayer on
      eng.queueProtectionPrayer(null);
      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      tickHere(eng);

      // After processing, the prayer should be active
      expect(eng.activePrayer).toBe(PrayerType.ProtectMagic);
      // And zero drain
      expect(eng.prayerState.points).toBe(99);
    });

    it('activation tick is recorded in prayerState', () => {
      const eng = makeSafeEngine();

      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      tickHere(eng);

      const tick = eng.getState().currentTick;
      expect(eng.prayerState.prayerActivationTicks[PrayerType.ProtectMagic]).toBe(tick);
    });

    it('re-activating same prayer refreshes activation tick', () => {
      const eng = makeSafeEngine();

      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      tickHere(eng);
      const firstActivationTick = eng.prayerState.prayerActivationTicks[PrayerType.ProtectMagic];

      // Flick: off→on
      eng.queueProtectionPrayer(null);
      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      tickHere(eng);

      const secondActivationTick = eng.prayerState.prayerActivationTicks[PrayerType.ProtectMagic];
      expect(secondActivationTick).toBeGreaterThan(firstActivationTick!);
      expect(secondActivationTick).toBe(eng.getState().currentTick);
    });

    it('reset clears activation ticks', () => {
      const eng = makeSafeEngine();

      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      tickHere(eng);
      expect(eng.prayerState.prayerActivationTicks[PrayerType.ProtectMagic]).toBeDefined();

      eng.reset();
      expect(eng.prayerState.prayerActivationTicks).toEqual({});
    });

    describe('quick-prayer orb toggles', () => {
      const quickSet = [PrayerType.ProtectMagic, PrayerType.Augury] as const;

      it('enqueues every click and lands back on the starting state after an even count', () => {
        const eng = makeSafeEngine();
        eng.queueQuickPrayerToggle(quickSet);
        tickHere(eng);
        expect(eng.getState().quickPrayersActive).toBe(true);

        eng.queueQuickPrayerToggle(quickSet);
        expect(eng.getState().quickPrayersActive).toBe(false);
        eng.queueQuickPrayerToggle(quickSet);
        expect(eng.getState().quickPrayersActive).toBe(true);
        tickHere(eng);

        expect(eng.getState().quickPrayersActive).toBe(true);
        expect(eng.activePrayer).toBe(PrayerType.ProtectMagic);
        expect(eng.boostPrayers).toEqual([PrayerType.Augury]);
      });

      it('emits every slot transition for an off→on pair inside one tick', () => {
        const eng = makeSafeEngine();
        eng.queueQuickPrayerToggle(quickSet);
        tickHere(eng);

        eng.queueQuickPrayerToggle(quickSet);
        eng.queueQuickPrayerToggle(quickSet);
        tickHere(eng);

        expect(prayerChanges(eng)).toEqual([
          { from: PrayerType.ProtectMagic, to: null },
          { from: PrayerType.Augury, to: null },
          { from: null, to: PrayerType.ProtectMagic },
          { from: null, to: PrayerType.Augury },
        ]);
        expect(eng.activePrayer).toBe(PrayerType.ProtectMagic);
        expect(eng.boostPrayers).toEqual([PrayerType.Augury]);
      });

      it('double-clicking from off lands back on off', () => {
        const eng = makeSafeEngine();

        eng.queueQuickPrayerToggle(quickSet);
        eng.queueQuickPrayerToggle(quickSet);
        tickHere(eng);

        expect(eng.getState().quickPrayersActive).toBe(false);
        expect(eng.activePrayer).toBeNull();
        expect(eng.boostPrayers).toEqual([]);
      });

      it('costs no prayer when double-clicked every tick', () => {
        const eng = makeSafeEngine();
        eng.queueQuickPrayerToggle(quickSet);
        tickHere(eng);

        for (let i = 0; i < 20; i++) {
          eng.queueQuickPrayerToggle(quickSet);
          eng.queueQuickPrayerToggle(quickSet);
          tickHere(eng);
        }

        expect(eng.getState().quickPrayersActive).toBe(true);
        expect(eng.prayerState.points).toBe(99);
        expect(eng.prayerState.drainCounter).toBe(0);
      });

      it('toggles after an odd number of clicks inside one tick', () => {
        const eng = makeSafeEngine();

        eng.queueQuickPrayerToggle(quickSet);
        eng.queueQuickPrayerToggle(quickSet);
        eng.queueQuickPrayerToggle(quickSet);
        tickHere(eng);

        expect(eng.getState().quickPrayersActive).toBe(true);
        expect(eng.activePrayer).toBe(PrayerType.ProtectMagic);
      });
    });

    describe('run orb toggles', () => {
      it('lands back on the starting state after two clicks', () => {
        const eng = makeSafeEngine();
        const initial = eng.getState().isRunEnabled;

        eng.queueRunToggle();
        expect(eng.getState().isRunEnabled).toBe(!initial);
        eng.queueRunToggle();
        expect(eng.getState().isRunEnabled).toBe(initial);
        tickHere(eng);

        expect(eng.getState().isRunEnabled).toBe(initial);
      });

      it('makes three clicks equivalent to one click', () => {
        const eng = makeSafeEngine();
        const initial = eng.getState().isRunEnabled;

        eng.queueRunToggle();
        tickHere(eng);
        expect(eng.getState().isRunEnabled).toBe(!initial);

        eng.queueRunToggle();
        eng.queueRunToggle();
        eng.queueRunToggle();
        tickHere(eng);
        expect(eng.getState().isRunEnabled).toBe(initial);
      });
    });
  });

  describe('prayer drain events', () => {
    const safePos: Coordinate = [39, 35];

    function makeSafeEngine(): SimulationEngine {
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: safePos });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: false,
        infiniteHealth: true,
      });
      return eng;
    }

    function advanceSafeTick(eng: SimulationEngine): void {
      eng.advanceTick(safePos);
    }

    it('emits prayer_depleted once when drain reaches zero', () => {
      const eng = makeSafeEngine();
      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      advanceSafeTick(eng);
      eng.prayerState.points = 1;
      eng.prayerState.drainCounter = 59;

      advanceSafeTick(eng);
      const depletedEvents = eng.getLastTickEvents().filter((event) => event.type === 'prayer_depleted');
      expect(depletedEvents).toHaveLength(1);
      expect(depletedEvents[0]).toMatchObject({ actorId: 'player' });

      advanceSafeTick(eng);
      expect(eng.getLastTickEvents().filter((event) => event.type === 'prayer_depleted')).toHaveLength(0);
    });

    it('clears the quick-prayer flag when prayer depletion switches off the set', () => {
      const eng = makeSafeEngine();
      eng.queueQuickPrayerToggle([PrayerType.ProtectMagic, PrayerType.Augury]);
      advanceSafeTick(eng);
      expect(eng.getState().quickPrayersActive).toBe(true);
      eng.prayerState.points = 1;
      eng.prayerState.drainCounter = 59;

      advanceSafeTick(eng);

      expect(eng.getState().activePrayer).toBeNull();
      expect(eng.getState().boostPrayers).toEqual([]);
      expect(eng.getState().quickPrayersActive).toBe(false);
    });

    it('emits prayer_activation_failed when activating with no prayer points', () => {
      const eng = makeSafeEngine();
      eng.prayerState.points = 0;

      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      advanceSafeTick(eng);

      const failedEvents = eng.getLastTickEvents().filter((event) => event.type === 'prayer_activation_failed');
      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0]).toMatchObject({ actorId: 'player', attemptedPrayer: PrayerType.ProtectMagic });
    });

    it('dedupes prayer_activation_failed for protection and offensive prayers on the same tick', () => {
      const eng = makeSafeEngine();
      eng.prayerState.points = 0;

      eng.queueProtectionPrayer(PrayerType.ProtectMagic);
      eng.queueBoostPrayer(PrayerType.Piety);
      advanceSafeTick(eng);

      expect(eng.getLastTickEvents().filter((event) => event.type === 'prayer_activation_failed')).toHaveLength(1);
    });
  });

  describe('input band precedes the timer band', () => {
    const safePos: Coordinate = [39, 35];
    const ANTIDOTE_PLUS_PLUS_4 = 5952;

    function makePoisonedEngine(): SimulationEngine {
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: safePos });
      eng.setMechanicsConfig({ yamaMageRange: false, waves: false, fireballs: false, voidFlares: false });
      eng.setInventory([{ id: ANTIDOTE_PLUS_PLUS_4 }]);
      const player = getWorldState(eng).getPlayer()!;
      // Counter at 1 so the poison timer is due on the very next tick.
      player.poisonState = { poisonVarp: 30, poisonTickCounter: 1, startedTick: null };
      return eng;
    }

    it('cures poison before the poison timer that was due on the same tick', () => {
      // Given a poisoned player whose next damage tick is this one
      const eng = makePoisonedEngine();
      const hpBefore = eng.getState().playerHP;

      // When the antidote is drunk on that tick
      eng.queueItemAction(0);
      eng.advanceTick(safePos);

      // Then the cure ran in the input band, ahead of the timer band that would
      // have dealt the hit — poison damage is driven from a normal timer, and
      // every timer runs after the tick's ops have been applied.
      expect(eng.getState().poisonVarp).toBeLessThanOrEqual(0);
      expect(eng.getState().playerHP).toBe(hpBefore);
    });

    it('still takes the hit when nothing was drunk', () => {
      // Given the same due poison timer and no input
      const eng = makePoisonedEngine();
      const hpBefore = eng.getState().playerHP;

      // When the tick advances
      eng.advanceTick(safePos);

      // Then the timer lands its damage
      expect(eng.getState().playerHP).toBeLessThan(hpBefore);
    });

    it('gives a poison applied by this tick a full first cycle', () => {
      // The timer band runs AFTER the hit that poisons, so without the application-tick
      // guard the counter would go 30 -> 29 on the tick it was set and every cycle would
      // land a tick early. Yama's melee carries `applyPoison`, so this is reachable.
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: safePos });
      eng.setMechanicsConfig({ yamaMageRange: false, waves: false, fireballs: false, voidFlares: false });
      const world = getWorldState(eng);
      const player = world.getPlayer()!;
      enqueueEnginePendingHit(eng, {
        sourceId: 'yama',
        targetId: 'player',
        style: 'melee',
        attackKind: 'melee_crush',
        launchTick: world.tick,
        impactTick: world.tick + 1,
        rolledDamage: 1,
        accuracySucceeded: true,
        applyPoison: 30,
      });

      eng.advanceTick(safePos);

      expect(player.poisonState.poisonVarp).toBe(30);
      expect(player.poisonState.poisonTickCounter).toBe(POISON_TICK_INTERVAL);
    });

    it('does not let a delayed heal come due after a lethal hit revive the corpse', () => {
      // Queue band before timer band means a karambwan heal can land on a player the
      // queue just killed, leaving alive:false with positive hitpoints on the death screen.
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: safePos });
      eng.setMechanicsConfig({ yamaMageRange: false, waves: false, fireballs: false, voidFlares: false });
      const player = getWorldState(eng).getPlayer()!;
      player.vitals.hp = 1;
      player.stats.hitpoints.current = 1;
      player.activeEffects = [
        {
          id: 'delayed-heal-under-test',
          type: 'delayed_heal',
          ticksRemaining: 1,
          tickDuration: 3,
          startedTick: getWorldState(eng).tick - 2,
          data: { amount: 20, group: 'combo_food' },
        },
      ];
      enqueueEnginePendingHit(eng, {
        sourceId: 'yama',
        targetId: 'player',
        style: 'melee',
        attackKind: 'melee_crush',
        launchTick: getWorldState(eng).tick,
        impactTick: getWorldState(eng).tick + 1,
        rolledDamage: 50,
        accuracySucceeded: true,
      });

      eng.advanceTick(safePos);

      expect(eng.getState().isAlive).toBe(false);
      expect(eng.getState().playerHP).toBe(0);
      expect(eng.getState().failedCondition).toBe('Death');
    });

    it('does not tick down an effect timer on the tick it was drunk', () => {
      // The timer band runs AFTER the input band, so without `EffectTimer.startedTick` a
      // potion drunk this tick would immediately lose one of its own ticks.
      const STAMINA_POTION_4 = 31638;
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: safePos });
      eng.setMechanicsConfig({ yamaMageRange: false, waves: false, fireballs: false, voidFlares: false });
      eng.setInventory([{ id: STAMINA_POTION_4 }]);
      const player = getWorldState(eng).getPlayer()!;

      eng.queueItemAction(0);
      eng.advanceTick(safePos);
      const stamina = player.activeEffects.find((effect) => effect.type === 'stamina');
      expect(stamina?.ticksRemaining).toBe(stamina?.tickDuration);

      eng.advanceTick(safePos);
      expect(player.activeEffects.find((effect) => effect.type === 'stamina')?.ticksRemaining).toBe(
        (stamina?.tickDuration ?? 0) - 1,
      );
    });

    it('keeps the attack target when a consume queued after it is refused by its cooldown', () => {
      // The FIFO split the attack cancel in two: the interaction cancel is unconditional
      // (the click happened), but clearing the TARGET is earned only by a consume that
      // actually ran. A click the cooldown refuses leaves the player attacking.
      const ANGLERFISH = 13441;
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: safePos });
      eng.setMechanicsConfig({ yamaMageRange: false, waves: false, fireballs: false, voidFlares: false });
      eng.setInventory([{ id: ANGLERFISH }, { id: ANGLERFISH }]);

      // Burn the food track with a first eat.
      eng.queueItemAction(0);
      eng.advanceTick(safePos);

      // Attack, then eat again in the same tick while the track is still on cooldown.
      // `applyAction` is the queued path; `setAttackTarget` writes straight through and
      // would never put an `attack_target` op in the FIFO for the eat to see.
      eng.applyAction({ type: 'attackTarget', targetId: 'yama' });
      eng.queueItemAction(1);
      eng.advanceTick(safePos);

      expect(eng.getAttackTarget()).toBe('yama');
      expect(getWorldState(eng).getPlayer()?.attackInteractionActive).toBe(false);
    });
  });

  describe('debug fireball action', () => {
    it('uses natural capture, then emits the spawn on the set start tick after it', () => {
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: true,
        voidFlares: false,
        infiniteHealth: true,
      });

      eng.executeEncounterCommand(YAMA_SPAWN_FIREBALL_COMMAND);
      // Capture tick, then the set's start tick — the second advance is what emits.
      eng.advanceTick(eng.getState().playerPosition);
      eng.advanceTick(eng.getState().playerPosition);

      expect(eng.getLastTickEvents()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'fireball_spawned',
            sourceId: 'yama',
            targetPosition: PLAYER_START_POS,
            fireballIndex: -1,
          }),
        ]),
      );
    });

    it('does NOT rewind the world tick, which would block player attacks', () => {
      const eng = new SimulationEngine({ encounter: new YamaEncounter(), startPos: PLAYER_START_POS });
      eng.setMechanicsConfig({
        yamaMageRange: false,
        waves: false,
        fireballs: true,
        voidFlares: false,
        infiniteHealth: true,
      });

      // Advance well past the early ticks (~tick 5).
      for (let i = 0; i < 40; i++) {
        eng.advanceTick(eng.getState().playerPosition);
      }
      const tickBefore = eng.getState().currentTick;

      eng.executeEncounterCommand(YAMA_SPAWN_FIREBALL_COMMAND);

      // The clock must stay put. Jumping it backward would leave the player's
      // absolute nextAttackTick in the future → unable to attack.
      expect(eng.getState().currentTick).toBe(tickBefore);
    });
  });
});

describe('SimulationEngine attack resources', () => {
  it.each([
    { roll: 0, damage: 3, accurate: true },
    { roll: 0.999999, damage: 0, accurate: false },
  ])('launches seeking quiver arrows and applies $damage damage with accuracy $accurate', ({
    roll,
    damage,
    accurate,
  }) => {
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(),
      startPos: [31, 27],
      combatRandom: () => roll,
      objTypeLoader: {
        load: (id) =>
          new ObjType(id, {
            name: 'test',
            game: 'oldschool',
            environment: 'live',
            revision: 232,
            timestamp: '',
            size: 0,
          }),
        getCount: () => 34000,
        clearCache: () => undefined,
      },
    });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    engine.setEquipment({ weapon: 20997, cape: 28951, amulet: 33639 });
    engine.setCombatSupplies({
      ...createEmptyCombatSupplies(),
      equippedAmmo: { id: 22947 },
      quiverAmmo: { id: 33595 },
    });
    engine.setAttackTarget('yama');

    const events = Array.from({ length: 4 }, () => {
      engine.advanceTick(engine.getState().playerPosition);
      return engine.getLastTickEvents();
    }).flat();

    expect(events.find((event) => isCoreEvent(event, 'attack_started'))).toMatchObject({
      ammoId: 33595,
      ammoSource: 'quiver',
    });
    expect(events.find((event) => isCoreEvent(event, 'hit_applied') && event.targetId === 'yama')).toMatchObject({
      damage,
      accurate,
    });
  });

  function makeAdjacentEngine(): SimulationEngine {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 27] });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    engine.setAttackTarget('yama');
    return engine;
  }

  function makeAdjacentEngineWithoutDamageRoll(): SimulationEngine {
    const npc = createTrackingNpc([10, 10], 0);
    npc.npcTypeId = 999_999;
    const engine = new SimulationEngine({ encounter: new TrackingNpcEncounter(npc), startPos: [10, 11] });
    engine.setAttackTarget(npc.id);
    return engine;
  }

  function withSupplies(overrides: Partial<CombatSupplies>): CombatSupplies {
    return { ...createEmptyCombatSupplies(), ...overrides };
  }

  it('copies combat supplies at the setter and getter boundaries', () => {
    const engine = makeAdjacentEngine();
    const supplies = withSupplies({
      equippedAmmo: { id: 11212 },
      blowpipe: { id: 11230 },
    });

    engine.setCombatSupplies(supplies);
    const current = engine.getCombatSupplies();

    expect(current).toEqual(supplies);
    expect(current).not.toBe(supplies);
    expect(current.equippedAmmo).not.toBe(supplies.equippedAmmo);
    expect(current.blowpipe).not.toBe(supplies.blowpipe);
  });

  it('keeps the worn ammo after an accepted launch and snapshots its identity', () => {
    const engine = makeAdjacentEngine();
    engine.setEquipment({ weapon: 20997 });
    engine.setCombatSupplies(withSupplies({ equippedAmmo: { id: 11212 }, selectedSpell: 'Fire Surge' }));

    engine.advanceTick(engine.getState().playerPosition);

    expect(engine.getCombatSupplies().equippedAmmo).toEqual({ id: 11212 });
    const attackStarted = engine.getLastTickEvents().find((event) => isCoreEvent(event, 'attack_started'));
    expect(attackStarted).toMatchObject({
      sourceId: 'player',
      weaponId: 20997,
      ammoId: 11212,
      ammoSource: 'equipped',
    });
    engine.setEquipment({ weapon: 9185 });
    engine.setCombatSupplies(withSupplies({ quiverAmmo: { id: 9242 } }));
    expect(attackStarted).toMatchObject({ weaponId: 20997, ammoId: 11212, ammoSource: 'equipped' });
  });

  it('does not launch again while the accepted attack is on cooldown', () => {
    const engine = makeAdjacentEngine();
    engine.setEquipment({ weapon: 20997 });
    engine.setCombatSupplies(withSupplies({ equippedAmmo: { id: 11212 } }));
    engine.advanceTick(engine.getState().playerPosition);

    engine.advanceTick(engine.getState().playerPosition);

    expect(engine.getCombatSupplies().equippedAmmo).toEqual({ id: 11212 });
    expect(engine.getLastTickEvents().some((event) => isCoreEvent(event, 'attack_started'))).toBe(false);
  });

  it('draws compatible Dizana quiver ammo when equipped ammo is incompatible', () => {
    const engine = makeAdjacentEngine();
    engine.setEquipment({ weapon: 9185 });
    engine.setCombatSupplies(
      withSupplies({
        equippedAmmo: { id: 28991 },
        quiverAmmo: { id: 9242 },
      }),
    );

    engine.advanceTick(engine.getState().playerPosition);

    expect(engine.getCombatSupplies()).toMatchObject({
      equippedAmmo: { id: 28991 },
      quiverAmmo: { id: 9242 },
    });
    const attackStarted = engine.getLastTickEvents().find((event) => isCoreEvent(event, 'attack_started'));
    expect(attackStarted).toMatchObject({ ammoId: 9242, ammoSource: 'quiver' });
  });

  it('never spends the worn ammunition, whatever cape is worn', () => {
    const engine = makeAdjacentEngine();
    engine.setEquipment({ cape: 28951, weapon: 20997 });
    engine.setCombatSupplies(withSupplies({ equippedAmmo: { id: 11212 } }));

    engine.advanceTick(engine.getState().playerPosition);

    expect(engine.getCombatSupplies().equippedAmmo).toEqual({ id: 11212 });
  });

  it('launches a spell without consuming any RNG', () => {
    // Given: a castable Ice Barrage and an unprofiled adjacent target that needs no damage-sampling RNG.
    const engine = makeAdjacentEngineWithoutDamageRoll();
    engine.setEquipment({ cape: 28951, weapon: 21006 });
    engine.setSelectedAttackStyleIndex(3);
    engine.setCombatSupplies(
      withSupplies({
        selectedSpell: 'Ice Barrage',
        runePouch: {
          kind: 'standard',
          slots: [{ id: 555 }, { id: 565 }, { id: 560 }],
        },
      }),
    );
    const randomSpy = vi.spyOn(Math, 'random');

    try {
      // When: the spell attack launches.
      engine.advanceTick(engine.getState().playerPosition);

      // Then: the launch is observable and no resource decision consumes RNG.
      const attackStarted = engine.getLastTickEvents().find((event) => isCoreEvent(event, 'attack_started'));
      expect(attackStarted).toMatchObject({ sourceId: 'player', spellId: 'Ice Barrage', ammoSource: 'none' });
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('starts a blowpipe attack without consuming any RNG', () => {
    // Given: a loaded blowpipe, a worn Dizana quiver, and a target that needs no damage-sampling RNG.
    const engine = makeAdjacentEngineWithoutDamageRoll();
    engine.setEquipment({ cape: 28951, weapon: 12926 });
    engine.setCombatSupplies(withSupplies({ blowpipe: { id: 11230 } }));
    const randomSpy = vi.spyOn(Math, 'random');

    try {
      // When: the blowpipe attack starts.
      engine.advanceTick(engine.getState().playerPosition);

      // Then: the attack records its blowpipe source and no resource decision consumes RNG.
      const attackStarted = engine.getLastTickEvents().find((event) => isCoreEvent(event, 'attack_started'));
      expect(attackStarted).toMatchObject({ sourceId: 'player', ammoId: 11230, ammoSource: 'blowpipe' });
      expect(randomSpy).not.toHaveBeenCalled();
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('keeps the loaded blowpipe dart - the blowpipe is modeled as always charged', () => {
    const engine = makeAdjacentEngine();
    engine.setEquipment({ weapon: 12926 });
    engine.setCombatSupplies(withSupplies({ blowpipe: { id: 11230 } }));

    engine.advanceTick(engine.getState().playerPosition);

    expect(engine.getCombatSupplies().blowpipe).toEqual({ id: 11230 });
    const attackStarted = engine.getLastTickEvents().find((event) => isCoreEvent(event, 'attack_started'));
    expect(attackStarted).toMatchObject({ ammoId: 11230, ammoSource: 'blowpipe' });
  });

  it('does not launch while moving toward an out-of-range target', () => {
    const npc = createTrackingNpc([10, 10], 0);
    const engine = new SimulationEngine({ encounter: new TrackingNpcEncounter(npc), startPos: [10, 30] });
    engine.setEquipment({ weapon: 20997 });
    engine.setCombatSupplies(withSupplies({ equippedAmmo: { id: 11212 } }));
    engine.setAttackTarget(npc.id);

    engine.advanceTick([10, 30]);

    expect(engine.getCombatSupplies().equippedAmmo).toEqual({ id: 11212 });
    expect(engine.getLastTickEvents().some((event) => isCoreEvent(event, 'attack_started'))).toBe(false);
  });

  it('does not start a ranged attack with no compatible ammo source', () => {
    const engine = makeAdjacentEngine();
    engine.setEquipment({ weapon: 9185 });
    engine.setCombatSupplies(withSupplies({ equippedAmmo: { id: 11212 } }));

    engine.advanceTick(engine.getState().playerPosition);

    expect(engine.getCombatSupplies().equippedAmmo).toEqual({ id: 11212 });
    expect(engine.getLastTickEvents().some((event) => isCoreEvent(event, 'attack_started'))).toBe(false);
  });

  it('retains current combat supplies when reset rebuilds the player actor', () => {
    const engine = makeAdjacentEngine();
    engine.setEquipment({ weapon: 20997 });
    engine.setCombatSupplies(withSupplies({ equippedAmmo: { id: 11212 } }));
    engine.advanceTick(engine.getState().playerPosition);

    engine.reset([31, 27]);

    expect(engine.getCombatSupplies().equippedAmmo).toEqual({ id: 11212 });
  });

  it('leaves the rune pouch untouched when a cast launches - runes are infinite', () => {
    const engine = makeAdjacentEngine();
    const runePouch = {
      kind: 'standard' as const,
      slots: [{ id: 555 }, { id: 565 }, { id: 560 }] as const,
    };
    engine.setEquipment({ weapon: 21006 });
    engine.setSelectedAttackStyleIndex(3);
    engine.setCombatSupplies(withSupplies({ selectedSpell: 'Ice Barrage', runePouch }));

    engine.advanceTick(engine.getState().playerPosition);

    expect(engine.getCombatSupplies().runePouch).toEqual({
      kind: 'standard',
      slots: [{ id: 555 }, { id: 565 }, { id: 560 }],
    });
    const attackStarted = engine.getLastTickEvents().find((event) => isCoreEvent(event, 'attack_started'));
    expect(attackStarted).toMatchObject({ spellId: 'Ice Barrage', ammoSource: 'none' });
  });
});

describe('prayer input does not skew the tick clock', () => {
  it('stamps a prayer change and every later event in the same tick with that tick', () => {
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(DIVINE_SEVERANCE_CONFIG, 0),
      startPos: [31, 37],
    });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });

    engine.queueProtectionPrayer(PrayerType.ProtectMagic);
    engine.advanceTick([32, 38]);

    // `processPrayerChanges` runs after the tick has already been advanced, so reading
    // `worldState.tick + 1` there overshot by one — and via `setTick` it dragged every
    // event emitted later in the tick along with it, movement included.
    const ticks = engine.getLastTickEvents().map((event) => event.tick);
    expect(ticks.length).toBeGreaterThan(1);
    expect(new Set(ticks)).toEqual(new Set([SIMULATION_START_TICK + 1]));
  });
});
