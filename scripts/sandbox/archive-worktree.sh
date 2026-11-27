#!/usr/bin/env bash
# Builds the deterministic archive of a working tree for `./sandbox --worktree` (see ../../sandbox).
# It runs in a no-network sandbox container from the pinned image, so GNU bash, sort and tar are the
# same on every host. The tree is mounted read-only at /src, the host's `git ls-files -z` output
# (every tracked or untracked, non-ignored path, and the deleted ones) at /req, and the archive is
# written to /out/worktree.tar.
#
# Nested repositories are left out. A symbolic link anywhere on a path, any other non-regular
# file, a `.git` component or a path that leaves the tree refuses the whole snapshot. tar never
# follows links, and the archive holds only the regular files listed, with fixed times and owners.
set -euo pipefail

refuse() { printf 'refusing the working tree: %s\n' "$1" >&2; exit 3; }

declare -A deleted=() checked=()
paths=()
while IFS= read -r -d '' p; do deleted[$p]=1; done < /req/deleted
while IFS= read -r -d '' p; do
  [ -n "${deleted[$p]+x}" ] && continue
  # git lists a nested repository (another clone or worktree inside this one) as `dir/`; it is not
  # part of this tree.
  if [[ $p == */ ]]; then
    printf 'skipping the nested repository %s\n' "$p" >&2
    continue
  fi
  case "/$p/" in
    //* | */../* | */./* | *//*) refuse "path '$p' leaves the tree" ;;
    */.git/*) refuse "path '$p' is inside a .git" ;;
  esac
  prefix=""
  rest=$p
  while [[ $rest == */* ]]; do
    prefix+=${rest%%/*}
    rest=${rest#*/}
    if [ -z "${checked[$prefix]+x}" ]; then
      [ -L "/src/$prefix" ] && refuse "'$prefix' is a symbolic link"
      [ -d "/src/$prefix" ] || refuse "'$prefix' is not a directory"
      checked[$prefix]=1
    fi
    prefix+=/
  done
  [ -L "/src/$p" ] && refuse "'$p' is a symbolic link"
  [ -f "/src/$p" ] || refuse "'$p' is not a regular file"
  paths+=("$p")
done < /req/all
[ ${#paths[@]} -gt 0 ] || refuse "it has no files"

printf '%s\0' "${paths[@]}" | LC_ALL=C sort -z |
  tar -C /src --null --no-recursion --verbatim-files-from -T - -c -f /out/worktree.tar \
    --format=gnu --mtime=@0 --owner=0 --group=0 --numeric-owner
