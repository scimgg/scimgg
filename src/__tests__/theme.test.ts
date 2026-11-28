import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getContextMenuColors } from '../components/ContextMenu/contextMenuTypes';
import { type NativeTextColors, THEME } from '../theme';

/** The custom properties declared on `index.css` `:root`, keyed without the `--` prefix. */
const ROOT: Record<string, string> = (() => {
  const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');
  const start = css.indexOf(':root {');
  const block = css.slice(start, css.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/^\s*--([\w-]+):\s*([^;]+);/gm)) tokens[name] = value.trim();
  return tokens;
})();

/** `orangeHover` → `native-orange-hover`. */
const nativeToken = (key: string) => `native-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/**
 * The text colors of the OSRS interfaces. These must never move with the app palette; change them
 * only to recolor the game itself.
 */
const NATIVE: NativeTextColors = {
  orange: '#ff981f',
  orangeHover: '#ffac4d',
  label: '#c8aa6e',
  body: '#d6c4a8',
  muted: '#8e7c5e',
  info: '#60a5fa',
};

/** WCAG 2 contrast between two #rrggbb colors. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = rgb(hex).map((channel) => {
      const c = channel / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function rgb(hex: string): number[] {
  expect(hex).toMatch(/^#[0-9a-f]{6}$/i);
  return [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
}

describe('native interface colors', () => {
  it('keeps them frozen in THEME, the CSS variables and the context menu', () => {
    expect(THEME.colors.native).toEqual(NATIVE);
    for (const [key, value] of Object.entries(NATIVE)) {
      expect(ROOT[nativeToken(key)]).toBe(value);
    }
    const menu = getContextMenuColors();
    expect(menu.target).toBe(NATIVE.orangeHover);
    expect(menu.headerText).toBe(NATIVE.label);
    expect(menu.disabled).toBe(NATIVE.muted);
  });
});

describe('THEME mirrors index.css :root', () => {
  it.each([
    ['background', 'color-bg'],
    ['bgElevated', 'color-bg-elevated'],
    ['surface', 'color-surface'],
    ['surfaceDark', 'color-surface-inset'],
    ['borderHighlight', 'color-border'],
    ['primary', 'color-primary'],
    ['primaryHover', 'color-primary-hover'],
    ['secondary', 'color-secondary'],
    ['textSecondary', 'color-secondary'],
    ['textMuted', 'color-text-muted'],
    ['success', 'color-success'],
    ['danger', 'color-error'],
    ['warning', 'color-warning'],
    ['info', 'color-info'],
    ['heading', 'color-heading'],
    ['accentText', 'color-accent-text'],
  ] as const)('THEME.colors.%s matches --%s', (key, token) => {
    expect(THEME.colors[key]).toBe(ROOT[token]);
  });

  it('keeps the glass panel on the page background', () => {
    expect(THEME.glass.panel).toBe(ROOT['color-bg']);
  });
});

describe('app palette', () => {
  it('carries the app text levels', () => {
    expect({
      heading: ROOT['color-heading'],
      label: ROOT['color-secondary'],
      body: ROOT['color-text-body'],
      muted: ROOT['color-text-muted'],
      dim: ROOT['color-text-dim'],
      accent: ROOT['color-primary'],
      accentText: ROOT['color-accent-text'],
    }).toEqual({
      heading: '#e2cea3',
      label: '#c3a777',
      body: '#d3c2a3',
      muted: '#9c8768',
      dim: '#625340',
      accent: '#cf8a3e',
      accentText: '#e0a35c',
    });
  });

  it('keeps every readable level above WCAG AA on its panel and its drawer', () => {
    for (const surface of [ROOT['color-bg-solid'], ROOT['color-bg-elevated']]) {
      for (const level of [
        'color-heading',
        'color-secondary',
        'color-text-body',
        'color-accent-text',
        'color-text-muted',
      ]) {
        expect(contrast(ROOT[level], surface)).toBeGreaterThanOrEqual(4.5);
      }
      // The accent is an indicator: non-text contrast.
      expect(contrast(ROOT['color-primary'], surface)).toBeGreaterThanOrEqual(3);
    }
  });

  it('steps heading above body far enough to read as a level', () => {
    // Warm parchment, close to body in brightness on purpose: headings step up by warmth,
    // weight and size (as OSRS titles do), not by being near-white.
    expect(contrast(ROOT['color-heading'], ROOT['color-text-body'])).toBeGreaterThanOrEqual(1.05);
  });
});

describe('Inferno spawn diagram colors', () => {
  const tokens = [
    'color-spawn-mager',
    'color-spawn-meleer',
    'color-spawn-ranger',
    'color-spawn-blob',
    'color-spawn-bat',
  ] as const;

  it('keeps a distinct blue player marker with terrain contrast', () => {
    // The true-tile frame also carries the native-size You label on the arena floor.
    expect(contrast(ROOT['color-spawn-player'], ROOT['color-surface-inset'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ROOT['color-heading'], ROOT['color-border'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ROOT['color-text-muted'], ROOT['color-surface-inset'])).toBeGreaterThanOrEqual(4.5);
    const [r, g, b] = rgb(ROOT['color-spawn-player']);
    expect(b).toBeGreaterThan(g + 20);
    expect(g).toBeGreaterThan(r + 30);
  });

  it('keeps stable monster identities independently of the accent', () => {
    const [mr, mg, mb] = rgb(ROOT['color-spawn-mager']);
    expect(mr).toBeGreaterThan(Math.max(mg, mb) + 30);
    const [or, og, ob] = rgb(ROOT['color-spawn-meleer']);
    expect(or).toBeGreaterThan(og + 25);
    expect(og).toBeGreaterThan(ob + 25);
    const [gr, gg, gb] = rgb(ROOT['color-spawn-ranger']);
    expect(gg).toBeGreaterThan(Math.max(gr, gb) + 20);
    const [yr, yg, yb] = rgb(ROOT['color-spawn-blob']);
    expect(Math.min(yr, yg)).toBeGreaterThan(yb + 45);
    expect(Math.abs(yr - yg)).toBeLessThan(35);
    const grey = rgb(ROOT['color-spawn-bat']);
    expect(Math.max(...grey) - Math.min(...grey)).toBeLessThan(10);
  });

  it('keeps labels legible over both resting and hovered monster fills', () => {
    // Body ink stays legible on the shared hover surface.
    expect(contrast(ROOT['color-text-body'], ROOT['color-surface-hover'])).toBeGreaterThanOrEqual(4.5);
    const base = rgb(ROOT['color-surface-inset']);
    for (const token of tokens) {
      // `.spawn-map__slot.is-filled` resting and hovered mixes over the inset (SpawnLayoutMap.css).
      for (const share of [0.25, 0.32]) {
        const fill = `#${rgb(ROOT[token])
          .map((channel, i) =>
            Math.round(channel * share + base[i] * (1 - share))
              .toString(16)
              .padStart(2, '0'),
          )
          .join('')}`;
        expect(contrast(ROOT['color-heading'], fill)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
