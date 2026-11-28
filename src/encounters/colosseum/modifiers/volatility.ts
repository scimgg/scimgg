import type { EncounterModifierTier } from '../../../core/encounters/encounterFactory';
import type { EnvironmentalDamage } from '../../../core/encounters/types';
import type { EncounterGraphicCue } from '../../../core/events/encounterVisual';
import { COLOSSEUM_SPOTANIMS } from '../../../npcs/colosseum/constants';
import type { Coordinate } from '../../../types/simulation';

export function volatilityExplosionCentre(position: Readonly<Coordinate>, size: number): Coordinate {
  const offset = Math.floor(size / 2);
  return [position[0] + offset, position[1] + offset];
}

/** Wiki Modifiers oldid=15163385: III retains II's radius; the added sand pool is not simulated. */
export function volatilityExplosionTiles(
  npcPosition: Readonly<Coordinate>,
  npcSize: number,
  tier: EncounterModifierTier,
): Coordinate[] {
  const radius = Math.min(tier, 2);
  const tiles: Coordinate[] = [];
  for (let x = npcPosition[0] - radius; x < npcPosition[0] + npcSize + radius; x++) {
    for (let y = npcPosition[1] - radius; y < npcPosition[1] + npcSize + radius; y++) tiles.push([x, y]);
  }
  return tiles;
}

/** M8521 and N7790: client-cycle ripple, not a damage delay or a per-tick hazard. */
export function volatilityRingDelay(position: Readonly<Coordinate>, centre: Readonly<Coordinate>): number {
  return 2 * Math.max(Math.abs(position[0] - centre[0]), Math.abs(position[1] - centre[1]));
}

export const VOLATILITY_DAMAGE_SOURCE = 'Volatility';

/** The leftover NPC and the explosion effect a wave enemy's Volatility death shows. */
export interface VolatilityGib {
  readonly npcTypeId: number;
  readonly sequenceId: number;
  readonly explosionSpotAnimId: number;
}

/**
 * Cache NPC ids `colosseum_*_gib` 12828–12831 with their `vfx_colosseum_*_gib_01` sequences and
 * `vfx_colosseum_*_explosion_01` spotanims (RuneLite gameval, 1.13.7-SNAPSHOT). Every one of Run A's
 * 33 wave gibs pairs them as below.
 */
const GIBS = {
  human: { npcTypeId: 12828, sequenceId: 10834, explosionSpotAnimId: COLOSSEUM_SPOTANIMS.volatilityHumanExplosion },
  manticore: {
    npcTypeId: 12829,
    sequenceId: 10835,
    explosionSpotAnimId: COLOSSEUM_SPOTANIMS.volatilityManticoreExplosion,
  },
  minotaur: {
    npcTypeId: 12830,
    sequenceId: 10837,
    explosionSpotAnimId: COLOSSEUM_SPOTANIMS.volatilityMinotaurExplosion,
  },
  colossi: { npcTypeId: 12831, sequenceId: 10836, explosionSpotAnimId: COLOSSEUM_SPOTANIMS.volatilityColossiExplosion },
} as const satisfies Record<string, VolatilityGib>;

const GIB_BY_NPC_TYPE: ReadonlyMap<number, VolatilityGib> = new Map<number, VolatilityGib>([
  // Run A: warband 12814/12815 and serpent shaman 12811 (the berserker's `del` is not printed, but its
  // gibs sit on its tile). UNVERIFIED for the jaguar warrior 12810: it uses the human death sequence
  // 10849, and no Volatility capture has a jaguar wave.
  ...[12810, 12811, 12814, 12815, 12816].map((id) => [id, GIBS.human] as const),
  [12818, GIBS.manticore],
  // 12813 is Red Flag's routing minotaur, UNVERIFIED (never captured).
  [12812, GIBS.minotaur],
  [12813, GIBS.minotaur],
  [12817, GIBS.colossi],
  [12819, GIBS.colossi],
]);

/** The gib for a wave enemy's cache NPC id, or null for anything that does not explode. */
export function volatilityGibForNpcType(npcTypeId: number): VolatilityGib | null {
  return GIB_BY_NPC_TYPE.get(npcTypeId) ?? null;
}

/** Run A, 33/33: the gib is deleted three ticks after it is added. */
export const VOLATILITY_GIB_LIFETIME_TICKS = 3;

/**
 * Run A's 33 wave explosions, all on the dying NPC's removal tick, alongside the gib added on its
 * south-west tile: the explosion spotanim on the footprint center, then a fireblast impact on every
 * explosion tile that is walkable (pillars and walls get none), rippling out by `volatilityRingDelay`
 * (33/33).
 * Damage is still `volatilityExplosionDamage`; a blocked tile cannot hold the player anyway.
 */
export function volatilityExplosionGraphics(input: {
  readonly npcPosition: Readonly<Coordinate>;
  readonly npcSize: number;
  readonly tier: EncounterModifierTier;
  readonly explosionSpotAnimId: number;
  readonly isWalkable: (tile: Coordinate) => boolean;
}): EncounterGraphicCue[] {
  const center = volatilityExplosionCentre(input.npcPosition, input.npcSize);
  return [
    { spotAnimId: input.explosionSpotAnimId, target: { kind: 'tile', position: center }, delayCycles: 0, height: 0 },
    ...volatilityExplosionTiles(input.npcPosition, input.npcSize, input.tier)
      .filter((tile) => input.isWalkable(tile))
      .map((position) => ({
        spotAnimId: COLOSSEUM_SPOTANIMS.fireblastImpact,
        target: { kind: 'tile' as const, position },
        delayCycles: volatilityRingDelay(position, center),
        height: 0,
      })),
  ];
}

/** A:2800/2852/3487/3592/3608/4026: the visual footprint is also the damage footprint. */
export function volatilityExplosionDamage(
  npcPosition: Readonly<Coordinate>,
  npcSize: number,
  tier: EncounterModifierTier,
  playerStartPosition: Readonly<Coordinate>,
): EnvironmentalDamage[] {
  // A:3260/4638: leaving during this tick still hits; A:2979: stepping in does not.
  const covered = volatilityExplosionTiles(npcPosition, npcSize, tier).some(
    ([x, y]) => x === playerStartPosition[0] && y === playerStartPosition[1],
  );
  return covered
    ? [
        {
          // MODEL: observed 16–24 (I 17/24/16/20, II 22/22/21, III 21); use engine combat RNG.
          baseDamage: [16, 24],
          attackType: 'typeless',
          source: VOLATILITY_DAMAGE_SOURCE,
          playerPosition: [...playerStartPosition],
        },
      ]
    : [];
}
