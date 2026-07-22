# ADR-0032: Params bind at provision; env-sourcing is a target-owned source

## Decision

A config param can be bound at `provision()` time — to a literal value or to a
target-owned source such as `envParam('NAME')` — instead of only carrying an
authoring-time `default`. An env-sourced param is the non-secret sibling of
ADR-0029's secret: the same need/source split, the same per-stage platform
variable, the same preflight — but read back through `config()`, validated by
the param's own schema, and never redacted. Here is the whole lifecycle:

```ts
// 1. The service declares the param — a schema, no value, no platform name.
//    (string() is from @prisma/composer)
const web = compute({
  name: 'web',
  params: { appOrigin: string() },
  build: /* … */,
});

// 2. The application binds it at provision — a literal, or a platform env
//    var via envParam (from the target, @prisma/composer-prisma-cloud).
export default module('app', ({ provision }) => {
  provision(web, { params: { appOrigin: envParam('APP_ORIGIN') } });
  // …or a provision-time literal: { params: { appOrigin: 'https://example.com' } }
});

// 3. Inside the service, the value reads back through config(), like every
//    other param — typed, schema-validated, unredacted.
const { appOrigin } = web.config();   // string
```

A module boundary forwards a param binding down to a child through a nameless
`paramNeed()` slot, exactly the way it forwards a secret need — the same rail
(ADR-0016/0029).

## Reasoning

**Why provision-time binding at all.** A param used to have exactly one source
of a value: its authoring-time `default`. That made per-stage, per-application
configuration — the canonical example is an application origin URL that differs
between production and a preview stage — impossible to express without editing
the service's own source. (Narrowed by ADR-0039: that example holds only for
an origin the operator genuinely knows, such as a custom domain they
provisioned. A service's own *platform-assigned* origin is never operator
input — the target resolves it and exposes it as `ComputeService.origin()`.) Binding at `provision()` puts the value where the
composition decision is made: the module declares *what* it needs (a schema),
the application decides *what it is worth* (a literal) or *where it comes from*
(a source). A binding beats the param's `default`; the `default` remains the
fallback when nothing is bound; a param that is neither optional, defaulted,
nor bound fails loudly when config is built at deploy, naming the param, the
service, and the fix. (Previously such a param lowered silently with the value
absent — a latent type-lie, since the typed `Values` said it was present.)

**Why the source constructor is the target's.** Core knows what a `ParamSource`
is only as an opaque, branded value it forwards; it never reads the payload.
`envParam('NAME')` — which validates the platform variable name and builds the
payload — ships with `@prisma/composer-prisma-cloud`, exactly as `envSecret`
does. A different target could ship its own source kind with no change to core.
This is ADR-0018/0019's declaration-versus-encoding split, applied to where a
param's *value* comes from.

**Why the read stays `config()`.** An env-sourced param is still just a param:
its sensitivity did not change, only its provenance. `load()`, `config()`,
`secrets()` (ADR-0021/0029) split by what the value *is* — a dependency, plain
config, a secret — not by where it came from. A fourth accessor keyed on
provenance would force every consumer to know how the application happened to
bind a value, which is precisely the coupling the need/source split removes.
No redaction, no `SecretBox`: it's config.

**The wire: a pointer, discriminated by shape.** At deploy, an env-sourced
param's stored row carries the platform variable's NAME, not a value — the same
pointer idea as a secret row. Unlike a secret, the row shares its key space
with literal-bound params (both are the one generated key per param,
`COMPOSER_<address>_<name>`), so writer and reader must tell a pointer from a
literal by the stored value alone. Literal values are JSON-encoded; a pointer
row is written as `@composer-param-pointer:<NAME>`. No `JSON.stringify` output
can begin with `@` (JSON text begins with a quote, brace, bracket, digit, `-`,
`t`, `f`, or `n`), so the discriminator is unambiguous and literal rows are
byte-for-byte unchanged.

**Boot: double-lookup, then the schema — on the raw string.** Boot reads the
pointer for the name, then reads that platform variable, and hands the raw
string to the param's own schema. There is no authoring-time restriction to
string-output schemas and no decode step: a `string()` param works as expected;
a `number()` or structured param bound to `envParam` fails at boot with the
existing invalid-value error, because its schema receives a string. That
failure mode is deliberate — the platform variable *is* a string, and inventing
a coercion layer (or a static schema-shape check) buys little for the params
that actually want env-sourcing, which are strings.

Two boot rules differ from secrets, on purpose:

- **An unset platform variable is a boot error** naming the param, the pointer
  key, and the platform variable — a bound param means the application said the
  value comes from there.
- **An empty string is a value, not an absence.** It reaches the schema like
  any other string and is valid iff the schema accepts it. Secrets treat empty
  as unprovisioned; config semantics belong to the param's own schema.

**Preflight covers env-sourced params like secrets.** Before anything is
provisioned, the deploy verifies every env-sourced param's platform name exists
for the target stage, fills a missing one from the deploy shell with a single
write-only API call, and fails early — listing the names — when a name is
absent from both. Param values are not sensitive by contract, but one
mechanism is simpler, and the stricter write-only path costs nothing.
Literal-bound params never touch the platform check.

## Consequences

- Provision-time literals fix "params are default-only" as a side effect: a
  literal binding is schema-validated when config is built and beats the
  `default`.
- A required param (no `default`, not `optional`) that nothing binds now fails
  the deploy loudly instead of lowering silently with the value absent.
- Env-sourced params are stringly at the boundary: bind `envParam` to a
  non-string-schema param and boot fails validation. Lifting that (target-owned
  decode before the schema, per ADR-0019) is an additive change if a real
  consumer needs it.
- Value changes need a redeploy to materialize — a compute version snapshots
  its environment at creation. Same platform semantics as secret rotation
  (ADR-0029).
- The `@composer-param-pointer:` prefix is reserved only in raw stored-row
  space, which literals never occupy: every service-owned literal is
  JSON-encoded, so a string literal that itself starts with the prefix stores
  with a leading quote, never matches the pointer check, and round-trips
  intact. No literal value is restricted.

## Alternatives considered

- **A fourth accessor (`env()` / `platformConfig()`).** Rejected: it keys the
  read API on provenance, forcing consumers to know how the application bound
  the value. The need/source split exists to keep that knowledge out of the
  module.
- **Restricting env-sourced params to string-output schemas at authoring.**
  Rejected for v1: it needs static schema-shape inspection machinery (Standard
  Schema exposes none portably), to prevent a failure boot already reports
  clearly.
- **A separate pointer key per param (a second row, like secrets).** Rejected:
  it doubles the rows and leaves the primary key's absent-vs-pointer semantics
  ambiguous; the value-shape discriminator keeps one key per param and leaves
  literal rows untouched.
- **Reusing the secrets channel for env-sourced params.** Rejected: it would
  wrap plain config in `SecretBox` redaction and impose the non-empty rule,
  both wrong for config; and a param has a schema to run, which secrets do not.

## Related

- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) — the need/source
  split, pointer-on-the-wire, and preflight this mirrors.
- [ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md)
  — the framework-minted sibling: a `provision` need's value is minted by the
  framework per dependency edge and lives in deploy state, where an
  `envParam` value is operator-supplied per stage, never enters deploy state,
  and is read at boot. A param claiming both channels at once is a loud
  lowering error.
- [ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md) /
  [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — schema on the
  declaration, wire owned by the target.
- [ADR-0021](ADR-0021-params-are-read-through-config-not-load.md) — why the
  read stays `config()`.
- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) — the
  forwarding rail `paramNeed()` rides on.
- [`../10-domains/config-params.md`](../10-domains/config-params.md) — the
  config model this extends.
