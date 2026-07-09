# @makerkit/integration-tests

Cross-package integration tests — see `test/README.md` at the repo root for
the boundary rule this package exists to satisfy.

Depends on every deploy-cli package (the CLI, core, and all target/adapter
packs), unlike `packages/makerkit-cli` itself, which must not depend on any
specific target/adapter pack.
