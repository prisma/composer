# Purpose

Let users, docs and agents ask the `prisma` CLI where a locally running Composer node is, instead of assuming which port it got:

```bash
npx prisma dev module.ts            # terminal 1
curl "$(npx prisma dev url gateway | jq -r 'select(.kind=="result").envelope.result.url')"   # terminal 2
```

and see everything the machine's local emulators are running:

```bash
npx prisma emulator list
```

Today the Composer getting-started page on prisma/web hard-codes `curl localhost:3001` and a POST to `localhost:3000`. Those only work because prisma/composer#350 happens to give the getting-started app those ports.

# At a glance

The project rests on one model, settled with Will on 2026-10-13:

- **The emulators are standalone, machine-local services.** The Compute, Postgres and bucket emulators hold instances: a running service process, a database, a bucket. They know nothing about Composer, apps, directories or node addresses. Each instance carries informative labels that the emulator stores and returns but never interprets, such as "started by Composer in /path/to/project for node `gateway`". Users will be able to start and stop emulators freely (a later project).
- **Composer is one client of the emulators.** `prisma dev` asks them for the instances its topology needs.
- **Composer owns the mapping from its names to emulator instances, per directory.** For each node address of the app run from a directory, Composer records which emulator instance backs it, in `.prisma-composer/dev/`. Every Composer operation on the emulators goes through that mapping: deploy, start, stop, logs, `--fresh`.

On that model, two commands:

- **`prisma dev url <address>`** prints the URL of a node of the app that `prisma dev` runs from the current directory. It covers services (`http://localhost:<port>`), databases (the local connection string) and buckets (the bucket emulator's S3 endpoint and the bucket's name on it). It reads the directory's mapping, then asks the emulator for that instance. `--json` gives the address, URL, kind and state.
- **`prisma emulator list`** prints every emulator on the machine, whether it is running, and each running emulator's instances with their kind, id, URL, state and labels. It needs no Composer project.

- **`prisma dev stop`** stops every instance this directory's app has on the emulators: service processes and Postgres servers. Data stays. An agent runs it before deleting its worktree, or after a `prisma dev` that was killed without a chance to clean up.

When `prisma dev` ends (Ctrl-C, SIGTERM, or a failure), it does the same stop. Today it stops only the service processes and leaves Postgres servers running. An instance keeps its port from creation until it is deleted, whether it is running or stopped, so a directory's ports never change. When an instance has to be re-created (its emulator lost its state), Composer requests the port remembered in the directory's mapping.

The shared emulator daemons themselves keep running; other directories may be using them.

`prisma dev <entry>` keeps working unchanged. The CLI engine learns to let a path be both a command and a group, so `prisma dev module.ts` runs the app and `prisma dev url gateway` runs the subcommand. A bare `dev` is the established convention (`pnpm dev`, `next dev`).

# Non-goals

- **Removing instances and their data.** A worktree that is deleted leaves its stopped instances' records and Postgres data on disk. They hold no process, but they do keep their ports reserved. A remove command comes with the later emulator start/stop project.
- **`prisma emulator start` and `stop`.** Planned; they change what runs on the shared emulators and get their own design.
- **Printing a bare value when stdout is a pipe.** The CLI keeps its rule that a piped stdout gets JSON frames. Docs use `jq`. No output-format change to the CLI engine.
- **`url` for things Composer didn't start.** `prisma dev url` takes a Composer node address only, never an emulator instance id.
- **Moving the emulators out of Composer.** Likely later, into their own project or into prisma-cli. This project keeps the emulator client behind one module boundary so that move stays cheap, but does not make it.
- **Migrating existing local dev state.** Local dev state is never migrated across Composer versions (running-locally guide). After the upgrade, a first `prisma dev` starts from empty instances. Instances the old emulators held are discarded.

# Place in the larger world

- **prisma/composer** — the emulators (`packages/1-prisma-cloud/0-lowering/dev-emulators`), the local target that drives them (`0-lowering/local-target`, `1-extensions/target/src/local-target`), the `dev` and `log` operations and the command family (`packages/0-framework/3-tooling/cli`), and `@prisma/composer-cli`, which the `prisma` binary mounts.
- **prisma/prisma-cli** — the CLI engine (`packages/cli-engine`), and the host that decides where each Composer command mounts (`packages/cli/src/cli.ts`, requirement R12 "the shell defines the command tree").
- **prisma/web** — the Composer getting-started and local-development pages.
- **Depends on prisma/composer#353** (open): a service counts as running only once its port accepts connections, and `withEmulatorRetry` retries only `DEV.EMULATOR_UNREACHABLE`. Without it, a URL `dev url` prints can refuse connections for a second or two after `ready`.
- **Releases.** Composer and CLI releases are currently blocked on an upstream Alchemy issue. The prisma-cli mount and the prisma/web change wait for a Composer release with the commands.

# Cross-cutting requirements

- **The emulators never learn a Composer concept.** No emulator route, file or field names an app, address or directory as anything other than an opaque label. A test or lint holds this.
- **Composer's mapping is the only source of truth for "which instance is this node".** Labels are for display. No Composer code finds an instance by reading labels.
- **Architecture boundaries hold.** The framework domain (`0-framework`) still imports nothing from `1-prisma-cloud`. The commands reach the emulators through a boundary dependency-cruiser allows, recorded in an ADR.
- **Every printed URL answers.** `dev url` reports a service as running only when the emulator does, which after #353 means its port accepts connections.
- **Errors follow ADR-0044.** Every failure a user can cause has its own code, raised where it is detected, with why and fix: no `prisma dev` has run in this directory; no node has that address (the known addresses listed); the node's emulator is not running; the service is not running. New codes and any new namespace are recorded in ADR-0044 in the same change.
- **User-facing changes ship with their docs** (`.agents/rules/user-facing-surface-changes.mdc`): `docs/guides/running-locally.md` and the core-concepts skill in Composer, and help text that meets prisma-cli's `docs/product/cli-help-standard.md`, which includes defining "emulator" for a reader who has never used Prisma.
- **`prisma dev` behaves the same from the outside** at every intermediate step, apart from the documented loss of pre-upgrade local state.

# Transitional-shape constraints

- The emulator refactor lands one emulator at a time if that keeps PRs reviewable. Each step leaves `prisma dev` fully working on main.
- Until the prisma-cli engine change ships, the Composer family may export the new commands without the host mounting them. The host mounts them only after the engine supports `dev` as both a command and a group.

# Project DoD

- [ ] On a machine with nothing running, the getting-started app's `prisma dev module.ts` followed by the documented `curl "$(npx prisma dev url gateway | jq …)"` returns a quote, run from the published `prisma` binary.
- [ ] Two directories running the same app at once get separate instances, and `prisma dev url gateway` in each returns that directory's own service.
- [ ] After Ctrl-C of `prisma dev`, or `prisma dev stop` following a `kill -9`, no process of that directory's app is running; the next `prisma dev` gets the same ports.
- [ ] `prisma emulator list` shows the services, databases and buckets of both, each labelled with the directory and address that started it.
- [ ] No emulator route, state key, file name or emulator-generated field carries an app name, address or directory. Composer data reaches an emulator only as label values and inside the deployment payload, stored verbatim and never interpreted.
- [ ] Composer ADRs record the emulator model (amending ADR-0041) and the new commands (amending ADR-0050). ADR-0044 lists the new codes.
- [ ] `docs/design/10-domains/local-dev.md`, the running-locally guide and the core-concepts skill describe both commands and the model.
- [ ] prisma-cli mounts both commands, with `EXCLUSIONS` entries in the e2e coverage test (local only, no management API).
- [ ] The prisma/web getting-started and local-development pages use `prisma dev url` instead of hard-coded ports.

# Open questions

None blocking. Decisions taken by the orchestrator, recorded in `design-notes.md`: the mapping file's location and shape, the label keys Composer writes, the `--json` shapes, and the error code names.

# References

- Brief (unvalidated, superseded by this spec where they differ): summarized in the conversation of 2026-10-13.
- `docs/design/10-domains/local-dev.md`, ADR-0041, ADR-0043, ADR-0044, ADR-0050, ADR-0051.
- prisma/composer#350 (merged), prisma/composer#353 (open).
- prisma-cli: `docs/architecture/cli-engine-requirements.md` (R12), `docs/product/cli-help-standard.md`, `docs/product/output-conventions.md`, `packages/cli/tests/e2e-coverage.test.ts`, `packages/cli/tests/mount-coverage.test.ts`.
