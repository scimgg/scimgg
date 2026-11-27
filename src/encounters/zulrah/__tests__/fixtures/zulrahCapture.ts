/**
 * Facts extracted from private gameplay captures. Ticks are each capture's own, and no two overlap:
 * - zulrah-packet-data-1.txt (ticks 229-605, contiguous) covers rotation 3 from its magma phase, then
 *   the next rotation's phases 1-4, also rotation 3, the player dying at t567;
 * - zulrah-packet-data-2.txt (ticks 2957-3260) covers rotation 2 from the opening spawn through phase 10;
 * - zulrah-packet-data-3.txt (ticks 810-1094) covers rotation 4 from phase 3's last orb through phase 12's
 *   first barrage, with one phase the wiki's table does not list (`ZULRAH_CAPTURE_EXTRA_PHASE`);
 * - zulrah-packet-data-4.txt (ticks 2006-2301) covers rotation 2 from phase 3's last orb through phase 10,
 *   then the next rotation, rotation 2 again, through phase 3's barrages; the player uses a blowpipe,
 *   then a noxious halberd.
 * Phases are 0-based indexes into `ZULRAH_ROTATIONS`. Tiles are sim tiles, world - (2240, 3008) (map
 * square 35_47), and an NPC's tile is its south-west tile.
 */
/**
 * A tail hit with no knockback (capture 2, t3015): the stun graphic (spotanim 245, stunned_thieving,
 * height 124) plays, "You're stunned!" answers clicks on t3016-t3021, and the player first moves on
 * t3022; capture 4 the same, hit t2064, stunned t2065-t2070, first move t2071. A knockback (not
 * modeled) adds a tick: t3119 to t3127; capture 1, t549 to t557. Capture 4's east knockback, hit
 * t2256, first moved t2265, an upper bound, as stunned clicks were not made every tick.
 */
export const ZULRAH_CAPTURE_TAIL_STUN = {
  hit: 3015,
  lastStunnedTick: 3021,
  firstMove: 3022,
  spotAnimId: 245,
} as const;

