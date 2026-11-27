import { afterEach, describe, expect, it, vi } from 'vitest';
import { CombatSystem } from '../../../core/combat/CombatSystem';
import { applyNpcHealing } from '../../../core/combat/npcHealing';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import type { NpcDefinitionContext } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { createZukWaveEncounter } from '../../../test/helpers/zukWave';
import { PrayerType } from '../../../types/simulation';
import { createInfernoActor } from '../actors';
import { isZukAttackEvent } from '../events';
import {
  createJad,
  INFERNO_WAVE_JAD_SCHEDULE,
  type JadExecution,
  type JadStyle,
  jadDefinition,
  LIVE_JAD_EXECUTION,
  removeJadIfDue,
} from '../jad';
import { createJadHealer } from '../jadHealer';
import { JALTOK_JAD_PROJECTILE_TIMING } from '../projectileProfiles';
import { createWaveEngine } from './waveFixture';

afterEach(() => {
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

function fixture(style: JadStyle, prayerCheckAtRelease: JadExecution['prayerCheckAtRelease'] = 'launch') {
  const engine = new SimulationEngine({ encounter: createZukWaveEncounter(0) });
  const world = engine['worldState'];
  const player = world.getPlayer();
  if (!player) throw new TypeError('Missing player fixture');
  world.actors.clear();
  player.position = [10, 15];
  const actor = createJad({ id: 'arbitrary-jad', position: [10, 10], spawnTick: 0, targetId: player.id });
  world.actors.set(actor.id, actor);
  world.actors.set(player.id, player);
  const tickEvents = new TickEvents();
  const context: NpcDefinitionContext = {
    tick: 0,
    world,
    tickEvents,
    random: () => 0.5,
    spawnNpc: (npc) => world.actors.set(npc.id, npc),
    despawnNpc: (id) => engine['despawnEncounterNpc'](id),
    logEvent: () => undefined,
  };
  const execution: JadExecution = {
    attackRange: 15,
    selectStyle: () => style,
    prayerCheckAtRelease,
    profiles: {
      magic: {
        windupTicks: 3,
        attack: {
          formulaStyle: 'magic',
          damageType: 'magic',
          attackKind: 'magic_fire',
          impactDelayTicks: 2,
          maxHit: 20,
          alwaysHits: true,
        },
      },
      range: {
        windupTicks: 3,
        attack: {
          formulaStyle: 'ranged',
          damageType: 'range',
          attackKind: 'range_arrow',
          impactDelayTicks: 2,
          maxHit: 20,
          alwaysHits: true,
        },
      },
      melee: {
        windupTicks: 0,
        attack: {
          formulaStyle: 'melee_crush',
          damageType: 'melee',
          attackKind: 'melee_crush',
          impactDelayTicks: 0,
          maxHit: 20,
        },
      },
    },
  };
  return { actor, player, context, world, execution };
}

describe('live Jad style selector', () => {
  it.each([
    { position: [10, 16], roll: 0, style: 'magic' },
    { position: [10, 16], roll: 0.499999, style: 'magic' },
    { position: [10, 16], roll: 0.5, style: 'range' },
    { position: [10, 16], roll: 0.999999, style: 'range' },
    { position: [10, 15], roll: 0, style: 'magic' },
    { position: [10, 15], roll: 1 / 3 - 0.000001, style: 'magic' },
    { position: [10, 15], roll: 1 / 3, style: 'range' },
    { position: [10, 15], roll: 2 / 3 - 0.000001, style: 'range' },
    { position: [10, 15], roll: 2 / 3, style: 'melee' },
    { position: [10, 15], roll: 0.999999, style: 'melee' },
    { position: [15, 15], roll: 0.999999, style: 'range' },
  ] as const)('selects $style at $position for draw $roll', ({ position, roll, style }) => {
    const { actor, player, context } = fixture('magic');
    actor.combat.attackRange = LIVE_JAD_EXECUTION.attackRange;
    player.position = [...position];
    const random = vi.fn(() => roll);

    const selected = LIVE_JAD_EXECUTION.selectStyle({ actor, target: player, context: { ...context, random } });

    expect(selected).toBe(style);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('uses Stab for both the live melee formula and attack kind', () => {
    expect(LIVE_JAD_EXECUTION.profiles.melee.attack).toMatchObject({
      formulaStyle: 'melee_stab',
      attackKind: 'melee_stab',
      maxHit: 113,
    });
  });
});

describe('configured Jad execution', () => {
  it.each([true, false])('removes only its own healer children when delayed despawn=%s', (delayed) => {
    const { actor, context, execution, world } = fixture('magic');
    const other = createJad({ id: 'other-jad', position: [20, 20], spawnTick: 0, targetId: 'player' });
    const children = ['living-child', 'dead-child', 'removed-child'].map((id) =>
      createJadHealer({ id, parentId: actor.id, position: [10, 15], spawnTick: 0 }),
    );
    const otherChildren = ['other-first', 'other-second'].map((id) =>
      createJadHealer({ id, parentId: other.id, position: [20, 25], spawnTick: 0 }),
    );
    const unrelated = createInfernoActor('ranger', 'unrelated-ranger', [30, 30]);
    for (const child of children) {
      child.alive = child.id !== 'dead-child';
      child.state.supportTargetId = other.id;
    }
    for (const child of otherChildren) child.state.supportTargetId = actor.id;
    for (const npc of [other, ...children, ...otherChildren, unrelated]) context.spawnNpc(npc);
    context.despawnNpc('removed-child');
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });
    registration.tick(actor, context);
    if (delayed) {
      actor.alive = false;
      registration.notifyDefeated(actor, { npcId: actor.id, tick: 1 }, 'encounter-owned', context);
      // A corpse takes no turn: its removal is the owning encounter's pre-band step.
      removeJadIfDue(actor, { ...context, tick: 6 });
      expect(world.getNpc(actor.id)).toBe(actor);
      expect(world.getNpc('living-child')).not.toBeNull();
      expect(world.getNpc('dead-child')).not.toBeNull();
    }

    if (delayed) removeJadIfDue(actor, { ...context, tick: 7 });
    else context.despawnNpc(actor.id);

    expect(world.getNpc(actor.id)).toBeNull();
    expect(actor.state.pendingAttack).toBeNull();
    for (const child of children) expect(world.getNpc(child.id)).toBeNull();
    expect(world.getNpc(other.id)).toBe(other);
    for (const child of otherChildren) expect(world.getNpc(child.id)).toBe(child);
    expect(world.getNpc(unrelated.id)).toBe(unrelated);
  });

  it.each([
    { accuracyRoll: 0, damageRoll: 0.5, accuracySucceeded: true, damage: 57 },
    { accuracyRoll: 0, damageRoll: 0, accuracySucceeded: true, damage: 0 },
    { accuracyRoll: 0.999999, damageRoll: 0.5, accuracySucceeded: false, damage: 0 },
  ])('applies live glyph damage $damage at the ranged pending-hit frame', ({
    accuracyRoll,
    damageRoll,
    accuracySucceeded,
    damage,
  }) => {
    const { actor, context, world } = fixture('range');
    const glyph = createInfernoActor('shield', 'glyph', [10, 15]);
    world.actors.set(glyph.id, glyph);
    actor.combat.targetId = glyph.id;
    const registration = jadDefinition.register({
      spawnHealers: () => undefined,
      execution: { ...LIVE_JAD_EXECUTION, initialDelayTicks: 0, selectStyle: () => 'range' },
    });
    const system = new CombatSystem({ enablePendingHits: true });
    registration.tick(actor, context);
    let draw = 0;
    world.tick = 3;
    const attack = registration.tick(actor, {
      ...context,
      tick: 3,
      random: () => (draw++ === 0 ? accuracyRoll : damageRoll),
    }).npcAttacks?.[0];
    if (!attack) throw new TypeError('Missing live Jad glyph release');
    system.processAttackRequest(world, { attacker: actor, target: glyph, attack }, { events: context.tickEvents });
    actor.combat.targetId = 'player';
    world.tick = 4;
    system.processPendingHits(world, { events: context.tickEvents });
    expect(glyph.vitals.hp).toBe(600);
    world.tick = 5;

    system.processPendingHits(world, { events: context.tickEvents });

    expect(attack.accuracySucceeded).toBe(accuracySucceeded);
    expect(glyph.vitals.hp).toBe(600 - damage);
  });

  it.each(['magic', 'range', 'melee'] as const)('releases a real glyph %s attack using the live profile', (style) => {
    const { actor, context, world } = fixture(style);
    const glyph = createInfernoActor('shield', 'glyph', [10, 15]);
    world.actors.set(glyph.id, glyph);
    actor.combat.targetId = glyph.id;
    const registration = jadDefinition.register({
      spawnHealers: () => undefined,
      execution: { ...LIVE_JAD_EXECUTION, initialDelayTicks: 0, selectStyle: () => style },
    });
    let draw = 0;
    const opening = registration.tick(actor, { ...context, random: () => (draw++ % 2 === 0 ? 0 : 0.5) });

    const result =
      style === 'melee'
        ? opening
        : registration.tick(actor, {
            ...context,
            tick: 3,
            random: () => (draw++ % 2 === 0 ? 0 : 0.5),
          });

    expect(result.npcAttacks?.[0]).toMatchObject({
      targetId: glyph.id,
      style,
      accuracySucceeded: true,
      rolledDamage: 57,
      impactDelayTicks: style === 'range' ? 2 : 0,
    });
  });

  it.each(['missing', 'dead'] as const)('cancels a %s glyph windup then reacquires on the next action', (condition) => {
    const { actor, context, execution, world } = fixture('magic');
    const glyph = createInfernoActor('shield', 'glyph', [10, 15]);
    world.actors.set(glyph.id, glyph);
    actor.combat.targetId = glyph.id;
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });
    registration.tick(actor, context);
    if (condition === 'missing') world.actors.delete(glyph.id);
    else glyph.alive = false;
    const releases: { tick: number; targetId: string }[] = [];

    for (let tick = 1; tick <= 11; tick++) {
      for (const attack of registration.tick(actor, { ...context, tick }).npcAttacks ?? []) {
        releases.push({ tick, targetId: attack.targetId });
      }
    }

    expect(releases).toEqual([{ tick: 11, targetId: 'player' }]);
    expect(actor.combat.targetId).toBe('player');
  });

  it('retains a living glyph windup when the source retargets the player', () => {
    const { actor, context, execution, world } = fixture('magic');
    const glyph = createInfernoActor('shield', 'glyph', [10, 15]);
    world.actors.set(glyph.id, glyph);
    actor.combat.targetId = glyph.id;
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });
    registration.tick(actor, context);
    actor.combat.targetId = 'player';

    const result = registration.tick(actor, { ...context, tick: 3 });

    expect(result.npcAttacks?.[0]?.targetId).toBe(glyph.id);
    expect(actor.combat.targetId).toBe('player');
  });

  it.each(['null', 'dead-player', 'missing-player'] as const)('does not reacquire with %s', (condition) => {
    const { actor, player, context, execution, world } = fixture('magic');
    actor.combat.targetId = condition === 'null' ? null : 'removed-glyph';
    if (condition === 'dead-player') player.alive = false;
    if (condition === 'missing-player') world.actors.delete(player.id);
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });

    const result = registration.tick(actor, context);

    expect(result.npcAttacks).toBeUndefined();
    expect(context.tickEvents.flush()).toEqual([]);
    expect(actor.combat.targetId).toBe(condition === 'null' ? null : 'removed-glyph');
  });

  it('emits a magic cue at selection and one semantic attack at release', () => {
    const { actor, context, execution } = fixture('magic');
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });
    registration.tick(actor, context);
    const cueEvents = context.tickEvents.flush();

    registration.tick(actor, { ...context, tick: 3 });

    expect(cueEvents.filter((event) => event.type === 'zuk_jad_cue')).toMatchObject([
      { sourceId: actor.id, style: 'magic' },
    ]);
    expect(cueEvents.filter(isZukAttackEvent)).toEqual([]);
    expect(context.tickEvents.flush().filter(isZukAttackEvent)).toMatchObject([
      { sourceId: actor.id, attack: 'jad_magic', launchTick: 3, projectileArrivalCycles: 26 },
    ]);
  });
  it('lands unforced melee accuracy and positive damage through CombatSystem', () => {
    const { actor, player, world, context, execution } = fixture('melee');
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });
    const system = new CombatSystem({ random: () => 0.5 });
    player.activePrayer = null;
    const hp = player.vitals.hp;
    let draw = 0;

    const attack = registration.tick(actor, { ...context, random: () => (draw++ === 0 ? 0 : 0.5) }).npcAttacks?.[0];
    if (!attack) throw new TypeError('Missing Jad melee request');
    system.processAttackRequest(world, { attacker: actor, target: player, attack }, { events: context.tickEvents });

    expect.soft(attack.accuracySucceeded).toBe(true);
    expect(player.vitals.hp).toBe(hp - 10);
  });

  it.each([
    ['magic', 8, 8],
    ['magic', 9, 9],
    ['range', 8, 8],
    ['range', 9, 9],
    ['melee', 8, 4],
    ['melee', 9, 4],
  ] as const)('sets %s combat metadata at the cue with variant %i', (style, rangedMagicPeriod, expectedPeriod) => {
    const { actor, context, execution } = fixture(style);
    const registration = jadDefinition.register({
      spawnHealers: () => undefined,
      execution: { ...execution, rangedMagicPeriod },
    });

    registration.tick(actor, context);

    expect(actor.combat).toMatchObject({
      attackStyle: style,
      attackSpeed: expectedPeriod,
      nextActionTick: context.tick + expectedPeriod,
    });
  });

  it('throws a configuration error when a supplied attack releases without formula stats', () => {
    const { actor, context, execution } = fixture('magic');
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });
    registration.tick(actor, context);
    delete actor.formulaStats;

    expect(() => registration.tick(actor, { ...context, tick: 3 })).toThrow(
      new TypeError(`Missing formula stats for ${actor.id}`),
    );
  });

  it.each(['missing', 'dead'] as const)('cancels release without error when its target is %s', (condition) => {
    const { actor, player, world, context, execution } = fixture('magic');
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });
    registration.tick(actor, context);
    if (condition === 'missing') world.actors.delete(player.id);
    else player.alive = false;

    expect(registration.tick(actor, { ...context, tick: 3 }).npcAttacks).toBeUndefined();
  });
  it.each([
    'magic',
    'range',
    'melee',
  ] as const)('executes supplied %s choices at release on their own cadence', (style) => {
    const { actor, context, execution } = fixture(style);
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });
    const releases: number[] = [];

    for (let tick = 0; tick < 20; tick++) {
      if (registration.tick(actor, { ...context, tick }).npcAttacks?.length) releases.push(tick);
    }

    expect(releases).toEqual(style === 'melee' ? [0, 4, 8, 12, 16] : [3, 11, 19]);
  });

  it('allows the supplied nine-tick variant without changing melee recovery', () => {
    const { actor, context, execution } = fixture('range');
    const registration = jadDefinition.register({
      spawnHealers: () => undefined,
      execution: { ...execution, rangedMagicPeriod: 9 },
    });
    const releases: number[] = [];

    for (let tick = 0; tick < 22; tick++)
      if (registration.tick(actor, { ...context, tick }).npcAttacks?.length) releases.push(tick);

    expect(releases).toEqual([3, 12, 21]);
  });

  it('snapshots moving targets and consumes damage rolls only at release, not at the cue', () => {
    const { actor, player, context, execution } = fixture('magic');
    let rolls = 0;
    const registration = jadDefinition.register({
      spawnHealers: () => undefined,
      execution: {
        ...execution,
        profiles: {
          ...execution.profiles,
          magic: {
            windupTicks: 3,
            attack: { ...execution.profiles.magic.attack, projectile: JALTOK_JAD_PROJECTILE_TIMING },
          },
        },
      },
    });
    registration.tick(actor, {
      ...context,
      random: () => {
        rolls++;
        return 0.5;
      },
    });
    expect(rolls).toBe(0);
    expect(context.tickEvents.flush().filter(isEncounterVisualEvent)[0]?.projectiles).toEqual([]);
    player.position = [12, 20];

    const result = registration.tick(actor, {
      ...context,
      tick: 3,
      random: () => {
        rolls++;
        return 0.5;
      },
    });

    expect(rolls).toBe(2);
    expect(result.npcAttacks?.[0]).toMatchObject({ targetId: player.id, impactDelayTicks: 2 });
    expect(context.tickEvents.flush().filter(isEncounterVisualEvent)[0]?.projectiles[0]).toMatchObject({
      target: { position: [12, 20] },
      startDelayCycles: 2,
    });
  });

  it.each([
    'launch',
    'impact',
  ] as const)('applies the explicitly supplied %s prayer policy through the pending-hit pipeline', (policy) => {
    const { actor, player, context, execution, world } = fixture('magic', policy);
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });
    const system = new CombatSystem({ enablePendingHits: true, random: () => 0.5 });
    registration.tick(actor, context);
    world.tick = 3;
    player.activePrayer = PrayerType.ProtectMagic;
    const attack = registration.tick(actor, { ...context, tick: 3 }).npcAttacks?.[0];
    if (!attack) throw new TypeError('Missing release');
    system.processAttackRequest(world, { attacker: actor, target: player, attack }, { events: context.tickEvents });
    player.activePrayer = null;
    const hp = player.vitals.hp;
    world.tick = 5;

    system.processPendingHits(world, { events: context.tickEvents });

    expect(player.vitals.hp).toBe(hp - (policy === 'impact' ? 10 : 0));
  });

  it('does not execute damaging actions when selection is unavailable', () => {
    const { actor, context } = fixture('magic');
    const result = jadDefinition.register({ spawnHealers: () => undefined }).tick(actor, context);
    expect(result.npcAttacks).toBeUndefined();
    expect(context.tickEvents.flush()).toEqual([]);
  });

  it('keeps half-health spawning latched across healing and cancels unreleased actions at death', () => {
    const { actor, context, execution } = fixture('magic');
    let spawns = 0;
    const registration = jadDefinition.register({
      spawnHealers: () => {
        spawns++;
      },
      execution,
    });
    const child = createJadHealer({ id: 'child', parentId: actor.id, position: [10, 15], spawnTick: 0 });
    const otherChild = createJadHealer({ id: 'other-child', parentId: 'other-jad', position: [11, 15], spawnTick: 0 });
    context.spawnNpc(child);
    context.spawnNpc(otherChild);
    const damage = {
      tick: 0,
      sourceId: 'player',
      targetId: actor.id,
      attackType: 'range' as const,
      baseDamage: 1,
      effectiveDamage: 1,
      activePrayer: null,
      prayedCorrectly: null,
      hpBefore: 176,
      hpAfter: 175,
    };
    actor.vitals.hp = actor.vitals.maxHp / 2;
    registration.notifyDamageResolved(actor, { ...damage, hpAfter: actor.vitals.hp }, context);
    applyNpcHealing(actor, 100, context.tickEvents);
    registration.notifyDamageResolved(actor, { ...damage, hpAfter: actor.vitals.maxHp / 2 }, context);
    registration.tick(actor, context);

    actor.alive = false;
    registration.notifyDefeated(actor, { npcId: actor.id, tick: 1 }, 'encounter-owned', context);

    expect(spawns).toBe(1);
    expect(registration.tick(actor, { ...context, tick: 3 }).npcAttacks).toBeUndefined();
    removeJadIfDue(actor, { ...context, tick: 6 });
    expect(context.world.getNpc(child.id)).toBe(child);
    removeJadIfDue(actor, { ...context, tick: 7 });
    expect(context.world.getNpc(actor.id)).toBeNull();
    expect(context.world.getNpc(child.id)).toBeNull();
    expect(context.world.getNpc(otherChild.id)).toBe(otherChild);
    expect(createJad({ id: 'fresh', position: [4, 6], spawnTick: 8, targetId: null }).state).toMatchObject({
      healersSpawned: false,
      pendingAttack: null,
      removeAt: null,
    });
  });

  it('keeps two Jad windups and target choices independent', () => {
    const { actor, player, context, execution } = fixture('magic');
    const other = createJad({ id: 'other', position: [10, 10], spawnTick: 1, targetId: player.id });
    const registration = jadDefinition.register({ spawnHealers: () => undefined, execution });
    const launches: [string, number][] = [];

    for (let tick = 0; tick < 6; tick++)
      for (const jad of [actor, other]) {
        if (registration.tick(jad, { ...context, tick }).npcAttacks?.length) launches.push([jad.id, tick]);
      }

    expect(launches).toEqual([
      [actor.id, 3],
      [other.id, 4],
    ]);
    expect(actor.state).not.toBe(other.state);
  });
});

describe('ordinary-wave JalTok-Jad', () => {
  function tellTicks(openingDelayTicks?: number, rangedMagicPeriod?: 8 | 9) {
    const jad = createJad({
      id: 'jad',
      position: [10, 5],
      spawnTick: 0,
      targetId: 'player',
      variant: 'ordinary',
      ...(openingDelayTicks === undefined ? {} : { initialDelayTicks: openingDelayTicks }),
      ...(rangedMagicPeriod === undefined ? {} : { rangedMagicPeriod }),
    });
    const { advanceTo, events } = createWaveEngine([jad]);
    advanceTo(30);
    return { jad, ticks: events.filter((event) => event.type === 'zuk_jad_cue').map((event) => event.tick) };
  }

  it('tells first at spawn+4 on an 8-tick cycle at wave 67', () => {
    const { jad, ticks } = tellTicks();
    expect(jad).toMatchObject({ npcTypeId: 7700, size: 5, archetypeId: 'inferno_jad' });
    expect(ticks).toEqual([4, 12, 20, 28]);
    expect(INFERNO_WAVE_JAD_SCHEDULE[67]).toEqual({ openingDelayTicks: [4], rangedMagicPeriod: 8, healersPerJad: 5 });
  });

  it.each([4, 7, 10])('keeps a 9-tick cycle from its own wave-68 opening +%i', (opening) => {
    const { ticks } = tellTicks(opening, 9);
    expect(ticks).toEqual([opening, opening + 9, opening + 18]);
    expect(INFERNO_WAVE_JAD_SCHEDULE[68]).toMatchObject({ rangedMagicPeriod: 9, healersPerJad: 3 });
  });

  it('builds ordinary Yt-HurKot as 7701', () => {
    expect(
      createJadHealer({ id: 'healer', position: [1, 1], spawnTick: 0, parentId: 'jad', variant: 'ordinary' }),
    ).toMatchObject({ npcTypeId: 7701, archetypeId: 'inferno_jad_healer' });
  });

  it('is removed six ticks after its death sequence through the shared wave removal', () => {
    const jad = createJad({ id: 'jad', position: [10, 5], spawnTick: 100, targetId: 'player', variant: 'ordinary' });
    const { engine, world, removals, advanceTo } = createWaveEngine([jad]);
    enqueueEnginePendingHit(engine, {
      sourceId: 'player',
      targetId: jad.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 0,
      impactTick: 2,
      rolledDamage: jad.vitals.hp,
      accuracySucceeded: true,
    });
    advanceTo(8);
    expect(world.getNpc(jad.id)).toBe(jad);
    advanceTo(9);
    expect(world.getNpc(jad.id)).toBeNull();
    expect(removals).toEqual([{ tick: 9, actorId: 'jad', npcTypeId: 7700, splits: [] }]);
  });
});
