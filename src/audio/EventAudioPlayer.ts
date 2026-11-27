import type { GameEvent } from '../core/events/types';
import { type Coordinate, OSRS_TICK_MS } from '../types/simulation';
import type { AudioChannel, AudioEngine } from './AudioEngine';
import { osrsSoundVolume } from './attenuation';
import { MAX_ATTENUATION_RANGE } from './constants';
import type { SoundPlayOptions } from './types';

export interface TimedSound {
  readonly id: number;
  readonly delayCycles?: number;
  /**
   * Overrides the rule's position for THIS sound only. Needed when one event produces
   * impacts on several tiles: Jal-MejJak's spark barrage emits a separate `sound_area`
   * at each of its three blast tiles rather than one at the caster.
   */
  readonly position?: Readonly<Coordinate> | null;
  readonly range?: number;
  readonly channel?: AudioChannel;
}

export type SoundRuleValue = number | TimedSound | Array<number | TimedSound>;

export interface SoundPlayResult {
  readonly kind: 'play';
  readonly sound: SoundRuleValue;
  readonly position?: Readonly<Coordinate>;
  readonly volume?: number;
  readonly range?: number;
  readonly channel?: AudioChannel; // explicit override; default: position ? 'area' : 'sfx'
}

export interface SoundSilent {
  readonly kind: 'silent';
}

export interface SoundPass {
  readonly kind: 'pass';
}

export type SoundResolution = SoundPlayResult | SoundSilent | SoundPass;

export function play(
  sound: SoundRuleValue,
  opts?: { position?: Readonly<Coordinate>; volume?: number; range?: number; channel?: AudioChannel },
): SoundPlayResult {
  return { kind: 'play', sound, ...opts };
}

export const silent: SoundSilent = Object.freeze({ kind: 'silent' });
export const pass: SoundPass = Object.freeze({ kind: 'pass' });

/**
 * Narrow an event's position field to a `Coordinate` for `play({ position })`.
 * Returning `undefined` for a malformed one is what makes the sound fall back to
 * unattenuated instead of throwing mid-tick.
 */
export function coordinateFrom(value: unknown): Coordinate | undefined {
  return Array.isArray(value) && value.length >= 2 && typeof value[0] === 'number' && typeof value[1] === 'number'
    ? [value[0], value[1]]
    : undefined;
}

/**
 * If a mechanic is disabled, the event is never emitted — no downstream gating
 * needed.
 */
export interface SoundRule {
  resolve: SoundRuleValue | ((event: GameEvent) => SoundResolution);
  preloadIds?: number[];
}

export interface SoundRuleLayer {
  readonly name: string;
  readonly rules: Record<string, SoundRule>;
}

type PendingReplaySound = {
  readonly dueTimeMs: number;
  readonly soundId: number;
  readonly options: Readonly<SoundPlayOptions>;
  readonly trigger: string;
};

export class EventAudioPlayer {
  private readonly layers: readonly SoundRuleLayer[];
  private ruleChains: Record<string, SoundRule[]>;
  private replayTimeMs: number | null = null;
  private readonly pendingReplaySounds: PendingReplaySound[] = [];

  constructor(
    private readonly engine: AudioEngine,
    ...layers: SoundRuleLayer[]
  ) {
    this.layers = layers;
    this.ruleChains = ruleChainsOf(layers);
  }

  /**
   * Dispatches events through only the named layers, still in constructor order; `null` restores every
   * layer. Preloading still covers every layer, so a sound can be ready before its layer dispatches.
   */
  setDispatchLayers(names: readonly string[] | null): void {
    if (names === null) {
      this.ruleChains = ruleChainsOf(this.layers);
      return;
    }
    const unknown = names.filter((name) => !this.layers.some((layer) => layer.name === name));
    if (unknown.length > 0) throw new Error(`[EventAudioPlayer] Unknown sound rule layers: ${unknown.join(', ')}`);
    this.ruleChains = ruleChainsOf(this.layers.filter((layer) => names.includes(layer.name)));
  }

  updateReplayClock(timeMs: number | null, paused = false): void {
    this.replayTimeMs = timeMs;
    if (timeMs === null) {
      this.pendingReplaySounds.length = 0;
      return;
    }
    if (paused) return;

    for (
      let cue = this.pendingReplaySounds.at(-1);
      cue && cue.dueTimeMs <= timeMs;
      cue = this.pendingReplaySounds.at(-1)
    ) {
      this.pendingReplaySounds.pop();
      this.engine.play(cue.soundId, cue.options, cue.trigger);
    }
  }

  finishReplay(speedMultiplier: number): void {
    const timeMs = this.replayTimeMs;
    if (timeMs === null) return;

    for (let cue = this.pendingReplaySounds.pop(); cue; cue = this.pendingReplaySounds.pop()) {
      this.engine.play(
        cue.soundId,
        { ...cue.options, delayMs: (cue.dueTimeMs - timeMs) / speedMultiplier },
        cue.trigger,
      );
    }
  }

  onEvents(events: GameEvent[], playerPosition: Coordinate): void {
    for (const event of events) {
      const chain = this.ruleChains[event.type];
      if (!chain) continue;

      for (const handler of chain) {
        const resolved = typeof handler.resolve === 'function' ? handler.resolve(event) : play(handler.resolve);

        if (resolved.kind === 'pass') continue;
        if (resolved.kind === 'silent') break;

        const sounds = normalizeRuleValue(resolved.sound);
        if (sounds.length === 0) break;

        const baseVolume = resolved.volume ?? 1;

        for (const sound of sounds) {
          const soundPosition = sound.position === undefined ? resolved.position : sound.position;
          const range = sound.range ?? resolved.range ?? MAX_ATTENUATION_RANGE;
          const soundVolume = soundPosition
            ? baseVolume * osrsSoundVolume(soundPosition, playerPosition, range)
            : baseVolume;
          if (soundVolume <= 0) continue;
          const delayCycles = sound.delayCycles ?? 0;
          const delayMs = delayCycles > 0 ? delayCycles * CLIENT_CYCLE_MS : undefined;
          const options: SoundPlayOptions = {
            volume: soundVolume,
            channel: sound.channel ?? resolved.channel ?? (soundPosition ? 'area' : 'sfx'),
            ...(this.replayTimeMs === null && delayMs !== undefined ? { delayMs } : {}),
          };
          const trigger = `event:${event.type}`;
          if (this.replayTimeMs !== null && delayMs !== undefined) {
            const dueTimeMs = event.tick * OSRS_TICK_MS + delayMs;
            if (dueTimeMs > this.replayTimeMs) {
              if (
                this.engine.getMasterVolume() <= 0 ||
                this.engine.isFocusSuspended() ||
                (options.channel === 'area' ? this.engine.getAreaVolume() : this.engine.getSfxVolume()) <= 0
              ) {
                continue;
              }
              const index = this.pendingReplaySounds.findIndex((cue) => cue.dueTimeMs <= dueTimeMs);
              this.pendingReplaySounds.splice(index < 0 ? this.pendingReplaySounds.length : index, 0, {
                dueTimeMs,
                soundId: sound.id,
                options,
                trigger,
              });
              continue;
            }
          }
          this.engine.play(sound.id, options, trigger);
        }

        break;
      }
    }
  }

  getAllSoundIds(): number[] {
    const ids = new Set<number>();

    for (const layer of this.layers) {
      for (const handler of Object.values(layer.rules)) {
        if (typeof handler.resolve === 'number') {
          ids.add(handler.resolve);
        } else if (Array.isArray(handler.resolve)) {
          for (const sound of normalizeRuleValue(handler.resolve)) ids.add(sound.id);
        } else if (isTimedSound(handler.resolve)) {
          ids.add(handler.resolve.id);
        }

        if (handler.preloadIds) {
          for (const id of handler.preloadIds) ids.add(id);
        }
      }
    }

    return [...ids];
  }

  async preload(): Promise<void> {
    await this.engine.preloadSounds(this.getAllSoundIds());
  }

  reset(): void {
    this.pendingReplaySounds.length = 0;
    this.replayTimeMs = null;
  }
}

const CLIENT_CYCLE_MS = 20;

/** Each event type's rules across `layers`, in layer order: the first non-`pass` rule wins. */
function ruleChainsOf(layers: readonly SoundRuleLayer[]): Record<string, SoundRule[]> {
  const chains: Record<string, SoundRule[]> = {};
  for (const layer of layers) {
    for (const [eventType, rule] of Object.entries(layer.rules)) {
      const chain = chains[eventType];
      if (chain) chain.push(rule);
      else chains[eventType] = [rule];
    }
  }
  return chains;
}

function isTimedSound(value: unknown): value is TimedSound {
  return typeof value === 'object' && value !== null && 'id' in value;
}

function normalizeRuleValue(value: SoundRuleValue): TimedSound[] {
  const raw = Array.isArray(value) ? value : [value];
  const normalized: TimedSound[] = [];
  for (const entry of raw) {
    if (typeof entry === 'number') {
      normalized.push({ id: entry });
      continue;
    }
    if (!isTimedSound(entry)) {
      console.warn('[EventAudioPlayer] Invalid sound rule entry, skipping:', entry);
      continue;
    }
    normalized.push({
      id: entry.id,
      delayCycles: entry.delayCycles,
      ...(entry.position !== undefined ? { position: entry.position } : {}),
      ...(entry.range !== undefined ? { range: entry.range } : {}),
      ...(entry.channel !== undefined ? { channel: entry.channel } : {}),
    });
  }
  return normalized;
}
