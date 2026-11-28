// https://oldschool.runescape.wiki/w/Orb_of_Darkness
export const DUKE_ORB_NPC_ID = 11708;
// The Acid pool LOC in cache 2772 matches the green center and lighter rim at 1:56.
// https://www.youtube.com/watch?v=YwYTtOvnuck&t=116s
export const DUKE_BILE_POOL_LOC_ID = 30032;

export const DUKE_FIRST_ATTACK_DELAY_TICKS = 5;
// https://oldschool.runescape.wiki/w/Duke_Sucellus/Strategies#Awakened_mode
export const DUKE_POISON_TOLERANCE = 370;
// Regular-mode feed captures: 20261126-235612-Duke-Sucellus.jsonl:6500, :6533 and :6568.
export const DUKE_POISON_PER_DOSE = 125;
export const DUKE_WAKE_AFTER_FEED_TICKS = 1;
// 20261126-232238-Duke.jsonl:4330–4432 and 20261127-005253-Duke-Sucellus_2.jsonl:12874–12983.
// The arrival delay includes the windup in both phases.
export const DUKE_MAGIC_FLIGHT_TICKS = 4;
// 20261126-232238-Duke.jsonl:6479–6510.
export const DUKE_GAS_FLIGHT_TICKS = 3;
export const DUKE_MAGIC_PROJECTILE = {
  startCycle: 50,
  endCycle: 120,
  startHeight: 350,
  endHeight: 100,
  startOffset: 32,
  slope: 5,
} as const;
export const DUKE_VENT_PROJECTILE = {
  ...DUKE_MAGIC_PROJECTILE,
  startCycle: 20,
  endCycle: 90,
  endHeight: 0,
} as const;
// Both bile casts in 20261126-232238-Duke.jsonl (lines 6588 and 7577).
export const DUKE_BILE_PROJECTILE = {
  startCycle: 32,
  endCycle: 51,
  startHeight: 130,
  endHeight: 160,
  startOffset: 32,
  slope: 0,
} as const;
// 20261126-232238-Duke.jsonl:6479–6559 and tick 133. Idle replaces the spawn graphic after one tick.
export const DUKE_VENT_ARM_TICKS = 1;
export const DUKE_VENT_ACTIVE_TICKS = 14;
// 20261127-012348-Duke-Sucellus_3.jsonl:12754–13086. During enrage the fade starts at windup +16.
export const DUKE_ENRAGED_VENT_ACTIVE_TICKS = 12;
// Cache 2772: idle (2432) runs 60 cycles and fade (2433) runs 30.
export const DUKE_VENT_SMOKE_CYCLE_TICKS = 2;
export const DUKE_VENT_FADE_TICKS = 1;
// The step-back routes in 20261126-232238-Duke.jsonl:5193–5237 and :6185–6235
// re-enter on windup +2. Resolve shatter before that tick's movement.
export const DUKE_SLAM_IMPACT_DELAY_TICKS = 2;
// 20261127-014756-Duke-Sucellus_5.jsonl:11238–11350. Windup 354, result 358, hit 359.
export const DUKE_GAZE_COVER_CHECK_TICKS = 4;
export const DUKE_GAZE_HIT_DELAY_TICKS = 1;
export const DUKE_GAZE_DURATION_TICKS = 6;

// Pinned cache 2772 (build 242). Names corroborated by RuneLite gameval AnimationID and
// SpotanimID at 9af7b54deaac35b3153af06195d66c1d68fbea5a.
export const DUKE_MAP_SQUARE = { x: 47, y: 100 };
export const DUKE_SEQS = {
  asleep: 10174,
  awake: 10175,
  slam: 10176,
  magic: 10177,
  fastMagic: 10178,
  wake: 10179,
  gaze: 10180,
  death: 10181,
} as const;
export const DUKE_WAKE_ANIMATION_TICKS = 3; // 90 client cycles in sequence 10179.
// Pinned cache 2772, DUKE_SIGHT interface 829 component 2. RuneLite's gameval AnimationID
// at 9af7b54deaac35b3153af06195d66c1d68fbea5a names the chthonian overlay's appear/disappear clips.
export const DUKE_GAZE_OVERLAY = { modelId: 48318, sequenceIds: [10216, 10215] } as const;
export const DUKE_SPOT_ANIMS = {
  orbBurst: 379, // 20261127-005253-Duke-Sucellus_2.jsonl:8559, :8739 and :8794.
  ventSpawn: 2431,
  ventIdle: 2432,
  ventDespawn: 2433,
  magicProjectile: 2434,
  magicImpact: 2435,
  spitProjectile: 2436,
  bileProjectile: 1354,
  npcIcicles: 2439,
  groundIciclesOuter: 2440,
  groundIciclesMidOuter: 2441,
  groundIciclesMidInner: 2442,
  groundIciclesCenter: 2443,
} as const;

// 20261126-232238-Duke.jsonl:4697–4704, west to east along the front row.
export const DUKE_GROUND_ICICLES = [
  DUKE_SPOT_ANIMS.groundIciclesOuter,
  DUKE_SPOT_ANIMS.groundIciclesMidOuter,
  DUKE_SPOT_ANIMS.groundIciclesMidInner,
  DUKE_SPOT_ANIMS.groundIciclesCenter,
  DUKE_SPOT_ANIMS.groundIciclesMidInner,
  DUKE_SPOT_ANIMS.groundIciclesMidOuter,
  DUKE_SPOT_ANIMS.groundIciclesOuter,
] as const;
