import { describe, expect, it } from 'vitest';
import { WorldState } from '../../../core/WorldState';
import {
  BEAM_CRYSTAL_EDGES,
  type CrystalActor,
  createCrystal,
  crystalBeamDirection,
  crystalDefinition,
} from '../../../npcs/colosseum/crystal';
import { colosseumBeamGraphics } from '../../../npcs/colosseum/visualEvents';
import type { Coordinate } from '../../../types/simulation';
import { type BeamRound, SolBeamRounds } from '../beams';
import {
  BEAM_ENRAGE_READY_DELAY_TICKS,
  BEAM_READY_DELAY_TICKS,
  SAND_POOL_DELAY_TICKS,
  SOL_DEATH_CLEANUP_DELAY_TICKS,
  SOL_DEATH_SAND_REMOVAL_DELAY_TICKS,
} from '../constants';
import { isEnraged, SOL_PHASE_TRANSITIONS, type SolPhase } from '../phases';
import { type CapturedPoolDeath, SOL_BEAM_TIMELINES, SOL_POOL_DEATHS } from './fixtures/solBeamCapture';

/**
 * Replays each capture's crystals and beam rounds through the production scheduler and crystal
 * patrol, in the engine's stage order (crystals move, then the encounter processes the tick), and
 * requires every warning, charge, fire and crystal step to land on the recorded tick and tile, and
 * every charge and fire graphic (map_anims 2689-2697) to match the capture's id, tile and delay.
 *
 * Four inputs come from the capture rather than the model: where each crystal spawns (it varies
 * between fights along the same edge), the ticks Sol telegraphed an attack (a warning can only go
 * out on one), which crystals the server processes before Sol, and each ready-delay roll. The roll
 * is the smallest value the capture allows, and the test fails if that value falls outside the model's range for the phase. Enrage makes an idle
 * clock ready at once, so a fire before the enrage taunt only bounds its roll up to the taunt.
 */

const TAUNTS = new Set(SOL_PHASE_TRANSITIONS.map((transition) => transition.taunt));
const ENRAGE_TAUNT = SOL_PHASE_TRANSITIONS[4].taunt;

interface Timeline {
  readonly taunts: readonly number[];
  readonly enrage: number;
  readonly crystals: readonly {
    readonly added: number;
    readonly at: Coordinate;
    readonly moves: Map<number, Coordinate>;
    /** NPC index below Sol's: it moves before his script holds it on a warning tick. */
    readonly beforeSol: boolean;
    /** Ticks of its despawn sequence (10800) and its removal, if recorded. */
    readonly despawned?: number;
    readonly removed?: number;
  }[];
  readonly warnings: readonly number[];
  /** Ticks Sol began any attack: spear, shield, triple or grapple. */
  readonly telegraphs: readonly number[];
  readonly charges: readonly number[];
  readonly fires: readonly number[];
  /** Beam map_anims per tick as `id x,y delay`. */
  readonly beamGraphics: ReadonlyMap<number, readonly string[]>;
  /** Sol's death sequence, or his removal when the player died first (A). */
  readonly death: number;
  /** Whether Sol was killed (his death sequence), rather than removed when the player died. */
  readonly killed: boolean;
}

const graphicKey = (spotAnimId: number, [x, y]: Readonly<Coordinate>, delayCycles: number) =>
  `${spotAnimId} ${x},${y} ${delayCycles}`;

function parseTimeline(fileName: string): Timeline {
  const captured = SOL_BEAM_TIMELINES[fileName];
  if (!captured) throw new Error(`No extracted beam timeline for ${fileName}`);
  return {
    ...captured,
    taunts: captured.taunts.filter(([, text]) => TAUNTS.has(text)).map(([tick]) => tick),
    enrage: captured.taunts.reduce(
      (last, [tick, text]) => (text === ENRAGE_TAUNT ? tick : last),
      Number.POSITIVE_INFINITY,
    ),
    crystals: captured.crystals.map((crystal) => ({ ...crystal, moves: new Map(crystal.moves) })),
    beamGraphics: new Map(
      captured.beamGraphics.map(([tick, graphics]) => [
        tick,
        graphics.map(([id, x, y, delay]) => graphicKey(id, [x, y], delay)),
      ]),
    ),
  };
}

/**
 * The ready delay the capture implies after the fire at `fireTick`: past the last telegraph it
 * skipped, and no later than the one it warned on. Returns the roll producing the smallest such
 * delay, or records why the phase's range cannot produce any.
 */
function readyRoll(timeline: Timeline, fireTick: number, phase: SolPhase, misfits: string[]): number {
  const [min, max] = isEnraged(phase)
    ? [BEAM_ENRAGE_READY_DELAY_TICKS, BEAM_ENRAGE_READY_DELAY_TICKS]
    : BEAM_READY_DELAY_TICKS;
  const warning = timeline.warnings.find((tick) => tick > fireTick);
  // The enrage taunt readies an idle clock, so the warning after it does not cap the roll.
  const enraged = timeline.enrage > fireTick && (warning === undefined || timeline.enrage < warning);
  const end = enraged ? timeline.enrage : (warning ?? timeline.death);
  const skipped = timeline.telegraphs.filter((tick) => tick > fireTick && tick < end);
  const earliest = Math.max(min, skipped.length > 0 ? Math.max(...skipped) - fireTick + 1 : 0);
  const latest = Math.min(max, warning === undefined || enraged ? Number.POSITIVE_INFINITY : warning - fireTick);
  if (earliest > latest) misfits.push(`fire ${fireTick} phase ${phase}: needs a delay in (${earliest - 1}, ${latest}]`);
  return (Math.min(earliest, max) - min + 0.5) / (max - min + 1);
}

function replay(timeline: Timeline) {
  const beams = new SolBeamRounds();
  const definition = crystalDefinition.register(undefined);
  const crystals: CrystalActor[] = [];
  const recorded = { warnings: [] as number[], charges: [] as number[], fires: [] as number[] };
  const stepMismatches: string[] = [];
  const graphicMismatches: string[] = [];
  const misfits: string[] = [];
  // The encounter paints each line from the round's own tiles; the capture is the reference.
  const compareGraphics = (tick: number, round: BeamRound, stage: 'charge' | 'fire') => {
    const model = round.lines
      .flatMap((line) => colosseumBeamGraphics(crystalBeamDirection(line.index), line.tiles, stage))
      .map((cue) =>
        cue.target.kind === 'tile' ? graphicKey(cue.spotAnimId, cue.target.position, cue.delayCycles) : 'actor',
      )
      .sort();
    const capture = [...(timeline.beamGraphics.get(tick) ?? [])].sort();
    if (`${model}` !== `${capture}`) graphicMismatches.push(`${stage} at ${tick}`);
  };
  const telegraphs = new Set(timeline.telegraphs);
  const context = {
    world: new WorldState(),
    random: () => 0.5,
    spawnNpc: () => {},
    despawnNpc: () => {},
    logEvent: () => {},
  };
  const first = timeline.crystals[0].added;
  // The 90% taunt comes two ticks before the first crystal the replay starts from.
  let phase = timeline.taunts.filter((tick) => tick < first).length as SolPhase;
  for (let tick = first; tick < timeline.death; tick++) {
    // Movement stage: a warning is due when a ready round meets a Sol telegraph. The sim has no NPC
    // indices and holds every crystal; one indexed below Sol's takes its step first (L beam 4).
    if (telegraphs.has(tick) && beams.isReady(crystals, tick))
      beams.holdForWarning(crystals.filter((_, index) => !timeline.crystals[index].beforeSol));
    crystals.forEach((crystal, index) => {
      const [step] = definition.move(crystal, { ...context, tick } as never);
      if (step) crystal.position = step.path[0];
      const expected = timeline.crystals[index].moves.get(tick);
      const moved = step !== undefined;
      if (moved !== (expected !== undefined) || (expected && `${crystal.position}` !== `${expected}`))
        stepMismatches.push(
          `crystal ${index} at ${tick}: model ${moved ? crystal.position : 'still'}, capture ${expected ?? 'still'}`,
        );
      if (expected) crystal.position = expected;
    });
    // Encounter stage: phase transition, scheduled crystal spawn, then the beam round.
    if (timeline.taunts.includes(tick)) phase = (phase + 1) as SolPhase;
    if (tick === timeline.enrage) beams.enrage(tick);
    const spawn = timeline.crystals.findIndex((crystal) => crystal.added === tick);
    if (spawn >= 0) {
      const at = timeline.crystals[spawn].at;
      const edge = BEAM_CRYSTAL_EDGES[spawn].edge;
      const spawnAlong = edge === 'north' || edge === 'south' ? at[0] : at[1];
      const crystal = createCrystal({ id: `c${spawn}`, index: spawn, tick, charging: beams.isHolding(), spawnAlong });
      expect(crystal.position).toEqual(at);
      crystals.push(crystal);
      beams.enroll(tick);
    }
    const charging = beams.startChargeIfDue(crystals, tick);
    if (charging) {
      recorded.charges.push(tick);
      compareGraphics(tick, charging, 'charge');
    }
    const fired = beams.fireIfDue(crystals, {
      tick,
      playerPos: [0, 0],
      phase,
      random: () => readyRoll(timeline, tick, phase, misfits),
    });
    if (fired) {
      recorded.fires.push(tick);
      compareGraphics(tick, fired.round, 'fire');
    }
    // Sol's launch runs after the beam stage, and a warning goes out only on a tick he attacks.
    if (telegraphs.has(tick) && beams.prepare(crystals, tick, phase >= 5) !== null) recorded.warnings.push(tick);
  }
  return { recorded, stepMismatches, graphicMismatches, misfits };
}

describe.each([
  'colosseum-sol-heredit-packet-data.txt',
  'colosseum-sol-heredit-solar-flare-doom-volatility-packet-data.txt',
  'colosseum-sol-heredit-packet-data-2.txt',
  'colosseum-sol-heredit-long-fight-packet-data-3.txt',
  'colosseum-waves-1-12-damage-trials-solarflare3-volatility3-bees1-totemic-doom1-death-packet-data.txt',
])('Sol beam rounds and crystal patrol vs %s', (fileName) => {
  const timeline = parseTimeline(fileName);
  const { recorded, stepMismatches, graphicMismatches, misfits } = replay(timeline);
  const beforeDeath = (ticks: readonly number[]) => ticks.filter((tick) => tick < timeline.death);

  it('warns only on Sol telegraphs', () => {
    expect(timeline.warnings.filter((tick) => !timeline.telegraphs.includes(tick))).toEqual([]);
  });

  it('fits every capture-implied ready delay inside its phase range', () => {
    expect(misfits).toEqual([]);
  });

  it('warns, charges and fires on every recorded tick and no other', () => {
    expect(timeline.charges.length).toBeGreaterThanOrEqual(5);
    expect(recorded.warnings).toEqual(beforeDeath(timeline.warnings));
    expect(recorded.charges).toEqual(beforeDeath(timeline.charges));
    expect(recorded.fires).toEqual(beforeDeath(timeline.fires));
  });

  it('steps every crystal on the recorded ticks and tiles', () => {
    expect(stepMismatches).toEqual([]);
  });

  it.runIf(timeline.killed)('despawns each crystal on the death tick and removes it at the cleanup tick', () => {
    // A crystal indexed below Sol's is processed before his death that tick, so it runs a tick late
    // (L beam 4); the sim has no NPC indices.
    expect(
      timeline.crystals.map(({ despawned, removed, beforeSol }) => [despawned, removed, beforeSol ? 1 : 0]),
    ).toEqual(
      timeline.crystals.map(({ beforeSol }) => {
        const late = beforeSol ? 1 : 0;
        return [timeline.death + late, timeline.death + SOL_DEATH_CLEANUP_DELAY_TICKS + late, late];
      }),
    );
  });

  it('paints every charge and fire on its tick with the recorded ids, tiles and delays', () => {
    expect(graphicMismatches).toEqual([]);
    // Every captured beam graphic before the death tick belongs to a modeled charge or fire. On it,
    // K:4221's due charge still sent its graphics while the crystals played their despawn; that one
    // observation is not modeled (the sim charges nothing once Sol is dead).
    expect([...timeline.beamGraphics.keys()].filter((tick) => tick < timeline.death)).toEqual(
      [...recorded.charges, ...recorded.fires].sort((a, b) => a - b),
    );
  });
});

/** Every pool LOC around Sol's death in a kill: when it formed, animated out and was replaced. */
function parsePoolDeath(fileName: string) {
  const captured = SOL_POOL_DEATHS[fileName];
  if (!captured) throw new Error(`No extracted pool timeline for ${fileName}`);
  const sets = (entries: CapturedPoolDeath['replaced']) =>
    new Map(entries.map(([tick, tiles]) => [tick, new Set(tiles)] as const));
  return {
    formed: new Map(captured.formed),
    strikes: new Map(captured.strikes),
    despawnAnims: sets(captured.despawnAnims),
    replaced: sets(captured.replaced),
    death: captured.death,
  };
}

describe.each([
  { fileName: 'colosseum-sol-heredit-packet-data.txt', deathTick: 4221, poolCount: 29 },
  { fileName: 'colosseum-sol-heredit-solar-flare-doom-volatility-packet-data.txt', deathTick: 8512, poolCount: 25 },
  { fileName: 'colosseum-sol-heredit-packet-data-2.txt', deathTick: 7781, poolCount: 39 },
  { fileName: 'colosseum-sol-heredit-long-fight-packet-data-3.txt', deathTick: 5833, poolCount: 47 },
])('molten sand pools at Sol death vs $fileName', ({ fileName, deathTick, poolCount }) => {
  const { formed, strikes, despawnAnims, replaced, death } = parsePoolDeath(fileName);
  const pools = [...formed]
    .filter(([, tick]) => tick < death)
    .map(([tile]) => tile)
    .sort();

  it('animates every pool out on the death tick and the next, then replaces them all at the removal tick', () => {
    expect(death).toBe(deathTick);
    expect(pools).toHaveLength(poolCount);
    expect(pools.length).toBeGreaterThan(20);
    expect([...despawnAnims.keys()]).toEqual([death, death + 1]);
    for (const tiles of despawnAnims.values()) expect([...tiles].sort()).toEqual(pools);
    // The same invisible LOC also sets the floor up before the fight (M:8272, L:3450) and appears off
    // the pools later (L:5844).
    const poolReplacements = [...replaced].filter(
      ([tick, tiles]) => tick >= death && pools.some((tile) => tiles.has(tile)),
    );
    expect(poolReplacements.map(([tick]) => tick)).toEqual([death + SOL_DEATH_SAND_REMOVAL_DELAY_TICKS]);
    expect([...(replaced.get(death + SOL_DEATH_SAND_REMOVAL_DELAY_TICKS) ?? [])].sort()).toEqual(pools);
  });

  it('forms each strike at emission+5 unless that falls on or after the death tick', () => {
    for (const [strikeTick, tiles] of strikes) {
      const due = strikeTick + SAND_POOL_DELAY_TICKS;
      for (const tile of tiles) expect([tile, formed.get(tile) ?? null]).toEqual([tile, due < death ? due : null]);
    }
  });
});
