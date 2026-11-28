import type { NpcActor } from '../../../core/actors/NpcActor';
import type { EncounterContext, EnvironmentalDamage } from '../../../core/encounters/types';
import { emitEncounterVisual } from '../../../core/events/encounterVisual';
import { isArenaFootprintWalkable } from '../../../core/npcMovementCollision';
import type { Coordinate } from '../../../types/simulation';
import { advanceBeeRespawn, beesDefinition, createBeeSwarms } from '../modifiers/bees';
import type { ColosseumModifierState } from '../modifiers/rules';
import { createSolarflare, SolarflareDamageState, solarflareDefinition } from '../modifiers/solarflare';
import {
  advanceHealingTotem,
  createHealingTotem,
  healingTotemDefinition,
  healingTotemSpawnTile,
  TOTEMIC_HP_THRESHOLD,
} from '../modifiers/totemic';
import { isColosseumModifierActor } from '../modifiers/waveCleanup';

/** Bees join a wave five ticks after it starts: B:2361->2366, 2630->2635, 2975->2980, 3347->3352. */
export const WAVE_BEES_DELAY_TICKS = 5;

/**
 * Solarflare's four wave orbs, in their add order, each a closed square of side 4 from its spawn
 * corner. VERIFIED in Run A waves 5-11 (28/28 orbs): added at T0 on these tiles (A:1333, 1779, 2182,
 * 2645, 3248, 3561, 4245), first step at T0+1, the same routes every wave and tier (A:1333-1386 one
 * full lap at tier I: N/W/S/E outward first, e.g. (38,40) -> (38,44) -> (42,44) -> (42,40)).
 */
export const WAVE_SOLARFLARE_ROUTES: readonly (readonly Readonly<Coordinate>[])[] = [
  [
    [38, 40],
    [38, 44],
    [42, 44],
    [42, 40],
  ],
  [
    [27, 40],
    [23, 40],
    [23, 44],
    [27, 44],
  ],
  [
    [27, 29],
    [27, 25],
    [23, 25],
    [23, 29],
  ],
  [
    [38, 29],
    [42, 29],
    [42, 25],
    [38, 25],
  ],
];
/** A:1333 add -> A:1334 first step, and the same in every Run A wave. */
const WAVE_SOLARFLARE_FIRST_STEP_TICKS = 1;

/**
 * A wave totem heals floor(30%) of its target's max HP (17/19 Run A heals: jaguar and shaman 37,
 * minotaur 67, javelin 66; the other two were capped at the missing HP), Sol facts spec §Totemic.
 */
const WAVE_TOTEM_HEAL_FRACTION = 0.3;

/**
 * The wave-stage effects of the modifier actors (Bees, Solarflare, Totemic), from each wave's start
 * to its completion. Wave 12 is Sol's: `SolModifierEffects` runs them there on his own schedule.
 */
export class ColosseumWaveModifiers {
  private readonly beeRules = beesDefinition.register(undefined);
  private readonly solarflareDamage = new SolarflareDamageState();
  private beesDueTick: number | null = null;
  /** Fighters given their totem; a target never receives a second one (Run A, 54/54). */
  private readonly totemTargets = new Set<string>();
  private totemCount = 0;
  private wave = 0;

  constructor(private readonly modifierState: ColosseumModifierState) {}

  /** T0, after the wave's pick is accepted: Solarflare's orbs now, Bees five ticks on. */
  startWave(ctx: EncounterContext, wave: number): void {
    this.wave = wave;
    const selection = this.modifierState.selection;
    this.beesDueTick = selection.bees ? ctx.tick + WAVE_BEES_DELAY_TICKS : null;
    const tier = selection.solarflare;
    if (!tier) return;
    for (const [index, corners] of WAVE_SOLARFLARE_ROUTES.entries()) {
      const orb = createSolarflare({
        id: `colosseum_w${wave}_solarflare_${index}`,
        corners,
        tier,
        spawnTick: ctx.tick,
        firstStepTick: ctx.tick + WAVE_SOLARFLARE_FIRST_STEP_TICKS,
      });
      // Not an enemy: neither an attack nor a ricochet may pick it.
      orb.untargetable = true;
      ctx.spawnNpc(orb);
    }
  }

  /** Whether `actor` is one of these effects' actors that moves by its own definition this wave. */
  moves(actor: NpcActor): boolean {
    return beesDefinition.isActor(actor) || solarflareDefinition.isActor(actor);
  }

  /** Before player movement: swarms waiting out their respawn come back. */
  resolveHazards(ctx: EncounterContext): void {
    for (const bee of ctx.world.getNpcs().filter(beesDefinition.isActor)) advanceBeeRespawn(bee, ctx.tick);
  }

  /**
   * After every NPC's turn (its damage taken): Solarflare's departure hits from this tick's actual
   * orb moves, the swarms' stings, then Totemic. A totem appears on the tick a living fighter is first
   * at or below half HP and leaves when its target dies (A:850-4832, 55 totems).
   */
  completeNpcBand(ctx: EncounterContext, fighters: Iterable<NpcActor>, random: () => number): EnvironmentalDamage[] {
    const selection = this.modifierState.selection;
    const damages: EnvironmentalDamage[] = [];
    if (selection.solarflare) {
      const orbIds = new Set(
        ctx.world
          .getNpcs()
          .filter(solarflareDefinition.isActor)
          .map((orb) => orb.id),
      );
      const movements = [...(ctx.npcMovements?.values() ?? [])].filter((move) => orbIds.has(move.npcId));
      damages.push(...this.solarflareDamage.resolveTick(ctx, movements, selection.solarflare));
    }
    for (const bee of ctx.world.getNpcs().filter(beesDefinition.isActor))
      damages.push(...this.beeRules.resolveLocalEffects(bee, { ...ctx, random }));
    for (const totem of ctx.world.getNpcs().filter(healingTotemDefinition.isActor)) {
      if (!ctx.world.getNpc(totem.state.targetId)?.alive) ctx.despawnNpc(totem.id);
    }
    if (selection.totemic) {
      for (const fighter of fighters) {
        if (!fighter.alive || this.totemTargets.has(fighter.id)) continue;
        if (fighter.vitals.hp > fighter.vitals.maxHp * TOTEMIC_HP_THRESHOLD) continue;
        // Other NPCs do not block the tile (A:1592); with no free tile it retries next tick.
        const tile = healingTotemSpawnTile(fighter, (candidate) => isArenaFootprintWalkable(candidate, 1));
        if (!tile) continue;
        this.totemTargets.add(fighter.id);
        ctx.spawnNpc(
          createHealingTotem({
            id: `colosseum_w${this.wave}_totem_${this.totemCount++}`,
            position: tile,
            target: fighter,
            healAmount: Math.floor(fighter.vitals.maxHp * WAVE_TOTEM_HEAL_FRACTION),
            tick: ctx.tick,
          }),
        );
      }
    }
    for (const totem of ctx.world.getNpcs().filter(healingTotemDefinition.isActor)) advanceHealingTotem(totem, ctx);
    return damages;
  }

  /** Post-tick: the wave's swarms, five ticks in. */
  processPostTick(ctx: EncounterContext, random: () => number): void {
    if (this.beesDueTick === null || ctx.tick < this.beesDueTick) return;
    this.beesDueTick = null;
    const tier = this.modifierState.selection.bees;
    if (!tier) return;
    for (const bee of createBeeSwarms({ tier, tick: ctx.tick, idPrefix: `colosseum_w${this.wave}_bees`, random })) {
      ctx.spawnNpc(bee);
      emitEncounterVisual(ctx.tickEvents, {
        animations: [{ actorId: bee.id, clipId: 'spawn', delayCycles: 0 }],
        projectiles: [],
        graphics: [],
      });
    }
  }

  /**
   * Tc: swarms, orbs and totems are deleted (waveCleanup.ts), and pending Solarflare hits go with the
   * orbs (policy, open question C17).
   */
  completeWave(ctx: EncounterContext): void {
    for (const npc of ctx.world.getNpcs().filter(isColosseumModifierActor)) ctx.despawnNpc(npc.id);
    this.solarflareDamage.reset();
    this.beesDueTick = null;
  }
}
