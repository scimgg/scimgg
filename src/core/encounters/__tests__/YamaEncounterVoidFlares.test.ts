import { beforeEach, describe, expect, it } from 'vitest';
import { YAMA_SPAWN_VOID_FLARE_COMMAND } from '../../../encounters/yamaP3/commands';
import { DEFAULT_YAMA_ATTACK_PATTERN, getCycleLength, VOID_FLARE_NPC_ID } from '../../../encounters/yamaP3/constants';
import {
  BLOODIED_BLOWS_CONFIG,
  DIVINE_SEVERANCE_CONFIG,
  SENSORY_CLOUDING_CONFIG,
  VOID_FLARE_CHARGE_TICKS,
} from '../../../encounters/yamaP3/contractConfig';
import { YamaEncounter } from '../../../encounters/yamaP3/YamaEncounter';
import { voidFlareDefinition, voidFlareExplosionHeal } from '../../../npcs/yama/voidFlare';
import { createEncounterActorOps } from '../../../test/helpers/encounterActorOps';
import { runEncounterNpcActions } from '../../../test/helpers/encounterNpcBand';
import { createUnusedPlayerControlOps } from '../../../test/helpers/playerControlStubs';
import { createEmptyStats } from '../../../types/equipmentStats';
import { createDefaultStats } from '../../../types/playerState';
import type { Coordinate, TickNumber } from '../../../types/simulation';
import type { PlayerActor } from '../../actors/PlayerActor';
import { TickEvents } from '../../events/TickEvents';
import { WorldState } from '../../WorldState';
import type { EncounterContext } from '../types';

const CYCLE_LENGTH = getCycleLength(DEFAULT_YAMA_ATTACK_PATTERN);

const VOID_FLARE_SPAWN_CYCLE_TICK = 60;

const FIRST_SPAWN_TICK = VOID_FLARE_SPAWN_CYCLE_TICK;

/**
 * Void flares are decided on a beat but spawn on the attack tick that beat queues.
 * Capture `yama-packet-data.txt` (P3 control t810): every P3 flare add — t871, t899,
 * t941 — lands on an `npc_yama01_*` attack animation tick (control + 5 + 7k), never
 * on the beat before it.
 */
function runSwingTick(enc: YamaEncounter, world: WorldState, swingTick: number): void {
  world.tick = swingTick;
  runEncounterNpcActions(enc, makeEncounterContext(world, swingTick), enc.getDefaultMechanicsConfig());
}

function runBeatAndSwing(enc: YamaEncounter, world: WorldState, beatTick: number): void {
  world.tick = beatTick;
  enc.processPostTick(makeEncounterContext(world, beatTick), enc.getDefaultMechanicsConfig());
  runSwingTick(enc, world, beatTick + 1);
}

function makePlayer(pos: Coordinate = [31, 25]): PlayerActor {
  return {
    id: 'player',
    kind: 'player',
    alive: true,
    position: pos,
    previousPosition: pos,
    facing: 0,
    size: 1,
    vitals: { hp: 99, maxHp: 99 },
    movementPath: [],
    isMoving: false,
    isRunning: false,
    activePrayer: null,
    offensivePrayer: null,
    independentPrayers: [],
    isRunEnabled: false,
    isSpecialAttackActive: false,
    pendingInputOps: [],
    quickPrayersActive: false,
    runEnergy: { current: 10000, regenCounter: 0 },
    history: new Map<TickNumber, Coordinate>(),
    // Real values, not `{}`: Yama rolls accuracy against the player's levels and defensive
    // bonuses every swing, and a stubbed player throws inside the formula.
    stats: createDefaultStats(),
    equipmentStats: createEmptyStats(),
    specialAttack: {} as any,
    combatTimers: {} as any,
    potionBoosts: [],
    inventory: {} as any,
    prayerState: {} as any,
    equipment: {} as any,
    cooldownTracks: {} as any,
    attackTarget: null,
    autoAttackPause: null,
    attackInteractionActive: true,
    pendingConflictionAttack: null,
  } as any;
}

function makeEncounterContext(world: WorldState, tick: number, playerPos: Coordinate = [31, 25]): EncounterContext {
  const tickEvents = new TickEvents();
  tickEvents.setTick(tick);
  return {
    tick,
    playerPos,
    world,
    tickEvents,
    logEvent: () => {},
    grantNextAttackSpeedup: () => {},
    ...createEncounterActorOps(world),
    ...createUnusedPlayerControlOps(),
  };
}

function setupEncounterWithPlayer(encounter: YamaEncounter, playerPos: Coordinate = [31, 25]): WorldState {
  const world = new WorldState();
  const player = makePlayer(playerPos);
  world.actors.set('player', player);

  const npcs = encounter.createNpcs(playerPos);
  for (const npc of npcs) {
    world.actors.set(npc.id, npc);
  }

  return world;
}

describe('YamaEncounter — Void Flares', () => {
  let encounter: YamaEncounter;

  beforeEach(() => {
    encounter = new YamaEncounter();
    encounter.reset({ fireballSeed: 0, firstRangeMageType: 'magic' });
  });

  describe('spawn timing', () => {
    it('void flares spawn one tick after the cycle beat, alongside the swing it queued', () => {
      const world = setupEncounterWithPlayer(encounter);

      encounter.processPostTick(makeEncounterContext(world, FIRST_SPAWN_TICK), encounter.getDefaultMechanicsConfig());
      expect(world.getNpcs().filter((n) => n.npcTypeId === 14179).length).toBe(0);

      runSwingTick(encounter, world, FIRST_SPAWN_TICK + 1);

      const flares = world.getNpcs().filter((n) => n.npcTypeId === 14179);
      expect(flares.length).toBeGreaterThan(0);
    });

    it('does NOT spawn void flares off the cycle beat', () => {
      const world = setupEncounterWithPlayer(encounter);

      runBeatAndSwing(encounter, world, 59);

      const flares = world.getNpcs().filter((n) => n.npcTypeId === 14179);
      expect(flares.length).toBe(0);
    });

    it('spawns 2 flares per cycle', () => {
      const world = setupEncounterWithPlayer(encounter);

      runBeatAndSwing(encounter, world, FIRST_SPAWN_TICK);

      const flares = world.getNpcs().filter((n) => n.npcTypeId === 14179);
      expect(flares.length).toBe(2);
    });

    it('spawns again in next cycle (tick 60 + 70 = 130)', () => {
      const world = setupEncounterWithPlayer(encounter);

      runBeatAndSwing(encounter, world, FIRST_SPAWN_TICK);
      runBeatAndSwing(encounter, world, FIRST_SPAWN_TICK + CYCLE_LENGTH);

      const flares = world.getNpcs().filter((n) => n.npcTypeId === 14179);
      expect(flares.length).toBe(4);
    });
  });

  describe('spawn positions', () => {
    const VALID_POSITIONS: Coordinate[] = [
      [26, 25],
      [35, 25],
      [23, 33],
      [38, 33],
    ];

    it('flares only spawn at the 4 valid positions', () => {
      const world = setupEncounterWithPlayer(encounter);

      runBeatAndSwing(encounter, world, FIRST_SPAWN_TICK);

      const flares = world.getNpcs().filter((n) => n.npcTypeId === 14179);
      expect(flares.length).toBe(2);

      for (const flare of flares) {
        const matchesValid = VALID_POSITIONS.some(([x, y]) => flare.position[0] === x && flare.position[1] === y);
        expect(matchesValid).toBe(true);
      }
    });

    it('flares spawn at both valid positions across different seeds', () => {
      const seenPositions = new Set<string>();

      for (let seed = 0; seed < 100; seed++) {
        const enc = new YamaEncounter();
        enc.reset({ fireballSeed: seed, firstRangeMageType: 'magic' });
        const world = setupEncounterWithPlayer(enc);
        runBeatAndSwing(enc, world, FIRST_SPAWN_TICK);

        const flares = world.getNpcs().filter((n) => n.npcTypeId === 14179);
        for (const flare of flares) {
          seenPositions.add(`${flare.position[0]},${flare.position[1]}`);
          const matchesValid = VALID_POSITIONS.some(([x, y]) => flare.position[0] === x && flare.position[1] === y);
          expect(matchesValid).toBe(true);
        }
      }

      expect(seenPositions.has('26,25')).toBe(true);
      expect(seenPositions.has('35,25')).toBe(true);
      expect(seenPositions.size).toBeLessThanOrEqual(4);
    });

    it('reset restarts flare id and corner while dropping a deferred spawn', () => {
      const seeds = {
        encounterSeed: 17,
        fireballSeed: 23,
        voidFlareSeed: 29,
        firstRangeMageType: 'magic',
      } as const;
      encounter.reset(seeds);
      const firstWorld = setupEncounterWithPlayer(encounter);
      const first = encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [31, 25],
          tick: 10,
          world: firstWorld,
          ...createEncounterActorOps(firstWorld),
        },
        {},
      );
      encounter.processPostTick(
        makeEncounterContext(firstWorld, FIRST_SPAWN_TICK),
        encounter.getDefaultMechanicsConfig(),
      );

      encounter.reset(seeds);
      const resetWorld = setupEncounterWithPlayer(encounter);
      runSwingTick(encounter, resetWorld, FIRST_SPAWN_TICK + 1);
      const afterDeferredTick = resetWorld.getNpcs().filter((npc) => npc.npcTypeId === 14179);
      const reset = encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [31, 25],
          tick: 10,
          world: resetWorld,
          ...createEncounterActorOps(resetWorld),
        },
        {},
      );

      expect(afterDeferredTick).toEqual([]);
      expect(first?.gameEvents?.[0]).toMatchObject({ flareId: 'vf-0' });
      expect(reset?.gameEvents?.[0]).toEqual(first?.gameEvents?.[0]);
    });
  });

  describe('max active limit', () => {
    it('max 4 active void flares (additional spawns capped)', () => {
      const world = setupEncounterWithPlayer(encounter);

      runBeatAndSwing(encounter, world, FIRST_SPAWN_TICK);
      runBeatAndSwing(encounter, world, FIRST_SPAWN_TICK + CYCLE_LENGTH);

      expect(world.getNpcs().filter((n) => n.npcTypeId === 14179 && n.alive).length).toBe(4);

      runBeatAndSwing(encounter, world, FIRST_SPAWN_TICK + CYCLE_LENGTH * 2);

      const aliveFlares = world.getNpcs().filter((n) => n.npcTypeId === 14179 && n.alive);
      expect(aliveFlares.length).toBe(4);
    });
  });

  describe('kill-prevents-explosion', () => {
    it('killed void flare does NOT produce explosion damage', () => {
      const world = setupEncounterWithPlayer(encounter);

      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [31, 25],
          tick: 10,
          world,
          ...createEncounterActorOps(world),
        },
        {},
      );

      const flares = world.getNpcs().filter((n) => n.npcTypeId === 14179);
      expect(flares.length).toBe(1);
      const flare = flares[0];

      flare.alive = false;

      const explodeTick = 10 + VOID_FLARE_CHARGE_TICKS;
      world.tick = explodeTick;

      const damages = encounter.resolveHazards(
        makeEncounterContext(world, explodeTick, flare.position),
        encounter.getDefaultMechanicsConfig(),
      );

      const flareDamages = damages.filter((d) => d.source === 'VoidFlare');
      expect(flareDamages.length).toBe(0);
    });

    it('frees capacity without reusing the killed flare id or exploding it later', () => {
      const world = setupEncounterWithPlayer(encounter);
      const actorOps = createEncounterActorOps(world);
      for (let index = 0; index < 4; index++) {
        encounter.executeCommand(
          YAMA_SPAWN_VOID_FLARE_COMMAND,
          { playerPos: [31, 25], tick: 10, world, ...actorOps },
          {},
        );
      }
      const killed = world.getNpc('vf-1');
      if (!killed) throw new TypeError('Expected vf-1');
      killed.alive = false;

      const cleanupContext = makeEncounterContext(world, 11);
      encounter.resolveHazards(cleanupContext, encounter.getDefaultMechanicsConfig());
      expect(cleanupContext.tickEvents.flush().filter((event) => event.type === 'voidflare_destroyed')).toMatchObject([
        { flareId: 'vf-1' },
      ]);

      const replacement = encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        { playerPos: [31, 25], tick: 12, world, ...actorOps },
        {},
      );
      expect(replacement?.gameEvents).toMatchObject([{ type: 'voidflare_spawned', flareId: 'vf-4' }]);
      const replacementActor = world.getNpc('vf-4');
      if (!replacementActor) throw new TypeError('Expected replacement flare');
      expect(voidFlareDefinition.getState(replacementActor)?.damageRollIndex).toBe(4);
      expect(world.getNpcs().filter((npc) => npc.npcTypeId === VOID_FLARE_NPC_ID && npc.alive)).toHaveLength(4);

      const explosionContext = makeEncounterContext(world, 10 + VOID_FLARE_CHARGE_TICKS);
      encounter.resolveHazards(explosionContext, encounter.getDefaultMechanicsConfig());
      const damages = encounter.resolveHazards(
        makeEncounterContext(world, 11 + VOID_FLARE_CHARGE_TICKS),
        encounter.getDefaultMechanicsConfig(),
      );
      const explodedIds = explosionContext.tickEvents
        .flush()
        .flatMap((event) =>
          event.type === 'voidflare_exploded' && typeof event.flareId === 'string' ? [event.flareId] : [],
        );
      expect(explodedIds).toEqual(['vf-0', 'vf-2', 'vf-3']);
      expect(damages.filter((damage) => damage.source === 'VoidFlare')).toHaveLength(3);
    });
  });

  describe('natural explosion', () => {
    it('alive void flare produces 10-27 typeless damage one tick after explodeTick', () => {
      const world = setupEncounterWithPlayer(encounter);

      const spawnTick = 10;
      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [31, 25],
          tick: spawnTick,
          world,
          ...createEncounterActorOps(world),
        },
        {},
      );

      const flares = world.getNpcs().filter((n) => n.npcTypeId === 14179);
      expect(flares.length).toBe(1);
      const flare = flares[0];
      expect(flare.alive).toBe(true);

      const player = world.getPlayer()!;
      player.position = [...flare.position] as Coordinate;

      const explodeTick = spawnTick + VOID_FLARE_CHARGE_TICKS;
      world.tick = explodeTick;

      expect(
        encounter
          .resolveHazards(
            makeEncounterContext(world, explodeTick, flare.position),
            encounter.getDefaultMechanicsConfig(),
          )
          .filter((d) => d.source === 'VoidFlare'),
      ).toEqual([]);

      world.tick = explodeTick + 1;
      const damages = encounter.resolveHazards(
        makeEncounterContext(world, explodeTick + 1, flare.position),
        encounter.getDefaultMechanicsConfig(),
      );

      const flareDamages = damages.filter((d) => d.source === 'VoidFlare');
      expect(flareDamages.length).toBe(1);
      expect(flareDamages[0].baseDamage).toBeGreaterThanOrEqual(10);
      expect(flareDamages[0].baseDamage).toBeLessThanOrEqual(27);
      expect(flareDamages[0].attackType).toBe('typeless');
    });

    /**
     * Drives the real detonation path, not the band helper: this is what fails if the runtime
     * ever reads a flare's SPAWN hitpoints instead of its live ones, which is the entire mechanic
     * and which every assertion against `voidFlareExplosionBand` alone would still pass.
     *
     * Both runs share an encounter seed, spawn tick and flare index, so the roll WITHIN the band
     * is identical and the whole gap is the health term: `floor(7/16 * 71) - floor(7/16 * 1)`.
     */
    it('rolls bloodied blows explosions off the flare live hitpoints', () => {
      const detonateAt = (flareHp: number): number[] => {
        const enc = new YamaEncounter(BLOODIED_BLOWS_CONFIG, 1234);
        const world = setupEncounterWithPlayer(enc);
        const spawnTick = 10;
        enc.executeCommand(
          YAMA_SPAWN_VOID_FLARE_COMMAND,
          { playerPos: [31, 25], tick: spawnTick, world, ...createEncounterActorOps(world) },
          {},
        );

        const flares = world.getNpcs().filter((n) => n.npcTypeId === VOID_FLARE_NPC_ID);
        expect(flares.length).toBeGreaterThan(0);
        for (const flare of flares) {
          flare.vitals = { ...flare.vitals, hp: flareHp };
        }
        world.getPlayer()!.position = [...flares[0].position] as Coordinate;

        const explodeTick = spawnTick + VOID_FLARE_CHARGE_TICKS;
        world.tick = explodeTick;
        enc.resolveHazards(
          makeEncounterContext(world, explodeTick, flares[0].position),
          enc.getDefaultMechanicsConfig(),
        );
        world.tick = explodeTick + 1;
        return enc
          .resolveHazards(
            makeEncounterContext(world, explodeTick + 1, flares[0].position),
            enc.getDefaultMechanicsConfig(),
          )
          .filter((d) => d.source === 'VoidFlare')
          .map((d) => {
            if (typeof d.baseDamage !== 'number') {
              throw new Error(`void flare damage is a single roll, got range ${JSON.stringify(d.baseDamage)}`);
            }
            return d.baseDamage;
          })
          .sort((a, b) => a - b);
      };

      const untouched = detonateAt(71);
      const spent = detonateAt(1);

      expect(untouched.length).toBe(spent.length);
      expect(untouched.length).toBeGreaterThan(0);
      for (const [index, damage] of untouched.entries()) {
        expect(damage - spent[index]).toBe(31);
        expect(damage).toBeGreaterThanOrEqual(39);
        expect(damage).toBeLessThanOrEqual(48);
        expect(spent[index]).toBeGreaterThanOrEqual(8);
        expect(spent[index]).toBeLessThanOrEqual(17);
      }
    });

    it.each([0, 23])('preserves the seeded damage trace with explicit sequential roll indices for seed %i', (seed) => {
      encounter.reset({ encounterSeed: 17, fireballSeed: seed, voidFlareSeed: 29, firstRangeMageType: 'magic' });
      const world = setupEncounterWithPlayer(encounter);

      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [0, 0],
          tick: 10,
          world,
          ...createEncounterActorOps(world),
        },
        {},
      );
      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [0, 0],
          tick: 12,
          world,
          ...createEncounterActorOps(world),
        },
        {},
      );

      const flares = world.getNpcs().filter((n) => n.npcTypeId === 14179);
      expect(flares).toHaveLength(2);

      expect(
        flares.map((flare) => ({ id: flare.id, index: voidFlareDefinition.getState(flare)?.damageRollIndex })),
      ).toEqual([
        { id: 'vf-0', index: 0 },
        { id: 'vf-1', index: 1 },
      ]);
      const expectedDamage = (seed: number, tick: number, flareIndex: number) => {
        const hash = (((seed * 2654435761 + (tick * 100 + flareIndex) * 340573321) >>> 0) % 18) + 10;
        return hash;
      };

      const firstExplodeTick = 10 + VOID_FLARE_CHARGE_TICKS;
      const secondExplodeTick = 12 + VOID_FLARE_CHARGE_TICKS;
      const firstPlayerPos = [...flares[0].position] as Coordinate;
      const secondPlayerPos = [...flares[1].position] as Coordinate;

      // The roll is taken on the detonation tick even though the hit lands on the next one, so
      // both expectations stay keyed to explodeTick.
      const explodeThenImpact = (explodeTick: number, playerPos: Coordinate) => {
        world.tick = explodeTick;
        encounter.resolveHazards(
          makeEncounterContext(world, explodeTick, playerPos),
          encounter.getDefaultMechanicsConfig(),
        );
        world.tick = explodeTick + 1;
        return encounter
          .resolveHazards(
            makeEncounterContext(world, explodeTick + 1, playerPos),
            encounter.getDefaultMechanicsConfig(),
          )
          .filter((d) => d.source === 'VoidFlare');
      };

      const player = world.getPlayer()!;
      player.position = [...firstPlayerPos];
      const firstDamage = explodeThenImpact(firstExplodeTick, firstPlayerPos);
      expect(firstDamage).toHaveLength(1);
      expect(firstDamage[0].baseDamage).toBe(expectedDamage(seed, firstExplodeTick, 0));

      player.position = [...secondPlayerPos];
      const secondDamage = explodeThenImpact(secondExplodeTick, secondPlayerPos);
      expect(secondDamage).toHaveLength(1);
      expect(secondDamage[0].baseDamage).toBe(expectedDamage(seed, secondExplodeTick, 1));

      expect(expectedDamage(seed, firstExplodeTick, 0)).not.toBe(expectedDamage(seed, secondExplodeTick, 1));
    });

    it('void flare explosion damages player regardless of position', () => {
      const world = setupEncounterWithPlayer(encounter);

      const spawnTick = 10;
      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [31, 25],
          tick: spawnTick,
          world,
          ...createEncounterActorOps(world),
        },
        {},
      );

      const player = world.getPlayer()!;
      player.position = [17, 2];

      const explodeTick = spawnTick + VOID_FLARE_CHARGE_TICKS;
      world.tick = explodeTick;
      encounter.resolveHazards(
        makeEncounterContext(world, explodeTick, [17, 2]),
        encounter.getDefaultMechanicsConfig(),
      );

      world.tick = explodeTick + 1;
      const damages = encounter.resolveHazards(
        makeEncounterContext(world, explodeTick + 1, [17, 2]),
        encounter.getDefaultMechanicsConfig(),
      );

      const flareDamages = damages.filter((d) => d.source === 'VoidFlare');
      expect(flareDamages.length).toBe(1);
      expect(flareDamages[0].baseDamage).toBeGreaterThanOrEqual(10);
      expect(flareDamages[0].baseDamage).toBeLessThanOrEqual(27);
      expect(flareDamages[0].attackType).toBe('typeless');
    });

    it('flare is marked dead after explosion', () => {
      const world = setupEncounterWithPlayer(encounter);

      const spawnTick = 10;
      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [31, 25],
          tick: spawnTick,
          world,
          ...createEncounterActorOps(world),
        },
        {},
      );

      const flare = world.getNpcs().filter((n) => n.npcTypeId === 14179)[0];
      expect(flare.alive).toBe(true);

      const player = world.getPlayer()!;
      player.position = [...flare.position] as Coordinate;

      const explodeTick = spawnTick + VOID_FLARE_CHARGE_TICKS;
      world.tick = explodeTick;

      encounter.resolveHazards(
        makeEncounterContext(world, explodeTick, flare.position),
        encounter.getDefaultMechanicsConfig(),
      );

      expect(flare.alive).toBe(false);
    });

    it('keeps a detached impact after the exploded flare leaves the world', () => {
      const world = setupEncounterWithPlayer(encounter);
      const spawnTick = 10;
      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        { playerPos: [31, 25], tick: spawnTick, world, ...createEncounterActorOps(world) },
        {},
      );
      const flare = world.getNpc('vf-0');
      if (!flare) throw new TypeError('Expected vf-0');
      const explodeTick = spawnTick + VOID_FLARE_CHARGE_TICKS;

      encounter.resolveHazards(
        makeEncounterContext(world, explodeTick, flare.position),
        encounter.getDefaultMechanicsConfig(),
      );
      world.actors.delete(flare.id);
      const damages = encounter.resolveHazards(
        makeEncounterContext(world, explodeTick + 1, flare.position),
        encounter.getDefaultMechanicsConfig(),
      );

      expect(damages.filter((damage) => damage.source === 'VoidFlare')).toHaveLength(1);
    });
  });

  describe('explosion heals Yama', () => {
    function explodeOneFlare(enc: YamaEncounter, world: WorldState) {
      const spawnTick = 10;
      enc.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        { playerPos: [31, 25], tick: spawnTick, world, ...createEncounterActorOps(world) },
        {},
      );
      const explodeTick = spawnTick + VOID_FLARE_CHARGE_TICKS;
      world.tick = explodeTick;
      const ctx = makeEncounterContext(world, explodeTick, [31, 25]);
      enc.resolveHazards(ctx, enc.getDefaultMechanicsConfig());
      const flushed = ctx.tickEvents.flush();
      world.tick = explodeTick + 1;
      const damages = enc
        .resolveHazards(makeEncounterContext(world, explodeTick + 1, [31, 25]), enc.getDefaultMechanicsConfig())
        .filter((d) => d.source === 'VoidFlare');
      const damage = damages[0]?.baseDamage;
      if (typeof damage !== 'number') throw new TypeError('Expected one rolled void flare explosion');
      const exploded = flushed.filter((event) => event.type === 'voidflare_exploded');
      const splats = flushed.filter((event) => event.type === 'hitsplat_spawned');
      return { damage, event: exploded[0], splats };
    }

    it('restores floor(8 * damage / 3) hitpoints and reports it on the explosion event', () => {
      const world = setupEncounterWithPlayer(encounter);
      const yama = world.getNpc('yama')!;
      const before = yama.vitals.hp;

      const { damage, event, splats } = explodeOneFlare(encounter, world);

      const expected = voidFlareExplosionHeal(damage);
      expect(expected).toBeGreaterThan(0);
      expect(yama.vitals.hp).toBe(before + expected);
      expect(event).toMatchObject({ damage, heal: expected });
      // The capture renders this as `hit id=6` on Yama (RuneLite HitsplatID.HEAL), so the sim owes
      // the player the same green splat rather than a silent health-bar jump.
      expect(splats).toMatchObject([{ targetId: 'yama', amount: expected, hitsplatType: 'heal' }]);
    });

    it('clamps the heal to Yama full-fight pool and reports only what it restored', () => {
      const world = setupEncounterWithPlayer(encounter);
      const yama = world.getNpc('yama')!;
      yama.vitals = { ...yama.vitals, hp: yama.vitals.maxHp - 5 };

      const { event } = explodeOneFlare(encounter, world);

      expect(yama.vitals.hp).toBe(yama.vitals.maxHp);
      expect(event).toMatchObject({ heal: 5 });
    });

    it('heals nothing when the flare is killed before its fuse runs out', () => {
      const world = setupEncounterWithPlayer(encounter);
      const yama = world.getNpc('yama')!;
      const before = yama.vitals.hp;

      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        { playerPos: [31, 25], tick: 10, world, ...createEncounterActorOps(world) },
        {},
      );
      world.getNpcs().filter((n) => n.npcTypeId === VOID_FLARE_NPC_ID)[0].alive = false;
      world.tick = 10 + VOID_FLARE_CHARGE_TICKS;
      encounter.resolveHazards(
        makeEncounterContext(world, 10 + VOID_FLARE_CHARGE_TICKS, [31, 25]),
        encounter.getDefaultMechanicsConfig(),
      );

      expect(yama.vitals.hp).toBe(before);
    });

    it('heals nothing under a contract whose explosions are lethal', () => {
      const lethal = new YamaEncounter(SENSORY_CLOUDING_CONFIG);
      lethal.reset({ fireballSeed: 0, firstRangeMageType: 'magic' });
      const world = setupEncounterWithPlayer(lethal);
      const yama = world.getNpc('yama')!;
      const before = yama.vitals.hp;

      const { damage, event } = explodeOneFlare(lethal, world);

      expect(damage).toBe(999);
      expect(yama.vitals.hp).toBe(before);
      expect(event).toMatchObject({ heal: 0 });
    });

    it('reproduces every damage/heal pair the captures contain', () => {
      expect([10, 22, 23, 26, 27, 38].map(voidFlareExplosionHeal)).toEqual([26, 58, 61, 69, 72, 101]);
      expect(voidFlareExplosionHeal(0)).toBe(0);
    });
  });

  describe('debug spawn action', () => {
    it('creates a void flare NpcActor in the world', () => {
      const world = setupEncounterWithPlayer(encounter);

      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [31, 25],
          tick: 10,
          world,
          ...createEncounterActorOps(world),
        },
        {},
      );

      const flares = world.getNpcs().filter((n) => n.npcTypeId === 14179);
      expect(flares.length).toBe(1);
      expect(flares[0].alive).toBe(true);
      expect(flares[0].size).toBe(2);
      expect(flares[0].archetypeId).toBe('voidflare');
    });

    it('pins the actor timing, identity, hitpoints, variant, and exact spawn event', () => {
      const world = setupEncounterWithPlayer(encounter);
      const spawnTick = 10;

      const result = encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        { playerPos: [31, 25], tick: spawnTick, world, ...createEncounterActorOps(world) },
        {},
      );
      const flare = world.getNpc('vf-0');
      if (!flare) throw new TypeError('Expected vf-0');

      expect({
        id: flare.id,
        npcTypeId: flare.npcTypeId,
        archetypeId: flare.archetypeId,
        role: flare.role,
        size: flare.size,
        hp: flare.vitals.hp,
        maxHp: flare.vitals.maxHp,
        spawnTick: flare.spawnTick,
        despawnTick: flare.despawnTick,
      }).toEqual({
        id: 'vf-0',
        npcTypeId: VOID_FLARE_NPC_ID,
        archetypeId: 'voidflare',
        role: 'minion',
        size: 2,
        hp: 71,
        maxHp: 140,
        spawnTick,
        despawnTick: spawnTick + VOID_FLARE_CHARGE_TICKS,
      });
      expect(result?.gameEvents).toEqual([
        {
          type: 'voidflare_spawned',
          flareId: 'vf-0',
          position: flare.position,
          variant: 'shadow',
        },
      ]);
    });

    it('returns gameEvents with voidflare_spawned event', () => {
      const world = setupEncounterWithPlayer(encounter);

      const result = encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [31, 25],
          tick: 10,
          world,
          ...createEncounterActorOps(world),
        },
        {},
      );

      expect(result).toBeDefined();
      expect(result!.gameEvents).toBeDefined();
      expect(result!.gameEvents!.length).toBe(1);
      expect(result!.gameEvents![0]).toMatchObject({
        type: 'voidflare_spawned',
        variant: 'shadow',
      });
    });

    it('respects max 4 active limit', () => {
      const world = setupEncounterWithPlayer(encounter);

      for (let i = 0; i < 4; i++) {
        encounter.executeCommand(
          YAMA_SPAWN_VOID_FLARE_COMMAND,
          {
            playerPos: [31, 25],
            tick: 10 + i,
            world,
            ...createEncounterActorOps(world),
          },
          {},
        );
      }

      const flaresBefore = world.getNpcs().filter((n) => n.npcTypeId === 14179 && n.alive);
      expect(flaresBefore.length).toBe(4);

      const result = encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        {
          playerPos: [31, 25],
          tick: 20,
          world,
          ...createEncounterActorOps(world),
        },
        {},
      );

      expect(result).toEqual({});
      const flaresAfter = world.getNpcs().filter((n) => n.npcTypeId === 14179 && n.alive);
      expect(flaresAfter.length).toBe(4);
    });
  });

  describe('mixed spawn sources', () => {
    it('spawns Divine continuous first, then deferred melee and beat flares up to max active', () => {
      const divine = new YamaEncounter(DIVINE_SEVERANCE_CONFIG);
      divine.reset({ encounterSeed: 0, fireballSeed: 0, voidFlareSeed: 0, firstRangeMageType: 'magic' });
      const playerPos: Coordinate = [31, 33];
      const world = setupEncounterWithPlayer(divine, playerPos);
      const postContext = makeEncounterContext(world, 60, playerPos);

      divine.processPostTick(postContext, divine.getDefaultMechanicsConfig());
      expect(postContext.tickEvents.flush().filter((event) => event.type === 'voidflare_spawned')).toMatchObject([
        { flareId: 'vf-0', variant: 'shadow' },
      ]);

      const swingContext = makeEncounterContext(world, 61, playerPos);
      runEncounterNpcActions(divine, swingContext, divine.getDefaultMechanicsConfig());
      expect(swingContext.tickEvents.flush().filter((event) => event.type === 'voidflare_spawned')).toMatchObject([
        { flareId: 'vf-1', variant: 'shadow' },
        { flareId: 'vf-2', variant: 'shadow' },
        { flareId: 'vf-3', variant: 'shadow' },
      ]);
      expect(
        world
          .getNpcs()
          .filter((npc) => npc.npcTypeId === VOID_FLARE_NPC_ID && npc.alive)
          .map((npc) => ({ id: npc.id, hp: npc.vitals.hp, spawnTick: npc.spawnTick })),
      ).toEqual([
        { id: 'vf-0', hp: 81, spawnTick: 60 },
        { id: 'vf-1', hp: 71, spawnTick: 61 },
        { id: 'vf-2', hp: 71, spawnTick: 61 },
        { id: 'vf-3', hp: 71, spawnTick: 61 },
      ]);
    });
  });

  describe('defeat cleanup', () => {
    it('destroys tracked living flares in insertion order before the overhead text', () => {
      const world = setupEncounterWithPlayer(encounter);
      const actorOps = createEncounterActorOps(world);
      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        { playerPos: [31, 25], tick: 10, world, ...actorOps },
        {},
      );
      encounter.executeCommand(
        YAMA_SPAWN_VOID_FLARE_COMMAND,
        { playerPos: [31, 25], tick: 11, world, ...actorOps },
        {},
      );
      const defeatContext = makeEncounterContext(world, 25);

      encounter.onNpcDefeated({ npcId: 'yama', tick: 25 }, defeatContext, 'encounter-owned');

      expect(
        defeatContext.tickEvents
          .flush()
          .filter((event) => event.type === 'voidflare_destroyed' || event.type === 'overhead_text')
          .map((event) => (event.type === 'voidflare_destroyed' ? `${event.type}:${event.flareId}` : event.type)),
      ).toEqual(['voidflare_destroyed:vf-0', 'voidflare_destroyed:vf-1', 'overhead_text']);
      expect([world.getNpc('vf-0')?.despawnTick, world.getNpc('vf-1')?.despawnTick]).toEqual([25, 25]);
    });
  });
});
