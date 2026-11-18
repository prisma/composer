# ADR-0064: The deploy does not copy local values to platform variables

Amended by [ADR-0067](ADR-0067-prisma-dev-converges-in-a-worker-thread.md): under `prisma dev` the text of each plain platform variable (`plainVariableText`) and the named secrets reach the local target in memory, through the worker thread that runs each converge, not through the app configuration file or `PRISMA_COMPOSER_NAMED_SECRETS`.

```ts
// module.ts
import { appRoot } from '@prisma/composer';
import { variable } from '@prisma/composer-prisma-cloud';

export default appRoot('shop', ({ provision }) => {
  const from = provision(variable({ name: 'EMAIL_FROM' }));
  const apiKey = provision(variable.secret({ name: 'EMAIL_API_KEY' }));
  provision(emailService(), { input: { from, apiKey } });
});
```

```sh
$ prisma deploy --environment staging
✔ check environment variables
Platform variables with no value:
  - EMAIL_API_KEY  (read by service "shop.email", field "apiKey")
    prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview
    prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --branch 'staging'
```

## Decision

A **platform variable** is a variable on the platform that a service reads by name at boot. The app declares each one with a **platform variable node** in its root: `variable({ name })` for a plain value, `variable.secret({ name })` for a **platform secret**, both from `@prisma/composer-prisma-cloud`. `provision()` returns the value, and the root passes it down through module inputs to the services that read it. The loaded graph lists every node and, for each service, the variables it reads, without deploying.

The deploy does not copy a platform variable's value from the developer's local environment: the `secrets` and `config` adapters, by default `.env` files and the shell. An implicit copy can push a local value into a remote environment by accident. For now the operator sets each value on Prisma Cloud with `prisma project env add`, and the deploy creates, changes and deletes no platform variable. Preflight checks only that every variable a service needs has a value. This is not a rule that the deploy may never set a variable. An explicit way to set variables through `deploy`, where the operator says which values go to which environment, is expected later (see Future work).

Destroying the production environment removes the Project, and with it every variable on the platform set on it. Composer records which service reads which variable, checks at deploy that every variable a service needs has a value, lists the ones with none, and reads the value only inside the running service. The rows Composer does write are its own: the `COMPOSER_…` rows of each service, and the create-only `DATABASE_URL` and `DATABASE_URL_POOLED` placeholders of [ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md). Those are variables on the platform, not platform variables: an app can read none of those names.

### Two ways to get a value

A value the operator supplies reaches the app in exactly two ways:

- **A value the deploy reads** is a field of the app root's `input`, a **root input field**. The `config` adapters fill it when the deploy runs ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). It is the only kind of value a `resolve()` can list or a resource's props can hold.
- **A value the service reads at boot** is a platform variable node, provisioned in the app root. Its value is known only at boot, so the deploy writes a pointer to the variable, never its text.

The environment's facts, such as `environment.name`, and the values Composer creates for its own use, through `generatedParam()` and `serviceOrigin()`, are neither.

### What Prisma Cloud does

- **A variable is a row in a project.** A row has `projectId`, `class` (`production` or `preview`), an optional `branchId`, a `key` and a `value`. A row with no `branchId` is the class's shared value. A row with one is that preview branch's override. Prisma Cloud calls these rows environment variables.
- **A deployment receives the rows of its class, with its branch's overrides on top.** The platform copies them into the deployment when it creates it and never reads them again, so a value set later reaches a service only at its next deployment. There is no service scope: every deployment receives every row of its class, its own and other services' alike. The list filter accepts only `projectId`, `class`, `key` and `branchId`.
- **A key is upper case or it does not exist.** The platform refuses a key that does not match `[A-Z_][A-Z0-9_]*`, on write and in the list filter.
- **A value is never empty.** The platform refuses an empty value, so a variable is either present with text or absent.
- **A read returns metadata, never a value.** It returns `updatedAt`, and `isManagedBySystem` for a row the platform owns.
- **The operator sets a row with the `prisma` CLI.** `prisma project env add 'NAME=<value>' --project <id> --role production` sets the production row. `--role preview` sets the preview-wide row that every preview branch shares. `--branch <environment>` sets one branch's override. `update`, `list` and `delete` take the same scopes.
- **A process that exits at boot is reported running.** The deployment is started and promoted as soon as it is created. The platform reports it `running`, `prisma deploy` succeeds, and the crashing deployment is promoted. Each request to the service boots it once and gets a 502. The boot error is only in the logs: `prisma service logs <service> --project <id>`.

### The node

- **The constructors.** `variable` is a function with a `secret` property. `variable({ name })` returns a value resource whose value is a plain source, typed `ParamSource<PlatformVariablePayload> & RuntimeValue<string>`; `variable.secret({ name })` returns one whose value is a secret source, typed `SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString>`. Both are core value resources ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)) of type `platform-variable`, with `props: { name, secret }`. The payload, `PlatformVariablePayload`, carries the variable's name and whether it is a secret; the serializer, preflight and `prisma dev` read the name from it.
- **Root only.** Only an `appRoot()` body can provision one. In a `module()` body the call does not compile, and the error names `appRoot()`. An app that names a platform variable therefore has an `appRoot()` root.
- **The value.** `provision(variable({ name: 'EMAIL_FROM' }))` returns the value with `id`, the node's address, on it. A plain value fits a `field()` field of a service's or a module's input. A secret value fits a `secretString()` field only. The value goes nowhere but a field of an input: a plain value in a secret field, a secret value in a `field()`, and any node value in per-key params do not compile. The source's label is `the platform variable "NAME"` or `the platform secret "NAME"`, and core's messages print it where they name a source.
- **The default id** is the variable's name in camel case: split on `_`, drop empty parts, lower-case each part, and capitalise each part after the first. `EMAIL_FROM` gives `emailFrom`, `SMTP_PORT` gives `smtpPort`, `EMAIL_2FA` gives `email2fa`. An explicit id goes on `provision(node, { id })`. Two names that give one id fail Load's duplicate-id error, which names both nodes.
- **It creates nothing.** The target registers a descriptor for `platform-variable` in `prismaCloud().nodes`, and the deploy walk looks it up like every other node ([ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md)). Its lowering creates nothing and writes no row. The application topology sent to Prisma Cloud leaves it out: the platform has no node kind for it, and Composer owns nothing it names. The deploy report has no line for it, because a line would read as something Composer deployed.
- **Where its value may go.** The compiler refuses a node value in a `resolve()` dependency, in a plain field (a schema member written without `field()`), in a field of the other secrecy, and in a service's per-key params, whose binding type admits no source. Load refuses a `resolve()` dependency and a resource's props at run time, and a source a cast gets into a per-key param, with `Service "<address>" binds its param "<name>" to <label of the source>, a value known only at boot. A param takes a literal or a value the deploy has. Bind the value to a field of the service's input instead.` A plain field reached through a cast is refused by the service's own schema at serialize or preflight, and the error ends with `The field "<path>" reads the platform variable "<NAME>".`

### Names

`variable()` and `variable.secret()` check the name they are given when the root's body runs, and fail with a message naming the requirement.

- A name matches `^[A-Z][A-Z0-9_]*$`: an upper-case letter, then upper-case letters, digits and underscores. The platform also accepts a leading underscore; Composer refuses it (see Reasoning).
- These names are reserved: any name starting with `COMPOSER_`, which are Composer's own variables on the platform; `DATABASE_URL` and `DATABASE_URL_POOLED`, which Prisma Cloud sets and manages; `PORT`, which boot sets to the service's port; `PATH` and `HOME`, which `prisma dev` sets from the developer's shell. `HOST` is allowed.

### The graph check

`ExtensionDescriptor` has an optional `checkGraph(graph)`. The CLI calls every extension's `checkGraph` right after Load and before the registry coverage check. So it runs in `prisma deploy`, in `prisma dev` at start and at every rebuild, and in `destroy`. A command that reads only the app's name, such as `log`, does not run Load and does not run the check. A check refuses a graph by throwing core's `GraphCheckError`, which fails the command with `COMPOSE.GRAPH_INVALID` and its message, before anything is created and before any dev service starts. Any other throw from the hook is a bug and reaches the user as one ([ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md)). The check sees the loaded graph only, never the app configuration or the app secrets.

The platform variable nodes are the value resources in `graph.nodes` whose extension is Prisma Cloud's and whose type is `platform-variable`. Prisma Cloud's check holds three requirements, and each error names the variable and every address involved:

1. **One node per name.** Two platform variable nodes with one variable name fail, whatever their ids, and whether each is plain or secret: `The platform variable "EMAIL_FROM" is declared twice in the app root, by "shop.emailFrom" and "shop.sender". Declare each platform variable once and pass its value to every module that needs it.` With three or more it says how many and names every one. When the nodes are not all plain or all secret, it adds which are which. Two nodes with one name and the default id get one id, so Load's duplicate-id error fires first.
2. **One name has one meaning.** A name is either a value the service reads at boot or a value the deploy reads. A plain node and a root input field with one name fail: `"EMAIL_FROM" is used two ways: as the platform variable "shop.emailFrom", which services read at boot, and as input.EMAIL_FROM of root module "shop", which the deploy reads. A name has one meaning in an app. Use one of them, or give the other a different name.` A secret node and a root input field with one name are refused by core's check of a root input field against a secret, in Load, also when no service reads the node ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). Both checks see only the root input fields the root's body passes on, because Composer cannot list a schema's keys.
3. **Not a service's whole input.** A node value bound as a service's whole input fails: `The platform variable "EMAIL_FROM" is bound as the whole input of service "shop.email.service". Bind it to one field of the input instead.` The check reads it from `graph.valueReads`.

### The input document

Each place in a service's input document that reads a platform variable holds a `$platform` marker:

```json
{ "from": { "$platform": { "name": "EMAIL_FROM" } }, "apiKey": { "$platform": { "name": "EMAIL_API_KEY", "secret": true } } }
```

- `name` is the variable. `secret` is `true` for a platform secret.
- The serializer writes a marker for every platform variable value, plain or secret, in place in the binding. It refuses any other param source except `generatedParam()` and `serviceOrigin()`, naming the platform variable nodes as the fix. It reads nothing from the app configuration.
- A `$generated` marker names a variable Composer writes itself, for `generatedParam()` and `serviceOrigin()`. Two `$generated` markers in one document must name different variables, compared without case. Two `$platform` markers for one name are two reads of one variable and are allowed.
- A user key spelled like a marker (`$platform` or `$generated`) gains one leading `$` when written and loses it when read, so only Composer can place a marker.
- The deploy report shows each marker as `$platform NAME` or `$generated NAME`.
- The marker format, the code that finds every marker at any depth, boot's handling of a marker, and the names of Composer's own `COMPOSER_…` rows live in one package, `@internal/input-document`. The serializer, boot and the local target all use it.

### Per-key params read no variable

A service's per-key param takes a literal or a deploy-time value, and no source ([ADR-0032](ADR-0032-params-bind-at-provision-to-a-literal-or-a-deploy-time-value.md)). A compute service declares one per-key param, the reserved `port`, and the deploy needs its number before the service exists, to set the deployment's port mapping. So no param row names a platform variable, and preflight, boot and `prisma dev` read platform variables from input documents only.

### Boot

`service.input()` reads the input document in four steps:

1. **A marker whose variable has no value** leaves its key out of its object. No value means `process.env[name]` is undefined or empty. A marker in an array position cannot be left out: boot fails, naming the variable and the path.
2. **A marker whose variable has text** takes the text.
3. **A marker with `secret: true`** puts the text in a secret box.
4. **The service's schema validates the whole object.** When it fails and step 1 left out at least one variable, the error ends with `(platform variables with no value: X, Y)`.

Empty means unset everywhere: at boot and under `prisma dev`.

### Deploy preflight

Preflight runs after the deploy has resolved the app's Project and Branch, and before Alchemy runs. It writes no variable and reads no value.

- **The names it checks.** Every platform variable, plain or secret, in a service's input binding, at any depth, found from the same walk of each binding, without serializing the service; and every platform variable node no service reads, which are the value resources not in `graph.valueReads`. An invalid input still fails after preflight reports the platform variables. The deploy preflight reads nothing from the app configuration.
- **One list call per name.** The call is filtered by `projectId`, `class` and `key`, and walks every page. The class is `production` for the environment `production` and `preview` for every other. The environment sees the class row, and for a preview environment its own branch's row. At most eight calls run at once. A failed call fails the deploy.
- **The row the platform resolves.** The branch row wins when there is one, otherwise the class row. Preflight keeps that row's `updatedAt`. A change to a class row under a branch override changes nothing the service receives, so it triggers nothing.
- **A system row is refused.** A row the environment sees with `isManagedBySystem: true` fails the deploy, naming the variable.
- **Required or reported, per service.** For each service that reads a variable with no row, preflight serialises the input with every variable present and runs the service's schema. A failure there is an invalid input, reported as such and never blamed on a variable. Then it runs the schema with every variable that has no row left out. If that passes, those variables are optional for that service. If it fails, it leaves out each one alone, and the ones whose absence alone fails are required. When no single one fails alone, the error says the service needs at least one of them. A variable an array position reads is required without a check. This is the method [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md) gives the dev preflight, and both preflights call the same code.
- **A node no service reads** has no reader to need it. It is reported once, named by its node, `named by resource "shop.emailFrom", read by no service`, and never required. That includes a secret node that a module receives and no service reads.
- **A required variable fails the deploy** with `DEPLOY.PREFLIGHT_FAILED`, before Alchemy runs:

  ```text
  Deploy failed. 1 platform variable a service needs has no value:
    - EMAIL_API_KEY  (read by service "shop.email", field "apiKey")

  Set it on the platform, then deploy again:
    - prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview
    - prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --branch 'staging'
  ```

  For production the one command is `--role production`. For every other environment the preview-wide command comes first, so the next preview branch is not missing it too, and the branch command second. A variable that an array position makes required has a second line with the reason, and a line for a service that needs some of several variables ends with the schema's message.
- **The findings.** Every variable with no row that nothing requires is listed, with its readers (a service and field, or the node that names it and that no service reads it) and the commands that set it. `PreflightInput.report` takes a `PlatformVariableCheck`: the count of platform variables checked and this list, names and readers only, never a value. It carries platform-variable findings and that count, nothing else. The deploy prints the list right after the preflight step, under `Platform variables with no value:`. With `--json` it is a message whose data holds the list, and `onEvent` receives it as a `preflight-findings` event. The step's data stays `{ checked, unset }`, two counts. The deploy hands the list to `lower()` as a value, `LowerOptions.findings`, and lowering puts it into `DeploymentResult.findings`; `prisma deploy` repeats it at the end of its report ([ADR-0066](ADR-0066-deploy-runs-alchemy-in-process.md)). An extension's own preflight payload never carries it.
- **Triggers.** Each service's deployment triggers carry `<name>:updatedAt` for each platform variable its input document points at, with `?` when the variable has no row. Changing a value on the platform and deploying again replaces exactly the deployments that read it.

### `prisma dev`

The local target plays the platform's part.

- **A plain platform variable comes from the app configuration.** The target's dev preflight runs in the first process. For each plain node a service reads, found in `graph.valueReads`, it reads the app configuration under the variable's name, once. A text value goes into `plainVariableText`, which `prisma dev` writes into the app configuration file for the second process, and counts toward its readers' fingerprints, so a changed value restarts only its readers. A value that is not text stops `prisma dev` before any service starts: ``The `config` adapters return a number for "SMTP_PORT", not text. prisma dev cannot start, because the platform variable "shop.smtpPort", which service "shop.mail.service" reads, takes text. Make the adapter return a string.``
- **A platform secret comes from the app secrets.** The first process hands the second process the named secrets, the app secrets under the secrets keys of the graph's platform secrets, in `PRISMA_COMPOSER_NAMED_SECRETS`, in memory.
- **A missing value follows ADR-0058.** For a variable a service reads in its input, an unset or empty one is left out of the service's input document, and the schema decides: a required one, or one an array position reads, stops `prisma dev` before any service starts, naming it and the service.
- **Every plain value in the file is checked.** A member of `plainVariableText` that holds a known secret fails with `CONFIG.SECRET_AS_PLAIN_VALUE`, naming the platform variable and the secret, never the value.
- **It isolates.** A local service receives only the variables its own `$platform` markers name. This is a requirement of the local target only: on Prisma Cloud every deployment receives every row of its class.
- **A changed value pauses rebuilds** until `prisma dev` is restarted. After the restart, the deployment's `<name>:updatedAt` trigger replaces only the readers' deployments.
- **A change to what the app reads pauses rebuilds.** A rebuild runs no preflight, so the values and the list of unset variables come from the preflight at start, and a read the change adds would have neither. After a rebuild's Load, `prisma dev` compares two sets with those at start: one key per `valueReads` entry (reader, node and path), and each read node's address with its `props`. Order does not matter. If either set differs, `prisma dev` does not converge, emits the `value-reads-changed` event, and pauses rebuilds until it is restarted. The CLI prints it as a warning: `The platform variables the app reads changed since dev started: reads of "shop.smtpPort" were added, reads of "shop.emailFrom" were removed, and "shop.sender" was changed. Restart dev to apply them; rebuilds are paused until then.` A node whose reads were only added goes in the first clause, one whose reads were only removed in the second, and one whose `props` changed, or whose reads were both added and removed, in the third.
- **Known limit: an edit to the app's own modules.** On a rebuild, the first process loads the entry again with `import()`, and the runtime returns the module it loaded at start. So after an edit to `module.ts` the first process still holds the graph from the start, and the comparison above sees no change. The second process does load the edited code. An edit that adds or removes a node then fails the converge with the existing error that the two processes built different graphs, and an edit that changes a read without changing a node address converges with the values worked out at start. This is how `prisma dev` handles every edit to the graph today, not only platform variables.

## Reasoning

**A platform variable is a node.** A variable the operator sets is part of what an environment needs before the app can run. As a node, the graph lists it, with the services that read it, before anything is deployed, and every message can name it by its address.

**Only the root declares one.** A variable's name is one space per deployed app. A module below the root that named one would claim that name for every app and every instance that uses the module, and would hide from its input what it needs. The root is the app, so it is the one place whose scope matches that space. A module declares the value in its input and the root wires it down.

**An implicit copy moves a local value to a remote environment.** A deploy that copies a missing variable from the app secrets or the app configuration to the platform can carry a developer's test key to production, because `.env` is read for every environment. Copying on each deploy also writes one override row per preview branch. Until the operator can say explicitly which value goes to which environment, the operator sets each value on the platform, in the scope the operator chooses.

**Preflight is the only protection against a missing value.** The platform promotes a deployment whose process exits at boot and reports it running. So a deploy that succeeded with a required variable unset would leave a crashing service in place. Preflight refuses the case it can see without a value: the service's own schema says the variable is needed.

**The schema decides, as a black box.** [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) forbids reading a schema's internals. Leaving variables out and calling `validate` asks the schema exactly whether it can do without them, with no value and no introspection.

**One call per name, not per scope.** The list filter by class and key already returns the class row and every branch row. Listing the whole class would return every branch's `COMPOSER_` rows on a preview project.

**Upper-case names.** The platform accepts no other key, and Composer compares pointer names without case while a process environment on Linux compares them with case. With upper-case names a row and a name never differ by case, so boot finds the row preflight saw.

**No leading underscore.** The platform accepts one; the requirement is Composer's. Shells and tools use names that start with an underscore for their own variables: bash puts `_` in the environment of every command it runs, and the Java virtual machine reads `_JAVA_OPTIONS`. Keeping those names out of the app's names means an app's variable never meets one of them.

**Empty means unset.** The platform cannot store an empty value. `prisma dev` treats empty as unset. Treating empty as unset at boot too makes the two agree.

**The graph check runs after Load.** A requirement that depends on more than one place in the graph cannot be checked in a constructor. Running it right after Load, in every command that runs Load, refuses a bad graph before preflight and before any dev service starts, without a deploy.

## Consequences

- A new environment needs its platform variables set first. For a new app, the first deploy creates the Project and Branch, then stops at preflight with the commands that set each required variable, including the project's id.
- Every new preview branch reads the preview-wide row.
- A deploy succeeds with an optional variable unset and lists it. Because the platform has no way to store "deliberately empty", the list also holds a variable whose absence is intended.
- A process that exits at boot for a reason preflight cannot see, such as a value that the schema refuses, is promoted. The guide names `prisma service logs <service>` as where the error is.
- Every service on Prisma Cloud sees every variable of its class. Composer records which service reads which variable in its graph and in each input document, so it can send that record if the platform ever takes one.
- Under `prisma dev` and on the platform, a service with an unset optional variable receives the same input: the field is absent. Dev's input document leaves the marker out; the deploy's document holds the marker, and boot leaves the key out.
- The deploy reads the app secrets only to redact the values under the graph's secrets keys wherever it prints.
- A test that needs to know which variable a binding reads finds the entry in `graph.valueReads`, takes the node at its `resource` from `graph.nodes`, and reads `props.name`.

## Alternatives considered

- **Copy local values on deploy.** Rejected: an implicit copy is how a local value reaches a remote environment by accident.
- **Succeed with every variable unset, and report.** Rejected: the platform promotes a service that exits at boot and reports it running, so the deploy would leave it crashing. Preflight refuses the case the schema can show without a value.
- **Two list calls per name, one per scope.** Rejected: one call filtered by class and key returns both.
- **The newest row's `updatedAt` as the trigger.** Rejected: a change to a class row under a branch override would redeploy a service whose value did not change.
- **A source with no node**, `envSecret('NAME')` and `envParam('NAME')`, written in any binding. Rejected: it leaves nothing for Load to list as a node and no address to name it by, and `envParam()` in an input binding gave a value the deploy reads a second spelling beside a root input field. Both are removed rather than kept as deprecated spellings, so there is one way to name a platform variable.
- **A platform variable as a property of an input field,** such as `field(type('number'), { env: 'SMTP_PORT' })`. Rejected: a value the operator must set is part of the topology, so it is a node.
- **A platform variable node anywhere in the tree.** Rejected: a nested module naming one claims the name for every app and instance, and hides from its input what it needs.
- **Two nodes for one name reconciled when they agree.** Rejected: with root-only nodes, two declarations of one name are two lines in one body, and refusing them is simpler.
- **The node declares its scope,** such as `variable({ name, scope: 'service' })`. Rejected: where a value lives is the operator's decision in the platform's terms, not the author's.
- **`provision()` returning `{ id, value }`.** Rejected: the value itself with `id` on it matches `generatedParam()` and `serviceOrigin()`, so a binding reads `{ from, apiKey }`.
- **No descriptor for the node**, with core skipping it in lowering and registry coverage. Rejected: it would add a special case to the one lookup every node goes through ([ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md)). The descriptor creates nothing instead.
- **A prefixed node type, `prisma-cloud/platform-variable`.** Rejected: the registry key already sits under the extension, and every key in `prismaCloud().nodes` is a bare name.
- **A platform variable in a service's per-key param**, written as a pointer row the service read at boot. Rejected: a compute service's one per-key param is `port`, which the deploy needs before the service exists, so the deploy would route to 3000 while the service read the variable, and the variable's text also fails `port`'s number schema at boot. Where a compute service's port is set is not decided.
- **Running the dev preflight on every rebuild**, so a change to what the app reads needs no restart. Deferred: it is a separate change to the dev loop.
- **"Subscription" as the word for a service reading a variable.** Rejected: it names a platform mechanism that does not exist, and reads as "receives updates as they happen", which is false.

## Future work

- **An explicit way to set platform variables through `deploy`.** The operator names the values and the environments they go to, and the deploy writes those rows. It needs its own design. It must not read local values implicitly.

## Related

- [ADR-0029](ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md): the secret.
- [ADR-0032](ADR-0032-params-bind-at-provision-to-a-literal-or-a-deploy-time-value.md): per-key params.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): service input and the input document.
- [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md): how `prisma dev` reads secrets and decides required or optional.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): the value resource, root-only provisioning, the reads list, the app configuration and the app secrets.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md): one descriptor lookup for every node.
- [deploying.md](../../guides/deploying.md) and [deploy-cli.md](../10-domains/deploy-cli.md).
