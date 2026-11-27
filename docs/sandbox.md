# Running code you did not write

`./sandbox` and `./dev-sandbox` run a commit, a pull request or your working tree in a Docker
sandbox that holds none of your credentials. Use them to review or try someone else's pull request,
and to run the checks on your own change before you open one. Running a pull request's code
directly (`npm ci`, `npm test`, `npm run dev`) would give its dependencies' install scripts, its
tests and its dev server your credentials, SSH keys and everything else your user can reach.

```bash
./dev-sandbox --pr 12              # pull request 12: dev server, opened in a separate browser profile
./dev-sandbox --worktree           # your checkout, uncommitted changes included
./dev-sandbox --status             # running sandboxes; --stop [TARGET] stops one
./sandbox test --pr 12 [-- ARGS]   # npm test [-- ARGS]; also build, and shell [-- CMD]
./sandbox seed --pr 12             # download the game data it needs (once per machine, see Seeds)
./sandbox status                   # sandboxes, disk use and limits
./sandbox clean [TARGET | --all]   # free the disk (see Disk)
```

`./sandbox --help` and `./dev-sandbox --help` list every command and option.

Run them from a checkout you trust, such as your own clone of `main`. The script, its helpers in
`scripts/sandbox/` and the lockfile checker come from the checkout they run in, never from the code
under test, so a pull request cannot change how it is sandboxed. Do not run `./sandbox` from a
checkout of a pull request.

## Targets

- `COMMIT-ISH` (default `HEAD`): any commit in your clone. Only committed content is used: the
  snapshot is a `git archive` of the commit, with no `.git` and no history.
- `--pr N`: pull request N, fetched over HTTPS without credentials from
  `https://github.com/scimgg/scimgg.git` into `refs/sandbox/pr-N` of your clone. A fork can point
  `SCIMGG_SANDBOX_UPSTREAM` at its own repository.
- `--worktree`: your checkout's `HEAD` plus its uncommitted edits, deletions and untracked files
  that git does not ignore. It prints what it took and a hash of the content; an unchanged tree
  reuses the last snapshot, and each edit makes a new one. Symbolic links in the tree are refused,
  and other repositories nested inside it are left out. It is for your own changes: if the
  checkout also holds someone else's (a merged branch, say), the sandbox script would come from
  their code too, so run that branch as a `COMMIT-ISH` from a clean checkout of `main` instead.

The dev server reuses a running sandbox of the same target. With `--worktree`, a new edit replaces
the server for the old content, as `npm run dev` would.

## What it isolates

- **Mounted:** the snapshot, the read-only seed data (below), and a generated `passwd` and `group`
  that name your user id. Nothing else from your machine: no home directory, SSH or GitHub
  credentials, Docker socket, or environment variables.
- **Containers:** the official `node` slim image pinned by digest, plus the compilers native
  modules need to build offline (`scripts/sandbox/Dockerfile`), as your non-root user id, with every
  capability dropped, `no-new-privileges`, a read-only root, `/tmp` and `HOME` in memory, and CPU,
  memory and process limits.
- **Network:** only `npm ci --ignore-scripts` has it, after `scripts/check-lockfile.mjs` from your
  checkout passes, in a directory holding nothing but `package.json` and `package-lock.json`.
  Dependency install scripts (`npm rebuild`), `npm run setup`, the tests, the build, the shell and
  the dev server have none. The dev server is on an internal Docker network on which your machine
  has no address, so it cannot reach services on your machine either; a relay container publishes
  it on `127.0.0.1` only, on a port from 5600 to 5899.
- **Dependencies:** they are installed once per lockfile and mounted read-only into every snapshot
  that uses that lockfile, so one pull request's code cannot change what another one runs. Only
  Vite's caches inside `node_modules` are writable, per snapshot.

What it does not protect against:

- A kernel or container-runtime escape. The containers share a kernel with your machine or with
  the Docker virtual machine.
- The page's JavaScript, which runs in your browser. That is why the dev server opens in a separate
  browser profile, with none of your cookies, logins or extensions. The page can still reach the
  internet and anything on `localhost` that the browser can.
- Docker itself, which is root-equivalent on a Linux host.
- A snapshot is writable by its own code, so a later run of the same commit sees what an earlier
  run left behind. `./sandbox clean TARGET` resets it.

## Requirements and platforms

- **Platforms:** Linux and WSL2 with Docker Engine or Docker Desktop; macOS (Apple Silicon or
  Intel) with Docker Desktop, OrbStack or Colima. Native Windows is not supported: the script says
  so and stops; use WSL2. Podman and rootless or user-namespace-remapped Docker are refused: the
  first is unverified, and on the others the container's user would not map to yours without
  running as root inside the container.
- **Tools:** bash 3.2 or later (the one macOS ships is fine), git 2.31 or later, curl, and Docker
  Engine 25.0 or later. The internal network relies on an option that leaves the host no address
  on it, checked on Docker 25.0 to 29.5.
- **Without Docker:** if `docker` is missing, the daemon is stopped or unreachable, your user may
  not use its socket, or the engine is Podman or too old, every command except `--help` says what
  to install or start and exits with status 1.
- **Browser:** on WSL, Chrome on Windows; on macOS, Chrome, Chromium, Edge or Brave; on Linux with
  a display, the same browsers. It always uses a separate profile, never your default browser or
  profile. If it finds none, it prints the URL and asks you to open it in a separate profile.
- **Limits:** containers get Docker's CPU count less headroom, and three quarters of its memory, at
  most 24 GB. `SCIMGG_SANDBOX_CPUS` and `SCIMGG_SANDBOX_MEMORY` (for example `6` and `8g`)
  override them. On Docker Desktop, OrbStack and Colima, Docker's figures are the virtual
  machine's settings.

## Isolation self-test

Before the first run on a Docker daemon, and again when its ID or version changes, the script runs
`scripts/sandbox/probe.mjs` in containers started with the same flags as the real ones. It takes a
few seconds.

- A container without a network must have only the loopback interface, no route, no DNS and no
  internet, and a file it writes into a mounted directory must come out owned by you.
- A container on the dev server's internal network must have no default route, no DNS and no
  internet. It must not reach any Docker network's gateway, your machine's addresses, Docker
  Desktop's host addresses or `host.docker.internal`, and it must still answer through the relay
  on `127.0.0.1`.

Only a "no route" error counts as unreachable; a refused connection or a timeout fails the test.
If any check fails, nothing runs, and there is no weaker mode to fall back to. `./sandbox selftest`
runs it again; the report is in `~/.cache/scimgg-sandbox/selftest/last.log`.

## Seeds

The sandbox runs `npm run setup -- --offline`, so the game cache, item icons and health bars that
setup would download come from a seed directory, `~/.cache/scimgg-sandbox/seed/`, mounted
read-only. A command that needs something missing stops before running anything, names what is
missing, and prints the command that fetches it:

```bash
./sandbox seed --pr 12             # the pinned cache, item icons and health bars (about 225 MB)
./sandbox seed --pr 12 --test-cache  # also the older cache some test suites need (160 MB)
```

`./sandbox seed` downloads only what the target pins, only from the sources setup uses (the
OpenRS2 archive, RuneLite's icon host and RuneLite's GitHub repository), and checks every file
against its SHA-256 pin before saving it. It runs code from your checkout, not the target's, in a
container that has network and sees the target's files read-only, as data. Files are kept by their
hash, so two pull requests that pin different versions of an icon do not overwrite each other.
Without the test cache, the suites that need it skip, as they do in a fresh clone; if your clone
has one at `.test-cache/disk.zip`, the sandbox uses that.

## Disk

Everything lives under `~/.cache/scimgg-sandbox/`, plus the sandbox's image in Docker.

| What | Size |
|---|---|
| A snapshot (the tree and its generated assets) | about 0.1 GB; 0.35 GB once the full test suite has unpacked the cache in it |
| A dependency set, one per lockfile | about 0.35 GB |
| Seeds | about 0.25 GB, plus 0.16 GB with `--test-cache` |
| npm's download cache | up to 1 GB, then emptied |
| The image: node slim plus python3, make and g++ | about 0.7 GB |

At the start of each command that prepares a snapshot, the script removes:

- snapshots unused for `SCIMGG_SANDBOX_KEEP_DAYS` days (default 7);
- with `--worktree`, the snapshots of the tree's earlier content, which an edit has replaced;
- then the least recently used snapshots while snapshots and dependency sets together exceed
  `SCIMGG_SANDBOX_MAX_GB` (default 5, which holds two lockfiles' dependencies and a dozen fully
  tested snapshots);
- dependency sets no remaining snapshot uses, apart from the two most recently used;
- its own images once nothing pins them, and game caches no snapshot uses, apart from the newest.

It never removes the snapshot of a running sandbox or of another run in progress, and it notes on
one line what it removed. An interrupted or failed preparation leaves nothing behind: its
half-made snapshot or dependency set is removed. `./sandbox status` shows the use per category and
the limits. `./sandbox clean` removes every snapshot and dependency set, `./sandbox clean TARGET`
one snapshot, and `./sandbox clean --all` also the seeds, caches, browser profile, the images the
script pulled or built, and the `refs/sandbox/` references in your clone.

On one machine, a new lockfile took about 50 seconds to install and set up, another commit with
the same lockfile about 15 seconds, and the full test suite about 2.5 minutes.

## Forks: `scripts/sandbox/local.sh`

A fork whose tree needs something different (another Node version, other seed data, another setup
step) can add `scripts/sandbox/local.sh` instead of editing the shared files, so it can keep merging
changes to them. It is git-ignored here; a fork commits it with `git add -f`. The script sources it
at startup as trusted code with your permissions, the same as the script itself, and never from a
snapshot. The variables and the `sandbox_local_target` hook it can set are listed under "Local
extensions" at the top of `./sandbox`.
