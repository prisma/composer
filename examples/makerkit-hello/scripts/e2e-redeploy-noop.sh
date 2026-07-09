#!/usr/bin/env bash
# Redeploys hello with an unchanged build and asserts it's a no-op — the
# node-kind determinism claim (the Next path is knowingly non-deterministic,
# see deploy-cli.md, so this proof lives here, not in the storefront-auth
# job). Asserts the positive signal alchemy itself prints for a no-op plan,
# `Plan: N to noop` (confirmed verbatim from CI run 29011388591's logs), then
# also checks no create/update/replace verb shows up, in case alchemy's
# plan-summary wording changes later. Run from examples/makerkit-hello;
# needs HELLO_STACK_NAME set.
set -euo pipefail

: "${HELLO_STACK_NAME:?HELLO_STACK_NAME must be set}"

out="$(bun node_modules/.bin/makerkit deploy src/hex.ts --name "$HELLO_STACK_NAME" 2>&1)"
printf '%s\n' "$out"

if ! printf '%s' "$out" | grep -qE 'Plan: [0-9]+ to noop'; then
  echo "Redeploy was not a no-op: no 'Plan: N to noop' line in the output."
  exit 1
fi

if printf '%s' "$out" | grep -qE '\b(created|updated|replaced)\b'; then
  echo "Redeploy was not a no-op: found a create/update/replace verb in the output."
  exit 1
fi
