import { getFormulaStyle } from '../../../core/combat/weaponCombatData';
import type { EncounterModifierSelection, EncounterModifierTier } from '../../../core/encounters/encounterFactory';
import type { EncounterEngineRules, EncounterHookEffect } from '../../../core/encounters/types';
import { CHAT_HIGHLIGHT_COLORS } from '../../../core/events/gameMessages';
import type { OverheadTextSegment } from '../../../core/events/types';
import { JAVELIN_ARTILLERY_SOURCE } from '../../../npcs/colosseum/javelinColossus';
import { findWeaponCategoryKey, resolveActiveSpell } from '../../../types/attackStyles';
import type { MechanicsConfig } from '../../../types/simulation';
import { BEES_DAMAGE_SOURCE } from './bees';
import { type ColosseumModifierId, colosseumModifierTierCount } from './definitions';
import { SOLARFLARE_DAMAGE_SOURCE } from './solarflare';
import { VOLATILITY_DAMAGE_SOURCE } from './volatility';

/**
 * Sent on the stack's hit tick with the Doom varbit: `You now have @mes_hl_red@1/15 points</col> of
 * @mes_hl_red@doom!</col>` (waves capture tick 3259, Doom I); `<col=ff3045>1/5 points` in the older
 * Sol capture (Doom III). No capture reaches the lethal stack, so its line is assumed to follow suit.
 */
function doomMessage(stacks: number, lethalStacks: number): readonly OverheadTextSegment[] {
  return [
    { text: 'You now have ' },
    { text: `${stacks}/${lethalStacks} points`, color: CHAT_HIGHLIGHT_COLORS.red },
    { text: ' of ' },
    { text: 'doom!', color: CHAT_HIGHLIGHT_COLORS.red },
  ];
}

/**
 * Wiki /w/Fortis_Colosseum/Modifiers oldid=15163385: Frailty I/II/III take 10%/20%/40% of base HP.
 * The engine applies the reduction (`playerMaxHpReduction`) from the base level, subtracting
 * floor(base * reduction): 99 becomes 90/80/60, not 89/79/59 (Wiki Strategies oldid=15354864), and an
 * upgrade does not compound (II from 99 is 80, not 72). Captured live tier changes: 99 -> 90 (B:2975,
 * C:3064, Frailty I) and 90 -> 80 (K:3992, I -> II), each on the next wave's start tick, five ticks
 * after the choice is confirmed (B:2970, C:3059, K:3987); the player was at full HP every time.
 */
const FRAILTY_MAX_HP_REDUCTION = [0.1, 0.2, 0.4] as const;

/**
 * C:1641 `<col=229628>`, A:4970 `@mes_hl_gre@`, both on the wave's start tick with the Doom count
 * varbit going to 0 and its tier varbit unchanged.
 */
const DOOM_RESET_MESSAGE: readonly OverheadTextSegment[] = [
  { text: 'Your Doom points have reset to 0.', color: CHAT_HIGHLIGHT_COLORS.green },
];

/**
 * Per-run state, reusable by any Colosseum encounter; never reset on an individual NPC death.
 * Waves raise tiers mid-run with `acceptModifier`; the engine caches `getEngineRules()`, so the
 * owner must re-read the rules after each change.
 */
export class ColosseumModifierState {
  private readonly initialSelection: EncounterModifierSelection;
  private current: EncounterModifierSelection;
  doomStacks = 0;
  private mechanics: Readonly<Partial<MechanicsConfig>> = {};

  constructor(selection: EncounterModifierSelection = {}) {
    this.initialSelection = Object.freeze({ ...selection });
    this.current = this.initialSelection;
  }

  /** The live tiers. Replaced, never mutated, when a modifier is accepted. */
  get selection(): EncounterModifierSelection {
    return this.current;
  }

  configureRunStart(mechanics: Readonly<Partial<MechanicsConfig>>): void {
    this.mechanics = mechanics;
  }

  /** A restart: the constructor's selection and no Doom points. */
  reset(): void {
    this.current = this.initialSelection;
    this.doomStacks = 0;
  }

  /** Accepting an intermission offer raises that modifier exactly one tier. */
  acceptModifier(id: ColosseumModifierId, tier: number): void {
    const owned = this.current[id] ?? 0;
    if (tier !== owned + 1 || tier > colosseumModifierTierCount(id)) {
      throw new RangeError(`Cannot take ${id} ${tier} while owning tier ${owned}`);
    }
    this.current = Object.freeze({ ...this.current, [id]: tier as EncounterModifierTier });
  }

  /**
   * At each wave start Doom points return to 0 and the tier is kept. The game only announces it when
   * there were points to clear: no message at C:2863 or C:3445, whose count varbit 9801 was already 0.
   */
  startWave(): readonly OverheadTextSegment[] | null {
    const hadPoints = this.doomStacks > 0;
    this.doomStacks = 0;
    return hadPoints ? DOOM_RESET_MESSAGE : null;
  }

  getEngineRules(): EncounterEngineRules {
    const { doom, blasphemy, frailty, myopia } = this.selection;
    return {
      // A fraction of base HP; the engine re-reads it when the owner refreshes the rules.
      ...(frailty
        ? {
            playerMaxHpReduction: FRAILTY_MAX_HP_REDUCTION[frailty - 1],
            itemRestrictions: { blockOverheal: true },
          }
        : {}),
      ...(myopia
        ? ({
            modifyPlayerCombatParams: (params, ctx) => {
              const player = ctx.player;
              // Wiki /w/Fortis_Colosseum oldid=15352279: autocast is affected, manual casts are not.
              if (player.manualCastSpell) return params;
              const weapon = player.equipment.weapon;
              const style = getFormulaStyle(weapon, player.selectedAttackStyleIndex);
              const spell = resolveActiveSpell({
                weaponId: weapon,
                selectedStyleIndex: player.selectedAttackStyleIndex,
                selectedSpell: player.combatSupplies.selectedSpell,
                spellbook: player.combatSupplies.spellbook,
              });
              const attackRange = Math.max(1, params.attackRange - 2 * myopia);
              if (style !== 'ranged' && style !== 'magic' && !spell) {
                if (findWeaponCategoryKey(weapon) !== 'polearm') return params;
                // Wiki /w/Fortis_Colosseum/Strategies: Myopia
                // stops halberds attacking from a distance cardinally, but diagonal attacks are
                // unaffected. Range 1 everywhere, still reaching the diagonally adjacent tile.
                return { ...params, attackRange, meleeReach: 'diagonal' };
              }
              return { ...params, attackRange };
            },
          } satisfies EncounterEngineRules)
        : {}),
      ...(doom || blasphemy
        ? ({
            onPlayerDamageTaken: (info) => {
              // Simulator policy, capture UNVERIFIED: poison/venom pulses neither add Doom nor drain prayer.
              if (info.effectiveDamage <= 0 || info.damageOverTime) return null;
              const effect: EncounterHookEffect = {};
              // Wiki Modifiers oldid=15163385; no-Sol capture ticks 1542–2420, K:4067.
              // Hook routing excludes self-damage.
              if (doom) {
                // Wiki /w/Javelin_Colossus rev 15411467 (a {{Bug}} note) and /w/Fortis_Colosseum/Strategies
                // rev 15414089: the airborne javelin adds two stacks; the Modifiers page is silent. UNVERIFIED
                // in captures (no artillery hit the player in A/B/C). Policy: one splat and one line with the
                // new count, as for a single stack.
                this.doomStacks += info.source === JAVELIN_ARTILLERY_SOURCE ? 2 : 1;
                const lethalStacks = [15, 10, 5][doom - 1]!;
                effect.playerHitsplats = [{ amount: this.doomStacks, hitsplatType: 'doom' }];
                effect.gameMessage = doomMessage(this.doomStacks, lethalStacks);
                if (this.doomStacks >= lethalStacks && !this.mechanics.infiniteHealth) effect.fail = 'Doom';
              }
              // A:4985/5005/5030: full five-damage groups, then multiply by tier (36->21, 33->18, 44->24).
              // A:1508/2800/3487/4026: modifier hits still add Doom but never drain prayer.
              // Molten sand retains the ordinary drain; that interaction remains unverified.
              // Simulator policy: Bees are excluded; their direct hits still add Doom.
              // Javelin artillery is an enemy attack taken off-prayer (it ignores Protect from Missiles), so
              // it drains like any other: Wiki Modifiers rev 15163385 "damage taken from enemies"; cache
              // struct 894 "damage received from enemies off-prayer". No Wiki exception; UNVERIFIED in captures.
              if (
                blasphemy &&
                ![SOLARFLARE_DAMAGE_SOURCE, VOLATILITY_DAMAGE_SOURCE, BEES_DAMAGE_SOURCE].includes(info.source)
              ) {
                effect.prayerPointsDelta = -Math.floor(info.effectiveDamage / 5) * blasphemy;
              }
              return effect;
            },
          } satisfies EncounterEngineRules)
        : {}),
    };
  }
}
