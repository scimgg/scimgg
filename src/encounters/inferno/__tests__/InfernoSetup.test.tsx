// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PracticePane, type PracticePaneProps } from '../../../components/launcher/PracticePane';
import { MechanicsSettings } from '../../../components/MechanicsSettings';
import { MobilePracticeControls } from '../../../components/MobilePracticeControls';
import { nearestMapTarget } from '../../../components/SpawnLayoutMap';
import { SimulationEngine } from '../../../core/SimulationEngine';
import type { Coordinate, MechanicsConfig } from '../../../types/simulation';
import { deleteSetting, loadSetting } from '../../../util/storage';
import { encounterControlsForKind } from '../../modules';
import { type EncounterSetupRun, encounterPracticeSession, encounterSetupControlsForKind } from '../../practiceChrome';
import { INFERNO_ARENA_MAP_IMAGE } from '../arenaMapImage';
import {
  buildInfernoControls,
  INFERNO_DESTROYED_PILLAR_KEYS,
  INFERNO_SPAWN_LAYOUT_KEY,
  INFERNO_START_WAVE_KEY,
} from '../controls';
import { InfernoEncounter } from '../InfernoEncounter';
import { InfernoLayoutTool } from '../InfernoLayoutTool';
import { INFERNO_SETUP_KEYS, InfernoSetup, type InfernoSetupProps, infernoSetupSummary } from '../InfernoSetup';
import { dismissInfernoSetupLinkNotice, showInfernoSetupLinkNotice } from '../setupLinkNotice';
import { buildInfernoSetupUrl, parseInfernoSetupParams, parseSpawnLayout } from '../spawnLayout';
import { waveCompositionText } from '../waveInfo';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const key of ['inferno-practice-shortcuts-expanded', 'inferno-rail-shortcuts-expanded']) deleteSetting(key);
  dismissInfernoSetupLinkNotice();
});

function setup(initial: Partial<MechanicsConfig> = {}, props: Partial<InfernoSetupProps> & { tool?: boolean } = {}) {
  let stored = { infiniteHealth: false, [INFERNO_START_WAVE_KEY]: '52', ...initial } as MechanicsConfig;
  const changed = vi.fn();
  let run = props.run;
  let setTool: (open: boolean) => void;
  const Host = () => {
    const [config, setConfig] = useState(stored);
    const [editing, setEditing] = useState(props.tool ?? false);
    setTool = setEditing;
    stored = config;
    if (editing)
      return (
        <InfernoLayoutTool
          config={config}
          run={run}
          exportGear={props.exportGear}
          onClose={() => setEditing(false)}
          onChange={(next) => {
            changed(next);
            setConfig(next);
          }}
        />
      );
    return (
      <InfernoSetup
        {...props}
        config={config}
        surface={props.surface ?? 'rail'}
        run={run}
        onChange={(next) => {
          changed(next);
          setConfig(next);
        }}
      />
    );
  };
  let view = render(<Host />);
  return {
    config: () => stored,
    changed,
    openTool: () => act(() => setTool(true)),
    closeTool: () => act(() => setTool(false)),
    reopen(nextRun = run) {
      view.unmount();
      run = nextRun;
      view = render(<Host />);
    },
  };
}
const waveField = () => screen.getByRole('spinbutton', { name: 'Start wave' }) as HTMLInputElement;
const shortcuts = () => fireEvent.click(screen.getByRole('button', { name: 'Wave shortcuts' }));
function setupArena(initial: Partial<MechanicsConfig> = {}) {
  const host = setup(initial);
  fireEvent.click(screen.getByRole('button', { name: /^Edit layout / }));
  return host;
}
const slot = (index: number) => document.querySelector<HTMLElement>(`[data-spawn-slot="${index}"]`)!;
const choose = (index: number, kind: string) => {
  fireEvent.click(slot(index));
  fireEvent.click(within(screen.getByRole('dialog', { name: /^Monster at/ })).getByRole('button', { name: kind }));
};
const copyButton = () => document.querySelector<HTMLButtonElement>('.inferno-copy-link')!;
function floor([x, y]: Coordinate) {
  const map = screen.getByTestId('arena-map');
  const plane = map.querySelector('.spawn-map__plane')!;
  vi.spyOn(plane, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    right: 330,
    bottom: 340,
    width: 330,
    height: 340,
  } as DOMRect);
  fireEvent.click(map, { clientX: (x - 15 + 0.5) * 10, clientY: (48 - y + 0.5) * 10 });
}
const runFor = (stage = 52, extra: Partial<EncounterSetupRun> = {}): EncounterSetupRun => ({
  stage,
  startedWith: '',
  execute: vi.fn(),
  ...extra,
});

describe('wave navigation remains independent of arena editing', () => {
  it('types, clamps and describes a wave without starting it', () => {
    const run = runFor();
    const host = setup({}, { run, surface: 'practice' });
    fireEvent.change(waveField(), { target: { value: '6' } });
    fireEvent.change(waveField(), { target: { value: '62' } });
    fireEvent.blur(waveField());
    expect(host.config()[INFERNO_START_WAVE_KEY]).toBe('62');
    expect(run.execute).not.toHaveBeenCalled();
    fireEvent.keyDown(waveField(), { key: 'Enter' });
    expect(run.execute).toHaveBeenCalledExactlyOnceWith({ encounter: 'inferno', type: 'go-to-wave', wave: 62 });
    fireEvent.change(waveField(), { target: { value: '400' } });
    expect(host.config()[INFERNO_START_WAVE_KEY]).toBe('69');
  });
  it('retains composition, continuation and the Zuk footer identity', () => {
    setup({ [INFERNO_START_WAVE_KEY]: '47' });
    expect(screen.getByText(waveCompositionText(47))).toBeVisible();
    expect(screen.getByText('Continues through to wave 69.')).toBeVisible();
    fireEvent.change(waveField(), { target: { value: '69' } });
    expect(screen.getByText('The final wave of the Inferno.')).toBeVisible();
    expect(infernoSetupSummary({ infiniteHealth: false, infernoStartWave: '69' })).toBe('Wave 69 · TzKal-Zuk');
    expect(infernoSetupSummary({ infiniteHealth: false, infernoStartWave: '35' })).toBe('Wave 35');
    // Partial or whole, a layout is custom.
    for (const layout of ['52:g--------', '52:grb-----b']) {
      expect(infernoSetupSummary({ infiniteHealth: false, infernoStartWave: '52', infernoSpawnLayout: layout })).toBe(
        'Wave 52 · Custom layout',
      );
    }
  });
  it.each([
    { wave: 35, label: 'Mager' },
    { wave: 50, label: 'Mager and ranger' },
    { wave: 63, label: 'Hard wave' },
  ])('keeps wave $wave a setting in the rail and a direct jump in Practice', ({ wave, label }) => {
    let host = setup();
    shortcuts();
    fireEvent.click(screen.getByRole('button', { name: `${label}, wave ${wave}` }));
    expect(host.config()[INFERNO_START_WAVE_KEY]).toBe(String(wave));
    expect(screen.getByRole('button', { name: `${label}, wave ${wave}` })).toHaveAttribute('aria-pressed', 'true');
    cleanup();
    const run = runFor();
    host = setup({}, { run, surface: 'practice' });
    shortcuts();
    expect(screen.getAllByRole('button', { name: /, wave \d+$/ })).toHaveLength(10);
    fireEvent.click(screen.getByRole('button', { name: `${label}, wave ${wave}` }));
    expect(run.execute).toHaveBeenCalledExactlyOnceWith({ encounter: 'inferno', type: 'go-to-wave', wave });
  });
  it('preserves separate shortcut preferences across remounts', () => {
    const host = setup({}, { surface: 'practice', run: runFor() });
    expect(screen.getByRole('button', { name: 'Wave shortcuts' })).toHaveAttribute('aria-expanded', 'false');
    shortcuts();
    host.reopen();
    expect(screen.getByRole('button', { name: 'Mager, wave 35' })).toBeVisible();
    expect(loadSetting('inferno-practice-shortcuts-expanded')).toBe(true);
    cleanup();
    setup();
    expect(screen.getByRole('button', { name: 'Wave shortcuts' })).toHaveAttribute('aria-expanded', 'false');
  });
  it('offers Go even for matching setup, while steppers only save', () => {
    vi.spyOn(HTMLInputElement.prototype, 'stepUp').mockImplementation(function (this: HTMLInputElement) {
      fireEvent.change(this, { target: { value: String(+this.value + 1) } });
    });
    const run = runFor();
    setup({}, { surface: 'practice', run });
    fireEvent.click(screen.getByRole('button', { name: 'Go: restart at wave 52' }));
    expect(run.execute).toHaveBeenCalledExactlyOnceWith({ encounter: 'inferno', type: 'go-to-wave', wave: 52 });
    vi.mocked(run.execute).mockClear();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Increment' }));
    fireEvent.mouseUp(screen.getByRole('button', { name: 'Increment' }));
    expect(waveField()).toHaveValue(53);
    expect(run.execute).not.toHaveBeenCalled();
  });
  it('keeps pending setup across remounts, clearing it only when the run matches', () => {
    const run = runFor();
    const host = setup({}, { surface: 'practice', run });
    host.openTool();
    fireEvent.click(screen.getByRole('button', { name: 'South pillar' }));
    expect(run.execute).not.toHaveBeenCalled();
    host.closeTool();
    host.reopen();
    expect(screen.getByText('Setup saved. Press Go to start wave 52 with it.')).toBeVisible();
    host.reopen({ ...run, startedWith: 'south' });
    expect(screen.queryByText(/^Setup saved/)).toBeNull();
  });
  it.each([2, 66, 67, 68])('tracks tile-only pending changes on wave %s without moving the live player', (wave) => {
    const run = runFor(wave);
    const host = setup({ infernoStartWave: String(wave) }, { surface: 'practice', run });
    host.openTool();
    floor([33, 44]);
    host.closeTool();
    expect(screen.getByText(/^Setup saved/)).toBeInTheDocument();
    expect(run.execute).not.toHaveBeenCalled();
    host.openTool();
    fireEvent.click(screen.getByRole('button', { name: 'Reset start' }));
    host.closeTool();
    expect(screen.queryByText(/^Setup saved/)).toBeNull();
  });
  it('does not call automatic wave progression an unsaved setup change', () => {
    setup({ infernoStartWave: '35' }, { surface: 'practice', run: runFor(48) });
    expect(waveField()).toHaveValue(35);
    expect(screen.queryByText(/^Setup saved/)).toBeNull();
  });
});

describe('one map derives random, partial and complete spawns', () => {
  it('starts collapsed, expands directly beneath the Arena row, and collapses without losing edits', () => {
    setup();
    expect(screen.queryByTestId('arena-map')).toBeNull();
    const summary = screen.getByRole('button', { name: 'Edit layout Random' });
    expect(summary).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(summary);
    expect(document.querySelectorAll('[data-spawn-slot]')).toHaveLength(9);
    expect(screen.getByText('Pick a monster above, then tap its spots.')).toBeVisible();
    expect(screen.getByRole('region', { name: 'Wave 52 layout' })).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    choose(0, 'Mager');
    expect(summary).toHaveAttribute('aria-expanded', 'true');
    expect(summary.querySelector('svg')).toHaveClass('disclosure-chevron', 'is-open');
    expect(summary.nextElementSibling).toBe(screen.getByRole('region', { name: 'Wave 52 layout' }));
    fireEvent.click(summary);
    expect(screen.queryByTestId('arena-map')).toBeNull();
    expect(summary).toHaveTextContent('Custom, rest random');
    fireEvent.click(summary);
    expect(slot(0)).toHaveTextContent('Mager');
  });
  it('offers only unplaced wave monsters, saves each placement, and clears to random', () => {
    const host = setupArena();
    fireEvent.click(slot(0));
    const picker = screen.getByRole('dialog', { name: 'Monster at North-west' });
    expect(
      within(picker)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Mager', 'Ranger', 'Bat']);
    fireEvent.click(within(picker).getByRole('button', { name: 'Mager' }));
    // Part of the wave is a layout already: the rest spawn at random.
    expect(host.config()[INFERNO_SPAWN_LAYOUT_KEY]).toBe('52:g--------');
    expect(screen.getByRole('status')).toHaveTextContent('Custom, rest random');
    choose(1, 'Ranger');
    choose(2, 'Bat');
    expect(host.config()[INFERNO_SPAWN_LAYOUT_KEY]).toBe('52:grb------');
    choose(8, 'Bat');
    expect(host.config()[INFERNO_SPAWN_LAYOUT_KEY]).toBe('52:grb-----b');
    expect(screen.getByRole('status')).toHaveTextContent('Custom');
    fireEvent.click(screen.getByRole('button', { name: 'Clear spawns' }));
    expect(host.config()[INFERNO_SPAWN_LAYOUT_KEY]).toBe('');
    expect(screen.getByRole('status')).toHaveTextContent('Random');
    expect(document.querySelectorAll('.spawn-map__slot.is-filled')).toHaveLength(0);
  });
  it('arms progress chips and places successive monsters until their total is reached', () => {
    const host = setupArena();
    const mager = screen.getByRole('button', { name: 'Mager 0/1' });
    expect(screen.getByRole('button', { name: 'Ranger 0/1' })).toBeEnabled();
    fireEvent.click(mager);
    expect(mager).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(slot(0));
    expect(slot(0)).toHaveTextContent('Mager');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Mager 1/1' })).toBeDisabled();
    expect(host.config().infernoSpawnLayout).toBe('52:g--------');
    fireEvent.click(screen.getByRole('button', { name: 'Bat 0/2' }));
    fireEvent.click(slot(2));
    expect(screen.getByRole('button', { name: 'Bat 1/2' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(slot(8));
    expect(screen.getByRole('button', { name: 'Bat 2/2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Bat 2/2' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Ranger 0/1' }));
    fireEvent.click(slot(1));
    expect(host.config().infernoSpawnLayout).toBe('52:grb-----b');
  });
  it('disarms on a second chip press and preserves the direct spot picker', () => {
    setupArena();
    const chip = screen.getByRole('button', { name: 'Mager 0/1' });
    fireEvent.click(chip);
    fireEvent.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(slot(0));
    expect(screen.getByRole('dialog', { name: 'Monster at North-west' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Ranger 0/1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(slot(0));
    fireEvent.click(screen.getByRole('button', { name: 'Mager 0/1' }));
    fireEvent.click(slot(0));
    expect(screen.getByRole('dialog', { name: 'Monster at North-west' })).toBeVisible();
    expect(slot(0)).toHaveTextContent('Ranger');
  });
  it('re-enables completed kinds after removal without re-arming them', () => {
    setupArena({ infernoSpawnLayout: '52:grb-----b' });
    expect(screen.getByRole('button', { name: 'Mager 1/1' })).toBeDisabled();
    choose(0, 'Remove');
    expect(screen.getByRole('button', { name: 'Mager 0/1' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Mager 0/1' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Mager 0/1' }));
    fireEvent.change(waveField(), { target: { value: '35' } });
    expect(screen.getByRole('button', { name: 'Mager 0/1' })).toHaveAttribute('aria-pressed', 'false');
  });
  it('replaces a placed kind with an unplaced kind and returns the old kind to the choices', () => {
    const host = setupArena();
    choose(0, 'Mager');
    choose(0, 'Ranger');
    expect(slot(0)).toHaveTextContent('Ranger');
    fireEvent.click(slot(1));
    expect(
      within(screen.getByRole('dialog', { name: 'Monster at West' }))
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Mager', 'Bat']);
    expect(host.config().infernoSpawnLayout).toBe('52:r--------');
  });
  it('removing from a complete layout leaves the rest placed and the removed one random', () => {
    const host = setupArena({ infernoSpawnLayout: '52:grb-----b' });
    choose(0, 'Remove');
    expect(host.config()[INFERNO_SPAWN_LAYOUT_KEY]).toBe('52:-rb-----b');
    expect(screen.getByRole('status')).toHaveTextContent('Custom, rest random');
    choose(6, 'Mager');
    expect(host.config()[INFERNO_SPAWN_LAYOUT_KEY]).toBe('52:-rb---g-b');
  });
  it('keeps a partial layout across remounts as the saved layout', () => {
    const host = setupArena();
    choose(0, 'Mager');
    host.reopen();
    expect(screen.queryByTestId('arena-map')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Edit layout / }));
    expect(slot(0)).toHaveTextContent('Mager');
    expect(host.config()[INFERNO_SPAWN_LAYOUT_KEY]).toBe('52:g--------');
    fireEvent.click(screen.getByRole('button', { name: 'Clear spawns' }));
    host.reopen();
    fireEvent.click(screen.getByRole('button', { name: /^Edit layout / }));
    expect(slot(0)).toBeEmptyDOMElement();
  });
  it('a custom layout belongs only to its own wave', () => {
    const host = setup({ infernoSpawnLayout: '52:grb-----b' });
    fireEvent.change(waveField(), { target: { value: '35' } });
    expect(screen.getByText('Random')).toBeVisible();
    expect(host.config().infernoSpawnLayout).toBe('52:grb-----b');
    fireEvent.change(waveField(), { target: { value: '52' } });
    expect(screen.getByText('Custom')).toBeVisible();
  });
  it('dismisses its local picker on outside press and does not open another editor', () => {
    setupArena();
    fireEvent.click(slot(0));
    expect(screen.getByRole('dialog', { name: 'Monster at North-west' })).toBeVisible();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Monster at North-west' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Wave 52 layout' })).toBeVisible();
  });
  it('swaps specific placed monsters in two taps without making a complete layout random', () => {
    const host = setupArena({ infernoSpawnLayout: '52:grb-----b' });
    choose(0, 'Swap with North-east Bat');
    expect(host.config().infernoSpawnLayout).toBe('52:brb-----g');
    expect(slot(0)).toHaveTextContent('Bat');
    expect(slot(8)).toHaveTextContent('Mager');
    expect(screen.getByRole('status')).toHaveTextContent('Custom');
  });
});

describe('terrain and player share the same map', () => {
  it('uses actual NPC sizes while empty spots retain the maximum footprint', () => {
    setupArena({ infernoStartWave: '62', infernoSpawnLayout: '62:grmlbb---' });
    const tile = Number(document.querySelector<HTMLElement>('.spawn-map__plane')!.dataset.tileSize);
    for (const [index, size] of [4, 3, 4, 3, 2, 2, 4, 4, 4].entries()) {
      expect(parseFloat(slot(index).style.width)).toBe(size * tile);
      expect(parseFloat(slot(index).style.height)).toBe(size * tile);
    }
  });
  it('resolves overlapping 44px hit areas by drawn footprint, not DOM stacking order', () => {
    const pillar = { left: 16, top: 72, width: 24, height: 24 };
    const westSlot = { left: 40, top: 80, width: 32, height: 32 };
    expect(nearestMapTarget(41, 85, [westSlot, pillar])).toBe(0);
    expect(nearestMapTarget(38, 84, [westSlot, pillar])).toBe(1);
    expect(nearestMapTarget(50, 75, [westSlot, pillar])).toBe(0);
    expect(nearestMapTarget(41, 85, [pillar, westSlot])).toBe(1);
    expect(nearestMapTarget(200, 200, [westSlot, pillar])).toBeNull();
    const southSlot = { left: 56, top: 176, width: 32, height: 32 };
    const southPillar = { left: 96, top: 184, width: 24, height: 24 };
    expect(nearestMapTarget(90, 192, [southSlot, southPillar])).toBe(0);
    expect(nearestMapTarget(94, 192, [southSlot, southPillar])).toBe(1);
  });
  it('selects a bat from the empty NE part of its maximum spot without moving You', () => {
    const host = setupArena({ infernoSpawnLayout: '52:grb-----b' });
    const map = screen.getByTestId('arena-map');
    const plane = map.querySelector('.spawn-map__plane')!;
    const hit = slot(2).closest<HTMLElement>('[data-spawn-hit]')!;
    expect(hit).toHaveClass('has-small-npc');
    expect(hit.style.width).toBe('32px');
    expect(slot(2).style.width).toBe('16px');
    vi.spyOn(plane, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      right: 264,
      bottom: 272,
      width: 264,
      height: 272,
    } as DOMRect);
    vi.spyOn(hit, 'getBoundingClientRect').mockReturnValue({
      left: 24,
      top: 216,
      right: 56,
      bottom: 248,
      width: 32,
      height: 32,
    } as DOMRect);
    fireEvent.click(map, { clientX: 54, clientY: 218 });
    expect(screen.getByRole('dialog', { name: 'Monster at South-west' })).toBeVisible();
    expect(screen.getByText('South-west spot')).toBeVisible();
    expect(host.changed).not.toHaveBeenCalled();
  });
  it('summarizes pillar counts without widening copy and keeps tools mounted while disabled', () => {
    setupArena({ infernoSpawnLayout: '52:grb-----b' });
    expect(screen.getByRole('button', { name: 'Reset start' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'West pillar' }));
    expect(screen.getByRole('status')).toHaveTextContent('Custom · 1 pillar down');
    fireEvent.click(screen.getByRole('button', { name: 'South pillar' }));
    expect(screen.getByRole('status')).toHaveTextContent('Custom · 2 pillars down');
    fireEvent.click(screen.getByRole('button', { name: 'North-east pillar' }));
    floor([25, 39]);
    expect(screen.getByRole('status')).toHaveTextContent('Custom · All pillars down · Moved start');
    fireEvent.click(screen.getByRole('button', { name: 'Clear spawns' }));
    expect(screen.getByRole('button', { name: 'Clear spawns' })).toBeDisabled();
  });
  it('wave 66 keeps all three pillar toggles functioning, preserving the other fields', () => {
    const host = setupArena({ infernoStartWave: '66' });
    expect(document.querySelectorAll('[data-pillar]')).toHaveLength(3);
    for (const [key, name] of [
      ['west', 'West'],
      ['south', 'South'],
      ['northEast', 'North-east'],
    ] as const) {
      const pillar = screen.getByRole('button', { name: `${name} pillar` });
      expect(pillar).toBeEnabled();
      fireEvent.click(pillar);
      expect(host.config()[INFERNO_DESTROYED_PILLAR_KEYS[key]]).toBe(true);
      expect(pillar).toHaveTextContent('Down');
      fireEvent.click(pillar);
      expect(host.config()[INFERNO_DESTROYED_PILLAR_KEYS[key]]).toBe(false);
    }
    expect(host.config().infernoStartWave).toBe('66');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('moves by tapping floor and resets without selecting a mode', () => {
    const host = setupArena();
    floor([25, 39]);
    expect(host.config().infernoStartTile).toBe('25,39');
    expect(screen.getByRole('img', { name: 'Your start: 25, 39. Tap floor to move.' })).toBeVisible();
    expect(screen.getByText('You')).toBeVisible();
    expect(screen.getByRole('button', { name: /^Edit layout / })).toHaveTextContent('Moved start');
    fireEvent.click(screen.getByRole('button', { name: 'Reset start' }));
    expect(host.config().infernoStartTile).toBe('');
    expect(screen.getByRole('button', { name: 'Reset start' })).toBeDisabled();
  });
  it.each([
    [17, 37],
    [34, 39],
    [16, 40],
    [46, 40],
    [15, 44],
    [47, 44],
    [30, 48],
    [30, 15],
  ] as Coordinate[])('rejects blocked or out-of-bounds floor %s,%s', (x, y) => {
    const host = setupArena();
    floor([x, y]);
    expect(host.changed).not.toHaveBeenCalled();
  });
  it.each([1])('keeps wave %s start fixed', (wave) => {
    const host = setupArena({ infernoStartWave: String(wave) });
    floor([25, 39]);
    expect(host.changed).not.toHaveBeenCalled();
    expect(screen.getByRole('img', { name: /Your start:.*\(fixed\)/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Reset start' })).toBeDisabled();
  });
  it.each([3, 8, 17, 34])('wave %s has nibblers and no spawn spots', (wave) => {
    setupArena({ infernoStartWave: String(wave) });
    expect(document.querySelectorAll('[data-spawn-slot]')).toHaveLength(0);
    expect(screen.getByRole('status')).toHaveTextContent('Only nibblers this wave');
    expect(screen.getAllByText('Only nibblers this wave')).toHaveLength(1);
    expect(screen.getByText('Clear spawns')).not.toBeVisible();
    expect(screen.getByRole('button', { name: 'West pillar' })).toBeEnabled();
  });
  it.each([67, 68])('wave %s has fixed spawns and former pillar footprints are selectable floor', (wave) => {
    const pillarSettings = {
      infernoWestPillarDestroyed: false,
      infernoSouthPillarDestroyed: true,
      infernoNorthEastPillarDestroyed: false,
    };
    const host = setupArena({ infernoStartWave: String(wave), ...pillarSettings });
    expect(screen.getAllByText('Jad spawns are fixed')).toHaveLength(1);
    expect(screen.getByText('Clear spawns')).not.toBeVisible();
    expect(document.querySelectorAll('[data-spawn-slot]')).toHaveLength(0);
    expect(document.querySelectorAll('.spawn-map__pillar,[data-pillar]')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: / pillar$/ })).toHaveLength(0);
    for (const [x, y] of [
      [18, 38],
      [28, 24],
      [35, 40],
    ] as Coordinate[]) {
      floor([x, y]);
      expect(host.config().infernoStartTile).toBe(`${x},${y}`);
      expect(screen.getByRole('img', { name: `Your start: ${x}, ${y}. Tap floor to move.` })).toBeVisible();
      expect(host.config()).toMatchObject(pillarSettings);
    }
    expect(host.changed).toHaveBeenCalledTimes(3);
  });
  it('retains true 3×3 pillar and 1×1 player dimensions', () => {
    setupArena();
    const pillar = screen.getByRole('button', { name: 'West pillar' });
    const player = screen.getByRole('img', { name: /^Your start/ });
    expect(parseFloat(pillar.style.width) / parseFloat(player.style.width)).toBeCloseTo(3);
    expect(parseFloat(pillar.style.height) / parseFloat(player.style.height)).toBeCloseTo(3);
    expect(parseFloat(pillar.style.left)).toBe(16);
    expect(screen.getByTestId('arena-map').style.aspectRatio).toBe('33 / 34');
    const underlay = document.querySelector<HTMLImageElement>('.spawn-map__terrain')!;
    expect(underlay.getAttribute('src')).toBe(INFERNO_ARENA_MAP_IMAGE.url);
    expect(underlay).toHaveAttribute('width', '264');
    expect(underlay).toHaveAttribute('height', '272');
    expect(pillar.querySelector('svg')).toBeNull();
    const standingBox = pillar.getAttribute('style');
    fireEvent.click(pillar);
    expect(pillar).toHaveTextContent('Down');
    expect(pillar).toHaveClass('is-down');
    expect(pillar.getAttribute('style')).toBe(standingBox);
  });
  it('draws a one-tile grid only over the playable floor beneath every marker', () => {
    setupArena();
    const grid = document.querySelector<SVGSVGElement>('.spawn-map__grid')!;
    expect(grid).toHaveAttribute('viewBox', '0 0 29 30');
    expect(grid).toHaveAttribute('shape-rendering', 'crispEdges');
    expect(grid).toHaveAttribute('aria-hidden', 'true');
    expect(parseFloat(grid.style.left)).toBe(16);
    expect(parseFloat(grid.style.top)).toBe(16);
    expect(parseFloat(grid.style.width)).toBe(29 * 8);
    expect(parseFloat(grid.style.height)).toBe(30 * 8);
    const path = grid.querySelector('path')!;
    expect(path).toHaveAttribute('vector-effect', 'non-scaling-stroke');
    expect(path.getAttribute('d')?.match(/M/g)).toHaveLength(61);
    expect(path.getAttribute('d')).toContain('M29 0V30');
    expect(path.getAttribute('d')).toContain('M0 30H29');
    expect(grid.previousElementSibling).toHaveClass('spawn-map__terrain-wash');
    expect(grid.nextElementSibling).toHaveAttribute('data-spawn-hit', '0');
  });
  it.each([
    [17, 46],
    [45, 17],
  ] as Coordinate[])('keeps playable edge tile %s,%s aligned inside the decorative margin', (x, y) => {
    const host = setupArena();
    floor([x, y]);
    expect(host.config().infernoStartTile).toBe(`${x},${y}`);
  });
  it('disables the fixed Zuk setup disclosure, not waves with editable tiles or pillars', () => {
    setup({}, { run: runFor() });
    const entry = () => screen.getByRole('button', { name: /^Edit layout / });
    fireEvent.click(entry());
    expect(screen.getByTestId('arena-map')).toBeVisible();
    fireEvent.change(waveField(), { target: { value: '69' } });
    expect(entry()).toBeDisabled();
    expect(screen.getByText('Fixed', { exact: true })).toBeVisible();
    expect(screen.queryByTestId('arena-map')).toBeNull();
    fireEvent.click(entry());
    expect(screen.queryByTestId('arena-map')).toBeNull();
    for (const wave of [3, 8, 17, 34, 67, 68]) {
      fireEvent.change(waveField(), { target: { value: String(wave) } });
      expect(entry()).toBeEnabled();
    }
  });
});

describe('immediate copy, without share or paste UI', () => {
  function clipboard() {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    return writeText;
  }
  it('copies a complete setup with gear by default, preserving the auto-start link contract', async () => {
    const write = clipboard();
    const exportGear = vi.fn(() => 'gear');
    setup({ infernoSpawnLayout: '52:grb-----b', infernoStartTile: '25,39' }, { exportGear });
    expect(screen.getByRole('checkbox', { name: 'Include gear' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Link auto-starts')).toBeVisible();
    expect(exportGear).not.toHaveBeenCalled();
    fireEvent.click(copyButton());
    await waitFor(() => expect(copyButton()).toHaveTextContent('Copied'));
    expect(exportGear).toHaveBeenCalledOnce();
    const params = new URL(write.mock.calls[0][0]).searchParams;
    expect(params.get('setup')).toBe('gear');
    const parsed = parseInfernoSetupParams(params);
    expect(parsed.ok && parsed.setup?.layout).toEqual(parseSpawnLayout('52:grb-----b'));
    expect(parsed.ok && parsed.setup?.startTile).toEqual([25, 39]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('omits gear when unchecked so the link opens setup, and exports only on copy', async () => {
    const write = clipboard();
    const exportGear = vi.fn(() => 'portable-gear');
    setup({}, { exportGear });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include gear' }));
    expect(screen.getByText('Link opens setup')).toBeVisible();
    expect(exportGear).not.toHaveBeenCalled();
    fireEvent.click(copyButton());
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(new URL(write.mock.calls[0][0]).searchParams.has('setup')).toBe(false);
    expect(exportGear).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include gear' }));
    expect(screen.getByText('Link auto-starts')).toBeVisible();
    fireEvent.click(copyButton());
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    expect(new URL(write.mock.calls[1][0]).searchParams.get('setup')).toBe('portable-gear');
    expect(exportGear).toHaveBeenCalledOnce();
  });
  it('copies a partial layout as it is, and random once cleared', async () => {
    const write = clipboard();
    setupArena();
    choose(0, 'Mager');
    expect(copyButton()).not.toHaveAttribute('aria-disabled');
    fireEvent.click(copyButton());
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    const partial = parseInfernoSetupParams(new URL(write.mock.calls[0][0]).searchParams);
    expect(partial.ok && partial.setup?.layout).toEqual(parseSpawnLayout('52:g--------'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear spawns' }));
    fireEvent.click(copyButton());
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    const random = parseInfernoSetupParams(new URL(write.mock.calls[1][0]).searchParams);
    expect(random.ok && random.setup?.layout).toBeNull();
  });
  it('seeds a local tool draft from the spawned wave and copies it without saving merely on open or copy', async () => {
    const write = clipboard();
    const exportGear = vi.fn(() => 'portable-gear');
    const currentSetup = {
      infernoStartWave: '6',
      infernoSpawnLayout: '6:-b-l----b',
      infernoWestPillarDestroyed: true,
      infernoStartTile: '25,39',
    };
    const run = runFor(6, { currentSetup });
    const host = setup({ infernoStartWave: '52' }, { surface: 'practice', run, exportGear, tool: true });
    expect(copyButton()).toHaveTextContent('Copy link');
    expect(waveField()).toHaveValue(6);
    expect(slot(1)).toHaveTextContent('Bat');
    expect(slot(3)).toHaveTextContent('Blob');
    expect(slot(8)).toHaveTextContent('Bat');
    expect(screen.getByRole('button', { name: 'West pillar' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('img', { name: 'Your start: 25, 39. Tap floor to move.' })).toBeVisible();
    expect(host.config().infernoStartWave).toBe('52');
    fireEvent.click(copyButton());
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(write.mock.calls[0][0]).toBe(
      buildInfernoSetupUrl(
        window.location.origin,
        {
          startWave: 6,
          layout: parseSpawnLayout('6:-b-l----b'),
          destroyedPillars: { west: true, south: false, northEast: false },
          startTile: [25, 39],
        },
        'portable-gear',
      ),
    );
    expect(exportGear).toHaveBeenCalledOnce();
    expect(host.changed).not.toHaveBeenCalled();
    expect(run.execute).not.toHaveBeenCalled();
    expect(screen.getByRole('checkbox', { name: 'Include gear' })).toHaveAttribute('aria-checked', 'true');
  });
  it('Practice can omit gear from the current-wave link without changing the wave being shared', async () => {
    const write = clipboard();
    const exportGear = vi.fn(() => 'portable-gear');
    const currentSetup = { infernoStartWave: '6', infernoSpawnLayout: '6:-b-l----b', infernoStartTile: '25,39' };
    const wave = {
      startWave: 6,
      layout: parseSpawnLayout('6:-b-l----b'),
      destroyedPillars: { west: false, south: false, northEast: false },
      startTile: [25, 39] as Coordinate,
    };
    setup(
      { infernoStartWave: '52' },
      { surface: 'practice', run: runFor(6, { currentSetup }), exportGear, tool: true },
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include gear' }));
    expect(exportGear).not.toHaveBeenCalled();
    fireEvent.click(copyButton());
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(write.mock.calls[0][0]).toBe(buildInfernoSetupUrl(window.location.origin, wave));
    expect(new URL(write.mock.calls[0][0]).searchParams.has('setup')).toBe(false);
    expect(exportGear).not.toHaveBeenCalled();
  });
  it('copies edits rather than the fight seed, a partial layout and a cleared random one included', async () => {
    const write = clipboard();
    const currentSetup = { infernoStartWave: '6', infernoSpawnLayout: '6:-b-l----b', infernoStartTile: '25,39' };
    const host = setup({ infernoStartWave: '52' }, { run: runFor(6, { currentSetup }), tool: true });
    const copied = (call: number) => parseInfernoSetupParams(new URL(write.mock.calls[call][0]).searchParams);
    choose(1, 'Remove');
    expect(host.config().infernoStartWave).toBe('6');
    fireEvent.click(copyButton());
    await waitFor(() => expect(write).toHaveBeenCalledOnce());
    const partial = copied(0);
    expect(partial.ok && partial.setup?.layout).toEqual(parseSpawnLayout('6:---l----b'));
    choose(0, 'Bat');
    fireEvent.click(screen.getByRole('button', { name: 'South pillar' }));
    floor([33, 44]);
    fireEvent.click(copyButton());
    await waitFor(() => expect(write).toHaveBeenCalledTimes(2));
    const parsed = copied(1);
    expect(parsed.ok && parsed.setup?.layout).toEqual(parseSpawnLayout('6:b--l----b'));
    expect(parsed.ok && parsed.setup?.destroyedPillars.south).toBe(true);
    expect(parsed.ok && parsed.setup?.startTile).toEqual([33, 44]);
    fireEvent.click(screen.getByRole('button', { name: 'Clear spawns' }));
    fireEvent.click(copyButton());
    await waitFor(() => expect(write).toHaveBeenCalledTimes(3));
    const random = copied(2);
    expect(random.ok && random.setup?.layout).toBeNull();
  });
  it('Practice offers no gear choice when the host has no loadout to export', () => {
    setup({}, { surface: 'practice', run: runFor(6), tool: true });
    expect(screen.queryByRole('checkbox', { name: 'Include gear' })).toBeNull();
    expect(copyButton()).toBeInTheDocument();
  });
  it('falls back to the saved setup before a wave has spawned', () => {
    const write = clipboard();
    setup({}, { surface: 'practice', run: runFor(), tool: true });
    fireEvent.click(copyButton());
    expect(write).toHaveBeenCalledOnce();
  });
  it('handles clipboard failure without a dialog, paste field or false success', async () => {
    const write = clipboard();
    write.mockRejectedValue(new Error('blocked'));
    setup();
    fireEvent.click(copyButton());
    await waitFor(() => expect(copyButton()).toHaveTextContent('Try again'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('retains the link boot notice until dismissed', () => {
    showInfernoSetupLinkNotice({ tone: 'success', message: 'Wave link loaded.' });
    setup();
    expect(screen.getByText('Wave link loaded.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Wave link loaded.')).toBeNull();
  });
  it('offers the link notice Undo at the end of its sentence, only while the link has one', () => {
    const undo = vi.fn(() => dismissInfernoSetupLinkNotice());
    showInfernoSetupLinkNotice({ tone: 'success', message: 'Start wave 52 loaded from link.', undo });
    setup();
    const notice = document.querySelector<HTMLElement>('.inferno-link-notice') as HTMLElement;
    expect(notice).toHaveTextContent('Start wave 52 loaded from link. Undo');
    fireEvent.click(within(notice).getByRole('button', { name: 'Undo' }));
    expect(undo).toHaveBeenCalledOnce();
    expect(screen.queryByText('Start wave 52 loaded from link.')).toBeNull();
    act(() => showInfernoSetupLinkNotice({ tone: 'error', message: 'The link does not say which wave to start on.' }));
    expect(screen.getByText('The link does not say which wave to start on.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});

describe('Practice hosts and the separate layout tool', () => {
  it('opening and closing do not save the spawned seed; Start commits it before executing', () => {
    const currentSetup = { infernoStartWave: '6', infernoSpawnLayout: '6:-b-l----b', infernoStartTile: '25,39' };
    const run = runFor(6, { currentSetup });
    const host = setup({ infernoStartWave: '52' }, { run, tool: true, surface: 'practice' });
    expect(host.changed).not.toHaveBeenCalled();
    host.closeTool();
    expect(host.config().infernoStartWave).toBe('52');
    expect(host.changed).not.toHaveBeenCalled();
    host.openTool();
    fireEvent.click(screen.getByRole('button', { name: 'Start wave 6' }));
    expect(host.config()).toMatchObject(currentSetup);
    expect(run.execute).toHaveBeenCalledExactlyOnceWith({ encounter: 'inferno', type: 'go-to-wave', wave: 6 });
    expect(host.changed.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(run.execute).mock.invocationCallOrder[0]);
  });
  it('notes the random rest only for partial layouts, including after removing from a complete layout', () => {
    setup({}, { surface: 'practice', run: runFor(), tool: true });
    const warning = 'Unplaced monsters spawn at random.';
    const caption = 'Pick a monster above, then tap its spots.';
    expect(screen.queryByText(warning)).toBeNull();
    expect(screen.getByText(caption)).toBeVisible();
    choose(0, 'Mager');
    expect(screen.getByText(warning)).toHaveClass('inferno-arena__caption');
    expect(screen.queryByText(caption)).toBeNull();
    choose(1, 'Ranger');
    choose(2, 'Bat');
    choose(8, 'Bat');
    expect(screen.queryByText(warning)).toBeNull();
    expect(screen.getByText(caption)).toBeVisible();
    choose(0, 'Remove');
    expect(screen.getByText(warning)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Clear spawns' }));
    expect(screen.queryByText(warning)).toBeNull();
    expect(screen.getByText(caption)).toBeVisible();
  });
  it('Close never starts, while Start starts a partial layout, the rest at random', () => {
    const run = runFor();
    const host = setup({}, { surface: 'practice', run });
    host.openTool();
    choose(0, 'Mager');
    const start = screen.getByRole('button', { name: 'Start wave 52' });
    expect(start).toBeEnabled();
    host.closeTool();
    expect(run.execute).not.toHaveBeenCalled();
    host.openTool();
    fireEvent.click(screen.getByRole('button', { name: 'Start wave 52' }));
    expect(run.execute).toHaveBeenCalledExactlyOnceWith({ encounter: 'inferno', type: 'go-to-wave', wave: 52 });
    expect(host.config().infernoSpawnLayout).toBe('52:g--------');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  function pane(overrides: Partial<PracticePaneProps> = {}) {
    const engine = new SimulationEngine({ encounter: new InfernoEncounter() });
    const controls = encounterControlsForKind('inferno');
    const execute = vi.fn();
    const restart = vi.fn();
    render(
      <PracticePane
        tab="setup"
        onTabChange={vi.fn()}
        replaying={false}
        engine={engine}
        simulationState={engine.getState()}
        mechanicsConfig={engine.getMechanicsConfig()}
        onMechanicsConfigChange={vi.fn()}
        onSetBossHp={vi.fn()}
        onExecuteEncounterCommand={execute}
        onRestart={restart}
        practice={{
          bossNpc: undefined,
          bossHpPresets: controls?.bossHpPresets ?? [],
          inFightMechanicsToggles: controls?.mechanicsToggles ?? [],
          optionsExpanded: false,
          setOptionsExpanded: vi.fn(),
          hasPracticeControls: true,
        }}
        {...overrides}
      />,
    );
    return { execute, restart };
  }
  it('keeps wave navigation and restart in Practice without layout or share controls', () => {
    const { execute, restart } = pane();
    expect(screen.queryByRole('button', { name: 'Arena' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy.*link|Edit layout/ })).toBeNull();
    const button = screen.getByRole('button', { name: 'Restart fight' });
    expect(button.closest('.practice-footer')).not.toBeNull();
    fireEvent.click(button);
    expect(restart).toHaveBeenCalledOnce();
    shortcuts();
    fireEvent.click(screen.getByRole('button', { name: 'Mager, wave 35' }));
    expect(execute).toHaveBeenCalledExactlyOnceWith({ encounter: 'inferno', type: 'go-to-wave', wave: 35 });
  });
  it('keeps setup and restart unavailable during replay', () => {
    pane({ replaying: true });
    expect(screen.queryByLabelText('Start wave')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Restart fight' })).toBeNull();
  });
  it('filters owned controls out of generic settings without duplicating pillars', () => {
    const controls = encounterSetupControlsForKind('inferno');
    expect(controls?.keys).toEqual(INFERNO_SETUP_KEYS);
    render(
      <MechanicsSettings
        config={{ infiniteHealth: false, infernoStartWave: '9' }}
        onConfigChange={vi.fn()}
        mechanicsToggles={buildInfernoControls().mechanicsToggles}
        debugActions={[]}
        setupControls={controls}
      />,
    );
    expect(screen.queryByLabelText('Start wave')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Pillar/ })).toBeNull();
  });
  it.each([35, 67, 68, 69])('Practice options follow current stage %s, not saved start wave', (stage) => {
    render(
      <MechanicsSettings
        variant="practice"
        config={{ infiniteHealth: true, infernoStartWave: stage === 69 ? '35' : '69', zukSetTimer: true }}
        onConfigChange={vi.fn()}
        mechanicsToggles={buildInfernoControls().mechanicsToggles}
        debugActions={[]}
        optionsExpanded
        setupControls={encounterSetupControlsForKind('inferno')}
        setupRun={runFor(stage)}
      />,
    );
    if (stage === 69)
      expect(screen.getByRole('checkbox', { name: 'Set Timer' })).toHaveAttribute('aria-checked', 'true');
    else expect(screen.queryByRole('checkbox', { name: 'Set Timer' })).toBeNull();
  });
  it.each([35, 69])('mobile keeps its existing session, wave and Zuk pages for current wave %s', (stage) => {
    const engine = new SimulationEngine({ encounter: new InfernoEncounter() });
    engine.setMechanicsConfig({ infiniteHealth: false, infernoStartWave: String(stage) });
    const state = engine.getState();
    const controls = encounterControlsForKind('inferno')!;
    const execute = vi.fn();
    const held: boolean[] = [];
    render(
      <MobilePracticeControls
        simulationState={state}
        engine={engine}
        mechanicsConfig={{ ...engine.getMechanicsConfig(), infernoStartWave: '9' }}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={controls.mechanicsToggles}
        debugActions={controls.debugActions}
        onExecuteEncounterCommand={execute}
        onEncounterToolOpenChange={(open) => held.push(open)}
        exportEncounterGear={() => 'gear'}
        onSetBossHp={vi.fn()}
        onRestart={vi.fn()}
        encounterSession={encounterPracticeSession(state.encounter, execute)}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to Practice' }));
    const layoutEntry = screen.getByRole('button', { name: 'Edit layout' });
    if (stage === 69) expect(layoutEntry).toBeDisabled();
    else {
      fireEvent.click(layoutEntry);
      expect(screen.getByRole('dialog', { name: 'Edit layout' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'West pillar' })).toBeEnabled();
      // The host's loadout export reaches the tool, so its link can carry gear.
      expect(
        within(screen.getByRole('dialog', { name: 'Edit layout' })).getByRole('checkbox', { name: 'Include gear' }),
      ).toBeVisible();
      expect(held).toEqual([true]);
      fireEvent.click(screen.getByRole('button', { name: 'Close Edit layout' }));
    }
    // The editor holds the fight only while it is open (never on wave 69, where it cannot open).
    expect(held).toEqual(stage === 69 ? [] : [true, false]);
    expect(screen.queryByRole('button', { name: 'TzKal-Zuk' }) !== null).toBe(stage === 69);
    fireEvent.click(screen.getByRole('button', { name: 'Start wave' }));
    expect(waveField()).toHaveValue(9);
    expect(screen.queryByRole('button', { name: 'Arena' })).toBeNull();
    shortcuts();
    fireEvent.click(screen.getByRole('button', { name: 'Mager and ranger, wave 50' }));
    expect(execute).toHaveBeenCalledExactlyOnceWith({ encounter: 'inferno', type: 'go-to-wave', wave: 50 });
  });
});

describe('Inferno setup copy stays in the pixel fonts', () => {
  // Intersection of getBestCmap() for all five public/fonts/RuneScape-*.ttf faces:
  // Bold 12, Plain 12, Plain 11, Quill 8 and Small. ASCII and Latin-1 are complete;
  // only the euro sign is common beyond them. Curly quotes and en dashes fall back.
  const commonGlyph = /^[\x20-\x7e\u00a0-\u00ff\u20ac]$/u;
  function expectCoveredText() {
    const roots = document.querySelectorAll('.inferno-setup,.inferno-layout-tool,.spawn-picker,[role="tooltip"]');
    const text = [...roots]
      .map((root) =>
        [
          root.textContent,
          ...[...root.querySelectorAll('[aria-label]')].map((node) => node.getAttribute('aria-label')),
        ].join(' '),
      )
      .join(' ');
    expect([...new Set(text)].filter((char) => !/\s/u.test(char) && !commonGlyph.test(char))).toEqual([]);
  }
  it.each(['rail', 'practice'] as const)('covers random, fixed and editable wave copy in %s', (surface) => {
    setup({}, { surface, run: runFor(), tool: surface === 'practice' });
    for (const wave of [1, 3, 52, 67, 68, 69]) {
      fireEvent.change(waveField(), { target: { value: String(wave) } });
      if (surface === 'rail' && wave !== 69 && !screen.queryByTestId('arena-map'))
        fireEvent.click(screen.getByRole('button', { name: /^Edit layout / }));
      expectCoveredText();
    }
  });
  it('covers custom, partial, pillar, start and swap-picker copy', () => {
    setupArena({ infernoSpawnLayout: '52:grb-----b' });
    fireEvent.click(screen.getByRole('button', { name: 'West pillar' }));
    floor([25, 39]);
    fireEvent.click(slot(0));
    expectCoveredText();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expectCoveredText();
    shortcuts();
    expectCoveredText();
  });
  it('covers the partial-layout workbench caption and start-wave hint', async () => {
    setup({}, { surface: 'practice', run: runFor(), tool: true });
    choose(0, 'Mager');
    expect(screen.getByText('Unplaced monsters spawn at random.')).toBeVisible();
    expectCoveredText();
    fireEvent.click(screen.getByRole('button', { name: 'About Start wave' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'The wave this layout is for. Changing it saves the start wave. Start wave applies your setup; unplaced monsters spawn at random.',
    );
    expectCoveredText();
  });
  it('covers the edited-setup copy hint and gear consequence', async () => {
    const run = runFor(52, { currentSetup: { infernoStartWave: '52' } });
    setup({}, { surface: 'practice', run, exportGear: () => 'gear', tool: true });
    fireEvent.pointerEnter(copyButton(), { pointerType: 'mouse' });
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Shares the edited wave 52 setup. Opening the link starts it with your gear.',
    );
    expectCoveredText();
    fireEvent.pointerLeave(copyButton(), { pointerType: 'mouse' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Include gear' }));
    fireEvent.pointerEnter(copyButton(), { pointerType: 'mouse' });
    await waitFor(() =>
      expect(screen.getByRole('tooltip')).toHaveTextContent(
        'Shares the edited wave 52 setup. Opening the link shows setup without gear.',
      ),
    );
    expectCoveredText();
  });
});
