# Audio

Two independent sound paths share one [`AudioEngine`](../../src/audio/AudioEngine.ts). Which ids
play, and the capture evidence for them, is in the [sound-ID audit](audio-sound-ids.md).

## Frame sounds

Sounds baked into cache `SeqType` frames; they never cross the wire, so no packet capture can
confirm or deny one.

- `SeqType.decodeOpcode()` fills `frameSounds` from opcodes 13/14. Skeletal sequences (rev ≥ 226)
  decode opcode 13 as the skeletal id, so their sparse frame sounds come from opcode 14 only; not
  every sequence has any.
- NPC clips carry their `SeqType` on `AnimClipRef.seqType`; the player's `AnimationSequence` does
  not, so `collectActorFrameStates()` looks it up via `loadPlayerSeqType(seqId)`.
- [`FrameSoundTracker`](../../src/audio/FrameSoundTracker.ts) plays the sounds on frames crossed
  since its last per-actor cursor, for actor clips **and spotanim sequences**, so anything the
  renderer animates needs no event rule (adding one double-plays). Located sounds attenuate on the
  `area` channel; others play flat on `sfx`. After a seek, `silentSync()` re-anchors cursors without
  playing.
- Driven by the base `SceneCompositor.build()` once per frame, after the final pose, for every scene
  built with a tracker (`configureEncounterScene`). A paused, discontinuous or rebuilt frame only
  calls `silentSync()`. NPC clips and encounter effects reach `extracted-frame-sounds.json` through
  `scripts/extract-frame-sounds.ts`, which collects every seq the render configs declare
  (`collectDeclaredNpcSeqIds`) and the sequence of every effect they declare
  (`collectDeclaredSpotAnimIds`); `frameSoundManifest.test.ts` fails when either is missing.

## Event sounds

The base `SceneCompositor.build()` forwards each frame's unprocessed events to
[`EventAudioPlayer`](../../src/audio/EventAudioPlayer.ts) (not while replay is paused).
[`useAudioManager`](../../src/hooks/useAudioManager.ts) builds the player with every encounter's rules
(`encounterAudioRules()`, each a row's optional `audioRules` in [`presentationModules.ts`](../../src/encounters/presentationModules.ts))
and the core rules last, so preloading covers every sound. Only the displayed encounter's rules and
core's dispatch: `useEventAudioScope` resolves the displayed kind's presentation module (a variant
resolves to its parent's) and hands the player those rules, then core's (`setDispatchRules`), and a
change of displayed encounter drops the old scene's queued replay sounds. Lookup stops at the first rule that returns something other than
`pass`, so an encounter can override a core sound, but never another encounter's. Zuk's rules and gating decisions are in
[Zuk policy: presentation](../encounters/zuk-policy.md#presentation).

Shape rules from the captures:

- `synth_sound` is non-positional, full volume, `sfx` channel. Only `sound_area` (a rule passing
  `position`) is attenuated, on the `area` channel. Most combat sounds are the former.
- `delay` is in client cycles (30 = 1 tick) and belongs on the rule, not rounded away.
- Attenuation ([`attenuation.ts`](../../src/audio/attenuation.ts)) is linear over Manhattan distance
  with one tile forgiven, out to the sound's own `range`. A Euclidean stand-in keeps diagonal sources
  audible past the cutoff. The curve is our approximation, not sourced.

## Replay cue timing

During replay `EventAudioPlayer` uses `ReplayTimeline.timeMs` (game-relative replay time, not the
geometry tick clamped at the final pose). Delayed sounds get deadlines from event tick plus delay in
an ordered pending array, so a frame with no due sound is a constant-time check. Live sounds keep
the Web Audio delay path.

- Ordinary pause keeps future onsets and calls `AudioEngine.pausePlayback()`, which stops native
  sources but retains buffer offsets / remaining start delays; `resumePlayback()` recreates sources
  from them without copying buffers, suspending the context, a RAF loop, or duplicate play events.
  Continuation shares the 32-voice cap.
- Seek, exit, timeline replacement, master mute, focus mute and disposal discard pending cues and
  continuation. A cue muted at launch is not queued for unmuting; loads/decodes from before a pause
  cannot start after it.
- On natural completion, remaining onsets go to `AudioEngine` with remaining delay ÷ playback speed,
  after the renderer acknowledges the final playhead. Seeking into a sound that never played does
  not reconstruct it.

## AudioEngine

- The `AudioContext` is created on the first `play()` (user-gesture requirement).
- Sounds come from a `SoundBufferLoader` and are loaded on first use. The app's loader renders them
  from the runtime game cache ([sound-effect synthesizer](audio-synth.md)). A sound the loader
  reports unavailable is not requested again; a failed load is retried on the next play.
- `playGeneration` bumps on every `stopAll()` / `dispose()`, so an in-flight load or decode never
  starts after a seek, pause or exit.
- Gain chain: per-sound gain → `sfx`/`area` → master → destination. `MAX_SIMULTANEOUS_SOUNDS` = 32.
- Settings `masterVolume`, `sfxVolume`, `areaVolume` (0–1) and `muteWhenUnfocused` persist via
  `usePersistedSettings`; master 0 stops all sources immediately.

No audio files ship. Each sound is synthesized in the browser from its cache index-4 patch by
[`src/audio/synth/`](../../src/audio/synth/); subtle filter or envelope differences from the native
client may remain. OSRS has no stereo panning.
