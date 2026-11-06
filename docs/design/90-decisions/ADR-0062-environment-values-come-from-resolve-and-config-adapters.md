# ADR-0062: A value that differs per environment is computed with `resolve()`; values from outside the code come through config adapters

```ts
// module.ts
import { type } from 'arktype';
import { appRoot, resolve } from '@prisma/composer';
import { envSecret, publicUrl } from '@prisma/composer-prisma-cloud';

export default appRoot('shop',
  { input: type({ EMAIL_FROM: 'string', 'SITE_HOSTNAME?': 'string' }) },
  ({ input, environment, provision }) => {
    const web = provision(webService, {
      input: { emailFrom: input.EMAIL_FROM, stripeKey: envSecret('STRIPE_SECRET_KEY') },
    });

    const url = resolve([input.SITE_HOSTNAME, environment.name], ([hostname, name]) =>
      hostname !== undefined ? publicUrl.hostname(hostname)
      : name === 'production' ? publicUrl.hostname('shop.com')
      : publicUrl.prismaBuild());

    provision(publicUrl({ id: 'site', url, target: web.http }));
  });
```

```ts
// prisma.config.ts
composer({
  extensions: [prismaCloud(), nodeBuild()],
  state: prismaState(),
  config: [dotenv(), environmentVariables()],
  secrets: [dotenv(), environmentVariables()],
})
```

```sh
prisma deploy                          # the environment production
prisma deploy --environment staging    # staging
prisma deploy --environment pr-42      # a preview
prisma dev                             # the environment dev, on this machine
```

`prisma deploy` reads `.env`, `.env.production` and their `.local` files, then the shell. The merged result is the root module's input, so `input.EMAIL_FROM` and `input.SITE_HOSTNAME` come from there. The `resolve()` picks the public URL's hostname from `SITE_HOSTNAME` if it is set, and otherwise from the environment's name. `STRIPE_SECRET_KEY` never enters the module: the service reads it from a platform variable at boot. The operator sets that variable on the platform; the deploy checks that it exists and never writes it.

## Decision

A module computes a value that depends on the environment, or on its inputs, with **`resolve()`**. Values that live outside the code reach the root module's `input` through **config adapters**, and secrets reach platform variables through **secrets adapters**, both named in the `composer` section of `prisma.config.ts`. Every environment has a name, and none is special.

All of this serves one requirement: **the graph's structure is the same whatever inputs Composer is given.** Values may differ per environment; nodes and edges may not.

## Why the graph's structure must not depend on inputs

A module body may not provision different nodes in different environments. There are three reasons.

- **A preview mirrors production.** A preview or staging environment is only useful as a test of what production will run. If production had a node that previews lack, nothing that passed on a preview would say much about production.
- **The topology is reproducible and inspectable without a deploy.** Composer Loads the graph before anything runs, so a person or an agent can inspect it and the CLI can answer questions about it without deploying. Standing up a new environment provisions the same graph from nothing. Both need one graph, not one per environment.
- **Identity and review.** A node's address is its identity on every platform. A node that exists only in some environments has an identity that comes and goes with the flag passed to the command. A reviewer reading the code should see the one graph that deploys everywhere.

Branching on the environment is the most common way to break the requirement, which is why the environment gets special attention below. The design meets the requirement by never handing a module body the data an input holds. The body gets stand-ins it can pass on, and a computation runs only after the graph is built.

The requirement covers the data Composer hands the body. A body that reads `process.env`, a file or the clock is outside it. The no-globals principle forbids such reads, but Composer cannot prevent them. A deploy notices when one changes the graph: it Loads the graph in two processes, and the second refuses to deploy a graph whose node addresses differ from the first's.

## Values

A **value**, typed `Value<T>`, is an opaque stand-in, in a module body, for data known later. Its **real value** is that data. The body can pass a value wherever data of its type is accepted: into a child module's or a service's `input`, a service param, or a resource's props, such as a public URL's `url`. A value cannot be a node's `name` or `id`, a `deps` binding or a `target`, because those decide the graph's structure and a node's address.

The body cannot read a value. Turning one into text or a number, serializing it, listing its keys or spreading it throws at Load. A truthiness check or `typeof` cannot be caught, because JavaScript calls no hook for them, but a value is always an object, so such a branch goes the same way in every environment and cannot vary the graph.

A value is **provided** or **computed**. `environment.name` and each field of a module's `input` are provided. A `resolve()` result is computed. Load computes every real value in its second pass, after every module body has run, with `provision` disabled.

A value is also **deploy-time** or **runtime**:

- A **deploy-time value** has its real value by the end of Load: `environment.name`, a `resolve()` result, a field of the root's input, `envParam('NAME')` in a binding, and a module input field bound to one of these.
- A **runtime value** stands for data that only the platform holds, or that the deploy creates after Load. The service reads it at boot. Its type is `RuntimeValue<T>`, which is `Value<Pointer<T>>`: its real value at deploy is a **pointer**, an object that names the platform variable holding the data. A pointer is a **secret pointer**, typed `Pointer<SecretString>`, or a **plain pointer**, typed `Pointer<string>`, and it records its kind in its data. `envSecret()` and a redacted `generatedParam()` give a secret pointer. `serviceOrigin()` and a plain `generatedParam()` give a plain pointer.

| | Plain | Secret |
| --- | --- | --- |
| **Deploy-time:** the deploy has the real value | a literal; a `resolve()` result; a configuration value | none |
| **Runtime:** only the platform has it; the service reads it at boot | `generatedParam()`, `serviceOrigin()` | `envSecret('NAME')`, a redacted `generatedParam()` |

A **configuration value** is a value whose real value is read from the app configuration (below): a field of the root's input, or `envParam('NAME')`.

`envParam()`, `envSecret()`, `generatedParam()` and `serviceOrigin()` each return one object that is both a value and the deploy target's source. Wherever a binding takes a source, the target receives that same object, so the format the deploy writes is the same as for any source. The deploy-time secret cell is empty: this decision gives the deploy no value that holds a secret's data.

## `resolve()`

`resolve(dependencies, fn)` returns a computed value. It lists the values it depends on. Load calls `fn` with their real values as one tuple, and `fn` returns plain data:

```ts
const url = resolve([environment.name], ([name]) =>
  name === 'production' ? 'shop.com' : publicUrl.prismaBuild());
```

- **Dependencies are explicit.** The list has the shape of Vue's `watch(sources, fn)` and Solid's `on(deps, fn)`, and `fn` is typed from it. A value is opaque until Load runs, so the list is the only way one computed value can depend on another. It also gives Composer a graph of computed values, which it orders and checks for cycles. Composer never inspects the function, which keeps the service input decision's requirement that the framework introspects nothing ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)).
- **Facts about the environment are dependencies like any other.** The body receives an `environment` object beside `input` and `provision`, holding one value per fact: `environment.name`, and others as they are needed. A body can only list them, so it cannot branch on the environment. A new fact is a new value, never a new argument to `fn`.
- **A dependency must be a deploy-time value**: `environment.name`, another `resolve()` result, a configuration value, or a plain field of a module's input. A computation over data the deploy does not have can produce nothing useful. So listing a runtime value, a field wrapped with `field()`, or a `secretString()` field fails to compile, with a type error that says a dependency must be a deploy-time value. The compiler cannot see a field typed `unknown`, a schema without type information, or a cast. So Load also refuses a dependency whose real value is a pointer or holds one at any depth, before `fn` runs, naming the field and saying to declare it plain. An unset `envParam()` that is listed fails the Load, naming the variable.
- **`fn` never receives a pointer and never returns a source.** Pointers stay inside Composer: Load produces them, the deploy writes them into the service's input document, and the service reads the variables they name at boot. Load refuses any source `fn` returns. To use a different secret in each environment, give it one name and set a different value for it on each environment.
- **`fn` must be a pure function of its dependencies.** A deploy Loads the graph in two processes, and both must compute the same values.
- **Every value `resolve()` lists is part of the graph**, whichever one `fn` uses.
- **Order of evaluation enforces the requirement.** Composer runs the module bodies and builds the graph with every `fn` unexecuted. It then disables `provision`. It then runs each `fn` for the environment being deployed and checks the result like any other value, so a function that returns nothing for some environment fails the deploy rather than silently picking a default. Only the fully resolved graph reaches Alchemy, the deploy engine.

`resolve()` is how an opaque input becomes a usable value: how `https://` is put in front of a hostname, or how one environment gets a named hostname and another its `prisma.build` URL. The lowering layer does the same with Alchemy's `Output.map`; `resolve()` is the authoring-level form.

A module field that a `resolve()` needs is declared plain, without `field()`. A wrapped field accepts a runtime value with a plain pointer, so its real value may be a pointer ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).

## Config adapters and secrets adapters

Some values belong to a file an ops team owns, or to a secrets manager, not to `module.ts`. The `composer` section of `prisma.config.ts` has two lists for them: `config`, a list of **config adapters**, and `secrets`, a list of **secrets adapters**. The names follow .NET's configuration system, where configuration providers are merged in order into one configuration.

- An adapter receives `{ environment, configDirectory }`: the environment's name and the folder of the declaring `prisma.config.ts`. It returns an object, or a Promise of one.
- The adapters of a list run one at a time, in order. Their results merge by top-level key, and a later adapter wins. A key whose value is `undefined` does not hide an earlier adapter's value.
- The merged result of the config adapters is **the app configuration**. "App" is what Composer calls the application, the outermost module, whose input it fills. It is the root's input, and `envParam()` reads from it. Nothing fills a platform variable from it on a deploy; under `prisma dev` the local target gives a per-key `envParam()` param its value from it.
- The merged result of the secrets adapters is **the app secrets**. Every value in it must be text. Nothing fills a platform variable from it. Under `prisma dev` the local target gives each service the named secrets, the values under the secrets keys of the graph's secret sources, that its own markers name. On a deploy, Composer reads it only to know which values to redact. The app secrets never reach Load or a schema.
- A platform variable is set on the platform, never by the deploy ([ADR-0064](ADR-0064-a-platform-variable-is-set-on-the-platform-never-by-the-deploy.md)). Editing a secret in `.env.production` and deploying again changes nothing on the platform. To change one, change it on the platform and deploy again.
- Both lists default to **`[environmentVariables()]`**, so a project that writes neither reads the shell. A list the author writes replaces the default. To keep reading the shell, include `environmentVariables()`.
- An adapter that throws fails the command with `CONFIG.ADAPTER_FAILED`. An adapter that returns something other than an object, or a secrets adapter that returns a value that is not text, fails it with `CONFIG.ADAPTER_INVALID`.
- Composer reads its own credentials (`PRISMA_SERVICE_TOKEN`, `PRISMA_WORKSPACE_ID`, `PRISMA_REGION`) from the process environment, never from the adapters.

An adapter is a mechanism, not a setting. The config file still carries no application settings ([ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md)); the values stay wherever the adapter reads them.

Adapters do not express a choice per environment. That is `resolve()`, in code, where it is reviewed with the topology. An adapter supplies a value; `resolve()` decides what to do with it.

### The two adapters that ship

- **`environmentVariables()`** returns the whole process environment, with no exception.
- **`dotenv()`** reads `.env` files from the folder of `prisma.config.ts`. It delegates to `dotenv-flow`, pinned to one version, so `dotenv-flow`'s file order is Composer's. The order, lowest first, is `.env`, `.env.local`, `.env.<environment>`, `.env.<environment>.local`. `dotenv-flow` lists its `.env.defaults` file first whenever it is given its own default pattern, so `dotenv()` drops that file from the list and never reads it. `dotenv()` reads files only; it never touches the process environment.

The `dotenv` package defines no order among these files, and Next.js and Vite disagree on whether `.env.local` beats `.env.<environment>`. Delegating to `dotenv-flow` means Composer invents no order of its own. A project that loads `.env` with `import 'dotenv/config'` in `prisma.config.ts` removes that import when it adopts `dotenv()`. Otherwise the import puts `.env`'s values into the process environment, `environmentVariables()` returns them last, and they override `.env.<environment>`.

### Which commands run the adapters

`prisma deploy` and `prisma dev` run both lists, in their first process. `prisma dev` runs them at start and at each rebuild; a changed value pauses rebuilds until dev is restarted, as an edit to `prisma.config.ts` does. `destroy` runs only the config adapters: it Loads the graph, so the app configuration must satisfy the root's schema, but it runs no preflight, so an unreachable secrets manager cannot block a teardown. No other command runs an adapter.

A deploy runs Alchemy in a second process, which Loads the graph again. That process runs no adapter. The first process writes the **app configuration file** beside the generated stack file, `.prisma-composer/app-configuration-<pid>-<uuid>.json`, readable only by its owner and deleted when the deploy ends. It holds what Load read from the app configuration and the first process's node addresses. What Load read is the real value of each path of the root's input that the root's body passes on, and the text of each configuration key an `envParam()` reads. The second process refuses a graph whose node addresses differ from the first process's. So a `.env` file edited during the deploy, or an adapter that would return something else a second time, cannot change what is deployed.

The app configuration file holds no secrets. Load refuses, with `COMPOSE.GRAPH_INVALID`, a name that both an `envParam()` and an `envSecret()` read, and a root input field the root's body passes on when an `envSecret()` in the graph reads the same name. The CLI refuses to write the file, with `CONFIG.SECRET_AS_PLAIN_VALUE`, when any value in it contains a known secret: a value under a secrets key of the graph's secret sources, in the app secrets or the app configuration. A known secret of eight characters or more is refused anywhere in a value, such as the password in a URL. A shorter one is refused only when it equals the whole value, so a placeholder secret such as `dev` does not refuse `dev@example.com`. A number or a boolean is compared as its text. Both refusals name the field, never the value; the CLI's refusal also names the secrets key whose value matched.

`destroy` runs no `secrets` adapter, so its check compares against the values under those names in the app configuration only. On `destroy`, which reads no secrets, a secret only the `secrets` list returns is not known, so the file check cannot refuse it. That is a known limit; a deploy of the same configuration refuses first. Load's refusal of a root field named like an `envSecret()` still applies on destroy.

`prisma dev`'s second process receives the app configuration file the same way. `prisma dev` writes it to the dev environment's directory before each converge and deletes it as soon as that converge ends. Under `prisma dev` only, the second process also receives the named secrets, the app secrets under the secrets keys of the graph's secret sources, in one environment variable, `PRISMA_COMPOSER_NAMED_SECRETS`, in memory. So the handover is one file, plus one variable under `prisma dev`.

The CLI also deletes the file when its process exits, so a run stopped by a second Ctrl-C leaves none. A process killed outright cannot delete its file. So at the start of each deploy, destroy and `prisma dev`, the CLI deletes the app configuration files under `.prisma-composer/` and each dev environment directory whose writing process is not running, by the process id in the file name, and that are older than ten minutes. The age check keeps the file of a run in a container or on another machine that shares the folder, whose process id means nothing here.

## The root's input

The root may declare `input`. Nothing provisions the root, so the deploy binds it: the root's binding is the app configuration. The root's schema checks it before anything is created. A mismatch fails the deploy with the schema's message and the environment's name, and a refused secret field never echoes its value. A key no adapter supplies is absent, and the schema decides: an optional one is left out, and a required one fails the deploy.

By default the app configuration holds every variable of the process environment, secrets included. So the root's body works as any module's does: it names the fields it needs, and only those reach the graph. Nothing stands for the whole input. Passing the whole `input` where a value is accepted fails to compile, and Load refuses it if a cast gets it past the compiler, with an error that says to pass its fields by name.

A root's fields stay plain. The app configuration never holds a pointer, so wrapping a root field would only stop a `resolve()` from using it. A root's input holds no secret, because the app configuration is plain and a `secretString()` field refuses a plain value. A root binds `envSecret()` where it provisions a child, as the example at the top does.

## Keeping secrets out

A secret's value enters no file Composer writes for a deploy, no deploy state, no deploy report and no log line.

- **Pointers.** An `envSecret()` reaches the service's input document as a pointer. The service reads the variable at boot. No `resolve()` sees a secret, because none can list one.
- **Redaction.** Everywhere Composer prints, including errors, events, adapter failures, a thrown defect's cause chain and the second process's failure cause, it redacts one set of known secrets: the values under the secrets keys of the graph's secret sources, in the app secrets and in the app configuration. The app configuration and the app secrets hold values Composer may carry; nothing else in them is a known secret. `prisma dev` compares the whole app secrets between rebuilds to notice a change, which reads them without making them known secrets. A plain value that shares a `.env` file with a secret is not redacted, and under `secrets: [dotenv(), environmentVariables()]` neither is the shell's `SHLVL=1`. Composer also keeps the redaction it already did, which is not part of this decision: a value of eight characters or more under a name that looks like a credential, in the app configuration or the process environment, and token shapes such as JWTs. A known secret is redacted at any length. When two known secrets overlap in the text, the redactor hides every character either one covers. Nothing is redacted by the known secrets before Load has named them: an adapter that throws, and a root schema failure that echoes a field's value, are redacted only by the credential-looking rule. That is a known limit: the names come from the graph.
- **Core knows each secret's name.** A target's secret source tells core which app secrets key holds its value: `secretSource()` takes `secretsKey`, and `envSecret('NAME')` passes `NAME`. That is how Composer knows what to redact, and which secrets `prisma dev` hands its second process.
- **Alchemy's output.** Under the CLI, the command engine gives the second process the terminal, so Composer never sees Alchemy's output and does not redact it, for now. Redacting it needed a change to the engine (prisma/prisma-cli#383), which was dropped: Composer will soon run Alchemy through its programmatic API, in its own process, which lets Composer redact that output. That work must redact Alchemy's output itself. A programmatic host's default runner, `spawnAlchemy`, pipes the second process's output through the stream redactor, so there it is redacted and prints plain lines without colour or a live display. The stream redactor's cost grows with the square of the longest secret's length; that is a known limit, which matters only for secrets of many kilobytes. Under both, the redactor covers everything Composer itself prints, including the second process's failure cause.
- A schema's refusal of a `secretString()` field says what kind of value it got, never the value.

Under `prisma dev`, the local compute emulator keeps each service's environment, secret values included, in its own state file, readable only by its owner.

## Every environment has a name; none is special

A nameless default environment is dangerous: forgetting a flag lands a deploy, or a teardown, on production. So each command has a default for its `--environment` parameter: `prisma deploy` defaults to `production` and `prisma dev` to `dev`. Those are defaults of a parameter, not a privileged environment. An adapter always receives a name, and so does a `resolve()` that lists `environment.name`. `destroy` has no default: its target names an environment, so an omitted value can never tear down production ([ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)).

There is one exception, inherited from `dotenv-flow`: `dotenv()` skips `.env.local` when the environment is `test`, so a developer's machine-wide overrides do not leak into tests.

**Local development is an environment like any other.** `prisma dev` runs as the environment the user names, `dev` by default. `environment.name` is `'dev'`, and the local target ignores a named hostname regardless. Nothing keys on the name `dev` itself.

**On Prisma Cloud, `production` is the Project's default Branch.** The platform creates each Project with one Branch marked as its default. The environment `production` resolves to that Branch by its `isDefault` flag. Every other environment resolves to the Branch with that `gitName`, created if absent. Composer reads `isDefault`, never the Branch's `role`. This mapping lives in the Prisma Cloud extension; core knows only environment names.

## Consequences

- **`@prisma/composer` exports `resolve()`, `Value`, `RuntimeValue` and `Pointer`**, target-neutral, with `isSecretPointer()` and `isPlainPointer()` for authors of schema helpers. Every node parameter and input binding that carries data accepts a `Value` of its type; `name`, `id`, `deps` and `target` do not. The module body receives `environment` beside `input` and `provision`.
- **The `composer` section has `config` and `secrets`**, each a list of adapters defaulting to `[environmentVariables()]` ([ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md)). `@prisma/composer/config` exports `dotenv()` and `environmentVariables()`. The errors decision gains `CONFIG.ADAPTER_FAILED` and `CONFIG.ADAPTER_INVALID`.
- **`prisma deploy` and `prisma dev` take `--environment`**, defaulting to `production` and `dev` ([ADR-0059](ADR-0059-a-deployment-environment-is-called-an-environment.md), [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md)). `destroy` takes an environment name with no default.
- **The app configuration is plain.** A secret belongs with `envSecret()`, whose platform variable the operator sets on the platform. The root's schema refuses a plain value where it expects `secretString()`.
- **`dotenv()` partly reverses the dev secrets decision's rejection of loading `.env` in Composer itself** ([ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md)). Composer ships the loader, but the user still names it in `prisma.config.ts`, so the user still chooses it.
- **This restates the environment-resolution decision** ([ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)): its statement that the environment never appears in the authored topology becomes the requirement that the graph is the same whatever inputs Composer is given.

## Alternatives considered

- **A per-parameter callback**, such as a `url` that is sometimes data and sometimes a function. Rejected: implicit, hard to type, and invisible in the graph. `resolve()` is explicit, typed and recorded.
- **`byEnvironment({ production: …, otherwise: … })`.** Rejected as a second mechanism. A `resolve()` function says the same thing and also covers derivation from inputs.
- **Passing all inputs to `fn`**, as in `resolve((inputs, environment) => …)`. Rejected: values are opaque, so without a dependency list one computed value could not depend on another, and there would be no graph to order or check for cycles.
- **The environment's name as an extra argument to `fn`**, as in `resolve([input.a], (a, environment) => …)`. Rejected: the name is one fact about the environment of several, and each would add a positional argument. As a dependency it is listed like everything else.
- **`fn` receiving its values as positional arguments.** Rejected in favour of one tuple, so the parameters and the dependency list have the same shape, as in `Promise.all`.
- **Reading the environment's name in the module body.** Rejected: a module could vary its structure by environment.
- **A `resolve()` value that reads a deploy result**, such as a hostname the platform assigns. Rejected for now: every `resolve()` runs before the deploy, so it sees inputs and facts about the environment only. A value that exists only after the deploy needs a separate mechanism, not needed yet.
- **`resolve()` receiving a runtime value as its pointer**, and returning it. Rejected: a function cannot compute anything useful from data the deploy does not have. All it can do is pass the pointer on, which a binding already does. Allowing it needed a public check for telling a pointer from data, a special case in Load for a returned pointer, and a preflight check for secrets that only a function named and no service reads.
- **A schema helper that names where a field's value comes from**, such as a helper for "read from an environment variable" or "known only at boot". Rejected: it puts information about where a value comes from into the module that receives it, which breaks encapsulation. Where a value comes from is the caller's choice, made in the binding. `field()` says only what a field accepts.
- **Placeholder values for runtime values during the schema check.** Rejected: a schema that checks a made-up value proves nothing about the real one, a transform runs on fake data, and each source needed a placeholder that every schema would accept. The schema sees the pointer instead, and `field()` and `secretString()` say which fields accept one.
- **Running the plain schema with pointers in place, and ignoring failures at the paths that hold pointers.** Rejected: it works around the problem instead of solving it. The problem is that a field's schema must accept either a value or a pointer to one, and `field()` says exactly that. Ignoring failures would also hide real failures that a refinement or a check across fields reports at the same path.
- **Forwarding a module's whole `input`** to a child or a service. Rejected: a module should receive the input it needs and no more. The root's input holds the whole process environment by default, secrets included, and forwarding it would put them in an input document the platform stores and the deploy report prints.
- **Filtering credentials, or Composer's own `PRISMA_COMPOSER_` variables, out of `environmentVariables()`**, by name or by pattern. Rejected: environment variables are environment variables, and `environmentVariables()` returns all of them, with no special cases. If Composer's own credentials should stop arriving through environment variables, there are other ways to give Composer its authorization. What keeps a secret out of the graph is that only the fields a body names reach it.
- **Per-environment hostnames through `.env` files as the primary story.** Rejected: a choice over an open-ended set of previews belongs in reviewed code, not in one file per environment. Adapters remain for values that live outside the code.
- **A nameless default environment that adapters map themselves**, as in `dotenv({ defaultEnvironment: 'production' })`. Rejected: it keeps one environment special.
- **Deep-merging adapter values.** Rejected: harder to predict. A `resolve()` can combine values where needed.
- **One list for plain and protected values.** Rejected: a separate `secrets` list makes a secrets adapter the obvious place for a secret. What it returns never reaches Load or a schema, and Composer redacts what the graph reads from it.

## Related

- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): module and root `input`, `field()`, and wrapped and plain fields.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): service input, which a service's binding of a value or a pointer reaches.
- [ADR-0060](ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md): the public URL, whose `url` is usually a `resolve()` value.
- [ADR-0059](ADR-0059-a-deployment-environment-is-called-an-environment.md): what an environment is.
- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md) and [ADR-0050](ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md): environment resolution and the `deploy` and `destroy` surfaces.
- [ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md): the `composer` section this extends.
- [ADR-0029](ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md) and [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md): secrets, and how `prisma dev` reads them.
- [ADR-0064](ADR-0064-a-platform-variable-is-set-on-the-platform-never-by-the-deploy.md): platform variables, which the operator sets and the deploy never writes.
- [local-dev.md](../10-domains/local-dev.md) and [config-params.md](../10-domains/config-params.md).
