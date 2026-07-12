---
name: deploying-prisma-composes
description: >-
  How to deploy a Prisma App to production with `prisma-compose deploy`, stand up
  an isolated staging or per-PR preview environment with `--stage`, and tear
  environments down with `prisma-compose destroy`. Destroy always requires an
  explicit target — a bare `prisma-compose destroy` is an error. Use when
  deploying a Prisma App, creating a staging/preview environment, or removing
  a deployed environment. Triggers on "prisma-compose deploy", "deploy a prisma
  app", "--stage", "staging environment", "preview environment", "prisma-compose
  destroy", "tear down a stage".
---

# Deploying Prisma Apps

`prisma-compose` deploys the app whose root node is your entry file's default
export. Two commands, `deploy` and `destroy`; the target environment — called
a **stage** — is chosen on the command line, never in your code.

| You want to… | Run |
| --- | --- |
| Deploy to production | `prisma-compose deploy <entry>` |
| Deploy an isolated environment | `prisma-compose deploy <entry> --stage <name>` |
| Tear down an isolated environment | `prisma-compose destroy <entry> --stage <name>` |
| Tear down production's resources | `prisma-compose destroy <entry> --production` |

## The commands

```sh
prisma-compose deploy module.ts                  # production
prisma-compose deploy module.ts --stage staging  # an isolated "staging" environment
prisma-compose deploy module.ts --stage pr-42    # one isolated environment per PR
prisma-compose deploy module.ts --name demo-42   # override the app name for this run
```

A deploy needs exactly two environment variables: `PRISMA_SERVICE_TOKEN` and
`PRISMA_WORKSPACE_ID`. Nothing else — the CLI resolves the app's Project (by
the root module's name) and, for a named stage, the stage's Branch, creating
either if it doesn't exist yet. A fresh checkout with just those two variables
set deploys successfully.

Build your app first — `prisma-compose deploy` does not build for you:

```sh
turbo run build && prisma-compose deploy module.ts
```

Re-deploying the same stage is idempotent: it finds the existing Project and
Branch and updates the resources inside them.

## What a stage is

Same code, many environments. Deploying with no `--stage` targets
**production**, at the Project level. `--stage <name>` targets a **named
stage** — a Branch of that same Project, with its own compute, its own empty
database, and its own configuration. Every environment repeats the app's full
topology; only the data and config differ.

A stage name must be a valid git ref name (checked with `git
check-ref-format`); an invalid name is a hard error, never silently
normalized.

## Destroy requires an explicit target

A bare `prisma-compose destroy` is an error.

```sh
prisma-compose destroy module.ts
# error: `destroy` requires an explicit target: --stage <name> to tear down a
# branch environment, or --production to tear down the production environment.
```

Name what you're tearing down:

```sh
prisma-compose destroy module.ts --stage staging     # removes staging's resources, then its Branch
prisma-compose destroy module.ts --production         # removes production's resources
```

`--stage` and `--production` together is also an error — pick one. Destroying
a named stage deletes its Branch after removing its resources; the production
Branch itself is never deleted, only the resources inside it.

Destroy never creates anything: destroying a stage that was never deployed
fails with "nothing deployed for `<app>/<stage>`" rather than standing one up
first.

## Example: `storefront-auth`

```sh
cd examples/storefront-auth

prisma-compose deploy module.ts                  # production: its own URL, its own database
prisma-compose deploy module.ts --stage staging  # staging: a second, isolated URL and database

prisma-compose destroy module.ts --stage staging # tears down staging only — production is untouched
```

## Full model

- [`docs/design/10-domains/deploy-cli.md`](../../docs/design/10-domains/deploy-cli.md)
  — the pipeline, stages and containers, the destroy contract.
- [ADR-0023](../../docs/design/90-decisions/ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md)
  — a Prisma App is one Project; a stage is a Branch.
- [ADR-0024](../../docs/design/90-decisions/ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)
  — how a stage resolves to a Project and Branch.
