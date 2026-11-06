# ADR-0058: `prisma dev` reads secrets from the app secrets and never invents them

```ts
// prisma.config.ts
import { defineConfig as composer, dotenv, environmentVariables } from '@prisma/composer/config';
// …
composer({ /* … */ config: [dotenv(), environmentVariables()], secrets: [dotenv(), environmentVariables()] })
```

```text
$ prisma dev
prisma dev cannot start:

1 platform variable a service needs has no value:
  - STRIPE_SECRET_KEY  (required by service "shop.billing": stripeKey must be present (was missing))

Set each missing variable where an adapter in prisma.config.ts reads it: the `secrets` list of the `composer` section for a secret, the `config` list for an env-sourced param. environmentVariables() reads the shell you run `prisma dev` from; dotenv() reads .env, .env.local, .env.dev and .env.dev.local beside prisma.config.ts.
```

## Decision

Under `prisma dev`, a secret's value comes only from the app secrets, and an env-sourced param's only from the app configuration ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md)). `prisma dev` reads both in its first process, from the adapters the `composer` section lists, at start and at each rebuild. By default both lists are `[environmentVariables()]`, the shell; `dotenv()` reads `.env` files. Composer never makes up a value and never reads one back from an earlier run.

- **A required secret that is unset or empty stops `prisma dev`.** The error lists every missing variable, the service that needs it, the schema's message, and where to set it. Empty counts as unset.
- **An optional secret that is unset or empty reaches the service as absent.** Its input has no value for that field, and the schema decides what that means, as it does for an unset `envParam` leaf ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)).
- **Required or optional is decided by validation, not by reading the schema.** For each service the dev preflight resolves the input binding with every unset secret left out and calls the schema's `validate`. If that passes, the missing secrets were optional. If it fails, the preflight checks each unset secret alone and names as required only the secrets whose absence alone fails. When no single secret fails alone, the error says the service needs some of them, and calls none of them required. A secret an array position reads is required without a check, because an array position cannot be left out. The deploy preflight decides required or optional for a platform variable with no row by the same method and the same code ([ADR-0064](ADR-0064-a-platform-variable-is-set-on-the-platform-never-by-the-deploy.md)).
- **Env-sourced params get the same sourcing.** A per-key param bound to `envParam()` reads its value from the app configuration. When the value is unset or empty, the param takes its default, or is left out when it is optional; it stops `prisma dev` only when it has no default and is not optional, naming the variable, the service and the param. A value that is not text stops `prisma dev`, naming the variable, the service and the kind of value. Like secrets, params are read fresh each run and fingerprinted, so a changed value redeploys the services that read it.
- **The second process receives the values; it reads none.** `prisma dev` runs Alchemy in a second process at start and at each rebuild. That process runs no adapter. It reads what Load read from the app configuration, and the first process's node addresses, from the app configuration file, `<dev environment dir>/app-configuration-<pid>.json`, readable only by its owner, which `prisma dev` writes before each converge and deletes as soon as that converge ends. It receives the named secrets, the app secrets under the secrets keys of the graph's secret sources, in one environment variable, `PRISMA_COMPOSER_NAMED_SECRETS`, in memory; no secret is written to a file for it.
- **The dev preflight hands the second process a payload.** It travels on the preflight transport that carries deploy's rotation timestamps (`PRISMA_COMPOSER_PREFLIGHT_<extension>`), with a `dev:` prefix that a deploy payload, always a JSON object, never starts with. It names the absent secrets and carries a fingerprint of the current value of each variable that a service's input or params point at, never the value. The serializer leaves an `envSecret` leaf out of the input document only when this payload names it absent.
- **Each local service gets only the variables its own rows point at**: the `$platform` markers in its input document, at any depth, and its param pointer rows. This is a rule of the local target. On Prisma Cloud every deployment receives every platform variable of its class ([ADR-0064](ADR-0064-a-platform-variable-is-set-on-the-platform-never-by-the-deploy.md)). A service that runs a dev server ([ADR-0056](ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md)) is given the same environment, and a changed value restarts it.
- **A changed value redeploys the services that read it.** Each `Deployment`'s triggers carry a `<name>:updatedAt` member per variable its rows point at. On a hosted deploy it holds the platform variable's `updatedAt`. Under `prisma dev` it holds the fingerprint from the payload: an HMAC-SHA256 of the value under a random 32-byte key that `prisma dev` creates once in `.prisma-composer/dev/<environment>/fingerprint.key` (mode 0600). Alchemy writes trigger members to its state as given, which is why the fingerprint is keyed: a bare hash of a short secret could be reversed by guessing. A lost key causes one redeploy, and `--fresh` deletes it.
- **A changed adapter value pauses rebuilds.** When what the adapters return at a rebuild differs from what they returned at start, `prisma dev` keeps the values it started with and stops rebuilding until it is restarted, as it does after an edit to `prisma.config.ts`.
- **Composer never reads a secret back from storage.** The `secrets.json` store in `.prisma-composer/dev/` is gone, and `prisma dev` deletes a leftover one when it starts.
- **Deploy sends no dev payload.** Its input document holds a marker for every secret, and boot leaves out a key whose variable has no value.

## Reasoning

An earlier local-dev decision ([ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)) gave an unset secret a minted placeholder, so that an app with a real external credential would still boot locally. In practice a service cannot tell a made-up value from a real key. A service that turns a feature on when its key is present turned it on with `local-placeholder-<hex>` and then failed in ways that pointed nowhere near the missing variable (prisma/composer#379). The stored value also never reached a service that was already deployed when the real value was set later (prisma/composer#380). Will rejected the placeholder model outright: users manage their environments themselves.

The user names where values come from, in `prisma.config.ts`, and Composer reads them there. Composer ships `dotenv()`, but the user still lists it, so the user still chooses the loader. The adapters run only in the first process, so the second process cannot see a value the first process did not check. A deploy reads them once per run. `prisma dev` reads them at start and again at each rebuild, always in the first process.

Without a made-up value, an unset secret has to be either an error or absent. Which one is the schema's call, because ADR-0042 already makes the schema the only judge of whether a field may be missing. Leaving the secret out and validating asks exactly that question, with the schema treated as a black box.

The second process needs the dev preflight's findings and the secret values, and it runs no adapter, so the first process hands them over: the findings on the existing preflight transport, the secrets in its environment, in memory. A file would leave secrets on disk if `prisma dev` were killed.

## Consequences

- An app whose required secret is unset locally stops with an error naming the variable. Optional secrets that are unset arrive absent.
- Changing a secret and running `prisma dev` again, without `--fresh`, restarts exactly the services whose rows point at it.
- Under `prisma dev`, a service receives only the secrets and env-sourced params its own input and params point at. Code that reads `process.env.X` directly, where `X` is bound by another service, gets nothing locally, and gets the value on Prisma Cloud.
- **A value in `.env` or `.env.local` is read by every environment, including `prisma deploy` to `production`.** The deploy never copies a secret to the platform, but a plain value there reaches the root's input and every `envParam()` in every environment. Put local-only values in `.env.dev` or `.env.dev.local`, which only the environment `dev` reads. A project that adopts `dotenv()` removes `import 'dotenv/config'` from `prisma.config.ts`, or `.env`'s values reach the shell's place in the order.
- Each environment's folder under `.prisma-composer/dev/` holds its own fingerprint key, mode 0600. Alchemy's local state holds HMAC fingerprints of secret values, never the values.
- The compute emulator keeps a copy of each running service's environment, secret values included, in its `instances.json` (mode 0600, in the machine-wide emulator directory, outside the project), so it can restart the service after the emulator itself restarts. Composer never reads that copy back. This is recorded in `.drive/deferred.md`.
- Dev and deploy give a service the same input when an optional secret is unset: the field is absent. Dev's input document leaves the marker out, and deploy's holds it and boot leaves the key out.

## Alternatives considered

- **Keep placeholders.** Rejected: a made-up value is indistinguishable from a real one, and it hides the missing variable.
- **Make every unset secret an error.** Rejected: it contradicts ADR-0042, under which an optional field may be absent, and forces developers to invent values for features they do not use.
- **Decide required or optional by reading the schema.** Rejected: ADR-0042 forbids introspection.
- **A plain SHA-256 fingerprint.** Rejected: it lands in Alchemy's state inside the project, and a short or guessable secret can be recovered from it.
- **Values only from the run's environment variables, with `import 'dotenv/config'` in `prisma.config.ts` as the way to load `.env`**, which an earlier version of this decision chose, following the ORM's model. Replaced by the adapters: the user still chooses the loader by listing it, and `.env.<environment>` files keep a value meant for `dev` away from `production`.
- **Load `.env` in Composer itself, without the user naming a loader.** Rejected: it takes the choice of loader away from the user.
- **The second process runs the adapters again.** Rejected: it could read values the first process never checked, and ask a secrets manager twice.
- **Write the secrets the second process needs to a file.** Rejected: a killed `prisma dev` would leave them on disk.

## Related

- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md) — local dev runs the deploy pipeline against local providers.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — the input schema, the binding, and validation as the only judge of absence.
- [ADR-0029](ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md) — the secrets model.
- [ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md) — the adapters, the app configuration and the app secrets.
- [ADR-0064](ADR-0064-a-platform-variable-is-set-on-the-platform-never-by-the-deploy.md) — platform variables on Prisma Cloud, and the deploy preflight that uses this record's method.
- [local-dev.md](../10-domains/local-dev.md) and [running-locally.md](../../guides/running-locally.md).
