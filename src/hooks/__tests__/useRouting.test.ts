// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EncounterRegistry } from '../../core/encounters/encounterFactory';
import { preservedQueryString, replaceRouteQuery, type SceneState, useRouting } from '../useRouting';

function createRegistry() {
  const registry = new EncounterRegistry();
  registry.register('yama_p3', () => ({}) as never, {
    kind: 'yama_p3',
    displayName: 'Yama - Phase 3',
    description: 'The Yama boss encounter',
    mapSquare: { x: 23, y: 157 },
    playerStart: [31, 37],
    variants: [
      {
        id: 'forfeit_breath',
        encounterKind: 'yama_p3_forfeit_breath',
        name: 'Forfeit Breath',
        subtitle: 'Run energy contract',
        available: true,
      },
    ],
  });
  registry.register('inferno', () => ({}) as never, {
    kind: 'inferno',
    displayName: 'The Inferno',
    description: 'Waves 1 to 69',
    mapSquare: { x: 35, y: 83 },
    playerStart: [0, 0],
  });
  registry.register('sol_heredit', () => ({}) as never, {
    kind: 'sol_heredit',
    displayName: 'Fortis Colosseum',
    description: 'Waves 1 to 12',
    mapSquare: { x: 28, y: 48 },
    playerStart: [0, 0],
  });
  registry.register('lobby', () => ({}) as never, {
    kind: 'lobby',
    displayName: 'Lobby',
    description: 'Hub area',
    mapSquare: { x: 0, y: 0 },
    playerStart: [0, 0],
  });

  return registry;
}

describe('useRouting', () => {
  beforeEach(() => {
    window.history.pushState(null, '', '/');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('syncs URL path when scene state changes', () => {
    const encounterRegistry = createRegistry();
    const enterEncounter = vi.fn();
    const enterLobby = vi.fn();

    const replaceStateSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener').mockImplementation(() => undefined);

    const { rerender } = renderHook(
      ({ sceneState }: { sceneState: SceneState }) =>
        useRouting(sceneState, enterEncounter, enterLobby, encounterRegistry),
      {
        initialProps: {
          sceneState: { kind: 'lobby' } as SceneState,
        },
      },
    );

    expect(addEventListenerSpy).toHaveBeenCalledWith('popstate', expect.any(Function));

    rerender({ sceneState: { kind: 'encounter', encounterKind: 'yama_p3' } });
    // Trailing slash keeps the browser URL identical to the canonical tag/sitemap entry.
    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/yama/');
  });

  it('navigates to encounter when URL path changes', () => {
    const encounterRegistry = createRegistry();
    const enterEncounter = vi.fn();
    const enterLobby = vi.fn();

    let popstateHandler: ((event: Event) => void) | undefined;
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'popstate') {
        popstateHandler = listener as (event: Event) => void;
      }
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation(() => undefined);
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);

    renderHook(() => useRouting({ kind: 'lobby' }, enterEncounter, enterLobby, encounterRegistry));

    window.history.pushState(null, '', '/yama');
    expect(popstateHandler).toBeDefined();
    if (popstateHandler) {
      popstateHandler(new PopStateEvent('popstate'));
    }

    expect(enterEncounter).toHaveBeenCalledWith('yama_p3');
  });

  it('syncs contract variant scene state to a nested URL path', () => {
    const encounterRegistry = createRegistry();
    const enterEncounter = vi.fn();
    const enterLobby = vi.fn();

    const replaceStateSpy = vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);
    vi.spyOn(window, 'addEventListener').mockImplementation(() => undefined);

    const { rerender } = renderHook(
      ({ sceneState }: { sceneState: SceneState }) =>
        useRouting(sceneState, enterEncounter, enterLobby, encounterRegistry),
      {
        initialProps: {
          sceneState: { kind: 'lobby' } as SceneState,
        },
      },
    );

    rerender({ sceneState: { kind: 'encounter', encounterKind: 'yama_p3_forfeit_breath' } });

    expect(replaceStateSpy).toHaveBeenCalledWith(null, '', '/yama/forfeit-breath/');
  });

  it('enters a contract variant from a nested URL path', () => {
    const encounterRegistry = createRegistry();
    const enterEncounter = vi.fn();
    const enterLobby = vi.fn();

    window.history.pushState(null, '', '/yama/forfeit-breath');
    vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);

    renderHook(() => useRouting({ kind: 'lobby' }, enterEncounter, enterLobby, encounterRegistry));

    expect(enterEncounter).toHaveBeenCalledWith('yama_p3_forfeit_breath');
    expect(enterLobby).not.toHaveBeenCalled();
  });

  it('enters encounter on initial load when URL is /yama', () => {
    const encounterRegistry = createRegistry();
    const enterEncounter = vi.fn();
    const enterLobby = vi.fn();

    window.history.pushState(null, '', '/yama');

    vi.spyOn(window.history, 'replaceState').mockImplementation(() => undefined);

    renderHook(() => useRouting({ kind: 'lobby' }, enterEncounter, enterLobby, encounterRegistry));

    expect(enterEncounter).toHaveBeenCalledWith('yama_p3');
    expect(enterLobby).not.toHaveBeenCalled();
  });

  it('enters the Inferno from a retired /zuk link and settles the address on /inferno/ without re-entering', () => {
    vi.useFakeTimers();
    try {
      const encounterRegistry = createRegistry();
      const enterEncounter = vi.fn();
      const enterLobby = vi.fn();
      window.history.pushState(null, '', '/zuk/');
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      const { rerender } = renderHook(
        ({ sceneState }: { sceneState: SceneState }) =>
          useRouting(sceneState, enterEncounter, enterLobby, encounterRegistry),
        { initialProps: { sceneState: { kind: 'lobby' } as SceneState } },
      );
      // The retired kind is handed on as-is; entering it resolves to the Inferno at wave 69.
      expect(enterEncounter).toHaveBeenCalledExactlyOnceWith('zuk');

      // Entering loads the owning kind while the address still reads /zuk/: not a second entry.
      rerender({ sceneState: { kind: 'loading', targetEncounter: 'inferno' } });
      vi.runAllTimers();
      rerender({ sceneState: { kind: 'encounter', encounterKind: 'inferno' } });

      expect(replaceStateSpy).toHaveBeenLastCalledWith(null, '', '/inferno/');
      expect(window.location.pathname).toBe('/inferno/');
      rerender({ sceneState: { kind: 'encounter', encounterKind: 'inferno' } });
      expect(enterEncounter).toHaveBeenCalledOnce();
      expect(enterLobby).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('enters the Colosseum on its saved setup from /colosseum and writes that address back', () => {
    const encounterRegistry = createRegistry();
    const enterEncounter = vi.fn();
    window.history.pushState(null, '', '/colosseum/');

    const { rerender } = renderHook(
      ({ sceneState }: { sceneState: SceneState }) =>
        useRouting(sceneState, enterEncounter, vi.fn(), encounterRegistry),
      { initialProps: { sceneState: { kind: 'lobby' } as SceneState } },
    );
    expect(enterEncounter).toHaveBeenCalledExactlyOnceWith('sol_heredit');

    rerender({ sceneState: { kind: 'encounter', encounterKind: 'sol_heredit' } });
    expect(window.location.pathname).toBe('/colosseum/');
    expect(enterEncounter).toHaveBeenCalledOnce();
  });

  it('enters a direct Sol start from the former /sol-heredit link and settles the address on /colosseum/', () => {
    vi.useFakeTimers();
    try {
      const encounterRegistry = createRegistry();
      const enterEncounter = vi.fn();
      const enterLobby = vi.fn();
      window.history.pushState(null, '', '/sol-heredit/');
      const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

      const { rerender } = renderHook(
        ({ sceneState }: { sceneState: SceneState }) =>
          useRouting(sceneState, enterEncounter, enterLobby, encounterRegistry),
        { initialProps: { sceneState: { kind: 'lobby' } as SceneState } },
      );
      expect(enterEncounter).toHaveBeenCalledExactlyOnceWith('sol_heredit', { colosseumStartWave: '12' });

      // Loading the Colosseum while the address still reads /sol-heredit/ is not a second entry.
      rerender({ sceneState: { kind: 'loading', targetEncounter: 'sol_heredit' } });
      vi.runAllTimers();
      rerender({ sceneState: { kind: 'encounter', encounterKind: 'sol_heredit' } });

      expect(replaceStateSpy).toHaveBeenLastCalledWith(null, '', '/colosseum/');
      expect(window.location.pathname).toBe('/colosseum/');
      rerender({ sceneState: { kind: 'encounter', encounterKind: 'sol_heredit' } });
      expect(enterEncounter).toHaveBeenCalledOnce();
      expect(enterLobby).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the address alone in both directions when disabled, as the UI harness runs it', () => {
    const encounterRegistry = createRegistry();
    const enterEncounter = vi.fn();
    const enterLobby = vi.fn();
    const address = '/ui-harness.html?encounter=yama_p3&open=settings';
    window.history.pushState(null, '', address);
    const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

    const { rerender } = renderHook(
      ({ sceneState }: { sceneState: SceneState }) =>
        useRouting(sceneState, enterEncounter, enterLobby, encounterRegistry, undefined, false),
      { initialProps: { sceneState: { kind: 'lobby' } as SceneState } },
    );
    rerender({ sceneState: { kind: 'encounter', encounterKind: 'yama_p3' } });

    expect(`${window.location.pathname}${window.location.search}`).toBe(address);
    expect(enterEncounter).not.toHaveBeenCalled();
    expect(enterLobby).not.toHaveBeenCalled();
    expect(addEventListenerSpy).not.toHaveBeenCalledWith('popstate', expect.any(Function));
  });

  // Inherited object names must not resolve as slugs, retired slugs or kinds.
  const UNKNOWN_PATHS = ['/not-a-fight/', '/toString', '/constructor/', '/__proto__', '/hasOwnProperty/x'];

  it.each(UNKNOWN_PATHS)('replaces the unknown path %s with the lobby address from the lobby', (path) => {
    const encounterRegistry = createRegistry();
    const enterEncounter = vi.fn();
    const enterLobby = vi.fn();
    window.history.pushState(null, '', `${path}?popout=1`);

    renderHook(() => useRouting({ kind: 'lobby' }, enterEncounter, enterLobby, encounterRegistry));

    expect(`${window.location.pathname}${window.location.search}`).toBe('/?popout=1');
    expect(enterEncounter).not.toHaveBeenCalled();
    expect(enterLobby).not.toHaveBeenCalled();
  });

  it.each(UNKNOWN_PATHS)('leaves an encounter for the lobby on the unknown path %s', (path) => {
    const encounterRegistry = createRegistry();
    const enterEncounter = vi.fn();
    const enterLobby = vi.fn();
    window.history.pushState(null, '', path);

    renderHook(() =>
      useRouting({ kind: 'encounter', encounterKind: 'yama_p3' }, enterEncounter, enterLobby, encounterRegistry),
    );

    expect(window.location.pathname).toBe('/');
    expect(enterEncounter).not.toHaveBeenCalled();
    expect(enterLobby).toHaveBeenCalledOnce();
  });
});

describe('replaceRouteQuery', () => {
  const params = ['wave', 'bat', 'pillars'];

  it('replaces only the route query’s own params, raw, keeping the rest in place', () => {
    expect(replaceRouteQuery('?wave=5&bat=[[1,5]]&popout=1&debug', { params, query: 'wave=6' })).toBe(
      '?wave=6&popout=1&debug',
    );
    expect(replaceRouteQuery('?popout=1', { params, query: 'wave=6&pillars=west' })).toBe(
      '?wave=6&pillars=west&popout=1',
    );
    expect(replaceRouteQuery('?wave=6&popout=1', { params, query: '' })).toBe('?popout=1');
    expect(replaceRouteQuery('?wave=6', { params, query: '' })).toBe('');
    expect(replaceRouteQuery('', { params, query: '' })).toBe('');
  });

  it('writes a query on the route it enters and drops it on the route it leaves for', () => {
    window.history.replaceState(null, '', '/?popout=1');
    const registry = createRegistry();
    const { rerender } = renderHook(
      ({ sceneState, query }: { sceneState: SceneState; query: string }) =>
        useRouting(sceneState, vi.fn(), vi.fn(), registry, { params, query }),
      { initialProps: { sceneState: { kind: 'lobby' } as SceneState, query: '' } },
    );
    rerender({ sceneState: { kind: 'loading', targetEncounter: 'inferno' }, query: 'wave=5' });
    expect(window.location.pathname + window.location.search).toBe('/inferno/?wave=5&popout=1');
    rerender({ sceneState: { kind: 'encounter', encounterKind: 'inferno' }, query: 'wave=6' });
    expect(window.location.pathname + window.location.search).toBe('/inferno/?wave=6&popout=1');
    rerender({ sceneState: { kind: 'lobby' }, query: '' });
    expect(window.location.pathname + window.location.search).toBe('/?popout=1');
    window.history.replaceState(null, '', '/');
  });
});

describe('preservedQueryString', () => {
  const originalLocation = window.location;

  function setLocationSearch(search: string): void {
    Object.defineProperty(window, 'location', {
      value: { ...originalLocation, search },
      writable: true,
      configurable: true,
    });
  }

  beforeEach(() => {
    setLocationSearch('');
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
  });

  it('returns an empty string when the URL has no query params', () => {
    setLocationSearch('');
    expect(preservedQueryString()).toBe('');
  });

  it('returns an empty string when the URL has query params but none are popout', () => {
    setLocationSearch('?logLevel=debug&foo=bar');
    expect(preservedQueryString()).toBe('');
  });

  it('returns ?popout=1 when the URL has popout=1', () => {
    setLocationSearch('?popout=1');
    expect(preservedQueryString()).toBe('?popout=1');
  });

  it('returns just ?popout=1 when popout=1 is mixed with other params (extracting only the popout flag)', () => {
    setLocationSearch('?popout=1&encounter=yama&logLevel=debug');
    expect(preservedQueryString()).toBe('?popout=1');
  });

  it('puts a route query first, ahead of a kept popout flag', () => {
    setLocationSearch('?popout=1&logLevel=debug');
    expect(preservedQueryString('wave=5&bat=[[1,5]]')).toBe('?wave=5&bat=[[1,5]]&popout=1');
    setLocationSearch('');
    expect(preservedQueryString('wave=5')).toBe('?wave=5');
  });

  it('does not preserve popout when the value is anything other than "1"', () => {
    setLocationSearch('?popout=true');
    expect(preservedQueryString()).toBe('');

    setLocationSearch('?popout=0');
    expect(preservedQueryString()).toBe('');

    setLocationSearch('?popout=');
    expect(preservedQueryString()).toBe('');
  });
});
