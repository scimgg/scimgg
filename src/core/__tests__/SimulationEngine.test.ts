import { afterEach, describe, expect, it, vi } from 'vitest';
import { getMonsterFormulaStats } from '../../data/monsterData';
import { LobbyEncounter } from '../../encounters/lobby/LobbyEncounter';
import { VOID_FLARE_CHARGE_TICKS } from '../../encounters/yamaP3/contractConfig';
import { YamaEncounter } from '../../encounters/yamaP3/YamaEncounter';
import { createVoidFlareActor } from '../../npcs/yama/voidFlare';
import type { CacheInfo } from '../../rs/cache/CacheInfo';
import { ObjType } from '../../rs/config/objtype/ObjType';
import { DummyTypeLoader } from '../../rs/config/TypeLoader';
import { enqueueEnginePendingHit } from '../../test/helpers/pendingHits';
import { createZukWaveEncounter } from '../../test/helpers/zukWave';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyInventory } from '../../types/inventory';
import { createStatsFromBaseLevels, type PlayerStats } from '../../types/playerState';
import { type Coordinate, type MechanicsConfig, PrayerType } from '../../types/simulation';
import type { NpcActor } from '../actors/NpcActor';
import type { PrevalidatedAttackRequest } from '../combat/CombatSystem';
import { applyNpcPoison, POISON_PERIOD_TICKS } from '../combat/npcPoison';
import { projectFirstPartyPlayerAttack } from '../combat/player/firstPartyPlayerAttack';
import { formulaStyleToAttackKind, formulaStyleToDamageType, getFormulaStyle } from '../combat/weaponCombatData';
import { DEAD_ACTOR_PRUNE_GRACE_TICKS, setArenaConfig } from '../constants';
import type {
  EncounterContext,
  EncounterEngineContext,
  EncounterEngineRules,
  EnvironmentalDamage,
} from '../encounters/types';
import { isCoreEvent } from '../events/types';
import { createNpcDefinition, NpcDefinitionCollection } from '../npcs';
import { ReplaySafetyError } from '../replaySafety';
import { ReplayTakeoverWork } from '../replayTakeover';
import { type EngineAction, SimulationEngine } from '../SimulationEngine';
import type { WorldState } from '../WorldState';

describe('SimulationEngine attack style defaults', () => {
  it('uses the loadout spellbook when a staff is equipped', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    engine.setCombatSupplies({ ...createEmptyCombatSupplies(), spellbook: 'ancient' });

    engine.setEquipment({ weapon: 21006 });

    expect(engine.getState().selectedAttackStyleIndex).toBe(3);
  });

  it('recomputes an unremembered staff default when the spellbook changes', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    engine.setEquipment({ weapon: 21006 });

    engine.setCombatSupplies({ ...createEmptyCombatSupplies(), spellbook: 'standard' });

    expect(engine.getState().selectedAttackStyleIndex).toBe(1);
  });

  it('replaces a persisted powered-staff index that no longer exists', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    engine.setEquipment({ weapon: 27275 });

    engine.setAttackStylePerCategory({ powered_staff: 2 });

    expect(engine.getState().selectedAttackStyleIndex).toBe(1);
  });
});

const AVAS_ASSEMBLER = 22109;
const DIZANAS_QUIVER = 28947;
const DRAGON_ARROW = 11212;
const TWISTED_BOW = 20997;

function makeRangedEngine(cape?: number): SimulationEngine {
  const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 27] });
  engine.setMechanicsConfig({
    yamaMageRange: false,
    yamaMelee: false,
    waves: false,
    fireballs: false,
    voidFlares: false,
    infiniteHealth: true,
  });
  engine.setAttackTarget('yama');
  engine.setEquipment(cape === undefined ? { weapon: TWISTED_BOW } : { cape, weapon: TWISTED_BOW });
  engine.setCombatSupplies({
    ...createEmptyCombatSupplies(),
    equippedAmmo: { id: DRAGON_ARROW },
  });
  return engine;
}

describe('ammunition is infinite', () => {
  it.each([
    { worn: 'no cape', cape: undefined },
    { worn: "Ava's assembler", cape: AVAS_ASSEMBLER },
    { worn: "Dizana's quiver", cape: DIZANAS_QUIVER },
  ])('keeps the worn ammunition through repeated launches with $worn', ({ cape }) => {
    const engine = makeRangedEngine(cape);

    for (let tick = 0; tick < 20; tick++) {
      engine.advanceTick(engine.getState().playerPosition);
    }

    // Then: the same arrow type is still worn - nothing was ever spent, so no
    // ammo-preservation roll is needed to keep it there.
    expect(engine.getCombatSupplies().equippedAmmo).toEqual({ id: DRAGON_ARROW });
  });
});

const PLAYER_POSITION: Coordinate = [31, 27];
const YAMA_TARGET_ID = 'yama';
const TEST_CACHE_INFO: CacheInfo = {
  name: 'test',
  game: 'oldschool',
  environment: 'live',
  revision: 232,
  timestamp: '2024-01-01T00:00:00.000Z',
  size: 0,
};

class GuaranteedMaxProjectionEncounter extends YamaEncounter {
  constructor(private readonly consumeGuaranteedMax: (context: EncounterEngineContext) => boolean) {
    super();
  }

  override getEngineRules(): EncounterEngineRules {
    return {
      ...super.getEngineRules(),
      consumePlayerGuaranteedMaxHit: this.consumeGuaranteedMax,
    };
  }
}

function makeYamaEngine(options: { combatRandom?: () => number } = {}): SimulationEngine {
  const engine = new SimulationEngine({
    encounter: new YamaEncounter(),
    startPos: PLAYER_POSITION,
    objTypeLoader: new DummyTypeLoader(TEST_CACHE_INFO, ObjType),
    ...(options.combatRandom === undefined ? {} : { combatRandom: options.combatRandom }),
  });
  engine.setMechanicsConfig({
    yamaMageRange: false,
    yamaMelee: false,
    waves: false,
    fireballs: false,
    voidFlares: false,
    infiniteHealth: true,
  });
  engine.setAttackTarget(YAMA_TARGET_ID);
  return engine;
}

function advanceTicks(engine: SimulationEngine, ticks: number): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    engine.advanceTick(engine.getState().playerPosition);
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

describe('replay-only engine containment', () => {
  const healers = { type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-healers' } } as const;
  const clear = { type: 'encounterCommand', command: { encounter: 'zuk', type: 'clear-spawns' } } as const;
  const create = (work: ReplayTakeoverWork) => {
    const engine = new SimulationEngine({
      encounter: createZukWaveEncounter(7),
      replayTakeoverWork: work,
      combatSeed: 31,
    });
    engine.setMechanicsConfig({ infiniteHealth: true, zukSets: false, zukAttacks: false });
    return engine;
  };
  // Commands are queued by `applyAction` and run at the start of the next tick, which is where
  // their admissions are charged.
  const step = (engine: SimulationEngine) => engine.advanceTick([31, 40]);
  const apply = (engine: SimulationEngine, action: EngineAction) => {
    engine.applyAction(action);
    step(engine);
  };

  it('checks initial seeds before registering an oversized batch', () => {
    expect(() => create(new ReplayTakeoverWork({ maxNpcs: 1 }))).toThrow(ReplaySafetyError);
    const work = new ReplayTakeoverWork({ maxNpcs: 2, maxSpawns: 2 });
    expect(create(work).getNpcCount()).toBe(2);
    expect(work.getStats().spawns).toBe(2);
  });

  it.each([false, true])('checks dynamic registration without snapshots, including dead-player=%s', (dead) => {
    const work = new ReplayTakeoverWork({ maxNpcs: 5 });
    const engine = create(work);
    if (dead) {
      const player = engine['worldState'].getPlayer();
      if (!player) throw new Error('Missing player');
      player.alive = false;
    }
    const snapshot = vi.spyOn(engine, 'getState').mockImplementation(() => {
      throw new Error('Guard: cloned state');
    });

    engine.applyAction(healers);
    if (dead) {
      // A dead player never ticks, so the queued spawn never runs and admits nothing.
      expect(() => step(engine)).not.toThrow();
      expect(engine.getNpcCount()).toBe(2);
      expect(work.getStats().spawns).toBe(2);
    } else {
      expect(() => step(engine)).toThrow(
        expect.objectContaining({
          reason: 'takeover-work-limit',
          details: { actual: 6, limit: 5, frameIndex: 0 },
        }),
      );
      expect(engine.getNpcCount()).toBe(5);
    }
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('retains lifetime admissions across removals and rejects further work after failure', () => {
    const work = new ReplayTakeoverWork({ maxNpcs: 6, maxSpawns: 10 });
    const engine = create(work);
    apply(engine, healers);
    apply(engine, clear);
    expect(engine.getNpcCount()).toBe(2);
    apply(engine, healers);
    expect(engine.getNpcCount()).toBe(6);
    expect(work.getStats().spawns).toBe(10);
    apply(engine, clear);

    expect(() => apply(engine, healers)).toThrow(ReplaySafetyError);
    expect(engine.getNpcCount()).toBe(2);
    expect(() => engine.reset()).toThrow(ReplaySafetyError);
    const retry = create(new ReplayTakeoverWork({ maxNpcs: 6, maxSpawns: 10 }));
    expect(() => apply(retry, healers)).not.toThrow();
  });

  it('charges reset seeds once each without resetting lifetime counters', () => {
    const work = new ReplayTakeoverWork({ maxSpawns: 4 });
    const engine = create(work);
    engine.reset();
    expect(work.getStats().spawns).toBe(4);
    expect(engine.getNpcCount()).toBe(2);
    expect(() => engine.reset()).toThrow(ReplaySafetyError);
  });

  it('counts replacement admissions without treating removed actors as still present', () => {
    const work = new ReplayTakeoverWork({ maxNpcs: 4, maxSpawns: 6 });
    const engine = create(work);
    apply(engine, { type: 'encounterCommand', command: { encounter: 'zuk', type: 'spawn-set' } });
    const replace = { type: 'encounterCommand', command: { encounter: 'zuk', type: 'replace-set' } } as const;
    apply(engine, replace);
    expect(engine.getNpcCount()).toBe(4);
    expect(work.getStats().spawns).toBe(6);
    expect(() => apply(engine, replace)).toThrow(ReplaySafetyError);
  });

  it('retains lifetime admissions when automatic pruning frees population capacity', () => {
    const work = new ReplayTakeoverWork({ maxNpcs: 6, maxSpawns: 10 });
    const engine = create(work);
    apply(engine, healers);
    for (const npc of engine['worldState'].getNpcs()) {
      if (npc.role !== 'minion') continue;
      npc.alive = false;
      npc.despawnTick = 0;
    }
    advanceTicks(engine, DEAD_ACTOR_PRUNE_GRACE_TICKS);
    expect(engine.getNpcCount()).toBe(2);
    apply(engine, healers);
    expect(engine.getNpcCount()).toBe(6);
    expect(work.getStats().spawns).toBe(10);
  });

  it('charges NPCs spawned during a tick before registering them', () => {
    const encounter = new YamaEncounter();
    const work = new ReplayTakeoverWork({ maxNpcTicks: 1 });
    const engine = new SimulationEngine({ encounter, replayTakeoverWork: work });
    const completeNpcBand = encounter.completeNpcBand.bind(encounter);
    vi.spyOn(encounter, 'completeNpcBand').mockImplementation((context, mechanics) => {
      context.spawnNpc(
        createVoidFlareActor({
          id: 'bounded-flare',
          damageRollIndex: 0,
          position: [31, 26],
          spawnTick: context.tick,
          chargeTicks: 1,
        }),
      );
      return completeNpcBand(context, mechanics);
    });
    expect(() => engine.advanceTick(engine.getState().playerPosition)).toThrow(ReplaySafetyError);
    expect(engine.getNpcCount()).toBe(1);
    expect(work.getStats()).toMatchObject({ npcTicks: 1, spawns: 1 });
  });

  it('bounds actual NPC-ticks before advancing or cloning a state', () => {
    const work = new ReplayTakeoverWork({ maxNpcTicks: 11 });
    const engine = create(work);
    engine.applyAction(healers);
    const snapshot = vi.spyOn(engine, 'getState').mockImplementation(() => {
      throw new Error('Guard: cloned state');
    });
    engine.advanceTick([31, 40]);
    expect(engine.currentTick).toBe(1);

    expect(() => engine.advanceTick([31, 40])).toThrow(
      expect.objectContaining({
        reason: 'takeover-work-limit',
        details: { actual: 12, limit: 11, frameIndex: 0 },
      }),
    );
    expect(engine.currentTick).toBe(1);
    expect(work.getStats().npcTicks).toBe(6);
    expect(snapshot).not.toHaveBeenCalled();
  });

  it('admits the current 256-command four-healer batch with peak headroom', () => {
    const work = new ReplayTakeoverWork();
    const engine = create(work);
    for (let index = 0; index < 256; index++) engine.applyAction(healers);
    step(engine);
    expect(engine.getNpcCount()).toBe(1026);
    // The batch spawns inside the tick, so its healers are also charged that tick's NPC-ticks.
    expect(work.getStats()).toMatchObject({ actions: 256, spawns: 1026, npcTicks: 1026, ticks: 1 });
  });

  it('relinquishes all limits before continued live play', () => {
    const work = new ReplayTakeoverWork({ maxActions: 1, maxTicks: 1, maxNpcs: 2, maxSpawns: 2, maxNpcTicks: 2 });
    const engine = create(work);
    engine.applyAction({ type: 'runToggle' });
    engine.advanceTick([31, 40]);
    const completed = work.getStats();
    engine.releaseReplayTakeoverLimits();

    engine.applyAction(healers);
    engine.advanceTick([31, 40]);
    engine.reset();
    expect(work.getStats()).toEqual(completed);
    expect(engine.getRunConfig()).not.toHaveProperty('replayTakeoverWork');
  });

  it.each([NaN, Infinity, -1, 1.5])('rejects invalid job limits %s', (maxActions) => {
    expect(() => new ReplayTakeoverWork({ maxActions })).toThrow(ReplaySafetyError);
  });

  it('rejects numeric counter overflow without performing work', () => {
    const work = new ReplayTakeoverWork({ maxNpcs: Number.MAX_SAFE_INTEGER });
    expect(() => work.admitNpcs(Number.MAX_SAFE_INTEGER, 1)).toThrow(
      expect.objectContaining({
        reason: 'takeover-work-limit',
        details: { limit: Number.MAX_SAFE_INTEGER, frameIndex: 0 },
      }),
    );
    expect(work.getStats().spawns).toBe(0);
  });
});

describe('SimulationEngine NPC lockout cancellation', () => {
  it('cancels active targeting before movement and does not resume at expiry', () => {
    const engine = makeYamaEngine();
    const world = engine['worldState'];
    const target = requireYama(world);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing lockout player');
    target.attackBlockedUntilTick = 3;
    player.position = [31, 20];

    advanceTicks(engine, 5);

    expect(player.position).toEqual([31, 20]);
    expect(player).toMatchObject({ attackTarget: null, attackInteractionActive: false, manualCastSpell: null });
    expect(engine['combatSystem'].getNextAttackTick(player.id)).toBeUndefined();
    expect(world.pendingHits).toEqual([]);
  });

  it.each([
    'direct',
    'attack',
    'manual',
  ] as const)('discards a %s request while locked without saving it for expiry', (mode) => {
    const engine = makeYamaEngine();
    const world = engine['worldState'];
    const target = requireYama(world);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing lockout player');
    engine.setAttackTarget(null);
    target.attackBlockedUntilTick = 3;

    switch (mode) {
      case 'direct':
        engine.setAttackTarget(target.id);
        expect(engine.getAttackTarget()).toBeNull();
        break;
      case 'attack':
        engine.applyAction({ type: 'attackTarget', targetId: target.id });
        break;
      case 'manual':
        engine.applyAction({ type: 'manualCast', targetId: target.id, spellName: 'Ice Barrage' });
        break;
      default:
        throw new TypeError(`Unexpected input mode: ${mode satisfies never}`);
    }
    advanceTicks(engine, 5);

    expect(player).toMatchObject({ attackTarget: null, attackInteractionActive: false, manualCastSpell: null });
    expect(player.pendingInputOps).toEqual([]);
    expect(engine['combatSystem'].getNextAttackTick(player.id)).toBeUndefined();
    expect(world.pendingHits).toEqual([]);
  });

  it('accepts a fresh attack request processed exactly at lockout expiry', () => {
    const engine = makeYamaEngine();
    const world = engine['worldState'];
    const target = requireYama(world);
    target.attackBlockedUntilTick = 3;
    engine.setEquipment({ weapon: 11802 });
    advanceTicks(engine, 2);

    engine.applyAction({ type: 'attackTarget', targetId: target.id });
    advanceTicks(engine, 1);

    expect(engine.getAttackTarget()).toBe(target.id);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({
        type: 'attack_started',
        sourceId: 'player',
        targetId: target.id,
        tick: 3,
      }),
    );
  });
});

describe('SimulationEngine remembered health target', () => {
  it('retains the selected NPC when a walk click clears the attack target', () => {
    const engine = makeYamaEngine();
    const target = requireYama(engine['worldState']);
    engine.applyAction({ type: 'attackTarget', targetId: target.id });
    advanceTicks(engine, 1);

    engine.applyAction({ type: 'attackTarget', targetId: null });
    advanceTicks(engine, 1);

    expect(engine.getState().attackTarget).toBeNull();
    expect(engine.getState().lastAttackTarget).toBe(target.id);
  });

  it('does not carry a remembered target into a reset run', () => {
    const engine = makeYamaEngine();
    const target = requireYama(engine['worldState']);
    engine.setAttackTarget(target.id);

    engine.reset();

    expect(engine.getState().lastAttackTarget).toBeNull();
  });
});

describe('SimulationEngine explicit NPC removal', () => {
  function setup(alive: boolean) {
    const engine = makeYamaEngine();
    engine.setAttackTarget(null);
    const world = engine['worldState'];
    const boss = requireYama(world);
    const npc: NpcActor = {
      ...boss,
      id: 'despawn-target',
      role: 'minion',
      alive,
      despawnTick: world.tick,
      vitals: { hp: alive ? 10 : 0, maxHp: 10 },
      combat: { ...boss.combat },
      history: new Map(),
    };
    engine['spawnEncounterNpc'](npc);
    return { engine, npc, world };
  }

  it.each([false, true])('emits an explicit removal event through the context when alive is %s', (alive) => {
    const { engine, npc, world } = setup(alive);
    const context = engine['buildNpcDefinitionContext']();
    const notifyDespawn = vi.spyOn(engine['npcDefinitions'], 'notifyDespawn');

    context.despawnNpc(npc.id);

    expect(engine['tickEvents'].flush()).toEqual([
      { type: 'actor_despawned', actorId: npc.id, tick: world.tick, eventId: expect.any(Number) },
    ]);
    expect(world.getNpc(npc.id)).toBeNull();
    expect(notifyDespawn).toHaveBeenCalledWith(npc, expect.objectContaining({ world }));
  });

  it('emits no explicit removal event when automatic pruning removes a dead actor', () => {
    const { engine, npc, world } = setup(false);
    const notifyDespawn = vi.spyOn(engine['npcDefinitions'], 'notifyDespawn');

    advanceTicks(engine, DEAD_ACTOR_PRUNE_GRACE_TICKS);

    expect(world.getNpc(npc.id)).toBeNull();
    expect(engine.getLastTickEvents().filter((event) => isCoreEvent(event, 'actor_despawned'))).toEqual([]);
    expect(notifyDespawn).toHaveBeenCalledWith(npc, expect.objectContaining({ world }));
  });

  // Four flares fill both the cap and all four spawn tiles. A pending flare spawns on the tick a lethal
  // hit lands on one of them only if that kill is resolved first: it frees the slot and the tile, as
  // when every kill resolved before the NPCs acted.
  it.each([
    true,
    false,
  ])('spawns a pending flare into the slot a flare killed that tick frees (killed: %s)', (killed) => {
    const engine = makeYamaEngine();
    engine.setAttackTarget(null);
    engine.setMechanicsConfig({ voidFlares: true });
    for (let index = 0; index < 4; index++)
      engine.executeEncounterCommand({ encounter: 'yama_p3', type: 'spawn-void-flare' });
    const world = engine['worldState'];
    const victim = world.getNpc('vf-0');
    if (!victim) throw new TypeError('Missing flare');
    expect(world.getNpcs().filter((npc) => npc.id.startsWith('vf-'))).toHaveLength(4);
    const encounter = engine['encounter'] as YamaEncounter;
    encounter['state'].voidFlares.pendingSpawns = [{ chargeTicks: VOID_FLARE_CHARGE_TICKS, hp: 71 }];
    if (killed)
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: victim.id,
        style: 'range',
        attackKind: 'range_arrow',
        launchTick: 0,
        impactTick: 1,
        rolledDamage: victim.vitals.hp,
        accuracySucceeded: true,
      });

    engine.advanceTick(PLAYER_POSITION);

    const spawned = engine.getLastTickEvents().filter((event) => event.type === 'voidflare_spawned');
    expect(victim.alive).toBe(!killed);
    expect(spawned).toEqual(killed ? [expect.objectContaining({ flareId: 'vf-4', position: victim.position })] : []);
    expect(encounter['state'].voidFlares.pendingSpawns).toEqual([]);
  });

  it('prunes an early-killed flare after death grace rather than its future explosion', () => {
    const engine = makeYamaEngine();
    engine.setAttackTarget(null);
    const world = engine['worldState'];
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing flare attacker');
    const flare = createVoidFlareActor({
      id: 'vf-0',
      damageRollIndex: 0,
      position: [31, 26],
      spawnTick: 0,
      chargeTicks: 26,
    });
    engine['spawnEncounterNpc'](flare);

    engine['combatSystem'].processAttackRequest(
      world,
      {
        attacker: player,
        target: flare,
        attack: {
          style: 'melee',
          attackKind: 'melee_slash',
          rolledDamage: flare.vitals.hp,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        },
      },
      engine['buildCombatBridge']({ enablePendingHits: false }),
    );
    // A player-killed flare dies as a queued NPC: its death animation is at K + 1, and the prune grace
    // runs from that, not from the kill.
    expect(flare.deathAnimationTick).toBe(1);
    advanceTicks(engine, DEAD_ACTOR_PRUNE_GRACE_TICKS);
    expect(world.getNpc(flare.id)).toBe(flare);
    advanceTicks(engine, 1);

    expect(world.getNpc(flare.id)).toBeNull();
    expect(engine.getState().npcs.some((npc) => npc.id === flare.id)).toBe(false);
  });

  it('preserves a living same-ID replacement when an earlier prune callback replaces a queued actor', () => {
    const { engine, npc, world } = setup(false);
    const notifications: NpcActor[] = [];
    const definition = createNpcDefinition<{ generation: number }, void>({
      id: 'prune-replacement',
      move: false,
      onDespawn: ({ actor, context }) => {
        notifications.push(actor);
        if (actor.id === npc.id) {
          context.despawnNpc(second.id);
          context.spawnNpc(replacement);
        }
      },
    });
    const first = definition.createActor(npc, { generation: 1 });
    const second = definition.createActor({ ...npc, id: 'second' }, { generation: 1 });
    const replacement = definition.createActor(
      { ...second, alive: true, despawnTick: undefined, vitals: { hp: 10, maxHp: 10 } },
      { generation: 2 },
    );
    engine['npcDefinitions'] = new NpcDefinitionCollection([definition.register(undefined)]);
    world.actors.set(first.id, first);
    world.actors.set(second.id, second);

    advanceTicks(engine, DEAD_ACTOR_PRUNE_GRACE_TICKS);

    expect(world.getNpc(second.id)).toBe(replacement);
    expect(notifications).toEqual([first, second]);
  });

  it.each([
    {
      reason: 'revived',
      update: (npc: NpcActor) => {
        npc.alive = true;
      },
    },
    {
      reason: 'promoted to boss',
      update: (npc: NpcActor) => {
        npc.role = 'boss';
      },
    },
    {
      reason: 'death cleared',
      update: (npc: NpcActor) => {
        npc.despawnTick = undefined;
      },
    },
    {
      reason: 'grace period renewed',
      update: (npc: NpcActor) => {
        npc.despawnTick = DEAD_ACTOR_PRUNE_GRACE_TICKS;
      },
    },
  ])('preserves a queued actor when an earlier prune callback leaves it $reason', ({ update }) => {
    const { engine, npc, world } = setup(false);
    const second: NpcActor = { ...npc, id: 'second' };
    world.actors.set(second.id, second);
    const notifyDespawn = vi.spyOn(engine['npcDefinitions'], 'notifyDespawn').mockImplementation((actor) => {
      if (actor === npc) update(second);
      return true;
    });

    advanceTicks(engine, DEAD_ACTOR_PRUNE_GRACE_TICKS);

    expect(world.getNpc(second.id)).toBe(second);
    expect(notifyDespawn).toHaveBeenCalledExactlyOnceWith(npc, expect.objectContaining({ world }));
  });

  it('emits no duplicate removal event when an already-removed actor is despawned again', () => {
    const { engine, npc } = setup(false);
    const context = engine['buildNpcDefinitionContext']();
    context.despawnNpc(npc.id);
    engine['tickEvents'].flush();

    context.despawnNpc(npc.id);

    expect(engine['tickEvents'].flush()).toEqual([]);
  });
});

describe('SimulationEngine damage history NPC attribution', () => {
  function setupZukAttacker(npcTypeId: number) {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(7) });
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad-healers' });
    const world = engine['worldState'];
    const attacker = world.getNpcs().find((npc) => npc.npcTypeId === npcTypeId);
    const target = world.getPlayer();
    if (!attacker || !target) throw new TypeError('Missing damage attribution actors');
    return { engine, world, attacker, target };
  }

  function commitAttack(engine: SimulationEngine, request: PrevalidatedAttackRequest): void {
    engine['combatSystem'].processAttackRequest(
      engine['worldState'],
      request,
      engine['buildCombatBridge']({ enablePendingHits: true }),
    );
  }

  it.each([
    { name: 'Zuk', npcTypeId: 7706, style: 'range', attackKind: 'range_arrow' },
    { name: 'mager', npcTypeId: 7703, style: 'magic', attackKind: 'magic_fire' },
    { name: 'ranger', npcTypeId: 7702, style: 'range', attackKind: 'range_arrow' },
    { name: 'Jad', npcTypeId: 7704, style: 'magic', attackKind: 'magic_fire' },
    { name: 'Jad healer', npcTypeId: 7705, style: 'melee', attackKind: 'melee_crush' },
  ] as const)('records the actual $name NPC type when its queued hit lands', ({ npcTypeId, style, attackKind }) => {
    const { engine, attacker, target } = setupZukAttacker(npcTypeId);
    const hpBefore = target.vitals.hp;
    commitAttack(engine, {
      attacker,
      target,
      attack: { style, attackKind, rolledDamage: 7, accuracySucceeded: true, impactDelayTicks: 1 },
    });

    advanceTicks(engine, 1);

    expect(engine.getState().damageHistory).toEqual([
      expect.objectContaining({
        tick: 1,
        source: 'ZukAttack',
        sourceNpcTypeId: npcTypeId,
        targetId: 'player',
        attackType: style,
        baseDamage: 7,
        effectiveDamage: 7,
        hpBefore,
        hpAfter: hpBefore - 7,
      }),
    ]);
  });

  it('records the actual NPC type when a non-Zuk attacker deals damage', () => {
    const engine = makeYamaEngine();
    const attacker = requireYama(engine['worldState']);
    const target = engine['player']();

    commitAttack(engine, {
      attacker,
      target,
      attack: {
        style: 'magic',
        attackKind: 'magic_fire',
        rolledDamage: 7,
        accuracySucceeded: true,
        impactDelayTicks: 0,
      },
    });

    expect(engine.getState().damageHistory).toEqual([
      expect.objectContaining({ source: 'YamaAttack', sourceNpcTypeId: 14176, effectiveDamage: 7 }),
    ]);
  });

  it('preserves player damage and expected hits without attributing the target NPC as the source', () => {
    const engine = makeYamaEngine();
    const target = requireYama(engine['worldState']);
    const hpBefore = target.vitals.hp;

    commitAttack(engine, {
      attacker: engine['player'](),
      target,
      attack: {
        style: 'range',
        attackKind: 'range_arrow',
        rolledDamage: 7,
        accuracySucceeded: true,
        impactDelayTicks: 0,
        expectedHit: 4.5,
      },
    });

    const history = engine.getState().damageHistory;
    expect(history).toEqual([
      expect.objectContaining({
        source: 'PlayerAttack',
        targetId: 'yama',
        effectiveDamage: 7,
        hpBefore,
        hpAfter: hpBefore - 7,
        expectedHit: 4.5,
      }),
    ]);
    expect(history[0]?.sourceNpcTypeId).toBeUndefined();
  });

  it('retains the recorded NPC type when the attacker is removed from the world', () => {
    const { engine, attacker, target } = setupZukAttacker(7703);
    commitAttack(engine, {
      attacker,
      target,
      attack: {
        style: 'magic',
        attackKind: 'magic_fire',
        rolledDamage: 7,
        accuracySucceeded: true,
        impactDelayTicks: 0,
      },
    });

    engine.executeEncounterCommand({ encounter: 'zuk', type: 'clear-spawns' });

    expect(engine.getState().damageHistory).toEqual([
      expect.objectContaining({ source: 'ZukAttack', sourceNpcTypeId: 7703, effectiveDamage: 7 }),
    ]);
  });

  it('leaves environmental damage without an NPC source', () => {
    const engine = makeYamaEngine();

    engine['applyDamage'](7, 'typeless', 'Poison', 0);

    const history = engine.getState().damageHistory;
    expect(history).toEqual([expect.objectContaining({ source: 'Poison', effectiveDamage: 7 })]);
    expect(history[0]?.sourceNpcTypeId).toBeUndefined();
  });
});

describe('SimulationEngine equipment effects', () => {
  it('schedules a lethal Eclipse burn pulse through advanceTick', () => {
    // Given: a guaranteed Eclipse-atlatl proc from a real ranged attack. The engine rolls combat
    // on its own seeded stream, so the roll is injected rather than mocked onto `Math.random`.
    const engine = makeYamaEngine({ combatRandom: () => 0 });
    engine.setEquipment({ head: 29035, body: 29031, legs: 29033, weapon: 29000 });
    engine.setCombatSupplies({
      ...createEmptyCombatSupplies(),
      equippedAmmo: { id: 28991 },
    });

    engine.advanceTick(engine.getState().playerPosition);
    expect(engine.getLastTickEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'attack_started',
          sourceId: 'player',
          targetId: YAMA_TARGET_ID,
          weaponId: 29000,
          ammoId: 28991,
          impactDelayTicks: 2,
        }),
      ]),
    );
    engine.setAttackTarget(null);
    advanceTicks(engine, 2);
    engine.setBossHp(1);
    advanceTicks(engine, 4);

    const pulseEvents = engine.getLastTickEvents();
    expect(pulseEvents.filter((event) => isCoreEvent(event, 'hit_applied'))).toEqual([
      expect.objectContaining({ targetId: YAMA_TARGET_ID, damage: 1, attackKind: 'typeless' }),
    ]);
    expect(pulseEvents.filter((event) => isCoreEvent(event, 'hitsplat_spawned'))).toEqual([
      expect.objectContaining({ targetId: YAMA_TARGET_ID, amount: 1, hitsplatType: 'burn' }),
    ]);
    expect(pulseEvents.filter((event) => isCoreEvent(event, 'actor_died'))).toEqual([
      expect.objectContaining({ actorId: YAMA_TARGET_ID }),
    ]);
    expect(engine.getState().damageHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tick: 7,
          source: 'PlayerAttack',
          targetId: YAMA_TARGET_ID,
          attackType: 'typeless',
          baseDamage: 1,
          effectiveDamage: 1,
        }),
      ]),
    );
  });

  it('uses steady-state Confliction accuracy for the engine DPS projection', () => {
    // Given: the eligible charged Eye of ayak and Confliction gauntlets loadout.
    const engine = makeYamaEngine();
    engine.setEquipment({ hands: 31106, weapon: 31113 });
    const state = engine.getState();
    const target = state.npcs.find((npc) => npc.id === YAMA_TARGET_ID);
    if (target === undefined) throw new Error('Expected Yama target');
    const formulaStats = getMonsterFormulaStats(target.npcTypeId, 'Phase 3');
    if (formulaStats === undefined) throw new Error('Expected Yama formula stats');
    const formulaStyle = getFormulaStyle(state.playerEquipment.weapon, state.selectedAttackStyleIndex);
    const projectionInput = {
      player: {
        stats: state.stats,
        equipment: state.playerEquipment,
        equipmentStats: state.equipmentStats,
        activePrayer: state.activePrayer,
        offensivePrayer: state.offensivePrayer,
        independentPrayers: [],
        selectedAttackStyleIndex: state.selectedAttackStyleIndex,
        combatTimers: state.combatTimers,
      },
      target: { size: target.size, npcTypeId: target.npcTypeId, formulaStats },
      formulaStyle,
      resources: { kind: 'none', source: 'none' } as const,
      attackSpeedTicks: state.playerAttackSpeed,
      delivery: {
        style: formulaStyleToDamageType(formulaStyle),
        attackKind: formulaStyleToAttackKind(formulaStyle),
        impactDelayTicks: 0,
      },
      application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
      manualCast: false,
      isSpecialAttack: false,
    };

    const engineProjection = engine.getAdjustedTheoreticalDps();
    const steadyState = projectFirstPartyPlayerAttack({ ...projectionInput, standardAccuracyMode: 'steady_state' });
    const singleRoll = projectFirstPartyPlayerAttack({ ...projectionInput, standardAccuracyMode: 'single_roll' });

    expect(engineProjection).toEqual(steadyState);
    expect(steadyState?.accuracy).toBeGreaterThan(singleRoll?.accuracy ?? 0);
    expect(engineProjection).toMatchObject({
      style: 'magic',
      attackSpeedTicks: state.playerAttackSpeed,
      attackIntervalSeconds: state.playerAttackSpeed * 0.6,
      outgoingDamageMultiplier: 1,
      specialAttackDamageMultiplier: 1,
    });
    expect(engineProjection?.expectedAppliedDamagePerAttack).toBeCloseTo(
      (engineProjection?.dps ?? 0) * state.playerAttackSpeed * 0.6,
    );
    expect(engineProjection?.baseAttackRoll).toBeGreaterThan(0);
    expect(engineProjection?.baseDefenceRoll).toBeGreaterThan(0);
    expect(engineProjection?.hits).toHaveLength(1);
    expect(engineProjection?.hits[0]?.accuracyProbability).toBe(engineProjection?.accuracy);
  });

  it('does not consume guaranteed-max encounter state while projecting', () => {
    const consumeGuaranteedMax = vi.fn(() => true);
    const engine = new SimulationEngine({
      encounter: new GuaranteedMaxProjectionEncounter(consumeGuaranteedMax),
      startPos: PLAYER_POSITION,
      objTypeLoader: new DummyTypeLoader(TEST_CACHE_INFO, ObjType),
    });
    engine.setEquipment({ weapon: 31113 });
    engine.setAttackTarget(YAMA_TARGET_ID);

    const first = engine.getAdjustedTheoreticalDps();
    const second = engine.getAdjustedTheoreticalDps();

    expect(first).toEqual(second);
    expect(consumeGuaranteedMax).not.toHaveBeenCalled();
  });
});

const CUSTOM_STATS: PlayerStats = {
  attack: { current: 70, max: 70 },
  strength: { current: 71, max: 71 },
  defence: { current: 72, max: 72 },
  ranged: { current: 73, max: 73 },
  magic: { current: 74, max: 74 },
  prayer: { current: 75, max: 75 },
  hitpoints: { current: 76, max: 76 },
  agility: { current: 99, max: 99 },
};

describe('SimulationEngine NPC poison driver', () => {
  // Guards two seams no unit test can reach: that the engine actually CALLS the poison driver on
  // its own tick band, and that the boss-HP slider ends the poison. The slider kills without
  // routing through `markNpcDead`, so without its own cleanup, dragging the bar back up revives a
  // boss that is still poisoned. Both would stay green if their production call were deleted.
  it('pulses NPC poison through advanceTick and drops it when the slider kills', () => {
    const engine = makeYamaEngine();
    const boss = engine['worldState'].getNpcs().find((npc) => npc.id === YAMA_TARGET_ID);
    if (boss?.formulaStats === undefined) throw new Error('Expected the Yama boss actor and its formula stats');
    // Yama is poison-IMMUNE in the shipped data. This case is about the driver, not the guard, so
    // it says plainly that it needs a target which can hold poison at all.
    boss.formulaStats = { ...boss.formulaStats, poisonResistance: 0 };

    const poisonSplatsOver = (ticks: number) => {
      const splats = [];
      for (let elapsed = 0; elapsed < ticks; elapsed += 1) {
        engine.advanceTick(engine.getState().playerPosition);
        splats.push(
          ...engine
            .getLastTickEvents()
            .filter(
              (event) =>
                isCoreEvent(event, 'hitsplat_spawned') &&
                event.targetId === YAMA_TARGET_ID &&
                event.hitsplatType === 'poison',
            ),
        );
      }
      return splats;
    };

    applyNpcPoison({ target: boss, sourceId: 'player', severity: 20, tick: engine['worldState'].tick });

    // ceil(20 / 5) = 4, one pulse per period.
    expect(poisonSplatsOver(POISON_PERIOD_TICKS + 1)).toEqual([
      expect.objectContaining({ targetId: YAMA_TARGET_ID, amount: 4, hitsplatType: 'poison' }),
    ]);

    // Kill with the slider, then drag it straight back up before the next pulse comes due.
    engine.setBossHp(0);
    engine.setBossHp(boss.vitals.maxHp);
    expect(boss.poison).toBeUndefined();

    expect(poisonSplatsOver(POISON_PERIOD_TICKS + 1)).toEqual([]);
  });
});

describe('SimulationEngine custom player stats', () => {
  it('initializes combat stats, hitpoints, and prayer from configured stats', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter(), stats: CUSTOM_STATS });

    const state = engine.getState();

    expect(state.stats).toEqual(CUSTOM_STATS);
    expect(state.playerHP).toBe(76);
    expect(state.maxHP).toBe(76);
    expect(state.prayerState).toMatchObject({ points: 75, maxPoints: 75 });
  });

  it('clones configured stats so mutable combat state cannot change reset values', () => {
    const configuredStats: PlayerStats = structuredClone(CUSTOM_STATS);
    const engine = new SimulationEngine({ encounter: new LobbyEncounter(), stats: configuredStats });

    configuredStats.attack.max = 1;
    engine.stats.attack.current = 1;
    engine.prayerState.points = 1;
    engine.reset();

    expect(engine.stats.attack).toEqual({ current: 70, max: 70 });
    expect(engine.prayerState).toMatchObject({ points: 75, maxPoints: 75 });
  });
});

describe('SimulationEngine startHp', () => {
  it('opens the fight on the given hitpoints without moving the configured max', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter(), stats: CUSTOM_STATS, startHp: 10 });

    const state = engine.getState();

    expect(state.playerHP).toBe(10);
    expect(state.maxHP).toBe(76);
    expect(state.stats.hitpoints).toEqual({ current: 10, max: 76 });
  });

  it('clamps to the encounter max above and to 1 below', () => {
    const high = new SimulationEngine({ encounter: new LobbyEncounter(), stats: CUSTOM_STATS, startHp: 500 });
    const low = new SimulationEngine({ encounter: new LobbyEncounter(), stats: CUSTOM_STATS, startHp: 0 });

    expect(high.getState().playerHP).toBe(76);
    expect(low.getState().playerHP).toBe(1);
  });

  it('leaves hitpoints at the configured max when unset', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter(), stats: CUSTOM_STATS });

    expect(engine.getState().playerHP).toBe(76);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects the non-finite starting hitpoints %p', (startHp) => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter(), stats: CUSTOM_STATS, startHp });

    const state = engine.getState();

    expect(state.playerHP).toBe(76);
    expect(Number.isFinite(state.playerHP)).toBe(true);
  });

  it('re-applies on reset, so Try Again opens on the same hitpoints', () => {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter(), stats: CUSTOM_STATS, startHp: 10 });

    engine.reset();

    expect(engine.getState().playerHP).toBe(10);
  });
});

/**
 * The engine auto-faces a stationary NPC toward its combat target
 * ({@link SimulationEngine.updateStationaryNpcTargetFacing}), but must NOT do so
 * for a locked-facing NPC (e.g. Zuk's shield always faces south). Without the
 * guard, a locked NPC that also has a live target is silently re-faced.
 *
 * Yama is a real stationary NPC that already targets the live player, so the
 * fixtures mutate it directly instead of constructing a fake actor.
 */

const YAMA_ID = 'yama';

const getWorldState = (engine: SimulationEngine): WorldState => Reflect.get(engine, 'worldState') as WorldState;

const invokeStationaryFacing = (engine: SimulationEngine): void => {
  const face = Reflect.get(engine, 'faceStationaryNpcTarget') as (npc: NpcActor) => void;
  for (const npc of getWorldState(engine).getNpcs()) face.call(engine, npc);
};

function requireYama(world: WorldState): NpcActor {
  const yama = world.getNpc(YAMA_ID);
  if (!yama) {
    throw new Error('expected the Yama NPC in the encounter world');
  }
  return yama;
}

describe('SimulationEngine.faceStationaryNpcTarget locked-facing guard', () => {
  it('does not overwrite a locked-facing stationary NPC that has a live target', () => {
    // Yama already targets the live player and is stationary; lock it at 800 — a
    // non-cardinal angle the toward-target math can never produce.
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 25] });
    const world = getWorldState(engine);
    const yama = requireYama(world);
    yama.lockedFacing = 800;
    yama.facing = 800;

    invokeStationaryFacing(engine);

    // Re-facing it would rewrite `facing` to a cardinal/diagonal (0/256/512/... — never 800).
    expect(world.getNpc(YAMA_ID)?.facing).toBe(800);
  });

  it('still auto-faces a stationary NPC that is NOT locked toward its live target', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 25] });
    const world = getWorldState(engine);
    const yama = requireYama(world);
    yama.facing = 800;

    invokeStationaryFacing(engine);

    expect(world.getNpc(YAMA_ID)?.facing).not.toBe(800);
  });
});

describe('SimulationEngine ground items', () => {
  const SHARK = 385;
  const COINS = 995;

  function createEngine(inventory = createEmptyInventory()): SimulationEngine {
    return new SimulationEngine({ encounter: new LobbyEncounter(), initialInventory: inventory });
  }

  /** Hold position so movement never interferes with what a test is measuring. */
  function tick(engine: SimulationEngine, count = 1): void {
    for (let i = 0; i < count; i++) {
      engine.advanceTick(engine.getState().playerPosition);
    }
  }

  it('drops the item onto the tile the player is standing on', () => {
    const inventory = createEmptyInventory();
    inventory[3] = { id: SHARK };
    const engine = createEngine(inventory);
    const start = engine.getState().playerPosition;

    engine.queueDropItem(3);
    tick(engine);

    const state = engine.getState();
    expect(state.inventory[3]).toBeNull();
    expect(state.groundItems).toHaveLength(1);
    expect(state.groundItems[0]).toMatchObject({ itemId: SHARK, quantity: 1, position: start });
  });

  it('gives each non-stackable drop its own pile', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: SHARK };
    inventory[1] = { id: SHARK };
    const engine = createEngine(inventory);

    engine.queueDropItem(0);
    engine.queueDropItem(1);
    tick(engine);

    const piles = engine.getState().groundItems;
    expect(piles).toHaveLength(2);
    expect(new Set(piles.map((pile) => pile.id)).size).toBe(2);
  });

  it('merges a stackable drop into a pile of the same id already on the tile', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: COINS, quantity: 40 };
    inventory[1] = { id: COINS, quantity: 60 };
    const engine = createEngine(inventory);

    engine.queueDropItem(0);
    tick(engine);
    engine.queueDropItem(1);
    tick(engine);

    const piles = engine.getState().groundItems;
    expect(piles).toHaveLength(1);
    expect(piles[0]?.quantity).toBe(100);
  });

  it('picks the pile back up on the tick the player is standing on it', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: SHARK };
    const engine = createEngine(inventory);

    engine.queueDropItem(0);
    tick(engine);
    const pileId = engine.getState().groundItems[0]?.id;
    expect(pileId).toBeDefined();

    engine.queuePickupGroundItem(pileId as string);
    tick(engine);

    const state = engine.getState();
    expect(state.groundItems).toHaveLength(0);
    expect(state.inventory[0]).toEqual({ id: SHARK });
  });

  it('leaves the pile on the floor when the inventory is full', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: SHARK };
    const engine = createEngine(inventory);

    engine.queueDropItem(0);
    tick(engine);
    const pileId = engine.getState().groundItems[0]?.id as string;

    const full = createEmptyInventory().map(() => ({ id: COINS }));
    engine.setInventory(full);
    engine.queuePickupGroundItem(pileId);
    tick(engine);

    expect(engine.getState().groundItems).toHaveLength(1);
  });

  it('leaves a pile on the floor indefinitely, because encounters are instances', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: SHARK };
    const engine = createEngine(inventory);

    engine.queueDropItem(0);
    tick(engine);

    // Well past the overworld's 200-tick lifetime, which instances do not apply.
    tick(engine, 600);

    expect(engine.getState().groundItems).toHaveLength(1);
  });

  it('keeps a merged pile in its original menu position', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: COINS, quantity: 40 };
    inventory[1] = { id: SHARK };
    inventory[2] = { id: COINS, quantity: 60 };
    const engine = createEngine(inventory);

    engine.queueDropItem(0);
    tick(engine);
    const coinsDropTick = engine.getState().groundItems[0]?.droppedTick as number;

    engine.queueDropItem(1);
    tick(engine, 5);
    engine.queueDropItem(2);
    tick(engine);

    const coins = engine.getState().groundItems.find((pile) => pile.itemId === COINS);
    expect(coins?.quantity).toBe(100);
    // Not restamped to the merging drop's tick, so it does not jump above the shark.
    expect(coins?.droppedTick).toBe(coinsDropTick);
  });

  it('takes one tick to pick up a pile the player is already standing on', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: SHARK };
    const engine = createEngine(inventory);

    engine.queueDropItem(0);
    tick(engine);
    const pileId = engine.getState().groundItems[0]?.id as string;

    engine.queuePickupGroundItem(pileId);
    tick(engine);

    expect(engine.getState().groundItems).toHaveLength(0);
  });

  it('takes the arrival tick plus one to pick up a pile the player has to walk to', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: SHARK };
    const engine = createEngine(inventory);
    const pileTile = engine.getState().playerPosition;

    engine.queueDropItem(0);
    tick(engine);
    const pileId = engine.getState().groundItems[0]?.id as string;

    const awayTile: Coordinate = [pileTile[0] + 1, pileTile[1]];
    engine.advanceTick(awayTile);
    expect(engine.getState().playerPosition).toEqual(awayTile);

    // Tick 1: walks back onto the tile, but standing there is a precondition the
    // step cannot satisfy for itself, so nothing is taken yet.
    engine.queuePickupGroundItem(pileId);
    engine.advanceTick(pileTile);
    expect(engine.getState().playerPosition).toEqual(pileTile);
    expect(engine.getState().groundItems).toHaveLength(1);

    // Tick 2: already on the tile, so the take resolves.
    engine.advanceTick(pileTile);
    expect(engine.getState().groundItems).toHaveLength(0);
  });

  it('resolves only the last take when several are clicked inside one tick', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: SHARK };
    inventory[1] = { id: 4151 };
    const engine = createEngine(inventory);

    engine.queueDropItem(0);
    engine.queueDropItem(1);
    tick(engine);
    const piles = engine.getState().groundItems;
    const first = piles[0]?.id as string;
    const second = piles[1]?.id as string;

    engine.queuePickupGroundItem(first);
    engine.queuePickupGroundItem(second);
    tick(engine);

    const remaining = engine.getState().groundItems;
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(first);
  });

  it('restores a floor wholesale without ever reissuing a restored pile id', () => {
    // Replay takeover rebuilds a world from a recorded snapshot; a later drop must
    // not collide with a pile that came out of that snapshot.
    const inventory = createEmptyInventory();
    inventory[0] = { id: SHARK };
    const engine = createEngine(inventory);
    const tile = engine.getState().playerPosition;

    engine.setGroundItems([
      { id: 'gi-7', itemId: COINS, quantity: 5, position: tile, droppedTick: 0 },
      { id: 'gi-3', itemId: 4151, quantity: 1, position: tile, droppedTick: 0 },
    ]);
    expect(engine.getState().groundItems).toHaveLength(2);

    engine.queueDropItem(0);
    tick(engine);

    const ids = engine.getState().groundItems.map((pile) => pile.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain('gi-8');
  });

  it('cancels a pending take when the player clicks somewhere else', () => {
    const inventory = createEmptyInventory();
    inventory[0] = { id: SHARK };
    const engine = createEngine(inventory);

    engine.queueDropItem(0);
    tick(engine);
    const pileId = engine.getState().groundItems[0]?.id as string;

    engine.queuePickupGroundItem(pileId);
    engine.applyAction({ type: 'attackTarget', targetId: null });
    tick(engine);

    expect(engine.getState().groundItems).toHaveLength(1);
    expect(engine.getState().inventory[0]).toBeNull();
  });
});

describe('SimulationEngine Redemption', () => {
  const REDEMPTION_START: Coordinate = [31, 37];

  function makeRedemptionEngine({ prayerLevel = 99, maxHp = 99, hp = 99, prayerPoints = 40, lit = true } = {}) {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(7), startPos: REDEMPTION_START });
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: false });
    engine.setPlayerStats(
      createStatsFromBaseLevels({
        attack: 99,
        strength: 99,
        defence: 99,
        ranged: 99,
        magic: 99,
        prayer: prayerLevel,
        hitpoints: maxHp,
        agility: 99,
      }),
    );
    if (lit) {
      engine.queueProtectionPrayer(PrayerType.Redemption);
      engine.advanceTick(engine.getState().playerPosition);
    }
    const player = engine['worldState'].getPlayer();
    if (!player) throw new TypeError('Missing player actor');
    engine.prayerState.points = prayerPoints;
    player.vitals.hp = hp;
    return { engine, player };
  }

  /** The environmental/mechanic damage path. `hitsplatType` classifies poison and venom pulses. */
  function hitPlayer(engine: SimulationEngine, damage: number, hitsplatType?: 'damage' | 'poison' | 'venom'): void {
    engine['applyDamage'](
      damage,
      'typeless',
      'Poison',
      engine.getState().currentTick,
      undefined,
      undefined,
      hitsplatType,
    );
  }

  it('heals floor(basePrayer * 0.25) and burns every prayer point when a hit drops HP below 10%', () => {
    const { engine, player } = makeRedemptionEngine({ hp: 15, prayerPoints: 40 });

    hitPlayer(engine, 6);

    // 15 - 6 = 9; 9 * 10 = 90 < 99, so it procs. floor(99 * 0.25) = 24.
    expect(player.vitals.hp).toBe(33);
    expect(engine.prayerState.points).toBe(0);
    expect(engine.activePrayer).toBeNull();
  });

  it('uses BASE Prayer level, not the boosted level', () => {
    const { engine, player } = makeRedemptionEngine({ prayerLevel: 70, hp: 15 });
    engine.stats.prayer.current = 99;

    hitPlayer(engine, 6);

    expect(player.vitals.hp).toBe(9 + Math.floor(70 * 0.25));
  });

  it('procs at 9 of 99 but not at 10, matching the wiki worked example', () => {
    const below = makeRedemptionEngine({ hp: 15 });
    hitPlayer(below.engine, 6);
    expect(below.player.vitals.hp).toBe(33);

    const atThreshold = makeRedemptionEngine({ hp: 15 });
    hitPlayer(atThreshold.engine, 5);
    expect(atThreshold.player.vitals.hp).toBe(10);
    expect(atThreshold.engine.prayerState.points).toBe(40);
  });

  it('procs on a 0-damage hit taken while already below the threshold', () => {
    const { engine, player } = makeRedemptionEngine({ hp: 5 });

    hitPlayer(engine, 0);

    expect(player.vitals.hp).toBe(29);
    expect(engine.prayerState.points).toBe(0);
  });

  it('cannot save a lethal hit', () => {
    const { engine, player } = makeRedemptionEngine({ hp: 5 });

    hitPlayer(engine, 50);

    expect(player.vitals.hp).toBe(0);
    expect(player.alive).toBe(false);

    expect(engine.prayerState.points).toBe(40);
  });

  it('caps the heal at max HP', () => {
    const { engine, player } = makeRedemptionEngine({ maxHp: 20, hp: 5 });

    hitPlayer(engine, 4);

    expect(player.vitals.hp).toBe(20);
  });

  it('does not proc a second time, because the first proc left no prayer lit', () => {
    const { engine, player } = makeRedemptionEngine({ hp: 15 });

    hitPlayer(engine, 6);
    expect(player.vitals.hp).toBe(33);

    hitPlayer(engine, 30);
    expect(player.vitals.hp).toBe(3);
  });

  it('does not proc without Redemption lit, or with no prayer points left', () => {
    const unlit = makeRedemptionEngine({ hp: 15, lit: false });
    hitPlayer(unlit.engine, 6);
    expect(unlit.player.vitals.hp).toBe(9);

    const drained = makeRedemptionEngine({ hp: 15, prayerPoints: 0 });
    hitPlayer(drained.engine, 6);
    expect(drained.player.vitals.hp).toBe(9);
  });

  it('holds poison and venom pulses out of the trigger', () => {
    const poison = makeRedemptionEngine({ hp: 15 });
    hitPlayer(poison.engine, 6, 'poison');
    expect(poison.player.vitals.hp).toBe(9);
    expect(poison.engine.prayerState.points).toBe(40);

    const venom = makeRedemptionEngine({ hp: 15 });
    hitPlayer(venom.engine, 6, 'venom');
    expect(venom.player.vitals.hp).toBe(9);

    // The same generic path still procs for an ordinary mechanic hit, so the exclusion is by
    // hitsplat type rather than by this code path being unreachable.
    const mechanic = makeRedemptionEngine({ hp: 15 });
    hitPlayer(mechanic.engine, 6, 'damage');
    expect(mechanic.player.vitals.hp).toBe(33);
  });

  it('reports the HIT in damage history, not the healed HP that follows it', () => {
    const { engine } = makeRedemptionEngine({ hp: 15 });

    hitPlayer(engine, 6);

    expect(engine.getState().damageHistory).toEqual([
      expect.objectContaining({ effectiveDamage: 6, hpBefore: 15, hpAfter: 9 }),
    ]);
  });

  describe('combat damage path', () => {
    function commitAttack(engine: SimulationEngine, request: PrevalidatedAttackRequest): void {
      engine['combatSystem'].processAttackRequest(
        engine['worldState'],
        request,
        engine['buildCombatBridge']({ enablePendingHits: true }),
      );
    }

    it('procs on an NPC hit without adding a healing hitsplat', () => {
      const { engine, player } = makeRedemptionEngine({ hp: 15 });
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
      const attacker = engine['worldState'].getNpcs().find((npc) => npc.npcTypeId === 7703);
      if (!attacker) throw new TypeError('Missing attacker');

      commitAttack(engine, {
        attacker,
        target: player,
        attack: {
          style: 'magic',
          attackKind: 'magic_fire',
          rolledDamage: 6,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        },
      });

      expect(player.vitals.hp).toBe(33);
      expect(engine.prayerState.points).toBe(0);

      const events = engine['tickEvents'].flush();
      const splats = events.filter((event) => event.type === 'hitsplat_spawned' && event.targetId === 'player');
      expect(splats).toMatchObject([{ amount: 6, hitsplatType: 'damage' }]);
      expect(events).toContainEqual(expect.objectContaining({ type: 'player_graphic_applied' }));
    });

    it('ignores a hit the player DEALS while below the threshold', () => {
      const { engine, player } = makeRedemptionEngine({ hp: 5 });
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
      const victim = engine['worldState'].getNpcs().find((npc) => npc.npcTypeId === 7703);
      if (!victim) throw new TypeError('Missing victim');

      commitAttack(engine, {
        attacker: player,
        target: victim,
        attack: {
          style: 'magic',
          attackKind: 'magic_fire',
          rolledDamage: 6,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        },
      });

      expect(player.vitals.hp).toBe(5);
      expect(engine.prayerState.points).toBe(40);
    });

    it('procs on the ruby bolt Blood Forfeit HP cost the player pays to attack', () => {
      // The proc damages the SHOOTER, so it arrives through the attacker side of the same resolved
      // hit rather than through `onDamageApplied`. floor(10 / 10) = 1, leaving 9 of 99.
      const { engine, player } = makeRedemptionEngine({ hp: 10 });
      engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-set' });
      const victim = engine['worldState'].getNpcs().find((npc) => npc.npcTypeId === 7703);
      if (!victim) throw new TypeError('Missing victim');

      commitAttack(engine, {
        attacker: player,
        target: victim,
        attack: {
          style: 'range',
          attackKind: 'range_arrow',
          rolledDamage: 6,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          sourceSelfDamageRatio: { numerator: 1, denominator: 10 },
        },
      });

      expect(player.vitals.hp).toBe(9 + 24);
      expect(engine.prayerState.points).toBe(0);
    });
  });

  describe('self-damage path', () => {
    const ROCK_CAKE_ID = 7510;
    const LOCATOR_ORB_ID = 22081;

    /** Guzzle/Feel is an inventory option, so it resolves through the item path, not a hit. */
    function useItem(engine: SimulationEngine, itemId: number): void {
      engine.setInventory([{ id: itemId }]);
      engine.queueItemAction(0, itemId === ROCK_CAKE_ID ? 'guzzle' : 'default');
      engine.advanceTick(engine.getState().playerPosition);
    }

    it('procs when a rock cake guzzle drops HP below 10%', () => {
      const { engine, player } = makeRedemptionEngine({ hp: 10 });

      useItem(engine, ROCK_CAKE_ID);

      // Guzzle removes floor(10 / 10) + 1, then Redemption restores 24.
      expect(player.vitals.hp).toBe(32);
      expect(engine.prayerState.points).toBe(0);
    });

    it('procs when the orb is clicked FIRST and Redemption is lit later in the same tick', () => {
      // The self-damage hit resolves in the queue band, after the whole input FIFO, so a prayer
      // clicked after the item is already lit by the time it lands.
      const { engine, player } = makeRedemptionEngine({ hp: 15, lit: false });
      engine.setInventory([{ id: LOCATOR_ORB_ID }]);

      engine.queueItemAction(0);
      engine.queueProtectionPrayer(PrayerType.Redemption);
      engine.advanceTick(engine.getState().playerPosition);

      // 15 - 10 = 5, below the threshold, so the heal lands: 5 + 24.
      expect(player.vitals.hp).toBe(29);
      expect(engine.prayerState.points).toBe(0);
    });

    it('procs with the clicks in the other order too', () => {
      const { engine, player } = makeRedemptionEngine({ hp: 15, lit: false });
      engine.setInventory([{ id: LOCATOR_ORB_ID }]);

      engine.queueProtectionPrayer(PrayerType.Redemption);
      engine.queueItemAction(0);
      engine.advanceTick(engine.getState().playerPosition);

      expect(player.vitals.hp).toBe(29);
      expect(engine.prayerState.points).toBe(0);
    });

    it('heals before a same-tick hazard that would otherwise kill the player', () => {
      // The orb's HP loss lands mid-FIFO but its proc cannot resolve there, because the Redemption
      // clicked after it is not lit yet. The proc must still land before the hazard band: deferring
      // it as far as the queue band let this hazard kill a player whose proc was already earned.
      const { engine, player } = makeRedemptionEngine({ hp: 15, lit: false });
      engine.setInventory([{ id: LOCATOR_ORB_ID }]);
      vi.spyOn(engine['encounter'], 'resolveHazards').mockReturnValueOnce([
        { baseDamage: 6, attackType: 'typeless', source: 'Poison' },
      ]);

      engine.queueItemAction(0);
      engine.queueProtectionPrayer(PrayerType.Redemption);
      engine.advanceTick(engine.getState().playerPosition);

      // Orb 15 -> 5, proc heals to 29, then the hazard takes 6.
      expect(player.alive).toBe(true);
      expect(player.vitals.hp).toBe(23);
      expect(engine.prayerState.points).toBe(0);
    });

    it('procs on the 0-damage guzzle at 1 HP', () => {
      // OSRS Wiki (Dwarven rock cake rev 15341177): guzzling at 1 HP "will still hit the player,
      // but for 0 damage". The 1-HP floor removes the damage, not the hit.
      const { engine, player } = makeRedemptionEngine({ hp: 1 });

      useItem(engine, ROCK_CAKE_ID);

      expect(player.vitals.hp).toBe(25);
      expect(engine.prayerState.points).toBe(0);
    });

    it('procs on locator orb self-damage', () => {
      const { engine, player } = makeRedemptionEngine({ hp: 15 });

      useItem(engine, LOCATOR_ORB_ID);

      // 15 - 10 = 5, below the threshold.
      expect(player.vitals.hp).toBe(29);
      expect(engine.prayerState.points).toBe(0);
    });

    it('does not proc while the self-damage leaves HP at or above 10%', () => {
      const { engine, player } = makeRedemptionEngine({ hp: 20 });

      useItem(engine, ROCK_CAKE_ID);

      expect(player.vitals.hp).toBe(17);
      expect(engine.prayerState.points).toBe(40);
    });

    it('preserves the self-damage splat and Redemption graphic without a healing hitsplat', () => {
      const { engine } = makeRedemptionEngine({ hp: 10 });

      useItem(engine, ROCK_CAKE_ID);

      const splats = engine
        .getLastTickEvents()
        .filter((event) => event.type === 'hitsplat_spawned' && event.targetId === 'player');
      expect(splats).toMatchObject([{ amount: 2, hitsplatType: 'damage' }]);
      expect(engine.getLastTickEvents()).toContainEqual(expect.objectContaining({ type: 'player_graphic_applied' }));
    });
  });
});

describe('SimulationEngine Preserve', () => {
  function makePreserveEngine() {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(7), startPos: [31, 37] });
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    const player = engine['worldState'].getPlayer();
    if (!player) throw new TypeError('Missing player actor');
    player.stats.strength = { current: 118, max: 99 };
    return { engine, player };
  }

  it.each([PrayerType.Piety, PrayerType.Zeal])('stacks with an overhead and %s, and all three drain', (offensive) => {
    const { engine, player } = makePreserveEngine();
    engine.setMechanicsConfig({ ...engine.getState().mechanicsConfig, zealPrayer: offensive === PrayerType.Zeal });

    engine.queueProtectionPrayer(PrayerType.Redemption);
    engine.queueOffensivePrayer(offensive);
    engine.queueIndependentPrayer(PrayerType.Preserve);
    engine.advanceTick(engine.getState().playerPosition);

    expect(engine.activePrayer).toBe(PrayerType.Redemption);
    expect(engine.offensivePrayer).toBe(offensive);
    expect(engine.independentPrayers).toEqual([PrayerType.Preserve]);
    expect(player.prayerState.activePrayers).toEqual([PrayerType.Redemption, offensive, PrayerType.Preserve]);
  });

  it('postpones the tick-100 decay to 150 and keeps the boosted level', () => {
    const { engine, player } = makePreserveEngine();
    engine.queueIndependentPrayer(PrayerType.Preserve);

    for (let tick = 0; tick < 101; tick += 1) {
      engine.advanceTick(engine.getState().playerPosition);
    }

    // Lit on tick 1 and long past the 25-tick gate by the tick-100 check, so that check is
    // postponed rather than taken: the level survives and the drain moves to 150.
    expect(player.combatTimers.statBoostDecayTick).toBe(150);
    expect(player.combatTimers.statBoostDecayExtended).toBe(true);
    expect(player.stats.strength.current).toBe(118);
  });

  it('takes the level at the postponed check, 50 ticks later than it otherwise would', () => {
    const { engine, player } = makePreserveEngine();
    engine.queueIndependentPrayer(PrayerType.Preserve);

    for (let tick = 0; tick < 151; tick += 1) {
      engine.advanceTick(engine.getState().playerPosition);
    }

    expect(player.stats.strength.current).toBe(117);
    expect(player.combatTimers.statBoostDecayExtended).toBe(false);
    expect(player.combatTimers.statBoostDecayTick).toBe(250);
  });

  it('leaves the interval at 100 ticks when it is not lit', () => {
    const { engine, player } = makePreserveEngine();

    for (let tick = 0; tick < 101; tick += 1) {
      engine.advanceTick(engine.getState().playerPosition);
    }

    expect(player.combatTimers.statBoostDecayTick).toBe(200);
    expect(player.stats.strength.current).toBe(117);
  });

  it('postpones the boost decay but not the recovery of a drained skill', () => {
    const { engine, player } = makePreserveEngine();
    player.stats.attack = { current: 80, max: 99 };
    engine.queueIndependentPrayer(PrayerType.Preserve);

    advanceToTick(engine, 101);
    expect(player.stats.strength.current).toBe(118);
    expect(player.stats.attack.current).toBe(81);

    advanceToTick(engine, 151);
    expect(player.stats.strength.current).toBe(117);
    expect(player.stats.attack.current).toBe(81);

    advanceToTick(engine, 201);
    expect(player.stats.attack.current).toBe(82);
    expect(player.combatTimers.statRecoveryTick).toBe(300);
  });

  it('goes dark with everything else when prayer points run out', () => {
    const { engine } = makePreserveEngine();
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.queueIndependentPrayer(PrayerType.Preserve);
    engine.advanceTick(engine.getState().playerPosition);
    engine.prayerState.points = 1;

    for (let tick = 0; tick < 10; tick += 1) {
      engine.advanceTick(engine.getState().playerPosition);
    }

    expect(engine.prayerState.points).toBe(0);
    expect(engine.activePrayer).toBeNull();
    expect(engine.independentPrayers).toEqual([]);
  });
});

describe('SimulationEngine prayer unlock toggles', () => {
  function makeEngine(config: Parameters<SimulationEngine['setMechanicsConfig']>[0]): SimulationEngine {
    const engine = new SimulationEngine({ encounter: new LobbyEncounter() });
    engine.setMechanicsConfig(config);
    return engine;
  }
  const tick = (engine: SimulationEngine): void => engine.advanceTick(engine.getState().playerPosition);
  const prayerEvents = (engine: SimulationEngine) =>
    engine
      .getLastTickEvents()
      .filter((event) => event.type === 'prayer_changed' || event.type === 'prayer_activation_failed');

  it('drops a queued Zeal click while Zeal is locked by default, without a rejection', () => {
    const engine = makeEngine({});
    engine.queueOffensivePrayer(PrayerType.Zeal);
    tick(engine);

    expect(engine.offensivePrayer).toBeNull();
    expect(engine.prayerState.activePrayers).toEqual([]);
    expect(prayerEvents(engine)).toEqual([]);
  });

  it('lights only the unlocked prayers of a quick-prayer set', () => {
    const engine = makeEngine({});
    engine.queueQuickPrayerToggle([PrayerType.ProtectMelee, PrayerType.Zeal]);
    tick(engine);

    expect(engine.activePrayer).toBe(PrayerType.ProtectMelee);
    expect(engine.offensivePrayer).toBeNull();
  });

  it.each([
    [PrayerType.Zeal, 'zealPrayer'],
    [PrayerType.Deadeye, 'upgradedPrayers'],
    [PrayerType.MysticVigour, 'upgradedPrayers'],
  ] as const)('turns %s off when %s is switched off', (prayer, key) => {
    const engine = makeEngine({ [key]: true });
    engine.queueOffensivePrayer(prayer);
    tick(engine);
    expect(engine.offensivePrayer).toBe(prayer);

    engine.setMechanicsConfig({ [key]: false });
    expect(engine.offensivePrayer).toBeNull();
    expect(engine.prayerState.activePrayers).toEqual([]);
    tick(engine);
    expect(prayerEvents(engine)).toEqual([expect.objectContaining({ type: 'prayer_changed', from: prayer, to: null })]);
  });

  it('keeps unlocked prayers lit and never swaps Piety for Zeal', () => {
    const engine = makeEngine({});
    engine.queueOffensivePrayer(PrayerType.Deadeye);
    tick(engine);
    engine.setMechanicsConfig({ infiniteHealth: true });
    expect(engine.offensivePrayer).toBe(PrayerType.Deadeye);

    engine.queueOffensivePrayer(PrayerType.Piety);
    tick(engine);
    engine.setMechanicsConfig({ zealPrayer: true });
    expect(engine.offensivePrayer).toBe(PrayerType.Piety);
  });
});

function advanceToTick(engine: SimulationEngine, tick: number): void {
  while (engine.getState().currentTick < tick) engine.advanceTick(engine.getState().playerPosition);
}

const SARADOMIN_BREW = 6685;
const SUPER_RESTORE = 3024;
const DIVINE_SUPER_COMBAT = 23685;

describe('SimulationEngine stat levels', () => {
  function makeStatEngine() {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(7), startPos: [31, 37] });
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    const player = engine['worldState'].getPlayer();
    if (!player) throw new TypeError('Missing player actor');
    return { engine, player };
  }

  /** Drink on the next tick, then wait out the 3-tick potion delay. */
  function drink(engine: SimulationEngine, itemId: number): void {
    engine.setInventory([{ id: itemId }]);
    engine.queueItemAction(0);
    engine.advanceTick(engine.getState().playerPosition);
    engine.advanceTick(engine.getState().playerPosition);
    engine.advanceTick(engine.getState().playerPosition);
  }

  it('never resurrects a drained boost: 110 Ranged, five brews, a super restore, then natural change', () => {
    // A boost record that survived the brews and restore would make the next decay recompute
    // Ranged as base + remembered boost - 1 = 109.
    const { engine, player } = makeStatEngine();
    player.stats.ranged = { current: 110, max: 99 };

    const afterEachBrew: number[] = [];
    for (let dose = 0; dose < 5; dose++) {
      drink(engine, SARADOMIN_BREW);
      afterEachBrew.push(player.stats.ranged.current);
    }
    drink(engine, SUPER_RESTORE);
    const afterRestore = player.stats.ranged.current;

    advanceToTick(engine, 100);
    const beforeCycle = player.stats.ranged.current;
    advanceToTick(engine, 101);
    const afterFirstCycle = player.stats.ranged.current;
    advanceToTick(engine, 201);

    // Each brew drains floor(C / 10) + 2 from the current level.
    expect(afterEachBrew).toEqual([97, 86, 76, 67, 59]);
    expect(afterRestore).toBe(91); // + floor(99 / 4) + 8
    expect(beforeCycle).toBe(91);
    expect(afterFirstCycle).toBe(92);
    expect(player.stats.ranged.current).toBe(93);
  });

  describe('divine decay lock', () => {
    it('stops the boost decaying, but not a later drain or the recovery of the drained skills', () => {
      const { engine, player } = makeStatEngine();
      drink(engine, DIVINE_SUPER_COMBAT);
      drink(engine, SARADOMIN_BREW);

      // The brew still drains a locked skill, from its current level.
      expect(player.stats.attack.current).toBe(105); // 118 - (11 + 2)
      expect(player.stats.defence.current).toBe(120);
      expect(player.stats.ranged.current).toBe(88);

      advanceToTick(engine, 201);

      expect(player.stats.attack.current).toBe(105);
      expect(player.stats.defence.current).toBe(120);
      expect(player.stats.ranged.current).toBe(90);
    });

    it('drops a skill still above base straight to base when it expires, 499 ticks after a live drink', () => {
      const { engine, player } = makeStatEngine();
      engine.setInventory([{ id: DIVINE_SUPER_COMBAT }]);
      engine.queueItemAction(0);
      advanceToTick(engine, 1);
      // Set in tick 1's input band and counted down by the same tick's timer band.
      expect(player.combatTimers.statDecayLocks.attack?.ticksRemaining).toBe(499);

      advanceToTick(engine, 499);
      expect(player.stats.attack.current).toBe(118);
      expect(player.combatTimers.statDecayLocks.attack?.ticksRemaining).toBe(1);

      advanceToTick(engine, 500);
      expect(player.stats.attack.current).toBe(99);
      expect(player.combatTimers.statDecayLocks).toEqual({});
    });

    it('leaves a skill drained below base where it is when it expires', () => {
      const { engine, player } = makeStatEngine();
      drink(engine, DIVINE_SUPER_COMBAT);
      drink(engine, SARADOMIN_BREW); // 118 -> 105
      drink(engine, SARADOMIN_BREW); // 105 -> 93

      advanceToTick(engine, 500);

      // Recovered at 101, 201, 301 and 401, and not reset to base by the expiry.
      expect(player.stats.attack.current).toBe(97);
    });

    it('refreshes on a re-drink on the tick it would have expired, before it can expire', () => {
      const { engine, player } = makeStatEngine();
      drink(engine, DIVINE_SUPER_COMBAT); // tick 1: would expire on tick 500
      advanceToTick(engine, 499);

      engine.setInventory([{ id: DIVINE_SUPER_COMBAT }]);
      engine.queueItemAction(0);
      advanceToTick(engine, 500);

      // Refreshed in the input band, then counted down with every other lock that tick.
      expect(player.stats.attack.current).toBe(118);
      expect(player.combatTimers.statDecayLocks.attack?.ticksRemaining).toBe(499);

      advanceToTick(engine, 998);
      expect(player.stats.attack.current).toBe(118);
      advanceToTick(engine, 999);
      expect(player.stats.attack.current).toBe(99);
    });

    it('is applied by Auto-Prepot without the Hitpoints cost, and expires on tick 500', () => {
      const { engine, player } = makeStatEngine();
      engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true, autoPrepot: true });
      engine.setInventory([{ id: DIVINE_SUPER_COMBAT }]);
      const hpBefore = player.vitals.hp;

      engine.applyPrepotEffects();

      expect(player.vitals.hp).toBe(hpBefore);
      expect(player.stats.attack.current).toBe(118);
      expect(player.combatTimers.statDecayLocks.attack).toEqual({ ticksRemaining: 500, source: 'divine' });

      advanceToTick(engine, 499);
      expect(player.stats.attack.current).toBe(118);
      advanceToTick(engine, 500);
      expect(player.stats.attack.current).toBe(99);
    });
  });

  describe('Rapid Restore', () => {
    function makeDrainedEngine() {
      const { engine, player } = makeStatEngine();
      player.stats.ranged = { current: 60, max: 99 };
      return { engine, player };
    }

    it('restores a drained skill every 100 ticks from the tick it was lit, beside the normal recovery', () => {
      const { engine, player } = makeDrainedEngine();
      advanceToTick(engine, 29);
      engine.queueIndependentPrayer(PrayerType.RapidRestore);
      advanceToTick(engine, 30);

      const levels = new Map<number, number>();
      for (const tick of [100, 101, 129, 130, 201, 229, 230]) {
        advanceToTick(engine, tick);
        levels.set(tick, player.stats.ranged.current);
      }

      expect(Object.fromEntries(levels)).toEqual({
        100: 60,
        101: 61, // normal recovery
        129: 61,
        130: 62, // Rapid Restore, 100 ticks after it was lit on tick 30
        201: 63,
        229: 63,
        230: 64,
      });
    });

    it('adds its +1 to a normal recovery that falls on the same tick', () => {
      const { engine, player } = makeDrainedEngine();
      engine.queueIndependentPrayer(PrayerType.RapidRestore); // lit on tick 1

      advanceToTick(engine, 100);
      expect(player.stats.ranged.current).toBe(60);
      advanceToTick(engine, 101);
      expect(player.stats.ranged.current).toBe(62);
    });

    it('re-phases from a flick back on, and does nothing while off', () => {
      const { engine, player } = makeDrainedEngine();
      advanceToTick(engine, 29);
      engine.queueIndependentPrayer(PrayerType.RapidRestore); // on at 30
      advanceToTick(engine, 79);
      engine.queueIndependentPrayer(PrayerType.RapidRestore); // off at 80
      advanceToTick(engine, 89);
      engine.queueIndependentPrayer(PrayerType.RapidRestore); // on at 90

      advanceToTick(engine, 130);
      expect(player.stats.ranged.current).toBe(61); // only the normal recovery at 101
      advanceToTick(engine, 190);
      expect(player.stats.ranged.current).toBe(62);
    });

    it('stops restoring once deactivated', () => {
      const { engine, player } = makeDrainedEngine();
      advanceToTick(engine, 29);
      engine.queueIndependentPrayer(PrayerType.RapidRestore); // on at 30
      advanceToTick(engine, 99);
      engine.queueIndependentPrayer(PrayerType.RapidRestore); // off at 100

      advanceToTick(engine, 230);
      expect(player.stats.ranged.current).toBe(62); // normal recoveries at 101 and 201 only
    });

    it('does not fire on the tick prayer points run out, because prayer drain runs first', () => {
      const { engine, player } = makeDrainedEngine();
      advanceToTick(engine, 29);
      engine.queueIndependentPrayer(PrayerType.RapidRestore); // on at 30
      advanceToTick(engine, 129);
      // The last point goes on tick 130, the same tick the restore would fire.
      engine.prayerState.points = 1;
      engine.prayerState.drainCounter = 59;

      advanceToTick(engine, 130);

      expect(engine.prayerState.points).toBe(0);
      expect(engine.independentPrayers).toEqual([]);
      expect(player.stats.ranged.current).toBe(61); // the normal recovery at 101, nothing at 130
    });

    it('restores drained Agility too, with its +1 on top of a coincident normal recovery', () => {
      const { engine, player } = makeStatEngine();
      player.stats.agility = { current: 60, max: 99 };
      engine.queueIndependentPrayer(PrayerType.RapidRestore); // lit on tick 1

      advanceToTick(engine, 100);
      expect(player.stats.agility.current).toBe(60);
      advanceToTick(engine, 101);
      expect(player.stats.agility.current).toBe(62);
    });

    it('never lowers a boosted skill', () => {
      const { engine, player } = makeStatEngine();
      player.stats.magic = { current: 110, max: 99 };
      advanceToTick(engine, 29);
      engine.queueIndependentPrayer(PrayerType.RapidRestore);

      advanceToTick(engine, 130);

      expect(player.stats.magic.current).toBe(109); // the normal decay at 101 only
    });
  });
});

describe('SimulationEngine natural Hitpoints', () => {
  function makeHpEngine(hp: number) {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(7), startPos: [31, 37] });
    engine.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: false });
    const player = engine['worldState'].getPlayer();
    if (!player) throw new TypeError('Missing player actor');
    player.vitals.hp = hp;
    return { engine, player };
  }

  function hpAt(engine: SimulationEngine, ticks: readonly number[]): Record<number, number> {
    const out: Record<number, number> = {};
    for (const tick of ticks) {
      advanceToTick(engine, tick);
      out[tick] = engine.getState().playerHP;
    }
    return out;
  }

  /** Queue one Rapid Heal click to land on `tick`. */
  function toggleRapidHealOn(engine: SimulationEngine, tick: number): void {
    advanceToTick(engine, tick - 1);
    engine.queueIndependentPrayer(PrayerType.RapidHeal);
    advanceToTick(engine, tick);
  }

  it('heals 1 below max on tick 101 and every 100 ticks after, whatever else happens', () => {
    const { engine } = makeHpEngine(50);

    expect(hpAt(engine, [100, 101, 200, 201, 301])).toEqual({ 100: 50, 101: 51, 200: 51, 201: 52, 301: 53 });
  });

  it('loses 1 of an overheal on the same cycle', () => {
    const { engine } = makeHpEngine(110);

    expect(hpAt(engine, [100, 101, 201])).toEqual({ 100: 110, 101: 109, 201: 108 });
  });

  it('does nothing at max, but the deadline still moves on', () => {
    const { engine, player } = makeHpEngine(99);

    advanceToTick(engine, 101);

    expect(player.vitals.hp).toBe(99);
    expect(player.combatTimers.hpRegenTick).toBe(201);
  });

  it('is not restarted by damage or healing', () => {
    const { engine, player } = makeHpEngine(50);
    advanceToTick(engine, 60);
    player.vitals.hp = 40;
    advanceToTick(engine, 80);
    player.vitals.hp = 45;

    advanceToTick(engine, 101);

    expect(player.vitals.hp).toBe(46);
  });

  it('never shows a hitsplat or procs Redemption', () => {
    const { engine } = makeHpEngine(110);
    advanceToTick(engine, 100);

    engine.advanceTick(engine.getState().playerPosition);

    expect(engine.getLastTickEvents().filter((event) => event.type === 'hitsplat_spawned')).toEqual([]);
  });

  describe('Rapid Heal', () => {
    it('restarts the countdown at 50 ticks when lit, then heals every 50', () => {
      const { engine, player } = makeHpEngine(50);
      toggleRapidHealOn(engine, 30);

      expect(player.combatTimers.hpRegenTick).toBe(80);
      expect(hpAt(engine, [79, 80, 129, 130, 180])).toEqual({ 79: 50, 80: 51, 129: 51, 130: 52, 180: 53 });
    });

    it('also takes an overheal down every 50 ticks while lit', () => {
      const { engine } = makeHpEngine(110);
      toggleRapidHealOn(engine, 30);

      expect(hpAt(engine, [80, 130])).toEqual({ 80: 109, 130: 108 });
    });

    it('restarts the countdown at 100 ticks when turned off', () => {
      const { engine, player } = makeHpEngine(50);
      toggleRapidHealOn(engine, 30);
      toggleRapidHealOn(engine, 60); // the second click turns it off

      expect(engine.independentPrayers).toEqual([]);
      expect(player.combatTimers.hpRegenTick).toBe(160);
      expect(hpAt(engine, [80, 159, 160])).toEqual({ 80: 50, 159: 50, 160: 51 });
    });

    it('takes the last transition of a same-tick flick', () => {
      const { engine, player } = makeHpEngine(50);
      toggleRapidHealOn(engine, 30);

      advanceToTick(engine, 59);
      engine.queueIndependentPrayer(PrayerType.RapidHeal); // off
      engine.queueIndependentPrayer(PrayerType.RapidHeal); // on
      advanceToTick(engine, 60);
      expect(engine.independentPrayers).toEqual([PrayerType.RapidHeal]);
      expect(player.combatTimers.hpRegenTick).toBe(110);

      advanceToTick(engine, 89);
      engine.queueIndependentPrayer(PrayerType.RapidHeal); // off
      engine.queueIndependentPrayer(PrayerType.RapidHeal); // on
      engine.queueIndependentPrayer(PrayerType.RapidHeal); // off
      advanceToTick(engine, 90);
      expect(engine.independentPrayers).toEqual([]);
      expect(player.combatTimers.hpRegenTick).toBe(190);
    });

    it('does not restart the countdown on a rejected activation', () => {
      const { engine, player } = makeHpEngine(50);
      engine.prayerState.points = 0;
      engine.stats.prayer.current = 0;

      toggleRapidHealOn(engine, 30);

      expect(engine.independentPrayers).toEqual([]);
      expect(player.combatTimers.hpRegenTick).toBe(101);
    });

    it('does not restart the countdown when quick prayers keep an already-lit Rapid Heal lit', () => {
      const { engine, player } = makeHpEngine(50);
      toggleRapidHealOn(engine, 30);

      advanceToTick(engine, 39);
      engine.queueQuickPrayerToggle([PrayerType.RapidHeal, PrayerType.ProtectMelee]);
      advanceToTick(engine, 40);

      expect(engine.activePrayer).toBe(PrayerType.ProtectMelee);
      expect(engine.independentPrayers).toEqual([PrayerType.RapidHeal]);
      expect(player.combatTimers.hpRegenTick).toBe(80);
    });

    it('counts running out of prayer points as turning it off', () => {
      const { engine, player } = makeHpEngine(50);
      toggleRapidHealOn(engine, 30);
      advanceToTick(engine, 44);
      // Rapid Heal adds 2 a tick against a resistance of 60: the last point goes on tick 45.
      engine.prayerState.points = 1;
      engine.prayerState.drainCounter = 58;

      advanceToTick(engine, 45);

      expect(engine.prayerState.points).toBe(0);
      expect(engine.independentPrayers).toEqual([]);
      expect(player.combatTimers.hpRegenTick).toBe(145);
      expect(hpAt(engine, [80, 145])).toEqual({ 80: 50, 145: 51 });
    });

    it('counts a Redemption proc, which burns every point, as turning it off', () => {
      const { engine, player } = makeHpEngine(50);
      engine.queueProtectionPrayer(PrayerType.Redemption);
      toggleRapidHealOn(engine, 30);
      player.vitals.hp = 15;
      vi.spyOn(engine['encounter'], 'resolveHazards').mockReturnValueOnce([
        { baseDamage: 6, attackType: 'typeless', source: 'Poison' },
      ]);

      advanceToTick(engine, 31);

      expect(player.vitals.hp).toBe(33); // 15 - 6 = 9, then + floor(99 * 0.25)
      expect(engine.independentPrayers).toEqual([]);
      expect(player.combatTimers.hpRegenTick).toBe(131);
    });
  });

  it('resolves Redemption before a regen on the same tick', () => {
    const { engine, player } = makeHpEngine(50);
    engine.queueProtectionPrayer(PrayerType.Redemption);
    advanceToTick(engine, 100);
    player.vitals.hp = 15;
    vi.spyOn(engine['encounter'], 'resolveHazards').mockReturnValueOnce([
      { baseDamage: 6, attackType: 'typeless', source: 'Poison' },
    ]);

    advanceToTick(engine, 101);

    // 15 - 6 = 9 procs Redemption (+24 = 33), then the regen adds 1.
    expect(player.vitals.hp).toBe(34);
    expect(engine.prayerState.points).toBe(0);
    const splats = engine.getLastTickEvents().filter((event) => event.type === 'hitsplat_spawned');
    expect(splats).toMatchObject([{ amount: 6 }]);
  });

  it('does not heal a player a hit killed on the regen tick', () => {
    const { engine, player } = makeHpEngine(50);
    advanceToTick(engine, 100);
    player.vitals.hp = 3;
    vi.spyOn(engine['encounter'], 'resolveHazards').mockReturnValueOnce([
      { baseDamage: 5, attackType: 'typeless', source: 'Poison' },
    ]);

    engine.advanceTick(engine.getState().playerPosition);

    expect(player.alive).toBe(false);
    expect(player.vitals.hp).toBe(0); // no +1 after the death
  });

  it('does not heal a player poison killed on the regen tick', () => {
    const { engine, player } = makeHpEngine(50);
    advanceToTick(engine, 100);
    player.vitals.hp = 3;
    player.poisonState = { poisonVarp: 30, poisonTickCounter: 1, startedTick: null };

    engine.advanceTick(engine.getState().playerPosition);

    expect(player.alive).toBe(false);
    expect(player.vitals.hp).toBe(0); // no +1 after the death
  });
});

type LockPhase = 'tickStart' | 'npcBand' | 'postTick' | 'damage';

/**
 * Yama with no attacks, scripted to teleport the player from its NPC band and to lock the player's
 * actions from each phase that can: tick start, the NPC band, after movement, and a landed hit.
 */
class ScriptedPlayerEncounter extends YamaEncounter {
  readonly teleports = new Map<number, { position: Coordinate; facing: number }>();
  readonly locks: { tick: number; phase: LockPhase; unlockTick: number }[] = [];

  private lockFrom(phase: LockPhase, tick: number, lock: (unlockTick: number) => void): void {
    for (const entry of this.locks) if (entry.tick === tick && entry.phase === phase) lock(entry.unlockTick);
  }

  override getEngineRules(): EncounterEngineRules {
    const base = super.getEngineRules();
    return {
      ...base,
      onTickStart: (ctx) => {
        this.lockFrom('tickStart', ctx.tick, ctx.lockPlayerActionsUntil);
        return base?.onTickStart?.(ctx) ?? null;
      },
      onPlayerDamageTaken: (info, ctx) => {
        this.lockFrom('damage', ctx.tick, ctx.lockPlayerActionsUntil);
        return base?.onPlayerDamageTaken?.(info, ctx) ?? null;
      },
    };
  }

  prepareNpcBand(ctx: EncounterContext): void {
    const teleport = this.teleports.get(ctx.tick);
    if (teleport) ctx.teleportPlayer(teleport.position, teleport.facing);
    this.lockFrom('npcBand', ctx.tick, ctx.lockPlayerActionsUntil);
  }

  override processPostTick(ctx: EncounterContext, mechanics: Partial<MechanicsConfig>): EnvironmentalDamage[] {
    const damage = super.processPostTick(ctx, mechanics);
    this.lockFrom('postTick', ctx.tick, ctx.lockPlayerActionsUntil);
    return damage;
  }
}

describe('SimulationEngine scripted player control', () => {
  const START: Coordinate = [31, 37];
  const TARGET: Coordinate = [31, 45];
  const LANDING: Coordinate = [33, 37];

  function makeScriptedEngine(): { engine: SimulationEngine; encounter: ScriptedPlayerEncounter } {
    const encounter = new ScriptedPlayerEncounter();
    const engine = new SimulationEngine({ encounter, startPos: START });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      yamaMelee: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    return { engine, encounter };
  }
  const player = (engine: SimulationEngine) => {
    const actor = engine['worldState'].getPlayer();
    if (!actor) throw new Error('missing player');
    return actor;
  };
  /** Advances to `toTick` walking toward TARGET, returning which ticks discarded it. */
  function discardingTicks(engine: SimulationEngine, toTick: number): number[] {
    const ticks: number[] = [];
    while (engine.currentTick < toTick) {
      engine.advanceTick(TARGET);
      if (engine.didLastTickDiscardWalkTarget()) ticks.push(engine.currentTick);
    }
    return ticks;
  }

  it('ends the walk in progress on a teleport, keeping the tick’s other inputs, and walks a fresh click', () => {
    const { engine, encounter } = makeScriptedEngine();
    encounter.teleports.set(3, { position: LANDING, facing: 1024 });
    engine.advanceTick(TARGET);
    engine.advanceTick(TARGET);
    const walking = engine.getState().playerPosition;
    expect(walking).not.toEqual(START);
    expect(walking).not.toEqual(TARGET);
    expect(engine.didLastTickDiscardWalkTarget()).toBe(false);

    engine.applyAction({ type: 'protectionPrayer', prayer: PrayerType.ProtectMagic });
    engine.advanceTick(TARGET);
    expect(engine.currentTick).toBe(3);
    // Exactly the landing tile and facing: no step toward the target the tick was given.
    expect(player(engine).position).toEqual(LANDING);
    expect(player(engine).facing).toBe(1024);
    expect(player(engine).movementPath).toEqual([]);
    expect(engine.didLastTickDiscardWalkTarget()).toBe(true);
    // A teleport is not an action lock: the prayer clicked for the same tick still applies.
    expect(player(engine).activePrayer).toBe(PrayerType.ProtectMagic);

    // The same coordinate clicked again walks from the landing tile.
    engine.advanceTick(TARGET);
    expect(engine.didLastTickDiscardWalkTarget()).toBe(false);
    expect(player(engine).position).not.toEqual(LANDING);
  });

  it('locks only the current tick with an unlock tick one past it, dropping that tick’s inputs', () => {
    const { engine, encounter } = makeScriptedEngine();
    encounter.locks.push({ tick: 2, phase: 'tickStart', unlockTick: 3 });
    engine.advanceTick(START);
    engine.applyAction({ type: 'protectionPrayer', prayer: PrayerType.ProtectMagic });
    engine.advanceTick(TARGET);
    expect(engine.didLastTickDiscardWalkTarget()).toBe(true);
    expect(player(engine).activePrayer).toBeNull();
    expect(player(engine).position).toEqual(START);
    expect(discardingTicks(engine, 5)).toEqual([]);
    expect(player(engine).position).not.toEqual(START);
  });

  it('locks every tick before the unlock tick', () => {
    const { engine, encounter } = makeScriptedEngine();
    encounter.locks.push({ tick: 2, phase: 'tickStart', unlockTick: 6 });
    expect(discardingTicks(engine, 8)).toEqual([2, 3, 4, 5]);
  });

  it('extends a lock but never shortens it', () => {
    const { engine, encounter } = makeScriptedEngine();
    encounter.locks.push(
      { tick: 2, phase: 'tickStart', unlockTick: 7 }, // locked 2..6
      { tick: 3, phase: 'tickStart', unlockTick: 4 }, // inside it: no shorter
      { tick: 5, phase: 'tickStart', unlockTick: 9 }, // locked through 8
    );
    expect(discardingTicks(engine, 11)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it('ignores an unlock tick that has already come, and rejects one that is not a safe integer', () => {
    const { engine, encounter } = makeScriptedEngine();
    encounter.locks.push(
      { tick: 2, phase: 'tickStart', unlockTick: 2 },
      { tick: 2, phase: 'npcBand', unlockTick: 1 },
      { tick: 3, phase: 'postTick', unlockTick: -5 },
    );
    expect(discardingTicks(engine, 4)).toEqual([]);
    expect(player(engine).position).not.toEqual(START);

    for (const unlockTick of [2.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const run = makeScriptedEngine();
      run.encounter.locks.push({ tick: 1, phase: 'tickStart', unlockTick });
      expect(() => run.engine.advanceTick(START)).toThrow(RangeError);
    }
  });

  it('clears a live lock on reset', () => {
    const { engine, encounter } = makeScriptedEngine();
    encounter.locks.push({ tick: 2, phase: 'tickStart', unlockTick: 13 });
    expect(discardingTicks(engine, 3)).toEqual([2, 3]);
    encounter.locks.length = 0;
    engine.reset(START);
    expect(engine.didLastTickDiscardWalkTarget()).toBe(false);
    expect(discardingTicks(engine, 4)).toEqual([]);
  });

  it('keeps an input already applied by an NPC-band lock, but not the step', () => {
    const { engine, encounter } = makeScriptedEngine();
    encounter.locks.push({ tick: 3, phase: 'npcBand', unlockTick: 5 });
    expect(discardingTicks(engine, 2)).toEqual([]);
    const walking = engine.getState().playerPosition;
    expect(walking).not.toEqual(START);

    engine.applyAction({ type: 'protectionPrayer', prayer: PrayerType.ProtectMagic });
    engine.advanceTick(TARGET);
    expect(engine.didLastTickDiscardWalkTarget()).toBe(true);
    expect(player(engine).activePrayer).toBe(PrayerType.ProtectMagic);
    expect(player(engine).position).toEqual(walking);
    expect(discardingTicks(engine, 5)).toEqual([4]);
    expect(player(engine).position).not.toEqual(walking);
  });

  it('keeps the step a post-movement lock comes after, and locks the ticks that follow', () => {
    const { engine, encounter } = makeScriptedEngine();
    encounter.locks.push({ tick: 2, phase: 'postTick', unlockTick: 4 });
    engine.advanceTick(TARGET);
    const before = engine.getState().playerPosition;

    engine.advanceTick(TARGET);
    const stepped = engine.getState().playerPosition;
    expect(stepped).not.toEqual(before);
    expect(engine.getLastTickEvents().some((event) => event.type === 'movement')).toBe(true);
    expect(engine.didLastTickDiscardWalkTarget()).toBe(true);

    expect(discardingTicks(engine, 3)).toEqual([3]);
    expect(player(engine).position).toEqual(stepped);
    expect(discardingTicks(engine, 4)).toEqual([]);
    expect(player(engine).position).not.toEqual(stepped);
  });

  it('locks from the hit that lands, stopping that tick’s step', () => {
    const { engine, encounter } = makeScriptedEngine();
    encounter.locks.push({ tick: 3, phase: 'damage', unlockTick: 5 });
    expect(discardingTicks(engine, 2)).toEqual([]);
    const walking = engine.getState().playerPosition;
    enqueueEnginePendingHit(engine, {
      sourceId: YAMA_TARGET_ID,
      targetId: 'player',
      style: 'typeless',
      attackKind: 'typeless',
      launchTick: 2,
      impactTick: 3,
      rolledDamage: 1,
      accuracySucceeded: true,
    });

    engine.advanceTick(TARGET);
    expect(engine.getLastTickEvents().some((event) => event.type === 'hitsplat_spawned')).toBe(true);
    expect(engine.didLastTickDiscardWalkTarget()).toBe(true);
    expect(player(engine).position).toEqual(walking);
    expect(discardingTicks(engine, 5)).toEqual([4]);
    expect(player(engine).position).not.toEqual(walking);
  });
});
