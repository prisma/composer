# S2 — Enforce the wiring contract

## At a glance

A producer that fails to supply a consumer's declared connection param
today yields a silent `undefined` serialized into the consumer's
environment — the failure surfaces at the consumer's boot, far from the
mistake. Under the inverted seam (ADR-0033) the consumer's connection
declaration is the contract; this slice makes under-delivery a loud
`LowerError` at deploy time, naming the edge. Operator-confirmed behavior
change (2026-07-17).

## Chosen design

All changes in `packages/0-framework/1-core/core/src/deploy.ts`,
`buildConfig`'s inputs loop — the one place the contract is resolved.

Current loop body (post-S1 shape):

```ts
const producedOutputs = edge !== undefined ? (lowered.get(edge.from) ?? {}) : {};
const values: Record<string, unknown> = {};
for (const [name, param] of Object.entries(inputNode.connection.params)) {
  values[name] =
    param.provision !== undefined
      ? provisioned.get(`${id}.${inputName}`)
      : producedOutputs[name];
}
```

New behavior — inside the same `for` loop, for the non-provisioned branch
only, when **an edge exists**:

```ts
const value = producedOutputs[name];
if (value === undefined && param.optional !== true && edge !== undefined) {
  throw new LowerError(
    `Connection input "${id}.${inputName}" declares param "${name}", but its producer ` +
      `"${edge.from}" did not supply it — the producer's wiring outputs carry ` +
      `[${Object.keys(producedOutputs).join(', ') || 'nothing'}]. Add "${name}" to the ` +
      `producer's returned wiring outputs, or declare the param optional on the connection.`,
  );
}
values[name] = value;
```

Pinned rulings:

- **`throw`, not `Effect.fail`** — matches `resolveParam`'s existing idiom
  in the same file; consistency wins over channel purity here.
- **`value === undefined` is the test** (not `name in producedOutputs`): a
  producer explicitly setting a key to `undefined` counts as missing —
  matches `resolveParam`'s bound-detection idiom.
- **Presence check only, no schema validation.** Wiring values at lowering
  time are routinely alchemy `Output` proxies (e.g. `deployment.deployedUrl`)
  — symbolic references that no Standard Schema can validate before apply
  resolves them. Record this as a code comment on the check, so nobody
  "completes" the enforcement later without noticing the proxy fact.
- **`edge === undefined` keeps today's behavior** (all params resolve
  `undefined`, no error). An unwired input is a graph-construction concern,
  out of this slice's scope; the check must not change that path.
- **Provisioned params are exempt** — the mint supplies them (ADR-0031);
  the `param.provision !== undefined` branch is untouched.
- **`param.optional === true` is exempt** — the consumer said absent is
  legal; boot-side `coerce()` already reads a missing var as `undefined`.

## Coherence rationale

One guard clause, one error message, a handful of tests — a reviewer holds
the entire semantic change (silent → loud) in one screen of diff.

## Scope

**In:** the guard, its comment, its tests.
**Deliberately out:** schema validation of wiring values (impossible
pre-resolution — see ruling); unwired-input handling; any descriptor
change (none should be needed — if a descriptor pair fails the new check
in tests or dogfood, that is a real latent bug, fixed as its own commit in
this slice with the failure named in the PR body).

## Pre-investigated edge cases

| Case | Ruling |
| --- | --- |
| s3-store's D4a↔D4b check | Its own serialize-time error stays — it guards `config` fields, not wiring presence; no overlap, no removal. |
| Optional connection params in existing modules | `coerce()`'s missing-var-as-absent contract (compute.ts serialize comment) is exactly the exempted path — unchanged. |

## Two facts D1 established (2026-07-17) — carry into the PR narrative

**1. The old behaviour was written down as a test, and this slice deletes
that assertion.** `lowering.test.ts` carried
*"a param the graph declares but the lowered outputs never produced
resolves to undefined"* — `db` wired, producer supplying nothing, `url`
declared required, asserting `{ url: undefined }`. That is precisely the
silent failure S2 retires, so DoD case 1 is that test **inverted**, and it
replaces rather than joins it.

This is the right call and the operator has confirmed the behaviour change
— but the diff will show a deleted assertion, and a reviewer must see that
as *the point*, not an oversight. Note the honest reading: the old
behaviour was characterized, not designed. The test recorded what
`buildConfig` did; nothing argued it was correct that a missing producer
output should reach a booting service as `undefined`.

**2. `buildConfig`'s `edge === undefined` branch is unreachable through
authoring.** `h.provision(auth, { id: 'auth' })` on a service declaring a
`db` input does not type-check — the authoring API requires declared inputs
be wired. So the branch is defensive only; D1's case 4 reaches it by
dropping the edge after `Load`, with a comment saying so.

**Ruling: implement the pinned condition as written.** `edge !== undefined`
inside the per-param check is correct either way, and defensive coding in
core's loop is cheap. The observation is recorded, not acted on — see the
project plan's § Open items.

## The blast radius is USER apps, not just our descriptors (established in review)

`dependency` is exported from `@internal/core`'s index (`index.ts:53`), and
`packages/9-public/composer/src/index.ts` is `export * from '@internal/core'`.
**App authors declare their own connections.** So the population this change
affects is not "our five descriptors" — it is every user-authored connection
declaration whose producer doesn't supply a declared required param.

This corrects how the null result must be framed. "No existing descriptor
pair under-delivers" is true and measured, but it covers **our** pairs and
says nothing about user apps, which is where the real exposure is. State it
that way in the PR; don't let the null result read as "nothing breaks."

Two further precisions for the PR narrative, from review:

- The postgres mutation proves the guard **can** fire through the real
  pipeline. The green suite **with the guard live** is what proves nothing
  under-delivers. The honest claim is therefore: *no descriptor pair the
  suite exercises under-delivers.*
- The residual is inverted by the slice itself — an untested
  under-delivering pair now fails **loudly at deploy** instead of silently
  at boot. The uncovered case is handled by the mechanism under review,
  which is why the qualified claim suffices.

## Slice-DoD

**Docs + skill (D3) — required, `.agents/rules/user-facing-surface-changes.mdc`
is `alwaysApply: true`:**

- [ ] `docs/guides/**` and `skills/prisma-composer/SKILL.md` both updated in
      this PR.

**Amended 2026-07-17 (F3, review).** My original DoD listed only test cases
— a spec-authoring miss, not an implementation one. S2 is precisely the
rule's named most-missed case ("behaviour a user hits without changing a
line of their code — a new default, **failure mode**, or status code"), and
the rule's own example is the same shape (RPC endpoints began returning 401
to unwired callers and neither surface said so). The one-PR decision is why
this is still catchable rather than already shipped: the "same PR" window is
open, but **no slice owned the debt** — S2's DoD listed tests, S3's spec is
primitives/rendering. It is now owned here, explicitly.

Write the consequence, not the mechanism: the line worth writing is the one
that stops a bug report from a user whose previously-green deploy now fails.

New `lowering.test.ts` cases, all green:

1. Producer omits a declared required param → deploy fails with a
   `LowerError` whose message contains the edge id (`consumer.input`), the
   param name, the producer id, and the producer's actual key list.
2. Producer omits a declared `optional` param → lowering succeeds; the
   consumer's config carries `undefined` for it.
3. A provisioned param with no producer-supplied value → untouched by the
   guard (mint path).
4. Unwired input (no edge) → today's behavior, no error.

## References

- Project spec: [../../spec.md](../../spec.md) · builds on S1's
  `WiringOutputs` seam.
- `packages/0-framework/1-core/core/src/deploy.ts:237-250` (the loop),
  `:178-218` (`resolveParam`'s idioms this mirrors).
