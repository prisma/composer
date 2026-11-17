# 4. A platform variable has a schema

Parent: [project spec](../../spec.md), [plan](../../plan.md) section 4, [design](../../design.md) sections 7, 8, 10, 11 and 14.

This document is the whole design for slice 4. It states what must be true when the slice is done: every public type, every rule and where it runs, every user-facing message, the behaviour at deploy, boot and under `prisma dev`, and every record and guide that changes. It does not say which internal code changes to get there. Rejected options are in section 11. Section 12 lists where this document departs from the project design, which is amended in the same pull request.

## 1. The decision

```ts
// module.ts, the app's root
import { appRoot } from '@prisma/composer';
import { variable } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';
import mailer from './src/mailer/service.ts';

export default appRoot('shop', ({ provision }) => {
  const smtpPort = provision(variable({ name: 'SMTP_PORT', schema: type('number') }));

  provision(mailer, { input: { smtpPort } });   // the service declares smtpPort: field(type('number'))
});
```

```text
$ prisma project env add 'SMTP_PORT=587' --project 'proj_…' --role production
$ prisma deploy --environment production

# in the mailer service, at boot
mailer.input().smtpPort   // 587, a number
```

```text
# the same app with SMTP_PORT set to "abc": the deploy succeeds, and the service fails at boot
The platform variable "SMTP_PORT" does not hold a number. Its schema is not a text type, so its text must be JSON, such as 587.
```

We are adding `schema` to `variable()`.

A variable on the platform holds text. Until now every platform variable's value was that text, so a service field typed `number` could not take one. `schema` says what the text means. It is a schema from any library that implements [Standard JSON Schema](https://standardschema.dev/json-schema); ArkType and Zod both do.

Three things follow from a `schema`:

1. **The compiler knows the type.** `provision(variable({ name, schema }))` is a `RuntimeValue<T>`, where `T` is the schema's output type. `field(type('number'))` accepts a `SMTP_PORT` declared `type('number')`, and `field(type('string'))` refuses it.
2. **The type travels as data.** The constructor turns the schema into plain JSON Schema once. The deploy writes that JSON Schema into each reading service's input document. The library's own schema never runs on a value, because the app's module code is not in the service.
3. **Boot decodes and validates, by one fixed rule.** A schema that accepts only text gives the text. A schema that accepts no text reads the text as JSON. A schema that accepts both is refused when the root's body runs. The decoded value is validated against the JSON Schema before the service's own schema sees it. `prisma dev` does the same, with the same messages, before any service starts.

`variable.secret()` takes no `schema`. Without `schema`, a plain variable's value is its text, as today.

### What each part satisfies

| Requirement (project spec) | How this slice meets it |
| --- | --- |
| R1, the graph shows every variable and the type its schema declares | The JSON Schema is in the node's `props` (5.2). |
| R3, the type travels as data | The marker carries the JSON Schema (5.5); boot decodes and validates with it (5.6). |
| R4, no value is guessed | One decoding rule, fixed from the JSON Schema alone; a mixed schema is refused (5.3, 5.4). |
| R5, the same app behaves the same locally | One implementation of the kind rule, decoding, validating and the messages, used by the constructor, boot and `prisma dev` (5.6, 5.7). |
| R7, no text in an error | Every message is built from the variable's name, the JSON Schema and the validator's path through the JSON Schema, never from the text, a key of it, or a parser's or validator's message (5.6). |
| R8, every record matches the code | Section 7. |

## 2. Terms

- **The variable's JSON Schema**: the plain JSON Schema the constructor keeps in the node's `props`, reduced as 5.2 says.
- **Text-only schema**, **never-text schema**, **mixed schema**: the three kinds 5.3 decides.
- **Decode**: turn a variable's text into a value: the text itself under no schema or a text-only schema, the parsed JSON under a never-text schema.
- Every other term is the project spec's or the glossary's.

## 3. How it works, end to end

1. The root's body calls `variable({ name: 'SMTP_PORT', schema: type('number') })`. The constructor asks the schema for its JSON Schema, refuses what it cannot read, reduces it, refuses the other cases of 5.4, and keeps the result in the node's `props`.
2. `provision()` returns a `RuntimeValue<number>`. The root binds it to `smtpPort`, a `field(type('number'))` of a service's input, directly or through a module's input.
3. `prisma deploy` reads no value. It writes `{ "$platform": { "name": "SMTP_PORT", "schema": { "type": "number" } } }` into the service's input document. Preflight checks that the variable has a row, as before.
4. At boot, `service.input()` finds the marker, reads the text `587`, parses it as JSON because the schema is never-text, validates the number against the JSON Schema, and puts `587` at `smtpPort`. Then the service's own schema checks the whole input.
5. Under `prisma dev`, the dev preflight reads `SMTP_PORT` from the app configuration, decodes and validates it the same way, and stops before any service starts when it does not fit.

## 4. Core and foundation

Core's graph, Load and `provision()` do not change. A value resource's `props` already hold any plain JSON, and `InputBinding<T>` is already generic in the pointer's type.

One public predicate changes. `isPlainPointer(value)` narrowed to `Pointer<string>`; a plain pointer is now typed by the variable's schema, so it narrows to a new exported type, `PlainPointer`: a pointer whose kind is `'plain'` and whose data type is not known. `Pointer<unknown>` would not do, because its kind is either.

A wrapped field may now hold an object or an array. Until now every record said `field()` wraps a leaf and never an object schema, because every plain source gave text. A wrapped field holds the whole value one source supplies: text, a number, a boolean, or an object or array when a platform variable's schema says so. The doc comments of both `field()` helpers say so. The deploy check already accepts a plain pointer in a wrapped field whatever its inner schema.

## 5. The Prisma Cloud target

### 5.1 The constructor's type

```ts
variable(options: { readonly name: string }): ValueResourceNode<PlainVariableValue<string>>;
variable<S extends StandardJSONSchemaV1>(options: {
  readonly name: string;
  readonly schema: S;
}): ValueResourceNode<PlainVariableValue<StandardJSONSchemaV1.InferOutput<S>>>;

type PlainVariableValue<T = string> = ParamSource<PlatformVariablePayload> & RuntimeValue<T>;
```

- `StandardJSONSchemaV1` is the type from `@standard-schema/spec` (1.1.0 in this repository). ArkType's and Zod's schemas satisfy it.
- `variable.secret()` keeps its signature. Passing `schema` to it does not compile, and a cast fails when the root's body runs: `variable.secret({ name: "X" }) takes no schema. A platform secret's value is always text; check its content in the service's secret field.`
- A `schema` may be an object or a function; an ArkType schema is a function. A `schema` with no `~standard.jsonSchema` does not compile. Through a cast it fails when the root's body runs: `The schema of the platform variable "SMTP_PORT" does not implement Standard JSON Schema. Use a schema from a library that does, such as ArkType or Zod.`

### 5.2 The variable's JSON Schema

The constructor calls `schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })` and `.output({ target: 'draft-2020-12' })`, each once. It never calls the library's `validate`.

It first refuses the references and keywords of 5.4's fourth and fifth rows, which it looks for at schema positions before anything is removed. It then reduces each result to the keywords of draft 2020-12 that validate, and keeps the reduced input form in the node's `props` as `schema`. JSON Schema treats a keyword that is not one of those as an annotation, so nothing that validates is lost. The reduction walks the schema by this table and by nothing else, so a property that is named `title` or `default` is never touched, and neither is anything inside a `const` or an `enum`:

| Keywords | Their value |
| --- | --- |
| `not`, `if`, `then`, `else`, `items`, `contains`, `additionalProperties`, `unevaluatedProperties`, `unevaluatedItems`, `propertyNames` | one schema, walked |
| `allOf`, `anyOf`, `oneOf`, `prefixItems` | a list of schemas, each walked |
| `properties`, `patternProperties`, `$defs`, `dependentSchemas` | a map from a name to a schema; the names are kept, each schema walked |
| `type`, `const`, `enum`, `required`, `dependentRequired`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `format`, `minItems`, `maxItems`, `uniqueItems`, `minContains`, `maxContains`, `minProperties`, `maxProperties`, `$ref` | kept as it is |
| every other keyword, including `$schema`, `title`, `description`, `examples`, `default`, `$comment`, `deprecated` and whatever a library's metadata adds | removed |

A schema that is the boolean `true` or `false` is kept where it is a member of the table's first three rows, and refused at the top level (5.4).

Then the `$defs` are renamed. ArkType names them with a counter that depends on what else the process created, so the same type can emit `intersection215` and later `intersection232`. The constructor renames each `$defs` entry to `d0`, `d1` and so on, in the order a depth-first walk from the top first reaches a `$ref` to them, with an object's members walked in the table's order and then by name, rewrites each `$ref`, and removes an entry the walk did not reach. In `#/$defs/<name>`, `<name>` is everything after `#/$defs/`, looked up as an own key of `$defs`.

So:

- `props` is `{ name, secret: false }` without a schema and `{ name, secret: false, schema }` with one. `PlatformVariablePayload` gains the same optional `schema` member.
- A changed type is a changed node. A changed description, or an unrelated edit elsewhere in the app, is not.
- A `default` in the variable's schema has no effect. A default belongs on the service's field, whose schema runs at boot.

### 5.3 The three kinds

The kind of a JSON Schema is decided from its top level by one function, in `@internal/input-document`, which the constructor, boot and the dev preflight all call. Wherever the rule looks at a schema that is a `$ref`, it looks at the schema the `$ref` names instead; a `$ref` it has already followed makes the schema mixed.

- **Text-only** when: `type` is `"string"` or `["string"]`; or `const` is a string; or `enum` is non-empty and holds only strings; or it is an `anyOf` or `oneOf` whose every member is text-only; or it is an `allOf` with at least one text-only member.
- **Never-text** when: `type` is one of `number`, `integer`, `boolean`, `object`, `array`, `null`, or a list without `string`; or `const` is not a string; or `enum` is non-empty and holds no string; or it is an `anyOf` or `oneOf` whose every member is never-text; or it is an `allOf` with at least one never-text member.
- **Mixed** when neither rule holds or both do. That includes an empty schema, a boolean schema, a `not`, `type: "number"` with a string `const`, and an `allOf` with both kinds.

`number | null` is never-text, and the text `null` gives `null`.

### 5.4 What the constructor refuses

Each refusal happens when the root's body runs, and names the variable.

| Case | Message |
| --- | --- |
| The library throws from `.input()` or `.output()` | `The schema of the platform variable "SMTP_PORT" cannot be written as JSON Schema: <the library's message>. Declare the type the text holds, and put any other check in the service's own schema.` |
| The reduced input and output forms differ (see below) | `The schema of the platform variable "SMTP_PORT" gives a different type from the one it takes. No code runs on a platform variable's value, so a transform or a default cannot apply. Declare the type the text holds, such as type('number'), and put a default on the service's field.` |
| A mixed schema | `The schema of the platform variable "SMTP_PORT" accepts both text and other values, or neither, so Composer cannot tell how to read the variable's text. Declare a text type, or a type that is never text.` When the schema is an `anyOf` or `oneOf` of text-only members and `null`, the message adds: `A variable on the platform cannot hold null as text: declare the text type and make the service's field optional.` |
| A `$ref`, at any depth, that is not `#` or `#/$defs/<name>` with an existing name; or a `$dynamicRef`, `$dynamicAnchor`, `$anchor` or `$id` anywhere | `The schema of the platform variable "SMTP_PORT" refers to "<ref>", which Composer cannot follow. It reads only references to the schema's own $defs.` |
| A keyword of an older draft that the validator still reads (`dependencies`, `additionalItems`, `$recursiveRef`, `$recursiveAnchor`, or `items` as a list), or a keyword of 5.2's table whose value has the wrong shape, at any schema position | `The schema of the platform variable "SMTP_PORT" uses "<keyword>" in a form that is not JSON Schema draft 2020-12, which is the form Composer reads.` |
| A `pattern`, or a `patternProperties` name, that is not a valid regular expression under the `u` flag, which is how the validator compiles it | `The schema of the platform variable "SMTP_PORT" holds the pattern "<pattern>", which is not valid as a Unicode regular expression: <the engine's message>. Rewrite it; an escape such as \- outside a character class is the usual cause.` |

**Comparing the two forms.** The comparison is deep equality of the reduced forms, with the members of an object compared whatever their order and the members of a list in order. One difference is allowed, at a schema position only: `additionalProperties: false` in the output form where the input form has no `additionalProperties`. Zod writes that for every `z.object()`, with no transform involved.

The library's message in the first row, and the engine's in the last, are about the author's own schema, read at Load on the author's machine. Neither can hold a variable's value.

### 5.5 The marker, the serializer and the deploy report

- The marker of a plain variable with a schema is `{ "$platform": { "name": "SMTP_PORT", "schema": { "type": "number" } } }`. `schema` is the variable's JSON Schema.
- A marker with both `secret` and `schema`, or with a `schema` that is mixed, is malformed, and is refused with the existing malformed-marker message wherever a document is read.
- Two fields that read one variable each hold the full marker.
- The deploy report and `describeDocument` show `$platform SMTP_PORT (number)`. The word in brackets is: the top-level `type` when it is a string; its members joined with ` | ` when it is a list; otherwise `text` for a text-only schema and `json` for a never-text one. A marker with no schema shows as today.
- Preflight, the triggers and the "required or reported" check do not change. They never decode: the deploy has no value.

### 5.6 Decoding and validating: one implementation

`@internal/input-document` holds the kind rule, the decoding rule, the validator call and the messages. Boot, the dev preflight and the local target use it.

For a marker whose variable has text:

1. **No schema, or a text-only schema:** the value is the text, exactly, with nothing trimmed.
2. **A never-text schema:** the text is parsed as JSON, as `JSON.parse` reads it: surrounding whitespace is allowed, the last of two equal keys wins, and a key named `__proto__` is an ordinary key. Text that is not JSON fails. A parsed number, at any depth, that is not finite, or is a whole number outside the safe range, fails: `JSON.parse` rounds the second silently and reads `1e400` as infinity.
3. **With a schema, the value is validated** against the JSON Schema, as draft 2020-12, with `format` checked for the formats the validator knows and ignored for the others.
4. The value goes to its place in the input. It is never searched for markers. The service's own schema then checks the whole input, as today.

A variable with no value is left out before any of this, as today, whatever its schema.

The messages. `<expected>` and `<example>` come from the top-level `type`, after following a top-level `$ref`: `a number` and `587` for `number` or `integer`; `true or false` and `true` for `boolean`; `an object` and `{"key":"value"}`; `an array` and `[1,2]`; `null` and `null`. For anything else `<expected>` is `JSON` and the sentence ends at `must be JSON.`

| Case | Message |
| --- | --- |
| The text is not JSON | `The platform variable "SMTP_PORT" does not hold <expected>. Its schema is not a text type, so its text must be JSON, such as <example>.` |
| A number that is not finite or not safe | `The platform variable "ORDER_ID" holds a number outside the range Composer reads exactly, which is whole numbers up to 9007199254740991. Declare it as text and keep it as text in the service.` |
| The value does not fit the schema | `The platform variable "SMTP_PORT" does not fit its schema: it fails "minimum" at #/minimum.` |
| The parser or the validator throws anything else, such as for a document nested too deeply | `The platform variable "SMTP_PORT" could not be checked against its schema.` |

**Which failure the third message names.** The validator runs with its short-circuit option on and returns a list in which a failure is followed by the failures inside it. The message starts at the first failure in the list and moves to the next failure in the list whose schema location extends the current one's, repeatedly, and stops when there is none, or when the current keyword is `anyOf`, `oneOf`, `not` or `if`. Every failure whose keyword the validator reports as `false` is removed from the list before the walk, so its enclosing failure is named: that is the one failure whose location is built from the value's own key or index, and it arises for `additionalProperties`, `unevaluatedProperties`, `items`, `unevaluatedItems` and `contains` set to `false`. With `contains: false` and `minContains`, such a failure comes first in the list. The location is printed as the validator gives it, which is its path through the schema, such as `#/$ref/properties/port/minimum`.

No message holds the text, a part of it, a key of it, the parser's message or the validator's message.

At boot these fail `service.input()`, so the process exits and the error is in `prisma service logs <service>`. The deploy still succeeds, as for every boot failure.

### 5.7 `prisma dev`

- The dev preflight still takes a plain variable's value from the app configuration, and still refuses a value that is not text, with the existing message.
- It then decodes and validates each text with the code of 5.6, once per variable. A failure stops `prisma dev` before any service starts, with the message boot would give, followed by one sentence: `prisma dev cannot start, because service "shop.mail.service" reads it.` With several readers: `because services "a" and "b" read it.`
- The local service decodes again at its own boot, through the same code, from the same text.
- A change to a node's schema changes its `props`, so the existing comparison reports the node as changed and pauses rebuilds.

### 5.8 The validator and how it ships

`@cfworker/json-schema` 4.1.6, checked on 2026-11-18 against the JSON Schemas ArkType 2.2.7 and Zod 4.4.3 emit:

- It validates draft 2020-12. It has no dependencies, generates no code (`new Function` and `eval` do not occur in it), and uses no Node or Bun API.
- `$ref` to `#` and into `$defs` resolves, including a recursive type. An unresolved `$ref` throws when validation reaches it, and it ignores `$dynamicRef`, which is why the constructor refuses both (5.4).
- It compiles `pattern` with the `u` flag when it validates, and throws for a pattern that flag refuses, which is why the constructor compiles each one (5.4).
- It checks the formats it knows, such as `email`, and accepts any value under a format it does not know.
- Its messages can quote the value (`0 is less than 1.`), so Composer uses only each failure's keyword and location.

The validator must be present wherever `@internal/input-document` runs at boot. `@prisma/composer-prisma-cloud` and each self-contained shared-module entrypoint (auth, cron, storage, email, streams) inline it, as they inline `@internal/input-document` itself; no built entrypoint that a service runs is left with a bare import of it.

## 6. Examples

No example under `examples/` changes: none has a service field that a typed platform variable fits. The integration fixture under `test/integration/test/fixtures/local-dev/` gains a typed plain variable, bound to a number field of a service's input, and the guide shows the root of section 1.

## 7. Records, guides and skill

Each is rewritten in place as the current statement.

- **The platform-variables record (ADR-0064):** the `schema` option, the variable's JSON Schema and its reduction, the kinds, the refusals, the marker's `schema` member, decoding and validating at boot, the validator and its checked behaviour, how it ships, `prisma dev`. Its example gains a typed variable. It states that reading the JSON Schema a library emits through a public standard is not reading the library's schema.
- **The service-input record (ADR-0042):** the marker's `schema` member; boot's step 2 decodes and validates; "The binding's type" says a wrapped field takes a plain platform variable's value typed by its schema, where it said `RuntimeValue<string>`; a wrapped field may hold an object when a variable's schema says so; "Composer never looks inside the schema" cites the statement above.
- **The module-input record (ADR-0061),** the guide's passage on `field()` in `building-an-app.md`, and the skill's: a wrapped field holds the whole value one source supplies, which may be an object, where each said a leaf and never an object schema.
- **The values record (ADR-0062):** a plain pointer is typed by its source, `Pointer<T>`, where it said `Pointer<string>`.
- **The dev-secrets record (ADR-0058):** the dev preflight decodes and validates each plain platform variable.
- **Glossary:** Platform variable node (the `schema` option), `$platform` marker, Value and RuntimeValue.
- **Domain docs:** `config-params.md`, `local-dev.md` and `module-composition.md`, wherever each says a platform variable's value is text or a wrapped field is a text leaf.
- **The guide and the skill:** how to type a variable; a text type gives the text exactly and any other type reads JSON; what a library loses on the way to JSON Schema (Zod drops `.refine()`, and `.trim()`, `.toLowerCase()`, `z.coerce`, `z.preprocess()` and `.catch()` emit the same schema as without them, so they do not run; ArkType throws for `.narrow()` and `string.url`); that such a check or change belongs in the service's own schema; regular-expression flags are dropped and a pattern must be valid under the `u` flag; `format`; keep an identifier as text; a default belongs on the service's field; `z.number().optional()` does not fit `field(z.number())`, so make the service's field optional instead.
- **The project design** (`design.md` sections 7 and 8): amended to match section 12.
- **`deferred.md`:** gains the size of an input document that repeats a large schema.
- **The release note:** additive. One before and after: `SMTP_PORT` read as text and converted in the service, and the same declared `type('number')`. It names the change to `isPlainPointer()`'s type.

## 8. Acceptance: expected behaviour

Each item is proved by a test.

1. `provision(variable({ name, schema: type('number') }))` binds to `field(type('number'))` and does not compile against `field(type('string'))`. Without `schema` the reverse holds. The same with Zod's `z.number()`. An object schema binds to a `field()` of the same object type, with ArkType and with Zod; the deploy check passes for that field bound to the variable's value, bound to a literal object, and reached through a module's input. `isPlainPointer()` narrows to `PlainPointer`.
2. `variable.secret({ name, schema })` does not compile, and a cast fails with the message of 5.1. A `schema` with no `~standard.jsonSchema` fails with the message of 5.1.
3. The constructor calls `.input()` and `.output()` once each and never `validate`.
4. The reduction: `$schema`, annotations and a library's metadata keys are removed at every schema position; a property named `title` or `default`, and an object inside `const` or `enum` with such keys, are kept whole. The same recursive ArkType type gives the same `props.schema` whatever other types were created before it.
5. Each row of 5.4's table: ArkType's `.narrow()` and Zod's `.transform()` (the library throws); ArkType's `string.numeric.parse` and a default inside an object (the forms differ); `type('string | number')`, an empty schema and `string | null` (mixed, the last with its extra sentence); a `$ref` to another document and a `$dynamicRef`; a hand-written schema with `dependencies`; the pattern `a\-b`. A plain `z.object()`, a `z.discriminatedUnion` and a recursive `z.object` are accepted.
6. The kind rule: every case 5.3 lists gives the stated kind, including a union with a `$ref` member, a top-level `$ref` to an `anyOf`, Zod's `"$ref":"#"`, and a schema that meets both rules.
7. The serializer writes `schema` into the marker for a plain variable with one, and none otherwise. A marker with `secret` and `schema`, and one with a mixed schema, are refused as malformed.
8. The deploy report shows `$platform SMTP_PORT (number)`, and each other case of 5.5's rule.
9. Boot: a number, a boolean, a string enum, an object and a recursive type each arrive with their type. Two fields that read one typed variable both receive it. A variable with no schema whose text is `587` arrives as the text `587`. A text-only enum whose text has a trailing newline fails; a number whose text has one arrives. An unset variable with a schema is left out. A decoded object that holds a `$platform` key arrives as data.
10. Boot failures, each with the message of 5.6: `abc` under a number, a boolean, an object and a union schema (each `<expected>` form); `9007199254740993`, `9007199254740993.0`, `1e21` and `1e400`; `0` under `minimum: 1`; `0` under `number >= 1 | null`, which names `anyOf`; a failure behind a `$ref`; a missing key under Zod's `z.record(z.enum(['a','b']), z.number())`, which names `required`; an unknown key under `additionalProperties: false`, which names `additionalProperties`; a `format` the validator knows, failing, and one it does not know, passing; a document nested deeply enough to throw.
11. A planted secret as the text of a variable under a number schema, as a key under `additionalProperties: false`, under `unevaluatedProperties: false`, under `propertyNames`, as a key named `properties`, and under a pattern: no message holds any part of it, at boot and under `prisma dev`.
12. `prisma dev` stops before any service starts for a text that does not decode or fit, with boot's message and the reader sentence for one reader and for two, and starts when it fits.
13. The comparison `prisma dev` runs after a rebuild reports a node whose schema changed.
14. `bun run test/local-dev.integration.ts` passes with a typed plain variable in its fixture.
15. No built entrypoint that a service runs, in `@prisma/composer-prisma-cloud` or the five shared modules, holds an import of `@cfworker/json-schema` or of `@internal/input-document`.

## 9. Scope

### In

Everything in sections 4 to 7.

### Out

- **`schema` on a platform secret.** In `deferred.md`.
- **Validating at deploy.** The deploy has no value.
- **Running the library's schema anywhere.** The app's module code is not in the service.
- **A size limit on the input document.** A marker repeats its schema in every field that reads the variable, and the document is one variable on the platform. No limit on a value's size is recorded. Added to `deferred.md`.

## 10. Done when

- Every acceptance item passes; build, typecheck, lint, the cast check and the dependency check pass for the whole repository.
- Checked on Prisma Cloud: a number, a boolean, an enum and an object variable received with their types; `type('number')` with the text `abc`, where the deploy succeeds and `prisma service logs <service>` shows the boot error; a planted secret decoded under a number schema, with the error searched for any part of it; the same under `prisma dev`. Every project created is destroyed.
- The records, guide and skill of section 7 match the code.
- The project spec's "Done when" holds in full, so the project's close-out can start.

## 11. Alternatives considered

- **Decode only, with no validator; let the service's own schema check the value.** Rejected: a constraint the app's author wrote on the variable, such as `number > 0`, would be ignored without a word whenever the module's field is looser.
- **Refuse any difference between the input and output forms.** Rejected: Zod's output form for every plain object adds `additionalProperties: false`, so every Zod object would be refused as a transform.
- **Detect every transform.** Impossible: `z.string().trim()` and `z.coerce.number()` emit the same JSON Schema as the type without them. The guide says they do not run.
- **Keep the library's JSON Schema whole and remove five annotation keywords.** Rejected: a library's metadata adds keys of its own, which would reach a variable on the platform, and a walk that removes a key by name at every depth removes properties with that name.
- **Print a failure's location only when it exists in the schema.** Rejected: a value's key named like a keyword passes that test, and a real location behind a `$ref` fails it.
- **Decode by trying JSON first; decode a mixed schema as text; a fixed vocabulary of types; run the library's schema at boot.** Rejected in the project design, section 15.
- **A validator that compiles schemas to code,** such as Ajv. Rejected: it uses `new Function`, which a runtime policy can forbid.
- **Trim the text under a text-only schema.** Rejected: it changes a value nobody asked to change.

## 12. Departures from the project design

`design.md` is amended in this pull request so the two agree.

- **Annotations are removed at construction, not when the marker is written,** and the schema is reduced to the validator's keywords, with `$defs` renamed. The design kept the library's input form in `props`. Reason: a description or an unrelated edit would otherwise change the node.
- **The transform check allows one difference,** Zod's `additionalProperties: false` on an output object. The design refused any difference.
- **A failure's location is the validator's path through the schema,** with the one value-built location skipped. The design said "the failing keyword and its location, such as `minimum at /`".
- **The constructor also refuses a reference it cannot follow and a pattern the validator cannot compile.** The design did not name either.
- **A wrapped field may hold an object or an array.** The design's examples bind only text and a number, and the records said a wrapped field is a leaf.

## 13. References

- [Standard JSON Schema](https://standardschema.dev/json-schema).
- The spike and the reviewers' probes: `wip/s4/` (not committed). Their results are in 5.2, 5.4, 5.6 and 5.8.
