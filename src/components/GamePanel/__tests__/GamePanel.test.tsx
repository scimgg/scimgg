// @vitest-environment happy-dom

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { type ComponentProps, type ReactElement, type ReactNode, useState } from 'react';
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest';
import { ReplayPresentationProvider } from '../../../contexts/ReplayPresentationContext';
import type {
  ReplayPanelModes,
  ReplayPanelPresentation,
  ReplayPresentationState,
} from '../../../core/replayPresentation';
import { SimulationEngine } from '../../../core/SimulationEngine';
import { EQUIPMENT_PRESETS } from '../../../data/playerPresets';
import { COMBINATION_RUNE, RUNE } from '../../../data/spellRunes';
import { SENSORY_CLOUDING_CONFIG } from '../../../encounters/yamaP3/contractConfig';
import { YamaEncounter } from '../../../encounters/yamaP3/YamaEncounter';
import { PANEL_FILTER_STORAGE_KEY } from '../../../hooks/panelFilterState';
import type { UIPosition } from '../../../hooks/usePersistedSettings';
import { MOBILE, PANEL, TAB_ICONS } from '../../../resourcePack';
import { defaultOsmFrame } from '../../../test/helpers/osmFrame';
import { WIKI_TIERED_PRAYER_ROWS } from '../../../types/__tests__/fixtures/wikiPrayerTable';
import type { RunePouch } from '../../../types/encounterLoadout';
import { createEmptyInventory, type Inventory } from '../../../types/inventory';
import { PRAYER_FILTER_DEFAULTS } from '../../../types/panelFilters';
import type { PlayerBaseStats, PlayerStats } from '../../../types/playerState';
import {
  createStatsFromBaseLevels,
  DEATH_CHARGE_COOLDOWN_TICKS,
  DEATH_CHARGE_DURATION_TICKS,
  DEATH_CHARGE_PROCS,
  DEATH_CHARGE_PROCS_UPGRADED,
} from '../../../types/playerState';
import {
  DEFAULT_MECHANICS_CONFIG,
  type MechanicsConfig,
  PrayerType,
  type SimulationState,
} from '../../../types/simulation';
import { ContextMenuProvider, useContextMenu } from '../../ContextMenu';
import type { LayerSprite } from '../../PixelSpriteLayer';
import { PanelSnapRegistryProvider } from '../../snap/PanelSnapRegistry';
import { TooltipOverlay, TooltipProvider } from '../../Tooltip';
import { GamePanel } from '../GamePanel';
import { PrayerContent, prayerSlotOrigin } from '../PrayerContent';
import { PRAYER_GRID } from '../prayerFilterUtils';
import { QuickPrayerSetup } from '../QuickPrayerSetup';
import { ARCEUUS_GRID, isSpellSlotEnabled } from '../spellbookFilterUtils';

type GamePanelProps = ComponentProps<typeof GamePanel>;

function renderWithProviders(element: ReactElement) {
  const ContextMenuProbe = () => {
    const { content } = useContextMenu();
    return (
      <div data-testid="context-menu-probe">
        {content?.entries.map((entry) => `${entry.action}${entry.target ? ` ${entry.target}` : ''}`).join('|')}
      </div>
    );
  };
  const Providers = ({ children }: { children: ReactNode }) => (
    <TooltipProvider>
      <ContextMenuProvider>
        {children}
        <ContextMenuProbe />
      </ContextMenuProvider>
      <TooltipOverlay />
    </TooltipProvider>
  );
  return render(element, { wrapper: Providers });
}

function makeInventory(): Inventory {
  const inventory = createEmptyInventory();
  inventory[0] = { id: 13441 };
  return inventory;
}

function setEventTimeStamp(event: Event, timeStamp: number): Event {
  Object.defineProperty(event, 'timeStamp', { value: timeStamp, configurable: true });
  return event;
}

function mouseEvent(type: string, init: MouseEventInit, timeStamp: number): MouseEvent {
  return setEventTimeStamp(new MouseEvent(type, { bubbles: true, cancelable: true, ...init }), timeStamp) as MouseEvent;
}

/**
 * Prayer and spell slots are transparent hit targets over a shared sprite canvas and carry the
 * name themselves; combat-style icons are still per-sprite canvases inside their button.
 */
function buttonForAltText(altText: string): HTMLButtonElement {
  const button =
    screen.queryByRole('button', { name: altText }) ?? screen.getByRole('img', { name: altText }).closest('button');
  expect(button).not.toBeNull();
  if (button === null) {
    throw new Error(`Missing button for ${altText}`);
  }
  return button as HTMLButtonElement;
}

function buttonForText(text: string): HTMLButtonElement {
  const button = screen.getByText(text).closest('button');
  expect(button).not.toBeNull();
  if (button === null) {
    throw new Error(`Missing button for ${text}`);
  }
  return button;
}

function renderPanel(
  replayActiveTab: NonNullable<GamePanelProps['replayActiveTab']>,
  props: Partial<GamePanelProps> = {},
) {
  const replayProps = { replayActiveTab };
  return renderWithProviders(
    <GamePanel
      activePrayer={null}
      onPrayerChange={vi.fn()}
      inventory={makeInventory()}
      prayerState={{ points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} }}
      {...replayProps}
      {...props}
    />,
  );
}

describe('GamePanel replay tab state', () => {
  const modernPanel = (props: Partial<GamePanelProps> = {}) =>
    renderWithProviders(<GamePanel activePrayer={null} onPrayerChange={vi.fn()} {...props} />);
  const panelBody = () => document.querySelector<HTMLElement>('[data-tutorial="game-panel"]');

  it('retains the same tab strip and sprite geometry when the content closes and reopens', () => {
    modernPanel();
    const bar = document.querySelector('[data-tutorial="tab-bar"]') as HTMLElement;
    const canvas = bar.querySelector('canvas') as HTMLCanvasElement;
    const geometry = () => ({
      bounds: [bar.style.width, bar.style.height, bar.style.transform],
      canvas: [canvas.style.width, canvas.style.height, canvas.width, canvas.height],
      sprites: (JSON.parse(canvas.dataset.sprites ?? '[]') as LayerSprite[]).filter(
        (sprite) => sprite.src !== PANEL.tabStoneSelected,
      ),
    });
    const before = geometry();
    const inventory = screen.getByRole('button', { name: /^Inventory/ });
    for (let press = 0; press < 2; press++) {
      fireEvent.click(inventory);
      expect(document.querySelector('[data-tutorial="tab-bar"]')).toBe(bar);
      expect(bar.querySelector('canvas')).toBe(canvas);
      expect(geometry()).toEqual(before);
    }
  });

  it('keeps same-tab hotkey closing off by default, while clicks close and reopen the body', () => {
    modernPanel();
    fireEvent.keyDown(window, { key: 'F3' });
    expect(panelBody()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
    expect(panelBody()).toBeNull();
    expect(screen.getByRole('button', { name: /^Inventory/ }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.keyDown(window, { key: 'F3' });
    expect(panelBody()).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
    expect(panelBody()).not.toBeNull();
  });

  it('closes and reopens on the same hotkey when enabled and switches to a different tab', () => {
    modernPanel({ hotkeysCloseSidePanel: true });
    fireEvent.keyDown(window, { key: 'F3' });
    expect(panelBody()).toBeNull();
    fireEvent.keyDown(window, { key: 'F3', repeat: true });
    expect(panelBody()).toBeNull();
    fireEvent.keyDown(window, { key: 'F3' });
    expect(panelBody()).not.toBeNull();
    fireEvent.keyDown(window, { key: 'F2' });
    expect(panelBody()).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Skills/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.keyDown(window, { key: 'F2' });
    expect(panelBody()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Prayer/ }));
    expect(panelBody()).not.toBeNull();
  });

  it('dismisses the hovered panel tooltip on same-tab close without pointer motion', () => {
    modernPanel({
      hotkeysCloseSidePanel: true,
      simulationState: stubSimulationState(makeStats({ prayer: { current: 1, max: 1 } })),
    });
    fireEvent.click(screen.getByRole('button', { name: /^Prayer/ }));
    fireEvent.mouseEnter(buttonForAltText('Protect from Magic'), { clientX: 10, clientY: 10 });
    expect(screen.getByText('Protect from Magic')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'F5' });

    expect(panelBody()).toBeNull();
    expect(screen.queryByText('Protect from Magic')).toBeNull();
  });

  it.each(['fixed', 'classic'] as const)('does not collapse %s when Modern closing is enabled', (mode) => {
    modernPanel({ clientLayoutMode: mode, hotkeysCloseSidePanel: true, transparentSidePanel: false });
    fireEvent.keyDown(window, { key: 'F3' });
    fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
    expect(panelBody()).not.toBeNull();
  });

  it.each([
    'modern',
    'classic',
  ] as const)('%s changes only the gameplay backing alpha and keeps text settings opaque', (clientLayoutMode) => {
    const inventory = makeInventory();
    const view = modernPanel({ clientLayoutMode, inventory });
    const backing = () => panelBody()?.querySelector<HTMLElement>('canvas[data-composed], img');
    expect(backing()?.style.opacity).toBe('0.5');
    const geometry = () => [
      panelBody()?.getAttribute('style'),
      screen.getByRole('button', { name: /^Inventory/ }).getAttribute('style'),
    ];
    const initialGeometry = geometry();
    const expectOpaqueContent = () => {
      let content: HTMLElement | null = screen.getByRole('button', { name: 'Item 13441' });
      while (content && content !== panelBody()) {
        expect(['', '1']).toContain(content.style.opacity);
        content = content.parentElement;
      }
      expect(panelBody()?.style.opacity).toBe('');
    };
    expectOpaqueContent();
    fireEvent.click(screen.getByRole('button', { name: /^Keybinds/ }));
    expect(backing()?.style.opacity).toBe('1');
    view.rerender(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        clientLayoutMode={clientLayoutMode}
        inventory={inventory}
        transparentSidePanel={false}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
    expect(backing()?.style.opacity).toBe('1');
    expectOpaqueContent();
    expect(geometry()).toEqual(initialGeometry);
  });

  it('keeps Fixed opaque regardless of the shared transparency preference', () => {
    const view = modernPanel({ clientLayoutMode: 'fixed' });
    const backing = () => panelBody()?.querySelector<HTMLCanvasElement>('canvas[data-composed]');
    expect(backing()?.style.opacity).toBe('1');
    const before = backing()?.getAttribute('data-composed');
    view.rerender(
      <GamePanel activePrayer={null} onPrayerChange={vi.fn()} clientLayoutMode="fixed" transparentSidePanel={false} />,
    );
    expect(backing()?.style.opacity).toBe('1');
    expect(backing()?.getAttribute('data-composed')).toBe(before);
  });

  it('keeps only General, Camera and Plugins categories with plugin shortcuts only in Plugins', () => {
    renderWithProviders(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        inventory={makeInventory()}
        prayerState={{ points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Keybinds/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Keybindings' }));

    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['General', 'Camera', 'Plugins']);
    expect(screen.queryByRole('button', { name: 'Rebind Zuk Set Timer: Advance timer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebind Simulation: Additional restart shortcut' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebind Simulation: Set practice start' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Camera' }));
    expect(screen.queryByRole('button', { name: 'Rebind Zuk Set Timer: Advance timer' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebind Simulation: Additional restart shortcut' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebind Simulation: Set practice start' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Simulation' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }));
    expect(screen.getByRole('button', { name: 'Rebind Zuk Set Timer: Advance timer' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Rebind Simulation: Additional restart shortcut' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rebind Simulation: Set practice start' })).toBeNull();
  });

  it('renders replay tabs independently from the live active tab', () => {
    const { rerender } = renderPanel('prayer');

    expect(screen.getByRole('button', { name: 'Protect from Magic' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Item 13441' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Prayer/ }));

    const replayProps = { replayActiveTab: 'inventory' as const };
    rerender(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        inventory={makeInventory()}
        prayerState={{ points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} }}
        {...replayProps}
      />,
    );

    expect(screen.getByRole('button', { name: 'Item 13441' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Protect from Magic' })).toBeNull();
  });

  it('discards a tab sub-view when the tab is left, as unmounting would', () => {
    // GamePanel does not unmount on a tab switch, so leaving the tab has to discard the
    // stats readout explicitly or the tab reopens on it instead of the slots.
    renderWithProviders(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        inventory={makeInventory()}
        prayerState={{ points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /^Equipment/ }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Equipment Stats' }), { button: 0 });
    expect(screen.queryByRole('button', { name: 'Back to equipment' })).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /^Prayer/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Equipment/ }));

    expect(screen.queryByRole('button', { name: 'Back to equipment' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Equipment Stats' })).not.toBeNull();
  });

  it('records a yellow replay marker when a real prayer is toggled with left-click', () => {
    const onPrayerChange = vi.fn();
    const onReplayCursorClick = vi.fn<NonNullable<GamePanelProps['onReplayCursorClick']>>();

    renderPanel('prayer', { onPrayerChange, onReplayCursorClick });

    fireEvent(
      buttonForAltText('Protect from Magic'),
      mouseEvent('mousedown', { button: 0, clientX: 101, clientY: 202 }, 3030),
    );

    expect(onPrayerChange).toHaveBeenCalledWith(PrayerType.ProtectMagic);
    expect(onReplayCursorClick).toHaveBeenCalledWith(101, 202, 'yellow', 3030);
  });

  it('sends the clicked prayer on every button op instead of deriving a direction from rendered state', () => {
    const onPrayerChange = vi.fn();
    renderPanel('prayer', { activePrayer: PrayerType.ProtectMagic, onPrayerChange });
    const prayerButton = buttonForAltText('Protect from Magic');

    fireEvent(prayerButton, mouseEvent('mousedown', { button: 0 }, 1000));
    fireEvent(prayerButton, mouseEvent('mousedown', { button: 0 }, 1001));

    expect(onPrayerChange.mock.calls).toEqual([[PrayerType.ProtectMagic], [PrayerType.ProtectMagic]]);
  });

  it('leaves a prayer-book slot above the configured Prayer level hoverable but inert', () => {
    const onPrayerChange = vi.fn();
    const onReplayCursorClick = vi.fn<NonNullable<GamePanelProps['onReplayCursorClick']>>();
    renderPanel('prayer', {
      onPrayerChange,
      onReplayCursorClick,
      simulationState: stubSimulationState(makeStats({ prayer: { current: 1, max: 1 } })),
    });
    const prayerButton = buttonForAltText('Protect from Magic');

    fireEvent(prayerButton, mouseEvent('mousedown', { button: 0, clientX: 101, clientY: 202 }, 1000));

    expect(prayerButton).not.toBeDisabled();
    expect(prayerButton).toHaveAttribute('aria-disabled', 'true');
    expect(onPrayerChange).not.toHaveBeenCalled();
    expect(onReplayCursorClick).not.toHaveBeenCalled();
  });

  it('names a prayer above the configured Prayer level on hover without offering an op', () => {
    renderPanel('prayer', {
      simulationState: stubSimulationState(makeStats({ prayer: { current: 1, max: 1 } })),
    });

    fireEvent.mouseEnter(buttonForAltText('Protect from Magic'), { clientX: 10, clientY: 10 });

    expect(screen.getByText('Protect from Magic')).toBeInTheDocument();
    expect(screen.queryByText('Activate')).toBeNull();
  });

  it('paints the label-only tooltip white for a prayer the player cannot use', () => {
    renderPanel('prayer', {
      simulationState: stubSimulationState(makeStats({ prayer: { current: 1, max: 1 } })),
    });

    fireEvent.mouseEnter(buttonForAltText('Protect from Magic'), { clientX: 10, clientY: 10 });

    expect(screen.getByText('Protect from Magic')).toHaveStyle({ color: '#ffffff' });
  });

  it('uses immediate prayer activation state in the context menu', () => {
    renderPanel('prayer', {
      prayerVisualOverrides: { [PrayerType.ProtectMagic]: true },
    });

    fireEvent.mouseDown(buttonForAltText('Protect from Magic'), { button: 2 });

    expect(screen.getByTestId('context-menu-probe').textContent).toContain('Deactivate Protect from Magic');
  });

  it('uses immediate prayer deactivation state in the context menu', () => {
    renderPanel('prayer', {
      activePrayer: PrayerType.ProtectMagic,
      prayerVisualOverrides: { [PrayerType.ProtectMagic]: false },
    });

    fireEvent.mouseDown(buttonForAltText('Protect from Magic'), { button: 2 });

    expect(screen.getByTestId('context-menu-probe').textContent).toContain('Activate Protect from Magic');
  });

  it('records yellow replay markers for spellbook casts', () => {
    const onMarkOfDarknessCast = vi.fn();
    const onHomeTeleportCast = vi.fn();
    const onReplayCursorClick = vi.fn<NonNullable<GamePanelProps['onReplayCursorClick']>>();

    renderPanel('spellbook', { onHomeTeleportCast, onMarkOfDarknessCast, onReplayCursorClick });

    fireEvent(
      buttonForAltText('Mark of Darkness'),
      mouseEvent('mousedown', { button: 0, clientX: 111, clientY: 222 }, 3333),
    );

    expect(onMarkOfDarknessCast).toHaveBeenCalledTimes(1);
    expect(onReplayCursorClick).toHaveBeenCalledTimes(1);
    expect(onReplayCursorClick).toHaveBeenCalledWith(111, 222, 'yellow', 3333);

    fireEvent(
      buttonForAltText('Arceuus Home Teleport'),
      mouseEvent('click', { button: 0, clientX: 121, clientY: 232 }, 3434),
    );

    expect(onHomeTeleportCast).toHaveBeenCalledTimes(1);
    expect(onReplayCursorClick).toHaveBeenCalledTimes(2);
    expect(onReplayCursorClick).toHaveBeenLastCalledWith(121, 232, 'yellow', 3434);
  });

  it('casts Death Charge from the spellbook', () => {
    // The whole prop chain has to be intact for this to fire — GridProviders -> Grid -> GamePanel
    // -> SpellbookContent.
    const onDeathChargeCast = vi.fn();
    const onReplayCursorClick = vi.fn<NonNullable<GamePanelProps['onReplayCursorClick']>>();

    renderPanel('spellbook', { onDeathChargeCast, onReplayCursorClick });

    fireEvent(
      buttonForAltText('Death Charge'),
      mouseEvent('mousedown', { button: 0, clientX: 141, clientY: 252 }, 3636),
    );

    expect(onDeathChargeCast).toHaveBeenCalledTimes(1);
    expect(onReplayCursorClick).toHaveBeenCalledWith(141, 252, 'yellow', 3636);
  });

  it('records yellow replay markers for combat controls', () => {
    const onAttackStyleChange = vi.fn();
    const onSpecialAttackToggle = vi.fn();
    const onReplayCursorClick = vi.fn<NonNullable<GamePanelProps['onReplayCursorClick']>>();

    renderPanel('combat', { hasSpecialAttack: true, onAttackStyleChange, onReplayCursorClick, onSpecialAttackToggle });

    fireEvent(buttonForAltText('Kick'), mouseEvent('mousedown', { button: 0, clientX: 131, clientY: 242 }, 3535));

    expect(onAttackStyleChange).toHaveBeenCalledWith(1);
    expect(onReplayCursorClick).toHaveBeenCalledWith(131, 242, 'yellow', 3535);

    fireEvent(
      buttonForText('Special Attack: 100%'),
      mouseEvent('mousedown', { button: 0, clientX: 141, clientY: 252 }, 3636),
    );

    expect(onSpecialAttackToggle).toHaveBeenCalledTimes(1);
    expect(onReplayCursorClick).toHaveBeenLastCalledWith(141, 252, 'yellow', 3636);
  });

  // With the axe worn the bar counts soul stacks.
  it('reads the Soulreaper axe special bar in soul stacks out of five', () => {
    const onSpecialAttackToggle = vi.fn();
    renderPanel('combat', {
      hasSpecialAttack: true,
      specialAttackPercent: 40,
      soulreaperStacks: 3,
      onSpecialAttackToggle,
    });

    expect(screen.queryByText('Special Attack: 40%')).toBeNull();
    fireEvent.mouseDown(buttonForText('Special Attack: 3/5'), { button: 0 });
    expect(onSpecialAttackToggle).toHaveBeenCalledTimes(1);
  });
});

describe('prayer book tiered prayers and Chivalry', () => {
  const labelOf = (prayer: PrayerType): string => {
    const slot = PRAYER_GRID.find((candidate) => candidate.prayer === prayer);
    if (slot === undefined) throw new TypeError(`No book slot for ${prayer}`);
    return slot.label;
  };
  const defenceStats = (defence: number) => makeStats({ defence: { current: defence, max: defence } });

  it.each(WIKI_TIERED_PRAYER_ROWS)('sends a click on the $prayer slot as a boost prayer click', ({ prayer }) => {
    const onBoostPrayerChange = vi.fn();
    const onPrayerChange = vi.fn();
    renderPanel('prayer', { simulationState: stubSimulationState(makeStats()), onBoostPrayerChange, onPrayerChange });
    const button = screen.getByRole('button', { name: labelOf(prayer) });
    expect(button.getAttribute('data-prayer')).toBe(prayer);
    expect(button.getAttribute('aria-disabled')).toBe('false');

    fireEvent.mouseDown(button, { button: 0 });
    expect(onBoostPrayerChange).toHaveBeenCalledExactlyOnceWith(prayer);
    expect(onPrayerChange).not.toHaveBeenCalled();
  });

  // "level 65 Defence and 60 Prayer" (https://oldschool.runescape.wiki/w/Chivalry?oldid=15293964).
  it.each([
    [64, false],
    [65, true],
  ] as const)('lets Chivalry be clicked at base Defence %i only from 65', (defence, clickable) => {
    const onBoostPrayerChange = vi.fn();
    renderPanel('prayer', { simulationState: stubSimulationState(defenceStats(defence)), onBoostPrayerChange });
    const button = screen.getByRole('button', { name: 'Chivalry' });
    expect(button.getAttribute('aria-disabled')).toBe(String(!clickable));

    fireEvent.mouseDown(button, { button: 0 });
    expect(onBoostPrayerChange).toHaveBeenCalledTimes(clickable ? 1 : 0);
  });

  it.each([
    [64, false],
    [65, true],
  ] as const)('filters Chivalry at base Defence %i when unmet requirements are hidden', (baseDefenceLevel, shown) => {
    renderWithProviders(
      <PrayerContent
        activePrayer={null}
        onPrayerChange={vi.fn()}
        reorderMode={false}
        filteringEnabled
        filterViewOpen={false}
        onFilterViewOpenChange={vi.fn()}
        filterSettings={{
          hidden: [],
          order: null,
          filterOptions: { ...PRAYER_FILTER_DEFAULTS, showLackRequirements: false },
        }}
        availability={{ basePrayerLevel: 99, baseDefenceLevel, baseAttackLevel: 99, baseStrengthLevel: 99 }}
        onToggleHidden={vi.fn()}
        onReorder={vi.fn()}
        onToggleFilterOption={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Chivalry' }) !== null).toBe(shown);
  });
});

describe('QuickPrayerSetup prayer upgrades', () => {
  it.each([
    [75, false, true],
    [74, false, false],
    [74, true, true],
  ] as const)('filters the effective prayer at Attack %s with unmet requirements shown %s', (baseAttackLevel, showLackRequirements, shown) => {
    renderWithProviders(
      <PrayerContent
        activePrayer={null}
        onPrayerChange={vi.fn()}
        reorderMode={false}
        filteringEnabled
        filterViewOpen={false}
        onFilterViewOpenChange={vi.fn()}
        filterSettings={{ hidden: [], order: null, filterOptions: { ...PRAYER_FILTER_DEFAULTS, showLackRequirements } }}
        availability={{ basePrayerLevel: 84, baseDefenceLevel: 1, baseAttackLevel, baseStrengthLevel: 75 }}
        zealPrayer
        onToggleHidden={vi.fn()}
        onReorder={vi.fn()}
        onToggleFilterOption={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Zeal' }) !== null).toBe(shown);
  });

  it('activates Zeal from the Piety cell in the prayer book when unlocked', () => {
    const onBoostPrayerChange = vi.fn();
    renderPanel('prayer', {
      simulationState: stubSimulationState(
        makeStats({
          prayer: { current: 84, max: 84 },
          attack: { current: 75, max: 75 },
          strength: { current: 75, max: 75 },
          defence: { current: 1, max: 1 },
        }),
        {
          ...DEFAULT_MECHANICS_CONFIG,
          zealPrayer: true,
        },
      ),
      onBoostPrayerChange,
    });
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Zeal' }), { button: 0 });
    expect(onBoostPrayerChange).toHaveBeenCalledWith(PrayerType.Zeal);
    expect(screen.queryByRole('button', { name: 'Piety' })).toBeNull();
  });

  it.each(['attack', 'strength'] as const)('refuses Zeal below base %s 75 even when boosted', (skill) => {
    const onBoostPrayerChange = vi.fn();
    renderPanel('prayer', {
      simulationState: stubSimulationState(
        makeStats({
          prayer: { current: 84, max: 84 },
          attack: { current: 75, max: 75 },
          strength: { current: 75, max: 75 },
          defence: { current: 1, max: 1 },
          [skill]: { current: 99, max: 74 },
        }),
        { ...DEFAULT_MECHANICS_CONFIG, zealPrayer: true },
      ),
      onBoostPrayerChange,
    });
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Zeal' }), { button: 0 });
    expect(onBoostPrayerChange).not.toHaveBeenCalled();
  });

  function renderSetup(quickPrayerSelections: string[], basePrayerLevel = 62, zealPrayer = false) {
    const onToggleSelection = vi.fn();
    render(
      <QuickPrayerSetup
        quickPrayerSelections={quickPrayerSelections}
        availability={{ basePrayerLevel, baseDefenceLevel: 99, baseAttackLevel: 99, baseStrengthLevel: 99 }}
        upgradedPrayers
        zealPrayer={zealPrayer}
        onToggleSelection={onToggleSelection}
        onClose={vi.fn()}
      />,
    );
    return onToggleSelection;
  }

  function activatedBackgrounds(label: string): number {
    return screen.getByRole('button', { name: label }).querySelectorAll('canvas[data-src*="activated_background"]')
      .length;
  }

  it('shows a prayer stored under the name its replacement took over as selected', () => {
    renderSetup([PrayerType.EagleEye]);
    expect(activatedBackgrounds('Deadeye')).toBe(1);
  });

  it('leaves a square nothing is stored for unselected', () => {
    renderSetup([]);
    expect(activatedBackgrounds('Deadeye')).toBe(0);
  });

  it('deselects the stored base prayer when its replacement is displayed', () => {
    const onToggleSelection = renderSetup([PrayerType.EagleEye]);

    fireEvent.click(screen.getByRole('button', { name: 'Deadeye' }));

    expect(onToggleSelection).toHaveBeenCalledWith(PrayerType.EagleEye);
  });

  it('persists the base slot identity when the replacement square is selected', () => {
    const onToggleSelection = renderSetup([]);

    fireEvent.click(screen.getByRole('button', { name: 'Deadeye' }));

    expect(onToggleSelection).toHaveBeenCalledWith(PrayerType.EagleEye);
  });

  it('shows saved Piety as selected Zeal and toggles the persisted Piety identity', () => {
    const onToggleSelection = renderSetup([PrayerType.Piety], 84, true);
    expect(activatedBackgrounds('Zeal')).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Zeal' }));
    expect(onToggleSelection).toHaveBeenCalledWith(PrayerType.Piety);
  });

  it('disables quick-prayer slots above the configured Prayer level', () => {
    const onToggleSelection = renderSetup([], 1);
    const prayerButton = screen.getByRole('button', { name: 'Protect from Magic' });

    fireEvent.click(prayerButton);

    expect(prayerButton).toBeDisabled();
    expect(onToggleSelection).not.toHaveBeenCalled();
  });
});

function makeStats(overrides: Partial<Record<keyof PlayerStats, { current: number; max: number }>> = {}): PlayerStats {
  const base = { current: 99, max: 99 };
  return {
    attack: { ...base },
    strength: { ...base },
    defence: { ...base },
    ranged: { ...base },
    magic: { ...base },
    prayer: { ...base },
    hitpoints: { ...base },
    agility: { ...base },
    ...overrides,
  };
}

function stubSimulationState(
  stats: PlayerStats,
  mechanicsConfig: MechanicsConfig = DEFAULT_MECHANICS_CONFIG,
): SimulationState {
  return { stats, mechanicsConfig } as unknown as SimulationState;
}

describe('GamePanel skills tab', () => {
  it('renders a replay frame without mechanicsConfig', () => {
    renderWithProviders(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        simulationState={{ stats: makeStats() } as unknown as SimulationState}
        replayActiveTab="skills"
      />,
    );

    expect(screen.getByTestId('skill-cell-attack')).toBeDefined();
  });

  it('renders the skills tab from live simulationState.stats when driven by a replay frame', () => {
    const { container } = renderWithProviders(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        simulationState={stubSimulationState(makeStats({ attack: { current: 118, max: 99 } }))}
        replayActiveTab="skills"
      />,
    );

    const cell = screen.getByTestId('skill-cell-attack');
    expect(screen.getByTestId('skill-current-attack').textContent).toBe('118');
    expect(screen.getByTestId('skill-base-attack').textContent).toBe('99');
    expect(cell).toBeDefined();
    expect(container.querySelector('canvas')).not.toBeNull();
  });

  it('exposes a Skills tab button that switches the panel to the skills content', () => {
    renderWithProviders(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        inventory={createEmptyInventory()}
        simulationState={stubSimulationState(makeStats())}
      />,
    );

    // Given: the panel starts on the default (inventory) tab.
    expect(screen.queryByTestId('skill-cell-attack')).toBeNull();

    // When: the user clicks the Skills tab (a real button through TabIcon).
    const skillsButton = screen.getByRole('button', { name: /^Skills/ });
    expect(skillsButton.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(skillsButton);

    // Then: the skills content is shown.
    expect(screen.getByTestId('skill-cell-attack')).toBeDefined();
    expect(skillsButton.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('GamePanel combat tab', () => {
  const RANGED_PURE_LEVELS: PlayerBaseStats = {
    attack: 1,
    strength: 1,
    defence: 1,
    ranged: 99,
    magic: 1,
    prayer: 1,
    hitpoints: 10,
    agility: 99,
  };

  function renderCombatTab(stats: PlayerStats) {
    renderPanel('combat', { simulationState: stubSimulationState(stats) });
  }

  it('derives the combat level from the base stats the simulation holds', () => {
    renderCombatTab(createStatsFromBaseLevels(RANGED_PURE_LEVELS));

    expect(screen.getByText('Combat Lvl: 50')).toBeInTheDocument();
  });

  it('holds the combat level while current levels are boosted', () => {
    // Reading `current` rather than `max` would show 67 for these stats.
    renderCombatTab({
      ...createStatsFromBaseLevels(RANGED_PURE_LEVELS),
      attack: { current: 99, max: 1 },
      strength: { current: 99, max: 1 },
    });

    expect(screen.getByText('Combat Lvl: 50')).toBeInTheDocument();
  });
});

function tabBarElement(container: HTMLElement): HTMLElement {
  const tabBar = container.querySelector<HTMLElement>('[data-tutorial="tab-bar"]');
  if (tabBar === null) {
    throw new Error('Missing tab bar');
  }
  return tabBar;
}

describe('GamePanel tab bar', () => {
  it('paints the whole tab bar into one shared canvas instead of a canvas per sprite', () => {
    // Given: the panel renders its seven tabs.
    const { container } = renderWithProviders(
      <GamePanel activePrayer={null} onPrayerChange={vi.fn()} inventory={createEmptyInventory()} />,
    );

    // Then: the stones and icons share one canvas, and no per-sprite canvas is left behind.
    const tabBar = tabBarElement(container);
    expect(tabBar.querySelectorAll('button')).toHaveLength(7);
    expect(tabBar.querySelectorAll('canvas')).toHaveLength(1);
    expect(tabBar.querySelectorAll('canvas[data-src]')).toHaveLength(0);
  });

  it('places every stone and icon at its tab slot, with the selected stone on the active tab', () => {
    // Given: the panel renders its seven tabs.
    const { container } = renderWithProviders(
      <GamePanel activePrayer={null} onPrayerChange={vi.fn()} inventory={createEmptyInventory()} />,
    );
    const tabBar = tabBarElement(container);
    const sprites: LayerSprite[] = JSON.parse(tabBar.querySelector('canvas')?.getAttribute('data-sprites') ?? '[]');

    // Then: each 33x36 tab carries a stone, and the icons follow the rendered tab order.
    const slot = (index: number) => ({ x: index * 34, y: 0, w: 33, h: 36 });
    expect(sprites.filter((sprite) => sprite.src === PANEL.tabStone)).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((index) => ({ ...slot(index), src: PANEL.tabStone, width: 33, height: 36 })),
    );
    const stoneSources: string[] = [PANEL.tabStone, PANEL.tabStoneSelected];
    expect(sprites.filter((sprite) => !stoneSources.includes(sprite.src)).map((sprite) => sprite.src)).toEqual([
      TAB_ICONS.combat,
      TAB_ICONS.skills,
      TAB_ICONS.inventory,
      TAB_ICONS.equipment,
      TAB_ICONS.prayer,
      TAB_ICONS.spellbook,
      TAB_ICONS.settings,
    ]);

    // And: the selected stone sits on the one tab the buttons report as pressed.
    const activeIndex = Array.from(tabBar.querySelectorAll('button')).findIndex(
      (button) => button.getAttribute('aria-pressed') === 'true',
    );
    expect(activeIndex).toBe(2);
    expect(sprites.filter((sprite) => sprite.src === PANEL.tabStoneSelected)).toEqual([
      { ...slot(activeIndex), src: PANEL.tabStoneSelected, width: 33, height: 36 },
    ]);
  });
});

// A browser page translation rewriting text nodes React owns tears the live HUD down
// mid-render. Every layout's body comes through one `panelBody`, so one opt-out covers them all,
// including the Mobile layout's.
describe('GamePanel page translation', () => {
  it.each(['modern', 'fixed', 'classic'] as const)('opts the %s panel body out, and nothing else', (layout) => {
    const { container } = renderWithProviders(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        inventory={createEmptyInventory()}
        clientLayoutMode={layout}
      />,
    );

    const optedOut = container.querySelectorAll('.panel-surface[translate="no"]');
    expect(optedOut).toHaveLength(1);
    expect(optedOut[0].closest('[data-tutorial="game-panel"]')).not.toBeNull();
  });
});

describe('GamePanel mobile layout', () => {
  const frame = defaultOsmFrame({ width: 844, height: 390 }, { top: 0, right: 0, bottom: 0, left: 0 });

  function renderMobile(props: Partial<GamePanelProps> = {}) {
    return renderWithProviders(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        inventory={createEmptyInventory()}
        clientLayoutMode="mobile"
        mobileFrame={frame}
        viewportWidth={844}
        viewportHeight={390}
        {...props}
      />,
    );
  }

  /** The rail's own stone, not the hotkey for the same tab. */
  const railButton = (container: HTMLElement, name: RegExp) =>
    within(tabBarElement(container)).getByRole('button', { name });
  const hotkey = (name: string) =>
    within(screen.getByRole('toolbar', { name: 'Hotkeys' })).getByRole('button', { name });

  const railSprites = (container: HTMLElement): LayerSprite[] =>
    JSON.parse(tabBarElement(container).querySelector('canvas')?.getAttribute('data-sprites') ?? '[]');
  const sidePanel = (container: HTMLElement) => container.querySelector('[data-tutorial="game-panel"]');

  it('opens on the inventory, beside a two-column rail of 40x40 stones', () => {
    const { container } = renderMobile();
    expect(sidePanel(container)).not.toBeNull();
    expect(railButton(container, /^Inventory/)).toHaveAttribute('aria-pressed', 'true');

    const stones = railSprites(container).filter((sprite) => sprite.src === MOBILE.tabStone);
    // 13 tabs plus the expand stone; every one is 40x40 at a 39-row pitch.
    expect(stones).toHaveLength(14);
    expect(new Set(stones.map((stone) => stone.x))).toEqual(new Set([3, 85 - 43]));
    expect(stones.every((stone) => stone.w === 40 && stone.h === 40 && (stone.y - 3) % 39 === 0)).toBe(true);
    expect(railSprites(container).filter((sprite) => sprite.src === MOBILE.tabStoneSelected)).toEqual([
      { src: MOBILE.tabStoneSelected, x: 3, y: 3, w: 40, h: 40 },
    ]);
  });

  it('gives the side panel the native fill and the stonebox border it shares with Modern', () => {
    const { container } = renderMobile({ transparentSidePanel: false, hotkeysCloseSidePanel: true });
    const panel = sidePanel(container) as HTMLElement;
    const fill = [...panel.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].find((el) =>
      el.dataset.sprite?.includes('background_brighter'),
    );
    expect(fill?.style.opacity).toBe(String(105 / 255));
    expect(fill?.style.backgroundRepeat).toBe('repeat');
    expect([fill?.style.left, fill?.style.top, fill?.style.width, fill?.style.height]).toEqual([
      '1px',
      '1px',
      '202px',
      '273px',
    ]);
    // No guessed backing left over from before the native rule.
    expect(panel.innerHTML).not.toContain('side_panel_background');
  });

  it('closes the panel when its selected tab is tapped again, and opens another tab directly', () => {
    const { container } = renderMobile();
    const inventory = railButton(container, /^Inventory/);

    fireEvent.click(inventory);
    expect(sidePanel(container)).toBeNull();
    expect(inventory).toHaveAttribute('aria-pressed', 'false');
    expect(railSprites(container).some((sprite) => sprite.src === MOBILE.tabStoneSelected)).toBe(false);

    fireEvent.click(inventory);
    expect(sidePanel(container)).not.toBeNull();

    fireEvent.click(railButton(container, /^Prayer/));
    expect(sidePanel(container)).not.toBeNull();
    expect(railButton(container, /^Prayer/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('reopens a closed panel on its own tab from the tab’s keybind', () => {
    const { container } = renderMobile({ transparentSidePanel: false, hotkeysCloseSidePanel: true });
    fireEvent.click(railButton(container, /^Prayer/));
    fireEvent.click(railButton(container, /^Prayer/));
    expect(sidePanel(container)).toBeNull();

    // F5, Prayer's default: the tab is already active, so only an explicit open shows it.
    fireEvent.keyDown(window, { key: 'F5' });
    expect(sidePanel(container)).not.toBeNull();
    expect(railButton(container, /^Prayer/)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { key: 'F5' });
    expect(sidePanel(container)).not.toBeNull();
  });

  it('reopens a closed panel on Prayer for quick-prayer setup', () => {
    const panel = (quickPrayerSetupOpen: boolean) => (
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        inventory={createEmptyInventory()}
        clientLayoutMode="mobile"
        mobileFrame={frame}
        viewportWidth={844}
        viewportHeight={390}
        quickPrayerSetupOpen={quickPrayerSetupOpen}
      />
    );
    const { container, rerender } = renderWithProviders(panel(false));
    fireEvent.click(railButton(container, /^Prayer/));
    fireEvent.click(railButton(container, /^Prayer/));
    expect(sidePanel(container)).toBeNull();

    rerender(panel(true));
    expect(sidePanel(container)).not.toBeNull();
    expect(railButton(container, /^Prayer/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('reopens the panel for a repeat setup request while setup is already open', () => {
    const panel = (quickPrayerSetupRequest: number) => (
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        inventory={createEmptyInventory()}
        clientLayoutMode="mobile"
        mobileFrame={frame}
        viewportWidth={844}
        viewportHeight={390}
        quickPrayerSetupOpen
        quickPrayerSetupRequest={quickPrayerSetupRequest}
      />
    );
    const { container, rerender } = renderWithProviders(panel(1));
    expect(sidePanel(container)).not.toBeNull();
    fireEvent.click(railButton(container, /^Prayer/));
    expect(sidePanel(container)).toBeNull();

    // The flag stays true; only the request count says "show it again".
    rerender(panel(2));
    expect(sidePanel(container)).not.toBeNull();
    expect(railButton(container, /^Prayer/)).toHaveAttribute('aria-pressed', 'true');
  });

  it('hangs the status bars off the side panel, outside the box the panel clips to', () => {
    const { container } = renderMobile({ statusBarsEnabled: true });
    const panel = sidePanel(container) as HTMLElement;
    // The pinned panel clips; the bars sit at negative x, so inside it neither would show.
    expect(panel.style.overflow).toBe('hidden');

    const bars = container.querySelector<HTMLElement>('[data-status-bars="mobile"]');
    if (!bars) throw new Error('status bars not rendered');
    expect(panel.contains(bars)).toBe(false);
    for (let el = bars.parentElement; el; el = el.parentElement) expect(el.style.overflow).not.toBe('hidden');
    expect(Number.parseFloat(bars.style.left)).toBeLessThan(0);

    // Laid over the panel's own box, at the zoom it applies, in the shell's coordinates.
    const host = bars.closest<HTMLElement>('[data-mobile-side-overlay]');
    if (!host) throw new Error('overlay host not found');
    expect(panel.style.transform).toBe(`translate3d(${host.style.left}, ${host.style.top}, 0)`);
    expect([host.style.width, host.style.height]).toEqual([panel.style.width, panel.style.height]);
    const panelZoom = (panel.firstElementChild as HTMLElement).style.zoom;
    expect((bars.parentElement as HTMLElement).style.zoom).toBe(panelZoom);

    // Closed, the panel takes its bars with it.
    fireEvent.click(railButton(container, /^Inventory/));
    expect(container.querySelector('[data-status-bars]')).toBeNull();
  });

  it('collapses the rail to its left column and swaps the expand icon', () => {
    const { container } = renderMobile();
    expect(railSprites(container).some((sprite) => sprite.src === MOBILE.showLess)).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));

    const sprites = railSprites(container);
    expect(sprites.some((sprite) => sprite.src === MOBILE.showMore)).toBe(true);
    // 601:85/86: the right column still draws, right-anchored at x=15 under the left one, and
    // the 9-slice middle covers it at IF3 transparency 140. It is not reachable.
    expect(within(tabBarElement(container)).queryByRole('button', { name: /^Skills/ })).toBeNull();
    expect(new Set(sprites.filter((sprite) => sprite.src === MOBILE.tabStone).map((stone) => stone.x))).toEqual(
      new Set([3, 58 - 3 - 40]),
    );
    const cover = sprites.find((sprite) => sprite.src === MOBILE.railMiddle && sprite.opacity !== undefined);
    expect(cover).toMatchObject({ x: 3, y: 3, w: 58 - 6, h: 280 - 6 });
    expect(cover?.opacity).toBeCloseTo(115 / 255);
    // The rail keeps its 9-slice frame collapsed.
    expect(sprites.some((sprite) => sprite.src === MOBILE.railTopLeft)).toBe(true);
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute('aria-expanded', 'false');
  });

  describe('hotkeys bar', () => {
    it('shows Jagex’s bossing loadout in order and lights its open panel', () => {
      renderMobile();
      const bar = screen.getByRole('toolbar', { name: 'Hotkeys' });
      expect(
        within(bar)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label')),
      ).toEqual(['Toggle run', 'Special attack', 'Prayer Tab', 'Spellbook Tab', 'Quick-prayers', 'Hide hotkeys']);
      expect(hotkey('Prayer Tab')).toHaveAttribute('aria-pressed', 'false');
      fireEvent.click(hotkey('Prayer Tab'));
      expect(hotkey('Prayer Tab')).toHaveAttribute('aria-pressed', 'true');
    });

    it('opens and closes panels through the rail path, and reopens the same hidden tab', () => {
      const { container } = renderMobile({ mobileHotkeys: [6, 8, 9, 21, 23] });

      fireEvent.click(hotkey('Inventory Tab'));
      expect(sidePanel(container)).toBeNull();
      expect(railButton(container, /^Inventory/)).toHaveAttribute('aria-pressed', 'false');

      // The tab never changed, so only the explicit open brings the panel back.
      fireEvent.click(hotkey('Inventory Tab'));
      expect(sidePanel(container)).not.toBeNull();
      expect(railButton(container, /^Inventory/)).toHaveAttribute('aria-pressed', 'true');

      fireEvent.click(hotkey('Prayer Tab'));
      expect(railButton(container, /^Prayer/)).toHaveAttribute('aria-pressed', 'true');
      expect(hotkey('Prayer Tab')).toHaveAttribute('aria-pressed', 'true');
      expect(hotkey('Inventory Tab')).toHaveAttribute('aria-pressed', 'false');
    });

    it('presses the very quick-prayer callback the orb uses, and lights while it is on', () => {
      const onQuickPrayerToggle = vi.fn();
      const { rerender } = renderMobile({ onQuickPrayerToggle });
      fireEvent.click(hotkey('Quick-prayers'));
      expect(onQuickPrayerToggle).toHaveBeenCalledTimes(1);
      expect(hotkey('Quick-prayers')).toHaveAttribute('aria-pressed', 'false');

      rerender(
        <GamePanel
          activePrayer={null}
          onPrayerChange={vi.fn()}
          inventory={createEmptyInventory()}
          clientLayoutMode="mobile"
          mobileFrame={frame}
          onQuickPrayerToggle={onQuickPrayerToggle}
          quickPrayersActive
        />,
      );
      expect(hotkey('Quick-prayers')).toHaveAttribute('aria-pressed', 'true');
    });

    it('arms the special attack only with a special-attack weapon, showing queued toggles', () => {
      const onSpecialAttackToggle = vi.fn();
      const { container, unmount } = renderMobile({ onSpecialAttackToggle, hasSpecialAttack: false });
      fireEvent.click(hotkey('Special attack'));
      expect(onSpecialAttackToggle).not.toHaveBeenCalled();
      const barSprites = (): LayerSprite[] =>
        JSON.parse(
          container.querySelector('[data-tutorial="mobile-hotkeys"] canvas')?.getAttribute('data-sprites') ?? '[]',
        );
      expect(barSprites().some((sprite) => sprite.src === MOBILE.hotkeyStoneDisabled)).toBe(true);
      unmount();

      const armed = renderMobile({
        onSpecialAttackToggle,
        hasSpecialAttack: true,
        isSpecialAttackActive: false,
        pendingSpecialAttackToggles: 1,
      });
      fireEvent.click(hotkey('Special attack'));
      expect(onSpecialAttackToggle).toHaveBeenCalledTimes(1);
      // One queued toggle shows the bar as it will be: on.
      expect(hotkey('Special attack')).toHaveAttribute('aria-pressed', 'true');
      const sprites: LayerSprite[] = JSON.parse(
        armed.container.querySelector('[data-tutorial="mobile-hotkeys"] canvas')?.getAttribute('data-sprites') ?? '[]',
      );
      expect(sprites.some((sprite) => sprite.src === MOBILE.hotkeyStoneSpecialOn)).toBe(true);
    });

    it('folds down to its master toggle and back', () => {
      renderMobile();
      fireEvent.click(screen.getByRole('button', { name: 'Hide hotkeys' }));
      expect(screen.queryByRole('button', { name: 'Prayer Tab' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Show hotkeys' }));
      expect(hotkey('Prayer Tab')).toBeTruthy();
    });

    it('skips empty slots, closing up the bar', () => {
      renderMobile({ mobileHotkeys: [0, 8, 0, 0, 22] });
      const bar = screen.getByRole('toolbar', { name: 'Hotkeys' });
      expect(
        within(bar)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label')),
      ).toEqual(['Prayer Tab', 'Toggle run', 'Hide hotkeys']);
    });
  });

  describe('on a touch-only device, under a wobbling finger', () => {
    afterEach(() => {
      vi.restoreAllMocks();
      vi.useRealTimers();
    });

    function renderTouchMobile(props: Partial<GamePanelProps> = {}) {
      vi.spyOn(window, 'matchMedia').mockImplementation(
        (query: string) =>
          ({
            matches: query.includes('coarse'),
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          }) as unknown as MediaQueryList,
      );
      vi.useFakeTimers();
      return renderMobile(props);
    }

    /**
     * A touch on `target`, laid out as a 27 px box (a 34 px prayer at the smallest Mobile
     * scale) at (100, 100), that lands at the first point, wobbles through the rest and lifts at
     * the last, followed by the click the browser still sends.
     */
    function wobblyTap(target: HTMLElement, path: readonly (readonly [number, number])[]) {
      target.getBoundingClientRect = () => new DOMRect(100, 100, 27, 27);
      const send = (type: string, [clientX, clientY]: readonly [number, number]) =>
        fireEvent(
          target,
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerType: 'touch',
            pointerId: 1,
            isPrimary: true,
            clientX,
            clientY,
          }),
        );
      send('pointerdown', path[0]);
      for (const point of path.slice(1, -1)) send('pointermove', point);
      act(() => vi.advanceTimersByTime(150));
      send('pointerup', path[path.length - 1]);
      const [clientX, clientY] = path[path.length - 1];
      fireEvent.click(target, { button: 0, detail: 1, clientX, clientY });
    }

    // 15-20 px of travel from where each lands, all of it on the 100-127 box.
    const WOBBLE = [
      [104, 104],
      [120, 108],
      [122, 122],
      [118, 121],
    ] as const;
    // Lands on the box, then lifts well clear of it.
    const OFF = [
      [104, 104],
      [104, 160],
    ] as const;

    it('switches tab once on a rail stone, with or without a menu, and not on a release off it', () => {
      const { container } = renderTouchMobile();

      wobblyTap(railButton(container, /^Prayer/), WOBBLE);
      expect(railButton(container, /^Prayer/)).toHaveAttribute('aria-pressed', 'true');

      wobblyTap(railButton(container, /^Equipment/), OFF);
      expect(railButton(container, /^Prayer/)).toHaveAttribute('aria-pressed', 'true');

      // No menu on this stone; tapping the open tab again closes the panel, so a second
      // activation would reopen it.
      wobblyTap(railButton(container, /^Inventory/), WOBBLE);
      expect(railButton(container, /^Inventory/)).toHaveAttribute('aria-pressed', 'true');
      wobblyTap(railButton(container, /^Inventory/), WOBBLE);
      expect(sidePanel(container)).toBeNull();
    });

    it('folds the rail once on a wobbling tap of its expand stone', () => {
      renderTouchMobile();

      wobblyTap(screen.getByRole('button', { name: 'Show less' }), WOBBLE);

      expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute('aria-expanded', 'false');
    });

    it('toggles a prayer once, and none for a release off it', () => {
      const onPrayerChange = vi.fn();
      const { container } = renderTouchMobile({ onPrayerChange });
      wobblyTap(railButton(container, /^Prayer/), WOBBLE);

      wobblyTap(buttonForAltText('Protect from Magic'), WOBBLE);
      expect(onPrayerChange).toHaveBeenCalledExactlyOnceWith(PrayerType.ProtectMagic);

      wobblyTap(buttonForAltText('Protect from Missiles'), OFF);
      expect(onPrayerChange).toHaveBeenCalledOnce();
    });

    it('casts a spell once, on mousedown and on click alike, and none for a release off it', () => {
      const onMarkOfDarknessCast = vi.fn();
      const onHomeTeleportCast = vi.fn();
      const { container } = renderTouchMobile({ onMarkOfDarknessCast, onHomeTeleportCast });
      wobblyTap(railButton(container, /^Spellbook/), WOBBLE);

      wobblyTap(buttonForAltText('Mark of Darkness'), WOBBLE);
      wobblyTap(buttonForAltText('Arceuus Home Teleport'), WOBBLE);
      wobblyTap(buttonForAltText('Mark of Darkness'), OFF);

      expect(onMarkOfDarknessCast).toHaveBeenCalledOnce();
      expect(onHomeTeleportCast).toHaveBeenCalledOnce();
    });

    it('presses a hotkey once, tab and orb alike, and none for a release off it', () => {
      const onQuickPrayerToggle = vi.fn();
      renderTouchMobile({ onQuickPrayerToggle });

      wobblyTap(hotkey('Prayer Tab'), WOBBLE);
      expect(hotkey('Prayer Tab')).toHaveAttribute('aria-pressed', 'true');

      wobblyTap(hotkey('Quick-prayers'), WOBBLE);
      wobblyTap(hotkey('Quick-prayers'), OFF);
      expect(onQuickPrayerToggle).toHaveBeenCalledOnce();
    });
  });
});

describe('GamePanel under a replayed panel arrangement', () => {
  // `hidden` holds icon names; the button carries the label. Keeping both here is what
  // makes the two assertions below actually exercise the filter rather than pass blindly.
  const HIDDEN_PRAYER_ICON = 'protect_from_magic';
  const HIDDEN_PRAYER_LABEL = 'Protect from Magic';
  /** First row of the prayer filter screen, which stands in for the screen being up. */
  const PRAYER_FILTER_ROW_LABEL = 'Show lower tiers of tiered prayers';

  function makePanelPresentation(modes: Partial<ReplayPanelModes> = {}): ReplayPanelPresentation {
    return {
      filters: {
        prayer: {
          hidden: [HIDDEN_PRAYER_ICON],
          order: null,
          filterOptions: { showLowerTiers: true, showTieredOverMultiskill: true, showRapidHealing: true },
        },
        spellbook: { hidden: {}, order: {}, activeCategories: ['combat', 'teleport', 'utility'], filterOptions: {} },
      },
      modes: {
        prayerReordering: false,
        prayerFiltering: false,
        spellReordering: false,
        spellFiltering: false,
        ...modes,
      },
    };
  }

  function makePresentation(panelPresentation: ReplayPanelPresentation): ReplayPresentationState {
    const position = { x: 0, y: 0, anchorX: 'right', anchorY: 'bottom' } as const;
    return {
      clientLayoutMode: 'modern',
      frame: { width: 1280, height: 720 },
      insets: { left: 0, right: 0 },
      uiScale: 1,
      panels: {
        gamePanel: position,
        minimap: { ...position, anchorY: 'top' },
        compactOrbs: { ...position, anchorY: 'top', y: 60 },
        infobox: null,
        zukSetTimer: null,
      },
      variants: {
        activeGamePanelTab: 'prayer',
        compactOrbsEnabled: false,
        compactOrbsLayout: 'vertical',
        compactOrbsOrder: ['hitpoints', 'prayer', 'run', 'special'],
        infoboxPinTarget: 'inventory',
        showCoordinates: false,
        panelPresentation,
      },
    };
  }

  function renderReplayedPanel(
    tab: NonNullable<GamePanelProps['replayActiveTab']>,
    panelPresentation: ReplayPanelPresentation,
    reportPanelPresentation: (panel: ReplayPanelPresentation) => void = vi.fn(),
    props: Partial<GamePanelProps> = {},
  ) {
    const Providers = ({ children }: { children: ReactNode }) => (
      <TooltipProvider>
        <ContextMenuProvider>
          <ReplayPresentationProvider
            presentation={makePresentation(panelPresentation)}
            reportPanelPresentation={reportPanelPresentation}
            reportMinimapZoom={() => {}}
          >
            {children}
          </ReplayPresentationProvider>
        </ContextMenuProvider>
      </TooltipProvider>
    );
    return render(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        inventory={makeInventory()}
        prayerState={{ points: 99, maxPoints: 99, drainCounter: 0, activePrayers: [], prayerActivationTicks: {} }}
        replayActiveTab={tab}
        {...props}
      />,
      { wrapper: Providers },
    );
  }

  describe('Modern panel visibility', () => {
    type Tab = NonNullable<GamePanelProps['activeTab']>;
    type Ownership = 'presentation' | 'replay-tab' | 'controlled-tab';

    function renderAcrossReplay(ownership: Ownership) {
      const report = vi.fn<(panel: ReplayPanelPresentation) => void>();
      function Harness({
        replayTab,
        modes,
        setupRequest,
      }: {
        replayTab: Tab | null;
        modes?: Partial<ReplayPanelModes>;
        setupRequest?: number;
      }) {
        const [liveTab, setLiveTab] = useState<Tab>('inventory');
        return (
          <ReplayPresentationProvider
            presentation={
              replayTab && ownership === 'presentation' ? makePresentation(makePanelPresentation(modes)) : null
            }
            reportPanelPresentation={report}
            reportMinimapZoom={() => {}}
          >
            <GamePanel
              activePrayer={null}
              onPrayerChange={vi.fn()}
              activeTab={replayTab ? (ownership === 'replay-tab' ? undefined : replayTab) : liveTab}
              replayActiveTab={replayTab && ownership === 'replay-tab' ? replayTab : undefined}
              onActiveTabChange={replayTab ? undefined : setLiveTab}
              hotkeysCloseSidePanel
              quickPrayerSetupOpen={setupRequest !== undefined}
              quickPrayerSetupRequest={setupRequest}
            />
          </ReplayPresentationProvider>
        );
      }
      const view = renderWithProviders(<Harness replayTab={null} />);
      return {
        report,
        rerender: (replayTab: Tab | null, modes?: Partial<ReplayPanelModes>, setupRequest?: number) =>
          view.rerender(<Harness replayTab={replayTab} modes={modes} setupRequest={setupRequest} />),
      };
    }

    const panelBody = () => document.querySelector('[data-tutorial="game-panel"]');
    const ownOpen = (report: Mock<(panel: ReplayPanelPresentation) => void>) =>
      report.mock.lastCall?.[0].modes.modernPanelOpen;

    it('reports live close and reopen without changing the active tab', () => {
      const { report } = renderAcrossReplay('presentation');
      expect(ownOpen(report)).toBe(true);
      fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
      expect(ownOpen(report)).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
      expect(ownOpen(report)).toBe(true);
      expect(screen.getByRole('button', { name: /^Inventory/ })).toHaveAttribute('aria-pressed', 'true');
    });

    it('plays recorded close/reopen, defaults old absence to open, and keeps controls inert', () => {
      const { report, rerender } = renderAcrossReplay('presentation');
      fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
      expect(ownOpen(report)).toBe(false);

      for (const open of [false, true, false, undefined]) {
        rerender('inventory', open === undefined ? {} : { modernPanelOpen: open });
        expect(panelBody() !== null).toBe(open ?? true);
        fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
        fireEvent.keyDown(window, { key: 'F3' });
        fireEvent.click(screen.getByRole('button', { name: /^Prayer/ }));
        expect(panelBody() !== null).toBe(open ?? true);
        expect(ownOpen(report)).toBe(false);
      }
      rerender(null);
      expect(panelBody()).toBeNull();
      expect(ownOpen(report)).toBe(false);
    });

    it.each([
      'presentation',
      'replay-tab',
      'controlled-tab',
    ] as const)('restores viewer closed state across %s entry, tab changes, commands and exit', (ownership) => {
      const { report, rerender } = renderAcrossReplay(ownership);
      fireEvent.click(screen.getByRole('button', { name: /^Inventory/ }));
      expect(panelBody()).toBeNull();

      // Even entering on the same tab, with no presentation in the replay, is ownership.
      rerender('inventory');
      expect(panelBody()).not.toBeNull();
      rerender('equipment');
      rerender('prayer', {}, 1);
      expect(ownOpen(report)).toBe(false);
      rerender(null, {}, 1);
      expect(panelBody()).toBeNull();
      expect(ownOpen(report)).toBe(false);

      // A new live request on the same tab reopens it; the replay's outstanding one did not.
      rerender(null, {}, 2);
      expect(panelBody()).not.toBeNull();
      expect(screen.getByRole('button', { name: /^Prayer/ })).toHaveAttribute('aria-pressed', 'true');
      fireEvent.click(screen.getByRole('button', { name: /^Prayer/ }));
      expect(panelBody()).toBeNull();
      rerender(null, {}, 3);
      expect(panelBody()).not.toBeNull();
      expect(screen.getByRole('button', { name: /^Prayer/ })).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('in the Mobile layout', () => {
    const mobileProps: Partial<GamePanelProps> = {
      clientLayoutMode: 'mobile',
      mobileFrame: defaultOsmFrame({ width: 844, height: 390 }, { top: 0, right: 0, bottom: 0, left: 0 }),
      viewportWidth: 844,
      viewportHeight: 390,
    };
    const recorded = {
      panelOpen: false,
      tabsCollapsed: true,
      panelFromHotkey: false,
      hotkeysCollapsed: false,
      hotkeysOpenOnLeft: false,
      hotkeys: [22, 0, 0, 0, 0],
    } as const;

    it("draws the recorder's panel, rail and hotkeys, and leaves their controls inert", () => {
      const { container } = renderReplayedPanel(
        'prayer',
        makePanelPresentation({ mobile: { ...recorded, hotkeys: [...recorded.hotkeys] } }),
        vi.fn(),
        mobileProps,
      );
      const rail = within(tabBarElement(container));
      expect(container.querySelector('[data-tutorial="game-panel"]')).toBeNull();
      expect(rail.getByRole('button', { name: 'Show more' })).toBeTruthy();
      const bar = screen.getByRole('toolbar', { name: 'Hotkeys' });
      expect(within(bar).getByRole('button', { name: 'Toggle run' })).toBeTruthy();
      expect(within(bar).queryByRole('button', { name: 'Inventory Tab' })).toBeNull();

      fireEvent.click(rail.getByRole('button', { name: /^Prayer/ }));
      fireEvent.click(rail.getByRole('button', { name: 'Show more' }));
      fireEvent.click(screen.getByRole('button', { name: 'Hide hotkeys' }));
      expect(container.querySelector('[data-tutorial="game-panel"]')).toBeNull();
      expect(rail.getByRole('button', { name: 'Show more' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Hide hotkeys' })).toBeTruthy();
    });

    it("reports the viewer's own Mobile state, never the recording's", () => {
      const report = vi.fn();
      renderReplayedPanel(
        'prayer',
        makePanelPresentation({ mobile: { ...recorded, hotkeys: [22, 0, 0, 0, 0] } }),
        report,
        {
          ...mobileProps,
          mobileHotkeys: [6, 8, 9, 21, 23],
        },
      );
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({
          modes: expect.objectContaining({
            mobile: {
              panelOpen: true,
              tabsCollapsed: false,
              panelFromHotkey: false,
              hotkeysCollapsed: false,
              hotkeysOpenOnLeft: false,
              hotkeys: [6, 8, 9, 21, 23],
            },
          }),
        }),
      );
    });

    describe('when playback ends', () => {
      type Tab = NonNullable<GamePanelProps['activeTab']>;
      let selectLiveTab: (tab: Tab) => void = () => {};

      /**
       * One GamePanel kept mounted across playback, fed as Grid feeds it: the live tab while
       * live, the recording's while replaying, with tab changes going nowhere under a replay.
       */
      function Harness({
        replayTab,
        initialTab,
        report,
        props,
      }: {
        replayTab: Tab | null;
        initialTab: Tab;
        report: (panel: ReplayPanelPresentation) => void;
        props: Partial<GamePanelProps>;
      }) {
        const [liveTab, setLiveTab] = useState<Tab>(initialTab);
        selectLiveTab = setLiveTab;
        return (
          <TooltipProvider>
            <ContextMenuProvider>
              <ReplayPresentationProvider
                presentation={replayTab ? makePresentation(makePanelPresentation()) : null}
                reportPanelPresentation={report}
                reportMinimapZoom={() => {}}
              >
                <GamePanel
                  activePrayer={null}
                  onPrayerChange={vi.fn()}
                  inventory={makeInventory()}
                  activeTab={replayTab ?? liveTab}
                  onActiveTabChange={replayTab ? undefined : setLiveTab}
                  {...mobileProps}
                  {...props}
                />
              </ReplayPresentationProvider>
            </ContextMenuProvider>
          </TooltipProvider>
        );
      }

      function renderAcrossReplay(initialTab: Tab, props: Partial<GamePanelProps> = {}) {
        const report = vi.fn<(panel: ReplayPanelPresentation) => void>();
        const tree = (replayTab: Tab | null, extra: Partial<GamePanelProps> = {}) => (
          <Harness replayTab={replayTab} initialTab={initialTab} report={report} props={{ ...props, ...extra }} />
        );
        const view = render(tree(null));
        return {
          ...view,
          report,
          rerenderWith: (replayTab: Tab | null, extra?: Partial<GamePanelProps>) =>
            view.rerender(tree(replayTab, extra)),
        };
      }

      const sidePanel = (container: HTMLElement) => container.querySelector('[data-tutorial="game-panel"]');
      const railButton = (container: HTMLElement, name: RegExp) =>
        within(tabBarElement(container)).getByRole('button', { name });
      const lastOwnMobileModes = (report: Mock<(panel: ReplayPanelPresentation) => void>) =>
        report.mock.lastCall?.[0].modes.mobile;

      afterEach(() => {
        selectLiveTab = () => {};
      });

      it('leaves a panel the viewer had closed closed', () => {
        const { container, report, rerenderWith } = renderAcrossReplay('prayer');
        fireEvent.click(railButton(container, /^Prayer/));
        expect(sidePanel(container)).toBeNull();

        rerenderWith('equipment');
        expect(railButton(container, /^Equipment/)).toHaveAttribute('aria-pressed', 'true');
        rerenderWith(null);

        expect(sidePanel(container)).toBeNull();
        expect(lastOwnMobileModes(report)).toMatchObject({ panelOpen: false });

        // Ownership has passed back: a genuine selection opens the panel again.
        act(() => selectLiveTab('spellbook'));
        expect(sidePanel(container)).not.toBeNull();
        expect(railButton(container, /^Spellbook/)).toHaveAttribute('aria-pressed', 'true');
        expect(lastOwnMobileModes(report)).toMatchObject({ panelOpen: true, panelFromHotkey: false });
      });

      it('leaves a panel a hotkey opened on the left', () => {
        const { container, report, rerenderWith } = renderAcrossReplay('inventory', {
          mobileHotkeysOpenOnLeft: true,
        });
        fireEvent.click(
          within(screen.getByRole('toolbar', { name: 'Hotkeys' })).getByRole('button', { name: 'Prayer Tab' }),
        );

        rerenderWith('equipment');
        rerenderWith(null);

        expect(lastOwnMobileModes(report)).toMatchObject({ panelOpen: true, panelFromHotkey: true });
        expect(railButton(container, /^Prayer/)).toHaveAttribute('aria-pressed', 'true');
      });

      it('does not re-show an outstanding quick-prayer setup request, only a new one', () => {
        const setup = (request: number) => ({ quickPrayerSetupOpen: true, quickPrayerSetupRequest: request });
        const { container, rerenderWith } = renderAcrossReplay('inventory');
        rerenderWith(null, setup(1));
        expect(railButton(container, /^Prayer/)).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(railButton(container, /^Prayer/));
        expect(sidePanel(container)).toBeNull();

        rerenderWith('equipment', setup(1));
        rerenderWith(null, setup(1));
        expect(sidePanel(container)).toBeNull();

        rerenderWith(null, setup(2));
        expect(sidePanel(container)).not.toBeNull();
        expect(railButton(container, /^Prayer/)).toHaveAttribute('aria-pressed', 'true');
      });
    });
  });

  it('reports no Mobile state outside the Mobile layout', () => {
    const report = vi.fn();
    renderReplayedPanel('prayer', makePanelPresentation(), report);
    expect(report.mock.lastCall?.[0].modes).not.toHaveProperty('mobile');
  });

  it('hides a prayer the recording had hidden, which the viewer has not', () => {
    renderReplayedPanel('prayer', makePanelPresentation());

    expect(screen.queryByRole('button', { name: HIDDEN_PRAYER_LABEL })).toBeNull();
  });

  // RuneLite's PrayerReorder leaves a hidden prayer's cell empty rather than sliding the
  // rest of the (reordered) book up into it; only the spellbook compacts.
  it('keeps every prayer in its reordered cell while another is hidden', () => {
    const order = PRAYER_GRID.map((slot) => slot.icon).reverse();
    const presentation = makePanelPresentation();
    renderReplayedPanel('prayer', {
      ...presentation,
      filters: { ...presentation.filters, prayer: { ...presentation.filters.prayer, order } },
    });

    const cellOf = (icon: string) => {
      const button = document.querySelector<HTMLElement>(`[data-prayer-icon="${icon}"]`);
      return button && { x: Number.parseFloat(button.style.left), y: Number.parseFloat(button.style.top) };
    };
    const hiddenIndex = order.indexOf(HIDDEN_PRAYER_ICON);
    expect(cellOf(HIDDEN_PRAYER_ICON)).toBeNull();
    for (const index of [hiddenIndex - 1, hiddenIndex + 1, order.length - 1]) {
      expect(cellOf(order[index])).toEqual(prayerSlotOrigin(index));
    }
  });

  // Reorder mode returns the UNFILTERED grid, so the recorded `hidden` only
  // reproduces the recorder's panel when the recorded mode comes with it.
  it('shows that same prayer when the recording was in reorder mode', () => {
    renderReplayedPanel('prayer', makePanelPresentation({ prayerReordering: true }));

    expect(screen.queryByRole('button', { name: HIDDEN_PRAYER_LABEL })).not.toBeNull();
  });

  it('withholds a filter subview that a recorded arrangement without it cannot describe', () => {
    // The screen REPLACES the grid, so falling back to the VIEWER's open filter screen
    // would show one its recorder never saw and leave it up once playback ended.
    renderReplayedPanel('prayer', makePanelPresentation({ prayerFiltering: true }));

    expect(screen.queryByText(PRAYER_FILTER_ROW_LABEL)).toBeNull();
  });

  it('shows the filter subview the recording did capture', () => {
    renderReplayedPanel('prayer', makePanelPresentation({ prayerFiltering: true, prayerFilterViewOpen: true }));

    expect(screen.queryByText(PRAYER_FILTER_ROW_LABEL)).not.toBeNull();
  });

  it('shows the quick-prayer setup the recording was on, not the prayer book under it', () => {
    // Both bodies are a grid of prayer buttons; only the prayer book carries the points
    // readout, so it is what separates them.
    renderReplayedPanel('prayer', makePanelPresentation({ quickPrayerSetupOpen: true }));

    expect(screen.queryByText('99 / 99')).toBeNull();
  });

  it('shows the equipment stats readout the recording was on', () => {
    renderReplayedPanel('equipment', makePanelPresentation({ equipmentView: 'stats' }));

    expect(screen.queryByRole('button', { name: 'Back to equipment' })).not.toBeNull();
  });

  it('leaves a control the replay overrides inert rather than merely masked', () => {
    // The override wins the render either way; what the click must not do is land in the
    // viewer's own state, where it would surface the moment playback ended.
    renderReplayedPanel('equipment', makePanelPresentation({ equipmentView: 'stats' }));

    fireEvent.click(screen.getByRole('button', { name: 'Back to equipment' }));

    expect(screen.queryByRole('button', { name: 'Back to equipment' })).not.toBeNull();
  });

  it('reports the arrangement the viewer owns, never the replayed override', () => {
    const reportPanelPresentation = vi.fn<(panel: ReplayPanelPresentation) => void>();

    renderReplayedPanel('prayer', makePanelPresentation({ prayerReordering: true }), reportPanelPresentation);

    const reported = reportPanelPresentation.mock.calls.at(-1)?.[0];
    expect(reported?.modes).toEqual({
      prayerReordering: false,
      prayerFiltering: false,
      spellReordering: false,
      spellFiltering: false,
      quickPrayerSetupOpen: false,
      autocastPickerStyleIndex: null,
      equipmentView: 'equipment',
      settingsSubTab: 'audio',
      prayerFilterViewOpen: false,
      spellFilterViewOpen: false,
      modernPanelOpen: true,
    });
    expect(reported?.filters.prayer.hidden).toEqual([]);
  });
});

/**
 * Clicking the spell has to reach the simulation. These bind a real engine to the rendered
 * button so the whole chain is under test: button -> SpellbookContent -> GamePanel -> handler
 * -> `applyAction` -> timers.
 */
describe('Death Charge, from the rendered spellbook to the engine', () => {
  function bootEngine(rite: boolean) {
    const engine = new SimulationEngine({
      encounter: new YamaEncounter(SENSORY_CLOUDING_CONFIG, 7),
      startPos: [31, 39],
    });
    engine.setMechanicsConfig({
      yamaMageRange: false,
      waves: false,
      fireballs: false,
      voidFlares: false,
      infiniteHealth: true,
      doubleDeathCharge: rite,
    });
    // The engine gates the cast on the spell's runes, so a bare player cannot cast at all. The
    // shipped Sensory preset is what a player actually arrives with.
    const preset = EQUIPMENT_PRESETS.yama_p3_sensory.mage;
    engine.setEquipment(preset.equipment);
    engine.setInventory([...preset.inventory]);
    if (preset.supplies) engine.setCombatSupplies(preset.supplies);
    return engine;
  }

  function timersOf(engine: SimulationEngine) {
    return engine.getState().combatTimers;
  }

  it('arms the charge when the spell is clicked', () => {
    const engine = bootEngine(true);
    renderPanel('spellbook', { onDeathChargeCast: () => engine.applyAction({ type: 'castDeathCharge' }) });
    expect(timersOf(engine).deathChargeProcsRemaining).toBe(0);

    fireEvent(buttonForAltText('Death Charge'), mouseEvent('mousedown', { button: 0 }, 1000));

    expect(timersOf(engine).deathChargeProcsRemaining).toBe(DEATH_CHARGE_PROCS_UPGRADED);
    expect(timersOf(engine).deathChargeActiveTicks).toBe(DEATH_CHARGE_DURATION_TICKS);
    expect(timersOf(engine).deathChargeCooldownTicks).toBe(DEATH_CHARGE_COOLDOWN_TICKS);
  });

  it('arms a single charge without the double toggle', () => {
    const engine = bootEngine(false);
    renderPanel('spellbook', { onDeathChargeCast: () => engine.applyAction({ type: 'castDeathCharge' }) });

    fireEvent(buttonForAltText('Death Charge'), mouseEvent('mousedown', { button: 0 }, 1000));

    expect(timersOf(engine).deathChargeProcsRemaining).toBe(DEATH_CHARGE_PROCS);
  });

  it('a second click while on cooldown changes nothing', () => {
    const engine = bootEngine(true);
    renderPanel('spellbook', { onDeathChargeCast: () => engine.applyAction({ type: 'castDeathCharge' }) });
    const spell = buttonForAltText('Death Charge');

    fireEvent(spell, mouseEvent('mousedown', { button: 0 }, 1000));
    engine.advanceTick([31, 39]);
    const afterOne = timersOf(engine).deathChargeActiveTicks;

    fireEvent(spell, mouseEvent('mousedown', { button: 0 }, 1001));

    // A refused recast must not silently re-arm the window either.
    expect(timersOf(engine).deathChargeActiveTicks).toBe(afterOne);
    expect(timersOf(engine).deathChargeProcsRemaining).toBe(DEATH_CHARGE_PROCS_UPGRADED);
  });

  it('grays the spell out unless the player can actually pay for it', () => {
    // The icon and the engine read the same gate. Drawing it full-color while the engine refuses
    // the cast is what turns a grayed-out spell into a dead button.
    renderPanel('spellbook', { onDeathChargeCast: vi.fn() });
    const deathCharge = ARCEUUS_GRID.find((slot) => slot.icon === 'death_charge');
    expect(deathCharge).toBeDefined();
    if (!deathCharge) throw new Error('Death Charge slot missing');
    const context = (magicLevel: number, runePouch: RunePouch | null) => ({
      magicLevel,
      equipment: {},
      inventory: createEmptyInventory(),
      runePouch,
    });
    // The shipped Yama pouch: its aether rune answers for the soul rune.
    const pouch: RunePouch = {
      kind: 'divine',
      slots: [{ id: RUNE.death }, { id: RUNE.blood }, { id: COMBINATION_RUNE.aether }, null],
    };

    expect(isSpellSlotEnabled(deathCharge, context(99, pouch))).toBe(true);
    // Death Charge needs 80 Magic.
    expect(isSpellSlotEnabled(deathCharge, context(79, pouch))).toBe(false);
    // And its runes.
    expect(isSpellSlotEnabled(deathCharge, context(99, null))).toBe(false);
  });
});

describe('quick prayers reaching the engine', () => {
  afterEach(() => {
    localStorage.removeItem(PANEL_FILTER_STORAGE_KEY);
  });

  function renderWithStoredQuickPrayers(selections: string[], mechanicsConfig?: MechanicsConfig) {
    localStorage.setItem(PANEL_FILTER_STORAGE_KEY, JSON.stringify({ prayer: { quickPrayerSelections: selections } }));
    const onQuickPrayerSelectionsReady = vi.fn();
    renderWithProviders(
      <GamePanel
        activePrayer={null}
        onPrayerChange={vi.fn()}
        simulationState={stubSimulationState(makeStats(), mechanicsConfig)}
        onQuickPrayerSelectionsReady={onQuickPrayerSelectionsReady}
      />,
    );
    return onQuickPrayerSelectionsReady;
  }

  it('sends the replacement for a prayer saved under the name it took over', () => {
    const ready = renderWithStoredQuickPrayers([PrayerType.EagleEye, PrayerType.ProtectMagic]);

    expect(ready).toHaveBeenLastCalledWith([PrayerType.Deadeye, PrayerType.ProtectMagic]);
  });

  it('sends the saved prayer untouched while the account toggle is off', () => {
    const ready = renderWithStoredQuickPrayers([PrayerType.EagleEye], {
      ...DEFAULT_MECHANICS_CONFIG,
      upgradedPrayers: false,
    });

    expect(ready).toHaveBeenLastCalledWith([PrayerType.EagleEye]);
  });

  it('sends Zeal for saved Piety when its separate account unlock is on', () => {
    const ready = renderWithStoredQuickPrayers([PrayerType.Piety, PrayerType.EagleEye], {
      ...DEFAULT_MECHANICS_CONFIG,
      zealPrayer: true,
      upgradedPrayers: false,
    });
    expect(ready).toHaveBeenLastCalledWith([PrayerType.Zeal, PrayerType.EagleEye]);
  });

  it('keeps Piety by default even when the older prayer upgrades are enabled', () => {
    const ready = renderWithStoredQuickPrayers([PrayerType.Piety]);
    expect(ready).toHaveBeenLastCalledWith([PrayerType.Piety]);
  });
});

describe('GamePanel placement through a UI-scale change', () => {
  // Two separate panels with no link between them: the one placement rule for every panel,
  // plus docking, keeps the inventory on its tab bar. The body must not rewrite its own saved
  // position on every scale step to clear the tab bar, which would skip both rules.
  function renderModernPanel(bodyPosition: UIPosition) {
    let stored = bodyPosition;
    function Harness({ uiScale }: { uiScale: number }) {
      const [position, setPosition] = useState(bodyPosition);
      stored = position;
      return (
        <PanelSnapRegistryProvider>
          <TooltipProvider initialScale={uiScale}>
            <ContextMenuProvider>
              <GamePanel
                activePrayer={null}
                onPrayerChange={vi.fn()}
                inventory={makeInventory()}
                prayerState={{
                  points: 99,
                  maxPoints: 99,
                  drainCounter: 0,
                  activePrayers: [],
                  prayerActivationTicks: {},
                }}
                panelPosition={position}
                onPanelPositionChange={setPosition}
                viewportWidth={1920}
                viewportHeight={970}
              />
            </ContextMenuProvider>
          </TooltipProvider>
        </PanelSnapRegistryProvider>
      );
    }
    const view = render(<Harness uiScale={1} />);
    const root = (id: string) => view.container.querySelector<HTMLElement>(`[data-tutorial="${id}"]`) as HTMLElement;
    const rect = (id: string) => {
      const element = root(id);
      const [left, top] = /translate3d\(([-\d.e]+)px, ([-\d.e]+)px/
        .exec(element.style.transform)
        ?.slice(1)
        .map(Number) ?? [Number.NaN, Number.NaN];
      // Logical solver geometry, distinct from the device-pixel-quantized wrapper.
      const content = element.firstElementChild as HTMLElement;
      const zoom = Number(content.style.zoom);
      return {
        left,
        top,
        right: left + Number.parseFloat(content.style.width) * zoom,
        bottom: top + Number.parseFloat(content.style.height) * zoom,
      };
    };
    return {
      rect,
      stored: () => stored,
      setScale: async (uiScale: number) => {
        await act(async () => view.rerender(<Harness uiScale={uiScale} />));
      },
      dragTabBar: async (dx: number, dy: number) => {
        await act(async () => {
          fireEvent.mouseDown(root('tab-bar'), { altKey: true, button: 0, clientX: 500, clientY: 500 });
          fireEvent.mouseMove(window, { altKey: true, buttons: 1, clientX: 500 + dx, clientY: 500 + dy });
          fireEvent.mouseUp(window, { altKey: true, clientX: 500 + dx, clientY: 500 + dy });
        });
        fireEvent.keyUp(window, { key: 'Alt' });
      },
    };
  }

  afterEach(() => {
    fireEvent.keyUp(window, { key: 'Alt' });
    fireEvent.blur(window);
  });

  it.each([
    ['100px from the right', { dx: -100, dy: 0 }, { x: 100, y: 38 }],
    ['2px off the bottom', { dx: 0, dy: -2 }, { x: 0, y: 40 }],
  ])('keeps the inventory on its tab bar %s, and round-trips', async (_label, drag, body) => {
    const panel = renderModernPanel({ ...body, anchorX: 'right', anchorY: 'bottom' });
    await panel.dragTabBar(drag.dx, drag.dy);
    const start = { body: panel.rect('game-panel'), tabBar: panel.rect('tab-bar') };
    expect(start.tabBar.top - start.body.bottom).toBe(2);
    expect(start.body.right).toBe(start.tabBar.right);

    for (const scale of [7 / 6, 1.32, 2]) {
      await panel.setScale(scale);
      expect(panel.rect('game-panel').right).toBeCloseTo(panel.rect('tab-bar').right, 6);
      expect(panel.rect('tab-bar').top - panel.rect('game-panel').bottom).toBeCloseTo(2, 6);
    }

    await panel.setScale(1);
    expect({ body: panel.rect('game-panel'), tabBar: panel.rect('tab-bar') }).toEqual(start);
  });

  it('keeps a body saved in the tab-bar band clear of the tab bar at every scale, without rewriting it', async () => {
    const saved = { x: 0, y: 0, anchorX: 'right', anchorY: 'bottom' } as const;
    const panel = renderModernPanel(saved);
    for (const scale of [1, 7 / 6, 1.32, 2, 1]) {
      await panel.setScale(scale);
      expect(panel.rect('tab-bar').top - panel.rect('game-panel').bottom).toBeCloseTo(2, 5);
    }
    expect(panel.stored()).toEqual(saved);
  });
});
