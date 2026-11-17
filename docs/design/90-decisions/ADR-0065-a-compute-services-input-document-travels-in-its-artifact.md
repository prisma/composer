# ADR-0065: A Compute service's input document travels in its artifact, not in a variable

Take the service `shop.web`, declared with an input schema and bound like this:

```ts
provision(web, { input: { siteName: 'Shop', stripeKey } }); // stripeKey: the platform secret STRIPE_SECRET_KEY
```

A deploy to Prisma Cloud writes these variables on the branch for it:

```text
COMPOSER_SHOP_WEB_PORT       3000
COMPOSER_SHOP_WEB_ORIGIN     …
COMPOSER_SHOP_WEB_DB_URL     …
```

and this into the service's artifact, in `compute.bootstrap.json`:

```json
{
  "moduleEntrypoint": "./main.mjs",
  "appEntrypoint": "./server.mjs",
  "address": "shop.web",
  "inputDocument": {
    "siteName": "Shop",
    "stripeKey": { "$platform": { "name": "STRIPE_SECRET_KEY", "secret": true } }
  }
}
```

A deploy that kept every value in a variable would also have written `COMPOSER_SHOP_WEB_INPUT` as a fourth variable, holding the same document as text, and the artifact would have had no `inputDocument` field.

## Decision

On Prisma Cloud, the deploy writes a Compute service's input document into the service's artifact, in the `inputDocument` field of `compute.bootstrap.json`, as nested JSON rather than as a string that holds JSON. It creates no variable for it. A service that declares no input has no `inputDocument` field. Every other value the service reads at boot stays a variable on the platform: `port`, each dependency's connection params, the provider params (the RPC accepted keys, the streams key, the service's origin) and each generated value.

The artifact is the input document's only source. At boot the artifact's `bootstrap.js` passes the document to the service's `run(address, boot, inputDocument)`, which puts it in place of any `COMPOSER_<ADDRESS>_INPUT` variable in the environment it reads. Under `prisma dev`, the local target does not use such a variable for a service that runs its artifact. An app's author writes nothing differently: `service.input()`, `service.load()` and `service.port()` behave as before.

No secret, and no value the deploy has not resolved, is ever written into an artifact.

## Reasoning

### The input document can be in the artifact

A service's input document is the output of its input schema, with defaults applied, serialized as one JSON text ([ADR-0042](ADR-0042-service-input-is-one-standard-schema.md)). It holds the literals the author wrote and a marker for each value known only at boot. A marker names a variable; it never holds a secret's value. `serializeInput`, which builds the document's text, refuses a secret's value, a secret box the binding did not supply, and anything that is not plain data. And the deploy knows the whole document before it creates anything: it checks the binding with the schema first, then writes the result.

So the document is neither secret nor issued by the platform, and it is final before the deploy builds the artifact. Nothing stops it from being part of the artifact, and putting it there has three effects:

- **It is not limited to a variable's size.** A Prisma Cloud variable's value is limited to 8 KB, and the input document grows with every field the service declares. In the artifact it is not limited to 8 KB.
- **The settings stay with the code they were checked against.** The deploy checks the document against the service's schema and then packs both into one artifact.
- **One variable fewer per service** on the branch, and one resource fewer for the deploy to create and track.

### The other values cannot

Every other value a Compute service reads at boot is issued during the deploy or is a secret, except `port`:

| Value | Why it stays a variable |
| --- | --- |
| `port`, the only param a Compute service declares itself | It is not part of the input document: the app binds it at provision to a literal or a deploy-time value, or it takes its default ([ADR-0032](ADR-0032-params-bind-at-provision-to-a-literal-or-a-deploy-time-value.md)), and the deploy writes it as its own variable. Under `prisma dev` the Compute emulator assigns each instance its port and the local target writes this variable from it, so the artifact must not fix it. |
| Each dependency's connection params | The platform issues them during the deploy, and most are secrets. |
| The provider params: the RPC accepted keys, the streams key, the service's origin | Issued or generated during the deploy; the keys are secrets. |
| Each generated value, `COMPOSER_<ADDRESS>_<PATH>_GENERATED` | A generated secret. |

The artifact is built before the values issued during the deploy exist. A secret has no place in a file that is uploaded and stored with the code. And `port` must stay a variable, so that under `prisma dev` the local target can give each instance the port the Compute emulator assigned it. Two things keep secrets out of the artifact. `serializeInput` keeps secret values out of the document. And `compute.bootstrap.json` has one field for one value, so the compute descriptor can put the input document there and nothing else. Core's contract for `package` says the same for every target: it must not write a secret, or a value the deploy has not resolved, into the artifact.

### How the document reaches the service

The deploy builds each service in four steps, `provision`, `serialize`, `package` and `deploy` ([ADR-0056](ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md) describes each). The input document goes through them, and then through the bootstrap, like this:

1. `serialize` builds the input document and creates no variable for it. The document is on its result, in `input`, where the deploy report already reads it.
2. Core passes `serialize`'s result to `package`. Core does not look inside it.
3. `package` passes the document, as a JSON value, to the artifact packer, which writes it into `compute.bootstrap.json` as the nested value of `inputDocument`. The same document always gives the same bytes, so the artifact stays deterministic.
4. The printed `bootstrap.js` is constant code that reads `compute.bootstrap.json` and calls `main.run(boot.address, () => import(boot.appEntrypoint), boot.inputDocument)`. No text from the app is ever placed inside the JavaScript.
5. The Prisma Cloud service's `run(address, boot, inputDocument)` turns the document into its JSON text and reads the service's environment with that text under the service's input key, `COMPOSER_<ADDRESS>_INPUT`. Then `stashRows` writes the address-free copies, `PORT` and `HOST` into the process environment, and `input()`, `load()`, `port()` and `origin()` read them there.

The third parameter belongs to the Prisma Cloud service. Core's `RunnableServiceNode.run(address, boot)` has two, because how configuration travels to a service is the target's concern ([ADR-0019](ADR-0019-the-target-owns-config-serialization.md)). A test harness that calls `run(address, boot)` reads everything from the environment.

The document is not a member of the deployment's `triggers`, the values whose change makes the deploy replace a deployment. It does not need to be: a changed document changes the artifact's bytes, and so its content-addressed path, and a new path replaces the deployment. A platform variable that the document names is still a `<name>:updatedAt` trigger member, so changing that variable on the platform still redeploys exactly the services that read it.

### The artifact is the document's only source

The deploy writes the input document only into the artifact, so any `COMPOSER_<ADDRESS>_INPUT` variable that a service with an artifact finds in its environment is stale. Two rules keep a service from reading it:

- `run()` ignores that variable whenever the artifact holds the document.
- The local target ignores it for every service that runs its artifact, whether or not the artifact holds a document.

The two rules cover the same services. The artifact holds a document exactly when the service declares an input, and `run()` reads no input variable for a service that declares none. The local target cannot see the service's schema, so it ignores the variable for every service that runs its artifact.

The upgrade is the case that needs these rules today. The first deploy with this decision runs while the previous deploy's `COMPOSER_<ADDRESS>_INPUT` variable still exists on the branch. Alchemy, the deploy engine, deletes it only after the new deployment has been created, and the platform copies the branch's variables into a deployment when it creates it. So the new deployment starts with the old variable in its environment, and must not read it. The rules stay after the upgrade, because a variable left behind for any other reason must not win over the artifact either.

### Under `prisma dev`

`prisma dev` runs the same steps against the local target ([ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md)).

- **A service that runs its artifact** reads its input document from the artifact, as on Prisma Cloud. The local `Deployment` provider decides which platform variables the service's process receives from the `$platform` markers in its input document ([ADR-0058](ADR-0058-prisma-dev-reads-secrets-from-the-app-secrets-and-never-invents-them.md)). It reads the document for that from the unpacked artifact, with the reader `@internal/lowering` exports next to the packer, so the boot file's writer and reader are one package's code. A `COMPOSER_<ADDRESS>_INPUT` entry in the local target's `env.json` is not used to choose the platform variables and is not put into the process's environment, whether or not the artifact holds a document.
- **A service that runs a dev server** has no artifact ([ADR-0056](ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md)). `reserve`, the step that stands in for `package` and `deploy`, creates the input document as a `Prisma.EnvironmentVariable`, with the resource ID `<address>.env.COMPOSER_<ADDRESS>_INPUT`, that key, and the class and branch that `serialize` gives every variable of the environment. The local target keeps it in its `env.json`, so the dev server's environment is what a deployment's would be.

### Upgrading

No value is written in two places, and nothing is migrated.

- The first deploy with this decision gives every Compute service a new artifact, so every service gets a new deployment that reads its input document from the artifact. Alchemy then deletes the `COMPOSER_<ADDRESS>_INPUT` variables, which no service declares any more.
- A deployment made before the upgrade keeps running until it is replaced, with the environment it was created with.
- Putting a deployment made before the upgrade back into service afterwards is not supported: its artifact holds no input document and its variable is gone.

## Consequences

- An input document is not limited to a variable's 8 KB on Prisma Cloud.
- A Compute service has one variable fewer on the branch. The variables it keeps are the ones issued or generated during the deploy, and `port`.
- Changing an input document redeploys exactly the service that reads it, through the artifact's path rather than the deployment's triggers.
- The artifact holds configuration. It holds no secret, but anyone who can read the artifact can read the literals the author wrote into the input document.
- `ServiceLowering.package` receives `serialize`'s result, under a contract that forbids writing a secret or an unresolved value into the artifact. Core still knows nothing about what the result holds.
- A deployment made before the upgrade cannot be put back into service after it.

## Alternatives considered

- **Keep every value a variable.** Rejected: a variable's value is limited to 8 KB, and the input document grows with every field a service declares.
- **A general map in `compute.bootstrap.json` of `COMPOSER_` keys to text, laid over the environment at boot.** Rejected. It accepts keys that nothing may put there, since every value other than the input document is a secret or is issued during the deploy, except `port`, which the Compute emulator has to be able to set under `prisma dev`. A later entry would silently shadow a variable with the same key. And the guarantee that no secret reaches the artifact would rest on which keys the descriptor happens to put in an open map, instead of on a field that can hold only the input document.
- **Write the document into `compute.bootstrap.json` as its JSON text, a string inside the JSON file.** Rejected. The text form was left over from the time the document lived in a variable, whose value can only be text. A nested value is readable in the file, and a reader gets the document with the one parse of the file instead of a second parse of the string. `run()` turns the value back into text in one place, for the environment that `input()` reads.
- **Let the environment win over the artifact.** Rejected: the first deploy after the upgrade would read the previous deploy's document, which is still a variable on the branch when the new deployment is created.
- **Write the document to both places for one release.** Rejected: it gives one value two sources that can disagree, for a rollback to a deployment made before the upgrade that is not supported anyway.

## Related

- [ADR-0019](ADR-0019-the-target-owns-config-serialization.md): the target owns serialization and its medium.
- [ADR-0042](ADR-0042-service-input-is-one-standard-schema.md): the input document.
- [ADR-0056](ADR-0056-prisma-dev-runs-a-service-with-its-build-adapters-dev-server.md): `reserve`, `stashRows` and dev servers.
- [ADR-0041](ADR-0041-local-dev-runs-the-deploy-pipeline-against-local-providers.md): the local `Deployment` provider.
- [ADR-0029](ADR-0029-a-secret-is-an-environment-sourced-value-the-framework-never-stores.md): the framework never stores a secret's value.
- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md): the framework assembles the artifact by documented, deterministic steps.
- [alchemy-lowering.md](../05-prisma-cloud/alchemy-lowering.md): the deployment's triggers.
- [core-model.md](../10-domains/core-model.md): booting a service.
