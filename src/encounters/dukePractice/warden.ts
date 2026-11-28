import type { NpcActor } from '../../core/actors/NpcActor';
import { createNpcDefinition, NpcDefinitionCollection } from '../../core/npcs';
import { getMonsterFormulaStats } from '../../data/monsterData';
import { WARDEN_SIZE, WARDEN_TILE } from './arena';
import { DUKE_ASLEEP_NPC_ID, DUKE_NPC_ID } from './constants';
import { ENRAGE_HP, VENTS_HP, WARDEN_MAX_HP } from './controls';

export const WARDEN_ID = 'rift-warden';
/** NPC type stored by replays from before the Duke models were loaded from cache. */
export const LEGACY_DUKE_TYPE_ID = -100;

export interface WardenPlan {
  openingAttackTick: number | null;
  poisonToleranceFilled: number;
  autosSinceGaze: number;
  autosUntilGas: number | null;
  basicAfterGaze: boolean;
  flaresRemaining: number;
  bileQueued: boolean;
}

const definition = createNpcDefinition<WardenPlan, undefined>({ id: WARDEN_ID, move: false });
export const wardenDefinitions = new NpcDefinitionCollection([definition.register(undefined)]);
export const getWardenPlan = definition.getState;

export function wardenCadence(hp: number): number {
  return hp <= ENRAGE_HP ? 4 : 5;
}

export function wardenGasInterval(hp: number): number {
  return hp <= ENRAGE_HP ? 3 : hp <= VENTS_HP ? 4 : 5;
}

export function createWardenPlan(openingAttackTick: number | null): WardenPlan {
  return {
    openingAttackTick,
    poisonToleranceFilled: 0,
    autosSinceGaze: 0,
    autosUntilGas: null,
    basicAfterGaze: false,
    flaresRemaining: 0,
    bileQueued: false,
  };
}

export function createWarden(hp: number): NpcActor {
  // https://oldschool.runescape.wiki/w/Duke_Sucellus#Awakened
  const formulaStats = getMonsterFormulaStats(DUKE_NPC_ID, { hitpoints: WARDEN_MAX_HP });
  if (!formulaStats) throw new TypeError('Missing Awakened Duke formula stats');

  return definition.createActor(
    {
      id: WARDEN_ID,
      kind: 'npc',
      role: 'boss',
      npcTypeId: DUKE_ASLEEP_NPC_ID,
      archetypeId: WARDEN_ID,
      position: [...WARDEN_TILE],
      previousPosition: [...WARDEN_TILE],
      size: WARDEN_SIZE,
      facing: 0,
      alive: true,
      history: new Map(),
      vitals: { hp, maxHp: WARDEN_MAX_HP },
      alwaysShowHealthBar: true,
      formulaStats: {
        ...formulaStats,
        // https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Battle_phase
        demonbaneVulnerability: 0.7,
        // https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode
        statDrainImmune: true,
        poisonResistance: 100,
        freezeResistance: 100,
      },
      combat: {
        attackSpeed: wardenCadence(hp),
        attackRange: 12,
        attackStyle: 'melee',
        targetId: null,
        nextActionTick: 0,
        lastAttackTick: null,
        animations: { idle: null, walk: null, run: null, attack: null, death: null },
      },
    },
    createWardenPlan(null),
  );
}
