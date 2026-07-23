# wired-egress — origin and cross-references

Branched out of the **auth-module** project (Will's call, 2026-07-23),
where the need surfaced during slice S1. What a fresh agent needs to know
about the surrounding state:

## Where the prior artifacts live

- Auth project workspace: `.drive/projects/auth-module/` on branch
  `claude/prisma-composer-auth-module-0ade44` (prisma/composer). Its
  `slices/rpc-port-isolation/spec.md` is the v2 draft this project's
  spec.md supersedes and absorbs (kept there for history; the auth plan's
  S5 entry should be replaced with a pointer to this project when that
  branch is next quiet — it was mid-deploy when this workspace was cut).
- Linear: auth project "Composer auth module"
  (https://linear.app/prisma-company/project/composer-auth-module-9f7763e35720,
  Terminal team, slices TML-3076..3079). No Linear project exists for
  wired-egress yet — create one at project start per the Drive ceremony.

## Already landed (on the auth branch, in S1) — relevant prior work

- `feat(service-rpc): serve() skips non-rpc exposed ports` — mixed
  rpc/non-rpc expose maps work; `Handlers<S>` filters to rpc ports. This
  project's `rpcPort()` split builds on that file state.
- Admin op renamed `findUser` (flat-dispatch collision with
  `session.getUser`). Keep the name post-project; the collision class
  dies but the rename is clearer anyway.
- Auth's entrypoint has an in-module fetch router
  (`/health`, `/api/auth*` public, `/rpc/*` flat-keyed) — the thing
  `serveMounts()` replaces.
- The flat accepted-key mechanics this project re-partitions:
  `packages/0-framework/2-authoring/service-rpc/src/serve.ts`
  (`COMPOSER_RPC_ACCEPTED_KEYS`, `acceptedKeys()`, constant-time
  membership) and the target's `service-keys.ts` / ADR-0030.

## External threads in flight at branch-out time

- **Platform ask** (multi-port per version): message sent by Will to the
  platform team 2026-07-23, meeting requested, no response yet. Evidence
  base: the ignite docs findings recorded in spec.md § Platform
  grounding.
- **Auth S3 sequencing decision** (deliberately open): does the auth
  project's storefront consumer example wait for this project's first
  slice (admin port transport-isolated before the flagship example
  deploys it), or ship on flat dispatch and re-wire later? To be decided
  when auth S2 is in review, with the platform response in hand.
