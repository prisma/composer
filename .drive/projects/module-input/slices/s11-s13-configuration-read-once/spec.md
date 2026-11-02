# S11 to S13 — Configuration is read once, and no known secret is printed

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Design: [design.md](../../design.md), which is authoritative; these slices build section 8 ("The two adapters that ship", "Which commands run which adapters", "The deploy's two processes", "`prisma dev`'s two processes"), section 9, the section 10 items "The 'pool' names in code" and "The second process's own run of the config adapters", and the section 12 changes to the decisions on secrets, env-sourced params, the `composer` config section, dev secrets and errors, with the glossary. Decisions: [ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md), [ADR-0049](../../../../../docs/design/90-decisions/ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md), [ADR-0058](../../../../../docs/design/90-decisions/ADR-0058-prisma-dev-reads-secrets-from-the-environment-and-never-invents-them.md), [ADR-0029](../../../../../docs/design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md), [ADR-0032](../../../../../docs/design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md) and [ADR-0044](../../../../../docs/design/90-decisions/ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md).

The three slices ship as one pull request. It is built on `claude/module-input-s11-s13`, stacked on prisma/composer#412 (S9 and S10). This spec is grounded in that branch at `78166d80`, which holds S9 and S10; § 19 says what S10 changed.

Release order: prisma/prisma-cli#383 merges first and publishes `@prisma/cli-engine` 0.10.0, which adds the output transform this PR uses (§ 9.5); this PR merges after that.

This spec leaves nothing to the implementer's judgement. Every file, type, signature, error message, document edit, test and commit is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 20 lists the decisions this spec takes, and § 21 what it found that the design gets wrong or does not say.

Read for this spec: `CLAUDE.md`; `docs/design/01-principles/`; `design.md` in full; `plan.md`; `spec.md`; the S4, S8 and S9 slice specs; ADR-0029, ADR-0032, ADR-0044, ADR-0049, ADR-0058, ADR-0061 and ADR-0062; the glossary entries Input, Value, Config pool, Secrets pool and Config adapter; `config-params.md`, `deploy-cli.md`, `local-dev.md`; the code each section names; `@prisma/cli-engine`'s `ctx.spawn` types and implementation, as prisma/prisma-cli#383 changes them for 0.10.0; `dotenv-flow` 4.1.0's `lib/dotenv-flow.js`; Alchemy 2.0.0-beta.83's `src/Util/interactive.ts` and `src/Cli/CliKit/layer.ts`.

## 1. At a glance

```ts
// prisma.config.ts
composer({ extensions: [prismaCloud(), nodeBuild()], state: prismaState(),
  config: [dotenv(), environmentVariables()], secrets: [dotenv(), environmentVariables()] })
```

```sh
$ prisma deploy --environment staging
```

1. The first process runs the `secrets` adapters, then the `config` adapters, once. `dotenv()` reads `.env`, `.env.local`, `.env.staging` and `.env.staging.local` through `dotenv-flow`, never `.env.defaults`.
2. It Loads the graph with the app configuration. The root's schema checks it. Load records what it read: each root field the body names, with its checked value, and the text of each name an `envParam()` reads.
3. It writes `.prisma-composer/configuration-<pid>-<uuid>.json`, mode 0600:

   ```json
   {"rootInput":[{"path":["EMAIL_FROM"],"value":"shop@example.com"},{"path":["EMAIL_DELIVERY_MODE"],"value":"none"}],"values":{}}
   ```

4. It starts the second process with `PRISMA_COMPOSER_CONFIGURATION_FILE` naming that file and `PRISMA_COMPOSER_NODE_ADDRESSES` listing the node addresses it checked. The second process runs no adapter. It Loads the graph with the file's values, without running the root's schema, and refuses to deploy a graph whose node addresses differ.
5. The CLI engine passes the second process's output through Composer's redactor before it prints it. The redactor replaces every secret value Composer knows, including one split across two chunks of output.
6. When the deploy ends, success or failure, the first process deletes the configuration file.

What the user sees when the second process prints a secret, and when an adapter's error holds one:

```text
api key is [redacted]
✘ [CONFIG.ADAPTER_FAILED] `composer.config[0]` failed to read the values for the environment "staging".
  Why: It threw: cannot use token [redacted]
```

`prisma dev` does the same, with `.prisma-composer/dev/<environment>/configuration.json`, and also hands its second process the secrets its local services need, in `PRISMA_COMPOSER_APP_SECRETS`, never in a file.

## 2. The model

- **The app configuration** is what the `config` adapters return, merged. **The app secrets** is what the `secrets` adapters return, merged. These names replace "config pool" and "secrets pool" everywhere: in types, functions, options, messages, docs and tests (§ 4).
- **Only the first process runs adapters.** `deploy` and `dev` run both lists; `destroy` runs only `config`. The order is now secrets first, then configuration, so a failing config adapter's message is redacted with every value a written `secrets` list returned (§ 7.2).
- **Load records what it read** from the app configuration, as `graph.checkedConfiguration` (§ 5). That record is exactly what the configuration file holds. It holds no secrets: a name may not be read both by `envParam()` and by `envSecret()` (§ 5.5).
- **The second process Loads with `checkedConfiguration`** instead of `configuration`. Load then takes each root field from the record without running the root's schema, and reads each configuration key from the record's text. A root field the record lacks is an error: the two processes built different graphs (§ 5.4).
- **The second process checks the node addresses.** `lower()` takes `checkedNodeAddresses` and refuses a graph whose addresses differ (§ 6.2).
- **Core knows each secret's name.** `secretSource()` takes `secretsKey`, the app secrets key that holds the secret's value; `envSecret('NAME')` passes `NAME`. Core's `secretsKeys(graph)` lists them. The CLI uses it to know what to redact and, under `prisma dev`, which secrets to hand the second process (§ 6.1).
- **Redaction** (§ 9). A `KnownSecrets` object per command collects every secret value the command reads: under every name an `envSecret()` in the graph names, the value in the app configuration and in the app secrets, at any length; and with a written `secrets` list, every value it returns, at any length. Every error an operation returns, every event `prisma dev` emits, the run report, the deploy reporter's message, the deployment summary and the second process's output pass through it. Composer also keeps the redaction S4 shipped: each app configuration value of eight characters or more under a name that looks like a credential, and the shapes `redactSecrets` finds. That is existing behaviour, kept for now; it is not part of this design.
- **The second process's output passes through a stream redactor.** For the CLI, the engine's `ctx.spawn` takes a per-stream output transform (prisma/prisma-cli#383, `@prisma/cli-engine` 0.10.0). Composer hands it a transform that redacts, and the engine prints the result where it would have printed the output, in every output format (§ 9.5). For programmatic hosts, `spawnAlchemy` pipes the output in-process through the same redactor (§ 9.4).
- **`environmentVariables()` no longer reads `PRISMA_COMPOSER_PARENT_VALUES`.** That variable existed so the child's second run of the adapters returned the parent's values. No child runs an adapter now, so it goes (§ 7.1).

## 3. S11: `dotenv()` delegates to `dotenv-flow`

### 3.1 Dependencies

- `packages/0-framework/3-tooling/cli/package.json` and `packages/9-public/composer/package.json`: the entry `"dotenv": "^17.4.2"` is replaced by `"dotenv-flow": "4.1.0"`, keeping alphabetical order in `dependencies`. Run `pnpm install` so the lockfile records it. No other package depends on `dotenv` for Composer's use; `examples/storefront-auth` keeps its own `dotenv` dependency.
- `dotenv-flow` 4.1.0 depends on `dotenv` `^16.0.0`. It is CommonJS with types in `lib/dotenv-flow.d.ts`; `import { listFiles, parse } from 'dotenv-flow'` works under Node and Bun (§ 18).

### 3.2 `packages/0-framework/3-tooling/cli/src/config-adapters.ts`

The file becomes, in full:

```ts
import * as path from 'node:path';
import type { ConfigAdapter, ConfigValues } from '@internal/core/config';
import { listFiles, parse } from 'dotenv-flow';

/** The prefix of the variables Composer sets for its own second process. */
const COMPOSER_PREFIX = 'PRISMA_COMPOSER_';

/**
 * Reads the process environment when called: every variable whose value is a string,
 * except Composer's own `PRISMA_COMPOSER_` variables. The default for both `config` and `secrets`.
 */
export function environmentVariables(): ConfigAdapter {
  return () => {
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value === 'string' && !name.startsWith(COMPOSER_PREFIX)) values[name] = value;
    }
    return values;
  };
}

/** `dotenv-flow`'s own default pattern. Given it, `listFiles` also lists `.env.defaults`, first. */
const DOTENV_FLOW_PATTERN = '.env[.node_env][.local]';
const ENV_DEFAULTS_FILE = '.env.defaults';

function envFiles(configDirectory: string, environment: string): string[] {
  const files = listFiles({
    node_env: encodeURIComponent(environment),
    path: configDirectory,
    pattern: DOTENV_FLOW_PATTERN,
  });
  return files[0] === path.resolve(configDirectory, ENV_DEFAULTS_FILE) ? files.slice(1) : files;
}

function readEnvFile(file: string): ConfigValues {
  try {
    return parse(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`dotenv() could not read ${file}: ${message}`, { cause: error });
  }
}

/**
 * Reads `.env`, `.env.local`, `.env.<environment>` and `.env.<environment>.local` from the
 * directory of prisma.config.ts, in `dotenv-flow`'s order, a later file winning. It skips
 * `.env.local` for the environment `test`, as `dotenv-flow` does, and never reads
 * `.env.defaults`. It does not read or change the process environment.
 */
export function dotenv(): ConfigAdapter {
  return ({ environment, configDirectory }) => {
    const values: Record<string, string> = {};
    for (const file of envFiles(configDirectory, environment)) {
      Object.assign(values, readEnvFile(file));
    }
    return values;
  };
}
```

`childEnvironment`, `PARENT_VALUES_ENV`, `parentValues`, `readEnvFile`'s `ENOENT` handling and `isMissingFile` are removed: `listFiles` lists only files that exist. `dotenv-flow`'s `parse(list)` merges with `Object.assign` in list order; parsing one file at a time and merging the same way gives the same result and lets the error name the file (§ 20, decision 3).

### 3.3 `packages/0-framework/3-tooling/cli/src/exports/config.ts`

Its doc comment becomes `/** The config adapters (ADR-0062), imported by prisma.config.ts, so this entry imports nothing heavier than node:path and dotenv-flow. */`.

### 3.4 `run-alchemy.ts`

The import of `childEnvironment` goes. In `alchemyInvocation`, `env: childEnvironment({ ...input.containerEnv, ...input.preflightEnv, ...input.env })` becomes `env: { ...input.containerEnv, ...input.preflightEnv, ...input.env }` (§ 9.4 adds `redactedValues`).

## 4. The rename: "pool" becomes "the app configuration" and "the app secrets"

### 4.1 Identifiers

| Before | After | Where |
| --- | --- | --- |
| `ConfigPool` | `AppConfiguration` | core `control/app-config.ts`, every importer |
| `SecretsPool` | `AppSecrets` | the same |
| `ConfigPools` | removed; each use becomes two fields, `configuration: AppConfiguration` and `secrets: AppSecrets` | `PreflightInput`, `LocalTargetProvidersInput`, `LocalTargetAttachment.serve`'s input, `PipelineResult` |
| `PreflightInput.pools` | `PreflightInput.configuration` and `PreflightInput.secrets` | core, target preflight, CLI operations |
| `LocalTargetProvidersInput.pools` | `.configuration` and `.secrets` | core, local target |
| `serve`'s input `pools` | `configuration` and `secrets` | core, `local-target/attach.ts`, `execute-dev.ts` |
| `localTargetProviders(resolved, containers, devDir, pools)` | `localTargetProviders(resolved, containers, devDir, configuration, secrets)` | core `control/local-target.ts`, the dev stack file |
| `materializeEnv(devDir, address, port, pools)` | `materializeEnv(devDir, address, port, configuration, secrets)` | `local-target/src/compute.ts`, `attach.ts` |
| `LoadOptions.configPool` | `LoadOptions.configuration` | core `graph-types.ts`, every caller |
| `LowerOptions.configPool` | removed; replaced by `checkedConfiguration` and `checkedNodeAddresses` (§ 6.2) | core `control/deploy.ts` |
| `ParamSourceOptions.poolKey` | `ParamSourceOptions.configurationKey` | core `node.ts`, target `param.ts` |
| the `'source'` origin's `poolKey` | `configurationKey` | core `value.ts`, `node.ts`, `resolve-values.ts` |
| `ProvisionedModuleInput.fromConfigPool` | `ProvisionedModuleInput.isRoot` | core `resolve-values.ts`, `load-module.ts` |
| `resolveValues`'s input `configPool` | `configuration` | core `resolve-values.ts` |
| `config-pools.ts`, `readConfigPool`, `readSecretsPool`, `PoolReadInput`, `readPool`, `PoolList` | `app-configuration.ts`, `readAppConfiguration`, `readAppSecrets`, `AdapterReadInput`, `readAdapters`, `AdapterList` | CLI |
| `PipelineResult.pools` | `PipelineResult.configuration` and `PipelineResult.secrets` | CLI `pipeline.ts`, operations |
| `samePools` | `sameValues` | CLI `execute-dev.ts` |
| `poolSecrets` | removed (§ 9.2) | CLI `deployment-summary.ts` |
| `src/exports/pools.ts` (`@internal/cli/pools`) and `packages/9-public/composer/src/exports/internal-pools.ts` (`@prisma/composer/internal/pools`) | removed; § 8.6 adds `internal/configuration-file` | CLI, public composer |
| `pool-text.ts`, `poolText(pool, name, notText)` | `configuration-text.ts`, `configurationText(configuration, name, notText)` | Prisma Cloud target |
| `poolValue` (preflight's map) | `valueOf` | target `preflight.ts` |
| the test fixture folder `pipeline-config-pool` | `pipeline-app-configuration` | CLI tests |
| `config-pools.test.ts` | `app-configuration.test.ts` | CLI tests |

### 4.2 Words, in code comments, messages, test titles and docs

| Before | After |
| --- | --- |
| `the config pool` | `the app configuration` |
| `config pool` (any other use, such as "a config pool value") | `app configuration` |
| `the secrets pool` | `the app secrets` |
| `secrets pool` (any other use) | `app secrets` |
| `the pools` / `both pools` / `the two pools` | `the app configuration and the app secrets` |
| `pool key` | `configuration key` |
| `a pool-key source` | `a source with a configuration key` |

### 4.3 How the implementer checks it

After the change, this finds nothing in `packages/`, `examples/`, `test/`, `skills/`, `docs/guides/`, `docs/design/03-domain-model/` and `docs/design/10-domains/`, outside `node_modules` and `dist`:

```sh
git grep -n -i -E 'config ?pool|secrets ?pool|configPool|ConfigPools?|SecretsPool|poolKey|pool-key|pool key|readConfigPool|readSecretsPool|internal/pools|internal-pools|poolText|pool-text|poolSecrets|samePools|PoolReadInput|\bpools\b' -- packages examples test skills docs/guides docs/design/03-domain-model docs/design/10-domains
```

`docs/design/90-decisions/` is covered by § 14, and keeps the word only where a rewritten record says what it replaced. `.drive/` keeps it.

## 5. Core: Load records what it read, and takes it back

### 5.1 `packages/0-framework/1-core/core/src/graph-types.ts`

After `NodeId`:

```ts
/** One field of the root's input that its body names, with the real value the root's schema produced there. */
export interface CheckedRootField {
  /** The key path inside the root's input, such as `['smtp', 'host']`. */
  readonly path: readonly string[];
  /** The real value; absent when it is `undefined`. */
  readonly value?: unknown;
}

/**
 * What a Load read from the app configuration, once the root's schema checked it (ADR-0062).
 * The deploy's and `prisma dev`'s first process writes it to the configuration file, and
 * their second process Loads with it in place of the app configuration.
 */
export interface CheckedConfiguration {
  /** Each field of the root's input that its body names. Empty when the root declares no input. */
  readonly rootInput: readonly CheckedRootField[];
  /** The text the app configuration holds for each configuration key a source reads, such as `envParam('NAME')`'s `NAME`. A key the app configuration does not hold, or holds as `''`, is absent. */
  readonly values: Readonly<Record<string, string>>;
}
```

`LoadOptions.configPool` and its doc comment become:

```ts
  /** The app configuration (ADR-0062): what the `config` adapters return. It is the root's input, which the root's schema checks, and what a source with a configuration key, such as `envParam('NAME')`, reads. The deploy's and dev's first process pass it. */
  readonly configuration?: Readonly<Record<string, unknown>>;
  /** What the first process's Load read, from the configuration file. The deploy's and dev's second process pass it in place of `configuration`: Load takes each root field from it without running the root's schema. */
  readonly checkedConfiguration?: CheckedConfiguration;
```

`Graph` gains, after `secretSources`:

```ts
  /** What this Load read from the app configuration (ADR-0062). Empty when Load was given none. */
  readonly checkedConfiguration: CheckedConfiguration;
```

`load-service.ts`'s graph gains `checkedConfiguration: { rootInput: [], values: {} },` after `secretSources: [],`.

### 5.2 `packages/0-framework/1-core/core/src/load-module.ts`, `loadModule`

The root's input block becomes:

```ts
  const moduleInputs: ProvisionedModuleInput[] = [];
  if (opts?.configuration !== undefined && opts.checkedConfiguration !== undefined) {
    throw new LoadError(
      'Load takes configuration, in the first process, or checkedConfiguration, in the second, not both.',
    );
  }
  if (root.inputSchema !== undefined) {
    if (opts?.checkedConfiguration !== undefined) {
      moduleInputs.push({
        moduleAddress: rootId,
        schema: root.inputSchema,
        binding: undefined,
        isRoot: true,
        checked: opts.checkedConfiguration.rootInput,
      });
    } else if (opts?.configuration !== undefined) {
      moduleInputs.push({
        moduleAddress: rootId,
        schema: root.inputSchema,
        binding: opts.configuration,
        isRoot: true,
      });
    } else {
      throw new LoadError(
        `Module "${root.name}" declares input and is being deployed as the root, but Load was given ` +
          'no app configuration to fill it from. Pass { configuration } to Load; prisma deploy and prisma dev ' +
          'pass the values the `config` adapters return.',
      );
    }
  }
```

The module-child push in `flatten` sets `isRoot: false` in place of `fromConfigPool: false`. The `resolveValues` call passes `configuration: opts?.configuration` and `checkedConfiguration: opts?.checkedConfiguration` in place of `configPool`. The returned graph gains `checkedConfiguration: resolved.checkedConfiguration,` after `secretSources`.

### 5.3 `packages/0-framework/1-core/core/src/resolve-values.ts`

1. Imports: `type CheckedConfiguration` and `type CheckedRootField` join the `./graph-types.ts` import.
2. `ProvisionedModuleInput`: `fromConfigPool` and its doc comment become:

   ```ts
     /** True for the root, whose binding is the app configuration. */
     readonly isRoot: boolean;
     /** For the root in the second process: its fields as the first process checked them. The root's schema does not run. */
     readonly checked?: readonly CheckedRootField[];
   ```

3. New module-private functions, after `describeNotPlain`:

   ```ts
   /** How `value` would not survive `JSON.stringify` and `JSON.parse` unchanged, or `undefined` when it would. A key whose value is `undefined` is dropped, which a body cannot tell from absent. */
   function jsonInexactKind(value: unknown): string | undefined {
     if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
     if (typeof value === 'number') return Number.isFinite(value) ? undefined : 'a non-finite number';
     if (Array.isArray(value)) {
       for (const member of value) {
         if (member === undefined) return 'an array with a missing member';
         const kind = jsonInexactKind(member);
         if (kind !== undefined) return kind;
       }
       return undefined;
     }
     if (isPlainObject(value)) {
       for (const member of Object.values(value)) {
         if (member === undefined) continue;
         const kind = jsonInexactKind(member);
         if (kind !== undefined) return kind;
       }
       return undefined;
     }
     return describeNotPlain(value) ?? describeKind(value);
   }

   const SAME_GRAPH_ADVICE =
     'A module body must build the same graph every time; one that reads process.env, a file or the clock can build a different one.';
   ```

4. `validateModuleInput`: `entry.fromConfigPool` becomes `entry.isRoot`.
5. `resolveValues`'s input: `readonly configPool: Readonly<Record<string, unknown>> | undefined;` becomes:

   ```ts
     readonly configuration: Readonly<Record<string, unknown>> | undefined;
     readonly checkedConfiguration: CheckedConfiguration | undefined;
   ```

   Its return type gains `readonly checkedConfiguration: CheckedConfiguration;`.
6. At the start of `resolveValues`'s body, `const { environment, configPool } = input;` becomes:

   ```ts
     const { environment } = input;
     const rootFields = new Map<string, CheckedRootField>();
     const keysRead = new Map<string, { readonly label: string; readonly text: string | undefined }>();
     /** The text the app configuration holds for `key`, recorded; `undefined` when it holds none or `''`. */
     const configurationText = (key: string, label: string, site: ValueBindingSite): string | undefined => {
       let raw: unknown;
       if (input.checkedConfiguration !== undefined) raw = input.checkedConfiguration.values[key];
       else if (input.configuration !== undefined) raw = input.configuration[key];
       else {
         throw new LoadError(
           `${describeSite(site)} depends on ${label}, but Load was given no app configuration to read "${key}" from. Pass { configuration } to Load; the deploy and dev commands pass the values the \`config\` adapters return.`,
         );
       }
       if (raw !== undefined && raw !== '' && typeof raw !== 'string') {
         throw new LoadError(
           `${describeSite(site)} depends on ${label}, which reads "${key}" from the values the \`config\` adapters return, but they return ${describeKind(raw)} for it, not text. ${label} reads text; to pass other data, declare it in the root module's input.`,
         );
       }
       const text = raw === undefined || raw === '' ? undefined : raw;
       keysRead.set(key, { label, text });
       return text;
     };
   ```

7. In `resolveOne`, the `'source'` case's `else if (configPool === undefined) { … } else { … }` chain becomes:

   ```ts
           if (origin.configurationKey === undefined) {
             result = origin.source;
           } else {
             result = configurationText(origin.configurationKey, origin.label, site);
           }
   ```

   In the `'computed'` case, `source.poolKey` becomes `source.configurationKey`, twice.
8. In the `'input'` case, `entry.fromConfigPool` becomes `entry.isRoot`, and `result = readPath(validatedInputOf(entry), origin);` becomes:

   ```ts
           if (entry.checked !== undefined) {
             const field = entry.checked.find(
               (candidate) => candidate.path.join('\0') === origin.path.join('\0'),
             );
             if (field === undefined) {
               throw new LoadError(
                 `${inputFieldLabel(origin)} of root module "${origin.module}" is not in the configuration file. The first process's root body did not pass it on, so the deploy's two processes built different graphs. ${SAME_GRAPH_ADVICE}`,
               );
             }
             result = field.value;
           } else {
             result = readPath(validatedInputOf(entry), origin);
             if (entry.isRoot) {
               rootFields.set(
                 origin.path.join('\0'),
                 result === undefined ? { path: origin.path } : { path: origin.path, value: result },
               );
             }
           }
   ```

9. `validatedInputOf`: its first line gains, before the cache check, `if (entry.checked !== undefined) return undefined;`.
10. New closure inside `resolveValues`, after `validatedInputOf`:

    ```ts
      const checkedConfigurationOf = (
        inputBindings: readonly InputBindingUse[],
        params: readonly ParamBinding[],
        secretSources: readonly SecretSourceUse[],
      ): CheckedConfiguration => {
        if (input.configuration !== undefined || input.checkedConfiguration !== undefined) {
          const kept: { readonly binding: unknown; readonly site: ValueBindingSite }[] = [
            ...inputBindings.map(({ serviceAddress, binding }) => ({
              binding,
              site: { address: serviceAddress, kind: 'serviceInput' as const, path: '' },
            })),
            ...params.map(({ serviceAddress, slot, binding }) => ({
              binding,
              site: { address: serviceAddress, kind: 'param' as const, path: slot },
            })),
          ];
          for (const { binding, site } of kept) {
            for (const pointer of pointersIn(binding)) {
              if (!isParamSource(pointer)) continue;
              const origin = sourceOriginOf(pointer);
              if (origin?.configurationKey !== undefined) {
                configurationText(origin.configurationKey, origin.label, site);
              }
            }
          }
        }
        for (const use of secretSources) {
          const origin = sourceOriginOf(use.source);
          const key = origin?.secretsKey;
          const read = key === undefined ? undefined : keysRead.get(key);
          if (key !== undefined && read !== undefined) {
            throw new LoadError(
              `${read.label} reads "${key}" from the app configuration, and ${origin?.label} names "${key}" as a secret. A name is a plain value or a secret, not both: Composer hands the deploy's second process every plain value it reads, in a file, and never writes a secret to a file. Give the plain value and the secret different names.`,
            );
          }
        }
        for (const field of rootFields.values()) {
          const kind = 'value' in field ? jsonInexactKind(field.value) : undefined;
          if (kind !== undefined) {
            throw new LoadError(
              `${inputFieldLabel({ kind: 'input', module: rootModuleAddress(), path: field.path })} of root module "${rootModuleAddress()}" holds ${kind}, which JSON cannot hold exactly. The deploy hands the root's checked input to its second process in a JSON file, so a field the root's body passes on must hold text, a finite number, a boolean, null, or arrays and plain objects of these.`,
            );
          }
        }
        const values: Record<string, string> = {};
        for (const [key, { text }] of keysRead) if (text !== undefined) values[key] = text;
        return { rootInput: [...rootFields.values()], values };
      };
    ```

    `rootModuleAddress()` is a closure, declared before it: `const rootModuleAddress = (): string => input.moduleInputs.find((entry) => entry.isRoot)?.moduleAddress ?? '';`. `inputFieldLabel` takes an `InputOrigin`, so the object literal above is that origin.
11. Both returns of `resolveValues` gain `checkedConfiguration`. The early return becomes:

    ```ts
      if (found.length === 0) {
        for (const [address, props] of authoredProps) refusePointersInProps(address, props);
        const secretSources = secretSourcesReceivedBy(input.inputBindings, input.params);
        return {
          inputBindings: input.inputBindings,
          params: input.params,
          resourceProps: authoredProps,
          secretSources,
          checkedConfiguration: checkedConfigurationOf(input.inputBindings, input.params, secretSources),
        };
      }
    ```

    and the last return becomes:

    ```ts
      const secretSources = secretSourcesReceivedBy(inputBindings, params);
      return {
        resourceProps,
        inputBindings,
        params,
        secretSources,
        checkedConfiguration: checkedConfigurationOf(inputBindings, params, secretSources),
      };
    ```

### 5.4 What Load does in each process

| | First process: `{ configuration }` | Second process: `{ checkedConfiguration }` |
| --- | --- | --- |
| The root's schema | runs over the whole app configuration | does not run |
| A root field the body names | read from the schema's output, recorded | taken from `checkedConfiguration.rootInput`; missing is a `LoadError` |
| A configuration key read in a module's input or a `resolve()` | read from `configuration`, recorded | read from `checkedConfiguration.values` |
| A configuration key in a service's input or a service param | read and recorded after resolution; non-text is a `LoadError` | read from `checkedConfiguration.values` |
| A key read as both a configuration key and a secrets key | `LoadError` | `LoadError` |
| A recorded root field JSON cannot hold | `LoadError` | cannot happen: the values came from JSON |

### 5.5 `node.ts` and `value.ts`

1. `value.ts`, the `'source'` origin: `poolKey` and its doc comment become:

   ```ts
         /** The app configuration key whose text at deploy is the real value, as for `envParam()`. `undefined` for a value known only at boot, whose real value is `source`, a pointer. */
         readonly configurationKey: string | undefined;
         /** The app secrets key that holds a secret source's value, as for `envSecret()`. `undefined` for any other source. */
         readonly secretsKey: string | undefined;
   ```

2. `node.ts`, after `SourceOptions`:

   ```ts
   /** What a deploy target says about a secret source it builds. */
   export interface SecretSourceOptions extends SourceOptions {
     /** The app secrets key that holds this secret's value, as `envSecret('NAME')`'s `NAME`. Composer redacts the value under it wherever it prints, and `prisma dev` hands it to its second process. */
     readonly secretsKey?: string;
   }
   ```

   `ParamSourceOptions.poolKey` and its doc comment become `/** The app configuration key whose text at deploy is the source's real value, as for \`envParam()\`. Without one the source is known only at boot, and its real value is the source itself, a pointer. */ readonly configurationKey?: string;`.
3. `secretSource(payload, options?: SourceOptions)` becomes `secretSource(payload, options?: SecretSourceOptions)`. Its body gains, after the `label` line:

   ```ts
     const secretsKey = options?.secretsKey;
     if (secretsKey !== undefined && (typeof secretsKey !== 'string' || secretsKey.length === 0)) {
       throw new Error('secretSource() secretsKey must be a non-empty string.');
     }
   ```

   and its origin literal becomes `{ kind: 'source', label, configurationKey: undefined, secretsKey }`.
4. `paramSource`: `poolKey` becomes `configurationKey` throughout; the two messages become `'paramSource() configurationKey must be a non-empty string.'` and `'paramSource() takes configurationKey, for a value known at deploy, or redacted, for a secret known only at boot, not both.'`; its origin literal becomes `{ kind: 'source', label, configurationKey, secretsKey: undefined }`.
5. `sourceMisuse`: `origin.poolKey === undefined` becomes `origin.configurationKey === undefined`.
6. `ParamSource`'s doc comment: `known at deploy when it names a config pool key (\`envParam\`)` becomes `known at deploy when it names an app configuration key (\`envParam\`)`.
7. `exports/index.ts`: the `../node.ts` type export gains `SecretSourceOptions`; the `../graph.ts` type export gains `CheckedConfiguration` and `CheckedRootField`.

## 6. Core: secret names, node addresses and the second process's check

### 6.1 `packages/0-framework/1-core/core/src/graph.ts`

New exports, after `Load`:

```ts
/** The app secrets key of every secret source the graph names, once each, in the order Load met them. A source built without a `secretsKey` is left out. */
export function secretsKeys(graph: Graph): readonly string[] {
  const keys = new Set<string>();
  for (const { source } of graph.secretSources) {
    const key = sourceOriginOf(source)?.secretsKey;
    if (key !== undefined) keys.add(key);
  }
  return [...keys];
}

/** The address of every node in the graph, sorted. Two Loads of the same graph give the same list. */
export function nodeAddresses(graph: Graph): readonly string[] {
  return graph.nodes.map(({ id }) => id).sort();
}
```

`graph.ts` imports `sourceOriginOf` from `./node.ts`. `exports/index.ts` exports `nodeAddresses` and `secretsKeys` beside `Load`.

### 6.2 `packages/0-framework/1-core/core/src/control/deploy.ts`

1. `LowerOptions.configPool` and its doc comment are replaced by:

   ```ts
     /** What the first process's Load read from the app configuration (ADR-0062), from the configuration file. Load takes the root's input and every configuration key's text from it, and the Prisma Cloud serializer reads a service's `envParam()` leaves from its `values`. The generated stack files pass it. */
     readonly checkedConfiguration?: CheckedConfiguration;
     /** The node addresses the first process checked. When given, lowering refuses a graph whose addresses differ. The generated stack files pass them. */
     readonly checkedNodeAddresses?: readonly string[];
   ```

2. In `lowering`, the `Load` call's `...(opts.configPool !== undefined ? { configPool: opts.configPool } : {})` becomes `...(opts.checkedConfiguration !== undefined ? { checkedConfiguration: opts.checkedConfiguration } : {})`, and directly after the `Load` call:

   ```ts
       if (opts.checkedNodeAddresses !== undefined) {
         assertSameNodeAddresses(nodeAddresses(graph), opts.checkedNodeAddresses);
       }
   ```

3. New module-private function, after `LowerError`:

   ```ts
   function assertSameNodeAddresses(built: readonly string[], checked: readonly string[]): void {
     const onlyBuilt = built.filter((address) => !checked.includes(address));
     const onlyChecked = checked.filter((address) => !built.includes(address));
     if (onlyBuilt.length === 0 && onlyChecked.length === 0) return;
     const list = (addresses: readonly string[]) =>
       addresses.length === 0 ? 'none' : addresses.map((address) => `"${address}"`).join(', ');
     throw new LowerError(
       `The deploy's second process built a different graph from the one Composer checked in its first process. Only in the second process: ${list(onlyBuilt)}. Only in the first process: ${list(onlyChecked)}. A module body must build the same graph every time; one that reads process.env, a file or the clock can build a different one.`,
     );
   }
   ```

   `deploy.ts` imports `nodeAddresses` from `../graph.ts` and the type `CheckedConfiguration` from `../graph-types.ts`. Core's `process.env` count stays `control/deploy.ts`, 2 (`invariants.test.ts` is unchanged): the addresses reach `lower()` as an option.

### 6.3 `control/app-config.ts`

1. `ConfigPool`, `SecretsPool` and `ConfigPools` and their doc comments are replaced by:

   ```ts
   /** The app configuration (ADR-0062): what the `config` adapters return, merged by top-level key, a later adapter winning. It is the root's input, and what `envParam()` reads. */
   export type AppConfiguration = Readonly<Record<string, unknown>>;

   /** The app secrets (ADR-0062): what the `secrets` adapters return, merged the same way. Every value is text. Preflight fills a missing `envSecret()` platform variable from it, and `prisma dev` hands its second process the values the graph's `envSecret()`s name. Composer redacts its values wherever it prints. */
   export type AppSecrets = Readonly<Record<string, string>>;
   ```

2. `ConfigAdapter`'s doc comment becomes: `A function in the \`config\` or \`secrets\` list of the \`composer\` section (ADR-0062): it receives the environment and returns that environment's values. Only the command's first process calls it; the second process reads what the first checked from the configuration file.`
3. `PrismaAppConfig`'s doc comment's last sentence becomes `` `config` and `secrets` list the adapters the app configuration and the app secrets come from. ``; `config`'s member comment becomes `Where the app configuration comes from. …` and `secrets`' `Where the app secrets come from. …`, the rest unchanged.
4. `PreflightInput.pools` is replaced by:

   ```ts
     /** The app configuration the command read for this environment. Preflight fills a missing `envParam()` param's platform variable from it. */
     readonly configuration: AppConfiguration;
     /** The app secrets the command read for this environment. Preflight fills a missing `envSecret()` platform variable from it. */
     readonly secrets: AppSecrets;
   ```

5. `LocalTargetProvidersInput.pools` is replaced by the same two members, with the comments `The app configuration the second process read: the text of each configuration key the graph reads. A local deployment takes the values its param rows point at from it.` and `The app secrets the first process handed the second process. A local deployment takes the values its \`$secret\` pointers name from it.`
6. `serve`'s `pools` member is replaced by `configuration: AppConfiguration` and `secrets: AppSecrets`, commented `The app configuration the command read for this environment.` and `The app secrets the command read for this environment.`
7. `control/local-target.ts`: `localTargetProviders`'s fourth parameter becomes `configuration: AppConfiguration`, a fifth `secrets: AppSecrets` follows, and the call becomes `descriptor.providers({ container: containers.get(id), devDir, configuration, secrets })`.

## 7. CLI: reading the app configuration and the app secrets

### 7.1 `config-adapters.ts`

§ 3.2.

### 7.2 `app-configuration.ts` (renamed from `config-pools.ts`)

`git mv src/config-pools.ts src/app-configuration.ts`, then:

1. The type imports become `ConfigAdapter`, `AppConfiguration`, `AppSecrets`, `PrismaAppConfig` from `@internal/core/config`; it imports `type KnownSecrets` from `./redaction.ts`.
2. `PoolReadInput` becomes `AdapterReadInput`, doc comment `What the adapters are read for.`; `PoolList` becomes `AdapterList`; `isText(pool)` becomes `isText(values): values is AppSecrets`; `readPool` becomes `readAdapters`, with a fourth parameter `onValue?: (value: string) => void`. In its merge loop, after `pool[key] = value;` (the local is renamed `merged`), it calls `if (typeof value === 'string') onValue?.(value);`.
3. The two exports become:

   ```ts
   /** Calls the section's `config` adapters (default `[environmentVariables()]`) and merges what they return: the app configuration. */
   export function readAppConfiguration(
     section: PrismaAppConfig,
     input: AdapterReadInput,
   ): Promise<AppConfiguration> {
     return readAdapters('config', section.config ?? [environmentVariables()], input);
   }

   /**
    * Calls the section's `secrets` adapters (default `[environmentVariables()]`) and merges what they
    * return: the app secrets. Every value must be text. When the section writes its own list, each
    * value is added to `known` as soon as its adapter returns it.
    */
   export async function readAppSecrets(
     section: PrismaAppConfig,
     input: AdapterReadInput,
     known: KnownSecrets,
   ): Promise<AppSecrets> {
     const merged = await readAdapters(
       'secrets',
       section.secrets ?? [environmentVariables()],
       input,
       section.secrets === undefined ? undefined : (value) => known.add([value]),
     );
     if (!isText(merged)) throw new InternalError('readAdapters admitted a secret that is not text');
     return merged;
   }
   ```

   The error messages of § 4.3 of the S4 spec do not change.

### 7.3 `pipeline.ts`

1. Imports: `type ConfigPools` becomes `type AppConfiguration, type AppSecrets`; `readConfigPool, readSecretsPool` from `./config-pools.ts` become `readAppConfiguration, readAppSecrets` from `./app-configuration.ts`; new imports `secretsKeys` from `@internal/core` and `KnownSecrets, secretValuesIn` from `./redaction.ts`.
2. `PipelineDeps.readSecrets`'s comment becomes `Read the app secrets too: \`deploy\` and \`dev\` do; \`destroy\` does not, and its \`secrets\` is empty.` It gains:

   ```ts
     /** Collects every secret value the run reads, for redaction. A new one when not given. */
     readonly knownSecrets?: KnownSecrets | undefined;
   ```

3. `PipelineResult.pools` is replaced by:

   ```ts
     /** The app configuration read for this run. In memory only; the configuration file holds only what Load read from it. */
     readonly configuration: AppConfiguration;
     /** The app secrets read for this run. In memory only: never written to a file, an event, a result or a report. */
     readonly secrets: AppSecrets;
   ```

4. Step 3 of `runPipeline` becomes:

   ```ts
     // 3. Read the app secrets, then the app configuration. Secrets first, so a config adapter's
     // failure is redacted with every value a written `secrets` list returned.
     const known = deps.knownSecrets ?? new KnownSecrets();
     const adapterInput = { environment, configFile: configSource.file };
     const secrets: AppSecrets =
       deps.readSecrets === true ? await readAppSecrets(config, adapterInput, known) : NO_SECRETS;
     const configuration = await readAppConfiguration(config, adapterInput);
     known.add(secretValuesIn(configuration, secrets, []));
   ```

5. Step 4's `configPool: pools.config` becomes `configuration`. Directly after the `ROOT_NOT_MODULE` check:

   ```ts
     known.add(secretValuesIn(configuration, secrets, secretsKeys(graph)));
   ```

6. The return becomes `return { configSource, entryModule, graph, name, assembled, configuration, secrets };`.

## 8. CLI: the configuration file and the second process

### 8.1 New file `packages/0-framework/3-tooling/cli/src/configuration-file.ts`

It imports `node:fs` and the types `AppSecrets`, `CheckedConfiguration` and `CheckedRootField`, and no value from core or `@prisma/cli-engine`, because the generated stack files import it in the second process.

```ts
/** Names the configuration file the first process wrote for this run (ADR-0062). */
export const CONFIGURATION_FILE_ENV = 'PRISMA_COMPOSER_CONFIGURATION_FILE';
/** Lists, as JSON, the node addresses the first process checked. */
export const NODE_ADDRESSES_ENV = 'PRISMA_COMPOSER_NODE_ADDRESSES';
/** `prisma dev` only: the value of each app secret an `envSecret()` in the graph names, as a JSON object. */
export const APP_SECRETS_ENV = 'PRISMA_COMPOSER_APP_SECRETS';

/** Writes `checked` to `file` as JSON, readable only by its owner. A file already there is replaced. */
export function writeConfigurationFile(file: string, checked: CheckedConfiguration): void {
  fs.rmSync(file, { force: true });
  fs.writeFileSync(file, JSON.stringify(checked), { mode: 0o600, flag: 'wx' });
}

/** Deletes `file`. Never throws: the run's own result is the one to report. */
export function removeConfigurationFile(file: string): void {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // The run already ended; a file left behind is a smaller problem than a masked result.
  }
}

/** What the first process adds to the second process's environment. `secrets` is given by `prisma dev` only. */
export function secondProcessEnvironment(input: {
  readonly configurationFile: string;
  readonly nodeAddresses: readonly string[];
  readonly secrets?: AppSecrets;
}): Record<string, string> {
  return {
    [CONFIGURATION_FILE_ENV]: input.configurationFile,
    [NODE_ADDRESSES_ENV]: JSON.stringify(input.nodeAddresses),
    ...(input.secrets === undefined ? {} : { [APP_SECRETS_ENV]: JSON.stringify(input.secrets) }),
  };
}

/** Second process: what the first process checked, from the configuration file and the node addresses it names. */
export function readCheckedConfiguration(env: Readonly<Record<string, string | undefined>>): {
  readonly configuration: CheckedConfiguration;
  readonly nodeAddresses: readonly string[];
};

/** Second process, under `prisma dev`: the app secrets the first process handed it. */
export function appSecretsFromEnvironment(env: Readonly<Record<string, string | undefined>>): AppSecrets;
```

`readCheckedConfiguration`:

1. `const file = env[CONFIGURATION_FILE_ENV]`; when it is `undefined` or `''`, throws `new Error(missingVariable(CONFIGURATION_FILE_ENV, 'names the configuration file it wrote there'))`.
2. Reads the file with `fs.readFileSync(file, 'utf8')`. A read error throws `new Error(\`Could not read the configuration file ${file}: ${message}. Composer deletes it when the run ends, so a stack file run by hand after that cannot read it; run the command again.\`, { cause })`.
3. Parses it with `JSON.parse`. A parse error, or a result that is not an object whose `rootInput` is an array of objects each with a `path` that is an array of strings, and whose `values` is an object of strings, throws `new Error(\`The configuration file ${file} is not one Composer wrote: <what>.\`)`, where `<what>` is `it is not JSON`, `rootInput is not a list of fields`, or `values is not an object of text`.
4. `const addresses = env[NODE_ADDRESSES_ENV]`; when it is `undefined` or `''`, throws `new Error(missingVariable(NODE_ADDRESSES_ENV, 'lists the node addresses it checked there'))`. When it does not parse to an array of strings, throws `new Error(\`${NODE_ADDRESSES_ENV} is not a JSON list of node addresses.\`)`.
5. Returns `{ configuration: { rootInput, values }, nodeAddresses }`, built from the parsed data without a cast: module-private type guards `isRecord(value): value is Record<string, unknown>` and `isTextList(value): value is string[]` check each part, each field is rebuilt as `{ path }` or `{ path, value }` (a field without a `value` key stays without one), and `values` is rebuilt entry by entry, refusing an entry that is not text.

`appSecretsFromEnvironment`: `env[APP_SECRETS_ENV]` undefined or `''` throws `new Error(missingVariable(APP_SECRETS_ENV, 'hands the app secrets the local services need there'))`; a value that does not parse to an object of strings throws `new Error(\`${APP_SECRETS_ENV} is not a JSON object of text.\`)`; otherwise returns a frozen object with no prototype holding the parsed entries.

`missingVariable(name, what)` is module-private and returns `` `${name} is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which ${what}.` ``.

### 8.2 The generated deploy stack file, `generate-stack.ts`

1. `renderOptions`: `lines.push('  configPool,');` becomes:

   ```ts
     lines.push('  checkedConfiguration: checked.configuration,');
     lines.push('  checkedNodeAddresses: checked.nodeAddresses,');
   ```

2. In the template, the header line `// It reads the config pool again here, from the same adapters, so an adapter must return the same values for the same environment every time.` becomes `// It runs no config adapter: it reads the values the CLI checked from the configuration file named in PRISMA_COMPOSER_CONFIGURATION_FILE.` The header's `(the PRISMA_COMPOSER_CONTAINER_*/_PREFLIGHT_* vars —` becomes `(the PRISMA_COMPOSER_CONTAINER_*/_PREFLIGHT_* vars and the configuration file —`.
3. The import `import { readConfigPool } from '@prisma/composer/internal/pools';` becomes `import { readCheckedConfiguration } from '@prisma/composer/internal/configuration-file';`.
4. The lines from `const configPool = await readConfigPool(…);` to `report.captureEngineFailure?.();` become:

   ```ts
   // The app's own @prisma/composer may predate the failure recorder.
   report.captureEngineFailure?.();

   const checked = readCheckedConfiguration(process.env);
   ```

   The failure recorder starts first, so a missing configuration file is recorded as the cause.

### 8.3 The generated dev stack file, `dev/generate-dev-stack.ts`

1. `renderOptions`: `lines.push('  configPool: pools.config,');` becomes the same two lines as § 8.2, and `'  providers: localTargetProviders(resolved, containers, devDir, pools),'` becomes `'  providers: localTargetProviders(resolved, containers, devDir, checked.configuration.values, secrets),'`.
2. In `imports`, `"import { readConfigPool, readSecretsPool } from '@prisma/composer/internal/pools';"` becomes `"import { appSecretsFromEnvironment, readCheckedConfiguration } from '@prisma/composer/internal/configuration-file';"`.
3. The header line `// It reads the config and secrets pools again here, …` becomes `// It runs no config or secrets adapter: it reads the values the CLI checked from the configuration file named in PRISMA_COMPOSER_CONFIGURATION_FILE, and the app secrets from PRISMA_COMPOSER_APP_SECRETS.`
4. The two lines `const poolInput = …;` and `const pools = …;` become:

   ```ts
   const checked = readCheckedConfiguration(process.env);
   const secrets = appSecretsFromEnvironment(process.env);
   ```

### 8.4 `operations/execute-deploy-destroy.ts`

1. Imports: `poolSecrets` goes from the `../deployment-summary.ts` import; new imports `nodeAddresses` from `@internal/core`, `removeConfigurationFile, secondProcessEnvironment, writeConfigurationFile` from `../configuration-file.ts` and `KnownSecrets, redactError, redactSummary` from `../redaction.ts`.
2. `StackPipelineOptions` gains `readonly knownSecrets: KnownSecrets;`. `executeDeploy` and `executeDestroy` pass `knownSecrets: new KnownSecrets()`.
3. `pipelineDeps` gains `knownSecrets: opts.knownSecrets`.
4. `extension.preflight({ …, pools: pipeline.pools, … })` becomes `configuration: pipeline.configuration, secrets: pipeline.secrets,`.
5. After `resultFilePath`:

   ```ts
     const configurationFilePath = path.join(
       cwd,
       '.prisma-composer',
       `configuration-${String(process.pid)}-${randomUUID()}.json`,
     );
   ```

6. Inside the try that writes the stack file, after `stackPath = writeStackFile({ … });`: `writeConfigurationFile(configurationFilePath, pipeline.graph.checkedConfiguration);`. A failure is `DEPLOY.STACK_WRITE_FAILED`, as for the stack file.
7. `alchemyInvocation`'s `env` becomes:

   ```ts
       env: {
         ...reporterChildEnv(reporters, opts.knownSecrets),
         ...secondProcessEnvironment({
           configurationFile: configurationFilePath,
           nodeAddresses: nodeAddresses(pipeline.graph),
         }),
         [DEPLOYMENT_RESULT_FILE_ENV]: resultFilePath,
       },
       redactedValues: opts.knownSecrets.values(),
   ```

8. `readEngineFailureCause(resultFilePath, poolSecrets(…))` becomes `readEngineFailureCause(resultFilePath, (text) => opts.knownSecrets.redact(text))`.
9. `return ok(readDeploymentSummary(resultFilePath));` becomes `return ok(redactSummary(readDeploymentSummary(resultFilePath), opts.knownSecrets));`.
10. The `finally`'s cleanup gains `removeConfigurationFile(configurationFilePath);` after the two `fs.rmSync` calls, outside their `try`.
11. `runStackPipeline`:
    - The `catch (error)` that records a defect: before `await finishReporters(…)`, `if (error instanceof Error) redactThrown(error, opts.knownSecrets);`, where `redactThrown` is a module-private function setting `error.message = known.redact(error.message)` and, when `error.stack` is a string, `error.stack = known.redact(error.stack)`. The defect's message reaches `finishReporters` already redacted.
    - Directly after `outcome = await runStackPipelineInner(…)` succeeds and before `if (!outcome.ok) opts.steps.failOpen();`: `if (!outcome.ok) outcome = notOk(redactError(outcome.failure, opts.knownSecrets));`. The run report, the reporters' `errorMessage` and the returned failure all read the redacted failure.
12. `beginReporters`, `attachReporters`, `finishReporters` and `reporterChildEnv` gain a last parameter `known: KnownSecrets`, and each `console.warn` passes `known.redact(detail)` in place of `detail`.

### 8.5 `operations/execute-dev.ts`

1. Imports: `type ConfigPools` goes; new imports `type PipelineResult` from `../pipeline.ts`, `nodeAddresses` and `secretsKeys` from `@internal/core`, `removeConfigurationFile, secondProcessEnvironment, writeConfigurationFile` from `../configuration-file.ts`, `KnownSecrets, redactDevEvent, redactError` from `../redaction.ts`, and `type AlchemyInvocation` from `../run-alchemy.ts`.
2. `executeDev`'s body moves into a module-private `executeDevInner(input, deps, cwd, known: KnownSecrets)`, unchanged except as below. `executeDev` becomes:

   ```ts
   export async function executeDev(
     input: DevInput,
     deps: OperationDeps,
     cwd: string,
   ): Promise<Result<DevSession, CliStructuredError>> {
     const known = new KnownSecrets();
     try {
       const result = await executeDevInner(input, deps, cwd, known);
       return result.ok ? result : notOk(redactError(result.failure, known));
     } catch (error) {
       if (error instanceof Error) {
         error.message = known.redact(error.message);
         if (error.stack !== undefined) error.stack = known.redact(error.stack);
       }
       throw error;
     }
   }
   ```

3. `emit` becomes `const emit = (event: DevEvent): void => { try { onEvent?.(redactDevEvent(event, known)); } catch { … } };`, the catch unchanged.
4. `samePools` becomes:

   ```ts
   function sameValues(started: PipelineResult, now: PipelineResult): boolean {
     return (
       isDeepStrictEqual(started.configuration, now.configuration) &&
       isDeepStrictEqual(started.secrets, now.secrets)
     );
   }
   ```

   and its call `samePools(pipeline.pools, rePipeline.pools)` becomes `sameValues(pipeline, rePipeline)`.
5. `pipelineDeps` and `watchDeps` gain `knownSecrets: known`.
6. `dev.preflight({ …, pools: pipeline.pools, … })` becomes `configuration: pipeline.configuration, secrets: pipeline.secrets,`; `serve({ address, node, server, pools: pipeline.pools })` becomes `serve({ address, node, server, configuration: pipeline.configuration, secrets: pipeline.secrets })`.
7. The constant `invocation` goes. In its place:

   ```ts
     const configurationFilePath = path.join(devDir, 'configuration.json');
     const invocationFor = (p: PipelineResult): AlchemyInvocation => {
       const secrets: Record<string, string> = {};
       for (const key of secretsKeys(p.graph)) {
         const value = p.secrets[key];
         if (value !== undefined && value !== '') secrets[key] = value;
       }
       return alchemyInvocation({
         command: 'deploy',
         stackFileRelativePath: devStackRelativePath(environment),
         cwd,
         stage: environment,
         containerEnv: containerEnv(containers),
         preflightEnv: preflightTransportEnv,
         env: secondProcessEnvironment({
           configurationFile: configurationFilePath,
           nodeAddresses: nodeAddresses(p.graph),
           secrets,
         }),
         redactedValues: known.values(),
       });
     };
   ```

8. `converge` becomes `converge(p: PipelineResult): Promise<{ outcome; stackPath; invocation }>`. It builds `const invocation = invocationFor(p);`; writes the dev stack file from `p` and, in the same try, `writeConfigurationFile(configurationFilePath, p.graph.checkedConfiguration);` (both `DEV.STACK_WRITE_FAILED`); runs the converge; and in a `finally` around the converge call, `removeConfigurationFile(configurationFilePath);`. It returns `invocation` too. The first converge calls `converge(pipeline)`, and its `reproduceCommand(invocation, …)` uses the returned invocation.
9. `rebuild`: the block from `const stackPath = writeDevStackFile({ … });` to the `converge-failed` emit becomes:

   ```ts
           const { outcome, stackPath, invocation } = await converge(rePipeline);
           if (outcome.signal !== null || outcome.exitCode !== 0) {
             emit({
               kind: 'converge-failed',
               stackFilePath: stackPath,
               reproduceCommand: reproduceCommand(invocation, outcome),
               cwd,
             });
             return;
           }
   ```

   A `CliStructuredError` that `converge` throws is caught by `rebuild`'s existing catch and emitted as `rebuild-failed`.

The dev configuration file lives only while a converge runs, which is shorter than the design's "deleted when `prisma dev` stops" (§ 20, decision 9).

### 8.6 Entries and packaging

1. `packages/0-framework/3-tooling/cli/src/exports/pools.ts` is deleted. New `src/exports/configuration-file.ts`:

   ```ts
   /** What the generated stack files read in the second process. Not public API: published as `@prisma/composer/internal/configuration-file`, it may change in any release. */
   export {
     appSecretsFromEnvironment,
     readCheckedConfiguration,
   } from '../configuration-file.ts';
   ```

2. `packages/0-framework/3-tooling/cli/tsdown.config.ts`: the entry `pools: 'src/exports/pools.ts',` becomes `'configuration-file': 'src/exports/configuration-file.ts',`. Run `pnpm --filter @internal/cli build`; it regenerates `package.json#exports` with `./configuration-file` and without `./pools`. Commit the regenerated file; do not hand-edit it.
3. `packages/9-public/composer/src/exports/internal-pools.ts` is deleted. New `internal-configuration-file.ts`: `export * from '@internal/cli/configuration-file';`.
4. `packages/9-public/composer/tsdown.config.ts`: `'internal-pools': 'src/exports/internal-pools.ts',` becomes `'internal-configuration-file': 'src/exports/internal-configuration-file.ts',`.
5. `packages/9-public/composer/package.json#exports`: `"./internal/pools": "./dist/internal-pools.mjs",` becomes `"./internal/configuration-file": "./dist/internal-configuration-file.mjs",`.
6. `architecture.config.json`: the entry for `packages/9-public/composer/src/exports/internal-pools.ts` becomes the same entry for `internal-configuration-file.ts`, `"domain": "public", "layer": "public", "plane": "control"`.
7. `tsconfig.depcruise.json`: the `@prisma/composer/internal/pools` path becomes `@prisma/composer/internal/configuration-file` → `./packages/9-public/composer/src/exports/internal-configuration-file.ts`.

### 8.7 The engine version

`@prisma/cli-engine` goes from `0.9.0` to `0.10.0`, exactly, in four places: the `dependencies` of `packages/0-framework/3-tooling/cli/package.json`; the `devDependencies` of `packages/1-prisma-cloud/1-extensions/target/package.json`; both the `peerDependencies` and the `devDependencies` of `packages/9-public/composer-cli/package.json`; and the root `package.json`'s `pnpm.overrides`. Run `pnpm install` so the lockfile records it. `pnpm check:cli-engine-pin` checks that the declarations agree and that the installed `prisma` host loads the same engine copy as the family. 0.10.0 must be published first: until prisma/prisma-cli#383 merges and publishes it, the implementer builds and tests against a local build of that branch at `415c668a` or later (for example a `link:` override, never committed) and the pull request stays a draft.

## 9. CLI: Composer redacts every secret it knows

### 9.1 What a command knows

| Values | When they are added | Length |
| --- | --- | --- |
| Every value a written `secrets` list returns | as each adapter returns, in `readAppSecrets` | any |
| Under each name `secretsKeys(graph)` lists, the value in the app configuration and the value in the app secrets | after Load | any |
| Each app configuration value under a name that looks like a credential (`SECRET_ENV_NAME`). Existing S4 behaviour, kept for now; not part of this design | after the app configuration is read | eight characters or more |

`KnownSecrets.redact(text)` also applies `redactSecrets(text, process.env)`, as today: the values of this process's own variables under credential-looking names, eight characters or more, bearer and basic tokens, JWTs, a password in a URL, and `token=…` pairs. That too is existing S4 behaviour, kept for now. The stream redactor (§ 9.3) uses exact values only: the known values and `secretNamedValues(process.env)`.

### 9.2 `deployment-summary.ts`

1. `import type { ConfigPools } from '@internal/core/config';` goes.
2. `readEngineFailureCause`'s signature and doc comment become:

   ```ts
   /** Parent half: the cause the child recorded, passed through `redact`, or undefined when it recorded none. The child redacts only what its own environment names as a credential; the parent knows every secret the command read. */
   export function readEngineFailureCause(
     resultFilePath: string,
     redact: (text: string) => string,
   ): string | undefined
   ```

   and its last line `return cause.length > 0 ? redactValues(cause, secrets) : undefined;` becomes `return cause.length > 0 ? redact(cause) : undefined;`.
3. `poolSecrets` is removed.
4. `redactValues` and its doc comment become exported, without a minimum length:

   ```ts
   /** `text` with each value in `values` replaced by `[redacted]`, longest first. A value is replaced at any length; an empty one is skipped. */
   export function redactValues(text: string, values: Iterable<string>): string {
     let redacted = text;
     for (const value of [...values].sort((a, b) => b.length - a.length)) {
       if (value.length > 0) redacted = redacted.replaceAll(value, REDACTED);
     }
     return redacted;
   }
   ```

5. New export, before `redactSecrets`:

   ```ts
   /** The values of `env`'s variables whose names look like credentials, eight characters or more, so a one-letter placeholder does not blank every matching letter. */
   export function secretNamedValues(env: Readonly<Record<string, string | undefined>>): string[] {
     return Object.entries(env).flatMap(([name, value]) =>
       SECRET_ENV_NAME.test(name) && value !== undefined && value.length >= 8 ? [value] : [],
     );
   }
   ```

   `SECRET_ENV_NAME` and `REDACTED` move above it and `REDACTED` is exported. `redactSecrets`'s first statement becomes `return redactValues(text, secretNamedValues(env))` followed by the same four `.replace` calls; its doc comment's "Values shorter than 8 characters are left, so a one-letter placeholder does not blank every matching letter." stays.

`deployment-summary.ts` still imports nothing but `node:fs`, `node:util`, core's types and `blindCast`, so the `report` entry stays light.

### 9.3 New file `packages/0-framework/3-tooling/cli/src/redaction.ts`

```ts
import type { AppConfiguration, AppSecrets } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import {
  type DeploymentSummary,
  REDACTED,
  redactSecrets,
  redactValues,
  secretNamedValues,
} from './deployment-summary.ts';
import type { DevEvent } from './operations/dev.ts';

/**
 * The secret values one command knows (ADR-0062). It learns them as the command reads them,
 * and everything the command prints, returns or reports passes through `redact`.
 */
export class KnownSecrets {
  private readonly known = new Set<string>();

  /** Adds each value that is not empty. */
  add(values: Iterable<string>): void {
    for (const value of values) if (value.length > 0) this.known.add(value);
  }

  /** Every value added so far, longest first. */
  values(): readonly string[] {
    return [...this.known].sort((a, b) => b.length - a.length);
  }

  /** `text` with every known value replaced by `[redacted]` at any length, then whatever `redactSecrets` finds by name and by shape. */
  redact(text: string): string {
    return redactSecrets(redactValues(text, this.known), process.env);
  }
}

/**
 * The secret values the app configuration and the app secrets hold: under each name in
 * `secretsKeys`, the value in either, at any length; and each app configuration value of
 * eight characters or more under a name that looks like a credential.
 */
export function secretValuesIn(
  configuration: AppConfiguration,
  secrets: AppSecrets,
  secretsKeys: readonly string[],
): string[] {
  const text = Object.fromEntries(
    Object.entries(configuration).flatMap(([name, value]) =>
      typeof value === 'string' ? [[name, value]] : [],
    ),
  );
  const named = secretsKeys.flatMap((key) =>
    [text[key], secrets[key]].filter((value): value is string => value !== undefined),
  );
  return [...named, ...secretNamedValues(text)];
}

function redactData(value: unknown, known: KnownSecrets): unknown {
  if (typeof value === 'string') return known.redact(value);
  if (Array.isArray(value)) return value.map((member) => redactData(member, known));
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, redactData(member, known)]),
    );
  }
  return value;
}

/**
 * `error` with every known secret removed from its summary, `why`, `fix` and every string in
 * its `meta`. The code, severity, `where` and docs link are kept. The cause is dropped, because
 * it holds the same text unredacted and a renderer may print it.
 */
export function redactError(error: CliStructuredError, known: KnownSecrets): CliStructuredError {
  return new CliStructuredError(error.code, known.redact(error.message), {
    severity: error.severity,
    ...(error.why === undefined ? {} : { why: known.redact(error.why) }),
    ...(error.fix === undefined ? {} : { fix: known.redact(error.fix) }),
    ...(error.where === undefined ? {} : { where: error.where }),
    ...(error.meta === undefined
      ? {}
      : {
          meta: Object.fromEntries(
            Object.entries(error.meta).map(([key, value]) => [key, redactData(value, known)]),
          ),
        }),
    ...(error.docsUrl === undefined ? {} : { docsUrl: error.docsUrl }),
  });
}

/** `event` with every known secret removed from the text it carries: a message, or a dev server's output line. */
export function redactDevEvent(event: DevEvent, known: KnownSecrets): DevEvent {
  switch (event.kind) {
    case 'target-warning':
    case 'rebuild-failed':
    case 'watch-error':
    case 'stop-error':
      return { ...event, message: known.redact(event.message) };
    case 'dev-server-output':
      return { ...event, line: known.redact(event.line) };
    default:
      return event;
  }
}

/** `summary` with every known secret removed from each entity's id, url and details. */
export function redactSummary(
  summary: DeploymentSummary | undefined,
  known: KnownSecrets,
): DeploymentSummary | undefined {
  if (summary === undefined) return undefined;
  return {
    app: summary.app,
    nodes: summary.nodes.map((node) => ({
      address: node.address,
      entities: node.entities.map((entity) => ({
        ...entity,
        id: known.redact(entity.id),
        ...(entity.url === undefined ? {} : { url: known.redact(entity.url) }),
        ...(entity.details === undefined
          ? {}
          : {
              details: Object.fromEntries(
                Object.entries(entity.details).map(([key, value]) => [key, known.redact(value)]),
              ),
            }),
      })),
    })),
  };
}

/**
 * Redacts a stream of text chunk by chunk: every value in `values` becomes `[redacted]`. It holds
 * back at most one fewer character than the longest value, so a value split across two chunks is
 * still replaced. When no value holds a line break, it never holds back a complete line.
 * `push` returns the text that is ready; `end` returns the rest.
 */
export class StreamRedactor {
  private held = '';
  private readonly pattern: RegExp | undefined;
  private readonly keep: number;
  private readonly cutAtLineEnds: boolean;

  constructor(values: readonly string[]) {
    const sorted = [...new Set(values)]
      .filter((value) => value.length > 0)
      .sort((a, b) => b.length - a.length);
    this.pattern =
      sorted.length === 0
        ? undefined
        : new RegExp(sorted.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
    this.keep = (sorted[0]?.length ?? 1) - 1;
    this.cutAtLineEnds = sorted.every((value) => !value.includes('\n'));
  }

  push(chunk: string): string {
    const text = this.held + chunk;
    let cut = Math.max(0, text.length - this.keep);
    if (this.cutAtLineEnds) cut = Math.max(cut, text.lastIndexOf('\n') + 1);
    let out = '';
    let from = 0;
    if (this.pattern !== undefined) {
      for (const match of text.matchAll(this.pattern)) {
        if (match.index >= cut) break;
        out += text.slice(from, match.index) + REDACTED;
        from = match.index + match[0].length;
        if (from > cut) cut = from;
      }
    }
    out += text.slice(from, cut);
    this.held = text.slice(cut);
    return out;
  }

  end(): string {
    const text = this.held;
    this.held = '';
    return this.pattern === undefined ? text : text.replace(this.pattern, REDACTED);
  }
}

/** A transform that redacts one output stream with a `StreamRedactor`, and writes what it held back when the stream ends. */
export function redactingTransform(values: readonly string[]): TransformStream<string, string> {
  const redactor = new StreamRedactor(values);
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const out = redactor.push(chunk);
      if (out.length > 0) controller.enqueue(out);
    },
    flush(controller) {
      const out = redactor.end();
      if (out.length > 0) controller.enqueue(out);
    },
  });
}
```

Neither `redaction.ts` nor `configuration-file.ts` casts, so `pnpm lint:casts` reports `delta=0`. The redactor never cuts a value in two. A value that starts before the length cut is whole inside `text`, because it is at most `keep + 1` characters long. A value that starts before the line cut ends before the line break, because it holds none. `TransformStream` is a global in Node and Bun, typed by `@types/node`, which the CLI's `tsconfig.json` already loads (§ 18 shows both probes).

Why the line cut: Alchemy prints a line, such as `Creating web`, then waits minutes for the platform. A length cut alone would hold back the end of that line for the whole wait.

### 9.4 `run-alchemy.ts`

1. `AlchemyInvocation` gains, after `env`:

   ```ts
     /** Every secret value the command knows, for the output redactor. Never in `env` or on the command line, which the engine may log. */
     readonly redactedValues: readonly string[];
   ```

   `AlchemyInvocationInput` gains the same member with the same comment, and `alchemyInvocation` returns `redactedValues: input.redactedValues`.
2. New export, before `spawnCommandLine`:

   ```ts
   /** Where a piped child's output is written. */
   export interface OutputStreams {
     readonly stdout: { write(text: string): unknown };
     readonly stderr: { write(text: string): unknown };
   }
   ```

3. `spawnCommandLine` becomes:

   ```ts
   /** Starts a resolved command line with stdin inherited and its output piped through redaction, and returns how it ended. */
   export function spawnCommandLine(
     line: AlchemyCommandLine,
     redactedValues: readonly string[],
     outputs: OutputStreams = process,
   ): Promise<AlchemyOutcome> {
     return new Promise<AlchemyOutcome>((resolve, reject) => {
       const child = spawn(line.command, [...line.args], {
         cwd: line.cwd,
         stdio: ['inherit', 'pipe', 'pipe'],
         env: { ...process.env, ...line.env },
       });
       const values = [...redactedValues, ...secretNamedValues(process.env)];
       const stdout = new StreamRedactor(values);
       const stderr = new StreamRedactor(values);
       const write = (stream: OutputStreams['stdout'], text: string): void => {
         if (text.length > 0) stream.write(text);
       };
       child.stdout?.setEncoding('utf8').on('data', (chunk: string) => write(outputs.stdout, stdout.push(chunk)));
       child.stderr?.setEncoding('utf8').on('data', (chunk: string) => write(outputs.stderr, stderr.push(chunk)));
       child.on('error', reject);
       child.on('close', (exitCode, signal) => {
         write(outputs.stdout, stdout.end());
         write(outputs.stderr, stderr.end());
         resolve({ exitCode, signal });
       });
     });
   }
   ```

   It imports `secretNamedValues` from `./deployment-summary.ts` and `StreamRedactor` from `./redaction.ts`.
4. `spawnAlchemy` becomes `return { ...(await spawnCommandLine(commandLine, invocation.redactedValues)), commandLine };`, and its doc comment's "inherited stdio" becomes "stdin inherited and output piped through redaction".
5. The file header's "hand the terminal to the generated stack file" becomes "run the generated stack file, with its output piped through redaction".

### 9.5 The engine's output transform, for the CLI

`@prisma/cli-engine` 0.10.0 (prisma/prisma-cli#383, final API at `415c668a`) adds `transformOutput?: (stream: ChildStreamName) => TransformStream<string, string>` to `ctx.spawn`'s options, where `ChildStreamName` is `"stdout" | "stderr"`. What the engine does with it:

- It calls `transformOutput` once per stream, before the child starts. It starts the child with stdin inherited and stdout and stderr piped, and passes each stream, decoded as UTF-8, through its transform.
- It writes the result where the child's output goes without a transform: in human and markdown format, the child's stdout to stdout and its stderr to stderr; in json format, both to stderr, so stdout carries only the engine's NDJSON. It reads the child only as fast as the terminal takes the text.
- Each stream keeps its own order; there is no order between the two.
- Each transform's `flush` runs, and its output is written, before `ctx.spawn` settles, on every path: a normal exit, an abort, a SIGTERM, a stream that fails, and an adapter that rejects.
- If a transform throws, the engine ends the child as on abort and `ctx.spawn` rejects with that error.
- Before the transform sees the text, the engine replaces the `PRISMA_SERVICE_TOKEN` it injects for `needs: { credentials: 'child' }` with `[redacted]`.
- `ctx.spawnOptions` lists the option names `ctx.spawn` accepts, and `ctx.spawn` refuses any other name. A host older than 0.10.0 has no `ctx.spawnOptions` and silently ignores `transformOutput`.

Composer writes nothing itself and maps no stream: the engine owns where the output goes, in every output format.

`family/converge.ts`:

1. `ConvergeContext` becomes:

   ```ts
   export interface ConvergeContext {
     readonly spawn: (options: {
       readonly command: string;
       readonly args?: readonly string[];
       readonly cwd?: string;
       readonly env?: Readonly<Record<string, string | undefined>>;
       readonly transformOutput?: (stream: ChildStreamName) => TransformStream<string, string>;
     }) => Promise<ChildResult>;
     /** The option names the host's `ctx.spawn` accepts. Absent on an engine older than 0.10.0. */
     readonly spawnOptions?: readonly string[];
     readonly lastChild: () => ChildResult | undefined;
   }
   ```

   `lastChild`'s doc comment is unchanged. `ChildStreamName` joins the type import from `@prisma/cli-engine`. The real `ctx` satisfies it structurally; `spawnOptions` is optional here because a 0.9.0 host does not set it.

2. New export, after `ConvergeContext`:

   ```ts
   /**
    * The failure for a host whose engine cannot transform a child's output, which Composer needs
    * to redact the deploy engine's output; `undefined` when it can. A 0.9.0 host would ignore the
    * transform and print the output unredacted.
    */
   export function outputTransformMissing(ctx: ConvergeContext): Result<never, CliStructuredError> | undefined {
     if (ctx.spawnOptions?.includes('transformOutput') === true) return undefined;
     return notOk(
       toEngineError(
         new ComposerError(
           'DEPS.CLI_ENGINE_INCOMPATIBLE',
           "This prisma CLI's @prisma/cli-engine is older than 0.10.0; Composer needs 0.10.0 or later.",
           {
             why: "Composer removes secrets from the deploy engine's output through ctx.spawn's transformOutput option, which @prisma/cli-engine 0.10.0 added. An older engine ignores the option and would print that output unredacted, so Composer starts nothing.",
             fix: 'Use a prisma CLI whose @prisma/cli-engine is 0.10.0 or later, the version @prisma/composer-cli declares as its peer.',
           },
         ),
       ),
     );
   }
   ```

   `converge.ts`'s import of `CliStructuredError as ComposerError` from `@internal/foundation/errors` becomes a value import.

3. `convergeSpawn` and its doc comment become:

   ```ts
   /**
    * The adapter the operations call, backed by the engine's `ctx.spawn`, so the engine owns
    * signal policy and where the output goes. The engine passes each of the child's output
    * streams through Composer's redactor before it prints it. The secret values reach the
    * redactor in this process, never the child's environment or command line. Call it only
    * after `outputTransformMissing` found nothing.
    */
   export function convergeSpawn(ctx: ConvergeContext): RunAlchemy {
     return async (invocation) => {
       const commandLine = alchemyCommandLine(invocation);
       const values = [...invocation.redactedValues, ...secretNamedValues(process.env)];
       const result = await ctx.spawn({
         command: commandLine.command,
         args: [...STDOUT_TO_STDERR, ...commandLine.args],
         cwd: commandLine.cwd,
         env: commandLine.env,
         transformOutput: () => redactingTransform(values),
       });
       return { ...result, commandLine };
     };
   }
   ```

   `converge.ts` imports `secretNamedValues` from `../deployment-summary.ts` and `redactingTransform` from `../redaction.ts`. Each call of `transformOutput` returns a new transform, so each stream has its own held-back text.

4. `commands/deploy.ts` and `commands/dev.ts`: the first two statements of each handler become

   ```ts
         const refused = outputTransformMissing(ctx);
         if (refused !== undefined) return refused;
         const alchemy = convergeSpawn(ctx);
   ```

   with `outputTransformMissing` added to their `../converge.ts` import. The check runs before the operation, so a refused run creates nothing: no container, no preflight write, no stack file. `destroy` has no CLI command (ADR-0050); the programmatic operations pipe in-process (§ 9.4) and need no engine.

`STDOUT_TO_STDERR` stays, because in human format the engine writes the child's stdout to the CLI's stdout, which in a piped run carries only Composer's data lines, and the preload keeps Alchemy's output off it. #383's README calls it redundant, but under the final API's own routing (stdout to stdout in human format) it is not; it stays until Composer's data lines move elsewhere. Its doc comment becomes `Node's \`--import\` of a module that sends the child's stdout to stderr when stdout is not a terminal. Under the engine's output transform the child's stdout is always a pipe, so all of Alchemy's output reaches the engine as stderr, and the CLI's own stdout keeps only its data lines in human format.`

What Composer relies on:

- **The held-back text.** The engine flushes each transform before `ctx.spawn` settles, on every path, so no held-back text is lost, and none is printed after the command's next output.
- **Report events.** While the child runs, the engine buffers `ctx.report` events and prints them before `ctx.spawn` resolves. Under `prisma dev`, a dev server's output line can be reported during a rebuild converge. The engine reads the child's streams to their end, flushing the transforms, before it prints the buffered events, so the child's last text comes first. With the line cut (§ 9.3), the only text the redactor holds back by then is an unfinished last line. Test 40 checks the order; if it fails, the implementer stops and reports.
- **Abort.** On SIGTERM or an abort of `ctx.signal`, the engine ends the child with SIGTERM, then SIGKILL after a grace period, and still flushes. Composer adds no signal handling.
- **Failure.** The redactor does not throw. If a transform did, `ctx.spawn` would reject; `runStackPipeline` reports that as a defect, redacted (§ 8.4).
- **The engine's credential.** The engine redacts the `PRISMA_SERVICE_TOKEN` it injects, including one from `prisma login`, which Composer never sees.

`reproduceCommand` keeps printing the Alchemy command line, which `outcome.commandLine` carries. Alchemy's stdout and stderr are pipes, so it shows plain progress lines without colour (§ 18 shows Alchemy deploying with piped output).

`alchemy-bin.ts` does not change.

## 10. The Prisma Cloud target and the local target

1. `packages/1-prisma-cloud/1-extensions/target/src/param.ts`: in `envParam`, `{ label: \`envParam('${name}')\`, poolKey: name }` becomes `{ label: \`envParam('${name}')\`, configurationKey: name }`; the doc comment's "the variable's value in the config pool" becomes "the variable's value in the app configuration".
2. `secret.ts`: in `envSecret`, `{ label: \`envSecret('${name}')\` }` becomes `{ label: \`envSecret('${name}')\`, secretsKey: name }`.
3. `git mv pool-text.ts configuration-text.ts`; the function becomes `configurationText(configuration: Readonly<Record<string, unknown>>, name: string, notText: (kind: string) => Error): string | undefined`, doc comment `The text the app configuration holds for \`name\`, as an environment variable would: \`undefined\` when it is absent or empty. Throws the error \`notText\` builds when it holds anything else there.` Its three importers (`serializer.ts`, `preflight.ts`, `local-target/preflight.ts`) import and call it by the new name.
4. `serializer.ts`: `SerializeInputOptions.env`'s doc comment becomes `Where \`envParam\` leaves are read: the app configuration, or in the second process the checked values from the configuration file. The process environment when not given.`
5. `descriptors/compute.ts`: `...(ctx.opts.configPool !== undefined ? { env: ctx.opts.configPool } : {}),` becomes `...(ctx.opts.checkedConfiguration !== undefined ? { env: ctx.opts.checkedConfiguration.values } : {}),`.
6. `preflight.ts`: `poolValue` becomes `valueOf`; `input.pools.secrets[meta.name]` becomes `input.secrets[meta.name]`; `poolText(input.pools.config, …)` becomes `configurationText(input.configuration, …)`; the doc comments use § 4.2's words.
7. `preflight-names.ts`: `/** An env-sourced param's config pool value that preflight cannot write to a platform variable. */` becomes `/** An env-sourced param's app configuration value that preflight cannot write to a platform variable. */`.
8. `local-target/preflight.ts`: `const env = input.pools.config;` becomes `const env = input.configuration;`; `input.pools.secrets[name]` becomes `input.secrets[name]`; the header's first sentence becomes `Every value comes from what the command read: secrets from the app secrets, env-sourced params from the app configuration.`
9. `local-target/attach.ts`: `serve: async ({ address, node, server, pools }) =>` becomes `serve: async ({ address, node, server, configuration, secrets }) =>`, and its `materializeEnv(…, pools)` becomes `materializeEnv(input.devDir, address, instance.port, configuration, secrets)`.
10. `packages/1-prisma-cloud/0-lowering/local-target/src/compute.ts`: `materializeEnv`'s last parameter `pools: ConfigPools` becomes `configuration: AppConfiguration, secrets: AppSecrets`; `pools.secrets[name]` becomes `secrets[name]` and `pools.config[name]` becomes `configuration[name]`; the provider's call passes `input.configuration, input.secrets`.
11. `packages/1-prisma-cloud/1-extensions/target/src/__tests__/invariants.test.ts`: in invariant 4's comment, "values come from the pools" becomes "values come from the app configuration and the app secrets".
12. `local-target/preflight.ts`, `howToSet`: its return becomes

    ```ts
      const files =
        environment === 'test'
          ? `.env, .env.${encoded} and .env.${encoded}.local`
          : `.env, .env.local, .env.${encoded} and .env.${encoded}.local`;
      return (
        'Set each missing variable where an adapter in prisma.config.ts reads it: the `secrets` list of ' +
        'the `composer` section for a secret, the `config` list for an env-sourced param. ' +
        `environmentVariables() reads the shell you run \`prisma dev\` from; dotenv() reads ${files} beside prisma.config.ts.`
      );
    ```

    so it never names `.env.local` for the environment `test`, which `dotenv()` skips.

In the dev second process, `configuration` is `checked.configuration.values`, the text of each configuration key the graph reads, which is every name a param row points at; `secrets` is what `PRISMA_COMPOSER_APP_SECRETS` holds, every name a `$secret` pointer names.

## 11. What breaks, and what does not

Breaks:

1. `LoadOptions.configPool` is now `configuration`. `LowerOptions.configPool` is gone; a hand-written stack passes `checkedConfiguration` or nothing.
2. `paramSource()`'s `poolKey` option is now `configurationKey`.
3. `ConfigPool`, `SecretsPool` and `ConfigPools` are now `AppConfiguration` and `AppSecrets`; `PreflightInput`, `LocalTargetProvidersInput` and a local attachment's `serve` input take `configuration` and `secrets` in place of `pools`; `localTargetProviders()` takes them as two arguments. This touches extension authors only.
4. `@prisma/composer/internal/pools` is gone. It was not public API.
5. `dotenv()` now skips `.env.local` for the environment `test`, and parses with `dotenv` 16 through `dotenv-flow`.
6. The deploy engine's output reaches the terminal through the CLI engine's output transform, so Alchemy's stdout and stderr are pipes: it shows plain progress lines, without colour or a live progress display.
7. A known secret is redacted at any length. A one-character secret blanks that character everywhere in the output.
8. A module body that builds a different graph in the second process fails the deploy, naming the addresses.
9. A root field whose real value JSON cannot hold exactly, such as a `Date`, fails the Load in the first process.
10. A name read both by `envParam()` and by `envSecret()` fails the Load.
11. An `envParam()` in a service's input or params whose app configuration value is not text fails at Load, in the first process. Before, it failed later, in the serializer or preflight.
12. A config adapter now runs after the secrets adapters, so a broken secrets adapter is reported before a broken config adapter.
13. The app's `@prisma/composer` must be at least the version that ships `internal/configuration-file`; with an older one the second process fails when it imports the stack file.
14. `@prisma/composer-cli` declares `@prisma/cli-engine` 0.10.0 as its exact peer. `prisma deploy` and `prisma dev` under a host with an older engine fail with `DEPS.CLI_ENGINE_INCOMPATIBLE` before they start anything.

Unchanged:

1. A project with neither `config` nor `secrets` reads the shell, as before, in the first process.
2. The input document, the pointer rows, the `$secret` pointers and every deploy's resources.
3. Every error message not listed in § 12.

The only existing tests this PR changes are those § 15.1 lists. If any other existing test fails, the implementer stops and reports.

## 12. Error messages, verbatim

| Where | Condition | Message |
| --- | --- | --- |
| `loadModule` | both `configuration` and `checkedConfiguration` | `Load takes configuration, in the first process, or checkedConfiguration, in the second, not both.` |
| `loadModule` | a root with `input` and neither | ``Module "<root>" declares input and is being deployed as the root, but Load was given no app configuration to fill it from. Pass { configuration } to Load; prisma deploy and prisma dev pass the values the `config` adapters return.`` |
| `configurationText` | no app configuration | ``<site> depends on <label>, but Load was given no app configuration to read "<key>" from. Pass { configuration } to Load; the deploy and dev commands pass the values the `config` adapters return.`` |
| `configurationText` | the value is not text (unchanged text; now also for a service's input and params) | ``<site> depends on <label>, which reads "<key>" from the values the `config` adapters return, but they return <kind> for it, not text. <label> reads text; to pass other data, declare it in the root module's input.`` |
| `resolveOne`, second process | a root field missing from the file | `<input.path> of root module "<m>" is not in the configuration file. The first process's root body did not pass it on, so the deploy's two processes built different graphs. A module body must build the same graph every time; one that reads process.env, a file or the clock can build a different one.` |
| `checkedConfigurationOf` | a key read as both | `<param label> reads "<key>" from the app configuration, and <secret label> names "<key>" as a secret. A name is a plain value or a secret, not both: Composer hands the deploy's second process every plain value it reads, in a file, and never writes a secret to a file. Give the plain value and the secret different names.` |
| `checkedConfigurationOf` | a root field JSON cannot hold | `<input.path> of root module "<m>" holds <kind>, which JSON cannot hold exactly. The deploy hands the root's checked input to its second process in a JSON file, so a field the root's body passes on must hold text, a finite number, a boolean, null, or arrays and plain objects of these.` `<kind>` is `a non-finite number`, `an array with a missing member`, `a function`, `a symbol`, `a bigint` or `an object that is not plain data`. |
| `secretSource()` | an empty `secretsKey` | `secretSource() secretsKey must be a non-empty string.` |
| `paramSource()` | an empty `configurationKey` | `paramSource() configurationKey must be a non-empty string.` |
| `paramSource()` | `configurationKey` and `redacted` | `paramSource() takes configurationKey, for a value known at deploy, or redacted, for a secret known only at boot, not both.` |
| `lowering` | the addresses differ | `The deploy's second process built a different graph from the one Composer checked in its first process. Only in the second process: <list>. Only in the first process: <list>. A module body must build the same graph every time; one that reads process.env, a file or the clock can build a different one.` `<list>` is `none`, or the addresses sorted, each in double quotes, joined by `, `. |
| `readCheckedConfiguration` | no `PRISMA_COMPOSER_CONFIGURATION_FILE` | `PRISMA_COMPOSER_CONFIGURATION_FILE is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which names the configuration file it wrote there.` |
| `readCheckedConfiguration` | the file cannot be read | `Could not read the configuration file <file>: <message>. Composer deletes it when the run ends, so a stack file run by hand after that cannot read it; run the command again.` |
| `readCheckedConfiguration` | not what Composer writes | `The configuration file <file> is not one Composer wrote: <it is not JSON | rootInput is not a list of fields | values is not an object of text>.` |
| `readCheckedConfiguration` | no `PRISMA_COMPOSER_NODE_ADDRESSES` | `PRISMA_COMPOSER_NODE_ADDRESSES is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which lists the node addresses it checked there.` |
| `readCheckedConfiguration` | addresses not a list of text | `PRISMA_COMPOSER_NODE_ADDRESSES is not a JSON list of node addresses.` |
| `appSecretsFromEnvironment` | no `PRISMA_COMPOSER_APP_SECRETS` | `PRISMA_COMPOSER_APP_SECRETS is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which hands the app secrets the local services need there.` |
| `appSecretsFromEnvironment` | not an object of text | `PRISMA_COMPOSER_APP_SECRETS is not a JSON object of text.` |
| `outputTransformMissing` | `DEPS.CLI_ENGINE_INCOMPATIBLE` | summary ``This prisma CLI's @prisma/cli-engine is older than 0.10.0; Composer needs 0.10.0 or later.``; why ``Composer removes secrets from the deploy engine's output through ctx.spawn's transformOutput option, which @prisma/cli-engine 0.10.0 added. An older engine ignores the option and would print that output unredacted, so Composer starts nothing.``; fix ``Use a prisma CLI whose @prisma/cli-engine is 0.10.0 or later, the version @prisma/composer-cli declares as its peer.`` |
| `dotenv()` | a file `dotenv-flow` lists cannot be read | `dotenv() could not read <absolute path>: <message>` (unchanged) |

The `LoadError`s carry `COMPOSE.GRAPH_INVALID`. The `LowerError` and the second process's plain `Error`s reach the user as the cause of `DEPLOY.ENGINE_FAILED` or `DEV.CONVERGE_FAILED`. The one new code is `DEPS.CLI_ENGINE_INCOMPATIBLE`.

## 13. The release note

The repo has no changesets; the pull request description carries the release note, as #403 and #412 did.

- **Title**: `feat!: configuration is read once, and no known secret is printed`.
- **Description**, a section `## Breaking changes` with, in this order:
  1. ```ts
     // before
     Load(root, { configPool: { EMAIL_FROM: 'a@example.com' } });
     paramSource(payload, { label: "myParam('X')", poolKey: 'X' });
     // after
     Load(root, { configuration: { EMAIL_FROM: 'a@example.com' } });
     paramSource(payload, { label: "myParam('X')", configurationKey: 'X' });
     ```
     The sentence: `"Config pool" and "secrets pool" are now "the app configuration" and "the app secrets". LoadOptions.configPool is LoadOptions.configuration, paramSource()'s poolKey option is configurationKey, and the types ConfigPool, SecretsPool and ConfigPools are AppConfiguration and AppSecrets. An extension's preflight, local providers and serve step receive configuration and secrets in place of pools.`
  2. `If prisma.config.ts has import 'dotenv/config' and you adopt dotenv() in config or secrets, remove the import. Otherwise it puts .env's values into the process environment, environmentVariables() returns them last, and they override .env.<environment>.` with the before and after of a `prisma.config.ts` head: `import 'dotenv/config';` and `config: [environmentVariables()]` before, `config: [dotenv(), environmentVariables()]` and no import after.
  3. `dotenv() reads its files through dotenv-flow 4.1.0, in the same order as before: .env, .env.local, .env.<environment>, .env.<environment>.local. It now skips .env.local for the environment test, as dotenv-flow does. It never reads .env.defaults.`
  4. `The deploy's second process no longer runs the config adapters. It reads the values the first process checked from a configuration file in .prisma-composer/, readable only by you and deleted when the deploy ends, and refuses to deploy a graph whose node addresses differ from the first process's. A module body that reads process.env, a file or the clock and builds a different graph now fails the deploy.`
  5. `Composer redacts every secret it knows wherever it prints: every value under a name an envSecret() names, every value your own secrets list returns, at any length. The deploy engine's output now passes through Composer's redactor before the CLI prints it, so Alchemy shows plain progress lines without colour.`
  6. `A root field the body passes on must hold data JSON can hold exactly; a name may not be read both by envParam() and by envSecret(); and a non-text envParam() value in a service's input now fails before anything is created.`
  7. `@prisma/composer and @prisma/composer-cli must be the same version: the generated stack file imports @prisma/composer/internal/configuration-file. @prisma/composer-cli needs @prisma/cli-engine 0.10.0 or later; under an older prisma CLI, prisma deploy and prisma dev stop with DEPS.CLI_ENGINE_INCOMPATIBLE before they start anything.`

## 14. Documentation

All in the same pull request (`.agents/rules/user-facing-surface-changes.mdc`). Every replacement is written without hard wraps: one paragraph or one list item per line. Each decision record this PR changes is replaced in full by the text given, between two `~~~` lines, so it reads as one current record with no amendment notes: its notes are folded in, and what this PR reverses moves to "Alternatives considered". ADR-0062 is already one current record, so it gets the edits of § 14.6 only.

### 14.1 ADR-0049, rewritten

`docs/design/90-decisions/ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md`:

~~~markdown
# ADR-0049: Composer's configuration is the `composer` section of `prisma.config.ts`

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
  orm: /* the ORM's own section, unchanged */,
});
```

## Decision

Composer reads its configuration from one place: the `composer` section of the app's `prisma.config.ts`, the file every Prisma CLI command family already shares. There is no separate Composer config file.

The section holds the `PrismaAppConfig` that [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) describes: the extension descriptors the deploy looks nodes up in, and the one state store. It also takes three optional fields: `entry`, the module whose default export is the application root; `config`, the config adapters; and `secrets`, the secrets adapters ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). The CLI engine (the command-line runtime every Prisma command family mounts into) loads the file, and Composer's section validator hands the command a `ComposerConfigSource`: `{ value, file }`, the validated section and the file that declared it. The programmatic operations on `@prisma/composer/control` take the same `ComposerConfigSource` as a required `config` input, and run the same checks on it.

- `entry` is an input to the tool, like the ORM section's schema path, not an application fact. It resolves against the directory of the declaring file. `--entry <path>` on `prisma deploy` and `prisma dev`, or an operation's `entry` input, overrides it and resolves against the working directory. With neither, the command fails with `CONFIG.ENTRY_MISSING`.
- `config` and `secrets` are arrays of adapters. Both default to `[environmentVariables()]`, applied by the command when it reads them, not by the validator. Only the command's first process calls an adapter. A deploy's, a `destroy`'s and `prisma dev`'s second process, which runs Alchemy, reads what the first process checked from a configuration file instead (ADR-0062).

## Reasoning

The Prisma CLI engine already discovers, evaluates and merges `prisma.config.ts`, and it gives each command family a named section with a validator of its own. A second Composer-only file meant a second loader, a second discovery rule (walking up from the deploy entry rather than from where the command runs), and a second file for users to learn. With the configuration in the shared file, Composer has one loader, the engine's, and one discovery rule, the engine's: from the command's working directory up to the repository root.

The section holds executable values. Extension descriptors carry provider layers, container lifecycles and preflight hooks, and adapters are functions; none of these can be described by a schema. So the validator checks only what identifies each value: `extensions` is an array of objects, each with a non-empty string `id` and an object `nodes`, and the ids are distinct; `state` is an object with a string `extension` and a `create` function; `entry`, when present, is a non-empty string; `config` and `secrets`, when present, are arrays of functions. The validator never calls an adapter. Everything else passes through untouched: the command receives the descriptors and adapters as the very objects the config file built, never copies. Any other top-level key of the section is an error, because a key the validator does not know is a key the deploy would silently ignore.

The engine resolves a section over the chain of config files it loaded, nearest first, and by default merges a section key by key. Composer's section declares its own merge, which takes the nearest declaring file's section whole. A section therefore always comes from exactly one file, and that matters beyond tidiness: the deploy runs its infrastructure engine (Alchemy) in a second process, and the stack file generated for that process imports the declaring `prisma.config.ts` and reads its `composer` export. A section assembled from two files would have no single file to import.

That import is also why the command needs the declaring file, not only the section. The engine gives the validator the section's provenance, the files that declared it, nearest first, and the engine's own guidance is that a validator resolves what it needs from provenance and returns it in its value. So the validator returns `{ value, file: provenance.files[0] }`, and every command that declares the section receives the file without doing anything itself.

The second process imports the file for its descriptors, not for its values. It runs no adapter: the first process writes what its Load read from the app configuration to a configuration file, readable only by its owner and deleted when the run ends, and the stack file reads it from `@prisma/composer/internal/configuration-file`, an entry that is not public API. So an adapter is called once per run, a `.env` file edited during a deploy cannot change what is deployed, and a secrets manager is asked once.

What makes a section valid lives in one module that does not import the engine, because `@prisma/composer` must not depend on it. The validator calls that module and turns its findings into engine diagnostics. The programmatic operations call the same module at the start of the pipeline, before the entry is loaded and before any container, preflight or deploy engine runs: a host that drives a deploy from code evaluates `prisma.config.ts` itself and passes `config: { value, file }`, and gets the same refusals a CLI user would. Passing the whole export instead of its `composer` property is caught this way, with a fix that says so. One invariant cannot be checked in-process: the second process imports `file` and uses its `composer` export, while the first process uses `value`, so the two must be the same section. Checking it would mean evaluating the user's config file inside `@prisma/composer`, which is the private loader this decision removes.

The old setup is refused, not migrated. A project that still has only `prisma-composer.config.ts` gets `CONFIG.SECTION_MISSING` from the validator, which names the old file because the engine gives the validator no directory to look in when no file declares the section. A section that still carries the old `configPath` pointer gets `CONFIG.FIELD_RETIRED`. A declaring file with `prisma-composer.config.{ts,mts,mjs,js}` beside it gets `CONFIG.FILE_RETIRED`, from the validator on the CLI and from the pipeline's check in code, so an old file is never silently ignored. All three name the fix: move `extensions` and `state` into the section and delete the old file. Only that directory is checked; searching further would be guessing.

Moving evaluation into the engine also retired Composer's effect pre-flight. The pre-flight inspected the installed tree to explain a failed import of Alchemy as `DEPS.EFFECT_VERSION_CONFLICT`. Alchemy declares a loose peer range on `effect` (`>=4.0.0-rc.115 || >=4.0.0`), and a different `effect` hoisted into the app does break it at import time: `alchemy@2.0.0-beta.78` and `beta.79` fail to import with `effect@4.0.0-rc.118` and import cleanly with `rc.115` (checked 2026-09-30). But the `composer` section imports Alchemy through the extensions' `/control` entries, so a broken tree fails the moment the engine evaluates `prisma.config.ts`, with `CLI.CONFIG_UNREADABLE` naming the file and carrying the module error, before any Composer code runs. The case is rare, because the public packages pin every `effect`-family package Alchemy would otherwise float, and only the user's package manager can fix it. A failed import of an operation's executor is reported as `DEPS.EXECUTOR_UNLOADABLE` with the import error.

## Consequences

- `prisma.config.ts` is the only config file Composer reads. Examples and fixtures declare the section there, next to any `orm` section.
- The generated deploy and dev stack files import the declaring `prisma.config.ts` and pass its `composer` export to `lower()`. The second process evaluates the whole file, not only Composer's section: the imports of every section in it, such as the ORM's config module and `definePrismaConfig`'s package, run there with the second process's environment, and a failure in any of them fails the deploy. This is accepted because the section's descriptors are functions that cannot cross a process boundary, so the second process must import the file that built them.
- The second process reads the values the first process checked from the configuration file the first process names in `PRISMA_COMPOSER_CONFIGURATION_FILE`, and the node addresses it checked from `PRISMA_COMPOSER_NODE_ADDRESSES`. A stack file run by hand after the run ended cannot read the configuration file, because it is gone.
- `dev` reads the section once, at start, and watches the declaring file. After an edit it reports that the file changed and pauses rebuilds until it is restarted, so the two processes never run against different versions of the file. When what an adapter returns changes, it pauses the same way.
- `deploy`, `destroy`, `dev` and `log` on `@prisma/composer/control` take a required `config: ComposerConfigSource` and never look for a config file. Their `entry` input is optional and overrides `config.value.entry`. `log` reads only `value`; it takes the same input so a host builds it once.
- `@prisma/composer-cli/family` exports no `ComposerSection`; the section's value type is `ComposerConfigSource`, exported from `@prisma/composer/control`.
- A broken `effect` tree fails fast: it surfaces as the engine's `CLI.CONFIG_UNREADABLE` with exit code 2, not as a Composer code. `DEPS.EFFECT_VERSION_CONFLICT` does not exist.
- On the CLI, every section-level failure (`CONFIG.SECTION_MISSING`, `CONFIG.FIELD_RETIRED`, `CONFIG.FILE_RETIRED` and field errors) appears as a diagnostic under the engine's `CLI.CONFIG_SECTION_INVALID` headline. In code, the same `CONFIG.` code is the failure itself. An adapter that throws or returns something other than an object fails the command with `CONFIG.ADAPTER_FAILED` or `CONFIG.ADAPTER_INVALID`.
- `c12` is not a Composer dependency.
- The dependency-cruiser configuration excludes `prisma.config.ts` by name, so the `/control` imports in the section are not cruised, and [ADR-0028](ADR-0028-numbered-domains-and-layers-enforced-by-dependency-cruiser.md)'s constraint that examples, the website and tests import only the published packages does not cover the file that imports `/control` entries.

## Alternatives considered

- **Keep `prisma-composer.config.ts` and point to it from the section** (a `configPath` field): rejected. It keeps two files, two loaders and two discovery rules, which is the confusion this decision removes.
- **A schema-declared section** (`defineConfigSection({ schema })` with the engine's `reference()` helper): rejected. The engine's schema path does not reject unknown keys, emits `CLI.` codes rather than Composer's `CONFIG.` codes, and cannot give `configPath` its own migration message.
- **The engine's default per-key merge**: rejected. A section merged from several files has no single file for the generated stack to import.
- **Migrate the old file automatically**: rejected. Rewriting a user's `prisma.config.ts` is out of place for a deploy command; a refusal naming the exact change is deterministic and short.
- **The second process runs the adapters again**, which an earlier version of this decision did, with the requirement that an adapter return the same values for the same environment in both processes. Rejected: a `.env` file edited during the deploy, or an adapter whose answer changed, could deploy values the first process never checked, and a secrets manager was asked twice. The configuration file holds exactly what the first process checked.
- **Keep the effect pre-flight**: rejected for the reasons above. It would be a second, Composer-owned check for a failure the engine already reports, fixable only in the user's package manager.
- **An engine hook that lets a command family veto config evaluation with its own diagnostic**, so the effect check could run before the engine evaluates `prisma.config.ts`: rejected. It would be an engine extension point with one consumer.
- **Composer's commands load the config themselves, after running the effect check**: rejected. It has the same cost in practice, and only Composer's commands would benefit.
- **Run the effect check at import time inside `@prisma/composer/config`**: rejected. It depends on the import order in the user's file, and import sorters such as Biome's organize-imports put `@prisma/composer-prisma-cloud/control`, which loads Alchemy, before `@prisma/composer/config`.
- **Make the extensions' `/control` entries import Alchemy lazily**, so evaluating the config never loads it: rejected for now. Those entries import Alchemy and `effect` at module load in many files, so this is a refactor of the lowering layer.
- **Programmatic operations that find the config themselves**: rejected. It would need a private loader in `@prisma/composer`, which must stay free of the engine.
- **The handler recovers the declaring file by resolving the config chain again**: rejected. It repeats work the engine already did for the validator, and a command that forgot the call would silently skip the old-file check. The validator returns the file instead.

## Related

- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — the control-plane firewall this section carries.
- [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md) — the programmatic surface that takes the `config` input.
- [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md) — the `CONFIG` and `DEPS` namespaces.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) — the config and secrets adapters, the app configuration and the configuration file.
~~~

### 14.2 ADR-0058, rewritten

`docs/design/90-decisions/ADR-0058-prisma-dev-reads-secrets-from-the-environment-and-never-invents-them.md`. The file name stays, so links keep working.

~~~markdown
# ADR-0058: `prisma dev` reads secrets from the app secrets and never invents them

```ts
// prisma.config.ts
import { defineConfig as composer, dotenv, environmentVariables } from '@prisma/composer/config';
// …
composer({ /* … */ config: [dotenv(), environmentVariables()], secrets: [dotenv(), environmentVariables()] })
```

```text
$ prisma dev
prisma dev cannot start:

required secrets are not set:
  - STRIPE_SECRET_KEY  (required by service "billing": stripeKey must be present (was missing))

Set each missing variable where an adapter in prisma.config.ts reads it: the `secrets` list of the `composer` section for a secret, the `config` list for an env-sourced param. environmentVariables() reads the shell you run `prisma dev` from; dotenv() reads .env, .env.local, .env.dev and .env.dev.local beside prisma.config.ts.
```

## Decision

Under `prisma dev`, a secret's value comes only from the app secrets, and an env-sourced param's only from the app configuration ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). `prisma dev` reads both in its first process, from the adapters the `composer` section lists, at start and at each rebuild. By default both lists are `[environmentVariables()]`, the shell; `dotenv()` reads `.env` files. Composer never makes up a value and never reads one back from an earlier run.

- **A required secret that is unset or empty stops `prisma dev`.** The error lists every missing variable, the service that needs it, the schema's message, and where to set it. Empty counts as unset.
- **An optional secret that is unset or empty reaches the service as absent.** Its input has no value for that field, and the schema decides what that means, as it does for an unset `envParam` leaf ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)).
- **Required or optional is decided by validation, not by reading the schema.** For each service the dev preflight resolves the input binding with every unset secret left out and calls the schema's `validate`. If that passes, the missing secrets were optional. If it fails, the preflight checks each unset secret alone and names as required only the secrets whose absence alone fails. When no single secret fails alone, the error says the service needs some of them, and calls none of them required.
- **Env-sourced params get the same sourcing.** An unset or empty env-sourced param is always an error. Like secrets, params are read fresh each run and fingerprinted, so a changed value redeploys the services that read it.
- **The second process receives the values; it reads none.** `prisma dev` runs Alchemy in a second process at start and at each rebuild. That process runs no adapter. It reads the app configuration's checked values from a configuration file, readable only by its owner, which `prisma dev` deletes as soon as that converge ends. It receives each app secret an `envSecret()` in the graph names through its environment, in `PRISMA_COMPOSER_APP_SECRETS`, in memory; no secret is written to a file for it.
- **The dev preflight hands the second process a payload.** It travels on the preflight transport that carries deploy's rotation timestamps (`PRISMA_COMPOSER_PREFLIGHT_<extension>`), with a `dev:` prefix that a deploy payload, always a JSON object, never starts with. It names the absent secrets and carries a fingerprint of the current value of each variable that a service's input or params point at, never the value. The serializer leaves an `envSecret` leaf out of the input document only when this payload names it absent.
- **Each service gets only the variables its own rows point at**: the `$secret` pointers in its input document and its param pointer rows. A service that runs a dev server ([ADR-0056](ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md)) is given the same environment, and a changed value restarts it.
- **A changed value redeploys the services that read it.** Each `Deployment`'s triggers carry a `<name>:updatedAt` member per variable its rows point at. On a hosted deploy it holds the platform variable's `updatedAt`. Under `prisma dev` it holds the fingerprint from the payload: an HMAC-SHA256 of the value under a random 32-byte key that `prisma dev` creates once in `.prisma-composer/dev/<environment>/fingerprint.key` (mode 0600). Alchemy writes trigger members to its state as given, which is why the fingerprint is keyed: a bare hash of a short secret could be reversed by guessing. A lost key causes one redeploy, and `--fresh` deletes it.
- **A changed adapter value pauses rebuilds.** When what the adapters return at a rebuild differs from what they returned at start, `prisma dev` keeps the values it started with and stops rebuilding until it is restarted, as it does after an edit to `prisma.config.ts`.
- **Composer never reads a secret back from storage.** The `secrets.json` store in `.prisma-composer/dev/` is gone, and `prisma dev` deletes a leftover one when it starts.
- **Deploy is unchanged by this decision.** Deploy sends no dev payload, so the serializer leaves nothing out.

## Reasoning

An earlier local-dev decision ([ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)) gave an unset secret a minted placeholder, so that an app with a real external credential would still boot locally. In practice a service cannot tell a made-up value from a real key. A service that turns a feature on when its key is present turned it on with `local-placeholder-<hex>` and then failed in ways that pointed nowhere near the missing variable (prisma/composer#379). The stored value also never reached a service that was already deployed when the real value was set later (prisma/composer#380). Will rejected the placeholder model outright: users manage their environments themselves.

The user names where values come from, in `prisma.config.ts`, and Composer reads them there. Composer ships `dotenv()`, but the user still lists it, so the user still chooses the loader. Reading the adapters once, in the first process, means one read per run: the second process cannot see a value the first process did not check.

Without a made-up value, an unset secret has to be either an error or absent. Which one is the schema's call, because ADR-0042 already makes the schema the only judge of whether a field may be missing. Leaving the secret out and validating asks exactly that question, with the schema treated as a black box.

The second process needs the dev preflight's findings and the secret values, and it runs no adapter, so the first process hands them over: the findings on the existing preflight transport, the secrets in its environment, in memory. A file would leave secrets on disk if `prisma dev` were killed.

## Consequences

- An app whose required secret is unset locally stops with an error naming the variable. Optional secrets that are unset arrive absent.
- Changing a secret and running `prisma dev` again, without `--fresh`, restarts exactly the services whose rows point at it.
- A service receives only the secrets and env-sourced params its own input and params point at. Code that reads `process.env.X` directly, where `X` is bound by another service, gets nothing.
- **A value in `.env` or `.env.local` is read by every environment, including `prisma deploy` to `production`.** Deploy's preflight uploads any secret the target environment does not have yet, so a local-only value there becomes the hosted value. Put local-only values in `.env.dev` or `.env.dev.local`, which only the environment `dev` reads. A project that adopts `dotenv()` removes `import 'dotenv/config'` from `prisma.config.ts`, or `.env`'s values reach the shell's place in the order.
- Each environment's folder under `.prisma-composer/dev/` holds its own fingerprint key, mode 0600. Alchemy's local state holds HMAC fingerprints of secret values, never the values.
- The compute emulator keeps a copy of each running service's environment, secret values included, in its `instances.json` (mode 0600, in the machine-wide emulator directory, outside the project), so it can restart the service after the emulator itself restarts. Composer never reads that copy back. This is recorded in `.drive/deferred.md`.
- Dev and deploy write different input documents for the same app when an optional secret is unset: dev leaves the field out, as ADR-0042 promises for every env-bound leaf, and deploy writes a `$secret` pointer and fails when the platform lacks the variable. The deferred deploy fix in `.drive/deferred.md` would make the two the same.

## Alternatives considered

- **Keep placeholders.** Rejected: a made-up value is indistinguishable from a real one, and it hides the missing variable.
- **Make every unset secret an error.** Rejected: it contradicts ADR-0042, under which an optional field may be absent, and forces developers to invent values for features they do not use.
- **Decide required or optional by reading the schema.** Rejected: ADR-0042 forbids introspection.
- **A plain SHA-256 fingerprint.** Rejected: it lands in Alchemy's state inside the project, and a short or guessable secret can be recovered from it.
- **Values only from the run's environment variables, with `import 'dotenv/config'` in `prisma.config.ts` as the way to load `.env`**, which an earlier version of this decision chose, following the ORM's model. Replaced by the adapters: the user still chooses the loader by listing it, and `.env.<environment>` files keep a value meant for `dev` away from `production`.
- **Load `.env` in Composer itself, without the user naming a loader.** Rejected: it takes the choice of loader away from the user.
- **The second process runs the adapters again.** Rejected: it could read values the first process never checked, and ask a secrets manager twice.
- **Write the secrets the second process needs to a file.** Rejected: a killed `prisma dev` would leave them on disk.

## Related

- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md) — local dev runs the deploy pipeline against local providers.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — the input schema, the binding, and validation as the only judge of absence.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) — the secrets model.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) — the adapters, the app configuration and the app secrets.
- [local-dev.md](../10-domains/local-dev.md) and [running-locally.md](../../guides/running-locally.md).
~~~

### 14.3 ADR-0029, rewritten

`docs/design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md`. The file name stays.

~~~markdown
# ADR-0029: A secret is an environment-sourced value the framework never stores

```ts
// service.ts — the field's type says "a redacted value arrives here"
const authInput = type({ baseUrl: field(type('string')), signingKey: secretString() });
export default compute({ name: 'auth', input: authInput, /* … */ });

// module.ts — only the application names the platform variable
provision(auth, { input: { baseUrl: serviceOrigin('shop.web'), signingKey: envSecret('AUTH_SIGNING_KEY') } });

// inside the service — the value is redacted until asked for
const { signingKey } = service.input();     // SecretString
sign(payload, signingKey.expose());         // expose() is the one deliberate read
```

## Decision

A **secret** is a value the deployment reads from a platform variable **by name**, whose contents the framework never writes into deploy state, a file it generates, a log, the deploy report or an error. There is exactly one secret concept. A value the framework generates at deploy is a param ([ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md), [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)): it may live in deploy state and is not a secret.

Three pieces carry the model:

- **`envSecret('NAME')` is the source.** It names the platform variable to read. Only the application writes it, so a reusable module underneath stays free of any platform name. It returns a value, typed `RuntimeValue<SecretString>`, whose real value at deploy is a secret pointer ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). A module passes it on through a `secretString()` field of its `input` ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)). A `resolve()` function cannot list it.
- **`secretString()` is the type.** The field is typed as the framework's redacting `SecretString`. A binding is typed from the schema, so binding a plain value where the schema expects a secret fails to compile, and so does binding `envSecret()` where it expects a plain string. Where the compiler sees no type, such as a schema without type information or a cast, validation fails the deploy instead.
- **`service.input()` is the read.** It returns the whole validated input, secret fields as `SecretString` boxes. A box prints `[REDACTED]` from every stringify path (`toString`, `toJSON`, `valueOf`, `inspect`); `.expose()` is the one call that returns the value.

**The framework carries the name, never the value.** At deploy, the service's input document gets a pointer, the name of the platform variable, not its contents:

```json
{ "baseUrl": "https://app.example", "signingKey": { "$secret": "AUTH_SIGNING_KEY" } }
```

At boot the framework swaps each pointer for a redacting box over the named variable, which the platform injects into the running instance.

**Preflight fills a missing variable from the app secrets.** Before anything is provisioned, deploy preflight checks that every name an `envSecret()` in the graph names exists on the platform for the environment. A missing name is filled from the app secrets, what the `composer` section's `secrets` adapters return ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), with one write-only API call, never recorded as managed infrastructure. A name the app secrets lack fails the deploy early, listing what to set. Preflight fills only a variable that does not exist yet; to change one, change it on the platform.

**Composer redacts every secret it knows.** Everywhere it prints, including errors, an adapter's own failure message, the deploy engine's output and the engine's failure cause, Composer replaces with `[redacted]`: under every name an `envSecret()` in the graph names, the value in the app configuration and in the app secrets; and when a project writes its own `secrets` list, every value it returns. A known value is redacted at any length. The deploy engine runs in a second process. The CLI's command engine passes that process's output through Composer's redactor before it prints it, and the redactor holds back the end of each chunk until the next one, so a secret split across two chunks of output is caught too. Composer also still redacts what it redacted before this decision: an app configuration value of eight characters or more under a name that looks like a credential, bearer and basic tokens, JWTs, a password in a URL and `token=` pairs. That is existing behaviour, kept until secrets get a home apart from plain values.

**The need lives in core and the source in the target.** Core's `secretSource(payload, { label, secretsKey })` builds a source from a target's payload, and never reads the payload. `secretsKey` is the app secrets key that holds the secret's value; Composer redacts the value under it, and `prisma dev` hands it to its second process. Prisma Cloud's `envSecret('NAME')` validates the name, brands the payload, and passes `secretsKey: NAME`. A different target could ship `vaultSecret({ path, key })` with no change to core.

## Reasoning

**Why redaction is a type, not a flag.** A `secret: true` flag on an ordinary value makes every place that touches config responsible for remembering to redact. Typing the field as `SecretString` moves the guarantee into the type: redacted by default, with `expose()` marking the one place code means to read it.

**Why names cross the boundary and values do not.** The deploy machine, the generated deploy program and deploy state are all things we inspect, diff and sometimes print; none was built to hold a secret. Rather than teach each to guard a value, the framework carries the platform variable's name and lets the platform inject the value into the running instance.

**Why Composer also redacts by value.** A secret's value still passes through Composer's process: preflight reads it to fill a missing variable, and `prisma dev` hands it to local services. An adapter's error, the deploy engine's output or a cause chain could carry it. So Composer replaces every value it knows a secret holds, wherever it prints. It cannot replace a secret it was never told about, which is why the set is the values the graph's `envSecret()`s name and the values a project's own secrets list returns; replacing every value in the shell would blank every `1` and `true`.

**Why the application binds the name.** If a reusable module hard-coded the variable it reads, every application using it would be forced onto that one name. A module that takes a `secretString()` field and lets its caller bind it stays reusable.

**Why a secret is environment-sourced, and generated values are not secrets.** A secret's value stays out of deploy state because someone else, the operator or the platform, holds it. A value the framework produces at deploy has no external holder; it must be stored to be stable, so it is a param, which may be redacted for display.

## Consequences

- Every framework-written variable carries a reserved `COMPOSER_` prefix, so it can never overwrite a variable the user provisioned.
- A secret field is required unless the schema makes it optional; presence is the schema's call.
- Rotation is: change the value on the platform, then redeploy. A running instance's environment is frozen when the instance is created.
- Two input fields that normalize to the same platform variable name are a deploy error, so a secret and a generated param never share a variable.
- A name may not be read both by `envParam()` and by `envSecret()`: Load refuses it, because the deploy hands its second process every plain value it reads, in a file.
- A short secret is redacted at any length, so a one-character secret blanks that character in everything Composer prints.

## Alternatives considered

- **A forwardable `secret()` slot on modules**, which this decision first described as the need a module declares and its parent binds. Replaced by a `secretString()` field of the module's `input` ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).
- **A `resolve()` function that receives the secret's source**, which an earlier version of the values decision allowed. Rejected: a function cannot compute anything useful from a value the deploy does not have.
- **Filling a missing variable from the deploying shell only.** Replaced by the app secrets, whose default, `[environmentVariables()]`, is the shell.
- **Redacting only values of eight characters or more.** Rejected for known secrets: a secret Composer knows is redacted at any length. The minimum stays for values Composer only guesses are credentials from their names, which is the existing behaviour this decision keeps for now.

## Related

- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — the one-schema input model a secret field lives in.
- [ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md) — a generated param, which is config, not a secret.
- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md) and [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) — module input, values, and the adapters.
- [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-environment-and-never-invents-them.md) — how `prisma dev` reads secrets.
- [config-params.md](../10-domains/config-params.md).
~~~

### 14.4 ADR-0032, rewritten

`docs/design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md`. The file name stays.

~~~markdown
# ADR-0032: Params bind at provision; env-sourcing is a target-owned source

```ts
// 1. The service declares the param: a schema, no value, no platform name.
const web = compute({ name: 'web', params: { appOrigin: string() }, build: /* … */ });

// 2. The application binds it at provision: a literal, or envParam().
export default module('app', ({ provision }) => {
  provision(web, { params: { appOrigin: envParam('APP_ORIGIN') } });
  // …or a literal: { params: { appOrigin: 'https://example.com' } }
});

// 3. Inside the service, the value reads back like every other param.
const { appOrigin } = web.config();   // string
```

## Decision

A service's per-key param can be bound at `provision()` to a literal or to a target-owned source such as `envParam('NAME')`, instead of only carrying an authoring-time `default`. An env-sourced param is the plain sibling of [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md)'s secret: the same name-carried source, the same per-environment platform variable, the same preflight, but read back unredacted and validated by the param's own schema.

`envParam('NAME')` returns a value, typed `Value<string>`, that is also the source ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). It reads `NAME` from the app configuration, what the `composer` section's `config` adapters return. Where it sits decides when:

- **In a service's per-key params**, the deploy writes a pointer row naming the platform variable. Preflight fills a missing variable from the app configuration. The service reads the variable at boot.
- **In a service's `input`**, the deploy writes the text into the service's input document. An unset or empty value leaves the key out, and the schema decides.
- **In a module's `input` or as a `resolve()` dependency**, Load reads the text as the value's real value. An unset or empty value has none: in a binding the key is left out, and listed in `resolve()` it fails the Load, naming the variable.

The value must be text; anything else fails the Load, naming the key and the kind of value, before anything is created. Core knows a source only as an opaque payload; `paramSource(payload, { label, configurationKey, redacted })` is the constructor a target calls. `configurationKey` is the app configuration key whose text is the source's real value at deploy; `redacted` makes a source known only at boot a secret pointer rather than a plain one. Prisma Cloud's `envParam('NAME')` passes `configurationKey: NAME`.

The deploy reads the app configuration once, in its first process, and hands its second process the text of every key the graph reads, in the configuration file ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).

## Reasoning

**Why provision-time binding at all.** A param's only source of a value used to be its authoring-time `default`. That made per-environment configuration impossible without editing the service's own source. Binding at `provision()` puts the value where the composition decision is made: the service declares what it needs, the application decides what it is worth or where it comes from. A binding beats the `default`; the `default` is the fallback when nothing is bound; a param that is neither optional, defaulted nor bound fails the deploy, naming the param, the service and the fix. A service's own platform-assigned origin is not operator input: the target resolves it ([ADR-0039](ADR-0039-a-compute-services-own-origin-is-a-target-resolved-property.md)).

**Why the source constructor is the target's.** Core forwards a `ParamSource` and never reads its payload. `envParam('NAME')` ships with `@prisma/composer-prisma-cloud`, as `envSecret` does. This is [ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md) and [ADR-0019](ADR-0019-the-target-owns-config-serialization.md)'s split between declaration and encoding, applied to where a value comes from.

**The wire: a pointer, told apart by shape.** An env-sourced param's stored row carries the platform variable's name, not a value. It shares its key, `COMPOSER_<address>_<name>`, with a literal-bound param, so writer and reader tell them apart by the stored value. Literal values are JSON-encoded; a pointer row is `@composer-param-pointer:<NAME>`. No `JSON.stringify` output begins with `@`, so the two never collide.

**Boot: double lookup, then the schema, on the raw string.** Boot reads the pointer for the name, reads that platform variable, and hands the raw string to the param's own schema. A `number()` param bound to `envParam` fails at boot with the existing invalid-value error, because the variable is a string. An unset platform variable is a boot error naming the param, the pointer key and the variable. An empty string is a value, which reaches the schema like any other.

**Preflight covers env-sourced params as it covers secrets.** Before anything is provisioned, the deploy checks that every env-sourced param's platform name exists for the environment, fills a missing one from the app configuration with one write-only call, and fails early, listing the names, when the app configuration lacks it too.

## Consequences

- A provision-time literal is schema-validated when config is built, and beats the `default`.
- A required param that nothing binds fails the deploy loudly.
- Env-sourced params are strings at the boundary. Decoding before the schema, per ADR-0019, is an additive change if a real consumer needs it.
- A value change needs a redeploy: a compute version snapshots its environment at creation.
- The `@composer-param-pointer:` prefix is reserved only in raw stored-row space, which literals never occupy.
- A name may not be read both by `envParam()` and by `envSecret()`; Load refuses it.

## Alternatives considered

- **A fourth accessor (`env()` or `platformConfig()`).** Rejected: it keys the read on provenance, forcing consumers to know how the application bound the value.
- **Restricting env-sourced params to string-output schemas at authoring.** Rejected: it needs schema inspection, which Standard Schema does not offer portably, to prevent a failure boot already reports.
- **A separate pointer key per param.** Rejected: it doubles the rows and leaves the primary key's meaning ambiguous.
- **Reusing the secrets channel for env-sourced params.** Rejected: it would wrap plain config in redaction and impose the non-empty constraint.
- **`paramNeed()` slots on modules**, which this decision first described as the way a module forwards a param binding. Replaced by fields of the module's `input` ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).
- **Reading `NAME` from the deploying shell.** Replaced by the app configuration, whose default, `[environmentVariables()]`, is the shell.
- **A `sentinel` option on `paramSource()`**, a stand-in value schemas checked in place of a pointer. Replaced by pointers, which schemas see as they are ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).

## Related

- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) — the secret this mirrors.
- [ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md) — framework-minted param values, which live in deploy state.
- [ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md) and [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — schema on the declaration, wire owned by the target.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) — values and the app configuration.
- [config-params.md](../10-domains/config-params.md).
~~~

### 14.5 ADR-0044, rewritten

`docs/design/90-decisions/ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md`. The text below keeps every statement of the current record, folds its three amendment notes into the registry, adds `DEPS.CLI_ENGINE_INCOMPATIBLE`, and replaces "A structured error is never transformed" with the one transformation this PR adds, redaction.

~~~markdown
# ADR-0044: Errors are structural envelopes with dotted namespace codes

## The shape of a failure, end to end

The site that detects a failure builds the complete error, because it is the only place that knows the context:

```ts
// @internal/assemble — a raise site
if (!descriptor) {
  throw new AssembleError('ASSEMBLE.DESCRIPTOR_MISSING', `No deploy descriptor for "${address}"`, {
    why: `Extension "${extensionName}" declares no descriptor for this service kind.`,
    fix: 'Add a deploy descriptor to the extension, or remove the service from the graph.',
    meta: { address },
  });
}
```

Every in-process consumer — the CLI's own adapters, a host driving `@prisma/composer/control` — branches on exactly two fields, for every operation (a `Result` never crosses a process boundary; CI and other out-of-process consumers see the rendered envelope on stderr and the exit code instead):

```ts
const result = await deploy(options);
if (!result.ok) {
  switch (result.failure.code) {
    case 'ASSEMBLE.DESCRIPTOR_MISSING': /* actionable: fix the extension */
    case 'DEPS.EXECUTOR_UNLOADABLE': /* actionable: fix the install */
    default: /* render the envelope; exit 2 */
  }
}
```

Between the two snippets a structured error changes in one way only: before an operation returns it, Composer removes every secret value it knows from its summary, `why`, `fix` and `meta`, and drops its cause, which holds the same text unredacted ([ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md)). Its code, severity, `where` and docs link are the ones raised at the origin. A foreign error (a rejecting build, a throwing extension hook) is wrapped exactly once, at the site that understands it, into a structured error carrying the original as `cause`.

## Decision

Composer uses the shared CLI error foundation (prisma/prisma's ADR 239 / ADR 245 lineage), carried in `@internal/foundation`:

- Every user-surfaced failure is a **`CliStructuredError`**: `code` is a dotted `NAMESPACE.SUBCODE` string, `message` is the summary, and the optional `why`/`fix`/`where`/`meta`/`docsUrl` fields complete the envelope (`toEnvelope()` serializes it). The namespace prefix is the error's category; there is no separate `domain` field.
- **Errors are structured at their origin; there are no catch-all codes.** A library type meant to surface (core's `LoadError`, assemble's `AssembleError`, a config-evaluation failure, an I/O failure the tool can name) is a structured error where it is raised. Site-specific wraps of foreign causes (an extension hook, an adapter, the environment) are legal and attach the original as `cause`; boundary fallbacks like "pipeline failed" are banned.
- **Bugs carry no code.** A non-structured error reaching a process boundary is by definition a bug: the CLI prints `Error: <message>` plus a report hint and exits 1. `InternalError` marks known invariants; nothing maps bugs onto the user-facing taxonomy. Its message is redacted like any other output.
- **Recognition is structural, never nominal.** `CliStructuredError.is()` duck-types on `name`/`code`/`toEnvelope`, so copies of the class in different packages and processes interoperate. Subclasses (`LoadError`, `AssembleError`) must not override `name`. A redacted error is a plain `CliStructuredError` with the original's code, so a consumer branches on `code`, never on the subclass.
- **Operation results ride one discriminator: `ok`.** The `./control` operations return the shared `Result` shape, `{ ok: true, value } | { ok: false, failure }`, with `CliStructuredError` as the failure. Bespoke per-operation outcome enums are banned; the success payload's type carries the operation-specific shape. A `Result` is in-process only (frozen, getter-backed; not JSON-serializable).

## The closed namespace list

Namespaces are closed and concern-shaped; each has one owning module (which may delegate). Namespaces raised below the CLI layer are legal: codes are vocabulary, not import edges.

| Namespace | Concern | Owning module (delegates) |
| --- | --- | --- |
| `CONFIG` | shape and coverage of the `composer` section of prisma.config.ts, its adapters, and the refused old config file | composer-config.ts (family/section.ts, pipeline.ts, validate-coverage.ts, app-configuration.ts) |
| `COMPOSE` | topology loading: entry, root node, graph shape, naming | pipeline.ts (load-entry.ts, core's graph modules) |
| `ASSEMBLE` | assembling each service's deploy artifact | `@internal/assemble`'s assemble-services.ts |
| `DEPLOY` | target selection, environment, containers, preflight, engine, teardown, generated files | operations/execute-deploy-destroy.ts (validate-environment.ts, run-alchemy.ts, alchemy-bin.ts) |
| `DEV` | local dev pipeline and session, and the commands on the app it recorded | operations/execute-dev.ts (core/control/local-target.ts, operations/execute-dev-current.ts, `@internal/dev-emulators`) |
| `LOG` | log attach and tail | operations/execute-log.ts |
| `DEPS` | the consumer's installed dependency tree | operations/shared.ts, operations/execute-deploy-destroy.ts, family/converge.ts |

Closed subcode registry:

- `CONFIG` — SECTION_MISSING, FIELD_INVALID, FIELD_UNKNOWN, FIELD_RETIRED, FILE_MISSING, FILE_RETIRED, EXTENSION_DUPLICATE, EXTENSION_MISSING, DESCRIPTOR_MISSING, DESCRIPTOR_KIND_MISMATCH, ENTRY_MISSING, ADAPTER_FAILED, ADAPTER_INVALID *(EXPORT_INVALID, PATH_MISMATCH and EVALUATION_FAILED retired by [ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md))*. ENTRY_MISSING: neither `entry` in the `composer` section nor `--entry`, or the operation's `entry` input, names the entry module. ADAPTER_FAILED: a config or secrets adapter threw or rejected; its message is redacted. ADAPTER_INVALID: an adapter returned something other than an object of values, or a secrets adapter returned a value that is not text.
- `COMPOSE` — ENTRY_UNLOADABLE, ENTRY_EXPORT_INVALID, ROOT_NOT_MODULE, NAME_MISSING, GRAPH_INVALID
- `ASSEMBLE` — EXTENSION_MISSING, DESCRIPTOR_MISSING, DESCRIPTOR_KIND_MISMATCH, SERVICE_MISSING, BUILD_FAILED
- `DEPLOY` — FLAG_INVALID, TARGET_CONFLICT, TARGET_MISSING, TARGET_NOT_FOUND, ENVIRONMENT_INVALID, ENVIRONMENT_UNVALIDATABLE, ENVIRONMENT_REQUIRED, CONTAINER_FAILED, PREFLIGHT_FAILED, ENGINE_FAILED, TEARDOWN_FAILED, CONTAINER_REMOVE_FAILED, BUILD_REQUIRED, ALCHEMY_BIN_MISSING, NODE_MISSING, STACK_WRITE_FAILED *(STAGE_INVALID, STAGE_UNVALIDATABLE and SCOPE_MISSING retired by [ADR-0059](ADR-0059-a-deployment-environment-is-called-an-environment.md))*. ENVIRONMENT_REQUIRED: a `destroy` call names no environment. STACK_WRITE_FAILED covers the configuration file as well as the stack file. `prisma dev` starts the deploy engine the same way `deploy` does, so it raises ALCHEMY_BIN_MISSING and NODE_MISSING under `DEPLOY` too.
- `DEV` — PLATFORM_UNSUPPORTED, TARGET_UNSUPPORTED, CONTAINER_FAILED, TEARDOWN_FAILED, PREFLIGHT_FAILED, EMULATOR_FAILED, SERVICE_START_FAILED, CONVERGE_FAILED, ATTACH_FAILED, STACK_WRITE_FAILED, EMULATORS_DIR_INVALID, EMULATOR_UNREACHABLE, SERVICE_READY_TIMEOUT_INVALID, NOT_STARTED_HERE, ADDRESS_UNKNOWN, NOT_RUNNING. EMULATOR_UNREACHABLE is raised by the emulator client when it cannot connect, so `log` raises it under `DEV` too; for a connection failure it takes the place of SERVICE_START_FAILED, ATTACH_FAILED and `LOG.ATTACH_FAILED`. `devUrl` also raises it when the emulator a node runs on is not running. NOT_STARTED_HERE (no `prisma dev` has recorded an app in the directory) is raised by `devUrl` and `devStop`; ADDRESS_UNKNOWN (the recorded app has no node at that address; the known addresses are listed) and NOT_RUNNING (the node exists but is not running; its state is named, and the reason and fix depend on it) by `devUrl` alone ([ADR-0053](ADR-0053-dev-url-dev-stop-and-emulator-list.md)). Both operations raise EMULATOR_FAILED when the local target fails without a code. `emulator list` fails only with EMULATORS_DIR_INVALID; an emulator it cannot list is reported in that emulator's entry with EMULATOR_UNREACHABLE or EMULATOR_FAILED.
- `LOG` — PLATFORM_UNSUPPORTED, ATTACH_FAILED, ADDRESS_UNKNOWN
- `DEPS` — EXECUTOR_UNLOADABLE, EXTENSION_INCOMPATIBLE, CLI_ENGINE_INCOMPATIBLE *(EFFECT_VERSION_CONFLICT retired by [ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md))*. EXTENSION_INCOMPATIBLE: an installed extension is older than the Composer running the deploy or destroy, so the container it resolved, rebuilt through its own `deserialize`, does not name the environment that was asked for. CLI_ENGINE_INCOMPATIBLE: the `prisma` CLI running `prisma deploy` or `prisma dev` has a `@prisma/cli-engine` older than 0.10.0, which cannot pass the deploy engine's output through Composer's redactor; it is raised before anything starts.

Adding a subcode is an edit to this list; adding a namespace is an edit to this record.

## Exit codes and the human layout

The exit-code convention is the shared one (prisma/prisma's CLI Style Guide), and it governs statuses the CLI itself generates: `0` OK, `1` internal error/bug only, `2` expected failure (usage errors and structured failures alike), `3` user abort, `130`/`143` signals.

**Documented exception:** when the spawned deploy engine (Alchemy) exits nonzero, the CLI prints the two reproduce-hint lines and passes the child's own exit status through unchanged. The child's status is the operator's signal, and renumbering it would erase information. A passthrough status is the child's number, not a statement in the CLI's own code space: an expected engine failure may therefore surface as `1` (or any other value) without contradicting the convention above.

The human rendering of an envelope (`render-error.ts`) is the shared layout:

```text
✖ <summary> (<CODE>)
  Why: <why>
  Fix: <fix>
  Where: <path>[:<line>]
```

## Reasoning

The `code` is the machine-branching surface: hosts driving `@prisma/composer/control`, agents, and CI branch on `failure.code` instead of parsing message strings. Structuring at origin keeps every raise site honest (the site that knows the context supplies the why and fix), and banning fallback codes makes an unnamed failure loud (a bug, exit 1) instead of hiding it behind a vague catch-all. Structural recognition is what lets Composer's copy of the foundation interoperate with any other copy of it. Redaction is the one change between origin and consumer, because the origin, often an adapter or the deploy engine, does not know which values are secrets, and the operation does.

## Consequences

- The registry above is the failure taxonomy. A coarse "which stage failed" view is derivable from the namespace prefix; no separate stage discriminant is stored on failures.
- An engine failure carries `meta.diagnostics` (exit code, generated stack-file path, reproduce command, cwd), read via the `executionDiagnostics()` helper: details of the current mechanism, outside the durable contract.
- Exit codes distinguish a bug (1) from an expected failure (2); "any nonzero means failure" consumers are unaffected either way.
- A failure's `cause` does not reach a consumer of an operation, because it would carry unredacted text.

## Alternatives considered

- **A separate `domain` field alongside the code**: rejected (as in prisma/prisma's ADR 239): one field fewer, and the namespace carries the same information.
- **Renumbering the Alchemy child-status passthrough onto the 2=failure convention**: rejected: the child's own exit status is information the operator and CI already use.
- **Per-command fallback codes (`*.PIPELINE_FAILED`)**: rejected: a failure worth surfacing gets its own code at its origin.
- **A stored per-operation `kind` discriminant on failures**: rejected: a second vocabulary restating what the namespace prefix and the `ok` discriminator already say.
- **`instanceof` recognition**: rejected: it breaks across duplicated copies, plane splits and JSON boundaries.
- **Never transforming a structured error between origin and consumer**, which this record first said. Rejected for redaction only: an adapter's or the engine's message can hold a secret, and only the operation knows which values are secrets.

## Related

- prisma/prisma's [ADR 239](https://github.com/prisma/prisma/blob/main/docs/architecture%20docs/adrs/ADR%20239%20-%20Errors%20are%20structural%20envelopes%20with%20dotted%20namespace%20codes.md) and [ADR 245](https://github.com/prisma/prisma/blob/main/docs/architecture%20docs/adrs/ADR%20245%20-%20Errors%20are%20structured%20at%20origin%3B%20results%20carry%20one%20ok%20discriminator.md): the parents of this record.
- [ADR-0043](ADR-0043-the-control-subpath-is-the-programmatic-deploy-surface.md): the programmatic surface these failures cross.
- [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md): the spawned child behind the exit-status exception.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md): what Composer redacts.
~~~

### 14.6 ADR-0062, edited

`docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md`. Each quoted string is replaced exactly:

1. `read from the configuration (below)` → `read from the app configuration (below)`.
2. `- The merged result of the config adapters is **the configuration**.` → `- The merged result of the config adapters is **the app configuration**. "App" is what Composer calls the application, the outermost module, whose input it fills.`
3. `- The merged result of the secrets adapters is **the secrets**.` → `- The merged result of the secrets adapters is **the app secrets**.`
4. `The secrets never reach Load or a schema.` → `The app secrets never reach Load or a schema.`
5. `so the configuration must satisfy the root's schema` → `so the app configuration must satisfy the root's schema`.
6. `It holds only what the graph reads from the configuration:` → `It holds only what the graph reads from the app configuration:`.
7. `` `prisma dev`'s second process receives the configuration the same way`` → `` `prisma dev`'s second process receives the app configuration the same way``.
8. In § The root's input: `the root's binding is the configuration.` → `the root's binding is the app configuration.`; `By default the configuration holds every variable` → `By default the app configuration holds every variable`; `The configuration never holds a pointer` → `The app configuration never holds a pointer`; `because the configuration is plain` → `because the app configuration is plain`.
9. In the **Redaction.** bullet, `Under the default list only the first kind applies, because redacting every value in the shell would blank every \`1\` and \`true\` in the output.` → `Under the default list only the first kind applies, because redacting every value in the shell would blank every \`1\` and \`true\` in the output. Composer also keeps the redaction it already did, which is not part of this decision: an app configuration value of eight characters or more under a name that looks like a credential, and token shapes such as JWTs.`
10. The **The second process's output** bullet becomes: `- **The second process's output** passes through Composer's redactor. The CLI's command engine pipes the second process's stdout and stderr, passes each through a transform Composer gives it, and prints the result where it would have printed the output. The redactor holds back at most one fewer character than the longest secret, and never a complete line when no secret holds a line break, so a secret split across two chunks of output is still caught. The second process has no terminal, so Alchemy's progress display and colours change.`
11. In § Consequences: `- **The configuration is plain.**` → `- **The app configuration is plain.**`.
12. In the **`dotenv()`** bullet, `` `dotenv-flow`'s `.env.defaults` file is not read. `` → `` `dotenv-flow` lists its `.env.defaults` file first whenever it is given its own default pattern, so `dotenv()` drops that file from the list and never reads it. ``
13. After the sentence `It holds no secrets.` in the configuration file paragraph: `Load refuses a name that both an \`envParam()\` and an \`envSecret()\` read, because the file would then hold that secret.`
14. In § Keeping secrets out, after the **Redaction.** bullet, a new bullet: `- **Core knows each secret's name.** A target's secret source tells core which app secrets key holds its value: \`secretSource()\` takes \`secretsKey\`, and \`envSecret('NAME')\` passes \`NAME\`. That is how Composer knows what to redact, and which secrets \`prisma dev\` hands its second process.`

`git grep -n -E 'the configuration[^ ]? |the secrets[^ ]? ' docs/design/90-decisions/ADR-0062*` afterwards shows only "the configuration file", "the secrets adapters", "the `config` adapters" and "the secrets manager".

### 14.7 The decision index, `docs/design/90-decisions/README.md`

Each whole line, from `- [ADR-00NN](` to the end of the line, becomes:

```markdown
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) — A secret is a value the deployment reads from a platform variable by name, whose contents the framework never writes into deploy state, a generated file, a log, the deploy report or an error. A service types the field `secretString()`; the application binds it with `envSecret('NAME')`, a value whose real value is a secret pointer; the service reads a redacting `SecretString`. The input document carries `{ "$secret": NAME }`; preflight fills a missing platform variable from the app secrets with a write-only call. Composer redacts every secret it knows wherever it prints, at any length, including the deploy engine's output, which the CLI's command engine passes through Composer's redactor. `secretSource()` takes a `secretsKey`, the app secrets key that holds the value.
- [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md) — A service's per-key param can be bound at `provision()` to a literal or to a target-owned source such as `envParam('NAME')`, which reads `NAME` from the app configuration: a pointer row in params, filled by preflight and read at boot; the text in a service's input document; the real value in a module's input or a `resolve()`. Non-text fails the Load. `paramSource()` takes `configurationKey` and `redacted`.
- [ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md) — Errors are structural envelopes with dotted `NAMESPACE.SUBCODE` codes from a closed registry, structured at origin with why/fix splits, no catch-all codes; bugs carry no code (exit 1); recognition is structural; operation results ride the `Result` `ok` discriminator; expected failures exit 2, with the deploy engine's status passed through. The one change between origin and consumer is redaction of known secrets, which also drops the cause.
- [ADR-0049](ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md) — Composer's configuration is the `composer` section of `prisma.config.ts`, loaded by the Prisma CLI engine: `extensions`, `state`, and optional `entry`, `config` and `secrets` adapter lists. The validator checks only what identifies each value, passes the file's own objects through, never calls an adapter, rejects unknown keys, takes the nearest declaring file's section whole, and returns `{ value, file }`; the programmatic operations take the same input. The old config file is refused, not migrated. Only the first process runs adapters; the second process imports the file for its descriptors and reads the checked values from a configuration file.
- [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-environment-and-never-invents-them.md) — Under `prisma dev` a secret comes from the app secrets and an env-sourced param from the app configuration, read once per run in the first process; Composer never invents a value or reuses one. A required secret that is missing stops dev; an optional one arrives absent, decided by validation. The second process reads the checked configuration from a file deleted after each converge and receives the secrets its services need through its environment, never a file. Fingerprints of values on the preflight transport redeploy exactly the services whose value changed.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) — The graph's structure is the same whatever inputs Composer is given; only values differ per environment. A module body holds values (`Value<T>`), opaque stand-ins for data known later: deploy-time values, whose data the deploy has by the end of Load, and runtime values (`RuntimeValue<T>`, which is `Value<Pointer<T>>`), whose data only the platform holds. `resolve(dependencies, fn)` computes a value from deploy-time values only; `fn` never sees a pointer. Config adapters produce the app configuration, which is the root's input and what `envParam()` reads; secrets adapters produce the app secrets, which fill missing `envSecret()` platform variables. Both lists default to `[environmentVariables()]`; `dotenv()` reads `.env` files through `dotenv-flow`. Only the first process runs adapters; the second reads a configuration file and refuses a graph whose node addresses differ. Secrets stay out through pointers and redaction. Every environment has a name and none is special.
```

### 14.8 Glossary, `docs/design/03-domain-model/glossary.md`

1. The three entries `### Config pool`, `### Secrets pool` and `### Config adapter`, with their paragraphs, are replaced by these four:

   ```markdown
   ### The app configuration

   The merged values the `config` adapters return for the environment, a later adapter winning by top-level key. "App" is what Composer calls the application, the outermost module, whose input it fills. It is the root module's input, checked by the root's schema, and what an `envParam('NAME')` reads `NAME` from, wherever it sits; the name a source reads is its **configuration key** (`paramSource()`'s `configurationKey`). With no `config` list it is the process environment, secrets included, so only the root fields its body passes on by name reach the graph. Only a command's first process reads it; the deploy's and `prisma dev`'s second process reads what the first checked from the **configuration file**, readable only by its owner and deleted when the run ends. In code: `AppConfiguration`, `LoadOptions.configuration`.

   ### The app secrets

   The merged values the `secrets` adapters return, text only. Deploy preflight fills a missing `envSecret()` platform variable from it, and `prisma dev` hands its second process the values the graph's `envSecret()`s name, through that process's environment. Composer never passes it to Load or a schema, never writes its values to a file, and redacts them wherever it prints. With no `secrets` list it is the process environment. In code: `AppSecrets`.

   ### Config adapter

   A function in the `config` list of the `composer` section. It receives the environment's name and the directory of `prisma.config.ts`, and returns that environment's values, which merge into the app configuration. `environmentVariables()` and `dotenv()` ship with Composer; `dotenv()` reads `.env` files through `dotenv-flow`. An adapter is a mechanism, not a setting: the values stay wherever it reads them ([ADR-0062](../90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)).

   ### Secrets adapter

   A function in the `secrets` list of the `composer` section, with the same shape as a config adapter. What the secrets adapters return merges into the app secrets; every value must be text. When a project writes its own `secrets` list, Composer redacts every value it returns.
   ```

2. Every link `(#config-pool)` becomes `(#the-app-configuration)`, `(#secrets-pool)` becomes `(#the-app-secrets)`, and `(#config-adapter)` is unchanged. The `envParam(NAME)` bullet's `the deploy reads \`NAME\` from its [config pool](#config-pool)` becomes `the deploy reads \`NAME\` from the [app configuration](#the-app-configuration)`.
3. The **Value** entry's `A root's input is the config pool.` (added by S9) becomes `A root's input is the [app configuration](#the-app-configuration).`
4. The environment entry's `` `dotenv()` reads `.env.<environment>` for the environment being deployed.`` becomes `` `dotenv()` reads `.env.<environment>` for the environment being deployed, and skips `.env.local` for the environment `test`.``

### 14.9 Domain docs

1. `docs/design/10-domains/deploy-cli.md`:
   - `It reads the config pool, because Load validates the root's input; it reads no secrets.` → `It runs the config adapters, because Load checks the root's input; it reads no secrets.`
   - Pipeline step 4 becomes one line: `4. **Read the app secrets and the app configuration.** For \`deploy\` the CLI first calls the \`secrets\` adapters, then for every command the \`config\` adapters, in list order, each awaited, and merges what each list returns by top-level key, a later adapter winning. Both lists default to \`[environmentVariables()]\`. The app configuration is Load's input: the root's input and what \`envParam()\` reads. The app secrets are held in memory for preflight. Every secret value read is recorded for redaction. An adapter that throws or returns something other than an object fails with \`CONFIG.ADAPTER_FAILED\` or \`CONFIG.ADAPTER_INVALID\`. No other process runs an adapter.`
   - Step 5's `config pool as the root's input` → `app configuration as the root's input`.
   - `The generated stack file reads the config pool again, from the same adapters; it never reads the secrets pool.` → `Beside it the CLI writes the configuration file, \`.prisma-composer/configuration-<pid>-<uuid>.json\`, mode 0600, holding what Load read from the app configuration, and deletes it when the run ends. The second process reads it, runs no adapter, and refuses a graph whose node addresses differ from the list the CLI passes in \`PRISMA_COMPOSER_NODE_ADDRESSES\`. It never receives the app secrets. The CLI engine passes its output through Composer's redactor, which replaces every secret value the CLI knows, before it prints it.`
   - The error table row `| Root's input refused by its schema | the schema's messages, and that a root's input is the config pool for the environment |` → `| Root's input refused by its schema | the schema's messages, and that a root's input is the app configuration for the environment |`. A new row after the adapter row: `| The prisma CLI's engine is older than 0.10.0 (\`DEPS.CLI_ENGINE_INCOMPATIBLE\`) | that Composer needs @prisma/cli-engine 0.10.0 or later to redact the deploy engine's output, and nothing was started |`.
2. `docs/design/10-domains/local-dev.md`:
   - The second note at the top, `> Amended by the module-input project (2026-10-30): …`, is removed; its content is in the body below.
   - The table rows: `| \`envParam\` sources (ADR-0032) | the config pool, same names; …` → `| \`envParam\` sources (ADR-0032) | the app configuration, same names; …` (the rest of the row unchanged); `| secrets (ADR-0029, ADR-0058) | the secrets pool: by default the shell, …` → `| secrets (ADR-0029, ADR-0058) | the app secrets: by default the shell, …`.
   - `The local \`Deployment\` provider reads current values from the pools the dev stack file read and gives each service only the variables its own input and params point at.` → `The dev second process runs no adapter. It reads the checked values of the app configuration from \`.prisma-composer/dev/<environment>/configuration.json\`, which \`prisma dev\` writes before each converge and deletes after it, and receives the app secrets the graph's \`envSecret()\`s name in \`PRISMA_COMPOSER_APP_SECRETS\`. The local \`Deployment\` provider gives each service only the variables its own input and params point at.`
   - `It reads \`.env\`, \`.env.local\`, \`.env.<environment>\` and \`.env.<environment>.local\` beside \`prisma.config.ts\`.` → `It reads \`.env\`, \`.env.local\`, \`.env.<environment>\` and \`.env.<environment>.local\` beside \`prisma.config.ts\`, through \`dotenv-flow\`, and skips \`.env.local\` for the environment \`test\`.` and `` `import 'dotenv/config'` at the top of `prisma.config.ts` still works with the default lists.`` → `` `import 'dotenv/config'` at the top of `prisma.config.ts` still works with the default lists; remove it when you list `dotenv()`.``
3. `docs/design/10-domains/config-params.md`: the four lines § 4.3's grep finds (99, 144, 161 and 300 at `78166d80`) take § 4.2's words; line 161's `read from the config pool Load is given` becomes `read from the app configuration Load is given`.
4. `docs/design/10-domains/core-model.md`, the `LowerOptions` sketch: `readonly configPool?: Readonly<Record<string, unknown>>       // passed to Load and the serializer; the generated stack files pass readConfigPool()` becomes two lines: `readonly checkedConfiguration?: CheckedConfiguration     // passed to Load and the serializer; the generated stack files read it from the configuration file` and `readonly checkedNodeAddresses?: readonly string[]        // lowering refuses a graph whose addresses differ`.
5. `docs/design/10-domains/module-composition.md`: `A root's input is the config pool, validated by its schema before any other module's binding.` → `A root's input is the app configuration, checked by its schema before any other module's binding.`; and the `ModuleContext.input` doc comment's last sentence, as in `node.ts`, becomes `A root's input is the app configuration, validated by its schema.`

The same sentence in `node.ts`'s `ModuleContext.input` doc comment changes the same way.

### 14.10 Guides

1. `docs/guides/building-an-app.md`:
   - § 4.2's words replace "config pool" and "secrets pool" on every line § 4.3's grep finds (eleven at `78166d80`).
   - `` `dotenv()` reads `.env`, `.env.local`, `.env.<environment>` and\n`.env.<environment>.local` beside `prisma.config.ts`, in that order, and a\nlater file wins. An environment name with `/` is encoded in the file name:\nthe environment `feature/x` reads `.env.feature%2Fx`.`` becomes one paragraph: `` `dotenv()` reads `.env`, `.env.local`, `.env.<environment>` and `.env.<environment>.local` beside `prisma.config.ts`, in that order, through `dotenv-flow`, and a later file wins. It skips `.env.local` for the environment `test`, and never reads `.env.defaults`. An environment name with `/` is encoded in the file name: the environment `feature/x` reads `.env.feature%2Fx`. If `prisma.config.ts` has `import 'dotenv/config'`, remove it when you list `dotenv()`: the import puts `.env` into the shell's values, which `environmentVariables()` returns last, so `.env` would override `.env.<environment>`.``
   - After `The root's schema checks the app configuration before anything is created, so a missing value fails with the schema's message.` (as § 4.2 leaves it), a new paragraph: `Composer reads the adapters once, in the command's own process. The deploy engine runs in a second process, which reads only what the first process checked, from a file in \`.prisma-composer/\` that only you can read and that is deleted when the deploy ends. A root field your body passes on must hold data JSON can hold exactly: text, numbers, booleans, null, arrays and plain objects.`
2. `docs/guides/deploying.md`: § 4.2's words in the paragraph that begins `One extra: if your app binds \`envSecret\``; and in the paragraph about `DEPLOY.ENGINE_FAILED`, `with credentials redacted and capped at 1000 characters` becomes `with every secret Composer knows redacted, and capped at 1000 characters`. A new paragraph after it: `The deploy engine's own output passes through Composer on its way to your terminal, with every secret Composer knows replaced by \`[redacted]\`: each value an \`envSecret()\` names, and every value your own \`secrets\` list returns, however short. So the engine shows plain progress lines, without colour.`
3. `docs/guides/running-locally.md`: `` `.env.dev` holds values only the environment `dev` reads. Without a `config` or `secrets` list, Composer reads the shell, so `import 'dotenv/config'` at the top of `prisma.config.ts` also works.`` → `` `.env.dev` holds values only the environment `dev` reads. Without a `config` or `secrets` list, Composer reads the shell, so `import 'dotenv/config'` at the top of `prisma.config.ts` also works; remove it when you list `dotenv()`.`` The same change in the bullet that ends `so \`import 'dotenv/config'\` as the first line of \`prisma.config.ts\` also works.`

### 14.11 The agent skill, `skills/prisma-composer-core-concepts/SKILL.md`

Written to `skills/README.md`. § 4.2's words replace "config pool", "secrets pool" and "pool" in the five places § 4.3's grep finds there; in the bullet that begins `` - `composer({ config: [...], secrets: [...] })` ``, `its whole \`input\` would be the whole pool, by default every shell variable.` becomes `its whole \`input\` would be the whole app configuration, by default every shell variable.` That bullet gains, at its end: `` `dotenv()` reads `.env`, `.env.local`, `.env.<environment>`, `.env.<environment>.local` through `dotenv-flow` (no `.env.local` for `test`); remove `import 'dotenv/config'` when you list it. The deploy engine's output is redacted: every value an `envSecret()` names and every value a written `secrets` list returns.``

### 14.12 Examples

No example adopts or drops `dotenv()` in this PR. `examples/storefront-auth` keeps `import 'dotenv/config'` with the default lists, which still works. The comment `// AUTH_SIGNING_SECRET; preflight fills it from the secrets pool when missing.` in `examples/storefront-auth/module.ts` becomes `// AUTH_SIGNING_SECRET; preflight fills it from the app secrets when missing.` The examples' tests take § 4.1's names.

### 14.13 The project design, `.drive/projects/module-input/design.md`

Each quoted string is replaced exactly. The edits make the design say what Will accepted on 2026-11-02.

1. Section 8, "The two adapters that ship": `Composer passes the pattern \`.env[.node_env][.local]\`, so \`dotenv-flow\`'s \`.env.defaults\` file is not read.` → `` `listFiles` lists `dotenv-flow`'s `.env.defaults` file first whenever it is given its own default pattern, `.env[.node_env][.local]`, so `dotenv()` drops that file from the list. It never reads `.env.defaults`. ``
2. Section 8, "The deploy's two processes": `- The second process never needs the app secrets, so the file holds none.` → `- The second process never needs the app secrets, so the file holds none. Load refuses a name that both an \`envParam()\` and an \`envSecret()\` read, because the file would then hold that secret.`
3. Section 9, after the bullet that ends `A value is redacted at any length. There is no minimum.`, two new bullets:
   - `- **How Composer knows a secret's name.** Core sees a secret source only as an opaque payload, so a target tells core which app secrets key holds the value: \`secretSource()\` takes \`secretsKey\`, and \`envSecret('NAME')\` passes \`NAME\`. Composer lists those keys to know what to redact, and which secrets \`prisma dev\` hands its second process.`
   - `- **What Composer already redacted stays, for now.** Composer keeps the redaction S4 shipped: an app configuration value of eight characters or more under a name that looks like a credential, and token shapes such as bearer tokens, JWTs and a password in a URL. That is existing behaviour, not part of this design. A later slice that gives secrets their own home revisits it (section 11).`
4. Section 9, the bullet that begins `- **The second process's output.** To redact it, Composer reads that output through a pipe and writes it on, instead of letting the second process write to the terminal.` becomes, whole: `- **The second process's output.** The CLI starts the second process through its command engine's \`ctx.spawn\`. From \`@prisma/cli-engine\` 0.10.0 (prisma/prisma-cli#383), \`ctx.spawn\` takes a transform per output stream: the engine pipes the child's stdout and stderr, passes each through the transform, and prints the result where it would have printed the output, in every output format. Composer's transform redacts. The engine still owns the child: stdin stays inherited, and signals, the abort ladder and the exit status work as before. A programmatic host has no engine, so there Composer pipes the output itself through the same redactor. Either way the second process has no terminal, so Alchemy's progress display and colours change. A secret can be split across two chunks of output, so the redactor holds back at most one fewer character than the longest secret until the next chunk or the end of the stream, and never a complete line when no secret holds a line break. A test splits a secret across two chunks.`
5. Section 12, "What this design reverses", a new last bullet: `- **Errors**: a structured error is never transformed between where it is raised and who receives it. Now redaction is the one change: before an operation returns an error, Composer removes every secret value it knows from its text and drops its cause.`

## 15. Tests

Runtime tests use `bun test`; type tests use vitest `expectTypeOf`. Test files are exempt from the no-bare-casts instruction. Every code block is as `pnpm lint:fix` formats it. Existing tests use `os.tmpdir()` for fixture apps; new tests in the same files follow the file's own fixture helpers.

### 15.1 Existing tests this PR changes

Renames only (§ 4.1 identifiers and § 4.2 words in titles, comments and assertions; no assertion's meaning changes): `core/__tests__/root-input.test.ts`, `source-load.test.ts`, `source-value.test.ts`, `source-value.test-d.ts`, `pointer.test.ts`, `config-adapters.test-d.ts`; CLI `pipeline.test.ts` and its fixture folders (`pipeline-config-pool` → `pipeline-app-configuration`), `generate-stack.test.ts`'s other tests; target `input-serializer.test.ts`, `local-target-preflight.test.ts`, `local-target-serve.test.ts`, `orm-postgres.test.ts`, `orm-postgres-shapes.test-d.ts`, `param.test.ts`, `pg-connection.test.ts`, `preflight.test.ts` (each `pools: { config: X, secrets: Y }` input becomes `configuration: X, secrets: Y`), `invariants.test.ts` (comment only); local target `compute-materialize-env.test.ts` (`materializeEnv(…, { config: C, secrets: S })` becomes `materializeEnv(…, C, S)`); `packages/1-prisma-cloud/2-shared-modules/auth/src/__tests__/module.test.ts`, `auth-options.test.ts`, `email/src/__tests__/module.test.ts`; `examples/auth/tests/module.test.ts`, `examples/email/tests/module.test.ts`; `test/integration/test/local-dev.integration.ts` (three comments).

Changes beyond renames:

- Every assertion of the two messages that said `Load was given no values from the \`config\` adapters` and `Pass { configPool } to Load` takes the § 12 text (`no app configuration`, `Pass { configuration } to Load`). `git grep -n 'Pass { configPool }' -- packages` lists them.

- `cli/src/__tests__/config-adapters.test.ts`: the tests `the deploy child reads the same values from the environment as the CLI` and `a variable Composer changes for the child reads as the CLI's own value there` are removed, with the helpers `asChild` and `deployInvocation` and the import of `alchemyInvocation`; `TOUCHED` becomes `['S4_LATE', 'S4_PROBE', 'PRISMA_COMPOSER_PREFLIGHT_X']`. The first `dotenv()` test is retitled `dotenv() reads the four files in dotenv-flow's order: the environment's local file wins, then the environment's file, then .env.local, then .env`; its assertion does not change.
- `cli/src/__tests__/config-pools.test.ts` becomes `app-configuration.test.ts` (`git mv`). Each `readSecretsPool(section(…), input)` becomes `readAppSecrets(section(…), input, new KnownSecrets())`. The describe `where the pool readers are published` and its test become:

  ```ts
  describe('where the readers are published', () => {
    test('the public config entry exports the adapters only, and the second process reads through the configuration-file entry', () => {
      expect(Object.keys(configEntry).sort()).toEqual(['dotenv', 'environmentVariables']);
      expect(Object.keys(configurationFileEntry).sort()).toEqual([
        'appSecretsFromEnvironment',
        'readCheckedConfiguration',
      ]);
    });
  });
  ```

  with `import * as configurationFileEntry from '../exports/configuration-file.ts';` in place of the pools entry import.
- `cli/src/__tests__/deployment-summary.test.ts`: the describe `poolSecrets` and its two tests are removed (§ 15.3 tests `secretValuesIn`). Each `readEngineFailureCause(file, values)` call becomes `readEngineFailureCause(file, (text) => redactValues(text, values))`.
- `cli/src/__tests__/generate-stack.test.ts`: `reads the config pool from the adapters and passes it to lower(), directly after the environment, and never reads the secrets pool` becomes `reads what the CLI checked from the configuration file, after the failure recorder starts, and passes it to lower() directly after the environment`. It asserts the rendered file contains `import { readCheckedConfiguration } from '@prisma/composer/internal/configuration-file';`, that `report.captureEngineFailure?.();` comes before `const checked = readCheckedConfiguration(process.env);`, that the options contain `  environment: "staging",\n  checkedConfiguration: checked.configuration,\n  checkedNodeAddresses: checked.nodeAddresses,`, and that the file contains neither `readConfigPool` nor `readSecretsPool`.
- `cli/src/dev/__tests__/generate-dev-stack.test.ts`: the expected import line becomes the § 8.3 one; `reads both pools from the adapters, …` becomes `reads the checked configuration and the app secrets the CLI handed over, passes the configuration to lower() directly after the environment, and both to the local providers`, asserting `const checked = readCheckedConfiguration(process.env);`, `const secrets = appSecretsFromEnvironment(process.env);`, the two option lines, and `  providers: localTargetProviders(resolved, containers, devDir, checked.configuration.values, secrets),`.
- `cli/src/__tests__/fixtures/stack-import/stub-composer.ts`: the `@prisma/composer/internal/pools` module becomes `@prisma/composer/internal/configuration-file`, with `export const readCheckedConfiguration = () => ({ configuration: { rootInput: [], values: { read: 'checked' } }, nodeAddresses: ['stub-address'] }); export const appSecretsFromEnvironment = () => ({ read: 'secrets' });`. The `lower` stub prints `checkedConfiguration: opts.checkedConfiguration, checkedNodeAddresses: opts.checkedNodeAddresses` in place of `configPool: opts.configPool`, and `...(globalThis.stubLocal === undefined ? {} : { local: globalThis.stubLocal })` in place of the `stubPools` spread. `localTargetProviders` becomes `(resolved, containers, devDir, configuration, secrets) => { globalThis.stubLocal = { configuration, secrets }; return {}; }`.
- `cli/src/__tests__/stack-file-import.test.ts`: `configPool` (the expected object) becomes `const checked = { configuration: { rootInput: [], values: { read: 'checked' } }, nodeAddresses: ['stub-address'] };`; the deploy test expects `{ app, extensions, state, environment: 'staging', checkedConfiguration: checked.configuration, checkedNodeAddresses: checked.nodeAddresses }`, retitled `the deploy stack passes the composer export of prisma.config.ts, the environment, and what the CLI checked, to lower(), and reads no secrets`; the dev test adds `local: { configuration: { read: 'checked' }, secrets: { read: 'secrets' } }`, retitled likewise.
- `cli/src/__tests__/run-alchemy.test.ts`: every `alchemyInvocation({ … })` and every hand-built `AlchemyInvocation` gains `redactedValues: []`. `env carries only the ADDITIONS …` drops any expectation of `PRISMA_COMPOSER_PARENT_VALUES`. Every `spawnCommandLine(line)` call becomes `spawnCommandLine(line, [])`.
- `cli/src/family/__tests__/converge-spawn.test.ts`: both `alchemyInvocation` calls gain `redactedValues: []`. The fake `ConvergeContext` ignores `transformOutput`, so the two tests still check `STDOUT_TO_STDERR` and the reproduce command; their expectations do not change.
- `cli/src/family/__tests__/*.test.ts` that run `deploy` or `dev` through `createTestCli`: the 0.10.0 harness sets `ctx.spawnOptions`, so they pass the new check unchanged.
- `cli/src/testing/operations-double.ts`: the synthetic `AlchemyInvocation` in `runConverge` gains `redactedValues: []`.
- `cli/src/operations/__tests__/operations.test.ts`: `deploy hands every extension's preflight both pools` becomes `deploy hands every extension's preflight the app configuration and the app secrets`, recording `{ configuration: input.configuration, secrets: input.secrets }`; `a secrets pool value appears in no event, result or report` becomes `an app secrets value appears in no event, result or report`, reading `input.secrets['S4_SENTINEL']`; `dev hands both pools to preflight and to a dev server` becomes `dev hands the app configuration and the app secrets to preflight and to a dev server`, with `serve: async ({ configuration, secrets }) => { seen.serve = { configuration, secrets }; … }` and the expected `{ configuration: { A: 'a' }, secrets: { S: 's' } }` for both; `an engine failure cause never carries a value the pools read from a dotenv file` becomes `an engine failure cause never carries a secret value read from a dotenv file`, its assertions unchanged. The describe `the operations read the pools from the config adapters` becomes `the operations read the app configuration and the app secrets from the adapters`.

- `core/src/__tests__/lowering.test.ts`: `lowering() passes opts.configPool to Load` becomes `lowering() passes opts.checkedConfiguration to Load`, and `opts({ bundles, configPool: { X: 'probe' } })` becomes `opts({ bundles, checkedConfiguration: { rootInput: [], values: { X: 'probe' } } })`; its assertion does not change.
- `target/src/__tests__/control-lowering.test.ts`: `the input document reads envParam() leaves from LowerOptions.configPool` becomes `the input document reads envParam() leaves from LowerOptions.checkedConfiguration`, and `opts: { configPool: { G: 'pool' } }` becomes `opts: { checkedConfiguration: { rootInput: [], values: { G: 'pool' } } }`; its assertion does not change.

If any other existing test fails, the implementer stops and reports.

### 15.2 New core tests

In `root-input.test.ts`, a new `describe("what Load reads from the app configuration", …)`. Its root schema is `type({ A: 'string', 'B?': 'string', C: 'string.integer.parse', D: 'string' })`; the body binds `{ a: input.A, b: input.B, c: input.C }` into the file's echo service; the configuration is `{ A: 'a', C: '4', D: 'unused', PATH: '/bin' }`.

1. `the graph records each root field the body names, with its checked value, and no other` — `[...graph.checkedConfiguration.rootInput].sort(byPath)` equals `[{ path: ['A'], value: 'a' }, { path: ['B'] }, { path: ['C'], value: 4 }]`, where `byPath` compares `path.join('.')`. `D` and `PATH` are absent.
2. `a root field JSON cannot hold exactly fails the Load, naming it` — schema `type({ WHEN: type('string').pipe((text) => new Date(text)) })`, body binds `{ when: input.WHEN }` into a service whose schema is `type({ when: 'Date' })`; Load with `{ configuration: { WHEN: '2026-01-01' } }` fails with exactly `input.WHEN of root module "shop" holds an object that is not plain data, which JSON cannot hold exactly. The deploy hands the root's checked input to its second process in a JSON file, so a field the root's body passes on must hold text, a finite number, a boolean, null, or arrays and plain objects of these.`
3. `the second process takes each root field from the checked configuration, without running the root's schema` — a Standard Schema whose `validate` pushes to a `calls` array and returns `{ value: {} }`; `Load(root, { checkedConfiguration: { rootInput: [{ path: ['A'], value: 'from-file' }, { path: ['B'] }, { path: ['C'], value: 4 }], values: {} } })`; `calls` stays `[]`, and the echo service's binding is `{ a: 'from-file', c: 4 }`.
4. `a root field missing from the checked configuration fails, saying the two processes built different graphs` — the same Load with `rootInput: [{ path: ['A'], value: 'a' }]` fails with exactly `input.B of root module "shop" is not in the configuration file. The first process's root body did not pass it on, so the deploy's two processes built different graphs. A module body must build the same graph every time; one that reads process.env, a file or the clock can build a different one.`
5. `Load refuses configuration and checkedConfiguration together` — exact message from § 12.
6. `a root with no input records no fields` — `Load(rootWithoutInput, { configuration: {} }).graph.checkedConfiguration` equals `{ rootInput: [], values: {} }`.

In `source-load.test.ts`, a new `describe('configuration keys Load reads', …)`, with a test source `const configured = (key: string) => paramSource({ key }, { label: \`configured('${key}')\`, configurationKey: key })` and `const secret = (key: string) => secretSource({ key }, { label: \`secret('${key}')\`, secretsKey: key })`:

7. `the graph records the text of every configuration key a source reads, in a module's input, a service's input and a service's params` — keys `IN_MODULE`, `IN_SERVICE`, `IN_PARAM` bound in the three places, configuration `{ IN_MODULE: 'm', IN_SERVICE: 's', IN_PARAM: 'p', OTHER: 'o' }`; `graph.checkedConfiguration.values` equals `{ IN_MODULE: 'm', IN_SERVICE: 's', IN_PARAM: 'p' }`.
8. `an unset or empty key is left out of the recorded values` — `IN_SERVICE: ''` and `IN_PARAM` absent; values equal `{ IN_MODULE: 'm' }`.
9. `a configuration key in a service's input whose value is not text fails at Load` — `IN_SERVICE: 4`; message exactly ``the input binding of service "shop.email.echo" depends on configured('IN_SERVICE'), which reads "IN_SERVICE" from the values the `config` adapters return, but they return a number for it, not text. configured('IN_SERVICE') reads text; to pass other data, declare it in the root module's input.``
10. `a name read as a configuration key and named as a secrets key fails at Load` — the service binds `{ plain: configured('SHARED'), key: secret('SHARED') }`; message exactly `configured('SHARED') reads "SHARED" from the app configuration, and secret('SHARED') names "SHARED" as a secret. A name is a plain value or a secret, not both: Composer hands the deploy's second process every plain value it reads, in a file, and never writes a secret to a file. Give the plain value and the secret different names.`
11. `the second process reads configuration keys from the checked values` — `Load(root, { checkedConfiguration: { rootInput: [], values: { IN_MODULE: 'from-file' } } })` gives the module-bound field `'from-file'`.

In `source-value.test.ts`:

12. `secretSource() takes a secretsKey, which must be non-empty text` — `secretSource({}, { secretsKey: '' })` throws `secretSource() secretsKey must be a non-empty string.`
13. `secretsKeys lists the secrets key of every secret source the graph names, once each` — two services binding `secret('A')`, one `secret('B')`, and one `secretSource({})` without a key; `secretsKeys(graph)` equals `['A', 'B']`.
14. `nodeAddresses lists every node's address, sorted` — `nodeAddresses(Load(root))` equals the sorted ids of `graph.nodes`.

In `lowering.test.ts`:

15. `lowering refuses a graph whose node addresses differ from the checked ones, naming both sides` — `lowering(root, config, { name: 'shop', bundles, checkedNodeAddresses: ['shop', 'shop.gone'] })` fails with the `LowerError` of § 12, where the second process built `shop.echo` and not `shop.gone`: `… Only in the second process: "shop.echo". Only in the first process: "shop.gone". …`. The test runs the effect as the file's other lowering tests do.
16. `lowering accepts the same addresses in any order` — `checkedNodeAddresses` is the graph's addresses reversed; no error.

### 15.3 New CLI tests

`cli/src/__tests__/config-adapters.test.ts`, describe `dotenv()`:

17. `dotenv() never reads .env.defaults` — files `.env.defaults` (`A=defaults\nD=defaults\n`) and `.env` (`A=env\n`); values equal `{ A: 'env' }`.
18. `dotenv() skips .env.local for the environment test, as dotenv-flow does` — files `.env`, `.env.local`, `.env.test`, `.env.test.local`, each `KEY=<file name>`, plus `.env.local` holding `ONLY_LOCAL=1`; for `environment: 'test'` the values equal `{ KEY: '.env.test.local' }`.
19. `dotenv() reads .env.defaults as the environment's file for an environment named defaults` — files `.env.defaults` (`A=env-file\n`) and `.env` (`A=env\n`); for `environment: 'defaults'` the values equal `{ A: 'env-file' }`.
20. `dotenv() does not change the process environment` — after the call, `process.env['S11_PROBE']` is still `undefined`, with `S11_PROBE=1` in `.env`.

New file `cli/src/__tests__/redaction.test.ts`:

21. `KnownSecrets redacts a known value at any length, longest first` — `add(['a', 'abc'])`; `redact('xabcx a')` equals `'x[redacted]x [redacted]'`.
22. `KnownSecrets skips empty values` — `add([''])`; `values()` equals `[]`.
23. `secretValuesIn takes the values under each secrets key from both, and credential-looking app configuration values of eight characters or more` — configuration `{ STRIPE_KEY: 'sk_live_123456', WEBHOOK: 'w', API_TOKEN: 'short', N: 4 }`, secrets `{ WEBHOOK: 'w2' }`, keys `['WEBHOOK']`; result sorted equals `['sk_live_123456', 'w', 'w2'].sort()`.
24. `redactError removes known values from the summary, why, fix and meta, and keeps the code, severity and where` — an error `CONFIG.ADAPTER_FAILED` with secret `hunter2` in each text field and in `meta.nested.list[0]`; the result's `JSON.stringify(toEnvelope())` does not contain `hunter2`, its `code`, `severity` and `where` are the original's, and `cause` is `undefined`.
25. `redactDevEvent redacts messages and dev server output, and leaves other events as they are`.
26. `redactSummary redacts entity ids, urls and details`.
27. `redactingTransform redacts a secret split across two chunks` — a `ReadableStream` of the chunks `'token is s3cr3t-'` and `'value, done\n'`, piped through `redactingTransform(['s3cr3t-value'])`; the text read out equals `'token is [redacted], done\n'`.
28. `redactingTransform redacts every occurrence at every chunk size` — the text of 2000 parts where every seventh is `SECRETXYZ`, every fiftieth otherwise is `abc\n`, and the rest `abc`; values `['SECRETXYZ', 'SECRET']`; for chunk sizes 1, 2, 3, 5, 8, 9, 10 and 64 the text read out equals the text with every `SECRETXYZ` replaced.
29. `StreamRedactor holds back one fewer character than the longest secret, and end returns the rest` — values `['abcdef']`; `push('0123456789')` returns `'01234'`, and `end()` returns `'56789'`.
30. `StreamRedactor returns every complete line at once when no secret holds a line break, holds a line break secret whole, and with no secret returns each chunk as it comes` — values `['abcdef']`: `push('Creating web\n')` returns `'Creating web\n'`. Values `['line1\nline2']`: `push('x line1\n') + push('line2 y\n') + end()` equals `'x [redacted] y\n'`. No values: `push('abc')` returns `'abc'`.

New file `cli/src/__tests__/configuration-file.test.ts`:

31. `the configuration file is JSON readable only by its owner` — `writeConfigurationFile(file, checked)`; `fs.statSync(file).mode & 0o777` equals `0o600`; `JSON.parse` of the file equals `checked`.
32. `a file already there is replaced, and gets mode 0600` — a file written first with mode `0o644`.
33. `readCheckedConfiguration reads back what was written, with the node addresses` — a field with `value` and one without.
34. `readCheckedConfiguration names the variable when it is not set` — exact message of § 12.
35. `readCheckedConfiguration says a file it cannot read is deleted when the run ends` — message starts with `Could not read the configuration file <file>: ` and ends with `run the command again.`
36. `readCheckedConfiguration refuses a file Composer did not write` — `{"rootInput":{}}` gives `… rootInput is not a list of fields.`
37. `secondProcessEnvironment names the file and the node addresses, and the app secrets only when given`.
38. `appSecretsFromEnvironment reads the object, and refuses one that is not text`.

`cli/src/family/__tests__/converge-spawn.test.ts`, new, using the engine's test harness (`createTestCli` from `@prisma/cli-engine/testing`). The command under test is defined in the file: `defineCommand({ help: { summary: 'Runs a converge' }, maySpawn: true, handler: async (_args, ctx) => { await convergeSpawn(ctx)(invocation); return ok(exitWithChildStatus()); } })`, where `invocation` is `alchemyInvocation({ command: 'deploy', stackFileRelativePath: '.prisma-composer/alchemy.run.ts', cwd, stage: 'test', containerEnv: {}, redactedValues: ['hunter2-secret'] })` and `cwd` is `appWithAlchemy([])`. The harness's scripted child writes its output with `child.write(stream, chunk)`, which the engine passes through the transform as it would a real child's.

39. `the engine prints the child's output with every known secret redacted, a secret split across two chunks included, in human and json mode` — the scripted child writes `'key=hunter2-'` and then `'secret\n'` to stdout, and `'boom hunter2-secret\n'` to stderr, and exits 0. Run with `--format human` and with `--json`: `result.spawns[0]?.output` is `'engine'`, neither `result.stdout` nor `result.stderr` contains `hunter2`, and together they contain `key=[redacted]\n` and `boom [redacted]\n`. The test does not assert which stream the engine printed to; that is the engine's business.
40. `the held-back text is printed before ctx.spawn resolves and before the report events the engine buffered` — the handler calls `setTimeout(() => ctx.report({ kind: 'endpoint', name: 'probe', url: 'https://probe.example' }), 5)` before it starts the converge; the scripted child waits 20 ms and writes `'tail-without-newline'` to stderr, with no line break, so the redactor holds it until the stream ends; then it exits 0. In human mode, `result.stderr` contains `tail-without-newline`, and its index is lower than the index of `https://probe.example`.

`cli/src/__tests__/run-alchemy.test.ts`, new:

41. `spawnCommandLine pipes the child's output through redaction, a secret split across chunks included` — a `node -e` child writing `key=hunter2-` then, 50 ms later, `secret\n` to stdout; `spawnCommandLine(line, ['hunter2-secret'], outputs)` with `outputs` collecting into strings; the collected stdout is `key=[redacted]\n`.

`cli/src/family/__tests__/converge-spawn.test.ts`, new:

42. `convergeSpawn gives the engine a transform per stream, and passes the secret values neither on the child's command line nor in its environment` — a `ConvergeContext` whose `spawn` records its options and resolves `{ exitCode: 0, signal: null }`; with `redactedValues: ['hunter2']`, the recorded `args` and the values of the recorded `env` do not contain `'hunter2'`; `transformOutput('stdout')` and `transformOutput('stderr')` return two different `TransformStream`s, and text `'a hunter2 b'` written through either reads out as `'a [redacted] b'`.

`cli/src/family/__tests__/converge-spawn.test.ts`, new, on the engine's test harness:

43. `a host whose engine cannot transform a child's output refuses before starting anything` — a command defined in the file whose handler calls `outputTransformMissing({ spawn: ctx.spawn, lastChild: ctx.lastChild })`, without `spawnOptions`, as a 0.9.0 host gives, returns the refusal when there is one, and otherwise runs `convergeSpawn(ctx)(invocation)`. Run with `--format human`: the exit code is 2, `result.stderr` holds `DEPS.CLI_ENGINE_INCOMPATIBLE` and the summary of § 12, and `result.spawns` is empty. The same command with `spawnOptions: ctx.spawnOptions` passed through runs the scripted child once.

`cli/src/__tests__/pipeline.test.ts`, new:

44. `runPipeline reads the app secrets before the app configuration` — adapters that push `'secrets'` and `'config'` to an order array; with `readSecrets: true` the array is `['secrets', 'config']`.
45. `runPipeline adds the values under every envSecret() name to the known secrets` — the `pipeline-app-configuration` fixture module binds `secretSource({}, { label: 'secret', secretsKey: 'S11_SECRET' })`; the config adapter returns `{ S11_SECRET: 'from-config' }` and the secrets adapter `{ S11_SECRET: 'from-secrets' }`; the `knownSecrets` passed in has both values.

`cli/src/operations/__tests__/operations.test.ts`, a new `describe('the second process reads what the first process checked', …)`, using a fixture app whose root declares `input: type({ GREETING: 'string' })`, binds `{ greeting: input.GREETING, origin: configured('APP_ORIGIN'), key: secret('S13_SECRET') }` into its service (the helpers of § 15.2, built from core), and whose `config` adapter returns `{ GREETING: 'hello', APP_ORIGIN: 'https://origin.example', UNUSED: 'x' }`:

46. `deploy writes the configuration file before the second process starts and deletes it after, mode 0600, holding only what Load read` — in the fake `alchemy`, `const file = input.env[CONFIGURATION_FILE_ENV]`; while it runs, the file exists, its mode is `0o600`, and its JSON equals `{ rootInput: [{ path: ['GREETING'], value: 'hello' }], values: { APP_ORIGIN: 'https://origin.example' } }`; `input.env[NODE_ADDRESSES_ENV]` equals `JSON.stringify(nodeAddresses(graph))` for the fixture's graph; after `deploy` returns, the file does not exist. The same holds when the fake returns `{ exitCode: 1, signal: null }`.
47. `destroy writes and deletes the configuration file the same way, and reads no secrets`.
48. `dev hands the second process the app secrets the graph names through its environment, never in a file` — `secrets: [() => ({ S13_SECRET: 'dev-secret-value', OTHER: 'not-named' })]`; in the fake `alchemy`, `input.env[APP_SECRETS_ENV]` equals `'{"S13_SECRET":"dev-secret-value"}'`, and no file under the app directory contains `dev-secret-value`; `.prisma-composer/dev/dev/configuration.json` exists during the converge and not after it.
49. **The end-to-end test.** `no known secret reaches the configuration file, the stack file, the deploy report, the errors or the second process's output`. The app's `secrets` adapter returns `{ S13_SECRET: 'e2e-SENTINEL-5f2a' }` and `config` returns the values above. The fake `alchemy` (a) copies the configuration file's text and the stack file's text into variables; (b) runs `spawnCommandLine({ command: process.execPath, args: ['-e', script], cwd, env: input.env }, input.redactedValues, outputs)`, where `script` writes `e2e-SENTI` and, after 50 ms, `NEL-5f2a and more\n` to stdout and `boom e2e-SENTINEL-5f2a\n` to stderr, and `outputs` collects both streams; (c) writes to the result file a deployment summary whose one entity has `id: 'svc'` and `details: { note: 'e2e-SENTINEL-5f2a' }`, and beside it the failure cause `error: rejected e2e-SENTINEL-5f2a`; and (d) returns the status the test sets. The test deploys twice, each with `reportPath` set to a file in the app directory: once with status 0 and once with status 1. Afterwards none of these contains `SENTINEL`: the copied configuration file and stack file texts of both runs, the collected stdout and stderr, both run report files, `JSON.stringify(result.value.summary)` of the first run, and `JSON.stringify(result.failure.toEnvelope())` and `String(result.failure.meta?.['engineCause'])` of the second. The collected stdout of each run is `[redacted] and more\n`.
50. `an adapter's failure message is redacted with every value a written secrets list returned` — `secrets: [() => ({ TOKEN_X: 'adapter-SENTINEL-1' })]`, `config: [() => { throw new Error('bad adapter-SENTINEL-1'); }]`; the failure is `CONFIG.ADAPTER_FAILED` and `JSON.stringify(result.failure.toEnvelope())` does not contain `SENTINEL`.
51. `a dev event's message is redacted` — a dev server output line holding the secret reaches `onEvent` as `[redacted]`.

## 16. Scope and commits

In: core (`packages/0-framework/1-core/core`), the CLI (`packages/0-framework/3-tooling/cli`), `@prisma/composer`'s entries, the Prisma Cloud target and the local target, the tests of § 15, `docs/`, `skills/`, `examples/storefront-auth/module.ts`'s comment, `architecture.config.json`, `tsconfig.depcruise.json`, the four `@prisma/cli-engine` declarations of § 8.7, the lockfile, and the project's `design.md` (§ 14.13).

Out, as the plan and Will's rulings assign: `prisma dev` watching inputs (S14); a developer's `.env.local` secret reaching another environment (S15); a home for secrets apart from plain values (S16); `secretString()` becoming `secret(schema)` (S17); `dotenv-flow` skipping `.env.local` for `test`; `destroy` needing a valid configuration; `KEY=` giving `''`; filtering `environmentVariables()`; any change to `envParam()`'s deploy-time reading. Also out: the engine change itself, which is prisma/prisma-cli#383.

Each commit is made with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"` and has no `Co-Authored-By` line. Before each commit, run `pnpm lint:fix` and keep the formatting it writes. Only the branch tip must be green.

1. `docs(drive): the module-input design says dotenv() drops .env.defaults, names secretsKey, refuses a name read as both, and redacts through the engine's output transform` — § 14.13.
2. `feat(cli)!: dotenv() reads its files through dotenv-flow` — § 3, its tests (15.1's `config-adapters.test.ts` changes, tests 17 to 20), the lockfile.
3. `refactor!: the config pool and the secrets pool are the app configuration and the app secrets` — § 4 and § 10 items 1, 3 to 11, with every rename-only test change of § 15.1.
4. `feat(core): Load records what it read from the app configuration, and the second process Loads with it` — § 5, § 6, § 10 item 2, tests 1 to 16.
5. `feat(cli)!: the second process reads a configuration file and runs no adapter` — § 7, § 8.1 to § 8.6, the `generate-stack`, `generate-dev-stack`, `stack-file-import`, `app-configuration` and `pipeline` changes of § 15.1, tests 31 to 38 and 44 to 48.
6. `feat(cli): Composer redacts every secret it knows, in errors, events and the second process's output` — § 8.7, § 9, § 10 item 12, the `deployment-summary`, `run-alchemy`, `converge-spawn`, `operations-double` and `operations` changes of § 15.1, tests 21 to 30, 39 to 43 and 49 to 51, the lockfile.
7. `docs(design): one current record for secrets, env-sourced params, errors, the composer section and dev secrets; the app configuration and the app secrets` — § 14.1 to § 14.9.
8. `docs: guides and the agent skill read configuration once and redact known secrets` — § 14.10 to § 14.12.
9. `docs(drive): module-input S11 to S13 manual QA` — `qa.md` in this slice's folder (§ 17).

## 17. Done when

- Tests 1 to 51 pass, and every test changed in § 15.1 passes. At the root: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm lint:deps`, `pnpm test`, `pnpm turbo run test:types`, `pnpm check:floor-imports`, `pnpm check:publish-deps`, `pnpm check:skill-packaging`, `pnpm check:family-static-graph` and `pnpm check:cli-engine-pin` are green. `pnpm lint:casts` reports `delta=0`. `pnpm lint` reports the same warning and info counts as main.
- § 4.3's grep finds nothing.
- Run `pnpm test` from this worktree, not from a scratch copy. Some target and local-target tests start emulator daemons. Stop no emulator you did not start; if tests fail because of an emulator this run did not start, record it and report. Never run `pnpm test:integration`, `pnpm test:e2e` or `pnpm test:all`. `test/integration/test/local-dev.integration.ts` changes only in comments and runs in CI.
- `@prisma/cli-engine` 0.10.0 is published and installed from the registry, with no local link left in any manifest or the lockfile. Until then the pull request stays a draft.
- Every document in § 14 is updated. The pull request carries § 13.
- **Manual QA**, recorded in `qa.md` in this slice's folder, after `pnpm build`. Credentials: `set -a; . ~/.config/prisma-compose/deploy.env; set +a`, never printing a value, with `PRISMA_REGION=us-east-1`. Every hosted step runs from `examples/email`, after `pnpm turbo run build --filter @prisma/example-email...`, as `( set -a; . ~/.config/prisma-compose/deploy.env; set +a; PRISMA_REGION=us-east-1 bun ../../node_modules/.bin/prisma deploy --name s13qa-email --environment s13-qa )`, called "the deploy" below. The name `s13qa-email` keeps the workspace's existing `email-example` project untouched. The secret value is generated once: `export S13_QA_SECRET="s13qa-$(openssl rand -hex 8)"`; `qa.md` records only its first five characters.
  1. **Files, deployed to Prisma Cloud.** Write `examples/email/.env.s13-qa` with `EMAIL_DELIVERY_MODE=none` and `EMAIL_FROM=s13qa@example.com`, and `examples/email/.env.s13-qa.local` with `EMAIL_DELIVERY_CREDENTIAL=$S13_QA_SECRET` (the value, written by the shell). Write `.env.defaults` with `EMAIL_FROM=defaults-must-not-win@example.com`. In a second shell, from `examples/email`, run `while true; do cp .prisma-composer/configuration-*.json ../../wip/s13-qa-configuration.json 2>/dev/null; sleep 0.2; done`. Run the deploy. Stop the loop. Record: the deploy succeeded; `wip/s13-qa-configuration.json` holds `rootInput` with `EMAIL_DELIVERY_MODE` and `EMAIL_FROM` set to `s13qa@example.com` (not the `.env.defaults` value), and `values` `{}`; `ls -l` showed mode `-rw-------` on it while it existed; `ls .prisma-composer/configuration-*.json` finds nothing after the deploy; `grep -r "$S13_QA_SECRET" .prisma-composer ../../wip/s13-qa-configuration.json` finds nothing; the Management API lists `EMAIL_DELIVERY_CREDENTIAL` on the `s13-qa` Branch (metadata only).
  2. **The second process's output is redacted.** Add, for this step only, at the end of `examples/email/prisma.config.ts`: `if (process.env.PRISMA_COMPOSER_CONFIGURATION_FILE !== undefined) console.log('qa secret in the second process:', process.env.EMAIL_DELIVERY_CREDENTIAL);`, export `EMAIL_DELIVERY_CREDENTIAL="$S13_QA_SECRET"` in the shell, and run the deploy again under `script -q ../../wip/s13-qa-output.txt bash -c '<the deploy>'`, so the terminal is a real one and its text is captured. Record: the output shows `qa secret in the second process: [redacted]`; `grep -c "$S13_QA_SECRET" ../../wip/s13-qa-output.txt` is 0; Alchemy's progress lines appear without colour. Run the deploy once more with `--json`, its stdout to `../../wip/s13-qa-stdout.json` and its stderr to `../../wip/s13-qa-stderr.txt`, and record that neither file holds the value and that the stdout file holds only JSON lines. Remove the line and unset the variable.
  3. **An adapter's error is redacted.** Put, for this step only, `config: [() => { throw new Error(\`cannot use ${process.env.EMAIL_DELIVERY_CREDENTIAL}\`); }, dotenv(), environmentVariables()]` in `prisma.config.ts`, export the variable again, and deploy. Record the `CONFIG.ADAPTER_FAILED` output: its `Why:` line reads `It threw: cannot use [redacted]`. Restore `prisma.config.ts` and unset the variable.
  4. **A different graph is refused.** Add, for this step only, to the root body in `examples/email/module.ts`: `if (process.env.PRISMA_COMPOSER_CONFIGURATION_FILE !== undefined) provision(email(), { id: 'extra', input: { deliveryMode: input.EMAIL_DELIVERY_MODE, from: input.EMAIL_FROM, deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') } });`, and deploy. Record that it fails with `DEPLOY.ENGINE_FAILED`, whose cause names `"s13qa-email.extra"` (and the nodes under it) as only in the second process, and that nothing new was created on the Branch. Restore `module.ts`.
  5. **`prisma dev`.** Write `examples/email/.env.dev` with the same two plain values, `EMAIL_FROM=dev-qa@example.com`, and `.env.dev.local` with `EMAIL_DELIVERY_CREDENTIAL=$S13_QA_SECRET`. Run `prisma dev --detach` from `examples/email`. Record: it started; `.prisma-composer/dev/dev/configuration.json` does not exist after it returns; `grep -r "$S13_QA_SECRET" .prisma-composer .alchemy` finds nothing (the compute emulator's own copy lives outside the project, as ADR-0058 records); `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"email":"qa@example.com","name":"QA"}' "$(prisma dev url email-example.mailer)/signup"` prints a 2xx status. Then `prisma dev stop`.
  6. **Clean up.** Run `( set -a; . ~/.config/prisma-compose/deploy.env; set +a; PRISMA_REGION=us-east-1 bun ../../scripts/composer-destroy.ts --environment s13-qa --name s13qa-email )`, and the same with `--environment production` if step 1 created it; record that destroy ran no secrets adapter (step 3's throwing adapter, put in `secrets` for this check only, does not fail it). Delete `.env.s13-qa`, `.env.s13-qa.local`, `.env.defaults`, `.env.dev`, `.env.dev.local` and `wip/s13-qa-*`. `git status` shows only this PR's changes.

## 18. Checks the spec author ran

One scratch worktree at the git-ignored `wip/s11-scratch`, removed afterwards. No process was left running. The probe scripts are kept at the git-ignored `wip/s11-s13-spec-probe/` for the review.

- **`dotenv-flow` 4.1.0** (`dotenv-flow-order.mjs`), with `.env.defaults`, `.env`, `.env.local`, `.env.production`, `.env.production.local`, `.env.test`, `.env.test.local` and `.env.defaults.local` in one folder. Given the pattern `.env[.node_env][.local]`, `listFiles` returned `.env.defaults` first for every environment: that string equals `dotenv-flow`'s `DEFAULT_PATTERN`, and `listFiles` adds `.env.defaults` exactly when the pattern equals it. The order after it was `.env`, `.env.local`, `.env.<environment>`, `.env.<environment>.local`; for `test` it skipped `.env.local`; for an environment named `defaults` it listed `.env.defaults` twice, first as the defaults file and later as the environment's file. `parse([])` returned `{}`, and `process.env` was untouched.
- **The filter** (`dotenv-flow-filter.mjs`): dropping the first entry when it is `<dir>/.env.defaults` gave `.env, .env.local, .env.production, .env.production.local` for `production`, kept the environment's own file for `defaults`, and changed nothing once `.env.defaults` was removed.
- **The stream redactor, first version** (`redactor.ts`, `redactor-probe.ts`, run with Bun): a secret split across two chunks was redacted; overlapping secrets `abc` and `abcdef` gave the longest match; a one-character secret was redacted; for chunk sizes 1, 2, 3, 5, 8, 9, 10 and 64 over a 6000-character text, the output equalled the text with every secret replaced.
- **Alchemy without a terminal** (`alchemy-no-tty.run.ts`): `node node_modules/alchemy/bin/cli.js deploy alchemy.run.ts --yes --stage probe` with stdout and stderr redirected to files and stdin from `/dev/null` exited 0, ran the stack effect (`process.stdout.isTTY` undefined), and printed plain timestamped log lines. Alchemy decides interactivity from `stdin.isTTY && stdout.isTTY` and agent variables, so a piped run is non-interactive, and `--yes` covers the confirmation.
- **The engine's `ctx.spawn`, 0.9.0** (`dist/report-*.d.ts` and `dist/engine-*.js`): `SpawnOptions` takes `command`, `args`, `cwd` and `env` only; the request's `output` is `"inherit"` or `"diagnostic"`, chosen by the engine from the output format; the engine logs `command` and `args` in debug mode, never `env`; it forwards SIGTERM to its child and, on a programmatic abort, ends it with SIGTERM, then SIGKILL.
- **The engine change, prisma/prisma-cli#383, final API** (head `415c668a`, read in its `README.md` and with `git diff origin/main...HEAD`): `SpawnOptions.transformOutput?: (stream: ChildStreamName) => TransformStream<string, string>`, called once per stream before the child starts; the spawn request's `output` is `"engine"` and the adapter returns both streams; the result is written where the output format sends the child's output, with backpressure; each transform's `flush` runs before `ctx.spawn` settles on every path; the engine replaces the `PRISMA_SERVICE_TOKEN` it injects with `[redacted]` before the transform; `ctx.spawnOptions` is `SPAWN_OPTION_NAMES` (`command`, `args`, `cwd`, `env`, `transformOutput`), and `ctx.spawn` refuses any other option name. The harness's scripted child has `write(stream, chunk)`, and `SpawnRecord.output` records the request's `output`. The README calls Composer's stdout preload redundant; § 9.5 says why it stays.

Checks for this amendment, in a scratch worktree at the git-ignored `wip/s11-amend-scratch`, removed afterwards:

- **The stream redactor and its transform** (`redactor.ts` and `probe.ts`, run with Bun): § 9.3's `StreamRedactor` and `redactingTransform`, piped from a `ReadableStream`, redacted a secret split across two chunks; with the values `SECRETXYZ` and `SECRET` over a 2000-part text with line breaks, chunk sizes 1, 2, 3, 5, 8, 9, 10 and 64 gave the text with every `SECRETXYZ` replaced; `push('0123456789')` with `abcdef` returned `01234` and `end()` returned `56789`; a complete line came out at once; a secret with a line break, split at the break, was redacted whole; overlapping `a`, `abc` and `abcdef` gave the longest match.
- **Types**: `redactor.ts` type-checks with the repo's TypeScript 6.0.3 under `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, once with the DOM library and once with only `@types/node`, so `TransformStream` and `match.index` need no cast.
- **Pins**: `@prisma/cli-engine` is `0.9.0` in `packages/0-framework/3-tooling/cli` (`dependencies`), `packages/1-prisma-cloud/1-extensions/target` (`devDependencies`), `packages/9-public/composer-cli` (`peerDependencies` and `devDependencies`) and the root `pnpm.overrides`.
- **Quotes against S10**: every code and document quote in § 5, § 10 and § 14 was checked against this branch at `78166d80` (§ 19).
- **Not run**: the implementation as a whole, `pnpm test`, a build of the new entries, any deploy, and the redactor against the engine, which is not published yet.

## 19. What S10 changed

S10 is on this branch. It typed a service's binding from its schema, renamed `ServiceInputBinding` to `InputBindingUse` and typed its `binding` as `unknown`. § 5.3's `checkedConfigurationOf` now takes `readonly InputBindingUse[]`. S10 did not change `SourceOptions`, `ParamSourceOptions`, `secretSource()`, `paramSource()`, `value.ts`'s source origin, `resolveValues`'s `configPool` reading, `loadModule`'s root input block, the CLI, the stack files, the operations or redaction, so every other quote in § 5 and § 10 matches the code. In the documents, S10 rewrote the binding sentences of `config-params.md` and the glossary; the lines § 14.8 and § 14.9 quote are still there, and `config-params.md` has four pool lines, at 99, 144, 161 and 300. `building-an-app.md` and the agent skill still hold every sentence § 14.10 and § 14.11 quote. ADR-0029's rewrite (§ 14.3) now says a wrong binding fails to compile, as S10 made it.

## 20. Decisions this spec records, for the review

1. **Under the CLI, the engine redacts the second process's output with Composer's transform** (§ 9.5), and prints it where it would have. Composer maps no stream and handles no output format. Programmatic hosts pipe in-process through the same redactor (§ 9.4). The secret values stay in the first process; no environment variable, argument or file carries them.
2. **The redactor never holds back a complete line when no secret holds a line break** (§ 9.3), so a progress line is printed at once, not after the platform's next answer.
3. **`dotenv()` filters `.env.defaults` itself** (§ 3.2): the design's pattern does not keep `dotenv-flow` from listing it (§ 21, finding 1). It parses one file at a time, merged in `dotenv-flow`'s order, so an unreadable file is named, as today.
4. **The app secrets are read before the app configuration** (§ 7.3), so a config adapter's failure is redacted with a written secrets list's values.
5. **The redaction set keeps S4's credential-name heuristic** for app configuration values of eight characters or more, and S4's shape patterns. This is existing behaviour, kept for now, not part of the design's redaction. Without it, a value such as `STRIPE_KEY` in the app configuration under the default lists, which no `envSecret()` names, would stop being redacted. The decision records and the design say the same (§ 14.3, § 14.6, § 14.13).
6. **The stream redactor matches exact values only**; the shape patterns (bearer tokens, JWTs, URL passwords) apply to whole texts: errors, events and failure causes. A pattern cannot be held back across chunks by a length.
7. **Core gains `secretSource()`'s `secretsKey`** (§ 5.5), so the CLI can list the names `envSecret()`s name without knowing a target's payload, as `paramSource()`'s `configurationKey` already does for params.
8. **Load records what it read on the graph** (`graph.checkedConfiguration`), so the first process writes exactly that and the second process Loads with it; core imports no `node:` module and reads no environment variable for this.
9. **The dev configuration file lives only while a converge runs**, at a fixed path per environment, which is stricter than the design's "deleted when `prisma dev` stops".
10. **The configuration file for a deploy has a unique name** per run, as the result file does, passed in `PRISMA_COMPOSER_CONFIGURATION_FILE`, so two deploys from one checkout never read each other's.
11. **A name read both as a configuration key and as a secrets key fails the Load** (§ 5.3), because the first would put the second's value in the configuration file.
12. **A non-text configuration value in a service's input or params fails at Load**, in the first process, because the first process must decide what the file holds; before, the serializer or preflight raised it.
13. **A redacted error is a new `CliStructuredError` with the same code and no cause** (§ 9.3). ADR-0044's record changes to say so.
14. **No example adopts `dotenv()` in this PR**; `examples/email` and `examples/auth` already use it, and `examples/storefront-auth` keeps `import 'dotenv/config'`, which still works.
15. **`PRISMA_COMPOSER_PARENT_VALUES` goes**, because no child runs an adapter.
16. **Decision records are rewritten in full** (§ 14.1 to § 14.5), as Will asks, and ADR-0062, already one current record, is edited in place.

## 21. What the design gets wrong or does not say

1. **Wrong: the pattern does not exclude `.env.defaults`.** Design section 8 said passing `.env[.node_env][.local]` keeps `dotenv-flow` from reading `.env.defaults`. That string is `dotenv-flow`'s own default, and `listFiles` adds `.env.defaults` exactly when the pattern equals the default (§ 18). This spec filters it out (§ 3.2). Will accepted the correction; § 14.13 and § 14.6 item 12 make the design and ADR-0062 say `dotenv()` drops it.
2. **Resolved: "Composer reads that output through a pipe" under the CLI.** `@prisma/cli-engine` 0.9.0's `ctx.spawn` cannot hand a command its child's output. The first version of this spec added a relay process. Will chose the engine change instead: prisma/prisma-cli#383 adds the output transform (§ 9.5), and this PR waits for 0.10.0. § 14.13 replaces the design's "reads that output through a pipe".
3. **Not said: how the CLI knows the names an `envSecret()` names.** Core sees only an opaque payload. This spec adds `secretsKey` to `secretSource()` (§ 20, decision 7), a core SPI change. Will accepted it; § 14.13 adds it to the design.
4. **Not said: what is redacted before the graph exists.** An adapter failure or a Load error happens before the CLI knows any `envSecret()` name. Under the default lists, only the credential-name heuristic applies then; with a written secrets list, its values apply too, because it is read first (§ 20, decision 4).
5. **Conflict with a recorded decision: ADR-0044 says a structured error is never transformed between its origin and the consumer.** Redaction transforms it. § 14.5 rewrites that statement; this reverses it for redaction only.
6. **Not said: a name read by both `envParam()` and `envSecret()`.** Without a refusal, the configuration file would hold a secret (§ 20, decision 11). Will accepted the refusal; § 14.13 adds it to the design.
7. **Consequence not stated: the reproduce command no longer works after a run.** It needs the configuration file, which is deleted when the run ends. It already needed the container and preflight variables the CLI passes, so a user could not run it bare before either; the second process's error now says why (§ 12).
8. **Size.** This is one pull request of nine commits touching core, the CLI, both public packages, the target, the local target, five decision records and three guides. The plan keeps them together, and this spec does too.
9. **Closed: the credential the engine gives the child.** The first amendment found that a `PRISMA_SERVICE_TOKEN` from `prisma login` never reaches Composer, so its redactor could not match it. #383's final API redacts the credential the engine injects before the command's transform runs (§ 9.5).
10. **Closed: an older engine.** A 0.9.0 host ignores `transformOutput` and would print the output unredacted. #383's final API adds `ctx.spawnOptions` and refuses unknown option names from 0.10.0 on, and `prisma deploy` and `prisma dev` now refuse with `DEPS.CLI_ENGINE_INCOMPATIBLE` before starting anything when `transformOutput` is not listed (§ 9.5, test 43).

## Changes since the first version

Made on 2026-11-02, after Will's decisions on the first version.

1. **The relay process is gone.** Under the CLI, the engine's per-stream output transform from prisma/prisma-cli#383 redacts the second process's output (§ 9.5). Removed: `output-relay.ts`, `internal/output-relay` and its entries in both packages, `architecture.config.json` and `tsconfig.depcruise.json`, `resolveOutputRelay`, `DEPLOY.OUTPUT_RELAY_MISSING`, `PRISMA_COMPOSER_REDACTED_VALUES`, the relay tests and fixture, and the relay's mentions in the release note, the error table, ADR-0044, `deploy-cli.md` and the findings. Why: Will chose the engine change over a third process.
2. **The spec pins #383's final API** (head `415c668a`): `transformOutput?: (stream: ChildStreamName) => TransformStream<string, string>`, called once per stream before the child starts; the engine writes the result where the output format sends it, flushes each transform before `ctx.spawn` settles on every path, and redacts the `PRISMA_SERVICE_TOKEN` it injects. Composer maps no stream and handles no output format. Why: #383 replaced the drafted `onOutput` in review.
3. **The redactor is a `StreamRedactor` plus `redactingTransform`** (§ 9.3), in place of `RedactingWriter`. It returns text instead of writing it, so the engine's transform and the in-process pipe share it. It never holds back a complete line when no secret holds a line break. Why: a transform needs the text back, and a long platform wait must not hold back the end of a progress line.
4. **Report ordering and abort are specified** (§ 9.5), with test 40 for the order of held-back text and buffered report events.
5. **`@prisma/cli-engine` goes to 0.10.0** in four places, including the root `pnpm.overrides`, which the first request did not list (§ 8.7). Release order: #383 merges and publishes 0.10.0, then this PR merges; until then it stays a draft.
11. **Composer refuses an older engine.** `prisma deploy` and `prisma dev` check `ctx.spawnOptions?.includes('transformOutput')` first and otherwise fail with the new `DEPS.CLI_ENGINE_INCOMPATIBLE`, before anything starts (§ 9.5, § 12, ADR-0044's registry, test 43; old tests 43 to 50 are now 44 to 51). The errors decision puts it under `DEPS`, the namespace for the consumer's installed dependency tree. Why: a 0.9.0 host ignores the transform and would print secrets.
12. **`STDOUT_TO_STDERR` stays**, against #383's README, because the final API still writes the child's stdout to the CLI's stdout in human format, which carries Composer's data lines in a piped run.
6. **Tests**: 39 to 45 are replaced by four tests, 39 to 42, two of them on the engine's test harness; old tests 46 to 53 are now 43 to 50. Commits gain a first design commit and are renumbered.
7. **Name-based redaction is described as existing S4 behaviour kept for now** in § 2, § 9.1, § 20 decision 5, ADR-0029's rewrite and ADR-0062's edit, not as part of the new design.
8. **The design is corrected** (§ 14.13): `dotenv()` drops `.env.defaults` itself, `secretSource()` takes `secretsKey`, Load refuses a name read by both `envParam()` and `envSecret()`, and the output is redacted through the engine's transform. ADR-0062 gets the same three statements (§ 14.6 items 12 to 14).
9. **Quotes match S10.** `ServiceInputBinding` is `InputBindingUse` in § 5.3; ADR-0029's rewrite says a wrong binding fails to compile; § 19 is rewritten; § 14.9 and § 14.10 no longer count lines that S10 moved.
10. **Two findings raised and closed** (§ 21, 9 and 10): the credential the engine injects, which #383 now redacts itself, and a host on engine 0.9.0, which Composer now refuses.
