import { afterEach, describe, expect, it } from 'vitest';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { isZukAttackEvent } from '../events';
import { createRanger } from '../setMonsters';
import { createInfernoWaveNpc, type InfernoWaveNpcSpecies } from '../waveNpcs';
import { createWaveEngine } from './waveFixture';

afterEach(() => {
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

describe('ordinary-wave removal', () => {
  // Killed on tick 2 with no step: death sequence on tick 3, removal at 3 + the facts-spec delay.
  it.each([
    ['nibbler', 7691, 2],
    ['bat', 7692, 2],
    ['blob', 7693, 2],
    ['blob_mage', 7694, 2],
    ['blob_range', 7695, 2],
    ['blob_melee', 7696, 3],
    ['meleer', 7697, 5],
    ['ranger', 7698, 4],
    ['mager', 7699, 2],
  ] as const satisfies readonly (readonly [
    InfernoWaveNpcSpecies,
    number,
    number,
  ])[])('removes %s (%i) %i ticks after its death sequence', (species, npcTypeId, delay) => {
    // Not yet due to act, so it takes no step that would move its death sequence.
    const actor = createInfernoWaveNpc(species, { id: 'npc', position: [10, 10], spawnTick: 100, targetId: 'player' });
    const { engine, world, removals, advanceTo } = createWaveEngine([actor]);
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
    advanceTo(2 + delay);
    expect(actor).toMatchObject({ npcTypeId, deathAnimationTick: 3 });
    expect(world.getNpc(actor.id)).toBe(actor);
    advanceTo(3 + delay);
    expect(world.getNpc(actor.id)).toBeNull();
    expect(removals).toMatchObject([{ tick: 3 + delay, actorId: 'npc', npcTypeId }]);
    expect(removals[0]?.splits).toHaveLength(species === 'blob' ? 3 : 0);
  });

  it('leaves a wave-69 Jal-Xil to the engine prune, unchanged', () => {
    const actor = createRanger({
      variant: 'zuk',
      id: 'npc',
      position: [10, 10],
      spawnTick: 100,
      initialTargetId: 'player',
      initialDelayTicks: 1,
    });
    const { engine, world, removals, advanceTo } = createWaveEngine([actor]);
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
    advanceTo(12);
    expect(world.getNpc(actor.id)).toBe(actor);
    expect(removals).toEqual([]);
  });
});

describe('ordinary-wave factory', () => {
  it.each([
    ['nibbler', 7691, 1, 10],
    ['bat', 7692, 2, 25],
    ['blob', 7693, 3, 40],
    ['blob_mage', 7694, 1, 15],
    ['blob_range', 7695, 1, 15],
    ['blob_melee', 7696, 1, 15],
    ['meleer', 7697, 4, 75],
    ['ranger', 7698, 3, 125],
    ['mager', 7699, 4, 220],
  ] as const)('builds %s as %i, size %i, %i HP', (species, npcTypeId, size, hp) => {
    const actor = createInfernoWaveNpc(species, { id: 'npc', position: [1, 2], spawnTick: 5, targetId: 'player' });
    expect(actor).toMatchObject({ npcTypeId, size, vitals: { hp, maxHp: hp }, spawnTick: 5, position: [1, 2] });
    expect(actor.role).toBe('minion');
  });

  it.each([
    ['bat', 13],
    ['blob', 21],
    ['meleer', 38],
    ['ranger', 63],
    ['mager', 111],
  ] as const)('revives a %s at floor(maxHp / 2) + 1 = %i', (species, hp) => {
    const actor = createInfernoWaveNpc(species, {
      id: 'npc',
      position: [1, 2],
      spawnTick: 5,
      targetId: 'player',
      origin: 'resurrection',
    });
    expect(actor.vitals.hp).toBe(hp);
  });

  // Player at (10,20). A blob emits its first attack at release, 3 ticks after the read.
  it.each([
    ['bat', [10, 16], 1, 4],
    ['blob', [9, 15], 4, 7],
    ['meleer', [9, 21], 1, 4],
    ['ranger', [9, 13], 1, 4],
    ['mager', [9, 12], 1, 4],
  ] as const)('a revived %s first acts at add+4 (wave spawn: add+%i)', (species, position, wave, revived) => {
    const firstAttack = (origin: 'wave' | 'resurrection') => {
      const actor = createInfernoWaveNpc(species, {
        id: 'npc',
        position: [...position],
        spawnTick: 0,
        targetId: 'player',
        origin,
      });
      const { advanceTo, events } = createWaveEngine([actor]);
      advanceTo(12);
      return events.filter(isZukAttackEvent).find((event) => event.sourceId === 'npc')?.tick;
    };
    expect(firstAttack('wave')).toBe(wave);
    expect(firstAttack('resurrection')).toBe(revived);
  });

  it('lets a revived blob read at add+4 and release at add+7', () => {
    const blob = createInfernoWaveNpc('blob', {
      id: 'blob',
      position: [9, 15],
      spawnTick: 0,
      targetId: 'player',
      origin: 'resurrection',
    });
    const { advanceTo, events } = createWaveEngine([blob]);
    advanceTo(3);
    expect(blob).toMatchObject({ state: { pendingRelease: null } });
    advanceTo(4);
    expect(blob).toMatchObject({ state: { pendingRelease: { releaseTick: 7 } } });
    advanceTo(6);
    expect(events.filter(isZukAttackEvent)).toEqual([]);
    advanceTo(7);
    expect(events.filter(isZukAttackEvent)).toMatchObject([{ sourceId: 'blob', tick: 7 }]);
  });

  it('lets a revived NPC step from add+1', () => {
    const bat = createInfernoWaveNpc('bat', {
      id: 'bat',
      position: [10, 50],
      spawnTick: 0,
      targetId: 'player',
      origin: 'resurrection',
    });
    const { advanceTo } = createWaveEngine([bat]);
    advanceTo(1);
    expect(bat.position).not.toEqual([10, 50]);
  });
});

describe('ordinary-wave sound owners', () => {
  it.each([
    ['nibbler', [10, 19], 'nibbler_melee', undefined],
    ['bat', [10, 16], 'bat_range', 64],
    ['meleer', [9, 21], 'meleer_melee', undefined],
    ['blob_melee', [10, 19], 'blob_melee', undefined],
    ['blob_range', [10, 15], 'blob_range', 72],
    ['blob_mage', [10, 15], 'blob_magic', 68],
  ] as const)('%s emits a %s attack from its SW tile', (species, position, attack, arrival) => {
    const actor = createInfernoWaveNpc(species, {
      id: 'npc',
      position: [...position],
      spawnTick: 0,
      targetId: 'player',
    });
    const { advanceTo, events } = createWaveEngine([actor]);
    advanceTo(3);
    const [first] = events.filter(isZukAttackEvent);
    expect(first).toMatchObject({ attack, sourceId: 'npc', sourcePosition: position, targetId: 'player' });
    expect(first?.projectileArrivalCycles).toBe(arrival);
  });

  it.each([
    ['nibbler', 'nibbler', true],
    ['bat', 'bat', true],
    ['blob', 'blob', true],
    ['blob_mage', 'blob_child', false],
    ['meleer', 'meleer', true],
  ] as const)('%s presents hits as %s (defend %s) and its death on the death sequence', (species, npcKind, defend) => {
    const actor = createInfernoWaveNpc(species, { id: 'npc', position: [10, 10], spawnTick: 100, targetId: 'player' });
    const { engine, advanceTo, events } = createWaveEngine([actor]);
    for (const [impactTick, rolledDamage] of [
      [1, 1],
      [2, actor.vitals.hp],
    ] as const)
      enqueueEnginePendingHit(engine, {
        sourceId: 'player',
        targetId: actor.id,
        style: 'range',
        attackKind: 'range_arrow',
        launchTick: 0,
        impactTick,
        rolledDamage,
        accuracySucceeded: true,
      });
    advanceTo(3);
    expect(events.filter((event) => event.type === 'zuk_hit')).toMatchObject([
      { tick: 1, npcKind },
      { tick: 2, npcKind },
    ]);
    const defends = events
      .filter(isEncounterVisualEvent)
      .flatMap((event) => event.animations)
      .filter((cue) => cue.clipId === 'defend');
    expect(defends).toHaveLength(defend ? 1 : 0);
    expect(events.filter((event) => event.type === 'zuk_death')).toMatchObject([{ tick: 3, npcKind }]);
  });
});
