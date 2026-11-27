import { afterEach, describe, expect, it } from 'vitest';
import type { NpcActor } from '../../../core/actors/NpcActor';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import type { GameEvent } from '../../../core/events/types';
import type { Coordinate } from '../../../types/simulation';
import { createInfernoActor } from '../actors';
import { createNibbler } from '../nibbler';
import { createWaveEngine } from './waveFixture';

afterEach(() => {
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

/** Stand-in for the encounter's invisible 3x3 Rocky support proxy (NPC 7709, 255 HP). */
function pillar(id: string, position: Coordinate): NpcActor {
  const actor = createInfernoActor('shield', id, position);
  return { ...actor, npcTypeId: 7709, archetypeId: 'inferno_pillar', vitals: { hp: 255, maxHp: 255 } };
}

function attackTicks(events: readonly GameEvent[], actorId: string): number[] {
  return events
    .filter(isEncounterVisualEvent)
    .filter((event) => event.animations.some((cue) => cue.actorId === actorId && cue.clipId === 'attack'))
    .map((event) => event.tick);
}

// Facts spec pillar tiles (west, south, north-east), local coordinates.
const PILLAR_TILES: readonly Coordinate[] = [
  [17, 37],
  [27, 23],
  [34, 39],
];

describe('Jal-Nib pillar targeting', () => {
  it("heads for the wave's pillar, whatever else stands nearer", () => {
    const pillars = ['west', 'south', 'north-east'].map((id, index) => pillar(id, PILLAR_TILES[index]));
    const nibbler = createNibbler({ id: 'nib', position: [26, 34], spawnTick: 0 });
    const { advanceTo, random } = createWaveEngine([...pillars, nibbler], { waveTarget: () => pillars[1] });
    // A draw that would pick another pillar changes nothing: the nibbler draws no target of its own.
    random.next = () => 0;
    advanceTo(1);
    expect(nibbler.combat.targetId).toBe('south');
  });

  it('first swings the tick after it reaches its attack tile, then every 4 ticks for 0-4', () => {
    // P wave 9 (index 39536): added at (25,33) t929, reaches (20,37) t934, first hit t935 = add+6.
    const target = pillar('west', [17, 37]);
    const nibbler = createNibbler({ id: 'nib', position: [25, 33], spawnTick: 0 });
    const { random, advanceTo, events, engine } = createWaveEngine([target, nibbler], { waveTarget: () => target });
    random.next = () => 0.999999;
    advanceTo(5);
    expect(nibbler.position).toEqual([20, 37]);
    expect(attackTicks(events, 'nib')).toEqual([]);
    advanceTo(14);
    expect(attackTicks(events, 'nib')).toEqual([6, 10, 14]);
    expect(target.vitals.hp).toBe(255 - 3 * 4);
    expect(engine.getDamageHistory().filter((hit) => hit.targetId === 'player')).toEqual([]);
  });

  it('staggers first swings by arrival', () => {
    const target = pillar('west', [17, 37]);
    const near = createNibbler({ id: 'near', position: [21, 37], spawnTick: 0 });
    const far = createNibbler({ id: 'far', position: [24, 37], spawnTick: 0 });
    const { advanceTo, events } = createWaveEngine([target, near, far], { waveTarget: () => target });
    advanceTo(10);
    // `near` arrives on its first turn (t1), `far` walks four tiles (t4); each swings the tick after.
    expect(attackTicks(events, 'near')).toEqual([2, 6, 10]);
    expect(attackTicks(events, 'far')).toEqual([5, 9]);
  });

  it('turns on the player for good once its pillar collapses, with no re-draw', () => {
    const pillars = ['west', 'south', 'north-east'].map((id, index) => pillar(id, PILLAR_TILES[index]));
    const nibbler = createNibbler({ id: 'nib', position: [20, 37], spawnTick: 0 });
    let waveTarget: NpcActor | null = pillars[0];
    const { advanceTo, engine } = createWaveEngine([...pillars, nibbler], { waveTarget: () => waveTarget });
    advanceTo(3);
    expect(nibbler.combat.targetId).toBe('west');
    engine['despawnEncounterNpc']('west');
    waveTarget = null;
    advanceTo(4);
    expect(nibbler.combat.targetId).toBe('player');
    // Even if the encounter offered a pillar again, the nibbler keeps on the player.
    waveTarget = pillars[1];
    advanceTo(5);
    expect(nibbler.combat.targetId).toBe('player');
  });

  it('attacks the player, always hitting for at most 4, when its wave had no pillar', () => {
    const nibbler = createNibbler({ id: 'nib', position: [10, 19], spawnTick: 0 });
    const { random, advanceTo, engine } = createWaveEngine([nibbler]);
    random.next = () => 0.999999;
    advanceTo(6);
    expect(nibbler.combat.targetId).toBe('player');
    // Adjacent from the start: it arrives on its first turn and swings the tick after.
    expect(engine.getDamageHistory().map((hit) => [hit.tick, hit.effectiveDamage])).toEqual([
      [2, 4],
      [6, 4],
    ]);
  });

  it('does not retaliate: a hit nibbler keeps on its pillar', () => {
    const target = pillar('west', [17, 37]);
    const nibbler = createNibbler({ id: 'nib', position: [24, 37], spawnTick: 0 });
    const { advanceTo, engine } = createWaveEngine([target, nibbler], { waveTarget: () => target });
    advanceTo(1);
    engine.setAttackTarget(nibbler.id);
    advanceTo(8);
    expect(nibbler.combat.targetId).toBe('west');
  });

  // Whether it moves on its add tick is the engine's rule (a wave spawn first moves next tick).
  it('steps on its first turn and first swings the turn after it arrives', () => {
    const target = pillar('west', [17, 37]);
    const nibbler = createNibbler({ id: 'nib', position: [21, 38], spawnTick: 0 });
    const { advanceTo, events } = createWaveEngine([target, nibbler], { waveTarget: () => target });
    advanceTo(1);
    expect(nibbler.position).toEqual([20, 37]);
    expect(attackTicks(events, 'nib')).toEqual([]);
    advanceTo(2);
    expect(attackTicks(events, 'nib')).toEqual([2]);
  });
});

describe('Jal-Nib collision', () => {
  it('stacks on another nibbler and walks through a blob, as the captures show', () => {
    // P:371-375: two nibblers step onto one tile; Q:10432-10504: a nibbler walks through a Jal-Ak.
    const target = pillar('west', [17, 37]);
    const blob = createInfernoActor('blob', 'blob', [20, 36]);
    const first = createNibbler({ id: 'first', position: [24, 38], spawnTick: 0 });
    const second = createNibbler({ id: 'second', position: [24, 38], spawnTick: 0 });
    const { advanceTo, events } = createWaveEngine([target, blob, first, second], { waveTarget: () => target });
    advanceTo(1);
    expect(first.position).toEqual(second.position);
    advanceTo(3);
    // Inside the blob's 3x3 (x 20-22, y 36-38) on its way to the pillar's east edge.
    const [x, y] = first.position;
    expect(x >= 20 && x <= 22 && y >= 36 && y <= 38).toBe(true);
    advanceTo(8);
    expect(first.position).toEqual(second.position);
    expect(attackTicks(events, 'first')).toEqual(attackTicks(events, 'second'));
    expect(attackTicks(events, 'first').length).toBeGreaterThan(0);
  });

  it('does not block other NPCs', () => {
    const nibbler = createNibbler({ id: 'nib', position: [30, 30], spawnTick: 0 });
    expect(nibbler).toMatchObject({ passThruNpcs: true, blocksNpcMovement: false });
  });
});
