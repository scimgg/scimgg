// @vitest-environment happy-dom

import { act, fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObjTypeLoader } from '../../../rs/config/objtype/ObjTypeLoader';
import { ALL_SPELL_CATEGORIES, PRAYER_FILTER_DEFAULTS, SPELL_FILTER_DEFAULTS } from '../../../types/panelFilters';
import { ContextMenuProvider } from '../../ContextMenu';
import { TooltipOverlay, TooltipProvider } from '../../Tooltip';
import { InventoryContent } from '../InventoryContent';
import { PrayerContent } from '../PrayerContent';
import { SpellbookContent } from '../SpellbookContent';

/**
 * The mobile client shows no hover tooltip on prayers, spells or items: their tooltips appear
 * only on mouse hover, which a finger does not produce.
 */
describe('panel tooltips under a finger', () => {
  let matchMedia: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation(
      (query: string) =>
        ({
          matches: query.includes('coarse'),
          media: query,
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        }) as unknown as MediaQueryList,
    );
    vi.useFakeTimers();
  });

  afterEach(() => {
    matchMedia?.mockRestore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function renderPanel(panel: React.ReactNode) {
    return render(
      <TooltipProvider>
        <ContextMenuProvider>
          {panel}
          <TooltipOverlay />
        </ContextMenuProvider>
      </TooltipProvider>,
    );
  }

  /** Everything a browser sends for a tap, the compatibility mouseover and mouseenter included. */
  function tap(target: Element, init: PointerEventInit = {}) {
    const touch = (type: string) =>
      fireEvent(
        target,
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
          pointerId: 1,
          isPrimary: true,
          clientX: 10,
          clientY: 10,
          ...init,
        }),
      );
    touch('pointerdown');
    touch('pointerup');
    fireEvent.mouseOver(target, { clientX: 10, clientY: 10 });
    fireEvent.mouseEnter(target, { clientX: 10, clientY: 10 });
    fireEvent.click(target, { detail: 1, clientX: 10, clientY: 10 });
    act(() => vi.runOnlyPendingTimers());
  }

  function hoverWithMouse(target: Element) {
    fireEvent(
      target,
      new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: 10, clientY: 10 }),
    );
    fireEvent.mouseEnter(target, { clientX: 10, clientY: 10 });
    act(() => vi.runOnlyPendingTimers());
  }

  const prayerPanel = (onPrayerChange = vi.fn()) => (
    <PrayerContent
      activePrayer={null}
      onPrayerChange={onPrayerChange}
      reorderMode={false}
      filteringEnabled={false}
      filterViewOpen={false}
      onFilterViewOpenChange={vi.fn()}
      filterSettings={{ hidden: [], order: null, filterOptions: PRAYER_FILTER_DEFAULTS }}
      onToggleHidden={vi.fn()}
      onReorder={vi.fn()}
      onToggleFilterOption={vi.fn()}
    />
  );

  it('activates a tapped prayer without ever showing its tooltip', () => {
    const onPrayerChange = vi.fn();
    renderPanel(prayerPanel(onPrayerChange));
    const prayer = screen.getByRole('button', { name: 'Protect from Magic' });

    tap(prayer);

    expect(onPrayerChange).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Protect from Magic/)).toBeNull();
    // Nothing is waiting to come back either: the next tap elsewhere leaves none behind.
    tap(screen.getByRole('button', { name: 'Protect from Missiles' }));
    expect(screen.queryByText(/Protect from/)).toBeNull();
  });

  it('still shows the prayer tooltip on mouse hover', () => {
    renderPanel(prayerPanel());

    hoverWithMouse(screen.getByRole('button', { name: 'Protect from Magic' }));

    expect(screen.getByText('Protect from Magic')).toBeInTheDocument();
  });

  it('shows no spell tooltip for a tap, and one for a mouse', () => {
    const onHomeTeleportCast = vi.fn();
    renderPanel(
      <SpellbookContent
        spellbook="arceuus"
        onHomeTeleportCast={onHomeTeleportCast}
        reorderMode={false}
        filteringEnabled={false}
        filterViewOpen={false}
        onFilterViewOpenChange={vi.fn()}
        filterSettings={{
          hidden: {},
          order: {},
          activeCategories: ALL_SPELL_CATEGORIES,
          filterOptions: SPELL_FILTER_DEFAULTS,
        }}
        onToggleHidden={vi.fn()}
        onReorder={vi.fn()}
        onToggleCategory={vi.fn()}
        onToggleFilterOption={vi.fn()}
      />,
    );
    const spell = document.querySelector<HTMLElement>('[data-spell="home_teleport"][data-tooltip-bound]');
    if (!spell) throw new Error('No spell is bound to a tooltip');
    // The overlay portals its card to the body, above everything else.
    const tooltipShown = () =>
      Array.from(document.body.children).some((element) => (element as HTMLElement).style.zIndex === '99999');

    tap(spell);
    expect(onHomeTeleportCast).toHaveBeenCalledOnce();
    expect(tooltipShown()).toBe(false);

    hoverWithMouse(spell);
    expect(tooltipShown()).toBe(true);
  });

  it('uses a tapped item without showing its name, and names it on mouse hover', () => {
    const onUseItem = vi.fn();
    const objTypeLoader = {
      load: () => ({ name: 'Super restore(4)', inventoryActions: ['Drink'] }),
    } as unknown as ObjTypeLoader;
    const inventory = Array.from({ length: 28 }, (_, index) => (index === 2 ? { id: 3024 } : null));
    renderPanel(
      <InventoryContent
        inventory={inventory}
        onUseItem={onUseItem}
        antiDragEnabled={false}
        objTypeLoader={objTypeLoader}
      />,
    );
    const item = screen.getByLabelText('Item 3024');

    tap(item);
    expect(onUseItem).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Super restore/)).toBeNull();

    hoverWithMouse(item);
    expect(screen.getByText(/Super restore/)).toBeInTheDocument();
  });
});
