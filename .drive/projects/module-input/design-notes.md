# Module input — design notes

The design is in the module input decision (ADR-0061) and the `resolve()` and config adapters decision (ADR-0062). These notes record what the discussion with Will on 2026-10-29 settled beyond them, and where it corrects them.

## 1. A module input field is a value

`module(name, { input: schema }, ({ input, environment, provision }) => …)`. The body receives one value per field (`input.from`, nested fields too), typed from the schema: a `from: 'string'` field is `Value<string>`. The body can pass a value on, into a child's or a service's `input`, or list it as a `resolve()` dependency. Nothing else.

## 2. The kinds of value an input field can hold

| | Config | Secret |
| --- | --- | --- |
| **Deploy-time** (the deploy has the real value) | a literal, a `resolve()` result, the root's input from `config` adapters, `envParam('NAME')` | a value from a `secrets` adapter (later) |
| **Run-time** (only the platform has it) | none in `input` today (later, see deferred) | `envSecret('NAME')` |

`envParam()` stays deploy-time, as it is in a service's `input` today: the serializer reads the variable at deploy and writes its value into the input document. Making it a run-time pointer would break every existing app. With root input it becomes redundant and is deprecated in a later step.

`envSecret()` is a value whose real value is the pointer to the platform variable. The service dereferences it at boot, as today. The deploy never holds the secret.

This corrects the 2026-10-29 amendment to ADR-0062, which says both functions will "store the value in a platform variable the deploy owns". Neither does in this project.

## 3. Config adapters and the pool

The `composer` section of `prisma.config.ts` gains `config` and `secrets`, each a list of adapters. Each adapter receives the environment's name and returns an object. The objects merge by top-level key in list order, a later adapter winning.

- The merged `config` output is the **config pool**. The root's schema validates it as the root's `input`. `envParam('NAME')` reads `NAME` from it, where it read the deploy shell before.
- The merged `secrets` output is the **secrets pool**. Preflight fills a missing platform variable for `envSecret('NAME')` from its `NAME`, where it read the deploy shell before. A name no adapter supplies fails the deploy, listing what to set.
- Both lists default to `[environmentVariables()]`, which reads the process environment. Existing projects therefore behave exactly as today. A list the author provides replaces the default; to keep reading the shell, include `environmentVariables()`. No hint is added to the missing-value error.
- `dotenv()` ships as the first file adapter: `.env`, `.env.<environment>`, and their `.local` variants, as dotenv's convention has it. Nothing else is specific to dotenv.

## 4. `resolve()` over module input

A `resolve()` function receives each dependency's real value. For a field bound to a deploy-time value, that is the data, typed from the schema. For a field bound to `envSecret()`, it is the pointer, although the type says `SecretString`. Listing a run-time value is allowed but pointless; Will: "just put the desired value in an env var with one name".

- Every value a `resolve()` lists is part of the graph, whichever one the function returns. Preflight checks every `envSecret()` anywhere in the graph, including `resolve()` dependencies.
- A pointer throws when code turns it into text or a number (`toString`, `valueOf`, `Symbol.toPrimitive`), with a message naming the variable and saying it is known only at boot. Pulumi's opt-in `PULUMI_ERROR_OUTPUT_STRING` is the precedent; CDK's `Token.isUnresolved` is the precedent for the guard `isRuntimeValue(x)`.
- A function may return a pointer it received, and it goes through the deploy as an `envSecret()` binding does. The `resolve()` slice's rule that a result is plain data is relaxed for pointers.

## 5. Settled by the orchestrator

- `input` can be forwarded whole: `provision(child, { input })`, except the root's. The root's input is the whole config pool, which by default holds every variable of the process environment, secrets included, so Load refuses it whole and the root passes on its fields one by one.
- An optional field the binding leaves out has no real value; a child bound to it sees the key omitted, and the child's schema decides.
- Load cannot list a module's input keys (Standard Schema exposes only `validate`), so an input field the body never uses is not an error, unlike an unused `deps` entry.
- A module's binding is validated by its schema during Load's second pass, synchronously, because a child's real value is read from the parent's validated output. An async schema fails the Load. The value is validated again by each child's schema.
- A real value is the schema's output, so a field typed `number` from `string.integer.parse` receives `4`, not `'4'`.
- A discriminated union's body reaches only the keys every member has; to narrow, forward the whole `input` or narrow inside a `resolve()` function. Array fields have no element access.
- Proven by the S1 spike: [slices/s1-spike/report.md](slices/s1-spike/report.md).
- A source is a value: `envSecret()`, `envParam()`, `generatedParam()` and `serviceOrigin()` each return one object that is both the target's source and a `Value`, so the serializer, preflight and boot see the same objects as today. Load computes a real value only where core uses one: a module's input binding, a `resolve()` dependency and a resource's props.
- `generatedParam()` and `serviceOrigin()` are run-time config in a service's input today: the platform holds the value and boot reads it. So the run-time config cell is not empty; it holds the framework's own sources.
- In a service's per-key `params`, `envParam()` is a run-time pointer row. In a service's `input` it is read from the deploy shell. Both behaviours stay.
