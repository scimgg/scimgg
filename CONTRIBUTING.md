# Contributing to Scim.GG

Issues and pull requests are welcome. This guide is for anyone changing the code, here or in a fork.
It explains the standard the existing encounters were built to, and the rules that keep the code
accurate and legally clean. Report bugs and inaccurate mechanics with the
[issue forms](https://github.com/scimgg/scimgg/issues/new/choose), and security vulnerabilities
privately as [SECURITY.md](./SECURITY.md) describes.

## The evidence standard

**No mechanic without evidence.** Every attack pattern, tick timing, projectile delay, movement
rule, damage formula, animation and sound in an encounter must trace back to a source you can cite.
Memory, intuition and "it felt right in game" are not evidence. A simulator exists to build muscle
memory, and teaching a player the wrong timing does real harm.

### What counts as evidence

In order of authority:

1. **Observations of the real game.** The committed capture fixtures hold tick-exact ids, timings
   and positions extracted from private gameplay captures, cited by file name. For
   observed behavior they outrank every other source.
2. **Jagex's own statements:** official posts, dev blogs, and replies from Jagex staff.
3. **The [OSRS Wiki](https://oldschool.runescape.wiki/):** article text, infobox stats and formula
   pages. Its data is CC BY-NC-SA; see [License](#license).
4. **The game cache:** ids, animation and graphic definitions, model and sound data. `npm run setup`
   downloads a pinned copy.
5. **Permissively licensed implementations**, used only to corroborate what the sources above
   show (see [Source rules](#source-rules)).

Frame-stepped video can support a claim, but it rarely settles tick timing on its own.

### How to use it

- **Separate observation from rule.** One capture shows what happened once. Check a proposed rule
  against every relevant recording, including variants such as Yama's contracts, and explain any
  disagreement instead of picking the convenient example.
- **Write down what you don't know.** When the evidence can't settle a question, record it as an
  open question, choose an explicit policy for the simulator, and say that it is a policy. Never
  fill a gap by guessing or by reading a forbidden source.
- **Cite beside the code.** Put the source next to the constant or branch it justifies: a capture
  name and tick, a Wiki URL, a cache id. A future reader must be able to check every number.
- **Pin it with a test.** Extract the facts a mechanic depends on (ticks, ids, relative tiles,
  delays, damage) into a fixture next to the test, with a header naming the source, and assert that
  the simulator reproduces them. Then break the behavior on purpose and confirm the test fails.
  The `__tests__/fixtures/*Capture.ts` files throughout `src/` show the pattern.

Each encounter keeps its reasoning in [`docs/encounters/`](./docs/encounters/), in up to three
kinds of file:

- a facts spec, `<encounter>-facts-spec.md`: the sourced facts
- a register of what the evidence does not settle, usually `<encounter>-open-questions.md` (Sol
  Heredit's is `sol-heredit-unverified.md`, which lists the implemented behavior the captures do
  not establish)
- a policy, `<encounter>-policy.md`, where the simulator had to decide past the evidence

Keep these up to date as part of the change, not afterwards.

### Gathering new evidence

The captures cited across this codebase are private gameplay captures; only the facts extracted
from them are committed, in the test fixtures. To check a mechanic they do not
cover, use sources that need no access to the game's network traffic:

- **Gameplay video**, frame-stepped against the 0.6 s tick, for sequences, positions and relative
  timing
- **The [OSRS Wiki](https://oldschool.runescape.wiki/)**: article text, infobox stats and formula
  pages
- **Jagex staff statements**: official posts, dev blogs and replies
- **The game cache**: ids, animation, graphic, model and sound definitions
- **[RuneLite](https://github.com/runelite/runelite)** (BSD-2-Clause) for behavior the client
  shows, such as overlays, health bars and interface state

Weigh each against the committed fixtures with the checklist in
[`docs/agent-reference.md`](./docs/agent-reference.md#capture-fixtures). When a source yields
measured facts a test depends on, extract the minimal reviewed facts into a fixture next to the
test, with a header naming the source, as described in [How to use it](#how-to-use-it).

**Never commit raw recordings** of any kind. They can contain account names, chat, other players'
names and session data. Commit only the extracted facts, and check fixtures for names and chat
before you commit them.

## Source rules

- **Allowed:**
  - OSRS Wiki prose and formula pages
  - [RuneLite](https://github.com/runelite/runelite) (BSD-2-Clause)
  - the game cache
  - code under a verified permissive license (MIT, ISC, BSD, Apache-2.0), once you have checked
    the license **at the revision you read, before you read it**
- **Forbidden:**
  - OSRS code under GPL, AGPL, LGPL, MPL or another copyleft license, a restrictive
    source-available license, or no license. This includes calculators and other tools that
    implement OSRS formulas; the Wiki's formula *articles* are fine.
  - decompiled or deobfuscated game clients, including projects ported from them, whatever license
    they claim
- **Write it yourself.** Use permitted implementations to confirm behavior, not as templates.
  Implement independently through this codebase's existing structure. If copying really is
  unavoidable, record it in [`scripts/vendoredNotices.ts`](./scripts/vendoredNotices.ts) and keep
  the original license notice.

The full policy is in
[`docs/agent-reference.md`](./docs/agent-reference.md#source-policy). The sound
synthesizer is an example of the clean-room approach the policy expects:
[`docs/architecture/audio-synth.md`](./docs/architecture/audio-synth.md).

## Keep game assets and private data out of the repository

- **Game assets** (sprites, sounds, fonts, models, renders) must not be committed, whether they come
  from the cache or the Wiki. Generate them at setup instead: interface art is described by
  [`scripts/assets/sprite-manifest.json`](./scripts/assets/sprite-manifest.json), and
  [`scripts/setup.ts`](./scripts/setup.ts) builds everything into git-ignored paths.
- **Personal data** (account names, chat, private links, other people's usernames) never goes in.
- **New Wiki-derived data** must be attributed in
  [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).

## Building an encounter

1. Read [AGENTS.md](./AGENTS.md). Its coordinate rule matters most: simulation, world and render
   coordinates are identical, and axes are never flipped.
2. Read [`docs/architecture/encounters.md`](./docs/architecture/encounters.md) and
   [`scene-objects.md`](./docs/architecture/scene-objects.md), and study an existing encounter in
   `src/encounters/` (`yamaP3`, `solHeredit`, `inferno`).
3. Gather the evidence, and write the facts spec and open questions **before** you write code.
4. Implement in encounter-local code. Keep sequencing and parameters with the encounter, not in
   shared infrastructure.
5. Add the fixtures and tests described above.
6. Run the checks:

   ```bash
   npm run typecheck
   npm run check:lockfile          # after changing dependencies
   npm test
   SCIM_REQUIRE_SETUP=1 npm test   # after npm run setup
   npm run build                   # after npm run setup
   ```

   The [sandbox](./docs/sandbox.md) runs them without giving the code your credentials:
   `./dev-sandbox test --worktree` and `./dev-sandbox shell --worktree -- npm run typecheck` check
   your own changes. For someone else's branch, run `./dev-sandbox test <branch>` from a checkout
   of `main` instead, because the sandbox script comes from the checkout it runs in.

## Pull requests

- For a new or changed mechanic, or any copied third-party code, open an issue with your evidence
  first and wait for a maintainer's go-ahead before you open the pull request.
- Keep each pull request to one change, and say where its numbers came from. The evidence standard
  above applies to every mechanic.
- Update the encounter's facts, open questions and policy notes in the same pull request.
- Run the checks listed under [Building an encounter](#building-an-encounter) and say which you ran.
- To review or try someone else's pull request, run it in the [sandbox](./docs/sandbox.md)
  (`./dev-sandbox --pr N`, `./dev-sandbox test --pr N`) rather than checking it out and running it
  directly: its dependencies, tests and dev server would run with your credentials.
- Never include raw captures, game assets or personal data.
- Contribute only work that is yours to license under MIT and that follows the
  [source rules](#source-rules).

## License

Code you contribute here is licensed under this repository's MIT license. Code you add to a fork of
this repository is MIT unless you choose otherwise. Data derived from the OSRS Wiki stays under
CC BY-NC-SA 3.0, which forbids commercial use of those files. Keep the `LICENSE` file and the
third-party notices, publish your fork under your own project name, and please credit Scim.GG in
your README, as the [README asks](./README.md#if-you-build-on-this).
