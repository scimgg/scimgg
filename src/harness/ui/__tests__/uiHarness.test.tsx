// @vitest-environment happy-dom

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { filterModifierSelection } from '../../../core/encounters/encounterFactory';
import type { CoreGameEvent } from '../../../core/events/types';
import { ReplayRecorder } from '../../../core/ReplayRecorder';
import { SOL_HEREDIT_MODIFIERS } from '../../../encounters/solHeredit/modifiers';
import { tickBus } from '../../../tutorial/runtime/tickBus';
import { saveSetting } from '../../../util/storage';
import type { DevHarnessSource, HarnessOutcome } from '../../devHarnessTypes';
import { applyHarnessOptions, createHarnessControls } from '../harnessControls';
import { HARNESS_STORAGE_NAMESPACE, installHarnessEnvironment } from '../harnessEnvironment';
import { resolveHarnessLoadout } from '../harnessLoadout';
import { resolveHarnessModifierFixture } from '../harnessModifierFixtures';
import { HARNESS_DEFAULT_OPTIONS, parseHarnessOptions } from '../harnessOptions';
import { parseSurfaceList } from '../harnessSurfaces';
import { UiHarnessApp } from '../UiHarnessApp';
import { registerMountedAppEnvironment } from './mountedAppEnvironment';

describe('parseHarnessOptions', () => {
  it('falls back to the defaults for an empty query string', () => {
    expect(parseHarnessOptions('')).toEqual(HARNESS_DEFAULT_OPTIONS);
  });

  it('reads every option from the query string', () => {
    expect(
      parseHarnessOptions('?encounter=yama_p3_forfeit_breath&preset=melee&tab=prayer&autoAdvance=1&ticks=7&chrome=0'),
    ).toEqual({
      ...HARNESS_DEFAULT_OPTIONS,
      encounter: 'yama_p3_forfeit_breath',
      preset: 'melee',
      tab: 'prayer',
      autoAdvance: true,
      ticks: 7,
      chrome: false,
    });
  });

  it('ignores an unknown game panel tab rather than mounting a broken panel', () => {
    expect(parseHarnessOptions('?tab=nonsense').tab).toBe(HARNESS_DEFAULT_OPTIONS.tab);
  });

  it.each(['death', 'victory'])('selects the bounded %s terminal fixture and optional practice variant', (outcome) => {
    expect(parseHarnessOptions(`?encounter=yama_p3&outcome=${outcome}&practice=1&chrome=0`)).toMatchObject({
      encounter: 'yama_p3',
      outcome,
      practice: true,
      chrome: false,
    });
    expect(parseHarnessOptions(`?outcome=${outcome}`).practice).toBe(false);
  });

  it.each([
    '?outcome=unknown&practice=1',
    '?outcome=death&practice=0',
    '?encounter=lobby&outcome=victory&practice=1',
  ])('bounds invalid/unsupported fixture query %s', (query) => {
    const options = parseHarnessOptions(query);
    expect(options.practice).toBe(false);
    if (query !== '?outcome=death&practice=0') expect(options.outcome).toBeNull();
  });

  it('parses `surface:arg` and rejects a surface listed beside the WebGL2 gate', () => {
    expect(parseSurfaceList(['encounter-panel:zuk', 'settings'])).toEqual([
      { surface: 'encounter-panel', arg: 'zuk' },
      { surface: 'settings' },
    ]);
    expect(() => parseSurfaceList(['webgl2-gate', 'settings'])).toThrow(/opens alone/);
  });

  it('reads the surfaces to open as a list, keeping unknown names for the boot to reject', () => {
    expect(parseHarnessOptions('?open=hardware-warning').open).toEqual(['hardware-warning']);
    expect(parseHarnessOptions('?open=hardware-warning,%20victory,,').open).toEqual(['hardware-warning', 'victory']);
    expect(parseHarnessOptions('?open=nonsense').open).toEqual(['nonsense']);
  });

  it('takes `practice` with a death or victory surface as it does with `outcome`', () => {
    expect(parseHarnessOptions('?open=death&practice=1').practice).toBe(true);
    expect(parseHarnessOptions('?open=hardware-warning&practice=1').practice).toBe(false);
  });

  it.each(['sol-seven', 'sol-all'])('reads the named %s modifier fixture without changing defaults', (fixture) => {
    expect(parseHarnessOptions(`?encounter=lobby&open=encounter-panel:sol_heredit&modifierFixture=${fixture}`)).toEqual(
      {
        ...HARNESS_DEFAULT_OPTIONS,
        encounter: 'lobby',
        open: ['encounter-panel:sol_heredit'],
        modifierFixture: fixture,
      },
    );
    expect(parseHarnessOptions('').modifierFixture).toBeNull();
  });

  it('keeps invalid fixture names for the boot to reject clearly, rather than silently seeding defaults', () => {
    const options = parseHarnessOptions('?modifierFixture=unknown');
    expect(options.modifierFixture).toBe('unknown');
    expect(() => resolveHarnessModifierFixture(options)).toThrow(/Unknown modifierFixture 'unknown'/);
  });
});

describe('resolveHarnessModifierFixture', () => {
  const options = {
    ...HARNESS_DEFAULT_OPTIONS,
    encounter: 'lobby',
    open: ['encounter-panel:sol_heredit'],
    modifierFixture: 'sol-seven',
  };

  it('matches the seven reference screenshot selections and uses only valid canonical tiers', () => {
    const selection = resolveHarnessModifierFixture(options);
    expect(selection).toEqual({
      blasphemy: 3,
      doom: 3,
      frailty: 3,
      myopia: 3,
      quartet: 1,
      relentless: 3,
      solarflare: 3,
    });
    expect(filterModifierSelection(SOL_HEREDIT_MODIFIERS, selection)).toEqual(selection);
  });

  it('selects every offered modifier at its valid maximum, including one-tier choices', () => {
    const selection = resolveHarnessModifierFixture({ ...options, modifierFixture: 'sol-all' });
    expect(Object.keys(selection ?? {})).toHaveLength(SOL_HEREDIT_MODIFIERS.length);
    expect(selection).toMatchObject({ bees: 3, totemic: 1, quartet: 1, volatility: 3 });
    for (const { id, tiers } of SOL_HEREDIT_MODIFIERS) expect(selection?.[id]).toBe(tiers.length);
    expect(filterModifierSelection(SOL_HEREDIT_MODIFIERS, selection)).toEqual(selection);
  });

  it('does nothing when no fixture was requested, regardless of the encounter or surfaces', () => {
    expect(resolveHarnessModifierFixture(HARNESS_DEFAULT_OPTIONS)).toBeUndefined();
    expect(resolveHarnessModifierFixture({ ...options, modifierFixture: null })).toBeUndefined();
  });

  it.each([
    { encounter: 'sol_heredit' },
    { encounter: 'yama_p3' },
    { open: [] },
    { open: ['encounter-panel:yama_p3'] },
    { open: ['encounter-panel'] },
    { open: ['modifiers'] },
    { open: ['encounter-panel:sol_heredit', 'settings'] },
  ])('rejects incompatible fixture context %j', (override) => {
    expect(() => resolveHarnessModifierFixture({ ...options, ...override })).toThrow(/modifierFixture requires/);
  });
});

describe('resolveHarnessLoadout', () => {
  it('picks the first non-fallback preset for `first`', () => {
    const loadout = resolveHarnessLoadout('yama_p3', 'first');
    expect(loadout).not.toBeNull();
    expect(Object.keys(loadout?.equipment ?? {}).length).toBeGreaterThan(0);
    expect(loadout?.inventory.filter(Boolean).length).toBeGreaterThan(0);
  });

  it('resolves a named preset', () => {
    expect(resolveHarnessLoadout('yama_p3', 'melee')?.equipment).toBeDefined();
  });

  it('resolves a contract variant through its parent presets key', () => {
    expect(resolveHarnessLoadout('yama_p3_forfeit_breath', 'first')).not.toBeNull();
  });

  it('returns null when an encounter has no presets', () => {
    expect(resolveHarnessLoadout('not-an-encounter', 'first')).toBeNull();
  });
});

describe('UiHarnessApp', () => {
  // The harness boots the real app without the GPU probe or any network request; see
  // `registerMountedAppEnvironment`, which watches both.
  const { glContexts, requests } = registerMountedAppEnvironment();

  async function showCommittedOutcome(
    controls: ReturnType<typeof createHarnessControls>,
    outcome: HarnessOutcome,
    practice: boolean,
  ) {
    const abort = new AbortController();
    let completion: { ok: true } | { ok: false; error: unknown } | undefined;
    let pending = Promise.resolve();
    act(() => {
      pending = controls.showOutcome(outcome, practice, abort.signal);
    });
    // Observe rejection immediately, including when the enclosing assertion fails. The API
    // resolves only after App's committed state is visible; do not race it with a 1s DOM query.
    const observed = pending.then(
      () => {
        completion = { ok: true };
      },
      (error: unknown) => {
        completion = { ok: false, error };
      },
    );
    try {
      // Match the named fixture API's existing 5s committed-state budget, locally. Waiting
      // inside Testing Library's async wrapper lets React commit without repeated role scans.
      await waitFor(() => expect(completion).toBeDefined(), { timeout: 5000 });
      if (!completion) throw new Error('Missing terminal fixture completion');
      if (!completion.ok) throw completion.error;
    } finally {
      abort.abort();
      await observed;
    }
  }

  it.each([
    [
      'sol-seven',
      ['Blasphemy III', 'Doom III', 'Frailty III', 'Myopia III', 'Quartet I', 'Relentless III', 'Solarflare III'],
    ],
    [
      'sol-all',
      [
        'Bees! III',
        'Blasphemy III',
        'Doom III',
        'Dynamic Duo I',
        'Frailty III',
        'Myopia III',
        'Quartet I',
        'Red Flag I',
        'Relentless III',
        'Solarflare III',
        'Totemic I',
        'Volatility III',
      ],
    ],
    [null, ['Blasphemy III']],
  ] as const)(
    'boots the real configurer with %s, saved only in the harness storage and kept on reopen',
    async (fixture, expected) => {
      installHarnessEnvironment();
      const options = parseHarnessOptions(
        `?encounter=lobby&open=encounter-panel:sol_heredit&chrome=0${fixture ? `&modifierFixture=${fixture}` : ''}`,
      );
      render(<UiHarnessApp options={options} />);
      await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });
      const panel = screen.getByRole('dialog', { name: 'Fortis Colosseum' });
      const list = within(panel).getByRole('list', { name: 'Selected modifiers' });
      expect(
        within(list)
          .getAllByRole('listitem')
          .map((item) => item.textContent?.replace(/\s+/g, ' ').trim()),
      ).toEqual(expected);
      // A fixture is an ordinary modifier edit, so it is remembered, but only under the harness's
      // own namespace: the developer's real settings are never written.
      const storedValues = Array.from({ length: localStorage.length }, (_, index) =>
        localStorage.getItem(localStorage.key(index) ?? ''),
      ).join('\n');
      expect(storedValues).not.toContain('sol-seven');
      expect(storedValues).not.toContain('sol-all');
      expect(localStorage.getItem('osrs-yama-settings') ?? '').not.toContain('modifiersPerEncounter');
      const harnessSettings = localStorage.getItem(`${HARNESS_STORAGE_NAMESPACE}osrs-yama-settings`) ?? '';
      if (fixture) expect(harnessSettings).toContain('"modifiersPerEncounter":{"sol_heredit":{');
      else expect(storedValues).not.toContain('"blasphemy":3');

      fireEvent.click(within(panel).getByRole('button', { name: 'Close encounter panel' }));
      expect(screen.queryByRole('dialog', { name: 'Fortis Colosseum' })).toBeNull();
      const controls = window.uiHarness;
      if (!controls) throw new Error('Missing actual App harness controls');
      let reopened = Promise.resolve();
      act(() => {
        reopened = controls.open('encounter-panel:sol_heredit');
      });
      await waitFor(() => expect(screen.getByRole('dialog', { name: 'Fortis Colosseum' })).toBeInTheDocument());
      await reopened;
      // Reopening shows the remembered choice; without a fixture, Sol's canonical Blasphemy III.
      const reopenedList = screen.getByRole('list', { name: 'Selected modifiers' });
      expect(
        within(reopenedList)
          .getAllByRole('listitem')
          .map((item) => item.textContent?.replace(/\s+/g, ' ').trim()),
      ).toEqual(expected);
      expect(glContexts).toEqual([]);
      expect(requests).toEqual([]);
    },
    20000,
  );

  it.each([
    '?encounter=lobby&open=encounter-panel:sol_heredit&modifierFixture=unknown',
    '?encounter=sol_heredit&open=encounter-panel:sol_heredit&modifierFixture=sol-seven',
    '?encounter=lobby&open=encounter-panel:yama_p3&modifierFixture=sol-all',
    '?encounter=lobby&open=webgl2-gate&modifierFixture=sol-seven',
  ])('reports invalid modifier fixture boot %s through the usual harness error', async (query) => {
    const options = parseHarnessOptions(query);
    installHarnessEnvironment(options.open);
    render(<UiHarnessApp options={options} />);
    await waitFor(() => expect(document.body.dataset.harnessError).toBe('true'), { timeout: 15000 });
    expect(document.body.dataset.harnessReady).toBeUndefined();
    expect(screen.getByTestId('harness-status')).toHaveTextContent(/modifierFixture/);
    expect(screen.queryByRole('dialog', { name: 'Fortis Colosseum' })).toBeNull();
    expect(glContexts).toEqual([]);
    expect(requests).toEqual([]);
  }, 20000);

  it.each([
    ['death', false],
    ['death', true],
    ['victory', false],
    ['victory', true],
  ] as const)(
    'boots the actual %s dialog with practice=%s and preserves genuine restart/replay/lobby actions',
    async (outcome, practice) => {
      installHarnessEnvironment();
      const getFrame = vi.spyOn(ReplayRecorder.prototype, 'getFrame');
      const options = parseHarnessOptions(
        `?encounter=yama_p3&outcome=${outcome}&practice=${practice ? 1 : 0}&chrome=0`,
      );
      render(<UiHarnessApp options={options} />);
      await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });
      const controls = window.uiHarness;
      if (!controls) throw new Error('Missing actual App harness controls');
      const dialogName = outcome === 'death' ? 'Death Screen' : 'VICTORY';
      const dialog = () => screen.getByRole('dialog', { name: dialogName });
      expect(dialog()).toBeInTheDocument();
      expect(screen.getAllByRole('dialog')).toHaveLength(1);
      expect(controls.getState().currentTick).toBe(12);
      expect(controls.getEngine().currentTick).toBe(12);
      expect(controls.getState().failedCondition !== null).toBe(outcome === 'death');
      if (outcome === 'victory')
        expect(controls.getState().encounterOutcome).toEqual({
          phase: 'victory',
          decisiveTick: 12,
          completionTick: 12,
          primaryActorId: 'yama',
          completionActorIds: ['yama'],
        });
      const recorder = getFrame.mock.contexts.find(
        (candidate): candidate is ReplayRecorder =>
          candidate instanceof ReplayRecorder && candidate.getFrameCount() === 13,
      );
      if (!recorder) throw new Error('Missing actual App fixture recording');
      const data = recorder.exportData();
      const normalized = new ReplayRecorder();
      normalized.load(data);
      expect(data.frames.map((frame) => frame.state.currentTick)).toEqual(
        Array.from({ length: 13 }, (_, tick) => tick),
      );
      expect(normalized.getFrame(10)?.state.isAlive).toBe(true);
      expect(normalized.getFrame(12)?.state.encounterOutcome).toEqual(controls.getState().encounterOutcome);
      expect(normalized.getFrame(12)?.state.failedCondition).toBe(controls.getState().failedCondition);
      fireEvent.click(
        within(dialog()).getByRole('button', { name: practice ? 'Restart from tick 10' : 'Restart fight' }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull());
      // Restarting from tick 10 restores tick 9, so tick 10 is the first one played again.
      expect(controls.getState().currentTick).toBe(practice ? 9 : 0);
      expect(controls.getState().failedCondition).toBeNull();
      expect(controls.getState().encounterOutcome.phase).toBe('active');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull();

      await showCommittedOutcome(controls, outcome, practice);
      expect(dialog()).toBeInTheDocument();
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Watch replay' }));
      await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Replay controls' })).toBeInTheDocument());
      expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull();
      expect(document.querySelectorAll('.replay-bar')).toHaveLength(1);
      const launcher = document.querySelector<HTMLElement>('[data-tutorial="replay-launcher"]');
      if (!launcher) throw new Error('Missing real replay exit launcher');
      fireEvent.click(launcher);
      await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Replay controls' })).toBeNull());
      expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull();

      if (outcome === 'victory' && !practice) {
        // Exercise a genuinely asynchronous stage beyond the ordinary 1s DOM-wait bound.
        // The real App, prefix factory and callbacks still run after this import is released.
        vi.doMock('../terminalFixtures', async (importOriginal) => {
          const actual = await importOriginal<typeof import('../terminalFixtures')>();
          await new Promise((resolve) => setTimeout(resolve, 1200));
          return actual;
        });
      }
      await showCommittedOutcome(controls, outcome, practice);
      expect(dialog()).toBeInTheDocument();
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Return to Lobby' }));
      const fade = document.querySelector('.exit-fade-overlay');
      if (!fade) throw new Error('Missing actual return-to-lobby fade');
      fireEvent.transitionEnd(fade);
      await waitFor(() => expect(controls.getEncounterKind()).toBe('lobby'));
      expect(screen.queryByRole('dialog', { name: dialogName })).toBeNull();
      expect(requests).toEqual([]);
      expect(glContexts).toEqual([]);
    },
    30000,
  );

  it('observes a rejected real fixture request before propagating the failure to the test', async () => {
    installHarnessEnvironment();
    render(<UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, chrome: false }} />);
    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });
    const controls = window.uiHarness;
    if (!controls) throw new Error('Missing actual App harness controls');
    const fixture = await import('../terminalFixtures');
    vi.spyOn(fixture, 'terminalFixtureEnding').mockImplementation(() => {
      throw new Error('fixture ending failure');
    });
    await expect(showCommittedOutcome(controls, 'victory', false)).rejects.toThrow('fixture ending failure');
    expect(screen.queryByRole('dialog', { name: 'VICTORY' })).toBeNull();
    expect(requests).toEqual([]);
    expect(glContexts).toEqual([]);
  }, 20000);

  it.each([
    'reset',
    'lobby',
  ] as const)('cancels pending initial terminal setup on a real harness %s action', async (action) => {
    installHarnessEnvironment();
    const fixture = await import('../terminalFixtures');
    const ending = vi.spyOn(fixture, 'terminalFixtureEnding');
    const originalLoad = ReplayRecorder.prototype.load;
    let navigation: Promise<void> | undefined;
    vi.spyOn(ReplayRecorder.prototype, 'load').mockImplementation(function (this: ReplayRecorder, data) {
      originalLoad.call(this, data);
      queueMicrotask(() => {
        const controls = window.uiHarness;
        if (!controls) throw new Error('Missing actual harness during fixture setup');
        act(() => {
          navigation = action === 'reset' ? controls.reset() : controls.enterEncounter('lobby');
        });
      });
    });
    const options = parseHarnessOptions('?encounter=yama_p3&outcome=death&practice=1&chrome=0');
    render(<UiHarnessApp options={options} />);
    await waitFor(() => expect(navigation).toBeDefined(), { timeout: 15000 });
    await navigation;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(ending).not.toHaveBeenCalled();
    expect(window.uiHarness?.getEncounterKind()).toBe(action === 'reset' ? 'yama_p3' : 'lobby');
    expect(window.uiHarness?.getState().currentTick).toBe(0);
    expect(window.uiHarness?.getState().failedCondition).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Death Screen' })).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'VICTORY' })).toBeNull();
    expect(document.body.dataset.harnessError).toBeUndefined();
    expect(requests).toEqual([]);
    expect(glContexts).toEqual([]);
  }, 20000);

  it('restores recorded DPS when replay opens over a different live target state', async () => {
    installHarnessEnvironment();
    render(<UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', ticks: 2 }} />);
    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });
    const controls = window.uiHarness;
    if (!controls) throw new TypeError('Missing ready UI harness');
    const recorded = controls.getEngine().getAdjustedTheoreticalDps();
    if (!recorded) throw new TypeError('Expected supported recorded attack');
    act(() => controls.setBossHp(0));
    fireEvent.click(screen.getByRole('button', { name: 'Practice' }));
    fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
    const maxHit = () => screen.getByText('Max hit').closest('.launcher-stats__row')?.textContent;
    expect(maxHit()).toBe('Max hit—');

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));

    expect(maxHit()).toBe(`Max hit${recorded.maxHit}`);
  }, 20000);

  it('keeps the Replay launcher a two-way toggle, with Practice on playback Stats meanwhile', async () => {
    installHarnessEnvironment();
    render(<UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', ticks: 2 }} />);
    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });
    const replay = document.querySelector<HTMLButtonElement>('[data-tutorial="replay-launcher"]');
    if (!replay) throw new TypeError('Missing Replay launcher');

    fireEvent.click(screen.getByRole('button', { name: 'Practice' }));
    expect(screen.getByRole('dialog', { name: 'Practice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Setup' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(replay);

    expect(replay).toBeInTheDocument();
    expect(replay).toHaveAttribute('aria-pressed', 'true');
    expect(replay).toHaveClass('is-open');
    expect(screen.getByRole('toolbar', { name: 'Replay controls' })).toBeInTheDocument();
    // Practice stays open, on the recording's Stats, with Setup off.
    expect(screen.getByRole('dialog', { name: 'Practice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Setup' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('From the replay')).toBeInTheDocument();

    fireEvent.click(replay);

    expect(screen.queryByRole('toolbar', { name: 'Replay controls' })).toBeNull();
    expect(replay).toHaveAttribute('aria-pressed', 'false');
    expect(replay).not.toHaveClass('is-open');
    expect(screen.getByRole('button', { name: 'Setup' })).toHaveAttribute('aria-pressed', 'true');
  }, 20000);

  it('keeps a fullscreen frame at its full size when the replay bar opens', async () => {
    installHarnessEnvironment();
    saveSetting('clientLayoutMode', 'modern');
    saveSetting('gameResolution', { mode: 'fit', width: 1280, height: 720, presetId: 'fit' });
    render(<UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', ticks: 2 }} />);
    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));

    const frame = document.querySelector<HTMLElement>('.game-viewport-frame');
    expect(frame?.style.transform).toBe('');
    expect(frame?.style.left).toBe('0px');
    expect(frame?.style.top).toBe('0px');
    expect(screen.getByRole('toolbar', { name: 'Replay controls' }).closest('.workspace-replay-host')).not.toBeNull();
  }, 20000);

  it.each([
    ['fixed', false],
    ['modern', false],
    ['fixed', true],
    ['modern', true],
  ] as const)(
    'preserves a selected resolution in a smaller window (%s, replay=%s)',
    async (mode, replaying) => {
      installHarnessEnvironment();
      saveSetting('osrs-yama-settings', {
        clientLayoutMode: mode,
        fixedLayoutScale: 1,
        gameResolution: { mode: 'fixed', width: 765, height: 503, presetId: 'custom' },
      });
      vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(740);
      vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(400);
      render(<UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', ticks: 2 }} />);
      await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });

      if (replaying) fireEvent.click(screen.getByRole('button', { name: 'Replay' }));

      const frame = document.querySelector<HTMLElement>('.game-viewport-frame');
      expect(frame?.style.width).toBe('765px');
      expect(frame?.style.height).toBe('503px');
      expect(frame?.style.transform).toBe('');
      // An unscaled replay frame still isolates, so the recorded menu stays under the replay cursor.
      expect(frame?.style.isolation).toBe(replaying ? 'isolate' : '');
      expect(frame?.getBoundingClientRect().x).toBe(0);
      expect(frame?.getBoundingClientRect().y).toBe(0);
      expect(document.querySelector('.viewport-size-strip')).not.toBeNull();
    },
    20000,
  );

  it('centers the Fixed frame beside an open sidebar and publishes its inset to CSS', async () => {
    installHarnessEnvironment();
    saveSetting('osrs-yama-settings', { clientLayoutMode: 'fixed', fixedLayoutScale: 1 });
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(1920);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1080);
    render(<UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', ticks: 2 }} />);
    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });
    const frame = () => document.querySelector<HTMLElement>('.game-viewport-frame');
    const rootInset = (side: 'left' | 'right') => document.documentElement.style.getPropertyValue(`--ui-inset-${side}`);

    expect(frame()?.style.width).toBe('765px');
    expect(frame()?.style.left).toBe('578px');
    expect(rootInset('right')).toBe('0px');

    // The Plugins drawer leaves 1600 on the left: the frame centers there, on a whole pixel.
    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    expect(frame()?.style.left).toBe('418px');
    expect(frame()?.style.top).toBe('289px');
    expect(rootInset('right')).toBe('320px');

    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }));
    expect(frame()?.style.left).toBe('578px');
    expect(rootInset('right')).toBe('0px');
  }, 20000);

  it('keeps the viewer chrome out of the replay workspace scale', async () => {
    installHarnessEnvironment();
    render(<UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', ticks: 2 }} />);
    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Game menu' })).getByRole('button', { name: 'Practice' }),
    );

    // The launchers and their panes are the viewer's chrome: window-level, never inside the
    // recording's scaled presentation surface.
    const stats = document.querySelector('.launcher-stats');
    expect(stats?.closest('.workspace-chrome-host')).not.toBeNull();
    expect(stats?.closest('.workspace-presentation-surface')).toBeNull();
  }, 20000);

  async function mountHarnessWithXpEvent() {
    installHarnessEnvironment();
    render(
      <UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', ticks: 2, autoAdvance: false }} />,
    );
    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });
    const controls = window.uiHarness;
    if (!controls) throw new TypeError('Missing ready UI harness');
    const engine = controls.getEngine();
    const now = performance.now();
    vi.spyOn(performance, 'now').mockReturnValue(now);
    const event: Extract<CoreGameEvent, { type: 'xp_drop' }> = {
      type: 'xp_drop',
      eventId: 9001,
      tick: engine.getState().currentTick + 1,
      skills: [
        { skill: 'strength', amount: 40 },
        { skill: 'hitpoints', amount: 13 },
      ],
      predictedHit: 10,
    };
    vi.spyOn(engine, 'getLastTickEvents').mockReturnValue([]).mockReturnValueOnce([event]);
    const publish = vi.spyOn(tickBus, 'publish');
    return { controls, engine, event, now, publish };
  }

  it('expires live XP drops when controlled ticks advance without wall-clock time', async () => {
    const { controls, event, now, publish } = await mountHarnessWithXpEvent();

    act(() => controls.tick());

    expect(publish).toHaveBeenCalledExactlyOnceWith(event.tick, [event]);
    expect(document.querySelectorAll('.xp-drop')).toHaveLength(1);
    expect(screen.getByText('53 (10)')).toBeInTheDocument();

    act(() => controls.tick(4));

    expect(controls.getState().currentTick).toBe(event.tick + 4);
    expect(performance.now()).toBe(now);
    expect(document.querySelectorAll('.xp-drop')).toHaveLength(0);
    expect(screen.queryByText('53 (10)')).toBeNull();
  }, 20000);

  it('reconstructs XP drops at the recorded age on replay seeks without advancing or republishing live ticks', async () => {
    const { controls, engine, event, publish } = await mountHarnessWithXpEvent();
    act(() => controls.tick());
    act(() => controls.tick(4));
    const liveTick = engine.getState().currentTick;
    publish.mockClear();

    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));
    const replay = within(screen.getByRole('toolbar', { name: 'Replay controls' }));
    const seek = (frameIndex: number) => {
      fireEvent.change(replay.getByRole('slider'), { target: { value: String(frameIndex) } });
      fireEvent.pointerUp(replay.getByRole('slider'));
    };

    seek(event.tick + 1);
    expect(document.querySelectorAll('.xp-drop')).toHaveLength(1);
    expect(screen.getByText('53 (10)')).toBeInTheDocument();
    expect(document.querySelector<HTMLElement>('.xp-drop')?.style.transform).toMatch(
      /translate\(-50%, -26\.4(?:0)?px\)/,
    );

    seek(event.tick - 1);
    expect(document.querySelectorAll('.xp-drop')).toHaveLength(0);
    expect(screen.queryByText('53 (10)')).toBeNull();

    seek(event.tick);
    expect(document.querySelectorAll('.xp-drop')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.xp-drop')?.style.transform).toMatch(/translate\(-50%, 0(?:\.00)?px\)/);

    seek(event.tick + 1);
    seek(event.tick - 1);
    seek(event.tick + 1);
    expect(document.querySelectorAll('.xp-drop')).toHaveLength(1);
    expect(screen.getAllByText('53 (10)')).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.xp-drop')?.style.transform).toMatch(
      /translate\(-50%, -26\.4(?:0)?px\)/,
    );

    seek(event.tick + 4);
    expect(document.querySelectorAll('.xp-drop')).toHaveLength(0);
    expect(screen.queryByText('53 (10)')).toBeNull();
    expect(engine.getState().currentTick).toBe(liveTick);
    expect(publish).not.toHaveBeenCalled();
  }, 20000);

  it('records one UI marker for a real prayer-panel click', async () => {
    installHarnessEnvironment();
    const recordClick = vi.spyOn(ReplayRecorder.prototype, 'recordCursorClick');
    render(<UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', tab: 'prayer', ticks: 2 }} />);
    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });
    const frame = document.querySelector('.game-viewport-frame');
    if (!frame) throw new TypeError('Missing game frame');
    vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1280, 720));
    const prayer = screen.getByRole('button', { name: 'Protect from Magic' });

    fireEvent.pointerDown(prayer, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseDown(prayer, { button: 0, clientX: 100, clientY: 100 });
    fireEvent.mouseUp(prayer, { button: 0, clientX: 100, clientY: 100 });

    expect(recordClick.mock.calls.map((call) => call[2])).toEqual(['ui']);
  }, 20000);

  it('captures a real menu as callback-free open, hover and close events', async () => {
    installHarnessEnvironment();
    const getMenuTrack = vi.spyOn(ReplayRecorder.prototype, 'getMenuTrack');
    const getRect = vi.mocked(HTMLElement.prototype.getBoundingClientRect).getMockImplementation();
    if (!getRect) throw new TypeError('Missing harness geometry fixture');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('game-viewport-frame'))
        return new DOMRect(100, 50, this.offsetWidth, this.offsetHeight);
      if (this.getAttribute('role') === 'menu') return new DOMRect(160, 90, 200, 160);
      if (this.getAttribute('role') === 'menuitem') return new DOMRect(160, 100, 180, 20);
      return getRect.call(this);
    });
    render(<UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', tab: 'prayer', ticks: 2 }} />);
    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });

    fireEvent.mouseDown(screen.getByRole('button', { name: 'Protect from Magic' }), {
      button: 2,
      clientX: 170,
      clientY: 110,
    });
    expect(screen.getByRole('menu')).toBeInTheDocument();
    // A mouse sends pointermove before its mousemove; the open menu hovers from the former.
    fireEvent.pointerMove(window, { pointerType: 'mouse', clientX: 170, clientY: 110 });
    fireEvent.mouseMove(window, { clientX: 170, clientY: 110 });
    fireEvent.blur(window);
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Replay' }));

    const result = getMenuTrack.mock.results.at(-1);
    if (!result || result.type !== 'return') throw new TypeError('Expected the recorded menu track');
    const events = result.value;
    const opened = events.find((event) => event.kind === 'open');
    expect(opened?.state).toMatchObject({ x: 60, y: 40, scale: 0.85 });
    expect(opened?.state.entries[0]?.target).toBe('Protect from Magic');
    expect(opened?.state.entries[0]).not.toHaveProperty('onClick');
    expect(events.some((event) => event.kind === 'update' && event.view.hoveredIndex === 0)).toBe(true);
    expect(events.at(-1)?.kind).toBe('close');
    expect(() => structuredClone(events)).not.toThrow();
  }, 20000);

  it('boots the real App on the requested encounter and exposes the control API', async () => {
    const options = { ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', ticks: 2 };
    // Exactly what the entry page does before mounting — namespaced storage and a
    // pre-seeded GPU probe.
    installHarnessEnvironment();
    render(<UiHarnessApp options={options} />);

    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });

    const controls = window.uiHarness;
    expect(controls).toBeDefined();
    const state = controls?.getState();
    expect(state?.encounter.kind).toBe('yama_p3');
    expect(state?.currentTick).toBe(2);
    expect(state?.inventory.filter(Boolean).length).toBeGreaterThan(0);
    // The real game panel is mounted: inventory slots render the real item sprites.
    expect(screen.getAllByRole('button', { name: /^Item \d+$/ }).length).toBeGreaterThan(0);
    // And the real launcher row is mounted alongside it.
    expect(
      within(screen.getByRole('navigation', { name: 'Game menu' })).getByRole('button', { name: 'Practice' }),
    ).toBeDefined();
    // No GPU probe and no cache round-trip: that is what makes it ~1s.
    expect(glContexts).toEqual([]);
    expect(requests).toEqual([]);
    // No set timer surface: the real App mounts none in this setup, and the Q / Shift+Q /
    // E chords raise none.
    expect(document.querySelector('[role="timer"]')).toBeNull();
    fireEvent.keyDown(window, { key: 'q', code: 'KeyQ' });
    fireEvent.keyDown(window, { key: 'Q', code: 'KeyQ', shiftKey: true });
    fireEvent.keyDown(window, { key: 'e', code: 'KeyE' });
    expect(document.querySelector('[role="timer"]')).toBeNull();
    expect(document.querySelector('[data-tutorial="zuk-set-timer-overlay"]')).toBeNull();
  }, 20000);

  it('reveals the encounter set countdown on X, through the real App wiring', async () => {
    installHarnessEnvironment();
    // The overlay is behind Zuk's own mechanics toggle, which ships off. Seed it
    // the way a player would rather than by prop, so every hop under test is the
    // production one: App owns the hook, Grid owns the overlay, and a hook that
    // tracked the reveal without Grid reading it would show up here as a missing
    // readout.
    saveSetting('osrs-yama-settings', { mechanicsConfigPerEncounter: { zuk: { zukSetTimer: true } } });
    render(<UiHarnessApp options={{ ...HARNESS_DEFAULT_OPTIONS, encounter: 'zuk', ticks: 2 }} />);

    await waitFor(() => expect(document.body.dataset.harnessReady).toBe('true'), { timeout: 15000 });

    expect(document.querySelector('[data-tutorial="zuk-set-timer-overlay"]')).not.toBeNull();
    expect(document.querySelector('.zuk-set-timer__actual')).toBeNull();

    fireEvent.keyDown(window, { key: 'x', code: 'KeyX' });

    expect(document.querySelector('.zuk-set-timer__actual')?.textContent).toMatch(/^actual\d+:\d\d$/);

    const controls = window.uiHarness;
    if (!controls) throw new TypeError('Missing ready UI harness');
    act(() => {
      controls.setBossHp(599);
      controls.tick();
    });
    expect(document.querySelector('.zuk-set-timer__actual.is-frozen')?.textContent).toBe('actual3:29');
    act(() => {
      controls.tick(100);
    });
    expect(document.querySelector('.zuk-set-timer__actual.is-frozen')?.textContent).toBe('actual3:29');

    // A toggle, not a hold: the same key puts the answer away.
    fireEvent.keyDown(window, { key: 'x', code: 'KeyX' });
    expect(document.querySelector('.zuk-set-timer__actual')).toBeNull();
  }, 20000);
});

describe('createHarnessControls', () => {
  /** Minimal stand-in for App's live bridge, so the control logic is testable without a mounted app. */
  function createFakeSource(overrides: Partial<DevHarnessSource> = {}) {
    const state = {
      encounterKind: 'yama_p3',
      sceneKind: 'encounter' as DevHarnessSource['sceneKind'],
      sceneLoadId: 1,
      autoAdvance: true,
      currentTick: 0,
      recordingIdentity: {},
      enteredWith: [] as Array<{ kind: string; weapon: number | undefined }>,
    };
    const source: DevHarnessSource = {
      engine: { getState: () => ({ currentTick: state.currentTick }) } as unknown as DevHarnessSource['engine'],
      get encounterKind() {
        return state.encounterKind;
      },
      get sceneKind() {
        return state.sceneKind;
      },
      get sceneLoadId() {
        return state.sceneLoadId;
      },
      get autoAdvance() {
        return state.autoAdvance;
      },
      get simulationState() {
        return { currentTick: state.currentTick } as DevHarnessSource['simulationState'];
      },
      replaying: false,
      get recordingIdentity() {
        return state.recordingIdentity;
      },
      installTerminalFixture: async () => false,
      fastForwardTo: (tick) => {
        state.currentTick = tick;
      },
      enterEncounter: (kind, loadout) => {
        state.enteredWith.push({ kind, weapon: loadout?.equipment.weapon });
        state.encounterKind = kind;
        state.sceneLoadId += 1;
        state.currentTick = 0;
        state.recordingIdentity = {};
      },
      enterLobby: () => {
        throw new Error('The fake source has no lobby');
      },
      reset: () => {
        state.currentTick = 0;
        state.recordingIdentity = {};
      },
      setGamePanelTab: () => {},
      setBossHp: () => {},
      setAutoAdvance: (enabled) => {
        state.autoAdvance = enabled;
      },
      ui: {} as DevHarnessSource['ui'],
      ...overrides,
    };
    return { state, sourceRef: { current: source } };
  }

  it('reads the committed bridge state rather than the engine snapshot', () => {
    const getState = vi.fn(() => ({ currentTick: 99 }));
    const { state, sourceRef } = createFakeSource({ engine: { getState } as unknown as DevHarnessSource['engine'] });
    state.currentTick = 7;
    expect(createHarnessControls(sourceRef).getState().currentTick).toBe(7);
    expect(getState).not.toHaveBeenCalled();
  });

  it('rejects an unknown encounter kind instead of hanging on a settle timeout', async () => {
    const { sourceRef } = createFakeSource();
    await expect(createHarnessControls(sourceRef).enterEncounter('not-a-boss')).rejects.toThrow(
      /Unknown encounter kind/,
    );
  });

  it('waits for a NEW scene when re-entering the encounter already mounted', async () => {
    const { state, sourceRef } = createFakeSource();
    const controls = createHarnessControls(sourceRef);
    state.currentTick = 12;

    await controls.enterEncounter('yama_p3');

    // Settling on kind equality alone would have resolved against the old scene.
    expect(state.sceneLoadId).toBe(2);
    expect(state.currentTick).toBe(0);
  });

  it('reset re-enters with the preset the harness last used, not the stored loadout', async () => {
    const { state, sourceRef } = createFakeSource();
    const controls = createHarnessControls(sourceRef);

    await controls.enterEncounter('yama_p3', 'melee');
    await controls.reset();

    expect(state.enteredWith).toHaveLength(2);
    expect(state.enteredWith[1]?.kind).toBe('yama_p3');
    expect(state.enteredWith[1]?.weapon).toBe(state.enteredWith[0]?.weapon);
  });

  it('applyHarnessOptions disables the tick loop before warming up', async () => {
    // The app always boots with auto-advance on (it is deliberately never
    // persisted), so acting only on `?autoAdvance=1` would leave every
    // "deterministic" screen free-running.
    const { state, sourceRef } = createFakeSource();
    const controls = createHarnessControls(sourceRef);

    await applyHarnessOptions(controls, { ...HARNESS_DEFAULT_OPTIONS, encounter: 'yama_p3', ticks: 4 });

    expect(state.autoAdvance).toBe(false);
    expect(state.currentTick).toBe(4);
  });

  it('applyHarnessOptions re-enables the tick loop when the URL asks for it', async () => {
    const { state, sourceRef } = createFakeSource();
    const controls = createHarnessControls(sourceRef);

    await applyHarnessOptions(controls, { ...HARNESS_DEFAULT_OPTIONS, autoAdvance: true });

    expect(state.autoAdvance).toBe(true);
  });

  it('routes named outcome options without arbitrary warmup ticks or auto-advance', async () => {
    // The stub installs nothing, so the final check, terminal dialogs included, finds no dialog.
    const install = vi.fn(async () => false);
    const { state, sourceRef } = createFakeSource({ installTerminalFixture: install });
    const controls = createHarnessControls(sourceRef);
    await expect(
      applyHarnessOptions(controls, {
        ...HARNESS_DEFAULT_OPTIONS,
        outcome: 'victory',
        practice: true,
        ticks: 999,
        autoAdvance: true,
      }),
    ).rejects.toThrow(/'victory' closed while the rest/);
    expect(install).toHaveBeenCalledExactlyOnceWith('victory', true, expect.any(AbortSignal));
    expect(state.currentTick).toBe(0);
    expect(state.autoAdvance).toBe(false);
  });

  it('does not apply a pending outcome after the initial setup was aborted', async () => {
    const abort = new AbortController();
    const install = vi.fn(async () => false);
    const { state, sourceRef } = createFakeSource({ installTerminalFixture: install });
    sourceRef.current.setAutoAdvance = (enabled) => {
      state.autoAdvance = enabled;
      abort.abort();
    };
    await applyHarnessOptions(
      createHarnessControls(sourceRef),
      { ...HARNESS_DEFAULT_OPTIONS, outcome: 'death' },
      abort.signal,
    );
    expect(install).not.toHaveBeenCalled();
  });
});
