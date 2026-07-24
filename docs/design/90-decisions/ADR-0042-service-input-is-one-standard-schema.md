# ADR-0042: Service input is one standard schema; the binding carries the sourcing

## Decision

A compute service declares its entire incoming configuration — plain values
and secrets together — as **one [Standard Schema](https://standardschema.dev)**
(Zod, ArkType, any conforming library), and reads it back through **one typed
accessor**. The `params`/`secrets` declaration maps and the
`config()`/`secrets()` accessor pair are replaced. `deps` and `origin()` are
untouched.

A service whose billing is optional looks like this:

```ts
// service.ts — the app declares what shapes are legal, in its own schema library
const chatInput = z.discriminatedUnion("stripeEnabled", [
  z.object({ stripeEnabled: z.literal(false) }),
  z.object({
    stripeEnabled: z.literal(true),
    stripeSecretKey: secretString(),      // a field typed SecretString
    stripeWebhookSecret: secretString(),
  }),
]);

export default compute({ name: "chat", input: chatInput, deps: { /* … */ } });
```

```ts
// module.ts — the operator binds where each value comes from
provision(chatService, {
  input: {
    stripeEnabled: true,
    stripeSecretKey: envSecret("STRIPE_SECRET_KEY"),
    stripeWebhookSecret: envSecret("STRIPE_WEBHOOK_SECRET"),
  },
});
```

```ts
// anywhere in the service — one call, one inferred type, narrowing included
const input = service.input();
if (input.stripeEnabled) stripe(input.stripeSecretKey.expose());
```

Fields whose values are secret are simply fields **typed** as the framework's
redacting `SecretString` box. `secretString()` is sugar for
`z.custom<SecretString>(isSecretString)` — every schema library can express
"must be an instance of X" natively, and the arktype spelling ships as
`@prisma/composer/arktype`, an opt-in entry point no other surface imports.
Secretness is enforced by validation, not annotated as metadata: binding a
plain literal where the schema expects a `SecretString` fails at deploy (a
credential almost landed in a plain config row), and binding `envSecret`
where the schema expects a string fails the same way.

## The mechanism: traverse the binding, validate with the schema

The framework never looks inside the schema. Standard Schema exposes exactly
one capability — `~standard.validate` — and deliberately excludes
introspection; a framework that walks Zod's or ArkType's internals is coupled
to those libraries' private representations. Instead, the two artifacts split
the work:

- **The binding is the traversable structure.** It is a plain object
  mirroring the schema's shape whose leaves are literals, `envParam(...)`,
  `envSecret(...)`, or `generatedParam(...)` markers (the source table in
  [`../10-domains/config-params.md`](../10-domains/config-params.md)). A dumb
  recursive descent over it yields everything provisioning needs: each
  `envSecret` leaf becomes an in-memory sentinel plus a `$secret` pointer to
  the operator's platform variable; each `generatedParam` leaf becomes a
  sentinel plus a `$generated` pointer to a framework-owned variable the
  deploy will fill, and is recorded for the descriptor's deploy step (§
  Generated sources); everything else becomes config data. **The walk itself
  creates no platform resource** — the sentinels live only long enough to be
  validated and then written into the document as pointers, so a binding the
  schema later rejects leaves nothing behind: validation runs before the one
  document row is written. An `envSecret` pointer names the operator's own
  variable, seeded by preflight; a `$generated` pointer names a variable the
  descriptor's deploy step provisions (that step, not this walk, is where a
  resource is created). The node graph itself is built from `deps`, which this
  ADR does not touch.
- **The schema is a black-box judge, invoked twice.** At deploy, the
  resolved binding — literals as-is, env params read from the deploy shell,
  each secret as an opaque `SecretString` sentinel, never the value — is
  passed to `validate`. `stripeEnabled: true` with a missing key fails right
  there, with the schema library's own error. At boot, the hydrated object
  is validated again before the app sees it. Validation is synchronous both
  times: a `validate` that returns a `Promise` (an async validator) is a
  loud error, not awaited — deploy and boot judge on data already in hand,
  so there is nothing to await. The typed object `service.input()` returns
  is the schema's inferred output; a schema that carries no Standard Schema
  type metadata still validates at runtime but is read as `unknown`.

**The wire format is one self-describing document.** The deploy serializes
the validated, defaults-applied object into a single env row
(`COMPOSER_<addr>_INPUT`, re-stashed address-free at boot like every other
row), with each secret leaf as a pointer naming the platform variable that
holds the value:

```json
{
  "stripeEnabled": true,
  "stripeSecretKey":     { "$secret": "STRIPE_SECRET_KEY" },
  "stripeWebhookSecret": { "$secret": "STRIPE_WEBHOOK_SECRET" }
}
```

At boot, `service.input()` reads that one well-known row, walks the document
(plain data again), replaces each `$secret` marker with a redacting box over
the named variable, validates, and returns the typed object. No name
reconstruction: the boot side cannot know the env-var names for a shape the
framework cannot see, so the deploy leaves behind a document that describes
itself. This is today's secret double-lookup (pointer row → platform
variable), consolidated into one document instead of scattered per-slot rows.
Secret values never appear in the document, so the deploy report can print it
verbatim.

The document is `JSON.stringify`d at deploy and re-parsed at boot, so the
schema's validated output must be JSON-representable: plain objects, arrays,
strings, numbers, booleans, and null, plus the framework's own `SecretString`
leaves (which serialize to `$secret` pointers). A schema whose output carries
`BigInt`, a `Date`, a class instance, or a symbol is outside the contract —
the two ends would not see byte-identical input. Schemas that need such a
value should keep the wire field a string and reconstruct it in the app.

**Absence is arbitrated by the schema.** An env-bound leaf whose variable is
unset (or empty) in the deploy shell resolves to *key omitted*; whether that
is legal is the schema's call — `.optional()`, a union arm, or a hard error.
This replaces any need for a framework-level "optional secret" flag: a
credential for an off-by-default feature is an ordinary optional
`SecretString` field. Because an omitted key can also be a typo'd variable
name, the deploy report prints every key that resolved absent.

### Generated sources

A fourth source, `generatedParam(...)`, is a param the **target generates at
deploy** rather than reads from the environment — a value with no external
holder to reference (an rpc service key, an instance signing key). It is a
config *param*, not a secret ([ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md)):
the framework produces it and keeps it in deploy state, stable across
redeploys. It rides the same walk as every other leaf, with three differences,
all consequences of "the framework produces and stores this value":

- **The pointer carries a redaction facet.** A generated leaf serializes to
  `{"$generated": "<VAR>", "redacted": <bool>}`, where `<VAR>` is a
  framework-owned variable name (reserved `COMPOSER_` prefix). It carries
  `redacted` because — unlike an `envSecret`, which is always redacted — a
  generated param may be either, and **boot cannot ask the schema** which:
  Standard Schema exposes only `validate`, never a field's type. So the deploy,
  which knows the facet, writes it into the self-describing document, and boot
  reads it from the pointer: a redacted leaf hydrates to a `SecretString`, a
  plain one to a string.
- **The descriptor's deploy step provisions the value.** The walk records each
  generated leaf; after it runs, the compute descriptor provisions one
  generation resource per leaf (which mints the value once and returns the same
  value on every later reconcile, so it is stable) and writes it to the named
  framework variable. Preflight skips generated leaves entirely — there is no
  operator variable to check.
- **The value never appears in the document, redacted or not** — only the
  pointer does, so the deploy report prints the document verbatim, exactly as
  for secrets. The difference from a secret is *where the value lives*: a
  secret's value is the operator's, injected by the platform and never in
  state; a generated param's value is the framework's, provisioned into deploy
  state. Redaction governs only whether that value is masked in logs.

A single collision check covers both pointer kinds: after the walk, every
`$secret` and `$generated` variable name on a service must be distinct once
normalized, or the deploy fails naming both input paths — so a secret and a
generated param can never quietly share a variable.

## Reasoning

**Configuration legality is relational, and the framework should not invent
a language for it.** Real services have inputs like "no `stripeSecretKey`
unless `stripeEnabled`" — conditionality that flat need-maps cannot state.
Schema libraries express this trivially (unions, refinements, optionality),
are already how applications describe incoming data, and give the app
type-level narrowing for free. Per the don't-reinvent-the-wheel principle,
the framework adopts them rather than growing its own conditional DSL — and
per the no-guessing rule, everything the framework itself consumes (the
binding, the document) is its own explicit, walkable data.

**Splitting shape from sourcing puts each fact where it is authored.** What
combinations are legal is the service author's knowledge — it lives in the
schema, versioned with the code that consumes it. Where values come from in
a given deployment is the operator's knowledge — it lives in the binding at
the composition root. Secretness rides the binding (`envSecret`) and the
type (`SecretString`), and validation cross-checks the two, so neither side
can silently misclassify a credential.

**Validate-only is enough because the deploy holds the values.** The reason
introspection feels necessary is the assumption that the framework must
enumerate slots before values exist. But at deploy time the binding is
resolved, so legality can be judged on the finished object; at boot the
document makes enumeration unnecessary. The single deliberate limit: a
schema cannot refine on a secret's *content* (deploy-time validation sees
opaque boxes) — content rules about credentials the framework never reads
are unenforceable by construction, and schemas must treat secret leaves as
opaque.

**One document beats per-key rows.** Flattened names collide (`stripe_secret`
the key vs `stripe.secret` the path), cannot express union arms or nesting,
and require the boot side to know the key set. A defaults-applied document
also guarantees deploy and boot judge byte-identical input — a schema-library
version skew between deploy shell and runtime cannot apply different
defaults. Test harnesses and local dev runners set one variable to one JSON
document instead of hand-writing the row protocol.

## Consequences

1. **Breaking authoring change.** `compute()` takes `input` (a Standard
   Schema) instead of `params` + `secrets`; `provision()` takes one `input`
   binding; `service.input()` replaces `config()` and `secrets()`. The
   reserved `port` param and `origin()` (ADR-0039) keep their existing
   channels. Examples and consuming apps migrate mechanically.

   That the framework's own per-service values stay on per-key rows is a
   limit on this ADR's scope, not a judgement that they belong there — the
   argument against per-key rows applies to them just as it does to the
   user's config. Moving them onto a framework-owned document, alongside
   this one and serialized by the same code, is tracked as its own project
   ("framework configuration rides the same document as user input") and
   would supersede this paragraph along with ADR-0031's separate channel.
2. **Serializer change.** One JSON document row per service plus per-secret
   platform variables, replacing per-key config rows and per-slot pointer
   rows. A secret leaf serializes to exactly `{"$secret": "<VAR>"}` — an
   object with the single key `$secret` and a string value, recognized only
   in that exact shape. The marker is collision-free by escaping: on write,
   any user key matching `/^\$+secret$/` gains one more leading `$`
   (`$secret` → `$$secret`, `$$secret` → `$$$secret`); on read, one `$` is
   stripped back off. So application data can carry a literal `$secret` key
   and round-trip unchanged, while only the framework can place a
   single-`$` marker — a forged pointer in user data is impossible.
   Escaping and pointer-recognition apply at every level of the walk,
   through nested objects and arrays alike.
3. **Error quality is the schema library's.** Binding/schema drift surfaces
   at deploy-time validation with the library's message, one step later than
   a metadata-reading design would catch it. This is the price of
   library-agnosticism, and it fails the deploy, never the running service.
4. **Secret content is opaque to schemas.** `secretString()` validates
   box-ness only. A schema that refines secret content is rejected loudly
   rather than silently passing at deploy and failing at boot.
5. **The deploy report grows two lines of honesty**: the serialized document
   (secret-free by construction) and the list of keys that resolved absent.

## Alternatives considered

- **Introspect the schema** (walk Zod's `_def` / ArkType's nodes, or use
  per-library metadata registries) — couples the framework to specific
  libraries' private internals and versions, and Standard Schema's authors
  excluded introspection deliberately. Rejected.
- **A framework combinator DSL** (`secret({ when: … })`, conditional need
  maps) — reinvents a fraction of what schema languages already do, worse,
  and every app would have to learn it. Rejected.
- **Per-key rows with declared-name reconstruction** (the status quo,
  extended) — requires a boot-side enumeration the schema cannot provide,
  cannot express nesting or union arms, and flattened names are ambiguous.
  Rejected.
- **An `optional` flag on secret slots** — solves only presence, not
  conditionality, and adds a framework concept the schema subsumes as an
  ordinary optional field. Rejected in favor of this design.

## Related decisions

This ADR replaces the read surface those earlier decisions established; the
sourcing mechanics they introduced survive as binding leaves.

- **[ADR-0021](ADR-0021-params-are-read-through-config-not-load.md)
  (superseded).** Params read through `config()`, a namespace separate from
  `load()`. `config()` and the `params` declaration are gone; configuration
  is now fields of the one `input` schema, read through `service.input()`.
  Dependencies still read through `load()`, so the two remain separate.
- **[ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) (partially
  superseded).** The forwardable, nameless secret *need* (`secret()`,
  `envSecret`) survives: a module still forwards a need without learning the
  platform name, and a forwarded ref is a binding leaf. What is replaced is
  the read surface (`secrets()` → a `SecretString` field of `input`) and the
  per-slot pointer-row wire format (→ the one document row).
- **[ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
  (partially superseded).** Binding a value at `provision()` and env
  sourcing (`envParam('NAME')`) survive unchanged as binding mechanics. What
  is replaced is the `config()` read and the per-key pointer rows.
- **[ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md)
  (untouched here, tracked separately).** The framework's own provider-param
  channel (origin, service keys) still rides per-key rows; consequence 1
  notes the project that would fold it onto a document like this one.
