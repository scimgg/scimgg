// @vitest-environment happy-dom

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TOUCH_SLOP_PX } from '../../../input/touchHold';
import { TOUCH_LONG_PRESS_DEFAULT_MS } from '../../../input/touchPrefs';
import type { ObjTypeLoader } from '../../../rs/config/objtype/ObjTypeLoader';
import { ARDER_MUSCA_POISON_ITEM_ID } from '../../../types/inventory';
import { ContextMenuOverlay, ContextMenuProvider } from '../../ContextMenu';
import { TooltipProvider } from '../../Tooltip';
import { InventoryContent } from '../InventoryContent';

/** The layer publishes its placements as `data-sprites` in dev, which is the paint list. */
function paintedSprites(): { src: string; x: number; y: number; w: number; h: number }[] {
  const layer = document.querySelector('canvas[data-sprites]');
  return JSON.parse(layer?.getAttribute('data-sprites') ?? '[]');
}

describe('InventoryContent', () => {
  it('paints item icons at the client\u2019s own slot origins', () => {
    // Given: items in the first slot of the first row and of the second row.
    const inventory = Array.from({ length: 28 }, (_, index) =>
      index === 0 ? { id: 4151 } : index === 4 ? { id: 385 } : null,
    );
    render(
      <TooltipProvider>
        <ContextMenuProvider>
          <InventoryContent inventory={inventory} />
        </ContextMenuProvider>
      </TooltipProvider>,
    );

    // When: the layer resolves each 36x32 icon inside the box it was given.
    const origins = paintedSprites().map((sprite) => ({
      x: sprite.x + (sprite.w - 36) / 2,
      y: sprite.y + (sprite.h - 32) / 2,
    }));

    // Then: they land on the client's (16 + col*42, 8 + row*36), plus the 7px
    // chrome inset around the client's 190x261 content box.
    expect(origins).toEqual([
      { x: 23, y: 15 },
      { x: 23, y: 51 },
    ]);
  });

  it('keeps each icon on top of its own hit target', () => {
    // Given: an item whose slot button carries the tooltip, drag and context-menu handling.
    const inventory = Array.from({ length: 28 }, (_, index) => (index === 6 ? { id: 4151 } : null));
    render(
      <TooltipProvider>
        <ContextMenuProvider>
          <InventoryContent inventory={inventory} />
        </ContextMenuProvider>
      </TooltipProvider>,
    );

    // When: the painted icon is compared with the button the player actually clicks.
    const button = screen.getByLabelText('Item 4151');
    const sprite = paintedSprites()[0];

    // Then: the icon is drawn over it, not offset into the pitch gutter beside it.
    expect(sprite.x + (sprite.w - 36) / 2).toBe(Number.parseFloat(button.style.left));
    expect(sprite.y + (sprite.h - 32) / 2).toBe(Number.parseFloat(button.style.top));
  });

  describe('stack mark', () => {
    const DRAGON_ARROW = 11212;
    const WHIP = 4151;
    /** Arrows stack in the cache; the whip does not. */
    const loader = {
      load: (id: number) => ({ stackable: id === DRAGON_ARROW, inventoryActions: [] }),
    } as unknown as ObjTypeLoader;

    function renderSlot(slot: { id: number; quantity?: number }, objTypeLoader?: ObjTypeLoader) {
      const inventory = Array.from({ length: 28 }, (_, index) => (index === 0 ? slot : null));
      render(
        <TooltipProvider>
          <ContextMenuProvider>
            <InventoryContent inventory={inventory} objTypeLoader={objTypeLoader} />
          </ContextMenuProvider>
        </TooltipProvider>,
      );
      return screen.getByLabelText(`Item ${slot.id}`);
    }

    it('marks a cache-stackable slot unlimited even with no quantity, as after unequipping it', () => {
      const slot = renderSlot({ id: DRAGON_ARROW }, loader);

      const mark = within(slot).getByRole('img', { name: 'Unlimited' });
      // In the corner the game prints a stack count, rows 0-8 of the 36x32 item box.
      expect(mark.style.left).toBe('0px');
      expect(mark.style.top).toBe('0px');
    });

    it('marks a counted stack unlimited without a cache, and never prints the count', () => {
      const slot = renderSlot({ id: 565, quantity: 1234 });

      expect(within(slot).getByRole('img', { name: 'Unlimited' })).toBeInTheDocument();
      expect(screen.queryByText('1234')).toBeNull();
    });

    it('shows the poison stack count', () => {
      const slot = renderSlot({ id: ARDER_MUSCA_POISON_ITEM_ID, quantity: 3 });

      expect(within(slot).getByRole('img', { name: 'Quantity 3' })).toHaveTextContent('3');
      expect(within(slot).queryByRole('img', { name: 'Unlimited' })).toBeNull();
    });

    it('leaves a single non-stackable item unmarked', () => {
      const slot = renderSlot({ id: WHIP }, loader);

      expect(within(slot).queryByRole('img', { name: 'Unlimited' })).toBeNull();
    });

    it('keeps the mark on a tagged stack, which renders its own sprite', () => {
      const inventory = Array.from({ length: 28 }, (_, index) => (index === 0 ? { id: DRAGON_ARROW } : null));
      render(
        <TooltipProvider>
          <ContextMenuProvider>
            <InventoryContent
              inventory={inventory}
              objTypeLoader={loader}
              showInventoryTags
              inventoryTags={{ [DRAGON_ARROW]: '#ff0000' }}
            />
          </ContextMenuProvider>
        </TooltipProvider>,
      );

      const slot = screen.getByRole('button', { name: `Item ${DRAGON_ARROW}` });
      expect(within(slot).getByRole('img', { name: 'Unlimited' })).toBeInTheDocument();
    });
  });
});

/**
 * Switching game-panel tabs unmounts this component. OSRS still runs a held item's
 * action when that happens, unless the press had already become a drag.
 */
describe('InventoryContent — a press the panel unmounts under', () => {
  const SUPER_RESTORE = 3024;
  const SLOT = 2;

  beforeEach(() => {
    // The hook batches onMove through rAF; running it inline keeps the drag promotion
    // observable within the act() that dispatched the move.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Drag promotion compares event timestamps, which a same-tick test cannot separate. */
  function atTime(type: string, init: MouseEventInit, timeStamp: number): MouseEvent {
    const event = new MouseEvent(type, { bubbles: true, ...init });
    Object.defineProperty(event, 'timeStamp', { value: timeStamp });
    return event;
  }

  function renderWithItem(onUseItem: (index: number) => void) {
    const inventory = Array.from({ length: 28 }, (_, index) => (index === SLOT ? { id: SUPER_RESTORE } : null));
    return render(
      <TooltipProvider>
        <ContextMenuProvider>
          <InventoryContent inventory={inventory} onUseItem={onUseItem} antiDragEnabled={false} />
        </ContextMenuProvider>
      </TooltipProvider>,
    );
  }

  function pressSlot(): void {
    fireEvent(
      screen.getByLabelText(`Item ${SUPER_RESTORE}`),
      atTime('mousedown', { button: 0, clientX: 100, clientY: 100 }, 1_000),
    );
  }

  it('runs the item action, as switching tabs mid-click does in game', () => {
    // Given: the button is pressed on a Super restore and never released.
    const onUseItem = vi.fn();
    const { unmount } = renderWithItem(onUseItem);
    pressSlot();

    // When: the tab switch unmounts the panel under the held press.
    unmount();

    // Then: the drink still happens, instead of the click being swallowed.
    expect(onUseItem).toHaveBeenCalledWith(SLOT);
  });

  it('abandons the gesture once it has become a drag, as the game does', () => {
    // Given: a press that has moved far enough, and long enough, to be a drag.
    const onUseItem = vi.fn();
    const { unmount } = renderWithItem(onUseItem);
    pressSlot();
    act(() => {
      window.dispatchEvent(atTime('mousemove', { buttons: 1, clientX: 160, clientY: 160 }, 2_000));
    });

    // When: the tab switch unmounts the grid the drag was aiming at.
    unmount();

    // Then: nothing is used — the drop target no longer exists.
    expect(onUseItem).not.toHaveBeenCalled();
  });
});

describe('InventoryContent touch taps (touch-only devices)', () => {
  const SUPER_RESTORE = 3024;
  const SLOT = 2;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function renderTouchInventory({ withOverlay = false } = {}) {
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
    const onUseItem = vi.fn();
    const onDropItem = vi.fn();
    const onSwapSlots = vi.fn();
    const inventory = Array.from({ length: 28 }, (_, index) => (index === SLOT ? { id: SUPER_RESTORE } : null));
    render(
      <TooltipProvider>
        <ContextMenuProvider>
          <InventoryContent
            inventory={inventory}
            onUseItem={onUseItem}
            onDropItem={onDropItem}
            onSwapSlots={onSwapSlots}
            antiDragEnabled={false}
            // Slots bind their menu, and with it touch taps, only once item definitions load.
            objTypeLoader={{ load: () => ({ inventoryActions: ['Drink'] }) } as unknown as ObjTypeLoader}
          />
          {withOverlay && <ContextMenuOverlay />}
        </ContextMenuProvider>
      </TooltipProvider>,
    );
    // Runs the drag's batched moves inline, so each is observable straight away.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const slot = screen.getByLabelText(`Item ${SUPER_RESTORE}`);
    const touch = (type: string, init: PointerEventInit = {}) =>
      fireEvent(
        slot,
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
          pointerId: 1,
          isPrimary: true,
          clientX: 9,
          ...init,
        }),
      );
    return { slot, touch, onUseItem, onDropItem, onSwapSlots };
  }

  // With the container at the origin, slot 2's cell spans x 104-146 and slot 1's x 62-104,
  // both at y 13-49.
  const ON_SLOT_2 = { clientX: 120, clientY: 30 };
  const PAST_SLOP = { clientX: 100, clientY: 30 };
  const ON_SLOT_1 = { clientX: 80, clientY: 30 };
  const draggedSprites = () => screen.queryAllByRole('img', { name: `Item ${SUPER_RESTORE}` });

  it('rearranges when the touch travels before the hold, carrying the item under the finger', () => {
    const { slot, touch, onUseItem, onSwapSlots } = renderTouchInventory();

    touch('pointerdown', ON_SLOT_2);
    act(() => vi.advanceTimersByTime(100));
    touch('pointermove', PAST_SLOP);
    expect(draggedSprites()).toHaveLength(1);
    expect(slot.style.opacity).toBe('0.3');

    touch('pointermove', ON_SLOT_1);
    // Past the long-press time: the drag already won, so no menu opens.
    act(() => vi.advanceTimersByTime(1000));
    touch('pointerup', ON_SLOT_1);
    fireEvent.click(slot, { button: 0, ...ON_SLOT_1 });

    expect(onSwapSlots).toHaveBeenCalledExactlyOnceWith(SLOT, 1);
    expect(onUseItem).not.toHaveBeenCalled();
    expect(draggedSprites()).toHaveLength(0);
  });

  it('uses the item on a tap that wobbles inside the slop, never picking it up', () => {
    const { slot, touch, onUseItem, onSwapSlots } = renderTouchInventory();

    // Up to 13 px from where it landed: a shaky tap, not a drag.
    touch('pointerdown', ON_SLOT_2);
    touch('pointermove', { clientX: 120 + TOUCH_SLOP_PX - 1, clientY: 30 });
    touch('pointermove', { clientX: 112, clientY: 39 });
    expect(draggedSprites()).toHaveLength(0);
    act(() => vi.advanceTimersByTime(TOUCH_LONG_PRESS_DEFAULT_MS - 50));
    touch('pointerup', { clientX: 128, clientY: 36 });
    fireEvent.click(slot, { button: 0, clientX: 128, clientY: 36 });

    expect(onUseItem).toHaveBeenCalledOnce();
    expect(onSwapSlots).not.toHaveBeenCalled();
  });

  it('picks the item up once a deliberate drag crosses the slop', () => {
    const { touch, onUseItem } = renderTouchInventory();

    touch('pointerdown', ON_SLOT_2);
    touch('pointermove', { clientX: 120 - TOUCH_SLOP_PX, clientY: 30 });

    expect(draggedSprites()).toHaveLength(1);
    expect(onUseItem).not.toHaveBeenCalled();
  });

  it('opens the menu once the hold wins, after which moving only slides the menu', () => {
    const { touch, onUseItem, onSwapSlots } = renderTouchInventory({ withOverlay: true });

    touch('pointerdown', ON_SLOT_2);
    act(() => vi.advanceTimersByTime(TOUCH_LONG_PRESS_DEFAULT_MS));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    touch('pointermove', PAST_SLOP);
    touch('pointermove', ON_SLOT_1);
    expect(draggedSprites()).toHaveLength(0);
    touch('pointerup', ON_SLOT_1);

    expect(onSwapSlots).not.toHaveBeenCalled();
    expect(onUseItem).not.toHaveBeenCalled();
  });

  it('keeps the order on a drop outside the grid, or when the browser cancels the drag', () => {
    const { slot, touch, onUseItem, onSwapSlots } = renderTouchInventory();

    touch('pointerdown', ON_SLOT_2);
    touch('pointermove', PAST_SLOP);
    touch('pointerup', { clientX: 500, clientY: 500 });

    touch('pointerdown', ON_SLOT_2);
    touch('pointermove', PAST_SLOP);
    touch('pointermove', ON_SLOT_1);
    touch('pointercancel', ON_SLOT_1);
    expect(slot.style.opacity).toBe('1');
    expect(draggedSprites()).toHaveLength(0);
    // The canceled pointer's stray release drops nothing either.
    touch('pointerup', ON_SLOT_1);

    expect(onSwapSlots).not.toHaveBeenCalled();
    expect(onUseItem).not.toHaveBeenCalled();
  });

  it('does not drag a press the mouse could not drag either', () => {
    const { touch, onSwapSlots, onDropItem } = renderTouchInventory();

    // A shift-press drops on release rather than dragging; traveling makes it neither.
    touch('pointerdown', { ...ON_SLOT_2, shiftKey: true });
    touch('pointermove', { ...PAST_SLOP, shiftKey: true });
    touch('pointerup', { ...ON_SLOT_1, shiftKey: true });

    expect(draggedSprites()).toHaveLength(0);
    expect(onSwapSlots).not.toHaveBeenCalled();
    expect(onDropItem).not.toHaveBeenCalled();
  });

  it('uses the item once per tap, slow or quick, with the click the browser still sends', () => {
    const { slot, touch, onUseItem } = renderTouchInventory();

    touch('pointerdown');
    act(() => vi.advanceTimersByTime(TOUCH_LONG_PRESS_DEFAULT_MS - 50));
    touch('pointerup');
    expect(onUseItem).toHaveBeenCalledTimes(1);

    touch('pointerdown');
    touch('pointerup');
    fireEvent.click(slot, { button: 0, clientX: 9 });
    expect(onUseItem).toHaveBeenCalledTimes(2);
  });

  it('drops the item on a shift-tap from a tablet keyboard', () => {
    const { touch, onUseItem, onDropItem } = renderTouchInventory();

    touch('pointerdown', { shiftKey: true });
    touch('pointerup', { shiftKey: true });

    expect(onDropItem).toHaveBeenCalledWith(SLOT);
    expect(onUseItem).not.toHaveBeenCalled();
  });
});
