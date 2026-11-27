import { isEncounterVisualEvent } from '../core/events/encounterVisual';
import type { GameEvent } from '../core/events/types';
import {
  isInfernoAbilityEvent,
  isZukAttackEvent,
  isZukDeathEvent,
  isZukGroundEffectEvent,
  isZukHitEvent,
} from '../npcs/inferno/events';
import { coordinateFrom, play, type SoundRule, silent, type TimedSound } from './EventAudioPlayer';

// Ordinary waves 1-68, both wave captures (inferno-waves-1-68, -(35ish)-to-68): each id fires on every
// tick of its owner and almost only there. NPC synths reach the player only within ~13 tiles in the
// captures; like wave 69 we play them without a distance cutoff (docs/encounters/zuk-policy.md).
const INFERNO_WAVE_SOUNDS = {
  // sound_area range 7 at the attacking nibbler, one per swing on a pillar or the player.
  nibblerAttack: 595,
  // Bare synth, delay 15, on every Jal-MejRah launch (projectile 1382).
  batAttack: 291,
  // Jal-Ak and its Mej/Ket children: synth 595 on a magic or melee launch; magic lands with 3528 and
  // ranged (no launch sound) with 3403, each delayed to the projectile's endtime.
  blobLaunch: 595,
  blobMagicImpact: 3528,
  blobRangedImpact: 3403,
  // Shared by Jal-ImKot and Yt-HurKot.
  meleerAttack: 608,
  // Hit sounds play on zero and damaging hits alike.
  smallHit: 597,
  batHit: 296,
  meleerHit: 610,
  smallDeath: 596,
  batDeath: 295,
  meleerDeath: 609,
  // sound_area range 10 at the actor's SW tile: dig-down tile, resurfaced tile, the mager.
  digDown: 1641,
  digUp: 1644,
  resurrect: 1095,
  // sound_area range 10 at the pillar's SW + (1, 1), once per collapsing pillar.
  pillarCollapse: 1021,
} as const;

/** The Inferno encounter's collapse event; the encounter owns its shape. */
function pillarCollapseSoundPosition(event: GameEvent) {
  return event.type === 'inferno_pillar_collapse' ? coordinateFrom(event.soundPosition) : undefined;
}

export const zukAudioRules: Record<string, SoundRule> = {
  encounter_visual: {
    resolve: (event) => {
      if (!isEncounterVisualEvent(event)) return silent;
      return play(
        event.graphics.flatMap((graphic): TimedSound[] =>
          graphic.spotAnimId === 659 && graphic.target.kind === 'tile'
            ? [
                {
                  id: 156,
                  delayCycles: graphic.delayCycles,
                  position: graphic.target.position,
                  range: 8,
                  channel: 'area',
                },
              ]
            : [],
        ),
      );
    },
    preloadIds: [156],
  },
  zuk_attack: {
    resolve: (event) => {
      if (!isZukAttackEvent(event)) return silent;
      switch (event.attack) {
        case 'zuk_blast': {
          const sounds: TimedSound[] = [
            event.targetId === 'player'
              ? { id: 155, channel: 'sfx' }
              : { id: 155, position: event.sourcePosition, range: 15, channel: 'area' },
          ];
          if (event.projectileArrivalCycles !== undefined)
            sounds.push({
              id: 156,
              delayCycles: event.projectileArrivalCycles,
              position: event.targetPosition,
              range: 10,
              channel: 'area',
            });
          return play(sounds);
        }
        case 'mager_magic':
          return event.targetId === 'player'
            ? play(598, { channel: 'sfx' })
            : play(598, { position: event.sourcePosition, range: 10, channel: 'area' });
        case 'ranger_range':
          return play({ id: 598, delayCycles: 50, channel: 'sfx' });
        case 'mager_melee':
        case 'ranger_melee':
          // No melee sound is identified by the captures; 598 belongs to their distance attacks.
          return silent;
        case 'jad_magic':
          return play(
            event.projectileArrivalCycles === undefined
              ? [162]
              : [162, { id: 163, delayCycles: event.projectileArrivalCycles }],
            { channel: 'sfx' },
          );
        case 'jad_range':
          return play(163, { channel: 'sfx' });
        case 'jad_healer_melee':
          return play(608, { channel: 'sfx' });
        case 'jad_melee':
          return play(408, { channel: 'sfx' });
        case 'nibbler_melee':
          return play(INFERNO_WAVE_SOUNDS.nibblerAttack, { position: event.sourcePosition, range: 7, channel: 'area' });
        case 'bat_range':
          return play({ id: INFERNO_WAVE_SOUNDS.batAttack, delayCycles: 15, channel: 'sfx' });
        case 'blob_magic':
          return play(
            event.projectileArrivalCycles === undefined
              ? [INFERNO_WAVE_SOUNDS.blobLaunch]
              : [
                  INFERNO_WAVE_SOUNDS.blobLaunch,
                  { id: INFERNO_WAVE_SOUNDS.blobMagicImpact, delayCycles: event.projectileArrivalCycles },
                ],
            { channel: 'sfx' },
          );
        case 'blob_range':
          return event.projectileArrivalCycles === undefined
            ? silent
            : play(
                { id: INFERNO_WAVE_SOUNDS.blobRangedImpact, delayCycles: event.projectileArrivalCycles },
                { channel: 'sfx' },
              );
        case 'blob_melee':
          return play(INFERNO_WAVE_SOUNDS.blobLaunch, { channel: 'sfx' });
        case 'meleer_melee':
          return play(INFERNO_WAVE_SOUNDS.meleerAttack, { channel: 'sfx' });
        default:
          return assertNever(event.attack);
      }
    },
    preloadIds: [
      155,
      156,
      598,
      162,
      163,
      608,
      408,
      INFERNO_WAVE_SOUNDS.nibblerAttack,
      INFERNO_WAVE_SOUNDS.batAttack,
      INFERNO_WAVE_SOUNDS.blobMagicImpact,
      INFERNO_WAVE_SOUNDS.blobRangedImpact,
    ],
  },
  zuk_jad_cue: {
    resolve: (event) =>
      event.type === 'zuk_jad_cue' && event.style === 'magic' && typeof event.sourceId === 'string'
        ? play(159, { channel: 'sfx' })
        : silent,
    preloadIds: [159],
  },
  zuk_healer_cast: {
    resolve: (event) => {
      if (event.type !== 'zuk_healer_cast') return silent;
      const position = coordinateFrom(event.sourcePosition);
      return position && typeof event.sourceId === 'string'
        ? play({ id: 155, delayCycles: 51 }, { position, range: 8, channel: 'area' })
        : silent;
    },
    preloadIds: [155],
  },
  zuk_ground_effect: {
    resolve: (event) =>
      isZukGroundEffectEvent(event)
        ? play({ id: 155, delayCycles: 51 }, { position: event.sourcePosition, range: 8, channel: 'area' })
        : silent,
    preloadIds: [155],
  },
  zuk_death: {
    resolve: (event) => {
      if (!isZukDeathEvent(event)) return silent;
      switch (event.npcKind) {
        case 'mager':
        case 'ranger':
          return play(599, { channel: 'sfx' });
        case 'jad':
          return play(409, { channel: 'sfx' });
        case 'healer':
          return play(899, { channel: 'sfx' });
        case 'nibbler':
        case 'blob':
        case 'blob_child':
          return play(INFERNO_WAVE_SOUNDS.smallDeath, { channel: 'sfx' });
        case 'bat':
          return play(INFERNO_WAVE_SOUNDS.batDeath, { channel: 'sfx' });
        case 'meleer':
          return play(INFERNO_WAVE_SOUNDS.meleerDeath, { channel: 'sfx' });
        case 'zuk':
        case 'shield':
        case 'jad_healer':
          return silent;
        default:
          return assertNever(event.npcKind);
      }
    },
    preloadIds: [
      599,
      409,
      899,
      INFERNO_WAVE_SOUNDS.smallDeath,
      INFERNO_WAVE_SOUNDS.batDeath,
      INFERNO_WAVE_SOUNDS.meleerDeath,
    ],
  },
  zuk_hit: {
    resolve: (event) => {
      if (!isZukHitEvent(event)) return silent;
      // Synth delivery uses SFX, not an inferred distance cutoff: docs/encounters/zuk-policy.md (Presentation).
      switch (event.npcKind) {
        case 'zuk':
        case 'jad':
          return play(410, { channel: 'sfx' });
        case 'mager':
        case 'ranger':
          return play(600, { channel: 'sfx' });
        case 'jad_healer':
          // Simulator-policy family transfer from captured 7701 to live 7705: docs/encounters/zuk-policy.md (Presentation).
          return play(610, { channel: 'sfx' });
        case 'healer':
          return play(900, { channel: 'sfx' });
        case 'nibbler':
        case 'blob':
        case 'blob_child':
          return play(INFERNO_WAVE_SOUNDS.smallHit, { channel: 'sfx' });
        case 'bat':
          return play(INFERNO_WAVE_SOUNDS.batHit, { channel: 'sfx' });
        case 'meleer':
          return play(INFERNO_WAVE_SOUNDS.meleerHit, { channel: 'sfx' });
        case 'shield':
          return silent;
        default:
          return assertNever(event.npcKind);
      }
    },
    preloadIds: [410, 600, 610, 900, INFERNO_WAVE_SOUNDS.smallHit, INFERNO_WAVE_SOUNDS.batHit],
  },
  inferno_ability: {
    resolve: (event) => {
      if (!isInfernoAbilityEvent(event)) return silent;
      const id = ((ability) => {
        switch (ability) {
          case 'meleer_dig_down':
            return INFERNO_WAVE_SOUNDS.digDown;
          case 'meleer_dig_up':
            return INFERNO_WAVE_SOUNDS.digUp;
          case 'mager_resurrect':
            return INFERNO_WAVE_SOUNDS.resurrect;
          default:
            return assertNever(ability);
        }
      })(event.ability);
      return play(id, { position: event.position, range: 10, channel: 'area' });
    },
    preloadIds: [INFERNO_WAVE_SOUNDS.digDown, INFERNO_WAVE_SOUNDS.digUp, INFERNO_WAVE_SOUNDS.resurrect],
  },
  inferno_pillar_collapse: {
    resolve: (event) => {
      const position = pillarCollapseSoundPosition(event);
      return position ? play(INFERNO_WAVE_SOUNDS.pillarCollapse, { position, range: 10, channel: 'area' }) : silent;
    },
    preloadIds: [INFERNO_WAVE_SOUNDS.pillarCollapse],
  },
};

function assertNever(value: never): never {
  throw new TypeError(`Unknown Inferno audio owner: ${value}`);
}
