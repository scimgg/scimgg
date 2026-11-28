// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlayInterfaceSound } from '../../../audio/interfaceSounds';
import type { EncounterCommand } from '../../../core/encounters/commands';
import type { EncounterSnapshot } from '../../../core/encounters/snapshot';
import { EncounterRunPrompt } from '../../practiceChrome';
import { ColosseumIntermission } from '../ColosseumIntermission';
import { type ColosseumRunPublicState, DIRECT_SOL_RUN_STATE } from '../waves/snapshot';

/** A wave-4 start at its opening offer, with the set configured in setup (`origin: 'set'`). */
const RUN: ColosseumRunPublicState = {
  startWave: 4,
  wave: 4,
  stage: 'intermission',
  waveStartTick: null,
  waveCompletedTick: null,
  reinforcementTick: null,
  solControlTick: null,
  offer: {
    wave: 4,
    options: [
      { id: 'doom', tier: 2 },
      { id: 'bees', tier: 1 },
      { id: 'quartet', tier: 1 },
    ],
    // The panel reads the options alone, so the fixture keeps the eligible picks to them.
    eligible: [
      { id: 'doom', tier: 2 },
      { id: 'bees', tier: 1 },
      { id: 'quartet', tier: 1 },
    ],
  },
  picks: [
    { origin: 'set', wave: null, id: 'doom', tier: 1, tick: null },
    { origin: 'set', wave: null, id: 'totemic', tier: 1, tick: null },
    { origin: 'set', wave: null, id: 'myopia', tier: 1, tick: null },
  ],
};

function renderPanel(
  run: ColosseumRunPublicState = RUN,
  execute = vi.fn<(command: EncounterCommand) => boolean>(() => true),
  mobileLayout = false,
) {
  const playSound = vi.fn<PlayInterfaceSound>();
  const view = render(
    <ColosseumIntermission
      run={run}
      attempt={0}
      currentTick={0}
      execute={execute}
      mobileLayout={mobileLayout}
      playSound={playSound}
    />,
  );
  return { ...view, execute, playSound };
}

const option = (name: RegExp) =>
  within(screen.getByRole('group', { name: 'Modifiers on offer' })).getByRole('button', { name });
const continueButton = () => screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;

describe('ColosseumIntermission', () => {
  afterEach(cleanup);

  it('shows the three offers at the tier each would become, with their tier text', () => {
    renderPanel();
    const offers = within(screen.getByRole('group', { name: 'Modifiers on offer' })).getAllByRole('button');
    expect(offers).toHaveLength(3);
    // Doom is owned at I, so it is offered at II with tier II's text, and says what it raises.
    expect(offers[0].textContent).toBe('Doom II from IDoom kills at 10 stacks.');
    expect(offers[1].textContent).toBe('Bees! I1 bee swarm');
    // A single-tier modifier carries no numeral.
    expect(offers[2].textContent).toContain('Quartet');
    expect(offers[2].textContent).not.toContain('Quartet I');
    for (const offer of offers) expect(offer.getAttribute('aria-pressed')).toBe('false');
  });

  it('names the wave it leads into and lists what is owned, with where each tier came from', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Before wave 4' })).toBeTruthy();
    expect(screen.getByText('Choose a modifier for wave 4.')).toBeTruthy();
    const owned = within(screen.getByRole('list', { name: 'Owned modifiers' }))
      .getAllByRole('listitem')
      .map((item) => item.textContent);
    expect(owned).toEqual(['Doom ISetup', 'TotemicSetup', 'Myopia ISetup']);
  });

  it('heads a later intermission with the wave just completed, and the owned tier is the highest picked', () => {
    renderPanel({
      ...RUN,
      startWave: 1,
      wave: 3,
      offer: { ...RUN.offer!, wave: 3 },
      picks: [
        { origin: 'live', wave: 1, id: 'doom', tier: 1, tick: 0 },
        { origin: 'live', wave: 2, id: 'doom', tier: 2, tick: 140 },
      ],
    });
    expect(screen.getByRole('heading', { name: 'Wave 2 complete' })).toBeTruthy();
    const owned = within(screen.getByRole('list', { name: 'Owned modifiers' })).getAllByRole('listitem');
    // The source is the pick that gave the tier now held.
    expect(owned.map((item) => item.textContent)).toEqual(['Doom IIWave 2']);
  });

  it('keeps Continue disabled until an option is selected, and selecting only highlights it', () => {
    const { execute } = renderPanel();
    expect(continueButton().disabled).toBe(true);
    fireEvent.click(option(/^Bees! I/));
    expect(option(/^Bees! I/).getAttribute('aria-pressed')).toBe('true');
    expect(continueButton().disabled).toBe(false);
    // Changing the selection is still only a highlight.
    fireEvent.click(option(/^Doom II/));
    expect(option(/^Doom II/).getAttribute('aria-pressed')).toBe('true');
    expect(option(/^Bees! I/).getAttribute('aria-pressed')).toBe('false');
    expect(execute).not.toHaveBeenCalled();
  });

  it('clears the selection when the selected option is clicked again, as the game does', () => {
    renderPanel();
    fireEvent.click(option(/^Bees! I/));
    fireEvent.click(option(/^Bees! I/));
    expect(option(/^Bees! I/).getAttribute('aria-pressed')).toBe('false');
    expect(continueButton().disabled).toBe(true);
  });

  it("plays the client's select sound on every option click and its hover sound for a mouse only", () => {
    const { playSound } = renderPanel();
    fireEvent.click(option(/^Bees! I/));
    fireEvent.click(option(/^Bees! I/));
    expect(playSound.mock.calls).toEqual([['select'], ['select']]);
    playSound.mockClear();
    fireEvent.pointerOver(option(/^Doom II/), { pointerType: 'mouse' });
    fireEvent.pointerOver(option(/^Quartet/), { pointerType: 'touch' });
    expect(playSound.mock.calls).toEqual([['colosseumOptionHover']]);
    // Continue plays nothing here: the run's own sound marks the tick the choice is taken.
    playSound.mockClear();
    fireEvent.click(continueButton());
    expect(playSound).not.toHaveBeenCalled();
  });

  it('sends exactly one confirm-modifier for the offer on Continue', () => {
    const { execute } = renderPanel();
    fireEvent.click(option(/^Doom II/));
    fireEvent.click(continueButton());
    fireEvent.click(continueButton());
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      encounter: 'sol_heredit',
      type: 'confirm-modifier',
      wave: 4,
      modifierId: 'doom',
    });
    expect(continueButton().disabled).toBe(true);
  });

  it('hides and reopens without sending anything or drawing new offers, keeping the selection', () => {
    const { execute } = renderPanel();
    fireEvent.click(option(/^Bees! I/));
    fireEvent.click(screen.getByRole('button', { name: 'Hide the modifier choice' }));
    expect(screen.queryByRole('group', { name: 'Modifiers on offer' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Wave 4: choose a modifier' }));
    const offers = within(screen.getByRole('group', { name: 'Modifiers on offer' })).getAllByRole('button');
    expect(offers.map((offer) => offer.querySelector('.colosseum-option__name')?.textContent)).toEqual([
      'Doom II from I',
      'Bees! I',
      'Quartet',
    ]);
    expect(option(/^Bees! I/).getAttribute('aria-pressed')).toBe('true');
    expect(execute).not.toHaveBeenCalled();
  });

  it('hides on Escape and sends nothing', () => {
    const { execute } = renderPanel();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.getByRole('button', { name: 'Wave 4: choose a modifier' })).toBeTruthy();
    expect(execute).not.toHaveBeenCalled();
  });

  it('offers Continue again when the engine refuses to queue the choice', () => {
    const execute = vi.fn<(command: EncounterCommand) => boolean>(() => false);
    renderPanel(RUN, execute);
    fireEvent.click(option(/^Doom II/));
    fireEvent.click(continueButton());
    expect(continueButton().disabled).toBe(false);
  });

  it('offers Continue again once a tick passes with the offer still open (the run refused it)', () => {
    const execute = vi.fn<(command: EncounterCommand) => boolean>(() => true);
    const { rerender } = render(<ColosseumIntermission run={RUN} attempt={0} currentTick={10} execute={execute} />);
    fireEvent.click(option(/^Doom II/));
    fireEvent.click(continueButton());
    expect(continueButton().disabled).toBe(true);
    rerender(<ColosseumIntermission run={RUN} attempt={0} currentTick={11} execute={execute} />);
    expect(continueButton().disabled).toBe(false);
  });

  it('starts the next offer unselected and open', () => {
    const execute = vi.fn<(command: EncounterCommand) => boolean>(() => true);
    const { rerender } = render(<ColosseumIntermission run={RUN} attempt={0} currentTick={0} execute={execute} />);
    fireEvent.click(option(/^Doom II/));
    fireEvent.click(screen.getByRole('button', { name: 'Hide the modifier choice' }));
    const next: ColosseumRunPublicState = {
      ...RUN,
      wave: 5,
      offer: {
        wave: 5,
        options: [
          { id: 'solarflare', tier: 1 },
          { id: 'bees', tier: 1 },
          { id: 'frailty', tier: 1 },
        ],
        eligible: [
          { id: 'solarflare', tier: 1 },
          { id: 'bees', tier: 1 },
          { id: 'frailty', tier: 1 },
        ],
      },
      picks: [...RUN.picks, { origin: 'live', wave: 4, id: 'doom', tier: 2, tick: 1 }],
    };
    rerender(<ColosseumIntermission run={next} attempt={0} currentTick={300} execute={execute} />);
    expect(screen.getByRole('heading', { name: 'Wave 4 complete' })).toBeTruthy();
    expect(continueButton().disabled).toBe(true);
    for (const offer of within(screen.getByRole('group', { name: 'Modifiers on offer' })).getAllByRole('button')) {
      expect(offer.getAttribute('aria-pressed')).toBe('false');
    }
  });

  describe('across a restart on the same wave', () => {
    /** The same wave-4 opening a restart draws again, with another seed's offer. */
    const REDRAWN: ColosseumRunPublicState = {
      ...RUN,
      offer: {
        wave: 4,
        options: [
          { id: 'bees', tier: 1 },
          { id: 'quartet', tier: 1 },
          { id: 'frailty', tier: 1 },
        ],
        eligible: [
          { id: 'bees', tier: 1 },
          { id: 'quartet', tier: 1 },
          { id: 'frailty', tier: 1 },
        ],
      },
    };

    function renderAttempt(execute = vi.fn<(command: EncounterCommand) => boolean>(() => true)) {
      const view = render(<ColosseumIntermission run={RUN} attempt={1} currentTick={0} execute={execute} />);
      const restart = (run: ColosseumRunPublicState, attempt = 2) =>
        view.rerender(<ColosseumIntermission run={run} attempt={attempt} currentTick={0} execute={execute} />);
      return { ...view, execute, restart };
    }

    it('starts unselected and open when the restart draws the same offer', () => {
      const { restart } = renderAttempt();
      fireEvent.click(option(/^Doom II/));
      fireEvent.click(screen.getByRole('button', { name: 'Hide the modifier choice' }));
      restart(RUN);
      expect(screen.getByRole('group', { name: 'Modifiers on offer' })).toBeTruthy();
      expect(option(/^Doom II/).getAttribute('aria-pressed')).toBe('false');
      expect(continueButton().disabled).toBe(true);
    });

    it("drops a pending send, so the new attempt's tick 0 is not mistaken for it", () => {
      const { execute, restart } = renderAttempt();
      fireEvent.click(option(/^Doom II/));
      fireEvent.click(continueButton());
      expect(continueButton().disabled).toBe(true);
      restart(RUN);
      fireEvent.click(option(/^Bees! I/));
      expect(continueButton().disabled).toBe(false);
      fireEvent.click(continueButton());
      expect(execute.mock.calls.map(([command]) => command)).toEqual([
        { encounter: 'sol_heredit', type: 'confirm-modifier', wave: 4, modifierId: 'doom' },
        { encounter: 'sol_heredit', type: 'confirm-modifier', wave: 4, modifierId: 'bees' },
      ]);
    });

    it('never sends a choice the new offer does not hold', () => {
      const { execute, restart } = renderAttempt();
      fireEvent.click(option(/^Doom II/));
      restart(REDRAWN);
      expect(continueButton().disabled).toBe(true);
      fireEvent.click(continueButton());
      expect(execute).not.toHaveBeenCalled();
      // Even within one attempt, an option the offer no longer holds is no choice.
      cleanup();
      const same = renderAttempt();
      fireEvent.click(option(/^Doom II/));
      same.restart(REDRAWN, 1);
      expect(continueButton().disabled).toBe(true);
      fireEvent.click(continueButton());
      expect(same.execute).not.toHaveBeenCalled();
    });

    it('drops what Mobile was inspecting', () => {
      const execute = vi.fn<(command: EncounterCommand) => boolean>(() => true);
      const { rerender } = render(
        <ColosseumIntermission run={RUN} attempt={1} currentTick={0} execute={execute} mobileLayout />,
      );
      const chips = within(screen.getByRole('list', { name: 'Owned modifiers' })).getAllByRole('button');
      fireEvent.click(chips[0]);
      expect(screen.getByText('Doom I, from setup.')).toBeTruthy();
      rerender(<ColosseumIntermission run={RUN} attempt={2} currentTick={0} execute={execute} mobileLayout />);
      expect(screen.getByText('Tap a modifier to see what it does.')).toBeTruthy();
    });
  });

  describe('choosing another eligible modifier', () => {
    /** The run accepts two picks beyond the three it drew: Blasphemy at II (owned at I) and Solarflare. */
    const WIDE: ColosseumRunPublicState = {
      ...RUN,
      offer: {
        ...RUN.offer!,
        eligible: [
          { id: 'solarflare', tier: 1 },
          { id: 'doom', tier: 2 },
          { id: 'blasphemy', tier: 2 },
          { id: 'bees', tier: 1 },
          { id: 'quartet', tier: 1 },
        ],
      },
      picks: [...RUN.picks, { origin: 'set', wave: null, id: 'blasphemy', tier: 1, tick: null }],
    };
    const toggle = () => screen.getByRole('button', { name: /^Choose another/ });
    const other = (name: RegExp) =>
      within(screen.getByRole('group', { name: 'Other modifiers' })).getByRole('button', { name });

    it('offers no way past the three when the run accepts nothing else', () => {
      renderPanel();
      expect(screen.queryByRole('button', { name: /^Choose another/ })).toBeNull();
    });

    it('opens the eligible picks the offer left out, in display order and at their tier', () => {
      renderPanel(WIDE);
      expect(toggle().textContent).toBe('Choose another2 more');
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(screen.queryByRole('group', { name: 'Other modifiers' })).toBeNull();
      fireEvent.click(toggle());
      expect(toggle().getAttribute('aria-expanded')).toBe('true');
      const others = within(screen.getByRole('group', { name: 'Other modifiers' })).getAllByRole('button');
      expect(others.map((button) => button.textContent)).toEqual(['Solarflare I', 'Blasphemy II']);
      // The three stay where they were, still the first choice on the panel.
      expect(within(screen.getByRole('group', { name: 'Modifiers on offer' })).getAllByRole('button')).toHaveLength(3);
    });

    it('selects one in place of the three, with the same sounds, and Continue sends it', () => {
      const { execute, playSound } = renderPanel(WIDE);
      fireEvent.click(option(/^Bees! I/));
      fireEvent.click(toggle());
      playSound.mockClear();
      fireEvent.pointerOver(other(/^Blasphemy II/), { pointerType: 'mouse' });
      fireEvent.click(other(/^Blasphemy II/));
      expect(playSound.mock.calls).toEqual([['colosseumOptionHover'], ['select']]);
      expect(other(/^Blasphemy II/).getAttribute('aria-pressed')).toBe('true');
      expect(option(/^Bees! I/).getAttribute('aria-pressed')).toBe('false');
      expect(screen.getByText(/Up from Blasphemy I\./)).toBeTruthy();
      fireEvent.click(continueButton());
      expect(execute.mock.calls.map(([command]) => command)).toEqual([
        { encounter: 'sol_heredit', type: 'confirm-modifier', wave: 4, modifierId: 'blasphemy' },
      ]);
    });

    it('drops a choice made there when it is closed, and choosing it again clears it', () => {
      renderPanel(WIDE);
      fireEvent.click(toggle());
      fireEvent.click(other(/^Solarflare I/));
      fireEvent.click(other(/^Solarflare I/));
      expect(continueButton().disabled).toBe(true);
      fireEvent.click(other(/^Solarflare I/));
      expect(continueButton().disabled).toBe(false);
      fireEvent.click(toggle());
      expect(continueButton().disabled).toBe(true);
      fireEvent.click(toggle());
      expect(other(/^Solarflare I/).getAttribute('aria-pressed')).toBe('false');
      // An offered choice survives the list opening and closing.
      fireEvent.click(option(/^Doom II/));
      fireEvent.click(toggle());
      expect(option(/^Doom II/).getAttribute('aria-pressed')).toBe('true');
      expect(continueButton().disabled).toBe(false);
    });

    it('keeps the choice to one attempt and one offer, and to what that offer accepts', () => {
      const execute = vi.fn<(command: EncounterCommand) => boolean>(() => true);
      const { rerender } = render(<ColosseumIntermission run={WIDE} attempt={1} currentTick={0} execute={execute} />);
      fireEvent.click(toggle());
      fireEvent.click(other(/^Solarflare I/));
      // The same attempt's offer no longer accepting it: no choice, and nothing sent.
      rerender(
        <ColosseumIntermission
          run={{
            ...WIDE,
            offer: { ...WIDE.offer!, eligible: WIDE.offer!.eligible.filter(({ id }) => id !== 'solarflare') },
          }}
          attempt={1}
          currentTick={0}
          execute={execute}
        />,
      );
      expect(continueButton().disabled).toBe(true);
      fireEvent.click(continueButton());
      // A restart drawing the same offer starts closed and unselected.
      rerender(<ColosseumIntermission run={WIDE} attempt={2} currentTick={0} execute={execute} />);
      expect(toggle().getAttribute('aria-expanded')).toBe('false');
      expect(continueButton().disabled).toBe(true);
      expect(execute).not.toHaveBeenCalled();
    });

    it('works the same in the Mobile sheet: a +N tile, icon chips and a named detail line', () => {
      const { execute } = renderPanel(WIDE, undefined, true);
      const more = screen.getByRole('button', { name: 'Choose another modifier' });
      expect(more.textContent).toBe('+2more');
      fireEvent.click(more);
      expect(more.getAttribute('aria-expanded')).toBe('true');
      fireEvent.click(other(/^Blasphemy II$/));
      const detail = document.querySelector('.colosseum-intermission__detail')?.textContent ?? '';
      expect(detail.startsWith('Blasphemy II Drain 2 prayer points')).toBe(true);
      expect(detail.endsWith(' Up from Blasphemy I.')).toBe(true);
      fireEvent.click(continueButton());
      expect(execute).toHaveBeenCalledWith({
        encounter: 'sol_heredit',
        type: 'confirm-modifier',
        wave: 4,
        modifierId: 'blasphemy',
      });
    });
  });

  it('centers a desktop panel and its bar on the scene it is given', () => {
    const scenePlacement = { top: 4, bottom: 338, left: 4, right: 516, panelLeft: 60, panelWidth: 400 };
    render(
      <ColosseumIntermission run={RUN} attempt={0} currentTick={0} execute={vi.fn()} scenePlacement={scenePlacement} />,
    );
    const panel = screen.getByRole('region', { name: 'Choose a modifier for wave 4' });
    expect(panel.classList.contains('colosseum-intermission--in-scene')).toBe(true);
    expect(panel.style.getPropertyValue('--panel-left')).toBe('60px');
    expect(panel.style.getPropertyValue('--panel-width')).toBe('400px');
    fireEvent.click(screen.getByRole('button', { name: 'Hide the modifier choice' }));
    const bar = screen.getByRole('button', { name: 'Wave 4: choose a modifier' });
    expect(bar.classList.contains('colosseum-intermission--in-scene')).toBe(true);
    expect(bar.style.getPropertyValue('--scene-right')).toBe('516px');
  });
});

describe('EncounterRunPrompt', () => {
  afterEach(cleanup);

  const snapshot = (run: ColosseumRunPublicState | undefined) =>
    ({ kind: 'sol_heredit', state: { modifiers: {}, run }, visuals: {} }) as unknown as EncounterSnapshot;

  it('draws the choice only while an offer is open', () => {
    const execute = vi.fn();
    const { rerender, container } = render(
      <EncounterRunPrompt snapshot={snapshot(RUN)} attempt={0} currentTick={0} execute={execute} />,
    );
    expect(screen.getByRole('group', { name: 'Modifiers on offer' })).toBeTruthy();
    rerender(
      <EncounterRunPrompt
        snapshot={snapshot({ ...RUN, stage: 'wave', offer: null })}
        attempt={0}
        currentTick={9}
        execute={execute}
      />,
    );
    expect(container.innerHTML).toBe('');
    // A direct Sol start, and a recording from before the waves, have no prompt.
    rerender(
      <EncounterRunPrompt snapshot={snapshot(DIRECT_SOL_RUN_STATE)} attempt={0} currentTick={0} execute={execute} />,
    );
    expect(container.innerHTML).toBe('');
    rerender(<EncounterRunPrompt snapshot={snapshot(undefined)} attempt={0} currentTick={0} execute={execute} />);
    expect(container.innerHTML).toBe('');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('ColosseumIntermission on Mobile', () => {
  afterEach(cleanup);

  const tile = (name: string) =>
    within(screen.getByRole('group', { name: 'Modifiers on offer' })).getByRole('button', { name });

  it('draws three tiles, the chosen one in the detail line, and the owned set as chips by source', () => {
    const { execute } = renderPanel(
      { ...RUN, picks: [...RUN.picks.slice(0, 2), { origin: 'live', wave: 3, id: 'myopia', tier: 1, tick: 9 }] },
      undefined,
      true,
    );
    expect(screen.getByRole('heading', { name: 'Before wave 4 · choose a modifier' })).toBeTruthy();
    expect(screen.getByText('Tap a modifier to see what it does.')).toBeTruthy();
    fireEvent.click(tile('Doom II'));
    expect(screen.getByText(/Doom kills at 10 stacks\./).textContent).toBe('Doom kills at 10 stacks. Up from Doom I.');
    const chips = within(screen.getByRole('list', { name: 'Owned modifiers' })).getAllByRole('button');
    expect(chips.map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'Doom I, from setup',
      'Totemic, from setup',
      'Myopia I, picked for wave 3',
    ]);
    expect(chips.map((chip) => chip.classList.contains('colosseum-chip--set'))).toEqual([true, true, false]);
    // A chip names itself in the detail line; choosing an option shows the option again.
    fireEvent.click(chips[2]);
    expect(screen.getByText('Myopia I, picked for wave 3.')).toBeTruthy();
    fireEvent.click(tile('Doom II'));
    fireEvent.click(tile('Doom II'));
    expect(document.querySelector('.colosseum-intermission__detail')?.textContent).toBe(
      'Doom kills at 10 stacks. Up from Doom I.',
    );
    fireEvent.click(continueButton());
    expect(execute).toHaveBeenCalledWith({
      encounter: 'sol_heredit',
      type: 'confirm-modifier',
      wave: 4,
      modifierId: 'doom',
    });
  });

  describe('"+N more" by touch', () => {
    /** Wave 7 with nothing owned: every supported pick is eligible, nine beyond the three. */
    const MANY: ColosseumRunPublicState = {
      ...RUN,
      startWave: 7,
      wave: 7,
      offer: {
        wave: 7,
        options: [
          { id: 'doom', tier: 1 },
          { id: 'bees', tier: 1 },
          { id: 'quartet', tier: 1 },
        ],
        eligible: (
          [
            'solarflare',
            'volatility',
            'doom',
            'frailty',
            'blasphemy',
            'myopia',
            'bees',
            'quartet',
            'totemic',
            'relentless',
            'dynamicDuo',
            'redFlag',
          ] as const
        ).map((id) => ({ id, tier: 1 })),
      },
      picks: [],
    };
    const more = () => screen.getByRole('button', { name: 'Choose another modifier' });
    const chip = (name: string) =>
      within(screen.getByRole('group', { name: 'Other modifiers' })).getByRole('button', { name });
    /** What a touchscreen sends for one tap: touch pointer events, then the compatibility mouse events. */
    const tap = (element: HTMLElement) => {
      fireEvent.pointerOver(element, { pointerType: 'touch' });
      fireEvent.pointerEnter(element, { pointerType: 'touch' });
      fireEvent.pointerDown(element, { pointerType: 'touch' });
      fireEvent.pointerUp(element, { pointerType: 'touch' });
      fireEvent.mouseOver(element);
      fireEvent.mouseDown(element);
      fireEvent.mouseUp(element);
      fireEvent.click(element);
    };

    it('plays the click sound once per tap and never the hover sound', () => {
      const { playSound } = renderPanel(MANY, undefined, true);
      tap(more());
      expect(playSound).not.toHaveBeenCalled();
      tap(chip('Red Flag'));
      expect(playSound.mock.calls).toEqual([['select']]);
      tap(chip('Red Flag'));
      expect(playSound.mock.calls).toEqual([['select'], ['select']]);
    });

    it('selects and clears with the list open, then sends the tapped pick', () => {
      const { execute } = renderPanel(MANY, undefined, true);
      tap(more());
      expect(within(screen.getByRole('group', { name: 'Other modifiers' })).getAllByRole('button')).toHaveLength(9);
      tap(chip('Red Flag'));
      expect(chip('Red Flag').getAttribute('aria-pressed')).toBe('true');
      expect(document.querySelector('.colosseum-intermission__detail-name')?.textContent).toBe('Red Flag ');
      tap(chip('Red Flag'));
      expect(chip('Red Flag').getAttribute('aria-pressed')).toBe('false');
      expect(continueButton().disabled).toBe(true);
      // An offered tile still works with the list open, and the list stays.
      tap(tile('Doom I'));
      expect(tile('Doom I').getAttribute('aria-pressed')).toBe('true');
      tap(chip('Dynamic Duo'));
      expect(tile('Doom I').getAttribute('aria-pressed')).toBe('false');
      // Hiding and showing the sheet keeps the list open and the choice.
      tap(screen.getByRole('button', { name: 'Hide the modifier choice' }));
      tap(screen.getByRole('button', { name: 'Wave 7: choose a modifier' }));
      expect(more().getAttribute('aria-expanded')).toBe('true');
      expect(chip('Dynamic Duo').getAttribute('aria-pressed')).toBe('true');
      tap(continueButton());
      expect(execute.mock.calls.map(([command]) => command)).toEqual([
        { encounter: 'sol_heredit', type: 'confirm-modifier', wave: 7, modifierId: 'dynamicDuo' },
      ]);
    });

    it('scrolls only the tiles and picks, keeping the header, detail line and Continue outside the scroller', () => {
      renderPanel(MANY, undefined, true);
      tap(more());
      const scroller = document.querySelector('.colosseum-intermission__scroll')!;
      expect(scroller.contains(screen.getByRole('group', { name: 'Modifiers on offer' }))).toBe(true);
      expect(scroller.contains(screen.getByRole('group', { name: 'Other modifiers' }))).toBe(true);
      for (const pinned of [
        document.querySelector('.colosseum-intermission__head')!,
        document.querySelector('.colosseum-intermission__detail')!,
        continueButton(),
      ]) {
        expect(scroller.contains(pinned)).toBe(false);
      }
    });

    it('lets the scroller shrink on its own fill, and hovers only where a pointer can hover (CSS)', () => {
      const css = readFileSync(resolve(__dirname, '../ColosseumIntermission.css'), 'utf8').replace(
        /\/\*[\s\S]*?\*\//g,
        '',
      );
      const rule = (selector: string) => {
        const match = new RegExp(`(^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
        return match?.[2] ?? '';
      };
      const scroll = rule('.colosseum-intermission__scroll');
      expect(scroll).toMatch(/flex: 0 1 auto;/);
      expect(scroll).toMatch(/overflow-y: auto;/);
      expect(scroll).toMatch(/background: var\(--color-bg-solid\);/);
      for (const pinned of [
        '.colosseum-intermission__head',
        '.colosseum-intermission__detail',
        '.colosseum-intermission__foot',
      ])
        expect(rule(pinned)).toMatch(/flex: none;/);
      // A tap leaves :hover on the tapped control; every hover rule for a choice sits behind (hover: hover).
      const top = css.replace(/@media \(hover: hover\) \{(?:[^{}]*\{[^}]*\})*\s*\}/g, '');
      expect(top).not.toMatch(
        /\.colosseum-(tile|other|option)(?![^,{]*(is-selected|aria-expanded))[^,{]*:hover:not\(:disabled\)/,
      );
    });
  });

  it('hides to a bar and says when nothing is owned yet', () => {
    renderPanel({ ...RUN, picks: [] }, undefined, true);
    expect(screen.getByText('No modifiers yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the modifier choice' }));
    expect(screen.getByRole('button', { name: 'Wave 4: choose a modifier' })).toBeTruthy();
  });
});
