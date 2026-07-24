# ADR-0029: A secret is an environment-sourced value the framework never stores

## Decision

A **secret** is one specific thing: a value the deployment reads from the
environment **by name**, whose contents the framework never writes into deploy
state. It is the sensitive member of the environment-input family —
`envSecret(NAME)`, the sibling of `envParam(NAME)`. There is exactly one secret
concept. A value the framework *generates* at deploy is a config param
([ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md),
[ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)) — it may live in
deploy state and is **not** a secret.

A service declares a secret as a field typed `secretString()` in its input
schema; the application binds that field to a platform variable with
`envSecret`; the service reads it back as a redacting box:

```ts
// service.ts — the field's type says "a redacted value arrives here"
const authInput = type({ baseUrl: 'string', signingKey: secretString() });
export default compute({ name: 'auth', input: authInput, /* … */ });

// module.ts — only the application names the platform variable
provision(auth, { input: { baseUrl: envParam('APP_ORIGIN'),
                           signingKey: envSecret('AUTH_SIGNING_KEY') } });

// inside the service — one accessor; the value is redacted until asked for
const { signingKey } = service.input();     // SecretString
sign(payload, signingKey.expose());         // expose() is the one deliberate read
```

Three pieces carry the whole model:

- **`envSecret('NAME')` is the source** — it names the platform variable to
  read. Only the application writes it, so a reusable module underneath stays
  free of any platform name. It is the sensitive counterpart of `envParam`:
  same environment-sourced, name-carried, never-in-state shape, plus redaction.
- **`secretString()` is the type** — the field is typed as the framework's
  redacting `SecretString`. Secretness is enforced by *validation*: binding a
  plain literal where the schema expects a `SecretString` fails the deploy, and
  binding `envSecret` where the schema expects a plain string fails the same
  way. Neither side can silently misclassify.
- **`service.input()` is the read** — one accessor returns the whole validated
  input, secret fields as `SecretString` boxes. A `SecretString` prints
  `[REDACTED]` from every stringify path (`toString`, `toJSON`, `valueOf`,
  `inspect`); `.expose()` is the single call that hands back the raw value.

**The framework carries the name, never the value.** At deploy, the service's
input document gets a *pointer* — the name of the platform variable, not its
contents — written into the one input row:

```json
{ "baseUrl": "https://app.example", "signingKey": { "$secret": "AUTH_SIGNING_KEY" } }
```

At boot the framework swaps each `$secret` pointer for a redacting box over the
named variable, which the platform injects into the running instance. So a
secret's value never passes through the framework's typed config, the generated
deploy program, deploy state, or a log line — only its name does, and a name is
as safe to write and diff as any other key. The input document is secret-free by
construction, so the deploy report prints it verbatim.

Before provisioning, **deploy preflight** checks that every bound name exists on
the platform for the target stage. A name missing there but present in the
deploy shell's own environment is pushed up with a single write-only API call —
never recorded as managed infrastructure, so even then the value never lands in
deploy state. A name missing from both places fails the deploy early, with the
list of what to set.

Finally, the **need lives in core and the source lives in the target.** At a
module boundary a service still forwards a nameless secret *need* down into a
child it provisions (`secret()`, core's `@prisma/composer`) exactly as it
forwards an ordinary input — core treats the source as opaque and never reads
inside it. The constructor that *builds* a source is the deploy target's:
Prisma Cloud ships `envSecret('NAME')`, which validates an env-var name and
brands it. A different target could ship `vaultSecret({ path, key })` with no
change to core.

## Reasoning

**Why redaction is a type, not a flag.** A `secret: true` flag on an ordinary
value makes every place that touches config — logging, serialization, a new
export added a year from now — responsible for remembering to redact.
Sensitivity that depends on everyone remembering leaks eventually. Typing the
field as `SecretString` moves the guarantee into the type: redacted by default,
`expose()` marking the one place code means to read it.

**Why names cross the boundary and values don't.** The deploy machine, the
generated deploy program, and deploy state are all things we inspect, diff, and
sometimes print — none was built to hold a secret safely. Rather than teach each
of them to guard a value, the framework never carries one; it carries the
platform variable's *name* and lets the platform inject the value straight into
the running instance. This is already the shape a secrets-manager integration
wants: nothing downstream ever held the value, so there is nothing to unwind.

**Why the application binds the name.** If a reusable module hard-coded the
variable it reads, every application using it would be forced onto that one
name, and two applications could never give it different secrets. A nameless
need the composing application binds keeps the module reusable — the same rail
ordinary inputs forward on.

**Why a secret is environment-sourced, and generated values are not secrets.**
A secret's defining property is that its value stays out of deploy state — which
is possible precisely because someone else (the operator, the platform) holds
the value and the framework only references it. A value the framework itself
produces at deploy has no external holder to reference; it must be stored to be
stable. That value is a config param (ADR-0030's service key, a generated
signing key) — it may be redacted for display, but redaction is a facet, not
secretness. "Secret" names the environment-sourced, never-stored case alone.

## Consequences

- Every framework-written variable carries a reserved `COMPOSER_` prefix, so it
  can never collide with — and silently overwrite — a variable the user
  provisioned.
- Every secret field is required unless the schema makes it optional (a union
  arm or an optional field) — presence is the schema's call, not a flag on the
  secret.
- Rotation is: change the value on the platform, then redeploy. A running
  instance's environment is frozen when the instance is created.
- Two input fields that normalize to the same platform variable name are a
  deploy error (the pointer-name collision check), so a secret and a generated
  param can never quietly share a variable.

## Related

- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — the one-schema
  input model a secret field lives in; where redaction-as-a-type is defined.
- [ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md)
  — a generated param (a service key): the framework produces and stores it, so
  it is config, not a secret.
- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) — the
  input-forwarding rail a secret need rides on at a module boundary.
- [`../10-domains/config-params.md`](../10-domains/config-params.md) — params and
  their sources; the living vocabulary.
