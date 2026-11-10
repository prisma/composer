# ADR-0064: The deploy does not copy local values to platform variables

```ts
// module.ts
export default appRoot('shop', ({ provision }) => {
  provision(emailService(), {
    input: { from: 'shop@example.com', apiKey: envSecret('EMAIL_API_KEY') },
  });
});
```

```sh
$ prisma deploy --environment staging
✔ check environment variables
Platform variables with no value:
  - EMAIL_API_KEY  (read by service "shop.email", field "apiKey")
    prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview
    prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview --branch 'staging'
```

## Decision

A **platform variable** is an environment variable on the platform that a service reads at boot. Today `envSecret('NAME')` and a per-key `envParam('NAME')` param name one.

The deploy does not copy a platform variable's value from the developer's local environment: the `secrets` and `config` adapters, by default `.env` files and the shell. An implicit copy can push a local value into a remote environment by accident. For now the operator sets each value on Prisma Cloud with `prisma project env add`, and the deploy creates, changes and deletes no platform variable. Preflight checks only that every variable a service needs has a value. This is not a rule that the deploy may never set a variable. An explicit way to set variables through `deploy`, where the operator says which values go to which environment, is expected later (see Future work).

Destroying the production environment removes the Project, and with it every variable set on it. Composer records which service reads which variable, checks at deploy that every variable a service needs has a value, lists the ones with none, and reads the value only inside the running service. The rows Composer does write are its own: the `COMPOSER_…` rows of each service, and the create-only `DATABASE_URL` and `DATABASE_URL_POOLED` placeholders of [ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md). An app can read none of those names.

### What Prisma Cloud does

- **A variable is a row in a project.** A row has `projectId`, `class` (`production` or `preview`), an optional `branchId`, a `key` and a `value`. A row with no `branchId` is the class's shared value. A row with one is that preview branch's override.
- **A deployment receives the rows of its class, with its branch's overrides on top.** The platform copies them into the deployment when it creates it and never reads them again, so a value set later reaches a service only at its next deployment. There is no service scope: every deployment receives every row of its class, its own and other services' alike. The list filter accepts only `projectId`, `class`, `key` and `branchId`.
- **A key is upper case or it does not exist.** The platform refuses a key that does not match `[A-Z_][A-Z0-9_]*`, on write and in the list filter.
- **A value is never empty.** The platform refuses an empty value, so a variable is either present with text or absent.
- **A read returns metadata, never a value.** It returns `updatedAt`, and `isManagedBySystem` for a row the platform owns.
- **The operator sets a row with the `prisma` CLI.** `prisma project env add 'NAME=<value>' --project <id> --role production` sets the production row. `--role preview` sets the preview-wide row that every preview branch shares. `--role preview --branch <environment>` sets one branch's override. `update`, `list` and `delete` take the same scopes.
- **A process that exits at boot is reported running.** The deployment is started and promoted as soon as it is created. The platform reports it `running`, `prisma deploy` succeeds, and the crashing deployment is promoted. Each request to the service boots it once and gets a 502. The boot error is only in the logs: `prisma service logs <service> --project <id>`.

### Names

`envSecret()` and `envParam()` check the name they are given, so Load fails with the message.

- A name matches `^[A-Z][A-Z0-9_]*$`: an upper-case letter, then upper-case letters, digits and underscores. The platform also accepts a leading underscore; Composer refuses it (see Reasoning).
- These names are reserved: any name starting with `COMPOSER_`, which are Composer's own rows; `DATABASE_URL` and `DATABASE_URL_POOLED`, which Prisma Cloud sets and manages; `PORT`, which boot sets to the service's port; `PATH` and `HOME`, which `prisma dev` sets from the developer's shell. `HOST` is allowed.
- **One name has one meaning.** Load refuses a name that `envParam()` or a root input field reads from the app configuration when an `envSecret()` names it as a secret. The Prisma Cloud extension's graph check refuses a name that both an `envParam()` and a field of the root's input use. The error names both uses. Two `envSecret('X')`, or two `envParam('X')`, read one variable and are allowed.

### The graph check

`ExtensionDescriptor` has an optional `checkGraph(graph)`. The CLI calls every extension's `checkGraph` right after Load and before the registry coverage check. So it runs in `prisma deploy`, in `prisma dev` at start and at every rebuild, and in `destroy`. A command that reads only the app's name, such as `log`, does not run Load and does not run the check. A check refuses a graph by throwing core's `GraphCheckError`, which fails the command with `COMPOSE.GRAPH_INVALID` and its message, before anything is created and before any dev service starts. Any other throw from the hook is a bug and reaches the user as one ([ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md)). The check sees the loaded graph only, never the app configuration or the app secrets.

### The input document

Each place in a service's input document that reads a platform variable holds a `$platform` marker:

```json
{ "from": "shop@example.com", "apiKey": { "$platform": { "name": "EMAIL_API_KEY", "secret": true } } }
```

- `name` is the variable. `secret` is `true` for `envSecret()`.
- A `$generated` marker names a variable Composer writes itself, for `generatedParam()` and `serviceOrigin()`. Two `$generated` markers in one document must name different variables, compared without case. Two `$platform` markers for one name are two reads of one variable and are allowed.
- A user key spelled like a marker (`$platform`, `$generated`, or `$secret`) gains one leading `$` when written and loses it when read, so only Composer can place a marker.
- The deploy report shows each marker as `$platform NAME` or `$generated NAME`.
- The marker format, the code that finds every marker at any depth, boot's handling of a marker, and the `COMPOSER_` row keys and per-key param pointer rows that boot reads beside the document live in one package, `@internal/input-document`. The serializer, boot and the local target all use it.

### Boot

`service.input()` reads the input document in four steps:

1. **A marker whose variable has no value** leaves its key out of its object. No value means `process.env[name]` is undefined or empty. A marker in an array position cannot be left out: boot fails, naming the variable and the path.
2. **A marker whose variable has text** takes the text.
3. **A marker with `secret: true`** puts the text in a secret box.
4. **The service's schema validates the whole object.** When it fails and step 1 left out at least one variable, the error ends with `(platform variables with no value: X, Y)`.

A per-key `envParam()` param whose variable has no value takes the param's default, or is left out when the param is optional. Boot fails only for a required one, with: `config param "<name>" (env <key> → <NAME>) has no value: set the platform variable "<NAME>" with prisma project env add.`

Empty means unset everywhere: at boot, for a per-key param, and under `prisma dev`.

### Deploy preflight

Preflight runs after the deploy has resolved the app's Project and Branch, and before Alchemy runs. It writes no variable and reads no value.

- **The names it checks.** Every `envSecret()` in a service's input binding, at any depth; every secret in a module's input that no service reads; and every per-key param bound to `envParam()`. An `envParam()` in an input binding is not a platform variable: the deploy reads its text from the app configuration.
- **One list call per name.** The call is filtered by `projectId`, `class` and `key`, and walks every page. The class is `production` for the environment `production` and `preview` for every other. The environment sees the class row, and for a preview environment its own branch's row. At most eight calls run at once. A failed call fails the deploy.
- **The row the platform resolves.** The branch row wins when there is one, otherwise the class row. Preflight keeps that row's `updatedAt`. A change to a class row under a branch override changes nothing the service receives, so it triggers nothing.
- **A system row is refused.** A row the environment sees with `isManagedBySystem: true` fails the deploy, naming the variable.
- **Required or reported, per service.** For each service that reads a variable with no row, preflight serialises the input with every variable present and runs the service's schema. A failure there is an invalid input, reported as such and never blamed on a variable. Then it runs the schema with every variable that has no row left out. If that passes, those variables are optional for that service. If it fails, it leaves out each one alone, and the ones whose absence alone fails are required. When no single one fails alone, the error says the service needs some of them. A variable an array position reads is required without a check. This is the method [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md) gives the dev preflight, and both preflights call the same code.
- **A per-key param** is required when it has no default and is not optional.
- **A secret in a module's input that no service reads** has no reader to need it. It is reported, never required.
- **A required variable fails the deploy** with `DEPLOY.PREFLIGHT_FAILED`, before Alchemy runs:

  ```text
  Deploy failed. 1 platform variable a service needs has no value:
    - EMAIL_API_KEY  (read by service "shop.email", field "apiKey")

  Set it on the platform, then deploy again:
    - prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview
    - prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview --branch 'staging'
  ```

  For production the one command is `--role production`. For every other environment the preview-wide command comes first, so the next preview branch is not missing it too, and the branch command second. A variable that an array position or a per-key param makes required has a second line with the reason, and a line for a service that needs some of several variables ends with the schema's message.
- **The findings.** Every variable with no row that nothing requires is listed, with its readers (a service and field, a service and per-key param, or the module that names it and that no service reads it) and the commands that set it. `PreflightInput.report` takes a `PlatformVariableCheck`: the count of platform variables checked and this list, names and readers only, never a value. It carries platform-variable findings and that count, nothing else. The deploy prints the list right after the preflight step, under `Platform variables with no value:`. With `--json` it is a message whose data holds the list, and `onEvent` receives it as a `preflight-findings` event. The step's data stays `{ checked, unset }`, two counts. The CLI carries the list to the deploy's second process in core's own transport variable, `PRISMA_COMPOSER_PREFLIGHT_FINDINGS`, and lowering puts it into `DeploymentResult.findings`, so the deploy report repeats it at the end. An extension's own preflight payload never carries it.
- **Triggers.** Each service's deployment triggers carry `<name>:updatedAt` for each platform variable its document or its per-key params point at, with `?` when the variable has no row. Changing a value on the platform and deploying again replaces exactly the deployments that read it.

### `prisma dev`

The local target plays the platform's part.

- It fills each `envSecret()` variable from the app secrets and each per-key `envParam()` variable from the app configuration, under the variable's name. An app configuration value that is not text stops `prisma dev`, naming the variable, the service and the kind of value.
- The first process hands the second process the named secrets, the app secrets under the secrets keys of the graph's secret sources, in `PRISMA_COMPOSER_NAMED_SECRETS`, in memory.
- **It isolates.** A local service receives only the variables its own rows and `$platform` markers point at. This is a rule of the local target only: on Prisma Cloud every deployment receives every row of its class.
- A missing value follows ADR-0058: a required secret, a secret an array position reads, or a required per-key param stops `prisma dev` before any service starts, naming it and the service; an optional one is left out of the service's input, as the deploy's boot leaves it out.
- A changed value pauses rebuilds until `prisma dev` is restarted. After the restart, the fingerprint trigger replaces only the readers' deployments.

### The shortcuts

- `envSecret('NAME')` is the one way to name a platform secret. Every value is text.
- `envParam('NAME')` in an input binding is a value from the app configuration at deploy, not a platform variable. It is deprecated: a field of the root's input replaces it. Its JSDoc carries `@deprecated`, so editors strike it through.
- `envParam('NAME')` in a service's per-key params is a platform variable, under every rule above.

## Reasoning

**An implicit copy moves a local value to a remote environment.** A deploy that copies a missing variable from the app secrets or the app configuration to the platform can carry a developer's test key to production, because `.env` is read for every environment. Copying on each deploy also writes one override row per preview branch. Until the operator can say explicitly which value goes to which environment, the operator sets each value on the platform, in the scope the operator chooses.

**Preflight is the only protection against a missing value.** The platform promotes a deployment whose process exits at boot and reports it running. So a deploy that succeeded with a required variable unset would leave a crashing service in place. Preflight refuses the case it can see without a value: the service's own schema says the variable is needed.

**The schema decides, as a black box.** [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) forbids reading a schema's internals. Leaving variables out and calling `validate` asks the schema exactly whether it can do without them, with no value and no introspection.

**One call per name, not per scope.** The list filter by class and key already returns the class row and every branch row. Listing the whole class would return every branch's `COMPOSER_` rows on a preview project.

**Upper-case names.** The platform accepts no other key, and Composer compares pointer names without case while a process environment on Linux compares them with case. With upper-case names a row and a name never differ by case, so boot finds the row preflight saw.

**No leading underscore.** The platform accepts one; the rule is Composer's. Shells and tools use names that start with an underscore for their own variables: bash puts `_` in the environment of every command it runs, and the Java virtual machine reads `_JAVA_OPTIONS`. Keeping those names out of the app's names means an app's variable never meets one of them.

**Empty means unset.** The platform cannot store an empty value. `prisma dev` already treated empty as unset. Treating empty as unset at boot too makes the two agree.

**The graph check runs after Load.** A rule that depends on more than one place in the graph cannot run in a constructor. Running it right after Load, in every command that runs Load, refuses a bad graph before preflight and before any dev service starts, without a deploy.

## Consequences

- A new environment needs its platform variables set first. For a new app, the first deploy creates the Project and Branch, then stops at preflight with the commands that set each required variable, including the project's id.
- Every new preview branch reads the preview-wide row. A project that relied on the deploy writing one override per branch needs one preview-wide row per name.
- A deploy succeeds with an optional variable unset and lists it. Because the platform has no way to store "deliberately empty", the list also holds a variable whose absence is intended.
- A process that exits at boot for a reason preflight cannot see, such as a value that the schema refuses, is still promoted. The guide names `prisma service logs <service>` as where the error is.
- Every service on Prisma Cloud sees every variable of its class. Composer records which service reads which variable in its graph and in each input document, so it can send that record if the platform ever takes one.
- Under `prisma dev` and on the platform, a service with an unset optional secret receives the same input: the field is absent. Dev's input document leaves the marker out; the deploy's document holds the marker, and boot leaves the key out.
- The deploy still reads the app secrets, only to redact the values under the graph's secrets keys wherever it prints.

## Alternatives considered

- **Keep copying local values on deploy.** Rejected: an implicit copy is how a local value reaches a remote environment by accident.
- **Succeed with every variable unset, and report.** Rejected: the platform promotes a service that exits at boot and reports it running, so the deploy would leave it crashing. Preflight refuses the case the schema can show without a value.
- **Two list calls per name, one per scope.** Rejected: one call filtered by class and key returns both.
- **The newest row's `updatedAt` as the trigger.** Rejected: a change to a class row under a branch override would redeploy a service whose value did not change.
- **Keep reading `$secret` beside `$platform`.** Rejected: the input document and the boot code ship in the same package and the same deployment, so no older document is ever read by newer boot code.

## Future work

- **An explicit way to set platform variables through `deploy`.** The operator names the values and the environments they go to, and the deploy writes those rows. It needs its own design. It must not read local values implicitly, which is what this decision removed.

## Related

- [ADR-0029](ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md): the secret.
- [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md): `envParam()` and per-key params.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): service input and the input document.
- [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md): how `prisma dev` reads secrets and decides required or optional.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): the app configuration and the app secrets.
- [deploying.md](../../guides/deploying.md) and [deploy-cli.md](../10-domains/deploy-cli.md).
