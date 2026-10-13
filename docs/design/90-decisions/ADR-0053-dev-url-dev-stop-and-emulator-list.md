# ADR-0053: `prisma dev url`, `prisma dev stop` and `prisma emulator list`

## Decision

Composer's command family ships three more commands, and `@prisma/composer/control` two more operations behind them:

```bash
$ prisma dev module.ts        # terminal 1: runs the app
$ prisma dev url gateway      # terminal 2: where a node of that app answers
http://localhost:3001
$ curl "$(prisma dev url gateway | jq -r 'select(.kind=="result").envelope.result.url')"
$ prisma dev stop             # stops this directory's app: services and database servers; data stays
$ prisma emulator list        # every local emulator on this machine and every instance on it
```

- **`dev url <address>`** prints where a node of the app `prisma dev` runs from the current directory answers: a service's `http://localhost:<port>`, a database's connection string, or a bucket's S3 endpoint plus `/<bucket>`. Its JSON result is `{ address, kind, url, state }`. In human format the URL alone goes to stdout, so `$(prisma dev url gateway --format human)` is the URL. It is the `devUrl` operation.
- **`dev stop`** stops that app's service processes and database servers, as ending `prisma dev` does, for a `prisma dev` that was killed without the chance. Data and ports stay. It is the `devStop` operation, and returns `{ app, stopped }`.
- **`emulator list`** lists the local emulators — the programs `prisma dev` starts to run services, databases and buckets on this machine — whether each runs, its admin URL, and its instances with id, kind, URL, state and labels. It needs no project. Its JSON result is `{ emulators: [{ kind, running, url, instances: [{ id, kind, url, state, labels }] }] }`. The operation is `listEmulators`, exported from `@prisma/composer-prisma-cloud/local-target`.

The family keys each command by the path it is meant to mount at (`dev url`, `dev stop`, `emulator list`); the `prisma` CLI decides where it mounts them. This amends [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md), under which the family was exactly `deploy` and `dev`, and [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md), whose `control` subpath had four operations.

## Reasoning

Docs, scripts and agents need to reach a locally running node without assuming its port. Ports are assigned in dependency order from 3000 and kept per directory ([ADR-0052](ADR-0052-composer-maps-its-nodes-to-emulator-instances-per-directory.md)), so `localhost:3001` is right for one app in one directory and wrong for the next. The directory's record already says which instance runs each node; these commands read it.

`dev url` and `dev stop` act on the app `prisma dev` *last ran from the directory*, without an entry or a build. The configuration does not name the app ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)), so the record is the only source. They still go through the core local-target seam, so core stays target-agnostic: `LocalTargetDescriptor` gains an optional `current({ devDir })`, which returns the recorded app's name, its addresses, `locate(address)` and `stop()`. The Prisma Cloud target implements it from `emulator-instances.json`; core never reads the record. Core turns what a target returns into the failures a user can act on:

| Situation | Code |
| --- | --- |
| No extension recorded an app in the directory | `DEV.NOT_STARTED_HERE` |
| The app has no node at the address (the known ones are listed) | `DEV.ADDRESS_UNKNOWN` |
| The emulator the node runs on is not running | `DEV.EMULATOR_UNREACHABLE` |
| The node exists but is not running (its state is named) | `DEV.NOT_RUNNING` |

`dev url` reports a node only when it is running, so every URL it prints answers. That relies on a service being `running` only once its port accepts connections.

`emulator list` is a question about the machine, not a project: it needs no `prisma.config.ts`, so it cannot go through the seam, which starts from the configuration. Its operation lives in the Prisma Cloud domain beside the emulator clients, and `@prisma/composer-cli`, a public package that may import both domains, adds the command to the family. Nothing running is a valid answer: every emulator is listed with `running: false`.

## Consequences

- `@prisma/composer/control` has six operations: `deploy`, `destroy`, `dev`, `devUrl`, `devStop`, `log`.
- `prisma dev` is both a command and a group. The CLI engine supports that from `@prisma/cli-engine` 0.8.0; the family itself is built against 0.7.0, because it only exports commands and does not mount paths. The `dev` command's description defines the terms its children rely on: an emulator, a node's address, and that the app is recorded in the directory.
- `emulator list`'s JSON departs from the list convention (`{ context, items, count }` with `{ name, id, status }` items): it nests two levels, emulators and their instances, because an instance is meaningless without the emulator that holds it.
- Database URLs are connection strings with local credentials, printed on purpose; a bucket's access keys are never printed.
- `prisma emulator start` and `prisma emulator stop`, and removing instances left by deleted directories, are planned and not part of this decision.

## Alternatives considered

- **`prisma emulator url <address>`.** The same behaviour, but `url` asks a question about this directory's app, which belongs under `dev`; `emulator` commands act on the machine.
- **A top-level `prisma url`.** Ambiguous between a local node and a deployed one.
- **Renaming the run command to `prisma dev start`.** Avoids a command that is also a group, but breaks every `prisma dev module.ts` and reverses ADR-0050's root verb.
- **Naming the app on the command line (`url my-app gateway`) or with `--app`.** Addresses are relative to the directory's app, and app names collide across directories.
- **`emulator list` through the core seam.** Would require a project and a configuration for a question about the machine.
- **Printing a bare URL even when stdout is piped.** Would change the CLI's rule that a piped stdout carries JSON frames; scripts use `jq` or `--format human` instead.

## Related

- [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md) — the commands Composer ships; amended here.
- [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md) — the programmatic operations; amended here.
- [ADR-0052](ADR-0052-composer-maps-its-nodes-to-emulator-instances-per-directory.md) — the per-directory record these commands read.
- [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md) — the codes above are registered there.
- [local-dev.md](../10-domains/local-dev.md) — the mechanics.
