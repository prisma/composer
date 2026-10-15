# S3 — `prisma dev url`, `prisma dev stop` and `prisma emulator list`

Repo: prisma/composer. Branch `feat/emulator-commands`, stacked on S1b (`feat/emulator-data-instances`, prisma/composer#356).

## At a glance

```bash
$ prisma dev module.ts        # terminal 1
$ prisma dev url gateway      # terminal 2
http://localhost:3001
$ prisma dev url catalog --json
{"kind":"result","envelope":{"ok":true,"result":{"address":"catalog","kind":"database","url":"postgres://…:51300/…","state":"running"},…}}
$ prisma dev stop             # stops this directory's app: services and Postgres servers; data stays
$ prisma emulator list        # every emulator on this machine and every instance on it, with its labels
```

## Chosen design

**Operations first (ADR-0043: commands render operations).**
- `@prisma/composer/control` gains two operations. `devUrl` takes a config, a cwd and an address, and returns `{ address, kind, url, state }`. `devStop` takes a config and a cwd, and stops the current app recorded in that directory.
- They go through the core local-target seam, so the framework stays target-agnostic.
- `LocalTargetDescriptor` gains what they need without an app name. Taking the dev state directory alone, it resolves an address and stops the directory's current app. The Prisma Cloud target implements both from `emulator-instances.json`.
- Core never learns the record's format.
- `emulator list` needs no project and no config, so it can't go through the seam. Its operation lives in the Prisma Cloud domain and is exported from `@prisma/composer-prisma-cloud/local-target`. It lists each emulator (`service`, `database`, `bucket`): whether it is running, its admin URL, and its instances with id, kind, URL, state and labels.
- It honours `PRISMA_COMPOSER_EMULATORS_DIR`, like everything else.

**Commands.**
- The family exports three new commands.
- The host decides the mount paths (prisma-cli requirement R12). The intended paths are `dev url`, `dev stop` and `emulator list`; prisma-cli's engine now allows `dev` to be both a command and a group (prisma/prisma-cli#349).
- `dev url` and `dev stop` declare the `composer` config section. `emulator list` declares none.
- `emulator list` is defined in the Prisma Cloud domain, or wherever keeps layering legal. `@prisma/composer-cli`, in `9-public`, which may import both domains, assembles it into the family.
- The family's static import graph stays free of alchemy and effect values (`scripts/check-family-static-graph.mjs`).
- `family.test.ts`'s pinned command list is updated.

**Output.**
- `dev url`, human format: the URL as the command's data line, so `--format human` works inside `$(…)`, plus a minimal human block. The JSON `result` is `{ address, kind, url, state }`, where `kind` is `service | database | bucket`.
- `state` is the service status; for a database `running | stopped`; for a bucket whether its emulator runs.
- URLs:
  - **Service:** `http://localhost:<port>`.
  - **Database:** its connection string.
  - **Bucket:** the bucket emulator's S3 endpoint plus `/` plus the bucket's id. Access keys are never printed.
- `dev stop` returns what it stopped.
- `emulator list` JSON `result`: `{ emulators: [{ kind, running, url, instances: [{ id, kind, url, state, labels }] }] }`. Human output: one block per emulator, and its instances with their address and directory from the labels when present.
- Follow prisma-cli's `docs/product/output-conventions.md` and `cli-style-guide.md` where they apply. The two-level list departs from the list convention; record that in the ADR.

**Errors (ADR-0044; record every new code in its registry in this change).**
- No record in this directory → `DEV.NOT_STARTED_HERE`. Fix: run `prisma dev <entry>` here.
- Unknown address → `DEV.ADDRESS_UNKNOWN`, listing the known addresses.
- The node's emulator isn't running → `DEV.EMULATOR_UNREACHABLE`.
- The node exists but isn't running → `DEV.NOT_RUNNING`. It names the state and points to `prisma dev`.
- `emulator list` with nothing running → ok, with every emulator `running: false`. No error.

**Help.** Every summary, description and flag brief meets prisma-cli's `docs/product/cli-help-standard.md`: the reader has never used Prisma, and each term is defined in place, "emulator" included. The `dev` command's description must define what its children rely on (prisma-cli `cli-style-guide.md`, "Groups With Their Own Command").

**Docs.**
- A new ADR amends ADR-0050 (the family is no longer exactly `deploy` and `dev`) and ADR-0043 (the new operations), and lists the alternatives from `design-notes.md`.
- Also update `local-dev.md`, `deploy-cli.md`'s scope, the running-locally guide and the core-concepts skill, including that `prisma emulator start` and `stop` are planned.
- The guide shows the `jq` form for scripts: `curl "$(prisma dev url gateway | jq -r 'select(.kind=="result").envelope.result.url')"`.

## Scope

In: the operations, the seam additions, the commands, the family assembly, tests (bun:test; real emulators in temporary directories, skipped on Windows), the ADR, ADR-0044 and the docs.

Out: mounting in prisma-cli (S4); prisma/web (S5); `emulator start`, `emulator stop` and removing instances.

## Slice-specific done conditions

- [ ] With an app running from a temporary directory on real emulators, `dev url` returns a URL for a service, a database and a bucket that each answer: an HTTP request, a Postgres `select 1`, and an S3 listing with the app's credentials.
- [ ] `dev stop` leaves no process or Postgres server of that app running.
- [ ] `emulator list` shows the instances of two directories with their labels.

## Dispatch plan

1. **Operations and seam:** `devUrl`, `devStop` and the emulator listing, with the errors and tests. *Hands to 2.*
2. **Commands and family assembly:** help text, output, family tests and the static-graph check. *Hands to 3.*
3. **Docs:** the ADR, ADR-0044, `local-dev.md`, `deploy-cli.md`, the guide and the skill. *Hands to:* the PR.
