# Purpose

Let a module take its configuration the way a service does: one Standard Schema, `input`, bound by whoever provisions it. Let the root module take `input` too, filled from config adapters named in `prisma.config.ts`. Today a module declares per-key `params` and `secrets` slots that accept only a source, never a literal, and the root has no input at all.

# At a glance

```ts
// a reusable module declares what it needs, as a service does
export default module('email',
  { input: type({ from: 'string', deliveryCredential: secretString() }), expose: { send: emailSendContract } },
  ({ input, provision }) => {
    const service = provision(emailService(), {
      id: 'service',
      input: { from: input.from, deliveryCredential: input.deliveryCredential },
    });
    return { send: service.send };
  });

// the root declares its own input; the deploy fills it from the config adapters
export default module('shop',
  { input: type({ EMAIL_FROM: 'string', 'SITE_HOSTNAME?': 'string' }) },
  ({ input, environment, provision }) => {
    provision(email(), {
      input: { from: input.EMAIL_FROM, deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') },
    });
    const host = resolve([input.SITE_HOSTNAME, environment.name], ([hostname, name]) =>
      hostname ?? `${name}.shop.com`);
    // …
  });
```

```ts
// prisma.config.ts
composer({ extensions: [prismaCloud(), nodeBuild()], state: prismaState(), config: [dotenv(), environmentVariables()] })
```

```sh
prisma deploy                         # root input from .env, .env.production, then the shell
prisma deploy --environment staging   # .env, .env.staging, then the shell
```

The decisions are ADR-0061 and ADR-0062. What the discussion with Will settled beyond them, and where it corrects them, is in [design-notes.md](design-notes.md).

# Non-goals

- Making `envParam()` a run-time pointer. It stays deploy-time; it is deprecated later (`.drive/deferred.md`).
- A run-time config source, `doppler()` or any secrets adapter beyond the default, and routing run-time secrets to a secret store (`.drive/deferred.md`).
- A `resolve()` that reads a deploy result.
- Any change to how a service reads its input at boot.

# Cross-cutting requirements

- **The graph's structure is the same whatever inputs Composer is given.** A module body never sees an input field's real value, so nothing it branches on can vary per environment.
- **Existing projects behave exactly as today.** A project with no `config` or `secrets` key gets `[environmentVariables()]` for both, so `envParam()` and preflight's fill of `envSecret()` still read the shell.
- **A secret's value never enters deploy state.** `envSecret()` stays a pointer the service dereferences at boot.
- **Recorded decisions are amended in the same PR as the code that depends on them**: ADR-0061, ADR-0062 (its 2026-10-29 amendment about storing `envParam()` and `envSecret()` values is corrected), ADR-0016, ADR-0029, ADR-0032, ADR-0049, the glossary, `module-composition.md`, `config-params.md`, the guides and the agent skill.
- Every implementer and reviewer is Opus.

# Definition of done

1. `module()` takes `input`; `provision(module, { input })` binds it; `params`, `paramNeed()`, `secrets` and the module form of `secret()` are gone.
2. A module body holds each input field as a value typed from the schema, passes it on, and lists it in `resolve()`. Turning one into text or a number, serializing it, listing its keys or iterating it fails with an error naming the field; comparing one with `===` or `switch` fails to compile. A truthiness check sees an object and always passes, so it cannot vary the graph.
3. The root declares `input`; the deploy fills it from the `config` pool and validates it with the root's schema, before anything is created.
4. `config` and `secrets` on the `composer` section default to `[environmentVariables()]`; `dotenv()` ships.
5. `envParam()` reads the `config` pool; preflight fills a missing `envSecret()` variable from the `secrets` pool; both are values.
6. A `resolve()` that lists an `envSecret()` value receives the pointer, which throws when used as text; `isRuntimeValue()` ships.
7. `auth()`, `email()` and every example use `input`; `prisma deploy` and `prisma dev` of the examples work against real targets, including a root `input` from `.env.<environment>`.
8. The decision records, glossary, domain docs, guides and skill describe the new surface.
