# Module input: the design

This is the whole design of the module input project, as settled with Will on 2026-10-29 and 2026-10-30. It is the authoritative statement of it. It describes how the system behaves, not how the code is arranged. Slices S2 to S5 build an earlier version of it; [plan.md](plan.md) says what is built and which slice builds each remaining change.

## 1. What it is for

A module takes its input the way a service does. It declares one schema, `input`, and whoever provisions it binds that input. The root module declares `input` too, and the deploy fills it from config adapters named in `prisma.config.ts`.

```ts
// a reusable module
import { field, secretString } from '@prisma/composer/arktype';

export default module('email',
  { input: type({ from: field(type('string')), deliveryCredential: secretString() }), expose: { send: emailSendContract } },
  ({ input, provision }) => {
    const service = provision(emailService(), {
      id: 'service',
      input: { from: input.from, deliveryCredential: input.deliveryCredential },
    });
    return { send: service.send };
  });

// the root
export default module('shop',
  { input: type({ EMAIL_FROM: 'string', 'SITE_HOSTNAME?': 'string' }) },
  ({ input, environment, provision }) => {
    provision(email(), {
      input: { from: input.EMAIL_FROM, deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') },
    });
    const host = resolve([input.SITE_HOSTNAME, environment.name], ([hostname, name]) =>
      hostname ?? `${name}.shop.com`);
  });
```

```ts
// prisma.config.ts
composer({ extensions: [prismaCloud(), nodeBuild()], state: prismaState(), config: [dotenv(), environmentVariables()] })
```

```sh
prisma deploy                         # the root's input from .env, .env.production and their .local files, then the shell
prisma deploy --environment staging   # the same files for staging, then the shell
prisma dev                            # the files for dev, then the shell
```

## 2. Requirements

The design must meet these four requirements. Sections 3 to 9 say how it does.

1. **A module receives the input it needs and no more.** Its body, and everything the body passes data to, should see only the fields its schema declares and the body names. Section 3 meets this by giving the body a dictionary of values, with nothing that stands for the whole input. Section 3's "Limits of the schema" says where a schema's own behaviour still lets more through.
2. **The graph's structure is the same whatever inputs Composer is given.** A module body must not be able to provision different nodes in different environments. Section 3 meets this by never giving the body an input's real data. This covers the data Composer hands the body. A body that reads `process.env`, a file or the clock is outside it: the no-globals principle forbids such reads, but Composer cannot prevent them. Section 8 says how a deploy notices when its two processes build different graphs.
3. **A secret's value never enters deploy state, a generated file, a log, the deploy report or an error message.** Sections 5, 8 and 9 say how. Section 9 names the one exception, under `prisma dev`.
4. **If it type-checks, it deploys correctly.** A body or binding that type-checks deploys what it says. This holds for a service's binding as well as a module's, because both are typed from the schema (section 3). An input field is always a truthy `Value` object, so code that branches on one is not a case the design handles. A value the environment supplies, such as a missing required variable, can still fail the deploy, with the schema's message, before anything is created. A field bound to a runtime value is checked by its inner schema only at boot (section 3).

## 3. A module's input

### Declaring and binding it

- `module(name, { input: schema, deps?, expose? }, body)`. The schema comes from any Standard Schema library (ArkType, Zod, …). Secret fields are typed `secretString()`.
- `provision(module, { input: { … } })` binds it. The binding is typed from the schema's input type. A module with an input schema must be bound; a module without one must not be.
- Each key of the binding takes a literal or a value (section 4). Every source is a value (section 5).

### The three forms a field's binding takes

- A **literal**: a plain `T`.
- A **deploy-time value**: a `Value<T>` whose `T` contains no pointer. Load computes its real value, a `T`, before anything is created.
- A **runtime value**: a `RuntimeValue<T>`, which is `Value<Pointer<T>>`. Its real value at deploy is a **pointer**, which names the platform variable that holds the data. At boot the service reads that variable's text.

A pointer has one of two kinds. A **secret pointer**, typed `Pointer<SecretString>`, comes from `envSecret()` and from a redacted `generatedParam()`. A **plain pointer**, typed `Pointer<string>`, comes from `serviceOrigin()` and from a plain `generatedParam()`. A pointer also records its kind in its data, so a check that runs without types can tell the two apart.

### Wrapped fields and plain fields

A module should not care which form its caller uses. So the idiomatic way to declare a leaf field is to wrap its schema in `field()`. A **wrapped field** is a field whose schema is `field(inner)`. It accepts a literal, a deploy-time value, or a runtime value with a plain pointer. A **plain field** is written without `field()`. It is the author's explicit request for deploy-time data: it accepts a literal or a deploy-time value only. A plain field is the only kind of field a `resolve()` can compute with.

```ts
// ArkType: import { field, secretString } from '@prisma/composer/arktype'
type({
  from: field(type('string')),
  baseUrl: field(type('string.url')),
  port: field(type('string.integer.parse')),
  deliveryCredential: secretString(),
  smtp: { user: field(type('string')), password: secretString() },
  host: type('string'),           // plain: a resolve() computes with it
})
// Zod: import { field, secretString } from '@prisma/composer/zod'
z.object({ from: field(z.string()), baseUrl: field(z.string().url()), deliveryCredential: secretString(), host: z.string() })
```

- **Types.** `field(inner)` accepts `In | Pointer<In>` and outputs `Out | Pointer<In>`, where `In` and `Out` are the inner schema's input and output types. The pointer is typed by `In` because it stands for the variable's text, before the inner schema runs. So `port` above accepts `Pointer<string>`, and the service receives a number. Every plain pointer is a `Pointer<string>`, so binding a runtime value to `field(type('number'))` fails to compile. Neither library infers the pointer's type parameter through a union, so `field()` casts its result to these types.
- **Checking.** `field(inner)` is a union that the schema library checks itself: a plain pointer, or a value the inner schema accepts. So the deploy check runs the author's whole schema, with pointers in place. For a field bound to a runtime value, the inner schema's check happens only at boot, when the service's schema sees the variable's text.
- **Leaves only.** `field()` wraps a leaf. An object field stays a plain object schema, and its leaves are wrapped, as `smtp`'s are above. Wrapping an object schema fails three ways. At boot the pointer becomes text, which an object schema refuses. In the body, `input.smtp.host` stops type-checking. And ArkType cannot build the union around an object schema that has a transform anywhere inside it. A root's fields stay plain too, because the configuration never holds a pointer (section 7).
- **Secrets.** `secretString()` accepts a secret box or a secret pointer, so a secret field needs no `field()`. `field()` accepts only plain pointers, and `secretString()` only secret ones. So an `envSecret()` bound to a wrapped text field fails the deploy check, and so does a `serviceOrigin()` bound to a `secretString()` field.
- **Error messages.** When the value is not a pointer, a wrapped field reports the error the plain field would. A missing required field and a value of the wrong type keep the inner schema's message, and no message names a Composer class. For Zod, the union's error function reports the inner schema's issue. For ArkType, the pointer branch carries a description a user understands, such as "a value known only at boot". Tests compare each wrapped field's messages with the plain field's.
- **ArkType.** The pointer branch checks that the value is an object before it checks for a pointer. Otherwise a union with a transforming inner schema throws when the schema is defined. A default goes outside the wrapper, `field(type('string')).default('x')`, because `type('string').default('x')` is not a type that can be wrapped.
- **Entry points.** `@prisma/composer/arktype` and `@prisma/composer/zod` each export `field()` and `secretString()`. For any other Standard Schema library, `@prisma/composer` exports the `Pointer` type and a check for each kind, `isPlainPointer()` and `isSecretPointer()`, beside `isSecretString()`. With these an author can write the same two helpers.
- The guide, the agent skill and the examples wrap every leaf field of a reusable module's schema, unless a `resolve()` needs the field.

### What the body receives

`input` is a **dictionary**. Reading a field returns a **value**, typed from the schema's output: `input.from` is `Value<string | Pointer<string>>`, `input.smtp.user` is `Value<string | Pointer<string>>`, `input.host` is `Value<string>`, and an optional field is `Value<T | undefined>`. Reading the same field twice returns the same value.

`input` itself is not a value. It cannot be bound to a child, put in a service's input, or listed in `resolve()`. Passing it where a value is accepted fails to compile: the dictionary carries a brand that every binding type refuses. A cast gets past the compiler, so Load refuses it too, with an error that says the whole `input` of the module was passed on, and to pass its fields by name.

The body can do two things with a field's value:
- pass it on, into a child module's or a service's `input`, a service param, or a resource's props;
- list it as a `resolve()` dependency, to compute with its real value (section 6). Only a plain field's value can be listed.

### What the body cannot do

Turning `input` or a field into text or a number, serializing it with `JSON.stringify`, listing its keys, spreading it, iterating it, using `in` on it, or assigning to it throws at Load. The error names the field and says to declare it plain and list it in `resolve()`. `console.log` prints a label such as `[input.from of module "shop.email"]`, never data.

Reading a path through a field that is not a plain object, such as `input.from.trim` or `input.tags[0]`, fails at Load, naming the path.

Some misuse cannot be caught, because JavaScript calls no hook for it: a truthiness check (`if (input.enabled)`, `!`, `&&`, `??`), `===` and `typeof`. These see an object, so `if (input.enabled)` always takes the branch, in every environment. They still cannot make the graph differ by environment. `===` against a literal and a `switch` fail to compile.

### A service's binding

A service's `input` binding is typed from the service's schema, as a module's is, with the same mapping. So a wrong literal, an `envSecret()` in a plain or wrapped text field, or a `serviceOrigin()` in a plain field fails to compile. This is what makes requirement 4 hold for services. It also makes a module and a service look the same to whoever provisions them, as the module boundary decision asks.

- In a binding type, `SecretString` and `Pointer` are leaves: the mapping never looks inside them. A `secretString()` field takes a secret runtime value, or a module's secret field passed on. It never takes a literal: a `SecretBox` written in a binding fails to compile. A pointer is never written as a literal either.
- A service's schema uses `field()` the same way a module's does. A field bound to `generatedParam()` or `serviceOrigin()` must be wrapped, or be a `secretString()` field for a redacted `generatedParam()`.
- `service.input()` returns the schema's output with every pointer removed, at any depth, because at boot every pointer has been replaced by the variable's text. So a wrapped `from` is `string` in service code, and a `secretString()` field is `SecretString`. Testing helpers that build a service's input use the same type.
- The deploy check still tells the two pointer kinds apart, as "Secrets" above says. It catches the bindings the compiler cannot see: a schema without type information, or a cast.

### When the input is checked, and what a field's real value is

During Load's second pass, from the root down, each module's binding is resolved, assembled into one object, and checked by the module's whole schema. A field bound to a runtime value holds its pointer, which a wrapped field or a `secretString()` field accepts and a plain field refuses. If the check fails, the deploy stops before anything is created. The check runs synchronously; an async schema fails the Load. The deploy checks each service's binding the same way, with pointers in place, before it writes the service's input document.

A field's real value is read at its path from **the schema's output**, not from the raw binding. So a field typed `number` by `string.integer.parse` receives `4`, not `'4'`, and defaults apply. A child then checks the value again with its own schema.

A pointer passes through a schema, but the schema may return a copy of it. ArkType copies an object's input when a transform runs in the object or when it deletes undeclared keys. The copy keeps the pointer's brand and the variable it names, but it is a different object. So Load, preflight and the serializer recognise a pointer by its brand and the variable it names, never by object identity. A pointer holds no private class fields, because a copy would lose them.

An optional field the binding leaves out has no real value. In a child's binding, its key is left out, and the child's schema decides whether that is allowed.

### Limits of the schema

Composer cannot see which keys a Standard Schema declares: the standard exposes only `validate`. So:

- An input field the body never uses is not an error.
- An **object-typed field** carries its whole subtree after validation. If the schema declares `smtp: { host: 'string' }` and the binding's `smtp` also holds `password`, ArkType's default keeps `password` in its output, and a `resolve()` that lists `input.smtp` receives it. Zod drops undeclared keys by default; ArkType does with `'+': 'delete'`. The guide recommends that a module's schema drop them. An ArkType service schema with a `secretString()` field must not, for the reason in the next item.
- **An ArkType service schema that copies its input loses its secrets.** ArkType copies an object's input when a transform runs in it or when it deletes undeclared keys. A secret box in the copy loses its value, so at boot the service cannot read the secret. At deploy the service's schema sees pointers, not boxes, so the deploy checks for this separately. For each service with a field bound to a secret pointer, it runs the service's schema a second time, with a stand-in box in place of each secret pointer. The stand-in holds a known text that is not a secret. If a box in the output no longer gives back that text, the deploy refuses the service, with an error naming the field and saying that the schema copies its input. Section 11 defers a secret box that survives the copy.
- **A union schema.** For a discriminated union, the body's types offer only the keys every member has. With the union below, `input.stripeEnabled` type-checks and `input.stripeSecretKey` does not, because the `false` member lacks it. The body cannot narrow with an `if`, and it cannot pass the whole input on. So a module cannot declare a union input and still pass every field to its service. It declares a flat schema instead, for example with an optional `stripeSecretKey`, and passes each field by name.

  ```ts
  z.discriminatedUnion('stripeEnabled', [
    z.object({ stripeEnabled: z.literal(false) }),
    z.object({ stripeEnabled: z.literal(true), stripeSecretKey: secretString() }),
  ]);
  ```

## 4. Values

A **value** is an opaque stand-in, in a module body, for data known later. Its **real value** is the data. Load computes every real value in its second pass, after every module body has run, with `provision` disabled.

| | Plain | Secret |
| --- | --- | --- |
| **Deploy-time:** the deploy has the real value | a literal; a `resolve()` result; a configuration value | none yet (section 11) |
| **Runtime:** only the platform has it; the service reads it at boot | `generatedParam()`, `serviceOrigin()` | `envSecret('NAME')`, a redacted `generatedParam()` |

A **configuration value** is a value whose real value is read from the configuration (section 8): a field of the root's input, or `envParam('NAME')` in a binding.

A runtime value's real value at deploy is a pointer (section 3). The service reads the variable the pointer names at boot, as today.

## 5. Sources are values

`envParam()`, `envSecret()`, `generatedParam()` and `serviceOrigin()` each return one object that is both the target's source and a value. The serializer, preflight and boot receive the same objects as before, so the format the deploy writes does not change.

- **`envParam('NAME')`** in a binding is a deploy-time configuration value. Its real value is `NAME` in the configuration. In a service's input, the deploy writes that text into the input document, as today. An unset or empty `NAME` gives no real value: in a binding the key is left out; listed in `resolve()`, the Load fails naming the variable. Once a root can declare `input`, `envParam()` is redundant, and a later step deprecates it.
- **`envParam('NAME')` in a service's per-key params**, the older form of input, behaves as today. It is not a value there. The deploy writes a pointer row, deploy preflight fills a missing platform variable from the configuration (section 8), and the service reads the variable at boot.
- **`envSecret('NAME')`** is a runtime secret. Its real value is a secret pointer. Preflight fills a missing platform variable from the secrets (section 8).
- **`generatedParam()`** and **`serviceOrigin()`** are runtime values the framework itself produces. Their real value at deploy is a pointer: a secret pointer for a redacted `generatedParam()`, and a plain pointer otherwise. A field bound to one must be a wrapped field, or a `secretString()` field for a redacted `generatedParam()`.

## 6. `resolve()` over input

`resolve(dependencies, fn)` lists values; `fn` receives their real values as one tuple and returns plain data.

- A dependency must be a deploy-time value: `environment.name`, another `resolve()` result, a configuration value, or a plain field of a module's input.
- A runtime value, or a wrapped field of a module's input, cannot be listed. A computation over a value the deploy does not have can produce nothing useful. Listing one fails to compile, and the type error says that a dependency must be a deploy-time value. To compute with a field, declare it plain.
- The compiler cannot see every case: a schema without type information, a field typed `unknown`, and a cast all pass. So Load also refuses a dependency whose real value is a pointer or contains one at any depth, with an error naming the field and saying to declare it plain. The check is deep because an object field whose leaves are wrapped contains pointers.
- So `fn` never receives a pointer. Pointers stay inside Composer: Load produces them, the serializer writes them into the service's input document, and boot reads the variables they name.
- Every value `resolve()` lists is part of the graph, whichever one `fn` uses.

## 7. The root's input

The root may declare `input`. Nothing provisions the root, so the deploy binds it: the root's binding is **the configuration** (section 8). The root's schema checks it before anything is created, and a mismatch fails the deploy with the schema's message and the environment's name. A refused secret field never echoes its value.

The root meets the first requirement in section 2 the same way as any other module. Its body names the fields it needs. Nothing stands for the whole configuration, which by default holds every variable of the process environment.

A root's fields stay plain. The configuration never holds a pointer, so wrapping a root field would only stop a `resolve()` from using it.

A root's input cannot hold a secret yet: the configuration is plain, and a `secretString()` field refuses a plain value. A root binds `envSecret()` where it provisions a child.

## 8. Config adapters and secrets adapters

The `composer` section of `prisma.config.ts` gains two lists: `config`, a list of **config adapters**, and `secrets`, a list of **secrets adapters**. The terms follow .NET's configuration system, where configuration providers are merged in order into one configuration.

- An adapter receives the environment's name and the folder of the declaring `prisma.config.ts`, and returns an object, possibly asynchronously.
- The adapters of a list run one at a time, in order. Their results merge by top-level key; a later adapter wins. A key whose value is `undefined` does not hide an earlier adapter's value.
- The merged result of the config adapters is **the configuration**. It is the root's binding, and `envParam()` reads it. Deploy preflight also fills a missing platform variable for an `envParam()` in a service's per-key params from it.
- The merged result of the secrets adapters is **the secrets**. Every value in it must be text; an adapter that returns anything else fails the command with `CONFIG.ADAPTER_INVALID`. Deploy preflight and dev preflight fill a missing `envSecret()` platform variable from the secrets, by name. A name no adapter supplies fails as today.
- Preflight fills only a platform variable that does not exist yet. Editing a value in `.env.production` and deploying again does not change a variable the platform already holds. To change one, change it on the platform.
- An adapter that throws fails the command with `CONFIG.ADAPTER_FAILED`. Its message is redacted like any other output (section 9).
- Both lists default to **`[environmentVariables()]`**. A project with neither key reads its values where it did before. A list the author writes replaces the default; to keep reading the shell, include `environmentVariables()`.
- Composer reads its own credentials (`PRISMA_SERVICE_TOKEN`, `PRISMA_WORKSPACE_ID`, `PRISMA_REGION`) from the process environment, as today.

### The two adapters that ship

- **`environmentVariables()`** returns the process environment, except the variables whose names start with `PRISMA_COMPOSER_`, which Composer uses to pass data to its own second process.
- **`dotenv()`** reads `.env` files from the folder of `prisma.config.ts`. It delegates to `dotenv-flow`, pinned to one version, because `dotenv-flow`'s file order becomes Composer's. `listFiles` gives the files for the environment, and `parse` merges them without touching the process environment. Composer passes the pattern `.env[.node_env][.local]`, so `dotenv-flow`'s `.env.defaults` file is not read. The order, lowest first, is `.env`, `.env.local`, `.env.<environment>`, `.env.<environment>.local`. Following `dotenv-flow`, `.env.local` is skipped when the environment is `test`. `dotenv()` reads files only.
- A project that loads `.env` with `import 'dotenv/config'` in `prisma.config.ts` must remove that import when it adopts `dotenv()`. Otherwise the import puts `.env`'s values into the process environment, `environmentVariables()` returns them last, and they override `.env.<environment>`. The release note says so.

### Which commands run which adapters

- `prisma deploy` runs both lists, in its first process.
- `prisma dev` runs both lists, in its first process, at start and at each rebuild.
- `destroy` runs only the config adapters. It loads the graph, so the configuration must satisfy the root's schema. It runs no preflight, so it does not need the secrets, and an unreachable secrets manager cannot block a teardown.
- No second process runs an adapter (see below), and no other command runs one. So `dev url`, `dev stop`, `log` and `deploy list` keep working when a `.env` file is broken or a secrets manager is unreachable.

In `prisma dev`, a changed adapter value pauses rebuilds until dev is restarted, as an edit to `prisma.config.ts` does today. A later slice watches every input and applies new values (section 11).

### The deploy's two processes

`prisma deploy` runs the adapters in its own process, to check the root's input and run preflight. It then starts a second process, which loads `prisma.config.ts` and the graph again, and runs Alchemy to do the deploy. The second process runs no adapter.

Instead, the first process writes a **configuration file** beside the generated stack file, in `.prisma-composer/`. It holds only the values the graph reads from the configuration:

- for each path of the root's input that the root's body names, the real value the first process's check produced;
- for each name an `envParam()` in the graph reads, that name's value in the configuration.

The second process takes the root's real values from the file and does not run the root's schema again. It could not: the file lacks the fields the body never names, and a required one among them would fail the check. The first process has already checked the whole configuration.

- The file is JSON. A root field whose real value JSON cannot hold exactly, such as a `Date` a transform produced, fails the deploy in the first process, naming the field.
- The file is readable only by its owner (mode 0600). The first process deletes it when the deploy ends, whether the deploy succeeds or fails.
- The second process never needs the secrets, so the file holds none. It inherits the shell's environment, as today, so a secret in the shell is present in it; it reads none.
- The second process reads the values the first process checked, so a `.env` file edited during the deploy, or an adapter that would return something else a second time, cannot change what is deployed.
- The first process also passes the second the list of node addresses it checked, in a `PRISMA_COMPOSER_` environment variable, as it passes the preflight payload. The second process refuses to deploy a graph whose list differs. A body that reads `process.env` directly is the way this can still happen (section 2).

`destroy`'s second process receives the configuration through the same file.

### `prisma dev`'s two processes

`prisma dev` starts a second process at start and at each rebuild. That process receives the configuration through the same kind of file, which `prisma dev` deletes when it stops. Unlike the deploy's second process, it needs the secrets, because the local services run with them. The first process passes the value of each name an `envSecret()` in the graph names through the second process's environment, in memory. Neither process writes a secret to a file for this.

## 9. Keeping secret values out

- A secret's value enters no file Composer writes for a deploy, no deploy state, no deploy report and no log line. An `envSecret()` reaches the service's input document as a pointer. The configuration file holds no secrets (section 8).
- **What Composer redacts.** Everywhere it prints, Composer redacts:
  - every value under a name that an `envSecret()` in the graph names, whether in the configuration or in the secrets;
  - every value a project's own secrets adapters return, when the project writes a `secrets` list.

  The default list, `[environmentVariables()]`, only supplies the values of the names `envSecret()` names, so under it only those values are redacted. Redacting every value in the shell would blank every `1` and `true` in the output.

  A value is redacted at any length. There is no minimum.
- **Where.** Errors, adapter failures including an adapter's own message, the second process's output, and the second process's failure cause.
- **Plain values are redacted too, for now.** Composer redacts by value, and a `.env` file often holds secrets and plain values side by side. When a project's own secrets list reads such a file, every value in it is redacted, the plain ones included. A later slice gives secrets a home distinct from plain values, so that only secrets are redacted (section 11).
- **The second process's output.** To redact it, Composer reads that output through a pipe and writes it on, instead of letting the second process write to the terminal. So the second process has no terminal, and Alchemy's progress display and colours change. A secret can be split across two chunks of output. So the redactor holds back the last characters of each chunk, one fewer than the longest secret's length, until the next chunk or the end of the output. A test splits a secret across two chunks.
- A schema's refusal of a `secretString()` field says what kind of value it got, never the value.
- Under `prisma dev`, the local compute emulator saves each service's environment, secret values included, in its own state file (mode 0600). That is recorded and deferred.

## 10. What goes away

The module slots `params` and `secrets`, `paramNeed()`, and the module form of `secret()` are removed. A module or a `provision()` that still uses them is refused with an error naming `input`. `paramSource()`, `secretSource()`, and a service's per-key params stay.

This design also removes or replaces the following. All but the last were built by S2 to S5.

- **`isRuntimeValue()`**, public in `@prisma/composer` and taught in the building-an-app guide. A `resolve()` function never receives a pointer, so nothing needs it.
- **A `resolve()` function returning a pointer it received**, and Load's special case that accepts one.
- **Forwarding a non-root module's whole `input`**, which S2 to S5 allow and test.
- **The stand-in values** that a module's and a service's schema check in place of a runtime value. Schemas see pointers instead. `paramSource()`'s `sentinel` option goes, and its `redacted` option decides the kind of pointer the source gives.
- **The "pool" names in code**: `LoadOptions.configPool`, `paramSource()`'s `poolKey` option, and `readConfigPool` and `readSecretsPool` on `@prisma/composer/internal/pools`, which the generated stack files import. The code takes the names "the configuration" and "the secrets", and the generated stack files read the configuration file instead.
- **The second process's own run of the config adapters**, and the requirement that adapters return the same values in both processes.
- **A service binding's loose type, `InputBinding`**, which accepts any source in any key.

`auth()`, `email()` and the examples move to `input`. The email example's root reads its input from `.env` files. The auth example keeps `serviceOrigin()` and `envParam()`, now inside `input`, and the auth service's schema wraps the fields they bind. The storefront-auth example keeps its root `envSecret()` and drops `import 'dotenv/config'` if it adopts `dotenv()`.

This breaks `@prisma/composer` for:

- any module that used the slots;
- any code that calls `isRuntimeValue()`;
- any service schema with a field bound to `generatedParam()` or `serviceOrigin()`, which must now be wrapped;
- any service binding that type-checks only because of the loose type.

The release note shows each change before and after.

## 11. Later

Slices of this project, designed with Will after the others ([plan.md](plan.md)):

- A slice that watches every input in `prisma dev`, `.env` files and other adapters alike, and applies new values instead of pausing.
- A slice that designs protection against a developer's local secret reaching another environment: deploying production from a machine whose `.env.local` holds a test key fills a missing production variable with that key.
- A slice that gives secrets a home distinct from plain values, so that redaction stops covering the plain values that share a `.env` file with secrets.

Outside this project:

- Deprecate `envParam()`.
- A runtime config source that provisions a plain platform variable and keeps its value in deploy state.
- Secrets adapters such as `doppler()`, which would fill the deploy-time secret cell and let a root's input hold a secret.
- Routing runtime secrets to a secret store such as Doppler.
- A secret box that survives an ArkType copy.
- Listing an unset `envParam()` in a module's input among the deploy report's absent keys.
- Running the deploy through Alchemy's programmatic API, in Composer's own process. That removes the second process, and with it the configuration file and the piping of its output.

## 12. Decision records and glossary this amends

These decisions get an amendment note, each in the PR that changes the behaviour it records: module input, `resolve()` and config adapters, module boundary, secrets, env-sourced params, service input, the `composer` config section, dev secrets, and errors. The errors decision gains `CONFIG.ADAPTER_FAILED` and `CONFIG.ADAPTER_INVALID`.

### What this design reverses

Each amendment says plainly which recorded statement it reverses:

- **`resolve()` and config adapters**, as amended by S3: a `resolve()` function receives a runtime value as a pointer and may return it, and `isRuntimeValue()` ships. Now a runtime value or a wrapped field cannot be listed, and `fn` never sees a pointer.
- **`resolve()` and config adapters**, as first written: secrets adapters fill the "known at deploy time, protected" cell, and their design is a separate decision. Now the `secrets` list ships, its values fill platform variables that a service reads at boot, and the deploy-time secret cell stays empty.
- **`resolve()` and config adapters**: "no environment is special". `dotenv()` skips `.env.local` when the environment is `test`, following `dotenv-flow`. That is one exception.
- **`resolve()` and config adapters**, as amended by S4: `dotenv()` follows Vite and `dotenv-flow` and lists four files itself. Now it delegates to a pinned `dotenv-flow`, without `.env.defaults`.
- **Module input**, as first written: the body "cannot read it or branch on it". The S2 amendment corrected that, and this design relies on the correction.
- **Module input**, as amended by S2: "to narrow, forward the whole `input`". Now the whole `input` is refused everywhere a value goes. A module declares a flat schema and passes fields by name.
- **Service input**: at deploy the schema sees each secret as an opaque `SecretString` stand-in. Now it sees a pointer, and a field bound to `generatedParam()` or `serviceOrigin()` must be wrapped. A service's binding is also now typed from its schema.
- **Service input**: an env-sourced value that is unset or empty is left out. The root's input keeps the empty text from a `.env` line such as `KEY=`.
- **The `composer` config section**, as amended by S4: the second process reads the adapters again, and an adapter must return the same values for the same environment in both processes. Now the second process reads the configuration file and runs no adapter.
- **Dev secrets**: it rejected "Load `.env` in Composer itself", and told projects to add `import 'dotenv/config'`. `dotenv()` partly reverses the first: Composer ships the loader, but the user still names it in `prisma.config.ts`. A project that adopts `dotenv()` removes the import. The dev second process now receives its secrets from the first process, not from its own environment or adapters.

### The glossary

- The entry "Configuration — params and their sources" is renamed **Input**. It says what a node's input schema declares, and the values a binding can give it: literals, values and sources. The older per-key service params get one line in it, as the older form. Other glossary text that uses "Configuration" in that sense, such as the Core nouns introduction, changes with it.
- The entries "Config pool", "Secrets pool" and "Config adapter", which S4 adds, are replaced by four: **the configuration**, **the secrets**, **config adapter** and **secrets adapter**.
- New entries: **`field()`**, which also defines a wrapped field and a plain field, and **`RuntimeValue`**, which also defines a pointer and its two kinds.
- The **Value** entry changes. A body can branch on a value, but the branch always goes the same way, so it cannot vary the graph. `envSecret()`, `generatedParam()` and `serviceOrigin()` give runtime values. The sentence saying that `envParam()` and `envSecret()` are not values yet goes.
