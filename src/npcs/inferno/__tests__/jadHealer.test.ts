import { afterEach, describe, expect, it, vi } from 'vitest';
import { CombatSystem, type DamageAppliedInfo } from '../../../core/combat/CombatSystem';
import { isNpcInMeleeRange } from '../../../core/combat/npcAttackRequest';
import { processPlayerAutoAttack } from '../../../core/combat/player/PlayerAutoAttackSystem';
import { notifyNpcOfPlayerAttack, processNpcRetaliations } from '../../../core/combat/retaliation';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import { npcFootprintsOverlap } from '../../../core/npcOccupancy';
import type { NpcDefinitionContext } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { RUNE } from '../../../data/spellRunes';
import { createZukWaveEncounter } from '../../../test/helpers/zukWave';
import { createEmptyCombatSupplies } from '../../../types/encounterLoadout';
import { createEmptyStats } from '../../../types/equipmentStats';
import type { Coordinate } from '../../../types/simulation';
import { createInfernoActor } from '../actors';
import { isZukAttackEvent } from '../events';
import { createJadHealer, jadHealerDefinition } from '../jadHealer';

afterEach(() => {
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

function fixture() {
  const world = new SimulationEngine({ encounter: createZukWaveEncounter(0) })['worldState'];
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  const player = world.getPlayer();
  if (!player) throw new TypeError('Missing player');
  world.actors.clear();
  world.actors.set(player.id, player);
  const parent = createInfernoActor('jad', 'arbitrary-parent', [25, 35]);
  parent.vitals.hp -= 100;
  const first = createJadHealer({ id: 'first', position: [25, 40], spawnTick: 0, parentId: parent.id });
  const second = createJadHealer({ id: 'second', position: [26, 40], spawnTick: 0, parentId: parent.id });
  for (const actor of [parent, first, second]) world.actors.set(actor.id, actor);
  player.position = [25, 41];
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
  return { world, player, parent, first, second, context };
}

describe('Jad healer independent support and engagement', () => {
  it.each([true, false])('does not start underfoot melee when damage is configured=%s', (configured) => {
    const { first, parent, player, context } = fixture();
    player.position = [...first.position];
    first.combat.targetId = player.id;
    first.combat.nextActionTick = 0;
    const lastAttackTick = first.combat.lastAttackTick;
    const parentHp = parent.vitals.hp;
    const random = vi.fn(() => 0.5);
    const registration = jadHealerDefinition.register({
      sampleHeal: () => 7,
      ...(configured
        ? { melee: { formulaStyle: 'melee_crush', attackKind: 'melee_crush', impactDelayTicks: 0 } as const }
        : {}),
    });

    const result = registration.tick(first, { ...context, random });

    expect(result.npcAttacks).toBeUndefined();
    expect(random).not.toHaveBeenCalled();
    expect(first.combat.nextActionTick).toBe(0);
    expect(first.combat.lastAttackTick).toBe(lastAttackTick);
    expect(parent.vitals.hp).toBe(parentHp);
    const events = context.tickEvents.flush();
    expect(events.filter(isZukAttackEvent)).toEqual([]);
    expect(events.filter(isEncounterVisualEvent).flatMap((event) => event.animations)).toEqual([]);
  });

  it('starts configured melee from valid adjacency while tagged healing stays suppressed', () => {
    const { first, parent, player, context } = fixture();
    first.combat.targetId = player.id;
    const parentHp = parent.vitals.hp;
    const random = vi.fn().mockReturnValueOnce(0).mockReturnValue(0.5);
    const registration = jadHealerDefinition.register({
      sampleHeal: () => 7,
      melee: { formulaStyle: 'melee_stab', attackKind: 'melee_stab', impactDelayTicks: 2, maxHit: 10 },
    });

    const result = registration.tick(first, { ...context, random });

    expect(result.npcAttacks).toMatchObject([
      { attackerId: first.id, targetId: player.id, style: 'melee', attackKind: 'melee_stab', impactDelayTicks: 2 },
    ]);
    expect(random).toHaveBeenCalledTimes(2);
    expect(first.combat).toMatchObject({ lastAttackTick: 0, nextActionTick: 4 });
    expect(first.state.nextHealTick).toBe(0);
    expect(parent.vitals.hp).toBe(parentHp);
    expect(context.tickEvents.flush().filter(isZukAttackEvent)).toMatchObject([
      { sourceId: first.id, attack: 'jad_healer_melee', launchTick: 0, impactTick: 2 },
    ]);
  });

  it('retains support proximity when the healer overlaps its parent', () => {
    const { first, parent, context } = fixture();
    first.position = [...parent.position];
    const parentHp = parent.vitals.hp;
    const registration = jadHealerDefinition.register({ sampleHeal: () => 7 });

    const moves = registration.move(first, context);
    registration.tick(first, context);

    expect(moves).toEqual([]);
    expect(parent.vitals.hp).toBe(parentHp + 7);
    expect(first.state.nextHealTick).toBe(4);
  });

  describe.each(['Ice Burst', 'Ice Barrage'])('%s range-edge tagging', (spell) => {
    describe.each([true, false])('manual cast=%s', (manual) => {
      it.each([
        { label: 'two hits', accurate: [true, true], rolls: [0, 0.5, 0, 0.5], multiplier: 1, healed: 14 },
        {
          label: 'primary splash and secondary zero',
          accurate: [false, true],
          rolls: [0.999999, 0, 0],
          multiplier: 0,
          healed: 7,
        },
        {
          label: 'primary zero and secondary splash',
          accurate: [true, false],
          rolls: [0, 0, 0.999999],
          multiplier: 0,
          healed: 7,
        },
      ])('retains fresh AoE aggression through movement when outcomes are $label', ({
        accurate,
        rolls,
        multiplier,
        healed,
      }) => {
        const { world, player, parent, first, second, context } = fixture();
        parent.position = [25, 36];
        first.position = [25, 41];
        second.position = [26, 41];
        player.position = [15, 41];
        player.equipment = { weapon: 4675 };
        player.equipmentStats = createEmptyStats();
        player.selectedAttackStyleIndex = manual ? 0 : 3;
        player.manualCastSpell = manual ? spell : null;
        player.combatSupplies = {
          ...createEmptyCombatSupplies(),
          spellbook: 'ancient',
          selectedSpell: manual ? null : spell,
          runePouch: {
            kind: 'divine',
            slots: [{ id: RUNE.water }, { id: RUNE.chaos }, { id: RUNE.death }, { id: RUNE.blood }],
          },
        };
        player.attackTarget = first.id;
        player.attackInteractionActive = true;
        const outside = createJadHealer({ id: 'outside', position: [27, 41], spawnTick: 0, parentId: parent.id });
        const byPlayer = createJadHealer({ id: 'by-player', position: [16, 41], spawnTick: 0, parentId: parent.id });
        for (const actor of [outside, byPlayer]) world.actors.set(actor.id, actor);
        for (const actor of [first, second]) actor.debuffs = { boundFromTick: 0, boundUntilTick: 8 };
        const samples = rolls.values();
        const random = vi.fn(() => {
          const roll = samples.next().value;
          if (roll === undefined) throw new TypeError('Unexpected attack roll');
          return roll;
        });
        const combat = new CombatSystem({ random: () => 0.5 });
        const registration = jadHealerDefinition.register({ sampleHeal: () => 7 });
        const parentHp = parent.vitals.hp;
        const damage = vi.fn<(info: DamageAppliedInfo) => void>();

        processPlayerAutoAttack(player, {
          world,
          combatSystem: combat,
          tickEvents: context.tickEvents,
          combatSupplies: player.combatSupplies,
          infiniteHealth: true,
          onDamageApplied: damage,
          encounterRules: { multiCombat: true, outgoingDamageMultiplier: multiplier },
          random,
        });

        expect(
          world.pendingHits.map((hit) => ({
            target: hit.targetId,
            accurate: hit.accuracySucceeded,
            impact: hit.impactTick,
          })),
        ).toEqual([
          { target: first.id, accurate: accurate[0], impact: 5 },
          { target: second.id, accurate: accurate[1], impact: 5 },
        ]);
        // Standard retaliation: a hit reacts on impact, a splash on the tick after the cast.
        expect([first, second].map((actor) => actor.combat.targetId)).toEqual([null, null]);
        expect([first, second].map((actor) => actor.combat.retaliation?.pending)).toEqual(
          accurate.map((hit) => [{ tick: hit ? 5 : 1, sourceId: player.id }]),
        );
        const observations = [];
        for (let tick = 1; tick <= 8; tick++) {
          world.tick = tick;
          processNpcRetaliations(world);
          const acquired = [first, second].map((actor) => actor.combat.targetId);
          for (const actor of [first, second]) {
            for (const move of registration.move(actor, { ...context, tick })) {
              const position = move.path.at(-1);
              if (position) actor.position = position;
            }
            registration.tick(actor, { ...context, tick });
          }
          combat.processPendingHits(world, { events: context.tickEvents, onDamageApplied: damage });
          observations.push({ tick, acquired, retained: [first, second].map((actor) => actor.combat.targetId) });
          if (tick === 7) {
            expect([first.position, second.position]).toEqual([
              [25, 41],
              [26, 41],
            ]);
            expect(parent.vitals.hp).toBe(parentHp + healed);
          }
        }
        expect(observations).toEqual(
          Array.from({ length: 8 }, (_, index) => {
            const tick = index + 1;
            const targets = accurate.map((hit) => (hit && tick < 5 ? null : player.id));
            return { tick, acquired: targets, retained: targets };
          }),
        );
        expect([first.position, second.position]).toEqual([
          [24, 41],
          [25, 41],
        ]);
        expect([first, second].map((actor) => actor.combat.retaliation?.lastIncomingAttackTick)).toEqual(
          accurate.map((hit) => (hit ? 5 : 1)),
        );
        expect([outside, byPlayer].map((actor) => actor.combat.targetId)).toEqual([null, null]);
        expect(damage.mock.calls.map(([info]) => [info.targetId, info.effectiveDamage > 0])).toEqual([
          [first.id, multiplier > 0],
          [second.id, multiplier > 0],
        ]);
      });
    });
  });

  it('faces an untagged support parent without overriding a tagged sibling or duplicating melee audio', () => {
    const { first, second, player, context } = fixture();
    first.combat.targetId = player.id;
    first.facing = 1024;
    const registration = jadHealerDefinition.register(undefined);

    for (const actor of [first, second]) registration.tick(actor, context);

    expect(first.facing).toBe(1024);
    expect(first.actionFacing).toBeUndefined();
    expect(second.facing).not.toBe(0);
    expect(second.combat.targetId).toBeNull();
    expect(context.tickEvents.flush().filter(isZukAttackEvent)).toMatchObject([
      { sourceId: first.id, targetId: player.id, attack: 'jad_healer_melee' },
    ]);
  });
  it('applies supplied healing and delegates the parent graphic to encounter presentation', () => {
    const { first, parent, context } = fixture();
    const hp = parent.vitals.hp;
    const presentHeal = vi.fn();

    jadHealerDefinition.register({ sampleHeal: () => 7, presentHeal }).tick(first, context);

    expect(parent.vitals.hp).toBe(hp + 7);
    expect(presentHeal).toHaveBeenCalledExactlyOnceWith(parent, context);
    expect(context.tickEvents.flush().filter(isEncounterVisualEvent)).toMatchObject([
      { animations: [{ actorId: first.id, clipId: 'heal' }], projectiles: [], graphics: [] },
    ]);
  });

  it.each([true, false])('treats a peer as a corner blocker until it is removed, dying or not (alive %s)', (alive) => {
    const { first, second, player, context } = fixture();
    first.position = [20, 20];
    second.position = [21, 20];
    second.alive = alive;
    player.position = [22, 21];
    first.combat.targetId = player.id;

    // A turn boundary: the engine reconciles placements before each NPC moves.
    context.world.occupancy.reconcile(context.world.actors.values());
    const moves = jadHealerDefinition.register(undefined).move(first, context);

    expect(moves).toEqual([{ npcId: first.id, path: [[20, 21]] }]);
  });

  describe.each(['peer', 'terrain'] as const)('%s corner trapping', (blocker) => {
    it.each([
      { playerPosition: [21, 21], contact: [21, 20] },
      { playerPosition: [21, 19], contact: [21, 20] },
      { playerPosition: [19, 21], contact: [19, 20] },
      { playerPosition: [19, 19], contact: [19, 20] },
    ] satisfies {
      playerPosition: Coordinate;
      contact: Coordinate;
    }[])('holds at diagonal adjacency to $playerPosition when the contact tile is blocked', ({
      playerPosition,
      contact,
    }) => {
      const { first, second, player, context } = fixture();
      first.position = [20, 20];
      first.combat.targetId = player.id;
      player.position = playerPosition;
      second.position = contact;
      second.alive = blocker === 'peer';
      if (blocker === 'terrain') {
        const walkableTiles = new Set<string>();
        for (let x = 19; x <= 21; x++)
          for (let y = 19; y <= 21; y++) if (x !== contact[0] || y !== contact[1]) walkableTiles.add(`${x},${y}`);
        setArenaConfig({ bounds: null, walkableTiles, collisionMap: null }, true);
      }

      // A turn boundary: the engine reconciles placements before each NPC moves.
      context.world.occupancy.reconcile(context.world.actors.values());
      const moves = jadHealerDefinition.register(undefined).move(first, context);

      expect(moves).toEqual([]);
    });
  });

  it.each([
    { random: 0, destination: [20, 19] },
    { random: 0.25, destination: [20, 21] },
    { random: 0.5, destination: [19, 20] },
    { random: 0.75, destination: [21, 20] },
  ] satisfies {
    random: number;
    destination: Coordinate;
  }[])('attempts a cardinal escape toward $destination when its player target is underfoot', ({
    random,
    destination,
  }) => {
    const { first, player, context } = fixture();
    first.position = [20, 20];
    player.position = [20, 20];
    first.combat.targetId = player.id;
    const sample = vi.fn(() => random);

    const moves = jadHealerDefinition.register(undefined).move(first, { ...context, random: sample });

    expect(moves).toEqual([{ npcId: first.id, path: [destination] }]);
    expect(sample).toHaveBeenCalledTimes(1);
  });

  it('stays when its selected underfoot escape is blocked without trying another direction', () => {
    const { first, second, player, context } = fixture();
    first.position = [20, 20];
    player.position = [20, 20];
    first.combat.targetId = player.id;
    second.position = [19, 20];
    const random = vi.fn(() => 0.5);

    // A turn boundary: the engine reconciles placements before each NPC moves.
    context.world.occupancy.reconcile(context.world.actors.values());
    const moves = jadHealerDefinition.register(undefined).move(first, { ...context, random });

    expect(moves).toEqual([]);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it.each(['bound', 'red-x'] as const)('suppresses underfoot escape before RNG when %s', (reason) => {
    const { first, player, context } = fixture();
    player.position = [...first.position];
    first.combat.targetId = player.id;
    if (reason === 'bound') first.debuffs = { boundFromTick: 0, boundUntilTick: 2 };
    else {
      player.attackTarget = first.id;
      player.attackInteractionActive = true;
    }
    const random = vi.fn(() => 0.5);

    const moves = jadHealerDefinition.register(undefined).move(first, { ...context, random });

    expect(moves).toEqual([]);
    expect(random).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: 'underfoot escape', playerPosition: [20, 20], distance: 1 },
    { scenario: 'corner trap', playerPosition: [21, 21], distance: 0 },
  ] satisfies {
    scenario: string;
    playerPosition: Coordinate;
    distance: number;
  }[])('preserves $scenario through successive engine ticks', ({ playerPosition, distance }) => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(7) });
    engine.setMechanicsConfig({ infiniteHealth: true, zukAttacks: false, zukSets: false });
    setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
    const world = engine['worldState'];
    const player = world.getPlayer();
    if (!player) throw new TypeError('Missing player');
    player.position = playerPosition;
    const healer = createJadHealer({ id: 'mover', position: [20, 20], spawnTick: 0, parentId: 'absent' });
    healer.combat.targetId = player.id;
    world.registerNpc(healer);
    if (distance === 0) {
      const blocker = createJadHealer({ id: 'blocker', position: [21, 20], spawnTick: 0, parentId: 'absent' });
      world.registerNpc(blocker);
    }
    const distances = [];

    for (let tick = 0; tick < 4; tick++) {
      engine.advanceTick(player.position);
      distances.push(Math.abs(healer.position[0] - 20) + Math.abs(healer.position[1] - 20));
    }

    expect(distances).toEqual([distance, distance, distance, distance]);
  });

  it('throws when configured melee has broken source formula stats', () => {
    const { first, player, context } = fixture();
    first.combat.targetId = player.id;
    delete first.formulaStats;
    const registration = jadHealerDefinition.register({
      melee: { formulaStyle: 'melee_crush', attackKind: 'melee_crush', impactDelayTicks: 0 },
    });

    expect(() => registration.tick(first, context)).toThrow(new TypeError(`Missing formula stats for ${first.id}`));
  });

  it.each(['missing', 'dead'] as const)('does not require melee formula stats when its target is %s', (condition) => {
    const { first, player, world, context } = fixture();
    first.combat.targetId = player.id;
    delete first.formulaStats;
    if (condition === 'missing') world.actors.delete(player.id);
    else player.alive = false;
    const registration = jadHealerDefinition.register({
      melee: { formulaStyle: 'melee_crush', attackKind: 'melee_crush', impactDelayTicks: 0 },
    });

    registration.move(first, context);
    const result = registration.tick(first, context);

    expect(result.npcAttacks).toBeUndefined();
    expect(first.combat.targetId).toBeNull();
  });

  it('suppresses healing while independently fighting a nearby player', () => {
    const { first, second, parent, context } = fixture();
    notifyNpcOfPlayerAttack(first, {
      sourceId: 'player',
      launchTick: -1,
      impactTick: -1,
      style: 'melee',
      accuracySucceeded: true,
    });
    const registration = jadHealerDefinition.register({ sampleHeal: () => 7 });
    const before = parent.vitals.hp;
    const actions: [string, string, number][] = [];

    for (let tick = 0; tick <= 4; tick++) {
      for (const actor of [first, second]) registration.tick(actor, { ...context, tick });
      for (const event of context.tickEvents.flush().filter(isEncounterVisualEvent))
        for (const cue of event.animations) actions.push([cue.actorId, cue.clipId, tick]);
    }

    expect(parent.vitals.hp).toBe(before + 14);
    // Standard retaliation: an immediate hit at D readies the swing at D + 2.
    expect(actions).toContainEqual(['first', 'melee', 1]);
    expect(actions).toContainEqual(['second', 'heal', 4]);
    expect(second.combat.targetId).toBeNull();
    expect(first.state.parentId).toBe(parent.id);
  });

  it.each([
    { start: [25, 40], firstHealTick: 877 },
    { start: [25, 41], firstHealTick: 878 },
    { start: [25, 43], firstHealTick: 880 },
  ] satisfies {
    start: Coordinate;
    firstHealTick: number;
  }[])('heals immediately in range at $firstHealTick and repeats four ticks later when spawned at $start', ({
    start,
    firstHealTick,
  }) => {
    const { parent, player, world, context } = fixture();
    // Off the approach lines: a player tile blocks an NPC step.
    player.position = [45, 50];
    const spawnTick = 877;
    const first = createJadHealer({ id: 'first', position: start, spawnTick, parentId: parent.id });
    world.actors.set(first.id, first);
    parent.vitals.hp = 250;
    const registration = createZukWaveEncounter(0).getNpcDefinitions();
    const random = vi.fn(() => 0.5);
    const observations = [];

    for (let tick = spawnTick - 1; tick <= firstHealTick + 4; tick++) {
      world.tick = tick;
      const tickContext = { ...context, tick, random };
      const before = parent.vitals.hp;
      const moves = tick === spawnTick ? [] : registration.move(first, tickContext);
      for (const move of moves) for (const position of move.path) first.position = position;
      const result = registration.tick(first, tickContext);
      const events = context.tickEvents.flush();
      if (tick < spawnTick) {
        expect(moves).toEqual([]);
        expect(result).toEqual({ environmentalDamages: [] });
        expect(events).toEqual([]);
        expect(first.position).toEqual(start);
      }
      observations.push({
        tick,
        amount: parent.vitals.hp - before,
        animations: events
          .filter(isEncounterVisualEvent)
          .flatMap((event) => event.animations)
          .filter((cue) => cue.actorId === first.id)
          .map((cue) => cue.clipId),
      });
    }

    expect(observations).toEqual(
      Array.from({ length: firstHealTick + 4 - spawnTick + 2 }, (_, index) => {
        const tick = spawnTick - 1 + index;
        const heals = tick === firstHealTick || tick === firstHealTick + 4;
        return { tick, amount: heals ? 10 : 0, animations: heals ? ['heal'] : [] };
      }),
    );
    expect(first.position).toEqual([25, 40]);
    expect(random).not.toHaveBeenCalled();
  });

  it('keeps HP unchanged when only default visual support and combat are enabled', () => {
    const { first, parent, player, context } = fixture();
    first.combat.targetId = player.id;
    const hp = parent.vitals.hp;
    const result = jadHealerDefinition.register(undefined).tick(first, context);
    expect(parent.vitals.hp).toBe(hp);
    expect(result.npcAttacks).toBeUndefined();
  });

  it.each([
    'missing',
    'dead',
    'full',
    'out-of-range',
  ] as const)('does not apply a heal when parent is %s', (condition) => {
    const { first, parent, world, context } = fixture();
    if (condition === 'missing') world.actors.delete(parent.id);
    if (condition === 'dead') parent.alive = false;
    if (condition === 'full') parent.vitals.hp = parent.vitals.maxHp;
    if (condition === 'out-of-range') first.position = [25, 41];
    const before = parent.vitals.hp;

    jadHealerDefinition.register({ sampleHeal: () => 19 }).tick(first, context);

    expect(parent.vitals.hp).toBe(before);
  });

  it('turns on a splash at cast + 1 and first swings at cast + 3 (P t9819 -> t9822)', () => {
    const { first, second, player, world, context } = fixture();
    first.position = [24, 39];
    player.position = [25, 41];
    const registration = jadHealerDefinition.register(undefined);
    notifyNpcOfPlayerAttack(first, {
      sourceId: player.id,
      launchTick: 9819,
      impactTick: 9822,
      style: 'magic',
      accuracySucceeded: false,
    });
    const attacks: number[] = [];

    for (let tick = 9820; tick <= 9826; tick++) {
      world.tick = tick;
      processNpcRetaliations(world);
      for (const move of registration.move(first, { ...context, tick })) {
        const position = move.path.at(-1);
        if (position) first.position = position;
      }
      registration.tick(first, { ...context, tick });
      for (const event of context.tickEvents.flush().filter(isEncounterVisualEvent))
        if (event.animations.some((cue) => cue.clipId === 'melee')) attacks.push(tick);
    }

    expect(first.position).toEqual([25, 40]);
    expect(attacks).toEqual([9822, 9826]);
    expect(second.combat.targetId).toBeNull();
  });

  it('attacks on arrival at 886 when the independent action clock is ready', () => {
    const { first, player, context } = fixture();
    first.position = [25, 40];
    player.position = [25, 46];
    first.combat.targetId = player.id;
    const registration = jadHealerDefinition.register(undefined);
    const attacks: number[] = [];

    for (let tick = 882; tick <= 886; tick++) {
      for (const move of registration.move(first, { ...context, tick })) {
        const position = move.path.at(-1);
        if (position) first.position = position;
      }
      registration.tick(first, { ...context, tick });
      for (const event of context.tickEvents.flush().filter(isEncounterVisualEvent))
        if (event.animations.some((cue) => cue.clipId === 'melee')) attacks.push(tick);
    }

    expect(attacks).toEqual([886]);
  });

  it('lands unforced melee accuracy and positive damage through CombatSystem while suppressing support', () => {
    const { first, player, parent, world, context } = fixture();
    first.combat.targetId = player.id;
    player.activePrayer = null;
    const before = parent.vitals.hp;
    const playerHp = player.vitals.hp;
    const system = new CombatSystem({ random: () => 0.5 });
    let draw = 0;

    const result = jadHealerDefinition
      .register({
        sampleHeal: () => 7,
        melee: { formulaStyle: 'melee_crush', attackKind: 'melee_crush', impactDelayTicks: 0, maxHit: 10 },
      })
      .tick(first, { ...context, random: () => (draw++ === 0 ? 0 : 0.5) });
    const attack = result.npcAttacks?.[0];
    if (!attack) throw new TypeError('Missing Jad healer melee request');
    system.processAttackRequest(world, { attacker: first, target: player, attack }, { events: context.tickEvents });

    expect(result.npcAttacks).toMatchObject([
      { attackerId: first.id, targetId: player.id, style: 'melee', rolledDamage: 5 },
    ]);
    expect.soft(attack.accuracySucceeded).toBe(true);
    expect.soft(player.vitals.hp).toBe(playerHp - 5);
    expect(parent.vitals.hp).toBe(before);
  });

  it('returns to its parent until engaged, then escapes from its underfoot player target', () => {
    const { first, player, context } = fixture();
    const registration = jadHealerDefinition.register(undefined);
    first.position = [20, 20];
    expect(registration.move(first, context)).toEqual([{ npcId: first.id, path: [[21, 21]] }]);
    first.combat.targetId = player.id;
    player.position = [...first.position];

    expect(registration.move(first, context)).toEqual([{ npcId: first.id, path: [[19, 20]] }]);
  });

  it.each([
    { start: [25, 43], arrival: [25, 40] },
    // The generic contact destination, not the nearest footprint tile (east side: its SW-most contact).
    { start: [32, 37], arrival: [30, 35] },
    { start: [24, 40], arrival: [25, 40] },
    { start: [30, 40], arrival: [29, 40] },
    { start: [24, 34], arrival: [25, 34] },
    { start: [30, 34], arrival: [29, 34] },
  ] satisfies {
    start: [number, number];
    arrival: [number, number];
  }[])('approaches from $start and stops at cardinal healing range when unengaged', ({ start, arrival }) => {
    const { first, parent, player, context } = fixture();
    player.position = [45, 50];
    first.position = start;
    const registration = jadHealerDefinition.register({ sampleHeal: () => 19 });
    const positions: Coordinate[] = [];
    const before = parent.vitals.hp;

    for (let tick = 0; tick < 5; tick++) {
      for (const move of registration.move(first, { ...context, tick })) {
        for (const position of move.path) {
          expect(npcFootprintsOverlap({ position, size: first.size }, parent)).toBe(false);
          first.position = position;
          positions.push(position);
        }
      }
      registration.tick(first, { ...context, tick });
    }

    expect(positions.length).toBeGreaterThan(0);
    expect(first.position).toEqual(arrival);
    expect(isNpcInMeleeRange(first, parent)).toBe(true);
    expect(registration.move(first, { ...context, tick: 5 })).toEqual([]);
    expect(parent.vitals.hp).toBeGreaterThan(before);
    expect(first.combat.targetId).toBeNull();
  });

  // Captured untagged steps toward a Jad at (25,35); the nearest-footprint-tile rule steps straight
  // instead (P t9815 -> (27,42), Q t4792 -> (29,32)).
  it.each([
    { capture: 'P t9815 (P:177546)', start: [27, 43], step: [26, 42] },
    { capture: 'P t9815 (P:177548)', start: [27, 41], step: [26, 40] },
    { capture: 'Q t4792 (Q:99872)', start: [29, 31], step: [28, 32] },
  ] satisfies {
    capture: string;
    start: Coordinate;
    step: Coordinate;
  }[])('steps toward its contact destination untagged ($capture)', ({ start, step }) => {
    const { first, second, context } = fixture();
    first.position = start;
    second.position = [40, 45];
    expect(jadHealerDefinition.register(undefined).move(first, context)).toEqual([{ npcId: first.id, path: [step] }]);
  });

  // P t9814-9817 (P:177522-177608): Jad (2265,5347) is the fixture's (25,35) and the player stands on
  // (25,41). Every add and untagged step faces the Jad (face-entity), never the step direction; the
  // captured angles truncate where Math.round rounds, hence the 1-unit tolerance.
  it('faces its Jad from its add tick and while it walks there untagged (P t9814-9817)', () => {
    const { world, parent, player, context } = fixture();
    world.actors.delete('first');
    world.actors.delete('second');
    player.position = [25, 41];
    // Index order: 62225, 62226, 62227, 62228, 62229.
    const starts: Coordinate[] = [
      [27, 43],
      [27, 41],
      [21, 42],
      [22, 35],
      [25, 42],
    ];
    const healers = starts.map((position, index) =>
      createJadHealer({
        id: `healer-${index}`,
        position,
        spawnTick: 9814,
        parentId: parent.id,
        variant: 'ordinary',
        firstTurnTick: 9815,
      }),
    );
    for (const healer of healers) world.actors.set(healer.id, healer);
    const registration = jadHealerDefinition.register(undefined);
    const observed: [Coordinate, number][][] = [];

    for (let tick = 9814; tick <= 9817; tick++) {
      world.tick = tick;
      for (const healer of healers) {
        context.world.occupancy.reconcile(context.world.actors.values());
        for (const move of registration.move(healer, { ...context, tick })) {
          const position = move.path.at(-1);
          if (position) healer.position = position;
        }
        registration.tick(healer, { ...context, tick });
      }
      observed.push(healers.map((healer) => [[...healer.position], healer.facing]));
    }

    const captured: [Coordinate, number][][] = [
      [
        [[27, 43], 0],
        [[27, 41], 0],
        [[21, 42], 1763],
        [[22, 35], 1412],
        [[25, 42], 1924],
      ],
      [
        [[26, 42], 1984],
        [[26, 40], 1944],
        [[22, 41], 1756],
        [[23, 35], 1385],
        [[25, 42], 1924],
      ],
      [
        [[26, 41], 1969],
        [[26, 40], 1944],
        [[23, 40], 1746],
        [[24, 35], 1345],
        [[25, 42], 1924],
      ],
      [
        [[26, 41], 1969],
        [[26, 40], 1944],
        [[24, 39], 1728],
        [[24, 35], 1345],
        [[25, 42], 1924],
      ],
    ];
    expect(observed.map((tick) => tick.map(([position]) => position))).toEqual(
      captured.map((tick) => tick.map(([position]) => position)),
    );
    for (const [tick, healersAtTick] of observed.entries()) {
      for (const [index, [, facing]] of healersAtTick.entries()) {
        expect(Math.abs(facing - (captured[tick]?.[index]?.[1] ?? Number.NaN))).toBeLessThanOrEqual(1);
      }
    }
  });

  it('uses the support target rather than the original parent when returning', () => {
    const { first, second, context } = fixture();
    first.position = [26, 43];
    first.state.supportTargetId = second.id;

    const moves = jadHealerDefinition.register(undefined).move(first, context);

    expect(moves).toEqual([{ npcId: first.id, path: [[26, 42]] }]);
  });

  it('uses an earlier peer-vacated tile when returning in NPC update order', () => {
    const { first, second, player, context } = fixture();
    player.position = [45, 50];
    first.position = [25, 41];
    second.position = [25, 42];
    const registration = jadHealerDefinition.register(undefined);
    const positions: Coordinate[] = [];

    for (const actor of [first, second]) {
      for (const move of registration.move(actor, context)) {
        const position = move.path.at(-1);
        if (position) actor.position = position;
      }
      positions.push(actor.position);
    }

    expect(positions).toEqual([
      [25, 40],
      [25, 41],
    ]);
  });

  it('stays blocked at the supplied wave-69 layout when returning through living peers would be required', () => {
    const { first, second, parent, world, context } = fixture();
    parent.position = [30, 35];
    first.position = [30, 41];
    second.position = [31, 40];
    const third = createJadHealer({ id: 'third', position: [30, 40], spawnTick: 0, parentId: parent.id });
    world.actors.set(third.id, third);

    const registration = createZukWaveEncounter(0).getNpcDefinitions();
    const before = parent.vitals.hp;

    for (let tick = 877; tick <= 885; tick++) {
      world.tick = tick;
      const tickContext = { ...context, tick };
      // A turn boundary: the engine reconciles placements before each NPC moves.
      context.world.occupancy.reconcile(context.world.actors.values());
      const moves = registration.move(first, tickContext);
      registration.tick(first, tickContext);

      expect(moves).toEqual([]);
      expect(parent.vitals.hp).toBe(before);
      expect(context.tickEvents.flush()).toEqual([]);
    }
  });

  it.each([true, false])('keeps a peer as return-path corner occupancy until it is removed (alive %s)', (alive) => {
    const { first, second, context } = fixture();
    first.position = [23, 33];
    second.position = [24, 33];
    second.alive = alive;

    // A turn boundary: the engine reconciles placements before each NPC moves.
    context.world.occupancy.reconcile(context.world.actors.values());
    const moves = jadHealerDefinition.register(undefined).move(first, context);

    expect(moves).toEqual([{ npcId: first.id, path: [[23, 34]] }]);
  });

  it('holds rather than finding a detour when the direct return tile is unwalkable', () => {
    const { first, context } = fixture();
    first.position = [25, 42];
    setArenaConfig(
      { bounds: null, walkableTiles: new Set(['25,42', '24,42', '24,41', '24,40', '25,40']), collisionMap: null },
      true,
    );

    const moves = jadHealerDefinition.register(undefined).move(first, context);

    expect(moves).toEqual([]);
  });

  it.each([10, 11, 30])('retains established player aggression when the Chebyshev gap is %s', (gap) => {
    const { first, player, context } = fixture();
    first.position = [25, 42];
    player.position = [25 + gap, 42 + gap];
    first.combat.targetId = player.id;
    first.combat.retaliation = { mode: 'standard', pending: [], lastIncomingAttackTick: -4 };
    first.combat.nextActionTick = 2;

    const moves = jadHealerDefinition.register(undefined).move(first, context);

    expect(first.combat.targetId).toBe(player.id);
    expect(first.combat.retaliation.lastIncomingAttackTick).toBe(-4);
    expect(first.combat.nextActionTick).toBe(2);
    expect(moves).toEqual([{ npcId: first.id, path: [[26, 43]] }]);
  });

  it.each([true, false])('retains tags through farther player movement and thaw when initially frozen=%s', (bound) => {
    const { first, player, world, context } = fixture();
    first.position = [25, 42];
    first.debuffs = { boundFromTick: 0, boundUntilTick: bound ? 2 : 0 };
    first.combat.nextActionTick = 8;
    const registration = jadHealerDefinition.register(undefined);
    const observations = [];

    for (const [tick, playerX] of [14, 5, -5].entries()) {
      world.tick = tick;
      player.position = [playerX, 42];
      // Splashes cast the tick before: each reacts on this tick.
      if (tick < 2)
        notifyNpcOfPlayerAttack(first, {
          sourceId: player.id,
          launchTick: tick - 1,
          impactTick: tick + 4,
          style: 'magic',
          accuracySucceeded: false,
        });
      processNpcRetaliations(world);
      const moves = registration.move(first, { ...context, tick });
      for (const move of moves) {
        const position = move.path.at(-1);
        if (position) first.position = position;
      }
      registration.tick(first, { ...context, tick });
      observations.push({
        target: first.combat.targetId,
        incomingTick: first.combat.retaliation?.lastIncomingAttackTick,
        nextActionTick: first.combat.nextActionTick,
        moves,
        position: first.position,
      });
    }

    expect(observations).toEqual(
      [0, 1, 2].map((tick) => {
        const position = [bound ? (tick < 2 ? 25 : 24) : 24 - tick, 42];
        return {
          target: player.id,
          incomingTick: tick === 0 ? 0 : 1,
          nextActionTick: 8,
          moves: bound && tick < 2 ? [] : [{ npcId: first.id, path: [position] }],
          position,
        };
      }),
    );
  });

  it('keeps its first readiness across distant movement and a retag while frozen', () => {
    const { first, player, world, context } = fixture();
    first.position = [25, 42];
    first.debuffs = { boundFromTick: 0, boundUntilTick: 10 };
    const registration = jadHealerDefinition.register(undefined);
    const retained = [];
    const attacks: number[] = [];

    for (const [tick, gap] of [11, 30, 1, 40, 1].entries()) {
      world.tick = tick;
      player.position = [25 - gap, 42];
      if (tick === 0 || tick === 2)
        notifyNpcOfPlayerAttack(first, {
          sourceId: player.id,
          launchTick: tick,
          impactTick: tick + 5,
          style: 'magic',
          accuracySucceeded: false,
        });
      processNpcRetaliations(world);
      registration.move(first, { ...context, tick });
      registration.tick(first, { ...context, tick });
      retained.push(first.combat.targetId);
      for (const event of context.tickEvents.flush().filter(isZukAttackEvent))
        if (event.attack === 'jad_healer_melee') attacks.push(tick);
    }

    // The t0 splash reacts at t1 (ready t3); the t2 retag (reacting t3) neither delays nor advances it.
    expect(retained).toEqual([null, player.id, player.id, player.id, player.id]);
    expect(first.combat.retaliation?.lastIncomingAttackTick).toBe(3);
    expect(attacks).toEqual([4]);
  });

  it.each([true, false])('disengages from a dead player before the root check when bound is %s', (bound) => {
    const { first, player, context } = fixture();
    first.position = [25, 42];
    // Off the return line: a player tile blocks an NPC step.
    player.position = [45, 50];
    first.combat.targetId = player.id;
    first.combat.retaliation = { mode: 'standard', pending: [], lastIncomingAttackTick: -4 };
    first.debuffs = { boundFromTick: 0, boundUntilTick: bound ? 1 : 0 };
    player.alive = false;

    const moves = jadHealerDefinition.register(undefined).move(first, context);

    expect(moves).toEqual(bound ? [] : [{ npcId: first.id, path: [[25, 41]] }]);
    expect(first.combat.targetId).toBeNull();
    expect(first.combat.retaliation.lastIncomingAttackTick).toBeNull();
  });

  it.each([true, false])('clears missing-player aggro but keeps pending retags when bound=%s', (bound) => {
    const { first, player, world, context } = fixture();
    first.position = [25, 42];
    first.combat.targetId = player.id;
    const pending = [{ tick: 3, sourceId: player.id }];
    first.combat.retaliation = { mode: 'standard', pending, lastIncomingAttackTick: -4 };
    first.debuffs = { boundFromTick: 0, boundUntilTick: bound ? 1 : 0 };
    world.actors.delete(player.id);

    const moves = jadHealerDefinition.register(undefined).move(first, context);

    expect(moves).toEqual(bound ? [] : [{ npcId: first.id, path: [[25, 41]] }]);
    expect(first.combat.targetId).toBeNull();
    expect(first.combat.retaliation.lastIncomingAttackTick).toBeNull();
    expect(first.combat.retaliation.pending).toEqual([{ tick: 3, sourceId: player.id }]);
  });

  it('resumes parent return when the root expires without reacquiring a nearby player', () => {
    const { first, player, context } = fixture();
    first.position = [25, 42];
    first.combat.targetId = player.id;
    first.combat.retaliation = { mode: 'standard', pending: [], lastIncomingAttackTick: -4 };
    player.alive = false;
    first.debuffs = { boundFromTick: 0, boundUntilTick: 2 };
    const registration = jadHealerDefinition.register(undefined);
    const moves = [];

    for (let tick = 0; tick <= 2; tick++) {
      if (tick === 1) {
        player.alive = true;
        player.position = [25, 43];
      }
      moves.push(registration.move(first, { ...context, tick }));
      registration.tick(first, { ...context, tick });
    }

    expect(moves).toEqual([[], [], [{ npcId: first.id, path: [[25, 41]] }]]);
    expect(first.combat.targetId).toBeNull();
  });

  it('keeps walking to and healing its dying Jad until removal, restoring nothing (Q t4839-4843)', () => {
    const { first, second, parent, player, context } = fixture();
    player.position = [45, 50];
    second.position = [40, 45];
    first.position = [25, 42];
    parent.alive = false;
    parent.death = { status: 'started', killTick: 0, processTick: 0, causeStage: 'hit-queue' };
    const hp = parent.vitals.hp;
    const presentHeal = vi.fn();
    const sampleHeal = vi.fn(() => 10);
    const registration = jadHealerDefinition.register({ sampleHeal, presentHeal });
    const heals: number[] = [];

    for (let tick = 0; tick < 4; tick++) {
      for (const move of registration.move(first, { ...context, tick })) {
        const position = move.path.at(-1);
        if (position) first.position = position;
      }
      registration.tick(first, { ...context, tick });
      for (const event of context.tickEvents.flush().filter(isEncounterVisualEvent))
        if (event.animations.some((cue) => cue.actorId === first.id && cue.clipId === 'heal')) heals.push(tick);
    }

    expect(first.position).toEqual([25, 40]);
    expect(heals).toEqual([1]);
    expect(presentHeal).toHaveBeenCalledTimes(1);
    expect(sampleHeal).not.toHaveBeenCalled();
    expect(parent.vitals.hp).toBe(hp);
  });

  it('first swings at splat + 2 after an accurate hit (Q t4801 -> t4803)', () => {
    const { first, player, world, context } = fixture();
    const registration = jadHealerDefinition.register(undefined);
    notifyNpcOfPlayerAttack(first, {
      sourceId: player.id,
      launchTick: 4799,
      impactTick: 4801,
      style: 'magic',
      accuracySucceeded: true,
    });
    const attacks: number[] = [];
    for (let tick = 4800; tick <= 4804; tick++) {
      world.tick = tick;
      processNpcRetaliations(world);
      registration.tick(first, { ...context, tick });
      for (const event of context.tickEvents.flush().filter(isEncounterVisualEvent))
        if (event.animations.some((cue) => cue.actorId === first.id && cue.clipId === 'melee')) attacks.push(tick);
    }
    expect(attacks).toEqual([4803]);
  });

  it.each([true, false])('does not steer or heal when its parent is unavailable with missing=%s', (missing) => {
    const { first, parent, world, context } = fixture();
    first.position = [25, 42];
    if (missing) world.actors.delete(parent.id);
    else parent.alive = false;
    const sampleHeal = vi.fn(() => 19);
    const presentHeal = vi.fn();
    const registration = jadHealerDefinition.register({ sampleHeal, presentHeal });

    const moves = registration.move(first, context);
    registration.tick(first, context);

    expect(moves).toEqual([]);
    expect(sampleHeal).not.toHaveBeenCalled();
    expect(presentHeal).not.toHaveBeenCalled();
    expect(context.tickEvents.flush()).toEqual([]);
  });

  it.each([
    0, 10,
  ])('reacts to a queued retag with the standard 2-tick delay without shortening readiness %s', (nextActionTick) => {
    const { first, player, parent, world, context } = fixture();
    first.position = [25, 42];
    first.combat.targetId = player.id;
    first.combat.retaliation = { mode: 'standard', pending: [], lastIncomingAttackTick: -4 };
    first.combat.nextActionTick = nextActionTick;
    notifyNpcOfPlayerAttack(first, {
      sourceId: player.id,
      launchTick: -1,
      impactTick: 3,
      style: 'range',
      accuracySucceeded: true,
    });
    world.actors.delete(player.id);
    const random = vi.fn(() => 0.5);
    const registration = createZukWaveEncounter(0).getNpcDefinitions();
    const before = parent.vitals.hp;
    const attacks: number[] = [];
    const readinessTicks: number[] = [];

    for (let tick = 0; tick <= 10; tick++) {
      world.tick = tick;
      if (tick === 2) {
        player.position = [25, 41];
        world.actors.set(player.id, player);
      }
      processNpcRetaliations(world);
      for (const move of registration.move(first, { ...context, tick, random })) {
        const position = move.path.at(-1);
        if (position) first.position = position;
      }
      const result = registration.tick(first, { ...context, tick, random });
      if (result.npcAttacks?.length) attacks.push(tick);
      readinessTicks.push(first.combat.nextActionTick);
    }

    expect(first.position).toEqual([25, 40]);
    // Impact 3 + 2, then every 4 ticks; a later existing readiness is kept.
    expect(attacks).toEqual(nextActionTick === 0 ? [5, 9] : [10]);
    expect(readinessTicks.slice(0, 3)).toEqual([nextActionTick, nextActionTick, nextActionTick]);
    expect(first.combat.retaliation.pending).toEqual([]);
    expect(first.combat.retaliation.lastIncomingAttackTick).toBe(3);
    expect(parent.vitals.hp).toBe(before + 10);
    expect(random).toHaveBeenCalledTimes(attacks.length * 2);
  });

  it.each([true, false])('has no movement, bookkeeping, RNG or clock side effects when future-spawn=%s', (future) => {
    const { first, player, context } = fixture();
    first.alive = future;
    first.spawnTick = future ? 5 : 0;
    player.alive = false;
    first.combat.targetId = player.id;
    first.combat.retaliation = {
      mode: 'standard',
      pending: [{ tick: 3, sourceId: player.id }],
      lastIncomingAttackTick: -4,
    };
    first.combat.nextActionTick = 2;
    const before = structuredClone(first);
    const sampleHeal = vi.fn(() => 19);
    const presentHeal = vi.fn();
    const random = vi.fn(() => 0.5);
    const registration = jadHealerDefinition.register({ sampleHeal, presentHeal });

    const moves = registration.move(first, { ...context, random });
    const result = registration.tick(first, { ...context, random });

    expect(moves).toEqual([]);
    expect(result).toEqual({ environmentalDamages: [] });
    expect(first).toEqual(before);
    expect(sampleHeal).not.toHaveBeenCalled();
    expect(presentHeal).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    expect(context.tickEvents.flush()).toEqual([]);
  });

  it('stops support and combat on death and starts fresh state on reset', () => {
    const { first, parent, player, context } = fixture();
    first.combat.targetId = player.id;
    first.alive = false;
    const before = parent.vitals.hp;
    const registration = jadHealerDefinition.register({ sampleHeal: () => 19 });

    const result = registration.tick(first, context);

    expect(result.npcAttacks).toBeUndefined();
    expect(parent.vitals.hp).toBe(before);
    expect(context.tickEvents.flush()).toEqual([]);
    expect(createJadHealer({ id: 'fresh', parentId: 'other', spawnTick: 4, position: [1, 1] }).state).toEqual({
      parentId: 'other',
      supportTargetId: 'other',
      nextHealTick: 4,
    });
  });
});
