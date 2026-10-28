#!/usr/bin/env bash
# Shared destroy step for e2e-deploy.yml's cleanup (runs even after a failed
# deploy, so a broken run doesn't leave orphaned cloud resources). Deploy
# state is hosted (the workspace's prisma-composer-state project), not local to the
# runner, so `.alchemy/` presence says nothing about whether a deploy ran —
# the workflow gates this step on the deploy step's own outcome instead, and
# a destroy against a stack that never deployed is a cheap no-op plan.
#
# Usage: destroy-guard.sh <label> <stack-name> [<environment>]
# <label> prefixes log lines (e.g. "" for storefront-auth).
# <environment> defaults to production; destroy itself has no default.
# Run from the example's directory: composer-destroy.ts reads its
# prisma.config.ts, including its `entry`.
set -euo pipefail

scripts_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

label="$1"
stack_name="$2"
environment="${3:-production}"

echo "Destroying ${label}stack $stack_name ($environment)…"
bun "$scripts_dir/composer-destroy.ts" --name "$stack_name" --environment "$environment"
