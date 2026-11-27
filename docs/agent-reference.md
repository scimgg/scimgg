# Agent Reference

Task-specific guidance supporting [`AGENTS.md`](../AGENTS.md). Read the sections relevant to the work.

## Coordinates and Rendering

An encounter's opening camera is its presentation row's matching `setupCameras` entry or `defaultCamera` in [`presentationModules.ts`](../src/encounters/presentationModules.ts); without a row or camera it is the fallback, yaw 180, looking from north towards south.

An NPC's position is the southwest tile of its square footprint, not its center (OSRS convention, used by movement collision and projectile aim). Start positions, landing areas, and fallback arena bounds are owned by each encounter under `src/encounters/<encounter>/` (usually `constants.ts`); runtime cache analysis supplies real arena bounds where available. Example (Yama P3): `YAMA_START_POS = [29, 28]` is the southwest corner of the 5×5 footprint, and the player lands facing south on a random tile from `randomLandingPosition()` — production never uses a fixed start.

The standard `SCALE = 1/128` matrix converts OSRS model space, where X is east-west, Y is height with negative up, and Z is north-south, into world space. Canonical implementations are [`SceneCompositor.ts`](../src/render/scene/SceneCompositor.ts), [`NpcInstanceManager.ts`](../src/render/npc/NpcInstanceManager.ts), [`LocRenderer.ts`](../src/render/environment/LocRenderer.ts), and [`SpotAnimRenderer.ts`](../src/render/effects/SpotAnimRenderer.ts). For OSRS angle `A`, let `theta = (A / 2048) * 2pi`:

```
col0 = [ S*cos theta, -S*sin theta, 0, 0 ]
col1 = [ 0,            0,           -S, 0 ]
col2 = [ S*sin theta,  S*cos theta,  0, 0 ]
col3 = [ tx, ty, tz, 1 ]
```

Player movement and facing cross two layers. [`SimulationEngine.ts`](../src/core/SimulationEngine.ts) owns tick-based `player.facing`; [`PlayerVisualTracker`](../src/render/core/interpolation.ts) owns per-frame target and displayed angles. The rendered model uses `facingAngle`. Reproduce facing, lag, or jitter bugs with a standalone `tsx` driver through the `RenderViewport3D` tick-to-frame wiring, then add the regression to [`PlayerVisualTracker.test.ts`](../src/render/core/__tests__/PlayerVisualTracker.test.ts). Do not use Playwright. See [`movement-and-facing.md`](./architecture/movement-and-facing.md).

For encounter-owned animated LOCs, read [`scene-objects.md`](./architecture/scene-objects.md) and use `SceneObjectController`. Do not call `LocRenderer` internals from encounter code.

WebGL debug tooling lives in `src/debug/index.ts`. Enable it with `?debug=1` or `localStorage.yamaDebug = '1'`. This turns on `webgl-lint`, the FPS overlay, and Tweakpane. Keep it opt-in. Use runtime probes or Spector.js frame captures when source inspection and tests cannot explain a visible rendering issue.

Optional diagnostics: `node scripts/check-scene-colors.mts` (Node 22.18+, not `tsx`; needs Playwright Chromium, installed with `npx playwright install chromium`) checks scene shader brightness, and `npx tsx scripts/audit-skeletal-spotanims.mts` lists which spotanims use the per-frame skeletal posing path rather than baked frames.

## Capture Fixtures

The captures cited throughout the code and docs (by file name, often with a line or tick number) are private gameplay captures. Tests cite the source capture beside the extracted expectations or in a fixture header.

When reading those facts, or weighing any new evidence against them:

- Identify the encounter attempt, phase, and exact effect IDs before measuring behavior. Similar effect names can describe different mechanics.
- Check tick continuity and capture completeness. Distinguish scene-load re-emissions from genuine repeated effects; never deduplicate batches solely because their contents match.
- Measure timing relative to a verified phase/control boundary and establish the coordinate offset before comparing capture tiles with simulation tiles.
- Separate observations from derived rules and uncertainty. Check the model against all relevant captures, including variant differences (e.g. Yama contracts); explain disagreements rather than choosing convenient evidence.
- Use focused extracts and deterministic simulation tests to verify the proposed timing and geometry.

## Planning and Workflow

Core contracts include the SimulationEngine tick or queue model, renderer pipeline, replay format, encounter/runtime API, and persistence shape. Before changing one, identify affected consumers, compatibility requirements, and regression coverage.

Run `npm run dev` (or the optional `./dev` shortcut) for visual development; Vite prints the URL (port 5173 unless it is taken). `./dev harness '<query>'` starts the same server and opens [`/ui-harness.html`](./testing/ui-harness.md) with that query. The dev server listens on loopback only; `SCIM_DEV_LAN=1 npm run dev` also binds the LAN interfaces for testing on a phone on a trusted network.

New settings need a settings-search entry: `SettingRow`, `CollapsibleSection` and `SettingLinkRow` require a `searchId` (`null` only with a comment saying why), and the row's entry and keywords go in [`entries.ts`](../src/settingsSearch/entries.ts); the anchor-coverage tests in `SettingsSidebar.test.tsx` and `PluginsPanel.test.tsx` fail until both sides match. Encounters are indexed from the registry automatically.

Keep searches scoped and respect `.ignore`, which excludes dependencies, build output, cache data, and generated assets. Guard probes that can hang (dead ports, browser processes) with a short timeout.

## Testing and Workflow Details

Escalation path:

1. `npx vitest run <path>` for the module or test you changed.
2. `npm run test:unit` for a pure-logic domain-wide change, or `npm run test:integration` for changes reaching the real SimulationEngine and cache.
3. `npm test` before merging, or earlier when the change warrants it. Component, hook, and render suites are not all covered by the two domain commands.

The default Vitest environment is `node`. DOM tests opt in with `// @vitest-environment happy-dom`; a file uses `jsdom` only with an inline comment explaining why happy-dom fails. Avoid `await import()` inside tests or hooks; it puts a module graph behind the test timeout.

To measure runtime performance in a dev build, use the console tools installed by `src/main.tsx`: `window.__renderProfile` ([`renderProfiler.tsx`](../src/debug/renderProfiler.tsx)) attributes React render time to the viewport and game panel, and `window.__inputLatency` ([`inputLatencyProfiler.ts`](../src/debug/inputLatencyProfiler.ts)) reports slow input events, frame pacing, and long animation frames with their costliest scripts. Call `start()`, play the same stretch of a fight, then `stop()`; compare branches by alternating runs in one browser session.

The worker cap stays at 8 in [`vite.config.ts`](../vite.config.ts): many machines have few cores and suite cost is mostly per-file setup. Do not raise the cap, delete cases, or set `isolate: false`. Compare CPU time against an interleaved same-session baseline, not wall time.

Vitest runs files in parallel and `npm test -- --shard=i/N` splits them by file, so a test file must not depend on another file running in the same process.

Documentation-only changes need link and content checks, not a build or test run.

For UI-only browser work, `/ui-harness.html` boots the real `App` without cache downloads or WebGL (e.g. `?encounter=yama_p3&tab=prayer&ticks=5&chrome=0`, or `./dev harness 'encounter=yama_p3&tab=prayer&ticks=5&chrome=0'` to start the dev server on it); see [`ui-harness.md`](./testing/ui-harness.md). It does not cover the scene, models, item names, tooltips, or context menus.

## UI Rendering Safeguards

### LCD text

Chrome's LCD text is a compositor choice and cannot be forced with CSS. Avoid its vetoes:

- A surface painting the background behind text must not carry an outer `box-shadow`. For a clipped surface such as a sidebar, put the shadow on a text-free sibling that mirrors its geometry and movement. A pseudo-element inside the clipped layer does not work. For a surface that can use `overflow: visible`, an inset `::before` can carry the shadow.
- Every `overflow-y: auto` text container needs its own opaque background. An ancestor's fill does not make the scrolling layer opaque.
- Avoid `scrollbar-gutter: stable` on a scroller holding text. Blink then paints the scroller's fill outside its scrolling contents and leaves it uncomposited, and once an SVG, input or other separately clipped element scrolls out above its top, every label below it can go grayscale. Where the reserved width must not change as content grows, use `overflow-y: scroll` with `scrollbar-gutter: auto` and give the idle track the scroller's fill (`::-webkit-scrollbar-track:disabled`), scoped with `@supports selector(::-webkit-scrollbar)`, as `.encounter-panel-rail` does. Paint containment on the clipped elements and `background-attachment: local` each fix only some cases.
- Avoid `will-change: transform`, filters, backdrop filters, opacity below 1, blend modes, running transform animations, and translucent fills behind text. Preserve the sidebars' `.open { will-change: auto }` rule.

Translucent fills are only for click-through overlays (DESIGN.md, the Opacity Rule): the infoboxes and the plugin overlays, whose text gives up LCD AA and carries the pixel text shadow instead. Everything that takes a click is opaque, including the replay bar and the Mobile tool window. The one exception is the transparent chatbox (`Chatbox`, resizable layouts only, on by default), which reproduces the client's own setting. `src/__tests__/surfaceOpacity.test.ts` enforces the rule.

After changing these surfaces, verify each one with a two-browser differential: capture the surface in a normal Chromium and in one launched with `--disable-lcd-text`, then compare. Text that is identical in both has already fallen back to grayscale. The verifier does this:

```bash
node scripts/verify-subpixel.mts --url <URL> [--preset <name>] [--selector <css>]
```

It needs the fonts from `npm run setup` and a running dev server. Its thresholds are tuned on Chromium and are not machine-independent. See the [LCD text guide](../.agents/skills/subpixel-aa/SKILL.md).

Do not infer LCD text from a screenshot or color fringes. Runtime probes must assign a resolved opaque color; `el.style.background = 'var(--token)'` can silently fail.

Text can also alternate between sharp and soft as its origin crosses fractional device pixels while LCD remains enabled. Ordinary centered modal cards use [`useCenteredModalSnap`](../src/components/ui/useCenteredModalSnap.ts) with `.centered-modal-snap` to align their resting origin without transforms; reuse this owner rather than adding per-modal offsets. Its contract and exclusions are in [Centered placement ownership](architecture/modal-family.md#centered-placement-ownership). Do not apply it to anchored popovers, drawers or draggable panels, or use it as a substitute for the opacity rules above.

### Cross-browser CSS

[`cross-browser-css.test.ts`](../src/__tests__/cross-browser-css.test.ts) locks these rules:

- Never style `::-webkit-textfield-decoration-container`; in WebKit it can contain the input's inner editor. Style individual `::-webkit-*-auto-fill-button` pseudo-elements instead.
- Pair every `appearance` declaration with `-webkit-appearance`.
- Do not put `::-webkit-scrollbar` rules and ungated `scrollbar-width` or `scrollbar-color` on the same element. Gate standard properties with `@supports not selector(::-webkit-scrollbar)`. Standard-only styling remains allowed where intentional.
- Pair each `vh` height with a `dvh` fallback.
- Pin `line-height` on chrome whose geometry must match across engines. For single-line text inputs, use at least the font's normal floor, `1.2` for the current fonts.

### Keyboard and focus policy

Scim.GG supports two inputs: mouse plus keyboard, where keys are game hotkeys (movement, camera, prayers, replay transport) and typing, and touch on mobile. A mouse is needed to play, so the app is not usable from the keyboard alone, and keyboard navigation of its chrome is a non-goal. It does not help either supported input. It also costs the player: a focused control takes game keys (Space re-activates it, arrows stop reaching the camera) and lights a ring mid-fight. Design pointer and touch targets instead.

Existing mechanisms:

- `useAppHotkeys` swallows Tab on `window` and blurs the focused element, so Tab never walks the app. A `keydown` handler that stops Tab's propagation opts its subtree back into Tab, so do not add one outside the exceptions below.
- `index.css` removes every outline (`*:focus { outline: none !important }`); there is no ring opt-in. [`cross-browser-css.test.ts`](../src/__tests__/cross-browser-css.test.ts) allows `:focus-visible` and `:focus-within` styling only in the loadout editor and on text fields, and requires any remaining ring there to be gated on `:root[data-focus-source="keyboard"]`. `installInputModality` (`src/util/inputModality.ts`) sets that attribute: `pointer` on any press, `keyboard` on Tab.
- A control that must not keep focus after a click cancels mousedown's default, which leaves the click and touch input working: `onMouseDown={(event) => event.preventDefault()}` on one button (`preventFocusOnClick` in `MobileToolWindow.tsx`, the minimap compass, the chatbox's All and Collapse buttons), or a container handler that does it for every button inside (the top chrome in `launcher/TopChrome.tsx`, the Mobile menu nav in `App.tsx`, `ReplayControls`, `KeybindingsContent`).
- `useEscapeLayer` gives Escape to the topmost open layer.

Allowed: Escape closing an overlay, menu or popover. Normal typing, and Enter to commit, in text fields (search, names, colors, numbers, keybinding capture); text fields keep their focus border. A surface whose purpose is typing may put the caret in its field when it opens, and the keybinding field holds focus while it records. Hotkeys that drive the game or replay (Space, arrows, Home and End in `ReplayControls`) are not navigation. ARIA roles and states such as `aria-expanded` and `aria-controls` are fine because they are not visual.

Not allowed on launchers, menus, popovers, tabs, segmented choices, panels or dialogs: Tab stops or Tab cycling (including focus traps), roving `tabIndex`, arrow or Home/End stepping, Enter/Space handlers that make non-buttons keyboard-operable, `focus()` that moves into a surface on open or back to its opener on close, `event.detail === 0` keyboard-activation branches, and `:focus-visible`, `:focus-within` or ring styling, gated or not. Focus traps do not keep keys from the game; to hold keys back while an overlay is open, stop them explicitly or gate the hotkey on the overlay's state. Where biome's a11y lint asks for focusability on a pointer-only control, suppress it with a reason that cites this policy.

Exceptions, which keep their keyboard handling and keyboard-gated focus styling:

- The loadout editor: the equipment slot picker (`SlotPickerPopover`: search field takes the caret, arrows and Enter choose, Tab stays inside, Escape dismisses), arrow keys across the equipment and inventory slot grid (`loadoutGridNavigation.ts`, `EquipmentSettings`, `EncounterLoadoutSection`), the rune pouch tray (`RunePouchRow`) and the preset tiles (`LoadoutPicker`), including their focus moves.
- The Ctrl+K quick search (`QuickSearch`) over encounters, settings, plugins and keybinds: its field takes the caret on open, Up, Down and Enter choose a result, and keys typed into it stay in it. The encounter picker's own search field (`EncounterPicker`) keeps the same handling: it takes the caret on open, and Up, Down and Enter choose a contract.

Do not copy these to other surfaces.

### Pixel-art icons

Pixel-art item and prayer icons need canvas resampling at fractional panel scale and device pixel ratio. Never replace them with bare `<img>` or `PackImage`; `PackImage` is for chrome. Any remaining `<img>` that paints a preloaded URL needs `crossOrigin="anonymous"` so it uses the warmed copy described in [`imageCache.ts`](../src/util/imageCache.ts).

A grid that mounts during game-panel tab switching uses one [`PixelSpriteLayer`](../src/components/PixelSpriteLayer.tsx), with transparent DOM hit targets. Do not use one canvas per slot. Grids opened only by an explicit replacement view, such as Quick Prayer Setup or the Autocast Spell Picker, may use per-slot `PixelSprite` because they do not mount during routine tab switches. A lone sprite also uses [`PixelSprite`](../src/components/PixelSprite.tsx), including filtered sprites and moving drag ghosts.

Screenshots cannot establish sharpness. Verify that each `canvas[data-src]` backing store matches its CSS box times `devicePixelRatio`; inspect a layer's development `data-sprites` attribute for placement.

## Source Policy

For quick source lookups, use:

- [RuneLite](https://github.com/runelite/runelite) (BSD-2-Clause), cited by project, path and commit, e.g. RuneLite `runelite-api/.../Perspective.java:58-59` at `ced4c4aba7a3cb7cace42e1f0c25a5f79b7faef2`. This is the default code reference; useful areas include `runelite-api/`, `runelite-client/`, and `cache/`.
- OSRS Wiki article prose, infobox statistics, and `Damage per second/*` formula pages.
- RSMod at `github.com/rsmod/rsmod`, under ISC, and MIT-licensed 2004scape server repositories (not client ports of decompiled clients), after verifying the relevant code's license at the cited revision.
- The committed capture fixtures, which outrank third parties. They hold facts extracted from private gameplay captures, cited by file name.

These are starting points, not a closed project allowlist. Other third-party implementation references are permitted when the relevant code at the cited revision has a verified permissive license, such as MIT, ISC, BSD-2-Clause, BSD-3-Clause, or Apache-2.0. Verify repository and file-specific notices before reading implementation code; public availability or a project's name alone does not establish permission.

For implementation, mechanic research, and bug fixes, never read non-permissively licensed OSRS implementation code, even to check a result without copying it. This excludes copyleft licenses (including GPL, AGPL, LGPL, and MPL), restrictive source-available licenses, and code without a verified license. The exclusion covers calculators and other tools that implement OSRS formulas, not only game servers and clients. The allowance for Wiki article and formula text does not extend to inspecting any calculator's implementation.

Use permitted implementations as corroborating evidence of mechanic behavior, not as default code or architecture templates. Establish the behavior and its evidence, then implement it independently through this project's existing owners and contracts. Do not port another project's abstractions, control flow, or code merely because its license permits it.

Copying or adapting third-party code or implementation structure is a last resort, only when an independent implementation is insufficient. Before doing so, explain the concrete necessity, alternatives, source/revision, scope of reuse, and license/attribution obligations; whether to reuse is a decision for the maintainers. A decision to research or implement a mechanic does not by itself authorize this reuse.

If code is reused, record copied or adapted third-party code in [`vendoredNotices.ts`](../scripts/vendoredNotices.ts) and preserve all required license notices. Cite research sources accurately, but do not label code as vendored or derived solely because a source was consulted or independently written code implements the same documented game mechanic. Conversely, do not rename, paraphrase, or lightly restructure adapted code to avoid required attribution; independence must be genuine.

Do not use decompiled Jagex client implementations.

If permitted material cannot settle a formula, report that limit and keep the behavior measured from captures. Do not fill the gap from an excluded source.
