# U1 — `Prisma.CustomDomain` works on any Branch

Repository: alchemy-run/alchemy (local clone at `wip/alchemy` in the Composer worktree). Parent: [project spec](../../spec.md), [plan § U1](../../plan.md), [design note 2](../../design-notes.md).

## At a glance

Before: `Prisma.CustomDomain("d", { app, hostname })` on an App whose Branch is not the Project's default fails with "Prisma custom domains can only be attached to apps on the default Branch."
After: the domain is created on that App, whatever Branch it is on. PDP has not enforced this rule since its "domains on non-default branches" change (2026-10-23).

## Chosen design

Delete `ensureDefaultBranchApp` from `packages/prisma/src/CustomDomain.ts` and its call in `reconcile`. Reconcile no longer calls `getApp` or `getBranch`. Nothing else in the provider's behaviour changes.

## Coherence rationale

One behaviour removed, its tests and its documentation. One reviewer sitting.

## Scope

In:
- `packages/prisma/src/CustomDomain.ts`: the check, its call, and the doc comments that state the rule (prop JSDoc and resource JSDoc).
- `packages/prisma/src/Website/FrameworkSite.ts`: JSDoc stating the rule.
- `packages/integration-tests/test/Prisma/`: the refusal test in `Resources.test.ts` becomes a test that a domain attaches to an App on a non-default Branch; fakes that exist only to serve the check go; the comment in `Website/CustomDomainDns.test.ts` that cites the rule.
- `website/src/content/docs/prisma/**`: hand-written guide sentences stating the rule. Generated provider reference pages are regenerated with `pnpm docs:gen`, never edited.

Deliberately out:
- `App`, `Compute`, `Branch` and other resources' default-branch behaviour (attaching an App to the default Branch when none is given). Unrelated.
- Any `Prisma.ServiceUrl` work (slice U2).
- Any file outside `packages/prisma`, `packages/integration-tests/test/Prisma`, and the Prisma docs pages.

## Pre-investigated edge cases

None.

## Slice-specific done conditions

- No code path in the Prisma provider checks the App's Branch before creating a custom domain, and a test deploys a `Prisma.CustomDomain` on an App whose Branch has `isDefault: false` and asserts `createAppDomain` was called.

## Open questions

None.
