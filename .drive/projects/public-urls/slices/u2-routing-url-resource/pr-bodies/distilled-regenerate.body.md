## What this changes

Prisma's Management API has a new RoutingUrl state, `no_domain_ownership`, and this adds it to the Prisma SDK's types. Alchemy's `Prisma.RoutingUrl` acts on that state, and today it has to compare it as a plain string:

```diff
-const hasNoDomainOwnership = ({ state }: { readonly state: string }) =>
-  state === "no_domain_ownership";
-if (hasNoDomainOwnership(current)) {
+if (current.state === "no_domain_ownership") {
```

A RoutingUrl is Prisma's record that a hostname serves an app (routes under `/v1/urls`; the generated types are named after the operations, such as `getUrl` and `createServiceUrl`). The new state means that no domain ownership, Prisma's proof that the workspace owns the hostname, covers it, so the hostname cannot serve until one is created and verified. Every RoutingUrl response type gains it: create, get, update, check, and both lists.

```diff
 export type GetUrlResponseDataState =
+  | "no_domain_ownership"
   | "not_verified"
   ...
```

This is breaking for code that handles every state exhaustively, such as a `switch` with no default: it now has a case to handle.

`packages/prisma` is generated from Prisma's OpenAPI spec, mirrored in the submodule `specs/spec-mirror-prisma-postgres`. This moves the submodule to the mirror's 2026-11-26 commit (`e1403bdd`), the first with the new state, and regenerates. #1348 was generated on the 2026-11-21 spec, before Prisma added the state on 2026-11-25.

The new spec also changes two other things:

- **`createDomainOwnership` now defaults to `false`** on create and update RoutingUrl (it was `true`). A caller that leaves it out no longer gets a domain ownership created for the hostname; pass `true` to keep the old behaviour. The generated type does not change (the field was already optional), only its doc comment. Alchemy always sends the field.
- **Three creates declare a 409** with the codes `quota-exceeded` and `client-error`: `POST /v1/databases`, `POST /v1/projects` and `POST /v1/projects/{projectId}/databases`. They still fail with the existing `Conflict` error, and no new error class is added. The third had no 409 in the spec before, so patch `003-add-conflict-responses` added one. This removes that operation from the patch, because the spec now declares it; with both, `createProjectDatabase` would list `Conflict` twice.

No operation or field is removed.

Alternatives considered:

- **Keep the string comparison in Alchemy.** It works, but the type system cannot catch a misspelled state, and every other consumer of the SDK would also miss the state.
- **Add only the state with a patch on the 2026-11-21 spec.** The patches here fill gaps in Prisma's spec. The spec now lists the state, so a patch would duplicate it and still leave the SDK behind the API's other changes.

## The failing call

Operation: `getUrl` (and every other RoutingUrl operation)

Request: `GET /v1/urls/{id}` for a RoutingUrl whose hostname no domain ownership covers.

Response: `"state": "no_domain_ownership"`, which the generated `GetUrlResponseDataState` did not list. Evidence: the state is in Prisma's published spec from the mirror's 2026-11-26 commit (`e1403bdd`).

## Checklist

- [x] I followed every rule in [CONTRIBUTING.md](https://github.com/alchemy-run/distilled/blob/main/CONTRIBUTING.md) and in [External contributors](https://github.com/alchemy-run/distilled/blob/main/AGENTS.md#external-contributors) in AGENTS.md
- [x] One change, with no commits from another open PR (rule 10)
- [x] A breaking change has `!` in the title, for example `fix(axiom)!: redact API tokens` (rule 11)
- [x] A spec or patch change commits the `pnpm generate <pkg>` output and its `distilled.generatedAt` stamp (rule 12)
- [x] `pnpm lint` passes, and any lint-disable comment has its reason in this body (rule 4)
- [x] If this breaks a type alchemy-run/alchemy uses, the Alchemy PR is linked here (rule 13): alchemy-run/alchemy#3529
- [x] "Allow edits by maintainers" is ticked (rule 14)

Agent: lassie-43

> [!NOTE]
> This comment was left by an agent on behalf of @wmadden
> model: opus 5.5
> harness: Claude Code desktop (claude-desktop, Agent SDK 0.3.331)
>
> As an agent I have read the CONTRIBUTING.md and AGENTS.md and understand the risks of getting @wmadden flagged as untrustworthy if I regularly violate the outlined rules
