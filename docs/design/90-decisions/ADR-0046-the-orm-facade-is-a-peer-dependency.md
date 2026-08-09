# ADR-0046: The published packages take the Prisma Next facade as a peer dependency

## Decision

`@prisma/composer-prisma-cloud` declares `@prisma/orm-postgres` — the Prisma Next postgres facade — as a **peer dependency** pinned to one exact version, plus a devDependency at the same version so the workspace can build. It is not a regular dependency.

The application installs the facade itself. Composer's `/prisma-next` and `/auth/pack` entrypoints import it at runtime from whatever copy the application resolved.

Every `@prisma/orm-*` specifier anywhere in this workspace is a single exact version, and all of them name the same version. `scripts/lint-orm-pins.mjs` enforces both halves.

The packages Composer *drives* rather than *extends* stay regular dependencies: `@prisma/orm-toolchain` carries the config loader, the CLI and the migration tools, which Composer's deploy runs on its own behalf.

## Reasoning

Prisma Next publishes one system as several packages (upstream ADR 242): a per-database facade, and the platform shells behind it. Their types and registries are compatible only within one version. Two copies of a shell in one tree means two codec registries, two operation registries, and two class identities — a value produced by one copy is rejected by the other, and `instanceof` stops holding. Nothing detects it; the failure shows up as a type error that names the same type on both sides, or as a runtime rejection of a value that looks correct.

Composer registers an extension pack against the application's copy of the target. `examples/auth/prisma-next.config.ts` is the shape:

```ts
import authPack from '@prisma/composer-prisma-cloud/auth/pack';
export default defineConfig({ /* … */, extensions: [authPack] });
```

The pack is Composer's, the config is the application's, and the descriptor the pack hands over has to be the one the application's facade understands. If Composer took the facade as a regular dependency, an application could upgrade its own facade without upgrading Composer and get two copies — the exact split above, at the seam where it does most damage. As a peer, that combination fails at install instead, which is the outcome worth having.

This is upstream's own rule for extension packs, and what Prisma's in-tree packs do: `@prisma/orm-extension-pgvector` peers on `@prisma/orm-target-postgres` and keeps a devDependency at the same version.

The peer is the facade rather than `@prisma/orm-target-postgres` because Composer reaches facade-only surfaces — `@prisma/orm-postgres/config`, `/runtime`, `/control`, `/contract-builder`. Those modules exist only inside the facade shell; there is no platform equivalent to peer on.

Every `@prisma/orm-*` spec is pinned exactly for the same reason the peer exists. A range on any of them reintroduces the split one package over: `check-publish-deps.mjs` scopes its exact-pin rule to packages this workspace publishes, so the external shells were unchecked until `lint-orm-pins` existed.

## Consequences

- An application that uses Composer's Prisma Next surface installs `@prisma/orm-postgres` itself, at the version Composer names. It already had to, to write `prisma-next.config.ts` and run the CLI.
- An application that uses Composer *without* Prisma Next gets an unmet-peer warning it can ignore, where previously it silently installed the ORM it never used.
- Upgrading Prisma Next is a coordinated release: Composer's pin and the application's install move together. That is the cost of one resolved copy, and it is the point.
- Two Composer entrypoints depend on the peer being present — `/prisma-next` (the typed client and the deploy-time migration path) and `/auth/pack`, whose built `dist/auth/pack.mjs` imports `@prisma/orm-postgres/family-contract/canonicalization-hooks` at runtime to verify the pack descriptor against its own contract. Neither is reachable from the main barrel (invariant 7 keeps the ORM out of it), so a service that does not opt in never loads the facade.
- The bundling boundary is now a name prefix rather than a distinct scope. `@prisma-next/*` used to be visibly not-ours; `@prisma/orm-*` sits in the same npm scope as `@prisma/composer*`, so every `noExternal: [/^@prisma\//]` in a `tsdown.config.ts` had to become `/^@prisma\/(?!orm-)/` to keep the ORM out of deployed service bundles.

## Alternatives considered

**Keep it a regular dependency** (what the manifests said before the 8.0.0-rc.1 upgrade). Simplest to install and what shipped for the whole `@prisma-next/*` era. Rejected: it makes the two-copies failure reachable, and the failure is silent until it is a confusing type error. The exact pin made a mismatch unlikely but not impossible.

**Peer on `@prisma/orm-target-postgres`** — the platform shell, matching upstream's wording literally. Rejected: Composer imports facade-only entrypoints, so peering on the target would leave the facade itself unpinned and the split still reachable.

**Re-export the facade from Composer** so the application never names it. Rejected: it makes Composer the distributor of somebody else's package surface, and the application still has to name the facade in `prisma-next.config.ts` and to run its CLI.

## Related

- [ADR-0022](ADR-0022-data-deps-carry-a-prisma-next-contract.md) — data dependencies carry a Prisma Next contract; this ADR replaces its consequence bullet about how the ORM is installed.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — the control plane loads through the app config.
- Upstream ADR 242 (`prisma/prisma`) — the published shells and the one-facade-per-application rule.
