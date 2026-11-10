# ADR-0029: A secret is an environment-sourced value the framework never stores

```ts
// service.ts — the field's type says "a redacted value arrives here"
const authInput = type({ baseUrl: field(type('string')), signingKey: secretString() });
export default compute({ name: 'auth', input: authInput, /* … */ });

// module.ts — only the application names the platform variable
provision(auth, { input: { baseUrl: serviceOrigin('shop.web'), signingKey: envSecret('AUTH_SIGNING_KEY') } });

// inside the service — the value is redacted until asked for
const { signingKey } = service.input();     // SecretString
sign(payload, signingKey.expose());         // expose() is the one deliberate read
```

## Decision

A **secret** is a value the deployment reads from a platform variable **by name**, whose contents the framework never writes into deploy state, a file it generates, a log, the deploy report or an error. There is exactly one secret concept. A value the framework generates at deploy is a param ([ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md), [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)): it may live in deploy state and is not a secret.

Three pieces carry the model:

- **`envSecret('NAME')` is the source.** It names the platform variable to read. Only the application writes it, so a reusable module underneath stays free of any platform name. It returns a value, typed `RuntimeValue<SecretString>`, whose real value at deploy is a secret pointer ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). A module passes it on through a `secretString()` field of its `input` ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)). A `resolve()` function cannot list it.
- **`secretString()` is the type.** The field is typed as the framework's redacting `SecretString`. A binding is typed from the schema, so binding a plain value where the schema expects a secret fails to compile, and so does binding `envSecret()` where it expects a plain string. Where the compiler sees no type, such as a schema without type information or a cast, validation fails the deploy instead.
- **`service.input()` is the read.** It returns the whole validated input, secret fields as `SecretString` boxes. A box prints `[REDACTED]` from every stringify path (`toString`, `toJSON`, `valueOf`, `inspect`); `.expose()` is the one call that returns the value.

**The framework carries the name, never the value.** At deploy, the service's input document gets a pointer, the name of the platform variable, not its contents:

```json
{ "baseUrl": "https://app.example", "signingKey": { "$platform": { "name": "AUTH_SIGNING_KEY", "secret": true } } }
```

At boot the framework swaps each pointer for a redacting box over the named variable, which the platform injects into the running instance. A variable that is unset or empty leaves its field out, and the schema decides whether that is allowed ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)).

**The operator sets the variable on the platform; preflight only checks it.** The deploy does not copy a value from the app secrets or the shell to the platform ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)). Before Alchemy runs, deploy preflight checks whether each name an `envSecret()` in the graph names has a row the environment sees. It reads no value and writes no variable. A missing variable that a service's schema requires fails the deploy, naming the variable, its readers and the `prisma project env add` commands that set it. A missing one nothing requires is listed and the deploy goes on ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)). To change a value, change it on the platform and deploy again.

**Composer redacts every secret it knows.** Everywhere it prints, including errors, events, adapter failures, a thrown defect's cause chain and the deploy engine's failure cause, Composer replaces with `[redacted]` the value under each secrets key of the graph's secret sources (`envSecret('NAME')` passes `NAME`), in the app configuration and in the app secrets. Nothing else in the app secrets is a known secret. A known value is redacted at any length. When two known secrets overlap, it hides every character either one covers. Nothing is redacted by the known secrets before Load has named them: an adapter that throws, and a root schema failure that echoes a field's value, are redacted only by the credential-looking rule. Whether the deploy engine's own output is redacted depends on who runs it ([ADR-0062, "Alchemy's output"](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md#keeping-secrets-out)). Composer also still redacts what it redacted before this decision: a value of eight characters or more under a name that looks like a credential, in the app configuration or the process environment, bearer and basic tokens, JWTs, a password in a URL and `token=` pairs. That is existing behaviour, kept until secrets get a home apart from plain values.

**The need lives in core and the source in the target.** Core's `secretSource(payload, { label, secretsKey })` builds a source from a target's payload, and never reads the payload. `secretsKey` is the app secrets key that holds the secret's value; Composer redacts the value under it, and `prisma dev` hands it to its second process. Prisma Cloud's `envSecret('NAME')` validates the name, brands the payload, and passes `secretsKey: NAME`. A different target could ship `vaultSecret({ path, key })` with no change to core.

## Reasoning

**Why redaction is a type, not a flag.** A `secret: true` flag on an ordinary value makes every place that touches config responsible for remembering to redact. Typing the field as `SecretString` moves the guarantee into the type: redacted by default, with `expose()` marking the one place code means to read it.

**Why names cross the boundary and values do not.** The deploy machine, the generated deploy program and deploy state are all things we inspect, diff and sometimes print; none was built to hold a secret. Rather than teach each to guard a value, the framework carries the platform variable's name and lets the platform inject the value into the running instance.

**Why Composer also redacts by value.** A secret's value still passes through Composer's process: `prisma dev` hands it to local services, and a deploying shell often holds the production value of a secret it deploys. An adapter's error, the deploy engine's failure cause or a cause chain could carry it. So Composer replaces every value it knows a secret holds, wherever it prints. It cannot replace a secret it was never told about, which is why the set is the values under the secrets keys of the graph's secret sources. The app configuration and the app secrets hold values Composer may carry, and they usually hold the whole shell and every `.env` value; treating every value in them as a secret would blank every `1` and `true` in the output and refuse every plain value that equals one.

**Why the application binds the name.** If a reusable module hard-coded the variable it reads, every application using it would be forced onto that one name. A module that takes a `secretString()` field and lets its caller bind it stays reusable.

**Why a secret is environment-sourced, and generated values are not secrets.** A secret's value stays out of deploy state because someone else, the operator or the platform, holds it. A value the framework produces at deploy has no external holder; it must be stored to be stable, so it is a param, which may be redacted for display.

## Consequences

- Every framework-written variable carries a reserved `COMPOSER_` prefix, so it can never overwrite a variable the user provisioned.
- A secret field is required unless the schema makes it optional; presence is the schema's call.
- Rotation is: change the value on the platform, then redeploy. A running instance's environment is frozen when the instance is created.
- A secret and a generated param never share a variable: a generated variable's name starts with `COMPOSER_`, which `envSecret()` refuses. Two fields bound to `envSecret()` with one name read one variable.
- A name may not be read both by `envParam()` and by `envSecret()`: Load refuses it, because the deploy hands its second process every plain value it reads, in a file.
- A short secret is redacted at any length, so a one-character secret blanks that character in everything Composer prints.

## Alternatives considered

- **A forwardable `secret()` slot on modules**, which this decision first described as the need a module declares and its parent binds. Replaced by a `secretString()` field of the module's `input` ([ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)).
- **A `resolve()` function that receives the secret's source**, which an earlier version of the values decision allowed. Rejected: a function cannot compute anything useful from a value the deploy does not have.
- **Copying a missing variable at deploy, implicitly, from the app secrets or the deploying shell.** Rejected: with `.env` read by every environment, it is how a developer's local value reaches production ([ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md)).
- **Redacting only values of eight characters or more.** Rejected for known secrets: a secret Composer knows is redacted at any length. The minimum stays for values Composer only guesses are credentials from their names, which is the existing behaviour this decision keeps for now.

## Related

- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — the one-schema input model a secret field lives in.
- [ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md) — a generated param, which is config, not a secret.
- [ADR-0061](ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md) and [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) — module input, values, and the adapters.
- [ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md) — how `prisma dev` reads secrets.
- [ADR-0064](ADR-0064-the-deploy-does-not-copy-local-values-to-platform-variables.md) — platform variables: names, the marker, boot and preflight.
- [config-params.md](../10-domains/config-params.md).
