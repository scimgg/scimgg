import { afterEach, describe, expect, it } from 'vitest';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import type { EncounterPlayerDamageInfo } from '../../../core/encounters/types';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { PrayerType } from '../../../types/simulation';
import { createBat, jalMejRahDrainEffect } from '../bat';
import { createWaveEngine } from './waveFixture';

afterEach(() => {
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

function batHit(overrides: Partial<EncounterPlayerDamageInfo> = {}): EncounterPlayerDamageInfo {
  return {
    sourceKind: 'combat',
    source: 'NpcAttack',
    tick: 5,
    attackType: 'range',
    baseDamage: 7,
    effectiveDamage: 7,
    prayedCorrectly: false,
    hpBefore: 99,
    hpAfter: 92,
    sourceNpcTypeId: 7692,
    ...overrides,
  };
}

describe('Jal-MejRah attacks', () => {
  it('fires every 3 ticks from add+1 and lands after floor((32 + 8D) / 30) from its SW tile', () => {
    // SW (10, 16), player (10, 20): SW distance 4 (endtime 64, +2 ticks); the center-tile distance would be 3.
    const bat = createBat({ id: 'bat', position: [10, 16], spawnTick: 0, targetId: 'player' });
    const { engine, advanceTo, events } = createWaveEngine([bat]);
    advanceTo(10);

    const launches = events.filter(isEncounterVisualEvent).filter((event) => event.animations[0]?.clipId === 'attack');
    expect(launches.map((event) => event.tick)).toEqual([1, 4, 7, 10]);
    expect(launches[0]?.projectiles).toMatchObject([
      { spotAnimId: 1382, startDelayCycles: 10, endDelayCycles: 64, slope: 16, startOffset: 128, startHeight: 200 },
    ]);
    expect(engine.getDamageHistory().map((hit) => hit.tick)).toEqual([3, 6, 9]);
  });

  it('only attacks from within 4 tiles of its footprint edge', () => {
    const bat = createBat({ id: 'bat', position: [10, 13], spawnTick: 0, targetId: 'player' });
    const { advanceTo, events } = createWaveEngine([bat]);
    advanceTo(2);
    // Player at y 20 is 6 tiles from the bat's north edge (y 14) on tick 1; it steps in first.
    const attacks = events.filter(isEncounterVisualEvent).filter((event) => event.animations[0]?.clipId === 'attack');
    expect(attacks.map((event) => event.tick)).toEqual([2]);
    expect(bat.position).toEqual([10, 15]);
  });
});

describe('Jal-MejRah drain policy', () => {
  it('drains 3 run energy per hit and 1 from each combat stat on a damaging hit', () => {
    expect(jalMejRahDrainEffect(batHit())).toEqual({
      runEnergyDelta: -300,
      playerStatDrains: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
    });
    expect(jalMejRahDrainEffect(batHit({ baseDamage: 0, effectiveDamage: 0 }))).toEqual({ runEnergyDelta: -300 });
  });

  it.each([
    ['Protect from Missiles', batHit({ prayedCorrectly: true, effectiveDamage: 0 })],
    ['another NPC', batHit({ sourceNpcTypeId: 7698 })],
    ['an environmental hit', batHit({ sourceKind: 'environment' })],
  ])('drains nothing for %s', (_, info) => {
    expect(jalMejRahDrainEffect(info)).toBeNull();
  });

  it.each([false, true])('drains through the engine hook, Protect from Missiles=%s', (protectedFromMissiles) => {
    const bat = createBat({ id: 'bat', position: [10, 16], spawnTick: 0, targetId: 'player' });
    const { engine, player, advanceTo } = createWaveEngine([bat], {
      rules: { onPlayerDamageTaken: jalMejRahDrainEffect },
    });
    player.activePrayer = protectedFromMissiles ? PrayerType.ProtectRange : null;
    player.equipmentStats = { ...player.equipmentStats, defenceRanged: -1000 };
    const ranged = player.stats.ranged.current;
    expect(player.runEnergy.energy).toBe(10000);
    advanceTo(3);

    const hits = engine.getDamageHistory();
    expect(hits).toMatchObject([{ tick: 3, effectiveDamage: protectedFromMissiles ? 0 : 10 }]);
    // The drain runs before that tick's regeneration (24 units at 99 Agility).
    expect(player.runEnergy.energy).toBe(protectedFromMissiles ? 10000 : 10000 - 300 + 24);
    expect(player.stats.ranged.current).toBe(protectedFromMissiles ? ranged : ranged - 1);
    expect(player.stats.magic.current).toBe(protectedFromMissiles ? ranged : ranged - 1);
  });
});
