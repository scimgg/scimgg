import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssRuleBlocks, withoutCssComments } from '../test/helpers/cssRules';

/**
 * DESIGN.md, Opacity: a Scim-owned surface is translucent if and only if it is click-through.
 *
 * Glass (a fill the scene shows through) is for overlays the player looks through and clicks
 * through: infoboxes and the plugin overlays. Everything that takes a click is opaque: the
 * launchers and their panes, the replay bar, sidebars, dialogs, hover cards, the Mobile tool window.
 *
 * Maintaining it: a new glass surface goes in CLICK_THROUGH_GLASS with the component that renders
 * it click-through; a new interactive surface goes in OPAQUE_SURFACES, and a scrolling text box
 * inside one in SCROLLING_TEXT_BOXES. The scan below fails on glass anywhere else, so a translucent
 * control cannot slip in unlisted. Listed surfaces also keep LCD text: no outer box-shadow on them.
 */

const SRC = join(__dirname, '..');

/** What makes a fill glass: a backdrop blur, or the HUD's translucent fill token. */
const GLASS_MARKERS: readonly RegExp[] = [
  /backdrop-filter\s*:(?!\s*none\b)[^;]+;/,
  /background(?:-color)?\s*:[^;]*var\(--hud-bg\)/,
];

/** The click-through overlays allowed glass, each with the component that must render it click-through. */
const CLICK_THROUGH_GLASS: Readonly<Record<string, string>> = {
  'components/InfoBox/InfoBox.css': 'components/InfoBox/InfoBoxPanel.tsx',
  'components/BossHealthBarOverlay.css': 'components/BossHealthBarOverlay.tsx',
  'components/DetailedDpsOverlay.css': 'components/DetailedDpsOverlay.tsx',
  'components/PrayerFlickOverlay.css': 'components/PrayerFlickOverlay.tsx',
  'components/ZukSetTimerOverlay.css': 'components/ZukSetTimerOverlay.tsx',
};

/** Interactive surfaces, each the rule that paints its fill, which must be an opaque token. */
const OPAQUE_SURFACES: readonly (readonly [file: string, selector: string])[] = [
  ['components/launcher/TopChrome.css', '.launcher-btn'],
  ['components/launcher/TopChrome.css', '.launcher-pane'],
  ['components/MobileToolWindow.css', '.osm-tools__window'],
  ['components/ReplayControls.css', '.replay-bar'],
  ['components/ReplayPractice.css', '.practice-retry-bar'],
  ['components/PracticeSessionBar.css', '.session-bar'],
  ['components/launcher/EncounterWorkbench.css', '.encounter-workbench'],
  ['encounters/inferno/InfernoSpawnSetup.css', '.inferno-layout-editor'],
  ['components/SpawnLayoutMap.css', '.spawn-picker'],
  ['encounters/colosseum/ColosseumIntermission.css', '.colosseum-intermission'],
  ['encounters/colosseum/ColosseumSpawnSetup.css', '.colosseum-layout-editor'],
  ['components/SettingsSidebar.css', '.controls-overlay'],
  ['components/PluginsPanel.css', '.plugins-overlay'],
  ['components/ui/HoverCard.css', '.hover-card'],
  ['components/ModifiersModal.css', '.modifiers-modal-card'],
  ['components/ZoomHintToast.css', '.zoom-hint-toast'],
  ['components/MobileLayoutEditBar.css', '.layout-edit-pill'],
  ['components/HardwareAccelWarning.css', '.hw-accel-strip'],
  ['components/ui/SystemNotice.css', '.sys-notice'],
  ['components/BrowserSuggestions.css', '.browser-suggestion'],
  ['tutorial/components/TutorialOverlay.css', '.tutorial-beam'],
  ['tutorial/components/TutorialOverlay.css', '.tutorial-beam-menu'],
  ['tutorial/components/TutorialOverlay.css', '.tutorial-codex'],
];

/**
 * Scrolling text boxes inside those surfaces. A scroller is its own compositing layer, and an
 * ancestor's fill (or a canvas drawn under it) does not make that layer opaque, so each paints its
 * own opaque fill or every glyph in it loses LCD text (docs/agent-reference.md, LCD text).
 */
const SCROLLING_TEXT_BOXES: readonly (readonly [file: string, selector: string])[] = [
  ['components/launcher/EncounterWorkbench.css', '.encounter-workbench__body'],
  ['components/SpawnLayoutMap.css', '.spawn-picker'],
  ['components/launcher/TopChrome.css', '.launcher-pane__body'],
  ['tutorial/components/TutorialOverlay.css', '.tutorial-codex-body'],
  ['components/ModifiersModal.css', '.modifiers-modal-body'],
  ['encounters/colosseum/ColosseumIntermission.css', '.colosseum-intermission__body'],
  ['encounters/colosseum/ColosseumIntermission.css', '.colosseum-intermission__scroll'],
  ['components/MobileToolWindow.css', '.osm-tools__practice-content'],
  ['components/MobileToolWindow.css', '.osm-tools__transport'],
  ['components/MobileToolWindow.css', '.osm-tools__menu'],
  ['components/MobileToolWindow.css', '.osm-tools__compact-note'],
  ['components/MobileToolWindow.css', '.osm-tools__window[data-tiny-slot] .osm-tools__practice'],
];

/** The pack's opaque fills. The `--hud-bg` and `*-translucent` tokens are not among them. */
const OPAQUE_FILLS = new Set([
  'var(--color-bg-solid)',
  'var(--color-bg)',
  'var(--color-bg-elevated)',
  'var(--color-surface)',
  'var(--color-surface-inset)',
  // The system-notice family's fill. Each host picks the opaque token that reads against its own
  // backdrop (`bg-solid` over the scene, `surface` on the browser support screen); the fallback
  // is opaque, so a host that sets nothing still paints one.
  'var(--notice-fill, var(--color-bg-solid))',
]);

function stylesheets(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : stylesheets(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

function ruleBodies(css: string, selector: string): string[] {
  return cssRuleBlocks(css)
    .filter((block) => block.selectors.includes(selector))
    .map((block) => block.body);
}

function surfaceRules(file: string, selector: string): string[] {
  const bodies = ruleBodies(readFileSync(join(SRC, file), 'utf8'), selector);
  expect(bodies.length, `${selector} not found in ${file}`).toBeGreaterThan(0);
  return bodies;
}

/** A box-shadow value's layers, split on the commas outside any function's parentheses. */
function shadowLayers(value: string): string[] {
  const layers: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '(') depth++;
    else if (value[i] === ')') depth--;
    else if (value[i] === ',' && depth === 0) {
      layers.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  layers.push(value.slice(start).trim());
  return layers;
}

function expectOpaqueFills(selector: string, bodies: string[]) {
  const fills = bodies.flatMap((body) =>
    [...body.matchAll(/background(?:-color)?\s*:\s*([^;]+);/g)].map((match) => match[1].trim()),
  );
  // Overrides need not repeat the fill, but every fill declaration must be opaque.
  expect(fills.length, `${selector} paints no fill of its own`).toBeGreaterThan(0);
  for (const fill of fills) expect(OPAQUE_FILLS.has(fill), `${selector}: ${fill}`).toBe(true);
  for (const body of bodies) expect(body).not.toMatch(/backdrop-filter\s*:(?!\s*none\b)/);
}

function expectNoOuterShadows(selector: string, bodies: string[]) {
  for (const body of bodies) {
    for (const [, value] of body.matchAll(/box-shadow\s*:\s*([^;]+);/g)) {
      for (const layer of shadowLayers(value)) {
        expect(layer === 'none' || /^inset\b/.test(layer), `${selector}: outer box-shadow "${layer}"`).toBe(true);
      }
    }
  }
}

describe('surface opacity (DESIGN.md, Opacity)', () => {
  it('clips the Mobile dock wrapper rather than the selected text button, preserving LCD text', () => {
    const file = 'components/MobileToolWindow.css';
    expect(surfaceRules(file, '.osm-tools__dock').some((body) => /overflow\s*:\s*hidden/.test(body))).toBe(true);
    for (const body of surfaceRules(file, '.osm-tools__dock-button')) {
      expect(body).not.toMatch(/overflow(?:-[xy])?\s*:\s*(?:hidden|clip)\b/);
    }
  });
  // `scrollbar-gutter: stable` left the rail uncomposited: an SVG or input scrolled out above its
  // top dropped every label below it to grayscale. An always-present scrollbar keeps the 8px.
  it('replaces every stable gutter on the configurer rail with an always-present scrollbar', () => {
    const blocks = cssRuleBlocks(readFileSync(join(SRC, 'components/EncounterConfigurer.css'), 'utf8'));
    const onRail = blocks.filter((block) => block.selectors.includes('.encounter-panel-rail'));
    const stable = onRail.filter((block) => /scrollbar-gutter\s*:\s*stable\b/.test(block.body));
    const replacements = onRail.filter(
      (block) => /overflow-y\s*:\s*scroll\b/.test(block.body) && /scrollbar-gutter\s*:\s*auto\b/.test(block.body),
    );
    expect(stable.length).toBeGreaterThan(0);
    for (const block of stable) {
      expect(
        replacements.some((replacement) => replacement.index > block.index),
        '.encounter-panel-rail lost overflow-y: scroll + scrollbar-gutter: auto after a stable gutter',
      ).toBe(true);
    }
    expect(
      blocks.some(
        (block) =>
          block.selectors.includes('.encounter-panel-rail::-webkit-scrollbar-track:disabled') &&
          /background\s*:\s*var\(--color-bg-solid\)/.test(block.body),
      ),
      'an idle rail scrollbar must keep the rail fill, as the empty gutter did',
    ).toBe(true);
  });
  it('keeps glass to the listed click-through overlays', () => {
    const offenders = stylesheets(SRC)
      .map((path) => relative(SRC, path).replaceAll('\\', '/'))
      .filter((file) => !(file in CLICK_THROUGH_GLASS))
      .filter((file) =>
        GLASS_MARKERS.some((marker) => marker.test(withoutCssComments(readFileSync(join(SRC, file), 'utf8')))),
      );
    expect(offenders, 'translucent fill outside a click-through overlay: make it opaque, or list it').toEqual([]);
  });

  it.each(Object.entries(CLICK_THROUGH_GLASS))('renders the glass in %s click-through (%s)', (_, component) => {
    const source = readFileSync(join(SRC, component), 'utf8');
    // DraggablePanel's passthrough layer is `pointer-events: none` until Alt makes it movable.
    expect(source).toMatch(/\bpointerPassthrough\b(?!\s*=\s*\{false\})/);
  });

  it.each(OPAQUE_SURFACES)('paints %s %s with an opaque fill and no blur', (file, selector) => {
    expectOpaqueFills(selector, surfaceRules(file, selector));
  });

  it.each(SCROLLING_TEXT_BOXES)('gives the scroller %s %s its own opaque fill', (file, selector) => {
    const bodies = surfaceRules(file, selector);
    expect(
      bodies.some((body) => /overflow(?:-y)?\s*:\s*(?:auto|scroll)\b/.test(body)),
      `${selector} no longer scrolls: drop it from SCROLLING_TEXT_BOXES`,
    ).toBe(true);
    expectOpaqueFills(selector, bodies);
  });

  // An outer shadow on the element painting the text's background is an LCD-text veto for its whole
  // subtree, opaque fill or not. Inset shadows stay inside the box and are fine; a drop shadow goes
  // on a text-free layer (a sibling, or a ::before on a box that never clips).
  it.each([...OPAQUE_SURFACES, ...SCROLLING_TEXT_BOXES])('puts no outer box-shadow on %s %s', (file, selector) => {
    expectNoOuterShadows(selector, surfaceRules(file, selector));
  });
});

describe('surface opacity — the declaration guards fire', () => {
  const selector = '.launcher-btn';
  const opaque = `${selector} { background: var(--color-bg-solid); }`;

  it('finds grouped selectors, including nested rules and commas inside :is()', () => {
    const css = `/* ignored { rule } */
      .launcher-btn-extra { background: rgba(0, 0, 0, .5); }
      .launcher-btn:hover { background: rgba(0, 0, 0, .5); }
      .launcher-btn, .other :is(input[type="text"], textarea) { background: var(--color-bg-solid); }
      @media (max-width: 600px) { .other, .launcher-btn { padding: 2px; } }`;
    const bodies = ruleBodies(css, selector);
    expect(bodies).toEqual([' background: var(--color-bg-solid); ', ' padding: 2px; ']);
    expectOpaqueFills(selector, bodies);
    expectNoOuterShadows(selector, bodies);
    expect(ruleBodies(css, '.missing')).toEqual([]);
  });

  it('rejects a later translucent fill, even if another opaque declaration follows', () => {
    const css = `${opaque}\n${selector} { background: rgba(0, 0, 0, .5); }\n${opaque}`;
    expect(() => expectOpaqueFills(selector, ruleBodies(css, selector))).toThrow(/rgba/);
  });

  it('rejects a later blur in a nested grouped rule with no fill declaration', () => {
    const css = `${opaque}\n@media (max-width: 600px) {
      .other, ${selector} { backdrop-filter: blur(4px); }
    }`;
    expect(() => expectOpaqueFills(selector, ruleBodies(css, selector))).toThrow();
  });

  it('rejects an outer shadow in a later override, even beside an inset shadow', () => {
    const css = `${opaque}\n${selector} {
      box-shadow: inset 0 0 1px rgba(0, 0, 0, .5), 0 2px 4px black;
    }`;
    expect(() => expectNoOuterShadows(selector, ruleBodies(css, selector))).toThrow(/outer box-shadow/);
  });

  it('allows inset-only shadows and none in later overrides', () => {
    const css = `${opaque}\n${selector} {
      box-shadow: inset 0 0 1px rgba(0, 0, 0, .5), inset 0 0 2px black;
    }\n${selector} { box-shadow: none; }`;
    const bodies = ruleBodies(css, selector);
    expectOpaqueFills(selector, bodies);
    expectNoOuterShadows(selector, bodies);
  });
});
