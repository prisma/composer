# ADR-0056: `prisma dev` reads secrets from the environment and never invents them

## Decision

Under `prisma dev`, a secret's value comes only from the environment of the current run: the shell, or a `.env` file that `prisma.config.ts` loads into `process.env`. Composer never makes up a value and never reads one back from an earlier run.

```bash
npm install dotenv
```

```ts
// prisma.config.ts
import 'dotenv/config';
import { defineConfig as composer } from '@prisma/composer/config';
// …
```

```text
$ prisma dev module.ts
local dev preflight failed:

required secrets are not set:
  - STRIPE_SECRET_KEY  (required by service "billing": stripeKey must be present (was missing))

Set each missing variable in either of these ways:
  - export it in the shell you run `prisma dev` from, or
  - load a .env file from prisma.config.ts: install the dotenv package and add import 'dotenv/config' at the top of prisma.config.ts.
(process.loadEnvFile('.env') works too, but only when the CLI runs under Node: Bun does not implement it.)
```

- **A required secret that is unset or empty stops `prisma dev`.** The error lists every missing variable, the service that needs it, the schema's message, and both ways to provide it. Empty counts as unset.
- **An optional secret that is unset or empty reaches the service as absent.** Its input has no value for that field, and the schema decides what that means, as it does for an unset `envParam` leaf (ADR-0042).
- **Required or optional is decided by validation, not by reading the schema.** For each service the dev preflight resolves the input binding with every unset secret left out and calls the schema's `validate`. If that passes, the missing secrets were optional. If it fails, the preflight checks each unset secret alone, leaving out only that one, and names as required only the secrets whose absence alone fails. When no single secret fails alone, the error says the service needs some of them, and does not call any one of them required. The framework never looks inside the schema (ADR-0042).
- **The dev preflight hands the alchemy process a payload.** It travels on the same preflight transport that carries deploy's rotation timestamps (`PRISMA_COMPOSER_PREFLIGHT_<extension>`), with a `dev:` prefix that a deploy payload, always a JSON object, never starts with. It names the absent secrets and carries a fingerprint of each pointed variable's current value, never the value. The serializer leaves an `envSecret` leaf out of the input document only when this payload names it absent.
- **Composer never reads a secret back from storage.** The `.prisma-composer/dev/secrets.json` store is gone, and `prisma dev` deletes a leftover one when it starts, because it holds credentials in plain text. The local `Deployment` provider reads current values from `process.env` in the alchemy process, which inherits the CLI's environment and re-imports `prisma.config.ts`. Each service gets only the variables its own rows point at: the `$secret` pointers in its input document and its param pointer rows.
- **A changed value redeploys the services that read it.** Each `Deployment`'s triggers carry a `<name>:updatedAt` member per pointed variable. On a hosted deploy it holds the platform variable's `updatedAt`. Under `prisma dev` it holds the fingerprint from the payload: an HMAC-SHA256 of the value under a random 32-byte key that `prisma dev` creates once in `.prisma-composer/dev/fingerprint.key` (mode 0600). The member changes exactly when the value changes, so Alchemy updates that deployment and the local provider gives the service the new environment. Alchemy writes trigger members to its state as given, which is why the fingerprint is keyed: a bare hash of a short secret could be reversed by guessing. A lost key causes one redeploy, and `--fresh` deletes it.
- **Deploy is unchanged.** Deploy's preflight, its input document and its errors are the same as before. Deploy sends no dev payload, so the serializer leaves nothing out.

This amends the secrets bullet of [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md), under which an unset secret got a minted placeholder that was stored and reused, with a printed warning.

## Reasoning

ADR-0041 chose placeholders so that an app with a real external credential would still boot locally, and only the code that spends the credential would fail. In practice a service cannot tell a made-up value from a real key. A service that turns a feature on when its key is present turned it on with `local-placeholder-<hex>` and then failed in ways that pointed nowhere near the missing variable (prisma/composer#379). The stored value also never reached a service that was already deployed when the real value was set later, because nothing in the deployment's inputs changed (prisma/composer#380).

Will rejected the placeholder model outright: "I think placeholder env vars is fucking insane … Users should manage their environments themselves using eg dotenv, or with the same model as the ORM, where env vars loaded in the config file propagate to the ORM commands' shells."

That puts value management where the user already manages it. The Prisma CLI evaluates `prisma.config.ts` before it runs a command, so whatever the file loads into `process.env` is in the CLI's environment, and the alchemy process inherits it and loads the file again. A shell export and a `.env` loaded by the config file are therefore one mechanism, and the same one the ORM commands use.

Without a made-up value, an unset secret has to be either an error or absent. Which one is the schema's call, because ADR-0042 already makes the schema the only judge of whether a field may be missing. Leaving the secret out and validating asks exactly that question, with the schema treated as a black box.

The engine needs the absent names in the alchemy process, which re-imports the config from scratch, so they ride the existing preflight transport rather than a new channel. Deploy and dev keep one lowering (ADR-0041): the serializer's only dev-specific input is that list, and deploy never sends it.

`process.loadEnvFile` is Node's own loader, but Bun does not implement it. When the CLI is started through Bun, Alchemy runs the converge under Bun and a config file that calls `process.loadEnvFile` throws there. `dotenv` works under both, so the error and the docs lead with it.

## Consequences

- Breaking for local dev: an app whose required secret is unset locally used to start with a made-up value and now stops with an error naming the variable. Optional secrets that are unset now arrive absent.
- A service whose schema marks a secret optional runs locally without it, and sees the field as absent rather than as a value that fails later.
- Changing a secret in the shell or in `.env` and running `prisma dev` again, without `--fresh`, restarts exactly the services whose rows point at it.
- `.prisma-composer/dev/` holds a fingerprint key, mode 0600. Alchemy's local state holds HMAC fingerprints of secret values, never the values.
- The compute emulator keeps a copy of each running service's environment, secret values included, in its `instances.json` (mode 0600, in the machine-wide emulator directory, outside the project), so it can restart the service after the emulator itself restarts. Composer never reads that copy back. This is recorded in `.drive/deferred.md`.
- Deploy still fails when an optional secret is missing on the platform, as before. That gap is recorded in `.drive/deferred.md`.

## Alternatives considered

- **Keep placeholders.** Rejected for the reasons above: a made-up value is indistinguishable from a real one, and it hides the missing variable.
- **Make every unset secret an error.** Simple, but contradicts ADR-0042, under which an optional field may be absent, and forces developers to invent values for features they do not use.
- **Decide required or optional by reading the schema.** ADR-0042 forbids introspection: it couples the framework to each schema library's private representation.
- **A plain SHA-256 fingerprint.** It lands in Alchemy's state inside the project, and a short or guessable secret can be recovered from it.
- **Load `.env` in Composer itself.** Would add a second, Composer-specific way to set the environment, unlike the ORM, and take the choice of loader away from the user.

## Related

- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md) — local dev runs the deploy pipeline against local providers; its secrets bullet is amended here.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) — the input schema, the binding, and validation as the only judge of absence.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) — the secrets model; unchanged.
- [local-dev.md](../10-domains/local-dev.md) — value sourcing and the error surface.
- [running-locally.md](../../guides/running-locally.md) — how to provide secrets locally.
