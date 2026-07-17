# S3 — Dispatch plan

## D1 — Action-mechanism probe

**Outcome:** a throwaway stack (scratch, not committed) proves: an
`Action` whose input references a fresh resource's attribute plans and
runs on a first deploy; the nonce forces re-run on an unchanged redeploy;
the runner receives resolved values. It must also settle the two typing
questions the spec's edge-case table names: that `In`'s **mutable** arrays
map correctly through `Input<>` (a `readonly T[]` does not satisfy its
array branch), and that nested `Output<string>` fields inside
`entries[].primitives[]` are accepted at the call site and arrive
**resolved** in the runner. Probe torn down after.
**Builds on:** S1 merged.
**Hands to:** D2 — the mechanism confirmed, or a STOP → discussion-mode
signal per the spec's edge-case table.
**Completed when:** both probe deploys observed; findings noted in the
dispatch return.

## D2 — Core: LoweredResult + loop + action + joinDeployment

**Outcome:** spec § Core types + § SPI change + § Loop change implemented;
`joinDeployment` exported and unit-tested (missing-address skip included);
existing lowering tests updated to `LoweredResult` returns; sync tests
still run without alchemy context.
**Builds on:** D1's confirmation.
**Hands to:** D3 — core compiles; descriptors don't (their returns are now
type errors), which is the migration worklist.
**Completed when:** core package tests green.

## D3 — Descriptors + renderer + generated stack

**Outcome:** the five descriptors return the pinned primitives table;
`render-deployment.ts` implements the pinned format (pure, unit-tested
against a fixture covering nested addresses, no-primitive nodes, url and
no-url primitives); `@prisma/composer` gains the `./report` export;
`generate-stack.ts` template emits the import + `report:` option; snapshot
tests updated.
**Builds on:** D2's types.
**Hands to:** D4 — a fully wired build.
**Completed when:** full repo CI green.

## D4 — Live verification + #101 closure

**Outcome:** deploy of the example/dogfood app shows the rendered tree on
a changed AND an unchanged redeploy, no stack-output blob; output-ordering
cosmetics assessed (upstream ask filed if ugly); PR #101 closed with the
supersession comment; slice PR opened.
**Builds on:** D3.
**Hands to:** project close-out.
**Completed when:** Slice-DoD checked off with deploy transcript excerpts
in the PR body.
