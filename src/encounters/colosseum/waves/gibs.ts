import type { NpcActor } from '../../../core/actors/NpcActor';
import { createNpcDefinition, type DefinedNpcActor } from '../../../core/npcs';
import type { Coordinate } from '../../../types/simulation';
import { VOLATILITY_GIB_LIFETIME_TICKS, type VolatilityGib } from '../modifiers/volatility';

export const VOLATILITY_GIB_ACTOR_PREFIX = 'colosseum_gib';

/** Cache sizes of 12828-12831 (human 1; manticore, minotaur and colossi 3; facts spec NPC ids). */
const GIB_SIZES: Readonly<Record<number, number>> = { 12828: 1, 12829: 3, 12830: 3, 12831: 3 };

type GibState = { readonly removeAt: number };
export type VolatilityGibActor = DefinedNpcActor<GibState>;

/** The non-interactable leftover a Volatility death adds; it never moves or acts. */
export const volatilityGibDefinition = createNpcDefinition<GibState, undefined>({
  id: 'colosseum-volatility-gib',
  move: false,
});

export function createVolatilityGib(input: {
  readonly id: string;
  readonly gib: VolatilityGib;
  readonly position: Readonly<Coordinate>;
  readonly tick: number;
}): VolatilityGibActor {
  const actor: NpcActor = {
    id: input.id,
    kind: 'npc',
    npcTypeId: input.gib.npcTypeId,
    archetypeId: 'colosseum_volatility_gib',
    role: 'npc',
    size: GIB_SIZES[input.gib.npcTypeId] ?? 1,
    alive: true,
    position: [...input.position],
    previousPosition: [...input.position],
    facing: 0,
    spawnTick: input.tick,
    blocksNpcMovement: false,
    passThruNpcs: true,
    vitals: { hp: 1, maxHp: 1 },
    history: new Map(),
    formulaStats: {
      levels: { attack: 1, strength: 1, defence: 1, ranged: 1, magic: 1 },
      offensive: { atk: 0, ranged: 0, magic: 0, str: 0, rangedStr: 0, magicStr: 0 },
      defensive: { stab: 0, slash: 0, crush: 0, rangedLight: 0, rangedStandard: 0, rangedHeavy: 0, magic: 0 },
      attributes: [],
    },
    combat: {
      attackSpeed: 1,
      attackRange: 0,
      attackStyle: 'typeless',
      nextActionTick: 0,
      targetId: null,
      lastAttackTick: null,
      animations: { idle: input.gib.sequenceId, walk: null, run: null, attack: null, death: null },
    },
  };
  return volatilityGibDefinition.createActor(actor, { removeAt: input.tick + VOLATILITY_GIB_LIFETIME_TICKS });
}
