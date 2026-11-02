# S1 spike: an input field as an opaque typed value

Probe code: [`probe/`](probe/), committed as a1f46317. Nothing under `packages/` was changed. TypeScript 6.0.3, ArkType 2.2.7, Zod 4.4.3, Bun 1.3.13, Node 26.8.1.

```sh
cd .drive/projects/module-input/slices/s1-spike/probe
../../../../../../node_modules/.bin/tsc -p tsconfig.json          # type tests: exit 0
../../../../../../node_modules/.bin/tsc -p tsconfig.errors.json   # lines meant to fail: 9 errors
bun run.ts                                                        # Load, second pass, how core handles it
bun operators.ts                                                  # what each operation does
bun serializer-morph.ts                                           # the ArkType morph finding
```

## 1. Typing `input` from the schema

`InputValue<T> = Value<T> & FieldsOf<T>`: a value, plus one value per key when `T` is a plain object. Checked for ArkType and Zod.

| Schema field | `input…` | Type |
| --- | --- | --- |
| `EMAIL_FROM: 'string'` | `input.EMAIL_FROM` | `Value<string>` |
| `smtp: { host, port: 'number', 'tls?': { ca } }` | `input.smtp.port` | `Value<number>` |
| | `input.smtp.tls.ca` | `Value<string \| undefined>` |
| `'SITE_HOSTNAME?': 'string'` | `input.SITE_HOSTNAME` | `Value<string \| undefined>`, always present |
| `tags: 'string[]'` | `input.tags` | `Value<string[]>`, no element access |
| `signingKey: secretString()` | `input.signingKey` | `Value<SecretString>`, no members |
| `count: 'string.integer.parse'` | `input.count` | `Value<number>`, the schema's output |
| the whole schema | `input` | `Value<typeof schema.infer>` |

A discriminated union exposes only the keys every member has. For the service input decision's stripe example, the body reaches `input.stripeEnabled` but not `input.stripeSecretKey`. Narrowing would be branching. The body can forward the whole `input`, or narrow inside `resolve([input], ([real]) => …)`.

A module child's binding is typed `Bindable<InferInput<S>>`: each key takes the data, a value of its type, or a source for a secret. The compiler refuses an optional value in a required field and a `Value<number>` in a string field.

## 2. Building `input` at runtime

`inputValues(moduleAddress)` returns a Proxy whose `get` trap answers core's value brand and origin symbols. The origin is `{ kind: 'input', module, path }`. Any other key returns the Proxy for the longer path, and the same path always returns the same object. Load builds one per module address.

Load needs no record of its own. The existing walk finds a value in a child's binding or a `resolve()` dependency list, and its origin names the module and path. `provision(child, { input })` is the value with path `[]`.

The second pass resolves an input value by resolving its module's binding, validating it with the module's schema, and reading the path out of the validated output. That recursion runs up to the root, whose binding is the config pool. A real value is the schema's output: `'4'` through `string.integer.parse` becomes `4`. An optional field the binding leaves out has no real value, and the child's binding leaves out the key. A secret source reaches a service through two module validations, by identity.

## 3. Reading, comparing and branching

These throw an error naming the field: a template literal, `String()`, `+`, `==`, `<`, arithmetic, `toString()`, `JSON.stringify`, `Object.keys`, spread, `for…in`, iteration, `in`, assignment and freezing. Example message:

```
input.smtp.host of module "shop" is a value, not its real value, and it was turned into text (a template literal or String()). A module body can only pass an input field on: into a provision() input or as a resolve() dependency. To compute with it, list it: resolve([input.smtp.host], ([v]) => …).
```

These cannot be caught at runtime, because JavaScript calls no trap: truthiness (`if`, `!`, `&&`, `||`, `? :`), `??`, `===`, `!==`, `switch` and `typeof`. `if (input.flag)` always takes the branch. The compiler refuses `===` against a literal and `switch` cases, because the types don't overlap. A method call such as `input.from.toUpperCase()` gets the engine's `TypeError`, and the compiler refuses it too.

## 4. The existing `Value` brand with a new origin kind

`isValue()`, `originOf()` and `resolve()` work unchanged. Core needs:

- `ValueOrigin` gains `{ kind: 'input'; module; path }`, and `resolveOne` gains its case, caching each module's validated input by address.
- Load records each module child's binding, as it records service input bindings, with its own wording in `describeSite`.
- `substitute` leaves out an object key whose real value is `undefined`.
- `deepValues` in `load-module.ts` stops at a value; today it lists the value's keys and the Proxy throws.
- `checkResult` asks `isValue(result)` before `isThenable(result)`.

## 5. Corrections to the design

- **a.** "Reading, comparing or branching fails with an error naming the field" cannot be met as worded. See question 3. The structure rule still holds, because a branch sees an object and always goes the same way.
- **b.** A module's binding is validated during the second pass, synchronously, not after it, because a child's real value is read from the parent's validated output. An async schema fails the Load.
- **c.** An ArkType schema with a morph copies its input, which breaks secret sentinels matched by identity. The probe tags each sentinel with a symbol property, which survives the copy. This already breaks services today: an ArkType input schema with a secret field and any morph cannot deploy (`serializer.ts` in the Prisma Cloud target).
- **d.** `InputBinding` refuses `Value<SecretString>` and `Value<T | undefined>`. The second slice must widen it.
- **e.** A union body reaches only shared keys, and arrays have no element access.
- **f.** An unused input field cannot be detected, as the design notes say.
