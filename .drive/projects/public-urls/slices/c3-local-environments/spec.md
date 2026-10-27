# C3 — Each environment runs its own local copy

Parent: [public-urls spec](../../spec.md). Builds on [C2](../c2-environment/spec.md). Decided with Will on 2026-10-27; not yet built.

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
- **Every local command acts on what you name, never on what ran last.** `dev url`, `dev stop` and `--fresh` take `--environment` (default `dev`) and act on the app the config's `entry` or `--name` declares, exactly as `prisma dev` chooses its app. The record's `current` app, and the rule that running another app stops the previous one, go. *Why:* a command whose target depends on history is unpredictable (Will: "let's stop doing that").
- **Keying.** The folder's record of local instances is keyed by app, environment and node. Alchemy's local stage is the environment name. The generated local stack file is per environment, so parallel sessions don't overwrite each other.

## Amends

ADR-0052 (record keyed by app; `current` app; switching apps stops the previous one) and ADR-0053 (`dev url` and `dev stop` act on the app last run here). Both need amendment notes and `docs/design/10-domains/local-dev.md` updated in the same PR.

## Open questions

- How a record written before C3 (keyed by app only) is read: most likely as the `dev` environment of each app, so existing data survives.
