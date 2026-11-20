# ADR-0048: Prisma Cloud resources come from the upstream Alchemy provider

Amended by [ADR-0057](ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md): resource IDs are the node's full address for its main resource and the address plus `.` and a role for its other pieces (`shop.web`, `shop.web.deploy`), not `${id}-svc` and `${id}-deploy`. Each declares its previous ID with `renamedFrom`.

Amended 2026-10-30: from Alchemy 2.0.0-beta.84 the provider is its own package, `@alchemy.run/prisma`, versioned in lockstep with `alchemy`; before that it was the `alchemy/Prisma` module of the `alchemy` package. Only `@prisma/composer-prisma-cloud` and the Prisma Cloud internals it bundles depend on it; `@prisma/composer` and `@prisma/composer-cli` depend on `alchemy` alone. The move kept every resource type id (`Prisma.*`), so deploy state carries over unchanged. The decision below is unchanged.

## Decision

Composer does not implement Alchemy resources for Prisma Cloud's Management API. It composes the official upstream Prisma provider's (`@alchemy.run/prisma`, formerly `alchemy/Prisma`) resources and providers, and defines its own resources only where the upstream provider has no support yet (buckets, whose routes upstream deferred) or where no Management API exists behind them (local mechanisms like migration steps).

The live wiring is composition, not implementation:

```ts
// lowering/src/providers.ts — deploys run on upstream's providers
Layer.mergeAll(
  Prisma.ProjectProvider(),
  Prisma.DatabaseProvider(),
  Prisma.ConnectionProvider(),
  Prisma.AppProvider(),
  Prisma.DeploymentProvider(),
  environmentVariableProvider(), // upstream's, deleting the rows an older Composer wrote (ADR-0069)
),
// + Composer's own resources: Bucket, BucketKey, ServiceKey,
//   GeneratedParam, S3Credentials, OrmMigration, PgWarm
```

and a lowered compute service is upstream resources wired by Composer's descriptors:

```ts
const app = Prisma.App(`${id}-svc`, { project, regionId, branchId });
const deployment = Prisma.Deployment(`${id}-deploy`, {
  app: appAfter(app.appId, producerOutputs), // see "The ordering edge" below
  artifactPath,                              // Composer's own tar.gz — never built by Alchemy
  variables,                                 // the service's COMPOSER_ keys (ADR-0069)
  triggers,                                  // one `<name>:updatedAt` per platform variable it reads
  start: true,
  promote: true,
});
```

Local dev keeps the shape ADR-0041 defined: the local target binds the same upstream resource *classes* to Composer's emulator providers at the `LowerOptions.providers` seam. Upstream's built-in dev mode (its providers register live and local variants and the engine picks by run mode) is never mounted; Composer swaps the whole layer.

Why hand Composer's most platform-critical surface to an external package: the provider tracks the Management API at its source, and its deploy lifecycle is stronger than what it replaced — failed deployments are cleaned up rather than leaked, terminal statuses fail fast instead of polling to timeout, and the stable endpoint is read by observing the App after promote rather than trusting the promote response.

## The compute family binds the low-level trio, not `Prisma.Compute`

Upstream offers two shapes for compute: a composite `Prisma.Compute` that owns app, environment, and deployment in one resource, and the low-level `App` / `Deployment` / `EnvironmentVariable`. Composer uses `App` and `Deployment`; `EnvironmentVariable` is declared only by `prisma dev` for a dev server, and its hosted provider stays registered to delete rows an older Composer wrote ([ADR-0069](ADR-0069-a-services-composer-keys-travel-with-its-deployment-as-service-variables.md)). The deciding constraint is a cycle:

Every service's environment includes `COMPOSER_<ADDRESS>_ORIGIN` — the service's *own* platform-assigned endpoint domain (ADR-0039). A composite resource that owns both the environment and the app makes that value an input of the very resource that produces the domain: a self-edge the planner rejects. Split, the wiring is legal: the App exists first and hands out `appEndpointDomain`, and the Deployment is created with the value in its `variables`.

Two supporting reasons:

- `Compute` manages environment rows through an internal ownership map and refuses in-scope rows absent from it; Composer's keys are service variables on the create-deployment request, which that map does not describe.
- `Compute` carries build, framework detection, and bundling. Its `artifactPath` prop bypasses them, but a bypass is a prop value; `Prisma.Deployment` has **no build path at all**, which is ADR-0005's guarantee in structural form.

What the trio costs: `Compute`'s preview/stable health checks and automatic rollback are not inherited, and deployment reuse must be handled by Composer (next two sections).

## The ordering edge rides the `app` prop

A consumer's deployment must not go live before its producers', or a consumer could call a method its producer has only just added. A compute service publishes its App's `appEndpointDomain` as its `url`, not its Deployment's: the Deployment is updated on every deploy, so its domain is unknown while planning, and every consumer whose `variables` hold the url would be replaced on every deploy. The App exists before any deployment, so the url alone orders nothing. Upstream's `Deployment` has no prop for that dependency, so Composer builds the edge into the `app` prop: an Output over the app id *and* every output of the nodes the service depends on, resolving to the app id (`appAfter` in `lowering/src/compute/deployment-edge.ts`). A compute producer's `serviceId` output comes from its Deployment and resolves only after the producer is promoted. Alchemy derives its graph from the resource references inside prop values, so every producer is promoted first, and an unchanged consumer is still reused because nothing in its `variables` or `triggers` changes.

The edge must not ride `artifactPath`. Upstream's diff reads `{portMapping, skipCodeUpload, artifactPath, artifactContentType}` as one block and offers no opinion when any member is unresolved — and an output of a resource the same deploy is changing is unresolved at plan time. The consequence of getting this wrong is severe and quiet: the artifact comparison never runs, the engine falls back to a plain update, and the reconcile keeps the running deployment while recording the new artifact's fingerprint as deployed — a code change silently never ships, and every later deploy agrees it already did. The `app` prop sits outside that block and tolerates being unresolved. `compute/__tests__/deployment-edge.test.ts` drives upstream's real diff and real Output machinery and fails if the edge ever moves back.

## A deployment is replaced when its environment changes

The platform copies a service's environment into a deployment when it creates it, and upstream reuses a deployment whose artifact is unchanged — so a value-only change (a rotated secret) must replace the deployment to reach the running app. Two props of `Prisma.Deployment` carry the values whose change replaces it.

- **`variables`**, the service's `COMPOSER_` keys ([ADR-0069](ADR-0069-a-services-composer-keys-travel-with-its-deployment-as-service-variables.md)). Upstream records a salted hash of the resolved map and plans a replacement when the hash changes, when a value is not resolved at plan time (its producing resource is itself changing in the same deploy), and when the prop is declared on a deployment that recorded no hash, because an update creates no deployment and the values would never reach the platform. Because upstream resolves the actual values, a value re-issued under a stable resource identity (a connection rotated in place, a re-minted service key) replaces too.
- **`triggers`** (upstream's replacement-inputs prop, shipped in alchemy 2.0.0-beta.74; designed as `redeployOn` and renamed in review), with one member per platform variable the service reads. Composer never holds such a variable's value, so its out-of-band rotation is detected through its `updatedAt` metadata, read at preflight and passed to the lowering as a value (a timestamp, never a variable's value), and joined as a `<name>:updatedAt` member. Upstream folds the members into a salted fingerprint and replaces when one moved; a member unresolved at plan time replaces conservatively, and the first deploy that declares `triggers` records its fingerprint through a plain update.

A service's input document is in neither: it travels in the artifact ([ADR-0065](ADR-0065-a-compute-services-input-document-travels-in-its-artifact.md)), so a changed document changes the artifact and replaces the deployment that way.

The values in `variables` are stored in deploy state in plain text: Alchemy writes every prop to state, and writes a `Redacted` value as its text. `Redacted` keeps them out of logs and error messages. Each is a value the deploy produced, never a platform variable's value, which the deploy never holds.

## Consequences

- **Namespaces.** The `Prisma.*` resource type-id namespace and the `'Prisma'` collection tag belong to upstream. Composer's collection tag is `'PrismaComposer'` and its own resources are `PrismaComposer.*`. Rows persisted under retired Composer type-ids are rewritten on read by the hosted state store (`state/legacy-resources.ts`): ids, attribute shapes, and the retirement of the `DATABASE_URL` claim rows that earlier versions tracked as resources (see "Claim both names with a placeholder" under Alternatives considered). The module is the durable compatibility boundary for state written by earlier Composer versions. Scope: "legacy" here means rows already INSIDE the platform state API (ADR-0045), written under retired type-ids or shapes. The older generation — the retired SQL `prisma-composer-state` stores — stays under ADR-0045's own rule: never read, cleaned up by destroy or Branch deletion. The two rules govern different stores and do not overlap.
- **Branch-stage databases carry generated physical names.** Upstream refuses an explicit name combined with branch attachment at create — and it is right to: the Management API creates the database and attaches the branch in separate transactions with no idempotency key, so a lost response is indistinguishable from a foreign database. Attaching after create does not survive either: upstream's reconcile detaches a branch its props don't declare. So branch stages attach at create and take the generated name; production keeps explicit names.
- **The platform's `DATABASE_URL` is left alone.** Prisma Cloud writes `DATABASE_URL`/`DATABASE_URL_POOLED` only when a project is created with a database, or when a database is created as the project's default, and marks them system-managed; upstream refuses to manage system-managed variables. Composer creates projects without a database and never creates a default one, so the platform writes neither on a Composer project. Composer never creates, overwrites, updates, deletes, or tracks either variable. The guarantee that apps read configuration through the framework is held at the authoring end: `variable()` and `variable.secret()` reject the reserved names (`variable-name.ts`), and every key Composer sends is `COMPOSER_`-prefixed. An app that reads `process.env.DATABASE_URL` directly sees whatever the platform or the user put there.
- **Auth never touches Alchemy's profile store.** Alchemy's own credential flow prompts on a TTY and hard-fails non-interactive; Composer runs alchemy as a subprocess with piped stdio. Composer provides `PrismaEnvironment` directly from `PRISMA_SERVICE_TOKEN`, with one base-URL resolver shared between upstream's providers and Composer's own SDK client so both always target the same host.
- **A known weakness is inherited:** upstream retries a conflicting App delete for only a few seconds, where Composer's own resource waited out deployment drain for minutes. Slow drains can fail a destroy and need a re-run.

## Alternatives considered

- **Keep Composer's own resources.** Six Management API wrappers whose drift Composer pays for alone, with a weaker deploy lifecycle than upstream's.
- **The composite `Prisma.Compute`.** Rejected for the self-edge, the environment-ownership map, and ADR-0005 (above).
- **Vendor the provider's source into Composer.** Mechanically possible; inherits its dependencies and permanent drift. Kept only as a fallback if a future alchemy upgrade proves unshippable.
- **Adopt upstream's built-in dev mode instead of the local target.** Would replace a whole-layer seam that already works with per-provider substitution, and tie local-dev iteration to an external release cadence.
- **Write each `COMPOSER_` key as a `Prisma.EnvironmentVariable` row, ordered before the deployment through the `app` prop, with one `triggers` member per row repeating its value.** The position before ADR-0069. The `app` edge held every whole row resource, because a persisted variable ID can resolve while its value update is still pending. Rows were branch overrides on preview, which the platform is removing; the record of that change is ADR-0069.
- **Take a consumer's url from its producer's Deployment.** Its domain is unknown while planning, so every consumer would be replaced on every deploy.
- **Replace the deployment on every deploy** (the pre-adoption behavior). Ships every change by brute force but gives up upstream's reuse entirely; superseded first by the Composer-side fingerprint, then by `Deployment.triggers`.
- **Claim both names with a placeholder.** Earlier versions wrote `"-"` under `DATABASE_URL` and `DATABASE_URL_POOLED`, in the production and preview classes at project level, so the platform could not put a live credential there. The first versions did it through tracked `EnvironmentVariable` resources, so the rows were in deploy state; later versions did it with create-only calls outside deploy state. Both rested on the belief that the platform fills in a missing `DATABASE_URL` on the first Compute deploy from any ready database in the project. The platform does not do that, so on a Composer project the rows protected nothing. Rows already written stay on existing projects. State entries from the tracked form are dropped on read by `state/legacy-resources.ts`, with no call to the platform.
- **Hash environment values Composer-side.** A bare hash of a secret in a plaintext path or state row is an offline-guessing target; rejected. The interim Composer-side fingerprint therefore hashed only material that was non-secret by construction (accepting the re-issued-value narrowing above); upstream's `triggers` avoids the exposure differently — a salted fingerprint computed and persisted inside alchemy's own state, never a bare hash of a secret in the open.

## References

- ADR-0005 (the framework never builds or bundles user code), ADR-0034 (hosted deploy state), ADR-0039 (a service's origin is a target-resolved property), ADR-0041 (local dev runs the deploy pipeline against local providers).
- The provider: the `alchemy/Prisma` module of the `alchemy` package, 2.0.0-beta.74 or later (buckets and `Deployment.triggers` first ship there). From 2.0.0-beta.84 it is the separate `@alchemy.run/prisma` package, with the same resources.
- `docs/design/05-prisma-cloud/alchemy-lowering.md` — the current resource-by-resource lowering map.
- `docs/guides/deploying.md` — operator-facing upgrade notes (one-time deployment reship, branch-database renames, leftover placeholder rows).
