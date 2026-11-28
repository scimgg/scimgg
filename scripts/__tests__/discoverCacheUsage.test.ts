import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SOL_BOUNDARY_LOC_IDS } from '../../src/encounters/solHeredit/arenaBoundary';
import { COLOSSEUM_SPOTANIMS } from '../../src/npcs/colosseum/constants';
import { computeTraceSpecHash, discoverCacheUsage, parseMapSquare } from '../discoverCacheUsage';

let root: string;
let srcDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'discover-cache-animations-'));
  srcDir = path.join(root, 'src');
  mkdirSync(srcDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSrc(rel: string, contents: string): void {
  const full = path.join(srcDir, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

describe('discoverCacheUsage animation sequence dictionaries', () => {
  it('extracts seq ids from uppercase *_ANIMATIONS object constants', async () => {
    writeSrc(
      'fixtures/constants.ts',
      `
      export const TEST_ANIMATIONS = {
        first: 101,
        second: 102,
        third: 103,
        fourth: 104,
      } as const;

      export const SECOND_TEST_ANIMATIONS = {
        first: 201,
        second: 202,
        third: 203,
        fourth: 204,
        fifth: 205,
        sixth: 206,
      } as const;
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.seqIds].sort((a, b) => a - b)).toEqual([101, 102, 103, 104, 201, 202, 203, 204, 205, 206]);
  });
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'discover-cache-'));
  srcDir = path.join(root, 'src');
  mkdirSync(srcDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discoverCacheUsage', () => {
  it('retains every Sol effect and boundary variant from their actual declarations', async () => {
    for (const file of ['npcs/colosseum/constants.ts', 'encounters/solHeredit/arenaBoundary.ts']) {
      writeSrc(file, readFileSync(`src/${file}`, 'utf8'));
    }
    const report = await discoverCacheUsage(root);
    const effects = Object.values(COLOSSEUM_SPOTANIMS).flat();
    expect(effects).toHaveLength(41);
    expect([...report.spotAnimIds].sort((left, right) => left - right)).toEqual(
      [...effects].sort((left, right) => left - right),
    );
    expect([...report.locIds]).toEqual(expect.arrayContaining([...SOL_BOUNDARY_LOC_IDS]));
    expect(report.npcIds).toContain(12823);
    expect(report.npcIds).toContain(12825);
    for (const id of [10821, 10822, 10823, 10824, 10827, 10828]) expect(report.seqIds).toContain(id);
  });

  it('reads nested spotanim dictionaries without treating comments or identifier digits as IDs', async () => {
    writeSrc(
      'effects.ts',
      `export const TEST_SPOTANIMS = {
      first: [100, 101], nested: { second: 102 },
      // 999 is not an asset
      referenced: SpotAnimID.VFX_DUST_01,
    } as const;`,
    );
    const report = await discoverCacheUsage(root);
    expect([...report.spotAnimIds]).toEqual([100, 101, 102]);
  });
  it('discovers restored Inferno models and melee frames from the actual declarations', async () => {
    writeSrc('npcs/inferno/constants.ts', readFileSync('src/npcs/inferno/constants.ts', 'utf8'));

    const report = await discoverCacheUsage(root);

    for (const id of [1377, 131, 659]) expect(report.spotAnimIds).toContain(id);
    for (const id of [7604, 7612]) expect(report.seqIds).toContain(id);
  });
  it('discovers explicit Inferno visual-event assets when only the preload array declares them', async () => {
    writeSrc(
      'npcs/inferno/constants.ts',
      'export const INFERNO_SPOT_ANIM_IDS = [1375, 1376, 448, 449, 450, 660, 444, 451] as const;',
    );

    const report = await discoverCacheUsage(root);

    expect([...report.spotAnimIds].sort((left, right) => left - right)).toEqual([
      444, 448, 449, 450, 451, 660, 1375, 1376,
    ]);
  });

  it('extracts NPC ids from *_NPC_ID constants and inline npcTypeId/npcId literals', async () => {
    writeSrc(
      'encounter/yamaConsts.ts',
      `
      export const YAMA_NPC_ID = 14176;
      export const VOID_FLARE_NPC_ID = 14179;
    `,
    );
    writeSrc(
      'encounter/lobbyConfig.ts',
      `
      export const lobbyMeta = [
        { npcTypeId: 10835, name: 'A' },
        { npcTypeId: 12345, name: 'B' },
      ];
    `,
    );
    writeSrc(
      'actor/spawn.ts',
      `
      function spawn() { actors.push({ npcId: 9999, hp: 1 }); }
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.npcIds].sort((a, b) => a - b)).toEqual([9999, 10835, 12345, 14176, 14179]);
  });

  it('extracts spotanim ids from spotAnimId literals and *_SPOTANIM_ID constants', async () => {
    writeSrc(
      'vfx/a.ts',
      `
      const SHADOW_SPIKE_SPOTANIM_ID = 3261;
      engine.queue({ spotAnimId: 1852, tick: 0 });
      engine.queue({ spotAnimId: 111 });
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.spotAnimIds].sort((a, b) => a - b)).toEqual([111, 1852, 3261]);
  });

  it('extracts manual weapon attack animations and projectile spotanims', async () => {
    writeSrc(
      'combat/manualWeaponVisuals.ts',
      `
      export const visuals = {
        attackAnimation: 11057,
        projectileId: 2795,
      };
    `,
    );

    const report = await discoverCacheUsage(root);

    expect(report.seqIds).toContain(11057);
    expect(report.spotAnimIds).toContain(2795);
  });

  it('extracts sprite ids from loadIntoIndexedSprite calls and *_SPRITE_ID constants', async () => {
    writeSrc(
      'cache/init.ts',
      `
      SpriteLoader.loadIntoIndexedSprite(spritesIndex, 511);
      SpriteLoader.loadIntoIndexedSprite(idx, 42);
    `,
    );
    writeSrc('hud/icon.ts', `export const HUD_ICON_SPRITE_ID = 7;`);

    const report = await discoverCacheUsage(root);

    expect([...report.spriteIds].sort((a, b) => a - b)).toEqual([7, 42, 511]);
  });

  it('extracts map squares from *_MAP_X / *_MAP_Y pairs and inline literals', async () => {
    writeSrc(
      'lobby/coords.ts',
      `
      export const LOBBY_MAP_X = 25;
      export const LOBBY_MAP_Y = 73;
    `,
    );
    writeSrc(
      'arena/coords.ts',
      `
      export const YAMA_MAP_X = 23;
      export const YAMA_MAP_Y = 157;
    `,
    );
    writeSrc(
      'encounters/registry.ts',
      `
      registry.set('foo', { mapSquare: { x: 50, y: 50 } });
    `,
    );
    writeSrc(
      'init/main.ts',
      `
      await loadMapSquare(99, 99, key);
      await loadAdditionalMapSquare(11, 22, key);
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.mapSquares].sort()).toEqual(['11,22', '23,157', '25,73', '50,50', '99,99']);
  });

  it('extracts an encounter descriptor mapSquare so terrain cache deps stay automatic', async () => {
    writeSrc(
      'core/encounters/encounterFactory.ts',
      `
      encounterRegistry.register('test_boss', () => new TestBossEncounter(), {
        kind: 'test_boss',
        mapSquare: { x: 28, y: 48 },
      });
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.mapSquares]).toEqual(['28,48']);
  });

  it('only pairs *_MAP_X with matching *_MAP_Y base name', async () => {
    writeSrc(
      'coords.ts',
      `
      export const ALPHA_MAP_X = 1;
      export const ALPHA_MAP_Y = 2;
      export const BETA_MAP_X = 3;
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.mapSquares].sort()).toEqual(['1,2']);
  });

  it('extracts seq ids from *_SEQ_ID constants and lowercase-prefix SeqId fields', async () => {
    writeSrc(
      'anim/yama.ts',
      `
      export const PLAYER_INTRO_ANIM_SEQ_ID = 12152;
      export const renderConfig = {
        idleSeqId: 12133,
        deathSeqId: 12134,
        animationSeqId: 12152,
      };
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.seqIds].sort((a, b) => a - b)).toEqual([12133, 12134, 12152]);
  });

  it('extracts spell visual animation and spotanim ids from SPELL_VISUALS fields', async () => {
    writeSrc(
      'data/spellVisuals.ts',
      `
      export const SPELL_VISUALS = {
        'Dark Demonbane': {
          castAnimationId: 8977,
          fallbackAnimationId: 1162,
          castSpotanimId: 1869,
          hitSpotanimId: 1870,
        },
      };
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.seqIds].sort((a, b) => a - b)).toEqual([1162, 8977]);
    expect([...report.spotAnimIds].sort((a, b) => a - b)).toEqual([1869, 1870]);
  });

  it('extracts generic animationId fields used by self-cast events', async () => {
    writeSrc(
      'core/SimulationEngine.ts',
      `
      events.emit({ type: 'spell_self_cast', animationId: 8970, spotAnimId: 1852 });
      events.emit({ type: 'spell_self_cast', animationId: 714, spotAnimId: 111 });
      specials.emit({ animationId: 7514, graphicId: 1171 });
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.seqIds].sort((a, b) => a - b)).toEqual([714, 7514, 8970]);
    expect([...report.spotAnimIds].sort((a, b) => a - b)).toEqual([111, 1171, 1852]);
  });

  it('seqFieldLit does NOT match upper-case _SEQ_ID: field-style false positives', async () => {
    writeSrc(
      'rec.ts',
      `
      const map = { _SEQ_ID: 9001 };
      const rec = { walkSeqId: 5 };
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.seqIds]).toContain(5);
    expect([...report.seqIds]).not.toContain(9001);
  });

  it('extracts item ids from *_ITEM_ID constants and inline itemId literals', async () => {
    writeSrc(
      'items.ts',
      `
      export const PURGING_STAFF_ITEM_ID = 29594;
      const list = [{ itemId: 27641 }, { itemId: 2446 }];
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.itemIds].sort((a, b) => a - b)).toEqual([2446, 27641, 29594]);
  });

  it('extracts loc ids from *_LOC_ID constants and *_LOC_IDS array constants', async () => {
    writeSrc('encounter/pool.ts', `export const TEST_POOL_LOC_ID = 50746;`);
    writeSrc(
      'encounter/shieldWall.ts',
      `export const SHIELD_COMBATANT_LOC_IDS = [50753, 50754, 50755, 50756, 50757, 50758] as const;`,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.locIds].sort((a, b) => a - b)).toEqual([50746, 50753, 50754, 50755, 50756, 50757, 50758]);
  });

  it('skips files in __tests__, __mocks__, generated, and *.test.ts / *.d.ts', async () => {
    writeSrc('a/__tests__/skip.ts', `const SKIP_NPC_ID = 11111;`);
    writeSrc('a/__mocks__/skip.ts', `const MOCK_NPC_ID = 22222;`);
    writeSrc('a/generated/auto.ts', `const GEN_NPC_ID = 33333;`);
    writeSrc('a/foo.test.ts', `const TEST_NPC_ID = 44444;`);
    writeSrc('a/foo.d.ts', `declare const DECL_NPC_ID = 55555;`);
    writeSrc('a/keep.ts', `const KEEP_NPC_ID = 7;`);

    const report = await discoverCacheUsage(root);

    expect([...report.npcIds]).toEqual([7]);
  });

  it('skips non-.ts/.tsx files', async () => {
    writeSrc('a/data.json', `{"npcTypeId": 99999}`);
    writeSrc('a/code.ts', `const REAL_NPC_ID = 1;`);

    const report = await discoverCacheUsage(root);

    expect([...report.npcIds]).toEqual([1]);
  });

  it('reports filesScanned and counts consistently with the result sets', async () => {
    writeSrc('a.ts', `const A_NPC_ID = 1;`);
    writeSrc('b.tsx', `const B_NPC_ID = 2;`);

    const report = await discoverCacheUsage(root);

    expect(report.filesScanned).toBe(2);
    expect(report.counts.npcIds).toBe(report.npcIds.size);
    expect(report.counts.spotAnimIds).toBe(report.spotAnimIds.size);
    expect(report.counts.spriteIds).toBe(report.spriteIds.size);
    expect(report.counts.seqIds).toBe(report.seqIds.size);
    expect(report.counts.itemIds).toBe(report.itemIds.size);
    expect(report.counts.mapSquares).toBe(report.mapSquares.size);
    expect(report.counts.locIds).toBe(report.locIds.size);
  });

  it('returns empty sets when src/ is empty', async () => {
    const report = await discoverCacheUsage(root);

    expect(report.filesScanned).toBe(0);
    expect(report.npcIds.size).toBe(0);
    expect(report.spotAnimIds.size).toBe(0);
    expect(report.spriteIds.size).toBe(0);
    expect(report.seqIds.size).toBe(0);
    expect(report.itemIds.size).toBe(0);
    expect(report.mapSquares.size).toBe(0);
    expect(report.locIds.size).toBe(0);
  });

  it('deduplicates ids that appear via multiple patterns', async () => {
    writeSrc(
      'npc.ts',
      `
      export const SOMETHING_NPC_ID = 14176;
      const meta = { npcTypeId: 14176 };
      const spawn = { npcId: 14176 };
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.npcIds]).toEqual([14176]);
  });

  it('extracts spotanim ids from *_GRAPHIC constants but not Z_ z-order constants', async () => {
    writeSrc(
      'render/zukAssets.ts',
      `
      export const ZUK_BLAST_GRAPHIC = 1375;
      export const ZUK_HEAL_IMPACT_GRAPHIC = 444;
      const Z_PLAYER_GRAPHIC = 72;
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.spotAnimIds].sort((a, b) => a - b)).toEqual([444, 1375]);
  });

  it('extracts spotanim ids from array-valued *_GRAPHICS / *_SPOTANIM_IDS constants', async () => {
    writeSrc(
      'render/zukAssets.ts',
      `
      export const ZUK_JAD_MAGIC_GRAPHICS = [448, 449, 450] as const;
      export const EXTRA_SPOTANIM_IDS: readonly number[] = [9001, 9002];
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.spotAnimIds].sort((a, b) => a - b)).toEqual([448, 449, 450, 9001, 9002]);
  });

  it('ignores digits inside enum member names listed in a *_SPOTANIM_IDS array', async () => {
    writeSrc(
      'render/testVfxTypes.ts',
      `
      export const TEST_SPOTANIM_IDS = [
        SpotAnimID.VFX_COLOSSI_STAB_DUST_01,
        ...TEST_SLAM_VFX_SPOTANIM_IDS,
      ] as const;
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.spotAnimIds]).toEqual([]);
  });

  it('extracts seq ids from *_SEQ constants without the _ID suffix', async () => {
    writeSrc('render/renderConfig.ts', `const ZUK_YT_HURKOT_DEATH_SEQ = 2638;`);

    const report = await discoverCacheUsage(root);

    expect([...report.seqIds]).toEqual([2638]);
  });

  it('extracts seq ids from *_ANIM_ID constants, and reads *_SPOTANIM_ID as a spotanim', async () => {
    writeSrc(
      'core/SimulationEngine.ts',
      `
      const SELF_IMBUE_CAST_ANIM_ID = 8970;
      const YAMA_INTRO_ANIMATION = 12152;
      const DEATH_CHARGE_SPOTANIM_ID = 1854;
      const SATURATED_HEART_SPOTANIM = 2287;
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.seqIds].sort((a, b) => a - b)).toEqual([8970, 12152]);
    expect([...report.spotAnimIds].sort((a, b) => a - b)).toEqual([1854, 2287]);
  });

  it('extracts every seq id from a nested *_SEQS animation table', async () => {
    writeSrc(
      'encounters/zuk/constants.ts',
      `
      export const ZUK_SEQS = {
        zuk: { idle: 7564, spawn: 7563, attack: 7566 },
        shield: { idle: 7567, hit: 7568, death: 7569 },
      } as const;
      export const UNRELATED = 4242;
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.seqIds].sort((a, b) => a - b)).toEqual([7563, 7564, 7566, 7567, 7568, 7569]);
  });

  it('extracts loc ids from sourceLocId / targetLocId object fields', async () => {
    writeSrc(
      'encounters/zuk/renderConfig.ts',
      `
      const REPLACEMENTS = [
        { localX: 27, localY: 52, sourceLocId: 30333, targetLocId: 30340, targetRotation: 1 },
      ];
    `,
    );

    const report = await discoverCacheUsage(root);

    expect([...report.locIds].sort((a, b) => a - b)).toEqual([30333, 30340]);
  });

  it('extracts rune item ids from RUNE / COMBINATION_RUNE / *_RUNE_SOURCES tables', async () => {
    writeSrc(
      'data/spellRunes.ts',
      `
      export const RUNE = { fire: 554, water: 555 } as const;
      export const COMBINATION_RUNE = { steam: 4694 } as const;
      export const UNLIMITED_RUNE_SOURCES = {
        1381: [RUNE.air],
        30064: [RUNE.earth],
      };
    `,
    );

    const report = await discoverCacheUsage(root);

    // Runes are not equippable, so equipment.json never covers them - they reach the
    // trimmer only through these tables.
    expect([...report.itemIds].sort((a, b) => a - b)).toEqual([554, 555, 1381, 4694, 30064]);
  });
});

describe('parseMapSquare', () => {
  it('parses "x,y" into a [x, y] tuple of numbers', () => {
    expect(parseMapSquare('23,157')).toEqual([23, 157]);
    expect(parseMapSquare('0,0')).toEqual([0, 0]);
    expect(parseMapSquare('25,73')).toEqual([25, 73]);
  });
});

describe('computeTraceSpecHash', () => {
  it.each([
    'data/weaponCombatVisuals.ts',
    'data/equipmentCombatFamilies.ts',
    'rs/model/PlayerModelLoader.ts',
  ])('changes when %s changes without scanner-visible ids', async (file) => {
    writeSrc(file, 'export const pairs = { 25888: [1929, 1928] };');
    const before = await computeTraceSpecHash(root);

    writeSrc(file, 'export const pairs = { 25888: [1888, 1887] };');
    const after = await computeTraceSpecHash(root);

    expect(after).not.toBe(before);
  });

  it.each([
    ['cast animation', 'standardSpell(123456, [90, 91, 92])'],
    ['cast spotanim', 'standardSpell(1162, [123456, 91, 92])'],
    ['projectile', 'standardSpell(1162, [90, 123456, 92])'],
    ['hit spotanim', 'standardSpell(1162, [90, 91, 123456])'],
  ])('changes when a spell visual helper %s argument changes', async (_asset, changedCall) => {
    writeSrc(
      'data/spellVisuals.ts',
      `export const SPELL_VISUALS = { 'Wind Strike': standardSpell(1162, [90, 91, 92]) };`,
    );
    const usageBefore = await discoverCacheUsage(root);
    const hashBefore = await computeTraceSpecHash(root);

    writeSrc('data/spellVisuals.ts', `export const SPELL_VISUALS = { 'Wind Strike': ${changedCall} };`);
    const hashAfter = await computeTraceSpecHash(root);

    expect(await discoverCacheUsage(root)).toEqual(usageBefore);
    expect(hashAfter).not.toBe(hashBefore);
  });

  it('is a deterministic 64-char sha256 for the same source tree', async () => {
    writeSrc('a.ts', `export const FOO_LOC_ID = 50753;`);

    const h1 = await computeTraceSpecHash(root);
    const h2 = await computeTraceSpecHash(root);

    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it('changes when a new cache dependency is declared (the shields case)', async () => {
    writeSrc('a.ts', `export const FOO_LOC_ID = 50753;`);
    const before = await computeTraceSpecHash(root);

    writeSrc('b.ts', `export const SHIELD_COMBATANT_LOC_IDS = [50754, 50755] as const;`);
    const after = await computeTraceSpecHash(root);

    expect(after).not.toBe(before);
  });

  it('changes when a direct trace-input data file changes (equipment catalog)', async () => {
    writeSrc('a.ts', `export const FOO_NPC_ID = 12821;`);
    writeSrc('data/osrs/equipment.json', '[{"ids":[1]}]');
    const before = await computeTraceSpecHash(root);

    writeSrc('data/osrs/equipment.json', '[{"ids":[1,2]}]');
    const after = await computeTraceSpecHash(root);

    expect(after).not.toBe(before);
  });

  it('is unaffected by source edits that add no cache dependency', async () => {
    writeSrc('a.ts', `export const FOO_LOC_ID = 50753;`);
    const before = await computeTraceSpecHash(root);

    writeSrc('unrelated.ts', `export const greeting = 'hello world';`);
    const after = await computeTraceSpecHash(root);

    expect(after).toBe(before);
  });

  it('changes when an encounter render config changes (plain-key attackClips)', async () => {
    writeSrc('a.ts', `export const FOO_LOC_ID = 50753;`);
    // trim-cache warms each render config's attackClips directly. Their keys are plain words
    // (`default`, `melee`), so a changed clip id moves no scanner-derived id and the fingerprint
    // must cover the file by content or the mirror ships a stale trim.
    writeSrc('encounters/yamaP3/renderConfig.ts', `export const C = { attackClips: { default: 12144 } };`);
    const before = await computeTraceSpecHash(root);

    writeSrc('encounters/yamaP3/renderConfig.ts', `export const C = { attackClips: { default: 12145 } };`);
    const after = await computeTraceSpecHash(root);

    expect(after).not.toBe(before);
  });

  // trim-cache pulls each droppable item's `inventoryModel` from collectItemIconIds and its
  // sources, which carry their ids as bare object keys or `{ id: N }` slots that no scanner
  // pattern sees. An edit there that moves no scanner-derived id must still force a re-trim,
  // or the newly droppable item is invisible on the mirror while fine in dev.
  it.each([
    ['data/itemIconIds.ts', `export const X = 1;`, `export const X = 2;`],
    ['data/inventoryItemCatalog.ts', `export const NAMES = { 385: 'Shark' };`, `export const NAMES = { 229: 'Vial' };`],
    ['data/itemEffects.ts', `export const ITEM_ACTIONS = { 13441: {} };`, `export const ITEM_ACTIONS = { 385: {} };`],
    ['data/customEquipmentPresets.ts', `export const SLOTS = ['cape'];`, `export const SLOTS = ['cape', 'ring'];`],
    ['data/playerPresets.ts', `export const P = [{ id: 11212 }];`, `export const P = [{ id: 11212 }, { id: 385 }];`],
    ['data/infoboxItemIds.ts', `export const IDS = { a: 385 };`, `export const IDS = { a: 386 };`],
  ])('changes when %s changes (ground-item model trace)', async (rel, before, after) => {
    writeSrc('a.ts', `export const FOO_LOC_ID = 50753;`);
    writeSrc(rel, before);
    const hashBefore = await computeTraceSpecHash(root);

    writeSrc(rel, after);

    expect(await computeTraceSpecHash(root)).not.toBe(hashBefore);
  });

  it('changes when a special-attack graphic changes (trimmer reads the registry directly)', async () => {
    writeSrc('a.ts', `export const FOO_LOC_ID = 50753;`);
    // collectCacheRoots reads `targetGraphicBySize` arrays, which no scanner pattern sees.
    const rel = 'core/combat/player/specialAttacks/registry.ts';
    writeSrc(rel, `export const R = { 1: { onKillEffect: { targetGraphicBySize: [100, 101] } } };`);
    const before = await computeTraceSpecHash(root);

    writeSrc(rel, `export const R = { 1: { onKillEffect: { targetGraphicBySize: [100, 102] } } };`);

    expect(await computeTraceSpecHash(root)).not.toBe(before);
  });

  it('changes when the SpotAnimID table changes (trimmer traces every entry)', async () => {
    writeSrc('a.ts', `export const FOO_LOC_ID = 50753;`);
    // trim-cache traces every Object.values(SpotAnimID); the entries match no id pattern,
    // so the fingerprint must cover the file by content.
    writeSrc('rs/config/spotanimtype/SpotAnimID.ts', `export const SpotAnimID = { VFX_A: 100 } as const;`);
    const before = await computeTraceSpecHash(root);

    writeSrc('rs/config/spotanimtype/SpotAnimID.ts', `export const SpotAnimID = { VFX_A: 100, VFX_B: 101 } as const;`);
    const after = await computeTraceSpecHash(root);

    expect(after).not.toBe(before);
  });
});
