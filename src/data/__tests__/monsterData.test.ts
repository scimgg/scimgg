import { describe, expect, it } from 'vitest';
import { collectCacheRoots } from '../../../scripts/cacheRoots';
import { discoverCacheUsage } from '../../../scripts/discoverCacheUsage';
import { applyMonsterStatOverrideToFormulaStats, getMonsterFormulaStats, getMonsterName } from '../monsterData';
import monsters from '../osrs/monsters.json';

/** NPCs the simulator spawns that have no Wiki monster infobox, so no `monsters.json` entry. */
const WITHOUT_WIKI_ENTRY: Readonly<Record<number, string>> = {
  0: 'no NPC: the placeholder sweep target in playerEffectDescriptors.ts',
  7707: 'Ancestral Glyph',
  7709: 'Rocky support',
  7710: 'Rocky support',
  12823: 'Bee Swarm',
  12824: 'unnamed Colosseum NPC',
  12826: 'unnamed Colosseum NPC',
  12827: 'Sol Heredit, seated',
};

describe('monsterData', () => {
  it.each([
    [7706, 'TzKal-Zuk'],
    [7703, 'Jal-Zek'],
    [7702, 'Jal-Xil'],
    [7704, 'JalTok-Jad'],
    [7705, 'Yt-HurKot'],
    [14176, 'Yama'],
  ])('returns the monster name when NPC id %i is known', (npcId, name) => {
    const result = getMonsterName(npcId);

    expect(result).toBe(name);
  });

  it('returns undefined when the monster name has an unknown NPC id', () => {
    const result = getMonsterName(-1);

    expect(result).toBeUndefined();
  });

  // monsters.json is trimmed to the simulator's NPCs (scripts/sync-osrs-data.ts filters by the
  // cache roots), so a newly referenced NPC needs a re-sync, not just a new id.
  it('carries an entry for every NPC the simulator can spawn, and for no other monster', async () => {
    const npcIds = collectCacheRoots(await discoverCacheUsage(process.cwd())).npcs;

    expect([...npcIds.keys()].filter((id) => !(id in WITHOUT_WIKI_ENTRY) && getMonsterName(id) === undefined)).toEqual(
      [],
    );
    expect(Object.keys(WITHOUT_WIKI_ENTRY).filter((id) => getMonsterName(Number(id)) !== undefined)).toEqual([]);
    expect(monsters.filter((m) => !m.ids.some((id) => npcIds.has(id))).map((m) => m.name)).toEqual([]);
  });

  it('selects versioned formula stats explicitly for duplicate NPC ids', () => {
    expect(getMonsterFormulaStats(14176, 'Phase 3')?.defensive).toEqual({
      stab: 135,
      slash: 108,
      crush: 449,
      rangedLight: 449,
      rangedStandard: 297,
      rangedHeavy: 449,
      magic: 81,
    });
  });

  it('applies every ranged defence an encounter override names, keeping the rest from the dataset', () => {
    const base = getMonsterFormulaStats(14176, 'Phase 3');

    const restatted = applyMonsterStatOverrideToFormulaStats(base, {
      defensive: { light: 1, heavy: 3 },
      skills: { def: 247 },
    });

    expect(restatted?.defensive).toEqual({
      stab: 135,
      slash: 108,
      crush: 449,
      rangedLight: 1,
      rangedStandard: 297,
      rangedHeavy: 3,
      magic: 81,
    });
    expect(restatted?.levels.defence).toBe(247);
    expect(applyMonsterStatOverrideToFormulaStats(base, { defensive: { standard: 2 } })?.defensive).toMatchObject({
      rangedLight: 449,
      rangedStandard: 2,
      rangedHeavy: 449,
    });
  });

  it('carries the elemental weakness through an encounter restat, and omits it for a monster without one', () => {
    const restatted = applyMonsterStatOverrideToFormulaStats(getMonsterFormulaStats(14176, 'Phase 3'), {
      skills: { def: 247, magic: 1 },
      defensive: { magic: 0 },
    });

    expect(restatted?.elementalWeakness).toEqual({ element: 'water', percent: 50 });
    expect(getMonsterFormulaStats(12821)).not.toHaveProperty('elementalWeakness');
  });
});
