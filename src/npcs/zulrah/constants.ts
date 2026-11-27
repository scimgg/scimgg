import type { ProjAnimTiming } from '../../core/combat/hitDelay';
import type { Coordinate } from '../../types/simulation';

/**
 * Zulrah's three forms. RuneLite gameval (NpcID.java, same commit): SNAKEBOSS_BOSS_RANGED 2042,
 * SNAKEBOSS_BOSS_MELEE 2043, SNAKEBOSS_BOSS_MAGIC 2044. NPC ids also in the OSRS Wiki infobox
 * (https://oldschool.runescape.wiki/w/Zulrah): serpentine (green) 2042, magma (crimson) 2043,
 * tanzanite (blue) 2044. The pinned cache (OpenRS2 2772) names all three "Zulrah", size 5.
 */
export const ZULRAH_RANGED_NPC_ID = 2042;
export const ZULRAH_MELEE_NPC_ID = 2043;
export const ZULRAH_MAGIC_NPC_ID = 2044;

export const ZULRAH_SIZE = 5;

/** Attack speed 3 ticks: wiki infobox. */
export const ZULRAH_ATTACK_SPEED_TICKS = 3;

/** Ranged and magic max hit 41: wiki infobox. */
export const ZULRAH_MAX_HIT = 41;

/**
 * Hits over 50 are replaced with a random 45-50 (https://oldschool.runescape.wiki/w/Zulrah and its
 * Strategies page). Applied to every hit that lands on Zulrah.
 */
export const ZULRAH_HIT_CAP = { above: 50, min: 45, max: 50 } as const;

/**
 * The magma form's tail. The wiki: Zulrah stares at the player's position "for several seconds"
 * before whipping its tail there (Strategies, Forms); 20-30 typeless damage and a stun "for several
 * seconds" if the player has not moved away; it "can be avoided by moving two tiles away" (Zulrah,
 * Fight overview). The rest is simulator policy:
 * - the target is the player's tile when the stare starts;
 * - it lands 6 ticks (3.6 s) after the stare starts;
 * - it hits the 3x3 around the target, so two tiles away is the first safe distance;
 * - the stun is 5 ticks. A stunned player cannot move or attack but can pray, eat and switch gear
 *   (the engine's `playerStunned`), following the wiki's stun status: stuns disable "attacking and
 *   moving" (https://oldschool.runescape.wiki/w/Stun_(status)).
 */
/**
 * The stunned player's graphic: spotanim 245 `stunned_thieving`, at height 124 (private gameplay
 * capture zulrah-packet-data-1.txt, ticks 242, 249 and 549).
 */
export const PLAYER_STUNNED_SPOTANIM_ID = 245;

export const ZULRAH_TAIL = {
  stareTicks: 6,
  radius: 1,
  damage: [20, 30] as [number, number],
  stunTicks: 7,
  /** Ticks after a slam lands before the next stare begins. */
  recoveryTicks: 3,
} as const;

/**
 * Tiles the tail cannot reach while Zulrah is at its middle spot (SW corner 26,64): the three walkable
 * tiles tucked behind each pillar (pillars at 25,63 and 31,63), reported from play. West pillar: its
 * west 24,63, south-west 24,62 and south 25,62; the east pillar mirrors them. The slam still lands; a
 * player standing here takes no damage and no stun.
 */
export const ZULRAH_TAIL_SAFE_TILES: Readonly<{ zulrah: Coordinate; tiles: readonly Coordinate[] }> = {
  zulrah: [26, 64],
  tiles: [
    [24, 63],
    [24, 62],
    [25, 62],
    [32, 63],
    [32, 62],
    [31, 62],
  ],
};

/**
 * Venom from attacks.
 * - Zulrah: "The ranged and magic attacks will envenom the player unless they miss, even if blocked by a
 *   protection prayer" (https://oldschool.runescape.wiki/w/Zulrah/Strategies, Venom). So every accurate
 *   ranged or magic attack envenoms; the tail is not named there, so it does not.
 * - Snakelings: the wiki says only that they "inflict venom with their attacks"
 *   (https://oldschool.runescape.wiki/w/Zulrah), with no chance. Simulator policy: 25% per attack, the
 *   base chance the wiki lists for the venom weapons (https://oldschool.runescape.wiki/w/Venom).
 *   docs/encounters/zulrah-open-questions.md.
 * - The clouds "do not envenom the player" (Strategies, Venom clouds).
 */
export const SNAKELING_VENOM_CHANCE = 0.25;

/**
 * Venom clouds. The wiki: Zulrah spawns them "via a barrage of dark-green orbs"; standing in a
 * cloud's "3x3 area" deals "varying damage per tick"; the clouds "do not envenom the player"
 * (https://oldschool.runescape.wiki/w/Zulrah/Strategies, Special attacks and Venom clouds). It gives
 * no counts, durations or damage figures, so these are simulator policy:
 * - 2 clouds per barrage, landing 3 ticks after it is spat;
 * - each lasts 30 ticks (18 s);
 * - 1-5 typeless damage on every tick the player stands in at least one.
 */
export const ZULRAH_CLOUD = {
  perBarrage: 2,
  flightTicks: 3,
  durationTicks: 30,
  radius: 1,
  damage: [1, 5] as [number, number],
} as const;

/**
 * SNAKEBOSS_POISONCLOUD (RuneLite gameval ObjectID, same commit): in the pinned cache a 3x3 loc with no
 * collision and an animated model (seq 1261), matching the wiki's 3x3 cloud.
 */
export const ZULRAH_CLOUD_LOC_ID = 11700;

/** The cloud barrage's dark-green orb: SNAKEBOSS_ORB, by policy (see the projectile note below). */
export const ZULRAH_CLOUD_ORB_SPOTANIM_ID = 1044;

/** The snakeling orb: SNAKEBOSS_EGG (RuneLite gameval SpotanimID). */

export const ZULRAH_SNAKELING_ORB_SPOTANIM_ID = 1047;

/** The magic snakeling's bolt: SNAKEBOSS_MINION_SPELL (RuneLite gameval SpotanimID). */
export const SNAKELING_MAGIC_SPOTANIM_ID = 1230;

/**
 * Snakelings: SNAKEBOSS_MINION_MELEE 2045 and SNAKEBOSS_MINION_MAGIC 2046 (RuneLite gameval NpcID,
 * same commit; the wiki infobox lists them in that order, https://oldschool.runescape.wiki/w/Snakeling). Each "attacks
 * with either magic or melee, but never both"; 1 HP, size 1, attack speed 3, max hit 15 melee (stab)
 * and 13 magic; protection prayers block them; they die with Zulrah or after "more than 40 seconds"
 * (Zulrah/Strategies, Special attacks). Simulator policy: the orb lands 3 ticks after it is spat, 1-3
 * tiles from the player; the style is a 50/50 draw; the first attack comes 3 ticks after landing; magic
 * reaches 7 tiles.
 */
export const SNAKELING_MELEE_NPC_ID = 2045;
export const SNAKELING_MAGIC_NPC_ID = 2046;
export const SNAKELING = {
  orbFlightTicks: 3,
  /** 40 seconds at 0.6 s a tick, rounded up. */
  lifetimeTicks: 67,
  firstAttackDelayTicks: 3,
  attackSpeedTicks: 3,
  magicRange: 7,
  meleeMaxHit: 15,
  magicMaxHit: 13,
  landingMinDistance: 1,
  landingMaxDistance: 3,
} as const;

/**
 * Snakeling sequences, named by RuneLite gameval (AnimationID.java, same commit): 1721 SNAKEBOSS_PET_IDLE,
 * 2405 SNAKEBOSS_PET_WALK_FORWARD, 1741 SNAKEBOSS_PET_ATTACK, 2413 SNAKEBOSS_PET_SPAWN and 2408
 * SNAKEBOSS_PET_DEATH. Idle and walk are also both ids' NpcType defaults in the pinned cache.
 */
export const SNAKELING_SEQS = { idle: 1721, walk: 2405, attack: 1741, spawn: 2413, death: 2408 } as const;

export type ZulrahForm = 'serpentine' | 'magma' | 'tanzanite';

export const ZULRAH_NPC_ID_BY_FORM: Readonly<Record<ZulrahForm, number>> = {
  serpentine: ZULRAH_RANGED_NPC_ID,
  magma: ZULRAH_MELEE_NPC_ID,
  tanzanite: ZULRAH_MAGIC_NPC_ID,
};

/**
 * Zulrah's sequences, named by RuneLite's gameval table (BSD-2-Clause; runelite/runelite at
 * 9af7b54deaac35b3153af06195d66c1d68fbea5a, runelite-api/.../gameval/AnimationID.java):
 * - 5070 SNAKEBOSS_IDLE (also every form's NpcType stand seq in the pinned cache);
 * - 5069 SNAKEBOSS_ATTACK_ACIDX1, its single spit;
 * - 5071 SNAKEBOSS_SPAWN, the rise that opens the fight;
 * - 5072 SNAKEBOSS_SINKFAST and 5073 SNAKEBOSS_EMERGEFAST, the dive and resurface between forms. Mod
 *   Ash: the dive plays the death animation "forwards and backwards at faster speeds"
 *   (https://oldschool.runescape.wiki/w/Zulrah, Trivia);
 * - 5806 SNAKEBOSS_ATTACK_TAIL_LEFT and 5807 SNAKEBOSS_ATTACK_TAIL_RIGHT, the magma tail;
 * - 5804 SNAKEBOSS_DEATH.
 * Not used: 5068 SNAKEBOSS_ATTACK_ACIDX3 (a triple spit; which turn plays it is an open question) and
 * 5808 SNAKEBOSS_DEFEND.
 */
export const ZULRAH_SEQS = {
  idle: 5070,
  attack: 5069,
  tailLeft: 5806,
  tailRight: 5807,
  spawn: 5071,
  emerge: 5073,
  dive: 5072,
  death: 5804,
} as const;

/**
 * Projectile spotanims. RuneLite gameval (SpotanimID.java, same commit) names them 1044 SNAKEBOSS_ORB,
 * 1045 SNAKEBOSS_DOUBLE_ORB, 1046 SNAKEBOSS_FIREBALL and 1047 SNAKEBOSS_EGG; 1230 is
 * SNAKEBOSS_MINION_SPELL. EGG is the snakeling orb (the wiki's "white orbs"; 1047 is 1044's model
 * recoloured white). Which of ORB and DOUBLE_ORB is the ranged attack and which the cloud barrage's
 * "dark-green orbs" is not settled by any source: simulator policy takes DOUBLE_ORB (1045) as the
 * ranged attack and ORB (1044) as the cloud orb, and FIREBALL (1046) as magic.
 * docs/encounters/zulrah-open-questions.md.
 */
export const ZULRAH_RANGED_SPOTANIM_ID = 1045;
export const ZULRAH_MAGIC_SPOTANIM_ID = 1046;

/**
 * Flight timing, simulator policy: the wiki says Zulrah's damage is rolled when the attack is
 * generated and gives no flight times, so both styles use the generic magic-spell shape
 * (`PROJ_ANIM_TIMINGS.magic_spell`).
 */
export const ZULRAH_PROJECTILE_TIMING = {
  delay: 51,
  lengthAdjustment: -5,
  stepMultiplier: 10,
  progress: 64,
} as const satisfies ProjAnimTiming;
