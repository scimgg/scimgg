/**
 * Recordings in the encounter visual-event wire shapes of main at 49ef532: `inferno_visual`,
 * `colosseum_visual`, `inferno_clear_minions`, and Yama's semantic events plus snapshot.
 *
 * Every event below is written out by hand. Never regenerate one from an encounter's emitter: these
 * stand for recordings already exported, so they must keep their old shape when the emitters change.
 * Only each frame's base simulation state comes from a fresh engine; the fields the presentation
 * reads (tick, NPCs, encounter snapshot fields) are set explicitly.
 *
 * Each recording goes through `ReplayRecorder.load`, the intake every loaded recording takes.
 */
import { isYamaSnapshot } from '../../core/encounters/snapshot';
import type { GameEvent } from '../../core/events/types';
import {
  DEFAULT_REPLAY_UI_STATE,
  type ReplayDisplayFrame,
  type ReplayFrame,
  ReplayRecorder,
  type ReplayRecorderData,
} from '../../core/ReplayRecorder';
import { SimulationEngine } from '../../core/SimulationEngine';
import { SolHereditEncounter } from '../../encounters/solHeredit/SolHereditEncounter';
import { YamaEncounter } from '../../encounters/yamaP3/YamaEncounter';
import { freshReplayCapture } from '../../replay/format/capture';
import type { Coordinate, NpcState, SimulationState } from '../../types/simulation';
import { createZukWaveEncounter } from './zukWave';

export type LegacyRecording = {
  readonly data: ReplayRecorderData;
  /** The display frames `ReplayRecorder.load` published, frame index = tick. */
  readonly frames: readonly ReplayDisplayFrame[];
};

export function legacyNpc(
  id: string,
  npcTypeId: number,
  position: Readonly<Coordinate>,
  size: number,
  overrides: Partial<NpcState> = {},
): NpcState {
  return {
    id,
    npcTypeId,
    archetypeId: 'legacy',
    role: 'minion',
    alive: true,
    position: [position[0], position[1]],
    previousPosition: [position[0], position[1]],
    facingAngle: 0,
    size,
    hp: 10,
    maxHp: 10,
    spawnTick: 0,
    history: new Map(),
    ...overrides,
  };
}

function load(frames: readonly ReplayFrame[], runConfig: ReplayRecorderData['runConfig']): LegacyRecording {
  const data: ReplayRecorderData = {
    frames,
    cursorSamples: [],
    cursorClicks: [],
    presentationSamples: [],
    viewportSamples: [],
    modifierSamples: [],
    damageHistory: [],
    runConfig,
    capture: freshReplayCapture(),
  };
  const recorder = new ReplayRecorder();
  recorder.load(data);
  return { data, frames: recorder.getDisplayFrames() };
}

/** The player standing still on `tile` all tick. */
function standingAt(
  tile: Readonly<Coordinate>,
): Pick<SimulationState, 'playerPosition' | 'playerPreviousPosition' | 'playerMovementPath'> {
  return { playerPosition: [tile[0], tile[1]], playerPreviousPosition: [tile[0], tile[1]], playerMovementPath: [] };
}

function frame(state: SimulationState, events: readonly GameEvent[]): ReplayFrame {
  return {
    tick: state.currentTick,
    startMs: state.currentTick * 600,
    input: [...state.playerPosition],
    state,
    uiState: DEFAULT_REPLAY_UI_STATE,
    events: [...events],
    actions: [],
    damageHistoryLength: 0,
  };
}

// --- The Inferno (shipped config: no primary NPC) ---------------------------------------------

export const LEGACY_INFERNO = {
  nibbler: { id: 'nib', npcTypeId: 7691, position: [20, 20], size: 1 },
  mager: { id: 'mager', npcTypeId: 7699, position: [30, 30], size: 4 },
  /** Dies on tick 3 and is pruned from the snapshot on tick 4; its corpse lasts 90 cycles. */
  healer: { id: 'healer', npcTypeId: 7701, position: [24, 22], size: 1, deathTick: 3 },
  /** Dies on tick 6, pruned on tick 7, then removed by type on tick 8. */
  clearedHealer: { id: 'healer-2', npcTypeId: 7701, position: [26, 22], size: 1, deathTick: 6 },
  /** Wave 69's intro adds Zuk at C-8 (tick 2) while his spawn tick is control C (tick 10). */
  zuk: { id: 'zuk', npcTypeId: 7706, position: [28, 52], size: 7, addTick: 2, controlTick: 10 },
  playerTile: [26, 26],
  lastTick: 9,
} as const;

/**
 * Hand-written `inferno_visual` batches. Ids and ordinals matter: they were each cue's identity.
 * Clip ids are render-config `attackClips` keys; delays are client cycles from the event tick.
 */
export const LEGACY_INFERNO_EVENTS = {
  /** Tick 1: the nibbler's swing, held 20 cycles (starts at cycle 50). */
  delayedClip: {
    type: 'inferno_visual',
    eventId: 11,
    tick: 1,
    animations: [{ actorId: 'nib', clipId: 'attack', delayCycles: 20 }],
    projectiles: [],
    graphics: [],
  },
  /** Tick 2: Zuk rises at the intro's add, C-8. */
  zukRise: {
    type: 'inferno_visual',
    eventId: 21,
    tick: 2,
    animations: [{ actorId: 'zuk', clipId: 'rise', delayCycles: 0 }],
    projectiles: [],
    graphics: [],
  },
  /** Tick 2: two flights and three graphics, one per anchor kind. */
  barrage: {
    type: 'inferno_visual',
    eventId: 22,
    tick: 2,
    animations: [{ actorId: 'mager', clipId: 'magic', delayCycles: 0 }],
    projectiles: [
      // A tile-targeted flight, airborne cycles [70, 130).
      {
        spotAnimId: 660,
        sourcePosition: [32, 32],
        target: { kind: 'tile', position: [20, 26] },
        startDelayCycles: 10,
        endDelayCycles: 70,
        slope: 16,
        startOffset: 64,
        startHeight: 70,
        endHeight: 0,
      },
      // A homing flight onto the nibbler, airborne cycles [60, 120).
      {
        spotAnimId: 1375,
        sourcePosition: [32, 32],
        target: { kind: 'actor', actorId: 'nib', size: 1, position: [10, 10] },
        startDelayCycles: 0,
        endDelayCycles: 60,
        slope: 0,
        startOffset: 0,
        startHeight: 100,
        endHeight: 40,
      },
    ],
    graphics: [
      // A tile spark landing: cycles [63, 123) with the 60-cycle fixture graphic.
      { spotAnimId: 659, target: { kind: 'tile', position: [25, 25] }, delayCycles: 3, height: 0 },
      // A tracked actor that is present: drawn on its rendered center, not the recorded [18, 18].
      {
        spotAnimId: 444,
        target: { kind: 'actor', actorId: 'nib', size: 1, position: [18, 18] },
        delayCycles: 30,
        height: 150,
      },
      // A tracked actor that never renders: drawn on the recorded fallback's center.
      {
        spotAnimId: 448,
        target: { kind: 'actor', actorId: 'absent', size: 2, position: [22, 26] },
        delayCycles: 120,
        height: 256,
      },
    ],
  },
  /** Tick 8: the pruned `healer-2` corpse's type is cleared before its corpse would end. */
  clearMinions: { type: 'inferno_clear_minions', eventId: 81, tick: 8, npcTypeIds: [7701] },
} as const satisfies Record<string, GameEvent>;

export function legacyInfernoRecording(): LegacyRecording {
  const engine = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 1 });
  const base = engine.getState();
  const { nibbler, mager, healer, clearedHealer, zuk } = LEGACY_INFERNO;
  const events: Record<number, GameEvent[]> = {
    1: [LEGACY_INFERNO_EVENTS.delayedClip],
    2: [LEGACY_INFERNO_EVENTS.zukRise, LEGACY_INFERNO_EVENTS.barrage],
    8: [LEGACY_INFERNO_EVENTS.clearMinions],
  };
  const corpse = (actor: typeof healer | typeof clearedHealer, tick: number) =>
    tick > actor.deathTick
      ? []
      : [
          legacyNpc(
            actor.id,
            actor.npcTypeId,
            actor.position,
            actor.size,
            tick === actor.deathTick ? { alive: false, hp: 0, despawnTick: actor.deathTick } : {},
          ),
        ];
  const frames = Array.from({ length: LEGACY_INFERNO.lastTick + 1 }, (_, tick) => {
    if (base.encounter.kind !== 'inferno') throw new TypeError('Expected an Inferno snapshot');
    const state: SimulationState = {
      ...base,
      ...standingAt(LEGACY_INFERNO.playerTile),
      currentTick: tick,
      npcs: [
        legacyNpc(nibbler.id, nibbler.npcTypeId, nibbler.position, nibbler.size),
        legacyNpc(mager.id, mager.npcTypeId, mager.position, mager.size),
        ...corpse(healer, tick),
        ...corpse(clearedHealer, tick),
        ...(tick >= zuk.addTick
          ? [legacyNpc(zuk.id, zuk.npcTypeId, zuk.position, zuk.size, { role: 'boss', spawnTick: zuk.controlTick })]
          : []),
      ],
      encounter: { ...base.encounter, visuals: { ...base.encounter.visuals, zukControlTick: zuk.controlTick } },
    };
    return frame(state, events[tick] ?? []);
  });
  return load(frames, engine.getRunConfig());
}

// --- Sol Heredit (primary NPC) -----------------------------------------------------------------

export const LEGACY_SOL = {
  /** SOL_ACTOR_ID: Sol is the render config's primary NPC. */
  actorId: 'sol_heredit',
  lastTick: 6,
  playerTile: [20, 20],
} as const;

/** Hand-written `colosseum_visual` batches. Graphic ordinals were each cue's identity. */
export const LEGACY_SOL_EVENTS = {
  /** Tick 1: a shield telegraph held 12 cycles (starts at cycle 42), and a three-tile sand burst. */
  telegraph: {
    type: 'colosseum_visual',
    eventId: 101,
    tick: 1,
    animations: [{ actorId: 'sol_heredit', clipId: 'shield', delayCycles: 12 }],
    graphics: [
      { spotAnimId: 2698, position: [28, 30], delayCycles: 0 },
      { spotAnimId: 2698, position: [29, 30], delayCycles: 2 },
      { spotAnimId: 2698, position: [30, 30], delayCycles: 4 },
    ],
  },
  /** Tick 2: one graphic attached to Sol, one to an actor that never renders, and a seer's cast. */
  attached: {
    type: 'colosseum_visual',
    eventId: 201,
    tick: 2,
    animations: [],
    graphics: [
      { spotAnimId: 2668, actorId: 'sol_heredit', delayCycles: 6, height: 64 },
      { spotAnimId: 2667, actorId: 'absent', delayCycles: 6 },
      { spotAnimId: 131, actorId: 'player', delayCycles: 30, height: 124 },
    ],
    projectiles: [
      {
        spotAnimId: 130,
        sourcePosition: [20.5, 21.5],
        target: { kind: 'actor', actorId: 'player', size: 1, position: [20, 20] },
        startDelayCycles: 10,
        endDelayCycles: 30,
        slope: 16,
        startOffset: 64,
        startHeight: 172,
        endHeight: 124,
      },
    ],
  },
  /** Tick 3: two fired beams, three segments each, each with its terminal impact beyond. */
  beams: {
    type: 'colosseum_visual',
    eventId: 301,
    tick: 3,
    animations: [],
    graphics: [
      { spotAnimId: 2695, position: [24, 20], delayCycles: 3, height: 128 },
      { spotAnimId: 2695, position: [24, 21], delayCycles: 6, height: 128 },
      { spotAnimId: 2695, position: [24, 22], delayCycles: 9, height: 128 },
      { spotAnimId: 2697, position: [24, 23], delayCycles: 9, height: 128 },
      { spotAnimId: 2696, position: [22, 23], delayCycles: 3, height: 128 },
      { spotAnimId: 2696, position: [23, 23], delayCycles: 6, height: 128 },
      { spotAnimId: 2696, position: [24, 23], delayCycles: 9, height: 128 },
      { spotAnimId: 2697, position: [25, 23], delayCycles: 9, height: 128 },
    ],
  },
} as const satisfies Record<string, GameEvent>;

export function legacySolRecording(): LegacyRecording {
  const engine = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatSeed: 1 });
  const base = engine.getState();
  const events: Record<number, GameEvent[]> = {
    1: [LEGACY_SOL_EVENTS.telegraph],
    2: [LEGACY_SOL_EVENTS.attached],
    3: [LEGACY_SOL_EVENTS.beams],
  };
  const frames = Array.from({ length: LEGACY_SOL.lastTick + 1 }, (_, tick) =>
    frame({ ...base, ...standingAt(LEGACY_SOL.playerTile), currentTick: tick }, events[tick] ?? []),
  );
  return load(frames, engine.getRunConfig());
}

// --- Yama P3 (semantic events plus snapshot) ---------------------------------------------------

export const LEGACY_YAMA = {
  /** A magic attack on tick 10 and a melee attack on tick 13, as the snapshot records them. */
  magicTick: 10,
  meleeTick: 13,
  lastTick: 16,
  /** Fixed here: a fresh Yama run lands the player on a random tile. */
  playerTile: [33, 36],
} as const;

export const LEGACY_YAMA_EVENTS = {
  magic: {
    type: 'attack_started',
    eventId: 1001,
    tick: 10,
    sourceId: 'yama',
    targetId: 'player',
    style: 'magic',
    attackKind: 'magic_fire',
  },
  fireballs: { type: 'fireball_spawned', eventId: 1002, tick: 10 },
  wave: { type: 'wave_activated', eventId: 1003, tick: 11 },
} as const satisfies Record<string, GameEvent>;

export function legacyYamaRecording(): LegacyRecording {
  const engine = new SimulationEngine({ encounter: new YamaEncounter(), combatSeed: 1 });
  const base = engine.getState();
  const snapshot = base.encounter;
  if (!isYamaSnapshot(snapshot)) throw new TypeError('Expected a Yama snapshot');
  const events: Record<number, GameEvent[]> = {
    10: [LEGACY_YAMA_EVENTS.magic, LEGACY_YAMA_EVENTS.fireballs],
    11: [LEGACY_YAMA_EVENTS.wave],
  };
  const frames = Array.from({ length: LEGACY_YAMA.lastTick + 1 }, (_, tick) => {
    const attack =
      tick >= LEGACY_YAMA.meleeTick
        ? { lastAttackTick: LEGACY_YAMA.meleeTick, lastAttackKind: 'melee_crush' as const }
        : tick >= LEGACY_YAMA.magicTick
          ? { lastAttackTick: LEGACY_YAMA.magicTick, lastAttackKind: 'magic_fire' as const }
          : {};
    return frame(
      {
        ...base,
        ...standingAt(LEGACY_YAMA.playerTile),
        currentTick: tick,
        encounter: { ...snapshot, state: { ...snapshot.state, ...attack } },
      },
      events[tick] ?? [],
    );
  });
  return load(frames, engine.getRunConfig());
}
