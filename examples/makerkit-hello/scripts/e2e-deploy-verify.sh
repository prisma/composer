#!/usr/bin/env bash
# Builds and deploys hello as a bare service (the SERVICE-root deploy path —
# LowerOptions.bundle, not a hex's bundles), then polls the deployed URL
# until it serves. Reads the deploy's own state file for the URL rather than
# trusting `makerkit`'s stdout, since that's the durable source of truth.
# Run from examples/makerkit-hello; needs HELLO_STACK_NAME set.
set -euo pipefail

: "${HELLO_STACK_NAME:?HELLO_STACK_NAME must be set}"

pnpm build
bun node_modules/.bin/makerkit deploy src/service.ts --name "$HELLO_STACK_NAME"

state="$(find .alchemy/state -name '*-deploy.json' | head -1)"
[ -n "$state" ] || { echo "no deploy state found"; exit 1; }
url="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$state','utf8')).attr?.deployedUrl ?? '')")"
echo "Hello URL: $url"

deadline=$((SECONDS + 180))
body=""
while [ "$SECONDS" -lt "$deadline" ]; do
  body="$(curl -sS --max-time 30 "$url" || true)"
  if printf '%s' "$body" | grep -q '"ok"'; then
    echo "Hello serves: $body"
    exit 0
  fi
  sleep 6
done
echo "hello never served; last body: $body"
exit 1
