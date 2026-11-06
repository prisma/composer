# Platform variables: the design

This is the whole design of the platform variables project. It is the authoritative statement of it. It describes how the system behaves, not how the code is arranged. [plan.md](plan.md) says which slice builds each part.

The design was settled with Will on 2026-11-05, inside the module-input project, and split out into its own project on 2026-11-06. Three reviews of the first draft (a fact check, a system design review and a code review, in `wip/pv-review/`) were applied on 2026-11-06, and Will settled the root construct and the API the same day (`wip/pv-review/decisions-round-2.md`), and the root's type and the plan's shape on a third round (`wip/pv-review/decisions-round-3.md`). The six platform behaviours the design depends on were checked against Prisma Cloud on 2026-11-06 ([platform-checks.md](platform-checks.md)); section 3 states the results as facts. The module-input design ([../module-input/design.md](../module-input/design.md), sections 4, 5 and 9) holds the original discussion. This file supersedes it for everything about platform variables.

## 1. What it is for

A service reads some of its configuration only at boot, from values the operator keeps on the platform: an email sender address, a delivery credential, a port. Composer should not carry those values, store them, or need them to deploy. It should name them, check that the service's input can take them, and let the platform deliver them.

Two terms, used throughout:

- **A variable on the platform** is a row in a Prisma Cloud project: a name and a text. Composer writes some rows itself, all named `COMPOSER_…`; the operator sets the others, in the Console, with `prisma project env add`, or through the Management API.
- **A platform variable** is a node in the app's graph that names a variable the operator sets. A **platform secret** is the same node for a value that must be handled as a secret: boxed in the service and redacted wherever Composer prints. Where this document means the general kind, it says "a platform variable node" or "both kinds"; where it means the non-secret kind alone, it says "a plain platform variable".

Only the root provisions a platform variable node, and the root is written with `appRoot()` (section 4). The root passes the value down through a module's input, like any other value.

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

`email()` is the repo's email example module. Its input declares `from` as a wrapped field, `deliveryCredential` as a secret field and `smtpPort` as a wrapped field typed `number`. `provision(variable(…))` returns the value itself, so the binding uses it directly.

- `EMAIL_FROM` is text. The email service's `from` field receives the text at boot.
- `EMAIL_DELIVERY_CREDENTIAL` is a secret. The service receives it in a secret box.
- `SMTP_PORT` holds the text `587` on the platform. `schema` says the text is a number, so the service's `smtpPort` field, typed `number`, receives `587`.

The deploy never reads, writes or needs any of these values. A missing value fails the deploy only when a field that must have a value reads it; otherwise the deploy lists the variable as not set and succeeds. The values are set on the platform.

The two shortcuts become spellings of the same thing. `envSecret('NAME')` is a platform secret written inline, with the meaning of `variable.secret({ name: 'NAME' })` provisioned in the root, and follows every rule in this document. `envParam('NAME')` in an input binding is a deploy-time value from the app configuration, not a platform variable, and is deprecated with `envSecret()`; a root input field replaces it. Section 12 has the detail.

## 2. Requirements

1. **The graph shows every platform variable.** Without deploying, the loaded graph holds every platform variable node, and for each one the services that read its value and the type its schema declares. This is the inspectability principle applied to variables.
2. **The deploy needs no value.** A deploy creates no value on the platform and never reads one. It fails for a missing value only when the service could not boot without it, and it finds that out from the schema, never from the value.
3. **The type travels as data.** A service field typed `number` can take a platform variable, without the service's schema knowing the value arrives as text. A platform value exists only at boot, inside the service's process, where the module's code is absent, so the conversion must be data, not code.
4. **No value is guessed.** Composer decodes a variable's text only as the author declared, never by trying JSON first.
5. **The same app behaves the same locally.** `prisma dev` fills each platform variable from the developer's own files and shell, and checks it the same way boot does, with the same messages.
6. **Nothing waits for the platform.** Everything here ships against the Management API as it is today (section 3).
7. **A secret's text never appears in an error.** Not at deploy, not at boot, not under `prisma dev`, and not through a parser's or a validator's message.

## 3. What the platform does today

This section states what Prisma Cloud does, as checked on 2026-11-06 against the Management API (SDK 1.80.0) and the `prisma` CLI (8.0.0-rc.26); the record, with raw output, is [platform-checks.md](platform-checks.md). The project needs no platform change: every part ships against today's API.

### Rows

An environment variable on Prisma Cloud is a row in a project, created with `POST /v1/environment-variables`:

| Field | Meaning |
| --- | --- |
| `projectId` | the project it belongs to |
| `class` | `production` or `preview` |
| `branchId` | absent for the class's shared value; set for one preview branch's override |
| `key` | the variable's name, matching `[A-Z_][A-Z0-9_]*` |
| `value` | text of at least one character, stored encrypted, never returned by a read |

A deployment receives the project's rows for its class, with its branch's overrides on top. So a name is resolved for each reader at two scopes today, project class and branch, and the most local wins. There is no service scope: no endpoint sets or lists a row on a service, and the list filter accepts only `projectId`, `class`, `key` and `branchId`. Will expects the platform to add a service scope later; section 4 says what that changes, which is preflight's list calls and nothing else. The platform copies the resolved rows into the deployment when it creates it and never reads them again, so a value set later reaches a service only at its next deployment. A read returns a row's metadata, including `updatedAt`, never its value. A deployment read (`GET /v1/deployments/{id}`) returns `envVars`, the names present on that deployment with values redacted, which shows what a deployment received without reading its logs. A row also carries `isManagedBySystem`, which marks a row the platform owns; a fresh project has no rows in either class, so no name carries it from the start.

Two facts about keys and values decide rules elsewhere in this design:

- **A key is upper case or it does not exist.** The platform refuses any key that does not match `[A-Z_][A-Z0-9_]*`, on write and in the list filter. A lower-case or mixed-case key cannot be a row, so a row's key and a name can never differ by case. Composer's own rule (section 6) is stricter only in refusing a leading underscore.
- **A value is never empty.** The platform refuses an empty value. So empty text can never arrive from the platform, and a variable is either present with text or absent.

The CLI sets rows at each scope: `prisma project env add KEY=VALUE --project <id> --role production` creates the production row; `--role preview` creates the preview-class row with no branch, shared by every preview branch; `--branch <git-name>` creates one branch's override. `update`, `list` (metadata only) and `delete` are scoped the same way.

Composer already uses all of this. Preflight lists rows by `projectId`, `class` and `key`, walks every page, and takes the newest `updatedAt` among the rows the environment sees. The compute target writes its own rows, all named `COMPOSER_<address>_…`, through Alchemy's `Prisma.EnvironmentVariable`. Each compute deployment is created with `start: true` and `promote: true`, and the deploy waits until the platform reports it running or failed.

Every environment-variable endpoint is marked experimental in the Management API SDK. Requirement 6 rests on them as they are; a change there is a change to preflight, not to the design.

### A process that exits at boot

The platform does not notice. The deployment reports `running`, the deploy's wait returns at once, `prisma deploy` succeeds, and the crashing deployment is promoted; the other services in the same deploy are promoted normally. The platform does not restart the process; each request to the service's URL boots it once and gets a 502. The boot error appears only in the logs: `prisma service logs <service> --project <id>`, or `GET /v1/deployments/{id}/logs?from_start=true`. This is a known platform problem and is outside this project. Its one consequence here: preflight's required-variable check (section 9) is the only protection Composer gives against a missing value, so the guide says in one sentence that a service that fails at boot is still promoted, and names `prisma service logs <service>` as where the error is.

### What does not exist, and what that costs

- **A record of which variables a service reads.** There is no API for a service to say which variables it reads. Every deployment receives every row of its class, so every service sees every variable in the project, its own and other services' included. That is already true today; nothing in this project makes it worse. Composer records which service reads which variable in its own graph and in each service's input document. If the platform later takes such a record, the target sends it and the platform can stop delivering the rest. No author-facing change is needed then.
- **A void value.** A row's value is non-empty text. The platform cannot tell "deliberately set to nothing" from "never set". So Composer sees two states: no row, and a row with text. An optional field whose variable has no row still works, because boot leaves the key out and the schema accepts that. The cost is in the deploy report: it lists that variable as not set even when its absence is intended.
- **A service scope.** Composer's model does not depend on one: the node says nothing about scope, the platform resolves each reader at whatever scopes it offers, and preflight is the only part of Composer that knows which scopes exist. When the platform adds a service scope, preflight's existence check gains one list call per reader ([deferred.md](deferred.md)); nothing else changes.
- **Workspace variables and rules.** Variables live in a project, with a shared value per class and per-branch overrides. There are no workspace-wide variables and no rules beyond that. Composer creates no values, so it does not care where the platform keeps them, as long as the deployment receives them.

The platform also has no idea which variables are secret: every value is encrypted and write-only. Whether a variable is a secret matters only inside Composer and inside the service. That needs nothing from the platform.

### What earlier drafts said wrongly

The module-input design said the first step on Prisma Cloud was to "stop stripping a service's environment at boot", and that the platform isolates each service's environment. Neither is true. On Prisma Cloud, `run()` adds Composer's rows to the process environment and removes nothing, and the platform gives every deployment every row of its class. Only the local target gives a service just the variables its rows point at. So that step does not exist, and the plan has no slice for it. The module-input design's three passages that said otherwise were corrected on 2026-11-06.

## 4. A platform variable is a node

### The mental model

A platform variable node is a named request for a value that something outside the app provides. It has three parts:

- **The name.** The handle the operator uses to supply the value. It is the contract between the app's author and whoever runs the app, and Composer passes it through unchanged: it never renames an operator's variable. Composer's own `COMPOSER_…` rows are a different thing, owned by Composer and named from an address, that happen to lower to the same platform primitive.
- **The readers.** The services whose input holds the value. They are derived from the graph (section 5), never declared.
- **The schema.** What the text under the name must be, and how each reader decodes it (section 7).

The node says nothing about where the value lives. That is the operator's decision, made in the platform's own terms. On Prisma Cloud a name is resolved for each reader at two scopes today, project class and branch, and the most local wins; a service scope is expected later (section 3). Each reader receives the value the platform resolves for that reader under that name, at whatever scopes the platform offers. The topology does not express scope, and preflight (section 9) is the only part of Composer that knows which scopes exist, so a new scope changes preflight's list calls and nothing else. Once a service scope exists, one node can give two readers two different values, when the operator chose to; the deploy report shows every name with its readers so the operator can see what each one resolves from.

**The name is the variable's identity in Composer.** For nodes Composer owns, the address is the identity, and it becomes the `logicalId` on the node's platform row (ADR-0051). A platform variable node has no row of its own, because Composer does not own the thing it names: the operator does, under the name. So here the name plays the role the address plays elsewhere. This is a deliberate exception to the principle that a node's address is its identity, and it is justified by ownership: Composer identifies what it owns by address, and refers to what it does not own by the handle its owner uses. Section 14 records the exception.

### The constructors

`@prisma/composer-prisma-cloud` exports one constructor with two forms:

```ts
variable({ name: string, schema?: StandardJSONSchemaV1 })
variable.secret({ name: string })
```

Both return a resource node. `variable()` is plain by default and `variable.secret()` marks a secret, as `field()` and `secret()` do in a schema. `schema` exists only on the plain form (section 7). A secret's value is always text; a `secret(inner)` field checks its content at boot, when the service unboxes it.

**Why the secret form exists although the platform stores every value alike.** The platform encrypts every row and returns no value, so secrecy is not a platform fact. It is a Composer and service fact, in three places: the binding, where a secret goes only into a `secret()` field and arrives boxed, and a plain value only into a `field()` field, as text or decoded; redaction, where a secret's value is a known secret that Composer blanks wherever it prints, which a plain `587` must not be; and boot errors, where a plain value's expected form may be described freely while a secret's error is held to the strictest rule. A plain variable bound to a `secret()` field, or a secret bound to a `field()` field, fails to compile at the binding.

### Only the root provisions one, and the compiler enforces it

The platform's name space is project-wide. A module closure can guarantee that a name is unique only inside itself, so a third-party module that named a variable could collide with the app's or with another module's, and the app's author could not fix it. The root's address is the app's name, and the app is the project, so the root is the only closure whose uniqueness scope matches the platform's. Below the root, a module declares its need in its input, and the app's author wires the value down.

The mechanism is a root constructor in `@prisma/composer`: `appRoot(name, { input? }, body)`, taking what `module()` takes minus `deps` and `expose`. Its body's `provision` has one extra overload, which accepts a platform variable node; `module()`'s does not, so `provision(variable(…))` in a nested module fails to compile. `appRoot()` returns an app root node, which is its own type and not a `ModuleNode`: the two differ by one method, `isRoot()`, which answers `false` on a module node and `true` on an app root node with literal return types, so neither is assignable to the other. `provision()` therefore refuses an app root in every overload, and so does a wrapper whose parameter is typed `ModuleNode`: a root cannot be nested, and the refusal does not depend on the call site. Load, lowering and the CLI's entry accept a `ModuleNode` or an app root node, and Load keeps a run-time check for a root that reaches `provision()` through a cast. This follows Will's rule that what type-checks deploys. An entry built with `module()` is accepted as it is, with no warning and nothing to remove later: a `module()` root threatens nothing, because its body has no `provision()` overload for a platform variable, and the rule that matters is that `appRoot()` never appears below the root. The guides and examples teach `appRoot()`, and every root in this repository moves to it in slice 1, so that there is one way to teach; slice 1 is additive, not breaking. In slice 3 the compile error for `provision(variable(…))` in a `module()` body, at the root or below it, names `appRoot()` as the fix. Will settled both points, the silent acceptance and the distinct type, on 2026-11-06 (`wip/pv-review/decisions-round-3.md`).

The root's existing special rules move onto `appRoot()` where the types can carry them: a root has no `deps` and no `expose`, and a root cannot be nested, are compile-time in slice 1, which ships `appRoot()` alone; slice 3 adds the overload for platform variables. The rule that a root's fields are plain or secret, never `field()`, stays a Load check, because it needs the schema's output type to carry no pointer, which the libraries do not expose reliably. The carried-secret rule for a root's `secret()` fields is module-input S18's and does not change here.

This reverses the glossary's statement that "there is no separate root construct"; section 14 records it, and slice 1 rewrites the entry.

### What the node is

- **The node provisions nothing and owns nothing on the platform.** It names a variable. Its descriptor writes no row, creates no Alchemy resource, and is not written to the platform's application topology. The variable's row is the operator's, and Composer never writes on it: not a value, not a `logicalId`, nothing. The node is the app's reference to something managed elsewhere, as a Terraform data source is.
- **The variable's identity is its name; the node's identity is its address.** `name` is a property of the node. The node's address is the path of provision ids from the root, as for every node.
- **One declaration per name.** Inside the root, two `variable()` calls with one `name` fail Load, naming both ids; so do a plain and a secret with one name. This cannot be structural, because the two calls are two lines in the root's body, but a collision is always between two lines the app's author wrote and can fix. The same node object provisioned twice is two declarations of one name, and fails the same way.
- **`provision()` returns the value itself.** Provisioning the node returns a runtime value with `id` on it, not a wrapper: `const from = provision(variable({ name: 'EMAIL_FROM' }))` gives a `RuntimeValue<string> & { id: string }`, which a binding uses directly. The precedent is `generatedParam()` and `serviceOrigin()`, which each return one object that is both source and value. The pointer names the variable: a plain pointer for `variable()`, a secret pointer for `variable.secret()`.
- **Its default id comes from its name.** A provision id may hold only ASCII letters and digits, and a variable's name usually holds underscores. So the default id is the name in camel case: split on `_`, drop empty parts, lower-case each part, capitalise every part after the first. `EMAIL_FROM` becomes `emailFrom`, `PORT` becomes `port`, `EMAIL_2FA` becomes `email2fa`. When two names give one id in the root, such as `EMAIL_FROM` and `EMAIL__FROM`, Load fails with the duplicate-id error and says to pass `id`. An explicit `id` always wins. In the graph the node's `name` field holds the id, `emailFrom`; its props hold the variable's name, `EMAIL_FROM`.
- **Renaming the variable.** With a default id, changing `name` changes the node's address, which makes a different node. That is harmless, because the node has no lifecycle and nothing on the platform refers to it. With an explicit `id`, changing `name` is a change to the node's props and the address stays.

### How the value is built

Core already has the one abstraction this needs: a **source**, a value whose real value at deploy is itself, a pointer, built by a target from a payload core never reads. `envSecret()` is one. A platform variable node builds its value the same way:

- **The constructor builds the source.** `variable()` and `variable.secret()` each build one source at construction, with the target's own payload: the variable's name, whether it is a secret, and the JSON Schema (section 7). A secret's source carries the name as its secrets key, so Composer knows what to redact and what `prisma dev` hands its second process, exactly as `envSecret()`'s does. The node holds this source.
- **`provision()` stamps the address.** `provision(node)` returns a copy of the node's source whose pointer data also holds the provisioned node's address. The address is ordinary data in the pointer, not a symbol-keyed origin, so it survives the copy a schema library may make of a pointer. This is what lets Load say which service reads which node after the value has passed through a module's input.
- **Core learns one fact.** A resource node may be a value: the target built it as a source, and `appRoot()`'s `provision()` returns that source with the address stamped in and `id` set on it. Core's Load never calls the target for this. This is allowed only on a resource that provides no contract, because `provision(resource)` returns a contract's fields on the returned object, and a value's members would collide with them. A second resource that needs both is a later design.
- **Types.** `provision(variable({ name }))` is `RuntimeValue<string> & { id: string }`. `provision(variable({ name, schema }))` is `RuntimeValue<T> & { id: string }`, where `T` is the schema's output type. `provision(variable.secret({ name }))` is `RuntimeValue<SecretString> & { id: string }`. Everything the module-input design says about runtime values applies: a value can be bound to a wrapped field or a secret field, passed through a module's input, and never listed in `resolve()`.

Section 14 records that this is a third origin of a runtime value beside the table in ADR-0062, and that ADR-0062's Values section is rewritten for it.

### Where its value may go

- **A service's input binding:** a wrapped field (`field()`) for a plain platform variable, a secret field for a platform secret. Before module-input S18 ships, the secret field is `secretString()`; after it, `secret(inner)`. The deploy check and the compiler refuse the other combinations, as module-input already does for every pointer.
- **A module's input binding,** into a wrapped field or a secret field, from which the module passes it on.
- **Two fields of one service may read one variable.** Each gets its own marker, and both read the same text at boot. The deploy's check that a service's markers name distinct variables keeps applying to `$generated` markers, which each own a variable, and stops applying to `$platform` markers.
- **Nowhere else.** A `resolve()` dependency, a resource's props, a service's per-key params, the whole input of a service, and a plain field (a schema member written without `field()` or a secret field) all need data the deploy has. The compiler refuses each where it can see the type. Where it cannot, Load refuses a `resolve()` dependency, and the target's graph check (section 5) refuses the others, naming the variable and the place.

### What the target does with the node

The node's descriptor has no provisioning step. Everything the target does for a platform variable happens elsewhere:

- **The graph check** (section 5) enforces the rules across nodes.
- **The serializer** writes a `$platform` marker into the input document of each service that reads the value (section 8).
- **Preflight** reads whether the variable has a row in the environment's scope, and when it last changed (section 9). It never writes one.
- **The deploy hook** adds the variable's `updatedAt` to the service's deployment triggers, so a changed value ships a new deployment at the next deploy. This is what pointed variables do today.
- **The local target** fills the variable from the developer's values (section 10).

## 5. Who reads a variable, and where the rules are checked

### The reads relation

A service **reads** a platform variable when its input document holds a marker for that variable's value. This is a relationship between two nodes that ADR-0063 does not have: a service neither depends on an interface of the node nor exposes one to it. The loaded graph records it as a list beside the service's binding, built from the addresses stamped in the pointers Load finds in each service's resolved binding, at any depth. It is not a graph edge: core's edges are dependencies, and the platform's application topology has no edge family for it. A new edge kind is recorded in [deferred.md](deferred.md).

The target groups the list by variable for the deploy report and for errors: for each variable, the services that read it, and the field in each.

### Where the rules run

Core's Load knows nothing about the node's payload, so the rules that read the payload run in the Prisma Cloud target, in two places:

- **The constructor** checks everything that depends on one node alone: the name's form and the reserved names (section 6), and the `schema` (section 7). It throws, so Load fails with the constructor's message and no hook is needed.
- **The target's graph check** checks everything that depends on more than one node, and anything that needs the resolved bindings. It is one hook that an extension registers and that runs right after Load, in every command that runs Load: `prisma deploy`, `prisma dev` and `destroy`. A command that loads the entry only to read the app's name never runs Load, so the check does not run there. So a bad graph fails before preflight, before any dev service starts, and without a deploy. This hook is new; slice 2 adds it to core. Today's similar checks run only at serialize or in preflight, which means at deploy.

The graph check enforces: one declaration per name inside the root, one meaning per name (section 6), a value in a place it may not go (section 4), the array-position rule (section 8), and `envSecret()` below the root (section 12). Root-only for the nodes needs no check, because the compiler enforces it (section 4). Each error names the variable and every address involved.

## 6. Names

### The form of a name

A platform variable's name must match `^[A-Z][A-Z0-9_]*$`: it starts with an upper-case ASCII letter and continues with upper-case letters, digits and underscores. The constructor refuses anything else, naming the node and the rule.

Upper case only, because the platform accepts no other key (section 3), and because the two places a name is used do not agree about case: Composer compares pointer names without case, and a process environment on Linux compares them with case. With upper-case names a row and a name can never differ by case, so boot always finds the row preflight saw.

### Reserved names

The constructor refuses these names, saying why:

- **Any name starting with `COMPOSER_`.** Composer's own rows.
- **`DATABASE_URL` and `DATABASE_URL_POOLED`.** Prisma Cloud seeds and manages them, as `envSecret()` and `envParam()` already say; a service reads its database through its dependency on the database node.
- **`PORT`.** Boot sets it to the service's port.
- **`PATH` and `HOME`.** Under `prisma dev` the local target sets both from the developer's shell, so a value of either on the platform would never be seen locally, which breaks requirement 5.

`HOST` is allowed. Boot sets `HOST` only when the environment has none, so a `HOST` row on the platform reaches the service unchanged.

Preflight also refuses the deploy when a variable's row in the environment's scope is marked `isManagedBySystem`, naming the variable, because such a row is the platform's, whatever its name.

### One name, one meaning

Within one app, a name is used in exactly one of these ways, and the graph check refuses a second:

- a plain platform variable node;
- a platform secret node;
- `envSecret('NAME')`, written inline;
- `envParam('NAME')`, in a binding or in a service's per-key params;
- a field of the root's input, plain or secret, that the root's body passes on.

A name used two ways means two things: a value from the platform at boot, and a value from the app configuration at deploy, or one variable claimed by two declarations. Composer already refuses `envParam()` with `envSecret()`, and a root field with `envSecret()`. This rule covers every pair, with one error that names both uses. The same way used twice is fine where it is fine today: two `envParam('X')` in two bindings, or two `envSecret('X')`, read one variable. Two nodes for one name are never fine (section 4).

## 7. `schema`: the variable's type travels as data

A variable's text is text. `schema` says what that text means, as a schema from any library that implements [Standard JSON Schema](https://standardschema.dev/json-schema). The repo's ArkType 2.2.7 and Zod 4.4.3 both do. Such a schema object exposes `~standard.jsonSchema.input(options)` and `.output(options)`, which return plain JSON Schema, and keeps its TypeScript type.

- **For the compiler,** the provisioned value is `RuntimeValue<T>`, where `T` is the schema's output type. `provision(variable({ name: 'SMTP_PORT', schema: type('number') }))` is a `RuntimeValue<number>`, so `field(type('number'))` accepts it and `field(type('string'))` refuses it. Without `schema`, `T` is `string`.
- **At construction,** the constructor calls `jsonSchema.input({ target: 'draft-2020-12' })` and `jsonSchema.output({ target: 'draft-2020-12' })`, catches what either throws, compares the two, and keeps the input form in the node's props as plain JSON. The library's schema never runs on a value, because there is none. Keeping the JSON Schema in the props means a changed schema is a changed node, and that the deploy never needs the library.
- **At deploy,** the JSON Schema is written into the `$platform` marker of each service that reads the variable, with its annotation keywords removed: `title`, `description`, `examples`, `default` and `$comment`. Validation does not use them, and a library copies an author's `examples` into the JSON Schema, which would otherwise land in a platform row and in the deploy report.
- **At boot,** Composer decodes the text, validates the result against the JSON Schema, and only then hands it to the service's schema (section 8).

### The decoding rule

Boot decodes a variable's text by one rule, decided from the JSON Schema alone at construction, so that boot has nothing to decide:

- **Without `schema`, the value is the text itself.**
- **A text-only schema: the value is the text itself.** A JSON Schema is text-only when every value it accepts is a string. The constructor decides that from the schema's top level: `type` is `"string"`; or `const` is a string; or `enum` holds only strings; or the schema is an `anyOf` or `oneOf` whose every member is text-only; or it is an `allOf` with at least one text-only member. A top-level `$ref` into the same document's `$defs` is followed once. So ArkType's `'"smtp" | "ses"'`, which emits `enum`, and `'"x"'`, which emits `const`, are text-only, and Zod's `z.enum([...])`, which emits `type: "string"`, is too.
- **A never-text schema: the text is JSON.** A JSON Schema is never-text when no value it accepts is a string, decided the same way: `type` is one of `number`, `integer`, `boolean`, `object`, `array` or `null`, or a list without `string`; or `const` is not a string; or `enum` holds no string; or every member of an `anyOf` or `oneOf` is never-text; or an `allOf` has at least one never-text member. Boot parses the text as JSON. `587` is the number 587, `true` is a boolean, `{"host":"x"}` is an object.
- **A mixed schema is refused at construction.** A schema that accepts both strings and non-strings, such as ArkType's `'string | number'`, or one whose top level fits neither rule, such as an empty schema or a `not`, is refused, with an error naming the node and saying to declare either a text type or a JSON type. `'string | null'` and Zod's `.nullable()` emit `anyOf` of `string` and `null`, which is mixed: a row's text cannot be `null`, so declare `string` and make the field optional instead. Composer never guesses which form the text has.

A variable with `schema: type('number')` whose text is `abc` fails boot, because `abc` is not JSON. A variable with no `schema` whose text is `587` gives the text `587`. The decoder refuses a parsed JSON number that is an integer outside the safe range, whatever its spelling, because `JSON.parse` rounds such a number silently (`9007199254740993` and `9007199254740993.0` both parse to `9007199254740992`); the guide says to keep an identifier as text.

### What the constructor refuses

- **A transforming schema.** A schema whose input and output JSON Schemas differ changes its value, which is code, and no code runs on a platform value. ArkType's `string.numeric.parse` gives input `{"type":"string","pattern":…}` and output `{"type":"number"}`, so it is refused. The error names the node and says to declare the type the text holds, such as `type('number')`.
- **A schema the library cannot express as JSON Schema.** ArkType throws for a `.narrow()` predicate and for `string.url`; Zod's `.transform()` throws from `jsonSchema.output()` while `.input()` returns `{"type":"string"}`. The constructor calls both and reports the library's message, naming the node.
- **A mixed schema,** as above.

### What the constructor cannot see

Some schemas lose meaning on the way to JSON Schema without failing. Boot can enforce only what the JSON Schema says.

- **Zod drops a refinement.** `z.string().refine(…)` gives `{"type":"string"}`, with no error. Boot does not run the refinement.
- **Zod hides coercion.** `z.coerce.number()` gives `{"type":"number"}` for both input and output. Boot parses the text as JSON and checks it is a number; the coercion never runs. The result is the same for every text that is a JSON number.
- **`format`.** Zod's `z.email()` emits `format: "email"`. Draft 2020-12 treats `format` as an annotation unless the validator is told otherwise. Slice 4's spike decides whether Composer's validator checks `format`, and the guide states the choice.

The guide says so, and says to put a check that must hold into the service's own schema, which does run at boot.

### Reading the JSON Schema is not reading the library's schema

ADR-0042 says Composer never looks inside a schema, because a library's internal representation is private. This section reads the JSON Schema a library emits through a public standard, never the library's own schema. ADR-0064 states that exception, and the ADR-0042 rewrite cites it.

### The validator

Boot validates with a JSON Schema validator that Composer ships in the service runtime. It must support draft 2020-12, which both libraries emit, must not generate code with `new Function`, so that it works under any runtime policy, and must not depend on Node or Bun. `@cfworker/json-schema` meets the first two and is small; it is not in the repo yet. Slice 4 confirms the choice with a spike that runs it against the schemas ArkType and Zod emit for the types the guide shows, and records: whether `format` is checked or ignored, whether `$ref` and `$defs` resolve, and every message the validator can produce, so that section 8's rule about messages holds.

The platform is not expected to validate anything. Composer does.

### One implementation

Boot, `prisma dev`'s first process and the local target all decode and validate, and requirement 5 says they must agree, messages included. So there is one implementation of the marker format, the decoding rule, the validator call and the error text, in one package that all three import. It ships in the service runtime, so it follows the runtime-agnostic principle. The local target's copy of the marker constants goes.

## 8. The input document and boot

### The `$platform` marker

Each place in a service's input document that holds a platform variable's value holds a marker:

```json
{
  "from": { "$platform": { "name": "EMAIL_FROM" } },
  "deliveryCredential": { "$platform": { "name": "EMAIL_DELIVERY_CREDENTIAL", "secret": true } },
  "smtpPort": { "$platform": { "name": "SMTP_PORT", "schema": { "type": "number" } } }
}
```

- `name` is the variable. `secret` is present and `true` for a platform secret. `schema` is present when the node has one, as the JSON Schema with its annotations removed.
- The marker replaces today's `$secret` pointer, `{ "$secret": "NAME" }`, in slice 2, for `envSecret()`; slice 3's nodes write the same marker. The input document and the code that reads it at boot ship in the same deployment, from the same installed package, so changing the marker needs no compatibility reader.
- `$generated` pointers, for `generatedParam()` and `serviceOrigin()`, stay as they are. Those variables are Composer's own, not the operator's.
- A user key spelled like a marker gains one leading `$` when written and loses it when read, as today for `$secret` and `$generated`. The escape covers `$platform` too, so only Composer can place a marker.
- The deploy report shows a marker as `$platform NAME`, or `$platform NAME (number)` when it has a schema, never the full JSON Schema.

### Boot

At boot `service.input()` reads the input document and replaces each marker. There are four steps:

1. **The variable has no value** (`process.env[name]` is undefined): the marker's key is left out of its object. The service's schema decides whether that is allowed. If the schema then fails, the error also names each platform variable that had no value, so the operator knows what to set. A marker in an array position cannot be left out; such a variable with no value fails boot naming the variable, and preflight already treats it as required (section 9).
2. **The variable has text:** the text is decoded by the marker's rule (section 7), then validated against `schema` if there is one. A value that does not decode or does not fit fails boot. The error names the variable and what was expected: the JSON form (`true` or `false`, a number, an object), or the failing JSON Schema keyword and its location, such as `minimum at /`. It never includes the text, a part of the text, the parser's message or the validator's message. This rule is the same for a plain platform variable and for a secret, because a parser's message quotes the input and no redaction runs at boot on the platform.
3. **For a platform secret,** the result is put in a secret box.
4. The service's own schema then validates the whole object, as today.

### Empty text

An empty value cannot exist on the platform (section 3), so at boot a variable is present with text or absent. `prisma dev` keeps its rule that an empty value is unset, so both agree: empty means unset.

## 9. Deploy

- **The deploy writes no variable.** Preflight no longer creates a missing variable from the app secrets or the app configuration. That was seeding, and with rows per class and per branch, seeding as a side effect of `deploy` is how a developer's local test key reaches production. A variable is set on the platform.
- **Preflight reads existence, never a value.** For each platform variable the graph reads, preflight asks whether a row exists at any scope one of its readers resolves from, following the platform's own resolution: the environment's project class and the environment's branch, the two scopes the platform offers today (section 3). A row at either counts as existing, and preflight keeps the `updatedAt` of the row the platform resolves: the branch row when there is one, otherwise the class row. A change to the class row while a branch override exists does not change what the service receives, so it is not a trigger. The reads run in parallel, at most eight at a time; a failed list call still fails the deploy, because the triggers need `updatedAt`. Preflight does not list every row of the class, because in the preview class that returns every branch's `COMPOSER_` rows. When the platform adds a service scope, preflight gains one list call per reader, and nothing else in Composer changes.
- **A missing variable that a service needs fails the deploy.** A deployment is started and promoted as soon as it is created, and the platform reports a process that exits at boot as running (section 3), so a service that exits at boot is promoted while crashing and the deploy succeeds. Preflight prevents the case it can know about: for each service, it first runs the service's schema with no variable left out, and a failure there is an invalid input, reported as such and never blamed on a variable. Then it resolves the input binding with every variable that has no row left out and runs the schema again. If the schema passes, those variables are optional. If it fails, preflight checks each one alone and names as required the variables whose absence alone fails; when no single one fails alone, it says the service needs some of them. A marker in an array position is required without a check. This is the method ADR-0058 gives the dev preflight, and it never needs a value. The error lists each required variable, the service and field that read it, and the command that sets it.
- **A missing variable nothing needs is reported.** The deploy succeeds, and the variable is listed under "Platform variables with no value", with each service that reads it and the command that sets it.
- **The command.** For production: `prisma project env add 'NAME=<value>' --project '<id>' --role production`. For every other environment the report leads with the preview-wide form, `prisma project env add 'NAME=<value>' --project '<id>' --role preview`, so that the next preview branch is not broken too; the `--branch '<environment>'` form follows, for one branch only.
- **How the names reach the operator.** Preflight returns its findings to the CLI, which prints the "no value" list right after the preflight step, before anything is created, and the deploy report repeats it at the end. Today's preflight contract carries counts only; it gains the list of names, and its wording changes. A deploy that fails later still showed the list.
- **A changed value redeploys its readers.** Each service's deployment triggers include `<name>:updatedAt` for each platform variable it reads, as pointed variables do today, and `?` when the variable has no row. Changing a value on the platform and deploying again creates new deployments for exactly those services. Changing a value without deploying changes nothing running, because the platform copies rows into a deployment only when it creates it.

## 10. `prisma dev`

The local target has no platform, so it plays the platform's part.

- **It fills each platform variable from the developer's values:** a plain platform variable from the app configuration, a platform secret from the app secrets, each under the variable's `name`. These are the lists `prisma.config.ts` names, read once per converge in the first process.
- **A plain platform variable's value must be text.** An app configuration value under its name that is not text fails `prisma dev` before any service starts, naming the variable and the kind of value found, as `envParam()` does today. The app secrets are text already.
- **What reaches the second process.** The first process hands the second process each plain platform variable's text in the app configuration file, beside the configuration keys it already carries, and each platform secret's text in `PRISMA_COMPOSER_NAMED_SECRETS`, in memory, as `envSecret()`'s today. The check that refuses to write a known secret into the file applies unchanged. The second process gives the local target the two sets, never the whole app configuration or app secrets.
- **It isolates.** A local service receives only the variables its own rows point at: its param pointer rows and the `$platform` markers in its input document. The local target collects `$platform` markers at any depth, as it collects `$secret` markers today.
- **It validates before any service starts.** The first process decodes and validates each filled value against its marker's JSON Schema, by the rules in sections 7 and 8, with the one shared implementation. A value that fails stops `prisma dev` with the message boot would give.
- **A missing value follows ADR-0058.** The dev preflight leaves every unset platform variable out and validates the service's input. If the schema accepts it, the variables were optional. If it fails, the error lists the variables whose absence alone fails, where to set them (`.env.dev`, `.env.dev.local` or the shell), and the schema's message.
- **An empty value is unset,** as section 8 says.
- **A changed value restarts its readers.** The fingerprint trigger ADR-0058 describes covers platform variables too.

## 11. Secrets and redaction

- A platform secret's value never enters Composer during a deploy. It is a pointer in the input document, and the platform delivers it at boot.
- **Known secrets.** Under deploy and dev, the value under each platform secret's `name` in the app secrets or the app configuration is a known secret, and Composer redacts it wherever it prints. This is what `envSecret()` names do today. Composer never uses these values on deploy; it reads them only to redact them, because a developer's shell often holds the production value of a secret it deploys.
- **Under `prisma dev`,** a platform secret's value is read, handed to the second process in memory, and given to the local service. It is never written to a file Composer owns. The compute emulator's copy of a service's environment is the known limit ADR-0058 records.
- **At boot and under `prisma dev`,** an error about a platform variable names the variable and what was expected, never the text (section 8). A test plants a secret, decodes it under a number schema, and checks that the error holds no part of it.
- **In the deploy report,** a marker shows its name and type only, and a schema's annotations are removed before the marker is written.

## 12. The shortcuts

Both shortcuts stay as deprecated spellings and are removed in a later release.

- **`envSecret('NAME')` is a platform secret written inline.** It stays a source, not a node: Load creates no node from a value it finds in a binding, which would need a mechanism nobody has designed for a form that is going away. It writes the same `$platform` marker as `variable.secret()`, with `secret: true`, and follows every rule here: the name's form and the reserved names, one meaning per name, no seeding, the missing-variable rules, and the rule that empty means unset. The target lists each `envSecret()` beside the nodes, through the existing list of secret sources, so the deploy report and errors name both. `envSecret()` below the root fails the graph check with an error that says to provision `variable.secret({ name })` in the root and pass its value through the module's input; the compiler cannot refuse it while `envSecret()` is a source, because a source may be written in any binding. The only thing lost against the node is that the graph does not list it as a node.
- **`envParam('NAME')` in an input binding** is a deploy-time value from the app configuration, not a platform variable. It is deprecated, and a root input field replaces it.
- **`envParam('NAME')` in a service's per-key params,** the older form of input, also stops being filled by preflight. At boot an unset pointed param takes the param's default or is left out if the param is optional, as a marker does; today it fails boot regardless. The boot error for a required one names the variable and says to set it on the platform; today it says the deploy did not provision it, which stops being true.

## 13. What changes for existing apps

Slice 1 makes the first change. Slice 2 makes every change that touches an existing platform row at once, so that no two rules for one row ever coexist on `main`. Slice 3 makes the last two, which concern only the new node's spelling.

- **The root is written with `appRoot()`** (slice 1). Every app in this repository changes `module(` to `appRoot(` on its entry; a `deps` or `expose` on the root fails to compile. An entry that is still a `module()` deploys exactly as before. Nested modules do not change. Slice 1 breaks nothing.
- **The deploy no longer creates a variable** (slice 2, as is every change below unless marked). A project that relied on `deploy` copying `envSecret()` values from `.env` to the platform sets them on the platform instead. The release note gives the commands.
- **Every new preview branch needs a value.** Today's seeding writes a per-branch override for every non-production environment, so a project that used `envSecret()` on previews holds one override per branch and probably no preview-wide value. After slice 2, a new branch has no row. The release note's first step is a one-time one: create a preview-wide value for every name the project seeded, with `prisma project env add 'NAME=<value>' --project '<id>' --role preview`. Slice 2's QA covers a fresh preview branch.
- **The deploy fails for a missing variable only when a service needs it.** An optional one is reported. Today every missing name fails the deploy.
- **Names are upper case.** An `envSecret()` or `envParam()` name with a lower-case letter fails Load. No deployed project has one, because the platform refuses a key that is not upper case (section 3), so the release note has no step for it.
- **`PORT`, `PATH` and `HOME` are reserved.** An `envSecret()` or `envParam()` that names one fails Load.
- **`envSecret('NAME')` below the root fails Load** (slice 3), with the migration message in section 12.
- **An unset `envParam()` per-key param with a default or optional** boots instead of failing.
- **`envParam()` is deprecated** (slice 2), and **`envSecret()` is deprecated** (slice 3, once `variable.secret()` exists to replace it).

Nothing else changes for an app that uses neither shortcut.

## 14. What this design reverses, and which slice amends each record

This is the one list of recorded statements the design reverses. Every record is rewritten in place, in full, as the current statement, in the PR that changes the behaviour: no supersession note, no "amended by" line, no history paragraph. Each record reads as if written today.

### Slice 1: the root is written with `appRoot()`

The graph is still a composition of modules that are all the same, except the root, which is written with `appRoot()`, cannot be provisioned, and (from slice 3) alone may provision a platform variable. The model is less uniform than these records say, and each must say so plainly.

- **Glossary, Module ("The App is the outermost Module"):** "There is no separate root construct; 'App' names the outermost Module, it is not a distinct kind of node." Now the root is written with `appRoot()`, an app root node that cannot be nested; it is still the outermost module in every other respect. A `module()` root is still accepted. Slice 3 adds that it alone may provision a platform variable.
- **ADR-0014, one authoring primitive:** "There is exactly one authoring primitive: `module()`. … nothing in the source marks it as special. … There is no separate `app()` construct." Now `module()` is the primitive for every module below the root, and `appRoot()` builds the root, because a root-only `provision()` overload needs a root-only type. The ADR index line for ADR-0014 changes with it.
- **ADR-0003, the entry:** "nothing marks a root in the model beyond its kind." Now the entry's default export is an app root built with `appRoot()`, or a `module()` root, which is still accepted.
- **Glossary, `module` (the function entry):** "It is the single authoring primitive; the App is the outermost `module()`, picked out only by being the one you deploy." Now it defines every module below the root, and the root is built with `appRoot()`.
- **Glossary, Superseded terms, App:** "it names the outermost Module." Now also: built with `appRoot()`; see App root.
- **Glossary, every "implicit root Module" passage** (the two Aggregate Contract passages and the superseded-terms arrow). Now "app root".
- **Glossary, new entry App root:** the outermost module, the one the entry default-exports and nothing provisions, built with `appRoot()`. Also called the root, the root module or the root node; those terms stay where they are exact and point at this entry.

### Slice 2: the deploy fills nothing

- **Glossary, The app secrets, Secrets key, Named secrets, Known secrets:** each defines its set through `envSecret()` and says "Deploy preflight fills a missing `envSecret()` platform variable". Now the app secrets fill nothing on the platform, and each set is defined through the names the graph's secret sources use. Slice 3 redefines them through platform secrets.
- **Glossary, The app configuration:** "Deploy preflight also fills a missing platform variable" is gone. Under `prisma dev` the local target fills a plain platform variable from it (slice 3 adds that sentence).
- **Purpose, goals:** "Recreate the whole topology in a fresh environment … no manually-created prerequisites." Now a new environment needs its platform variables set first, and preflight names every one that a service needs before anything is created.
- **ADR-0029, secrets:** "Preflight fills a missing variable from the app secrets." Now preflight fills nothing. Slice 3 rewrites the record again for the secret concept.
- **ADR-0032, env-sourced params:** preflight fills a missing variable from the app configuration, and an unset pointed param "is a boot error". Now it fills nothing, and an unset pointed param takes its default or is left out when optional.
- **ADR-0042, service input:** the `$secret` marker; "Every variable a service's markers name must be distinct once normalised"; the three boot outcomes. Now the `$platform` marker, distinct names for `$generated` only, the four boot steps, the empty-text rule, and the array-position rule.
- **ADR-0058, dev secrets:** "Each service gets only the variables its own rows point at" is stated as a local-target rule, not a Prisma Cloud one; and the recorded difference between dev's and deploy's input documents for an unset optional secret closes, because both now leave the key out.
- **ADR-0062, values and config adapters:** "Deploy preflight and dev preflight fill a missing `envSecret()` platform variable". Now preflight fills nothing. Slice 3 rewrites the Values section.
- **ADR-0064, new, "A platform variable is a node":** created with the platform facts of section 3, the graph check hook, the preflight findings, and sections 8 to 12 as they apply to every operator variable. Slice 3 adds the node.

### Slice 3: a platform variable is a node

- **Glossary, Core nouns:** "Anything without a lifecycle — an API key, an external URL — is part of a node's Input, not a node." Now a node either has a lifecycle Composer manages, or refers to something the platform owns; Composer lists a referenced value and never creates it.
- **Glossary, Resource:** "A node whose lifecycle a provider manages." Now also a node that refers to a value the platform owns.
- **Architectural principles, "A node's address is its identity, everywhere," and ADR-0051:** a node's one identity is its address, written as the `logicalId` of its platform row. Now a platform variable node, which has no row and names something Composer does not own, is identified by the variable's name; the principle gains that one exception, with its reason.
- **Glossary, Topology:** "Every node in the topology has a managed lifecycle." Now every node either has one or refers to something the operator sets, and the second kind is listed by name when an environment is created.
- **Glossary, Input:** `envSecret()` "is the only thing the framework calls a secret", and "A value is a secret only when it is externally sourced and never in state — `envSecret`". Now a platform secret, spelled as a node or as `envSecret()`, and a carried secret (module-input S18) are secrets.
- **Glossary, Value and RuntimeValue:** the sources that give a runtime value are listed as `envSecret()`, `generatedParam()` and `serviceOrigin()`, and "every plain pointer is a `Pointer<string>`". Now a platform variable node gives one, and a plain pointer is typed by its schema.
- **Glossary, The app secrets, Secrets key, Named secrets, Known secrets:** Slice 2 defined each set through the names the graph's secret sources use. Now each is defined through platform secrets, of which `envSecret()` is one spelling.
- **Glossary, The app configuration:** gains that under `prisma dev` the local target fills a plain platform variable from it.
- **Domain map:** "Every node carries a managed lifecycle" and "Configuration is not a node. Keys, URLs, and secrets parameterise Services and Resources". Now a platform variable is a node that names a value the operator sets, and the rest of configuration is still input.
- **ADR-0029, secrets:** "There is exactly one secret concept" and `envSecret()` is "the source". Now a secret is any value handled as one, and a platform secret is the kind Composer never sees. Module-input S18 adds the carried secret to the same record when it ships.
- **ADR-0058, dev secrets:** the named secrets are defined through platform secrets.
- **ADR-0062, values and config adapters:** "secrets reach platform variables through secrets adapters"; the runtime-value table lists only sources. Now the Values section records a third origin of a runtime value, one a resource gives. The S18 rewrite of this record, for the root's secret field, builds on slice 3's.
- **ADR-0063, two relationships:** a node depends on an interface or exposes one. Now a service also reads a platform variable, a third relationship that is not an edge.
- **ADR-0064:** gains the node, sections 4 to 6, the core changes slice 3 makes (the `provision()` overload on `appRoot()`, a resource that is a value), and the alternatives in section 15.

### Slice 4: a platform variable has a schema

- **ADR-0064:** `schema`, the decoding rule, the refusals and the validator.
- **ADR-0042:** the `schema` member of the marker and the decode-then-validate step. The statement "Composer never looks inside the schema" gains the exception in section 7, stated in ADR-0064 and cited here.
- **Glossary:** the `schema` option on the platform variable entry.

No two slices rewrite one record at the same time: each slice starts after the one before it has merged. A record slice 2 rewrites may be rewritten again by slice 3, because they are sequential.

## 15. Alternatives considered

- **A platform variable as a property of an input field,** such as `field(type('number'), { env: 'SMTP_PORT' })`. Rejected by Will: a platform input is part of the topology, so it is a node, not a property of a field.
- **A new node kind, such as a "reference", instead of a resource.** More honest in the types, but it changes core's node union and the platform's topology kind list, which another team owns. A resource that provisions nothing, with the reversal recorded, costs less and says the same thing.
- **A source with no node,** as `envSecret()` is. It leaves nothing for Load to list as a node, no address, and no single place for `schema`.
- **"Resource outputs" as a new core concept, with Load asking the target for the pointer.** Rejected: core already has the source, which carries the secrets key redaction and `prisma dev` need; "output" already means Alchemy's attributes and the retired end of a connection; and Load calling a target would be core's first dependency on one.
- **A platform variable node anywhere in the tree.** Rejected: a variable's name is one space per project, so a nested module naming one claims it for every app and instance, and hides from the module's input what the module needs.
- **Root-only enforced by a Load check alone,** with `module()` as the root. Rejected by Will on 2026-11-06: the rule is structural, so the type system should carry it, and a Load check would let a library ship a module that compiles and fails every app that uses it. `appRoot()` makes the misuse fail to compile.
- **Two nodes for one name reconciled when their schemas agree.** This rule existed only because nodes could sit below the root. With root-only, two declarations of one name are two lines in one body, and refusing them is simpler than reconciling them.
- **The node declares its scope,** such as `variable({ name, scope: 'service' })`. Rejected: where a value lives is the operator's decision in the platform's terms, not the author's; the topology says who reads a name, not where its value is set. An author-declared per-reader variable is recorded in [deferred.md](deferred.md).
- **`provision()` returning `{ id, value }`.** Rejected in favour of the value itself with `id` on it, matching `generatedParam()` and `serviceOrigin()`, so a binding reads `{ from, smtpPort }`.
- **The deploy succeeds with every variable unset, and reports.** Rejected: a deployment is promoted as it is created, and the platform reports a crashing process as running (section 3), so a service that exits at boot is promoted while crashing. Preflight refuses the case the schema can show without a value.
- **Decode by trying JSON first.** Rejected by Will: Composer must not guess. A variable whose text happens to be valid JSON would change type without anyone declaring it.
- **Decode a mixed schema as text.** Rejected: `'string | number'` holding `587` would then be a different value from the one `type('number')` gives for the same row, chosen by Composer.
- **A fixed vocabulary of types,** such as `schema: 'number'`. Rejected by Will in favour of a standard: Standard JSON Schema carries the type in a form any library can produce and any validator can check.
- **`parse` as the option's name.** Rejected: in both libraries "parse" means running a transform, which is exactly what the option refuses, and the marker already says `schema`.
- **`schema` on a platform secret.** Deferred: a secret box whose content is not text is undefined in both this design and module-input's; `secret(inner)` already checks a secret's text at boot.
- **Run the module's schema at boot.** Impossible: the schema is code in the app's module, which is not in the service's bundle.
- **Let the platform validate.** Will expects the platform never to validate values against a schema. Composer validates at boot and in `prisma dev`.
- **Keep seeding on deploy, or add a seeding command.** Seeding on deploy is how a local value reaches production. A seeding command was shelved by Will on 2026-11-05.
- **Make `envSecret()` a node provisioned where it is written.** Rejected: Load would have to create a node from a value found in a binding, with an owner and an id nobody has defined, for a form the same slice deprecates.
- **"Subscription" as the word for a service reading a variable.** Rejected: it names a platform mechanism that does not exist, reads as "receives updates as they happen", which is false, and already means streaming in the principles.
- **Wait for the platform to record which service reads which variable.** Not needed: every part ships against today's API (section 3), and the platform's record would change nothing an author writes.
