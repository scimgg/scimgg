import type { EncounterModifierSelection } from '../../core/encounters/encounterFactory';
import type { ColosseumHeldOrb } from '../../npcs/colosseum/visualEvents';
import type { Coordinate } from '../../types/simulation';
import type { ColosseumRunPublicState, ColosseumRunSetupState } from '../colosseum/waves/snapshot';

/**
 * Plain, readonly, `structuredClone`-safe fight state. No functions, class instances, Maps or
 * Sets: `ReplayRecorder` clones this every frame.
 */
export interface SolHereditPublicState {
  readonly modifiers: EncounterModifierSelection;
  readonly doomStacks: number;
  /** Solarflare NPC positions; departure hits use the player's pre-movement tile. */
  readonly solarflareTiles: readonly Coordinate[];
  /** All retained bee actors, including inactive swarms waiting at their own spawn tile. */
  readonly beeTiles: readonly Coordinate[];
  /** Transitions that have fired: 0 is the opening, 5 is enrage. */
  readonly phase: number;
  /** Tiles the current regular attack will cover, published from its warning tick. */
  readonly dangerTiles: readonly Coordinate[];
  /** Tiles the charging beams will cross. Empty while no round is charging. */
  readonly beamTiles: readonly Coordinate[];
  /**
   * Tiles of the beam round that fired on this tick, tested against the tile the player started it
   * on; a struck player takes the hit next tick. Empty on every other tick.
   */
  readonly beamFiredTiles: readonly Coordinate[];
  /** Molten sand pools on the floor (their LOCs). */
  readonly sandTiles: readonly Coordinate[];
  /** The pools are playing their despawn: from Sol's death until they are removed at death+2. */
  readonly sandDespawning: boolean;
  /** The equipment slot Sol is currently demanding, and the tick the window closes. */
  readonly grapple: { readonly slot: string; readonly taunt: string; readonly resolveTick: number } | null;
  /** Ticks a triple attack's remaining hits land on. */
  readonly tripleHitTicks: readonly number[];
  readonly crystalCount: number;
  /** The Fortis Colosseum run around the fight; see `colosseumRunState`. */
  readonly run?: ColosseumRunPublicState;
  /** A wave run's practice setup; absent for a direct Sol start and in older recordings. */
  readonly runSetup?: ColosseumRunSetupState;
}

export interface SolHereditVisuals {
  /**
   * C, the tick Sol and his shield-warrior fence appear; null while waves 1-11 run. Absent in older
   * recordings, which are direct starts (C = 0).
   */
  readonly solControlTick?: number | null;
  /**
   * Manticore orbs held over their heads after this tick's turns (`manticoreHeldOrbs`), drawn from
   * the tick's start: the server re-sends each every tick until its launch (A:2661-2670). Absent
   * means none.
   */
  readonly heldOrbs?: readonly ColosseumHeldOrb[];
}
