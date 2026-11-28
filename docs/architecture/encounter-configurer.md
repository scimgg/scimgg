# Encounter configurer and Practice

The configurer is an Operate-mode preparation workbench within the established simulator identity.
Text size and contrast must not regress, and mobile Practice lives in the Mobile tool window's Practice tab (Practice / Replay / Menu).
The modal family shares its materials with this workbench; sidebars and native chrome remain separate.

## Ownership

`EncounterPanel` owns the setup / loadout / modifier view. Switching to modifiers hides rather than
unmounts `EncounterLoadoutSection`: drafts, import requests, saving and selected slot state stay
with their owner. Modifier changes save immediately (see [Setup persistence](#setup-persistence));
Return to setup is navigation, not a cancel transaction. Reopening setup shows the saved choices.
Setup reviews only selected modifiers, with every
name and tier visible. Details & edit opens the full editor for canonical effects and
tier changes. Off removes a modifier from the overview; all-off shows an explicit empty state.

`EncounterSetupSelection` renders metadata-backed variants and modifier tiers. Contract terms,
reward, availability and Beta status are authored metadata. `StartingHitpointsField` is
conditional on a variant declaring starting HP, and uses Bloodied's own defaults and clamps.
Only Yama base offers Practice As and the tutorial. Forfeit offers Infinite Stamina. Sol defaults
to Blasphemy III. Zuk is wave 69 of the `inferno` encounter; the `zuk` alias kind
enters that wave.

An edited loadout that matches no named set does not hold the fight. The edit is already this
encounter's loadout: it travels `applyLoadout` to App's `setEncounterLoadout`, and
`useEncounterEquipment` writes the map to local storage on every change, so it survives starting,
restarting, reopening the panel and a reload; `enterEncounter` reads that same stored loadout.
Encounter entry does not infer a damaged save from a sparse equipment selection.
An edited loadout may be absent from the preset list, which is why export refuses it and
the next preset press replaces it. The shared loadout identity warns once beside the save controls:
“This loadout is not saved as a preset. Starting the encounter will not save it.” The wide footer
shows the short status “Not saved as a preset” beside Start for a draft, or the loadout name
otherwise, rather than repeating the full explanation. The draft status in the standalone
preset picker keeps the shorter “Loadout not saved as a preset.” Starting uses the
current loadout without creating a named preset or updating an existing one; it leaves that
preset-save step undone, without blocking the fight.
Save preset, Update preset,
Save new preset and Revert belong only to the loadout bar. Save preset opens the Preset name
field, then commits it; Update preset changes the existing saved preset without creating a copy.
Saving and updating use “preset” consistently in their labels, validation and confirmation messages.
The visibly labeled name field brings itself into view and keeps the compact controls' touch
height. There is no second Save in the footer.

Loadout selection, import/export, stats, unlocks, equipment, inventory, pouch and spellbook use
their shared implementations. The deeper editor is a compact affordance only: a wide card
already shows the frame, supplies and stats, so it offers no Edit step. On desktop, Change opens
preset choices above the still-visible equipment preview and keeps the chooser open through selection
for repeated comparison. Preset choices precede clipboard transfer tools; pending draft actions sit
above comparisons. Done closes it without changing the kit. Compact layouts replace the editor
with the chooser, without unmounting it, and close the chooser after selection. The selection handler
reads the current viewport at the press, matching the inline-preview CSS breakpoint. On a phone, Change reveals presets inline
and Edit reveals the deeper editor in the same frame. Combat stats is an inline disclosure.

A shipped set may name a picker section (`EncounterPreset.section`; the Inferno's four speedrun
replicas are `'Speedrun'`). `LoadoutPicker` lists unsectioned sets as the main presets and each
section, in declaration order, as a disclosure below them headed by its name and the number of sets
in it, locked ones included. A section starts closed unless it holds the selected set; a press
overrides that until a selection, import or stat auto-switch moves into it. Closed sections unmount
their tiles. Their groups stay owned by the one preset listbox, so the arrow-key roving
walks only open sections. Desktop Change, phone Change and the standalone picker share this; an
encounter whose sets name no section draws no section heading. Names are data, never hard-coded.

## Setup persistence

`useEncounterManager` owns it; `SetupContextControls`
(`src/types/setupContext.ts`) is the contract the configurer and Practice render.

- **Remembered everywhere.** Configure, Enter (picker, lobby NPC, URL route, group continuation),
  Start and Restart all use the player's saved setup for the exact encounter/variant: mechanics
  (`mechanicsConfigPerEncounter`), modifiers (`modifiersPerEncounter`) and starting hitpoints
  (`startingHpPerEncounter`), resolved as defaults -> variant's saved entry -> account toggles
  (`__player__`). Opening or closing a surface never resets anything. Practice aids (Infinite
  Health, Infinite Special Attack, Auto-Prepot) are remembered like any other choice.
- **Edits save at once** from the configurer, desktop and mobile Practice and the Inferno layout
  workbench.
- **Modifiers** are saved per encounter kind as the whole selection: `{}` is "every modifier off",
  an absent entry the descriptor's `defaultModifiers` for the run's setup (a Fortis Colosseum start
  wave's suggestion). A present entry is always the player's, even one equal to today's default, so
  it never starts following the setup again; only a reset (the modifier editor's own, or Reset to
  defaults) removes it, and the editor offers its reset whenever there is an entry. The Modifiers
  picker's restart saves its selection too. Unknown modifiers and tiers are dropped on read
  (`filterModifierSelection`). The field rides the settings blob, through `normalizeSettings`,
  which migrates it once to `MODIFIER_SETTINGS_VERSION` (version 1 clears Sol Heredit's saved
  Blasphemy III, which older builds saved for an untouched selection).
- **Restart** resolves the modifiers exactly as an entry would. Where they differ from what the
  running engine was built with, the run restarts on a fresh engine
  (`useEncounterManager.createRestartEngine`), with the restart's loadout, countdown and one
  recording; otherwise the running engine is reset.
- **Reset to defaults** (`SetupContextControls.onReset`) clears the shown variant's mechanics,
  modifiers and starting hitpoints entries, and nothing else: not gear, named presets, account
  unlocks or sibling variants. `isDefault` says whether there is anything to reset (account unlocks
  are not compared). It returns an undo that writes those three entries back over whatever else has
  been saved since. Replays and tutorials offer no reset.
- **Where the reset is drawn** (`ResetToDefaults.tsx`, one hook and control for every surface): at
  the far end of the configurer's setup-column heading row ("Fight setup", or the encounter's
  `railSection`), so the kit column beside it is visibly outside it; as the last row of desktop
  Practice's Setup scroller, ruled off above Restart fight's separate footer; and as the last row of
  mobile Practice's overview list, after Restart fight. It is hidden while `isDefault` holds and
  wherever `onReset` is absent. Pressing it shows "Defaults restored" with Undo in the same place,
  with no toast, timer or dialog. The Undo lasts until the options next change away from their
  defaults (on any surface), the encounter or variant on screen changes, or the surface unmounts;
  it waits to see the defaults before watching, so a late result cannot end it. Desktop Practice
  holds it across a look at Stats and mobile across its pages. The heading row keeps its height in
  every state. Player-facing copy speaks of options and gear, never "setup".
- **Alias kinds** (`resolveEncounterEntry`): the Zuk statue and `/zuk` save only their own keys
  (`infernoStartWave: '69'`) over the saved Inferno setup, on Configure and on entry alike. Wave 69
  is also the Inferno's default start, which Reset to defaults returns to; the statue still writes
  it, so a saved other wave gives way. The Colosseum's former `/sol-heredit` link
  (`resolveLegacySlugEntry`) saves `colosseumStartWave: '12'` over its saved setup the same way.
- **Tutorials** run in a tutorial setup that is never saved: the encounter's defaults, the account
  unlocks, the lesson's mechanics (`TutorialDirector` `setMechanics`, checkpoints) and forced
  Infinite Health, played in the lesson's preset gear when it declares one. Practice edits and
  autocast picks during a lesson stay in it; Restart keeps it. Leaving Tutorial Mode (Exit, an
  ordinary Enter or Start, the lobby) returns the scene to the saved setup, so nothing is written
  on entry or restored on exit.
- **The engine** is built from the resolved setup synchronously, and the mechanics sync in
  `useSimulationWiring` follows the active scene's setup (`activeMechanicsConfig`), so a plain
  Restart replays it. Retry, Lock layout and the reroll keep their one-attempt `runMechanics`;
  Lock layout's run-only lock (`infernoPinnedWave`) is one too, re-emitted by each locked Retry, so
  it lives in the run and its recording but never in the saved setup, a setup link or the "press
  Go" key (save a custom layout in Edit layout to keep spawns past the run). Replays rebuild from the recorded bootstrap and
  never write settings.
- Inferno setup links and the address-bar mirror: [inferno-policy](../encounters/inferno-policy.md).
  The link notice (rail, Practice and the mobile page alike) puts its Undo at the end of its
  sentence, as the same underlined text action the reset's Undo uses, rather than a row of its own.

## Geometry

Desktop setup has a stable height capped at 800px and width capped at 920px, with 24px viewport
clearance. The loadout / setup columns share the width equally and scroll independently against
opaque backgrounds. Expanding a disclosure or choosing presets does not move the surrounding
window. Header/footer stay outside the scrollers. Phone uses one setup scroller, a compact loadout
summary and a single-row pinned footer. Landscape above 720px keeps the two independently scrolling
columns and direct gear editing, rather than spending the short viewport on a full-width stack.
The deeper editor keeps its grid/slot keyboard behavior. App chrome is pointer/touch,
without a focus trap or navigation keys.

Contract setup leads with the full selected name in one Change control. It reveals the six
options inline; choosing an option closes that catalog without discarding the terms
disclosure's state. Choosing a different non-default contract opens its canonical terms.
Closing the catalog through Done changes nothing. There is no keyboard navigation.

The rail's choice groups and switches wrap to intrinsic tracks. Rules, keybinding editors and
the pickers occupy the full width. Compact layouts keep switches in one column so long labels
do not compete for width. A selected non-default contract opens its terms; choosing another
non-default contract reveals its consequences in the same mounted disclosure. An explicit collapse
holds through ordinary setup changes and pressing the already-selected contract. Encounter metadata
owns the verbatim terms and rewards. The full modifier editor uses aligned rows on
desktop, stacked descriptions on phone, and two compact columns in short landscape. Its header
states that changes apply immediately. Its footer has the selection count and a single Return to setup
action, with no Start or duplicate Back action. Players select modifiers, return to review the kit and
fight setup, then Start there. Escape also returns without cancellation. The hidden setup body stays
hidden in native landscape, where the layout otherwise overrides its display.
Selected modifiers use a two-column, row-first overview rather than duplicate forms. Names wrap
without truncation; one-tier selections explicitly show I. The overview has no nested scroller or
per-item interaction targets. The full editor reserves tier-description height for comparison but
does not reserve an inactive overview's height once a tier is selected.
The footer says Close in setup and dismisses the configurer without rollback. The compact loadout
editor names its task in the subhead and has one Return to setup action in its footer, alongside direct
Start. Start Tutorial stays on setup rather than competing with editing. The header close mark always dismisses the whole
configurer. None of these navigation actions unmounts the loadout owner within the open panel.

In the compact editor, equipment and inventory columns wrap at their combined intrinsic minimum
instead of sharing equal fractional tracks. Their slot targets do not shrink. Transfer, spellbook
and draft actions use the same minimum touch height as the other configurer controls. Inline Change
keeps the summary as the single loadout identity; the picker owns transfer and draft actions.
Spellbook and rune-pouch controls share a lower row under their labels, wrapping at intrinsic widths;
the expanded rune tray spans the full supply area.
The compact encounter header shows the presentation's short phase/wave context and active contract.

The slot picker keeps its own portal, positioning and keyboard owner. In short landscape,
held-item context and support occupy the left column while search, category filters and results
occupy the right. Its result list keeps usable height rather than shrinking to zero behind fixed
touch controls. Tall and portrait layouts keep the single-column flow. Search notes share a
layout wrapper so multiple notes remain readable without overlapping in the landscape grid.

BossPortrait occupies the header's full height in a text-free region, 120px wide on desktop and 68px
in compact layouts. ResizeObserver passes its measured width and height to both renderer and
projection; the model is not stretched from a square canvas. It receives the cache bootstrap loaders.
It has no well: the canvas paints the raised header's own color, and the bottom edge is taken by
a painted gradient in that color, on a text-free `::after`. The fade is painted rather than
masked because `mask-image` composites the portrait's layer, and the two-browser differential
measured that layer dropping all 27 setup-rail labels to grayscale once the loadout column was
expanded and scrolled. The live canvas needs only its base dissolved; the thumbnail is a
rectangular picture with its own backing, so it stays at 56px desktop / 44px compact
size, centered in the wider region and vignetted on all four edges like the picker's hero art.

The stand cycle loops for as long as the portrait is visible, wrapping on the cycle length so it
restarts on the pose it just reached. What draws a single still frame is `still` (which the phone
and the other compact layouts set) and a touch-only device. Reduced motion deliberately does not:
the idle is a slow stand cycle inside the header, not motion that travels. Modifier/edit views and
input interaction still pause it, as do a hidden document and leaving the screen, and playback
belongs to the mounted portrait, so a view rebuild resumes where it stood. Its renderer owns the
once-only initialization idle budget and hidden/offscreen suspension; the harness shows the
thumbnail.

Portrait framing orbits west of the NPC's southward facing, which turns the subject towards the
header's text rather than off the card's left edge and keeps the silhouette narrower than the
mirrored angle. `focusHeight` is the head's height as a fraction of the pose, and the camera aims
there and orbits the horizontal median of the model's visible points in a thin slice at that
height, not the center of its bounding box: a boss's box is set by wings, weapons and tails, and
the head sits well in front of its middle, which yaw 0 hides along the line of sight and any turn
swings sideways across the frame. The median ignores the few far points a mean would follow, and a
pose with nothing at that height falls back to the box. Each encounter keeps its own pitch, focus
height and span. The UI harness mounts no renderer and no cache. An external, temporary portrait-only
probe can verify framing with existing local cache assets and the real renderer without booting an
encounter or downloading a cache; it does not verify the full app's cache-to-component wiring.
The per-boss crop is judged at desktop, phone and short-landscape container proportions, through
the idle cycle: Yama keeps horn clearance while bringing the face forward from his wings; Sol keeps
his tall crest but centers the face and shoulders; the Inferno portrays TzKal-Zuk, who sits higher above
the fade with room for his idle's upward movement. These choices live in each presentation's framing metadata, not
viewport-specific transforms or a second generic positioning system.

Practice placement and maximum dimensions are owned by `topChromeLayout` and
`osmToolWindowLayout`, not fixed specimen widths. The smaller native mobile host can therefore
need more scrolling than desktop. Options is collapsed initially; `usePracticeControls` saves
the explicit choice with `loadSetting` / `saveSetting` under `practice-options-expanded`, independently
from encounter mechanics. Stats uses the shared readouts. Section shortcuts are available when
expanded desktop Options overflows, using the zoom-correct scroll navigation.

Desktop Practice has Setup / Stats tabs, with Restart fight outside its settings scroller.
Mobile has no second tab strip and no Stats: native HP orbs and the boss bar own health readouts,
and the DPS overlay plugin covers damage for players who want it. The tool window's Practice tab
(`MobilePracticeControls`) is paged: a group list (session, boss health, phase jumps, the
encounter's own setup control, each setup family, its Options contribution, mechanics, named
sections, practice aids, actions, restart), and one group at a time behind a "‹ Practice" header
that returns to the list. The session page shows replay practice while it is active, otherwise the
encounter's own session (Inferno: Retry wave N, plus Random spawns on a custom-layout wave, New spawns
on a locked one, or Lock layout on any other wave but 67 and 69). It opens on Boss health, or on the session page while a
replay practice session is active, or the first page where there is no boss.
Phase jumps are vertical rows, listed only while the boss is present. Boss health adds a Restart fight shortcut only
when restart is available, no session is active and the slot is tall enough; the Restart group is
listed whenever restart is available. Geometry and paging details are in
[Mobile Tools](./workspace-docking.md#mobile-tools).

Restart fight calls App's `handleReset` through Grid and the host; it is not exact-state
retry. The replay practice retry/change/clear controls stay in their own host and are not
duplicated. Replay disables setup. Busy exact-state restore disables whole-fight restart
until that operation completes.

## Encounter-owned setup controls

An encounter whose setup needs more than generic toggle and picker rows (the Inferno's start wave,
named waves and pillars) registers an `EncounterSetupControls` entry in `src/encounters/practiceChrome.tsx`:

```ts
interface EncounterSetupControls {
  keys: readonly string[];
  railSection: string;
  summary?: (config: MechanicsConfig) => string;
   hasFooterActions?: boolean;
  render: (props: {
    config: MechanicsConfig;
    onChange: (config: MechanicsConfig) => void;
    surface: 'rail' | 'practice';
    run?: { stage: number; startedWith: string; currentSetup?: Partial<MechanicsConfig>; execute: (command: EncounterCommand) => void };
    exportGear?: () => string;
    actionFooter?: HTMLElement | null;
  }) => React.ReactNode;
  optionsSummary?: (props: EncounterSetupControlsProps) => string;
}
```

`EncounterPanel` renders it as its own rail section after the shared encounter selection and before
Preparation, with the same seam a contract or modifier block draws, and filters `keys` from every
generic list on the card. `railSection` names the rail heading and the section's accessible name;
the control draws its own field labels. `summary`, where given, is the footer's line beside Start ahead of the phase metadata
(Inferno: "Wave 35", or "Wave 69 · TzKal-Zuk"); modifier counts lead where an encounter has
them. In Practice, `MechanicsSettings` renders the immediate control in the always-visible Fight Setup,
outside Options; `optionsSummary`, where given, names the Options disclosure's contents for the current
run in place of the generic summary. Mobile Practice gives the control its own page instead, under
`practiceSection ?? railSection`, after phase jumps and before the setup families.
Both use the same config and change route, and the list filters the same keys. The configurer list only filters, so a choice is never
offered twice. Persistence stays in the encounter's mechanics config, and run state (`stage`,
`startedWith`) is derived from the snapshot by the encounter.

`encounterCurrentSetup(snapshot)` supplies the optional encounter-owned setup that reproduces the
current stage. Only the encounter tool's run (`useEncounterTool`) carries it, memoized on its serialized
value rather than per-tick snapshot identity; Practice setup controls never receive it.
Inferno uses the actual `waveSpawnLayout` and `waveStartDestroyedPillars`, not pending settings or
pillars damaged mid-wave. Before a wave has spawned, the editor falls back to saved setup.
Sharing never mutates setup. The workbench initializes a local draft from this current-wave
configuration. Merely opening or closing does not change the saved start wave. Explicit edits
save through the mechanics route; Start commits even an untouched seed before executing
the start command. The tool stays mounted and keeps local edits on same-wave reopen; a new spawned
configuration seeds a fresh draft. Other Practice settings follow saved config.

Inferno's **Wave & arena** rail groups Start wave and Wave shortcuts, then one **Edit layout** summary row.
It names random, custom or partly custom spawns, any down pillars and a moved start. It always opens
collapsed, even for a saved custom layout. The whole **Edit layout** row toggles the editor directly
below it, using the same SVG chevron as Wave shortcuts. There is no duplicate trailing action.
Opening does not scroll or move the disclosure row. Closing preserves changes. The map, chip row, tools and
caption share one width, flush with the rail's content edge and capped at 396px to bound desktop height.
Normal setup controls stay in the same rail; Copy link and Include gear stay in the footer.
Start wave and Edit layout share a label/value grid; composition and Wave shortcuts begin at the column's
left edge. The summary is a single ellipsized line: Random, Custom or Custom, rest random, with a
count of down pillars and Moved start when applicable. Its min-width-zero value cell cannot widen
the rail. Both disclosure rows have 44px targets. Wave 69 says "Fixed" and disables the disclosure, including its chevron.
Waves 67/68 offer start-tile editing; nibbler-only waves offer pillars and start-tile editing.
Practice keeps Start wave + Go and the generic Restart fight footer, with no layout or sharing controls.
An encounter-provided **Edit layout** launcher (one matching mobile Tools entry) opens a dedicated
non-modal workbench. Its geometry exception and lifecycle are in [Workspace docking](workspace-docking.md).
**Copy link** shares the edited setup shown in the panel, not a separate fight snapshot, partial
layouts included. **Start wave M** applies
the edited setup. Close never starts; Start wave runs the start command and closes the workbench.

One compact wrapping progress row shows each wave monster's placed/total count with its role swatch.
Tap an unfinished chip to arm that kind, then tap empty spots to place it until its total is reached.
Tap the selected chip again to disarm it; completed kinds are dimmed and disabled, and become available
again when a placed monster is removed. Changing waves resets the armed choice. Directly tapping an
empty spot without an armed kind opens the remaining-monster picker. No extra status line repeats
the counts. Chips size to content, keep their boxes and 44px height, and fit all five wave-62 kinds on desktop and phone.
Genuinely narrower containers may wrap without shrinking text. Clear spawns and Reset start
occupy a reserved tools row; Clear spawns is hidden when the wave has no placeable kinds. Otherwise
unavailable actions are disabled. The two-line caption below these tools and above the map explains
chip arming, direct spot picking, knocking down/restoring pillars and moving You. It keeps the same
height for the workbench's "Unplaced monsters spawn at random." note on a partial layout. The workbench reserves two composition
lines and a chip row even on fixed-spawn waves; wave 69 uses a same-size fixed-arena placeholder.
Changing selections, placement, pillars, player start or wave never moves the map or footer.

There are no map modes, trays, legends or duplicated pillar checkboxes. Tap a placed monster to replace it, swap it with a specifically
named occupied spot, or remove it. Clear spawns returns to random. Every placement is saved as the
layout at once, complete or partial: a partial layout's unplaced monsters spawn at random, which the
summary and the workbench caption say. There is no separate draft. Neither Start is blocked by partial placement. A custom layout
applies only to its own wave. Nibbler-only waves and waves 67–69 expose no spawn spots.
The spot picker has a muted header naming the selected spot. A small NPC keeps a faint dashed
4x4 spot boundary behind its true-size footprint, and the entire spot stays selectable. Expanded
44px invisible targets use nearest-target arbitration rather than DOM stacking order.

The map has north up, true 3×3 labeled Pillar/Down terrain, and a true 1×1 player frame with attached You.
Its drawing bounds include a two-tile margin on every side (x15..47, y15..48), keeping the west pillar
away from the frame without changing its position. Pointer projection uses these drawing bounds;
the start-tile validator rejects the decorative margin outside the playable arena.
`arenaMapImage.ts` owns those bounds and the cache-derived terrain underlay's URL. Image, terrain,
player and spot projection share that contract. The image is a text-free decorative layer; labels
and named monster tiles keep their own opaque backgrounds above it.
The decorative grid uses one-tile lines over playable tiles x17..45 / y17..46 only, leaving the margin
clear. Its SVG shares the same projection, snaps edges crisply, and keeps strokes at one screen pixel
as the diagram scales. It takes no pointer events and sits below every marker. Pillars use their entire
3×3 footprint: a solid square standing, an unfilled muted dotted square down, distinct from dashed spawn spots. Only the label keeps a small
opaque text backing in the down state.
Tap a pillar to toggle it; tap bare floor to move You, as the single caption explains. Reset start enables
only when moved. The terrain anchors are west `[17,37]`, south `[27,23]`, north-east `[34,39]`.
Landscape windows keep the map beside their title, progress and actions. Fresh start defaults are
`[34,44]` on waves 2–68; wave 1 landing and wave 69 start are fixed. Restarts keep where the player stood.

The map itself is shared (`src/components/SpawnLayoutMap.tsx`, its plane math in `spawnMapGeometry.ts`):
the encounter supplies the drawing bounds, terrain, named spots, spot size, kind labels and sizes,
obstacles (pressable only with a toggle handler) and whether the start moves; the map owns chips,
arming, the spot picker, nearest-target arbitration and floor taps. The Fortis Colosseum's **Wave &
modifiers** rail puts the same **Edit layout** row under its start-wave text for waves 1–11 (none
for a direct Sol start). Its map is the waves floor drawn tile by tile (x16..48, y18..51, no image),
the four pillars as fixed squares, the 12 spawn points as 3×3 spots and the start tile, which any
floor tap moves. The chips are the start wave's initial monsters only. Clear spawns and Reset start
work as the Inferno's. A placement the game would not make from the start tile
(`colosseumSpawnLayoutWarnings`) rings each such point in the warning color, adds a note to its
name, and shows a warning box under the map; the summary row adds "Not possible in game". It never
blocks the layout. The footer line names a custom layout ("Waves 4–12 · Custom layout · 2 modifiers"),
as the Inferno's does. Practice has no layout editor: as in the Inferno, the top chrome's **Edit
layout** workbench (`ColosseumLayoutTool`) edits the start wave, its layout and start tile, with the
same warning under its map. It opens on a copy of the wave being fought (the snapshot's
`runSetup.waveSpawnLayout` and the tile its points were drawn from), unsaved until edited or started;
**Start wave M** saves it and sends `go-to-wave`, which keeps the run's seed for the wave being fought
and draws new ones for another. Practice's start-wave control says a saved change is waiting for a
restart whenever the start wave, the layout or a moved start tile differs from the run's own
(`colosseumRunSetupKey`, from `runSetup.startSpawnLayout` and `startPlayerTile`). Restart fight and
Ctrl+R start the saved setup with new seeds: a saved layout and tile repeat, random spawns stay random.

`hasFooterActions` reserves a single `actionFooter` destination in the configurer. The encounter portals
Include gear and Copy link there; shared hosts have no Inferno switches. Copy link immediately copies
the setup, without a share dialog, source selector or paste/import UI. Incomplete setup disables copy
until finished or cleared on both surfaces. On desktop the share group stays anchored after Close;
the flexible space belongs between sharing and the start summary. Copy sizes to content, never wider
than the primary action, including on touch phones. All encounters have the generic Restart fight footer. It marks Ctrl+R only while that key restarts the
fight: a practice session (a replay practice tick, or Inferno's Retry wave) takes the key otherwise.
The rail supplies `exportGear` from its selected equipment, inventory and supplies through the
portable serializer, including unsaved gear edits without creating a preset. Export runs only when
copying with Include gear checked (on by default). Practice never exports depleted live supplies. A gear-free
link opens setup; a gear-bearing link auto-starts. Link boot and auto-start are owned outside the configurer.

The Inferno shares its wave and arena controls between surfaces. Ten Wave shortcuts (monster firsts,
checkpoints 50 and 63, and Zuk's 69) are grouped immediately with the wave field. They start collapsed,
remembering separate rail/practice choices under `inferno-rail-shortcuts-expanded` and
`inferno-practice-shortcuts-expanded`, independently of `practice-options-expanded`. Opening them never
executes; a jump never forces them closed. Practice's composition is inside this disclosure to keep the
immediate command compact. Pillars are edited only in Arena, not duplicated in Options. The landmarks use the card's single-choice chip recipe
in the rail and the Practice pane's inset segments there. They stay in wave order, in two complete
rows of five on a wide rail and five rows of two on narrower rails, desktop Practice and the Mobile
Tools Wave page. The disclosure itself labels the Practice list, without a repeated heading.
Checkpoint 50 reads "M + R" (Mager and ranger), the first wave with both and a common practice start;
63 reads "Hard" (Hard wave), described as one of the hardest waves to solve, not definitively
the hardest. These are practice destinations only, separate from the replay monster milestones.
The rail adds where the run goes ("Continues
through to wave 69.", or "The final wave of the Inferno." on 69). Waves 67 and 68 omit pillar marks,
so their pillar footprints are selectable floor; wave 69 has no editable map. Typing and stepping only save the start wave; Enter
or Go saves and starts it through `run.execute`, and a landmark does both at once mid-run. Go is
always visible beside the field when Practice has an actionable `run`, including when the setup matches.
It starts a fresh run, never exact-state Retry. Its accessible name identifies the wave and whether
that restarts the current wave; the hint explains the fresh run with saved setup. The command pair
stays together with a separated, minimum 44px Go target; narrow hosts wrap the label above it.
Typing, stepping and blur never execute. Automatic progression changes the current stage, not the
saved start wave, and is not described as an unsaved change. Pending pillars compare the saved key
with `run.startedWith`, never live pillars. On waves with pillars, the always-visible message reads
"Setup saved. Press Go to start wave N with it." It survives collapse and remount,
clearing when the run reports the matching start setup. Tile-only changes use the same message.
Current waves without pillars ignore those saved marks for pending-state purposes. A saved destination without pillars
still disables the marks, since Go applies that destination's setup.

Practice Options follows `run.stage`, never the saved start-wave destination: waves 1–68 offer
"Practice aids"; wave 69 offers "Zuk & aids", without a duplicate pillar section.
Zuk's health and Start / Pre-Jad / Pre-Healers commands lead while his boss is present.
The Zuk section and the Zuk-only actions (in the Actions palette and Mobile Practice) appear only on
current wave 69. General aids and wave navigation remain available throughout. Encounter-authored
`visibleInPractice` predicates on toggles and actions govern this presentation in the shared settings
list, Mobile Practice's pages and the Actions palette, through the one `visibleInPractice` filter in
`MechanicsSettings`; they never reset config, execute commands, or change Options expansion. Their
context's `config` is the saved settings, which a run may not have applied; a rule about what the
run is doing reads `encounterSnapshot`, the run's published state (Inferno's Random Spawns and Lock
Layout actions, which therefore always offer the same restart as its session bar).
Stage changes also refresh the desktop section-navigation stops. This stage-dependent Zuk group
placement applies to Practice only; the preparation rail keeps all deferred Zuk controls.

## Named toggle sections

A `MechanicsToggleInfo` may name a `section`: controls that belong to one part of the fight rather
than to the whole of it. The Inferno files all of TzKal-Zuk's controls (shield direction, attacks,
sets, set timer, safe tiles) under `TzKal-Zuk`. A section overrides its members' `setup` and
`group` placement. The configurer lists each section after Mechanics and before Practice aids, with
the Mechanics seam and a section head; Practice lists it inside Options in the same position, as its
own section-nav stop, and names it in the Options summary unless the encounter contribution supplies
the combined summary. A deferral every
member shares (`appliesLater`, "From wave 69") is stated once at the head and omitted from the rows;
it clears when it no longer applies. The rail keeps that stable placement; Practice may filter a
section's members by their encounter-authored current-stage visibility.
