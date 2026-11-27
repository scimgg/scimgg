import { describe, expect, it } from 'vitest';
import type { EncounterContext, EquipmentClickSlot } from '../../../core/encounters/types';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { CHAT_HIGHLIGHT_COLORS } from '../../../core/events/gameMessages';
import { TickEvents } from '../../../core/events/TickEvents';
import { isCoreEvent } from '../../../core/events/types';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { createSolAttackState, launchSolAttack, takeSolTripleHit } from '../../../npcs/colosseum/attackScheduler';
import {
  BEAM_CRYSTAL_ACTOR_PREFIX,
  BEAM_CRYSTAL_NPC_ID,
  COLOSSEUM_SEQS,
  COLOSSEUM_SPOTANIMS,
  SOL_ACTOR_ID,
  TRIPLE_HIT_OFFSETS_SHORT,
} from '../../../npcs/colosseum/constants';
import { crystalDefinition } from '../../../npcs/colosseum/crystal';
import {
  GRAPPLE_TARGETS,
  GRAPPLE_WRONG_SLOT_MESSAGE,
  grappleDefendedMessage,
  grappleWarningMessage,
} from '../../../npcs/colosseum/grapple';
import { launchSolIfReady, solDefinition } from '../../../npcs/colosseum/sol';
import { createEncounterActorOps } from '../../../test/helpers/encounterActorOps';
import { runEncounterNpcActions } from '../../../test/helpers/encounterNpcBand';
import { createUnusedPlayerControlOps } from '../../../test/helpers/playerControlStubs';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import {
  ENRAGE_SAND_INTERVAL_TICKS,
  SAND_DAMAGE_ONSET_TICKS,
  SAND_POOL_DELAY_TICKS,
  SOL_BEAM_PREPARED_EVENT,
  SOL_DEATH_SAND_REMOVAL_DELAY_TICKS,
  SOL_FIRST_ATTACK_TICK,
} from '../constants';
import { solVictoryTaunt } from '../phases';
import { SOL_HEREDIT_RENDER_CONFIG } from '../renderConfig';
import { SolHereditEncounter } from '../SolHereditEncounter';

/**
 * Checks for behavior that is easy to get wrong. Each asserts the behavior the evidence requires,
 * so a future change that breaks it fails here rather than in a player's fight.
 */

function setup(seed = 7) {
  const encounter = new SolHereditEncounter(seed);
  const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
  const world = engine['worldState'];
  const sol = world.getNpcs().find((npc) => npc.id === SOL_ACTOR_ID);
  if (!sol || !solDefinition.isActor(sol)) throw new Error('Sol did not spawn');
  const context: EncounterContext = {
    tick: engine.getState().currentTick,
    playerPos: engine.getState().playerPosition,
    world,
    tickEvents: new TickEvents(),
    logEvent: () => {},
    grantNextAttackSpeedup: () => {},
    ...createEncounterActorOps(world),
    ...createUnusedPlayerControlOps(),
  };
  return { encounter, engine, world, sol, context };
}

/** Adjacent to Sol's spawn footprint, so he can attack without moving. */
const IN_REACH: Coordinate = [33, 35];

/** Queues the grapple command with his attacks off and plays to the slot it launches on. */
function forceGrapple(
  engine: SimulationEngine,
  sol: ReturnType<typeof setup>['sol'],
  player: { position: Coordinate },
) {
  engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false });
  player.position = [...IN_REACH];
  engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'trigger-grapple' });
  while (!sol.state.grapple.pending && engine.getState().currentTick < 30) engine.advanceTick(player.position);
  const pending = sol.state.grapple.pending;
  if (!pending) throw new Error('expected a grapple');
  return pending;
}

const rolls =
  (...values: number[]) =>
  () =>
    values[Math.min(values.length - 1, 0)] ?? 0.5;

describe('Sol launch presentation', () => {
  it('launches a forced grapple on his next ready slot with its delayed clip, even with his attacks off', () => {
    const { engine, sol, world } = setup(7);
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false });
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.position = [...IN_REACH];
    const command = { encounter: 'sol_heredit', type: 'trigger-grapple' } as const;

    expect(engine.executeEncounterCommand(command)).toBe(true);
    // Queued, not started: nothing shows until his first attack slot.
    expect(sol.state.grapple.pending).toBeNull();
    while (engine.getState().currentTick < SOL_FIRST_ATTACK_TICK) {
      expect(sol.state.grapple.pending).toBeNull();
      engine.advanceTick(player.position);
    }

    const start = SOL_FIRST_ATTACK_TICK;
    const snapshot = engine.getState().encounter;
    if (snapshot.kind !== 'sol_heredit') throw new Error('wrong snapshot');
    expect(snapshot.state.grapple?.resolveTick).toBe(start + 4);
    const pending = sol.state.grapple.pending;
    const events = engine.getLastTickEvents();
    if (!pending) throw new Error('expected a grapple');
    expect(pending.startTick).toBe(start);
    // The forced spear opener is still owed once his attacks come back on.
    expect(sol.state.scheduler).toMatchObject({ forcedSpecial: null, forceSpearNext: true, nextAttackTick: start + 7 });
    const [before, part, after] = pending.target.taunt.split(new RegExp(`(${pending.target.bodyPart})`));
    // Captured markup: <col=ff0000>I'LL CUT YOUR <col=ffffff>FEET<col=FF0000> OFF! (K:3468).
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'overhead_text',
        tick: start,
        overheadText: pending.target.taunt,
        overheadTextColor: '#ff0000',
        overheadTextSegments: [{ text: before }, { text: part, color: '#ffffff' }, { text: after }],
      }),
    );
    expect(events.filter(isEncounterVisualEvent)).toEqual([
      expect.objectContaining({
        tick: start,
        animations: [{ actorId: SOL_ACTOR_ID, clipId: 'grapple', delayCycles: 30 }],
        graphics: [],
      }),
    ]);

    // A repeat while one is in flight queues the next slot rather than restarting this one.
    engine.executeEncounterCommand(command);
    expect(sol.state.grapple.pending).toBe(pending);
    for (let tick = start + 1; tick <= start + 6; tick++) {
      engine.advanceTick(player.position);
      expect(engine.getLastTickEvents().filter(isEncounterVisualEvent)).toEqual([]);
      if (tick < start + 4) expect(sol.state.grapple.pending).toBe(pending);
      else expect(sol.state.grapple.pending).toBeNull();
    }
    engine.advanceTick(player.position);
    expect(sol.state.grapple.pending?.startTick).toBe(start + 7);
    expect(engine.getDamageHistory().filter((damage) => damage.source !== 'SolGrapple')).toEqual([]);
  });

  it('retains target tracking when a regular attack records its launch geometry', () => {
    const { sol, context, world } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.position = [sol.position[0] + 2, sol.position[1] - 1];

    launchSolIfReady(sol, { ...context, tick: 20 }, { phase: 0, random: () => 0.5, enabled: true });

    expect(sol.actionFacing).toBeUndefined();
    expect(sol.state.scheduler.pendingGround?.resolveTick).toBe(23);
    expect(sol.combat.targetId).toBe(player.id);
  });

  it('delays only the grapple clip by one tick when the taunt starts', () => {
    const { sol, context, world } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.position = [sol.position[0] + 2, sol.position[1] - 1];
    // The special roll hits, then the type roll picks the grapple.
    const random = [0.01, 0.01, 0.5];
    sol.state.scheduler.forceSpearNext = false; // Test a non-opener grapple.

    const taunt = launchSolIfReady(
      sol,
      { ...context, tick: 20 },
      { phase: 2, random: () => random.shift() ?? 0.5, enabled: true },
    );

    expect(taunt).toBeTruthy();
    expect(context.tickEvents.flush().filter(isEncounterVisualEvent)[0]?.animations).toEqual([
      { actorId: sol.id, clipId: 'grapple', delayCycles: 30 },
    ]);
  });

  it.each([
    { phase: 1, spotAnimId: 2668, clipId: 'tripleShort' },
    { phase: 3, spotAnimId: 2667, clipId: 'triple' },
  ] as const)('attaches warning $spotAnimId to Sol for phase $phase', ({ phase, spotAnimId, clipId }) => {
    const { sol, context, world } = setup();
    sol.state.scheduler.forceSpearNext = false; // Test a non-opener triple.
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.position = [sol.position[0] + 2, sol.position[1] - 1];

    // The special roll hits; below 75% the type roll then picks the triple over the grapple.
    const random = [0.01, 0.9];
    launchSolIfReady(sol, { ...context, tick: 20 }, { phase, random: () => random.shift() ?? 0.5, enabled: true });

    expect(context.tickEvents.flush().filter(isEncounterVisualEvent)[0]).toMatchObject({
      animations: [{ actorId: sol.id, clipId, delayCycles: 0 }],
      graphics: [{ spotAnimId, target: { kind: 'attached', actorId: sol.id }, delayCycles: 0, height: 0 }],
    });
  });
});

describe('molten sand after Sol dies', () => {
  it('says the taunt and removes crystals at death+1, despawns the pools through death+1 and removes them at death+2, suppresses hazards immediately, and completes at death+9', () => {
    const { encounter, engine, sol, world, context } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false });
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'spawn-crystal' });
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'strike-sand' });
    while (engine.getState().currentTick < 7) engine.advanceTick(engine.getState().playerPosition);
    const before = engine.getState().encounter;
    if (before.kind !== 'sol_heredit') throw new Error('wrong snapshot');
    expect(before.state.beamTiles.length).toBeGreaterThan(0); // Beam would fire at tick 8.
    expect(before.state.sandTiles.length).toBeGreaterThan(0);
    const pool = before.state.sandTiles[0];
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.position = [...pool];
    sol.vitals.hp = 0;
    sol.alive = false;
    const deathTick = 7;
    encounter.onNpcDefeated({ npcId: sol.id, tick: deathTick }, { ...context, tick: deathTick }, 'encounter-owned');

    for (let tick = deathTick; tick <= deathTick + 9; tick++) {
      const ctx = { ...context, tick, playerPos: [...pool] as Coordinate };
      expect(runEncounterNpcActions(encounter, ctx, {}).environmentalDamages).toEqual([]);
      expect(encounter.resolveHazards(ctx, {})).toEqual([]);
      expect(encounter.processPostTick(ctx)).toEqual([]);
      const snapshot = engine.getState().encounter;
      if (snapshot.kind !== 'sol_heredit') throw new Error('wrong snapshot');
      expect(snapshot.state.crystalCount).toBe(tick === deathTick ? 1 : 0);
      // Pool LOCs play their despawn on D and D+1 and are replaced at D+2 (K/M/N/L, 4/4).
      const poolsShown = tick < deathTick + SOL_DEATH_SAND_REMOVAL_DELAY_TICKS;
      expect(snapshot.state.sandTiles).toEqual(poolsShown ? before.state.sandTiles : []);
      expect(snapshot.state.sandDespawning).toBe(poolsShown);
      expect(context.tickEvents.flush().filter((event) => event.type === 'overhead_text')).toEqual(
        tick === deathTick + 1 ? [expect.objectContaining({ overheadText: solVictoryTaunt(7) })] : [],
      );
      expect(encounter.getOutcome()).toMatchObject({
        phase: tick < deathTick + 9 ? 'resolving' : 'victory',
        decisiveTick: deathTick,
        completionTick: deathTick + 9,
      });
    }
  });

  it('plays every crystal despawn on the death tick and removes them at death+1 (K:4221/4222, M, N, L)', () => {
    const { encounter, engine, sol, world, context } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false });
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'spawn-crystal' });
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'spawn-crystal' });
    while (engine.getState().currentTick < 5) engine.advanceTick(engine.getState().playerPosition);
    const crystalIds = () =>
      world
        .getNpcs()
        .filter(crystalDefinition.isActor)
        .map((crystal) => crystal.id);
    const ids = crystalIds();
    expect(ids).toHaveLength(2);
    sol.vitals.hp = 0;
    sol.alive = false;
    const deathTick = 5;
    context.tickEvents.flush();
    encounter.onNpcDefeated({ npcId: sol.id, tick: deathTick }, { ...context, tick: deathTick }, 'encounter-owned');
    const despawns = context.tickEvents.flush().filter(isEncounterVisualEvent);
    expect(despawns.flatMap((event) => event.animations)).toEqual(
      ids.map((actorId) => ({ actorId, clipId: 'despawn', delayCycles: 0 })),
    );
    // The clip exists for the crystal, so the renderer plays it rather than dropping the cue.
    const crystalType = SOL_HEREDIT_RENDER_CONFIG.preloadNpcTypes?.find(
      (type) => type.npcTypeId === BEAM_CRYSTAL_NPC_ID,
    );
    expect(crystalType?.attackClips?.despawn).toBe(COLOSSEUM_SEQS.crystal.despawn);
    runEncounterNpcActions(encounter, { ...context, tick: deathTick }, {});
    expect(crystalIds()).toEqual(ids);
    runEncounterNpcActions(encounter, { ...context, tick: deathTick + 1 }, {});
    expect(crystalIds()).toEqual([]);
  });

  it('forms no pool from a strike due on the death tick or later (K:4216/4219, M:8510, N:7776/7779)', () => {
    const { encounter, engine, sol, context } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false, solHereditBeams: false });
    // Commands strike on the current tick.
    const strikeTick = engine.getState().currentTick;
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'strike-sand' });
    engine.advanceTick(engine.getState().playerPosition);
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'strike-sand' });
    // The engine forms a pool before resolving the killing hit, so the first strike's pool appears on
    // the death tick itself; the death must take it back, and the later strike must never form.
    const deathTick = strikeTick + SAND_POOL_DELAY_TICKS;
    while (engine.getState().currentTick < deathTick) engine.advanceTick(engine.getState().playerPosition);
    const poolsAt = () => {
      const snapshot = engine.getState().encounter;
      if (snapshot.kind !== 'sol_heredit') throw new Error('wrong snapshot');
      return snapshot.state.sandTiles;
    };
    expect(poolsAt().length).toBeGreaterThan(0);
    sol.vitals.hp = 0;
    sol.alive = false;
    encounter.onNpcDefeated({ npcId: sol.id, tick: deathTick }, { ...context, tick: deathTick }, 'encounter-owned');
    expect(poolsAt()).toEqual([]);
    for (let tick = 0; tick < 4; tick++) {
      engine.advanceTick(engine.getState().playerPosition);
      expect(poolsAt()).toEqual([]);
    }
  });

  it('stops burning the player once he is out of HP', () => {
    const { encounter, engine, sol, context } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true });
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'strike-sand' });
    for (let tick = 0; tick < 8; tick++) engine.advanceTick(engine.getState().playerPosition);

    const snapshot = engine.getState().encounter;
    if (snapshot?.kind !== 'sol_heredit') throw new Error('wrong snapshot');
    expect(snapshot.state.sandTiles.length).toBeGreaterThan(0);

    sol.vitals.hp = 0;
    sol.alive = false;
    // Pools animate out at D+1/D+2, so nothing may burn through the nine-tick victory delay.
    for (let tick = 0; tick < 12; tick++) {
      const damages = encounter.resolveHazards(
        { ...context, tick: engine.getState().currentTick + tick, playerPos: engine.getState().playerPosition },
        {},
      );
      expect(damages).toEqual([]);
    }
  });
});

describe('triple attack protection timing', () => {
  it('is NOT blocked by a Protect from Melee held from before the hit', () => {
    const { encounter, world, sol, context } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.activePrayer = PrayerType.ProtectMelee;
    player.prayerState.prayerActivationTicks[PrayerType.ProtectMelee] = 0;
    sol.state.scheduler.forceSpearNext = false;

    launchSolAttack(sol.state.scheduler, {
      tick: 10,
      phase: 2,
      random: rolls(0.01),
      grappleAvailable: false,
    });

    const hitTick = 10 + TRIPLE_HIT_OFFSETS_SHORT[0];
    const damages = encounter
      .getNpcDefinitions()
      .resolveLocalEffects(sol, { ...context, tick: hitTick, random: () => 0 });
    // Wiki: the overhead must go up ON the landing tick; one held from earlier does not protect.
    expect(damages.some((damage) => damage.source === 'SolTripleAttack')).toBe(true);
  });

  it('is blocked when the overhead goes up on the landing tick', () => {
    const { encounter, world, sol, context } = setup();
    sol.state.scheduler.forceSpearNext = false;
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    launchSolAttack(sol.state.scheduler, {
      tick: 10,
      phase: 2,
      random: rolls(0.01),
      grappleAvailable: false,
    });

    const hitTick = 10 + TRIPLE_HIT_OFFSETS_SHORT[0];
    player.activePrayer = PrayerType.ProtectMelee;
    player.prayerState.prayerActivationTicks[PrayerType.ProtectMelee] = hitTick;
    const damages = encounter
      .getNpcDefinitions()
      .resolveLocalEffects(sol, { ...context, tick: hitTick, random: () => 0 });
    expect(damages).toEqual([
      { source: 'SolTripleAttack', baseDamage: 0, attackType: 'typeless', playerPosition: [...player.position] },
    ]);
    expect(damages[0]).not.toHaveProperty('disablesProtectionPrayersForTicks');
  });
});

describe('triple hit consumption', () => {
  function launchTriple() {
    const state = createSolAttackState(0);
    state.forceSpearNext = false;
    launchSolAttack(state, {
      tick: 10,
      phase: 2,
      random: rolls(0.01),
      grappleAvailable: false,
    });
    return state;
  }

  it('lands each hit once even if the tick is polled twice', () => {
    const state = launchTriple();
    const tick = 10 + TRIPLE_HIT_OFFSETS_SHORT[0];
    expect(takeSolTripleHit(state, tick)).not.toBeNull();
    expect(takeSolTripleHit(state, tick)).toBeNull();
    // The later hits survive the double poll.
    expect(takeSolTripleHit(state, 10 + TRIPLE_HIT_OFFSETS_SHORT[1])).not.toBeNull();
    expect(takeSolTripleHit(state, 10 + TRIPLE_HIT_OFFSETS_SHORT[2])).not.toBeNull();
  });

  it('publishes the unresolved hit ticks so presentation need not re-derive them', () => {
    const state = launchTriple();
    const pendingTicks = () => state.pendingTriple.map((hit) => hit.tick);
    expect(pendingTicks()).toEqual(TRIPLE_HIT_OFFSETS_SHORT.map((offset) => 10 + offset));
    takeSolTripleHit(state, 10 + TRIPLE_HIT_OFFSETS_SHORT[0]);
    expect(pendingTicks()).toEqual([10 + TRIPLE_HIT_OFFSETS_SHORT[1], 10 + TRIPLE_HIT_OFFSETS_SHORT[2]]);
  });
});

describe('beam crystals when the mechanic is toggled off', () => {
  function runCrystal(beamsOnAt: (tick: number) => boolean) {
    const { engine, world } = setup();
    const configure = (beams: boolean) =>
      engine.setMechanicsConfig({
        infiniteHealth: true,
        solHereditAttacks: false,
        solHereditSand: false,
        solHereditBeams: beams,
      });
    configure(beamsOnAt(0));
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'spawn-crystal' });
    const crystal = world.getNpcs().find(crystalDefinition.isActor);
    if (!crystal) throw new Error('no crystal');
    const log: string[] = [];
    const steps: number[] = [];
    for (let tick = 1; tick <= 32; tick++) {
      configure(beamsOnAt(tick));
      const before = `${crystal.position}`;
      engine.advanceTick(engine.getState().playerPosition);
      for (const event of engine.getLastTickEvents()) {
        if (event.type === SOL_BEAM_PREPARED_EVENT) log.push(`warn@${tick}`);
        if (!isEncounterVisualEvent(event)) continue;
        for (const { clipId } of event.animations)
          if (clipId === 'charge' || clipId === 'attack') log.push(`${clipId}@${tick}`);
      }
      if (`${crystal.position}` !== before) steps.push(tick);
    }
    return { log, steps };
  }

  it('warns afresh before charging when switched back on, and never charges unannounced', () => {
    // Sol's attacks are off here, so a ready round warns at once. Beams go off mid-charge at 6
    // and back on at 12.
    const { log, steps } = runCrystal((tick) => tick < 6 || tick >= 12);
    expect(log).toEqual(['warn@1', 'charge@4', 'warn@12', 'charge@15', 'attack@19']);
    // Released while off: the abandoned round's fire tick (8) resumes the patrol, every two ticks.
    expect(steps.filter((tick) => tick >= 6 && tick < 12)).toEqual([8, 10]);
  });

  it('leaves the patrol untouched while switched off, even across a scheduled warning', () => {
    const { log, steps } = runCrystal(() => false);
    expect(log).toEqual([]);
    expect(steps.filter((tick) => tick <= 15)).toEqual([3, 5, 7, 9, 11, 13, 15]);
  });
});

describe('beam damage debug tiles', () => {
  it('publishes the fired round on its fire tick; the hit lands one tick later', () => {
    const { engine, world } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false, solHereditSand: false });
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'spawn-crystal' });
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    const fired = new Map<number, string>();
    let charging: Coordinate[] = [];
    let lastCharging: Coordinate[] = [];
    for (let tick = 1; tick <= 12; tick++) {
      engine.advanceTick(player.position);
      const snapshot = engine.getState().encounter;
      if (snapshot.kind !== 'sol_heredit') throw new Error('wrong snapshot');
      if (snapshot.state.beamTiles.length > 0 && charging.length === 0) {
        // Stand on the charging line so the fire tick's damage lands too.
        charging = [...snapshot.state.beamTiles];
        player.position = [...charging[0]];
      }
      if (snapshot.state.beamTiles.length > 0) lastCharging = [...snapshot.state.beamTiles];
      fired.set(tick, JSON.stringify(snapshot.state.beamFiredTiles));
    }
    const fireTicks = [...fired].filter(([, tiles]) => tiles !== '[]').map(([tick]) => tick);
    expect(fireTicks).toHaveLength(1);
    const [fireTick] = fireTicks;
    expect(JSON.parse(fired.get(fireTick) ?? '[]')).toEqual(lastCharging);
    expect(
      engine
        .getDamageHistory()
        .filter((hit) => hit.source === 'SolLightBeam')
        .map((hit) => hit.tick),
    ).toEqual([fireTick + 1]);
  });
});

describe('grapple on an empty equipment slot', () => {
  // Wiki: the grapple is used even on an empty slot, "and will therefore be unable to defend".
  it.each([1, 2, 3, 4])('cannot defend an empty target slot clicked at T+%i', (offset) => {
    const { engine, world, sol } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.equipment = {};

    const pending = forceGrapple(engine, sol, player);
    const resolveTick = pending.startTick + 4;
    while (engine.getState().currentTick < pending.startTick + offset - 1) engine.advanceTick(player.position);
    // The click is still swallowed so it can never become an unequip.
    expect(engine.acceptsEncounterInput({ kind: 'equipmentSlotClick', slot: pending.target.slot })).toBe(true);
    engine.applyAction({ type: 'equipmentSlotClick', slot: pending.target.slot });
    while (engine.getState().currentTick < resolveTick) engine.advanceTick(player.position);
    expect(engine.getDamageHistory().filter((damage) => damage.source === 'SolGrapple')).toEqual([
      expect.objectContaining({ tick: resolveTick }),
    ]);
    expect(sol.state.guaranteedMaxHitUntilTick).toBeNull();
    expect(player.equipment).toEqual({});
  });

  it('lets a correct click after an empty-slot click defend at once', () => {
    const { engine, world, sol } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.equipment = { body: 11832, cape: 6570, hands: 7462, legs: 11834, boots: 11840 };

    const pending = forceGrapple(engine, sol, player);
    engine.applyAction({ type: 'equipmentSlotClick', slot: 'head' });
    engine.applyAction({ type: 'equipmentSlotClick', slot: pending.target.slot });
    engine.advanceTick(player.position);
    expect(pending.defendedTick).toBe(pending.startTick + 1);
    expect(sol.state.grapple.pending).toBeNull();
    while (engine.getState().currentTick < pending.startTick + 4) engine.advanceTick(player.position);
    expect(engine.getDamageHistory().filter((damage) => damage.source === 'SolGrapple')).toEqual([]);
    expect(sol.state.guaranteedMaxHitUntilTick).toBeNull();
  });
});

describe('grapple equipment click consumption', () => {
  it.each([false, true])('swallows every slot and repeat click without unequipping (empty gear: %s)', (empty) => {
    const { engine, world, sol } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.equipment = empty ? {} : { weapon: 4151, body: 11832, cape: 6570, boots: 11840 };
    const equipment = { ...player.equipment };
    const inventory = structuredClone(engine.getState().inventory);
    const supplies = structuredClone(engine.getCombatSupplies());
    const pending = forceGrapple(engine, sol, player);
    const start = pending.startTick;
    // Every slot but the target is wrong. None of them defends or unequips, so the grapple still hits.
    const slots = (
      [
        'weapon',
        'head',
        'cape',
        'amulet',
        'ammo',
        'quiver-ammo',
        'body',
        'shield',
        'legs',
        'hands',
        'boots',
        'ring',
      ] as const satisfies readonly EquipmentClickSlot[]
    ).filter((slot) => slot !== pending.target.slot);
    for (let tick = 1; tick <= 4; tick++) {
      for (const slot of slots) {
        expect(engine.acceptsEncounterInput({ kind: 'equipmentSlotClick', slot })).toBe(true);
        engine.applyAction({ type: 'equipmentSlotClick', slot });
      }
      engine.advanceTick(player.position);
      expect(player.equipment).toEqual(equipment);
      expect(engine.getState().inventory).toEqual(inventory);
      expect(engine.getCombatSupplies()).toEqual(supplies);
      if (tick < 4) expect(sol.state.grapple.pending?.defendedTick).toBeNull();
    }
    expect(engine.getDamageHistory().filter((damage) => damage.source === 'SolGrapple')).toEqual([
      expect.objectContaining({ tick: start + 4, effectiveDamage: expect.any(Number) }),
    ]);
    expect(sol.state.guaranteedMaxHitUntilTick).toBeNull();
    expect(engine.acceptsEncounterInput({ kind: 'equipmentSlotClick', slot: pending.target.slot })).toBe(false);
  });

  it('still perfectly parries on the last tick after wrong clicks on earlier ticks', () => {
    const { engine, world, sol } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.equipment = { weapon: 4151, body: 11832, cape: 6570, hands: 7462, legs: 11834, boots: 11840 };
    const pending = forceGrapple(engine, sol, player);
    for (let tick = 1; tick <= 3; tick++) {
      engine.applyAction({ type: 'equipmentSlotClick', slot: 'weapon' });
      engine.advanceTick(player.position);
      expect(sol.state.grapple.pending).toBe(pending);
    }
    engine.applyAction({ type: 'equipmentSlotClick', slot: pending.target.slot });
    engine.advanceTick(player.position);
    expect(engine.getState().currentTick).toBe(pending.startTick + 4);
    expect(sol.state.grapple.pending).toBeNull();
    expect(engine.getDamageHistory().filter((damage) => damage.source === 'SolGrapple')).toEqual([]);
    expect(sol.state.guaranteedMaxHitUntilTick).not.toBeNull();
  });
});

describe('grapple chat messages', () => {
  const FULL_GEAR = { weapon: 4151, body: 11832, cape: 6570, hands: 7462, legs: 11834, boots: 11840 };
  const chat = (engine: SimulationEngine) =>
    engine.getLastTickEvents().filter((event) => isCoreEvent(event, 'game_message'));

  it('sends the grapple warning as a game message on the tick it shows overhead (L:4698)', () => {
    const { engine, world, sol } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    const pending = forceGrapple(engine, sol, player);
    expect(chat(engine)).toEqual([
      expect.objectContaining({
        tick: pending.startTick,
        kind: 'game',
        segments: grappleWarningMessage(pending.target),
      }),
    ]);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({ type: 'overhead_text', tick: pending.startTick, overheadText: pending.target.taunt }),
    );
  });

  it('sends the wrong-part line before the early defense line on the same tick (L:4701)', () => {
    const { engine, world, sol } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.equipment = { ...FULL_GEAR };
    const pending = forceGrapple(engine, sol, player);
    engine.applyAction({ type: 'equipmentSlotClick', slot: 'weapon' });
    engine.applyAction({ type: 'equipmentSlotClick', slot: pending.target.slot });
    engine.advanceTick(player.position);
    expect(chat(engine)).toEqual([
      expect.objectContaining({ tick: pending.startTick + 1, kind: 'game', segments: GRAPPLE_WRONG_SLOT_MESSAGE }),
      expect.objectContaining({
        tick: pending.startTick + 1,
        kind: 'game',
        segments: grappleDefendedMessage(pending.target),
      }),
    ]);
  });

  it('words the early defense with the body part in title case, as captured for Hands', () => {
    const hands = GRAPPLE_TARGETS.find((target) => target.slot === 'hands');
    if (!hands) throw new Error('no hands target');
    expect(grappleDefendedMessage(hands)).toEqual([
      {
        text: "You successfully defend your Hands from Sol Heredit's grapple!",
        color: CHAT_HIGHLIGHT_COLORS.green,
      },
    ]);
  });

  it('sends a wrong-part line per wrong click, then the perfect parry line on the closing tick (L:4858)', () => {
    const { engine, world, sol } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.equipment = { ...FULL_GEAR };
    const pending = forceGrapple(engine, sol, player);
    engine.applyAction({ type: 'equipmentSlotClick', slot: 'weapon' });
    engine.applyAction({ type: 'equipmentSlotClick', slot: 'weapon' });
    // An empty slot holds nothing to defend with, so its click says nothing.
    engine.applyAction({ type: 'equipmentSlotClick', slot: 'head' });
    engine.advanceTick(player.position);
    expect(chat(engine).map((event) => event.segments)).toEqual([
      GRAPPLE_WRONG_SLOT_MESSAGE,
      GRAPPLE_WRONG_SLOT_MESSAGE,
    ]);
    for (let tick = 2; tick <= 3; tick++) {
      engine.advanceTick(player.position);
      expect(chat(engine)).toEqual([]);
    }
    engine.applyAction({ type: 'equipmentSlotClick', slot: pending.target.slot });
    engine.advanceTick(player.position);
    expect(chat(engine)).toEqual([
      expect.objectContaining({
        tick: pending.startTick + 4,
        kind: 'game',
        segments: [{ text: "You perfectly parry Sol Heredit's grapple!", color: CHAT_HIGHLIGHT_COLORS.green }],
      }),
    ]);
  });

  it('sends no outcome line for a failed grapple, since none is captured', () => {
    const { engine, world, sol } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.equipment = { ...FULL_GEAR };
    const pending = forceGrapple(engine, sol, player);
    while (engine.getState().currentTick < pending.startTick + 4) {
      engine.advanceTick(player.position);
      expect(chat(engine)).toEqual([]);
    }
    expect(engine.getDamageHistory().filter((damage) => damage.source === 'SolGrapple')).toHaveLength(1);
  });
});

describe('named HP presets', () => {
  it('re-arms the spear opener when entering a training preset', () => {
    const { engine, sol } = setup();
    sol.state.scheduler.forceSpearNext = false;
    engine.applyBossHpPreset(150);
    expect(sol.state.scheduler.forceSpearNext).toBe(true);
    expect(
      launchSolAttack(sol.state.scheduler, { tick: 7, phase: 5, random: () => 0, grappleAvailable: true }),
    ).toMatchObject({ kind: 'regular', style: 'spear', variant: 1 });
  });

  it('rebuilds the phase floor, so the same preset always lands on the same state', () => {
    const { engine, sol } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false });
    const floorState = () => {
      const snapshot = engine.getState().encounter;
      if (snapshot?.kind !== 'sol_heredit') throw new Error('wrong snapshot');
      const { phase, crystalCount, sandTiles, beamTiles, grapple, tripleHitTicks } = snapshot.state;
      return { phase, crystalCount, sandTiles, beamTiles, grapple, tripleHitTicks };
    };
    const sandObservationTicks = ENRAGE_SAND_INTERVAL_TICKS * 3 + SAND_POOL_DELAY_TICKS;

    engine.applyBossHpPreset(150);
    const presetFloor = floorState();
    expect(presetFloor).toEqual({
      phase: 5,
      crystalCount: 4,
      sandTiles: [],
      beamTiles: [],
      grapple: null,
      tripleHitTicks: [],
    });
    for (let tick = 0; tick < sandObservationTicks; tick++) engine.advanceTick(engine.getState().playerPosition);
    expect(floorState().sandTiles.length).toBeGreaterThan(0);

    engine.applyBossHpPreset(150);
    expect(floorState()).toEqual(presetFloor);
    for (let tick = 0; tick < sandObservationTicks; tick++) engine.advanceTick(engine.getState().playerPosition);
    expect(floorState().sandTiles.length).toBeGreaterThan(0);

    engine.applyBossHpPreset(sol.vitals.maxHp);
    const fullHpFloor = { ...presetFloor, phase: 0, crystalCount: 0 };
    expect(floorState()).toEqual(fullHpFloor);
    for (let tick = 0; tick < sandObservationTicks; tick++) {
      engine.advanceTick(engine.getState().playerPosition);
      expect(floorState()).toEqual(fullHpFloor);
    }
  });
});

describe('external completion ownership', () => {
  it('cleans up but leaves the outcome to the owner', () => {
    const { encounter, engine, world, sol, context } = setup();
    engine.applyBossHpPreset(150);
    expect(world.getNpcs().filter(crystalDefinition.isActor)).toHaveLength(4);
    sol.alive = false;
    encounter.onNpcDefeated({ npcId: SOL_ACTOR_ID, tick: 10 }, { ...context, tick: 10 }, 'external-owned');
    expect(encounter.getOutcome().phase).toBe('active');
    expect(world.getNpcs().filter(crystalDefinition.isActor)).toHaveLength(4);
    runEncounterNpcActions(encounter, { ...context, tick: 11 }, {});
    expect(encounter.getOutcome().phase).toBe('active');
    // Delayed cleanup still happens with external ownership.
    expect(world.getNpcs().filter(crystalDefinition.isActor)).toHaveLength(0);
    expect(world.getNpcs().filter((npc) => npc.id.startsWith(BEAM_CRYSTAL_ACTOR_PREFIX))).toEqual([]);
  });
});

describe('Sol regeneration', () => {
  it('heals 1 HP at control+101 and every 100 ticks after, as in all three captures', () => {
    const { engine, sol } = setup();
    engine.setMechanicsConfig({
      infiniteHealth: true,
      solHereditAttacks: false,
      solHereditSand: false,
      solHereditBeams: false,
    });
    sol.vitals.hp = 1400;
    const hpAt = new Map<number, number>();
    while (engine.getState().currentTick < 201) {
      engine.advanceTick(engine.getState().playerPosition);
      hpAt.set(engine.getState().currentTick, sol.vitals.hp);
    }
    expect([100, 101, 200, 201].map((tick) => hpAt.get(tick))).toEqual([1400, 1401, 1401, 1402]);
  });
});

describe('enraged sand drip', () => {
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('starts 6-8 ticks after entering enrage, then every 3 (seed %i)', (seed) => {
    const { engine, world } = setup(seed);
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false, solHereditBeams: false });
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    // Arena center with no pools: every drip roll lands on a free in-arena tile, so each fires visibly.
    player.position = [32, 34];
    engine.applyBossHpPreset(150);
    const start = engine.getState().currentTick;
    const strikes: number[] = [];
    for (let tick = 0; tick < 16; tick++) {
      engine.advanceTick([32, 34]);
      const struck = engine
        .getLastTickEvents()
        .filter(isEncounterVisualEvent)
        .some((event) => event.graphics.some((cue) => cue.spotAnimId === COLOSSEUM_SPOTANIMS.sunfireLightning));
      if (struck) strikes.push(engine.getState().currentTick);
    }
    // K +7, M +8, N +6 after the enrage burst (analysis section 3).
    expect(strikes[0] - start).toBeGreaterThanOrEqual(6);
    expect(strikes[0] - start).toBeLessThanOrEqual(8);
    for (const tick of strikes) expect((tick - strikes[0]) % ENRAGE_SAND_INTERVAL_TICKS).toBe(0);
  });
});

describe('phase transitions wait for the attack slot', () => {
  it.each([
    { previousHp: 1500, hp: 1350, values: [0] },
    { previousHp: 1350, hp: 1125, values: [0.5, 0] },
  ])('forces a spear after the $hp HP transition even when rolls select a special', ({ previousHp, hp, values }) => {
    const { encounter, sol, world, context } = setup();
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.position = [sol.position[0] + 2, sol.position[1] - 1];
    encounter.syncBossHp(previousHp, { world });
    encounter['random'] = () => values.shift() ?? 0;
    sol.state.scheduler.forceSpearNext = false;
    sol.state.scheduler.memory = { lastAction: 'spear', lastVariant: 1 };
    sol.state.scheduler.nextAttackTick = 10;
    // Far enough past a special that any roll below 0.5 would pick another.
    sol.state.scheduler.regularsSinceSpecial = 9;
    sol.vitals.hp = hp;
    const mechanics = { solHereditSand: false, solHereditBeams: false };
    const regulars = sol.state.scheduler.regularsSinceSpecial;
    runEncounterNpcActions(encounter, { ...context, tick: 10 }, mechanics);
    expect(sol.state.scheduler.forceSpearNext).toBe(true);
    expect(sol.state.scheduler.pendingGround).toBeNull();
    runEncounterNpcActions(encounter, { ...context, tick: 17 }, mechanics);
    expect(sol.state.scheduler.pendingGround).toMatchObject({ style: 'spear', variant: 2, resolveTick: 20 });
    expect(sol.state.scheduler.forceSpearNext).toBe(false);
    expect(sol.state.scheduler.regularsSinceSpecial).toBe(regulars + 1);
    expect(sol.state.scheduler.pendingTriple).toEqual([]);
    expect(sol.state.grapple.pending).toBeNull();
  });

  it('lets the attack in flight land, then taunts on the next slot instead of attacking', () => {
    const { engine, sol, world } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditBeams: false });
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    // Stand in reach until Sol telegraphs his first attack.
    const inReach: Coordinate = [33, 35];
    let telegraph = -1;
    while (telegraph < 0) {
      engine.advanceTick(inReach);
      if (sol.state.scheduler.pendingGround) telegraph = engine.getState().currentTick;
    }
    const slot = sol.state.scheduler.nextAttackTick;
    const landing = sol.state.scheduler.pendingGround?.resolveTick;
    sol.vitals.hp = 1349; // below 90% one tick after the telegraph, like K:4102 / N:7626
    const taunts: number[] = [];
    const landed: number[] = [];
    const sand: number[] = [];
    for (let tick = telegraph + 1; tick <= slot + 1; tick++) {
      engine.advanceTick(inReach);
      const events = engine.getLastTickEvents();
      if (events.some((event) => event.type === 'overhead_text')) taunts.push(tick);
      for (const event of events.filter(isEncounterVisualEvent)) {
        if (event.graphics.some((cue) => COLOSSEUM_SPOTANIMS.solMelee.includes(cue.spotAnimId as never)))
          landed.push(tick);
        if (event.graphics.some((cue) => cue.spotAnimId === COLOSSEUM_SPOTANIMS.sunfireLightning)) sand.push(tick);
      }
    }
    expect(landed).toEqual([landing]);
    expect(taunts).toEqual([slot]);
    expect(sand).toEqual([slot + 1]);
    expect(sol.state.scheduler.pendingGround).toBeNull();
    expect(sol.state.scheduler.nextAttackTick).toBe(slot + 7);
  });
});

describe('failed triple hit prayer lockout', () => {
  it('clears prayer activated on H-1 immediately and lands the full hit at H (A:5186–5187)', () => {
    const { engine, sol } = setup();
    engine.setMechanicsConfig({ solHereditAttacks: false, solHereditBeams: false, solHereditSand: false });
    sol.state.scheduler.pendingTriple = [{ tick: 3, damage: 15, index: 0 }];
    const position = engine.getState().playerPosition;
    engine.advanceTick(position);
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(position);
    expect(engine.activePrayer).toBeNull();
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({
        type: 'prayer_changed',
        from: PrayerType.ProtectMelee,
        to: null,
        tick: 2,
      }),
    );
    engine.advanceTick(position);
    expect(engine.getDamageHistory()).toEqual([
      expect.objectContaining({ tick: 3, source: 'SolTripleAttack', baseDamage: 15, effectiveDamage: 15 }),
    ]);
  });

  it('sends the eager prayer line with the H-1 drop and the injured line for a refused retry (L:5149–5150)', () => {
    const { engine, sol } = setup();
    engine.setMechanicsConfig({
      infiniteHealth: true,
      solHereditAttacks: false,
      solHereditBeams: false,
      solHereditSand: false,
    });
    sol.state.scheduler.pendingTriple = [{ tick: 3, damage: 35, index: 2 }];
    const position = engine.getState().playerPosition;
    // His entry line and opening taunt fall in this window too; only the prayer lines are under test.
    const chat = () =>
      engine
        .getLastTickEvents()
        .filter((event) => isCoreEvent(event, 'game_message'))
        .filter((event) => event.tick > 1 && event.kind !== 'public');
    engine.advanceTick(position);
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(position);
    expect(chat()).toEqual([
      expect.objectContaining({
        tick: 2,
        kind: 'spam',
        segments: [{ text: "Sol Heredit doesn't take kindly to your eager prayer.", color: CHAT_HIGHLIGHT_COLORS.red }],
      }),
    ]);
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(position);
    expect(engine.activePrayer).toBeNull();
    expect(chat()).toEqual([
      expect.objectContaining({
        tick: 3,
        kind: 'game',
        segments: [{ text: "You've been injured and can't use that prayer!" }],
      }),
    ]);
  });

  it.each([
    { phase: 2, ticks: [3, 6, 9], damage: [15, 25, 35] },
    { phase: 3, ticks: [3, 6, 10], damage: [15, 30, 45] },
  ] as const)('retains fixed unprayed triple damage in phase $phase, not random rolls', ({ phase, ticks, damage }) => {
    const { engine, sol } = setup();
    engine.setMechanicsConfig({ solHereditAttacks: false, solHereditBeams: false, solHereditSand: false });
    sol.state.scheduler = createSolAttackState(0);
    sol.state.scheduler.forceSpearNext = false;
    launchSolAttack(sol.state.scheduler, { tick: 0, phase, random: () => 0.01, grappleAvailable: false });
    while (engine.getState().currentTick < ticks.at(-1)!) engine.advanceTick(engine.getState().playerPosition);
    const hits = engine.getDamageHistory().filter((hit) => hit.source === 'SolTripleAttack');
    expect(hits.map((hit) => hit.tick)).toEqual(ticks);
    expect(hits.map((hit) => hit.baseDamage)).toEqual(damage);
  });

  /** Sol launches a short triple at tick 10 with the player adjacent and Protect from Melee held. */
  function heldPrayerTriple() {
    const { engine, sol, world } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditBeams: false, solHereditSand: false });
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    const inReach: Coordinate = [33, 35];
    sol.state.scheduler = createSolAttackState(Number.POSITIVE_INFINITY);
    sol.state.scheduler.forceSpearNext = false;
    launchSolAttack(sol.state.scheduler, { tick: 10, phase: 2, random: rolls(0.01), grappleAvailable: false });
    while (engine.getState().currentTick < 9) engine.advanceTick(inReach);
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(inReach);
    return { engine, player, inReach, hitTick: 10 + TRIPLE_HIT_OFFSETS_SHORT[0] };
  }

  it('drops held prayer on H-1 and refuses it again until the following hit has landed', () => {
    const { engine, inReach, hitTick } = heldPrayerTriple();
    const [first, second, third] = TRIPLE_HIT_OFFSETS_SHORT.map((offset) => 10 + offset);
    expect(hitTick).toBe(first);
    expect(engine.activePrayer).toBe(PrayerType.ProtectMelee);
    while (engine.getState().currentTick < first - 1) engine.advanceTick(inReach);
    expect(engine.activePrayer).toBeNull();

    // Every retry from H through the next hit is refused, so hit 2 cannot be saved.
    while (engine.getState().currentTick < second) {
      engine.queueProtectionPrayer(PrayerType.ProtectMelee);
      engine.advanceTick(inReach);
      expect(engine.activePrayer).toBeNull();
    }
    const triple = () => engine.getDamageHistory().filter((damage) => damage.source === 'SolTripleAttack');
    expect(triple().map((damage) => [damage.tick, damage.effectiveDamage])).toEqual([
      [first, 15],
      [second, 25],
    ]);

    // Released after the following hit: an on-time flick blocks hit 3 (A:5186 dropped, A:5193 blocked).
    while (engine.getState().currentTick < third - 1) engine.advanceTick(inReach);
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(inReach);
    expect(triple().at(-1)).toEqual(expect.objectContaining({ tick: third, effectiveDamage: 0 }));
  });

  it('after a dropped prayer on the last hit, refuses H and allows prayer on H+1 (A:5247–5249)', () => {
    const { engine, sol } = setup();
    engine.setMechanicsConfig({
      infiniteHealth: true,
      solHereditAttacks: false,
      solHereditBeams: false,
      solHereditSand: false,
    });
    sol.state.scheduler.pendingTriple = [{ tick: 3, damage: 35, index: 2 }];
    const position = engine.getState().playerPosition;
    engine.advanceTick(position);
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(position);
    expect(engine.activePrayer).toBeNull();
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(position);
    expect(engine.activePrayer).toBeNull();
    expect(engine.getDamageHistory()).toContainEqual(
      expect.objectContaining({ tick: 3, source: 'SolTripleAttack', effectiveDamage: 35 }),
    );
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(position);
    expect(engine.activePrayer).toBe(PrayerType.ProtectMelee);
  });

  it('practice command queues a triple for his next attack slot, even at full HP', () => {
    const { engine, sol } = setup();
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditBeams: false, solHereditSand: false });
    const inReach: Coordinate = [33, 35];
    expect(engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'trigger-triple' })).toBe(true);
    let launchTick: number | null = null;
    while (engine.getState().currentTick < 60 && launchTick === null) {
      engine.advanceTick(inReach);
      if (sol.state.scheduler.pendingTriple.length === 3) launchTick = engine.getState().currentTick;
    }
    if (launchTick === null) throw new Error('no triple launched');
    // The opening spear still comes first; the triple takes the slot after it.
    expect(engine.getDamageHistory().some((damage) => damage.source === 'SolSpear')).toBe(true);
    expect(sol.state.scheduler.forcedSpecial).toBeNull();
    while (engine.getState().currentTick < launchTick + TRIPLE_HIT_OFFSETS_SHORT.at(-1)!) engine.advanceTick(inReach);
    expect(
      engine
        .getDamageHistory()
        .filter((damage) => damage.source === 'SolTripleAttack')
        .map((damage) => [damage.tick - launchTick!, damage.baseDamage]),
    ).toEqual(TRIPLE_HIT_OFFSETS_SHORT.map((offset, index) => [offset, [15, 25, 35][index]]));
  });

  it('adds no extended lockout when the player simply misses the flick', () => {
    const { engine, sol } = setup();
    engine.setMechanicsConfig({
      infiniteHealth: true,
      solHereditAttacks: false,
      solHereditBeams: false,
      solHereditSand: false,
    });
    sol.state.scheduler.pendingTriple = [
      { tick: 3, damage: 15, index: 0 },
      { tick: 6, damage: 25, index: 1 },
    ];
    const position = engine.getState().playerPosition;
    while (engine.getState().currentTick < 5) engine.advanceTick(position);
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(position);
    expect(engine.getDamageHistory().filter((damage) => damage.source === 'SolTripleAttack')).toEqual([
      expect.objectContaining({ tick: 3, effectiveDamage: 15 }),
      expect.objectContaining({ tick: 6, effectiveDamage: 0 }),
    ]);
  });

  it('leaves a correctly timed flick alone', () => {
    const { engine, player, inReach, hitTick } = heldPrayerTriple();
    engine.setMechanicsConfig({ infiniteHealth: false });
    player.powerOfDeathUntilTick = 100;
    const hp = player.vitals.hp;
    engine.queueProtectionPrayer(null);
    while (engine.getState().currentTick < hitTick - 1) engine.advanceTick(inReach);
    engine.queueProtectionPrayer(PrayerType.ProtectMelee);
    engine.advanceTick(inReach);
    expect(engine.getDamageHistory().filter((damage) => damage.source === 'SolTripleAttack')).toEqual([
      expect.objectContaining({ tick: hitTick, baseDamage: 0, effectiveDamage: 0 }),
    ]);
    expect(engine.getLastTickEvents()).toContainEqual(
      expect.objectContaining({ type: 'hitsplat_spawned', targetId: 'player', amount: 0, hitsplatType: 'block' }),
    );
    expect(engine.activePrayer).toBe(PrayerType.ProtectMelee);
    expect(player.vitals.hp).toBe(hp);
    expect(player.powerOfDeathUntilTick).toBe(100);
    engine.queueProtectionPrayer(PrayerType.ProtectMagic);
    engine.advanceTick(inReach);
    expect(engine.activePrayer).toBe(PrayerType.ProtectMagic);
  });
});

describe('practice controls', () => {
  type Setup = ReturnType<typeof setup>;
  const solHits = (engine: SimulationEngine) =>
    engine.getDamageHistory().filter((damage) => damage.source.startsWith('Sol') && damage.source !== 'SolMoltenSand');
  const landedGround = (engine: SimulationEngine) =>
    engine
      .getLastTickEvents()
      .filter(isEncounterVisualEvent)
      .some((event) => event.graphics.some((cue) => COLOSSEUM_SPOTANIMS.solMelee.includes(cue.spotAnimId as never)));
  function inReach({ engine, world }: Setup, mechanics: Parameters<SimulationEngine['setMechanicsConfig']>[0]) {
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditBeams: false, solHereditSand: false, ...mechanics });
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.position = [...IN_REACH];
    const advance = () => engine.advanceTick(player.position);
    return { player, advance };
  }

  it('queues a forced grapple behind the attack in flight instead of overlapping it', () => {
    const fight = setup();
    const { engine, sol } = fight;
    const { advance } = inReach(fight, {});
    while (!sol.state.scheduler.pendingGround) advance();
    const telegraph = engine.getState().currentTick;
    const landing = sol.state.scheduler.pendingGround?.resolveTick;
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'trigger-grapple' });
    const landed: number[] = [];
    while (!sol.state.grapple.pending) {
      advance();
      if (landedGround(engine)) landed.push(engine.getState().currentTick);
    }
    expect(landed).toEqual([landing]);
    // The opening spear's cooldown, not the command, decides when the grapple starts.
    expect(sol.state.grapple.pending.startTick).toBe(telegraph + 7);
    expect(sol.state.scheduler).toMatchObject({ pendingGround: null, forcedSpecial: null, regularsSinceSpecial: 0 });
  });

  it('keeps only the latest forced special when the commands are repeated', () => {
    const fight = setup();
    const { engine, sol } = fight;
    const { advance } = inReach(fight, { solHereditAttacks: false });
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'trigger-grapple' });
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'trigger-triple' });
    while (engine.getState().currentTick < SOL_FIRST_ATTACK_TICK) advance();
    expect(sol.state.scheduler.pendingTriple).toHaveLength(3);
    expect(sol.state.grapple.pending).toBeNull();
    expect(sol.state.scheduler.forcedSpecial).toBeNull();
  });

  it.each([
    false,
    true,
  ])('lands every forced triple hit with his attacks switched off, blockable on time (flicked: %s)', (flick) => {
    const fight = setup();
    const { engine, sol } = fight;
    const { advance } = inReach(fight, {});
    advance();
    // Switched off before the command, so the cancel on the way off cannot touch it.
    engine.setMechanicsConfig({ ...engine.getMechanicsConfig(), solHereditAttacks: false });
    advance();
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'trigger-triple' });
    while (sol.state.scheduler.pendingTriple.length === 0) advance();
    const launch = engine.getState().currentTick;
    for (const offset of TRIPLE_HIT_OFFSETS_SHORT) {
      while (engine.getState().currentTick < launch + offset - 1) advance();
      if (flick) engine.queueProtectionPrayer(PrayerType.ProtectMelee);
      advance();
      if (flick) engine.queueProtectionPrayer(null);
    }
    expect(solHits(engine).map((hit) => [hit.tick - launch, hit.source, hit.effectiveDamage])).toEqual(
      TRIPLE_HIT_OFFSETS_SHORT.map((offset, index) => [offset, 'SolTripleAttack', flick ? 0 : [15, 25, 35][index]]),
    );
    // Nothing but the forced special launches while his attacks are off.
    for (let tick = 0; tick < 30; tick++) advance();
    expect(solHits(engine)).toHaveLength(3);
    expect(sol.state.scheduler.pendingGround).toBeNull();
  });

  it.each(['spear', 'shield'] as const)('pins his regular attacks to %s from the next launch, live', (pin) => {
    const fight = setup();
    const { engine, sol } = fight;
    const { advance } = inReach(fight, {});
    const styles: string[] = [];
    engine.setMechanicsConfig({ ...engine.getMechanicsConfig(), solHereditAttackStyle: pin });
    while (engine.getState().currentTick < 60) {
      advance();
      const pending = sol.state.scheduler.pendingGround;
      if (pending?.resolveTick === engine.getState().currentTick + 3) styles.push(pending.style);
    }
    // Every regular follows the pin, including the forced opener spear.
    expect(styles.length).toBeGreaterThan(5);
    expect(styles).toEqual(styles.map(() => pin));
  });

  it('cancels a telegraphed attack when Sol Attacks is switched off, so it never lands', () => {
    const fight = setup();
    const { engine, sol } = fight;
    const { advance } = inReach(fight, {});
    while (!sol.state.scheduler.pendingGround) advance();
    const landing = sol.state.scheduler.pendingGround?.resolveTick ?? 0;
    engine.setMechanicsConfig({ ...engine.getMechanicsConfig(), solHereditAttacks: false });
    while (engine.getState().currentTick <= landing + 10) {
      advance();
      expect(landedGround(engine)).toBe(false);
    }
    expect(sol.state.scheduler.pendingGround).toBeNull();
    expect(solHits(engine)).toEqual([]);
  });

  it.each(['triple', 'grapple'] as const)('cancels a %s in flight when Sol Attacks is switched off', (kind) => {
    const fight = setup();
    const { engine, sol } = fight;
    const { advance } = inReach(fight, {});
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: `trigger-${kind}` });
    while (sol.state.scheduler.pendingTriple.length === 0 && !sol.state.grapple.pending) advance();
    const launch = engine.getState().currentTick;
    advance();
    engine.setMechanicsConfig({ ...engine.getMechanicsConfig(), solHereditAttacks: false });
    for (let tick = 0; tick < 15; tick++) advance();
    expect(sol.state.grapple.pending).toBeNull();
    expect(sol.state.scheduler.pendingTriple).toEqual([]);
    // Only the opening spear, before the special, may have landed.
    expect(solHits(engine).filter((hit) => hit.tick > launch)).toEqual([]);
  });

  describe('molten sand switched off', () => {
    /** A 90% transition with his attacks off: taunt at 5, a sand batch underfoot at 6. */
    function transitionRun(sandOnAt: (tick: number) => boolean) {
      const { engine, encounter, sol } = setup();
      const configure = (tick: number) =>
        engine.setMechanicsConfig({
          infiniteHealth: true,
          solHereditAttacks: false,
          solHereditBeams: false,
          solHereditSand: sandOnAt(tick),
        });
      configure(0);
      sol.vitals.hp = 1349;
      const strikes: number[] = [];
      const pools: string[] = [];
      for (let tick = 1; tick <= 20; tick++) {
        configure(tick);
        engine.advanceTick(engine.getState().playerPosition);
        const struck = engine
          .getLastTickEvents()
          .filter(isEncounterVisualEvent)
          .some((event) => event.graphics.some((cue) => cue.spotAnimId === COLOSSEUM_SPOTANIMS.sunfireLightning));
        if (struck) strikes.push(tick);
        const snapshot = engine.getState().encounter;
        if (snapshot.kind !== 'sol_heredit') throw new Error('wrong snapshot');
        pools.push(JSON.stringify(snapshot.state.sandTiles));
      }
      const burns = engine
        .getDamageHistory()
        .filter((hit) => hit.source === 'SolMoltenSand')
        .map((hit) => hit.tick);
      return { strikes, pools, burns, nextRoll: encounter['random']() };
    }

    it('keeps forming pools out of sight and shows and burns them again once switched back on', () => {
      const always = transitionRun(() => true);
      const hidden = transitionRun((tick) => tick < 4 || tick >= 15);
      expect(always.strikes).toEqual([6]);
      expect(hidden.strikes).toEqual([]);
      expect(hidden.pools.slice(3, 14).every((tiles) => tiles === '[]')).toBe(true);
      expect(hidden.pools.slice(14)).toEqual(always.pools.slice(14));
      expect(JSON.parse(hidden.pools[14]).length).toBeGreaterThan(0);
      expect(always.burns[0]).toBe(6 + SAND_DAMAGE_ONSET_TICKS);
      expect(hidden.burns).toEqual(always.burns.filter((tick) => tick >= 15));
      expect(hidden.burns.length).toBeGreaterThan(0);
      // The hidden batch drew the same rolls, so the seeded stream is unchanged.
      expect(hidden.nextRoll).toBe(always.nextRoll);
    });
  });

  describe('raw boss HP into enrage', () => {
    function rawHp() {
      const fight = setup();
      const { engine, encounter, world } = fight;
      engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false, solHereditBeams: false });
      const player = world.getPlayer();
      if (!player) throw new Error('no player');
      player.position = [32, 34];
      const advance = (ticks: number) => {
        const strikes: number[] = [];
        for (let tick = 0; tick < ticks; tick++) {
          engine.advanceTick([32, 34]);
          const struck = engine
            .getLastTickEvents()
            .filter(isEncounterVisualEvent)
            .some((event) => event.graphics.some((cue) => cue.spotAnimId === COLOSSEUM_SPOTANIMS.sunfireLightning));
          if (struck) strikes.push(engine.getState().currentTick);
        }
        return strikes;
      };
      const armedAt = (): number | null => encounter['nextEnrageSandTick'];
      return { engine, advance, armedAt };
    }

    it('starts the drip 6-8 ticks after the raw HP set, stops it on leaving and re-arms on re-entry', () => {
      const { engine, advance, armedAt } = rawHp();
      advance(2);
      for (let entry = 0; entry < 2; entry++) {
        const start = engine.getState().currentTick;
        engine.setBossHp(150);
        expect(armedAt()).toBeGreaterThanOrEqual(start + 6);
        expect(armedAt()).toBeLessThanOrEqual(start + 8);
        const strikes = advance(12);
        expect(strikes[0] - start).toBeGreaterThanOrEqual(6);
        expect(strikes[0] - start).toBeLessThanOrEqual(8);
        engine.setBossHp(1500);
        expect(armedAt()).toBeNull();
        expect(advance(12)).toEqual([]);
      }
    });

    it('rolls the first-drip delay once for a preset, whether or not Sol was already enraged', () => {
      const draws = (alreadyEnraged: boolean) => {
        const fight = setup();
        const { engine, encounter } = fight;
        engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false, solHereditBeams: false });
        if (alreadyEnraged) engine.setBossHp(150);
        engine.advanceTick(engine.getState().playerPosition);
        const random: () => number = encounter['random'];
        let count = 0;
        encounter['random'] = () => {
          count++;
          return random();
        };
        const start = engine.getState().currentTick;
        engine.applyBossHpPreset(150);
        const armed: number | null = encounter['nextEnrageSandTick'];
        expect(armed).toBeGreaterThanOrEqual(start + 6);
        expect(armed).toBeLessThanOrEqual(start + 8);
        return count;
      };
      expect(draws(false)).toBe(draws(true));
    });

    it('keeps the running drip when the HP moves within enrage', () => {
      const { engine, advance, armedAt } = rawHp();
      engine.setBossHp(150);
      advance(3);
      const armed = armedAt();
      engine.setBossHp(100);
      expect(armedAt()).toBe(armed);
    });
  });
});
