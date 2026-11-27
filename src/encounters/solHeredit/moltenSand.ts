/**
 * Molten sand: the sunfire lightning strikes and the persistent pools they leave.
 *
 * Placement follows the Wiki's documented rule (six candidates in the 9x9 centered on the player,
 * one of them always the player's own tile, an already-covered tile yielding nothing) which the
 * captures corroborate on every batch: all ten multi-tile batches contain the player's tile, the
 * observed maximum distance is exactly 4, and the batch sizes of 4-6 are what rolling six
 * candidates against existing pools produces.
 */
import type { EncounterContext, EnvironmentalDamage } from '../../core/encounters/types';
import { isInsideArena } from '../../npcs/colosseum/solAttacks';
import type { Coordinate } from '../../types/simulation';
import {
  SAND_DAMAGE_ONSET_TICKS,
  SAND_MAX_DAMAGE,
  SAND_MIN_DAMAGE,
  SAND_PLACEMENT_RADIUS,
  SAND_POOL_DELAY_TICKS,
  SOL_ARENA,
} from './constants';

const tileKey = (tile: Readonly<Coordinate>): string => `${tile[0]},${tile[1]}`;

export interface SandStrike {
  readonly tiles: readonly Coordinate[];
  readonly tick: number;
}

export class MoltenSand {
  /**
   * Tiles showing a pool LOC. A subset of `burning`: struck tiles burn before the pool appears.
   * Pools never expire while Sol lives: every captured pool lasted until his death, L's first for
   * 1,853 ticks (L:3982 to its removal at L:5835). Keyed to the tick each pool formed.
   */
  private readonly pools = new Map<string, number>();
  private readonly burning = new Set<string>();
  private pending: { readonly key: string; readonly strikeTick: number }[] = [];

  clear(): void {
    this.pools.clear();
    this.burning.clear();
    this.pending = [];
  }

  /** Tiles showing a pool, for the snapshot's LOCs. Forming tiles already burn but are not listed. */
  getActivePools(): Coordinate[] {
    return [...this.pools.keys()].map((key) => key.split(',').map(Number) as Coordinate);
  }

  /**
   * Sol's death on `tick` ends pool formation: a strike still forming never leaves a pool, including
   * one due on the death tick itself. VERIFIED: K:4216 and N:7776 were due on D, K:4219, M:8510 and
   * N:7779 later, and none formed in any kill; the pools already down stay until removal.
   */
  stopForming(tick: number): void {
    this.pending = [];
    for (const [key, formed] of this.pools) if (formed >= tick) this.pools.delete(key);
  }

  isCovered(tile: Readonly<Coordinate>): boolean {
    return this.pools.has(tileKey(tile));
  }

  /**
   * Rolls one batch of strikes around the player and schedules their pools.
   *
   * Candidates are rolled against the whole 9x9 INCLUDING covered tiles and discarded afterwards,
   * which is what makes a batch smaller than `count` as the floor fills up — the reason observed
   * transition batches are 4-6 rather than always 6.
   *
   * `forcePlayerTile` matches the Wiki's rule that one candidate is always underfoot. It holds for
   * every observed transition and enrage-opening batch, but NOT for the enrage drip, whose singles
   * land 1-4 tiles away (K:4207..4219; none of L's 20 was underfoot). The drip takes one roll per
   * slot, which over-produces empty slots against L (see `ENRAGE_SAND_INTERVAL_TICKS`).
   */
  strike(
    playerPos: Readonly<Coordinate>,
    count: number,
    tick: number,
    random: () => number,
    forcePlayerTile = true,
  ): SandStrike {
    const chosen: Coordinate[] = [];
    const seen = new Set<string>();
    const consider = (tile: Coordinate): void => {
      const key = tileKey(tile);
      // Burning includes every pool. A struck tile not yet burning (E+1/E+2) can be chosen again:
      // no permitted source settles that case.
      if (seen.has(key) || this.burning.has(key) || !isInsideArena(tile, SOL_ARENA)) return;
      seen.add(key);
      chosen.push(tile);
    };
    const span = SAND_PLACEMENT_RADIUS * 2 + 1;
    let rolls = count;
    if (forcePlayerTile) {
      consider([playerPos[0], playerPos[1]]);
      rolls--;
    }
    for (let roll = 0; roll < rolls; roll++) {
      consider([
        playerPos[0] - SAND_PLACEMENT_RADIUS + Math.floor(random() * span),
        playerPos[1] - SAND_PLACEMENT_RADIUS + Math.floor(random() * span),
      ]);
    }
    for (const tile of chosen) this.pending.push({ key: tileKey(tile), strikeTick: tick });
    return { tiles: chosen, tick };
  }

  /** Struck tiles burn from E+3, while the white pool is still forming; the pool LOC shows at E+5. */
  advance(tick: number): void {
    for (const entry of this.pending) {
      if (tick >= entry.strikeTick + SAND_DAMAGE_ONSET_TICKS) this.burning.add(entry.key);
      if (tick >= entry.strikeTick + SAND_POOL_DELAY_TICKS && !this.pools.has(entry.key))
        this.pools.set(entry.key, entry.strikeTick + SAND_POOL_DELAY_TICKS);
    }
    this.pending = this.pending.filter((entry) => tick < entry.strikeTick + SAND_POOL_DELAY_TICKS);
  }

  /**
   * Burns the player for standing in sand, forming or formed. Call with the tile the player starts
   * the tick on, before movement. Damage is the Wiki's approximate 6-8 range; the single observed
   * player hit attributable to sand is 8 (K:4067).
   */
  resolve(ctx: Pick<EncounterContext, 'playerPos'>): EnvironmentalDamage[] {
    if (!this.burning.has(tileKey(ctx.playerPos))) return [];
    return [
      {
        baseDamage: [SAND_MIN_DAMAGE, SAND_MAX_DAMAGE],
        attackType: 'typeless',
        source: 'SolMoltenSand',
        playerPosition: [...ctx.playerPos],
      },
    ];
  }
}
