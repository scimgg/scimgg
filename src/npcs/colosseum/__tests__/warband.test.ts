import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NpcActor } from '../../../core/actors/NpcActor';
import { CombatSystem, type DamageAppliedInfo } from '../../../core/combat/CombatSystem';
import { npcHitDelayFromEndTime } from '../../../core/combat/hitDelay';
import { setArenaConfig } from '../../../core/constants';
import type { EncounterContext, EncounterTickResult } from '../../../core/encounters/types';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import { type GameEvent, isCoreEvent } from '../../../core/events/types';
import { recordNpcLethalTransition, recordNpcStep } from '../../../core/npcDeath';
import type { NpcDefinitionContext } from '../../../core/npcs';
import { NpcDefinitionCollection } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { SolHereditEncounter } from '../../../encounters/solHeredit/SolHereditEncounter';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import type { Coordinate } from '../../../types/simulation';
import type { ColosseumRelentlessRank } from '../constants';
import { createWarbander, WARBAND_SLOT_OFFSETS, type WarbanderRole, warbanderDefinition } from '../warband';

const SPAWN_TICK = 10;
const registration = warbanderDefinition.register(undefined);

afterEach(() => setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true));

/** One production warbander through the real engine: its definition moves and acts in its own turn. */
class WarbanderEngineEncounter extends LobbyEncounter {
  private readonly definitions = new NpcDefinitionCollection([warbanderDefinition.register(undefined)]);

  constructor(private readonly member: NpcActor) {
    super();
  }

  override createNpcs(): NpcActor[] {
    return [this.member];
  }

  getNpcDefinitions(): NpcDefinitionCollection {
    return this.definitions;
  }

  processNpcTick(actor: NpcActor, ctx: EncounterContext): EncounterTickResult {
    return this.definitions.tick(actor, { ...ctx, random: () => 0.5 });
  }
}

function fixture(role: WarbanderRole, position: Coordinate = [20, 21], relentless?: ColosseumRelentlessRank) {
  const world = new SimulationEngine({ encounter: new SolHereditEncounter(1) })['worldState'];
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  const player = world.getPlayer()!;
  world.actors.clear();
  world.actors.set(player.id, player);
  player.position = [20, 20];
  const warbander = createWarbander({
    id: 'warbander',
    role,
    position,
    spawnTick: SPAWN_TICK,
    slotOffset: WARBAND_SLOT_OFFSETS.berserker,
    relentless,
  });
  world.actors.set(warbander.id, warbander);
  const context = (tick: number, random: () => number = () => 0.5): NpcDefinitionContext => ({
    tick,
    world,
    tickEvents: new TickEvents(),
    random,
    spawnNpc: () => undefined,
    despawnNpc: () => undefined,
    logEvent: () => undefined,
  });
  return { world, player, warbander, context };
}

describe('Fremennik warbander death through the engine', () => {
  // B:3356: the berserker swings on its killing tick, its next-tick melee never lands (no splat at
  // 3357), and its death sequence starts at 3357.
  it.each([
    { killed: true, landsOnPlayer: false },
    { killed: false, landsOnPlayer: true },
  ])('swings on its killing tick and its melee lands $landsOnPlayer (killed: $killed, B:3356)', ({
    killed,
    landsOnPlayer,
  }) => {
    const berserker = createWarbander({
      id: 'berserker',
      role: 'berserker',
      position: [20, 21],
      spawnTick: SPAWN_TICK,
      slotOffset: WARBAND_SLOT_OFFSETS.berserker,
    });
    const engine = new SimulationEngine({ encounter: new WarbanderEngineEncounter(berserker), startPos: [20, 20] });
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
    engine.setMechanicsConfig({ infiniteHealth: true });
    if (killed) {
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: berserker.id,
        style: 'magic',
        attackKind: 'magic_shadow',
        launchTick: 10,
        impactTick: 13,
        rolledDamage: berserker.vitals.hp,
        accuracySucceeded: true,
      });
    }
    const killTickEvents: GameEvent[] = [];
    while (engine.currentTick < 13) {
      engine.advanceTick([20, 20]);
      killTickEvents.splice(0, killTickEvents.length, ...engine.getLastTickEvents());
    }
    engine.advanceTick([20, 20]);
    const nextTickEvents = engine.getLastTickEvents();

    expect(
      killTickEvents.some((event) => isCoreEvent(event, 'attack_started') && event.sourceId === berserker.id),
    ).toBe(true);
    expect(nextTickEvents.some((event) => isCoreEvent(event, 'hit_applied') && event.targetId === 'player')).toBe(
      landsOnPlayer,
    );
    if (!killed) return;
    expect(berserker.death).toMatchObject({ killTick: 13, processTick: 14, status: 'started' });
    expect(berserker.deathAnimationTick).toBe(14);
    expect(engine.getState().npcs.find((npc) => npc.id === berserker.id)).toMatchObject({
      alive: false,
      deathAnimationTick: 14,
    });
  });
});

describe('Fremennik warbander killed while it walks', () => {
  // A member killed in its own hit pass still walks that tick (its queued death keeps the turn), and its
  // death sequence is floored three ticks after that step: B:2218 killed mid-walk, death 2221.
  it.each([true, false])('takes its killing-tick steps and falls three ticks later (killed: %s)', (killed) => {
    const berserker = createWarbander({
      id: 'berserker',
      role: 'berserker',
      position: [20, 24],
      spawnTick: SPAWN_TICK,
      slotOffset: WARBAND_SLOT_OFFSETS.berserker,
    });
    const engine = new SimulationEngine({ encounter: new WarbanderEngineEncounter(berserker), startPos: [20, 20] });
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
    engine.setMechanicsConfig({ infiniteHealth: true });
    const firstMoveTick = SPAWN_TICK + 2;
    if (killed)
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: berserker.id,
        style: 'magic',
        attackKind: 'magic_shadow',
        launchTick: 0,
        impactTick: firstMoveTick,
        rolledDamage: berserker.vitals.hp,
        accuracySucceeded: true,
      });
    while (engine.currentTick < firstMoveTick) engine.advanceTick([20, 20]);

    expect(berserker.position).toEqual([20, 22]);
    expect(berserker.lastStepTick).toBe(firstMoveTick);
    if (!killed) return;
    expect(berserker.death).toMatchObject({ killTick: firstMoveTick, processTick: firstMoveTick + 1 });
    expect(berserker.deathAnimationTick).toBe(firstMoveTick + 3);
    engine.advanceTick([20, 20]);
    expect(berserker.position).toEqual([20, 22]);
  });
});

describe('Fremennik warbander', () => {
  it.each([
    { role: 'berserker', npcTypeId: 12816, hp: 48, weakness: 'magic', attack: 10856, death: 10858 },
    { role: 'archer', npcTypeId: 12814, hp: 50, weakness: 'melee', attack: 10850, death: 10852 },
    { role: 'seer', npcTypeId: 12815, hp: 50, weakness: 'range', attack: 10853, death: 10855 },
  ] as const)('builds the $role from its Wiki stats with one weakness style', ({ role, ...expected }) => {
    const { warbander } = fixture(role);
    expect(warbander).toMatchObject({
      npcTypeId: expected.npcTypeId,
      size: 1,
      vitals: { hp: expected.hp, maxHp: expected.hp },
      blocksNpcMovement: false,
      passThruNpcs: true,
      movesWithAttackerUnder: true,
      combat: { attackSpeed: 6, animations: { attack: expected.attack, death: expected.death } },
      formulaStats: {
        levels: { attack: 110, strength: 110, defence: 80, ranged: 110, magic: 110 },
        alwaysMaximumPlayerHitStyles: [expected.weakness],
      },
    });
  });

  it.each([
    { role: 'berserker', ticks: [13, 19, 25] },
    { role: 'seer', ticks: [14, 20, 26] },
    { role: 'archer', ticks: [15, 21, 27] },
  ] as const)('attacks the $role on its fixed 6-tick phase from spawn', ({ role, ticks }) => {
    const { warbander, context } = fixture(role);
    const attackTicks: number[] = [];
    for (let tick = SPAWN_TICK; tick <= 28; tick++) {
      if (registration.tick(warbander, context(tick)).npcAttacks?.length) attackTicks.push(tick);
    }
    expect(attackTicks).toEqual(ticks);
  });

  // The slot is north of the player's [20, 20]; the gate reads where the member started the tick.
  it.each([
    { case: 'it only arrived on its slot this tick', start: [20, 23] as Coordinate, position: [20, 21] as Coordinate },
    { case: 'it started beside the player on the wrong side', start: [20, 19] as Coordinate },
    { case: 'it started diagonal', start: [21, 21] as Coordinate },
    { case: 'it started two tiles away', start: [20, 22] as Coordinate },
    { case: 'it started under the player', start: [20, 20] as Coordinate },
  ])('skips the cycle without rolling when $case', ({ start, position = start }) => {
    const { warbander, context } = fixture('berserker', position);
    warbander.previousPosition = start;
    const random = vi.fn(() => 0.5);
    const tickContext = context(13, random);

    expect(registration.tick(warbander, tickContext).npcAttacks).toBeUndefined();
    expect(random).not.toHaveBeenCalled();
    expect(tickContext.tickEvents.flush()).toEqual([]);
  });

  it.each([
    // B:3356: the berserker's swing on its killing tick never lands, while released projectiles persist.
    {
      role: 'berserker',
      tick: 13,
      style: 'melee',
      attackKind: 'melee_stab',
      maxHit: 29,
      impactDelayTicks: 1,
      sourceDeathPolicy: 'cancel-before-impact',
    },
    {
      role: 'archer',
      tick: 15,
      style: 'range',
      attackKind: 'range_arrow',
      maxHit: 14,
      impactDelayTicks: 1,
      sourceDeathPolicy: 'persist',
    },
    {
      role: 'seer',
      tick: 14,
      style: 'magic',
      attackKind: 'magic_fire',
      maxHit: 12,
      impactDelayTicks: 1,
      sourceDeathPolicy: 'persist',
    },
  ] as const)('rolls the $role attack up to its Wiki maximum and lands it after $impactDelayTicks', ({
    role,
    tick,
    ...expected
  }) => {
    const { warbander, player, context } = fixture(role);
    const tickContext = context(tick, () => 0.999999);

    const [attack] = registration.tick(warbander, tickContext).npcAttacks ?? [];

    expect(attack).toEqual({
      attackerId: warbander.id,
      targetId: player.id,
      style: expected.style,
      attackKind: expected.attackKind,
      rolledDamage: expected.maxHit,
      accuracySucceeded: false,
      impactDelayTicks: expected.impactDelayTicks,
      sourceDeathPolicy: expected.sourceDeathPolicy,
    });
    expect(tickContext.tickEvents.flush().filter(isEncounterVisualEvent)).toMatchObject([
      { animations: [{ actorId: warbander.id, clipId: 'attack', delayCycles: 0 }] },
    ]);
  });

  // B:3356: the berserker swings on its killing tick and no splat lands at 3357. The sim does not yet let
  // a member act on its killing tick, so the swing comes a tick earlier and the kill lands before impact.
  it.each([
    { role: 'berserker', tick: 13, landed: [] },
    { role: 'archer', tick: 15, landed: [14] },
  ] as const)('$role: the swing launched before the member dies lands $landed', ({ role, tick, landed }) => {
    const { world, warbander, player, context } = fixture(role);
    const [attack] =
      registration.tick(
        warbander,
        context(tick, () => 0),
      ).npcAttacks ?? [];
    if (!attack) throw new TypeError('Expected a warband attack');
    const combat = new CombatSystem();
    const events = new TickEvents();
    const damage: number[] = [];
    const bridge = {
      events,
      enablePendingHits: true,
      onDamageApplied: (info: DamageAppliedInfo) => damage.push(info.effectiveDamage),
    };
    world.tick = tick;
    combat.processAttackRequest(
      world,
      { attacker: warbander, target: player, attack: { ...attack, accuracySucceeded: true, rolledDamage: 14 } },
      bridge,
    );
    warbander.vitals.hp = 0;
    warbander.alive = false;

    world.tick = tick + 1;
    combat.processPendingHits(world, bridge, 'npc');
    combat.processPendingHits(world, bridge, 'player');

    expect(damage).toEqual(landed);
    expect(world.pendingHits).toEqual([]);
  });

  describe('Relentless', () => {
    /** The share of an even grid of rolls the attack hits with: its accuracy, to the grid's resolution. */
    function hitShare(relentless: ColosseumRelentlessRank | undefined, defence: number) {
      const { warbander, player, context } = fixture('berserker', [20, 21], relentless);
      player.stats.defence.current = defence;
      let hits = 0;
      for (let step = 0; step < 1000; step++) {
        const roll = (step + 0.5) / 1000;
        if (
          registration.tick(
            warbander,
            context(13, () => roll),
          ).npcAttacks?.[0]?.accuracySucceeded
        )
          hits++;
      }
      expect(player.stats.defence.current).toBe(defence);
      return hits;
    }

    it.each([
      { rank: 1, maxHit: 30 },
      { rank: 2, maxHit: 32 },
      { rank: 3, maxHit: 35 },
    ] as const)('raises the berserker max hit by the rank $rank bonus', ({ rank, maxHit }) => {
      const { warbander, context } = fixture('berserker', [20, 21], rank);
      const [attack] =
        registration.tick(
          warbander,
          context(13, () => 0.999999),
        ).npcAttacks ?? [];
      expect(attack?.rolledDamage).toBe(maxHit);
      // Rank III ignores accuracy; lower ranks still roll it.
      expect(attack?.accuracySucceeded).toBe(rank === 3);
    });

    it.each([
      { rank: 1, bypassedLevel: 99 - 32 },
      { rank: 2, bypassedLevel: 99 - 65 },
    ] as const)('rolls rank $rank accuracy as if the Defence level were $bypassedLevel', ({ rank, bypassedLevel }) => {
      const share = hitShare(rank, 99);
      expect(share).toBeGreaterThan(hitShare(undefined, 99));
      expect(share).toBe(hitShare(undefined, bypassedLevel));
    });
  });

  // Packet fields: WARBAND_PROJECTILES in ../constants.ts, checked against every capture in warbandCapture.test.ts.
  it.each([
    { role: 'berserker', tick: 13, projectile: undefined, impacts: [] },
    {
      role: 'archer',
      tick: 15,
      projectile: { spotAnimId: 9, slope: 15, startHeight: 163, endHeight: 146 },
      impacts: [],
    },
    {
      role: 'seer',
      tick: 14,
      projectile: { spotAnimId: 130, slope: 16, startHeight: 172, endHeight: 124 },
      impacts: [{ spotAnimId: 131, target: { kind: 'attached', actorId: 'player' }, delayCycles: 30, height: 124 }],
    },
  ] as const)('launches the $role projectile with its captured fields, landing on the hit tick', ({
    role,
    tick,
    projectile,
    impacts,
  }) => {
    const { warbander, player, context } = fixture(role);
    const tickContext = context(tick);

    const [attack] = registration.tick(warbander, tickContext).npcAttacks ?? [];
    const [visual] = tickContext.tickEvents.flush().filter(isEncounterVisualEvent);

    expect(visual?.graphics).toEqual(impacts);
    if (!projectile) {
      expect(visual?.projectiles).toEqual([]);
      return;
    }
    expect(visual?.projectiles).toEqual([
      {
        ...projectile,
        sourcePosition: [20.5, 21.5],
        target: { kind: 'actor', actorId: player.id, size: 1, position: [20, 20] },
        startDelayCycles: 10,
        endDelayCycles: 30,
        startOffset: 64,
      },
    ]);
    expect(attack?.impactDelayTicks).toBe(npcHitDelayFromEndTime(30));
  });

  it('holds on its spawn tick and the next, then runs two tiles toward its slot', () => {
    const { warbander, context } = fixture('berserker', [20, 14]);
    expect(registration.move(warbander, context(SPAWN_TICK))).toEqual([]);
    expect(registration.move(warbander, context(SPAWN_TICK + 1))).toEqual([]);
    expect(registration.move(warbander, context(SPAWN_TICK + 2))).toEqual([
      {
        npcId: warbander.id,
        path: [
          [20, 15],
          [20, 16],
        ],
      },
    ]);
  });

  it('stays put while bound and forgets the route it was walking', () => {
    const { warbander, context } = fixture('berserker', [20, 14]);
    registration.move(warbander, context(SPAWN_TICK + 2));
    expect(warbander.state.route.remainingSteps).not.toEqual([]);
    warbander.debuffs = { boundUntilTick: SPAWN_TICK + 5 };

    expect(registration.move(warbander, context(SPAWN_TICK + 3))).toEqual([]);
    expect(warbander.state.route.remainingSteps).toEqual([]);
  });

  it('swings from its slot while a leftover route carries it off (C:1800-1802)', () => {
    // Sim tiles of no-sol t1798-1802 (world minus 1792/3072). The trio spawns at 1798.
    const { world, player, context } = fixture('berserker');
    world.actors.clear();
    world.actors.set(player.id, player);
    const spawns: Record<WarbanderRole, Coordinate> = { berserker: [35, 37], archer: [34, 36], seer: [36, 36] };
    const members = (['berserker', 'archer', 'seer'] as const).map((role) => {
      const member = createWarbander({
        id: role,
        role,
        position: spawns[role],
        spawnTick: 1798,
        slotOffset: WARBAND_SLOT_OFFSETS[role],
      });
      world.actors.set(member.id, member);
      return member;
    });
    /** The engine's NPC band: record the start tile, move every member, then run the attack hooks. */
    const runTick = (tick: number, playerStart: Coordinate) => {
      player.position = playerStart;
      const tickContext = context(tick, () => 0.999999);
      const paths: Record<string, Coordinate[]> = {};
      for (const member of members) {
        member.previousPosition = member.position;
        const path = registration.move(member, tickContext)[0]?.path ?? [];
        paths[member.id] = path;
        member.position = path.at(-1) ?? member.position;
      }
      const attacks = members.flatMap((member) => registration.tick(member, tickContext).npcAttacks ?? []);
      return { paths, attacks };
    };

    expect(runTick(1800, [31, 39]).paths).toEqual({
      berserker: [
        [34, 37],
        [33, 38],
      ],
      archer: [
        [33, 36],
        [32, 37],
      ],
      seer: [
        [35, 36],
        [34, 37],
      ],
    });
    // The player ran beside them: each starts 1801 on its slot (N, W, E) with an empty fresh route,
    // keeps walking the 1800 route's tail, and only the berserker is on its phase (spawn+3).
    const at1801 = runTick(1801, [33, 37]);
    expect(at1801.paths).toEqual({
      berserker: [
        [32, 39],
        [31, 40],
      ],
      archer: [
        [31, 38],
        [30, 39],
      ],
      seer: [
        [33, 38],
        [32, 39],
      ],
    });
    expect(at1801.attacks).toEqual([
      expect.objectContaining({ attackerId: 'berserker', style: 'melee', impactDelayTicks: 1 }),
    ]);
    // The swing lands on 1802 (the capture's 9). The seer's 1802 phase finds it two tiles off.
    expect(runTick(1802, [35, 37]).attacks).toEqual([]);
  });

  it('launches a ranged projectile from the tile it started the tick on', () => {
    const { warbander, context } = fixture('seer', [19, 22]);
    warbander.previousPosition = [20, 21];
    const tickContext = context(14);
    expect(registration.tick(warbander, tickContext).npcAttacks).toHaveLength(1);
    const [visual] = tickContext.tickEvents.flush().filter(isEncounterVisualEvent);
    expect(visual?.projectiles?.[0]?.sourcePosition).toEqual([20.5, 21.5]);
  });

  it('flinches on a hit it survives, but not on the killing one', () => {
    const { warbander, context } = fixture('archer');
    const damage = { tick: 12, sourceId: 'player', targetId: warbander.id, attackType: 'melee' as const };
    const survive = context(12);
    registration.notifyDamageResolved(
      warbander,
      {
        ...damage,
        baseDamage: 5,
        effectiveDamage: 5,
        activePrayer: null,
        prayedCorrectly: null,
        hpBefore: 50,
        hpAfter: 45,
      },
      survive,
    );
    expect(
      survive.tickEvents
        .flush()
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations),
    ).toEqual([{ actorId: warbander.id, clipId: 'defend', delayCycles: 0 }]);
    const killed = context(13);
    registration.notifyDamageResolved(
      warbander,
      {
        ...damage,
        baseDamage: 45,
        effectiveDamage: 45,
        activePrayer: null,
        prayedCorrectly: null,
        hpBefore: 45,
        hpAfter: 0,
      },
      killed,
    );
    expect(killed.tickEvents.flush()).toEqual([]);
  });

  it('faces its steps while it moves, not the player', () => {
    expect(fixture('seer').warbander.facesStepsWhileMoving).toBe(true);
  });

  // Capture cases (B): kill on a still tick after a step (2210 -> 2212), kill mid-walk (2218 -> 2221),
  // long still (1882 -> 1883), and a step 2 ticks before the kill (2385 -> 2386).
  it.each([
    { case: 'stepped on the defeat tick', lastStep: 0, deathAfter: 3 },
    { case: 'stepped one tick before', lastStep: 1, deathAfter: 2 },
    { case: 'stepped two ticks before', lastStep: 2, deathAfter: 1 },
    { case: 'stood still for longer', lastStep: 5, deathAfter: 1 },
  ])('starts its death $deathAfter ticks after a lethal-last kill when it $case', ({ lastStep, deathAfter }) => {
    const { warbander } = fixture('archer');
    const defeatTick = 40;
    // The engine records each step it applies; the queued death reads the last one.
    recordNpcStep(warbander, defeatTick - lastStep);

    recordNpcLethalTransition(warbander, defeatTick, 'hit-queue');

    expect(warbander.death).toMatchObject({ killTick: defeatTick, processTick: defeatTick + 1 });
    expect(warbander.deathAnimationTick).toBe(defeatTick + deathAfter);
  });
});
