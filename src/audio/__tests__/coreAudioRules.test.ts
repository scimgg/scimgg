import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameEvent } from '../../core/events/types';
import { EQUIPMENT_COMBAT_FAMILIES } from '../../data/equipmentCombatFamilies';
import { PrayerType } from '../../types/simulation';
import type { AudioEngine } from '../AudioEngine';
import { coreAudioRules } from '../coreAudioRules';
import { EventAudioPlayer } from '../EventAudioPlayer';
import { ALL_SOUND_IDS } from '../soundNames';

describe('coreAudioRules', () => {
  let mockAudioEngine: { play: ReturnType<typeof vi.fn>; preloadSounds: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockAudioEngine = {
      play: vi.fn(),
      preloadSounds: vi.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createPlayer(): EventAudioPlayer {
    return new EventAudioPlayer(mockAudioEngine as unknown as AudioEngine, coreAudioRules);
  }

  it.each(EQUIPMENT_COMBAT_FAMILIES)('inherits ordinary and special sound resolution for family $baseId', ({
    baseId,
    variantIds,
  }) => {
    const player = createPlayer();
    for (const usingSpecialAttack of [false, true]) {
      for (const attackKind of ['melee_stab', 'melee_slash', 'melee_crush', 'range_arrow', 'magic_shadow'] as const) {
        const event: GameEvent = {
          type: 'attack_started',
          eventId: 1,
          tick: 0,
          sourceId: 'player',
          targetId: 'boss',
          style: 'range',
          attackKind,
          weaponId: baseId,
          usingSpecialAttack,
        };
        mockAudioEngine.play.mockClear();
        player.onEvents([event], [0, 0]);
        const baseCalls = [...mockAudioEngine.play.mock.calls];
        for (const weaponId of variantIds) {
          mockAudioEngine.play.mockClear();
          player.onEvents([{ ...event, weaponId }], [0, 0]);
          expect(mockAudioEngine.play.mock.calls, `${weaponId} ${attackKind} special=${usingSpecialAttack}`).toEqual(
            baseCalls,
          );
        }
      }
    }
  });

  it('keeps every sound the core rules can play in the trimmed cache', () => {
    const ids = createPlayer().getAllSoundIds();
    const kept = new Set(ALL_SOUND_IDS);
    const missing = [...ids].filter((id) => !kept.has(id));

    expect(missing).toEqual([]);
  });

  it.each([
    { prayer: PrayerType.EagleEye, soundId: 2665 },
    { prayer: PrayerType.MysticMight, soundId: 2669 },
    { prayer: PrayerType.Deadeye, soundId: 10194 },
    { prayer: PrayerType.MysticVigour, soundId: 10100 },
    { prayer: PrayerType.Zeal, soundId: 12645 },
    { prayer: PrayerType.Redemption, soundId: 2680 },
    { prayer: PrayerType.Preserve, soundId: 2679 },
    { prayer: PrayerType.RapidRestore, soundId: 2679 },
    { prayer: PrayerType.RapidHeal, soundId: 2678 },
  ])('plays sound $soundId when $prayer activates', ({ prayer, soundId }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'prayer_changed',
      eventId: 20,
      tick: 0,
      actorId: 'player',
      from: null,
      to: prayer,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(soundId, { channel: 'sfx', volume: 1 }, 'event:prayer_changed');
  });

  it('plays the shared deactivation sound when an upgraded prayer deactivates', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'prayer_changed',
      eventId: 21,
      tick: 0,
      actorId: 'player',
      from: PrayerType.Deadeye,
      to: null,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(2663, { channel: 'sfx', volume: 1 }, 'event:prayer_changed');
  });

  it('plays both layered sounds for mark of darkness self-cast', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'spell_self_cast',
      eventId: 1,
      tick: 0,
      animationId: 8970,
      spotAnimId: 1852,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(2);
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      1,
      5046,
      { channel: 'sfx', volume: 1 },
      'event:spell_self_cast',
    );
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      2,
      5015,
      { channel: 'sfx', volume: 1 },
      'event:spell_self_cast',
    );
  });

  // Same self-imbue animation as Mark of Darkness; only the spotanim tells the casts apart.
  it.each([
    { label: 'base', spotAnimId: 1854 },
    { label: 'upgraded', spotAnimId: 3288 },
  ])('plays only 5034 for a $label Death Charge self-cast', ({ spotAnimId }) => {
    const player = createPlayer();
    const event: GameEvent = { type: 'spell_self_cast', eventId: 1, tick: 0, animationId: 8970, spotAnimId };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledExactlyOnceWith(
      5034,
      { channel: 'sfx', volume: 1 },
      'event:spell_self_cast',
    );
  });

  it('plays 5047 when a killing blow pays out a Death Charge proc', () => {
    const player = createPlayer();
    const event: GameEvent = { type: 'death_charge_proc', eventId: 1, tick: 0 };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledExactlyOnceWith(
      5047,
      { channel: 'sfx', volume: 1 },
      'event:death_charge_proc',
    );
  });

  it('plays the item pickup sound when the player takes a ground item', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'ground_item_taken',
      eventId: 1,
      tick: 0,
      itemId: 6685,
      quantity: 1,
      position: [32, 37],
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledExactlyOnceWith(
      2582,
      { channel: 'sfx', volume: 1 },
      'event:ground_item_taken',
    );
  });

  it.each([
    { label: 'saturated heart', spotAnimId: 2287, soundId: 6847 },
    { label: 'redemption proc', spotAnimId: 436, soundId: 2681 },
  ])('plays the $label sound for spotanim $spotAnimId', ({ spotAnimId, soundId }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'player_graphic_applied',
      eventId: 2,
      tick: 0,
      spotAnimId,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(
      soundId,
      { channel: 'sfx', volume: 1 },
      'event:player_graphic_applied',
    );
  });

  it('stays silent for a player graphic with no sound of its own', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'player_graphic_applied',
      eventId: 3,
      tick: 0,
      spotAnimId: 1852,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).not.toHaveBeenCalled();
  });

  it.each([2811, 2812, 2813])('plays the Scatter-ashes kill synth 9315 at delay 5 for npc graphic %i', (spotAnimId) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'npc_graphic_applied',
      eventId: 4,
      tick: 0,
      targetId: 'vf-0',
      spotAnimId,
      height: 0,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledExactlyOnceWith(
      9315,
      { channel: 'sfx', volume: 1, delayMs: 100 },
      'event:npc_graphic_applied',
    );
  });

  it('stays silent for an npc graphic with no sound of its own', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'npc_graphic_applied',
      eventId: 5,
      tick: 0,
      targetId: 'boss',
      spotAnimId: 1542,
      height: 92,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).not.toHaveBeenCalled();
  });

  it('plays mark of darkness fade sound on status expiration', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'status_effect_expired',
      eventId: 3,
      tick: 0,
      effect: 'mark_of_darkness',
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(
      5000,
      { channel: 'sfx', volume: 1 },
      'event:status_effect_expired',
    );
  });

  it('plays saturated heart fade sound on status expiration', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'status_effect_expired',
      eventId: 4,
      tick: 0,
      effect: 'saturated_heart',
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(
      228,
      { channel: 'sfx', volume: 1 },
      'event:status_effect_expired',
    );
  });

  it('plays the Death Charge faded sound on status expiration', () => {
    const player = createPlayer();
    const event: GameEvent = { type: 'status_effect_expired', eventId: 5, tick: 0, effect: 'death_charge' };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledExactlyOnceWith(
      5056,
      { channel: 'sfx', volume: 1 },
      'event:status_effect_expired',
    );
  });

  it.each([
    ['Smoke Rush', 183, 185],
    ['Shadow Rush', 178, 179],
    ['Blood Rush', 106, 110],
    ['Ice Rush', 171, 173],
    ['Smoke Burst', 183, 182],
    ['Shadow Burst', 178, 177],
    ['Blood Burst', 106, 105],
    ['Ice Burst', 171, 170],
    ['Smoke Blitz', 183, 181],
    ['Shadow Blitz', 178, 176],
    ['Blood Blitz', 106, 104],
    ['Ice Blitz', 171, 169],
    ['Smoke Barrage', 183, 180],
    ['Shadow Barrage', 178, 175],
    ['Blood Barrage', 106, 102],
    ['Ice Barrage', 171, 168],
  ] as const)('plays the immediate cast and exact-cycle area impact for %s', (spellId, cast, impact) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 90,
      tick: 5,
      sourceId: 'player',
      targetId: 'target',
      style: 'magic',
      attackKind: 'magic_fire',
      spellId,
      weaponId: 27275,
      impactDelayTicks: 3,
      spellCast: { sourcePosition: [3101, 3509], targetPosition: [3101, 3507], targetSize: 1, accurate: true },
    };

    player.onEvents([event], [3101, 3507]);

    expect(mockAudioEngine.play.mock.calls).toEqual([
      [cast, { channel: 'sfx', volume: 1 }, 'event:attack_started'],
      [impact, { channel: 'area', volume: 1, delayMs: 1320 }, 'event:attack_started'],
    ]);
    expect(player.getAllSoundIds()).toEqual(expect.arrayContaining([cast, impact]));
  });

  it.each([
    [1, 56],
    [2, 66],
    [3, 76],
    [6, 106],
  ])('uses %i-tile cast distance for a %i-cycle impact', (distance, cycles) => {
    const player = createPlayer();

    player.onEvents(
      [
        {
          type: 'attack_started',
          eventId: 90,
          tick: 0,
          sourceId: 'player',
          targetId: 'target',
          style: 'magic',
          attackKind: 'magic_shadow',
          spellId: 'Blood Barrage',
          spellCast: { sourcePosition: [0, 0], targetPosition: [distance, 0], targetSize: 1, accurate: true },
        },
      ],
      [distance, 0],
    );

    expect(mockAudioEngine.play).toHaveBeenLastCalledWith(
      102,
      { channel: 'area', volume: 1, delayMs: cycles * 20 },
      'event:attack_started',
    );
  });

  it.each([false, undefined])('plays only the cast when Ancient accuracy is %s', (accurate) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 90,
      tick: 0,
      sourceId: 'player',
      targetId: 'target',
      style: 'magic',
      attackKind: 'magic_shadow',
      spellId: 'Blood Barrage',
      ...(accurate === undefined
        ? {}
        : { spellCast: { sourcePosition: [0, 0], targetPosition: [1, 0], targetSize: 1, accurate } }),
    };

    player.onEvents([event], [0, 0]);

    expect(mockAudioEngine.play.mock.calls).toEqual([[106, { channel: 'sfx', volume: 1 }, 'event:attack_started']]);
  });

  it('attenuates the Ancient impact from its target emission tile with range 10', () => {
    const player = createPlayer();

    player.onEvents(
      [
        {
          type: 'attack_started',
          eventId: 90,
          tick: 0,
          sourceId: 'player',
          targetId: 'target',
          style: 'magic',
          attackKind: 'magic_shadow',
          spellId: 'Blood Barrage',
          spellCast: { sourcePosition: [20, 0], targetPosition: [0, 0], targetSize: 1, accurate: true },
        },
      ],
      [11, 0],
    );

    expect(mockAudioEngine.play.mock.calls).toEqual([[106, { channel: 'sfx', volume: 1 }, 'event:attack_started']]);
  });

  it('plays layered dark demonbane cast sounds from attack_started spellId', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 5,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'magic',
      attackKind: 'magic_shadow',
      spellId: 'Dark Demonbane',
      impactDelayTicks: 2,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(2);
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      1,
      5053,
      { channel: 'sfx', volume: 1 },
      'event:attack_started',
    );
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      2,
      5035,
      { channel: 'sfx', volume: 1, delayMs: 1200 },
      'event:attack_started',
    );
  });

  describe.each([
    { style: 'magic', attackKind: 'magic_fire', soundId: 160 },
    { style: 'magic', attackKind: 'magic_air', soundId: 220 },
    { style: 'magic', attackKind: 'magic_water', soundId: 211 },
    { style: 'magic', attackKind: 'magic_shadow', soundId: 178 },
    { style: 'range', attackKind: 'range_arrow', soundId: 2700 },
    { style: 'melee', attackKind: 'melee_slash', soundId: 2500 },
    { style: 'melee', attackKind: 'melee_stab', soundId: 2517 },
    { style: 'melee', attackKind: 'melee_crush', soundId: 2567 },
  ] as const)('$attackKind ownership', ({ style, attackKind, soundId }) => {
    it('plays the generic attack sound when the player attacks', () => {
      const player = createPlayer();
      const event: GameEvent = {
        type: 'attack_started',
        eventId: 80,
        tick: 0,
        sourceId: 'player',
        targetId: 'zuk',
        style,
        attackKind,
      };

      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).toHaveBeenCalledExactlyOnceWith(
        soundId,
        { channel: 'sfx', volume: 1 },
        'event:attack_started',
      );
    });

    it.each(['mager', 'ranger', 'unknown-npc'])('stays silent when %s attacks', (sourceId) => {
      const player = createPlayer();
      const event: GameEvent = {
        type: 'attack_started',
        eventId: 81,
        tick: 0,
        sourceId,
        targetId: 'player',
        style,
        attackKind,
      };

      player.onEvents([event], [31, 37]);

      expect(mockAudioEngine.play).not.toHaveBeenCalled();
    });
  });

  it.each([
    { what: 'spell', style: 'magic', attackKind: 'magic_shadow', spellId: 'Dark Demonbane', impactDelayTicks: 2 },
    { what: 'weapon', style: 'magic', attackKind: 'magic_shadow', weaponId: 27275 },
    { what: 'special', style: 'melee', attackKind: 'melee_slash', weaponId: 13652, usingSpecialAttack: true },
  ] as const)('ignores player $what metadata when an NPC attacks', ({ what: _what, ...attack }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 82,
      tick: 0,
      sourceId: 'unknown-npc',
      targetId: 'player',
      ...attack,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).not.toHaveBeenCalled();
  });

  it.each([
    {
      what: "Inquisitor's mace uses its own crush sound rather than the generic maul",
      weaponId: 24417,
      expected: 2508,
    },
    { what: 'another crush weapon still uses the generic maul sound', weaponId: 4153, expected: 2567 }, // granite maul
  ])('$what', ({ weaponId, expected }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 51,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'melee',
      attackKind: 'melee_crush',
      weaponId,
      usingSpecialAttack: false,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(expected, { channel: 'sfx', volume: 1 }, 'event:attack_started');
  });

  it.each([
    { what: 'hasta Lunge', weaponId: 11889, attackKind: 'melee_stab', expected: 2562 },
    { what: 'hasta Swipe', weaponId: 11889, attackKind: 'melee_slash', expected: 2524 },
    { what: 'hasta Pound', weaponId: 11889, attackKind: 'melee_crush', expected: 2555 },
    { what: 'cudgel Pound', weaponId: 23528, attackKind: 'melee_crush', expected: 2508 },
    { what: 'cudgel Spike', weaponId: 23528, attackKind: 'melee_stab', expected: 2509 },
    { what: 'bludgeon Pound', weaponId: 13263, attackKind: 'melee_crush', expected: 1309 },
    // capture weapon-soulreaper-fang-dragonwarhammer-zombieaxe-noxhalberd-tridentoftheswamps-tridentoftheseas-packet-data.txt, by tick.
    { what: 'Soulreaper axe Chop', weaponId: 28338, attackKind: 'melee_slash', expected: 1321 }, // 440
    { what: 'Soulreaper axe Smash', weaponId: 28338, attackKind: 'melee_crush', expected: 1316 }, // 454
    { what: "Osmumten's fang Stab", weaponId: 26219, attackKind: 'melee_stab', expected: 2549 }, // 497
    { what: "Osmumten's fang (or) Slash", weaponId: 27246, attackKind: 'melee_slash', expected: 2548 }, // 511
    { what: 'Dragon warhammer Pound', weaponId: 13576, attackKind: 'melee_crush', expected: 2567 }, // 532
    { what: 'Zombie axe Hack', weaponId: 28810, attackKind: 'melee_slash', expected: 2498 }, // 566
    { what: 'Zombie axe Smash', weaponId: 28810, attackKind: 'melee_crush', expected: 2497 }, // 572
    { what: 'Noxious halberd Jab', weaponId: 29796, attackKind: 'melee_stab', expected: 2562 }, // 596
    { what: 'Noxious halberd Swipe', weaponId: 29796, attackKind: 'melee_slash', expected: 2524 }, // 602
  ] as const)('plays the captured swing sound for $what', ({ weaponId, attackKind, expected }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 60,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'melee',
      attackKind,
      weaponId,
      usingSpecialAttack: false,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(expected, { channel: 'sfx', volume: 1 }, 'event:attack_started');
  });

  it('plays the captured abyssal bludgeon special attack sounds', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 61,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'melee',
      attackKind: 'melee_crush',
      weaponId: 13263,
      usingSpecialAttack: true,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(2);
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      1,
      2715,
      { channel: 'sfx', delayMs: 200, volume: 1 },
      'event:attack_started',
    );
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      2,
      1930,
      { channel: 'sfx', delayMs: 600, volume: 1 },
      'event:attack_started',
    );
  });

  it.each([
    { attackKind: 'melee_slash' as const, label: 'Chop/Slash/Block' },
    { attackKind: 'melee_stab' as const, label: 'Lunge' },
  ])('plays the shared claws swing sound for a burning claws $label auto', ({ attackKind }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 70,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'melee',
      attackKind,
      weaponId: 29577,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(1);
    expect(mockAudioEngine.play).toHaveBeenCalledWith(4139, { channel: 'sfx', volume: 1 }, 'event:attack_started');
  });

  it('plays the captured burning claws special attack sound twice, neither on the swing tick', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 71,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'melee',
      attackKind: 'melee_slash',
      weaponId: 29577,
      usingSpecialAttack: true,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(2);
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      1,
      9316,
      { channel: 'sfx', delayMs: 580, volume: 1 },
      'event:attack_started',
    );
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      2,
      9316,
      { channel: 'sfx', delayMs: 1200, volume: 1 },
      'event:attack_started',
    );
  });

  it('plays the packet-captured Eclipse atlatl launch sound', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 50,
      tick: 0,
      sourceId: 'player',
      targetId: 'zuk',
      style: 'range',
      attackKind: 'range_arrow',
      weaponId: 29000,
      usingSpecialAttack: false,
    };

    player.onEvents([event], [31, 46]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(2699, { channel: 'sfx', volume: 1 }, 'event:attack_started');
  });

  it('plays accursed sceptre cast sound', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 51,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'magic',
      attackKind: 'magic_shadow',
      weaponId: 27665,
      usingSpecialAttack: false,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(178, { channel: 'sfx', volume: 1 }, 'event:attack_started');
  });

  it('plays accursed sceptre special attack layered sounds', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 52,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'magic',
      attackKind: 'magic_shadow',
      weaponId: 27665,
      usingSpecialAttack: true,
      impactDelayTicks: 2,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(2);
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(1, 183, { channel: 'sfx', volume: 1 }, 'event:attack_started');
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      2,
      163,
      { channel: 'sfx', volume: 1, delayMs: 1200 },
      'event:attack_started',
    );
  });

  it('plays eye of ayak special attack sequence with delayed layers', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 54,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'magic',
      attackKind: 'magic_shadow',
      weaponId: 31113,
      usingSpecialAttack: true,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(10);
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      1,
      10313,
      { channel: 'sfx', volume: 1, delayMs: 420 },
      'event:attack_started',
    );
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      2,
      10322,
      { channel: 'sfx', volume: 1, delayMs: 1620 },
      'event:attack_started',
    );
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      3,
      10319,
      { channel: 'sfx', volume: 1, delayMs: 2160 },
      'event:attack_started',
    );
    expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
      4,
      10311,
      { channel: 'sfx', volume: 1, delayMs: 2440 },
      'event:attack_started',
    );
  });

  it("plays Tumeken's Shadow cast sound", () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 56,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'magic',
      attackKind: 'magic_shadow',
      weaponId: 27275,
      usingSpecialAttack: false,
      impactDelayTicks: 2,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(1);
    expect(mockAudioEngine.play).toHaveBeenCalledWith(6410, { channel: 'sfx', volume: 1 }, 'event:attack_started');
  });

  it.each([
    // capture tob-hmt-5-packet-data-*.txt: `endtime = 46 + 5 * distance`, 1460 at the target.
    {
      what: 'lands',
      accurate: true,
      expected: [
        [178, undefined],
        [1460, 86 * 20],
      ],
    },
    { what: 'splashes', accurate: false, expected: [[178, undefined]] },
  ])('plays Eye of Ayak impact at the target, on the projectile, when the cast $what', ({ accurate, expected }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 58,
      tick: 0,
      sourceId: 'player',
      targetId: 'maiden',
      style: 'magic',
      attackKind: 'magic_shadow',
      weaponId: 31113,
      usingSpecialAttack: false,
      impactDelayTicks: 4,
      spellCast: { sourcePosition: [10, 18], targetPosition: [10, 10], targetSize: 1, accurate },
    };

    player.onEvents([event], [10, 18]);

    expect(mockAudioEngine.play.mock.calls.map(([id, options]) => [id, options.delayMs])).toEqual(expected);
  });

  it.each([
    // The weapon sweep capture, by tick.
    { what: 'Armadyl godsword', weaponId: 11802, attackKind: 'melee_slash', expected: [[3869, undefined]] }, // 892
    { what: 'Zamorak godsword', weaponId: 11808, attackKind: 'melee_crush', expected: [[3869, undefined]] }, // 987
    { what: 'Abyssal tentacle', weaponId: 26484, attackKind: 'melee_slash', expected: [[2713, undefined]] }, // 678
    {
      what: 'Emberlight',
      weaponId: 29589,
      attackKind: 'melee_slash',
      expected: [
        [9319, 11 * 20],
        [9320, 28 * 20],
        [9321, 53 * 20],
      ],
    }, // 497
    { what: 'Armadyl crossbow', weaponId: 11785, attackKind: 'range_arrow', expected: [[3892, 15 * 20]] }, // 1024
    // The soulreaper/fang/warhammer capture, by tick: Behead (473), Smash (551), and Eviscerate (522),
    // which sends no sound at all rather than the fang's swing.
    { what: 'Soulreaper axe', weaponId: 28338, attackKind: 'melee_slash', expected: [[7019, undefined]] },
    { what: 'Dragon warhammer', weaponId: 13576, attackKind: 'melee_crush', expected: [[2520, undefined]] },
    { what: "Osmumten's fang", weaponId: 26219, attackKind: 'melee_stab', expected: [] },
  ] as const)('plays the $what special attack stack', ({ weaponId, attackKind, expected }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 60,
      tick: 0,
      sourceId: 'player',
      targetId: 'warbander',
      style: attackKind === 'range_arrow' ? 'range' : 'melee',
      attackKind,
      weaponId,
      usingSpecialAttack: true,
    };

    player.onEvents([event], [10, 11]);

    expect(mockAudioEngine.play.mock.calls.map(([id, options]) => [id, options.delayMs])).toEqual(expected);
  });

  it.each([
    {
      what: 'lands',
      accurate: true,
      weaponId: 12899,
      expected: [
        [178, undefined],
        [1460, 56 * 20],
      ],
    },
    {
      what: 'lands',
      accurate: true,
      weaponId: 11905,
      expected: [
        [178, undefined],
        [1460, 56 * 20],
      ],
    },
    { what: 'splashes', accurate: false, weaponId: 11907, expected: [[178, undefined]] },
  ] as const)('plays trident $weaponId cast, and 1460 at the target when it $what', ({
    accurate,
    weaponId,
    expected,
  }) => {
    // capture weapon-soulreaper-fang-dragonwarhammer-zombieaxe-noxhalberd-tridentoftheswamps-tridentoftheseas-packet-data.txt
    // ticks 624-651: synth 178, then `sound_area 1460, delay=56, range=10` at the dummy one tile away.
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 63,
      tick: 0,
      sourceId: 'player',
      targetId: 'dummy',
      style: 'magic',
      attackKind: 'magic_fire',
      weaponId,
      usingSpecialAttack: false,
      impactDelayTicks: 2,
      spellCast: { sourcePosition: [10, 11], targetPosition: [10, 10], targetSize: 1, accurate },
    };

    player.onEvents([event], [10, 11]);

    expect(mockAudioEngine.play.mock.calls.map(([id, options]) => [id, options.delayMs])).toEqual(expected);
  });

  it.each([
    { what: 'the powered sceptre', weaponId: 27665 },
    { what: 'the (a) sceptre', weaponId: 27679 },
  ])('plays Condemn from $what with 163 on its arrival, landed or not', ({ weaponId }) => {
    const player = createPlayer();
    // Weapon sweep capture tick 545: one tile to the target, endtime=56, and it splashed.
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 61,
      tick: 0,
      sourceId: 'player',
      targetId: 'shaman',
      style: 'magic',
      attackKind: 'magic_shadow',
      weaponId,
      usingSpecialAttack: true,
      spellCast: { sourcePosition: [10, 11], targetPosition: [10, 10], targetSize: 1, accurate: false },
    };

    player.onEvents([event], [10, 11]);

    expect(mockAudioEngine.play.mock.calls.map(([id, options]) => [id, options.delayMs])).toEqual([
      [183, undefined],
      [163, 56 * 20],
    ]);
  });

  it('adds the surge potion sound to the ordinary drink', () => {
    const player = createPlayer();
    player.onEvents([{ type: 'item_consumed', eventId: 62, tick: 0, track: 'potion', itemId: 30875 }], [10, 10]);
    expect(mockAudioEngine.play.mock.calls.map(([id]) => id)).toEqual([6182, 2401]);
  });

  it.each([
    { what: 'without a launch snapshot, the launch alone', spellCast: undefined, impact: [] },
    // yama-contract-of-sensory-clouding-packet-data-1(incomplete).txt tick 1564: footprint distance 1, endtime 54.
    {
      what: 'with one, 9325 and 9326 on the arrival too',
      spellCast: { sourcePosition: [1505, 10088], targetPosition: [1503, 10083], targetSize: 5, accurate: false },
      impact: [
        [9325, 54 * 20],
        [9326, 54 * 20],
      ],
    },
  ] as const)('plays the Scorching bow special $what', ({ spellCast, impact }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 59,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'range',
      attackKind: 'range_arrow',
      weaponId: 29591,
      usingSpecialAttack: true,
      impactDelayTicks: 3,
      ...(spellCast ? { spellCast } : {}),
    };

    player.onEvents([event], [10, 18]);

    // capture yama-contract-of-sensory-clouding-packet-data-1(incomplete).txt:17214-17216.
    expect(mockAudioEngine.play.mock.calls.map(([id, options]) => [id, options.delayMs])).toEqual([
      [2700, undefined],
      [9327, 11 * 20],
      [9328, 46 * 20],
      ...impact,
    ]);
  });

  it.each([
    // capture colosseum-no-sol-packet-data.txt:367-371: 8 tiles to a size-1 target, endtime=152.
    {
      what: 'lands',
      accurate: true,
      expected: [
        [6410, undefined],
        [1460, 152 * 20],
      ],
    },
    // A splash plays 227 on `hit_applied` instead of the impact sound.
    { what: 'splashes', accurate: false, expected: [[6410, undefined]] },
  ])("plays Tumeken's shadow impact at the target when the cast $what", ({ accurate, expected }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 57,
      tick: 0,
      sourceId: 'player',
      targetId: 'warbander',
      style: 'magic',
      attackKind: 'magic_shadow',
      weaponId: 27275,
      usingSpecialAttack: false,
      spellCast: { sourcePosition: [1822, 3115], targetPosition: [1821, 3107], targetSize: 1, accurate },
    };

    player.onEvents([event], [1822, 3115]);

    expect(mockAudioEngine.play.mock.calls.map(([id, options]) => [id, options.delayMs])).toEqual(expected);
  });

  // capture weapon-soulreaper-fang-dragonwarhammer-zombieaxe-noxhalberd-tridentoftheswamps-tridentoftheseas-packet-data.txt,
  // the wield on each weapon's first tick: kind is what the engine's slot/category rule sends.
  it.each([
    { what: 'Soulreaper axe', itemId: 28338, equipSound: 'fun', expected: 2232 }, // 434
    { what: 'Soulreaper axe (o)', itemId: 33335, equipSound: 'fun', expected: 2232 },
    { what: "Osmumten's fang", itemId: 26219, equipSound: 'fun', expected: 2238 }, // 480
    { what: 'Dragon warhammer', itemId: 13576, equipSound: 'fun', expected: 2233 }, // 527
    { what: 'Zombie axe', itemId: 28810, equipSound: 'fun', expected: 2232 }, // 556
    { what: 'Noxious halberd', itemId: 29796, equipSound: 'fun', expected: 2247 }, // 582
    { what: 'Trident of the swamp', itemId: 12899, equipSound: 'staff', expected: 2247 }, // 621
    { what: 'Trident of the seas', itemId: 11907, equipSound: 'staff', expected: 2247 }, // 637
  ] as const)('plays the captured wield sound for the $what', ({ itemId, equipSound, expected }) => {
    const player = createPlayer();
    player.onEvents([{ type: 'item_equipped', eventId: 7, tick: 0, slot: 'weapon', itemId, equipSound }], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledExactlyOnceWith(
      expected,
      { channel: 'sfx', volume: 1 },
      'event:item_equipped',
    );
  });

  it('plays equip sound by equipSound kind', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'item_equipped',
      eventId: 6,
      tick: 0,
      slot: 'head',
      itemId: 0,
      equipSound: 'helmet',
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(2240, { channel: 'sfx', volume: 1 }, 'event:item_equipped');
  });

  it('falls back to equip fun sound for unknown equipSound kind', () => {
    const player = createPlayer();
    const event = {
      type: 'item_equipped',
      eventId: 7,
      tick: 0,
      slot: 'ring',
      itemId: 0,
      equipSound: 'unknown_kind',
    } as unknown as GameEvent;

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(2238, { channel: 'sfx', volume: 1 }, 'event:item_equipped');
  });

  it('does not play for unrelated spell_self_cast animations', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'spell_self_cast',
      eventId: 8,
      tick: 0,
      animationId: 714,
      spotAnimId: 111,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).not.toHaveBeenCalled();
  });

  it.each([
    // Body type A's four-sound set; body type B would be the two-sound 509/510.
    { what: 'damage taken', hitsplatType: 'damage', family: [518, 519, 520, 521], varied: true },
    // `human_block_1`: rsmod's fallback when no worn item carries `item_block_sound1..5`,
    // which no cache we ship does.
    { what: 'a blocked hit', hitsplatType: 'block', family: [511], varied: false },
  ])('plays one delayed $what sound for the player', ({ hitsplatType, family, varied }) => {
    const player = createPlayer();
    const event = {
      type: 'hitsplat_spawned',
      eventId: 9,
      tick: 0,
      targetId: 'player',
      amount: hitsplatType === 'block' ? 0 : 7,
      hitsplatType,
    } as unknown as GameEvent;

    // pickVariant indexes with floor(random * family.length), so these draws walk the set in
    // turn. Live randomness leaves a real chance of one variant never surfacing across 40 draws,
    // which is the assertion below failing on a healthy build.
    const randomSpy = vi.spyOn(Math, 'random');
    for (let i = 0; i < 40; i++) {
      randomSpy.mockReturnValueOnce((i % family.length) / family.length);
      player.onEvents([event], [31, 37]);
    }

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(40);
    const played = mockAudioEngine.play.mock.calls.map(([id]) => id as number);
    expect(played.every((id) => family.includes(id))).toBe(true);
    expect(new Set(played).size).toBe(varied ? family.length : 1);
    for (const [, options] of mockAudioEngine.play.mock.calls) {
      expect(options).toEqual({ channel: 'sfx', volume: 1, delayMs: 400 });
    }
  });

  it.each([
    // The capture's hitsplat table: only DAMAGE_ME and BLOCK_ME on the player make a sound.
    { what: 'poison', hitsplatType: 'poison', targetId: 'player' },
    { what: 'venom', hitsplatType: 'venom', targetId: 'player' },
    { what: 'disease', hitsplatType: 'disease', targetId: 'player' },
    { what: 'doom', hitsplatType: 'doom', targetId: 'player' },
    { what: 'a damage splat on an NPC', hitsplatType: 'damage', targetId: 'yama' },
  ])('stays silent for $what', ({ hitsplatType, targetId }) => {
    const player = createPlayer();
    const event = {
      type: 'hitsplat_spawned',
      eventId: 20,
      tick: 0,
      targetId,
      amount: 7,
      hitsplatType,
    } as unknown as GameEvent;

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).not.toHaveBeenCalled();
  });

  it('plays no hitsplat sound for a hit on an NPC', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'hit_applied',
      eventId: 10,
      tick: 0,
      targetId: 'yama',
      damage: 31,
      blocked: false,
      attackKind: 'melee_slash',
      prayedCorrectly: null,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).not.toHaveBeenCalled();
  });

  it.each([
    { what: 'plays the human death sound when the player dies', actorId: 'player', calls: 1 },
    { what: 'stays silent when an NPC dies', actorId: 'yama', calls: 0 },
  ])('$what', ({ actorId, calls }) => {
    const player = createPlayer();
    const event: GameEvent = { type: 'actor_died', eventId: 11, tick: 0, actorId };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(calls);
  });

  it('plays the capture-backed bow launch sound', () => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 12,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'range',
      attackKind: 'range_arrow',
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledWith(2700, { channel: 'sfx', volume: 1 }, 'event:attack_started');
  });

  it.each([12926, 28688])('plays the captured two-part blowpipe special for item %i', (weaponId) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 1,
      tick: 116,
      sourceId: 'player',
      targetId: 'man',
      style: 'range',
      attackKind: 'range_arrow',
      weaponId,
      usingSpecialAttack: true,
    };

    player.onEvents([event], [3098, 3509]);

    expect(mockAudioEngine.play.mock.calls).toEqual([
      [2696, { channel: 'sfx', volume: 1 }, 'event:attack_started'],
      [800, { channel: 'sfx', volume: 1, delayMs: 640 }, 'event:attack_started'],
    ]);
    expect(player.getAllSoundIds()).toContain(800);
  });

  it.each([
    25865, 25867, 25888, 23983, 24123,
  ])('uses the captured Bowfa sound instead of the generic bow for item %i', (weaponId) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'attack_started',
      eventId: 2,
      tick: 123,
      sourceId: 'player',
      targetId: 'man',
      style: 'range',
      attackKind: 'range_arrow',
      weaponId,
      usingSpecialAttack: false,
    };

    player.onEvents([event], [3098, 3509]);

    expect(mockAudioEngine.play.mock.calls).toEqual([[1352, { channel: 'sfx', volume: 1 }, 'event:attack_started']]);
    expect(player.getAllSoundIds()).toContain(1352);
  });

  it.each([
    { what: 'scythe of vitur', weaponId: 22325, attackKind: 'melee_slash', expected: [2524] },
    { what: 'ghrazi rapier', weaponId: 22324, attackKind: 'melee_stab', expected: [2549] },
    // The weapon sweep capture's tick numbers: capture weapon-attacks-sgs-…-dragon-pickaxe-packet-data.txt
    { what: 'ghrazi rapier slash', weaponId: 22324, attackKind: 'melee_slash', expected: [2548] }, // 565
    { what: 'godsword smash', weaponId: 11802, attackKind: 'melee_crush', expected: [3846] }, // 876
    { what: 'elder maul', weaponId: 21003, attackKind: 'melee_crush', expected: [3454] }, // 383
    { what: 'abyssal tentacle', weaponId: 26484, attackKind: 'melee_slash', expected: [2720] }, // 662
    { what: 'scythe jab', weaponId: 25736, attackKind: 'melee_crush', expected: [2522] }, // 635
    { what: 'dragon scimitar lunge', weaponId: 4587, attackKind: 'melee_stab', expected: [2501] }, // 842
    { what: 'dragon claws lunge', weaponId: 13652, attackKind: 'melee_stab', expected: [4139] }, // 601
    { what: 'zamorakian spear slash', weaponId: 11824, attackKind: 'melee_slash', expected: [2556] }, // 730
    { what: 'dragon hunter lance crush', weaponId: 22978, attackKind: 'melee_crush', expected: [2555] }, // 711
    { what: 'dragon pickaxe smash', weaponId: 11920, attackKind: 'melee_crush', expected: [2497] }, // 1084
    { what: 'saradomin godsword', weaponId: 11806, attackKind: 'melee_slash', expected: [3847] },
    { what: 'toxic blowpipe', weaponId: 12926, attackKind: 'range_arrow', expected: [2696] },
    { what: 'rune crossbow', weaponId: 9185, attackKind: 'range_arrow', expected: [2695] },
    { what: 'zaryte crossbow', weaponId: 26374, attackKind: 'range_arrow', expected: [2695] },
    { what: 'dragon claws slash', weaponId: 13652, attackKind: 'melee_slash', expected: [4139] },
    { what: 'scorching bow', weaponId: 29591, attackKind: 'range_arrow', expected: [2700] },
  ])('plays the $what weapon sound rather than the generic style sound', ({ weaponId, attackKind, expected }) => {
    const player = createPlayer();
    const event = {
      type: 'attack_started',
      eventId: 13,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'melee',
      attackKind,
      weaponId,
      usingSpecialAttack: false,
    } as unknown as GameEvent;

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play.mock.calls.map(([id]) => id)).toEqual(expected);
  });

  it.each([
    { what: 'holy ghrazi rapier', weaponId: 25734, attackKind: 'melee_stab', expected: [2549] },
    { what: 'holy scythe of vitur', weaponId: 25739, attackKind: 'melee_slash', expected: [2524] },
    { what: 'blessed scythe of vitur', weaponId: 25741, attackKind: 'melee_slash', expected: [2524] },
    { what: 'trailblazer toxic blowpipe', weaponId: 28688, attackKind: 'range_arrow', expected: [2696] },
    { what: 'ornate armadyl godsword', weaponId: 29605, attackKind: 'melee_slash', expected: [3847] },
  ])('resolves the $what variant id to its base weapon sound', ({ weaponId, attackKind, expected }) => {
    const player = createPlayer();
    const event = {
      type: 'attack_started',
      eventId: 16,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'melee',
      attackKind,
      weaponId,
      usingSpecialAttack: false,
    } as unknown as GameEvent;

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play.mock.calls.map(([id]) => id)).toEqual(expected);
  });

  it.each([
    { what: 'trailblazer dragon claws', weaponId: 28039, expected: [4138, 4140, 4141, 4141] },
    { what: 'ornate voidwaker', weaponId: 29607, expected: [5027, 6182] },
    { what: 'ornate elder maul', weaponId: 27100, expected: [8984] },
  ])('resolves the $what variant id to its base spec sound stack', ({ weaponId, expected }) => {
    const player = createPlayer();
    const event = {
      type: 'attack_started',
      eventId: 17,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'melee',
      attackKind: 'melee_slash',
      weaponId,
      usingSpecialAttack: true,
    } as unknown as GameEvent;

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play.mock.calls.map(([id]) => id)).toEqual(expected);
  });

  it.each([
    // BGS has no spec-specific stack in the table; the godsword swing is what it plays here.
    { what: 'bandos godsword', weaponId: 11804, expected: [3847] },
    { what: 'an unmapped weapon', weaponId: 1, expected: [2500] },
  ])('falls a $what special attack through to the normal swing sound', ({ weaponId, expected }) => {
    const player = createPlayer();
    const event = {
      type: 'attack_started',
      eventId: 18,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'melee',
      attackKind: 'melee_slash',
      weaponId,
      usingSpecialAttack: true,
    } as unknown as GameEvent;

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play.mock.calls.map(([id]) => id)).toEqual(expected);
  });

  it.each([
    {
      what: 'dragon claws',
      weaponId: 13652,
      expected: [
        [4138, 200],
        [4140, 600],
        [4141, 840],
        [4141, 1200],
      ],
    },
    { what: 'saradomin godsword', weaponId: 11806, expected: [[3869, undefined]] },
    {
      what: 'voidwaker',
      weaponId: 27690,
      expected: [
        [5027, undefined],
        [6182, 600],
      ],
    },
    { what: 'elder maul', weaponId: 21003, expected: [[8984, 40]] },
  ])('plays the $what special attack sound stack', ({ weaponId, expected }) => {
    const player = createPlayer();
    const event = {
      type: 'attack_started',
      eventId: 14,
      tick: 0,
      sourceId: 'player',
      targetId: 'yama',
      style: 'melee',
      attackKind: 'melee_slash',
      weaponId,
      usingSpecialAttack: true,
    } as unknown as GameEvent;

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play).toHaveBeenCalledTimes(expected.length);
    expected.forEach(([id, delayMs], index) => {
      expect(mockAudioEngine.play).toHaveBeenNthCalledWith(
        index + 1,
        id,
        delayMs === undefined ? { channel: 'sfx', volume: 1 } : { channel: 'sfx', volume: 1, delayMs },
        'event:attack_started',
      );
    });
  });

  it.each([
    { what: 'plays the splash sound when a spell misses an NPC', accurate: false, expected: [227] },
    { what: 'stays silent when a spell hits an NPC for zero', accurate: true, expected: [] },
  ])('$what', ({ accurate, expected }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'hit_applied',
      eventId: 15,
      tick: 0,
      targetId: 'yama',
      damage: 0,
      blocked: true,
      attackKind: 'magic_shadow',
      prayedCorrectly: null,
      accurate,
    };

    player.onEvents([event], [31, 37]);

    expect(mockAudioEngine.play.mock.calls.map(([id]) => id)).toEqual(expected);
  });

  it.each([
    // Splash is `sound_area ... range=10` at the TARGET's tile in every capture, so it attenuates
    // from the thing you splashed on, not from you. 4 tiles away is distance 3 after the
    // forgiven tile.
    { what: 'at full volume on top of the target', target: [31, 37] as const, volume: 1 },
    { what: 'attenuated a few tiles out', target: [31, 41] as const, volume: (10 - 3) / 10 },
    { what: 'silent past its 10-tile range', target: [31, 48] as const, volume: 0 },
  ])('plays the splash $what', ({ target, volume }) => {
    const player = createPlayer();
    const event: GameEvent = {
      type: 'hit_applied',
      eventId: 19,
      tick: 0,
      targetId: 'yama',
      targetPosition: [...target],
      damage: 0,
      blocked: true,
      attackKind: 'magic_shadow',
      prayedCorrectly: null,
      accurate: false,
    };

    player.onEvents([event], [31, 37]);

    if (volume === 0) {
      expect(mockAudioEngine.play).not.toHaveBeenCalled();
      return;
    }
    expect(mockAudioEngine.play).toHaveBeenCalledTimes(1);
    const [id, options] = mockAudioEngine.play.mock.calls[0];
    expect(id).toBe(227);
    expect(options.channel).toBe('area');
    expect(options.volume).toBeCloseTo(volume, 10);
  });
});
