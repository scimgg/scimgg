import type { NpcActor } from '../../core/actors/NpcActor';
import type { EncounterModifierSelection } from '../../core/encounters/encounterFactory';
import type { EncounterContext, EncounterNpcDefeat, EnvironmentalDamage } from '../../core/encounters/types';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { isArenaFootprintWalkable } from '../../core/npcMovementCollision';
import { COLOSSEUM_SPOTANIMS } from '../../npcs/colosseum/constants';
import {
  createWarbander,
  WARBAND_SLOT_OFFSETS,
  WARBANDER_ROLES,
  warbanderDefinition,
} from '../../npcs/colosseum/warband';
import type { Coordinate } from '../../types/simulation';
import { advanceBeeRespawn, beesDefinition, createBeeSwarms } from '../colosseum/modifiers/bees';
import { createSolarflare, SolarflareDamageState, solarflareDefinition } from '../colosseum/modifiers/solarflare';
import {
  advanceHealingTotem,
  createHealingTotem,
  healingTotemDefinition,
  healingTotemSpawnTile,
  TOTEMIC_HP_THRESHOLD,
} from '../colosseum/modifiers/totemic';
import {
  volatilityExplosionCentre,
  volatilityExplosionDamage,
  volatilityExplosionTiles,
  volatilityRingDelay,
} from '../colosseum/modifiers/volatility';
import {
  SOL_BEES_ACTOR_PREFIX,
  SOL_BEES_SPAWN_TICK,
  SOL_QUARTET_ACTOR_ID,
  SOL_QUARTET_SPAWN_TICK,
  SOL_QUARTET_SPAWN_TILES,
  SOL_SOLARFLARE_ACTOR_PREFIX,
  SOL_SOLARFLARE_FIRST_STEP_TICK,
  SOL_SOLARFLARE_REMOVAL_DELAY_TICKS,
  SOL_SOLARFLARE_ROUTES,
  SOL_SOLARFLARE_SPAWN_TICK,
  SOL_TOTEMIC_ACTOR_PREFIX,
  SOL_TOTEMIC_HEAL_AMOUNT,
  SOL_TOTEMIC_RESPAWN_TICKS,
  SOL_VOLATILITY_DELAY_TICKS,
} from './constants';

/** Sol owns modifier spawn/death schedules; shared helpers own hit selection and damage ranges. */
export class SolModifierEffects {
  private spawned = false;
  private beesSpawned = false;
  private quartetSpawned = false;
  private readonly beeRules = beesDefinition.register(undefined);
  private readonly solarflareDamage = new SolarflareDamageState();
  private removeOrbsAt: number | null = null;
  private explosion: { readonly tick: number; readonly position: Coordinate; readonly size: number } | null = null;
  /**
   * When the next totem appears: on Sol's first half-HP tick, then a due tick after the live one is
   * destroyed. Null while a totem is up, since he only ever has one.
   */
  private totemDue: 'half-hp' | number | null = 'half-hp';
  /** Totems spawned this run, so a new totem never reuses a corpse's id. */
  private totemCount = 0;

  constructor(private readonly selection: EncounterModifierSelection) {}

  reset(): void {
    this.spawned = false;
    this.beesSpawned = false;
    this.quartetSpawned = false;
    this.solarflareDamage.reset();
    this.removeOrbsAt = null;
    this.explosion = null;
    this.totemDue = 'half-hp';
    this.totemCount = 0;
  }

  orbs(world: EncounterContext['world']) {
    return world.getNpcs().filter(solarflareDefinition.isActor);
  }

  bees(world: EncounterContext['world']) {
    return world.getNpcs().filter(beesDefinition.isActor);
  }

  warbanders(world: EncounterContext['world']) {
    return world.getNpcs().filter(warbanderDefinition.isActor);
  }

  totems(world: EncounterContext['world']) {
    return world.getNpcs().filter(healingTotemDefinition.isActor);
  }

  /**
   * Totemic: one totem at a time. The first appears on the tick Sol is at or below half HP, as wave
   * totems appear on their target's crossing tick; this runs after NPC damage has landed for that.
   * Once it is destroyed the next appears `SOL_TOTEMIC_RESPAWN_TICKS` later, whatever his HP then
   * (MODEL: the Wiki's "respawn in 2 minutes" names no condition). Totems leave as soon as Sol dies,
   * as wave totems leave 0–1 ticks after their target (18/18).
   */
  advanceTotemic(ctx: EncounterContext, boss: NpcActor | null): void {
    if (!this.selection.totemic) return;
    if (!boss?.alive) {
      for (const totem of this.totems(ctx.world)) ctx.despawnNpc(totem.id);
      return;
    }
    if (this.totemDue === 'half-hp' && boss.vitals.hp <= boss.vitals.maxHp * TOTEMIC_HP_THRESHOLD) {
      this.totemDue = ctx.tick;
    }
    if (typeof this.totemDue === 'number' && ctx.tick >= this.totemDue) {
      // Other NPCs do not block the tile (A:1592); with no free tile it retries next tick.
      const tile = healingTotemSpawnTile(boss, (candidate) => isArenaFootprintWalkable(candidate, 1));
      if (tile) {
        ctx.spawnNpc(
          createHealingTotem({
            id: `${SOL_TOTEMIC_ACTOR_PREFIX}_${this.totemCount++}`,
            position: tile,
            target: boss,
            healAmount: SOL_TOTEMIC_HEAL_AMOUNT,
            tick: ctx.tick,
          }),
        );
        this.totemDue = null;
      }
    }
    for (const totem of this.totems(ctx.world)) advanceHealingTotem(totem, ctx);
  }

  /**
   * "Destroyed" is the player's kill, timed from the killing hit's tick. Of Run A's 55 wave totems,
   * 43 were killed and the other 12 left with their dying target.
   */
  onNpcDefeated(defeat: EncounterNpcDefeat, world: EncounterContext['world']): void {
    const npc = world.getNpc(defeat.npcId);
    if (npc && healingTotemDefinition.isActor(npc)) this.totemDue = defeat.tick + SOL_TOTEMIC_RESPAWN_TICKS;
  }

  /** A boss-HP preset starts Totemic over: its totem goes, and the half-HP trigger re-arms. */
  resetTotemic(ctx: Pick<EncounterContext, 'world' | 'despawnNpc'>): void {
    for (const totem of this.totems(ctx.world)) ctx.despawnNpc(totem.id);
    this.totemDue = 'half-hp';
  }

  advanceRespawns(ctx: EncounterContext): void {
    for (const bee of this.bees(ctx.world)) advanceBeeRespawn(bee, ctx.tick);
  }

  /** Bees and the Quartet warbander leave with the crystals once Sol is dead. */
  cleanupNpcs(ctx: EncounterContext): void {
    for (const npc of [...this.bees(ctx.world), ...this.warbanders(ctx.world)]) ctx.despawnNpc(npc.id);
  }

  shouldMoveOrbs(tick: number): boolean {
    return this.removeOrbsAt === null || tick < this.removeOrbsAt;
  }

  onSolDefeated(tick: number, position: Readonly<Coordinate>, size: number): void {
    this.removeOrbsAt = tick + SOL_SOLARFLARE_REMOVAL_DELAY_TICKS;
    if (this.selection.volatility) {
      // Capture the death footprint; no later movement or practice edit can relocate the blast.
      this.explosion = { tick: tick + SOL_VOLATILITY_DELAY_TICKS, position: [...position], size };
    }
  }

  processTick(ctx: EncounterContext, bossAlive: boolean, random: () => number): EnvironmentalDamage[] {
    const tier = this.selection.solarflare;
    // Like Sol's regular attacks, this runs after NPC movement but before player movement.
    // Consume actual NPC movement records, not predicted routes, so suppressed moves cannot hit.
    const orbIds = new Set(this.orbs(ctx.world).map((orb) => orb.id));
    const movements = [...(ctx.npcMovements?.values() ?? [])].filter((move) => orbIds.has(move.npcId));
    const damages = tier ? this.solarflareDamage.resolveTick(ctx, movements, tier) : [];
    if (bossAlive && this.selection.bees && !this.beesSpawned && ctx.tick >= SOL_BEES_SPAWN_TICK) {
      this.beesSpawned = true;
      for (const bee of createBeeSwarms({
        tier: this.selection.bees,
        tick: ctx.tick,
        idPrefix: SOL_BEES_ACTOR_PREFIX,
        random,
      })) {
        ctx.spawnNpc(bee);
        emitEncounterVisual(ctx.tickEvents, {
          animations: [{ actorId: bee.id, clipId: 'spawn', delayCycles: 0 }],
          projectiles: [],
          graphics: [],
        });
      }
    }
    if (bossAlive && this.selection.quartet && !this.quartetSpawned && ctx.tick >= SOL_QUARTET_SPAWN_TICK) {
      // One warbander for the whole fight: it is never replaced after dying. Both draws come from
      // the encounter stream only while Quartet is on, so other runs keep their seeded rolls.
      this.quartetSpawned = true;
      const role = WARBANDER_ROLES[Math.floor(random() * WARBANDER_ROLES.length)]!;
      const tile = SOL_QUARTET_SPAWN_TILES[Math.floor(random() * SOL_QUARTET_SPAWN_TILES.length)]!;
      ctx.spawnNpc(
        createWarbander({
          id: SOL_QUARTET_ACTOR_ID,
          role,
          position: tile,
          spawnTick: ctx.tick,
          slotOffset: WARBAND_SLOT_OFFSETS.quartet,
          // UNVERIFIED: with its south slot blocked it falls back to the nearest reachable tile in reach.
          fallbackOffsets: [],
          relentless: this.selection.relentless ?? 0,
        }),
      );
    }
    if (bossAlive) {
      for (const bee of this.bees(ctx.world)) {
        damages.push(...this.beeRules.resolveLocalEffects(bee, { ...ctx, random }));
      }
    }
    if (tier && bossAlive && !this.spawned && ctx.tick >= SOL_SOLARFLARE_SPAWN_TICK) {
      this.spawned = true;
      for (const [index, corners] of SOL_SOLARFLARE_ROUTES.entries()) {
        ctx.spawnNpc(
          createSolarflare({
            id: `${SOL_SOLARFLARE_ACTOR_PREFIX}_${index}`,
            corners,
            tier,
            spawnTick: ctx.tick,
            firstStepTick: SOL_SOLARFLARE_FIRST_STEP_TICK,
          }),
        );
      }
    }
    if (this.removeOrbsAt !== null && ctx.tick >= this.removeOrbsAt) {
      for (const orb of this.orbs(ctx.world)) ctx.despawnNpc(orb.id);
      this.removeOrbsAt = null;
    }
    const explosion = this.explosion;
    const volatility = this.selection.volatility;
    if (!explosion || !volatility || ctx.tick < explosion.tick) return damages;
    this.explosion = null;
    const centre = volatilityExplosionCentre(explosion.position, explosion.size);
    emitEncounterVisual(ctx.tickEvents, {
      animations: [],
      projectiles: [],
      graphics: [
        {
          spotAnimId: COLOSSEUM_SPOTANIMS.finalBossExplosion,
          target: { kind: 'tile', position: centre },
          delayCycles: 0,
          height: 0,
        },
        ...volatilityExplosionTiles(explosion.position, explosion.size, volatility).map((position) => ({
          spotAnimId: COLOSSEUM_SPOTANIMS.fireblastImpact,
          target: { kind: 'tile' as const, position },
          delayCycles: volatilityRingDelay(position, centre),
          height: 0,
        })),
      ],
    });
    damages.push(...volatilityExplosionDamage(explosion.position, explosion.size, volatility, ctx.playerPos));
    return damages;
  }
}
