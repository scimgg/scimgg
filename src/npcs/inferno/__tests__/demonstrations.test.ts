import { afterEach, describe, expect, it } from 'vitest';
import { setArenaConfig, setDefaultArenaConfig } from '../../../core/constants';
import { isEncounterVisualEvent } from '../../../core/events/encounterVisual';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { createZukWaveEncounter } from '../../../test/helpers/zukWave';
import { createInfernoActor } from '../actors';
import { demonstrateHeal, demonstrateJad, demonstrateSet } from '../demonstrations';
import { createGlyph } from '../glyph';
import { createJad } from '../jad';
import { ZUK_WAVE_GRAPHICS } from './fixtures/zukWaveGraphicsCapture';

const capture = { packets: ZUK_WAVE_GRAPHICS };
const rangerPackets = capture.packets.filter((packet) => packet.id === 1377);

afterEach(() => {
  setDefaultArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null });
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
});

describe('recorded Inferno visual-only demonstrations', () => {
  it.each([
    { target: [11, 11], end: 46 },
    { target: [11, 12], end: 54 },
  ] as const)('keeps overlapping-target ranger flights valid at end cycle $end', ({ target, end }) => {
    const ranger = createInfernoActor('ranger', 'ranger', [10, 10]);
    const receiver = createInfernoActor('jad_healer', 'target', [...target]);

    const cue = demonstrateSet([ranger], receiver);

    expect(isEncounterVisualEvent({ type: 'encounter_visual', eventId: 1, tick: 0, ...cue })).toBe(true);
    expect(cue.projectiles).toHaveLength(2);
    expect(
      cue.projectiles.map(({ spotAnimId, startDelayCycles, endDelayCycles }) => ({
        spotAnimId,
        startDelayCycles,
        endDelayCycles,
      })),
    ).toEqual(Array.from({ length: 2 }, () => ({ spotAnimId: 1377, startDelayCycles: end, endDelayCycles: end })));
  });

  it('emits both ranger projectiles when demonstrating the recorded t106 shot', () => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(0) });
    const player = engine['worldState'].getPlayer();
    if (!player) throw new TypeError('Missing player fixture');
    player.position = [40, 46];
    const ranger = createInfernoActor('ranger', 'ranger', [35, 39]);
    const volley = capture.packets.filter((packet) => packet.tick === 106 && packet.id === 1377);

    const cue = demonstrateSet([ranger], player);

    expect(volley).toHaveLength(2);
    expect(cue.projectiles).toEqual(
      volley.map((packet) => {
        if (!packet.origin) throw new TypeError('Missing ranger origin');
        return {
          spotAnimId: packet.id,
          sourcePosition: [packet.origin[0] + 0.5, packet.origin[1] + 0.5],
          target: { kind: 'actor', actorId: 'player', size: 1, position: [40, 46] },
          startDelayCycles: packet.fields.starttime,
          endDelayCycles: packet.fields.endtime,
          slope: packet.fields.angle,
          startOffset: packet.fields.progress,
          startHeight: packet.fields.startheight,
          endHeight: packet.fields.endheight,
        };
      }),
    );
    expect(cue.graphics).toEqual([]);
  });

  it.each([
    ...new Set(rangerPackets.map((packet) => packet.tick)),
  ])('matches the supported fields of both recorded ranger projectiles at t%i', (tick) => {
    const volley = rangerPackets.filter((packet) => packet.tick === tick);
    const recordedTarget = volley[0]?.target;
    if (!recordedTarget) throw new TypeError('Missing ranger target');
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(0) });
    const player = engine['worldState'].getPlayer();
    if (!player) throw new TypeError('Missing player fixture');
    player.position = [recordedTarget[0], recordedTarget[1]];
    const ranger = createInfernoActor('ranger', 'ranger', [35, 39]);

    const cue = demonstrateSet([ranger], player);

    expect(cue.projectiles).toHaveLength(2);
    expect(
      cue.projectiles.map((projectile) => ({
        id: projectile.spotAnimId,
        starttime: projectile.startDelayCycles,
        endtime: projectile.endDelayCycles,
        angle: projectile.slope,
        progress: projectile.startOffset,
        startheight: projectile.startHeight,
        endheight: projectile.endHeight,
        target: projectile.target,
      })),
    ).toEqual(
      volley.map((packet) => ({
        id: packet.id,
        ...packet.fields,
        target: { kind: 'actor', actorId: 'player', size: 1, position: player.position },
      })),
    );
    expect(cue.graphics).toEqual([]);
  });

  it.each([
    {
      direction: 'north',
      target: [11, 17],
      facing: 1024,
      sources: [
        [10.5, 13.5],
        [12.5, 13.5],
      ],
    },
    {
      direction: 'north-east',
      target: [17, 17],
      facing: 1280,
      sources: [
        [11.5, 13.5],
        [13.5, 11.5],
      ],
    },
    {
      direction: 'east',
      target: [17, 11],
      facing: 1536,
      sources: [
        [13.5, 12.5],
        [13.5, 10.5],
      ],
    },
    {
      direction: 'south-east',
      target: [17, 5],
      facing: 1792,
      sources: [
        [13.5, 11.5],
        [11.5, 9.5],
      ],
    },
    {
      direction: 'south',
      target: [11, 5],
      facing: 0,
      sources: [
        [12.5, 9.5],
        [10.5, 9.5],
      ],
    },
    {
      direction: 'south-west',
      target: [5, 5],
      facing: 256,
      sources: [
        [11.5, 9.5],
        [9.5, 11.5],
      ],
    },
    {
      direction: 'west',
      target: [5, 11],
      facing: 512,
      sources: [
        [9.5, 10.5],
        [9.5, 12.5],
      ],
    },
    {
      direction: 'north-west',
      target: [5, 17],
      facing: 768,
      sources: [
        [9.5, 11.5],
        [11.5, 13.5],
      ],
    },
  ] as const)('rotates the approximate launch pair when the target is $direction', ({ target, facing, sources }) => {
    const ranger = createInfernoActor('ranger', 'ranger', [10, 10]);
    const receiver = createInfernoActor('jad_healer', 'target', [...target]);

    const cue = demonstrateSet([ranger], receiver);

    expect(cue.projectiles.map((projectile) => projectile.sourcePosition)).toEqual(sources);
    expect(ranger.facing).toBe(facing);
    expect(cue.animations).toEqual([{ actorId: ranger.id, clipId: 'range', delayCycles: 0 }]);
    expect(demonstrateSet([ranger], receiver)).toEqual(cue);
  });

  it('matches every packet field of the first recorded Jad magic volley after its three-tick windup', () => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(0) });
    const player = engine['worldState'].getPlayer();
    const first = capture.packets.find((packet) => packet.id === 448);
    if (!player || !first?.target) throw new TypeError('Missing capture fixture');
    player.position = [first.target[0], first.target[1]];
    const jad = createJad({ id: 'jad', position: [30, 35], spawnTick: 0, targetId: null });
    const cue = demonstrateJad(jad, player, 'magic');
    const volley = capture.packets.filter(
      (packet) => packet.tick === first.tick && [448, 449, 450].includes(packet.id),
    );
    expect(
      cue.projectiles.map((projectile) => ({
        id: projectile.spotAnimId,
        starttime: projectile.startDelayCycles - 90,
        endtime: projectile.endDelayCycles - 90,
        angle: projectile.slope,
        progress: projectile.startOffset,
        startheight: projectile.startHeight,
        endheight: projectile.endHeight,
        source: projectile.sourcePosition,
      })),
    ).toEqual(volley.map((packet) => ({ id: packet.id, ...packet.fields, source: [32.5, 37.5] })));
    expect(cue.projectiles.map((projectile) => projectile.target)).toEqual(
      Array.from({ length: 3 }, () => ({ kind: 'actor', actorId: 'player', size: 1, position: player.position })),
    );
  });

  it('keeps the D=3 magic horizons inclusive without invented spatial leads', () => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(0) });
    const player = engine['worldState'].getPlayer();
    if (!player) throw new TypeError('Missing player');
    player.position = [32, 40];
    const jad = createJad({ id: 'jad', position: [30, 35], spawnTick: 0, targetId: null });
    const cue = demonstrateJad(jad, player, 'magic');
    expect(cue.projectiles.map((projectile) => projectile.endDelayCycles - projectile.startDelayCycles + 1)).toEqual([
      25, 25, 27,
    ]);
    expect(cue.projectiles.map((projectile) => projectile.sourcePosition)).toEqual([
      [32.5, 37.5],
      [32.5, 37.5],
      [32.5, 37.5],
    ]);
  });

  it('matches the mager packet without attaching its impact graphic to the ranger pair', () => {
    const first = capture.packets.find((packet) => packet.id === 1376);
    if (!first?.target) throw new TypeError('Missing mager fixture');
    const glyph = createGlyph({ id: 'zuk_shield', position: [30, 48], spawnTick: 0, targetEndpoint: 1 });
    glyph.position = [first.target[0] - 1, first.target[1] - 1];
    const cue = demonstrateSet(
      [createInfernoActor('mager', 'mager', [26, 39]), createInfernoActor('ranger', 'ranger', [35, 39])],
      glyph,
    );
    expect(cue.projectiles.map((projectile) => projectile.spotAnimId)).toEqual([1376, 1377, 1377]);
    const projectile = cue.projectiles[0];
    expect({
      starttime: projectile.startDelayCycles,
      endtime: projectile.endDelayCycles,
      angle: projectile.slope,
      progress: projectile.startOffset,
      startheight: projectile.startHeight,
      endheight: projectile.endHeight,
    }).toEqual(first.fields);
    expect(projectile.sourcePosition).toEqual([28.5, 41.5]);
    expect(cue.graphics).toEqual([
      { spotAnimId: 131, target: projectile.target, delayCycles: first.fields.endtime, height: 124 },
    ]);
    expect(cue.animations).toEqual([
      { actorId: 'mager', clipId: 'magic', delayCycles: 0 },
      { actorId: 'ranger', clipId: 'range', delayCycles: 0 },
    ]);
  });

  it('faces inert demonstration casters without creating combat targets or definitions', () => {
    const mager = createInfernoActor('mager', 'mager', [10, 10]);
    const ranger = createInfernoActor('ranger', 'ranger', [10, 10]);
    const healer = createInfernoActor('healer', 'healer', [10, 10]);
    const target = createInfernoActor('zuk', 'parent', [8, 20]);
    const initialVitals = structuredClone([mager.vitals, ranger.vitals, healer.vitals, target.vitals]);
    const initialCombat = structuredClone([mager.combat, ranger.combat, healer.combat, target.combat]);

    demonstrateSet([mager, ranger], target);
    demonstrateHeal([healer], target);

    expect([mager.vitals, ranger.vitals, healer.vitals, target.vitals]).toEqual(initialVitals);
    expect([mager.combat, ranger.combat, healer.combat, target.combat]).toEqual(initialCombat);
    for (const actor of [mager, ranger, healer]) {
      expect(actor.facing).not.toBe(0);
      expect(actor.combat.targetId).toBeNull();
      expect(actor.definition).toBeUndefined();
      expect(actor.actionFacing).toBeUndefined();
    }
  });

  it('reproduces the t1069 four-healer bucket and the single t1073 actor graphic without HP mutation', () => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(0) });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'demonstrate-heal' });
    const event = engine.getLastTickEvents().find(isEncounterVisualEvent);
    if (!event) throw new TypeError('Missing visual event');
    const bucket = capture.packets.filter((packet) => packet.tick === 1069 && packet.id === 660);
    expect(
      event.projectiles.map((projectile) => ({
        starttime: projectile.startDelayCycles,
        endtime: projectile.endDelayCycles,
        angle: projectile.slope,
        progress: projectile.startOffset,
        startheight: projectile.startHeight,
        endheight: projectile.endHeight,
      })),
    ).toEqual(bucket.map((packet) => packet.fields));
    const graphic = capture.packets.filter((packet) => packet.tick === 1073 && packet.id === 444);
    expect(graphic).toHaveLength(1);
    expect(event.graphics).toHaveLength(1);
    expect(event.graphics[0]).toMatchObject({ delayCycles: (1073 - 1069) * 30, height: graphic[0].fields.height });
    expect(event.animations).toHaveLength(4);
    expect(engine['worldState'].getNpc('zuk')?.vitals.hp).toBe(1200);
  });

  it('keeps ranged demonstrations animation-only while explicit rock inspection remains available', () => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(0) });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'demonstrate-jad', style: 'range' });
    const demonstration = engine.getLastTickEvents().filter(isEncounterVisualEvent).at(-1);
    expect(demonstration).toMatchObject({
      animations: [expect.objectContaining({ clipId: 'range' })],
      graphics: [],
      projectiles: [],
    });
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'inspect-ranged-graphic' });
    const inspection = engine.getLastTickEvents().filter(isEncounterVisualEvent).at(-1);
    const packet = capture.packets.find((candidate) => candidate.id === 451);
    expect(inspection?.graphics).toEqual([
      { spotAnimId: 451, height: packet?.fields.height, delayCycles: 0, target: { kind: 'tile', position: [31, 44] } },
    ]);
  });
});
