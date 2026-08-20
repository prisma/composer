# ADR-0048: Prisma Cloud resources come from the upstream Alchemy provider

## Decision

Composer does not implement Alchemy resources for Prisma Cloud's Management
API. It composes the official `alchemy/Prisma` provider's resources and
providers, and defines its own resources only where no Management API exists
behind them.

The live wiring is composition, not implementation:

```ts
// lowering/src/providers.ts — deploys run on upstream's providers
Layer.mergeAll(
  Prisma.ProjectProvider(),
  Prisma.DatabaseProvider(),
  Prisma.ConnectionProvider(),
  Prisma.AppProvider(),
  Prisma.DeploymentProvider(),
  Prisma.EnvironmentVariableProvider(),
),
// + Composer's own resources: Bucket, BucketKey, ServiceKey,
//   GeneratedParam, S3Credentials, PnMigration, PgWarm
```

and a lowered compute service is upstream resources wired by Composer's
descriptors:

```ts
const app = Prisma.App(`${id}-svc`, { project, regionId, branchId });
const vars = records.map((r) => Prisma.EnvironmentVariable(...));
const deployment = Prisma.Deployment(`${id}-deploy`, {
  app: dependsOnEnvironment(app, vars),   // see "The ordering edge" below
  artifactPath,                            // Composer's own tar.gz — never built by Alchemy
  start: true,
  promote: true,
});
```

Local dev keeps the shape ADR-0041 defined: the local target binds the same
upstream resource *classes* to Composer's emulator providers at the
`LowerOptions.providers` seam. Upstream's built-in dev mode (its providers
register live and local variants and the engine picks by run mode) is never
mounted; Composer swaps the whole layer.

Why hand Composer's most platform-critical surface to an external package:
the provider tracks the Management API at its source, and its deploy
lifecycle is stronger than what it replaced — failed deployments are cleaned
up rather than leaked, terminal statuses fail fast instead of polling to
timeout, and the stable endpoint is read by observing the App after promote
rather than trusting the promote response.

## The compute family binds the low-level trio, not `Prisma.Compute`

Upstream offers two shapes for compute: a composite `Prisma.Compute` that
owns app, environment, and deployment in one resource, and the low-level
`App` / `Deployment` / `EnvironmentVariable`. Composer uses the low-level
trio. The deciding constraint is a cycle:

Every service's environment includes `COMPOSER_<ADDRESS>_ORIGIN` — the
service's *own* platform-assigned endpoint domain (ADR-0039). A composite
resource that owns both the environment rows and the app makes that row an
input of the very resource that produces the domain: a self-edge the planner
rejects. Split, the wiring is legal: the App exists first and hands out
`appEndpointDomain`, environment rows are written from it, the Deployment
comes last.

Two supporting reasons:

- `Compute` owns environment rows through an internal ownership map and
  refuses in-scope rows absent from it; Composer's per-key rows have no
  honest mapping into that map.
- `Compute` carries build, framework detection, and bundling. Its
  `artifactPath` prop bypasses them, but a bypass is a prop value;
  `Prisma.Deployment` has **no build path at all**, which is ADR-0005's
  guarantee in structural form.

What the trio costs: `Compute`'s preview/stable health checks and automatic
rollback are not inherited, and deployment reuse must be handled by Composer
(next two sections).

## The ordering edge rides the `app` prop

Environment rows must be written before the deployment is created, because
the platform snapshots the branch environment into a deployment at create.
Upstream's `Deployment` has no prop for that dependency, so Composer builds
the edge into the `app` prop: an Output over the app id *and* every
environment row's id, resolving to the app id
(`lowering/src/compute/deployment-edge.ts`). Alchemy derives its graph from
the resource references inside prop values, so every row is scheduled first.

The edge must not ride `artifactPath`. Upstream's diff reads
`{portMapping, skipCodeUpload, artifactPath, artifactContentType}` as one
block and offers no opinion when any member is unresolved — and a brand-new
environment row is always unresolved at plan time. The consequence of
getting this wrong is severe and quiet: the artifact comparison never runs,
the engine falls back to a plain update, and the reconcile keeps the running
deployment while recording the new artifact's fingerprint as deployed — a
code change silently never ships, and every later deploy agrees it already
did. The `app` prop sits outside that block and tolerates being unresolved.
`compute/__tests__/deployment-edge.test.ts` drives upstream's real diff and
real Output machinery and fails if the edge ever moves back.

## A deployment is replaced when its environment changes

The platform bakes environment values into a deployment at create, and
upstream reuses a deployment whose artifact is unchanged — so a value-only
change (a rotated secret) would update the platform's variable row and never
reach the running app. Composer closes this with a deploy fingerprint
(`compute/deploy-fingerprint.ts`): the artifact hard-link directory is named
from a hash of the service's environment material, so the resolved
`artifactPath` upstream compares moves exactly when the environment does —
unchanged service, identical path, deployment reused; changed environment or
artifact, new path, replace.

The fingerprint hashes only non-secret material. Composer's environment rows
carry none (ADR-0042: secrets are pointers to platform variables, not
values); secret-bearing rows contribute their wiring identity, not a value.
Out-of-band rotation of a pointed platform variable is detected through its
`updatedAt` metadata, read at preflight and carried to the Alchemy process
over the framework's preflight-transport channel (a timestamp, never a
value). One accepted narrowing, recorded in the module: a value re-issued
under a stable resource identity (a connection rotated in place, a re-minted
service key) does not move the fingerprint; the deployment ships it on the
next change that does. Upstream's `Deployment.redeployOn` closes that
properly once released — alchemy resolves and diffs those inputs inside its
own encrypted state — and the fingerprint then moves onto it at a marked
seam.

## Consequences

- **Namespaces.** The `Prisma.*` resource type-id namespace and the
  `'Prisma'` collection tag belong to upstream. Composer's collection tag is
  `'PrismaComposer'` and its own resources are `PrismaComposer.*`. Rows
  persisted under retired Composer type-ids are rewritten on read by the
  hosted state store (`state/legacy-resources.ts`): ids, attribute shapes,
  and the retirement of the legacy claim rows below. The module is the durable
  compatibility boundary for state written by earlier Composer versions.
- **Branch-stage databases carry generated physical names.** Upstream
  refuses an explicit name combined with branch attachment at create — and
  it is right to: the Management API creates the database and attaches the
  branch in separate transactions with no idempotency key, so a lost
  response is indistinguishable from a foreign database. Attaching after
  create does not survive either: upstream's reconcile detaches a branch its
  props don't declare. So branch stages attach at create and take the
  generated name; production keeps explicit names.
- **The platform's `DATABASE_URL` is left alone.** Prisma Cloud seeds
  `DATABASE_URL`/`DATABASE_URL_POOLED` on every app and marks them
  system-managed; upstream refuses to manage system-managed variables.
  Composer never overwrites, updates, deletes, or tracks them. It does CREATE
  them, once, on a fresh Project: `application.provision` claims both names
  with the placeholder `"-"` via create-only calls (`database-url-claim.ts`),
  because the platform otherwise self-heals a missing `DATABASE_URL` on the
  first compute deploy with a live credential to one of the app's own
  databases. An existing row — platform-seeded or the operator's — makes the
  claim a 409 no-op. The guarantee that apps read
  configuration through the framework is held at the authoring end too:
  `param.ts`/`secret.ts` reject the reserved names, and every
  Composer-written row is `COMPOSER_`-prefixed. An app that reads
  `process.env.DATABASE_URL` directly sees whatever the platform put there.
- **Auth never touches Alchemy's profile store.** Alchemy's own credential
  flow prompts on a TTY and hard-fails non-interactive; Composer runs
  alchemy as a subprocess with piped stdio. Composer provides
  `PrismaEnvironment` directly from `PRISMA_SERVICE_TOKEN`, with one
  base-URL resolver shared between upstream's providers and Composer's own
  SDK client so both always target the same host.
- **A known weakness is inherited:** upstream retries a conflicting App
  delete for only a few seconds, where Composer's own resource waited out
  deployment drain for minutes. Slow drains can fail a destroy and need a
  re-run.

## Alternatives considered

- **Keep Composer's own resources.** Six Management API wrappers whose drift
  Composer pays for alone, with a weaker deploy lifecycle than upstream's.
- **The composite `Prisma.Compute`.** Rejected for the self-edge, the
  environment-ownership map, and ADR-0005 (above).
- **Vendor the provider's source into Composer.** Mechanically possible;
  inherits its dependencies and permanent drift. Kept only as a fallback if
  a future alchemy upgrade proves unshippable.
- **Adopt upstream's built-in dev mode instead of the local target.** Would
  replace a whole-layer seam that already works with per-provider
  substitution, and tie local-dev iteration to an external release cadence.
- **Replace the deployment on every deploy** (the pre-adoption behavior).
  Ships every change by brute force but gives up upstream's reuse entirely;
  superseded by the fingerprint, which detects changes from non-secret
  material only.
- **Hash environment values into the fingerprint.** A hash of a secret in
  plaintext state is an offline-guessing target; rejected. The fingerprint
  hashes only material that is non-secret by construction.

## References

- ADR-0005 (the framework never builds or bundles user code), ADR-0034
  (hosted deploy state), ADR-0039 (a service's origin is a target-resolved
  property), ADR-0041 (local dev runs the deploy pipeline against local
  providers).
- The provider: the `alchemy/Prisma` module of the `alchemy` package,
  2.0.0-beta.67 or later.
- `docs/design/05-prisma-cloud/alchemy-lowering.md` — the current
  resource-by-resource lowering map.
- `docs/guides/deploying.md` — operator-facing upgrade notes (one-time
  deployment reship, branch-database renames, leftover placeholder rows).
