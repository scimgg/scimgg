import type { NpcActor } from '../../../core/actors/NpcActor';
import { notifyNpcOfPlayerAttack } from '../../../core/combat/retaliation';
import { SIMULATION_START_TICK, setResolvedArenaConfig } from '../../../core/constants';
import type { DecisionKey } from '../../../core/decisionRandom';
import type { NpcProjectileCue } from '../../../core/events/encounterVisual';
import type { GameEvent } from '../../../core/events/types';
import { SimulationEngine } from '../../../core/SimulationEngine';
import type { WorldState } from '../../../core/WorldState';
import { INFERNO_WAVE_NPC_IDS, INFERNO_WAVE_SEQS, ZUK_SEQS } from '../../../npcs/inferno/constants';
import {
  ConstrainedDecisions,
  type DecisionConstraint,
  type DecisionRecord,
  type ForcedOutcome,
} from '../../../test/capture/constrainedRandom';
import type { ConditioningNote, Divergence, Observation, ReplaySession } from '../../../test/capture/replay';
import type {
  ActorLife,
  ActorUpdateEvent,
  CaptureCoord,
  CaptureTick,
  HitEvent,
  ProjectileEvent,
  ReplayRange,
} from '../../../test/capture/types';
import { enqueueEnginePendingHit } from '../../../test/helpers/pendingHits';
import { RUN_ENERGY_MAX } from '../../../types/playerState';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { INFERNO_SPAWN_SLOTS, LAST_PILLAR_WAVE, startWaveDelayTicks, WAVE_68_JAD_TILES } from '../constants';
import { INFERNO_DESTROYED_PILLAR_KEYS, INFERNO_START_WAVE_KEY } from '../controls';
import { InfernoEncounter } from '../InfernoEncounter';
import { INFERNO_PILLARS, PILLAR_MAX_HP, type PillarKey } from '../pillars';
import { waveSpawnKinds } from '../waves';
import { INFERNO_CAPTURE_FIXTURES } from './captureFixtures';
import { loadInfernoArena } from './infernoArenaFixture';
import { INFERNO_ORIGIN, lifeKey, loadReplayRange } from './replayRange';

/**
 * Inferno ordinary-wave capture replay (docs/testing/capture-timeline.md, Replay). Coordinates are
 * local to map square (35,83): `local = world - (2240, 5312)` (facts spec). A window starts at sim
 * tick 1, as many ticks before its first wave's spawn as the encounter waits for that start wave
 * (`startWaveDelayTicks`: the captured +11 from wave 1, the next tick from a later wave, so sim tick 1
 * is the spawn), and continues into later waves as the sim completes them. A window replays inside
 * the one replay range of its capture stream that holds its last tick.
 */
export const INFERNO_CAPTURES = {
  P: INFERNO_CAPTURE_FIXTURES.infernoWaves1To68,
  Q: INFERNO_CAPTURE_FIXTURES.infernoWaves35To68,
} as const;
export type InfernoCaptureName = keyof typeof INFERNO_CAPTURES;

export const INFERNO_CHANNELS = [
  'spawn',
  'despawn',
  'move',
  'attack',
  'projectile',
  'hit',
  'pillar',
  'player',
  'projectile_origin',
] as const;

export interface InfernoWindow {
  readonly name: string;
  readonly capture: InfernoCaptureName;
  readonly stream: number;
  readonly firstWave: number;
  /** Last capture tick replayed, inclusive. */
  readonly lastTick: number;
}

type Species = {
  readonly name: string;
  readonly size: number;
  /** Sim clip id -> captured sequence, for the actions compared on the `attack` channel. */
  readonly clips: Readonly<Record<string, number>>;
  readonly death?: number;
};

const SPECIES: Readonly<Record<number, Species>> = {
  [INFERNO_WAVE_NPC_IDS.nibbler]: {
    name: 'nibbler',
    size: 1,
    clips: { attack: INFERNO_WAVE_SEQS.nibbler.attack },
    death: INFERNO_WAVE_SEQS.nibbler.death,
  },
  [INFERNO_WAVE_NPC_IDS.bat]: {
    name: 'bat',
    size: 2,
    clips: { attack: INFERNO_WAVE_SEQS.bat.attack },
    death: INFERNO_WAVE_SEQS.bat.death,
  },
  [INFERNO_WAVE_NPC_IDS.blob]: {
    name: 'blob',
    size: 3,
    clips: {
      magic: INFERNO_WAVE_SEQS.blob.magic,
      range: INFERNO_WAVE_SEQS.blob.range,
      melee: INFERNO_WAVE_SEQS.blob.melee,
    },
    death: INFERNO_WAVE_SEQS.blob.death,
  },
  [INFERNO_WAVE_NPC_IDS.blob_mage]: {
    name: 'blob_mage',
    size: 1,
    clips: { magic: INFERNO_WAVE_SEQS.blobChild.magic },
    death: INFERNO_WAVE_SEQS.blobChild.death,
  },
  [INFERNO_WAVE_NPC_IDS.blob_range]: {
    name: 'blob_range',
    size: 1,
    clips: { range: INFERNO_WAVE_SEQS.blobChild.range },
    death: INFERNO_WAVE_SEQS.blobChild.death,
  },
  [INFERNO_WAVE_NPC_IDS.blob_melee]: {
    name: 'blob_melee',
    size: 1,
    clips: { melee: INFERNO_WAVE_SEQS.blobChild.melee },
    death: INFERNO_WAVE_SEQS.blobChild.death,
  },
  [INFERNO_WAVE_NPC_IDS.meleer]: {
    name: 'meleer',
    size: 4,
    clips: {
      attack: INFERNO_WAVE_SEQS.meleer.attack,
      dig_down: INFERNO_WAVE_SEQS.meleer.dig_down,
      dig_up: INFERNO_WAVE_SEQS.meleer.dig_up,
    },
    death: INFERNO_WAVE_SEQS.meleer.death,
  },
  [INFERNO_WAVE_NPC_IDS.ranger]: {
    name: 'ranger',
    size: 3,
    clips: { range: ZUK_SEQS.ranger.range, melee: ZUK_SEQS.ranger.melee },
    death: ZUK_SEQS.ranger.death,
  },
  [INFERNO_WAVE_NPC_IDS.mager]: {
    name: 'mager',
    size: 4,
    clips: { magic: ZUK_SEQS.mager.magic, melee: ZUK_SEQS.mager.melee, resurrect: INFERNO_WAVE_SEQS.mager.resurrect },
    death: ZUK_SEQS.mager.death,
  },
  [INFERNO_WAVE_NPC_IDS.jad]: {
    name: 'jad',
    size: 5,
    clips: { magic: ZUK_SEQS.jad.magic, range: ZUK_SEQS.jad.range, melee: ZUK_SEQS.jad.melee },
    death: ZUK_SEQS.jad.death,
  },
  [INFERNO_WAVE_NPC_IDS.jad_healer]: {
    name: 'healer',
    size: 1,
    clips: { heal: ZUK_SEQS.ytHurKot.heal, melee: ZUK_SEQS.ytHurKot.attack },
  },
  [INFERNO_WAVE_NPC_IDS.pillar]: { name: 'pillar', size: 3, clips: {} },
  [INFERNO_WAVE_NPC_IDS.pillarCollapse]: { name: 'collapse', size: 3, clips: {} },
};

const ACTION_SEQS = new Set<number>(
  Object.values(SPECIES).flatMap((species) => [
    ...Object.values(species.clips),
    ...(species.death === undefined ? [] : [species.death]),
  ]),
);
ACTION_SEQS.add(INFERNO_WAVE_SEQS.pillarCollapse);

/** Hitsplats the local player dealt (RuneLite HitsplatID: BLOCK_ME 12, DAMAGE_ME 16, DAMAGE_MAX_ME 43, BURN 74). */
/** Who launches each NPC projectile (facts spec, Projectiles). */
const PROJECTILE_LAUNCHERS: Readonly<Record<number, readonly number[]>> = {
  1382: [INFERNO_WAVE_NPC_IDS.bat],
  1378: [INFERNO_WAVE_NPC_IDS.blob],
  1380: [INFERNO_WAVE_NPC_IDS.blob],
  1379: [INFERNO_WAVE_NPC_IDS.blob_range],
  1381: [INFERNO_WAVE_NPC_IDS.blob_mage],
  1377: [INFERNO_WAVE_NPC_IDS.ranger],
  1376: [INFERNO_WAVE_NPC_IDS.mager],
  448: [INFERNO_WAVE_NPC_IDS.jad],
  449: [INFERNO_WAVE_NPC_IDS.jad],
  450: [INFERNO_WAVE_NPC_IDS.jad],
};
/** Projectiles NPCs of waves 1-68 launch (facts spec, Projectiles); everything else is the player's. */
const NPC_PROJECTILES = new Set([1376, 1377, 1378, 1379, 1380, 1381, 1382, 448, 449, 450]);
/** Sequences whose hit lands on the swing tick, on an adjacent target. */
const MELEE_SEQS = new Set<number>([
  INFERNO_WAVE_SEQS.nibbler.attack,
  INFERNO_WAVE_SEQS.meleer.attack,
  INFERNO_WAVE_SEQS.blob.melee,
  ZUK_SEQS.ranger.melee,
  ZUK_SEQS.mager.melee,
  ZUK_SEQS.jad.melee,
  ZUK_SEQS.ytHurKot.attack,
]);
/** The ice impact graphic P shows on every NPC an ice spell freezes, scheduled on the cast tick. */
const ICE_IMPACT = 363;
/** Jal-Zek's resurrection graphic, a map_anim on the revived NPC's birth footprint. */
const RESURRECTION_GRAPHIC = 444;
/** A splashed spell's impact graphic, scheduled on the cast tick; it never comes with a splat. */
const FAILED_SPELL_IMPACT = 85;
const ICE_BURST_TRAVEL = 366;
// spells.json secondary effects: Ice Burst 16, Ice Blitz 24.
const ICE_BURST_FREEZE = 16;
const ICE_BLITZ_FREEZE = 24;
/** JalTok-Jad's ranged hit lands tell + 5 (facts spec, Jad). */
const JAD_RANGE_IMPACT_TICKS = 5;
const PLAYER_DEALT_SPLATS = new Set([12, 16, 43, 74]);
const BURN_SPLAT = 74;
const PILLAR_VARBITS: Readonly<Record<number, PillarKey>> = { 5655: 'west', 5656: 'south', 5657: 'northEast' };
const PRAYER_VARBITS: Readonly<Record<number, PrayerType>> = {
  4116: PrayerType.ProtectMagic,
  4117: PrayerType.ProtectRange,
  4118: PrayerType.ProtectMelee,
};
/** Player attack animations in P and Q, for the launch tick of a captured player hit. */
const PLAYER_ATTACK_SEQS = new Set([11057, 10092, 10091, 5061, 10656, 426, 7618, 8056]);
const PLAYER_MAGIC_SEQS = new Set([10092, 10091]);
const PLAYER_MELEE_SEQS = new Set([8056]);

const local = ([x, y]: CaptureCoord): Coordinate => [x - INFERNO_ORIGIN[0], y - INFERNO_ORIGIN[1]];
const tile = ([x, y]: readonly number[]): string => `${x},${y}`;

/** Every fact the replay needs from one replay range, indexed once per worker. */
interface CaptureIndex {
  readonly range: ReplayRange;
  readonly ticks: ReadonlyMap<number, CaptureTick>;
  readonly npcIdOf: ReadonlyMap<ActorLife, number>;
  /** Attributed source of each NPC projectile (null: ambiguous). */
  readonly projectileSource: ReadonlyMap<ProjectileEvent, ActorLife | null>;
  readonly seqs: ReadonlyMap<ActorLife, ReadonlyMap<number, readonly number[]>>;
  readonly projectiles: ReadonlyMap<ActorLife, ReadonlyMap<number, readonly ProjectileEvent[]>>;
  readonly moves: ReadonlyMap<ActorLife, ReadonlyMap<number, ActorUpdateEvent>>;
  readonly adds: ReadonlyMap<number, readonly ActorUpdateEvent[]>;
  /** End-of-tick player tile (local). */
  readonly player: ReadonlyMap<number, Coordinate>;
  readonly playerAttackTicks: readonly number[];
  readonly waveSpawns: ReadonlyMap<number, number>;
  readonly pillarOf: ReadonlyMap<ActorLife, PillarKey>;
  /** The NPC attack each non-player splat comes from, when exactly one captured attack lands it. */
  readonly splatAttacker: ReadonlyMap<HitEvent, ActorLife | null>;
  /** Every captured attack that could have landed each non-player splat. */
  readonly splatCandidates: ReadonlyMap<HitEvent, readonly ActorLife[]>;
  /** Ice-spell freezes by cast tick: NPCs given the ice impact graphic. */
  readonly freezes: ReadonlyMap<number, readonly { readonly life: ActorLife; readonly duration: number }[]>;
  /** Lives that showed a non-action sequence (a defend) on a tick, which can mask an attack sequence. */
  readonly masked: ReadonlyMap<number, ReadonlySet<ActorLife>>;
}

const indexes = new Map<string, CaptureIndex>();

function speciesOf(npcId: number | undefined): Species | undefined {
  return npcId === undefined ? undefined : SPECIES[npcId];
}

function sourceTile(position: Coordinate, size: number): string {
  // A Jal-MejRah (size 2) launches from its SW tile in the captures; the rest from SW + floor(size / 2).
  const offset = size === 2 ? 0 : Math.floor(size / 2);
  return tile([position[0] + offset, position[1] + offset]);
}

/** The single NPC whose start- or end-of-tick footprint center is the projectile's source tile. */
function attributeSource(
  from: string,
  candidates: Iterable<readonly [unknown, Coordinate | undefined, Coordinate | undefined, number]>,
): unknown {
  const matches = new Set<unknown>();
  for (const [actor, start, end, size] of candidates) {
    if ((start && sourceTile(start, size) === from) || (end && sourceTile(end, size) === from)) matches.add(actor);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function captureIndex(capture: InfernoCaptureName, streamNumber: number, lastTick: number): CaptureIndex {
  const path = INFERNO_CAPTURES[capture].ranges.find((candidate) => {
    const range = loadReplayRange(candidate);
    return range.stream === streamNumber && range.first <= lastTick && lastTick <= range.last;
  });
  if (!path) throw new RangeError(`${capture} stream ${streamNumber} has no replay range holding t${lastTick}`);
  const cached = indexes.get(path);
  if (cached) return cached;
  const range = loadReplayRange(path);
  if (range.capture !== INFERNO_CAPTURES[capture].capture)
    throw new RangeError(`${path} names ${range.capture}, not ${INFERNO_CAPTURES[capture].capture}`);
  const npcIdOf = new Map<ActorLife, number>();
  for (const record of range.lives) if (record.npcId !== undefined) npcIdOf.set(record.life, record.npcId);
  const ticks = new Map<number, CaptureTick>();
  const projectileSource = new Map<ProjectileEvent, ActorLife | null>();
  const seqs = new Map<ActorLife, Map<number, number[]>>();
  const projectiles = new Map<ActorLife, Map<number, ProjectileEvent[]>>();
  const moves = new Map<ActorLife, Map<number, ActorUpdateEvent>>();
  const adds = new Map<number, ActorUpdateEvent[]>();
  const player = new Map<number, Coordinate>();
  const playerAttackTicks: number[] = [];
  const waveSpawns = new Map<number, number>();
  const pillarOf = new Map<ActorLife, PillarKey>();
  const splatAttacker = new Map<HitEvent, ActorLife | null>();
  const splatCandidates = new Map<HitEvent, ActorLife[]>();
  const freezes = new Map<number, { life: ActorLife; duration: number }[]>();
  const masked = new Map<number, Set<ActorLife>>();
  /** Captured attacks by `target|impactTick`: projectiles and Jad ranged tells, recorded at launch. */
  const impacts = new Map<string, Set<ActorLife | 'player'>>();
  const impactKey = (target: ActorLife | 'player', tick: number) =>
    `${target === 'player' ? 'player' : lifeKey(target)}|${tick}`;
  const addImpact = (target: ActorLife | 'player', tick: number, attacker: ActorLife) => {
    const key = impactKey(target, tick);
    const set = impacts.get(key) ?? new Set();
    set.add(attacker);
    impacts.set(key, set as Set<ActorLife | 'player'>);
  };
  const at = <V>(map: Map<ActorLife, Map<number, V[]>>, life: ActorLife, tick: number, value: V) => {
    let byTick = map.get(life);
    if (!byTick) {
      byTick = new Map();
      map.set(life, byTick);
    }
    const list = byTick.get(tick);
    if (list) list.push(value);
    else byTick.set(tick, [value]);
  };
  const position = new Map<ActorLife, Coordinate>();
  const notePillar = (life: ActorLife, at: Coordinate) => {
    if (npcIdOf.get(life) !== INFERNO_WAVE_NPC_IDS.pillar || pillarOf.has(life)) return;
    const pillar = INFERNO_PILLARS.find((candidate) => tile(candidate.position) === tile(at));
    if (pillar) pillarOf.set(life, pillar.key);
  };
  for (const { life, coord } of range.start.npcs) {
    position.set(life, local(coord));
    notePillar(life, local(coord));
  }
  let playerTile: Coordinate | undefined = local(range.start.player);
  player.set(range.start.tick, playerTile);
  for (const tick of range.ticks) {
    ticks.set(tick.tick, tick);
    const start = new Map(position);
    // NPCs act before the player moves: melee reach is judged from the player's start-of-tick tile.
    const playerStart = playerTile;
    const pending: ProjectileEvent[] = [];
    for (const event of tick.events) {
      if (event.type === 'actor') {
        const end = local(event.newcoord ?? event.coord);
        if (event.actor.kind === 'player') {
          playerTile = end;
          continue;
        }
        position.set(event.actor, end);
        if (event.op === 'add') {
          const list = adds.get(tick.tick);
          if (list) list.push(event);
          else adds.set(tick.tick, [event]);
        }
        if (event.newcoord) {
          let byTick = moves.get(event.actor);
          if (!byTick) {
            byTick = new Map();
            moves.set(event.actor, byTick);
          }
          byTick.set(tick.tick, event);
        }
        notePillar(event.actor, end);
      } else if (event.type === 'sequence' && event.actor) {
        if (event.actor.kind === 'player') {
          if (PLAYER_ATTACK_SEQS.has(event.id)) playerAttackTicks.push(tick.tick);
        } else if (ACTION_SEQS.has(event.id)) at(seqs, event.actor, tick.tick, event.id);
      } else if (event.type === 'projectile') {
        pending.push(event);
      } else if (event.type === 'wave') {
        waveSpawns.set(event.wave, tick.tick);
      }
    }
    const acting = new Set<ActorLife>();
    for (const event of tick.events)
      if (event.type === 'sequence' && event.actor?.kind === 'npc' && ACTION_SEQS.has(event.id))
        acting.add(event.actor);
    for (const event of pending) {
      if (!NPC_PROJECTILES.has(event.id)) continue;
      // The NPC that played an action this tick next to the launch tile; else the one whose
      // footprint center is the launch tile (a launch without an animation, e.g. a dying blob's).
      const from = local(event.from);
      const launchers = PROJECTILE_LAUNCHERS[event.id] ?? [];
      const near = [...acting].filter((life) => {
        if (!launchers.includes(npcIdOf.get(life) ?? -1)) return false;
        const size = speciesOf(npcIdOf.get(life))?.size ?? 1;
        return [start.get(life), position.get(life)].some(
          (at) =>
            at !== undefined &&
            Math.max(
              Math.max(at[0] - from[0], 0, from[0] - (at[0] + size - 1)),
              Math.max(at[1] - from[1], 0, from[1] - (at[1] + size - 1)),
            ) <= 2,
        );
      });
      const source =
        near.length === 1
          ? near[0]!
          : (attributeSource(
              tile(from),
              [...new Set([...start.keys(), ...position.keys()])]
                .filter((life) => launchers.includes(npcIdOf.get(life) ?? -1))
                .map((life) => [life, start.get(life), position.get(life), speciesOf(npcIdOf.get(life))?.size ?? 1]),
            ) as ActorLife | null);
      projectileSource.set(event, source);
      if (source) at(projectiles, source, tick.tick, event);
      const target = event.targetActor?.life;
      if (source && target && event.endtime !== undefined)
        addImpact(target.kind === 'player' ? 'player' : target, tick.tick + Math.floor(event.endtime / 30), source);
    }
    const iceBurst = tick.events.some((event) => event.type === 'projectile' && event.id === ICE_BURST_TRAVEL);
    for (const event of tick.events) {
      if (event.type !== 'spotanim' || event.id !== ICE_IMPACT || event.actor?.kind !== 'npc') continue;
      const list = freezes.get(tick.tick) ?? [];
      list.push({ life: event.actor, duration: iceBurst ? ICE_BURST_FREEZE : ICE_BLITZ_FREEZE });
      freezes.set(tick.tick, list);
    }
    // Melee lands this tick on an adjacent target; a Jad ranged tell lands 5 ticks later on the player.
    const swings: ActorLife[] = [];
    for (const event of tick.events) {
      if (event.type !== 'sequence' || event.actor?.kind !== 'npc') continue;
      // One sequence per actor per update: a defend sent the same tick hides the swing (P t939).
      if (!ACTION_SEQS.has(event.id) && event.id !== -1) {
        const set = masked.get(tick.tick) ?? new Set<ActorLife>();
        set.add(event.actor);
        masked.set(tick.tick, set);
        if (npcIdOf.get(event.actor) === INFERNO_WAVE_NPC_IDS.nibbler) swings.push(event.actor);
      }
      if (MELEE_SEQS.has(event.id)) swings.push(event.actor);
      if (event.id === ZUK_SEQS.jad.range) addImpact('player', tick.tick + JAD_RANGE_IMPACT_TICKS, event.actor);
    }
    const footprint = (life: ActorLife | 'player'): [Coordinate, number] | null => {
      if (life === 'player') return playerStart ? [playerStart, 1] : null;
      const at = position.get(life) ?? start.get(life);
      return at ? [at, speciesOf(npcIdOf.get(life))?.size ?? 1] : null;
    };
    const adjacent = (a: ActorLife, b: ActorLife | 'player') => {
      const left = footprint(a);
      const right = footprint(b);
      if (!left || !right) return false;
      const gap = (from: number, size: number, other: number, otherSize: number) =>
        Math.max(other - (from + size - 1), from - (other + otherSize - 1), 0);
      return (
        Math.max(gap(left[0][0], left[1], right[0][0], right[1]), gap(left[0][1], left[1], right[0][1], right[1])) <= 1
      );
    };
    for (const event of tick.events) {
      if (event.type !== 'hit' || !event.actor) continue;
      if (event.actor.kind === 'npc' && PLAYER_DEALT_SPLATS.has(event.id)) continue;
      const target: ActorLife | 'player' = event.actor.kind === 'player' ? 'player' : event.actor;
      const candidates = new Set<ActorLife>();
      for (const attacker of impacts.get(impactKey(target, tick.tick)) ?? [])
        if (attacker !== 'player') candidates.add(attacker);
      for (const swing of swings) if (adjacent(swing, target)) candidates.add(swing);
      splatAttacker.set(event, candidates.size === 1 ? [...candidates][0]! : null);
      // No attack accounts for it: anything that acted this tick may have.
      splatCandidates.set(event, candidates.size > 0 ? [...candidates] : [...acting]);
    }
    for (const event of tick.events) if (event.type === 'actor' && event.op === 'del') position.delete(event.actor);
    // The player line is only sent when something about the player changed; the tile carries over.
    if (playerTile) player.set(tick.tick, playerTile);
  }
  const index: CaptureIndex = {
    range,
    ticks,
    npcIdOf,
    projectileSource,
    seqs,
    projectiles,
    moves,
    adds,
    player,
    playerAttackTicks,
    waveSpawns,
    pillarOf,
    splatAttacker,
    splatCandidates,
    freezes,
    masked,
  };
  indexes.set(path, index);
  return index;
}

/** Fisher-Yates swap choices (from the top) that turn `initial` into an arrangement starting with `prefix`. */
function shuffleWitness<T>(
  initial: readonly T[],
  prefix: readonly T[],
  same: (a: T, b: T) => boolean,
): number[] | null {
  const rest = initial.filter((item) => !prefix.some((wanted) => same(wanted, item)));
  const target = [...prefix, ...rest];
  if (target.length !== initial.length) return null;
  const array = [...initial];
  const swaps: number[] = [];
  for (let index = array.length - 1; index > 0; index--) {
    const position = array.findIndex((item) => same(item, target[index]!));
    if (position < 0 || position > index) return null;
    swaps[index] = position;
    [array[index], array[position]] = [array[position]!, array[index]!];
  }
  return swaps;
}

type WaveWitness = {
  readonly slotSwaps: readonly number[] | null;
  readonly jadSwaps: readonly number[] | null;
  readonly nibblers: readonly Coordinate[];
  readonly pillar: PillarKey | null;
  readonly evidence: string;
  readonly pillarEvidence?: string;
};

/** Facts spec (Jal-Nib): attack tiles from the central spawns. */
const NIBBLER_ATTACK_TILES: Readonly<Record<PillarKey, Coordinate>> = {
  west: [20, 37],
  south: [27, 26],
  northEast: [33, 39],
};

function waveWitness(index: CaptureIndex, wave: number): WaveWitness | null {
  const spawnTick = index.waveSpawns.get(wave);
  if (spawnTick === undefined) return null;
  const adds = index.adds.get(spawnTick) ?? [];
  const evidence = `wave ${wave} adds, line ${adds[0]?.source.line ?? '?'}`;
  const byType = new Map<number, Coordinate[]>();
  // The batch spawns in NPC index order (mager, ranger, meleer, blob, bat, nibbler; wave 68's Jad
  // openings follow it too), which the capture's line order need not follow (P:2013-2016).
  for (const add of [...adds].sort((left, right) => left.actor.index - right.actor.index)) {
    const list = byType.get(add.npcId ?? -1) ?? [];
    list.push(local(add.coord));
    byType.set(add.npcId ?? -1, list);
  }
  const kinds = waveSpawnKinds(wave);
  const taken = new Map<number, number>();
  const prefix: Coordinate[] = [];
  const nibblers: Coordinate[] = [];
  const jads: Coordinate[] = [];
  for (const kind of kinds) {
    const npcId = INFERNO_WAVE_NPC_IDS[kind];
    const next = taken.get(npcId) ?? 0;
    taken.set(npcId, next + 1);
    const position = byType.get(npcId)?.[next];
    if (!position) return { slotSwaps: null, jadSwaps: null, nibblers: [], pillar: null, evidence };

    if (kind === 'nibbler') nibblers.push(position);
    else if (kind === 'jad') jads.push(position);
    else prefix.push(position);
  }
  const same = (a: readonly number[], b: readonly number[]) => a[0] === b[0] && a[1] === b[1];
  const nibblerLives = new Set(
    adds.filter((add) => add.npcId === INFERNO_WAVE_NPC_IDS.nibbler).map((add) => add.actor),
  );
  let pillar: PillarKey | null = null;
  for (const [tick, entry] of index.ticks) {
    if (tick < spawnTick || pillar !== null) continue;
    for (const event of entry.events) {
      if (event.type !== 'facing' || !event.actor || !nibblerLives.has(event.actor)) continue;
      const target = event.target;
      if (target?.npcId !== INFERNO_WAVE_NPC_IDS.pillar || !target.coord) continue;
      const at = tile(local(target.coord));
      const key = INFERNO_PILLARS.find((candidate) => tile(candidate.position) === at)?.key;
      if (key) {
        pillar = key;
        break;
      }
    }
    if (tick > spawnTick + 60) break;
  }
  let pillarEvidence = 'nibbler facing';
  if (pillar === null) {
    // No nibbler faced a pillar (all died first): the pillar every first step heads for, if unique.
    const steps = [...nibblerLives].flatMap((life) => {
      const move = [...(index.moves.get(life) ?? [])].sort(([a], [b]) => a - b)[0]?.[1];
      return move?.newcoord ? [[local(move.coord), local(move.newcoord)] as const] : [];
    });
    const heading = INFERNO_PILLARS.filter((candidate) => {
      const attackTile = NIBBLER_ATTACK_TILES[candidate.key];
      return (
        steps.length > 0 &&
        steps.every(
          ([from, to]) =>
            Math.sign(to[0] - from[0]) === Math.sign(attackTile[0] - from[0]) &&
            Math.sign(to[1] - from[1]) === Math.sign(attackTile[1] - from[1]),
        )
      );
    });
    if (heading.length === 1) {
      pillar = heading[0]!.key;
      pillarEvidence = 'nibbler first steps';
    }
  }
  return {
    slotSwaps: prefix.length > 0 ? shuffleWitness(INFERNO_SPAWN_SLOTS, prefix, same) : null,
    jadSwaps: wave === 68 ? shuffleWitness(WAVE_68_JAD_TILES, jads, same) : null,
    nibblers,
    pillar,
    evidence,
    pillarEvidence,
  };
}

const DIG_FIRST = 50;
const DIG_FIRST_RESURRECTED = 49;
const DIG_MIN = 40;
const DIG_SPAN = 21;
/** Attack speed 4 + Arcane's 15-cycle attack-delay window (meleer.ts). */
const DIG_SUPPRESSION = 19;
/** Down->up 3 + walk from up+3: after a dig the interval counts from down+6 (meleer.ts). */
const DIG_RESUME = 6;

/**
 * Hidden dig checks: one draw per check, digging only when the meleer has not swung in the last 19
 * ticks (a swing on the check tick comes after it); the next check is `check + 40 + k`, or
 * `dig + 6 + 40 + k` after a dig. A local search finds draws that reach every captured dig with every
 * check in between suppressed by a captured attack; after the last dig, checks stay suppressed while
 * possible.
 */
function digWitness(
  attacks: readonly number[],
  digs: readonly number[],
  firstCheck: number,
  lifeEnd: number,
): Map<number, number> | null {
  const suppressed = (check: number) => attacks.some((attack) => attack < check && check - attack <= DIG_SUPPRESSION);
  // Where the 40-60 count starts from a check: observed digs resume it at down+6.
  const base = (check: number) => check + (digs.includes(check) ? DIG_RESUME : 0) + DIG_MIN;
  const witness = new Map<number, number>();
  let check = firstCheck;
  for (const dig of digs) {
    // Breadth-first over check ticks between `check` and `dig`.
    const previous = new Map<number, number>();
    const frontier = [check];
    const seen = new Set([check]);
    let reached = check === dig;
    while (frontier.length > 0 && !reached) {
      const current = frontier.shift()!;
      if (current !== check && !suppressed(current)) continue;
      // The segment starts at the first check or the previous dig; only the former must be suppressed.
      if (current === check && current !== dig && !digs.includes(current) && !suppressed(current)) return null;
      for (let k = 0; k < DIG_SPAN; k++) {
        const next = base(current) + k;
        if (next > dig || seen.has(next)) continue;
        seen.add(next);
        previous.set(next, current);
        if (next === dig) {
          reached = true;
          break;
        }
        frontier.push(next);
      }
    }
    if (!reached || suppressed(dig)) return null;
    const chain: number[] = [dig];
    while (chain[0] !== check) chain.unshift(previous.get(chain[0]!)!);
    for (let step = 0; step + 1 < chain.length; step++)
      witness.set(chain[step]!, chain[step + 1]! - base(chain[step]!));
    check = dig;
  }
  // After the last observed dig (or with none): keep each check suppressed, else leave it free.
  while (check < lifeEnd) {
    if (check !== (digs.at(-1) ?? Number.NaN) && !suppressed(check)) return witness;
    let chosen: number | null = null;
    for (let k = 0; k < DIG_SPAN; k++) {
      const next = base(check) + k;
      if (next >= lifeEnd || suppressed(next)) {
        chosen = k;
        break;
      }
    }
    if (chosen === null) return witness;
    witness.set(check, chosen);
    check = base(check) + chosen;
  }
  return witness;
}

export interface InfernoReplaySession extends ReplaySession {
  readonly engine: SimulationEngine;
  readonly ledger: ConstrainedDecisions;
  /** Capture life key per sim actor id, as mapped at spawn. */
  readonly mapping: ReadonlyMap<string, string>;
  readonly skippedConditioning: string[];
  /** A conditioned player splat the sim applied as less damage (the NPC had fewer HP left). */
  cappedHit(tick: number, target: string): boolean;
}

function lifeName(index: CaptureIndex, life: ActorLife): string {
  if (life.kind === 'player') return 'player';
  const species = speciesOf(index.npcIdOf.get(life));
  const pillar = index.pillarOf.get(life);
  return pillar ? `pillar:${pillar}` : `${species?.name ?? 'npc'}#${lifeKey(life).slice(4)}`;
}

export function openInfernoReplay(window: InfernoWindow): InfernoReplaySession {
  const index = captureIndex(window.capture, window.stream, window.lastTick);
  const spawnTick = index.waveSpawns.get(window.firstWave);
  if (spawnTick === undefined)
    throw new RangeError(`${window.capture} stream ${window.stream} has no wave ${window.firstWave}`);
  // capture tick = sim tick + offset; the encounter spawns the window's first wave this many ticks
  // after control (sim tick 0): the captured +11 for wave 1, the next tick for a later start.
  const offset = spawnTick - (SIMULATION_START_TICK + startWaveDelayTicks(window.firstWave));
  const firstTick = offset + SIMULATION_START_TICK + 1;
  const simTick = (captureTick: number) => captureTick - offset;
  const captureTick = (sim: number) => sim + offset;

  const ledger = new ConstrainedDecisions();
  setResolvedArenaConfig('inferno', loadInfernoArena());
  const encounter = new InfernoEncounter(1, {
    decisionRandom: (stream, wave, next) => ledger.wrap(`${stream}:${wave}`, next),
  });
  const startTile = index.player.get(firstTick - 1);
  if (!startTile) throw new RangeError(`No player tile at ${window.capture} t${firstTick - 1}`);
  const engine = new SimulationEngine({
    encounter,
    combatSeed: 1,
    startPos: [...startTile],
    // Opened on wave 1, so the tick-0 move to the window's wave keeps the capture's tile (a start on
    // the default wave, 69, would be moved to the practice start tile by that edit).
    mechanics: { [INFERNO_START_WAVE_KEY]: '1' },
    combatDecisions: (next) => ledger.wrap('combat', next),
  });
  const world = Reflect.get(engine, 'worldState') as WorldState;

  // Window start state from the capture: standing pillars and their damage, the active prayer.
  const pillarLives = new Map<PillarKey, ActorLife>();
  const pillarDamage = new Map<PillarKey, number>();
  let prayer: PrayerType | null = null;
  const prayerState = new Map<number, boolean>();
  const present = new Set<ActorLife>(index.range.start.npcs.map((npc) => npc.life));
  const setVarbit = (id: number, value: number) => {
    if (PILLAR_VARBITS[id]) pillarDamage.set(PILLAR_VARBITS[id]!, value);
    if (PRAYER_VARBITS[id] !== undefined) prayerState.set(id, value === 1);
  };
  for (const { id, value } of index.range.start.varbits) setVarbit(id, value);
  for (const [tick, entry] of index.ticks) {
    if (tick >= firstTick) break;
    for (const event of entry.events) {
      if (event.type === 'actor' && event.actor.kind === 'npc') {
        if (event.op === 'del') present.delete(event.actor);
        else present.add(event.actor);
      }
      if (event.type === 'varbit') setVarbit(event.id, event.value);
    }
  }
  for (const [varbit, active] of prayerState) if (active) prayer = PRAYER_VARBITS[varbit]!;
  const preexisting = new Set(present);
  for (const life of present) {
    const key = index.pillarOf.get(life);
    // Pillars never stand from wave 67 (the end-of-66 collapse falls before such a window's spawn).
    if (key && window.firstWave <= LAST_PILLAR_WAVE) pillarLives.set(key, life);
  }
  engine.setMechanicsConfig({
    infiniteHealth: true,
    infiniteStamina: true,
    [INFERNO_START_WAVE_KEY]: String(window.firstWave),
    [INFERNO_DESTROYED_PILLAR_KEYS.west]: !pillarLives.has('west'),
    [INFERNO_DESTROYED_PILLAR_KEYS.south]: !pillarLives.has('south'),
    [INFERNO_DESTROYED_PILLAR_KEYS.northEast]: !pillarLives.has('northEast'),
  });
  const player = world.getPlayer();
  if (!player) throw new TypeError('Missing player');
  if (!player.isRunEnabled) engine.applyAction({ type: 'runToggle' });

  const conditioning: ConditioningNote[] = [
    {
      name: 'captured player damage',
      replaces:
        "the player's own attacks: every captured player-dealt splat (12/16/43, burn 74) lands on its tick through the hit queue, retaliation notified at the latest captured player attack animation, and a splash (failed-spell graphic 85, no splat) notifies its target with no damage; weapons, switches and specs are not in the capture",
    },
    {
      name: 'captured freezes',
      replaces:
        "the player's ice spells (the sim's own rule, cast + 1, needs its player attacks): NPCs given the ice impact graphic are bound from the tick after the cast for the spell's duration",
    },
    { name: 'player hitpoints', replaces: 'player HP, eating and death (infinite health)' },
    { name: 'player prayer points and run energy', replaces: 'prayer drain/restores and run energy (held full)' },
    {
      name: 'window start',
      replaces:
        'the run up to the window: player tile, active prayer, standing pillars and their damage varbits; NPCs left from the previous wave are not simulated',
    },
    {
      name: 'player movement',
      replaces: 'movement clicks (absent from the capture): each tick clicks the captured end-of-tick tile, run on',
    },
  ];

  // Sim actor <-> capture life, mapped at spawn by NPC type and tile, in add order for identical ones.
  const simToLife = new Map<string, ActorLife>();
  const lifeToSim = new Map<ActorLife, string>();
  const mapping = new Map<string, string>();
  const bind = (simId: string, life: ActorLife) => {
    simToLife.set(simId, life);
    lifeToSim.set(life, simId);
    mapping.set(simId, lifeName(index, life));
  };
  const nameOfSim = (simId: string): string => {
    if (simId === player.id) return 'player';
    const life = simToLife.get(simId);
    return life ? lifeName(index, life) : `sim:${simId}`;
  };

  // --- Witnesses ---------------------------------------------------------------------------------------
  const waveWitnesses = new Map<number, WaveWitness | null>();
  const witnessFor = (wave: number) => {
    if (!waveWitnesses.has(wave)) waveWitnesses.set(wave, waveWitness(index, wave));
    return waveWitnesses.get(wave)!;
  };
  const digWitnesses = new Map<ActorLife, Map<number, number> | null>();
  /** One captured splat per attack, the accuracy and damage draws of one attack sharing it. */
  const attackSplats = new Map<string, number | null>();
  const consumedSplats = new Set<HitEvent>();
  const seqAt = (life: ActorLife, tick: number) => index.seqs.get(life)?.get(tick) ?? [];
  const constraint = (key: DecisionKey, outcome: ForcedOutcome, evidence: string): DecisionConstraint => ({
    ...key,
    outcome,
    evidence,
    optional: true,
  });
  const choice = (label: string, test: (value: unknown) => boolean): ForcedOutcome => ({
    kind: 'choose',
    label,
    matches: test,
  });
  const sameTile = (value: unknown, wanted: readonly number[]) =>
    Array.isArray(value) && value[0] === wanted[0] && value[1] === wanted[1];

  /** The captured splat the attack (`key`) produced: next unconsumed non-player splat on its target at impact. */
  const splatFor = (key: DecisionKey): number | null => {
    const memo = `${key.tick}|${key.actorId}|${key.targetId}`;
    if (attackSplats.has(memo)) return attackSplats.get(memo)!;
    const attacker = key.actorId ? simToLife.get(key.actorId) : undefined;
    const target = key.targetId === player.id ? 'player' : key.targetId ? simToLife.get(key.targetId) : undefined;
    let value: number | null = null;
    if (attacker && target) {
      const tick = captureTick(key.tick);
      const flight = index.projectiles.get(attacker)?.get(tick)?.[0];
      const npcId = index.npcIdOf.get(attacker);
      const jadRange = npcId === INFERNO_WAVE_NPC_IDS.jad && seqAt(attacker, tick - 3).includes(ZUK_SEQS.jad.range);
      const impact =
        flight?.endtime !== undefined ? tick + Math.floor(flight.endtime / 30) : jadRange ? tick + 2 : tick;
      const events = index.ticks.get(impact)?.events ?? [];
      const onTarget = events.filter(
        (event): event is HitEvent =>
          event.type === 'hit' &&
          !consumedSplats.has(event) &&
          event.actor !== null &&
          (target === 'player' ? event.actor.kind === 'player' : event.actor === target) &&
          (target === 'player' || !PLAYER_DEALT_SPLATS.has(event.id)),
      );
      const splat =
        onTarget.find((event) => index.splatAttacker.get(event) === attacker) ??
        onTarget.find((event) => index.splatAttacker.get(event) === null);
      if (splat) {
        consumedSplats.add(splat);
        value = splat.value;
      }
    }
    attackSplats.set(memo, value);
    return value;
  };

  ledger.resolver = (key, method, support, stream) => {
    const [streamName, waveText] = stream.split(':');
    const life = key.actorId ? simToLife.get(key.actorId) : undefined;
    const tick = captureTick(key.tick);
    switch (key.site) {
      case 'inferno.layout.slot':
      case 'inferno.layout.jad': {
        const witness = streamName === 'layout' ? witnessFor(Number(waveText)) : null;
        const swaps = key.site === 'inferno.layout.slot' ? witness?.slotSwaps : witness?.jadSwaps;
        const value = key.ordinal === undefined ? undefined : swaps?.[key.ordinal];
        return value === undefined ? null : constraint(key, { kind: 'int', value }, witness!.evidence);
      }
      case 'inferno.layout.nibbler_x':
      case 'inferno.layout.nibbler_y': {
        const witness = streamName === 'layout' ? witnessFor(Number(waveText)) : null;
        const position = key.ordinal === undefined ? undefined : witness?.nibblers[key.ordinal];
        if (!position) return null;
        const value = key.site.endsWith('_x') ? position[0] : position[1];
        return constraint(key, { kind: 'int', value }, witness!.evidence);
      }
      case 'inferno.nibbler.pillar': {
        const witness = streamName === 'nibbler_target' ? witnessFor(Number(waveText)) : null;
        const pillar = witness?.pillar;
        return pillar
          ? constraint(
              key,
              choice(pillar, (value) => value === pillar),
              `wave ${waveText} ${witness?.pillarEvidence}`,
            )
          : null;
      }
      case 'inferno.blob.style': {
        if (!life) return null;
        const release = index.projectiles.get(life)?.get(tick + 3)?.[0];
        if (!release) return null;
        const range = release.id === 1378;
        if (!range && release.id !== 1380) return null;
        return constraint(key, { kind: 'chance', value: range }, `release line ${release.source.line}`);
      }
      case 'inferno.blob.melee': {
        if (!life) return null;
        if (seqAt(life, tick).includes(INFERNO_WAVE_SEQS.blob.melee))
          return constraint(key, { kind: 'chance', value: true }, `melee at t${tick}`);
        if (index.projectiles.get(life)?.get(tick + 3))
          return constraint(key, { kind: 'chance', value: false }, `read at t${tick}, release t${tick + 3}`);
        return null;
      }
      case 'inferno.meleer.dig_interval': {
        if (!life || method !== 'int') return null;
        if (!digWitnesses.has(life)) {
          const record = index.range.lives.find((candidate) => candidate.life === life);
          const added = record?.start ?? tick;
          const resurrected = [...(index.ticks.get(added)?.events ?? [])].some(
            (event) => event.type === 'sequence' && event.id === INFERNO_WAVE_SEQS.mager.resurrect,
          );
          const ticksOf = (seq: number) =>
            [...(index.seqs.get(life) ?? [])].filter(([, ids]) => ids.includes(seq)).map(([at]) => at);
          digWitnesses.set(
            life,
            digWitness(
              ticksOf(INFERNO_WAVE_SEQS.meleer.attack),
              ticksOf(INFERNO_WAVE_SEQS.meleer.dig_down),
              added + (resurrected ? DIG_FIRST_RESURRECTED : DIG_FIRST),
              record?.end ?? Number.POSITIVE_INFINITY,
            ),
          );
        }
        const value = digWitnesses.get(life)?.get(tick);
        return value === undefined ? null : constraint(key, { kind: 'int', value }, 'dig-check witness');
      }
      case 'npc.movement.overlap_escape': {
        const move = life ? index.moves.get(life)?.get(tick) : undefined;
        if (!life && key.actorId) {
          // Added this tick (a split child born under the player, Q t895): its escape is hidden in its
          // add tick, so the add tile one cardinal step from its birth tile witnesses the direction.
          const npc = world.getNpc(key.actorId);
          const steps = (index.adds.get(tick) ?? [])
            .filter((add) => npc && add.npcId === npc.npcTypeId)
            .map((add) => [local(add.coord)[0] - npc!.position[0], local(add.coord)[1] - npc!.position[1]] as const)
            .filter(([dx, dy]) => Math.abs(dx) + Math.abs(dy) === 1);
          if (steps.length !== 1) return null;
          const [dx, dy] = steps[0]!;
          return constraint(
            key,
            choice(`${dx},${dy}`, (value) => sameTile(value, [dx, dy])),
            `add at t${tick}`,
          );
        }
        if (!move?.newcoord) return null;
        const dx = move.newcoord[0] - move.coord[0];
        const dy = move.newcoord[1] - move.coord[1];
        if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
        return constraint(
          key,
          choice(`${dx},${dy}`, (value) => sameTile(value, [dx, dy])),
          `line ${move.source.line}`,
        );
      }
      case 'inferno.mager.rez': {
        if (!life) return null;
        const seqs = seqAt(life, tick);
        if (seqs.includes(INFERNO_WAVE_SEQS.mager.resurrect))
          return constraint(key, { kind: 'chance', value: true }, `rez at t${tick}`);
        if (seqs.includes(ZUK_SEQS.mager.magic) || seqs.includes(ZUK_SEQS.mager.melee))
          return constraint(key, { kind: 'chance', value: false }, `attack at t${tick}`);
        return null;
      }
      case 'inferno.mager.rez.corpse':
      case 'inferno.mager.rez.tile': {
        const revived = (index.adds.get(tick) ?? []).find(
          (add) => add.npcId !== undefined && add.npcId !== INFERNO_WAVE_NPC_IDS.jad_healer,
        );
        if (!revived) return null;
        const species = speciesOf(revived.npcId)?.name;
        // The draw is the birth SW tile, not the add tile: the revived NPC steps in its add tick. The
        // caster faces the birth tile and graphic 444 sits at birth + (size - 2) (P t4869, P:85377-85383).
        const events = index.ticks.get(tick)?.events ?? [];
        const graphic = events.find((event) => event.type === 'map_anim' && event.id === RESURRECTION_GRAPHIC);
        const facing = events.find(
          (event) => event.type === 'facing' && event.mode === 'coord' && event.actor === life && event.coord,
        );
        const offset = (speciesOf(revived.npcId)?.size ?? 2) - 2;
        const position: Coordinate | null =
          graphic?.type === 'map_anim'
            ? [local(graphic.coord)[0] - offset, local(graphic.coord)[1] - offset]
            : facing?.type === 'facing' && facing.coord
              ? local(facing.coord)
              : null;
        if (key.site === 'inferno.mager.rez.tile' && position === null) return null;
        return key.site === 'inferno.mager.rez.corpse'
          ? constraint(
              key,
              choice(String(species), (value) => (value as { species?: string }).species === species),
              `line ${revived.source.line}`,
            )
          : constraint(
              key,
              choice(tile(position!), (value) => sameTile(value, position!)),
              `birth tile, line ${revived.source.line}`,
            );
      }
      case 'inferno.jad.style': {
        if (!life) return null;
        const seqs = seqAt(life, tick);
        const style = seqs.includes(ZUK_SEQS.jad.magic)
          ? 'magic'
          : seqs.includes(ZUK_SEQS.jad.range)
            ? 'range'
            : seqs.includes(ZUK_SEQS.jad.melee)
              ? 'melee'
              : null;
        return style
          ? constraint(
              key,
              choice(style, (value) => value === style),
              `tell at t${tick}`,
            )
          : null;
      }
      case 'inferno.jad_healer.tile': {
        // The sim spawns healers in draw order and gives each its turn in that order; the game turns NPCs
        // in index order, which the printed add order need not follow (P t9814 prints 62229 before
        // 62227, and at t9843 62229 enters the tile 62227 has just left).
        const healers = (index.adds.get(tick) ?? [])
          .filter((add) => add.npcId === INFERNO_WAVE_NPC_IDS.jad_healer)
          .sort((first, second) => first.actor.index - second.actor.index);
        const healer = key.ordinal === undefined ? undefined : healers[key.ordinal];
        if (!healer) return null;
        const position = local(healer.coord);
        return constraint(
          key,
          choice(tile(position), (value) => sameTile(value, position)),
          `line ${healer.source.line}`,
        );
      }
      case 'npc.attack.select': {
        if (!life) return null;
        const seqs = seqAt(life, tick);
        const type = seqs.includes(ZUK_SEQS.ranger.range)
          ? 'range'
          : seqs.includes(ZUK_SEQS.mager.magic)
            ? 'magic'
            : seqs.some((seq) => seq === ZUK_SEQS.ranger.melee || seq === ZUK_SEQS.mager.melee)
              ? 'melee'
              : null;
        return type
          ? constraint(
              key,
              choice(type, (value) => (value as { plan?: { damageType?: string } }).plan?.damageType === type),
              `attack at t${tick}`,
            )
          : null;
      }
      case 'npc.attack.accuracy': {
        const value = splatFor(key);
        if (value === null) return null;
        const accurate = value > 0 || (support.probability ?? 0) >= 1;
        return constraint(key, { kind: 'chance', value: accurate }, `splat ${value}`);
      }
      case 'npc.attack.damage':
      case 'inferno.nibbler.damage': {
        const value = splatFor(key);
        return value === null ? null : constraint(key, { kind: 'int', value }, `splat ${value}`);
      }
      default:
        return null;
    }
  };

  // --- Inputs ------------------------------------------------------------------------------------------
  const playerSplats = new Map<number, { target: ActorLife; event: HitEvent }[]>();
  for (const [tick, entry] of index.ticks) {
    if (tick < firstTick || tick > window.lastTick) continue;
    for (const event of entry.events) {
      if (event.type !== 'hit' || !event.actor || event.actor.kind !== 'npc') continue;
      if (!PLAYER_DEALT_SPLATS.has(event.id) || index.pillarOf.has(event.actor)) continue;
      const list = playerSplats.get(tick) ?? [];
      list.push({ target: event.actor, event });
      playerSplats.set(tick, list);
    }
  }
  const attackTicks = index.playerAttackTicks;
  const launchOf = (tick: number): number | null => {
    let launch: number | null = null;
    for (const candidate of attackTicks) {
      if (candidate > tick) break;
      if (tick - candidate <= 6) launch = candidate;
    }
    return launch;
  };
  const notifyAt = new Map<
    number,
    { target: ActorLife; launch: number; impact: number; seq: number; accurate: boolean }[]
  >();
  for (const [tick, splats] of playerSplats) {
    for (const { target, event } of splats) {
      if (event.id === BURN_SPLAT) continue;
      const launch = launchOf(tick);
      if (launch === null) continue;
      const seq = index.ticks
        .get(launch)
        ?.events.find(
          (candidate) =>
            candidate.type === 'sequence' && candidate.actor?.kind === 'player' && PLAYER_ATTACK_SEQS.has(candidate.id),
        );
      const notifyTick = Math.min(launch + 1, tick);
      const list = notifyAt.get(notifyTick) ?? [];
      list.push({
        target,
        launch,
        impact: tick,
        seq: seq?.type === 'sequence' ? seq.id : 0,
        accurate: event.id !== 12,
      });
      notifyAt.set(notifyTick, list);
    }
  }
  // A splash still provokes its target: P t9819 healer 62227 is splashed (graphic 85, no splat) and
  // walks at the player from t9820 (P:177631-177679). Notified like a splat, with no damage to inject.
  for (const [tick, entry] of index.ticks) {
    if (tick < firstTick || tick >= window.lastTick) continue;
    for (const event of entry.events) {
      if (event.type !== 'spotanim' || event.id !== FAILED_SPELL_IMPACT || event.actor?.kind !== 'npc') continue;
      const target = event.actor;
      const impact = tick + 1 + Math.floor((event.delay ?? 0) / 30);
      if (playerSplats.get(impact)?.some((splat) => splat.target === target)) continue;
      const list = notifyAt.get(tick + 1) ?? [];
      list.push({ target, launch: tick, impact, seq: [...PLAYER_MAGIC_SEQS][0]!, accurate: false });
      notifyAt.set(tick + 1, list);
    }
  }
  const skippedConditioning: string[] = [];
  /** Conditioned hits by impact tick and sim target: excluded from the hit comparison. */
  const injectedAt = new Map<number, Map<string, number[]>>();
  const inject = (simId: string, launch: number, impact: number, value: number, accurate: boolean) => {
    enqueueEnginePendingHit(engine, {
      sourceId: player.id,
      targetId: simId,
      style: 'typeless',
      attackKind: 'typeless',
      launchTick: simTick(launch),
      impactTick: simTick(impact),
      rolledDamage: value,
      accuracySucceeded: accurate,
    });
    const byTarget = injectedAt.get(impact) ?? new Map<string, number[]>();
    byTarget.set(simId, [...(byTarget.get(simId) ?? []), value]);
    injectedAt.set(impact, byTarget);
  };

  const proxies = () => INFERNO_PILLARS.map((pillar) => world.getNpc(`inferno_pillar_${pillar.key}`) ?? null);

  const spawnDiverged = new Set<string>();
  const firstDivergence = new Map<string, string>();
  /** Who landed the hits on `tick|target`, on either side (the hit channel is keyed by target). */
  const hitAttackers = new Map<string, Set<string>>();
  const simPlayer = new Map<number, Coordinate>();
  const capped = new Set<string>();
  const simWave = new Map<number, number>();
  const captureWave = (tick: number) => {
    let wave = window.firstWave;
    for (const [number, at] of index.waveSpawns) if (at <= tick && number > wave) wave = number;
    return wave;
  };
  /** Sim attacks by `targetId|impactTick`, from `zuk_attack`. */
  const simImpacts = new Map<string, Set<string>>();

  // --- Sim observation state -----------------------------------------------------------------------------
  let previous = new Map<string, { position: Coordinate; npc: NpcActor }>();
  const pillarHp = new Map<string, number>();

  const session: InfernoReplaySession = {
    firstTick,
    lastTick: window.lastTick,
    engine,
    ledger,
    mapping,
    skippedConditioning,
    decisions: ledger,
    conditioning,
    applyInputs(tick) {
      if (tick === firstTick && prayer !== null) engine.applyAction({ type: 'protectionPrayer', prayer });
      if (tick === firstTick + 1) {
        // The proxies materialized on the first tick (mapped then); set their captured damage.
        for (const proxy of proxies()) {
          if (!proxy) continue;
          const key = proxy.id.slice('inferno_pillar_'.length) as PillarKey;
          proxy.vitals.hp = PILLAR_MAX_HP - (pillarDamage.get(key) ?? 0);
          pillarHp.set(proxy.id, proxy.vitals.hp);
        }
      }
      for (const event of index.ticks.get(tick)?.events ?? []) {
        if (event.type !== 'varbit' || PRAYER_VARBITS[event.id] === undefined) continue;
        const changed = PRAYER_VARBITS[event.id]!;
        if (event.value === 1) engine.applyAction({ type: 'protectionPrayer', prayer: changed });
        else if (player.activePrayer === changed) engine.applyAction({ type: 'protectionPrayer', prayer: null });
      }
      player.prayerState.points = player.prayerState.maxPoints;
      player.runEnergy = { ...player.runEnergy, energy: RUN_ENERGY_MAX };
      if (!player.isRunEnabled) player.isRunEnabled = true;
      // Frozen from the tick after the cast (P t581 cast, nibblers stop at t582, damage at t586).
      for (const { life, duration } of index.freezes.get(tick - 1) ?? []) {
        const npc = lifeToSim.has(life) ? world.getNpc(lifeToSim.get(life)!) : undefined;
        if (!npc) continue;
        npc.debuffs = { ...npc.debuffs, boundFromTick: simTick(tick), boundUntilTick: simTick(tick) + duration };
      }
      for (const notice of notifyAt.get(tick) ?? []) {
        const simId = lifeToSim.get(notice.target);
        const npc = simId ? world.getNpc(simId) : undefined;
        if (!npc) continue;
        notifyNpcOfPlayerAttack(npc, {
          sourceId: player.id,
          launchTick: simTick(notice.launch),
          impactTick: simTick(notice.impact),
          style: PLAYER_MAGIC_SEQS.has(notice.seq) ? 'magic' : PLAYER_MELEE_SEQS.has(notice.seq) ? 'melee' : 'range',
          accuracySucceeded: notice.accurate,
        });
      }
      for (const { target, event } of playerSplats.get(tick) ?? []) {
        const simId = lifeToSim.get(target);
        if (!simId || !world.getNpc(simId)) {
          skippedConditioning.push(
            `t${tick} ${lifeName(index, target)} splat ${event.value} (line ${event.source.line})`,
          );
          continue;
        }
        inject(simId, tick - 1, tick, event.value, event.id !== 12);
      }
    },
    advance() {
      const tick = captureTick(engine.currentTick + 1);
      const target = index.player.get(tick) ?? player.position;
      engine.advanceTick([...target]);
    },
    observe(tick) {
      const out: Observation[] = [];
      const events = engine.getLastTickEvents();
      const now = new Map<string, { position: Coordinate; npc: NpcActor }>();
      for (const npc of world.getNpcs()) now.set(npc.id, { position: [...npc.position], npc });
      // New sim actors: bind to this tick's captured adds of the same type on the same tile, then (for a
      // type added exactly once on both sides) by type alone; the spawn channel still compares the tile.
      const unboundAdds = (index.adds.get(tick) ?? []).filter((add) => !lifeToSim.has(add.actor));
      // An NPC added inside the NPC turns takes an ordinary first step that tick, and the capture's `add`
      // tile is where it ended: compare the end-of-tick tile, with no separate move for that step.
      const spawnTile = (npc: NpcActor): Coordinate => [...npc.position];
      const spawned = [...now].filter(([id]) => !previous.has(id));
      const unbound: [string, NpcActor, Coordinate][] = [];
      for (const [id, { npc }] of spawned) {
        const position = spawnTile(npc);
        if (tick === firstTick && npc.npcTypeId === INFERNO_WAVE_NPC_IDS.pillar) {
          // Pre-existing in the capture: the window's standing pillars.
          const life = pillarLives.get(id.slice('inferno_pillar_'.length) as PillarKey);
          if (life) bind(id, life);
          continue;
        }
        const match = unboundAdds.findIndex(
          (add) => add.npcId === npc.npcTypeId && tile(local(add.coord)) === tile(position),
        );
        if (match >= 0) {
          bind(id, unboundAdds[match]!.actor);
          unboundAdds.splice(match, 1);
        } else unbound.push([id, npc, position]);
      }
      for (const [id, npc] of unbound) {
        const sameType = (candidate: { npcTypeId: number }) => candidate.npcTypeId === npc.npcTypeId;
        const adds = unboundAdds.filter((add) => add.npcId === npc.npcTypeId);
        if (adds.length === 1 && unbound.filter(([, other]) => sameType(other)).length === 1) {
          bind(id, adds[0]!.actor);
          unboundAdds.splice(unboundAdds.indexOf(adds[0]!), 1);
        }
      }
      for (const [id, { npc }] of spawned) {
        if (tick === firstTick && npc.npcTypeId === INFERNO_WAVE_NPC_IDS.pillar) continue;
        out.push({ channel: 'spawn', tick, actor: nameOfSim(id), value: `${npc.npcTypeId}@${tile(spawnTile(npc))}` });
      }
      for (const [id] of previous)
        if (!now.has(id)) out.push({ channel: 'despawn', tick, actor: nameOfSim(id), value: 'del' });
      for (const [id, { npc, position }] of now) {
        const before = previous.get(id);
        if (!before || tile(before.position) === tile(position)) continue;
        const path = npc.movementPath ?? [];
        out.push({
          channel: 'move',
          tick,
          actor: nameOfSim(id),
          value: path.length > 1 ? `${tile(position)} via ${path.slice(0, -1).map(tile).join(' ')}` : tile(position),
        });
      }
      const sizeOf = (id: string) => now.get(id)?.npc.size ?? previous.get(id)?.npc.size ?? 1;
      const projectileCandidates = [...new Set([...previous.keys(), ...now.keys()])]
        .filter((id) => !id.startsWith('inferno_pillar'))
        .map((id) => [id, previous.get(id)?.position, now.get(id)?.position, sizeOf(id)] as const);
      const injectedLeft = new Map([...(injectedAt.get(tick) ?? [])].map(([id, values]) => [id, [...values]]));
      for (const event of events) {
        if (event.type !== 'zuk_attack') continue;
        const key = `${String(event.targetId)}|${Number(event.impactTick)}`;
        const set = simImpacts.get(key) ?? new Set<string>();
        set.add(String(event.sourceId));
        simImpacts.set(key, set);
      }
      for (const event of events) {
        if (event.type === 'encounter_visual') {
          const visual = event as GameEvent & {
            animations: readonly { actorId: string; clipId: string }[];
            projectiles: readonly NpcProjectileCue[];
          };
          for (const animation of visual.animations) {
            const npc = now.get(animation.actorId)?.npc ?? previous.get(animation.actorId)?.npc;
            const seq = speciesOf(npc?.npcTypeId)?.clips[animation.clipId];
            if (seq !== undefined)
              out.push({ channel: 'attack', tick, actor: nameOfSim(animation.actorId), value: `seq ${seq}` });
          }
          // The animating NPC launched it; a launch without an animation is the next attack event's.
          const position = events.indexOf(event);
          const launcher =
            visual.animations[0]?.actorId ??
            (events.slice(position + 1).find((next) => next.type === 'zuk_attack') as { sourceId?: string } | undefined)
              ?.sourceId;
          for (const cue of visual.projectiles) {
            const source = tile([Math.floor(cue.sourcePosition[0]), Math.floor(cue.sourcePosition[1])]);
            const attacker = launcher ?? (attributeSource(source, projectileCandidates) as string | null);
            const target =
              cue.target.kind === 'actor' ? nameOfSim(cue.target.actorId) : `tile ${tile(cue.target.position)}`;
            out.push({
              channel: 'projectile_origin',
              tick,
              actor: attacker ? nameOfSim(attacker) : 'world',
              value: `${cue.spotAnimId} ${source}`,
            });
            out.push({
              channel: 'projectile',
              tick,
              actor: attacker ? nameOfSim(attacker) : 'world',
              value: projectileValue(cue.spotAnimId, target, [
                cue.startDelayCycles,
                cue.endDelayCycles,
                cue.slope,
                cue.startOffset,
                cue.startHeight,
                cue.endHeight,
              ]),
            });
          }
        } else if (event.type === 'zuk_death') {
          const actorId = String(event.actorId);
          const npc = now.get(actorId)?.npc ?? previous.get(actorId)?.npc;
          const death = speciesOf(npc?.npcTypeId)?.death;
          if (death !== undefined)
            out.push({ channel: 'attack', tick, actor: nameOfSim(actorId), value: `seq ${death}` });
        } else if (event.type === 'inferno_pillar_collapse') {
          const pillar = String(event.pillar);
          out.push({
            channel: 'attack',
            tick,
            actor: nameOfSim(`inferno_pillar_${pillar}_collapse`),
            value: `seq ${INFERNO_WAVE_SEQS.pillarCollapse}`,
          });
        } else if (event.type === 'hit_applied') {
          const targetId = String(event.targetId);
          const left = injectedLeft.get(targetId);
          const damage = Number(event.damage);
          const at = left?.indexOf(damage) ?? -1;
          if (left && at >= 0) {
            left.splice(at, 1);
            continue;
          }
          const npc = now.get(targetId)?.npc ?? previous.get(targetId)?.npc;
          if (left?.some((value) => value > damage) && npc && npc.vitals.hp <= 0)
            capped.add(`${tick}|${nameOfSim(targetId)}`);
          const target = nameOfSim(targetId);
          const attackers = hitAttackers.get(`${tick}|${target}`) ?? new Set<string>();
          for (const attacker of simImpacts.get(`${targetId}|${engine.currentTick}`) ?? [])
            attackers.add(nameOfSim(attacker));
          hitAttackers.set(`${tick}|${target}`, attackers);
          out.push({ channel: 'hit', tick, actor: target, value: String(damage) });
        }
      }
      for (const proxy of proxies()) {
        if (!proxy) continue;
        const before = pillarHp.get(proxy.id);
        if (before !== undefined && before !== proxy.vitals.hp)
          out.push({
            channel: 'pillar',
            tick,
            actor: nameOfSim(proxy.id),
            value: String(PILLAR_MAX_HP - proxy.vitals.hp),
          });
        pillarHp.set(proxy.id, proxy.vitals.hp);
      }
      out.push({ channel: 'player', tick, actor: 'player', value: tile(player.position) });
      simPlayer.set(tick, [...player.position]);
      const snapshot = engine.getEncounterSnapshot();
      // The last wave the sim has spawned (in the countdown the state already names the next one).
      if (snapshot.kind === 'inferno')
        simWave.set(tick, snapshot.state.phase === 'countdown' ? snapshot.state.wave - 1 : snapshot.state.wave);
      previous = now;
      return out;
    },
    expected(tick) {
      const out: Observation[] = [];
      const entry = index.ticks.get(tick);
      if (!entry) return out;
      const playerTile = index.player.get(tick);
      if (playerTile) out.push({ channel: 'player', tick, actor: 'player', value: tile(playerTile) });
      const simulated = (life: ActorLife | null | undefined) =>
        !life ||
        life.kind === 'player' ||
        !preexisting.has(life) ||
        pillarLives.has(index.pillarOf.get(life) as PillarKey);
      for (const event of entry.events) {
        const line = event.source.line;
        // NPCs left over from the previous wave are not simulated, and nothing but the player is
        // compared before the window's first spawn.
        if (tick < spawnTick) continue;
        if ('actor' in event && !simulated(event.actor)) continue;
        switch (event.type) {
          case 'actor': {
            if (event.actor.kind === 'player') break;
            const actor = lifeName(index, event.actor);
            if (event.op === 'add')
              out.push({ channel: 'spawn', tick, actor, value: `${event.npcId}@${tile(local(event.coord))}`, line });
            else if (event.op === 'del') out.push({ channel: 'despawn', tick, actor, value: 'del', line });
            else if (event.newcoord) {
              const destination = tile(local(event.newcoord));
              const path = event.path ?? [];
              out.push({
                channel: 'move',
                tick,
                actor,
                value:
                  path.length > 1
                    ? `${destination} via ${path
                        .slice(0, -1)
                        .map((step) => tile(local(step)))
                        .join(' ')}`
                    : destination,
                line,
              });
            }
            break;
          }
          case 'sequence':
            if (event.actor?.kind === 'npc' && ACTION_SEQS.has(event.id))
              out.push({
                channel: 'attack',
                tick,
                actor: lifeName(index, event.actor),
                value: `seq ${event.id}`,
                line,
              });
            break;
          case 'projectile': {
            if (!NPC_PROJECTILES.has(event.id)) break;
            const source = index.projectileSource.get(event);
            if ((source && !simulated(source)) || (!source && tick < spawnTick)) break;
            const target = event.targetActor?.life
              ? lifeName(index, event.targetActor.life)
              : `tile ${tile(local(event.to))}`;
            out.push({
              channel: 'projectile_origin',
              tick,
              actor: source ? lifeName(index, source) : 'world',
              value: `${event.id} ${tile(local(event.from))}`,
              line,
            });
            out.push({
              channel: 'projectile',
              tick,
              actor: source ? lifeName(index, source) : 'world',
              value: projectileValue(event.id, target, [
                event.starttime,
                event.endtime,
                event.angle,
                event.progress,
                event.startheight,
                event.endheight,
              ]),
              line,
            });
            break;
          }
          case 'hit': {
            if (!event.actor) break;
            if (event.actor.kind === 'npc' && PLAYER_DEALT_SPLATS.has(event.id)) break;
            const target = lifeName(index, event.actor);
            const attacker = index.splatAttacker.get(event);
            if (attacker && !simulated(attacker)) break;
            const attackers = hitAttackers.get(`${tick}|${target}`) ?? new Set<string>();
            for (const candidate of index.splatCandidates.get(event) ?? []) attackers.add(lifeName(index, candidate));
            hitAttackers.set(`${tick}|${target}`, attackers);
            out.push({ channel: 'hit', tick, actor: target, value: String(event.value), line });
            break;
          }
          case 'varbit': {
            const pillar = PILLAR_VARBITS[event.id];
            if (pillar)
              out.push({ channel: 'pillar', tick, actor: `pillar:${pillar}`, value: String(event.value), line });
            break;
          }
          default:
            break;
        }
      }
      return out;
    },
    recentDecisions(actor, tick) {
      const simIds = new Set([...mapping].filter(([, name]) => name === actor).map(([id]) => id));
      if (actor === 'player') simIds.add(player.id);
      if (actor.startsWith('sim:')) simIds.add(actor.slice(4));
      return ledger.recent(simTick(tick), (record) =>
        record.key.actorId === undefined
          ? actor === 'world'
          : simIds.has(record.key.actorId) || simIds.has(record.key.targetId ?? ''),
      );
    },
    cappedHit(tick, target) {
      return capped.has(`${tick}|${target}`);
    },
    explain(divergence) {
      const base = divergence.actor.replace(/ \(unattributed\)$/, '');
      const earlier = firstDivergence.get(base);
      if (divergence.channel === 'hit') {
        // Hits are keyed by their target; a hit from an attacker that already diverged follows it.
        for (const attacker of hitAttackers.get(`${divergence.tick}|${base}`) ?? []) {
          const before = firstDivergence.get(attacker);
          if (before) return `follows its attacker ${attacker}'s earlier divergence (${before})`;
        }
      } else if (!earlier) firstDivergence.set(base, `${divergence.channel}@t${divergence.tick}`);
      else if (divergence.channel !== 'player') return `follows this actor's earlier divergence (${earlier})`;
      // NPCs see the player's tile from the start of the tick: a tick on which (or after which) the
      // sim player stood elsewhere than the capture's says nothing about the NPCs.
      const off = (at: number) => {
        const sim = simPlayer.get(at);
        const captured = index.player.get(at);
        return sim !== undefined && captured !== undefined && tile(sim) !== tile(captured);
      };
      if (divergence.channel !== 'player' && [0, 1, 2].some((back) => off(divergence.tick - back)))
        return 'follows a player-position divergence (the input could not be reproduced)';
      // The sim is still on an earlier wave: what the capture's later wave does cannot be compared.
      if (
        divergence.unexpected.length === 0 &&
        (divergence.channel === 'spawn' || divergence.channel === 'pillar') &&
        (simWave.get(divergence.tick) ?? 0) < captureWave(divergence.tick)
      ) {
        spawnDiverged.add(divergence.actor);
        return `the sim has not reached wave ${captureWave(divergence.tick)} (it follows earlier divergences)`;
      }
      if (divergence.channel === 'spawn') {
        spawnDiverged.add(divergence.actor);
      } else if (spawnDiverged.has(divergence.actor)) {
        return 'follows its spawn divergence';
      }
      if (divergence.channel === 'attack' && divergence.missing.length === 0) {
        const life = [...lifeToSim.keys()].find((candidate) => lifeName(index, candidate) === divergence.actor);
        if (life && index.masked.get(divergence.tick)?.has(life))
          return 'the capture sent another sequence (a defend) for this actor on this tick, which masks the swing';
      }
      // A single-splat kill the capture animates on its kill tick (P 9 and Q 6, mostly Jal-Ak, e.g. P t847)
      // is not explained: no player projectile accounts for it (240/249 P kills with one launched in the
      // 4 ticks before animate at K+1), so nothing the replay could supply would promote it.
      if (divergence.channel === 'attack' && divergence.unexpected.length === 0) {
        const life = [...lifeToSim.keys()].find((candidate) => lifeName(index, candidate) === base);
        const death = life ? speciesOf(index.npcIdOf.get(life))?.death : undefined;
        const killed = (index.ticks.get(divergence.tick)?.events ?? []).some(
          (event) => event.type === 'dead' && event.actor === life,
        );
        if (death !== undefined && killed && divergence.missing.includes(`seq ${death}`))
          return 'death animated on its kill tick in the capture (N9, unexplained)';
      }
      const attackers =
        divergence.channel === 'hit'
          ? [...mapping]
              .filter(([, name]) => hitAttackers.get(`${divergence.tick}|${base}`)?.has(name))
              .map(([id]) => id)
          : [];
      return explainDivergence(divergence, mapping, ledger.records, simTick, attackers);
    },
  };
  return session;
}

function projectileValue(id: number, target: string, fields: readonly (number | undefined)[]): string {
  return `${id}->${target} [${fields.map((value) => value ?? '-').join(',')}]`;
}

const DAMAGE_SITES = new Set(['npc.attack.accuracy', 'npc.attack.damage', 'inferno.nibbler.damage']);

function explainDivergence(
  divergence: Divergence,
  mapping: ReadonlyMap<string, string>,
  records: readonly DecisionRecord[],
  simTick: (captureTick: number) => number,
  /** For the hit channel (keyed by target): the sim ids of the attackers involved. */
  attackers: readonly string[] = [],
): string | null {
  const names = new Set(mapping.values());
  const actor = divergence.actor.replace(/ \(unattributed\)$/, '');
  if (divergence.channel !== 'spawn' && actor.startsWith('sim:'))
    return 'unmapped sim actor: follows its spawn divergence';
  if (divergence.channel !== 'spawn' && actor.includes('#') && !names.has(actor))
    return 'capture actor never spawned in the sim: follows its spawn divergence';
  const simIds = new Set([...mapping].filter(([, name]) => name === actor).map(([id]) => id));
  for (const attacker of attackers) simIds.add(attacker);
  const tick = simTick(divergence.tick);
  const free = records.find(
    (record) =>
      record.constraint === null &&
      // A dig-check draw only schedules the next check, 40+ ticks on: it never explains a divergence in
      // this lookback, least of all the dig (or its absence) on its own tick.
      record.key.site !== 'inferno.meleer.dig_interval' &&
      record.key.tick <= tick &&
      record.key.tick >= tick - 12 &&
      (divergence.channel === 'spawn'
        ? record.key.site.startsWith('inferno.layout') || record.key.site === 'inferno.mager.rez'
        : record.key.actorId !== undefined && simIds.has(record.key.actorId)) &&
      (divergence.channel === 'hit'
        ? // A free damage draw explains a different value, never a missing or extra splat.
          DAMAGE_SITES.has(record.key.site) && divergence.missing.length === divergence.unexpected.length
        : !DAMAGE_SITES.has(record.key.site)),
  );
  return free ? `follows a free draw ${free.key.site}@t${free.key.tick} (${free.outcome})` : null;
}
