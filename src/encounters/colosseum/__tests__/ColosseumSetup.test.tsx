// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MobilePracticeControls } from '../../../components/MobilePracticeControls';
import type { EncounterSnapshot } from '../../../core/encounters/snapshot';
import { SimulationEngine } from '../../../core/SimulationEngine';
import type { Coordinate, MechanicsConfig } from '../../../types/simulation';
import { encounterControlsForKind } from '../../modules';
import {
  type EncounterSetupRun,
  encounterCurrentSetup,
  encounterInfobox,
  encounterSetupControlsForKind,
  encounterSetupStage,
  encounterSetupStartedWith,
  encounterToolFor,
} from '../../practiceChrome';
import {
  COLOSSEUM_SPAWN_LAYOUT_KEY,
  COLOSSEUM_START_TILE_KEY,
  COLOSSEUM_START_WAVE_KEY,
  colosseumRunSetupKey,
  resolveColosseumRunSetup,
  resolveColosseumSpawnLayout,
} from '../../solHeredit/controls';
import { SolHereditEncounter } from '../../solHeredit/SolHereditEncounter';
import { ColosseumLayoutTool } from '../ColosseumLayoutTool';
import { colosseumSetupSummary } from '../ColosseumSetup';
import { colosseumLayoutWarningText } from '../ColosseumSpawnSetup';
import { colosseumOwnedModifiers, colosseumWaveText } from '../runChrome';
import type { ColosseumRunPublicState, ColosseumRunSetupState } from '../waves/snapshot';
import { colosseumSpawnLayoutWarnings } from '../waves/spawnLayout';

const controls = encounterSetupControlsForKind('sol_heredit');
if (!controls) throw new Error('Expected the Colosseum setup control');

function renderSetup(startWave: string | undefined, surface: 'rail' | 'practice' = 'rail', startedWith?: string) {
  const onChange = vi.fn<(config: MechanicsConfig) => void>();
  const config = mechanics(startWave);
  render(
    <div>
      {controls?.render({
        config,
        onChange,
        surface,
        run: startedWith === undefined ? undefined : { stage: 4, startedWith, execute: vi.fn() },
      })}
    </div>,
  );
  return { onChange, field: screen.getByLabelText('Start wave') as HTMLInputElement };
}

/** A saved setup with only the start wave set, as the configurer holds it before any other choice. */
const mechanics = (startWave?: string): MechanicsConfig => ({
  infiniteHealth: false,
  ...(startWave === undefined ? {} : { [COLOSSEUM_START_WAVE_KEY]: startWave }),
});

const run = (overrides: Partial<ColosseumRunPublicState>): ColosseumRunPublicState => ({
  startWave: 4,
  wave: 6,
  stage: 'wave',
  waveStartTick: 400,
  waveCompletedTick: null,
  reinforcementTick: 466,
  solControlTick: null,
  offer: null,
  picks: [],
  ...overrides,
});
const snapshot = (state: object) => ({ kind: 'sol_heredit', state, visuals: {} }) as unknown as EncounterSnapshot;
const setupState = (overrides: Partial<ColosseumRunSetupState>): ColosseumRunSetupState => ({
  startSpawnLayout: '',
  startPlayerTile: '23,38',
  waveSpawnLayout: '',
  waveStartPlayerTile: null,
  ...overrides,
});

describe('Colosseum start wave', () => {
  afterEach(cleanup);

  it('owns the start-wave key, so the generic list draws no row for it', () => {
    expect(controls.keys).toEqual([COLOSSEUM_START_WAVE_KEY]);
  });

  it('defaults to wave 12, the direct Sol fight with the preset modifiers', () => {
    const { field } = renderSetup(undefined);
    expect(field.value).toBe('12');
    expect(screen.getByText('Sol Heredit.')).toBeTruthy();
    expect(colosseumSetupSummary(mechanics(), { blasphemy: 3 })).toBe('Sol Heredit · 1 modifier');
  });

  it('saves a typed wave as the mechanics key, clamped to 1-12', () => {
    const { onChange, field } = renderSetup('12');
    fireEvent.change(field, { target: { value: '5' } });
    expect(onChange).toHaveBeenLastCalledWith(mechanics('5'));
    fireEvent.change(field, { target: { value: '40' } });
    expect(onChange).toHaveBeenLastCalledWith(mechanics('12'));
  });

  it('says what an earlier wave spawns and that the run starts with the modifiers below', () => {
    renderSetup('5');
    expect(screen.getByText(colosseumWaveText(5))).toBeTruthy();
    expect(colosseumWaveText(5)).toBe(
      'Fremennik warband, 1 serpent shaman, 1 javelin colossus, 1 manticore. Reinforced by 1 jaguar warrior, 1 serpent shaman.',
    );
    expect(
      screen.getByText(
        'Starts with the modifiers below and offers another before each wave, through to Sol Heredit at wave 12.',
      ),
    ).toBeTruthy();
    expect(colosseumSetupSummary(mechanics('5'), { blasphemy: 2, doom: 1 })).toBe('Waves 5–12 · 2 modifiers');
    expect(colosseumSetupSummary(mechanics('1'), {})).toBe('Waves 1–12 · No modifiers');
  });

  it('in Practice, says a changed start waits for a restart', () => {
    renderSetup('3', 'practice', '4');
    expect(screen.getByRole('status').textContent).toBe('Setup saved. Restart the fight to start wave 3 with it.');
    cleanup();
    renderSetup('4', 'practice', '4');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('in Practice, says a changed layout or start tile waits for a restart too, as the run keys it', () => {
    const pending = (saved: Partial<MechanicsConfig>, startedWith: string) => {
      cleanup();
      render(
        <div>
          {controls.render({
            config: { ...mechanics('4'), ...saved },
            onChange: vi.fn(),
            surface: 'practice',
            run: { stage: 4, startedWith, execute: vi.fn() },
          })}
        </div>,
      );
      return screen.queryByRole('status')?.textContent ?? null;
    };
    const layout = { [COLOSSEUM_SPAWN_LAYOUT_KEY]: '4:s----------m' };
    const tile = { [COLOSSEUM_START_TILE_KEY]: '30,40' };
    const message = 'Setup saved. Restart the fight to start wave 4 with it.';
    // A run started random from the default tile.
    expect(pending({}, '4')).toBeNull();
    expect(pending(layout, '4')).toBe(message);
    expect(pending(tile, '4')).toBe(message);
    // The default tile named outright is the default.
    expect(pending({ [COLOSSEUM_START_TILE_KEY]: '23,38' }, '4')).toBeNull();
    // A run started on that layout and tile: only a change from them is pending.
    const started = encounterSetupStartedWith(
      snapshot({
        modifiers: {},
        run: run({ wave: 4 }),
        runSetup: setupState({ startSpawnLayout: '4:s----------m', startPlayerTile: '30,40' }),
      }),
    );
    expect(pending({ ...layout, ...tile }, started)).toBeNull();
    expect(pending(layout, started)).toBe(message);
    expect(pending({ ...tile, [COLOSSEUM_SPAWN_LAYOUT_KEY]: '' }, started)).toBe(message);
    expect(pending({ ...tile, [COLOSSEUM_SPAWN_LAYOUT_KEY]: '4:-m-s--------' }, started)).toBe(message);
  });

  it('names a custom layout in the footer line, as the Inferno does', () => {
    const custom = { ...mechanics('4'), [COLOSSEUM_SPAWN_LAYOUT_KEY]: '4:s----------m' };
    expect(colosseumSetupSummary(custom, {})).toBe('Waves 4–12 · Custom layout · No modifiers');
    // A layout saved for another wave is not this run's.
    expect(colosseumSetupSummary({ ...custom, [COLOSSEUM_START_WAVE_KEY]: '5' }, { doom: 1 })).toBe(
      'Waves 5–12 · 1 modifier',
    );
    expect(colosseumSetupSummary({ ...custom, [COLOSSEUM_START_WAVE_KEY]: '12' }, {})).toBe(
      'Sol Heredit · No modifiers',
    );
  });
});

describe('Colosseum spawn layout editor', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  /** The rail's control over a saved setup, re-rendered with each change it saves, as the configurer does. */
  function renderEditor(saved: Partial<MechanicsConfig>) {
    const changes: MechanicsConfig[] = [];
    let config: MechanicsConfig = { infiniteHealth: false, ...saved } as MechanicsConfig;
    const view = render(<div />);
    const draw = () =>
      view.rerender(
        <div>
          {controls?.render({
            config,
            onChange: (next) => {
              changes.push(next);
              config = next;
              draw();
            },
            surface: 'rail',
          })}
        </div>,
      );
    draw();
    return { changes, config: () => config };
  }
  const summary = () => document.querySelector<HTMLButtonElement>('.colosseum-layout-summary')!;
  const open = () => fireEvent.click(summary());
  const spot = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}:`) });
  const chip = (label: string) =>
    within(screen.getByRole('group', { name: 'Wave monsters' })).getByRole('button', { name: new RegExp(`^${label}`) });
  /** A tap on bare floor at `tile`, with the 33x34-tile plane (x 16-48, y 18-51) at 10px a tile. */
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
    fireEvent.click(map, { clientX: (x - 16 + 0.5) * 10, clientY: (51 - y + 0.5) * 10 });
  }

  it('is not offered for a direct Sol Heredit start', () => {
    renderEditor({ [COLOSSEUM_START_WAVE_KEY]: '12' });
    expect(document.querySelector('.colosseum-layout-summary')).toBeNull();
  });

  it("places the start wave's monsters on the 12 points and saves the layout value", () => {
    const { changes, config } = renderEditor({ [COLOSSEUM_START_WAVE_KEY]: '7' });
    expect(summary().textContent).toBe('Edit layoutRandom');
    open();
    // Wave 7 starts a javelin, a manticore and a shockwave; the jaguar and minotaur only reinforce.
    const chips = within(screen.getByRole('group', { name: 'Wave monsters' })).getAllByRole('button');
    expect(chips.map((button) => button.textContent)).toEqual(['Javelin 0/1', 'Manticore 0/1', 'Shockwave 0/1']);
    expect(screen.getAllByRole('button', { name: /: empty spawn$/ })).toHaveLength(12);
    fireEvent.click(chip('Manticore'));
    fireEvent.click(spot('North'));
    expect(changes.at(-1)?.[COLOSSEUM_SPAWN_LAYOUT_KEY]).toBe('7:--------m---');
    expect(resolveColosseumSpawnLayout(config())?.points[8]).toBe('manticore');
    expect(summary().textContent).toBe('Edit layoutCustom, rest random');
    fireEvent.click(chip('Javelin'));
    fireEvent.click(spot('East, south'));
    fireEvent.click(chip('Shockwave'));
    fireEvent.click(spot('South'));
    expect(changes.at(-1)?.[COLOSSEUM_SPAWN_LAYOUT_KEY]).toBe('7:j--w----m---');
    expect(summary().textContent).toBe('Edit layoutCustom');
    // Clear spawns returns the wave to random spawns.
    fireEvent.click(screen.getByRole('button', { name: 'Clear spawns' }));
    expect(changes.at(-1)?.[COLOSSEUM_SPAWN_LAYOUT_KEY]).toBe('');
  });

  it('moves the start on a floor tap, never onto a pillar, and Reset start puts it back', () => {
    const { changes } = renderEditor({ [COLOSSEUM_START_WAVE_KEY]: '3' });
    open();
    expect(screen.getByRole('img', { name: /^Your start: 23, 38/ })).toBeTruthy();
    floor([33, 31]);
    expect(changes.at(-1)?.[COLOSSEUM_START_TILE_KEY]).toBe('33,31');
    expect(screen.getByRole('img', { name: /^Your start: 33, 31/ })).toBeTruthy();
    expect(summary().textContent).toBe('Edit layoutRandom · Moved start');
    const count = changes.length;
    floor([25, 27]); // The south-west pillar.
    expect(changes).toHaveLength(count);
    fireEvent.click(screen.getByRole('button', { name: 'Reset start' }));
    expect(changes.at(-1)?.[COLOSSEUM_START_TILE_KEY]).toBe('');
  });

  it('warns beside the map, and marks the points, when the game could not spawn there from the start', () => {
    // West, inner (25,34) is 4 from the default start (23,38): the game never draws it.
    renderEditor({ [COLOSSEUM_START_WAVE_KEY]: '2', [COLOSSEUM_SPAWN_LAYOUT_KEY]: '2:----------j-' });
    expect(summary().textContent).toBe('Edit layoutCustom, rest random · Not possible in game');
    open();
    expect(spot('West, inner').getAttribute('aria-label')).toBe('West, inner: Javelin, too close to your start');
    expect(spot('West, inner').closest('.spawn-map__spot')?.classList.contains('is-flagged')).toBe(true);
    const warning = document.querySelector('.colosseum-layout-warning')!;
    expect(warning.textContent).toBe(
      'Not possible in the gameThe marked spawn is within 4 tiles of your start. The game never spawns monsters that close, but this run will.',
    );
    // Moving the start away clears it; a start inside the javelin says so.
    floor([40, 30]);
    expect(document.querySelector('.colosseum-layout-warning')).toBeNull();
    expect(document.querySelectorAll('.spawn-map__spot.is-flagged')).toHaveLength(0);
    floor([26, 35]);
    expect(spot('West, inner').getAttribute('aria-label')).toBe('West, inner: Javelin, on your start');
    expect(document.querySelector('.colosseum-layout-warning')?.textContent).toContain(
      'You also start inside the javelin colossus.',
    );
  });

  it('counts each marked point once in the warning', () => {
    expect(
      colosseumLayoutWarningText(
        colosseumSpawnLayoutWarnings(
          {
            wave: 3,
            points: [null, null, null, null, null, null, null, null, null, null, 'javelinColossus', 'serpentShaman'],
          },
          [23, 38],
        ),
      ),
    ).toBe(
      '2 marked spawns are within 4 tiles of your start. The game never spawns monsters that close, but this run will.',
    );
  });
});

describe('Colosseum run chrome', () => {
  it('publishes the run stage and its start for the setup control', () => {
    const state = { modifiers: {}, run: run({}) };
    expect(encounterSetupStage(snapshot(state))).toBe(6);
    expect(encounterSetupStartedWith(snapshot(state))).toBe('4');
    // Older recordings carry no run: a direct Sol start.
    expect(encounterSetupStage(snapshot({ modifiers: {} }))).toBe(12);
    expect(encounterSetupStartedWith(snapshot({ modifiers: {} }))).toBe('12');
  });

  it('keys the run by its start wave, layout and moved start, as the saved setup is keyed', () => {
    const runSetup = setupState({ startSpawnLayout: '4:s----------m', startPlayerTile: '30,40' });
    const started = encounterSetupStartedWith(snapshot({ modifiers: {}, run: run({}), runSetup }));
    expect(started).toBe('4;4:s----------m;start=30,40');
    const saved = {
      [COLOSSEUM_START_WAVE_KEY]: '4',
      [COLOSSEUM_SPAWN_LAYOUT_KEY]: '4:s----------m',
      [COLOSSEUM_START_TILE_KEY]: '30,40',
    };
    expect(colosseumRunSetupKey(resolveColosseumRunSetup(saved))).toBe(started);
    // Random spawns from the default tile key as the wave alone, as before either existed.
    expect(encounterSetupStartedWith(snapshot({ modifiers: {}, run: run({}), runSetup: setupState({}) }))).toBe('4');
    // A direct Sol start ignores both.
    expect(colosseumRunSetupKey(resolveColosseumRunSetup({ ...saved, [COLOSSEUM_START_WAVE_KEY]: '12' }))).toBe('12');
  });

  it('copies the wave being fought, once it has spawned, as the layout tool opens on it', () => {
    const spawned = setupState({ waveSpawnLayout: '6:sjjm--------', waveStartPlayerTile: [30, 40] });
    expect(encounterCurrentSetup(snapshot({ modifiers: {}, run: run({}), runSetup: spawned }))).toEqual({
      [COLOSSEUM_START_WAVE_KEY]: '6',
      [COLOSSEUM_SPAWN_LAYOUT_KEY]: '6:sjjm--------',
      [COLOSSEUM_START_TILE_KEY]: '30,40',
    });
    // Spawned from the default tile, the copy keeps the default unset.
    expect(
      encounterCurrentSetup(
        snapshot({ modifiers: {}, run: run({}), runSetup: { ...spawned, waveStartPlayerTile: [23, 38] } }),
      ),
    ).toMatchObject({ [COLOSSEUM_START_TILE_KEY]: '' });
    // Through an intermission there is nothing to copy, nor for a direct Sol start.
    expect(
      encounterCurrentSetup(snapshot({ modifiers: {}, run: run({ stage: 'intermission' }), runSetup: setupState({}) })),
    ).toBeUndefined();
    expect(encounterCurrentSetup(snapshot({ modifiers: {} }))).toBeUndefined();
  });

  it('shows a wave tile for runs started before Sol, listing the tiers in force', () => {
    expect(encounterInfobox(snapshot({ modifiers: { blasphemy: 3 } }))).toBeNull();
    const picks = [
      { origin: 'set', wave: null, id: 'doom', tier: 1, tick: null },
      { origin: 'live', wave: 5, id: 'quartet', tier: 1, tick: 300 },
      { origin: 'live', wave: 6, id: 'doom', tier: 2, tick: 600 },
    ] as const;
    const tile = encounterInfobox(snapshot({ modifiers: { doom: 1, quartet: 1 }, run: run({ picks }) }));
    expect(tile).toMatchObject({ id: 'colosseum-wave', text: '6', tooltipTitle: 'Fortis Colosseum' });
    // Doom II was chosen but only takes effect at its wave's start.
    expect(tile?.tooltipDetail).toBe('Wave 6 of 12. Modifiers: Doom I, Quartet.');
    expect(colosseumOwnedModifiers(picks)).toEqual([
      // Doom's tier now held came from the wave-6 pick, not the set.
      { id: 'doom', tier: 2, source: { origin: 'live', wave: 6 } },
      { id: 'quartet', tier: 1, source: { origin: 'live', wave: 5 } },
    ]);
  });
});

describe('Colosseum layout tool', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const tool = () => {
    const definition = encounterToolFor(snapshot({ modifiers: {}, run: run({}) }));
    if (!definition) throw new Error('Expected the Colosseum layout tool');
    return definition;
  };
  const runFor = (stage = 4, extra: Partial<EncounterSetupRun> = {}): EncounterSetupRun => ({
    stage,
    startedWith: String(stage),
    execute: vi.fn(),
    ...extra,
  });

  /** The tool over a saved setup in state, opened and closed as its host does. */
  function host(initial: Partial<MechanicsConfig>, toolRun?: EncounterSetupRun) {
    let stored = { infiniteHealth: false, ...initial } as MechanicsConfig;
    const changed = vi.fn();
    let setOpen: (open: boolean) => void = () => {};
    const Host = () => {
      const [config, setConfig] = useState(stored);
      const [open, setEditing] = useState(true);
      setOpen = setEditing;
      stored = config;
      if (!open) return null;
      return (
        <ColosseumLayoutTool
          config={config}
          run={toolRun}
          onClose={() => setEditing(false)}
          onChange={(next) => {
            changed(next);
            setConfig(next);
          }}
        />
      );
    };
    render(<Host />);
    return {
      config: () => stored,
      changed,
      open: () => act(() => setOpen(true)),
      close: () => act(() => setOpen(false)),
    };
  }
  const spot = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name}:`) });
  const chip = (label: string) =>
    within(screen.getByRole('group', { name: 'Wave monsters' })).getByRole('button', { name: new RegExp(`^${label}`) });

  it("is offered for wave starts only, and disabled once the run reaches Sol, as wave 69 disables the Inferno's", () => {
    expect(tool().label).toBe('Edit layout');
    expect(encounterToolFor(snapshot({ modifiers: {} }))).toBeUndefined();
    expect(tool().disabledReason(runFor(4))).toBeUndefined();
    expect(tool().disabledReason(runFor(12))).toBe('Wave 12 has a fixed layout.');
  });

  it('opens on the spawned wave without saving it; Start saves it before restarting from that wave', () => {
    const currentSetup = {
      [COLOSSEUM_START_WAVE_KEY]: '6',
      [COLOSSEUM_SPAWN_LAYOUT_KEY]: '6:sjjm--------',
      [COLOSSEUM_START_TILE_KEY]: '30,40',
    };
    const toolRun = runFor(6, { currentSetup });
    const view = host({ [COLOSSEUM_START_WAVE_KEY]: '4' }, toolRun);
    expect(screen.getByRole('spinbutton', { name: 'Start wave' })).toHaveValue(6);
    expect(screen.getByRole('img', { name: /^Your start: 30, 40/ })).toBeTruthy();
    expect(spot('East, south').getAttribute('aria-label')).toBe('East, south: Shaman');
    view.close();
    view.open();
    expect(view.changed).not.toHaveBeenCalled();
    expect(view.config()[COLOSSEUM_START_WAVE_KEY]).toBe('4');
    fireEvent.click(screen.getByRole('button', { name: 'Start wave 6' }));
    expect(view.config()).toMatchObject(currentSetup);
    expect(toolRun.execute).toHaveBeenCalledExactlyOnceWith({ encounter: 'sol_heredit', type: 'go-to-wave', wave: 6 });
    expect(view.changed.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(toolRun.execute).mock.invocationCallOrder[0]!,
    );
    // Start closes the tool.
    expect(screen.queryByRole('spinbutton', { name: 'Start wave' })).toBeNull();
  });

  it('saves each edit, notes the random rest of a partial layout and warns where the game could not spawn', () => {
    const toolRun = runFor(2);
    const view = host({ [COLOSSEUM_START_WAVE_KEY]: '2' }, toolRun);
    const caption = 'Pick a monster above, then tap its spots.';
    expect(screen.getByText(caption)).toBeTruthy();
    // West, inner (25,34) is 4 from the default start (23,38).
    fireEvent.click(chip('Javelin'));
    fireEvent.click(spot('West, inner'));
    expect(view.config()[COLOSSEUM_SPAWN_LAYOUT_KEY]).toBe('2:----------j-');
    expect(screen.getByText('Unplaced monsters spawn at random.')).toBeTruthy();
    expect(document.querySelector('.colosseum-layout-warning')?.textContent).toContain('Not possible in the game');
    fireEvent.click(chip('Shaman'));
    fireEvent.click(spot('North'));
    expect(screen.getByText(caption)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear spawns' }));
    expect(view.config()[COLOSSEUM_SPAWN_LAYOUT_KEY]).toBe('');
    expect(document.querySelector('.colosseum-layout-warning')).toBeNull();
    expect(toolRun.execute).not.toHaveBeenCalled();
  });

  it('says a direct Sol start has a fixed layout, and still starts it', () => {
    const toolRun = runFor(4);
    host({ [COLOSSEUM_START_WAVE_KEY]: '12' }, toolRun);
    expect(screen.getByText('This wave has a fixed layout.')).toBeTruthy();
    expect(screen.queryByTestId('arena-map')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start wave 12' }));
    expect(toolRun.execute).toHaveBeenCalledExactlyOnceWith({ encounter: 'sol_heredit', type: 'go-to-wave', wave: 12 });
  });

  it.each([
    4, 12,
  ])('opens from the mobile Practice list for a wave start, holding the fight (start wave %i)', (startWave) => {
    const engine = new SimulationEngine({
      encounter: new SolHereditEncounter(7),
      mechanics: { [COLOSSEUM_START_WAVE_KEY]: String(startWave) },
    });
    const controls = encounterControlsForKind('sol_heredit')!;
    const execute = vi.fn();
    const held: boolean[] = [];
    render(
      <MobilePracticeControls
        simulationState={engine.getState()}
        engine={engine}
        mechanicsConfig={engine.getMechanicsConfig()}
        onMechanicsConfigChange={vi.fn()}
        mechanicsToggles={controls.mechanicsToggles}
        debugActions={controls.debugActions}
        onExecuteEncounterCommand={execute}
        onEncounterToolOpenChange={(open) => held.push(open)}
        onSetBossHp={vi.fn()}
        onRestart={vi.fn()}
        encounterSession={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Back to Practice' }));
    if (startWave === 12) {
      // A direct Sol start has no wave layout to edit.
      expect(screen.queryByRole('button', { name: 'Edit layout' })).toBeNull();
      return;
    }
    fireEvent.click(screen.getByRole('button', { name: 'Edit layout' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit layout' });
    expect(within(dialog).getByTestId('arena-map')).toBeTruthy();
    expect(within(dialog).getByRole('spinbutton', { name: 'Start wave' })).toHaveValue(4);
    expect(held).toEqual([true]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start wave 4' }));
    expect(execute).toHaveBeenCalledExactlyOnceWith({ encounter: 'sol_heredit', type: 'go-to-wave', wave: 4 });
    expect(held).toEqual([true, false]);
  });
});
