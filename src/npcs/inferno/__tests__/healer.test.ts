import { describe, expect, it, vi } from 'vitest';
import { notifyNpcOfPlayerAttack, processNpcRetaliations } from '../../../core/combat/retaliation';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { TickEvents } from '../../../core/events/TickEvents';
import type { NpcDefinitionContext } from '../../../core/npcs';
import { WorldState } from '../../../core/WorldState';
import { createInfernoActor } from '../actors';
import { createHealer, type HealerConfig, healerDefinition } from '../healer';

function fixture() {
  const world = new WorldState();
  const parent = createInfernoActor('jad', 'unrelated-parent', [10, 10]);
  parent.vitals.hp -= 100;
  const first = createHealer({ id: 'first', position: [4, 4], spawnTick: 10, supportTargetId: parent.id });
  const second = createHealer({ id: 'second', position: [8, 4], spawnTick: 11, supportTargetId: parent.id });
  for (const actor of [parent, first, second]) world.actors.set(actor.id, actor);
  const context: NpcDefinitionContext = {
    tick: 10,
    world,
    tickEvents: new TickEvents(),
    random: () => 0,
    spawnNpc: (actor) => world.actors.set(actor.id, actor),
    despawnNpc: (id) => {
      world.actors.delete(id);
    },
    logEvent: () => undefined,
  };
  return { world, parent, first, second, context };
}

describe('enrage healer supplied support', () => {
  it('arms the incoming lockout at first impact before readiness returns, not at launch', () => {
    const { first, second, parent, world, context } = fixture();
    const registration = healerDefinition.register(undefined);
    notifyNpcOfPlayerAttack(first, {
      sourceId: parent.id,
      launchTick: 16,
      impactTick: 17,
      style: 'range',
      accuracySucceeded: true,
    });
    registration.tick(first, { ...context, tick: 16 });
    expect(first.attackBlockedUntilTick).toBeUndefined();

    world.tick = 17;
    processNpcRetaliations(world);
    registration.tick(first, { ...context, tick: 17 });

    expect(first.state.firstEngagementTick).toBe(17);
    expect(first.attackBlockedUntilTick).toBe(18);
    expect(first.combat.nextActionTick).toBe(18);
    expect(second.attackBlockedUntilTick).toBeUndefined();
    expect(second.state.firstEngagementTick).toBeNull();
  });

  it.each([18, 20])('does not extend the first-tag lockout when another hit engages at tick %i', (impactTick) => {
    const { first, parent, world, context } = fixture();
    const registration = healerDefinition.register(undefined);
    notifyNpcOfPlayerAttack(first, {
      sourceId: parent.id,
      launchTick: 16,
      impactTick: 17,
      style: 'range',
      accuracySucceeded: true,
    });
    world.tick = 17;
    processNpcRetaliations(world);
    registration.tick(first, { ...context, tick: 17 });
    notifyNpcOfPlayerAttack(first, {
      sourceId: parent.id,
      launchTick: impactTick - 1,
      impactTick,
      style: 'range',
      accuracySucceeded: true,
    });

    world.tick = impactTick;
    processNpcRetaliations(world);
    registration.tick(first, { ...context, tick: impactTick });

    expect(first.state.firstEngagementTick).toBe(17);
    expect(first.attackBlockedUntilTick).toBe(18);
    expect(first.combat.nextActionTick).toBe(impactTick + 1);
  });

  it('anchors a splash lockout to launch even when the healer next ticks later', () => {
    const { first, parent, context } = fixture();
    notifyNpcOfPlayerAttack(first, {
      sourceId: parent.id,
      launchTick: 16,
      impactTick: 20,
      style: 'magic',
      accuracySucceeded: false,
    });

    healerDefinition.register(undefined).tick(first, { ...context, tick: 17 });

    expect(first.state.firstEngagementTick).toBe(16);
    expect(first.attackBlockedUntilTick).toBe(17);
  });

  it('records the spawn tick its render-config spawn clip plays from', () => {
    const actor = createHealer({ id: 'spawned', position: [40, 51], spawnTick: 1065, supportTargetId: 'zuk' });

    expect(actor.spawnTick).toBe(1065);
  });

  it('faces support without pinning an angle over subsequent player aggro', () => {
    const { first, parent, context } = fixture();

    healerDefinition.register(undefined).tick(first, { ...context, tick: 14 });

    expect(first.facing).toBeGreaterThan(512);
    expect(first.actionFacing).toBeUndefined();
    expect(first.combat.targetId).toBeNull();
    expect(context.tickEvents.flush()).toContainEqual(
      expect.objectContaining({
        type: 'zuk_healer_cast',
        sourceId: first.id,
        sourcePosition: first.position,
        targetId: parent.id,
      }),
    );
  });
  it('emits four source casts and delegates each applied heal to encounter parent presentation', () => {
    const { parent, context } = fixture();
    const actors = Array.from({ length: 4 }, (_, index) =>
      createHealer({ id: `healer-${index}`, position: [index, 4], spawnTick: 10, supportTargetId: parent.id }),
    );
    const presentHeal = vi.fn();
    const registration = healerDefinition.register({ sampleHeal: () => 7, presentHeal });
    const hp = parent.vitals.hp;

    for (const actor of actors) {
      registration.tick(actor, { ...context, tick: 14 });
      registration.resolveLocalEffects(actor, { ...context, tick: 18 });
    }

    const casts = context.tickEvents.flush().filter(isEncounterVisualEvent);
    expect(casts).toHaveLength(4);
    expect(casts.flatMap((cue) => cue.animations)).toHaveLength(4);
    expect(casts.flatMap((cue) => cue.projectiles)).toHaveLength(4);
    expect(casts.flatMap((cue) => cue.graphics)).toEqual([]);
    expect(parent.vitals.hp).toBe(hp + 28);
    expect(presentHeal).toHaveBeenCalledTimes(4);
    expect(presentHeal.mock.calls).toEqual(Array.from({ length: 4 }, () => [parent, { ...context, tick: 18 }]));
  });

  it('anchors its first cast to spawn even when registration misses the spawn turn', () => {
    const { first, context } = fixture();
    const registration = healerDefinition.register(undefined);

    for (let tick = 11; tick <= 14; tick++) registration.tick(first, { ...context, tick });

    expect(context.tickEvents.flush().filter(isEncounterVisualEvent)).toHaveLength(1);
  });

  it('casts independently from spawn plus four every three ticks without default HP effects', () => {
    const { first, second, parent, context } = fixture();
    const registration = healerDefinition.register(undefined);
    const casts: [string, number][] = [];
    const hp = parent.vitals.hp;

    for (let tick = 10; tick <= 20; tick++) {
      context.tickEvents.setTick(tick);
      for (const actor of [first, second]) {
        registration.resolveLocalEffects(actor, { ...context, tick });
        registration.tick(actor, { ...context, tick });
      }
      for (const event of context.tickEvents.flush().filter(isEncounterVisualEvent))
        for (const cue of event.animations) casts.push([cue.actorId, tick]);
    }

    expect(casts).toEqual([
      ['first', 14],
      ['second', 15],
      ['first', 17],
      ['second', 18],
      ['first', 20],
    ]);
    expect(parent.vitals.hp).toBe(hp);
  });

  it('applies a fixed supplied sample at cast plus four and caps it without redirecting in-flight support', () => {
    const { first, parent, world, context } = fixture();
    parent.vitals.hp = parent.vitals.maxHp - 7;
    const other = createInfernoActor('jad', 'other', [30, 30]);
    other.vitals.hp -= 50;
    world.actors.set(other.id, other);
    const registration = healerDefinition.register({ sampleHeal: () => 19 });
    for (let tick = 10; tick <= 14; tick++) registration.tick(first, { ...context, tick });
    first.state.supportTargetId = other.id;

    registration.resolveLocalEffects(first, { ...context, tick: 17 });
    expect(parent.vitals.hp).toBe(parent.vitals.maxHp - 7);
    registration.resolveLocalEffects(first, { ...context, tick: 18 });

    expect(parent.vitals.hp).toBe(parent.vitals.maxHp);
    expect(other.vitals.hp).toBe(other.vitals.maxHp - 50);
    expect(context.tickEvents.flush()).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'hitsplat_spawned', targetId: parent.id, amount: 7 })]),
    );
  });

  it('switches only the attacked actor to next-tick reaction then period three with an optional spark callback', () => {
    const { first, second, parent, world, context } = fixture();
    const attacker = createInfernoActor('jad', 'player', [20, 20]);
    world.actors.set(attacker.id, attacker);
    const registration = healerDefinition.register(undefined);
    for (let tick = 10; tick <= 16; tick++)
      for (const actor of [first, second]) registration.tick(actor, { ...context, tick });
    context.tickEvents.flush();
    notifyNpcOfPlayerAttack(first, {
      sourceId: attacker.id,
      launchTick: 16,
      impactTick: 17,
      style: 'range',
      accuracySucceeded: true,
    });
    const reactions: number[] = [];

    for (let tick = 17; tick <= 24; tick++) {
      world.tick = tick;
      processNpcRetaliations(world);
      registration.tick(first, { ...context, tick });
      for (const event of context.tickEvents.flush().filter(isEncounterVisualEvent)) {
        if (event.animations.some((cue) => cue.clipId === 'attack')) reactions.push(tick);
        expect(event.projectiles).toEqual([]);
      }
    }

    expect(reactions).toEqual([18, 21, 24]);
    expect(second.combat.targetId).toBeNull();
    expect(first.state.supportTargetId).toBe(parent.id);
  });

  it('delegates tagged ready casts after audio, including one-tick retaliation recovery', () => {
    const { first, second, parent, world, context } = fixture();
    const calls: { readonly tick: number; readonly actorId: string; readonly targetId: string }[] = [];
    const castSparks: NonNullable<HealerConfig['castSparks']> = ({ actor, target, context: castContext }) => {
      calls.push({ tick: castContext.tick, actorId: actor.id, targetId: target.id });
      const events = castContext.tickEvents.flush();
      expect(events.at(-1)).toMatchObject({ type: 'zuk_healer_cast', sourceId: actor.id, targetId: target.id });
      expect(events.filter((event) => event.type === 'zuk_healer_cast')).toHaveLength(1);
      expect(actor).toBe(first);
      expect(target).toBe(parent);
      expect(castContext.world).toBe(world);
    };
    const sampleHeal = vi.fn(() => 19);
    const registration = healerDefinition.register({ castSparks, sampleHeal });
    for (let tick = 10; tick <= 16; tick++) registration.tick(first, { ...context, tick });
    context.tickEvents.flush();
    notifyNpcOfPlayerAttack(first, {
      sourceId: parent.id,
      launchTick: 16,
      impactTick: 17,
      style: 'range',
      accuracySucceeded: true,
    });

    for (let tick = 17; tick <= 24; tick++) {
      world.tick = tick;
      processNpcRetaliations(world);
      registration.tick(first, { ...context, tick });
    }

    expect(calls).toEqual([18, 21, 24].map((tick) => ({ tick, actorId: first.id, targetId: parent.id })));
    expect(sampleHeal).toHaveBeenCalledTimes(1);
    expect(second.combat.targetId).toBeNull();
  });

  it('does not delegate sparks while unengaged heal actions remain active', () => {
    const { first, context } = fixture();
    const castSparks = vi.fn();
    const sampleHeal = vi.fn(() => 19);
    const registration = healerDefinition.register({ castSparks, sampleHeal });

    for (let tick = 10; tick <= 20; tick++) registration.tick(first, { ...context, tick });

    expect(castSparks).not.toHaveBeenCalled();
    expect(sampleHeal).toHaveBeenCalledTimes(3);
    expect(first.state.pendingHeals.map((heal) => heal.applyTick)).toEqual([18, 21, 24]);
  });

  it.each(['dead-source', 'dead-target', 'missing-target'] as const)('stops tagged callbacks after %s', (boundary) => {
    const { first, parent, world, context } = fixture();
    first.combat.targetId = parent.id;
    const castSparks = vi.fn();
    const registration = healerDefinition.register({ castSparks });
    registration.tick(first, { ...context, tick: 14 });
    switch (boundary) {
      case 'dead-source':
        first.alive = false;
        break;
      case 'dead-target':
        parent.alive = false;
        break;
      case 'missing-target':
        world.actors.delete(parent.id);
        break;
      default:
        throw new TypeError(`Unexpected boundary: ${boundary satisfies never}`);
    }

    for (let tick = 15; tick <= 20; tick++) registration.tick(first, { ...context, tick });

    expect(castSparks).toHaveBeenCalledTimes(1);
  });

  it.each([
    'death',
    'despawn',
    'missing-target',
    'dead-target',
  ] as const)('cancels a queued application at the %s boundary', (boundary) => {
    const { first, parent, world, context } = fixture();
    const registration = healerDefinition.register({ sampleHeal: () => 19 });
    for (let tick = 10; tick <= 14; tick++) registration.tick(first, { ...context, tick });
    const before = parent.vitals.hp;
    if (boundary === 'death') {
      first.alive = false;
      registration.notifyDefeated(first, { npcId: first.id, tick: 15 }, 'encounter-owned', context);
    }
    if (boundary === 'despawn') registration.notifyDespawn(first, context);
    if (boundary === 'missing-target') world.actors.delete(parent.id);
    if (boundary === 'dead-target') parent.alive = false;

    registration.resolveLocalEffects(first, { ...context, tick: 18 });

    expect(parent.vitals.hp).toBe(before);
    expect(first.state.pendingHeals).toEqual([]);
    expect(
      createHealer({ id: 'fresh', position: [1, 1], spawnTick: 0, supportTargetId: 'new' }).state.pendingHeals,
    ).toEqual([]);
  });
});
