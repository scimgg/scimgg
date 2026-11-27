import { describe, expect, it } from 'vitest';
import { SimulationEngine } from '../core/SimulationEngine';
import type { WorldState } from '../core/WorldState';
import { EQUIPMENT_PRESETS } from '../data/playerPresets';
import { YAMA_SPAWN_VOID_FLARE_COMMAND } from '../encounters/yamaP3/commands';
import { VOID_FLARE_NPC_ID } from '../encounters/yamaP3/constants';
import { BLOODIED_BLOWS_CONFIG, type YamaContractConfig } from '../encounters/yamaP3/contractConfig';
import { YamaEncounter } from '../encounters/yamaP3/YamaEncounter';
import { VOID_FLARE_UNTARGETABLE_TICKS } from '../npcs/yama/timing';
import type { CacheInfo } from '../rs/cache/CacheInfo';
import { ObjType } from '../rs/config/objtype/ObjType';
import { DummyTypeLoader } from '../rs/config/TypeLoader';
import { WIKI_TIERED_PRAYER_ROWS, type WikiTieredPrayer } from '../types/__tests__/fixtures/wikiPrayerTable';
import { createEmptyCombatSupplies } from '../types/encounterLoadout';
import { type Coordinate, PrayerType } from '../types/simulation';

const PLAYER_POS: Coordinate = [31, 33];
const YAMA_TARGET_ID = 'yama';
const TEST_CACHE_INFO: CacheInfo = {
  name: 'test',
  game: 'oldschool',
  environment: 'live',
  revision: 232,
  timestamp: '2024-01-01T00:00:00.000Z',
  size: 0,
};

class FinalWaveFormulaEncounter extends YamaEncounter {
  override createNpcs(playerStart: Coordinate) {
    const npcs = super.createNpcs(playerStart);
    for (const npc of npcs) npc.npcTypeId = 7702;
    return npcs;
  }
}

function createEngine(weaponId: number, contract?: YamaContractConfig): SimulationEngine {
  const engine = new SimulationEngine({
    encounter: contract === undefined ? new YamaEncounter() : new YamaEncounter(contract),
    startPos: PLAYER_POS,
    objTypeLoader: new DummyTypeLoader(TEST_CACHE_INFO, ObjType),
  });

  engine.setMechanicsConfig({
    yamaMageRange: false,
    yamaMelee: false,
    waves: false,
    fireballs: false,
    voidFlares: false,
    infiniteHealth: true,
  });

  engine.setEquipment({ weapon: weaponId });
  // Weapons with a built-in autocast (Purging staff -> Dark Demonbane) are rune-gated
  // like any other cast, so stock the runes its default spell needs.
  engine.setCombatSupplies({
    ...createEmptyCombatSupplies(),
    runePouch: {
      kind: 'standard',
      slots: [{ id: 554 }, { id: 566 }, null],
    },
  });
  engine.setAttackTarget(YAMA_TARGET_ID);
  return engine;
}

const getWorldState = (engine: SimulationEngine): WorldState => Reflect.get(engine, 'worldState') as WorldState;

function advanceTicks(engine: SimulationEngine, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    engine.advanceTick(engine.getState().playerPosition);
  }
}

/** A debug flare cannot be targeted until it activates, so wait that out before returning it. */
function spawnTargetableFlare(engine: SimulationEngine) {
  engine.setAttackTarget(null);
  engine.executeEncounterCommand(YAMA_SPAWN_VOID_FLARE_COMMAND);
  advanceTicks(engine, VOID_FLARE_UNTARGETABLE_TICKS);
  const flare = getWorldState(engine)
    .getNpcs()
    .find((npc) => npc.npcTypeId === VOID_FLARE_NPC_ID);
  if (flare === undefined) throw new Error('Expected a debug void flare');
  return flare;
}

function getPlayerHits(engine: SimulationEngine) {
  return engine
    .getState()
    .damageHistory.filter((entry) => entry.source === 'PlayerAttack' && entry.targetId === YAMA_TARGET_ID);
}

describe('expected DPS regression', () => {
  it('expectedHit is non-zero for melee weapon attacks', () => {
    const engine = createEngine(24417);
    advanceTicks(engine, 20);

    const hits = getPlayerHits(engine);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((entry) => (entry.expectedHit ?? 0) > 0)).toBe(true);
  });

  it('expectedHit is non-zero for magic weapon attacks (powered staff)', () => {
    const engine = createEngine(29594);
    advanceTicks(engine, 20);

    const hits = getPlayerHits(engine);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((entry) => (entry.expectedHit ?? 0) > 0)).toBe(true);
  });

  it('keeps launch-time ammo for expectedHit across delayed projectiles', () => {
    const engine = createEngine(20997);
    engine.setCombatSupplies({
      ...createEmptyCombatSupplies(),
      equippedAmmo: { id: 11212 },
    });

    advanceTicks(engine, 8);

    const hits = getPlayerHits(engine);
    expect(engine.getCombatSupplies().equippedAmmo).toEqual({ id: 11212 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.expectedHit).toBeGreaterThan(0);
  });

  it('keeps launch-time expectedHit when equipment changes before a delayed projectile lands', () => {
    const baseline = createEngine(20997);
    const swapped = createEngine(20997);
    const supplies = {
      ...createEmptyCombatSupplies(),
      equippedAmmo: { id: 11212, quantity: 1 },
    };
    baseline.setCombatSupplies(supplies);
    swapped.setCombatSupplies(supplies);

    baseline.advanceTick(baseline.getState().playerPosition);
    swapped.advanceTick(swapped.getState().playerPosition);
    swapped.setEquipment({ weapon: 9185 });
    advanceTicks(baseline, 7);
    advanceTicks(swapped, 7);

    const baselineExpectedHit = getPlayerHits(baseline)[0]?.expectedHit;
    const swappedExpectedHit = getPlayerHits(swapped)[0]?.expectedHit;
    expect(baselineExpectedHit).toBeGreaterThan(0);
    expect(swappedExpectedHit).toBe(baselineExpectedHit);
  });

  it('derives non-zero expected DPS from the engine damage history (HUD per-target formula)', () => {
    const engine = createEngine(29594);
    advanceTicks(engine, 20);

    const hits = getPlayerHits(engine);
    expect(hits.length).toBeGreaterThan(0);

    const totalExpected = hits.reduce((sum, entry) => sum + (entry.expectedHit ?? 0), 0);
    const firstTick = hits[0].tick;
    const elapsedTicks = engine.getState().currentTick - firstTick;
    const elapsedSeconds = elapsedTicks * 0.6;
    const expected = elapsedSeconds > 0 ? totalExpected / elapsedSeconds : 0;

    expect(expected).toBeGreaterThan(0);
  });

  it('reduces Ruby bolt proc damage as the target loses hitpoints', () => {
    const engine = createEngine(9185);
    engine.setCombatSupplies({
      ...createEmptyCombatSupplies(),
      equippedAmmo: { id: 9242 },
    });

    const baseHpProjection = engine.getAdjustedTheoreticalDps();
    engine.setBossHp(400);
    const lowHpProjection = engine.getAdjustedTheoreticalDps();

    expect(baseHpProjection).not.toBeNull();
    expect(lowHpProjection).not.toBeNull();
    expect(baseHpProjection?.dps).toBeGreaterThan(lowHpProjection?.dps ?? Number.POSITIVE_INFINITY);
    expect(baseHpProjection?.maxHit).toBeGreaterThan(lowHpProjection?.maxHit ?? Number.POSITIVE_INFINITY);
  });

  it('projects non-zero DPS for a default Dark Demonbane cast when its runes are available', () => {
    const engine = createEngine(29594);

    const result = engine.getAdjustedTheoreticalDps();

    expect(result?.dps).toBeGreaterThan(0);
  });

  it('projects zero DPS for a default Dark Demonbane cast when its runes are unavailable', () => {
    const engine = createEngine(29594);
    engine.setCombatSupplies(createEmptyCombatSupplies());

    const result = engine.getAdjustedTheoreticalDps();

    expect(result?.dps ?? 0).toBe(0);
  });

  it('returns no DPS projection for a dead target instead of restoring full HP', () => {
    const engine = createEngine(9185);
    engine.setCombatSupplies({
      ...createEmptyCombatSupplies(),
      equippedAmmo: { id: 9242 },
    });

    engine.setBossHp(400);
    expect(engine.getAdjustedTheoreticalDps()).not.toBeNull();

    engine.setBossHp(0);
    expect(engine.getAdjustedTheoreticalDps()).toBeNull();
  });

  it('projects non-zero DPS for a Twisted bow, which scales off the target Magic', () => {
    const engine = createEngine(20997);
    engine.setCombatSupplies({ ...createEmptyCombatSupplies(), equippedAmmo: { id: 11212 } });

    const result = engine.getAdjustedTheoreticalDps();

    expect(result?.dps).toBeGreaterThan(0);
  });

  it('projects non-zero DPS for enchanted bolts', () => {
    const engine = createEngine(9185);
    engine.setCombatSupplies({ ...createEmptyCombatSupplies(), equippedAmmo: { id: 9242 } });

    const result = engine.getAdjustedTheoreticalDps();

    expect(result?.dps).toBeGreaterThan(0);
  });

  // Yama Phase 3 carries light 449 / standard 297 / heavy 449 ranged defence at Defence 225. An NPC's
  // defence roll is (Defence level + 9) × (ranged defence bonus + 64) (OSRS Wiki, Damage per
  // second/Ranged § Step six): (225 + 9) × (449 + 64) = 120042 for the blowpipe and Armadyl crossbow,
  // and (225 + 9) × (297 + 64) = 84474 for bows and the atlatl (/w/Attack_types § Ranged types).
  it.each([
    { weapon: 'Toxic blowpipe (dragon darts)', weaponId: 12926, ammoId: undefined, defenceRoll: 120042 },
    { weapon: 'Armadyl crossbow', weaponId: 11785, ammoId: 21905, defenceRoll: 120042 },
    { weapon: 'Twisted bow', weaponId: 20997, ammoId: 11212, defenceRoll: 84474 },
    { weapon: 'Bow of faerdhinen', weaponId: 25865, ammoId: undefined, defenceRoll: 84474 },
    { weapon: 'Crystal bow', weaponId: 23983, ammoId: undefined, defenceRoll: 84474 },
    { weapon: 'Eclipse atlatl', weaponId: 29000, ammoId: 28991, defenceRoll: 84474 },
  ])('projects the $weapon against Yama Phase 3 ranged defence roll $defenceRoll', ({
    weaponId,
    ammoId,
    defenceRoll,
  }) => {
    const engine = createEngine(weaponId);
    engine.setCombatSupplies({
      ...createEmptyCombatSupplies(),
      ...(ammoId === undefined ? {} : { equippedAmmo: { id: ammoId } }),
    });

    const result = engine.getAdjustedTheoreticalDps();

    expect(result?.style).toBe('ranged');
    expect(result?.baseDefenceRoll).toBe(defenceRoll);
  });

  it('raises a demonbane cast max hit once Mark of Darkness is active', () => {
    const plain = createEngine(29594);
    const marked = createEngine(29594);
    marked.setCombatSupplies({
      ...createEmptyCombatSupplies(),
      runePouch: { kind: 'standard', slots: [{ id: 554 }, { id: 566 }, { id: 564 }] },
    });
    marked.castMarkOfDarkness();

    const plainMaxHit = plain.getAdjustedTheoreticalDps()?.maxHit ?? 0;
    const markedMaxHit = marked.getAdjustedTheoreticalDps()?.maxHit ?? 0;

    expect(marked.markOfDarknessActive).toBe(true);
    expect(plainMaxHit).toBeGreaterThan(0);
    expect(markedMaxHit).toBeGreaterThan(plainMaxHit);
  });

  it('scales demonbane max hits by Yama and Void Flare vulnerability', () => {
    const engine = createEngine(29594);
    engine.setCombatSupplies({
      ...createEmptyCombatSupplies(),
      runePouch: { kind: 'standard', slots: [{ id: 554 }, { id: 566 }, { id: 564 }] },
    });
    engine.castMarkOfDarkness();
    const againstYama = engine.getAdjustedTheoreticalDps()?.maxHit ?? 0;

    const flare = spawnTargetableFlare(engine);
    engine.setAttackTarget(flare.id);
    const againstFlare = engine.getAdjustedTheoreticalDps()?.maxHit ?? 0;

    expect(engine.markOfDarknessActive).toBe(true);
    // Yama turns the +50% bonus into +60%; the flare turns it into +100%.
    expect(againstYama).toBeGreaterThan(0);
    expect(againstFlare).toBe(Math.floor((againstYama / 1.6) * 2));
  });

  it.each([
    { style: 'magic', weaponId: 29594 },
    { style: 'melee', weaponId: 24417 },
  ])('projects full $style accuracy on a void flare, in every contract', ({ weaponId }) => {
    const projectAccuracy = (contract?: YamaContractConfig) => {
      const engine = createEngine(weaponId, contract);
      const againstYama = engine.getAdjustedTheoreticalDps()?.accuracy ?? 0;

      const flare = spawnTargetableFlare(engine);
      engine.setAttackTarget(flare.id);

      return { againstYama, againstFlare: engine.getAdjustedTheoreticalDps()?.accuracy ?? 0 };
    };

    for (const contract of [undefined, BLOODIED_BLOWS_CONFIG]) {
      const { againstYama, againstFlare } = projectAccuracy(contract);
      expect(againstYama).toBeGreaterThan(0);
      expect(againstYama).toBeLessThan(1);
      expect(againstFlare).toBeCloseTo(1, 10);
    }
  });

  // A manual cast ends the interaction but leaves `lastAttackTarget`: the projection stays on it.
  it('projects against the last target once the interaction has ended, and against the boss with none', () => {
    const engine = createEngine(29594);
    const againstYama = engine.getAdjustedTheoreticalDps()?.accuracy ?? 0;
    const flare = spawnTargetableFlare(engine);
    engine.setAttackTarget(flare.id);
    engine.setAttackTarget(null);
    const player = getWorldState(engine).getPlayer();
    if (!player) throw new Error('Expected player');

    expect(player).toMatchObject({ attackTarget: null, lastAttackTarget: flare.id });
    expect(againstYama).toBeLessThan(1);
    expect(engine.getAdjustedTheoreticalDps()?.accuracy).toBeCloseTo(1, 10);

    delete player.lastAttackTarget;
    expect(engine.getAdjustedTheoreticalDps()?.accuracy).toBe(againstYama);
  });

  it('launches the purging staff special instead of refusing it', () => {
    const engine = createEngine(29594);
    const flare = spawnTargetableFlare(engine);
    engine.setAttackTarget(flare.id);
    engine.queueSpecialAttackToggle();

    advanceTicks(engine, 4);

    const hits = engine
      .getState()
      .damageHistory.filter((entry) => entry.source === 'PlayerAttack' && entry.targetId === flare.id);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((entry) => (entry.expectedHit ?? 0) > 0)).toBe(true);
    expect(engine.getState().specialAttack.energy).toBeLessThan(100);
  });

  it('resolves a rendered final-wave ID through the real engine attack path', () => {
    const engine = new SimulationEngine({
      encounter: new FinalWaveFormulaEncounter(),
      startPos: PLAYER_POS,
      objTypeLoader: new DummyTypeLoader(TEST_CACHE_INFO, ObjType),
    });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      yamaMelee: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
    });
    engine.setEquipment({ weapon: 29000 });
    engine.setCombatSupplies({
      ...createEmptyCombatSupplies(),
      equippedAmmo: { id: 28991 },
    });
    engine.setAttackTarget(YAMA_TARGET_ID);

    advanceTicks(engine, 12);

    expect(getPlayerHits(engine).some((entry) => (entry.expectedHit ?? 0) > 0)).toBe(true);
  });
});

const SHIPPED_PRESETS = Object.entries(EQUIPMENT_PRESETS).flatMap(([encounter, group]) =>
  Object.entries(group).map(([key, preset]) => ({ encounter, key, preset })),
);

function createPresetEngine(preset: (typeof SHIPPED_PRESETS)[number]['preset']): SimulationEngine {
  const engine = new SimulationEngine({
    encounter: new YamaEncounter(),
    startPos: PLAYER_POS,
    objTypeLoader: new DummyTypeLoader(TEST_CACHE_INFO, ObjType),
  });
  engine.setMechanicsConfig({
    yamaMageRange: false,
    yamaMelee: false,
    waves: false,
    fireballs: false,
    voidFlares: false,
    infiniteHealth: true,
  });
  engine.setEquipment(preset.equipment);
  engine.setCombatSupplies({ ...createEmptyCombatSupplies(), ...(preset.supplies ?? {}) });
  engine.setAttackTarget(YAMA_TARGET_ID);
  return engine;
}

describe('shipped equipment presets', () => {
  it('sweeps every preset the loadout planner ships', () => {
    expect(SHIPPED_PRESETS.length).toBeGreaterThan(10);
  });

  it.each(SHIPPED_PRESETS)('$encounter/$key projects a non-zero DPS readout', ({ preset }) => {
    const projection = createPresetEngine(preset).getAdjustedTheoreticalDps();

    expect(projection?.dps ?? 0).toBeGreaterThan(0);
    expect(projection?.maxHit ?? 0).toBeGreaterThan(0);
  });

  it.each(SHIPPED_PRESETS)('$encounter/$key lands damage through the engine attack path', ({ preset }) => {
    const engine = createPresetEngine(preset);

    advanceTicks(engine, 20);

    const hits = getPlayerHits(engine);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((entry) => (entry.expectedHit ?? 0) > 0)).toBe(true);
  });

  it('exposes Yama 120% demonbane vulnerability to player projections', () => {
    const world = getWorldState(createPresetEngine(EQUIPMENT_PRESETS.yama_p3.melee));

    expect(world.getNpc(YAMA_TARGET_ID)?.formulaStats?.demonbaneVulnerability).toBe(1.2);
  });
});

/**
 * What the DPS overlay shows (`getAdjustedTheoreticalDps`) for each tiered prayer and Chivalry, lit
 * through the prayer book's engine call, on 99s against Yama Phase 3. The stub item loader leaves
 * only the hand-set gear stats in `EQUIPMENT_STAT_OVERRIDES`, so each loadout's bonuses are known.
 *
 * Wiki formulas (https://oldschool.runescape.wiki/w/Damage_per_second/Melee, /Ranged, /Magic):
 * effective level = floor(99 × prayer) + stance + 8; attack roll = effective × (bonus + 64);
 * melee and ranged max hit = floor((effective strength × (strength bonus + 64) + 320) / 640);
 * magic max hit = floor(base × (1 + gear damage + prayer damage)); NPC defence roll =
 * (level + 9) × (defence bonus + 64); accuracy = attack / (2 × (defence + 1)) when attack ≤ defence.
 * DPS = accuracy × (max / 2 + 1 / (max + 1)) / seconds per attack, the last term being the
 * projection's rule that an accurate 0 lands as 1 (playerAttackProjection.ts).
 *
 * - melee, Inquisitor's mace on Pound (+3 Attack): crush +102, strength +96, 4 ticks = 2.4 s, against
 *   (225 + 9) × (449 + 64) = 120042. Unprayed: 110 × 166 = 18260, floor((107 × 160 + 320) / 640) = 27.
 * - ranged, Bow of Faerdhinen on Accurate (+3 both) with Necklace of rupture, Dizana's quiver and
 *   Avernic treads (max): ranged +53, ranged strength +14, 2.4 s, against (225 + 9) × (297 + 64) =
 *   84474. Unprayed: 110 × 117 = 12870, floor((110 × 78 + 320) / 640) = 13.
 * - magic, Ice Barrage (base 30) from an Ancient staff with Blue Moon chestplate and Avernic treads
 *   (max): magic +41, damage +3%, 5 ticks = 3 s, against (250 + 9) × (81 + 64) = 37555. Unprayed:
 *   107 × 105 = 11235, floor(30 × 1.03) = 30.
 */
type OverlayNumbers = { readonly accuracy: number; readonly maxHit: number; readonly dps: number };
type OverlayStyle = 'melee' | 'ranged' | 'magic';

const UNPRAYED_OVERLAY: Record<OverlayStyle, OverlayNumbers> = {
  // 18260 / 240086
  melee: { accuracy: 0.07605607990470081, maxHit: 27, dps: 0.4289472363672858 },
  // 12870 / 168950
  ranged: { accuracy: 0.07617638354542765, maxHit: 13, dps: 0.20857819304105188 },
  // 11235 / 75112
  magic: { accuracy: 0.1495766322292044, maxHit: 30, dps: 0.7494915120302069 },
};

/** Only the styles each prayer changes; every other style must read exactly as unprayed. */
const PRAYED_OVERLAY: Record<WikiTieredPrayer, Partial<Record<OverlayStyle, OverlayNumbers>>> = {
  // Defence prayers move no attack number; their effect on the NPC's roll is in npcAttackRequest.test.ts.
  [PrayerType.ThickSkin]: {},
  [PrayerType.RockSkin]: {},
  [PrayerType.SteelSkin]: {},
  // Strength 103 / 108 / 113: floor((111 | 116 | 121) × 160 + 320) / 640) = 28 / 29 / 30
  [PrayerType.BurstOfStrength]: { melee: { accuracy: 0.07605607990470081, maxHit: 28, dps: 0.44475322587950045 } },
  [PrayerType.SuperhumanStrength]: { melee: { accuracy: 0.07605607990470081, maxHit: 29, dps: 0.4605618172006883 } },
  [PrayerType.UltimateStrength]: { melee: { accuracy: 0.07605607990470081, maxHit: 30, dps: 0.47637275854288413 } },
  // Attack 103 / 108 / 113: (114 | 119 | 124) × 166 = 18924 / 19754 / 20584, over 240086
  [PrayerType.ClarityOfThought]: { melee: { accuracy: 0.07882175553759903, maxHit: 27, dps: 0.4445453176897326 } },
  [PrayerType.ImprovedReflexes]: { melee: { accuracy: 0.0822788500787218, maxHit: 27, dps: 0.46404291934279107 } },
  [PrayerType.IncredibleReflexes]: { melee: { accuracy: 0.08573594461984456, maxHit: 27, dps: 0.4835405209958495 } },
  // Ranged 103 / 108: (114 | 119) × 117 = 13338 / 13923 over 168950; floor((114 | 119) × 78 + 320) / 640) = 14 / 15
  [PrayerType.SharpEye]: { ranged: { accuracy: 0.07894643385617046, maxHit: 14, dps: 0.2324533885765019 } },
  [PrayerType.HawkEye]: { ranged: { accuracy: 0.08240899674459899, maxHit: 15, dps: 0.2596741824504291 } },
  // Magic 103 / 108: (111 | 116) × 105 = 11655 / 12180 over 75112; Mystic Lore floor(30 × 1.04) = 31
  [PrayerType.MysticWill]: { magic: { accuracy: 0.1551682820321653, maxHit: 30, dps: 0.77750988631171 } },
  [PrayerType.MysticLore]: { magic: { accuracy: 0.16215784428586644, maxHit: 31, dps: 0.839504673021621 } },
  // Attack 113 as Incredible Reflexes; Strength floor(99 × 1.18) = 116: floor((124 × 160 + 320) / 640) = 31
  [PrayerType.Chivalry]: { melee: { accuracy: 0.08573594461984456, maxHit: 31, dps: 0.5548276624487336 } },
};

describe('tiered prayers and Chivalry in the DPS overlay', () => {
  const ICE_BARRAGE_RUNES = { kind: 'standard', slots: [{ id: 555 }, { id: 565 }, { id: 560 }] } as const;
  const LOADOUTS: Record<OverlayStyle, () => SimulationEngine> = {
    melee: () => {
      const engine = createEngine(24417);
      engine.setSelectedAttackStyleIndex(0);
      return engine;
    },
    ranged: () => {
      const engine = createEngine(25865);
      engine.setEquipment({ weapon: 25865, amulet: 33639, cape: 28951, boots: 31097 });
      engine.setSelectedAttackStyleIndex(0);
      return engine;
    },
    magic: () => {
      const engine = createEngine(4675);
      engine.setEquipment({ weapon: 4675, body: 29037, boots: 31097 });
      engine.setCombatSupplies({
        ...createEmptyCombatSupplies(),
        spellbook: 'ancient',
        selectedSpell: 'Ice Barrage',
        runePouch: ICE_BARRAGE_RUNES,
      });
      engine.setSelectedAttackStyleIndex(3);
      return engine;
    },
  };

  function overlay(style: OverlayStyle, prayer: PrayerType | null): OverlayNumbers {
    const engine = LOADOUTS[style]();
    if (prayer !== null) engine.queueBoostPrayer(prayer);
    advanceTicks(engine, 1);
    expect(engine.boostPrayers).toEqual(prayer === null ? [] : [prayer]);
    const projection = engine.getAdjustedTheoreticalDps();
    if (projection === null) throw new TypeError('Expected a DPS projection');
    return { accuracy: projection.accuracy, maxHit: projection.maxHit, dps: projection.dps };
  }

  function expectOverlay(actual: OverlayNumbers, expected: OverlayNumbers): void {
    expect(actual.maxHit).toBe(expected.maxHit);
    expect(actual.accuracy).toBeCloseTo(expected.accuracy, 12);
    expect(actual.dps).toBeCloseTo(expected.dps, 12);
  }

  it.each(['melee', 'ranged', 'magic'] as const)('reads the unprayed %s numbers the wiki formulas give', (style) => {
    expectOverlay(overlay(style, null), UNPRAYED_OVERLAY[style]);
  });

  it.each(WIKI_TIERED_PRAYER_ROWS)('changes exactly the overlay numbers $prayer boosts', ({ prayer }) => {
    for (const style of ['melee', 'ranged', 'magic'] as const) {
      expectOverlay(overlay(style, prayer), PRAYED_OVERLAY[prayer][style] ?? UNPRAYED_OVERLAY[style]);
    }
  });
});
