# ADR-0050: An input binds to a literal or to a pointer into the platform env, and a deploy reads nothing from the shell

## Decision

Each leaf of a service's input binding is one of two things:

- a **literal**: a value written in module code, validated at deploy and
  recorded in the input document, or
- a **pointer**: the name of a variable in the project env on the platform.
  The deploy checks that the name exists for the stage. The service reads the
  value when it boots.

A public value can be either. A secret value must be a pointer. The service's
input schema decides which fields are secret, and deploy-time validation
rejects a binding that disagrees with it.

A deploy reads nothing from the deploy shell beyond the deploy credential.
Reading a value from the shell is still possible, but only through an explicit
`fromShell("NAME")` leaf that the module author writes.

```ts
// service.ts: the service author declares the shape and which fields are secret
import { secretString } from '@prisma/composer/arktype';
import { type } from 'arktype';

const webInput = type({
  region: 'string',
  appOrigin: 'string.url',
  stripeSecretKey: secretString(),
});

export default compute({ name: 'web', input: webInput /* , build, deps */ });
```

```ts
// module.ts: the operator binds each field to a literal or a pointer
import { env, envSecret } from '@prisma/composer-prisma-cloud';

provision(web, {
  input: {
    region: 'eu-central-1',                          // literal
    appOrigin: env('APP_ORIGIN'),                    // public pointer
    stripeSecretKey: envSecret('STRIPE_SECRET_KEY'), // secret pointer
  },
});
```

The deploy writes this input document. It holds the literal and two pointers,
and no value that came from the platform or the shell:

```json
{
  "region": "eu-central-1",
  "appOrigin": { "$env": "APP_ORIGIN" },
  "stripeSecretKey": { "$secret": "STRIPE_SECRET_KEY" }
}
```

At boot, the service replaces `{ "$env": "APP_ORIGIN" }` with the plain string
from the platform variable `APP_ORIGIN`, replaces the `$secret` pointer with a
redacting `SecretString` box, and validates the result with `webInput`.

The full set of leaves after this ADR:

| Leaf | Where the value lives | When Composer reads it | In the input document |
| --- | --- | --- | --- |
| literal | module code | deploy | the value |
| `env('NAME')` (new) | platform project env, per stage | boot | `{ "$env": "NAME" }` |
| `envSecret('NAME')` | platform project env, per stage | boot | `{ "$secret": "NAME" }` |
| `fromShell('NAME')` (new) | the deploy shell | deploy | the value |
| `generatedParam()`, `serviceOrigin()` | deploy state, the platform | deploy, boot | `{ "$generated": … }` |

`envParam('NAME')` in an input binding is replaced by `fromShell('NAME')`
(same behavior) or by `env('NAME')` (pointer). See § Migration.

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
from the shell value. It never updates a variable that already exists. It does
not check `envParam` leaves of an input binding, because those are read from
the shell during serialization.

Platform env values are write-only: the Management API returns a variable's
metadata, such as `updatedAt`, and never its value. So Composer cannot read a
public value back from the platform, and that is why `envParam` reads from the
shell.

(For the reserved `params` of a service, such as `port`, `envParam` already
behaves as a pointer: the deploy writes a pointer row and the service reads the
platform variable at boot, as
[ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md)
first described. [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)
changed input bindings to read `envParam` from the shell. The user guide,
`docs/guides/building-an-app.md`, still describes the pointer behavior for
input bindings.)

### What that costs

Today, where a value comes from depends on whether it is secret. A secret is
stored once per stage on the platform. A public value has to be in the deploy
shell on every deploy of every stage.

pdp-control-plane, which deploys its Console on Composer, shows the cost. Its
CI deploys through `prisma/cloud-deploy-action`. A GitHub Actions `uses:` step
cannot be wrapped in a secrets manager's command, so the workflow cannot run
the deploy under `doppler run`. Instead it keeps an explicit list of 37 public
names. A workflow step copies those names from Doppler into `$GITHUB_ENV`, and
a drift test keeps the list in sync with `module.mjs`. A name that is added to
`module.mjs` but not to the list is only caught by the drift test. A name bound
to an optional field and missing from the shell is left out of the deploy
without an error. Any customer with public config in CI has the same problem.

Deploys that depend on the shell are also hard for coding agents, which
[the agent-first principle](../01-principles/guiding-principles.md#agent-first)
asks us to serve. The inputs of a deploy are not visible in the repository.
When a value is missing, the failure shows no cause in the code. The same
commit deployed to the same stage can produce different deploys, depending on
who ran it and from which shell.

### Separating the two questions

Two questions decide how a value travels. They are independent:

1. **Where does the value live?** In module code (a literal), or in the
   platform's per-stage env (a pointer).
2. **Is the value secret?** The service author knows this, and states it in
   the schema with `secretString()`.

Today the first answer is forced by the second. This ADR lets the operator
answer the first question for every field, public or secret, with one rule
for secrets: a secret must be a pointer, so its value never lands in git or in
the input document.

A pointer needs nothing from the shell, because the platform already stores
the value per stage. A literal needs nothing from the shell, because it is in
the code. That is why a deploy can stop reading the shell.

### Why the binding still says "secret"

Ideally, `env('NAME')` would serve both public and secret fields, and the
schema alone would decide. Composer cannot do this, for two reasons that
[ADR-0042](ADR-0042-service-input-is-one-standard-schema.md) already records:

- Standard Schema gives Composer only `validate`. Composer cannot ask a schema
  whether a field is a `SecretString`.
- Boot reads the input document without the schema's help. A pointer in the
  document must say whether to wrap the value in a redacting box. The
  `$generated` pointer carries a `redacted` flag for the same reason.

So the binding still names the kind of pointer: `env()` for a public value,
`envSecret()` for a secret. The schema is still the authority. Deploy-time
validation checks the binding against the schema in both directions, as it
does today:

- A literal, `env()` or `fromShell()` on a `secretString()` field fails the
  deploy, because the schema receives a string where it expects a box.
- An `envSecret()` on a plain string field fails the deploy, because the
  schema receives a box where it expects a string.

### How a deploy handles each leaf

**Literals** are unchanged. The deploy validates them and writes them into the
document.

**`env()` pointers** are checked for existence. The preflight adds every
`env()` name to the names it already checks for `envSecret()`
(`collectPreflightNames` in `preflight-names.ts`). A name that does not exist
for the stage fails the deploy. The existing error lists each missing name and
the `prisma project env add` command that sets it.

The value itself is not known at deploy. To validate the rest of the input,
the deploy passes a placeholder string at each `env()` leaf. Standard Schema
reports each problem with a path. The deploy fails on problems at any other
path, and defers problems at an `env()` path to boot. When validation passes,
the deploy replaces each placeholder in the output with its `$env` pointer, by
path, as it does for `$generated` pointers. When it defers a problem, the
schema returns no output, so the deploy writes the document from the resolved
binding, and the schema applies its defaults at boot.

**`envSecret()` pointers** are unchanged. The deploy validates them as empty
`SecretString` boxes, as today.

**`fromShell()` leaves** behave like an input-binding `envParam()` today: the
deploy reads the shell, writes the value into the document, and leaves the key
out if the variable is unset or empty. The difference is the name. A reader of
`module.ts` can see which values come from the shell.

**The preflight stops copying values from the shell.** Today it creates a
missing platform variable from the shell. Under this ADR, a missing name
fails the deploy, for both `env()` and `envSecret()`. This keeps the rule that
a deploy reads nothing from the shell. An operator or agent sets a value on
the platform with `prisma project env add`, or in the Console, before the
first deploy of a stage.

**Boot validates the input before it starts the app.** Today
`ComputeService.run()` (`compute.ts`) re-stashes the input document, and the
schema runs on the first `service.input()` call, which may be inside a request
handler. Under this ADR, `run()` calls `readInput` before it calls `boot()`.
A bad pointer value then stops the process when it starts, with the schema's
error, instead of failing the first request that reads the input.

**Rotation works as it does for secrets today.** The preflight already reads
each pointer name's `updatedAt` and returns it. The compute deploy adds it to
the deployment's `triggers` as a `<name>:updatedAt` member
(`descriptors/compute.ts`). When an `env()` value changes on the platform, the
next deploy sees a new timestamp and replaces the deployment. Prisma Compute
copies env values into a deployment when the deployment is created, so the new
value reaches the service only through a new deployment.

### The limit: module code cannot read a pointer

A pointer is resolved inside the running service. Module code runs at deploy
and only sees the pointer, so it cannot branch on the value. Values that
decide what gets deployed stay in module code. For example, whether a stage
provisions a service, or which literal a field gets in one stage, depends on
the stage name, so it is decided in module code.

Composer does not pass the stage name to module code today. pdp-control-plane
reads its own `STAGE` variable from the shell for this. This ADR does not
change that.

### How other tools do it

These are the common, documented patterns of each tool.

| Tool | Public config | Secrets | When the value is read |
| --- | --- | --- | --- |
| Kubernetes | container `env` with `value`, or `valueFrom.configMapKeyRef` | `valueFrom.secretKeyRef` | container start. ConfigMap and Secret references are injected the same way. |
| AWS ECS task definitions | `environment` (literal name and value) | `secrets` with `valueFrom` (an SSM Parameter Store or Secrets Manager reference) | container start |
| AWS CloudFormation | template parameters and literals | dynamic references: `{{resolve:ssm:…}}`, `{{resolve:secretsmanager:…}}` | stack create or update (deploy time) |
| Pulumi | per-stack config file in the repo (`Pulumi.<stack>.yaml`) | `pulumi config set --secret`, stored encrypted in the same file | deploy |
| SST v3 | code, chosen per `$app.stage` | `sst secret set`, referenced by name from code | deploy, linked to the function |
| Fly.io | `[env]` in `fly.toml` | `fly secrets set`, in the platform store | machine start |
| Vercel, Netlify | one platform store per environment | the same store, with a "sensitive" or "secret" flag | build and runtime |

Most of these tools keep public config in the repository per stage, and refer
to secrets by name in a store. Kubernetes and ECS also let public values be
references, resolved when the container starts, which is what `env()` does.
None of them rebuilds public values from the deploy shell on every deploy.
This ADR moves Composer to the same two options: literals in code, and named
references into a per-stage store.

## Consequences

1. **A pointer value is not validated at deploy.** A bad value fails when the
   new deployment boots. Composer creates each deployment with `start: true`
   and `promote: true`. The upstream Alchemy resource (`Prisma.Deployment`)
   starts the deployment, waits until the platform reports it `running`, and
   only then moves the app's endpoint to it. If the platform reports `failed`,
   the deploy fails, the new deployment is cleaned up, and the old deployment
   keeps serving. Composer has no health check of its own. So the old version
   keeps serving only if the platform reports a process that exits during
   start as `failed` before it reports `running`. Neither Composer's nor
   Alchemy's code settles this; it depends on how Prisma Compute decides that
   a deployment is running. It must be confirmed before this ADR is accepted.
   Without that guarantee, a bad pointer value can be promoted and take the
   service down.
2. **A pointer value is not recorded in the input document.** The deploy
   record alone does not reproduce a deploy. Composer never sees the value. It
   sees only the variable's `updatedAt` timestamp, at the next deploy. A
   running deployment keeps the old value until a new deployment replaces it;
   a restart does not pick up the new value. This is how `envSecret()` works
   today, and it now applies to public values bound with `env()`.
3. **Pointer values stay write-only.** The CLI cannot show an `env()` value,
   and the deploy cannot validate it before boot. One option for a follow-up
   is a non-secret flag on platform env variables, so the CLI can read public
   values back and the deploy can validate and record them. That needs a
   platform change and is not part of this ADR.
4. **Deploy-time validation covers less.** Problems at an `env()` path move to
   boot. If an `env()` leaf decides the shape of the input, such as a union
   discriminator, the placeholder can make the schema report problems at
   other paths too. Bind such fields to literals.
5. **Every pointer name must exist for the stage.** There is no optional
   pointer. A field that is set in some stages only is left unbound in the
   others, which module code decides per stage, or the variable is created in
   every stage.
6. **A new stage needs its variables before its first deploy.** The preflight
   no longer creates them from the shell. The failure lists each missing name
   and the command to set it.
7. **The shell no longer changes the result of a deploy,** unless a module uses
   `fromShell()`, and then the dependency is visible in `module.ts`. The same
   commit and the same stage produce the same input document.
8. **Local dev keeps reading the shell.** `prisma dev` has no platform store.
   Its preflight (`local-target/preflight.ts`) already copies `envSecret`
   names from the shell into a local store under the dev directory, or uses a
   placeholder. It does the same for `env()` names, but a missing `env()` name
   is a hard error, as a missing env-sourced param is today, because a
   placeholder would fail schema validation at boot with a confusing message.
   `fromShell()` reads the shell in dev as it does in a deploy.

## Migration

- **`envParam('NAME')` in an input binding** becomes `fromShell('NAME')` where
  the shell read is intended. The behavior is the same. Where the value is the
  same in every stage, or chosen per stage in module code, it becomes a
  literal. Where the value lives per stage on the platform, it becomes
  `env('NAME')`. `CONTRIBUTING.md` asks for no compatibility aliases before
  1.0, so by default `envParam` is removed from input bindings in the same
  release that adds `fromShell` and `env`. A deprecation window, in which
  `envParam` still works and the deploy prints the replacement, needs the
  maintainers to make an exception.
- **`envParam('NAME')` on a reserved param** (`params: { port: … }`) already
  works as a pointer, so it becomes `env('NAME')` with no change in behavior.
- **`envSecret('NAME')`** is unchanged. It cannot become `env('NAME')` on a
  `secretString()` field, because Composer cannot read secretness from the
  schema (§ Why the binding still says "secret").
- **Existing modules** keep deploying until `envParam` is removed. The input
  document gains the `$env` pointer. The reserved-key escaping of ADR-0042
  (consequence 2) extends to `$env`, so a user key named `$env` still
  round-trips.
- **Deploys that rely on the preflight copying a missing name from the shell**
  must set the name on the platform first.
- **pdp-control-plane** binds its 37 public names with `env()`, sets each once
  per stage on the platform, and removes the Doppler step and the drift test.
  Stages that should not have a value leave the field unbound, as module code
  already does today for names only some stages have.

## Alternatives considered

- **Keep reading public values from the shell, and make CI export them more
  easily**, for example with an env-file input on `cloud-deploy-action`. This
  keeps every deploy dependent on the shell, so the same commit and stage can
  still produce different deploys, and agents still cannot see the inputs.
  Rejected.
- **One `env()` for public and secret fields, with secretness read from the
  schema.** Standard Schema exposes only `validate`, and ADR-0042 rejected
  reading library internals. Trying both a string and a box at each leaf and
  keeping whichever passes is guessing, which
  [the architectural principles](../01-principles/architectural-principles.md)
  rule out. Rejected.
- **Keep the preflight's copy from the shell for missing names.** It never
  overwrites, so it only affects the first deploy of a name in a stage. It
  still makes that deploy depend on the shell, and the dependency is not
  visible in module code. Rejected for this ADR. A separate explicit command
  that seeds a stage from a file could replace it.
- **Make public platform variables readable first, then read `env()` values at
  deploy.** This would allow deploy-time validation and recording. It needs a
  platform change, and the pointer model in this ADR works without it. Listed
  as a follow-up in consequence 3.
- **A per-stage config file in the repository, as Pulumi does.** Composer
  modules are code, and literals per stage in module code already give this.
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
  the deployment's `triggers` that replace it when a pointer variable changes.
- [`../10-domains/config-params.md`](../10-domains/config-params.md): the
  sources of a value.
