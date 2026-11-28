// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { type ComponentProps, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EncounterRegistry } from '../../../core/encounters/encounterFactory';
import type { DebugActionInfo } from '../../../core/encounters/types';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { InfernoEncounter } from '../../../encounters/inferno/InfernoEncounter';
import { encounterControlsForKind } from '../../../encounters/modules';
import { SOL_SECTION } from '../../../encounters/solHeredit/controls';
import { SolHereditEncounter } from '../../../encounters/solHeredit/SolHereditEncounter';
import { YamaEncounter } from '../../../encounters/yamaP3/YamaEncounter';
import { createZukWaveEncounter } from '../../../test/helpers/zukWave';
import { TUTORIAL_HUD_OPENED_EVENT, TUTORIAL_REPLAY_ENTERED_EVENT } from '../../../tutorial/events';
import { saveTutorialProgress } from '../../../tutorial/persistence';
import { useTutorialDirector } from '../../../tutorial/runtime/useTutorialDirector';
import { makeReplayPractice } from '../../__tests__/ReplayPractice.fixtures';
import { DraggablePanel } from '../../DraggablePanel';
import { EncounterPicker } from '../../EncounterPicker';
import { ReplayControls } from '../../ReplayControls';
import { PanelSnapRegistryProvider } from '../../snap/PanelSnapRegistry';
import { TooltipProvider } from '../../Tooltip';
import { TopChrome } from '../TopChrome';

// The real icons, counted: an icon renders exactly when its launcher does.
const iconRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock('../launcherIcons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../launcherIcons')>();
  return {
    ...actual,
    LauncherIcon: (props: ComponentProps<typeof actual.LauncherIcon>) => {
      iconRenders.count++;
      return <actual.LauncherIcon {...props} />;
    },
  };
});

const ACTIONS: DebugActionInfo[] = [
  { command: { encounter: 'sol_heredit', type: 'trigger-grapple' }, label: 'Trigger grapple' },
  { command: { encounter: 'sol_heredit', type: 'spawn-crystal' }, label: 'Add beam crystal' },
];

function rect(x: number, y: number, width: number, height: number): DOMRect {
  return new DOMRect(x, y, width, height);
}

let frame: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('innerWidth', 765);
  vi.stubGlobal('innerHeight', 503);
  // A Fixed 1x frame filling the window, its chat open, as the browser would lay it out.
  frame = document.createElement('div');
  frame.getBoundingClientRect = () => rect(0, 0, 765, 503);
  const chat = document.createElement('div');
  chat.className = 'chatbox';
  chat.getBoundingClientRect = () => rect(0, 338, 519, 165);
  frame.append(chat);
  document.body.append(frame);
  // happy-dom lays nothing out: give every launcher a width so the row measures.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('launcher-btn--icon')) return rect(0, 0, 28, 28);
    if (this.classList.contains('launcher-btn')) return rect(0, 0, 70, 28);
    return rect(0, 0, 0, 0);
  });
});

afterEach(() => {
  localStorage.removeItem('practice-options-expanded');
  cleanup();
  frame.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function solEngine() {
  return new SimulationEngine({ encounter: new SolHereditEncounter() });
}

function renderChrome(overrides: Partial<ComponentProps<typeof TopChrome>> = {}) {
  const engine = (overrides.engine as SimulationEngine | undefined) ?? solEngine();
  const props: ComponentProps<typeof TopChrome> = {
    frameRef: { current: frame },
    fixed: true,
    zoom: 1,
    layoutKey: 'fixed',
    settings: { open: false, inset: 0 },
    menu: {
      items: (
        <button type="button" data-menu-item="settings">
          Settings
        </button>
      ),
      pinned: false,
    },
    plugins: null,
    showFps: false,
    engine,
    simulationState: engine.getState(),
    mechanicsConfig: engine.getMechanicsConfig(),
    onMechanicsConfigChange: vi.fn(),
    mechanicsToggles: encounterControlsForKind('sol_heredit')?.mechanicsToggles ?? [],
    debugActions: ACTIONS,
    onExecuteEncounterCommand: vi.fn(),
    onSetBossHp: vi.fn(),
    replay: { hasRecording: true, isReplaying: false, onEnter: vi.fn(), onExit: vi.fn(), notice: null },
    ...overrides,
  };
  const view = render(<TopChrome {...props} />);
  return {
    view,
    props,
    rerender: (next: Partial<ComponentProps<typeof TopChrome>>) => view.rerender(<TopChrome {...props} {...next} />),
  };
}

/** Plugins' measured width: the corner TopChrome places. */
const CORNER_WIDTH = 66;
const row = () => document.querySelector<HTMLElement>('nav.launcher-row');
const launcher = (name: string) => within(row() as HTMLElement).getByRole('button', { name });
const pane = () => document.querySelector<HTMLElement>('.launcher-pane');

describe('encounter-provided layout launcher', () => {
  function infernoChrome(wave = 52, overrides: Partial<ComponentProps<typeof TopChrome>> = {}) {
    const engine = new SimulationEngine({ encounter: new InfernoEncounter() });
    engine.setMechanicsConfig({ ...engine.getMechanicsConfig(), infernoStartWave: String(wave) });
    return renderChrome({
      engine,
      simulationState: engine.getState(),
      mechanicsConfig: engine.getMechanicsConfig(),
      mechanicsToggles: encounterControlsForKind('inferno')?.mechanicsToggles ?? [],
      debugActions: [],
      ...overrides,
    });
  }
  const actionLabels = () =>
    within(pane() as HTMLElement)
      .getAllByRole('button')
      .map((button) => button.textContent);
  it.each([
    [52, ['Retry Wave', 'Lock Layout']],
    // 67's lone Jad always spawns alike: Retry alone.
    [67, ['Retry Wave']],
    [69, ['Retry Wave', 'Spawn set', 'Spawn Jad', 'Spawn healers']],
  ])('lists Zuk actions in the Actions palette only on wave 69 (wave %i)', (wave, expected) => {
    infernoChrome(wave, { debugActions: encounterControlsForKind('inferno')?.debugActions ?? [] });
    fireEvent.click(launcher('Actions'));
    const labels = actionLabels();
    for (const label of expected) expect(labels).toContain(label);
    if (wave !== 69) expect(labels).not.toContain('Spawn set');
    // Lock Layout only where it keeps something: not 67, nor 69 (its run seed picks only a shield start).
    if (!expected.includes('Lock Layout')) expect(labels).not.toContain('Lock Layout');
    // No custom layout for the wave: Retry already rolls new spawns, so Random Spawns is not listed.
    expect(labels).not.toContain('Random Spawns');
  });
  it('lists Random Spawns or Lock Layout as the run places its wave, whatever the saved setup says', () => {
    const { props, rerender } = infernoChrome(6, { debugActions: encounterControlsForKind('inferno')?.debugActions });
    fireEvent.click(launcher('Actions'));
    expect(actionLabels()).not.toContain('Random Spawns');
    expect(actionLabels()).toContain('Lock Layout');
    // A saved layout for this wave, not yet applied to the run: the run is still random.
    const savedCustom = { ...props.mechanicsConfig, infernoSpawnLayout: '6:-b-l----b' };
    rerender({ mechanicsConfig: savedCustom });
    expect(actionLabels()).toContain('Lock Layout');
    expect(actionLabels()).not.toContain('Random Spawns');
    // The run itself on the same wave placing it from that layout (Go applied it): Random Spawns.
    const random = props.simulationState.encounter;
    if (random.kind !== 'inferno') throw new Error('wrong encounter');
    const custom = { ...random, state: { ...random.state, startSpawnLayout: '6:-b-l----b' } };
    rerender({ mechanicsConfig: savedCustom, simulationState: { ...props.simulationState, encounter: custom } });
    expect(actionLabels()).toEqual(expect.arrayContaining(['Retry Wave', 'Random Spawns']));
    expect(actionLabels()).not.toContain('Lock Layout');
    fireEvent.click(within(pane() as HTMLElement).getByRole('button', { name: 'Random Spawns' }));
    expect(props.onExecuteEncounterCommand).toHaveBeenLastCalledWith({ encounter: 'inferno', type: 'reroll-wave' });
    // The saved setup gone random again, the run still custom: unchanged.
    rerender({
      mechanicsConfig: props.mechanicsConfig,
      simulationState: { ...props.simulationState, encounter: custom },
    });
    expect(actionLabels()).toContain('Random Spawns');
    // The run random on the wave once more (after Random spawns): Lock Layout, which keeps those spawns.
    rerender({ mechanicsConfig: savedCustom, simulationState: { ...props.simulationState, encounter: random } });
    expect(actionLabels()).not.toContain('Random Spawns');
    fireEvent.click(within(pane() as HTMLElement).getByRole('button', { name: 'Lock Layout' }));
    expect(props.onExecuteEncounterCommand).toHaveBeenLastCalledWith({ encounter: 'inferno', type: 'keep-spawns' });
    // The run keeping wave 6's spawns (its snapshot, never the saved setup, which has no pin): Random Spawns.
    const pinned = { ...random, state: { ...random.state, pinnedWave: 6 } };
    rerender({ mechanicsConfig: savedCustom, simulationState: { ...props.simulationState, encounter: pinned } });
    expect(actionLabels()).toEqual(expect.arrayContaining(['Retry Wave', 'Random Spawns']));
    expect(actionLabels()).not.toContain('Lock Layout');
    fireEvent.click(within(pane() as HTMLElement).getByRole('button', { name: 'Random Spawns' }));
    expect(props.onExecuteEncounterCommand).toHaveBeenLastCalledWith({ encounter: 'inferno', type: 'reroll-wave' });
    // A pin the run has moved past no longer applies.
    const moved = { ...random, state: { ...random.state, wave: 7, pinnedWave: 6 } };
    rerender({ simulationState: { ...props.simulationState, encounter: moved } });
    expect(actionLabels()).toContain('Lock Layout');
    expect(actionLabels()).not.toContain('Random Spawns');
  });
  it('holds the fight while the editor is open, releasing it however it closes', () => {
    const held: boolean[] = [];
    const { rerender, props, view } = infernoChrome(52, { onEncounterToolOpenChange: (open) => held.push(open) });
    const open = () => fireEvent.click(launcher('Edit layout'));
    open();
    expect(held).toEqual([true]);
    fireEvent.click(screen.getByRole('button', { name: 'Close Edit layout' }));
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    open();
    open();
    open();
    fireEvent.click(launcher('Practice'));
    expect(held).toEqual([true, false, true, false, true, false, true, false]);
    // Replay disables the editor, which lets the fight go; it never holds a replay.
    open();
    rerender({ replay: { ...props.replay!, isReplaying: true } });
    expect(held.at(-1)).toBe(false);
    rerender({ replay: { ...props.replay!, isReplaying: false } });
    open();
    expect(held.at(-1)).toBe(true);
    view.unmount();
    expect(held.at(-1)).toBe(false);
    expect(held.filter(Boolean)).toHaveLength(held.length / 2);
  });
  it('starts the edited wave while still held, then releases the fight as the editor closes', () => {
    const log: string[] = [];
    infernoChrome(52, {
      onEncounterToolOpenChange: (open) => log.push(open ? 'held' : 'released'),
      onExecuteEncounterCommand: (command) => log.push(command.type),
    });
    fireEvent.click(launcher('Edit layout'));
    fireEvent.click(screen.getByRole('button', { name: 'Start wave 52' }));
    // The restart runs under the hold and the editor's close releases it, so the new run is never
    // left held, nor started while the editor still covers it.
    expect(log).toEqual(['held', 'go-to-wave', 'released']);
    expect(screen.queryByRole('dialog', { name: 'Edit layout' })).toBeNull();
  });
  it('opens from its own opaque launcher, leaves Practice clean, and restores the closed editor', () => {
    infernoChrome();
    expect(launcher('Edit layout').closest('.top-chrome__item')).not.toBeNull();
    fireEvent.click(launcher('Practice'));
    expect(within(pane()!).queryByRole('button', { name: /Arena|Copy.*link|Edit layout/ })).toBeNull();
    fireEvent.click(launcher('Edit layout'));
    expect(pane()).toBeNull();
    const tool = screen.getByRole('dialog', { name: 'Edit layout' });
    expect(tool).not.toHaveAttribute('aria-modal');
    expect(tool).toHaveClass('encounter-workbench');
    expect(within(tool).getByRole('spinbutton', { name: 'Start wave' })).toHaveValue(52);
    fireEvent.click(within(tool).getByRole('button', { name: 'Mager 0/1' }));
    fireEvent.click(within(tool).getByRole('button', { name: 'Close Edit layout' }));
    expect(screen.queryByRole('dialog', { name: 'Edit layout' })).toBeNull();
    fireEvent.click(launcher('Edit layout'));
    expect(screen.getByRole('button', { name: 'Mager 0/1' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Edit layout' })).toBeNull();
    fireEvent.click(launcher('Edit layout'));
    const keys = vi.fn();
    window.addEventListener('keydown', keys);
    try {
      fireEvent.keyDown(tool, { key: ' ' });
      expect(keys).toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', keys);
    }
    fireEvent.click(launcher('Practice'));
    expect(screen.queryByRole('dialog', { name: 'Edit layout' })).toBeNull();
  });
  it('keeps the launcher visible but disabled on the fixed wave 69 arena and during replay', () => {
    const { rerender, props } = infernoChrome(69);
    expect(launcher('Edit layout')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(launcher('Edit layout'));
    expect(screen.queryByRole('dialog', { name: 'Edit layout' })).toBeNull();
    rerender({ replay: { ...props.replay!, isReplaying: true } });
    expect(launcher('Edit layout')).toHaveAttribute('aria-disabled', 'true');
  });
  it('uses the same saved wave as Practice and closes after starting the edited wave', () => {
    const { rerender, props } = infernoChrome();
    fireEvent.click(launcher('Edit layout'));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Start wave' }), { target: { value: '62' } });
    expect(props.onMechanicsConfigChange).toHaveBeenCalledWith(expect.objectContaining({ infernoStartWave: '62' }));
    rerender({ mechanicsConfig: { ...props.mechanicsConfig, infernoStartWave: '62' } });
    expect(screen.getByRole('button', { name: 'Meleer 0/1' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Start wave 62' }));
    expect(props.onExecuteEncounterCommand).toHaveBeenCalledWith({
      encounter: 'inferno',
      type: 'go-to-wave',
      wave: 62,
    });
    expect(screen.queryByRole('dialog', { name: 'Edit layout' })).toBeNull();
    fireEvent.click(launcher('Practice'));
    expect(screen.getByRole('spinbutton', { name: 'Start wave' })).toHaveValue(62);
  });
});

describe('the Fortis Colosseum layout launcher', () => {
  function colosseumChrome(startWave: number, overrides: Partial<ComponentProps<typeof TopChrome>> = {}) {
    const engine = new SimulationEngine({
      encounter: new SolHereditEncounter(7),
      mechanics: { colosseumStartWave: String(startWave) },
    });
    return renderChrome({
      engine,
      simulationState: engine.getState(),
      mechanicsConfig: engine.getMechanicsConfig(),
      ...overrides,
    });
  }

  it('is left out of a direct Sol start, which has no wave layout', () => {
    colosseumChrome(12);
    expect(within(row() as HTMLElement).queryByRole('button', { name: 'Edit layout' })).toBeNull();
  });

  it('opens the start wave map in the corner workbench, with its warning, and starts the edited wave', () => {
    const log: string[] = [];
    const { props } = colosseumChrome(2, {
      onEncounterToolOpenChange: (open) => log.push(open ? 'held' : 'released'),
      onExecuteEncounterCommand: (command) => log.push(command.type),
    });
    expect(launcher('Edit layout').closest('.top-chrome__item')).not.toBeNull();
    fireEvent.click(launcher('Edit layout'));
    const tool = screen.getByRole('dialog', { name: 'Edit layout' });
    expect(tool).toHaveClass('encounter-workbench');
    expect(within(tool).getByRole('spinbutton', { name: 'Start wave' })).toHaveValue(2);
    expect(within(tool).getByTestId('arena-map')).toBeTruthy();
    // West, inner is 4 from the default start: the game never spawns there.
    fireEvent.click(within(tool).getByRole('button', { name: /^Javelin/ }));
    fireEvent.click(within(tool).getByRole('button', { name: /^West, inner:/ }));
    expect(props.onMechanicsConfigChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ colosseumSpawnLayout: '2:----------j-' }),
    );
    expect(within(tool).getByText('Not possible in the game')).toBeTruthy();
    fireEvent.click(within(tool).getByRole('button', { name: 'Start wave 2' }));
    expect(log).toEqual(['held', 'go-to-wave', 'released']);
    expect(screen.queryByRole('dialog', { name: 'Edit layout' })).toBeNull();
  });

  it('keeps the launcher visible but disabled once a wave run reaches Sol', () => {
    const { props, rerender } = colosseumChrome(4);
    const encounter = props.simulationState.encounter;
    if (encounter.kind !== 'sol_heredit' || !encounter.state.run) throw new Error('Expected a wave run');
    const atSol = {
      ...encounter,
      state: { ...encounter.state, run: { ...encounter.state.run, wave: 12, stage: 'sol' as const } },
    };
    rerender({ simulationState: { ...props.simulationState, encounter: atSol } });
    expect(launcher('Edit layout')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(launcher('Edit layout'));
    expect(screen.queryByRole('dialog', { name: 'Edit layout' })).toBeNull();
  });
});

describe('the active practice session', () => {
  it('keeps session context and restart in the top tool area and in an opened pane, never both', () => {
    const controls = makeReplayPractice({ startTick: 124 });
    const { rerender } = renderChrome({ replayPractice: controls });
    const session = screen.getByRole('group', { name: 'Practice session' });
    expect(session).toHaveClass('top-chrome__item', 'practice-session', 'practice-retry-bar--compact');
    expect(Number.parseFloat(session.style.top)).toBeLessThan(100);
    expect(within(session).getByRole('button', { name: 'Restart from tick 124' })).toHaveTextContent('Restart: 124');
    fireEvent.click(within(session).getByRole('button', { name: 'Restart from tick 124' }));
    expect(controls.onRetry).toHaveBeenCalledOnce();
    fireEvent.click(launcher('Practice'));
    expect(screen.getAllByRole('group', { name: 'Practice session' })).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Practice session' }).closest('.launcher-pane')).not.toBeNull();
    rerender({
      replayPractice: controls,
      replay: { hasRecording: true, isReplaying: true, onEnter: vi.fn(), onExit: vi.fn(), notice: null },
    });
    expect(screen.queryByRole('group', { name: 'Practice session' })).toBeNull();
  });

  it('places persistent session controls below boss HP on a narrow window', () => {
    vi.stubGlobal('innerWidth', 480);
    vi.stubGlobal('innerHeight', 800);
    frame.getBoundingClientRect = () => rect(0, 0, 480, 800);
    const boss = document.createElement('div');
    boss.setAttribute('data-tutorial', 'boss-health-bar-panel');
    boss.getBoundingClientRect = () => rect(24, 36, 208, 42);
    frame.append(boss);
    renderChrome({ fixed: false, layoutKey: 'narrow', replayPractice: makeReplayPractice({ startTick: 4 }) });
    const session = screen.getByRole('group', { name: 'Practice session' });
    expect(Number.parseFloat(session.style.top)).toBeGreaterThanOrEqual(82);
  });

  it.each(['Menu', 'Practice', 'Actions'])('keeps a session combined with %s below boss HP', (name) => {
    const boss = document.createElement('div');
    boss.setAttribute('data-tutorial', 'boss-health-bar-panel');
    boss.getBoundingClientRect = () => rect(4, 36, 208, 42);
    frame.append(boss);
    renderChrome({ fixed: false, replayPractice: makeReplayPractice({ startTick: 124 }) });
    expect(screen.getByRole('group', { name: 'Practice session' })).toHaveClass('practice-retry-bar--labelled');
    fireEvent.click(launcher(name));
    const openPane = pane() as HTMLElement;
    expect(openPane.style.width).toBe('240px');
    expect(Number.parseFloat(openPane.style.top)).toBeGreaterThanOrEqual(82);
    expect(screen.getAllByRole('group', { name: 'Practice session' })).toHaveLength(1);
    expect(screen.getByRole('group', { name: 'Practice session' }).closest('.launcher-pane')).toBe(openPane);
    expect(screen.getByRole('group', { name: 'Practice session' })).toHaveClass('practice-retry-bar--labelled');
  });

  it('drops the context line beside an icon row, still naming every session action', () => {
    vi.stubGlobal('innerWidth', 480);
    vi.stubGlobal('innerHeight', 800);
    frame.getBoundingClientRect = () => rect(0, 0, 480, 800);
    (frame.querySelector('.chatbox') as HTMLElement).getBoundingClientRect = () => rect(0, 647, 480, 153);
    renderChrome({ fixed: false, replayPractice: makeReplayPractice({ startTick: 124 }) });
    expect(launcher('Menu')).toHaveClass('launcher-btn--icon');
    const session = screen.getByRole('group', { name: 'Practice session' });
    expect(session.style.width).toBe('240px');
    expect(session).toHaveClass('practice-retry-bar--compact');
    // The row's icon form never spreads to the session's own controls: a launcher glyph in here
    // would name Replay or "close this surface", not these actions.
    expect(within(session).getByRole('button', { name: 'Change' })).toHaveTextContent('Change');
    expect(within(session).getByRole('button', { name: 'Clear restart point' })).toHaveTextContent('Clear');
    expect(session.querySelector('svg[data-glyph]')).toBeNull();
    fireEvent.click(launcher('Menu'));
    expect(pane()?.style.width).toBe('240px');
    expect(screen.getByRole('group', { name: 'Practice session' })).toHaveClass('practice-retry-bar--compact');
    expect(pane()?.querySelector('.practice-retry-bar__context')).toBeNull();
  });

  it('gives Menu the session width only while a practice point is active', () => {
    const { rerender } = renderChrome({ fixed: false, replayPractice: makeReplayPractice({ startTick: 124 }) });
    fireEvent.click(launcher('Menu'));
    expect(pane()?.style.width).toBe('240px');
    rerender({ replayPractice: makeReplayPractice() });
    expect(pane()?.style.width).toBe('192px');
  });
});

describe('the launcher row', () => {
  const lefts = () => Array.from(row()?.children ?? []).map((item) => (item as HTMLElement).style.left);

  /** A boss bar panel in the frame, wherever it is. */
  function bossBar(x: number, y: number, width = 239, height = 42) {
    const panel = document.createElement('div');
    panel.setAttribute('data-tutorial', 'boss-health-bar-panel');
    panel.getBoundingClientRect = () => rect(x, y, width, height);
    frame.append(panel);
    return panel;
  }
  const forms = () =>
    Array.from(row()?.querySelectorAll('button') ?? []).map((b) =>
      b.classList.contains('launcher-btn--icon') ? 'icon' : 'text',
    );

  it('is labeled where the row takes at most half the scene beside it, in Menu · Practice · Actions · Replay order', () => {
    // A resizable 765 frame: the whole window is the scene, 757 of room for a 292 row.
    renderChrome({ fixed: false, layoutKey: 'modern' });
    // Each launcher is its own item, one gap after the last.
    expect(lefts()).toEqual(['4px', '78px', '152px', '226px']);
    expect((row()?.firstElementChild as HTMLElement).style.top).toBe('4px');
    expect(
      Array.from(row()?.querySelectorAll('button') ?? []).map((b) => b.getAttribute('aria-label') ?? b.textContent),
    ).toEqual(['Menu', 'Practice', 'Actions', 'Replay']);
    expect(forms()).toEqual(['text', 'text', 'text', 'text']);
    // No launcher uses the browser's title tooltip.
    for (const button of row()?.querySelectorAll('button') ?? []) expect(button.hasAttribute('title')).toBe(false);
  });

  it('turns every launcher, Menu too, to its icon together where the labeled row would take more than half (Fixed 1x)', () => {
    // 504 of room from 8 to the scene's right inset: 292 labeled is over half. No form between.
    renderChrome();
    expect(forms()).toEqual(['icon', 'icon', 'icon', 'icon']);
    expect(lefts()).toEqual(['8px', '40px', '72px', '104px']);
    expect(launcher('Menu').querySelector('svg')?.dataset.glyph).toBe('menu');
    expect(launcher('Menu')).toHaveAttribute('data-tutorial', 'menu-launcher');
    expect(launcher('Replay').querySelector('svg')?.dataset.glyph).toBe('replay');
  });

  it('counts Replay before there is a recording, so its arrival changes nothing else', () => {
    // Fixed 1x without Replay would be 218 labeled, inside half of 504: decided with Replay's 70.
    const noRecording = { hasRecording: false, isReplaying: false, onEnter: vi.fn(), onExit: vi.fn(), notice: null };
    const { rerender } = renderChrome({ replay: noRecording });
    expect(forms()).toEqual(['icon', 'icon', 'icon']);
    expect(lefts()).toEqual(['8px', '40px', '72px']);
    // The recording arrives a tick into the fight: Replay joins the end in the same form.
    rerender({ replay: { ...noRecording, hasRecording: true } });
    expect(forms()).toEqual(['icon', 'icon', 'icon', 'icon']);
    expect(lefts()).toEqual(['8px', '40px', '72px', '104px']);
    // An encounter that cannot record has no Replay to count.
    rerender({ replay: null });
    expect(forms()).toEqual(['text', 'text', 'text']);
  });

  it('decides without Replay in a combat tutorial, which never shows it', () => {
    // The tutorial keeps the replay controls but never a recording: 218 labeled fits half of 504.
    const hidden = { hasRecording: false, isReplaying: false, onEnter: vi.fn(), onExit: vi.fn(), notice: null };
    renderChrome({ replay: hidden, replaySuppressed: true });
    expect(forms()).toEqual(['text', 'text', 'text']);
    expect(lefts()).toEqual(['8px', '82px', '156px']);
  });

  it('turns every launcher to its icon where the Settings drawer leaves less room', () => {
    renderChrome({ settings: { open: true, inset: 320 } });
    expect(forms()).toEqual(['icon', 'icon', 'icon', 'icon']);
    expect(lefts()).toEqual(['324px', '356px', '388px', '420px']);
  });

  it('takes its form from the viewport alone: no boss bar, wherever it is, changes it', () => {
    const { rerender } = renderChrome({ fixed: false, layoutKey: 'modern' });
    const panel = bossBar(150, 4);
    rerender({});
    expect(forms()).toEqual(['text', 'text', 'text', 'text']);
    panel.getBoundingClientRect = () => rect(300, 4, 400, 42);
    rerender({});
    expect(forms()).toEqual(['text', 'text', 'text', 'text']);
  });

  it('draws its icons monochrome in the label color, so hover, open, disabled and packs recolor them', () => {
    const { rerender } = renderChrome({ settings: { open: true, inset: 320 } });
    for (const name of ['Menu', 'Practice', 'Actions', 'Replay']) {
      const ink = launcher(name).querySelector('svg > g:last-child');
      expect(ink?.getAttribute('fill'), name).toBe('currentColor');
    }
    rerender({
      settings: { open: true, inset: 320 },
      replay: { hasRecording: true, isReplaying: true, onEnter: vi.fn(), onExit: vi.fn(), notice: null },
    });
    expect(launcher('Actions')).toHaveAttribute('aria-disabled', 'true');
    expect(launcher('Exit Replay').querySelector('svg')?.dataset.glyph).toBe('replay');
  });

  it('names an icon launcher in the hover card on hover, and closes the card on a press', async () => {
    renderChrome();
    fireEvent.pointerEnter(launcher('Replay'), { pointerType: 'mouse' });
    const card = await waitFor(() => screen.getByRole('tooltip'));
    expect(card.textContent).toBe('Replay');
    fireEvent.pointerDown(launcher('Replay'), { pointerType: 'mouse' });
    fireEvent.click(launcher('Replay'));
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    // Menu's icon says "Menu" the same way.
    fireEvent.pointerEnter(launcher('Menu'), { pointerType: 'mouse' });
    expect((await waitFor(() => screen.getByRole('tooltip'))).textContent).toBe('Menu');
  });

  it('shows no card for a labeled launcher with nothing more to say, and none for touch', async () => {
    // Modern: labeled.
    renderChrome({ fixed: false, layoutKey: 'modern' });
    fireEvent.pointerEnter(launcher('Practice'), { pointerType: 'mouse' });
    fireEvent.pointerEnter(launcher('Menu'), { pointerType: 'mouse' });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(screen.queryByRole('tooltip')).toBeNull();
    // Fixed 1x: icons, and still no card for touch.
    cleanup();
    renderChrome();
    fireEvent.pointerEnter(launcher('Replay'), { pointerType: 'touch' });
    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('opens the menu once by itself on a first lobby visit, and reports it', () => {
    const onOpenedOnce = vi.fn();
    const { rerender } = renderChrome({
      menu: { items: <button type="button">Training</button>, pinned: false, openOnce: true, onOpenedOnce },
    });
    expect(pane()?.dataset.pane).toBe('menu');
    expect(onOpenedOnce).toHaveBeenCalledOnce();
    // Dismissed like any menu, and not reopened.
    fireEvent.pointerDown(document.body);
    expect(pane()).toBeNull();
    rerender({ menu: { items: <button type="button">Training</button>, pinned: false, openOnce: false } });
    expect(pane()).toBeNull();
  });

  it('moves right past the open Settings drawer and stays usable, its pane with it', () => {
    const { rerender } = renderChrome({ settings: { open: true, inset: 320 } });
    expect(lefts()[0]).toBe('324px');
    for (const item of row()?.children ?? []) expect(item).not.toHaveAttribute('data-tucked', 'true');
    // Practice opens under the moved row, past the play area's edge, as wide as the scene leaves.
    fireEvent.click(launcher('Practice'));
    expect(pane()?.dataset.column).toBe('launcher');
    expect(pane()?.style.left).toBe('324px');
    expect(pane()?.style.width).toBe(`${516 - 4 - 324}px`);
    // Closing the drawer brings the row (and the open pane, placed again) back to the corner.
    rerender({ settings: { open: false, inset: 320 } });
    expect(lefts()[0]).toBe('8px');
    expect(pane()?.style.left).toBe('8px');
  });

  it('stops a pane under the pushed row one gap short of the Modern minimap', () => {
    const minimap = document.createElement('div');
    minimap.setAttribute('data-tutorial', 'minimap');
    minimap.getBoundingClientRect = () => rect(521, 0, 244, 166);
    frame.append(minimap);
    renderChrome({ fixed: false, layoutKey: 'modern', settings: { open: true, inset: 320 } });
    fireEvent.click(launcher('Practice'));
    expect(pane()?.dataset.column).toBe('launcher');
    expect(pane()?.style.left).toBe('324px');
    expect(pane()?.style.width).toBe(`${521 - 4 - 324}px`);
  });

  it('hides under a drawer that covers the whole window', () => {
    renderChrome({ settings: { open: true, inset: 0 } });
    for (const item of row()?.children ?? []) expect(item).toHaveAttribute('data-tucked', 'true');
  });

  // A tour pins the menu and raises the chrome above the drawers, so a full-window Plugins drawer
  // has to hide the row and the menu itself: they covered the plugin rows the tour pointed at.
  it('hides the row and a pinned menu under a full-window Plugins drawer, not a side one', () => {
    const { rerender } = renderChrome({
      elevated: true,
      menu: { items: <button type="button">Training</button>, pinned: true },
      plugins: { open: true, inset: 0, onToggle: vi.fn() },
    });
    for (const item of row()?.children ?? []) expect(item).toHaveAttribute('data-tucked', 'true');
    expect(pane()).toHaveAttribute('data-tucked', 'true');

    rerender({
      elevated: true,
      menu: { items: <button type="button">Training</button>, pinned: true },
      plugins: { open: true, inset: 320, onToggle: vi.fn() },
    });
    for (const item of row()?.children ?? []) expect(item).not.toHaveAttribute('data-tucked', 'true');
    expect(pane()).not.toHaveAttribute('data-tucked', 'true');
  });

  it('leaves Actions out without commands, and Replay out without a recording', () => {
    renderChrome({
      debugActions: [],
      replay: { hasRecording: false, isReplaying: false, onEnter: vi.fn(), onExit: vi.fn(), notice: null },
    });
    expect(within(row() as HTMLElement).queryByRole('button', { name: 'Actions' })).toBeNull();
    expect(within(row() as HTMLElement).queryByRole('button', { name: 'Replay' })).toBeNull();
  });

  it('keeps focus off its buttons: a press never leaves a control taking game keys', () => {
    renderChrome();
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    launcher('Practice').dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);
    for (const button of document.querySelectorAll('.top-chrome button')) {
      expect(button.getAttribute('tabindex')).not.toBe('0');
    }
  });

  it('enters replay from the Replay launcher, leaving the tutorial to hear of it once playback runs', () => {
    const onEnter = vi.fn();
    const entered = vi.fn();
    window.addEventListener(TUTORIAL_REPLAY_ENTERED_EVENT, entered);
    try {
      renderChrome({ replay: { hasRecording: true, isReplaying: false, onEnter, onExit: vi.fn(), notice: null } });
      fireEvent.click(launcher('Replay'));
      expect(onEnter).toHaveBeenCalledOnce();
      // Grid sends it when the transport is on screen; a request alone is not replay mode yet.
      expect(entered).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(TUTORIAL_REPLAY_ENTERED_EVENT, entered);
    }
  });

  describe('Modifiers', () => {
    it('shows only for an encounter with modifiers, after Actions and before Replay', () => {
      const { rerender } = renderChrome({ fixed: false, layoutKey: 'modern' });
      expect(within(row() as HTMLElement).queryByRole('button', { name: 'Modifiers' })).toBeNull();
      rerender({ fixed: false, layoutKey: 'modern', modifiers: { open: false, onOpen: vi.fn() } });
      expect(Array.from(row()?.querySelectorAll('button') ?? []).map((b) => b.textContent)).toEqual([
        'Menu',
        'Practice',
        'Actions',
        'Modifiers',
        'Replay',
      ]);
      expect(lefts()).toEqual(['4px', '78px', '152px', '226px', '300px']);
      expect(forms()).toEqual(['text', 'text', 'text', 'text', 'text']);
    });

    it('turns to its sliders icon with the rest, named in the hover card', async () => {
      renderChrome({ modifiers: { open: false, onOpen: vi.fn() } });
      expect(forms()).toEqual(['icon', 'icon', 'icon', 'icon', 'icon']);
      expect(launcher('Modifiers').querySelector('svg')?.dataset.glyph).toBe('modifiers');
      fireEvent.pointerEnter(launcher('Modifiers'), { pointerType: 'mouse' });
      expect((await waitFor(() => screen.getByRole('tooltip'))).textContent).toBe('Modifiers');
    });

    it('asks App to open the picker on a press, opening no pane of its own, and shows it open', () => {
      const onOpen = vi.fn();
      const { rerender } = renderChrome({ fixed: false, layoutKey: 'modern', modifiers: { open: false, onOpen } });
      fireEvent.click(launcher('Modifiers'));
      expect(onOpen).toHaveBeenCalledOnce();
      expect(pane()).toBeNull();
      expect(launcher('Modifiers')).toHaveAttribute('aria-expanded', 'false');
      rerender({ fixed: false, layoutKey: 'modern', modifiers: { open: true, onOpen } });
      expect(launcher('Modifiers')).toHaveAttribute('aria-expanded', 'true');
      expect(launcher('Modifiers')).toHaveClass('is-open');
    });

    it('is off during a replay, which a new fight would end, and says why', async () => {
      const onOpen = vi.fn();
      renderChrome({
        fixed: false,
        layoutKey: 'modern',
        modifiers: { open: false, onOpen },
        replay: { hasRecording: true, isReplaying: true, onEnter: vi.fn(), onExit: vi.fn(), notice: null },
      });
      expect(launcher('Modifiers')).toHaveAttribute('aria-disabled', 'true');
      fireEvent.click(launcher('Modifiers'));
      expect(onOpen).not.toHaveBeenCalled();
      fireEvent.pointerEnter(launcher('Modifiers'), { pointerType: 'mouse' });
      expect((await waitFor(() => screen.getByRole('tooltip'))).textContent).toBe(
        'Modifiers are off while you watch a replay.',
      );
    });
  });
});

describe('the panes', () => {
  it('opens Practice 4px under the row, 152 wide in Fixed 1x, and tells the tutorial', () => {
    const opened = vi.fn();
    window.addEventListener(TUTORIAL_HUD_OPENED_EVENT, opened);
    try {
      renderChrome();
      fireEvent.click(launcher('Practice'));
      expect(pane()?.dataset.pane).toBe('practice');
      expect(pane()?.style.left).toBe('8px');
      expect(pane()?.style.top).toBe('40px');
      expect(pane()?.style.width).toBe('152px');
      // Down to one gap above the chat: 338 - 4 - 40.
      expect(pane()?.style.maxHeight).toBe('294px');
      expect(launcher('Practice')).toHaveAttribute('aria-expanded', 'true');
      expect(opened).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener(TUTORIAL_HUD_OPENED_EVENT, opened);
    }
  });

  it('opens one pane at a time', () => {
    renderChrome();
    fireEvent.click(launcher('Practice'));
    fireEvent.click(launcher('Actions'));
    expect(pane()?.dataset.pane).toBe('actions');
    expect(document.querySelectorAll('.launcher-pane')).toHaveLength(1);
    expect(launcher('Practice')).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps Practice and Actions open through scene clicks, closing on Escape, × or the launcher', () => {
    renderChrome();
    fireEvent.click(launcher('Practice'));
    fireEvent.pointerDown(document.body);
    fireEvent.mouseDown(document.body);
    expect(pane()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(pane()).toBeNull();

    fireEvent.click(launcher('Practice'));
    fireEvent.click(screen.getByRole('button', { name: 'Close Practice' }));
    expect(pane()).toBeNull();

    fireEvent.click(launcher('Actions'));
    fireEvent.click(launcher('Actions'));
    expect(pane()).toBeNull();
  });

  it('runs an action per press and stays open for the next', () => {
    const { props } = renderChrome();
    fireEvent.click(launcher('Actions'));
    const list = within(pane() as HTMLElement);
    fireEvent.click(list.getByRole('button', { name: 'Trigger grapple' }));
    fireEvent.click(list.getByRole('button', { name: 'Add beam crystal' }));
    expect(props.onExecuteEncounterCommand).toHaveBeenNthCalledWith(1, ACTIONS[0].command);
    expect(props.onExecuteEncounterCommand).toHaveBeenNthCalledWith(2, ACTIONS[1].command);
    expect(pane()?.dataset.pane).toBe('actions');
  });

  it('puts Settings first in the menu, ruled off from the places to go', () => {
    renderChrome();
    fireEvent.click(launcher('Menu'));
    expect(pane()?.querySelector('.launcher-menu__rule--settings')).not.toBeNull();
    expect(pane()?.querySelector('[data-menu-item="settings"]')).not.toBeNull();
  });

  it('closes the menu on a click outside it or on choosing an item', () => {
    const onSettings = vi.fn();
    renderChrome({
      menu: {
        items: (
          <button type="button" onClick={onSettings}>
            Settings
          </button>
        ),
        pinned: false,
      },
    });
    fireEvent.click(launcher('Menu'));
    expect(pane()?.dataset.pane).toBe('menu');
    fireEvent.pointerDown(document.body);
    expect(pane()).toBeNull();

    fireEvent.click(launcher('Menu'));
    fireEvent.click(within(pane() as HTMLElement).getByRole('button', { name: 'Settings' }));
    expect(onSettings).toHaveBeenCalledOnce();
    expect(pane()).toBeNull();
  });

  it('keeps a pinned menu up while no other pane is open (a tutorial points into it)', () => {
    renderChrome({ menu: { items: <button type="button">Training</button>, pinned: true } });
    expect(pane()?.dataset.pane).toBe('menu');
    fireEvent.click(launcher('Practice'));
    expect(pane()?.dataset.pane).toBe('practice');
    fireEvent.click(launcher('Practice'));
    expect(pane()?.dataset.pane).toBe('menu');
  });

  it('holds its place while open, and no overlay ever decides it', () => {
    const { rerender } = renderChrome();
    fireEvent.click(launcher('Practice'));
    const before = pane()?.getAttribute('style');
    expect(pane()?.style.top).toBe('40px');
    // A boss bar arriving under the pane mid-fight does not move it; it is drawn over.
    const bar = document.createElement('div');
    bar.setAttribute('data-tutorial', 'boss-health-bar-panel');
    bar.getBoundingClientRect = () => rect(8, 40, 239, 42);
    frame.append(bar);
    // Nor do rows of infoboxes under it.
    const strip = document.createElement('div');
    strip.setAttribute('data-tutorial', 'infobox-panel');
    strip.getBoundingClientRect = () => rect(8, 133, 150, 201);
    frame.append(strip);
    rerender({});
    expect(pane()?.getAttribute('style')).toBe(before);
    // Nor does Replay coming or going, which changes the row's width.
    rerender({ replay: null });
    expect(within(row() as HTMLElement).queryByRole('button', { name: 'Replay' })).toBeNull();
    expect(pane()?.getAttribute('style')).toBe(before);
    // Reopened, it is placed afresh: in the same place, over the bar and the infoboxes.
    fireEvent.click(launcher('Practice'));
    fireEvent.click(launcher('Practice'));
    expect(pane()?.style.top).toBe('40px');
    expect(pane()?.dataset.column).toBe('launcher');
  });

  describe('moves with the fixed chrome it keeps clear of', () => {
    function minimapAt(x: number) {
      const minimap = document.createElement('div');
      minimap.setAttribute('data-tutorial', 'minimap');
      minimap.getBoundingClientRect = () => rect(x, 0, 244, 166);
      frame.append(minimap);
      return minimap;
    }
    const pushed = { fixed: false, layoutKey: 'modern', settings: { open: true, inset: 320 } } as const;

    /**
     * The chrome as real panels in the frame, laid out by the panel layout store the chrome
     * shares with them (App's PanelSnapRegistryProvider), each where its transform puts it.
     */
    function renderWithPanels(panels: readonly { id: string; x: number }[]) {
      vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
        if (this.classList.contains('launcher-btn--icon')) return rect(0, 0, 28, 28);
        if (this.classList.contains('launcher-btn')) return rect(0, 0, 70, 28);
        const at = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(this.style.transform);
        if (this.dataset.tutorial && at) {
          return rect(
            Number(at[1]),
            Number(at[2]),
            Number.parseFloat(this.style.width),
            Number.parseFloat(this.style.height),
          );
        }
        return rect(0, 0, 0, 0);
      });
      const engine = solEngine();
      const chrome = (
        <TopChrome
          frameRef={{ current: frame }}
          {...pushed}
          zoom={1}
          menu={{ items: null, pinned: false }}
          plugins={null}
          showFps={false}
          engine={engine}
          simulationState={engine.getState()}
          mechanicsConfig={engine.getMechanicsConfig()}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={encounterControlsForKind('sol_heredit')?.mechanicsToggles ?? []}
          debugActions={ACTIONS}
          onExecuteEncounterCommand={vi.fn()}
          onSetBossHp={vi.fn()}
          replay={null}
        />
      );
      const tree = (list: readonly { id: string; x: number }[]) => (
        <PanelSnapRegistryProvider>
          {createPortal(
            list.map(({ id, x }) => (
              <DraggablePanel
                key={id}
                dataTutorial={id}
                defaultPosition={{ x, y: 0, anchorX: 'left', anchorY: 'top' }}
                position={{ x, y: 0, anchorX: 'left', anchorY: 'top' }}
                width={id === 'minimap' ? 244 : 204}
                height={id === 'minimap' ? 166 : 275}
                viewportWidth={1000}
                viewportHeight={503}
              >
                {id}
              </DraggablePanel>
            )),
            frame,
          )}
          {chrome}
        </PanelSnapRegistryProvider>
      );
      const view = render(tree(panels));
      // The panels are solved after their commit, and the chrome measures them once it is done.
      const settle = (list: readonly { id: string; x: number }[]) =>
        act(async () => {
          view.rerender(tree(list));
        });
      return { settle };
    }

    it('when it moves on its own (a dragged panel), with nothing else changing', async () => {
      const { settle } = renderWithPanels([{ id: 'minimap', x: 521 }]);
      await settle([{ id: 'minimap', x: 521 }]);
      fireEvent.click(launcher('Practice'));
      expect(pane()?.style.width).toBe(`${521 - 4 - 324}px`);
      // The chrome's own inputs are the same: the panel's solve is what tells it.
      await settle([{ id: 'minimap', x: 561 }]);
      expect(pane()?.style.width).toBe(`${561 - 4 - 324}px`);
    });

    it('against where it is now, when the layout key changes with it', () => {
      // Grid's key changes in the same render the minimap moves, before TopChrome has measured the
      // new place: the pane must not stay solved against the old one.
      const minimap = minimapAt(521);
      const { rerender } = renderChrome(pushed);
      fireEvent.click(launcher('Practice'));
      minimap.getBoundingClientRect = () => rect(561, 0, 244, 166);
      rerender({ ...pushed, layoutKey: 'modern|moved' });
      expect(pane()?.style.width).toBe(`${561 - 4 - 324}px`);
    });

    it('and when chrome it keeps clear of appears beside it (the game panel dragged up)', async () => {
      const { settle } = renderWithPanels([]);
      await settle([]);
      fireEvent.click(launcher('Practice'));
      expect(pane()?.style.width).toBe('240px');
      await settle([{ id: 'game-panel', x: 540 }]);
      expect(pane()?.style.width).toBe(`${540 - 4 - 324}px`);
      // And again when it goes.
      await settle([]);
      expect(pane()?.style.width).toBe('240px');
    });
  });

  it('titles a pane opened from a labeled launcher by the launcher alone: no title row, the head keeps its close', () => {
    renderChrome({ fixed: false, layoutKey: 'modern' });
    fireEvent.click(launcher('Practice'));
    expect(pane()?.querySelector('.launcher-pane__title')).toBeNull();
    expect(within(pane() as HTMLElement).getAllByRole('button', { name: 'Close Practice' })).toHaveLength(1);
  });

  it('titles a pane opened from an icon launcher, with one close, Setup and Stats beneath', () => {
    renderChrome({ settings: { open: true, inset: 320 } });
    for (const name of ['Menu', 'Practice', 'Actions']) {
      fireEvent.click(launcher(name));
      const title = pane()?.querySelector('.launcher-pane__title');
      expect(title?.textContent, name).toBe(name);
      expect(within(pane() as HTMLElement).getAllByRole('button', { name: `Close ${name}` }), name).toHaveLength(1);
      expect(within(title as HTMLElement).getByRole('button', { name: `Close ${name}` })).toBeDefined();
    }
    fireEvent.click(launcher('Practice'));
    const tabs = pane()?.querySelector('.launcher-tabs');
    const title = pane()?.querySelector('.launcher-pane__title');
    // The title row comes first, the tabs beneath it.
    expect(title?.compareDocumentPosition(tabs as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('names the menu opened from its icon, with Settings still the first menu action', () => {
    renderChrome({ settings: { open: true, inset: 320 } });
    expect(launcher('Menu')).toHaveClass('launcher-btn--icon');
    fireEvent.click(launcher('Menu'));
    expect(pane()?.dataset.pane).toBe('menu');
    expect(pane()?.dataset.column).toBe('launcher');
    expect(pane()?.querySelector('.launcher-pane__title')?.textContent).toBe('Menu');
    expect(within(pane() as HTMLElement).getByRole('button', { name: 'Close Menu' })).toBeDefined();
    expect(launcher('Menu')).toHaveAttribute('aria-expanded', 'true');
  });

  it.each([true, false])('uses the same title policy for every combined pane, icon form=%s', (fixed) => {
    renderChrome({ fixed, replayPractice: makeReplayPractice({ startTick: 124 }) });
    for (const name of ['Menu', 'Practice', 'Actions']) {
      fireEvent.click(launcher(name));
      const openPane = pane() as HTMLElement;
      const session = openPane.querySelector('.practice-retry-bar');
      const title = openPane.querySelector('.launcher-pane__title');
      expect(openPane.firstElementChild).toBe(session);
      if (fixed) {
        expect(title?.textContent).toBe(name);
        expect(session?.nextElementSibling).toBe(title);
        expect(within(openPane).getAllByRole('button', { name: `Close ${name}` })).toHaveLength(1);
      } else {
        expect(title).toBeNull();
      }
    }
  });

  it('does not add a duplicate title to a labeled launcher shifted by Settings', () => {
    vi.stubGlobal('innerWidth', 1024);
    vi.stubGlobal('innerHeight', 768);
    frame.getBoundingClientRect = () => rect(0, 0, 1024, 768);
    renderChrome({
      fixed: false,
      settings: { open: true, inset: 320 },
      replayPractice: makeReplayPractice({ startTick: 10 }),
    });
    for (const name of ['Menu', 'Practice', 'Actions']) {
      expect(launcher(name)).not.toHaveClass('launcher-btn--icon');
      fireEvent.click(launcher(name));
      expect(pane()?.querySelector('.launcher-pane__title')).toBeNull();
    }
  });

  describe('the narrow-window tool window (Modern 480 portrait)', () => {
    beforeEach(() => {
      vi.stubGlobal('innerWidth', 480);
      vi.stubGlobal('innerHeight', 800);
      frame.getBoundingClientRect = () => rect(0, 0, 480, 800);
      (frame.querySelector('.chatbox') as HTMLElement).getBoundingClientRect = () => rect(0, 647, 480, 153);
      const minimap = document.createElement('div');
      minimap.setAttribute('data-tutorial', 'minimap');
      minimap.getBoundingClientRect = () => rect(236, 0, 244, 166);
      frame.append(minimap);
    });

    it('opens Practice and Actions at the row, titled, with one close, where no column fits', () => {
      renderChrome({ fixed: false, layoutKey: 'modern' });
      for (const name of ['Practice', 'Actions']) {
        fireEvent.click(launcher(name));
        expect(pane()?.dataset.column, name).toBe('window');
        expect(pane()?.style.left).toBe('4px');
        expect(pane()?.style.top).toBe('36px');
        expect(pane()?.style.maxHeight).toBe('400px');
        expect(pane()?.querySelector('.launcher-pane__title')?.textContent).toBe(name);
        expect(within(pane() as HTMLElement).getAllByRole('button', { name: `Close ${name}` })).toHaveLength(1);
      }
      fireEvent.click(launcher('Practice'));
      // 228: one gap short of the minimap's panel.
      expect(pane()?.style.width).toBe('228px');
    });

    it('scrolls in one body under a stationary title, and keeps the wheel from the game', () => {
      const onFrameWheel = vi.fn();
      frame.addEventListener('wheel', onFrameWheel);
      renderChrome({ fixed: false, layoutKey: 'modern' });
      fireEvent.click(launcher('Practice'));
      const window = pane() as HTMLElement;
      const bodies = window.querySelectorAll('.launcher-pane__body');
      expect(bodies).toHaveLength(1);
      // The title row and the tabs sit outside the scroller, so they stay put as it scrolls.
      const body = bodies[0] as HTMLElement;
      expect(body.contains(window.querySelector('.launcher-pane__title'))).toBe(false);
      expect(body.contains(window.querySelector('.launcher-tabs'))).toBe(false);
      // No second scroller inside it.
      expect(body.querySelector('.launcher-pane__body')).toBeNull();
      // The window is not inside the game frame, so a wheel over it never reaches the camera's
      // listener there (the body's overscroll-behavior keeps the scroll from chaining further).
      fireEvent.wheel(body, { deltaY: 120 });
      expect(onFrameWheel).not.toHaveBeenCalled();
      expect(frame.contains(window)).toBe(false);
    });
  });
});

// Grid re-renders the chrome on every simulation tick: it measures only when something it reads may
// have moved (useLayoutMeasure).
describe('measuring', () => {
  const lefts = () => Array.from(row()?.children ?? []).map((item) => (item as HTMLElement).style.left);

  /** ResizeObservers the test fires, as the browser does once a layout has resized what they watch. */
  function resizeObservers() {
    const observers: { callback: ResizeObserverCallback; targets: Set<Element> }[] = [];
    vi.stubGlobal(
      'ResizeObserver',
      class {
        private readonly entry: { callback: ResizeObserverCallback; targets: Set<Element> };
        constructor(callback: ResizeObserverCallback) {
          this.entry = { callback, targets: new Set() };
          observers.push(this.entry);
        }
        observe(target: Element) {
          this.entry.targets.add(target);
        }
        unobserve(target: Element) {
          this.entry.targets.delete(target);
        }
        disconnect() {
          this.entry.targets.clear();
        }
      },
    );
    return (target: Element) =>
      act(() => {
        for (const { callback, targets } of observers) if (targets.has(target)) callback([], {} as ResizeObserver);
      });
  }

  it('reads nothing, and draws no launcher again, on a render that only advances the fight', () => {
    const engine = solEngine();
    const state = engine.getState();
    // Fixed 1x: every launcher is an icon in the live row, as it is in its probe.
    const { rerender } = renderChrome({ engine, simulationState: state });
    expect(iconRenders.count).toBeGreaterThan(0);
    iconRenders.count = 0;
    const chat = frame.querySelector('.chatbox') as HTMLElement;
    const reads = [
      vi.mocked(HTMLElement.prototype.getBoundingClientRect),
      vi.spyOn(frame, 'getBoundingClientRect'),
      vi.spyOn(chat, 'getBoundingClientRect'),
    ];
    for (const read of reads) read.mockClear();
    for (let tick = 1; tick <= 3; tick++)
      rerender({ engine, simulationState: { ...state, currentTick: state.currentTick + tick } });
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(iconRenders.count).toBe(0);
    expect(lefts()).toEqual(['8px', '40px', '72px', '104px']);
    // What a launcher shows still reaches it.
    rerender({
      engine,
      simulationState: state,
      replay: { hasRecording: true, isReplaying: true, onEnter: vi.fn(), onExit: vi.fn(), notice: null },
    });
    expect(iconRenders.count).toBeGreaterThan(0);
    expect(launcher('Exit Replay')).toHaveAttribute('aria-pressed', 'true');
  });

  it('follows the window resizing', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('top-chrome__corner') ? CORNER_WIDTH : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('top-chrome__corner') ? 28 : 0;
    });
    renderChrome({ plugins: { open: false, inset: 0, onToggle: vi.fn() } });
    const plugins = () => screen.getByRole('button', { name: 'Plugins' }).parentElement;
    expect(plugins()?.style.left).toBe(`${765 - 4 - CORNER_WIDTH}px`);
    vi.stubGlobal('innerWidth', 1000);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(plugins()?.style.left).toBe(`${1000 - 4 - CORNER_WIDTH}px`);
  });

  it('follows the frame wherever the app places it, with nothing in it resizing', async () => {
    renderChrome();
    const first = () => row()?.firstElementChild as HTMLElement;
    expect([first().style.left, first().style.top]).toEqual(['8px', '8px']);
    // The app centers (or fits) the frame through its own style: one gap inside its border, still.
    frame.getBoundingClientRect = () => rect(2, 3, 765, 503);
    await act(async () => {
      frame.style.left = '2px';
    });
    expect([first().style.left, first().style.top]).toEqual(['10px', '11px']);
  });

  it('places an open pane again when the chat resizes, with nothing else changing', () => {
    const resize = resizeObservers();
    renderChrome();
    fireEvent.click(launcher('Practice'));
    expect(pane()?.style.maxHeight).toBe(`${338 - 4 - 40}px`);
    const chat = frame.querySelector('.chatbox') as HTMLElement;
    chat.getBoundingClientRect = () => rect(0, 300, 519, 203);
    resize(chat);
    expect(pane()?.style.maxHeight).toBe(`${300 - 4 - 40}px`);
  });

  it("lays the row out again when a launcher's label changes width (its font loading)", () => {
    const resize = resizeObservers();
    renderChrome({ fixed: false, layoutKey: 'modern' });
    expect(lefts()).toEqual(['4px', '78px', '152px', '226px']);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('launcher-btn--icon')) return rect(0, 0, 28, 28);
      if (this.classList.contains('launcher-btn')) return rect(0, 0, 80, 28);
      return rect(0, 0, 0, 0);
    });
    const labelled = document.querySelector('.launcher-row--probe') as HTMLElement;
    resize(labelled.firstElementChild as Element);
    expect(lefts()).toEqual(['4px', '88px', '172px', '256px']);
  });

  it('keeps an open pane titled as it was placed when the row changes form under it', () => {
    const resize = resizeObservers();
    renderChrome({ fixed: false, layoutKey: 'modern' });
    fireEvent.click(launcher('Practice'));
    expect(pane()?.querySelector('.launcher-pane__title')).toBeNull();
    // The labels widen (a font loading): 412 labeled is over half of 757, so the row turns to icons.
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('launcher-btn--icon')) return rect(0, 0, 28, 28);
      if (this.classList.contains('launcher-btn')) return rect(0, 0, 100, 28);
      return rect(0, 0, 0, 0);
    });
    resize((document.querySelector('.launcher-row--probe') as HTMLElement).firstElementChild as Element);
    expect(launcher('Practice')).toHaveClass('launcher-btn--icon');
    // The open pane neither gains a title row nor loses its head's close.
    expect(pane()?.querySelector('.launcher-pane__title')).toBeNull();
    expect(within(pane() as HTMLElement).getAllByRole('button', { name: 'Close Practice' })).toHaveLength(1);
    // Opened again, it is placed from the icon, and titled.
    fireEvent.click(launcher('Practice'));
    fireEvent.click(launcher('Practice'));
    expect(pane()?.querySelector('.launcher-pane__title')?.textContent).toBe('Practice');
  });

  it('lays out a launcher that appears (a recording to replay)', () => {
    const { rerender } = renderChrome({ fixed: false, layoutKey: 'modern', replay: null });
    expect(lefts()).toEqual(['4px', '78px', '152px']);
    rerender({
      fixed: false,
      layoutKey: 'modern',
      replay: { hasRecording: true, isReplaying: false, onEnter: vi.fn(), onExit: vi.fn(), notice: null },
    });
    expect(lefts()).toEqual(['4px', '78px', '152px', '226px']);
  });
});

// Escape is one press for one layer, the topmost (useEscapeLayer), whichever registered first.
describe('Escape, with what else is open', () => {
  const REPLAYING = { hasRecording: true, isReplaying: true, onEnter: vi.fn(), onExit: vi.fn(), notice: null };
  const press = () => fireEvent.keyDown(document.body, { key: 'Escape' });

  /** The replay bar, mounted before the chrome, so its window listener is registered first. */
  function renderReplayBar(overrides: Partial<ComponentProps<typeof ReplayControls>> = {}) {
    render(
      <TooltipProvider>
        <ReplayControls
          compact={false}
          replayFrameIndex={4}
          totalFrames={12}
          onExitReplay={vi.fn()}
          onStepBack={vi.fn()}
          onStepForward={vi.fn()}
          onJumpToStart={vi.fn()}
          onJumpToEnd={vi.fn()}
          onSeek={vi.fn()}
          onPreviewSeek={vi.fn()}
          onPlayPause={vi.fn()}
          isPlaying={false}
          onTakeOver={vi.fn()}
          replayCursorVisible
          onReplayCursorVisibleChange={vi.fn()}
          {...overrides}
        />
      </TooltipProvider>,
    );
  }

  it('closes Practice over a replay and leaves the replay playing; the next press exits it', () => {
    const onExitReplay = vi.fn();
    renderReplayBar({ onExitReplay });
    renderChrome({ replay: REPLAYING });
    fireEvent.click(launcher('Practice'));

    press();
    expect(pane()).toBeNull();
    expect(onExitReplay).not.toHaveBeenCalled();

    press();
    expect(onExitReplay).toHaveBeenCalledOnce();
  });

  it('closes the menu over a replay without exiting it', () => {
    const onExitReplay = vi.fn();
    renderReplayBar({ onExitReplay });
    renderChrome({ replay: REPLAYING });
    fireEvent.click(launcher('Menu'));

    press();
    expect(pane()).toBeNull();
    expect(onExitReplay).not.toHaveBeenCalled();
  });

  it('closes the Ctrl+K encounter search over the open menu first, then the menu', () => {
    function Search() {
      const [open, setOpen] = useState(true);
      return (
        <EncounterPicker
          isOpen={open}
          onClose={() => setOpen(false)}
          onEnter={vi.fn()}
          onConfigure={vi.fn()}
          encounterRegistry={new EncounterRegistry()}
        />
      );
    }
    renderChrome();
    fireEvent.click(launcher('Menu'));
    render(<Search />);
    const search = () => document.querySelector('.picker-overlay');
    expect(search()).not.toBeNull();

    press();
    expect(search()).toBeNull();
    expect(pane()?.dataset.pane).toBe('menu');

    press();
    expect(pane()).toBeNull();
  });
});

describe('Practice', () => {
  it('remembers the tab across closing and reopening', () => {
    renderChrome();
    fireEvent.click(launcher('Practice'));
    expect(screen.getByRole('button', { name: 'Setup' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
    fireEvent.click(launcher('Practice'));
    fireEvent.click(launcher('Practice'));
    expect(screen.getByRole('button', { name: 'Stats' })).toHaveAttribute('aria-pressed', 'true');
  });

  it("jumps to a section in the body's own pixels above 1x zoom, not the zoomed ones on screen", () => {
    // The body scrolls, so the section shortcuts show; each section's offset in its content is 200
    // CSS px after the last. On screen the zoom draws those 1.5 times as far apart.
    const zoom = 1.5;
    const contentTop = { fightSetup: 0, [`section:${SOL_SECTION}`]: 200, assists: 400 } as Record<string, number>;
    const setupBody = (element: HTMLElement) => element.closest<HTMLElement>('.launcher-pane__body--setup');
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('launcher-pane__body--setup') ? 900 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('launcher-pane__body--setup') ? 200 : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
      return contentTop[this.dataset.practiceGroup ?? ''] ?? 0;
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.practiceGroup ? setupBody(this) : null;
      },
    });
    const bodyTopOnScreen = 100;
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      if (this.classList.contains('launcher-btn--icon')) return rect(0, 0, 28 * zoom, 28 * zoom);
      if (this.classList.contains('launcher-btn')) return rect(0, 0, 70 * zoom, 28 * zoom);
      if (this.classList.contains('launcher-pane__body--setup')) return rect(8, bodyTopOnScreen, 200, 300);
      const group = this.dataset.practiceGroup;
      const body = setupBody(this);
      if (group && body) return rect(8, bodyTopOnScreen + (contentTop[group] - body.scrollTop) * zoom, 200, 100);
      return rect(0, 0, 0, 0);
    });
    try {
      renderChrome({ zoom });
      fireEvent.click(launcher('Practice'));
      fireEvent.click(screen.getByRole('button', { name: /Options/ }));
      const sections = within(pane()?.querySelector('.launcher-sections') as HTMLElement);
      const body = pane()?.querySelector<HTMLElement>('.launcher-pane__body--setup') as HTMLElement;

      fireEvent.click(sections.getByRole('button', { name: SOL_SECTION }));
      expect(body.scrollTop).toBe(200);
      fireEvent.click(sections.getByRole('button', { name: 'Aids' }));
      expect(body.scrollTop).toBe(400);
      fireEvent.click(sections.getByRole('button', { name: 'Fight' }));
      expect(body.scrollTop).toBe(0);
    } finally {
      delete (HTMLElement.prototype as { offsetParent?: unknown }).offsetParent;
    }
  });

  it('keeps immediate controls outside collapsed Options and actions in their own palette', () => {
    renderChrome();
    fireEvent.click(launcher('Practice'));
    const options = screen.getByRole('button', { name: /Options/ });
    expect(options).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(options);
    const titles = Array.from(pane()?.querySelectorAll('.practice-options__heading') ?? []).map((t) => t.textContent);
    // Sol's own toggles head their own section, as TzKal-Zuk's do on an Inferno run.
    expect(titles).toEqual([SOL_SECTION, 'Practice aids']);
    expect(screen.getByText('Jump to phase')).toBeDefined();
    expect(screen.queryByText('Practice Aids')).toBeNull();
  });

  it('shows Stats from playback in replay, with Setup and Actions off and saying why', async () => {
    const { rerender } = renderChrome();
    fireEvent.click(launcher('Practice'));
    rerender({ replay: { hasRecording: true, isReplaying: true, onEnter: vi.fn(), onExit: vi.fn(), notice: null } });
    const setup = screen.getByRole('button', { name: 'Setup' });
    expect(setup).toHaveAttribute('aria-disabled', 'true');
    fireEvent.pointerEnter(setup, { pointerType: 'mouse' });
    expect((await waitFor(() => screen.getByRole('tooltip'))).textContent).toMatch(/off while you watch a replay/);
    fireEvent.pointerLeave(setup, { pointerType: 'mouse' });
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
    expect(screen.getByText('From the replay')).toBeDefined();
    fireEvent.click(setup);
    expect(screen.getByRole('button', { name: 'Stats' })).toHaveAttribute('aria-pressed', 'true');
    expect(launcher('Actions')).toHaveAttribute('aria-disabled', 'true');
    fireEvent.pointerEnter(launcher('Actions'), { pointerType: 'mouse' });
    expect((await waitFor(() => screen.getByRole('tooltip'))).textContent).toBe(
      'Actions are off while you watch a replay.',
    );
    fireEvent.pointerLeave(launcher('Actions'), { pointerType: 'mouse' });
    fireEvent.click(launcher('Actions'));
    expect(pane()?.dataset.pane).toBe('practice');

    // Live again: back on the tab that was chosen.
    rerender({ replay: { hasRecording: true, isReplaying: false, onEnter: vi.fn(), onExit: vi.fn(), notice: null } });
    expect(screen.getByRole('button', { name: 'Setup' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Stats', () => {
  function openStats(overrides: Partial<ComponentProps<typeof TopChrome>> = {}) {
    renderChrome(overrides);
    fireEvent.click(launcher('Practice'));
    fireEvent.click(screen.getByRole('button', { name: 'Stats' }));
    return pane() as HTMLElement;
  }
  const readValue = (stats: HTMLElement, label: string) =>
    within(stats).getByText(label, { selector: '.launcher-stats__label, .launcher-stats__sub' }).nextElementSibling
      ?.textContent;

  it('says "None" and "No damage yet" rather than inventing numbers', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 33] });
    const stats = openStats({ engine, simulationState: { ...engine.getState(), npcs: [] }, debugActions: [] });
    expect(readValue(stats, 'Target')).toBe('None');
    expect(readValue(stats, 'DPS')).toBe('No damage yet');
    expect(readValue(stats, 'Player')).toBe('99 / 99');
  });

  it('names the target from its monster metadata, with DPS Actual and Expected under one label', () => {
    const engine = new SimulationEngine({ encounter: new YamaEncounter(), startPos: [31, 33] });
    engine.setAttackTarget('yama');
    const live = engine.getState();
    // One 30 hit (24 expected) on tick 0, read 10 ticks (6 seconds) later.
    const hit = { tick: 0, source: 'PlayerAttack', targetId: 'yama', effectiveDamage: 30, expectedHit: 24 };
    const simulationState = {
      ...live,
      currentTick: 10,
      damageHistory: [hit as unknown as (typeof live.damageHistory)[number]],
    };
    const stats = openStats({ engine, simulationState, debugActions: [] });
    expect(within(stats).getByText('Yama', { selector: '.launcher-stats__label' })).toBeDefined();
    const dps = stats.querySelector('.launcher-stats__dps');
    expect(dps?.firstElementChild?.textContent).toBe('DPS');
    expect(readValue(stats, 'Actual')).toBe('5.00');
    expect(readValue(stats, 'Expected')).toBe('4.00');
  });

  it('keeps the phase shortcuts and slider on Zuk while the target is Jad', () => {
    const engine = new SimulationEngine({ encounter: createZukWaveEncounter(1) });
    engine.applyBossHpPreset(480);
    engine.executeEncounterCommand({ encounter: 'zuk', type: 'spawn-jad' });
    const jad = engine.getState().npcs.find((npc) => npc.npcTypeId === 7704);
    if (!jad) throw new TypeError('Missing Jad fixture');
    engine.setAttackTarget(jad.id);
    const onApplyBossHpPreset = vi.fn();
    const stats = openStats({
      engine,
      simulationState: engine.getState(),
      mechanicsConfig: engine.getMechanicsConfig(),
      onApplyBossHpPreset,
      debugActions: [],
    });
    expect(within(stats).getByText('JalTok-Jad', { selector: '.launcher-stats__label' })).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Setup' }));
    fireEvent.click(screen.getByRole('button', { name: 'Set TzKal-Zuk to Start (1200 HP)' }));
    expect(onApplyBossHpPreset).toHaveBeenCalledExactlyOnceWith(1200);
    expect(screen.getByRole('slider', { name: 'Set TzKal-Zuk health' })).toHaveAttribute('max', '1200');
  });
});

// The real tour runner (Driver.js), the Getting Started steps and this chrome, wired as App wires
// them: the menu is pinned and the chrome raised while the tour is up.
describe('during the Getting Started tour', () => {
  const styles: HTMLStyleElement[] = [];
  beforeEach(() => {
    // Driver.js's own pointer policy and this chrome's answer to it, so the cascade can be read.
    for (const file of ['node_modules/driver.js/dist/driver.css', 'src/components/launcher/TopChrome.css']) {
      const style = document.createElement('style');
      style.textContent = readFileSync(join(process.cwd(), file), 'utf8');
      document.head.append(style);
      styles.push(style);
    }
    localStorage.clear();
    // Resume where the Practice steps begin ("Open the fight stats", step 5); the steps before them
    // want a game panel. With none here, Move and Resize (1, 2) are skipped and were never shown.
    saveTutorialProgress('main', { lastStep: 5, completed: false, completedSteps: [0, 3, 4] });
  });
  afterEach(() => {
    for (const style of styles.splice(0)) style.remove();
    localStorage.clear();
  });

  function Tour({ onReady }: { onReady: (director: ReturnType<typeof useTutorialDirector>) => void }) {
    const engineRef = useRef(solEngine());
    const director = useTutorialDirector({
      isTouchOnly: false,
      engineRef,
      simulationState: engineRef.current.getState(),
      completionOwnership: 'encounter-owned',
      activeEncounterKind: 'lobby',
      settledEncounterKind: 'lobby',
      enterEncounter: vi.fn(),
      enterLobby: vi.fn(),
      resetEncounter: vi.fn(),
      setMechanics: vi.fn(),
      setTargetTile: vi.fn(),
      injectAction: vi.fn(),
      castMarkOfDarkness: vi.fn(),
      executeEncounterCommand: vi.fn(() => true),
      activateTilePreset: vi.fn(),
      deactivateTilePresets: vi.fn(),
      fastForwardTicks: vi.fn(),
      setTutorialPaused: vi.fn(),
    });
    onReady(director);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const engine = engineRef.current;
    // App's menu entries, as far as the tour is concerned (App.tsx `navItems`).
    const items = (
      <>
        <button
          type="button"
          className="controls-toggle-open"
          data-menu-item="settings"
          onClick={() => {
            setSettingsOpen(true);
            window.dispatchEvent(new CustomEvent('tutorial:settings-opened'));
          }}
        >
          Settings
        </button>
        <div className="tutorials-button-anchor">
          <button type="button" className="controls-toggle-open">
            Training
          </button>
          {director.spotlightActive && (
            <button type="button" aria-label="Exit tutorial" onClick={director.exitTutorial}>
              ×
            </button>
          )}
        </div>
      </>
    );
    return (
      <>
        {/* App's Settings sidebar, as far as the tour's guards are concerned: the Settings steps need it open. */}
        <aside className={settingsOpen ? 'controls-overlay open' : 'controls-overlay'} />
        <TopChrome
          frameRef={{ current: frame }}
          fixed
          zoom={1}
          layoutKey="fixed"
          settings={{ open: settingsOpen, inset: 320 }}
          elevated={director.spotlightActive}
          menu={{ items, pinned: director.spotlightActive }}
          plugins={null}
          showFps={false}
          engine={engine}
          simulationState={engine.getState()}
          mechanicsConfig={engine.getMechanicsConfig()}
          onMechanicsConfigChange={vi.fn()}
          mechanicsToggles={encounterControlsForKind('sol_heredit')?.mechanicsToggles ?? []}
          debugActions={ACTIONS}
          onExecuteEncounterCommand={vi.fn()}
          onSetBossHp={vi.fn()}
          replay={null}
        />
      </>
    );
  }

  const title = () => document.querySelector('.driver-popover-title')?.textContent;
  const description = () => document.querySelector('.driver-popover-description')?.textContent;
  const spotlit = () => document.querySelector('.driver-active-element');
  const next = () => fireEvent.click(document.querySelector('.driver-popover-next-btn') as HTMLElement);
  const exit = () => screen.queryByRole('button', { name: 'Exit tutorial' });
  // Driver.js finishes a highlight (and a step its action listener) on the next frame.
  const highlighted = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  const pressable = (element: Element | null) => element !== null && getComputedStyle(element).pointerEvents !== 'none';

  it('opens Practice, moves on, and still finds Settings, with Exit reachable throughout', async () => {
    let director: ReturnType<typeof useTutorialDirector> | null = null;
    render(<Tour onReady={(live) => (director = live)} />);
    // Nothing pinned yet: the menu is closed until the tour starts.
    expect(pane()).toBeNull();
    act(() => director?.startTutorial('main'));
    expect(title()).toBe('Open the fight stats');
    expect(spotlit()).toBe(launcher('Practice'));

    // The Practice step: the pane takes the pinned menu's place.
    await highlighted();
    fireEvent.click(launcher('Practice'));
    await waitFor(() => expect(title()).toBe('Fight stats and setup'));
    expect(pane()?.dataset.pane).toBe('practice');
    // Practice opens on Setup (or the tab last chosen): the step names both tabs and sends the
    // player to Stats for the readouts it describes, rather than switching tabs itself.
    await highlighted();
    expect(spotlit()).toBe(pane());
    expect(description()).toContain('Practice has two tabs: Setup and Stats. Stats shows your DPS');
    const statsTab = within(pane() as HTMLElement).getByRole('button', { name: 'Stats' });
    expect(within(pane() as HTMLElement).getByRole('button', { name: 'Setup' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(pressable(statsTab)).toBe(true);
    fireEvent.click(statsTab);
    for (const readout of ['DPS', 'Max hit', 'Tick']) {
      expect(within(spotlit() as HTMLElement).getByText(readout, { selector: '.launcher-stats__label' })).toBeDefined();
    }
    // Training and its Exit are one press away: the Menu launcher takes clicks under the overlay,
    // undimmed, while the rest of the row does not.
    expect(document.body).toHaveClass('driver-active');
    expect(pressable(launcher('Menu'))).toBe(true);
    expect(getComputedStyle(launcher('Menu')).opacity).not.toBe('0.3');
    expect(pressable(launcher('Actions'))).toBe(false);
    expect(getComputedStyle(launcher('Actions')).opacity).toBe('0.3');

    // A later step: leaving the stats closes Practice, and the pinned menu is back with Exit.
    next();
    expect(title()).toBe('Return to Lobby');
    await waitFor(() => expect(pane()?.dataset.pane).toBe('menu'));
    expect(pressable(exit())).toBe(true);

    // The Settings step points at the pinned menu's first row, which takes the click.
    next();
    expect(title()).toBe('Open Main Settings');
    await highlighted();
    const settings = within(pane() as HTMLElement).getByRole('button', { name: 'Settings' });
    expect(spotlit()).toBe(settings);
    expect(pressable(settings)).toBe(true);
    expect(pressable(exit())).toBe(true);
    fireEvent.click(settings);
    await waitFor(() => expect(title()).toBe('Settings'));

    act(() => director?.exitTutorial());
    expect(document.querySelector('.driver-popover')).toBeNull();
    expect(exit()).toBeNull();
  });

  it('jumps from the Practice step straight to Settings through the step drawer, and spotlights the menu row', async () => {
    let director: ReturnType<typeof useTutorialDirector> | null = null;
    render(<Tour onReady={(live) => (director = live)} />);
    act(() => director?.startTutorial('main'));
    await highlighted();
    fireEvent.click(launcher('Practice'));
    await waitFor(() => expect(title()).toBe('Fight stats and setup'));
    expect(pane()?.dataset.pane).toBe('practice');

    // Driver resolves the destination before it deselects this step, so the menu Practice covers
    // has to be back before the move, not after it.
    fireEvent.click(document.querySelector('.tutorial-stepnav-trigger') as HTMLElement);
    const row = Array.from(document.querySelectorAll<HTMLButtonElement>('.tutorial-stepnav-item-btn')).find(
      (button) => button.querySelector('.tutorial-stepnav-label')?.textContent === 'Open Main Settings',
    );
    fireEvent.click(row as HTMLButtonElement);

    await waitFor(() => expect(title()).toBe('Open Main Settings'));
    await highlighted();
    expect(pane()?.dataset.pane).toBe('menu');
    const settings = within(pane() as HTMLElement).getByRole('button', { name: 'Settings' });
    expect(spotlit()).toBe(settings);
    expect(document.getElementById('driver-dummy-element')).toBeNull();
    expect(pressable(settings)).toBe(true);
    fireEvent.click(settings);
    await waitFor(() => expect(title()).toBe('Settings'));

    act(() => director?.exitTutorial());
  });
});

describe('Plugins and the FPS readout', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('top-chrome__corner') ? CORNER_WIDTH : 0;
    });
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('top-chrome__corner') ? 28 : 0;
    });
  });

  const closed = (onToggle = vi.fn()) => ({ open: false, inset: 320, onToggle });
  const open = (inset: number, onToggle = vi.fn()) => ({ open: true, inset, onToggle });
  const pluginsButton = () => screen.getByRole('button', { name: 'Plugins' });

  it("keeps Plugins labeled in the window's top-right corner, over the frame, with the FPS readout under it", () => {
    const onToggle = vi.fn();
    renderChrome({ plugins: closed(onToggle), showFps: true });
    const plugins = pluginsButton();
    expect(plugins).not.toHaveClass('launcher-btn--icon');
    expect(plugins.textContent).toBe('Plugins');
    expect(plugins.parentElement?.style.left).toBe(`${765 - 4 - CORNER_WIDTH}px`);
    expect(plugins.parentElement?.style.top).toBe('4px');
    expect(plugins).toHaveAttribute('aria-pressed', 'false');
    expect(plugins).not.toHaveClass('is-open');
    fireEvent.click(plugins);
    expect(onToggle).toHaveBeenCalledOnce();
    // Flush with Plugins' right edge, one gap under it, growing leftward; backed.
    const fps = screen.getByTestId('fps-overlay');
    expect(fps.style.right).toBe('4px');
    expect(fps.style.top).toBe(`${4 + 28 + 4}px`);
    expect(fps).toHaveClass('fps-overlay--backed');
  });

  it('moves left past its open drawer, pressed, and closes it on a press, the FPS readout following', () => {
    const onToggle = vi.fn();
    renderChrome({ plugins: open(320, onToggle), showFps: true });
    const plugins = pluginsButton();
    // Shown, one gap left of the 320px drawer, as the row sits one gap right of Settings.
    expect(plugins.parentElement).not.toHaveAttribute('data-tucked', 'true');
    expect(plugins.parentElement?.style.left).toBe(`${765 - 320 - 4 - CORNER_WIDTH}px`);
    expect(plugins).toHaveAttribute('aria-pressed', 'true');
    expect(plugins).toHaveClass('is-open');
    fireEvent.click(plugins);
    expect(onToggle).toHaveBeenCalledOnce();
    const fps = screen.getByTestId('fps-overlay');
    expect(fps.style.right).toBe(`${320 + 4}px`);
    expect(fps.style.top).toBe(`${4 + 28 + 4}px`);
  });

  it('slides with its drawer, the FPS readout with it, and goes back to placing at once', () => {
    vi.useFakeTimers();
    try {
      const { rerender } = renderChrome({ plugins: closed(), showFps: true });
      const chrome = () => document.querySelector('.top-chrome');
      expect(chrome()).not.toHaveClass('top-chrome--sliding');
      rerender({ plugins: open(320), showFps: true });
      expect(chrome()).toHaveClass('top-chrome--sliding');
      expect(screen.getByTestId('fps-overlay')).toHaveClass('fps-overlay--sliding');
      act(() => vi.advanceTimersByTime(320));
      expect(chrome()).not.toHaveClass('top-chrome--sliding');
      expect(screen.getByTestId('fps-overlay')).not.toHaveClass('fps-overlay--sliding');
    } finally {
      vi.useRealTimers();
    }
  });

  it('hides under a drawer that covers the whole window, and the FPS readout with it', () => {
    renderChrome({ plugins: open(0), showFps: true });
    expect(pluginsButton().parentElement).toHaveAttribute('data-tucked', 'true');
    expect(screen.queryByTestId('fps-overlay')).toBeNull();
  });

  // Raised over the drawers for a tour, Plugins sat on the full-window Settings drawer's close.
  it('hides with the FPS readout under a full-window Settings drawer', () => {
    const onPluginsChange = vi.fn();
    renderChrome({ settings: { open: true, inset: 0 }, plugins: closed(), showFps: true, onPluginsChange });
    expect(pluginsButton().parentElement).toHaveAttribute('data-tucked', 'true');
    expect(onPluginsChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId('fps-overlay')).toBeNull();
  });

  it('gives way to the row where both drawers leave no room for the two, the FPS readout with it', () => {
    const onPluginsChange = vi.fn();
    // 765 wide: the row starts at 324 past Settings, Plugins would start at 375 left of its drawer.
    renderChrome({ settings: { open: true, inset: 320 }, plugins: open(320), showFps: true, onPluginsChange });
    expect(pluginsButton().parentElement).toHaveAttribute('data-tucked', 'true');
    for (const item of row()?.children ?? []) expect(item).not.toHaveAttribute('data-tucked', 'true');
    expect(onPluginsChange).toHaveBeenLastCalledWith(null);
    expect(screen.queryByTestId('fps-overlay')).toBeNull();
  });

  it("reports where Plugins is for the boss bar's default to keep clear of, moved or not, and nothing while it is hidden", () => {
    const onPluginsChange = vi.fn();
    const { rerender } = renderChrome({ plugins: closed(), onPluginsChange });
    expect(onPluginsChange).toHaveBeenLastCalledWith({
      x: 765 - 4 - CORNER_WIDTH,
      y: 4,
      width: CORNER_WIDTH,
      height: 28,
    });
    rerender({ plugins: open(320), onPluginsChange });
    expect(onPluginsChange).toHaveBeenLastCalledWith({
      x: 765 - 320 - 4 - CORNER_WIDTH,
      y: 4,
      width: CORNER_WIDTH,
      height: 28,
    });
    rerender({ plugins: open(0), onPluginsChange });
    expect(onPluginsChange).toHaveBeenLastCalledWith(null);
  });
});
