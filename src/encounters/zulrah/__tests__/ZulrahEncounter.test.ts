import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  canInitiateAttackOnNpc,
  canShowNpcHealthBar,
  isNpcTargetable,
  type NpcActor,
} from '../../../core/actors/NpcActor';
import { isImmuneToBurn } from '../../../core/combat/burnStacks';
import { npcHitDelayFromEndTime } from '../../../core/combat/hitDelay';
import {
  type FirstPartyPlayerAttackInput,
  planFirstPartyPlayerAttack,
  projectFirstPartyPlayerAttack,
  resolveFirstPartyPlayerAttack,
} from '../../../core/combat/player/firstPartyPlayerAttack';
import { resolvePlayerAttack } from '../../../core/combat/playerAttackResolution';
import { RECOIL_DELAY_TICKS, recoilDamage } from '../../../core/combat/recoil';
import {
  clearResolvedArenaConfigs,
  getArenaAllowUnboundedFallback,
  getArenaConfig,
  getDefaultArenaConfig,
  isInTileSpace,
  isWalkableTile,
  setArenaConfig,
  setDefaultArenaConfig,
  setResolvedArenaConfig,
} from '../../../core/constants';
import { isCoreEvent } from '../../../core/events/types';
import { canReceiveNewAttack } from '../../../core/npcDeath';
import { VENOM_THRESHOLD } from '../../../core/poison';
import { mulberry32 } from '../../../core/rng';
import { SimulationEngine } from '../../../core/SimulationEngine';
import type { PendingHit, WorldState } from '../../../core/WorldState';
import { isInfernoVisualEvent } from '../../../npcs/inferno/visualEvents';
import type { NpcProjectileCue } from '../../../npcs/projectileCue';
import {
  PLAYER_STUNNED_SPOTANIM_ID,
  SNAKELING,
  SNAKELING_MAGIC_NPC_ID,
  SNAKELING_MELEE_NPC_ID,
  SNAKELING_SEQS,
  ZULRAH_ATTACK_SPEED_TICKS,
  ZULRAH_CLOUD,
  ZULRAH_CLOUD_LOC_ID,
  ZULRAH_CLOUD_ORB_SPOTANIM_ID,
  ZULRAH_LOS_GIVE_UP_TICKS,
  ZULRAH_MAGIC_SPOTANIM_ID,
  ZULRAH_NPC_ID_BY_FORM,
  ZULRAH_RANGED_SPOTANIM_ID,
  ZULRAH_SNAKELING_ORB_SPOTANIM_ID,
  ZULRAH_TAIL,
  zulrahCloudOrbLandTicks,
} from '../../../npcs/zulrah/constants';
import { createSnakeling, snakelingDefinition } from '../../../npcs/zulrah/snakeling';
import {
  getZulrahState,
  isInTailArea,
  isTailSafeTile,
  transformZulrah,
  zulrahDefinition,
  zulrahTailSide,
} from '../../../npcs/zulrah/zulrah';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { createCollisionMap, getBoundsFromRegion } from '../../../rs/collision/WalkabilityAnalyzer';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { createEmptyStats } from '../../../types/equipmentStats';
import { parseInventoryFromSetup } from '../../../types/inventory';
import { createDefaultPoisonState, createDefaultTimers, POISON_TICK_INTERVAL } from '../../../types/playerState';
import { type Coordinate, type MechanicsConfig, PrayerType } from '../../../types/simulation';
import {
  cloudCenter,
  isInCloud,
  randomCloudBarrage,
  ZULRAH_CLOUD_FILL,
  ZULRAH_CLOUD_SEQUENCES,
  ZULRAH_CLOUD_SITES,
  zulrahCloudSequence,
} from '../clouds';
import { zulrahIslandTiles } from '../constants';
import {
  ZULRAH_EMERGE_TICKS,
  ZULRAH_FORM_CHANGE_TICKS,
  ZULRAH_OPENING_PAUSE_TICKS,
  ZULRAH_OPENING_POSITION,
  ZULRAH_OPENING_RISE_TICKS,
  ZULRAH_ROTATION_NUMBERS,
  ZULRAH_ROTATIONS,
  ZULRAH_SPOTS,
  ZULRAH_SURFACE_PAUSE_TICKS,
  ZULRAH_UNDERWATER_TICKS,
} from '../rotation';
import { randomSnakelingSite, ZULRAH_SNAKELING_SITES, zulrahSnakelingSequence } from '../snakelingOrbs';
import { ZULRAH_ACTOR_ID, ZULRAH_PLAYER_START, ZulrahEncounter } from '../ZulrahEncounter';
import { ZulrahSceneObjectController } from '../ZulrahSceneObjectController';
import {
  ZULRAH_CAPTURE_2_JAD_PROJECTILES,
  ZULRAH_CAPTURE_3_JAD_PROJECTILES,
  ZULRAH_CAPTURE_ATTACK_HIT,
  ZULRAH_CAPTURE_CLOUD_BARRAGE,
  ZULRAH_CAPTURE_CLOUD_SEQUENCES,
  ZULRAH_CAPTURE_CLOUD_SITES,
  ZULRAH_CAPTURE_DEFERRED,
  ZULRAH_CAPTURE_DIVES,
  ZULRAH_CAPTURE_EMERGE_FACING_TILE,
  ZULRAH_CAPTURE_EXTRA_PHASE,
  ZULRAH_CAPTURE_FIRST_ATTACKABLE,
  ZULRAH_CAPTURE_FLIGHTS,
  ZULRAH_CAPTURE_FORM_CHANGES,
  ZULRAH_CAPTURE_IMMUNITY,
  ZULRAH_CAPTURE_JAD_PROJECTILES,
  ZULRAH_CAPTURE_OPENING,
  ZULRAH_CAPTURE_PHASE_ATTACKS,
  ZULRAH_CAPTURE_PROJECTILES,
  ZULRAH_CAPTURE_SIGHT,
  ZULRAH_CAPTURE_SIGHT_GIVE_UP,
  ZULRAH_CAPTURE_SIGHT_RESUME,
  ZULRAH_CAPTURE_SNAKELING_DEATHS,
  ZULRAH_CAPTURE_SNAKELING_FACING,
  ZULRAH_CAPTURE_SNAKELING_ORBS,
  ZULRAH_CAPTURE_SNAKELING_SEQUENCES,
  ZULRAH_CAPTURE_SPOTS,
  ZULRAH_CAPTURE_TAIL_SIDES,
  ZULRAH_CAPTURE_TAIL_SLAMS,
  ZULRAH_CAPTURE_TAIL_STUN,
  ZULRAH_CAPTURE_TAILS,
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
    // The spit comes at rise + pause; its first cloud lands as the first orb does.
    expect(firstLand - zulrahCloudOrbLandTicks(0) - risen).toBe(ZULRAH_OPENING_RISE_TICKS + ZULRAH_OPENING_PAUSE_TICKS);
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

  describe('seeds', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reports its seed and rebuilds from it', () => {
      const encounter = new ZulrahEncounter(7);
      expect(encounter.getSeeds()).toEqual({ encounterSeed: 7 });
      encounter.reset({ encounterSeed: 9 });
      expect(encounter.getSeeds()).toEqual({ encounterSeed: 9 });
    });

    it.each([
      {},
      { encounterSeed: 'x' },
      { encounterSeed: null },
      { encounterSeed: -1 },
      { encounterSeed: 0x100000000 },
      { encounterSeed: 1.5 },
      { encounterSeed: Number.NaN },
      { encounterSeed: 7, extra: 1 },
    ])('refuses the malformed seed record %j rather than drawing a new fight', (seeds) => {
      const encounter = new ZulrahEncounter(7);
      expect(() => encounter.reset(seeds)).toThrow();
    });

    it('accepts seed 0 and rebuilds the same fight from it', () => {
      const styles = (constructed: number) => {
        const encounter = new ZulrahEncounter(constructed);
        encounter.reset({ encounterSeed: 0 });
        expect(encounter.getSeeds()).toEqual({ encounterSeed: 0 });
        const engine = new SimulationEngine({ encounter, startPos: [...ZULRAH_PLAYER_START] as Coordinate });
        engine.setMechanicsConfig({ infiniteHealth: true, zulrahRotation: 'random' });
        const world = engine['worldState'] as WorldState;
        const picked: string[] = [];
        for (let i = 0; i < 300; i++) {
          engine.advanceTick([...ZULRAH_PLAYER_START] as Coordinate);
          const zulrah = world.getNpcs().find((npc) => zulrahDefinition.isActor(npc));
          if (zulrah?.combat.lastAttackTick === world.tick) picked.push(`${world.tick}:${zulrah.combat.attackStyle}`);
        }
        return picked;
      };
      const first = styles(5);
      expect(first.length).toBeGreaterThan(5);
      expect(styles(99)).toEqual(first);
    });

    it('draws a fresh seed when reset without one', () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.25);
      const encounter = new ZulrahEncounter(7);
      encounter.reset();
      expect(encounter.getSeeds()).toEqual({ encounterSeed: 0x40000000 });
    });
  });
});

describe('Zulrah stats from the Wiki rows', () => {
  it('can be burned in every form, as can both snakelings: the Wiki lists no burn immunity', () => {
    const run = startRun(1);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    for (const form of ['serpentine', 'magma', 'tanzanite'] as const) {
      transformZulrah(zulrah, {
        form,
        mode: 'idle',
        actions: [],
        position: [...ZULRAH_SPOTS.middle],
        spawnTick: 1,
        emergeTicks: 4,
      });
      expect(zulrah.formulaStats?.burnImmunity, form).toBeNull();
      expect(isImmuneToBurn(zulrah, 'weak'), form).toBe(false);
    }
    for (const style of ['melee', 'magic'] as const) {
      const snakeling = createSnakeling({ id: style, style, position: [23, 68], spawnTick: 1 });
      expect(isImmuneToBurn(snakeling, 'normal'), style).toBe(false);
    }
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

  describe("in the player's expected damage", () => {
    /** A Soulreaper axe swing at 300 melee strength: max hit 75 (floor((132 x 364 + 320) / 640)). */
    function swingAt(target: FirstPartyPlayerAttackInput['target']): FirstPartyPlayerAttackInput {
      const level = { current: 99, max: 99 };
      return {
        player: {
          stats: {
            attack: level,
            strength: level,
            defence: level,
            ranged: level,
            magic: level,
            prayer: level,
            hitpoints: level,
            agility: level,
          },
          equipment: { weapon: 28338 },
          equipmentStats: { ...createEmptyStats(), attackSlash: 100, meleeStrength: 300 },
          activePrayer: null,
          offensivePrayer: PrayerType.Piety,
          selectedAttackStyleIndex: 1,
          combatTimers: createDefaultTimers(),
        },
        target,
        formulaStyle: 'melee_slash',
        resources: { kind: 'none', source: 'none' },
        attackSpeedTicks: 5,
        delivery: { style: 'melee', attackKind: 'melee_slash', impactDelayTicks: 1 },
        application: { outgoingDamageMultiplier: 1, specialAttackDamageMultiplier: 1 },
        manualCast: false,
        isSpecialAttack: false,
        standardAccuracyMode: 'single_roll',
      };
    }
    const zulrahActor = () => {
      const zulrah = startRun(3).zulrah();
      if (!zulrah?.incomingHitCap) throw new Error('No capped Zulrah');
      return zulrah;
    };

    it("counts a hit over 50 at the cap draw's mean and caps the max hit at 50", () => {
      const zulrah = zulrahActor();
      const capped = projectFirstPartyPlayerAttack(swingAt(zulrah));
      const uncapped = projectFirstPartyPlayerAttack(swingAt({ ...zulrah, incomingHitCap: undefined }));
      if (!capped || !uncapped) throw new Error('Expected projections');

      expect(uncapped.maximumRolledDamagePerAttack).toBe(75);
      expect(uncapped.maximumAppliedDamagePerAttack).toBe(75);
      expect(capped.maximumRolledDamagePerAttack).toBe(75);
      expect(capped.maximumAppliedDamagePerAttack).toBe(50);
      // Rolls 0-75 (76 values) at accuracy p: each of 51-75 counts 47.5 instead of itself,
      // sum(51..75) - 25 x 47.5 = 1575 - 1187.5 = 387.5 less per 76 accurate rolls.
      expect(capped.accuracy).toBe(uncapped.accuracy);
      expect(capped.expectedAppliedDamagePerAttack).toBeCloseTo(
        uncapped.expectedAppliedDamagePerAttack - (capped.accuracy * 387.5) / 76,
        10,
      );
      expect(capped.dps).toBeCloseTo(capped.expectedAppliedDamagePerAttack / 3, 10);
    });

    it('records that expectation on the swing without drawing any extra combat RNG', () => {
      const zulrah = zulrahActor();
      const counted = (seed: number) => {
        const random = mulberry32(seed);
        let draws = 0;
        return {
          random: () => {
            draws += 1;
            return random();
          },
          draws: () => draws,
        };
      };
      for (const target of [zulrah, { ...zulrah, incomingHitCap: undefined }]) {
        const plan = planFirstPartyPlayerAttack(swingAt(target));
        if (plan?.kind !== 'ready') throw new Error('Expected a ready plan');
        const swing = counted(11);
        const rollOnly = counted(11);
        const result = resolveFirstPartyPlayerAttack(plan, swing.random);
        const rolled = resolvePlayerAttack(plan, rollOnly.random);

        expect(swing.draws()).toBe(rollOnly.draws());
        expect(result.hits.map((h) => h.damage)).toEqual(rolled.hits.map((h) => h.rolledDamage));
        expect(result.expectedHit).toBe(projectFirstPartyPlayerAttack(swingAt(target))?.expectedAppliedDamagePerAttack);
      }
    });
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
    // The start tile is in Zulrah's center column: TAIL_LEFT (simulator policy).
    expect(pending.landTick - run.world.tick).toBe(ZULRAH_TAIL.stareTicks.tailLeft);
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

  it('lands the recoil of a tail slam the tick after it', () => {
    const run = startRun(5, { zulrahClouds: false, zulrahSnakelings: false });
    run.engine.setEquipment({ ring: 2550 }); // Ring of recoil.
    const pending = runToStare(run);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    while (run.world.tick < pending.landTick - 1) run.engine.advanceTick([...pending.target] as Coordinate);
    const ticks: [number, string, number][] = [];
    for (let i = 0; i < 2; i++) {
      run.engine.advanceTick([...pending.target] as Coordinate);
      for (const e of run.engine.getLastTickEvents())
        if (isCoreEvent(e, 'hit_applied') && e.damage > 0)
          ticks.push([run.world.tick - pending.landTick, e.targetId, e.damage]);
    }
    const slam = ticks.find(([, target]) => target === 'player');
    expect(slam?.[0]).toBe(0);
    expect(ticks.filter(([, target]) => target === zulrah.id)).toEqual([
      [RECOIL_DELAY_TICKS, zulrah.id, recoilDamage(slam?.[2] ?? 0)],
    ]);
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
    expect(stares[1] - stares[0]).toBe(ZULRAH_TAIL.stareTicks.tailLeft + ZULRAH_TAIL.recoveryTicks);
  });

  it.each(
    ZULRAH_CAPTURE_TAIL_SIDES.filter((t) => !t.exception).map(
      (t) => [t.capture, t.stare, t.side, `${t.player}`, t] as const,
    ),
  )('whips from the captured side: capture %i t%i, %s, the player at (%s)', (_capture, _stare, _side, _player, {
    side,
    player,
  }) => {
    expect(zulrahTailSide({ position: ZULRAH_SPOTS.middle, size: 5 }, player)).toBe(side);
  });

  it('whips the other side at the captured exceptions (capture 1 t244, capture 3 t885, capture 4 t2058 and t2250) only in the capture', () => {
    const exceptions = ZULRAH_CAPTURE_TAIL_SIDES.filter((t) => t.exception);
    expect(exceptions.map((t) => [t.capture, t.stare])).toEqual([
      [1, 244],
      [3, 885],
      [4, 2058],
      [4, 2250],
    ]);
    for (const { side, player } of exceptions)
      expect(zulrahTailSide({ position: ZULRAH_SPOTS.middle, size: 5 }, player)).not.toBe(side);
  });

  it('fixture: every captured slam hit the player exactly when within one tile of the whip (OBSERVATION, not modeled)', () => {
    expect(ZULRAH_CAPTURE_TAIL_SLAMS).toHaveLength(18);
    for (const { whip, player, hit } of ZULRAH_CAPTURE_TAIL_SLAMS)
      expect(Math.max(Math.abs(whip[0] - player[0]), Math.abs(whip[1] - player[1])) <= 1).toBe(hit);
  });

  it.each([
    ['west', [22, 62], 'tailLeft'],
    ['east', [33, 62], 'tailRight'],
    ['in the center column (policy)', [28, 61], 'tailLeft'],
  ] as const)('stares %s of Zulrah with %s and its stare length', (_where, tile, side) => {
    const run = startRun(5, { zulrahClouds: false });
    runToPhase(run, MAGMA_PHASE);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    let pending = getZulrahState(zulrah)?.pendingTail ?? null;
    let clip: string | undefined;
    for (let i = 0; i < 40 && !pending; i++) {
      run.engine.advanceTick([tile[0], tile[1]]);
      pending = getZulrahState(zulrah)?.pendingTail ?? null;
      clip = run.engine
        .getLastTickEvents()
        .filter(isInfernoVisualEvent)
        .flatMap((v) => v.animations.filter((a) => a.actorId === zulrah.id).map((a) => a.clipId))
        .find((id) => id === 'tailLeft' || id === 'tailRight');
    }
    if (!pending) throw new Error('Magma never stared');
    expect(run.world.getPlayer()?.position).toEqual(tile);
    expect(clip).toBe(side);
    expect(pending.landTick - run.world.tick).toBe(ZULRAH_TAIL.stareTicks[side]);
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

  it.each(ZULRAH_ROTATION_NUMBERS)('opens rotation %i on the captured fill', (rotation) => {
    const opening = ZULRAH_CAPTURE_CLOUD_SEQUENCES.find((s) => s.index === 0);
    if (!opening) throw new Error('No captured opening');
    const run = startRun(6, { zulrahRotation: String(rotation) as '1' | '2' | '3' | '4' });
    runToPhase(run, 1);
    const centers = visualClouds(run)
      .slice()
      .sort((a, b) => a.landTick - b.landTick)
      .map((cloud) => [cloud.center[0], cloud.center[1]]);
    expect(centers).toEqual(opening.barrages.flat().map(cloudCenter));
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
  const siteIndex = (site: readonly number[]) =>
    ZULRAH_CLOUD_SITES.findIndex((s) => s[0] === site[0] && s[1] === site[1]);
  const covers = (site: Coordinate, tile: Coordinate) =>
    isInCloud(tile, { center: cloudCenter(site), landTick: 0, expireTick: 1 }, 0);

  it('are the captured sites, around the U from the west arm tip, each barrage at most two steps apart', () => {
    expect(ZULRAH_CLOUD_SITES).toEqual(ZULRAH_CAPTURE_CLOUD_SITES);
    const steps = [
      ...ZULRAH_CAPTURE_CLOUD_SEQUENCES.flatMap((s) => s.barrages),
      ...ZULRAH_CAPTURE_EXTRA_PHASE.barrages,
    ].map(([a, b]) => Math.abs(siteIndex(a) - siteIndex(b)));
    expect(steps.filter((step) => step === 1).length).toBeGreaterThan(0);
    expect(steps.filter((step) => step === 2).length).toBeGreaterThan(0);
    expect(steps.every((step) => step === 1 || step === 2)).toBe(true);
  });

  it("repeat rotation 2's captured sequences in capture 4, and its last phase is the captured fill", () => {
    const capture4 = ZULRAH_CAPTURE_CLOUD_SEQUENCES.filter((s) => s.capture === 4);
    expect(capture4.map((s) => s.index)).toEqual([3, 4, 7, 8, 10]);
    for (const { index, barrages } of capture4) {
      const capture2 = ZULRAH_CAPTURE_CLOUD_SEQUENCES.find((s) => s.capture === 2 && s.index === index);
      expect(barrages, `phase ${index}`).toEqual(index === 10 ? ZULRAH_CLOUD_FILL : capture2?.barrages);
    }
    const orbs4 = ZULRAH_CAPTURE_SNAKELING_SEQUENCES.filter((s) => s.capture === 4 && !s.partial);
    expect(orbs4.map((s) => s.index)).toEqual([4, 7]);
    for (const { index, sites } of orbs4)
      expect(sites).toEqual(
        ZULRAH_CAPTURE_SNAKELING_SEQUENCES.find((s) => s.capture === 2 && s.index === index)?.sites,
      );
    expect(ZULRAH_CLOUD_SEQUENCES[2]?.[10]).toBe(ZULRAH_CLOUD_FILL);
  });

  it('fill without covering the arm tips', () => {
    const tips: Coordinate[] = [
      [24, 70],
      [32, 70],
    ];
    for (const site of ZULRAH_CLOUD_FILL.flat())
      for (const tip of tips) expect(covers(site, tip), `${site}`).toBe(false);
    // The fill never uses the east arm's tip site, the one that would cover (32, 70).
    expect(covers([32, 69], [32, 70])).toBe(true);
  });

  it('use the captured sequence, then the fill for the opening and each last phase, else none', () => {
    for (const { rotation, index, barrages, partial } of ZULRAH_CAPTURE_CLOUD_SEQUENCES) {
      const sequence = zulrahCloudSequence(index === 0 ? ZULRAH_OPENING_POSITION : { rotation, index });
      expect(partial ? sequence?.slice(0, barrages.length) : sequence).toEqual(barrages);
    }
    for (const rotation of ZULRAH_ROTATION_NUMBERS) {
      const phases = ZULRAH_ROTATIONS[rotation];
      expect(zulrahCloudSequence({ rotation, index: phases.length - 1 })).toEqual(ZULRAH_CLOUD_FILL);
      phases.forEach((phase, index) => {
        const sequence = zulrahCloudSequence(index === 0 ? ZULRAH_OPENING_POSITION : { rotation, index });
        const barrages = [...(phase.before ?? []), ...(phase.after ?? [])].filter((s) => s === 'cloud').length;
        // Each sequence covers its phase's barrages exactly.
        if (sequence) expect(sequence, `rotation ${rotation} phase ${index}`).toHaveLength(barrages);
      });
    }
    // Rotation 1's blue south and jad west, like rotation 2's, stay on the fallback until captured.
    expect(zulrahCloudSequence({ rotation: 1, index: 7 })).toBeNull();
    expect(zulrahCloudSequence({ rotation: 1, index: 8 })).toBeNull();
  });

  it('fall back to a random pair at most two steps apart on the U, either orb first, the same for the same seed', () => {
    const draw = (seed: number) => {
      const random = mulberry32(seed);
      return Array.from({ length: 400 }, () => randomCloudBarrage(random));
    };
    const barrages = draw(7);
    expect(draw(7)).toEqual(barrages);
    expect(draw(8)).not.toEqual(barrages);
    const pairs = new Set<string>();
    let westFirst = 0;
    for (const [a, b] of barrages) {
      expect(siteIndex(a)).toBeGreaterThanOrEqual(0);
      expect(siteIndex(b)).toBeGreaterThanOrEqual(0);
      expect([1, 2]).toContain(Math.abs(siteIndex(a) - siteIndex(b)));
      pairs.add(`${Math.min(siteIndex(a), siteIndex(b))}-${Math.max(siteIndex(a), siteIndex(b))}`);
      if (siteIndex(a) < siteIndex(b)) westFirst += 1;
    }
    // The 8 neighboring pairs and the 7 one site apart.
    expect(pairs.size).toBe(15);
    expect(westFirst).toBeGreaterThan(0);
    expect(westFirst).toBeLessThan(barrages.length);
  });

  it('fall back the same way in the same seeded run (rotation 1, phase 3)', () => {
    const barrages = (seed: number) => {
      const run = startRun(seed);
      runToPhase(run, 4);
      const snapshot = run.engine.getEncounterSnapshot();
      return snapshot.kind === 'zulrah' ? snapshot.visuals.clouds.map((c) => c.center) : [];
    };
    const first = barrages(21);
    expect(first.length).toBeGreaterThan(0);
    expect(barrages(21)).toEqual(first);
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
  const originalArena = getArenaConfig();
  const originalFallback = getArenaAllowUnboundedFallback();
  afterEach(() => {
    clearResolvedArenaConfigs();
    setArenaConfig(originalArena, originalFallback);
  });

  /** As the app does once the cache resolves the arena: store it for the kind, then reapply. */
  function installIsland(run?: Run): void {
    const walkableTiles = zulrahIslandTiles();
    const config = { bounds: getBoundsFromRegion(walkableTiles), walkableTiles, collisionMap: null };
    setResolvedArenaConfig('zulrah', config);
    if (run) run.engine.reapplyArenaConfig();
    else setArenaConfig(config);
  }

  it('counts the arm tiles past y 63 as usable tiles once the arena reaches them', () => {
    // One map square's frame, as before the arena reached into 35_48.
    setArenaConfig(
      {
        bounds: { minX: 0, minY: 0, maxX: 63, maxY: 63, width: 64, height: 64 },
        walkableTiles: null,
        collisionMap: null,
      },
      false,
    );
    expect(isInTileSpace(23, 69)).toBe(false);
    installIsland();
    expect(isInTileSpace(23, 69)).toBe(true);
    expect(isInTileSpace(33, 70)).toBe(true);
    expect(isInTileSpace(23, 71)).toBe(false);
  });

  it("uses the island, not the global default (Yama's arena once the cache loads), before its own bake", () => {
    const previousDefault = getDefaultArenaConfig();
    const yamaLike = new Set(['32,30', '32,31']);
    setDefaultArenaConfig({ bounds: getBoundsFromRegion(yamaLike), walkableTiles: yamaLike, collisionMap: null });
    try {
      const run = startRun(6);
      expect(run.encounter.getArenaConfig().walkableTiles).toEqual(zulrahIslandTiles());
      expect(getArenaConfig().walkableTiles).toEqual(zulrahIslandTiles());
      expect(isWalkableTile(...ZULRAH_PLAYER_START)).toBe(true);
      expect(isWalkableTile(32, 30)).toBe(false);
      // The start tile is on it, and the pillars and the water are not.
      expect(isWalkableTile(25, 63)).toBe(false);
      expect(isWalkableTile(28, 64)).toBe(false);
    } finally {
      setDefaultArenaConfig(previousDefault);
    }
  });

  it('walks a halberd from the base round a pillar and up an arm to hit the middle form', () => {
    const run = startRun(6, { zulrahAttacks: false, zulrahClouds: false });
    installIsland(run);
    const front: Coordinate = [28, 62];
    run.engine.setEquipment({ weapon: 29796 }); // Noxious halberd
    // Weapon reach comes from the cache's item params, which unit tests do not load: set the halberd's 2.
    const player = run.world.getPlayer();
    if (!player) throw new Error('No player');
    player.equipmentStats = { ...player.equipmentStats, attackRange: 2 };
    for (let i = 0; i < 20; i++) run.engine.advanceTick(front);
    expect(player.position).toEqual(front);
    run.engine.setAttackTarget(ZULRAH_ACTOR_ID);
    let attackedFrom: Coordinate | null = null;
    for (let i = 0; i < 10 && !attackedFrom; i++) {
      run.engine.advanceTick([player.position[0], player.position[1]]);
      const attacked = run.engine
        .getLastTickEvents()
        .some((event) => event.type === 'attack_started' && event.sourceId === player.id);
      if (attacked) attackedFrom = [player.position[0], player.position[1]];
    }
    // The base's front row (y 62) is 3 tiles from the footprint (y 65-69), and y 63 between the pillars
    // is not walkable, so only the arms' inner columns (x 24 and 32, from y 63) are in a halberd's reach.
    expect(attackedFrom).not.toBeNull();
    expect([24, 32]).toContain(attackedFrom?.[0]);
    expect(attackedFrom?.[1]).toBeGreaterThanOrEqual(63);
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

  it('spits 4 orbs that land as snakelings on 4 different sites (an uncaptured phase)', () => {
    expect(zulrahSnakelingSequence({ rotation: 4, index: 1 })).toBeNull();
    for (let seed = 8; seed < 14; seed++) {
      const run = startRun(seed, { zulrahRotation: '4', zulrahClouds: false });
      runToPhase(run, 1);
      // Each one's tile as it lands, before it moves.
      const landed = new Map<string, Coordinate>();
      for (let i = 0; i < 40 && landed.size < 4; i++) {
        run.tick();
        for (const s of snakelings(run)) if (!landed.has(s.id)) landed.set(s.id, [s.position[0], s.position[1]]);
      }
      const spawned = snakelings(run);
      expect(spawned).toHaveLength(4);
      for (const snakeling of spawned) {
        expect(ZULRAH_SNAKELING_SITES).toContainEqual(landed.get(snakeling.id));
        expect([SNAKELING_MELEE_NPC_ID, SNAKELING_MAGIC_NPC_ID]).toContain(snakeling.npcTypeId);
        expect(snakeling.vitals).toEqual({ hp: 1, maxHp: 1 });
      }
      expect(new Set([...landed.values()].map(String)).size, `seed ${seed}`).toBe(4);
    }
  });

  it("lands only on the nine cloud sites' centers, as every captured orb did", () => {
    expect(ZULRAH_SNAKELING_SITES).toEqual(ZULRAH_CLOUD_SITES.map(cloudCenter));
    for (const { sites } of ZULRAH_CAPTURE_SNAKELING_SEQUENCES)
      for (const site of sites) expect(ZULRAH_SNAKELING_SITES).toContainEqual(site);
  });

  it('use the captured sequence of each fully captured phase, and no site twice in one', () => {
    for (const { rotation, index, sites, partial } of ZULRAH_CAPTURE_SNAKELING_SEQUENCES) {
      const sequence = zulrahSnakelingSequence({ rotation, index });
      if (partial) {
        // Rotation 3 phase 2's earlier round agrees with its full capture; rotation 4 phase 3 stays on the fallback.
        if (sequence) expect(sequence.slice(-sites.length)).toEqual(sites);
        continue;
      }
      expect(sequence, `rotation ${rotation} phase ${index}`).toEqual(sites);
      expect(new Set(sites.map(String)).size).toBe(sites.length);
    }
    expect(zulrahSnakelingSequence({ rotation: 4, index: 3 })).toBeNull();
    for (const rotation of ZULRAH_ROTATION_NUMBERS) {
      ZULRAH_ROTATIONS[rotation].forEach((phase, index) => {
        const orbs = [...(phase.before ?? []), ...(phase.after ?? [])].filter((s) => s === 'snakeling').length;
        const sequence = zulrahSnakelingSequence({ rotation, index });
        if (sequence) expect(sequence, `rotation ${rotation} phase ${index}`).toHaveLength(orbs);
      });
    }
  });

  it('falls back to a seeded random site the phase has not used yet', () => {
    const draw = (seed: number) => {
      const random = mulberry32(seed);
      const used: Coordinate[] = [];
      for (let i = 0; i < ZULRAH_SNAKELING_SITES.length; i++) used.push(randomSnakelingSite(random, used));
      return used;
    };
    const sites = draw(3);
    expect(draw(3)).toEqual(sites);
    expect(draw(4)).not.toEqual(sites);
    expect(new Set(sites.map(String)).size).toBe(ZULRAH_SNAKELING_SITES.length);
  });

  it('walks a snakeling off (33, 70), a site the island leaves out, as in the capture', () => {
    expect(zulrahIslandTiles().has('33,70')).toBe(false);
    const run = startRun(8, { zulrahRotation: '4', zulrahClouds: false, zulrahAttacks: false });
    runToPhase(run, 6); // Green south: its last orb lands on (33, 70).
    let snakeling: NpcActor | undefined;
    for (let i = 0; i < 60 && !snakeling; i++) {
      run.tick();
      snakeling = snakelings(run).find((s) => s.position[0] === 33 && s.position[1] === 70);
    }
    if (!snakeling) throw new Error('No snakeling on (33, 70)');
    for (let i = 0; i < 10; i++) run.tick();
    expect(snakeling.position).not.toEqual([33, 70]);
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

  const diedThisTick = (run: Run, id: string) =>
    run.engine.getLastTickEvents().some((event) => event.type === 'actor_died' && event.actorId === id);

  /** Ticks until `npc` leaves the world, returning the tick it went. */
  function tickUntilRemoved(run: Run, id: string, limit = 40): number {
    for (let i = 0; i < limit && run.world.getNpc(id); i++) run.tick();
    if (run.world.getNpc(id)) throw new Error(`${id} was never removed`);
    return run.world.tick;
  }

  it('dies off the most common captured lifetime after it appears, as a death, not a vanish', () => {
    const lifetimes = ZULRAH_CAPTURE_SNAKELING_DEATHS.map((d) => d.death - d.appears);
    expect(Math.min(...lifetimes)).toBe(50);
    expect(Math.max(...lifetimes)).toBe(53);
    expect(lifetimes.filter((l) => l === SNAKELING.lifetimeTicks)).toHaveLength(lifetimes.length / 2);
    for (const d of ZULRAH_CAPTURE_SNAKELING_DEATHS) expect(d.removed - d.death).toBe(2);
    const run = runToFirstSnakelings(8);
    const first = snakelings(run)[0];
    if (!first?.spawnTick) throw new Error('No snakeling');
    const deathTick = first.spawnTick + SNAKELING.lifetimeTicks;
    while (run.world.tick < deathTick - 1) run.tick();
    expect(first.alive).toBe(true);
    run.tick();
    expect(run.world.getNpc(first.id)).toBe(first);
    expect(first.alive).toBe(false);
    expect(first.death?.status).toBe('started');
    expect(diedThisTick(run, first.id)).toBe(true);
    expect(first.combat.animations.death).toBe(SNAKELING_SEQS.death);
  });

  it('is removed after dying off just as a killed snakeling is', () => {
    const lifetime = SNAKELING.lifetimeTicks;
    const expiry = runToFirstSnakelings(8);
    const expiring = snakelings(expiry)[0];
    if (!expiring?.spawnTick) throw new Error('No snakeling');
    const expiryDeath = expiring.spawnTick + lifetime;
    while (expiry.world.tick < expiryDeath) expiry.tick();
    expect(diedThisTick(expiry, expiring.id)).toBe(true);
    const expiryRemoval = tickUntilRemoved(expiry, expiring.id) - expiryDeath;

    const kill = runToFirstSnakelings(8);
    const killed = snakelings(kill)[0];
    if (!killed) throw new Error('No snakeling');
    enqueueEnginePendingHit(kill.engine, {
      sourceId: 'player',
      targetId: killed.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: kill.world.tick,
      impactTick: kill.world.tick + 1,
      rolledDamage: 1,
      accuracySucceeded: true,
    });
    kill.tick();
    expect(diedThisTick(kill, killed.id)).toBe(true);
    const killTick = kill.world.tick;
    const killRemoval = tickUntilRemoved(kill, killed.id) - killTick;
    expect(expiryRemoval).toBe(killRemoval);
  });

  it('neither attacks nor can be attacked while it dies off', () => {
    const run = runToFirstSnakelings(8);
    const first = snakelings(run)[0];
    if (!first?.spawnTick) throw new Error('No snakeling');
    while (run.world.tick < first.spawnTick + SNAKELING.lifetimeTicks) run.tick();
    expect(first.alive).toBe(false);
    const lastAttack = first.combat.lastAttackTick;
    expect(canReceiveNewAttack(first)).toBe(false);
    for (let i = 0; i < 5 && run.world.getNpc(first.id); i++) {
      run.engine.setAttackTarget(first.id);
      run.tick();
      expect(first.combat.lastAttackTick).toBe(lastAttack);
      expect(
        run.engine.getLastTickEvents().some((event) => event.type === 'attack_started' && event.targetId === first.id),
      ).toBe(false);
    }
  });

  describe('recoil', () => {
    const recoils = (run: Run) =>
      (
        run.engine['damageHistory'] as { tick: number; source: string; targetId: string; effectiveDamage: number }[]
      ).filter((entry) => entry.source === 'PlayerAttack' && entry.targetId.startsWith('zulrah-snakeling-'));

    it.each([
      ['Ring of recoil', 2550],
      ['Ring of suffering (ri)', 20657],
    ])('kills a snakeling that hits a player wearing a %s, the tick after its hit lands', (_name, ring) => {
      const run = runToFirstSnakelings(8);
      run.world.getPlayer()!.equipment.ring = ring;
      for (let i = 0; i < 20 && recoils(run).length === 0; i++) run.tick();
      const [recoil] = recoils(run);
      expect(recoil).toMatchObject({ effectiveDamage: 1 });
      const snakeling = run.world.getNpc(recoil!.targetId);
      if (!snakeling || !snakelingDefinition.isActor(snakeling)) throw new Error('No snakeling');
      expect(snakeling.alive).toBe(false);
      // Melee lands on its attack tick, the magic bolt a tick later; the recoil a tick after either.
      const landed = (snakeling.combat.lastAttackTick ?? -1) + (snakeling.state.style === 'magic' ? 1 : 0);
      expect(recoil!.tick).toBe(landed + RECOIL_DELAY_TICKS);
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

  it('envenoms at impact on an accurate hit that a protection prayer blocks to 0, starting a fresh clock', () => {
    // Wiki, Zulrah/Strategies: "will envenom the player unless they miss, even if blocked by a
    // protection prayer". Protect from Magic from the start (prayer is checked at launch), and follow
    // the first accurate hit, which on this seed is a damaging magic one, to its landing.
    const run = startRun(9, { zulrahClouds: false, zulrahSnakelings: false });
    run.engine.queueProtectionPrayer(PrayerType.ProtectMagic);
    let target: PendingHit | undefined;
    for (let i = 0; i < 400 && !target; i++) {
      run.tick();
      target = run.world.pendingHits.find((hit) => hit.sourceId === ZULRAH_ACTOR_ID && hit.accuracySucceeded);
    }
    if (!target) throw new Error('No accurate Zulrah hit');
    expect(target).toMatchObject({ style: 'magic', applyPoison: VENOM_THRESHOLD });
    expect(target.rolledDamage).toBeGreaterThan(0);
    while (run.world.tick < target.impactTick - 1) run.tick();
    expect(poisonVarp(run)).toBe(0);
    run.tick();

    const landed = run.engine
      .getDamageHistory()
      .filter((entry) => entry.tick === target.impactTick && entry.targetId === run.world.getPlayer()?.id);
    expect(landed).toEqual([expect.objectContaining({ prayedCorrectly: true, effectiveDamage: 0 })]);
    expect(run.world.getPlayer()?.poisonState).toEqual({
      poisonVarp: VENOM_THRESHOLD,
      poisonTickCounter: POISON_TICK_INTERVAL,
      startedTick: target.impactTick,
    });
  });

  it('does not envenom on a miss', () => {
    const run = startRun(9, { zulrahClouds: false, zulrahSnakelings: false });
    let miss: PendingHit | undefined;
    for (let i = 0; i < 400 && !miss; i++) {
      run.tick();
      miss = run.world.pendingHits.find((hit) => hit.sourceId === ZULRAH_ACTOR_ID && !hit.accuracySucceeded);
    }
    if (!miss) throw new Error('No missed Zulrah hit');
    while (run.world.tick < miss.impactTick - 1) run.tick();
    // Clear any venom from earlier hits, so the miss lands on a clean counter.
    const player = run.world.getPlayer();
    if (!player) throw new Error('No player');
    player.poisonState = createDefaultPoisonState();
    run.tick();
    const landed = run.engine.getDamageHistory().filter((entry) => entry.tick === miss.impactTick);
    expect(landed).toEqual([expect.objectContaining({ targetId: player.id, effectiveDamage: 0 })]);
    expect(poisonVarp(run)).toBe(0);
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

  it('envenoms a player in an uncharged serpentine helm, which protects from nothing', () => {
    const run = startRun(9, { zulrahClouds: false });
    run.engine.setEquipment({ head: 12929 });
    expect(run.world.getPlayer()?.equipment.head).toBe(12929);
    expect(runUntilEnvenomed(run)).toBe(true);
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

describe.each([
  { rotation: 3, capture: 'zulrah-packet-data-1.txt', jad: ZULRAH_CAPTURE_JAD_PROJECTILES },
  { rotation: 2, capture: 'zulrah-packet-data-2.txt', jad: ZULRAH_CAPTURE_2_JAD_PROJECTILES },
  { rotation: 4, capture: 'zulrah-packet-data-3.txt', jad: ZULRAH_CAPTURE_3_JAD_PROJECTILES },
] as const)('Zulrah rotation $rotation against private gameplay capture $capture', ({ rotation, jad }) => {
  type Action = 'attack' | 'cloud' | 'snakeling';
  type TickRecord = {
    readonly tick: number;
    readonly phaseInRotation: number;
    readonly clips: readonly string[];
    readonly projectiles: readonly NpcProjectileCue[];
    readonly action: Action | null;
    readonly attackStyle: string;
    readonly emerged: boolean;
    readonly tailStart: 'tailLeft' | 'tailRight' | null;
    readonly tailHit: boolean;
    readonly position: Coordinate;
    readonly actionFacing: number | undefined;
    readonly targetId: string | null;
    readonly newClouds: readonly { center: readonly [number, number]; landTick: number; expireTick: number }[];
    readonly newSnakelings: readonly { tile: Coordinate; spawnTick: number }[];
  };

  const ZULRAH_PROJECTILE_IDS = new Set<number>(Object.values(ZULRAH_CAPTURE_PROJECTILES));

  function actionOf(projectiles: readonly NpcProjectileCue[]): Action | null {
    if (projectiles.length === 0) return null;
    if (projectiles.some((p) => p.target.kind === 'actor')) return 'attack';
    return projectiles.length === ZULRAH_CLOUD.perBarrage ? 'cloud' : 'snakeling';
  }

  /** A run pinned to the capture's rotation, recorded tick by tick. */
  function recordRotation(ticks = 760): TickRecord[] {
    const run = startRun(11, { zulrahRotation: String(rotation) as '2' | '3' | '4' });
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const seenClouds = new Set<string>();
    const seenSnakelings = new Set<string>();
    const records: TickRecord[] = [];
    for (let i = 0; i < ticks; i++) {
      const hadTail = getZulrahState(zulrah)?.pendingTail ?? null;
      run.tick();
      const tick = run.world.tick;
      const visuals = run.engine.getLastTickEvents().filter(isInfernoVisualEvent);
      const projectiles = visuals.flatMap((v) => v.projectiles.filter((p) => ZULRAH_PROJECTILE_IDS.has(p.spotAnimId)));
      const snapshot = run.engine.getEncounterSnapshot();
      const clouds = snapshot.kind === 'zulrah' ? snapshot.visuals.clouds : [];
      const newClouds = clouds.filter((cloud) => {
        const key = `${cloud.center}:${cloud.landTick}`;
        if (seenClouds.has(key)) return false;
        seenClouds.add(key);
        return true;
      });
      const newSnakelings = run.world
        .getNpcs()
        .filter((npc) => snakelingDefinition.isActor(npc) && !seenSnakelings.has(npc.id))
        .map((npc) => {
          seenSnakelings.add(npc.id);
          return { tile: [npc.position[0], npc.position[1]] as Coordinate, spawnTick: npc.spawnTick ?? -1 };
        });
      const clips = visuals.flatMap((v) =>
        v.animations.filter((a) => a.actorId === ZULRAH_ACTOR_ID).map((a) => a.clipId),
      );
      records.push({
        tick,
        phaseInRotation: stateOf(run).phaseInRotation,
        clips,
        projectiles,
        action: actionOf(projectiles),
        attackStyle: zulrah.combat.attackStyle,
        emerged: zulrah.spawnTick === tick && tick > 1,
        tailStart: clips.includes('tailLeft') ? 'tailLeft' : clips.includes('tailRight') ? 'tailRight' : null,
        tailHit: hadTail !== null && getZulrahState(zulrah)?.pendingTail === null,
        position: [zulrah.position[0], zulrah.position[1]],
        actionFacing: zulrah.actionFacing,
        targetId: zulrah.combat.targetId,
        newClouds,
        newSnakelings,
      });
    }
    return records;
  }

  let records: TickRecord[] = [];
  let sinks: number[] = [];
  let emerges: number[] = [];
  beforeAll(() => {
    records = recordRotation();
    sinks = records.filter((r) => r.clips.includes('dive')).map((r) => r.tick);
    emerges = records.filter((r) => r.emerged).map((r) => r.tick);
  });
  const at = (tick: number) => records.find((r) => r.tick === tick);
  const nextSinkAfter = (tick: number) => sinks.find((sink) => sink > tick);
  /** The one value every capture case agrees on. */
  const single = (values: readonly number[]) => {
    const unique = [...new Set(values)];
    if (unique.length !== 1) throw new Error(`Capture cases disagree: ${values}`);
    return unique[0] as number;
  };
  /** The most common capture offset, for facts with an outlier. */
  const usual = (values: readonly number[]) => {
    const counts = new Map<number, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] as number;
  };
  const SINK_TO_EMERGE = single(ZULRAH_CAPTURE_FORM_CHANGES.map((c) => c.emerge - c.sink));
  const EMERGE_TO_FIRST = usual(
    ZULRAH_CAPTURE_FORM_CHANGES.flatMap((c) => (c.firstAction === null ? [] : [c.firstAction - c.emerge])),
  );
  const DEFERRED_SNAKELING = single(
    ZULRAH_CAPTURE_DEFERRED.filter((d) => d.kind === 'snakeling').map((d) => d.appears - d.launch),
  );
  const DEFERRED_CLOUD = single(
    ZULRAH_CAPTURE_DEFERRED.filter((d) => d.kind === 'cloud').map((d) => d.appears - d.launch),
  );
  const SNAKELING_LANDS = single(ZULRAH_CAPTURE_SNAKELING_ORBS.map((orb) => orb.lands - orb.launch));

  it('runs through every phase of the rotation and into the next', () => {
    expect(emerges.length).toBeGreaterThanOrEqual(ZULRAH_ROTATIONS[rotation].length);
  });

  it('slams on the captured tick for each side, and stares again the captured ticks after a slam', () => {
    const stareTicks = (side: 'tailLeft' | 'tailRight') =>
      single(ZULRAH_CAPTURE_TAILS.filter((t) => t.side === side).map((t) => t.lands - t.stare));
    const restartTicks = single(
      ZULRAH_CAPTURE_TAILS.flatMap((tail, i) => {
        const next = ZULRAH_CAPTURE_TAILS[i + 1];
        return i % 2 === 0 && next ? [next.stare - tail.lands] : [];
      }),
    );
    const starts = records.filter((r) => r.tailStart !== null);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    let restarts = 0;
    for (const start of starts) {
      const slam = records.find((r) => r.tick > start.tick && r.tailHit);
      if (!start.tailStart || !slam) throw new Error(`No slam after the stare at t${start.tick}`);
      expect(slam.tick - start.tick, `${start.tailStart} t${start.tick}`).toBe(stareTicks(start.tailStart));
      const next = starts.find((r) => r.tick > start.tick);
      if (next && next.tick < (nextSinkAfter(start.tick) ?? Number.POSITIVE_INFINITY)) {
        restarts += 1;
        expect(next.tick - slam.tick, `stare after t${slam.tick}`).toBe(restartTicks);
      }
    }
    expect(restarts).toBeGreaterThan(0);
  });

  it('launches the captured projectile for each kind of turn, on the captured flight', () => {
    expect([ZULRAH_RANGED_SPOTANIM_ID, ZULRAH_MAGIC_SPOTANIM_ID]).toEqual([
      ZULRAH_CAPTURE_PROJECTILES.ranged,
      ZULRAH_CAPTURE_PROJECTILES.magic,
    ]);
    expect([ZULRAH_CLOUD_ORB_SPOTANIM_ID, ZULRAH_SNAKELING_ORB_SPOTANIM_ID]).toEqual([
      ZULRAH_CAPTURE_PROJECTILES.cloudOrb,
      ZULRAH_CAPTURE_PROJECTILES.snakelingOrb,
    ]);
    const flight = (p: NpcProjectileCue) => ({ startCycle: p.startDelayCycles, endCycle: p.endDelayCycles });
    const seen = new Set<Action>();
    for (const record of records) {
      if (record.action === null) continue;
      seen.add(record.action);
      switch (record.action) {
        case 'attack':
          for (const p of record.projectiles) {
            expect(p.spotAnimId, `t${record.tick}`).toBe(
              record.attackStyle === 'magic' ? ZULRAH_CAPTURE_PROJECTILES.magic : ZULRAH_CAPTURE_PROJECTILES.ranged,
            );
            expect(flight(p)).toEqual(ZULRAH_CAPTURE_FLIGHTS.attack);
          }
          break;
        case 'cloud':
          expect(record.projectiles.map((p) => p.spotAnimId)).toEqual(
            [1, 2].map(() => ZULRAH_CAPTURE_PROJECTILES.cloudOrb),
          );
          expect(record.projectiles.map(flight)).toEqual(ZULRAH_CAPTURE_FLIGHTS.cloudOrbs);
          break;
        case 'snakeling':
          expect(record.projectiles.map((p) => p.spotAnimId)).toEqual([ZULRAH_CAPTURE_PROJECTILES.snakelingOrb]);
          expect(record.projectiles.map(flight)).toEqual([ZULRAH_CAPTURE_FLIGHTS.snakelingOrb]);
          break;
      }
    }
    expect(seen).toEqual(new Set(['attack', 'cloud', 'snakeling']));
  });

  it('lands an attack on the player 3 ticks after it, as in the capture', () => {
    const { launch, hit } = ZULRAH_CAPTURE_ATTACK_HIT;
    expect(npcHitDelayFromEndTime(ZULRAH_CAPTURE_FLIGHTS.attack.endCycle)).toBe(hit - launch);
  });

  it('emerges the captured ticks after it sinks, and first acts the captured ticks after that', () => {
    expect(sinks.length).toBeGreaterThanOrEqual(11);
    // An emerge too near the recording's end to see its first turn is left out.
    for (const emerge of emerges.filter((e) => e < (records.at(-1)?.tick ?? 0) - 10)) {
      const sink = [...sinks].reverse().find((s) => s < emerge);
      expect(emerge - (sink ?? -1), `emerge t${emerge}`).toBe(SINK_TO_EMERGE);
      const first = records.find((r) => r.tick > emerge && r.clips.some((clip) => clip !== 'dive'));
      expect((first?.tick ?? -1) - emerge, `emerge t${emerge}`).toBe(EMERGE_TO_FIRST);
    }
  });

  it('dives on the captured tick after each kind of last turn', () => {
    const expected = new Map(
      (['attack', 'cloud', 'snakeling', 'tailHit'] as const).map((kind) => [
        kind,
        single(ZULRAH_CAPTURE_DIVES.filter((d) => d.after === kind).map((d) => d.dive - d.tick)),
      ]),
    );
    const kinds = new Set<string>();
    for (const sink of sinks) {
      const last = [...records].reverse().find((r) => r.tick < sink && (r.action !== null || r.tailHit));
      if (!last) throw new Error(`Nothing before the dive at t${sink}`);
      const kind = last.tailHit ? 'tailHit' : (last.action as Action);
      kinds.add(kind);
      expect(sink - last.tick, `${kind} t${last.tick}, dive t${sink}`).toBe(expected.get(kind));
    }
    // A tail phase ends on its last slam unless specials follow it (rotation 4's has 2 barrages after).
    const tailEnds = ZULRAH_ROTATIONS[rotation].some((p) => p.mode === 'tail' && !p.after?.length);
    expect(kinds).toEqual(new Set([...expected.keys()].filter((kind) => tailEnds || kind !== 'tailHit')));
  });

  it('puts Zulrah on the captured spot tiles', () => {
    expect(ZULRAH_SPOTS).toEqual(ZULRAH_CAPTURE_SPOTS);
    for (const change of ZULRAH_CAPTURE_FORM_CHANGES) expect(Object.values(ZULRAH_SPOTS)).toContainEqual(change.to);
    for (const emerge of emerges) expect(Object.values(ZULRAH_SPOTS)).toContainEqual(at(emerge)?.position);
  });

  it('surfaces facing the captured tile, then faces the player, the first cloud or the orb tile as it acts', () => {
    expect(ZULRAH_CAPTURE_CLOUD_BARRAGE.facing).toEqual([
      ZULRAH_CAPTURE_CLOUD_BARRAGE.orbs[0].target[0] + ZULRAH_CLOUD.radius,
      ZULRAH_CAPTURE_CLOUD_BARRAGE.orbs[0].target[1] + ZULRAH_CLOUD.radius,
    ]);
    expect(ZULRAH_CAPTURE_SNAKELING_FACING.facing).toEqual(ZULRAH_CAPTURE_SNAKELING_FACING.target);
    const footprint = (record: TickRecord) => ({ position: record.position, size: 5 });
    for (const emerge of emerges) {
      const record = at(emerge);
      if (!record) throw new Error(`No record at t${emerge}`);
      expect(record.actionFacing, `emerge t${emerge}`).toBe(
        bearing(footprint(record), ZULRAH_CAPTURE_EMERGE_FACING_TILE),
      );
    }
    for (const record of records) {
      if (record.action === 'attack') {
        expect(record.actionFacing).toBeUndefined();
        expect(record.targetId).toBe('player');
      } else if (record.action === 'cloud') {
        const [orb] = record.projectiles;
        const tile = orb?.target.position ?? [0, 0];
        expect(record.actionFacing).toBe(
          bearing(footprint(record), [tile[0] + ZULRAH_CLOUD.radius, tile[1] + ZULRAH_CLOUD.radius]),
        );
      } else if (record.action === 'snakeling') {
        expect(record.actionFacing).toBe(bearing(footprint(record), record.projectiles[0]?.target.position ?? []));
      }
    }
  });

  it('never plays the attack animation without a projectile, so no bob after a form change', () => {
    const attackClips = records.filter((r) => r.clips.includes('attack'));
    expect(attackClips.length).toBeGreaterThan(0);
    for (const record of attackClips) expect(record.projectiles.length, `t${record.tick}`).toBeGreaterThan(0);
  });

  it('lands each cloud on its orb tick, at the orb target, for 30 ticks; one landing on the dive waits', () => {
    const barrage = ZULRAH_CAPTURE_CLOUD_BARRAGE;
    const landOffsets = barrage.orbs.map((orb) => orb.lands - barrage.launch);
    const lifetime = single(barrage.orbs.map((orb) => orb.removed - orb.lands));
    let deferred = 0;
    for (const record of records.filter((r) => r.action === 'cloud')) {
      const clouds = record.newClouds;
      expect(clouds).toHaveLength(ZULRAH_CLOUD.perBarrage);
      clouds.forEach((cloud, index) => {
        const orbTarget = record.projectiles[index]?.target.position;
        expect(orbTarget).toEqual([cloud.center[0] - ZULRAH_CLOUD.radius, cloud.center[1] - ZULRAH_CLOUD.radius]);
        const onTime = record.tick + (landOffsets[index] ?? -1);
        if (onTime === nextSinkAfter(record.tick)) {
          deferred += 1;
          expect(cloud.landTick, `deferred t${record.tick}`).toBe(record.tick + DEFERRED_CLOUD);
        } else {
          expect(cloud.landTick, `t${record.tick} orb ${index}`).toBe(onTime);
        }
        expect(cloud.expireTick - cloud.landTick).toBe(lifetime);
      });
    }
    expect(deferred).toBeGreaterThan(0);
  });

  it('lands each snakeling on its orb tile the captured ticks later; one landing on the dive waits', () => {
    let onTime = 0;
    let deferred = 0;
    const spawned = records.flatMap((r) => r.newSnakelings);
    for (const record of records.filter((r) => r.action === 'snakeling')) {
      const tile = record.projectiles[0]?.target.position;
      const lands = record.tick + SNAKELING_LANDS;
      const expectedTick = lands === nextSinkAfter(record.tick) ? record.tick + DEFERRED_SNAKELING : lands;
      if (expectedTick === lands) onTime += 1;
      else deferred += 1;
      const snakeling = spawned.find(
        (s) => s.spawnTick === expectedTick && s.tile[0] === tile?.[0] && s.tile[1] === tile?.[1],
      );
      expect(snakeling, `orb t${record.tick} to ${tile}`).toBeDefined();
    }
    expect(onTime).toBeGreaterThan(0);
    expect(deferred).toBeGreaterThan(0);
    // The deferred effect comes on the next form's first turn.
    for (const d of ZULRAH_CAPTURE_DEFERRED) {
      const change = ZULRAH_CAPTURE_FORM_CHANGES.find((c) => c.sink === d.dive);
      expect(d.appears - (change?.emerge ?? 0)).toBe(EMERGE_TO_FIRST);
    }
  });

  it('spits the captured cloud sequence in each captured phase, every time the phase comes round', () => {
    const captured = ZULRAH_CAPTURE_CLOUD_SEQUENCES.filter((s) => s.rotation === rotation && s.index > 0);
    expect(captured.length).toBeGreaterThan(0);
    for (const { index, barrages, partial } of captured) {
      const spat = records
        .filter((r) => r.phaseInRotation === index + 1 && r.action === 'cloud')
        .map((r) => r.projectiles.map((p) => p.target.position));
      expect(spat.length, `phase ${index}`).toBeGreaterThanOrEqual(barrages.length);
      if (partial) {
        expect(spat.slice(0, barrages.length), `phase ${index}`).toEqual(barrages);
        continue;
      }
      // Phases that come round again in the next rotation repeat it.
      for (let i = 0; i < spat.length; i++)
        expect(spat[i], `phase ${index} barrage ${i}`).toEqual(barrages[i % barrages.length]);
    }
  });

  it('spits the captured snakeling orbs in each captured phase, every time the phase comes round', () => {
    const captured = ZULRAH_CAPTURE_SNAKELING_SEQUENCES.filter((s) => s.rotation === rotation && !s.partial);
    expect(captured.length).toBeGreaterThan(0);
    for (const { index, sites } of captured) {
      const spat = records
        .filter((r) => r.phaseInRotation === index + 1 && r.action === 'snakeling')
        .map((r) => r.projectiles[0]?.target.position);
      expect(spat.length, `phase ${index}`).toBeGreaterThanOrEqual(sites.length);
      for (let i = 0; i < spat.length; i++) expect(spat[i], `phase ${index} orb ${i}`).toEqual(sites[i % sites.length]);
    }
  });

  it("makes each captured phase's attack count, the outlier aside", () => {
    const captured = ZULRAH_CAPTURE_PHASE_ATTACKS.filter((p) => p.rotation === rotation && !p.outlier);
    for (const { index, launches } of captured) {
      expect(ZULRAH_ROTATIONS[rotation][index]?.attacks).toBe(launches.length);
      const made = records.filter((r) => r.phaseInRotation === index + 1 && r.action === 'attack');
      expect(made.length, `phase ${index}`).toBeGreaterThanOrEqual(launches.length);
      // Every round of the phase makes the full count (the recording may end mid-round).
      expect(made.length % launches.length, `phase ${index}`).toBe(0);
    }
  });

  it('opens the jad phase on the captured style and alternates, as in the capture', () => {
    const jadPhase = ZULRAH_ROTATIONS[rotation].findIndex((phase) => phase.mode === 'jad') + 1;
    const ids = records
      .filter((r) => r.phaseInRotation === jadPhase && r.action === 'attack')
      .map((r) => r.projectiles[0]?.spotAnimId);
    expect(ids.slice(0, jad.length)).toEqual(jad);
  });
});

describe('Zulrah takes no player hits from its sink until it can be attacked again (capture 4)', () => {
  const {
    landedOnSinkMinusOne,
    droppedOnSink,
    refusedFromSink,
    firstAttackAfterEmerge,
    deferredSplats,
    lostAfterMove,
  } = ZULRAH_CAPTURE_IMMUNITY;

  /** Rotation 1's blue middle phase (index 2), then green south, both in a blowpipe's reach of the start. */
  function blowpipeRun(attackSpeed: number) {
    const run = startRun(5, { zulrahClouds: false, zulrahAttacks: false, zulrahSnakelings: false });
    runToPhase(run, 2);
    const zulrah = run.zulrah();
    const player = run.world.getPlayer();
    if (!zulrah || !player) throw new Error('No Zulrah or player');
    run.engine.setEquipment({ weapon: 12926 });
    player.equipmentStats = { ...createEmptyStats(), attackSpeed, attackRange: 6, rangedStrength: 40 };
    return { run, zulrah, player };
  }

  /** Clicks Zulrah every tick through the next form's emerge + 8; the ticks of attacks, splats, the sink and the emerge. */
  function clickThroughDive(attackSpeed: number) {
    const { run, zulrah, player } = blowpipeRun(attackSpeed);
    const attacks: number[] = [];
    const splats: number[] = [];
    let sink: number | null = null;
    let emerge: number | null = null;
    while (emerge === null || run.world.tick < emerge + 8) {
      run.engine.applyAction({ type: 'attackTarget', targetId: zulrah.id });
      run.tick();
      const tick = run.world.tick;
      const events = run.engine.getLastTickEvents();
      if (events.some((e) => e.type === 'attack_started' && e.sourceId === player.id)) attacks.push(tick);
      if (events.some((e) => e.type === 'hitsplat_spawned' && e.targetId === zulrah.id)) splats.push(tick);
      if (sink === null && stateOf(run).stage === 'diving') sink = tick;
      if (sink !== null && emerge === null && zulrah.spawnTick === tick) emerge = tick;
      if (tick > 400) throw new Error('No dive');
    }
    if (sink === null || emerge === null) throw new Error('No dive');
    return { attacks, splats, sink, emerge };
  }

  it('counts the captured cases: a hit landing on S-1 splats, one due on S never does', () => {
    for (const { launch, sink, splat } of landedOnSinkMinusOne) {
      expect(splat - sink).toBe(-1);
      expect(launch).toBeLessThan(splat);
    }
    for (const { attack, sink, delay } of droppedOnSink) expect(attack + delay).toBe(sink);
    for (const { click, sink } of refusedFromSink) expect(click - sink).toBeGreaterThanOrEqual(0);
    for (const { refused, attack, emerge } of firstAttackAfterEmerge)
      expect([refused - emerge, attack - emerge]).toEqual([ZULRAH_EMERGE_TICKS - 1, ZULRAH_EMERGE_TICKS]);
    // Not modeled (open questions): the E+3 splat that followed each hit pending at S.
    for (const { sink, splat } of deferredSplats) expect(splat - sink).toBe(ZULRAH_FORM_CHANGE_TICKS + 3);
    for (const { launch, sink, emerge } of lostAfterMove) expect([sink - launch, emerge - sink]).toEqual([1, 3]);
  });

  it('takes a queued hit landing on S-1, and drops those landing on S or later, with no splat', () => {
    const dry = clickThroughDive(1);
    const run = startRun(5, { zulrahClouds: false, zulrahAttacks: false, zulrahSnakelings: false });
    runToPhase(run, 2);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    while (run.world.tick < dry.sink - 2) run.tick();
    const hpBefore = zulrah.vitals.hp;
    for (const [impact, damage] of [
      [dry.sink - 1, 7],
      [dry.sink, 11],
      [dry.sink + 1, 13],
      [dry.emerge + 3, 17],
    ] as const) {
      enqueueEnginePendingHit(run.engine, {
        sourceId: 'player',
        targetId: zulrah.id,
        style: 'range',
        attackKind: 'range_arrow',
        launchTick: run.world.tick,
        impactTick: impact,
        rolledDamage: damage,
        accuracySucceeded: true,
      });
    }
    const splats: number[] = [];
    while (run.world.tick < dry.emerge + 5) {
      run.tick();
      if (run.engine.getLastTickEvents().some((e) => e.type === 'hitsplat_spawned' && e.targetId === zulrah.id))
        splats.push(run.world.tick);
    }
    expect(splats).toEqual([dry.sink - 1]);
    expect(hpBefore - zulrah.vitals.hp).toBe(7);
  });

  it('stays targetable, with its health bar, through S-1, and refuses attacks from S', () => {
    const dry = clickThroughDive(1);
    const run = startRun(5, { zulrahClouds: false, zulrahAttacks: false, zulrahSnakelings: false });
    runToPhase(run, 2);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    while (run.world.tick < dry.sink - 1) run.tick();
    expect(isNpcTargetable(zulrah, run.world.tick)).toBe(true);
    expect(canShowNpcHealthBar(zulrah, run.world.tick)).toBe(true);
    expect(canInitiateAttackOnNpc(zulrah, run.world.tick + 1)).toBe(false);
    run.tick();
    expect(isNpcTargetable(zulrah, run.world.tick)).toBe(false);
  });

  it("lands its own last attack on the player on S, and holds the player's recoil to E+3, with its damage", () => {
    const recoilHeld = deferredSplats.filter((d) => d.pending.startsWith('recoil'));
    expect(recoilHeld).toHaveLength(2);
    for (const { sink, splat } of recoilHeld) expect(splat - sink).toBe(ZULRAH_FORM_CHANGE_TICKS + 3);
    const run = startRun(5, { zulrahClouds: false, zulrahSnakelings: false });
    runToPhase(run, 2);
    run.engine.setEquipment({ ring: 2550 }); // Ring of recoil.
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    for (let i = 0; i < 60 && stateOf(run).stage !== 'diving'; i++) run.tick();
    expect(stateOf(run).stage).toBe('diving');
    const sink = run.world.tick;
    const hit = run.engine.getLastTickEvents().find((e) => isCoreEvent(e, 'hit_applied') && e.targetId === 'player');
    if (!hit || !isCoreEvent(hit, 'hit_applied')) throw new Error('No hit on S');
    const splats: [number, number][] = [];
    while (run.world.tick < sink + ZULRAH_FORM_CHANGE_TICKS + 5) {
      run.tick();
      for (const e of run.engine.getLastTickEvents())
        if (isCoreEvent(e, 'hitsplat_spawned') && e.targetId === zulrah.id) splats.push([run.world.tick, e.amount]);
    }
    expect(splats).toEqual([[sink + ZULRAH_FORM_CHANGE_TICKS + 3, recoilDamage(hit.damage)]]);
  });

  it.each([
    1, 2,
  ])('lets an attack start on S-1 but wastes it, refuses attacks from S through E+3, and attacks on E+4 (speed %i)', (speed) => {
    const { attacks, splats, sink, emerge } = clickThroughDive(speed);
    expect(emerge - sink).toBe(ZULRAH_FORM_CHANGE_TICKS);
    // Started up to S-1 (every tick at speed 1)...
    expect(attacks.filter((t) => t >= sink - 2 && t < sink).length).toBeGreaterThan(0);
    if (speed === 1) expect(attacks).toContain(sink - 1);
    // ...none from S through E+3, then on E+4.
    expect(attacks.filter((t) => t >= sink && t <= emerge + 3)).toEqual([]);
    expect(attacks).toContain(emerge + ZULRAH_EMERGE_TICKS);
    // The blowpipe lands 2 ticks after the throw: the throws of S-2 and S-1 never splat.
    expect(splats.filter((t) => t >= sink && t <= emerge + ZULRAH_EMERGE_TICKS + 1)).toEqual([]);
    expect(splats).toContain(sink - 1);
    expect(splats.some((t) => t > emerge + ZULRAH_EMERGE_TICKS)).toBe(true);
  });
});

describe('Zulrah rotation 1, against the Wiki table', () => {
  /**
   * Written out by hand from https://oldschool.runescape.wiki/w/Zulrah/Strategies, "Rotation 1
   * ("Crimson A")", read 2026-11-27; not derived from `rotation.ts`. Turns in order: R a ranged attack,
   * M a magic or ranged one, J the jad phase's alternating attacks, starting with ranged, T a tail
   * ("attacking twice with Melee"), C a venom cloud barrage, S a snakeling orb. Phase 8's "alternating
   * series of 5 snakeling orbs and venom cloud barrages" is read as starting with an orb, as worded.
   */
  const WIKI_ROTATION_1 = [
    { form: 'green', spot: 'middle', turns: 'CCCC' },
    { form: 'red', spot: 'middle', turns: 'TT' },
    { form: 'blue', spot: 'middle', turns: 'MMMM' },
    { form: 'green', spot: 'south', turns: 'RRRRRSSCCSS' },
    { form: 'red', spot: 'middle', turns: 'TT' },
    { form: 'blue', spot: 'west', turns: 'MMMMM' },
    { form: 'green', spot: 'south', turns: 'CCCSSSS' },
    { form: 'blue', spot: 'south', turns: 'MMMMMSCSCS' },
    { form: 'green', spot: 'west', turns: 'JJJJJJJJJJCCCC' },
    { form: 'red', spot: 'middle', turns: 'TT' },
    { form: 'green', spot: 'middle', turns: 'RRRRRCCCC' },
  ] as const;
  const FORM_BY_NPC: Record<number, string> = {
    [ZULRAH_NPC_ID_BY_FORM.serpentine]: 'green',
    [ZULRAH_NPC_ID_BY_FORM.magma]: 'red',
    [ZULRAH_NPC_ID_BY_FORM.tanzanite]: 'blue',
  };

  it('runs the table phase by phase: form, spot and every turn in order', () => {
    const run = startRun(4, { zulrahRotation: '1' });
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const phases: { form: string; spot: string; turns: string }[] = [];
    let jadStyles = '';
    for (let i = 0; i < 1200; i++) {
      run.tick();
      const phase = stateOf(run).phaseInRotation;
      // The last phase counts as the next rotation's first: stop once that rotation reaches phase 2.
      if (phases.length === WIKI_ROTATION_1.length && phase === 2) break;
      if (phases.length < phase) {
        const spot = Object.entries(ZULRAH_SPOTS).find(
          ([, tile]) => tile[0] === zulrah.position[0] && tile[1] === zulrah.position[1],
        )?.[0];
        phases.push({ form: FORM_BY_NPC[zulrah.npcTypeId] ?? '?', spot: spot ?? '?', turns: '' });
      }
      const current = phases.at(-1);
      if (!current) continue;
      for (const visual of run.engine.getLastTickEvents().filter(isInfernoVisualEvent)) {
        const clips = visual.animations.filter((a) => a.actorId === zulrah.id).map((a) => a.clipId);
        if (clips.includes('tailLeft') || clips.includes('tailRight')) current.turns += 'T';
        const ids = visual.projectiles.map((p) => p.spotAnimId);
        if (ids.includes(ZULRAH_CLOUD_ORB_SPOTANIM_ID)) current.turns += 'C';
        else if (ids.includes(ZULRAH_SNAKELING_ORB_SPOTANIM_ID)) current.turns += 'S';
        else if (ids.includes(ZULRAH_RANGED_SPOTANIM_ID) || ids.includes(ZULRAH_MAGIC_SPOTANIM_ID)) {
          const jad = phases.length === 9;
          current.turns += jad ? 'J' : current.form === 'blue' ? 'M' : 'R';
          if (jad) jadStyles += ids.includes(ZULRAH_RANGED_SPOTANIM_ID) ? 'r' : 'm';
          else if (current.form !== 'blue') expect(ids, `phase ${phases.length}`).toContain(ZULRAH_RANGED_SPOTANIM_ID);
        }
      }
    }
    expect(phases).toEqual(WIKI_ROTATION_1);
    expect(jadStyles).toBe('rmrmrmrmrm');
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

describe('Zulrah line of sight, against private gameplay captures', () => {
  /** The island's projectile blockers in the pinned cache: one pillar tile each side of the base. */
  const PILLARS: readonly Coordinate[] = [
    [25, 63],
    [31, 63],
  ];

  const originalArena = getArenaConfig();
  const originalFallback = getArenaAllowUnboundedFallback();
  afterEach(() => {
    clearResolvedArenaConfigs();
    setArenaConfig(originalArena, originalFallback);
  });

  function installPillars(run: Run): void {
    const collisionMap = createCollisionMap(64, 128);
    const walkableTiles = zulrahIslandTiles();
    for (const [x, y] of PILLARS) {
      collisionMap.flag(x, y, CollisionFlag.OBJECT | CollisionFlag.OBJECT_PROJECTILE_BLOCKER);
      walkableTiles.delete(`${x},${y}`);
    }
    setResolvedArenaConfig('zulrah', { bounds: getBoundsFromRegion(walkableTiles), walkableTiles, collisionMap });
    run.engine.reapplyArenaConfig();
  }

  /** Phases that open on their ranged or magic attacks at each spot, by pinned rotation and index. */
  const ATTACK_PHASE = {
    middle: { rotation: '1', index: 2 }, // Blue middle, 4 attacks.
    south: { rotation: '1', index: 3 }, // Green south, 5 attacks, then S S C C S S.
    east: { rotation: '2', index: 6 }, // Green east, 5 attacks, nothing after.
  } as const;

  /** A run at the emerge of `spot`'s attack phase, the pillars in place and the player on `tile`. */
  function emergeAt(spot: keyof typeof ATTACK_PHASE, tile: Coordinate) {
    const { rotation, index } = ATTACK_PHASE[spot];
    const run = startRun(3, { zulrahRotation: rotation, zulrahClouds: false, zulrahSnakelings: false });
    installPillars(run);
    runToPhase(run, index);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    expect(zulrah.position).toEqual(ZULRAH_SPOTS[spot]);
    standOn(run, tile);
    return { run, zulrah, emerged: zulrah.spawnTick ?? 0 };
  }

  function standOn(run: Run, tile: Coordinate): void {
    const player = run.world.getPlayer();
    if (!player) throw new Error('No player');
    player.position = [tile[0], tile[1]];
    player.previousPosition = [tile[0], tile[1]];
  }

  /** Ticks on `tile` (it stays there) until `tick`, returning the ticks Zulrah attacked on. */
  function holdUntil(run: Run, zulrah: NpcActor, tile: Coordinate, tick: number): number[] {
    const attacks: number[] = [];
    while (run.world.tick < tick) {
      run.engine.advanceTick([tile[0], tile[1]]);
      expect(run.world.getPlayer()?.position).toEqual(tile);
      if (zulrah.combat.lastAttackTick === run.world.tick) attacks.push(run.world.tick);
    }
    return attacks;
  }

  const firstTurn = (emerged: number) => emerged + ZULRAH_SURFACE_PAUSE_TICKS;

  it.each(
    ZULRAH_CAPTURE_SIGHT.map((c) => [c.spot, `${c.tile}`, c.visible ? 'sees' : 'cannot see', c] as const),
  )('at the %s spot, from (%s), %s the player', (_spot, _tile, _sees, { spot, tile, visible }) => {
    const { run, zulrah, emerged } = emergeAt(spot, tile);
    const attacks = holdUntil(run, zulrah, tile, firstTurn(emerged));
    expect(attacks).toEqual(visible ? [firstTurn(emerged)] : []);
    if (!visible) {
      // It turns to the player while it waits.
      expect(zulrah.actionFacing).toBeUndefined();
      expect(zulrah.combat.targetId).toBe('player');
    }
  });

  it('attacks on the first tick it sees the player, off its 3-tick grid, then keeps 3 ticks from there', () => {
    const { attack, hidden, hiddenThrough, seenFrom, resumed, next } = ZULRAH_CAPTURE_SIGHT_RESUME;
    const { run, zulrah, emerged } = emergeAt('south', [24, 64]);
    const start = firstTurn(emerged);
    const at = (tick: number) => start + (tick - attack);
    expect(holdUntil(run, zulrah, [24, 64], start)).toEqual([start]);
    standOn(run, [...hidden]);
    expect(holdUntil(run, zulrah, [...hidden], at(hiddenThrough))).toEqual([]);
    standOn(run, [...seenFrom]);
    const attacks = holdUntil(run, zulrah, [...seenFrom], at(next) + 3 * 2);
    expect(attacks).toEqual([at(resumed), at(next), at(next) + 3, at(next) + 6]);
    // All 5 attacks made.
    expect(getZulrahState(zulrah)?.attacksMade).toBe(5);
  });

  it('gives up its attacks after the policy count of blocked ticks and dives on the captured tick', () => {
    const { lastAttack, blockedFrom, dive } = ZULRAH_CAPTURE_SIGHT_GIVE_UP;
    expect(dive - blockedFrom).toBe(ZULRAH_LOS_GIVE_UP_TICKS);
    const { run, zulrah, emerged } = emergeAt('east', [24, 64]);
    const third = firstTurn(emerged) + 2 * ZULRAH_ATTACK_SPEED_TICKS;
    expect(holdUntil(run, zulrah, [24, 64], third)).toHaveLength(3);
    standOn(run, [24, 63]);
    const at = (tick: number) => third + (tick - lastAttack);
    let dived: number | null = null;
    while (dived === null && run.world.tick < at(dive) + 5) {
      run.engine.advanceTick([24, 63]);
      expect(zulrah.combat.lastAttackTick).toBe(third);
      if (stateOf(run).stage === 'diving') dived = run.world.tick;
    }
    expect(dived).toBe(at(dive));
  });

  /**
   * Rotation 2 from the start, the pillars in place, the player put on `tileFor`'s tile before every
   * tick: each sink, emerge and attack turn (with its style), and each phase's attack count at its dive.
   */
  function recordTimeline(attacks: boolean, tileFor: (zulrah: NpcActor) => Coordinate, ticks = 700) {
    const run = startRun(7, { zulrahRotation: '2', zulrahAttacks: attacks, zulrahClouds: false });
    installPillars(run);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const sinks: number[] = [];
    const emerges: number[] = [];
    const turns: string[] = [];
    const attacksAtDive: number[] = [];
    let gaveUp = 0;
    let blocked = 0;
    let wasDiving = false;
    for (let i = 0; i < ticks; i++) {
      const tile = tileFor(zulrah);
      standOn(run, tile);
      const blockedBefore = getZulrahState(zulrah)?.blockedTicks ?? 0;
      run.engine.advanceTick([tile[0], tile[1]]);
      const tick = run.world.tick;
      const state = getZulrahState(zulrah);
      const attacked = zulrah.combat.lastAttackTick === tick;
      if (blockedBefore === ZULRAH_LOS_GIVE_UP_TICKS - 1 && state?.blockedTicks === 0 && !attacked) gaveUp += 1;
      if ((state?.blockedTicks ?? 0) > 0) blocked += 1;
      if (attacked) turns.push(`${tick}:${zulrah.combat.attackStyle}`);
      if (zulrah.spawnTick === tick && tick > 1) emerges.push(tick);
      const diving = stateOf(run).stage === 'diving';
      if (diving && !wasDiving) {
        sinks.push(tick);
        attacksAtDive.push(state?.attacksMade ?? -1);
      }
      wasDiving = diving;
    }
    return { sinks, emerges, turns, attacksAtDive, gaveUp, blocked };
  }

  it('keeps every sink, emerge and attack turn with attacks off, the player in sight throughout', () => {
    const seen: Coordinate = [28, 61];
    const on = recordTimeline(true, () => seen);
    const off = recordTimeline(false, () => seen);
    expect(on.blocked).toBe(0);
    expect(on.sinks.length).toBeGreaterThanOrEqual(ZULRAH_ROTATIONS[2].length);
    expect(off).toEqual(on);
  });

  it('draws the same rolls with attacks off, so turning them back on continues an all-on run', () => {
    // Each attack as launched: its tick, projectile, accuracy roll and rolled damage.
    const styles = (offUntil: number) => {
      const run = startRun(7, { zulrahRotation: '2', zulrahAttacks: offUntil === 0 });
      const zulrah = run.zulrah();
      if (!zulrah) throw new Error('No Zulrah');
      const made: string[] = [];
      for (let i = 0; i < 520; i++) {
        if (run.world.tick === offUntil)
          run.engine.setMechanicsConfig({ infiniteHealth: true, zulrahRotation: '2', zulrahAttacks: true });
        run.tick();
        const projectile = run.engine
          .getLastTickEvents()
          .filter(isInfernoVisualEvent)
          .flatMap((v) => v.projectiles)
          .find((p) => p.spotAnimId === ZULRAH_RANGED_SPOTANIM_ID || p.spotAnimId === ZULRAH_MAGIC_SPOTANIM_ID);
        if (!projectile || run.world.tick <= offUntil) continue;
        const hits = run.world.pendingHits.filter(
          (hit) => hit.sourceId === zulrah.id && hit.launchTick === run.world.tick,
        );
        expect(hits).toHaveLength(1);
        const [hit] = hits;
        made.push(`${run.world.tick}:${projectile.spotAnimId}:${hit?.accuracySucceeded}:${hit?.rolledDamage}`);
      }
      return made;
    };
    // Off through rotation 2's first blue phases (indexes 2 and 4), on from its second blue south.
    const resumed = styles(300);
    expect(resumed.length).toBeGreaterThan(10);
    // Both accuracy outcomes and damaging rolls are compared, not only the turns.
    expect(resumed.some((made) => made.endsWith(':false:0'))).toBe(true);
    expect(resumed.some((made) => /:true:[1-9]/.test(made))).toBe(true);
    expect(styles(0).filter((made) => Number(made.split(':')[0]) > 300)).toEqual(resumed);
  });

  it('waits for sight and gives up on the same ticks with attacks off, the player behind a pillar for part of a phase', () => {
    // Green east: seen from (24, 64) for its first two attacks, then hidden on (24, 63) until it gives up.
    const tileFor = (zulrah: NpcActor): Coordinate => {
      const atEast = zulrah.position[0] === ZULRAH_SPOTS.east[0] && zulrah.position[1] === ZULRAH_SPOTS.east[1];
      return atEast && (getZulrahState(zulrah)?.attacksMade ?? 0) >= 2 ? [24, 63] : [24, 64];
    };
    const on = recordTimeline(true, tileFor);
    const off = recordTimeline(false, tileFor);
    expect(on.gaveUp).toBeGreaterThan(0);
    expect(on.attacksAtDive).toContain(2);
    expect(off).toEqual(on);
  });

  it('spits its clouds and snakeling orbs without sight, once it gives up its attacks', () => {
    const run = startRun(3, { zulrahRotation: '1' });
    installPillars(run);
    runToPhase(run, ATTACK_PHASE.south.index);
    const zulrah = run.zulrah();
    if (!zulrah) throw new Error('No Zulrah');
    const hidden: Coordinate = [24, 66];
    standOn(run, hidden);
    const blockedFrom = firstTurn(zulrah.spawnTick ?? 0);
    const specials: number[] = [];
    for (let i = 0; i < 100 && phaseIndexOf(run) === ATTACK_PHASE.south.index; i++) {
      run.engine.advanceTick([hidden[0], hidden[1]]);
      const spat = run.engine
        .getLastTickEvents()
        .filter(isInfernoVisualEvent)
        .some((v) => v.animations.some((a) => a.actorId === ZULRAH_ACTOR_ID && a.clipId === 'attack'));
      if (spat) specials.push(run.world.tick);
    }
    expect(zulrah.combat.lastAttackTick).toBeNull();
    // S S C C S S, the first on the tick after the last blocked one, then every 3 ticks.
    const first = blockedFrom + ZULRAH_LOS_GIVE_UP_TICKS;
    expect(specials).toEqual([0, 1, 2, 3, 4, 5].map((i) => first + i * ZULRAH_ATTACK_SPEED_TICKS));
  });
});
