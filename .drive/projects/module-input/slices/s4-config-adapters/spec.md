# S4 — Config adapters and the root's input

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Decisions: the `resolve()` and config adapters decision ([ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), the `composer` section decision ([ADR-0049](../../../../../docs/design/90-decisions/ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md)), the module input decision ([ADR-0061](../../../../../docs/design/90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)), the secrets decision ([ADR-0029](../../../../../docs/design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)), the provision-time params decision ([ADR-0032](../../../../../docs/design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)), the dev secrets decision ([ADR-0058](../../../../../docs/design/90-decisions/ADR-0058-prisma-dev-reads-secrets-from-the-environment-and-never-invents-them.md)), the paths decision ([ADR-0004](../../../../../docs/design/90-decisions/ADR-0004-paths-resolve-relative-to-the-authoring-file.md)) and the root decision ([ADR-0003](../../../../../docs/design/90-decisions/ADR-0003-deploy-derives-everything-from-the-root-node.md)), each with its amendments. This slice implements section 3 of [design-notes.md](../../design-notes.md). It builds on S3 ([S3 spec](../s3-values/spec.md)) after S3's review fixes have landed.

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file and test is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 14 lists the decisions this spec takes, and § 15 the conflicts it found.

Read for this spec: `CLAUDE.md`; `docs/design/01-principles/`; ADR-0003, ADR-0004, ADR-0029, ADR-0032, ADR-0044 (index line), ADR-0049, ADR-0058, ADR-0061 and ADR-0062 with every amendment; the glossary entries Config pool, Value and Environment; `deploy-cli.md`; `local-dev.md`; the S2 and S3 specs; and the code named in each section below.

## 1. At a glance

```ts
// prisma.config.ts
import { defineConfig as composer, dotenv, environmentVariables } from '@prisma/composer/config';
import { nodeBuild } from '@prisma/composer/node/control';
import { prismaCloud, prismaState } from '@prisma/composer-prisma-cloud/control';
import { definePrismaConfig } from 'prisma/config';

export default definePrismaConfig({
  composer: composer({
    entry: './module.ts',
    extensions: [prismaCloud(), nodeBuild()],
    state: prismaState(),
    config: [dotenv(), environmentVariables()],
    secrets: [dotenv(), environmentVariables()],
  }),
});
```

```ts
// module.ts: the root declares its input; the deploy fills it from the config pool
export default module(
  'shop',
  { input: type({ EMAIL_FROM: 'string', 'SITE_HOSTNAME?': 'string' }) },
  ({ input, environment, provision }) => {
    const web = provision(webService, {
      input: { from: input.EMAIL_FROM, stripeKey: envSecret('STRIPE_KEY') },
    });
    const url = resolve([input.SITE_HOSTNAME, environment.name], ([hostname, name]) =>
      hostname !== undefined ? publicUrl.hostname(hostname) : publicUrl.prismaBuild());
    provision(publicUrl({ name: 'site', url, target: web.http }));
  },
);
```

```sh
# .env.staging (committed)
EMAIL_FROM=staging@shop.example
# .env.staging.local (git-ignored)
STRIPE_KEY=sk_test_51...
```

`prisma deploy --environment staging` reads, in this order, `.env`, `.env.local`, `.env.staging` and `.env.staging.local` beside `prisma.config.ts`, then the shell. The root's input is `{ EMAIL_FROM: 'staging@shop.example' }`, validated by the root's schema before anything is created. If the staging Branch has no `STRIPE_KEY` platform variable, preflight sets it from the secrets pool. The value never appears in the generated stack file, the output, the deploy state or the report.

A project whose `composer` section has no `config` or `secrets` key behaves exactly as it does today: both lists default to `[environmentVariables()]`, which reads the process environment.

```text
$ prisma deploy --environment staging      # .env.staging has no EMAIL_FROM, and the shell has none
✖ The input of root module "shop" does not match its input schema: EMAIL_FROM must be a string (was missing). A root's input is the config pool: the values the `config` adapters in prisma.config.ts return for the environment "staging". (COMPOSE.GRAPH_INVALID)
```

## 2. The model

- **A config adapter** is a function in the `config` or `secrets` list of the `composer` section. Composer calls it with the environment's name and the directory of the declaring `prisma.config.ts`, and it returns an object of values by name, or a Promise of one.
- **The config pool** is what the `config` adapters return, merged by top-level key in list order, a later adapter winning. A key whose value is `undefined` is skipped, so it does not hide an earlier adapter's value. Values may be any data; the merge never looks inside them.
- **The secrets pool** is the same merge over the `secrets` adapters. Every value in it is text.
- **Both lists default to `[environmentVariables()]`.** A list the author writes replaces the default, so a project that wants the shell as well lists `environmentVariables()` itself. An empty list is allowed and gives an empty pool.
- **The config pool is the root's input.** The root may now declare `input`. Load validates the config pool with the root's schema, during its second pass, before any service binding is resolved and before anything is created. Keys the schema does not declare are passed to the schema like any other key; whether it ignores or refuses them is the schema's call.
- **`envParam('NAME')` reads `NAME` from the config pool,** wherever it read the deploy shell before: in a module's input and in `resolve()` (S3 already passes the pool to Load), in a service's input when the target serializes it, and when preflight fills the platform variable an `envParam()` service param points at.
- **Preflight fills a missing `envSecret()` platform variable from the secrets pool,** where it read the deploy shell before. `prisma dev` reads a secret's local value from the secrets pool. A name no adapter supplies fails as today.
- **The secrets pool never reaches Load, a schema, a file, an event or a report.** Only preflight, the dev preflight's fingerprints and the local deployments of `prisma dev` read it. The root's input cannot hold a secret: a root schema field typed `secretString()` receives a plain string from the config pool and refuses it.
- **Composer reads the pools in the CLI and again in the deploy engine's process** (the Alchemy child, which imports `prisma.config.ts` and Loads the graph again). An adapter must return the same values for the same environment both times, for the reason a `resolve()` function must be pure.
- **Composer's own credentials do not come from the pools.** `PRISMA_SERVICE_TOKEN`, `PRISMA_WORKSPACE_ID` and `PRISMA_REGION` are still read from the process environment, by the extension and the CLI, as today.

| Command | Config pool | Secrets pool |
| --- | --- | --- |
| `prisma deploy`, the `deploy` operation | read in the CLI and in the deploy child | read in the CLI only, for preflight |
| the `destroy` operation | read in the CLI and in the destroy child | not read |
| `prisma dev`, the `dev` operation | read in the CLI at start, at each rebuild, and in each converge child | the same |
| `prisma deploy list`, `dev url`, `dev stop`, the `log`, `devUrl` and `devStop` operations | not read | not read |

## 3. Core

### 3.1 `control/app-config.ts`: the adapter and pool types

New exports, directly before `PrismaAppConfig`:

```ts
/** What a config adapter receives (ADR-0062). */
export interface ConfigAdapterInput {
  /** The environment's name, as `--environment` gave it. */
  readonly environment: string;
  /** The absolute directory of the prisma.config.ts that declares the `composer` section. A file adapter reads its files relative to it (ADR-0004). */
  readonly configDirectory: string;
}

/** The values one adapter returns, by name. */
export type ConfigValues = Readonly<Record<string, unknown>>;

/**
 * A function in the `config` or `secrets` list of the `composer` section (ADR-0062):
 * it receives the environment and returns that environment's values. Composer calls it
 * in the CLI and again in the deploy engine's process, so it must return the same
 * values for the same environment both times.
 */
export type ConfigAdapter = (input: ConfigAdapterInput) => ConfigValues | Promise<ConfigValues>;

/** What the `config` adapters return, merged by top-level key, a later adapter winning: the root's input, and what `envParam()` reads. */
export type ConfigPool = Readonly<Record<string, unknown>>;

/** What the `secrets` adapters return, merged the same way. Every value is text. Only preflight and local dev read it; it is never logged, reported or written anywhere but the platform variable it fills. */
export type SecretsPool = Readonly<Record<string, string>>;

/** The two pools one command read for one environment. */
export interface ConfigPools {
  readonly config: ConfigPool;
  readonly secrets: SecretsPool;
}
```

`PrismaAppConfig` gains two members after `state`:

```ts
  /** Where the config pool comes from. Defaults to `[environmentVariables()]`; a list given here replaces the default. */
  readonly config?: readonly ConfigAdapter[];
  /** Where the secrets pool comes from. Defaults to `[environmentVariables()]`; a list given here replaces the default. */
  readonly secrets?: readonly ConfigAdapter[];
```

`PreflightInput` gains, after `environment`:

```ts
  /** The pools the command read for this environment. Preflight fills a missing `envSecret()` platform variable from `pools.secrets` and an `envParam()` param's from `pools.config`. */
  readonly pools: ConfigPools;
```

`LocalTargetProvidersInput` and `LocalTargetAttachInput` each gain, after `devDir`:

```ts
  /** The pools the command read for this environment. A local deployment takes the values its rows point at from them. */
  readonly pools: ConfigPools;
```

The field is required in all three. Every caller is the CLI, the generated dev stack file or a test.

The `PrismaAppConfig` doc comment's first sentence gains: `` `config` and `secrets` list the adapters the two pools come from. ``

### 3.2 `control/local-target.ts`

```ts
export function localTargetProviders(
  resolved: ReadonlyMap<string, LocalTargetDescriptor>,
  containers: ReadonlyMap<string, ContainerInstance>,
  devDir: string,
  pools: ConfigPools,
): Layer.Layer<never>;
```

It passes `{ container: containers.get(id), devDir, pools }` to each `descriptor.providers`.

### 3.3 Load: the root's input

`load-module.ts`, `loadModule`. S2's check

```ts
if (root.inputSchema !== undefined) {
  throw new LoadError(`Module "${root.name}" declares input but is being deployed as the root. …`);
}
```

is replaced by:

```ts
if (root.inputSchema !== undefined) {
  if (opts?.configPool === undefined) {
    throw new LoadError(
      `Module "${root.name}" declares input and is being deployed as the root, but Load was given ` +
        'no config pool to fill it from. Pass { configPool } to Load; prisma deploy and prisma dev ' +
        'pass the values the `config` adapters return.',
    );
  }
  moduleInputs.push({
    moduleAddress: rootId,
    schema: root.inputSchema,
    binding: opts.configPool,
    fromConfigPool: true,
  });
}
```

It runs after the root's `deps`, `secrets` and `params` checks and before `flatten`, so the root's entry is first in `moduleInputs` and is validated before every other module's (S2's parents-first order). `flatten` already builds the root's `input` with `buildModuleInput(selfId)` when the node declares a schema; nothing changes there.

`resolve-values.ts`, `ProvisionedModuleInput` gains:

```ts
  /** True for the root, whose binding is the config pool. */
  readonly fromConfigPool: boolean;
```

The module-child push in `flatten` sets `fromConfigPool: false`.

`validateModuleInput`'s issues error, for an entry with `fromConfigPool: true`, is, verbatim:

```
The input of root module "<address>" does not match its input schema: <messages joined with "; ">. A root's input is the config pool: the values the `config` adapters in prisma.config.ts return<for the environment>.
```

`<for the environment>` is ` for the environment "<name>"` when Load was given `environment`, and empty otherwise. `validateModuleInput` gains a parameter `environment: EnvironmentRealValues | undefined` for this. Every other S2 error keeps its text; for the root the `<site>` is `the input binding of module "<root address>"`.

The `ModuleContext.input` doc comment becomes: `` The module's input: one value per field, typed from its input schema's output (ADR-0061); `undefined` when it declares none. A root's input is the config pool, validated by its schema. Pass a field into a provision() binding or list it as a resolve() dependency. ``

### 3.4 Load: a pool-key source reads text

`resolve-values.ts`, the `'source'` case of `resolveOne` (S3 § 4.4) becomes:

```
case 'source':
  if isSecretSource(origin.source): recordSecret(origin.source, site)
  if origin.poolKey === undefined: result = origin.source
  else if configPool === undefined: throw the no-config-pool error (S3 § 4.12)
  else:
    raw = configPool[origin.poolKey]
    if raw === undefined or raw === '': result = undefined
    else if typeof raw === 'string': result = raw
    else: throw the not-text error
```

The not-text error, a `LoadError`, verbatim:

```
<site> depends on <label>, which reads "<key>" from the config pool, but the pool holds <kind> there, not text. A source with a pool key reads text; to pass other data, declare it in the root module's input.
```

`<kind>` is `describeKind(raw)` (§ 3.6).

### 3.5 Doc comments

- `LoadOptions.configPool` in `graph-types.ts`: `The config pool: the values a source with a pool key, such as \`envParam('NAME')\`, reads by name at deploy, and the root's input. Required by any such source whose real value Load needs, and by a root that declares input. The deploy and dev commands pass what the \`config\` adapters return.`
- `LowerOptions.configPool` in `control/deploy.ts`: `The config pool Load reads a source's pool key and the root's input from, and the Prisma Cloud serializer reads a service's envParam() leaves from. The generated stack files pass what readConfigPool() returns.`

### 3.6 `@internal/foundation`: `describeKind`

New file `packages/0-framework/0-foundation/foundation/src/describe-kind.ts`, re-exported from `src/exports/errors.ts`:

```ts
/** How an error names the kind of a value it did not expect, without printing the value. */
export function describeKind(value: unknown): string;
```

| `value` | Result |
| --- | --- |
| `undefined` | `nothing` |
| `null` | `null` |
| an array | `an array` |
| a function | `a function` |
| another object | `an object` |
| a string, number, boolean, bigint or symbol | `a string`, `a number`, `a boolean`, `a bigint`, `a symbol` |

Core, the CLI and the Prisma Cloud target use it, so a message never prints the value it refuses.

### 3.7 Invariants

Core's `process.env` count is unchanged: `control/deploy.ts`, twice. Core imports no `node:` module.

## 4. The CLI: adapters and pools

### 4.1 New file `packages/0-framework/3-tooling/cli/src/config-adapters.ts`

It imports `node:fs`, `node:path`, `parse` from `dotenv`, and the types `ConfigAdapter` and `ConfigValues` from `@internal/core/config`. It imports nothing from `@prisma/cli-engine`.

```ts
/** Reads the process environment when called: every variable whose value is a string. The default for both `config` and `secrets`. */
export function environmentVariables(): ConfigAdapter;
```

The adapter returns a new object with each own key of `process.env` whose value is a string, read at call time, not when `environmentVariables()` runs. An empty string is kept.

```ts
/**
 * Reads `.env`, `.env.local`, `.env.<environment>` and `.env.<environment>.local` from the
 * directory of prisma.config.ts, a later file winning. A missing file is skipped. It does
 * not read the process environment.
 */
export function dotenv(): ConfigAdapter;
```

- The files are read in the order `.env`, `.env.local`, `.env.<environment>`, `.env.<environment>.local`, each relative to `input.configDirectory`, and merged with `Object.assign` in that order. So `.env.<environment>.local` beats `.env.<environment>`, which beats `.env.local`, which beats `.env` (§ 14, decision 6).
- `<environment>` is `encodeURIComponent(input.environment)`, as `devEnvironmentDir` encodes it, so `feature/x` reads `.env.feature%2Fx`.
- Each file is read with `fs.readFileSync(file, 'utf8')` and parsed with `dotenv`'s `parse`. `${VAR}` references are not expanded.
- A file that does not exist (`ENOENT`) is skipped. Any other read error throws a plain `Error`, verbatim: `` dotenv() could not read <absolute path>: <message> ``. The pool reader reports it as `CONFIG.ADAPTER_FAILED` (§ 4.2).
- No file present gives `{}`.
- `dotenv()` takes no arguments.

### 4.2 New file `packages/0-framework/3-tooling/cli/src/config-pools.ts`

It imports `node:path`, `CliStructuredError` and `describeKind` from `@internal/foundation/errors`, the core types, and `environmentVariables` from `./config-adapters.ts`.

```ts
/** Where a pool is read for. */
export interface PoolReadInput {
  /** The environment's name. */
  readonly environment: string;
  /** The absolute path of the prisma.config.ts that declares the section. */
  readonly configFile: string;
}

/** Calls the section's `config` adapters (default `[environmentVariables()]`) and merges what they return: the config pool. */
export function readConfigPool(section: PrismaAppConfig, input: PoolReadInput): Promise<ConfigPool>;

/** Calls the section's `secrets` adapters (default `[environmentVariables()]`) and merges what they return: the secrets pool. Every value must be text. */
export function readSecretsPool(section: PrismaAppConfig, input: PoolReadInput): Promise<SecretsPool>;
```

Both run one module-private function, `readPool(list: 'config' | 'secrets', adapters, input)`:

1. `adapters` is `section[list] ?? [environmentVariables()]`.
2. The adapter input is `Object.freeze({ environment: input.environment, configDirectory: path.dirname(input.configFile) })`. `configFile` is used as given; it is not resolved through symlinks, as the section's `entry` is not.
3. The adapters are called one at a time, in list order, each awaited before the next starts.
4. An adapter that throws, or whose Promise rejects, fails with `CONFIG.ADAPTER_FAILED` (§ 4.3).
5. A result that is not a plain object (`null`, an array, a function, or not an object) fails with `CONFIG.ADAPTER_INVALID`.
6. For `secrets`, a member whose value is neither `undefined` nor a string fails with `CONFIG.ADAPTER_INVALID`, naming the key and its kind, never the value.
7. Each own enumerable string key whose value is not `undefined` is assigned into one plain object (`{}`), in list order, so a later adapter wins. Values are assigned by reference; nothing is copied deeply.
8. The result is `Object.freeze`d and returned.

### 4.3 Errors, verbatim

Each is a `CliStructuredError` with `where: { path: input.configFile }` and `meta: { field: '<list>[<index>]' }`. `<list>` is `config` or `secrets`; `<index>` is the adapter's position.

| Code | Condition | Summary | Why | Fix |
| --- | --- | --- | --- | --- |
| `CONFIG.ADAPTER_FAILED` | the adapter threw or rejected | `` `composer.<list>[<index>]` failed to read the values for the environment "<environment>". `` | `It threw: <message>` (the thrown `Error`'s message, else `String(thrown)`) | `` Fix the adapter, or remove it from `composer.<list>` in prisma.config.ts. `` |
| `CONFIG.ADAPTER_INVALID` | it returned a function | `` `composer.<list>[<index>]` returned a function, not an object of values. `` | — | `` An adapter factory was put in the list instead of the adapter it makes: write `dotenv()`, not `dotenv`. `` |
| `CONFIG.ADAPTER_INVALID` | it returned anything else that is not a plain object | `` `composer.<list>[<index>]` returned <kind>, not an object of values. `` | — | `` Return an object whose keys are the names of the values, e.g. `{ EMAIL_FROM: 'shop@example.com' }`. `` |
| `CONFIG.ADAPTER_INVALID` | a `secrets` adapter returned a value that is not text | `` `composer.secrets[<index>]` returned <kind> for "<key>", but a secret is text. `` | — | `Return the secret as a string. A platform variable holds text.` |

`<kind>` is `describeKind(value)`. The thrown `cause` is set on `CONFIG.ADAPTER_FAILED`.

### 4.4 The section validator: `composer-config.ts`

- `SECTION_FIELDS` becomes `new Set(['entry', 'extensions', 'state', 'config', 'secrets'])`.
- `unknownField`'s two fix texts say `` The section takes only `entry`, `extensions`, `state`, `config` and `secrets`. `` in place of `` The section takes only `entry`, `extensions` and `state`. ``
- New module-private `checkAdapters(list: 'config' | 'secrets', value: unknown): ConfigFinding[]`. `undefined` gives no finding. Otherwise:

  | Condition | Finding (`code: 'CONFIG.FIELD_INVALID'`) |
  | --- | --- |
  | not an array | summary `` `composer.<list>` must be an array of adapters. ``; fix `` Set `<list>` to a list of adapters, e.g. `<list>: [dotenv(), environmentVariables()]`, imported from '@prisma/composer/config'. ``; field `<list>` |
  | an entry that is not a function | summary `` `composer.<list>[<index>]` must be an adapter: a function that receives the environment and returns its values. ``; fix `` Put an adapter here, e.g. `dotenv()`. ``; field `<list>[<index>]` |

- `checkFields` pushes `checkAdapters('config', section['config'])` and then `checkAdapters('secrets', section['secrets'])` after the `entry` finding. The returned value gains `...(config === undefined ? {} : { config })` and the same for `secrets`, as the file's own arrays, by reference. The validator never applies the default; the pool readers do.
- The validator never calls an adapter.

### 4.5 Exports

- New file `packages/0-framework/3-tooling/cli/src/exports/config.ts`:

  ```ts
  /** The config adapters and the pool readers (ADR-0062): imported by prisma.config.ts and by the generated stack files, so this entry imports nothing heavier than node:fs, node:path and dotenv. */
  export { dotenv, environmentVariables } from '../config-adapters.ts';
  export type { PoolReadInput } from '../config-pools.ts';
  export { readConfigPool, readSecretsPool } from '../config-pools.ts';
  ```

- `packages/0-framework/3-tooling/cli/tsdown.config.ts` gains the entry `config: 'src/exports/config.ts'`. The build regenerates `package.json#exports` with `"./config"`; commit it, do not hand-edit it.
- `packages/9-public/composer/src/exports/config.ts` becomes:

  ```ts
  export * from '@internal/core/config';
  export * from '@internal/cli/config';
  ```

- `packages/0-framework/1-core/core/src/exports/app-config.ts` needs no change: `export *` carries the new types.
- `architecture.config.json` needs no change: `packages/0-framework/3-tooling/cli/src/**` already covers both new files as control plane.

### 4.6 Dependencies

`"dotenv": "^17.4.2"` is added to `dependencies` in `packages/0-framework/3-tooling/cli/package.json` and in `packages/9-public/composer/package.json`, the way `cross-spawn` is listed in both: `@internal/*` is inlined into `@prisma/composer`, and an npm dependency stays an import. Run `pnpm install` so the lockfile records it. The examples keep their own `dotenv` dependency, which their `import 'dotenv/config'` still uses.

## 5. The CLI: the commands use the pools

### 5.1 `pipeline.ts`

`PipelineDeps` gains:

```ts
  /** Read the secrets pool too: `deploy` and `dev` do; `destroy` does not, and its `pools.secrets` is empty. */
  readonly readSecrets?: boolean | undefined;
```

`PipelineResult` gains:

```ts
  /** The pools read for this run. In memory only: never written to a file, an event, a result or a report. */
  readonly pools: ConfigPools;
```

In `runPipeline`, between step 2 (the name) and step 3 (Load), a new step, with the steps after it renumbered:

```ts
// 3. Read the pools. The config pool is Load's input; the secrets pool is preflight's.
const poolInput = { environment, configFile: configSource.file };
const pools: ConfigPools = {
  config: await readConfigPool(config, poolInput),
  secrets: deps.readSecrets === true ? await readSecretsPool(config, poolInput) : NO_SECRETS,
};
```

`NO_SECRETS` is a module-level `Object.freeze({})`. Load becomes `Load(entryModule.root, { id: name, environment: { name: environment }, configPool: pools.config })`. The return gains `pools`. `pipeline.ts` no longer contains `process.env`.

### 5.2 `operations/execute-deploy-destroy.ts`

- The `pipelineDeps` passed to `runPipeline` gain `readSecrets: action === 'deploy'`.
- Each `extension.preflight(…)` call gains `pools: pipeline.pools`.

### 5.3 `operations/execute-dev.ts`

- `pipelineDeps` and `watchDeps` gain `readSecrets: true`.
- Each `dev.preflight(…)` call gains `pools: pipeline.pools`; each `dev.attach(…)` call gains `pools: pipeline.pools`.
- **A changed value pauses rebuilds.** The session keeps `pipeline.pools`, read at start. In `rebuild`, directly after `rePipeline` is computed and before the stack file is written, if `!samePools(pipeline.pools, rePipeline.pools)`: set `valuesChanged = true`, emit `{ kind: 'values-changed' }` the first time only, and return. `samePools` is a module-private function that compares both pools with `isDeepStrictEqual` from `node:util`. `pausedForConfig` is renamed `paused` and returns `true` when `valuesChanged` is already true, before its file check, so `rebuildUntilSettled` and the watch callbacks stop rebuilding exactly as they do after a config edit.

`operations/dev.ts`, `DevEvent` gains, after `config-changed`:

```ts
  /** What the `config` or `secrets` adapters return changed since the session started. The session keeps the values it started with and stops rebuilding until it is restarted. */
  | { readonly kind: 'values-changed' }
```

`family/commands/dev.ts` renders it as a warning, verbatim: `The values the config or secrets adapters return changed since dev started. Restart dev to apply them; rebuilds are paused until then.`

### 5.4 The generated deploy stack file: `generate-stack.ts`

The template gains, after the `@prisma/composer/report` import:

```ts
import { readConfigPool } from '@prisma/composer/config';
```

and, after the `config === undefined` check and before `report.captureEngineFailure?.()`:

```ts
const configPool = await readConfigPool(config, { environment: <quoted environment>, configFile: <quoted absolute configFile> });
```

`renderOptions` renders `  configPool,` in place of `  configPool: process.env,`. The deploy stack file never calls `readSecretsPool`.

### 5.5 The generated dev stack file: `dev/generate-dev-stack.ts`

The import line `import { deserializeContainers } from '@prisma/composer/config';` becomes `import { deserializeContainers, readConfigPool, readSecretsPool } from '@prisma/composer/config';` (it stays inside the `imports` array, so no line of the built renderer starts with `import`).

After the `devDir` line:

```ts
const poolInput = { environment: <quoted environment>, configFile: <quoted absolute configFile> };
const pools = { config: await readConfigPool(config, poolInput), secrets: await readSecretsPool(config, poolInput) };
```

`renderOptions` renders `  configPool: pools.config,` in place of `  configPool: process.env,`, and `  providers: localTargetProviders(resolved, containers, devDir, pools),`.

Each file's header comment gains one line, verbatim. The deploy file: `// It reads the config pool again here, from the same adapters, so an adapter must return the same values for the same environment every time.` The dev file: `// It reads the config and secrets pools again here, from the same adapters, so an adapter must return the same values for the same environment every time.`

## 6. The Prisma Cloud target

### 6.1 New file `packages/1-prisma-cloud/1-extensions/target/src/pool-text.ts`

```ts
/**
 * The text the config pool holds for `name`, as an environment variable would: `undefined` when it is absent or empty.
 * Throws the error `notText` builds when the pool holds anything else there.
 */
export function poolText(
  pool: Readonly<Record<string, unknown>>,
  name: string,
  notText: (kind: string) => Error,
): string | undefined;
```

`kind` is `describeKind(value)`.

### 6.2 The serializer: `serializer.ts`

- `SerializeInputOptions.env` becomes `readonly env?: Readonly<Record<string, unknown>>;`, doc comment `Where \`envParam\` leaves are read: the config pool. The process environment when not given.`
- The `envParam` branch of `resolveInputBinding`'s walk reads `poolText(env, value.payload.name, (kind) => new Error(…))` in place of `env[value.payload.name]`. The error, verbatim: `` input binding<key> is bound to envParam('<NAME>'), but the config pool holds <kind> at "<NAME>", not text. envParam() reads text; to pass other data, declare it in the root module's input. `` `<key>` is empty at the root and ` key "<path>"` inside.
- The `process.env` count of `serializer.ts` stays 9.

### 6.3 The compute descriptor: `descriptors/compute.ts`

The `serializeInput(svc, address, …, { absentSecrets: o().preflight.absentSecrets })` call becomes:

```ts
serializeInput(svc, address, graph.inputBindings.find((b) => b.serviceAddress === address)?.binding, {
  absentSecrets: o().preflight.absentSecrets,
  ...(ctx.opts.configPool !== undefined ? { env: ctx.opts.configPool } : {}),
});
```

So the deploy and dev children read a service's `envParam()` leaves from the config pool their stack file read. A hand-written stack that passes no `configPool` keeps reading the process environment.

### 6.4 Deploy preflight: `preflight.ts`

- `runPreflight` records, for each name, which pool fills it: a name in `collected.secrets` reads `input.pools.secrets[name]`; a name only in `collected.envParams` reads `poolText(input.pools.config, name, notText)`. A name in both lists is a secret, since the secrets are taken first, as today.
- The line `const shellValue = process.env[meta.name];` is replaced by that read; the rest of the fill (`fillMissing` when the value is a non-empty string, else `missing.push`) is unchanged.
- `notText` for an env-sourced param, verbatim: `` The config pool holds <kind> at "<NAME>", not text, so preflight cannot set the platform variable envParam('<NAME>') of service "<address>" reads. Make the adapter return a string. ``
- `missingError`'s text does not change.
- Doc comments: the file header's "A name absent on the platform but present in the deploy shell is provisioned …" becomes "A name absent on the platform but present in its pool (the secrets pool for a secret, the config pool for an env-sourced param) is provisioned …". `runPreflight`'s "fills from the shell where possible" becomes "fills from the pools where possible", and "they resolve from the deploy shell at serialize" becomes "they resolve from the config pool at serialize".
- `preflight.ts`'s `process.env` count becomes 1 (`PRISMA_SERVICE_TOKEN`).

### 6.5 Dev preflight: `local-target/preflight.ts`

- `const env = process.env;` is removed. A secret is set when `input.pools.secrets[name]` is a non-empty string. An env-sourced param is set when `poolText(input.pools.config, name, notText)` is defined, with the § 6.4 `notText` text. `inputValidationFailure(…)` receives `env: input.pools.config`.
- The fingerprint of each pointed name is taken over the same value: the secrets pool's for a secret name, the config pool's text for an env-sourced param's; a name in both is a secret.
- `HOW_TO_SET` becomes a function of the environment, verbatim:

  ```
  Set each missing variable where an adapter in prisma.config.ts reads it: the `secrets` list of the `composer` section for a secret, the `config` list for an env-sourced param. environmentVariables() reads the shell you run `prisma dev` from; dotenv() reads .env, .env.local, .env.<environment> and .env.<environment>.local beside prisma.config.ts.
  ```

  with `<environment>` the encoded environment name, as `dotenv()` encodes it.
- The file header's "Every value comes from this run's environment variables: the shell, or a `.env` that `prisma.config.ts` loads." becomes "Every value comes from the pools the command read: secrets from the secrets pool, env-sourced params from the config pool."
- `local-target/preflight.ts` no longer contains `process.env`.

### 6.6 Local deployments: `packages/1-prisma-cloud/0-lowering/local-target/src/compute.ts`

- `pointedVariableNames(rows, address): ReadonlySet<string>` is replaced by:

  ```ts
  /** The variables this service's own rows point at: its param pointer rows, and its input document's `$secret` pointers. */
  export function pointedVariables(
    rows: Readonly<Record<string, string>>,
    address: string,
  ): { readonly params: ReadonlySet<string>; readonly secrets: ReadonlySet<string> };
  ```

- `materializeEnv` gains a fourth parameter, `pools: ConfigPools`. For each name in `secrets`, the value is `pools.secrets[name]`; for each name in `params` that is not also in `secrets`, it is `pools.config[name]` when that is a string. A value is set only when it is a non-empty string, as today. `PATH` and `HOME` still come from `process.env`.
- `LocalDeploymentProvider` passes `input.pools`.
- `packages/1-prisma-cloud/1-extensions/target/src/local-target/attach.ts`: `serve` passes `input.pools` to `materializeEnv`. `shellEnv()` is unchanged: a dev server keeps the developer's shell, with Composer's rows laid over it (ADR-0056).

### 6.7 Invariants

`packages/1-prisma-cloud/1-extensions/target/src/__tests__/invariants.test.ts`, invariant 4: `preflight.ts` count 1; the `local-target/preflight.ts` entry is removed. Its comment's "preflight.ts (the deploy shell's values), local-target/preflight.ts (the dev run's values)" becomes "preflight.ts (PRISMA_SERVICE_TOKEN; values come from the pools)".

## 7. Where a secrets pool value never goes

- **The generated stack files** contain the code that reads the pools, never a value (§ 5.4, § 5.5). The deploy stack file does not read the secrets pool at all, so the deploy engine's process never holds a secret value.
- **Load, the graph and the schemas.** The secrets pool is never passed to Load. A root's input is the config pool.
- **Events, results and reports.** `PipelineResult.pools` stays in memory. No `DeployEvent`, `DevEvent`, operation result, `--report` file or deploy summary carries it. Preflight reports counts only, as today.
- **Errors.** An adapter error names the list, the index, the key and the value's kind (`describeKind`), never the value.
- **Deploy state.** Deploy preflight writes a missing value to the platform variable with the existing write-only call, never through Alchemy. Under `prisma dev`, Alchemy's local state holds the HMAC fingerprint, as today, and the compute emulator keeps each running service's environment, as ADR-0058 records.

## 8. Every existing app keeps working

1. **No `config` or `secrets` key reads the process environment,** in the CLI and in the children, so `envParam()` and the fill of `envSecret()` read the shell as before (§ 11, tests 13, 14 and 43).
2. **A `prisma.config.ts` that does `import 'dotenv/config'`** loads `.env` into `process.env`, and the default `environmentVariables()` reads it, as before.
3. **The wire format is unchanged.** The input document, the pointer rows and the `$secret` pointers are the same objects, serialized the same way.
4. **A root without `input` Loads as before.** Only a root that declares `input` reads the config pool as its input.
5. **The examples deploy and serve as before** (§ 12, QA 1).

The only existing tests this slice changes are listed in § 11.7. If any other existing test fails, the implementer stops and reports.

## 9. Documentation

All in the same pull request, per `.agents/rules/user-facing-surface-changes.mdc`. Each amendment note goes directly after the decision's last existing note.

- **The `composer` section decision**, `ADR-0049-…md`, verbatim:

  > Amended 2026-10-30 (module-input project, fourth slice): the section takes two optional lists, `config` and `secrets`. The validator checks that each is an array of functions, passes the arrays through as the file's own objects, and never calls an adapter. Both default to `[environmentVariables()]`, applied when the pools are read, not by the validator. The generated stack files import `readConfigPool` (and, for `prisma dev`, `readSecretsPool`) from `@prisma/composer/config` and read the pools again in the child, from the same `prisma.config.ts`, so an adapter must return the same values for the same environment in both processes. New codes: `CONFIG.ADAPTER_FAILED` and `CONFIG.ADAPTER_INVALID`.

  Index line gains: ``*(Amended 2026-10-30: the section takes `config` and `secrets` adapter lists, defaulting to `[environmentVariables()]`; the stack files read the pools again in the child.)*``
- **The `resolve()` and config adapters decision**, `ADR-0062-…md`, verbatim:

  > Amended 2026-10-30 (module-input project, fourth slice): config adapters ship. An adapter receives `{ environment, configDirectory }`, the environment's name and the directory of the declaring `prisma.config.ts`, and returns an object or a Promise of one. The `config` adapters' merged values are the **config pool**: the root's input, and what `envParam()` reads. The `secrets` adapters' merged values are the **secrets pool**, which is text only. It does not fill the "known at deploy time, protected" cell of the table below: it seeds the platform variables `envSecret()` points at, so its values sit in the runtime cell, and that cell stays empty until a later decision. A root's input therefore holds no secret. A key whose value is `undefined` does not hide an earlier adapter's value. Both lists default to `[environmentVariables()]`, and a list the author writes replaces the default. `dotenv()` reads `.env`, `.env.local`, `.env.<environment>` and `.env.<environment>.local`, a later file winning; the `dotenv` package defines no order among these files, and Next.js and Vite disagree on whether `.env.local` beats `.env.<environment>`, so this follows Vite and dotenv-flow: the file named for the environment beats the machine-wide local file. Composer's own credentials still come from the process environment.

  Index line gains: ``*(Amended 2026-10-30: config adapters ship; the config pool is the root's input and `envParam()`'s source; the secrets pool seeds `envSecret()` platform variables and never reaches the root's input; `dotenv()` reads four files, the environment's beating `.env.local`.)*``
- **The module input decision**, `ADR-0061-…md`, verbatim:

  > Amended 2026-10-30 (module-input project, fourth slice): a root may declare `input`. Its binding is the config pool, which Load validates with the root's schema first, during its second pass, before anything is created. A root's input takes no secret: the config pool holds plain values, so a `secretString()` field refuses them.

  Index line gains: ``*(Amended 2026-10-30: a root's input is the config pool.)*``
- **The secrets decision**, `ADR-0029-…md`, verbatim:

  > Amended 2026-10-30 (module-input project, fourth slice): a name missing on the platform is filled from the secrets pool, what the `composer` section's `secrets` adapters return, in place of the deploy shell's environment. The default `secrets` list reads the process environment, so a project that sets no list behaves as before.

  Index line gains: ``*(Amended 2026-10-30: preflight fills a missing name from the secrets pool.)*``
- **The provision-time params decision**, `ADR-0032-…md`, verbatim:

  > Amended 2026-10-30 (module-input project, fourth slice): `envParam('NAME')` reads `NAME` from the config pool everywhere it read the deploy shell: in a service's input when the target serializes it, in a module's input and `resolve()`, and when preflight fills the platform variable an `envParam()` param points at. The value must be text.

  Index line gains: ``*(Amended 2026-10-30: `envParam()` reads the config pool.)*``
- **The dev secrets decision**, `ADR-0058-…md`, verbatim:

  > Amended 2026-10-30 (module-input project, fourth slice): under `prisma dev`, a secret comes from the secrets pool and an env-sourced param from the config pool, in the CLI and in the local `Deployment` provider, in place of `process.env`. Both pools default to the process environment, so `import 'dotenv/config'` still works. `dotenv()` is now the documented way to load `.env` files. This partly revisits the rejected "Load `.env` in Composer itself": Composer ships the loader, but the user still names it in `prisma.config.ts`, so the user still chooses where values come from. Listing `.env.<environment>` files per environment also removes this decision's warning for those files: a value in `.env.dev` is never read by `prisma deploy` to `production`. A value in `.env` or `.env.local` still is. When an adapter returns different values at a rebuild than at start, `prisma dev` pauses rebuilds until it is restarted.

  Index line gains: ``*(Amended 2026-10-30: dev reads the secrets and config pools; `dotenv()` is the documented loader.)*``
- **The errors decision**, `ADR-0044-…md`, index line gains: ``*(Amended 2026-10-30: `CONFIG.ADAPTER_FAILED` and `CONFIG.ADAPTER_INVALID` are added.)*`` The decision record gains the same sentence as an amendment note.
- **Glossary**, `docs/design/03-domain-model/glossary.md`:
  - `### Config pool` becomes, verbatim: `The merged values the \`config\` adapters return for the environment being deployed, a later adapter winning by top-level key. It is the root module's input, validated by the root's schema, and what an \`envParam('NAME')\` reads \`NAME\` from, wherever it sits. With no \`config\` list in the \`composer\` section it is the process environment. In code it is \`LoadOptions.configPool\`, and the name a source reads is its **pool key** (\`paramSource()\`'s \`poolKey\` option). Composer reads it in the CLI and again in the deploy engine's process.`
  - New `### Secrets pool`, after it: `The merged values the \`secrets\` adapters return, text only. Deploy preflight fills a missing \`envSecret()\` platform variable from it, and \`prisma dev\` gives a service its secrets from it. It never reaches Load, a schema, a file or a report. With no \`secrets\` list it is the process environment.`
  - New `### Config adapter`, after that: `A function in the \`config\` or \`secrets\` list of the \`composer\` section. It receives the environment's name and the directory of \`prisma.config.ts\`, and returns that environment's values. \`environmentVariables()\` and \`dotenv()\` ship with Composer. An adapter is a mechanism, not a setting: the values stay wherever it reads them ([ADR-0062](../90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).`
  - `### Value`, "Provided or computed": after "…after its schema has validated it." add `A root's input is the config pool.`
  - `### Environment`: after "`prisma dev` to `dev`." add `\`dotenv()\` reads \`.env.<environment>\` for the environment being deployed.`
- **`docs/design/10-domains/deploy-cli.md`**:
  - § The pipeline: a new step after "Resolve the name": `**Read the pools.** The CLI calls the \`config\` adapters, and for \`deploy\` the \`secrets\` adapters, in list order, each awaited, and merges what they return by top-level key, a later adapter winning. Both lists default to \`[environmentVariables()]\`. The config pool is Load's input: the root's input and what \`envParam()\` reads. The secrets pool is held in memory for preflight. An adapter that throws or returns something other than an object fails with \`CONFIG.ADAPTER_FAILED\` or \`CONFIG.ADAPTER_INVALID\`.` The steps after it are renumbered, and step "Load" says the root's input is validated there.
  - Step "Lower and drive" gains: `The generated stack file reads the config pool again, from the same adapters; it never reads the secrets pool.`
  - § Error surface gains rows: `Root's input refused by its schema` → `the schema's messages, and that a root's input is the config pool for the environment`; `A config adapter throws or returns something other than an object (\`CONFIG.ADAPTER_FAILED\`, \`CONFIG.ADAPTER_INVALID\`)` → `which list and position, and the fix`.
  - `destroy` in § Scope gains: `It reads the config pool, because Load validates the root's input; it reads no secrets.`
- **`docs/design/10-domains/local-dev.md`**:
  - The header gains a second amendment line: `> Amended by the module-input project (2026-10-30): secrets and env-sourced params come from the secrets and config pools, which the \`composer\` section's adapters fill and which default to the process environment.`
  - § The pipeline, relative to deploy, step 1: `Import + Load — identical, same errors; the CLI reads both pools first.` Step 5 gains: `The dev stack file reads both pools again and passes them to the local providers.`
  - § Value sourcing table: the `envParam` row's source becomes `the config pool, same names`; the secrets row becomes `the secrets pool: by default the shell, or \`dotenv()\` in the \`secrets\` list. Unset or empty counts as missing. …` (the rest of the cell unchanged). The paragraph "To load a `.env`, install the `dotenv` package …" is replaced by: `To load \`.env\` files, list \`dotenv()\` in \`config\` and \`secrets\`, with \`environmentVariables()\` after it to keep the shell. It reads \`.env\`, \`.env.local\`, \`.env.<environment>\` and \`.env.<environment>.local\` beside \`prisma.config.ts\`. Values in \`.env.dev\` are read only by the environment \`dev\`; values in \`.env\` and \`.env.local\` are read by every environment, \`prisma deploy\` to \`production\` included, whose preflight uploads any secret the environment does not have yet. \`import 'dotenv/config'\` at the top of \`prisma.config.ts\` still works with the default lists.` The sentence "The local `Deployment` provider reads current values from `process.env` …" becomes "The local `Deployment` provider reads current values from the pools the dev stack file read …".
  - § Error surface: the "required secret unset or empty" row's fix becomes `where an adapter in \`secrets\` reads it`; a new row: `an adapter returns different values at a rebuild than at start` → `that the values changed and rebuilds are paused until dev restarts`.
- **`docs/design/10-domains/config-params.md`**: line-97 "it from the deploy shell when absent" becomes "it from the config pool when absent"; the § Sources are values table's service-input cell "read at serialize from the deploy shell, as today" becomes "read at serialize from the config pool"; "which the deploy and dev commands fill with the process environment" becomes "which the \`config\` adapters fill, by default from the process environment"; line-298 "from the deploy shell when the platform lacks it" becomes "from the secrets pool when the platform lacks it".
- **`docs/design/10-domains/core-model.md`**: the `LoadOptions` line's comment becomes `// what a source's pool key reads, and the root's input; the commands pass what the config adapters return`; the `LowerOptions` line's comment becomes `// passed to Load and the serializer; the generated stack files pass readConfigPool()`.
- **`docs/design/10-domains/module-composition.md`**, § Input, "Not supported yet": the sentence about a root's `input` is replaced by `A root's input is the config pool, validated by its schema before any other module's binding.`
- **`docs/guides/building-an-app.md`**:
  - "A module's input": the bullet "A root module cannot declare `input` yet." becomes `- A root module's input is filled from the config adapters ([Values from outside the code](#values-from-outside-the-code)).`
  - A new section `## Values from outside the code`, after "Values that differ per environment". In this order: the § 1 `prisma.config.ts` and `module.ts` examples; one sentence each: a root declares `input` like any module, and the deploy fills it from the `config` adapters; each adapter receives the environment's name and returns values, and later adapters win by top-level key; without `config` or `secrets`, both read the process environment, and a list you write replaces that, so list `environmentVariables()` to keep the shell; `dotenv()` reads `.env`, `.env.local`, `.env.<environment>` and `.env.<environment>.local` beside `prisma.config.ts`, in that order, a later file winning, and an environment name with `/` is encoded (`.env.feature%2Fx`); `envParam('NAME')` reads `NAME` from the config pool; the `secrets` adapters fill a missing `envSecret()` platform variable at deploy and give `prisma dev` its secrets; a root's input takes no secret, so bind `envSecret()` inside the body; the root's schema checks the config pool before anything is created, so a missing value fails with the schema's message; a value in `.env` or `.env.local` is read by every environment, including a `prisma deploy` to `production` from your machine; Composer reads the adapters in the CLI and again in the deploy engine's process, so an adapter must return the same values both times; `PRISMA_SERVICE_TOKEN` and `PRISMA_WORKSPACE_ID` still come from the shell; an adapter is any function, so a project can write its own.
  - "Service input", the `envParam('NAME')` paragraph: "The deploy reads the variable from the environment of the shell that runs `prisma deploy` or `prisma dev`" becomes "The deploy reads the variable from the config pool: by default the shell that runs `prisma deploy` or `prisma dev`, or the `config` adapters you list ([Values from outside the code](#values-from-outside-the-code))".
  - The `envSecret('NAME')` paragraph: "copies a missing one up from the deploying shell" becomes "copies a missing one up from the secrets pool: by default the deploying shell".
  - "Absence is the schema's call": "unset (or empty) in the deploy shell" becomes "unset (or empty) in the config pool".
  - "Sources in resolve()": "read from the deploying shell" becomes "read from the config pool".
- **`docs/guides/deploying.md`**, "CI": in the paragraph that begins "One extra:", "the deploying shell only seeds it" becomes "the secrets pool only seeds it", "the shell" in "absent from both the platform and the shell" becomes "the secrets pool", and the last sentence becomes `An \`envParam\` input is different: the deploy reads it from the config pool on every deploy, so CI exports it, or commits it in \`.env.<environment>\` and lists \`dotenv()\`, every time.` A new paragraph after it: `A root's input and an \`envParam()\` can come from a committed \`.env.<environment>\` file per environment ([Values from outside the code](building-an-app.md#values-from-outside-the-code)). Keep secrets out of committed files: put them in CI's secret store and keep \`environmentVariables()\` in \`secrets\`.`
- **`docs/guides/running-locally.md`**: the paragraph at "Secrets come from the environment `prisma` runs in…" and the bullet "Secrets come from your environment variables." lead with `dotenv()` in `config` and `secrets` (the § 1 config), say `.env.dev` holds values only the environment `dev` reads, and keep `import 'dotenv/config'` as the alternative that works with the default lists. The bullet "A `.env` loaded by `prisma.config.ts` is also read by `prisma deploy`" becomes: `**\`.env\` and \`.env.local\` are read by every environment, including \`prisma deploy\` to \`production\`.** Deploy uploads any secret the target environment does not have yet, so a local-only secret in those files becomes the hosted value. Put local-only values in \`.env.dev\` or \`.env.dev.local\`.` A new bullet: `Changing a value an adapter reads while \`prisma dev\` runs pauses rebuilds at the next rebuild, with a message; restart \`prisma dev\` to use the new values.`
- **`docs/guides/getting-started.md`**: "A secret the app reads must be in the shell `prisma` runs in, or in a `.env` your `prisma.config.ts` loads" becomes "A secret the app reads must be where a `secrets` adapter in `prisma.config.ts` reads it: the shell by default, or `.env.dev` with `dotenv()`".
- **`skills/prisma-composer-core-concepts/SKILL.md`**, written to the rules in `skills/README.md`:
  - Rule 2 of "Rules that bite": "the deploy reads the variable from the deploying shell on every deploy" becomes "the deploy reads the variable from the config pool on every deploy", and "the deploying shell only seeds a missing name" becomes "the secrets pool only seeds a missing name".
  - Under "Values that differ per environment", the first bullet's "A root cannot declare `input` yet" becomes "A root's `input` is the config pool".
  - A new bullet after it: `- \`composer({ config: [...], secrets: [...] })\` lists config adapters; each gets the environment's name and returns values, later wins by top-level key. Both default to \`[environmentVariables()]\` (the shell); a list you write replaces the default. \`dotenv()\` reads \`.env\`, \`.env.local\`, \`.env.<environment>\`, \`.env.<environment>.local\`, later wins. The config pool is the root's input and what \`envParam()\` reads; the secrets pool only seeds \`envSecret()\` platform variables and \`prisma dev\`'s secrets, never the root's input. Both import from \`@prisma/composer/config\`. Credentials (\`PRISMA_SERVICE_TOKEN\`) still come from the shell.`
  - "dev" rule 5: "export them in the shell, or load a `.env`: install the `dotenv` package, then make `import 'dotenv/config'` the first line of `prisma.config.ts` (…)" becomes "put them where a `secrets` adapter reads them: the shell by default, or `.env.dev` with `secrets: [dotenv(), environmentVariables()]`".
- **`.drive/deferred.md`**, under `# Module input — deferred (2026-10-29)`:
  - `prisma dev notices a changed adapter value only at the next rebuild, and then pauses. Watching the files an adapter reads would need adapters to name them.`
  - `The deploy child reads the config pool again. Nothing checks that it got the values the CLI checked; a non-deterministic adapter deploys a graph the CLI did not validate.`

## 10. Scope

In: everything above, in `packages/0-framework/0-foundation/foundation` (§ 3.6), `packages/0-framework/1-core/core` (§ 3), `packages/0-framework/3-tooling/cli` (§§ 4, 5), `packages/9-public/composer` (§§ 4.5, 4.6), `packages/1-prisma-cloud/1-extensions/target` and `packages/1-prisma-cloud/0-lowering/local-target` (§ 6), `docs/`, `skills/`, `.drive/deferred.md`.

Out: a secrets manager adapter such as `doppler()`; any adapter option (`dotenv()` takes none); a deploy-time secret in a root's input; watching the files adapters read; removing the module `params` and `secrets` slots and migrating the examples (S5); any change to boot, the wire format or the deploy report.

## 11. Tests

Runtime tests use `bun test`; type tests use vitest `expectTypeOf` and `@ts-expect-error`. Core fixtures follow `source-load.test.ts`: `echoService()`, `staging`, `loadError()`, `recording(seen)`, `refusing(message)`, `variable(name)`. A test that sets a process environment variable restores it in `afterEach`. File adapters use a fresh `fs.mkdtempSync` directory per test.

### 11.1 Core: new file `packages/0-framework/1-core/core/src/__tests__/root-input.test.ts`

1. `a root that declares input receives the config pool as its input` — root `input: recording(seen)`, body binds `{ from: input.EMAIL_FROM }` on `echoService()`; `configPool: { EMAIL_FROM: 'a@shop.example' }`; the service binding is `{ from: 'a@shop.example' }` and `seen` holds the pool.
2. `the root's schema output is the real value` — ArkType `type({ N: 'string.integer.parse' })`, pool `{ N: '4' }`; the binding holds `4`.
3. `an optional root key the pool lacks is a key left out` — `'SITE?': 'string'`, pool `{}`; `'site' in binding` is false.
4. `pool keys the root's schema does not declare reach the schema, which decides` — ArkType `type({ A: 'string' })` (ignores extra keys) with pool `{ A: 'x', PATH: '/bin' }` Loads; `type({ '+': 'reject', A: 'string' })` with the same pool fails with the issues message.
5. `a root input the schema refuses fails naming the root and the environment` — `refusing('EMAIL_FROM must be a string (was missing)')`, `staging`; the exact § 3.3 message with ` for the environment "staging"`.
6. `without an environment the root's message leaves the environment out`.
7. `a root that declares input fails when Load has no config pool` — the exact § 3.3 message.
8. `a root's secretString() field refuses a plain string from the pool` — ArkType `type({ KEY: secretString() })`, pool `{ KEY: 'x' }`; the message starts `The input of root module "shop" does not match its input schema: `.
9. `the root's schema runs before any other module's` — a child module with a `recording` schema and the root with another; the root's array is filled first (a shared `order` array).
10. `resolve() over a root input field receives the pool's value` — `resolve([input.HOST], ([h]) => \`https://${h}\`)`; `'https://shop.example'`.
11. `a pool-key source whose pool value is not text fails naming its kind` — `variable('N')` in a module's input, `configPool: { N: 4 }`; the exact § 3.4 message with `a number`.

### 11.2 Foundation: `describe-kind.test.ts` beside `describe-kind.ts`

12. `describeKind names each kind and never the value` — one case per § 3.6 row.

### 11.3 CLI: new file `packages/0-framework/3-tooling/cli/src/__tests__/config-pools.test.ts`

The section is `{ extensions: [], state: { extension: 'x', create: () => undefined }, … }`; `input` is `{ environment: 'staging', configFile: '/app/prisma.config.ts' }`.

13. `with no config list, the config pool is the process environment` — `S4_PROBE=probe` set; `readConfigPool(...)['S4_PROBE']` is `'probe'`.
14. `with no secrets list, the secrets pool is the process environment`.
15. `adapters merge by top-level key in list order, a later adapter winning` — `[() => ({ A: '1', B: '1' }), () => ({ B: '2' })]` gives `{ A: '1', B: '2' }`.
16. `an undefined value does not hide an earlier adapter's value`.
17. `the merge is shallow: a later object replaces an earlier one whole` — `{ S: { a: 1 } }` then `{ S: { b: 2 } }` gives `{ S: { b: 2 } }`, and `S` is `toBe` the second adapter's object.
18. `each adapter receives the environment's name and the config file's directory` — it records `{ environment: 'staging', configDirectory: '/app' }`.
19. `an async adapter is awaited, and adapters run one at a time in list order` — two async adapters push to an `order` array before and after an `await`; the order is `['a:start', 'a:end', 'b:start', 'b:end']`.
20. `a list the author writes replaces the default` — `config: []` with `S4_PROBE` set gives `{}`.
21. `an adapter that throws fails with CONFIG.ADAPTER_FAILED naming its list and position` — `secrets: [ok, () => { throw new Error('vault down'); }]`; code, summary ``…`composer.secrets[1]` failed to read the values for the environment "staging".``, why `It threw: vault down`, `meta.field` `secrets[1]`, `where.path` the config file.
22. `an adapter that returns something other than an object fails with CONFIG.ADAPTER_INVALID` — over `null` (`null`), `[]` (`an array`), `'x'` (`a string`), `undefined` (`nothing`); the exact summary and fix.
23. `an adapter factory in place of its adapter names the fix` — `config: [dotenv]` (the factory); `CONFIG.ADAPTER_INVALID`, summary `` `composer.config[0]` returned a function, not an object of values. `` and the exact fix.
24. `a secrets adapter that returns a value that is not text fails naming the key and its kind, never the value` — `{ TOKEN: 918273645 }`; the exact summary with `a number` and `"TOKEN"`; `JSON.stringify(error)` and `error.message` do not contain `918273645`.
25. `the pools are frozen plain objects` — `Object.isFrozen`, `Object.getPrototypeOf(pool) === Object.prototype`.

### 11.4 CLI: new file `packages/0-framework/3-tooling/cli/src/__tests__/config-adapters.test.ts`

26. `environmentVariables() reads the process environment when called, not when created` — create the adapter, then set `S4_LATE=late`, then call it.
27. `dotenv() reads the four files, the environment's local file winning, then the environment's file, then .env.local, then .env` — each file sets `KEY` to its own name and one unique key; `KEY` is `.env.staging.local`, and all four unique keys are present.
28. `dotenv() skips files that do not exist, and gives {} when none does`.
29. `dotenv() reads beside prisma.config.ts, not the working directory` — the files in the temp dir, `process.cwd()` elsewhere.
30. `dotenv() does not read the process environment` — `S4_PROBE` set, no file sets it; the result has no `S4_PROBE`.
31. `dotenv() encodes an environment name with a slash` — environment `feature/x`; `.env.feature%2Fx` is read.
32. `dotenv() fails naming a file it cannot read` — a directory named `.env`; the error message starts `dotenv() could not read <dir>/.env: `.
33. `dotenv() leaves ${VAR} references as written` — `A=x` and `B=${A}`; `B` is `'${A}'`.

### 11.5 CLI: the validator, the pipeline, the stack files and the operations

34. `family/__tests__/section.test.ts`: `config and secrets are passed through as the file's own arrays` — `toBe` each array; the value has no `config` key when the section has none.
35. Same file: `config or secrets that is not an array fails` and `an adapter entry that is not a function fails` — the exact § 4.4 findings, for both lists.
36. Same file: `the validator never calls an adapter` — an adapter that throws when called; the section is accepted.
37. `__tests__/pipeline.test.ts`: `runPipeline passes the config pool the adapters return to Load` — a copy of the `pipeline-config-pool` fixture whose `prisma.config.ts` sets `config: [() => ({ CONFIG_POOL_PROBE: 'adapter' })]`, with `CONFIG_POOL_PROBE=shell` in the process environment; the binding is `{ greeting: 'adapter' }`, and `result.pools.config` is `{ CONFIG_POOL_PROBE: 'adapter' }`.
38. Same file: `runPipeline reads the secrets pool only when asked` — `readSecrets` unset gives `pools.secrets` `{}` and a throwing `secrets` adapter is never called; `readSecrets: true` calls it and fails with `CONFIG.ADAPTER_FAILED`.
39. `__tests__/generate-stack.test.ts`: the deploy file contains `import { readConfigPool } from '@prisma/composer/config';`, the `readConfigPool(config, { environment: "staging", configFile: <absolute> })` line, `  configPool,`, and no `readSecretsPool`.
40. `dev/__tests__/generate-dev-stack.test.ts`: the dev file contains the extended `@prisma/composer/config` import, the `poolInput` and `pools` lines, `  configPool: pools.config,` and `localTargetProviders(resolved, containers, devDir, pools)`. With `S4_SECRET_SENTINEL=never-in-the-stack-file` in the process environment, neither rendered file contains `never-in-the-stack-file`.
41. `__tests__/stack-file-import.test.ts`: the stub `@prisma/composer/config` gains `readConfigPool = async (section, input) => ({ read: 'config', environment: input.environment, configFile: input.configFile })` and `readSecretsPool = async () => ({ read: 'secrets' })`; the stub `lower` prints `configPool: opts.configPool` and the stub `localTargetProviders` records its fourth argument on `globalThis`, which the stub `lower` prints as `pools`. The deploy stack prints `configPool: { read: 'config', environment: 'staging', configFile: <the fixture's prisma.config.ts> }` and no `pools`; the dev stack prints the same `configPool` and `pools: { config: …, secrets: { read: 'secrets' } }`.
42. `operations/__tests__/operations.test.ts`: `deploy fills the root's input from the config adapters` — a fixture root declaring `input: type({ GREETING: 'string' })` forwarded to the service; a `prisma.config.ts` with `config: [() => ({ GREETING: 'from-adapter' })]`; the fake alchemy sees the stack file; the graph's binding is `{ greeting: 'from-adapter' }`.
43. Same file: `deploy hands every extension's preflight both pools` — a fake extension's `preflight` records `input.pools`; it equals the adapters' merged values.
44. Same file: `destroy reads no secrets` — a `secrets` adapter that throws; destroy reaches the fake alchemy.
45. Same file: `log, devUrl and devStop run no adapter` — `config` and `secrets` adapters that throw; each operation gets past identity resolution as it does today.
46. Same file: `a secrets pool value appears in no event, result or report` — a `secrets` adapter returning `{ S4_SENTINEL: 'never-printed-7f3a' }` and a fake preflight that receives it; `JSON.stringify` of every `DeployEvent`, the result and the `--report` file contain no `never-printed-7f3a`.
47. Same file: `an adapter that fails stops deploy with CONFIG.ADAPTER_FAILED before any container is resolved` — the fake container's `ensure` is never called.
48. Same file: `dev hands both pools to preflight and attach`.
49. Same file: `a value an adapter returns differently at a rebuild is reported, and rebuilds stop until dev restarts` — a `config` adapter that reads a mutable `let value`; change it, trigger a build change; one `{ kind: 'values-changed' }` event, the stack file is not rewritten, and a second build change triggers no rebuild. Modelled on `an edit to prisma.config.ts is reported, and rebuilds stop until dev restarts`.
50. `family/__tests__/` (the test that renders `config-changed`; locate it with `grep -rl "config-changed" family/__tests__`): `values-changed renders as a warning` — the exact § 5.3 text.

### 11.6 Prisma Cloud target and local target

51. `preflight.test.ts`: `a missing secret is filled from the secrets pool, not the shell` — `NAME=shell` in the process environment, `pools.secrets` `{ NAME: 'pool' }`; `fillMissing` receives `'pool'`.
52. Same file: `a missing secret the secrets pool lacks fails, even when the shell has it` — the existing missing-variable error.
53. Same file: `a missing env-sourced param is filled from the config pool`.
54. Same file: `a name bound as a secret and as an env-sourced param is filled from the secrets pool`.
55. Same file: `an env-sourced param whose config pool value is not text fails naming its kind` — the exact § 6.4 text.
56. `local-target-preflight.test.ts`: `a required secret only the shell has stops prisma dev` — `pools.secrets` `{}`, the process environment has it.
57. Same file: `a secret in the secrets pool satisfies prisma dev, and its fingerprint is the pool value's`.
58. Same file: `an env-sourced param is read from the config pool`.
59. Same file: `the missing-values message says where the adapters read` — the exact § 6.5 text for the environment `dev` (`.env.dev`).
60. `input-serializer.test.ts`: `an envParam() leaf reads the env it is given` — `env: { G: 'pool' }` with `G=shell` set; the document holds `'pool'`.
61. Same file: `an envParam() leaf whose value is not text fails naming the key and its kind` — the exact § 6.2 text.
62. The target test that drives the compute descriptor's `serialize` (`control-lowering.test.ts`, or the file the implementer finds with `grep -l "serializeInput\|inputRow" src/__tests__`; if none drives it, stop and report): `the input document reads envParam() leaves from LowerOptions.configPool` — `configPool: { G: 'pool' }`, `G=shell` set; the input row holds `'pool'`.
63. `packages/1-prisma-cloud/0-lowering/local-target/src/__tests__/compute-materialize-env.test.ts`: `a local deployment takes its secrets from the secrets pool and its param pointers from the config pool, never the shell` — the shell sets both names to `shell`; the materialized env holds the pools' values.
64. Same file: `a param pointer whose config pool value is not text is left out`.

### 11.7 Existing tests whose subject changed

- `module-input.test.ts`: test 27, `a root that declares input fails`, is removed; § 11.1 tests 1 and 7 replace it.
- `pipeline.test.ts`: `runPipeline passes the process environment to Load as the config pool` is renamed `with no config list, runPipeline passes the process environment to Load as the config pool`. Its body does not change.
- `generate-stack.test.ts`, `generate-dev-stack.test.ts`, `stack-file-import.test.ts`: the S3 assertions on `  configPool: process.env,` are replaced by tests 39 to 41.
- `section.test.ts`: `an unknown field is an error naming the fields the section takes` expects the § 4.4 text.
- `dev-pointed-variables.test.ts`: it calls `pointedVariables` and expects `{ params, secrets }` with the same names split by kind.
- `compute-materialize-env.test.ts`: existing calls pass a fourth argument, the pools holding the values the test put in the process environment before.
- Every test that builds a `PreflightInput`, a `LocalTargetProvidersInput` or a `LocalTargetAttachInput` gains `pools`. A test that set `process.env[NAME]` for preflight to fill moves the value into `pools.secrets`, or `pools.config` for an env-sourced param.
- The target's `invariants.test.ts`, per § 6.7.

## 12. Done when

- Tests 1 to 64 and the type tests pass; `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm test` are green at the root.
- Type tests, in a new `packages/0-framework/1-core/core/src/__tests__/config-adapters.test-d.ts`: `defineConfig({ …, config: [() => ({ A: 1 })], secrets: [async () => ({ B: 'b' })] })` compiles; `config: [{}]` and `config: () => ({})` are errors; `ConfigAdapter`'s parameter is `ConfigAdapterInput`; `PreflightInput['pools']` is `ConfigPools`. (`environmentVariables()` and `dotenv()` are declared to return `ConfigAdapter`, so the compiler already checks them.)
- Manual QA, recorded in `qa.md` in this slice's folder, in `examples/env-param`, with the repo's deploy credentials:
  1. **Unchanged.** With no edit, `ENV_PARAM_GREETING=hi pnpm deploy`, then `EXPECTED_GREETING=hi pnpm smoke:deployed` passes. `ENV_PARAM_GREETING=hi prisma dev --detach`, then `curl "$(prisma dev url env-param-example.echo)"` prints `{"greeting":"hi","environment":"deployed to dev"}`; then `prisma dev stop`.
  2. **The edit.** `module.ts`: the root becomes `module('env-param-example', { input: type({ GREETING: 'string' }) }, ({ input, environment, provision }) => …)`, binding `greeting: input.GREETING`, and it provisions a module `greeter` declaring `input: type({ 'key?': secretString() })` that provisions nothing, bound `{ key: envSecret('S4_QA_SECRET') }`. `prisma.config.ts`: `config: [dotenv()]` and `secrets: [dotenv()]`, imported from `@prisma/composer/config`. Files beside it: `.env.s4-qa` with `GREETING=from-env-s4-qa`, `.env.s4-qa.local` with `S4_QA_SECRET=s4-qa-value`, `.env.dev` with `GREETING=from-env-dev`.
  3. **Root input from `.env.<environment>`, deployed.** With `ENV_PARAM_GREETING` and `GREETING` unset in the shell, `ENV_PARAM_ENVIRONMENT=s4-qa pnpm deploy`: the preflight step reports one filled setting, and `ENV_PARAM_ENVIRONMENT=s4-qa EXPECTED_GREETING=from-env-s4-qa pnpm smoke:deployed` passes. `prisma project env` (or the Console) shows `S4_QA_SECRET` on the `s4-qa` Branch. Neither the deploy output, `.prisma-composer/alchemy.run.ts` nor the report file contains `s4-qa-value` (`grep -r s4-qa-value .prisma-composer .prisma` finds nothing).
  4. **The shell is no longer read.** With `.env.s4-qa` moved aside and `GREETING=from-shell` exported, `ENV_PARAM_ENVIRONMENT=s4-qa pnpm deploy` fails before anything is created with the § 3.3 root message for the environment `s4-qa`. Move the file back.
  5. **`prisma dev` with `.env.dev`.** `prisma dev --detach`, then `curl "$(prisma dev url env-param-example.echo)"` prints `{"greeting":"from-env-dev","environment":"deployed to dev"}`; then `prisma dev stop`.
  6. **A changed value pauses dev.** `prisma dev` in the foreground; edit `.env.dev` to `GREETING=changed`; touch `src/server.ts` and run `pnpm build`. The session prints the § 5.3 warning and does not converge. Ctrl-C.
  7. **Clean up.** `ENV_PARAM_ENVIRONMENT=s4-qa pnpm destroy:environment` succeeds with the edit still in place (destroy reads the config pool and no secrets). Then `git checkout examples/env-param` and remove the three `.env.*` files.
- Every document in § 9 is updated.

## 13. How a reviewer checks the decisions

Each decision in § 14 has a test that fails when the behavior breaks: decision 1 by tests 37, 39 to 41; 2 by tests 18, 29; 3 by tests 19, 21; 4 by tests 26 to 33 and the § 4.6 lockfile entry; 5 by tests 34 to 36; 6 by test 27; 7 by test 31; 8 by tests 38, 44, 45; 9 by tests 11, 55, 61; 10 by test 49; 11 by tests 8, 24, 40, 46; 12 by tests 51 to 59; 13 by test 59.

## 14. Decisions this spec records, for the review

1. **The child reads the pools again from the config; nothing passes them across** (§ 5.4, § 5.5). The child already imports `prisma.config.ts` and Loads the graph from scratch, because the section's descriptors are functions that cannot cross a process boundary; the adapters are the same kind of thing. Passing the pools instead would need a second transport besides the container and preflight ones, would put the secrets pool in an environment variable Composer writes, would make the printed reproduce command depend on that variable, and would limit a pool to what fits in one environment variable. The cost is that each adapter runs twice and must be deterministic, which the `resolve()` purity rule already asks of `fn` for the same reason. The deploy child reads only the config pool, so no secret value enters it.
2. **An adapter receives `{ environment, configDirectory }`** (§ 3.1). The settled scope says an adapter "receives the environment's name". `dotenv()` must also read relative to the declaring `prisma.config.ts` (ADR-0004), and a function in the config cannot learn its file's location otherwise. The section's `entry` already resolves against the same directory.
3. **Adapters may be async, and run one at a time in list order** (§ 4.2). A secrets manager adapter, the next one planned, is a network call. Both the CLI and the stack files are async contexts. Running them in order keeps any side effect in list order.
4. **`dotenv()` uses the `dotenv` package's `parse`, and reads the files itself** (§ 4.1). Don't reinvent the wheel: `dotenv`'s parser is the de facto format (quotes, multi-line values, comments, `export`), three examples already depend on it, and ADR-0058 already recommends it. Composer reads the files itself, so that nothing writes to `process.env` and `dotenv()` reads only files. `dotenv` has no runtime dependencies, works under Node and Bun, and is added to `@internal/cli` and `@prisma/composer` as `cross-spawn` is.
5. **The adapters and the pool readers live in the CLI package, and are exported from `@prisma/composer/config`** (§ 4.5); **the types live in core's `control/app-config.ts`**. Core may not read `process.env` or import `node:` modules (its invariant tests), and `environmentVariables()`, `dotenv()` and the default list need both. The CLI is the target-neutral package that already reads the user's files and environment. `/config` is where the user imports `defineConfig`, and the generated dev stack file already imports from it.
6. **`dotenv()`'s precedence is `.env` < `.env.local` < `.env.<environment>` < `.env.<environment>.local`** (§ 4.1). The `dotenv` package defines no order among these files, and its README advises one file per environment. Next.js puts `.env.local` above `.env.<environment>`; Vite and dotenv-flow put it below. This spec follows Vite and dotenv-flow, because with Next.js's order a developer's machine-wide `.env.local` overrides a committed `.env.production` when they deploy from their machine. § 15, conflict 2.
7. **An environment name is encoded in a file name with `encodeURIComponent`** (§ 4.1), as `devEnvironmentDir` encodes it. A branch name such as `feature/x` is a valid environment, and without encoding its file would be inside a directory named `.env.feature`.
8. **Each command reads only the pools it uses** (§ 2's table). `destroy` reads no secrets; `log`, `devUrl`, `devStop` and `deploy list` read neither, because they do not Load. `destroy` does read the config pool, so a root whose input the pool no longer satisfies cannot be destroyed until it does, as a destroy already needs the built artifacts.
9. **`envParam()` reads text** (§ 3.4, § 6.2, § 6.4). The config pool may hold any data, because the root's schema can parse structured values. An `envParam()` stands for a string, a service param's platform variable holds text, and a `resolve()` function is typed to receive a string, so a pool value that is not text fails, naming its kind.
10. **In `prisma dev`, a changed adapter value pauses rebuilds, as an edit to `prisma.config.ts` does** (§ 5.3). Dev's preflight state (absent secrets, fingerprints) is computed once at start, and the child reads the pools again at every converge. Comparing at each rebuild keeps the CLI and the children from running against different values, the rule ADR-0049 set for the config file.
11. **The root's input takes no secret in this slice** (§ 2). The settled scope routes the secrets pool to preflight only, and the design notes leave a deploy-time secret for later. A `secretString()` root field fails with its schema's message.
12. **Preflight fills an `envParam()` service param's platform variable from the config pool, and a name used both ways from the secrets pool** (§ 6.4). An `envParam()` reads the config pool everywhere else; a secret is the stricter case.
13. **The dev error says where the adapters read, without saying which list is the default** (§ 6.5). Its old text told the user to export the variable in the shell or `import 'dotenv/config'`, which is wrong for a project whose lists do not read the shell. "Fails as today" holds for which names fail and why; only the advice changes.
14. **Composer's credentials stay in the process environment** (§ 2). `prismaCloud()` reads `PRISMA_WORKSPACE_ID` when `prisma.config.ts` is evaluated, before any adapter runs, and the platform client reads `PRISMA_SERVICE_TOKEN`. Moving them into the pools would be a change to the extension and the control operations that no one asked for.

## 15. Conflicts

1. **ADR-0062's table puts `secrets` adapters in the "known at deploy time, protected" cell,** and the design notes list "a value from a `secrets` adapter (later)" as a deploy-time secret. The settled scope makes the secrets pool only the source preflight fills `envSecret()` platform variables from. This spec follows the settled scope, and the ADR-0062 amendment says the protected deploy-time cell stays empty (§ 9).
2. **The settled scope asks for "dotenv's precedence among the files", and ADR-0062 says `dotenv()` "follows dotenv's own convention".** The `dotenv` package has no multi-file convention. The four-file convention comes from Next.js, Vite and dotenv-flow, which disagree about `.env.local` (§ 14, decision 6). The orchestrator settled the order as decision 6 states: the committed per-environment file wins over a developer's `.env.local`.
3. **The settled scope says each adapter "receives the environment's name".** This spec also passes the config directory (§ 14, decision 2).
4. **ADR-0058 rejected "Load `.env` in Composer itself",** and ADR-0062 later decided `dotenv()` ships with Composer. ADR-0058's rejected alternative is partly reversed; its reasoning (the user chooses the loader) still holds, because the user names `dotenv()`. The project spec's list of records to amend does not name ADR-0058, ADR-0044 or ADR-0061 for this slice; this spec amends them (§ 9) because their text would otherwise be wrong.
5. **ADR-0058 says the local `Deployment` provider reads current values from `process.env`** in the child. With adapters it reads the pools (§ 6.6). The amendment says so.
6. **The plan lists only ADR-0049 and ADR-0062, `deploy-cli.md` and `local-dev.md` for S4.** ADR-0029 and ADR-0032 say preflight reads the deploy shell, and the guides and the skill describe the same; the repo rule `user-facing-surface-changes.mdc` requires the guides and the skill to change with the behavior. This spec updates all of them (§ 9).
7. **The design notes say an adapter "returns an object" and ADR-0062 says "returns a value".** This spec requires a plain object (or a Promise of one) and refuses anything else (§ 4.3), because the merge is by top-level key.
8. **The brief says "A name no adapter supplies fails as today",** and today's dev error tells the user to set the variable in the shell or load `.env` with `import 'dotenv/config'`. The names and the failure are unchanged; the advice text changes (§ 14, decision 13).
9. **S3's spec says "The CLI starts the deploy engine's process with the same environment, so both Loads read the same values."** With adapters, both processes read the same files and environment, not one shared object; a file changed between the two reads, or a non-deterministic adapter, gives the child different values. This spec records it as deferred (§ 9) rather than adding a check.
10. **`deploy-cli.md` says "Extension factories validate their own environment during config evaluation"** and credentials come from the shell. That stays true: the pools are for the app's values only (§ 14, decision 14). A user who puts `PRISMA_SERVICE_TOKEN` in `.env.production` and lists `dotenv()` will find it is not read; the guide says so (§ 9).
