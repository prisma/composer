# Project Plan — deployment-identity

## Summary

Three slices: two on the control plane that can run in parallel, then one in Composer that ships only after both are in production. Linear project: [Deployment identity](https://linear.app/prisma-company/project/deployment-identity-find-the-project-by-identifier-create-only-when-3f43eb77b990) (P-TML-1156).

**Spec:** `.drive/projects/deployment-identity/spec.md`

The control plane work runs from the clone at `wip/pdp-control-plane` (bot identity, draft PRs per that repo's rules). The Composer work runs on this branch.

## Slices

### Slice 1 — Console creates the Project at connect time (TML-3579, control plane)

The setup-PR path in `connectRepositoryForComposer` creates the Project with the reserved module name as `logicalId` and the region the user chose (already stored on the setup attempt), then creates the link with `projectId` set, the way the "connect without a setup PR" path in `project.create/action.ts` already does. `reflectProjectOnLink` becomes dead and is removed. "Remove setup" (`releasePendingLinkUnlessAdopted`) and the unmerged-PR archive path delete the Project the connect created, when it still holds nothing. The pending-link name-conflict query stops assuming `projectId` is null.

- **Builds on:** nothing.
- **Hands to:** slice 3 — every repo connected from now on has its Project before its first deploy, so Composer can refuse to create.

### Slice 2 — Backfill `logicalId` on linked Projects (TML-3580, control plane)

A script under the control plane's scripts convention: for every live `ProjectScmRepo` with a `moduleName` whose Project has no `logicalId`, set it. Dry-run by default, refuses a value that is not unique in the workspace, prints the remaining count. Run against production once reviewed.

- **Builds on:** nothing.
- **Hands to:** slice 3 — zero linked Projects without a `logicalId` in production.

### Slice 3 — Composer finds by `logicalId` only and creates only with `--create` (TML-3581, Composer)

`resolveProject` drops the display-name match. `ResolveContainerOptions.ensure` becomes a mode with three values: a plain deploy finds the Project or refuses, `deploy --create` finds it or creates it, and destroy finds it or reports that nothing is deployed. The mode is threaded from a new `create` option on the `deploy` operation and `prisma deploy --create` through `LocateContainerInput` and the extension's `ensureContainer`. A miss without `--create` is a structured `DEPLOY.PROJECT_NOT_FOUND` error with the message from the design notes. The decision records on environment resolution and on full-path node addresses are amended, deploying guide and core-concepts skill updated, PR 355 closed.

- **Builds on:** slices 1 and 2 in production.
- **Hands to:** close-out.

## Sequencing

- Parallel: slices 1 and 2.
- Stack: (1, 2) → 3. Slice 3 may be built and reviewed alongside, but is not released until the backfill has run and slice 1 is deployed.

## Close-out (required)

- [ ] Verify all acceptance criteria in `.drive/projects/deployment-identity/spec.md`
- [ ] Migrate long-lived docs into `docs/` (ADR amendments land with slice 3; nothing else is long-lived)
- [ ] Strip repo-wide references to `.drive/projects/deployment-identity/**`
- [ ] Delete `.drive/projects/deployment-identity/`
