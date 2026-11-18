# Slice 2 dispatch plan

Spec: [spec.md](spec.md). Five dispatches, in order. Each lands as one or more commits on `claude/platform-variables-s2` with its tests green; the next starts from that state.

## D1. The input document carries `$platform`, and boot reads it

**Outcome:** one package holds the marker format, and the serializer, boot and the local target all use it. Spec 2.3, 2.4, 2.5.

- Builds on: `main`.
- Delivers: `@internal/input-document` with its architecture entry; the serializer writes `$platform` and drops `$secret`; distinct names for `$generated` only; `InputDocumentRow.variables`; the compute descriptor's triggers read it and its `input` detail prints `$platform NAME`; boot's four steps, empty means unset, the per-key param rule and its new error; the local target imports the shared package and its copies go; the invariants test's file list updated.
- Hands to: D3 (preflight reads `variables` and the marker walk) and D4 (the report detail).
- Completed when: the target, local-target and CLI test suites pass; `dev-pointed-variables.test.ts` proves both sides agree; a planted-secret boot test passes.

## D2. Names, and the graph check hook

**Outcome:** a bad name fails Load with one checker's message, and an extension can refuse a graph right after Load in every command that runs Load. Spec 2.1, 2.2.

- Builds on: D1 (nothing structural; sequential to avoid conflicts in `secret.ts`/`param.ts` tests).
- Delivers: `checkGraph` on `ExtensionDescriptor`, called in `runPipeline` after Load and before coverage, surfaced as `COMPOSE.GRAPH_INVALID`; `assertVariableName` in the target, used by `envSecret()` and `envParam()`; the target's `checkGraph` refusing `envParam()` plus a root input field of one name; the seeding-era preflight test that builds a graph Load refuses removed.
- Hands to: D3 (the checker is reused by nothing in slice 2, but preflight's names are now known valid).
- Completed when: core, CLI and target tests pass; a pipeline test shows the hook runs for deploy, dev and destroy and not for `resolveAppIdentity`.

## D3. Preflight reads existence and decides required or reported

**Outcome:** `prisma deploy` writes no variable, refuses only a required one, and returns findings for the rest. Spec 2.6, target side.

- Builds on: D1 (`variables`, the marker walk) and D2 (valid names).
- Delivers: `fillMissing` and its tests gone; one list call per name, at most eight at a time; the branch row over the class row for `updatedAt`; `isManagedBySystem` refused; the ADR-0058 method moved where both preflights use it and applied per service, with the array-position and per-key rules; module-input secrets no service reads reported, never required; the required error text; the findings value returned beside the `updatedAt` map and serialised on the preflight transport.
- Hands to: D4 (the findings type and the transport payload).
- Completed when: `preflight.test.ts` and `preflight-payload.test.ts` pass with the new assertions; a test shows `POST /v1/environment-variables` is never called.

## D4. The findings reach the operator, and `prisma dev` follows the same rules

**Outcome:** the operator sees every variable with no value after the preflight step and in the deploy report, and `prisma dev` applies the per-key rule. Spec 2.6 CLI side, 2.7, 2.8.

- Builds on: D3 (the findings type).
- Delivers: `PreflightInput.report` carries findings; a new CLI event the human renderer prints as the `Platform variables with no value:` block and the JSON renderer carries; step data keeps `checked` and `unset`; the second process repeats the block at the end of the deploy report; the dev preflight's per-key param rule; `@deprecated` on `envParam()`.
- Hands to: D5.
- Completed when: `operations.test.ts`, `deploy.test.ts`, `local-target-preflight.test.ts` pass; the "an app secrets value appears in no event, result or report" test still passes with the findings in the events.

## D5. Records, guides and the release note

**Outcome:** every record matches the code. Spec 2.9, 2.10.

- Builds on: D1 to D4.
- Delivers: ADR-0064 and its index line; ADR-0029, 0032, 0042, 0058, 0062 rewritten in place; the five glossary entries; `goals.md`; the doc comments in `app-config.ts`; `deploying.md`, `building-an-app.md`, `deploy-cli.md`, the core-concepts skill; the release note drafted at `wip/pv-review/pr-s2-body.md`.
- Completed when: `pnpm lint` passes and a grep for "preflight fills", "fills a missing" and `$secret` over `docs/`, `skills/` and source doc comments finds only the release note's before/after.
