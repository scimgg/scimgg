import { INFOBOX_ITEM_IDS } from '../../data/infoboxItemIds';
import { encounterInfobox } from '../../encounters/practiceChrome';
import { type CombatTimers, POISON_TICK_INTERVAL } from '../../types/playerState';
import type { SimulationState } from '../../types/simulation';
import { resolveTickColor, type TickColorOverrides } from '../../util/tickColor';
import type { InfoBoxData } from './infoboxTypes';
import { formatTicksToClock } from './timerFormat';

export interface InfoBoxSettings {
  showTickCounterInfobox?: boolean;
  tickCounterMax?: number;
  tickCounterColors?: TickColorOverrides;
  /** Visual: whether the outline is drawn on ALL infobox text (used when enabled). */
  infoboxTextOutlineEnabled?: boolean;
  /** Visual: outline color applied to ALL infobox text (not selection). */
  infoboxTextOutlineColor?: string;
}

const STAT_CONFIG: Record<string, { id: string; name: string; spriteUrl: string }> = {
  attack: { id: 'stat-attack', name: 'Attack', spriteUrl: '/assets/ui/skill-attack.png' },
  strength: { id: 'stat-strength', name: 'Strength', spriteUrl: '/assets/ui/skill-strength.png' },
  defence: { id: 'stat-defence', name: 'Defence', spriteUrl: '/assets/ui/skill-defence.png' },
  ranged: { id: 'stat-ranged', name: 'Ranged', spriteUrl: '/assets/ui/skill-ranged.png' },
  magic: { id: 'stat-magic', name: 'Magic', spriteUrl: '/assets/ui/skill-magic.png' },
};

/** Ticks left on the saturated heart's Magic decay lock. */
function saturatedHeartTicksRemaining(timers: CombatTimers): number {
  const lock = timers.statDecayLocks.magic;
  return lock?.source === 'saturated_heart' ? lock.ticksRemaining : 0;
}

export function selectInfoboxes(state: SimulationState, settings?: InfoBoxSettings): InfoBoxData[] {
  const infoboxes: InfoBoxData[] = [];

  // The encounter's own run state leads: it is the only tile here that says where the fight is,
  // and first is also the cell the Mobile buff bar never drops when the strip overflows.
  const encounterTile = encounterInfobox(state.encounter);
  if (encounterTile) infoboxes.push(encounterTile);

  const showTickCounterInfobox = settings?.showTickCounterInfobox ?? true;
  const tickCounterMax = settings?.tickCounterMax ?? 4;

  if (showTickCounterInfobox && tickCounterMax > 0) {
    const cycleValue = ((state.currentTick - 1) % tickCounterMax) + 1;
    infoboxes.push({
      id: 'tick-counter',
      spriteUrl: '',
      text: cycleValue.toString(),
      textColor: resolveTickColor(cycleValue, tickCounterMax, settings?.tickCounterColors),
      tooltipTitle: 'Tick Counter',
      tooltipDetail: `Tick ${cycleValue} of ${tickCounterMax}`,
    });
  }

  const overloadTicksRemaining = state.overloadTicksRemaining ?? 0;

  if (overloadTicksRemaining > 0) {
    const overloadTimeText = formatTicksToClock(overloadTicksRemaining);
    infoboxes.push({
      id: 'overload-plus',
      itemId: INFOBOX_ITEM_IDS.overloadPlus,
      text: overloadTimeText,
      ticksRemaining: overloadTicksRemaining,
      sampledAtTick: state.currentTick,
      tooltipTitle: 'Overload (+)',
      tooltipDetail: `Combat stats boosted (${overloadTimeText} remaining)`,
    });
  }

  const ticksRemaining = saturatedHeartTicksRemaining(state.combatTimers);

  if (ticksRemaining > 0) {
    const timeText = formatTicksToClock(ticksRemaining);
    // The live boost, not the heart's formula: drains and restores since the heart change it.
    const magicBoost = state.stats.magic.current - state.stats.magic.max;

    infoboxes.push({
      id: 'saturated-heart',
      itemId: INFOBOX_ITEM_IDS.saturatedHeart,
      text: timeText,
      ticksRemaining,
      sampledAtTick: state.currentTick,
      tooltipTitle: 'Saturated heart',
      tooltipDetail: magicBoost > 0 ? `Magic +${magicBoost} (${timeText} remaining)` : `${timeText} remaining`,
    });
  }

  const modTicksRemaining = state.markOfDarknessTicksRemaining;

  if (modTicksRemaining > 0) {
    const modTimeText = formatTicksToClock(modTicksRemaining);

    infoboxes.push({
      id: 'mark-of-darkness',
      spriteUrl: '/assets/ui/packs/pack-vanilla/spells/arceuus_spell/mark_of_darkness.png',
      text: modTimeText,
      ticksRemaining: modTicksRemaining,
      sampledAtTick: state.currentTick,
      tooltipTitle: 'Mark of Darkness',
      tooltipDetail: `Demonbane bonus active (${modTimeText} remaining)`,
    });
  }

  // Death Charge shows as TWO boxes, because the two numbers a player acts on are never the same
  // number. While the cast is live what matters is how many kills it will still pay out on; once
  // it is spent or expired what matters is when it can be recast. Splitting them also stops the
  // common case rendering two identical countdowns: the window and the cooldown are both 100 ticks
  // and start on the same tick, so they only diverge after the procs are used.
  const deathChargeActive = state.combatTimers.deathChargeActiveTicks;
  const deathChargeCooldown = state.combatTimers.deathChargeCooldownTicks;

  if (deathChargeActive > 0) {
    const charges = state.combatTimers.deathChargeProcsRemaining;
    const windowText = formatTicksToClock(deathChargeActive);
    infoboxes.push({
      id: 'death-charge',
      spriteUrl: '/assets/ui/packs/pack-vanilla/spells/arceuus_spell/death_charge.png',
      // A count, not a countdown, so `ticksRemaining` is deliberately unset — setting it makes the
      // tile render the interpolated timer INSTEAD of this text.
      text: charges.toString(),
      ...(charges > 1 ? { tone: 'boost' as const } : {}),
      tooltipTitle: 'Death Charge',
      tooltipDetail: `${charges} ${charges === 1 ? 'kill' : 'kills'} left to restore 15% special attack (${windowText} remaining)`,
    });
  }

  if (deathChargeCooldown > 0 && deathChargeActive === 0) {
    const cooldownText = formatTicksToClock(deathChargeCooldown);
    infoboxes.push({
      id: 'death-charge-cooldown',
      spriteUrl: '/assets/ui/packs/pack-vanilla/spells/arceuus_spell/death_charge_disabled.png',
      text: cooldownText,
      ticksRemaining: deathChargeCooldown,
      sampledAtTick: state.currentTick,
      tooltipTitle: 'Death Charge',
      tooltipDetail: `Can be recast in ${cooldownText}`,
    });
  }

  if (state.poisonVarp < 0) {
    const immunityVarpUnits = Math.abs(state.poisonVarp);
    const remainingTicks = (immunityVarpUnits - 1) * POISON_TICK_INTERVAL + state.poisonTickCounter;
    const immunityTimeText = formatTicksToClock(remainingTicks);

    infoboxes.push({
      id: 'antipoison',
      itemId: INFOBOX_ITEM_IDS.antipoison,
      text: immunityTimeText,
      ticksRemaining: remainingTicks,
      sampledAtTick: state.currentTick,
      tooltipTitle: 'Antipoison',
      tooltipDetail: `Poison immunity (${immunityTimeText} remaining)`,
    });
  }

  // The engine's own cooldown, read as it stands: it is what stops the next dose, so the box and
  // the refusal can never disagree about when a surge potion can be drunk again.
  const surgeCooldown = state.combatTimers.surgePotionCooldownTicks;

  if (surgeCooldown > 0) {
    const surgeCooldownText = formatTicksToClock(surgeCooldown);
    infoboxes.push({
      id: 'surge-potion-cooldown',
      itemId: INFOBOX_ITEM_IDS.surgePotion,
      text: surgeCooldownText,
      ticksRemaining: surgeCooldown,
      sampledAtTick: state.currentTick,
      tooltipTitle: 'Surge potion',
      tooltipDetail: `Cooldown (${surgeCooldownText} remaining)`,
    });
  }

  const statsToCheck = ['attack', 'strength', 'defence', 'ranged', 'magic'] as const;

  for (const statName of statsToCheck) {
    const stat = state.stats[statName];
    if (stat.current !== stat.max) {
      const config = STAT_CONFIG[statName];
      const diff = stat.current - stat.max;
      const sign = diff > 0 ? '+' : '';

      infoboxes.push({
        id: config.id,
        spriteUrl: config.spriteUrl,
        text: stat.current.toString(),
        tone: diff > 0 ? 'boost' : 'drain',
        tooltipTitle: config.name,
        tooltipDetail: `${config.name}: ${stat.current}/${stat.max} (${sign}${diff})`,
      });
    }
  }

  return infoboxes;
}
