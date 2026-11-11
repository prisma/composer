# Platform variables: plan

Spec: [spec.md](spec.md), which numbers the requirements (R1 to R8) and the decisions (D1 to D15) this plan refers to. Design: [design.md](design.md), authoritative for every behaviour; each slice cites its sections for detail, but each slice's opening stands on its own.

## Status

Slices 1 and 2 are merged. Slice 3 is specified.

## Order

```text
1. The root is written with appRoot()
2. The deploy stops copying local values
3. A platform variable is a node
4. A platform variable has a schema
```

Four slices, because the root constructor, the rule change for every existing variable, the new node and the schema are each one afternoon's review with their own release note, and shipping the rule change before the node keeps one rule set per platform row at every point on `main`.

Each slice is one pull request, merged before the next starts. Slice 1 stands alone because it moves every root in the repository and its guidance; keeping that move out of the platform-variable slices keeps their reviews about platform variables. It is additive, not breaking. Slice 2 changes the rules for every operator variable that exists on `main` today, which means every `envSecret()` and `envParam()`: no seeding, upper-case names, the `$platform` marker, required-or-reported in preflight. Slice 3 adds the node under those same rules and removes the shortcuts. After slice 2 there is one rule set and the shortcuts follow it; after slice 3 the nodes follow the same one, so no platform row ever follows two rule sets on `main`. Slice 4 adds `schema` last, because it is the only part that needs a validator, and it starts after slice 3 has merged so that no two slices rewrite one decision record at the same time. No slice depends on module-input S18.

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

## 2. The deploy stops copying local values

**Starts from:** slice 1 merged.

**After this slice merges:** `prisma deploy` does not copy local values to the platform, and creates no platform variable. Preflight reads only whether each variable an app names has a row, at the two scopes the platform offers (the environment's project class and its branch), and when it last changed. A variable with no row that a service needs, decided from the service's schema and never from a value, fails the deploy before anything is created, naming the variable, the service and field that read it, and the `prisma project env add` command that sets it. A variable with no row that nothing needs is listed after the preflight step and again in the deploy report, and the deploy succeeds. A changed value redeploys exactly the services that read it. An `envSecret()` or `envParam()` name must be upper case and must not be `COMPOSER_…`, `DATABASE_URL`, `DATABASE_URL_POOLED`, `PORT`, `PATH` or `HOME`; one name has one meaning in an app. A service's input document carries `{ "$platform": { "name": "X", "secret": true } }` where it carried `{ "$secret": "X" }`. At boot a variable with no value leaves its key out and the service's schema decides; an empty value is unset; a boot error names the variable and never its text. `prisma dev` gives a service only the variables its markers and rows point at, applies the same missing-value rule, and stops before any service starts when a required one is unset. `envParam()` in a binding is deprecated. There is no node yet: `envSecret()` is the only way to name a platform secret, and every value is text.

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

**The decision.** An app declares each platform variable it reads as a node in its root: `provision(variable({ name }))` for a plain one, `provision(variable.secret({ name }))` for a secret. `provision()` returns the value itself, so the root passes it down through module inputs like any other value. Only the app root can provision one, and the compiler enforces it. Core learns one new concept for this, a value resource: a resource node that is also a value. Everything slice 2 does for an `envSecret()` applies to the nodes. `envSecret()` and `envParam()` are removed: a value the deploy reads is a field of the app root's `input`, and a value the service reads at boot is a node.

**After this slice merges:**

- `variable()` and `variable.secret()` exist in `@prisma/composer-prisma-cloud`. A plain value fits a `field()` field or a service's per-key param; a secret fits a secret field and arrives boxed.
- `provision(variable(…))` in a `module()` body, at the root or below it, does not compile, and the error names `appRoot()`.
- The loaded graph lists every platform variable node and, for each service, the variables it reads.
- Right after Load, the target's graph check refuses: two nodes for one name; a node and a root input field with one name; and a node value as a service's whole input.
- Deploy, preflight and boot treat a node's variable as slice 2 treats an `envSecret()`'s. The node creates nothing, is not sent in the application topology, and has no line in the deploy report.
- `prisma dev` fills a plain platform variable from the app configuration, in an input field or a per-key param, and refuses a value that is not text before any service starts.
- `@prisma/composer-prisma-cloud` no longer exports `envSecret()`, `envParam()` or `secretName()`. Core's `paramSource()` takes no `configurationKey`, and Load reads nothing from the app configuration except the root's input. The release note is a migration guide with a before and after for each use.
- The `email`, `auth` and `storefront-auth` examples use the nodes; `env-param` becomes `root-input`, an example of a root input field. The guides, the skill and the records teach the two ways to get a value.
- Apps and docs in Prisma's other repositories move off the removed functions in those repositories, not in this slice.
- `schema` does not exist yet; every value is text.

**Satisfies:** R1; R2, R5 and R7 for the nodes; R8 for the records it rewrites.

**Design:** D2 to D7, D8 (the node's constructor), D12 (plain platform variables under dev), D14 (the shortcuts removed), D15. Design sections 4, 5, 6, 10, 12 and 14.

**Checked on Prisma Cloud:** an app with a plain node, a secret node and a module that receives both through its input, deployed with the secret unset and required (preflight refuses), then set (the service boots with the value); a plain node in a per-key param; a fresh preview branch of that app; a nested module and a `module()` root's body failing to compile with `appRoot()` in the error; the same app under `prisma dev`; the planted-secret search with a secret node.

**Spec:** [slices/3-a-platform-variable-is-a-node/spec.md](slices/3-a-platform-variable-is-a-node/spec.md), which holds every type, rule, message, file, record and test, and the alternatives considered.

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
- **The rule change and the node in one slice.** Rejected: one pull request holding two core changes, a new node, the serializer, boot, preflight, the shortcuts, per-key params, a shared package, `prisma dev`, the examples, seven decision records and a dozen glossary entries cannot be reviewed in one sitting, and its release note mixes "your existing deploy changes" with "here is a new API". Splitting keeps the one-rule-set constraint, because slice 2 changes every operator variable at once and slice 3 replaces the shortcuts with the node under the same rules.
- **The node first, the rule change after.** Rejected: between the two, nodes would follow the new rules and `envSecret()` the old, which is the two-rule-set window the design forbids.
- **`schema` before the rule change.** Rejected: `schema` needs the marker and the shared decoding package that slice 2 creates.
- **`schema` inside the node slice.** Rejected: it adds a validator choice and a spike to a slice that already carries the node and the records, and it would have two slices rewrite ADR-0042 and ADR-0064 at once.
