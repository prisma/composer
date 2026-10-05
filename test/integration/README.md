# @prisma/integration-tests

Cross-package integration tests — see `test/README.md` at the repo root for
the boundary rule this package exists to satisfy.

Depends on every deploy-cli package (the CLI, core, and the extension
packages), unlike `packages/app-cli` itself, which must not depend on any
specific extension.

This package carries its own `prisma.config.ts` with a `composer` section
(ADR-0017): `prisma deploy` run from this directory loads it through
the CLI engine, so its static imports of `@prisma/composer-prisma-cloud/control` and
`@prisma/composer/node/control` resolve from THIS package's own dependency tree —
the same ambient resolution an end user's app gets. No special install layout
is needed: the old `dependenciesMeta.*.injected` scaffolding existed only to
serve the node-owned-loads model (dynamic imports resolved from core's own
install location) and was removed with it.
