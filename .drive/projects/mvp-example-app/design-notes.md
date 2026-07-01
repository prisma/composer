# Design notes — MVP example app

Project-level design record. The canonical model lives in
[`docs/design/`](../../../docs/design/); this file records only the decisions
specific to standing up the deployable MVP.

## Principles inherited

From [`docs/design/01-principles/`](../../../docs/design/01-principles/): don't
reinvent the wheel (build on Alchemy), no globals (inject typed config), code is
the source of truth, everything reproducible in a fresh environment.

## The model this exercises

Two **Hexes** (Storefront, Auth), each a **Service** (its code) plus a **Resource**
(its own Postgres). No shared data. See
[`docs/design/03-domain-model/`](../../../docs/design/03-domain-model/) for
Service/Resource/Configuration and the layering that this project instantiates
against real Prisma Cloud primitives.

## Key decisions

- **Own v2/Effect Alchemy providers, not the v1 ones.** Prisma ships a v1 (async)
  Postgres provider; our design is built on Alchemy v2 (Effect). We wrote our own
  v2 Postgres provider (Project/Database/Connection) and will write the Compute
  provider the same way. Rationale in the session; the v1 path was rejected.
- **Wrap the official SDK.** Providers call `@prisma/management-api-sdk`
  (`createManagementApiClient({ token })`) rather than hand-rolling REST/OAuth.
  Auth is a `PRISMA_SERVICE_TOKEN` resolved from env via a `PrismaCredentials`
  service (no full `alchemy login` flow for the MVP).
- **Compute has no upstream Alchemy provider — we build one.** Confirmed via the
  SDK types and ignite. The lifecycle is: create deployment (returns
  `foundryVersionId` + `uploadUrl`) → PUT the tar.gz to `uploadUrl` → start the
  version → promote the service. `skipCodeUpload` reuses an existing build.
- **The Compute provider consumes a *prebuilt* artifact.** It takes a path to the
  tar.gz + the `{ manifestVersion, entrypoint }` manifest as input. This decouples
  the provider's control flow from *how* the bundle is produced, so bundling can be
  solved separately at the app build-step slice.
- **One Postgres per Hex.** Simplest correct thing; sidesteps aggregate contracts,
  which are out of scope for the MVP.

## Alternatives considered

- **Deploy Compute via the Prisma CLI (`prisma compute deploy`) and use Alchemy
  only for Postgres.** Faster to a first deploy, but leaves half the system outside
  Alchemy and doesn't surface the seam MakerKit must close. Rejected in favour of
  an all-Alchemy path (operator's call).
- **Use the v1 Postgres provider.** Rejected — see above.

## Open questions

- Next.js → Compute artifact bundling (operator has prior art).
- Direct vs pooled connection string from the Connection resource (currently using
  the connection's top-level `url`).
- Whether the Compute service+deployment is one resource or two.

## References

- [`spec.md`](./spec.md)
- [`packages/prisma-alchemy`](../../../packages/prisma-alchemy) — commit `64e530f`.
- `ignite/docs/portal/technology/prisma-compute/architecture.md`.
