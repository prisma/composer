# Slice: streams binding redesign — provider params + contract-owned lifecycle

## At a glance

Close out Will's 2026-07-17 review of PR #92 by implementing the two settled
designs recorded in
[streams-binding-design.md](../../streams-binding-design.md) (the binding
contract for this slice — read it in full before implementing):

- **Part A**: provider-side minted values (rpc accepted keys, streams API
  key) become target-owned **reserved params** — declared, schema-validated,
  carried by the normal serialize → deserialize → stash pipeline.
  `restashAddressFree` and the raw `process.env` scrapes it fed are deleted.
- **Part B (untyped defs only)**: the streams contract **names its
  streams**; `durableStreams(contract)` hydrates to one handle per stream;
  handles own ensure-create and the proven-safe 404 heal; the client
  becomes a class. `streamDef({ event })` typed validation is the recorded
  follow-up and does NOT ship here — no schema parameter that does nothing.

This lands on PR #92's branch (`claude/streams-minted-key`); the slice is
done when every open review thread is answered with either the fix or the
recorded rationale, and Will's re-review is requested.

## Scope

In: everything under "The design" in Parts A and B of the design doc, at the
#92 scope split; moving (not weakening) the existing invariant tests; the
live re-proof; replying on and resolving all 11 open review threads.

Out: `streamDef({ event })` / both-edge validation (follow-up slice); RPC
cold-start handling and its canary (separate task, operator direction);
required-checks branch protection (Will's manual step).

## Verification bar (inherited from this branch's history — do not lower)

- **Invariant tests move, not die**: zero-consumer deny-all `"[]"`;
  no-expose-no-rows; a third brand touches only `control.ts`; the boot
  round-trip of provider params through deserialize/stash (replaces the four
  restash tests).
- **Mutation checks keep their teeth**: the wire-counted append tests (one
  POST per append, zero retries — 503 + concurrency) and the heal test
  (delete the stream out from under the handle; red without the heal) are
  re-verified red after moving into the streams package.
- **Live re-proof** on real Prisma Cloud: deploy `examples/streams`,
  conformance (215/239, the 24 = PRO-218 SSE), smoke (401 unauth, authed
  append/read/tail), the PRO-217 canary still runs and classifies, destroy
  clean.
- Repo checks green throughout: typecheck, biome, lint, depcruise, casts,
  `pnpm test:scripts`.

## Review-thread closeout (the slice's exit)

Every open thread on #92 gets a reply naming the commit that resolves it or
the recorded rationale (design doc section), then resolved; the three stale
pre-2026-07-17 threads likewise. Re-request Will's review. No merge without
his word.
