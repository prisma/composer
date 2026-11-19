# ADR-0058: `prisma dev` reads secrets from the app secrets and never invents them

Amended by [ADR-0068](ADR-0068-destroy-runs-alchemy-in-process.md): the environment transport `PRISMA_COMPOSER_PREFLIGHT_<extension>` is deleted. Every preflight payload reaches the lowering as a value.

Amended by [ADR-0067](ADR-0067-prisma-dev-converges-in-a-worker-thread.md): `prisma dev` has no second process, no dev app configuration file and no `PRISMA_COMPOSER_NAMED_SECRETS`. The named secrets reach the local target as a value in memory, passed to the worker thread that runs each converge.

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

Set each missing variable where an adapter in prisma.config.ts reads it: the `secrets` list of the `composer` section for a secret, the `config` list for a plain platform variable. environmentVariables() reads the shell you run `prisma dev` from; dotenv() reads .env, .env.local, .env.dev and .env.dev.local beside prisma.config.ts.
```

## Decision

Under `prisma dev`, a platform secret's value comes only from the app secrets, and a plain platform variable's only from the app configuration ([ADR-0062](ADR-0062-environment-values-come-from-resolve-and-config-adapters.md), [ADR-0064](ADR-0064-an-app-declares-its-platform-variables-in-its-root-and-the-deploy-copies-no-local-values.md)). `prisma dev` runs the adapters the `composer` section lists in its first process, at start and at each rebuild. The target's dev preflight, which runs at start, reads the values. By default both lists are `[environmentVariables()]`, the shell; `dotenv()` reads `.env` files. Composer never makes up a value and never reads one back from an earlier run.

- **A required secret that is unset or empty stops `prisma dev`.** The error lists every missing variable, the service that needs it, the schema's message, and where to set it. Empty counts as unset.
- **An optional secret that is unset or empty reaches the service as absent.** Its input has no value for that field, and the schema decides what that means, as it does for any absent field ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)).
- **Required or optional is decided by validation, not by reading the schema.** For each service the dev preflight resolves the input binding with every unset secret left out and calls the schema's `validate`. If that passes, the missing secrets were optional. If it fails, the preflight checks each unset secret alone and names as required only the secrets whose absence alone fails. When no single secret fails alone, the error says the service needs at least one of them, and calls none of them required. A secret an array position reads is required without a check, because an array position cannot be left out. The deploy preflight decides required or optional for a platform variable with no row by the same method and the same code ([ADR-0064](ADR-0064-an-app-declares-its-platform-variables-in-its-root-and-the-deploy-copies-no-local-values.md)).
- **Plain platform variables get the same sourcing.** For each plain platform variable node a service reads, the dev preflight reads the app configuration under the variable's name, once. A platform variable is read only through a field of a service's input. An unset or empty value is left out of the input document, like an unset secret, and the same validation decides whether the service needs it. A value that is not text stops `prisma dev` before any service starts, naming the variable, the node, the services that read it and the kind of value. The dev preflight then decodes and validates each text by the variable's schema, once per variable, with the code boot runs ([ADR-0064](ADR-0064-an-app-declares-its-platform-variables-in-its-root-and-the-deploy-copies-no-local-values.md)). A text that does not decode or fit stops `prisma dev` before any service starts, with the message boot would give followed by `prisma dev cannot start, because service "shop.mail" reads it.`, or `because services "shop.mail" and "shop.digest" read it.` with several readers. Like secrets, these values are read fresh each run and fingerprinted, so a changed value redeploys the services that read it.
- **The second process receives the values; it reads none.** `prisma dev` runs Alchemy in a second process at start and at each rebuild. That process runs no adapter. It reads what Load read from the app configuration, the text of each plain platform variable a service reads (`plainVariableText`), and the first process's node addresses, from the app configuration file, `<dev environment dir>/app-configuration-<pid>.json`, readable only by its owner, which `prisma dev` writes before each converge and deletes as soon as that converge ends. `prisma dev` keeps the texts the dev preflight found at start and writes them on the first converge and on every rebuild. Before writing the file it checks every plain value in it, each `plainVariableText` member included, against the known secrets, and a plain value that holds a secret's value fails with `CONFIG.SECRET_AS_PLAIN_VALUE`. The second process passes `plainVariableText` to the local target, which fills each plain `$platform` marker from it. It receives the named secrets, the values under the secrets keys of the graph's secret sources, which are the platform secret nodes, in one environment variable, `PRISMA_COMPOSER_NAMED_SECRETS`, in memory; no secret is written to a file for it.
- **The dev preflight hands the second process a payload.** It travels on the preflight transport that carries deploy's rotation timestamps (`PRISMA_COMPOSER_PREFLIGHT_<extension>`), with a `dev:` prefix that a deploy payload, always a JSON object, never starts with. It names the absent platform variables, plain and secret (`absentVariables`), and carries a fingerprint of the current value of each variable a service's input document names, never the value. The serializer leaves a platform variable out of the input document only when this payload names it absent.
- **Each local service gets only the variables its own markers name**: the `$platform` markers in its input document, at any depth. This is a requirement of the local target. On Prisma Cloud every deployment receives every platform variable of its class ([ADR-0064](ADR-0064-an-app-declares-its-platform-variables-in-its-root-and-the-deploy-copies-no-local-values.md)). A service that runs a dev server ([ADR-0056](ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md)) is given the same environment, and a changed value restarts it.
- **A changed value redeploys the services that read it.** Each `Deployment`'s triggers carry a `<name>:updatedAt` member per variable its input document's markers name. On a hosted deploy it holds the platform variable's `updatedAt`. Under `prisma dev` it holds the fingerprint from the payload: an HMAC-SHA256 of the value under a random 32-byte key that `prisma dev` creates once in `.prisma-composer/dev/<environment>/fingerprint.key` (mode 0600). Alchemy writes trigger members to its state as given, which is why the fingerprint is keyed: a bare hash of a short secret could be reversed by guessing. A lost key causes one redeploy, and `--fresh` deletes it.
- **A changed adapter value pauses rebuilds.** When what the adapters return at a rebuild differs from what they returned at start, `prisma dev` keeps the values it started with and stops rebuilding until it is restarted, as it does after an edit to `prisma.config.ts`.
- **A change to what the app reads pauses rebuilds.** A rebuild runs no dev preflight, so a read the change adds would have no value. When the rebuilt graph's reads of platform variable nodes, or the read nodes' `props`, differ from those at start, `prisma dev` does not converge, emits `value-reads-changed`, warns that the platform variables the app reads changed, and pauses rebuilds until it is restarted ([ADR-0064](ADR-0064-an-app-declares-its-platform-variables-in-its-root-and-the-deploy-copies-no-local-values.md)). A rebuild reloads the app's modules as they were at start in the first process, so today this fires only when the graph the first process loads changes.
- **Composer never reads a secret back from storage.** The `secrets.json` store in `.prisma-composer/dev/` is gone, and `prisma dev` deletes a leftover one when it starts.
- **The deploy passes no secret values to the second process.** Its input document holds a marker for every secret, and boot leaves out a key whose variable has no value.

## Reasoning

An earlier local-dev decision ([ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)) gave an unset secret a minted placeholder, so that an app with a real external credential would still boot locally. In practice a service cannot tell a made-up value from a real key. A service that turns a feature on when its key is present turned it on with `local-placeholder-<hex>` and then failed in ways that pointed nowhere near the missing variable (prisma/composer#379). The stored value also never reached a service that was already deployed when the real value was set later (prisma/composer#380). Will rejected the placeholder model outright: users manage their environments themselves.

The user names where values come from, in `prisma.config.ts`, and Composer reads them there. Composer ships `dotenv()`, but the user still lists it, so the user still chooses the loader. The adapters run only in the first process, so the second process cannot see a value the first process did not check. A deploy reads them once per run. `prisma dev` reads them at start and again at each rebuild, always in the first process.

Without a made-up value, an unset secret has to be either an error or absent. Which one is the schema's call, because ADR-0042 already makes the schema the only judge of whether a field may be missing. Leaving the secret out and validating asks exactly that question, with the schema treated as a black box.

The second process needs the dev preflight's findings and the secret values, and it runs no adapter, so the first process hands them over: the findings on the existing preflight transport, the secrets in its environment, in memory. A file would leave secrets on disk if `prisma dev` were killed.

## Consequences

- An app whose required secret is unset locally stops with an error naming the variable. Optional secrets that are unset arrive absent.
- Changing a secret and running `prisma dev` again, without `--fresh`, restarts exactly the services whose markers name it.
- Under `prisma dev`, a service receives only the platform variables its own input document names. Code that reads `process.env.X` directly, where `X` is bound by another service, gets nothing locally, and gets the value on Prisma Cloud.
- **A value in `.env` or `.env.local` is read by every environment, including `prisma deploy` to `production`.** The deploy does not copy a secret to the platform, but a plain value there reaches the root's input in every environment. Put local-only values in `.env.dev` or `.env.dev.local`, which only the environment `dev` reads. A project that adopts `dotenv()` removes `import 'dotenv/config'` from `prisma.config.ts`, or `.env`'s values reach the shell's place in the order.
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
- [ADR-0064](ADR-0064-an-app-declares-its-platform-variables-in-its-root-and-the-deploy-copies-no-local-values.md) — platform variables on Prisma Cloud, and the deploy preflight that uses this record's method.
- [local-dev.md](../10-domains/local-dev.md) and [running-locally.md](../../guides/running-locally.md).
