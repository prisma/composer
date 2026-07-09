# test/

Test suites that need to cross package dependency boundaries live here, not
under `packages/`.

Each package under `packages/` must respect its own declared dependencies —
its tests may only exercise what it actually depends on. A test that needs a
different package's real implementation (for example, driving the CLI
against a real target/adapter pack) does not belong in that package's own
test suite; it belongs here instead.

Makerkit has no automated import-boundary check (e.g. dependency-cruiser) —
this file is the boundary rule. See `test/integration/README.md` for what
lives in this specific package.
