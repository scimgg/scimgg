# UI test harness

`/ui-harness.html` boots the real `<App/>` with no OSRS cache download and no WebGL, so panels, the launcher row and Practice, orbs, replay bar, sidebars, modals, and overlays can be driven and screenshotted in ~1.5 s. Start `npm run dev` and append `/ui-harness.html?…` to the Local URL Vite prints, or run `./dev harness '<query>'` (e.g. `./dev harness 'tab=prayer&chrome=0'`), which starts the same server and opens that route on whichever port Vite takes. With no browser to open (`BROWSER=none`, or a headless machine), append the route it prints to the Local URL.

Dev-only: Vite builds `index.html` alone, so `ui-harness.html` never reaches `dist/`.

## Seams

Each seam is guarded by a leading `import.meta.env.DEV &&` so production folds it away.

| Seam | Effect |
|---|---|
| `useCacheBootstrap({ devHarness })` | Reports "loaded, empty cache" without `CacheManager`, `ensureCache()`, or asset/audio preloads. |
| `useEncounterManager({ devHarness })` | Skips per-encounter cache round-trips (map locs, arena collision) and any entry intro (`enableIntro`, e.g. Yama's landing). |
| `rendererType: 'none'` | `Grid` mounts no viewport or GL context; `useSimulationWiring` treats it as scene-ready. |
| No `<LoadingScreen>` | Nothing loads. |
| `useRouting(…, enabled: false)` (`DevHarnessBoot.fixedAddress`) | The router neither reads nor rewrites the address, so a reload keeps `/ui-harness.html?…` and its options. `enterEncounter('lobby')` uses App's own lobby entry. |

The entry also seeds the WebGL2 probe (`presetGpuStatus()`).

Consequences:

- The scene area is black by design.
- Cache loaders are `null`: item icons render (sprite CDN), but item names, tooltips, right-click menus, rune-availability shading, and NPC/model data are inert. Use the app or focused tests for those.
- Ticks advance only when stepped; `?autoAdvance=1` restores the real-time loop.
- `localStorage` is namespaced (`ui-harness:`) and cross-window settings broadcasts are suppressed, so runs never touch real settings.

## URL parameters

| Param | Default | Meaning |
|---|---|---|
| `encounter` | `yama_p3` | Any registered encounter kind, or `lobby`. |
| `preset` | `first` | Key in `EQUIPMENT_PRESETS[<presetsKey>]`; `first` = first non-fallback set. |
| `tab` | `inventory` | `combat`, `skills`, `inventory`, `equipment`, `prayer`, `spellbook`, `settings`. |
| `ticks` | `0` | Ticks to advance before ready. |
| `autoAdvance` | `0` | Run the real-time loop. |
| `chrome` | `1` | Harness toolbar; `0` for clean screenshots. |
| `outcome` | none | Named `death` or `victory` terminal fixture, for `encounter=yama_p3` only. Unknown values/other encounters ignore it. |
| `practice` | `0` | With an outcome fixture (`outcome`, or `open` naming `death` or `victory`), establish an actual practice start at tick 10. |
| `open` | none | UI surfaces to open once ready, comma-separated, in order, `name` or `name:arg` (see [Surfaces](#surfaces)). A bad list fails the boot (`data-harness-error`). |
| `modifierFixture` | none | Configurer selection applied at boot: `sol-seven` or `sol-all`. Saved as an ordinary modifier edit, so it stays in the harness's own (namespaced) storage for later harness runs until Reset to defaults. Requires `encounter=lobby` and exactly `open=encounter-panel:sol_heredit`; unknown/incompatible requests fail the boot (`data-harness-error`). |
| `colosseumStartWave` | none | With `encounter=sol_heredit`, a whole wave `1`–`12` saved as the Fortis Colosseum's Start wave before the app mounts, as the setup control saves it. Waves 1–11 open on that wave's modifier choice at tick 0 (`?encounter=sol_heredit&colosseumStartWave=4&chrome=0`); 12 is the direct Sol fight. It stays in harness storage like any saved setting. Anything else is ignored. |
| `renderStatus` | none | Preview the 3D view's status notice: `lost`, `restoring`, `context-restore`, `context-timeout`, `render-loop`, `unsupported`. Not a surface (see below); an unknown value is ignored. |
| `renderStatusHeld` | none | What that notice says the graphics hold has paused: `fight` or `replay`. Anything else is nothing held (lobby, loading, a fight already over). |
| `replayChapters` | none | Preview the replay transport over a chaptered recording: `full` (the whole Inferno, 69 waves, Zuk cleared) or `practice` (waves 35 to 37, dying on 37). Not a surface (see below); an unknown value is ignored. |
| `replayChaptersCompact` | `0` | That preview in the narrow form the app uses below 720px. |
| `replayChaptersMobile` | `0` | That preview on the Mobile Tools window's Replay page. |

### Configurer modifier fixtures

These dev-only density fixtures open the real lobby configurer through App's live Configure callback:

- `/ui-harness.html?encounter=lobby&open=encounter-panel:sol_heredit&modifierFixture=sol-seven&chrome=0`
- `/ui-harness.html?encounter=lobby&open=encounter-panel:sol_heredit&modifierFixture=sol-all&chrome=0`

`sol-seven` matches the overview reference screenshot: Blasphemy III, Doom III, Frailty III, Myopia III, Quartet I, Relentless III and Solarflare III. `sol-all` selects every entry in `SOL_HEREDIT_MODIFIERS` at its highest valid tier (currently ten, including Bees!, Totemic and Volatility). The fixture owner is `src/harness/ui/harnessModifierFixtures.ts`; names, effects and valid tiers come from canonical encounter metadata, not copied UI definitions.

The typed DEV bridge seeds the setup selection after Configure's normal reset. No fixture is written to real or harness storage, and no URL option changes production defaults or mechanics. With no fixture, Configure behaves normally. Closing and reopening normally (including `uiHarness.open('encounter-panel:sol_heredit')`) resets to the encounter's defaults (currently Blasphemy III for Sol); the boot fixture is not reapplied. Other `open` surfaces cannot be combined with this bounded fixture.

The Inferno configurer needs no fixture: `/ui-harness.html?encounter=lobby&open=encounter-panel:inferno&chrome=0` opens it on the saved setup, which is wave 69 in fresh harness storage. Expand Wave shortcuts to reach the 69 Zuk landmark; Change then the Speedrun heading shows the sectioned presets. Inferno Practice is `?encounter=inferno&open=practice`; set `ticks` above 0 before editing the start wave to exercise a pending setup against a started run. Go stays available whenever Practice has an actionable run. Wave shortcuts and Options start collapsed and remember their separate explicit choices. Arena always starts collapsed. The Arena row expands the inline setup map. The separate top-chrome Edit layout launcher opens the standalone workbench. Copy link is in the setup footer; Copy wave N link is in the workbench footer.

The shortcuts include checkpoints 50 (Mager and ranger) and 63 (Hard wave). In the rail
they only save the destination; in Practice they save and start immediately. For mobile, open
`?encounter=inferno&open=mobile&ticks=1&chrome=0`, then Tools -> Practice -> Start wave -> Wave shortcuts.
Layout editing is Tools -> Practice -> Edit layout.
The wide rail uses two rows of five; phone rail, desktop Practice and the mobile Start wave page use five
rows of two. Check the full short faces, not only the accessible labels, at the narrow widths.

### Inferno wave-field regression

The Fixed 1× Practice pane is only 152px wide (138px of content), despite its 765px viewport.
With a mouse the wave command takes the pane's 28px row and keeps its steppers there and in the
wide pane; it hides them by container width, not viewport width, only where even the compact pair
cannot fit. Touch (and the mobile Start wave page) makes the number field and Go at least 44×44
and drops the steppers. DOM-only tests cannot detect clipped hit targets. Run the
opt-in rendered check against the running dev server:

```bash
npx tsx scripts/check-inferno-wave-controls.mts <Local URL> <output directory>
```

Pass the Local URL `npm run dev` printed and any directory for the captures. This Playwright Chromium check is a rendered-geometry and
real-pointer regression check, not an editor workflow test: placement, swap/remove, pillar, start-tile,
wave and copy behavior belong to `src/encounters/inferno/__tests__/InfernoSetup.test.tsx` and
`src/components/__tests__/EncounterPanel.test.tsx`. Each scenario is one harness load from isolated
saved state plus a few actions; it never advances a fight or arranges NPCs. No scenario relies on
the default start wave. The configurer opens on the saved setup, so rail scenarios save only a bare
wave 52 (no layout, pillars standing) and type the wave they need, then build any draft by real
clicks; Practice scenarios save their full setup and use `ticks=12` for a spawned current wave.

| Viewport | Surface | Scenarios |
|---|---|---|
| `desktop` 1440×900 | Configurer rail | `setup`, `partial`, `waves` |
| `phone` 390×844 | Configurer rail | `setup`, `partial`, `wave62`, `placed` |
| `fixed-1x` 765×503 | Practice, workbench | `practice`, `wave62` |
| `wide-practice` 1440×900 | Practice, workbench | `practice` |
| `mobile` 844×390 | Tools -> Practice, workbench | `practice`, `wave62`, `placed` |

- `setup` (wave 52, random): wave/Arena/shortcuts/composition alignment and 44px disclosure rows;
  opening Arena leaves its row in place; on desktop the caption is visible in the rail viewport;
  chips and map share the rail's left edge.
- `partial` (three monsters placed by real chip-and-spot clicks): one more placement completes it
  with no column/card widening, overflow or vertical shift, and the share group stays put across
  the captures.
- `wave62` (empty): the five-kind chip row stays on one line; real `page.mouse` clicks where the
  west slot meets the west pillar's 44px area pick the slot, and the pillar center toggles the
  pillar; then one pillar down. In Practice the change from the seeded wave to 62 must not move,
  widen or overflow the workbench.
- `placed` (wave 62 populated): the rail places five of its six monsters, then clicks every pillar
  down and the floor to reach the longest summary,
  `Custom, rest random · All pillars down · Moved start`, which keeps its 44px row
  without widening or shifting; Practice's workbench is seeded with the spawned placements. Both
  check that a real click in the empty NE corner of the bat's maximum spot opens its picker.
- `waves` (wave 1 typed): its single chip is content-sized; a real click on the west pillar's former center
  tile at wave 67 moves You; wave 69 disables Arena with the Fixed summary.
- `practice` (Practice saved at 35, wave 52 spawned): the wave field and Go are unobscured, at
  least 44×44 on touch and 28px tall with visible steppers with a mouse; the workbench is seeded
  from the spawned wave without saving.

Every map measurement asserts one integer tile scale and a pixel-aligned origin; terrain, grid,
You, pillar, spot and spot-target footprints on the tile transform; crisp non-interactive grid; map
in the viewport; captions within two lines; pillar label and frame clearance; NPC sizes and the
small-NPC outline; no spot over a standing pillar; and 44px invisible hit targets. Every footer
capture asserts Copy is no wider than the primary action and that the rail's share group does not
shift between captures; `setup` and `practice` also assert Include gear starts on, its row is 44px
and inside the footer, and turning it off moves nothing. Editor frames must contain the map, chips,
footer and caption, and no page may overflow horizontally.

Captures wait for fonts and two animation frames after moving the pointer away. The output directory
gets `<viewport>-<state>.png` screenshots, `-zoom3x.png` map crops for wave 62, map geometry
`<viewport>-<state>.json`, `-container.json` and `-seeded.json` evidence, `footer-geometry.json`
and `failures.json`; failed assertions exit nonzero.

### Terminal fixtures

These routes mount the real App and its normal terminal-dialog arbitration, not standalone modal stories. They are also the `death` and `victory` [surfaces](#surfaces): `?open=death` is another spelling of `?outcome=death` (one fixture, the same tick 12), so the two cannot both be given:

- `/ui-harness.html?encounter=yama_p3&outcome=death&chrome=0`
- `/ui-harness.html?encounter=yama_p3&outcome=death&practice=1&chrome=0`
- `/ui-harness.html?encounter=yama_p3&outcome=victory&chrome=0`
- `/ui-harness.html?encounter=yama_p3&outcome=victory&practice=1&chrome=0`

Wait for `data-harness-ready="true"` as usual. All four stop at tick **12**, overriding `ticks` and leaving auto-advance off even if requested. A small deterministic, cacheless Yama prefix uses real engine ticks and a real replay bootstrap; choosing tick **10** adopts the state just before it (tick 9) through the exact-state-validated replay takeover, so tick 10 is the first tick played. Ticks 10–12 are then recorded normally, with an explicitly authored terminal ending at tick 12 (a lethal fixture HP change/completed outcome, not simulated or researched Yama kill/death behavior).

The authored ending belongs to App's committed simulation state and its recording; no private engine state or modal-visible flag is changed. `getState()` reports that committed state; `getEngine()` is the real playable engine behind the fixture. Restart fight resets to 0, practice restart reconstructs the state just before tick 10 (so tick 10 is played again), Watch replay enters the real transport, and Return to Lobby follows the real scene transition. Leaving replay also leaves the authored ending. Reset/navigation/user input cancels pending initial setup so an old asynchronous fixture cannot repaint over a user action; setup is not automatically reapplied.

## Control API

Wait for `document.body.dataset.harnessReady === 'true'`, never a timeout. `window.uiHarness` ([`harnessControls.ts`](../../src/harness/ui/harnessControls.ts)):

| Call | Purpose |
|---|---|
| `tick(count = 1)` | Advance; returns the new tick. |
| `await setAutoAdvance(enabled)` | Async; resolves once applied. |
| `await enterEncounter(kind, presetKey?)` | Async; settles the real lobby→loading→encounter transition. Await before ticking or capturing. |
| `await reset()` | Rebuild the current encounter at tick 0 with the same preset. |
| `setGamePanelTab(tab)` | Open a panel tab. |
| `setBossHp(hp)` | Practice's boss HP control. |
| `await open(surface)` | Open a live surface, `name` or `name:arg` (see [Surfaces](#surfaces)); resolves once it is on screen, throws with the reason otherwise. |
| `getState()` / `getEngine()` / `getEncounterKind()` | Live state, engine, and encounter. |
| `await showOutcome('death' \| 'victory', practice = false)` | Reinstall a named terminal fixture in a settled base Yama encounter, with auto-advance stopped. No arbitrary-state injection. |
| `options` | Parsed URL options. |

App knows nothing about this API: it fills a `DevHarnessSource` ref ([`devHarnessTypes.ts`](../../src/harness/devHarnessTypes.ts), type-only) with its own callbacks, so harness actions take the same path as user actions.

## Surfaces

`?open=<surface>[,<surface>…]` and `await uiHarness.open('<surface>')` share one list ([`harnessSurfaces.ts`](../../src/harness/ui/harnessSurfaces.ts)): one entry per surface, with the element that proves it is up and what it cannot be shown with. Each route runs what a player's press runs: App's own handler for the button, menu item or hotkey (handed to the harness on `DevHarnessSource.ui`), a launcher clicked, or a real setting; death and victory are the terminal fixtures. Nothing mounts a component on its own.

- **Boot** surfaces depend on the GPU probe, seeded before the app mounts, so they exist only as URL options; `open()` rejects them. **Live** surfaces open either way.
- `name:arg` passes an argument where the table shows one (`?open=tutorial:yama-waves`).
- `?outcome=death` (or `victory`) is the `death` (or `victory`) surface under its [terminal fixture](#terminal-fixtures) name: it joins the list first, so naming the same one in `open` is a duplicate and the other a conflict.
- A list opens in the order written. It fails before anything opens for an unknown name, a name listed twice, a pair that conflicts (table), or anything beside `webgl2-gate` (checked by the harness shell, so a gated page fails too); and after, naming the surface, if any listed surface is not on screen, terminal dialogs included (Quick search closes the modals under it).
- User input that cancels the boot (a real click or key, or a control-API call) also cancels a surface's remaining steps: a route that is still waiting changes nothing more, including its own clean-up (`tick-timing` leaves the loop to whoever started it).
- Routes that change a setting (the overlays, `countdown`, `mobile`, `viewport-size-warning`) store it in the harness's namespaced storage like any setting, so it carries into the next load. To start clean, use a disposable browser profile, or remove only the harness's keys from the page's console (`localStorage.clear()` would also wipe your real simulator settings on the same origin): `Object.keys(localStorage).filter((k) => k.startsWith('ui-harness:')).forEach((k) => localStorage.removeItem(k))`.

| Surface | Kind | Reached through | Conflicts / caveats |
|---|---|---|---|
| `death`, `victory` | live | The [terminal fixture](#terminal-fixtures) (`showOutcome`), the same as `?outcome=`: deterministic, stopping at tick 12; `practice=1` applies. | Base `yama_p3` only; elsewhere it fails with the fixture's own error. Not with each other, nor with a surface that hides or replaces the ending: `replay`, `tutorial`, `tour`, `title-card`, `countdown`. |
| `hardware-warning` | boot | The probe reports a software renderer (`Google SwiftShader (ui-harness)`); its own dismiss button gives the strip. | |
| `webgl2-gate` | boot | The probe reports no WebGL2, so the real `WebGL2Gate` replaces the app. | Opens alone; ready with no `window.uiHarness`. |
| `settings`, `plugins` | live | The drawers' own setters (the Menu item and the Plugins button). | |
| `menu`, `practice`, `actions` | live | The top chrome's launcher, pressed. | One pane at a time. Desktop only (not with `mobile`). `actions` is not available in replay. |
| `replay` | live | The Replay launcher, pressed (one tick is recorded first when there is none). | Not with `death`, `victory`, `mobile`. |
| `encounter-picker`, `quick-search`, `training`, `shortcuts`, `credits`, `cache-explorer` | live | The menu item's or hotkey's own handler. | Quick search closes the other modals. The cache explorer opens empty (no cache). |
| `encounter-panel[:kind]` | live | The encounter picker's Configure (`handleConfigureEncounter`). | Defaults to the current encounter (`yama_p3` from the lobby). |
| `modifiers` | live | The Modifiers launcher's handler. | Needs an encounter with run modifiers: `?encounter=sol_heredit`. |
| `tutorial[:id]` | live | Training's start for the lesson (the current encounter's first by default), which enters its own scene. | Not with `tour`. An unknown id fails with the list of lesson ids (`src/tutorial/content`). |
| `tour[:id]` | live | The same start for a spotlight tour (`main` by default), which goes to the lobby. | |
| `title-card` | live | The current encounter entered again, which plays its arrival. | Not with `death`, `victory` (the fresh entry replaces the ending). |
| `countdown` | live | Fight-start countdown on, the live loop on, the encounter entered again. | Transient: up for the count only (about 2 s), and it leaves the live loop running, so the fight starts after. Not with `death`, `victory`. |
| `hint-toast` | live | The quick-prayer orb pressed with no quick prayers chosen. | |
| `hint-bar` | live | Alt pressed on the window, as the keyboard does. Held until a real key-up or blur. | |
| `viewport-size-warning` | live | A locked resolution 200 px larger than the window each way. | Not with `settings` (App hides it while Settings is open). |
| `dps-overlay`, `prayer-flick`, `status-bars` | live | The plugin's own setting on. | XP drops and the boss bar are on already. |
| `fps`, `tick-timing`, `sound-debug`, `modifier-keys` | live | The debug setting on. | `tick-timing` runs the live loop until it has samples, then stops it. |
| `mobile` | live | Settings' Device choice set to Mobile, which gives the Mobile layout, its tool window and its first-run sheet. | Not with the desktop top chrome (`menu`, `practice`, `actions`, `replay`). A modal listed after it takes its sheet form. |
| `mobile-edit-bar` | live | `mobile`, then Settings' Edit layout. | As `mobile`. |

`?renderStatus=` is deliberately **not** in that list. The harness mounts no renderer, so no context can be lost and no app state reaches `ViewportStatusOverlay`; `RenderStatusPreview` mounts the component itself and portals it into Grid's container, which puts it on its real layer (under the minimap and the side panel) but is not a state a player reaches. Grid's own wiring is covered by `src/__tests__/Grid.test.tsx`.

`?replayChapters=` is not in it either, for the same kind of reason: a replay's chapters come from the recording, and an Inferno recording of real waves needs the OSRS cache and a fight far past the [browser reach limit](../../AGENTS.md). `ReplayChaptersPreview` synthesizes frames, derives the chapters from them with the encounter's own `infernoWaveChapters`, and mounts the bar inside the DOM `Grid` gives the floating transport. `replayChaptersMobile` reproduces the tool window's element chain and measurements instead of the window itself, so confirm band geometry in the real app. The bar's own behavior is covered by `src/components/__tests__/ReplayControls.test.tsx`.

**Not reachable**, and why:

- **Context menus, item names and tooltips:** they read the OSRS cache, which the harness never loads.
- **Tile-marker, inventory-tag and NPC-tag color pickers:** their handlers live in Grid and are reached only from those context menus (a tile, an item, an NPC), so they need the cache or the scene.
- **Loading screen:** the harness skips the cache bootstrap by design (`<LoadingScreen>` is not mounted).
- **Scene transition overlay:** it is up for about 300 ms while a scene loads, and the harness waits for it to clear.
- **The 3D scene and anything drawn in it** (the attack-timer bar, hitsplats): no WebGL.

## Scripting a check

For a quick look, use the browser console on a harness page once it has booted:

```js
document.body.dataset.harnessReady; // 'true'
uiHarness.tick(5); // 5, the new tick
await uiHarness.open('settings'); // resolves once Settings is on screen
uiHarness.getState().activePrayer;
```

To batch a QA round, script it with the project's own Puppeteer (a devDependency; `npm ci` skips
its Chrome, so install it once with `npx puppeteer browsers install chrome`). Save this anywhere, e.g. as `ui-check.mjs`:

```js
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import puppeteer from 'puppeteer';

const base = process.env.HARNESS_URL; // the Local URL Vite printed
const browser = await puppeteer.launch();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900 });
  await page.goto(new URL('/ui-harness.html?tab=prayer&chrome=0', base).href);
  await page.waitForFunction(() => document.body.dataset.harnessReady === 'true');
  await page.locator('::-p-aria([name="Protect from Magic"][role="button"])').click();
  await page.evaluate(() => window.uiHarness.tick(1));
  console.log(await page.evaluate(() => window.uiHarness.getState().activePrayer));
  await page.screenshot({ path: join(tmpdir(), 'ui-check.png') });
} finally {
  await browser.close();
}
```

With the dev server running, feed it to Node from the repository root, so that `puppeteer` resolves
from this project's `node_modules`:

```bash
HARNESS_URL=<Local URL> node --input-type=module < ui-check.mjs
```

## Guarding the seams

The main risk is a new boot effect doing cache or GL work outside the seams. After touching App's boot path, run `npx vitest run src/harness`; it asserts the harness creates no WebGL context and issues no `fetch`.
