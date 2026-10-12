#!/usr/bin/env bash
#
# Copyright (c) 2026 James Shafton
# Licensed under the PolyForm Noncommercial License 1.0.0
# See LICENSE file in the project root, or
# https://polyformproject.org/licenses/noncommercial/1.0.0
#
# Brings this install up to date with GitHub. Called by update.sh.
#
# Normally that is just `git pull`, exactly as before. The one extra case is an upstream
# history that has been rewritten, for example to remove something that should never have
# been committed. Every commit then gets a new ID, so this install's history and GitHub's
# no longer line up, and `git pull` refuses to continue. The install keeps running, but it
# can never update again without someone fixing it by hand.
#
# A rewrite is recognised strictly: every commit this install has that GitHub lacks must have
# an exact counterpart on GitHub with the same author, the same author timestamp and the same
# title. Genuine local work never has one, so it is never mistaken for a rewrite. Only then,
# and only if no tracked file has been edited, the install is moved to GitHub's history with
# `git reset --keep`. That never touches untracked or ignored files (settings, the database,
# backups and node_modules all live outside git's view) and refuses outright rather than
# overwrite anything changed locally. In every other case nothing new happens: plain
# `git pull`, with whatever result it always had.

set -euo pipefail
cd "$(dirname "$0")/.."

# Prints one line per commit: author timestamp, author email, title.
commit_keys() { git log --format='%at %ae %s' "$1"; }

history_was_rewritten() {
  local mine theirs line
  git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1 || return 1
  mine=$(commit_keys '@{u}..HEAD') || return 1
  [ -n "$mine" ] || return 1                    # nothing local-only: a normal update
  theirs=$(commit_keys 'HEAD..@{u}') || return 1
  [ -n "$theirs" ] || return 1                  # only local commits: not a rewrite
  while IFS= read -r line; do
    printf '%s\n' "$theirs" | grep -qxF -- "$line" || return 1
  done <<EOF
$mine
EOF
  return 0
}

# --force matters here. A plain `git fetch --tags` REFUSES to update a tag that
# already exists locally with different content ("would clobber existing tag")
# and exits non-zero - which, under `set -e`, aborts this script before `git
# pull` ever runs. The update then silently does nothing and the installed
# version never moves, while the dashboard keeps advertising a newer release.
# Release tags are re-pointed upstream from time to time, so treating the
# remote as authoritative for them is both correct and necessary.
git fetch --tags --force

if history_was_rewritten; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "WattSnatch's history on GitHub was rewritten, but files in this install have been"
    echo "edited, so it will not move automatically. Keep a copy of your edits, then run:"
    echo "  git stash && git reset --keep @{u} && npm install"
    exit 1
  fi
  echo "WattSnatch's history on GitHub was rewritten (the code is the same). Moving this"
  echo "install across. Your settings and data are not affected."
  git reset --keep '@{u}'
else
  git pull
fi
