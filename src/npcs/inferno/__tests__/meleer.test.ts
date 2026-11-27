import { afterEach, describe, expect, it } from 'vitest';
import { canInitiateAttackOnNpc, isNpcTargetable } from '../../../core/actors/NpcActor';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import type { GameEvent } from '../../../core/events/types';
import { createNpcStepOccupancyPredicate } from '../../../core/npcOccupancy';
import type { Coordinate } from '../../../types/simulation';
import { createInfernoActor } from '../actors';
import { createMeleer, meleerResurfacePosition } from '../meleer';
import { createInfernoWaveNpc } from '../waveNpcs';
import { createWaveEngine } from './waveFixture';

afterEach(() => {
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

function clipTicks(events: readonly GameEvent[], actorId: string, clipId: string): number[] {
  return events
    .filter(isEncounterVisualEvent)
    .filter((event) =>
      event.animations.some((animation) => animation.actorId === actorId && animation.clipId === clipId),
    )
    .map((event) => event.tick);
}

// Far enough that a meleer from (0, 0), walking a tile a tick, never reaches the player before its first
// dig; inside the engine's 64x64 grid.
const FAR_PLAYER: Coordinate = [60, 60];

describe('Jal-ImKot dig', () => {
  it("digs first at spawn+50, resurfaces 3 ticks later around the player's dig-down tile, walks from up+3 and attacks from up+9", () => {
    const meleer = createMeleer({ id: 'meleer', position: [0, 0], spawnTick: 0, targetId: 'player' });
    const { advanceTo, events, player } = createWaveEngine([meleer], { startPos: FAR_PLAYER });
    advanceTo(50);
    const buried = [...meleer.position];
    expect(clipTicks(events, 'meleer', 'dig_down')).toEqual([50]);
    // The player moves while it is underground; the resurface reads the tile from the start of the
    // down tick (42/42 captured telejumps, e.g. P t3017-3020).
    advanceTo(52, () => [60, 63]);
    expect(meleer.position).toEqual(buried);
    advanceTo(53, () => [60, 63]);
    expect(clipTicks(events, 'meleer', 'dig_up')).toEqual([53]);
    // Sound owners at the SW tile before and after the dig (sound_area 1641 / 1644).
    expect(events.filter((event) => event.type === 'inferno_ability')).toMatchObject([
      { tick: 50, ability: 'meleer_dig_down', actorId: 'meleer', position: buried },
      { tick: 53, ability: 'meleer_dig_up', actorId: 'meleer', position: [57, 57] },
    ]);
    // Player's dig-down tile at the NE corner of the 4x4 footprint (25/42 captured resurfaces).
    expect(meleer.position).toEqual([57, 57]);
    expect(player.position).not.toEqual(FAR_PLAYER);

    // Step back to the tile north of the footprint and wait.
    advanceTo(55, () => [60, 61]);
    expect(meleer.position).toEqual([57, 57]);
    advanceTo(66, () => [60, 61]);
    // Up t53: nothing at up+6..+8, first swing at up+9 (facts spec, 17/25 exactly +9).
    expect(clipTicks(events, 'meleer', 'attack')).toEqual([62, 66]);
  });

  it('does not attack while underground', () => {
    const meleer = createMeleer({ id: 'meleer', position: [57, 56], spawnTick: 0, targetId: 'player' });
    const { advanceTo, events, engine } = createWaveEngine([meleer], { startPos: FAR_PLAYER });
    advanceTo(49);
    // Adjacent from the start: attacks every 4 ticks, so the spawn+50 check is suppressed.
    expect(clipTicks(events, 'meleer', 'attack').at(-1)).toBe(49);
    // 20 ticks before the check: outside the swing + 4 + 15 window, so it digs.
    meleer.combat.lastAttackTick = 30;
    advanceTo(56);
    expect(clipTicks(events, 'meleer', 'dig_down')).toEqual([50]);
    expect(clipTicks(events, 'meleer', 'attack').filter((tick) => tick >= 50)).toEqual([]);
    expect(engine.getDamageHistory().filter((hit) => hit.tick >= 50)).toEqual([]);
  });

  it('digs before a swing that is ready on the check tick: that swing neither blocks the dig nor lands', () => {
    const meleer = createMeleer({ id: 'meleer', position: [57, 56], spawnTick: 0, targetId: 'player' });
    const { advanceTo, events } = createWaveEngine([meleer], { startPos: FAR_PLAYER });
    advanceTo(49);
    // Adjacent and ready to swing at the t50 check, last swing 20 ticks earlier.
    meleer.combat.lastAttackTick = 30;
    meleer.combat.nextActionTick = 50;
    advanceTo(50);
    expect(clipTicks(events, 'meleer', 'dig_down')).toEqual([50]);
    expect(clipTicks(events, 'meleer', 'attack').filter((tick) => tick >= 50)).toEqual([]);
  });

  it.each([
    { lastAttack: 31, dug: false, next: 90 },
    { lastAttack: 30, dug: true, next: 96 },
  ])('skips a check while swing + 4 is within 15 ticks (swing $lastAttack; P t7331 -> t7349 corner trap)', ({
    lastAttack,
    dug,
    next,
  }) => {
    // P t7349 was suppressed 18 ticks after a swing at t7331; 19 is the inclusive edge.
    const meleer = createMeleer({ id: 'meleer', position: [0, 0], spawnTick: 0, targetId: 'player' });
    const { advanceTo, events, random } = createWaveEngine([meleer], { startPos: FAR_PLAYER });
    advanceTo(49);
    meleer.combat.lastAttackTick = lastAttack;
    random.next = () => 0;
    advanceTo(50);
    expect(clipTicks(events, 'meleer', 'dig_down')).toEqual(dug ? [50] : []);
    // Draw 0 -> 40: from the check when suppressed, from the walk-again tick (down+6) after a dig.
    expect(meleer.state.nextDigCheckTick).toBe(next);
  });

  it('digs despite a flinch-pushed action clock: only its own swings block a dig (P t9229-9236)', () => {
    const meleer = createMeleer({ id: 'meleer', position: [0, 0], spawnTick: 0, targetId: 'player' });
    const { advanceTo, events } = createWaveEngine([meleer], { startPos: FAR_PLAYER });
    advanceTo(49);
    expect(meleer.combat.lastAttackTick).toBeNull();
    // As if retaliation pushed its next action past the check after a player hit.
    meleer.combat.nextActionTick = 52;
    advanceTo(50);
    expect(clipTicks(events, 'meleer', 'dig_down')).toEqual([50]);
  });

  it.each([
    [0.999999, 116],
    [0.5, 106],
  ])('rechecks 40-60 ticks after it may walk again, down+6 (draw %s -> %i)', (draw, next) => {
    const meleer = createMeleer({ id: 'meleer', position: [0, 0], spawnTick: 0, targetId: 'player' });
    const { advanceTo, events, random } = createWaveEngine([meleer], { startPos: FAR_PLAYER });
    random.next = () => draw;
    advanceTo(50);
    expect(clipTicks(events, 'meleer', 'dig_down')).toEqual([50]);
    expect(meleer.state.nextDigCheckTick).toBe(next);
  });

  it('first digs at add+49 when resurrected, at half HP', () => {
    const meleer = createInfernoWaveNpc('meleer', {
      id: 'meleer',
      position: [0, 0],
      spawnTick: 0,
      targetId: 'player',
      origin: 'resurrection',
    });
    expect(meleer.vitals).toEqual({ hp: 38, maxHp: 75 });
    const { advanceTo, events } = createWaveEngine([meleer], { startPos: FAR_PLAYER });
    advanceTo(50);
    expect(clipTicks(events, 'meleer', 'dig_down')).toEqual([49]);
  });

  it('resurfaces onto other NPCs: only terrain rules a footprint out', () => {
    // P t8396 resurfaced over a bat (P:152815-152827), Q t3847 over a mager (Q:81854-81857).
    const meleer = createMeleer({ id: 'meleer', position: [0, 0], spawnTick: 0, targetId: 'player' });
    const bat = createInfernoActor('bat', 'bat', [58, 58]);
    const { advanceTo, world } = createWaveEngine([meleer, bat], { startPos: FAR_PLAYER });
    advanceTo(53);
    expect(meleer.position).toEqual([57, 57]);
    expect(world.getNpc('bat')?.position).toEqual([58, 58]);
  });

  it('falls back to the footprint with the player on its SW corner when the NE-corner one is off the floor', () => {
    const meleer = createMeleer({ id: 'meleer', position: [18, 18], spawnTick: 0, targetId: 'player' });
    const { world } = createWaveEngine([meleer], { startPos: [30, 32] });
    // Every tile walkable except (27,29), inside the NE-corner footprint (SW 27,29).
    const tiles = new Set<string>();
    for (let x = 0; x < 64; x++) for (let y = 0; y < 64; y++) if (x !== 27 || y !== 29) tiles.add(`${x},${y}`);
    setArenaConfig({ bounds: null, walkableTiles: tiles, collisionMap: null }, true);
    expect(world.getNpc('meleer')).toBe(meleer);
    expect(meleerResurfacePosition(meleer, [30, 32])).toEqual([30, 32]);
  });

  it.each([
    ['north', [30, 33]],
    ['south', [30, 28]],
    ['east', [31, 32]],
    ['west', [26, 32]],
  ] as const)('finds the only free footprint one tile %s of the player', (_, anchor) => {
    const meleer = createMeleer({ id: 'meleer', position: [18, 18], spawnTick: 0, targetId: 'player' });
    const { world } = createWaveEngine([meleer], { startPos: [30, 32] });
    // Only the anchor's 4x4 is walkable, so no footprint containing the player's tile is valid.
    const tiles = new Set<string>();
    for (let dx = 0; dx < 4; dx++) for (let dy = 0; dy < 4; dy++) tiles.add(`${anchor[0] + dx},${anchor[1] + dy}`);
    setArenaConfig({ bounds: null, walkableTiles: tiles, collisionMap: null }, true);

    expect(world.getNpc('meleer')).toBe(meleer);
    expect(meleerResurfacePosition(meleer, [30, 32])).toEqual(anchor);
  });
});

describe('Jal-ImKot underground', () => {
  it('cannot be targeted from dig-down to the up tick, and is targetable again once it resurfaces', () => {
    const meleer = createMeleer({ id: 'meleer', position: [0, 0], spawnTick: 0, targetId: 'player' });
    const { advanceTo, engine, player } = createWaveEngine([meleer], { startPos: FAR_PLAYER });
    advanceTo(49);
    // The player is already attacking it when it digs: the attack is dropped, not carried underground.
    engine.setAttackTarget(meleer.id);
    advanceTo(50);
    expect(meleer.state.dig).toEqual({ downTick: 50, target: FAR_PLAYER });
    expect(player.attackTarget).toBeNull();
    for (const tick of [51, 52]) {
      advanceTo(tick);
      expect(canInitiateAttackOnNpc(meleer, tick)).toBe(false);
      expect(isNpcTargetable(meleer, tick)).toBe(false);
      engine.setAttackTarget(meleer.id);
      expect(player.attackTarget).toBeNull();
    }
    advanceTo(53);
    expect(meleer.state.dig).toBeNull();
    expect(meleer.targetableFromTick).toBeUndefined();
    engine.setAttackTarget(meleer.id);
    expect(player.attackTarget).toBe(meleer.id);
  });

  it('keeps blocking from its old footprint while underground', () => {
    // P wave 63: dug at (37,37) t8806 (P:159828-159830); the mager behind it waits until t8810.
    const meleer = createMeleer({ id: 'meleer', position: [0, 0], spawnTick: 0, targetId: 'player' });
    const { advanceTo, world } = createWaveEngine([meleer], { startPos: FAR_PLAYER });
    const stepsIntoBuried = () => {
      const [x, y] = meleer.position;
      // A 1x1 walker stepping east onto the footprint's west column.
      return createNpcStepOccupancyPredicate(world.occupancy)([x - 1, y + 1], [x, y + 1], 1);
    };
    advanceTo(50);
    expect(meleer.state.dig).toEqual({ downTick: 50, target: FAR_PLAYER });
    for (const tick of [50, 51, 52]) {
      advanceTo(tick);
      expect(stepsIntoBuried()).toBe(false);
      expect(world.occupancy.isBlocked(meleer.position[0] + 3, meleer.position[1] + 3)).toBe(true);
    }
  });
});
