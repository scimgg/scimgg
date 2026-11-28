import type { NpcProjectileCue } from '../../core/events/encounterVisual';

/**
 * Fortis Colosseum actor identities, cache ids, and the parameters of Sol's and the crystals' own
 * behavior. Encounter sequencing (phases, sand, beam rounds) keeps its values in
 * `src/encounters/solHeredit/constants.ts`.
 *
 * Every id below is a clean RuneLite gameval name (RuneLite `runelite-api/.../gameval`,
 * BSD-2-Clause per RuneLite's `LICENSE`) cross-checked against the Sol captures.
 * Tick-cited occurrences live in `docs/encounters/sol-heredit-capture-analysis.md` section 7.
 * Timing status tags follow `docs/encounters/sol-heredit-facts-spec.md#timing-verification-ledger`;
 * VERIFIED denotes repeated capture agreement, not universality.
 */

export const SOL_NPC_ID = 12821; // COLOSSEUM_SOL_P1
export const SOL_SIZE = 5;

// --- Regular attacks -------------------------------------------------------------------------

/** VERIFIED: warning to ground emission is +3 in all 114 bursts; visuals alone do not prove damage. */
export const TELEGRAPH_TO_GROUND_TICKS = 3;

/** VERIFIED: cooldown follows the attack just used; spear 7/6 slow/fast (22/33 pairs). */
export const SPEAR_COOLDOWN_TICKS = 7;
/** VERIFIED: shield 6/5 slow/fast (19/28 uninterrupted pairs across K/M/N). */
export const SHIELD_COOLDOWN_TICKS = 6;
/** VERIFIED: both regular cooldowns drop by one at the observed 75% transition. */
export const FAST_PHASE_COOLDOWN_REDUCTION = 1;

/**
 * Wiki infobox: up to 44 typeless AoE, not reduced by Protect from Melee (strategy page: 45).
 * VERIFIED max: 37 unprayed hits (L 25, N 4, A 8) peak at 44 (x3). Relentless does not raise it:
 * L's 25 hits under Relentless II include two 44s and none of 45-47.
 */
export const REGULAR_AOE_MAX_HIT = 44;

// --- Triple attack ---------------------------------------------------------------------------

/** VERIFIED: charge-relative short hits +3/+6/+9 (4 complete triples). */
export const TRIPLE_HIT_OFFSETS_SHORT = [3, 6, 9] as const;
/** VERIFIED: charge-relative long hits +3/+6/+10 (4 complete triples), after the 50% transition. */
export const TRIPLE_HIT_OFFSETS_LONG = [3, 6, 10] as const;

/**
 * Wiki infobox max hits: 15/25/35 above 50% HP, 15/30/45 at or below. Without Relentless they are
 * fixed (Run A's unprayed hits were exactly 15/25/35); Relentless adds its bonus on top.
 */
export const TRIPLE_DAMAGE_SHORT = [15, 25, 35] as const;
export const TRIPLE_DAMAGE_LONG = [15, 30, 45] as const;

/**
 * VERIFIED: telegraph to next action is 12 after a long triple (17/17, e.g. L:5140->5152) and after
 * a short one in the slow phase (15/15, e.g. L:3990->4002), but 11 after a short triple in the fast
 * 75-50% phase (10/10: L 9/9 from L:4575->4586, plus M:8380->8391).
 */
export const TRIPLE_COOLDOWN_TICKS = 12;
export const SHORT_FAST_TRIPLE_COOLDOWN_TICKS = 11;

/**
 * A failed hit refuses a same-tick retry (A:5248 "You've been injured and can't use that prayer!").
 * The engine's exclusive upper bound H+1 blocks H only. The longer lockout after Sol drops an early
 * prayer lives in sol.ts and is an UNVERIFIED model.
 */
export const TRIPLE_PRAYER_LOCKOUT_TICKS = 1;

// --- Grapple ---------------------------------------------------------------------------------

/**
 * VERIFIED: the window closes at shout+4, where 9 of the 10 captured grapples resolved (K/M/N 4,
 * L 5 perfect parries). A correct defense before then resolves on its own tick (L:4701, shout+3, n=1).
 */
export const GRAPPLE_WINDOW_TICKS = 4;

/** VERIFIED: shout to next attack is +7 in all 10 grapples (e.g. M:8436->8443, L:4698->4705). */
export const GRAPPLE_COOLDOWN_TICKS = 7;

/**
 * Wiki Sol_Heredit infobox (oldid=15303373) lists 44 for the grapple; Strategies (oldid=15354864)
 * says "up to 45". Simulator policy: 44; no capture shows a failed grapple. UNVERIFIED: a fail rolls the
 * higher of two 0..44 rolls, as the regular AoE does (grapple.ts). Failing also moves the targeted
 * item to the inventory (not modeled).
 */
export const GRAPPLE_FAIL_MAX_HIT = 44;

/** WIKI-ONLY: next attack within five ticks is a max hit; expiry endpoints/consumption unverified. */
export const PERFECT_PARRY_REWARD_TICKS = 5;

// --- Relentless modifier ---------------------------------------------------------------------

/** The selected Relentless tier; 0 when the modifier is off. */
export type ColosseumRelentlessRank = 0 | 1 | 2 | 3;

/**
 * Wiki /w/Fortis_Colosseum/Modifiers: enemy max hits rise by 1/3/6. Rank II VERIFIED on Sol's triple:
 * L's unprayed hits were 18/28/48 (L:5584, L:4511, L:5150/5201/5400), Wiki+3, where Relentless-0
 * Run A had exactly 15/25/35. Ranks I and III are UNVERIFIED Wiki values.
 */
export const RELENTLESS_MAX_HIT_BONUS = [0, 1, 3, 6] as const satisfies Record<ColosseumRelentlessRank, number>;

/**
 * Wiki /w/Fortis_Colosseum/Modifiers: enemies bypass 33%/66% of the player's Defence level, and rank
 * III ignores accuracy checks (so its 100 is moot: those attacks always hit). UNVERIFIED in captures;
 * rounding the bypassed levels down is a MODEL.
 */
export const RELENTLESS_DEFENCE_BYPASS_PERCENT = [0, 33, 66, 100] as const satisfies Record<
  ColosseumRelentlessRank,
  number
>;

// --- Selection models ------------------------------------------------------------------------

/**
 * MODEL: an even seeded spear/shield choice; the captured split is indistinguishable from a coin
 * flip (docs/encounters/sol-heredit-unverified.md#sol-attacks--selection).
 */
export const SPEAR_SELECTION_CHANCE = 0.5;

/**
 * MODEL of whether a non-forced slot below 90% is a special (triple or grapple); phase 0 has none.
 * With g the regular attacks since the last special (forced openers count): never at g < 2, then
 * 2% rising 7.5% per further regular, capped at 60%. Before the fight's first special the chance
 * is a flat 25%. No phase or Relentless dependence. The cap is unconstrained by the captures.
 * Fit: docs/encounters/sol-heredit-capture-analysis.md#13-capture-l-long-fight-audit.
 */
export const SPECIAL_REFRACTORY_REGULARS = 2;
export const SPECIAL_CHANCE_AFTER_REFRACTORY = 0.02;
export const SPECIAL_CHANCE_STEP = 0.075;
export const SPECIAL_CHANCE_CAP = 0.6;
export const FIRST_SPECIAL_CHANCE = 0.25;

/** MODEL: once the grapple is unlocked, its share of specials (10/38 observed; same fit doc). */
export const GRAPPLE_SHARE_OF_SPECIALS = 10 / 38;

export const BEAM_CRYSTAL_NPC_ID = 12824; // COLOSSEUM_BEAM_CRYSTAL
export const BEAM_CRYSTAL_SIZE = 1;
export const SOLARFLARE_NPC_ID = 12826; // M8276: COLOSSEUM_SOLAR_FLARE
export const BEES_NPC_ID = 12823; // B:2366 and A:4984: COLOSSEUM_MODIFIER_BEES
export const HEALING_TOTEM_NPC_ID = 12825; // A:850 onward: COLOSSEUM_HEALING_TOTEM
// Fremennik warband (no-sol t1451 and every wave spawn in the three wave captures). Cache rev 232:
// all size 1, run seq -1; archer/berserker idle 808 walk 819, seer idle 813 walk 1205.
export const WARBAND_ARCHER_NPC_ID = 12814; // COLOSSEUM_WARBANDER_RANGED_FEMALE
export const WARBAND_SEER_NPC_ID = 12815; // COLOSSEUM_WARBANDER_MAGE_MALE
export const WARBAND_BERSERKER_NPC_ID = 12816; // COLOSSEUM_WARBANDER_MELEE_MALE

/** Every charge and fire batch is exactly 13 tiles running inward from the crystal. */
export const BEAM_LINE_LENGTH = 13;

/** VERIFIED: one tile every two ticks; warning/charge/fire holds replay across all three captures. */
export const CRYSTAL_STEP_INTERVAL_TICKS = 2;

export const SOL_ACTOR_ID = 'sol_heredit';
/** His name as chat prints it, both as the public-chat speaker and in "Sol Heredit: " game messages. */
export const SOL_CHAT_NAME = 'Sol Heredit';
export const BEAM_CRYSTAL_ACTOR_PREFIX = 'sol_crystal';

/** VERIFIED: `colosseum_holy_fire` LOC appears emission+5 (29 batches); not proof of damage onset. */
export const MOLTEN_SAND_LOC_ID = 50746;

export const COLOSSEUM_SEQS = {
  sol: {
    idle: 10874, // NPC_COLOSSI_FINALBOSS_01_IDLE
    walk: 10878, // NPC_COLOSSI_FINALBOSS_01_WALK
    arenaJump: 10876,
    arenaLand: 10877,
    /** VERIFIED: warning to ground effects is +3 in all 114 observed bursts. */
    spearTelegraph: 10883,
    shieldTelegraph: 10885,
    grappleTelegraph: 10884,
    /** VERIFIED: short triple uses +3/+6/+9 (4 complete samples), above the 50% transition. */
    tripleShort: 10887,
    /** VERIFIED: long triple uses +3/+6/+10 (4 complete samples), after the 50% transition. */
    tripleLong: 10886,
    death: 10888,
  },
  crystal: {
    spawn: 10798,
    idle: 10799,
    despawn: 10800,
    charge: 10801,
    attack: 10802,
  },
  // Cache revision 232 NPC 12826: model 51242, size 1, idle and walk both 10817, no actions.
  // Cache seq 10817 (disk-2485): 41 frames, frameStep 21, sound 7980 on frame 1 — frames 0-19
  // are a one-time flare-up and the loop resumes at frame 20.
  solarflare: { idle: 10817 },
  // Cache revision 232: model 53132, idle/walk 10822. Spawn/attack/despawn also observed in B.
  bees: { spawn: 10821, idle: 10822, attack: 10823, despawn: 10824 },
  // Cache revision 232 NPC 12825: model 51251, size 1, idle/walk 10827. Run A's only totem
  // `sequence` is the attack, 53/53 launches; the cache has no spawn or death seq for it.
  totem: { idle: 10827, attack: 10828 },
  // Gameval names and capture `sequence` lines agree (e.g. no-sol t1451 spawn, t1459 death).
  // All frame-based in cache rev 232; each death clip plays 47 cycles, then holds 20000.
  warband: {
    spawn: 10861, // NPC_HUMAN_STAFFREADY_SPAWN, shared by all three
    // Idle is the cache NpcType's stand (rev 232); walk stays the cache default.
    archer: { idle: 808, attack: 10850, defend: 10851, death: 10852 },
    seer: { idle: 813, attack: 10853, defend: 10854, death: 10855 },
    berserker: { idle: 808, attack: 10856, defend: 10857, death: 10858 },
  },
} as const;

export const COLOSSEUM_SPOTANIMS = {
  /**
   * The three melee ground effects are one visual set, NOT three mechanical shapes: all three
   * appear together in every burst and partition its tiles, with the split varying between two
   * bursts of identical geometry (capture analysis section 1.1).
   */
  solMelee: [2669, 2670, 2671],
  solLand: 2666,
  solDeath: 2680,
  tripleTelegraphShort: 2668,
  tripleTelegraphLong: 2667,
  crystalCharge: [2689, 2690, 2691, 2692],
  crystalFire: [2693, 2694, 2695, 2696],
  crystalImpact: 2697,
  sunfireLightning: 2698,
  finalBossExplosion: 2724,
  fireblastImpact: 131, // M8521 / N7790: FIREBLAST_IMPACT
  warbandArrow: 9, // no-sol t1462: IRON_ARROW_TRAVEL, the archer's projectile
  warbandFireblast: 130, // no-sol t1461: FIREBLAST_TRAVEL, the seer's projectile
  totemProjectile: 2687, // A:946: VFX_COLOSSEUM_TOTEM_PROJECTILE_01
  totemImpact: 2688, // A:947: VFX_COLOSSEUM_TOTEM_IMPACT_01, on the healed NPC as the heal lands
  // Waves 1-11. The emitting species and Volatility read these; keep them literal so the cache trim
  // (`scripts/discoverCacheUsage.ts`) finds them, as it finds nothing in tables that only reference them.
  javelinSpearhead: 2673, // NPC_COLOSSI_JAVELIN_01_SPEARHEAD, the ranged projectile
  javelinArtilleryFire: 2676, // NPC_COLOSSI_JAVELIN_01_ARTILLERY_FIRE, on the colossus as it casts
  javelinArtilleryFalling: 2674, // NPC_COLOSSI_JAVELIN_01_ARTILLERY_SLOW, the falling javelin on its tile
  javelinArtilleryShadow: 1446, // GARGBOSS_DEBRIS_SHADOW_90, the warning beside it
  javelinArtilleryBlast: 2265, // WILD_FALLOFF_METEOR_BLAST_RED, the landing
  shockwaveProjectile: 2520, // VFX_VARDORVIS_HEAD_PROJECTILE_MAGIC_01
  shockwaveImpact: 2254, // AKKHA_MAGIC_IMPACT
  manticoreMagicOrb: 2681, // VFX_MANTICORE_01_PROJECTILE_MAGIC_01, held and thrown
  manticoreRangedOrb: 2683, // VFX_MANTICORE_01_PROJECTILE_RANGED_01
  manticoreMeleeOrb: 2685, // VFX_MANTICORE_01_PROJECTILE_MELEE_01
  shamanCasting: 1458, // WATERSURGE_CASTING
  shamanTravel: 1459, // WATERSURGE_TRAVEL
  shamanImpact: 1460, // WATERSURGE_IMPACT
  minotaurHeal: 444, // TZHAAR_HEAL, on the healed NPC (C:2478)
  volatilityHumanExplosion: 2713, // VFX_COLOSSEUM_*_EXPLOSION_01 on a Volatility death, by gib
  volatilityManticoreExplosion: 2721,
  volatilityColossiExplosion: 2722,
  volatilityMinotaurExplosion: 2723,
} as const;

/**
 * VERIFIED: all 53 totem projectile records in Run A carry these exact fields, each on its
 * attack-sequence tick and aimed at the NPC being healed (e.g. A:946). All flew from a tile
 * diagonal to the target's footprint, so the distance scaling of `endtime` is unobserved. Arrival
 * is six ticks later; see `TOTEM_HEAL_FLIGHT_TICKS` for when the heal itself lands.
 */
export const HEALING_TOTEM_PROJECTILE = {
  spotAnimId: COLOSSEUM_SPOTANIMS.totemProjectile,
  startDelayCycles: 90,
  endDelayCycles: 180,
  slope: 0,
  startOffset: 0,
  startHeight: 220,
  endHeight: 138,
} as const satisfies Omit<NpcProjectileCue, 'sourcePosition' | 'target'>;

/**
 * VERIFIED (distance 1 only): every captured warband projectile record carries these exact fields.
 * It launches on the attack sequence's tick (or a same-tick defend), landing at cycle 30 for the next tick's hit
 * (`npcHitDelayFromEndTime(30)` = 1). All were fired from one tile away, so the distance scaling of
 * `endtime` is unobserved. Packet `angle` is `slope` and `progress` is `startOffset`.
 * Evidence: docs/encounters/sol-heredit-facts-spec.md#fremennik-warband-and-quartet (Projectiles).
 */
export const WARBAND_PROJECTILES = {
  archer: {
    spotAnimId: COLOSSEUM_SPOTANIMS.warbandArrow,
    startDelayCycles: 10,
    endDelayCycles: 30,
    slope: 15,
    startOffset: 64,
    startHeight: 163,
    endHeight: 146,
  },
  seer: {
    spotAnimId: COLOSSEUM_SPOTANIMS.warbandFireblast,
    startDelayCycles: 10,
    endDelayCycles: 30,
    slope: 16,
    startOffset: 64,
    startHeight: 172,
    endHeight: 124,
  },
} as const satisfies Record<'archer' | 'seer', Omit<NpcProjectileCue, 'sourcePosition' | 'target'>>;

/**
 * VERIFIED: the seer's launch tick sets `spotanim fireblast_impact (131), delay=30, height=124` on
 * the player (e.g. C:1645, A:853); the delay is the projectile's `endtime`. The archer's arrows set
 * no impact spotanim. Evidence and exceptions: docs/encounters/sol-heredit-facts-spec.md (Projectiles).
 */
export const WARBAND_SEER_IMPACT_HEIGHT = 124;
