# C3 — Each environment runs its own local copy

Parent: [public-urls spec](../../spec.md). Builds on [C2](../c2-environment/spec.md). Decided with Will on 2026-10-27 and 2026-10-28.

## At a glance

```sh
prisma dev                                  # the environment dev
prisma dev --environment test --fresh       # a second, clean copy; dev's data untouched
prisma dev url shop.api                     # dev's URL
prisma dev url shop.api --environment test  # test's URL
prisma dev stop --environment test
```

## Decisions

- **An environment name means a complete, separate local copy.** `prisma dev --environment <name>` runs the whole topology as that environment, with its own services, databases, buckets and ports. The name defaults to `dev`. A second name runs a parallel copy; two environments of one app can run at once in one folder. *Why:* everywhere else an environment is a place the app runs with its own data, and the common reason to pass a name locally is a clean copy for tests that leaves working data alone.
- **Every local command acts on what you name, never on what ran last.** `dev url`, `dev stop` and `--fresh` take `--environment` (default `dev`). The record's `current` app, and the rule that running another app stops the previous one, go. *Why:* a command whose target depends on history is unpredictable (Will: "let's stop doing that").
- **How each command finds its app.**
  - `prisma dev` and `prisma dev stop` take the app from the config's `entry`, or from `--name`, as `deploy list` does.
  - `prisma dev url <address>` takes the app from the address: `shop.api` names the app `shop`. It does not import the module.
- **One folder per environment.** Everything local and per copy lives in `.prisma-composer/dev/<environment>/`: the record of local instances, the environment variable values, the placeholder secrets, the generated stack file, the artifacts and the bucket objects. Today these are shared by the whole folder, and two environments of one app would overwrite each other's environment variables. The folder name is encoded, because an environment name may contain `/`.
- **Alchemy's local stage is the environment name.** Alchemy already keeps state per stage, at `.alchemy/state/<app>/<stage>`.
- **Instances carry the environment.** Each emulator instance gets an environment label, and `emulator list` shows the environment at the end of each line. Labels stay display-only.
- **Existing local data moves into `dev`.** The first `prisma dev` after the upgrade moves the folder's existing record, environment variables, secrets and bucket objects into the `dev` environment, so databases and objects survive. This overrides the per-folder record decision's rule that local state is never migrated, following the full-address decision, which rewrote the record.
- **The extension version check.** `prisma dev` does not run C2's check today: it does not rebuild each container through the extension's `deserialize` and refuse with `DEPS.EXTENSION_INCOMPATIBLE`. C3 adds it, because an older local target that ignores the name would put every environment in one copy.

## Amends

The per-folder record decision (record keyed by app; a `current` app; running another app stops the previous one; local state never migrated) and the `dev url` / `dev stop` decision (they act on the app last run here). Both get amendment notes, and `docs/design/10-domains/local-dev.md` is updated, in the same PR.

## Acceptance criteria

1. `prisma dev --environment test` runs alongside a running `prisma dev` of the same app in the same folder. Each has its own ports, databases and bucket objects.
2. `prisma dev --environment test --fresh` deletes only `test`'s copy. `dev`'s data is untouched.
3. Running a second app or environment stops nothing already running.
4. `prisma dev url shop.api` prints `dev`'s URL; with `--environment test` it prints `test`'s. It does not import the config's entry.
5. `prisma dev stop` stops the config's app in `dev`; `--environment` and `--name` select another. It fails with a clear message when that app and environment has nothing running.
6. A folder written by the previous version keeps its data as the `dev` environment after one `prisma dev`.
7. `prisma dev` refuses an incompatible local target extension with `DEPS.EXTENSION_INCOMPATIBLE`.
8. `emulator list` shows each instance's environment.
9. Both decision records carry amendment notes and the local-dev doc describes the new behaviour.
