import { afterEach, describe, expect, it, vi } from 'vitest';
import { type EncounterVisualEvent, isEncounterVisualEvent } from '../../core/events/encounterVisual';
import { ReplayRecorder } from '../../core/ReplayRecorder';
import {
  clearWave,
  confirm,
  type Run,
  runState,
  startRun,
  step,
} from '../../encounters/colosseum/waves/__tests__/waveRunHarness';
import { SOL_BEAM_PREPARED_EVENT } from '../../encounters/solHeredit/constants';
import { colossusEngine, resetArena } from '../../npcs/colosseum/__tests__/colossusReachHarness';
import { COLOSSUS_FIRST_ATTACK_TICKS } from '../../npcs/colosseum/colossusReach';
import { COLOSSEUM_SPOTANIMS } from '../../npcs/colosseum/constants';
import { createJavelinColossus } from '../../npcs/colosseum/javelinColossus';
import { createShockwaveColossus, SHOCKWAVE_PROJECTILE_TIMING } from '../../npcs/colosseum/shockwaveColossus';
import type { Coordinate } from '../../types/simulation';
import { AudioEngine } from '../AudioEngine';
import { EventAudioPlayer } from '../EventAudioPlayer';
import { solHereditAudioRules } from '../solHereditAudioRules';
import { SOL_BEAM_WARNING_SOUND_TICKS, SOL_LIGHTNING_SOUND_TICKS } from './fixtures/solHereditAudioCapture';

afterEach(() => {
  vi.restoreAllMocks();
  resetArena();
});

describe('Sol sand audio capture conformance', () => {
  it.each([
    'colosseum-sol-heredit-packet-data.txt',
    'colosseum-sol-heredit-solar-flare-doom-volatility-packet-data.txt',
  ])('plays the captured lightning sounds at their printed delays in %s', (filename) => {
    const batches = SOL_LIGHTNING_SOUND_TICKS[filename] ?? [];
    expect(batches.length).toBeGreaterThanOrEqual(5);
    const audio = new AudioEngine();
    const played = vi.spyOn(audio, 'play').mockImplementation(() => undefined);
    const player = new EventAudioPlayer(audio, solHereditAudioRules);

    for (const [eventId, { tick, sounds }] of batches.entries()) {
      played.mockClear();
      expect(sounds).toHaveLength(2);
      const event: EncounterVisualEvent = {
        type: 'encounter_visual',
        eventId,
        tick,
        animations: [],
        projectiles: [],
        graphics: [
          {
            spotAnimId: COLOSSEUM_SPOTANIMS.sunfireLightning,
            target: { kind: 'tile', position: [33, 35] },
            delayCycles: 30,
            height: 0,
          },
          {
            spotAnimId: COLOSSEUM_SPOTANIMS.sunfireLightning,
            target: { kind: 'tile', position: [34, 35] },
            delayCycles: 30,
            height: 0,
          },
        ],
      };

      player.onEvents([event], [33, 35]);

      expect(played.mock.calls.map(([id, options]) => [id, options?.delayMs])).toEqual(
        sounds.map(([id, delay]) => [id, delay * 20]),
      );
    }
  });
});

describe('Sol beam warning audio capture conformance', () => {
  it.each([
    'colosseum-sol-heredit-packet-data.txt',
    'colosseum-sol-heredit-solar-flare-doom-volatility-packet-data.txt',
  ])('plays every fired warning pair at its printed delays in %s', (filename) => {
    const preparations = SOL_BEAM_WARNING_SOUND_TICKS[filename] ?? [];
    const audio = new AudioEngine();
    const played = vi.spyOn(audio, 'play').mockImplementation(() => undefined);
    const player = new EventAudioPlayer(audio, solHereditAudioRules);

    let fired = 0;
    for (const [eventId, { tick, fireTick, sounds }] of preparations.entries()) {
      // Terminal warnings precede a charge that Sol's death interrupts.
      if (fireTick === null || fireTick - tick > 7) continue;
      fired++;
      played.mockClear();
      player.onEvents([{ type: SOL_BEAM_PREPARED_EVENT, eventId, tick, fireInTicks: fireTick - tick }], [33, 35]);
      expect(played.mock.calls.map(([id, options]) => [id, options?.delayMs])).toEqual(
        sounds.map(([id, delay]) => [id, delay * 20]),
      );
    }
    expect(fired).toBe(6);
  });
});

it('preserves separate beam impact sounds even when their endpoints share a row', () => {
  const audio = new AudioEngine();
  const played = vi.spyOn(audio, 'play').mockImplementation(() => undefined);
  const player = new EventAudioPlayer(audio, solHereditAudioRules);
  const event: EncounterVisualEvent = {
    type: 'encounter_visual',
    eventId: 1,
    tick: 10,
    animations: [],
    projectiles: [],
    graphics: [
      { spotAnimId: 2697, target: { kind: 'tile', position: [25, 32] }, delayCycles: 39, height: 128 },
      { spotAnimId: 2697, target: { kind: 'tile', position: [40, 32] }, delayCycles: 39, height: 128 },
      { spotAnimId: 2697, target: { kind: 'tile', position: [30, 32] }, delayCycles: 39, height: 128 },
    ],
  };

  player.onEvents([event], [33, 32]);

  expect(played.mock.calls.map(([id]) => id)).toEqual([8230, 8230, 8230]);
  // The capture's sound_area is emitted without delay, separately from delayed map_anim.
  expect(played.mock.calls.map(([, options]) => options?.delayMs)).toEqual([undefined, undefined, undefined]);
});

describe('wave colossi sounds', () => {
  const PLAYER_TILE: Coordinate = [22, 38];
  const COLOSSUS_TILE: Coordinate = [28, 41];

  /** What the rule plays for a colossus run through the engine: id, the client cycle it plays on, tile and range. */
  function heard(colossus: Parameters<typeof colossusEngine>[0], ticks: number) {
    const engine = colossusEngine(colossus, PLAYER_TILE, () => 0.5);
    const rule = solHereditAudioRules.encounter_visual;
    if (typeof rule.resolve !== 'function') throw new TypeError('expected a resolver');
    const sounds: { id: number; cycle: number; position?: unknown; range?: number }[] = [];
    const events: EncounterVisualEvent[] = [];
    while (engine.currentTick < ticks) {
      engine.advanceTick(PLAYER_TILE);
      for (const event of engine.getLastTickEvents().filter(isEncounterVisualEvent)) {
        events.push(event);
        const result = rule.resolve(event);
        if (result.kind !== 'play') continue;
        for (const sound of [result.sound].flat()) {
          if (typeof sound === 'number') throw new TypeError('expected timed sounds');
          sounds.push({
            id: sound.id,
            cycle: event.tick * 30 + (sound.delayCycles ?? 0),
            ...(sound.position ? { position: sound.position, range: sound.range } : {}),
          });
        }
      }
    }
    return { sounds, events };
  }

  it('plays each throw on its landing, the artillery warning on T+3 and its blast on the tile at T+6 (C:1560-1563)', () => {
    const javelin = createJavelinColossus({ id: 'javelin', position: COLOSSUS_TILE, spawnTick: 0 });
    const cast = COLOSSUS_FIRST_ATTACK_TICKS + 4 * 5;
    const { sounds, events } = heard(javelin, cast + 6);
    const blast = events
      .flatMap((event) => event.graphics)
      .find((cue) => cue.spotAnimId === COLOSSEUM_SPOTANIMS.javelinArtilleryBlast);
    if (blast?.target.kind !== 'tile') throw new Error('no artillery blast');
    expect(sounds).toEqual([
      // synth_sound 8348 delay=90 on each throw tick (C:1562): the javelin's `endtime`.
      ...[0, 1, 2, 3].map((index) => ({ id: 8348, cycle: (COLOSSUS_FIRST_ATTACK_TICKS + index * 5) * 30 + 90 })),
      // synth_sound 8356 with no delay on T+3, beside the shadow's map_anim (C:1560).
      { id: 8356, cycle: (cast + 3) * 30 },
      // The next throw, five ticks after the artillery.
      { id: 8348, cycle: (cast + 5) * 30 + 90 },
      // sound_area 8352 range=15 with no delay, on the blast's tick and tile (C:1563).
      { id: 8352, cycle: (cast + 6) * 30, position: blast.target.position, range: 15 },
    ]);
  });

  it("plays the Shockwave's sound as its projectile lands (C:2414)", () => {
    const shockwave = createShockwaveColossus({ id: 'shockwave', position: COLOSSUS_TILE, spawnTick: 0 });
    const { sounds, events } = heard(shockwave, COLOSSUS_FIRST_ATTACK_TICKS);
    const projectile = events.flatMap((event) => event.projectiles)[0];
    expect(projectile?.endDelayCycles).toBeGreaterThan(SHOCKWAVE_PROJECTILE_TIMING.delay);
    expect(sounds).toEqual([{ id: 5774, cycle: COLOSSUS_FIRST_ATTACK_TICKS * 30 + projectile!.endDelayCycles }]);
  });
});

describe('the intermission Continue sound', () => {
  const CONFIRMED_SOUND = 8010;

  /** Plays every tick's events through the Colosseum rules; returns `[tick, delayMs, channel]` per 8010. */
  function listen(run: Run) {
    const audio = new AudioEngine();
    const played = vi.spyOn(audio, 'play').mockImplementation(() => undefined);
    const player = new EventAudioPlayer(audio, solHereditAudioRules);
    const heard: [number, number | undefined, string | undefined][] = [];
    const advance = () => {
      played.mockClear();
      const events = step(run);
      player.onEvents([...events], run.engine.getState().playerPosition);
      for (const [id, options] of played.mock.calls) {
        if (id === CONFIRMED_SOUND) heard.push([run.engine.currentTick, options?.delayMs, options?.channel]);
      }
      return events;
    };
    return { heard, advance };
  }

  // synth_sound 8010, no delay, on Tk with Minimus's del (A:832, B:1857, C:1446, K:3987; 32/32).
  it('plays once, unattenuated and undelayed, on the tick the choice is accepted, never for a refused one', () => {
    const run = startRun(1);
    const { heard, advance } = listen(run);
    advance();
    const offer = runState(run).offer!;
    // Refused: a wave the offer is not for, then an option it does not hold.
    confirm(run, offer.options[0]!.id, offer.wave + 1);
    advance();
    run.engine.queueEncounterCommand({
      encounter: 'sol_heredit',
      type: 'confirm-modifier',
      wave: offer.wave,
      modifierId: (['mantimayhem', 'reentry', 'myopia'] as const).find(
        (id) => !offer.options.some((option) => option.id === id),
      )!,
    });
    advance();
    expect(heard).toEqual([]);

    confirm(run, offer.options[0]!.id);
    // A second Continue queued for the same choice is stale.
    confirm(run, offer.options.at(-1)!.id);
    advance();
    const tk = run.engine.currentTick;
    expect(runState(run).picks.at(-1)?.tick).toBe(tk);
    expect(heard).toEqual([[tk, undefined, 'sfx']]);

    // Nothing more through the wave, nor when the next intermission opens.
    clearWave(run);
    while (runState(run).offer === null) advance();
    for (let tick = 0; tick < 5; tick++) advance();
    expect(heard).toEqual([[tk, undefined, 'sfx']]);
  });

  it('replays from the recorded events: once, on the same tick, through a seek past it', () => {
    const run = startRun(1);
    const recorder = new ReplayRecorder();
    recorder.startRun(run.engine.getRunConfig());
    const position = run.engine.getState().playerPosition;
    recorder.recordFrame(0, position, run.engine.getState(), []);
    let tk = -1;
    while (run.engine.currentTick < 12) {
      if (runState(run).offer) confirm(run);
      run.engine.advanceTick(position);
      if (tk < 0 && runState(run).picks.length > 0) tk = run.engine.currentTick;
      recorder.recordFrame(run.engine.currentTick, position, run.engine.getState(), run.engine.getLastTickEvents());
    }
    const frames = recorder.exportData().frames;

    const audio = new AudioEngine();
    const played = vi.spyOn(audio, 'play').mockImplementation(() => undefined);
    const player = new EventAudioPlayer(audio, solHereditAudioRules);
    const heardAt: number[] = [];
    for (const frame of frames) {
      played.mockClear();
      player.updateReplayClock(frame.tick * 600);
      player.onEvents(frame.events, position);
      for (const [id] of played.mock.calls) if (id === CONFIRMED_SOUND) heardAt.push(frame.tick);
    }
    expect(tk).toBeGreaterThan(0);
    expect(heardAt).toEqual([tk]);
  });
});
