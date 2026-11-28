---
name: Scim.GG
description: Browser-based OSRS combat practice simulator
colors:
  # App chrome palette. Set on src/index.css :root and mirrored in THEME.colors
  # (src/theme.ts).
  primary: "#cf8a3e"
  primary-hover: "#e6ad6a"
  primary-structure: "#6a5e4e"
  accent-text: "#e0a35c"
  secondary: "#c3a777"
  # JS-only (THEME.colors), not a CSS variable.
  secondary-hover: "#d6be92"
  # Derived in index.css, not a :root color: color-mix(in srgb, secondary 12%, bg-elevated).
  # The hex below is that mix resolved.
  primary-dim: "#3c3225"
  # Shared action recipe; mixes secondary with bg-elevated, independent of selected wells.
  action-fill: "#362d21"
  action-hover: "#463a2b"
  action-edge: "#988463"
  heading: "#e2cea3"
  text-body: "#d3c2a3"
  text-muted: "#9c8768"
  text-dim: "#625340"
  bg: "#221c14"
  bg-solid: "#221c14"
  bg-elevated: "#2a221a"
  surface: "#181410"
  surface-inset: "#0c0a06"
  surface-hover: "#3e3828"
  surface-highlight: "#ffffff0d"
  border: "#3e3428"
  # JS-only (THEME.colors), not CSS variables.
  border-highlight: "#3e3428"
  border-dark: "#121210"
  error: "#cf715f"
  success: "#86b46e"
  warning: "#e0b04a"
  info: "#85a3bd"
  limited-notice: "#8c8c8c"
  spawn-mager: "#cf715f"
  spawn-meleer: "#df914c"
  spawn-ranger: "#86b46e"
  spawn-blob: "#dabe66"
  spawn-bat: "#949494"
  spawn-player: "#80c7f2"
  surface-translucent: "#18140eeb"
  border-translucent: "#3e342880"
  infobox-tint: "#120e0abf"
  hud-bg: "#221c14e0"
  hud-border: "#3e342840"
  # Native interface text (--native-*): frozen, never follows the app palette.
  native-orange: "#ff981f"
  native-orange-hover: "#ffac4d"
  native-label: "#c8aa6e"
  native-body: "#d6c4a8"
  native-muted: "#8e7c5e"
  native-info: "#60a5fa"
typography:
  # Native em: every RuneScape face rasterizes on its pixel grid at 16px and integer multiples.
  terminal:
    fontFamily: "RuneScape Bold 12, sans-serif"
    fontSize: "48px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "0px"
  display:
    fontFamily: "RuneScape Bold 12, sans-serif"
    fontSize: "32px"
    fontWeight: 400
    lineHeight: "32px"
    letterSpacing: "0px"
  title:
    fontFamily: "RuneScape Bold 12, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0px"
  body:
    fontFamily: "RuneScape Plain 12, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "20px"
    letterSpacing: "0px"
  control-label:
    fontFamily: "RuneScape Bold 12, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "16px"
    letterSpacing: "0px"
  hint:
    fontFamily: "RuneScape Plain 11, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "18px"
    letterSpacing: "0px"
  small:
    fontFamily: "RuneScape Plain 11, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "16px"
    letterSpacing: "0px"
  readout:
    fontFamily: "RuneScape Small, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: "14px"
    letterSpacing: "0px"
  # Off-grid chrome scale: sizes used by shared primitives and some surfaces.
  # Glance-only text; do not extend it to new text (see Typography).
  chrome-title:
    fontFamily: "RuneScape Bold 12, sans-serif"
    fontSize: "20px"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "0px"
  chrome-section:
    fontFamily: "RuneScape Bold 12, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.5px"
  chrome-label:
    fontFamily: "RuneScape Bold 12, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0px"
  chrome-data:
    fontFamily: "RuneScape Bold 12, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0px"
  chrome-caption:
    fontFamily: "RuneScape Plain 12, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.3
    letterSpacing: "0px"
  chrome-sublabel:
    fontFamily: "RuneScape Bold 12, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "1px"
rounded:
  none: "0px"
  xs: "2px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
components:
  button-default:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.secondary}"
    typography: "{typography.title}"
    rounded: "{rounded.xs}"
    padding: "8px 16px"
  button-default-hover:
    backgroundColor: "{colors.surface-hover}"
    textColor: "{colors.accent-text}"
    typography: "{typography.title}"
    rounded: "{rounded.xs}"
    padding: "8px 16px"
  button-primary:
    backgroundColor: "{colors.action-fill}"
    textColor: "{colors.heading}"
    borderColor: "{colors.action-edge}"
    typography: "{typography.title}"
    rounded: "{rounded.xs}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
    textColor: "{colors.heading}"
    typography: "{typography.title}"
    rounded: "{rounded.xs}"
    padding: "8px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.secondary}"
    typography: "{typography.title}"
    rounded: "{rounded.xs}"
    padding: "8px 16px"
  checkbox:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.secondary}"
    typography: "{typography.control-label}"
    rounded: "{rounded.xs}"
    size: "16px"
  checkbox-checked:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.primary}"
    typography: "{typography.control-label}"
    rounded: "{rounded.xs}"
    size: "16px"
  toggle-off:
    backgroundColor: "{colors.surface-inset}"
    # Thumb: text-muted 72% mixed with text-dim, resolved.
    textColor: "#8c785d"
    height: "14px"
    width: "28px"
  toggle-on:
    # Fill: primary 24% mixed with surface-inset, resolved.
    # Edge: primary-structure 65% mixed with that fill. textColor is the thumb.
    backgroundColor: "#3b2913"
    textColor: "{colors.heading}"
    height: "14px"
    width: "28px"
  toggle-on-hover:
    # Fill: primary 30% mixed with surface-inset, resolved.
    # Edge follows the same mix as toggle-on, using this hover fill.
    backgroundColor: "#463017"
    textColor: "{colors.heading}"
    height: "14px"
    width: "28px"
  number-input:
    backgroundColor: "{colors.surface-inset}"
    textColor: "{colors.secondary}"
    rounded: "{rounded.xs}"
    padding: "3px 4px"
  panel:
    backgroundColor: "{colors.bg-solid}"
    textColor: "{colors.text-body}"
    rounded: "{rounded.none}"
    padding: "16px"
  panel-header:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.heading}"
    typography: "{typography.chrome-title}"
    rounded: "{rounded.none}"
    padding: "12px 16px"
  collapsible-section:
    textColor: "{colors.secondary}"
    typography: "{typography.chrome-section}"
    rounded: "{rounded.xs}"
    padding: "10px 0"
  tooltip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.text-body}"
    typography: "{typography.small}"
    rounded: "{rounded.xs}"
    padding: "8px"
  badge:
    backgroundColor: "#ffffff08"
    textColor: "{colors.text-muted}"
    typography: "{typography.chrome-sublabel}"
    rounded: "{rounded.xs}"
    padding: "3px 5px 3px 6px"
---

# Design System: Scim.GG

## Overview

Scim.GG is a browser-based combat practice simulator for OSRS (Old School RuneScape) players. The encounters are listed in `src/encounters/catalog.ts`. It is a precision tool for standalone encounter practice, not a casual experience.

The visual system is **game-faithful, premium, and precise.** It is rooted in the OSRS pixel aesthetic (RuneScape pixel fonts, dark warm palettes), but Scim.GG's own chrome is executed at higher fidelity than the game's UI. The mood is dark fantasy, refined and restrained, never gritty or grungy.

**Mode**: Operate. The interface serves the simulation, not the other way around.

### Two chrome layers (read this first)

Every surface belongs to exactly one of two layers, and the two follow different rules.

1. **Client-faithful surfaces** reproduce the OSRS client: the chatbox (`src/components/Chatbox.tsx`), the game panel's game tabs (combat, prayer, spellbook, equipment, inventory, skills), the minimap and its orbs, the context menu and item tooltips, scene text such as hitsplats and overhead text, and RuneLite-parity plugin overlays such as the status bars. They follow the client's own art, colors and metrics, taken from the cache or RuneLite. Literal client colors are correct here: `#000` text shadows, `#fff` labels, the chat highlight colors, the stone-button green `#0dc10d`, and the status bars' RuneLite RGBA fills. These colors are fixed. Do not retint them or move them onto app tokens: players recognize these surfaces by matching the client. Their interface text colors come from the frozen `--native-*` tokens.
2. **Scim-owned surfaces** are everything the client does not have: Settings, Plugins, the launcher row and its Practice, Actions and Menu panes, menus, pickers, modals, tutorials, the boss health bar and the setup rail. They use the app palette (`--color-*`) and the rules in the rest of this document, including tinted neutrals.

When a Scim-owned surface sits inside client chrome (the Settings and Keybindings tabs in the game panel), it uses app tokens and keeps the panel's stone texture visible.

**The Surface Family Rule.** Scim-owned panels should feel like members of one product family without copying each other's exact layouts. Consistency comes from shared warmth, restrained interaction states, clear hierarchy, disciplined accent usage and reuse of shared primitives. It does not come from forcing the same layout, section structure or component patterns onto every panel.

### Anti-references (what this is not)

- Generic SaaS chrome: no identical card grids, no hero-metric templates, no gradient text, no glassmorphism as default.
- Faux-3D bevels, inset chrome or exaggerated pressed states. Depth should be quiet.
- Bright, ungrounded neutrals on Scim-owned surfaces. Every app neutral is tinted towards the palette's warm brown, never generic cool gray.
- Visual noise. Most panels should read as controlled and intentional at a glance, with one or two clear points of emphasis.

## Colors

### The palette

The front-matter palette is classic OSRS stone, warm umber neutrals and an orange-brass accent. The interface art is the cache's own, unrecolored.

The palette lives in two places that must agree: the CSS custom properties on `src/index.css` `:root` (for CSS consumers) and the `THEME.colors` object in `src/theme.ts` (for canvas and WebGL consumers). `src/__tests__/theme.test.ts` checks that they match and pins the app text levels and the frozen native colors.

**The Token Rule.** On Scim-owned surfaces, never hard-code a color in component CSS; reference the semantic token (`var(--color-primary)`). The one carried-over client convention is the hard 1px pixel shadow (`text-shadow: 1px 1px 0 #000`) on pixel-font text that sits over busy art: buttons, the launcher row and the boss health bar.

**The AA Rule.** Heading, label (`secondary`), body, muted and accent-text all reach at least 4.5:1 contrast against `bg-solid` and `bg-elevated`. The accent itself (`primary`) is an indicator and needs 3:1. New text levels must hold the same bar.

### App token roles

The palette is intentionally narrow. Restraint is part of the design quality.

| Token | Role |
|---|---|
| `--color-primary` | **Commitment signal.** Fills, active edges, checked marks; persistent active / selected / checked state. Used rarely: if too many things use it, nothing feels selected. |
| `--color-accent-text` | The rare word that must read as the accent: primary-button labels and button hover text. |
| `--color-primary-hover` | Lighter accent for primary on hover. |
| `--color-primary-structure` | Hover borders, toggle and slider structure. |
| `--color-heading` | Titles. Warm parchment, close to body in brightness on purpose: headings step up by warmth, weight and size, not by being near-white. |
| `--color-secondary` | **Resting interactive text** for buttons, section titles and control labels. The dominant role color across Scim-owned chrome. |
| `--color-text-body` | Data text at rest; hover text for labels. |
| `--color-text-muted` | Structural labels, sub-headers, captions, metadata badges. |
| `--color-text-dim` | Disabled and placeholder. Warm-tinted, never cool gray. |
| `--color-error`, `--color-success`, `--color-warning`, `--color-info` | Semantic status. |
| `--color-limited-notice` | The one deliberately untinted gray: the `i` mark and caption on a verified item with an accepted limitation. Kept neutral so it never reads as a status color. |
| `--color-spawn-mager`, `--color-spawn-meleer`, `--color-spawn-ranger`, `--color-spawn-blob`, `--color-spawn-bat` | Spawn diagram identities: red mager, orange meleer, green ranger, yellow blob and gray bat. The Fortis Colosseum reuses them: red serpent shaman, green javelin colossus, yellow manticore and orange shockwave colossus. Those hues stay fixed, independent of the accent and status colors. Labels use heading ink over opaque tinted wells. |
| `--color-spawn-player` | Light blue player start marker, distinct from every monster hue. A square true-tile outline with a quiet tinted fill and an attached You label. |
| `--color-bg-solid`, `--color-bg-elevated` | Panel base and header / drawer background. |
| `--color-surface`, `--color-surface-inset`, `--color-surface-hover`, `--color-surface-highlight` | Control rest, press / inset, hover, overlay highlight. `surface` is also the hover-card fill, one layer above the panel. |
| `--color-border` | Section dividers, panel borders, input borders. Carries most of the depth in the system. |
| `--shadow-glow` | Glow that encodes the primary hue. |
| `--hud-bg`, `--hud-border` | Semi-transparent chrome over the simulation viewport. |
| `--color-surface-translucent`, `--color-border-translucent`, `--infobox-tint` | Tints over an opaque surface (hover rows, headers), and click-through overlays. Never the base fill of a control (the Opacity Rule). |
| `--primary-dim` | Quiet brass-tinted active surface for "primary, persistent, on" controls. **Derived, not a palette color**: `src/index.css` defines it once as `color-mix(in srgb, var(--color-secondary) 12%, var(--color-bg-elevated))`, so it follows the two tokens it mixes. |

`THEME.colors.primaryDim`, `borderHighlight`, `borderDark` and `secondaryHover` are JS-only. `primaryDim` is `rgba(<native orange>, 0.15)` for the context menu's hover row (a native surface), so it never matches a CSS surface painted with `--primary-dim`.

### Native token roles

`--native-orange` (interface names and headings), `--native-orange-hover` (item and target names in tooltips and the context menu), `--native-label`, `--native-body`, `--native-muted` and `--native-info` are the text colors of the client-faithful panels. They are frozen and never follow the app palette. Do not use them on Scim-owned surfaces, and do not use app tokens on client-faithful ones.

### Interaction rhythm (Scim-owned controls)

| State | Text | Background | Border |
|---|---|---|---|
| Resting | `--color-secondary` | `--color-surface` | `--color-border` |
| Hover | `--color-accent-text` (buttons), `--color-text-body` (labels) | `--color-surface-hover` | `--color-primary-structure` |
| Active / Selected | `--color-primary` | `--color-surface-inset` | `--color-primary` |
| Disabled | `--color-text-muted` or `--color-text-dim` | transparent | `--color-border` |

Prefer muted ink and a transparent fill over `opacity` for disabled text-bearing controls: opacity below 1 is one of Blink's LCD-text vetoes.

There is no focus state. The gold outline on an open launcher is selection, not focus. Scim.GG is played with mouse plus keyboard (keys are game hotkeys and typing) or with touch, and a mouse is needed to play, so keyboard-only navigation is a non-goal. Chrome is designed as pointer and touch targets: no Tab stops, focus rings, focus moves, or arrow/Enter navigation on launchers, menus, popovers, tabs, panels or dialogs. Escape may close overlays, and text fields keep normal typing. The loadout editor and the Ctrl+K encounter search keep their keyboard handling; the policy below is the canonical list of exceptions. Mechanisms and rules: [Keyboard and focus policy](./docs/agent-reference.md#keyboard-and-focus-policy).

**The Sticky Active Rule.** Active state must survive hover. Any `.active`, `[aria-checked="true"]` or `[aria-expanded="true"]` selector needs an explicit `:hover` override that preserves the active color intent.

### Practical color tests (Scim-owned panels)

- **Squint test**: only the most important active states stand out at a glance.
- **Hue test**: neutrals feel tinted towards the palette's warm brown, never generic gray.
- **Density test**: if a panel feels noisy, remove emphasis rather than adding separators or brighter colors.

## Typography

Typography uses the **RuneScape pixel font family**. The pixel font is the brand; do not substitute system fonts in production chrome. `:root` and form controls default to `RuneScape Plain 12`, so unstyled text never falls back to a system sans; a component still names its face for its role. The exception is the code-style readouts in the Cache Explorer, which are not pixel-font surfaces.

### Faces (measured from `public/fonts/`)

| Face | Pixel grid | Cap height at 16px | Rasterizer hint (`gasp`) | Use |
|---|---|---|---|---|
| `RuneScape Bold 12` | unitsPerEm 16 | 10px | bilevel | Titles, control labels, section headings, buttons. The workhorse. |
| `RuneScape Plain 12` | unitsPerEm 16 | 10px | bilevel | The default face. Body text and descriptions; chatbox messages and input line. |
| `RuneScape Plain 11` | unitsPerEm 16 | 9px | bilevel | The smaller step at the native em: Practice controls, hover cards, control hints (`.settings-hint`, the pop-out hint) and the Settings legal footer, chatbox tab labels. |
| `RuneScape Quill 8` | unitsPerEm 16 | 12px | bilevel | Client-faithful only, where the client itself uses it: the combat tab's weapon name. It is not a chat face. |
| `RuneScape Small` | unitsPerEm 1024 on a 64-unit grid (16px per em) | 10px | grayscale AA | Numeric and glance readouts: hitsplats and overhead text, orb values, status-bar counters, infobox timers, the boss health bar, the prayer-flick overlay. |

All five faces have a 16px pixel em. Every face uses `font-display: block`. The `@font-face` ascent / descent overrides (`81.25%` / `18.75%` for Bold 12, Plain 12 and Plain 11; `87.5%` / `12.5%` for Quill 8 and Small) give each face a whole-pixel 16px content box at 16px.

### The Native Em Rule (16 / 32)

**Pixel-font text is set at 16px, or an integer multiple: 32px for display and 48px for terminal headings.** At 16px one font unit (or one 64-unit cell, for Small) maps to exactly one CSS pixel. Every other size scales the outline by a fraction, so glyph edges land mid-pixel and antialias into mush. The effect is worst on composited surfaces (translucent fills, `backdrop-filter`, transform animations), where Blink forces grayscale AA. The bilevel `gasp` hint is only honored on the native em. Verify a surface with the [two-browser LCD-text differential](docs/agent-reference.md#lcd-text) (`node scripts/verify-subpixel.mts`).

- **Take size steps from the face, not from `font-size`.** Need smaller text? Use Plain 11 or Small at 16px. Need more emphasis? Use Bold 12, color and spacing.
- **Keep line boxes on whole pixels**: 16px or 20px for the 12-series and Plain 11, 14px for Small. `line-height: 1.2` on 16px resolves to 19.2px and puts every baseline back on a half pixel.
- **Native size is mandatory wherever text is read under pressure**: in-fight overlays, infobox tiles, countdowns, Practice and its Stats, tooltips, settings copy.

### Sanctioned exceptions

1. **Scaled chrome.** The chatbox, game panel, orbs and status bars draw at 16px multiplied by the game frame's scale, so they follow the client's metrics as the frame resizes. Zoomed Scim chrome (the launcher row, its panes and the replay bar under `chromeZoomStyle`) is still authored at 16px. A fractional scale is accepted in both cases: the text is designed at the native em, and the scale belongs to the whole surface, which has to track the frame or the viewport. Canvas-drawn text rounds size, position and shadow offset to whole device pixels.
2. **The off-grid chrome scale** (front-matter `chrome-*`: 20 / 15 / 14 / 13 / 12 / 11px). It is used by shared primitives (`OsrsButton` labels at 14px, the Settings panel title at 20px, `CollapsibleSection` titles at 15px, `StatusBadge` at 11px) and by these surfaces: the encounter, variant, loadout and tutorial pickers, the tutorial overlay, the Plugins panel and the Cache Explorer. Its off-grid steps cost legibility. Accept them only for text that is glanced at, never for text that is read. Do not use the scale on new text, and move a surface to the native em when you rework it. Do not add sizes below 11px; 10, 9 and 8px appear only in a few badges and developer readouts.

### Pixel-font rules

- **No `text-shadow` on text under 14px.** At the chrome scale's small steps a shadow turns crisp glyphs into smears. Scim-owned pixel text over busy art uses the hard 1px shadow at 14px and above. Client-faithful surfaces use their client shadows at the frame-scaled native size.
- **Control labels and hints are both 16px and step by face.** Labels (`.osrs-checkbox__label`, `.settings-field-label`, `.settings-inline-label`, `.plugin-setting-label`, `.ti-label`) are Bold 12 on a 16px line; a heading over them (`.plugin-name`) is never smaller than 16px. Hints (`.settings-hint`, `.viewport-popout__hint`, the legal footer) are Plain 11 on an 18px line in `text-muted`, 4px below the control. Do not shrink a label to an off-grid 14px: it then draws no larger than its hint, softer, and the hint takes over the row.
- **Crest text** (EncounterTitleCard, DeathModal, VictoryModal, tutorial step intro) is set only at 16 / 32 / 48px with integer tracking and solid hard-offset `--crest-shadow-*` tokens. The canonical rule lives with the tokens in `src/index.css` and is enforced by `src/__tests__/crest-css.test.ts`.
- **No forced font smoothing.** `:root` deliberately sets no `-webkit-font-smoothing` / `-moz-osx-font-smoothing`. Forcing either would give grayscale AA on macOS and override the fonts' bilevel hint.
- **Letter-spacing belongs on small uppercase labels only** (chrome sub-labels and section titles). Do not track body type.

## Layout

- **Spacing rhythm**: 4 / 6 / 8 / 12 / 16px, with 2px for hairline insets. Vary spacing for rhythm; the same padding everywhere is monotony.
- **Panels** (Scim-owned): 16px outer padding, a 12px / 16px header on `--color-bg-elevated` with a `--color-border` separator, 12px after section headers, 8px between items. Two to four visual zones per panel at most. If a panel feels busy, simplify structure before adding color or containers.
- **The game frame is protected.** In-fight chrome sits along the top edge, in Fixed's margins where there are any, and never over the scene's play area. Click-through overlays (infoboxes, the boss bar) may cross it. The geometry is owned by [Workspace And Top Chrome](docs/architecture/workspace-docking.md).
- **Safe areas**: edge-anchored chrome honors the `--safe-top/right/bottom/left` insets.

## Elevation & Depth

Depth is **quiet**. Most separation comes from borders and surface shifts, not shadows or bevels. `--color-border` carries the hierarchy that other systems push to shadows.

| Token | Value | Use |
|---|---|---|
| `--shadow-sm` | `0 2px 4px rgba(0,0,0,0.4)` | Small floating cards (hover cards), subtle lifts. |
| `--shadow-md` | `0 8px 16px rgba(0,0,0,0.5)` | Floating panels (popovers, dropdowns). |
| `--shadow-lg` | `0 16px 32px rgba(0,0,0,0.6)` | Modals and terminal overlays. |
| `--shadow-glow` | `0 0 10px rgba(207,138,62,0.12)`, the primary at 12% | Subtle glow on the primary commitment surface. |

**The Shadow Sibling Rule.** Never put an outer `box-shadow` on the element that paints a text background; carry it on a text-free sibling or an inset pseudo-element. Every scrolling text box needs its own opaque background. Details and verification: [UI rendering safeguards](./docs/agent-reference.md#ui-rendering-safeguards).

**The Opacity Rule (binding).** A Scim-owned surface is translucent if and only if it is click-through. Glass (a translucent fill, `--hud-bg`, or a backdrop blur) is only for overlays the player looks and clicks through, whose content layer is `pointer-events: none`: the infoboxes and the plugin overlays (XP drops, the DPS overlay, the prayer flick helper, the Zuk set timer, the boss health bar, the hint bar). Everything that takes a click or a tap is opaque, on `--color-bg-solid` or another opaque token: the launcher row and its Practice, Actions and Menu panes, Plugins, the replay bar, the sidebars, dialogs and sheets, hover cards, toasts, tutorial cards, and the Mobile tool window. An opaque control also keeps its text's LCD antialiasing. The one exception is client-faithful: the transparent chatbox reproduces the client's own setting, in either click mode. (The FPS readout's small backing is opaque yet click-through: a readout rather than a surface, kept opaque so it stays legible over the game's art and keeps LCD text.) `src/__tests__/surfaceOpacity.test.ts` enforces the rule: a new glass surface is listed there with the component that renders it click-through; a new interactive surface is listed with the rule that paints its opaque fill.

**Reduced motion.** Honor `prefers-reduced-motion: reduce` in any new motion. Collapse to plain opacity, skip transforms, and keep all content visible.

## Shapes

Corners are nearly square: 2px (`--modal-radius` for modals) on controls, cards and modals; 0 on panel chrome. Round shapes are reserved for things that are round in the game (orbs, toggle knobs). Inside chrome zoomed with `chromeZoomStyle` (`src/components/chromeZoom.ts`), borders and radii use `--unscaled-px` so they keep their 1x weight. Padding next to such a border adds back `--border-give`, which keeps the zoomed glyphs on the device-pixel grid.

## Components

All shared primitives live in `src/components/ui/` and are themed entirely through semantic tokens. Reuse them before inventing a new visual language.

### Top Chrome: Launchers, Practice And Actions

The in-fight chrome is a row along the top, not a stack in the scene. The contract, geometry ownership and verification scenarios are in [Workspace Docking](docs/architecture/workspace-docking.md); the geometry is `src/layout/topChromeLayout.ts`. Read both before changing them.

- **One row, one anchor.** Menu · Practice · Actions · Modifiers · Replay sit at the top left as 28px stone buttons. Items drop off the end, never reorder.
- **Labels or icons follow the viewport alone.** The row is all labeled or all icons, Menu included. Overlays never choose its form.
- **One inset.** The row, panes and boss bar's default share `HUD_TOOL_GAP`, 4px scaled with the chrome, from the window's edges or Fixed's inner stone border.
- **Boss bar default.** It places itself around the row and fixed chrome, never the reverse, with a compact form when space is tight. A bar the player placed keeps its place and full form.
- **Menu pane.** Settings is the first row, plain text, ruled off from the places to go. It toggles the Settings drawer and closes the menu. Training carries a muted "Start here" note until the player has opened it.
- **One pane at a time:** Menu, Practice or Actions. The lit launcher is the pane's title and toggle; × and Escape also close Practice and Actions. Scene clicks play and never close Practice or Actions; the menu closes on an outside click or an item. An open pane holds its place through the fight. Click-through overlays never move a pane, except that an active practice session keeps clear of the boss bar.
- **Title row.** Every pane opened from an icon launcher names itself in a stationary title row ("Menu", "Practice", or "Actions") with one close. Labeled launchers need no duplicate title, wherever the pane is placed. This is decided on opening, so an open pane never gains or loses its title when the row changes form. When a practice session is active, its controls come first and the pane title follows, naming the content below. Practice's Setup / Stats sit beneath the title, and the body below is the one scroller.
- **Practice** uses Setup and Stats tabs on desktop. Immediate controls lead; a quiet Options disclosure groups mechanics and aids beneath a dividing rule. The restart action is visually separated from the scrolling controls. Labels and choices wrap at narrow widths; type never shrinks. Mobile Practice is the setup alone, in the Mobile tool window, with no Stats and no second tab strip.
- **Actions and playback.** Actions shares the menu's quiet rows, faint separators, whole-row press fill and wrapping labels. It stays open for repeated commands. During replay, Practice shows playback Stats; Setup and Actions are disabled and say why on hover. The live state returns on exit.
- **Plugins** stays a labeled stone button in the top-right in every layout. Its click-through FPS readout has a small opaque backing that never jitters as digits change.
- **Replay transport** sits at the bottom of the window, opaque, and draws over the chat and Chatbox infoboxes. The chat never pushes it, and only the bar takes clicks, so the chat beside it keeps working. It goes compact when narrow.
- **Replay chapters.** A recording whose encounter names stretches of it (an Inferno run's waves) gains a readout before the tick, a chevron either side of it, and a picker above the bar. The seek rail is cut into segments at the chapter boundaries, thinned to the finest pitch that still reads as a scale, and the landmark chapters get a thin mark beneath the rail, in the lane the late-tick pips above it never share. The picker is a grid of chapter numbers over the bar's own surface: landmarks read brighter, a chapter the recording never finished is drawn open rather than filled, the current one takes the selected treatment, and one line below the grid names whichever the pointer is on. A replay with no chapters draws none of it.
- **Icons and hover cards.** Monochrome pixel glyphs use the label color and shadow, recolored like text in every state. Icon names, disabled reasons and notices use the app's hover card, never the browser's title tooltip. Touch shows no hover card.
- **Surfaces** are opaque `--color-bg-solid` with a `--color-border` hairline and no outer shadow, so their text keeps LCD antialiasing. Type is native 16px: Bold 12 for buttons, values and headings, Plain 11 for secondary labels.

### Mobile Tool Window

Mobile tools belong to the app, not the native stone interface. The compact panel has an opaque base, a quiet hairline edge and nearly square corners. A flat labeled Tools toggle replaces the stone dock, with the same restrained selected treatment as the tabs. Placement and sharing with game panels belong to [Workspace Docking](docs/architecture/workspace-docking.md#mobile-tools).

- **Three tabs** form a raised footer with quiet seams. The footer and adjacent Tools button share a clean top and bottom baseline, reading as one aligned row beside the stone column. Labels use the native body face without a shadow, rather than a smaller hint face; constrained slots use the launcher glyph family instead of clipping or shrinking the labels. The selected tab shares the content surface and carries a fine accent along its bottom edge; its color survives hover. There is no attached fourth control to break the panel's rectangular outline.
- **Practice is one control group**, with a two-line header: a leading back chevron and Practice link above the current group name. The overview has a plain Practice title and destination rows with trailing chevrons, matching Browse's navigation language rather than a dropdown. Single-choice groups place help in a distinct cell beside that heading. Choices form consistent text rows with radio markers, quiet borders and a warm selected fill, not illustrated chips that wrap into an orphan row. Labels wrap rather than shrink. Phase rows align their names and HP values; repeatable actions use quiet left-aligned rows. Session restart remains primary, with Change and Clear secondary. Health's restart shortcut, where present, is visually separated below its controls. Health and Replay share slender rails and clearly visible rectangular thumbs.
- **Menu has three clear icon-and-label controls**, using the launcher glyph family and quiet framed surfaces. Settings, Plugins and Browse fill the main page as one balanced group, not isolated text over an empty body. Browse uses brighter left-aligned rows, fine separators and trailing chevrons, below a raised Back row.
- **Replay uses the same material**, with a labeled tick field, clearly weighted transport glyphs and an enclosed More affordance. Secondary actions form a left-aligned list with body-color titles and readable supporting text. There is no nested floating bar or ornamental frame.
- **Scrolling content paints its own opaque background.** A slim token-colored native scrollbar signals overflow. No outer shadow, blur or transform animation is used on these text surfaces; controls respond immediately rather than adding decorative movement.
- **Unusable slots show a quiet notice**, not cut-off controls. The compact notice uses the same opaque material and native hint face; unavailable footer glyphs use muted ink without fading the whole surface.

### Encounter Setup Rail

An Operate surface in the encounter card. The identity header pairs a portrait with a display title, the phase or wave that title needs to be unambiguous, and any status chip, all on one line; the portrait has no frame and dissolves into the raised header rather than sitting in a well. Compact preset rows use one item sprite, the full name and a selected checkmark. Preparation, mechanics and practice aids use the shared control-label treatment, with whitespace and hairlines rather than nested cards.

Contract choices are plain rows until one is chosen: the selected contract takes the accent edge and accent ink, because it is the card's most consequential commitment and a structural edge alone would leave six rows reading as static text. Selected modifier tiers take the same accent; a tier left Off takes a quiet fill instead, so a grid of untouched modifiers never outweighs the one that was set. Control labels and their choices are set at the native em, not the off-grid chrome scale.

The desktop composition pairs a dark kit area with a warm fight-setup area across one dividing rule, each column named. Equipment and supplies sit directly on the kit surface rather than inside another framed panel; individual slots retain their inset wells. Switch groups wrap to the width they are given. Phone setup presents a compact loadout summary above the fight controls. All scrolling surfaces are opaque; header and action footer use the raised surface. The footer confirms the run in the terms it was configured in, never by repeating the title. Geometry and state ownership are specified in [Encounter configurer](docs/architecture/encounter-configurer.md).

Inferno's Edit layout summary is a chevron disclosure row with a muted, single-line state. It shares the Wave shortcuts disclosure treatment and aligns its editor with the column's leading edge. Its map uses a very faint, smoothly sampled terrain underlay and an equally quiet tile grid, quiet dashed empty spots, named monster tiles in their role colors, plain near-black square pillars, and a labeled true-tile player outline. Small monster footprints retain a faint dashed spot boundary behind them. Standing pillars have a restrained edge and centered light labels; down pillars are unfilled dotted squares with muted labels, distinct from spawn spots. Labels retain opaque text backings. No separate compass or legend competes with the map.

The Fortis Colosseum's Edit layout uses the same map on its waves floor, drawn as quiet warm tiles with the same grid ink and no terrain image; its pillars are plain unlabeled squares. A spawn the game could not produce takes a warning-colored ring outside its tile, and a plain warning box with a warning-ink title sits under the map, on the raised surface with a warning-tinted hairline rather than a warning fill.

Monster progress uses compact, content-sized chips with matching role-color swatches in chips and pickers, and placed/total text. An armed chip takes its monster color on the edge and a quiet tinted fill; completed kinds retain the same box with muted ink and swatches, without fading the text layer. Instructions sit above the map in native hint type on an opaque backing. Spot pickers have a quiet contextual heading. Clear spawns and Reset start use muted disabled ink when unavailable; sharing remains visually secondary to the filled primary action.

Selected modifiers read as compact two-column identities: the modifier artwork leads each full name, with its Roman-numeral tier close beside it in accent ink. Names stay in label ink on an opaque setup surface, without individual frames or repeated form controls. A single framed action sits beside the section heading. Detailed modifier editing retains its wider rows and tier controls.

The selected contract is a full-width warm choice row, with its name prominent and Change at the trailing edge. Its catalog uses the framed choices when revealed; canonical terms remain plain text beneath it. Short-landscape item pickers separate held-item context from search and results across two columns, using the same opaque material and restrained controls as the portrait picker.

### Modal family

Ordinary dialogs are compact framed windows with native title-size headings, not display banners. Boss identities retain the display face. Dark navigation areas contrast with warm reading areas; raised headers establish the frame without overpowering the task. Training uses a narrow course column beside curriculum and lesson content. Its selected rows use restrained structural edges and inset fills, with small framed metadata beside the lesson. Encounter contracts place their actions beside the terms. Rewards remain canvas sprites, not decorative badges.

Reference dialogs share that material but use their own reading composition: Shortcuts pairs compact keycaps with readable descriptions; Credits keeps its centered names and quiet license link. Dialog geometry, scrolling and selection flows live in [Modal family](docs/architecture/modal-family.md).

### Settings in the game panel (Keybindings, Audio)

These Scim-owned tabs sit on the game panel's stone texture. Keep the editor, navigation and scroll area transparent so the texture shows; do not add an opaque fill to chase subpixel AA. Legibility comes from native 16px labels, whole-pixel line heights, contrast and a restrained tinted pixel shadow. Key fields may use a light translucent tint, never a replacement panel background. Audio uses plain text tabs with a restrained selected underline, slim token-colored slider rails and neutral (not accent) percentage readouts. Do not paint an opaque background on the label-bearing navigation track; keep its fill on a text-free sibling.

Key bindings save immediately. Ordinary conflicts unbind automatically and are reported in a quiet, native-size "Unbound" footer note, with no warning triangle, tinted box or border. Recording never changes row geometry. Feature-specific editors (such as Zuk's Set Timer shortcuts) reuse `KeybindingsContent`, using its `compact` variant when shown inline. Behavior details live in `src/components/GamePanel/KeybindingsContent.tsx`.

### `OsrsButton`

`src/components/ui/OsrsButton.tsx`

- **default / secondary**: the workhorse. Dark surface, secondary ink and a quiet border. Hover raises the fill and edge; press returns to the inset surface.
- **primary**: dark warm fill, heading ink and a restrained brass edge, lighter along the top. Hover lightens the dark fill, never turning it into a solid gold block. Press darkens the well; disabled states use muted ink rather than fading the whole control.
- **ghost**: secondary ink without a resting frame. Hover reveals the quiet surface and border.
- **danger**: `error` text with an error-tinted border at rest, so it reads as destructive before it is read.

Primary, secondary and ghost labels use the native title face. Primary ink has no shadow; secondary labels keep the pixel shadow. These recipes belong to the shared button primitive, not to client-native stone buttons or segmented choices.

### `OsrsCheckbox` and `OsrsToggle`

Match form to meaning. `OsrsCheckbox` (16px box, always paired with an inline label in Bold 12 at 16px on a 16px line) is for **retained preferences** the user revisits. `OsrsToggle` is for **immediate on / off behavior** with a visible consequence now. Do not swap one for the other for visual variety.

`OsrsToggle` uses a **dark accent-tinted track, a quietly blended edge and a pale thumb for on**. The fill mixes a low share of `primary` into `surface-inset`, so the accent shows only as a subdued tint. The edge blends `primary-structure` into that fill; the right-hand thumb uses `heading`. Off is an inset well with a smaller, muted left-hand thumb. The filled body, thumb size and position distinguish on without making each enabled plugin a color statement.

Hover gently lifts the same tinted fill and blended edge while keeping the pale thumb steady. The small variant retains the same treatment; touch enlarges the target rather than the artwork. Colors derive entirely from the palette tokens, with no colors of the switch's own. Do not replace this with a saturated accent fill, a bright perimeter, an internal lit rail, or an accent outline alone.

### `OsrsNumberInput`

Numeric field with a stepper on `surface-inset`. Like every text input, it is pinned to a minimum 16px computed font size on coarse pointers (the global rule in `src/index.css`), so focusing it does not zoom iOS Safari.

### `ResetButton`

`src/components/ui/ResetButton.tsx` is the shared defaults-reset affordance: a 20px square with an SVG counter-clockwise arrow, quiet at rest. Modified settings show it without hover; unmodified `SettingRow` resets stay hidden but reserve their gutter (`--setting-reset-size`, `--setting-reset-gap`). Simulation restarts and other destructive actions do not use it.

Reset to defaults (`src/components/ResetToDefaults.tsx`) is its labeled form for a whole group of options: the same glyph before a body-face label, ghost at rest, with no frame or fill until hover. It sits quieter than the heading or controls it serves. Once pressed, a muted "Defaults restored" and an underlined text Undo take its place in the action's own face, without changing the row's height. That Undo is the app's one text-action recipe, with the WikiLink's 1px rule. It takes the face of the line it sits in, so the Inferno link notice reuses it inside its sentence.

### `HoverCard` and `StatusBadge`

Hover cards (`role="tooltip"`) use `surface` with a 1px border, Plain 11 at 16px on 16px lines, and a measure balanced for short hints. `StatusBadge` marks metadata such as "Beta": muted text on a faint wash, deliberately not the accent or warning color.

### `CollapsibleSection`

Use it **only** when collapsing genuinely improves scanability or reduces repetition. Do not collapse core information because other panels do.

### Victory overlay

`src/components/VictoryModal.tsx` is the one terminal screen shared by every boss. It is driven by encounter descriptor data, so new bosses supply metadata, not components. It shows a fixed five-row fight record. The accent tints only the heading and emblem, using the palette tokens. The overlay is not dismissible: it clears when the outcome changes.

### Status bars (client-faithful)

`src/components/GamePanel/StatusBars.tsx` reproduces RuneLite's `statusbars` plugin. It uses RuneLite's literal RGBA fills, pinned by `statusBarsPaint.test.ts`, and current-value counters in 16px RuneScape Small with the client's 1px `#000` shadow. It is an overlay on the panel, never a column that makes the panel reflow, and it is decorative to assistive technology.

## Do's and Don'ts

### Do

- **Do decide the layer first.** Client-faithful surfaces copy the client; Scim-owned surfaces use app tokens.
- **Do reuse** `OsrsButton`, `OsrsCheckbox`, `OsrsToggle`, `OsrsNumberInput`, `ResetButton`, `HoverCard` and `CollapsibleSection` when the interaction matches their meaning.
- **Do reference semantic tokens** (`var(--color-primary)`) on Scim-owned surfaces. Add a genuinely new role to `src/index.css` `:root`, and to `THEME.colors` in `src/theme.ts` when canvas or WebGL code paints it.
- **Do set pixel-font text at 16px** (or 32 / 48px) and take smaller steps from Plain 11 or Small.
- **Do honor the type hierarchy**: the panel title is the strongest element; section titles read as structure; sub-labels and captions support scanning and never compete.
- **Do reduce emphasis before adding color**: if a panel reads loud, remove an accent, soften a border, drop a divider.
- **Do keep `--color-primary` rare.** It is a commitment signal.
- **Do test active states under hover.**

### Don't

- **Don't use `#000` or `#fff` on Scim-owned surfaces**, apart from the hard 1px pixel text shadow. App neutrals are tinted towards the palette's warm brown. Client-faithful surfaces keep the client's literal colors.
- **Don't retint client-faithful colors** or move them onto app tokens.
- **Don't add new text on the off-grid chrome scale**, or use any off-grid size for text that is read under pressure.
- **Don't put `text-shadow` on text under 14px.**
- **Don't use `border-left` / `border-right` as a colored accent stripe.** Use full borders, background tints, leading icons, or nothing.
- **Don't use gradient text** (`background-clip: text` with a gradient).
- **Don't use glassmorphism as a default.** Backdrop blur is a rare, purposeful effect, and only on a click-through overlay (the Opacity Rule).
- **Don't build identical card grids** that repeat the same icon, heading and text pattern, and never nest cards.
- **Don't use bevel-heavy controls, inset chrome or exaggerated pressed states.**
- **Don't reach for a modal first.** Exhaust inline and progressive alternatives.
- **Don't use em-dashes in UX copy or design docs.** Use commas, colons, semicolons, periods or parentheses.
- **Don't hard-code mechanics or theme assumptions in shared components.** Read the palette through CSS variables or `THEME.colors`.

### Quality gate (before shipping a panel redesign)

1. Does this panel feel like the same product family without copying another panel's exact layout?
2. Is the default state mostly calm, with `--color-primary` used rarely and intentionally?
3. Does the hierarchy still read clearly if you ignore color and look only at spacing and type?
4. Are hover states quieter than active states?
5. Does every divider, section and container clarify information, or merely decorate?
6. If one element became less emphasized, would the panel likely improve? If yes, reduce emphasis.
