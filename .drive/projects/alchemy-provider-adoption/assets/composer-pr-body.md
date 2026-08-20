Composer's six hand-written Alchemy resources for Prisma Cloud are gone. Deploys and local dev now run on the official `alchemy/Prisma` provider (alchemy 2.0.0-beta.67):

```ts
// lowering/src/providers.ts — the whole live wiring is now composition, not implementation
Layer.mergeAll(
  Prisma.ProjectProvider(),
  Prisma.DatabaseProvider(),
  Prisma.ConnectionProvider(),
  Prisma.AppProvider(),
  Prisma.DeploymentProvider(),
  Prisma.EnvironmentVariableProvider(),
  // still ours until upstream PR alchemy-run/alchemy#1061 releases:
  BucketProvider(), BucketKeyProvider(),
)
```

Why: upstream tracks the Management API so we don't, and its deploy lifecycle is better than ours was — cleanup of failed deployments, terminal-status fast-fail, post-promote endpoint observation. Decision record: ADR-0048.

## What changed

- **Foundation** — alchemy beta.59 → beta.67 (plus the forced effect beta.100 train). Our provider collection tag and remaining resource type-ids renamed to `PrismaComposer.*`; the old ids are aliases so existing state rows resolve.
- **Postgres family** — upstream `Project`/`Database`/`Connection` classes, driven by our own auth layer (`PrismaEnvironment` from `PRISMA_SERVICE_TOKEN`, no interactive profile store; one base-URL resolver shared with our SDK client). Branch stages create their database attached with a generated physical name (upstream correctly refuses explicit-name-plus-branch; verified against PDP source). `directConnectionString` is bound explicitly — upstream's `databaseUrl` is pooled-first.
- **Compute family** — upstream's low-level `App`/`Deployment`/`EnvironmentVariable`, not composite `Compute`: the `COMPOSER_*_ORIGIN` self-edge needs the App to exist before env rows, and `Deployment` has no build path at all (ADR-0005 by structure). The env→deployment ordering edge rides the deployment's `app` prop as an Output (`deployment-edge.ts`) — riding `artifactPath` would silently skip code deploys when a new env row lands in the same deploy (proven with tests against alchemy's real Output machinery, and re-proven live).
- **A deployment is replaced exactly when its environment changes** (`compute/deploy-fingerprint.ts`) — the artifact hard-link directory is named from a hash of the service's environment material, so upstream reuses the deployment when nothing changed and replaces it when the env or artifact did. The hashed material is non-secret by construction (ADR-0042 rows carry literals and pointers, never values); out-of-band rotation of a pointed platform variable is detected via its `updatedAt` metadata, read at preflight and carried across the CLI→Alchemy process boundary on a new preflight-transport channel. Swaps onto upstream's `Deployment.redeployOn` (in #1061) at a marked seam when it releases.
- **Legacy state migrates on read** (`state/legacy-resources.ts`) — old type-ids and attribute shapes rewrite in the hosted store; the retired poison `DATABASE_URL` rows are reported `retained` (state row dropped, platform variable untouched). Fresh projects get the poison back by a different route: `application.provision` claims `DATABASE_URL`/`DATABASE_URL_POOLED` with `"-"` via create-only writes (never tracked as resources, never modified or deleted), because the platform otherwise self-heals a missing `DATABASE_URL` on first deploy with a live credential to one of the app's own databases. Existing rows — platform-seeded or ours — 409 and no-op. The authoring-side name ban remains.
- **Local dev unchanged in shape** — the local target binds upstream's resource classes to our emulators at the same seam (ADR-0041).

## Verified

- Full suites green at every commit (build 36/36, typecheck 74/74, tests 62/63 with the one known dev-emulators flake; cast delta −8).
- Deployed smoke against real Prisma Cloud: fresh deploy + 2/2 smoke, idempotent redeploy (zero churn), the code-plus-new-var scenario that motivated the edge design (deployment replaced, new code live), clean destroy.
- A genuinely legacy stage (deployed from this PR's merge-base, redeployed from this branch): adopted in place — same database id, app ids, URLs — one-time deployment reship, then steady state byte-identical to a fresh stack. Clean destroy.

## Operator notes (also in docs/guides/deploying.md)

- First deploy after upgrading replaces each service's deployment once.
- Branch-stage databases migrate to generated physical names; the database's *default* connection credentials rotate once (the app's own connection is unaffected).
- The `"-"` placeholder in `DATABASE_URL`/`DATABASE_URL_POOLED` is deliberate and self-restoring; deleting it by hand is not useful (the next deploy's claim or the platform's template filler recreates the row). A user-set value wins over both — the guide has the details.

## Follow-up (tracked in TML-3156)

When upstream PR alchemy-run/alchemy#1061 merges and releases: bump alchemy, delete our bucket resources (upstream now ships them with capability bindings), drop the alchemy pnpm patch, and move the deploy fingerprint onto `Deployment.redeployOn` at the marked seam.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

