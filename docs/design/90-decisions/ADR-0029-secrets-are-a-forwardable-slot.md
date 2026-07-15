# ADR-0029: Secrets are a forwardable slot

## Context

A service needs a secret — a signing key, an API token — whose value the platform
holds and the deploy machine must never see. The value is provisioned out-of-band
on the platform; the framework's only job is to route the service to it at boot.
That routing has to survive composition: a reusable module declares that it needs
a secret without knowing which platform variable an application will bind it to,
and the application composing that module supplies the name. The framework already
forwards ordinary inputs down a module's boundary (ADR-0016) — secrets ride the
same rail.

## Decision

A secret is its own slot kind — not a config param, not a dependency.

- **`secret()`** (from `@prisma/compose`) declares a nameless *need* on
  `compute()`/`module()` (`secrets: { signingKey: secret() }`). A module forwards its need to an inner
  service through `ctx.secrets`, exactly as it forwards a dependency input.
- **`envSecret('NAME')`** (from `@prisma/compose-prisma-cloud`) is the *source*:
  the root binds a need to a platform env-var name — `provision(auth, { secrets: { signingKey: envSecret('AUTH_SIGNING_KEY') } })`.
  Only the root names the variable; the module never does.
- **`secrets()`** reads the value at the point of use, a third accessor beside
  `load()`/`config()` (ADR-0021), returning one `SecretBox<string>` per slot.
  `expose()` is the sole reader; the box prints `[REDACTED]` from `toString`,
  `toJSON`, `valueOf`, and `inspect`.

The framework carries only the **name**. Deploy writes a pointer row
`COMPOSE_<addr>_<slot> = NAME` — never a value. Boot double-looks-up: read the
pointer row for the name, then read `process.env[NAME]` (the platform injects the
user-provisioned variable into the version's env), and wrap the result in a
`SecretBox`. Load records each resolved binding on the graph, and the deploy
target keys its pointer row off that. **Deploy preflight** verifies every bound
name exists on the platform for the stage's class/branch before provisioning; a
name absent from the platform but present in the deploy shell is provisioned with
a direct write-only POST (never an Alchemy resource, so no value reaches deploy
state); a name absent from both fails the deploy.

**The need is core; the source is the target's.** `secret()` and the opaque
`SecretSource` are `@prisma/compose`; core forwards a source and never reads its
payload. The source constructor belongs to the target — Prisma Cloud ships
`envSecret('NAME')` from `@prisma/compose-prisma-cloud`, which validates the name
and wraps it via core's `secretSource()`. The ADR-0018/0019 split, for secrets.

## Rationale

- **A distinct slot makes sensitivity structural.** Redaction is carried by the
  type (`SecretBox`), not a flag every sink must remember to check — a secret
  cannot be logged or serialized by accident, and `expose()` marks the one place
  value access is intended.
- **Names, not values, keep secrets out of inspectable state.** The value never
  enters the typed `Config`, the generated stack file, deploy state, or a log —
  only a name does, which is as safe to write and diff as any other key. This is
  also exactly the constraint a future platform-side secrets-manager integration
  needs, with nothing to unwind.
- **Root-binds-and-forwards keeps modules reusable.** A module declares the need
  and forwards it; it never hardcodes a platform variable name, so the same
  module composes into any application, each binding its own name.

## Consequences

- Every generated key carries a reserved `COMPOSE_` prefix, so a framework key can
  never collide with — and silently overwrite — a user-provisioned platform
  variable.
- Every wired secret is required; an "optional secret" would be a distinct future
  construct, not a facet on this one.
- Rotation is `PATCH` the value on the platform, then redeploy — the platform's
  own version-snapshot semantics (an env map is frozen per compute version), not a
  framework mechanism.
- A secret slot and a service-own param may not share a name (they derive the same
  config key); a dependency may, since its keys carry the input and param segments.

## Alternatives considered

- **A secret as a param facet bound at the leaf** (the service names the platform
  variable itself). Rejected: the binding cannot be forwarded through the topology,
  so a reusable module would have to hardcode the platform name — the opposite of
  composable.
- **A secret as an ordinary dependency.** Rejected: it would read back as a client
  through `load()`, and its sensitivity would be a flag on a value rather than a
  property of the type — the same leak-by-omission the distinct slot removes.
- **Value-as-default sourced from the deploy environment.** Rejected: it persists
  the secret value in deploy state and offers no way to verify the value is present
  before provisioning.
- **Unprefixed generated keys.** Rejected: a generated key could collide with a
  user-provisioned platform variable of the same name and silently overwrite it.

## Related

- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) — the module
  input-forwarding rail secrets ride.
- [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — the declaration/
  encoding split this applies to secrets: core carries the need, the target owns
  the source and its serialization.
- [ADR-0021](ADR-0021-params-are-read-through-config-not-load.md) —
  `load()`/`config()`/`secrets()` as separate read namespaces.
- [`../10-domains/config-params.md`](../10-domains/config-params.md) — the config
  model, with a § Secrets summary.
