# ADR-0064: An app declares its platform variables as nodes in its root, and the deploy copies no local values to them

Amended by [ADR-0067](ADR-0067-prisma-dev-converges-in-a-worker-thread.md): under `prisma dev` the text of each plain platform variable (`plainVariableText`) and the named secrets reach the local target in memory, through the worker thread that runs each converge, not through the app configuration file or `PRISMA_COMPOSER_NAMED_SECRETS`. The comparison of platform variable reads on a rebuild runs in that worker, against the app as edited, which lifts the limit this record first stated for an edit to the app's own modules.

```ts
// module.ts
import { appRoot } from '@prisma/composer';
import { variable } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

export default appRoot('shop', ({ provision }) => {
  const from = provision(variable({ name: 'EMAIL_FROM' }));
  const smtpPort = provision(variable({ name: 'SMTP_PORT', schema: type('number') }));
  const apiKey = provision(variable.secret({ name: 'EMAIL_API_KEY' }));
  provision(emailService(), { input: { from, smtpPort, apiKey } });
});
```

```sh
$ prisma deploy --environment staging
✔ check environment variables
Platform variables with no value:
  - EMAIL_API_KEY  (read by service "shop.email", field "apiKey")
    prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview
    prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --branch 'staging'
```

## Decision

A **platform variable** is a variable on the platform that a service reads by name at boot. The app declares each one with a **platform variable node** in its root: `variable({ name })` for a plain value, `variable.secret({ name })` for a **platform secret**, both from `@prisma/composer-prisma-cloud`. A plain variable may also declare what its text holds: `variable({ name, schema })` takes a schema from any library that implements [Standard JSON Schema](https://standardschema.dev/json-schema), such as ArkType or Zod. The value is then typed by the schema, and boot decodes the text and validates it against the schema's JSON Schema before the service's own schema sees it. `provision()` returns the value, and the root passes it down through module inputs to the services that read it. The loaded graph lists every node and, for each service, the variables it reads, without deploying.

The deploy does not copy a platform variable's value from the developer's local environment: the `secrets` and `config` adapters, by default `.env` files and the shell. An implicit copy can push a local value into a remote environment by accident. For now the operator sets each value on Prisma Cloud with `prisma project env add`, and the deploy creates, changes and deletes no platform variable. Preflight checks only that every variable a service needs has a value. This is not a rule that the deploy may never set a variable. An explicit way to set variables through `deploy`, where the operator says which values go to which environment, is expected later (see Future work).

Destroying the production environment removes the Project, and with it every variable on the platform set on it. Composer records which service reads which variable, checks at deploy that every variable a service needs has a value, lists the ones with none, and reads the value only inside the running service. The rows Composer does write are its own: the `COMPOSER_…` rows of each service. Those are variables on the platform, not platform variables: an app cannot declare a platform variable with a `COMPOSER_` name.

### Two ways to get a value

A value the operator supplies reaches the app in exactly two ways:

- **A value the deploy reads** is a field of the app root's `input`, a **root input field**. The `config` adapters fill it when the deploy runs ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). It is the only kind of value a `resolve()` can list or a resource's props can hold.
- **A value the service reads at boot** is a platform variable node, provisioned in the app root. Its value is known only at boot, so the deploy writes a pointer to the variable, never its text.

The environment's facts, such as `environment.name`, and the values Composer creates for its own use, through `generatedParam()` and `serviceOrigin()`, are neither.

### What Prisma Cloud does

- **A variable is a row in a project.** A row has `projectId`, `class` (`production` or `preview`), an optional `branchId`, a `key` and a `value`. A row with no `branchId` is the class's shared value. A row with one is that preview branch's override. Prisma Cloud calls these rows environment variables.
- **A deployment receives the rows of its class, with its branch's overrides on top.** A **scope** is a level at which a row can be set and at which a reader looks it up. Today there are two: the class and the branch. When a name has a row at both, the more local one, the branch row, wins. The platform copies the rows into the deployment when it creates it and never reads them again, so a value set later reaches a service only at its next deployment. A third scope, the service, holds values stored on one service and wins over both; Composer sends its own `COMPOSER_` keys there ([ADR-0069](ADR-0069-a-services-composer-keys-travel-with-its-deployment-as-service-variables.md)), and preflight does not look there. Every deployment receives every row of its class, its own and other services' alike. The list filter accepts only `projectId`, `class`, `key` and `branchId`.
- **A key is upper case or it does not exist.** The platform refuses a key that does not match `[A-Z_][A-Z0-9_]*`, on write and in the list filter.
- **A value is never empty.** The platform refuses an empty value, so a variable is either present with text or absent.
- **A read returns metadata, never a value.** It returns `updatedAt`, and `isManagedBySystem` for a row the platform owns.
- **The operator sets a row with the `prisma` CLI.** `prisma project env add 'NAME=<value>' --project <id> --role production` sets the production row. `--role preview` sets the preview-wide row that every preview branch shares. `--branch <environment>` sets one branch's override. `update`, `list` and `delete` take the same scopes.
- **A process that exits at boot is reported running.** The deployment is started and promoted as soon as it is created. The platform reports it `running`, `prisma deploy` succeeds, and the crashing deployment is promoted. The other services in the same deploy are promoted as usual. The platform does not restart the process on its own: each request to the service boots it once and gets a 502. The boot error is only in the logs: `prisma service logs <service> --project <id>`, or `GET /v1/deployments/{id}/logs?from_start=true` in the Management API.
- **A deployment read lists the names it received.** `GET /v1/deployments/{id}` returns `envVars`, the names of the variables on that deployment with their values redacted. It shows what a deployment received without reading its logs.
- **Variables belong to a project.** There are no workspace-wide variables: every row belongs to one project.
- **The environment-variable endpoints are experimental.** The Management API SDK marks every one of them so. For platform variables, a change to these endpoints is a change to preflight, the only part of Composer that reads them. Composer's own `COMPOSER_…` rows are written through them too.

### The node

- **The constructors.** `variable` is a function with a `secret` property. `variable({ name })` returns a value resource whose value is a plain source, typed `PlainVariableValue<string>`, which is `ParamSource<PlatformVariablePayload> & RuntimeValue<string>`. `variable({ name, schema })`, where `schema` is a `StandardJSONSchemaV1` from `@standard-schema/spec`, returns `PlainVariableValue<T>`, where `T` is the schema's output type. `variable.secret({ name })` returns a value resource whose value is a secret source, typed `SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString>`. All are core value resources ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)) of type `platform-variable`. Their `props` are `{ name, secret }`, plus `schema` for a plain variable that has one. The payload, `PlatformVariablePayload`, carries the same members; the serializer, preflight and `prisma dev` read the name and the schema from it.
- **Root only.** Only an `appRoot()` body can provision one. In a `module()` body the call does not compile, and the error names `appRoot()`. An app that names a platform variable therefore has an `appRoot()` root.
- **The value.** `provision(variable({ name: 'EMAIL_FROM' }))` returns the value with `id`, the node's address, on it. A plain value fits a `field()` field of a service's or a module's input whose inner schema takes its type: `field(type('number'))` takes a variable declared `schema: type('number')`, and `field(type('string'))` takes a variable with no schema. An object schema fits a `field()` of the same object type. A secret value fits a `secretString()` field only. The value goes nowhere but a field of an input: a plain value in a secret field, a secret value in a `field()`, and any node value in per-key params do not compile. The source's label is `the platform variable "NAME"` or `the platform secret "NAME"`, and core's messages print it where they name a source.
- **The default id** is the variable's name in camel case: split on `_`, drop empty parts, lower-case each part, and capitalise each part after the first. `EMAIL_FROM` gives `emailFrom`, `SMTP_PORT` gives `smtpPort`, `EMAIL_2FA` gives `email2fa`. An explicit id goes on `provision(node, { id })`. Two names that give one id fail Load's duplicate-id error, which names both nodes. With the default id, changing `name` changes the node's address, so it is a different node; nothing is lost, because the node creates nothing on the platform. With an explicit id, changing `name` changes the node's `props`, and the address stays.
- **It creates nothing.** The target registers a descriptor for `platform-variable` in `prismaCloud().nodes`, and the deploy walk looks it up like every other node ([ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md)). Its lowering creates nothing and writes no row. The application topology sent to Prisma Cloud leaves it out: the platform has no node kind for it, and Composer owns nothing it names. The deploy report has no line for it, because a line would read as something Composer deployed.
- **Where its value may go.** The compiler refuses a node value in a `resolve()` dependency, in a plain field (a schema member written without `field()`), in a field of the other secrecy, and in a service's per-key params, whose binding type admits no source. Load refuses a `resolve()` dependency and a resource's props at run time, and a source a cast gets into a per-key param, with `Service "<address>" binds its param "<name>" to <label of the source>, a value known only at boot. A param takes a literal or a value the deploy has. Bind the value to a field of the service's input instead.` A plain field reached through a cast is refused by the service's own schema at serialize or preflight, and the error ends with `The field "<path>" reads the platform variable "<NAME>".`

### Names

`variable()` and `variable.secret()` check the name they are given when the root's body runs, and fail with a message naming the requirement.

- A name matches `^[A-Z][A-Z0-9_]*$`: an upper-case letter, then upper-case letters, digits and underscores. The platform also accepts a leading underscore; Composer refuses it (see Reasoning).
- These names are reserved: any name starting with `COMPOSER_`, which are Composer's own variables on the platform; `DATABASE_URL` and `DATABASE_URL_POOLED`, which Prisma Cloud sets and manages; `PORT`, which boot sets to the service's port; `PATH` and `HOME`, which `prisma dev` sets from the developer's shell. `HOST` is allowed, because boot sets `HOST` only when the environment has none, so a `HOST` row on the platform reaches the service unchanged.

### A typed platform variable

A variable on the platform holds text. Without `schema`, a plain platform variable's value is its text, exactly. With `schema`, the text is read by one fixed rule that the variable's JSON Schema decides, and the value is validated against that JSON Schema at boot.

#### The schema option

- `schema` may be an object or a function; an ArkType schema is a function. A schema with no `~standard.jsonSchema` does not compile, and through a cast it fails when the root's body runs: `The schema of the platform variable "SMTP_PORT" does not implement Standard JSON Schema. Use a schema from a library that does, such as ArkType or Zod.`
- `variable.secret()` takes no schema. Passing one does not compile, and through a cast it fails when the root's body runs: `variable.secret({ name: "API_KEY" }) takes no schema. A platform secret's value arrives as text in a secret box.`
- The constructor calls `schema['~standard'].jsonSchema.input({ target: 'draft-2020-12' })` and then `.output({ target: 'draft-2020-12' })`, each once; when `.input()` throws, `.output()` is not called. It never calls the library's `validate`, because the app's module code is not in the service: the library's schema cannot run on the value.

#### The variable's JSON Schema

The constructor reads each of the two JSON Schemas the library emits in one walk. The walk refuses the references, keywords and patterns listed under "What the constructor refuses" below as it goes, so each is found before anything is removed. It keeps only the keywords of draft 2020-12 that validate. JSON Schema treats every other keyword as an annotation, so nothing that validates is lost. The walk follows this table and nothing else, so a property named `title` or `default` is kept, and so is everything inside a `const` or an `enum`:

| Keywords | Their value |
| --- | --- |
| `not`, `if`, `then`, `else`, `items`, `contains`, `additionalProperties`, `unevaluatedProperties`, `unevaluatedItems`, `propertyNames` | one schema, walked |
| `allOf`, `anyOf`, `oneOf`, `prefixItems` | a list of schemas, each walked |
| `properties`, `patternProperties`, `$defs`, `dependentSchemas` | a map from a name to a schema; the names are kept, each schema walked |
| `type`, `const`, `enum`, `required`, `dependentRequired`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minLength`, `maxLength`, `pattern`, `format`, `minItems`, `maxItems`, `uniqueItems`, `minContains`, `maxContains`, `minProperties`, `maxProperties`, `$ref` | kept as it is |
| every other keyword, including `$schema`, `title`, `description`, `examples`, `default`, `$comment`, `deprecated` and whatever a library's metadata adds | removed |

A schema that is the boolean `true` or `false` is kept where it is a member of the table's first three rows.

Then the `$defs` are renamed. ArkType names them with a counter that depends on what else the process created, so the same type can emit `intersection215` and later `intersection232`. The constructor renames each top-level `$defs` entry to `d0`, `d1` and so on, in the order a depth-first walk from the top first reaches a `$ref` to it. The walk visits an object's members in the table's order, the entries of a map by sorted name, and `$ref` last. It rewrites each `$ref`, and removes every entry the walk did not reach, and every `$defs` below the top level, which no accepted reference can name. In `#/$defs/<name>`, `<name>` is everything after `#/$defs/`, looked up as an own key of `$defs`. One function in `@internal/input-document`, `resolveSchemaRef()`, holds this rule, and the constructor, the kind rule and the boot message all use it.

The reduced input form is the **variable's JSON Schema**. The node keeps it in `props.schema`, and the payload in `schema`. So a changed type is a changed node, and a changed description, or an unrelated edit elsewhere in the app, is not. A `default` in the variable's schema has no effect; a default belongs on the service's field, whose schema runs at boot.

#### The three kinds

One function, `schemaKind()` in `@internal/input-document`, decides the kind of a JSON Schema from its top level. The constructor, boot and the dev preflight all call it. Wherever the rule looks at a schema that has a `$ref`, it looks at the schema the `$ref` names instead, and ignores the keywords beside it. A `$ref` already followed on the way down, or one that names nothing, makes the schema mixed.

- **Text-only** when `type` is `"string"` or `["string"]`; or `const` is a string; or `enum` is non-empty and holds only strings; or it is an `anyOf` or `oneOf` whose every member is text-only; or it is an `allOf` with at least one text-only member.
- **Never-text** when `type` is one of `number`, `integer`, `boolean`, `object`, `array`, `null`, or a list without `string`; or `const` is not a string; or `enum` is non-empty and holds no string; or it is an `anyOf` or `oneOf` whose every member is never-text; or it is an `allOf` with at least one never-text member.
- **Mixed** when neither rule holds, or both do. That includes an empty schema, a boolean schema, a `not`, `type: "number"` with a string `const`, and an `allOf` with both kinds.

`number | null` is never-text, and the text `null` gives `null`.

#### What the constructor refuses

Each refusal happens when the root's body runs, and names the variable.

| Case | Message |
| --- | --- |
| The library throws from `.input()` or `.output()` | `The schema of the platform variable "SMTP_PORT" cannot be written as JSON Schema: <the library's message>. Declare the type the text holds, and put any other check in the service's own schema.` The library's message is printed with each run of whitespace made one space, because ArkType's spans several lines. |
| The reduced input and output forms differ | `The schema of the platform variable "SMTP_PORT" gives a different type from the one it takes. No code runs on a platform variable's value, so a transform or a default cannot apply. Declare the type the text holds, such as type('number'), and put a default on the service's field.` |
| A mixed schema | `The schema of the platform variable "SMTP_PORT" accepts both text and other values, or neither, so Composer cannot tell how to read the variable's text. Declare a text type, or a type that is never text.` When the schema is a top-level `anyOf` or `oneOf` of text-only members and `null`, the message adds: `A variable on the platform cannot hold null as text: declare the text type and make the service's field optional.` |
| A `$ref`, at any depth, that is not `#` or `#/$defs/<name>` with an existing name; or a `$dynamicRef`, `$dynamicAnchor`, `$anchor` or `$id` anywhere | `The schema of the platform variable "SMTP_PORT" refers to "<ref>", which Composer cannot follow. It reads only references to the schema's own $defs.` For the four keywords, `<ref>` is the keyword's value. |
| A keyword of an older draft that the validator still reads (`dependencies`, `additionalItems`, `$recursiveRef`, `$recursiveAnchor`, or `items` as a list), or a keyword of the table whose value has the wrong shape, at any schema position. A `const` or an `enum` member that is not plain JSON data is a wrong shape. | `The schema of the platform variable "SMTP_PORT" uses "<keyword>" in a form that is not JSON Schema draft 2020-12, which is the form Composer reads.` |
| A `pattern`, or a `patternProperties` name, that is not a valid regular expression under the `u` flag, which is how the validator compiles it | `The schema of the platform variable "SMTP_PORT" holds the pattern "<pattern>", which is not valid as a Unicode regular expression: <the engine's message>. Rewrite it; an escape such as \- outside a character class is the usual cause.` |

**Comparing the two forms.** The comparison is deep equality of the two reduced forms, with the members of an object compared whatever their order and the members of a list in order. One difference is allowed, at a schema position only: `additionalProperties: false` in the output form where the input form has no `additionalProperties`. Zod writes that for every `z.object()`, and ArkType for `'+': 'delete'`. In the library, such an object drops the keys it does not declare. That removal does not run on a platform variable's value, so an undeclared key reaches the service's field, whose own schema decides.

The library's message in the first row and the engine's in the last are about the author's own schema, read at Load on the author's machine. Neither can hold a variable's value.

### The graph check

`ExtensionDescriptor` has an optional `checkGraph(graph)`. The CLI calls every extension's `checkGraph` right after Load and before the registry coverage check. So it runs in `prisma deploy`, in `prisma dev` at start and at every rebuild, and in `destroy`. A command that reads only the app's name, such as `log`, does not run Load and does not run the check. A check refuses a graph by throwing core's `GraphCheckError`, which fails the command with `COMPOSE.GRAPH_INVALID` and its message, before anything is created and before any dev service starts. Any other throw from the hook is a bug and reaches the user as one ([ADR-0044](ADR-0044-errors-are-structural-envelopes-with-dotted-namespace-codes.md)). The check sees the loaded graph only, never the app configuration or the app secrets.

The platform variable nodes are the value resources in `graph.nodes` whose extension is Prisma Cloud's and whose type is `platform-variable`. Prisma Cloud's check holds three requirements, and each error names the variable and every address involved:

1. **One node per name.** Two platform variable nodes with one variable name fail, whatever their ids, and whether each is plain or secret: `The platform variable "EMAIL_FROM" is declared twice in the app root, by "shop.emailFrom" and "shop.sender". Declare each platform variable once and pass its value to every module that needs it.` With three or more it says how many and names every one. When the nodes are not all plain or all secret, it adds which are which. Two nodes with one name and the default id get one id, so Load's duplicate-id error fires first.
2. **One name has one meaning.** A name is either a value the service reads at boot or a value the deploy reads. A plain node and a root input field with one name fail: `"EMAIL_FROM" is used two ways: as the platform variable "shop.emailFrom", which services read at boot, and as input.EMAIL_FROM of root module "shop", which the deploy reads. A name has one meaning in an app. Use one of them, or give the other a different name.` A secret node and a root input field with one name are refused by core's check of a root input field against a secret, in Load, also when no service reads the node ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). Both checks see only the root input fields the root's body passes on, because Composer cannot list a schema's keys.
3. **Not a service's whole input.** A node value bound as a service's whole input fails: `The platform variable "EMAIL_FROM" is bound as the whole input of service "shop.email.service". Bind it to one field of the input instead.` The check reads it from `graph.valueReads`.

### The input document

Each place in a service's input document that reads a platform variable holds a `$platform` marker. On Prisma Cloud the document travels in the service's artifact ([ADR-0065](ADR-0065-a-compute-services-input-document-travels-in-its-artifact.md)), so the marker and its schema travel with it:

```json
{
  "from": { "$platform": { "name": "EMAIL_FROM" } },
  "smtpPort": { "$platform": { "name": "SMTP_PORT", "schema": { "type": "number" } } },
  "apiKey": { "$platform": { "name": "EMAIL_API_KEY", "secret": true } }
}
```

- `name` is the variable. `secret` is `true` for a platform secret. `schema` is the variable's JSON Schema, for a plain variable declared with one.
- A marker with both `secret` and `schema`, or whose `schema` is not an object or is mixed, is malformed, and is refused with the malformed-marker message wherever a document is read.
- Two fields that read one variable each hold the full marker.
- The serializer writes a marker for every platform variable value, plain or secret, in place in the binding. It refuses any other param source except `generatedParam()` and `serviceOrigin()`, naming the platform variable nodes as the fix. It reads nothing from the app configuration.
- A `$generated` marker names a variable Composer writes itself, for `generatedParam()` and `serviceOrigin()`. Two `$generated` markers in one document must name different variables, compared without case. Two `$platform` markers for one name are two reads of one variable and are allowed.
- A user key spelled like a marker (`$platform` or `$generated`) gains one leading `$` when written and loses it when read, so only Composer can place a marker.
- A change to the marker format needs no reader for older documents. The input document and the code that reads it at boot ship in the same deployment, from the same installed package.
- The deploy report shows each marker as `$platform NAME` or `$generated NAME`. A marker with a schema shows a word in brackets, such as `$platform SMTP_PORT (number)`. The word is the top-level `type` when it is a string; its members joined with ` | ` when it is a list; otherwise `text` for a text-only schema and `json` for a never-text one.
- The marker format, the code that finds every marker at any depth, boot's handling of a marker, the kind rule, decoding and validating with their messages, and the names of Composer's own `COMPOSER_…` rows live in one package, `@internal/input-document`. The serializer, boot, the dev preflight and the local target all use it.

### Per-key params read no variable

A service's per-key param takes a literal or a deploy-time value, and no source ([ADR-0032](ADR-0032-params-bind-at-provision-to-a-literal-or-a-deploy-time-value.md)). A compute service declares one per-key param, the reserved `port`, and the deploy needs its number before the service exists, to set the deployment's port mapping. So no param row names a platform variable, and preflight, boot and `prisma dev` read platform variables from input documents only.

### Boot

`service.input()` reads the input document in four steps:

1. **A marker whose variable has no value** leaves its key out of its object. No value means `process.env[name]` is undefined or empty. A marker in an array position cannot be left out: boot fails, naming the variable and the path.
2. **A marker with `secret: true`** puts the text in a secret box.
3. **A plain marker** takes the text, decoded and validated by its schema when it has one, as below. The value is never searched for markers.
4. **The service's schema validates the whole object.** When it fails and step 1 left out at least one variable, the error ends with `(platform variables with no value: X, Y)`.

Empty means unset everywhere: at boot and under `prisma dev`.

### Decoding and validating

`readVariableText(name, text, schema)` in `@internal/input-document` holds the decoding rule, the validator call and the messages. Boot and the dev preflight call it, and a local service runs it at its own boot.

1. **No schema, or a text-only schema:** the value is the text, exactly, with nothing trimmed.
2. **A never-text schema:** the text is parsed as JSON, as `JSON.parse` reads it: surrounding whitespace is allowed, the last of two equal keys wins, and a key named `__proto__` is an ordinary key. Text that is not JSON fails. A parsed value nested more than 100 levels deep fails with the fourth message below. The limit is fixed and checked with a loop, not recursion, because runtimes differ in how deep they can recurse, and `prisma dev` and boot must agree: the validator recurses on each level, and on a recursive schema it fails on Node from about 150 levels, while Bun goes past 1,000. The limit makes the two agree for the recursive schemas ArkType and Zod emit. A hand-written recursive schema that nests several combinators, such as `allOf` wrappers, on each level uses more stack per level, so on Node it can still fail within 100 levels while Bun validates it; `prisma dev` then refuses a text that boot accepts. A parsed number, at any depth, that is not finite, or is a whole number outside the safe range, fails, because `JSON.parse` rounds the second silently and reads `1e400` as infinity.
3. **With a schema, the value is validated** against the variable's JSON Schema, as draft 2020-12, with `format` checked for the formats the validator knows and ignored for the others.

The messages. `<expected>` and `<example>` come from the top-level `type`, after following a top-level `$ref`: `a number` and `587` for `number` or `integer`; `true or false` and `true` for `boolean`; `an object` and `{"key":"value"}`; `an array` and `[1,2]`; `null` and `null`. For anything else `<expected>` is `JSON`, and the sentence ends at `must be JSON.`

| Case | Message |
| --- | --- |
| The text is not JSON | `The platform variable "SMTP_PORT" does not hold <expected>. Its schema is not a text type, so its text must be JSON, such as <example>.` |
| A number that is not finite or not safe | `The platform variable "ORDER_ID" holds a number outside the range Composer reads exactly, which is whole numbers up to 9007199254740991. Declare it as text and keep it as text in the service.` |
| The value does not fit the schema | `The platform variable "SMTP_PORT" does not fit its schema: it fails "minimum" at #/minimum.` |
| A value nested more than 100 levels deep, or the parser or the validator throws anything else | `The platform variable "SMTP_PORT" could not be checked against its schema.` |

**Which failure the third message names.** The validator runs with its short-circuit option on, and returns a list in which a failure is followed by the failures inside it. First every failure whose keyword the validator reports as `false` is removed: such a failure's location is built from the value's own key or index, not from the schema. It arises for `additionalProperties`, `unevaluatedProperties`, `items` and `unevaluatedItems` set to `false`, and for a `contains` with `minContains` whose items fail a `false` schema, which the validator lists with no wrapping failure, sometimes first in the list. The message then starts at the first failure left and moves to the next failure in the list while that failure's schema location is the current one's followed by `/`. It stops when there is none, or when the current keyword is `anyOf`, `oneOf`, `not` or `if`. The location is printed as the validator gives it: its path through the schema, such as `#/$ref/properties/port/minimum`. One exception: the validator misspells the location of a `dependentRequired` failure as `…/dependantRequired`, and Composer prints `…/dependentRequired`, the keyword's place in the schema. A `patternProperties` location holds the schema's pattern percent-encoded; it comes from the schema.

No message holds the text, a part of it, a key of it, the parser's message or the validator's message. No redaction runs at boot on the platform, so the message itself must leave the value out. A failure fails `service.input()`, so the process exits and the error is in `prisma service logs <service>`. The deploy still succeeds, as for every boot failure.

### The validator and how it ships

The validator is `@cfworker/json-schema` 4.1.6, checked against the JSON Schemas ArkType 2.2.7 and Zod 4.4.3 emit.

- It validates draft 2020-12. It has no dependencies, generates no code (`new Function` and `eval` do not occur in it), and uses no Node or Bun API.
- A `$ref` to `#` and into `$defs` resolves, including a recursive type. An unresolved `$ref` throws only when validation reaches it, and it ignores `$dynamicRef`; that is why the constructor refuses both.
- It compiles `pattern` with the `u` flag when it validates, and throws for a pattern that flag refuses; that is why the constructor compiles each one.
- It checks these formats: `date`, `time`, `date-time`, `duration`, `uri`, `uri-reference`, `uri-template`, `url`, `email`, `hostname`, `ipv4`, `ipv6`, `regex`, `uuid`, `json-pointer`, `json-pointer-uri-fragment` and `relative-json-pointer`. It accepts any value under any other format.
- Its messages can quote the value (`0 is less than 1.`), so Composer uses only each failure's keyword and location.
- It defines hidden properties on the schema object it is given, so Composer hands it a copy.
- It recurses once per level of a value it validates, and Node's stack is smaller than Bun's.
- It reports a failed `dependentRequired` at `…/dependantRequired`, a misspelling.

The validator must be present wherever `@internal/input-document` runs at boot. `@internal/input-document` depends on it. `@prisma/composer-prisma-cloud` and each self-contained shared-module entrypoint (auth, cron, storage, email, streams) inline it, as they inline `@internal/input-document` itself. `@internal/input-document` owns the list of its own runtime dependencies, `inputDocumentRuntimeDependencies`, in a source-only subpath, `@internal/input-document/bundling`, which a tsdown config can import before any package is built. Every build pass that inlines `@internal/*` lists that constant beside `/^@internal\//`, so the validator is named in one place, in the package that depends on it. A test in `@prisma/composer-prisma-cloud` finds every built `*-entrypoint.mjs` and fails if any of them, or any built file of that package, imports either package.

### Deploy preflight

Preflight runs after the deploy has resolved the app's Project and Branch, and before Alchemy runs. It writes no variable and reads no value.

- **The names it checks.** Every platform variable, plain or secret, in a service's input binding, at any depth, found from the same walk of each binding, without serializing the service; and every platform variable node no service reads, which are the value resources not in `graph.valueReads`. An invalid input still fails after preflight reports the platform variables. The deploy preflight reads nothing from the app configuration.
- **One list call per name.** The call is filtered by `projectId`, `class` and `key`, and walks every page. The class is `production` for the environment `production` and `preview` for every other. The environment sees the class row, and for a preview environment its own branch's row. At most eight calls run at once. A failed call fails the deploy, because the deployment triggers need each row's `updatedAt`.
- **The row the platform resolves.** The branch row wins when there is one, otherwise the class row. Preflight keeps that row's `updatedAt`. A change to a class row under a branch override changes nothing the service receives, so it triggers nothing.
- **A system row is refused.** A row the environment sees with `isManagedBySystem: true` fails the deploy, naming the variable.
- **Required or reported, per service.** For each service that reads a variable with no row, preflight serialises the input with every variable present and runs the service's schema. A failure there is an invalid input, reported as such and never blamed on a variable. Then it runs the schema with every variable that has no row left out. If that passes, those variables are optional for that service. If it fails, it leaves out each one alone, and the ones whose absence alone fails are required. When no single one fails alone, the error says the service needs at least one of them. A variable an array position reads is required without a check. This is the method [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md) gives the dev preflight, and both preflights call the same code.
- **A node no service reads** has no reader to need it. It is reported once, named by its node, `named by resource "shop.emailFrom", read by no service`, and never required. That includes a secret node that a module receives and no service reads.
- **A required variable fails the deploy** with `DEPLOY.PREFLIGHT_FAILED`, before Alchemy runs:

  ```text
  Deploy failed. 1 platform variable a service needs has no value:
    - EMAIL_API_KEY  (read by service "shop.email", field "apiKey")

  Set it on the platform, then deploy again:
    - prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --role preview
    - prisma project env add 'EMAIL_API_KEY=<value>' --project 'proj_…' --branch 'staging'
  ```

  For production the one command is `--role production`. For every other environment the preview-wide command comes first, so the next preview branch is not missing it too, and the branch command second. A variable that an array position makes required has a second line with the reason, and a line for a service that needs some of several variables ends with the schema's message.
- **The findings.** Every variable with no row that nothing requires is listed, with its readers (a service and field, or the node that names it and that no service reads it) and the commands that set it. `PreflightInput.report` takes a `PlatformVariableCheck`: the count of platform variables checked and this list, names and readers only, never a value. It carries platform-variable findings and that count, nothing else. The deploy prints the list right after the preflight step, under `Platform variables with no value:`. With `--json` it is a message whose data holds the list, and `onEvent` receives it as a `preflight-findings` event. The step's data stays `{ checked, unset }`, two counts. The deploy hands the list to `lower()` as a value, `LowerOptions.findings`, and lowering puts it into `DeploymentResult.findings`; `prisma deploy` repeats it at the end of its report ([ADR-0066](ADR-0066-deploy-runs-alchemy-in-process.md)). An extension's own preflight payload never carries it.
- **Triggers.** Each service's deployment triggers carry `<name>:updatedAt` for each platform variable its input document points at, with `?` when the variable has no row. Changing a value on the platform and deploying again replaces exactly the deployments that read it.

### `prisma dev`

The local target plays the platform's part.

- **A plain platform variable comes from the app configuration.** The target's dev preflight runs in the first process. For each plain node a service reads, found in `graph.valueReads`, it reads the app configuration under the variable's name, once. A text value goes into `plainVariableText`, which `prisma dev` writes into the app configuration file for the second process, and counts toward its readers' fingerprints, so a changed value restarts only its readers. A value that is not text stops `prisma dev` before any service starts: ``The `config` adapters return a number for "SMTP_PORT", not text. prisma dev cannot start, because the platform variable "shop.smtpPort", which service "shop.mail.service" reads, takes text. Make the adapter return a string.``
- **A typed platform variable is decoded and validated before any service starts.** The dev preflight then calls `readVariableText` on each text, once per platform variable node. A failure stops `prisma dev` with the message boot would give, followed by one sentence naming the readers: `prisma dev cannot start, because service "shop.mail.service" reads it.`, or with several readers `because services "shop.mail" and "shop.digest" read it.` The local service decodes again at its own boot, through the same code, from the same text, because the input document its artifact carries keeps the marker's schema; a dev server reads the same document from its `COMPOSER_<ADDRESS>_INPUT` variable.
- **A platform secret comes from the app secrets.** The first process hands the second process the named secrets, the app secrets under the secrets keys of the graph's platform secrets, in `PRISMA_COMPOSER_NAMED_SECRETS`, in memory.
- **A missing value follows ADR-0058.** For a variable a service reads in its input, an unset or empty one is left out of the service's input document, and the schema decides: a required one, or one an array position reads, stops `prisma dev` before any service starts, naming it and the service.
- **Every plain value in the file is checked.** A member of `plainVariableText` that holds a known secret fails with `CONFIG.SECRET_AS_PLAIN_VALUE`, naming the platform variable and the secret, never the value.
- **It isolates.** A local service receives only the variables its own `$platform` markers name. This is a requirement of the local target only: on Prisma Cloud every deployment receives every row of its class.
- **A changed value pauses rebuilds** until `prisma dev` is restarted. After the restart, the deployment's `<name>:updatedAt` trigger replaces only the readers' deployments.
- **A change to what the app reads pauses rebuilds.** A rebuild runs no preflight, so the values and the list of unset variables come from the preflight at start, and a read the change adds would have neither. After a rebuild's Load, `prisma dev` compares two sets with those at start: one key per `valueReads` entry (reader, node and path), and each read node's address with its `props`. Order does not matter. A change to a node's schema changes its `props`, so it is a change too. If either set differs, `prisma dev` does not converge, emits the `value-reads-changed` event, and pauses rebuilds until it is restarted. The CLI prints it as a warning: `The platform variables the app reads changed since dev started: reads of "shop.smtpPort" were added, reads of "shop.emailFrom" were removed, and "shop.sender" was changed. Restart dev to apply them; rebuilds are paused until then.` A node whose reads were only added goes in the first clause, one whose reads were only removed in the second, and one whose `props` changed, or whose reads were both added and removed, in the third.
- **An edit to the app's own modules is seen.** Since [ADR-0067](ADR-0067-prisma-dev-converges-in-a-worker-thread.md), the comparison above runs in the worker thread of each converge, which loads the app as it is on disk, so it sees an edit to `module.ts`. Before that decision the first process compared the graph it loaded at start with itself, and saw no change.

## Reasoning

**A platform variable is a node.** A variable the operator sets is part of what an environment needs before the app can run. As a node, the graph lists it, with the services that read it, before anything is deployed, and every message can name it by its address.

**Only the root declares one.** A variable's name is one space per deployed app. A module below the root that named one would claim that name for every app and every instance that uses the module, and would hide from its input what it needs. The root is the app, so it is the one place whose scope matches that space. A module declares the value in its input and the root wires it down.

**The node says nothing about where its value is set.** Where a value lives is the operator's decision, made in the platform's own terms. Each reader receives the value the platform resolves for it under the variable's name, at whatever scopes the platform offers: today the class and the branch. Preflight is the only part of the deploy that looks up where a platform variable's value is set. If the platform adds a scope, such as a value set on one service, preflight's existence check gains a list call per reader, and nothing else in the deploy changes. `prisma dev` gives each name one value from local files, so two readers with two values under one name would also need a local source per reader.

**A secret is a fact about Composer and the service, not about the platform.** The platform encrypts every row and returns no value, so it handles a secret and a plain value alike. The difference matters in four places inside Composer. In a binding, a platform secret fits only a secret field and arrives boxed, while a plain value fits only a `field()` field. In output, Composer redacts a secret's value wherever it prints; it must not redact a plain value such as `587`. In boot errors, a plain value's expected form may be described, while a secret is never decoded, so a secret's error says nothing about its content. Under `prisma dev`, a platform secret comes from the app secrets and a plain variable from the app configuration. So the node says which kind it is, and the platform needs nothing for it.

**An implicit copy moves a local value to a remote environment.** A deploy that copies a missing variable from the app secrets or the app configuration to the platform can carry a developer's test key to production, because `.env` is read for every environment. Copying on each deploy also writes one override row per preview branch. Until the operator can say explicitly which value goes to which environment, the operator sets each value on the platform, in the scope the operator chooses.

**Preflight is the only protection against a missing value.** The platform promotes a deployment whose process exits at boot and reports it running. So a deploy that succeeded with a required variable unset would leave a crashing service in place. Preflight refuses the case it can see without a value: the service's own schema says the variable is needed.

**The schema decides, as a black box.** [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) forbids reading a schema's internals. Leaving variables out and calling `validate` asks the schema exactly whether it can do without them, with no value and no introspection.

**One call per name, not per scope.** The list filter by class and key already returns the class row and every branch row. Listing the whole class would also return every branch's overrides on a preview project, including `COMPOSER_` rows an older Composer wrote.

**Upper-case names.** The platform accepts no other key, and Composer compares pointer names without case while a process environment on Linux compares them with case. With upper-case names a row and a name never differ by case, so boot finds the row preflight saw.

**No leading underscore.** The platform accepts one; the requirement is Composer's. Shells and tools use names that start with an underscore for their own variables: bash puts `_` in the environment of every command it runs, and the Java virtual machine reads `_JAVA_OPTIONS`. Keeping those names out of the app's names means an app's variable never meets one of them.

**Empty means unset.** The platform cannot store an empty value. `prisma dev` treats empty as unset. Treating empty as unset at boot too makes the two agree.

**A schema says what the text means.** A variable on the platform holds text, so a service field typed `number` could not take a platform variable until the variable could say how its text is read. The schema's type also lets the compiler check the binding: `field(type('number'))` accepts a variable typed `number` and refuses one with no schema.

**The type travels as data.** The app's module code is not in the service, so the library's schema cannot run on the value at boot. The constructor turns the schema into plain JSON Schema once, and the deploy writes it into each reading service's input document. Reading the JSON Schema a library emits through a public standard, Standard JSON Schema, is not reading the library's schema: Composer reads what the library publishes, never its internals ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)).

**One rule decides how the text is read, from the schema alone.** A schema that accepts only text gives the text, and one that accepts no text reads JSON. A schema that accepts both is refused, because any choice would guess: `"587"` and `587` are both a valid reading of the text `587`.

**The value is validated before the service's schema sees it.** A constraint the app's author wrote on the variable, such as `number > 0`, would otherwise be ignored without a word whenever the module's field is looser.

**The reduction keeps the node stable.** Without it, a description or an unrelated edit, or ArkType's counter in `$defs` names, would change the node and redeploy every reader.

**No message holds the value.** Every message is built from the variable's name, the JSON Schema and the validator's path through the JSON Schema. The parser's and the validator's own messages can quote the value, so they are never printed.

**The graph check runs after Load.** A requirement that depends on more than one place in the graph cannot be checked in a constructor. Running it right after Load, in every command that runs Load, refuses a bad graph before preflight and before any dev service starts, without a deploy.

## Consequences

- A new environment needs its platform variables set first. For a new app, the first deploy creates the Project and Branch, then stops at preflight with the commands that set each required variable, including the project's id.
- Every new preview branch reads the preview-wide row.
- A deploy succeeds with an optional variable unset and lists it. Because the platform has no way to store "deliberately empty", the list also holds a variable whose absence is intended.
- A process that exits at boot for a reason preflight cannot see, such as a value that the schema refuses, is promoted. The guide names `prisma service logs <service>` as where the error is.
- Every service on Prisma Cloud sees every variable of its class. Composer records which service reads which variable in its graph and in each input document, so it can send that record if the platform ever takes one.
- Under `prisma dev` and on the platform, a service with an unset optional variable receives the same input: the field is absent. Dev's input document leaves the marker out; the deploy's document holds the marker, and boot leaves the key out.
- The deploy reads the app secrets only to redact the values under the graph's secrets keys wherever it prints.
- A schema's transform, default, refinement or removal of undeclared keys does not run on a platform variable's value. A transform or default the library can show in its JSON Schema is refused; one it cannot show, such as Zod's `.trim()` or `z.coerce`, is accepted and does not run. Such a check or change belongs in the service's own schema.
- A hand-written schema whose `$ref` contradicts the keywords beside it, such as `{ "$ref": "#/$defs/n", "type": "string" }` with `n` a number, is judged by its target, so it is accepted and fails every boot with "does not fit". Neither ArkType nor Zod emits such a schema.
- An input document repeats a variable's schema in every field that reads it. On Prisma Cloud the document travels in the service's artifact, not in a variable, so a variable's 8 KB limit does not apply to it ([ADR-0065](ADR-0065-a-compute-services-input-document-travels-in-its-artifact.md)).
- A test that needs to know which variable a binding reads finds the entry in `graph.valueReads`, takes the node at its `resource` from `graph.nodes`, and reads `props.name`.

## Alternatives considered

- **Copy local values on deploy.** Rejected: an implicit copy is how a local value reaches a remote environment by accident.
- **Succeed with every variable unset, and report.** Rejected: the platform promotes a service that exits at boot and reports it running, so the deploy would leave it crashing. Preflight refuses the case the schema can show without a value.
- **Two list calls per name, one per scope.** Rejected: one call filtered by class and key returns both.
- **The newest row's `updatedAt` as the trigger.** Rejected: a change to a class row under a branch override would redeploy a service whose value did not change.
- **A source with no node**, `envSecret('NAME')` and `envParam('NAME')`, written in any binding. Rejected: it leaves nothing for Load to list as a node and no address to name it by, and `envParam()` in an input binding gave a value the deploy reads a second spelling beside a root input field. Both are removed rather than kept as deprecated spellings, so there is one way to name a platform variable.
- **A platform variable as a property of an input field,** such as `field(type('number'), { env: 'SMTP_PORT' })`. Rejected: a value the operator must set is part of the topology, so it is a node.
- **A platform variable node anywhere in the tree.** Rejected: a nested module naming one claims the name for every app and instance, and hides from its input what it needs.
- **Two nodes for one name reconciled when they agree.** Rejected: with root-only nodes, two declarations of one name are two lines in one body, and refusing them is simpler.
- **The node declares its scope,** such as `variable({ name, scope: 'service' })`. Rejected: where a value lives is the operator's decision in the platform's terms, not the author's.
- **`provision()` returning `{ id, value }`.** Rejected: the value itself with `id` on it matches `generatedParam()` and `serviceOrigin()`, so a binding reads `{ from, apiKey }`.
- **Resource outputs as a new core concept, with Load asking the target for the pointer.** Rejected: core already has the source, which carries the secrets key that redaction and `prisma dev` need; "output" already means Alchemy's attributes and the retired name for the end of a connection; and Load calling a target would be core's first dependency on one.
- **No descriptor for the node**, with core skipping it in lowering and registry coverage. Rejected: it would add a special case to the one lookup every node goes through ([ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md)). The descriptor creates nothing instead.
- **A prefixed node type, `prisma-cloud/platform-variable`.** Rejected: the registry key already sits under the extension, and every key in `prismaCloud().nodes` is a bare name.
- **A platform variable in a service's per-key param**, written as a pointer row the service read at boot. Rejected: a compute service's one per-key param is `port`, which the deploy needs before the service exists, so the deploy would route to 3000 while the service read the variable, and the variable's text also fails `port`'s number schema at boot. Where a compute service's port is set is not decided.
- **Running the dev preflight on every rebuild**, so a change to what the app reads needs no restart. Deferred: it is a separate change to the dev loop.
- **Decode only, with no validator; let the service's own schema check the value.** Rejected: a constraint the app's author wrote on the variable, such as `number > 0`, would be ignored without a word whenever the module's field is looser.
- **Refuse any difference between the input and output forms.** Rejected: Zod's output form for every plain object adds `additionalProperties: false`, so every Zod object would be refused as a transform.
- **Detect every transform.** Impossible: `z.string().trim()` and `z.coerce.number()` emit the same JSON Schema as the type without them. The guide says they do not run.
- **Keep the library's JSON Schema whole and remove five annotation keywords.** Rejected: a library's metadata adds keys of its own, which would reach a variable on the platform, and a walk that removes a key by name at every depth removes properties with that name.
- **Print a failure's location only when it exists in the schema.** Rejected: a value's key named like a keyword passes that test, and a real location behind a `$ref` fails it.
- **Decode by trying JSON first, or decode a mixed schema as text.** Rejected: either guesses which reading the author meant.
- **A fixed vocabulary of types,** such as `variable({ name, type: 'number' })`. Rejected: it adds a type language beside the schema libraries the app already uses, and cannot say an object's shape.
- **Run the library's schema at boot.** Impossible: the app's module code is not in the service.
- **Let the platform validate the value.** Rejected: the platform stores text and is not expected to check it against a schema. Composer validates at boot and in `prisma dev`.
- **`parse` as the option's name.** Rejected: in ArkType and Zod, parsing means running a transform, which is exactly what the option refuses. The marker already calls it `schema`.
- **`schema` on a platform secret.** Not built: a secret box that holds something other than text is not defined. A platform secret binds to a `secretString()` field, which takes the box and does not check its text; checking a secret's content waits for a secret field that takes a schema for its content.
- **A validator that compiles schemas to code,** such as Ajv. Rejected: it uses `new Function`, which a runtime policy can forbid.
- **Trim the text under a text-only schema.** Rejected: it changes a value nobody asked to change.
- **"Subscription" as the word for a service reading a variable.** Rejected: it names a platform mechanism that does not exist, and reads as "receives updates as they happen", which is false.

## Future work

- **An explicit way to set platform variables through `deploy`.** The operator names the values and the environments they go to, and the deploy writes those rows. It needs its own design. It must not read local values implicitly.

## Related

- [ADR-0029](ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md): the secret.
- [ADR-0032](ADR-0032-params-bind-at-provision-to-a-literal-or-a-deploy-time-value.md): per-key params.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): service input and the input document.
- [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md): how `prisma dev` reads secrets and decides required or optional.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md): the value resource, root-only provisioning, the reads list, the app configuration and the app secrets.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md): one descriptor lookup for every node.
- [deploying.md](../../guides/deploying.md) and [deploy-cli.md](../10-domains/deploy-cli.md).
