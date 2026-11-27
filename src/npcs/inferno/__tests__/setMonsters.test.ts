import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NpcActor } from '../../../core/actors/NpcActor';
import { CombatSystem } from '../../../core/combat/CombatSystem';
import { canNpcAttack, hasNpcAttackReach } from '../../../core/combat/npcAttackRequest';
import { notifyNpcOfPlayerAttack, processNpcRetaliations } from '../../../core/combat/retaliation';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import type { EncounterContext } from '../../../core/encounters/types';
import { type EncounterVisualEvent, isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import { NpcDefinitionCollection, type NpcDefinitionContext } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { getMonsterFormulaStats, getMonsterHp } from '../../../data/monsterData';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { CollisionFlag } from '../../../rs/collision/CollisionFlag';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import type { Coordinate } from '../../../types/simulation';
import { createInfernoActor } from '../actors';
import { ZUK_SEQS } from '../constants';
import { isZukAttackEvent } from '../events';
import { createGlyph, glyphDefinition } from '../glyph';
import { type InfernoCorpse, resurrectableSpecies } from '../resurrection';
import {
  createMager,
  createRanger,
  magerDefinition,
  type RangerOptions,
  rangerDefinition,
  type SetMonsterSpawnOptions,
} from '../setMonsters';
import { createInfernoWaveNpc } from '../waveNpcs';
import { ZUK_WAVE_GRAPHICS } from './fixtures/zukWaveGraphicsCapture';
import { createWaveEngine } from './waveFixture';

const rangerPackets = ZUK_WAVE_GRAPHICS.filter((packet) => packet.id === 1377);

const definitions = new NpcDefinitionCollection([
  glyphDefinition.register({
    endpoints: [
      [10, 20],
      [20, 20],
    ],
    endpointPauseTicks: 1,
  }),
  magerDefinition.register(undefined),
  rangerDefinition.register(undefined),
]);

class SetFixtureEncounter extends LobbyEncounter {
  constructor(readonly actors: NpcActor[]) {
    super();
  }
  override getIntroConfig() {
    return null;
  }
  override getArenaConfig() {
    return { bounds: null, walkableTiles: null, collisionMap: null };
  }
  override createNpcs() {
    return this.actors;
  }
  getNpcDefinitions() {
    return definitions;
  }
  processNpcTick(actor: NpcActor, context: EncounterContext) {
    return {
      environmentalDamages: [],
      npcAttacks: definitions.tick(actor, { ...context, random: alternatingRoll() }).npcAttacks ?? [],
    };
  }
}

function alternatingRoll() {
  let roll = 0;
  return () => (roll++ % 2 === 0 ? 0 : 0.999999);
}

function fixture(actors: NpcActor[]) {
  const engine = new SimulationEngine({ encounter: new SetFixtureEncounter(actors), startPos: [10, 20] });
  const world = engine['worldState'];
  const events = new TickEvents();
  const context = (tick: number): NpcDefinitionContext => {
    world.tick = tick;
    events.setTick(tick);
    return {
      tick,
      world,
      tickEvents: events,
      random: alternatingRoll(),
      spawnNpc: (actor) => world.actors.set(actor.id, actor),
      despawnNpc: (id) => world.actors.delete(id),
      logEvent: () => undefined,
    };
  };
  return { engine, world, events, context };
}

const options = {
  id: 'independent',
  position: [10, 10],
  spawnTick: 20,
  initialTargetId: 'player',
  initialDelayTicks: 2,
} satisfies SetMonsterSpawnOptions;

function createTestMager(spawnOptions: SetMonsterSpawnOptions) {
  return createMager({ ...spawnOptions, attackRange: 12 });
}

function createZukRanger(spawnOptions: SetMonsterSpawnOptions) {
  return createRanger({ variant: 'zuk', ...spawnOptions });
}

afterEach(() => {
  vi.restoreAllMocks();
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

describe.each([
  {
    create: createTestMager,
    species: 'mager',
    size: 4,
    primary: 'magic',
    kind: 'melee_stab',
    maxHit: 52,
    defence: 'defenceStab',
  },
  {
    create: createZukRanger,
    species: 'ranger',
    size: 3,
    primary: 'range',
    kind: 'melee_crush',
    maxHit: 19,
    defence: 'defenceCrush',
  },
] as const)('$species adjacent melee policy', ({ create, species, size, primary, kind, maxHit, defence }) => {
  it.each([
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ])('attacks once with melee at footprint edge direction (%i, %i)', (directionX, directionY) => {
    const actor = create(options);
    const { context, world, events } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing melee target');
    player.position = [10 + (directionX > 0 ? size : directionX), 10 + (directionY > 0 ? size : directionY)];
    const random = vi
      .fn(() => 0.999999)
      .mockReturnValueOnce(0.499999)
      .mockReturnValueOnce(0);

    const result = definitions.tick(actor, { ...context(22), random });

    expect(result.npcAttacks).toMatchObject([
      { style: 'melee', attackKind: kind, rolledDamage: maxHit, accuracySucceeded: true, impactDelayTicks: 0 },
    ]);
    const emitted = events.flush();
    expect(emitted.filter(isZukAttackEvent)).toMatchObject([
      { attack: `${species}_melee`, sourceId: actor.id, targetId: player.id, launchTick: 22, impactTick: 22 },
    ]);
    expect(emitted.filter(isZukAttackEvent)[0]).not.toHaveProperty('projectileArrivalCycles');
    expect(emitted.filter(isEncounterVisualEvent)).toMatchObject([
      {
        animations: [{ actorId: actor.id, clipId: 'melee', delayCycles: 0 }],
        projectiles: [],
        graphics: [],
      },
    ]);
    const deltaX = player.position[0] + 0.5 - actor.position[0] - size / 2;
    const deltaY = player.position[1] + 0.5 - actor.position[1] - size / 2;
    expect(actor.facing).toBe((Math.round((Math.atan2(-deltaX, -deltaY) * 2048) / (2 * Math.PI)) + 2048) % 2048);
    expect(actor.combat).toMatchObject({ attackStyle: primary, nextActionTick: 26 });
    expect(random).toHaveBeenCalledTimes(3);
    if (directionX !== 0 && directionY !== 0) {
      expect(
        canNpcAttack({ ...actor, combat: { ...actor.combat, meleeReach: 'cardinal' } }, player, {
          formulaStyle: kind,
          damageType: 'melee',
          attackKind: kind,
          impactDelayTicks: 0,
        }),
      ).toBe(false);
    }
  });

  it.each([0.5, 0.999999])('keeps the primary attack when the adjacent style draw is %s', (draw) => {
    const actor = create(options);
    const { context, world, events } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing melee target');
    player.position = [9, 9];
    const random = vi.fn(() => 0).mockReturnValueOnce(draw);

    const result = definitions.tick(actor, { ...context(22), random });

    expect(result.npcAttacks).toMatchObject([{ style: primary }]);
    expect(events.flush().filter(isEncounterVisualEvent)[0]?.projectiles).toHaveLength(species === 'mager' ? 1 : 2);
    expect(random).toHaveBeenCalledTimes(3);
  });

  it.each([
    [8, 10],
    [8, 8],
    [10, 20],
  ])('preserves two primary RNG draws at nonadjacent tile (%i, %i)', (tileX, tileY) => {
    const actor = create(options);
    const { context, world } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing melee target');
    player.position = [tileX, tileY];
    const random = vi.fn(() => 0);

    const result = definitions.tick(actor, { ...context(22), random });

    expect(result.npcAttacks).toMatchObject([{ style: primary }]);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it.each([
    'overlap',
    'opening',
    'cooldown',
    'dead-attacker',
    'dead-target',
    'missing-target',
    'out-of-range',
  ] as const)('consumes no RNG when %s prevents an attack', (condition) => {
    const actor = create(options);
    const { context, world, events } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing melee target');
    player.position = [9, 9];
    let tick = 22;
    switch (condition) {
      case 'overlap':
        player.position = [10 + size - 1, 10 + size - 1];
        break;
      case 'opening':
        tick = 21;
        break;
      case 'cooldown':
        actor.combat.nextActionTick = 23;
        break;
      case 'dead-attacker':
        actor.alive = false;
        break;
      case 'dead-target':
        player.alive = false;
        break;
      case 'missing-target':
        world.actors.delete(player.id);
        break;
      case 'out-of-range':
        player.position = [50, 50];
        break;
      default:
        throw new TypeError(`Unknown melee condition: ${condition satisfies never}`);
    }
    const random = vi.fn(() => 0);

    const result = definitions.tick(actor, { ...context(tick), random });

    expect(result.npcAttacks ?? []).toEqual([]);
    expect(events.flush()).toEqual([]);
    expect(random).not.toHaveBeenCalled();
  });

  it.each([false, true])('uses target-to-attacker LOS at the diagonal corner, attacker blocked: %s', (blocked) => {
    const actor = create(options);
    const { context, world, events } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing melee target');
    player.position = [9, 9];
    const flags = new Int32Array(64 * 64);
    const blockingTile = blocked ? 10 : 9;
    flags[blockingTile + blockingTile * 64] = CollisionFlag.OBJECT_PROJECTILE_BLOCKER;
    setArenaConfig({
      bounds: null,
      walkableTiles: null,
      collisionMap: {
        sizeX: 64,
        sizeY: 64,
        flags,
        getFlag: (tileX, tileY) => flags[tileX + tileY * 64],
        hasFlag: (tileX, tileY, flag) => (flags[tileX + tileY * 64] & flag) !== 0,
        flag: (tileX, tileY, flag) => {
          flags[tileX + tileY * 64] |= flag;
        },
        unflag: (tileX, tileY, flag) => {
          flags[tileX + tileY * 64] &= ~flag;
        },
      },
    });
    const random = vi.fn(() => 0);

    const result = definitions.tick(actor, { ...context(22), random });

    expect(result.npcAttacks ?? []).toHaveLength(blocked ? 0 : 1);
    expect(random).toHaveBeenCalledTimes(blocked ? 0 : 3);
    expect(
      events
        .flush()
        .filter(isZukAttackEvent)
        .map((event) => event.attack),
    ).toEqual(blocked ? [] : [`${species}_melee`]);
  });

  it.each([
    'defenceStab',
    'defenceCrush',
  ] as const)('rolls accuracy against the appropriate %s bonus', (boostedDefence) => {
    const actor = create(options);
    const { context, world } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing melee target');
    player.position = [9, 9];
    player.equipmentStats = { ...player.equipmentStats, defenceStab: 0, defenceCrush: 0, [boostedDefence]: 100000 };
    const random = vi
      .fn(() => 0.999999)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.1);

    const result = definitions.tick(actor, { ...context(22), random });

    expect(result.npcAttacks).toMatchObject([
      { attackKind: kind, accuracySucceeded: boostedDefence !== defence, rolledDamage: maxHit },
    ]);
  });

  it('shares the four-tick clock across primary, melee and distant primary attacks', () => {
    const actor = create(options);
    const { context, world, events } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing melee target');
    const random = vi.fn(() => 0);
    const attacks = [];

    for (let tick = 22; tick <= 30; tick++) {
      player.position = tick === 26 ? [9, 9] : [10, 20];
      attacks.push(...(definitions.tick(actor, { ...context(tick), random }).npcAttacks ?? []));
    }

    expect(attacks.map((attack) => attack.style)).toEqual([primary, 'melee', primary]);
    expect(
      events
        .flush()
        .filter(isZukAttackEvent)
        .map((event) => event.launchTick),
    ).toEqual([22, 26, 30]);
    expect(actor.combat).toMatchObject({ attackStyle: primary, nextActionTick: 34 });
    expect(random).toHaveBeenCalledTimes(7);
  });

  it('melees a diagonal multi-tile glyph without retargeting to the adjacent player', () => {
    const glyph = createInfernoActor('shield', 'glyph', [7, 7]);
    const actor = create({ ...options, initialTargetId: glyph.id });
    const { context, world } = fixture([actor, glyph]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing melee target');
    player.position = [9, 10];

    const result = definitions.tick(actor, { ...context(22), random: () => 0 });

    expect(result.npcAttacks).toMatchObject([
      { targetId: glyph.id, style: 'melee', attackKind: kind, impactDelayTicks: 0 },
    ]);
    expect(actor.combat.targetId).toBe(glyph.id);
  });
});

describe('named Zuk ranger preset', () => {
  const spawnOptions = {
    id: 'zuk-ranger',
    position: [35, 39],
    spawnTick: 36,
    initialTargetId: 'glyph',
    initialDelayTicks: 8,
    variant: 'zuk',
  } satisfies RangerOptions;

  it('applies identity and combat defaults when the zuk variant is selected', () => {
    const actor = createRanger(spawnOptions);

    expect(actor).toMatchObject({
      npcTypeId: 7702,
      archetypeId: 'zuk_ranger',
      size: 3,
      spawnTick: 36,
      position: [35, 39],
      combat: { attackRange: 16, attackSpeed: 4, attackStyle: 'range', targetId: 'glyph' },
      state: { firstActionTick: 44 },
    });
    expect(actor.vitals).toEqual({ hp: getMonsterHp(7702), maxHp: getMonsterHp(7702) });
    expect(actor.formulaStats).toEqual(getMonsterFormulaStats(7702));
    expect(actor.definition).toBe(rangerDefinition.identity);
    expect(rangerDefinition.isActor(actor)).toBe(true);
  });

  it('isolates mutable dataset stats when another ranger is damaged and drained', () => {
    const first = createRanger(spawnOptions);
    const second = createRanger({ ...spawnOptions, id: 'second' });
    const baseline = getMonsterFormulaStats(7702);
    if (!first.formulaStats) throw new TypeError('Missing ranger formula stats');

    first.vitals.hp = 1;
    first.vitals.maxHp = 2;
    first.formulaStats.levels.defence = 1;
    first.formulaStats.levels.ranged = 2;
    first.formulaStats.offensive.rangedStr = 3;
    first.formulaStats.defensive.rangedStandard = 4;
    const subsequent = createRanger({ ...spawnOptions, id: 'subsequent' });

    for (const actor of [second, subsequent]) {
      expect(actor.vitals).toEqual({ hp: getMonsterHp(7702), maxHp: getMonsterHp(7702) });
      expect(actor.formulaStats).toEqual(baseline);
    }
    expect(getMonsterFormulaStats(7702)).toEqual(baseline);
  });

  it('isolates spawn state when another ranger moves and receives a retaliation', () => {
    const first = createRanger(spawnOptions);
    const second = createRanger({ ...spawnOptions, id: 'second' });
    const baselineCombat = structuredClone(second.combat);

    first.position[0] = 1;
    first.previousPosition[1] = 2;
    first.combat.nextActionTick = 90;
    first.combat.lastAttackTick = 86;
    first.combat.attackRange = 2;
    first.combat.attackSpeed = 9;
    first.combat.animations.attack = 123;
    notifyNpcOfPlayerAttack(first, {
      sourceId: 'player',
      launchTick: 40,
      impactTick: 43,
      style: 'range',
      accuracySucceeded: true,
    });
    const subsequent = createRanger({ ...spawnOptions, id: 'subsequent' });

    expect(first.combat.retaliation?.pending).not.toEqual([]);
    for (const actor of [second, subsequent]) {
      expect(actor.position).toEqual([35, 39]);
      expect(actor.previousPosition).toEqual([35, 39]);
      expect(actor.combat).toEqual(baselineCombat);
      expect(actor.state).toEqual({ firstActionTick: 44 });
      expect(actor.state).not.toBe(first.state);
      expect(actor.definition).toBe(rangerDefinition.identity);
    }
    expect(spawnOptions.position).toEqual([35, 39]);
  });
});

describe('reusable Jal-Zek and Jal-Xil long-range actions', () => {
  it.each([
    createTestMager,
    createZukRanger,
  ])('pursues a live target during cooldown and stops at attack reach', (create) => {
    const actor = create({ ...options, position: [10, 0], spawnTick: 0, initialDelayTicks: 1 });
    actor.combat.nextActionTick = 30;
    const { engine } = fixture([actor]);
    const initial = [...actor.position];

    for (let tick = 1; tick <= 20; tick++) engine.advanceTick([10, 20]);

    expect(actor.position).not.toEqual(initial);
    expect(actor.position[1] + actor.size - 1 + actor.combat.attackRange).toBe(20);
    expect(actor.isMoving).toBe(false);
    expect(actor.movementPath).toEqual([]);
    expect(actor.combat).toMatchObject({ targetId: 'player', nextActionTick: 30 });
    expect(engine.getDamageHistory()).toEqual([]);
  });

  it.each([createTestMager, createZukRanger])('resumes pursuit exactly at the end of a scheduled freeze', (create) => {
    const actor = create({ ...options, position: [10, 0], spawnTick: 0, initialDelayTicks: 30 });
    actor.debuffs = { boundFromTick: 1, boundUntilTick: 3 };
    const { engine } = fixture([actor]);
    const positions = [];

    for (let tick = 1; tick <= 3; tick++) {
      engine.advanceTick([10, 20]);
      positions.push([...actor.position]);
    }

    expect(positions).toEqual([
      [10, 0],
      [10, 0],
      [10, 1],
    ]);
    expect(actor.state.firstActionTick).toBe(30);
    expect(actor.combat.targetId).toBe('player');
  });

  it.each([
    createTestMager,
    createZukRanger,
  ])('does not reacquire a missing glyph during the movement phase', (create) => {
    const actor = create({
      ...options,
      position: [10, 0],
      spawnTick: 0,
      initialDelayTicks: 1,
      initialTargetId: 'missing-glyph',
    });
    actor.combat.nextActionTick = 4;
    const { engine } = fixture([actor]);
    const observed = [];

    for (let tick = 1; tick <= 5; tick++) {
      engine.advanceTick([10, 20]);
      observed.push({ position: [...actor.position], target: actor.combat.targetId });
    }

    expect(observed).toEqual([
      { position: [10, 0], target: 'missing-glyph' },
      { position: [10, 0], target: 'missing-glyph' },
      { position: [10, 0], target: 'missing-glyph' },
      { position: [10, 0], target: 'player' },
      { position: [10, 1], target: 'player' },
    ]);
  });

  it.each([
    createTestMager,
    createZukRanger,
  ])('preserves spawn identity when an explicit spawn tick is supplied', (create) => {
    const actor = create({ ...options, spawnTick: 47 });
    expect(actor.spawnTick).toBe(47);
  });

  it.each([
    { create: createTestMager, style: 'magic', damage: 70, delay: 3, projectiles: 1, range: 12 },
    { create: createZukRanger, style: 'range', damage: 46, delay: 3, projectiles: 2, range: 16 },
  ])('uses shared formulas for $style with supported player targets', ({
    create,
    style,
    damage,
    delay,
    projectiles,
    range,
  }) => {
    const actor = create(options);
    const { context, events } = fixture([actor]);
    const result = definitions.tick(actor, context(22));
    expect(result.npcAttacks).toEqual([
      expect.objectContaining({
        attackerId: 'independent',
        targetId: 'player',
        style,
        rolledDamage: damage,
        accuracySucceeded: true,
        impactDelayTicks: delay,
      }),
    ]);
    const cues = events.flush();
    expect(cues.find(isEncounterVisualEvent)?.projectiles).toHaveLength(projectiles);
    expect(cues.filter(isZukAttackEvent)).toMatchObject([
      { sourceId: actor.id, targetId: 'player', launchTick: 22, impactTick: 25 },
    ]);
    expect(actor.combat).toMatchObject({ attackSpeed: 4, nextActionTick: 26, attackRange: range });
  });

  it('emits recorded ranger pairs through the live definition when the player moves between attacks', () => {
    const actor = createZukRanger({ ...options, position: [35, 39] });
    const { world, events, context } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player fixture');
    const volleys: EncounterVisualEvent[] = [];
    const attackTicks: number[] = [];
    const facing: number[] = [];
    const recordedTicks = [106, 110, 114];

    for (let tick = 22; tick <= 30; tick++) {
      const recordedTick = recordedTicks[Math.floor((tick - 22) / 4)];
      const target = rangerPackets.find((packet) => packet.tick === recordedTick)?.target;
      if (!target) throw new TypeError('Missing recorded ranger target');
      player.position = [target[0], target[1]];
      const result = definitions.tick(actor, context(tick));
      const emitted = events.flush();
      volleys.push(...emitted.filter(isEncounterVisualEvent));
      attackTicks.push(...emitted.filter(isZukAttackEvent).map((event) => event.launchTick));
      if ((tick - 22) % 4 === 0) {
        expect(result.npcAttacks).toHaveLength(1);
        facing.push(actor.facing);
      } else {
        expect(result.npcAttacks ?? []).toEqual([]);
        expect(emitted).toEqual([]);
      }
    }

    expect(attackTicks).toEqual([22, 26, 30]);
    expect(volleys).toHaveLength(3);
    expect(facing[0]).toBeGreaterThan(1024);
    expect(facing[1]).toBe(1024);
    expect(facing[2]).toBeLessThan(1024);
    for (const [index, volley] of volleys.entries()) {
      const recorded = rangerPackets.filter((packet) => packet.tick === recordedTicks[index]);
      expect(volley.animations).toEqual([{ actorId: actor.id, clipId: 'range', delayCycles: 0 }]);
      expect(ZUK_SEQS.ranger.range).toBe(7605);
      expect(volley.graphics).toEqual([]);
      expect(volley.projectiles).toEqual(
        recorded.map((packet) => {
          if (!packet.origin || !packet.target) throw new TypeError('Missing ranger endpoints');
          return {
            spotAnimId: packet.id,
            sourcePosition: [packet.origin[0] + 0.5, packet.origin[1] + 0.5],
            target: {
              kind: 'actor',
              actorId: 'player',
              size: 1,
              position: [packet.target[0], packet.target[1]],
            },
            startDelayCycles: packet.fields.starttime,
            endDelayCycles: packet.fields.endtime,
            slope: packet.fields.angle,
            startOffset: packet.fields.progress,
            startHeight: packet.fields.startheight,
            endHeight: packet.fields.endheight,
          };
        }),
      );
    }
  });

  it('keeps independent clocks and alternate NPC targets without Zuk composition', () => {
    const target = createInfernoActor('ranger', 'practice-target', [10, 20]);
    const first = createTestMager({ ...options, id: 'first', initialTargetId: target.id });
    const second = createTestMager({ ...options, id: 'second', position: [16, 13], initialDelayTicks: 4 });
    const { context } = fixture([first, second, target]);
    const actions: { tick: number; attackerId: string; targetId: string }[] = [];
    for (let tick = 20; tick <= 30; tick++) {
      for (const actor of [first, second]) {
        for (const attack of definitions.tick(actor, context(tick)).npcAttacks ?? []) {
          actions.push({ tick, attackerId: attack.attackerId, targetId: attack.targetId });
        }
      }
    }
    expect(actions).toEqual([
      { tick: 22, attackerId: 'first', targetId: 'practice-target' },
      { tick: 24, attackerId: 'second', targetId: 'player' },
      { tick: 26, attackerId: 'first', targetId: 'practice-target' },
      { tick: 28, attackerId: 'second', targetId: 'player' },
      { tick: 30, attackerId: 'first', targetId: 'practice-target' },
    ]);
  });

  it.each([
    'dead-attacker',
    'dead-target',
    'missing-target',
    'out-of-range',
  ] as const)('emits no action when %s', (condition) => {
    const actor = createZukRanger(options);
    const { context, world, events } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player fixture');
    switch (condition) {
      case 'dead-attacker':
        actor.alive = false;
        break;
      case 'dead-target':
        player.alive = false;
        break;
      case 'missing-target':
        actor.combat.targetId = null;
        break;
      case 'out-of-range':
        actor.combat.attackRange = 2;
        break;
      default: {
        const exhaustive: never = condition;
        throw new TypeError(`Unknown fixture condition: ${exhaustive}`);
      }
    }
    const result = definitions.tick(actor, context(22));
    expect(result.npcAttacks ?? []).toEqual([]);
    expect(events.flush()).toEqual([]);
  });

  it.each([createTestMager, createZukRanger])('returns a real NPC attack when the live glyph is targeted', (create) => {
    const glyph = createInfernoActor('shield', 'alternate-glyph', [10, 20]);
    const actor = create({ ...options, initialTargetId: glyph.id });
    const { context, events } = fixture([actor, glyph]);
    const random = vi.fn(() => 0);
    const result = definitions.tick(actor, { ...context(22), random });
    expect(result.npcAttacks).toMatchObject([
      { attackerId: actor.id, targetId: glyph.id, accuracySucceeded: true, rolledDamage: 0, impactDelayTicks: 3 },
    ]);
    const visuals = events.flush().filter(isEncounterVisualEvent);
    expect(visuals).toHaveLength(1);
    expect(visuals[0].projectiles).toHaveLength(create === createZukRanger ? 2 : 1);
    expect(visuals[0].projectiles.map((projectile) => projectile.target)).toEqual(
      Array.from({ length: create === createZukRanger ? 2 : 1 }, () => ({
        kind: 'actor',
        actorId: glyph.id,
        size: 3,
        position: glyph.position,
      })),
    );
    expect(random).toHaveBeenCalledTimes(2);
    expect(glyph.vitals.hp).toBe(600);
    expect(actor.combat.nextActionTick).toBe(26);
  });

  // NPC→NPC timing pinned through the engine's turn order. The glyph takes its turn before the set, as
  // its lower index does in capture inferno-waves-69-zuk-packet-data.txt (46150 vs Jal-Zek 46913),
  // and Jal-Zek's endtime-140 cast at t104 lands on it at t108: floor(140 / 30) = 4 ticks.
  it('lands a Jal-Zek cast on a glyph processed before it floor(endtime / 30) ticks after launch (t104 -> t108)', () => {
    const glyph = createGlyph({ id: 'glyph', position: [10, 20], spawnTick: 0, targetEndpoint: 1 });
    // Size-4 mager: center [12, 34], 14 tiles from the glyph's base, so endtime 28 + 8 * 14 = 140.
    const mager = createMager({ ...options, position: [10, 32], initialTargetId: glyph.id, attackRange: 15 });
    const { engine, world } = fixture([glyph, mager]);
    expect([glyph.processingOrder, mager.processingOrder]).toEqual([0, 1]);
    const launches: { launchTick: number; impactTick: number }[] = [];

    for (let tick = 1; tick <= 30 && launches.length === 0; tick++) {
      engine.advanceTick([10, 20]);
      launches.push(
        ...engine
          .getLastTickEvents()
          .filter(isZukAttackEvent)
          .filter((event) => event.sourceId === mager.id && event.targetId === glyph.id),
      );
    }
    const [launch] = launches;
    if (!launch) throw new TypeError('Expected a Jal-Zek cast on the glyph');
    while (engine.currentTick < launch.launchTick + 5) engine.advanceTick([10, 20]);

    expect(launch.impactTick - launch.launchTick).toBe(4);
    expect(engine.getDamageHistory().flatMap((entry) => (entry.targetId === glyph.id ? [entry.tick] : []))).toEqual([
      launch.launchTick + 4,
    ]);
    expect(world.getNpc(glyph.id)).toBe(glyph);
  });

  // Inferno 1-68: 1312 -> 1313 and 7288 -> 7289: a ranged NPC killed on its attack tick still fires,
  // its released projectile lands, and it dies the tick after.
  it.each([
    createTestMager,
    createZukRanger,
  ])('fires on its killing tick, and the released projectile still lands after it dies', (create) => {
    const actor = create({ ...options, spawnTick: 0, initialDelayTicks: 2, position: [10, 10] });
    const { engine } = fixture([actor]);
    engine.setMechanicsConfig({ infiniteHealth: true });
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: actor.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 0,
      impactTick: 2,
      rolledDamage: actor.vitals.hp,
      accuracySucceeded: true,
    });
    engine.advanceTick([10, 20]);
    engine.advanceTick([10, 20]);
    const [shot] = engine.getLastTickEvents().filter(isZukAttackEvent);
    expect(actor).toMatchObject({ alive: false, death: { killTick: 2, processTick: 3 }, deathAnimationTick: 3 });
    expect(shot).toMatchObject({ sourceId: actor.id, targetId: 'player', launchTick: 2 });
    if (!shot) throw new TypeError('Expected the killing-tick shot');

    while (engine.currentTick < shot.impactTick) engine.advanceTick([10, 20]);

    expect(shot.impactTick).toBeGreaterThan(2);
    expect(
      engine
        .getDamageHistory()
        .filter((entry) => entry.targetId === 'player')
        .map((entry) => [entry.tick, entry.sourceNpcTypeId]),
    ).toEqual([[shot.impactTick, actor.npcTypeId]]);
  });

  it.each([createTestMager, createZukRanger])('allows formula misses against the glyph', (create) => {
    const glyph = createInfernoActor('shield', 'glyph', [10, 20]);
    const actor = create({ ...options, initialTargetId: glyph.id });
    const { context } = fixture([actor, glyph]);

    const result = definitions.tick(actor, { ...context(22), random: () => 0.999999 });

    expect(result.npcAttacks?.[0]).toMatchObject({ targetId: glyph.id, accuracySucceeded: false });
  });

  it.each([
    createTestMager,
    createZukRanger,
  ])('reacquires the player only on its ready action after glyph removal', (create) => {
    const glyph = createInfernoActor('shield', 'glyph', [10, 20]);
    const actor = create({ ...options, initialTargetId: glyph.id });
    const { context, world } = fixture([actor, glyph]);
    definitions.tick(actor, context(22));
    world.actors.delete(glyph.id);
    for (let tick = 23; tick < 26; tick++) {
      expect(definitions.tick(actor, context(tick)).npcAttacks).toBeUndefined();
      expect(actor.combat.targetId).toBe(glyph.id);
    }

    const result = definitions.tick(actor, context(26));

    expect(result.npcAttacks?.[0]?.targetId).toBe('player');
    expect(actor.combat.targetId).toBe('player');
  });

  it.each([
    createTestMager,
    createZukRanger,
  ])('reacquires after glyph death but does not steal player aggro for a new glyph', (create) => {
    const glyph = createInfernoActor('shield', 'glyph', [10, 20]);
    glyph.alive = false;
    const replacement = createInfernoActor('shield', 'new-glyph', [10, 20]);
    const actor = create({ ...options, initialTargetId: glyph.id });
    const { context } = fixture([actor, glyph, replacement]);

    const result = definitions.tick(actor, context(22));

    expect(result.npcAttacks?.[0]?.targetId).toBe('player');
    expect(actor.combat.targetId).toBe('player');
  });

  it.each([createTestMager, createZukRanger])('leaves a lost target unchanged when the player is dead', (create) => {
    const actor = create({ ...options, initialTargetId: 'removed-glyph' });
    const { context, world } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player fixture');
    player.alive = false;

    const result = definitions.tick(actor, context(22));

    expect(result.npcAttacks).toBeUndefined();
    expect(actor.combat.targetId).toBe('removed-glyph');
  });

  it.each([
    'retargeted-source',
    'dead-target',
    'missing-target',
  ] as const)('uses the pending-hit target policy when a launched glyph attack has %s', (condition) => {
    const glyph = createInfernoActor('shield', 'glyph', [10, 20]);
    const actor = createTestMager({ ...options, initialTargetId: glyph.id });
    const { context, world, events } = fixture([actor, glyph]);
    const system = new CombatSystem({ enablePendingHits: true });
    const attack = definitions.tick(actor, context(22)).npcAttacks?.[0];
    if (!attack) throw new TypeError('Missing glyph attack');
    system.processAttackRequest(world, { attacker: actor, target: glyph, attack }, { events });
    actor.combat.targetId = 'player';
    if (condition === 'dead-target') glyph.alive = false;
    if (condition === 'missing-target') world.actors.delete(glyph.id);
    world.tick = 25;

    system.processPendingHits(world, { events });

    expect(glyph.vitals.hp).toBe(condition === 'retargeted-source' ? 530 : 600);
    expect(world.pendingHits).toEqual([]);
  });

  it.each([
    createTestMager,
    createZukRanger,
  ])('damages and destroys a live glyph through the engine pipeline', (create) => {
    const glyph = createGlyph({ id: 'glyph', position: [10, 20], spawnTick: 0, targetEndpoint: 1 });
    const actor = create({ ...options, spawnTick: 0, initialDelayTicks: 1, initialTargetId: glyph.id });
    const { engine } = fixture([actor, glyph]);
    engine.advanceTick([10, 20]);
    engine.advanceTick([10, 20]);
    engine.advanceTick([10, 20]);
    expect(glyph.vitals.hp).toBe(600);

    engine.advanceTick([10, 20]);

    expect(glyph.vitals.hp).toBe(create === createTestMager ? 530 : 554);
    expect(engine.getLastTickEvents().filter(isEncounterVisualEvent)).toContainEqual(
      expect.objectContaining({
        type: 'encounter_visual',
        animations: [{ actorId: glyph.id, clipId: 'hit', delayCycles: 0 }],
        projectiles: [],
        graphics: [],
      }),
    );
    for (let tick = 5; tick <= 60 && glyph.alive; tick++) engine.advanceTick([10, 20]);
    expect(glyph.alive).toBe(false);
    expect(glyph.vitals.hp).toBe(0);
    for (let tick = 0; tick < 4; tick++) engine.advanceTick([10, 20]);
    expect(actor.combat.targetId).toBe('player');
  });

  it('rejects broken attacker stats rather than treating them as glyph-only support', () => {
    const glyph = createInfernoActor('shield', 'glyph', [10, 20]);
    const actor = createTestMager({ ...options, initialTargetId: glyph.id });
    actor.formulaStats = undefined;
    const { context, events } = fixture([actor, glyph]);
    expect(() => definitions.tick(actor, context(22))).toThrow('Missing formula stats');
    expect(events.flush()).toEqual([]);
  });

  describe.each([createTestMager, createZukRanger])('standard retaliation for %s', (create) => {
    it.each([
      { style: 'range', impact: 23 },
      { style: 'magic', impact: 25 },
    ] as const)('retargets without advancing either actor on an incoming $style miss', ({ style, impact }) => {
      const glyph = createInfernoActor('shield', 'glyph', [10, 20]);
      const first = create({ ...options, id: 'first', initialTargetId: glyph.id });
      const second = create({ ...options, id: 'second', initialTargetId: glyph.id });
      const { context, world } = fixture([first, second, glyph]);
      definitions.tick(first, context(22));
      definitions.tick(second, context(22));
      notifyNpcOfPlayerAttack(first, {
        sourceId: 'player',
        launchTick: 22,
        impactTick: impact,
        style,
        accuracySucceeded: false,
      });
      const playerShots: number[] = [];
      const glyphShots: number[] = [];
      for (let tick = 23; tick <= 30; tick++) {
        const current = context(tick);
        processNpcRetaliations(world);
        playerShots.push(...(definitions.tick(first, current).npcAttacks ?? []).map(() => tick));
        glyphShots.push(...(definitions.tick(second, current).npcAttacks ?? []).map(() => tick));
      }
      expect(playerShots).toEqual([26, 30]);
      expect(glyphShots).toEqual([26, 30]);
      expect(first.combat.targetId).toBe('player');
      expect(second.combat.targetId).toBe('glyph');
    });

    it.each([
      { phase: 0, firstPlayerAction: 26 },
      { phase: 1, firstPlayerAction: 26 },
      { phase: 2, firstPlayerAction: 26 },
      { phase: 3, firstPlayerAction: 27 },
    ])('only extends the mature glyph phase at offset $phase and ignores subsequent player tags', ({
      phase,
      firstPlayerAction,
    }) => {
      const glyph = createInfernoActor('shield', 'glyph', [10, 20]);
      const actor = create({ ...options, initialTargetId: glyph.id });
      const { context, world } = fixture([actor, glyph]);
      const hitTick = 22 + phase;
      const playerShots: number[] = [];

      for (let tick = 22; tick <= firstPlayerAction + 8; tick++) {
        const current = context(tick);
        processNpcRetaliations(world);
        for (const attack of definitions.tick(actor, current).npcAttacks ?? []) {
          if (attack.targetId === 'player') playerShots.push(tick);
        }
        if (tick >= hitTick)
          notifyNpcOfPlayerAttack(actor, {
            sourceId: 'player',
            launchTick: tick,
            impactTick: tick,
            style: 'melee',
            accuracySucceeded: true,
          });
      }

      expect(playerShots).toEqual([firstPlayerAction, firstPlayerAction + 4, firstPlayerAction + 8]);
    });
  });

  describe.each([
    { create: createTestMager, opening: 6 },
    { create: createZukRanger, opening: 8 },
  ])('immutable opening floor $opening', ({ create, opening }) => {
    it.each([0, 1, 2, 5, 7])('uses max(opening, reaction readiness) for a tag at spawn+%s', (offset) => {
      const actor = create({ ...options, initialTargetId: 'glyph', initialDelayTicks: opening });
      const { context } = fixture([actor]);
      const hitTick = options.spawnTick + offset;
      const expected = Math.max(options.spawnTick + opening, hitTick + 2);
      const attacks: number[] = [];
      notifyNpcOfPlayerAttack(actor, {
        sourceId: 'player',
        launchTick: hitTick,
        impactTick: hitTick,
        style: 'melee',
        accuracySucceeded: true,
      });

      for (let tick = hitTick + 1; tick <= expected + 4; tick++) {
        attacks.push(...(definitions.tick(actor, context(tick)).npcAttacks ?? []).map(() => tick));
      }

      expect(attacks).toEqual([expected, expected + 4]);
      expect(actor.state.firstActionTick).toBe(options.spawnTick + opening);
    });
  });

  it.each([
    { create: createTestMager, spawn: 98, opening: 6, launch: 119, impact: 122, expected: 124 },
    { create: createTestMager, spawn: 448, opening: 6, launch: 469, impact: 472, expected: 474 },
    { create: createTestMager, spawn: 1229, opening: 6, launch: 1254, impact: 1257, expected: 1259 },
    { create: createZukRanger, spawn: 98, opening: 8, launch: 100, impact: 103, expected: 106 },
    { create: createZukRanger, spawn: 448, opening: 8, launch: 450, impact: 453, expected: 456 },
    { create: createZukRanger, spawn: 1229, opening: 8, launch: 1232, impact: 1235, expected: 1237 },
  ])('matches the recorded hit $impact to first player action $expected through the engine', ({
    create,
    spawn,
    opening,
    launch,
    impact,
    expected,
  }) => {
    const glyph = createInfernoActor('shield', 'glyph', [10, 20]);
    const actor = create({ ...options, spawnTick: spawn, initialDelayTicks: opening, initialTargetId: glyph.id });
    const { engine, world, events } = fixture([actor, glyph]);
    engine.setMechanicsConfig({ infiniteHealth: true });
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player fixture');
    // The engine only drains hits its own CombatSystem queued.
    const combat = Reflect.get(engine, 'combatSystem') as CombatSystem;
    const playerShots: number[] = [];

    for (let tick = 1; tick <= expected + 4; tick++) {
      engine.advanceTick([10, 20]);
      playerShots.push(
        ...engine
          .getLastTickEvents()
          .filter(isZukAttackEvent)
          .filter((event) => event.sourceId === actor.id && event.targetId === player.id)
          .map((event) => event.launchTick),
      );
      if (tick === launch)
        combat.processAttackRequest(
          world,
          {
            attacker: player,
            target: actor,
            attack: {
              style: 'range',
              attackKind: 'range_arrow',
              rolledDamage: 0,
              accuracySucceeded: true,
              impactDelayTicks: impact - launch,
            },
          },
          { events, enablePendingHits: true },
        );
    }

    expect(playerShots).toEqual([expected, expected + 4]);
  });

  it.each([
    createTestMager,
    createZukRanger,
  ])('applies delayed HP loss and faces the target in the engine', (create) => {
    const actor = create({ ...options, spawnTick: 0, initialDelayTicks: 1 });
    const { engine, world } = fixture([actor]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player fixture');
    const before = player.vitals.hp;
    engine.advanceTick([10, 20]);
    expect(actor.combat.lastAttackTick).toBe(1);
    expect(actor.facing).not.toBe(0);
    expect(player.vitals.hp).toBe(before);
    for (let tick = 2; tick <= 4; tick++) engine.advanceTick([10, 20]);
    expect(player.vitals.hp).toBeLessThan(before);
    expect(engine.getLastTickEvents().some((event) => event.type === 'hitsplat_spawned')).toBe(true);
  });
});

describe('ordinary-wave Jal-Xil and Jal-Zek', () => {
  it('builds 7698 with reach 15, not wave 69 reach 16', () => {
    const ordinary = createInfernoWaveNpc('ranger', { id: 'xil', position: [10, 2], spawnTick: 0, targetId: 'player' });
    const zuk = createZukRanger({ ...options, id: 'zuk-xil', position: [10, 2] });
    const { world } = fixture([ordinary, zuk]);
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player');
    player.position = [10, 20];

    expect(ordinary).toMatchObject({ npcTypeId: 7698, size: 3, combat: { attackRange: 15, attackSpeed: 4 } });
    // North edge y 4 is 16 tiles from the player.
    expect(hasNpcAttackReach(ordinary, player, ordinary.combat.attackRange)).toBe(false);
    expect(hasNpcAttackReach(zuk, player, zuk.combat.attackRange)).toBe(true);
    expect(hasNpcAttackReach({ ...ordinary, position: [10, 3] }, player, ordinary.combat.attackRange)).toBe(true);
  });

  it('builds 7699 with reach 15 and a live 1376 projectile', () => {
    const mager = createInfernoWaveNpc('mager', { id: 'zek', position: [10, 5], spawnTick: 0, targetId: 'player' });
    const { advanceTo, events } = createWaveEngine([mager]);
    advanceTo(1);
    expect(mager).toMatchObject({ npcTypeId: 7699, size: 4, combat: { attackRange: 15 } });
    expect(events.filter(isEncounterVisualEvent)[0]?.projectiles).toMatchObject([{ spotAnimId: 1376 }]);
  });
});

describe('Jal-Zek resurrection', () => {
  function rezFixture(corpses: InfernoCorpse[]) {
    const revived: { corpse: InfernoCorpse; position: Coordinate; tick: number }[] = [];
    const mager = createInfernoWaveNpc('mager', { id: 'zek', position: [10, 5], spawnTick: 0, targetId: 'player' });
    const fixture = createWaveEngine([mager], {
      resurrection: {
        eligibleCorpses: () => corpses,
        revive: (corpse, position, context) => {
          corpses.splice(corpses.indexOf(corpse), 1);
          revived.push({ corpse, position, tick: context.tick });
          context.spawnNpc(
            createInfernoWaveNpc(corpse.species, {
              id: `revived-${corpse.id}`,
              position,
              spawnTick: context.tick,
              targetId: 'player',
              origin: 'resurrection',
            }),
          );
        },
      },
    });
    return { ...fixture, mager, revived };
  }

  it('resurrects on a 1/10 draw instead of attacking, then attacks again at rez+8', () => {
    const { random, advanceTo, events, revived, world, engine } = rezFixture([{ id: 'bat', species: 'bat' }]);
    random.next = () => 0.05;
    advanceTo(1);

    expect(revived).toHaveLength(1);
    const [{ position, tick }] = revived;
    expect(tick).toBe(1);
    expect(position[0]).toBeGreaterThanOrEqual(31);
    expect(position[0]).toBeLessThanOrEqual(37);
    expect(position[1]).toBeGreaterThanOrEqual(28);
    expect(position[1]).toBeLessThanOrEqual(34);
    const bat = world.getNpc('revived-bat');
    expect(bat).toMatchObject({ npcTypeId: 7692, vitals: { hp: 13, maxHp: 25 } });
    // Revived during the NPC turns, it takes an ordinary first step that tick (toward the player at
    // (10,20)); the captured add tile is where that step ends (20/34 revivals step).
    expect(bat?.position).toEqual([position[0] - 1, position[1] - 1]);
    const visual = events.filter(isEncounterVisualEvent).find((event) => event.animations[0]?.clipId === 'resurrect');
    expect(visual).toMatchObject({
      tick: 1,
      animations: [{ actorId: 'zek', clipId: 'resurrect' }],
      graphics: [{ spotAnimId: 444, height: 150, target: { kind: 'tile', position } }],
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'game_message',
        kind: 'spam',
        segments: [{ text: 'Jal-Zek uses his power to trigger the rebirth of a fallen foe.' }],
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'inferno_ability', tick: 1, ability: 'mager_resurrect', position: [10, 5] }),
    );
    expect(engine.getDamageHistory()).toEqual([]);

    // The mager's next attack is rez+8.
    advanceTo(9);
    const casts = events
      .filter(isEncounterVisualEvent)
      .filter((event) => event.animations.some((cue) => cue.actorId === 'zek' && cue.clipId === 'magic'));
    expect(casts.map((event) => event.tick)).toEqual([9]);
  });

  it('puts graphic 444 at the birth SW tile + (size - 2) and births inside x 31-37, y 28-34', () => {
    const { random, advanceTo, events, revived } = rezFixture([{ id: 'blob', species: 'blob' }]);
    random.next = () => 0.05;
    advanceTo(1);

    const [{ position }] = revived;
    const visual = events.filter(isEncounterVisualEvent).find((event) => event.animations[0]?.clipId === 'resurrect');
    expect(visual?.graphics[0]?.target).toEqual({ kind: 'tile', position: [position[0] + 1, position[1] + 1] });
    expect(position[0] >= 31 && position[0] <= 37 && position[1] >= 28 && position[1] <= 34).toBe(true);
  });

  it.each([
    { corpses: [], draws: 2, rezzed: false },
    { corpses: [{ id: 'blob', species: 'blob' }], draws: 3, rezzed: false },
  ] as const)('attacks without a resurrection: $corpses.length corpses', ({ corpses, draws, rezzed }) => {
    const { random, advanceTo, revived, engine } = rezFixture([...corpses]);
    const draw = vi.fn(() => 0.5);
    random.next = draw;
    advanceTo(1);
    // A magic attack draws accuracy and damage; the 1/10 roll only happens with a corpse to revive.
    expect(draw).toHaveBeenCalledTimes(draws);
    expect(revived.length > 0).toBe(rezzed);
    expect(engine.getDamageHistory()).toHaveLength(0);
  });

  it('only offers bats, blobs, meleers, rangers and magers', () => {
    expect(
      [7691, 7692, 7693, 7694, 7695, 7696, 7697, 7698, 7699, 7700, 7701, 7702, 7703].map((npcTypeId) =>
        resurrectableSpecies({ npcTypeId }),
      ),
    ).toEqual([null, 'bat', 'blob', null, null, null, 'meleer', 'ranger', 'mager', null, null, null, null]);
  });
});
