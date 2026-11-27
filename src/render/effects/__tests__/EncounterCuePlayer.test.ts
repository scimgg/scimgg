import { afterEach, describe, expect, it } from 'vitest';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import {
  type EncounterVisualEvent,
  isEncounterVisualEvent,
  type NpcProjectileCue,
} from '../../../core/events/encounterVisual';
import type { ReplayDisplayFrame } from '../../../core/ReplayRecorder';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { createZukWaveEncounter } from '../../../test/helpers/zukWave';
import type { Coordinate } from '../../../types/simulation';
import type { RenderQueue } from '../../core/commands';
import { ReplayEffectIndex } from '../../core/replayEffectIndex';
import { makeSnapshot } from '../../npc/__tests__/npcFacingTestHarness';
import type { SurfaceHeightResolver } from '../controllers/ProjectileController';
import { EncounterCuePlayer } from '../EncounterCuePlayer';
import { advanceProjectileMotion } from '../projectileMotion';
import { SpotAnimRenderer } from '../SpotAnimRenderer';
import type { SpotAnimTransform } from '../spotAnimTypes';

type History = { readonly frames: readonly ReplayDisplayFrame[]; readonly throughFrameIndex: number };

/** The cue player as a scene drives it from a history: one shared effect index per history. */
class ReplayedCuePlayer extends EncounterCuePlayer {
  private readonly indexes = new WeakMap<readonly ReplayDisplayFrame[], ReplayEffectIndex>();

  /** A seek, new history or restore: everything held is rebuilt for the destination. */
  reconstruct(history: History, frame: { readonly cycle: number }): void {
    this.syncReplay(this.indexOf(history), { cycle: frame.cycle, throughFrameIndex: history.throughFrameIndex }, true);
  }

  /** A continuing replay frame: cues already playing keep their state. */
  syncHistory(history: History, frame: { readonly cycle: number }): void {
    this.syncReplay(this.indexOf(history), { cycle: frame.cycle, throughFrameIndex: history.throughFrameIndex }, false);
  }

  private indexOf(history: History): ReplayEffectIndex {
    let index = this.indexes.get(history.frames);
    if (!index) {
      index = new ReplayEffectIndex(history.frames);
      this.indexes.set(history.frames, index);
    }
    index.extend();
    return index;
  }
}

function fixture(resolveSurfaceHeight?: SurfaceHeightResolver) {
  const renderer = new SpotAnimRenderer();
  for (const spotAnimId of [1375, 1376, 1377, 448, 449, 450, 660, 444, 451]) {
    renderer['meshCache'].set(spotAnimId, {
      static: [
        {
          meshId: `effect-${spotAnimId}`,
          materialId: 'osrs-npc',
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
          depth: 'readwrite',
        },
      ],
      frames: [],
      frameLengths: [2, 3, 5],
      frameStep: 2,
      heightOffset: 999,
    });
  }
  const controller = new ReplayedCuePlayer(renderer);
  let target: Coordinate | null = [10, 5];
  let attachment: SpotAnimTransform | null = null;
  const heights = Array.from({ length: 65 }, () => new Int32Array(65).fill(-128));
  const update = (cycle: number) => {
    controller.update({
      cycle,
      resolveActor: () => target,
      resolveAttachment: () => attachment,
      terrainHeights: heights,
      resolveSurfaceHeight,
    });
    renderer.tick(Math.floor(cycle / 30), cycle / 30);
    const queue: RenderQueue = { replayPresentationReady: true, commands: [] };
    renderer.render(queue);
    return queue.commands.flatMap((command) =>
      command.kind === 'mesh3d'
        ? [
            {
              id: command.meshId,
              matrix: Array.from(command.modelMatrix),
            },
          ]
        : [],
    );
  };
  return {
    renderer,
    heights,
    controller,
    update,
    move: (position: Coordinate | null) => {
      target = position;
    },
    /** The rendered model an `attached` graphic rides, or null while its actor is not drawn. */
    attach: (transform: SpotAnimTransform | null) => {
      attachment = transform;
    },
  };
}

const projectile: NpcProjectileCue = {
  spotAnimId: 1375,
  sourcePosition: [2, 5.5],
  target: { kind: 'actor', actorId: 'player', size: 1, position: [10, 5] },
  startDelayCycles: 0,
  endDelayCycles: 24,
  slope: 0,
  startOffset: 64,
  startHeight: 390,
  endHeight: 124,
};

function event(overrides: Partial<EncounterVisualEvent> = {}): EncounterVisualEvent {
  return {
    type: 'encounter_visual',
    eventId: 1,
    tick: 0,
    animations: [],
    projectiles: [projectile],
    graphics: [],
    ...overrides,
  };
}

function realZukBall() {
  const engine = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 1 });
  const initial = engine.getState();
  engine.reset([40, 46]);
  engine.setMechanicsConfig({ zukSets: false, infiniteHealth: true });
  for (let tick = 0; tick < 40; tick++) {
    engine.advanceTick([40, 46]);
    const emitted = engine
      .getLastTickEvents()
      .filter(isEncounterVisualEvent)
      .find((event) => event.projectiles.some((cue) => cue.spotAnimId === 1375));
    if (!emitted) continue;
    const cue = emitted.projectiles.find((cue) => cue.spotAnimId === 1375);
    if (!cue) expect.fail('Expected real Zuk ball cue');
    return { initial, state: engine.getState(), emitted, cue, base: emitted.tick * 30 };
  }
  return expect.fail('Expected the engine to emit a Zuk ball');
}

afterEach(() => {
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
});

describe('EncounterCuePlayer', () => {
  it('aims a new real Zuk ball at the live player after reconstructed history hands off', () => {
    const { initial, emitted, cue, base } = realZukBall();
    expect(cue.sourcePosition).toEqual([31.5, 55.5]);
    expect(cue.target).toMatchObject({ kind: 'actor', actorId: 'player', position: [40, 46] });
    const restored = fixture();
    const live = fixture();
    restored.controller.reconstruct({ frames: [{ state: initial, events: [] }], throughFrameIndex: 0 }, { cycle: 0 });
    restored.update(0);
    restored.controller.consumeEvents([]);
    for (const scene of [restored, live]) {
      scene.move([40, 46]);
      scene.controller.consumeEvents([emitted]);
    }
    const start = base + cue.startDelayCycles;
    for (const cycle of [start, start + 1, start + 10]) expect(restored.update(cycle)).toEqual(live.update(cycle));
    const motion = [...restored.controller['flights']['flights'].values()][0]?.runtime['motion'];
    if (!motion) expect.fail('Expected initialized Zuk ball');
    expect(motion.velocity.x).toBeGreaterThan(0);
    const arrival = advanceProjectileMotion(motion, base + cue.endDelayCycles - (start + 10));
    expect(arrival.position.x).toBeCloseTo(40.5, 12);
    expect(arrival.position.y).toBeCloseTo(46.5, 12);
  });

  it('preserves an airborne real Zuk ball and its motion phase while switching to live homing', () => {
    const { state, emitted, cue, base } = realZukBall();
    const restored = fixture();
    const live = fixture();
    const start = base + cue.startDelayCycles;
    const handoff = start + 5;
    live.move(state.playerPosition);
    live.controller.consumeEvents([emitted]);
    for (let cycle = start; cycle <= handoff; cycle++) live.update(cycle);
    restored.move(state.playerPosition);
    restored.controller.reconstruct(
      { frames: [{ state, events: [emitted] }], throughFrameIndex: 0 },
      { cycle: handoff },
    );
    expect(restored.update(handoff)).toEqual(live.update(handoff));
    const [id, flight] = [...restored.controller['flights']['flights'].entries()][0];
    const motion = flight.runtime['motion'];
    const rendererInstance = restored.renderer['activeInstances'].get(id);
    restored.controller.consumeEvents([]);
    expect(restored.controller['flights']['flights'].get(id)).toBe(flight);
    expect(flight.runtime['motion']).toBe(motion);
    expect(flight.runtime['cycle']).toBe(handoff);
    expect(restored.renderer['activeInstances'].get(id)).toBe(rendererInstance);
    expect(restored.update(handoff)).toEqual(live.update(handoff));
    for (const scene of [restored, live]) scene.move([42, 45]);
    for (const cycle of [handoff + 1, handoff + 7.5]) expect(restored.update(cycle)).toEqual(live.update(cycle));
    const moved = flight.runtime['motion'];
    if (!moved) expect.fail('Expected airborne Zuk ball');
    const arrival = advanceProjectileMotion(moved, base + cue.endDelayCycles - (handoff + 7.5));
    expect(arrival.position.x).toBeCloseTo(42.5, 12);
    expect(arrival.position.y).toBeCloseTo(45.5, 12);
  });

  it('still respects the historical actor cutoff for a real Zuk ball during replay', () => {
    const { state, emitted, cue, base } = realZukBall();
    const frames: ReplayDisplayFrame[] = [
      { state, events: [emitted] },
      {
        state: {
          ...state,
          currentTick: state.currentTick + 1,
          playerPosition: [10, 20],
          playerPreviousPosition: [10, 20],
          playerMovementPath: [],
        },
        events: [],
      },
    ];
    const scene = fixture();
    scene.move([50, 50]);
    const cycle = base + Math.max(cue.startDelayCycles + 1, 31);
    const sample = (throughFrameIndex: number) => {
      scene.controller.reconstruct({ frames, throughFrameIndex }, { cycle: cycle });
      scene.update(cycle);
      const motion = [...scene.controller['flights']['flights'].values()][0]?.runtime['motion'];
      if (!motion) expect.fail('Expected historical Zuk ball');
      return advanceProjectileMotion(motion, base + cue.endDelayCycles - cycle).position;
    };
    expect(sample(0)).toMatchObject({ x: expect.closeTo(40.5, 12), y: expect.closeTo(46.5, 12) });
    expect(sample(1)).toMatchObject({ x: expect.closeTo(10.5, 12), y: expect.closeTo(20.5, 12) });
  });

  it('reaches the target at packet endtime when a delayed blast launches on a nonzero tick', () => {
    const { controller, update } = fixture();
    controller.consumeEvents([
      event({ tick: 2, projectiles: [{ ...projectile, startDelayCycles: 50, endDelayCycles: 126 }] }),
    ]);
    update(110);
    const motion = [...controller['flights']['flights'].values()][0]?.runtime['motion'];
    if (!motion) expect.fail('Expected initialized flight');

    const arrival = advanceProjectileMotion(motion, 126 - 50);

    expect(arrival.position.x).toBeCloseTo(10.5, 12);
    expect(arrival.position.y).toBeCloseTo(5.5, 12);
    expect(arrival.position.z).toBeCloseTo((128 + 124) / 128, 12);
  });

  it.each([186, 186.5, 187])('draws nothing at or after packet endtime when sampled at cycle %s', (cycle) => {
    const { controller, update } = fixture();
    controller.consumeEvents([
      event({ tick: 2, projectiles: [{ ...projectile, startDelayCycles: 50, endDelayCycles: 126 }] }),
    ]);
    expect(update(185.5).map((mesh) => mesh.id)).toEqual(['effect-1375']);

    const meshes = update(cycle);

    expect(meshes).toEqual([]);
  });

  it('restores no flight at exactly its packet endtime: the end is exclusive', () => {
    const { controller } = fixture();
    const state = new SimulationEngine({ encounter: createZukWaveEncounter(1) }).getState();
    const history = {
      frames: [{ state: { ...state, currentTick: 2 }, events: [event({ tick: 2 })] }],
      throughFrameIndex: 0,
    };

    controller.reconstruct(history, { cycle: 83.5 });
    expect(controller['flights'].size).toBe(1);
    controller.reconstruct(history, { cycle: 84 });
    expect(controller['flights'].size).toBe(0);
  });

  it('holds a corpse target in the included snapshot instead of borrowing a future despawn', () => {
    const state = new SimulationEngine({ encounter: createZukWaveEncounter(1) }).getState();
    const emitted = event({
      projectiles: [
        {
          ...projectile,
          endDelayCycles: 90,
          target: { kind: 'actor', actorId: 'corpse', size: 1, position: [100, 100] },
        },
      ],
    });
    const frames: ReplayDisplayFrame[] = [
      {
        state: {
          ...state,
          npcs: [
            {
              ...makeSnapshot({ id: 'corpse', npcTypeId: 7705, position: [10, 5], size: 1, alive: false }),
              history: new Map(),
            },
          ],
        },
        events: [emitted],
      },
      { state: { ...state, currentTick: 1, npcs: [] }, events: [] },
    ];
    const reference = fixture();
    reference.controller.consumeEvents([emitted]);
    for (let cycle = 0; cycle <= 60; cycle++) reference.update(cycle);
    const sought = fixture();
    sought.controller.reconstruct({ frames, throughFrameIndex: 0 }, { cycle: 60 });
    expect(sought.update(60)).toEqual(reference.update(60));
    sought.controller.reconstruct({ frames, throughFrameIndex: 1 }, { cycle: 60 });
    expect(sought.update(60)).toEqual(reference.update(60));
  });
  it('matches fine and fractional coarse replay sampling after a moving target disappears', () => {
    const state = new SimulationEngine({ encounter: createZukWaveEncounter(1) }).getState();
    const frames: ReplayDisplayFrame[] = Array.from({ length: 4 }, (_, tick) => ({
      state: {
        ...state,
        currentTick: tick,
        npcs:
          tick < 2
            ? [
                {
                  ...makeSnapshot({ id: 'target', npcTypeId: 7705, position: [12 + tick, 5], size: 1 }),
                  previousPosition: [10 + tick, 5],
                  history: new Map(),
                },
              ]
            : [],
      },
      events:
        tick === 0
          ? [
              event({
                projectiles: [
                  {
                    ...projectile,
                    startDelayCycles: 7,
                    endDelayCycles: 90,
                    slope: 16,
                    target: { kind: 'actor', actorId: 'target', size: 1, position: [10, 5] },
                  },
                ],
              }),
            ]
          : [],
    }));
    const sample = (cycles: number[]) => {
      const scene = fixture();
      let meshes: ReturnType<typeof scene.update> = [];
      for (const cycle of cycles) {
        scene.controller.syncHistory({ frames, throughFrameIndex: Math.floor(cycle / 30) }, { cycle: cycle });
        meshes = scene.update(cycle);
      }
      return meshes;
    };
    const fine = sample([...Array.from({ length: 61 }, (_, cycle) => cycle), 60.5]);
    const reference = fixture();
    reference.controller.consumeEvents(frames[0].events);
    for (const cycle of [...Array.from({ length: 61 }, (_, index) => index), 60.5]) {
      const tick = Math.floor(cycle / 30);
      const fraction = cycle / 30 - tick;
      reference.move(tick >= 2 ? null : [fraction === 0 ? 12 + tick : 10 + tick + fraction * 2, 5]);
      reference.update(cycle);
    }
    expect(fine).toEqual(reference.update(60.5));
    expect(sample([60.5])).toEqual(fine);
    expect(sample([0, 7, 19.25, 35.75, 60.5])).toEqual(fine);
    expect(sample([0, 59.5, 60.5])).toEqual(fine);
    expect(fine).toHaveLength(1);
  });

  it('restores only the last successful historical target across seeks and history replacement', () => {
    const state = new SimulationEngine({ encounter: createZukWaveEncounter(1) }).getState();
    const emitted = event({
      projectiles: [
        {
          ...projectile,
          endDelayCycles: 90,
          target: { kind: 'actor', actorId: 'target', size: 4, position: [10, 5] },
        },
      ],
    });
    const frames: ReplayDisplayFrame[] = [
      { state: { ...state, npcs: [] }, events: [emitted] },
      {
        state: {
          ...state,
          currentTick: 1,
          npcs: [
            {
              ...makeSnapshot({ id: 'target', npcTypeId: 7705, position: [20, 10], size: 4 }),
              history: new Map(),
            },
          ],
        },
        events: [],
      },
      { state: { ...state, currentTick: 2, npcs: [] }, events: [] },
    ];
    const scene = fixture((worldX, worldY) => -128 * (worldX + worldY));
    const seek = (history: readonly ReplayDisplayFrame[], throughFrameIndex: number) => {
      scene.controller.reconstruct({ frames: history, throughFrameIndex: throughFrameIndex }, { cycle: 89.9999 });
      return scene.update(89.9999)[0];
    };

    const afterLoss = seek(frames, 2);
    const beforeSample = seek(frames, 0);
    const restored = seek(frames, 2);
    const replacement = seek(
      frames.map((frame) => ({
        ...frame,
        state: { ...frame.state, npcs: [] },
      })),
      2,
    );

    expect(afterLoss?.matrix[12]).toBeCloseTo(22, 3);
    expect(afterLoss?.matrix[13]).toBeCloseTo(12, 3);
    expect(afterLoss?.matrix[14]).toBeCloseTo(34 + 124 / 128, 3);
    expect(beforeSample?.matrix[12]).toBeCloseTo(12, 3);
    expect(beforeSample?.matrix[13]).toBeCloseTo(7, 3);
    expect(restored).toEqual(afterLoss);
    expect(replacement).toEqual(beforeSample);
  });

  it('does not reread history on repeated seeks and only reads the appended frame', () => {
    const state = new SimulationEngine({ encounter: createZukWaveEncounter(1) }).getState();
    let stateReads = 0;
    let eventReads = 0;
    const makeFrame = (tick: number): ReplayDisplayFrame => ({
      get state() {
        stateReads++;
        return { ...state, currentTick: tick };
      },
      get events() {
        eventReads++;
        return [
          event({
            eventId: tick,
            tick,
            graphics: [{ spotAnimId: 451, target: projectile.target, delayCycles: 70, height: 0 }],
          }),
        ];
      },
    });
    const frames = Array.from({ length: 10000 }, (_, tick) => makeFrame(tick));
    const { controller, update } = fixture();
    const seek = (tick: number) => {
      controller.reconstruct({ frames, throughFrameIndex: tick }, { cycle: tick * 30 + 5 });
      update(tick * 30 + 5);
    };
    seek(9999);
    stateReads = 0;
    eventReads = 0;
    for (const tick of [9000, 2000, 8000, 1000, 9000]) seek(tick);
    expect(stateReads).toBe(0);
    expect(eventReads).toBe(0);
    expect(controller['flights'].size).toBe(1);
    expect(controller['graphics'].size).toBeLessThanOrEqual(3);
    frames.push(makeFrame(10000));
    seek(10000);
    expect(stateReads).toBe(1);
    expect(eventReads).toBe(1);
  });

  it('materializes cache-ready held replay graphics without changing their original clock', () => {
    const { controller, renderer, update } = fixture();
    const state = new SimulationEngine({ encounter: createZukWaveEncounter(1) }).getState();
    const frames = [
      {
        state,
        events: [
          event({
            projectiles: [],
            graphics: [{ spotAnimId: 451, target: projectile.target, delayCycles: 70, height: 0 }],
          }),
        ],
      },
    ];
    const cache = renderer['meshCache'].get(451);
    if (!cache) expect.fail('Missing graphic fixture');
    renderer['meshCache'].delete(451);
    const history = { frames, throughFrameIndex: 0 };
    const frame = { cycle: 75.5 };
    controller.reconstruct(history, frame);
    expect(update(75.5)).toEqual([]);
    renderer['meshCache'].set(451, cache);
    controller.syncHistory(history, frame);
    expect(update(75.5)).toHaveLength(1);
    expect(renderer['activeInstances'].get('cue-1-graphic-0')?.lifecycle).toMatchObject({ startTick: 70 / 30 });
    expect(update(80)).toEqual([]);
  });
  it.each`
    spotAnimId | direction     | targetX | targetY | startHeight | endHeight
    ${1375}    | ${'east'}     | ${13}   | ${5}    | ${256}      | ${256}
    ${1376}    | ${'east'}     | ${13}   | ${5}    | ${256}      | ${256}
    ${1377}    | ${'east'}     | ${13}   | ${5}    | ${256}      | ${256}
    ${448}     | ${'east'}     | ${13}   | ${5}    | ${256}      | ${256}
    ${449}     | ${'east'}     | ${13}   | ${5}    | ${256}      | ${256}
    ${450}     | ${'east'}     | ${13}   | ${5}    | ${256}      | ${256}
    ${660}     | ${'east'}     | ${13}   | ${5}    | ${256}      | ${256}
    ${450}     | ${'north'}    | ${5}    | ${13}   | ${256}      | ${256}
    ${450}     | ${'west'}     | ${1}    | ${5}    | ${256}      | ${256}
    ${450}     | ${'diagonal'} | ${13}   | ${13}   | ${256}      | ${256}
    ${450}     | ${'rising'}   | ${13}   | ${5}    | ${256}      | ${768}
    ${450}     | ${'falling'}  | ${13}   | ${5}    | ${768}      | ${256}
  `(
    'aligns native -Z projectile head with $direction flight at midpoint: $spotAnimId',
    ({ spotAnimId, targetX, targetY, startHeight, endHeight }) => {
      const { controller, update } = fixture();
      controller.consumeEvents([
        event({
          projectiles: [
            {
              ...projectile,
              spotAnimId,
              sourcePosition: [5.5, 5.5],
              target: { kind: 'tile', position: [targetX, targetY] },
              endDelayCycles: 19,
              startOffset: 0,
              slope: 0,
              startHeight,
              endHeight,
            },
          ],
        }),
      ]);

      const meshes = update(9.5);

      expect(meshes).toHaveLength(1);
      const mesh = meshes[0];
      if (!mesh) expect.fail('Missing projectile mesh');
      const head = mesh.matrix.slice(8, 11).map((component) => -component);
      const headLength = Math.hypot(...head);
      const midpointVelocity = [(targetX - 5) / 19, (targetY - 5) / 19, (endHeight - startHeight) / 128 / 19];
      const speed = Math.hypot(...midpointVelocity);
      const alignment = midpointVelocity.reduce(
        (dot, component, axis) => dot + (component / speed) * (head[axis] / headLength),
        0,
      );
      expect(alignment).toBeCloseTo(1, 6);
    },
  );

  it.each([
    { actorId: 'player', destination: 60 },
    { actorId: 'moving-npc', destination: 60 },
    { actorId: 'player', destination: 60.5 },
    { actorId: 'moving-npc', destination: 60.5 },
  ])('reconstructs historical flight motion rather than aiming only at the destination: %j', ({
    actorId,
    destination,
  }) => {
    const initial = new SimulationEngine({ encounter: createZukWaveEncounter(1) }).getState();
    const history: ReplayDisplayFrame[] = Array.from({ length: 4 }, (_, tick) => ({
      state: {
        ...initial,
        currentTick: tick,
        playerPreviousPosition: [10 + tick, 5],
        playerPosition: [12 + tick, 5],
        playerMovementPath: [
          [11 + tick, 7],
          [12 + tick, 5],
        ],
        npcs: [
          {
            ...makeSnapshot({ id: 'moving-npc', npcTypeId: 7705, position: [12 + tick, 5], size: 1 }),
            previousPosition: [10 + tick, 5],
            history: new Map(),
          },
        ],
      },
      events:
        tick === 0
          ? [
              event({
                projectiles: [
                  {
                    ...projectile,
                    target: { ...projectile.target, kind: 'actor', actorId, size: 1 },
                    slope: 16,
                    endDelayCycles: 90,
                  },
                ],
              }),
            ]
          : [],
    }));
    const resolveSurfaceHeight = (worldX: number, worldY: number) => -128 * worldX - 64 * worldY;
    const prefix = fixture(resolveSurfaceHeight);
    for (const cycle of [...Array.from({ length: Math.floor(destination) + 1 }, (_, index) => index), destination]) {
      const tick = Math.floor(cycle / 30);
      const fraction = cycle / 30 - tick;
      const pathY = fraction < 0.5 ? 5 + fraction * 4 : 9 - fraction * 4;
      const targetX = actorId === 'moving-npc' && fraction === 0 ? 12 + tick : 10 + tick + fraction * 2;
      prefix.move([targetX, actorId === 'player' ? pathY : 5]);
      prefix.controller.consumeEvents(history[tick]?.events ?? []);
      prefix.update(cycle);
    }
    const expected = prefix.update(destination);
    const sought = fixture(resolveSurfaceHeight);
    sought.move([12, 5]);

    sought.controller.reconstruct({ frames: history, throughFrameIndex: 2 }, { cycle: destination });
    const actual = sought.update(destination);
    const destinationOnly = fixture(resolveSurfaceHeight);
    destinationOnly.move([12, 5]);
    destinationOnly.controller.consumeEvents(history[0]?.events ?? []);

    expect(actual).toEqual(expected);
    expect(actual).not.toEqual(destinationOnly.update(destination));
  });

  it('retains only destination-active and pending cues and excludes future frames', () => {
    const initial = new SimulationEngine({ encounter: createZukWaveEncounter(1) }).getState();
    const { controller, update } = fixture();
    const history: ReplayDisplayFrame[] = [
      {
        state: initial,
        events: [
          event({
            projectiles: [projectile, { ...projectile, startDelayCycles: 70, endDelayCycles: 90 }],
            graphics: [
              { spotAnimId: 444, target: projectile.target, delayCycles: 0, height: 0 },
              { spotAnimId: 451, target: projectile.target, delayCycles: 70, height: 0 },
            ],
            animations: [{ actorId: 'parent', clipId: 'attack', delayCycles: 80 }],
          }),
        ],
      },
      {
        state: { ...initial, currentTick: 1 },
        events: [event({ eventId: 2, projectiles: [{ ...projectile, endDelayCycles: 300 }] })],
      },
    ];

    controller.reconstruct({ frames: history, throughFrameIndex: 0 }, { cycle: 60 });

    expect(update(60)).toEqual([]);
    expect(controller.takeAnimations(60)).toEqual([]);
    expect(update(70).map((mesh) => mesh.id)).toEqual(['effect-1375', 'effect-451']);
    expect(controller.takeAnimations(80)).toHaveLength(1);
    expect(update(91)).toEqual([]);
  });

  it('keeps a long cache-owned graphic without an arbitrary history lookback', () => {
    const { controller, renderer, update } = fixture();
    const cache = renderer['meshCache'].get(444);
    if (!cache) expect.fail('Missing graphic fixture');
    cache.frameLengths = [20000];
    const state = new SimulationEngine({ encounter: createZukWaveEncounter(1) }).getState();

    controller.reconstruct(
      {
        frames: [
          {
            state,
            events: [
              event({
                projectiles: [],
                graphics: [{ spotAnimId: 444, target: projectile.target, delayCycles: 0, height: 0 }],
              }),
            ],
          },
        ],
        throughFrameIndex: 0,
      },
      { cycle: 19000 },
    );

    expect(update(19000).map((mesh) => mesh.id)).toEqual(['effect-444']);
    expect(update(20000)).toEqual([]);
  });

  it('uses independent start and exclusive end cycles when a Jad batch overlaps', () => {
    const { controller, update } = fixture();
    controller.consumeEvents([
      event({
        projectiles: [
          { ...projectile, spotAnimId: 448, startDelayCycles: 92, endDelayCycles: 116 },
          { ...projectile, spotAnimId: 449, startDelayCycles: 96, endDelayCycles: 120 },
          { ...projectile, spotAnimId: 450, startDelayCycles: 100, endDelayCycles: 126 },
        ],
      }),
    ]);

    const samples = [91, 92, 96, 100, 115.5, 116, 120, 126].map((cycle) => update(cycle).map((mesh) => mesh.id));

    expect(samples).toEqual([
      [],
      ['effect-448'],
      ['effect-448', 'effect-449'],
      ['effect-448', 'effect-449', 'effect-450'],
      ['effect-448', 'effect-449', 'effect-450'],
      ['effect-449', 'effect-450'],
      ['effect-450'],
      [],
    ]);
  });

  it('uses resolved source XY, raw offsets and terrain height when launching', () => {
    const { controller, update } = fixture();
    controller.consumeEvents([event()]);

    const meshes = update(0);

    expect(meshes[0]?.matrix.slice(12, 15)).toEqual([2.5, 5.5, (390 + 128) / 128]);
  });

  it.each([
    { source: -256, target: -768 },
    { source: 0, target: 0 },
  ])('uses separate scene references without changing packet offsets: %j', ({ source, target }) => {
    const { controller, update } = fixture((worldX) => (worldX < 3 ? source : target));
    controller.consumeEvents([event()]);

    const launch = update(0)[0];
    const midpoint = update(12)[0];

    expect(launch?.matrix.slice(12, 15)).toEqual([2.5, 5.5, (390 - source) / 128]);
    expect(midpoint?.matrix[14]).toBeCloseTo((3 * (390 - source) + 124 - target) / 512);
  });

  it('resamples the moving actor center rather than its footprint elevation', () => {
    const { controller, update, move } = fixture((worldX, worldY) => -128 * (worldX + worldY));
    controller.consumeEvents([
      event({
        projectiles: [{ ...projectile, target: { kind: 'actor', actorId: 'target', size: 4, position: [10, 5] } }],
      }),
    ]);
    update(10);
    move([12.25, 8.5]);

    const mesh = update(24 - 0.0001)[0];

    expect(mesh?.matrix[12]).toBeCloseTo(14.25, 3);
    expect(mesh?.matrix[13]).toBeCloseTo(10.5, 3);
    expect(mesh?.matrix[14]).toBeCloseTo(24.75 + 124 / 128, 3);
  });

  it('preserves the current trajectory when a live target moves and the clock is held', () => {
    const { controller, update, move } = fixture();
    controller.consumeEvents([event({ projectiles: [{ ...projectile, slope: 16 }] })]);
    update(0);
    const before = update(10);
    move([20, 10]);

    const held = update(10);
    const after = update(11);

    expect(held).toEqual(before);
    expect(after[0]?.matrix[12]).toBeGreaterThan(before[0]?.matrix[12] ?? 0);
    expect(after[0]?.matrix[13]).toBeGreaterThan(5.5);
    const launchVelocity = (8 / 24) * Math.tan(Math.PI / 8);
    const acceleration = (2 * ((124 - 390) / 128 - launchVelocity * 24)) / 24 ** 2;
    expect(after[0]?.matrix[14]).toBeCloseTo((390 + 128) / 128 + launchVelocity * 11 + (acceleration * 11 ** 2) / 2);
  });

  it('uses the explicit SW fallback plus actor size when the target disappears', () => {
    const { controller, update, move } = fixture();
    controller.consumeEvents([
      event({
        projectiles: [
          {
            ...projectile,
            endDelayCycles: 1,
            startOffset: 0,
            target: { kind: 'actor', actorId: 'gone', size: 4, position: [8, 3] },
          },
        ],
      }),
    ]);
    move(null);

    const meshes = update(0.5);

    expect(meshes[0]?.matrix.slice(12, 14)).toEqual([6, 5.25]);
  });

  it('retains a sampled moving destination after target loss without sharing it with another flight', () => {
    const { controller, update, move } = fixture((worldX, worldY) => -128 * (worldX + worldY));
    controller.consumeEvents([event()]);
    update(0);
    move([20, 10]);
    update(10);
    move(null);
    controller.consumeEvents([event({ eventId: 2 })]);

    const meshes = update(23.9999);

    expect(meshes[0]?.matrix[12]).toBeCloseTo(20.5, 3);
    expect(meshes[0]?.matrix[13]).toBeCloseTo(10.5, 3);
    expect(meshes[0]?.matrix[14]).toBeCloseTo(31 + 124 / 128, 3);
    expect(meshes[1]?.matrix[12]).toBeCloseTo(10.5, 3);
    expect(meshes[1]?.matrix[13]).toBeCloseTo(5.5, 3);
  });

  it('forgets a sampled destination when clear resets a reused flight id', () => {
    const { controller, update, move } = fixture();
    controller.consumeEvents([event()]);
    move([20, 10]);
    update(10);

    controller.clear();
    controller.consumeEvents([event()]);
    move(null);
    const mesh = update(23.9999)[0];

    expect(mesh?.matrix[12]).toBeCloseTo(10.5, 3);
    expect(mesh?.matrix[13]).toBeCloseTo(5.5, 3);
  });

  it('expires at endtime without advancing or retaining an expired flight', () => {
    const { controller, update } = fixture();
    controller.consumeEvents([event()]);
    update(23.9);

    const meshes = update(24);

    expect(meshes).toEqual([]);
    expect(update(54)).toEqual([]);
  });

  it('gates an unloaded projectile without restarting its flight on cache readiness', () => {
    const { renderer, controller, update } = fixture();
    const cache = renderer['meshCache'].get(1375);
    if (!cache) throw new Error('Missing test cache');
    renderer['meshCache'].delete(1375);
    controller.consumeEvents([event()]);
    const unloaded = update(5);
    renderer['meshCache'].set(1375, cache);

    const loaded = update(10);

    expect(unloaded).toEqual([]);
    expect(loaded[0]?.matrix[12]).toBeCloseTo(5.833333333333334);
  });

  it('uses cache frame lengths and tail frameStep rather than stretching animation to flight', () => {
    const { renderer, controller, update } = fixture();
    controller.consumeEvents([event()]);
    update(0);

    update(11);

    const instance = [...renderer['activeInstances'].values()][0];
    expect(instance?.frameProgress).toBeCloseTo(0.3);
  });

  it('expires a graphic exactly on its client-cycle boundary without tick-rounding drift', () => {
    const { controller, renderer, update } = fixture();
    const cache = renderer['meshCache'].get(451);
    if (!cache) expect.fail('Expected graphic cache');
    cache.frameLengths = [10];
    controller.consumeEvents([
      event({
        projectiles: [],
        graphics: [{ spotAnimId: 451, target: { kind: 'tile', position: [3, 4] }, delayCycles: 70, height: 92 }],
      }),
    ]);

    expect(update(79.999)).toHaveLength(1);
    expect(update(80)).toEqual([]);
  });

  it('attaches only explicit graphics with their cache lifetime and supplied height', () => {
    const { controller, update, move } = fixture(() => -1280);
    controller.consumeEvents([
      event({
        projectiles: [],
        graphics: [{ spotAnimId: 444, target: projectile.target, delayCycles: 120, height: 256 }],
      }),
    ]);
    expect(update(119)).toEqual([]);
    update(120);
    move([12, 8]);

    const meshes = update(125);

    expect(meshes[0]?.matrix.slice(12, 15)).toEqual([12.5, 8.5, 3]);
    expect(update(130)).toEqual([]);
  });

  it.each([
    { lengths: [] },
    { lengths: [0, 0] },
  ])('drops graphics whose loaded cache has no duration $lengths instead of inventing a lifetime', ({ lengths }) => {
    const { renderer, controller, update } = fixture();
    const cache = renderer['meshCache'].get(451);
    if (!cache) throw new Error('Missing test cache');
    cache.frameLengths = lengths;
    controller.consumeEvents([
      event({
        projectiles: [],
        graphics: [{ spotAnimId: 451, target: { kind: 'tile', position: [3, 4] }, delayCycles: 0, height: 92 }],
      }),
    ]);

    const meshes = update(0);
    cache.frameLengths = [30];

    expect(meshes).toEqual([]);
    expect(update(1)).toEqual([]);
  });

  it('retires a due graphic when its cache is unavailable instead of retaining an unbounded pending effect', () => {
    const { renderer, controller, update } = fixture();
    const cache = renderer['meshCache'].get(451);
    if (!cache) throw new Error('Missing test cache');
    renderer['meshCache'].delete(451);
    controller.consumeEvents([
      event({
        projectiles: [],
        graphics: [{ spotAnimId: 451, target: { kind: 'tile', position: [3, 4] }, delayCycles: 2, height: 92 }],
      }),
    ]);

    const missing = update(2);
    renderer['meshCache'].set(451, cache);

    expect(missing).toEqual([]);
    expect(update(3)).toEqual([]);
  });

  it('retains an unloaded future graphic and uses its event clock and tile center when ready', () => {
    const { renderer, controller, update } = fixture();
    const cache = renderer['meshCache'].get(451);
    if (!cache) expect.fail('Expected graphic cache');
    renderer['meshCache'].delete(451);
    controller.consumeEvents([
      event({
        tick: 10,
        projectiles: [],
        graphics: [{ spotAnimId: 451, target: { kind: 'tile', position: [3, 4] }, delayCycles: 15, height: 64 }],
      }),
    ]);
    const pending = update(310);
    renderer['meshCache'].set(451, cache);

    const mesh = update(320)[0];

    expect(pending).toEqual([]);
    expect(mesh?.matrix.slice(12, 15)).toEqual([3.5, 4.5, 1.5]);
    expect(update(325)).toEqual([]);
  });

  it('deduplicates events, isolates instances, and clears owned effects for rewind', () => {
    const { renderer, controller, update } = fixture();
    renderer.spawn({
      instanceId: 'other-controller',
      spotAnimId: 451,
      transform: { kind: 'static', value: { position: [0, 0, 0] } },
      lifecycle: { kind: 'manual' },
    });
    controller.consumeEvents([event(), event(), event({ eventId: 2 })]);
    expect(update(0)).toHaveLength(3);

    controller.clear();

    expect(update(0).map((mesh) => mesh.id)).toEqual(['effect-451']);
    controller.consumeEvents([event()]);
    expect(update(0)).toHaveLength(2);
    controller.clear();
    expect(update(0)).toHaveLength(1);
  });

  it('rebuilds queued historical animations from the cutoff on every sync, including rewinds', () => {
    const { controller } = fixture();
    const state = new SimulationEngine({ encounter: createZukWaveEncounter(1), combatSeed: 1 }).getState();
    const attack = event({
      eventId: 5,
      tick: 2,
      projectiles: [],
      animations: [{ actorId: 'zuk', clipId: 'attack', delayCycles: 30 }],
    });
    const frames: ReplayDisplayFrame[] = [0, 1, 2].map((currentTick) => ({
      state: { ...state, currentTick },
      events: currentTick === 2 ? [attack] : [],
    }));
    const queued = (throughFrameIndex: number, cycle: number) => {
      controller.syncHistory({ frames, throughFrameIndex }, { cycle });
      return controller['animations'].map(({ cue, cycle: start }) => ({ clipId: cue.clipId, start }));
    };
    // The first sync predates the cue; later syncs at newer cutoffs must still owe it to live play.
    controller.reconstruct({ frames, throughFrameIndex: 1 }, { cycle: 45 });
    expect(controller['animations']).toEqual([]);
    expect(queued(2, 67.5)).toEqual([{ clipId: 'attack', start: 90 }]);
    expect(queued(2, 67.5)).toHaveLength(1);
    expect(queued(1, 67.5)).toEqual([]);
    expect(queued(2, 59)).toEqual([]);
    expect(queued(2, 90)).toEqual([]);
    expect(queued(2, 89)).toEqual([{ clipId: 'attack', start: 90 }]);
    expect(controller.takeAnimations(90).map(({ cycle }) => cycle)).toEqual([90]);
  });
  it("rides an attached graphic on its actor's rendered model, turning with it, and hides it while the actor is absent", () => {
    const { controller, renderer, update, attach, move } = fixture();
    const yawOf = (matrix: readonly number[]) => (Math.atan2(matrix[8], matrix[0]) * 2048) / (2 * Math.PI);
    controller.consumeEvents([
      event({
        projectiles: [],
        graphics: [{ spotAnimId: 444, target: { kind: 'attached', actorId: 'sol' }, delayCycles: 2, height: 64 }],
      }),
    ]);
    attach({ position: [10, 20, 1], yaw2048: 512 });
    // The tracked-anchor actor position is ignored: an attachment follows only the rendered model.
    move([40, 40]);

    expect(update(1)).toEqual([]);
    const turned = update(2)[0];
    attach({ position: [11, 20, 1], yaw2048: 0 });
    const facing = update(3)[0];
    attach(null);
    const hidden = update(5);
    attach({ position: [12, 20, 1], yaw2048: 1024 });
    const back = update(7)[0];
    const lifecycle = renderer['activeInstances'].get('cue-1-graphic-0')?.lifecycle;
    attach(null);
    update(12);

    expect(turned?.matrix.slice(12, 15)).toEqual([10, 20, 1.5]);
    expect(yawOf(turned?.matrix ?? [])).toBeCloseTo(512, 6);
    expect(facing?.matrix.slice(12, 15)).toEqual([11, 20, 1.5]);
    expect(yawOf(facing?.matrix ?? [])).toBeCloseTo(0, 6);
    expect(hidden).toEqual([]);
    // Back on its own clock, not restarted by the gap.
    expect(back?.matrix.slice(12, 15)).toEqual([12, 20, 1.5]);
    expect(Math.abs(yawOf(back?.matrix ?? []))).toBeCloseTo(1024, 6);
    expect(lifecycle).toMatchObject({ startTick: 2 / 30 });
    // Its lifetime runs out while hidden: it is gone rather than shown late.
    expect(controller['graphics'].size).toBe(0);
    attach({ position: [12, 20, 1] });
    expect(update(12)).toEqual([]);
  });

  it('draws a tracked graphic on its recorded fallback while its actor is not rendered, unlike an attached one', () => {
    const { controller, update, move } = fixture();
    controller.consumeEvents([
      event({
        projectiles: [],
        graphics: [
          {
            spotAnimId: 444,
            target: { kind: 'actor', actorId: 'gone', size: 2, position: [8, 3] },
            delayCycles: 0,
            height: 128,
          },
          { spotAnimId: 451, target: { kind: 'attached', actorId: 'gone' }, delayCycles: 0, height: 128 },
        ],
      }),
    ]);
    move(null);

    const meshes = update(1);

    expect(meshes.map((mesh) => [mesh.id, mesh.matrix.slice(12, 15)])).toEqual([['effect-444', [9, 4, 2]]]);
  });

  it('plays same-cycle clips in emission order and every clip in start order, whatever order they were added in', () => {
    const { controller } = fixture();
    controller.consumeEvents([
      event({
        eventId: 1,
        tick: 1,
        projectiles: [],
        animations: [
          { actorId: 'a', clipId: 'late', delayCycles: 20 },
          { actorId: 'a', clipId: 'first', delayCycles: 5 },
          { actorId: 'a', clipId: 'second', delayCycles: 5 },
        ],
      }),
    ]);
    controller.consumeEvents([
      event({ eventId: 2, tick: 1, projectiles: [], animations: [{ actorId: 'a', clipId: 'third', delayCycles: 5 }] }),
    ]);

    expect(controller.takeAnimations(34)).toEqual([]);
    expect(controller.takeAnimations(40).map(({ cue, cycle }) => [cue.clipId, cycle])).toEqual([
      ['first', 35],
      ['second', 35],
      ['third', 35],
    ]);
    expect(controller.takeAnimations(50).map(({ cue, cycle }) => [cue.clipId, cycle])).toEqual([['late', 50]]);
  });
});
