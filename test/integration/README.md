# @prisma/integration-tests

Cross-package integration tests — see `test/README.md` at the repo root for
the boundary rule this package exists to satisfy.

Depends on every deploy-cli package (the CLI, core, and the extension
packages), unlike `packages/app-cli` itself, which must not depend on any
specific extension.

This package carries its own `prisma-compose.config.ts` (ADR-0017): `prisma-compose
deploy` discovers it by walking up from the fixture entry and evaluates it
with c12, so its static imports of `@prisma/compose-prisma-cloud/control` and
`@prisma/compose/node/control` resolve from THIS package's own dependency tree —
the same ambient resolution an end user's app gets. No special install layout
is needed: the old `dependenciesMeta.*.injected` scaffolding existed only to
serve the node-owned-loads model (dynamic imports resolved from core's own
install location) and was removed with it.
