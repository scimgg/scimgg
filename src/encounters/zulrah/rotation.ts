import type { ZulrahForm } from '../../npcs/zulrah/constants';
import type { ZulrahAction, ZulrahAttackMode, ZulrahStyle } from '../../npcs/zulrah/zulrah';
import type { Coordinate } from '../../types/simulation';

export type ZulrahSpot = 'middle' | 'south' | 'west' | 'east';

/**
 * Zulrah's south-west tile at each named spot, in the local frame of map square 35_47 (the shrine
 * island's north arms run into 35_48, local y 64+), from the private gameplay capture
 * zulrah-packet-data-1.txt. `middle`, `west` and `east` are its tracked tiles (e.g. t255, t298).
 * `south` is derived (t280-t291): the tracked tile after that move reads (33, 50), but Zulrah's
 * projectiles leave from (27, 57), the player's spells at it target (28, 56) = south-west + 2 as at
 * every other spot, and both sides' facing angles are exact for a center of (28.5, 56.5).
 */
export const ZULRAH_SPOTS: Readonly<Record<ZulrahSpot, Coordinate>> = {
  middle: [26, 65],
  south: [26, 54],
  west: [16, 63],
  east: [36, 63],
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
 * Form-change timing, from private gameplay captures (zulrah-packet-data-1.txt, 12/12 form changes,
 * e.g. t252 sink, t255 emerge, t258 first attack; zulrah-packet-data-2.txt, 10/10, e.g. t3018, t3021,
 * t3024; zulrah-packet-data-3.txt and zulrah-packet-data-4.txt, 10/10 each). Each turn takes Zulrah's
 * 3-tick attack speed, each phase has its listed attacks and venom barrages, and every form change is
 * the same sequence:
 * - dive: SINKFAST (5072) at the old spot on tick S;
 * - on S+3 Zulrah moves to its next spot, transforms and plays EMERGEFAST (5073), all on one tick;
 * - its first turn is 3 ticks after that (`ZULRAH_SURFACE_PAUSE_TICKS`);
 * - the player can attack it from 4 ticks after that (`ZULRAH_EMERGE_TICKS`): zulrah-packet-data-2.txt
 *   emerge t3239, attack clicks on t3241 and t3242 made no attack, the attack went off on t3243;
 *   zulrah-packet-data-4.txt the same four times, e.g. refused on t2080 and attacking on t2081 after the
 *   t2077 emerge (the opening, below, is attacked at the same delay).
 * The captures never remove Zulrah. Simulator policy: it is drawn through SINKFAST's 60 cycles
 * (`ZULRAH_DIVE_TICKS`) and hidden for the one tick left (`ZULRAH_UNDERWATER_TICKS`), so the idle
 * pose does not pop back up at the old spot; it cannot be targeted from S.
 * The fight's opening (zulrah-packet-data-2.txt): Zulrah is added at the middle spot on SNAKEBOSS_SPAWN
 * (5071) on t2973; the player's first attack click, on t2977, cast at once (hit for 47 on t2981), so it
 * can be attacked by `ZULRAH_OPENING_RISE_TICKS` after the spawn (earlier is untested); its first
 * barrage is on t2984, `ZULRAH_OPENING_RISE_TICKS + ZULRAH_OPENING_PAUSE_TICKS` after the spawn.
 */
export const ZULRAH_DIVE_TICKS = 2;
export const ZULRAH_UNDERWATER_TICKS = 1;
/** Sink to emerge: 3 ticks. */
export const ZULRAH_FORM_CHANGE_TICKS = ZULRAH_DIVE_TICKS + ZULRAH_UNDERWATER_TICKS;
export const ZULRAH_EMERGE_TICKS = 4;
export const ZULRAH_OPENING_RISE_TICKS = 4;

/**
 * Ticks from a form's emerge to its first turn: 3 (zulrah-packet-data-1.txt, 10 of 11 form changes that
 * acted, once 4, t276 to t280; zulrah-packet-data-2.txt, 8 of 9, once 6 with the player out of sight,
 * t3068 to t3074; zulrah-packet-data-3.txt, 8 of 10, the others with the player out of sight). Not
 * applied to the opening, which has its own pause.
 */
export const ZULRAH_SURFACE_PAUSE_TICKS = 3;

/** Ticks Zulrah waits after its opening rise before its first turn: 11 from the spawn in all (above). */
export const ZULRAH_OPENING_PAUSE_TICKS = 7;
