// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOL_HEREDIT_MODIFIERS } from '../../encounters/solHeredit/modifiers';
import { ModifierSelector } from '../ModifierSelector';

describe('ModifierSelector', () => {
  afterEach(cleanup);

  it("names the selection in the header and shows each modifier's current effect", () => {
    render(<ModifierSelector modifiers={SOL_HEREDIT_MODIFIERS} value={{ doom: 2 }} onChange={() => {}} />);
    expect(screen.getByText('Doom II')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Modifiers/ }));
    expect(screen.getByRole('button', { name: 'Bees! tier III' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Doom tier II' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('Doom kills at 10 stacks.', { ignore: '[aria-hidden="true"]' })).toBeTruthy();
    // An inactive modifier describes itself instead.
    expect(
      screen.getByText('An orb circles the pillars, dealing 10–20 damage.', {
        ignore: '[aria-hidden="true"]',
      }),
    ).toBeTruthy();
  });

  it("lists Sol's modifiers alphabetically", () => {
    expect(SOL_HEREDIT_MODIFIERS.map(({ name }) => name)).toEqual([
      'Bees!',
      'Blasphemy',
      'Doom',
      'Dynamic Duo',
      'Frailty',
      'Myopia',
      'Quartet',
      'Red Flag',
      'Relentless',
      'Solarflare',
      'Totemic',
      'Volatility',
    ]);
  });

  it.each([
    [10, '5'],
    [9, '5'],
    [1, '1'],
  ])('sizes the column-first grid for %i modifiers to %s rows', (count, rows) => {
    const { container } = render(
      <ModifierSelector modifiers={SOL_HEREDIT_MODIFIERS.slice(0, count)} value={{}} onChange={() => {}} />,
    );
    const grid = container.querySelector<HTMLElement>('.modifier-grid');
    expect(grid?.style.getPropertyValue('--modifier-rows')).toBe(rows);
  });

  it('keeps damage ranges in summaries and explains tier effects without provisional copy', () => {
    const solarflare = SOL_HEREDIT_MODIFIERS.find(({ id }) => id === 'solarflare');
    const volatility = SOL_HEREDIT_MODIFIERS.find(({ id }) => id === 'volatility');
    expect(solarflare?.summary).toContain('10–20');
    expect(solarflare?.tiers).toEqual([
      'The orb moves every 2 ticks, with 7-tick corner gaps. Departure hits land one tick later.',
      'The orb moves every 2 ticks without stopping. Departure hits land one tick later.',
      'The orb moves every tick, with 2-tick corner gaps, and disables protection prayers on departure. Hits land one tick later.',
    ]);
    expect(volatility?.summary).toContain('16–24');
    expect(volatility?.tiers).toEqual([
      'The explosion reaches one tile beyond the enemy footprint.',
      'The explosion reaches two tiles beyond the enemy footprint.',
      "The explosion reaches two tiles beyond the enemy footprint. The center sand pool isn't simulated yet.",
    ]);
    for (const modifier of [solarflare, volatility]) {
      expect(modifier).toBeDefined();
      expect([modifier?.summary, ...modifier!.tiers].join(' ')).not.toMatch(/provisional/i);
      expect(modifier?.tiers.join(' ')).not.toMatch(/10–20|16–24/);
    }
  });

  it('sets a tier and clears it again with Off', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ModifierSelector modifiers={SOL_HEREDIT_MODIFIERS} value={{ doom: 2 }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Modifiers/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Solarflare tier III' }));
    expect(onChange).toHaveBeenLastCalledWith({ doom: 2, solarflare: 3 });

    rerender(
      <ModifierSelector modifiers={SOL_HEREDIT_MODIFIERS} value={{ doom: 2, solarflare: 3 }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Doom off' }));
    expect(onChange).toHaveBeenLastCalledWith({ solarflare: 3 });
  });

  it.each([
    ['quartet', 'Quartet'],
    ['totemic', 'Totemic'],
  ])('offers %s only as Off or I and names it without a tier', (id, name) => {
    const onChange = vi.fn();
    render(<ModifierSelector modifiers={SOL_HEREDIT_MODIFIERS} value={{ [id]: 1 }} onChange={onChange} />);
    expect(screen.getByText(name, { selector: '.modifier-summary' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Modifiers/ }));
    const group = screen.getByRole('group', { name: `${name} tier` });
    expect([...group.querySelectorAll('button')].map((button) => button.textContent)).toEqual(['Off', 'I']);
    expect(screen.getByRole('button', { name: `${name} tier I` })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: `${name} off` }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });
});
