# Platform variables: project spec

A service reads some of its configuration from values the operator keeps on the platform. This project lets an app name those values in its graph, type them, and receive them at boot, while the deploy does not copy them from the developer's local environment, store them or need them.

Design: [design.md](design.md), which is authoritative and holds the detail behind every statement here. Plan: [plan.md](plan.md), which says which slice builds each part.

## The design

### An example

```ts
import { appRoot } from '@prisma/composer';
import { variable } from '@prisma/composer-prisma-cloud';
import { email } from '@prisma/example-email';
import { type } from 'arktype';

export default appRoot('shop', {}, ({ provision }) => {
  const from = provision(variable({ name: 'EMAIL_FROM' }));
  const deliveryCredential = provision(variable.secret({ name: 'EMAIL_DELIVERY_CREDENTIAL' }));
  const smtpPort = provision(variable({ name: 'SMTP_PORT', schema: type('number') }));

  provision(email(), { input: { from, deliveryCredential, smtpPort } });
});
```

What it shows, decision by decision:

- The root is written with `appRoot()`, not `module()` (D1).
- The root provisions three platform variable nodes. A nested module cannot: `provision(variable(…))` inside `module()` does not compile, and the error names `appRoot()` as the fix (D2).
- `provision()` returns the value itself, so the binding passes `from`, `deliveryCredential` and `smtpPort` straight into the email module's input (D4).
- `EMAIL_DELIVERY_CREDENTIAL` is a platform secret. The service receives it in a secret box, and Composer redacts its value wherever it prints (D5, D13).
- `SMTP_PORT` has `schema: type('number')`. The platform holds the text `587`; the service's `smtpPort` field, typed `number`, receives the number 587. The type travels to boot as JSON Schema inside the service's input document (D9, D10).
- Nothing in this file is a value. The deploy writes no variable, reads no value, and succeeds with `EMAIL_FROM` unset if the email module's schema makes `from` optional; it refuses to deploy if `from` is required and has no row (D11).
- Under `prisma dev` the same three names are read from the developer's `.env.dev` files and shell, decoded and validated the same way (D12).

### The decisions

Each decision is stated once. The design.md section holds the detail. "Satisfies" names the requirements in the next section.

**D1. The root is written with `appRoot()`.** `appRoot(name, { input? }, body)` in `@prisma/composer` takes what `module()` takes minus `deps` and `expose`, and returns an app root node. That node is its own type, not a `ModuleNode`: the two differ by an `isRoot()` method with literal return types, so `provision()` refuses an app root in every overload, directly or through a wrapper typed `ModuleNode`, and a root cannot be nested. An entry built with `module()` is still accepted as it is; its body simply has no overload for a platform variable. Design section 4, "Only the root provisions one". Satisfies R1, as the precondition for D2.

**D2. A platform variable is a resource node, and only the root provisions one; the compiler enforces it.** `@prisma/composer-prisma-cloud` exports `variable({ name, schema? })` for a plain platform variable and `variable.secret({ name })` for a platform secret. `appRoot()`'s body has one `provision()` overload that accepts such a node; `module()`'s body does not, so a `module()` body that tries, at the root or below it, fails to compile with an error that names `appRoot()` as the fix. Below the root, a module declares its need in its input and the app's author wires the value down. Design section 4. Satisfies R1.

**D3. The node provisions nothing and owns nothing on the platform.** Its descriptor writes no row and creates no Alchemy resource. The variable's row belongs to the operator, who sets it at whichever scope the platform offers; the node never says where the value lives. The variable's identity in Composer is its name, a recorded exception to the rule that a node's address is its identity, justified because Composer does not own the thing it names. Design section 4, "What the node is" and "The mental model". Satisfies R2.

**D4. `provision()` returns the value itself.** `provision(variable({ name }))` is `RuntimeValue<string> & { id: string }`; with `schema`, `RuntimeValue<T>` where `T` is the schema's output type; `provision(variable.secret({ name }))` is `RuntimeValue<SecretString> & { id: string }`. The constructor builds the value as a source, `provision()` stamps the node's address into it, and core learns one fact: a resource that provides no contract may be a value. The default provision id is the name in camel case (`EMAIL_FROM` becomes `emailFrom`); an explicit `id` wins. Design section 4, "How the value is built". Satisfies R1, R3.

**D5. A value goes into a `field()` for a plain variable, into a secret field for a secret, or, for a plain variable, into a service's per-key param, and nowhere else.** It may pass through a module's input on the way. A plain value in a per-key param writes a pointer row the service reads at boot. A plain value in a secret field, a secret in a `field()` or a per-key param, or a value in a `resolve()` dependency, a resource's props, the whole input or a plain field is refused: by the compiler where it can see the type, otherwise by Load, the graph check (D7) or the service's own schema. Two fields of one service may read one variable. Design section 4, "Where its value may go". Satisfies R1, R7.

**D6. A service reads a variable when its input document holds a marker for it.** The loaded graph records this reads relation as a list beside each service's binding, built from the addresses D4 stamped, at any depth. It is not a graph edge. The target groups it by variable for the deploy report and for errors. Design section 5. Satisfies R1.

**D7. One-node rules run in the constructor; cross-node rules run in a graph check after Load.** The constructor throws for a bad name or a bad `schema`. The graph check is a new core hook that an extension registers and that runs right after Load in every command that runs Load (`prisma deploy`, `prisma dev` and `destroy`); it enforces one declaration per name, one meaning per name and a value in a place it may not go. The array-position rule runs in the serializer, where array positions are known. Design section 5. Satisfies R1, R2.

**D8. A name is upper case, some names are reserved, and one name has one meaning.** A name matches `^[A-Z][A-Z0-9_]*$`; the platform itself accepts no key that is not upper case, so a row and a name can never differ by case. The constructor refuses `COMPOSER_…`, `DATABASE_URL`, `DATABASE_URL_POOLED`, `PORT`, `PATH` and `HOME`. Within one app a name is used in exactly one of three ways: a plain node, a secret node, or a root input field. Design section 6. Satisfies R2, R5.

**D9. `schema` is a Standard JSON Schema, and the type travels as data.** The constructor turns the author's schema (ArkType, Zod, or any library implementing Standard JSON Schema) into plain JSON Schema at construction and keeps it in the node's props; the library's schema never runs on a value. One decoding rule is fixed from the JSON Schema alone: a text-only schema gives the text, a never-text schema parses the text as JSON, a mixed schema is refused. A transforming schema and one the library cannot express are refused. Boot decodes, validates against the JSON Schema with a validator Composer ships, and only then hands the value to the service's schema. One implementation of the marker format, the decoding rule, the validator call and the error text serves boot, `prisma dev` and the local target. Design section 7. Satisfies R3, R4, R5.

**D10. The input document carries a `$platform` marker, and boot follows four steps.** `{ "$platform": { "name", "secret"?, "schema"? } }` stands for a platform variable's value; it replaces the `$secret` marker. At boot: a variable with no value leaves its key out and the service's schema decides whether that is allowed; a variable with text is decoded and validated; a secret is boxed; the service's schema validates the whole. An error names the variable and what was expected, never the text, a part of it, or a parser's or validator's message. An empty value cannot exist on the platform, so a variable is present with text or absent; `prisma dev` treats an empty value as unset, so both agree. Design section 8. Satisfies R3, R4, R7.

**D11. The deploy does not copy local values to platform variables, and refuses only a required variable with no row.** Preflight no longer seeds a missing variable from the app secrets or the app configuration. An implicit copy can push a local value into a remote environment by accident: `.env` is read for every environment, and copying on each deploy also writes one override row per preview branch. For now the operator sets each value with `prisma project env add`. This is not a rule that the deploy may never set a variable: an explicit way to set variables through `deploy`, where the operator says which values go to which environment, is expected later (deferred.md). For each variable it reads whether a row exists at any scope the platform offers (project class and branch today; one more list call when the platform adds a service scope) and when it last changed; it never reads a value. It decides "required" by resolving each service's binding with every unset variable left out and running the service's schema, the method ADR-0058 gives the dev preflight. A required variable with no row fails the deploy before anything is created, naming the variable, the reader and the command that sets it. An optional one is reported, after preflight and again in the deploy report, with `prisma project env add … --role production` or `--role preview`. A changed value redeploys exactly its readers, through the deployment triggers. This check is the only protection Composer gives against a missing value: the platform reports a process that exits at boot as running and promotes it, so the guide says so and names `prisma service logs <service>` as where the boot error is. Design sections 3 and 9. Satisfies R2, R6.

**D12. `prisma dev` plays the platform's part.** It fills a plain platform variable from the app configuration and a platform secret from the app secrets, under the variable's name; gives each local service only the variables its own rows and markers point at; decodes and validates before any service starts, with the shared implementation; applies the ADR-0058 missing-value rule; and restarts a service whose value changes. Design section 10. Satisfies R5.

**D13. A platform secret is a known secret.** Its value never enters Composer during a deploy. Under deploy and dev the value under its name in the app secrets or the app configuration is a known secret, read only to be redacted. Under dev it is handed to the second process in memory and never written to a file Composer owns. In the deploy report a marker shows its name and type only. Design section 11. Satisfies R7.

**D14. `envSecret()` and `envParam()` are removed.** An app gets a value from outside its code in exactly two ways. A value the deploy reads is a field of the app root's `input`, filled by the `config` adapters; it replaces `envParam()` in an input binding. A value the service reads at boot is a platform variable node provisioned in the app root; it replaces `envSecret()` everywhere and `envParam()` in a service's per-key params, where a plain node writes the same pointer row. Slice 2 changes the rules for both functions; slice 3 adds the node and removes them, with a migration guide in its release note. Core keeps no source that reads the app configuration. Apps and docs in Prisma's other repositories move in those repositories. Design section 12. Satisfies R1, R2.

**D15. Nothing waits for the platform, and every record is rewritten in the slice that changes the behaviour.** Everything ships against the Management API as it is; its behaviour was checked on 2026-11-06 and design section 3 states it as fact. Every decision record, glossary entry and principle the design reverses is rewritten in place, in full, as the current statement, in the pull request that changes the behaviour, with no supersession notes; no two slices rewrite one record at the same time. Design sections 3 and 14. Satisfies R6, R8.

## Terms

- **App root**: the outermost module, the one the entry default-exports and nothing provisions, written with `appRoot()`. Its address is the app's name. Also called the root, the root module or the root node.
- **A variable on the platform**, or **row**: one entry in a Prisma Cloud project's environment variables, an upper-case name and a non-empty encrypted text. The operator sets it; Composer's own rows are named `COMPOSER_…`.
- **Class**: the platform's two kinds of environment, `production` and `preview`. A row belongs to one class.
- **Scope**: the level at which a row is set and from which a reader resolves it. On Prisma Cloud there are two today, the project's class and one preview branch, and the most local wins; a service scope is expected later.
- **Platform variable**: a node in the app's graph that names a variable the operator sets. "Plain platform variable" means the non-secret kind, `variable()`.
- **Platform secret**: the same kind of node for a value handled as a secret, `variable.secret()`: boxed in the service and redacted wherever Composer prints.
- **Source** and **pointer**: a source is a value whose real value at deploy is itself a pointer, built by a target from a payload core never reads; `generatedParam()` is one. A platform variable's value is a source.
- **Runtime value** (`RuntimeValue<T>`): a value that exists only at boot and may be bound to a `field()` or a secret field, never listed in `resolve()`.
- **Input document**: the JSON object the deploy writes for a service, holding its bound input with pointers in place of values. The service reads it at boot through `service.input()`.
- **`$platform` marker**: the entry in an input document that stands for a platform variable's value: `{ "$platform": { "name": "EMAIL_FROM" } }`, with `secret: true` for a secret and `schema` for a typed one.
- **Secret field**: the input field that takes only a secret. Before module-input S18 ships it is `secretString()`; after, `secret(inner)`.
- **Plain field**: a schema member written without `field()` or a secret field. It takes data the deploy has, never a runtime value.
- **Preflight**: the step of `prisma deploy` that checks the environment before anything is created. Here it reads whether each variable has a row and decides which missing ones are required.
- **Graph check**: the hook an extension registers that runs right after Load, in every command that runs Load, to enforce rules that span more than one node.
- **Reads relation**: the recorded fact that a service's input document holds a marker for a variable. It is a list beside the service's binding, not a graph edge.
- **The app configuration** and **the app secrets**: the values the `configuration` and `secrets` adapters in `prisma.config.ts` return, read from `.env` files and the shell. The app configuration fills the root's input. Under `prisma dev` they also fill plain platform variables and platform secrets respectively.
- **Root input field**: a field of the app root's `input`, filled from the app configuration when the deploy or `prisma dev` runs. It is how an app gives itself a value the deploy reads.
- **Known secrets**: the values one command knows are secrets and redacts wherever it prints: the value under each platform secret's name in the app secrets or the app configuration.
- **Named secrets**: the subset of the app secrets that `prisma dev`'s first process hands its second process in memory: the values under the names the graph's platform secrets use.
- **Deploy report**: what `prisma deploy` prints at the end: what was created, and here, each platform variable with no value, its readers and the command that sets it.

## Requirements

R1 to R7 are the design's requirements, numbered as in design section 2. R8 is this project's process requirement.

- **R1. The graph shows every platform variable.** Without deploying, the loaded graph holds every platform variable node, the services that read each one and the type its schema declares. Satisfied by D1, D2, D4, D5, D6, D7, D14.
- **R2. The deploy needs no value.** A deploy creates no value and reads none. It fails for a missing value only when the service could not boot without it, found from the schema and never from the value. Satisfied by D3, D7, D8, D11, D14.
- **R3. The type travels as data.** A service field typed `number` can take a platform variable without the service's schema knowing the value arrives as text, and without the module's code being present at boot. Satisfied by D4, D9, D10.
- **R4. No value is guessed.** Composer decodes a variable's text only as the author declared, never by trying JSON first. Satisfied by D9, D10.
- **R5. The same app behaves the same locally.** `prisma dev` fills each platform variable from the developer's files and shell and checks it the same way boot does, with the same messages. Satisfied by D8, D9, D12.
- **R6. Nothing waits for the platform.** Everything ships against the Management API as it is today. Satisfied by D11, D15.
- **R7. A secret's text never appears in an error.** Not at deploy, not at boot, not under `prisma dev`, and not through a parser's or validator's message. Satisfied by D5, D10, D13.
- **R8. Every record matches the code.** Every decision record, glossary entry, domain doc and principle the design reverses is rewritten in place as the current statement in the pull request that changes the behaviour. Satisfied by D15.

## Out of scope

- **Platform changes.** The project adds nothing to the Management API: no record of which service reads which variable, no void value, no service scope, no workspace variables. Reason: R6; each is recorded in [deferred.md](deferred.md).
- **Isolating a service's environment on Prisma Cloud.** Every deployment keeps receiving every project variable of its class. Reason: it needs the platform record above.
- **Carried secrets.** A root `secret()` field whose value the deploy reads from the app secrets and sets on a service belongs to the module-input project (S18). Reason: a different mechanism, and this project does not depend on it.
- **`schema` on a platform secret.** Reason: a secret box whose content is not text is undefined in both designs; `secret(inner)` already checks a secret's text at boot.
- **Moving apps and docs in Prisma's other repositories off `envSecret()` and `envParam()`.** Six internal apps (the `prisma/streams` deploy apps, `prisma/asks`, `prisma/program`, `prisma/pdp-control-plane`) call them, and `prisma/skills` and `prisma/web` document them. Reason: they are other repositories; each moves when it upgrades Composer, following slice 3's migration guide ([deferred.md](deferred.md)).
- **Validating on the platform.** Reason: Will expects the platform never to validate values against a schema.
- **A graph edge or a topology entry for the reads relation.** Reason: nothing reads it as an edge yet, and the platform has no node kind for it.
- **Anything about a process that exits at boot on the platform.** The platform reports it running and promotes it. Reason: a known platform problem outside this project; the guide states it and names `prisma service logs <service>`.

## States between slices

Each slice merges to `main` on its own. This is what is true after each.

- **After slice 1.** `appRoot()` exists and every root in this repository and its guidance uses it. An entry built with `module()` still deploys, exactly as before. A root with `deps` or `expose`, or a root passed to `provision()`, fails to compile. Nothing about platform variables has changed: `envSecret()` and `envParam()` work as before, including preflight seeding a missing variable.
- **After slice 2.** The deploy does not copy local values to platform variables. Every operator variable that exists on `main`, which means every `envSecret()` and `envParam()`, follows the new rules: upper-case names, reserved names, one meaning per name, the `$platform` marker, the four boot steps, required-or-reported in preflight, existence at every scope the platform offers, triggers on `updatedAt`, and the `prisma dev` rules. `envParam()` in a binding is deprecated. The node does not exist yet, so `envSecret()` is the only way to name a platform secret and there is no plain platform variable. Every value is text.
- **After slice 3.** `variable()` and `variable.secret()` exist, only an `appRoot()` body can provision them, `provision()` returns the value, the graph records the reads relation, and the examples and guides use the nodes and root input fields. `envSecret()` and `envParam()` are removed. `schema` does not exist; every value is text.
- **After slice 4.** `schema` exists on `variable()`, with the decoding rule and the validator.
- **At every point before module-input S18 ships,** a platform secret binds to a `secretString()` field. After it ships, to `secret(inner)`. This project does not depend on S18.

At no point do two rule sets for one platform row coexist on `main`: slice 2 changes the rules for every operator variable at once, and slice 3 replaces the shortcuts with the node under the same rules.

## Done when

Each condition names the requirement it proves.

- An app whose root is `appRoot()` and that uses `variable()`, `variable.secret()` and `schema` deploys to Prisma Cloud with one optional variable unset; the deploy report lists that variable with its readers and the command that sets it. R1, R2.
- The same app with a required variable unset is refused by preflight, naming the variable and the field, before anything is created. Setting it with `prisma project env add` and deploying again starts the service with the value decoded and validated. R2, R3.
- Changing a value on the platform and deploying again creates new deployments for exactly the services that read it. R2.
- A fresh preview branch of that app deploys with its values from a preview-wide row created with `--role preview`. R2, R6.
- A nested module that calls `provision(variable(…))` fails to compile with an error that names `appRoot()`, and so does a `module()` root's body. An entry that is still a `module()` deploys as before. R1.
- The same app runs under `prisma dev` with its values in `.env.dev`, and a value that fails its `schema` stops `prisma dev` with the message boot would give. R5.
- A variable with `schema: type('number')` whose text is `abc` on the platform: the deploy succeeds, and `prisma service logs <service>` shows a boot error naming the variable and the expected form. A variable with no `schema` whose text is `587` gives the text `587`. R3, R4.
- A platform secret node deploys with nothing written to the platform. R2.
- A planted secret decoded under a number schema produces an error, at boot and under `prisma dev`, that holds no part of the secret; the deploy output, the report and the stack file hold no part of it either. R7.
- The examples and guides use the nodes and root input fields, and `@prisma/composer-prisma-cloud` no longer exports `envSecret()` or `envParam()`. R1.
- ADR-0064 exists and records the platform facts of design section 3, and ADR-0003, 0014, 0029, 0032, 0042, 0058, 0062, 0063, the glossary, the domain map, the goals and the address principle match the code, each as one current record. R8.

## Decided during the slices

These are engineering choices the design leaves open. The implementer decides them inside the slice and records the choice where stated.

- **The JSON Schema validator and whether it checks `format`.** Slice 4's spike decides, by running the candidate against the schemas ArkType and Zod emit for the guide's types, and records the choice and every message the validator can produce in ADR-0064.
- **The name and location of the shared package** that holds the marker format, the decoding rule, the validator call and the error text (D9). Slice 2 decides; it must ship in the service runtime and depend on neither Node nor Bun.
- **Exact error wording,** within the rules: every error names the variable and every address involved, and never holds a secret's text.

**When a slice stops and comes back to Will:** when a design statement cannot be built as written, or when building it would reverse a recorded decision the design does not list in section 14. The slice records what it found and its recommendation, and waits.

## Alternatives considered

The project-level ones. Design section 15 has the full list with reasons.

- **A platform variable as a property of an input field,** `field(type('number'), { env: 'SMTP_PORT' })`. Rejected by Will: a platform input is part of the topology, so it is a node.
- **A platform variable node anywhere in the tree.** Rejected: a name is one space per project, so a nested module naming one claims it for every app and hides the need from the module's input.
- **Root-only enforced by a Load check alone,** with `module()` as the root. Rejected by Will: the rule is structural, so the type system carries it; `appRoot()` makes the misuse fail to compile.
- **A source with no node,** as `envSecret()` was, or a new node kind. Rejected: a source leaves nothing for the graph to list; a new kind changes core's node union and the platform's topology kinds for the same result.
- **`provision()` returning `{ id, value }`.** Rejected in favour of the value itself with `id` on it, matching `generatedParam()` and `serviceOrigin()`.
- **Keep seeding on deploy.** Rejected: an implicit copy is how a local value reaches a remote environment by accident. An explicit way to set variables through `deploy` is expected later (deferred.md).
- **Decode by trying JSON first, or a fixed vocabulary of types.** Rejected by Will: Composer must not guess, and a standard carries the type in a form any library can produce.
- **Keep `envSecret()` and `envParam()` as deprecated spellings, or remove only `envSecret()`.** Rejected by Will: one mechanism for each kind of value, and no leftover function. Keeping either keeps a second way to name one thing and the code that supports it; slice 3's spec gives the detail.
- **Wait for the platform to record who reads what, or to add a service scope.** Not needed: every part ships against today's API, and either change would alter preflight's list calls and nothing an author writes.

## References

- Design discussion with Will, 2026-11-05 and 2026-11-06, recorded in [design.md](design.md). Reviews and decisions: `wip/pv-review/`, in particular `decisions-round-2.md`, `decisions-round-3.md` and `platform-checks.md`.
- [ADR-0029](../../../docs/design/90-decisions/ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md), [ADR-0032](../../../docs/design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md), [ADR-0042](../../../docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md), [ADR-0058](../../../docs/design/90-decisions/ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md), [ADR-0062](../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md), [ADR-0063](../../../docs/design/90-decisions/ADR-0063-a-node-depends-on-an-interface-or-exposes-one.md).
- Module input: [../module-input/design.md](../module-input/design.md), which defines runtime values, pointers, `field()` and the secret field.
- [Standard JSON Schema](https://standardschema.dev/json-schema).
