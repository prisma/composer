# A2 — `prisma deploy list` lists what is deployed on a stage

## At a glance

```
$ prisma deploy list --stage pr-42
ADDRESS                KIND      PLATFORM ID   URL
shop                   project   proj_123
shop.api               service   svc_456       https://….prisma.app
shop.catalog           module
shop.catalog.db        postgres  db_789
shop.files             bucket    bkt_012

$ prisma deploy list --json            # production, machine-readable
```

## Chosen design

From design note 8, grounded in the code at `origin/main` `87d001de`:

- **Where it lives.** `packages/9-public/composer-cli`, next to `emulator list`. It reads Prisma Cloud data, and the framework CLI has no extension hook for "read what is deployed". Adding one for a single command is not worth it.
- **What it reads.** The stage's application topology (`GET /v1/projects/{projectId}/branches/{branchId}/application-topology`), which every deploy writes. Not the Alchemy state: reading that needs the deploy lease and would collide with a running deploy.
- **The join.** Each topology node is one row of output, in topology order. Its platform row is found by `logicalId` in the Branch's services, databases and buckets lists (filtered by `projectId` and `branchId`). The root node's row is the Project.
- **Kind.** `project` for the root, `service`, `postgres` for both Postgres types, `bucket`, `module` for other modules. Any other resource shows its topology `type`. A node with no platform row has an empty platform ID.
- **URL.** Services only: the row's `appEndpointDomain`, which is already a full `https://` URL and is the same URL a deploy prints.
- **Finding the stage.** The same find-only lookup deploy uses: the Project by `logicalId` (the app name), the Branch by `gitName`, production when no `--stage` is given. The app name comes from the entry, as `deploy` resolves it (`resolveAppIdentity`), with `--name` and `--entry` working as on `deploy`.
- **Nothing deployed.** No Project, no Branch, or no topology (404 or no nodes) fails with `DEPLOY.TARGET_NOT_FOUND`, naming the app and stage.
- **Output.** Human: a table. `stdout`: one tab-separated line per node. `--json`: an array of `{ address, kind, platformId, url }`, with `null` for missing values.
- **Mounting in `prisma`.** The `prisma` host in prisma/prisma-cli mounts each Composer command by name. A small prisma-cli PR adds `"deploy list"` next to `"emulator list"`.
- **Design records, in this PR.** ADR-0053 (or ADR-0050, whichever lists the family's commands) gets an amendment for `deploy list`. `deploy-cli.md`, `docs/guides/deploying.md` (a short section on listing a stage), and the agent skill show it.

## Scope

**In:** everything above.

**Out:**
- Platform rows with no topology node (for example after a failed topology write). The topology drives the list.
- Showing a node's status or its last deploy.
- Addresses on platform commands (B1).

## Pre-investigated edge cases

- The topology is written before the apply, and the write is best-effort. After a failed deploy a node may have no row; it lists with an empty platform ID.
- S3 credentials resources and non-root modules have no row.
- Production has no Branch filter for `isDefault`; reuse the existing paged lookup.

## Slice-specific done conditions

- Against a real deployed stage, the command lists every node with the right IDs and URLs.
- The e2e deploy workflow runs it after deploy and checks its `--json` output against the platform rows. Until prisma-cli ships `deploy list`, the check may run the Composer command family directly rather than through `prisma`.

## Open questions

None.

## References

- [Project spec](../../spec.md), [design notes](../../design-notes.md) decision 8.
- ADR-0023, ADR-0024, ADR-0043, ADR-0044, ADR-0050, ADR-0053, ADR-0057.
- `docs/design/05-prisma-cloud/pdp-data-model.md`, `build-reporting.md`.
