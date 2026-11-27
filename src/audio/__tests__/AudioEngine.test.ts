import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioEngine, type SoundBufferLoader } from '../AudioEngine';
import { MAX_SIMULTANEOUS_SOUNDS } from '../constants';

describe('AudioEngine', () => {
  let engine: AudioEngine;
  let mockContext: {
    currentTime: number;
    state: string;
    createGain: ReturnType<typeof vi.fn>;
    createBufferSource: ReturnType<typeof vi.fn>;
    destination: object;
    resume: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    decodeAudioData: ReturnType<typeof vi.fn<(data: ArrayBuffer) => Promise<AudioBuffer>>>;
  };
  let mockSource: {
    buffer: unknown;
    loop: boolean;
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
  };

  beforeEach(() => {
    const mockGain = {
      gain: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    mockSource = {
      buffer: null,
      loop: false,
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
    mockContext = {
      currentTime: 10,
      state: 'running',
      createGain: vi.fn(() => mockGain),
      createBufferSource: vi.fn(() => mockSource),
      destination: {},
      resume: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      decodeAudioData: vi.fn(),
    };

    function MockAudioContext() {
      return mockContext;
    }
    vi.stubGlobal('AudioContext', MockAudioContext);
    engine = new AudioEngine(undefined, fetchAndDecode);
  });

  /**
   * A stand-in sound source: fetch a file and decode it on the context. A 404 or 410 means the sound
   * does not exist; any other failure is transient.
   */
  const fetchAndDecode: SoundBufferLoader = async (soundId) => {
    const response = await fetch(`/sounds/${soundId}.ogg`);
    if (!response.ok) {
      if (response.status === 404 || response.status === 410) return null;
      throw new Error(`HTTP ${response.status}`);
    }
    return mockContext.decodeAudioData(await response.arrayBuffer());
  };

  /** A source that produces buffers straight from the context, as a synth would: no fetch at all. */
  const decodeOnly: SoundBufferLoader = () => mockContext.decodeAudioData(new ArrayBuffer(8));

  it('requests nothing and stays quiet without a sound source', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn');
    const silent = new AudioEngine();

    silent.play(2500, undefined, 'test:silent');
    silent.play(2500);
    await silent.preloadSounds([2500, 2517]);
    await Promise.resolve();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(mockContext.createBufferSource).not.toHaveBeenCalled();
    expect(silent.getCacheStats()).toMatchObject({ retainedSounds: 0, pendingDecodes: 0, decodeCount: 0 });
    silent.dispose();
  });

  afterEach(() => {
    engine.dispose();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns a default master volume of 1.0', () => {
    expect(engine.getMasterVolume()).toBe(1);
  });

  it('returns a default sfx volume of 1.0', () => {
    expect(engine.getSfxVolume()).toBe(1);
  });

  it('is not ready before creating an audio context', () => {
    expect(engine.isReady()).toBe(false);
  });

  it('stores the master volume when updated', () => {
    engine.setMasterVolume(0.5);

    expect(engine.getMasterVolume()).toBe(0.5);
  });

  it('stores the sfx volume when updated', () => {
    engine.setSfxVolume(0.3);

    expect(engine.getSfxVolume()).toBe(0.3);
  });

  it('schedules playback at current time plus delay', () => {
    (engine as unknown as { bufferCache: Map<number, AudioBuffer> }).bufferCache.set(10313, {} as AudioBuffer);

    engine.play(10313, { delayMs: 420 });

    expect(mockSource.start).toHaveBeenCalledWith(10.42, 0);
  });

  it('records and emits sound play events with stable ids', () => {
    (engine as unknown as { bufferCache: Map<number, AudioBuffer> }).bufferCache.set(9335, {} as AudioBuffer);
    const listener = vi.fn();
    const unsubscribe = engine.onSoundPlayed(listener);

    engine.play(9335, { channel: 'area' }, 'event:fireball_spawned');

    expect(listener).toHaveBeenCalledTimes(1);
    const evt = listener.mock.calls[0][0] as { eventId: number; soundId: number; trigger: string; timestamp: number };
    expect(evt.eventId).toBe(1);
    expect(evt.soundId).toBe(9335);
    expect(evt.trigger).toBe('event:fireball_spawned');
    expect(typeof evt.timestamp).toBe('number');

    const history = engine.getRecentSoundEvents(5);
    expect(history.length).toBe(1);
    expect(history[0].eventId).toBe(1);

    unsubscribe();
  });

  it('stops notifying a listener after unsubscribe', () => {
    (engine as unknown as { bufferCache: Map<number, AudioBuffer> }).bufferCache.set(4997, {} as AudioBuffer);
    const listener = vi.fn();
    const unsubscribe = engine.onSoundPlayed(listener);

    engine.play(4997, { channel: 'sfx' }, 'event:attack_started');
    unsubscribe();
    engine.play(4997, { channel: 'sfx' }, 'event:attack_started');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  describe('stopAll', () => {
    it('stops all active sources and clears the set', () => {
      const buffers = [100, 200, 300];
      const sources: Array<typeof mockSource> = [];
      mockContext.createBufferSource = vi.fn(() => {
        const src = {
          buffer: null as unknown,
          loop: false,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null as (() => void) | null,
        };
        sources.push(src);
        return src;
      });

      for (const id of buffers) {
        (engine as unknown as { bufferCache: Map<number, AudioBuffer> }).bufferCache.set(id, {} as AudioBuffer);
        engine.play(id);
      }

      expect(sources).toHaveLength(3);

      engine.stopAll();

      for (const src of sources) {
        expect(src.stop).toHaveBeenCalled();
      }
    });
  });

  describe('lazy load on play', () => {
    beforeEach(() => {
      mockContext.decodeAudioData = vi.fn().mockResolvedValue({ length: 4, numberOfChannels: 1 } as AudioBuffer);
    });

    it('fetches and replays sound when not preloaded', async () => {
      const fakeArrayBuffer = new ArrayBuffer(8);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(fakeArrayBuffer),
        }),
      );

      engine.play(999, { channel: 'sfx' }, 'test:lazy');

      expect(mockContext.createBufferSource).not.toHaveBeenCalled();

      await vi.waitFor(() => {
        expect(mockContext.decodeAudioData).toHaveBeenCalled();
      });
      await vi.waitFor(() => {
        expect(mockSource.start).toHaveBeenCalled();
      });
    });

    it('does not double-fetch when play is called twice for same pending sound', async () => {
      const fakeArrayBuffer = new ArrayBuffer(8);
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(fakeArrayBuffer),
      });
      vi.stubGlobal('fetch', fetchMock);

      engine.play(888);
      engine.play(888);

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    it.each([404, 410])('treats a sound the source lacks (HTTP %s) as unavailable for the session', async (status) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const fetchMock = vi.fn().mockResolvedValue({ ok: false, status });
      vi.stubGlobal('fetch', fetchMock);

      engine.play(8143);
      engine.play(8143);
      await vi.waitFor(() => expect(engine.getCacheStats().pendingDecodes).toBe(0));
      engine.stopAll();
      engine.play(8143);
      await engine.preloadSounds([8143, 8143]);

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(mockContext.decodeAudioData).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      engine.dispose();
      expect(engine['failedLoads'].size).toBe(0);
    });

    it.each([
      'network',
      'body',
      403,
      408,
      429,
      500,
      503,
    ] as const)('retries a %s failure on the next explicit request and coalesces concurrent loads', async (failure) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rawData = new ArrayBuffer(8);
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(async () => {
          if (failure === 'network') throw new Error('temporary offline');
          return {
            ok: failure === 'body',
            status: typeof failure === 'number' ? failure : 200,
            arrayBuffer: async () => {
              throw new Error('broken body');
            },
          };
        })
        .mockResolvedValue({ ok: true, arrayBuffer: async () => rawData });
      vi.stubGlobal('fetch', fetchMock);

      await Promise.all([engine.loadSound(888), engine.loadSound(888)]);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(engine['failedLoads'].has(888)).toBe(false);
      expect(engine['bufferCache'].has(888)).toBe(false);

      mockContext.decodeAudioData.mockResolvedValue({ length: 4, numberOfChannels: 1 } as AudioBuffer);
      await Promise.all([engine.loadSound(888), engine.loadSound(888)]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockContext.decodeAudioData).toHaveBeenCalledExactlyOnceWith(rawData);
      engine.play(888);
      await vi.waitFor(() => expect(mockSource.start).toHaveBeenCalledOnce());
      expect(mockContext.decodeAudioData).toHaveBeenCalledOnce();
    });

    it('retries a transient failure on the next lazy play, sharing one load between waiting plays', async () => {
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary offline'))
        .mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
      vi.stubGlobal('fetch', fetchMock);

      engine.play(888);
      engine.play(888);
      await vi.waitFor(() => expect(engine.getCacheStats().pendingDecodes).toBe(0));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(mockSource.start).not.toHaveBeenCalled();

      engine.play(888);
      engine.play(888);
      await vi.waitFor(() => expect(mockSource.start).toHaveBeenCalledTimes(2));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mockContext.decodeAudioData).toHaveBeenCalledOnce();
    });
  });

  describe('cancels stale async playback on stopAll (replay seek/pause/exit)', () => {
    it('does not start a sound whose decode resolves after stopAll', async () => {
      let resolveDecode!: (b: AudioBuffer) => void;
      mockContext.decodeAudioData = vi.fn(
        () =>
          new Promise<AudioBuffer>((res) => {
            resolveDecode = res;
          }),
      );
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        }),
      );

      engine.play(901, { channel: 'sfx' }, 'test:cancel');

      // Wait until we reach the decode stage (fetch done, decode pending).
      await vi.waitFor(() => {
        expect(mockContext.decodeAudioData).toHaveBeenCalled();
      });

      engine.stopAll();

      // Decode resolves AFTER the stop: the now-stale sound must NOT start.
      resolveDecode({} as AudioBuffer);
      await Promise.resolve();
      await Promise.resolve();

      expect(mockSource.start).not.toHaveBeenCalled();
    });

    it('does start the sound when lazy-load resolves with no intervening stop (control)', async () => {
      mockContext.decodeAudioData = vi.fn().mockResolvedValue({} as AudioBuffer);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        }),
      );

      engine.play(902, { channel: 'sfx' }, 'test:cancel-control');

      await vi.waitFor(() => {
        expect(mockSource.start).toHaveBeenCalled();
      });
    });
  });

  describe('playback continuation', () => {
    const buffer: AudioBuffer = {
      duration: 4,
      length: 4,
      numberOfChannels: 1,
      sampleRate: 1,
      getChannelData: () => new Float32Array(4),
      copyFromChannel: vi.fn(),
      copyToChannel: vi.fn(),
    };
    let sources: Array<typeof mockSource>;
    let gains: Array<{
      gain: { value: number };
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }>;

    beforeEach(() => {
      sources = [];
      gains = [];
      engine.dispose();
      engine = new AudioEngine(undefined, decodeOnly);
      engine['bufferCache'].set(100, buffer);
      mockContext.createBufferSource = vi.fn(() => {
        const source: typeof mockSource = {
          buffer: null,
          loop: false,
          connect: vi.fn(),
          disconnect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
          onended: null,
        };
        sources.push(source);
        return source;
      });
      mockContext.createGain = vi.fn(() => {
        const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
        gains.push(gain);
        return gain;
      });
    });

    it('continues the same buffer at its elapsed offset when paused mid-waveform', () => {
      engine.play(100, { volume: 0.4, channel: 'area' }, 'test:wave');
      mockContext.currentTime = 11.25;

      engine.pausePlayback();
      mockContext.currentTime = 30;
      engine.resumePlayback();

      expect(sources[0].stop).toHaveBeenCalledOnce();
      expect(sources[0].disconnect).toHaveBeenCalledOnce();
      expect(gains[4].disconnect).toHaveBeenCalledOnce();
      expect(sources[1].buffer).toBe(buffer);
      expect(sources[1].start).toHaveBeenCalledExactlyOnceWith(30, 1.25);
      expect(gains[5].gain.value).toBe(0.4);
      expect(gains[5].connect).toHaveBeenCalledWith(gains[2]);
      expect(mockContext.state).toBe('running');
      expect(mockContext.resume).not.toHaveBeenCalled();
      expect(sources[1]).not.toHaveProperty('playbackRate');
    });

    it('retains only the remaining native delay when paused before onset', () => {
      engine.play(100, { delayMs: 2000 });
      mockContext.currentTime = 10.75;
      engine.pausePlayback();
      mockContext.currentTime = 30;

      engine.resumePlayback();

      expect(sources[1].start).toHaveBeenCalledExactlyOnceWith(31.25, 0);
    });

    it('accumulates offsets across repeated pauses without counting paused time', () => {
      engine.play(100, { delayMs: 500 });
      mockContext.currentTime = 11;
      engine.pausePlayback();
      mockContext.currentTime = 30;
      engine.resumePlayback();
      mockContext.currentTime = 31;

      engine.pausePlayback();
      mockContext.currentTime = 60;
      engine.resumePlayback();

      expect(sources[2].start).toHaveBeenCalledExactlyOnceWith(60, 1.5);
    });

    it('does not stop twice or duplicate voices or play events when pause/resume repeat', () => {
      const listener = vi.fn();
      engine.onSoundPlayed(listener);
      engine.play(100, undefined, 'test:once');
      mockContext.currentTime = 11;

      engine.pausePlayback();
      mockContext.currentTime = 20;
      engine.pausePlayback();
      engine.resumePlayback();
      engine.resumePlayback();

      expect(sources).toHaveLength(2);
      expect(sources[0].stop).toHaveBeenCalledOnce();
      expect(sources[1].start).toHaveBeenCalledExactlyOnceWith(20, 1);
      expect(listener).toHaveBeenCalledOnce();
      expect(engine.getRecentSoundEvents()).toHaveLength(1);
    });

    it('does not revive naturally ended or exhausted voices awaiting onended', () => {
      engine.play(100);
      sources[0].onended?.();
      engine.play(100);
      mockContext.currentTime = 14;

      engine.pausePlayback();
      engine.resumePlayback();

      expect(sources).toHaveLength(2);
    });

    it('ignores late onended callbacks from nodes replaced by pause/resume', () => {
      engine.play(100);
      const oldEnded = sources[0].onended;
      mockContext.currentTime = 11;
      engine.pausePlayback();
      engine.resumePlayback();

      oldEnded?.();
      mockContext.currentTime = 12;
      engine.pausePlayback();
      engine.resumePlayback();

      expect(sources[2].start).toHaveBeenCalledExactlyOnceWith(12, 2);
      expect(sources[0].disconnect).toHaveBeenCalledOnce();
    });

    it('bounds voices even when stopped nodes have not dispatched onended', () => {
      for (let index = 0; index < MAX_SIMULTANEOUS_SOUNDS + 5; index++) engine.play(100);
      const originalSources = sources.slice();

      engine.pausePlayback();
      engine.resumePlayback();

      expect(sources.length - originalSources.length).toBe(MAX_SIMULTANEOUS_SOUNDS);
      for (const source of originalSources) expect(source.stop).toHaveBeenCalledOnce();
    });

    it.each(['sfx', 'area'] as const)('uses current %s gain when an existing muted voice resumes', (channel) => {
      engine.play(100, { channel, volume: 0.3 });
      engine.pausePlayback();
      engine.setSfxVolume(0);
      engine.setAreaVolume(0);

      engine.resumePlayback();

      const channelGain = gains[channel === 'area' ? 2 : 1];
      expect(sources).toHaveLength(2);
      expect(gains[5].connect).toHaveBeenCalledWith(channelGain);
      expect(gains[5].gain.value).toBe(0.3);
      expect(channelGain.gain.value).toBe(0);
      engine.setSfxVolume(0.2);
      engine.setAreaVolume(0.6);
      expect(channelGain.gain.value).toBe(channel === 'area' ? 0.6 : 0.2);
    });

    it('drops new cached and uncached plays while paused, including after context unlock', async () => {
      const fetchSound = vi.fn();
      vi.stubGlobal('fetch', fetchSound);
      engine.pausePlayback();
      await engine.resume();

      engine.play(100, undefined, 'test:paused-cached');
      engine.play(200, undefined, 'test:paused-uncached');
      engine.resumePlayback();

      expect(sources).toHaveLength(0);
      expect(fetchSound).not.toHaveBeenCalled();
      expect(engine.getRecentSoundEvents()).toHaveLength(0);
    });

    it('cancels paused voices and lifts the pause on stopAll, allowing fresh live playback', () => {
      engine.play(100);
      engine.play(100, { delayMs: 2000 });
      engine.pausePlayback();

      engine.stopAll();
      engine.play(100);
      engine.resumePlayback();

      expect(sources).toHaveLength(3);
      expect(sources[2].start).toHaveBeenCalledOnce();
    });

    // A mute or scene replacement does not own the pause: playback stays paused under it until its
    // owner resumes it.
    it.each([
      { name: 'master mute', mute: (audio: AudioEngine) => audio.setMasterVolume(0) },
      { name: 'focus mute', mute: (audio: AudioEngine) => audio.setFocusSuspended(true) },
      { name: 'discardSounds', mute: (audio: AudioEngine) => audio.discardSounds() },
    ])('cancels paused voices on $name but keeps the pause until it is resumed', ({ mute }) => {
      engine.play(100);
      engine.play(100, { delayMs: 2000 });
      engine.pausePlayback();

      mute(engine);
      engine.setMasterVolume(1);
      engine.setFocusSuspended(false);
      engine.play(100);
      expect(sources).toHaveLength(2);
      engine.resumePlayback();
      engine.play(100);

      expect(sources).toHaveLength(3);
      expect(sources[2].start).toHaveBeenCalledOnce();
    });

    it('never resurrects paused voices or creates a context after disposal', async () => {
      engine.play(100);
      engine.pausePlayback();

      engine.dispose();
      engine.pausePlayback();
      engine.resumePlayback();
      await engine.resume();
      engine.play(100);

      expect(sources).toHaveLength(1);
      expect(mockContext.close).toHaveBeenCalledOnce();
      expect(engine.isReady()).toBe(false);
    });

    it('rejects a stale decode after pause/resume but keeps its buffer for fresh live plays', async () => {
      const resolveDecode = vi.fn<(value: AudioBuffer) => void>();
      const decoded = new Promise<AudioBuffer>((resolve) => resolveDecode.mockImplementation(resolve));
      mockContext.decodeAudioData.mockReturnValue(decoded);
      engine.play(200, undefined, 'test:stale');
      engine.pausePlayback();
      engine.resumePlayback();

      resolveDecode(buffer);
      await decoded;

      expect(sources).toHaveLength(0);
      expect(engine.getRecentSoundEvents()).toHaveLength(0);
      engine.play(200, undefined, 'test:fresh');
      expect(sources).toHaveLength(1);
      expect(engine.getRecentSoundEvents().map((event) => event.trigger)).toEqual(['test:fresh']);
    });

    it('cancels lazy loads that complete after pause/resume without dropping subsequent live playback', async () => {
      const finishLoad = vi.fn<() => void>();
      const loaded = new Promise<void>((resolve) => finishLoad.mockImplementation(resolve));
      const loader = vi.fn<SoundBufferLoader>(async () => {
        await loaded;
        return buffer;
      });
      engine.dispose();
      engine = new AudioEngine(undefined, loader);
      engine.play(200, undefined, 'test:stale-load');
      engine.pausePlayback();
      engine.resumePlayback();

      finishLoad();
      await loader.mock.results[0]?.value;
      await Promise.resolve();

      expect(sources).toHaveLength(0);
      expect(engine.getRecentSoundEvents()).toHaveLength(0);
      engine.play(200, undefined, 'test:fresh-load');
      await Promise.resolve();
      expect(sources).toHaveLength(1);
      expect(engine.getRecentSoundEvents().map((event) => event.trigger)).toEqual(['test:fresh-load']);
    });

    // Sol Heredit's shield ripple plays one cue per tile (~169) in the same frame.
    const BURST = 169;

    it('decodes a burst of plays of one undecoded sound once and keeps the voice cap', async () => {
      const resolveDecode = vi.fn<(value: AudioBuffer) => void>();
      const decoded = new Promise<AudioBuffer>((resolve) => resolveDecode.mockImplementation(resolve));
      mockContext.decodeAudioData.mockReturnValue(decoded);

      for (let index = 0; index < BURST; index++) engine.play(200, undefined, 'test:burst');

      expect(mockContext.decodeAudioData).toHaveBeenCalledOnce();
      expect(sources).toHaveLength(0);
      resolveDecode(buffer);
      await decoded;

      expect(mockContext.decodeAudioData).toHaveBeenCalledOnce();
      expect(sources).toHaveLength(BURST);
      expect(engine['activeSources'].size).toBe(MAX_SIMULTANEOUS_SOUNDS);
      expect(engine.getRecentSoundEvents(BURST)).toHaveLength(BURST);
      engine.play(200);
      expect(mockContext.decodeAudioData).toHaveBeenCalledOnce();

      engine.stopAll();
      expect(engine['activeSources'].size).toBe(0);
      for (const source of sources) expect(source.stop).toHaveBeenCalledOnce();
    });

    it("keeps each shared-decode caller's volume, channel, delay and trigger", async () => {
      let finishDecode!: (value: AudioBuffer) => void;
      const decoded = new Promise<AudioBuffer>((resolve) => {
        finishDecode = resolve;
      });
      mockContext.decodeAudioData.mockReturnValue(decoded);

      engine.play(200, { volume: 0.25, channel: 'area', delayMs: 420 }, 'test:area');
      engine.play(200, { volume: 0.75, channel: 'sfx', delayMs: 1000 }, 'test:sfx');
      finishDecode(buffer);
      await decoded;

      expect(mockContext.decodeAudioData).toHaveBeenCalledOnce();
      expect(sources[0].start).toHaveBeenCalledExactlyOnceWith(10.42, 0);
      expect(sources[1].start).toHaveBeenCalledExactlyOnceWith(11, 0);
      expect(gains[4].gain.value).toBe(0.25);
      expect(gains[4].connect).toHaveBeenCalledWith(gains[2]);
      expect(gains[5].gain.value).toBe(0.75);
      expect(gains[5].connect).toHaveBeenCalledWith(gains[1]);
      expect(engine.getRecentSoundEvents().map((event) => event.trigger)).toEqual(['test:sfx', 'test:area']);
    });

    it('starts nothing from a shared decode that completes after stopAll', async () => {
      const resolveDecode = vi.fn<(value: AudioBuffer) => void>();
      const decoded = new Promise<AudioBuffer>((resolve) => resolveDecode.mockImplementation(resolve));
      mockContext.decodeAudioData.mockReturnValue(decoded);
      for (let index = 0; index < BURST; index++) engine.play(200, undefined, 'test:burst-stale');

      engine.stopAll();
      engine.play(200, undefined, 'test:burst-fresh');
      resolveDecode(buffer);
      await decoded;

      expect(mockContext.decodeAudioData).toHaveBeenCalledOnce();
      expect(sources).toHaveLength(1);
      expect(engine.getRecentSoundEvents().map((event) => event.trigger)).toEqual(['test:burst-fresh']);
    });

    it('retries a decode after the shared attempt fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const failed = Promise.reject(new Error('bad ogg'));
      mockContext.decodeAudioData.mockReturnValueOnce(failed).mockResolvedValueOnce(buffer);
      for (let index = 0; index < BURST; index++) engine.play(200);

      await failed.catch(() => {});
      expect(mockContext.decodeAudioData).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
      expect(sources).toHaveLength(0);

      engine.play(200);
      await vi.waitFor(() => expect(sources).toHaveLength(1));
      expect(mockContext.decodeAudioData).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it('does not cache a decode that completes after dispose', async () => {
      const resolveDecode = vi.fn<(value: AudioBuffer) => void>();
      const decoded = new Promise<AudioBuffer>((resolve) => resolveDecode.mockImplementation(resolve));
      mockContext.decodeAudioData.mockReturnValue(decoded);
      for (let index = 0; index < BURST; index++) engine.play(200);

      engine.dispose();
      resolveDecode(buffer);
      await decoded;

      expect(sources).toHaveLength(0);
      expect(engine.getCacheStats()).toMatchObject({ retainedSounds: 0, pendingDecodes: 0 });
    });

    describe('decoded cache budget', () => {
      beforeEach(() => {
        engine.dispose();
        engine = new AudioEngine(32, decodeOnly);
      });

      async function playDecoded(soundId: number, length = 4, channels = 1): Promise<AudioBuffer> {
        const decodedBuffer = { ...buffer, length, numberOfChannels: channels };
        mockContext.decodeAudioData.mockResolvedValueOnce(decodedBuffer);
        engine.play(soundId);
        await Promise.resolve();
        await Promise.resolve();
        return decodedBuffer;
      }

      it('counts PCM bytes and unique retained sounds separately from successful decodes', async () => {
        expect(engine.getCacheStats()).toEqual({
          retainedBytes: 0,
          retainedSounds: 0,
          decodeCount: 0,
          pendingDecodes: 0,
          budgetBytes: 32,
        });
        const snapshot = engine.getCacheStats();
        await playDecoded(200, 3, 2);
        engine.play(200);

        expect(engine.getCacheStats()).toEqual({
          retainedBytes: 24,
          retainedSounds: 1,
          decodeCount: 1,
          pendingDecodes: 0,
          budgetBytes: 32,
        });
        expect(snapshot.retainedBytes).toBe(0);
        engine.dispose();
        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 0, retainedSounds: 0, decodeCount: 1 });
      });

      it('evicts the least recently played cold sound and decodes it again without another fetch', async () => {
        await playDecoded(200);
        sources[0].onended?.();
        await playDecoded(300);
        sources[1].onended?.();
        engine.play(200);
        sources[2].onended?.();
        await playDecoded(400);

        engine.play(200);
        sources.at(-1)?.onended?.();
        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 32, retainedSounds: 2, decodeCount: 3 });
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await playDecoded(300);

        engine.play(400);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 32, retainedSounds: 2, decodeCount: 4 });
      });

      it('protects every active voice, even over budget, then trims immediately when voices end', async () => {
        await playDecoded(200);
        await playDecoded(300);
        await playDecoded(400);

        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 48, retainedSounds: 3 });
        for (const source of sources) expect(source.stop).not.toHaveBeenCalled();
        sources[1].onended?.();
        engine.play(200);
        engine.play(400);
        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 32, retainedSounds: 2, decodeCount: 3 });
        await playDecoded(300);
        expect(engine.getCacheStats().decodeCount).toBe(4);
      });

      it('waits for the last voice of a sound before evicting its buffer', async () => {
        engine.dispose();
        engine = new AudioEngine(0, decodeOnly);
        await playDecoded(200);
        engine.play(200);
        sources[0].onended?.();
        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 16, retainedSounds: 1, decodeCount: 1 });
        sources[1].onended?.();
        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 0, retainedSounds: 0, decodeCount: 1 });
      });

      it('protects simultaneous decode continuations until each sound starts its voice', async () => {
        engine.dispose();
        engine = new AudioEngine(0, decodeOnly);
        mockContext.decodeAudioData.mockResolvedValueOnce({ ...buffer }).mockResolvedValueOnce({ ...buffer });
        engine.play(200);
        engine.play(300);
        await Promise.resolve();
        await Promise.resolve();

        expect(sources).toHaveLength(2);
        expect(mockContext.decodeAudioData).toHaveBeenCalledTimes(2);
        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 32, retainedSounds: 2, pendingDecodes: 0 });
        engine.stopAll();
        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 0, retainedSounds: 0 });
      });

      it('protects scheduled and paused voices with a zero budget and resumes their exact remaining delay', async () => {
        engine.dispose();
        engine = new AudioEngine(0, decodeOnly);
        await playDecoded(200);
        engine.stopAll();
        mockContext.decodeAudioData.mockResolvedValueOnce(buffer);
        engine.play(200, { volume: 0.4, channel: 'area', delayMs: 2000 });
        await Promise.resolve();
        await Promise.resolve();
        expect(engine.getCacheStats().retainedBytes).toBe(16);
        mockContext.currentTime = 10.75;
        engine.pausePlayback();
        expect(engine.getCacheStats().retainedBytes).toBe(16);
        mockContext.currentTime = 30;
        engine.resumePlayback();

        expect(sources[2].start).toHaveBeenCalledExactlyOnceWith(31.25, 0);
        expect(sources[2].buffer).toBe(buffer);
        expect(gains[6].gain.value).toBe(0.4);
        expect(gains[6].connect).toHaveBeenCalledWith(gains[2]);
        sources[2].onended?.();
        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 0, retainedSounds: 0, decodeCount: 2 });
      });

      it('trims over-budget voices discarded by stopAll, including held paused voices', async () => {
        await playDecoded(200, 10);
        engine.pausePlayback();
        expect(engine.getCacheStats().retainedBytes).toBe(40);
        engine.stopAll();
        expect(engine.getCacheStats()).toMatchObject({ retainedBytes: 0, retainedSounds: 0 });
      });

      it('trims a canceled decode without starting or re-decoding it', async () => {
        let finishDecode!: (value: AudioBuffer) => void;
        const decoded = new Promise<AudioBuffer>((resolve) => {
          finishDecode = resolve;
        });
        mockContext.decodeAudioData.mockReturnValue(decoded);
        engine.play(200);
        expect(engine.getCacheStats().pendingDecodes).toBe(1);
        engine.stopAll();
        finishDecode({ ...buffer, length: 10 });
        await decoded;
        await Promise.resolve();

        expect(sources).toHaveLength(0);
        expect(engine.getCacheStats()).toMatchObject({
          retainedBytes: 0,
          retainedSounds: 0,
          decodeCount: 1,
          pendingDecodes: 0,
        });
        expect(mockContext.decodeAudioData).toHaveBeenCalledOnce();
      });

      it('keeps a normal observed Sol-sized working set warm under the generous default', async () => {
        engine.dispose();
        engine = new AudioEngine(undefined, decodeOnly);
        for (let id = 200; id < 260; id++) {
          await playDecoded(id, 64 * 1024);
          sources.at(-1)?.onended?.();
        }
        for (let id = 200; id < 260; id++) {
          engine.play(id);
          sources.at(-1)?.onended?.();
        }

        expect(mockContext.decodeAudioData).toHaveBeenCalledTimes(60);
        expect(engine.getCacheStats()).toMatchObject({
          retainedBytes: 15 * 1024 * 1024,
          retainedSounds: 60,
          decodeCount: 60,
          budgetBytes: 64 * 1024 * 1024,
        });
      });
    });

    it.each([
      { name: 'stopAll', cancel: (audio: AudioEngine) => audio.stopAll() },
      { name: 'master mute', cancel: (audio: AudioEngine) => audio.setMasterVolume(0) },
      { name: 'focus mute', cancel: (audio: AudioEngine) => audio.setFocusSuspended(true) },
      { name: 'discardSounds', cancel: (audio: AudioEngine) => audio.discardSounds() },
      { name: 'dispose', cancel: (audio: AudioEngine) => audio.dispose() },
    ])('rejects pending decode completion after $name', async ({ cancel }) => {
      const resolveDecode = vi.fn<(value: AudioBuffer) => void>();
      const decoded = new Promise<AudioBuffer>((resolve) => resolveDecode.mockImplementation(resolve));
      mockContext.decodeAudioData.mockReturnValue(decoded);
      engine.play(200, undefined, 'test:cancel-decode');

      cancel(engine);
      engine.setMasterVolume(1);
      engine.setFocusSuspended(false);
      resolveDecode(buffer);
      await decoded;
      engine.resumePlayback();

      expect(sources).toHaveLength(0);
      expect(engine.getRecentSoundEvents()).toHaveLength(0);
    });
  });

  describe('setFocusSuspended', () => {
    // Override createGain so each of masterGain / sfxGain / areaGain is a
    // distinct object. The default mock shares one gain instance across all
    // calls, which hides interactions between the three gain nodes.
    let masterGain: { gain: { value: number } };
    beforeEach(() => {
      const gains: Array<{
        gain: { value: number };
        connect: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
      }> = [];
      mockContext.createGain = vi.fn(() => {
        const g = {
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        gains.push(g);
        return g;
      });
      // Force context creation so masterGain is the first gain created.
      (engine as unknown as { ensureContext: () => unknown }).ensureContext();
      masterGain = gains[0];
    });

    it('starts in a non-suspended state', () => {
      expect(engine.isFocusSuspended()).toBe(false);
    });

    it('silences master gain, stops active sources, and blocks new play calls', () => {
      (engine as unknown as { bufferCache: Map<number, AudioBuffer> }).bufferCache.set(1111, {} as AudioBuffer);
      engine.setMasterVolume(0.8);
      engine.play(1111);
      expect(mockSource.start).toHaveBeenCalledTimes(1);
      expect(masterGain.gain.value).toBe(0.8);

      engine.setFocusSuspended(true);

      expect(engine.isFocusSuspended()).toBe(true);
      expect(masterGain.gain.value).toBe(0);
      expect(mockSource.stop).toHaveBeenCalled();

      const startCallsBefore = mockSource.start.mock.calls.length;
      engine.play(1111);
      expect(mockSource.start.mock.calls.length).toBe(startCallsBefore);
    });

    it('restores master gain to the user-configured volume when resumed', () => {
      engine.setMasterVolume(0.5);
      expect(masterGain.gain.value).toBe(0.5);

      engine.setFocusSuspended(true);
      expect(masterGain.gain.value).toBe(0);

      engine.setFocusSuspended(false);
      expect(engine.isFocusSuspended()).toBe(false);
      expect(masterGain.gain.value).toBe(0.5);
    });

    it('preserves user volume changes made while suspended', () => {
      engine.setMasterVolume(0.9);
      expect(masterGain.gain.value).toBe(0.9);

      engine.setFocusSuspended(true);
      expect(masterGain.gain.value).toBe(0);

      engine.setMasterVolume(0.25);
      expect(engine.getMasterVolume()).toBe(0.25);
      expect(masterGain.gain.value).toBe(0);

      engine.setFocusSuspended(false);
      expect(masterGain.gain.value).toBe(0.25);
    });

    it('is idempotent when setting the same state twice', () => {
      (engine as unknown as { bufferCache: Map<number, AudioBuffer> }).bufferCache.set(4444, {} as AudioBuffer);
      engine.play(4444);
      mockSource.stop.mockClear();

      engine.setFocusSuspended(true);
      const firstStopCalls = mockSource.stop.mock.calls.length;

      engine.setFocusSuspended(true);
      expect(mockSource.stop.mock.calls.length).toBe(firstStopCalls);
    });
  });

  describe('metronome', () => {
    type MockGain = {
      gain: { value: number };
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    };
    let gains: MockGain[];
    let sources: Array<typeof mockSource>;

    beforeEach(() => {
      gains = [];
      sources = [];
      mockContext.createGain = vi.fn(() => {
        const gain = { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
        gains.push(gain);
        return gain;
      });
      mockContext.createBufferSource = vi.fn(() => {
        const source = { ...mockSource, connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), stop: vi.fn() };
        sources.push(source);
        return source;
      });
      Object.assign(mockContext, {
        sampleRate: 48_000,
        createBuffer: vi.fn((_channels: number, length: number) => ({ length, copyToChannel: vi.fn() })),
      });
    });

    // ensureContext creates master, sfx, area, then metronome gains.
    const masterGain = () => gains[0];
    const metronomeGain = () => gains[3];

    it('routes beats through its own gain into master, bypassing the sfx channel', () => {
      engine.setSfxVolume(0);
      engine.setMetronomeVolume(0.4);

      engine.playMetronomeBeat('tick');

      expect(metronomeGain().connect).toHaveBeenCalledWith(masterGain());
      expect(metronomeGain().gain.value).toBe(0.4);
      expect(sources).toHaveLength(1);
      expect(sources[0].connect).toHaveBeenCalledWith(metronomeGain());
      expect(sources[0].start).toHaveBeenCalledOnce();
    });

    it.each([
      ['metronome volume is 0', () => engine.setMetronomeVolume(0)],
      ['master volume is 0', () => engine.setMasterVolume(0)],
      ['focus is suspended', () => engine.setFocusSuspended(true)],
    ])('stays silent when %s', (_label, silence) => {
      silence();

      engine.playMetronomeBeat('tick');

      expect(sources).toHaveLength(0);
    });

    it('drops beats while the context is suspended instead of queueing them for later', () => {
      mockContext.state = 'suspended';
      engine.playMetronomeBeat('tick');
      expect(sources).toHaveLength(0);

      mockContext.state = 'running';
      mockContext.currentTime += 0.05;
      engine.playMetronomeBeat('tick');
      expect(sources).toHaveLength(1);
    });

    it('never throws into tick dispatch when audio cannot start', () => {
      Object.assign(mockContext, {
        createBuffer: vi.fn(() => {
          throw new Error('no buffer');
        }),
      });
      expect(() => engine.playMetronomeBeat('tick')).not.toThrow();

      vi.stubGlobal('AudioContext', undefined);
      const noAudio = new AudioEngine();
      expect(() => noAudio.playMetronomeBeat('tick')).not.toThrow();
    });

    it('plays one beat for a burst of ticks in the same instant', () => {
      engine.playMetronomeBeat('tick');
      engine.playMetronomeBeat('tock');
      mockContext.currentTime += 0.6;
      engine.playMetronomeBeat('tick');

      expect(sources).toHaveLength(2);
    });

    it('does not count beats toward the game-sound voice cap', () => {
      for (let beat = 0; beat < MAX_SIMULTANEOUS_SOUNDS + 1; beat++) {
        engine.playMetronomeBeat('tick');
        mockContext.currentTime += 0.6;
      }
      engine.stopAll();

      for (const source of sources) expect(source.stop).not.toHaveBeenCalled();
    });
  });
});
