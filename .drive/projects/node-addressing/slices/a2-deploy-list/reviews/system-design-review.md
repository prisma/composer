# System-design review — A2 `prisma deploy list`

Range: `origin/main...drive/deploy-list` (merge base `87d001de`, head `2e16ca74`, 12 commits).
Spec: [../spec.md](../spec.md). No pull request yet.

Read before reviewing: `docs/design/01-principles/` (both files), the ADR index, ADR-0050 and ADR-0053 with their new amendments, ADR-0044's `DEPLOY` codes, `docs/design/10-domains/deploy-cli.md`.

## What the branch adds

A read-only command, `deploy list`, that prints one row per node of the application topology the last deploy wrote to a stage's Branch, joined by `logicalId` to the Branch's service, database and bucket rows. Three new pieces carry it:

- `readDeployedStage` in the Prisma Cloud lowering package (`packages/1-prisma-cloud/0-lowering/lowering/src/deployed.ts`). It finds the Project and Branch with the existing find-only `resolveContainer`, reads the topology, and lists the Branch's rows filtered by `projectId` and `branchId`.
- `resolveAppIdentity` and `validateStageName`, exposed on a new `@internal/cli/app-identity` subpath, so a command can learn the app name without Load or assembly.
- The command itself in `@prisma/composer-cli`, next to `emulator list`, with the join as a pure function (`deployed-nodes.ts`) and the Management API work lazily imported (`list-deployed.ts`).

## Fit with the recorded design

- **Placement matches ADR-0053.** `emulator list` set the pattern: a command that needs Prisma Cloud code is added to the family by `@prisma/composer-cli`, and the framework CLI does not grow a target hook. `deploy list` follows it exactly. The framework family's doc comment and both ADR amendments say so. No principle is contradicted: the framework core still knows nothing about Prisma Cloud.
- **Node identity.** The join is by full address against `logicalId`, which is what the "address is identity everywhere" principle and ADR-0057 require. Row IDs are shown as data, never used as keys. Good.
- **No deploy-lease contention.** Reading the topology rather than Alchemy state is the right call and is recorded in `deploy-cli.md`.
- **Command shape.** ADR-0050 says `prisma deploy` is a bare verb. `deploy list` makes `deploy` both a command and a group, the same shape `dev` already has with `dev url` and `dev stop`. The ADR-0050 amendment states this. It does not reverse the decision; it extends it as ADR-0053 did.
- **Error codes.** `DEPLOY.TARGET_NOT_FOUND` and `DEPLOY.STAGE_INVALID` are existing ADR-0044 codes used with the meaning `destroy` already gives them.

## Naming and typology

- `@internal/cli/app-identity`: named for the concept it exposes (who the app is). It also exports `validateStageName`, which is not app identity. Acceptable as "what a read-only command needs before a lookup", but the subpath's doc comment has to explain the stage check; a reader would not guess it from the name. No action needed.
- `DeployedStage`, `DeployedRow`, `DeployedServiceRow`, `DeployedNode`: consistent "deployed" prefix across the lowering read and the command's output row. Each name says what it is. No qualifier-prefix problem.
- `listDeployed` / `ListDeployed` / `ListDeployedInput`, parallel to `listEmulators` / `ListEmulators`. Symmetric with the precedent.

### The `kind` column mixes three vocabularies

The spec settled this, so it is an observation for Will, not a finding. The `kind` value comes from three different sources:

- `project` describes the platform row (the root's topology kind is `module`).
- `service` and `module` are the topology's structural `kind`.
- `postgres` and `bucket` are renamed resource types (`raw-postgres` becomes `postgres`, `s3` becomes `bucket`), while every other resource passes its raw `type` through (`s3-credentials`).

So `kind` is an open set whose values do not share one meaning. An agent filtering on `kind == "bucket"` works today; an agent asking "which nodes are resources" cannot answer from this column. If that matters later, adding the topology's `kind` and `type` as separate JSON fields would answer it without changing the human table.

### The resource-type vocabulary now has three copies

`deployed-nodes.ts` restates which target resource types become a database or a bucket row. `scripts/platform-identity.ts` has the same table, and the target's `local-target/emulators.ts` has a third (`DATABASE_TYPES`). The types themselves belong to the Prisma Cloud target pack. If the target adds a database type, `deploy list` will silently show the raw type with no platform ID, and the e2e check will agree with it because it reads its own copy. See code-review F03.

## Test strategy at the architecture level

- The join is a pure function with unit tests per kind. The command is tested through the engine with a fake Management API, including request parameters (the Branch filter). This is the right split.
- The e2e check reads the platform independently (`/v1/apps` across the whole Project, then filters by Branch itself) rather than reusing `readDeployedStage`. That independence is what makes it a real check of the command, and it is worth keeping.
- `scripts/platform-state.ts` now holds the shared platform read for both e2e checks. It imports lowering source files by relative path, as the old `e2e-verify-identity.ts` did. No change in kind.

## Out of scope here

Implementation correctness, failure modes and acceptance criteria are in [code-review.md](code-review.md). Adopter learnability of the guide text would be a devrel review.
