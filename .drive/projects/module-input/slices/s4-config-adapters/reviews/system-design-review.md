# S4 system design review: config adapters and the root's input

**Range:** `claude/module-input-s3...claude/module-input-s4` (base is S3's branch, not `main`). **Spec:** [`../spec.md`](../spec.md). **QA:** [`../qa.md`](../qa.md). **Companion:** [`code-review.md`](code-review.md).

**Read for this pass:** `CLAUDE.md`; `docs/design/01-principles/` (both files); the decisions on deploy deriving everything from the root node (ADR-0003), secrets (ADR-0029), provision-time params (ADR-0032), the `composer` section (ADR-0049), dev secrets (ADR-0058), module input (ADR-0061) and `resolve()` and config adapters (ADR-0062), each in full with this slice's amendments; the errors decision's new amendment line (ADR-0044); the decisions index; `.drive/projects/module-input/design-notes.md`; the glossary entries Config pool, Secrets pool, Config adapter, Value and Environment; the `deploy-cli.md`, `local-dev.md`, `config-params.md`, `core-model.md` and `module-composition.md` changes.

## What the slice does

The `composer` section of `prisma.config.ts` gains two lists, `config` and `secrets`. Each holds config adapters: functions that receive `{ environment, configDirectory }` and return an object of values. The CLI merges each list into a pool, a later adapter winning by top-level key. Both lists default to `[environmentVariables()]`, which reads the process environment, so a project without the keys reads what it read before. `dotenv()` reads four files beside `prisma.config.ts`.

The config pool becomes:

- the root module's `input`, validated by the root's schema in Load before any other module's binding;
- what `envParam('NAME')` reads, in Load, in the serializer, and in both preflights.

The secrets pool becomes what deploy preflight fills a missing `envSecret()` platform variable from, and what `prisma dev` gives a local service. The deploy child reads the config pool again from the same adapters; the dev child reads both. A dev session whose adapters return different values at a rebuild pauses rebuilds.

## Fit with the recorded design

- **Layering is right.** The types (`ConfigAdapter`, `ConfigPool`, `SecretsPool`, `ConfigPools`) live in core's `control/app-config.ts`, next to `PrismaAppConfig`. The adapters and pool readers live in the CLI package, the target-neutral package that already reads the user's files and environment. Core still imports no `node:` module and its `process.env` count is unchanged. `describeKind` lives in foundation's errors entry, where core, the CLI and the target can all use it.
- **The child re-reading the adapters follows the existing rule.** The child already re-imports `prisma.config.ts` because the section's descriptors are functions; adapters are the same kind of value. This matches the `composer` section decision and the `resolve()` purity rule.
- **"Users own their environment" survives.** The dev secrets decision rejected Composer loading `.env` itself. The amendment says honestly that this is partly reversed, and why the reasoning still holds: the user names `dotenv()`.
- **Target-neutrality holds.** Core knows pools only as records. The Prisma Cloud target decides that `envParam()` reads text and that a name used both ways is a secret.
- **One inaccuracy in the amendments, covered by A01:** the `resolve()` and config adapters amendment says "A root's input therefore holds no secret", and the spec says "the deploy engine's process never holds a secret value". Neither is true under the configuration the guides recommend.

## Findings

### A01. The two pools read the same sources, so every secret is in the config pool, and the root's input carries it

**What the design says.** The spec (§ 2, § 7), the `resolve()` and config adapters amendment, and the glossary all say the secrets pool never reaches Load, a schema, a file or a report, and that a root's input "holds no secret".

**What happens.** Both lists default to `[environmentVariables()]`, and the guides recommend `config: [dotenv(), environmentVariables()]` and `secrets: [dotenv(), environmentVariables()]`. Both read the same shell and the same four files. So every secret exported in the shell, and every secret in `.env.<environment>.local`, is also in the config pool. The secrets pool object never reaches Load, but its values do, through the config pool. The QA run shows this: `.env.s4-qa.local` held `S4_QA_SECRET`, and `config: [dotenv()]` read that file, so the deploy child's config pool held the secret.

The root's binding is the whole pool, and a schema that ignores undeclared keys (ArkType's default) returns the whole pool as the root's input. The design notes allow forwarding `input` whole. A probe against this branch shows the consequence:

```ts
module('shop', { input: type({ GREETING: 'string' }) }, ({ input, provision }) => {
  provision(web, { input });        // or: { input: resolve([input], ([i]) => i) }
});
// configPool { GREETING: 'hi', STRIPE_KEY: 'sk-123' }
// Prisma Cloud input row: {"GREETING":"hi","STRIPE_KEY":"sk-123"}
```

The input document is "secret-free by construction" in the secrets decision, so the deploy report prints it verbatim, and it is written to the platform. With the default lists, the document would carry the entire shell, `PRISMA_SERVICE_TOKEN` included.

**What it would take.** This needs Will's decision, because each option changes a recorded statement:

1. Load refuses the root's `input` forwarded whole, and refuses it listed whole as a `resolve()` dependency, with an error that says to bind the fields. This reverses the design note "input can be forwarded whole" for the root only. It is the narrowest fix: Composer cannot list a schema's keys, so it cannot cut the pool down to them.
2. Leave the behavior and correct the claims: the root's input can hold secrets, so forwarding it whole is unsafe. This contradicts the secrets decision's "the input document is secret-free by construction".

Either way, the `resolve()` and config adapters amendment, spec § 7 and the glossary's Secrets pool entry should stop saying the root's input and the deploy child hold no secret. What is true is narrower: nothing Composer writes reads the secrets pool, and a root schema field typed `secretString()` refuses a plain value.

Code-level detail and tests: [`code-review.md` F01](code-review.md#f01).

### A02. The root's schema messages echo pool values, including the one case the design anticipates

The spec says a root field typed `secretString()` "receives a plain string from the config pool and refuses it". It does, but the message prints the value: `KEY must be a SecretString box — bind this field to a secret (was "sk_live_…")`. ArkType appends the actual value, and the root's error passes the schema's messages through. For a module or service binding the refused value was a literal in code; for the root it comes from the pool, which (A01) holds real secrets. The fix belongs in foundation's `secretString()`, which should never describe the value it refuses. See [`code-review.md` F02](code-review.md#f02).

### A03. The default adapter does not return the same values in the CLI and in the deploy child

The `composer` section amendment says an adapter "must return the same values for the same environment in both processes". The CLI starts the deploy child with its own environment plus Composer's transport variables: the preflight payloads (`PRISMA_COMPOSER_PREFLIGHT_<extension>`) and the serialized containers. So `environmentVariables()`, the default, returns more keys in the child than in the CLI. Today this is harmless: a root reads its fields by name, and a schema that refuses unknown keys already fails in the CLI on `PATH`. With A01's forwarding it is not harmless: the child's input document would also carry the preflight payload.

Either state this in the amendment (the default adapter sees Composer's own transport variables in the child), or have `environmentVariables()` leave out the `PRISMA_COMPOSER_` variables Composer itself writes for the child. The second is not guessing: the names are Composer's own reserved prefix.

### A04. `pools` sits on the attach input, so `log` has to invent empty pools

`LocalTargetAttachInput` gains `pools`. Only `serve` uses them, to give a dev server its values. `log` also calls `attach`, and the pool table says `log` reads no adapter, so `execute-log.ts` passes a frozen `NO_POOLS`. The attachment it gets back has a `serve` that would start a service with no secrets. Nothing calls it today, so this is not a bug. But the value belongs where it is used: on `serve`'s input, or on `LocalTargetProvidersInput` only. Moving it would remove the made-up empty value. Low priority; acceptable to leave with the existing comment.

### A05. The public `/config` entry now exports pool readers that only generated files should call

`@prisma/composer/config` now exports `readConfigPool` and `readSecretsPool`. They exist for the generated stack files, which can import only the app's own `@prisma/composer`. The entry already has a precedent (`deserializeContainers`), so the choice is consistent. The consequence is that both readers become supported public API, and `readSecretsPool` is a function any config file can call to obtain every secret. Consider marking both `@internal` in their doc comments, as generated-file plumbing, so they can change without a breaking release.

### A06. `deploy-cli.md` explains the pipeline order instead of fixing it

The pipeline list in `deploy-cli.md` numbers Load as step 2 and "Read the pools" as step 5, then adds a sentence to step 2 saying Load "runs after the name is resolved and the pools are read (steps 4 and 5)". The list was already out of order before this slice (Load ran after the config and the name), but this slice adds a step that makes it harder to follow. Reorder the list to the order `runPipeline` runs: import the entry, load the config, resolve the name, read the pools, Load, check coverage, assemble.

## Naming and typology probes

- **`ConfigAdapter` for a function in the `secrets` list.** The resolve() and config adapters decision calls both lists' functions config adapters, and the glossary now defines the term that way. Accepted: the name says what the function is (it adapts an outside store into Composer's configuration), not which list it is in.
- **`ConfigPools` holds a config pool and a secrets pool.** The plural reads as "two config pools", and the secrets pool is defined as not a config pool. `Pools` alone would be vaguer. Accepted, since the field names `config` and `secrets` disambiguate at every use.
- **`fromConfigPool: boolean` on `ProvisionedModuleInput`.** It is true only for the root, and the only behavior it changes is the error text. The name describes where the binding came from, which is the true reason the message differs. Accepted.
- **`environmentVariables()` and `dotenv()`.** Both name what they read, in the established language: the process environment's "environment variables", and the `dotenv` file convention. No coined term.
- **`poolText`.** Says what it returns: the pool's value as text, or nothing. Accepted.
- **No qualifier prefixes** (`Authored*`, `Internal*` and the like) were introduced.

## Test strategy at the architectural level

The properties that must hold, and where they are proven:

- **Existing projects behave as before.** Proven by the default-list tests (config pools 13 and 14), the renamed pipeline test, and every pre-existing suite passing unchanged except the listed edits.
- **The secrets pool goes only to preflight and local dev.** Proven for events, results and the report file (operations test 46) and the stack files (generate-dev-stack sentinel test, which is a regression guard: the renderer never reads the environment). Not proven, and not true, for the config pool's copy of the same values (A01).
- **The child reads the same adapters.** Proven by the stack-file import test with stub readers. Nothing proves the child gets the same values (deferred, correctly).
- **Missing:** a test that the root's whole `input` cannot reach a service's input document, once A01 is decided; and a test that a refused root field's message does not contain the refused value (A02).

## Out of scope for this pass

Implementation correctness, failure modes, the stale error messages, redaction of the engine-failure output and the acceptance-criteria verification are in [`code-review.md`](code-review.md).
