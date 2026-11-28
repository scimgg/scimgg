import type { Coordinate } from '../../types/simulation';

export type WardenHazardKind = 'spikes' | 'slam' | 'gaze' | 'magic' | 'vent' | 'gasSpit' | 'bile';

export interface DukePose {
  readonly clip: 'wake' | 'slam' | 'magic' | 'fastMagic' | 'gaze' | 'bile';
  readonly startTick: number;
}

export interface WardenHazard {
  readonly kind: WardenHazardKind;
  readonly tiles: readonly Coordinate[];
  /** Projectile arrival when the hazard takes additional time to become damaging. */
  readonly landingTick?: number;
  readonly windupTick?: number;
  readonly missed?: boolean;
  readonly impactTick: number;
  readonly expiresTick: number;
}

export interface DukeState {
  readonly poisonToleranceFilled?: number;
  readonly bileTicksRemaining: number;
  readonly enraged: boolean;
  readonly perfectKillEligible: boolean;
}

export interface DukeOrbBurst {
  readonly tile: Coordinate;
  readonly tick: number;
}

export interface DukeVisuals {
  readonly hazards: readonly WardenHazard[];
  readonly orbTile: Coordinate | null;
  /** Earlier replays reconstruct attack clips and ordinary effects from snapshots alone. */
  readonly usesVisualEvents?: true;
  /** Previous tile of the same orb, available while it is moving. */
  readonly orbPreviousTile?: Coordinate;
  readonly orbBursts?: readonly DukeOrbBurst[];
  readonly pose?: DukePose;
  /** Expired damage areas whose impact or fade graphic is still playing. */
  readonly fadingEffects?: readonly WardenHazard[];
}
