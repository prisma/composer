#!/usr/bin/env bash
# Reads the storefront service's deployed URL from Alchemy state, then polls it
# until the page renders the live storefront->auth round trip. Retries because a
# version cold-starts after deploy (PRO-200) and auth's DB ping can transiently
# fail right after idle (FT-5219), recovering on the next hit. Run from
# examples/storefront-auth.
set -euo pipefail

state="$(find .alchemy/state -name 'storefront-deploy.json' | head -1)"
[ -n "$state" ] || { echo "No storefront-deploy state under .alchemy/state."; exit 1; }
url="$(node -e "console.log(JSON.parse(require('fs').readFileSync('$state','utf8')).attr?.deployedUrl ?? '')")"
[ -n "$url" ] || { echo "storefront-deploy state has no attr.deployedUrl: $(cat "$state")"; exit 1; }
echo "Storefront URL: $url"

deadline=$((SECONDS + 180))
body=""
while [ "$SECONDS" -lt "$deadline" ]; do
  body="$(curl -sS --max-time 30 "$url" || true)"
  clean="$(printf '%s' "$body" | sed -e 's/<!--[^>]*-->//g' -e 's/&quot;/"/g')"
  if printf '%s' "$clean" | grep -q 'Auth /verify says: true'; then
    echo 'Round trip OK — storefront rendered auth.verify() -> { ok: true }'
    exit 0
  fi
  sleep 6
done
echo "Round trip never rendered 'Auth /verify says: true' within the deadline. Last body:"
printf '%s' "$body" | head -c 3000
exit 1
