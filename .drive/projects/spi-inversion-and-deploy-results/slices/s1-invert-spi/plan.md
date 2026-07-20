# S1 — Dispatch plan

## D1 — Core SPI + loop + core tests

**Outcome:** `deploy.ts` carries the new type set (spec § Core verbatim);
`lowering()`/`lower()`/`buildConfig` compile against it; `lowering.test.ts`
updated and green, including the new resolves-to-`undefined` test.
**Builds on:** nothing.
**Hands to:** D2 — a compiling core whose SPI the extension migrates onto.
**Completed when:** `pnpm turbo run test --filter @internal/core` green;
no `LoweredNode` reference remains under `packages/0-framework/`.

## D2 — Extension migration + target tests

**Outcome:** the five descriptors, `shared.ts` (`CloudApplication` +
guarded `projectIdOf`), and `control.ts` implement the typed SPI per spec;
compute's two `as` casts and shared's `blindCast` deleted; target tests
(incl. the new `projectIdOf` seam-error test) green.
**Builds on:** D1's SPI.
**Hands to:** D3 — a fully compiling workspace.
**Completed when:** repo-wide typecheck + target package tests green;
cast ratchet net-negative.

## D3 — ADR + doc sweep + full CI

**Outcome:** ADR-0033 (spec § Docs content contract) + decisions index
updated; `core-model.md` SPI quotes transcribed to the new types; full CI
green.
**Builds on:** D2 (documents what now exists).
**Hands to:** slice PR open; S2/S3 unblocked.
**Completed when:** `git grep LoweredNode` empty repo-wide; CI green.
