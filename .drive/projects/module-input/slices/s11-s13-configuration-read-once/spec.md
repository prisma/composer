# S11 to S13 — Configuration is read once, and no known secret is printed

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Design: [design.md](../../design.md), which is authoritative; these slices build section 8 ("The two adapters that ship", "Which commands run which adapters", "The deploy's two processes", "`prisma dev`'s two processes"), section 9, the section 10 items "The 'pool' names in code" and "The second process's own run of the config adapters", and the section 12 changes to the decisions on secrets, env-sourced params, the `composer` config section, dev secrets and errors, with the glossary. Decisions: [ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md), [ADR-0049](../../../../../docs/design/90-decisions/ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md), [ADR-0058](../../../../../docs/design/90-decisions/ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md), [ADR-0029](../../../../../docs/design/90-decisions/ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md), [ADR-0032](../../../../../docs/design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md) and [ADR-0044](../../../../../docs/design/90-decisions/ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md).

The three slices ship as one pull request. It is built on `claude/module-input-s11-s13`, stacked on prisma/composer#412 (S9 and S10). This spec is grounded in that branch at `78166d80`, which holds S9 and S10; § 19 says what S10 changed.

Release order: this PR needs no engine release. It runs on `@prisma/cli-engine` 0.9.0, the version on `main`. The engine change it once waited for, prisma/prisma-cli#383, was dropped on 2026-11-05 (§ 9.5).

This spec leaves nothing to the implementer's judgement. Every file, type, signature, error message, document edit, test and commit is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 20 lists the decisions this spec takes, and § 21 what it found that the design gets wrong or does not say.

Read for this spec: `CLAUDE.md`; `docs/design/01-principles/`; `design.md` in full; `plan.md`; `spec.md`; the S4, S8 and S9 slice specs; ADR-0029, ADR-0032, ADR-0044, ADR-0049, ADR-0058, ADR-0061 and ADR-0062; the glossary entries Input, Value, Config pool, Secrets pool and Config adapter; `config-params.md`, `deploy-cli.md`, `local-dev.md`; the code each section names; `@prisma/cli-engine` 0.9.0's `ctx.spawn` types; `dotenv-flow` 4.1.0's `lib/dotenv-flow.js`; Alchemy 2.0.0-beta.83's `src/Util/interactive.ts` and `src/Cli/CliKit/layer.ts`.

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
3. It writes the app configuration file, `.prisma-composer/app-configuration-<pid>-<uuid>.json`, mode 0600. It first refuses, with `CONFIG.SECRET_AS_PLAIN_VALUE`, when any value in it would contain a known secret:

   ```json
   {"appConfigurationRead":{"rootInput":[{"path":["EMAIL_FROM"],"value":"shop@example.com"},{"path":["EMAIL_DELIVERY_MODE"],"value":"none"}],"configurationKeyText":{}},"nodeAddresses":["shop","shop.email"]}
   ```

4. It starts the second process with `PRISMA_COMPOSER_APP_CONFIGURATION_FILE` naming that file. The second process runs no adapter. It Loads the graph with what the first process read, without running the root's schema, and refuses to deploy a graph whose node addresses differ from the file's.
5. The second process prints to the terminal, as before this PR; its output is not redacted (§ 9.5). Everything Composer itself prints is redacted, including the second process's failure cause.
6. When the deploy ends, success or failure, the first process deletes the app configuration file. It also deletes it when the process exits. A later run deletes a file left by a process killed outright, once that process is not running and the file is ten minutes old.

What the user sees when an adapter's error holds a known secret:

```text
✘ [CONFIG.ADAPTER_FAILED] `composer.config[0]` failed to read the values for the environment "staging".
  Why: It threw: cannot use token [redacted]
```

`prisma dev` does the same, with `<dev environment dir>/app-configuration-<pid>.json`, and also hands its second process the secrets its local services need, in `PRISMA_COMPOSER_NAMED_SECRETS`, never in a file.

## 2. The model

- **The app configuration** is what the `config` adapters return, merged. **The app secrets** is what the `secrets` adapters return, merged. These names replace "config pool" and "secrets pool" everywhere: in types, functions, options, messages, docs and tests (§ 4).
- **Only the first process runs adapters.** `deploy` and `dev` run both lists; `destroy` runs only `config`. The secrets are read first, then the configuration (§ 7.3).
- **Load records what it read** from the app configuration, as `graph.appConfigurationRead` (§ 5). The app configuration file holds that record and the graph's node addresses. It holds no secrets: Load refuses a name read both by `envParam()` and by `envSecret()`, and a root input field the body passes on whose name an `envSecret()` reads (§ 5.5). The CLI refuses to write the file when any value in it contains a known secret (§ 8.1).
- **The second process Loads with `appConfigurationRead`** instead of `configuration`. Load then takes each root field from the record without running the root's schema, and reads each configuration key from the record's text. A root field the record lacks is an error: the two processes built different graphs (§ 5.4).
- **The second process checks the node addresses.** `lower()` takes `firstProcessNodeAddresses`, read from the app configuration file, and refuses a graph whose addresses differ (§ 6.2).
- **Core knows each secret's name.** `secretSource()` takes `secretsKey`, the app secrets key that holds the secret's value; `envSecret('NAME')` passes `NAME`. Core's `secretsKeys(graph)` lists them. The CLI uses it to know what to redact and, under `prisma dev`, which secrets to hand the second process (§ 6.1).
- **Redaction** (§ 9). A `SecretRedaction` object per command holds two kinds of value. The **known secrets** (`KnownSecrets`) are values Composer knows are secrets: under every name an `envSecret()` in the graph names, the value in the app configuration and in the app secrets, at any length. Nothing else in the app secrets is read, so nothing else is a known secret: the lists are pools of values Composer may carry, read only for the names the graph names. Under `secrets: [dotenv(), environmentVariables()]`, a plain `.env` value and the shell's `SHLVL=1` are not known secrets. The **credential-looking values** only look like secrets by their variable's name: text of eight characters or more under a credential-looking name, in the process environment and the app configuration. That second kind is the redaction S4 shipped, kept for now; it is not part of this design. Every error an operation returns, every thrown defect, every event `prisma dev` emits, the run report, the deploy reporter's message, the deployment summary and the second process's failure cause hide both kinds, and the token shapes S4's redactor finds.
- **The CLI does not redact the second process's output, for now** (§ 9.5). The CLI's engine gives the second process the terminal, as before this PR. For programmatic hosts, `spawnAlchemy` pipes the output in-process through a stream redactor (§ 9.4).
- **`environmentVariables()` no longer reads `PRISMA_COMPOSER_PARENT_VALUES`.** That variable existed so the child's second run of the adapters returned the parent's values. No child runs an adapter now, so it goes. `environmentVariables()` returns the whole process environment, `PRISMA_COMPOSER_` variables included (Will's ruling; § 7.1).

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

/** Reads the process environment when called: every variable whose value is a string. The default for both `config` and `secrets`. */
export function environmentVariables(): ConfigAdapter {
  return () => {
    const values: Record<string, string> = {};
    for (const [name, value] of Object.entries(process.env)) {
      if (typeof value === 'string') values[name] = value;
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
| `ConfigPools` | removed; each use becomes two fields, `configuration: AppConfiguration` and `secrets: AppSecrets` | `PreflightInput`, `LocalTargetAttachment.serve`'s input, `PipelineResult` |
| `PreflightInput.pools` | `PreflightInput.configuration` and `PreflightInput.secrets` | core, target preflight, CLI operations |
| `LocalTargetProvidersInput.pools` | `.configurationKeyText` (the text of each configuration key the graph reads, from the app configuration file) and `.namedSecrets: NamedSecrets` (the app secrets the graph's `envSecret()`s name) | core, local target |
| `serve`'s input `pools` | `configuration` and `secrets` | core, `local-target/attach.ts`, `execute-dev.ts` |
| `localTargetProviders(resolved, containers, devDir, pools)` | `localTargetProviders(resolved, containers, devDir, configurationKeyText, namedSecrets)` | core `control/local-target.ts`, the dev stack file |
| `materializeEnv(devDir, address, port, pools)` | `materializeEnv(devDir, address, port, configuration, secrets)` | `local-target/src/compute.ts`, `attach.ts` |
| `LoadOptions.configPool` | `LoadOptions.configuration` | core `graph-types.ts`, every caller |
| `LowerOptions.configPool` | removed; replaced by `appConfigurationRead` and `firstProcessNodeAddresses` (§ 6.2) | core `control/deploy.ts` |
| `ParamSourceOptions.poolKey` | `ParamSourceOptions.configurationKey` | core `node.ts`, target `param.ts` |
| the `'source'` origin's `poolKey` | `configurationKey` | core `value.ts`, `node.ts`, `resolve-values.ts` |
| `ProvisionedModuleInput.fromConfigPool` | `ProvisionedModuleInput.isRoot` | core `resolve-values.ts`, `load-module.ts` |
| `resolveValues`'s input `configPool` | `configuration` | core `resolve-values.ts` |
| `config-pools.ts`, `readConfigPool`, `readSecretsPool`, `PoolReadInput`, `readPool`, `PoolList` | `app-configuration.ts`, `readAppConfiguration`, `readAppSecrets`, `AdapterReadInput`, `readAdapters`, `AdapterList` | CLI |
| `PipelineResult.pools` | `PipelineResult.configuration` and `PipelineResult.secrets` | CLI `pipeline.ts`, operations |
| `samePools` | `sameValues` | CLI `execute-dev.ts` |
| `poolSecrets` | removed (§ 9.2) | CLI `deployment-summary.ts` |
| `src/exports/pools.ts` (`@internal/cli/pools`) and `packages/9-public/composer/src/exports/internal-pools.ts` (`@prisma/composer/internal/pools`) | removed; § 8.6 adds `internal/app-configuration-file` (`internal-app-configuration-file.ts`) | CLI, public composer |
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
export interface RootInputField {
  /** The key path inside the root's input, such as `['smtp', 'host']`. */
  readonly path: readonly string[];
  /** The real value; absent when it is `undefined`. */
  readonly value?: unknown;
}

/**
 * What a Load read from the app configuration, once the root's schema checked it (ADR-0062).
 * The deploy's and `prisma dev`'s first process writes it to the app configuration file, and
 * their second process Loads with it in place of the app configuration.
 */
export interface AppConfigurationRead {
  /** Each field of the root's input that its body names. Empty when the root declares no input. */
  readonly rootInput: readonly RootInputField[];
  /** The text the app configuration holds for each configuration key a source reads, such as `envParam('NAME')`'s `NAME`. A key the app configuration does not hold, or holds as `''`, is absent. */
  readonly configurationKeyText: Readonly<Record<string, string>>;
}
```

`LoadOptions` becomes a union of two option types over common options, so the compiler refuses a call that passes both (`load-options.test-d.ts`):

```ts
interface CommonLoadOptions {
  readonly id?: NodeId;
  readonly environment?: EnvironmentRealValues;
}

/** Load's options in the first process, or wherever the app configuration is at hand. */
export interface FirstProcessLoadOptions extends CommonLoadOptions {
  /** The app configuration (ADR-0062): what the `config` adapters return. It is the root's input, which the root's schema checks, and what a source with a configuration key, such as `envParam('NAME')`, reads. */
  readonly configuration?: Readonly<Record<string, unknown>>;
  readonly appConfigurationRead?: never;
}

/** Load's options in the deploy's and dev's second process. */
export interface SecondProcessLoadOptions extends CommonLoadOptions {
  readonly configuration?: never;
  /** What the first process's Load read, from the app configuration file. Load takes each root field from it without running the root's schema. */
  readonly appConfigurationRead: AppConfigurationRead;
}

export type LoadOptions = FirstProcessLoadOptions | SecondProcessLoadOptions;
```

`Load` also refuses both at runtime (§ 5.2), for a caller without type checks.

`Graph` gains, after `secretSources`:

```ts
  /** What this Load read from the app configuration (ADR-0062). Empty when Load was given none. */
  readonly appConfigurationRead: AppConfigurationRead;
```

`load-service.ts`'s graph gains `appConfigurationRead: { rootInput: [], configurationKeyText: {} },` after `secretSources: [],`.

### 5.2 `packages/0-framework/1-core/core/src/load-module.ts`, `loadModule`

The root's input block becomes:

```ts
  const moduleInputs: ProvisionedModuleInput[] = [];
  if (opts?.configuration !== undefined && opts.appConfigurationRead !== undefined) {
    throw new LoadError(
      'Load takes configuration, in the first process, or appConfigurationRead, in the second, not both.',
    );
  }
  if (root.inputSchema !== undefined) {
    if (opts?.appConfigurationRead !== undefined) {
      moduleInputs.push({
        moduleAddress: rootId,
        schema: root.inputSchema,
        binding: undefined,
        isRoot: true,
        checked: opts.appConfigurationRead.rootInput,
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

The module-child push in `flatten` sets `isRoot: false` in place of `fromConfigPool: false`. The `resolveValues` call passes `configuration: opts?.configuration` and `appConfigurationRead: opts?.appConfigurationRead` in place of `configPool`. The returned graph gains `appConfigurationRead: resolved.appConfigurationRead,` after `secretSources`.

### 5.3 `packages/0-framework/1-core/core/src/resolve-values.ts`

1. Imports: `type AppConfigurationRead` and `type RootInputField` join the `./graph-types.ts` import.
2. `ProvisionedModuleInput`: `fromConfigPool` and its doc comment become:

   ```ts
     /** True for the root, whose binding is the app configuration. */
     readonly isRoot: boolean;
     /** For the root in the second process: its fields as the first process's root schema produced them. The root's schema does not run. */
     readonly checked?: readonly RootInputField[];
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
     'A module body must build the same graph every time; one that reads the process environment, a file or the clock can build a different one.';
   ```

4. `validateModuleInput`: `entry.fromConfigPool` becomes `entry.isRoot`.
5. `resolveValues`'s input: `readonly configPool: Readonly<Record<string, unknown>> | undefined;` becomes:

   ```ts
     readonly configuration: Readonly<Record<string, unknown>> | undefined;
     readonly appConfigurationRead: AppConfigurationRead | undefined;
   ```

   Its return type gains `readonly appConfigurationRead: AppConfigurationRead;`.
6. At the start of `resolveValues`'s body, `const { environment, configPool } = input;` becomes:

   ```ts
     const { environment } = input;
     const rootFields = new Map<string, RootInputField>();
     const keysRead = new Map<string, { readonly label: string; readonly text: string | undefined }>();
     /** The text the app configuration holds for `key`, recorded; `undefined` when it holds none or `''`. */
     const configurationText = (key: string, label: string, site: ValueBindingSite): string | undefined => {
       let raw: unknown;
       if (input.appConfigurationRead !== undefined) raw = input.appConfigurationRead.configurationKeyText[key];
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
                 `${inputFieldLabel(origin)} of root module "${origin.module}" is not in the app configuration file. The first process's root body did not pass it on, so the deploy's two processes built different graphs. ${SAME_GRAPH_ADVICE}`,
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
10. New closure inside `resolveValues`, after `validatedInputOf`: `appConfigurationReadOf(inputBindings, params, secretSources)`, with `rootModuleAddress()` declared before it. When Load has a `configuration` or an `appConfigurationRead`, it reads, through `configurationText`, the configuration key of every param source (`sourceKind: 'param'`) left in a service's input binding or a service param. Then, for each secret source (`sourceKind: 'secret'`) with a `secretsKey`, it throws a `LoadError` when a configuration key read the same name, and when a recorded root field's first path segment is that name (§ 12 has both messages). Then it throws when a recorded root field holds a value JSON cannot hold exactly. It returns `{ rootInput: [...rootFields.values()], configurationKeyText }`, where `configurationKeyText` holds each recorded key's text. The code is in `packages/0-framework/1-core/core/src/resolve-values.ts`.
11. Both returns of `resolveValues` gain `appConfigurationRead`. The early return becomes:

    ```ts
      if (found.length === 0) {
        for (const [address, props] of authoredProps) refusePointersInProps(address, props);
        const secretSources = secretSourcesReceivedBy(input.inputBindings, input.params);
        return {
          inputBindings: input.inputBindings,
          params: input.params,
          resourceProps: authoredProps,
          secretSources,
          appConfigurationRead: appConfigurationReadOf(input.inputBindings, input.params, secretSources),
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
        appConfigurationRead: appConfigurationReadOf(inputBindings, params, secretSources),
      };
    ```

### 5.4 What Load does in each process

| | First process: `{ configuration }` | Second process: `{ appConfigurationRead }` |
| --- | --- | --- |
| The root's schema | runs over the whole app configuration | does not run |
| A root field the body names | read from the schema's output, recorded | taken from `appConfigurationRead.rootInput`; missing is a `LoadError` |
| A configuration key read in a module's input or a `resolve()` | read from `configuration`, recorded | read from `appConfigurationRead.configurationKeyText` |
| A configuration key in a service's input or a service param | read and recorded after resolution; non-text is a `LoadError` | read from `appConfigurationRead.configurationKeyText` |
| A key read as both a configuration key and a secrets key | `LoadError` | `LoadError` |
| A root field the body passes on whose name a secrets key reads | `LoadError` | `LoadError` |
| Both `configuration` and `appConfigurationRead` | refused by the type, and by a `LoadError` at runtime | the same |
| A recorded root field JSON cannot hold | `LoadError` | cannot happen: the values came from JSON |

### 5.5 `node.ts` and `value.ts`

1. `value.ts`: the `'source'` origin splits in two by `sourceKind`, so each kind has exactly one key. `sourceKind: 'param'` carries `configurationKey: string | undefined` (in place of `poolKey`), the app configuration key whose text at deploy is the real value, as for `envParam()`. `sourceKind: 'secret'` carries `secretsKey: string | undefined`, the app secrets key that holds the secret's value, as for `envSecret()`. Both keep `label` and the non-enumerable `source`.

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

   and its origin literal becomes `{ kind: 'source', sourceKind: 'secret', label, secretsKey }`.
4. `paramSource`: `poolKey` becomes `configurationKey` throughout; the two messages become `'paramSource() configurationKey must be a non-empty string.'` and `'paramSource() takes configurationKey, for a value known at deploy, or redacted, for a secret known only at boot, not both.'`; its origin literal becomes `{ kind: 'source', sourceKind: 'param', label, configurationKey }`.
5. `sourceMisuse`: `origin.poolKey === undefined` becomes `origin.sourceKind === 'secret' || origin.configurationKey === undefined`.
6. `ParamSource`'s doc comment: `known at deploy when it names a config pool key (\`envParam\`)` becomes `known at deploy when it names an app configuration key (\`envParam\`)`.
7. `exports/index.ts`: the `../node.ts` type export gains `SecretSourceOptions`; the `../graph.ts` type export gains `AppConfigurationRead` and `RootInputField`.

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

`graph.ts` imports `sourceOriginOf` from `./node.ts`. `secretsKeys` takes `secretsKey` only from an origin with `sourceKind: 'secret'`. `exports/deploy.ts` (`@internal/core/deploy`, republished as `@prisma/composer/deploy`) exports `nodeAddresses` and `secretsKeys`; they are not on the main entry.

### 6.2 `packages/0-framework/1-core/core/src/control/deploy.ts`

1. `LowerOptions.configPool` and its doc comment are replaced by:

   ```ts
     /** What the first process's Load read from the app configuration (ADR-0062), from the app configuration file. Load takes the root's input and every configuration key's text from it, and the Prisma Cloud serializer reads a service's `envParam()` leaves from its `configurationKeyText`. The generated stack files pass it. */
     readonly appConfigurationRead?: AppConfigurationRead;
     /** The node addresses of the graph the first process built. When given, lowering refuses a graph whose addresses differ. The generated stack files pass them. */
     readonly firstProcessNodeAddresses?: readonly string[];
   ```

2. In `lowering`, the `Load` call's `...(opts.configPool !== undefined ? { configPool: opts.configPool } : {})` becomes `...(opts.appConfigurationRead !== undefined ? { appConfigurationRead: opts.appConfigurationRead } : {})`, and directly after the `Load` call:

   ```ts
       if (opts.firstProcessNodeAddresses !== undefined) {
         assertSameNodeAddresses(nodeAddresses(graph), opts.firstProcessNodeAddresses);
       }
   ```

3. New module-private function, after `LowerError`:

   ```ts
   function assertSameNodeAddresses(built: readonly string[], firstProcess: readonly string[]): void {
     const onlyBuilt = built.filter((address) => !firstProcess.includes(address));
     const onlyFirst = firstProcess.filter((address) => !built.includes(address));
     if (onlyBuilt.length === 0 && onlyFirst.length === 0) return;
     const list = (addresses: readonly string[]) =>
       addresses.length === 0 ? 'none' : addresses.map((address) => `"${address}"`).join(', ');
     throw new LowerError(
       `The deploy's second process built a different graph from the one Composer checked in its first process. Only in the second process: ${list(onlyBuilt)}. Only in the first process: ${list(onlyFirst)}. A module body must build the same graph every time; one that reads the process environment, a file or the clock can build a different one.`,
     );
   }
   ```

   `deploy.ts` imports `nodeAddresses` from `../graph.ts` and the type `AppConfigurationRead` from `../graph-types.ts`. Core's `process.env` count stays `control/deploy.ts`, 2 (`invariants.test.ts` is unchanged): the addresses reach `lower()` as an option, read by the stack file from the app configuration file, and the messages say "the process environment", not `process.env`, because the invariant counts the text.

### 6.3 `control/app-config.ts`

1. `ConfigPool`, `SecretsPool` and `ConfigPools` and their doc comments are replaced by:

   ```ts
   /** The app configuration (ADR-0062): what the `config` adapters return, merged by top-level key, a later adapter winning. It is the root's input, and what `envParam()` reads. */
   export type AppConfiguration = Readonly<Record<string, unknown>>;

   /** The app secrets (ADR-0062): what the `secrets` adapters return, merged the same way. Every value is text. Preflight fills a missing `envSecret()` platform variable from it, and `prisma dev` hands its second process the values the graph's `envSecret()`s name. Composer redacts its values wherever it prints. */
   export type AppSecrets = Readonly<Record<string, string>>;
   ```

2. `ConfigAdapter`'s doc comment becomes: `A function in the \`config\` or \`secrets\` list of the \`composer\` section (ADR-0062): it receives the environment and returns that environment's values. Only the command's first process calls it; the second process reads what the first process's Load read from the app configuration file.`
3. `PrismaAppConfig`'s doc comment's last sentence becomes `` `config` and `secrets` list the adapters the app configuration and the app secrets come from. ``; `config`'s member comment becomes `Where the app configuration comes from. …` and `secrets`' `Where the app secrets come from. …`, the rest unchanged.
4. `PreflightInput.pools` is replaced by:

   ```ts
     /** The app configuration the command read for this environment. Preflight fills a missing `envParam()` param's platform variable from it. */
     readonly configuration: AppConfiguration;
     /** The app secrets the command read for this environment. Preflight fills a missing `envSecret()` platform variable from it. */
     readonly secrets: AppSecrets;
   ```

5. `LocalTargetProvidersInput.pools` is replaced by `configurationKeyText: Readonly<Record<string, string>>`, `The text of each configuration key the graph reads, from the app configuration file. A local deployment takes the text its param rows point at from it.`, and `namedSecrets: NamedSecrets`, `The app secrets the graph's \`envSecret()\`s name, which the first process handed the second. A local deployment takes the text its \`$secret\` pointers name from it.` `app-config.ts` exports `type NamedSecrets = Readonly<Record<string, string>>`, the subset of the app secrets under the graph's secrets keys.
6. `serve`'s `pools` member is replaced by `configuration: AppConfiguration` and `secrets: AppSecrets`, commented `The app configuration the command read for this environment.` and `The app secrets the command read for this environment.`
7. `control/local-target.ts`: `localTargetProviders`'s fourth parameter becomes `configurationKeyText: Readonly<Record<string, string>>`, a fifth `namedSecrets: NamedSecrets` follows, and the call becomes `descriptor.providers({ container: containers.get(id), devDir, configurationKeyText, namedSecrets })`.

## 7. CLI: reading the app configuration and the app secrets

### 7.1 `config-adapters.ts`

§ 3.2.

### 7.2 `app-configuration.ts` (renamed from `config-pools.ts`)

`git mv src/config-pools.ts src/app-configuration.ts`, then:

1. The type imports become `ConfigAdapter`, `AppConfiguration`, `AppSecrets`, `PrismaAppConfig` from `@internal/core/config`.
2. `PoolReadInput` becomes `AdapterReadInput`, doc comment `What the adapters are read for.`; `PoolList` becomes `AdapterList`; `isText(pool)` becomes `isText(values): values is AppSecrets`; `readPool` becomes `readAdapters`, and its local `pool` becomes `merged`.
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
    * return: the app secrets. Every value must be text. A value is a known secret only once the graph
    * names it, so this adds none.
    */
   export async function readAppSecrets(
     section: PrismaAppConfig,
     input: AdapterReadInput,
   ): Promise<AppSecrets> {
     const merged = await readAdapters('secrets', section.secrets ?? [environmentVariables()], input);
     if (!isText(merged)) throw new InternalError('readAdapters admitted a secret that is not text');
     return merged;
   }
   ```

   Whether the section writes its own `secrets` list makes no difference to what is known: the known secrets come from the graph (§ 9.1).

   The error messages of § 4.3 of the S4 spec do not change.

### 7.3 `pipeline.ts`

1. Imports: `type ConfigPools` becomes `type AppConfiguration, type AppSecrets`; `readConfigPool, readSecretsPool` from `./config-pools.ts` become `readAppConfiguration, readAppSecrets` from `./app-configuration.ts`; new imports `secretsKeys` from `@internal/core/deploy` and `credentialLookingValues, SecretRedaction, valuesUnderSecretsKeys` from `./redaction.ts`.
2. `PipelineDeps.readSecrets`'s comment becomes `Read the app secrets too: \`deploy\` and \`dev\` do; \`destroy\` does not, and its \`secrets\` is empty.` It gains:

   ```ts
     /** Collects every secret value the run reads, for redaction. A new one over the process environment when not given. */
     readonly redaction?: SecretRedaction | undefined;
   ```

3. `PipelineResult.pools` is replaced by:

   ```ts
     /** The app configuration read for this run. In memory only; the app configuration file holds only what Load read from it. */
     readonly configuration: AppConfiguration;
     /** The app secrets read for this run. In memory only: never written to a file, an event, a result or a report. */
     readonly secrets: AppSecrets;
   ```

4. Step 3 of `runPipeline` becomes:

   ```ts
     // 3. Read the app secrets, then the app configuration.
     const redaction = deps.redaction ?? new SecretRedaction(process.env);
     const adapterInput = { environment, configFile: configSource.file };
     const secrets: AppSecrets =
       deps.readSecrets === true ? await readAppSecrets(config, adapterInput) : NO_SECRETS;
     const configuration = await readAppConfiguration(config, adapterInput);
     redaction.addCredentialLookingValues(credentialLookingValues(configuration));
   ```

5. Step 4's `configPool: pools.config` becomes `configuration`. Directly after the `ROOT_NOT_MODULE` check:

   ```ts
     redaction.addKnownSecrets(valuesUnderSecretsKeys(configuration, secrets, secretsKeys(graph)));
   ```

6. The return becomes `return { configSource, entryModule, graph, name, assembled, configuration, secrets };`.

## 8. CLI: the app configuration file and the second process

### 8.1 New file `packages/0-framework/3-tooling/cli/src/app-configuration-file.ts`

The first process's handover to the second, and the second process's reading of it, in one module. It imports `node:fs`, `node:path`, `DEV_DIR` and the types it needs, and no value from core's main entry or `@prisma/cli-engine`, because the generated stack files import it in the second process. Its exports:

- `APP_CONFIGURATION_FILE_ENV = 'PRISMA_COMPOSER_APP_CONFIGURATION_FILE'`, which names the file, and `NAMED_SECRETS_ENV = 'PRISMA_COMPOSER_NAMED_SECRETS'`, which carries the named secrets under `prisma dev` only.
- `interface AppConfigurationFile { appConfigurationRead: AppConfigurationRead; nodeAddresses: readonly string[] }`: what the file holds, as JSON.
- `deployAppConfigurationFile(cwd, runId)`: `.prisma-composer/app-configuration-<pid>-<runId>.json`, unique per run. `devAppConfigurationFile(devDir)`: `<dev environment dir>/app-configuration-<pid>.json`.
- `LEFTOVER_APP_CONFIGURATION_FILE_AGE_MS = 10 * 60 * 1000`.
- `removeLeftoverAppConfigurationFiles(cwd)`: deletes the app configuration files in `.prisma-composer/` and in each dev environment folder whose process id (from the file name) is not this process, is not running (`process.kill(pid, 0)`; `EPERM` counts as running), and whose file is older than `LEFTOVER_APP_CONFIGURATION_FILE_AGE_MS`. The age check keeps the file of a run in a container or on another machine that shares the folder but not the process ids. Never throws.
- `prepareSecondProcess({ file, appConfigurationRead, nodeAddresses, secretsKeys, knownSecrets: KnownSecrets, appSecrets? })` returns a `SecondProcessHandover { env; writeFile(); removeFile() }`. It first refuses, with `refuseSecretsIn`, a file that would hold a known secret. `env` holds `APP_CONFIGURATION_FILE_ENV`, and, when `appSecrets` is given (only `prisma dev` gives it), `NAMED_SECRETS_ENV` with the app secrets under `secretsKeys` that hold text. `writeFile()` replaces any file at `file` with the JSON, mode 0600, and registers a `process.on('exit')` handler that deletes it with `fs.rmSync`; writing again does not register a second handler. `removeFile()` removes the handler and deletes the file, and never throws.
- `refuseSecretsIn(read, knownSecrets)`, module-private: walks every root input field's value and every configuration key's text. A string is checked as it is; a number, a boolean or a bigint as `String(value)`. When `knownSecrets.appearIn(text)` finds a known secret anywhere in one, it throws `CONFIG.SECRET_AS_PLAIN_VALUE` (§ 12), naming the field, never the value.
- `readAppConfigurationFile(env): AppConfigurationFile` (second process): throws `missingVariable(APP_CONFIGURATION_FILE_ENV, 'names the app configuration file it wrote there')` when the variable is unset or `''`; a read error throws `Could not read the app configuration file ${file}: ${message}. Composer deletes it when the run ends, so a stack file run by hand after that cannot read it; run the command again.`; a file that does not have the expected shape throws `The app configuration file ${file} is not one Composer wrote: <what>.`, where `<what>` is `it is not JSON`, `appConfigurationRead is not an object`, `rootInput is not a list of fields`, `configurationKeyText is not an object of text` or `nodeAddresses is not a list of node addresses`. It rebuilds the data with type guards, without a cast.
- `namedSecretsFromEnvironment(env): NamedSecrets` (second process, `prisma dev`): throws `missingVariable(NAMED_SECRETS_ENV, 'hands the secrets the local services need there')` when unset, and `PRISMA_COMPOSER_NAMED_SECRETS is not a JSON object of text.` when malformed; otherwise returns a frozen object with no prototype.

`missingVariable(name, what)` is module-private and returns `` `${name} is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which ${what}.` ``.

`prepareSecondProcess` and `KnownSecrets` are also exported from `@internal/cli/testing` (republished as `@prisma/composer-cli/testing`), so the integration tests hand over to the second process the way the CLI does.

### 8.2 The generated deploy stack file, `generate-stack.ts`

`renderOptions` passes `appConfigurationRead: file.appConfigurationRead` and `firstProcessNodeAddresses: file.nodeAddresses` in place of `configPool`. The template imports `readAppConfigurationFile` from `@prisma/composer/internal/app-configuration-file`, starts the failure recorder (`report.captureEngineFailure?.()`) first, so a missing app configuration file is recorded as the cause, then reads `const file = readAppConfigurationFile(process.env);`. The header says the stack file runs no config adapter and reads what the first process's Load read from the app configuration file named in `PRISMA_COMPOSER_APP_CONFIGURATION_FILE`.

### 8.3 The generated dev stack file, `dev/generate-dev-stack.ts`

The same two options as § 8.2, and `providers: localTargetProviders(resolved, containers, devDir, file.appConfigurationRead.configurationKeyText, namedSecrets)`. It imports `namedSecretsFromEnvironment` and `readAppConfigurationFile` from `@prisma/composer/internal/app-configuration-file`, and reads `const file = readAppConfigurationFile(process.env);` and `const namedSecrets = namedSecretsFromEnvironment(process.env);`. The header says it runs no config or secrets adapter.

### 8.4 `operations/execute-deploy-destroy.ts`

1. `StackPipelineOptions` gains `readonly redaction: SecretRedaction;`. `executeDeploy` and `executeDestroy` pass `redaction: new SecretRedaction(process.env)`, and `pipelineDeps` passes it on.
2. `extension.preflight({ …, pools: pipeline.pools, … })` becomes `configuration: pipeline.configuration, secrets: pipeline.secrets,`.
3. At the start of the run, `removeLeftoverAppConfigurationFiles(cwd)`.
4. Inside the try that writes the stack file: `handover = prepareSecondProcess({ file: deployAppConfigurationFile(cwd, randomUUID()), appConfigurationRead: pipeline.graph.appConfigurationRead, nodeAddresses: nodeAddresses(pipeline.graph), secretsKeys: secretsKeys(pipeline.graph), knownSecrets: opts.redaction.knownSecrets })`, then the stack file, then `handover.writeFile()`. `nodeAddresses` and `secretsKeys` come from `@internal/core/deploy`. A `CONFIG.SECRET_AS_PLAIN_VALUE` refusal is returned as it is; a write failure is `DEPLOY.STACK_WRITE_FAILED`, as for the stack file.
5. `alchemyInvocation`'s `env` is `{ ...reporterChildEnv(reporters, opts.redaction), ...handover.env, [DEPLOYMENT_RESULT_FILE_ENV]: resultFilePath }`, and `redactedValues: opts.redaction.allValues()`.
6. `readEngineFailureCause(resultFilePath, poolSecrets(…))` becomes `readEngineFailureCause(resultFilePath, (text) => opts.redaction.redact(text))`.
7. `return ok(readDeploymentSummary(resultFilePath));` becomes `return ok(redactSummary(readDeploymentSummary(resultFilePath), opts.redaction));`.
8. The `finally` calls `handover?.removeFile();` after removing the result files.
9. `runStackPipeline`:
    - The `catch (error)` that records a defect: `const thrown = redactThrown(error, opts.redaction);` first. The reporters get `thrown.message`, and the catch rethrows `thrown`.
    - After `runStackPipelineInner` returns: `if (!outcome.ok) outcome = notOk(redactError(outcome.failure, opts.redaction));`. The run report, the reporters' `errorMessage` and the returned failure all read the redacted failure.
10. `beginReporters`, `attachReporters`, `finishReporters` and `reporterChildEnv` take a last parameter `redaction: SecretRedaction`, and each `console.warn` passes `redaction.redact(detail)` in place of `detail`.

### 8.5 `operations/execute-dev.ts`

1. `executeDev`'s body moves into a module-private `executeDevInner(input, deps, cwd, redaction: SecretRedaction)`. `executeDev` builds `const redaction = new SecretRedaction(process.env);`, returns `notOk(redactError(result.failure, redaction))` for a failure, and in its catch rethrows `redactThrown(error, redaction)`.
2. At the start, `removeLeftoverAppConfigurationFiles(cwd)`.
3. `emit` passes each event through `redactDevEvent(event, redaction)`.
4. `samePools` becomes `sameValues(started: PipelineResult, now: PipelineResult)`, comparing `configuration` and `secrets` with `isDeepStrictEqual`.
5. `pipelineDeps` and `watchDeps` pass `redaction`.
6. `dev.preflight` and `serve` take `configuration: pipeline.configuration, secrets: pipeline.secrets` in place of `pools`.
7. The constant `invocation` goes. `invocationFor(p: PipelineResult)` returns `{ invocation, handover }`: the handover is `prepareSecondProcess({ file: devAppConfigurationFile(devDir), appConfigurationRead: p.graph.appConfigurationRead, nodeAddresses: nodeAddresses(p.graph), secretsKeys: secretsKeys(p.graph), knownSecrets: redaction.knownSecrets, appSecrets: p.secrets })`, and the invocation passes `env: handover.env` and `redactedValues: redaction.allValues()`.
8. `converge(p)` writes the dev stack file and calls `handover.writeFile()` in one try (both `DEV.STACK_WRITE_FAILED`), runs the converge, and calls `handover.removeFile()` in a `finally`. It returns `{ outcome, stackPath, invocation }`. The first converge and each rebuild call it; a rebuild's `converge-failed` event uses the returned invocation for `reproduceCommand`, and a `CliStructuredError` it throws is emitted as `rebuild-failed`.

The dev app configuration file lives only while a converge runs, which is shorter than the design's "deleted when `prisma dev` stops" (§ 20, decision 9).

### 8.6 Entries and packaging

1. `packages/0-framework/3-tooling/cli/src/exports/pools.ts` is deleted. New `src/exports/app-configuration-file.ts` exports `namedSecretsFromEnvironment` and `readAppConfigurationFile`, with the doc comment `What the generated stack files read in the second process. Not public API: published as \`@prisma/composer/internal/app-configuration-file\`, it may change in any release.`
2. `packages/0-framework/3-tooling/cli/tsdown.config.ts`: the entry `pools` becomes `'app-configuration-file': 'src/exports/app-configuration-file.ts'`. `pnpm --filter @internal/cli build` regenerates `package.json#exports`; commit the regenerated file, do not hand-edit it.
3. `packages/9-public/composer/src/exports/internal-pools.ts` is deleted. New `internal-app-configuration-file.ts`: `export * from '@internal/cli/app-configuration-file';`. Its tsdown entry is `'internal-app-configuration-file'`, and `package.json#exports` has `"./internal/app-configuration-file": "./dist/internal-app-configuration-file.mjs"`. `architecture.config.json` and `tsconfig.depcruise.json` name the new file.
4. `nodeAddresses` and `secretsKeys` are exported from core's `deploy` entry, `@prisma/composer/deploy`, not from the main entry.
5. `@internal/cli/testing` exports `prepareSecondProcess`, the type `SecondProcessHandover`, and `KnownSecrets`; `@prisma/composer-cli/testing` republishes them.

### 8.7 The engine version

`@prisma/cli-engine` stays at `0.9.0`, the version on `main`, in every manifest, the root `pnpm.overrides` and the lockfile. `pnpm check:cli-engine-pin` passes unchanged. No command checks the engine's version.

## 9. CLI: Composer redacts every secret it knows

### 9.1 What a command knows

One `SecretRedaction` per command holds two kinds of value. The known secrets are in its `knownSecrets` (`KnownSecrets`); the credential-looking values are kept beside them.

| Values | Kind | When they are added | Length |
| --- | --- | --- | --- |
| Under each name `secretsKeys(graph)` lists, the value in the app configuration and the value in the app secrets (`valuesUnderSecretsKeys`) | known secret | after Load | any |
| Text under a credential-looking name (`credentialLookingValues`) in the process environment. Existing S4 behaviour, kept for now; not part of this design | credential-looking | when the `SecretRedaction` is built | eight characters or more |
| Text under a credential-looking name in the app configuration. The same S4 behaviour | credential-looking | after the app configuration is read | eight characters or more |

`SecretRedaction.redact(text)` replaces every value of both kinds, then the token shapes S4's redactor finds: bearer and basic tokens, JWTs, a password in a URL, and `token=…` pairs. The stream redactor that `spawnAlchemy` uses for programmatic hosts (§ 9.4) uses exact values only: `allValues()`. The app configuration file check (§ 8.1) uses only the known secrets, so a plain value that merely equals a credential-looking variable is not refused.

### 9.2 `deployment-summary.ts`

1. `import type { ConfigPools } from '@internal/core/config';` goes, and `poolSecrets` is removed.
2. `readEngineFailureCause(resultFilePath, redact: (text: string) => string)` passes the recorded cause through `redact` in place of a list of values. The child redacts only what its own environment names as a credential; the parent knows every secret the command read.
3. The child's own failure capture, `captureEngineFailure` and `engineFailureCause`, uses `redactCredentialLooking(text, env)` from `./redaction.ts`, because the second process has no `SecretRedaction`.

The redaction primitives move to `redaction.ts` (§ 9.3). `deployment-summary.ts` still imports nothing heavy, so the `report` entry stays light.

### 9.3 New file `packages/0-framework/3-tooling/cli/src/redaction.ts`

Every redaction primitive lives here, over one `SecretMatcher`. The code is the source; this lists what each export does.

- `REDACTED = '[redacted]'`.
- `credentialLookingValues(variables)`: the credential-looking values in a record, text of eight characters or more under a name `SECRET_ENV_NAME` matches. It serves both the process environment and the app configuration.
- `SecretMatcher(values)`: one regular expression over every non-empty value, built once. `spans(text)` returns the merged `[start, end)` span of every secret in the text: at each position the longest secret that starts there, and overlapping spans merged, so two overlapping secrets are hidden whole. `startOfSecretAtEnd(text)` returns the length of the longest end of the text that is the start, not the whole, of a secret. `redact(text)` replaces each span with `[redacted]`.
- `redactValues(text, values)`: `new SecretMatcher(values).redact(text)`.
- `redactCredentialLooking(text, env)`: the credential-looking values of `env`, then the token shapes: bearer and basic tokens, JWTs, a password in a URL, and `token=…` pairs. For a process that has no `SecretRedaction`, such as the second process's failure capture.
- `KnownSecrets`: the known secrets of one command, values Composer knows are secrets. `add(values)` skips empty ones; `values()` returns the set; `appearIn(text)` says whether a known secret appears anywhere in the text. It has a private field, so a plain `Set` cannot stand in for it, and `prepareSecondProcess` can only be given the known secrets.
- `SecretRedaction(env)`: what one command hides. It starts with `credentialLookingValues(env)`. `knownSecrets` is its `KnownSecrets`; `addKnownSecrets(values)` and `addCredentialLookingValues(values)` add each kind; `allValues()` returns both kinds, longest first; `redact(text)` replaces both kinds, then the token shapes. It rebuilds its matcher when a value was added since the last call.
- `valuesUnderSecretsKeys(configuration, secrets, secretsKeys)`: the text under each secrets key, in the app configuration and in the app secrets, at any length.
- `redactError(error, redaction)`: a new `CliStructuredError` with the summary, `why`, `fix` and every string in `meta` redacted; the code, severity, `where` and docs link kept; the cause dropped, because it holds the same text unredacted.
- `redactThrown(thrown: unknown, redaction): Error`: the error to rethrow in place of a thrown defect. A thrown value that is not an `Error`, such as a string or a plain object, becomes an `Error` whose message is its redacted text. It redacts the message and stack of the error, of each error in its `cause` chain and of each member of an `AggregateError`, and turns a cause that is text or plain data into a redacted copy. It sets each property with `Object.defineProperty`, which works on a `DOMException`, whose `message` has only a getter. When even that fails, as for a frozen error, it returns a new `Error` (or `AggregateError`) with the same name and the redacted message, stack and cause. It never throws: a `message` that is not text is redacted as text, and when reading the error fails at all, as for a getter that throws or a revoked proxy, it returns a new `Error` holding the redacted text of what was thrown, or a fixed sentence when even that text cannot be read.
- `redactDevEvent(event, redaction)`: the event with its message, or a dev server's output line, redacted.
- `redactSummary(summary, redaction)`: each entity's id, url and details redacted.
- `StreamRedactor(values)`: redacts a stream chunk by chunk with the same matcher. `push(chunk)` returns the text that is ready and holds back only the end that could still be part of a secret: the longest end that could start one, or a match a later secret could extend. It never splits a surrogate pair. `end()` returns the rest, redacted.

## 9.4 `run-alchemy.ts`

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
       const stdout = new StreamRedactor(redactedValues);
       const stderr = new StreamRedactor(redactedValues);
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

   It imports `StreamRedactor` from `./redaction.ts`. `redactedValues` already holds the credential-looking values of the process environment, because the command's `SecretRedaction` starts with them.
4. `spawnAlchemy` becomes `return { ...(await spawnCommandLine(commandLine, invocation.redactedValues)), commandLine };`, and its doc comment's "inherited stdio" becomes "stdin inherited and output piped through redaction".
5. The file header's "hand the terminal to the generated stack file" becomes "run the generated stack file, with its output piped through redaction".

### 9.5 The second process's output, under the CLI

Under the CLI the second process's output is not redacted, for now. The CLI's command engine gives the second process the terminal, so Composer never sees Alchemy's output. Redacting it needed a change to the engine, prisma/prisma-cli#383, which let a command transform a child's output. Will dropped that change on 2026-11-05: Composer will soon run Alchemy through its programmatic API, in its own process, which removes the second process and with it this problem (design.md section 9, "The second process's output is not redacted, for now"). Until then Alchemy's output prints as it did before this PR. The redactor still covers everything Composer itself prints, including the second process's failure cause (§ 9.2).

`family/converge.ts`, `commands/deploy.ts` and `commands/dev.ts` are as on `main`: `convergeSpawn` passes `ctx.spawn` the command, arguments, working directory and environment, and nothing else. The secret values never reach the child's environment or command line. `STDOUT_TO_STDERR` and its doc comment are unchanged. `destroy` has no CLI command (ADR-0050); the programmatic operations pipe in-process through the stream redactor (§ 9.4).

## 10. The Prisma Cloud target and the local target

1. `packages/1-prisma-cloud/1-extensions/target/src/param.ts`: in `envParam`, `{ label: \`envParam('${name}')\`, poolKey: name }` becomes `{ label: \`envParam('${name}')\`, configurationKey: name }`; the doc comment's "the variable's value in the config pool" becomes "the variable's value in the app configuration".
2. `secret.ts`: in `envSecret`, `{ label: \`envSecret('${name}')\` }` becomes `{ label: \`envSecret('${name}')\`, secretsKey: name }`.
3. `git mv pool-text.ts configuration-text.ts`; the function becomes `configurationText(configuration: Readonly<Record<string, unknown>>, name: string, notText: (kind: string) => Error): string | undefined`, doc comment `The text the app configuration holds for \`name\`, as an environment variable would: \`undefined\` when it is absent or empty. Throws the error \`notText\` builds when it holds anything else there.` Its three importers (`serializer.ts`, `preflight.ts`, `local-target/preflight.ts`) import and call it by the new name.
4. `serializer.ts`: `SerializeInputOptions.env`'s doc comment becomes `Where \`envParam\` leaves are read: the app configuration, or in the second process the configuration key text from the app configuration file. The process environment when not given.`
5. `descriptors/compute.ts`: `...(ctx.opts.configPool !== undefined ? { env: ctx.opts.configPool } : {}),` becomes `...(ctx.opts.appConfigurationRead !== undefined ? { env: ctx.opts.appConfigurationRead.configurationKeyText } : {}),`.
6. `preflight.ts`: `poolValue` becomes `valueOf`; `input.pools.secrets[meta.name]` becomes `input.secrets[meta.name]`; `poolText(input.pools.config, …)` becomes `configurationText(input.configuration, …)`; the doc comments use § 4.2's words.
7. `preflight-names.ts`: `/** An env-sourced param's config pool value that preflight cannot write to a platform variable. */` becomes `/** An env-sourced param's app configuration value that preflight cannot write to a platform variable. */`.
8. `local-target/preflight.ts`: `const env = input.pools.config;` becomes `const env = input.configuration;`; `input.pools.secrets[name]` becomes `input.secrets[name]`; the header's first sentence becomes `Every value comes from what the command read: secrets from the app secrets, env-sourced params from the app configuration.`
9. `local-target/attach.ts`: `serve: async ({ address, node, server, pools }) =>` becomes `serve: async ({ address, node, server, configuration, secrets }) =>`, and its `materializeEnv(…, pools)` becomes `materializeEnv(input.devDir, address, instance.port, configuration, secrets)`.
10. `packages/1-prisma-cloud/0-lowering/local-target/src/compute.ts`: `materializeEnv`'s last parameter `pools: ConfigPools` becomes `configuration: Readonly<Record<string, unknown>>, secrets: Readonly<Record<string, string>>`; `pools.secrets[name]` becomes `secrets[name]` and `pools.config[name]` becomes `configuration[name]`; the provider's call passes `input.configurationKeyText, input.namedSecrets`.
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

In the dev second process, the providers get `configurationKeyText`, the text of each configuration key the graph reads, which is every name a param row points at, and `namedSecrets`, what `PRISMA_COMPOSER_NAMED_SECRETS` holds, every name a `$secret` pointer names.

## 11. What breaks, and what does not

Breaks:

1. `LoadOptions.configPool` is now `configuration`. `LoadOptions` is now a union, `FirstProcessLoadOptions | SecondProcessLoadOptions`, so `interface X extends LoadOptions` stops compiling. `LowerOptions.configPool` is gone; a hand-written stack passes `appConfigurationRead` or nothing.
2. `paramSource()`'s `poolKey` option is now `configurationKey`.
3. `ConfigPool`, `SecretsPool` and `ConfigPools` are now `AppConfiguration` and `AppSecrets`; `PreflightInput` and a local attachment's `serve` input take `configuration` and `secrets` in place of `pools`; `LocalTargetProvidersInput` takes `configurationKeyText` and `namedSecrets`, and `localTargetProviders()` takes them as two arguments. This touches extension authors only.
4. `@prisma/composer/internal/pools` is gone. It was not public API.
5. `dotenv()` now skips `.env.local` for the environment `test`, and parses with `dotenv` 16 through `dotenv-flow`.
6. Under the CLI the deploy engine's output is not redacted (§ 9.5). A programmatic host's `spawnAlchemy` pipes it through the stream redactor, so there Alchemy shows plain progress lines, without colour or a live progress display.
7. A known secret is redacted at any length. A one-character secret blanks that character everywhere in the output.
8. A module body that builds a different graph in the second process fails the deploy, naming the addresses.
9. A root field whose real value JSON cannot hold exactly, such as a `Date`, fails the Load in the first process.
10. A name read both by `envParam()` and by `envSecret()` fails the Load, and so does a root input field the body passes on whose name an `envSecret()` reads.
11. The CLI refuses to write the app configuration file, with `CONFIG.SECRET_AS_PLAIN_VALUE`, when any value in it contains a known secret, whole or inside a longer value.
12. `environmentVariables()` returns the whole process environment, `PRISMA_COMPOSER_` variables included.
13. An `envParam()` in a service's input or params whose app configuration value is not text fails at Load, in the first process. Before, it failed later, in the serializer or preflight.
14. A config adapter now runs after the secrets adapters, so a broken secrets adapter is reported before a broken config adapter.
15. Only the values under the names an `envSecret()` in the graph names are known secrets. With a written `secrets` list, its other values are neither redacted nor refused in the app configuration file. Before, every value a written list returned was redacted.
16. The app's `@prisma/composer` must be at least the version that ships `internal/app-configuration-file`; with an older one the second process fails when it imports the stack file.

Unchanged:

1. A project with neither `config` nor `secrets` reads the shell, as before, in the first process.
2. The input document, the pointer rows, the `$secret` pointers and every deploy's resources.
3. Every error message not listed in § 12.

The only existing tests this PR changes are those § 15.1 lists. If any other existing test fails, the implementer stops and reports.

## 12. Error messages, verbatim

| Where | Condition | Message |
| --- | --- | --- |
| `loadModule` | both `configuration` and `appConfigurationRead` | `Load takes configuration, in the first process, or appConfigurationRead, in the second, not both.` |
| `loadModule` | a root with `input` and neither | ``Module "<root>" declares input and is being deployed as the root, but Load was given no app configuration to fill it from. Pass { configuration } to Load; prisma deploy and prisma dev pass the values the `config` adapters return.`` |
| `configurationText` | no app configuration | ``<site> depends on <label>, but Load was given no app configuration to read "<key>" from. Pass { configuration } to Load; the deploy and dev commands pass the values the `config` adapters return.`` |
| `configurationText` | the value is not text (unchanged text; now also for a service's input and params) | ``<site> depends on <label>, which reads "<key>" from the values the `config` adapters return, but they return <kind> for it, not text. <label> reads text; to pass other data, declare it in the root module's input.`` |
| `resolveOne`, second process | a root field missing from the file | `<input.path> of root module "<m>" is not in the app configuration file. The first process's root body did not pass it on, so the deploy's two processes built different graphs. A module body must build the same graph every time; one that reads the process environment, a file or the clock can build a different one.` |
| `appConfigurationReadOf` | a key read as both | `<param label> reads "<key>" from the app configuration, and <secret label> names "<key>" as a secret. A name is a plain value or a secret, not both: Composer hands the deploy's second process every plain value it reads, in a file, and never writes a secret to a file. Give the plain value and the secret different names.` |
| `appConfigurationReadOf` | a root field the body passes on whose name a secrets key reads | `<input.path> of root module "<m>" reads "<key>" from the app configuration, and <secret label> names "<key>" as a secret. A name is a plain value or a secret, not both: Composer hands the deploy's second process every root input field the root's body passes on, in a file, and never writes a secret to a file. Read the secret with <secret label> only, or give the plain value a different name.` |
| `appConfigurationReadOf` | a root field JSON cannot hold | `<input.path> of root module "<m>" holds <kind>, which JSON cannot hold exactly. The deploy hands the root's input to its second process in a JSON file, so a field the root's body passes on must hold text, a finite number, a boolean, null, or arrays and plain objects of these.` `<kind>` is `a non-finite number`, `an array with a missing member`, `a function`, `a symbol`, `a bigint` or `an object that is not plain data`. |
| `secretSource()` | an empty `secretsKey` | `secretSource() secretsKey must be a non-empty string.` |
| `paramSource()` | an empty `configurationKey` | `paramSource() configurationKey must be a non-empty string.` |
| `paramSource()` | `configurationKey` and `redacted` | `paramSource() takes configurationKey, for a value known at deploy, or redacted, for a secret known only at boot, not both.` |
| `lowering` | the addresses differ | `The deploy's second process built a different graph from the one Composer checked in its first process. Only in the second process: <list>. Only in the first process: <list>. A module body must build the same graph every time; one that reads the process environment, a file or the clock can build a different one.` `<list>` is `none`, or the addresses sorted, each in double quotes, joined by `, `. |
| `readAppConfigurationFile` | no `PRISMA_COMPOSER_APP_CONFIGURATION_FILE` | `PRISMA_COMPOSER_APP_CONFIGURATION_FILE is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which names the app configuration file it wrote there.` |
| `readAppConfigurationFile` | the file cannot be read | `Could not read the app configuration file <file>: <message>. Composer deletes it when the run ends, so a stack file run by hand after that cannot read it; run the command again.` |
| `readAppConfigurationFile` | not what Composer writes | `The app configuration file <file> is not one Composer wrote: <it is not JSON | appConfigurationRead is not an object | rootInput is not a list of fields | configurationKeyText is not an object of text | nodeAddresses is not a list of node addresses>.` |
| `namedSecretsFromEnvironment` | no `PRISMA_COMPOSER_NAMED_SECRETS` | `PRISMA_COMPOSER_NAMED_SECRETS is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which hands the secrets the local services need there.` |
| `namedSecretsFromEnvironment` | not an object of text | `PRISMA_COMPOSER_NAMED_SECRETS is not a JSON object of text.` |
| `prepareSecondProcess` | `CONFIG.SECRET_AS_PLAIN_VALUE`: a value in the file would contain a known secret | `<where> holds a secret. Composer hands the second process every plain value Load read, in a file, and never writes a secret to a file.` `<where>` is `Root input field input.<path>` or `Configuration key "<key>"`. Fix: `Read the secret with envSecret() where it is used, or give this plain value text that is not a secret.` |
| `dotenv()` | a file `dotenv-flow` lists cannot be read | `dotenv() could not read <absolute path>: <message>` (unchanged) |

The `LoadError`s carry `COMPOSE.GRAPH_INVALID`. The `LowerError` and the second process's plain `Error`s reach the user as the cause of `DEPLOY.ENGINE_FAILED` or `DEV.CONVERGE_FAILED`. The new code is `CONFIG.SECRET_AS_PLAIN_VALUE`.

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
     The sentence: `"Config pool" and "secrets pool" are now "the app configuration" and "the app secrets". LoadOptions.configPool is LoadOptions.configuration, paramSource()'s poolKey option is configurationKey, and the types ConfigPool, SecretsPool and ConfigPools are AppConfiguration and AppSecrets. LoadOptions is now a union of FirstProcessLoadOptions and SecondProcessLoadOptions, so code that writes interface X extends LoadOptions stops compiling; use one of the two. An extension's preflight and serve step receive configuration and secrets in place of pools, and its local providers receive configurationKeyText and namedSecrets.`
  2. `If prisma.config.ts has import 'dotenv/config' and you adopt dotenv() in config or secrets, remove the import. Otherwise it puts .env's values into the process environment, environmentVariables() returns them last, and they override .env.<environment>.` with the before and after of a `prisma.config.ts` head: `import 'dotenv/config';` and `config: [environmentVariables()]` before, `config: [dotenv(), environmentVariables()]` and no import after.
  3. `dotenv() reads its files through dotenv-flow 4.1.0, in the same order as before: .env, .env.local, .env.<environment>, .env.<environment>.local. It now skips .env.local for the environment test, as dotenv-flow does. It never reads .env.defaults.`
  4. `The deploy's second process no longer runs the config adapters. It reads what the first process's Load read from the app configuration file, .prisma-composer/app-configuration-<pid>-<id>.json, readable only by you and deleted when the deploy ends, and refuses to deploy a graph whose node addresses differ from the first process's. A module body that reads process.env, a file or the clock and builds a different graph now fails the deploy.`
  5. `Composer redacts every secret it knows wherever it prints, at any length: the value under every name an envSecret() names, in your config and secrets lists. The lists are pools Composer reads only for those names, so their other values, such as a plain .env value or the shell's SHLVL, are not redacted. The deploy engine's own output is not redacted yet; Composer redacts its failure cause.`
  6. `A root field the body passes on must hold data JSON can hold exactly; a name may not be read both by envParam() and by envSecret(); and a non-text envParam() value in a service's input now fails before anything is created. Load refuses, with COMPOSE.GRAPH_INVALID, a root input field the body passes on whose name an envSecret() reads. The CLI refuses, with CONFIG.SECRET_AS_PLAIN_VALUE, to write the app configuration file when any value in it contains a known secret, such as a secret's text inside a URL. Both errors name the field, never the value.`
  7. `environmentVariables() now returns every variable of the process environment, PRISMA_COMPOSER_ variables included. If your shell sets such variables, they appear in the app configuration.`
  8. `@prisma/composer and @prisma/composer-cli must be the same version: the generated stack file imports @prisma/composer/internal/app-configuration-file.`

## 14. Documentation

All in the same pull request (`.agents/rules/user-facing-surface-changes.mdc`), written without hard wraps. The committed files are the text; this section says what changed in each, so it cannot drift from them. Each rewritten decision record reads as one current record with no amendment notes: what this PR reverses is under "Alternatives considered".

### 14.1 Decision records

- [ADR-0049](../../../../../docs/design/90-decisions/ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md), rewritten: only the first process runs adapters, at start and each rebuild under `prisma dev`; the second process imports `prisma.config.ts` for its descriptors and reads what the first process's Load read from the app configuration file.
- [ADR-0058](../../../../../docs/design/90-decisions/ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md), rewritten and renamed after its title: under `prisma dev` a secret comes from the app secrets and an env-sourced param from the app configuration, read in the first process at start and each rebuild. The second process receives the named secrets in its environment, never a file.
- [ADR-0029](../../../../../docs/design/90-decisions/ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md), rewritten and renamed after its title: a secret is a value the deployment reads from a platform variable by name, which the framework never writes to deploy state, a file, a log, a report or an error. Composer redacts every known secret wherever it prints, the values under the names the graph's `envSecret()`s name; the deploy engine's output is not redacted yet.
- [ADR-0032](../../../../../docs/design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md), rewritten: `envParam('NAME')` reads `NAME` from the app configuration; `paramSource()` takes `configurationKey`; non-text fails the Load.
- [ADR-0044](../../../../../docs/design/90-decisions/ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md), rewritten: redaction of known secrets is the one change between where an error is raised and who receives it, and it drops the cause. The Decision section lists that exception. `CONFIG.SECRET_AS_PLAIN_VALUE` joins the registry.
- [ADR-0061](../../../../../docs/design/90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md), edited: it names `configurationKey` and `secretsKey`, and says how the root's input is kept out of the file: Load's refusal by `envSecret()` name, and the CLI's refusal of a known secret anywhere in a value.
- [ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md), edited: "the app configuration" and "the app secrets"; `environmentVariables()` returns the whole process environment with no exception; the app configuration file's name and contents; the two refusals; deletion at exit and of leftover files older than ten minutes; core knows each secret's name; the known secrets are only the values under those names; the second process's output is not redacted, for now; and the known limit of § 21.
- The [decision index](../../../../../docs/design/90-decisions/README.md): each changed record's line says what the record now decides.

### 14.2 Glossary

[`glossary.md`](../../../../../docs/design/03-domain-model/glossary.md): "Config pool" and "Secrets pool" become [the app configuration](../../../../../docs/design/03-domain-model/glossary.md#the-app-configuration) and [the app secrets](../../../../../docs/design/03-domain-model/glossary.md#the-app-secrets). New entries: the app configuration file, secrets adapter, configuration key, secrets key, named secrets, and known secrets (with credential-looking values). Every link to the old anchors moves.

### 14.3 Domain docs

- [`deploy-cli.md`](../../../../../docs/design/10-domains/deploy-cli.md): pipeline step 4 reads the app secrets, then the app configuration; the app configuration file, its refusal, its deletion at exit and the leftover sweep; that the second process's output is not redacted; the error row for `CONFIG.SECRET_AS_PLAIN_VALUE`.
- [`local-dev.md`](../../../../../docs/design/10-domains/local-dev.md): the dev second process runs no adapter, reads the app configuration file and the named secrets; `dotenv()` reads through `dotenv-flow` and skips `.env.local` for `test`.
- [`config-params.md`](../../../../../docs/design/10-domains/config-params.md) and [`module-composition.md`](../../../../../docs/design/10-domains/module-composition.md): § 4.2's words.
- [`core-model.md`](../../../../../docs/design/10-domains/core-model.md): `CommonLoadOptions`, `FirstProcessLoadOptions`, `SecondProcessLoadOptions` and their union, and `LowerOptions`' `appConfigurationRead` and `firstProcessNodeAddresses`.

### 14.4 Guides, skill, examples and design

- [`building-an-app.md`](../../../../../docs/guides/building-an-app.md): § 4.2's words; `dotenv()` through `dotenv-flow`, and removing `import 'dotenv/config'` when you list `dotenv()`; the adapters run once, in the command's own process; the refusals of a secret in the app configuration file.
- [`deploying.md`](../../../../../docs/guides/deploying.md): under a programmatic host, the deploy engine's output is redacted, so it shows plain progress lines.
- [`running-locally.md`](../../../../../docs/guides/running-locally.md): remove `import 'dotenv/config'` when you list `dotenv()`.
- `skills/prisma-composer-core-concepts/SKILL.md`: § 4.2's words and `dotenv()` through `dotenv-flow`.
- `examples/storefront-auth/module.ts`: "the secrets pool" becomes "the app secrets". No example adopts or drops `dotenv()`.
- `.drive/projects/module-input/design.md`, sections 8, 9 and 12: what Will accepted on 2026-11-02: `.env.defaults` is dropped from `listFiles`' list; the name refusal; how Composer knows a secret's name; the S4 redaction kept for now; redaction as the one change to an error. On 2026-11-05 Will added: the second process's output is not redacted, for now, and the known secrets are only the values the graph names.

## 15. Tests

Runtime tests use `bun test`; type tests use vitest `expectTypeOf`. Test files are exempt from the no-bare-casts instruction. Every code block is as `pnpm lint:fix` formats it. Existing tests use `os.tmpdir()` for fixture apps; new tests in the same files follow the file's own fixture helpers.

### 15.1 Existing tests this PR changes

Renames only (§ 4.1 identifiers and § 4.2 words in titles, comments and assertions; no assertion's meaning changes): `core/__tests__/root-input.test.ts`, `source-load.test.ts`, `source-value.test.ts`, `source-value.test-d.ts`, `pointer.test.ts`, `config-adapters.test-d.ts`; CLI `pipeline.test.ts` and its fixture folders (`pipeline-config-pool` → `pipeline-app-configuration`), `generate-stack.test.ts`'s other tests; target `input-serializer.test.ts`, `local-target-preflight.test.ts`, `local-target-serve.test.ts`, `orm-postgres.test.ts`, `orm-postgres-shapes.test-d.ts`, `param.test.ts`, `pg-connection.test.ts`, `preflight.test.ts` (each `pools: { config: X, secrets: Y }` input becomes `configuration: X, secrets: Y`), `invariants.test.ts` (comment only); local target `compute-materialize-env.test.ts` (`materializeEnv(…, { config: C, secrets: S })` becomes `materializeEnv(…, C, S)`); `packages/1-prisma-cloud/2-shared-modules/auth/src/__tests__/module.test.ts`, `auth-options.test.ts`, `email/src/__tests__/module.test.ts`; `examples/auth/tests/module.test.ts`, `examples/email/tests/module.test.ts`; `test/integration/test/local-dev.integration.ts` (its preflight input takes `configuration` and `secrets`).

Changes beyond renames:

- Every assertion of the two messages that said `Load was given no values from the \`config\` adapters` and `Pass { configPool } to Load` takes the § 12 text (`no app configuration`, `Pass { configuration } to Load`). `git grep -n 'Pass { configPool }' -- packages` lists them.

- `cli/src/__tests__/config-adapters.test.ts`: the tests `the deploy child reads the same values from the environment as the CLI` and `a variable Composer changes for the child reads as the CLI's own value there` are removed, with the helpers `asChild` and `deployInvocation` and the import of `alchemyInvocation`; `TOUCHED` becomes `['S4_LATE', 'S4_PROBE', 'PRISMA_COMPOSER_PREFLIGHT_X']`. The first `dotenv()` test is retitled `dotenv() reads the four files in dotenv-flow's order: the environment's local file wins, then the environment's file, then .env.local, then .env`; its assertion does not change.
- `cli/src/__tests__/config-pools.test.ts` becomes `app-configuration.test.ts` (`git mv`). Each `readSecretsPool(section(…), input)` becomes `readAppSecrets(section(…), input)`. The describe `where the pool readers are published` and its test become:

  ```ts
  describe('where the readers are published', () => {
    test('the public config entry exports the adapters only, and the second process reads through the app-configuration-file entry', () => {
      expect(Object.keys(configEntry).sort()).toEqual(['dotenv', 'environmentVariables']);
      expect(Object.keys(configurationFileEntry).sort()).toEqual([
        'namedSecretsFromEnvironment',
        'readAppConfigurationFile',
      ]);
    });
  });
  ```

  with `import * as configurationFileEntry from '../exports/app-configuration-file.ts';` in place of the pools entry import.
- `cli/src/__tests__/deployment-summary.test.ts`: the describe `poolSecrets` and its two tests are removed (§ 15.3 tests `valuesUnderSecretsKeys` and `credentialLookingValues`). Each `readEngineFailureCause(file, values)` call becomes `readEngineFailureCause(file, (text) => redactValues(text, values))`. The describe `redactSecrets` becomes `redactCredentialLooking`, its assertions unchanged.
- `cli/src/__tests__/generate-stack.test.ts`: `reads the config pool from the adapters and passes it to lower(), directly after the environment, and never reads the secrets pool` becomes `imports no Composer internal entry except the app configuration file entry, calls no adapter list, and reads the file after the failure recorder starts, and passes it to lower() directly after the environment`. It asserts the rendered file contains `import { readAppConfigurationFile } from '@prisma/composer/internal/app-configuration-file';`, that `report.captureEngineFailure?.();` comes before `const file = readAppConfigurationFile(process.env);`, that the options contain `  environment: "staging",\n  appConfigurationRead: file.appConfigurationRead,\n  firstProcessNodeAddresses: file.nodeAddresses,`, and that the file contains neither `readConfigPool` nor `readSecretsPool`.
- `cli/src/dev/__tests__/generate-dev-stack.test.ts`: the expected import line becomes the § 8.3 one; `reads both pools from the adapters, …` becomes `reads the app configuration file and the named secrets the CLI handed over, passes what Load read to lower() directly after the environment, and …`, asserting `const file = readAppConfigurationFile(process.env);`, `const namedSecrets = namedSecretsFromEnvironment(process.env);`, the two option lines, and `  providers: localTargetProviders(resolved, containers, devDir, file.appConfigurationRead.configurationKeyText, namedSecrets),`.
- `cli/src/__tests__/fixtures/stack-import/stub-composer.ts`: the `@prisma/composer/internal/pools` module becomes `@prisma/composer/internal/app-configuration-file`, with `export const readAppConfigurationFile = () => ({ appConfigurationRead: { rootInput: [], configurationKeyText: { read: 'from-file' } }, nodeAddresses: ['stub-address'] }); export const namedSecretsFromEnvironment = () => ({ read: 'secrets' });`. The `lower` stub prints `appConfigurationRead: opts.appConfigurationRead, firstProcessNodeAddresses: opts.firstProcessNodeAddresses` in place of `configPool: opts.configPool`, and `...(globalThis.stubLocal === undefined ? {} : { local: globalThis.stubLocal })` in place of the `stubPools` spread. `localTargetProviders` becomes `(resolved, containers, devDir, configurationKeyText, namedSecrets) => { globalThis.stubLocal = { configurationKeyText, namedSecrets }; return {}; }`. The fixture's `prisma.config.ts` adapters throw, so the test shows the second process runs no adapter.
- `cli/src/__tests__/stack-file-import.test.ts`: the expected object becomes what the stub's `readAppConfigurationFile` returns; the deploy test expects `{ app, extensions, state, environment: 'staging', appConfigurationRead, firstProcessNodeAddresses: ['stub-address'] }`, titled `the deploy stack passes the composer export of prisma.config.ts, the environment, and the app configuration file, to lower(), and runs no adapter`; the dev test adds `local: { configurationKeyText: { read: 'from-file' }, namedSecrets: { read: 'secrets' } }`, titled `the dev stack passes the composer export of prisma.config.ts, the environment, and the app configuration file, to lower(), the configuration key text and the named secrets to the local providers, and runs no adapter`.
- `cli/src/__tests__/run-alchemy.test.ts`: every `alchemyInvocation({ … })` and every hand-built `AlchemyInvocation` gains `redactedValues: []`. `env carries only the ADDITIONS …` drops any expectation of `PRISMA_COMPOSER_PARENT_VALUES`. Every `spawnCommandLine(line)` call becomes `spawnCommandLine(line, [])`.
- `cli/src/family/__tests__/converge-spawn.test.ts`: both `alchemyInvocation` calls gain `redactedValues: []`. Their expectations do not change.
- `cli/src/operations/__tests__/operations.test.ts`: `makeAppDir` takes an optional secrets key, which the service's input then reads. `an engine failure cause never carries a known secret read from a dotenv file, and keeps a dotenv value no envSecret() names` names `WEBHOOK_SIG` as a secrets key; a `.env` value under `SIGNING_SALT`, which nothing names, stays in the cause. `a thrown string holding a known secret is redacted …` names `TOKEN_X`, and test 51 names `DEV_TOKEN`.
- `cli/src/testing/operations-double.ts`: the synthetic `AlchemyInvocation` in `runConverge` gains `redactedValues: []`.
- `cli/src/operations/__tests__/operations.test.ts`: `deploy hands every extension's preflight both pools` becomes `deploy hands every extension's preflight the app configuration and the app secrets`, recording `{ configuration: input.configuration, secrets: input.secrets }`; `a secrets pool value appears in no event, result or report` becomes `an app secrets value appears in no event, result or report`, reading `input.secrets['S4_SENTINEL']`; `dev hands both pools to preflight and to a dev server` becomes `dev hands the app configuration and the app secrets to preflight and to a dev server`, with `serve: async ({ configuration, secrets }) => { seen.serve = { configuration, secrets }; … }` and the expected `{ configuration: { A: 'a' }, secrets: { S: 's' } }` for both; `an engine failure cause never carries a value the pools read from a dotenv file` becomes `an engine failure cause never carries a secret value read from a dotenv file`, its assertions unchanged. The describe `the operations read the pools from the config adapters` becomes `the operations read the app configuration and the app secrets from the adapters`.

- `test/integration/test/local-dev.integration.ts` hands the dev second process what the first process read, as `prisma dev` does. It Loads with `{ id, environment: { name: 'dev' }, configuration }`, where `configuration` is what the default adapters return, and before each of its three converges it builds the handover with `prepareSecondProcess({ file, appConfigurationRead: graph.appConfigurationRead, nodeAddresses: nodeAddresses(graph), secretsKeys: secretsKeys(graph), knownSecrets: new KnownSecrets(), appSecrets })`, calls `writeFile()`, adds `handover.env` to the child's environment, and calls `removeFile()` after. It imports `prepareSecondProcess` and `KnownSecrets` from `@prisma/composer-cli/testing`, and `nodeAddresses` and `secretsKeys` from `@prisma/composer/deploy`. Run it locally with `bun run test/local-dev.integration.ts` from `test/integration`.

- `test/integration/test/local-dev-store.integration.ts`: its direct `alchemy deploy` re-run of the dev stack file that `prisma dev` wrote gets the same handover. It reads the default adapters for the environment `dev` beside the store app's `prisma.config.ts`, Loads the app's `module.ts` with `{ id: 'store', environment: { name: 'dev' }, configuration }`, and builds the handover with `prepareSecondProcess` as above, writing the file before the re-run and removing it after. No other file under `test/integration` or `examples/` runs a stack file or Alchemy directly. The tests that start a real `prisma dev` (this one, `local-dev-criteria-4-5` and `local-dev-detach`) need the `prisma` host release of the release-order note before they can run.

- `core/src/__tests__/lowering.test.ts`: `lowering() passes opts.configPool to Load` becomes `lowering() passes opts.appConfigurationRead to Load`, and `opts({ bundles, configPool: { X: 'probe' } })` becomes `opts({ bundles, appConfigurationRead: { rootInput: [], configurationKeyText: { X: 'probe' } } })`; its assertion does not change.
- `target/src/__tests__/control-lowering.test.ts`: `the input document reads envParam() leaves from LowerOptions.configPool` becomes `the input document reads envParam() leaves from LowerOptions.appConfigurationRead`, and `opts: { configPool: { G: 'pool' } }` becomes `opts: { appConfigurationRead: { rootInput: [], configurationKeyText: { G: 'pool' } } }`; its assertion does not change.

If any other existing test fails, the implementer stops and reports.

### 15.2 New core tests

In `root-input.test.ts`, a new `describe("what Load reads from the app configuration", …)`. Its root schema is `type({ A: 'string', 'B?': 'string', C: 'string.integer.parse', D: 'string' })`; the body binds `{ a: input.A, b: input.B, c: input.C }` into the file's echo service; the configuration is `{ A: 'a', C: '4', D: 'unused', PATH: '/bin' }`.

1. `the graph records each root field the body names, with its checked value, and no other` — `[...graph.appConfigurationRead.rootInput].sort(byPath)` equals `[{ path: ['A'], value: 'a' }, { path: ['B'] }, { path: ['C'], value: 4 }]`, where `byPath` compares `path.join('.')`. `D` and `PATH` are absent.
2. `a root field JSON cannot hold exactly fails the Load, naming it` — schema `type({ WHEN: type('string').pipe((text) => new Date(text)) })`, body binds `{ when: input.WHEN }` into a service whose schema is `type({ when: 'Date' })`; Load with `{ configuration: { WHEN: '2026-01-01' } }` fails with exactly `input.WHEN of root module "shop" holds an object that is not plain data, which JSON cannot hold exactly. The deploy hands the root's input to its second process in a JSON file, so a field the root's body passes on must hold text, a finite number, a boolean, null, or arrays and plain objects of these.`
3. `the second process takes each root field from what the first process read, without running the root's schema` — a Standard Schema whose `validate` pushes to a `calls` array and returns `{ value: {} }`; `Load(root, { appConfigurationRead: { rootInput: [{ path: ['A'], value: 'from-file' }, { path: ['B'] }, { path: ['C'], value: 4 }], configurationKeyText: {} } })`; `calls` stays `[]`, and the echo service's binding is `{ a: 'from-file', c: 4 }`.
4. `a root field missing from what the first process read fails, saying the two processes built different graphs` — the same Load with `rootInput: [{ path: ['A'], value: 'a' }]` fails with exactly `input.B of root module "shop" is not in the app configuration file. The first process's root body did not pass it on, so the deploy's two processes built different graphs. A module body must build the same graph every time; one that reads the process environment, a file or the clock can build a different one.`
5. Two tests. `load-options.test-d.ts`, `Load takes the app configuration or what the first process read, not both`: a call that passes both fails to compile. `root-input.test.ts`, `Load refuses configuration and appConfigurationRead together, which a caller without type checks can pass`: the options cast past the compiler, Load throws the exact message of § 12.
6. `a root with no input records no fields` — `Load(rootWithoutInput, { configuration: {} }).appConfigurationRead` equals `{ rootInput: [], configurationKeyText: {} }`.

In `source-load.test.ts`, a new `describe('configuration keys Load reads', …)`, with a test source `const configured = (key: string) => paramSource({ key }, { label: \`configured('${key}')\`, configurationKey: key })` and `const secret = (key: string) => secretSource({ key }, { label: \`secret('${key}')\`, secretsKey: key })`:

7. `the graph records the text of every configuration key a source reads, in a module's input, a service's input and a service's params` — keys `IN_MODULE`, `IN_SERVICE`, `IN_PARAM` bound in the three places, configuration `{ IN_MODULE: 'm', IN_SERVICE: 's', IN_PARAM: 'p', OTHER: 'o' }`; `graph.appConfigurationRead.configurationKeyText` equals `{ IN_MODULE: 'm', IN_SERVICE: 's', IN_PARAM: 'p' }`.
8. `an unset or empty key is left out of the recorded values` — `IN_SERVICE: ''` and `IN_PARAM` absent; `configurationKeyText` equals `{ IN_MODULE: 'm' }`.
9. `a configuration key in a service's input whose value is not text fails at Load` — `IN_SERVICE: 4`; message exactly ``the input binding of service "shop.email.echo" depends on configured('IN_SERVICE'), which reads "IN_SERVICE" from the values the `config` adapters return, but they return a number for it, not text. configured('IN_SERVICE') reads text; to pass other data, declare it in the root module's input.``
10. `a name read as a configuration key and named as a secrets key fails at Load` — the service binds `{ plain: configured('SHARED'), key: secret('SHARED') }`; message exactly `configured('SHARED') reads "SHARED" from the app configuration, and secret('SHARED') names "SHARED" as a secret. A name is a plain value or a secret, not both: Composer hands the deploy's second process every plain value it reads, in a file, and never writes a secret to a file. Give the plain value and the secret different names.`
11. `the second process reads configuration keys from what the first process read` — `Load(root, { appConfigurationRead: { rootInput: [], configurationKeyText: { IN_MODULE: 'from-file' } } })` gives the module-bound field `'from-file'`.
54. `a root input field named as a secrets key fails at Load, and the message holds no value` — a root field the body passes on whose name a `secret()` names; the message is the root-field row of § 12, and does not contain the field's value.

In `source-value.test.ts`:

12. `secretSource() takes a secretsKey, which must be non-empty text` — `secretSource({}, { secretsKey: '' })` throws `secretSource() secretsKey must be a non-empty string.`
13. `secretsKeys lists the secrets key of every secret source the graph names, once each` — two services binding `secret('A')`, one `secret('B')`, and one `secretSource({})` without a key; `secretsKeys(graph)` equals `['A', 'B']`.
14. `nodeAddresses lists every node's address, sorted` — `nodeAddresses(Load(root))` equals the sorted ids of `graph.nodes`.

In `lowering.test.ts`:

15. `lowering refuses a graph whose node addresses differ from the checked ones, naming both sides`, where the checked ones are the first process's — `lowering(root, config, { name: 'shop', bundles, firstProcessNodeAddresses: ['shop', 'shop.gone'] })` fails with the `LowerError` of § 12, where the second process built `shop.echo` and not `shop.gone`: `… Only in the second process: "shop.echo". Only in the first process: "shop.gone". …`. The test runs the effect as the file's other lowering tests do.
16. `lowering accepts the same addresses in any order` — `firstProcessNodeAddresses` is the graph's addresses reversed; no error.

### 15.3 New CLI tests

`cli/src/__tests__/config-adapters.test.ts`, describe `dotenv()`:

17. `dotenv() never reads .env.defaults` — files `.env.defaults` (`A=defaults\nD=defaults\n`) and `.env` (`A=env\n`); values equal `{ A: 'env' }`.
18. `dotenv() skips .env.local for the environment test, as dotenv-flow does` — files `.env`, `.env.local`, `.env.test`, `.env.test.local`, each `KEY=<file name>`, plus `.env.local` holding `ONLY_LOCAL=1`; for `environment: 'test'` the values equal `{ KEY: '.env.test.local' }`.
19. `dotenv() reads .env.defaults as the environment's file for an environment named defaults` — files `.env.defaults` (`A=env-file\n`) and `.env` (`A=env\n`); for `environment: 'defaults'` the values equal `{ A: 'env-file' }`.
20. `dotenv() does not change the process environment` — after the call, `process.env['S11_PROBE']` is still `undefined`, with `S11_PROBE=1` in `.env`.

New file `cli/src/__tests__/redaction.test.ts`:

21. `SecretRedaction redacts a known secret at any length, longest first` — known secrets `['a', 'abc']`; `redact('xabcx a')` equals `'x[redacted]x [redacted]'`.
22. `SecretRedaction skips empty values` — `allValues()` equals `[]` after adding `''`.
55. `SecretRedaction hides overlapping secrets whole` — known secrets `abc` and `bcdef`: `'xxabcdefyy'` becomes `'xx[redacted]yy'`, and `redactValues` agrees.
56. `SecretRedaction starts with the credential-looking values of the environment it is given, so every output hides the same set` — `allValues()` holds `SHELL_API_TOKEN`'s value, and `knownSecrets` is empty.
57. `SecretRedaction hides a value added after it first redacted`.
58. `redactThrown redacts the message and stack of a thrown error and of each error in its cause chain and aggregate`.
59. `redactThrown redacts a DOMException, whose message has no setter, in place` — for `AbortError` and `TimeoutError`.
60. `redactThrown replaces a frozen error with a new one that carries the redacted message, stack and cause chain`.
61. `redactThrown keeps an error whose cause is a frozen error, and points it at the redacted copy`.
62. `redactThrown replaces a cause that is text or plain data with a redacted copy`.
- `redactThrown never throws`: a thrown string, number or plain object becomes an `Error` whose message is its redacted text; a `message` that is not text is redacted as text; a `message`, `cause` or `stack` getter that throws, and a revoked proxy as the cause or as the thrown value, each give a new `Error` holding no secret.
- `a thrown string holding a known secret is redacted before it is rethrown or sent to a reporter` (operations).
23. `valuesUnderSecretsKeys takes the value under each secrets key from both, at any length` — configuration `{ STRIPE_KEY: 'sk_live_123456', WEBHOOK: 'w', N: 4 }`, secrets `{ WEBHOOK: 'w2' }`, keys `['WEBHOOK']`; sorted result `['w', 'w2']`. `credentialLookingValues takes text of eight characters or more under credential-looking names` — `{ STRIPE_KEY: 'sk_live_123456', API_TOKEN: 'short', N: 4 }` gives `['sk_live_123456']`.
63. `a credential-looking value is redacted but is not a known secret`.
64. `KnownSecrets finds a known secret anywhere in a text` — `appearIn` finds `secret-pw-77` inside a URL, and not in a URL without it.
24. `redactError removes known values from the summary, why, fix and meta, and keeps the code, severity and where` — an error `CONFIG.ADAPTER_FAILED` with secret `hunter2` in each text field and in `meta.nested.list[0]`; the result's `JSON.stringify(toEnvelope())` does not contain `hunter2`, its `code`, `severity` and `where` are the original's, and `cause` is `undefined`.
25. `redactDevEvent redacts messages and dev server output, and leaves other events as they are`.
26. `redactSummary redacts entity ids, urls and details`.
27. `StreamRedactor redacts a secret split across two chunks` — chunks `'token is s3cr3t-'` and `'value, done\n'` through `new StreamRedactor(['s3cr3t-value'])` read out as `'token is [redacted], done\n'`.
28. `StreamRedactor redacts every occurrence at every chunk size`.
29. `StreamRedactor holds back only the end of the text that could start a secret, and end returns the rest` — values `['abcdef']`; `push('0123456789')` returns `'0123456789'`, `push('0123abc')` returns `'0123'`, and `end()` returns `'abc'`.
30. `StreamRedactor returns text that cannot start a secret at once, holds a line break secret whole, and with no secret returns each chunk as it comes`.
52. `StreamRedactor returns a prompt without a line break at once`.
65. `StreamRedactor hides overlapping secrets whole, at every chunk size`.
66. `StreamRedactor gives the same text as whole-text redaction for random chunks and overlapping secrets`.
53. `StreamRedactor never splits a surrogate pair across two pieces`.

New file `cli/src/__tests__/app-configuration-file.test.ts`:

31. `the file holds what Load read and the node addresses, as JSON readable only by its owner` — `prepareSecondProcess(…).writeFile()`; mode `0o600`; the JSON is `{ appConfigurationRead, nodeAddresses }`.
32. `a file already there is replaced, and gets mode 0600`.
67. `removeFile deletes the file, and never throws when it is gone`.
37. `the second process's environment names the file, and carries the named secrets only when the app secrets are given` — only the app secrets under the graph's secrets keys, and none that is `''`.
68. `prepareSecondProcess refuses a file that would hold a known secret, naming where and never the secret`.
69. `prepareSecondProcess refuses a known secret inside a longer value, such as the password in a URL` — a configuration key.
70. `prepareSecondProcess refuses a root field the root's schema built around a known secret` — a schema transform returns `Bearer <secret>`.
71. `prepareSecondProcess refuses a number the root's schema made from a known secret`.
72. `writeFile deletes the file when the process exits, and removeFile stops that` — two `writeFile()` calls add one exit listener; calling it deletes the file; `removeFile()` removes it.
33. `readAppConfigurationFile reads back what was written`.
34. `readAppConfigurationFile names the variable when it is not set` — exact message of § 12.
35. `readAppConfigurationFile says a file it cannot read is deleted when the run ends`.
36. `readAppConfigurationFile refuses a file Composer did not write` — each `<what>` of § 12.
38. `namedSecretsFromEnvironment reads the object, and refuses one that is not text`.
73. `removeLeftoverAppConfigurationFiles deletes the old files of processes that are no longer running, in .prisma-composer and in each dev environment folder, and keeps the rest` — files dated older than `LEFTOVER_APP_CONFIGURATION_FILE_AGE_MS`; this run's, a running process's and a result file stay.
74. `removeLeftoverAppConfigurationFiles keeps a recent file whose process is not running here, which may be a run in a container or on another machine`.
75. `removeLeftoverAppConfigurationFiles does nothing when there is no .prisma-composer folder`.

`cli/src/__tests__/run-alchemy.test.ts`, new:

41. `spawnCommandLine pipes the child's output through redaction, a secret split across chunks included` — a `node -e` child writing `key=hunter2-` then, 50 ms later, `secret\n` to stdout; `spawnCommandLine(line, ['hunter2-secret'], outputs)` with `outputs` collecting into strings; the collected stdout is `key=[redacted]\n`.

`cli/src/__tests__/pipeline.test.ts`, new:

44. `runPipeline reads the app secrets before the app configuration` — adapters that push `'secrets'` and `'config'` to an order array; with `readSecrets: true` the array is `['secrets', 'config']`.
45. `runPipeline adds the values under every envSecret() name to the known secrets` — the `pipeline-app-configuration` fixture module binds `secretSource({}, { label: 'secret', secretsKey: 'S11_SECRET' })`; the config adapter returns `{ S11_SECRET: 'from-config' }` and the secrets adapter `{ S11_SECRET: 'from-secrets' }`; the `SecretRedaction` passed in as `redaction` has both values among its known secrets.

`cli/src/operations/__tests__/operations.test.ts`, a new `describe('the second process reads what the first process read', …)`, using a fixture app whose root declares `input: type({ GREETING: 'string' })`, binds `{ greeting: input.GREETING, origin: configured('APP_ORIGIN'), key: secret('S13_SECRET') }` into its service (the helpers of § 15.2, built from core), and whose `config` adapter returns `{ GREETING: 'hello', APP_ORIGIN: 'https://origin.example', UNUSED: 'x' }`:

46. `deploy writes the app configuration file before the second process starts and deletes it after, mode 0600, holding only what Load read (exit <status>)`, for exit 0 and exit 1 — in the fake `alchemy`, `input.env[APP_CONFIGURATION_FILE_ENV]` names the file; while it runs, the file exists, its mode is `0o600`, and its JSON equals `{ appConfigurationRead: { rootInput: [{ path: ['GREETING'], value: 'hello' }], configurationKeyText: { APP_ORIGIN: 'https://origin.example' } }, nodeAddresses }` for the fixture's graph; after `deploy` returns, the file does not exist.
47. `destroy writes and deletes the app configuration file the same way, and reads no secrets`.
76. `deploy, destroy and dev each start by deleting the app configuration files that earlier runs left` — leftover files of an ended process, dated older than `LEFTOVER_APP_CONFIGURATION_FILE_AGE_MS`.
77. `deploy refuses <what>, before writing any file or starting the second process`, for a root input field holding the text under a secrets key, and for a configuration key holding the text under a secrets key — the failure is `CONFIG.SECRET_AS_PLAIN_VALUE` with the § 12 message, the fake `alchemy` never runs, and no app configuration file is left.
48. `dev hands the second process the named secrets through its environment, never in a file` — `secrets: [() => ({ S13_SECRET: 'dev-secret-value', OTHER: 'not-named' })]`; in the fake `alchemy`, `input.env[NAMED_SECRETS_ENV]` equals `'{"S13_SECRET":"dev-secret-value"}'`, and no file under the app directory contains `dev-secret-value`; `<dev environment dir>/app-configuration-<pid>.json` exists during the converge and not after it.

49. **The end-to-end test**, in the describe `no known secret is printed`. `no known secret reaches the app configuration file, the stack file, the deploy report, the errors or the second process's output`. The app's `secrets` adapter returns `{ S13_SECRET: 'e2e-SENTINEL-5f2a' }` and `config` returns the values above. The fake `alchemy` (a) copies the app configuration file's text and the stack file's text into variables; (b) runs `spawnCommandLine({ command: process.execPath, args: ['-e', script], cwd, env: input.env }, input.redactedValues, outputs)`, where `script` writes `e2e-SENTI` and, after 50 ms, `NEL-5f2a and more\n` to stdout and `boom e2e-SENTINEL-5f2a\n` to stderr, and `outputs` collects both streams; (c) writes to the result file a deployment summary whose one entity has `id: 'svc'` and `details: { note: 'e2e-SENTINEL-5f2a' }`, and beside it the failure cause `error: rejected e2e-SENTINEL-5f2a`; and (d) returns the status the test sets. The test deploys twice, each with `reportPath` set to a file in the app directory: once with status 0 and once with status 1. Afterwards none of these contains `SENTINEL`: the copied configuration file and stack file texts of both runs, the collected stdout and stderr, both run report files, `JSON.stringify(result.value.summary)` of the first run, and `JSON.stringify(result.failure.toEnvelope())` and `String(result.failure.meta?.['engineCause'])` of the second. The collected stdout of each run is `[redacted] and more\n`.
78. `with the default lists, a secret known only because an envSecret() names it reaches no file, report, reporter, error or output`.
51. `a dev event's message is redacted` — the app's service reads `DEV_TOKEN` as a secrets key; a dev server output line holding its value reaches `onEvent` as `[redacted]`.
80. `with dotenv() and environmentVariables() in both lists, only the value an envSecret() names is redacted` — `config: [dotenv(), environmentVariables()], secrets: [dotenv(), environmentVariables()]`; `.env` holds `EMAIL_DELIVERY_MODE=none`, `EMAIL_FROM=dev@example.com` and `EMAIL_DELIVERY_CREDENTIAL=sk_test_abc123`; the root passes the first two on and its service reads `envSecret('EMAIL_DELIVERY_CREDENTIAL')`. The app configuration file's `rootInput` holds `none` and `dev@example.com` and not `sk_test_abc123`; a child run through `spawnCommandLine` printing all three shows `mode none from dev@example.com key [redacted]`, and so does the engine failure cause.

`cli/src/__tests__/redaction.test.ts`:

79. `a shell value in the app secrets that no secrets key names is not redacted` — with `SHLVL: '1'` and `EMAIL_DELIVERY_CREDENTIAL` in the app secrets and only `EMAIL_DELIVERY_CREDENTIAL` named, `redact('SHLVL=1 key=sk_test_abc123')` equals `'SHLVL=1 key=[redacted]'`.

## 16. Scope and commits

In: core (`packages/0-framework/1-core/core`), the CLI (`packages/0-framework/3-tooling/cli`), `@prisma/composer`'s entries, the Prisma Cloud target and the local target, the tests of § 15, `docs/`, `skills/`, `examples/storefront-auth/module.ts`'s comment, `architecture.config.json`, `tsconfig.depcruise.json`, the four `@prisma/cli-engine` declarations of § 8.7, the lockfile, and the project's `design.md` (§ 14.4).

Out, as the plan and Will's rulings assign: `prisma dev` watching inputs (S14); a developer's `.env.local` secret reaching another environment (S15); a home for secrets apart from plain values (S16); `secretString()` becoming `secret(schema)` (S17); `dotenv-flow` skipping `.env.local` for `test`; `destroy` needing a valid configuration; `KEY=` giving `''`; filtering `environmentVariables()`; any change to `envParam()`'s deploy-time reading. Also out: the engine change itself, which is prisma/prisma-cli#383.

Each commit is made with `git commit -s --trailer "Signed-off-by: Will Madden <madden@prisma.io>"` and has no `Co-Authored-By` line. Before each commit, run `pnpm lint:fix` and keep the formatting it writes. Only the branch tip must be green.

The first nine commits, as made:

1. `docs(drive): the module-input design says dotenv() drops .env.defaults, names secretsKey, refuses a name read as both, and redacts through the engine's output transform` — § 14.4.
2. `feat(cli)!: dotenv() reads its files through dotenv-flow` — § 3, its tests (15.1's `config-adapters.test.ts` changes, tests 17 to 20), the lockfile.
3. `refactor!: the config pool and the secrets pool are the app configuration and the app secrets` — § 4 and § 10 items 1, 3 to 11, with every rename-only test change of § 15.1.
4. `feat(core): Load records what it read from the app configuration, and the second process Loads with it` — § 5, § 6, § 10 item 2, tests 1 to 16.
5. `feat(cli)!: the second process reads a configuration file and runs no adapter` (the review fixes later renamed that file the app configuration file) — § 7, § 8.1 to § 8.6, the `generate-stack`, `generate-dev-stack`, `stack-file-import`, `app-configuration` and `pipeline` changes of § 15.1, tests 31 to 38 and 44 to 48.
6. `feat(cli): Composer redacts every secret it knows, in errors, events and the second process's output` — § 8.7, § 9, § 10 item 12, the `deployment-summary`, `run-alchemy`, `converge-spawn`, `operations-double` and `operations` changes of § 15.1, tests 21 to 30, 39 to 43 and 49 to 51, the lockfile.
7. `docs(design): one current record for secrets, env-sourced params, errors, the composer section and dev secrets; the app configuration and the app secrets` — § 14.1 to § 14.3.
8. `docs: guides and the agent skill read configuration once and redact known secrets` — § 14.4.
9. `docs(drive): module-input S11 to S13 manual QA` — `qa.md` in this slice's folder (§ 17).

The integration-test, QA-note and review-fix commits that follow are listed under "History" at the end.

## 17. Done when

- Every test of § 15.2 and § 15.3 passes, and every test changed in § 15.1 passes. At the root: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm lint:deps`, `pnpm test`, `pnpm turbo run test:types`, `pnpm check:floor-imports`, `pnpm check:publish-deps`, `pnpm check:skill-packaging`, `pnpm check:family-static-graph` and `pnpm check:cli-engine-pin` are green. `pnpm lint:casts` reports `delta=0`. `pnpm lint` reports the same warning and info counts as main.
- § 4.3's grep finds nothing.
- Run `pnpm test` from this worktree, not from a scratch copy. Some target and local-target tests start emulator daemons. Stop no emulator you did not start; if tests fail because of an emulator this run did not start, record it and report. Never run `pnpm test:integration`, `pnpm test:e2e` or `pnpm test:all`. Run `bun run test/local-dev.integration.ts` from `test/integration`; the other integration tests run in CI.
- `@prisma/cli-engine` is 0.9.0 in every manifest, `pnpm.overrides` and the lockfile, as on `main`.
- Every document in § 14 is updated. The pull request carries § 13.
- **Manual QA**, recorded in `qa.md` in this slice's folder, after `pnpm build`. Credentials: `set -a; . ~/.config/prisma-compose/deploy.env; set +a`, never printing a value, with `PRISMA_REGION=us-east-1`. Every hosted step runs from `examples/email`, after `pnpm turbo run build --filter @prisma/example-email...`, as `( set -a; . ~/.config/prisma-compose/deploy.env; set +a; PRISMA_REGION=us-east-1 bun ../../node_modules/.bin/prisma deploy --name s13qa-email --environment s13-qa )`, called "the deploy" below. The name `s13qa-email` keeps the workspace's existing `email-example` project untouched. The secret value is generated once: `export S13_QA_SECRET="s13qa-$(openssl rand -hex 8)"`; `qa.md` records only its first five characters.
  1. **Files, deployed to Prisma Cloud.** Write `examples/email/.env.s13-qa` with `EMAIL_DELIVERY_MODE=none` and `EMAIL_FROM=s13qa@example.com`, and `examples/email/.env.s13-qa.local` with `EMAIL_DELIVERY_CREDENTIAL=$S13_QA_SECRET` (the value, written by the shell). Write `.env.defaults` with `EMAIL_FROM=defaults-must-not-win@example.com`. In a second shell, from `examples/email`, run `while true; do cp .prisma-composer/app-configuration-*.json ../../wip/s13-qa-configuration.json 2>/dev/null; sleep 0.2; done`. Run the deploy. Stop the loop. Record: the deploy succeeded, with `prisma.config.ts`'s `config: [dotenv(), environmentVariables()]` and `secrets: [dotenv(), environmentVariables()]`, and without `CONFIG.SECRET_AS_PLAIN_VALUE`; its output shows `s13qa@example.com` and `none` wherever it prints them, not `[redacted]`; `wip/s13-qa-configuration.json` holds `appConfigurationRead.rootInput` with `EMAIL_DELIVERY_MODE` and `EMAIL_FROM` set to `s13qa@example.com` (not the `.env.defaults` value), `configurationKeyText` `{}`, and `nodeAddresses`; `ls -l` showed mode `-rw-------` on it while it existed; `ls .prisma-composer/app-configuration-*.json` finds nothing after the deploy; `grep -r "$S13_QA_SECRET" .prisma-composer ../../wip/s13-qa-configuration.json` finds nothing; the Management API lists `EMAIL_DELIVERY_CREDENTIAL` on the `s13-qa` Branch (metadata only).
  2. **Removed.** The second process's output is not redacted under the CLI (§ 9.5), so there is nothing to check here.
  3. **An adapter's error is redacted.** Put, for this step only, `config: [() => { throw new Error(\`cannot use ${process.env.EMAIL_DELIVERY_CREDENTIAL}\`); }, dotenv(), environmentVariables()]` in `prisma.config.ts`, export the variable again, and deploy. Record the `CONFIG.ADAPTER_FAILED` output: its `Why:` line reads `It threw: cannot use [redacted]`. No graph exists yet, so no value is a known secret; the exported variable's name looks like a credential, and that redaction hides it. Restore `prisma.config.ts` and unset the variable.
  4. **A different graph is refused.** Add, for this step only, to the root body in `examples/email/module.ts`: `if (process.env.PRISMA_COMPOSER_APP_CONFIGURATION_FILE !== undefined) provision(email(), { id: 'extra', input: { deliveryMode: input.EMAIL_DELIVERY_MODE, from: input.EMAIL_FROM, deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') } });`, and deploy. Record that it fails with `DEPLOY.ENGINE_FAILED`, whose cause names `"s13qa-email.extra"` (and the nodes under it) as only in the second process, and that nothing new was created on the Branch. Restore `module.ts`.
  5. **`prisma dev`.** Write `examples/email/.env.dev` with the same two plain values, `EMAIL_FROM=dev-qa@example.com`, and `.env.dev.local` with `EMAIL_DELIVERY_CREDENTIAL=$S13_QA_SECRET`. Run `prisma dev --detach` from `examples/email`. Record: it started; no `.prisma-composer/dev/dev/app-configuration-*.json` exists after it returns; `grep -r "$S13_QA_SECRET" .prisma-composer .alchemy` finds nothing (the compute emulator's own copy lives outside the project, as ADR-0058 records); `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{"email":"qa@example.com","name":"QA"}' "$(prisma dev url email-example.mailer)/signup"` prints a 2xx status. Then `prisma dev stop`.
  6. **Clean up.** Run `( set -a; . ~/.config/prisma-compose/deploy.env; set +a; PRISMA_REGION=us-east-1 bun ../../scripts/composer-destroy.ts --environment s13-qa --name s13qa-email )`, and the same with `--environment production` if step 1 created it; record that destroy ran no secrets adapter (step 3's throwing adapter, put in `secrets` for this check only, does not fail it). Delete `.env.s13-qa`, `.env.s13-qa.local`, `.env.defaults`, `.env.dev`, `.env.dev.local` and `wip/s13-qa-*`. `git status` shows only this PR's changes.

## 18. Checks the spec author ran

One scratch worktree at the git-ignored `wip/s11-scratch`, removed afterwards. No process was left running. The probe scripts are kept at the git-ignored `wip/s11-s13-spec-probe/` for the review.

- **`dotenv-flow` 4.1.0** (`dotenv-flow-order.mjs`), with `.env.defaults`, `.env`, `.env.local`, `.env.production`, `.env.production.local`, `.env.test`, `.env.test.local` and `.env.defaults.local` in one folder. Given the pattern `.env[.node_env][.local]`, `listFiles` returned `.env.defaults` first for every environment: that string equals `dotenv-flow`'s `DEFAULT_PATTERN`, and `listFiles` adds `.env.defaults` exactly when the pattern equals it. The order after it was `.env`, `.env.local`, `.env.<environment>`, `.env.<environment>.local`; for `test` it skipped `.env.local`; for an environment named `defaults` it listed `.env.defaults` twice, first as the defaults file and later as the environment's file. `parse([])` returned `{}`, and `process.env` was untouched.
- **The filter** (`dotenv-flow-filter.mjs`): dropping the first entry when it is `<dir>/.env.defaults` gave `.env, .env.local, .env.production, .env.production.local` for `production`, kept the environment's own file for `defaults`, and changed nothing once `.env.defaults` was removed.
- **The stream redactor, first version** (`redactor.ts`, `redactor-probe.ts`, run with Bun): a secret split across two chunks was redacted; overlapping secrets `abc` and `abcdef` gave the longest match; a one-character secret was redacted; for chunk sizes 1, 2, 3, 5, 8, 9, 10 and 64 over a 6000-character text, the output equalled the text with every secret replaced.
- **Alchemy without a terminal** (`alchemy-no-tty.run.ts`): `node node_modules/alchemy/bin/cli.js deploy alchemy.run.ts --yes --stage probe` with stdout and stderr redirected to files and stdin from `/dev/null` exited 0, ran the stack effect (`process.stdout.isTTY` undefined), and printed plain timestamped log lines. Alchemy decides interactivity from `stdin.isTTY && stdout.isTTY` and agent variables, so a piped run is non-interactive, and `--yes` covers the confirmation.
- **The engine's `ctx.spawn`, 0.9.0** (`dist/report-*.d.ts` and `dist/engine-*.js`): `SpawnOptions` takes `command`, `args`, `cwd` and `env` only; the request's `output` is `"inherit"` or `"diagnostic"`, chosen by the engine from the output format; the engine logs `command` and `args` in debug mode, never `env`; it forwards SIGTERM to its child and, on a programmatic abort, ends it with SIGTERM, then SIGKILL.
- **The engine change, prisma/prisma-cli#383, final API** (head `415c668a`, read in its `README.md` and with `git diff origin/main...HEAD`): `SpawnOptions.transformOutput?: (stream: ChildStreamName) => TransformStream<string, string>`, called once per stream before the child starts; the spawn request's `output` is `"engine"` and the adapter returns both streams; the result is written where the output format sends the child's output, with backpressure; each transform's `flush` runs before `ctx.spawn` settles on every path; the engine replaces the `PRISMA_SERVICE_TOKEN` it injects with `[redacted]` before the transform; `ctx.spawnOptionNames` is `SPAWN_OPTION_NAMES` (`command`, `args`, `cwd`, `env`, `transformOutput`), and `ctx.spawn` refuses any other option name. The harness's scripted child has `write(stream, chunk)`, and `SpawnRecord.output` records the request's `output`. The README calls Composer's stdout preload redundant; § 9.5 says why it stays.

Checks for this amendment, in a scratch worktree at the git-ignored `wip/s11-amend-scratch`, removed afterwards:

- **The stream redactor and its transform** (`redactor.ts` and `probe.ts`, run with Bun): § 9.3's `StreamRedactor` and `redactingTransform`, piped from a `ReadableStream`, redacted a secret split across two chunks; with the values `SECRETXYZ` and `SECRET` over a 2000-part text with line breaks, chunk sizes 1, 2, 3, 5, 8, 9, 10 and 64 gave the text with every `SECRETXYZ` replaced; `push('0123456789')` with `abcdef` returned `01234` and `end()` returned `56789`; a complete line came out at once; a secret with a line break, split at the break, was redacted whole; overlapping `a`, `abc` and `abcdef` gave the longest match.
- **Types**: `redactor.ts` type-checks with the repo's TypeScript 6.0.3 under `strict`, `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`, once with the DOM library and once with only `@types/node`, so `TransformStream` and `match.index` need no cast.
- **Pins**: `@prisma/cli-engine` is `0.9.0` in `packages/0-framework/3-tooling/cli` (`dependencies`), `packages/1-prisma-cloud/1-extensions/target` (`devDependencies`), `packages/9-public/composer-cli` (`peerDependencies` and `devDependencies`) and the root `pnpm.overrides`.
- **Quotes against S10**: every code and document quote in § 5, § 10 and § 14 was checked against this branch at `78166d80` (§ 19).
- **Not run**: the implementation as a whole, `pnpm test`, a build of the new entries, any deploy, and the redactor against the engine, which is not published yet.

## 19. What S10 changed

S10 is on this branch. It typed a service's binding from its schema, renamed `ServiceInputBinding` to `InputBindingUse` and typed its `binding` as `unknown`. § 5.3's `appConfigurationReadOf` now takes `readonly InputBindingUse[]`. S10 did not change `SourceOptions`, `ParamSourceOptions`, `secretSource()`, `paramSource()`, `value.ts`'s source origin, `resolveValues`'s `configPool` reading, `loadModule`'s root input block, the CLI, the stack files, the operations or redaction, so every other quote in § 5 and § 10 matches the code. In the documents, S10 rewrote the binding sentences of `config-params.md` and the glossary, and `config-params.md` had four pool lines, at 99, 144, 161 and 300. ADR-0029's rewrite (§ 14.1) says a wrong binding fails to compile, as S10 made it.

## 20. Decisions this spec records, for the review

1. **Under the CLI, the second process's output is not redacted, for now** (§ 9.5). Will dropped the engine change it needed on 2026-11-05, because running Alchemy through its programmatic API will remove the second process. Programmatic hosts pipe in-process through the stream redactor (§ 9.4). The secret values stay in the first process; no environment variable, argument or file carries them.
2. **The stream redactor holds back only an end of the output that could start a secret, and never splits a surrogate pair** (§ 9.3), so a progress line or a prompt is printed at once, not after the platform's next answer.
3. **`dotenv()` filters `.env.defaults` itself** (§ 3.2): the design's pattern does not keep `dotenv-flow` from listing it (§ 21, finding 1). It parses one file at a time, merged in `dotenv-flow`'s order, so an unreadable file is named, as today.
4. **The known secrets are only the values under the names an `envSecret()` in the graph names** (§ 9.1), in the app secrets and the app configuration. The lists are pools of values Composer may carry. Treating every value a written list returns as a secret made every `.env` value and every shell variable one under `secrets: [dotenv(), environmentVariables()]`: the deploy refused every root input field with `CONFIG.SECRET_AS_PLAIN_VALUE`, and the redactor blanked every `1` and `true` (review finding F16; Will's ruling). The app secrets are still read before the app configuration (§ 7.3).
5. **The redaction set keeps S4's credential-name heuristic**, the credential-looking values of eight characters or more in the process environment and the app configuration, and S4's shape patterns. They are redacted, but they are not known secrets, so the app configuration file check ignores them. This is existing behaviour, kept for now, not part of the design's redaction. Without it, a value such as `STRIPE_KEY` in the app configuration under the default lists, which no `envSecret()` names, would stop being redacted. The decision records and the design say the same (§ 14.1, § 14.4).
6. **The stream redactor matches exact values only**; the shape patterns (bearer tokens, JWTs, URL passwords) apply to whole texts: errors, events and failure causes. A pattern cannot be held back across chunks by a length.
7. **Core gains `secretSource()`'s `secretsKey`** (§ 5.5), so the CLI can list the names `envSecret()`s name without knowing a target's payload, as `paramSource()`'s `configurationKey` already does for params.
8. **Load records what it read on the graph** (`graph.appConfigurationRead`), so the first process writes exactly that and the second process Loads with it; core imports no `node:` module and reads no environment variable for this.
9. **The dev app configuration file lives only while a converge runs**, at `<dev environment dir>/app-configuration-<pid>.json`, which is stricter than the design's "deleted when `prisma dev` stops".
10. **The app configuration file for a deploy has a unique name** per run, as the result file does, passed in `PRISMA_COMPOSER_APP_CONFIGURATION_FILE`, so two deploys from one checkout never read each other's.
11. **A name read both as a configuration key and as a secrets key fails the Load** (§ 5.3), because the first would put the second's value in the app configuration file.
12. **A non-text configuration value in a service's input or params fails at Load**, in the first process, because the first process must decide what the file holds; before, the serializer or preflight raised it.
13. **A redacted error is a new `CliStructuredError` with the same code and no cause** (§ 9.3). ADR-0044's record changes to say so. A thrown defect is redacted in place where it can be, and replaced by a new error when it cannot be changed.
14. **No example adopts `dotenv()` in this PR**; `examples/email` and `examples/auth` already use it, and `examples/storefront-auth` keeps `import 'dotenv/config'`, which still works.
15. **`PRISMA_COMPOSER_PARENT_VALUES` goes**, because no child runs an adapter.
16. **Decision records are rewritten in full** (§ 14.1), as Will asks, and ADR-0062, already one current record, is edited in place.
17. **The app configuration file check refuses a known secret anywhere in a value**, numbers and booleans compared as text, and ignores credential-looking values (§ 8.1).
18. **Leftover app configuration files are deleted only when their process is not running and they are older than ten minutes**, and the CLI also deletes its own file at process exit (§ 8.1).

## 21. What the design gets wrong or does not say

1. **Wrong: the pattern does not exclude `.env.defaults`.** Design section 8 said passing `.env[.node_env][.local]` keeps `dotenv-flow` from reading `.env.defaults`. That string is `dotenv-flow`'s own default, and `listFiles` adds `.env.defaults` exactly when the pattern equals the default (§ 18). This spec filters it out (§ 3.2). Will accepted the correction; § 14.4 and § 14.1 make the design and ADR-0062 say `dotenv()` drops it.
2. **Resolved: "Composer reads that output through a pipe" under the CLI.** `@prisma/cli-engine` 0.9.0's `ctx.spawn` cannot hand a command its child's output. The first version of this spec added a relay process. Will chose the engine change instead, prisma/prisma-cli#383, and then dropped it on 2026-11-05: Composer will run Alchemy through its programmatic API, which removes the second process. Until then the second process's output is not redacted (§ 9.5), as design.md section 9 now says.
3. **Not said: how the CLI knows the names an `envSecret()` names.** Core sees only an opaque payload. This spec adds `secretsKey` to `secretSource()` (§ 20, decision 7), a core SPI change. Will accepted it; § 14.4 adds it to the design.
4. **Not said: what is redacted before the graph exists.** An adapter failure or a Load error happens before the CLI knows any `envSecret()` name. Only the credential-name heuristic applies then, whatever the lists (§ 20, decision 4).
5. **Conflict with a recorded decision: ADR-0044 says a structured error is never transformed between its origin and the consumer.** Redaction transforms it. § 14.1 rewrites that statement; this reverses it for redaction only.
6. **Not said: a name read by both `envParam()` and `envSecret()`.** Without a refusal, the app configuration file would hold a secret (§ 20, decision 11). Will accepted the refusal; § 14.4 adds it to the design.
7. **Consequence not stated: the reproduce command no longer works after a run.** It needs the app configuration file, which is deleted when the run ends. It already needed the container and preflight variables the CLI passes, so a user could not run it bare before either; the second process's error now says why (§ 12).
8. **Size.** This is one pull request, first of nine commits plus review fixes, touching core, the CLI, both public packages, the target, the local target, five decision records and three guides. The plan keeps them together, and this spec does too.
9. **Closed: the credential the engine gives the child.** The first amendment found that a `PRISMA_SERVICE_TOKEN` from `prisma login` never reaches Composer, so its redactor could not match it. With #383 dropped, the second process's output is not redacted at all (§ 9.5); its failure cause is redacted with the credential-looking values of the process environment.
10. **Closed: an older engine.** With #383 dropped, Composer runs on `@prisma/cli-engine` 0.9.0 and checks no engine version.
11. **Closed: `destroy` checks the file against fewer secrets.** `destroy` runs only the config adapters (Will's ruling, so an unreachable secrets manager cannot block a teardown). Its check before writing the app configuration file compares against the values under the graph's secrets keys in the app configuration only. Since the known secrets are only the values the graph names (§ 20, decision 4), destroy no longer misses a value that only a written `secrets` list returns; `deferred.md` closes F11. Load's refusal of a root field named like an `envSecret()` still applies.
12. **Known limit: the stream redactor's cost grows with the square of the longest secret's length.** It applies to programmatic hosts only (§ 9.4). It matters only for secrets of many kilobytes, such as a CA bundle in a credential-named variable. ADR-0062 and `deferred.md` record it.

## History

- **First version.** It added a relay process to read the second process's output.
- **Second version, after Will's decisions.** The engine's per-stream output transform (prisma/prisma-cli#383, `@prisma/cli-engine` 0.10.0) replaced the relay. `StreamRedactor` holds back only an end that could start a secret and keeps surrogate pairs whole. Composer refuses an older engine with `DEPS.CLI_ENGINE_INCOMPATIBLE`. `STDOUT_TO_STDERR` stays. Name-based redaction is described as existing S4 behaviour. The design was corrected on `.env.defaults`, `secretsKey`, the name refusal and the transform. Quotes were checked against S10.
- **Round 1 review fixes (F01 to F08, D01 to D14).** Load refuses a root field named like an `envSecret()`, and the CLI refuses a secret in the app configuration file. One `SecretMatcher` hides overlapping secrets whole and makes the stream redactor fast for many secrets. Leftover files are deleted at the next run. `redactThrown` redacts the cause chain. One redaction set serves every output. "The configuration file" became "the app configuration file", holding `{ appConfigurationRead, nodeAddresses }`; `PRISMA_COMPOSER_NODE_ADDRESSES` went. `prepareSecondProcess` owns the handover. `environmentVariables()` returns the whole process environment. `LoadOptions` became a union, and the source origin gained `sourceKind`. The decision records were renamed and made consistent. Why: the reviews found secrets that could reach the file or the output, and names that did not say what they held.
- **Round 2 review fixes (F09 to F15, D15 to D19).** `redactThrown` never throws, so a `DOMException` or a frozen error no longer hides the defect. The file check finds a known secret anywhere in a value. The CLI deletes its file at exit, and the leftover sweep also needs the file to be ten minutes old. Load refuses both options at runtime again. The names split the two kinds: `KnownSecrets` and `SecretRedaction`, `addKnownSecrets` and `addCredentialLooking`, `allValues()`, `credentialNamedValues`, `redactCredentialLooking`, and `prepareSecondProcess`'s `knownSecrets`. The records, `core-model.md` and the glossary follow. This spec now describes the current design in one pass. Two known limits are recorded (§ 21, items 11 and 12).
- **Round 3 review fixes (F17, F18, D21 to D23).** `redactThrown` takes any thrown value: one that is not an `Error` becomes an `Error` with its redacted text, so a thrown string no longer reaches the user or a reporter unredacted. It also never throws when a getter throws, a `message` is not text, or a cause is a revoked proxy. The heuristic has one name: `credentialLookingValues` and `addCredentialLookingValues`. `prepareSecondProcess`'s comment names `knownSecrets` as its one input that is not plain data from the graph. F16 and D20 wait on Will's decision.
- **2026-11-05: the engine change is dropped, and the known secrets are only the values the graph names.** Will dropped prisma/prisma-cli#383, because Composer will run Alchemy through its programmatic API. `transformOutput`, `spawnOptionNames`, `outputTransformMissing`, `DEPS.CLI_ENGINE_INCOMPATIBLE` and `redactingTransform` are gone, `@prisma/cli-engine` stays at 0.9.0, and the CLI gives the second process the terminal as on `main`; its output is not redacted (§ 9.5). Tests 39, 40, 42 and 43 are removed, and 27 and 28 test `StreamRedactor` directly. Will also ruled on F16: the lists are pools Composer may carry, read only for the names the graph names. `readAppSecrets` adds no known secret; the known secrets are only the values under the graph's secrets keys (§ 9.1, § 20 decision 4). Test 50 is removed, and tests 79 and 80 are added. Manual QA step 2 is removed, and step 1 checks the two-list setup.
