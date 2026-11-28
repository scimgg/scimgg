import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInfernoActor } from '../../../npcs/inferno/actors';
import { describePlayerPrimaries } from '../../../render/core/replayPrimaryCues';
import { describePlayerEffects } from '../../../render/effects/playerEffectDescriptors';
import { enqueueTestPendingHit } from '../../../test/helpers/pendingHits';
import { createZukWaveEncounter } from '../../../test/helpers/zukWave';
import { createEmptyCombatSupplies } from '../../../types/encounterLoadout';
import { createEmptyStats } from '../../../types/equipmentStats';
import { createEmptyInventory } from '../../../types/inventory';
import {
  createDefaultPoisonState,
  createDefaultRunEnergy,
  createDefaultSpecialAttack,
  createDefaultStats,
  createDefaultTimers,
} from '../../../types/playerState';
import { createDefaultPrayerState, PrayerType } from '../../../types/simulation';
import type { NpcActor } from '../../actors/NpcActor';
import type { PlayerActor } from '../../actors/PlayerActor';
import { TickEvents } from '../../events/TickEvents';
import { type GameEvent, isCoreEvent } from '../../events/types';
import { recordNpcLethalTransition } from '../../npcDeath';
import { SimulationEngine } from '../../SimulationEngine';
import { WorldState } from '../../WorldState';
import {
  type AttackResolution,
  type CombatBridge,
  CombatSystem,
  type DamageAppliedInfo,
  type PrayerReduction,
} from '../CombatSystem';
import { getSpecialAttackDef } from '../player/specialAttacks/registry';
import type { SpecialAttackEffect } from '../player/specialAttacks/types';

const ELYSIAN_SPIRIT_SHIELD = 12817;

function makePlayer(shield?: number): PlayerActor {
  return {
    id: 'player',
    kind: 'player',
    alive: true,
    position: [31, 25],
    previousPosition: [31, 25],
    facing: 0,
    size: 1,
    vitals: { hp: 99, maxHp: 99 },
    movementPath: [],
    isMoving: false,
    isRunning: false,
    history: new Map(),
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    prayerState: createDefaultPrayerState(),
    stats: createDefaultStats(),
    poisonState: createDefaultPoisonState(),
    specialAttack: createDefaultSpecialAttack(),
    combatTimers: createDefaultTimers(),
    inventory: createEmptyInventory(),
    combatSupplies: createEmptyCombatSupplies(),
    isRunEnabled: true,
    isSpecialAttackActive: false,
    runEnergy: createDefaultRunEnergy(),
    ctrlClickOverride: false,
    equipment: shield === undefined ? {} : { shield },
    equipmentStats: createEmptyStats(),
    pendingInputOps: [],
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    pendingItemPickup: null,
    activeEffects: [],
    quickPrayersActive: false,
    attackTarget: 'yama',
    autoAttackPause: null,
    attackInteractionActive: true,
    manualCastSpell: null,
    selectedAttackStyleIndex: 0,
    pendingConflictionAttack: null,
    xpCounters: {},
  };
}

function makeNpc(): NpcActor {
  return {
    id: 'yama',
    kind: 'npc',
    alive: true,
    position: [29, 28],
    previousPosition: [29, 28],
    facing: 0,
    size: 5,
    vitals: { hp: 1000, maxHp: 1000 },
    npcTypeId: 14176,
    archetypeId: 'yama',
    history: new Map(),
    combat: {
      attackSpeed: 4,
      attackRange: 10,
      attackStyle: 'magic',
      nextActionTick: 0,
      lastAttackTick: null,
      targetId: 'player',
      animations: { idle: null, walk: null, run: null, attack: null, death: null },
    },
  };
}

type NpcHitScenario = {
  readonly damage: number;
  readonly shield?: number;
  readonly prayer?: PrayerType;
  readonly prayerReduction?: PrayerReduction;
  readonly infiniteHealth?: boolean;
};

function resolveNpcHit(scenario: NpcHitScenario): {
  readonly player: PlayerActor;
  readonly events: readonly GameEvent[];
  readonly damageInfo: DamageAppliedInfo | null;
} {
  const player = makePlayer(scenario.shield);
  player.activePrayer = scenario.prayer ?? null;
  const npc = makeNpc();
  const world = new WorldState();
  world.actors.set(player.id, player);
  world.actors.set(npc.id, npc);
  const events = new TickEvents();
  let damageInfo: DamageAppliedInfo | null = null;
  const system = new CombatSystem();

  system.processAttackRequest(
    world,
    {
      attacker: npc,
      target: player,
      attack: {
        style: 'magic',
        attackKind: 'magic_fire',
        rolledDamage: scenario.damage,
        accuracySucceeded: true,
        impactDelayTicks: 0,
        ...(scenario.prayerReduction === undefined ? {} : { prayerReduction: scenario.prayerReduction }),
      },
    },
    {
      events,
      infiniteHealth: scenario.infiniteHealth ?? false,
      onDamageApplied: (info) => {
        damageInfo = info;
      },
    },
  );

  return { player, events: events.flush(), damageInfo };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pending hit actor instances', () => {
  function fixture() {
    const world = new WorldState();
    const source = makeNpc();
    const target = makePlayer();
    world.actors.set(source.id, source);
    world.actors.set(target.id, target);
    const system = new CombatSystem({ enablePendingHits: true });
    const onDamageApplied = vi.fn<(info: DamageAppliedInfo) => void>();
    const bridge: CombatBridge = { events: new TickEvents(), onDamageApplied };
    system.processAttackRequest(
      world,
      {
        attacker: source,
        target,
        attack: {
          style: 'range',
          attackKind: 'range_arrow',
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 2,
          prayerCheckAt: { afterLaunchTicks: 1 },
        },
      },
      bridge,
    );
    bridge.events.flush();
    return { world, source, target, system, bridge, onDamageApplied };
  }

  it.each(['source', 'target'] as const)('discards damage when the %s is replaced before impact', (replaced) => {
    const { world, system, bridge, onDamageApplied } = fixture();
    const replacement = replaced === 'source' ? makeNpc() : makePlayer();
    world.actors.delete(replacement.id);
    world.actors.set(replacement.id, replacement);
    const target = world.getPlayer();
    if (!target) throw new TypeError('Missing player fixture');

    world.tick = 2;
    system.processPendingHits(world, bridge);

    expect(target.vitals.hp).toBe(99);
    expect(onDamageApplied).not.toHaveBeenCalled();
    expect(bridge.events.flush()).toEqual([]);
    expect(world.pendingHits).toEqual([]);
  });

  it.each([
    'source',
    'target',
  ] as const)('discards a replaced %s hit before sampling its delayed prayer', (replaced) => {
    const { world, system, bridge } = fixture();
    const [pendingHit] = world.pendingHits;
    const replacement = replaced === 'source' ? makeNpc() : makePlayer();
    world.actors.set(replacement.id, replacement);
    const target = world.getPlayer();
    if (!target) throw new TypeError('Missing player fixture');
    target.activePrayer = PrayerType.ProtectRange;

    world.tick = 1;
    system.processPendingHits(world, bridge);

    expect(pendingHit?.judgedProtectionPrayer).toBeNull();
    expect(world.pendingHits).toEqual([]);
  });

  it('applies the queued damage when both launch-time instances remain present', () => {
    const { world, target, system, bridge, onDamageApplied } = fixture();

    world.tick = 2;
    system.processPendingHits(world, bridge);

    expect(target.vitals.hp).toBe(89);
    expect(onDamageApplied).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ effectiveDamage: 10 }));
    expect(bridge.events.flush().filter((event) => event.type === 'hit_applied')).toEqual([
      expect.objectContaining({ targetId: target.id, damage: 10 }),
    ]);
    expect(world.pendingHits).toEqual([]);
  });

  it('leaves a hit owned by the other pass unsampled, then unresolved', () => {
    const { world, target, system, bridge, onDamageApplied } = fixture();
    const [pendingHit] = world.pendingHits;
    target.activePrayer = PrayerType.ProtectRange;

    // Tick 1 is this hit's prayer check tick, tick 2 its impact.
    world.tick = 1;
    system.processPendingHits(world, bridge, 'npc');

    expect(pendingHit?.judgedProtectionPrayer).toBeNull();

    system.processPendingHits(world, bridge, 'player');

    expect(pendingHit?.judgedProtectionPrayer).toBe(PrayerType.ProtectRange);

    world.tick = 2;
    system.processPendingHits(world, bridge, 'npc');

    expect(onDamageApplied).not.toHaveBeenCalled();
    expect(world.pendingHits).toEqual([pendingHit]);

    system.processPendingHits(world, bridge, 'player');

    expect(onDamageApplied).toHaveBeenCalledOnce();
    expect(world.pendingHits).toEqual([]);
  });
});

describe('pending hit queue order', () => {
  type HitDraft = Parameters<typeof enqueueTestPendingHit>[2];

  function fixture() {
    const world = new WorldState();
    const victim = makeNpc();
    const otherNpc: NpcActor = { ...makeNpc(), id: 'other-npc', size: 1, vitals: { hp: 50, maxHp: 50 } };
    const player = makePlayer();
    for (const actor of [victim, otherNpc, player]) world.actors.set(actor.id, actor);
    const system = new CombatSystem();
    const landed: string[] = [];
    const bridge: CombatBridge = {
      events: new TickEvents(),
      onDamageApplied: (info) => landed.push(`${info.sourceId}>${info.targetId}:${info.baseDamage}`),
    };
    const queue = (overrides: Partial<HitDraft> & Pick<HitDraft, 'sourceId' | 'rolledDamage'>) =>
      enqueueTestPendingHit(world, system, {
        targetId: victim.id,
        style: 'magic',
        attackKind: 'magic_fire',
        launchTick: 0,
        impactTick: 2,
        accuracySucceeded: true,
        ...overrides,
      });
    return { world, victim, otherNpc, player, system, bridge, landed, queue };
  }

  it('applies a victim’s due hits in enqueue order across sources, whatever their launch or impact tick', () => {
    const { world, otherNpc, player, system, bridge, landed, queue } = fixture();
    // Launched later and due earlier than the hits queued after it: neither outranks queue order.
    queue({ sourceId: otherNpc.id, rolledDamage: 5, launchTick: 1, impactTick: 2 });
    queue({ sourceId: player.id, rolledDamage: 7, launchTick: 0, impactTick: 1 });
    queue({ sourceId: otherNpc.id, rolledDamage: 3, launchTick: 0, impactTick: 2 });

    world.tick = 2;
    system.processPendingHits(world, bridge, 'npc');

    expect(landed).toEqual(['other-npc>yama:5', 'player>yama:7', 'other-npc>yama:3']);
    expect(world.pendingHits).toEqual([]);
  });

  it('allocates world-owned, never-reused sequence numbers', () => {
    const { world, player, queue } = fixture();
    const first = queue({ sourceId: player.id, rolledDamage: 1 });
    world.removePendingHitsBySource(player.id);
    const second = queue({ sourceId: player.id, rolledDamage: 1 });
    // A second system enqueuing into the same world continues the world's sequence.
    const third = enqueueTestPendingHit(world, new CombatSystem(), {
      sourceId: player.id,
      targetId: 'yama',
      style: 'magic',
      attackKind: 'magic_fire',
      launchTick: 0,
      impactTick: 2,
      rolledDamage: 1,
      accuracySucceeded: true,
    });

    expect([first, second, third].map((hit) => hit.enqueueSequence)).toEqual([0, 1, 2]);
    expect(world.nextHitSequence).toBe(3);
  });

  it('keeps future entries queued, in order and untouched, while due ones land', () => {
    const { world, player, otherNpc, system, bridge, landed, queue } = fixture();
    const later = queue({ sourceId: player.id, rolledDamage: 9, impactTick: 4 });
    queue({ sourceId: otherNpc.id, rolledDamage: 2, impactTick: 2 });
    const latest = queue({ sourceId: otherNpc.id, rolledDamage: 4, impactTick: 3 });

    world.tick = 2;
    system.processPendingHits(world, bridge, 'npc');

    expect(landed).toEqual(['other-npc>yama:2']);
    expect(world.pendingHits).toEqual([later, latest]);
  });

  it('services a due hit queued for the same victim by a callback, and keeps a future one', () => {
    const { world, player, otherNpc, system, bridge, landed, queue } = fixture();
    let inserted = false;
    const onDamageApplied = bridge.onDamageApplied;
    bridge.onDamageApplied = (info) => {
      onDamageApplied?.(info);
      if (inserted) return;
      inserted = true;
      queue({ sourceId: player.id, rolledDamage: 6, launchTick: 2, impactTick: 2 });
      queue({ sourceId: player.id, rolledDamage: 8, launchTick: 2, impactTick: 5 });
    };
    queue({ sourceId: otherNpc.id, rolledDamage: 1 });
    queue({ sourceId: otherNpc.id, rolledDamage: 2 });

    world.tick = 2;
    system.processPendingHits(world, bridge, 'npc');

    expect(landed).toEqual(['other-npc>yama:1', 'other-npc>yama:2', 'player>yama:6']);
    expect(world.pendingHits).toMatchObject([{ rolledDamage: 8, enqueueSequence: 3 }]);
  });

  it('honors a callback that discards queued entries instead of restoring them from a snapshot', () => {
    const { world, player, otherNpc, system, bridge, landed, queue } = fixture();
    const onDamageApplied = bridge.onDamageApplied;
    bridge.onDamageApplied = (info) => {
      onDamageApplied?.(info);
      world.removePendingHitsBySource(otherNpc.id);
    };
    queue({ sourceId: player.id, rolledDamage: 1 });
    queue({ sourceId: otherNpc.id, rolledDamage: 2 });
    queue({ sourceId: otherNpc.id, rolledDamage: 3, impactTick: 4 });

    world.tick = 2;
    system.processPendingHits(world, bridge, 'npc');

    expect(landed).toEqual(['player>yama:1']);
    expect(world.pendingHits).toEqual([]);
  });

  it('stops a replaced target’s drain without losing a callback-queued hit for its same-id successor', () => {
    const { world, victim, player, system, bridge, landed, queue } = fixture();
    const successor: NpcActor = {
      ...makeNpc(),
      id: victim.id,
      vitals: { hp: 1000, maxHp: 1000 },
    };
    queue({ sourceId: player.id, rolledDamage: 5 });
    const oldHit = queue({ sourceId: player.id, rolledDamage: 11 });
    const onDamageApplied = bridge.onDamageApplied;
    bridge.onDamageApplied = (info) => {
      onDamageApplied?.(info);
      if (world.getNpc(victim.id) !== victim) return;
      world.actors.delete(victim.id);
      world.registerNpc(successor);
      queue({ sourceId: player.id, rolledDamage: 7, launchTick: 2, impactTick: 2 });
    };
    world.tick = 2;

    system.processPendingHitsForTarget(world, bridge, victim);

    expect(landed).toEqual(['player>yama:5']);
    expect(victim.vitals.hp).toBe(995);
    expect(successor.vitals.hp).toBe(1000);
    expect(world.pendingHits).toMatchObject([
      { enqueueSequence: oldHit.enqueueSequence, rolledDamage: 11 },
      { enqueueSequence: oldHit.enqueueSequence + 1, rolledDamage: 7 },
    ]);
    // Re-entering the obsolete drain must not service even the new entry sharing its target id.
    system.processPendingHitsForTarget(world, bridge, victim);
    expect(landed).toEqual(['player>yama:5']);
    expect(world.pendingHits).toHaveLength(2);

    system.processPendingHitsForTarget(world, bridge, successor);

    expect(landed).toEqual(['player>yama:5', 'player>yama:7']);
    expect(successor.vitals.hp).toBe(993);
    expect(victim.vitals.hp).toBe(995);
    expect(world.pendingHits).toEqual([]);
    expect(
      bridge.events
        .flush()
        .filter((event) => isCoreEvent(event, 'hit_applied'))
        .map((event) => event.damage),
    ).toEqual([5, 7]);
  });

  it('drains one target at a time, leaving other victims’ hits for their own drain', () => {
    const { world, victim, otherNpc, player, system, bridge, landed, queue } = fixture();
    queue({ sourceId: player.id, targetId: otherNpc.id, rolledDamage: 4 });
    queue({ sourceId: otherNpc.id, rolledDamage: 5 });

    world.tick = 2;
    system.processPendingHitsForTarget(world, bridge, victim);

    expect(landed).toEqual(['other-npc>yama:5']);
    expect(world.pendingHits).toMatchObject([{ targetId: otherNpc.id, rolledDamage: 4 }]);

    system.processPendingHitsForTarget(world, bridge, otherNpc);

    expect(landed).toEqual(['other-npc>yama:5', 'player>other-npc:4']);
    expect(world.pendingHits).toEqual([]);
  });

  it.each([
    'source',
    'target',
  ] as const)('lands only the new instance’s hits when a %s id is reused by another actor', (reused) => {
    const { world, victim, otherNpc, system, bridge, landed, queue } = fixture();
    queue({ sourceId: otherNpc.id, rolledDamage: 5 });
    const replacement: NpcActor =
      reused === 'source'
        ? { ...makeNpc(), id: otherNpc.id, size: 1 }
        : { ...makeNpc(), vitals: { hp: victim.vitals.hp, maxHp: victim.vitals.maxHp } };
    world.actors.set(replacement.id, replacement);
    queue({ sourceId: otherNpc.id, rolledDamage: 7 });

    world.tick = 2;
    system.processPendingHits(world, bridge, 'npc');

    expect(landed).toEqual(['other-npc>yama:7']);
    expect(victim.vitals.hp).toBe(reused === 'target' ? 1000 : 993);
    expect(world.pendingHits).toEqual([]);
  });

  describe('source death policy', () => {
    /** An NPC-sourced hit on the player, launched by `otherNpc` (a projectile or a melee swing). */
    function npcHitOnPlayer(sourceDeathPolicy: 'persist' | 'cancel-before-impact') {
      const scenario = fixture();
      const { otherNpc, player, queue } = scenario;
      otherNpc.npcTypeId = 7692;
      queue({ sourceId: otherNpc.id, targetId: player.id, rolledDamage: 9, impactTick: 2, sourceDeathPolicy });
      return scenario;
    }

    it.each([
      'killed',
      'pruned',
      'replaced by a new actor with its id',
    ] as const)('lands a released projectile after its source is %s, still attributed to the launcher (Inferno 1-68: 1312→1313)', (fate) => {
      const { world, otherNpc, player, system, bridge, landed } = npcHitOnPlayer('persist');
      const infos: DamageAppliedInfo[] = [];
      const onDamageApplied = bridge.onDamageApplied;
      bridge.onDamageApplied = (info) => {
        onDamageApplied?.(info);
        infos.push(info);
      };
      otherNpc.vitals.hp = 0;
      otherNpc.alive = false;
      if (fate !== 'killed') world.actors.delete(otherNpc.id);
      if (fate === 'replaced by a new actor with its id') {
        const newcomer: NpcActor = { ...makeNpc(), id: otherNpc.id, npcTypeId: 1, size: 1 };
        world.actors.set(newcomer.id, newcomer);
      }

      world.tick = 2;
      system.processPendingHits(world, bridge, 'npc');
      system.processPendingHits(world, bridge, 'player');

      expect(landed).toEqual(['other-npc>player:9']);
      expect(player.vitals.hp).toBe(90);
      expect(infos[0]?.sourceNpcTypeId).toBe(7692);
      expect(world.pendingHits).toEqual([]);
    });

    it.each([
      'killed',
      'pruned',
      'replaced by a new actor with its id',
    ] as const)('drops a cancelable hit once its source is %s (B:3356)', (fate) => {
      const { world, otherNpc, player, system, bridge, landed } = npcHitOnPlayer('cancel-before-impact');
      otherNpc.vitals.hp = 0;
      otherNpc.alive = false;
      if (fate !== 'killed') world.actors.delete(otherNpc.id);
      if (fate === 'replaced by a new actor with its id') {
        world.actors.set(otherNpc.id, { ...makeNpc(), id: otherNpc.id, size: 1 });
      }

      world.tick = 2;
      system.processPendingHits(world, bridge, 'npc');
      system.processPendingHits(world, bridge, 'player');

      expect(landed).toEqual([]);
      expect(player.vitals.hp).toBe(99);
      expect(bridge.events.flush()).toEqual([]);
      expect(world.pendingHits).toEqual([]);
    });

    it('still voids a persistent hit whose target instance was replaced', () => {
      const { world, victim, player, system, bridge, landed, queue } = fixture();
      queue({ sourceId: player.id, rolledDamage: 9, sourceDeathPolicy: 'persist' });
      world.actors.set(victim.id, { ...makeNpc() });

      world.tick = 2;
      system.processPendingHits(world, bridge, 'npc');

      expect(landed).toEqual([]);
      expect(world.pendingHits).toEqual([]);
    });
  });

  describe('zero impacts', () => {
    function hitEvents(bridge: CombatBridge) {
      return bridge.events.flush().flatMap((event) => {
        if (event.type === 'hitsplat_spawned') return [`splat ${event.amount} ${event.hitsplatType}`];
        if (event.type === 'hit_applied') return [`hit ${event.damage}${event.blocked ? ' blocked' : ''}`];
        if (event.type === 'actor_died') return [`died ${event.actorId}`];
        return [];
      });
    }

    it('renders hits after the killing blow as 0 blocks, with one death (C:1606 scythe 45,0,0)', () => {
      const { world, victim, player, system, bridge, landed, queue } = fixture();
      victim.vitals.hp = 45;
      for (const rolledDamage of [45, 12, 6]) queue({ sourceId: player.id, rolledDamage });

      world.tick = 2;
      system.processPendingHits(world, bridge, 'npc');

      expect(hitEvents(bridge)).toEqual([
        'hit 45',
        'splat 45 damage',
        'died yama',
        'hit 0 blocked',
        'splat 0 block',
        'hit 0 blocked',
        'splat 0 block',
      ]);
      expect(landed).toEqual(['player>yama:45', 'player>yama:0', 'player>yama:0']);
      expect(victim.vitals.hp).toBe(0);
    });

    it('reports a zero impact without a kill reward, a roll, or any on-hit effect', () => {
      const { world, victim, player, bridge } = fixture();
      const random = vi.fn(() => 0.5);
      const system = new CombatSystem({ random });
      const infos: DamageAppliedInfo[] = [];
      bridge.onDamageApplied = (info) => infos.push(info);
      victim.vitals.hp = 0;
      recordNpcLethalTransition(victim, 1, 'hit-queue');
      enqueueTestPendingHit(world, system, {
        sourceId: player.id,
        targetId: victim.id,
        style: 'magic',
        attackKind: 'magic_fire',
        launchTick: 0,
        impactTick: 2,
        rolledDamage: 12,
        accuracySucceeded: true,
        onKillEffect: { refundSpecEnergy: 10 },
        applyPoison: 6,
        postHitEffects: [
          { effect: 'freeze', durationTicks: 32 },
          { effect: 'burn', pulses: 10, severity: 'normal' },
          { effect: 'heal_hp', percentOfDamage: 25, minimumHeal: 5 },
        ],
        sourceSelfDamageRatio: { numerator: 1, denominator: 10 },
      });

      world.tick = 2;
      system.processPendingHits(world, bridge, 'npc');

      expect(infos).toEqual([expect.objectContaining({ effectiveDamage: 0, hpBefore: 0, hpAfter: 0 })]);
      expect(infos[0]?.onKillEffect).toBeUndefined();
      expect(infos[0]?.applyPoison).toBeUndefined();
      expect(random).not.toHaveBeenCalled();
      expect(victim.debuffs?.boundUntilTick).toBeUndefined();
      expect(victim.burnStacks ?? []).toEqual([]);
      expect(player.vitals.hp).toBe(99);
      expect(hitEvents(bridge)).toEqual(['hit 0 blocked', 'splat 0 block']);
    });

    it('still discards a hit on an NPC taken out of life at nonzero HP, and on a dead player', () => {
      const { world, victim, otherNpc, player, system, bridge, landed, queue } = fixture();
      victim.alive = false;
      queue({ sourceId: player.id, rolledDamage: 5 });
      player.vitals.hp = 0;
      player.alive = false;
      queue({ sourceId: otherNpc.id, targetId: player.id, rolledDamage: 5, sourceDeathPolicy: 'persist' });

      world.tick = 2;
      system.processPendingHits(world, bridge);

      expect(landed).toEqual([]);
      expect(hitEvents(bridge)).toEqual([]);
    });
  });

  it('keeps an accepted batch going after an earlier component kills its target', () => {
    const { world, victim, player, system, bridge, landed } = fixture();
    victim.vitals.hp = 4;
    const component = (rolledDamage: number) => ({
      attacker: player,
      target: victim,
      attack: {
        style: 'magic' as const,
        attackKind: 'magic_fire' as const,
        rolledDamage,
        accuracySucceeded: true,
        impactDelayTicks: 0,
      },
    });

    expect(system.processAttackRequest(world, component(4), bridge)).toBe(true);
    expect(system.processSupplementalHitRequest(world, component(7), bridge)).toBe(true);
    // A fresh attack on the corpse is still refused.
    expect(system.processAttackRequest(world, component(7), bridge)).toBe(false);

    expect(landed).toEqual(['player>yama:4', 'player>yama:0']);
    expect(bridge.events.flush().flatMap((event) => (event.type === 'actor_died' ? [event.actorId] : []))).toEqual([
      'yama',
    ]);
  });

  it('refuses a released hit on a dead player', () => {
    const { world, otherNpc, player, system, bridge, landed } = fixture();
    player.vitals.hp = 0;
    player.alive = false;

    expect(
      system.processSupplementalHitRequest(
        world,
        {
          attacker: otherNpc,
          target: player,
          attack: {
            style: 'magic',
            attackKind: 'magic_fire',
            rolledDamage: 5,
            accuracySucceeded: true,
            impactDelayTicks: 0,
          },
        },
        bridge,
      ),
    ).toBe(false);
    expect(landed).toEqual([]);
  });

  it('rejects an entry that bypassed the central enqueue rather than guessing its identity', () => {
    const { world, player, system, bridge } = fixture();
    world.pendingHits.push({
      enqueueSequence: 99,
      sourceDeathPolicy: 'persist',
      sourceId: player.id,
      targetId: 'yama',
      style: 'magic',
      attackKind: 'magic_fire',
      launchTick: 0,
      impactTick: 2,
      rolledDamage: 1,
      accuracySucceeded: true,
    });

    expect(() => system.processPendingHits(world, bridge, 'npc')).toThrow(/not queued through/);
  });
});

describe('calculation-time NPC hitpoints cap', () => {
  function fixture(overrides: Partial<AttackResolution> = {}) {
    const player = makePlayer();
    player.vitals.hp = 10;
    const npc = makeNpc();
    const world = new WorldState();
    world.actors.set(player.id, player);
    world.actors.set(npc.id, npc);
    const events = new TickEvents();
    const damage = vi.fn<(info: DamageAppliedInfo) => void>();
    const random = vi.fn(() => 0.9);
    const system = new CombatSystem({ enablePendingHits: true, random });
    const bridge: CombatBridge = { events, onDamageApplied: damage };
    const attack: AttackResolution = {
      style: 'range',
      attackKind: 'range_arrow',
      rolledDamage: 50,
      accuracySucceeded: true,
      impactDelayTicks: 2,
      ...overrides,
    };
    return { player, npc, world, events, damage, random, system, bridge, attack };
  }

  it.each([
    'melee',
    'range',
    'magic',
    'typeless',
  ] as const)('survives healing after a delayed %s calculation', (style) => {
    const { player, npc, world, events, damage, system, bridge, attack } = fixture({ style });
    system.processAttackRequest(world, { attacker: npc, target: player, attack }, bridge);
    expect(world.pendingHits[0]).toMatchObject({ rolledDamage: 50, damageCapAtCalculation: 10 });
    player.vitals.hp += 20;
    world.tick = 2;

    system.processPendingHits(world, bridge);

    expect(player.vitals.hp).toBe(20);
    expect(player.alive).toBe(true);
    expect(damage).toHaveBeenCalledWith(expect.objectContaining({ baseDamage: 50, effectiveDamage: 10, hpAfter: 20 }));
    expect(events.flush()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'hit_applied', damage: 10 }),
        expect.objectContaining({ type: 'hitsplat_spawned', amount: 10 }),
      ]),
    );
  });

  it('remains lethal without healing after calculation', () => {
    const { player, npc, world, events, system, bridge, attack } = fixture();
    system.processAttackRequest(world, { attacker: npc, target: player, attack }, bridge);
    world.tick = 2;

    system.processPendingHits(world, bridge);

    expect(player.vitals.hp).toBe(0);
    expect(player.alive).toBe(false);
    expect(events.flush().filter((event) => event.type === 'actor_died')).toHaveLength(1);
  });

  it('includes healing done before calculation in the cap', () => {
    const { player, npc, world, system, bridge, attack } = fixture();
    player.vitals.hp += 20;

    system.processAttackRequest(world, { attacker: npc, target: player, attack }, bridge);
    world.tick = 2;
    system.processPendingHits(world, bridge);

    expect(player.vitals.hp).toBe(0);
    expect(player.alive).toBe(false);
  });

  it('caps immediate melee but offers no intervening healing window', () => {
    const { player, npc, world, damage, system, bridge, attack } = fixture({ style: 'melee', impactDelayTicks: 0 });
    player.vitals.hp += 20;

    system.processAttack(world, npc, player, { ...bridge, resolveAttack: () => attack });

    expect(damage).toHaveBeenCalledWith(expect.objectContaining({ baseDamage: 50, effectiveDamage: 30 }));
    expect(player.alive).toBe(false);
    expect(world.pendingHits).toHaveLength(0);
  });

  it('does not grant invulnerability against multiple committed hits', () => {
    const { player, npc, world, events, system, bridge, attack } = fixture();
    for (let hit = 0; hit < 3; hit++)
      system.processAttackRequest(world, { attacker: npc, target: player, attack }, bridge);
    player.vitals.hp += 5;
    world.tick = 2;

    system.processPendingHits(world, bridge);

    expect(player.alive).toBe(false);
    expect(events.flush().filter((event) => event.type === 'hit_applied')).toHaveLength(2);
  });

  it.each([
    { hp: 7, raw: 100, expected: 5, delay: 0 },
    { hp: 7, raw: 120, expected: 6, delay: 0 },
    { hp: 1, raw: 100, expected: 1, delay: 0 },
    { hp: 7, raw: 100, expected: 5, delay: 2 },
    { hp: 7, raw: 120, expected: 6, delay: 2 },
    { hp: 1, raw: 100, expected: 1, delay: 2 },
  ])('applies prayer before the saved HP ceiling: $hp HP, $raw raw, delay $delay', ({ hp, raw, expected, delay }) => {
    const { player, npc, world, damage, system, bridge, attack } = fixture({
      rolledDamage: raw,
      impactDelayTicks: delay,
      prayerReduction: { type: 'reduce', value: 0.05 },
    });
    player.vitals.hp = hp;
    player.activePrayer = PrayerType.ProtectRange;

    system.processAttackRequest(world, { attacker: npc, target: player, attack }, bridge);
    world.tick = delay;
    system.processPendingHits(world, bridge);

    expect(damage).toHaveBeenCalledWith(expect.objectContaining({ baseDamage: raw, effectiveDamage: expected }));
    expect(player.vitals.hp).toBe(hp - expected);
    expect(player.alive).toBe(hp > expected);
  });

  it.each([
    { equipAtImpact: true, expectedDamage: 5, expectedDraws: 2 },
    { equipAtImpact: false, expectedDamage: 7, expectedDraws: 1 },
  ])('applies Elysian after the saved ceiling with impact equipment $equipAtImpact', ({
    equipAtImpact,
    expectedDamage,
    expectedDraws,
  }) => {
    const { player, npc, world, damage, random, system, bridge, attack } = fixture({
      rolledDamage: [100, 120],
      prayerReduction: { type: 'reduce', value: 0.5 },
    });
    player.vitals.hp = 7;
    player.activePrayer = PrayerType.ProtectRange;
    if (!equipAtImpact) player.equipment.shield = ELYSIAN_SPIRIT_SHIELD;
    random.mockReturnValueOnce(0).mockReturnValueOnce(0);

    system.processAttackRequest(world, { attacker: npc, target: player, attack }, bridge);
    expect(random).toHaveBeenCalledTimes(1);
    expect(world.pendingHits[0]).toMatchObject({ rolledDamage: 100, damageCapAtCalculation: 7 });
    player.vitals.hp += 20;
    if (equipAtImpact) player.equipment.shield = ELYSIAN_SPIRIT_SHIELD;
    else delete player.equipment.shield;
    world.tick = 2;
    system.processPendingHits(world, bridge);

    expect(random).toHaveBeenCalledTimes(expectedDraws);
    expect(damage).toHaveBeenCalledWith(expect.objectContaining({ baseDamage: 100, effectiveDamage: expectedDamage }));
    expect(player.vitals.hp).toBe(27 - expectedDamage);
  });

  it.each([
    0, 2,
  ])('applies boosted/scaled roll, prayer, saved ceiling, then Elysian for delay %s', (impactDelayTicks) => {
    const { player, npc, world, damage, bridge, attack } = fixture({
      rolledDamage: 8,
      damageBonusPercent: 100,
      impactDelayTicks,
      prayerReduction: { type: 'reduce', value: 0.5 },
    });
    player.vitals.hp = 12;
    player.equipment.shield = ELYSIAN_SPIRIT_SHIELD;
    player.activePrayer = PrayerType.ProtectRange;
    const mitigationSystem = new CombatSystem({ enablePendingHits: true, random: () => 0 });

    mitigationSystem.processAttackRequest(
      world,
      { attacker: npc, target: player, attack },
      { ...bridge, incomingDamageMultiplier: 2 },
    );
    world.tick = impactDelayTicks;
    mitigationSystem.processPendingHits(world, { ...bridge, incomingDamageMultiplier: 10 });

    expect(damage).toHaveBeenCalledWith(expect.objectContaining({ baseDamage: 32, effectiveDamage: 9 }));
    expect(player.vitals.hp).toBe(3);
  });

  it.each([
    { accuracySucceeded: true, sample: 0 },
    { accuracySucceeded: false, sample: 0.9 },
  ])('preserves zero/misses and one damage draw when accuracy is $accuracySucceeded', ({
    accuracySucceeded,
    sample,
  }) => {
    const { player, npc, world, random, system, bridge, attack } = fixture({
      rolledDamage: [0, 50],
      accuracySucceeded,
      damageBonusPercent: 100,
    });
    random.mockReturnValue(sample);

    system.processAttackRequest(world, { attacker: npc, target: player, attack }, bridge);
    world.tick = 2;
    system.processPendingHits(world, bridge);

    expect(player.vitals.hp).toBe(10);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it.each([
    'player',
    'npc',
  ] as const)('leaves %s attacks against NPCs uncapped at calculation, dealing at most the HP left on impact', (sourceKind) => {
    const { player, npc, world, damage, system, bridge, attack } = fixture();
    npc.vitals.hp = 10;
    const source = sourceKind === 'player' ? player : { ...makeNpc(), id: 'other-npc' };
    world.actors.set(source.id, source);
    system.processAttackRequest(world, { attacker: source, target: npc, attack }, bridge);
    expect(world.pendingHits[0]?.damageCapAtCalculation).toBeUndefined();
    npc.vitals.hp += 20;
    world.tick = 2;

    system.processPendingHits(world, bridge);

    // Healing in flight raised the ceiling to 30; the splat shows what the NPC actually lost.
    expect(damage).toHaveBeenCalledWith(expect.objectContaining({ baseDamage: 50, effectiveDamage: 30 }));
    expect(npc.alive).toBe(false);
  });
});

describe('Elysian spirit shield combat mitigation', () => {
  it('reduces positive NPC damage, HP loss, callback damage, and events on a roll below 0.70', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.699_999);

    const result = resolveNpcHit({ damage: 8, shield: ELYSIAN_SPIRIT_SHIELD });

    expect(result.player.vitals.hp).toBe(93);
    expect(result.damageInfo?.effectiveDamage).toBe(6);
    expect(result.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'hit_applied', damage: 6 }),
        expect.objectContaining({ type: 'hitsplat_spawned', amount: 6 }),
      ]),
    );
  });

  it('does not proc when the roll is exactly 0.70', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.7);

    const result = resolveNpcHit({ damage: 8, shield: ELYSIAN_SPIRIT_SHIELD });

    expect(result.player.vitals.hp).toBe(91);
    expect(result.damageInfo?.effectiveDamage).toBe(8);
  });

  it('rounds a one-damage proc down to zero', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = resolveNpcHit({ damage: 1, shield: ELYSIAN_SPIRIT_SHIELD });

    expect(result.player.vitals.hp).toBe(99);
    expect(result.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'hit_applied', damage: 0 })]),
    );
  });

  it('applies Elysian after protection-prayer mitigation', () => {
    // Given: prayer reduces ten damage to five before a successful Elysian roll.
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = resolveNpcHit({
      damage: 10,
      shield: ELYSIAN_SPIRIT_SHIELD,
      prayer: PrayerType.ProtectMagic,
      prayerReduction: { type: 'reduce', value: 0.5 },
    });

    // Then: Elysian floors 75% of the prayer-adjusted five damage to three.
    expect(result.damageInfo?.effectiveDamage).toBe(3);
    expect(result.player.vitals.hp).toBe(96);
  });

  it('does not roll or alter zero damage', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = resolveNpcHit({ damage: 0, shield: ELYSIAN_SPIRIT_SHIELD });

    expect(result.damageInfo?.effectiveDamage).toBe(0);
    expect(randomSpy).not.toHaveBeenCalled();
  });

  it('does not roll or alter NPC damage with another shield', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = resolveNpcHit({ damage: 8, shield: 11924 });

    expect(result.damageInfo?.effectiveDamage).toBe(8);
    expect(randomSpy).not.toHaveBeenCalled();
  });

  it('reports mitigated damage while infinite health preserves HP', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const result = resolveNpcHit({ damage: 8, shield: ELYSIAN_SPIRIT_SHIELD, infiniteHealth: true });

    expect(result.player.vitals.hp).toBe(99);
    expect(result.damageInfo?.effectiveDamage).toBe(6);
    expect(result.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'hit_applied', damage: 6 })]),
    );
  });

  it('does not roll Elysian mitigation for player attacks', () => {
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(0);
    const player = makePlayer(ELYSIAN_SPIRIT_SHIELD);
    const npc = makeNpc();
    const world = new WorldState();
    world.actors.set(player.id, player);
    world.actors.set(npc.id, npc);

    new CombatSystem().processAttackRequest(
      world,
      {
        attacker: player,
        target: npc,
        attack: {
          style: 'magic',
          attackKind: 'magic_fire',
          rolledDamage: 8,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        },
      },
      { events: new TickEvents() },
    );

    expect(npc.vitals.hp).toBe(992);
    expect(randomSpy).not.toHaveBeenCalled();
  });
});

function makeNpcActor(overrides: Partial<NpcActor> = {}): NpcActor {
  return { ...makeNpc(), ...overrides };
}

function makePlayerActor(overrides: Partial<PlayerActor> = {}): PlayerActor {
  return { ...makePlayer(), ...overrides };
}

function makeWorldState(tick: number, overrides: Partial<WorldState> = {}): WorldState {
  const world = new WorldState();
  const npc = makeNpcActor();
  const player = makePlayerActor();
  world.tick = tick;
  world.actors.set(npc.id, npc);
  world.actors.set(player.id, player);
  return Object.assign(world, overrides);
}

function makeBridge(overrides: Partial<CombatBridge> = {}): CombatBridge {
  return {
    events: new TickEvents(),
    ...overrides,
  };
}

describe('CombatSystem', () => {
  describe.each([
    { spellId: 'Ice Burst', projectileId: 366, hitSpotanim: 363 },
    { spellId: 'Ice Barrage', projectileId: 368, hitSpotanim: 369 },
    { spellId: 'Blood Burst', projectileId: -1, hitSpotanim: 376 },
    { spellId: 'Blood Barrage', projectileId: -1, hitSpotanim: 377 },
  ])('$spellId supplemental visuals', ({ spellId, projectileId, hitSpotanim }) => {
    it.each([
      { primaryAccurate: true, secondaryAccurate: true },
      { primaryAccurate: true, secondaryAccurate: false },
      { primaryAccurate: false, secondaryAccurate: true },
      { primaryAccurate: false, secondaryAccurate: false },
    ])('preserves per-target effects when primary=$primaryAccurate and secondary=$secondaryAccurate', ({
      primaryAccurate,
      secondaryAccurate,
    }) => {
      const engine = new SimulationEngine({ encounter: createZukWaveEncounter(0), combatSeed: 1 });
      const world = engine['worldState'];
      const player = world.getPlayer();
      if (!player) expect.fail('Expected player');
      player.position = [1, 2];
      const primary = createInfernoActor('mager', 'primary', [7, 2]);
      const secondary = createInfernoActor('mager', 'secondary', [8, 3]);
      world.actors.set(primary.id, primary);
      world.actors.set(secondary.id, secondary);
      const onAttackStarted = vi.fn();
      const bridge = makeBridge({ onAttackStarted });
      const system = new CombatSystem();
      const attack = {
        style: 'magic',
        attackKind: 'magic_water',
        spellId,
        rolledDamage: 5,
        impactDelayTicks: 0,
        accuracySucceeded: primaryAccurate,
      } as const;

      system.processAttackRequest(world, { attacker: player, target: primary, attack }, bridge);
      system.processSupplementalHitRequest(
        world,
        { attacker: player, target: secondary, attack: { ...attack, accuracySucceeded: secondaryAccurate } },
        bridge,
      );
      const events = bridge.events.flush();
      player.position[0] = 40;
      primary.position[0] = 45;
      secondary.position[0] = 50;
      const frame = { state: engine.getState(), events };
      const effects = describePlayerEffects(frame);

      expect([primary.vitals.hp, secondary.vitals.hp]).toEqual([
        primaryAccurate ? 215 : 220,
        secondaryAccurate ? 215 : 220,
      ]);
      expect(events.filter((event) => event.type === 'attack_started')).toHaveLength(1);
      expect(onAttackStarted).toHaveBeenCalledOnce();
      expect(describePlayerPrimaries(frame)).toEqual([{ kind: 'attack', tick: world.tick, sequenceIds: [10092] }]);
      const targets = [
        { actorId: 'primary', position: [7, 2], size: 4, accurate: primaryAccurate },
        { actorId: 'secondary', position: [8, 3], size: 4, accurate: secondaryAccurate },
      ];
      // A target the spell missed shows the splash (85) where its impact would be.
      expect(effects).toMatchObject(
        targets.map(({ accurate, ...target }) =>
          projectileId >= 0
            ? {
                kind: 'projectile',
                source: [1, 2],
                target,
                visuals: { projectileId, hitSpotanim: accurate ? hitSpotanim : 85 },
              }
            : { kind: 'impact', target, spotAnimId: accurate ? hitSpotanim : 85 },
        ),
      );
    });
  });

  describe('processAttackRequest', () => {
    it('delivers an encounter-approved request while the attacker has a private cooldown', () => {
      // Given: a normal attack has scheduled the NPC's next attack for tick 14.
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama');
      const target = world.getPlayer();
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      const bridge = makeBridge({
        resolveAttack: () => ({ rolledDamage: 1, accuracySucceeded: true, impactDelayTicks: 0 }),
      });
      system.processAttack(world, attacker, target, bridge);
      bridge.events.flush();
      expect(system.getNextAttackTick(attacker.id)).toBe(14);

      world.tick = 11;
      system.processAttackRequest(
        world,
        {
          attacker,
          target,
          attack: {
            style: 'range',
            attackKind: 'range_arrow',
            rolledDamage: 7,
            accuracySucceeded: true,
            impactDelayTicks: 0,
          },
        },
        bridge,
      );

      // Then: the shared hit pipeline delivers it without consulting or changing the cooldown.
      expect(bridge.events.flush()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'attack_started', sourceId: attacker.id, style: 'range' }),
          expect.objectContaining({ type: 'hit_applied', targetId: target.id, damage: 7 }),
        ]),
      );
      expect(system.getNextAttackTick(attacker.id)).toBe(14);
    });

    it('rejects a prevalidated request when either actor is dead', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama');
      const target = world.getPlayer();
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      target.alive = false;
      const bridge = makeBridge();

      system.processAttackRequest(
        world,
        {
          attacker,
          target,
          attack: {
            style: 'magic',
            attackKind: 'magic_fire',
            rolledDamage: 7,
            accuracySucceeded: true,
            impactDelayTicks: 0,
          },
        },
        bridge,
      );

      expect(bridge.events.flush()).toEqual([]);
    });

    it('uses the existing pending-hit and damage pipeline for delayed requests', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama');
      const target = world.getPlayer();
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      const bridge = makeBridge({ enablePendingHits: true });

      system.processAttackRequest(
        world,
        {
          attacker,
          target,
          attack: {
            style: 'magic',
            attackKind: 'magic_fire',
            rolledDamage: 6,
            accuracySucceeded: true,
            impactDelayTicks: 2,
          },
        },
        bridge,
      );
      const launchEvents = bridge.events.flush();
      world.tick = 12;
      system.processPendingHits(world, bridge);

      expect(launchEvents).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'attack_started' })]));
      expect(world.pendingHits).toEqual([]);
      expect(bridge.events.flush()).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'hit_applied', damage: 6 })]),
      );
    });

    it.each(
      (
        [
          { method: 'processAttackRequest', eventType: 'attack_started' },
          { method: 'processSupplementalHitRequest', eventType: 'spell_targeted' },
        ] as const
      ).flatMap((request) => [true, false].map((accurate) => ({ ...request, accurate }))),
    )('snapshots $eventType geometry and accuracy $accurate before actors move', ({ method, eventType, accurate }) => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.getPlayer();
      const target = world.getNpc('yama');
      if (!attacker || !target) expect.fail('Expected combat fixtures');
      attacker.position = [3101, 3509];
      target.position = [3101, 3507];
      const bridge = makeBridge({ enablePendingHits: true });

      system[method](
        world,
        {
          attacker,
          target,
          attack: {
            style: 'magic',
            attackKind: 'magic_shadow',
            rolledDamage: 6,
            accuracySucceeded: accurate,
            impactDelayTicks: 3,
            spellId: 'Blood Barrage',
          },
        },
        bridge,
      );
      attacker.position[0] = 4000;
      target.position[1] = 4000;

      expect(bridge.events.flush()).toContainEqual(
        expect.objectContaining({
          type: eventType,
          spellCast: { sourcePosition: [3101, 3509], targetPosition: [3101, 3507], targetSize: target.size, accurate },
        }),
      );
    });

    it('queues a supplemental hit without another launch event or cooldown', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama');
      const target = world.getPlayer();
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      const onDamageApplied = vi.fn();
      const bridge = makeBridge({ enablePendingHits: true, onDamageApplied });

      system.processSupplementalHitRequest(
        world,
        {
          attacker,
          target,
          attack: {
            style: 'magic',
            attackKind: 'magic_shadow',
            rolledDamage: 6,
            accuracySucceeded: true,
            impactDelayTicks: 2,
            spellId: 'Ice Barrage',
          },
        },
        bridge,
      );

      expect(bridge.events.flush()).toEqual([]);
      expect(world.pendingHits).toHaveLength(1);
      expect(system.getNextAttackTick(attacker.id)).toBeUndefined();

      world.tick = 12;
      system.processPendingHits(world, bridge);
      expect(onDamageApplied).toHaveBeenCalledWith(expect.objectContaining({ targetId: target.id, baseDamage: 6 }));
    });

    it('applies an immediate supplemental hit silently on the launch tick', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama');
      const target = world.getPlayer();
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      const onDamageApplied = vi.fn();
      const onAttackStarted = vi.fn();
      const bridge = makeBridge({ enablePendingHits: true, onDamageApplied, onAttackStarted });

      system.processSupplementalHitRequest(
        world,
        {
          attacker,
          target,
          attack: {
            style: 'magic',
            attackKind: 'magic_shadow',
            rolledDamage: 6,
            accuracySucceeded: true,
            impactDelayTicks: 0,
            spellId: 'Ice Barrage',
          },
        },
        bridge,
      );

      expect(world.pendingHits).toEqual([]);
      expect(onDamageApplied).toHaveBeenCalledWith(expect.objectContaining({ tick: 10, targetId: target.id }));
      expect(onAttackStarted).not.toHaveBeenCalled();
      expect(bridge.events.flush().some((event) => event.type === 'attack_started')).toBe(false);
      expect(system.getNextAttackTick(attacker.id)).toBeUndefined();
    });

    it('judges a delayed hit against the prayer that was up when it launched', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama');
      const target = world.getPlayer();
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      const bridge = makeBridge({ enablePendingHits: true });
      target.activePrayer = PrayerType.ProtectMagic;

      system.processAttackRequest(
        world,
        {
          attacker,
          target,
          attack: {
            style: 'magic',
            attackKind: 'magic_fire',
            rolledDamage: 30,
            accuracySucceeded: true,
            impactDelayTicks: 3,
          },
        },
        bridge,
      );
      bridge.events.flush();
      const hpAfterLaunch = target.vitals.hp;

      target.activePrayer = PrayerType.ProtectRange;
      world.tick = 13;
      system.processPendingHits(world, bridge);

      // Then: the hit is still blocked. OSRS decides prayer at the attack tick, so a
      // switch made after the animation cannot retroactively expose the player — that
      // is the whole basis of prayer flicking.
      expect(target.vitals.hp).toBe(hpAfterLaunch);
      expect(bridge.events.flush()).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'hit_applied', damage: 0, blocked: true })]),
      );
    });

    it('honors an explicit impact-time prayer check for late-resolving mechanics', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama');
      const target = world.getPlayer();
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      const bridge = makeBridge({ enablePendingHits: true });
      target.activePrayer = PrayerType.ProtectMagic;

      system.processAttackRequest(
        world,
        {
          attacker,
          target,
          attack: {
            style: 'magic',
            attackKind: 'magic_fire',
            rolledDamage: 30,
            accuracySucceeded: true,
            impactDelayTicks: 3,
            prayerCheckAt: 'impact',
          },
        },
        bridge,
      );
      bridge.events.flush();

      target.activePrayer = PrayerType.ProtectRange;
      world.tick = 13;
      system.processPendingHits(world, bridge);

      expect(bridge.events.flush()).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'hit_applied', damage: 30 })]),
      );
    });
  });

  // An accurate roll is floored to 1 BEFORE `outgoingDamageMultiplier` runs, so a damping
  // encounter turns a landed hit into a 0-damage one. Shadow and Ice key off the hit CONNECTING
  // and must survive that; Smoke needs real damage and must not.
  it('keeps accuracy-gated spell effects on an accurate hit damped to zero damage', () => {
    const landEffects = (effects: SpecialAttackEffect[], accuracySucceeded: boolean) => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.getPlayer();
      const target = world.actors.get('yama') as NpcActor | undefined;
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      // A percentage drain needs a real level underneath it: the bare fixture falls back to attack 1,
      // where 15% floors to a 0 that reads exactly like the effect never running.
      target.formulaStats = {
        levels: { attack: 100, strength: 100, defence: 100, ranged: 100, magic: 100 },
        offensive: { atk: 100, str: 100, ranged: 100, rangedStr: 100, magic: 100, magicStr: 100 },
        defensive: { stab: 80, slash: 80, crush: 80, rangedLight: 80, rangedStandard: 80, rangedHeavy: 80, magic: 80 },
      };
      system.processAttackRequest(
        world,
        {
          attacker,
          target,
          attack: {
            style: 'magic',
            attackKind: 'magic_shadow',
            rolledDamage: 1,
            accuracySucceeded,
            impactDelayTicks: 0,
            postHitEffects: effects,
          },
        },
        makeBridge({ infiniteHealth: true, outgoingDamageMultiplier: 0 }),
      );
      return target.debuffs ?? {};
    };

    expect(landEffects([{ effect: 'freeze', durationTicks: 32 }], true)).toMatchObject({
      boundFromTick: 11,
      boundUntilTick: 43,
    });
    expect(landEffects([{ effect: 'drain_attack', percent: 15 }], true).attackDrain).toBe(15);

    // A miss still applies nothing, and a damage-gated effect still needs damage.
    expect(landEffects([{ effect: 'freeze', durationTicks: 32 }], false).boundUntilTick).toBeUndefined();
    expect(landEffects([{ effect: 'drain_defence', percent: 30 }], true).defenceDrain).toBeUndefined();
  });

  // /w/Dragon_warhammer: Smash lowers Defence by 30% of its CURRENT level, rounded down, and only
  // on a hit that deals damage; a miss or a 0 leaves it alone.
  it('drains Dragon warhammer Defence only on a damaging hit, compounding off the current level', () => {
    const world = makeWorldState(10);
    const attacker = world.getPlayer();
    const target = world.actors.get('yama') as NpcActor | undefined;
    if (!attacker || !target) throw new Error('Expected combat fixtures');
    target.formulaStats = {
      levels: { attack: 100, strength: 100, defence: 200, ranged: 100, magic: 100 },
      offensive: { atk: 0, str: 0, ranged: 0, rangedStr: 0, magic: 0, magicStr: 0 },
      defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
    };
    const smash = getSpecialAttackDef(13576)?.postHitEffects;
    if (smash === undefined) throw new Error('Expected the Dragon warhammer special');
    const land = (rolledDamage: number, accuracySucceeded: boolean, outgoingDamageMultiplier?: number) => {
      // A fresh system per swing: one attacker cannot attack twice on the same tick.
      new CombatSystem().processAttackRequest(
        world,
        {
          attacker,
          target,
          attack: {
            style: 'melee',
            attackKind: 'melee_crush',
            rolledDamage,
            accuracySucceeded,
            impactDelayTicks: 0,
            usingSpecialAttack: true,
            postHitEffects: smash,
          },
        },
        makeBridge(outgoingDamageMultiplier === undefined ? {} : { outgoingDamageMultiplier }),
      );
      return target.debuffs?.defenceDrain;
    };

    expect(land(25, false)).toBeUndefined();
    expect(land(25, true, 0)).toBeUndefined();
    expect(land(25, true)).toBe(60);
    expect(land(0, false)).toBe(60);
    expect(land(25, true)).toBe(60 + 42);
  });

  // capture inferno-waves-1-68-packet-data.txt t581: an Ice Burst's targets stand still from
  // t582, four ticks before its splats at t586; a splashed Burst's target walks on (t3517).
  it.each([
    { accurate: true, window: [11, 43] },
    { accurate: false, window: [undefined, undefined] },
  ])('freezes a flying spell at launch, from the next tick, when accurate ($accurate)', ({ accurate, window }) => {
    const system = new CombatSystem();
    const world = makeWorldState(10);
    const attacker = world.getPlayer();
    const target = world.actors.get('yama') as NpcActor | undefined;
    if (!attacker || !target) throw new Error('Expected combat fixtures');
    const bridge = makeBridge({ enablePendingHits: true, infiniteHealth: true });

    system.processAttackRequest(
      world,
      {
        attacker,
        target,
        attack: {
          style: 'magic',
          attackKind: 'magic_shadow',
          rolledDamage: 20,
          accuracySucceeded: accurate,
          impactDelayTicks: 3,
          spellId: 'Ice Barrage',
          postHitEffects: [{ effect: 'freeze', durationTicks: 32 }],
        },
      },
      bridge,
    );

    const frozenWindow = () => [target.debuffs?.boundFromTick, target.debuffs?.boundUntilTick];
    expect(frozenWindow()).toEqual(window);
    // The hit carries no second freeze to impact.
    expect(world.pendingHits.map((hit) => hit.postHitEffects)).toEqual([undefined]);
    world.tick = 13;
    system.processPendingHits(world, bridge);
    expect(frozenWindow()).toEqual(window);
  });

  describe('a swing that fails its accuracy roll', () => {
    const landDelayedAttack = (accuracySucceeded: boolean) => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama');
      const target = world.getPlayer();
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      const applied: DamageAppliedInfo[] = [];
      const bridge = makeBridge({ enablePendingHits: true, onDamageApplied: (info) => applied.push(info) });

      system.processAttackRequest(
        world,
        {
          attacker,
          target,
          attack: {
            style: 'melee',
            attackKind: 'melee_slash',
            rolledDamage: 30,
            accuracySucceeded,
            impactDelayTicks: 1,
            applyPoison: 30,
          },
        },
        bridge,
      );
      world.tick = 11;
      system.processPendingHits(world, bridge);
      return applied;
    };

    // Yama's melee attaches its poison varp to every swing, and his autos roll accuracy, so
    // a miss reaching `applyDamage` with the varp still attached poisons off a blue 0 splat.
    it('does not poison the target, where a landed swing does', () => {
      expect(landDelayedAttack(false).map((info) => info.applyPoison)).toEqual([undefined]);
      expect(landDelayedAttack(true).map((info) => info.applyPoison)).toEqual([30]);
    });

    // The accuracy outcome must not change how far the shared combat stream advances, or an
    // NPC missing shifts every later player roll in the fight.
    it('consumes the same damage draw a landed swing does', () => {
      const draws = (accuracySucceeded: boolean): number => {
        let count = 0;
        const system = new CombatSystem({
          random: () => {
            count += 1;
            return 0.5;
          },
        });
        const world = makeWorldState(10);
        const attacker = world.actors.get('yama');
        const target = world.getPlayer();
        if (!attacker || !target) throw new Error('Expected combat fixtures');

        system.processAttackRequest(
          world,
          {
            attacker,
            target,
            attack: {
              style: 'magic',
              attackKind: 'magic_fire',
              rolledDamage: [0, 30],
              accuracySucceeded,
              impactDelayTicks: 3,
            },
          },
          makeBridge({ enablePendingHits: true }),
        );
        return count;
      };

      expect(draws(false)).toBe(draws(true));
      expect(draws(true)).toBe(1);
    });
  });

  describe('processAttack', () => {
    it('preserves an impact-time prayer check supplied by the bridge override', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama');
      const target = world.getPlayer();
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      target.activePrayer = PrayerType.ProtectMagic;
      const bridge = makeBridge({
        enablePendingHits: true,
        resolveAttack: () => ({
          style: 'magic',
          attackKind: 'magic_fire',
          rolledDamage: 30,
          accuracySucceeded: true,
          impactDelayTicks: 3,
          prayerCheckAt: 'impact',
        }),
      });
      system.processAttack(world, attacker, target, bridge);
      bridge.events.flush();

      target.activePrayer = PrayerType.ProtectRange;
      world.tick = 13;
      system.processPendingHits(world, bridge);

      expect(bridge.events.flush()).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: 'hit_applied', damage: 30 })]),
      );
    });

    it('multiplies a delayed hit by the LAUNCH multipliers, not the impact ones', () => {
      // Encounter multipliers are `EncounterDynamic`s now — Glyphic Attenuation scales
      // outgoing damage off the player's live prayer bonus — so resolving them again at
      // impact would let gear swapped mid-flight rewrite a roll already made, and would put
      // the damage at odds with the XP drop, which is granted at launch.
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.getPlayer();
      const target = world.actors.get('yama');
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      const hpBefore = target.vitals.hp;

      const launchBridge = makeBridge({
        enablePendingHits: true,
        outgoingDamageMultiplier: 2,
        specDamageMultiplier: 3,
        resolveAttack: () => ({
          style: 'magic',
          attackKind: 'magic_fire',
          rolledDamage: 5,
          accuracySucceeded: true,
          impactDelayTicks: 3,
          usingSpecialAttack: true,
        }),
      });
      system.processAttack(world, attacker, target, launchBridge);
      launchBridge.events.flush();

      world.tick = 13;
      system.processPendingHits(world, makeBridge({ outgoingDamageMultiplier: 10, specDamageMultiplier: 10 }));

      // Then: 5 * 2 * 3, not 5 * 10 * 10.
      expect(hpBefore - target.vitals.hp).toBe(30);
    });

    it('treats a hit queued without a launch snapshot as unmultiplied', () => {
      // Hand-built pending hits (tests, and any future direct producer) must not silently
      // pick up whatever multipliers happen to be live when they land.
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.getPlayer();
      const target = world.actors.get('yama');
      if (!attacker || !target) throw new Error('Expected combat fixtures');
      const hpBefore = target.vitals.hp;
      enqueueTestPendingHit(world, system, {
        sourceId: attacker.id,
        targetId: target.id,
        style: 'magic',
        attackKind: 'magic_fire',
        launchTick: 10,
        impactTick: 11,
        rolledDamage: 7,
        accuracySucceeded: true,
      });

      world.tick = 11;
      system.processPendingHits(world, makeBridge({ outgoingDamageMultiplier: 10 }));

      expect(hpBefore - target.vitals.hp).toBe(7);
    });
  });

  describe('Critical #1: reset() clears attack timers', () => {
    it('should have a reset() method', () => {
      const system = new CombatSystem();
      expect(typeof (system as any).reset).toBe('function');
    });

    it('should allow attack immediately after reset even if timer was set', () => {
      const system = new CombatSystem({ defaultAttackSpeedTicks: 4 });
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = world.actors.get('player')!;
      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
      });

      system.processAttack(world, attacker, target, bridge);
      const eventsAfterFirst = bridge.events.flush();
      expect(eventsAfterFirst.some((e) => e.type === 'attack_started')).toBe(true);

      world.tick = 11;
      system.processAttack(world, attacker, target, bridge);
      const eventsBlocked = bridge.events.flush();
      expect(eventsBlocked.some((e) => e.type === 'attack_started')).toBe(false);

      system.reset();
      target.vitals.hp = 99;
      target.alive = true;
      system.processAttack(world, attacker, target, bridge);
      const eventsAfterReset = bridge.events.flush();
      expect(eventsAfterReset.some((e) => e.type === 'attack_started')).toBe(true);
    });

    it('should clear timers for all actors on reset', () => {
      const system = new CombatSystem({ defaultAttackSpeedTicks: 4 });

      const world = makeWorldState(10);
      const npc1 = makeNpcActor({ id: 'npc1' as any });
      const npc2 = makeNpcActor({ id: 'npc2' as any });
      const target = world.actors.get('player')!;
      world.actors.set('npc1' as any, npc1);
      world.actors.set('npc2' as any, npc2);

      const bridge = makeBridge({
        resolveAttack: () => ({
          rolledDamage: 5,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
      });

      system.processAttack(world, npc1, target, bridge);
      bridge.events.flush();
      target.vitals.hp = 99;
      target.alive = true;

      system.processAttack(world, npc2, target, bridge);
      bridge.events.flush();
      target.vitals.hp = 99;
      target.alive = true;

      world.tick = 11;
      system.processAttack(world, npc1, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(false);

      system.processAttack(world, npc2, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(false);

      system.reset();
      target.vitals.hp = 99;
      target.alive = true;

      system.processAttack(world, npc1, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(true);
    });
  });

  describe('Critical #2: calculateDamage prayer reduction', () => {
    it('does NOT apply player min-1 to NPC attacks: NPC roll 0 through prayer stays 0', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 0,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          prayerReduction: { type: 'cap' as const, value: 3 },
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const events = bridge.events.flush();

      const hitEvent = events.find((e) => e.type === 'hit_applied');
      expect(hitEvent).toBeDefined();
      // Project Rebalance min-1 is a PLAYER-only rule (OSRS Wiki "Successful hit":
      // "If the roll is from a player, then 0's are rounded up to 1's."). An NPC
      // rolling 0 is NOT boosted, so cap(3) -> min(3, 0) = 0 (fully blocked).
      expect((hitEvent as any).damage).toBe(0);
    });

    it('should reduce damage to min(3, baseDamage) when prayer is correct', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 2,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          prayerReduction: { type: 'cap' as const, value: 3 },
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const events = bridge.events.flush();

      const hitEvent = events.find((e) => e.type === 'hit_applied');
      expect(hitEvent).toBeDefined();
      expect((hitEvent as any).damage).toBe(2);
      expect(hitEvent).toMatchObject({ prayedCorrectly: true });
    });

    it('should cap damage at 3 when prayer is correct and baseDamage > 3', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          prayerReduction: { type: 'cap' as const, value: 3 },
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const events = bridge.events.flush();

      const hitEvent = events.find((e) => e.type === 'hit_applied');
      expect(hitEvent).toBeDefined();
      expect((hitEvent as any).damage).toBe(3);
    });

    it('should return 0 damage when accuracy fails (miss)', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: false,
          impactDelayTicks: 0,
          prayerReduction: { type: 'cap' as const, value: 3 },
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const events = bridge.events.flush();

      const hitEvent = events.find((e) => e.type === 'hit_applied');
      expect(hitEvent).toBeDefined();
      expect((hitEvent as any).damage).toBe(0);
    });

    it('should not reduce damage when prayer is wrong', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectRange });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          prayerReduction: { type: 'cap' as const, value: 3 },
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const events = bridge.events.flush();

      const hitEvent = events.find((e) => e.type === 'hit_applied');
      expect(hitEvent).toBeDefined();
      expect((hitEvent as any).damage).toBe(40);
      expect(hitEvent).toMatchObject({ prayedCorrectly: false });
    });
  });

  describe('C1: hit_applied.blocked should reflect effectiveDamage, not accuracySucceeded', () => {
    it('should emit blocked=true when prayer reduces damage to 0 (accuracy succeeded but fully blocked)', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      const capturedEvents: unknown[] = [];
      const originalEmit = bridge.events.emit.bind(bridge.events);
      bridge.events.emit = (event) => {
        capturedEvents.push(event);
        originalEmit(event);
      };

      system.processAttack(world, attacker, target, bridge);

      const hitEvent = capturedEvents.find(isHitAppliedEvent);
      const hitsplatEvent = capturedEvents.find(isHitsplatEvent);

      expect(hitEvent).toBeDefined();
      expect(hitsplatEvent).toBeDefined();
      if (!hitEvent || !hitsplatEvent) {
        throw new Error('Expected combat events were not emitted');
      }
      expect(hitEvent.damage).toBe(0);
      expect(hitEvent.blocked).toBe(true);
      expect(hitsplatEvent.amount).toBe(0);
      expect(hitsplatEvent.hitsplatType).toBe('block');
    });

    it('should emit blocked=false when accuracy succeeds and damage gets through', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          prayerReduction: { type: 'cap' as const, value: 3 },
        }),
        infiniteHealth: true,
      });

      const capturedEvents: unknown[] = [];
      const originalEmit = bridge.events.emit.bind(bridge.events);
      bridge.events.emit = (event) => {
        capturedEvents.push(event);
        originalEmit(event);
      };

      system.processAttack(world, attacker, target, bridge);

      const hitEvent = capturedEvents.find(isHitAppliedEvent);
      const hitsplatEvent = capturedEvents.find(isHitsplatEvent);

      expect(hitEvent).toBeDefined();
      expect(hitsplatEvent).toBeDefined();
      if (!hitEvent || !hitsplatEvent) {
        throw new Error('Expected combat events were not emitted');
      }
      expect(hitEvent.damage).toBe(3);
      expect(hitEvent.blocked).toBe(false);
      expect(hitsplatEvent.amount).toBe(3);
      expect(hitsplatEvent.hitsplatType).toBe('damage');
    });

    it('emits accurate=false when the attack roll misses', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor();
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: false,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      const capturedEvents: unknown[] = [];
      const originalEmit = bridge.events.emit.bind(bridge.events);
      bridge.events.emit = (event) => {
        capturedEvents.push(event);
        originalEmit(event);
      };

      system.processAttack(world, attacker, target, bridge);

      const hitEvent = capturedEvents.find(isHitAppliedEvent);
      expect(hitEvent).toBeDefined();
      expect(hitEvent?.damage).toBe(0);
      // `blocked` cannot tell a miss from a hit that rolled 0, and the two sound different:
      // coreAudioRules plays the splash only when `accurate` is false.
      expect(hitEvent?.blocked).toBe(true);
      expect(hitEvent?.accurate).toBe(false);
    });
  });

  type HitAppliedEvent = {
    type: 'hit_applied';
    targetId: string;
    damage: number;
    blocked: boolean;
    attackKind: string;
    accurate?: boolean;
  };

  type HitsplatEvent = {
    type: 'hitsplat_spawned';
    targetId: string;
    amount: number;
    hitsplatType: 'damage' | 'block';
  };

  const isHitAppliedEvent = (event: unknown): event is HitAppliedEvent => {
    if (!event || typeof event !== 'object') {
      return false;
    }

    const candidate = event as { type?: unknown; damage?: unknown; blocked?: unknown; attackKind?: unknown };
    return (
      candidate.type === 'hit_applied' &&
      typeof candidate.damage === 'number' &&
      typeof candidate.blocked === 'boolean' &&
      typeof candidate.attackKind === 'string'
    );
  };

  const isHitsplatEvent = (event: unknown): event is HitsplatEvent => {
    if (!event || typeof event !== 'object') {
      return false;
    }

    const candidate = event as { type?: unknown; amount?: unknown; hitsplatType?: unknown };
    return (
      candidate.type === 'hitsplat_spawned' &&
      typeof candidate.amount === 'number' &&
      (candidate.hitsplatType === 'damage' || candidate.hitsplatType === 'block')
    );
  };

  describe('bridge.getAttackSpeed controls player cooldown', () => {
    it('should use bridge.getAttackSpeed for cooldown when provided', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor();
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const bridge = makeBridge({
        getAttackSpeed: () => 5,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(true);

      world.tick = 14;
      target.vitals.hp = 1000;
      target.alive = true;
      system.processAttack(world, attacker, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(false);

      world.tick = 15;
      system.processAttack(world, attacker, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(true);
    });

    it('should not allow attack before cooldown expires even with default speed', () => {
      const system = new CombatSystem({ defaultAttackSpeedTicks: 4 });
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor();
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'melee' as const,
          attackKind: 'melee_crush' as const,
          rolledDamage: 5,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(true);

      world.tick = 13;
      system.processAttack(world, attacker, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(false);

      world.tick = 14;
      system.processAttack(world, attacker, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(true);
    });
  });

  describe('reduceNextAttackTick', () => {
    it('reduces the stored next attack tick by the given amount', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor();
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const bridge = makeBridge({
        getAttackSpeed: () => 5,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(system.getNextAttackTick('player')).toBe(15);

      system.reduceNextAttackTick('player', 3, 10);
      expect(system.getNextAttackTick('player')).toBe(12);
    });

    it('never brings the next attack earlier than the tick after the reduction', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor();
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const bridge = makeBridge({
        getAttackSpeed: () => 5,
        resolveAttack: () => ({
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(system.getNextAttackTick('player')).toBe(15);

      system.reduceNextAttackTick('player', 3, 12);
      expect(system.getNextAttackTick('player')).toBe(13);
    });

    it('keeps the full reduction when food delay pushed the cooldown out', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor();
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const bridge = makeBridge({
        getAttackSpeed: () => 5,
        resolveAttack: () => ({
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      system.extendNextAttackTickIfActive('player', 11, 3);
      expect(system.getNextAttackTick('player')).toBe(18);

      system.reduceNextAttackTick('player', 3, 12);
      expect(system.getNextAttackTick('player')).toBe(15);
    });

    it('never delays an actor whose cooldown has already elapsed', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor();
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const bridge = makeBridge({
        getAttackSpeed: () => 5,
        resolveAttack: () => ({
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(system.getNextAttackTick('player')).toBe(15);

      system.reduceNextAttackTick('player', 3, 20);
      expect(system.getNextAttackTick('player')).toBe(15);
    });

    it('leaves the cooldown alone when it ends on the reduction tick itself', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor();
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const bridge = makeBridge({
        getAttackSpeed: () => 5,
        resolveAttack: () => ({
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(system.getNextAttackTick('player')).toBe(15);

      system.reduceNextAttackTick('player', 3, 15);
      expect(system.getNextAttackTick('player')).toBe(15);
    });

    it('does nothing for unknown actor', () => {
      const system = new CombatSystem();
      system.reduceNextAttackTick('unknown', 3, 10);
      expect(system.getNextAttackTick('unknown')).toBeUndefined();
    });

    it('does nothing for zero or negative reduction', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor();
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const bridge = makeBridge({
        getAttackSpeed: () => 5,
        resolveAttack: () => ({
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(system.getNextAttackTick('player')).toBe(15);

      system.reduceNextAttackTick('player', 0, 10);
      expect(system.getNextAttackTick('player')).toBe(15);

      system.reduceNextAttackTick('player', -2, 10);
      expect(system.getNextAttackTick('player')).toBe(15);
    });
  });

  describe('extendNextAttackTickIfActive (food eat delay)', () => {
    function setupSystemWithCooldown(): { system: CombatSystem; postAttackTick: number } {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor();
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const bridge = makeBridge({
        getAttackSpeed: () => 5,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const postAttackTick = system.getNextAttackTick('player')!;
      expect(postAttackTick).toBe(15); // tick 10 + attackSpeed 5
      return { system, postAttackTick };
    }

    it('extends next attack tick by delayTicks while a cooldown is active', () => {
      const { system, postAttackTick } = setupSystemWithCooldown();

      // currentTick=11 < nextAttackTick=15, weapon mid-cooldown, +3 ticks for normal food
      system.extendNextAttackTickIfActive('player', 11, 3);
      expect(system.getNextAttackTick('player')).toBe(postAttackTick + 3);
    });

    it('does nothing when actor has no tracked next attack tick', () => {
      const system = new CombatSystem();
      system.extendNextAttackTickIfActive('unknown', 0, 3);
      expect(system.getNextAttackTick('unknown')).toBeUndefined();
    });

    it('does nothing when delayTicks is 0 (e.g. potions)', () => {
      const { system, postAttackTick } = setupSystemWithCooldown();
      system.extendNextAttackTickIfActive('player', 11, 0);
      expect(system.getNextAttackTick('player')).toBe(postAttackTick);
    });

    it('does nothing when delayTicks is negative', () => {
      const { system, postAttackTick } = setupSystemWithCooldown();
      system.extendNextAttackTickIfActive('player', 11, -3);
      expect(system.getNextAttackTick('player')).toBe(postAttackTick);
    });

    it('does nothing when weapon is already ready (currentTick >= nextAttackTick)', () => {
      const { system, postAttackTick } = setupSystemWithCooldown();
      system.extendNextAttackTickIfActive('player', 15, 3);
      expect(system.getNextAttackTick('player')).toBe(postAttackTick);
    });

    it('does nothing when weapon ready by overshoot (currentTick > nextAttackTick)', () => {
      const { system, postAttackTick } = setupSystemWithCooldown();
      system.extendNextAttackTickIfActive('player', 100, 3);
      expect(system.getNextAttackTick('player')).toBe(postAttackTick);
    });

    it('extends when currentTick is exactly nextAttackTick - 1 (1 tick of cooldown left)', () => {
      const { system, postAttackTick } = setupSystemWithCooldown();
      system.extendNextAttackTickIfActive('player', postAttackTick - 1, 3);
      expect(system.getNextAttackTick('player')).toBe(postAttackTick + 3);
    });

    it('stacks additively across multiple calls in the same tick (combo eating)', () => {
      const { system, postAttackTick } = setupSystemWithCooldown();

      // Combo eat: shark (3) + karambwan (2) = +5 total
      // Wiki: "eating a shark with a karambwan results in a 5 tick attack delay"
      system.extendNextAttackTickIfActive('player', 11, 3);
      system.extendNextAttackTickIfActive('player', 11, 2);
      expect(system.getNextAttackTick('player')).toBe(postAttackTick + 5);
    });

    it('continues to extend after a previous extend pushed the cooldown out', () => {
      const { system, postAttackTick } = setupSystemWithCooldown();

      system.extendNextAttackTickIfActive('player', 11, 3);
      // Now nextAttackTick = 18; currentTick=11 still < 18
      system.extendNextAttackTickIfActive('player', 11, 2);
      expect(system.getNextAttackTick('player')).toBe(postAttackTick + 5);
    });

    it('reset() clears the timer so subsequent extends are no-ops', () => {
      const { system } = setupSystemWithCooldown();
      system.reset();
      system.extendNextAttackTickIfActive('player', 11, 3);
      expect(system.getNextAttackTick('player')).toBeUndefined();
    });
  });

  describe('onKillEffect threading', () => {
    it('passes onKillEffect to DamageAppliedInfo when target dies from delayed hit', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor({ vitals: { hp: 5, maxHp: 1000 } } as any);
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const onKillEffect = { refundSpecEnergy: 25, reduceAttackDelayTicks: 3 };

      const bridge = makeBridge({
        enablePendingHits: true,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 20,
          accuracySucceeded: true,
          impactDelayTicks: 2,
          onKillEffect,
        }),
      });

      system.processAttack(world, attacker, target, bridge);
      expect(world.pendingHits).toHaveLength(1);
      expect(world.pendingHits[0].onKillEffect).toEqual(onKillEffect);

      let capturedInfo: any = null;
      const resolveBridge = makeBridge({
        onDamageApplied: (info) => {
          capturedInfo = info;
        },
      });

      world.tick = 12;
      system.processPendingHits(world, resolveBridge);

      expect(capturedInfo).not.toBeNull();
      expect(capturedInfo.hpAfter).toBe(0);
      expect(capturedInfo.onKillEffect).toEqual(onKillEffect);
    });

    it('does not pass onKillEffect when target survives', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor();
      const target = makeNpcActor({ vitals: { hp: 500, maxHp: 1000 } } as any);
      world.actors.set('player', attacker);
      world.actors.set('yama', target);

      const bridge = makeBridge({
        enablePendingHits: true,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 20,
          accuracySucceeded: true,
          impactDelayTicks: 2,
          onKillEffect: { refundSpecEnergy: 25, reduceAttackDelayTicks: 3 },
        }),
      });

      system.processAttack(world, attacker, target, bridge);

      let capturedInfo: any = null;
      const resolveBridge = makeBridge({
        onDamageApplied: (info) => {
          capturedInfo = info;
        },
      });

      world.tick = 12;
      system.processPendingHits(world, resolveBridge);

      expect(capturedInfo).not.toBeNull();
      expect(capturedInfo.hpAfter).toBeGreaterThan(0);
      expect(capturedInfo.onKillEffect).toBeUndefined();
    });
  });

  describe('PrayerReduction types', () => {
    it('should fully block damage with default prayer reduction (block)', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const events = bridge.events.flush();
      const hitEvent = events.find((e) => e.type === 'hit_applied');

      expect(hitEvent).toBeDefined();
      expect((hitEvent as any).damage).toBe(0);
    });

    it('should cap damage with cap prayer reduction', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          prayerReduction: { type: 'cap' as const, value: 3 },
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const events = bridge.events.flush();
      const hitEvent = events.find((e) => e.type === 'hit_applied');

      expect(hitEvent).toBeDefined();
      expect((hitEvent as any).damage).toBe(3);
    });

    it('should reduce damage by percentage with reduce prayer reduction', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          prayerReduction: { type: 'reduce' as const, value: 0.25 },
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const events = bridge.events.flush();
      const hitEvent = events.find((e) => e.type === 'hit_applied');

      expect(hitEvent).toBeDefined();
      expect((hitEvent as any).damage).toBe(10);
    });

    it('should ignore prayer with bypass prayer reduction', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          prayerReduction: { type: 'bypass' as const },
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const events = bridge.events.flush();
      const hitEvent = events.find((e) => e.type === 'hit_applied');

      expect(hitEvent).toBeDefined();
      expect((hitEvent as any).damage).toBe(40);
    });

    it('should queue pending hit when impactDelayTicks > 0 and enablePendingHits is true', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      world.actors.set('player', target);

      const bridge = makeBridge({
        enablePendingHits: true,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 40,
          accuracySucceeded: true,
          impactDelayTicks: 2,
          prayerReduction: { type: 'cap' as const, value: 3 },
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const launchEvents = bridge.events.flush();
      expect(launchEvents.some((event) => event.type === 'hit_applied')).toBe(false);

      world.tick = 11;
      system.processPendingHits(world, bridge);
      const preImpactEvents = bridge.events.flush();
      expect(preImpactEvents.some((event) => event.type === 'hit_applied')).toBe(false);

      world.tick = 12;
      system.processPendingHits(world, bridge);
      const impactEvents = bridge.events.flush();
      const hitEvent = impactEvents.find((event) => event.type === 'hit_applied');
      expect(hitEvent).toBeDefined();
      expect((hitEvent as any).damage).toBe(3);
    });

    it('should preserve attackKind for delayed hit_applied events', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: null });
      world.actors.set('player', target);

      const capturedEvents: unknown[] = [];
      const bridge = makeBridge({
        enablePendingHits: true,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_shadow' as const,
          rolledDamage: 12,
          accuracySucceeded: true,
          impactDelayTicks: 2,
        }),
      });
      const originalEmit = bridge.events.emit.bind(bridge.events);
      bridge.events.emit = (event) => {
        capturedEvents.push(event);
        originalEmit(event);
      };

      system.processAttack(world, attacker, target, bridge);
      bridge.events.flush();

      world.tick = 12;
      system.processPendingHits(world, bridge);

      const hitEvent = capturedEvents.find(isHitAppliedEvent);
      expect(hitEvent).toBeDefined();
      if (!hitEvent) {
        throw new Error('Expected hit_applied event was not emitted');
      }
      expect(hitEvent.attackKind).toBe('magic_shadow');
    });
  });

  describe('impact delay timing', () => {
    it.each([
      {
        label: 'melee',
        style: 'melee' as const,
        attackKind: 'melee_crush' as const,
        delay: 1,
      },
      {
        label: 'range',
        style: 'range' as const,
        attackKind: 'range_shadow' as const,
        delay: 2,
      },
      {
        label: 'magic',
        style: 'magic' as const,
        attackKind: 'magic_shadow' as const,
        delay: 2,
      },
    ])('lands $label hit after $delay delayed ticks when pending hits enabled', ({ style, attackKind, delay }) => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: null });
      world.actors.set('player', target);

      const bridge = makeBridge({
        enablePendingHits: true,
        resolveAttack: () => ({
          style,
          attackKind,
          rolledDamage: 12,
          accuracySucceeded: true,
          impactDelayTicks: delay,
        }),
        infiniteHealth: true,
      });

      system.processAttack(world, attacker, target, bridge);
      const launchEvents = bridge.events.flush();

      const attackStarted = launchEvents.find((event) => event.type === 'attack_started');
      expect(attackStarted).toBeDefined();
      expect(launchEvents.some((event) => event.type === 'hit_applied')).toBe(false);
      expect((attackStarted as { impactDelayTicks?: number } | undefined)?.impactDelayTicks).toBe(delay);

      const launchTick = 10;
      expect(world.pendingHits).toHaveLength(1);
      expect(world.pendingHits[0].impactTick).toBe(launchTick + delay);

      world.tick = launchTick + delay - 1;
      system.processPendingHits(world, bridge);
      expect(bridge.events.flush().some((event) => event.type === 'hit_applied')).toBe(false);

      world.tick = launchTick + delay;
      system.processPendingHits(world, bridge);

      const impactEvents = bridge.events.flush();
      const hitEvent = impactEvents.find(isHitAppliedEvent);
      expect(hitEvent).toBeDefined();
      if (!hitEvent) {
        throw new Error('Expected hit_applied event was not emitted');
      }
      expect(hitEvent.tick).toBe(launchTick + delay);
    });
  });

  describe('DamageValue range support', () => {
    it('resolves a [min, max] range to a value within bounds for immediate hit', () => {
      const system = new CombatSystem();
      const results = new Set<number>();

      for (let i = 0; i < 100; i++) {
        const world = makeWorldState(10);
        const attacker = world.actors.get('yama')!;
        const target = makePlayerActor({ activePrayer: null });
        target.vitals.hp = 99;
        target.alive = true;
        world.actors.set('player', target);

        const bridge = makeBridge({
          resolveAttack: () => ({
            style: 'magic' as const,
            attackKind: 'magic_fire' as const,
            rolledDamage: [5, 15] as [number, number],
            accuracySucceeded: true,
            impactDelayTicks: 0,
          }),
          infiniteHealth: false,
        });

        system.processAttack(world, attacker, target, bridge);
        const damage = 99 - target.vitals.hp;
        results.add(damage);
        system.reset();
      }

      for (const d of results) {
        expect(d).toBeGreaterThanOrEqual(5);
        expect(d).toBeLessThanOrEqual(15);
      }
      expect(results.size).toBeGreaterThanOrEqual(3);
    });

    it('resolves a [min, max] range for delayed (pending) hit', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: null });
      target.vitals.hp = 99;
      world.actors.set('player', target);

      const bridge = makeBridge({
        enablePendingHits: true,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: [10, 30] as [number, number],
          accuracySucceeded: true,
          impactDelayTicks: 2,
        }),
        infiniteHealth: false,
      });

      system.processAttack(world, attacker, target, bridge);

      // Damage should be rolled at queue time — PendingHit stores resolved number
      expect(world.pendingHits.length).toBe(1);
      const pending = world.pendingHits[0];
      expect(typeof pending.rolledDamage).toBe('number');
      expect(pending.rolledDamage).toBeGreaterThanOrEqual(10);
      expect(pending.rolledDamage).toBeLessThanOrEqual(30);

      world.tick = 12;
      system.processPendingHits(world, bridge);
      const damage = 99 - target.vitals.hp;
      expect(damage).toBeGreaterThanOrEqual(10);
      expect(damage).toBeLessThanOrEqual(30);
    });

    it('resolves a plain number rolledDamage', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: null });
      target.vitals.hp = 99;
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 25,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: false,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(target.vitals.hp).toBe(74);
    });
  });

  describe('Project Rebalance: minimum hit boost (0→1 on accuracy success) — PLAYER attacks only', () => {
    it('boosts a PLAYER attack from 0 to 1 when accuracy succeeds', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor({ id: 'player' as any });
      const target = makeNpcActor({ id: 'target-npc' as any, vitals: { hp: 99, maxHp: 99 } });
      world.actors.set('target-npc' as any, target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 0,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: false,
      });

      system.processAttack(world, attacker, target, bridge);
      // 0 boosted to 1
      expect(target.vitals.hp).toBe(98);
    });

    it('does NOT boost when accuracy fails (miss stays 0)', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: null });
      target.vitals.hp = 99;
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 0,
          accuracySucceeded: false,
          impactDelayTicks: 0,
        }),
        infiniteHealth: false,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(target.vitals.hp).toBe(99);
    });

    it('does not double-boost PLAYER attack values already >= 1', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor({ id: 'player' as any });
      const target = makeNpcActor({ id: 'target-npc' as any, vitals: { hp: 99, maxHp: 99 } });
      world.actors.set('target-npc' as any, target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 5,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: false,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(target.vitals.hp).toBe(94);
    });

    it('boosts a PLAYER attack 0→1 for delayed (pending) hits', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = makePlayerActor({ id: 'player' as any });
      const target = makeNpcActor({ id: 'target-npc' as any, vitals: { hp: 99, maxHp: 99 } });
      world.actors.set(attacker.id, attacker);
      world.actors.set('target-npc' as any, target);

      const bridge = makeBridge({
        enablePendingHits: true,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: [0, 0] as [number, number],
          accuracySucceeded: true,
          impactDelayTicks: 2,
        }),
        infiniteHealth: false,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(world.pendingHits.length).toBe(1);

      world.tick = 12;
      system.processPendingHits(world, bridge);
      // 0 boosted to 1 at impact time
      expect(target.vitals.hp).toBe(98);
    });
  });

  describe('NPC attacks do NOT get the player min-1 boost (prayed hits can deal 0)', () => {
    it('NPC roll 0 with no prayer stays 0 (does not kill at 1 HP)', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: null });
      target.vitals.hp = 1;
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 0,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: false,
      });

      system.processAttack(world, attacker, target, bridge);
      // NPC roll 0 is NOT boosted to 1, so the player takes 0 and survives.
      expect(target.vitals.hp).toBe(1);
      expect(target.alive).toBe(true);
    });

    it('Yama prayed range/mage roll 0 deals 0 (does not leave player stuck at 1 HP)', () => {
      // A player at 2 HP praying correctly against a rolled-0 attack must take 0
      // (cap(3) -> min(3,0) = 0).
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      target.vitals.hp = 2;
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 0,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          prayerReduction: { type: 'cap' as const, value: 3 },
        }),
        infiniteHealth: false,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(target.vitals.hp).toBe(2);
      expect(target.alive).toBe(true);
    });

    it('NPC roll 0 fully blocked by prayer deals 0', () => {
      const system = new CombatSystem();
      const world = makeWorldState(10);
      const attacker = world.actors.get('yama')!;
      const target = makePlayerActor({ activePrayer: PrayerType.ProtectMagic });
      target.vitals.hp = 50;
      world.actors.set('player', target);

      const bridge = makeBridge({
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 0,
          accuracySucceeded: true,
          impactDelayTicks: 0,
          prayerReduction: { type: 'block' as const },
        }),
        infiniteHealth: false,
      });

      system.processAttack(world, attacker, target, bridge);
      expect(target.vitals.hp).toBe(50);
    });
  });
});

describe('CombatSystem — scheduled attack cycle + perfect-dodge speedup', () => {
  function setupAttacker() {
    const system = new CombatSystem();
    const world = makeWorldState(10);
    const attacker = makePlayerActor();
    const target = makeNpcActor();
    world.actors.set('player', attacker);
    world.actors.set('yama', target);
    const bridge = makeBridge({
      getAttackSpeed: () => 5,
      resolveAttack: () => ({
        style: 'magic' as const,
        attackKind: 'magic_fire' as const,
        rolledDamage: 10,
        accuracySucceeded: true,
        impactDelayTicks: 0,
      }),
      infiniteHealth: true,
    });
    return { system, world, attacker, target, bridge };
  }

  describe('getScheduledAttackCycle', () => {
    it('returns undefined before the first attack', () => {
      const { system } = setupAttacker();
      expect(system.getScheduledAttackCycle('player')).toBeUndefined();
    });

    it('records the cycle length used to schedule the current cooldown', () => {
      const { system, world, attacker, target, bridge } = setupAttacker();
      system.processAttack(world, attacker, target, bridge);
      expect(system.getScheduledAttackCycle('player')).toBe(5);
      expect(system.getNextAttackTick('player')).toBe(15);
    });

    it('updates the cycle on each attack using the speed AT scheduling time', () => {
      const { system, world, attacker, target } = setupAttacker();
      const fastBridge = makeBridge({
        getAttackSpeed: () => 5,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });
      system.processAttack(world, attacker, target, fastBridge);
      expect(system.getScheduledAttackCycle('player')).toBe(5);

      world.tick = 15;
      const faster = makeBridge({
        getAttackSpeed: () => 3,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });
      system.processAttack(world, attacker, target, faster);
      expect(system.getScheduledAttackCycle('player')).toBe(3);
    });

    it('clears on reset()', () => {
      const { system, world, attacker, target, bridge } = setupAttacker();
      system.processAttack(world, attacker, target, bridge);
      expect(system.getScheduledAttackCycle('player')).toBe(5);
      system.reset();
      expect(system.getScheduledAttackCycle('player')).toBeUndefined();
    });
  });

  describe('speedUpNextAttack (perfect-dodge cooldown shortening)', () => {
    it('shortens the CURRENT pending cooldown so the next attack lands sooner', () => {
      const { system, world, attacker, target, bridge } = setupAttacker();
      // First attack schedules the cooldown: nextTick = 10 + 5 = 15, cycle 5.
      system.processAttack(world, attacker, target, bridge);
      expect(system.getNextAttackTick('player')).toBe(15);
      expect(system.getScheduledAttackCycle('player')).toBe(5);

      // Perfect dodge shortens the live cooldown by 1: nextTick 15 -> 14, cycle 5 -> 4.
      system.speedUpNextAttack('player', 1, 10);
      expect(system.getNextAttackTick('player')).toBe(14);
      expect(system.getScheduledAttackCycle('player')).toBe(4);
      expect(system.getAppliedAttackSpeedup('player')).toBe(1);
    });

    it('makes the NEXT swing fire one tick earlier than it otherwise would', () => {
      const { system, world, attacker, target, bridge } = setupAttacker();
      // Attack at tick 10 -> normally blocked until tick 15.
      system.processAttack(world, attacker, target, bridge);
      bridge.events.flush();

      system.speedUpNextAttack('player', 1, 10); // cooldown ends at tick 14 now.

      world.tick = 13;
      target.vitals.hp = 1000;
      target.alive = true;
      system.processAttack(world, attacker, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(false);

      // Fires at tick 14 — one tick earlier than the normal tick 15.
      world.tick = 14;
      target.vitals.hp = 1000;
      target.alive = true;
      system.processAttack(world, attacker, target, bridge);
      expect(bridge.events.flush().some((e) => e.type === 'attack_started')).toBe(true);
    });

    it('is a no-op when no cooldown is pending (actor has not attacked yet)', () => {
      const { system } = setupAttacker();
      system.speedUpNextAttack('player', 1, 10);
      expect(system.getNextAttackTick('player')).toBeUndefined();
      expect(system.getAppliedAttackSpeedup('player')).toBe(0);
    });

    it('is a no-op when the actor is already eligible to attack (cooldown elapsed)', () => {
      const { system, world, attacker, target, bridge } = setupAttacker();
      system.processAttack(world, attacker, target, bridge); // tick 10 -> nextTick 15, cycle 5
      // At tick 20 the cooldown has long elapsed (player ready but not swinging).
      system.speedUpNextAttack('player', 1, 20);
      expect(system.getNextAttackTick('player')).toBe(15);
      expect(system.getScheduledAttackCycle('player')).toBe(5);
      expect(system.getAppliedAttackSpeedup('player')).toBe(0);
    });

    it('does NOT stack — repeated dodges before the next swing cap at the granted amount', () => {
      const { system, world, attacker, target, bridge } = setupAttacker();
      system.processAttack(world, attacker, target, bridge); // nextTick 15, cycle 5
      system.speedUpNextAttack('player', 1, 10);
      system.speedUpNextAttack('player', 1, 10);
      system.speedUpNextAttack('player', 1, 10);
      // Only -1 total, not -3.
      expect(system.getNextAttackTick('player')).toBe(14);
      expect(system.getScheduledAttackCycle('player')).toBe(4);
      expect(system.getAppliedAttackSpeedup('player')).toBe(1);
    });

    it('tops up to a larger grant within the same cooldown window', () => {
      const { system, world, attacker, target, bridge } = setupAttacker();
      system.processAttack(world, attacker, target, bridge); // nextTick 15, cycle 5
      system.speedUpNextAttack('player', 1, 10); // -> 14, applied 1
      system.speedUpNextAttack('player', 2, 10); // top up by 1 more -> 13, applied 2
      expect(system.getNextAttackTick('player')).toBe(13);
      expect(system.getScheduledAttackCycle('player')).toBe(3);
      expect(system.getAppliedAttackSpeedup('player')).toBe(2);
    });

    it('resets per cooldown window — a new swing allows a fresh dodge', () => {
      const { system, world, attacker, target, bridge } = setupAttacker();
      system.processAttack(world, attacker, target, bridge); // tick 10 -> nextTick 15
      system.speedUpNextAttack('player', 1, 10); // -> 14, applied 1
      bridge.events.flush();

      // The sped-up swing fires at tick 14 and schedules a fresh cooldown (14+5=19).
      world.tick = 14;
      target.vitals.hp = 1000;
      target.alive = true;
      system.processAttack(world, attacker, target, bridge);
      expect(system.getNextAttackTick('player')).toBe(19);
      expect(system.getAppliedAttackSpeedup('player')).toBe(0);

      // A new dodge shortens THIS window: 19 -> 18.
      system.speedUpNextAttack('player', 1, 14);
      expect(system.getNextAttackTick('player')).toBe(18);
      expect(system.getScheduledAttackCycle('player')).toBe(4);
    });

    it('never shortens the cycle below 1 tick (1-tick weapon)', () => {
      const { system, world, attacker, target } = setupAttacker();
      const oneTick = makeBridge({
        getAttackSpeed: () => 1,
        resolveAttack: () => ({
          style: 'magic' as const,
          attackKind: 'magic_fire' as const,
          rolledDamage: 10,
          accuracySucceeded: true,
          impactDelayTicks: 0,
        }),
        infiniteHealth: true,
      });
      system.processAttack(world, attacker, target, oneTick); // tick 10 -> nextTick 11, cycle 1
      system.speedUpNextAttack('player', 5, 10);
      // cycle 1 cannot be shortened (would drop below 1). No change.
      expect(system.getNextAttackTick('player')).toBe(11);
      expect(system.getScheduledAttackCycle('player')).toBe(1);
      expect(system.getAppliedAttackSpeedup('player')).toBe(0);
    });

    it('ignores zero and negative amounts', () => {
      const { system, world, attacker, target, bridge } = setupAttacker();
      system.processAttack(world, attacker, target, bridge); // nextTick 15
      system.speedUpNextAttack('player', 0, 10);
      system.speedUpNextAttack('player', -5, 10);
      expect(system.getNextAttackTick('player')).toBe(15);
      expect(system.getAppliedAttackSpeedup('player')).toBe(0);
    });

    it('clears applied speedup on reset()', () => {
      const { system, world, attacker, target, bridge } = setupAttacker();
      system.processAttack(world, attacker, target, bridge);
      system.speedUpNextAttack('player', 1, 10);
      expect(system.getAppliedAttackSpeedup('player')).toBe(1);
      system.reset();
      expect(system.getAppliedAttackSpeedup('player')).toBe(0);
      expect(system.getNextAttackTick('player')).toBeUndefined();
    });
  });
});
