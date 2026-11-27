import { describe, expect, it } from 'vitest';
import { calculatePrayerDamage } from '../../../core/combat/damageCalculation';
import { isCoreEvent } from '../../../core/events/types';
import { isPlayerUnderFootprint, npcPursuitPath } from '../../../core/npcPursuit';
import { SimulationEngine } from '../../../core/SimulationEngine';
import type { WorldState } from '../../../core/WorldState';
import { EQUIPMENT_PRESETS } from '../../../data/playerPresets';
import { VOID_FLARE_FUSE_BAR_LEAD_TICKS, VOID_FLARE_UNTARGETABLE_TICKS } from '../../../npcs/yama/timing';
import { voidFlareExplosionBand } from '../../../npcs/yama/voidFlare';
import { wretchedDamageBonusPercent, wretchedMinimumHit } from '../../../npcs/yama/wretchedStrength';
import {
  DEATH_CHARGE_COOLDOWN_TICKS,
  DEATH_CHARGE_PROCS_UPGRADED,
  DEATH_CHARGE_SPEC_RESTORE,
  LIGHTBEARER_ITEM_ID,
  SPEC_REGEN_AMOUNT,
  SPEC_REGEN_TICKS,
  SPEC_REGEN_TICKS_LIGHTBEARER,
} from '../../../types/playerState';
import { type Coordinate, PrayerType } from '../../../types/simulation';
import { getYamaBeatInfo, VOID_FLARE_NPC_ID, VOID_FLARE_SPAWN_POSITIONS, YAMA_SIZE } from '../constants';
import {
  BASE_YAMA_CONFIG,
  BLOODIED_BLOWS_CONFIG,
  BLOODIED_BLOWS_P3_START_HP,
  CONTRACT_COMBAT_LEVELS,
  DIVINE_CONTINUOUS_FLARE_INTERVAL,
  DIVINE_SEVERANCE_CONFIG,
  FORFEIT_BREATH_CONFIG,
  GLYPHIC_ATTENUATION_CONFIG,
  GLYPHIC_ATTENUATION_P3_START_HP,
  MELEE_VOID_FLARE_CHARGE_TICKS,
  resolveEncounterConfig,
  SENSORY_CLOUDING_CONFIG,
  VOID_FLARE_CHARGE_TICKS,
  type VoidFlareExplosionDamage,
  YAMA_CONTRACT_P3_START_HP,
  YAMA_P3_START_HP,
  type YamaContractConfig,
} from '../contractConfig';
import { getWaveTiles, isWaveTile } from '../waves';
import { YamaEncounter } from '../YamaEncounter';
import { YAMA_FLARE_LIFECYCLES, YAMA_P3_CAPTURES, YAMA_SCORCHING_CASTS } from './fixtures/yamaP3Captures';

/**
 * Conformance of the phase-3 model against the captures it was derived from.
 *
 * Every number here comes from facts extracted from the captures
 * (`fixtures/yamaP3Captures.ts`), and the
 * suite derives each claim from those facts rather than from transcribed conclusions, so a model
 * change the captures contradict fails here.
 *
 * Decoding conventions:
 *   sim tick 0        = the `busy 1->0` after the LAST `yama_transition_phase 1->0`
 *   sim (x, y)        = world (x - 1472, y - 10048)
 *   map_anim delay    = client cycles, 30 per tick; the tile burns on emit + delay/30
 */

const CYCLES_PER_CLIENT_TICK = 30;
/** Ticks from Yama's cast animation to the hitsplat, constant across all four captures. */
const AUTO_ATTACK_FLIGHT_TICKS = 3;

const BASE_CAPTURE = 'yama-packet-data.txt';
const DIVINE_CAPTURE = 'yama-contract-of-divine-severance-packet-data-1.txt';
const DIVINE_CAPTURE_2 = 'yama_divine_severance.txt';
const FORFEIT_CAPTURE = 'yama_forfeit_breath.txt';
const GLYPHIC_CAPTURE = 'yama-contract-of-glyphic-attenuation-packet-data-1.txt';
const GLYPHIC_CAPTURE_2 = 'yama-contract-of-glyphic-attenuation-packet-data-2.txt';
const BLOODIED_CAPTURE = 'yama-contract-of-bloodied-blows-packet-data-1.txt';
const SENSORY_CAPTURE = 'yama-contract-of-sensory-clouding-packet-data-1(incomplete).txt';
const SENSORY_CAPTURE_2 = 'yama-contract-of-sensory-clouding-p3-contributed-packet-data(incomplete).txt';
const BASE_LONG_CAPTURE = 'yama-normal-contract-long-p3-packet-data.txt';
const BASE_KNOWN_GEAR_CAPTURE = 'yama-normal-contract-203-magic-def-223-range-def-p3-packet-data.txt';
/** Every base (no contract) phase 3 with a control tick. Only the first is in `ALL_CAPTURES`. */
const BASE_CAPTURES = [BASE_CAPTURE, BASE_LONG_CAPTURE, BASE_KNOWN_GEAR_CAPTURE];
/**
 * Captures whose player fought Yama from range, so EVERY beat Yama did not cast on is a
 * special. The glyphic captures are deliberately excluded: that contract is crush-only, so
 * its player stands in melee range and Yama sometimes swings instead of casting — the same
 * extra holes the base captures show, which their cadence test reads out of Yama's melee swings.
 */
const SIGIL_CAPTURES = [DIVINE_CAPTURE, DIVINE_CAPTURE_2, FORFEIT_CAPTURE, BLOODIED_CAPTURE, SENSORY_CAPTURE];
const GLYPHIC_CAPTURES = [GLYPHIC_CAPTURE, GLYPHIC_CAPTURE_2];
const ALL_CAPTURES = [BASE_CAPTURE, ...SIGIL_CAPTURES, ...GLYPHIC_CAPTURES];

interface WallTile {
  /** Sim tick the batch was emitted on. */
  emit: number;
  /** Sim tick the tile becomes dangerous. */
  danger: number;
  /** Which diagonal arm's batch sent it: 'L' is y-x, 'R' is x+y. */
  arm: 'L' | 'R';
  x: number;
  y: number;
}

interface Capture {
  /** Packet tick phase 3 handed control back; every sim tick below is relative to it. */
  controlTick: number;
  bossHpAtP3: number;
  bossMaxHp: number;
  /** Sim ticks carrying a `vfx_npc_yama_magic_*` cast. */
  castTicks: number[];
  /** Each phase-3 cast with the style it used, in order. */
  castStyles: Array<{ tick: number; style: 'magic' | 'range' }>;
  /** Sim ticks Yama's own block carries an `npc_yama01_melee01` swing. */
  meleeTicks: number[];
  wallTiles: WallTile[];
  /** Sim tick -> how many flares were added on it. */
  flareSpawns: Map<number, number>;
  /** Every phase-3 spawn event in order: the sim tick, and the corners it filled. */
  flareSpawnOrder: Array<{ tick: number; positions: Coordinate[] }>;
  /** Flares the player killed, with the total damage that did it. */
  flareKills: Array<{ spawn: number; spawnedTogether: number; totalDamage: number }>;
  /**
   * Yama's auto-attacks as they LANDED on the player (cast + 3), tagged with how long
   * since the last protection click. Restricted to autos on purpose: ground hazards
   * (waves, the shadow crash) are typeless and were never covered by a prayer, so
   * including them reads as protection failing when it did not.
   */
  autoAttackLandings: Array<{
    tick: number;
    sinceProtectionClick: number | null;
    damage: number;
    style: 'magic' | 'range';
    /**
     * Whether the overhead matching this auto's style was up ON THE LANDING TICK. Reading it
     * at either end instead lets a flick that was already off cover the hit, which is what
     * puts the sensory capture's 19 and base's 10 in the prayed set and makes any penetration
     * rate fitted from them read several times too high.
     */
    protectedByOverhead: boolean;
    /** Yama's health on the CAST tick — the bonus is read at launch, not at impact. */
    bossHpAtLaunch: number;
  }>;
  /** Ticks from each protection prayer's `0->1` to its `1->0`. */
  prayerVarbitSpans: number[];
  /** Sim tick -> Yama's SW corner at the END of that tick, for every tick he was reported. */
  yamaPositions: Map<number, Coordinate>;
  /** Sim tick -> the player's tile at the END of that tick. */
  playerPositions: Map<number, Coordinate>;
  /** Sim ticks the player fired the scorching bow's special on. */
  scorchingSpecTicks: number[];
  /** `sa_energy` (varp 300) transitions, in raw tenths of a percent. */
  specEnergy: Array<{ tick: number; from: number; to: number }>;
  /** `arceuus_death_charge_active` (varbit 12411) transitions — the value is procs remaining. */
  deathChargeActive: Array<{ tick: number; from: number; to: number }>;
  /** `arceuus_death_charge_cooldown` (varbit 12138) transitions. */
  deathChargeCooldown: Array<{ tick: number; from: number; to: number }>;
}

const cache = new Map<string, Capture>();

function loadCapture(name: string): Capture {
  const cached = cache.get(name);
  if (cached) return cached;
  const captured = YAMA_P3_CAPTURES[name];
  if (!captured) throw new Error(`${name}: no extracted phase-3 capture`);
  const capture: Capture = {
    ...captured,
    castTicks: [...captured.castTicks],
    castStyles: [...captured.castStyles],
    meleeTicks: [...captured.meleeTicks],
    wallTiles: captured.wallBatches.flatMap(([emit, danger, arm, tiles]) =>
      Array.from({ length: tiles.length / 2 }, (_, i) => ({
        emit,
        danger,
        arm,
        x: tiles[2 * i]!,
        y: tiles[2 * i + 1]!,
      })),
    ),
    flareSpawns: new Map(captured.flareSpawns),
    flareSpawnOrder: captured.flareSpawnOrder.map(({ tick, positions }) => ({
      tick,
      positions: positions.map(([x, y]) => [x, y] as Coordinate),
    })),
    flareKills: [...captured.flareKills],
    autoAttackLandings: [...captured.autoAttackLandings],
    prayerVarbitSpans: [...captured.prayerVarbitSpans],
    yamaPositions: new Map(captured.yamaPositions.map(([tick, [x, y]]) => [tick, [x, y] as Coordinate])),
    playerPositions: new Map(captured.playerPositions.map(([tick, [x, y]]) => [tick, [x, y] as Coordinate])),
    scorchingSpecTicks: [...captured.scorchingSpecTicks],
    specEnergy: [...captured.specEnergy],
    deathChargeActive: [...captured.deathChargeActive],
    deathChargeCooldown: [...captured.deathChargeCooldown],
  };
  cache.set(name, capture);
  return capture;
}

/** Both arms of one X are emitted within a tick of each other; group them back together. */
function groupIntoWaves(tiles: WallTile[]): Map<number, WallTile[]> {
  const byEmit = new Map<number, WallTile[]>();
  for (const tile of tiles) byEmit.set(tile.emit, [...(byEmit.get(tile.emit) ?? []), tile]);

  const waves = new Map<number, WallTile[]>();
  for (const emit of [...byEmit.keys()].sort((a, b) => a - b)) {
    const partner = [...waves.keys()].find((k) => emit - k <= 1);
    const key = partner ?? emit;
    waves.set(key, [...(waves.get(key) ?? []), ...(byEmit.get(emit) ?? [])]);
  }
  return waves;
}

/**
 * Cycle boundaries WITHOUT reference to the model's period: members of one group land
 * within ~23 ticks of its base, and the next group is a full period away.
 */
function splitIntoCycles(capture: Capture): Array<{ base: number; members: number[] }> {
  const emissions = [...groupIntoWaves(capture.wallTiles).keys()].sort((a, b) => a - b);
  const cycles: Array<{ base: number; members: number[] }> = [];
  for (const emit of emissions) {
    const current = cycles[cycles.length - 1];
    if (current && emit - current.base <= 30) current.members.push(emit - current.base);
    else cycles.push({ base: emit, members: [0] });
  }
  return cycles;
}

/**
 * One captured X: the two arm batches, and how late each was sent against the delta the
 * model schedules it on. That lateness IS the sigil contracts' random offset — see
 * `waves.ts`. Measuring it against the SIBLING arm instead loses the both-arms-late case,
 * which then reads as no offset at all.
 */
interface CapturedWave {
  /** Sim tick the earlier of the two arms was emitted on. */
  group: number;
  /**
   * Which entry of the config's `deltas` this X is. Slot 0 is the delta-0 member, which is
   * NOT always the first wave of its cycle: base cycle 0 fires only delta 14 and so has no
   * slot-0 member at all.
   */
  slot: number;
  arms: Array<{ arm: 'L' | 'R'; emit: number; late: number; tiles: WallTile[] }>;
}

function capturedWaves(capture: Capture, name: string): CapturedWave[] {
  const { periodTicks, deltas } = resolveEncounterConfig(CONFIG_FOR_CAPTURE[name].encounter).waves;
  return [...groupIntoWaves(capture.wallTiles)].map(([group, wave]) => {
    const cycleBase = WAVE_EMIT_TICK + periodTicks * Math.floor((group - WAVE_EMIT_TICK) / periodTicks);
    const slot = deltas.reduce(
      (best, d, i) => (Math.abs(group - cycleBase - d) < Math.abs(group - cycleBase - deltas[best]) ? i : best),
      0,
    );
    const scheduled = cycleBase + deltas[slot];
    const arms: CapturedWave['arms'] = [];
    for (const side of ['L', 'R'] as const) {
      const tiles = wave.filter((t) => t.arm === side);
      if (tiles.length === 0) continue;
      const emit = Math.min(...tiles.map((t) => t.emit));
      arms.push({ arm: side, emit, late: emit - scheduled, tiles });
    }
    return { group, slot, arms };
  });
}

/**
 * One un-staggered, un-offset wave — the shape every captured wave is a translate of.
 * Period, speed and start delay come from the SHIPPED config, so changing any of them
 * breaks this suite rather than silently drifting away from the captures.
 */
function singleWaveConfig(config: YamaContractConfig) {
  const { periodTicks, speedTilesPerTick, startDelay } = resolveEncounterConfig(config.encounter).waves;
  return { periodTicks, speedTilesPerTick, startDelay, deltas: [0], firstCycleDeltas: [0], randomOffsets: false };
}

/** Sim tick every capture puts its first wave group on — a packet fact, not a model constant. */
const WAVE_EMIT_TICK = 12;

const CONFIG_FOR_CAPTURE: Record<string, YamaContractConfig> = {
  [BASE_CAPTURE]: BASE_YAMA_CONFIG,
  [DIVINE_CAPTURE]: DIVINE_SEVERANCE_CONFIG,
  [DIVINE_CAPTURE_2]: DIVINE_SEVERANCE_CONFIG,
  [FORFEIT_CAPTURE]: FORFEIT_BREATH_CONFIG,
  [GLYPHIC_CAPTURE]: GLYPHIC_ATTENUATION_CONFIG,
  [GLYPHIC_CAPTURE_2]: GLYPHIC_ATTENUATION_CONFIG,
  [BLOODIED_CAPTURE]: BLOODIED_BLOWS_CONFIG,
  [SENSORY_CAPTURE]: SENSORY_CLOUDING_CONFIG,
  [SENSORY_CAPTURE_2]: SENSORY_CLOUDING_CONFIG,
};

/** Free passes = captured tiles the model would let the player stand on. */
function freePasses(wave: WallTile[], emit: number, config: ReturnType<typeof singleWaveConfig>): number {
  let free = 0;
  for (const tile of wave) {
    const modelTick = tile.danger - (emit - WAVE_EMIT_TICK);
    if (!isWaveTile(tile.x, tile.y, modelTick, config)) free++;
  }
  return free;
}

const PLAYER_POS: Coordinate = [31, 37];

/** Orthogonally adjacent to Yama's 5x5 footprint from `YAMA_START_POS`, so he swings his axe. */
const MELEE_RANGE_POS: Coordinate = [34, 30];

function runEncounter(config: YamaContractConfig, ticks: number, playerPos: Coordinate = PLAYER_POS) {
  const engine = new SimulationEngine({ encounter: new YamaEncounter(config), startPos: playerPos });
  engine.setMechanicsConfig({
    yamaMageRange: true,
    waves: false,
    fireballs: false,
    voidFlares: true,
    infiniteHealth: true,
    // Same job as infiniteHealth: the run has to survive the three cycles these assertions
    // count flares over. Forfeit Breath ends it at 0 run energy, and its passive drain gets
    // there well inside that window, which left the sim with no spawns to check at all.
    infiniteStamina: true,
  });
  const world = Reflect.get(engine, 'worldState') as WorldState;

  const seen = new Set<string>();
  const spawns = new Map<number, number[]>();
  const positions = new Map<number, Coordinate[]>();
  const fuses: number[] = [];
  for (let i = 0; i < ticks; i++) {
    engine.advanceTick(playerPos);
    for (const npc of world.getNpcs()) {
      if (npc.npcTypeId !== VOID_FLARE_NPC_ID || seen.has(npc.id)) continue;
      seen.add(npc.id);
      const spawn = npc.spawnTick ?? world.tick;
      spawns.set(spawn, [...(spawns.get(spawn) ?? []), npc.vitals.hp]);
      positions.set(spawn, [...(positions.get(spawn) ?? []), [...npc.position] as Coordinate]);
      if (npc.despawnTick !== undefined) fuses.push(npc.despawnTick - spawn);
    }
  }
  return { spawns, positions, fuses };
}

describe('capture conformance: phase-3 anchor', () => {
  it.each(ALL_CAPTURES)("%s exposes a phase-3 control tick and the contract's own health bar", (name) => {
    const capture = loadCapture(name);
    expect(capture.controlTick).toBeGreaterThan(0);
    expect(capture.bossMaxHp).toBe(resolveEncounterConfig(CONFIG_FOR_CAPTURE[name].encounter).boss.maxHp);
  });

  it.each([
    [BASE_CAPTURE, BASE_YAMA_CONFIG, YAMA_P3_START_HP],
    [DIVINE_CAPTURE, DIVINE_SEVERANCE_CONFIG, YAMA_CONTRACT_P3_START_HP],
    [DIVINE_CAPTURE_2, DIVINE_SEVERANCE_CONFIG, YAMA_CONTRACT_P3_START_HP],
    [FORFEIT_CAPTURE, FORFEIT_BREATH_CONFIG, YAMA_CONTRACT_P3_START_HP],
    [GLYPHIC_CAPTURE, GLYPHIC_ATTENUATION_CONFIG, GLYPHIC_ATTENUATION_P3_START_HP],
    [GLYPHIC_CAPTURE_2, GLYPHIC_ATTENUATION_CONFIG, GLYPHIC_ATTENUATION_P3_START_HP],
    [BLOODIED_CAPTURE, BLOODIED_BLOWS_CONFIG, BLOODIED_BLOWS_P3_START_HP],
    [SENSORY_CAPTURE, SENSORY_CLOUDING_CONFIG, YAMA_CONTRACT_P3_START_HP],
  ] as const)('%s opens phase 3 within a few hitpoints of the modeled threshold', (name, config, threshold) => {
    const capture = loadCapture(name);
    const resolved = resolveEncounterConfig(config.encounter);

    expect(resolved.boss.hp).toBe(threshold);
    expect(resolved.boss.maxHp).toBe(capture.bossMaxHp);
    // Damage keeps landing through the resistance window before the teleport, so a capture
    // usually opens just BELOW the threshold — bloodied blows opens 73 under its 1500. The
    // sensory capture opens four ABOVE it (1254 of 2500), and its transition fires on the hit
    // that leaves Yama at 1254, so the real trigger is not exactly 50% and the modeled
    // threshold is a round stand-in for it rather than a bound in either direction. Hence a
    // two-sided allowance, scaled to the pool because the overshoot is a couple of player hits.
    // What the captures DO exclude is the wrong half of the bar.
    expect(Math.abs(capture.bossHpAtP3 - threshold)).toBeLessThan(capture.bossMaxHp / 30);
  });
});

describe('capture conformance: shadow waves', () => {
  it.each(ALL_CAPTURES)('%s — every captured wall tile is dangerous in the model (0 free passes)', (name) => {
    const capture = loadCapture(name);
    // Scored at NO origin shift, against each arm's OWN emission tick. That is the whole
    // offset claim in one assertion: a jittered arm is the un-jittered batch sent a tick
    // later, so re-anchoring it to its own tick must recover the un-jittered shape exactly.
    // Taking the minimum over three origin shifts instead would make this pass for any
    // offset model at all, wrong ones included.
    const waveConfig = singleWaveConfig(CONFIG_FOR_CAPTURE[name]);
    const waves = capturedWaves(capture, name);
    expect(waves.length).toBeGreaterThan(0);

    let tilesChecked = 0;
    for (const { group, arms } of waves) {
      for (const { arm, emit, tiles } of arms) {
        expect(freePasses(tiles, emit, waveConfig), `${arm} arm of the X at sim tick ${group} in ${name}`).toBe(0);
        tilesChecked += tiles.length;
      }
    }
    expect(tilesChecked).toBeGreaterThan(1000);
  });

  it.each(ALL_CAPTURES)('%s — the delta-0 wave leading each cycle is never jittered', (name) => {
    const leaders = capturedWaves(loadCapture(name), name).filter((w) => w.slot === 0);
    expect(leaders.length).toBeGreaterThan(0);

    for (const leader of leaders) {
      expect(leader.arms.length, `X at sim tick ${leader.group} in ${name}`).toBe(2);
      // Both arms on the cycle base, every cycle, in every capture — which is why
      // `getWaveSetOffset` returns no offset for delta 0.
      expect(
        leader.arms.map((a) => a.late),
        `X at sim tick ${leader.group} in ${name}`,
      ).toEqual([0, 0]);
    }
  });

  it('the sigil captures use all FOUR jitter combinations, and base Yama none', () => {
    const seen = new Set<string>();
    for (const name of [...SIGIL_CAPTURES, ...GLYPHIC_CAPTURES]) {
      for (const wave of capturedWaves(loadCapture(name), name)) {
        if (wave.slot === 0 || wave.arms.length < 2) continue;
        seen.add(wave.arms.map((a) => `${a.arm}${a.late}`).join(''));
      }
    }
    // A three-variant table cannot produce 'L1R1'; the captures hold 10 of them.
    expect([...seen].sort()).toEqual(['L0R0', 'L0R1', 'L1R0', 'L1R1']);

    for (const wave of capturedWaves(loadCapture(BASE_CAPTURE), BASE_CAPTURE)) {
      expect(
        wave.arms.map((a) => a.late),
        `X at sim tick ${wave.group} in ${BASE_CAPTURE}`,
      ).toEqual([0, 0]);
    }
  });

  it('the model is not dangerous everywhere, which a containment check alone would accept', () => {
    const config = singleWaveConfig(BASE_YAMA_CONFIG);
    const arena = { minX: 17, maxX: 44, minY: 0, maxY: 45 };
    const area = (arena.maxX - arena.minX + 1) * (arena.maxY - arena.minY + 1);

    for (const tick of [16, 20, 24, 28]) {
      const dangerous = getWaveTiles(tick, arena.minX, arena.maxX, arena.minY, arena.maxY, config).length;
      expect(dangerous).toBeGreaterThan(0);
      // The wave is two clipped diagonals; anything approaching the whole floor means the
      // geometry has collapsed and every "0 free passes" result above is meaningless.
      expect(dangerous, `dangerous tiles at sim tick ${tick}`).toBeLessThan(area / 4);
    }
  });

  it.each(ALL_CAPTURES)('%s — wave groups recur on exactly the modeled period', (name) => {
    const capture = loadCapture(name);
    const { periodTicks, deltas, firstCycleDeltas } = resolveEncounterConfig(CONFIG_FOR_CAPTURE[name].encounter).waves;
    const cycles = splitIntoCycles(capture);
    expect(cycles.length).toBeGreaterThan(1);

    // Boundaries are clustered out of the capture, never divided through the model's own
    // period, or the assertion would hold for any period at all. Base P3 opens on its
    // lone delta-14 wave, so cycle 0 starts later than every cycle after it.
    for (const [i, cycle] of cycles.entries()) {
      const earliest = Math.min(...(i === 0 ? firstCycleDeltas : deltas));
      expect(cycle.base, `cycle ${i} of ${name}`).toBe(WAVE_EMIT_TICK + periodTicks * i + earliest);
    }
  });

  it.each(ALL_CAPTURES)('%s — each cycle fires the modeled number of staggered waves', (name) => {
    const capture = loadCapture(name);
    const { deltas, firstCycleDeltas } = resolveEncounterConfig(CONFIG_FOR_CAPTURE[name].encounter).waves;
    const cycles = splitIntoCycles(capture);

    // The final cycle can be truncated by the end of the capture.
    for (const [index, cycle] of cycles.slice(0, -1).entries()) {
      const expected = [...(index === 0 ? firstCycleDeltas : deltas)].sort((a, b) => a - b);
      expect(cycle.members.length, `cycle ${index} of ${name}`).toBe(expected.length);
      for (const [i, member] of cycle.members.entries()) {
        // The captured stagger jitters by a tick; the model picks the low end of each.
        const drift = Math.abs(member - (expected[i] - expected[0]));
        expect(drift, `cycle ${index} member ${i} of ${name}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('capture conformance: attack cadence', () => {
  it.each(SIGIL_CAPTURES)('%s — the model fires an auto on exactly the captured beats', (name) => {
    const capture = loadCapture(name);
    const pattern = resolveEncounterConfig(DIVINE_SEVERANCE_CONFIG.encounter).attackPattern;
    const casts = new Set(capture.castTicks);
    const first = Math.min(...capture.castTicks);
    const last = Math.max(...capture.castTicks);

    // A beat schedules the swing that ANIMATES one tick later, so the model's beat k
    // owns the cast the capture prints at `beatStartTick + 1 + interval * k`.
    let autos = 0;
    let specials = 0;
    for (let beat = 0; ; beat++) {
      const beatTick = pattern.beatStartTick + pattern.beatIntervalTicks * beat;
      const castTick = beatTick + 1;
      if (castTick > last) break;
      if (castTick < first) continue;

      const info = getYamaBeatInfo(beatTick, pattern);
      expect(info.isBeat, `sim tick ${beatTick} should be a beat`).toBe(true);
      // A snap beat is Yama winding up a special; the attack policy returns `idle`, so
      // no cast is sent — which is exactly the hole the capture shows.
      const modelCasts = info.fireballBeatKind !== 'snap';
      expect(modelCasts, `cast at sim tick ${castTick} in ${name}`).toBe(casts.has(castTick));
      if (modelCasts) autos++;
      else specials++;
    }

    // The bloodied blows capture is the shortest phase 3 in the set, at 156 ticks.
    expect(autos).toBeGreaterThan(15);
    expect(specials).toBeGreaterThanOrEqual(4);
    // Nothing in the capture may fall off the model's grid either.
    for (const cast of capture.castTicks) {
      expect((cast - 1 - pattern.beatStartTick) % pattern.beatIntervalTicks, `cast ${cast} off-grid`).toBe(0);
    }
  });

  /**
   * Base Yama snaps on beat 3 only in the first cycle and casts alongside that fireball from the
   * second on. Melee swings replace the cast on any beat, so a beat Yama swung on is skipped: the
   * capture cannot say what he would have cast there.
   */
  it.each(BASE_CAPTURES)('%s — base snaps only where the model does, beat 3 in cycle 0 only', (name) => {
    const capture = loadCapture(name);
    const pattern = resolveEncounterConfig(BASE_YAMA_CONFIG.encounter).attackPattern;
    const casts = new Set(capture.castTicks);
    const swings = new Set(capture.meleeTicks);
    const last = Math.max(...capture.castTicks);

    let autos = 0;
    let firstCycleBeat3Snaps = 0;
    let laterBeat3Casts = 0;
    for (let beat = 0; ; beat++) {
      const beatTick = pattern.beatStartTick + pattern.beatIntervalTicks * beat;
      const castTick = beatTick + 1;
      if (castTick > last) break;
      if (swings.has(castTick)) continue;

      const info = getYamaBeatInfo(beatTick, pattern);
      const modelCasts = info.fireballBeatKind !== 'snap';
      expect(modelCasts, `cast at sim tick ${castTick} (beat ${info.beatIndex}) in ${name}`).toBe(casts.has(castTick));
      if (modelCasts) autos++;
      if (info.beatIndex !== 3) continue;
      if (info.globalBeatOrdinal < pattern.beatsPerCycle) firstCycleBeat3Snaps += Number(!casts.has(castTick));
      else laterBeat3Casts += Number(casts.has(castTick));
    }

    expect(autos).toBeGreaterThan(15);
    expect(firstCycleBeat3Snaps).toBe(1);
    expect(laterBeat3Casts).toBeGreaterThanOrEqual(1);
  });

  it.each([...SIGIL_CAPTURES, ...GLYPHIC_CAPTURES])('%s — casts run every 7 ticks from sim tick 12', (name) => {
    const capture = loadCapture(name);
    const pattern = resolveEncounterConfig(DIVINE_SEVERANCE_CONFIG.encounter).attackPattern;

    expect(Math.min(...capture.castTicks)).toBe(pattern.beatStartTick + pattern.beatIntervalTicks + 1);
    const gaps = new Set(capture.castTicks.slice(1).map((t, i) => t - capture.castTicks[i]));
    for (const gap of gaps) {
      expect(gap % pattern.beatIntervalTicks).toBe(0);
    }
  });

  it.each(GLYPHIC_CAPTURES)('%s — every beat the model snaps on is silent in the capture', (name) => {
    const capture = loadCapture(name);
    const pattern = resolveEncounterConfig(GLYPHIC_ATTENUATION_CONFIG.encounter).attackPattern;
    const casts = new Set(capture.castTicks);
    const last = Math.max(...capture.castTicks);

    // One direction only. Glyphic forces the player into melee range, so Yama occasionally
    // swings instead of casting and leaves a hole on an ordinary beat too — the capture
    // cannot tell that apart from a special. What it CAN prove is that no snap beat ever
    // carries an auto, which is what the fireball timing hangs off.
    let snaps = 0;
    for (let beat = 0; ; beat++) {
      const beatTick = pattern.beatStartTick + pattern.beatIntervalTicks * beat;
      if (beatTick + 1 > last) break;
      if (getYamaBeatInfo(beatTick, pattern).fireballBeatKind !== 'snap') continue;
      snaps++;
      expect(casts.has(beatTick + 1), `snap beat at sim tick ${beatTick} in ${name} cast anyway`).toBe(false);
    }
    expect(snaps).toBeGreaterThan(1);
  });

  /**
   * The alternation between Yama's two ranged styles advances once per CAST, never per beat.
   * A beat carrying a special leaves the parity untouched, and so does a MELEE swing — which is
   * why the two captures whose player stood in melee range still read as a clean alternation
   * across their extra holes. Yama's actor state gets this right by incrementing
   * `alternatingAttackCount` only when it actually queues a ranged/magic attack.
   *
   * WHICH style opens the phase is not fixed — it is either one — so this is anchored to each
   * capture's own first cast. All eight happen to open on shadow; that is coincidence, not a
   * rule, and pinning a constant to it would be wrong.
   */
  it.each(ALL_CAPTURES)('%s — casts strictly alternate, once per cast', (name) => {
    const capture = loadCapture(name);
    expect(capture.castStyles.length).toBeGreaterThan(10);

    const opener = capture.castStyles[0].style;
    const opposite = opener === 'range' ? 'magic' : 'range';
    for (const [ordinal, { tick, style }] of capture.castStyles.entries()) {
      expect(style, `cast ${ordinal} at sim tick ${tick} in ${name}`).toBe(ordinal % 2 === 0 ? opener : opposite);
    }
  });

  it('the engine alternates the same way, from whichever style it opens on', () => {
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(BLOODIED_BLOWS_CONFIG),
      startPos: PLAYER_POS,
    });
    engine.setMechanicsConfig({
      yamaMageRange: true,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });

    const styles: string[] = [];
    let seen = 0;
    for (let i = 0; i < 160; i++) {
      engine.advanceTick(PLAYER_POS);
      const history = engine.getState().damageHistory.filter((h) => h.source === 'YamaAttack');
      for (const hit of history.slice(seen)) styles.push(hit.attackType);
      seen = history.length;
    }

    expect(styles.length).toBeGreaterThan(10);
    const opener = styles[0];
    const opposite = opener === 'range' ? 'magic' : 'range';
    expect(['range', 'magic']).toContain(opener);
    for (const [ordinal, style] of styles.entries()) {
      expect(style, `engine cast ${ordinal}`).toBe(ordinal % 2 === 0 ? opener : opposite);
    }
  });
});

describe('capture conformance: protection prayers', () => {
  /**
   * Divine Severance's prayer timer, bounded from BOTH sides by the capture so neither
   * half can drift with the config it is meant to pin.
   *
   * The lower bound is damage: a click one tick before a landing still blocks it, so the
   * window cannot be one tick. The upper bound is the varbit: the `1->0` always arrives at
   * click+1, so the prayer cannot still be up at click+2. Note the two disagree by design —
   * the varbit reports the deactivation on a tick the prayer is STILL protecting, which is
   * why reading the timer off varbit spans alone gives half the real window.
   */
  const DIVINE_CAPTURES = [DIVINE_CAPTURE, DIVINE_CAPTURE_2] as const;

  /**
   * How many ticks the engine actually PROTECTS for, measured by clicking further and
   * further ahead of a real landing and watching when damage starts getting through —
   * the same measurement made against the captures. Reading `activePrayer` back instead
   * would answer a different question: the prayer goes dark on its final protected tick,
   * exactly as the client shows it.
   */
  function engineProtectionWindow(): number {
    const run = (
      clickTick: number | null,
      prayer: PrayerType,
      encounterSeed: number,
    ): { landing: number; damage: number; connected: boolean } => {
      const engine = new SimulationEngine({
        encounter: new YamaEncounter(DIVINE_SEVERANCE_CONFIG, encounterSeed),
        startPos: PLAYER_POS,
        combatSeed: 0,
      });
      engine.setMechanicsConfig({
        yamaMageRange: true,
        waves: false,
        fireballs: false,
        voidFlares: false,
        infiniteHealth: true,
      });
      for (let tick = 1; tick <= 24; tick++) {
        if (clickTick === tick) engine.queueProtectionPrayer(prayer);
        engine.advanceTick(PLAYER_POS);
      }
      const hits = engine.getState().damageHistory.filter((h) => h.source === 'YamaAttack');
      // `baseDamage` is the roll BEFORE the overhead, so it separates the two ways a splat
      // reads 0: Yama's accuracy roll failing (0 here too) and the prayer blocking a real hit.
      // Counting a miss as a block walks this probe straight past the window it is measuring.
      return { landing: hits[0].tick, damage: hits[0].effectiveDamage, connected: hits[0].baseDamage > 0 };
    };

    // Yama's accuracy comes off the encounter's own seed, and a swing that misses says nothing
    // about the prayer window — so measure on a seed whose first swing lands. The prayer clicks
    // do not consume that stream, which is what makes one seed valid for every variant below.
    const seed = [...Array(64).keys()].find((s) => run(null, PrayerType.ProtectRange, s).connected);
    if (seed === undefined) throw new Error('no seed in 0..63 lands Yama\u2019s first phase-3 swing');

    // Try both overheads and keep the better one, so the answer is the window rather than
    // whether this particular swing happened to be the ranged or the magic one.
    const bestDamage = (clickTick: number): number =>
      Math.min(...[PrayerType.ProtectRange, PrayerType.ProtectMagic].map((p) => run(clickTick, p, seed).damage));

    const { landing } = run(null, PrayerType.ProtectRange, seed);
    let window = 0;
    while (window < 6 && bestDamage(landing - window) === 0) window++;
    return window;
  }

  it('a click one tick before a landing still blocks it, so the window is at least two ticks', () => {
    const landings = DIVINE_CAPTURES.flatMap((name) => loadCapture(name).autoAttackLandings);
    // A couple of 1s survive where a wave tile burned on the same tick as a landing; Yama's
    // contract max hit is 53, so mid-single-digits or above is prayer genuinely failing.
    const blockedAt = (offset: number) =>
      landings.filter((h) => h.sinceProtectionClick === offset && h.damage <= 5).length;
    const leakedAt = (offset: number) =>
      landings.filter((h) => h.sinceProtectionClick === offset && h.damage > 5).length;

    expect(blockedAt(1)).toBeGreaterThan(5);
    expect(leakedAt(1)).toBe(0);
    expect(engineProtectionWindow()).toBeGreaterThan(1);
  });

  it('the varbit reports the prayer off at click+1, so the window is at most two ticks', () => {
    for (const name of DIVINE_CAPTURES) {
      const spans = loadCapture(name).prayerVarbitSpans.filter((span) => span > 0);
      expect(spans.length).toBeGreaterThan(20);
      expect(new Set(spans), `varbit spans in ${name}`).toEqual(new Set([1]));
    }
    const lastProtectedOffset = Math.max(...loadCapture(DIVINE_CAPTURE).prayerVarbitSpans);
    expect(engineProtectionWindow()).toBeLessThanOrEqual(lastProtectedOffset + 1);
  });

  it('an auto-attack outside the window hits for real', () => {
    const window = engineProtectionWindow();
    const unprotected = DIVINE_CAPTURES.flatMap((name) =>
      loadCapture(name).autoAttackLandings.filter(
        (h) => h.sinceProtectionClick === null || h.sinceProtectionClick >= window,
      ),
    );
    expect(unprotected.length).toBeGreaterThan(0);
    // Unprotected landings can still read 0 — Yama misses like any npc — so the claim is
    // only that real damage gets through out here, and never inside the window.
    expect(Math.max(...unprotected.map((h) => h.damage))).toBeGreaterThan(20);
  });
});

describe('capture conformance: prayer penetration and Wretched Strength', () => {
  /** Every damage the model can put through a correct overhead at this boss health. */
  const modelledLeaks = (config: YamaContractConfig, bossHpAtLaunch: number, wretched = true): Set<number> => {
    const { autoAttacks, boss } = resolveEncounterConfig(config.encounter);
    const [, maxHit] = autoAttacks.rangedMagicDamage;
    const bonus = wretched && autoAttacks.wretchedStrength ? wretchedDamageBonusPercent(bossHpAtLaunch, boss.maxHp) : 0;
    const leaks = new Set<number>();
    for (let roll = 0; roll <= maxHit; roll++) {
      const boosted = roll + Math.floor((roll * bonus) / 100);
      leaks.add(
        calculatePrayerDamage(boosted, 'range', PrayerType.ProtectRange, autoAttacks.rangedMagicPrayerReduction),
      );
    }
    return leaks;
  };

  const prayedPhase3Landings = (name: string) => {
    const capture = loadCapture(name);
    return capture.autoAttackLandings.filter(
      (landing) => landing.protectedByOverhead && landing.tick - AUTO_ATTACK_FLIGHT_TICKS >= capture.controlTick,
    );
  };

  // The counts are pinned, not bounded: a parser or filter regression that silently drops most
  // of a capture's landings leaves every membership assertion below trivially true.
  it.each([
    [BASE_CAPTURE, BASE_YAMA_CONFIG, 17],
    [FORFEIT_CAPTURE, FORFEIT_BREATH_CONFIG, 29],
    [GLYPHIC_CAPTURE_2, GLYPHIC_ATTENUATION_CONFIG, 47],
    [SENSORY_CAPTURE, SENSORY_CLOUDING_CONFIG, 24],
    [SENSORY_CAPTURE_2, SENSORY_CLOUDING_CONFIG, 14],
    [BLOODIED_CAPTURE, BLOODIED_BLOWS_CONFIG, 17],
  ] as const)('%s — the model can roll every prayed phase-3 leak the capture recorded', (name, config, expected) => {
    const landings = prayedPhase3Landings(name);
    expect(landings.length).toBe(expected);
    for (const landing of landings) {
      expect([...modelledLeaks(config, landing.bossHpAtLaunch)], `packet tick ${landing.tick}`).toContain(
        landing.damage,
      );
    }
  });

  // Every rate is pinned by `floor(maxHit * rate)` landing exactly on its capture's largest
  // observed leak. That is what makes the rates re-derivable rather than free: one percent either
  // way moves the ceiling off the observation.
  it.each([
    [GLYPHIC_CAPTURE_2, GLYPHIC_ATTENUATION_CONFIG],
    [SENSORY_CAPTURE, SENSORY_CLOUDING_CONFIG],
    [FORFEIT_CAPTURE, FORFEIT_BREATH_CONFIG],
  ] as const)('%s pins its rate through the direct-floor ceiling', (name, config) => {
    const largest = Math.max(...prayedPhase3Landings(name).map((landing) => landing.damage));
    const { autoAttacks } = resolveEncounterConfig(config.encounter);
    const [, maxHit] = autoAttacks.rangedMagicDamage;
    const rate = autoAttacks.rangedMagicPrayerReduction.value ?? 0;

    // The ceiling IS the floored product — not one above it, which is what the subtract-blocked
    // arithmetic this replaced produced.
    expect(Math.max(...modelledLeaks(config, 0))).toBe(Math.floor(maxHit * rate));
    // Forfeit never rolled its ceiling (5 observed against a modeled 6), so it bounds only from
    // below; the other two reach theirs exactly.
    expect(Math.floor(maxHit * rate)).toBeGreaterThanOrEqual(largest);
  });

  // The only thing pinning sensory clouding's unpublished rate from ABOVE. The membership
  // test cannot: a rate set too high contains every observed value and stays green, which is
  // how 0.2 survived here while modeling leaks up to 12 against 28 positive landings that
  // stop at 9.
  it("the sensory captures' largest leak is the most sensory clouding can model", () => {
    const observed = [SENSORY_CAPTURE, SENSORY_CAPTURE_2].flatMap((name) =>
      prayedPhase3Landings(name).map((landing) => landing.damage),
    );

    expect(Math.max(...modelledLeaks(SENSORY_CLOUDING_CONFIG, 0))).toBe(Math.max(...observed));
  });

  it("bloodied's two lowest-health leaks are what pin Yama's damage bonus", () => {
    const landings = prayedPhase3Landings(BLOODIED_CAPTURE);
    const { boss } = resolveEncounterConfig(BLOODIED_BLOWS_CONFIG.encounter);
    const unexplained = landings.filter(
      (landing) => !modelledLeaks(BLOODIED_BLOWS_CONFIG, landing.bossHpAtLaunch, false).has(landing.damage),
    );

    expect(unexplained.map((landing) => landing.damage)).toEqual([5, 6]);
    for (const landing of unexplained) {
      expect(landing.bossHpAtLaunch / boss.maxHp).toBeLessThan(0.1);
    }
  });

  it("giving Yama the player's minimum-hit floor would contradict the capture's smallest leak", () => {
    const { autoAttacks, boss } = resolveEncounterConfig(BLOODIED_BLOWS_CONFIG.encounter);
    const [, maxHit] = autoAttacks.rangedMagicDamage;
    const smallest = prayedPhase3Landings(BLOODIED_CAPTURE)
      .filter((landing) => landing.damage > 0)
      .reduce((lowest, landing) => (landing.damage < lowest.damage ? landing : lowest));

    const flooredLeak = calculatePrayerDamage(
      wretchedMinimumHit(maxHit, smallest.bossHpAtLaunch, boss.maxHp),
      'range',
      PrayerType.ProtectRange,
      autoAttacks.rangedMagicPrayerReduction,
    );

    expect(flooredLeak).toBeGreaterThan(smallest.damage);
    expect([...modelledLeaks(BLOODIED_BLOWS_CONFIG, smallest.bossHpAtLaunch)]).toContain(smallest.damage);
  });
});

/**
 * `yama-normal-contract-203-magic-def-223-range-def-p3-packet-data.txt` — base Yama phase 3, and
 * the only capture that records the defensive bonuses it was taken at, which is what makes it the
 * one usable against an accuracy model. Augury up throughout, 99 Defence and 99 Magic, 88 clean
 * landings, none dropped as confounded.
 *
 * A capture measures a ZERO-SPLAT rate, never a miss rate: under the shipped `floor(roll * rate)`
 * penetration every roll below `100 / rate` also reads 0 through a correct overhead — 13 of the 47
 * rolls at base Yama's 8% — and an OSRS 0 is a block splat either way. Derivation and the
 * per-style counts: `docs/encounters/yama-facts-spec.md`.
 */
const KNOWN_GEAR_CAPTURE = { magicDefence: 203, rangedDefence: 223 } as const;

describe("capture conformance: Yama's autos roll accuracy", () => {
  /**
   * Two measurements that are NOT interchangeable. `missRate` is the accuracy roll itself, read
   * off `hit_applied.accurate`, which no capture can see. `prayedZeroSplatRate` is what a capture
   * records: of the landings a correct overhead covered, the share that read 0 — misses and
   * floored-away leaks together.
   *
   * Asserting unconditional accuracy against a zero-splat rate is the trap: it stays comfortably
   * non-zero with `accuracySucceeded` hardcoded back to `true`, so only `missRate` can detect
   * that regression, and only the zero-splat rate can be held against the captures.
   */
  const rollOutcomes = (
    magicDefence: number,
    rangedDefence: number,
    overhead?: PrayerType,
    offensive?: PrayerType,
    ticks = 700,
  ) => {
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(BASE_YAMA_CONFIG, 7),
      startPos: PLAYER_POS,
      combatSeed: 7,
    });
    engine.setMechanicsConfig({
      yamaMageRange: true,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    const world = Reflect.get(engine, 'worldState') as WorldState;
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    player.equipmentStats = { ...player.equipmentStats, defenceMagic: magicDefence, defenceRanged: rangedDefence };
    if (overhead) engine.queueProtectionPrayer(overhead);
    if (offensive) engine.queueBoostPrayer(offensive);

    let swings = 0;
    let misses = 0;
    for (let tick = 0; tick < ticks; tick++) {
      // Yama drains the book dry long before tick 700, and an overhead that lapses silently
      // reclassifies the rest of the run as unprayed rather than failing.
      player.prayerState.points = player.prayerState.maxPoints;
      engine.advanceTick(PLAYER_POS);
      for (const event of engine.getLastTickEvents()) {
        // Ground hazards emit `hit_applied` with no `accurate` field, so its presence is what
        // marks an attack that actually rolled to hit.
        if (!isCoreEvent(event, 'hit_applied') || event.targetId !== 'player') continue;
        if (event.accurate === undefined) continue;
        swings += 1;
        if (!event.accurate) misses += 1;
      }
    }

    const autos = engine.getState().damageHistory.filter((h) => h.source === 'YamaAttack');
    // One overhead covers only the style it names, exactly as the captures are classified.
    const prayed = autos.filter((h) => h.prayedCorrectly === true);
    expect(swings).toBeGreaterThan(40);
    expect(autos.length).toBe(swings);
    return {
      missRate: misses / swings,
      prayedLandings: prayed.length,
      prayedZeroSplatRate: prayed.filter((h) => h.effectiveDamage === 0).length / prayed.length,
    };
  };

  it('misses some swings and lands others, instead of connecting unconditionally', () => {
    const { missRate } = rollOutcomes(150, 150);
    expect(missRate).toBeGreaterThan(0);
    expect(missRate).toBeLessThan(1);
  });

  it("reads the player's defensive bonuses, so better gear is missed more often", () => {
    expect(rollOutcomes(0, 0).missRate).toBeLessThan(rollOutcomes(250, 250).missRate);
  });

  // The calibration check: nothing here was fitted, so this is the shipped accuracy formula and
  // the shipped monster stats agreeing with the packets on their own. A regression that silently
  // divorces the roll from the player's stats leaves the two tests above green and this one red.
  // Melee is Slash, so it reads slash defence — which a melee loadout stacks far higher than the
  // magic/ranged bonuses the other two styles read, so Yama misses MORE with melee, not less.
  // Exempting melee from the roll scores 13.2 log-likelihood units
  // worse against the long-P3 base capture, where 5 of 9 prayed melee landings read 0 and the
  // formula independently predicts 58% misses against that capture's melee preset.
  it('rolls melee accuracy too, and misses often against a high slash-defence loadout', () => {
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(BASE_YAMA_CONFIG, 7),
      startPos: MELEE_RANGE_POS,
      combatSeed: 7,
    });
    engine.setMechanicsConfig({
      yamaMelee: true,
      yamaMageRange: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    const world = Reflect.get(engine, 'worldState') as WorldState;
    const player = world.getPlayer();
    if (!player) throw new Error('no player');
    // The capture's melee preset carries slash defence 357; 250 is a conservative stand-in that
    // still puts the expected miss rate well clear of zero.
    player.equipmentStats = { ...player.equipmentStats, defenceSlash: 250, defenceStab: 250 };

    let swings = 0;
    let misses = 0;
    for (let tick = 0; tick < 400; tick++) {
      engine.advanceTick(MELEE_RANGE_POS);
      for (const event of engine.getLastTickEvents()) {
        if (!isCoreEvent(event, 'hit_applied') || event.targetId !== 'player') continue;
        if (event.accurate === undefined) continue;
        swings += 1;
        if (!event.accurate) misses += 1;
      }
    }
    expect(swings).toBeGreaterThan(20);
    expect(misses / swings).toBeGreaterThan(0.25);
  });

  // Attack, Magic and Ranged each feed their own style's roll; Strength and Defence feed nothing
  // Yama throws. All five move together on the wiki's table, so a partial sync would leave the
  // rest silently on base Yama's.
  it('gives contracted Yama his own combat levels', () => {
    const contracted = new YamaEncounter(SENSORY_CLOUDING_CONFIG).createNpcs(PLAYER_POS)[0];
    const base = new YamaEncounter(BASE_YAMA_CONFIG).createNpcs(PLAYER_POS)[0];

    expect(contracted.formulaStats?.levels).toMatchObject(CONTRACT_COMBAT_LEVELS);
    expect(base.formulaStats?.levels.attack).toBe(320);
    expect(contracted.formulaStats?.offensive).toEqual(base.formulaStats?.offensive);
  });

  // The calibration check, and the only one that can settle an accuracy question: it runs the
  // model at the ONE capture whose own defensive bonuses are recorded, rather than against the
  // pooled figure above, whose seven captures have unknown and varying gear. Holding the model
  // against that pooled figure tests whatever loadout you assumed the players wore — it was done
  // here once, read as the model over-producing zeros, and this capture refuted it.
  //
  // Measured THROUGH an overhead, because that is the only landing a capture can classify.
  // Reverting it to an unprayed `baseDamage === 0` rate holds the model's misses alone against a
  // figure that also contains every leak the 8% floored to nothing.
  it.each([
    // Wilson 95% intervals on the capture's own counts. One overhead classifies one style, so
    // each row is its own run.
    ['ranged (25/38 zeros)', PrayerType.ProtectRange, 0.4989, 0.7879],
    ['magic (23/43 zeros)', PrayerType.ProtectMagic, 0.3892, 0.6749],
  ] as const)('reproduces the 203/223 capture\u2019s prayed %s zero-splat rate', (_style, overhead, low, high) => {
    const { prayedZeroSplatRate, prayedLandings } = rollOutcomes(
      KNOWN_GEAR_CAPTURE.magicDefence,
      KNOWN_GEAR_CAPTURE.rangedDefence,
      overhead,
      PrayerType.Augury,
    );

    expect(prayedLandings).toBeGreaterThan(20);
    expect(prayedZeroSplatRate).toBeGreaterThanOrEqual(low);
    expect(prayedZeroSplatRate).toBeLessThanOrEqual(high);
  });
});

describe('capture conformance: void flares', () => {
  const lifecycles = YAMA_FLARE_LIFECYCLES;

  it('every captured flare activates its HP and fuse bars on add+3, and is never clicked before', () => {
    const activated = lifecycles.filter((flare) => flare.end > flare.add + VOID_FLARE_UNTARGETABLE_TICKS);
    expect(activated.length).toBeGreaterThan(300);
    for (const flare of activated) {
      const at = `${flare.capture} flare ${flare.index}`;
      expect(flare.hpBar, at).toBe(flare.add + VOID_FLARE_UNTARGETABLE_TICKS);
      expect(flare.fuseBar?.tick, at).toBe(flare.add + VOID_FLARE_UNTARGETABLE_TICKS);
      // A click on the activation tick reaches the server on the next one.
      if (flare.firstOp !== null) expect(flare.firstOp, at).toBeGreaterThan(flare.add + VOID_FLARE_UNTARGETABLE_TICKS);
    }
  });

  it('every captured detonation lands two ticks after its fuse bar fills, whatever the bar length', () => {
    const detonated = lifecycles.filter((flare) => flare.explode !== null);
    expect(detonated.length).toBeGreaterThan(30);
    for (const flare of detonated) {
      const barTicks = (flare.fuseBar?.endTime ?? Number.NaN) / CYCLES_PER_CLIENT_TICK;
      expect(flare.explode, `${flare.capture} flare ${flare.index}`).toBe(
        flare.add + VOID_FLARE_UNTARGETABLE_TICKS + barTicks + VOID_FLARE_FUSE_BAR_LEAD_TICKS,
      );
    }
  });

  it('the modeled fuse is the 600-cycle bar every phase-3 beat-pair flare carries', () => {
    // 630 is the phase-1/2 beat pair and 360 the phase-3 melee single (next test); Divine
    // Severance's drumbeat singles share the 600.
    const p3 = lifecycles.filter((flare) => flare.fuseBar?.endTime === 600 && flare.explode !== null);
    expect(p3.length).toBeGreaterThanOrEqual(20);
    for (const flare of p3) expect(flare.explode! - flare.add).toBe(VOID_FLARE_CHARGE_TICKS);
  });

  it('a phase-3 melee swing flare that detonates carries the 360-cycle bar and the modeled melee fuse', () => {
    // A melee flare is the lone flare added on one of Yama's `npc_yama01_melee01` ticks.
    let detonated = 0;
    for (const name of [...ALL_CAPTURES, BASE_LONG_CAPTURE, BASE_KNOWN_GEAR_CAPTURE]) {
      const { controlTick, meleeTicks } = loadCapture(name);
      const flares = lifecycles.filter((flare) => flare.capture === name);
      for (const tick of meleeTicks.map((t) => t + controlTick)) {
        const added = flares.filter((flare) => flare.add === tick);
        if (added.length !== 1 || added[0].explode === null) continue;
        const at = `${name} flare ${added[0].index}`;
        expect(added[0].fuseBar?.endTime, at).toBe(360);
        expect(added[0].explode - added[0].add, at).toBe(MELEE_VOID_FLARE_CHARGE_TICKS);
        detonated++;
      }
    }
    expect(detonated).toBe(3);
  });

  it('the sim gives every flare the captured fuse', () => {
    const { fuses } = runEncounter(DIVINE_SEVERANCE_CONFIG, 140);
    expect(fuses.length).toBeGreaterThan(5);
    for (const fuse of fuses) {
      expect(fuse).toBe(VOID_FLARE_CHARGE_TICKS);
    }
  });

  it.each([
    [BASE_CAPTURE, BASE_YAMA_CONFIG],
    [FORFEIT_CAPTURE, FORFEIT_BREATH_CONFIG],
    [GLYPHIC_CAPTURE_2, GLYPHIC_ATTENUATION_CONFIG],
    [BLOODIED_CAPTURE, BLOODIED_BLOWS_CONFIG],
  ] as const)('%s — flares die on the modeled 71 hitpoints', (name, config) => {
    const capture = loadCapture(name);
    const { hp } = resolveEncounterConfig(config.encounter).voidFlares;
    const inPhase3 = capture.flareKills.filter((k) => k.spawn >= 0);
    expect(inPhase3.length).toBeGreaterThan(2);
    for (const kill of inPhase3) {
      expect(kill.totalDamage, `flare spawned at sim tick ${kill.spawn}`).toBe(hp);
    }
  });

  it.each([
    DIVINE_CAPTURE,
    DIVINE_CAPTURE_2,
  ] as const)('%s — only the continuously-spawned flares carry the raised hitpoints', (name) => {
    const capture = loadCapture(name);
    const { hp, continuousHp } = resolveEncounterConfig(DIVINE_SEVERANCE_CONFIG.encounter).voidFlares;
    expect(continuousHp).toBeGreaterThan(hp);

    const inPhase3 = capture.flareKills.filter((k) => k.spawn >= 0);
    const lone = inPhase3.filter((k) => k.spawnedTogether === 1);
    const paired = inPhase3.filter((k) => k.spawnedTogether > 1);

    expect(lone.length).toBeGreaterThan(3);
    expect(paired.length).toBeGreaterThan(1);
    for (const kill of lone) {
      expect(kill.totalDamage, `lone flare spawned at sim tick ${kill.spawn}`).toBe(continuousHp);
    }
    for (const kill of paired) {
      expect(kill.totalDamage, `paired flare spawned at sim tick ${kill.spawn}`).toBe(hp);
    }
  });

  it.each([...SIGIL_CAPTURES, GLYPHIC_CAPTURE_2])('%s — every pair lands on a modeled void-flare beat', (name) => {
    const capture = loadCapture(name);
    const pattern = resolveEncounterConfig(CONFIG_FOR_CAPTURE[name].encounter).attackPattern;
    const pairTicks = pattern.voidFlareBeats.map(
      (beat) => pattern.beatStartTick + pattern.beatIntervalTicks * beat + 1,
    );
    const cycle = pattern.beatIntervalTicks * pattern.beatsPerCycle;
    const onABeat = (tick: number) => pairTicks.some((pairTick) => (tick - pairTick) % cycle === 0);

    const pairs = [...capture.flareSpawns].filter(([, n]) => n > 1).map(([t]) => t);
    expect(pairs.length).toBeGreaterThan(1);
    for (const tick of pairs) {
      expect(onABeat(tick), `pair at sim tick ${tick} in ${name}`).toBe(true);
    }
    // Bloodied blows' extra pair is only visible as a COUNT: every beat-3 pair sits a
    // half-cycle from a beat-8 one, so a model that dropped beat 3 would still put every
    // captured pair on a beat and pass the check above.
    expect(pairs.length, `pairs per cycle in ${name}`).toBeGreaterThanOrEqual(
      pattern.voidFlareBeats.length * Math.floor((Math.max(...pairs) - Math.min(...pairs)) / cycle),
    );

    // Pursuit off for the sim run. Yama's melee has spawned a flare of its own since the mechanic
    // was added, and under sensory clouding he closes and swings every beat — those flares are
    // correct, but they fill `maxActive` and leave no room for the beat pair, which is the only
    // thing this assertion is about. Every other contract keeps him on his spawn tile.
    const config = CONFIG_FOR_CAPTURE[name];
    const { spawns } = runEncounter({ ...config, encounter: { ...config.encounter, pursuit: false } }, cycle * 3);
    const simPairs = [...spawns].filter(([, hps]) => hps.length > 1).map(([t]) => t);
    expect(simPairs.length).toBeGreaterThanOrEqual(pattern.voidFlareBeats.length * 2);
    for (const tick of simPairs) {
      expect(onABeat(tick)).toBe(true);
    }
  });

  it.each([
    DIVINE_CAPTURE,
    DIVINE_CAPTURE_2,
  ] as const)('%s — the continuous drumbeat runs on the modeled interval', (name) => {
    const capture = loadCapture(name);
    const lone = [...capture.flareSpawns]
      .filter(([, n]) => n === 1)
      .map(([t]) => t)
      .sort((a, b) => a - b);
    expect(lone.length).toBeGreaterThan(5);

    // The drumbeat is a fight-long timer inherited from phases 1-2, so only its PERIOD
    // transfers to a phase-3 sim; the two captures disagree on its phase (control+18 vs
    // control+12) for exactly that reason.
    const residues = new Set(lone.map((t) => t % DIVINE_CONTINUOUS_FLARE_INTERVAL));
    expect(residues.size).toBe(1);

    const { spawns } = runEncounter(DIVINE_SEVERANCE_CONFIG, 140);
    const simLone = [...spawns].filter(([, hps]) => hps.length === 1).map(([t]) => t);
    expect(simLone.length).toBeGreaterThan(2);
    const simResidues = new Set(simLone.map((t) => t % DIVINE_CONTINUOUS_FLARE_INTERVAL));
    expect(simResidues.size).toBe(1);
  });

  it.each([
    BASE_CAPTURE,
    FORFEIT_CAPTURE,
    ...GLYPHIC_CAPTURES,
    BLOODIED_CAPTURE,
  ] as const)('%s — no contract-only drumbeat appears', (name) => {
    const capture = loadCapture(name);
    const lone = [...capture.flareSpawns].filter(([, n]) => n === 1).map(([t]) => t);
    // Base and glyphic each spawn one extra flare on a melee swing — glyphic's player is
    // in melee range for the whole phase, so Yama swings. Neither is a periodic stream.
    expect(lone.length).toBeLessThan(3);
  });

  /**
   * Spawn CORNERS are a strict round-robin: walking `VOID_FLARE_SPAWN_POSITIONS` from the corner
   * a capture happens to open phase 3 on reproduces every spawn it contains, pairs and Divine Severance's lone
   * drumbeat flares alike. The starting corner is the only free parameter, and all four occur
   * across the set, so it is fitted per capture here exactly as the sim seeds it per fight.
   */
  it.each(ALL_CAPTURES)('%s — every flare lands on the next corner in the rotation', (name) => {
    const capture = loadCapture(name);
    const corners = VOID_FLARE_SPAWN_POSITIONS.length;
    expect(capture.flareSpawnOrder.length).toBeGreaterThan(0);

    const matches = (start: number) => {
      let pointer = start;
      return capture.flareSpawnOrder.every(({ positions }) => {
        const expected = positions.map((_, i) => VOID_FLARE_SPAWN_POSITIONS[(pointer + i) % corners]);
        pointer = (pointer + positions.length) % corners;
        // A pair arrives in one packet block with no meaningful order, so compare as a set.
        return [...positions].sort().toString() === [...expected].sort().toString();
      });
    };

    const phases = [...VOID_FLARE_SPAWN_POSITIONS.keys()];
    expect(phases.filter(matches).length, `no rotation phase explains ${name}`).toBeGreaterThan(0);
  });

  it('the sim rotates through the same corners, in the same order', () => {
    const corners = VOID_FLARE_SPAWN_POSITIONS.length;
    const { positions } = runEncounter(BLOODIED_BLOWS_CONFIG, 300);
    const spawned = [...positions].sort((a, b) => a[0] - b[0]).flatMap(([, spawnedAt]) => spawnedAt);
    expect(spawned.length).toBeGreaterThan(7);

    const start = VOID_FLARE_SPAWN_POSITIONS.findIndex((c) => c.toString() === spawned[0].toString());
    expect(start).toBeGreaterThanOrEqual(0);
    for (const [i, corner] of spawned.entries()) {
      expect(corner.toString(), `flare ${i}`).toBe(VOID_FLARE_SPAWN_POSITIONS[(start + i) % corners].toString());
    }
  });

  /**
   * A corner the rotation names but cannot use costs that ONE flare its slot; it does not re-phase
   * the rotation. Standing on a corner is enough to reach this.
   *
   * Read as the PERIOD of the corner sequence, because that is what survives the relocation: with
   * the pointer advanced once per flare the cycle stays four long (one ordinal relocating, and
   * sometimes cascading into the corner behind it), where advancing it to wherever the relocation
   * scan stopped drops the blocked corner out of the cycle entirely and collapses it to three.
   */
  it('keeps the rotation four corners long when one of them is blocked', () => {
    const corners = VOID_FLARE_SPAWN_POSITIONS.length;
    const blocked = VOID_FLARE_SPAWN_POSITIONS[1];
    const { positions } = runEncounter(BLOODIED_BLOWS_CONFIG, 300, blocked);
    const spawned = [...positions]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([, spawnedAt]) => spawnedAt)
      .map(String);
    expect(spawned.length).toBeGreaterThan(2 * corners);
    expect(spawned).not.toContain(String(blocked));

    const period = [...Array(corners).keys()]
      .map((i) => i + 1)
      .find((candidate) => spawned.slice(candidate).every((corner, i) => corner === spawned[i]));
    expect(period).toBe(corners);
  });

  /**
   * Every detonation in `yama-contract-of-bloodied-blows-voidflare-explosions-packet-data.txt`,
   * as (flare hitpoints going into the detonation tick, damage on the player the tick after).
   * Hitpoints are `71 - damage the flare had taken`; the damage is confirmed independently by
   * Yama's heal splat on the detonation tick, which is `floor(8 * damage / 3)` for all 14.
   *
   * Two flares detonate on most of these ticks, and within a tick the pairing follows npc index
   * order. The t568 pair is what forces the direction: 71 hitpoints dealt 45 where 1 hitpoint
   * dealt 10 under an identical Yama, so the scaling is the FLARE's health, not Yama's.
   */
  const BLOODIED_BLOWS_CAPTURE_EXPLOSIONS: readonly (readonly [number, number])[] = [
    [71, 45],
    [71, 47],
    [71, 47],
    [71, 47],
    [70, 45],
    [70, 42],
    [46, 35],
    [38, 28],
    [27, 21],
    [27, 22],
    [11, 19],
    [10, 17],
    [7, 19],
    [1, 10],
  ];

  /**
   * A community-reported set of 35 more bloodied blows P3 detonations (not a capture), each row
   * being the orb's remaining hitpoints and the damage it dealt. These set the band's width at 10:
   * nine of them fall outside the 7-wide band that the capture alone supports, including a 40 at
   * a full 71 and a 24 at 17.
   */
  const BLOODIED_BLOWS_REPORTED_EXPLOSIONS: readonly (readonly [number, number])[] = [
    [71, 40],
    [49, 33],
    [37, 29],
    [36, 29],
    [31, 24],
    [29, 22],
    [27, 24],
    [24, 19],
    [24, 21],
    [23, 19],
    [23, 24],
    [22, 26],
    [21, 19],
    [20, 17],
    [20, 17],
    [20, 22],
    [19, 22],
    [18, 21],
    [17, 17],
    [17, 24],
    [16, 19],
    [15, 19],
    [15, 22],
    [14, 21],
    [13, 19],
    [13, 21],
    [12, 21],
    [11, 19],
    [10, 21],
    [9, 19],
    [7, 19],
    [6, 10],
    [6, 14],
    [5, 17],
    [4, 17],
  ];

  /**
   * Phase 1 and 2 flares spawn on 140 rather than 71, so these are the only samples that
   * constrain the curve ABOVE 71 — without them the hp-140 band is pure extrapolation. The
   * glyphic and forfeit rows are what prove the band is shared by every non-lethal contract
   * rather than being a bloodied blows quirk; deleting them lets the band drift back onto one
   * contract. Hitpoints come from the flare's own `headbar id=2` fill, which is why they are
   * ranges: `fill = ceil(hp * 20 / 71)` (phase-1 flares spawn on 140, so their fill maxes at 40).
   *
   * Each `source` is a capture and a tick: `-p3-void-flare-explosions` for glyphic,
   * `-p3-voidflare-explosions-` for forfeit, and `-voidflare-explosions-` for bloodied blows. A row's damage is
   * confirmable twice, because Yama's `hit id=6` heal on the detonation tick is
   * `floor(8 * damage / 3)` — which is how the 24 at forfeit t2434 was told apart from the 44
   * that Yama's own attack landed on the player in the same tick.
   */
  const CROSS_CONTRACT_EXPLOSIONS: readonly {
    readonly source: string;
    readonly hp: readonly [number, number];
    readonly damage: number;
  }[] = [
    { source: 'bloodied blows P1', hp: [140, 140], damage: 75 },
    { source: 'bloodied blows P1', hp: [140, 140], damage: 71 },
    { source: 'bloodied blows P1', hp: [140, 140], damage: 77 },
    { source: 'glyphic P1 t16388', hp: [139, 140], damage: 73 },
    { source: 'glyphic P1 t16991', hp: [29, 31], damage: 22 },
    { source: 'glyphic P3 t6693', hp: [68, 71], damage: 47 },
    { source: 'glyphic P3 t6553', hp: [8, 10], damage: 21 },
    { source: 'forfeit P1 t198', hp: [54, 56], damage: 38 },
    { source: 'forfeit P3 t2364', hp: [68, 71], damage: 40 },
    { source: 'forfeit P3 t2434', hp: [32, 35], damage: 24 },
  ];

  function bloodiedBlowsExplosionSpec(): Exclude<VoidFlareExplosionDamage, 'lethal'> {
    const spec = BLOODIED_BLOWS_CONFIG.encounter.voidFlares?.explosionDamage;
    if (spec === undefined || spec === 'lethal') {
      throw new Error(`bloodied blows needs a rollable explosion band, got ${String(spec)}`);
    }
    return spec;
  }

  it('brackets every measured explosion with the flare-hitpoint band', () => {
    const spec = bloodiedBlowsExplosionSpec();
    for (const [flareHp, damage] of [...BLOODIED_BLOWS_CAPTURE_EXPLOSIONS, ...BLOODIED_BLOWS_REPORTED_EXPLOSIONS]) {
      const [min, max] = voidFlareExplosionBand(spec, flareHp);
      expect({ flareHp, damage, inBand: damage >= min && damage <= max }).toEqual({
        flareHp,
        damage,
        inBand: true,
      });
    }
  });

  it('brackets the phase-1 and cross-contract explosions too', () => {
    const spec = bloodiedBlowsExplosionSpec();
    for (const { source, hp, damage } of CROSS_CONTRACT_EXPLOSIONS) {
      const candidates = Array.from({ length: hp[1] - hp[0] + 1 }, (_, offset) => hp[0] + offset);
      const someHpFits = candidates.some((candidate) => {
        const [min, max] = voidFlareExplosionBand(spec, candidate);
        return damage >= min && damage <= max;
      });
      expect({ source, damage, someHpFits }).toEqual({ source, damage, someHpFits: true });
    }
  });

  /**
   * Every non-lethal contract reads the SAME band off the shared sigil base. Without this a
   * change that re-homes the band onto bloodied blows passes every other assertion here while
   * silently dropping glyphic and forfeit back to the flat default.
   */
  it('gives every non-lethal contract the identical explosion band', () => {
    const bloodied = bloodiedBlowsExplosionSpec();
    for (const config of [GLYPHIC_ATTENUATION_CONFIG, FORFEIT_BREATH_CONFIG]) {
      const spec = config.encounter.voidFlares?.explosionDamage;
      expect({ contract: config.contractId, spec }).toEqual({ contract: config.contractId, spec: bloodied });
    }
    for (const config of [DIVINE_SEVERANCE_CONFIG, SENSORY_CLOUDING_CONFIG]) {
      expect({ contract: config.contractId, spec: config.encounter.voidFlares?.explosionDamage }).toEqual({
        contract: config.contractId,
        spec: 'lethal',
      });
    }
  });

  /**
   * The band has to stay narrow enough to be a measurement rather than a shrug: widening it until
   * everything fits is always possible and says nothing. Ten is the joint minimum over slope and
   * width that still contains all 52 samples.
   */
  it('keeps the contract explosion band at its fitted width', () => {
    const spec = bloodiedBlowsExplosionSpec();
    const [min, max] = voidFlareExplosionBand(spec, 71);
    expect(max - min).toBe(9);
    expect([min, max]).toEqual([39, 48]);
    expect(voidFlareExplosionBand(spec, 0)).toEqual([8, 17]);
    expect(voidFlareExplosionBand(spec, 140)).toEqual([69, 78]);
  });

  /**
   * A flare left alone hits about twice as hard as one chipped to nothing. Without this the
   * scaling can be silently flattened back to a fixed band and every other assertion still passes.
   */
  it('makes an untouched flare detonate far harder than a spent one', () => {
    const spec = bloodiedBlowsExplosionSpec();
    const [fullMin] = voidFlareExplosionBand(spec, 71);
    const [, spentMax] = voidFlareExplosionBand(spec, 1);
    expect(fullMin).toBeGreaterThan(spentMax);
  });
});

const SENSORY_CAPTURE_BIND_DELAY = 2;
const SENSORY_CAPTURE_BIND_TICKS = 21;
const SENSORY_PURSUIT_EXPECTATIONS = [
  { name: SENSORY_CAPTURE, considered: 120, diverged: [49] },
  { name: SENSORY_CAPTURE_2, considered: 50, diverged: [19, 20, 89, 90] },
] as const;

describe('capture conformance: sensory clouding pursuit', () => {
  const capture = () => loadCapture(SENSORY_CAPTURE);

  /** Chebyshev distance from the player's tile to Yama's 5x5 footprint. */
  const footprintDistance = (yamaSW: Coordinate, player: Coordinate): number =>
    Math.max(
      Math.max(yamaSW[0] - player[0], 0, player[0] - (yamaSW[0] + YAMA_SIZE - 1)),
      Math.max(yamaSW[1] - player[1], 0, player[1] - (yamaSW[1] + YAMA_SIZE - 1)),
    );

  const boundTicks = (specTicks: readonly number[]): Set<number> => {
    const bound = new Set<number>();
    for (const spec of specTicks) {
      for (
        let t = spec + SENSORY_CAPTURE_BIND_DELAY;
        t < spec + SENSORY_CAPTURE_BIND_DELAY + SENSORY_CAPTURE_BIND_TICKS;
        t++
      ) {
        bound.add(t);
      }
    }
    return bound;
  };

  it('only this contract turns pursuit on', () => {
    expect(resolveEncounterConfig(SENSORY_CLOUDING_CONFIG.encounter).pursuit).toBe(true);
    for (const config of [
      BASE_YAMA_CONFIG,
      DIVINE_SEVERANCE_CONFIG,
      FORFEIT_BREATH_CONFIG,
      GLYPHIC_ATTENUATION_CONFIG,
    ]) {
      expect(resolveEncounterConfig(config.encounter).pursuit).toBe(false);
    }
  });

  it('Yama chases at exactly one tile per tick', () => {
    const positions = [...capture().yamaPositions].sort((a, b) => a[0] - b[0]);
    expect(positions.length).toBeGreaterThan(200);
    for (const [index, [tick, here]] of positions.entries()) {
      if (index === 0) continue;
      const there = positions[index - 1][1];
      const step = Math.max(Math.abs(here[0] - there[0]), Math.abs(here[1] - there[1]));
      expect(step, `Yama moved ${step} tiles into sim tick ${tick}`).toBeLessThanOrEqual(1);
    }
  });

  it('the scorching bow bind pins Yama for exactly the modeled window', () => {
    const { yamaPositions, scorchingSpecTicks } = capture();
    expect(scorchingSpecTicks.length).toBeGreaterThanOrEqual(6);

    for (const spec of scorchingSpecTicks) {
      const at = (tick: number): Coordinate | undefined => yamaPositions.get(tick);
      const first = spec + SENSORY_CAPTURE_BIND_DELAY;
      const last = first + SENSORY_CAPTURE_BIND_TICKS - 1;
      const pinned = at(first);
      if (!pinned || !at(last + 1)) continue;

      // Motionless for every tick the model binds him...
      for (let tick = first; tick <= last; tick++) {
        const here = at(tick);
        if (here) expect(here, `spec ${spec}, bound tick ${tick}`).toEqual(pinned);
      }
      // ...and moving again on the very next one, which is what makes this a measurement of the
      // duration rather than of "he stopped at some point".
      expect(at(last + 1), `spec ${spec} released`).not.toEqual(pinned);
    }
  });

  /**
   * Every DETERMINISTIC phase-3 movement, tile for tile.
   *
   * Two classes of tick are excluded because the model is not meant to reproduce them:
   * a bind window, where Yama cannot move at all, and a tick where the player stood under his
   * footprint at decision time, where he takes a RANDOM sidestep. Both are excluded by
   * construction rather than absorbed into a tolerance, which is what lets this assert an exact
   * count instead of a pass rate.
   */
  it.each(
    SENSORY_PURSUIT_EXPECTATIONS,
  )('$name reproduces every deterministic phase-3 movement except the pinned divergences', ({
    name,
    considered: expectedConsidered,
    diverged: expectedDiverged,
  }) => {
    const { yamaPositions, playerPositions, scorchingSpecTicks } = loadCapture(name);
    const bound = boundTicks(scorchingSpecTicks);
    const lastKnown = <T>(source: Map<number, T>, tick: number): T | undefined => {
      for (let t = tick; t >= 0; t--) {
        const value = source.get(t);
        if (value !== undefined) return value;
      }
      return undefined;
    };

    let considered = 0;
    const diverged: number[] = [];
    for (const [tick, actual] of [...yamaPositions].sort((a, b) => a[0] - b[0])) {
      const from = lastKnown(yamaPositions, tick - 1);
      const player = lastKnown(playerPositions, tick - 1);
      if (!from || !player) continue;
      if (bound.has(tick)) continue;
      if (isPlayerUnderFootprint(from, YAMA_SIZE, player)) continue;

      const step = npcPursuitPath({
        bossSW: from,
        size: YAMA_SIZE,
        underFootprint: 'random-cardinal',
        unreachable: 'nearest-reachable',
        player,
        rng: () => 0,
        maxSpeed: 1,
        canOccupy: () => true,
      })[0];
      const predicted = step ?? from;
      considered++;
      if (predicted[0] !== actual[0] || predicted[1] !== actual[1]) diverged.push(tick);
    }

    expect(considered).toBe(expectedConsidered);
    expect(diverged).toEqual(expectedDiverged);
  });

  it('Yama closes to melee range, which is what makes the attack policy swing', () => {
    const { yamaPositions, playerPositions } = capture();
    const distances = [...yamaPositions]
      .map(([tick, yama]) => {
        const player = playerPositions.get(tick);
        return player ? footprintDistance(yama, player) : null;
      })
      .filter((d): d is number => d !== null);

    expect(Math.min(...distances)).toBeLessThanOrEqual(1);
  });
});

/**
 * `sa_energy` is tenths of a percent (RuneLite reads `getVarpValue(SA_ENERGY) / 10`), so the sim's
 * 0-100 constants scale by 10 to compare against the capture.
 */
const SPEC_VARP_PER_PERCENT = 10;

describe('capture conformance: special attack economy', () => {
  const capture = () => loadCapture(SENSORY_CAPTURE);

  it('the capture regenerates at the Lightbearer cadence, which the preset wears', () => {
    // The Sensory preset equips ring 25975, and `syncLightbearer` is what makes that reach the
    // regen timer. Before it did, this capture was reproduced at half speed.
    expect(EQUIPMENT_PRESETS.yama_p3_sensory.mage.equipment.ring).toBe(LIGHTBEARER_ITEM_ID);

    // A +10% step that is not a Death Charge proc is a natural regen tick.
    const { specEnergy, deathChargeActive } = capture();
    const procTicks = new Set(deathChargeActive.filter((t) => t.to < t.from).map((t) => t.tick));
    const regenTicks = specEnergy
      .filter((e) => e.to - e.from === SPEC_REGEN_AMOUNT * SPEC_VARP_PER_PERCENT)
      .filter((e) => !procTicks.has(e.tick))
      .map((e) => e.tick);
    expect(regenTicks.length).toBeGreaterThan(4);

    // Gaps are only comparable across a stretch where a cycle was actually RUNNING. A full bar has
    // none — the player sits at 100% for 200+ ticks here without a single regen — so a pair
    // straddling a refill measures dead time, not cadence.
    const fullTicks = specEnergy.filter((e) => e.to === 100 * SPEC_VARP_PER_PERCENT).map((e) => e.tick);
    const running = regenTicks
      .slice(1)
      .map((tick, index) => ({ from: regenTicks[index], to: tick }))
      .filter((pair) => !fullTicks.some((full) => full >= pair.from && full < pair.to));
    expect(running.length).toBeGreaterThan(3);

    for (const pair of running) {
      expect(pair.to - pair.from, `regen t${pair.from} -> t${pair.to}`).toBe(SPEC_REGEN_TICKS_LIGHTBEARER);
    }
    // The bare rate cannot produce a 25-tick gap at all, which is what makes this discriminating.
    expect(SPEC_REGEN_TICKS).toBeGreaterThan(SPEC_REGEN_TICKS_LIGHTBEARER);
  });

  it('every Death Charge cast arms two procs — the rite, not one', () => {
    const casts = capture().deathChargeActive.filter((t) => t.from === 0);
    expect(casts.length).toBeGreaterThan(0);
    for (const cast of casts) {
      expect(cast.to, `cast at t${cast.tick}`).toBe(DEATH_CHARGE_PROCS_UPGRADED);
    }
  });

  it('each proc pays exactly the modeled 15%', () => {
    const { deathChargeActive, specEnergy } = capture();
    const procs = deathChargeActive.filter((t) => t.to < t.from);
    expect(procs.length).toBeGreaterThan(1);

    for (const proc of procs) {
      const gain = specEnergy.find(
        (e) => e.tick === proc.tick && e.to - e.from === DEATH_CHARGE_SPEC_RESTORE * SPEC_VARP_PER_PERCENT,
      );
      expect(gain, `proc at t${proc.tick} restored 15%`).toBeDefined();
    }
  });

  it('the cast cooldown runs exactly as long as the model says', () => {
    const { deathChargeCooldown } = capture();
    const starts = deathChargeCooldown.filter((t) => t.to === 1);
    const ends = deathChargeCooldown.filter((t) => t.to === 0);
    expect(starts.length).toBeGreaterThan(0);

    for (const end of ends) {
      const start = starts.filter((s) => s.tick < end.tick).at(-1);
      expect(start).toBeDefined();
      expect(end.tick - start!.tick, `cooldown from t${start!.tick}`).toBe(DEATH_CHARGE_COOLDOWN_TICKS);
    }
  });

  it('a proc never takes the bar past full', () => {
    for (const step of capture().specEnergy) {
      expect(step.to).toBeLessThanOrEqual(100 * SPEC_VARP_PER_PERCENT);
    }
  });
});

/**
 * Scorching shackles, read straight out of both sensory captures rather than through
 * `loadCapture`: the second one opens mid-phase-3 and carries no `busy 1->0`, so it has no
 * control tick to shift against, and none of these numbers need one.
 *
 * Each subset is asserted at an EXACT size. A filter that silently stops matching casts would
 * otherwise leave the surviving ones passing, which is how a capture-backed number rots.
 * Derivations: `docs/encounters/sensory-clouding-open-questions.md` entries 6 and 6b.
 */
describe('capture conformance: scorching shackles timing', () => {
  const scorchingCasts = (name: string) =>
    YAMA_SCORCHING_CASTS.filter((cast) => cast.capture === name).map((cast) => ({
      ...cast,
      untilNextCast: cast.untilNextCast ?? Number.POSITIVE_INFINITY,
    }));

  const casts = [...scorchingCasts(SENSORY_CAPTURE), ...scorchingCasts(SENSORY_CAPTURE_2)];

  it('reads ten casts spanning footprint distances 1 to 4', () => {
    expect(casts).toHaveLength(10);
    expect([...new Set(casts.map((cast) => cast.distance))].sort()).toEqual([1, 2, 3, 4]);
  });

  it('lands its hitsplat three ticks after the cast, at every distance', () => {
    const attributable = casts.filter((cast) => cast.soleAttacker);
    expect(attributable).toHaveLength(8);
    expect([...new Set(attributable.map((cast) => cast.distance))].sort()).toEqual([1, 2, 3, 4]);
    for (const cast of attributable) {
      expect(cast.splat, `${cast.capture} cast ${cast.tick} (distance ${cast.distance})`).toBe(3);
    }
  });

  // A cast fired into an existing bind cannot show a free step, so it says nothing about the
  // start and is excluded rather than counted as agreement.
  it('stops Yama from cast+2, one tick after his last free step', () => {
    const chasing = casts.filter((cast) => cast.steppedOnCastRelativeTicks.includes(1));
    expect(chasing).toHaveLength(7);
    for (const cast of chasing) {
      expect(
        cast.steppedOnCastRelativeTicks,
        `${cast.capture} cast ${cast.tick} (distance ${cast.distance})`,
      ).not.toContain(2);
    }
  });

  // A later cast rebinds Yama from ITS cast+2, so the release is visible whenever the next cast is
  // more than 21 ticks out, not 23.
  it('lets Yama step again on cast+23, wherever no later cast rebinds him first', () => {
    const releasing = casts.filter((cast) => cast.untilNextCast + 2 > 23);
    expect(releasing).toHaveLength(8);
    for (const cast of releasing) {
      const resumed = Math.min(...cast.steppedOnCastRelativeTicks.filter((t) => t >= 2));
      expect(resumed, `${cast.capture} cast ${cast.tick}`).toBe(23);
    }
  });
});
