import { afterEach, describe, expect, it } from 'vitest';
import { isNpcTargetable, type NpcActor } from '../../../core/actors/NpcActor';
import {
  clearResolvedArenaConfigs,
  getArenaAllowUnboundedFallback,
  getArenaConfig,
  isInTileSpace,
  setArenaConfig,
  setResolvedArenaConfig,
} from '../../../core/constants';
import { VENOM_THRESHOLD } from '../../../core/poison';
import { SimulationEngine } from '../../../core/SimulationEngine';
import type { WorldState } from '../../../core/WorldState';
import { isInfernoVisualEvent } from '../../../npcs/inferno/visualEvents';
import {
  PLAYER_STUNNED_SPOTANIM_ID,
  SNAKELING,
  SNAKELING_MAGIC_NPC_ID,
  SNAKELING_MELEE_NPC_ID,
  ZULRAH_CLOUD,
  ZULRAH_CLOUD_LOC_ID,
  ZULRAH_NPC_ID_BY_FORM,
  ZULRAH_SNAKELING_ORB_SPOTANIM_ID,
  ZULRAH_TAIL,
} from '../../../npcs/zulrah/constants';
import { snakelingDefinition } from '../../../npcs/zulrah/snakeling';
import { getZulrahState, isInTailArea, isTailSafeTile, zulrahDefinition } from '../../../npcs/zulrah/zulrah';
import { getBoundsFromRegion } from '../../../rs/collision/WalkabilityAnalyzer';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { createEmptyStats } from '../../../types/equipmentStats';
import { parseInventoryFromSetup } from '../../../types/inventory';
import { type Coordinate, type MechanicsConfig, PrayerType } from '../../../types/simulation';
import { pickCloudSites, ZULRAH_CLOUD_FILL_ORDER, ZULRAH_CLOUD_SITES } from '../clouds';
import {
  ZULRAH_OPENING_PAUSE_TICKS,
  ZULRAH_OPENING_RISE_TICKS,
  ZULRAH_ROTATION_NUMBERS,
  ZULRAH_ROTATIONS,
  ZULRAH_SPOTS,
  ZULRAH_SURFACE_PAUSE_TICKS,
  ZULRAH_UNDERWATER_TICKS,
} from '../rotation';
import { ZULRAH_ACTOR_ID, ZULRAH_PLAYER_START, ZulrahEncounter } from '../ZulrahEncounter';
import { ZulrahSceneObjectController } from '../ZulrahSceneObjectController';
import {
  ZULRAH_CAPTURE_EMERGE_FACING_TILE,
  ZULRAH_CAPTURE_EXTRA_PHASE,
  ZULRAH_CAPTURE_FIRST_ATTACKABLE,
  ZULRAH_CAPTURE_OPENING,
  ZULRAH_CAPTURE_TAIL_STUN,
} from './fixtures/zulrahCapture';

type Run = {
  readonly engine: SimulationEngine;
  readonly encounter: ZulrahEncounter;
  readonly world: WorldState;
  readonly zulrah: () => NpcActor | undefined;
  readonly tick: () => void;
};

/** A run pinned to rotation 1 unless `mechanics` says otherwise, so phase indexes are fixed. */
function startRun(seed = 1, mechanics: Partial<MechanicsConfig> = {}): Run {
  const encounter = new ZulrahEncounter(seed);
  const engine = new SimulationEngine({ encounter, startPos: [...ZULRAH_PLAYER_START] as Coordinate });
  engine.setMechanicsConfig({ infiniteHealth: true, zulrahAttacks: true, zulrahRotation: '1', ...mechanics });
  const world = engine['worldState'] as WorldState;
  return {
    engine,
    encounter,
    world,
    zulrah: () => world.getNpcs().find((npc) => zulrahDefinition.isActor(npc) && npc.alive),
    tick: () => engine.advanceTick([...ZULRAH_PLAYER_START] as Coordinate),
  };
}

function stateOf(run: Run) {
  const snapshot = run.engine.getEncounterSnapshot();
  if (snapshot.kind !== 'zulrah') throw new Error(`Expected a Zulrah snapshot, got ${snapshot.kind}`);
  return snapshot.state;
}

function phaseIndexOf(run: Run): number {
  return stateOf(run).phaseIndex;
}

/** OSRS angle from a footprint's center to a tile's center, as Zulrah computes its facing. */
function bearing(from: Pick<NpcActor, 'position' | 'size'>, tile: readonly number[]): number {
  const dx = (tile[0] ?? 0) + 0.5 - (from.position[0] + from.size / 2);
  const dy = (tile[1] ?? 0) + 0.5 - (from.position[1] + from.size / 2);
  return (Math.round((Math.atan2(-dx, -dy) * 1024) / Math.PI) + 2048) % 2048;
}

/** Advances until the snapshot reports `phaseIndex` (or gives up). */
function runToPhase(run: Run, phaseIndex: number, limit = 2000): void {
  for (let i = 0; i < limit; i++) {
    if (phaseIndexOf(run) === phaseIndex) return;
    run.tick();
  }
  throw new Error(`Never reached phase ${phaseIndex}`);
}

describe('ZulrahEncounter', () => {
  it('opens as serpentine in the middle with full HP', () => {
    const run = startRun();
    const zulrah = run.zulrah();
    expect(zulrah?.npcTypeId).toBe(ZULRAH_NPC_ID_BY_FORM.serpentine);
    expect(zulrah?.position).toEqual(ZULRAH_SPOTS.middle);
    expect(zulrah?.vitals).toEqual({ hp: 500, maxHp: 500 });
  });

  it("leaves capture 3's extra blue middle phase out of rotation 4's table, as one observation", () => {
    const { barrages, attacks, styles } = ZULRAH_CAPTURE_EXTRA_PHASE;
    expect(ZULRAH_ROTATIONS[4][3]).toMatchObject({ form: 'tanzanite', spot: 'west' });
    expect(ZULRAH_ROTATIONS[4][4]).toMatchObject({ form: 'magma', spot: 'middle' });
    expect(
      ZULRAH_ROTATIONS[4].some((p) => p.form === 'tanzanite' && p.spot === 'middle' && p.attacks === attacks.length),
    ).toBe(false);
    expect([barrages.length, styles.length]).toEqual([3, attacks.length]);
  });

  it.each(ZULRAH_ROTATION_NUMBERS)('walks rotation %i in order, each form at its spot, then wraps to phase 2', (n) => {
    const run = startRun(1, { zulrahRotation: String(n) });
    const table = ZULRAH_ROTATIONS[n];
    // Through the whole rotation, then one past it: the last phase is the next rotation's phase 1.
    for (let index = 1; index <= table.length; index++) {
      runToPhase(run, index, 4000);
      const expected = index < table.length ? index : 1;
      const phase = table[expected];
      const zulrah = run.zulrah();
      expect(stateOf(run).rotation, `global phase ${index}`).toBe(n);
      expect(stateOf(run).phaseInRotation, `global phase ${index}`).toBe(expected + 1);
      expect(zulrah?.npcTypeId, `phase ${index}`).toBe(ZULRAH_NPC_ID_BY_FORM[phase.form]);
      expect(zulrah?.position, `phase ${index}`).toEqual(ZULRAH_SPOTS[phase.spot]);
      // Only one Zulrah is ever up.
      expect(run.world.getNpcs().filter((npc) => npc.alive && zulrahDefinition.isActor(npc))).toHaveLength(1);
    }
  });

  it('leaves the rotation open during the shared opening phase', () => {
    const run = startRun(1, { zulrahRotation: 'random' });
    expect(stateOf(run).rotation).toBeNull();
    expect(stateOf(run).phaseInRotation).toBe(1);
  });

  it('picks rotations at random, the same way for the same seed', () => {
    const firstRotation = (seed: number) => {
      const run = startRun(seed, { zulrahRotation: 'random' });
      runToPhase(run, 1);
      return stateOf(run).rotation;
    };
    const picks = Array.from({ length: 24 }, (_, seed) => firstRotation(seed + 100));
    expect(new Set(picks)).toEqual(new Set([1, 2, 3, 4]));
    expect(firstRotation(103)).toBe(picks[3]);
  });

  it('holds the first attack for the leading snakelings (rotation 4, phase 2)', () => {
    const run = startRun(1, { zulrahRotation: '4' });
    runToPhase(run, 1);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const surfaced = run.world.tick;
    while (zulrah.combat.lastAttackTick === null) run.tick();
    // The surface pause, then 4 snakeling orbs of 3 ticks each before the first of its 6 attacks.
    expect(zulrah.combat.lastAttackTick - surfaced).toBe(ZULRAH_SURFACE_PAUSE_TICKS + 4 * 3);
  });

  it('surfaces, pauses, then makes each listed attack 3 ticks apart', () => {
    // Timing is built from fixed pieces, not fitted to a total: the surface pause after the emerge,
    // then one turn every 3 ticks (Zulrah's attack speed) for each listed attack and venom barrage.
    const run = startRun(1);
    runToPhase(run, 3); // Rotation 1 phase 4: south, green, 5 ranged.
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const surfaced = zulrah.spawnTick ?? 0;
    const attackTicks: number[] = [];
    while (phaseIndexOf(run) === 3) {
      run.tick();
      if (zulrah.combat.lastAttackTick === run.world.tick) attackTicks.push(run.world.tick);
    }
    expect(attackTicks[0]).toBe(surfaced + ZULRAH_SURFACE_PAUSE_TICKS);
    expect(attackTicks.slice(1).map((tick, i) => tick - (attackTicks[i] ?? 0))).toEqual([3, 3, 3, 3]);
  });

  it('hides Zulrah underwater for ZULRAH_UNDERWATER_TICKS between forms', () => {
    const run = startRun(1);
    runToPhase(run, 1);
    let empty = 0;
    while (phaseIndexOf(run) === 1) {
      run.tick();
      if (stateOf(run).stage === 'submerged') {
        empty += 1;
        // Still in the world, but not drawn and not targetable.
        expect(run.zulrah()?.hidden).toBe(true);
        expect((run.zulrah()?.targetableFromTick ?? 0) > run.world.tick).toBe(true);
      }
    }
    expect(empty).toBe(ZULRAH_UNDERWATER_TICKS);
  });

  it('carries damage across a form change: one actor, transformed', () => {
    const run = startRun();
    run.tick();
    const first = run.zulrah();
    if (!first) throw new Error('No Zulrah');
    first.vitals.hp = 321;
    runToPhase(run, 1);
    const second = run.zulrah();
    expect(second).toBe(first);
    expect(second?.npcTypeId).toBe(ZULRAH_NPC_ID_BY_FORM.magma);
    expect(second?.vitals.hp).toBe(321);
  });

  it('surfaces on the captured bearing after a form change, then tracks the player from its first attack', () => {
    const run = startRun();
    runToPhase(run, 3); // Rotation 1 phase 4 opens on its attacks.
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    expect(zulrah.actionFacing).toBe(bearing(zulrah, ZULRAH_CAPTURE_EMERGE_FACING_TILE));
    while (zulrah.combat.lastAttackTick === null) run.tick();
    expect(zulrah.actionFacing).toBeUndefined();
    expect(zulrah.combat.targetId).toBe('player');
  });

  it('rises on the first tick without waiting for the player to act', () => {
    const encounter = new ZulrahEncounter(1);
    const engine = new SimulationEngine({ encounter, startPos: [...ZULRAH_PLAYER_START] as Coordinate });
    engine.setMechanicsConfig({ infiniteHealth: true, zulrahRotation: '1' });
    const world = engine['worldState'] as WorldState;
    const zulrah = () => world.getNpcs().find((npc) => zulrahDefinition.isActor(npc));
    engine.advanceTick([...ZULRAH_PLAYER_START] as Coordinate);
    expect(zulrah()?.hidden).toBe(false);
    expect(zulrah()?.spawnTick).toBe(world.tick);
    expect(zulrah()?.combat.targetId).toBeNull();
  });

  it('waits ZULRAH_OPENING_PAUSE_TICKS after its rise before the first barrage', () => {
    const run = startRun(1);
    run.tick();
    const risen = run.zulrah()?.spawnTick ?? 0;
    const clouds = () => {
      const snapshot = run.engine.getEncounterSnapshot();
      return snapshot.kind === 'zulrah' ? snapshot.visuals.clouds : [];
    };
    while (stateOf(run).phaseIndex === 0 && clouds().length === 0) run.tick();
    const firstLand = Math.min(...clouds().map((cloud) => cloud.landTick));
    // The spit comes at rise + pause; its clouds land ZULRAH_CLOUD.flightTicks later.
    expect(firstLand - ZULRAH_CLOUD.flightTicks - risen).toBe(ZULRAH_OPENING_RISE_TICKS + ZULRAH_OPENING_PAUSE_TICKS);
  });

  it('makes every listed attack in a ranged phase, all ranged', () => {
    const run = startRun();
    runToPhase(run, 3); // South serpentine: 5 ranged.
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const styles: string[] = [];
    while (phaseIndexOf(run) === 3) {
      run.tick();
      if (zulrah.combat.lastAttackTick === run.world.tick) styles.push(zulrah.combat.attackStyle);
    }
    expect(styles).toEqual(['range', 'range', 'range', 'range', 'range']);
  });

  it('alternates ranged and magic through the jad phase, opening on ranged', () => {
    const run = startRun();
    runToPhase(run, 8);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    expect(getZulrahState(zulrah)?.mode).toBe('jad');
    const styles: string[] = [];
    while (phaseIndexOf(run) === 8) {
      run.tick();
      if (zulrah.combat.lastAttackTick === run.world.tick) styles.push(zulrah.combat.attackStyle);
    }
    expect(styles).toEqual(Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? 'range' : 'magic')));
  });

  it('is untargetable while emerging', () => {
    const run = startRun();
    const zulrah = run.zulrah();
    expect(zulrah?.targetableFromTick).toBeGreaterThan(run.world.tick);
  });

  it('never attacks with attacks turned off, yet still rotates', () => {
    const run = startRun(1, { zulrahAttacks: false });
    runToPhase(run, 4);
    const zulrah = run.zulrah();
    expect(zulrah?.combat.lastAttackTick ?? null).toBeNull();
  });

  it('replays tanzanite style choices from the same seed', () => {
    const styles = (seed: number) => {
      const run = startRun(seed);
      runToPhase(run, 2); // Middle tanzanite: 4 mixed.
      const zulrah = run.zulrah();
      if (!zulrah) throw new Error('No Zulrah');
      const picked: string[] = [];
      while (phaseIndexOf(run) === 2) {
        run.tick();
        if (zulrah.combat.lastAttackTick === run.world.tick) picked.push(zulrah.combat.attackStyle);
      }
      return picked;
    };
    const a = styles(42);
    expect(a).toHaveLength(4);
    expect(styles(42)).toEqual(a);
  });

  it('reports its seed and rebuilds from it', () => {
    const encounter = new ZulrahEncounter(7);
    expect(encounter.getSeeds()).toEqual({ encounterSeed: 7 });
    encounter.reset({ encounterSeed: 9 });
    expect(encounter.getSeeds()).toEqual({ encounterSeed: 9 });
  });
});

describe('Zulrah damage cap', () => {
  /** Lands one player hit of `damage` on the current Zulrah and returns the HP it took. */
  function landHit(run: Run, damage: number, hp = 500): number {
    runToPhase(run, 3); // A targetable serpentine phase with time to spare.
    while (!run.zulrah()?.targetableFromTick || (run.zulrah()?.targetableFromTick ?? 0) > run.world.tick) run.tick();
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    zulrah.vitals.hp = hp;
    enqueueEnginePendingHit(run.engine, {
      sourceId: 'player',
      targetId: zulrah.id,
      style: 'melee',
      attackKind: 'melee_stab',
      launchTick: run.world.tick,
      impactTick: run.world.tick + 1,
      rolledDamage: damage,
      accuracySucceeded: true,
    });
    run.tick();
    run.tick();
    return hp - zulrah.vitals.hp;
  }

  it('leaves hits of 50 or less alone', () => {
    expect(landHit(startRun(3), 50)).toBe(50);
    expect(landHit(startRun(3), 12)).toBe(12);
  });

  it('replaces every hit over 50 with 45-50', () => {
    const taken = Array.from({ length: 20 }, (_, seed) => landHit(startRun(seed + 10), 77));
    for (const damage of taken) {
      expect(damage).toBeGreaterThanOrEqual(45);
      expect(damage).toBeLessThanOrEqual(50);
    }
    // A real draw, not a constant.
    expect(new Set(taken).size).toBeGreaterThan(1);
  });

  it('still never deals more than the HP left', () => {
    expect(landHit(startRun(4), 90, 20)).toBe(20);
  });
});

describe('Zulrah magma tail', () => {
  const MAGMA_PHASE = 1; // Rotation 1 phase 2: middle, magma, 2 tails.
  const playerHp = (run: Run) => run.world.getPlayer()?.vitals.hp ?? 0;

  /** Ticks (standing still) until the magma Zulrah starts a stare; returns its pending tail. */
  function runToStare(run: Run) {
    runToPhase(run, MAGMA_PHASE);
    for (let i = 0; i < 100; i++) {
      const zulrah = run.zulrah();
      const pending = zulrah ? getZulrahState(zulrah)?.pendingTail : null;
      if (pending) return pending;
      run.tick();
    }
    throw new Error('Magma never stared');
  }

  /** As `runToStare`, for the phase's second and last tail, whose stun no later slam extends. */
  function runToLastStare(run: Run) {
    const first = runToStare(run);
    for (let i = 0; i < 100; i++) {
      run.tick();
      const zulrah = run.zulrah();
      const pending = zulrah ? getZulrahState(zulrah)?.pendingTail : null;
      if (pending && pending !== first) return pending;
    }
    throw new Error('Magma never stared twice');
  }

  it('locks the tile the player stood on and lands ZULRAH_TAIL.stareTicks later', () => {
    const run = startRun(5, { infiniteHealth: false, zulrahClouds: false });
    const pending = runToStare(run);
    expect(pending.target).toEqual(ZULRAH_PLAYER_START);
    expect(pending.landTick - run.world.tick).toBe(ZULRAH_TAIL.stareTicks);
  });

  it('hits a player who stays for 20-30 and stuns them', () => {
    const run = startRun(5, { infiniteHealth: false, zulrahClouds: false });
    const pending = runToStare(run);
    const before = playerHp(run);
    while (run.world.tick < pending.landTick) run.tick();
    run.tick(); // The hit lands through the damage queue.
    const taken = before - playerHp(run);
    expect(taken).toBeGreaterThanOrEqual(20);
    expect(taken).toBeLessThanOrEqual(30);

    // Stunned: a click elsewhere is dropped, so the player stays put.
    const stuckAt = [...(run.world.getPlayer()?.position ?? [0, 0])];
    run.engine.advanceTick([stuckAt[0] + 4, stuckAt[1]] as Coordinate);
    expect(run.engine.wasLastTickStunned()).toBe(true);
    expect(run.world.getPlayer()?.position).toEqual(stuckAt);
  });

  it('lets a stunned player pray but not move or attack, and shows the stun graphic', () => {
    const run = startRun(5, { infiniteHealth: false, zulrahClouds: false });
    const pending = runToStare(run);
    let sawGraphic = false;
    while (run.world.tick <= pending.landTick) {
      run.tick();
      sawGraphic ||= run.engine
        .getLastTickEvents()
        .some((event) => event.type === 'player_graphic_applied' && event.spotAnimId === PLAYER_STUNNED_SPOTANIM_ID);
    }
    expect(sawGraphic).toBe(true);
    const stuckAt = [...(run.world.getPlayer()?.position ?? [0, 0])];
    run.engine.queueProtectionPrayer(PrayerType.ProtectMagic);
    const zulrah = run.zulrah();
    if (zulrah) run.engine.setAttackTarget(zulrah.id);
    run.engine.advanceTick([stuckAt[0] + 4, stuckAt[1]] as Coordinate);
    expect(run.engine.wasLastTickStunned()).toBe(true);
    expect(run.world.getPlayer()?.activePrayer).toBe(PrayerType.ProtectMagic);
    expect(run.world.getPlayer()?.attackTarget ?? null).toBeNull();
    expect(run.world.getPlayer()?.position).toEqual(stuckAt);
  });

  // Capture 2 t3015: stunned through t3021, moving again on t3022.
  const { hit: STUN_HIT, firstMove: STUN_FIRST_MOVE } = ZULRAH_CAPTURE_TAIL_STUN;
  const stunnedTicks = STUN_FIRST_MOVE - STUN_HIT;

  it('stuns for the captured window: from the landing tick to the tick before the first move', () => {
    expect(ZULRAH_TAIL.stunTicks).toBe(stunnedTicks);
    expect(PLAYER_STUNNED_SPOTANIM_ID).toBe(ZULRAH_CAPTURE_TAIL_STUN.spotAnimId);
  });

  it('stuns from the tick the tail lands: no step until the captured first-move tick', () => {
    const run = startRun(5, { zulrahClouds: false });
    const pending = runToLastStare(run);
    while (run.world.tick < pending.landTick - 1) run.tick();
    const away: Coordinate = [pending.target[0] + 4, pending.target[1]];
    const moved: boolean[] = [];
    // The player clicks away every tick from the landing tick on; the tail still catches it, since
    // Zulrah's turn comes before the player's.
    for (let i = 0; i <= stunnedTicks; i++) {
      const before = [...(run.world.getPlayer()?.position ?? [0, 0])];
      run.engine.advanceTick(away);
      expect(run.world.tick).toBe(pending.landTick + i);
      expect(run.engine.wasLastTickStunned(), `tick +${i}`).toBe(i < stunnedTicks);
      const after = run.world.getPlayer()?.position ?? [0, 0];
      moved.push(after[0] !== before[0] || after[1] !== before[1]);
    }
    expect(moved).toEqual([...Array.from({ length: stunnedTicks }, () => false), true]);
  });

  it('stuns from the tick the tail lands: no attack until the captured first-move tick', () => {
    const run = startRun(5, { zulrahClouds: false });
    // The first tail: Zulrah stays up after it, so it can be attacked once the stun ends.
    const pending = runToStare(run);
    while (run.world.tick < pending.landTick) run.tick();
    // The second slam would stun again on the first free tick (as in the capture, t3008 then t3015), so
    // it lands harmlessly: attacks off from here on.
    run.engine.setMechanicsConfig({
      infiniteHealth: true,
      zulrahRotation: '1',
      zulrahClouds: false,
      zulrahAttacks: false,
    });
    expect(run.engine.wasLastTickStunned()).toBe(true);
    const player = run.world.getPlayer();
    if (!player) throw new Error('No player');
    // A blowpipe's reach covers Zulrah's middle spot from the start tile; set by hand, as there is no item loader.
    run.engine.setEquipment({ weapon: 12926 });
    player.equipmentStats = { ...createEmptyStats(), attackSpeed: 2, attackRange: 6 };
    const attacked: boolean[] = [];
    for (let i = 1; i <= stunnedTicks; i++) {
      const zulrah = run.zulrah();
      if (zulrah) run.engine.setAttackTarget(zulrah.id);
      run.tick();
      attacked.push(
        run.engine.getLastTickEvents().some((event) => event.type === 'attack_started' && event.sourceId === player.id),
      );
    }
    // Ticks +1 to +7 after the landing tick (itself stunned, above).
    expect(attacked).toEqual([...Array.from({ length: stunnedTicks - 1 }, () => false), true]);
  });

  it('faces the locked tile through the stare, then tracks the player again', () => {
    const run = startRun(5, { zulrahClouds: false });
    runToStare(run);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const locked = zulrah.actionFacing;
    expect(locked).toBeDefined();
    // The player walks off; the bearing holds.
    for (let i = 0; i < 3; i++)
      run.engine.advanceTick([ZULRAH_PLAYER_START[0] + 4, ZULRAH_PLAYER_START[1]] as Coordinate);
    expect(zulrah.actionFacing).toBe(locked);
    while (getZulrahState(zulrah)?.pendingTail) run.tick();
    expect(zulrah.actionFacing).toBeUndefined();
  });

  it('misses a player who moves two tiles away during the stare', () => {
    const run = startRun(5, { infiniteHealth: false, zulrahClouds: false });
    const pending = runToStare(run);
    const before = playerHp(run);
    const away: Coordinate = [pending.target[0] + 3, pending.target[1]];
    while (run.world.tick <= pending.landTick + 1) run.engine.advanceTick(away);
    expect(isInTailArea(run.world.getPlayer()?.position ?? [0, 0], pending.target)).toBe(false);
    expect(playerHp(run)).toBe(before);
    expect(run.engine.wasLastTickStunned()).toBe(false);
  });

  it.each([
    ['west of the west', [24, 63]],
    ['south-west of the west', [24, 62]],
    ['south of the west', [25, 62]],
    ['east of the east', [32, 63]],
    ['south-east of the east', [32, 62]],
    ['south of the east', [31, 62]],
  ] as const)('neither damages nor stuns a player %s pillar', (_side, tile) => {
    const safe: Coordinate = [tile[0], tile[1]];
    const run = startRun(5, { infiniteHealth: false, zulrahClouds: false });
    runToPhase(run, MAGMA_PHASE);
    for (let i = 0; i < 10; i++) run.engine.advanceTick(safe);
    expect(run.world.getPlayer()?.position).toEqual(safe);
    let pending = run.zulrah() ? getZulrahState(run.zulrah()!)?.pendingTail : null;
    for (let i = 0; i < 100 && !pending; i++) {
      run.engine.advanceTick(safe);
      pending = getZulrahState(run.zulrah()!)?.pendingTail;
    }
    if (!pending) throw new Error('Magma never stared');
    // It still stares at the player's tile and slams; the pillar takes it.
    expect(pending.target).toEqual(safe);
    const before = playerHp(run);
    while (run.world.tick <= pending.landTick + 1) run.engine.advanceTick(safe);
    expect(playerHp(run)).toBe(before);
    expect(run.engine.wasLastTickStunned()).toBe(false);
  });

  it('only treats the pillar tiles as safe while Zulrah is at the middle spot', () => {
    expect(isTailSafeTile(ZULRAH_SPOTS.middle, [24, 62])).toBe(true);
    expect(isTailSafeTile(ZULRAH_SPOTS.middle, [32, 62])).toBe(true);
    expect(isTailSafeTile(ZULRAH_SPOTS.middle, [25, 62])).toBe(true);
    expect(isTailSafeTile(ZULRAH_SPOTS.middle, [26, 62])).toBe(false);
    expect(isTailSafeTile(ZULRAH_SPOTS.middle, [24, 61])).toBe(false);
    expect(isTailSafeTile([16, 65], [24, 62])).toBe(false);
  });

  it('slams twice, then dives to the next phase', () => {
    const run = startRun(5);
    runToPhase(run, MAGMA_PHASE);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const stares: number[] = [];
    while (phaseIndexOf(run) === MAGMA_PHASE) {
      run.tick();
      if (zulrah.combat.lastAttackTick === run.world.tick) stares.push(run.world.tick);
    }
    expect(stares).toHaveLength(2);
    expect(stares[1] - stares[0]).toBe(ZULRAH_TAIL.stareTicks + ZULRAH_TAIL.recoveryTicks);
  });

  it('counts the 3x3 around the target as the tail area', () => {
    expect(isInTailArea([10, 10], [10, 10])).toBe(true);
    expect(isInTailArea([11, 9], [10, 10])).toBe(true);
    expect(isInTailArea([12, 10], [10, 10])).toBe(false);
  });
});

describe('Zulrah venom clouds', () => {
  const playerHp = (run: Run) => run.world.getPlayer()?.vitals.hp ?? 0;
  const visualClouds = (run: Run) => {
    const snapshot = run.engine.getEncounterSnapshot();
    return snapshot.kind === 'zulrah' ? snapshot.visuals.clouds : [];
  };

  it('fills the island through the opening phase, base first and the arms last', () => {
    const run = startRun(6);
    runToPhase(run, 1);
    const centers = visualClouds(run)
      .slice()
      .sort((a, b) => a.landTick - b.landTick)
      .map((cloud) => [cloud.center[0], cloud.center[1]]);
    expect(centers).toEqual(ZULRAH_CLOUD_FILL_ORDER.map((site) => [site[0], site[1]]));
  });

  it('deals 1-5 a tick to a player standing in one, and nothing with clouds off', () => {
    const damageOver = (mechanics: Partial<MechanicsConfig>) => {
      const run = startRun(6, { infiniteHealth: false, zulrahAttacks: false, ...mechanics });
      const ticks: number[] = [];
      // Through the opening rise and pause until the first clouds have landed and ticked.
      for (let i = 0; i < 40; i++) {
        const before = playerHp(run);
        run.tick();
        ticks.push(before - playerHp(run));
      }
      return ticks;
    };
    const hits = damageOver({}).filter((damage) => damage > 0);
    expect(hits.length).toBeGreaterThan(0);
    for (const damage of hits) {
      expect(damage).toBeGreaterThanOrEqual(1);
      expect(damage).toBeLessThanOrEqual(5);
    }
    expect(damageOver({ zulrahClouds: false }).every((damage) => damage === 0)).toBe(true);
  });

  it('turns to each venom barrage as it spits, and back to attacking the player after', () => {
    const run = startRun(6);
    run.tick();
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const bearings = new Set<number>();
    while (phaseIndexOf(run) === 0) {
      run.tick();
      if (zulrah.actionFacing !== undefined) bearings.add(zulrah.actionFacing);
    }
    // Four fill barrages at different sites: more than one bearing, none of them simply "the player".
    expect(bearings.size).toBeGreaterThan(1);
    // Rotation 1 phase 4 (index 3) spits after its attacks; its first attack drops the bearing.
    runToPhase(run, 3);
    while (zulrah.combat.lastAttackTick === null || zulrah.combat.lastAttackTick < run.world.tick) run.tick();
    expect(zulrah.actionFacing).toBeUndefined();
  });

  it('expires each cloud ZULRAH_CLOUD.durationTicks after it lands', () => {
    const run = startRun(6);
    runToPhase(run, 1);
    const first = visualClouds(run)[0];
    if (!first) throw new Error('No cloud');
    expect(first.expireTick - first.landTick).toBe(ZULRAH_CLOUD.durationTicks);
    while (run.world.tick < first.expireTick) run.tick();
    expect(
      visualClouds(run).some((cloud) => cloud.landTick === first.landTick && cloud.center[0] === first.center[0]),
    ).toBe(false);
  });
});

describe('Zulrah cloud sites', () => {
  it('leave both arm tips clear', () => {
    for (const site of ZULRAH_CLOUD_SITES) {
      for (const tip of [
        [23, 69],
        [33, 69],
      ] as const) {
        expect(Math.max(Math.abs(site[0] - tip[0]), Math.abs(site[1] - tip[1]))).toBeGreaterThan(ZULRAH_CLOUD.radius);
      }
    }
  });

  it('pick distinct sites, the nearest to the player first', () => {
    const sites = pickCloudSites([33, 65], () => 0.5);
    expect(sites).toHaveLength(ZULRAH_CLOUD.perBarrage);
    expect(sites[0]).toEqual([33, 65]);
    expect(new Set(sites.map(String)).size).toBe(sites.length);
  });
});

describe('ZulrahSceneObjectController', () => {
  it('draws one 3x3 cloud LOC per landed cloud, placed by its south-west tile', () => {
    const controller = new ZulrahSceneObjectController();
    const specs = controller.update({
      state: {
        currentTick: 10,
        encounter: {
          kind: 'zulrah',
          state: {} as never,
          visuals: {
            clouds: [
              { center: [26, 62], landTick: 8, expireTick: 38 },
              { center: [29, 61], landTick: 12, expireTick: 42 },
            ],
          },
        },
      },
    } as never);
    expect(specs.map((spec) => spec.id)).toEqual(['zulrah-cloud-26-62-8']);
    expect(specs[0]?.data).toMatchObject({ locId: ZULRAH_CLOUD_LOC_ID, localX: 25, localY: 61 });
  });
});

describe('Zulrah island across two map squares', () => {
  /** The island the cache flood-fills from the start tile: base y 60-63, arms x 22-24 and 32-34 to y 70. */
  function islandArena(): Set<string> {
    const tiles = new Set<string>();
    for (let x = 22; x <= 34; x++) for (let y = 60; y <= 63; y++) tiles.add(`${x},${y}`);
    for (const [minX, maxX] of [
      [22, 24],
      [32, 34],
    ])
      for (let x = minX; x <= maxX; x++) for (let y = 64; y <= 70; y++) tiles.add(`${x},${y}`);
    return tiles;
  }

  const originalArena = getArenaConfig();
  const originalFallback = getArenaAllowUnboundedFallback();
  afterEach(() => {
    clearResolvedArenaConfigs();
    setArenaConfig(originalArena, originalFallback);
  });

  /** As the app does once the cache resolves the arena: store it for the kind, then reapply. */
  function installIsland(run?: Run): void {
    const walkableTiles = islandArena();
    const config = { bounds: getBoundsFromRegion(walkableTiles), walkableTiles, collisionMap: null };
    setResolvedArenaConfig('zulrah', config);
    if (run) run.engine.reapplyArenaConfig();
    else setArenaConfig(config);
  }

  it('counts the arm tiles past y 63 as usable tiles once the arena reaches them', () => {
    expect(isInTileSpace(23, 69)).toBe(false);
    installIsland();
    expect(isInTileSpace(23, 69)).toBe(true);
    expect(isInTileSpace(33, 70)).toBe(true);
    expect(isInTileSpace(23, 71)).toBe(false);
  });

  it('lets the player walk up an arm to its tip', () => {
    const run = startRun(6, { zulrahAttacks: false, zulrahClouds: false });
    installIsland(run);
    const tip: Coordinate = [23, 69];
    for (let i = 0; i < 20; i++) run.engine.advanceTick(tip);
    expect(run.world.getPlayer()?.position).toEqual(tip);
  });

  it('gives a player time to run from the start tile to the east tip before the fill reaches it', () => {
    const run = startRun(6, { infiniteHealth: false, zulrahAttacks: false });
    installIsland(run);
    const tip: Coordinate = [33, 69];
    const before = run.world.getPlayer()?.vitals.hp;
    for (let i = 0; i < 30; i++) run.engine.advanceTick(tip);
    expect(run.world.getPlayer()?.position).toEqual(tip);
    expect(run.world.getPlayer()?.vitals.hp).toBe(before);
  });

  it('spares a player on an arm tip from the clouds', () => {
    const run = startRun(6, { infiniteHealth: false, zulrahAttacks: false });
    installIsland(run);
    const tip: Coordinate = [33, 69];
    for (let i = 0; i < 12; i++) run.engine.advanceTick(tip);
    expect(run.world.getPlayer()?.position).toEqual(tip);
    const before = run.world.getPlayer()?.vitals.hp;
    for (let i = 0; i < 20; i++) run.engine.advanceTick(tip);
    expect(run.world.getPlayer()?.vitals.hp).toBe(before);
  });
});

describe('Zulrah snakelings', () => {
  const snakelings = (run: Run) => run.world.getNpcs().filter((npc) => snakelingDefinition.isActor(npc) && npc.alive);

  /** Rotation 4 phase 2 opens on 4 snakeling orbs. */
  function runToFirstSnakelings(seed: number, mechanics: Partial<MechanicsConfig> = {}): Run {
    const run = startRun(seed, { zulrahRotation: '4', zulrahClouds: false, ...mechanics });
    runToPhase(run, 1);
    for (let i = 0; i < 40 && snakelings(run).length < 4; i++) run.tick();
    return run;
  }

  it('spits 4 orbs that land as snakelings 1-3 tiles from the player', () => {
    const run = runToFirstSnakelings(8);
    const spawned = snakelings(run);
    expect(spawned).toHaveLength(4);
    for (const snakeling of spawned) {
      const distance = Math.max(
        Math.abs(snakeling.position[0] - ZULRAH_PLAYER_START[0]),
        Math.abs(snakeling.position[1] - ZULRAH_PLAYER_START[1]),
      );
      expect(distance).toBeLessThanOrEqual(SNAKELING.landingMaxDistance + 1);
      expect([SNAKELING_MELEE_NPC_ID, SNAKELING_MAGIC_NPC_ID]).toContain(snakeling.npcTypeId);
      expect(snakeling.vitals).toEqual({ hp: 1, maxHp: 1 });
    }
  });

  it('draws both styles across runs', () => {
    const types = new Set<number>();
    for (let seed = 20; seed < 26; seed++)
      for (const s of snakelings(runToFirstSnakelings(seed))) types.add(s.npcTypeId);
    expect(types).toEqual(new Set([SNAKELING_MELEE_NPC_ID, SNAKELING_MAGIC_NPC_ID]));
  });

  it('attacks the player', () => {
    const run = runToFirstSnakelings(8);
    for (let i = 0; i < 15; i++) run.tick();
    expect(snakelings(run).some((s) => s.combat.lastAttackTick !== null)).toBe(true);
  });

  it(`dies off ${SNAKELING.lifetimeTicks} ticks after landing`, () => {
    const run = runToFirstSnakelings(8);
    const first = snakelings(run)[0];
    if (!first?.spawnTick) throw new Error('No snakeling');
    while (run.world.tick < first.spawnTick + SNAKELING.lifetimeTicks + 1) run.tick();
    expect(run.world.getNpc(first.id)).toBeNull();
  });

  describe('recoil', () => {
    const recoils = (run: Run) =>
      (run.engine['damageHistory'] as { source: string; targetId: string; effectiveDamage: number }[]).filter(
        (entry) => entry.source === 'PlayerAttack' && entry.targetId.startsWith('zulrah-snakeling-'),
      );

    it.each([
      ['Ring of recoil', 2550],
      ['Ring of suffering (ri)', 20657],
    ])('kills a snakeling that hits a player wearing a %s', (_name, ring) => {
      const run = runToFirstSnakelings(8);
      run.world.getPlayer()!.equipment.ring = ring;
      for (let i = 0; i < 20 && recoils(run).length === 0; i++) run.tick();
      const [recoil] = recoils(run);
      expect(recoil).toMatchObject({ effectiveDamage: 1 });
      expect(run.world.getNpc(recoil!.targetId)?.alive ?? false).toBe(false);
    });

    it('reflects nothing off an uncharged ring of suffering', () => {
      const run = runToFirstSnakelings(8);
      run.world.getPlayer()!.equipment.ring = 19710; // Ring of suffering (i)
      for (let i = 0; i < 20; i++) run.tick();
      expect(recoils(run)).toHaveLength(0);
    });
  });

  it('faces each orb as it spits it, not the player', () => {
    const run = startRun(8, { zulrahRotation: '4', zulrahClouds: false });
    runToPhase(run, 1);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const center = (tile: readonly number[]) => [tile[0] + 0.5, tile[1] + 0.5];
    let checked = 0;
    for (let i = 0; i < 40 && checked < 4; i++) {
      run.tick();
      for (const event of run.engine.getLastTickEvents()) {
        if (event.type !== 'inferno_visual') continue;
        const orb = (
          event as { projectiles?: { spotAnimId: number; target: { position: number[] } }[] }
        ).projectiles?.find((p) => p.spotAnimId === ZULRAH_SNAKELING_ORB_SPOTANIM_ID);
        if (!orb) continue;
        const [tx, ty] = center(orb.target.position);
        const dx = tx - (zulrah.position[0] + zulrah.size / 2);
        const dy = ty - (zulrah.position[1] + zulrah.size / 2);
        const expected = (Math.round((Math.atan2(-dx, -dy) * 1024) / Math.PI) + 2048) % 2048;
        const diff = Math.abs((zulrah.actionFacing ?? -9999) - expected) % 2048;
        expect(Math.min(diff, 2048 - diff)).toBeLessThanOrEqual(2);
        checked += 1;
      }
    }
    expect(checked).toBe(4);
  });

  it('spawns none with snakelings off', () => {
    const run = runToFirstSnakelings(8, { zulrahSnakelings: false });
    expect(snakelings(run)).toHaveLength(0);
  });

  it('kills every snakeling when Zulrah dies', () => {
    const run = runToFirstSnakelings(8);
    expect(snakelings(run).length).toBeGreaterThan(0);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    while ((zulrah.targetableFromTick ?? 0) > run.world.tick) run.tick();
    zulrah.vitals.hp = 1;
    enqueueEnginePendingHit(run.engine, {
      sourceId: 'player',
      targetId: zulrah.id,
      style: 'melee',
      attackKind: 'melee_stab',
      launchTick: run.world.tick,
      impactTick: run.world.tick + 1,
      rolledDamage: 5,
      accuracySucceeded: true,
    });
    for (let i = 0; i < 4; i++) run.tick();
    expect(snakelings(run)).toHaveLength(0);
  });
});

describe('Zulrah venom', () => {
  const poisonVarp = (run: Run) => run.world.getPlayer()?.poisonState.poisonVarp ?? 0;
  const envenomed = (run: Run) => poisonVarp(run) >= VENOM_THRESHOLD;

  /** Rotation 1 with clouds off, run until the player is envenomed or `limit` ticks pass. */
  function runUntilEnvenomed(run: Run, limit = 400): boolean {
    for (let i = 0; i < limit; i++) {
      if (envenomed(run)) return true;
      run.tick();
    }
    return envenomed(run);
  }

  it("envenoms the player through Zulrah's attacks", () => {
    const run = startRun(9, { zulrahClouds: false, zulrahSnakelings: false });
    expect(runUntilEnvenomed(run)).toBe(true);
  });

  it('envenoms on every Zulrah attack that does not miss, and never on a miss', () => {
    // Wiki, Zulrah/Strategies: "will envenom the player unless they miss, even if blocked by a
    // protection prayer". Read off the queued hits, before any lands.
    const run = startRun(9, { zulrahClouds: false, zulrahSnakelings: false });
    const seen = { accurate: 0, missed: 0 };
    for (let i = 0; i < 400 && (seen.accurate === 0 || seen.missed === 0); i++) {
      run.tick();
      for (const hit of run.world.pendingHits) {
        if (hit.sourceId !== ZULRAH_ACTOR_ID) continue;
        expect(hit.applyPoison === VENOM_THRESHOLD, `hit at ${hit.impactTick}`).toBe(hit.accuracySucceeded);
        seen[hit.accuracySucceeded ? 'accurate' : 'missed'] += 1;
      }
    }
    expect(seen.accurate).toBeGreaterThan(0);
    expect(seen.missed).toBeGreaterThan(0);
  });

  it('never envenoms with venom off', () => {
    const run = startRun(9, { zulrahClouds: false, zulrahVenom: false });
    expect(runUntilEnvenomed(run)).toBe(false);
  });

  it('never envenoms a player wearing a serpentine helm or a recolour', () => {
    for (const head of [12931, 13197, 13199]) {
      const run = startRun(9, { zulrahClouds: false });
      run.engine.setEquipment({ head });
      expect(runUntilEnvenomed(run), `head ${head}`).toBe(false);
    }
  });

  it('is cured by an anti-venom+ dose, which then holds venom off', () => {
    const run = startRun(9, { zulrahClouds: false, zulrahSnakelings: false });
    expect(runUntilEnvenomed(run)).toBe(true);
    run.engine.setInventory(parseInventoryFromSetup([{ id: 12913 }]));
    run.engine.queueItemAction(0);
    for (let i = 0; i < 3; i++) run.tick();
    expect(poisonVarp(run)).toBeLessThan(0);
    expect(run.world.getPlayer()?.inventory[0]?.id).toBe(12915); // Anti-venom+(3)
  });
});

describe('Zulrah opening and first attackable tick, against private gameplay capture zulrah-packet-data-2.txt', () => {
  const { spawn, spawnFacing, firstCast, hit, firstAction } = ZULRAH_CAPTURE_OPENING;

  it('can be attacked the captured ticks after its spawn, and first acts the captured ticks after it', () => {
    const run = startRun(1);
    run.tick();
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const risen = zulrah.spawnTick ?? 0;
    expect(risen).toBe(run.world.tick);
    expect((zulrah.targetableFromTick ?? 0) - risen).toBe(firstCast - spawn);
    let firstSpit: number | null = null;
    while (firstSpit === null) {
      run.tick();
      const spat = run.engine
        .getLastTickEvents()
        .filter(isInfernoVisualEvent)
        .some((v) => v.animations.some((a) => a.actorId === ZULRAH_ACTOR_ID && a.clipId === 'attack'));
      if (spat) firstSpit = run.world.tick;
    }
    expect(firstSpit - risen).toBe(firstAction - spawn);
  });

  it('faces south through the opening, even once hit, until its first barrage', () => {
    const run = startRun(1);
    run.tick();
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const risen = zulrah.spawnTick ?? 0;
    expect(zulrah.actionFacing).toBe(spawnFacing);
    expect(zulrah.combat.targetId).toBeNull();
    while (run.world.tick < risen + (hit - spawn) - 1) run.tick();
    enqueueEnginePendingHit(run.engine, {
      sourceId: 'player',
      targetId: zulrah.id,
      style: 'magic',
      attackKind: 'magic_water',
      launchTick: run.world.tick,
      impactTick: run.world.tick + 1,
      rolledDamage: 47,
      accuracySucceeded: true,
    });
    while (run.world.tick < risen + (firstAction - spawn) - 1) {
      run.tick();
      expect(zulrah.actionFacing, `t+${run.world.tick - risen}`).toBe(spawnFacing);
    }
    expect(zulrah.vitals.hp).toBeLessThan(zulrah.vitals.maxHp);
    run.tick();
    expect(zulrah.actionFacing).not.toBe(spawnFacing);
  });

  it('can first be attacked after a form change on the captured tick', () => {
    const { emerge, refused, attack } = ZULRAH_CAPTURE_FIRST_ATTACKABLE;
    const run = startRun(5, { zulrahClouds: false });
    runToPhase(run, 1); // Rotation 1 phase 2 surfaces at the middle spot, in reach of the start tile.
    const zulrah = run.zulrah();
    const player = run.world.getPlayer();
    if (!zulrah || !player) throw new Error('No Zulrah or player');
    const emerged = zulrah.spawnTick ?? 0;
    expect(emerged).toBe(run.world.tick);
    // A blowpipe's reach covers the middle spot from the start tile; set by hand, as there is no item loader.
    run.engine.setEquipment({ weapon: 12926 });
    player.equipmentStats = { ...createEmptyStats(), attackSpeed: 2, attackRange: 6 };
    let firstAttack: number | null = null;
    while (firstAttack === null && run.world.tick < emerged + 10) {
      // The queued click, handled in the next tick's input band, as a click sent during this tick is.
      run.engine.applyAction({ type: 'attackTarget', targetId: zulrah.id });
      run.tick();
      const attacked = run.engine
        .getLastTickEvents()
        .some((event) => event.type === 'attack_started' && event.sourceId === player.id);
      if (attacked) firstAttack = run.world.tick;
    }
    for (const tick of refused) expect(isNpcTargetable(zulrah, emerged + (tick - emerge))).toBe(false);
    expect(firstAttack).toBe(emerged + (attack - emerge));
  });
});
