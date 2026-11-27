import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AudioEngine } from '../../audio/AudioEngine';
import { coreAudioRules } from '../../audio/coreAudioRules';
import { EventAudioPlayer } from '../../audio/EventAudioPlayer';
import type { NpcActor } from '../../core/actors/NpcActor';
import type { PlayerActor } from '../../core/actors/PlayerActor';
import { CombatSystem } from '../../core/combat/CombatSystem';
import type { PlayerAutoAttackDeps } from '../../core/combat/player/PlayerAutoAttackSystem';
import { processPlayerAutoAttack } from '../../core/combat/player/PlayerAutoAttackSystem';
import { setArenaConfig } from '../../core/constants';
import { TickEvents } from '../../core/events/TickEvents';
import { type GameEvent, isCoreEvent } from '../../core/events/types';
import { WorldState } from '../../core/WorldState';
import type { ReplayEffectSourceFrame } from '../../render/core/replayEffectContext';
import { describePlayerPrimaries } from '../../render/core/replayPrimaryCues';
import { describePlayerEffects, projectileEndCycle } from '../../render/effects/playerEffectDescriptors';
import { getWeaponCategory } from '../../types/attackStyles';
import { createEmptyCombatSupplies } from '../../types/encounterLoadout';
import { createEmptyStats } from '../../types/equipmentStats';
import { createDefaultSpecialAttack } from '../../types/playerState';
import { CAPTURED_ATTACKS, type CapturedAttack } from './fixtures/weaponSoulreaperTridentsAttacks';

/**
 * Every attack in the capture, replayed through the real attack system and then through the same
 * presentation the app uses: the audio rules, the replay animation cues and the effect descriptors.
 * Tables alone cannot catch a rule that is right but never reached, or a swing sound that a special
 * also plays.
 *
 * The player stands one tile south of a POH combat dummy throughout. `com_mode` is the style
 * button: 0-3, with the last button of a three- or two-style weapon in slot 3.
 */
const CAPTURE =
  'weapon-soulreaper-fang-dragonwarhammer-zombieaxe-noxhalberd-tridentoftheswamps-tridentoftheseas-packet-data.txt';
const PLAYER_TILE: [number, number] = [10, 9];
const DUMMY_TILE: [number, number] = [10, 10];

function styleIndex(weaponId: number, comMode: number): number {
  const styles = getWeaponCategory(weaponId).styles.length;
  return comMode === 3 ? styles - 1 : Math.min(comMode, styles - 2);
}

function attacker(weaponId: number, selectedAttackStyleIndex: number, special: boolean): PlayerActor {
  return {
    id: 'player',
    kind: 'player',
    alive: true,
    position: PLAYER_TILE,
    previousPosition: PLAYER_TILE,
    facing: 0,
    size: 1,
    vitals: { hp: 99, maxHp: 99 },
    movementPath: [],
    isMoving: false,
    isRunning: false,
    history: new Map(),
    activePrayer: null,
    boostPrayers: [],
    independentPrayers: [],
    prayerState: { points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} },
    stats: Object.fromEntries(
      ['attack', 'strength', 'defence', 'ranged', 'magic', 'prayer', 'hitpoints', 'agility'].map((skill) => [
        skill,
        { current: 99, max: 99 },
      ]),
    ),
    specialAttack: createDefaultSpecialAttack(),
    combatTimers: { markOfDarknessActiveTicks: 0, statBoostDecayTick: 100 },
    inventory: Array(28).fill(null),
    combatSupplies: createEmptyCombatSupplies(),
    isRunEnabled: true,
    isSpecialAttackActive: special,
    runEnergy: { energy: 10000 },
    ctrlClickOverride: false,
    equipment: { weapon: weaponId },
    equipmentStats: createEmptyStats(),
    cooldownTracks: { food: 0, potion: 0, combo_food: 0 },
    pendingInputOps: [],
    quickPrayersActive: false,
    activeEffects: [],
    attackTarget: 'dummy',
    autoAttackPause: null,
    selectedAttackStyleIndex,
    pendingConflictionAttack: null,
    manualCastSpell: null,
    attackInteractionActive: true,
    xpCounters: {},
  } as unknown as PlayerActor;
}

const DUMMY = {
  id: 'dummy',
  kind: 'npc',
  alive: true,
  position: DUMMY_TILE,
  previousPosition: DUMMY_TILE,
  facing: 0,
  size: 1,
  vitals: { hp: 10_000, maxHp: 10_000 },
  combat: { attackSpeed: 4, attackStyle: 'melee', attackRange: 1, nextActionTick: 0, targetId: null, animations: {} },
  npcTypeId: 2668,
  formulaStats: {
    levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
    offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
    defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
  },
} as unknown as NpcActor;

/** The attack the real attack system launches for one captured swing. */
function launch(weaponId: number, attack: CapturedAttack): Extract<GameEvent, { type: 'attack_started' }> {
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  const player = attacker(weaponId, styleIndex(weaponId, attack.comMode), attack.special);
  const world = new WorldState();
  world.tick = attack.tick;
  world.actors.set(player.id, player);
  world.actors.set(DUMMY.id, { ...DUMMY, vitals: { ...DUMMY.vitals } });
  const deps: PlayerAutoAttackDeps = {
    world,
    tickEvents: new TickEvents(),
    combatSystem: new CombatSystem(),
    infiniteHealth: true,
    onDamageApplied: () => {},
    combatSupplies: createEmptyCombatSupplies(),
    lookupItemStats: () => createEmptyStats(),
    // Every roll lands: the capture's splats are all max hits.
    random: () => 0,
  };
  deps.tickEvents.setTick(attack.tick);
  processPlayerAutoAttack(player, deps);
  const started = deps.tickEvents.flush().find((event) => isCoreEvent(event, 'attack_started'));
  if (!started || !isCoreEvent(started, 'attack_started')) throw new Error(`No attack launched at ${attack.tick}`);
  expect(started.usingSpecialAttack === true, `special at ${attack.tick}`).toBe(attack.special);
  return started;
}

function frameOf(weaponId: number, event: GameEvent): ReplayEffectSourceFrame {
  return {
    state: {
      currentTick: event.tick,
      playerPosition: PLAYER_TILE,
      primaryNpcPosition: DUMMY_TILE,
      primaryNpcSize: 1,
      playerEquipment: { weapon: weaponId },
      npcs: [],
    },
    events: [event],
  } as unknown as ReplayEffectSourceFrame;
}

afterEach(() => {
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  vi.restoreAllMocks();
});

const ATTACKS = CAPTURED_ATTACKS;
const CASES = ATTACKS.flatMap((attack) => attack.weaponIds.map((weaponId) => ({ weaponId, ...attack })));

describe(`every attack in capture ${CAPTURE}`, () => {
  it('reads 28 swings, three of them specials', () => {
    expect(ATTACKS).toHaveLength(28);
    expect(ATTACKS.filter((attack) => attack.special).map((attack) => attack.tick)).toEqual([473, 522, 551]);
  });

  it.each(CASES)('plays tick $tick ($weaponId, com_mode $comMode) as captured', (attack) => {
    const event = launch(attack.weaponId, attack);

    // On the swing tick, landing a melee splat one tick later and a trident's two.
    expect(event.tick).toBe(attack.tick);
    expect(attack.tick + (event.impactDelayTicks ?? 0)).toBe(attack.splatTick);

    const play = vi.fn();
    const audio = new EventAudioPlayer({ play, preloadSounds: vi.fn() } as unknown as AudioEngine, coreAudioRules);
    audio.onEvents([event], PLAYER_TILE);
    const sounds = play.mock.calls
      .map(([id, options]) => [id, Math.round((options.delayMs ?? 0) / 20)] as const)
      .sort((left, right) => left[0] - right[0]);
    expect(sounds).toEqual(attack.sounds);

    const frame = frameOf(attack.weaponId, event);
    const swing = describePlayerPrimaries(frame).find((cue) => cue.kind === 'attack');
    expect(swing?.sequenceIds[0]).toBe(attack.sequence);

    const effects = describePlayerEffects(frame);
    const graphic = effects.find((effect) => effect.kind === 'graphic');
    expect(graphic ? [graphic.spotAnimId, graphic.height] : null).toEqual(attack.playerGraphic);

    const projectile = effects.find((effect) => effect.kind === 'projectile');
    if (attack.projectile === null) {
      expect(projectile).toBeUndefined();
      expect(attack.impact).toBeNull();
      return;
    }
    if (projectile?.kind !== 'projectile') expect.fail(`Expected a projectile at ${attack.tick}`);
    expect({
      id: projectile.visuals.projectileId,
      start: projectile.visuals.projectileStartDelay,
      end: projectileEndCycle(projectile) - attack.tick * 30,
      angle: projectile.visuals.projectileSlope,
      progress: projectile.timing?.progress,
      heights: [projectile.visuals.projectileStartHeight, projectile.visuals.projectileEndHeight],
    }).toEqual(attack.projectile);
    // The impact graphic lands with the projectile.
    expect([
      projectile.visuals.hitSpotanim,
      projectileEndCycle(projectile) - attack.tick * 30,
      projectile.visuals.hitSpotanimHeight,
    ]).toEqual(attack.impact);
  });
});
