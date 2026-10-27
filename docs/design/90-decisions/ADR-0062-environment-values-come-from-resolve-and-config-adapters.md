# ADR-0062: A value that differs per environment is computed with `resolve()`; values from outside the code come through config adapters

## Decision

A module computes a value from its inputs and the environment's name with **`resolve()`**. Values that live outside the code reach the root module's `input` through **config adapters** named in `prisma.config.ts`. Every environment has a name, and no environment is special.

```ts
// module.ts
import { module, resolve } from '@prisma/composer';
import { publicUrl } from '@prisma/composer-prisma-cloud';

export default module('shop', { input: type({ 'SITE_HOSTNAME?': 'string' }) }, ({ input, environment, provision }) => {
  const web = provision(webService, { deps: { auth: auth.rpc } });

  const url = resolve([input.SITE_HOSTNAME, environment.name], ([hostname, name]) =>
    hostname !== undefined ? publicUrl.hostname(hostname)
    : name === 'production' ? publicUrl.hostname('shop.com')
    : publicUrl.generated());

  provision(publicUrl({ name: 'site', url, target: web.http }));
});
```

```ts
// prisma.config.ts: where values from outside the code come from
composer({ extensions: [prismaCloud(), nodeBuild()], state: prismaState(), config: [dotenv()] })
```

```sh
prisma deploy module.ts                        # the environment production
prisma deploy module.ts --environment staging  # staging
prisma deploy module.ts --environment pr-42    # a preview
prisma dev module.ts                           # the environment dev, on this machine
```

`prisma deploy`'s `--environment` defaults to `production` and `prisma dev`'s to `dev`. Those are defaults of each command's parameter, not a privileged environment.

## Reasoning

**One rule governs everything here: the graph's structure is the same whatever inputs Composer is given.** Values may differ per environment; nodes and edges may not. This is what stage resolution's older rule, "the stage never appears in the authored topology", was protecting, and this decision restates it that way. Branching on the environment is the most common way to break the rule, which is why the environment gets special attention below.

**`resolve()` is the one way a module body computes a value.** `resolve(dependencies, fn)` returns a `ResolvedValue<T>`, a value the graph records as "computed later from these inputs and the environment". It can be passed anywhere a value of type `T` can: a public URL's `url`, a service's input, a resource's name.

- **Dependencies are explicit, and `fn` receives their values as one tuple**: `resolve([input.a, environment.name], ([a, name]) => …)`, the shape of Vue's `watch(sources, fn)` and Solid's `on(deps, fn)`. A dependency is a module input reference, a reference to a deploy-time fact, or another `ResolvedValue`. The list is the only way one resolved value can be computed from another, since a `ResolvedValue` is opaque until it is run, and it gives Composer a graph of resolved values it orders before running them and checks for cycles. `fn` is typed from the list. Composer never inspects the function, which keeps the service-input decision's rule that the framework introspects nothing ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)).
- **Deploy-time facts are dependencies like any other.** The module body receives an `environment` object beside `input` and `provision`, holding one opaque reference per fact: `environment.name` today, others as they are needed. A body can only list them as dependencies, so it still cannot branch on the environment. Nothing is appended to `fn`'s parameters: a new fact is a new reference, not a new argument.
- **`fn` receives values and returns a value.** Secret inputs arrive as opaque `SecretString` boxes.
- **Order of evaluation enforces the rule.** Composer runs the module code and builds the graph with every `resolve()` function unexecuted. It then disables `provision`. It then runs each function for the environment being deployed and validates the result like any other value, so a function that returns nothing for some environment fails the deploy rather than silently picking a default. Only the fully resolved graph is handed to Alchemy, the deploy engine.
- **It fills a gap.** Module inputs are opaque references ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)), which could previously only be passed through unchanged. `resolve()` is how `https://` is put in front of a hostname, or how one environment gets a named hostname and another a generated one. The lowering layer already does this with Alchemy's `Output.map`; `resolve()` is the authoring-level form.

**Config adapters bring in values that live outside the code.** Some values belong to a file an ops team owns, or a secrets manager, not to `module.ts`. The `composer` section of `prisma.config.ts` names adapters; each receives the environment's name and returns a value; the results merge by top-level key in list order, a later adapter winning; and the merged value is the root module's input, validated by its schema. An adapter is a mechanism, not a value: the config file still carries no application settings ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)); the values stay wherever the adapter reads them. `dotenv()` is the first adapter and follows dotenv's own convention: `.env` for every environment, `.env.<environment>` for the one being deployed, plus the `.local` variants. A `secrets` list beside `config` comes later, so a secrets manager rather than a committed file is the obvious home for a secret.

Adapters are not how per-environment choice is expressed. That is `resolve()`, in code, where it is reviewed with the topology. An adapter supplies a value; `resolve()` decides what to do with it.

**Four kinds of value, and where each lives:**

| | plain | protected |
| --- | --- | --- |
| **known at deploy time** | `config` adapters, and `resolve()` over them | `secrets` adapters (named here, built later) |
| **held by the platform** | not yet available | `envSecret` |

**A key no adapter supplies is absent, and the schema decides.** An optional key left out is simply absent in `fn`, which may return a generated URL for it. A required key left out fails the deploy before anything is created, with the schema's error. This is how an unset `envParam` behaves today.

**Every environment has a name; none is special.** A nameless "default" environment is a footgun: forgetting a flag lands a deploy, or a teardown, on production. So each command has a default value for its `--environment` parameter, and an adapter always receives a name, as does a `resolve()` that lists `environment.name`. `destroy` keeps having no default: its target names an environment explicitly, so an omitted value can still never tear down production ([ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)).

**Local development is an environment like any other.** `prisma dev` runs as the environment the user names, `dev` by default. `environment.name` resolves to `'dev'`; the local target ignores a named hostname regardless. Nothing keys on the name `dev` itself.

**On Prisma Cloud, `production` keeps resolving where production lives today.** The platform creates each Project with one Branch marked as its default (created as `gitName: main`, `role: production`), and Composer already resolves a deploy without a named environment to that Branch by its `isDefault` flag. The environment `production` keeps that resolution, so no existing app moves; every other environment resolves by exact `gitName`, created if absent. Composer reads `isDefault`, never `role`. This mapping lives in the Prisma Cloud extension; core knows only environment names.

## Consequences

- **`resolve()` ships in `@prisma/composer`**, target-neutral, returning `ResolvedValue<T>`; every node parameter and input binding accepts a `ResolvedValue` of its type.
- **The `composer` section gains `config`, and later `secrets`.** Its validator rejects unknown keys today ([ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md)), so both become known fields, each an array of adapters. `dotenv()` ships with Composer.
- **`--environment` replaces `--stage`** on `prisma deploy`, and `prisma dev` gains it ([ADR-0059](ADR-0059-a-deployment-environment-is-called-an-environment.md)). `prisma deploy` without it deploys `production`, the same Branch as before on Prisma Cloud.
- **`destroy` targets an environment by name**, `production` included. The separate `{ kind: 'production' }` target is retired.
- **Local dev no longer says "stages do not apply".** How local state and emulator instances are keyed by environment is settled with that change; this decision fixes only what `resolve()` and adapters receive.
- **Values in `.env` files are plain.** A secret belongs with `envSecret`, or with a secrets adapter once they exist. The root's schema refuses a plain value where it expects `secretString()`.

## Alternatives considered

- **A per-parameter callback** (a `url` that is "sometimes a value, sometimes a function"). Rejected: implicit, hard to type, and invisible in the graph. `resolve()` is explicit, typed and recorded.
- **`byEnvironment({ production: …, otherwise: … })`.** Rejected as a second mechanism; a `resolve()` function says the same thing and also covers derivation from inputs.
- **Passing all inputs to `fn`** (`resolve((inputs, environment) => …)`). Rejected: a `ResolvedValue` is opaque, so without a dependency list one resolved value could not be computed from another, and there would be no graph to order or check for cycles.
- **The environment's name as an extra argument to `fn`** (`resolve([input.a], (a, environment) => …)`). Rejected: the name is one deploy-time fact of several to come, and each would add a positional argument. As a dependency it is listed like everything else.
- **`fn` receiving its values as positional arguments.** Rejected in favour of one tuple, so the parameters and the dependency list have the same shape, as in `Promise.all`.
- **Reading the environment's name in the module body.** Rejected: a module could vary its structure by environment.
- **Per-environment hostnames through `.env` files as the primary story.** Rejected after team review: a rule over an open-ended set of previews belongs in reviewed code, not in one file per environment. Adapters remain for values that live outside the code.
- **A nameless default environment that adapters map themselves** (`dotenv({ defaultStage: 'production' })`). Rejected: it keeps one environment special.
- **Deep-merging adapter values.** Rejected: harder to predict; a `resolve()` can combine values where needed.
- **One list for plain and protected values.** Rejected: a separate `secrets` list makes a secrets adapter the obvious place for a secret.

## Related

- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): module and root `input`, which adapters fill and `resolve()` derives from.
- [ADR-0060](ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md): the public URL, the first consumer of a `resolve()` value.
- [ADR-0059](ADR-0059-a-deployment-environment-is-called-an-environment.md): what an environment is.
- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md) and [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md): environment resolution and the `deploy`/`destroy` surfaces this amends.
- [ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md): the config section this extends.
- [local-dev.md](../10-domains/local-dev.md) and [config-params.md](../10-domains/config-params.md).
