import { afterEach, describe, expect, it, vi } from 'vitest';
import { layBurnStack } from '../../core/combat/burnStacks';
import { setArenaConfig, setDefaultArenaConfig } from '../../core/constants';
import { isEncounterVisualEvent } from '../../core/events/encounterVisual';
import { TickEvents } from '../../core/events/TickEvents';
import type { GameEvent } from '../../core/events/types';
import { SimulationEngine } from '../../core/SimulationEngine';
import { emitZukAttack, type ZukAttackKind } from '../../npcs/inferno/events';
import { EncounterCuePlayer } from '../../render/effects/EncounterCuePlayer';
import { SpotAnimRenderer } from '../../render/effects/SpotAnimRenderer';
import { enqueueEnginePendingHit } from '../../test/helpers/pendingHits';
import { createZukWaveEncounter } from '../../test/helpers/zukWave';
import { AudioEngine } from '../AudioEngine';
import { coreAudioRules } from '../coreAudioRules';
import { EventAudioPlayer } from '../EventAudioPlayer';
import { ALL_SOUND_IDS } from '../soundNames';
import { zukAudioRules } from '../zukAudioRules';

afterEach(() => {
  vi.restoreAllMocks();
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

function fixture() {
  const engine = new AudioEngine();
  const played = vi.spyOn(engine, 'play').mockImplementation(() => undefined);
  const player = new EventAudioPlayer(engine, zukAudioRules);
  return { player, played };
}

function attackEvent(attack: ZukAttackKind, overrides: Partial<GameEvent> = {}): GameEvent {
  const tickEvents = new TickEvents();
  tickEvents.setTick(100);
  emitZukAttack(
    { tickEvents },
    {
      attack,
      sourceId: 'source',
      targetId: 'player',
      sourcePosition: [31, 55],
      targetPosition: [31, 48],
      launchTick: 100,
      impactTick: 103,
      projectileArrivalCycles: 106,
    },
  );
  return { ...tickEvents.flush()[0], ...overrides };
}

describe('evidence-backed Inferno event audio', () => {
  it.each(['mager_melee', 'ranger_melee'] as const)('does not reuse distance-attack audio for %s', (attack) => {
    const { player, played } = fixture();
    player.onEvents([attackEvent(attack, { impactTick: 100, projectileArrivalCycles: undefined })], [31, 48]);
    expect(played).not.toHaveBeenCalled();
  });

  it.each([
    ['ranger_range', 598, 1000],
    ['mager_magic', 598, undefined],
    ['jad_range', 163, undefined],
    ['jad_healer_melee', 608, undefined],
    ['jad_melee', 408, undefined],
  ] as const)('plays one %s action sound with its printed delay', (attack, id, delayMs) => {
    const { player, played } = fixture();

    player.onEvents([attackEvent(attack)], [31, 48]);

    expect(played).toHaveBeenCalledExactlyOnceWith(
      id,
      {
        volume: 1,
        channel: 'sfx',
        ...(delayMs === undefined ? {} : { delayMs }),
      },
      'event:zuk_attack',
    );
  });

  it('keeps magic cue, release and first-projectile impact separate from the two followers', () => {
    const { player, played } = fixture();

    player.onEvents(
      [
        { type: 'zuk_jad_cue', eventId: 1, tick: 827, sourceId: 'jad', style: 'magic' },
        attackEvent('jad_magic', { projectileArrivalCycles: 58 }),
      ],
      [31, 48],
    );

    expect(played.mock.calls.map(([id, options]) => [id, options?.delayMs])).toEqual([
      [159, undefined],
      [162, undefined],
      [163, 1160],
    ]);
  });

  it('uses the mager source tile for glyph-targeted area casts with simulator attenuation', () => {
    const { player, played } = fixture();

    player.onEvents([attackEvent('mager_magic', { targetId: 'glyph' })], [31, 55]);

    expect(played).toHaveBeenCalledExactlyOnceWith(598, { volume: 1, channel: 'area' }, 'event:zuk_attack');
  });

  it.each(['glyph', 'player'])('separates Zuk cast ownership from impact when targeting %s', (targetId) => {
    const { player, played } = fixture();

    player.onEvents([attackEvent('zuk_blast', { targetId })], [31, 48]);

    expect(played).toHaveBeenCalledTimes(2);
    expect(played.mock.calls[0]).toEqual([
      155,
      expect.objectContaining({ channel: targetId === 'player' ? 'sfx' : 'area' }),
      'event:zuk_attack',
    ]);
    expect(played.mock.calls[1]).toEqual([156, { volume: 1, channel: 'area', delayMs: 2120 }, 'event:zuk_attack']);
  });

  it('preserves each caster and each explicitly supplied duplicate spark landing', () => {
    const { player, played } = fixture();
    const events: GameEvent[] = ['first', 'second'].map((sourceId, index) => ({
      type: 'zuk_healer_cast',
      eventId: index,
      tick: 1069,
      sourceId,
      sourcePosition: [31, 48],
    }));
    events.push({
      type: 'encounter_visual',
      eventId: 3,
      tick: 1072,
      animations: [],
      projectiles: [],
      graphics: [1, 1, 4].map((delayCycles) => ({
        spotAnimId: 659,
        delayCycles,
        height: 0,
        target: { kind: 'tile', position: [31, 48] },
      })),
    });

    player.onEvents(events, [31, 48]);

    expect(played.mock.calls.map(([id, options]) => [id, options?.delayMs])).toEqual([
      [155, 1020],
      [155, 1020],
      [156, 20],
      [156, 20],
      [156, 80],
    ]);
  });

  it('does not infer hit owners from generic splats or invent unknown death sounds or spark fields', () => {
    const { player, played } = fixture();

    player.onEvents(
      [
        ...['zuk', 'shield', 'jad_healer'].map((npcKind, eventId) => ({
          type: 'zuk_death',
          eventId,
          tick: 100,
          actorId: 'arbitrary',
          npcKind,
          position: [31, 48],
        })),
        { type: 'hitsplat_spawned', eventId: 3, tick: 100, targetId: 'mager', amount: 0 },
        {
          type: 'encounter_visual',
          eventId: 4,
          tick: 100,
          animations: [],
          projectiles: [],
          graphics: [{ spotAnimId: 659, target: { kind: 'tile', position: [31, 48] } }],
        },
      ],
      [31, 48],
    );

    expect(played).not.toHaveBeenCalled();
  });

  it('preloads every enabled sound, each kept in the trimmed cache', () => {
    const { player } = fixture();

    const ids = player.getAllSoundIds().sort((left, right) => left - right);

    expect(ids).toEqual([
      155, 156, 159, 162, 163, 291, 295, 296, 408, 409, 410, 595, 596, 597, 598, 599, 600, 608, 609, 610, 899, 900,
      1021, 1095, 1641, 1644, 3403, 3528,
    ]);
    for (const id of ids) expect(ALL_SOUND_IDS).toContain(id);
  });

  it('preserves one sound per supported death owner on a shared tick', () => {
    const { player, played } = fixture();
    const events = ['mager', 'ranger', 'jad', 'healer'].map((npcKind, eventId) => ({
      type: 'zuk_death',
      eventId,
      tick: 100,
      actorId: npcKind,
      npcKind,
      position: [31, 48],
    }));

    player.onEvents(events, [31, 48]);

    expect(played.mock.calls.map(([id]) => id)).toEqual([599, 599, 409, 899]);
  });

  it('plays only release audio when exact projectile arrival cycles are unavailable', () => {
    const { player, played } = fixture();
    const event = attackEvent('jad_magic', { projectileArrivalCycles: undefined });

    player.onEvents([event], [31, 48]);

    expect(played).toHaveBeenCalledExactlyOnceWith(162, { volume: 1, channel: 'sfx' }, 'event:zuk_attack');
  });
});

describe('live Inferno damage callbacks to audio and defend cues', () => {
  it.each([
    [7706, 'zuk', 410, true, undefined],
    [7704, 'jad', 410, true, 409],
    [7703, 'mager', 600, false, 599],
    [7702, 'ranger', 600, true, 599],
    [7705, 'jad_healer', 610, true, undefined],
    [7708, 'healer', 900, true, 899],
  ] as const)('presents zero, positive, burn and lethal hits once each for NPC %i', (npcTypeId, npcKind, hurt, defend, death) => {
    const simulation = new SimulationEngine({ encounter: createZukWaveEncounter(7) });
    simulation.setMechanicsConfig({ zukAttacks: false, zukSets: false, infiniteHealth: true });
    for (const type of ['spawn-set', 'spawn-jad-healers', 'spawn-healers'] as const)
      simulation.executeEncounterCommand({ encounter: 'zuk', type });
    const world = simulation['worldState'];
    const actor = world.getNpcs().find((npc) => npc.npcTypeId === npcTypeId);
    if (!actor) throw new TypeError(`Missing NPC ${npcTypeId}`);
    for (const other of world.getNpcs()) if (other !== actor) world.actors.delete(other.id);
    world.actors.delete(actor.id);
    actor.id = 'arbitrary-owner';
    world.actors.set(actor.id, actor);
    actor.vitals.hp = 20;
    const audio = new AudioEngine();
    const played = vi.spyOn(audio, 'play').mockImplementation(() => undefined);
    const player = new EventAudioPlayer(audio, zukAudioRules, coreAudioRules);
    for (const rolledDamage of [0, 3])
      enqueueEnginePendingHit(simulation, {
        sourceId: 'player',
        targetId: actor.id,
        style: 'range',
        attackKind: 'range_arrow',
        launchTick: 0,
        impactTick: 1,
        rolledDamage,
        accuracySucceeded: rolledDamage > 0,
      });
    layBurnStack({
      target: actor,
      sourceId: 'player',
      origin: 'eclipse',
      severity: 'incendiary',
      pulses: 1,
      tick: 0,
      firstPulseDelayTicks: 1,
    });

    simulation.advanceTick(simulation.getState().playerPosition);
    const events = simulation.getLastTickEvents();
    player.onEvents(events, [0, 0]);
    const visuals = new EncounterCuePlayer(new SpotAnimRenderer());
    visuals.consumeEvents(events, simulation.getState());

    expect(actor.vitals.hp).toBe(16);
    expect(events.filter((event) => event.type === 'zuk_hit')).toMatchObject(
      Array.from({ length: 3 }, () => ({ actorId: actor.id, npcKind, position: actor.position, tick: 1 })),
    );
    expect(
      events
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations)
        .filter((cue) => cue.clipId === 'defend'),
    ).toEqual(defend ? Array.from({ length: 3 }, () => ({ actorId: actor.id, clipId: 'defend', delayCycles: 0 })) : []);
    expect(played.mock.calls).toEqual(
      Array.from({ length: 3 }, () => [hurt, { volume: 1, channel: 'sfx' }, 'event:zuk_hit']),
    );
    expect(
      visuals
        .takeAnimations(30)
        .filter(({ cue }) => cue.clipId === 'defend')
        .map(({ cue }) => cue.actorId),
    ).toEqual(defend ? [actor.id, actor.id, actor.id] : []);

    played.mockClear();
    enqueueEnginePendingHit(simulation, {
      sourceId: 'player',
      targetId: actor.id,
      style: 'range',
      attackKind: 'range_arrow',
      launchTick: 1,
      impactTick: 2,
      rolledDamage: 100,
      accuracySucceeded: true,
    });
    simulation.advanceTick(simulation.getState().playerPosition);
    const lethal = simulation.getLastTickEvents();
    player.onEvents(lethal, [0, 0]);
    expect(
      lethal
        .filter(isEncounterVisualEvent)
        .flatMap((event) => event.animations)
        .filter((cue) => cue.clipId === 'defend'),
    ).toEqual([]);
    // The death sound comes with the death sequence, a tick after the killing hit's own sound for every
    // queued Zuk-wave NPC: W69 Jal-Xil t155 hit 600 -> t156 599, Jad t983 410 -> t984 409, enrage
    // healers t1138 -> t1139 899.
    expect(played.mock.calls.map(([id]) => id)).toEqual([hurt]);
    expect(lethal).toContainEqual(expect.objectContaining({ type: 'actor_died', actorId: actor.id }));
    played.mockClear();
    simulation.advanceTick(simulation.getState().playerPosition);
    player.onEvents(simulation.getLastTickEvents(), [0, 0]);
    expect(played.mock.calls.map(([id]) => id)).toEqual(death === undefined ? [] : [death]);
  });
});

describe('ordinary-wave Inferno event audio', () => {
  it.each([
    ['nibbler_melee', [[595, { volume: 1, channel: 'area' }]]],
    ['bat_range', [[291, { volume: 1, channel: 'sfx', delayMs: 300 }]]],
    [
      'blob_magic',
      [
        [595, { volume: 1, channel: 'sfx' }],
        [3528, { volume: 1, channel: 'sfx', delayMs: 2120 }],
      ],
    ],
    ['blob_range', [[3403, { volume: 1, channel: 'sfx', delayMs: 2120 }]]],
    ['blob_melee', [[595, { volume: 1, channel: 'sfx' }]]],
    ['meleer_melee', [[608, { volume: 1, channel: 'sfx' }]]],
  ] as const)('plays the captured %s sounds', (attack, expected) => {
    const { player, played } = fixture();
    // Listener on the attacker's tile: the nibbler's area sound is at full volume there.
    player.onEvents([attackEvent(attack)], [31, 55]);
    expect(played.mock.calls).toEqual(expected.map(([id, options]) => [id, options, 'event:zuk_attack']));
  });

  it('attenuates the nibbler swing with range 7 at the nibbler', () => {
    const { player, played } = fixture();
    player.onEvents([attackEvent('nibbler_melee')], [31, 63]);
    expect(played).not.toHaveBeenCalled();
  });

  it.each([
    ['nibbler', 597, 596],
    ['blob', 597, 596],
    ['blob_child', 597, 596],
    ['bat', 296, 295],
    ['meleer', 610, 609],
  ] as const)('plays %s hit %i and death %i', (npcKind, hit, death) => {
    const { player, played } = fixture();
    player.onEvents(
      ['zuk_hit', 'zuk_death'].map((type, eventId) => ({
        type,
        eventId,
        tick: 100,
        actorId: 'npc',
        npcKind,
        position: [31, 48],
      })),
      [31, 48],
    );
    expect(played.mock.calls.map(([id, options]) => [id, options?.channel])).toEqual([
      [hit, 'sfx'],
      [death, 'sfx'],
    ]);
  });

  it.each([
    ['meleer_dig_down', 1641],
    ['meleer_dig_up', 1644],
    ['mager_resurrect', 1095],
  ] as const)('plays %s as a range-10 area sound at the actor', (ability, id) => {
    const { player, played } = fixture();
    const event = { type: 'inferno_ability', eventId: 1, tick: 100, ability, actorId: 'npc', position: [31, 48] };
    player.onEvents([event], [31, 48]);
    player.onEvents([{ ...event, eventId: 2 }], [31, 59]);
    expect(played.mock.calls).toEqual([[id, { volume: 1, channel: 'area' }, 'event:inferno_ability']]);
  });

  it('plays each pillar collapse at its SW + (1, 1)', () => {
    const { player, played } = fixture();
    player.onEvents(
      ['west', 'south'].map((pillar, eventId) => ({
        type: 'inferno_pillar_collapse',
        eventId,
        tick: 100,
        pillar,
        position: [17, 37],
        soundId: 1021,
        soundPosition: [18, 38],
      })),
      [18, 38],
    );
    expect(played.mock.calls).toEqual([
      [1021, { volume: 1, channel: 'area' }, 'event:inferno_pillar_collapse'],
      [1021, { volume: 1, channel: 'area' }, 'event:inferno_pillar_collapse'],
    ]);
  });
});
