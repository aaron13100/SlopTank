#!/bin/sh
# scripts/run-in-index-snapshot.sh
#
# Run an arbitrary command against a throwaway, read-only export of the
# current git INDEX (what `git commit` would actually commit) instead of the
# on-disk working tree.
#
# Why: dependency-cruiser (unlike scripts/validate-features.mjs, which grew
# its own --staged mode in commit 36447f3c18) has no built-in "staged
# content only" mode -- it walks and parses whatever is physically on disk
# under the directory it is pointed at. On a worktree shared by several
# concurrent agents, that means ANY other agent's unstaged, in-progress
# dirty file under src/ can introduce a layer-boundary violation or a new
# circular import that fails a commit which never touched that file. This
# script sidesteps that by exporting the git index into a scratch directory
# and running the given command there instead of in the real working tree:
# the snapshot gets exactly the tracked, staged file set, including the
# tracked config files the tool itself needs to run correctly
# (.dependency-cruiser.js, tsconfig, package.json, the known-violations
# json), with none of the unstaged noise. See t_260924_153132_894 / c285,
# sibling fix to c282's validate-features.mjs --staged mode for the same
# structural bug shape (a gate that scans disk instead of the index).
#
# Usage:
#   scripts/run-in-index-snapshot.sh <command> [args...]
#
# The command is run with its cwd set to the snapshot directory, and its
# exit status is propagated exactly as this script's own exit status. Any
# failure in setting up the snapshot itself (as opposed to the command
# failing) is reported to stderr prefixed "index-snapshot:" and this script
# exits non-zero -- it fails closed, never silently falling through to run
# the command against something partial or missing.
#
# node_modules is not part of the git index (it is .gitignore'd), so it is
# symlinked in from the real repo rather than exported; dependency-cruiser
# needs it on disk to resolve module imports.

if [ "$#" -eq 0 ]; then
    echo "index-snapshot: usage: $0 <command> [args...]" >&2
    exit 1
fi

REPO=$(git rev-parse --show-toplevel)
if [ -z "$REPO" ]; then
    echo "index-snapshot: not inside a git repository; refusing to proceed (fail closed)." >&2
    exit 1
fi

if [ ! -d "$REPO/node_modules" ]; then
    echo "index-snapshot: $REPO/node_modules is missing; refusing to proceed (fail closed)." >&2
    exit 1
fi

SNAP=$(mktemp -d "${TMPDIR:-/private/tmp}/index-snapshot.XXXXXX")
if [ -z "$SNAP" ] || [ ! -d "$SNAP" ]; then
    echo "index-snapshot: failed to create a scratch snapshot directory; refusing to proceed (fail closed)." >&2
    exit 1
fi
trap 'rm -rf "$SNAP"' EXIT INT TERM

if ! git -C "$REPO" checkout-index -a -f --prefix="$SNAP/"; then
    echo "index-snapshot: git checkout-index failed to export the index into $SNAP; refusing to proceed (fail closed)." >&2
    exit 1
fi

if ! ln -s "$REPO/node_modules" "$SNAP/node_modules"; then
    echo "index-snapshot: failed to symlink node_modules into $SNAP; refusing to proceed (fail closed)." >&2
    exit 1
fi

if ! cd "$SNAP"; then
    echo "index-snapshot: failed to cd into snapshot directory $SNAP; refusing to proceed (fail closed)." >&2
    exit 1
fi

"$@"
exit $?
