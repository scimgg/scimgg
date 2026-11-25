// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fpsReporter } from '../../render/core/fpsReporter';
import { skipWithoutSetup } from '../../test/helpers/setupAssets';
import { FpsOverlay, fpsSizer, fpsValueOffset } from '../FpsOverlay';

/**
 * Each digit's (and the dash's) advance in a TrueType face, from its `cmap` (format 4) and `hmtx`
 * tables: enough to check which digit is widest without a font library.
 */
function digitAdvances(font: Buffer): Record<string, number> {
  const tables = new Map<string, number>();
  for (let i = 0, n = font.readUInt16BE(4); i < n; i++) {
    const at = 12 + i * 16;
    tables.set(font.toString('latin1', at, at + 4), font.readUInt32BE(at + 8));
  }
  const cmap = tables.get('cmap') as number;
  let format4 = -1;
  for (let i = 0, n = font.readUInt16BE(cmap + 2); i < n; i++) {
    const offset = cmap + font.readUInt32BE(cmap + 4 + i * 8 + 4);
    if (font.readUInt16BE(offset) === 4) format4 = offset;
  }
  const segments = font.readUInt16BE(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  const glyphOf = (code: number) => {
    for (let s = 0; s < segments; s++) {
      if (font.readUInt16BE(ends + s * 2) < code) continue;
      if (font.readUInt16BE(starts + s * 2) > code) return 0;
      const delta = font.readInt16BE(deltas + s * 2);
      const range = font.readUInt16BE(ranges + s * 2);
      if (range === 0) return (code + delta) & 0xffff;
      const glyph = font.readUInt16BE(ranges + s * 2 + range + (code - font.readUInt16BE(starts + s * 2)) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
  const metrics = font.readUInt16BE((tables.get('hhea') as number) + 34);
  const hmtx = tables.get('hmtx') as number;
  const advance = (glyph: number) => font.readUInt16BE(hmtx + Math.min(glyph, metrics - 1) * 4);
  return Object.fromEntries([...'0123456789—'].map((char) => [char, advance(glyphOf(char.charCodeAt(0)))]));
}

afterEach(() => {
  // The reporter is a module singleton: leave no value for the next suite's seed read.
  fpsReporter.report(0);
  vi.restoreAllMocks();
});

/** The digit-advance cases read the font `npm run setup` builds from the cache. */
const noFonts = skipWithoutSetup('fonts');

describe('FpsOverlay', () => {
  it('renders nothing while hidden', () => {
    fpsReporter.report(60);
    render(<FpsOverlay visible={false} />);
    expect(screen.queryByTestId('fps-overlay')).toBeNull();
  });

  const value = () => screen.getByTestId('fps-overlay').querySelector('.fps-overlay__value')?.textContent;
  const sizer = () => screen.getByTestId('fps-overlay').querySelector('.fps-overlay__sizer')?.textContent;

  it('shows a placeholder until the first report, then every reported value', () => {
    render(<FpsOverlay visible />);
    expect(value()).toBe('—');
    act(() => fpsReporter.report(59));
    expect(value()).toBe('59');
    act(() => fpsReporter.report(144));
    expect(value()).toBe('144');
  });

  it('seeds from the latest report when it opens', () => {
    fpsReporter.report(75);
    render(<FpsOverlay visible />);
    expect(value()).toBe('75');
  });

  it('sizes its box by the number of digits alone, never by which digits', () => {
    render(<FpsOverlay visible backed />);
    // The placeholder reserves one digit.
    expect(sizer()).toBe('8');
    const seen: Record<number, string | null | undefined> = {};
    for (const fps of [9, 59, 60, 61, 88, 140, 144, 145, 240]) {
      act(() => fpsReporter.report(fps));
      seen[fps] = sizer();
      expect(value()).toBe(String(fps));
    }
    expect(seen[9]).toBe('8');
    for (const fps of [59, 60, 61, 88]) expect(seen[fps], String(fps)).toBe('88');
    for (const fps of [140, 144, 145, 240]) expect(seen[fps], String(fps)).toBe('888');
    expect(fpsSizer(0)).toBe('8');
  });

  it.skipIf(noFonts)('centers the value in its box on a whole pixel, as the face advances each digit', () => {
    const advances = digitAdvances(readFileSync(join(process.cwd(), 'public/fonts/RuneScape-Plain-12.ttf')));
    const width = (text: string) => [...text].reduce((sum, digit) => sum + advances[digit], 0);
    // 144 in 888's box: 24 - 20, two pixels a side. 165: 24 - 21, the odd pixel to the right.
    expect(fpsValueOffset(width('888'), width('144'))).toBe(2);
    expect(fpsValueOffset(width('888'), width('165'))).toBe(1);
    expect(fpsValueOffset(width('88'), width('60'))).toBe(0);
    expect(fpsValueOffset(width('88'), width('11'))).toBe(2);
    // A wider face: flush left, and the box grows to the value.
    expect(fpsValueOffset(16, 20)).toBe(0);
  });

  it('writes the offset onto the value as it changes', () => {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('fps-overlay__sizer')
        ? 24
        : this.classList.contains('fps-overlay__value')
          ? 20
          : 0;
    });
    render(<FpsOverlay visible backed />);
    act(() => fpsReporter.report(144));
    const valueNode = screen.getByTestId('fps-overlay').querySelector<HTMLElement>('.fps-overlay__value');
    expect(valueNode?.style.marginLeft).toBe('2px');
  });

  it.skipIf(noFonts)("reserves the face's widest digit: no digit in RuneScape Plain 12 advances further than 8", () => {
    const advances = digitAdvances(readFileSync(join(process.cwd(), 'public/fonts/RuneScape-Plain-12.ttf')));
    const widest = Math.max(...Object.values(advances));
    expect(advances['8']).toBe(widest);
    // The placeholder dash is no wider than one reserved digit.
    expect(advances['—']).toBeLessThanOrEqual(widest);
  });

  it('draws an opaque click-through backing when asked (the desktop chrome), right-anchored', () => {
    render(<FpsOverlay visible backed position={{ right: 4, top: 36 }} />);
    const overlay = screen.getByTestId('fps-overlay');
    expect(overlay).toHaveClass('fps-overlay--backed');
    expect(overlay.style.right).toBe('4px');
    expect(overlay.style.top).toBe('36px');
    expect(overlay.style.left).toBe('');
    expect(overlay.style.pointerEvents).toBe('none');
    const css = readFileSync(join(process.cwd(), 'src/components/FpsOverlay.css'), 'utf8');
    const backing = /\.fps-overlay--backed \.fps-overlay__box\s*\{([^}]*)\}/s.exec(css)?.[1] ?? '';
    expect(backing).toMatch(/background:\s*var\(--color-bg-solid\)/);
    expect(backing).toMatch(/border:\s*1px solid var\(--color-border\)/);
    expect(backing).not.toMatch(/box-shadow|opacity|rgba|transparent/);
  });

  it('keeps clicks and sits on the pixel fonts native 16px grid', () => {
    render(<FpsOverlay visible />);
    const { style } = screen.getByTestId('fps-overlay');
    expect(style.pointerEvents).toBe('none');
    expect(style.fontSize).toBe('16px');
    expect(style.lineHeight).toBe('16px');
    expect(style.fontFamily).toContain('RuneScape Plain 12');
  });

  it('ends above the top-right Plugins button, which Auto zooms downward from a fixed top', () => {
    render(<FpsOverlay visible />);
    const { style } = screen.getByTestId('fps-overlay');
    const bottom = Number.parseFloat(style.top) + Number.parseFloat(style.lineHeight);
    // `.sidebar-nav` divides its offset by the zoom it is drawn at, so its screen top is
    // this base value at every Auto size (the narrow-window rule is a separate layout).
    const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8');
    const navTop = /\.sidebar-nav\s*\{[^}]*?\btop:\s*calc\(\(\s*(\d+)px/s.exec(css);
    expect(navTop).toBeTruthy();
    expect(bottom).toBeLessThanOrEqual(Number(navTop?.[1]));
  });

  it('on mobile goes under every drawer and sheet, whose close shares its corner', () => {
    const css = (file: string) => readFileSync(join(process.cwd(), file), 'utf8');
    const zIndex = (source: string, selector: string) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const rule = new RegExp(`${escaped}\\s*\\{[^}]*?z-index:\\s*(\\d+)`, 's').exec(source);
      expect(rule, selector).toBeTruthy();
      return Number(rule?.[1]);
    };
    const fps = css('src/components/FpsOverlay.css');
    const mobile = zIndex(fps, ':root[data-mobile-ui] .fps-overlay');
    // The lowest layer of any sheet: the drawers' text-free shadow siblings.
    expect(mobile).toBeLessThan(zIndex(css('src/components/SettingsSidebar.css'), '.controls-overlay-shadow'));
    expect(mobile).toBeLessThan(zIndex(css('src/components/PluginsPanel.css'), '.plugins-overlay-shadow'));
    // Desktop keeps it over everything it always sat above.
    expect(zIndex(fps, '.fps-overlay')).toBe(1000);
    render(<FpsOverlay visible />);
    expect(screen.getByTestId('fps-overlay').className).toBe('fps-overlay');
  });
});
