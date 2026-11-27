import { describe, expect, it, vi } from 'vitest';
import { AudioEngine } from '../../../audio/AudioEngine';
import { EventAudioPlayer } from '../../../audio/EventAudioPlayer';
import { FrameSoundTracker } from '../../../audio/FrameSoundTracker';
import { solHereditAudioRules } from '../../../audio/solHereditAudioRules';
import type { EncounterContext } from '../../../core/encounters/types';
import {
  type EncounterGraphicCue,
  type EncounterVisualEvent,
  isEncounterVisualEvent,
} from '../../../core/events/encounterVisual';
import { CHAT_HIGHLIGHT_COLORS } from '../../../core/events/gameMessages';
import { TickEvents } from '../../../core/events/TickEvents';
import { type CoreGameEvent, isCoreEvent } from '../../../core/events/types';
import { SimulationEngine } from '../../../core/SimulationEngine';
import {
  COLOSSEUM_SEQS,
  COLOSSEUM_SPOTANIMS,
  MOLTEN_SAND_LOC_ID,
  SOL_ACTOR_ID,
  SOLARFLARE_NPC_ID,
} from '../../../npcs/colosseum/constants';
import { GRAPPLE_TARGETS, grappleWarningMessage } from '../../../npcs/colosseum/grapple';
import { createQueue, type NpcMesh3DCommand } from '../../../render/core/commands';
import { FLOOR_EFFECT_DEPTH_BIAS } from '../../../render/effects/spotAnimRenderPolicy';
import { type SceneObjectLocModelLoader, SceneObjectRenderer } from '../../../render/graphics/SceneObjectRenderer';
import type { SceneObjectFrameContext } from '../../../render/graphics/sceneObjectTypes';
import { CLIENT_TICK_MS, type FrameClipRef, type NpcAnimationSet } from '../../../render/npc/animationTypes';
import { NpcAnimationController } from '../../../render/npc/NpcAnimationController';
import type { LocMeshData } from '../../../rs/config/loctype/LocModelLoader';
import { SeqSoundEffect, SeqType } from '../../../rs/config/seqtype/SeqType';
import { createEncounterActorOps } from '../../../test/helpers/encounterActorOps';
import { runEncounterNpcActions } from '../../../test/helpers/encounterNpcBand';
import { createUnusedPlayerControlOps } from '../../../test/helpers/playerControlStubs';
import type { SimulationState } from '../../../types/simulation';
import { LobbyEncounter } from '../../lobby/LobbyEncounter';
import { SOL_BOUNDARY_WARRIORS } from '../arenaBoundary';
import { SOL_BEAM_PREPARED_EVENT, SOL_ENTRY_MESSAGE_TICK, SOL_OPENING_TAUNT_TICK } from '../constants';
import { SOL_OPENING_TAUNT, SOL_PHASE_TRANSITIONS, solVictoryTaunt } from '../phases';
import { SOL_HEREDIT_RENDER_CONFIG } from '../renderConfig';
import { SolHereditEncounter } from '../SolHereditEncounter';
import { MOLTEN_SAND_DESPAWN_SEQ_ID, SolHereditSceneObjectController } from '../SolHereditSceneObjectController';

/**
 * Sol's presentation is not decoration: his attacks ARE their telegraphs, and the grapple taunt
 * names the slot the player has to defend. These assert the encounter actually publishes them.
 */

type GameMessageEvent = Extract<CoreGameEvent, { type: 'game_message' }>;

interface RunResult {
  readonly overheadTexts: string[];
  readonly overheadTicks: { readonly tick: number; readonly text: string }[];
  readonly gameMessages: GameMessageEvent[];
  readonly visualEvents: ReturnType<typeof collectVisuals>;
  readonly snapshotSandTiles: readonly (readonly number[])[];
  readonly beamPreparations: { readonly tick: number; readonly fireInTicks: number }[];
}

function collectVisuals(events: readonly ReturnType<SimulationEngine['getLastTickEvents']>[number][]) {
  return events.filter(isEncounterVisualEvent);
}

/** Drives a real engine, damaging Sol so the phase transitions fire. */
function runFight(ticks = 200): RunResult {
  const encounter = new SolHereditEncounter(7);
  const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
  engine.setMechanicsConfig({ infiniteHealth: true });
  const world = engine['worldState'];
  const sol = world.getNpcs().find((npc) => npc.id === SOL_ACTOR_ID);
  if (!sol) throw new Error('Sol did not spawn');

  const overheadTexts: string[] = [];
  const overheadTicks: RunResult['overheadTicks'] = [];
  const gameMessages: GameMessageEvent[] = [];
  const visualEvents: ReturnType<typeof collectVisuals> = [];
  let snapshotSandTiles: readonly (readonly number[])[] = [];
  const beamPreparations: RunResult['beamPreparations'] = [];

  for (let tick = 0; tick < ticks; tick++) {
    if (tick > 0 && tick % 4 === 0 && sol.vitals.hp > 1) {
      sol.vitals.hp = Math.max(1, sol.vitals.hp - 40);
    }
    engine.advanceTick(engine.getState().playerPosition);
    const events = engine.getLastTickEvents();
    for (const event of events) {
      if (isCoreEvent(event, 'overhead_text')) {
        overheadTexts.push(event.overheadText);
        overheadTicks.push({ tick: event.tick, text: event.overheadText });
      }
      if (isCoreEvent(event, 'game_message')) gameMessages.push(event);
      if (event.type === SOL_BEAM_PREPARED_EVENT && typeof event.fireInTicks === 'number')
        beamPreparations.push({ tick: event.tick, fireInTicks: event.fireInTicks });
    }
    visualEvents.push(...collectVisuals(events));
    const snapshot = engine.getState().encounter;
    if (snapshot?.kind === 'sol_heredit' && snapshot.state.sandTiles.length > 0) {
      snapshotSandTiles = snapshot.state.sandTiles;
    }
  }
  return { overheadTexts, overheadTicks, gameMessages, visualEvents, snapshotSandTiles, beamPreparations };
}

describe('Sol Heredit overhead speech', () => {
  const result = runFight();

  it('opens the fight with his footwork taunt', () => {
    expect(result.overheadTexts[0]).toBe(SOL_OPENING_TAUNT);
  });

  it('says every phase transition taunt in order', () => {
    const transitionTaunts = SOL_PHASE_TRANSITIONS.map((transition) => transition.taunt);
    const said = result.overheadTexts.filter((text) => transitionTaunts.includes(text));
    expect(said).toEqual(transitionTaunts);
  });

  it('anchors the taunt to Sol so it renders above his head', () => {
    const encounter = new SolHereditEncounter(7);
    const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
    engine.setMechanicsConfig({ infiniteHealth: true });
    const events: ReturnType<SimulationEngine['getLastTickEvents']> = [];
    for (let tick = 0; tick < 5; tick++) {
      engine.advanceTick(engine.getState().playerPosition);
      events.push(...engine.getLastTickEvents());
    }
    const overhead = events.filter((event) => isCoreEvent(event, 'overhead_text'));
    expect(overhead).toHaveLength(1);
    for (const event of overhead) {
      if (!isCoreEvent(event, 'overhead_text')) continue;
      expect(event.anchor).toEqual({ kind: 'actor', actorId: SOL_ACTOR_ID });
    }
  });
});

describe('Sol Heredit chat messages', () => {
  const result = runFight();
  const taunts = [SOL_OPENING_TAUNT, ...SOL_PHASE_TRANSITIONS.map((transition) => transition.taunt)];

  it('announces the fight in red on the first simulated tick (L:3446)', () => {
    expect(result.gameMessages[0]).toMatchObject({
      tick: SOL_ENTRY_MESSAGE_TICK,
      kind: 'game',
      segments: [{ text: 'Sol Heredit jumps down from his seat...', color: CHAT_HIGHLIGHT_COLORS.red }],
    });
  });

  it('says every taunt in public chat on the tick it shows overhead', () => {
    const publicChat = result.gameMessages
      .filter((message) => message.kind === 'public')
      .map((message) => ({ tick: message.tick, speaker: message.speaker, segments: message.segments }));
    const overhead = result.overheadTicks.filter((said) => taunts.includes(said.text));
    expect(overhead.map((said) => said.text)).toEqual(taunts);
    expect(overhead[0].tick).toBe(SOL_OPENING_TAUNT_TICK);
    expect(publicChat).toEqual(
      overhead.map((said) => ({ tick: said.tick, speaker: 'Sol Heredit', segments: [{ text: said.text }] })),
    );
  });

  it('marks up the warning as captured: red highlight, white body part, plain red tail', () => {
    const hands = GRAPPLE_TARGETS.find((target) => target.slot === 'hands');
    if (!hands) throw new Error('no hands target');
    expect(grappleWarningMessage(hands)).toEqual([
      { text: 'Sol Heredit: ' },
      { text: "I'LL TWIST YOUR ", color: CHAT_HIGHLIGHT_COLORS.red },
      { text: 'HANDS', color: '#ffffff' },
      { text: ' OFF!', color: '#ff0000' },
    ]);
  });

  it('says his dying words in public chat at death+1', () => {
    const encounter = new SolHereditEncounter(7);
    const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
    const world = engine['worldState'];
    const sol = world.getNpcs().find((npc) => npc.id === SOL_ACTOR_ID);
    if (!sol) throw new Error('Sol did not spawn');
    const context: EncounterContext = {
      tick: 7,
      playerPos: engine.getState().playerPosition,
      world,
      tickEvents: new TickEvents(),
      logEvent: () => {},
      grantNextAttackSpeedup: () => {},
      ...createEncounterActorOps(world),
      ...createUnusedPlayerControlOps(),
    };
    sol.vitals.hp = 0;
    sol.alive = false;
    encounter.onNpcDefeated({ npcId: sol.id, tick: 7 }, context, 'encounter-owned');
    runEncounterNpcActions(encounter, { ...context, tick: 8 }, {});
    expect(context.tickEvents.flush().filter((event) => isCoreEvent(event, 'game_message'))).toEqual([
      expect.objectContaining({ kind: 'public', speaker: 'Sol Heredit', segments: [{ text: solVictoryTaunt(7) }] }),
    ]);
  });
});

describe('Sol Heredit visual cues', () => {
  const fightTicks = 200;
  const result = runFight(fightTicks);

  it('emits a telegraph animation for his regular attacks', () => {
    const clips = result.visualEvents.flatMap((event) => event.animations.map((cue) => cue.clipId));
    expect(clips).toContain('spear');
    expect(clips.some((clip) => clip === 'shield')).toBe(true);
    for (const event of result.visualEvents) {
      for (const cue of event.animations) expect(cue.actorId).toBeTruthy();
    }
  });

  it('paints a ground effect on every tile a regular attack will damage', () => {
    const melee = new Set<number>(COLOSSEUM_SPOTANIMS.solMelee);
    const burst = result.visualEvents.find((event) => event.graphics.some((cue) => melee.has(cue.spotAnimId)));
    expect(burst).toBeDefined();
    // Sol's smallest recorded burst still covers his own footprint and the row ahead of it.
    expect(burst?.graphics.length).toBeGreaterThan(20);
  });

  it('ripples the ground effect outward at two cycles per ring', () => {
    const melee = new Set<number>(COLOSSEUM_SPOTANIMS.solMelee);
    const burst = result.visualEvents.find((event) => event.graphics.some((cue) => melee.has(cue.spotAnimId)));
    const delays = [...new Set((burst?.graphics ?? []).map((cue) => cue.delayCycles))].sort((a, b) => a - b);
    expect(delays[0]).toBe(0);
    // Every delay is an even number of cycles, and they step by two.
    for (const delay of delays) expect(delay % 2).toBe(0);
  });

  it('marks each molten sand strike with the sunfire lightning effect', () => {
    const lightning = result.visualEvents.filter((event) =>
      event.graphics.some((cue) => cue.spotAnimId === COLOSSEUM_SPOTANIMS.sunfireLightning),
    );
    expect(lightning.length).toBeGreaterThan(0);
  });

  // Through the dispatcher, each emitted batch: one molten sand pair per burst however many tiles it
  // lit, and one area sound per fired beam's terminal impact, played at once (K:4077), never per segment.
  it('sounds each sand burst once and each terminal beam impact once, without delay', () => {
    const audio = new AudioEngine();
    const played = vi.spyOn(audio, 'play').mockImplementation(() => undefined);
    const player = new EventAudioPlayer(audio, solHereditAudioRules);
    const isSand = (cue: EncounterGraphicCue) => cue.spotAnimId === COLOSSEUM_SPOTANIMS.sunfireLightning;
    const isImpact = (cue: EncounterGraphicCue) => cue.spotAnimId === COLOSSEUM_SPOTANIMS.crystalImpact;
    let bursts = 0;
    let impacts = 0;
    for (const event of result.visualEvents) {
      played.mockClear();
      const ends = event.graphics.filter(isImpact).map(({ target }) => {
        if (target.kind !== 'tile') throw new Error('Expected a beam impact on a tile');
        return target.position;
      });
      // Heard from the impacts' midpoint, which every one of them is in range of.
      const listener: [number, number] = ends.length
        ? [ends.reduce((sum, [x]) => sum + x, 0) / ends.length, ends.reduce((sum, [, y]) => sum + y, 0) / ends.length]
        : [30, 30];
      for (const [x, y] of ends) expect(Math.abs(x - listener[0]) + Math.abs(y - listener[1])).toBeLessThan(20);

      player.onEvents([event], listener);

      const sand = event.graphics.some(isSand);
      expect(played.mock.calls.map(([id, options]) => [id, options?.delayMs])).toEqual([
        ...(sand
          ? [
              [8053, 30 * CLIENT_TICK_MS],
              [10046, 90 * CLIENT_TICK_MS],
            ]
          : []),
        ...ends.map(() => [8230, undefined]),
      ]);
      if (sand) bursts++;
      impacts += ends.length;
    }
    expect(bursts).toBeGreaterThan(1);
    expect(impacts).toBeGreaterThan(1);
  });

  it('warns only on ticks Sol starts an attack, so each beam charges as that attack lands', () => {
    const solAttackTicks = new Set(
      result.visualEvents
        .filter((event) => event.animations.some((cue) => cue.actorId === SOL_ACTOR_ID))
        .map((event) => event.tick),
    );
    expect(result.beamPreparations.length).toBeGreaterThan(1);
    for (const warning of result.beamPreparations) expect(solAttackTicks.has(warning.tick)).toBe(true);
  });

  it('warns three ticks before every charge with the ticks until that round fires', () => {
    const ticksWith = (ids: readonly number[]) =>
      result.visualEvents
        .filter((event) => event.graphics.some((cue) => ids.includes(cue.spotAnimId)))
        .map((event) => event.tick);
    const charges = ticksWith(COLOSSEUM_SPOTANIMS.crystalCharge);
    const fires = ticksWith(COLOSSEUM_SPOTANIMS.crystalFire);
    expect(charges.length).toBeGreaterThan(1);
    // A warning in the last three ticks announces a charge the run ends before.
    const warnedCharges = result.beamPreparations.map((warning) => warning.tick + 3);
    expect(warnedCharges.filter((tick) => tick < fightTicks)).toEqual(charges);
    for (const warning of result.beamPreparations) {
      const fire = fires.find((tick) => tick > warning.tick);
      if (fire !== undefined) expect(warning.tick + warning.fireInTicks).toBe(fire);
    }
  });
});

describe('molten sand pools', () => {
  it('renders all 48 collision boundary warriors from the initial frame through death with aids disabled', () => {
    const controller = new SolHereditSceneObjectController();
    const initial = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatSeed: 1 }).getState();
    const state: SimulationState = {
      ...initial,
      mechanicsConfig: { ...initial.mechanicsConfig, solHereditTelegraph: false, solHereditSand: false },
    };
    const context = { currentTick: 0, interpolatedTick: 0, state, terrainHeights: null };
    const guards = controller.update(context);
    expect(guards).toHaveLength(48);
    expect(new Set(guards.map((spec) => spec.id)).size).toBe(48);
    expect(
      guards.map(
        (spec) =>
          spec.data && {
            locId: spec.data.locId,
            localX: spec.data.localX,
            localY: spec.data.localY,
            rotation: spec.data.rotation,
            type: spec.data.modelType,
            level: spec.data.level,
          },
      ),
    ).toEqual(SOL_BOUNDARY_WARRIORS);
    for (const guard of guards) {
      expect(guard.classification).toBe('sceneMesh');
      expect(guard.lifecycle).toEqual({ kind: 'sync' });
      expect(guard.data?.seqId).toBe(-1);
    }
    expect(
      controller.update({
        ...context,
        currentTick: 20,
        state: { ...state, npcs: state.npcs.map((npc) => ({ ...npc, alive: false })) },
      }),
    ).toEqual(guards);
  });
  it('renders one holy-fire LOC per pooled tile, with ids stable across frames', () => {
    const controller = new SolHereditSceneObjectController();
    const initial = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatSeed: 1 }).getState();
    if (initial.encounter.kind !== 'sol_heredit') throw new Error('wrong snapshot');
    const state: SimulationState = {
      ...initial,
      encounter: {
        ...initial.encounter,
        state: {
          ...initial.encounter.state,
          sandTiles: [
            [30, 33],
            [31, 34],
          ],
        },
      },
    };
    const context: SceneObjectFrameContext<SimulationState> = {
      currentTick: 5,
      interpolatedTick: 5,
      state,
      terrainHeights: null,
    };

    const first = controller.update(context).filter((spec) => spec.id.startsWith('sol-sand-'));
    expect(first).toHaveLength(2);
    expect(first.map((spec) => spec.id)).toEqual(['sol-sand-30-33', 'sol-sand-31-34']);
    for (const spec of first) {
      expect(spec.classification).toBe('groundDecal');
      expect(spec.style?.depthBias).toBe(FLOOR_EFFECT_DEPTH_BIAS);
      expect(spec.data?.locId).toBe(MOLTEN_SAND_LOC_ID);
      expect(spec.lifecycle).toEqual({ kind: 'sync' });
    }
    // Same tiles next frame means the same spec ids, so the baked mesh is reused.
    expect(
      controller
        .update(context)
        .filter((spec) => spec.id.startsWith('sol-sand-'))
        .map((spec) => spec.id),
    ).toEqual(first.map((spec) => spec.id));
  });

  it('plays the despawn on every pool while Sol is dying, keeping their ids (K:4221, M:8512, N:7781, L:5833)', () => {
    const controller = new SolHereditSceneObjectController();
    const initial = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatSeed: 1 }).getState();
    if (initial.encounter.kind !== 'sol_heredit') throw new Error('wrong snapshot');
    const encounter = initial.encounter;
    const pools = (sandDespawning: boolean) =>
      controller
        .update({
          currentTick: 5,
          interpolatedTick: 5,
          state: {
            ...initial,
            encounter: { ...encounter, state: { ...encounter.state, sandTiles: [[30, 33]], sandDespawning } },
          },
          terrainHeights: null,
        })
        .filter((spec) => spec.id.startsWith('sol-sand-'));
    expect(pools(false).map((spec) => [spec.id, spec.data?.seqId])).toEqual([['sol-sand-30-33', -1]]);
    expect(pools(true).map((spec) => [spec.id, spec.data?.seqId])).toEqual([
      ['sol-sand-30-33', MOLTEN_SAND_DESPAWN_SEQ_ID],
    ]);
    expect(MOLTEN_SAND_DESPAWN_SEQ_ID).toBe(10814);
  });

  it('shows the same despawn frame at death+1 whether played through or seeked to, and drops the pools at death+2', () => {
    const encounter = new SolHereditEncounter(7);
    const engine = new SimulationEngine({ encounter, combatRandom: () => 0.5 });
    engine.setMechanicsConfig({ infiniteHealth: true, solHereditAttacks: false, solHereditBeams: false });
    const world = engine['worldState'];
    const sol = world.getNpcs().find((npc) => npc.id === SOL_ACTOR_ID);
    if (!sol) throw new Error('Sol did not spawn');
    engine.executeEncounterCommand({ encounter: 'sol_heredit', type: 'strike-sand' });
    const deathTick = 7;
    while (engine.getState().currentTick < deathTick) engine.advanceTick(engine.getState().playerPosition);
    const context: EncounterContext = {
      tick: deathTick,
      playerPos: engine.getState().playerPosition,
      world,
      tickEvents: new TickEvents(),
      logEvent: () => {},
      grantNextAttackSpeedup: () => {},
      ...createEncounterActorOps(world),
      ...createUnusedPlayerControlOps(),
    };
    // Recorded frames, as a replay holds them: the last live tick, then D, D+1 and D+2.
    const frames = new Map<number, SimulationState>([[deathTick - 1, engine.getState()]]);
    sol.vitals.hp = 0;
    sol.alive = false;
    encounter.onNpcDefeated({ npcId: sol.id, tick: deathTick }, context, 'encounter-owned');
    for (let tick = deathTick; tick <= deathTick + 2; tick++) {
      runEncounterNpcActions(encounter, { ...context, tick }, {});
      frames.set(tick, { ...engine.getState(), currentTick: tick });
    }
    const atDeath = frames.get(deathTick)?.encounter;
    if (atDeath?.kind !== 'sol_heredit') throw new Error('wrong snapshot');
    expect(atDeath.state.sandTiles.length).toBeGreaterThan(0);

    // Seq 10814: 15 frames of 4 client ticks, so one game tick (30 client ticks) in is frame 7.
    const despawn = new SeqType(MOLTEN_SAND_DESPAWN_SEQ_ID, {
      name: 'test',
      game: 'oldschool',
      environment: 'test',
      revision: 232,
      timestamp: '',
      size: 0,
    });
    despawn.frameIds = Array.from({ length: 15 }, (_, frame) => frame);
    despawn.frameLengths = despawn.frameIds.map(() => 4);
    const meshFrame = (frame: number): LocMeshData => ({
      mesh: {
        positions: new Float32Array([-64, 0, -64, 64, 0, -64, -64, 0, 64]),
        normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]),
      },
      hslColors: new Float32Array([1, 2, 3]),
      alphas: new Float32Array([1, 1, 1]),
      faceBias: new Float32Array([frame, frame, frame]),
      hasTransparency: false,
    });
    const loader: SceneObjectLocModelLoader = {
      loadLocMesh: (locId, _modelType, _rotation, worldX, worldY, worldZ) => {
        if (locId !== MOLTEN_SAND_LOC_ID) return undefined;
        const { mesh, hslColors, alphas } = meshFrame(-1);
        return { locId, mesh, hslColors, alphas, worldX, worldY, worldZ, sizeX: 1, sizeY: 1 };
      },
      loadAnimatedLocMeshFrames: (locId, _modelType, _rotation, seqId) =>
        locId === MOLTEN_SAND_LOC_ID && seqId === MOLTEN_SAND_DESPAWN_SEQ_ID
          ? { frames: despawn.frameIds.map(meshFrame), seqType: despawn }
          : undefined,
      loadLocType: () => ({ sizeX: 1, sizeY: 1, contouredGround: -1 }),
    };
    const show = (renderer: SceneObjectRenderer, tick: number, interpolatedTick = tick) => {
      const state = frames.get(tick);
      if (!state) throw new Error(`no frame at ${tick}`);
      const controller = new SolHereditSceneObjectController();
      renderer.sync(controller.update({ currentTick: tick, interpolatedTick, state, terrainHeights: null }), tick);
      const queue = createQueue();
      renderer.render(queue, tick, interpolatedTick);
      // The scene-object renderer only emits LOC meshes; each frame's face bias is its index.
      return queue.commands.map((command) => (command as NpcMesh3DCommand).perVertexFaceBias?.[0]);
    };
    const pools = atDeath.state.sandTiles.length;

    const played = new SceneObjectRenderer(loader);
    show(played, deathTick - 1);
    expect(show(played, deathTick)).toEqual(Array(pools).fill(0));
    show(played, deathTick, deathTick + 0.5);
    const playedAtD1 = show(played, deathTick + 1);
    expect(playedAtD1).toEqual(Array(pools).fill(7));

    // A seek straight to D+1 must land mid-despawn rather than restart it at frame 0.
    const seeked = new SceneObjectRenderer(loader);
    show(seeked, deathTick - 1);
    seeked.resetTimeline();
    expect(show(seeked, deathTick + 1)).toEqual(playedAtD1);
    expect(show(seeked, deathTick + 1, deathTick + 1.9)).toEqual(Array(pools).fill(14));

    expect(show(played, deathTick + 2)).toEqual([]);
    expect(show(seeked, deathTick + 2)).toEqual([]);

    // Without a recorded outcome the renderer keeps its old anchor: the tick it first sees the despawn.
    const unrecorded = new SceneObjectRenderer(loader);
    const d1 = frames.get(deathTick + 1);
    if (!d1) throw new Error('no D+1 frame');
    frames.set(deathTick + 1, { ...d1, encounterOutcome: { phase: 'active' } });
    expect(show(unrecorded, deathTick + 1)).toEqual(Array(pools).fill(0));
  });

  it('returns nothing for another encounter snapshot', () => {
    const controller = new SolHereditSceneObjectController();
    const state = new SimulationEngine({ encounter: new LobbyEncounter(), combatSeed: 1 }).getState();
    expect(
      controller.update({
        currentTick: 0,
        interpolatedTick: 0,
        state,
        terrainHeights: null,
      }),
    ).toEqual([]);
  });

  it('starts pools only when published and removes them when cleared', () => {
    const controller = new SolHereditSceneObjectController();
    const initial = new SimulationEngine({ encounter: new SolHereditEncounter(7), combatSeed: 1 }).getState();
    if (initial.encounter.kind !== 'sol_heredit') throw new Error('wrong snapshot');
    const context = { currentTick: 5, interpolatedTick: 5, state: initial, terrainHeights: null };
    expect(controller.update(context).filter((spec) => spec.id.startsWith('sol-sand-'))).toEqual([]);
    const pooled: SimulationState = {
      ...initial,
      encounter: {
        ...initial.encounter,
        state: { ...initial.encounter.state, sandTiles: [[30, 33]] },
      },
    };
    expect(
      controller.update({ ...context, state: pooled }).filter((spec) => spec.id.startsWith('sol-sand-')),
    ).toHaveLength(1);
    expect(controller.update({ ...context, currentTick: 6 }).filter((spec) => spec.id.startsWith('sol-sand-'))).toEqual(
      [],
    );
  });
});

describe('Sol Heredit audio rules', () => {
  const resolve = (event: EncounterVisualEvent) => {
    const rule = solHereditAudioRules.encounter_visual;
    if (typeof rule.resolve !== 'function') throw new TypeError('expected a resolver');
    return rule.resolve(event);
  };

  it('plays the molten sand pair once per burst, however many tiles lit', () => {
    const result = resolve({
      type: 'encounter_visual',
      eventId: 1,
      tick: 10,
      animations: [],
      projectiles: [],
      graphics: [30, 31, 32].map((x) => ({
        spotAnimId: COLOSSEUM_SPOTANIMS.sunfireLightning,
        target: { kind: 'tile', position: [x, 33] },
        delayCycles: 0,
        height: 0,
      })),
    });
    expect(result.kind).toBe('play');
    expect(result.kind === 'play' && result.sound).toHaveLength(2);
  });

  it('stays silent for an event with no Sol-attributable effect', () => {
    const result = resolve({
      type: 'encounter_visual',
      eventId: 2,
      tick: 10,
      animations: [{ actorId: SOL_ACTOR_ID, clipId: 'spear', delayCycles: 0 }],
      projectiles: [],
      graphics: [],
    });
    expect(result.kind).toBe('silent');
  });
});

describe('solar flare stand animation', () => {
  /** Cache seq 10817 (disk-2485): 41 frames, loop back 21 frames, flare-up sound on frame 1. */
  const FLARE_SOUND_ID = 7980;
  const LOOP_START_FRAME = 20;

  function standClip(id: string): FrameClipRef {
    const seqId = COLOSSEUM_SEQS.solarflare.idle;
    const seqType = new SeqType(seqId, {
      name: 'test',
      game: 'oldschool',
      environment: 'test',
      revision: 232,
      timestamp: '',
      size: 0,
    });
    seqType.frameIds = Array.from({ length: 41 }, (_, frame) => frame);
    seqType.frameLengths = seqType.frameIds.map((frame) => (frame < LOOP_START_FRAME ? 3 : 4));
    seqType.frameStep = 21;
    seqType.frameSounds = new Map([[1, [new SeqSoundEffect(FLARE_SOUND_ID, 1, 8, 4)]]]);
    return { kind: 'frame', id, seqId, seqType, frameIds: seqType.frameIds, frameLengths: seqType.frameLengths };
  }

  /** The set `NpcInstanceManager.loadNpcType` builds: the cache walk seq for 12826 is also 10817. */
  function solarflareAnimationSet(): NpcAnimationSet {
    const config = SOL_HEREDIT_RENDER_CONFIG.preloadNpcTypes?.find((type) => type.npcTypeId === SOLARFLARE_NPC_ID);
    const walkSeqId = config?.walkSeqId ?? COLOSSEUM_SEQS.solarflare.idle;
    return {
      idle: standClip('idle'),
      idlePlayMode: config?.idlePlayMode,
      ...(walkSeqId === -1 ? {} : { walk: standClip('walk') }),
    };
  }

  it('flares up once on spawn, never again while idling or crawling', () => {
    const controller = new NpcAnimationController({
      animationSet: solarflareAnimationSet(),
      modelAdapter: {
        resetPose: () => {},
        applyFrame: () => {},
        applyFrameInterleaved: () => {},
        applySkeletal: () => {},
        resize: () => {},
        commitPose: () => {},
      },
    });
    const play = vi.fn();
    const tracker = new FrameSoundTracker({ play } as unknown as AudioEngine);
    const frames: number[] = [];

    // 40 game ticks (several loops) of a crawl that alternates moving and stationary ticks.
    for (let clientTick = 0; clientTick < 40 * 30; clientTick++) {
      controller.update({
        deltaMs: CLIENT_TICK_MS,
        speedMultiplier: 1,
        turn: { isTurning: false, turnDeltaSigned: 0 },
        movement: { isMoving: Math.floor(clientTick / 30) % 2 === 1 },
      });
      const state = controller.getFrameState();
      if (!state) throw new Error('solar flare has no frame state');
      frames.push(state.currentFrameIndex);
      tracker.update(
        [
          {
            actorId: 'flare',
            seqId: state.seqId,
            currentFrame: state.currentFrameIndex,
            seqType: state.seqType,
            position: [0, 0],
          },
        ],
        [0, 0],
      );
    }

    expect(play.mock.calls.filter(([id]) => id === FLARE_SOUND_ID)).toHaveLength(1);
    const introEnd = frames.indexOf(40);
    expect(introEnd).toBeGreaterThan(0);
    expect(Math.min(...frames.slice(introEnd))).toBe(LOOP_START_FRAME);
  });
});
