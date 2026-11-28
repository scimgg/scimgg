import { BYPASS_PROTECTION_PRAYER } from '../../core/combat/damageCalculation';
import { lookupPrayerMultipliersFromState } from '../../core/combat/formulas';
import { npcFormulaActor, playerFormulaActor, projectileDistance } from '../../core/combat/npcAttackRequest';
import { emitEncounterVisual } from '../../core/events/encounterVisual';
import { createNpcDefinition, type NpcDefinitionContext } from '../../core/npcs';
import type { Coordinate } from '../../types/simulation';
import { npcProjectileSource } from '../projectileCue';
import { createInfernoActor } from './actors';
import { rollZukBlast } from './blastDamage';
import { emitZukAttack } from './events';
import { presentInfernoDamage } from './presentation';

export type ZukState = {
  lastCastTick: number | null;
  enragedAt: number | null;
  jadSpawned: boolean;
  /** Also latched by practice HP edits that skip healers without actually enraging Zuk. */
  healersSpawned: boolean;
  firstCastTick: number;
  glyphId: string;
};

export type ZukOptions = {
  readonly id: string;
  readonly position: Coordinate;
  readonly spawnTick: number;
  readonly openingDelayTicks: number;
  readonly glyphId: string;
};

type ZukConfig = {
  readonly attacksEnabled: () => boolean;
  readonly targetsPlayer: (glyphX: number, player: Readonly<Coordinate>) => boolean;
  readonly spawnJad: (sourceActorId: string, context: NpcDefinitionContext) => void;
  readonly spawnHealers: (sourceActorId: string, context: NpcDefinitionContext) => void;
};

export const zukDefinition = createNpcDefinition<ZukState, ZukConfig>({
  id: 'inferno-zuk',
  move: false,
  // Zuk's blasts persist past an ordinary source's death, but the boss keeps its own outcome: in the
  // one captured kill (inferno-waves-tbow-69-zuk, death 590 -> 591) no Zuk shot is in flight to the
  // player and none lands after, so none is allowed to. Runs on the kill itself, before the player
  // band could take a blast due that tick.
  onDeathStarted: ({ actor, context }) => context.world.removePendingHitsBySource(actor.id),
  onDamageResolved: ({ actor, damage, config, context }) => {
    presentInfernoDamage({ actor, damage, context });
    if (damage.sourceId !== 'player' || damage.effectiveDamage <= 0 || damage.hpAfter <= 0) return;
    // Strict phase thresholds: docs/encounters/zuk-facts-spec.md#published-rules-used-by-the-evidence-build.
    if (!actor.state.jadSpawned && damage.hpAfter < 480) {
      actor.state.jadSpawned = true;
      config.spawnJad(actor.id, context);
    }
    if (!actor.state.healersSpawned && damage.hpAfter < 240) {
      actor.state.healersSpawned = true;
      actor.state.enragedAt ??= damage.tick;
      config.spawnHealers(actor.id, context);
    }
  },
  tick: ({ actor, config, context }) => {
    const empty = { environmentalDamages: [] };
    if (!actor.alive || !config.attacksEnabled()) return empty;
    const associatedGlyph = context.world.getNpc(actor.state.glyphId);
    const glyph = associatedGlyph?.alive ? associatedGlyph : null;
    const player = context.world.getPlayer();
    if (!player?.alive) return empty;
    // capture inferno-waves-69-zuk-packet-data.txt: control t26, first cast t39, enrage t1065, faster cast t1066.
    if (context.tick < zukNextCastTick(actor.state, context.tick)) return empty;
    actor.state.lastCastTick = context.tick;
    const exposed = !glyph || config.targetsPlayer(glyph.position[0], player.position);
    const target = !glyph || exposed ? player : glyph;
    actor.combat.targetId = target.id;
    // Flight follows the pre-NPC-phase player position, not the glyph endpoint: docs/encounters/zuk-facts-spec.md#3-zuks-attack-cadence.
    const endCycles = 16 + 10 * projectileDistance(actor, player);
    const impactDelayTicks = Math.floor(endCycles / 30);
    emitEncounterVisual(context.tickEvents, {
      animations: [
        { actorId: actor.id, clipId: 'attack', delayCycles: 0 },
        ...(!exposed ? [{ actorId: target.id, clipId: 'hit', delayCycles: endCycles }] : []),
      ],
      projectiles: [
        {
          // 1375 packet fields: capture inferno-waves-69-zuk-packet-data.txt, t39 and the exposed cast t1066.
          spotAnimId: 1375,
          sourcePosition: npcProjectileSource(actor),
          target: { kind: 'actor', actorId: target.id, size: target.size, position: [...target.position] },
          startDelayCycles: Math.min(50, endCycles),
          endDelayCycles: endCycles,
          slope: 0,
          startOffset: exposed ? 128 : 64,
          startHeight: 390,
          endHeight: 124,
        },
      ],
      graphics: exposed
        ? [
            {
              spotAnimId: 131,
              target: { kind: 'actor', actorId: target.id, size: target.size, position: [...target.position] },
              delayCycles: endCycles,
              height: 124,
            },
          ]
        : [],
    });
    emitZukAttack(context, {
      attack: 'zuk_blast',
      sourceId: actor.id,
      targetId: target.id,
      sourcePosition: [actor.position[0] + Math.floor(actor.size / 2), actor.position[1] + Math.floor(actor.size / 2)],
      targetPosition: target.position,
      launchTick: context.tick,
      impactTick: context.tick + impactDelayTicks,
      projectileArrivalCycles: endCycles,
    });
    if (!exposed) return empty;
    const attacker = npcFormulaActor(actor);
    if (!attacker) throw new TypeError('Zuk requires formula stats');
    const roll = rollZukBlast({
      attacker,
      target: playerFormulaActor(player),
      targetEquipmentStats: player.equipmentStats,
      targetPrayerMultipliers: lookupPrayerMultipliersFromState(player.activePrayer, player.boostPrayers),
      random: context.random,
    });
    return {
      environmentalDamages: [],
      npcAttacks: [
        {
          attackerId: actor.id,
          targetId: player.id,
          style: 'typeless',
          attackKind: 'typeless',
          rolledDamage: roll.rolledDamage,
          damageCap: 'none',
          accuracySucceeded: roll.accuracySucceeded,
          impactDelayTicks,
          prayerReduction: BYPASS_PROTECTION_PRAYER,
          // A released projectile (spec section 4).
          sourceDeathPolicy: 'persist',
        },
      ],
    };
  },
  attackTimer: ({ actor, config, context }) => {
    if (!config.attacksEnabled()) return null;
    return {
      nextAttackTick: zukNextCastTick(actor.state, context.tick),
      attackSpeed: zukCastInterval(actor.state, context.tick),
    };
  },
});

export function createZuk(options: ZukOptions) {
  const actor = createInfernoActor('zuk', options.id, options.position);
  actor.spawnTick = options.spawnTick;
  return zukDefinition.createActor(
    { ...actor, lockedFacing: 0 },
    {
      lastCastTick: null,
      enragedAt: null,
      jadSpawned: false,
      healersSpawned: false,
      firstCastTick: options.spawnTick + options.openingDelayTicks,
      glyphId: options.glyphId,
    },
  );
}

/**
 * Zuk casts off its own counter rather than the shared NPC action clock, so this is the only
 * place that turns its state into an absolute tick. The enrage test is `>` because the enrage
 * tick itself still casts at the slow cadence.
 */
export function zukNextCastTick(state: Readonly<ZukState>, tick: number): number {
  if (state.lastCastTick === null) return state.firstCastTick;
  return state.lastCastTick + zukCastInterval(state, tick);
}

export const ZUK_NORMAL_CAST_INTERVAL_TICKS = 10;
const ZUK_ENRAGED_CAST_INTERVAL_TICKS = 7;

function zukCastInterval(state: Readonly<ZukState>, tick: number): number {
  return state.enragedAt !== null && tick > state.enragedAt
    ? ZUK_ENRAGED_CAST_INTERVAL_TICKS
    : ZUK_NORMAL_CAST_INTERVAL_TICKS;
}

/**
 * Reconciles Zuk's cast clock to a shield's own opening epoch (`shieldSpawnTick`), so his cast
 * cadence always stays phase-locked to wherever the shield's patrol actually started - regardless
 * of what Zuk's own clock had drifted to (e.g. a real enrage-speed cast, `zukAttacks` having been
 * disabled and re-enabled while the schedule kept ticking, or a shield reset that only touched the
 * glyph). Only valid pre-enrage: this always reproduces the real encounter-open relationship
 * (first cast = shield spawn + opening delay, docs/encounters/zuk-facts-spec.md) and its ongoing
 * 10-tick cadence, never an earlier slot the real game never reaches.
 *
 * `lastResolvedTick` is the current (already-simulated) world tick, as seen by callers that run
 * between ticks (practice-tool presets and commands, via `SpawnContext.tick` - not an in-tick NPC
 * callback's `context.tick`, which is the tick currently executing). The result is always strictly
 * after it, since the schedule is first checked on the following tick.
 */
export function zukCastTickSyncedToShield(
  shieldSpawnTick: number,
  openingDelayTicks: number,
  lastResolvedTick: number,
): number {
  const opening = shieldSpawnTick + openingDelayTicks;
  if (lastResolvedTick < opening) return opening;
  const elapsedCycles = Math.floor((lastResolvedTick - opening) / ZUK_NORMAL_CAST_INTERVAL_TICKS) + 1;
  return opening + elapsedCycles * ZUK_NORMAL_CAST_INTERVAL_TICKS;
}
