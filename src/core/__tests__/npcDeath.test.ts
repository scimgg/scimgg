import { afterEach, describe, expect, it } from 'vitest';
import { LobbyEncounter } from '../../encounters/lobby/LobbyEncounter';
import { createWarbander, WARBAND_SLOT_OFFSETS } from '../../npcs/colosseum/warband';
import { enqueueEnginePendingHit } from '../../test/helpers/pendingHits';
import type { NpcActor } from '../actors/NpcActor';
import { advanceNpcHitpointRegen } from '../combat/npcRegeneration';
import { setArenaConfig, setDefaultArenaConfig } from '../constants';
import type { EncounterContext, NpcAttackRequest } from '../encounters/types';
import {
  canNpcActThisTurn,
  canReceiveHealing,
  canReceiveKillTickSpell,
  canReceiveNewAttack,
  claimNpcDeathAnimation,
  isCurrentActorInstance,
  isNpcDeathDue,
  isNpcDeathReleaseDue,
  isNpcKillTurnReleaseDue,
  markNpcDead,
  promoteHitQueueDeath,
  pruneGraceStartTick,
  queuedDeathAnimationTick,
  recordNpcLethalTransition,
  recordNpcStep,
  reviveNpc,
  startNpcDeath,
} from '../npcDeath';
import { createNpcDefinition, NpcDefinitionCollection } from '../npcs';
import { SimulationEngine } from '../SimulationEngine';
import { WorldState } from '../WorldState';

// The engine-backed cases install their encounter's arena config module-wide.
afterEach(() => {
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

function npc(overrides: Partial<NpcActor> = {}): NpcActor {
  return {
    id: 'npc',
    kind: 'npc',
    alive: true,
    position: [10, 10],
    previousPosition: [10, 10],
    facing: 0,
    size: 1,
    vitals: { hp: 0, maxHp: 10 },
    npcTypeId: 1,
    archetypeId: 'test',
    history: new Map(),
    combat: {
      attackSpeed: 4,
      attackRange: 1,
      attackStyle: 'melee',
      nextActionTick: 0,
      lastAttackTick: null,
      targetId: 'player',
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
      retaliation: { mode: 'standard', pending: [{ tick: 6, sourceId: 'player' }], lastIncomingAttackTick: 4 },
    },
    ...overrides,
  };
}

describe('NPC life state', () => {
  it('keeps a queued hit-queue kill acting on K only, and stops it once processing starts', () => {
    const actor = npc({ deathPolicy: 'queued' });
    recordNpcLethalTransition(actor, 5, 'hit-queue');

    expect(actor).toMatchObject({ alive: false, death: { status: 'pending', killTick: 5, processTick: 6 } });
    expect([canNpcActThisTurn(actor, 5), canNpcActThisTurn(actor, 6)]).toEqual([true, false]);
    expect([canReceiveNewAttack(actor), canReceiveHealing(actor)]).toEqual([false, false]);

    startNpcDeath(actor);
    expect(canNpcActThisTurn(actor, 5)).toBe(false);
    expect(actor.combat.retaliation).toMatchObject({ pending: [], lastIncomingAttackTick: null });
  });

  it('lets a kill-tick spell reach a pending death only, never a processed one', () => {
    const living = npc({ vitals: { hp: 5, maxHp: 10 } });
    const pending = npc({ deathPolicy: 'queued' });
    recordNpcLethalTransition(pending, 5, 'hit-queue');
    const started = npc({ deathPolicy: 'queued' });
    recordNpcLethalTransition(started, 5, 'hit-queue');
    startNpcDeath(started);
    // An immediate NPC's death is due, and processed by the engine, on the lethal transition itself.
    const immediate = npc();
    recordNpcLethalTransition(immediate, 5, 'hit-queue');
    expect(isNpcDeathDue(immediate, 5)).toBe(true);
    startNpcDeath(immediate);

    expect(
      [living, pending, started, immediate].map((actor) => [
        canReceiveNewAttack(actor),
        canReceiveKillTickSpell(actor),
      ]),
    ).toEqual([
      [true, true],
      [false, true],
      [false, false],
      [false, false],
    ]);
  });

  it.each([
    { policy: undefined, cause: 'hit-queue', processTick: 5 },
    { policy: 'queued', cause: 'timer', processTick: 6 },
    { policy: 'queued', cause: 'scripted', processTick: 5 },
  ] as const)('processes a $cause death under $policy policy on $processTick', ({ policy, cause, processTick }) => {
    const actor = npc(policy === undefined ? {} : { deathPolicy: policy });
    recordNpcLethalTransition(actor, 5, cause);
    expect(actor.death?.processTick).toBe(processTick);
    expect(canNpcActThisTurn(actor, 5)).toBe(processTick > 5);
  });

  it('promotes only a pending hit-queue death on its kill tick, never a timer kill', () => {
    const hitKill = npc({ deathPolicy: 'queued' });
    recordNpcLethalTransition(hitKill, 5, 'hit-queue');
    promoteHitQueueDeath(hitKill, 6);
    expect(hitKill.death?.processTick).toBe(6);
    promoteHitQueueDeath(hitKill, 5);
    expect(hitKill.death?.processTick).toBe(5);

    const timerKill = npc({ deathPolicy: 'queued' });
    recordNpcLethalTransition(timerKill, 5, 'timer');
    promoteHitQueueDeath(timerKill, 5);
    expect(timerKill.death?.processTick).toBe(6);
  });

  it('records the death exactly once per life', () => {
    const actor = npc();
    recordNpcLethalTransition(actor, 5, 'hit-queue');
    expect(() => recordNpcLethalTransition(actor, 5, 'hit-queue')).toThrow(/already has a death record/);
  });

  it('starts a new life on revival, clearing only the despawn tick the death set', () => {
    const killed = npc();
    markNpcDead(killed, 5);
    expect(killed).toMatchObject({ despawnTick: 5, death: { status: 'started', causeStage: 'scripted' } });
    reviveNpc(killed);
    expect(killed).toMatchObject({ alive: true, lifeGeneration: 1 });
    expect(killed.death).toBeUndefined();
    expect(killed.despawnTick).toBeUndefined();
    expect([canReceiveNewAttack(killed), canReceiveHealing(killed)]).toEqual([true, true]);

    const fused = npc({ despawnTick: 40 });
    markNpcDead(fused, 5);
    reviveNpc(fused);
    expect(fused.despawnTick).toBe(40);
  });

  it('treats a revived instance as current and a same-id replacement as not', () => {
    const world = new WorldState();
    const actor = npc();
    world.registerNpc(actor);
    markNpcDead(actor, 5);
    reviveNpc(actor);
    expect(isCurrentActorInstance(world, actor)).toBe(true);
    world.registerNpc(npc());
    expect(isCurrentActorInstance(world, actor)).toBe(false);
  });

  it('stops regeneration on the lethal transition', () => {
    const actor = npc({ vitals: { hp: 5, maxHp: 10 }, hitpointRegenNextTick: 5 });
    actor.death = { status: 'pending', killTick: 4, processTick: 5, causeStage: 'timer' };
    advanceNpcHitpointRegen(actor, 5);
    expect(actor.vitals.hp).toBe(5);
  });

  it('runs the queued prune grace from the death animation when it is later than the kill', () => {
    const actor = npc({ deathPolicy: 'queued' });
    recordNpcStep(actor, 4);
    recordNpcLethalTransition(actor, 5, 'hit-queue');
    actor.despawnTick = 5;
    expect(actor.deathAnimationTick).toBe(7);
    expect(pruneGraceStartTick(actor)).toBe(7);

    const immediate = npc({ despawnTick: 5, deathAnimationTick: 7 });
    recordNpcLethalTransition(immediate, 5, 'hit-queue');
    expect(pruneGraceStartTick(immediate)).toBe(5);
  });
});

describe('shared death animation rule', () => {
  // A scripted death (Zuk's minion cleanup) animates as it is processed, whatever the member last did,
  // and its definition is told once however many callers reach it.
  it('animates a scripted queued death at once and claims its presentation exactly once', () => {
    const warbander = createWarbander({
      id: 'w',
      role: 'archer',
      position: [20, 20],
      spawnTick: 0,
      slotOffset: WARBAND_SLOT_OFFSETS.archer,
    });
    recordNpcStep(warbander, 99);

    markNpcDead(warbander, 100);

    expect(warbander.deathAnimationTick).toBe(100);
    expect([100, 100, 101].map((tick) => claimNpcDeathAnimation(warbander, tick))).toEqual([true, false, false]);
  });

  // The warband capture cases this rule took over from the warband's own formula (B:2210, B:2218,
  // B:1882, B:2385) and the window edges around them, for a lethal-last kill (processTick = K + 1).
  it.each([
    { stepsBeforeKill: [0], expected: 3 },
    { stepsBeforeKill: [1], expected: 2 },
    { stepsBeforeKill: [2], expected: 1 },
    { stepsBeforeKill: [3], expected: 1 },
    { stepsBeforeKill: [5, 4], expected: 1 },
    { stepsBeforeKill: [], expected: 1 },
  ])('starts a lethal-last death animation $expected ticks after K with steps $stepsBeforeKill ticks before it', ({
    stepsBeforeKill,
    expected,
  }) => {
    const killTick = 100;
    const warbander = createWarbander({
      id: 'w',
      role: 'archer',
      position: [20, 20],
      spawnTick: 0,
      slotOffset: WARBAND_SLOT_OFFSETS.archer,
    });
    for (const before of [...stepsBeforeKill].sort((a, b) => b - a)) recordNpcStep(warbander, killTick - before);

    recordNpcLethalTransition(warbander, killTick, 'hit-queue');

    expect(warbander.deathPolicy).toBe('queued');
    expect(warbander.deathAnimationTick).toBe(killTick + expected);
    expect(queuedDeathAnimationTick(killTick + 1, warbander.lastStepTick)).toBe(killTick + expected);
  });
});

describe('death-animation release hook', () => {
  type WindupState = { releaseTick: number | null; started: number[]; released: number[] };
  const windup = createNpcDefinition<WindupState, undefined>({
    id: 'test-windup',
    deathPolicy: 'queued',
    move: false,
    // Commits to a release 3 ticks after its first turn, then tries to start a new attack every turn.
    tick: ({ actor, context }) => {
      actor.state.started.push(context.tick);
      actor.state.releaseTick ??= context.tick + 3;
      if (context.tick !== actor.state.releaseTick) return { environmentalDamages: [] };
      return { environmentalDamages: [], npcAttacks: [windupAttack(actor.id)] };
    },
    releaseOnDeathAnimation: ({ actor, context }) => {
      actor.state.released.push(context.tick);
      return actor.state.releaseTick === context.tick ? [windupAttack(actor.id)] : [];
    },
  });

  function windupAttack(attackerId: string): NpcAttackRequest {
    return {
      attackerId,
      targetId: 'player',
      style: 'magic',
      attackKind: 'magic_fire',
      rolledDamage: 5,
      accuracySucceeded: true,
      impactDelayTicks: 2,
      sourceDeathPolicy: 'persist',
    };
  }

  function fixture(killImpactTick: number) {
    const actor = windup.createActor(npc({ id: 'windup', vitals: { hp: 10, maxHp: 10 }, spawnTick: 0 }), {
      releaseTick: null,
      started: [],
      released: [],
    });
    const definitions = new NpcDefinitionCollection([windup.register(undefined)]);
    class Fixture extends LobbyEncounter {
      override createNpcs() {
        return [actor];
      }
      getNpcDefinitions() {
        return definitions;
      }
      processNpcTick(npcActor: NpcActor, ctx: EncounterContext) {
        return definitions.tick(npcActor, { ...ctx, random: () => 0.5 });
      }
    }
    const engine = new SimulationEngine({ encounter: new Fixture(), startPos: [31, 25] });
    engine.setMechanicsConfig({ infiniteHealth: true });
    actor.position = [31, 27];
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: actor.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 0,
      impactTick: killImpactTick,
      rolledDamage: 10,
      accuracySucceeded: true,
    });
    for (let tick = 1; tick <= 8; tick++) engine.advanceTick([31, 25]);
    return { actor, engine };
  }

  it('launches the committed release on the death-animation tick and lands it after its flight', () => {
    // First turn 1 commits a release at 4; killed at 3, its death animates at 4.
    const { actor, engine } = fixture(3);
    expect(actor.deathAnimationTick).toBe(4);
    expect(actor.state.started).toEqual([1, 2, 3]);
    expect(actor.state.released).toEqual([4]);
    expect(engine.getDamageHistory().filter((hit) => hit.targetId === 'player')).toMatchObject([
      { tick: 6, attackType: 'magic', baseDamage: 5 },
    ]);
  });

  it('never starts a new attack once dying, and asks for releases on the death-animation tick only', () => {
    // Killed at 2, animating at 3: the release due at 4 is lost.
    const { actor, engine } = fixture(2);
    expect(actor.deathAnimationTick).toBe(3);
    expect(actor.state.started).toEqual([1, 2]);
    expect(actor.state.released).toEqual([3]);
    expect(engine.getDamageHistory().filter((hit) => hit.targetId === 'player')).toEqual([]);

    const world = engine['worldState'];
    const combat = engine['combatSystem'];
    const bridge = engine['buildCombatBridge']({ enablePendingHits: true });
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player');
    const request = { attacker: actor, target: player, attack: windupAttack(actor.id) };
    world.tick = 3;
    expect(combat.processAttackRequest(world, request, bridge)).toBe(false);
    expect(combat.processDeathReleaseRequest(world, request, bridge, 'death-animation')).toBe(true);
    world.tick = 4;
    expect(combat.processDeathReleaseRequest(world, request, bridge, 'death-animation')).toBe(false);
  });

  it('releases nothing for a scripted death', () => {
    const actor = npc({ deathPolicy: 'queued' });
    markNpcDead(actor, 5);
    expect(actor.deathAnimationTick).toBe(5);
    expect(isNpcDeathReleaseDue(actor, 5)).toBe(false);
  });
});

describe('kill-turn release hook', () => {
  type CommittedState = { releaseTick: number | null; turns: number[]; animationReleases: number[] };
  const committed = createNpcDefinition<CommittedState, undefined>({
    id: 'test-committed',
    deathPolicy: 'queued',
    move: false,
    // Commits to an attack 3 ticks after its first turn and launches it then.
    tick: ({ actor, context }) => {
      actor.state.turns.push(context.tick);
      actor.state.releaseTick ??= context.tick + 3;
      if (context.tick !== actor.state.releaseTick) return { environmentalDamages: [] };
      return { environmentalDamages: [], npcAttacks: [committedAttack(actor.id)] };
    },
    // The other contract: asked on the death-animation tick, with nothing of its own to release.
    releaseOnDeathAnimation: ({ actor, context }) => {
      actor.state.animationReleases.push(context.tick);
      return [];
    },
  });

  function committedAttack(attackerId: string): NpcAttackRequest {
    return {
      attackerId,
      targetId: 'player',
      style: 'magic',
      attackKind: 'magic_fire',
      rolledDamage: 5,
      accuracySucceeded: true,
      impactDelayTicks: 2,
      sourceDeathPolicy: 'persist',
    };
  }

  /** Killed on 4, the tick its committed attack is due; a trailing hit on 4 promotes the death to K. */
  function fixture(options: { readonly promoted: boolean; readonly steppedOn?: number }) {
    const actor = committed.createActor(npc({ id: 'committed', vitals: { hp: 10, maxHp: 10 }, spawnTick: 0 }), {
      releaseTick: null,
      turns: [],
      animationReleases: [],
    });
    const definitions = new NpcDefinitionCollection([committed.register(undefined)]);
    const killTurns: number[] = [];
    class Fixture extends LobbyEncounter {
      override createNpcs() {
        return [actor];
      }
      getNpcDefinitions() {
        return definitions;
      }
      processNpcTick(npcActor: NpcActor, ctx: EncounterContext) {
        return definitions.tick(npcActor, { ...ctx, random: () => 0.5 });
      }
      releaseNpcKillTurn(npcActor: NpcActor, ctx: EncounterContext) {
        killTurns.push(ctx.tick);
        const state = committed.getState(npcActor);
        return state?.releaseTick === ctx.tick ? [committedAttack(npcActor.id)] : [];
      }
    }
    const engine = new SimulationEngine({ encounter: new Fixture(), startPos: [31, 25] });
    engine.setMechanicsConfig({ infiniteHealth: true });
    actor.position = [31, 27];
    const hit = (rolledDamage: number) =>
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: actor.id,
        style: 'range',
        attackKind: 'range_arrow',
        launchTick: 0,
        impactTick: 4,
        rolledDamage,
        accuracySucceeded: true,
      });
    hit(10);
    if (options.promoted) hit(1);
    for (let tick = 1; tick <= 8; tick++) {
      if (tick === options.steppedOn) recordNpcStep(actor, tick);
      engine.advanceTick([31, 25]);
    }
    const playerHits = engine.getDamageHistory().filter((entry) => entry.targetId === 'player');
    return { actor, killTurns, playerHits };
  }

  it('leaves a pending death its ordinary kill turn, never asking the hook', () => {
    const { actor, killTurns, playerHits } = fixture({ promoted: false });
    expect(actor.death).toMatchObject({ killTick: 4, processTick: 5 });
    expect(actor.state.turns).toEqual([1, 2, 3, 4]);
    expect(killTurns).toEqual([]);
    expect(playerHits).toMatchObject([{ tick: 6, baseDamage: 5 }]);
  });

  it('asks the encounter once for a promoted kill and launches the attack due on that turn', () => {
    const { actor, killTurns, playerHits } = fixture({ promoted: true });
    expect(actor.death).toMatchObject({ killTick: 4, processTick: 4, status: 'started' });
    expect(actor.state.turns).toEqual([1, 2, 3]);
    expect(killTurns).toEqual([4]);
    expect(playerHits).toMatchObject([{ tick: 6, baseDamage: 5 }]);
    // The death-animation release is its own contract, asked on its own tick.
    expect(actor.state.animationReleases).toEqual([4]);
  });

  it('releases on the kill turn when a recent step puts the death animation later', () => {
    const { actor, killTurns, playerHits } = fixture({ promoted: true, steppedOn: 3 });
    expect(actor.deathAnimationTick).toBe(6);
    expect(killTurns).toEqual([4]);
    expect(playerHits).toMatchObject([{ tick: 6, baseDamage: 5 }]);
    expect(actor.state.animationReleases).toEqual([6]);
  });

  it('is due only on the kill tick of a started, non-scripted queued death', () => {
    const pending = npc({ deathPolicy: 'queued' });
    recordNpcLethalTransition(pending, 5, 'hit-queue');
    expect(isNpcKillTurnReleaseDue(pending, 5)).toBe(false);

    const promoted = npc({ deathPolicy: 'queued' });
    recordNpcLethalTransition(promoted, 5, 'hit-queue');
    promoteHitQueueDeath(promoted, 5);
    startNpcDeath(promoted);
    expect([4, 5, 6].map((tick) => isNpcKillTurnReleaseDue(promoted, tick))).toEqual([false, true, false]);

    const scripted = npc({ deathPolicy: 'queued' });
    markNpcDead(scripted, 5);
    expect(isNpcKillTurnReleaseDue(scripted, 5)).toBe(false);

    const immediate = npc();
    recordNpcLethalTransition(immediate, 5, 'hit-queue');
    startNpcDeath(immediate);
    expect(isNpcKillTurnReleaseDue(immediate, 5)).toBe(false);
  });

  it('commits a kill-turn release only on its own gate and only against a living target', () => {
    const { actor } = fixture({ promoted: true, steppedOn: 3 });
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    const world = engine['worldState'];
    const combat = engine['combatSystem'];
    const bridge = engine['buildCombatBridge']({ enablePendingHits: true });
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player');
    world.actors.set(actor.id, actor);
    const request = { attacker: actor, target: player, attack: committedAttack(actor.id) };
    world.tick = 4;
    expect(combat.processAttackRequest(world, request, bridge)).toBe(false);
    // On K the animation (6) is not due, so only the kill-turn gate opens.
    expect(combat.processDeathReleaseRequest(world, request, bridge, 'death-animation')).toBe(false);
    player.alive = false;
    expect(combat.processDeathReleaseRequest(world, request, bridge, 'kill-turn')).toBe(false);
    player.alive = true;
    expect(combat.processDeathReleaseRequest(world, request, bridge, 'kill-turn')).toBe(true);
    world.tick = 5;
    expect(combat.processDeathReleaseRequest(world, request, bridge, 'kill-turn')).toBe(false);
  });
});
