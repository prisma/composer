# ADR-0050: Every input leaf names its source: module code, the shell, or the platform

## Decision

Each leaf of a service's input binding names where its value comes from. There
are three sources:

- **module code:** a literal. Public values only.
- **the deploy shell:** `fromShell('NAME')`.
- **the platform:** a pointer to a variable in the stage's project env,
  `env('NAME')` for a public value or `envSecret('NAME')` for a secret.

A value is either **Composer-managed** or **platform-managed**.
Composer-managed values come from module code or the shell, and the deploy
makes sure the platform holds them. Platform-managed values are set on the
platform by the operator, and the deploy only checks that they exist. A module
chooses platform management per leaf, explicitly.

| Leaf | Source | Managed by | Secret | Composer reads the value | In the input document |
| --- | --- | --- | --- | --- | --- |
| literal | module code | Composer | no | at deploy | the value |
| `fromShell('NAME')` (new) | deploy shell | Composer | no | at deploy | the value |
| `envSecret('NAME', { from: fromShell('NAME') })` (new option) | deploy shell, copied to the platform | Composer | yes | at deploy, to write it; the service reads it at boot | `{ "$secret": "NAME" }` |
| `env('NAME')` (new) | platform | platform | no | never; the service reads it at boot | `{ "$env": "NAME" }` |
| `envSecret('NAME')` | platform | platform | yes | never; the service reads it at boot | `{ "$secret": "NAME" }` |
| `generatedParam()`, `serviceOrigin()` | Composer | Composer | either | at deploy | `{ "$generated": … }` |

The last row is unchanged by this ADR. `envParam('NAME')` in an input binding
is removed (see § Migration).

```ts
// service.ts: the service author declares the shape and which fields are secret
import { secretString } from '@prisma/composer/arktype';
import { type } from 'arktype';

const webInput = type({
  region: 'string',
  releaseChannel: 'string',
  appOrigin: 'string.url',
  stripeSecretKey: secretString(),
  webhookSigningSecret: secretString(),
});

export default compute({ name: 'web', input: webInput /* , build, deps */ });
```

```ts
// module.ts: the operator names the source of each field
import { env, envSecret, fromShell } from '@prisma/composer-prisma-cloud';

provision(web, {
  input: {
    region: 'eu-central-1',                       // module code
    releaseChannel: fromShell('RELEASE_CHANNEL'), // deploy shell
    appOrigin: env('APP_ORIGIN'),                 // platform, public
    stripeSecretKey: envSecret('STRIPE_SECRET_KEY', {
      from: fromShell('STRIPE_SECRET_KEY'),       // Composer-managed secret
    }),
    webhookSigningSecret: envSecret('WEBHOOK_SIGNING_SECRET'), // platform-managed secret
  },
});
```

The deploy writes this input document. Values from module code and the shell
are in it. Values on the platform appear only as pointers:

```json
{
  "region": "eu-central-1",
  "releaseChannel": "stable",
  "appOrigin": { "$env": "APP_ORIGIN" },
  "stripeSecretKey": { "$secret": "STRIPE_SECRET_KEY" },
  "webhookSigningSecret": { "$secret": "WEBHOOK_SIGNING_SECRET" }
}
```

At boot, the service replaces `{ "$env": … }` with the plain string from the
platform variable, replaces each `$secret` pointer with a redacting
`SecretString` box, and validates the result with `webInput` before the app
starts.

**The invariant.** A module that uses only Composer-managed leaves deploys
into an empty project with no manual platform steps. The deploy reads the
shell only where the module names a shell variable with `fromShell()`. It
never reads the shell implicitly.

## Reasoning

### What Composer does today

Composer's Prisma Cloud target
(`packages/1-prisma-cloud/1-extensions/target/src/`) has two ways to bind an
input field to a value that is not in module code:

- `envParam('NAME')` (`param.ts`). In an input binding, the deploy reads
  `NAME` from the deploy shell and writes the value into the input document
  (`resolveInputBinding` in `serializer.ts`). If `NAME` is unset or empty, the
  key is left out of the document and the schema decides whether that is
  legal. The deploy report lists such keys under `absent`
  (`descriptors/compute.ts`), but the deploy does not fail on an optional
  field.
- `envSecret('NAME')` (`secret.ts`). The deploy writes only a pointer,
  `{ "$secret": "NAME" }`. The service reads the value from the platform
  variable `NAME` when it first calls `service.input()` (`readInput` in
  `serializer.ts`).

Before the deploy runs, the preflight (`preflight.ts`) checks that each
`envSecret` name exists on the platform for the stage. If a name is missing
there but set in the deploy shell, the preflight creates the platform variable
from the shell value with `POST /v1/environment-variables`. It never updates a
variable that exists. So after the first deploy of a stage, the platform holds
the real value, and a changed value in the shell is ignored.

Platform env values are write-only: the Management API returns a variable's
metadata, such as `updatedAt`, and never its value. Composer cannot read a
public value back from the platform, and that is why `envParam` reads from the
shell.

(For the reserved `params` of a service, such as `port`, `envParam` already
behaves as a pointer: the deploy writes a pointer row and the service reads
the platform variable at boot, as
[ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
first described. [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)
changed input bindings to read `envParam` from the shell. The user guide,
`docs/guides/building-an-app.md`, still describes the pointer behavior for
input bindings.)

### What that costs

Today, where a value comes from depends on whether it is secret, and neither
path says so in module code. A secret is created on the platform once, from
whatever shell ran the first deploy, and never updated by Composer again. A
public value has to be in the deploy shell on every deploy of every stage.

pdp-control-plane, which deploys its Console on Composer, shows the cost. Its
CI deploys through `prisma/cloud-deploy-action`. A GitHub Actions `uses:` step
cannot be wrapped in a secrets manager's command, so the workflow cannot run
the deploy under `doppler run`. Instead it keeps an explicit list of 37 public
names. A workflow step copies those names from Doppler into `$GITHUB_ENV`, and
a drift test keeps the list in sync with `module.mjs`. A name bound to an
optional field and missing from the shell is left out of the deploy without
an error. Any customer with public config in CI has the same problem.

Deploys that depend on the shell in ways the code does not show are also hard
for coding agents, which
[the agent-first principle](../01-principles/guiding-principles.md#agent-first)
asks us to serve. The inputs of a deploy are not visible in the repository.
When a value is missing, the failure shows no cause in the code. The same
commit deployed to the same stage can produce different deploys, depending on
who ran it and from which shell.

### Composer can be the only source of truth

Composer's original model is that the deploy is the orchestrator. It makes
sure every platform env variable, secret or not, exists with the correct
value, and that each Compute service can read the values it needs. The
platform hosts the values; Composer decides them. Alchemy state must never
hold a secret value, so a secret travels from the shell to the platform's
secret store, and the input document refers to it by pointer.

This ADR keeps that model as the default and makes it complete. Every value
can come from module code or the shell. A Composer-managed secret is written
to the platform on every deploy, so the platform always holds the value the
deploy was given. Nothing a module needs has to be set by hand first.

### Why a platform-managed mode exists too

Some teams cannot or will not give CI every secret.
`prisma/cloud-deploy-action` can sign in with a GitHub OIDC token alone, so
the CI job holds no long-lived credential and no application secret. That only
works if the values already live on the platform. Teams also edit a value with
`prisma project env update` and expect the next deploy to use it, with no code
change and no CI secret. Secrets already work this way today, because the
preflight never overwrites them.

So a leaf can opt into platform management. Both modes have real costs.

**Composer-managed, the costs:**

- Every deploy needs every Composer-managed secret in its shell. CI must hold
  them all, which rules out OIDC-only deploys for those modules.
- The shell always wins. A value someone set on the platform by hand is
  overwritten on the next deploy, with no warning. A deploy from a shell with
  an old value rolls the value back.
- The value is written on every deploy. Without the platform change described
  below, every deploy would replace every deployment that uses a
  Composer-managed secret.

**Platform-managed, the costs:**

- The platform holds the only copy of the value. Composer is no longer the
  single source of truth for that leaf, and the repository does not describe
  the deploy completely.
- The deploy cannot validate the value, because platform values are
  write-only. A bad value fails when the new deployment boots.
- The deploy does not record the value. The same commit and stage can behave
  differently after someone changes the variable.
- A new stage needs each platform-managed variable set by hand before its
  first deploy.

The module states the choice for each leaf, so a reader of `module.ts` can see
which values the repository and its shell control and which the platform
controls.

### Why the binding still says "secret"

Ideally, one pointer, `env('NAME')`, would serve public and secret fields,
and the schema alone would decide. Composer cannot do this, for two reasons
that [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) already
records:

- Standard Schema gives Composer only `validate`. Composer cannot ask a schema
  whether a field is a `SecretString`.
- Boot reads the input document without the schema. A pointer in the document
  must say whether to wrap the value in a redacting box. The `$generated`
  pointer carries a `redacted` flag for the same reason.

So the binding names the pointer kind: `env()` for a public value,
`envSecret()` for a secret. The schema is still the authority. Deploy-time
validation checks the binding against the schema in both directions, as it
does today:

- A literal, `fromShell()` or `env()` on a `secretString()` field fails the
  deploy, because the schema receives a string where it expects a box. A
  secret therefore never lands in git or in the input document.
- An `envSecret()` on a plain string field fails the deploy, because the
  schema receives a box where it expects a string.

### How a deploy handles each leaf

**Literals** are unchanged. The deploy validates them and writes them into the
document.

**`fromShell()` leaves** behave like an input-binding `envParam()` today: the
deploy reads the shell, writes the value into the document, and leaves the key
out if the variable is unset or empty, so the schema decides. The difference
is the name: a reader of `module.ts` can see which values come from the
shell. Like literals, these values reach the platform inside the input
document, which Composer writes as a framework-owned env variable. Alchemy
keeps that row's value `Redacted` in state, and the deployment's `triggers`
hold only a salted hash of it (`descriptors/compute.ts`).

**Composer-managed secrets** (`envSecret('NAME', { from: fromShell('NAME') })`)
are written by the preflight on every deploy. The preflight reads `NAME` from
the shell. If it is unset or empty, the deploy fails and names the variable.
Otherwise the preflight creates the platform variable for the stage when it
is missing, and updates it when it exists. The input document keeps only the
`$secret` pointer. Alchemy state never holds the value or a hash of it. The
write goes to the same scope the preflight uses today: the production
template for the default stage, and a branch override for a named stage.

**Platform-managed values** (`env('NAME')` and bare `envSecret('NAME')`) are
checked for existence only. The preflight adds every `env()` name to the names
it already checks for `envSecret()` (`collectPreflightNames` in
`preflight-names.ts`). A name that does not exist for the stage fails the
deploy. The existing error lists each missing name and the
`prisma project env add` command that sets it. The preflight no longer copies
a missing name from the shell. The explicit `from: fromShell()` option
replaces that behavior.

The value of an `env()` leaf is not known at deploy. To validate the rest of
the input, the deploy passes a placeholder string at each `env()` leaf.
Standard Schema reports each problem with a path. The deploy fails on problems
at any other path, and defers problems at an `env()` path to boot. When
validation passes, the deploy replaces each placeholder in the output with its
`$env` pointer, by path, as it does for `$generated` pointers. When it defers
a problem, the schema returns no output, so the deploy writes the document
from the resolved binding, and the schema applies its defaults at boot.
`envSecret()` leaves are validated as empty `SecretString` boxes, as today.

**Boot validates the input before it starts the app.** Today
`ComputeService.run()` (`compute.ts`) re-stashes the input document, and the
schema runs on the first `service.input()` call, which may be inside a request
handler. Under this ADR, `run()` calls `readInput` before it calls `boot()`.
A bad platform value then stops the process when it starts, with the schema's
error, instead of failing the first request that reads the input.

**A change to a pointed-to variable ships on the next deploy.** The preflight
already reads each pointer name's `updatedAt` and returns it. The compute
deploy adds it to the deployment's `triggers` as a `<name>:updatedAt` member
(`descriptors/compute.ts`). When a variable's `updatedAt` moves, the next
deploy replaces the deployment. Prisma Compute copies env values into a
deployment when the deployment is created, so a new value reaches the service
only through a new deployment. This covers `env()`, bare `envSecret()` and
Composer-managed secrets alike.

### Prerequisite: a platform write that changes nothing when the value is the same

A Composer-managed secret is written on every deploy, and its `updatedAt` is a
trigger. If writing an unchanged value moves `updatedAt`, every deploy
replaces every deployment that uses a Composer-managed secret.

The Management API moves it today. `PATCH /v1/environment-variables/:id`
calls `setConfigVariable` in `replace-only` mode
(`services/management-api/routes/v1/environment-variables.ts` in
pdp-control-plane). `setConfigVariable`
(`packages/interactors/src/compute-config/setConfigVariable.ts`) encrypts the
new value with a fresh IV and always calls `updateConfigVariable`. Its lookup,
`findConfigVariableByNaturalKey`, returns only the row id, so the interactor
never sees the stored value. `updateConfigVariable`
(`packages/repositories/src/compute-config/computeConfig.repository.pn.ts`)
writes the new ciphertext and sets `updatedAt` to the current time. No step
compares the old and new values.

Composer cannot do the comparison itself. Platform values are write-only, and
keeping a hash of each secret in Alchemy state would put a value derived from
the secret into state, which this ADR rules out.

So the Management API must change before Composer-managed secrets ship. The
behavior needed:

- On a replace (`PATCH /v1/environment-variables/:id`, and the `upsert` mode of
  `setConfigVariable`), the interactor decrypts the stored value with the
  project's data key and compares it with the new value in constant time.
- When they are equal, it writes nothing. The row keeps its ciphertext, its
  `valueKid` and its `updatedAt`, and the route answers `200` with that
  unchanged row.
- When they differ, it behaves as today.
- Comparing ciphertexts is not enough, because each write uses a fresh IV.

Until this ships, Composer-managed secrets are not available. Bare
`envSecret()`, `env()`, literals and `fromShell()` do not depend on it.

### The limit: module code cannot read a pointer

A pointer is resolved inside the running service. Module code runs at deploy
and only sees the pointer, so it cannot branch on the value. Values that
decide what gets deployed stay in module code. For example, whether a stage
provisions a service, or which literal a field gets in one stage, depends on
the stage name, so it is decided in module code. Composer does not pass the
stage name to module code today. pdp-control-plane reads its own `STAGE`
variable from the shell for this. This ADR does not change that.

### How other tools do it

These are the common, documented patterns of each tool.

| Tool | Values the deploy carries | References into a store |
| --- | --- | --- |
| Kubernetes | container `env` with `value` | `valueFrom` with `configMapKeyRef` or `secretKeyRef`, read at container start |
| AWS ECS task definitions | `environment` (literal name and value) | `secrets` with `valueFrom` (SSM Parameter Store or Secrets Manager), read at container start |
| AWS CloudFormation | parameters and literals | dynamic references such as `{{resolve:secretsmanager:…}}`, read at stack create or update |
| Pulumi | per-stack config file in the repo; `--secret` stores the value encrypted in the same file | none needed |
| SST v3 | code, chosen per `$app.stage` | `sst secret set`, referenced by name |
| Fly.io | `[env]` in `fly.toml` | `fly secrets set`, in the platform store |

Most of these tools offer both modes this ADR names: values the deploy itself
carries, and named references into a per-stage store that the operator
manages. None of them rebuilds public values from the deploy shell on every
deploy without the configuration saying so.

## Consequences

1. **A platform-managed value is not validated at deploy.** A bad value fails
   when the new deployment boots. Composer creates each deployment with
   `start: true` and `promote: true`. The upstream Alchemy resource
   (`Prisma.Deployment`) starts the deployment, waits until the platform
   reports it `running`, and only then moves the app's endpoint to it. If the
   platform reports `failed`, the deploy fails, the new deployment is cleaned
   up, and the old deployment keeps serving. Composer has no health check of
   its own. So the old version keeps serving only if the platform reports a
   process that exits during start as `failed` before it reports `running`.
   Neither Composer's nor Alchemy's code settles this; it depends on how
   Prisma Compute decides that a deployment is running. It must be confirmed
   before this ADR is accepted. Without that guarantee, a bad platform value
   can be promoted and take the service down.
2. **A platform-managed value is not recorded by the deploy.** Composer sees
   only the variable's `updatedAt`, at the next deploy. A running deployment
   keeps the old value until a new deployment replaces it; a restart does not
   pick up the new value.
3. **Platform values stay write-only.** The CLI cannot show an `env()` value.
   A follow-up could add a non-secret flag on platform env variables, so the
   CLI can read public values back and the deploy can validate and record
   them. That needs a platform change and is not part of this ADR.
4. **Deploy-time validation covers less for `env()` leaves.** Problems at an
   `env()` path move to boot. If an `env()` leaf decides the shape of the
   input, such as a union discriminator, the placeholder can make the schema
   report problems at other paths too. Bind such fields to literals.
5. **Every platform-managed name must exist for the stage.** There is no
   optional pointer. A field that is set in some stages only is left unbound
   in the others, which module code decides per stage.
6. **A Composer-managed secret overwrites manual edits.** The value in the
   deploy shell is written on every deploy. Changing it on the platform by
   hand lasts only until the next deploy.
7. **Composer-managed secrets wait for the Management API change** in
   § Prerequisite.
8. **The shell changes the result of a deploy only through `fromShell()`,**
   and then the dependency is visible in `module.ts`.
9. **Local dev keeps reading the shell.** `prisma dev` has no platform store.
   Its preflight (`local-target/preflight.ts`) already copies `envSecret`
   names from the shell into a local store under the dev directory, or uses a
   placeholder. A Composer-managed secret reads its `fromShell()` name the
   same way. An `env()` name comes from the shell too, and a missing one is a
   hard error, as a missing env-sourced param is today, because a placeholder
   would fail schema validation at boot with a confusing message.

## Migration

`CONTRIBUTING.md` asks for no compatibility aliases before 1.0, so by default
the release that adds `fromShell`, `env` and the `from` option also removes
`envParam` from input bindings and the preflight's implicit copy from the
shell. A deprecation window needs the maintainers to make an exception.

- **`envParam('NAME')` in an input binding** becomes one of:
  - a literal, where the value is the same in every stage or is chosen per
    stage in module code;
  - `fromShell('NAME')`, where the shell read is intended (same behavior as
    today);
  - `env('NAME')`, where the value lives per stage on the platform.
- **`envParam('NAME')` on a reserved param** (`params: { port: … }`) already
  works as a pointer, so it becomes `env('NAME')` with no change in behavior.
- **Bare `envSecret('NAME')`** keeps today's runtime behavior. It loses the
  implicit create from the shell. A module that relies on the first deploy
  copying the secret from the shell adds `from: fromShell('NAME')`, or the
  operator sets the variable on the platform first.
- **The input document** gains the `$env` pointer. The reserved-key escaping
  of ADR-0042 (consequence 2) extends to `$env`, so a user key named `$env`
  still round-trips.
- **pdp-control-plane:** its 37 public names become per-stage literals in
  `module.mjs` or `env()` pointers. Its secrets stay platform-managed, as bare
  `envSecret()`. The Doppler step and the drift test go away. Its Cloudflare
  Workers still read the same public values from Doppler until they move to
  Composer, so until then those values are kept in two places.

## Alternatives considered

- **Composer as the only source of truth, with no platform-managed mode.**
  Every value would come from module code or the shell. CI would then have to
  hold every secret for every deploy, which rules out deploys that sign in
  with OIDC only and hold no application secret. Rejected.
- **The platform as the source of truth for all non-literal values,** with
  `env()` and bare `envSecret()` only. A module could then not deploy into an
  empty project without manual steps, and Composer would stop being the
  orchestrator of its own values. Rejected.
- **Keep reading public values from the shell implicitly, and make CI export
  them more easily**, for example with an env-file input on
  `cloud-deploy-action`. The shell would still change deploys in ways module
  code does not show. Rejected.
- **One `env()` for public and secret fields, with secretness read from the
  schema.** Standard Schema exposes only `validate`, and ADR-0042 rejected
  reading library internals. Trying both a string and a box at each leaf and
  keeping whichever passes is guessing, which
  [the architectural principles](../01-principles/architectural-principles.md)
  rule out. Rejected.
- **Keep the preflight's implicit copy of a missing name from the shell.** It
  makes the first deploy of a stage depend on the shell without module code
  saying so, and it never updates the value afterwards. The explicit
  `from: fromShell()` covers the same need and also updates. Rejected.
- **Write Composer-managed secrets as Alchemy `Prisma.EnvironmentVariable`
  resources** and put their values in the deployment's `triggers`, as
  Composer does for its own framework rows. This needs no platform change.
  But `triggers` stores a salted hash of each value in state, and this ADR
  keeps any value derived from an operator's secret out of state. Rejected.
- **A per-stage config file in the repository, as Pulumi does.** Composer
  modules are code, and per-stage literals in module code already give this.
  A separate file would add a second place to look. Rejected.

## Related

- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): one input
  schema, the input document, validation in both directions, and the
  `$secret` and `$generated` pointers. This ADR adds the `$env` pointer and
  replaces the shell read of input-binding `envParam` with `fromShell`.
- [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md):
  provision-time binding and the pointer behavior of `envParam` that `env()`
  restores for input bindings.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md): secrets as named
  platform variables, and the preflight that checks them.
- [ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md):
  the deployment's `triggers` that replace it when a pointed-to variable
  changes.
- [`../10-domains/config-params.md`](../10-domains/config-params.md): the
  sources of a value.
