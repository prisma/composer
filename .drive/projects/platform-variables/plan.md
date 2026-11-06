# Platform variables: plan

Spec: [spec.md](spec.md), which numbers the requirements (R1 to R8) and the decisions (D1 to D15) this plan refers to. Design: [design.md](design.md), authoritative for every behaviour; each slice cites its sections for detail, but each slice's opening stands on its own.

## Status

Written from scratch on 2026-11-06 against `main` after #419 plus this branch's `appRoot()` design, after Will's third round of decisions and the platform checks. Slice 1 is specified.

## Order

```text
1. The root is written with appRoot()
2. The deploy fills nothing
3. A platform variable is a node
4. A platform variable has a schema
```

Four slices, because the root constructor, the rule change for every existing variable, the new node and the schema are each one afternoon's review with their own release note, and shipping the rule change before the node keeps one rule set per platform row at every point on `main`.

Each slice is one pull request, merged before the next starts. Slice 1 stands alone because it moves every root in the repository and its guidance; keeping that move out of the platform-variable slices keeps their reviews about platform variables. It is additive, not breaking. Slice 2 changes the rules for every operator variable that exists on `main` today, which means every `envSecret()` and `envParam()`: no seeding, upper-case names, the `$platform` marker, required-or-reported in preflight. Slice 3 adds the node under those same rules. After slice 2 there is one rule set and the shortcuts follow it; after slice 3 the nodes follow the same one, so no platform row ever follows two rule sets on `main`. Slice 4 adds `schema` last, because it is the only part that needs a validator, and it starts after slice 3 has merged so that no two slices rewrite one decision record at the same time. No slice depends on module-input S18.

## 1. The root is written with `appRoot()`

**Starts from:** `main`.

**After this slice merges:** An app's entry can be written `appRoot('shop', { input? }, body)` instead of `module(…)`. `appRoot()` takes what `module()` takes minus `deps` and `expose`; an unknown key in its options object is a compile error. Its result is an app root node, a type of its own: passing it to `provision()` fails to compile in a `module()` body, in an `appRoot()` body, and through a wrapper typed `ModuleNode`. Every root in this repository, in the examples, the website, the fixtures, the guides and the decision records' code samples, is written with `appRoot()`, so there is one way to teach. An entry that is still a `module()` deploys and runs under `prisma dev` exactly as before. Nothing about platform variables, `envSecret()` or `envParam()` has changed.

**Satisfies:** the precondition for R1; R8 for the records it rewrites.

**Design:** D1 (design section 4, "Only the root provisions one"; section 14, slice 1).

**Builds:**

- `appRoot(name, { input? }, body)` in `@prisma/composer`, with its own body context type (`input`, `environment`, `provision`; no `deps`), returning an app root node whose `isRoot()` answers `true` where a module node's answers `false`. One internal builder shared with `module()`. Load, lowering and the CLI's entry accept either kind of node.
- Every root in this repository changes `module(` to `appRoot(`: the examples, `website/module.ts`, the CLI and integration fixtures, the entries tests write to disk, the guides, the agent skill, the repository README, the shared-module READMEs and every decision record's code sample.
- Records rewritten in place as current statements, with no supersession notes: ADR-0003, ADR-0014 (and its index line), ADR-0016, ADR-0044, ADR-0061; the glossary's Module entry, `module` function entry, superseded-terms App line and every "implicit root Module" passage; a new glossary entry, App root.
- The release note in the pull request: a root before and after, and the two changed error messages for an entry that is not a module.

**Checked on Prisma Cloud:** one repository example deployed after its root moves to `appRoot()`; the same example under `prisma dev`; the same example with its entry put back to `module()`, deploying as before.

**Spec:** [slices/1-the-root-is-written-with-approot/spec.md](slices/1-the-root-is-written-with-approot/spec.md).

## 2. The deploy fills nothing

**Starts from:** slice 1 merged.

**After this slice merges:** `prisma deploy` never creates a variable on the platform. Preflight reads only whether each variable an app names has a row, at the two scopes the platform offers (the environment's project class and its branch), and when it last changed. A variable with no row that a service needs, decided from the service's schema and never from a value, fails the deploy before anything is created, naming the variable, the service and field that read it, and the `prisma project env add` command that sets it. A variable with no row that nothing needs is listed after the preflight step and again in the deploy report, and the deploy succeeds. A changed value redeploys exactly the services that read it. An `envSecret()` or `envParam()` name must be upper case and must not be `COMPOSER_…`, `DATABASE_URL`, `DATABASE_URL_POOLED`, `PORT`, `PATH` or `HOME`; one name has one meaning in an app. A service's input document carries `{ "$platform": { "name": "X", "secret": true } }` where it carried `{ "$secret": "X" }`. At boot a variable with no value leaves its key out and the service's schema decides; an empty value is unset; a boot error names the variable and never its text. `prisma dev` gives a service only the variables its markers and rows point at, applies the same missing-value rule, and stops before any service starts when a required one is unset. `envParam()` in a binding is deprecated. There is no node yet: `envSecret()` is the only way to name a platform secret, and every value is text.

**Satisfies:** R2, R6, R7; R5 for everything that exists in this slice.

**Design:** D7 (the graph check hook), D8 (names), D10 (the marker and boot, without `schema`), D11 (deploy), D12 (`prisma dev`), D13 (known secrets), D14 (the shortcuts, except the part that names the node), D15. Design sections 3, 5, 6, 8 to 13.

**Builds:**

- Core: the graph check hook, which an extension registers and which runs right after Load in every command that runs Load (design section 5). The preflight contract carries the list of variables with no value and their readers, not counts only; the CLI prints it after the preflight step and the deploy report repeats it (design section 9).
- Names: one checker, reused by slice 3's constructor, that refuses a name not matching `^[A-Z][A-Z0-9_]*$` and the reserved names. `envSecret()` and `envParam()` call it at construction, so Load fails with its message. The graph check refuses one name used two ways across `envSecret()`, `envParam()` in a binding or in per-key params, and a root input field, with one error naming both uses (design section 6).
- The serializer: the `$platform` marker with `secret: true` for `envSecret()`; `$secret` goes; the key escape covers `$platform`; the distinct-name check applies to `$generated` markers only; the report shows a marker as `$platform NAME` (design section 8).
- Boot: the four steps of design section 8, with "decode" meaning "the value is the text" until slice 4; a marker in an array position fails boot when its variable has no value; an empty value is unset; an error names the variable and never holds the text. An unset `envParam()` per-key param takes its default or is left out when optional, and the error for a required one says to set the variable on the platform (design section 12).
- Preflight: fills nothing; reads existence at the project class and the branch, in parallel and at most eight at a time, and a failed list call fails the deploy; refuses a row marked `isManagedBySystem`; decides "required" by resolving each service's binding with every unset variable left out and running its schema, then each alone, as ADR-0058's dev preflight does; a marker in an array position is required without a check; reports the optional ones with `prisma project env add 'NAME=<value>' --project '<id>' --role production`, or for every other environment the `--role preview` form first and the `--branch` form after it; each service's deployment triggers carry `<name>:updatedAt`, or `?` for no row (design section 9).
- The shared package: one module, shipped in the service runtime and free of Node and Bun, holding the marker format, the decoding rule (text only for now) and the error text. Boot, `prisma dev`'s first process and the local target import it; the local target's copies of the marker constants go (design section 7, "One implementation").
- `prisma dev`: the local target collects `$platform` markers at any depth for isolation; fills each platform secret from the app secrets under its name and hands it to the second process in memory; the named secrets and known secrets stay the values under the names the graph's secret sources use, which is every marker's name and any secret a module's input names that no service reads; the missing-value rule of ADR-0058 leaves every unset variable out and validates, so dev's and deploy's input documents agree for an unset optional secret; an empty value is unset; a changed value restarts its readers (design section 10).
- `envParam()` in a binding is marked deprecated, with a message that a root input field replaces it.
- Records, each rewritten in place as the current statement: ADR-0064 written, holding the platform facts of design section 3 and the rules of sections 8 to 12 as they apply to every operator variable; ADR-0029 and ADR-0062 (preflight fills nothing); ADR-0032 (an unset pointed param takes its default); ADR-0042 (the `$platform` marker, distinct names for `$generated` only, the four boot steps, the array-position rule); ADR-0058 (isolation as a local-target rule, the closed dev-versus-deploy difference); the glossary's The app configuration, The app secrets, Secrets key, Named secrets and Known secrets (nothing fills a platform variable; the sets are defined through the names the graph's secret sources use); the purpose doc's goals (a new environment needs its variables set first, and preflight names them). Design section 14 lists the statements each one reverses.
- The guide: the deploy fills nothing; a required variable with no row refuses the deploy and an optional one is reported; the commands per scope; and one sentence that a service that fails at boot on the platform is still reported running and promoted, with `prisma service logs <service>` as where the error is.
- The release note, with a before and after for each: the one-time step first, creating a preview-wide value with `--role preview` for every name the project seeded; the deploy no longer creates a variable; the deploy fails for a missing variable only when a service needs it; `PORT`, `PATH` and `HOME` are reserved; a lower-case `envSecret()` or `envParam()` name, which only ever worked in `prisma dev`, must be renamed; a leading-underscore name, which the platform accepts, must be renamed too, after the row is created under the new name in every scope that has one; an unset `envParam()` per-key param with a default boots; `envParam()` in a binding is deprecated.

**Checked on Prisma Cloud:** an `envSecret()` a service requires, unset: preflight refuses, naming it, before anything is created. One nothing requires, unset: the deploy succeeds and the report lists it with the command. Set, then changed: only its readers redeploy. The platform's rows listed before and after a deploy, showing nothing written. A fresh preview branch deploying with a preview-wide row made with `--role preview`. A secret planted in a value, and the deploy output, the report, the stack file and a boot error searched for any part of it. Under `prisma dev`: a required secret unset stops dev before any service starts; a service receives only the variables its markers name.

**Spec:** [slices/2-the-deploy-fills-nothing/spec.md](slices/2-the-deploy-fills-nothing/spec.md).

## 3. A platform variable is a node

**Starts from:** slice 2 merged.

**After this slice merges:** An app's root provisions `variable({ name })` for a plain platform variable and `variable.secret({ name })` for a platform secret, both from `@prisma/composer-prisma-cloud`. `provision()` returns the value itself, with `id` on it, so the root passes it into a module's or a service's input binding: a plain one into a `field()`, a secret into a secret field. A `module()` body that calls `provision(variable(…))`, at the root or below it, does not compile, and the error names `appRoot()` as the fix. The loaded graph lists every platform variable node and, for each service, the variables it reads, without deploying. Two declarations of one name in the root fail Load naming both; so does a value in a `resolve()` dependency, a resource's props, per-key params, the whole input or a plain field. The deploy, preflight, boot and `prisma dev` treat a node's variable exactly as slice 2 treats an `envSecret()`'s, and `prisma dev` also fills a plain platform variable from the app configuration. The examples and guides use the nodes. `envSecret()` is deprecated in favour of `variable.secret()`, and below the root it fails Load with a message saying to provision the node in the root and pass the value down. `schema` does not exist yet; every value is text.

**Satisfies:** R1; R2, R5 and R7 for the nodes.

**Design:** D2, D3, D4, D5, D6, D7 (the node's rules), D8 (the node's constructor), D12 (plain platform variables under dev), D14 (`envSecret()` as a spelling of the node), D15. Design sections 4, 5, 6, 10, 12, 14.

**Builds:**

- Core: the one `provision()` overload on `appRoot()`'s body that accepts a platform variable node; `module()`'s body does not get it, and its compile error for a platform variable node names `appRoot()`. A resource node that provides no contract may be a value: the target builds the source at construction, and `provision()` returns it with the provisioned address stamped into the pointer's data and `id` set on it. The rule that a root's fields are plain or secret, never `field()`, stays a Load check (design section 4).
- The constructors: `variable({ name })` and `variable.secret({ name })`, each building its source at construction with the target's payload (the name, whether it is a secret), using slice 2's name checker, with a descriptor that provisions nothing and is not sent to the application topology. The default id is the name in camel case; an explicit `id` wins; two names giving one id fail Load with the duplicate-id error and say to pass `id`. Types: `RuntimeValue<string> & { id: string }` for plain, `RuntimeValue<SecretString> & { id: string }` for secret, bound to `secretString()` until module-input S18 ships; a plain value in a secret field or a secret in a `field()` fails to compile (design section 4).
- The graph check gains: one declaration per name inside the root, across both forms and for the same node object provisioned twice; the one-meaning rule extended to the two node kinds; a value in a place it may not go, naming the variable and the place; `envSecret()` below the root, with the migration message (design sections 4 to 6 and 12).
- The reads relation: the loaded graph records, beside each service's binding, the platform variables it reads, from the addresses stamped in the pointers Load finds at any depth; the target groups it by variable for the report and for errors, and lists each `envSecret()` beside the nodes through the existing list of secret sources (design section 5).
- The serializer, preflight and boot handle a node's marker through slice 2's code; nothing per row changes. The local target fills a plain platform variable from the app configuration under its name, refuses a value that is not text before any service starts, and hands plain values to the second process in the app configuration file beside the keys it already carries; the second process gives the local target the two sets, never the whole configuration or secrets (design section 10).
- `envSecret()` is marked deprecated, with a message naming `variable.secret()`.
- Examples `email`, `auth`, `storefront-auth` and `env-param` move to the nodes. The building-an-app and deploying guides and the agent skill show the nodes, the mental model (name, readers, schema; the operator chooses scope), and one line on why only the root provisions them.
- Records, each rewritten in place as the current statement: ADR-0064 gains the node (design sections 4 to 6, the core changes, and section 15's alternatives); ADR-0062's Values section (a third origin of a runtime value); ADR-0063 (a service also reads a platform variable, a third relationship that is not an edge); ADR-0029 (a secret is any value handled as one; a platform secret is the kind Composer never sees); ADR-0058 (the named secrets are defined through platform secrets); the glossary's new entries Platform variable and Platform secret, and its Module (App), Core nouns, Resource, Topology, Address and logical ID, Input, Value, RuntimeValue, The app configuration, The app secrets, Secrets key, Named secrets and Known secrets entries, now defined through platform secrets with `envSecret()` as one spelling; the domain map; the architectural principle "A node's address is its identity" and ADR-0051, which gain the name-as-identity exception. Some of these were rewritten in slice 2; rewriting them again is allowed because the slices are sequential.
- The release note: `envSecret('X')` becomes `variable.secret({ name: 'X' })` provisioned in the root, before and after; `envSecret()` below the root fails Load; `envSecret()` is deprecated.

**Checked on Prisma Cloud:** an app with a plain node, a secret node and a module that receives both through its input, deployed with the secret unset and required (preflight refuses) and then set (the service boots with the value). A fresh preview branch of that app. A nested module calling `provision(variable(…))` fails to compile naming `appRoot()`, and so does a `module()` root's body. The same app under `prisma dev` with its values in `.env.dev`. The planted-secret search repeated with a secret node.

**Spec:** to be written when slice 2 merges.

## 4. A platform variable has a schema

**Starts from:** slice 3 merged.

**After this slice merges:** `variable({ name, schema })` takes a schema from any library that implements Standard JSON Schema (the repo's ArkType and Zod do). `provision()` then returns `RuntimeValue<T>` where `T` is the schema's output type, so `field(type('number'))` accepts a `SMTP_PORT` declared `type('number')` and `field(type('string'))` refuses it. The constructor turns the schema into plain JSON Schema once, keeps it in the node's props, and refuses a schema that transforms its value, one the library cannot express as JSON Schema, and one that accepts both text and non-text. The marker carries the JSON Schema with its annotations removed. At boot and under `prisma dev`, a text-only schema gives the text, a never-text schema parses the text as JSON, and the result is validated against the JSON Schema with a validator Composer ships, before the service's own schema runs. A value that does not decode or fit fails boot naming the variable and the expected form or the failing keyword and location, never the text. The deploy report shows `$platform SMTP_PORT (number)`.

**Satisfies:** R3, R4; R5 and R7 for typed values.

**Design:** D9, D10 (the `schema` member and the decode-then-validate step). Design section 7, and section 8's step 2.

**Builds:**

- A spike that confirms the validator (`@cfworker/json-schema` is the expected choice) against the JSON Schemas ArkType and Zod emit for the types the guide shows, and records in ADR-0064: that it supports draft 2020-12, uses no `new Function`, and depends on neither Node nor Bun; whether `$ref` and `$defs` resolve; whether `format` is checked or ignored; and every message it can produce, so that no message can carry a value's text (design section 7, "The validator"). A candidate that fails the first three is replaced, not patched.
- `schema` on `variable()`, typed so the provisioned value is `RuntimeValue<T>` from the schema's output type; `variable.secret()` does not take it.
- The constructor calls `jsonSchema.input()` and `.output()` for draft 2020-12, catches what the library throws and reports it naming the node, refuses a transforming schema (input and output differ) and a mixed one, decides text-only or never-text from the top level following one `$ref` into `$defs`, removes `title`, `description`, `examples`, `default` and `$comment`, and keeps the result in the node's props.
- The serializer writes `schema` into the marker; the report shows `$platform NAME (type)`.
- The shared package gains the decoding rule, the refusal of a JSON number that is not a safe integer, and the validator call; boot and `prisma dev` use them, with errors that name the variable and the expected form or the failing keyword and location, never the text or a library's message.
- Records: ADR-0064 and ADR-0042 rewritten for `schema`; the glossary's platform variable entry gains it; the guide gains what Zod and ArkType lose on the way to JSON Schema, the `format` choice, and the advice to keep an identifier as text.

**Checked on Prisma Cloud:** a number, a boolean, an enum and an object variable received with their types; `type('number')` with the text `abc`, where the deploy succeeds and `prisma service logs <service>` shows the boot error; a planted secret decoded under a number schema, with the error searched for any part of it; the same under `prisma dev`.

**Spec:** to be written when slice 3 merges.

## Close-out

- [ ] Verify every condition in the spec's "Done when".
- [ ] Move what is long-lived from `design.md` into `docs/design/` (ADR-0064 and the domain docs).
- [ ] Remove references to `.drive/projects/platform-variables/` elsewhere in the repo.
- [ ] Delete `.drive/projects/platform-variables/`.

## Alternatives considered

- **One slice.** Rejected: the root constructor, the rule change for existing variables, the node and `schema` are four changes with four release notes, and no reviewer holds them in one sitting.
- **`appRoot()` inside the node slice.** Rejected: moving every root in the repository and its guidance doubles that slice's diff and makes its review about something other than platform variables.
- **The rule change and the node in one slice.** Rejected: one pull request holding two core changes, a new node, the serializer, boot, preflight, the shortcuts, per-key params, a shared package, `prisma dev`, the examples, seven decision records and a dozen glossary entries cannot be reviewed in one sitting, and its release note mixes "your existing deploy changes" with "here is a new API". Splitting keeps the one-rule-set constraint, because slice 2 changes every operator variable at once and slice 3 adds a spelling under the same rules.
- **The node first, the rule change after.** Rejected: between the two, nodes would follow the new rules and `envSecret()` the old, which is the two-rule-set window the design forbids.
- **`schema` before the rule change.** Rejected: `schema` needs the marker and the shared decoding package that slice 2 creates.
- **`schema` inside the node slice.** Rejected: it adds a validator choice and a spike to a slice that already carries the node and the records, and it would have two slices rewrite ADR-0042 and ADR-0064 at once.
