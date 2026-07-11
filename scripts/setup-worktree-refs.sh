#!/usr/bin/env bash
# Populate a git worktree with the reference clones the framework work needs:
# prisma-next, ignite, datahub, open-chat (all gitignored, one clone per worktree).
#
# Idempotent: clones that already exist are left untouched, so it is safe to run
# on every session start. Wired as a SessionStart hook in .claude/settings.local.json;
# also runnable by hand: `bash scripts/setup-worktree-refs.sh`.
#
# Each worktree clones from a shared bare cache next to the main repo, so objects
# are hard-linked on the same filesystem instead of re-downloading ~165MB per tree.
set -uo pipefail

# Only populate linked worktrees, never the main checkout (whose .git is a directory)
# and never a transient subagent worktree.
root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
[ -f "$root/.git" ] || exit 0
case "$(basename "$root")" in
  agent-*) exit 0 ;;
esac

main_root="$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')"
[ -n "${main_root:-}" ] || main_root="$(cd "$(git rev-parse --git-common-dir)/.." && pwd)"
cache="$main_root/.worktree-refs"
mkdir -p "$cache"

while IFS='=' read -r name url; do
  [ -n "$name" ] || continue
  dest="$root/$name"
  [ -e "$dest" ] && continue

  bare="$cache/$name.git"
  if [ -d "$bare" ]; then
    git -C "$bare" fetch --quiet origin '+refs/heads/*:refs/heads/*' 2>/dev/null || true
  elif ! git clone --quiet --bare "$url" "$bare" 2>/dev/null; then
    echo "setup-worktree-refs: could not cache $url" >&2
    continue
  fi

  if git clone --quiet "$bare" "$dest" 2>/dev/null; then
    git -C "$dest" remote set-url origin "$url" 2>/dev/null || true
  else
    echo "setup-worktree-refs: could not create $dest" >&2
  fi
done <<'EOF'
prisma-next=https://github.com/prisma/prisma-next
ignite=https://github.com/prisma/ignite
datahub=https://github.com/prisma/datahub
open-chat=https://github.com/prisma/open-chat
EOF
