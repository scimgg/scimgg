# Workspace And Top Chrome

The game frame and the chrome around it are separate coordinate systems. Chrome may sit outside
the frame, or over it, without changing the renderer's size, the selected client scale, or the
meaning of a game-frame position.

This is the canonical contract for the in-fight chrome: the launcher row and its panes, Plugins,
the boss bar's default slot, the Chatbox infoboxes and the replay transport. The visual rules are
in [DESIGN.md, Top Chrome](../../DESIGN.md#top-chrome-launchers-practice-and-actions).

## Design Goals

Keep combat controls one press away while covering as little of the fight as possible.

- **Nothing sits in the middle of the scene by default.** There is no readout card. The fight's
  stats live in Practice's Stats tab; nothing is open until the player opens it, except the first-run
  lobby menu below.
- **Protect the play area.** `protectedPlayArea` (`layout/chromeBreakpoints.ts`) is the ground the
  player clicks to walk on: a band 0.2 of the scene's height either side of its center, from 0.3 of
  its height down to its bottom. Panes keep out of it except in the narrow-window tool window and
  the explicitly opened encounter editing workbench below.
  Click-through overlays (infoboxes, the boss bar, XP drops) may lie over it, because they never take
  a click.
- **Scene clicks still play.** Opening a pane never pauses the game, moves the camera or catches
  scene clicks; Practice and Actions stay open until closed.
- **Respect the player's resolution and client scale.** Spare space around a Fixed frame is used
  (the row and its panes sit in the margin), never created by shrinking the game.
- **One source of state.** The chrome changes presentation only: no engine ownership, combat logic
  or recorded cursor coordinates.

## The Pieces

| Piece | Owner | Where |
| --- | --- | --- |
| Launcher row: Menu · Practice · Actions · Modifiers · Replay | `components/launcher/TopChrome.tsx` | Top-left corner, past the open Settings drawer |
| Menu, Practice and Actions panes, one at a time | `TopChrome.tsx`, `launcher/PracticePane.tsx` | Under the row, or the right-side column |
| Plugins and the FPS readout | `TopChrome.tsx` | The window's top-right corner |
| Boss bar default slot | `BossHealthBarOverlay.tsx` (`defaultSlot`) | Scene's top inset |
| Chatbox infoboxes | `InfoBox/InfoBoxPanel.tsx` (`chatboxAnchor`) | A band above the chatbox, as wide as it |
| Debug and coordinate readouts | `Grid.tsx` | On the Chatbox infoboxes, or above the chat |
| Replay transport | `Grid.tsx`, `ReplayControls.tsx` | The window's bottom center, bounded by open drawers and drawn over the chatbox where they meet |

All placement is pure geometry in `layout/topChromeLayout.ts`; the components measure live
rectangles (frame, chatbox, minimap, side panel, Plugins, the row's width in each form) and pass them
in. Pane placement ignores click-through overlays except the boss bar during an active practice
session. Size-driven switches and their lines are listed in `layout/chromeBreakpoints.ts`.

## Geometry

**One inset.** `HUD_TOOL_GAP` (4px, multiplied by the chrome's zoom) from the window's edge, or,
where the row would otherwise sit over the Fixed frame, from the inner edge of the frame's stone
border (`launcherRowPosition`). Fixed 1× puts the row at 8,8; fitted 1024×640 at 35,9; Fixed with
room around it at the window's corner, in the margin.

**The launcher row** is one row of 28px stone buttons, one gap apart, in the order Menu · Practice ·
Actions · Modifiers · Replay. Actions appears only where the encounter has commands; Modifiers only
where it offers run modifiers. Modifiers opens the modifier picker, which restarts the fight with
the chosen set, and is disabled during playback. Replay appears only once there is a recording.
Unavailable items are omitted without reordering the rest; Replay joins and leaves the end.

**Encounter editing workbench.** An encounter may provide one editor through `EncounterTool` in
`encounters/practiceChrome.tsx`. Its launcher sits before Replay; TopChrome does not branch on
encounter names. Inferno provides **Edit layout**, using the tile-plan icon when the row switches
to icons. Its matching mobile Tools destination opens the same `EncounterWorkbench` surface.
The Fortis Colosseum provides the same **Edit layout** for a run started on waves 1–11, under the
same rules, for its start wave's layout and start tile. `EncounterTool.offered` leaves it out of a
direct Sol start, which has no wave layout (its modifiers use the Modifiers picker); a wave run that
reaches Sol keeps it visible but disabled ("Wave 12 has a fixed layout."), as wave 69 does.
The workbench's frame and its short-landscape columns are shared (`.spawn-layout-tool` in
`SpawnLayoutMap.css`); each encounter supplies the head, the map and the footer's actions.

This workbench alone may cover the protected play area: spatial editing requires a legible arena
map that cannot fit the ordinary 152px Fixed 1× control column. It is opaque and non-modal, with
no backdrop or hotkey guard. Desktop anchors below the launcher row, leaving that row usable;
mobile anchors at the viewport inset. Width is 422px normally and 690px in short landscape,
clamped to the viewport. The short form groups wave, composition, chips and hint alongside the map
with a single full-width action footer, rather than reducing the map to a tiny thumbnail.
This exception does not affect `placePane`, other panes, or game-frame geometry.

Close and Escape hide the mounted editor, preserving local selection and scroll position until
the encounter changes; open state is never saved across reloads. Opening a regular launcher pane
closes the workbench, and opening the workbench closes that pane. Wave 69 keeps the launcher
visible but disabled, matching replay-disabled launchers, with the hover reason “Wave 69 has a
fixed layout.” Mobile shows the same disabled entry. Opened mid-fight, it shows the current wave as it spawned, as an
unsaved draft; editing or **Start wave M** saves it to the same setup Practice uses. **Copy link**
shares the setup shown and is disabled while a layout is partly placed (see
[encounter-configurer.md](./encounter-configurer.md)). Practice itself has neither layout nor
sharing controls.
While the workbench is open it holds the live fight the way a covering modal does (App folds it
into the wiring's `modalPaused`): the tick loop, countdown and live audio wait, so nothing can die
or win behind the editor, and nothing is recorded but the paused time a modal already excludes.
The player's own pause is a separate hold that the workbench never sets or releases. **Start wave
M** restarts under the hold and its countdown begins as the workbench closes. There is no Paused indicator:
the open workbench is the explanation.

**The Menu launcher** is the row's first button: its label (56px at 1×), or its three-bar icon in the
row's icon form. The menu's first row is
Settings (32px, plain text, ruled off from the rest), which toggles the Settings drawer and closes the
menu; then Encounters, Quick search and Training.
While the drawer is open the whole row moves right past it (`leftInset`, one gap from its edge) on
the drawer's own slide, and stays usable; a pane open from it follows, placed again. A drawer that
covers the whole window (narrow windows) hides the row instead.

**First run.** A new player's first lobby visit opens the menu once, after the lobby has held for
800ms (the scene starts as the lobby even on a route to an encounter). Never in an encounter or a
tour; a persisted flag (`_firstRunMenuShown` in the tutorial progress map) keeps it from opening
again. It closes like any menu. Until the player has opened Training, its row carries a muted
"Start here" note on the label's baseline, 8px after it.

**Labels or icons** follow the viewport alone (`launcherRowUsesIcons`, with the line in
`layout/chromeBreakpoints.ts`, `LAUNCHER_ROW_MAX_SHARE`). The row has two forms: all labeled, or
every launcher, Menu too, as its icon. It is labeled where the labeled row covers at most half
the scene from where it starts to the scene's right inset, and icons otherwise. The measured
examples here use Menu, Practice, Actions and Replay: 282px labeled at 1×, 124px as icons. Fixed
1× has 504px of room, so those icons start at 8, 40, 72 and 104 (8..132); with the drawer open 188px,
at 324, 356, 388 and 420 (324..448). Modern keeps its labels at every desktop size with the drawers
closed, and below 892px with the Settings drawer open turns to icons; Fixed fitted to the window
stays labeled down to a fit of about 1.12×. The form is decided on every launcher the encounter can
show, with Replay counted wherever it can appear (not in a combat tutorial, which hides it) and
before there is a recording, so the recording that arrives a tick into each fight (and goes on
reset) only adds Replay at the end in the form already chosen. Overlays never
decide it: the boss bar, infoboxes and the rest place themselves around the row. The room ends at the
scene's inset, not at the minimap or Plugins over the scene in Modern and Classic: the Plugins drawer
moves the minimap left, under a labeled row's end (Modern 800: the row ends at 286, the minimap
starts at 236), and with both drawers open on a narrow window Plugins gives way to the row and hides
(`pluginsClearOfRow`).

**Icons and hover cards.** "Glyph 12" monochrome pixel glyphs (three bars 10×8 for Menu;
bullseye 12×12, bolt 10×12, horizontal sliders 12×11, rewind 13×12) in the
label color with the labels' 1px shadow, so every state and pack recolors them like text. The
fixed cell and ink-box offsets are documented beside the glyph data in `launcher/launcherIcons.tsx`;
`launcherIcons.test.tsx` asserts the margins. At a fractional chrome zoom times device-pixel ratio,
`crispEdges` snaps the glyphs: sharp, not pixel-exact, as the pixel fonts are. What a launcher cannot
say on its face (its name in icon form, why it is off, what a notice means) it says on hover in the
app's hover card under the row, never the
browser's title tooltip; a press closes the card. Touch has no hover and a tap belongs to the
button, so touch shows no card. Menu's icon names itself "Menu".

**Surfaces and type.** The launchers and panes use opaque `--color-bg-solid`, a `--color-border`
hairline and no outer shadow, so their text keeps LCD antialiasing. Type is native 16px: Bold 12 for
buttons, values and headings, Plain 11 for secondary labels.

**Boss bar default** (`bossBarDefault`) places itself around the row and the fixed chrome; it never
feeds back into the row's form.

1. The row's line at the scene's top inset: centered, moved to 8px after the row, and kept one gap
   short of the scene's right inset (in Fixed, the minimap column's edge) and of the chrome that sits
   over the scene in Modern and Classic: the minimap with its orbs (or the Compact Orbs block) and
   Plugins, where they are now (Grid measures the minimap; TopChrome reports Plugins).
2. Else the next line, one gap under the row, normal form, by the same rule from the row's left
   (Modern 765: 263,36).
3. Else the compact form there at the row's left, as wide as the room to the scene's inset and the
   chrome allows, up to its 208px design width (Fixed 1× with the drawer open: 188×56 at 324,40;
   Modern 765 with the drawer open: 193 wide at 324,36, short of the minimap): the whole name, then
   HP, then the track; no Beta badge or percentage.

The bar widens to show the whole name in its normal form. The slot is computed in frame
pixels at the bar's scaled size, so the panel registry takes it as it is rather than projecting it
as a 1x design default (DraggablePanel `defaultInFrame`). Only the default changes: a position the
user saved is kept in its normal form, and replays keep their recorded geometry.

**Pane placement** (`placePane`), decided when a pane opens and kept while it is open (a new layout,
such as a window resize, a layout mode or zoom change or the chat opening, places it again; the
launcher row changing width or form does not). Normally the viewport and the fixed chrome decide it: the
row, the Settings drawer through the row, the minimap with its orbs or the Compact Orbs block,
Plugins, the side panel and its tab bar, and the chatbox. Click-through overlays normally do not;
the pane draws over them. Exception: an active practice session treats the boss bar as an obstacle,
alone or combined with an open pane. Session controls are compact (no "Practice · Ctrl+R" header,
tighter padding) for icon launchers or a placement narrower than 240px, labeled otherwise; a
combined pane keeps the form chosen on opening. Every form keeps its button words and wraps Change
and Clear to a second line when the row is too narrow.

- Under the launcher row, one gap below it. A row the drawer pushed past the play area's left edge
  opens its pane under itself anyway, from the row to the scene's right inset and one gap short of
  the chrome beside the pane (the minimap with its orbs, Plugins): Fixed 1× 324,40, 188 wide;
  Modern 765 324,36, 193 wide.
- Width `min(240, room left of the play area minus one gap)`, measured with the chat collapsed so
  both chat states agree (152 in Fixed 1×, 196 fitted at 1024×640). A Fixed frame with margin puts
  the whole pane outside the frame at 240.
- Height content-sized up to 400, ending one gap above the chatbox. It never reserves empty height.
- Right-side column, per pane: where the room under the row is under the pane's minimum (150 wide;
  Practice 140 tall, Actions and Menu 96), right of the play area by the same width rule, below the
  chrome over it (a row the drawer moved, the minimap, Plugins).
- Narrow-window tool window: where that column cannot host it either (Modern 480 portrait; a narrow
  Modern window where the column would sit under the minimap). 240 wide at the row's left, clamped
  one gap inside the window, or one gap short of the minimap's panel beside it where that still
  leaves 150 (228 in Modern 480); one gap below the row and ending one gap above the chat; content
  sized up to 400. Opaque pane styling, not the Mobile stone frame. It may cover scene ground while
  it is open: in such a window there is no room that does not. The FPS readout stays outside it.
- Title row: every pane opened from an icon launcher, Menu included, names itself with one close.
  Labeled launchers need no duplicate title, even in the right column or tool window. This is
  decided with placement, so a row changing form under an open pane never adds or removes its
  title. With an active practice session, the session controls come first and the pane title follows,
  naming the content below. Practice's Setup / Stats sit beneath it, and one `.launcher-pane__body`
  below scrolls (`overscroll-behavior: contain`; the chrome host is outside the game frame, so the
  wheel never reaches the camera).

**Plugins** is a narrower labeled stone button in the window's top-right corner, one gap in, in
every layout (`pluginsPosition`): 695,4 in Fixed 1×, 1200,4 in Modern 1270. It is chrome drawn on top,
so where the minimap or Fixed's stone column holds that corner it covers a little of it rather than moving
off. Its open drawer moves the button left past the drawer, on the drawer's slide, and the button
stays pressed and usable to close it. A full-window drawer hides the row and Plugins; where both
drawers leave too little room, Plugins gives way to the row and hides (`pluginsClearOfRow`).
The FPS readout sits one gap under Plugins, flush with its right edge, whenever Plugins shows
(right 4, top 36 in Fixed 1×), so it has one place and is never under the button, and follows it past
its open drawer. Without a Plugins button
it returns to its own corner (`fpsPosition`); TopChrome hides the readout where a full-window drawer
or an open Plugins drawer without a visible button covers its spot. It is anchored by its right
edge and grows leftward on a small opaque backing (`--color-bg-solid`, 1px `--color-border`, 2px
radius; 24×20 for two digits), click-through. Its width follows the number of digits only, reserving
the face's widest digit ("8") per digit (`fpsSizer`): 16, 24 or 32px, so 59→61 or 140→145 never move it.

**Chatbox infoboxes** (`chatboxInfoboxAnchor`, `chatboxInfoboxGrid`): one gap in from the frame's
left (the border's inner edge in Fixed) and one gap above the chatbox or its collapsed controls row.
Rows may run the chatbox's width, one gap short of its right edge and never past the scene's right
inset: 14 tiles a row at 1× in Fixed 1× (504px), 15 over Modern's 519px chat. They cross the play
area on purpose: the strip is click-through in every placement (`pointerPassthrough`), so a tile
never takes a click meant for the ground. Panes draw over them while open and never move for them.
The chat's width is the cap because the rows read as one band sitting on the chat; past it they
would meet the side panel or the minimap column. Tiles run in reading order in balanced rows (8 + 8,
never 14 + 2) and grow upward; every tile is always visible, nothing scrolls, and the rows never move
when a pane opens or closes. The replay transport draws over them where they meet, as over the chat. Fixed
cannot host the Inventory placement, so it shows the Chatbox one without overwriting a stored
Inventory choice.

The Inventory placement keeps rows of up to six: there the cap is the side panel's width, which the
strip lines up with, not a click concern. Free keeps rows of up to six too.

## Interaction

- One pane at a time. The lit launcher is the open pane's title and toggle.
- Practice and Actions close on Escape, their ×, or their launcher; scene clicks never close them.
  The menu also closes on a click outside it and on choosing an item.
- A tutorial pins the menu open while no other pane is, from before it filters its steps, so the
  entries its steps point at are found; a step that opened Practice closes it as the tour moves on.
  The chrome rises above the tutorial overlay; the Training cluster (with its Exit) and the Menu
  launcher, which brings that cluster back over Practice, stay pressable and undimmed.
- No keyboard focus: no Tab stops, rings, focus moves or arrow navigation; a press keeps no focus.
  The gold outline on an open launcher is selection, not focus.
- Actions run one command per press and the palette stays open. The list shares the menu's anatomy:
  quiet rows, faint separators, a whole-row press fill and full labels that wrap.
- Desktop Practice has Setup and Stats tabs and remembers the last one. Setup keeps Fight Setup
  (HP slider, then "Jump to phase" outlined buttons with hover explanations) immediately available.
  One remembered Options disclosure contains Mechanics, Practice aids and any actions in the same
  opaque scrolling body. Section navigation appears when Options is expanded and the body overflows,
  measured without the nav. A chosen section stays selected through its own scroll; a manual scroll
  follows the position again. Mobile Practice has no Stats: the tool window's Practice tab is the
  setup alone. Narrow widths wrap labels and choice groups; type never shrinks.
- Stats shows the player's and the target's HP with bars, tick, DPS and max hit. DPS has a "DPS"
  label with Actual and Expected indented beneath, values in one right-aligned column. "None" and
  "No damage yet" stand in place of invented numbers. Target names come from monster metadata
  (`npcDisplayName`).

## Replay

The chrome is the viewer's own: it is drawn in the window-level chrome host
(`.workspace-chrome-host`), never inside the recording's scaled presentation surface, and nothing
about it is recorded.

During playback Practice shows Stats from the recording; Setup and Actions are disabled and say why
on hover. The live tab and state return on exit. While a Mobile recording plays on a desktop, the
Mobile tool window replaces the top chrome, as it does live.

`ReplayPresentationState.frame` describes the game frame. The workspace is the frame itself:
`workspace` carries only its size, which must match `frame`, and cursor pixels are frame-local.
The infobox placement token `hud` is the stored and recorded name of the Chatbox placement.

## The chatbox

`layout/chatboxLayout.ts` places the chatbox in every desktop layout: inside the frame in Fixed, at
the screen's bottom-left in Modern and Classic. It is the bottom layer of the frame's overlays.
Panes, the Chatbox infoboxes and the readouts keep off it. The replay transport does not: it is
window-fixed at the window's bottom pad, centered in the window when drawers are closed and bounded
by the area not covered by open Settings or Plugins drawers. Grid uses the live window-relative
`uiInsets`, not recorded frame-local `viewportInsets`, to place the dock and choose compact mode
from the remaining width at the chrome's zoom. It draws over the chat and the Chatbox infobox rows
wherever they meet. The chat never moves it, so Grid does not measure the chat for this placement.
It is portalled into the window-level transport host (`.workspace-replay-host`, App.css: fixed,
z-index 80), a sibling after the game frame, so it paints above everything in the frame in every
layout, including a replay frame that is isolated or scaled to fit. The dock spans that available
width but takes no pointer events; only the bar does, so clicks on the bar go to it and the chat
beside it keeps its clicks, wheel and scrollbar. During playback the scene takes no movement
clicks, so the bar need not keep off the play area. The bar is opaque, as every control is
(DESIGN.md, the Opacity Rule).
Draggable panels (side panel, minimap and orbs, free infoboxes, XP drops,
boss bar) draw over it, so opening and collapsing the chat never moves them.

Known parity gap: the Mobile layout has no chatbox. The mobile client has one (601:49
CHAT_CONTAINER) behind its own chat button, which the simulator does
not draw.

## Mobile Tools

`MobileToolWindow` is viewer-owned chrome, separate from the desktop launchers. Its anchor is the
native **left** side-panel slot from `osmChromeLayout(..., true)`, irrespective of the setting
“Hotkeys open side panels on the left”. That setting moves only panels opened through hotkeys.

The tools do not change that setting or the game panel's state. They deliberately **cover** an
open game panel in the left slot: close Tools to use the panel underneath. `osmToolWindowLayout`
keeps both Tools and its window inside their native slots and the safe frame. The window's
right edge stops at the actual right-side game panel, or the tab rail when the game panel is
on the left. This narrows the window in portrait rather than covering inventory. Its top also
respects the native chat and map/orb reservations. There is no obstacle search, adjacent-column
fallback or above-panel placement. Practice, Menu, Browse and Replay share the same rectangle.
Moving a game panel between left and right can change the available width; a different recorded
frame geometry also changes the native slot. Neither changes the Tools toggle position.

All pages fill that same aligned rectangle, with no tool-specific minimum or maximum dimensions
and no compact-page height budgets. Content scrolls instead of growing beyond it. The three
tabs share its width and the Tools button's height, including their top/bottom borders. They use
the launcher glyphs when the slot is narrower than 126px or the row is shorter than
22px, keeping their accessible names. On the narrowest native slots their widths are necessarily
below 44px; widening the panel would cover native chrome. A collapsed tutorial strip is the
shared row height plus its top border.

Tools derives its bounds from `osmPopoutPlacement`. Its top respects the snapped bottom of
both expanded and collapsed Hotkeys, whose centering/truncation can differ by a logical row.
Clearance also encloses the native panels' device-pixel-snapped paint bounds. At fractional
DPRs this can leave up to one CSS pixel between the panel and column rather than letting a
rounded native edge paint underneath it. The geometry uses the shared edge-rounding rule,
not a compensating offset; the dock/footer top and bottom baselines remain aligned.
The shared bottom is the earlier of the native panel and pop-out bottoms, clipped to the safe
frame. The footer and Tools stay aligned without extending either native slot. **Native chrome
clearance takes priority over a 44px touch minimum.** At the default scale without safe
insets, the row is 27px at 568×320, 32px at 667×375, 33px at 844×390 and 390×844,
31px at 360×640, and 49px at 1024×768. Safe areas and fitted recordings can reduce it further.
Open/closed toggle geometry is identical. The Tools label becomes the Menu glyph below
28px width or 20px height, keeping its Open/Close tools accessible name. The selected tab also
closes it. Normal page loads start with Tools closed, even if it was open on the previous visit.
Explicit replay entry and tutorial targets can still open the panel when needed.
No additional Close control is attached to the panel. Panel and toggle are separate
rectangles in the HUD reservation, not a single bounding box that blocks the scene between them.
The panel uses the native frame's pixel snapping and placement. Open/close and page changes are immediate, with
no animated translation, opacity or delayed layout (including under reduced motion).

Practice shows one group at a time: health, phase jumps, an encounter-owned setup control and
its Options contribution, each setup choice family, mechanics, named sections, practice aids,
actions, full restart, or a practice session (replay practice while active, otherwise the
encounter's own). Pages follow the run's current stage, as desktop Practice does (see
[Encounter-owned setup controls](./encounter-configurer.md#encounter-owned-setup-controls)).
Health opens directly by default. The full group header returns to the Practice overview, whose destination rows open
individual groups within the same slot. The overview has a static title, not another toggle.
The current group survives Menu/tab changes while Practice remains mounted; a new session
selects its Restart/Change/Clear page. No extra overview tap is required to reach initial health.
For a single-choice setup group, the group heading supplies its visible label and adjacent help;
the shared radiogroup keeps its accessible name. Parent/dependent families keep their own labels.
Encounter toggle metadata may supply `compactLabel` for these pages without changing desktop's
full label. Choices use one column so their ordering and target shape do not change with wrapping.
The group heading is 40px high. Health offers the full-restart callback in a bottom
shortcut except in slots shorter than 200px or during a practice session; the explicit Restart
group remains available in every slot. Session uses the shared Retry/Change/Clear owner.
Below 120px slot height, Practice scrolls its header with the content, so a fitted recording's
fixed header cannot consume the entire body. Normal phone/tablet slots keep the header stationary.
Below 88px width or 56px available body height, a scrollable "More room needed" notice replaces
the visible controls and advises increasing interface scaling or enlarging the view. Tabs are
disabled so playback cannot start with a hidden transport; Tools still closes normally. Panes
stay mounted and restore their selected group when sufficient room returns. The footer's minimum
height is zero so its icon content cannot force it above the native dock in these extreme slots.
Menu starts with Settings, Plugins and Browse. Browse replaces those rows with the other
destinations; tutorial targets select the needed page without changing the user's choice.

Replay follows `syncReplay`: selecting its tab enters playback and leaving exits it. Its
transport and More actions remain inside the same scrollable slot. The ordinary
transport uses three touch rows: tick/More, scrubber and playback. A chaptered recording (Inferno
waves) adds a fourth, the wave readout with its previous/next jumps, above playback; its wave list
replaces the scrubber row while open, and More hides the readout. Its controls are distributed
within the native height, rather than leaving a separate empty area below playback. More has
an internal opaque scroller beneath its stationary header. More omits the
nonessential total tick so its scrollbar cannot force a second header line. Slots narrower than
150px omit that total in ordinary playback too. Slots shorter than 200px use 40px transport rows
instead of 44px so playback remains visible inside the native bounds; other controls scroll.
Tools never pauses the
game, moves the camera or focus, or dismisses itself on a scene click. The tutorial
targets stay mounted. A tutorial targeting a tab can show just the footer, without mutating the
user's open state. Mobile Tools does not affect desktop launcher geometry or appearance.

## Approaches To Avoid

- A HUD card or tool stack in the scene's bottom-left, in any orientation: it covers the ground the
  player walks back onto, and no way of fitting it (compact cards, horizontal strips, exterior
  lanes) avoids trading one cover for another.
- Auto-pausing, moving the camera, or dismissing panes on scene clicks.
- Infoboxes that scroll, hide tiles, or move when a pane opens.
- Plugins in the menu, or moved beside the minimap or shrunk to an icon to keep off its ring: it
  stays one labeled button in the window's top-right corner.
- Lifting the replay transport above the chatbox (the chat would push the control around), or docking
  it to the chatbox's width (it would leave the window's center): it centers in the window and draws over
  the chat.
- Tucking the launcher row under the open Settings drawer: it moves past it instead.
- A separate Settings cog launcher: Settings is the menu's first row.
- Choosing labels or icons from the overlays beside the row (the boss bar, minimap, Plugins): the
  row's form would change with the fight. It follows the viewport alone.
- A mixed row (Replay alone as its icon, or a labeled Menu before icons): the row is all labeled
  or all icons.
- Deciding the form without Replay until there is a recording: the row would flip a tick into every
  fight and back on reset.
- Client-color launcher sprites: the icons stay monochrome in the label color.
- Keyboard navigation of the chrome (see the keyboard and focus policy in `docs/agent-reference.md`).

## Verification Scope

`layout/__tests__/topChromeLayout.test.ts` owns the geometry against the measured cases (Fixed 1×
open and collapsed, fitted Fixed, Fixed with margins, Modern, Modern 765 with the drawer open, the
Modern 480 tool window, and the strip's own grid: 16 at 1× in two rows, 10 at 1.5× in one). `InfoBoxPanel.layout.test.tsx` holds the strip's click-through contract.
`launcher/__tests__/TopChrome.test.tsx` owns the row, pane exclusivity, dismissal, the fallback
column and tool window (title row, one close, one scroller, the wheel kept from the frame),
remembered tabs, replay, Stats and Plugins placement. `InfoBoxPanel.attached.test.tsx` owns
the Chatbox rows. Browser checks use the UI harness at Modern 1909 and 1270, Classic 1366, Fixed 1×
with the chat open and collapsed, Fixed in a larger window, fitted Fixed, replay and the lobby. Many
or scaled infoboxes are not reachable in the harness; the tests cover them. For scrollbar checks
launch Chromium with `ignoreDefaultArgs: ['--hide-scrollbars']`. In-world confirmation remains a
user check.
