# S1b — The Postgres and bucket emulators know nothing about Composer

Repo: prisma/composer. Branch `feat/emulator-data-instances`, stacked on S1a (`feat/emulator-instances`, prisma/composer#354). PR base: that branch until it merges.

## At a glance

After S1a, only the Compute emulator follows ADR-0052. This slice moves the Postgres and bucket emulators to the same model, makes `prisma dev` stop its Postgres servers when it ends, and lets one directory keep the local data of more than one app.

```text
~/work/shop/.prisma-composer/dev/emulator-instances.json
  { "current": "shop",
    "apps": {
      "shop": { "nodes": {
        "quotes":  { "kind": "service",  "id": "svc_k3f9…", "port": 3000 },
        "catalog": { "kind": "database", "id": "db_02c4…" },
        "uploads": { "kind": "bucket",   "id": "bkt-77e1…" } } },
      "shop-v2": { "nodes": { … } } } }
```

Two checkouts of one app no longer share a local database or a bucket.

## Chosen design

**Postgres emulator.**
- A database is an instance with an emulator-generated id and labels, hosted on a `@prisma/dev` server named after that id. Every operation takes the id.
- A route lists all instances.
- New: **stop** shuts the instance's server down and keeps its data; **start** brings it back on the same port with the same data. Delete removes the server and its data. A stopped database keeps its port, by the same reasoning as Compute: its connection URL is in its dependents' environments.
- Old app-keyed servers and state are discarded on load. If `@prisma/dev` keeps data for them outside the emulator's own directory, remove it there too, or document exactly what is left behind.

**Bucket emulator.**
- A bucket is an instance with an emulator-generated id and labels. Its name on the S3 wire is that id, replacing `<app>--<bucket>`.
- Its data root is the in-project directory Composer registers, `.prisma-composer/dev/buckets/<app>/<bucket>/` (the app is in the path so two apps in one directory don't share a bucket's files). The emulator stores that path verbatim and never interprets it.
- Credentials are registered per instance. A route lists all instances.
- A bucket has no process, so stop and start don't apply.

**The record holds every app run from the directory.** This changes S1a's rule that switching apps deletes the previous app's Compute instances.
- `current` names the app `prisma dev` last ran here. `prisma dev url` (S3) resolves addresses in it.
- Switching apps stops the previous app's instances and keeps them, with their data and ports. Switching back resumes them warm.
- `--fresh` deletes the current app's instances and its entry.
- This follows Will's statement that the mapping is keyed by directory, app and topology. It also avoids deleting a database because a root module was renamed or run with a different `--name`.

**`prisma dev` ends.** On Ctrl-C, SIGTERM or a failure, `prisma dev` stops the current app's service processes, as today, and also its Postgres servers. The next start brings them back with their data.

**Everything else reaches databases and buckets through the record.** That includes the providers (`Database`, `Connection`, `Bucket`, `BucketKey`), attach, teardown, and `PgWarm`/`OrmMigration`, which already use the provider's URL. The emulators hook ensures them, as it does for Compute. Every instance gets the three `composer.*` labels.

**Docs.**
- ADR-0052 is extended in place, since it is unreleased, to cover databases, buckets, stop and the multi-app record. ADR-0041's amendment note is adjusted if needed.
- `local-dev.md`, the running-locally guide and the core-concepts skill are updated, removing every "Postgres and buckets are still keyed by the app" caveat.
- The guide's note that `PRISMA_COMPOSER_EMULATORS_DIR` doesn't isolate Postgres goes, because generated ids make checkouts independent.

## Scope

In: the Postgres and bucket emulators and their clients; the record's multi-app shape and the switch rule for all kinds; stopping Postgres servers on exit; the data providers, attach and teardown; tests; docs.

Out: `dev url`, `dev stop` and `emulator list` (S3); removing instances left by deleted directories.

## Pre-investigated edge cases

| Case | Expected |
| --- | --- |
| Warm start after Ctrl-C | Same database, same port, data intact, migrations no-op |
| A recorded database missing from the emulator | Re-created, requesting the remembered port; empty data, so migrations replay as on a fresh start |
| Switch app A → B → A | A's services, databases and buckets resume with their data and ports |
| Two checkouts of one app, each writes a row | Each reads only its own row; each lists only its own bucket objects |

## Slice-specific done conditions

- [ ] Two directories running one app with a database and a bucket each see only their own rows and objects (real emulators, temporary emulators directory).
- [ ] After `prisma dev` ends, no Postgres server of that app is running; the next start has the data.

## Dispatch plan

1. **Postgres emulator and client:** instances, labels, list, stop and start keeping data, delete. *Hands to 2.*
2. **Bucket emulator and client:** instances, labels, list, per-instance credentials. *Hands to 3.*
3. **Composer side:** the multi-app record, the data providers, attach and stop-on-exit, teardown, the two-directory data test. *Hands to 4.*
4. **Docs.** *Hands to:* the PR.
