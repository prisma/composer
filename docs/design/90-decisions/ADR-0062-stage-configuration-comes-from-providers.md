# ADR-0062: Per-stage configuration comes from providers named in the config file

## Decision

The `composer` section of `prisma.config.ts` names **configuration providers**. For the stage being deployed, each provider returns a value; the deploy merges them and passes the result to the root module's `input` schema, which validates it.

```ts
// prisma.config.ts
import { defineConfig as composer, dotenv } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import { definePrismaConfig } from 'prisma/config';

export default definePrismaConfig({
  composer: composer({
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
    config: [dotenv()],
  }),
});
```

```sh
# .env.production
SITE_HOSTNAME=www.myapp.com
# .env.staging
SITE_HOSTNAME=staging.myapp.com
```

```ts
// module.ts: the root declares what it accepts
export default module('shop', { input: type({ 'SITE_HOSTNAME?': 'string' }) },
  ({ input, provision }) => {
    const web = provision(webService, { /* … */ });
    provision(ingress({ name: 'site', hostname: input.SITE_HOSTNAME, target: web.http }));
  });
```

```sh
prisma deploy module.ts                  # stage production: SITE_HOSTNAME=www.myapp.com
prisma deploy module.ts --stage staging  # SITE_HOSTNAME=staging.myapp.com
prisma deploy module.ts --stage pr-42    # no SITE_HOSTNAME: the ingress gets a generated hostname
prisma dev module.ts                     # stage dev
```

Every stage has a name, and every environment is independent. `prisma deploy`'s `--stage` defaults to `production`, and `prisma dev`'s to `dev`. Those are defaults of each command's parameter, not a special environment.

## Reasoning

**Four kinds of value need a home.** A value is either known when the deploy runs or held by the platform, and either plain or protected:

| | plain | protected |
| --- | --- | --- |
| **known at deploy time** | `config` providers (this decision) | `secrets` providers (named here, built later) |
| **held by the platform** | not yet available | `envSecret` |

`envParam` already reads a value from the deploy shell's environment at deploy ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)). What was missing is the common case `.env` files solve: plain values that differ per stage and are kept in the repository. A custom hostname is one; so is a feature flag or a third-party account id.

**A provider is a mechanism, not a value.** The config file says how a deploy works, never what the application is: it names extensions and the state store, and carries no application settings ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)). A provider says where values come from. The values themselves stay in the files or system the provider reads, and the root module's schema says what they must be.

**A provider is a function of the stage.** It receives the stage name and returns any value; Composer adds no rule about its shape. `dotenv()` follows dotenv's own convention: it loads `.env` for every stage and `.env.<stage>` for the stage being deployed, plus their `.local` variants. Values specific to one stage go in that stage's file, so production's hostname in `.env.production` never reaches `pr-42`. A provider for a secrets manager or a team's own configuration service is another function with the same contract.

**Several providers merge by top-level key, in list order; the later provider wins.** Kubernetes `envFrom`, Docker Compose `env_file` and the dotenv layering in Next.js and Vite all resolve repeated keys this way. Merging by top-level key keeps the rule predictable: a later provider that returns `db` replaces an earlier provider's `db` as a whole.

**The root's schema is the judge.** The merged value is the root's input binding. The deploy validates it with the root's schema before anything is created ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)). A key no provider supplies is absent, and the schema decides whether that is allowed: an optional hostname left unset gives a generated hostname; a required value left unset fails the deploy with the schema's error. This is how an unset `envParam` behaves today.

**There is no default stage.** A nameless "default stage" makes one environment special, and an environment that is special by omission is a footgun: forgetting a flag lands a deploy, or a teardown, on production. Each command instead has a default value for its `--stage` parameter. A provider always receives a name, so `dotenv()` reads `.env.production` for production like any other stage. `destroy` keeps having no default: its target names a stage explicitly, so an omitted value can still never tear down production ([ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)).

**Local development is a stage like any other.** `prisma dev` runs at the stage the user names, `dev` by default, so providers can give local development its own values (`.env.dev`). A stage names any environment the app runs in, local or deployed ([ADR-0059](ADR-0059-a-deployment-environment-is-a-stage.md)).

**On Prisma Cloud, `production` keeps resolving where production lives today.** The platform creates each Project with one Branch marked as its default (created as `gitName: main`, `role: production`), and Composer already resolves a deploy without `--stage` to that Branch by its `isDefault` flag. The stage `production` keeps that resolution, so no existing app moves; every other stage resolves by exact `gitName`, created if absent, as today. Composer reads `isDefault`, never `role`. This mapping lives in the Prisma Cloud extension; core knows only stage names.

## Consequences

- **The `composer` section gains `config`, and later `secrets`.** Its validator rejects unknown keys today ([ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md)), so both become known fields: each an array of providers.
- **`dotenv()` ships with Composer** as the first provider.
- **`prisma deploy` without `--stage` deploys the stage `production`.** On Prisma Cloud this is the same Branch as before.
- **`destroy` targets a stage by name**, `{ kind: 'stage', stage: 'production' }` included. The separate `{ kind: 'production' }` target is retired.
- **`prisma dev` takes `--stage`.** Local dev no longer says "Stages do not apply". How local state and emulator instances are keyed by stage is settled with that change; this decision fixes only what providers receive.
- **`--stage main` reaches production on Prisma Cloud**, because the default Branch's `gitName` is `main`. That is true today and stays true.
- **Values in `.env` files are plain.** A secret belongs with `envSecret`, or with a secrets provider once they exist. The root's schema can refuse a plain value where it expects `secretString()`.

## Alternatives considered

- **Per-stage values in the Prisma Cloud extension's options.** Rejected: application values in the config file, keyed by platform branch names.
- **Only `envParam`, with the deploy shell loading `.env` files.** Works in CI today, but every developer and pipeline must load the right file for the right stage themselves, and nothing in the repository says which values a stage gets.
- **A nameless default stage that providers map themselves** (`dotenv({ defaultStage: 'production' })`). Rejected: it keeps one environment special.
- **Deep-merging provider values.** Rejected: harder to predict, and providers that need combined values can combine them themselves.
- **One list for plain and protected values.** Rejected: a separate `secrets` list makes a secrets provider, not a committed file, the obvious place for a secret.

## Related

- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): the root's `input`, which providers fill.
- [ADR-0060](ADR-0060-ingress-is-a-driver-on-an-exposed-http-port.md): the ingress, the first consumer of a per-stage value.
- [ADR-0059](ADR-0059-a-deployment-environment-is-a-stage.md): what a stage is.
- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md) and [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md): stage resolution and the `deploy`/`destroy` surfaces this amends.
- [ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md): the config section this extends.
- [local-dev.md](../10-domains/local-dev.md) and [config-params.md](../10-domains/config-params.md).
