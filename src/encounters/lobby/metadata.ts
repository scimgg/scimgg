import { SOL_NPC_ID } from '../../npcs/colosseum/constants';
import { ZULRAH_RANGED_NPC_ID } from '../../npcs/zulrah/constants';

export interface PortalDefinition {
  position: [number, number];
  encounterKind: string;
  displayName: string;
  locId: number;
}

export interface LobbyBossNpcDefinition {
  actorId: `lobby-npc-${number}`;
  npcTypeId: number;
  position: [number, number];
  facingAngle: number;
  available?: boolean;
  displaySize?: number;
}

export interface LobbyEncounterCard {
  encounterKind: string;
  displayName: string;
  description: string;
}

export const LOBBY_BOSS_NPCS: LobbyBossNpcDefinition[] = [
  {
    actorId: 'lobby-npc-0',
    npcTypeId: 7706, // TzKal-Zuk
    position: [20, 30],
    facingAngle: 1712,
    available: true,
  },
  {
    actorId: 'lobby-npc-1',
    npcTypeId: 14176,
    position: [30, 36],
    facingAngle: 0,
    available: true,
  },
  {
    actorId: 'lobby-npc-2',
    npcTypeId: SOL_NPC_ID,
    // Mirrors Zuk across the north pathway, facing the lobby center.
    position: [40, 30],
    facingAngle: 336,
    available: true,
  },
  {
    actorId: 'lobby-npc-3',
    npcTypeId: ZULRAH_RANGED_NPC_ID,
    // Mirrors Yama across the lobby center, on the open south side, facing north toward the center.
    position: [30, 12],
    facingAngle: 1024,
    available: true,
  },
];

export const LOBBY_PORTALS: PortalDefinition[] = [
  {
    position: [5, 6],
    encounterKind: 'yama_p3',
    displayName: 'Yama - Phase 3',
    locId: 11833,
  },
];

export const LOBBY_NPC_ENCOUNTERS: Record<string, LobbyEncounterCard> = {
  'lobby-npc-0': {
    // The Zuk statue opens the whole Inferno, set to start at wave 69 (its retired `zuk` kind).
    encounterKind: 'zuk',
    displayName: 'The Inferno',
    description:
      'Start from any wave. Each cleared wave leads straight into the next, through to TzKal-Zuk at wave 69.',
  },
  'lobby-npc-1': {
    encounterKind: 'yama_p3',
    displayName: 'Yama (Phase 3)',
    description: 'The third and final phase of the Yama fight.',
  },
  'lobby-npc-2': {
    encounterKind: 'sol_heredit',
    displayName: 'Sol Heredit',
    description: 'The final wave of the Fortis Colosseum.',
  },
  'lobby-npc-3': {
    encounterKind: 'zulrah',
    displayName: 'Zulrah',
    description: 'Zulrah at Zul-Andra: all four rotations, with its ranged, magic, jad and tail phases.',
  },
};
