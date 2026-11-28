import { afterEach, describe, expect, it } from 'vitest';
import type { NpcActor } from '../../../core/actors/NpcActor';
import { NpcDefinitionCollection } from '../../../core/npcs';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { LobbyEncounter } from '../../../encounters/lobby/LobbyEncounter';
import { createJaguarWarrior, jaguarWarriorDefinition } from '../jaguarWarrior';
import { createJavelinColossus, javelinColossusDefinition } from '../javelinColossus';
import { createManticore, manticoreDefinition } from '../manticore';
import { createMinotaur, minotaurDefinition } from '../minotaur';
import { createSerpentShaman, serpentShamanDefinition } from '../serpentShaman';
import { createShockwaveColossus, shockwaveColossusDefinition } from '../shockwaveColossus';
import { createWarbander, warbanderDefinition } from '../warband';
import { resetArena } from './colossusReachHarness';

afterEach(resetArena);

const SPAWN_TICK = 0;

class WaveSpeciesEncounter extends LobbyEncounter {
  private readonly definitions = new NpcDefinitionCollection([
    warbanderDefinition.register(undefined),
    serpentShamanDefinition.register(undefined),
    javelinColossusDefinition.register(undefined),
    manticoreDefinition.register(undefined),
    shockwaveColossusDefinition.register(undefined),
    jaguarWarriorDefinition.register(undefined),
    minotaurDefinition.register(undefined),
  ]);

  constructor(private readonly npcs: readonly NpcActor[]) {
    super();
  }

  override createNpcs(): NpcActor[] {
    return [...this.npcs];
  }

  getNpcDefinitions(): NpcDefinitionCollection {
    return this.definitions;
  }
}

function snapshotOf(npcs: readonly NpcActor[]) {
  const engine = new SimulationEngine({ encounter: new WaveSpeciesEncounter(npcs), startPos: [5, 5] });
  return new Map(engine.getState().npcs.map((npc) => [npc.id, npc]));
}

describe('wave species in the snapshot', () => {
  it('are minions, so they get the default true-tile highlights, Red Flag minotaur included', () => {
    const spawn = (id: string, x: number) => ({ id, position: [x, 40] as const, spawnTick: SPAWN_TICK });
    const npcs = [
      createWarbander({ ...spawn('warbander', 10), role: 'seer', slotOffset: [0, 0] }),
      createSerpentShaman(spawn('shaman', 14)),
      createJavelinColossus(spawn('javelin', 18)),
      createManticore({ ...spawn('manticore', 22), firstStyle: 'magic' }),
      createShockwaveColossus(spawn('shockwave', 26)),
      createJaguarWarrior(spawn('jaguar', 30)),
      createMinotaur(spawn('minotaur', 34)),
      createMinotaur({ ...spawn('redFlagMinotaur', 38), routefinding: true }),
    ];
    const snapshot = snapshotOf(npcs);
    expect(Object.fromEntries([...snapshot].map(([id, npc]) => [id, npc.role]))).toEqual(
      Object.fromEntries(npcs.map((npc) => [npc.id, 'minion'])),
    );
  });

  it('project the shaman, jaguar and minotaur first action at spawn+3 from the combat clock', () => {
    const spawn = (id: string, x: number) => ({ id, position: [x, 40] as const, spawnTick: SPAWN_TICK });
    const snapshot = snapshotOf([
      createSerpentShaman(spawn('shaman', 14)),
      createJaguarWarrior(spawn('jaguar', 30)),
      createMinotaur(spawn('minotaur', 34)),
    ]);
    for (const id of ['shaman', 'jaguar', 'minotaur']) {
      expect(snapshot.get(id)?.attackTimer, id).toEqual({ nextAttackTick: SPAWN_TICK + 3, attackSpeed: 5 });
    }
  });
});
