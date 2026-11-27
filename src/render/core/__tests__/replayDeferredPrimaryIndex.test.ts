import { describe, expect, it, vi } from 'vitest';
import { ActorCueLife } from '../actorCueLife';
import { ReplayDeferredPrimaryIndex } from '../replayDeferredPrimaryIndex';
import type { PrimarySpec } from '../replayPrimaryIndex';

const spec = (clip: string, priority: number): PrimarySpec<string> => ({
  clip,
  priority,
  duration: 100,
  delay: 0,
  replaces: false,
});
const destination = (cycle: number, throughFrameIndex: number, spawnTick = 0) => ({
  cycle,
  throughFrameIndex,
  spawnTick,
});

function retainedReferences(root: object): number {
  const visited = new Set<object>();
  function count(value: unknown): number {
    if (typeof value !== 'object' || value === null) return 0;
    if (visited.has(value)) return 1;
    visited.add(value);
    const children: readonly unknown[] =
      value instanceof Map ? [...value.keys(), ...value.values()] : Object.values(value);
    return 1 + children.reduce<number>((total, child) => total + count(child), 0);
  }
  return count(root);
}

describe('ReplayDeferredPrimaryIndex', () => {
  it('keeps exact client-cycle origins when game-tick conversion would round them', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    index.append(0, 0, [{ cycle: 62, clipId: 'attack' }]);
    expect(index.sample(destination(65, 0), {}, (id) => spec(id, 5)).primary).toMatchObject({
      elapsedTicks: 3,
      remainderMs: 0,
    });
  });
  it('arbitrates in due order without allowing future source frames to reject an earlier delayed cue', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    index.append(0, 0, [{ cycle: 60, clipId: 'low' }]);
    index.append(1, 1, [{ cycle: 30, clipId: 'high' }]);
    const metadata = {};
    const resolve = (id: string) => spec(id, id === 'high' ? 10 : 4);
    expect(index.sample(destination(70, 1), metadata, resolve).primary?.clip).toBe('high');
    expect(index.sample(destination(70, 0), metadata, resolve).primary).toMatchObject({
      clip: 'low',
      elapsedTicks: 10,
    });
  });

  it('preserves chronological same-time order and extends without rereading prior metadata on scrubs', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    for (let frame = 0; frame < 1000; frame++)
      index.append(frame, frame, [{ cycle: frame * 30 + 30, clipId: String(frame) }]);
    const resolve = vi.fn((id: string) => spec(id, 5));
    const metadata = {};
    index.sample(destination(30000, 999), metadata, resolve);
    resolve.mockClear();
    for (let frame = 900; frame > 800; frame--) index.sample(destination(frame * 30 + 10.5, frame), metadata, resolve);
    expect(resolve).not.toHaveBeenCalled();
    index.append(1000, 1000, [{ cycle: 30000, clipId: 'new' }]);
    expect(index.sample(destination(30000, 1000), metadata, resolve).primary?.clip).toBe('new');
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it('filters pre-spawn cues, retries unavailable metadata and resets for new metadata', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    index.append(0, 0, [
      { cycle: 0, clipId: 'old' },
      { cycle: 300, clipId: 'new' },
    ]);
    const metadata = {};
    expect(index.sample(destination(305.5, 0, 10), metadata, () => undefined).pending).toBe(true);
    const resolve = (id: string) => spec(id, 5);
    expect(index.sample(destination(305.5, 0, 10), metadata, resolve)).toMatchObject({
      firstCycle: 300,
      primary: { clip: 'new', elapsedTicks: 5, remainderMs: 10 },
    });
    expect(index.sample(destination(305.5, 0, 10), {}, () => null).primary).toBeNull();
  });

  it('retains approximately twice the references when long-delayed cues grow from 500 to 1000', () => {
    const references = [500, 1000].map((cueCount) => {
      const index = new ReplayDeferredPrimaryIndex<string>();
      const metadata = {};
      const resolve = (id: string) => spec(id, 5);
      for (let frame = 0; frame < cueCount; frame++) {
        index.append(frame, frame, [{ cycle: 100000 + frame, clipId: String(frame) }]);
        index.sample(destination(frame * 30, frame), metadata, resolve);
      }
      index.sample(destination(100, 0), metadata, resolve);
      const result = index.sample(destination(cueCount * 30, cueCount - 1), metadata, resolve);

      expect(result).toMatchObject({ primary: null, firstCycle: undefined, pending: false });
      expect(index['sources'].reduce((total, source) => total + source.cues.length, 0)).toBe(cueCount);
      const retained = retainedReferences({ sources: index['sources'], lives: index['lives'] });
      expect(index.sample(destination(100000 + cueCount + 4, cueCount - 1), metadata, resolve)).toMatchObject({
        firstCycle: 100000,
        primary: { clip: String(cueCount - 1), elapsedTicks: 5 },
      });
      return retained;
    });

    expect(references[0]).toBeGreaterThanOrEqual(500);
    expect(references[1]).toBeLessThanOrEqual(references[0] * 2.1);
    expect(references[1]).toBeLessThan(12000);
  });

  it('re-arbitrates when a newly admitted frame has a cue before the sampled cycle', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    const metadata = {};
    const resolve = vi.fn((id: string) => spec(id, id === 'high' ? 10 : 4));
    index.append(0, 0, [{ cycle: 60, clipId: 'low' }]);
    expect(index.sample(destination(70, 0), metadata, resolve).primary?.clip).toBe('low');
    index.append(1, 1, [{ cycle: 30, clipId: 'high' }]);

    const result = index.sample(destination(70, 1), metadata, resolve);

    expect(result).toMatchObject({ primary: { clip: 'high', elapsedTicks: 40 }, firstCycle: 30, rebuilt: false });
    expect(resolve.mock.calls).toEqual([['low'], ['high']]);
  });

  it('preserves source and within-source order when equal-cycle cues are admitted incrementally', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    const metadata = {};
    const resolve = vi.fn((id: string) => spec(id, 5));
    index.append(0, 0, [
      { cycle: 60, clipId: 'first' },
      { cycle: 60, clipId: 'second' },
    ]);
    expect(index.sample(destination(60, 0), metadata, resolve).primary?.clip).toBe('second');
    index.append(1, 1, [{ cycle: 60, clipId: 'third' }]);

    const result = index.sample(destination(60, 1), metadata, resolve);

    expect(result.primary).toMatchObject({ clip: 'third', elapsedTicks: 0 });
    expect(index.sample(destination(60, 0), metadata, resolve).primary?.clip).toBe('second');
    expect(index.sample(destination(60, 1), metadata, resolve).primary?.clip).toBe('third');
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('merges newly eligible future cues ahead of queued cues while continuing the sweep', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    const metadata = {};
    const resolve = vi.fn((id: string) => spec(id, id === 'middle' ? 10 : 5));
    index.append(0, 0, [
      { cycle: 0, clipId: 'first' },
      { cycle: 90, clipId: 'last' },
    ]);
    index.sample(destination(20, 0), metadata, resolve);
    index.append(1, 1, [{ cycle: 60, clipId: 'middle' }]);

    const result = index.sample(destination(100, 1), metadata, resolve);

    expect(result).toMatchObject({ firstCycle: 0, primary: { clip: 'middle', elapsedTicks: 40 } });
    expect(resolve.mock.calls).toEqual([['first'], ['last'], ['middle']]);
  });

  it('rebuilds on cycle-only rewinds without rereading metadata or resurrecting replaced clips', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    const metadata = {};
    const resolve = vi.fn((id: string) => ({ ...spec(id, 5), duration: id === 'short' ? 10 : 100 }));
    index.append(0, 0, [
      { cycle: 0, clipId: 'long' },
      { cycle: 30, clipId: 'short' },
    ]);
    index.sample(destination(50, 0), metadata, resolve);

    const result = index.sample(destination(20.5, 0), metadata, resolve);

    expect(result).toMatchObject({ primary: { clip: 'long', elapsedTicks: 20, remainderMs: 10 }, rebuilt: false });
    expect(index.sample(destination(35, 0), metadata, resolve).primary?.clip).toBe('short');
    expect(index.sample(destination(40, 0), metadata, resolve).primary).toBeNull();
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('waits for both the source tick and frame before resolving a cue', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    const metadata = {};
    const resolve = vi.fn((id: string) => spec(id, 5));
    index.append(2, 3, [{ cycle: 90, clipId: 'attack' }]);

    const results = [
      index.sample(destination(89, 2), metadata, resolve),
      index.sample(destination(100, 1), metadata, resolve),
    ];

    expect(results.map((result) => result.firstCycle)).toEqual([undefined, undefined]);
    expect(resolve).not.toHaveBeenCalled();
    expect(index.sample(destination(100, 2), metadata, resolve)).toMatchObject({
      firstCycle: 90,
      primary: { clip: 'attack', elapsedTicks: 10 },
    });
  });

  it('keeps an unresolved source atomic and retries without skipping it or rereading cached clips', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    const metadata = {};
    let available = false;
    const resolve = vi.fn((id: string) => (id === 'loading' && !available ? undefined : spec(id, 5)));
    index.append(0, 0, [{ cycle: 0, clipId: 'original' }]);
    index.append(1, 1, [
      { cycle: 60, clipId: 'ready' },
      { cycle: 70, clipId: 'loading' },
    ]);
    index.append(2, 2, [{ cycle: 80, clipId: 'last' }]);

    const pending = index.sample(destination(85, 2), metadata, resolve);
    const retry = index.sample(destination(85, 2), metadata, resolve);

    expect(pending).toMatchObject({ pending: true, primary: { clip: 'original' } });
    expect(retry).toMatchObject({ pending: true, rebuilt: true, primary: { clip: 'original' } });
    expect(resolve.mock.calls).toEqual([['original'], ['ready'], ['loading'], ['loading']]);
    available = true;
    expect(index.sample(destination(85, 2), metadata, resolve)).toMatchObject({
      pending: false,
      rebuilt: true,
      primary: { clip: 'last', elapsedTicks: 5 },
    });
    expect(resolve.mock.calls).toEqual([['original'], ['ready'], ['loading'], ['loading'], ['loading'], ['last']]);
  });

  it('caches null absence across scrubs and resolves it again only for new metadata', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    const metadata = {};
    index.append(0, 0, [{ cycle: 0, clipId: 'absent' }]);
    index.append(1, 1, [
      { cycle: 30, clipId: 'absent' },
      { cycle: 40, clipId: 'present' },
    ]);
    const resolve = vi.fn((id: string) => (id === 'absent' ? null : spec(id, 5)));
    expect(index.sample(destination(50, 1), metadata, resolve)).toMatchObject({ firstCycle: 40, pending: false });
    resolve.mockImplementation((id) => spec(id, 10));

    const scrub = index.sample(destination(20, 0), metadata, resolve);

    expect(scrub).toMatchObject({ primary: null, firstCycle: undefined, pending: false });
    expect(resolve.mock.calls).toEqual([['absent'], ['present']]);
    expect(index.sample(destination(20, 0), {}, resolve)).toMatchObject({
      rebuilt: true,
      firstCycle: 0,
      primary: { clip: 'absent', elapsedTicks: 20 },
    });
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('excludes pre-spawn cues before resolution while keeping separate actor lives', () => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    const metadata = {};
    index.append(0, 0, [
      { cycle: 299, clipId: 'old' },
      { cycle: 300, clipId: 'new' },
    ]);
    const resolve = vi.fn((id: string) => spec(id, id === 'old' ? 10 : 5));

    const respawned = index.sample(destination(305, 0, 10), metadata, resolve);

    expect(respawned).toMatchObject({ firstCycle: 300, primary: { clip: 'new' } });
    expect(resolve.mock.calls).toEqual([['new']]);
    expect(index.sample(destination(305, 0, 0), metadata, resolve).primary?.clip).toBe('old');
    expect(index.sample(destination(305, 0, 10), metadata, resolve).primary?.clip).toBe('new');
  });

  it('drops a queued cue whose actor life ended before it became due, as a direct sample does', () => {
    // The actor is removed on tick 1 and its id reused with no spawn tick, so the successor samples
    // the same spawn key: only the cue's own life tells the two apart.
    const life = new ActorCueLife();
    life.bind(undefined, { frameIndex: 0, tick: 0 });
    const cues = [{ cycle: 70, clipId: 'attack', life }];
    const resolve = (id: string) => spec(id, 5);
    const metadata = {};
    const warmed = new ReplayDeferredPrimaryIndex<string>();
    warmed.append(0, 0, cues);
    expect(warmed.sample(destination(0, 0), metadata, resolve)).toMatchObject({ primary: null });
    life.end({ frameIndex: 1, tick: 1 });
    const direct = new ReplayDeferredPrimaryIndex<string>();
    direct.append(0, 0, cues);

    for (const index of [warmed, direct])
      expect(index.sample(destination(70, 2), metadata, resolve)).toMatchObject({
        primary: null,
        firstCycle: undefined,
      });
  });

  it.each([
    { cycle: 5.5, clip: 'high', elapsedTicks: 0, delayClientTicks: 5, remainderMs: 10 },
    { cycle: 29, clip: 'high', elapsedTicks: 19, delayClientTicks: 0, remainderMs: 0 },
    { cycle: 30, clip: 'low', elapsedTicks: 0, delayClientTicks: 0, remainderMs: 0 },
    { cycle: 35, clip: 'forced', elapsedTicks: 0, delayClientTicks: 0, remainderMs: 0 },
  ])('preserves delay, expiry and forced replacement at cycle $cycle', ({ cycle, ...primary }) => {
    const index = new ReplayDeferredPrimaryIndex<string>();
    index.append(0, 0, [
      { cycle: 0, clipId: 'high' },
      { cycle: 5, clipId: 'blocked' },
      { cycle: 30, clipId: 'low' },
      { cycle: 35, clipId: 'forced' },
    ]);
    const resolve = (id: string) =>
      id === 'high'
        ? { ...spec(id, 10), duration: 20, delay: 10 }
        : { ...spec(id, id === 'forced' ? 1 : 5), replaces: id === 'forced' };

    const result = index.sample(destination(cycle, 0), {}, resolve);

    expect(result.primary).toMatchObject(primary);
  });
});
