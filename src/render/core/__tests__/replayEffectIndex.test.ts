import { afterEach, describe, expect, it, vi } from 'vitest';
import { setArenaConfig } from '../../../core/constants';
import type { GameEvent } from '../../../core/events/types';
import type { ReplayDisplayFrame } from '../../../core/ReplayRecorder';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import type { NpcState } from '../../../types/simulation';
import { ProjectileController } from '../../effects/controllers/ProjectileController';
import { describePlayerEffects, projectileEndCycle } from '../../effects/playerEffectDescriptors';
import { SpotAnimRenderer } from '../../effects/SpotAnimRenderer';
import { ReplayEffectIndex } from '../replayEffectIndex';

afterEach(() => {
  setArenaConfig({ bounds: null, walkableTiles: null, collisionMap: null }, true);
  vi.restoreAllMocks();
});

function frame(tick: number, events: GameEvent[] = []): ReplayDisplayFrame {
  const state = new SimulationEngine({ encounter: new LobbyEncounter(), combatSeed: 1 }).getState();
  return {
    state: {
      ...state,
      currentTick: tick,
      playerPosition: [0, 0],
      primaryNpcPosition: [10, 0],
      primaryNpcSize: 1,
      npcs: [],
    },
    events,
  };
}

const graphic = (tick: number, spotAnimId = 123): GameEvent => ({
  type: 'player_graphic_applied',
  eventId: tick,
  tick,
  spotAnimId,
});
const shot = (tick: number): GameEvent => ({
  type: 'attack_started',
  eventId: tick,
  tick,
  sourceId: 'player',
  targetId: 'target',
  style: 'range',
  attackKind: 'range_arrow',
  weaponId: 20997,
  ammoId: 11212,
});

function corpse(id: string, npcTypeId: number, spawnTick: number, despawnTick: number): NpcState {
  return {
    id,
    npcTypeId,
    archetypeId: 'test',
    role: 'minion',
    alive: false,
    position: [12, 4],
    previousPosition: [12, 4],
    facingAngle: 0,
    size: 1,
    hp: 0,
    maxHp: 1,
    spawnTick,
    despawnTick,
    history: new Map(),
  };
}

describe('ReplayEffectIndex', () => {
  it('extends in current-presence work rather than revisiting historical lives and deaths', () => {
    const frames: ReplayDisplayFrame[] = [];
    const index = new ReplayEffectIndex(frames);
    const lives = index['actorLives'];
    const iterateLives = lives[Symbol.iterator].bind(lives);
    let lifeVisits = 0;
    let deathVisits = 0;
    lives[Symbol.iterator] = function* () {
      for (const entry of iterateLives()) {
        lifeVisits++;
        yield entry;
      }
      return undefined;
    };
    const source = frame(0);

    for (let tick = 0; tick < 128; tick++) {
      const dead = corpse(`dead-${tick}`, 7705, tick, tick);
      Object.defineProperty(dead, 'npcTypeId', {
        get() {
          deathVisits++;
          return 7705;
        },
      });
      frames.push({
        state: { ...source.state, currentTick: tick, npcs: [dead] },
        events: [{ type: 'actor_presentations_removed', npcTypeIds: [7705], eventId: tick, tick }],
      });
      index.extend();
    }

    expect(lifeVisits).toBeLessThanOrEqual(256);
    expect(deathVisits).toBeLessThanOrEqual(256);
    expect(index.deathPresentations({ cycle: 127 * 30, throughFrameIndex: 127 }, 100000)).toEqual([]);
  });

  it('applies type clears only to deaths already recorded, including same-frame deaths, at both seek cutoffs', () => {
    const before = frame(9, [{ type: 'actor_presentations_removed', npcTypeIds: [7705], eventId: 1, tick: 9 }]);
    const death = frame(10);
    const dead = corpse('healer', 7705, 1, 10);
    const other = corpse('other', 7706, 1, 10);
    death.state.npcs = [dead, other];
    const frames = [before, death];
    const index = new ReplayEffectIndex(frames);
    const original = index.deathPresentations({ cycle: 330, throughFrameIndex: 1 }, 6000);
    const replacement = corpse('healer', 7705, 11, 11);
    const clear = frame(11, [{ type: 'actor_presentations_removed', npcTypeIds: [7705], eventId: 2, tick: 11 }]);
    clear.state.npcs = [replacement];
    frames.push(clear);
    index.extend();

    const results = [
      { cycle: 330, throughFrameIndex: 1 },
      { cycle: 329, throughFrameIndex: 2 },
      { cycle: 330, throughFrameIndex: 2 },
    ].map((destination) => index.deathPresentations(destination, 6000).map(({ npc }) => npc));

    expect(results).toEqual([[dead, other], [dead, other], [other]]);
    expect(original.map(({ npc }) => npc)).toEqual([dead, other]);
    expect(index.deathPresentations({ cycle: 330, throughFrameIndex: 1 }, 6000)).toEqual(original);
  });

  it.each([undefined, 4])('preserves absent/reappearing life identity when spawnTick=%s', (spawnTick) => {
    const first = corpse('healer', 7705, 4, 10);
    first.spawnTick = spawnTick;
    const replacement = { ...first, despawnTick: 12 };
    const death = frame(10);
    death.state.npcs = [first];
    const clear = frame(11, [{ type: 'actor_presentations_removed', npcTypeIds: [7705], eventId: 1, tick: 11 }]);
    const respawn = frame(12);
    respawn.state.npcs = [replacement];

    const index = new ReplayEffectIndex([death, clear, respawn]);

    expect(index.deathPresentations({ cycle: 360, throughFrameIndex: 2 }, 6000).map(({ npc }) => npc)).toEqual(
      spawnTick === undefined ? [replacement] : [],
    );
  });

  it.each([
    'actor-first',
    'type-first',
  ] as const)('retains the first suppression event when %s has a later clock', (order) => {
    const death = frame(10);
    death.state.npcs = [corpse('healer', 7705, 1, 10)];
    const actor: GameEvent = {
      type: 'actor_despawned',
      actorId: 'healer',
      eventId: 2,
      tick: order === 'actor-first' ? 12 : 11,
    };
    const type: GameEvent = {
      type: 'actor_presentations_removed',
      npcTypeIds: [7705],
      eventId: 3,
      tick: order === 'type-first' ? 12 : 11,
    };
    const removal = frame(11, order === 'actor-first' ? [actor, type] : [type, actor]);
    const index = new ReplayEffectIndex([death, removal]);

    const results = [330, 360].map((cycle) => index.deathPresentations({ cycle, throughFrameIndex: 1 }, 6000).length);

    expect(results).toEqual([1, 0]);
  });

  it('returns a large active encounter graphic stream in emission order', () => {
    const graphics = Array.from({ length: 130_000 }, () => ({
      spotAnimId: 659,
      target: { kind: 'tile', position: [1, 1] },
      delayCycles: 0,
      height: 0,
    }));
    const index = new ReplayEffectIndex([
      frame(0, [{ type: 'encounter_visual', eventId: 1, tick: 0, animations: [], projectiles: [], graphics }]),
    ]);

    const active = index.cues.activeGraphics({ cycle: 0, throughFrameIndex: 0 }, () => 30);

    expect(active).toHaveLength(graphics.length);
    expect(active[0]?.id).toBe('cue-1-graphic-0');
    expect(active.at(-1)?.id).toBe('cue-1-graphic-129999');
  });

  // Vitest's worker threads have 4 MiB stacks, so the test above would pass even if a stream were
  // spread into one call; on a 1 MiB main-thread stack (Node's default, and a browser page's) such a
  // spread throws RangeError near 125k arguments. This pins the bounded iteration instead.
  it('collects a large active encounter graphic stream without passing it as call arguments', () => {
    const graphics = Array.from({ length: 130_000 }, () => ({
      spotAnimId: 659,
      target: { kind: 'tile', position: [1, 1] },
      delayCycles: 0,
      height: 0,
    }));
    const index = new ReplayEffectIndex([
      frame(0, [{ type: 'encounter_visual', eventId: 1, tick: 0, animations: [], projectiles: [], graphics }]),
    ]);
    // A plain wrapper rather than a spy: a spy's own argument copies overflow even a worker's stack.
    const push = Array.prototype.push;
    let widest = 0;
    Array.prototype.push = function (this: unknown[], ...items: unknown[]) {
      widest = Math.max(widest, items.length);
      return push.apply(this, items);
    };
    try {
      index.cues.activeGraphics({ cycle: 0, throughFrameIndex: 0 }, () => 30);
    } finally {
      Array.prototype.push = push;
    }

    expect(widest).toBeLessThan(graphics.length);
  });

  it.each(
    [
      { spellId: 'Wind Strike', projectileId: 91, castSpotanim: 90, hitSpotanim: 92 },
      { spellId: 'Fire Surge', projectileId: 1465, castSpotanim: 1464, hitSpotanim: 1466 },
      { spellId: 'Ice Rush', projectileId: 360, castSpotanim: -1, hitSpotanim: 361 },
    ].flatMap((spell) => [false, true, undefined].map((accurate) => ({ ...spell, accurate }))),
  )('preserves cast and flight but swaps the success impact for a splash for $spellId when accurate=$accurate', ({
    spellId,
    projectileId,
    castSpotanim,
    hitSpotanim,
    accurate,
  }) => {
    const launch = frame(0, [
      {
        type: 'attack_started',
        eventId: 1,
        tick: 0,
        sourceId: 'player',
        targetId: 'target',
        style: 'magic',
        attackKind: 'magic_air',
        spellId,
        spellCast:
          accurate === undefined
            ? undefined
            : {
                sourcePosition: [0, 0],
                targetPosition: [10, 0],
                targetSize: 1,
                accurate,
              },
      },
    ]);

    const effects = describePlayerEffects(launch);

    expect(effects.filter((effect) => effect.kind === 'projectile')).toMatchObject([
      {
        source: [0, 0],
        target: { position: [10, 0], size: 1 },
        visuals: { projectileId, hitSpotanim: accurate === false ? 85 : hitSpotanim },
        timing: { delay: 51 },
      },
    ]);
    expect(effects.filter((effect) => effect.kind === 'graphic').map((effect) => effect.spotAnimId)).toEqual(
      castSpotanim < 0 ? [] : [castSpotanim],
    );
  });

  it('keeps chronological overlap order when shots belong to different lifetime streams', () => {
    const frames = ['Wind Strike', 'Fire Strike', 'Wind Strike'].map((spellId, tick) =>
      frame(tick, [
        {
          type: 'attack_started',
          eventId: tick,
          tick,
          sourceId: 'player',
          targetId: 'target',
          style: 'magic',
          attackKind: 'magic_air',
          spellId,
        },
      ]),
    );
    const index = new ReplayEffectIndex(frames);

    const effects = index.playerEffects({ cycle: 60, throughFrameIndex: 2 }, () => 90);

    expect(effects.filter((effect) => effect.kind === 'projectile').map((effect) => effect.tick)).toEqual([0, 1, 2]);
  });
  it('keeps only the latest graphic when its predecessor has a longer lifetime', () => {
    const index = new ReplayEffectIndex([frame(50, [graphic(50)]), frame(51, [graphic(51, 456)])]);

    const effects = index.playerEffects({ cycle: 52 * 30, throughFrameIndex: 1 }, (id) => (id === 123 ? 20000 : 10));

    expect(effects).toEqual([]);
  });

  it('keeps a long-lived graphic when seeking beyond a fixed history window', () => {
    const index = new ReplayEffectIndex([frame(50, [graphic(50)])]);

    const effects = index.playerEffects({ cycle: 10000, throughFrameIndex: 0 }, () => 20000);

    expect(effects).toMatchObject([{ kind: 'graphic', tick: 50 }]);
  });

  it('excludes later frames when the raw clock passes their event ticks', () => {
    const index = new ReplayEffectIndex([frame(50, [graphic(50)]), frame(51, [graphic(51, 456)])]);

    const effects = index.playerEffects({ cycle: 52 * 30, throughFrameIndex: 0 }, () => 90);

    expect(effects).toMatchObject([{ spotAnimId: 123 }]);
  });

  it('indexes appended frames without reading an existing prefix during scrubs', () => {
    const source = frame(0);
    let eventReads = 0;
    const frames: ReplayDisplayFrame[] = Array.from({ length: 10000 }, (_, tick) => ({
      state: { ...source.state, currentTick: tick },
      get events() {
        eventReads++;
        return [graphic(tick)];
      },
    }));
    const index = new ReplayEffectIndex(frames);
    eventReads = 0;

    for (const tick of [9999, 5000, 2000, 9000]) {
      index.extend();
      index.playerEffects({ cycle: tick * 30, throughFrameIndex: tick }, () => 90);
    }
    frames.push({
      state: { ...source.state, currentTick: 10000 },
      get events() {
        eventReads++;
        return [graphic(10000)];
      },
    });
    index.extend();

    expect(eventReads).toBe(1);
    expect(index.playerEffects({ cycle: 300000, throughFrameIndex: 10000 }, () => 90)).toMatchObject([{ tick: 10000 }]);
  });

  it('retains original geometry and weapon when the destination state changes', () => {
    const origin = frame(50, [shot(50)]);
    const destination = frame(51);
    destination.state.playerPosition = [40, 40];
    const index = new ReplayEffectIndex([origin, destination]);

    const effects = index.playerEffects({ cycle: 51 * 30, throughFrameIndex: 1 }, () => 90);

    expect(effects.filter((effect) => effect.kind === 'projectile')).toMatchObject([
      { kind: 'projectile', source: [0, 0], weaponId: 20997, target: { position: [10, 0] } },
    ]);
  });

  it('restores overlapping shots while retaining their independent clocks', () => {
    const index = new ReplayEffectIndex([frame(50, [shot(50)]), frame(51, [shot(51)])]);

    const effects = index.playerEffects({ cycle: 51 * 30, throughFrameIndex: 1 }, () => 90);

    expect(effects.filter((effect) => effect.kind === 'projectile').map((effect) => effect.tick)).toEqual([50, 51]);
  });

  it('keeps pending shots and expires them at the inclusive flight end plus one cycle', () => {
    const index = new ReplayEffectIndex([frame(0, [shot(0)])]);

    const observed = [0, 96.999, 97].map(
      (cycle) =>
        index.playerEffects({ cycle, throughFrameIndex: 0 }, () => 90).filter((effect) => effect.kind === 'projectile')
          .length,
    );

    expect(observed).toEqual([1, 1, 0]);
  });

  it('uses explicit Ancient cast positions and accuracy instead of destination geometry', () => {
    const launch = frame(50, [
      {
        type: 'attack_started',
        eventId: 1,
        tick: 50,
        sourceId: 'player',
        targetId: 'target',
        style: 'magic',
        attackKind: 'magic_water',
        spellId: 'Ice Barrage',
        weaponId: 24424,
        spellCast: { sourcePosition: [2, 3], targetPosition: [7, 9], targetSize: 3, accurate: false },
      },
    ]);

    const effects = describePlayerEffects(launch);

    expect(effects).toMatchObject([
      {
        kind: 'projectile',
        source: [2, 3],
        target: { position: [7, 9], size: 3 },
        visuals: { hitSpotanim: 85, hitSpotanimHeight: 124 },
        presentation: { origin: 'target', impactHeightMode: 'actor' },
      },
    ]);
  });

  it('preserves player-graphic-applied precedence over same-frame attack graphics', () => {
    const launch = frame(0, [
      graphic(0, 777),
      { type: 'spell_self_cast', eventId: 2, tick: 0, animationId: 1, spotAnimId: 888 },
    ]);

    const effects = describePlayerEffects(launch);

    expect(effects).toMatchObject([{ kind: 'graphic', spotAnimId: 777 }]);
  });

  it.each([
    { cycle: 67.5, endpoint: [10, 4.5] },
    { cycle: 82.5, endpoint: [10.5, 5] },
  ])('homes an airborne projectile along a queued death’s final two-step path at cycle $cycle', ({
    cycle,
    endpoint,
  }) => {
    const launch = frame(0, [shot(0)]);
    const target: NpcState = {
      ...corpse('target', 1, 0, 2),
      alive: true,
      hp: 1,
      position: [10, 4],
      previousPosition: [10, 4],
    };
    launch.state.npcs = [target];
    // The arrow starts at cycle 41. Put the final step on tick 2 so both segments are sampled
    // while it is airborne, at step fractions 0.25 and 0.75, rather than before its release.
    const still = frame(1);
    still.state.npcs = [target];
    const killed = frame(2);
    killed.state.npcs = [
      {
        ...target,
        alive: false,
        hp: 0,
        position: [11, 5],
        movementPath: [
          [10, 5],
          [11, 5],
        ],
        deathAnimationTick: 5,
      },
    ];
    const frames = [launch, still, killed];
    const index = new ReplayEffectIndex(frames);
    const destination = { cycle, throughFrameIndex: 2 };
    expect(index.actors.sampler(destination)(cycle, 0)('target')).toEqual(endpoint);

    const renderFlight = (history: ReplayDisplayFrame[], continuous = false) => {
      const effects = new ReplayEffectIndex(history);
      const projectile = effects.playerEffects(destination, () => 120).find((effect) => effect.kind === 'projectile');
      if (!projectile) throw new Error('Expected the launched player projectile to remain airborne');
      expect(cycle).toBeGreaterThanOrEqual(projectile.tick * 30 + projectile.visuals.projectileStartDelay);
      expect(cycle).toBeLessThan(projectileEndCycle(projectile));
      const controller = new ProjectileController();
      const renderer = new SpotAnimRenderer();
      const upsert = vi.spyOn(renderer, 'upsert');
      vi.spyOn(renderer, 'isLoaded').mockReturnValue(true);
      controller.consumeDescriptor(projectile, 0);
      const update = (at: number) => {
        controller.setReplaySampler(effects.actors.sampler({ cycle: at, throughFrameIndex: Math.floor(at / 30) }));
        controller.update(renderer, Math.floor(at / 30), at / 30, null);
      };
      if (continuous) for (let at = 0; at < cycle; at += 3.75) update(at);
      update(cycle);
      const transform = upsert.mock.lastCall?.[0].transform;
      expect(transform?.kind).toBe('static');
      const position = transform?.kind === 'static' ? transform.value.position : null;
      controller.dispose();
      renderer.dispose();
      return position;
    };
    // Retaining the final step must produce the same homing as the equivalent living mover, not
    // the pre-kill tile. Compare actual projectile transforms, not just actor-history samples.
    const living = frames.map((entry) => ({
      ...entry,
      state: { ...entry.state, npcs: entry.state.npcs.map((npc) => ({ ...npc, alive: true, hp: 1 })) },
    }));
    const stationary = frames.map((entry) => ({ ...entry, state: { ...entry.state, npcs: [target] } }));
    const sought = renderFlight(frames);
    expect(sought).toEqual(renderFlight(frames, true));
    expect(sought).toEqual(renderFlight(living));
    expect(sought).not.toEqual(renderFlight(stationary));
  });

  it('retains a disappeared target only for attachments that had already started', () => {
    const first = frame(50);
    const npc: NpcState = {
      id: 'target',
      npcTypeId: 1,
      archetypeId: 'test',
      role: 'npc',
      alive: true,
      position: [12, 4],
      previousPosition: [10, 4],
      facingAngle: 0,
      size: 1,
      hp: 1,
      maxHp: 1,
      history: new Map(),
    };
    first.state.npcs = [npc];
    const index = new ReplayEffectIndex([first, frame(51)]);
    const sample = index.actors.sampler({ cycle: 52 * 30, throughFrameIndex: 1 });

    const positions = [sample(52 * 30, 50 * 30)('target'), sample(52 * 30, 51 * 30)('target')];

    expect(positions).toEqual([[12, 4], null]);
  });

  it.each([true, false])('holds the last included snapshot actor beyond its tick when alive=%s', (alive) => {
    const first = frame(50);
    first.state.npcs = [
      {
        id: 'target',
        npcTypeId: 1,
        archetypeId: 'test',
        role: 'npc',
        alive,
        position: [12, 4],
        previousPosition: [10, 4],
        facingAngle: 0,
        size: 1,
        hp: 1,
        maxHp: 1,
        history: new Map(),
      },
    ];
    const index = new ReplayEffectIndex([first, frame(51)]);
    const held = index.actors.sampler({ cycle: 1560, throughFrameIndex: 0 }, 'snapshot');
    const removed = index.actors.sampler({ cycle: 1560, throughFrameIndex: 1 }, 'snapshot');
    expect(held(1560, 1560)('target')).toEqual([12, 4]);
    expect(removed(1560, 1560)('target')).toBeNull();
  });

  it('retains the first dead snapshot by reference after simulation pruning and reports exact age', () => {
    const dead = corpse('healer', 7705, 4, 10);
    const death = frame(10);
    death.state.npcs = [dead];
    const index = new ReplayEffectIndex([death, frame(20)]);

    const presentations = index.deathPresentations({ cycle: 20 * 30 + 3, throughFrameIndex: 1 }, 7000);

    expect(presentations).toEqual([{ npc: dead, elapsedMs: 6060 }]);
    expect(presentations[0]?.npc).toBe(dead);
  });

  it('expires corpses at the manager-provided maximum duration boundary', () => {
    const death = frame(10);
    death.state.npcs = [corpse('healer', 7705, 4, 10)];
    const index = new ReplayEffectIndex([death]);

    expect(index.deathPresentations({ cycle: 10 * 30 + 29, throughFrameIndex: 0 }, 600)).toHaveLength(1);
    expect(index.deathPresentations({ cycle: 11 * 30, throughFrameIndex: 0 }, 600)).toEqual([]);
  });

  it.each(['actor', 'type'] as const)('suppresses a pruned corpse after an explicit %s removal', (scope) => {
    const death = frame(10);
    death.state.npcs = [corpse('healer', 7705, 4, 10)];
    const removal = frame(
      11,
      scope === 'actor'
        ? [{ type: 'actor_despawned', actorId: 'healer', eventId: 2, tick: 11 }]
        : [{ type: 'actor_presentations_removed', npcTypeIds: [7705], eventId: 2, tick: 11 }],
    );
    const index = new ReplayEffectIndex([death, removal]);

    expect(index.deathPresentations({ cycle: 11 * 30, throughFrameIndex: 0 }, 6000)).toHaveLength(1);
    expect(index.deathPresentations({ cycle: 11 * 30, throughFrameIndex: 1 }, 6000)).toEqual([]);
  });

  it('ignores malformed clear suppression and isolates actor-id reuse by spawn life', () => {
    const firstDeath = frame(10);
    firstDeath.state.npcs = [corpse('healer', 7705, 4, 10)];
    const malformed = frame(11, [
      { type: 'actor_presentations_removed', npcTypeIds: [7705, 'bad'], eventId: 2, tick: 11 },
    ]);
    const replacementDeath = frame(12);
    const replacement = corpse('healer', 7705, 12, 12);
    replacementDeath.state.npcs = [replacement];
    const index = new ReplayEffectIndex([firstDeath, malformed, replacementDeath]);

    expect(index.deathPresentations({ cycle: 12 * 30, throughFrameIndex: 2 }, 6000).map(({ npc }) => npc)).toEqual([
      firstDeath.state.npcs[0],
      replacement,
    ]);
  });
});
