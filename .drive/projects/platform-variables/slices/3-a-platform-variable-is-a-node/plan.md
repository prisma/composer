# 3. A platform variable is a node: dispatch plan

Spec: [spec.md](spec.md). Section and acceptance item numbers below are the spec's.

Six dispatches, in order. Each leaves the repository building, type-checking and passing its package tests, so each can be reviewed as it lands. The first three add the node beside `envSecret()` and `envParam()`; the fourth removes the two functions; the fifth rewrites the records and guides; the sixth makes a platform variable go into `input` only, as decided on 2026-11-17.

The nodes are added before the functions are removed because the examples, fixtures and tests can only move off the functions once the node works at deploy and under `prisma dev`.

## 1. Core: a resource can be a value

**Outcome.** Core has the value resource, and `provision()` handles it as sections 4.1 to 4.4 and 4.6 say: only an `appRoot()` body can provision one, the returned copy records the node's address, a duplicate id names the node already at the id, the graph has `valueReads`, every secret value resource is in the graph's secret sources, and the deploy report has no entry for a value resource.

**Builds on.** `main` plus the design documents.

**Hands to.** `valueResource()`, `isValueResource()`, the `ValueResourceNode` and `SourceValue` types and the `VALUE_RESOURCE` key type are exported from `@prisma/composer` and `@internal/core`. `Graph.valueReads` exists on every graph. `envSecret()`, `envParam()` and `configurationKey` still work unchanged.

**Completed when.** Acceptance items 2, 11, 12, 13 and 14 pass in core, with a test value resource built in the tests; the duplicate-id part of item 6 passes; the core part of item 16 (no report entry) passes; every existing test in the repository still passes except the one `app-root.test-d.ts` assertion the spec replaces.

## 2. The Prisma Cloud target: `variable()` and `variable.secret()` at deploy

**Outcome.** An app can provision a platform variable node in its root and deploy it: sections 5.1 to 5.5 and 5.7. The constructors, the payload, the descriptor that creates nothing, the topology skip, graph check rules 1 to 3, the `$platform` marker for plain and secret nodes, the pointer row for a plain node in a per-key param (dispatch 6 removes it), the schema-failure suffix naming the variable, and deploy preflight for node names, including unread nodes listed once.

**Builds on.** Dispatch 1's exports and `valueReads`.

**Hands to.** `variable` and the `PlatformVariablePayload` type are exported from `@prisma/composer-prisma-cloud`. A node's value works wherever an `envSecret()` or a per-key `envParam()` works at deploy; dispatch 6 removes the per-key part. Slice 2's graph check rule for `envParam()` and both functions still exist beside the new rules.

**Completed when.** Acceptance items 1, 3, 4, 5, 6, 7, 8, 15, 16, 17 and 20 pass; existing tests still pass.

## 3. `prisma dev` fills plain platform variables

**Outcome.** Section 5.6. The dev preflight works out each plain node's text, `prisma dev` hands the texts to the second process in the app configuration file as `plainVariableText`, checked against the known secrets, and the local target fills markers and per-key pointers from them (dispatch 6 removes the per-key pointers). After a rebuild, a change in the app's reads pauses rebuilds with the message the spec gives.

**Builds on.** Dispatch 2's payload and name lookup; dispatch 1's `valueReads`.

**Hands to.** `DevPreflightResult` is exported beside `LocalTargetDescriptor`. `LocalTargetProvidersInput` and the app configuration file carry `plainVariableText`. The old `configurationKeyText` members still exist beside it, for `envParam()`, until dispatch 4.

**Completed when.** Acceptance items 18 and 19 pass, except the parts of 19 that say `configurationKeyText` is gone; existing tests still pass, including `bun run test/local-dev.integration.ts` and `bun run test/local-dev-store.integration.ts` from `test/integration`, each run alone.

## 4. `envSecret()` and `envParam()` are removed

**Outcome.** Sections 4.5, 5.8 and 6. The two functions, `secretName()`, core's `configurationKey` and `configurationKeyText`, and all code that exists only for them are gone. `absentSecrets` is `absentVariables`. Every example, fixture, shared-module test and README uses the nodes or a root input field; `examples/env-param` is `examples/root-input`. Every message and doc comment in the code that named a removed function says what the spec says, and the code part of the terminology sweep (section 7) is done.

**Builds on.** Dispatches 1 to 3: the node works at deploy and under `prisma dev`.

**Hands to.** No file under `packages/`, `examples/`, `test/`, `website/` or `scripts/` names `envSecret`, `envParam`, `secretName`, `configurationKey` or `absentSecrets`, except tests that assert they are absent.

**Completed when.** Acceptance items 21, 22 and 23 pass, and the rest of item 19; `grep` finds no use of the removed names in the folders above; build, typecheck, lint, the dependency lint and the cast check pass for the whole repository; package tests pass.

## 5. Records, guides and skill

**Outcome.** Section 7. Every decision record, glossary entry, principle, domain doc, guide and the skill the spec lists is rewritten in place as the current statement, and teaches the two ways to get a value. The pull request description draft holds the release note of section 8.

**Builds on.** Dispatch 4: the code is final, so the records describe it.

**Hands to.** The slice's "Done when", ready for `/drive-code-review` and QA.

**Completed when.** No file under `docs/` or `skills/` names `envSecret()` or `envParam()`, except the two friction logs the spec leaves as they are and decision records' "Alternatives considered"; every record the spec lists says what the spec says it must; the skill is staged; the docs checks in CI's lint job pass locally.

## 6. A platform variable goes into `input` only

**Outcome.** The decision of 2026-11-17 (`wip/handover/port-decision.md`), as the spec now states it in 4.6, 5.2, 5.4, 5.5 and 5.6: a platform variable node's value goes into a field of a service's or a module's `input` only; a per-key param takes a literal or a deploy-time value and no source; the pointer row, `paramName()` and all per-key handling in preflight, the dev preflight and the local target are deleted; `ValueRead` is `{ reader, resource, path }`; the rebuild check keys a read by reader, resource and path. The records, guides and skill say the same.

**Builds on.** Dispatches 1 to 5.

**Hands to.** The slice's "Done when", ready for `/drive-code-review` and QA.

**Completed when.** Every point of the decision holds, each proved by a test: the compiler refuses a source in a per-key param; Load refuses a source cast into one, with the message in 5.4; no pointer row is written or read; `paramName()` is not exported; `valueReads` entries have `path` and no `site`; and the integration fixture binds its plain node to an input field. Acceptance items 3, 11, 15, 17, 18 and 21 pass as the spec now states them.

## After the dispatches

`/drive-code-review` on the whole slice, with its findings fixed; QA on Prisma Cloud as the spec's "Done when" lists; then the pull request.
