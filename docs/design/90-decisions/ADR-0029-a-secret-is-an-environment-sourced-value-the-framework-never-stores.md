# ADR-0029: A secret is an environment-sourced value the framework never stores

```ts
// service.ts — the field's type says "a redacted value arrives here"
const authInput = type({ baseUrl: field(type('string')), signingKey: secretString() });
export default compute({ name: 'auth', input: authInput, /* … */ });

// module.ts — only the app root names the platform secret
export default appRoot('shop', ({ provision }) => {
  const signingKey = provision(variable.secret({ name: 'AUTH_SIGNING_KEY' }));
  provision(auth, { input: { baseUrl: serviceOrigin('shop.web'), signingKey } });
});

// inside the service — the value is redacted until asked for
const { signingKey } = service.input();     // SecretString
sign(payload, signingKey.expose());         // expose() is the one deliberate read
```

## Decision

A **secret** is a value held outside Composer, which the deploy never holds: the operator sets it on the platform, and the deployment reads it **by name**. The framework never writes its contents into deploy state, a file it generates, a log, the deploy report or an error. In the service it is boxed, typed `SecretString`, and Composer redacts it wherever it prints. Today the one kind is the **platform secret**, declared with `variable.secret({ name })`, a node the app root provisions ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)). A value the framework generates at deploy is a param ([ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md), [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)): it may live in deploy state, and it may be redacted for display and boxed like a secret, but the deploy holds it, so it is not a secret.

Three pieces carry the model:

- **The platform secret node is the source.** `provision(variable.secret({ name: 'NAME' }))` names the platform variable to read. Only the app root can provision it, so a reusable module underneath stays free of any platform name. It returns a value, typed `SecretSource<PlatformVariablePayload> & RuntimeValue<SecretString>`, whose real value at deploy is a secret pointer ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). A module receives it through a `secretString()` field of its `input` and passes it on ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)). A `resolve()` function cannot list it.
- **`secretString()` is the type.** The field is typed as the framework's redacting `SecretString`. A binding is typed from the schema, so binding a plain value where the schema expects a secret fails to compile, and so does binding a platform secret's value where it expects a plain string. Where the compiler sees no type, such as a schema without type information or a cast, validation fails the deploy instead.
- **`service.input()` is the read.** It returns the whole validated input, secret fields as `SecretString` boxes. A box prints `[REDACTED]` from every stringify path (`toString`, `toJSON`, `valueOf`, `inspect`); `.expose()` is the one call that returns the value.

**The framework carries the name, never the value.** At deploy, the service's input document gets a pointer, the name of the platform variable, not its contents:

```json
{ "baseUrl": "https://app.example", "signingKey": { "$platform": { "name": "AUTH_SIGNING_KEY", "secret": true } } }
```

At boot the framework swaps each pointer for a redacting box over the named variable, which the platform injects into the running instance. A variable that is unset or empty leaves its field out, and the schema decides whether that is allowed ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)).

**The operator sets the variable on the platform; preflight only checks it.** The deploy does not copy a value from the app secrets or the shell to the platform ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)). Before Alchemy runs, deploy preflight checks whether each platform secret in the graph has a row the environment sees, also one no service reads. It reads no value and writes no variable. A missing variable that a service's schema requires fails the deploy, naming the variable, its readers and the `prisma project env add` commands that set it. A missing one nothing requires is listed and the deploy goes on ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)). To change a value, change it on the platform and deploy again.

**Composer redacts every secret it knows.** Everywhere it prints, including errors, events, adapter failures, a thrown defect's cause chain and the deploy engine's failure cause, Composer replaces with `[redacted]` the value under each secrets key of the graph's secret sources (`variable.secret({ name: 'NAME' })` passes `NAME`), in the app configuration and in the app secrets. Every platform secret the root provisions is one of them, also when nothing binds it. Nothing else in the app secrets is a known secret. A known value is redacted at any length. When two known secrets overlap, it hides every character either one covers. Nothing is redacted by the known secrets before Load has named them: an adapter that throws, and a root schema failure that echoes a field's value, are redacted only by the credential-looking rule. Whether the deploy engine's own output is redacted depends on who runs it ([ADR-0062, "Alchemy's output"](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md#keeping-secrets-out)). Composer also redacts values that look like credentials: a value of eight characters or more under a name that looks like a credential, in the app configuration or the process environment, bearer and basic tokens, JWTs, a password in a URL and `token=` pairs.

**The need lives in core and the source in the target.** Core's `secretSource(payload, { label, secretsKey })` builds a source from a target's payload, and never reads the payload. `secretsKey` is the app secrets key that holds the secret's value; Composer redacts the value under it, and `prisma dev` hands it to its second process. Prisma Cloud's `variable.secret({ name: 'NAME' })` validates the name, brands the payload, passes `secretsKey: NAME`, and wraps the source in a value resource. A different target could ship `vaultSecret({ path, key })` with no change to core.

## Reasoning

**Why redaction is a type, not a flag.** A `secret: true` flag on an ordinary value makes every place that touches config responsible for remembering to redact. Typing the field as `SecretString` moves the guarantee into the type: redacted by default, with `expose()` marking the one place code means to read it.

**Why names cross the boundary and values do not.** The deploy machine, the generated deploy program and deploy state are all things we inspect, diff and sometimes print; none was built to hold a secret. Rather than teach each to guard a value, the framework carries the platform variable's name and lets the platform inject the value into the running instance.

**Why Composer also redacts by value.** A secret's value still passes through Composer's process: `prisma dev` hands it to local services, and a deploying shell often holds the production value of a secret it deploys. An adapter's error, the deploy engine's failure cause or a cause chain could carry it. So Composer replaces every value it knows a secret holds, wherever it prints. It cannot replace a secret it was never told about, which is why the set is the values under the secrets keys of the graph's secret sources. The app configuration and the app secrets hold values Composer may carry, and they usually hold the whole shell and every `.env` value; treating every value in them as a secret would blank every `1` and `true` in the output and refuse every plain value that equals one.

**Why the app root names the variable.** If a reusable module hard-coded the variable it reads, every application using it would be forced onto that one name. A module that takes a `secretString()` field and lets its caller bind it stays reusable. The names form one space per deployed app, and the root is the app, so only the root declares one.

**Why a platform secret is environment-sourced, and generated values are not secrets.** A platform secret's value stays out of deploy state because someone else, the operator or the platform, holds it. A value the framework produces at deploy has no external holder; it must be stored to be stable, so it is a param, which may be redacted for display.

## Consequences

- Every framework-written variable carries a reserved `COMPOSER_` prefix, so it can never overwrite a variable the user provisioned.
- A secret field is required unless the schema makes it optional; presence is the schema's call.
- Rotation is: change the value on the platform, then redeploy. A running instance's environment is frozen when the instance is created.
- A platform secret and a generated param never share a variable: a generated variable's name starts with `COMPOSER_`, which `variable.secret()` refuses. Two fields bound to one platform secret's value read one variable. Two nodes with one name fail the Prisma Cloud graph check ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)).
- A name may not be both a platform secret and a root input field: Load refuses it, also when no service reads the secret, because a root input field is a plain value: `prisma deploy` sends it to the platform as plain configuration, and `prisma dev` and `destroy` hand it to their second process in a file.
- A short secret is redacted at any length, so a one-character secret blanks that character in everything Composer prints.

## Alternatives considered

- **`envSecret('NAME')`, a secret source with no node**, written in any binding. Rejected: the graph could not list it as a node, it had no address for a message to name, and it let a module below the root claim a platform name. The platform secret node replaces it.
- **A forwardable `secret()` slot on modules**, which this decision first described as the need a module declares and its parent binds. Replaced by a `secretString()` field of the module's `input` ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).
- **A `resolve()` function that receives the secret's source**, which an earlier version of the values decision allowed. Rejected: a function cannot compute anything useful from a value the deploy does not have.
- **Copying a missing variable at deploy, implicitly, from the app secrets or the deploying shell.** Rejected: with `.env` read by every environment, it is how a developer's local value reaches production ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)).
- **Redacting only values of eight characters or more.** Rejected for known secrets: a secret Composer knows is redacted at any length. The minimum applies only to values Composer guesses are credentials from their names.

## Related

- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — the one-schema input model a secret field lives in.
- [ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md) — a generated param, which is config, not a secret.
- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md) and [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) — module input, values, and the adapters.
- [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md) — how `prisma dev` reads secrets.
- [ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md) — platform variables: names, the marker, boot and preflight.
- [config-params.md](../10-domains/config-params.md).
