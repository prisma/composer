# Platform checks

Run on 2026-11-06 against Prisma Cloud (Management API SDK 1.80.0, `prisma` CLI 8.0.0-rc.26) with `wip/pv-review/platform-checks.ts`, in throwaway project `proj_jq33n0c1iy3opp69hj2hqtd3` (`pv-check-1793970605187`, workspace "Makerkit Dev 2"). Raw output: `platform-checks-raw.txt`.

## 1. Empty value

The platform refuses an empty value. `POST /v1/environment-variables` with `value: ""` returns 422 `validation-error`, "value: Too small: expected string to have >=1 characters". A row always holds at least one character. So empty text can never arrive from the platform, and "empty means unset" is the only rule. `prisma dev` keeps its rule that an empty value is unset, and both agree.

## 2. Key case

The platform refuses any key that does not match `[A-Z_][A-Z0-9_]*`, on write and on the `key` list filter (422, "key: must match POSIX env-var key shape"). A lower-case or mixed-case key cannot exist as a row. Composer's rule `^[A-Z][A-Z0-9_]*$` is stricter only in refusing a leading underscore. Case cannot differ between a row and a name, so a lower-case `envSecret()` name never had a row and never deployed. It can exist in a project that only ran `prisma dev`, which reads local files by name and accepts any case today; the same holds for a leading underscore. Slice 2's release note says to rename such a name.

## 3. Preview-wide row from the CLI

Yes. `prisma project env add KEY=VALUE --role preview` creates the preview-class row with no branch, shared by every preview branch. `--branch <git-name>` creates one branch's override. `--role production` creates the production row. The CLI also has `update`, `list` (metadata only) and `delete`, each scoped the same way.

## 4. Deployment exits at boot

The platform does not notice. A process that exits at boot leaves its deployment at status `running`, the deploy's wait for `running` returns at once, `prisma deploy` exits 0, and the crashing deployment is promoted. Other services in the same deploy are promoted normally. The platform does not restart the process on its own; each request to the URL boots it once and gets a 502. The error is visible only in the logs: `prisma service logs <service> --project <id>` or `GET /v1/deployments/{id}/logs?from_start=true`. Full evidence in `platform-check-4.md`.

## 5. Service scope

There is no service scope. The Management API resolves a deployment's variables from the service's attached branch only: the production-class rows for the production branch, the preview-class rows plus that branch's overrides for a preview branch (deployment-create doc string, SDK 1.80.0). The environment-variable list accepts `projectId`, `class`, `key` and `branchId`; an unknown `serviceId` filter is ignored. No endpoint sets or lists a row on a service. So a name resolves at two scopes, project class and branch, and preflight's existence check covers both with the list calls it makes today. The design's third scope, "a row set on the service itself", does not exist and is removed.

A deployment read (`GET /v1/deployments/{id}`) returns `envVars`, the names present on that deployment with values redacted. That is a way to see what a deployment received without reading logs.

## 6. System-managed names

A fresh project has no rows in either class, so no name is `isManagedBySystem` from the start. The reserved list stays as the design has it.
