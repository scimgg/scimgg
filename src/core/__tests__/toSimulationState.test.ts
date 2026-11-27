import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BASE_YAMA_CONFIG } from '../../encounters/yamaP3/contractConfig';
import { YamaEncounter } from '../../encounters/yamaP3/YamaEncounter';
import { zukDefinition } from '../../npcs/inferno/zuk';
import { lobbySnapshot } from '../../test/helpers/encounterSnapshot';
import { createZukWaveEncounter } from '../../test/helpers/zukWave';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createDefaultPoisonState, createStatsFromBaseLevels } from '../../types/playerState';
import { type Coordinate, DEFAULT_MECHANICS_CONFIG, type TickNumber } from '../../types/simulation';
import type { NpcActor } from '../actors/NpcActor';
import type { PlayerActor } from '../actors/PlayerActor';
import { scheduleNpcAction } from '../combat/npcActionClock';
import { setArenaConfig, setDefaultArenaConfig } from '../constants';
import type { EncounterOutcome } from '../encounters/outcome';
import { ReplayRecorder } from '../ReplayRecorder';
import { SimulationEngine } from '../SimulationEngine';
import { type EngineSnapshot, toSimulationState, WorldState } from '../WorldState';

function makePlayer(pos: Coordinate = [31, 25]): PlayerActor {
  return {
    id: 'player',
    kind: 'player',
    alive: true,
    position: pos,
    previousPosition: pos,
    facing: 0,
    size: 1,
    vitals: { hp: 99, maxHp: 99 },
    movementPath: [],
    isMoving: false,
    isRunning: false,
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    isRunEnabled: false,
    isSpecialAttackActive: false,
    pendingInputOps: [],
    quickPrayersActive: false,
    runEnergy: { current: 10000, regenCounter: 0 },
    history: new Map<TickNumber, Coordinate>(),
    // Prayer level is real because the pending-prayer projection reads it to size a
    // restore-potion dose; everything else this fixture never touches.
    stats: { prayer: { current: 99, max: 99 } } as any,
    poisonState: createDefaultPoisonState(),
    specialAttack: {} as any,
    combatTimers: {} as any,
    potionBoosts: [],
    inventory: {} as any,
    combatSupplies: createEmptyCombatSupplies(),
    equipmentStats: {} as any,
    prayerState: {} as any,
    equipment: {} as any,
    cooldownTracks: {} as any,
    attackTarget: null,
    autoAttackPause: null,
    attackInteractionActive: true,
    pendingConflictionAttack: null,
    outline: undefined,
  } as any;
}

function makeNpc(id: string, pos: Coordinate = [29, 28], role: 'boss' | 'npc' = 'npc'): NpcActor {
  return {
    id,
    kind: 'npc',
    npcTypeId: 8355,
    archetypeId: 'yama',
    role,
    alive: true,
    position: pos,
    previousPosition: pos,
    facing: 0,
    size: 5,
    vitals: { hp: 100, maxHp: 100 },
    history: new Map<TickNumber, Coordinate>(),
    combat: {
      attackSpeed: 4,
      attackRange: 1,
      attackStyle: 'magic',
      nextActionTick: 0,
      targetId: null,
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
    },
    spawnTick: 0,
    despawnTick: null,
    outline: undefined,
  } as any;
}

function createMockEngineSnapshot(): EngineSnapshot {
  const outcome: EncounterOutcome = {
    phase: 'resolving',
    decisiveTick: 12,
    completionTick: 21,
    primaryActorId: 'boss-1',
    completionActorIds: ['boss-1'],
  };
  return {
    getFailedCondition: () => null,
    getPrayerRestoreProjectionRules: () => ({ allowed: true }),
    getEncounterSnapshot: () => lobbySnapshot(),
    getEncounterOutcome: () => outcome,
    getDamageHistory: () => [],
    getEventLog: () => [],
    getMechanicsConfig: () => DEFAULT_MECHANICS_CONFIG,
    getNpcHistory: () => new Map(),
    getPlayerAttackCooldown: () => 0,
    getPlayerNextAttackTick: () => -1,
    getPlayerAttackSpeed: () => 4,
    getNpcAttackTimer: () => null,
    getIntroActive: () => false,
  };
}

describe('toSimulationState', () => {
  let world: WorldState;
  let engineSnapshot: EngineSnapshot;

  beforeEach(() => {
    world = new WorldState();
    engineSnapshot = createMockEngineSnapshot();
  });

  describe('with player + boss NPC', () => {
    it('returns valid SimulationState with boss NPC data', () => {
      const player = makePlayer([31, 25]);
      const boss = makeNpc('boss-1', [29, 28], 'boss');

      world.actors.set('player', player);
      world.actors.set('boss-1', boss);

      const state = toSimulationState(world, engineSnapshot);

      expect(state.playerPosition).toEqual([31, 25]);
      expect(state.playerHP).toBe(99);
      expect(state.isAlive).toBe(true);

      expect(state.primaryNpcPosition).toEqual([29, 28]);
      expect(state.primaryNpcFacingAngle).toBe(0);
      expect(state.primaryNpcSize).toBe(5);
      expect(state.primaryNpcHistory).toBeInstanceOf(Map);
      expect(state.npcs).toHaveLength(1);
      expect(state.npcs[0]?.id).toBe('boss-1');
      expect(state.npcs[0]?.history).toBeInstanceOf(Map);
    });
  });

  it('exposes the exact typed encounter outcome from the engine boundary', () => {
    world.actors.set('player', makePlayer());

    const state = toSimulationState(world, engineSnapshot);

    expect(state.encounterOutcome).toEqual({
      phase: 'resolving',
      decisiveTick: 12,
      completionTick: 21,
      primaryActorId: 'boss-1',
      completionActorIds: ['boss-1'],
    });
  });

  describe('with player + no NPCs (graceful handling)', () => {
    it('returns valid SimulationState with default NPC values, does not throw', () => {
      const player = makePlayer([31, 25]);
      world.actors.set('player', player);

      const state = toSimulationState(world, engineSnapshot);

      expect(state.playerPosition).toEqual([31, 25]);
      expect(state.playerHP).toBe(99);
      expect(state.isAlive).toBe(true);

      expect(state.primaryNpcPosition).toEqual([0, 0]);
      expect(state.primaryNpcPreviousPosition).toEqual([0, 0]);
      expect(state.primaryNpcFacingAngle).toBe(0);
      expect(state.primaryNpcSize).toBe(1);
      expect(state.primaryNpcHistory).toBeInstanceOf(Map);
      expect(state.primaryNpcHistory.size).toBe(0);
      expect(state.npcs).toEqual([]);
    });
  });

  describe('with player + minion NPCs only (no boss)', () => {
    it('returns valid SimulationState with first minion NPC data', () => {
      const player = makePlayer([31, 25]);
      const minion1 = makeNpc('minion-1', [30, 28], 'npc');
      const minion2 = makeNpc('minion-2', [28, 28], 'npc');

      world.actors.set('player', player);
      world.actors.set('minion-1', minion1);
      world.actors.set('minion-2', minion2);

      const state = toSimulationState(world, engineSnapshot);

      expect(state.playerPosition).toEqual([31, 25]);
      expect(state.isAlive).toBe(true);

      expect(state.primaryNpcPosition).toEqual([30, 28]);
      expect(state.primaryNpcFacingAngle).toBe(0);
      expect(state.primaryNpcSize).toBe(5);
      expect(state.primaryNpcHistory).toBeInstanceOf(Map);
      expect(state.npcs.map((npc) => npc.id)).toEqual(['minion-1', 'minion-2']);
      expect(state.npcs[0]?.history).toBe(state.primaryNpcHistory);
    });
  });

  describe('with player + boss and minion NPCs', () => {
    it('orders npcs with the primary boss first, matching the singular primary fields', () => {
      const player = makePlayer([31, 25]);
      const minion = makeNpc('minion-1', [30, 28], 'npc');
      const boss = makeNpc('boss-1', [29, 28], 'boss');

      world.actors.set('player', player);
      world.actors.set('minion-1', minion);
      world.actors.set('boss-1', boss);

      const state = toSimulationState(world, engineSnapshot);

      expect(state.npcs.map((npc) => npc.id)).toEqual(['boss-1', 'minion-1']);
      expect(state.primaryNpcPosition).toEqual(state.npcs[0]?.position);
      expect(state.primaryNpcPreviousPosition).toEqual(state.npcs[0]?.previousPosition);
      expect(state.primaryNpcFacingAngle).toBe(state.npcs[0]?.facingAngle);
      expect(state.primaryNpcSize).toBe(state.npcs[0]?.size);
      expect(state.primaryNpcHistory).toBe(state.npcs[0]?.history);
    });
  });

  describe('NPC attack timers', () => {
    it.each([14, 17, 20])('preserves the scheduled absolute tick when the world is at tick %i', (tick) => {
      const npc = makeNpc('minion');
      npc.combat.lastAttackTick = 5;
      npc.combat.targetId = 'player';
      scheduleNpcAction(npc.combat, 13, 4);
      world.tick = tick;
      world.actors.set('player', makePlayer());
      world.actors.set(npc.id, npc);

      const state = toSimulationState(world, engineSnapshot);

      expect(state.npcs[0]?.attackTimer).toEqual({ nextAttackTick: 17, attackSpeed: 4 });
    });

    it('copies each NPC clock independently when their attack speeds differ', () => {
      const boss = makeNpc('boss', [29, 28], 'boss');
      const minion = makeNpc('minion');
      boss.combat.targetId = 'player';
      minion.combat.targetId = 'player';
      boss.combat.attackSpeed = 8;
      scheduleNpcAction(boss.combat, 13, 8);
      scheduleNpcAction(minion.combat, 13, 4);
      world.actors.set('player', makePlayer());
      world.actors.set(minion.id, minion);
      world.actors.set(boss.id, boss);

      const state = toSimulationState(world, engineSnapshot);
      scheduleNpcAction(boss.combat, 21, 4);
      boss.combat.attackSpeed = 4;

      expect(state.npcs.map((npc) => npc.attackTimer)).toEqual([
        { nextAttackTick: 21, attackSpeed: 8 },
        { nextAttackTick: 17, attackSpeed: 4 },
      ]);
    });

    it.each([
      { reason: 'no scheduled action', alive: true, attackSpeed: 4, nextActionTick: 0 },
      { reason: 'no attack cadence', alive: true, attackSpeed: 0, nextActionTick: 17 },
      { reason: 'dead NPC', alive: false, attackSpeed: 4, nextActionTick: 17 },
    ])('omits the timer when there is $reason', ({ alive, attackSpeed, nextActionTick }) => {
      const npc = makeNpc('npc');
      npc.alive = alive;
      npc.combat.attackSpeed = attackSpeed;
      npc.combat.nextActionTick = nextActionTick;
      npc.combat.targetId = 'player';
      world.actors.set('player', makePlayer());
      world.actors.set(npc.id, npc);

      const state = toSimulationState(world, engineSnapshot);

      expect(state.npcs[0]).not.toHaveProperty('attackTimer');
    });

    it.each([true, false])('preserves optional timer data in replay frames when captured=%s', (captured) => {
      const npc = makeNpc('minion');
      npc.combat.targetId = 'player';
      scheduleNpcAction(npc.combat, 13, 4);
      world.actors.set('player', makePlayer());
      world.actors.set(npc.id, npc);
      const state = toSimulationState(world, engineSnapshot);
      if (!captured) {
        state.npcs = state.npcs.map(({ attackTimer, ...snapshot }) => snapshot);
      }
      const recorder = new ReplayRecorder();

      recorder.recordFrame(14, [31, 25], state, [], { recordedAtMs: 0 });

      const replayNpc = recorder.getFrame(0)?.state.npcs[0];
      if (captured) {
        expect(replayNpc?.attackTimer).toEqual({ nextAttackTick: 17, attackSpeed: 4 });
      } else {
        expect(replayNpc).not.toHaveProperty('attackTimer');
      }
    });

    it.each([
      { reason: 'null target', targetId: null, targetAlive: true },
      { reason: 'missing target', targetId: 'missing', targetAlive: true },
      { reason: 'dead target', targetId: 'player', targetAlive: false },
    ])('omits the generic timer when there is a $reason', ({ targetId, targetAlive }) => {
      const npc = makeNpc('minion');
      npc.combat.targetId = targetId;
      scheduleNpcAction(npc.combat, 13, 4);
      const player = makePlayer();
      player.alive = targetAlive;
      world.actors.set(player.id, player);
      world.actors.set(npc.id, npc);

      const state = toSimulationState(world, engineSnapshot);

      expect(state.npcs[0]).not.toHaveProperty('attackTimer');
    });

    it.each([
      { reason: 'null target', targetId: null, targetAlive: true },
      { reason: 'missing target', targetId: 'missing', targetAlive: true },
      { reason: 'dead target', targetId: 'player', targetAlive: false },
      { reason: 'live target', targetId: 'player', targetAlive: true },
    ])('prefers a definition-owned schedule over the generic clock with a $reason', ({ targetId, targetAlive }) => {
      const npc = makeNpc('boss', [29, 28], 'boss');
      npc.combat.targetId = targetId;
      scheduleNpcAction(npc.combat, 13, 4);
      const player = makePlayer();
      player.alive = targetAlive;
      world.actors.set(player.id, player);
      world.actors.set(npc.id, npc);
      engineSnapshot.getNpcAttackTimer = () => ({ nextAttackTick: 39, attackSpeed: 7 });

      const state = toSimulationState(world, engineSnapshot);

      expect(state.npcs[0]?.attackTimer).toEqual({ nextAttackTick: 39, attackSpeed: 7 });
    });
  });

  describe('live NPC attack timers', () => {
    afterEach(() => {
      setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
      setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
    });

    it('reports no Yama timer until the encounter enables its attacks', () => {
      const engine = new SimulationEngine({ encounter: new YamaEncounter(BASE_YAMA_CONFIG, 7), startPos: [31, 37] });

      expect(engine.getState().npcs[0]).not.toHaveProperty('attackTimer');
    });

    it.each([
      { tick: 1, nextAttackTick: 4 },
      { tick: 4, nextAttackTick: 11 },
      { tick: 10, nextAttackTick: 11 },
      { tick: 11, nextAttackTick: 18 },
    ])("projects Yama's beat cadence at tick $tick", ({ tick, nextAttackTick }) => {
      const engine = new SimulationEngine({ encounter: new YamaEncounter(BASE_YAMA_CONFIG, 7), startPos: [31, 37] });
      engine.setMechanicsConfig({ infiniteHealth: true, waves: false, voidFlares: false });
      for (let current = 0; current < tick; current++) engine.advanceTick([31, 37]);

      expect(engine.getState().npcs[0]?.attackTimer).toEqual({ nextAttackTick, attackSpeed: 7 });
    });

    it('projects Zuk off its own cast counter, and never for its shield', () => {
      const engine = new SimulationEngine({ encounter: createZukWaveEncounter(7) });
      engine.setMechanicsConfig({ infiniteHealth: true, zukSets: false });

      const state = engine.getState();

      expect(state.npcs.find((npc) => npc.archetypeId === 'zuk')?.attackTimer).toEqual({
        nextAttackTick: 13,
        attackSpeed: 10,
      });
      expect(state.npcs.find((npc) => npc.archetypeId === 'zuk_shield')).not.toHaveProperty('attackTimer');
    });

    // /w/Soulreaper_axe: one stack decays every 50 ticks without an axe attack.
    it('sheds Soulreaper axe stacks on the live engine one per 50 ticks', () => {
      const engine = new SimulationEngine({ encounter: new YamaEncounter(BASE_YAMA_CONFIG, 7), startPos: [31, 37] });
      engine.setMechanicsConfig({ infiniteHealth: true, waves: false, voidFlares: false });
      const player = engine['worldState'].getPlayer();
      if (!player) throw new TypeError('Missing player');
      player.soulreaper = { stacks: 2, decayTick: 50 };
      const advanceTo = (tick: number) => {
        while (engine.getState().currentTick < tick) engine.advanceTick([31, 37]);
        return engine.getState().soulreaperStacks;
      };

      expect(advanceTo(49)).toBe(2);
      expect(advanceTo(50)).toBe(1);
      expect(advanceTo(99)).toBe(1);
      expect(advanceTo(100)).toBeUndefined();
    });

    it.each([
      { name: 'ordinary axe attack', weaponId: 28338, special: false, expectedDamage: 30, expectedStacks: 3 },
      { name: 'Behead', weaponId: 28338, special: true, expectedDamage: 30, expectedStacks: undefined },
      { name: 'non-axe attack', weaponId: 4151, special: false, expectedDamage: undefined, expectedStacks: 1 },
    ])('$name takes precedence over decay on the attack tick', ({
      weaponId,
      special,
      expectedDamage,
      expectedStacks,
    }) => {
      const engine = new SimulationEngine({
        encounter: new YamaEncounter(BASE_YAMA_CONFIG, 7),
        startPos: [31, 37],
        combatRandom: () => 0.999,
      });
      engine.setMechanicsConfig({ infiniteHealth: true, waves: false, voidFlares: false });
      engine.setPlayerStats(
        createStatsFromBaseLevels({
          attack: 99,
          strength: 99,
          defence: 99,
          ranged: 99,
          magic: 99,
          prayer: 99,
          hitpoints: 99,
          agility: 99,
        }),
      );
      const player = engine['worldState'].getPlayer();
      if (!player) throw new TypeError('Missing player');
      const npc = makeNpc('soulreaper-target', [32, 37]);
      npc.npcTypeId = 1;
      npc.formulaStats = {
        levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
        offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
        defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
        alwaysAccuratePlayerHit: true,
      };
      engine['worldState'].registerNpc(npc);

      // Keep the target in melee range and use the engine's actual auto-attack path.
      player.equipment = { weapon: weaponId };
      player.equipmentStats = { ...player.equipmentStats, meleeStrength: 100 };
      engine.applyAction({ type: 'attackTarget', targetId: npc.id });
      player.isSpecialAttackActive = special;
      player.specialAttack.energy = 100;

      // Set the real combat cooldown to the next engine tick, making the attack and decay
      // boundary coincide without needing a setup swing.
      const attackTick = engine.getState().currentTick + 1;
      engine['combatSystem']['nextAttackTickByActor'].set(player.id, attackTick);
      player.soulreaper = { stacks: 2, decayTick: attackTick };
      engine.advanceTick([31, 37]);

      const hit = engine['worldState'].pendingHits.find((pending) => pending.sourceId === player.id);
      if (expectedDamage !== undefined)
        expect(hit).toMatchObject({ rolledDamage: expectedDamage, accuracySucceeded: true });
      expect(player.soulreaper?.stacks).toBe(expectedStacks);
      if (expectedStacks !== undefined) expect(player.soulreaper?.decayTick).toBe(attackTick + 50);
    });

    it("tightens Zuk's projected cadence once it is enraged", () => {
      const engine = new SimulationEngine({ encounter: createZukWaveEncounter(7) });
      engine.setMechanicsConfig({ infiniteHealth: true, zukSets: false });
      const boss = engine['worldState'].getNpc('zuk');
      const bossState = boss && zukDefinition.getState(boss);
      if (!bossState) throw new TypeError('Missing Zuk state');
      bossState.lastCastTick = 13;
      bossState.enragedAt = 16;
      for (let current = 0; current < 17; current++) engine.advanceTick(engine.getState().playerPosition);

      expect(engine.getState().npcs.find((npc) => npc.archetypeId === 'zuk')?.attackTimer).toEqual({
        nextAttackTick: 20,
        attackSpeed: 7,
      });
    });
  });

  // Absent at zero, so a run that never stacks the axe carries no such field.
  it('reports Soulreaper axe stacks only while the player has any', () => {
    const player = makePlayer();
    world.actors.set('player', player);
    expect(toSimulationState(world, engineSnapshot)).not.toHaveProperty('soulreaperStacks');

    player.soulreaper = { stacks: 3, decayTick: 60 };
    expect(toSimulationState(world, engineSnapshot).soulreaperStacks).toBe(3);
  });

  describe('NPC movement and facing facts', () => {
    // B:2208 sim tiles: a run (24,39) -> (23,40) -> (23,41).
    it('publishes a multi-step path and omits a one-step or empty one', () => {
      const runner = makeNpc('runner', [23, 41]);
      runner.previousPosition = [24, 39];
      runner.movementPath = [
        [23, 40],
        [23, 41],
      ];
      const walker = makeNpc('walker', [10, 11]);
      walker.previousPosition = [10, 10];
      walker.movementPath = [[10, 11]];
      const still = makeNpc('still');
      still.movementPath = [];
      world.actors.set('player', makePlayer());
      for (const npc of [runner, walker, still]) world.actors.set(npc.id, npc);

      const [runnerState, walkerState, stillState] = toSimulationState(world, engineSnapshot).npcs;

      expect(runnerState?.movementPath).toEqual([
        [23, 40],
        [23, 41],
      ]);
      expect(walkerState).not.toHaveProperty('movementPath');
      expect(stillState).not.toHaveProperty('movementPath');
    });

    it.each([
      { facesSteps: true, isMoving: true, expected: null },
      { facesSteps: true, isMoving: false, expected: 'player' },
      { facesSteps: false, isMoving: true, expected: 'player' },
      { facesSteps: undefined, isMoving: true, expected: 'player' },
    ])('publishes target $expected when facesSteps=$facesSteps and moving=$isMoving', ({
      facesSteps,
      isMoving,
      expected,
    }) => {
      const npc = makeNpc('npc');
      npc.combat.targetId = 'player';
      npc.isMoving = isMoving;
      if (facesSteps !== undefined) npc.facesStepsWhileMoving = facesSteps;
      world.actors.set('player', makePlayer());
      world.actors.set(npc.id, npc);

      expect(toSimulationState(world, engineSnapshot).npcs[0]?.combatTargetId).toBe(expected);
    });

    it('keeps the generic attack timer on a moving NPC that faces its steps', () => {
      const npc = makeNpc('npc');
      npc.combat.targetId = 'player';
      npc.isMoving = true;
      npc.facesStepsWhileMoving = true;
      scheduleNpcAction(npc.combat, 13, 4);
      world.actors.set('player', makePlayer());
      world.actors.set(npc.id, npc);

      expect(toSimulationState(world, engineSnapshot).npcs[0]?.attackTimer).toEqual({
        nextAttackTick: 17,
        attackSpeed: 4,
      });
    });

    it('publishes a delayed death animation tick only while the NPC is dead', () => {
      const npc = makeNpc('npc');
      npc.deathAnimationTick = 15;
      world.actors.set('player', makePlayer());
      world.actors.set(npc.id, npc);
      expect(toSimulationState(world, engineSnapshot).npcs[0]).not.toHaveProperty('deathAnimationTick');

      npc.alive = false;
      expect(toSimulationState(world, engineSnapshot).npcs[0]?.deathAnimationTick).toBe(15);
    });
  });

  describe('error handling', () => {
    it('throws when player is missing', () => {
      const boss = makeNpc('boss-1', [29, 28], 'boss');
      world.actors.set('boss-1', boss);

      expect(() => toSimulationState(world, engineSnapshot)).toThrow('WorldState missing required player actor');
    });
  });
});
