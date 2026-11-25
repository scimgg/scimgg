// @vitest-environment happy-dom

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OutcomePracticeActions, PracticeRetryBar } from '../ReplayPractice';
import { makeReplayPractice } from './ReplayPractice.fixtures';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('replay practice pointer controls', () => {
  it('shows actionable failures and busy state without routine helper copy', () => {
    const controls = makeReplayPractice({ startTick: 124, error: 'This tick could not be restored.' });
    const view = render(<PracticeRetryBar controls={controls} />);
    expect(screen.getByRole('status')).toHaveTextContent('This tick could not be restored.');
    expect(screen.getByRole('status')).toHaveClass('practice-retry-bar__error');
    view.rerender(<PracticeRetryBar controls={{ ...controls, error: null, busy: true, message: 'Restoring tick…' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Restoring tick');
    expect(screen.getByRole('status')).not.toHaveClass('practice-retry-bar__error');
    expect(screen.getByRole('button', { name: 'Restart from tick 124' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Change' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear restart point' })).toBeDisabled();
  });

  it('keeps the fixed retry destination visible and Change start separate from retry', () => {
    vi.useFakeTimers();
    const controls = makeReplayPractice({ startTick: 124 });
    render(<PracticeRetryBar controls={controls} />);
    fireEvent.click(screen.getByRole('button', { name: 'Restart from tick 124' }));
    expect(controls.onRetry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(controls.onChangeStart).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Clear restart point' }));
    expect(controls.onClearStart).toHaveBeenCalledOnce();
    fireEvent.pointerEnter(screen.getByRole('button', { name: 'Restart from tick 124' }), { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Ctrl+R restarts from this tick.');
  });

  it('has no retry strip when no practice start is set', () => {
    const { container } = render(<PracticeRetryBar controls={makeReplayPractice()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('adds a slim context line only to the labeled desktop presentation, without repeating the tick', () => {
    const controls = makeReplayPractice({ startTick: 124 });
    const view = render(<PracticeRetryBar controls={controls} presentation="labelled" />);
    expect(screen.getByText('Practice')).toBeInTheDocument();
    expect(screen.getByText('Ctrl+R')).toBeInTheDocument();
    expect(screen.getAllByText(/124/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Restart from tick 124' })).toHaveTextContent('Restart: 124');

    view.rerender(<PracticeRetryBar controls={controls} presentation="compact" />);
    expect(view.container.querySelector('.practice-retry-bar__context')).toBeNull();
    view.rerender(<PracticeRetryBar controls={controls} />);
    expect(view.container.querySelector('.practice-retry-bar__context')).toBeNull();
    expect(screen.getByRole('group', { name: 'Practice session' })).not.toHaveClass('practice-retry-bar--compact');
  });

  it.each(['toolbar', 'compact', 'labelled'] as const)('names every %s session action in words', (presentation) => {
    const controls = makeReplayPractice({ startTick: 124 });
    const { container } = render(<PracticeRetryBar controls={controls} presentation={presentation} />);
    expect(screen.getByRole('button', { name: 'Restart from tick 124' })).toHaveTextContent('Restart: 124');
    expect(screen.getAllByText(/124/)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Change' })).toHaveTextContent('Change');
    expect(screen.getByRole('button', { name: 'Clear restart point' })).toHaveTextContent('Clear');
    // No launcher glyph stands in for a label at any width: the rewind and close marks name
    // Replay and "close this surface" everywhere else in the same chrome.
    expect(container.querySelector('svg[data-glyph]')).toBeNull();
  });

  it('keeps the narrow session to a restart destination with the two actions wrapping together', () => {
    const controls = makeReplayPractice({ startTick: 124 });
    const { container } = render(<PracticeRetryBar controls={controls} presentation="compact" />);
    const restart = screen.getByRole('button', { name: 'Restart from tick 124' });
    // Change and Clear share one wrapper, so a bar too narrow for one line drops both to the
    // next line rather than stranding Clear above the action it qualifies.
    const actions = container.querySelector('.practice-retry-bar__actions') as HTMLElement;
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Change' }));
    expect(actions).toContainElement(screen.getByRole('button', { name: 'Clear restart point' }));
    expect(actions).not.toContainElement(restart);
    expect(fireEvent.mouseDown(restart)).toBe(false);
    fireEvent.click(restart);
    expect(controls.onRetry).toHaveBeenCalledOnce();
  });

  it('wraps the narrow row instead of hiding a label or fixing a width', () => {
    const css = readFileSync(join(process.cwd(), 'src/components/ReplayPractice.css'), 'utf8');
    const rule = (selector: string) =>
      new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 's').exec(css)?.[1] ?? '';
    expect(rule('.practice-retry-bar__row')).toContain('flex-wrap: wrap');
    expect(rule('.practice-retry-bar__actions')).toContain('flex: 1 1 auto');
    // The compact presentation differs in padding alone; nothing in it may hide a control's
    // label or pin a control to a glyph-sized box.
    for (const [, body] of css.matchAll(/\.practice-retry-bar--compact[^{]*\{([^}]*)\}/gs)) {
      expect(body).not.toMatch(/display:\s*none/);
      expect(body).not.toMatch(/\bwidth:\s*\d/);
    }
  });

  it.each([
    ['Change', 'Pick a new restart tick in the replay.'],
    ['Clear restart point', 'Ctrl+R restarts the whole fight again.'],
  ])('explains the compact %s action on hover', (name, hint) => {
    vi.useFakeTimers();
    render(<PracticeRetryBar controls={makeReplayPractice({ startTick: 124 })} presentation="compact" />);
    fireEvent.pointerEnter(screen.getByRole('button', { name }), { pointerType: 'mouse' });
    act(() => vi.advanceTimersByTime(0));
    expect(screen.getByRole('tooltip')).toHaveTextContent(hint);
  });

  it('keeps ordinary outcomes to Restart fight and Watch replay', () => {
    const controls = makeReplayPractice();
    const onRestart = vi.fn();
    render(<OutcomePracticeActions controls={controls} onRestart={onRestart} onReplay={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Practice last/ })).toBeNull();
    expect(onRestart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Restart fight' }));
    expect(onRestart).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: /Retry from/ })).toBeNull();
  });

  it('promotes retry while active, retaining the separate full reset and accurate Ctrl+R hint', () => {
    const controls = makeReplayPractice({ startTick: 124 });
    const onRestart = vi.fn();
    render(<OutcomePracticeActions controls={controls} onRestart={onRestart} onReplay={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Restart from tick 124' })).toHaveClass('osrs-btn--primary');
    expect(screen.queryByRole('button', { name: /Practice last/ })).toBeNull();
    expect(screen.queryByText('Practice attempt')).toBeNull();
    expect(screen.getByText('Ctrl+R').closest('button')).toBe(
      screen.getByRole('button', { name: 'Restart from tick 124' }),
    );
    expect(screen.getAllByText(/124/)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Restart fight' }));
    expect(onRestart).toHaveBeenCalledOnce();
    expect(controls.onRetry).not.toHaveBeenCalled();
  });

  it('disables restore-sensitive actions while busy and exposes failure without hiding full restart', () => {
    const controls = makeReplayPractice({ startTick: 123456789, busy: true, message: 'Restoring tick…' });
    const view = render(
      <OutcomePracticeActions controls={controls} onRestart={vi.fn()} onReplay={vi.fn()} onReturnToLobby={vi.fn()} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Restoring tick…');
    expect(screen.getByRole('status')).not.toHaveClass('outcome-practice-actions__error');
    for (const button of screen.getAllByRole('button').filter((button) => button.textContent !== 'Return to Lobby'))
      expect(button).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Return to Lobby' })).toBeEnabled();
    view.rerender(
      <OutcomePracticeActions
        controls={{
          ...controls,
          busy: false,
          message: null,
          retryUnavailableReason: 'This recording cannot restore that tick.',
        }}
        onRestart={vi.fn()}
        onReplay={vi.fn()}
        onReturnToLobby={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('This recording cannot restore that tick.');
    expect(screen.getByRole('status')).not.toHaveClass('outcome-practice-actions__error');
    expect(screen.getByRole('button', { name: 'Restart from tick 123456789' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Restart fight' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Watch replay' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Return to Lobby' })).toBeEnabled();
  });

  it.each([
    'toolbar',
    'compact',
    'labelled',
  ] as const)('marks only session failures in %s presentation while neutral reasons keep the hint class', (presentation) => {
    const controls = makeReplayPractice({ startTick: 10, error: 'Restart failed.' });
    const view = render(<PracticeRetryBar presentation={presentation} controls={controls} />);
    expect(screen.getByRole('status')).toHaveClass('practice-retry-bar__error');
    expect(screen.getByRole('status')).toHaveTextContent('Restart failed.');
    view.rerender(
      <PracticeRetryBar
        presentation={presentation}
        controls={{ ...controls, error: null, message: 'Close the dialog first.' }}
      />,
    );
    expect(screen.getByRole('status')).toHaveClass('replay-practice__hint');
    expect(screen.getByRole('status')).not.toHaveClass('practice-retry-bar__error');
    expect(screen.getByRole('status')).toHaveTextContent('Close the dialog first.');
  });

  it('marks outcome action failures separately from neutral notices and progress', () => {
    const controls = makeReplayPractice({ startTick: 10, error: 'Restart failed.' });
    const view = render(<OutcomePracticeActions controls={controls} onRestart={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveClass('outcome-practice-actions__error');
    expect(screen.getByRole('status')).toHaveTextContent('Restart failed.');
    view.rerender(
      <OutcomePracticeActions
        controls={{ ...controls, error: null, message: 'Close the dialog first.' }}
        onRestart={vi.fn()}
      />,
    );
    expect(screen.getByRole('status')).toHaveClass('outcome-practice-actions__status');
    expect(screen.getByRole('status')).not.toHaveClass('outcome-practice-actions__error');
  });

  it('routes retry, replay and lobby independently without taking pointer focus', () => {
    const controls = makeReplayPractice({ startTick: 124 });
    const onReplay = vi.fn();
    const onReturnToLobby = vi.fn();
    render(
      <OutcomePracticeActions
        controls={controls}
        onRestart={vi.fn()}
        onReplay={onReplay}
        onReturnToLobby={onReturnToLobby}
      />,
    );
    const retry = screen.getByRole('button', { name: 'Restart from tick 124' });
    expect(fireEvent.mouseDown(retry)).toBe(false);
    fireEvent.click(retry);
    fireEvent.click(screen.getByRole('button', { name: 'Watch replay' }));
    fireEvent.click(screen.getByRole('button', { name: 'Return to Lobby' }));
    expect(controls.onRetry).toHaveBeenCalledOnce();
    expect(onReplay).toHaveBeenCalledOnce();
    expect(onReturnToLobby).toHaveBeenCalledOnce();
  });
});
