import { PRAYER_CATEGORIES, type PrayerType, prayersConflict } from '../types/simulation';

/** Prayer clicks remain discrete toggles evaluated against live state when processed. */
export type QueuedPrayerAction =
  // Non-null prayers are prayer-button toggles. Null remains an explicit clear of the whole slot
  // or set: every protection prayer, or every boost prayer.
  | { readonly type: 'protection'; readonly prayer: PrayerType | null }
  | { readonly type: 'boost'; readonly prayer: PrayerType | null }
  // An independent prayer stacks with everything, so its click is a toggle of one membership
  // rather than an assignment to a slot. There is no null form: clearing them all is what
  // turning quick prayers off does.
  | { readonly type: 'independent'; readonly prayer: PrayerType }
  | { readonly type: 'quickPrayers'; readonly selections: readonly PrayerType[] };

export interface PrayerInputState {
  readonly protection: PrayerType | null;
  /** Conflict-free; insertion-ordered like {@link independent}. */
  readonly boost: readonly PrayerType[];
  /** Unordered in meaning, but kept deduplicated and in insertion order so replays stay byte-stable. */
  readonly independent: readonly PrayerType[];
  readonly quickPrayersActive: boolean;
}

export interface PrayerChange {
  readonly from: PrayerType | null;
  readonly to: PrayerType | null;
}

export type PrayerTransition = PrayerChange & {
  /**
   * For the two sets, `to` is the prayer that lit and `from` the first lit prayer it turned off, or
   * null. See {@link prayerSetChanges}.
   */
  readonly slot: 'protection' | 'boost' | 'independent';
};

export interface PrayerInputOutcome extends PrayerInputState {
  /** True when at least one action in the batch could change the protection slot. */
  readonly protectionTouched: boolean;
  /** True when at least one action in the batch could change the boost set. */
  readonly boostTouched: boolean;
  /** True when at least one action in the batch could change independent membership. */
  readonly independentTouched: boolean;
  /**
   * Prayers that went from inactive to active while resolving the batch and are
   * still active at the end. Only these earn the drain grace period — a prayer
   * that was already burning and never transitioned does not, which stops rejected
   * or otherwise ineffective inputs from silently buying free prayer.
   */
  readonly activated: readonly PrayerType[];
  /** Prayers whose activation was refused because the player had no prayer points. */
  readonly rejected: readonly PrayerType[];
  /** Every actual per-slot value change, in input replay order. */
  readonly transitions: readonly PrayerTransition[];
}

/**
 * The changes that take a prayer set from `before` to `after`, one per prayer that lit plus one per
 * prayer that went dark on its own.
 *
 * A prayer that lit is paired with the first prayer it turned off by conflict, the way a slot
 * swap always was: one click, one change, one sound. Any further prayers the same arrival turned
 * off are not reported separately. Prayers leaving without being displaced come first, so the
 * deactivation sound never plays after the activation that followed it.
 */
export function prayerSetChanges(before: readonly PrayerType[], after: readonly PrayerType[]): PrayerChange[] {
  const arrivals = after.filter((prayer) => !before.includes(prayer));
  const leavers = before.filter((prayer) => !after.includes(prayer));
  const displaced = (prayer: PrayerType): boolean => arrivals.some((arrival) => prayersConflict(arrival, prayer));
  const changes: PrayerChange[] = leavers
    .filter((prayer) => !displaced(prayer))
    .map((prayer) => ({ from: prayer, to: null }));
  const unpaired = leavers.filter(displaced);
  for (const arrival of arrivals) {
    const index = unpaired.findIndex((prayer) => prayersConflict(arrival, prayer));
    const from = index === -1 ? null : unpaired.splice(index, 1)[0];
    changes.push({ from, to: arrival });
  }
  return changes;
}

/** Light `prayer` in `set`, turning off whatever it conflicts with. */
function lightInSet(set: readonly PrayerType[], prayer: PrayerType): PrayerType[] {
  return [...set.filter((lit) => !prayersConflict(prayer, lit)), prayer];
}

function splitSelections(selections: readonly PrayerType[]): {
  protection: PrayerType | null;
  boost: PrayerType[];
  independent: PrayerType[];
} {
  let protection: PrayerType | null = null;
  let boost: PrayerType[] = [];
  const independent: PrayerType[] = [];
  for (const prayer of selections) {
    const category = PRAYER_CATEGORIES[prayer];
    if (category === 'protection') protection = prayer;
    // A later selection wins a conflict, as a later protection selection wins the slot.
    else if (category === 'boost' && !boost.includes(prayer)) boost = lightInSet(boost, prayer);
    else if (category === 'independent' && !independent.includes(prayer)) independent.push(prayer);
  }
  return { protection, boost, independent };
}

/** One queued input paired with whether the player had prayer points when it ran. */
export interface PrayerActionStep {
  readonly action: QueuedPrayerAction;
  readonly hasPrayerPoints: boolean;
}

/**
 * Replay an ordered batch of prayer inputs against `start`, exactly as the
 * server would apply the packets it received during one tick.
 *
 * Availability is per STEP because a restore dose earlier in the same tick's FIFO can
 * write the points this guard reads — see {@link projectPendingPrayerInput}.
 *
 * Pure: the engine uses it to commit the tick, and the state snapshot uses it to
 * report the client-predicted result of inputs that have not been ticked yet.
 */
export function resolvePrayerActionSteps(
  start: PrayerInputState,
  steps: readonly PrayerActionStep[],
): PrayerInputOutcome {
  let protection = start.protection;
  let boost: readonly PrayerType[] = start.boost;
  let independent: readonly PrayerType[] = start.independent;
  let quickPrayersActive = start.quickPrayersActive;
  let protectionTouched = false;
  let boostTouched = false;
  let independentTouched = false;
  const activated = new Set<PrayerType>();
  const rejected: PrayerType[] = [];
  const transitions: PrayerTransition[] = [];

  const activate = (from: PrayerType | null, to: PrayerType | null): void => {
    if (to !== null && to !== from) activated.add(to);
  };

  const setProtection = (next: PrayerType | null): void => {
    if (protection === next) return;
    transitions.push({ slot: 'protection', from: protection, to: next });
    protection = next;
  };

  const setBoost = (next: readonly PrayerType[]): void => {
    for (const change of prayerSetChanges(boost, next)) transitions.push({ slot: 'boost', ...change });
    boost = [...next];
  };

  const setIndependent = (next: readonly PrayerType[]): void => {
    for (const change of prayerSetChanges(independent, next)) transitions.push({ slot: 'independent', ...change });
    independent = [...next];
  };

  for (const { action, hasPrayerPoints } of steps) {
    if (action.type === 'protection') {
      protectionTouched = true;
      quickPrayersActive = false;
      if (action.prayer === null || action.prayer === protection) {
        setProtection(null);
      } else if (!hasPrayerPoints) {
        rejected.push(action.prayer);
      } else {
        activate(protection, action.prayer);
        setProtection(action.prayer);
      }
      continue;
    }

    if (action.type === 'boost') {
      boostTouched = true;
      quickPrayersActive = false;
      const prayer = action.prayer;
      if (prayer === null) {
        setBoost([]);
      } else if (boost.includes(prayer)) {
        setBoost(boost.filter((lit) => lit !== prayer));
      } else if (!hasPrayerPoints) {
        rejected.push(prayer);
      } else {
        activated.add(prayer);
        setBoost(lightInSet(boost, prayer));
      }
      continue;
    }

    if (action.type === 'independent') {
      independentTouched = true;
      quickPrayersActive = false;
      if (independent.includes(action.prayer)) {
        setIndependent(independent.filter((prayer) => prayer !== action.prayer));
      } else if (!hasPrayerPoints) {
        rejected.push(action.prayer);
      } else {
        activated.add(action.prayer);
        setIndependent([...independent, action.prayer]);
      }
      continue;
    }

    if (quickPrayersActive) {
      protectionTouched = true;
      boostTouched = true;
      independentTouched = true;
      quickPrayersActive = false;
      setProtection(null);
      setBoost([]);
      setIndependent([]);
      continue;
    }

    const next = splitSelections(action.selections);
    if (next.protection === null && next.boost.length === 0 && next.independent.length === 0) {
      // Nothing is assigned to the quick-prayer set, so there is nothing to turn
      // on and the flag stays where it was.
      continue;
    }
    if (!hasPrayerPoints) {
      rejected.push(next.protection ?? next.boost[0] ?? (next.independent[0] as PrayerType));
      continue;
    }
    protectionTouched = true;
    boostTouched = true;
    independentTouched = true;
    quickPrayersActive = true;
    activate(protection, next.protection);
    // A prayer the set merely RETAINS was already burning, so it must not collect a fresh
    // activation stamp and buy itself another drain-free tick.
    for (const prayer of [...next.boost, ...next.independent]) {
      if (!boost.includes(prayer) && !independent.includes(prayer)) activated.add(prayer);
    }
    setProtection(next.protection);
    setBoost(next.boost);
    setIndependent(next.independent);
  }

  return {
    protection,
    boost,
    independent,
    quickPrayersActive,
    protectionTouched,
    boostTouched,
    independentTouched,
    activated: [...activated].filter(
      (prayer) => prayer === protection || boost.includes(prayer) || independent.includes(prayer),
    ),
    rejected,
    transitions,
  };
}

/** Every input judged against the same availability. */
export function resolvePrayerActions(
  start: PrayerInputState,
  actions: readonly QueuedPrayerAction[],
  hasPrayerPoints: boolean,
): PrayerInputOutcome {
  return resolvePrayerActionSteps(
    start,
    actions.map((action) => ({ action, hasPrayerPoints })),
  );
}
