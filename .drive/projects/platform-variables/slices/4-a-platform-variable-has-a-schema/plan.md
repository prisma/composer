# 4. A platform variable has a schema: dispatch plan

Spec: [spec.md](spec.md). Section and acceptance item numbers below are the spec's.

Four dispatches, in order. Each leaves the repository building, type-checking and passing its package tests, so each can be reviewed as it lands.

## 1. The input document decodes and validates

**Outcome.** `@internal/input-document` holds the kind rule (5.3), a marker with a `schema` member (5.5), decoding, validating and the four messages (5.6), and the report word (5.5). It depends on `@cfworker/json-schema`, and every built entrypoint a service runs inlines it (5.8). Nothing writes a marker with a schema yet.

**Builds on.** `main`.

**Hands to.** The kind function, the marker constructor that takes a schema, and the decode-and-validate function are exported from `@internal/input-document`. `readDocument` decodes and validates a marker that has a schema.

**Completed when.** Acceptance items 6, 8 (`describeDocument`), 9, 10 and 11 (boot part) pass against hand-written JSON Schemas in the package's own tests; item 15 passes; a marker with `secret` and `schema`, or with a mixed schema, is refused as malformed (the reading half of item 7); existing tests pass.

## 2. `variable()` takes a schema

**Outcome.** Sections 4, 5.1, 5.2, 5.4 and the writing half of 5.5: the constructor's types, the reduction and `$defs` renaming, every refusal, `schema` in the node's `props` and payload, the serializer writing it into the marker, `PlainPointer`, and the `field()` doc comments. A typed variable deploys and boots.

**Builds on.** Dispatch 1's exports.

**Hands to.** `variable({ name, schema })` works at deploy and at boot on Prisma Cloud. `prisma dev` does not yet decode in its preflight.

**Completed when.** Acceptance items 1 to 5, 7 and 8 pass, with real ArkType and Zod schemas; existing tests pass.

## 3. `prisma dev` decodes and validates

**Outcome.** Section 5.7 and section 6: the dev preflight decodes and validates each plain variable's text with dispatch 1's code and stops with boot's message and the reader sentence; the integration fixture has a typed plain variable.

**Builds on.** Dispatches 1 and 2.

**Completed when.** Acceptance items 11 (dev part), 12, 13 and 14 pass; `bun run test/local-dev.integration.ts` from `test/integration`, run alone, passes.

## 4. Records, guides and skill

**Outcome.** Section 7: every record, glossary entry, domain doc, guide and the skill it lists is rewritten in place; `design.md` is amended as section 12 says; `deferred.md` gains the input document's size; the release note is drafted in `wip/s4/pr-body.md`.

**Builds on.** Dispatch 3: the code is final.

**Completed when.** Every record the spec lists says what the spec says; the docs checks in CI's lint job pass locally.

## After the dispatches

`/drive-code-review` on the whole slice, with its findings fixed; QA on Prisma Cloud as the spec's "Done when" lists; then the pull request.
