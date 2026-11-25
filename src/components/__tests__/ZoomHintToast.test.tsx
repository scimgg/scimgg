// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGlobalUiShortcuts } from '../../hooks/useGlobalUiShortcuts';
import { HUD_TOOL_GAP as PAD } from '../../util/viewportLayout';
import { type HintToastAnchor, type ToastItem, useZoomHintToast, ZoomHintToast } from '../ZoomHintToast';

const toast = (id = 1): ToastItem => ({ id, type: 'keybind', message: 'Rebind keys in the Keybinds tab' });

const renderStack = (props: { toasts: ToastItem[]; anchor?: HintToastAnchor | null }) =>
  render(<ZoomHintToast onDismiss={vi.fn()} onOptOut={vi.fn()} {...props} />);

const stack = () => document.querySelector<HTMLElement>('.zoom-hint-toast-stack');

// This stack is position:fixed to the WINDOW while the corner it sits on lives inside the
// (possibly letterboxed or fitted) game frame. `anchor` is what holds them together: Grid reports
// that corner in window pixels, rather than the toast re-deriving it from the raw sidebar width.
// Getting this wrong jumps the tip sideways off its corner when a sidebar opens.
describe('ZoomHintToast', () => {
  it('keeps its dismiss icon named without a hover hint', () => {
    vi.useFakeTimers();
    try {
      renderStack({ toasts: [toast()] });
      const button = screen.getByRole('button', { name: 'Dismiss tip' });
      expect(button).not.toHaveAttribute('title');
      fireEvent.pointerEnter(button, { pointerType: 'mouse' });
      act(() => vi.advanceTimersByTime(1000));
      expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders nothing at all when there are no tips', () => {
    const { container } = renderStack({ toasts: [] });
    expect(container.firstChild).toBeNull();
  });

  it('rests at its own inset from the window corner until Grid has reported', () => {
    renderStack({ toasts: [toast()] });
    expect(stack()?.style.left).toBe(`${PAD}px`);
    expect(stack()?.style.bottom).toBe(`calc(40px + ${PAD}px + 8px)`);
    expect(stack()?.style.transform).toBe('');
  });

  it('sits one gap above the window-space corner it is handed', () => {
    renderStack({ toasts: [toast()], anchor: { left: 336, top: 600 } });
    expect(stack()?.style.left).toBe('336px');
    expect(stack()?.style.bottom).toBe('calc(100% - 600px + 8px)');
  });

  it('takes a fractional edge, which is what a letterboxed viewport produces', () => {
    renderStack({ toasts: [toast()], anchor: { left: 273.5, top: 600 } });
    expect(stack()?.style.left).toBe('273.5px');
    expect(stack()?.style.transform).toBe('');
  });

  it('changes only its left offset when the launcher row moves sideways — the property the row animates', () => {
    // A transform here would be a second, unsynchronized motion system: the panels a drawer
    // pushes (the launcher row, TopChrome.css) transition `left`, so this must too or the two
    // drift apart mid-slide. The bottom anchor and the column-reverse order survive a sidebar
    // opening.
    const { rerender } = renderStack({ toasts: [toast()], anchor: { left: 8, top: 600 } });
    const closed = stack()?.style.cssText ?? '';
    rerender(
      <ZoomHintToast toasts={[toast()]} onDismiss={vi.fn()} onOptOut={vi.fn()} anchor={{ left: 336, top: 600 }} />,
    );
    const open = stack()?.style.cssText ?? '';

    expect(closed).not.toBe(open);
    expect(closed.replace('left: 8px', 'left: 336px')).toBe(open);
    expect(stack()?.style.transform).toBe('');
  });

  it('renders one card per tip', () => {
    renderStack({
      toasts: [toast(1), { id: 2, type: 'drag', message: 'Use Alt + Drag to move UI panels' }],
      anchor: { left: 336, top: 600 },
    });
    expect(document.querySelectorAll('.zoom-hint-toast')).toHaveLength(2);
    expect(screen.getByText('Rebind keys in the Keybinds tab')).toBeInTheDocument();
  });
});

describe('ZoomHintToast action', () => {
  it('renders a tip action as a styled text action that runs and closes the tip', async () => {
    const onClick = vi.fn();
    const onDismiss = vi.fn();
    vi.useFakeTimers();
    try {
      render(
        <ZoomHintToast
          toasts={[
            {
              id: 7,
              type: 'quick-prayers-empty',
              message: 'No quick-prayers selected.',
              action: { label: 'Set up', onClick },
            },
          ]}
          onDismiss={onDismiss}
          onOptOut={vi.fn()}
        />,
      );
      const action = screen.getByRole('button', { name: 'Set up' });
      expect(action.className).toContain('zoom-hint-toast__action');
      // Inside the message, so it reads as the end of the sentence.
      expect(action.closest('.zoom-hint-toast__message')?.textContent).toBe('No quick-prayers selected. Set up');
      action.click();
      expect(onClick).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(200);
      expect(onDismiss).toHaveBeenCalledWith(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses no title attributes', () => {
    const { container } = render(
      <ZoomHintToast
        toasts={[{ id: 1, type: 't', message: 'Hi', action: { label: 'Go', onClick: vi.fn() } }]}
        onDismiss={vi.fn()}
        onOptOut={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('[title]')).toHaveLength(0);
  });
});

describe('ZoomHintToast dismissal, wired the way App wires it', () => {
  const TICK_MS = 600;
  const noop = () => {};

  /**
   * App's wiring: the shortcut hints and the quick-prayers hint share one stack, the opt-out
   * writes the persisted list, and `onDismiss` is a fresh inline function on every render,
   * which comes at least once a tick.
   */
  function Host({ onSetUp, initialDisabled = [] }: { onSetUp: () => void; initialDisabled?: string[] }) {
    const [disabled, setDisabled] = useState<string[]>(initialDisabled);
    const [, setTick] = useState(0);
    useEffect(() => {
      const timer = setInterval(() => setTick((tick) => tick + 1), TICK_MS);
      return () => clearInterval(timer);
    }, []);
    const { hintToasts, dismissHintToast, handleHintOptOut } = useGlobalUiShortcuts({
      disabledShortcutHints: disabled,
      onReset: noop,
      onToggleQuickSearch: noop,
      onToggleShowFps: noop,
      showShortcutHints: true,
      updateDisabledShortcutHints: setDisabled,
    });
    const quickPrayerHint = useZoomHintToast({ disabledTypes: disabled });
    return (
      <>
        <button
          type="button"
          onClick={() =>
            quickPrayerHint.trigger('quick-prayers-empty', 'No quick-prayers selected.', {
              label: 'Set up',
              onClick: onSetUp,
            })
          }
        >
          Quick-prayers
        </button>
        <output data-testid="disabled">{disabled.join(',')}</output>
        <ZoomHintToast
          toasts={[...hintToasts, ...quickPrayerHint.toasts]}
          onDismiss={(id) => {
            dismissHintToast(id);
            quickPrayerHint.dismiss(id);
          }}
          onOptOut={handleHintOptOut}
        />
      </>
    );
  }

  const showResizeHint = () => fireEvent.keyDown(window, { key: '=', code: 'Equal', ctrlKey: true });
  const showQuickPrayerHint = () => fireEvent.click(screen.getByRole('button', { name: 'Quick-prayers' }));
  const tips = () => [...document.querySelectorAll('.zoom-hint-toast')].map((tip) => tip.textContent);
  const control = (text: RegExp, selector: string) =>
    screen.getByText(text).closest('.zoom-hint-toast')?.querySelector<HTMLButtonElement>(selector) as HTMLButtonElement;
  const optOut = (text: RegExp) => control(text, '.zoom-hint-toast__opt-out');
  /** Far enough for the exit animation, with a host render landing inside it. */
  const settle = () => act(() => vi.advanceTimersByTime(TICK_MS));
  const disabledTypes = () => screen.getByTestId('disabled').textContent;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes the tip on Don't show again and records its type, though the opt-out re-renders the host", () => {
    render(<Host onSetUp={noop} />);
    showResizeHint();

    fireEvent.click(optOut(/resize UI panels/));
    settle();

    expect(tips()).toEqual([]);
    expect(disabledTypes()).toBe('resize');
  });

  it('never shows an opted-out type again, a shortcut hint or the quick-prayers one', () => {
    render(<Host onSetUp={noop} />);
    showResizeHint();
    showQuickPrayerHint();
    fireEvent.click(optOut(/resize UI panels/));
    fireEvent.click(optOut(/No quick-prayers/));
    settle();

    // Well past the per-type cooldown, so only the opt-out can be holding them back.
    act(() => vi.advanceTimersByTime(60_000));
    showResizeHint();
    showQuickPrayerHint();

    expect(tips()).toEqual([]);
  });

  it('keeps both of two types opted out before the host re-renders', () => {
    render(<Host onSetUp={noop} />);
    showResizeHint();
    showQuickPrayerHint();
    const first = optOut(/resize UI panels/);
    const second = optOut(/No quick-prayers/);

    // One batch, so the second opt-out runs with the props of the render before the first.
    act(() => {
      first.click();
      second.click();
    });
    settle();

    expect(disabledTypes()).toBe('resize,quick-prayers-empty');
    expect(tips()).toEqual([]);
  });

  it('closes on x and on Set up, running the action once, and records no opt-out', () => {
    const onSetUp = vi.fn();
    render(<Host onSetUp={onSetUp} />);
    showResizeHint();
    showQuickPrayerHint();

    fireEvent.click(control(/resize UI panels/, '.zoom-hint-toast__close'));
    fireEvent.click(screen.getByRole('button', { name: 'Set up' }));
    settle();

    expect(onSetUp).toHaveBeenCalledOnce();
    expect(tips()).toEqual([]);
    expect(disabledTypes()).toBe('');
  });

  it('hides by itself after its time on screen while the host re-renders every tick', () => {
    render(<Host onSetUp={noop} />);
    showResizeHint();

    act(() => vi.advanceTimersByTime(7_000));
    settle();

    expect(tips()).toEqual([]);
  });

  describe('stylesheet', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/ZoomHintToast.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      '',
    );
    const rule = (selector: string) => {
      const body =
        new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
      const value = (property: string) =>
        new RegExp(`(?:^|;)\\s*${property}:\\s*([^;]+);`).exec(body)?.[1].trim() ?? '';
      return value;
    };
    const px = (value: string) => value.split(/\s+/).map((part) => Number.parseFloat(part));

    it('gives the close a thumb-sized hit area without moving the row', () => {
      const close = rule('.zoom-hint-toast__close');
      expect(close('box-sizing')).toBe('content-box');
      const [pad] = px(close('padding'));
      const [top, right, bottom, left] = px(close('margin'));
      expect(px(close('width'))[0] + 2 * pad).toBeGreaterThanOrEqual(32);
      expect(px(close('height'))[0] + 2 * pad).toBeGreaterThanOrEqual(32);
      // The margin takes the padding back, so it lays out as the 18px box it always was (with its
      // 2px pull into the toast's right padding).
      expect([top, bottom, left]).toEqual([-pad, -pad, -pad]);
      expect(right).toBe(-pad - 2);
    });

    it.each([
      ['.zoom-hint-toast__tip', 'RuneScape Small'],
      ['.zoom-hint-toast__opt-out', 'RuneScape Plain 11'],
    ])('sets %s in a native face at its native 16px', (selector, face) => {
      const value = rule(selector);
      expect(value('font-family')).toContain(face);
      expect(value('font-size')).toBe('16px');
      expect(value('letter-spacing') || '0px').toMatch(/^\d+px$/);
    });
  });
});
