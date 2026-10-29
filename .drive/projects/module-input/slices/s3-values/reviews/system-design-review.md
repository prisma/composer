# S3 system design review: sources are values

**Range:** `claude/module-input...claude/module-input-s3` (base is S2's branch, in review as prisma/composer#401, not `main`). Nine commits, `25be8fe4` to `181dc28c`.

**Spec:** [`../spec.md`](../spec.md). No pull request exists for this branch yet.

**Read before reviewing:** `CLAUDE.md`; `docs/design/01-principles/` (both files); the decision records in full: secrets are an environment-sourced value the framework never stores (ADR-0029), params bind at provision and env-sourcing is a target source (ADR-0032), service input is one standard schema (ADR-0042), a module declares its input as a compute service does (ADR-0061), environment values come from `resolve()` and config adapters (ADR-0062); `.drive/projects/module-input/design-notes.md`; the glossary's Value and Configuration entries; `docs/design/10-domains/config-params.md`, `module-composition.md` and `core-model.md` as changed by the branch.

## What the slice does

Before this slice, `envParam()`, `envSecret()`, `generatedParam()` and `serviceOrigin()` returned opaque sources that core forwarded but could not compute with. A module's `input` refused a param source, and a `resolve()` function could not list a source.

After it, each constructor returns one frozen object that is both the target's source and a `Value`. The type says what it stands for: `envSecret()` is `SecretSource<EnvSecretPayload> & Value<SecretString>`. Load treats the object two ways:

- Where a binding took a source before (a service's `input`, a service's `params`, a module's `secrets` and `params` slots), Load leaves the object in place. The serializer, preflight and boot see exactly what they saw before.
- Where core needs a real value (a module's `input`, a `resolve()` dependency, a resource's `props`), Load computes one. For `envParam('NAME')` it reads `NAME` from a new `LoadOptions.configPool`, which the CLI and the generated stack files fill with `process.env`. For the other three the real value is the source itself, a **pointer**, which throws when code turns it into text or a number.

Three new guarantees follow:

1. A `resolve()` function may return a pointer it received, at any depth, matched by identity. It may not return a source it made itself.
2. `graph.secretSources` lists every `envSecret()` the graph names, including one only a `resolve()` dependency lists and one in a module's input that no service receives. Deploy preflight checks all of them; dev preflight keeps its per-service rule.
3. A module's schema checks a runtime param source through a stand-in its target names (`https://origin.invalid` for `serviceOrigin()`, `''` or an empty `SecretString` for `generatedParam()`), and Load puts the source back. A schema that changes such a field fails Load.

## Fit with the recorded design

**One object, not a wrapper.** The design notes first said a source would become "the payload inside a value". The spec chose one object instead, and the branch updates the design notes to match. This is the right call: every target path that reads a source without Load (the serializer, its tests, preflight) keeps working, and `isValue()` is true either way. No recorded decision is reversed.

**Thin core, no target knowledge.** Core learns three facts about a param source from options the target passes: a config pool key, a stand-in string, and whether it is redacted. It never reads the payload and never names a target. This keeps the principle that the core knows nothing about specific deployment targets. The stand-in strings are the same ones the serializer already uses for a service, now exported from `param.ts`, so the module's schema and the service's schema check the same thing.

**Core still does not read the environment.** Core's invariant test allows `process.env` only for the container transport. The commands pass the environment in. This matches the no-globals principle and gives the config adapters, planned for the next slice, one option to fill.

**Secrets stay out of deploy state.** The deploy still holds only a pointer for `envSecret()`. A function can choose between pointers but cannot read one. The secrets decision's core promise holds.

**Preflight now depends on the graph, not on one environment's choice.** Checking every listed secret, whichever one a function returns, follows the design notes, which Will settled. The guide says plainly that the multi-key `resolve()` example needs both variables in every environment. Dev preflight does not check them; the spec records that as a decision. A `prisma dev` that starts therefore does not predict that deploy preflight passes. That asymmetry is recorded, so it is not a finding.

## Findings

### A01. `configKey` already means something else in this codebase

`ParamSourceOptions.configKey` (public, exported from `@prisma/composer`) and `SourceOrigin.configKey` mean "the config pool key whose value at deploy is the real value". The term "config key" already has an established meaning here: the platform variable key derived from a node's address. The node-address principle lists "config keys" among the names derived from the address, `core-model.md` uses it the same way, and the Prisma Cloud target exports a function `configKey()` that builds `COMPOSER_<address>_<name>`. A reader of `paramSource(payload, { configKey: 'APP_ORIGIN' })` cannot tell which of the two it means, and a target author will meet both names in one file.

Suggestion: rename the option and the origin field to `poolKey` (or `configPoolKey`), and the docs' "a source with a config key" to "a source with a pool key". It is a public SPI field added in this slice, so renaming now costs nothing.

### A02. `SecretSourceUse.nodeKind` has no value for a resource

`nodeKind` is `'service' | 'module'`, but Load records a secret source from four binding sites: a service's input, a service's params, a module's input, and a resource's props. The props site maps to `'service'`. A secret that a `resolve()` lists inside a resource's props is recorded as `{ address: 'shop.site', nodeKind: 'service' }`, and deploy preflight would report it as `used by service "shop.site"`. I confirmed this with a throwaway probe test. The behaviour and the fix are in the code review (F01). The design point is that the discriminator does not cover every node kind it is derived from. Either add `'resource'`, or decide that a resource's props never name a secret source and stop recording from that site.

### A03. The module input decision still says `paramSource()` and `secretSource()` are unchanged

The module input decision (ADR-0061) says, under Consequences: "`paramSource()` and `secretSource()`, which targets use to build their sources, are unchanged." This slice changes both: each takes a second options parameter and returns `& Value<T>`. The branch amends the secrets, provision-time params and `resolve()` decisions, but not this one. Add a one-line amendment note there, and the matching index line, saying the constructors now take options and return values.

### A04. The secrets decision's amendment contradicts itself

The new amendment note in ADR-0029 says the target receives the same object, "so the pointer, preflight and boot are unchanged", and three sentences later says deploy preflight now checks more secrets than before. Reword the first sentence to "so the pointer and boot are unchanged" and keep the preflight sentence.

### A05. "Config pool" is a public term with no glossary entry

`LoadOptions.configPool` and `LowerOptions.configPool` are public, and the guides, the decision amendments and the core-model doc use "config pool". The glossary defines "pointer" inside the Value entry but has no entry for the config pool. The next slice makes the pool the merged output of the config adapters, so the term will carry more weight. Add a short glossary entry: what it is, who fills it (the commands, today with the process environment), and what reads it (a source with a pool key).

### A06. The glossary and the skill still misdescribe where an `envParam()` value lives

Spec § 15, conflict 4, set out to correct the docs that call the platform variable the store for an `envParam()` input. The guides are corrected. Two places remain off:

- The glossary's Configuration entry says an `envParam` value is "never written into deploy state" and that environment sources "re-resolve per environment and never enter deploy state". For an `envParam()` in a service's input, the corrected guide now says the deploy reads the shell and "writes its value into the service's input". With this slice, a module's input and a `resolve()` dependency read it at deploy too. The glossary should say where the value goes for an input leaf, as the guide does.
- The skill's rule 2 now says "Only `envSecret` lives on the platform". An `envParam()` bound to a service param still keeps a platform pointer row, read at boot (the provision-time params decision). Scope the sentence to `input`, as its first sentence is.

These are doc accuracy points in the area this slice rewrote, so they are in scope.

## Naming and typology probes

- **`isRuntimeValue()`** is true for the source object in the module body and for the pointer a function receives. Because the two are one object, the name matches the glossary's "runtime value" in both places. No change.
- **`SourceOptions` / `ParamSourceOptions`** are symmetric with `secretSource()` / `paramSource()`. The secret side has no `configKey`, `sentinel` or `redacted`, because a secret is always runtime and always redacted. That asymmetry follows the concepts and is fine.
- **`SecretSourceUse` / `secretSourceManifest()`** sit beside `paramManifest()` and `inputManifest()` in core, target-neutral. The fit is good. Its discriminator gap is A02.
- **"Sentinel"** in `ParamSourceOptions.sentinel` names the mechanism (a stand-in string), not the concept. It matches the serializer's existing word for the same thing, so it is consistent inside the codebase. No change.
- **`SourceOrigin`** joins `InputOrigin` as a fourth `ValueOrigin` kind. This fits the existing typology.

## Test strategy at the architectural level

The property that matters most is that a service's binding still receives the same object. `source-load.test.ts` tests 8 to 11 assert identity (`toBe`), and the existing shared-module and example suites, which read those leaves, pass unchanged. That is the right evidence.

The second property is that preflight depends on every secret the graph names. Tests 29 to 31 and the two preflight tests cover the cases where no service receives the secret. No test covers the case where a service does receive a secret through a module's input, which is where the reported address depends on iteration order (code review F02).

## Out of scope for this pass

Adopter learnability of the new guide subsection, and whether the multi-key `resolve()` example should be in the guide at all, are documentation-reader concerns. Correctness, failure modes and AC verification are in [`code-review.md`](code-review.md).
