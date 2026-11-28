import type { NpcBurnImmunity, NpcFormulaStats } from '../core/actors/types';
import type { MonsterStatOverride } from '../types/monsterStatOverride';
import monstersJson from './osrs/monsters.json';
import type { SpellElement } from './spellCatalog';

interface MonsterEntry {
  readonly ids: readonly number[];
  readonly name: string;
  readonly version?: string;
  readonly levels: {
    hitpoints: number;
    attack: number;
    defence: number;
    strength: number;
    magic: number;
    ranged: number;
  };
  readonly offensive: {
    attack: number;
    magic: number;
    magicDamage: number;
    ranged: number;
    rangedStrength: number;
    strength: number;
  };
  readonly defensive: {
    stab: number;
    slash: number;
    crush: number;
    magic: number;
    ranged: number;
    rangedLight: number;
    rangedStandard: number;
    rangedHeavy: number;
    flatArmour: number;
  };
  readonly immunities: {
    burn: NpcBurnImmunity | null;
    poison: number;
    freeze: number;
  };
  readonly attributes: readonly string[];
  readonly elementalWeakness?: { readonly element: SpellElement; readonly percent: number };
}

const monsters = monstersJson as MonsterEntry[];

const monsterById = new Map<number, MonsterEntry>();
const monsterByIdAndVersion = new Map<string, MonsterEntry>();
for (const m of monsters) {
  for (const id of m.ids) {
    if (!monsterById.has(id)) monsterById.set(id, m);
    if (m.version !== undefined) monsterByIdAndVersion.set(`${id}:${m.version}`, m);
  }
}

export function getMonsterName(npcId: number): string | undefined {
  return monsterById.get(npcId)?.name;
}

export function getMonsterHp(npcId: number): number | undefined {
  return monsterById.get(npcId)?.levels.hitpoints;
}

export function getMonsterFormulaStats(
  npcId: number,
  variant?: string | { readonly hitpoints: number },
): NpcFormulaStats | undefined {
  // Some infoboxes reuse both the NPC id and the version anchor across forms.
  const m =
    typeof variant === 'object'
      ? monsters.find((entry) => entry.levels.hitpoints === variant.hitpoints && entry.ids.includes(npcId))
      : variant === undefined
        ? monsterById.get(npcId)
        : monsterByIdAndVersion.get(`${npcId}:${variant}`);
  if (!m) return undefined;

  return {
    burnImmunity: m.immunities.burn,
    freezeResistance: m.immunities.freeze,
    poisonResistance: m.immunities.poison,
    attributes: m.attributes,
    ...(m.elementalWeakness === undefined ? {} : { elementalWeakness: m.elementalWeakness }),
    levels: {
      attack: m.levels.attack,
      strength: m.levels.strength,
      defence: m.levels.defence,
      ranged: m.levels.ranged,
      magic: m.levels.magic,
    },
    offensive: {
      atk: m.offensive.attack,
      ranged: m.offensive.ranged,
      magic: m.offensive.magic,
      str: m.offensive.strength,
      rangedStr: m.offensive.rangedStrength,
      magicStr: m.offensive.magicDamage,
    },
    defensive: {
      stab: m.defensive.stab,
      slash: m.defensive.slash,
      crush: m.defensive.crush,
      rangedLight: m.defensive.rangedLight,
      rangedStandard: m.defensive.rangedStandard,
      rangedHeavy: m.defensive.rangedHeavy,
      magic: m.defensive.magic,
    },
  };
}

/**
 * Fold an encounter's {@link MonsterStatOverride} into an actor's formula stats, so the
 * restat reaches percentage defence drains, player projections, and NPC-vs-NPC rolls from
 * one actor-owned baseline.
 *
 * `flat_armour` has no `NpcFormulaStats` counterpart and is dropped.
 * `skills.hp` is dropped too: an actor's hitpoints come from the encounter configuration.
 */
export function applyMonsterStatOverrideToFormulaStats(
  base: NpcFormulaStats | undefined,
  override: MonsterStatOverride | undefined,
): NpcFormulaStats | undefined {
  if (!base || !override) return base;
  const { skills, defensive } = override;
  return {
    ...base,
    levels: {
      attack: skills?.atk ?? base.levels.attack,
      strength: skills?.str ?? base.levels.strength,
      defence: skills?.def ?? base.levels.defence,
      ranged: skills?.ranged ?? base.levels.ranged,
      magic: skills?.magic ?? base.levels.magic,
    },
    defensive: {
      stab: defensive?.stab ?? base.defensive.stab,
      slash: defensive?.slash ?? base.defensive.slash,
      crush: defensive?.crush ?? base.defensive.crush,
      rangedLight: defensive?.light ?? base.defensive.rangedLight,
      rangedStandard: defensive?.standard ?? base.defensive.rangedStandard,
      rangedHeavy: defensive?.heavy ?? base.defensive.rangedHeavy,
      magic: defensive?.magic ?? base.defensive.magic,
    },
  };
}
