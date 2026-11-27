import type { PlayerEquipment } from '../../rs/model/PlayerModelLoader';
import type { CombatSupplies } from '../../types/encounterLoadout';
import type { EquipmentStats } from '../../types/equipmentStats';
import type { Inventory } from '../../types/inventory';
import type {
  CombatTimers,
  CooldownTrackState,
  EffectTimer,
  PlayerStats,
  PoisonState,
  RunEnergyState,
  SpecialAttackState,
} from '../../types/playerState';
import type { Coordinate, PrayerState, PrayerType, TickNumber } from '../../types/simulation';
import type { PendingConflictionAttack } from '../combat/player/confliction';
import type { SoulreaperState } from '../combat/player/soulreaper';
import type { XpSkill } from '../events/types';
import type { PendingInputOp } from '../inputOps';
import type { ActorBase } from './ActorBase';
import type { ActorId, PendingItemPickup } from './types';

export interface PlayerAutoAttackPause {
  readonly targetId: ActorId;
  readonly resumeTick: TickNumber;
}

export interface PlayerActor extends ActorBase {
  kind: 'player';
  movementPath: Coordinate[];
  isMoving: boolean;
  isRunning: boolean;
  history: Map<TickNumber, Coordinate>;
  activePrayer: PrayerType | null;
  /**
   * Lit attack, strength and defence boosts. Conflict-free by `prayersConflict`, deduplicated and
   * insertion-ordered.
   */
  boostPrayers: PrayerType[];
  /**
   * Prayers that belong to no conflict group and therefore stack with everything above
   * (Preserve, Rapid Restore and Rapid Heal). Deduplicated, insertion-ordered.
   */
  independentPrayers: PrayerType[];
  prayerState: PrayerState;
  stats: PlayerStats;
  poisonState: PoisonState;
  specialAttack: SpecialAttackState;
  combatTimers: CombatTimers;
  inventory: Inventory;
  combatSupplies: CombatSupplies;
  isRunEnabled: boolean;
  isSpecialAttackActive: boolean;
  /** /w/Staff_of_the_dead#Special_attack; exclusive expiry tick, refreshed rather than stacked. */
  powerOfDeathUntilTick?: number;
  /** Soulreaper axe soul stacks; absent while there are none. */
  soulreaper?: SoulreaperState;
  runEnergy: RunEnergyState;
  ctrlClickOverride: boolean;
  equipment: PlayerEquipment;
  equipmentStats: EquipmentStats;
  cooldownTracks: CooldownTrackState;
  /**
   * Every client op received since the last tick, in arrival order, drained as
   * one FIFO on the next tick — see {@link PendingInputOp} for why op type must
   * not re-sort this.
   */
  pendingInputOps: PendingInputOp[];
  /**
   * The ground item the player is walking to take, or null. Survives across ticks
   * and is resolved BEFORE movement each tick, so standing on the pile is a
   * precondition this tick's step cannot satisfy for itself; cleared by any new
   * walk/attack click.
   */
  pendingItemPickup: PendingItemPickup | null;
  activeEffects: EffectTimer[];
  /** Whether the quick-prayer set is engaged (OSRS varbit 4103, `QUICKPRAYER_ACTIVE`). */
  quickPrayersActive: boolean;
  attackTarget: ActorId | null;
  /** Remembers the health-overlay selection independently of active attack intent. */
  lastAttackTarget?: ActorId;
  /** Target-specific execution pause. Combat intent and queued attack state remain active. */
  autoAttackPause: PlayerAutoAttackPause | null;
  /**
   * Whether the attack interaction is active (player intends to attack when in range).
   * Models OSRS's separation of interaction vs movement:
   *   - true  = normal combat: walk to NPC AND attack when in range
   *   - false = interaction canceled by interface action (eat/equip/drink):
   *            walk to NPC but do NOT attack
   *
   * Cleared when an eat/equip/drink op runs after an attack op in the same tick.
   * Persists across ticks so multi-tick movement continues without attacking.
   */
  attackInteractionActive: boolean;
  /**
   * Spell name forced for the next attack by a manual cast (spellbook click then
   * NPC click), or null. A manual cast is a single forced cast: this is cleared as
   * soon as the attack launches, after which the target stays engaged and normal
   * attacks resume with the configured autocast (OSRS Wiki: Autocast).
   */
  manualCastSpell: string | null;
  /** Index into the weapon category's styles array (0-based). Clamped at attack time. */
  selectedAttackStyleIndex: number;
  pendingConflictionAttack: PendingConflictionAttack | null;
  /**
   * Cumulative fractional combat XP per skill, fed by player attacks.
   * Drives xp_drop events: the integer display deltas of these counters
   * reproduce the alternating 13/14-style drops of the real client.
   */
  xpCounters: Partial<Record<XpSkill, number>>;
}
