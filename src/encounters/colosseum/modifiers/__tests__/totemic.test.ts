import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import { isEncounterVisualEvent } from '../../../../core/events/encounterVisual';
import { TickEvents } from '../../../../core/events/TickEvents';
import { isCoreEvent } from '../../../../core/events/types';
import { WorldState } from '../../../../core/WorldState';
import { getMonsterHp } from '../../../../data/monsterData';
import { createColosseumActor } from '../../../../npcs/colosseum/actors';
import {
  COLOSSEUM_SEQS,
  COLOSSEUM_SPOTANIMS,
  HEALING_TOTEM_NPC_ID,
  HEALING_TOTEM_PROJECTILE,
} from '../../../../npcs/colosseum/constants';
import type { Coordinate } from '../../../../types/simulation';
import {
  advanceHealingTotem,
  createHealingTotem,
  healingTotemSpawnTile,
  TOTEM_FIRST_LAUNCH_TICKS,
  TOTEM_HEAL_FLIGHT_TICKS,
  TOTEM_LAUNCH_INTERVAL_TICKS,
} from '../totemic';
import {
  type CapturedTotem,
  TOTEM_CAPTURE_HEALS,
  TOTEM_CAPTURE_LIVES,
  TOTEM_CAPTURE_NPC_TYPES,
  TOTEM_CAPTURE_PROJECTILES,
  TOTEM_CAPTURE_TOTEMS,
} from './fixtures/healingTotemCapture';

/**
 * Max hitpoints of every NPC type in the capture, from the OSRS Wiki monster infoboxes. Most are
 * Colosseum waves the simulator never spawns, so `monsters.json` does not carry them.
 */
const CAPTURE_NPC_MAX_HP: Readonly<Record<number, number>> = {
  12810: 125, // Jaguar warrior
  12811: 125, // Serpent shaman
  12812: 225, // Minotaur
  12814: 50, // Fremennik warband archer
  12815: 50, // Fremennik warband seer
  12816: 48, // Fremennik warband berserker
  12817: 220, // Javelin Colossus
  12818: 250, // Manticore
  12819: 125, // Shockwave Colossus
  12821: 1500, // Sol Heredit
  12825: 1, // Healing totem
};

function fixture(targetHp = 100, targetMaxHp = 200) {
  const world = new WorldState();
  const target = createColosseumActor('bees', 'wounded', [10, 10]);
  target.vitals = { hp: targetHp, maxHp: targetMaxHp };
  world.actors.set(target.id, target);
  const totem = createHealingTotem({ id: 'totem', position: [9, 9], target, healAmount: 60, tick: 0 });
  world.actors.set(totem.id, totem);
  const events = new TickEvents();
  const step = (tick: number) => {
    events.setTick(tick);
    advanceHealingTotem(totem, { tick, world, tickEvents: events });
    return events.flush();
  };
  return { world, target, totem, step };
}

describe('healing totem', () => {
  it('is a 1 HP minion every player hit lands on, facing the NPC it heals', () => {
    const { totem } = fixture();
    expect(getMonsterHp(HEALING_TOTEM_NPC_ID)).toBe(1);
    expect(totem).toMatchObject({
      npcTypeId: HEALING_TOTEM_NPC_ID,
      size: 1,
      role: 'minion',
      spawnTick: 0,
      blocksNpcMovement: false,
      vitals: { hp: 1, maxHp: 1 },
      formulaStats: { alwaysAccuratePlayerHit: true },
      combat: {
        targetId: 'wounded',
        animations: { idle: COLOSSEUM_SEQS.totem.idle, attack: COLOSSEUM_SEQS.totem.attack },
      },
    });
  });

  it('launches at spawn+7 and every 6 ticks while its target is hurt; each heal lands 6 ticks later', () => {
    const { target, step } = fixture();
    const launches: number[] = [];
    const heals: [number, number][] = [];
    for (let tick = 1; tick <= 30; tick++) {
      for (const event of step(tick)) {
        if (isCoreEvent(event, 'hitsplat_spawned') && event.hitsplatType === 'heal') heals.push([tick, event.amount]);
        if (isEncounterVisualEvent(event) && event.projectiles?.length) launches.push(tick);
      }
    }
    expect(TOTEM_FIRST_LAUNCH_TICKS).toBe(7);
    expect(TOTEM_LAUNCH_INTERVAL_TICKS).toBe(6);
    expect(TOTEM_HEAL_FLIGHT_TICKS).toBe(6);
    // 100 -> 160 at 13 -> 200 (capped at the 40 missing) at 19; full from then, so no launch at 19.
    expect(launches).toEqual([7, 13]);
    expect(heals).toEqual([
      [13, 60],
      [19, 40],
    ]);
    expect(target.vitals.hp).toBe(200);
  });

  it('emits the captured clip, projectile and impact', () => {
    const { target, totem, step } = fixture();
    for (let tick = 1; tick < 7; tick++) expect(step(tick)).toEqual([]);
    const [launch] = step(7).filter(isEncounterVisualEvent);
    expect(launch).toMatchObject({
      animations: [{ actorId: totem.id, clipId: 'attack', delayCycles: 0 }],
      graphics: [],
      projectiles: [
        {
          ...HEALING_TOTEM_PROJECTILE,
          sourcePosition: [9.5, 9.5],
          target: { kind: 'actor', actorId: target.id, size: target.size, position: [10, 10] },
        },
      ],
    });
    for (let tick = 8; tick < 13; tick++) step(tick);
    expect(step(13).filter(isEncounterVisualEvent)[0]).toMatchObject({
      graphics: [
        {
          spotAnimId: COLOSSEUM_SPOTANIMS.totemImpact,
          target: { kind: 'attached', actorId: target.id },
          delayCycles: 0,
        },
      ],
    });
  });

  it('waits at full HP and launches on the first tick its target is hurt again (A:934+37 -> +39)', () => {
    const { target, step } = fixture(200);
    for (let tick = 1; tick <= 9; tick++) expect(step(tick)).toEqual([]);
    target.vitals.hp = 199;
    expect(step(10).some(isEncounterVisualEvent)).toBe(true);
    for (let tick = 11; tick < 16; tick++) expect(step(tick).some(isEncounterVisualEvent)).toBe(false);
  });

  it('heals nothing once destroyed or once its target is dead', () => {
    const killed = fixture();
    for (let tick = 1; tick <= 8; tick++) killed.step(tick);
    killed.totem.alive = false;
    for (let tick = 9; tick <= 20; tick++) expect(killed.step(tick)).toEqual([]);
    expect(killed.target.vitals.hp).toBe(100);

    const orphaned = fixture();
    for (let tick = 1; tick <= 8; tick++) orphaned.step(tick);
    orphaned.target.alive = false;
    for (let tick = 9; tick <= 20; tick++) expect(orphaned.step(tick)).toEqual([]);
  });

  describe('spawn tile', () => {
    const target = { position: [10, 10] as Coordinate, size: 3 };
    const allow =
      (...blocked: Coordinate[]) =>
      (tile: Coordinate) =>
        !blocked.some(([x, y]) => x === tile[0] && y === tile[1]);

    it('prefers the south-west diagonal, then the north-east one past the footprint', () => {
      expect(healingTotemSpawnTile(target, allow())).toEqual([9, 9]);
      expect(healingTotemSpawnTile(target, allow([9, 9]))).toEqual([13, 13]);
    });

    it('otherwise takes the free ring tile nearest the south-west diagonal', () => {
      expect(healingTotemSpawnTile(target, allow([9, 9], [13, 13]))).toEqual([10, 9]);
      expect(healingTotemSpawnTile(target, allow([9, 9], [13, 13], [10, 9]))).toEqual([9, 10]);
      expect(healingTotemSpawnTile(target, () => false)).toBeNull();
    });
  });
});

/**
 * Run A's 55 wave totems (A:850–4832; none in its Sol fight), extracted from the capture.
 * Denominators are stated in each expectation.
 */
describe('healing totem capture conformance (Run A)', () => {
  /** One NPC from its `add` to its `del`; indices are reused, so a target is a life, not an index. */
  interface Life {
    readonly index: number;
    readonly add: number;
    readonly del: number | null;
    readonly fills: readonly (readonly [tick: number, fill: number])[];
    /** Default-slot spotanims by tick. */
    readonly spotanims: ReadonlyMap<number, readonly string[]>;
  }
  interface Totem extends Omit<CapturedTotem, 'life' | 'target'> {
    readonly life: Life;
    /** From the add tick's `facing npc=`, else its first projectile's target. */
    readonly target: Life | null;
  }
  const lives: readonly Life[] = TOTEM_CAPTURE_LIVES.map((life) => ({ ...life, spotanims: new Map(life.spotanims) }));
  const totems = new Map<number, Totem>(
    TOTEM_CAPTURE_TOTEMS.map((totem) => [
      totem.index,
      { ...totem, life: lives[totem.life]!, target: totem.target === null ? null : lives[totem.target]! },
    ]),
  );
  const projectiles = TOTEM_CAPTURE_PROJECTILES;
  const heals = TOTEM_CAPTURE_HEALS;
  const maxHp = new Map(TOTEM_CAPTURE_NPC_TYPES.map(([index, npcId]) => [index, CAPTURE_NPC_MAX_HP[npcId]!]));
  const targeted = [...totems.values()].filter((totem) => totem.target !== null);
  const deathTick = (life: Life) => life.fills.find(([, fill]) => fill === 0)?.[0] ?? null;
  const killTick = (totem: Totem) => totem.hits.at(-1)?.[0] ?? null;

  it('flies every heal projectile with the captured fields, one per attack sequence', () => {
    const expected = {
      startTime: HEALING_TOTEM_PROJECTILE.startDelayCycles,
      endTime: HEALING_TOTEM_PROJECTILE.endDelayCycles,
      angle: HEALING_TOTEM_PROJECTILE.slope,
      progress: HEALING_TOTEM_PROJECTILE.startOffset,
      startHeight: HEALING_TOTEM_PROJECTILE.startHeight,
      endHeight: HEALING_TOTEM_PROJECTILE.endHeight,
    };
    expect(totems.size).toBe(55);
    expect(projectiles).toHaveLength(53);
    expect(projectiles.filter((projectile) => isDeepStrictEqual(projectile.fields, expected))).toHaveLength(53);
    const launches = [...totems.values()].flatMap((totem) => totem.launches.map((tick) => `${totem.index}@${tick}`));
    expect(projectiles.map((projectile) => `${projectile.totem}@${projectile.tick}`).sort()).toEqual(launches.sort());
  });

  it('first launches at spawn+7 (35 of the 36 that could) and relaunches 6 ticks later (17/18)', () => {
    const launching = [...totems.values()].filter((totem) => totem.launches.length > 0);
    expect(launching.map((totem) => totem.launches[0]! - totem.add)).toEqual(
      launching.map(() => TOTEM_FIRST_LAUNCH_TICKS),
    );
    expect(launching).toHaveLength(35);
    const gaps = launching.flatMap((totem) => totem.launches.slice(1).map((tick, i) => tick - totem.launches[i]!));
    expect(gaps).toHaveLength(18);
    expect(gaps.filter((gap) => gap === TOTEM_LAUNCH_INTERVAL_TICKS)).toHaveLength(17);
  });

  it('heals floor(30%) of max HP, capped at the missing HP, 6 ticks after a higher-index totem launches', () => {
    const landed = projectiles.flatMap((projectile) => {
      const heal = heals.find(
        (candidate) =>
          candidate.target === projectile.target &&
          candidate.tick > projectile.tick &&
          candidate.tick <= projectile.tick + 6,
      );
      return heal
        ? [{ ...heal, delay: heal.tick - projectile.tick, aboveTarget: projectile.totem > projectile.target }]
        : [];
    });
    expect(landed).toHaveLength(19);
    expect(landed.filter((heal) => heal.aboveTarget && heal.delay === TOTEM_HEAL_FLIGHT_TICKS)).toHaveLength(16);
    expect(landed.filter((heal) => !heal.aboveTarget && heal.delay === TOTEM_HEAL_FLIGHT_TICKS - 1)).toHaveLength(3);
    const full = landed.filter((heal) => heal.amount === Math.floor(maxHp.get(heal.target)! * 0.3));
    // The other two topped their target up: A:2283+19 (54 of 67) and A:934+37 (27 of 37).
    expect(full).toHaveLength(17);
  });

  it('takes exactly 1 from every player hit and never a 0 (43/43 hit totems)', () => {
    const hit = [...totems.values()].filter((totem) => totem.hits.length > 0);
    expect(hit).toHaveLength(43);
    expect(hit.flatMap((totem) => totem.hits.map(([, splat]) => splat))).toEqual(hit.map(() => '16:1'));
  });

  it("appears as its target's headbar first reaches 15 or 14 of 30, never at 16+ (54/54 known targets)", () => {
    expect(targeted).toHaveLength(54); // A:1695 neither faced nor launched at anything
    const timing = targeted.map((totem) => {
      const fills = totem.target!.fills;
      const first15 = fills.find(([, fill]) => fill <= 15)![0];
      const first14 = fills.find(([, fill]) => fill <= 14)?.[0];
      const fillAt15 = fills.filter(([tick]) => tick === first15).at(-1)![1];
      return totem.add === first15
        ? 'first <= 15'
        : totem.add === first14 && fillAt15 === 15
          ? 'waited at 15'
          : 'other';
    });
    // fill = 1 + floor(29 * hp / max), so 15 straddles half HP: 3 came at exactly 15 (A:889/3326/3665).
    expect(timing.filter((kind) => kind === 'first <= 15')).toHaveLength(50);
    expect(timing.filter((kind) => kind === 'waited at 15')).toHaveLength(4);
  });

  it('never gives a target a second totem, even after a kill or a fall back through half HP', () => {
    const targets = targeted.map((totem) => totem.target!);
    expect(new Set(targets).size).toBe(targeted.length);
    const outlived = targeted.flatMap((totem) => {
      const killed = killTick(totem);
      const died = deathTick(totem.target!);
      return killed !== null && died !== null && died > totem.life.del! ? [died - totem.life.del!] : [];
    });
    expect(outlived).toHaveLength(36);
    expect(Math.max(...outlived)).toBe(50); // A:1592's Javelin Colossus
    const fellBack = targeted.filter((totem) => {
      const after = totem.target!.fills.filter(([tick]) => tick > totem.add);
      const healedOver = after.findIndex(([, fill]) => fill >= 16);
      return healedOver >= 0 && after.slice(healedOver).some(([, fill]) => fill > 0 && fill <= 14);
    });
    // Healed back over half, then below it again: A:3665 while its totem lived, 5 after the kill.
    expect(fellBack.map((totem) => totem.add)).toEqual([934, 1026, 1592, 2283, 3665, 4425]);
  });

  it('removes a killed totem 3 ticks after the kill, or with its dying target (55/55)', () => {
    const removal = [...totems.values()].map((totem) => {
      const killed = killTick(totem);
      const died = totem.target && deathTick(totem.target);
      const del = totem.life.del!;
      if (killed !== null && del === killed + 3) return 'kill+3';
      if (died !== null && died !== undefined && (del === died || del === died + 1)) return 'target death+0/1';
      return 'other';
    });
    expect(removal.filter((kind) => kind === 'kill+3')).toHaveLength(37);
    // 6 killed totems whose target died first, and all 12 unkilled ones.
    expect(removal.filter((kind) => kind === 'target death+0/1')).toHaveLength(18);
  });

  it('shows 2688 on every heal unless the target shows another default-slot spotanim (19/19)', () => {
    const lifeAt = (index: number, tick: number) =>
      targeted.map((totem) => totem.target!).find((life) => life.index === index && life.add <= tick)!;
    const shown = heals.map((heal) => lifeAt(heal.target, heal.tick).spotanims.get(heal.tick) ?? []);
    expect(shown.filter((ids) => ids.includes('vfx_colosseum_totem_impact_01'))).toHaveLength(17);
    // A:1616 Javelin's own npc_colossi_javelin_01_artillery_fire, A:4444 sanguinesti_staff_heal.
    expect(shown.filter((ids) => ids.length === 1 && !ids.includes('vfx_colosseum_totem_impact_01'))).toHaveLength(2);
  });
});
