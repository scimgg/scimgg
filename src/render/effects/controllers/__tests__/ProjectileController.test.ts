import { describe, expect, it, vi } from 'vitest';
import { chebyshevDistanceToRect } from '../../../../core/combat/distance';
import { calculateProjectileEndTime, hitDelayFromEndTime, PROJ_ANIM_TIMINGS } from '../../../../core/combat/hitDelay';
import { getProjectileTiming } from '../../../../core/combat/weaponCombatData';
import type { EncounterVisualEvent } from '../../../../core/events/encounterVisual';
import type { ReplayDisplayFrame } from '../../../../core/ReplayRecorder';
import { MAX_REPLAY_PROJECTILE_STEPS, ReplaySafetyError } from '../../../../core/replaySafety';
import { SimulationEngine } from '../../../../core/SimulationEngine';
import { getSpellVisuals } from '../../../../data/spellVisuals';
import { getWeaponCombatVisuals } from '../../../../data/weaponCombatVisuals';
import { LobbyEncounter } from '../../../../encounters/lobby/LobbyEncounter';
import type { RenderQueue } from '../../../core/commands';
import { ReplayEffectIndex } from '../../../core/replayEffectIndex';
import { EncounterCuePlayer } from '../../EncounterCuePlayer';
import type { PlayerProjectileDescriptor } from '../../playerEffectDescriptors';
import { advanceProjectileMotion } from '../../projectileMotion';
import { ReplayProjectileWork } from '../../replayProjectileWork';
import { SpotAnimRenderer } from '../../SpotAnimRenderer';
import { ProjectileController } from '../ProjectileController';

function flightFixture() {
  const controller = new ProjectileController();
  const renderer = new SpotAnimRenderer();
  for (const spotAnimId of [1375, 444]) {
    renderer['meshCache'].set(spotAnimId, {
      static: [
        {
          meshId: `effect-${spotAnimId}`,
          materialId: 'osrs-npc',
          positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, -1]),
          depth: 'readwrite',
        },
      ],
      frames: [],
      frameLengths: spotAnimId === 444 ? [120] : [2, 3, 5],
      frameStep: 2,
      heightOffset: 128,
    });
  }
  const impactCache = renderer['meshCache'].get(444);
  if (!impactCache) expect.fail('Expected impact cache');
  impactCache.frames = Array.from({ length: 120 }, (_, frame) =>
    impactCache.static.map((part) => ({
      ...part,
      perVertexHslColors: new Float32Array(3).fill(frame),
    })),
  );
  impactCache.frameLengths = new Array<number>(120).fill(1);
  const base = getWeaponCombatVisuals(29000);
  if (!base) expect.fail('Expected weapon visuals');
  const visuals = {
    ...base,
    projectileId: 1375,
    projectileStartDelay: 0,
    projectileStartHeight: 256,
    projectileEndHeight: 256,
    projectileSlope: 0,
    hitSpotanim: 444,
    hitSpotanimHeight: 64,
  };
  const timing = { delay: 0, lengthAdjustment: 60, stepMultiplier: 0, progress: 0 };
  let target: [number, number] | null = [10, 0];
  const update = (tick: number) => {
    controller.update(renderer, Math.floor(tick), tick, null, 0, () => target);
    renderer.tick(Math.floor(tick), tick);
    const queue: RenderQueue = { replayPresentationReady: true, commands: [] };
    renderer.render(queue);
    return queue.commands.flatMap((command) =>
      command.kind === 'mesh3d'
        ? [
            {
              id: command.meshId,
              matrix: Array.from(command.modelMatrix),
              zIndex: command.zIndex,
              frame:
                'perVertexHslColors' in command && command.perVertexHslColors instanceof Float32Array
                  ? command.perVertexHslColors[0]
                  : undefined,
            },
          ]
        : [],
    );
  };
  return {
    controller,
    renderer,
    visuals,
    timing,
    update,
    move: (position: [number, number] | null) => {
      target = position;
    },
  };
}

describe('ProjectileController', () => {
  it('applies shared flight culling and sorting to player and Inferno projectiles', () => {
    const { controller, renderer, visuals, timing } = flightFixture();
    const inferno = new EncounterCuePlayer(renderer);
    inferno.consumeEvents(
      [
        {
          type: 'encounter_visual',
          eventId: 1,
          tick: 0,
          animations: [],
          graphics: [],
          projectiles: [
            {
              spotAnimId: 1375,
              sourcePosition: [0, 0],
              target: { kind: 'tile', position: [10, 0] },
              startDelayCycles: 0,
              endDelayCycles: 60,
              startOffset: 0,
              slope: 0,
              startHeight: 0,
              endHeight: 0,
            },
          ],
        },
      ],
      { npcs: [], currentTick: 0 },
    );
    controller.launchProjectile({ ...visuals, hitSpotanim: -1 }, 29000, [0, 0], [10, 0], 1, 0, 0, undefined, timing);

    controller.update(renderer, 0, 0, null);
    inferno.update({ cycle: 0, resolveActor: () => null, resolveAttachment: () => null, terrainHeights: null });
    const queue: RenderQueue = { replayPresentationReady: true, commands: [] };
    renderer.render(queue);

    expect(queue.commands).toHaveLength(2);
    expect(queue.commands.every((command) => command.kind === 'mesh3d' && command.cullFace === 'back')).toBe(true);
    expect([...renderer['activeInstances'].values()].every((instance) => instance.style?.requireTransparentSort)).toBe(
      true,
    );
  });

  it.each([
    false,
    true,
  ])('shares the exact allowance across many player and Inferno flights (Inferno first: %s)', (infernoFirst) => {
    const { controller, renderer, visuals, timing } = flightFixture();
    const inferno = new EncounterCuePlayer(renderer);
    const state = new SimulationEngine({ encounter: new LobbyEncounter(), combatSeed: 1 }).getState();
    const emitted: EncounterVisualEvent = {
      type: 'encounter_visual',
      eventId: 1,
      tick: 0,
      animations: [],
      graphics: [],
      projectiles: Array.from({ length: 64 }, () => ({
        spotAnimId: 1375,
        sourcePosition: [0, 0],
        target: { kind: 'tile', position: [10, 0] },
        startDelayCycles: 0,
        endDelayCycles: 60,
        startOffset: 0,
        slope: 0,
        startHeight: 0,
        endHeight: 0,
      })),
    };
    const visualFrame = { cycle: 4.5, resolveActor: () => null, resolveAttachment: () => null, terrainHeights: null };
    const index = new ReplayEffectIndex([{ state, events: [emitted] }]);
    index.extend();
    inferno.syncReplay(index, { cycle: 4.5, throughFrameIndex: 0 }, true);
    controller.setReplaySampler(() => () => null);
    for (let index = 0; index < 64; index++) {
      controller.launchProjectile({ ...visuals, hitSpotanim: -1 }, 29000, [0, 0], [10, 0], 1, 0, 0, undefined, timing);
    }
    let samples = 0;
    const resolveSurfaceHeight = () => {
      if (++samples > 2000) throw new TypeError('Guarded controller sample work');
      return 0;
    };
    controller.setSurfaceHeightResolver(resolveSurfaceHeight);
    const work = new ReplayProjectileWork();
    const playerUpdate = () => controller.update(renderer, 0, 4.5 / 30, null, undefined, undefined, work);
    const infernoUpdate = () => inferno.update({ ...visualFrame, resolveSurfaceHeight }, work);

    expect(() => {
      work.charge(MAX_REPLAY_PROJECTILE_STEPS - 128 * 6 + 1);
      (infernoFirst ? infernoUpdate : playerUpdate)();
      (infernoFirst ? playerUpdate : infernoUpdate)();
    }).toThrowError(
      new ReplaySafetyError('projectile-work-limit', {
        actual: MAX_REPLAY_PROJECTILE_STEPS + 1,
        limit: MAX_REPLAY_PROJECTILE_STEPS,
      }),
    );
    expect(samples).toBe(127 * 6 * 2);
    expect(() => controller.update(renderer, 0, 4.5 / 30, null)).not.toThrow();
    expect(() => inferno.update({ ...visualFrame, resolveSurfaceHeight })).not.toThrow();
  });

  it.each([
    10.5, 35.2, 59.9, 70.5,
  ])('matches continuous historical sampling when seeking directly to cycle %s', (destinationCycle) => {
    const initial = new SimulationEngine({ encounter: new LobbyEncounter(), combatSeed: 1 }).getState();
    const frames: ReplayDisplayFrame[] = Array.from({ length: 4 }, (_, tick) => ({
      state: {
        ...initial,
        currentTick: tick,
        npcs:
          tick >= 2
            ? []
            : [
                {
                  id: 'target',
                  npcTypeId: 1,
                  archetypeId: 'test',
                  role: 'npc',
                  alive: true,
                  position: [12 + tick, 4],
                  previousPosition: [10 + tick, 2],
                  facingAngle: 0,
                  size: 1,
                  hp: 1,
                  maxHp: 1,
                  history: new Map(),
                },
              ],
      },
      events: [],
    }));
    const index = new ReplayEffectIndex(frames);
    const continuous = flightFixture();
    const sought = flightFixture();
    const effect: PlayerProjectileDescriptor = {
      kind: 'projectile',
      key: 'test',
      tick: 0,
      source: [0, 0],
      target: { position: [10, 0], size: 1, actorId: 'target', npcTypeId: 1 },
      weaponId: 29000,
      visuals: { ...continuous.visuals, projectileSlope: 16 },
      timing: continuous.timing,
      presentation: {},
    };
    continuous.controller.consumeDescriptor(effect, 0);
    for (let cycle = 0; cycle < destinationCycle; cycle += 0.37) {
      continuous.controller.setReplaySampler(
        index.actors.sampler({ cycle, throughFrameIndex: Math.floor(cycle / 30) }),
      );
      continuous.update(cycle / 30);
    }
    const sampler = index.actors.sampler({
      cycle: destinationCycle,
      throughFrameIndex: Math.floor(destinationCycle / 30),
    });
    continuous.controller.setReplaySampler(sampler);
    const expected = continuous.update(destinationCycle / 30);
    sought.controller.consumeDescriptor(effect, 0);
    sought.controller.setReplaySampler(sampler);

    const actual = sought.update(destinationCycle / 30);

    expect(actual).toEqual(expected);
    expect(actual.length).toBeGreaterThan(0);
  });

  describe('magic casts whose arrival precedes the projectile start delay', () => {
    const LAUNCH_TICK = 686;
    const castDescriptor = (
      caster: 'Ice Barrage' | 'powered staff',
      distance: number,
      fixture: ReturnType<typeof flightFixture>,
    ): PlayerProjectileDescriptor => {
      const target = { position: [20 + distance, 20] as const, size: 1, actorId: 'target', npcTypeId: 1 };
      const common = { kind: 'projectile', key: 'cast', tick: LAUNCH_TICK, source: [20, 20], target } as const;
      if (caster === 'powered staff') {
        const staff = getWeaponCombatVisuals(12899);
        if (!staff) expect.fail('Expected trident visuals');
        return {
          ...common,
          weaponId: 12899,
          visuals: { ...staff, projectileId: 1375, hitSpotanim: 444 },
          timing: getProjectileTiming(12899),
          presentation: {},
        };
      }
      const spell = getSpellVisuals(caster);
      if (!spell) expect.fail('Expected Ice Barrage visuals');
      return {
        ...common,
        weaponId: 0,
        visuals: {
          ...fixture.visuals,
          projectileStartDelay: spell.projectileStartDelay,
          projectileStartHeight: spell.projectileStartHeight,
          projectileEndHeight: spell.projectileEndHeight,
          projectileSlope: spell.projectileSlope,
        },
        timing: PROJ_ANIM_TIMINGS.magic_spell,
        presentation: { origin: spell.projectileOrigin, impactHeightMode: 'actor' },
      };
    };
    const launch = (
      caster: 'Ice Barrage' | 'powered staff',
      distance: number,
      mode: 'live' | 'replay',
    ): ReturnType<typeof flightFixture> => {
      const fixture = flightFixture();
      fixture.move([20 + distance, 20]);
      if (mode === 'replay') fixture.controller.setReplaySampler(() => () => [20 + distance, 20]);
      fixture.controller.consumeDescriptor(castDescriptor(caster, distance, fixture), 0);
      return fixture;
    };
    const seek = (fixture: ReturnType<typeof flightFixture>, offsetCycles: number) =>
      fixture.update((LAUNCH_TICK * 30 + offsetCycles) / 30).map(({ id, frame }) => ({ id, frame }));

    it.each([
      'Ice Barrage',
      'powered staff',
    ] as const)('shares the magic_spell profile that ends 5 cycles before its start at distance 0 (%s)', (caster) => {
      const { visuals, timing } = castDescriptor(caster, 0, flightFixture());
      if (!timing) expect.fail('Expected magic timing');

      expect(visuals.projectileStartDelay).toBe(51);
      expect(calculateProjectileEndTime(timing, 0)).toBe(46);
    });

    it.each([
      { caster: 'Ice Barrage', mode: 'replay' },
      { caster: 'Ice Barrage', mode: 'live' },
      { caster: 'powered staff', mode: 'replay' },
      { caster: 'powered staff', mode: 'live' },
    ] as const)('draws no travel but lands the impact on time at distance 0 ($caster, $mode)', ({ caster, mode }) => {
      for (const [offset, expected] of [
        [0, []],
        [45.99, []],
        [46, [{ id: 'effect-444', frame: 0 }]],
        [51, [{ id: 'effect-444', frame: 5 }]],
        [56, [{ id: 'effect-444', frame: 10 }]],
        [46 + 120, []],
      ] as const) {
        const fixture = launch(caster, 0, mode);

        expect(seek(fixture, offset), `offset ${offset}`).toEqual(expected);
        expect(fixture.controller['activeProjectiles'].size).toBe(0);
      }
    });

    it.each(['replay', 'live'] as const)('advances through a distance-0 cast without travel (%s)', (mode) => {
      const fixture = launch('Ice Barrage', 0, mode);

      const meshes = [0, 45.99, 46, 51, 56, 166].map((offset) => seek(fixture, offset).map(({ id }) => id));

      expect(meshes).toEqual([[], [], ['effect-444'], ['effect-444'], ['effect-444'], []]);
    });

    it.each(['replay', 'live'] as const)('still flies a distance-1 cast from 51 to 56 cycles (%s)', (mode) => {
      for (const [offset, expected] of [
        [50.99, []],
        [51, ['effect-1375']],
        [55.99, ['effect-1375']],
        [56, ['effect-444']],
      ] as const) {
        const fixture = launch('Ice Barrage', 1, mode);

        expect(
          seek(fixture, offset).map(({ id }) => id),
          `offset ${offset}`,
        ).toEqual(expected);
      }
    });
  });

  it('deduplicates a retained descriptor when a held replay is rebuilt', () => {
    const { controller, visuals, timing, update } = flightFixture();
    const effect: PlayerProjectileDescriptor = {
      kind: 'projectile',
      key: 'test',
      tick: 0,
      source: [0, 0],
      target: { position: [10, 0], size: 1, actorId: 'target', npcTypeId: 1 },
      weaponId: 29000,
      visuals,
      timing,
      presentation: {},
    };
    controller.consumeDescriptor(effect, 0);
    const expected = update(0.5);

    controller.consumeDescriptor(effect, 0);
    const actual = update(0.5);

    expect(actual).toEqual(expected);
  });
  it.each([
    0, 124,
  ])('anchors Ancient projectile impacts at actor height %i without model or sequence lift', (height) => {
    const { controller, visuals, timing, update } = flightFixture();
    controller.launchProjectile(
      { ...visuals, hitSpotanimHeight: height },
      29000,
      [0, 0],
      [10, 0],
      1,
      5,
      0,
      undefined,
      timing,
      { impactHeightMode: 'actor' },
    );

    const impact = update(2).find((mesh) => mesh.id === 'effect-444');

    expect(impact?.matrix.slice(12, 15)).toEqual([10.5, 0.5, height / 128]);
  });

  it('anchors a fractional direct Ancient impact without a standalone sequence offset', () => {
    const { controller, update } = flightFixture();
    controller.scheduleImpactSpotanim(444, 0, 66 / 30, [10, 0], 1, 5, undefined, 'actor');
    const before = update(65.99 / 30);

    const impact = update(66 / 30)[0];

    expect(before).toEqual([]);
    expect(impact?.matrix.slice(12, 15)).toEqual([10.5, 0.5, 0]);
    expect(impact?.frame).toBe(0);
  });

  it.each([
    [10, 0, 256],
    [0, 10, 256],
    [-10, 0, 256],
    [10, 10, 768],
    [10, -10, 0],
  ])('aligns the native -Z mesh head with real flight toward %j', (targetX, targetY, endHeight) => {
    const { controller, visuals, timing, update } = flightFixture();
    controller.launchProjectile(
      { ...visuals, projectileEndHeight: endHeight },
      29000,
      [0, 0],
      [targetX, targetY],
      1,
      5,
      0,
      undefined,
      timing,
    );

    const mesh = update(1)[0];

    if (!mesh) expect.fail('Expected projectile mesh');
    const head = mesh.matrix.slice(8, 11).map((component) => -component);
    const velocity = [targetX / 60, targetY / 60, (endHeight - 256) / 128 / 60];
    const alignment =
      velocity.reduce((dot, component, axis) => dot + component * head[axis], 0) /
      Math.hypot(...head) /
      Math.hypot(...velocity);
    expect(alignment).toBeCloseTo(1, 6);
  });

  it('preserves the held transform and homes continuously rather than redrawing from launch', () => {
    const { controller, visuals, timing, update, move } = flightFixture();
    controller.launchProjectile({ ...visuals, projectileSlope: 16 }, 29000, [0, 0], [10, 0], 1, 5, 0, 'target', timing);
    update(0);
    const before = update(1);
    move([20, 10]);

    const held = update(1);
    const after = update(1.001)[0];

    expect(held).toEqual(before);
    if (!after) expect.fail('Expected projectile mesh');
    const previousX = 0.5 + (10 * 30) / 60;
    expect(after.matrix[12]).toBeCloseTo(previousX + ((20.5 - previousX) * 0.03) / 30, 5);
    expect(after.matrix[13]).toBeCloseTo(0.5 + (10 * 0.03) / 30, 5);
    const progress = (1.001 * 30) / 60;
    expect(after.matrix[14]).toBeCloseTo(3 + 10 * Math.tan(Math.PI / 8) * (progress - progress ** 2), 5);
  });

  it('reaches the target at packet endtime when the player adapter launches a flight', () => {
    const { controller, visuals, timing, update } = flightFixture();
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 5, 0, undefined, timing);
    update(0);
    const motion = [...controller['activeProjectiles'].values()][0]?.flight['motion'];
    if (!motion) expect.fail('Expected initialized flight');

    const arrival = advanceProjectileMotion(motion, 60);

    expect(arrival.position.x).toBeCloseTo(10.5, 12);
    expect(arrival.position.y).toBeCloseTo(0.5, 12);
    expect(arrival.position.z).toBeCloseTo(2, 12);
  });

  it.each([0, 10, 29, 30, 60])('expires at endtime and keeps the on-time impact for arrival cycle %s', (endCycle) => {
    const { controller, visuals, timing, update, move } = flightFixture();
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 5, 0, 'target', {
      ...timing,
      lengthAdjustment: endCycle,
    });
    const endTick = endCycle / 30;
    const before = update(endTick - 0.001);
    move([12, 4]);

    const atEnd = update(endTick);
    const afterEnd = update((endCycle + 0.5) / 30);

    expect(before.map((mesh) => mesh.id)).toEqual(endCycle === 0 ? [] : ['effect-1375']);
    expect(atEnd.map((mesh) => mesh.id)).toEqual(['effect-444']);
    const impact = atEnd.find((mesh) => mesh.id === 'effect-444');
    expect(impact?.matrix.slice(12, 15)).toEqual([12.5, 4.5, 6.5]);
    expect(impact?.frame).toBe(0);
    expect(afterEnd.map((mesh) => mesh.id)).toEqual(['effect-444']);
    expect(update((endCycle + 1.5) / 30)[0]?.frame).toBe(1);
  });

  it('keeps player sequence height, zIndex and full-sequence looping', () => {
    const { controller, renderer, visuals, timing, update } = flightFixture();
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 5, 0, undefined, timing);

    const mesh = update(0.5)[0];

    expect(mesh?.matrix[14]).toBe(3);
    expect(mesh?.zIndex).toBe(68);
    expect([...renderer['activeInstances'].values()].map((instance) => instance.frameProgress)).toEqual([0.5]);
  });

  it('samples the target center point instead of footprint corner heights without a surface resolver', () => {
    const { controller, visuals, timing, update } = flightFixture();
    const heights = Array.from({ length: 65 }, () => new Int32Array(65));
    heights[10][0] = -128;
    heights[12][0] = -128;
    heights[10][2] = -128;
    heights[12][2] = -128;
    heights[11][1] = -1280;
    controller.setTerrainHeights(heights);
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 2, 50, 0, undefined, timing);

    const mesh = update(1)[0];

    expect(mesh?.matrix[14]).toBeCloseTo(5.5);
  });

  it.each([
    { source: -256, target: -768, midpoint: 6 },
    { source: 0, target: 0, midpoint: 3 },
  ])('uses independent surface references including zero: %j', ({ source, target, midpoint }) => {
    const { controller, visuals, timing, update } = flightFixture();
    controller.setTerrainHeights(Array.from({ length: 65 }, () => new Int32Array(65).fill(-1280)));
    const resolveSurfaceHeight = vi.fn((worldX: number, _worldY: number) => (worldX < 1 ? source : target));
    controller.setSurfaceHeightResolver(resolveSurfaceHeight);
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 2, 50, 0, undefined, timing);

    const mesh = update(1)[0];

    expect(mesh?.matrix[14]).toBeCloseTo(midpoint);
    expect(resolveSurfaceHeight.mock.calls).toEqual([
      [0.5, 0.5],
      [11, 1],
    ]);
  });

  it('resamples elevation at the moving target visual center', () => {
    const { controller, visuals, timing, update, move } = flightFixture();
    const resolveSurfaceHeight = vi.fn((worldX: number, worldY: number) => -128 * (worldX + worldY));
    controller.setSurfaceHeightResolver(resolveSurfaceHeight);
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 2, 50, 0, 'target', timing);
    update(1);
    move([12.25, 4.5]);

    const mesh = update((60 - 0.0001) / 30).find((part) => part.id === 'effect-1375');

    expect(resolveSurfaceHeight).toHaveBeenLastCalledWith(13.25, 5.5);
    expect(mesh?.matrix[14]).toBeCloseTo(21.75, 3);
  });

  it('falls back to bilinear source sampling when the surface callback is removed', () => {
    const { controller, visuals, timing, update } = flightFixture();
    const heights = Array.from({ length: 65 }, () => new Int32Array(65));
    heights[0][0] = -128;
    heights[1][0] = -256;
    heights[0][1] = -384;
    heights[1][1] = -512;
    controller.setTerrainHeights(heights);
    controller.setSurfaceHeightResolver(() => -1280);
    controller.setSurfaceHeightResolver(null);
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 50, 0, undefined, timing);

    const mesh = update(0)[0];

    expect(mesh?.matrix[14]).toBe(5.5);
  });

  it('keeps impact graphics on footprint and model heights when flight uses a surface resolver', () => {
    const { controller, visuals, timing, update } = flightFixture();
    controller.setTerrainHeights(Array.from({ length: 65 }, () => new Int32Array(65).fill(-128)));
    controller.setSurfaceHeightResolver(() => -1280);
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 2, 5, 0, undefined, timing);

    const impact = update(2).find((mesh) => mesh.id === 'effect-444');

    expect(impact?.matrix.slice(12, 15)).toEqual([11, 1, 7.5]);
  });

  it('retains the old flight while the next launch is pending and lets both flights coexist', () => {
    const { controller, visuals, timing, update } = flightFixture();
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 5, 0, undefined, {
      ...timing,
      lengthAdjustment: 90,
    });
    update(0.5);
    controller.launchProjectile(visuals, 29000, [4, 4], [10, 0], 1, 5, 2, undefined, timing);

    const pending = update(1);
    const replacement = update(2);

    expect(pending.map((mesh) => mesh.id)).toEqual(['effect-1375']);
    const flights = replacement.filter((mesh) => mesh.id === 'effect-1375');
    expect(flights).toHaveLength(2);
    expect(flights[1]?.matrix.slice(12, 14)).toEqual([4.5, 4.5]);
    expect(update(3).filter((mesh) => mesh.id === 'effect-1375')).toHaveLength(1);
  });

  it('does not cancel an airborne projectile when the next attack has no projectile', () => {
    const { controller, visuals, timing, update } = flightFixture();
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 5, 0, undefined, timing);
    controller.launchProjectile({ ...visuals, projectileId: -1 }, 29000, [0, 0], [10, 0], 1, 5, 1, undefined, timing);

    expect(update(1).map((mesh) => mesh.id)).toEqual(['effect-1375']);
  });

  it('keeps simultaneous shots attached to independent targets', () => {
    const { controller, visuals, timing, update } = flightFixture();
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 5, 0, undefined, timing);
    controller.launchProjectile(visuals, 29000, [0, 0], [0, 10], 1, 5, 0, undefined, timing);

    const meshes = update(1);

    expect(meshes.map((mesh) => mesh.matrix.slice(12, 14))).toEqual([
      [5.5, 0.5],
      [0.5, 5.5],
    ]);
  });

  it('renders overlapping impacts independently and expires only the finished one', () => {
    const { controller, update } = flightFixture();
    controller.scheduleImpactSpotanim(444, 0, 10, [10, 0], 1, 0);
    controller.scheduleImpactSpotanim(444, 0, 11, [0, 10], 1, 0);

    expect(update(11).map((mesh) => mesh.matrix.slice(12, 14))).toEqual([
      [10.5, 0.5],
      [0.5, 10.5],
    ]);
    expect(update(14).map((mesh) => mesh.matrix.slice(12, 14))).toEqual([[0.5, 10.5]]);
  });

  it('clears the shared flight and impact on a game-tick rewind', () => {
    const { controller, visuals, timing, update } = flightFixture();
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 5, 0, undefined, timing);
    controller.launchProjectile(visuals, 29000, [0, 0], [0, 10], 1, 5, 0, undefined, timing);
    controller.scheduleImpactSpotanim(444, 0, 0, [10, 0], 1, 5);
    update(1);

    const rewound = update(0);
    const resumed = update(1);

    expect(rewound).toEqual([]);
    expect(resumed).toEqual([]);
  });

  it('finishes at the last resolved destination when its target disappears mid-flight', () => {
    const { controller, visuals, timing, update, move } = flightFixture();
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 5, 0, 'target', timing);
    update(0);
    move([12, 4]);
    update(1);
    move(null);

    const flight = update((60 - 0.0001) / 30).find((mesh) => mesh.id === 'effect-1375');

    expect(flight?.matrix[12]).toBeCloseTo(12.5, 3);
    expect(flight?.matrix[13]).toBeCloseTo(4.5, 3);
  });

  it('renders an impact on time even when the projectile mesh never loaded', () => {
    const { controller, renderer, visuals, timing, update } = flightFixture();
    const cache = renderer['meshCache'].get(1375);
    if (!cache) expect.fail('Expected projectile cache');
    renderer['meshCache'].delete(1375);
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 5, 0, undefined, timing);
    const onTime = update(2);
    renderer['meshCache'].set(1375, cache);

    const arrival = update(3);
    const impact = update(3);

    expect(onTime.map((mesh) => mesh.id)).toEqual(['effect-444']);
    expect(onTime[0]?.frame).toBe(0);
    expect(arrival.map((mesh) => mesh.id)).toEqual(['effect-444']);
    expect(impact.map((mesh) => mesh.id)).toEqual(['effect-444']);
    expect(impact[0]?.frame).toBe(30);
  });

  it('applies depth bias to Demonbane impact spotanims', () => {
    const controller = new ProjectileController();
    const renderer = new SpotAnimRenderer();
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([30, 30]);
    const upsert = vi.spyOn(renderer, 'upsert');
    const darkDemonbane = getSpellVisuals('Dark Demonbane');
    if (!darkDemonbane) {
      throw new Error('Expected Dark Demonbane spell visuals');
    }

    controller.scheduleImpactSpotanim(darkDemonbane.hitSpotanimId, 0, 10, [29, 28], 5, 0);
    controller.update(renderer, 10, 10.5, null, 1024);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: expect.stringMatching(/^player-projectile-impact-/),
        spotAnimId: darkDemonbane.hitSpotanimId,
        style: expect.objectContaining({
          depthBias: 0.0005,
        }),
      }),
    );
  });

  it('does not apply depth bias to unrelated impact spotanims', () => {
    const controller = new ProjectileController();
    const renderer = new SpotAnimRenderer();
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([30, 30]);
    const upsert = vi.spyOn(renderer, 'upsert');

    controller.scheduleImpactSpotanim(9999, 0, 10, [29, 28], 5, 0);
    controller.update(renderer, 10, 10.5, null, 1024);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        instanceId: expect.stringMatching(/^player-projectile-impact-/),
        spotAnimId: 9999,
        style: expect.not.objectContaining({
          depthBias: expect.any(Number),
        }),
      }),
    );
  });

  it('launches the arrow projectile 11/128 tile along the source-to-target vector', () => {
    const controller = new ProjectileController();
    const renderer = new SpotAnimRenderer();
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([30, 30]);
    const upsert = vi.spyOn(renderer, 'upsert');
    const visuals = getWeaponCombatVisuals(29000);
    if (!visuals) {
      throw new Error('Expected Eclipse atlatl visuals');
    }

    // Source player at (0,0), target 1x1 npc at (10,0): the center-to-center unit
    // vector is +X, so an 11-local-unit progress offsets the launch by 11/128 tile.
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 5, 0);
    const appearTick = visuals.projectileStartDelay / 30;
    controller.update(renderer, 0, appearTick, null);

    const call = upsert.mock.calls.at(-1)?.[0];
    if (!call || call.transform.kind !== 'static') {
      throw new Error('Expected a static projectile transform');
    }
    const [x, y] = call.transform.value.position;
    expect(x).toBeCloseTo(0.5 + 11 / 128, 6);
    expect(y).toBeCloseTo(0.5, 6);
  });

  it('targets ground height plus endHeight/128 and ignores npc model-center height for the projectile', () => {
    const controller = new ProjectileController();
    const renderer = new SpotAnimRenderer();
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([30, 30]);
    const upsert = vi.spyOn(renderer, 'upsert');
    const base = getWeaponCombatVisuals(29000);
    if (!base) {
      throw new Error('Expected Eclipse atlatl visuals');
    }
    // Flat trajectory: startHeight == endHeight (146) with zero slope holds z
    // constant at 146/128 for a correct endHeight-based target Z. A model-center
    // target Z would bend the parabola far away from 146/128.
    const visuals = { ...base, projectileStartHeight: 146, projectileSlope: 0 };
    const decoyModelCenterHeight = 5;

    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, decoyModelCenterHeight, 0);

    const distance = chebyshevDistanceToRect(0, 0, 10, 0, 1);
    const timing = getProjectileTiming(29000);
    if (!timing) {
      throw new Error('Expected arrow projectile timing');
    }
    const appearTick = visuals.projectileStartDelay / 30;
    const impactTick = calculateProjectileEndTime(timing, distance) / 30;
    const midTick = (appearTick + impactTick) / 2;

    controller.update(renderer, 0, midTick, null);

    const call = upsert.mock.calls.at(-1)?.[0];
    if (!call || call.transform.kind !== 'static') {
      throw new Error('Expected a static projectile transform');
    }
    expect(call.transform.value.position[2]).toBeCloseTo(146 / 128, 6);
  });

  // The failure this guards against: pinning the destination to the launch-tick tile makes
  // the projectile fly to where the target *was*. OSRS re-reads the target
  // entity's position every cycle, so a target that moves is still hit.
  it('re-aims at the target actor live position while it moves', () => {
    const controller = new ProjectileController();
    const renderer = new SpotAnimRenderer();
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([30, 30]);
    const upsert = vi.spyOn(renderer, 'upsert');
    const visuals = getWeaponCombatVisuals(29000);
    if (!visuals) {
      throw new Error('Expected Eclipse atlatl visuals');
    }

    // Fired east at a 1x1 NPC on (10,0); the NPC then walks two tiles north.
    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 0, 0, 'npc-1');
    const distance = chebyshevDistanceToRect(0, 0, 10, 0, 1);
    const timing = getProjectileTiming(29000);
    if (!timing) {
      throw new Error('Expected arrow projectile timing');
    }
    const appearTick = visuals.projectileStartDelay / 30;
    const midTick = (appearTick + calculateProjectileEndTime(timing, distance) / 30) / 2;
    controller.update(renderer, 0, midTick, null, undefined, () => [10, 2]);

    const call = upsert.mock.calls.at(-1)?.[0];
    if (!call || call.transform.kind !== 'static') {
      throw new Error('Expected a static projectile transform');
    }
    // Half-way to the NPC's NEW center (2.5) rather than staying on the old row;
    // the 11/128 launch offset keeps it just off an exact midpoint.
    expect(call.transform.value.position[1]).toBeCloseTo(1.5, 1);
  });

  it('keeps a projectile launched without a target actor pinned to its tile', () => {
    const controller = new ProjectileController();
    const renderer = new SpotAnimRenderer();
    vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([30, 30]);
    const upsert = vi.spyOn(renderer, 'upsert');
    const visuals = getWeaponCombatVisuals(29000);
    if (!visuals) {
      throw new Error('Expected Eclipse atlatl visuals');
    }

    controller.launchProjectile(visuals, 29000, [0, 0], [10, 0], 1, 0, 0);
    const distance = chebyshevDistanceToRect(0, 0, 10, 0, 1);
    const timing = getProjectileTiming(29000);
    if (!timing) {
      throw new Error('Expected arrow projectile timing');
    }
    const appearTick = visuals.projectileStartDelay / 30;
    const midTick = (appearTick + calculateProjectileEndTime(timing, distance) / 30) / 2;
    controller.update(renderer, 0, midTick, null, undefined, () => [10, 2]);

    const call = upsert.mock.calls.at(-1)?.[0];
    if (!call || call.transform.kind !== 'static') {
      throw new Error('Expected a static projectile transform');
    }
    expect(call.transform.value.position[1]).toBeCloseTo(0.5, 6);
  });

  it('rides the target actor with the impact spotanim', () => {
    const { controller, update, move } = flightFixture();
    controller.scheduleImpactSpotanim(444, 64, 10, [29, 28], 1, 5, 'npc-1');
    move([31, 28]);

    const mesh = update(10.5)[0];

    expect(mesh?.matrix.slice(12, 15)).toEqual([31.5, 28.5, 1.5]);
  });

  it('keeps the last live impact anchor after the actor disappears', () => {
    const { controller, update, move } = flightFixture();
    controller.scheduleImpactSpotanim(444, 64, 10, [29, 28], 1, 5, 'npc-1');
    move([31, 28]);
    update(10.5);
    move(null);

    const mesh = update(11)[0];

    expect(mesh?.matrix.slice(12, 15)).toEqual([31.5, 28.5, 1.5]);
    expect(mesh?.frame).toBe(30);
  });

  it('does not resolve a future impact target before its attachment becomes active', () => {
    const { controller, update, move } = flightFixture();
    controller.scheduleImpactSpotanim(444, 0, 10, [29, 28], 1, 0, 'npc-1');
    move([40, 40]);
    update(9);
    move(null);

    const mesh = update(10)[0];

    expect(mesh?.matrix.slice(12, 14)).toEqual([29.5, 28.5]);
  });

  it('retains an unloaded impact without restarting or extending its clock', () => {
    const { controller, renderer, update } = flightFixture();
    const cache = renderer['meshCache'].get(444);
    if (!cache) expect.fail('Expected impact cache');
    renderer['meshCache'].delete(444);
    controller.scheduleImpactSpotanim(444, 0, 10, [29, 28], 1, 0);
    const unloaded = update(11);
    renderer['meshCache'].set(444, cache);

    const mesh = update(11)[0];

    expect(unloaded).toEqual([]);
    expect(mesh?.frame).toBe(30);
    expect(update(14)).toEqual([]);
  });

  it('retains the launch snapshot while its projectile asset is unavailable', () => {
    const controller = new ProjectileController();
    const renderer = new SpotAnimRenderer();
    let loaded = false;
    vi.spyOn(renderer, 'isLoaded').mockImplementation(() => loaded);
    vi.spyOn(renderer, 'getFrameLengths').mockReturnValue([30, 30]);
    const upsert = vi.spyOn(renderer, 'upsert');
    const visuals = getWeaponCombatVisuals(20997, 11212);
    if (!visuals) {
      throw new Error('Expected Twisted bow dragon-arrow visuals');
    }

    controller.launchProjectile(visuals, 20997, [0, 0], [10, 0], 1, 0, 3, 'target');
    controller.update(renderer, 3, 3, null);
    expect(upsert).not.toHaveBeenCalled();

    loaded = true;
    controller.update(renderer, 5, 5, null);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ spotAnimId: 1120 }));
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        lifecycle: { kind: 'duration', startTick: 131 / 30, endTick: 186 / 30 },
      }),
    );
  });

  it.each([
    {
      weapon: 12926,
      ammo: 11230,
      distance: 1,
      start: 32,
      end: 37,
      offset: 105,
      startHeight: 142,
      endHeight: 146,
      hit: 2,
    },
    {
      weapon: 12926,
      ammo: 11230,
      distance: 5,
      start: 32,
      end: 57,
      offset: 105,
      startHeight: 142,
      endHeight: 146,
      hit: 2,
    },
    {
      weapon: 20997,
      ammo: 11212,
      distance: 1,
      start: 41,
      end: 51,
      offset: 11,
      startHeight: 163,
      endHeight: 146,
      hit: 2,
    },
    {
      weapon: 20997,
      ammo: 11212,
      distance: 3,
      start: 41,
      end: 61,
      offset: 11,
      startHeight: 163,
      endHeight: 146,
      hit: 3,
    },
    {
      weapon: 20997,
      ammo: 11212,
      distance: 10,
      start: 41,
      end: 96,
      offset: 11,
      startHeight: 163,
      endHeight: 146,
      hit: 4,
    },
  ])('reaches the endpoint before the shared combat hit tick for weapon $weapon at distance $distance', (shot) => {
    const { controller, renderer, update } = flightFixture();
    const profile = getWeaponCombatVisuals(shot.weapon, shot.ammo);
    const timing = getProjectileTiming(shot.weapon);
    const cache = renderer['meshCache'].get(1375);
    if (!profile || !timing || !cache) expect.fail('Missing ranged projectile fixture');
    cache.heightOffset = 0;
    controller.setTerrainHeights(Array.from({ length: 65 }, () => new Int32Array(65).fill(-240)));
    controller.launchProjectile({ ...profile, projectileId: 1375 }, shot.weapon, [0, 0], [shot.distance, 0], 1, 5, 0);

    expect(update((shot.start - 1) / 30)).toEqual([]);
    const launch = update(shot.start / 30)[0];
    const arrival = update((shot.end - 0.0001) / 30)[0];
    const expired = update(shot.end / 30);

    expect(launch?.matrix[12]).toBeCloseTo(0.5 + shot.offset / 128, 6);
    expect(launch?.matrix[14]).toBeCloseTo((240 + shot.startHeight) / 128, 6);
    expect(arrival?.matrix[12]).toBeCloseTo(shot.distance + 0.5, 3);
    expect(arrival?.matrix[14]).toBeCloseTo((240 + shot.endHeight) / 128, 3);
    expect(expired).toEqual([]);
    expect(calculateProjectileEndTime(timing, shot.distance)).toBe(shot.end);
    expect(hitDelayFromEndTime(shot.end)).toBe(shot.hit);
    expect(shot.end).toBeLessThanOrEqual(shot.hit * 30);
    expect(shot.end).toBeGreaterThan((shot.hit - 1) * 30);
  });
});
