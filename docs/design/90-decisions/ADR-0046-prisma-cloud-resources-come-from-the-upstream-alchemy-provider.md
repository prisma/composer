# ADR-0046: Prisma Cloud resources come from the upstream Alchemy provider

## Decision

Composer does not implement Alchemy resources for Prisma Cloud's Management
API. The six resource families that talk to it — project, database,
connection, app, deployment, environment variable — are the upstream
`alchemy/Prisma` provider's classes (`Prisma.Project`, `Prisma.Database`,
`Prisma.Connection`, `Prisma.App`, `Prisma.Deployment`,
`Prisma.EnvironmentVariable`), registered in Composer's own provider
collection and driven by Composer's lowering.

Composer keeps defining resources only where no Management API exists behind
them: mint-once values (`ServiceKey`, `GeneratedParam`, `S3Credentials`),
`PnMigration`, `PgWarm`, and — until the upstream contribution ships in a
release — `Bucket`/`BucketKey`. The hosted state store keeps its policy layer
(state lives in a framework-owned database on the stage's Branch, ADR-0034);
its generic Postgres core is contributed upstream.

The compute family binds the **low-level** trio, not the composite
`Prisma.Compute`:

- A service's `COMPOSER_<ADDRESS>_ORIGIN` row carries that service's own
  platform-assigned domain (ADR-0039). One composite resource owning app,
  environment rows, and deployment makes that row an input of the resource
  that produces the domain — a self-edge the planner rejects. Splitting lets
  the App surface `appEndpointDomain` in `provision`, before any row is
  written.
- `Compute` owns environment rows through an internal ownership map with no
  honest migration from per-key resource rows.
- `Compute` carries build, framework detection, and bundling. `artifactPath`
  bypasses them, but the bypass is a prop value; `Prisma.Deployment` has no
  build path at all, which is the structural form of ADR-0005's guarantee.

The env→deployment ordering edge rides the deployment's `app` prop as an
Output over every environment row's id (`deployment-edge.ts`). It must not
ride `artifactPath`: upstream's diff requires that prop to be *resolved*
before comparing artifacts, and a brand-new environment row is unresolved at
plan time — the diff then degrades to a generic update that reuses the running
deployment while recording the new artifact's fingerprint, permanently and
silently skipping a code deploy.

Local dev is unchanged in shape (ADR-0041): the local target rebinds the same
upstream resource classes to Composer's emulator providers at the
`LowerOptions.providers` seam. Upstream's own dev mode (`providers({ dev })`,
which Composer contributed) is not used, because Composer swaps the whole
layer rather than one provider's dev half.

## Consequences

- Composer's collection tag is `'PrismaComposer'` and its remaining resource
  type-ids are `PrismaComposer.*` — the `Prisma.*` namespace belongs to
  upstream. Rows written before the adoption migrate on read in the hosted
  store (`state/legacy-resources.ts`): type-ids, attribute shapes, and the
  neutralization of the retired poison rows.
- Branch-stage databases carry generated physical names. Upstream refuses an
  explicit name combined with branch attachment in create (correct: PDP
  creates and attaches in separate transactions with no idempotency key), and
  attach-after-create is reverted by upstream's reconcile. Production keeps
  explicit names; branch stages attach at create and take the generated name.
- The platform's seeded `DATABASE_URL`/`DATABASE_URL_POOLED` are no longer
  overwritten. They are system-managed and upstream refuses to manage them.
  The authoring-side ban remains: `param.ts`/`secret.ts` reject the names, and
  every Composer row is `COMPOSER_`-prefixed. An app reading
  `process.env.DATABASE_URL` outside the framework sees the platform's value.
- Auth never touches Alchemy's profile store: Composer provides
  `PrismaEnvironment` directly from `PRISMA_SERVICE_TOKEN`, with one base-URL
  resolver shared by the upstream providers and Composer's own SDK client.
- Two regressions are accepted and filed as upstream asks: an environment
  value change alone no longer replaces the running deployment (the only
  non-secret change signal upstream exposes, `updatedAt`, moves on every
  deploy, so no mechanism at this layer can express "the value changed"), and
  the App delete conflict-retry budget is ~3.75 s where Composer's old
  provider waited up to 5 minutes.

## Alternatives considered

- **Keep Composer's own resources.** Rejected: six API wrappers whose drift
  against the Management API Composer pays for alone, with a less hardened
  deploy lifecycle than upstream's (no failure cleanup, no terminal-status
  fast-fail, promote-response trust instead of post-promote observation).
- **Composite `Prisma.Compute`.** Rejected for the self-edge, the ownership
  map, and ADR-0005 (above).
- **Vendor `src/Prisma/` into Composer.** Works mechanically, inherits
  `@prisma/dev` and permanent drift. Kept only as a fallback if a future
  alchemy bump is unshippable.
- **Upstream's dev mode instead of the local target.** Would tie local dev's
  iteration to upstream review cadence and replace a whole-layer seam that
  already works with a per-provider one.

## References

Upstream provider: alchemy-run/alchemy PR #416; Composer's contribution
(buckets, `providers({dev})`/`liveProviders()`, Postgres state backend):
PR #1061. Supersedes the resource inventory in ADR-0033's reading of
`alchemy-lowering.md`; ADR-0005, ADR-0034, ADR-0039, ADR-0041 unchanged.
