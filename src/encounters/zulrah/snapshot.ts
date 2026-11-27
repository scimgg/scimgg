import type { ZulrahForm } from '../../npcs/zulrah/constants';
import type { ZulrahSpot } from './rotation';

export type ZulrahStage = 'emerging' | 'active' | 'diving' | 'submerged' | 'defeated';

/**
 * Zulrah's public per-tick payload. Plain, readonly, `structuredClone`-safe data: the replay recorder
 * clones it every frame.
 */
export interface ZulrahPublicState {
  /** Zero-based count of phases since the fight began. */
  readonly phaseIndex: number;
  /** Rotation 1-4, or null during the opening phase, which all four share. */
  readonly rotation: 1 | 2 | 3 | 4 | null;
  /** One-based phase within the rotation. */
  readonly phaseInRotation: number;
  readonly rotationLength: number;
  readonly form: ZulrahForm;
  readonly spot: ZulrahSpot;
  readonly stage: ZulrahStage;
  readonly hp: number;
}

/** A venom cloud: its 3x3 centre, when it lands, and when it is gone. */
export interface ZulrahCloudVisual {
  readonly center: readonly [number, number];
  readonly landTick: number;
  readonly expireTick: number;
}

export interface ZulrahVisuals {
  /** Clouds in flight (not yet landed) or on the island. */
  readonly clouds: readonly ZulrahCloudVisual[];
}
