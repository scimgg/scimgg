# Third-party notices

This project's own code and documentation are licensed under the MIT license ([LICENSE](./LICENSE)).
The MIT license covers the contributors' own work. It grants no rights in anything the contributors
do not own. This file covers the material that is not, or not only, under that license: data under a
separate license, code adapted from other projects, the two committed third-party binaries, npm
dependencies, and the game content that `npm run setup` downloads but this repository does not
contain.

| Material | Where | Terms |
|---|---|---|
| This project's own code and documentation | The contributors' own parts of the repository | MIT |
| [OSRS Wiki-derived data](#osrs-wiki-derived-data) | `src/data/osrs/*.json` and the other files listed there | CC BY-NC-SA 3.0 |
| [Code and data adapted from other projects](#code-and-data-adapted-from-other-projects) | The files listed there | ISC, MIT, BSD-2-Clause or public domain |
| [Committed binaries](#committed-binaries) | `public/bzip2.wasm`, `public/bzip2-module.js` | MIT (Foxglove, Emscripten, musl), the bzip2 license, and the LLVM runtime license |
| [npm dependencies](#npm-dependencies) | Installed by `npm ci` | Each package's own license |
| [Downloaded by setup](#downloaded-by-npm-run-setup) | Git-ignored paths | Jagex's terms; RuneLite's BSD-2-Clause for the health bars |
| [Game text and trademarks](#game-content-and-trademarks) | Throughout the source | Jagex Ltd's |

## Where the license texts are

[`scripts/vendoredNotices.ts`](./scripts/vendoredNotices.ts) holds the verbatim license text of
everything in the sections below that no package manifest records. `npm run build` writes this
project's own `LICENSE`, then those texts and the license of every production npm dependency, to
`dist/licenses.txt`. The
development server serves the same file at `/licenses.txt`, and the app's Credits dialog links to
it. The production minifier strips `@license` comments from the bundle, so `licenses.txt` is how
the notices that MIT and BSD require reach a built copy.

`npm run check:licenses` ([`scripts/check-licenses.ts`](./scripts/check-licenses.ts)), also the
first step of `npm run build`, checks the license each production dependency declares in its
`package.json`, and the license recorded for each entry in `vendoredNotices.ts`. It passes only
licenses on an allowlist of permissive SPDX identifiers and a few written exceptions. In a compound
expression every `AND` term must pass, and every choice (`OR`) must have a recorded election that
passes in its place. Anything it does not recognize, a malformed expression, a choice with no
recorded election, and a dependency with no license at all fail the build. A package that declares
nothing is rejected if its license file is one of a few restrictive licenses, and otherwise also
stops the build until someone reads the file and records an exception: the check never passes
undeclared license text unread. The check reads declarations,
not source: it cannot see code that was copied without a record. The rules and exceptions are in
[`scripts/licensePolicy.ts`](./scripts/licensePolicy.ts).

## OSRS Wiki-derived data

Licensed under [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/), not MIT:

- **`src/data/osrs/*.json`**. `equipment.json`, `monsters.json` and `itemAliases.json` are
  generated from the Wiki's item and monster data by
  [`scripts/sync-osrs-data.ts`](./scripts/sync-osrs-data.ts). `manualEquipment.json` is
  hand-written metadata for the pages the sync drops. `spells.json` is generated from the Wiki's
  spell articles by [`scripts/sync-osrs-spells.ts`](./scripts/sync-osrs-spells.ts); see
  [below](#spellsjson). [`docs/legal/data-provenance.md`](./docs/legal/data-provenance.md) records
  each file's fields and the changes made to them.
- **`src/data/playerPresets.ts`**: the loadouts that follow the Wiki's Inferno, Fortis Colosseum and
  Yama strategy guides, each citing its page. The file's other Inferno presets copy community
  players' published setups, each cited by screenshot and date, and are not Wiki-derived.
- **`src/data/tilePackPresets.ts`**: the Donofly and Yama Mage Contract tile packs, taken from the
  Wiki's Yama strategy page and its tile-marker module.
- **The values transcribed from Wiki tables** in `src/data/spellRunes.ts` (rune costs),
  `src/data/itemEffects.ts` (food and potion effects) and `src/types/simulation.ts` (the prayer
  table's drain effects and stat boosts, and its conflict groups), each citing its article.

Elsewhere, Wiki articles are cited as evidence beside the code that implements individual mechanics.

**Attribution.** This project contains data derived from the
[Old School RuneScape Wiki](https://oldschool.runescape.wiki/), by
[its contributors](https://oldschool.runescape.wiki/w/Old_School_RuneScape_Wiki:Contributors),
licensed under CC BY-NC-SA 3.0. The data has been selected, renamed and restructured; the changes
are described in `docs/legal/data-provenance.md`.

**What this means for a fork.** The MIT license covers the code around this data. It does not
relicense the data. Anyone who redistributes these files, or an adaptation of them, must credit the
Wiki, may not do so for commercial purposes, and must share adaptations under the same license. A
commercial fork must remove or replace this data first.

### `spells.json`

Rebuilt from the OSRS Wiki (CC BY-NC-SA 3.0) on 2026-11-24 by
[`scripts/sync-osrs-spells.ts`](./scripts/sync-osrs-spells.ts). Every field of all 48 spells,
including the Ancient Magicks secondary effects, is read from the spell articles and the Wiki's
spell-family pages. The pages, revisions and simplifications are in
[`docs/legal/data-provenance.md`](./docs/legal/data-provenance.md#spellsjson).

## Code and data adapted from other projects

These licenses are permissive, but all except the public-domain dedication require their copyright
notice to accompany copies. Each adapted file names its upstream in a comment.

| Upstream | License | Used in |
|---|---|---|
| [RSMod](https://github.com/rsmod/rsmod/tree/fa13b3f67172ef36e15d6b1514358aee61411796) | ISC | `npcRouteFinding.ts`: a simplified TypeScript port of `RouteFinding.kt` for NPC melee pursuit. NPC retaliation, action clock and pursuit semantics in `src/core/combat/` and `src/core/npc*.ts`. Player teleport and action-lock semantics in `src/core/SimulationEngine.ts`. |
| [2004Scape Server](https://github.com/2004Scape/Server/tree/647886c42f8a22c0f18e5dbe79c2697f052f8d2e) (Lost City) | MIT | The same NPC retaliation, action clock and pursuit semantics. |
| [rs-map-viewer](https://github.com/dennisdev/rs-map-viewer/tree/ce2278728ba4b7c9155ac9cf7c936438eef11ad0) (dennisdev) | BSD-2-Clause | In `src/rs/`: the cache, model, animation, map and sprite decoders. Also `PicoTexture.ts`, `LocAnimated.ts`, `TerrainBuilder.ts` and the `RenderViewport3D` camera setup. |
| [RuneLite](https://github.com/runelite/runelite/tree/ced4c4aba7a3cb7cace42e1f0c25a5f79b7faef2) | BSD-2-Clause; see below for the holders | `Projection3D.ts` (from `Perspective.java`, and the zoom limits of `CameraPlugin.java` and `CameraConfig.java`), `FacePrioritySorter.ts` and `splitMeshByAlpha.ts` (`FacePrioritySorter.java`, `IntProjection.java`), `npcPick.ts` (`Perspective.java`), the `PicoGLRenderer.ts` blend and sort rules (`GpuPlugin.java`), the scene shaders' texture-animation and alpha handling (`vert.glsl`, `frag.glsl`), `textureUv.ts` (`ModelDefinition.java`, `SceneUploader.java`), `CollisionFlag.ts` (`CollisionDataFlag.java`), `prayerFlickOrb.ts` (`PrayerFlickOverlay.java`, `PrayerPlugin.java`, `PrayerConfig.java`), `distance.ts` (`WorldArea.java`, `CollisionDataFlag.java`), `StatusBars.tsx` and `statusBarsPaint.ts` (the Status Bars plugin's `StatusBarsOverlay.java`, `BarRenderer.java`, `Viewport.java` and `StatusBarsConfig.java`). |
| [weapon-animation-replacer](https://github.com/geheur/weapon-animation-replacer/tree/0312d8c5b9738b9774e8c7101c1ca1a2d1c1eaaf) (geheur) | BSD-2-Clause | `src/data/weaponCombatVisuals.generated.ts`: the per-weapon animation sets and projectiles, from its `data.json`. |
| [kotori-plugins](https://github.com/OreoCupcakes/kotori-plugins/tree/0e7c60f6dac45e6a68e673a45950c06c5891f393) `PlayerAttackAnimations.java` (Matsyir, Mazhar) | BSD-2-Clause (the file's own header) | The attack-animation names in the same generated file. |
| [Compact Orbs](https://github.com/its-cue/compact-orbs/tree/fd3678bc9ef569b5912bb707cfe1c38e012f2f0c) (cue) | BSD-2-Clause; its files' headers: (c) 2025, cue; its `LICENSE`: (c) 2025, its-cue | `src/types/compactOrbs.ts` and `minimapOrbGeometry.ts`: the compact orb layouts' names and the column-major slot order. Pinned at the last upstream commit before our file was written. |
| [Tile Packs](https://github.com/TrevorMDev/tile-packs/tree/fa48c15408c9dc86f1739c8d6def18d7a2fb19a6) (TrevorMDev) | BSD-2-Clause, Copyright (c) 2022, TrevorMDev | `src/data/tilePackPresets.ts`: the "Yama No Fly" pack (id 66 in its `tilePacks.jsonc`), recolored. |
| [RuneMarkers](https://github.com/jamiegyoung/runemarkers/tree/b6fb9d0b3aa5706662267c2bdf0b00d4113dd158) (Jamie Young) | MIT, Copyright (c) 2024 Jamie Young | `src/data/tilePackPresets.ts`: the Zuk Inferno pack, from its `entities/inferno.json`, recolored. RuneMarkers credits those tiles to the We Do Raids community's `!infernotiles` command, and the UNSAFE label to Brew Time. |
| [bryc/code `PRNGs.md`](https://github.com/bryc/code/blob/88c1317ea6f9b25c153afa9c369c365fed11b482/jshash/PRNGs.md#mulberry32) (Tommy Ettinger's Mulberry32) | Public domain (`PRNGs.md`); the original C is CC0 1.0 | `src/core/rng.ts`: `mulberry32`, hand-vendored. Both dedications are reproduced in `licenses.txt`. |

**RuneLite copyright holders.** RuneLite's repository license is Copyright (c) 2016-2017, Adam, but
most of its source files carry their own BSD-2-Clause header naming their own holders, and a port
is attributed with that header. Read at RuneLite `ced4c4a`:

| Upstream files | Header copyright |
|---|---|
| `Perspective.java`, `PrayerFlickOverlay.java` | (c) 2017, Adam |
| `FacePrioritySorter.java`, `GpuPlugin.java`, `SceneUploader.java`, `vert.glsl`, `frag.glsl` | (c) 2018, Adam |
| `IntProjection.java` | (c) 2024, Adam |
| `WorldArea.java`, `CollisionDataFlag.java` | (c) 2018, Woox |
| `PrayerPlugin.java` | (c) 2017, Adam; (c) 2018, Raqes |
| `PrayerConfig.java` | (c) 2018, Raqes |
| `CameraPlugin.java` | (c) 2018 Abex; (c) 2018, Adam; (c) 2019, Wynadorn |
| `CameraConfig.java` | (c) 2018 Abex |
| `StatusBarsOverlay.java`, `BarRenderer.java` | (c) 2019, Jos; (c) 2019, Rheon |
| `Viewport.java` (Status Bars) | (c) 2018, Jos |
| `StatusBarsConfig.java` | (c) 2019, Jos |
| `ModelDefinition.java`, the generated `SpotanimID.java`, the health bars | No header: the repository license |

`FacePrioritySorter.java` is read at `938f61e`, the revision current when it was ported; RuneLite
later renamed it `ModelUploader.java`. Every other header is the same at `ced4c4a` as at the
revision current when its file was ported. `licenses.txt` reproduces each header in full.

`weaponCombatVisuals.generated.ts` was generated from the two BSD-2-Clause projects above and
RuneLite's `SpotanimID.java`.

Both tile packs were checked tile for tile against the upstream file at the pinned revision, and
each license was read at that revision. The remaining packs in `tilePackPresets.ts` are the two
Wiki packs [above](#osrs-wiki-derived-data) and a tutorial lane of this project's own.

## Committed binaries

`public/bzip2.wasm` and `public/bzip2-module.js` are, byte for byte, `wasm/module.wasm` and
`wasm/module.js` from [`@foxglove/wasm-bz2`](https://github.com/foxglove/wasm-bz2/tree/v0.3.0)
0.3.0, which its `build.sh` builds with Emscripten 3.1.26. They contain:

| Component | Copyright | License |
|---|---|---|
| Foxglove's wrapper | Foxglove Technologies Inc | MIT |
| libbzip2 | (C) 1996-2010 Julian R Seward | The bzip2 license |
| Emscripten's runtime: the generated loader `.js`, and embind and the system stubs in the `.wasm` | Emscripten authors | MIT or NCSA; this project takes MIT |
| musl libc's stdio, string, math and ctype routines | (C) 2005-2020 Rich Felker, et al., and the holders its `COPYRIGHT` lists | MIT |
| LLVM's compiler-rt builtins, libc++ and the libc++abi demangler | The LLVM contributors | Apache-2.0 WITH LLVM-exception, plus the NCSA and MIT terms its `LICENSE.TXT` also carries |
| dlmalloc | Doug Lea | Public domain (CC0) |

The LLVM exception lifts the Apache license's notice conditions for portions embedded in compiled
object code. The LLVM notice is reproduced anyway, because the NCSA and MIT terms that the same
`LICENSE.TXT` carries have no such exception. Every license above except dlmalloc's is
reproduced in full in `licenses.txt`, from
[`scripts/vendoredNotices.ts`](./scripts/vendoredNotices.ts), so the binaries' attribution does not
depend on the npm package staying installed.

## npm dependencies

No production dependency is under GPL, AGPL or LGPL. Notes:

- **jszip** is `MIT OR GPL-3.0-or-later`. This project elects MIT; the election is recorded in
  `LICENSE_ELECTIONS` in [`scripts/licenseNotices.ts`](./scripts/licenseNotices.ts) and printed in
  `licenses.txt`.
- **pako** is `MIT AND Zlib`. Both bind, and both texts are reproduced: the zlib notice is read from
  the package's `lib/zlib/README`.
- **isarray** ships no license file. Its MIT notice (Copyright (c) 2013 Julian Gruber) is in its
  README's License section, which is where `licenses.txt` reads it from. A package with neither
  gets a pointer to its repository instead. On Linux x64 those are only the platform binaries of
  `esbuild` and `rolldown`, whose parent packages' notices are in the same file.
- **lightningcss** (MPL-2.0) is reachable from the production graph because `vite` is listed under
  `dependencies`. It is a build-time CSS transformer and none of its code is emitted into `dist/`.
- **sharp** and its libvips binaries (LGPL-3.0) are a devDependency used by setup and tests. They
  are not part of a build.

## Downloaded by `npm run setup`

None of the following is in this repository. `npm run setup` downloads each item to your machine
(the full game cache, the item icons and the health bars), checks it against a pinned size or
SHA-256, and writes it, and the files generated from it, to git-ignored paths. You download it
yourself, on the terms below; this project does not license or redistribute it, and the MIT license
does not cover it. A build made after setup (`dist/`) does not contain the full cache; it contains
the trimmed cache, the files setup generated from the cache, the item icons and the health bars, so
sharing such a build is subject to the same terms.

| Download | From, and how it is pinned | What setup makes from it | Terms |
|---|---|---|---|
| OSRS game cache 2772 | [OpenRS2 Archive](https://archive.openrs2.org/), size and SHA-256 in [`scripts/pinnedCache.ts`](./scripts/pinnedCache.ts) | The trimmed cache the browser loads, interface sprites (recipes in [`scripts/assets/sprite-manifest.json`](./scripts/assets/sprite-manifest.json)), the bitmap fonts as TTFs, the Inferno arena map and its test fixture | Jagex's game data. OpenRS2 archives the cache; it does not license it. The TTF writer and sprite compositor are this project's code. |
| Item icons | `static.runelite.net/cache/item/icon/<id>.png`, SHA-256 per icon in `scripts/item-icon-manifest.json` | Used as downloaded | Jagex's item art, as rendered and hosted by RuneLite. RuneLite publishes no terms for that endpoint that this project found. |
| Health bars | [RuneLite](https://github.com/runelite/runelite/tree/ae11244136b396dcbf976b38974a3877bbe62cd6) `interfacestyles/2010/healthbar/`, SHA-256 per file in [`scripts/assets/runeliteHealthbars.ts`](./scripts/assets/runeliteHealthbars.ts) | The originals, and two recolors of them | RuneLite's BSD-2-Clause, Copyright (c) 2016-2017, Adam, reproduced in `licenses.txt` under RuneLite. They were drawn to match Jagex's RuneScape HD bars ([runelite#13798](https://github.com/runelite/runelite/pull/13798)). |

Jagex's terms for its game and content are its
[Terms and Conditions](https://legal.jagex.com/docs/terms/terms-and-conditions.md) and its
[Fan Content Policy](https://legal.jagex.com/docs/policies/fan-content-policy.md). This project
claims no license or permission from Jagex.

### Sound

No standalone sound recordings are committed or fetched separately. `src/audio/synth/` renders
sound effects at runtime from the sound data in your cache. It was written independently, from the OSRS Wiki's
[Audio](https://oldschool.runescape.wiki/w/Audio) article (the synth's structure, as facts), RuneLite's
BSD-licensed sound-effect cache loaders (to corroborate the byte layout), general signal-processing
knowledge, and black-box comparison of its output. The
[clean-room statement](./docs/architecture/audio-synth.md#clean-room-statement) lists the sources
and what was not consulted.

## Game content and trademarks

Game names, item and NPC names, chat messages and boss dialogue in the source are Jagex's, quoted
so that the simulator matches the game. The mechanics data and test fixtures record facts
extracted from private gameplay captures, plus ids and values read from the game cache.

RuneScape and Old School RuneScape are trademarks of Jagex Ltd. This is an unofficial fan project.
It is not affiliated with or endorsed by Jagex Ltd.

## Audit records

- [`docs/legal/data-provenance.md`](./docs/legal/data-provenance.md): where each dataset comes from.
