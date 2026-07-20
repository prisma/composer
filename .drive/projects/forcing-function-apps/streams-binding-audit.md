# Audit: the streams binding as built on `claude/streams-minted-key`

Status: written 2026-07-17 on Will's halt order, for his audit. All dispatch
work is stopped; nothing further executes until he rules on the decisions at
the end. Everything below was read from the code at `655bda1` (and verified
by running probes where stated), not taken from any implementer's report.

Scope: the streams module end to end as it exists on the branch — the
contract model and its type-level hole (the trigger for this audit), the
client and handle behavior, the provider-param provisioning pipeline (Part
A), and a complete inventory of every point where correctness rests on an
unenforced invariant. Deviations from the recorded design doc
([streams-binding-design.md](streams-binding-design.md)) are listed
explicitly.

---

## 1. What is actually checked, where

Core's contract model ([contract.ts](../../../packages/0-framework/1-core/core/src/contract.ts))
is two mechanisms:

- **Authoring time (compile):** wiring compatibility is plain TypeScript
  assignability on `Contract<Kind, Cmp>`, checked where a provider's
  ref-port is passed into a consumer slot at `provision()`. Core never
  inspects `Cmp`; the *kind's builder* is responsible for shaping `Cmp` so
  that assignability means something. RPC does this properly: its `Cmp` is
  the concrete function map, so assignability applies real function
  variance.
- **Load time (runtime):** `ref.satisfies(required)` as a backstop
  ([load-module.ts:85](../../../packages/0-framework/1-core/core/src/load-module.ts)).

For streams, as built:

| Moment | What it verifies for a streams edge |
|---|---|
| Compile, wiring | **Nothing beyond `kind: 'streams'`.** The provider port is `Contract<'streams', never>`; `never` is assignable to every consumer's `Cmp`, so the check passes vacuously for any def map. |
| Load, `satisfies` | `required.kind === 'streams'`. Kind only. |
| Deploy | Part A's provider params (§4): the minted key row is written, schema-known. |
| Boot | The key row is schema-validated (`string`) before the service can use it. |
| Runtime | Nothing validates stream names or events. Untyped by design in this slice. |

The semantic claim behind the vacuous pass is true: the Durable Streams
server is schema-agnostic — it will serve any stream name — so *any* streams
provider genuinely does satisfy *any* streams consumer. The defect is not
the absence of checking (nothing checkable exists yet); it is that the
absence was encoded as a type-level lie instead of stated honestly (§2).

## 2. The `never` provider contract — the hole, precisely

**As built** (`packages/1-prisma-cloud/2-shared-modules/streams/src/contract.ts`):

```ts
export const streamsProviderContract: Contract<'streams', never> = Object.freeze({
  kind: 'streams',
  __cmp: blindCast<never, '…'>(undefined),
  satisfies: (required) => required.kind === 'streams',
});
```

Why it exists: the `streams()` module's exposed port must satisfy every
consumer's `streamsContract(defs)`, whose `Cmp` is a *literal* record type
(`{ jobs: StreamDef }`). A wide `Record<string, StreamDef>` is **not**
assignable to a literal record (an index signature does not supply a
required literal property — verified). `never` is assignable to everything,
so it passes. D2 chose it and manufactured the impossible value with
`blindCast<never>(undefined)`.

What is wrong with it, concretely:

1. **The runtime value lies about its type.** `__cmp` is declared `never` —
   "no value can exist here" — and holds `undefined`. Everything downstream
   that could ever touch a provider's `__cmp` is now trusting the comment
   "nothing reads this," which no test or type enforces. If any future code
   path reads a provider's `__cmp` (e.g. a diagnostic, a future typed
   `satisfies`), it receives `undefined` where the type system promises it
   cannot even be asked, and the failure will not point back here.
2. **It cost a real dependency.** `@internal/streams` now depends on
   `@internal/foundation` solely to manufacture the impossible value.
3. **It normalizes the wrong idiom.** The next kind with a schema-agnostic
   provider will copy it; `never`-plus-cast becomes the house pattern for
   "provider can't know," when an honest encoding exists.

**The honest encoding exists and is proven.** I verified this with a
typecheck probe against the real core types before writing it here (probe
run, passed, deleted — both its `@ts-expect-error` checks consumed, meaning
literal-key handle typing and wrong-kind rejection both still hold):

- The consumer's **binding type** keeps the literal defs:
  `durableStreams<D>(contract: Contract<'streams', D>)` still hydrates to
  `StreamHandles<D>` with exact keys.
- The consumer's **required type** (what wiring compatibility is checked
  against) is typed wide: `DependencyEnd<StreamHandles<D>, Contract<'streams', StreamDefs>>`.
  Widening is plain safe assignability (`D extends StreamDefs`), not a cast.
- The provider port becomes `Contract<'streams', StreamDefs>` with
  `__cmp: {}` — **an empty record is a legitimate `StreamDefs` value.** No
  `never`, no `blindCast`, no foundation dependency, no unenforced
  invariant. A postgres-like contract still fails the wiring check.

This encodes the truth directly: "what a streams consumer requires of its
provider is *that it is a streams provider*" — which is exactly what the
kind-only `satisfies` already says at runtime. Type and runtime then make
the same claim. Recommendation R1.

What this does **not** fix, because it is not fixable at wiring time: two
consumers of one module naming the same stream with different (future
typed) defs. The server cannot attest to event shapes; the recorded
follow-up slice puts validation at the reading edge, which is the same trust
model RPC uses for outputs. That part of the design stands.

## 3. Behavior changes that shipped inside the "refactor" (Part B)

The design doc authorized moving the lifecycle into handles. The following
went further than the doc's words, and each is a real behavior decision:

| # | Was | Now | Risk / note |
|---|---|---|---|
| B1 | `client.create(name)` public, ensure-style | **No public create at all.** First `append`/`read`/`tail` creates, memoized per handle (`ensureCreate` private). | Doc said "no variant *requires* the app to create"; D2 made deliberate creation *impossible*. Defensible reading, but it is a removal, not a move. |
| B2 | Reading a never-created stream → 404 error | **Reading it creates it** and returns an empty page. | The old test pinning the 404 was deleted as "obsolete by design." For an app author, "read errors" vs "read silently manufactures an empty stream" is a real difference — a typo'd dynamic name now yields plausible-looking empty data instead of a failure. Contract-declared names are reviewed identifiers, so the primary path is fine; the dynamic `stream(name)` path carries the risk. |
| B3 | `create(name, { contentType })` — caller could choose | `JSON_CONTENT_TYPE` hardcoded internally. | Capability silently dropped. Nothing on the branch needs it; the module is JSON-events by contract. Should be a recorded decision, not an accident. |
| B4 | `isStreamNotFound` exported | Module-private again | Correct; its only consumer was the app-side heal, which no longer exists. |

The heal and append safety are **unchanged in substance** and their tests
moved with teeth re-verified (no-retry mutant fails the 503 wire-count
test; no-batch mutant yields 2-not-5 POSTs; gutting the heal fails the heal
test). `IDEMPOTENT_BACKOFF` untouched — mandatory, since PRO-217 was
reproduced live today (three closes; see the canary section of gotchas.md).

## 4. Part A as built (provider params) — audit summary

Reviewed SATISFIED by an independent pass that re-derived every claim; the
shape on the branch after D1c:

- Provider-side minted values (`RPC_ACCEPTED_KEYS`, `STREAMS_API_KEY`) are
  **declared reserved params**: name + arktype schema in per-brand modules
  (`service-keys.ts`, `streams-keys.ts`, each carrying its `brand`);
  the boot list `RESERVED_PROVIDER_PARAMS` in `provider-params.ts` (runtime-
  safe, imports no deploy machinery); `control.ts` holds only the deploy-side
  `value(refs)` functions and **derives** its registry from the boot list,
  throwing at module load on a missing value — deploy cannot write a row
  boot never stashes. A further test pins `PROVISIONERS` ↔ `PROVIDER_PARAMS`
  brand coverage (the fail-open path where keys are minted but no provider
  row is written).
- `restashAddressFree` (the raw whole-namespace env sweep) is deleted;
  boot is deserialize → typed stash → provider-param stash → secret
  pointers → `PORT`. A present-but-invalid row fails loudly; an absent row
  stashes nothing ("never provisioned" semantics preserved — `serve()`
  pass-through, streams entrypoint refuses to boot).
- Provider params are excluded from `config()`'s `Values<P>` (verified at
  type level during review with consumed `@ts-expect-error` probes).
- Zero-consumer rpc provider stores byte-exact `"[]"` (deny-all); traced
  through deploy encode → stash → `serve()`'s parser during review.

Two facts about the boot side an auditor should know:

- The boot list is a **static two-entry array in the runtime bundle**. It
  cannot be fed from `control.ts`'s registry because `run(address, boot)`'s
  signature is fixed by target-agnostic lowering and a schema is code, not
  storable data. A new brand edits its own keys module + `control.ts`'s
  value map; the derivation makes forgetting one a load-time throw, not a
  silent fail-open.
- `descriptors/compute.ts`'s `Output.isOutput(raw)` true-branch — the branch
  **every real deploy takes** — has no test. The test suite mocks Alchemy's
  `Output` process-wide, so tests only ever exercise the plain-value branch.
  A correctness failure there is bounded (boot's schema check rejects the
  stringified expression object; loud, not fail-open) and the D3 live deploy
  exercises it for real, but it is an untested production conditional and
  two honest attempts to test it produced only order-dependent flakes.
  Recommendation R5.

## 5. Trust inventory — every unenforced invariant on the branch

Every point where correctness rests on something no type or test enforces,
in one place. "Enforced by" names the strongest existing guard.

| # | Location | The claim being trusted | Enforced by | If false |
|---|---|---|---|---|
| T1 | `contract.ts` `streamsProviderContract.__cmp` | No code ever reads a provider contract's `__cmp` | Comment only | Reader receives `undefined` typed as `never`; failure surfaces far from the lie. **Fix available: R1 removes the lie entirely.** |
| T2 | `control.ts` provisioned-ref cast (`Output<string>`) | Refs keyed by a brand's edges were produced by that brand's sole registered provisioner | Registration locality (one file) + review | Wrong ref shape flows into an env row; boot's schema check catches non-strings loudly |
| T3 | `serve.ts:65` reads `COMPOSER_RPC_ACCEPTED_KEYS` | Every target hosting an rpc provider stashes that exact slot, decoded shape `string[]` | Part A tests for this target; the slot name is a cross-package string constant in two packages | A new target that forgets → `serve()` pass-through = **fail-open**. Cross-package contract has no shared constant; rpc's `RPC_ACCEPTED_KEYS_ENV` and the target's param name coincide by spelling |
| T4 | streams entrypoint reads `COMPOSER_STREAMS_API_KEY` | Same slot contract, target-side | Entrypoint integration test (spawns real entrypoint; JSON.parse removal verified to fail it) | Refuses to boot (fail-closed) — safe direction |
| T5 | Heal predicate (`instanceof FetchError/DurableStreamError` + `status === 404`) | Electric's error classes are the same module instance in app and lib; a 404 is generated instead of a write at every layer | Review round 11's protocol trace; heal test | If class identity split (dual bundling), heal never fires — fail-safe (no retry). If a 404-after-apply existed, duplicate append — protocol-traced as impossible |
| T6 | `satisfies` kind-only (streams, both sides) | The server really serves any stream name; def conflicts between consumers are acceptable until typed defs land | Design decision, recorded | Two consumers' conflicting future-typed defs are undetected at wiring; caught at reading edge only |
| T7 | `Output.isOutput` true-branch (§4) | Real deploys produce `Output`s that the branch maps correctly | Live deploy only | Env row holds a stringified expression object; boot rejects loudly |
| T8 | Boot list ↔ deploy registry (Part A) | The two-entry list covers every brand that mints | Load-time throw + coverage tests (D1c) | Was the fail-open drift path; now structurally closed |
| T9 | Canary's cross-clock margin (2s) | Runner and VM clocks agree within 2s | NTP assumption, measured ≈0 skew once | A touch near the margin is classed `unknown` (inconclusive), not guessed — degrades safe |

Cast movement on the branch vs main: **+2 / −1** (`control.ts` gained the
relocated provisioned-ref cast when the old one left `descriptors/compute.ts`;
`contract.ts` gained the `never` cast). The ratchet reads delta 0 against
its merge-base; the net-new cast of this slice is T1, and R1 deletes it.

## 6. Deviations from the recorded design doc

| Doc said | Branch does | Verdict |
|---|---|---|
| "Ensure-create on first use" | Also: no explicit create exists (B1), read-creates (B2), contentType dropped (B3) | Went further than authorized; needs Will's ruling |
| Silent on provider port typing | `Contract<'streams', never>` + cast (T1) | Unauthorized encoding decision; R1 replaces it |
| Silent on def value shape | `StreamDef = { kind: 'stream-def' }` marker | Good: an empty `{}` would type-accept anything (`streamsContract({ jobs: 123 })` would have compiled). Keep; back-record in doc |
| `streamDef({ event })` deferred, nothing half-lands | Honored — no schema parameter exists | Matches |
| Handles own name/lifecycle; example = routes + error mapping | Matches; example has zero lifecycle/wire imports | Matches |
| Part A design | Matches after D1b/D1c, one addition: registry **derivation** (stronger than the doc's two-lists-plus-test) | Matches, improved; back-record |

## 7. Decisions — Will rules, nothing proceeds until then

- **R1 (the trigger): replace the `never` encoding with the wide-required
  encoding.** Provider port `Contract<'streams', StreamDefs>` with honest
  `__cmp: {}`; consumer `required` typed `Contract<'streams', StreamDefs>`
  while the binding keeps literal `StreamHandles<D>`. Proven by probe
  against real core types: literal handle keys preserved, wrong-kind still
  rejected, `never`/`blindCast`/foundation-dep all deleted. My
  recommendation: do it; it is a small, mechanical change confined to
  `contract.ts` + the module's expose type.
- **R2 (B1/B2): decide the missing-stream read semantics.** Options:
  (a) keep read-creates (as built); (b) restore a 404 on read of a
  never-created stream while keeping append/tail auto-create; (c) restore an
  explicit ensure-`create()` on the handle and make it required before
  reads of dynamic names. My recommendation: (a) for contract-declared
  names, and I lean (a) overall for symmetry — but this is an app-facing
  semantic you should choose knowingly, since B2 turns a typo into empty
  data instead of an error on the dynamic path.
- **R3 (B3): contentType.** Record its removal as deliberate (my
  recommendation — the module is JSON-events by contract and the typed
  follow-up would own any future negotiation), or restore the option.
- **R4: back-record §6's items in the design doc** once ruled (my job, not
  an implementer's).
- **R5 (T7): accept the untested `isOutput` branch with the D3 live deploy
  as its proof, or require a test.** An honest test needs the Output mocking
  de-globalized in `control-lowering.test.ts` (per-file mock hygiene) —
  roughly a half-day of test refactoring. My recommendation: accept for this
  slice, file it as debt with the follow-up.
- **R6 (T3): the rpc accepted-keys slot name is spelled independently in two
  packages.** Worth a shared constant or a cross-package test so a rename
  cannot fail open. Small; could ride R1's commit or the follow-up.

Nothing in this audit found a fail-open defect live on the branch. The two
fail-open *classes* found during the work (deploy-writes-boot-never-stashes;
minted-keys-without-provider-row) were both closed structurally in D1c and
have biting tests. The `never` contract is not a runtime hazard today — it
is a type-system lie with an available honest replacement, and it is the
kind of lie that becomes a runtime hazard the day someone believes it.
