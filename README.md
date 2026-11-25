# Scim.GG: OSRS combat simulator

A browser-based Old School RuneScape combat simulator for practicing hard boss encounters with
tick-accurate mechanics and instant resets.

> [!IMPORTANT]
> **This is the open-source release of Scim.GG.** It is published under the MIT license, with the
> [exceptions listed under License](#license), so that anyone can fork it. Issues and pull requests
> are welcome: read [CONTRIBUTING.md](./CONTRIBUTING.md) first. If you build on it, publish your
> fork under **your own name** and [credit Scim.GG in your README](#if-you-build-on-this); the
> Scim.GG name is not part of the license.

## What is in it

- **Encounters:** Yama phase 3, including the Forfeit Breath, Glyphic Attenuation, Sensory
  Clouding, Divine Severance and Bloodied Blows contracts; Sol Heredit (Fortis Colosseum wave 12)
  with its modifiers; the Inferno, with TzKal-Zuk on wave 69; and a practice lobby.
- An equipment and inventory loadout planner with presets.
- Prayers, quick prayers and a flicking metronome.
- Tile markers, NPC highlights, anti-drag and other RuneLite-style plugins.
- Guided tutorials.
- Local replay recording and playback, with seeking and practice takeover.

Everything runs locally in the browser.

## What is not included

There is no backend: no accounts, cloud sync or replay sharing. Settings and loadouts are saved in
the browser's local storage, and replays are recorded and played back locally. Replays cannot be
saved to a file or shared.

## Evidence first

The point of this project is **accuracy**. Timings, attack patterns, projectiles, animations and
formulas are built from evidence: recordings of the real game, the OSRS Wiki's articles and
formulas, Jagex's own statements, and the game cache. Sources are cited beside the code, and
observed facts are pinned by tests. A simulator that teaches the wrong timing is worse than none.

Where the evidence runs out, that is written down rather than hidden. Each encounter's notes in
[`docs/encounters/`](./docs/encounters/) separate what was measured from what was extrapolated or
chosen as a policy; [`sol-heredit-unverified.md`](./docs/encounters/sol-heredit-unverified.md) is a
good example. A test that pins a policy only proves the simulator is consistent, not that the game
behaves that way.

If you extend it, keep that standard. **Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you add or
change a mechanic.** It covers what counts as evidence, how to record it, and the source rules every
change must follow.

## Getting started

You need Node.js 24 (recommended; 22.13 or newer also works), a few GB of free disk space (about
1 GB for npm dependencies and the downloaded game cache, plus build output and any test browsers),
and an internet connection for the one-time setup.

```bash
npm ci
npm run setup   # one time: downloads the game cache and builds the game assets
npm run dev     # open the Local URL Vite prints (normally http://127.0.0.1:5173)
```

The npm scripts are the canonical commands. In a Bash-compatible shell, the optional `./dev` script
is a shortcut for the common ones: `./dev` starts the dev server, `./dev harness` opens the [UI test
harness](./docs/testing/ui-harness.md), and `./dev check` runs the type, lint and license checks.
`./dev --help` lists them all.

### Why there is a setup step

No Jagex game assets are committed. `npm run setup` downloads them onto your machine from public
sources and builds the files the app needs into git-ignored paths:

| Download | From | Checked by |
|---|---|---|
| OSRS game cache: OpenRS2 cache ID 2772, game build 242 (about 203 MB) | [OpenRS2 Archive](https://archive.openrs2.org/) | size and SHA-256 |
| Item icons | RuneLite's static icon host | SHA-256 per icon |
| Health bar images | RuneLite's GitHub repository, at a pinned commit | SHA-256 per file |

From the cache, setup generates the interface sprites, the bitmap fonts, the Inferno arena map and
test fixture, and a trimmed cache that the browser loads. Sound effects are not files at all: an
independently written synthesizer renders them at runtime from the cache's sound data (see
[`docs/architecture/audio-synth.md`](./docs/architecture/audio-synth.md)). It sounds close to the
game, but not identical.

The first run takes a couple of minutes. Useful flags:

- `npm run setup -- --check` reports what is missing or out of date, without downloading anything.
- `npm run setup -- --offline` rebuilds without touching the network. It only works after an
  earlier successful run, because it needs the cache in `.setup-cache/` and the icons and health
  bars already in `public/assets/`.
- If OpenRS2 ever stops serving cache 2772, put a copy of that cache's `disk.zip` at
  `.setup-cache/openrs2-2772-disk.zip` and run `npm run setup` as normal. It uses your copy instead
  of downloading one, but still needs the network for the icons and health bars on a fresh clone.
  Setup refuses any file whose size or hash doesn't match the pin.
- If RuneLite re-renders an icon, the hash check fails and lists it. Run
  `npm run setup -- --accept-changed-icons` to take the new version.

Without setup the app still starts, but interface art, fonts and models are missing.

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | Download and build the game assets (above) |
| `npm run dev` | Development server |
| `npm run build` | License check, asset check, a production build in `dist/`, then a check of the trimmed cache it ships |
| `npm run preview` | Serve the production build |
| `npm test` | The full Vitest suite |
| `npm run typecheck` | `tsc -b` |
| `npm run check` | Biome format and lint (writes fixes) |
| `npm run check:lockfile` | Checks that every package in `package-lock.json` is a published version from the npm registry with a sha512 integrity hash; CI runs it before installing anything |
| `npm run check:cache-runtime` | Optional, and takes minutes: runs the simulation and render loaders against the trimmed cache from `npm run setup`, failing on any archive they read that the trim left empty or production cannot decode (`CACHE_RUNTIME_TRIMMED_DIR=dist/osrs-cache` checks a build instead) |

`npm test` passes on a fresh clone without setup: tests that need generated assets skip with a
message. Set `SCIM_REQUIRE_SETUP=1` to make those skips fail instead. Some suites also need the
older OpenRS2 cache 2437, which their expected values were recorded on, at `.test-cache/disk.zip` or
the path in `SCIM_REAL_CACHE_PATH`. They skip without it, and their skip message says where to
download it; set `SCIM_REQUIRE_REAL_CACHE=1` to make that skip fail instead.

If you run your own copy:

- Run `npm audit` and update the dependencies before relying on them.
- Deploy only the built `dist/` directory, from a static host over HTTPS, never the dev server.
- `npm ci` deliberately skips the Chrome that the optional browser checks use. Install it with
  `npx puppeteer browsers install chrome` if you need it.

## Documentation

- [CONTRIBUTING.md](./CONTRIBUTING.md): the evidence standard, source rules and how to build an
  encounter.
- [AGENTS.md](./AGENTS.md) and [`docs/agent-reference.md`](./docs/agent-reference.md): project rules
  for people and coding agents, including coordinates, testing and UI safeguards.
- [`docs/architecture/`](./docs/architecture/): actors, combat, events, rendering, audio and
  encounters.
- [`docs/encounters/`](./docs/encounters/): the evidence, open questions and policies behind each
  encounter.
- [`docs/research/`](./docs/research/): sourced notes on individual weapons, spells and their
  presentation.
- [`docs/testing/`](./docs/testing/): the UI harness and the replay fixtures the capture-conformance
  tests read.
- [`DESIGN.md`](./DESIGN.md): the visual design system.
- [SECURITY.md](./SECURITY.md): how to report a vulnerability privately.

## License

This project's own source code and documentation are [MIT](./LICENSE), copyright Scim.GG
contributors. The MIT license covers the contributors' own work. It grants no rights in anything
the contributors do not own. These exceptions apply:

- **OSRS Wiki data.** `src/data/osrs/*.json` and the other files listed in
  [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) are derived from the
  [Old School RuneScape Wiki](https://oldschool.runescape.wiki/) and licensed under
  [CC BY-NC-SA 3.0](https://creativecommons.org/licenses/by-nc-sa/3.0/). Its **non-commercial** and
  share-alike terms apply to those files and to anything built from them.
- **Vendored third-party code and data** keep their own licenses, listed in
  [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md). That includes the parts of `src/rs/` adapted
  from rs-map-viewer under its BSD-2-Clause license, and the committed bzip2 binaries.
- **Game content.** RuneScape and Old School RuneScape are trademarks of Jagex Ltd. Game names and
  text, the game cache and everything setup generates from it, and the item icons, belong to
  Jagex. This is an unofficial fan project, not affiliated with or endorsed by Jagex.
- **Downloaded files** stay under their own terms and are not covered by this repository's
  license. That includes the health bar images, which come from RuneLite's repository under its
  BSD license. [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) lists each download's terms.

### If you build on this

The MIT license requires you to keep the copyright and permission notice in [LICENSE](./LICENSE)
with any copy of this code, and the third-party notices keep their own terms. Beyond that, we ask
that any project built on this one says so in its README, for example:

> Based on [Scim.GG](https://github.com/scimgg/scimgg), an open-source OSRS combat simulator (MIT).

Give your project its own name, and do not present it as Scim.GG or as its continuation.
