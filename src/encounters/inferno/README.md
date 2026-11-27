# The Inferno (waves 1–69)

One encounter, kind `inferno`, for the whole run: the ordinary waves 1–68 and then TzKal-Zuk on
wave 69, in one engine and world. All 69 waves are playable, with the evidence gaps the docs below
record (the module is marked `isWorkInProgress`).

- Evidence: [facts spec](../../../docs/encounters/inferno-facts-spec.md)
- Simulator policy, including practice behavior, the [seeds](../../../docs/encounters/inferno-policy.md#seeds)
  and the [68 → 69 transition](../../../docs/encounters/inferno-policy.md#wave-69-transition):
  [policy](../../../docs/encounters/inferno-policy.md)
- Unexplained observations and unsupported rules:
  [open questions](../../../docs/encounters/inferno-open-questions.md)
- Wave 69: [`../zuk/`](../zuk/README.md)

## Code map

| File | Owns |
|---|---|
| `InfernoEncounter.ts` | Wave director (first wave per `startWaveDelayTicks`, completion on the last removal, next wave +6, 68 → 69 intro), pillar lifecycle, corpse ledger, every ordinary spawn, seeds (`getSeeds`/`reset`), practice restarts (`planPracticeRestart`, `planRestartStart`); the engine hooks, handed to wave 69's director once it starts |
| `constants.ts` | Tiles, delays and fitted bands (landing tile, practice start tile, spawn slots, Jad and healer placement) |
| `waves.ts` | Wave table 1–68 and batch spawn order |
| `layout.ts` | Seeded per-`(runSeed, wave)` layout and nibbler-pillar streams, the NPC decision seed (`npcDecisionSeed`) and streams, Jad healer tiles |
| `controls.ts`, `commands.ts` | Run setup keys and `resolveInfernoRunSetup`; one control set (start wave 1–69, destroyed pillars, then wave 69's mechanics and boss-HP phases); the Retry / Lock layout / reroll commands and `infernoSecondaryRestart` |
| `practiceChrome.ts` | The session bar's wave title and restart buttons, read from the run's snapshot |
| `startTile.ts` | The practice start tile for waves 2–68 (`infernoStartTile`, its default and validation) |
| `spawnLayout.ts` | Custom spawn layouts (`infernoSpawnLayout`) and the setup link's parameters (`INFERNO_SETUP_PARAMS`), Inferno Stats compatible |
| `setupLink.ts`, `setupLinkNotice.ts` | What a setup link at boot asks for (setup, gear, auto-start) and its one-shot notice; the hooks are `useInfernoSetupLink` and `useInfernoSetupQuery` (`src/hooks`) |
| `InfernoSetup.tsx`, `InfernoSpawnSetup.tsx`, `SpawnLayoutMap.tsx`, `InfernoLayoutTool.tsx` | The setup card and Practice pane controls, the spawn-layout editor and its arena map |
| `arenaMapImage.ts` | The static terrain image of the arena (`public/assets/encounters/inferno-arena-map.webp`, from `scripts/generate-inferno-arena-map.mts`) and its tile-to-pixel mapping |
| `waveInfo.ts` | Presentation facts about waves: monster names, compositions, milestones |
| `pillars.ts` | Rocky supports: proxy (7709) and collapse (7710) definitions, runtime collision |
| `spawners.ts` | One spawn path per species, and the registrations wave 69 shares (Jal-Zek, Jal-Xil, JalTok-Jad, Yt-HurKot) |
| `renderConfig.ts`, `sceneObjects.ts` | Every Inferno NPC type and graphic; the standing pillar LOCs and the alcove's walls and static glyph, by stage |
| `snapshot.ts` | The published snapshot types |
| `replayChapters.ts` | A replay's waves as chapters |

Species definitions live in `src/npcs/inferno/`.

## Notes for reading the code

- **Run setup** is mechanics (`infernoStartWave`, the three destroyed-pillar keys,
  `infernoSpawnLayout`, `infernoStartTile`, the run-only `infernoPinnedWave`, `zukShieldStart`; the
  encounter's `runStartMechanicsKeys`), applied by `configureRunStart` before the world is built and
  on tick-zero edits. A start wave the mechanics do not name is `INFERNO_DEFAULT_START_WAVE`, wave
  69, so an engine built without mechanics opens on Zuk; tests that mean wave 1 name it.
- **Restarts** are answered by `planPracticeRestart` with run-only `runMechanics` overrides, optional
  `encounterSeeds` and an optional start position (`restartStart`); the wiring
  (`useSimulationWiring`) performs them. The snapshot's `startPlayerTile`, `startSpawnLayout` and
  pillars feed the changed-since-start key (`infernoRunSetupKey`); `pinnedWave` stays out of it and
  out of the setup link. What each restart does is the
  [policy's restart table](../../../docs/encounters/inferno-policy.md#restarts).
- **68 → 69** (`advanceZukIntro`, `ZUK_INTRO`): busy C-12..C is an engine action lock, taken by
  `onTickStart` at C-12 with `lockPlayerActionsUntil(C + 1)`; the teleport at C-10 is
  `teleportPlayer`; the actors arrive at C-8 and start the director.
- **Stage-owned behavior** dispatches on the director: NPC contexts, movement, removal, hazards,
  outcome (won on Zuk's defeat) and Zuk's `encounter: 'zuk'` commands. One registration per
  definition; a Jad's healers follow their parent's type, and wave 69's magers never resurrect.
- **Snapshot**: `state.wave`/`phase`, `state.zuk` (wave 69's fight state from the tick its actors
  arrive) and `visuals.zukControlTick`, which the scene controller turns into the alcove's state.
- **Pillars** are baked into the cache collision as dynamic locs; `refineArenaConfig` and the
  encounter's own reinstall open a collapsed one. Proxies spawn on tick 1, after the tick-0 setup.
  Collapse damage goes through the victims' hit queue (`queueNpcHit`).
