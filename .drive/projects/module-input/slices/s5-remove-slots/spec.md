# S5 — Migrate to `input` and remove the module slots

Parent: [module-input spec](../../spec.md) and [plan](../../plan.md). Decisions: the module input decision ([ADR-0061](../../../../../docs/design/90-decisions/ADR-0061-a-module-declares-its-input-as-a-compute-service-does.md)), the module boundary decision ([ADR-0016](../../../../../docs/design/90-decisions/ADR-0016-a-module-has-the-same-boundary-as-a-service.md)), the secrets decision ([ADR-0029](../../../../../docs/design/90-decisions/ADR-0029-secrets-are-a-forwardable-slot.md)), the provision-time params decision ([ADR-0032](../../../../../docs/design/90-decisions/ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)), the service input decision ([ADR-0042](../../../../../docs/design/90-decisions/ADR-0042-service-input-is-one-standard-schema.md)) and the `resolve()` and config adapters decision ([ADR-0062](../../../../../docs/design/90-decisions/ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)), each with its amendments. This is the last slice of the project. It builds on S4 ([S4 spec](../s4-config-adapters/spec.md)) after S4's review fixes have landed (branch `claude/module-input-s4`).

This spec leaves nothing to the implementer's judgement. Every type, signature, name, error message, file and test is pinned. Where the implementer finds the spec and the code in conflict, the implementer stops and reports; it does not choose. § 13 lists the decisions this spec takes, and § 14 the conflicts it found.

Read for this spec: `CLAUDE.md`; `docs/design/01-principles/`; ADR-0016, ADR-0029, ADR-0032, ADR-0042, ADR-0061 and ADR-0062 with every amendment; the glossary entries Module, Value and Config pool; `module-composition.md`; `config-params.md`; the S2, S3 and S4 specs; `.agents/rules/user-facing-surface-changes.mdc`; `skills/README.md`; `docs/oss/versioning.md`; and the code named in each section below.

`<date>` below is the date the pull request is opened, as `YYYY-MM-DD`.

## 1. At a glance

Before this slice, a module took configuration three ways. After it, one.

```ts
// before: per-key slots that take only a source
const relay = module(
  'relay',
  { params: { origin: paramNeed() }, secrets: { key: secret() } },
  ({ params, secrets, provision }) => {
    provision(relayService, { input: { origin: params.origin, key: secrets.key } });
  },
);
provision(relay, { params: { origin: envParam('ORIGIN') }, secrets: { key: envSecret('RELAY_KEY') } });

// after: one input schema, bound like a service's
const relay = module(
  'relay',
  { input: type({ origin: 'string', key: secretString() }) },
  ({ input, provision }) => {
    provision(relayService, { input: { origin: input.origin, key: input.key } });
  },
);
provision(relay, { input: { origin: envParam('ORIGIN'), key: envSecret('RELAY_KEY') } });
```

The shipped modules move the same way:

```ts
provision(email(), {
  input: {
    deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
    from: envParam('EMAIL_FROM'),
    deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
  },
});
provision(auth(), { deps: { db, email: mail.send }, input: { baseUrl: serviceOrigin('shop.web') } });
```

Old code fails with an error that names the replacement:

```text
$ prisma deploy
✖ module("relay") declares `params`, which a module no longer takes. Declare each value as a field of the module's `input` schema, and bind it with provision(module, { input: { … } }) (ADR-0061).
```

The email example's root now declares its own input, filled from `.env` files by the config adapters:

```ts
// examples/email/module.ts
export default module(
  'email-example',
  { input: type({ EMAIL_DELIVERY_MODE: "'resend' | 'smtp' | 'none'", EMAIL_FROM: 'string' }) },
  ({ input, provision }) => {
    const mail = provision(email(), {
      input: {
        deliveryMode: input.EMAIL_DELIVERY_MODE,
        from: input.EMAIL_FROM,
        deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
      },
    });
    provision(mailerService, { deps: { email: mail.send, outbox: mail.outbox } });
  },
);
```

## 2. The model

- **A module takes configuration only through `input`.** `module()` has no `params` or `secrets` key. `provision()` of a module takes `id`, `deps` and `input`, nothing else. The body receives `deps`, `input`, `environment` and `provision`.
- **The old keys are refused, not ignored.** `module()` throws when its boundary has a `params` or `secrets` key, and `provision()` of a module throws when its options have a `params` or `secrets` key. Each error names `input`. TypeScript already rejects both, so the errors reach a JavaScript caller, or a caller that cast around the types.
- **A service keeps its per-key `params`.** `provision(service, { params: { port: envParam('PORT') } })` is unchanged, as are `paramSource()`, `secretSource()`, `isParamSource()`, `isSecretSource()`, `isRuntimeValue()`, and the target's `envParam()`, `envSecret()`, `generatedParam()` and `serviceOrigin()`.
- **A source in a module's input behaves as S3 made it.** `envParam()` is its value at deploy, read from the config pool, so the service receives the string. `envSecret()`, `generatedParam()` and `serviceOrigin()` are pointers, so the service receives the source itself. The service's input document on the wire is the same as when the module forwarded the source through a slot.
- **The types lose their slot parameters.** `ModuleNode<D, E, I>` and `ModuleContext<D, I>` replace `ModuleNode<D, E, S, PN, I>` and `ModuleContext<D, S, PN, I>`.
- **This is a breaking change to `@prisma/composer` and `@prisma/composer-prisma-cloud`.** The project is pre-1.0, and breaking changes ship in a minor release (`docs/oss/versioning.md`). § 7 says how the release notes describe it.

## 3. Core

### 3.1 `node.ts`: what is removed

Removed, with their doc comments:

- the `SECRET_NEED` brand constant, and the comment block above `SECRET_NEED` and `SECRET_SOURCE` that begins "A secret slot rides its OWN brand";
- `interface SecretNeed`, `type Secrets`, `type SecretBindings`, `function secret()`;
- the `PARAM_NEED` brand constant, and the comment block above `PARAM_SOURCE` that begins "A param can be bound at provision time";
- `interface ParamNeed`, `type ParamNeeds`, `function paramNeed()`, `type ParamNeedBindings`;
- `ModuleNode`'s `secretSlots` and `paramSlots` members;
- `ModuleContext`'s `secrets` and `params` members.

Kept unchanged: `SECRET_SOURCE`, `SecretSource`, `secretSource()`, `isSecretSource()`, `PARAM_SOURCE`, `ParamSource`, `paramSource()`, `isParamSource()`, `ParamBindings`, `SourceOptions`, `ParamSourceOptions`, `isRuntimeValue()`, and everything else in the file.

Two doc comments change:

- `isSecretSource`: `` /** True if `value` is a secret source, such as an `envSecret()` result. */ ``
- `isParamSource`: `` /** True if `value` is a param source, such as an `envParam()` result. */ ``

### 3.2 `node.ts`: the module types

```ts
export interface ModuleNode<
  D extends Deps = Deps,
  E extends Expose = Expose,
  I extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  readonly [NODE]: true;
  readonly kind: 'module';
  /** Human-readable, given at authoring — logs/diagnostics only. */
  readonly name: string;
  readonly deps: D;
  /** The module's whole incoming configuration as one Standard Schema (authored as `input`, ADR-0061), or `undefined` when it takes none. Load only calls its `~standard.validate`. */
  readonly inputSchema: I;
  readonly expose: E;
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  body(ctx: ModuleContext<D, I>): ModuleOutputs<E> | void;
}

export interface ModuleContext<
  D extends Deps,
  I extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
> {
  readonly deps: { [K in keyof D]: InputRef<D[K]> };
  readonly input: I extends StandardSchemaV1 ? ModuleInput<I> : undefined;
  readonly environment: EnvironmentFacts;
  readonly provision: ModuleBuilder['provision'];
}
```

`ModuleNode`'s own doc comment and `ModuleContext`'s members' doc comments keep their current text.

`ModuleProvisionOptions` and `ModuleProvisionArgs` become:

```ts
/**
 * A child-MODULE provision's trailing options: `deps` and `input` each
 * required exactly when the module declares them.
 */
type ModuleProvisionOptions<D extends Deps, I extends StandardSchemaV1 | undefined> = {
  id?: string;
} & ([keyof D] extends [never] ? unknown : { deps: DepBindings<D> }) &
  ([I] extends [StandardSchemaV1] ? { input: ModuleInputBinding<ModuleInputOf<I>> } : unknown);

/** The options are optional exactly when nothing is required. */
type ModuleProvisionArgs<D extends Deps, I extends StandardSchemaV1 | undefined> = [
  keyof D,
] extends [never]
  ? [I] extends [StandardSchemaV1]
    ? [opts: ModuleProvisionOptions<D, I>]
    : [opts?: ModuleProvisionOptions<D, I>]
  : [opts: ModuleProvisionOptions<D, I>];
```

The two module overloads of `ModuleBuilder['provision']` become:

```ts
  /** Registers an owned child module; its id defaults to the node's `name`; `deps` and `input` are required iff it declares them. */
  provision<D extends Deps, E extends Expose, I extends StandardSchemaV1 | undefined>(
    child: ModuleNode<D, E, I>,
    ...args: ModuleProvisionArgs<D, I>
  ): ProvisionedRef<E>;
  /** The child-module call with `deps` spelled out — the same generic-wrapper escape as the service overload above. */
  provision<D extends Deps, E extends Expose, I extends StandardSchemaV1 | undefined>(
    child: ModuleNode<D, E, I>,
    opts: {
      id?: string;
      deps: DepBindings<D>;
      input?: ModuleInputBinding<ModuleInputOf<I>>;
    },
  ): ProvisionedRef<E>;
```

The service and resource overloads do not change.

### 3.3 `node.ts`: `module()`

```ts
export function module(
  name: string,
  body: (ctx: ModuleContext<Record<never, never>, undefined>) => void,
): ModuleNode<Record<never, never>, Record<never, never>, undefined>;
export function module<
  D extends Deps = Record<never, never>,
  E extends Expose = Record<never, never>,
  I extends StandardSchemaV1 | undefined = undefined,
>(
  name: string,
  boundary: { deps?: D; input?: I; expose?: E },
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  body: (ctx: ModuleContext<D, I>) => ModuleOutputs<E> | void,
): ModuleNode<D, E, I>;
export function module(
  name: string,
  boundaryOrBody:
    | { deps?: Deps; input?: StandardSchemaV1; expose?: Expose }
    | ((ctx: ModuleContext<Deps, undefined>) => void),
  // biome-ignore lint/suspicious/noConfusingVoidType: void accepts bodies with no return statement; undefined would reject them.
  maybeBody?: (ctx: ModuleContext<Deps>) => ModuleOutputs<Expose> | void,
): ModuleNode;
```

The overloads' doc comments keep their text. In the implementation, directly after `const boundary = closedRoot ? {} : boundaryOrBody;`:

```ts
  if (Object.hasOwn(boundary, 'params')) {
    throw new Error(
      `module("${name}") declares \`params\`, which a module no longer takes. Declare each value ` +
        "as a field of the module's `input` schema, and bind it with provision(module, { input: { … } }) (ADR-0061).",
    );
  }
  if (Object.hasOwn(boundary, 'secrets')) {
    throw new Error(
      `module("${name}") declares \`secrets\`, which a module no longer takes. Declare each secret ` +
        "as a secretString() field of the module's `input` schema, and bind it with provision(module, { input: { … } }) (ADR-0061).",
    );
  }
```

The key is refused whatever its value, `undefined` included. The `secretSlots` and `paramSlots` lines and the two members of the returned object are removed. The returned node's own keys are `kind`, `name`, `deps`, `inputSchema`, `expose` and `body`, plus the `NODE` symbol.

### 3.4 `load-module.ts`: what is removed

- `MODULE_SECRET_KEY` and `MODULE_PARAM_KEY`, with their doc comments.
- `deepValues`, with its doc comment. Its only callers mark slot usage.
- `validateSecretBinding` and `validateParamNeedBinding`, with their doc comments. `validateServiceParamBinding` stays.
- In `flatten`: the parameters `secretWiring` and `paramWiring`; `usedSecrets`, `usedParams`, `ctxSecrets`, `ctxParams`, `markSecretsUsed`, `markParamsUsed` and their comments; `localSecrets` and its `markSecretsUsed` call; the `markParamsUsed(Object.values(localParams))` call (`localParams` stays, for a service's params); the two `deepValues` blocks, in the service branch and in the module branch; the `validateSecretBinding` and `validateParamNeedBinding` calls and their comments; the two loops after the body that report a secret or param "but never forwards it into a provision", with their comments.
- In `loadModule`: the `rootSecretKeys` and `rootParamKeys` checks. `module()` now refuses both keys, so no node built by this copy of core has slots.
- Imports no longer used: `isParamSource` and `isSecretSource` from `./node.ts`, and `originOf` from `./value.ts`. If `pnpm lint` reports another unused import, remove it too.

The `flatten` call in `loadModule` becomes `flatten(root, rootId, {}, nodes, edges, …)`, and the recursive call `flatten(child, fullAddress, localWiring, nodes, edges, …)`.

The `ctx` object passes `deps`, `input`, `environment` and `provision`. Its `blindCast` reason becomes: `"ctxInputs holds one resolved ref per moduleNode.deps key (the shape a producer port carries), input is buildModuleInput(selfId) exactly when the node declares an input schema, and provision is exactly ModuleBuilder['provision'] — together they satisfy ModuleContext<D, I> structurally for whatever D/I this moduleNode declares"`.

The comment in `provision` that begins "The id defaults to the node's own `name`; `opts.deps`/`opts.secrets`/" ends: "carry the producers, the input binding and a service's param bindings that satisfy its slots."

### 3.5 `load-module.ts`: the module branch refuses the old maps

At the start of the module branch, directly before `const childInputSchema`:

```ts
    if (provisionSecrets !== undefined) {
      throw new LoadError(
        `provision("${id}") received secrets for a module, which a module no longer takes. A ` +
          'module takes a secret as a secretString() field of its `input` binding (ADR-0061), not a secrets map.',
      );
    }
    if (provisionParams !== undefined) {
      throw new LoadError(
        `provision("${id}") received params for a module, which a module no longer takes. A ` +
          'module takes its values as fields of its `input` binding (ADR-0061), not a params map.',
      );
    }
```

The provision implementation's `opts` type keeps `secrets?` and `params?`, so it can read them. The service branch's secrets error and the resource branch's errors do not change.

### 3.6 `exports/index.ts`

Removed from the `../node.ts` type group: `ParamNeed`, `ParamNeedBindings`, `ParamNeeds`, `SecretBindings`, `SecretNeed`, `Secrets`. Removed from the value group: `paramNeed`, `secret`. `@prisma/composer` re-exports `@internal/core` wholesale, so nothing changes in `packages/9-public/composer`.

### 3.7 Comments elsewhere in core

- `config.ts`, the `ConfigDeclaration` doc comment: "Secrets are not here — they live on their own slot." becomes "Secrets are not here: they are `secretString()` fields of a service's input, bound with `envSecret()`."

## 4. The shared modules

### 4.1 `packages/1-prisma-cloud/2-shared-modules/email/src/email-module.ts`

```ts
/**
 * The `email()` module: an email service with its own Postgres `db`, exposing
 * `send` and `outbox` as separate ports, so a consumer that can send cannot
 * read every email ever sent. Its input is `deliveryMode`, `from` and the
 * secret `deliveryCredential`; `deliveryUrl` is a factory option.
 */
import type { ModuleNode } from '@internal/core';
import { module } from '@internal/core';
import { secretString } from '@internal/foundation/arktype';
import { rawPostgres } from '@internal/prisma-cloud';
import { type } from 'arktype';
import { emailOutboxContract, emailSendContract } from './contract.ts';
import { emailService } from './email-service.ts';

const emailModuleInput = type({
  deliveryMode: 'string',
  from: 'string',
  deliveryCredential: secretString(),
});

export function email(opts?: {
  name?: string;
  deliveryUrl?: string;
}): ModuleNode<
  Record<never, never>,
  { send: typeof emailSendContract; outbox: typeof emailOutboxContract },
  typeof emailModuleInput
> {
  return module(
    opts?.name ?? 'email',
    { input: emailModuleInput, expose: { send: emailSendContract, outbox: emailOutboxContract } },
    ({ input, provision }) => {
      const db = provision(rawPostgres({ name: 'db' }), { id: 'db' });
      const service = provision(emailService(), {
        id: 'service',
        deps: { db },
        input: {
          deliveryMode: input.deliveryMode,
          deliveryUrl: opts?.deliveryUrl ?? 'https://api.resend.com',
          from: input.from,
          deliveryCredential: input.deliveryCredential,
        },
      });
      return { send: service.send, outbox: service.outbox };
    },
  );
}
```

`deliveryMode` is `'string'` in the module's schema; the service's schema checks the mode (§ 13, decision 3). `emailModuleInput` is not exported.

### 4.2 `packages/1-prisma-cloud/2-shared-modules/auth/src/auth-module.ts`

The file doc comment becomes:

```ts
/**
 * The `auth()` module: Better Auth in one service. The database and the email
 * sender are dependencies the parent wires. Its input is `baseUrl`, the public
 * origin of the consumer app (scheme and host, no trailing slash, no path),
 * bound with `serviceOrigin('<app>.<service>')`, `envParam(...)` or a literal.
 * The instance secret is a `generatedParam()` the module binds itself; `signUp`
 * is a factory option.
 */
```

The imports drop `ParamNeed` and `paramNeed`, and add `import { type } from 'arktype';`. Before `AuthModuleOptions`:

```ts
const authModuleInput = type({ baseUrl: 'string' });
```

The return type's last two arguments, `Record<never, never>, { baseUrl: ParamNeed }`, become `typeof authModuleInput`. In the boundary, `params: { baseUrl: paramNeed() }` becomes `input: authModuleInput`. The body destructures `({ deps, input, provision })` and binds `baseUrl: input.baseUrl`. `authModuleInput` is not exported. Nothing else in the file changes.

### 4.3 `storage` and `streams`

`storage/src/storage-module.ts`: the return type `ModuleNode<Record<never, never>, { store: typeof s3Contract }, Record<never, never>>` becomes `ModuleNode<Record<never, never>, { store: typeof s3Contract }, undefined>`. `streams/src/streams-module.ts`: the return type's third argument, `Record<never, never>`, becomes `undefined`. Both third arguments were the old secret slots, which those modules never declared; the third argument is now the input schema, and `undefined` says the module declares none. Leaving it out would give `ModuleNode`'s wide default, `StandardSchemaV1 | undefined`.

### 4.4 READMEs

- `email/README.md`, § Wiring: the `provision(email(), { … })` call becomes, verbatim:

  ```ts
  const mail = provision(email(), {
    id: 'email',
    input: {
      deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
      from: envParam('EMAIL_FROM'),
      deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
    },
  });
  ```

- `email/README.md`, § Platform env vars (per environment): the first paragraph becomes: `` `deliveryMode`, `from` and `deliveryCredential` are the module's `input`. Bind `deliveryMode` and `from` to a literal, an `envParam(...)` or a field of your root's input, so they can vary per environment. `deliveryCredential` is a `secretString()` field: bind it with `envSecret(...)`. The module's schema checks only that `deliveryMode` is a string; the service checks that it is `resend`, `smtp` or `none` before anything is created. `deliveryUrl` is a factory option (`email({ deliveryUrl })`), static per app: it defaults to `https://api.resend.com` and follows the mode. `` The table and the paragraph after it do not change.
- `auth/README.md`, § Golden-path wiring: `params: { baseUrl: serviceOrigin('app.api') }, // the PUBLIC app origin` becomes `input: { baseUrl: serviceOrigin('app.api') }, // the PUBLIC app origin`.
- `auth/README.md`, the `signUp: 'closed'` snippet: `params: { … }` becomes `input: { baseUrl: … }`.
- `auth/README.md`, § Email flows: the snippet becomes:

  ```ts
  const mail = provision(email(), { id: 'mail', input: { /* deliveryMode, from, deliveryCredential */ } });
  const identity = provision(auth(), {
    id: 'auth',
    deps: { db, email: mail.send },
    input: { baseUrl: envParam('AUTH_BASE_URL') },
  });
  ```

- `streams/SCOPE.md`, the diagram line `└─ secrets.apiKey: secret()   ← bearer key, root-bound (ADR-0029)` becomes `└─ apiKey                       ← bearer key, provisioned by the target`. The file's own § "Secrets: none" already says so.

## 5. The examples

### 5.1 Which example moves how

| Example | Root today | After this slice |
| --- | --- | --- |
| `email` | binds `email()`'s `params` with `envParam()` and its `secrets` with `envSecret()` | the root declares `input` from the config adapters (`dotenv()`, then the shell); `envSecret()` for the credential |
| `auth` | binds `email()`'s slots as above and `auth()`'s `baseUrl` with `serviceOrigin()` | keeps `envParam()` and `serviceOrigin()`, now in `input` bindings; `prisma.config.ts` lists `dotenv()` |
| `storefront-auth` | binds its own auth module's `secrets` slot with `envSecret()` | binds the module's `input` with `envSecret()`; `prisma.config.ts` unchanged |
| `env-param` | binds a service's input with `envParam()`, no module | unchanged: it is the `envParam()` example |
| every other example | no module slots | unchanged |

### 5.2 `examples/email`

`module.ts`, verbatim:

```ts
import { module } from '@prisma/composer';
import { envSecret } from '@prisma/composer-prisma-cloud';
import { email } from '@prisma/composer-prisma-cloud/email';
import { type } from 'arktype';
import mailerService from './src/mailer/service.ts';

/**
 * The email example: a `mailer` app backed by the `email()` module. The root's
 * input comes from the config adapters in prisma.config.ts, and its schema
 * checks the delivery mode before anything is created. The credential is a
 * secret, bound with envSecret(); it is required even in `none` mode.
 */
export default module(
  'email-example',
  { input: type({ EMAIL_DELIVERY_MODE: "'resend' | 'smtp' | 'none'", EMAIL_FROM: 'string' }) },
  ({ input, provision }) => {
    const mail = provision(email(), {
      input: {
        deliveryMode: input.EMAIL_DELIVERY_MODE,
        from: input.EMAIL_FROM,
        deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
      },
    });
    provision(mailerService, { deps: { email: mail.send, outbox: mail.outbox } });
  },
);
```

`prisma.config.ts`: the line `import 'dotenv/config';` and the blank line after it are removed; the `@prisma/composer/config` import becomes `import { defineConfig as composer, dotenv, environmentVariables } from '@prisma/composer/config';`; the section gains, after `state`:

```ts
    config: [dotenv(), environmentVariables()],
    secrets: [dotenv(), environmentVariables()],
```

`.env.example`, verbatim:

```sh
# Values for this example. Copy this file to .env for every environment, or to
# .env.<environment> for one. dotenv() in prisma.config.ts reads .env, .env.local,
# .env.<environment> and .env.<environment>.local here, a later file winning, and
# then the shell, which wins over all of them.

# The root module's input. Its schema in module.ts checks these before anything is created.
EMAIL_DELIVERY_MODE=none
EMAIL_FROM=dev@example.com

# A secret. prisma deploy uploads it when the environment does not have it yet, so put
# a real one in .env.<environment>.local, which git ignores. Mode none never reads it.
EMAIL_DELIVERY_CREDENTIAL=local-dev-unused
```

`package.json`: the `dotenv` devDependency is removed. `scripts/smoke.ts`: the app lookup `(s) => s['name'] === 'mailer'` becomes ``(s) => s['name'] === `${stack}.mailer` ``, and the error `` `no "mailer" app on the production branch …` `` becomes `` `no "${stack}.mailer" app on the production branch (candidates: ${candidates.length})` ``. Apps are named by full address; the auth smoke script was fixed the same way in S3.

### 5.3 `examples/auth`

`module.ts`: the `email()` provision becomes:

```ts
  const mail = provision(email(), {
    id: 'mail',
    input: {
      deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
      from: envParam('EMAIL_FROM'),
      deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
    },
  });
```

and the `auth()` provision's `params: { baseUrl: serviceOrigin('auth-example.api') }` becomes `input: { baseUrl: serviceOrigin('auth-example.api') }`. The file's doc comment becomes:

```ts
/**
 * The auth example: a database carrying only the auth extension pack, the
 * `auth()` module wired to it, and the `email()` module as auth's email
 * dependency. `api` holds the `api` and `session` ports and the verifier; `ops`
 * holds `admin` and the smoke's read-only outbox. `baseUrl` is the api
 * service's public origin. The email module's input reads its delivery mode
 * and sender with envParam(), from the config adapters in prisma.config.ts;
 * its credential is required even in `none` mode.
 */
```

`prisma.config.ts`: as § 5.2, the `dotenv/config` import is removed, the config import gains `dotenv` and `environmentVariables`, and the section gains the same `config` and `secrets` lists after `state`. The comments in the file do not change.

`.env.example`: the first line becomes `# Local values. Copy this file to .env; dotenv() in prisma.config.ts reads it, and the shell wins over it.` The other lines do not change.

`package.json`: the `dotenv` devDependency is removed.

### 5.4 `examples/storefront-auth`

`modules/auth/src/module.ts`, from the import lines on:

```ts
import { module } from '@prisma/composer';
import { secretString } from '@prisma/composer/arktype';
import { rawPostgres } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';
import { authContract } from './contract.ts';
import authService from './service.ts';

export default module(
  'auth',
  { input: type({ signingKey: secretString() }), expose: { rpc: authContract } },
  ({ input, provision }) => {
    const db = provision(rawPostgres({ name: 'database' }));
    const service = provision(authService, {
      id: 'service',
      deps: { db },
      input: { signingKey: input.signingKey },
    });
    return { rpc: service.rpc };
  },
);
```

The file doc comment above the imports gains, as its last paragraph: `The signing key is a secretString() field of the module's input. The root binds it to a platform variable; this module never learns the name.`

`module.ts`: the comment and `provision(authModule, { … })` become:

```ts
  // The root binds the auth module's signingKey to the platform variable
  // AUTH_SIGNING_SECRET; preflight fills it from the secrets pool when missing.
  const auth = provision(authModule, {
    input: { signingKey: envSecret('AUTH_SIGNING_SECRET') },
  });
```

`modules/auth/src/service.ts`: the comment "The auth module forwards its boundary secret slot as this field's binding leaf" becomes "The auth module passes its own `signingKey` input field on as this field's binding". `module.test.ts`, `prisma.config.ts` and `.env.example` do not change.

`.github/workflows/e2e-deploy.yml`: the comment line `# The root binds the auth module's secret need to AUTH_SIGNING_SECRET (ADR-0029).` becomes `# The root binds the auth module's signingKey input to AUTH_SIGNING_SECRET (ADR-0029).`

### 5.5 Lockfile

`pnpm install` regenerates `pnpm-lock.yaml` after the two `dotenv` removals. CI installs with `--frozen-lockfile`.

## 6. Documentation

All in the same pull request, per `.agents/rules/user-facing-surface-changes.mdc`. Each amendment note goes directly after the decision's last existing note.

### 6.1 Decision records

- **The module boundary decision**, `ADR-0016-…md`, verbatim:

  > Amended `<date>` (module-input project, fifth slice): the module `params` and `secrets` slots are removed from the code, with `paramNeed()` and the module form of `secret()`. `module()` refuses a `params` or `secrets` key, and `provision()` of a module refuses a `params` or `secrets` map, each with an error that names `input`. A module's boundary is `deps` and `expose`; its configuration is `input`.

  Index line gains: ``*(Amended `<date>`: the module slots are removed; `module()` and `provision()` refuse `params` and `secrets`.)*``
- **The secrets decision**, `ADR-0029-…md`, verbatim:

  > Amended `<date>` (module-input project, fifth slice): `secret()`, `SecretNeed`, `Secrets` and `SecretBindings` are removed, with the module `secrets` slot. What the Decision below calls a module's secret need is now a `secretString()` field of the module's `input`, which the module passes on and the root binds with `envSecret('NAME')`. So the module still never learns the platform name. `secretSource()`, `isSecretSource()` and `envSecret()` are unchanged.

  Index line gains: ``*(Amended `<date>`: `secret()` and the module `secrets` slot are removed; a module takes a secret as a `secretString()` input field.)*``
- **The provision-time params decision**, `ADR-0032-…md`, verbatim:

  > Amended `<date>` (module-input project, fifth slice): `paramNeed()`, `ParamNeed`, `ParamNeeds` and `ParamNeedBindings` are removed, with the module `params` slot. A module takes a value as a field of its `input`, which takes a literal as well as a source, so the rule that a module param slot takes only a source is gone with the slot. A service's per-key `params`, `paramSource()` and `envParam()` are unchanged.

  Index line gains: ``*(Amended `<date>`: `paramNeed()` and the module `params` slot are removed; a service's params are unchanged.)*``
- **The module input decision**, `ADR-0061-…md`, verbatim:

  > Amended `<date>` (module-input project, fifth slice): the slots are removed from the code, as the Consequences below say. `module()` refuses a `params` or `secrets` key, and `provision()` of a module refuses a `params` or `secrets` map, with errors that name `input`. `ModuleNode` and `ModuleContext` lose their slot type parameters: `ModuleNode<D, E, I>` and `ModuleContext<D, I>`. `auth()` and `email()` declare `input`.

  Index line gains: ``*(Amended `<date>`, fifth slice: the slots are removed; `ModuleNode<D, E, I>`.)*``
- **The service input decision**, `ADR-0042-…md`, verbatim:

  > Amended `<date>` (module-input project, fifth slice): the entry for the secrets decision below says the forwardable secret need (`secret()`) survives. It does not: a module takes a secret as a `secretString()` field of its own `input` (ADR-0061), so the one-schema model covers modules too.

  Index line gains: ``*(Amended `<date>`: the forwardable secret need is removed; a module takes a secret as an input field.)*``

### 6.2 Domain docs

- **`docs/design/10-domains/module-composition.md`**:
  - The header gains a second amendment line: `> Amended by the module-input project (<date>): the module \`params\` and \`secrets\` slots are removed; \`module()\` and \`provision()\` refuse them.`
  - § Input, "Nowhere else: not as a `provision()` id, not in `deps`, not in a module's `secrets` or `params` binding, and not as an `expose` return." becomes "Nowhere else: not as a `provision()` id, not in `deps`, and not as an `expose` return."
  - The boundary section gains a last bullet after the one on `provision`'s id: `- \`module()\` refuses a \`params\` or \`secrets\` key when it is called, before Load starts, with an error naming \`input\`: a module takes its configuration only through \`input\`.` (`module()` throws a plain `Error` at construction, so this refusal is not a Load error.)
  - § Load, the "Boundary validation" list gains a last bullet: `- a \`params\` or \`secrets\` map on a module's \`provision()\`: a module takes its configuration only through \`input\`.`
- **`docs/design/10-domains/config-params.md`**:
  - The header gains a third amendment line: `> Amended by the module-input project (<date>): the module slots are removed from the code; § Secrets and the table below describe \`input\`.`
  - The sentence "A module boundary forwards a binding down to a child through a nameless `paramNeed()` slot, the same way it forwards a secret need." becomes "A module passes a binding down to a child as a field of its own `input`."
  - § Sources are values: the rows `A module's \`secrets\` slot` and `A module's \`params\` slot` are removed. "A service's input binding, a service's params and a module's `secrets` and `params` slots receive the source itself" becomes "A service's input binding and a service's params receive the source itself".
  - § Secrets: the first paragraph becomes: `A secret is **not** a param (ADR-0029). The value is provisioned out-of-band on the platform; the framework carries only the NAME. A service types the field \`secretString()\` in its input schema; a module declares the same field in its own \`input\` and passes it on; the root binds it to a platform variable with \`envSecret('NAME')\`. The service reads it back through \`service.input()\` as a redacting \`SecretString\`:` The code block becomes:

    ```ts
    // A service declares the field's type — no platform name here:
    compute({ name: 'auth', input: type({ signingKey: secretString() }), build: … });

    // A module declares the same field in its input and passes it on:
    module('auth', { input: type({ signingKey: secretString() }), expose: … }, ({ input, provision }) =>
      provision(inner, { input: { signingKey: input.signingKey } }),
    );

    // Only the ROOT names the platform variable (envSecret is the TARGET's, from
    // @prisma/composer-prisma-cloud; secretString() is core's, from @prisma/composer/arktype):
    provision(auth, { input: { signingKey: envSecret('AUTH_SIGNING_KEY') } });

    // Read at the point of use — expose() is the sole reader:
    const { signingKey } = service.input(); // SecretString
    signingKey.expose();                     // the one door to the value
    ```

    The paragraph after it becomes: `\`service.input()\` returns the whole validated input. A \`SecretString\` redacts under \`toString\`/\`toJSON\`/\`valueOf\`/\`inspect\`, so a stray log or serialization prints \`[REDACTED]\`; only \`expose()\` returns the value. \`secretString()\` and the opaque \`SecretSource\` are core (\`@prisma/composer\`); \`envSecret('NAME')\`, the source constructor that names and validates a platform variable, is the target's, from \`@prisma/composer-prisma-cloud\` (ADR-0018/0019 applied to secrets).` Step 1 of the round trip, "**Bind + forward.** The root binds each need to a platform name and wires it down the module topology (the same rail dependencies use).", becomes "**Bind.** The root binds each secret field to a platform name, and each module on the way passes it on as a field of its input." The rest of the step, "Load records one binding per resolved service secret slot: `{ serviceAddress, slot, name }`.", becomes "Load records each service's input binding, and preflight collects every `envSecret()` it names." The rest of § Secrets does not change.
  - § Introspection, the bullet "**Secrets are not params.** A secret is a distinct forwardable slot (§ Secrets, ADR-0029), read through `secrets()` as a `SecretBox` — sensitivity is carried by the type, never a param facet." becomes "**Secrets are not params.** A secret is a `secretString()` field of an input schema (§ Secrets, ADR-0029, ADR-0042), read through `service.input()` as a `SecretString`: sensitivity is carried by the type, never a param facet."
- **`docs/design/10-domains/core-model.md`**: the `ConfigParam` comment "A param is never secret — a secret is its own forwardable slot, declared with secret() and read with secrets() (ADR-0029)." becomes "A param is never secret: a secret is a secretString() field of an input schema, bound with envSecret() (ADR-0029, ADR-0042)." The `ConfigDeclaration` comment "Secrets are not here — they live on their own slot (ADR-0029)." becomes "Secrets are not here: they are secretString() fields of a service's input (ADR-0029)."
- **The glossary** does not change. No entry describes the slots (§ 14, conflict 1).

### 6.3 Guides

- **`docs/guides/building-an-app.md`**, § Reusable Modules:
  - "The builder function receives `provision`, the boundary's forwarded `deps`, `secrets` and `params`, the module's `input`" becomes "The builder function receives `provision`, the boundary's forwarded `deps`, the module's `input`".
  - The example becomes:

    ```ts
    import { module } from '@prisma/composer';
    import { secretString } from '@prisma/composer/arktype';
    import { rawPostgres } from '@prisma/composer-prisma-cloud';
    import { type } from 'arktype';

    export default module(
      'auth',
      { input: type({ signingKey: secretString() }), expose: { rpc: authContract } },
      ({ input, provision }) => {
        const db = provision(rawPostgres({ name: 'database' }));
        const service = provision(authService, {
          id: 'service',
          deps: { db },
          input: { signingKey: input.signingKey },
        });
        return { rpc: service.rpc };
      },
    );
    ```

  - The paragraph "The boundary still declares `secrets: { signingKey: secret() }` — a nameless need …" becomes: `The module declares \`signingKey\` as a \`secretString()\` field of its input and passes it on without learning the platform variable's name. Inside, the field is just another leaf of the service's input binding ([below](#service-input)).`
  - The root snippet becomes `const auth = provision(authModule, { input: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });` followed by the unchanged `provision(storefrontService, …)` line.
  - The `provision(node, opts?)` list loses the `secrets` bullet.
- **`docs/guides/building-an-app.md`**, § A module's input: a last bullet, verbatim: `- Before Composer 0.37, a module declared per-key \`params\` with \`paramNeed()\` and \`secrets\` with \`secret()\`, bound with \`provision(module, { params, secrets })\`. Both are gone, and \`module()\` and \`provision()\` refuse them with an error naming \`input\`. Declare each one as a field of the module's \`input\` schema, a secret as a \`secretString()\` field, and bind them all with \`input\`; \`auth()\` and \`email()\` take \`input\` the same way. A service's \`params\` do not change.`
- **`docs/guides/building-an-app.md`**, § Service input: "A reusable Module forwards a secret need up to its parent without ever learning the platform name ([above](#reusable-modules))" becomes "A reusable Module takes a secret as a `secretString()` field of its `input` and passes it on without ever learning the platform name ([above](#reusable-modules))". The rest of the sentence does not change.
- **`docs/guides/building-an-app.md`**, § Values that differ per environment: "A value cannot be a provision id or a `deps` entry, and a module's `secrets` and `params` bindings take only sources, which are values too." becomes "A value cannot be a provision id or a `deps` entry."
- **`docs/guides/building-an-app.md`**, § Digging deeper: "[ADR-0029](…) for the forwardable secret need, and" becomes "[ADR-0029](…) for secrets, which the deploy carries by name only, and".
- **The website** renders `docs/guides/*.md` at build time into `website/src/generated/`, which git ignores. No tracked website file changes. `website/tests/content.test.ts` checks the guides' in-site links; no heading this slice touches is renamed.

### 6.4 The agent skill

`skills/prisma-composer-core-concepts/SKILL.md`, written to the rules in `skills/README.md`:

- The node table's Module row: "its builder receives `deps`, `secrets`, `params`, `environment` and `provision`" becomes "its builder receives `deps`, `input`, `environment` and `provision`".
- Rule 5 of "Rules that bite", under "Two channels: dependencies and input", becomes, verbatim: `5. **A Module passes a secret on without learning the platform name.** Declare a \`secretString()\` field in the Module's \`input\` and pass \`input.<field>\` on as a binding leaf; the parent binds \`envSecret('NAME')\`. A module has no \`params\` or \`secrets\` slots: \`module()\` and \`provision()\` refuse both, naming \`input\`. A service's \`params\` stay.`
- Under "Values that differ per environment": "Never as a provision id or a `deps` entry; a module's `secrets` and `params` bindings take only sources." becomes "Never as a provision id or a `deps` entry."
- The building-blocks table: the `auth` row's "What it provisions" cell gains, at its end: `Bind \`input: { baseUrl }\`, the public app origin: \`serviceOrigin('<app>.<service>')\`, \`envParam(...)\` or a literal.` The `email` row's cell gains: `Bind \`input: { deliveryMode, from, deliveryCredential }\`; the credential with \`envSecret(...)\`, required even when \`deliveryMode\` is \`none\`.`

### 6.5 Repo notes

- **`gotchas.md`**, "Composer's secret model has no optional/conditional secrets…", **Reproduction**: step 1 becomes `1. Provision \`email()\` with \`input: { deliveryMode: envParam('EMAIL_DELIVERY_MODE'), from: envParam('EMAIL_FROM'), deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') }\` and leave \`EMAIL_DELIVERY_CREDENTIAL\` unset in an environment where \`EMAIL_DELIVERY_MODE=none\`.`; step 2's "the secret slot is unbound" becomes "the platform variable is missing".
- **`gotchas.md`**, "Module-boundary param slots admit only sources, never a literal…": a line after the **Cost** line, verbatim: `**Fixed in Prisma Composer** (module-input project, <date>): a module takes its configuration through one \`input\` schema, and its input binding takes a literal as well as a source. \`paramNeed()\` and \`ParamNeedBindings\` are removed. \`email()\` keeps \`deliveryUrl\` as a factory option.` The rest of the entry stays as the record of what was hit.
- **`.drive/deferred.md`**: the entry "A spread copy of a source (the ctx.secrets and ctx.params refs) does not throw when turned into text, … Removed with the module slots in S5." is removed. The copies no longer exist.

## 7. Release notes

The repo has no changesets. A merged root version bump publishes `latest` and creates a GitHub Release with `gh release create --generate-notes`, whose notes list the merged pull requests by title (`.github/workflows/publish.yml`, `docs/oss/versioning.md`). So the pull request carries the release note:

- **Title**, a conventional commit marked breaking, as `feat(node)!:` was for `dependencies`: `feat(core)!: a module takes its configuration only through input`.
- **Description**, a section `## Breaking change` holding, in this order: the § 1 before/after example; the removed exports (`paramNeed`, `secret`, `ParamNeed`, `ParamNeeds`, `ParamNeedBindings`, `SecretNeed`, `Secrets`, `SecretBindings`); that `ModuleNode` and `ModuleContext` lose their slot type parameters, so `ModuleNode<D, E, S, PN, I>` becomes `ModuleNode<D, E, I>`; the `email()` and `auth()` before/after:

  ```ts
  // before
  provision(email(), {
    params: { deliveryMode: envParam('EMAIL_DELIVERY_MODE'), from: envParam('EMAIL_FROM') },
    secrets: { deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') },
  });
  provision(auth(), { deps: { db, email: mail.send }, params: { baseUrl: serviceOrigin('shop.web') } });

  // after
  provision(email(), {
    input: {
      deliveryMode: envParam('EMAIL_DELIVERY_MODE'),
      from: envParam('EMAIL_FROM'),
      deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL'),
    },
  });
  provision(auth(), { deps: { db, email: mail.send }, input: { baseUrl: serviceOrigin('shop.web') } });
  ```

  and one sentence: `An envParam() in a module's input is read at deploy, so an unset EMAIL_FROM now fails when the graph loads, with the email module's schema message, instead of at serialize with the service's.`

The guide's "Before Composer 0.37" bullet (§ 6.3) is the user-facing migration note, as the guide's "Before Composer 0.36 this field was called `inputs`" note was for `deps`.

## 8. What breaks, and what does not

Breaks, for code that used the old surface:

1. `module(name, { params })` and `module(name, { secrets })`: a compile error, and at run time the § 3.3 errors.
2. `provision(module, { params })` and `provision(module, { secrets })`: a compile error, and at Load the § 3.5 errors.
3. Imports of the eight removed names; `ctx.secrets` and `ctx.params` in a module body; a `ModuleNode` or `ModuleContext` written with four or five type arguments.
4. `email()` and `auth()` bound with `params` or `secrets`.

Unchanged:

1. **A service's params.** `provision(service, { params })` takes a literal or a source as today (§ 10, the kept `params.test.ts` tests).
2. **The wire format.** A service's input document holds the same values and `$secret` and `$generated` pointers as when a module forwarded the source through a slot. `envParam()` in a module's input reaches the service as the string the serializer would have read (S3).
3. **Preflight and boot.** Every `envSecret()` the graph names is still checked (S3's `secretSources`).
4. **`email()` and `auth()`**: their names, options, ports and services.
5. **The examples** deploy and serve as before (§ 11, QA).

The only existing tests this slice changes are listed in § 10.4. If any other existing test fails, the implementer stops and reports.

## 9. Scope

In: `packages/0-framework/1-core/core` (§ 3); `packages/1-prisma-cloud/2-shared-modules/{auth,email,storage,streams}` (§ 4); `packages/1-prisma-cloud/1-extensions/target` (tests only, § 10.4); `examples/{auth,email,storefront-auth}` (§ 5); `.github/workflows/e2e-deploy.yml` (one comment); `pnpm-lock.yaml`; `docs/`, `skills/`, `gotchas.md`, `.drive/deferred.md` (§ 6).

Out: deprecating `envParam()`; the absent-key report for an `envParam()` in a module's input (deferred by S3); optional delivery credentials for `email()`; any change to `cron()`, `storage()` or `streams()` beyond the type arguments; the project close-out (moving `design-notes.md` into `docs/design/`, deleting `.drive/projects/module-input/`).

## 10. Tests

Runtime tests use `bun test`; type tests use vitest `expectTypeOf` and `@ts-expect-error`. A test that injects a retired key casts with `blindCast` and a reason, as `params.test.ts` does. Core fixtures follow `module-input.test.ts`: `echoService()`, `loadError()`.

### 10.1 Core: new file `packages/0-framework/1-core/core/src/__tests__/module-retired-slots.test.ts`

1. `module() refuses a params key, naming input` — the exact § 3.3 message for `module("relay")`.
2. `module() refuses a secrets key, naming input` — the exact § 3.3 message.
3. `module() refuses a params key whose value is undefined`.
4. `provision() of a module refuses a secrets map, naming input` — a root provisions `module('relay', {}, () => {})` with `{ id: 'relay', secrets: { key: secretSource({ name: 'K' }) } }`; the exact § 3.5 message.
5. `provision() of a module refuses a params map, naming input` — the same with `params: { origin: paramSource({ name: 'O' }) }`; the exact § 3.5 message.
6. `a module body receives deps, environment, input and provision, nothing else` — the body records `Object.keys(ctx).sort()`; it is `['deps', 'environment', 'input', 'provision']`, for a closed root and for a module with a boundary.
7. `a module node carries no slot fields` — `Object.keys(module('m', {}, () => {})).sort()` is `['body', 'deps', 'expose', 'inputSchema', 'kind', 'name']`.
8. `the removed names are not exported` — `import * as core from '../exports/index.ts'`; `'paramNeed' in core` and `'secret' in core` are false.

### 10.2 Core: new file `packages/0-framework/1-core/core/src/__tests__/module-retired-slots.test-d.ts`

9. `module() takes no params or secrets key` — `@ts-expect-error` on `module('m', { params: {} }, () => {})` and on `module('m', { secrets: {} }, () => {})`.
10. `provision() of a module takes no params or secrets map` — for `m = module('m', { input: type({ from: 'string' }) }, () => {})`, `@ts-expect-error` on `provision(m, { input: { from: 'a' }, params: {} })` and on the same with `secrets: {}`.
11. `a module body has no secrets or params` — `@ts-expect-error` on `module('m', {}, ({ secrets }) => {})` and on `({ params })`.
12. `ModuleNode takes three type parameters` — `expectTypeOf<ModuleNode<Record<never, never>, Record<never, never>, undefined>['inputSchema']>().toEqualTypeOf<undefined>()`, and `@ts-expect-error` on a type alias `ModuleNode<Record<never, never>, Record<never, never>, undefined, Record<never, never>>`.
13. `the removed types are not exported` — `import type * as Core from '../exports/index.ts'`; `@ts-expect-error` on `expectTypeOf<Core.X>()` for each of `ParamNeed`, `ParamNeeds`, `ParamNeedBindings`, `SecretNeed`, `Secrets`, `SecretBindings`.

### 10.3 Shared modules and examples

`email/src/__tests__/module.test.ts`: the helper `rootWithEmail()` binds `input: { deliveryMode: envParam('EMAIL_DELIVERY_MODE'), from: envParam('EMAIL_FROM'), deliveryCredential: envSecret('EMAIL_DELIVERY_CREDENTIAL') }`, with `envParam` and `envSecret` from `@internal/prisma-cloud`, and every `Load` passes `{ configPool: { EMAIL_DELIVERY_MODE: 'none', EMAIL_FROM: 'shop@example.com' } }`. Every test that bound `params` and `secrets` binds that `input`. The file doc comment's "forwards its boundary `deliveryMode`/`from` params and `deliveryCredential` secret down to the service" becomes "passes its input on to the service". The helper `sourcePayload` and the imports `isParamSource`, `paramSource`, `secretSource` are removed; `secretName` is imported from `@internal/prisma-cloud`.

14. Replaces `boundary params and secret forward into the service's input binding, mapped to their bound env sources (ADR-0042)`: `the module's input reaches the service's input: envParam() fields as their values, envSecret() as its source` — the binding's `deliveryMode` is `'none'`, `from` is `'shop@example.com'`, `secretName(binding.deliveryCredential, 'deliveryCredential')` is `'EMAIL_DELIVERY_CREDENTIAL'`, and `deliveryUrl` is `'https://api.resend.com'`.
15. `a literal binds a field, as in a service's input` — `deliveryMode: 'smtp'`; the binding holds `'smtp'`.
16. `the module's schema refuses a missing from before the service's does` — `configPool: { EMAIL_DELIVERY_MODE: 'none' }`; the message is exactly `The input binding of module "root.email" does not match the module's input schema: from must be a string (was missing)`.

`email/src/__tests__/module.test-d.ts`: imports drop `ParamNeed`, `SecretNeed`, `paramSource`, `secretSource`; add `StandardSchemaV1` from `@standard-schema/spec`, `SecretString` from `@internal/core`, and `envParam`, `envSecret` from `@internal/prisma-cloud`.

17. Replaces `email() is a ModuleNode exposing send and outbox ports over module-boundary params/secret`: `email() is a ModuleNode exposing send and outbox, with an input schema` — `const asModule: ModuleNode<Record<never, never>, { send: …; outbox: … }, StandardSchemaV1> = m;`.
18. `email()'s input is deliveryMode, from and a secret deliveryCredential` — `StandardSchemaV1.InferInput<NonNullable<ReturnType<typeof email>['inputSchema']>>` equals `{ deliveryMode: string; from: string; deliveryCredential: SecretString }`.
19. The two wiring tests bind the § 1 `input`.
20. `email() needs its input, takes a value of the root's narrower type, and refuses a plain string credential` — `@ts-expect-error` on `provision(email())`; a field typed `Value<'resend' | 'smtp' | 'none'>` fits `deliveryMode`; `@ts-expect-error` on `deliveryCredential: 'plain'`; `@ts-expect-error` on a `params` map.

`auth/src/__tests__/module.test.ts`: `rootWithAuth()` and the `signUp` and custom-name tests bind `input: { baseUrl: serviceOrigin('root.app') }` with `serviceOrigin` from `@internal/prisma-cloud`. The doc comment's "the `baseUrl` boundary param forwards down into that same input" becomes "the `baseUrl` input passes into that same input". `sourcePayload` and the imports `isParamSource`, `isSecretSource`, `paramSource` are removed; `isOriginParamSource` is imported from `@internal/prisma-cloud`.

21. Replaces `forwards the baseUrl boundary param down into the service input`: `the baseUrl input reaches the service's input: serviceOrigin() as its source` — `isOriginParamSource(binding.baseUrl)` is true.
22. `an envParam() baseUrl reaches the service as its value at deploy` — `envParam('AUTH_BASE_URL')`, `configPool: { AUTH_BASE_URL: 'https://app.example' }`; the binding holds `'https://app.example'`.
23. `a literal baseUrl reaches the service unchanged` — `'https://app.example'`.

`auth/src/__tests__/contract.test-d.ts`: imports drop `ParamNeed` and `paramSource`; add `StandardSchemaV1`, and `envParam`, `serviceOrigin` from `@internal/prisma-cloud`.

24. Replaces `auth() is a ModuleNode with the db + email boundary deps, three ports, and the baseUrl param need`: `auth() is a ModuleNode with the db + email boundary deps, three ports, and an input schema` — the third type argument is `StandardSchemaV1`.
25. `auth()'s input is baseUrl, a string` — the inferred input equals `{ baseUrl: string }`.
26. The wiring test binds `input: { baseUrl: serviceOrigin('root.app') }`.
27. `auth() takes baseUrl as serviceOrigin(), envParam() or a literal, and nothing else` — the three compile; `@ts-expect-error` on `baseUrl: 4`; `@ts-expect-error` on `params: { baseUrl: … }`.

New file `examples/email/tests/module.test.ts`, importing `Load` from `@prisma/composer`, `secretName` from `@prisma/composer-prisma-cloud`, and `root` from `../module.ts`:

28. `the root's input from the config pool reaches the email service` — `Load(root, { configPool: { EMAIL_DELIVERY_MODE: 'none', EMAIL_FROM: 'a@example.com', PATH: '/bin' } })`; the binding of `email-example.email.service` has `deliveryMode` `'none'`, `from` `'a@example.com'`, and `secretName(deliveryCredential, …)` `'EMAIL_DELIVERY_CREDENTIAL'`.
29. `a delivery mode the root's schema does not name fails before anything is created` — `EMAIL_DELIVERY_MODE: 'smpt'`; the message starts with `The input of root module "email-example" does not match its input schema: EMAIL_DELIVERY_MODE must be ` and contains `(was "smpt")`.

New file `examples/auth/tests/module.test.ts`, importing `Load` from `@prisma/composer`, `isOriginParamSource` and `secretName` from `@prisma/composer-prisma-cloud`, and `root` from `../module.ts`:

30. `the root binds the email module's input from the config pool and auth's baseUrl to the api's origin` — `Load(root, { configPool: { EMAIL_DELIVERY_MODE: 'none', EMAIL_FROM: 'dev@example.com' } })`; `auth-example.mail.service`'s binding has `deliveryMode` `'none'`, `from` `'dev@example.com'` and the credential named `EMAIL_DELIVERY_CREDENTIAL`; `auth-example.auth.service`'s `baseUrl` satisfies `isOriginParamSource`.

`examples/storefront-auth/module.test.ts` does not change and must pass.

### 10.4 Existing tests whose subject changed

Core, `packages/0-framework/1-core/core/src/__tests__/`:

- `secrets.test.ts`: removed: `a module forwards a secret slot into an inner service input binding (the multi-level case)`, `a module that declares a secret but never forwards it fails`, `a forwarded secret counts as used wherever it nests inside an input binding`, `a forwarded secret nested inside an unrelated source payload is not falsely marked used`, `a root module that declares its own secret slot fails — the root binds, it does not declare`, `a non-secret value wired into a module secret slot is rejected`, `branded copies keep used-tracking per-slot — …`. `a cyclic input binding completes and the forwarded secret is still marked used` becomes `a cyclic service input binding completes Load`: the root binds the cyclic object, holding `key: secretSource('AUTH_KEY')`, on `svcWithInput('inner')` directly; `graph.inputBindings` has length 1. `secretSource builds a secret source; secret() and plain values are not` becomes `secretSource builds a secret source; plain values are not`, without the `secret()` line. The `secret` import is removed.
- `params.test.ts`: removed: `a module forwards a param source to an inner service (the multi-level case)`, `a module that declares a param-forwarding slot but never forwards it fails`, `a root module that declares its own param-forwarding slot fails — …`, `a declared module param-forwarding slot left unbound in a provision fails at Load`, `a non-source value wired into a module param-forwarding slot is rejected`, `an extra param key naming a non-slot fails at Load on a module target`, `branded copies keep used-tracking per-slot — …`. `paramSource builds a param source; paramNeed() and plain values are not` becomes `paramSource builds a param source; plain values are not`, without the `paramNeed()` line. The file doc comment's sentence about "a nameless `paramNeed()` slot" is removed. The `paramNeed` import is removed.
- `params.test-d.ts`: `a module param-forwarding slot accepts only a ParamSource, …` is removed; `paramSource() is a ParamSource and a value; paramNeed() is a ParamNeed` becomes `paramSource() is a ParamSource and a value`; the doc comment's `paramNeed()` clause is removed.
- `config.test-d.ts`: `secret() is a SecretNeed; secretSource() is a SecretSource and a value` becomes `secretSource() is a SecretSource and a value`, without the `secret()` line; `SecretNeed` and `secret` imports removed.
- `source-value.test-d.ts`: `a Value<SecretString> that is not a source does not fit a module's secrets slot` becomes `a Value<SecretString> that is not a source is not a SecretSource`, keeping only its first assertion; `SecretBindings` and `SecretNeed` imports removed.
- `source-load.test.ts`: removed: `a source bound to a module's secrets slot and forwarded reaches the service with the same payload`, `a param source with a pool key bound to a module's params slot and forwarded reaches the service param unchanged`, `a forwarded secrets slot listed only in a resolve() dependency counts as forwarded`. Imports no longer used are removed.
- `module-input.test.ts`: removed: `a forwarded secrets slot inside a module's input binding counts as used`, `an input field bound to a module's secrets slot fails with the existing message` (test 4 covers the map). The `secret` import is removed.
- `module-input.test-d.ts`: `a module that declares secrets and input needs both bound` is removed; in `a module that declares no input receives undefined`, `ModuleContext<Record<never, never>, Record<never, never>, Record<never, never>, undefined>` becomes `ModuleContext<Record<never, never>, undefined>`; the `secret` import is removed.
- `resolve-values.test.ts`: removed: `a value as a module secrets binding fails`, `a value as a module params binding fails`; the `secret` and `paramNeed` imports are removed.

Prisma Cloud target, `packages/1-prisma-cloud/1-extensions/target/src/__tests__/`:

- `sources.test-d.ts`: `each source still fits a module's params or secrets slot, and envParam() a number param` becomes `each source fits a module's input field of its type, and envParam() a service param`: `relay` declares `input: type({ origin: 'string', token: secretString(), base: 'string', key: secretString() })` (`secretString` from `@internal/foundation/arktype`, `type` from `arktype`) and the root binds `input: { origin: envParam('ORIGIN'), token: generatedParam(), base: serviceOrigin('shop.web'), key: envSecret('KEY') }`; the `compute` provision with `params: { port: envParam('PORT') }` stays. The `paramNeed` and `secret` imports are removed.
- `env-key-clash.test.ts`: `EmptyModule` becomes `ModuleNode<Record<never, never>, Record<never, never>, undefined>`.

## 11. Done when

- Tests 1 to 30 pass; `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:casts`, `pnpm lint:deps`, `pnpm test` are green at the root.
- `git grep -nE "paramNeed|ParamNeed|SecretNeed|SecretBindings|secretSlots|paramSlots|secret\(\)|ctx\.secrets|ctx\.params" -- packages examples docs/guides skills .github` finds nothing. In `docs/design/` it finds only the decision records and the amendment lines at the top of `config-params.md` and `module-composition.md`.
- `git ls-files examples | grep '/\.env'` lists exactly `examples/auth/.env.example`, `examples/email/.env.example` and `examples/storefront-auth/.env.example`.
- Every document in § 6 is updated.
- Manual QA, recorded in `qa.md` in this slice's folder, with the repo's deploy credentials and `PRISMA_REGION=us-east-1` exported, after `pnpm build`. Every `pnpm deploy` below is `pnpm run deploy`, because `pnpm deploy` is pnpm's own command.
  1. **The email example, deployed, root input from `.env.production`.** In `examples/email`, with no `.env` and with `EMAIL_DELIVERY_MODE`, `EMAIL_FROM` and `EMAIL_DELIVERY_CREDENTIAL` unset in the shell, create `.env.production` holding `EMAIL_DELIVERY_MODE=none` and `EMAIL_FROM=s5-qa-production@example.com`, and `.env.production.local` holding `EMAIL_DELIVERY_CREDENTIAL=s5-qa-unused-credential`. `EMAIL_STACK_NAME=s5qa-email pnpm run deploy` succeeds, and its preflight step reports one filled setting. `EMAIL_STACK_NAME=s5qa-email pnpm run smoke:deployed` passes. With the `mailer URL` the smoke printed, `curl -sS -X POST "$URL/signup" -H 'content-type: application/json' -d '{"email":"s5-qa@example.com","name":"S5 QA"}'` returns an `id`, and `curl -sS "$URL/emails/$ID"` shows `"from":"s5-qa-production@example.com"`. Neither the deploy output nor `grep -r s5-qa-unused-credential .prisma-composer .prisma` shows the credential.
  2. **The root's schema stops a bad value first.** Change `.env.production` to `EMAIL_DELIVERY_MODE=smpt`. `EMAIL_STACK_NAME=s5qa-email pnpm run deploy` fails before anything is created, with the root message for the environment `production` and `(was "smpt")`. Change it back to `none`.
  3. **`prisma dev` of the email example, root input from `.env.dev`.** Create `.env.dev` holding `EMAIL_DELIVERY_MODE=none`, `EMAIL_FROM=s5-qa-dev@example.com` and `EMAIL_DELIVERY_CREDENTIAL=local-dev-unused`. `prisma dev --detach`; then with `URL=$(prisma dev url email-example.mailer)`, the same two `curl` calls show `"from":"s5-qa-dev@example.com"`. `prisma dev stop`.
  4. **The auth example, deployed.** The workspace's project list must not hold `auth-example`, because `serviceOrigin('auth-example.api')` ties the example to its own name; if it does, stop and report. In `examples/auth`, `cp .env.example .env`; `pnpm run deploy` succeeds; `pnpm run smoke:deployed` passes every check.
  5. **The storefront-auth example, deployed.** In `examples/storefront-auth`, `AUTH_SIGNING_SECRET=sk_test_ci_storefront_auth STOREFRONT_STACK_NAME=s5qa-storefront pnpm run deploy` succeeds, and `STACK_NAME=s5qa-storefront bash scripts/e2e-verify.sh` passes.
  6. **Tear down.** Each destroy Loads the graph, so each example's `.env` files stay in place until its destroy has finished. `EMAIL_STACK_NAME=s5qa-email pnpm run destroy` in `examples/email`; `pnpm run destroy` in `examples/auth`; `STOREFRONT_STACK_NAME=s5qa-storefront pnpm run destroy` in `examples/storefront-auth`. Each prints `Destroyed.` or that it removed the Project. Then remove `examples/email/.env.production`, `.env.production.local` and `.env.dev`, and `examples/auth/.env`. The workspace's project list holds no `s5qa-email`, `auth-example` or `s5qa-storefront`, and `git status` shows only this slice's changes.

## 12. How a reviewer checks the decisions

Each decision in § 13 has a test that fails when the behavior breaks: decision 1 by tests 1 to 5; 2 by tests 12, 13 and the type check of `storage`, `streams` and `env-key-clash.test.ts`; 3 by tests 16, 20 and 29; 4 by tests 18 and 25; 5 by tests 28 to 30 and QA 1 to 5; 6 by the PR title and description (checked by the reviewer); 7 by `pnpm install --frozen-lockfile` in CI; 8 by QA 1, whose smoke run uses the fixed lookup.

## 13. Decisions this spec records, for the review

1. **The retired keys are refused with an error naming `input`, not ignored** (§ 3.3, § 3.5). Without the checks, a JavaScript caller, or one that casts, would lose its bindings silently: a `secrets` map would vanish and the service would fail later with a schema message that does not say why. This follows the `composer` section decision's precedent, which refuses retired fields with `CONFIG.FIELD_RETIRED` and never migrates them. The brief asked to remove the Load checks for the slots; those are removed, and these four errors replace them.
2. **`ModuleNode<D, E, I>` and `ModuleContext<D, I>`** (§ 3.2). Leaving `S` and `PN` in place as unused parameters would keep a type surface for slots that no longer exist. `module-composition.md` already documents `ModuleNode<D, E, I>`. Two shared modules, `storage` and `streams`, wrote `Record<never, never>` as the third argument for the empty secret slots; that argument is now `I`, so they pass `undefined` there.
3. **`email()`'s schema types `deliveryMode` as `'string'`, not as the three modes** (§ 4.1). `envParam()` is typed `Value<string>`, and a value of type `string` does not fit a field typed `'resend' | 'smtp' | 'none'` (`ModuleInputBinding` follows the field's type, as S3's `{ n: number }` test shows). The narrow type would make the before/after migration of § 7 fail to compile. The module input decision says a module that only forwards a value can use a permissive schema; the email service's own schema still checks the mode before anything is created. A root that wants an earlier check types its own field narrowly, as the email example does, and a value of the narrow type fits the module's `string` field.
4. **Each module's input schema is a module-level constant that is not exported** (§ 4.1, § 4.2). The return type names it with `typeof`, so the declaration file carries its type; exporting it would add public surface no one asked for.
5. **The examples, per example** (§ 5.1). `email` shows the new root surface: `input` from `[dotenv(), environmentVariables()]` and a committed `.env.example`. `auth` shows an `envParam()` and a `serviceOrigin()` in a module's input, the two sources the brief names for `baseUrl`, and also moves to `dotenv()`. `storefront-auth` keeps its root's `envSecret()`, because a root's input takes no secret (S4), and keeps its config, because CI sets `AUTH_SIGNING_SECRET` in the runner's environment. `env-param` is unchanged: it binds a service, not a module, and it is the guide's example of `envParam()`.
6. **The release note is the PR title and a "Breaking change" section** (§ 7). The repo has no changesets; GitHub Release notes are generated from pull request titles. `feat(node)!:` set the precedent for a breaking title.
7. **The `dotenv` devDependency is removed from `examples/email` and `examples/auth`** (§ 5.2, § 5.3). Nothing in either imports it once `import 'dotenv/config'` goes. `storefront-auth` keeps it.
8. **The email smoke script looks up `${stack}.mailer`** (§ 5.2). It looks up `mailer`, which the full-address decision broke; S3's QA found and fixed the same fault in the auth smoke script. QA 1 needs it.
9. **New Load tests in the email and auth examples** (tests 28 to 30). `storefront-auth` already has one; the root input of `email` and the bindings of `auth` are otherwise checked only by a deploy.
10. **The fixed gotcha stays in `gotchas.md`, marked fixed** (§ 6.5), as the file marks upstream fixes, so the record of what users hit is kept.

## 14. Conflicts

1. **The brief asks for the glossary's old slots to disappear.** The glossary has no entry or sentence about the module `params` or `secrets` slots, so this spec changes nothing there (§ 6.2).
2. **The brief names amendment notes on the module boundary, secrets and provision-time params decisions only.** The service input decision says the forwardable secret need "survives", which this slice makes false, and the module input decision's code-level surface changes (`ModuleNode<D, E, I>`, the refusals). This spec amends both too (§ 6.1).
3. **The brief says to remove "the Load checks and errors for them".** This spec removes them and adds four errors that refuse the retired keys (§ 13, decision 1).
4. **The brief says `auth()`'s `baseUrl` is bound with `serviceOrigin(...)` or `envParam(...)`.** Both work, but they behave differently in a module's input: `serviceOrigin()` reaches the service as its source, and `envParam()` as its value at deploy (S3). The service's input document is the same. Two things change for an `envParam()` that a module forwarded through a slot before: an unset variable now fails when the graph loads, with the module's schema message, not at serialize with the service's; and the deploy report's list of absent keys does not name it (deferred by S3). The release note says the first (§ 7).
5. **The brief asks to decide per example where the root bound module params from the shell with `envParam()`.** Only `auth` and `email` did. `storefront-auth` bound a module secret, and `env-param` binds a service (§ 5.1).
6. **The brief asks for "a committed `.env.example`".** `dotenv()` does not read `.env.example`; it is a template a developer copies to `.env` or `.env.<environment>`. The email example's file says so (§ 5.2).
7. **The plan asks for QA of "a root `input` from `.env.<environment>` in `prisma deploy`".** The email smoke script checks only the Project's default Branch, the environment `production`, so QA 1 uses `.env.production`, which is not git-ignored. QA 6 removes it.
8. **The email smoke script is outside "every example's module.ts"** but is broken by the full-address decision, and QA needs it (§ 13, decision 8).
9. **`config-params.md`'s § Secrets predates the one-schema decision** and still describes `secrets()`, `SecretBox` and per-slot pointer rows, under a note that says so. This spec rewrites only what describes `secret()` slots (§ 6.2), not the whole section.
10. **Three documents say the framework has no optional secrets**: `email-module.md`, `email/README.md` and the `gotchas.md` entry's cause. Since the service input decision, a schema can make a secret optional; the email service's schema just does not. That is not about the removed slots, so this spec leaves the three as they are and only fixes the gotcha's reproduction steps (§ 6.5).
11. **`serviceOrigin('auth-example.api')` ties the auth example to its own app name**, so QA cannot deploy it under a throwaway name as the other examples are; QA 4 stops if a project with that name already exists.
12. **Teardown needs the configuration.** `destroy` Loads the graph (S3 review), so the email example's root input and the auth example's `envParam()` values must be readable until its destroy has finished. QA 6 orders the steps for this.

## 15. Settled by the orchestrator

1. **Conflict 10 is fixed here.** `email-module.md`, the email README and the gotcha stop saying a secret cannot be optional: an optional `secretString()` field has been possible since services moved to one input schema. Correct those sentences in this slice.
2. **Conflict 11:** if a project named `auth-example` exists, QA deploys the auth example under a throwaway name with a temporary edit of its `serviceOrigin()` address and `AUTH_STACK_NAME`, reverts the edit afterwards, and tears the throwaway project down. It does not touch the existing project.
