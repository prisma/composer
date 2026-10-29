# ADR-0062: A value that differs per environment is computed with `resolve()`; values from outside the code come through config adapters

Amended 2026-10-29: the thing `resolve()` returns is a **value**, typed `Value<T>`, not `ResolvedValue<T>`. A value is an opaque handle in a module body for something that has a real value once the graph is fully evaluated. A value is provided or computed: `environment.name` is provided, and `resolve(dependencies, fn)` returns one computed from others. A value is deploy-time or runtime: a deploy-time value holds its real value by the end of Load; a runtime value is known only on the deployment system, and its deploy-time form is a pointer to it. Every value shipped by the public-URLs project is deploy-time. `envParam()` and `envSecret()` are not values yet: with the `module-input` project they return values, the special handling of environment variables is replaced by config adapters and secret adapters, and the two functions then create a persisted resource for a value instead of passing it through. The glossary's "Value" entry defines the term.

## Decision

A module computes a value that depends on the environment, or on its inputs, with **`resolve()`**. Values that live outside the code reach the root module's `input` through **config adapters** named in `prisma.config.ts`. Every environment has a name, and no environment is special.

The simplest case: a value that depends only on which environment is being deployed.

```ts
import { module, resolve } from '@prisma/composer';
import { publicUrl } from '@prisma/composer-prisma-cloud';

export default module('shop', ({ environment, provision }) => {
  const web = provision(webService);

  const url = resolve([environment.name], ([name]) =>
    name === 'production' ? 'shop.com' : publicUrl.prismaBuild());

  provision(publicUrl({ name: 'site', url, target: web.http }));
});
```

`resolve(dependencies, fn)` names what the value depends on, here the environment's name, and `fn` receives those values as one tuple and returns the value. The result is a `ResolvedValue`, accepted anywhere a value of that type is.

A value can also depend on a module input ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)), and on another resolved value:

```ts
export default module('shop', { input: type({ 'SITE_HOSTNAME?': 'string' }) }, ({ input, environment, provision }) => {
  const web = provision(webService);

  const url = resolve([input.SITE_HOSTNAME, environment.name], ([hostname, name]) =>
    hostname !== undefined ? publicUrl.hostname(hostname)
    : name === 'production' ? publicUrl.hostname('shop.com')
    : publicUrl.prismaBuild());

  provision(publicUrl({ name: 'site', url, target: web.http }));
});
```

The root's input comes from outside the code. The `composer` section of `prisma.config.ts` names where:

```ts
composer({ extensions: [prismaCloud(), nodeBuild()], state: prismaState(), config: [dotenv()] })
```

And the environment is named on the command line:

```sh
prisma deploy                          # the environment production
prisma deploy --environment staging    # staging
prisma deploy --environment pr-42      # a preview
prisma dev                             # the environment dev, on this machine
```

`prisma deploy`'s `--environment` defaults to `production` and `prisma dev`'s to `dev`. Those are defaults of each command's parameter, not a privileged environment.

## Reasoning

**One rule governs everything here: the graph's structure is the same whatever inputs Composer is given.** Values may differ per environment; nodes and edges may not. Branching on the environment is the most common way to break the rule, which is why the environment gets special attention below.

**`resolve()` is the one way a module body computes a value.** `resolve(dependencies, fn)` returns a `ResolvedValue<T>`, a value the graph records as "computed later from these dependencies". It can be passed anywhere a value of type `T` can: a public URL's `url`, a service's input, a bucket's configuration. It cannot be a node's `name` or `id`, a `deps` binding or a `target`, because those decide the graph's structure and a node's address, and the structure may not differ per environment.

- **Dependencies are explicit, and `fn` receives their values as one tuple**: `resolve([input.a, environment.name], ([a, name]) => …)`, the shape of Vue's `watch(sources, fn)` and Solid's `on(deps, fn)`. A dependency is a module input reference, a reference to a deploy-time fact, or another `ResolvedValue`. The list is the only way one resolved value can be computed from another, since a `ResolvedValue` is opaque until it is run, and it gives Composer a graph of resolved values it orders before running them and checks for cycles. `fn` is typed from the list. Composer never inspects the function, which keeps the service-input decision's rule that the framework introspects nothing ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)).
- **Deploy-time facts are dependencies like any other.** The module body receives an `environment` object beside `input` and `provision`, holding one opaque reference per fact: `environment.name`, and others as they are needed. A body can only list them as dependencies, so it cannot branch on the environment. A new fact is a new reference, never a new argument to `fn`.
- **`fn` receives values and returns a value.** Secret inputs arrive as opaque `SecretString` boxes.
- **Order of evaluation enforces the rule.** Composer runs the module code and builds the graph with every `resolve()` function unexecuted. It then disables `provision`. It then runs each function for the environment being deployed and validates the result like any other value, so a function that returns nothing for some environment fails the deploy rather than silently picking a default. Only the fully resolved graph is handed to Alchemy, the deploy engine.
- **It is how an opaque input becomes a value.** Module inputs are opaque references, which can otherwise only be passed through unchanged. `resolve()` is how `https://` is put in front of a hostname, or how one environment gets a named hostname and another its prisma.build URL. The lowering layer already does this with Alchemy's `Output.map`; `resolve()` is the authoring-level form.

**Config adapters bring in values that live outside the code.** Some values belong to a file an ops team owns, or a secrets manager, not to `module.ts`. The `composer` section of `prisma.config.ts` names adapters; each receives the environment's name and returns a value; the results merge by top-level key in list order, a later adapter winning; and the merged value is the root module's input, validated by its schema. An adapter is a mechanism, not a value: the config file still carries no application settings ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)); the values stay wherever the adapter reads them. `dotenv()` follows dotenv's own convention: `.env` for every environment, `.env.<environment>` for the one being deployed, plus the `.local` variants. A `secrets` list beside `config` is the home for a secrets manager; its adapters are a separate decision.

Adapters are not how per-environment choice is expressed. That is `resolve()`, in code, where it is reviewed with the topology. An adapter supplies a value; `resolve()` decides what to do with it.

**Four kinds of value, and where each lives:**

| | plain | protected |
| --- | --- | --- |
| **known at deploy time** | `config` adapters, and `resolve()` over them | `secrets` adapters |
| **held by the platform** | — | `envSecret` |

**A key no adapter supplies is absent, and the schema decides.** An optional key left out is simply absent in `fn`, which may return a prisma.build URL for it. A required key left out fails the deploy before anything is created, with the schema's error, as an unset `envParam` does.

**Every environment has a name; none is special.** A nameless "default" environment is a footgun: forgetting a flag lands a deploy, or a teardown, on production. So each command has a default value for its `--environment` parameter, an adapter always receives a name, and so does a `resolve()` that lists `environment.name`. `destroy` has no default: its target names an environment explicitly, so an omitted value can never tear down production ([ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)).

**Local development is an environment like any other.** `prisma dev` runs as the environment the user names, `dev` by default. `environment.name` resolves to `'dev'`; the local target ignores a named hostname regardless. Nothing keys on the name `dev` itself.

**On Prisma Cloud, `production` is the Project's default Branch.** The platform creates each Project with one Branch marked as its default, and the environment `production` resolves to that Branch by its `isDefault` flag; every other environment resolves to the Branch of that `gitName`, created if absent. Composer reads `isDefault`, never the Branch's `role`. This mapping lives in the Prisma Cloud extension; core knows only environment names.

## Consequences

- **`resolve()` ships in `@prisma/composer`**, target-neutral, returning `Value<T>` (see the amendment above); every node parameter and input binding that carries a value accepts a `Value` of its type. `name`, `id`, `deps` and `target` do not. The module body receives `environment` beside `input` and `provision`.
- **The `composer` section has `config`, and later `secrets`.** Its validator rejects unknown keys ([ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md)), so both are known fields, each an array of adapters. `dotenv()` ships with Composer.
- **`prisma deploy` and `prisma dev` take `--environment`**, defaulting to `production` and `dev` ([ADR-0059](ADR-0059-a-deployment-environment-is-called-an-environment.md)); `destroy` takes an environment name with no default.
- **Values in `.env` files are plain.** A secret belongs with `envSecret`, or with a secrets adapter. The root's schema refuses a plain value where it expects `secretString()`.
- **The structure rule is stated in terms of inputs**, amending the environment-resolution decision ([ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)): the graph is the same whatever inputs Composer is given, and branching on the environment is the most common way to break that.

## Alternatives considered

- **A per-parameter callback** (a `url` that is "sometimes a value, sometimes a function"). Rejected: implicit, hard to type, and invisible in the graph. `resolve()` is explicit, typed and recorded.
- **`byEnvironment({ production: …, otherwise: … })`.** Rejected as a second mechanism; a `resolve()` function says the same thing and also covers derivation from inputs.
- **Passing all inputs to `fn`** (`resolve((inputs, environment) => …)`). Rejected: a `ResolvedValue` is opaque, so without a dependency list one resolved value could not be computed from another, and there would be no graph to order or check for cycles.
- **The environment's name as an extra argument to `fn`** (`resolve([input.a], (a, environment) => …)`). Rejected: the name is one deploy-time fact of several, and each would add a positional argument. As a dependency it is listed like everything else.
- **`fn` receiving its values as positional arguments.** Rejected in favour of one tuple, so the parameters and the dependency list have the same shape, as in `Promise.all`.
- **Reading the environment's name in the module body.** Rejected: a module could vary its structure by environment.
- **A `resolve()` value that reads a deploy result**, such as a hostname the platform assigns. Rejected for now: every `resolve()` runs before the deploy, so it sees inputs and environment facts only. A value that exists only after the deploy is a separate mechanism, not needed yet.
- **Per-environment hostnames through `.env` files as the primary story.** Rejected: a rule over an open-ended set of previews belongs in reviewed code, not in one file per environment. Adapters remain for values that live outside the code.
- **A nameless default environment that adapters map themselves** (`dotenv({ defaultEnvironment: 'production' })`). Rejected: it keeps one environment special.
- **Deep-merging adapter values.** Rejected: harder to predict; a `resolve()` can combine values where needed.
- **One list for plain and protected values.** Rejected: a separate `secrets` list makes a secrets adapter the obvious place for a secret.

## Related

- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): module and root `input`, which adapters fill and `resolve()` derives from.
- [ADR-0060](ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md): the public URL, the first consumer of a `resolve()` value.
- [ADR-0059](ADR-0059-a-deployment-environment-is-called-an-environment.md): what an environment is.
- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md) and [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md): environment resolution and the `deploy`/`destroy` surfaces this amends.
- [ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md): the config section this extends.
- [local-dev.md](../10-domains/local-dev.md) and [config-params.md](../10-domains/config-params.md).
