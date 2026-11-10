# ADR-0042: Service input is one Standard Schema, and the binding is typed from it

```ts
// service.ts: the service declares what shapes are legal, in its own schema library
import { field, secretString } from '@prisma/composer/zod';
import { compute } from '@prisma/composer-prisma-cloud';
import { z } from 'zod';

const chatInput = z.discriminatedUnion('stripeEnabled', [
  z.object({ stripeEnabled: z.literal(false), returnUrl: field(z.string()) }),
  z.object({ stripeEnabled: z.literal(true), returnUrl: field(z.string()), stripeSecretKey: secretString() }),
]);

export default compute({ name: 'chat', input: chatInput, deps: { /* … */ }, build });
```

```ts
// module.ts: whoever provisions the service binds where each value comes from
provision(chatService, {
  input: {
    stripeEnabled: true,
    returnUrl: serviceOrigin('shop.web'),
    stripeSecretKey: envSecret('STRIPE_SECRET_KEY'),
  },
});
```

```ts
// anywhere in the service: one call, one inferred type, narrowing included
const input = chatService.input();
if (input.stripeEnabled) stripe(input.stripeSecretKey.expose());
```

## Decision

A compute service declares all of its input, plain values and secrets together, as **one [Standard Schema](https://standardschema.dev)** (Zod, ArkType or any conforming library), `input`, and reads it back through **one typed accessor**, `service.input()`. Whoever provisions the service binds that input with `provision(service, { input: { … } })`. Dependencies stay separate: they are declared with `deps` and read through `service.load()`. The reserved `port` param is read through `service.port()`.

- **Secret fields** are typed `secretString()`. **A leaf field that may receive a value known only at boot**, such as another service's origin, is wrapped in `field()`. `@prisma/composer/arktype` and `@prisma/composer/zod` export both helpers. For any other library, `@prisma/composer` exports the `Pointer` type, `isPlainPointer()`, `isSecretPointer()` and `isSecretString()`, from which an author writes the same two helpers.
- **The binding** mirrors the schema's shape. Each leaf is a literal, a value such as a `resolve()` result or a module's input field ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), or a source: `envParam()`, `envSecret()`, `generatedParam()` or `serviceOrigin()`, each of which is a value too.
- **The binding is typed from the schema's input type**, with the same mapping a module's binding uses ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)). So a wrong literal, an `envSecret()` in a text field, or a `serviceOrigin()` in a plain field fails to compile.
- **The deploy checks the binding with the schema** before anything is created, with each value known only at boot in place as its pointer, and writes the schema's output into one input document.
- **At boot** `service.input()` reads that document, leaves out each field whose platform variable has no value, puts each secret in a redacting box, checks the result with the schema again, and returns it.

## The binding's type

`InputBinding<T>` is what a binding accepts where the schema expects `T`. A leaf of type `T` takes a value of type `T`, or the literal `T`. Two kinds of leaf take no literal. A `SecretString` field takes a secret runtime value, such as `envSecret()` or a redacted `generatedParam()`, or a module's secret field passed on: a secret box written in a binding fails to compile, because a secret's value never sits in the code. A pointer is never written as a literal either: a field wrapped with `field()` takes `serviceOrigin()` or a plain `generatedParam()`, whose values are typed `RuntimeValue<string>`, which is `Value<Pointer<string>>`. A plain field takes neither kind of runtime value, and `envParam()`, whose value is text, fits only a field that accepts any text.

`InputBindingOf<I>` is the binding of a node whose input schema is `I`. `provision()` takes it for a service and for a module, so the two look the same to whoever provisions them, as the module boundary decision asks ([ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md)). `input` is required exactly when the node declares an input schema, with or without dependencies, so a call that leaves it out fails to compile.

The type checks a binding's shape and kind: the keys, the type of each literal, whether a leaf is a literal or a value, and whether a value is a secret or plain, deploy-time or known only at boot. It cannot check a refinement the schema's input type does not carry, such as a URL format, a minimum length or a pattern: a literal `'abc'` bound to a URL field compiles, and the deploy check refuses it. A schema without type information has the input type `unknown`, and its binding takes anything; the deploy check below still applies.

## The deploy check

The deploy resolves the binding. A literal stays as written. A deploy-time value becomes its real value: `envParam('NAME')` reads `NAME` from the app configuration, the values the `config` adapters return ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), and an unset or empty `NAME` leaves the key out. A value known only at boot becomes a **pointer**, an object that names the platform variable holding the data and records its kind: a secret pointer for `envSecret()` and a redacted `generatedParam()`, a plain pointer for `serviceOrigin()` and a plain `generatedParam()`.

The schema then checks the resolved binding, synchronously; a schema that returns a promise fails the deploy. `secretString()` accepts a secret box or a secret pointer. A wrapped field accepts what its inner schema accepts and a plain pointer. A plain field accepts neither pointer. So a plain field bound to `serviceOrigin()` fails the deploy with that field's own message, which catches a binding the compiler could not see: a schema without type information, or a cast. A schema may check a pointer but never replace it or move it to another field.

A schema may return a copy of a pointer: ArkType copies its input when a transform runs anywhere in it, a wrapped field's included, and when it deletes undeclared keys. The copy keeps the pointer's brand and the variable it names, so the deploy recognises a pointer by those, never by object identity. A copied secret box, though, loses its value, so a service whose binding holds a secret pointer is checked a second time, with a stand-in box holding a known text in place of each secret pointer. If a box in the output no longer gives back that text, the deploy refuses the service, naming the field and saying that the schema copies its input. A Zod schema keeps the box when it transforms. A schema whose output holds a secret box its binding did not supply, such as a default, is refused too: no platform variable stands behind it.

## The input document

The deploy writes the schema's output, with defaults applied, into one environment row per service, `COMPOSER_<address>_INPUT`. Each pointer is written as a marker. A secret pointer from `envSecret()` becomes `{"$platform": {"name": "<VARIABLE>", "secret": true}}`, naming a platform variable the operator sets on the platform ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)). A `generatedParam()` and a `serviceOrigin()` become `{"$generated": "<VARIABLE>", "redacted": <true|false>}`, naming a variable in Composer's reserved `COMPOSER_` namespace that the deploy writes: with a value it generates once and keeps in deploy state, or with the other service's public origin. A `$platform` marker records `secret`, and a `$generated` marker records `redacted`, because boot cannot ask the schema which fields are secret. The two differ in name and place on purpose. `secret` is a fact about the operator's variable, so it sits beside the variable's name in the marker's body. `redacted` is the option the author gave `generatedParam()` for a value Composer generates, so it keeps that option's name. The marker format and the code that reads it live in `@internal/input-document`, which the serializer, boot and the local target share.

```json
{
  "stripeEnabled": true,
  "returnUrl": { "$generated": "COMPOSER_SHOP_CHAT_RETURNURL_GENERATED", "redacted": false },
  "stripeSecretKey": { "$platform": { "name": "STRIPE_SECRET_KEY", "secret": true } }
}
```

No secret's value and no generated value appears in the document. The deploy report prints it with each marker shown as `$platform NAME` or `$generated NAME`, with every key that resolved absent. A user key spelled like a marker, `$platform`, `$generated` or `$secret`, gains one more leading `$` when written and loses it when read, so only Composer can place a marker. The `$generated` variables of one service must be distinct once upper-cased, or the deploy fails naming both input paths, because Composer writes each one. Two `$platform` markers for one name are two reads of one variable and are allowed. The document is JSON, so the schema's output must be plain objects, arrays, text, numbers, booleans, null and secret boxes. A schema that outputs a `Date`, a `BigInt` or another class instance is outside this contract; keep the field as text and convert it in the service.

At boot `service.input()` reads the one row and replaces each marker in four steps:

1. A `$platform` marker whose variable has no value, unset or empty, leaves its key out of its object. A marker in an array position cannot be left out, so boot fails naming the variable and the path.
2. A `$platform` marker whose variable has text takes the text.
3. A marker with `secret: true` puts the text in a secret box. A `$generated` marker becomes a box or text as its `redacted` says.
4. The schema checks the result. When it fails and step 1 left out at least one variable, the error ends with the names of those variables, so the operator knows what to set.

`service.input()` returns the schema's output. Its type is the schema's output type with every pointer removed, at any depth, because at boot each pointer has been replaced by the variable's text: a wrapped field reads as its inner type, and a `secretString()` field as `SecretString`. `mockService()`'s input double has the same type.

An `envParam()` field whose variable is unset or empty in the app configuration is a key left out at deploy, and an `envSecret()` field whose platform variable is unset or empty is a key left out at boot. Whether that is allowed is the schema's call: an optional field, a union member, or an error with the schema's message. So an optional secret, or a field that exists only when another field is set, is an ordinary schema, with no flag of Composer's. Empty means unset because the platform cannot store an empty value.

## Reasoning

**Legality is relational, and Composer should not invent a language for it.** A real service has inputs such as "no `stripeSecretKey` unless `stripeEnabled`". Per-key declarations cannot say that; a schema library says it with a union, and gives the service narrowing for free. Composer adopts the schema libraries the app already uses instead of growing its own.

**Composer never looks inside the schema.** Standard Schema exposes one capability, `validate`, and leaves out introspection on purpose. A framework that walked Zod's or ArkType's internals would be tied to their private representations. So the two halves split the work: the binding is plain data Composer can walk, and the schema is a black box that judges it, at deploy and again at boot. The binding's type comes from the schema's input type, which every Standard Schema publishes, so typing the binding needs no introspection either.

**Shape and kind fail in the editor.** The deploy check catches every binding the schema refuses, but late: after the author has run a deploy. Typing the binding from the schema moves the failures of shape and kind to the editor wherever the schema has types: a missing or undeclared key, a literal of the wrong type, a source in the wrong kind of field. The two checks agree because both come from the schema: the type from its input type, the deploy check from its `validate`. The deploy check stays, for a refinement the type cannot express, a schema without types, and a cast.

**Secretness is a type, checked both ways.** A secret field is typed `SecretString`, and a secret source gives a secret pointer. Binding a plain literal or a plain pointer to a secret field fails, and binding a secret source to a text field fails, at compile time and at deploy. Neither the service's author nor the operator can misclassify a credential without the other side noticing.

**Pointers, not stand-ins.** The schema sees each value known only at boot as the pointer that names its variable. A wrapped field accepts a plain pointer and a plain field does not, so a field that would receive text only at boot must say so in its schema, and the deploy can tell. A schema cannot check a secret's content, because at deploy it sees a pointer; content checks on credentials Composer never reads are impossible by construction.

**One document, not per-key rows.** Flattened key names collide (`stripe_secret` the key against `stripe.secret` the path), cannot express union members or nesting, and require the boot side to know every key. A self-describing document needs none of that, and because it holds the schema's output with defaults applied, deploy and boot judge the same data.

## Consequences

- `compute()` takes `input`, one Standard Schema, and `provision()` takes one `input` binding typed `InputBindingOf<I>`. `service.input()` returns the checked input. The service-level `params` and `secrets` declarations and the `config()` and `secrets()` accessors are gone. The reserved `port` and `origin()` keep their own accessors.
- The type `InputBinding<T>` is shared by modules and services. A binding whose shape or kind the schema's input type refuses fails to compile: a wrong literal type, a missing or undeclared key, a source in the wrong kind of field, or a missing `input`. A refinement the type cannot express, such as a URL format, is checked by the deploy, as is a binding the compiler cannot see: a schema without type information, or a cast.
- Errors about a binding's data are the schema library's own messages, at compile time as a type error and at deploy as the library's issue text.
- A schema that copies its input cannot hold a secret field in ArkType; the deploy refuses it and names the field.
- The deploy report prints each service's input document, each marker as `$platform NAME` or `$generated NAME`, and every key that resolved absent.
- Composer's own per-service values, such as another service's URL wired as a dependency, still travel on per-key rows ([ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md)). Moving them into a document like this one is a separate decision.

## Alternatives considered

- **Introspect the schema** (walk Zod's or ArkType's internal nodes, or use per-library metadata). Rejected: it ties Composer to private internals and versions, and Standard Schema's authors excluded introspection on purpose.
- **A framework language for conditional configuration** (`secret({ when: … })`, conditional maps). Rejected: it reimplements a fraction of what schema languages do, and every app would have to learn it.
- **Per-key rows with key names rebuilt at boot**, the model before this decision. Rejected: boot would need to enumerate keys the schema cannot list, and nesting and union members cannot be expressed.
- **An `optional` flag on secret slots.** Rejected: it covers presence only, not conditions, and an optional field in the schema already says it.
- **Opaque stand-ins at deploy**, which an earlier version of this decision used: the schema saw a stand-in box for each secret and a stand-in string for each generated value. Rejected: a plain text field accepted the stand-in for `serviceOrigin()`, so the deploy passed a binding that the service could only read as text at boot, and the schema never learned which fields wait for a value known only at boot. Pointers make the schema say so.
- **A loosely typed binding**, which an earlier version of this decision used: one type that took any literal or source in any key, because the binding's exact shape seemed to need introspection. Rejected: a binding that type-checked could fail the deploy, and a service's binding looked different from a module's. The schema's input type gives the shape without introspection.

## Related

- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md): a module declares its input the same way, and its binding has the same type.
- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md): a module has the same boundary as a service.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): values, runtime values and pointers, and the app configuration `envParam()` reads.
- [ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md): platform variables, the `$platform` marker's rules, and the deploy preflight.
- [ADR-0021](ADR-0021-params-are-read-through-config-not-load.md), superseded: `config()` is replaced by `service.input()`; dependencies still read through `load()`.
- [ADR-0029](ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md), partly superseded: `envSecret()` survives as a binding leaf; the `secrets()` read and per-slot pointer rows are replaced.
- [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md), partly superseded: binding at `provision()` and `envParam()` survive; the `config()` read and per-key pointer rows are replaced.
- [ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md): Composer's own provider params, still on per-key rows.
- [config-params.md](../10-domains/config-params.md): the sources, and where each is accepted.
