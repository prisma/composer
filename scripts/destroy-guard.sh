#!/usr/bin/env bash
# Shared destroy step for e2e-deploy.yml's cleanup (runs even after a failed
# deploy, so a broken run doesn't leave orphaned cloud resources). Deploy
# state is hosted (the workspace's prisma-composer-state project), not local to the
# runner, so `.alchemy/` presence says nothing about whether a deploy ran —
# the workflow gates this step on the deploy step's own outcome instead, and
# a destroy against a stack that never deployed is a cheap no-op plan.
#
# Usage: destroy-guard.sh <label> <entry-file> <stack-name>
# <label> prefixes log lines (e.g. "" for storefront-auth).
# Run from the example's directory: composer-destroy.ts reads its
# prisma.config.ts. Destroy requires an explicit target (--stage or
# --production); this cleanup targets the production environment of the
# per-run stack name.
set -euo pipefail

scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

label="$1"
entry="$2"
stack_name="$3"

echo "Destroying ${label}stack $stack_name…"
bun "$scripts_dir/composer-destroy.ts" "$entry" --name "$stack_name" --production
