import type { ZulrahForm } from '../../npcs/zulrah/constants';
import type { ZulrahAction, ZulrahAttackMode, ZulrahStyle } from '../../npcs/zulrah/zulrah';
import type { Coordinate } from '../../types/simulation';

export type ZulrahSpot = 'middle' | 'south' | 'west' | 'east';

/**
 * Zulrah's south-west tile at each named spot, in the local frame of map square 35_47 (the shrine
 * island's north arms run into 35_48, local y 64+).
 *
 * Simulator policy, read off the cache geometry rather than any capture: the island is a U whose base
 * spans local y 60-63 and whose arms are x 22-24 and 32-34 up to y 70. `middle` sits between the arms
 * north of the base, `south` below the base, `west` and `east` just outside each arm. `middle`'s south
 * edge (y 64) is two tiles from the base's front row (y 62), so a halberd (reach 2) hits it from the
 * middle, as reported from play; one tile further north, only the arms were in reach.
 */
export const ZULRAH_SPOTS: Readonly<Record<ZulrahSpot, Coordinate>> = {
  middle: [26, 64],
  south: [26, 55],
  west: [16, 65],
  east: [36, 64],
};

/** A phase's non-attack action: a venom cloud barrage, or a snakeling orb (not modelled yet: idle). */
export type ZulrahSpecial = 'cloud' | 'snakeling';

export type ZulrahPhase = {
  readonly form: ZulrahForm;
  readonly spot: ZulrahSpot;
  /** How its attacks are made; `idle` phases have only specials. */
  readonly mode: ZulrahAttackMode;
  /** Ranged/magic attacks, or tail slams for `tail`. */
  readonly attacks: number;
  readonly jadOpening?: ZulrahStyle;
  /** Specials before the first attack, in the wiki's order. */
  readonly before?: readonly ZulrahSpecial[];
  /** Specials after the last attack, before the dive. */
  readonly after?: readonly ZulrahSpecial[];
};

export type ZulrahRotationNumber = 1 | 2 | 3 | 4;

const C = 'cloud' as const;
const S = 'snakeling' as const;
const n = <T>(count: number, value: T): T[] => Array.from({ length: count }, () => value);

/**
 * The four rotations, from the wiki's phase tables
 * (https://oldschool.runescape.wiki/w/Zulrah/Strategies, Rotations; read from the page's wikitext).
 * `C` is a venom cloud barrage and `S` a snakeling orb, in the order the tables give them. Where the
 * wiki says "an alternating series of N" of the two, this takes N in all, opening on the one it names
 * first.
 *
 * Every rotation opens on the same green middle phase. Each ends on a green middle phase that the
 * wiki says "counts as the first phase of the new rotation", so the next rotation continues from its
 * second phase (`nextZulrahPosition`).
 */
export const ZULRAH_ROTATIONS: Readonly<Record<ZulrahRotationNumber, readonly ZulrahPhase[]>> = {
  // Rotation 1, "Crimson A".
  1: [
    { form: 'serpentine', spot: 'middle', mode: 'idle', attacks: 0, before: n(4, C) },
    { form: 'magma', spot: 'middle', mode: 'tail', attacks: 2 },
    { form: 'tanzanite', spot: 'middle', mode: 'mixed', attacks: 4 },
    { form: 'serpentine', spot: 'south', mode: 'ranged', attacks: 5, after: [S, S, C, C, S, S] },
    { form: 'magma', spot: 'middle', mode: 'tail', attacks: 2 },
    { form: 'tanzanite', spot: 'west', mode: 'mixed', attacks: 5 },
    { form: 'serpentine', spot: 'south', mode: 'idle', attacks: 0, before: [...n(3, C), ...n(4, S)] },
    { form: 'tanzanite', spot: 'south', mode: 'mixed', attacks: 5, after: [S, C, S, C, S] },
    { form: 'serpentine', spot: 'west', mode: 'jad', attacks: 10, jadOpening: 'range', after: n(4, C) },
    { form: 'magma', spot: 'middle', mode: 'tail', attacks: 2 },
    { form: 'serpentine', spot: 'middle', mode: 'ranged', attacks: 5, after: n(4, C) },
  ],
  // Rotation 2, "Crimson B".
  2: [
    { form: 'serpentine', spot: 'middle', mode: 'idle', attacks: 0, before: n(4, C) },
    { form: 'magma', spot: 'middle', mode: 'tail', attacks: 2 },
    { form: 'tanzanite', spot: 'middle', mode: 'mixed', attacks: 4 },
    { form: 'serpentine', spot: 'west', mode: 'idle', attacks: 0, before: [...n(3, C), ...n(4, S)] },
    { form: 'tanzanite', spot: 'south', mode: 'mixed', attacks: 5, after: [S, S, C, C, S, S] },
    { form: 'magma', spot: 'middle', mode: 'tail', attacks: 2 },
    { form: 'serpentine', spot: 'east', mode: 'ranged', attacks: 5 },
    { form: 'tanzanite', spot: 'south', mode: 'mixed', attacks: 5, after: [S, C, S, C, S] },
    { form: 'serpentine', spot: 'west', mode: 'jad', attacks: 10, jadOpening: 'range', after: n(4, C) },
    { form: 'magma', spot: 'middle', mode: 'tail', attacks: 2 },
    { form: 'serpentine', spot: 'middle', mode: 'ranged', attacks: 5, after: n(4, C) },
  ],
  // Rotation 3, "Serp".
  3: [
    { form: 'serpentine', spot: 'middle', mode: 'idle', attacks: 0, before: n(4, C) },
    { form: 'serpentine', spot: 'east', mode: 'ranged', attacks: 5, after: n(3, S) },
    { form: 'magma', spot: 'middle', mode: 'tail', attacks: 2, before: [C, S, C, S, C, S] },
    { form: 'tanzanite', spot: 'west', mode: 'mixed', attacks: 5 },
    { form: 'serpentine', spot: 'south', mode: 'ranged', attacks: 5 },
    { form: 'tanzanite', spot: 'east', mode: 'mixed', attacks: 5 },
    { form: 'serpentine', spot: 'middle', mode: 'idle', attacks: 0, before: [...n(3, C), ...n(3, S)] },
    { form: 'serpentine', spot: 'west', mode: 'ranged', attacks: 5 },
    { form: 'tanzanite', spot: 'middle', mode: 'mixed', attacks: 5, after: [C, C, S, S, S] },
    { form: 'serpentine', spot: 'east', mode: 'jad', attacks: 10, jadOpening: 'magic' },
    { form: 'tanzanite', spot: 'middle', mode: 'idle', attacks: 0, before: n(4, S) },
    { form: 'serpentine', spot: 'middle', mode: 'ranged', attacks: 5, after: n(4, C) },
  ],
  // Rotation 4, "Tanz".
  4: [
    { form: 'serpentine', spot: 'middle', mode: 'idle', attacks: 0, before: n(4, C) },
    { form: 'tanzanite', spot: 'east', mode: 'mixed', attacks: 6, before: n(4, S) },
    { form: 'serpentine', spot: 'south', mode: 'ranged', attacks: 4, after: n(2, C) },
    { form: 'tanzanite', spot: 'west', mode: 'mixed', attacks: 4, before: n(4, S) },
    { form: 'magma', spot: 'middle', mode: 'tail', attacks: 2, after: n(2, C) },
    { form: 'serpentine', spot: 'east', mode: 'ranged', attacks: 4 },
    { form: 'serpentine', spot: 'south', mode: 'idle', attacks: 0, before: [...n(6, S), ...n(3, C)] },
    { form: 'tanzanite', spot: 'west', mode: 'mixed', attacks: 5, after: n(4, S) },
    { form: 'serpentine', spot: 'middle', mode: 'ranged', attacks: 4 },
    { form: 'tanzanite', spot: 'middle', mode: 'mixed', attacks: 4, after: n(3, C) },
    { form: 'serpentine', spot: 'east', mode: 'jad', attacks: 8, jadOpening: 'magic' },
    { form: 'tanzanite', spot: 'middle', mode: 'idle', attacks: 0, before: n(4, S) },
    { form: 'serpentine', spot: 'middle', mode: 'ranged', attacks: 5, after: n(4, C) },
  ],
};

/** A phase's turns in order: its leading specials, its attacks (or tail slams), its trailing specials. */
export function zulrahPhaseActions(phase: ZulrahPhase): ZulrahAction[] {
  const attack: ZulrahAction = phase.mode === 'tail' ? 'tail' : 'attack';
  return [...(phase.before ?? []), ...n(phase.mode === 'idle' ? 0 : phase.attacks, attack), ...(phase.after ?? [])];
}

export const ZULRAH_ROTATION_NUMBERS: readonly ZulrahRotationNumber[] = [1, 2, 3, 4];

/** Where Zulrah is in its rotations. `rotation` is null until phase 1 ends, which all four share. */
export type ZulrahPosition = { readonly rotation: ZulrahRotationNumber | null; readonly index: number };

export const ZULRAH_OPENING_POSITION: ZulrahPosition = { rotation: null, index: 0 };

export function zulrahPhaseAt(position: ZulrahPosition): ZulrahPhase {
  const phase = ZULRAH_ROTATIONS[position.rotation ?? 1][position.index];
  if (!phase) throw new TypeError(`No Zulrah phase ${position.index} in rotation ${position.rotation}`);
  return phase;
}

/**
 * The phase after `position`. Phase 1 ending fixes the first rotation; a rotation's last phase is the
 * next one's phase 1, so the next rotation (freshly chosen) continues from its second phase.
 */
export function nextZulrahPosition(
  position: ZulrahPosition,
  chooseRotation: () => ZulrahRotationNumber,
): ZulrahPosition {
  if (position.rotation === null) return { rotation: chooseRotation(), index: 1 };
  if (position.index + 1 < ZULRAH_ROTATIONS[position.rotation].length) {
    return { rotation: position.rotation, index: position.index + 1 };
  }
  return { rotation: chooseRotation(), index: 1 };
}

/**
 * Transition timings, simulator policy (no source gives them). Timing is built from fixed pieces,
 * never fitted to an overall pace: each turn takes Zulrah's 3-tick attack speed, each phase has its
 * listed attacks and venom barrages, and every form change is the same sequence:
 * - dive: SINKFAST runs 60 cycles, 2 ticks;
 * - underwater: 2 ticks hidden;
 * - emerge: EMERGEFAST runs 60 cycles, 2 ticks untargetable after the new form appears;
 * - surface pause: the bob, then 3 quiet ticks; first turn at `ZULRAH_SURFACE_PAUSE_TICKS` after the emerge.
 * The fight's opening rise (SNAKEBOSS_SPAWN, 105 cycles) keeps 4 ticks, then its own pause.
 */
export const ZULRAH_DIVE_TICKS = 2;
export const ZULRAH_UNDERWATER_TICKS = 2;
export const ZULRAH_EMERGE_TICKS = 2;
export const ZULRAH_OPENING_RISE_TICKS = 4;

/**
 * Ticks from a resurfaced form's emerge ending (its bob) to its first turn. No source gives it; from
 * play she waits 3 full ticks after the bob before attacking, so the first turn lands on bob + 4 (at
 * bob + 3 it reads as one more attack at her normal speed). A POLICY value until measured on video.
 * Not applied to the opening, which has its own pause.
 */
export const ZULRAH_SURFACE_PAUSE_TICKS = 4;

/**
 * Ticks Zulrah waits after its opening rise before its first turn (the fill's first barrage). No
 * source gives it; 12 is the user's pick from play, a POLICY value until it is measured on video
 * (docs/encounters/zulrah-open-questions.md, Timing).
 */
export const ZULRAH_OPENING_PAUSE_TICKS = 12;
