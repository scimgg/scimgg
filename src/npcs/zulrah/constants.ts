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

/**
 * Consecutive ticks a due ranged or magic attack waits for line of sight before Zulrah gives up the
 * phase's remaining attacks (`waitForSight` in zulrah.ts). Simulator policy, approved by the project
 * owner and unverified: it reproduces private gameplay capture zulrah-packet-data-2.txt's east phase
 * (blocked from t3137, dive t3145) but not two in zulrah-packet-data-1.txt (blocked from t301, dive
 * t307; blocked from t363, first special t373).
 */
export const ZULRAH_LOS_GIVE_UP_TICKS = 8;

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
 * Tiles the tail cannot reach while Zulrah is at its middle spot (SW corner 26,65, its tracked tile
 * in private gameplay captures; `ZULRAH_SPOTS.middle`): the three walkable tiles tucked behind each
 * pillar (pillars at 25,63 and 31,63), reported from play. West pillar: its west 24,63, south-west
 * 24,62 and south 25,62; the east pillar mirrors them. The slam still lands; a
 * player standing here takes no damage and no stun.
 */
export const ZULRAH_TAIL_SAFE_TILES: Readonly<{ zulrah: Coordinate; tiles: readonly Coordinate[] }> = {
  zulrah: [26, 65],
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
 * (https://oldschool.runescape.wiki/w/Zulrah/Strategies, Special attacks and Venom clouds). The
 * private gameplay capture zulrah-packet-data-1.txt measures the rest of the timing (t313: orbs
 * 40-90 and 45-120 cycles, clouds at t316 and t317, removed at t346 and t347; 17/17 clouds last 30):
 * - each barrage is 2 orbs, each aimed at its cloud LOC's south-west tile;
 * - the first orb lands 3 ticks after the spit and the second 4, each cloud appearing as its orb lands;
 * - each cloud lasts 30 ticks (18 s).
 * Simulator policy: 1-5 typeless damage on every tick the player stands in at least one.
 */
export const ZULRAH_CLOUD = {
  perBarrage: 2,
  /** Each orb's flight in client cycles, first orb first; it lands `floor(endCycles / 30)` ticks later. */
  orbFlights: [
    { startCycles: 40, endCycles: 90 },
    { startCycles: 45, endCycles: 120 },
  ],
  durationTicks: 30,
  radius: 1,
  damage: [1, 5] as [number, number],
} as const;

/** Ticks from a barrage's spit to orb `index` landing. */
export function zulrahCloudOrbLandTicks(index: number): number {
  const flight = ZULRAH_CLOUD.orbFlights[index];
  if (!flight) throw new RangeError(`No cloud orb ${index}`);
  return Math.floor(flight.endCycles / 30);
}

/**
 * SNAKEBOSS_POISONCLOUD (RuneLite gameval ObjectID, same commit): in the pinned cache a 3x3 loc with no
 * collision and an animated model (seq 1261), matching the wiki's 3x3 cloud.
 */
export const ZULRAH_CLOUD_LOC_ID = 11700;

/** The cloud barrage's dark-green orb: SNAKEBOSS_DOUBLE_ORB (see the projectile note below). */
export const ZULRAH_CLOUD_ORB_SPOTANIM_ID = 1045;

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
  orbStartCycles: 40,
  orbEndCycles: 120,
  orbFlightTicks: 4,
  /** 40 seconds at 0.6 s a tick, rounded up. */
  lifetimeTicks: 67,
  firstAttackDelayTicks: 3,
  attackSpeedTicks: 3,
  magicRange: 7,
  meleeMaxHit: 15,
  magicMaxHit: 13,
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
 * SNAKEBOSS_MINION_SPELL. EGG is the snakeling orb (the wiki's "white orbs"). The private gameplay
 * capture zulrah-packet-data-1.txt settles the rest: ORB (1044) is the ranged attack (t258, at the
 * player, blocked to 0 by Protect from Missiles at t261), DOUBLE_ORB (1045) the cloud barrage's pair
 * of orbs at tiles (t313, clouds at t316/t317), and FIREBALL (1046) the magic attack.
 */
export const ZULRAH_RANGED_SPOTANIM_ID = 1044;
export const ZULRAH_MAGIC_SPOTANIM_ID = 1046;

/**
 * Both attacks fly 40-90 cycles at any distance, so each hit lands 3 ticks after its attack (private
 * gameplay capture zulrah-packet-data-1.txt, all 38 ranged and magic launches, e.g. t258 to t261).
 */
export const ZULRAH_PROJECTILE_TIMING = {
  delay: 40,
  lengthAdjustment: 50,
  stepMultiplier: 0,
  progress: 0,
} as const satisfies ProjAnimTiming;

/**
 * Zulrah faces this tile, the island's base south of the middle spot, every time it emerges between
 * forms, until its first action (private gameplay captures zulrah-packet-data-1.txt, 12/12 emergences,
 * e.g. t255, and zulrah-packet-data-2.txt, 10/10, e.g. t3000). From the middle spot that bearing is
 * south, which is also the opening rise's spawn angle; it holds that until its first action, even once
 * hit (zulrah-packet-data-2.txt: added facing south on t2973, hit on t2981, first barrage on t2984).
 */
export const ZULRAH_SURFACE_FACING_TILE: Coordinate = [28, 62];
