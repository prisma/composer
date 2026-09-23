#!/usr/bin/env bash
# Resolves the storefront service's deployed URL via the Management API (state
# is hosted, not local files), then polls it until the page renders the live
# storefront->auth round trip. Retries because a version cold-starts after
# deploy (PRO-200) and auth's DB ping can transiently fail right after idle
# (FT-5219), recovering on the next hit. Run from examples/storefront-auth.
# Requires PRISMA_SERVICE_TOKEN; STACK_NAME optionally overrides the
# project name (defaults to storefront-auth, matching the stack name the CLI deploys).
set -euo pipefail

stack="${STACK_NAME:-storefront-auth}"
api="https://api.prisma.io/v1"
auth_header="Authorization: Bearer ${PRISMA_SERVICE_TOKEN:?PRISMA_SERVICE_TOKEN is required}"

project_id="$(curl -sS -H "$auth_header" "$api/projects?limit=100" \
  | node -e "let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>{const p=(JSON.parse(d).data??[]).find((x)=>x.name===process.argv[1]);console.log(p?.id??'')})" "$stack")"
[ -n "$project_id" ] || { echo "No project named '$stack' in the workspace."; exit 1; }

# The post-promote endpoint domain is the servable one (the create-time domain
# is a placeholder — PRO-200); by the time this script runs, deploy + promote
# have completed, so the app read returns the real domain. `/v1/apps` is the
# current Management API surface for what used to be `/v1/compute-services`
# (same underlying resources — see cold-start-canary.ts and gotchas.md PRO-217).
domain="$(curl -sS -H "$auth_header" "$api/apps?projectId=$project_id&limit=100" \
  | node -e "let d='';process.stdin.on('data',(c)=>{d+=c}).on('end',()=>{const s=(JSON.parse(d).data??[]).find((x)=>x.name==='storefront');console.log(s?.appEndpointDomain??'')})")"
[ -n "$domain" ] || { echo "Project $project_id has no 'storefront' app with an endpoint domain."; exit 1; }
# appEndpointDomain arrives WITH the https:// scheme (see the PRO-200
# gotcha's captured responses); tolerate either shape.
case "$domain" in
  http://*|https://*) url="$domain" ;;
  *) url="https://$domain/" ;;
esac
echo "Storefront URL: $url"

deadline=$((SECONDS + 180))
body=""
while [ "$SECONDS" -lt "$deadline" ]; do
  body="$(curl -sS --max-time 30 "$url" || true)"
  clean="$(printf '%s' "$body" | sed -e 's/<!--[^>]*-->//g' -e 's/&quot;/"/g')"
  if printf '%s' "$clean" | grep -q 'Auth /verify says: true' \
    && printf '%s' "$clean" | grep -q 'Secret /check says: true'; then
    echo 'Round trip OK — storefront rendered auth.verify() -> { ok: true } AND the secret proof (secretCheck -> { ok: true })'
    exit 0
  fi
  sleep 6
done
echo "Round trip never rendered both 'Auth /verify says: true' and 'Secret /check says: true' within the deadline. Last body:"
printf '%s' "$body" | head -c 3000
exit 1
