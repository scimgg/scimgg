// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { encounterControlsForKind } from '../../../encounters/modules';
import { SOL_SECTION } from '../../../encounters/solHeredit/controls';
import { SolHereditEncounter } from '../../../encounters/solHeredit/SolHereditEncounter';
import type { SetupContextControls } from '../../../types/setupContext';
import { deleteSetting, loadSetting } from '../../../util/storage';
import { useHudReadouts, usePracticeControls } from '../../hudModel';
import { MobilePracticeControls } from '../../MobilePracticeControls';
import { PracticePane, type PracticePaneProps } from '../PracticePane';

afterEach(() => {
  deleteSetting('practice-options-expanded');
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('starts Options collapsed and remembers explicit changes across a remount', () => {
  const engine = new SimulationEngine({ encounter: new SolHereditEncounter() });
  const args = {
    engine,
    simulationState: engine.getState(),
    mechanicsToggles: encounterControlsForKind('sol_heredit')?.mechanicsToggles ?? [],
  };
  const first = renderHook(() => usePracticeControls(args));
  expect(first.result.current.optionsExpanded).toBe(false);
  act(() => first.result.current.setOptionsExpanded(true));
  expect(loadSetting('practice-options-expanded')).toBe(true);
  first.unmount();
  const second = renderHook(() => usePracticeControls(args));
  expect(second.result.current.optionsExpanded).toBe(true);
  act(() => second.result.current.setOptionsExpanded(false));
  second.unmount();
  expect(renderHook(() => usePracticeControls(args)).result.current.optionsExpanded).toBe(false);
});

// A manual cast ends the interaction but leaves `lastAttackTarget`: the readouts stay on what was cast at.
it.each([
  { label: 'the remembered target once the interaction has ended', attackTarget: null, last: 'add', shown: 'add' },
  { label: 'the boss with no target at all', attackTarget: null, last: null, shown: 'boss' },
  { label: 'the current target over the remembered one', attackTarget: 'boss', last: 'add', shown: 'boss' },
] as const)('reads out $label', ({ attackTarget, last, shown }) => {
  const engine = new SimulationEngine({ encounter: new SolHereditEncounter() });
  const state = engine.getState();
  const sol = state.npcs.find((npc) => npc.role === 'boss');
  if (!sol) throw new Error('Expected Sol');
  const simulationState = {
    ...state,
    npcs: [
      { ...sol, id: 'boss' },
      { ...sol, id: 'add', role: 'npc' as const },
    ],
    attackTarget,
    lastAttackTarget: last,
  };

  const { result } = renderHook(() => useHudReadouts({ simulationState, dpsProjection: null }));

  expect(result.current.targetNpc?.id).toBe(shown);
});

it('routes pinned whole-fight restart separately and removes it during playback', () => {
  const { props, view } = setup();
  const onRestart = vi.fn();
  view.rerender(<PracticePane {...props} onRestart={onRestart} />);
  const restart = screen.getByRole('button', { name: 'Restart fight' });
  const shortcut = within(restart).getByText('Ctrl+R');
  expect(shortcut.tagName).toBe('KBD');
  expect(shortcut).toHaveAttribute('aria-hidden', 'true');
  fireEvent.click(restart);
  expect(onRestart).toHaveBeenCalledOnce();
  view.rerender(<PracticePane {...props} onRestart={onRestart} restoring />);
  expect(screen.getByRole('button', { name: 'Restart fight' })).toBeDisabled();
  view.rerender(<PracticePane {...props} onRestart={onRestart} replaying />);
  expect(screen.queryByRole('button', { name: 'Restart fight' })).toBeNull();
  expect(screen.queryByText('Ctrl+R')).toBeNull();
});

function setup() {
  const engine = new SimulationEngine({ encounter: new SolHereditEncounter() });
  const simulationState = engine.getState();
  const controls = encounterControlsForKind('sol_heredit');
  const props: PracticePaneProps = {
    tab: 'setup',
    onTabChange: vi.fn(),
    replaying: false,
    engine,
    simulationState,
    mechanicsConfig: engine.getMechanicsConfig(),
    onMechanicsConfigChange: vi.fn(),
    onSetBossHp: vi.fn(),
    onExecuteEncounterCommand: vi.fn(),
    practice: {
      optionsExpanded: true,
      setOptionsExpanded: vi.fn(),
      bossNpc: simulationState.npcs.find((npc) => npc.role === 'boss'),
      bossHpPresets: controls?.bossHpPresets ?? [],
      inFightMechanicsToggles: controls?.mechanicsToggles ?? [],
      hasPracticeControls: true,
    },
  };
  let availableHeight = 200;
  let contentHeight = 600;
  let resize = () => {};
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe = observe;
      disconnect = disconnect;
    },
  );
  const isBody = (element: HTMLElement) => element.classList.contains('launcher-pane__body--setup');
  const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return isBody(this) ? contentHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return isBody(this) ? availableHeight - (document.querySelector('.launcher-sections') ? 24 : 0) : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('launcher-sections') ? 24 : 0;
  });
  // The Sol fixture's three stops: its fight setup, Sol's own section (as the Inferno names Zuk's),
  // and the aids.
  const offsets: Record<string, number> = { fightSetup: 0, [`section:${SOL_SECTION}`]: 200, assists: 400 };
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    return offsets[this.dataset.practiceGroup ?? ''] ?? 0;
  });
  const positions = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement,
  ) {
    const body = document.querySelector<HTMLElement>('.launcher-pane__body--setup');
    const top = this.dataset.practiceGroup ? offsets[this.dataset.practiceGroup] - (body?.scrollTop ?? 0) : 0;
    return new DOMRect(0, top, 200, 100);
  });
  const view = render(<PracticePane {...props} />);
  const body = document.querySelector<HTMLElement>('.launcher-pane__body--setup');
  if (!body) throw new Error('missing Setup body');
  for (const group of body.querySelectorAll('[data-practice-group]')) {
    Object.defineProperty(group, 'offsetParent', { configurable: true, value: body });
  }
  return {
    props,
    view,
    body,
    height,
    positions,
    observe,
    disconnect,
    resize: (height: number) => {
      availableHeight = height;
      act(() => resize());
    },
    contentHeight: (height: number) => {
      contentHeight = height;
    },
    rerender: (next: Partial<PracticePaneProps>) => view.rerender(<PracticePane {...props} {...next} />),
  };
}

it('keeps the launcher pane close icon named without a hover hint', () => {
  vi.useFakeTimers();
  const { props, view } = setup();
  view.rerender(<PracticePane {...props} onClose={vi.fn()} />);
  const button = screen.getByRole('button', { name: 'Close Practice' });
  expect(button).not.toHaveAttribute('title');
  fireEvent.pointerEnter(button, { pointerType: 'mouse' });
  act(() => vi.advanceTimersByTime(1000));
  expect(screen.queryByRole('tooltip')).toBeNull();
});

describe('Practice Setup measurement', () => {
  it('keeps checkpoint controls out of both normal Practice tabs', () => {
    const { view, props } = setup();
    for (const tab of ['setup', 'stats'] as const) {
      view.rerender(<PracticePane {...props} tab={tab} />);
      expect(screen.queryByRole('button', { name: /Back .* ticks/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Set start here' })).toBeNull();
    }
    view.rerender(<PracticePane {...props} replaying />);
    expect(screen.getByRole('button', { name: 'Setup' })).toHaveAttribute('aria-disabled', 'true');
  });
  it('ignores tick-changing data but remeasures body and content resizes, excluding the nav height', () => {
    const { props, view, body, height, positions, observe, disconnect, resize, rerender } = setup();
    expect(screen.getByRole('button', { name: 'Fight' })).toBeTruthy();
    expect(observe).toHaveBeenCalledWith(body);
    expect(observe).toHaveBeenCalledWith(document.querySelector('.practice-panel'));
    height.mockClear();
    positions.mockClear();
    rerender({
      simulationState: { ...props.simulationState, currentTick: 1 },
      practice: { ...props.practice, bossNpc: props.practice.bossNpc && { ...props.practice.bossNpc, hp: 123 } },
    });
    expect(height).not.toHaveBeenCalled();
    expect(positions).not.toHaveBeenCalled();
    resize(800);
    expect(height).toHaveBeenCalled();
    expect(document.querySelector('.launcher-sections')).toBeNull();
    resize(200);
    expect(document.querySelector('.launcher-sections')).not.toBeNull();
    // It would overflow only WITH the 24px nav: that must not keep the nav mounted.
    resize(610);
    expect(document.querySelector('.launcher-sections')).toBeNull();
    view.unmount();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('remeasures disclosure and section-list changes without waiting for a resize', () => {
    const { props, height, rerender, contentHeight } = setup();
    height.mockClear();
    contentHeight(150);
    rerender({ practice: { ...props.practice, optionsExpanded: false } });
    expect(height).toHaveBeenCalled();
    expect(document.querySelector('.launcher-sections')).toBeNull();
    contentHeight(600);
    height.mockClear();
    rerender({ practice: { ...props.practice, inFightMechanicsToggles: [] } });
    expect(height).toHaveBeenCalled();
    expect(document.querySelector('.launcher-sections')).toBeNull();
  });

  it('keeps a chosen section through its own scroll and layout changes, then follows manual scrolling', () => {
    const { body, height, resize } = setup();
    const nav = within(document.querySelector('.launcher-sections') as HTMLElement);
    const mechanics = nav.getByRole('button', { name: SOL_SECTION });
    fireEvent.click(mechanics);
    expect(body.scrollTop).toBe(200);
    // The browser may clamp the requested jump before dispatching its scroll event.
    body.scrollTop = 424;
    height.mockClear();
    fireEvent.scroll(body);
    expect(mechanics.getAttribute('aria-pressed')).toBe('true');
    expect(height).not.toHaveBeenCalled();
    resize(200);
    expect(mechanics.getAttribute('aria-pressed')).toBe('true');
    fireEvent.scroll(body);
    expect(nav.getByRole('button', { name: 'Aids' }).getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Reset to defaults in Practice', () => {
  const context = (isDefault: boolean, onReset?: () => () => void): SetupContextControls => ({
    mode: onReset ? 'saved' : 'tutorial',
    isDefault,
    ...(onReset ? { onReset } : {}),
  });

  it('ends the Setup tab while there is something to reset, with its Undo kept across a look at Stats', () => {
    const { props, view } = setup();
    const undo = vi.fn();
    const onReset = vi.fn(() => undo);
    const body = () => within(document.querySelector<HTMLElement>('.practice-panel') as HTMLElement);
    view.rerender(<PracticePane {...props} setupContext={context(true, onReset)} />);
    expect(body().queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
    view.rerender(<PracticePane {...props} setupContext={context(false)} />);
    expect(body().queryByRole('button', { name: 'Reset to defaults' })).toBeNull();
    view.rerender(<PracticePane {...props} setupContext={context(false, onReset)} />);
    fireEvent.click(body().getByRole('button', { name: 'Reset to defaults' }));
    expect(onReset).toHaveBeenCalledOnce();
    view.rerender(<PracticePane {...props} setupContext={context(true, onReset)} />);
    expect(body().getByText('Defaults restored')).toBeInTheDocument();
    view.rerender(<PracticePane {...props} tab="stats" setupContext={context(true, onReset)} />);
    view.rerender(<PracticePane {...props} setupContext={context(true, onReset)} />);
    fireEvent.click(body().getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(body().queryByText('Defaults restored')).toBeNull();
  });

  it('closes the mobile overview with a reset row whose Undo is the whole row', () => {
    const engine = new SimulationEngine({ encounter: new SolHereditEncounter() });
    const controls = encounterControlsForKind('sol_heredit');
    const undo = vi.fn();
    const onReset = vi.fn(() => undo);
    const props = {
      simulationState: engine.getState(),
      engine,
      mechanicsConfig: engine.getMechanicsConfig(),
      onMechanicsConfigChange: vi.fn(),
      mechanicsToggles: controls?.mechanicsToggles ?? [],
      debugActions: [],
      onExecuteEncounterCommand: vi.fn(),
      onSetBossHp: vi.fn(),
      onRestart: vi.fn(),
    };
    const view = render(<MobilePracticeControls {...props} setupContext={context(false, onReset)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back to Practice' }));
    const rows = () =>
      Array.from(document.querySelectorAll('.osm-tools__groups > button')).map((row) => row.textContent);
    expect(rows().at(-1)).toBe('Reset to defaults');
    expect(rows().at(-2)).toBe('Restart fight');
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }));
    view.rerender(<MobilePracticeControls {...props} setupContext={context(true, onReset)} />);
    expect(rows().at(-1)).toBe('Defaults restoredUndo');
    fireEvent.click(screen.getByRole('button', { name: 'Undo reset to defaults' }));
    expect(undo).toHaveBeenCalledOnce();
    view.rerender(<MobilePracticeControls {...props} setupContext={context(true)} />);
    expect(rows().at(-1)).toBe('Restart fight');
  });
});
