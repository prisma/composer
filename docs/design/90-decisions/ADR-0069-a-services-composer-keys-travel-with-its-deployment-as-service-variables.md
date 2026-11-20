# ADR-0069: A service's `COMPOSER_` keys travel with its deployment as service variables

Take the app `shop`, where `shop.web` depends on the RPC interface `shop.auth` exposes. When a deploy creates a deployment of `shop.web`, its request to Prisma Cloud carries every key the service reads at boot:

```http
POST /v1/services/svc_2/deployments
```

```json
{
  "portMapping": { "http": 3000 },
  "variables": {
    "COMPOSER_SHOP_WEB_PORT": "3000",
    "COMPOSER_SHOP_WEB_AUTH_URL": "https://svc_1.cdg.prisma.build",
    "COMPOSER_SHOP_WEB_AUTH_SERVICEKEY": "…",
    "COMPOSER_SHOP_WEB_ORIGIN": "\"https://svc_2.cdg.prisma.build\"",
    "COMPOSER_SHOP_WEB_RPC_ACCEPTED_KEYS": null,
    "COMPOSER_SHOP_WEB_STREAMS_API_KEY": null,
    "COMPOSER_SHOP_WEB_BILLING_URL": null
  }
}
```

The platform stores the values on the service, and every deployment of the service receives them. `shop.web` exposes nothing and serves no streams, so its accepted keys and its streams key are `null`. It depended on `billing` in an earlier deploy and no longer does, so that key is `null` too. The deploy writes no environment variable row.

## Decision

On Prisma Cloud the deploy sends a Compute service's `COMPOSER_` keys in the `variables` field of the request that creates the service's deployment. The platform stores them as **service variables**: a string sets a key, `null` deletes it, and a key not sent keeps its stored value. Keys keep their names, so nothing changes in how a service boots. The deploy writes no `Prisma.EnvironmentVariable` for a service on Prisma Cloud.

- **Every key boot reads is sent, as a value or `null`.** That is each declared param (`port` and each dependency's connection params) and each reserved provider param (`RESERVED_PROVIDER_PARAMS`: the RPC accepted keys, the streams key, the origin), for every service, on every deploy, plus each generated value the input document names. A key with no value is `null`.
- **A name Composer no longer sends is deleted.** A Composer resource, `PrismaCloud.SentVariableNames`, one per service with the ID `<address>.sent-variable-names`, takes this deploy's variable names and keeps every name it has ever been given in deploy state. It holds names, never values. The deploy sends `null` for every recorded name it no longer sends.
- **At most 50.** `serialize` refuses a service with more than 50 keys that are not `null` before any resource is created, changed or deleted (the branch's application topology has already been replaced and the build recorded by then), naming the service, the count and the limit (`SERVICE_VARIABLE_LIMIT` in `descriptors/shared.ts`). `null` is not counted.
- **Only `COMPOSER_` keys.** The map never holds a platform variable's value or any other value the operator sets.
- **The deployment is replaced when the map changes.** `Prisma.Deployment` records a salted hash of the resolved map and plans a replacement when it changes, when a value is not resolved while planning, and when the prop is declared on a deployment that recorded no hash. The deployment's `triggers` keep only the `<name>:updatedAt` member of each platform variable the service reads.
- **The input document stays in the artifact** ([ADR-0065](ADR-0065-a-compute-services-input-document-travels-in-its-artifact.md)).
- **A dev server keeps rows.** Under `prisma dev` a service that runs its artifact takes its keys from its deployment's `variables`, leaving out a `null`. A service that runs a dev server has no deployment, so `reserve` declares a local `Prisma.EnvironmentVariable` for each key that is not `null`, and one for the input document. `reserve` fails as a bug in any application other than the local, branchless one, so no row reaches Prisma Cloud.
- **The hosted `Prisma.EnvironmentVariable` provider stays registered**, so that Alchemy can delete the rows an older Composer wrote, on the first deploy and on `destroy` of an environment last deployed by an older version.

The change can ship only when the platform accepts `variables` in production and both the upstream provider (`@alchemy.run/prisma`) and the generated client (`@distilled.cloud/prisma`) have released the field. Until then this repository adds the field with `pnpm` patches under `patches/`, and `check:patched-dependencies` fails, because a published package would install the unpatched provider, which drops `variables` without an error.

## Reasoning

### Why service variables

The platform is removing branch overrides, which is how Composer wrote these keys on every preview deploy. A variable group is shared by every branch that receives it, and these values differ per branch, so the keys cannot move into a group. Service variables belong to one service, which is what every `COMPOSER_` key is: at boot a service reads only the keys under its own address (`stashRows` in `serializer.ts`), and a value it gets from another service is copied under its own key at deploy. The platform sets them only through the create-deployment request.

### Why every key boot reads is sent

With stored service variables, a key that is left out keeps whatever an earlier deploy stored. For most keys that would only be stale. For the streams key it would open a hole: a streams service with no consumer gets no key and refuses to boot, which is the fail-closed behaviour the streams module depends on. If the old key stayed stored, the service would keep booting and keep accepting it. So every key boot can read is sent on every deploy, and a missing value is `null`. A `null` is a literal known while planning and the same on every deploy, so it never replaces a deployment on its own. The platform accepts a `null` for a key it does not hold and does not count it.

### Why a record of sent names

A key the service's code no longer declares, such as a removed dependency's params or a renamed generated value, would otherwise stay stored: a stale secret readable by every later deployment, counted toward the limit, and left for the user to find and delete. `SentVariableNames` remembers every name, and the deploy sends `null` for each name it no longer sends, on that deploy and every later one.

When a deploy sends the same names as the last one, the record's input is unchanged, the engine plans no change for it, and its output is known while planning. The map is then the same as last time and the deployment is reused. A test with the real Alchemy engine deploys twice with nothing changed and checks that no second deployment is created. When the names change, the record changes, its output is not known while planning, and the deployment is replaced, which a changed key set needs anyway.

### Why the replacement rule differs from `triggers`

Upstream records a `triggers` hash through a plain update the first time `triggers` is declared. An update creates no deployment, and the platform takes `variables` only when a deployment is created, so a deployment that gained `variables` through an update would never send them. A `variables` prop with no recorded hash therefore replaces.

### What is in deploy state

Alchemy writes every prop to deploy state, and it writes a `Redacted` value as its plain text. So the values in `variables` are stored in deploy state in plain text, as the rows and the trigger members that repeated them were before. This is no change in exposure: every value is one the deploy produced, never a platform variable's value, which the deploy never holds. `Redacted` keeps the values out of logs and error messages.

### The limit

A service has at most 50 service variables. The platform's own error arrives in the middle of a deploy, after other services have changed, and says only "Quota exceeded for service_variable". Composer counts its own keys first. It cannot see variables a user set on the service in Console, and those count too.

## Consequences

- **The first deploy of an existing app with this version** replaces each service's deployment once, because the deployment declares `variables` for the first time. The new deployment is created with every value. Alchemy then deletes the variable rows in its state that no deployment declares any more, on production and on preview, each after the old deployment it fed has stopped. A deployment still draining open connections holds its rows until a later deploy finds it stopped, so rows can stay visible in Console after the first deploy. While a row and a service variable both exist, the service variable wins.
- **A key that loses its value in the upgrade deploy is still read from its old row.** A `null` deletes a service variable, not a row, and the new deployment is created while the old rows still exist. So if the same deploy removes a dependency, or the last consumer of a streams service, the new deployment receives the old row's value for that key and keeps it until the deployment is next replaced. Composer releases before this one behave the same. Make the upgrade deploy on its own, or deploy that service once more with a changed artifact afterwards.
- **A row that cannot be deleted does not fail the deploy.** A row already deleted in Console, or one the platform manages, is skipped by the upstream provider. A row the platform refuses to delete because its recorded project, branch, class or key differ from the platform's is dropped from deploy state, and the deploy logs a warning naming the key and saying to delete it in Console. Composer's own provider layer (`providerForDeletingOldVariableRows()` in `lowering/src/providers.ts`) does this, around upstream's. Without it, one such row would fail this deploy and every later one.
- **An interrupted upgrade finishes on the next deploy** without replacing any deployment again.
- **The key-clash check is gone.** It refused a deploy while an old row held a key that a different node owned after the move to full addresses ([ADR-0057](ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md)). With no rows written, two rows cannot collide. One case remains for an app that upgrades directly from a version before full addresses: a service whose new key equals another service's old key, and which has no value for it, would receive the other service's old row once. Such an app deploys once with any release from 0.35.0 to 0.39.0 first.
- **Going back to an older Composer is not supported.** An older version writes rows again, and the service variables this version stored win over them, so a value that changed since, such as a rotated connection, never reaches the service. A user can delete those service variables in Console first, and the older version's next deployment then reads its rows.
- **A user can change a service's variables in Console**, `COMPOSER_` keys included. Every deploy that creates a deployment sets Composer's own keys again, and deletes the names Composer no longer sends. A change made in Console takes effect by creating a deployment, and the next `prisma deploy` makes Composer's own deployment live again: a value the user set under another name stays stored and reaches Composer's deployment from its next replacement on, and a `COMPOSER_` key the user changed is set back on that replacement. Composer reads none of them.
- **Destroy** deletes the App, and the platform deletes its service variables with it.

## Alternatives considered

- **Composer keeps writing rows, as branch overrides on preview and class rows on production.** The position before this record. Rejected: the platform rejects override writes three months after variable groups ship, which would fail every preview deploy.
- **Composer writes rows into the branch's variable group.** Rejected: a group is shared by every branch that receives it, and these values differ per branch.
- **Send a service's complete set and let the platform delete everything else stored on it.** Rejected: it would delete values a user set on the service in Console, on every deploy.
- **Leave behind the keys a service stops declaring.** Rejected: a stale secret reaches every later deployment, and a service that reached 50 could not be deployed or cleaned up by its user.
- **The provider reads the service's current keys before creating the deployment and sends `null` for those under Composer's prefix.** Rejected: a second prop on the upstream resource, one more call per deployment, and a dependency on the platform listing a service's keys correctly.
- **Composer reads every service's keys before the deploy and passes the stale ones as `null`.** Rejected: the `null`s disappear from the props once applied, which replaces each such deployment a second time on the following deploy.
- **The platform takes a "delete every key with this prefix that I did not send" flag.** Atomic, but a new request to the platform and nothing Composer can build against today.
- **The provider remembers the keys it sent.** Does not work: Alchemy creates a replacement without the old instance's props or outputs, and every value change here is a replacement.
- **Keep each value in `triggers` and pass `variables` with no hash of its own.** No new diff logic upstream, but every value would be stored twice in props.
- **One variable holding all of a service's keys as JSON.** Rejected: a value is limited to 8,192 characters, and it changes how every service boots.
- **A Composer-owned resource for service variables.** Not possible: the platform sets them only through the create-deployment request.
- **Hand the dev server its values without rows.** Rejected: core would have to pass every local target a new thing for one target's reason. Rows through the local provider need no core change.

## Related

- [ADR-0048](ADR-0048-prisma-cloud-resources-come-from-the-upstream-alchemy-provider.md): the upstream provider, the ordering edge and change propagation.
- [ADR-0065](ADR-0065-a-compute-services-input-document-travels-in-its-artifact.md): the input document travels in the artifact.
- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md): local dev runs the deploy pipeline against local providers.
- [ADR-0056](ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md): `reserve` and dev servers.
- [ADR-0057](ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md): keys built from the full address.
- [ADR-0064](ADR-0064-an-app-declares-its-platform-variables-in-its-root-and-the-deploy-copies-no-local-values.md): platform variables, which the operator sets and the deploy never writes.
- [alchemy-lowering.md](../05-prisma-cloud/alchemy-lowering.md): the resources a compute service lowers to.
