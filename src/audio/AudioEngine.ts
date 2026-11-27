import { log } from '../util/Logger';
import { MAX_SIMULTANEOUS_SOUNDS } from './constants';
import { type MetronomeBeat, synthesizeMetronomeBeat } from './metronomeSound';
import type { SoundPlayOptions } from './types';

export type AudioChannel = 'sfx' | 'area';

/**
 * Where a sound's PCM comes from. Resolving `null` marks the sound unavailable: it is not requested
 * again, and playing it is a silent no-op.
 */
export type SoundBufferLoader = (soundId: number) => Promise<AudioBuffer | null>;

/** No sound source is wired in: every sound is unavailable, so nothing is fetched or rendered. */
export const NO_SOUND_BUFFERS: SoundBufferLoader = async () => null;

// The synth renders 22,050 Hz mono, so the whole catalog (ALL_SOUND_IDS at cache 2772: 286
// sounds) is ~29 MiB of Float32 PCM. The budget holds all of it without within-fight eviction and
// leaves room for the catalog to roughly double before eviction starts.
const DEFAULT_DECODED_CACHE_BUDGET_BYTES = 64 * 1024 * 1024;

/** Game-sound PCM the loader produced; excludes the synthesized metronome buffers. */
export interface AudioCacheStats {
  readonly retainedBytes: number;
  readonly retainedSounds: number;
  /** Buffers the loader produced, including reloads after eviction. */
  readonly decodeCount: number;
  readonly pendingDecodes: number;
  readonly budgetBytes: number;
}

export interface SoundPlayEvent {
  eventId: number;
  soundId: number;
  trigger: string;
  timestamp: number;
}

type BufferedVoice = {
  readonly buffer: AudioBuffer;
  readonly channel: AudioChannel;
  readonly volume: number;
  readonly offset: number;
};

type ActiveVoice = BufferedVoice & {
  readonly startTime: number;
  readonly soundGain: GainNode;
};

type PausedVoice = BufferedVoice & {
  readonly remainingDelay: number;
};

export class AudioEngine {
  private disposed = false;
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private areaGain: GainNode | null = null;
  private metronomeGain: GainNode | null = null;
  private metronomeBuffers: Record<MetronomeBeat, AudioBuffer> | null = null;
  private lastMetronomeBeatTime = Number.NEGATIVE_INFINITY;
  private metronomeFailureLogged = false;
  private bufferCache = new Map<number, AudioBuffer>();
  private retainedDecodedBytes = 0;
  private decodeCount = 0;
  private failedLoads = new Set<number>();
  private activeSources = new Map<AudioBufferSourceNode, ActiveVoice>();
  private pausedVoices: PausedVoice[] = [];
  private playbackPaused = false;
  private pendingDecodes = new Map<number, Promise<AudioBuffer | null>>();
  private masterVolume = 1.0;
  private sfxVolumeValue = 1.0;
  private areaVolumeValue = 1.0;
  private metronomeVolumeValue = 1.0;
  private focusSuspended = false;
  private playListeners: Array<(event: SoundPlayEvent) => void> = [];
  private playEventSeq = 0;
  private playEventHistory: SoundPlayEvent[] = [];

  /** The byte budget is soft while voices own buffers; only inactive entries may be evicted. */
  constructor(
    private readonly decodedCacheBudgetBytes = DEFAULT_DECODED_CACHE_BUDGET_BYTES,
    private readonly loadBuffer: SoundBufferLoader = NO_SOUND_BUFFERS,
  ) {
    if (!Number.isFinite(decodedCacheBudgetBytes) || decodedCacheBudgetBytes < 0) {
      throw new RangeError('Decoded audio cache budget must be a finite, non-negative byte count');
    }
  }

  /** Whether the context exists and is running, i.e. a gesture has unlocked audio. */
  isUnlocked(): boolean {
    return this.context?.state === 'running';
  }

  getCacheStats(): AudioCacheStats {
    return {
      retainedBytes: this.retainedDecodedBytes,
      retainedSounds: this.bufferCache.size,
      decodeCount: this.decodeCount,
      pendingDecodes: this.pendingDecodes.size,
      budgetBytes: this.decodedCacheBudgetBytes,
    };
  }

  onSoundPlayed(listener: (event: SoundPlayEvent) => void): () => void {
    this.playListeners.push(listener);
    return () => {
      this.playListeners = this.playListeners.filter((l) => l !== listener);
    };
  }

  private notifyPlayed(soundId: number, trigger: string): void {
    const event: SoundPlayEvent = {
      eventId: ++this.playEventSeq,
      soundId,
      trigger,
      timestamp: Date.now(),
    };
    this.playEventHistory = [event, ...this.playEventHistory].slice(0, 200);
    if (this.playListeners.length === 0) return;
    this.playListeners = this.playListeners.filter((listener) => {
      try {
        listener(event);
        return true;
      } catch {
        return false;
      }
    });
  }

  getRecentSoundEvents(limit: number = 50): SoundPlayEvent[] {
    const normalized = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;
    return this.playEventHistory.slice(0, normalized);
  }

  private ensureContext(): AudioContext {
    if (this.context === null) {
      if (typeof AudioContext === 'undefined') {
        throw new Error('[AudioEngine] AudioContext is not available in this environment');
      }
      const context = new AudioContext();
      const masterGain = context.createGain();
      const sfxGain = context.createGain();
      const areaGain = context.createGain();
      const metronomeGain = context.createGain();

      sfxGain.connect(masterGain);
      areaGain.connect(masterGain);
      metronomeGain.connect(masterGain);
      masterGain.connect(context.destination);

      masterGain.gain.value = this.focusSuspended ? 0 : this.masterVolume;
      sfxGain.gain.value = this.sfxVolumeValue;
      areaGain.gain.value = this.areaVolumeValue;
      metronomeGain.gain.value = this.metronomeVolumeValue;

      this.context = context;
      this.masterGain = masterGain;
      this.sfxGain = sfxGain;
      this.areaGain = areaGain;
      this.metronomeGain = metronomeGain;
    }

    return this.context;
  }

  async resume(): Promise<void> {
    if (this.disposed) return;
    if (typeof AudioContext === 'undefined') {
      return;
    }
    const context = this.ensureContext();
    if (context.state === 'suspended') {
      await context.resume();
      if (this.disposed) return;
    }
  }

  async loadSound(id: number): Promise<AudioBuffer | null> {
    if (this.disposed) return null;
    const cached = this.bufferCache.get(id);
    if (cached) return cached;
    if (this.failedLoads.has(id)) return null;
    return this.requestBuffer(id).catch(() => null);
  }

  async preloadSounds(ids: number[]): Promise<void> {
    await Promise.all(ids.map(async (id) => this.loadSound(id)));
  }

  private playGeneration = 0;

  play(soundId: number, options?: SoundPlayOptions, trigger?: string): void {
    if (this.disposed || this.playbackPaused) return;
    if (this.masterVolume <= 0) return;
    if (this.focusSuspended) return;

    const playGeneration = this.playGeneration;

    const channel = options?.channel ?? 'sfx';
    const channelVolume = channel === 'area' ? this.areaVolumeValue : this.sfxVolumeValue;
    if (channelVolume <= 0) return;

    const buffer = this.bufferCache.get(soundId);
    if (!buffer) {
      if (this.failedLoads.has(soundId)) return;
      // Load a sound not yet preloaded and play it once it arrives, for every caller that asked:
      // they share one load, and each keeps its own options.
      this.requestBuffer(soundId).then(
        (loaded) => {
          if (!loaded || this.disposed || playGeneration !== this.playGeneration) return;
          this.play(soundId, options, trigger);
        },
        () => {},
      );
      return;
    }

    // LRU tracks playback, not voice completion.
    this.bufferCache.delete(soundId);
    this.bufferCache.set(soundId, buffer);

    if (trigger) {
      this.notifyPlayed(soundId, trigger);
    }

    if (this.activeSources.size >= MAX_SIMULTANEOUS_SOUNDS) {
      const [oldest] = this.activeSources;
      if (oldest) this.stopVoice(...oldest);
    }

    const context = this.ensureContext();
    this.startVoice(
      { buffer, channel, volume: clamp(options?.volume ?? 1.0, 0, 1), offset: 0 },
      context.currentTime + Math.max(0, options?.delayMs ?? 0) / 1000,
    );
    this.trimDecodedCache();
  }

  /**
   * One load per sound at a time; a sound the loader resolves `null` for is marked unavailable, and
   * a rejected load is retried on the next request. Callers chain onto the loader's own promise, so
   * every waiting play starts in the same turn the buffer is cached.
   */
  private requestBuffer(soundId: number): Promise<AudioBuffer | null> {
    const pending = this.pendingDecodes.get(soundId);
    if (pending) return pending;

    const load = this.loadBuffer(soundId);
    this.pendingDecodes.set(soundId, load);
    load.then(
      (buffer) => {
        if (!this.disposed) {
          if (buffer) {
            this.bufferCache.set(soundId, buffer);
            this.retainedDecodedBytes += decodedBytes(buffer);
            this.decodeCount++;
          } else {
            this.failedLoads.add(soundId);
          }
        }
        // Wait for play continuations before eviction to avoid a load/evict loop under tiny budgets.
        queueMicrotask(() => {
          if (this.pendingDecodes.get(soundId) === load) this.pendingDecodes.delete(soundId);
          this.trimDecodedCache();
        });
      },
      (error: unknown) => {
        if (this.pendingDecodes.get(soundId) === load) this.pendingDecodes.delete(soundId);
        console.warn(`[AudioEngine] Failed to load sound ${soundId}`, error);
      },
    );
    return load;
  }

  private trimDecodedCache(): void {
    if (this.retainedDecodedBytes <= this.decodedCacheBudgetBytes) return;
    const protectedBuffers = new Set<AudioBuffer>();
    for (const voice of this.activeSources.values()) protectedBuffers.add(voice.buffer);
    for (const voice of this.pausedVoices) protectedBuffers.add(voice.buffer);
    for (const [soundId, buffer] of this.bufferCache) {
      if (this.retainedDecodedBytes <= this.decodedCacheBudgetBytes) break;
      // Scheduled sources and paused voices still own their PCM.
      if (protectedBuffers.has(buffer) || this.pendingDecodes.has(soundId)) continue;
      this.bufferCache.delete(soundId);
      this.retainedDecodedBytes -= decodedBytes(buffer);
    }
  }

  /**
   * Plays a synthesized metronome beat on its own channel, which feeds master
   * but not the sound-effect channel. A beat lasts ~120 ms, so it is not tracked
   * for pause/resume and never evicts a game sound from the voice cap.
   *
   * Best-effort: it runs inside the simulation's tick dispatch, so it never throws.
   */
  playMetronomeBeat(beat: MetronomeBeat): void {
    if (this.disposed || this.playbackPaused || this.focusSuspended) return;
    if (this.masterVolume <= 0 || this.metronomeVolumeValue <= 0) return;
    if (typeof AudioContext === 'undefined') return;

    try {
      const context = this.ensureContext();
      const metronomeGain = this.metronomeGain;
      // A suspended context would queue the beat and play it late, whenever audio next unlocks.
      if (context.state !== 'running' || !metronomeGain) return;
      // Tutorial fast-forward publishes many ticks in one frame; one beat is enough.
      if (context.currentTime - this.lastMetronomeBeatTime < MIN_METRONOME_BEAT_GAP_S) return;
      this.lastMetronomeBeatTime = context.currentTime;

      this.metronomeBuffers ??= {
        tick: createMonoBuffer(context, synthesizeMetronomeBeat('tick', context.sampleRate)),
        tock: createMonoBuffer(context, synthesizeMetronomeBeat('tock', context.sampleRate)),
      };
      const source = context.createBufferSource();
      source.buffer = this.metronomeBuffers[beat];
      source.connect(metronomeGain);
      source.onended = () => source.disconnect();
      source.start();
    } catch (error) {
      if (this.metronomeFailureLogged) return;
      this.metronomeFailureLogged = true;
      log.warn('AudioEngine', 'Metronome beat failed', error);
    }
  }

  private startVoice(voice: BufferedVoice, startTime: number): void {
    const context = this.ensureContext();
    const channelGain = voice.channel === 'area' ? this.areaGain : this.sfxGain;
    if (!channelGain) {
      return;
    }

    const source = context.createBufferSource();
    source.buffer = voice.buffer;

    const soundGain = context.createGain();
    soundGain.gain.value = voice.volume;

    source.connect(soundGain);
    soundGain.connect(channelGain);

    source.onended = () => {
      if (!this.activeSources.delete(source)) return;
      source.disconnect();
      soundGain.disconnect();
      this.trimDecodedCache();
    };

    this.activeSources.set(source, { ...voice, startTime, soundGain });
    source.start(startTime, voice.offset);
  }

  private stopVoice(source: AudioBufferSourceNode, voice: ActiveVoice): void {
    this.activeSources.delete(source);
    source.onended = null;
    source.stop();
    source.disconnect();
    voice.soundGain.disconnect();
  }

  pausePlayback(): void {
    if (this.disposed || this.playbackPaused) return;
    this.playbackPaused = true;
    this.playGeneration++;
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const [source, voice] of this.activeSources) {
      const offset = voice.offset + Math.max(0, now - voice.startTime);
      if (offset < voice.buffer.duration) {
        this.pausedVoices.push({
          buffer: voice.buffer,
          channel: voice.channel,
          volume: voice.volume,
          offset,
          remainingDelay: Math.max(0, voice.startTime - now),
        });
      }
      this.stopVoice(source, voice);
    }
    this.trimDecodedCache();
  }

  resumePlayback(): void {
    if (this.disposed || !this.playbackPaused) return;
    this.playbackPaused = false;
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const voice of this.pausedVoices) {
      this.startVoice(voice, now + voice.remainingDelay);
    }
    this.pausedVoices.length = 0;
    this.trimDecodedCache();
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp(v, 0, 1);
    if (this.masterGain && !this.focusSuspended) {
      this.masterGain.gain.value = this.masterVolume;
    }
    if (this.masterVolume <= 0) {
      this.discardSounds();
    }
  }

  setSfxVolume(v: number): void {
    this.sfxVolumeValue = clamp(v, 0, 1);
    if (this.sfxGain) {
      this.sfxGain.gain.value = this.sfxVolumeValue;
    }
  }

  setAreaVolume(v: number): void {
    this.areaVolumeValue = clamp(v, 0, 1);
    if (this.areaGain) {
      this.areaGain.gain.value = this.areaVolumeValue;
    }
  }

  setMetronomeVolume(v: number): void {
    this.metronomeVolumeValue = clamp(v, 0, 1);
    if (this.metronomeGain) {
      this.metronomeGain.gain.value = this.metronomeVolumeValue;
    }
  }

  /**
   * While suspended, master gain is forced to 0 and new play() calls are
   * dropped, but user-facing volume sliders remain untouched.
   */
  setFocusSuspended(suspended: boolean): void {
    if (this.focusSuspended === suspended) return;
    this.focusSuspended = suspended;
    if (this.masterGain) {
      this.masterGain.gain.value = suspended ? 0 : this.masterVolume;
    }
    if (suspended) {
      this.discardSounds();
    }
  }

  isFocusSuspended(): boolean {
    return this.focusSuspended;
  }

  isReady(): boolean {
    return this.context !== null && this.masterGain !== null && this.sfxGain !== null;
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  getSfxVolume(): number {
    return this.sfxVolumeValue;
  }

  getAreaVolume(): number {
    return this.areaVolumeValue;
  }

  /** Start over: discard every sound and lift any pause. */
  stopAll(): void {
    this.discardSounds();
    this.playbackPaused = false;
  }

  /**
   * Stop and forget every sound: playing, held by a pause, or still loading. A pause stays in force,
   * because the mutes that discard sounds do not own it: whoever paused playback (replay transport,
   * a live hold) resumes it, and nothing may play under it before then. Replacing the displayed scene
   * discards its sounds for the same reason.
   */
  discardSounds(): void {
    this.playGeneration++;
    this.pausedVoices.length = 0;
    for (const [source, voice] of this.activeSources) {
      this.stopVoice(source, voice);
    }
    this.trimDecodedCache();
  }

  dispose(): void {
    this.disposed = true;
    this.stopAll();
    this.bufferCache.clear();
    this.retainedDecodedBytes = 0;
    this.failedLoads.clear();
    this.pendingDecodes.clear();
    this.playListeners = [];
    this.playEventHistory = [];

    const context = this.context;
    this.context = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.areaGain = null;
    this.metronomeGain = null;
    this.metronomeBuffers = null;

    if (context) {
      void context.close();
    }
  }
}

const MIN_METRONOME_BEAT_GAP_S = 0.1;

function decodedBytes(buffer: AudioBuffer): number {
  return buffer.length * buffer.numberOfChannels * Float32Array.BYTES_PER_ELEMENT;
}

function createMonoBuffer(context: AudioContext, samples: Float32Array<ArrayBuffer>): AudioBuffer {
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
