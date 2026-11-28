import type { NpcActor } from '../../../core/actors/NpcActor';
import type { NpcDefinitionRegistration } from '../../../core/npcs';
import type { ColosseumRelentlessRank } from '../../../npcs/colosseum/constants';
import {
  createJaguarWarrior,
  JAGUAR_WARRIOR_REMOVAL_DELAY_TICKS,
  jaguarWarriorDefinition,
} from '../../../npcs/colosseum/jaguarWarrior';
import {
  createJavelinColossus,
  JAVELIN_DEATH_TO_REMOVAL_TICKS,
  javelinColossusDefinition,
} from '../../../npcs/colosseum/javelinColossus';
import {
  createManticore,
  MANTICORE_DEATH_TO_REMOVAL_TICKS,
  type ManticoreFirstStyle,
  manticoreDefinition,
} from '../../../npcs/colosseum/manticore';
import { createMinotaur, MINOTAUR_REMOVAL_DELAY_TICKS, minotaurDefinition } from '../../../npcs/colosseum/minotaur';
import {
  createSerpentShaman,
  SERPENT_SHAMAN_REMOVAL_DELAY_TICKS,
  serpentShamanDefinition,
} from '../../../npcs/colosseum/serpentShaman';
import {
  createShockwaveColossus,
  SHOCKWAVE_DEATH_TO_REMOVAL_TICKS,
  shockwaveColossusDefinition,
} from '../../../npcs/colosseum/shockwaveColossus';
import type { Coordinate } from '../../../types/simulation';
import type { ColosseumWaveSpecies } from './waveTable';

export interface ColosseumSpeciesSpawnInput {
  readonly id: string;
  readonly position: Readonly<Coordinate>;
  readonly spawnTick: number;
  readonly relentless: ColosseumRelentlessRank;
  /** The wave's manticore order; ignored by every other species. */
  readonly manticoreFirstStyle: ManticoreFirstStyle;
  /** Red Flag is owned: minotaurs spawn as the routefinding 12813; ignored by every other species. */
  readonly redFlag: boolean;
}

/**
 * How the wave owner spawns a species. A spawn sequence (shaman, jaguar, minotaur, manticore) needs
 * no cue: it is the render config's `spawnSeqId`, played from the actor's `spawnTick`.
 */
export interface ColosseumSpecies {
  readonly create: (input: ColosseumSpeciesSpawnInput) => NpcActor;
  /** Death sequence to `del`, the wave owner's removal (facts spec, despawn table). */
  readonly removalDelayTicks: number;
  /** Damage-history label for its hits. */
  readonly damageLabel: string;
}

/** Death sequence to `del` for every warband member: 89/89 (28 berserkers, 31 seers, 30 archers). */
export const WARBAND_REMOVAL_DELAY_TICKS = 3;
export const WARBAND_DAMAGE_LABEL = 'FremennikWarbandAttack';

/** The six wave species; each lane's factory owns its behavior, this only names how to spawn it. */
export const COLOSSEUM_WAVE_SPECIES: Readonly<Record<ColosseumWaveSpecies, ColosseumSpecies>> = {
  serpentShaman: {
    create: ({ manticoreFirstStyle: _, redFlag: __, ...input }) => createSerpentShaman(input),
    removalDelayTicks: SERPENT_SHAMAN_REMOVAL_DELAY_TICKS,
    damageLabel: 'SerpentShamanAttack',
  },
  javelinColossus: {
    create: ({ manticoreFirstStyle: _, redFlag: __, ...input }) => createJavelinColossus(input),
    removalDelayTicks: JAVELIN_DEATH_TO_REMOVAL_TICKS,
    damageLabel: 'JavelinColossusAttack',
  },
  manticore: {
    create: ({ manticoreFirstStyle, redFlag: _, ...input }) =>
      createManticore({ ...input, firstStyle: manticoreFirstStyle }),
    removalDelayTicks: MANTICORE_DEATH_TO_REMOVAL_TICKS,
    damageLabel: 'ManticoreAttack',
  },
  shockwaveColossus: {
    create: ({ manticoreFirstStyle: _, redFlag: __, ...input }) => createShockwaveColossus(input),
    removalDelayTicks: SHOCKWAVE_DEATH_TO_REMOVAL_TICKS,
    damageLabel: 'ShockwaveColossusAttack',
  },
  jaguarWarrior: {
    create: ({ manticoreFirstStyle: _, redFlag: __, ...input }) => createJaguarWarrior(input),
    removalDelayTicks: JAGUAR_WARRIOR_REMOVAL_DELAY_TICKS,
    damageLabel: 'JaguarWarriorAttack',
  },
  minotaur: {
    create: ({ manticoreFirstStyle: _, redFlag, ...input }) => createMinotaur({ ...input, routefinding: redFlag }),
    removalDelayTicks: MINOTAUR_REMOVAL_DELAY_TICKS,
    damageLabel: 'MinotaurAttack',
  },
};

export function colosseumWaveSpeciesRegistrations(): NpcDefinitionRegistration[] {
  return [
    serpentShamanDefinition.register(undefined),
    javelinColossusDefinition.register(undefined),
    manticoreDefinition.register(undefined),
    shockwaveColossusDefinition.register(undefined),
    jaguarWarriorDefinition.register(undefined),
    minotaurDefinition.register(undefined),
  ];
}
