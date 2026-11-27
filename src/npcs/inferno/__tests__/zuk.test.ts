import { afterEach, describe, expect, it, vi } from 'vitest';
import { CombatSystem } from '../../../core/combat/CombatSystem';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import type { NpcDefinitionContext } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { createInfernoActor } from '../actors';
import { isZukAttackEvent } from '../events';
import { createGlyph, glyphDefinition } from '../glyph';
import { createZuk, zukCastTickSyncedToShield, zukDefinition } from '../zuk';

afterEach(() => {
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

function lifecycleFixture() {
  const world = new SimulationEngine({ encounter: new LobbyEncounter() })['worldState'];
  const player = world.getPlayer();
  if (!player) throw new TypeError('Missing player fixture');
  player.position = [38, 46];
  const glyph = createGlyph({ id: 'glyph', position: [37, 48], spawnTick: 0, targetEndpoint: 1 });
  const zuk = createZuk({
    id: 'zuk',
    position: [28, 52],
    spawnTick: 0,
    openingDelayTicks: 13,
    glyphId: glyph.id,
  });
  world.actors.set(glyph.id, glyph);
  world.actors.set(zuk.id, zuk);
  const context: NpcDefinitionContext = {
    tick: 0,
    world,
    tickEvents: new TickEvents(),
    random: () => 0.5,
    spawnNpc: (actor) => world.actors.set(actor.id, actor),
    despawnNpc: (id) => {
      world.actors.delete(id);
    },
    logEvent: () => undefined,
  };
  const targetsPlayer = vi.fn(() => false);
  const registration = zukDefinition.register({
    attacksEnabled: () => true,
    targetsPlayer,
    spawnJad: () => undefined,
    spawnHealers: () => undefined,
  });
  return { world, player, glyph, zuk, context, registration, targetsPlayer };
}

describe('glyph combat lifecycle', () => {
  it('keeps instance identity, position, opening, and glyph association independent', () => {
    const first = createZuk({
      id: 'first-zuk',
      position: [8, 12],
      spawnTick: 100,
      openingDelayTicks: 13,
      glyphId: 'first-glyph',
    });
    const second = createZuk({
      id: 'second-zuk',
      position: [38, 42],
      spawnTick: 200,
      openingDelayTicks: 17,
      glyphId: 'second-glyph',
    });

    first.state.lastCastTick = 113;

    expect(first).toMatchObject({ id: 'first-zuk', position: [8, 12], spawnTick: 100 });
    expect(first.state).toMatchObject({ firstCastTick: 113, glyphId: 'first-glyph', lastCastTick: 113 });
    expect(second).toMatchObject({ id: 'second-zuk', position: [38, 42], spawnTick: 200 });
    expect(second.state).toMatchObject({ firstCastTick: 217, glyphId: 'second-glyph', lastCastTick: null });
  });

  it('casts at spawn plus its opening delay and preserves the subsequent cadence', () => {
    const { world, glyph, context, registration } = lifecycleFixture();
    const zuk = createZuk({
      id: 'late-zuk',
      position: [28, 52],
      spawnTick: 100,
      openingDelayTicks: 13,
      glyphId: glyph.id,
    });
    world.actors.set(zuk.id, zuk);
    const casts: number[] = [];

    for (let tick = 0; tick <= 123; tick++) {
      registration.tick(zuk, { ...context, tick });
      casts.push(
        ...context.tickEvents
          .flush()
          .filter(isZukAttackEvent)
          .map((event) => event.launchTick),
      );
    }

    expect(casts).toEqual([113, 123]);
  });

  it('resolves only each instance glyph association', () => {
    const { world, context, registration } = lifecycleFixture();
    const player = context.world.getPlayer();
    if (!player) throw new TypeError('Missing player fixture');
    world.actors.clear();
    world.actors.set(player.id, player);
    const firstGlyph = createGlyph({ id: 'first-glyph', position: [20, 48], spawnTick: 0, targetEndpoint: 1 });
    const secondGlyph = createGlyph({ id: 'second-glyph', position: [40, 48], spawnTick: 0, targetEndpoint: 1 });
    const first = createZuk({
      id: 'first-zuk',
      position: [18, 52],
      spawnTick: 0,
      openingDelayTicks: 13,
      glyphId: firstGlyph.id,
    });
    const second = createZuk({
      id: 'second-zuk',
      position: [38, 52],
      spawnTick: 0,
      openingDelayTicks: 13,
      glyphId: secondGlyph.id,
    });
    for (const actor of [firstGlyph, secondGlyph, first, second]) world.actors.set(actor.id, actor);

    registration.tick(first, { ...context, tick: 13 });
    registration.tick(second, { ...context, tick: 13 });

    expect(
      context.tickEvents
        .flush()
        .filter(isZukAttackEvent)
        .map((event) => [event.sourceId, event.targetId]),
    ).toEqual([
      [first.id, firstGlyph.id],
      [second.id, secondGlyph.id],
    ]);
  });

  it('passes the source actor identity to threshold spawn paths', () => {
    const { zuk, context } = lifecycleFixture();
    const spawnJad = vi.fn();
    const spawnHealers = vi.fn();
    const registration = zukDefinition.register({
      attacksEnabled: () => true,
      targetsPlayer: () => false,
      spawnJad,
      spawnHealers,
    });

    registration.notifyDamageResolved(
      zuk,
      {
        tick: 50,
        sourceId: 'player',
        targetId: zuk.id,
        attackType: 'range',
        baseDamage: 961,
        effectiveDamage: 961,
        hpBefore: 1200,
        hpAfter: 239,
        activePrayer: null,
        prayedCorrectly: null,
      },
      context,
    );

    expect(spawnJad).toHaveBeenCalledExactlyOnceWith(zuk.id, context);
    expect(spawnHealers).toHaveBeenCalledExactlyOnceWith(zuk.id, context);
  });

  it('creates detached explicit level-one zero-bonus defenders with 600 HP', () => {
    const first = createInfernoActor('shield', 'first', [0, 0]);
    const second = createInfernoActor('shield', 'second', [0, 0]);

    expect(first.formulaStats).toEqual({
      levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
      offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
      defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
      attributes: [],
    });
    expect(first.vitals).toEqual({ hp: 600, maxHp: 600 });
    expect(first.formulaStats).not.toBe(second.formulaStats);
    expect(first.formulaStats?.levels).not.toBe(second.formulaStats?.levels);
    expect(first.formulaStats?.offensive).not.toBe(second.formulaStats?.offensive);
    expect(first.formulaStats?.defensive).not.toBe(second.formulaStats?.defensive);
    expect(first.formulaStats?.attributes).not.toBe(second.formulaStats?.attributes);
  });

  it('does not request patrol movement or advance its clock after death', () => {
    const { glyph, context } = lifecycleFixture();
    glyph.alive = false;
    const state = structuredClone(glyph.state);
    const registration = glyphDefinition.register({
      endpoints: [
        [17, 48],
        [43, 48],
      ],
      endpointPauseTicks: 4,
    });

    const moves = registration.move(glyph, { ...context, tick: 100 });

    expect(moves).toEqual([]);
    expect(glyph.state).toEqual(state);
  });

  it.each([0, 2, 600])('emits only a nonlethal hit clip when damage is %i', (damage) => {
    const { glyph, context } = lifecycleFixture();
    const registration = glyphDefinition.register({
      endpoints: [
        [17, 48],
        [43, 48],
      ],
      endpointPauseTicks: 4,
    });

    registration.notifyDamageResolved(
      glyph,
      {
        tick: 0,
        sourceId: 'mager',
        targetId: glyph.id,
        attackType: 'magic',
        baseDamage: damage,
        effectiveDamage: damage,
        hpBefore: 600,
        hpAfter: 600 - damage,
        activePrayer: null,
        prayedCorrectly: null,
      },
      context,
    );

    expect(context.tickEvents.flush()).toEqual(
      damage < 600
        ? [
            expect.objectContaining({
              type: 'encounter_visual',
              animations: [{ actorId: glyph.id, clipId: 'hit', delayCycles: 0 }],
              projectiles: [],
              graphics: [],
            }),
          ]
        : [],
    );
  });

  it.each(['missing', 'dead'] as const)('continues casts at 13 and 23 when the glyph starts %s', (condition) => {
    const { world, glyph, zuk, context, registration, targetsPlayer } = lifecycleFixture();
    if (condition === 'missing') world.actors.delete(glyph.id);
    else glyph.alive = false;
    const casts: number[] = [];

    for (let tick = 0; tick <= 23; tick++) {
      const result = registration.tick(zuk, { ...context, tick });
      for (const attack of result.npcAttacks ?? []) {
        casts.push(tick);
        expect(attack.targetId).toBe('player');
      }
    }

    expect(casts).toEqual([13, 23]);
    expect(targetsPlayer).not.toHaveBeenCalled();
    expect(
      context.tickEvents
        .flush()
        .filter(isEncounterVisualEvent)
        .every((cue) => cue.animations.length === 1),
    ).toBe(true);
  });

  it.each([false, true])('preserves the existing cast clock after glyph destruction with enrage %s', (enraged) => {
    const { world, player, glyph, zuk, context, registration } = lifecycleFixture();
    const first = registration.tick(zuk, { ...context, tick: 13 });
    expect(first.npcAttacks).toBeUndefined();
    glyph.alive = false;
    if (enraged) zuk.state.enragedAt = 15;
    const system = new CombatSystem({ enablePendingHits: true });
    const casts: number[] = [];
    const hp = player.vitals.hp;

    for (let tick = 14; tick <= 23; tick++) {
      world.tick = tick;
      system.processPendingHits(world, { events: context.tickEvents });
      if (registration.tick(zuk, { ...context, tick }).npcAttacks?.length) casts.push(tick);
    }

    expect(casts).toEqual([enraged ? 20 : 23]);
    expect(player.vitals.hp).toBe(hp);
  });

  it('never submits glyph damage or rolls accuracy for covered Zuk blasts', () => {
    const { glyph, zuk, context, registration } = lifecycleFixture();
    const random = vi.fn(() => 0.5);

    for (let tick = 0; tick <= 43; tick++) {
      expect(registration.tick(zuk, { ...context, tick, random }).npcAttacks).toBeUndefined();
    }

    expect(glyph.vitals.hp).toBe(600);
    expect(random).not.toHaveBeenCalled();
    expect(
      context.tickEvents
        .flush()
        .filter(isZukAttackEvent)
        .map((event) => event.launchTick),
    ).toEqual([13, 23, 33, 43]);
  });
});

describe('Zuk hitpoints cap exception', () => {
  it('keeps an exposed blast lethal after healing during flight', () => {
    const { world, player, zuk, context, registration, targetsPlayer } = lifecycleFixture();
    targetsPlayer.mockReturnValue(true);
    player.vitals.hp = 10;
    world.tick = 13;
    const attack = registration.tick(zuk, { ...context, tick: 13, random: () => 0.5 }).npcAttacks?.[0];
    if (!attack) throw new TypeError('Expected exposed Zuk blast');
    const combat = new CombatSystem({ enablePendingHits: true });
    const bridge = { events: context.tickEvents };
    combat.processAttackRequest(world, { attacker: zuk, target: player, attack }, bridge);
    player.vitals.hp += 20;
    world.tick += attack.impactDelayTicks;

    combat.processPendingHits(world, bridge);

    expect(player.vitals.hp).toBe(0);
    expect(player.alive).toBe(false);
    expect(context.tickEvents.flush()).toContainEqual(expect.objectContaining({ type: 'hit_applied', damage: 74 }));
  });
});

describe('Zuk launch presentation', () => {
  it.each([
    { position: [31, 55], end: 16, start: 16, hitDelay: 0 },
    { position: [31, 54], end: 26, start: 26, hitDelay: 0 },
    { position: [31, 53], end: 36, start: 36, hitDelay: 1 },
    { position: [31, 52], end: 46, start: 46, hitDelay: 1 },
    { position: [31, 51], end: 56, start: 50, hitDelay: 1 },
  ] as const)('keeps the shieldless close-range blast valid at arrival $end', ({ position, end, start, hitDelay }) => {
    const { world, player, glyph, zuk, context, registration } = lifecycleFixture();
    world.actors.delete(glyph.id);
    player.position = [...position];

    const result = registration.tick(zuk, { ...context, tick: 13 });

    const cue = context.tickEvents.flush().find(isEncounterVisualEvent);
    expect(cue?.projectiles).toHaveLength(1);
    expect(cue?.projectiles[0]).toMatchObject({ startDelayCycles: start, endDelayCycles: end });
    expect(result.npcAttacks?.[0]).toMatchObject({ targetId: player.id, impactDelayTicks: hitDelay });
  });

  it.each([false, true])('schedules only the target-specific reaction when exposed is %s', (exposed) => {
    const world = new SimulationEngine({ encounter: new LobbyEncounter() })['worldState'];
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player fixture');
    player.position = [38, 46];
    const glyph = createGlyph({ id: 'glyph', position: [37, 48], spawnTick: 0, targetEndpoint: 1 });
    const zuk = createZuk({
      id: 'zuk',
      position: [28, 52],
      spawnTick: 0,
      openingDelayTicks: 13,
      glyphId: glyph.id,
    });
    for (const actor of [player, glyph, zuk]) world.actors.set(actor.id, actor);
    const context: NpcDefinitionContext = {
      tick: 13,
      world,
      tickEvents: new TickEvents(),
      random: () => 0.5,
      spawnNpc: (actor) => world.actors.set(actor.id, actor),
      despawnNpc: (id) => {
        world.actors.delete(id);
      },
      logEvent: () => undefined,
    };

    zukDefinition
      .register({
        attacksEnabled: () => true,
        targetsPlayer: () => exposed,
        spawnJad: () => undefined,
        spawnHealers: () => undefined,
      })
      .tick(zuk, context);

    const cue = context.tickEvents.flush().find(isEncounterVisualEvent);
    expect(cue?.projectiles[0]?.endDelayCycles).toBe(106);
    expect(cue?.animations).toEqual([
      { actorId: 'zuk', clipId: 'attack', delayCycles: 0 },
      ...(!exposed ? [{ actorId: glyph.id, clipId: 'hit', delayCycles: 106 }] : []),
    ]);
    expect(cue?.graphics).toEqual(
      exposed
        ? [
            {
              spotAnimId: 131,
              target: { kind: 'actor', actorId: 'player', size: 1, position: [38, 46] },
              height: 124,
              delayCycles: 106,
            },
          ]
        : [],
    );
  });
});

describe('Zuk attack timer projection', () => {
  it('counts down to the first cast before Zuk has cast anything', () => {
    const { zuk, context, registration } = lifecycleFixture();

    expect(registration.attackTimer(zuk, { ...context, tick: 0 })).toEqual({ nextAttackTick: 13, attackSpeed: 10 });
  });

  it('follows the ten-tick cadence off the last cast', () => {
    const { zuk, context, registration } = lifecycleFixture();
    const state = zukDefinition.getState(zuk);
    if (!state) throw new TypeError('Expected Zuk state');
    state.lastCastTick = 13;

    expect(registration.attackTimer(zuk, { ...context, tick: 14 })).toEqual({
      nextAttackTick: 23,
      attackSpeed: 10,
    });
  });

  it('tightens to the seven-tick cadence once past the enrage tick', () => {
    const { zuk, context, registration } = lifecycleFixture();
    const state = zukDefinition.getState(zuk);
    if (!state) throw new TypeError('Expected Zuk state');
    state.lastCastTick = 100;
    state.enragedAt = 100;

    expect([
      registration.attackTimer(zuk, { ...context, tick: 100 }),
      registration.attackTimer(zuk, { ...context, tick: 101 }),
    ]).toEqual([
      { nextAttackTick: 110, attackSpeed: 10 },
      { nextAttackTick: 107, attackSpeed: 7 },
    ]);
  });

  it('reports no timer while Zuk attacks are disabled', () => {
    const { zuk, context } = lifecycleFixture();
    const disabled = zukDefinition.register({
      attacksEnabled: () => false,
      targetsPlayer: () => false,
      spawnJad: () => undefined,
      spawnHealers: () => undefined,
    });

    expect(disabled.attackTimer(zuk, { ...context, tick: 0 })).toBeNull();
  });
});

describe('zukCastTickSyncedToShield', () => {
  it.each([
    { lastResolvedTick: 0, expected: 13 },
    { lastResolvedTick: 12, expected: 13 },
    { lastResolvedTick: 13, expected: 23 },
    { lastResolvedTick: 14, expected: 23 },
    { lastResolvedTick: 22, expected: 23 },
    { lastResolvedTick: 23, expected: 33 },
    { lastResolvedTick: 32, expected: 33 },
  ])('returns $expected for lastResolvedTick=$lastResolvedTick at a tick-0 shield spawn', ({
    lastResolvedTick,
    expected,
  }) => {
    expect(zukCastTickSyncedToShield(0, 13, lastResolvedTick)).toBe(expected);
  });

  it('anchors to a non-zero shield spawn tick, not tick zero', () => {
    expect(zukCastTickSyncedToShield(20, 13, 20)).toBe(33);
    expect(zukCastTickSyncedToShield(20, 13, 33)).toBe(43);
  });

  it('always returns a tick strictly after lastResolvedTick, never a repeat or earlier slot', () => {
    for (let lastResolvedTick = 0; lastResolvedTick <= 100; lastResolvedTick++) {
      expect(zukCastTickSyncedToShield(0, 13, lastResolvedTick)).toBeGreaterThan(lastResolvedTick);
    }
  });
});
