# System design review — D1, regenerated `@distilled.cloud/prisma` (distilled)

Range: `origin/main...feat/prisma-routing-urls` at `ecdf829a1`. Expectations: [spec.md](../../spec.md), [plan.md](../../plan.md) step D1, `wip/pr-bodies/distilled.md`, pdp-control-plane `origin/main`.

## What changes

The generated Prisma Management API client gains the RoutingUrl operations and the domain ownership status model. One hand-written input changes: patch 005 stops typing `DomainOwnershipRequired` on the workspace domain ownership create, because the platform now saves the row `unverified` instead of refusing it.

## Fit

- **Generated, not hand-written.** Every new surface comes from the spec. The only hand edit is a patch, which is the repository's rule.
- **The breaking change is real and correctly flagged.** Removing a typed error from an operation's union breaks any `catchTag("DomainOwnershipRequired")` on `createWorkspaceDomainOwnership`. The only caller is alchemy-run/alchemy#2701, which D2 replaces. The `!` in the title is right.
- **Names follow the generator's path-based scheme** (`createServiceUrl`, `getProjectBranchUrls`, `createDomainOwnershipVerify`, `createUrlCheck`). They read oddly (`createUrlCheck` for "check a URL") but changing them needs `opAliases` metadata, and consistency with the rest of the generated client matters more. No action.
- **Typed errors are where the design falls short.** The spec makes the RoutingUrl's 409 and 422 cases distinct errors so D3 can fail with one that names the conflicting row. Distilled is the layer that owns that typing (Alchemy's typed-error rule). Without it, D3 must either inspect error bodies (forbidden in Alchemy) or report a generic conflict. See code review F01.
- **The client hides whether a create created anything.** Both the domain ownership create and the legacy custom domain create are idempotent on the platform and say which case happened only through 201 vs 200. A generated client that drops that fact pushes callers to guess, which is the root of two D2 findings. Whether to expose it is a core decision; this pull request is the natural place to raise it. See code review F02.

## Test strategy

Generated code is tested through its consumers. D3's fake and live tests are the evidence for the RoutingUrl operations. The patch audit (`patches:audit prisma`) confirms every patch still applies.

## Out of scope for this pass

Details and AC verification are in [code-review.md](code-review.md).
