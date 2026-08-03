# Design notes — alchemy-provider-adoption

## Principles

- Own zero Management-API wrapper code that upstream also owns.
- Composer's local-dev iteration speed must not depend on upstream review
  latency (operator decision, 2026-08-03).
- Upstream's opinionated guards are adopted, not fought — each one we checked
  (named-DB+branch refusal, system-managed env refusal, pooled-first URL) was
  correct or workaroundable on our side.

## The model

One provider (upstream's), two provider *layers* on Composer's side:

- deploy: upstream's live providers (needs the `liveProviderLayer` export or a
  local rebuild of its wiring — client layer + individual `*Provider()`s).
- dev: Composer's emulator providers bound to upstream's resource classes,
  substituted at `LowerOptions.providers` (`deploy.ts:203`) exactly as ADR-0041
  does today.

State: hosted Postgres store unchanged; rows migrate off the colliding
type-ids. Auth: `Layer.succeed(PrismaEnvironment, {token, baseUrl})`, skipping
alchemy's profile store.

## Alternatives considered

- **Contribute emulators upstream** (original proposal, in wip notes): rejected
  for now — couples our dev loop to Sam's dual-mode design and review cadence.
- **Adopt `ProviderLayer.dual`**: solves cross-mode state stamping we don't
  need (dev and deploy use disjoint state stores). Revisit if that ever
  changes.
- **Vendor `src/Prisma/` into Composer**: works on beta.59 (provider uses no
  newer core APIs) but inherits `@prisma/dev` dep + permanent drift. Only a
  fallback if the beta bump stalls badly.
- **Keep our six resources**: rejected — the spike showed upstream is strictly
  more hardened on deploy lifecycle and we'd keep paying API drift.

## Open questions

Tracked in spec.md (Compute vs App+Deployment; state-migration mechanics;
first released beta).

## References

`wip/alchemy-prisma-provider-notes-for-aman.md`; spike session artifacts;
upstream PRs #416, #963.
