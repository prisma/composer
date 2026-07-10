# @prisma/integration-tests

Cross-package integration tests — see `test/README.md` at the repo root for
the boundary rule this package exists to satisfy.

Depends on every deploy-cli package (the CLI, core, and all target/adapter
packs), unlike `packages/app-cli` itself, which must not depend on any
specific target/adapter pack.

`package.json`'s `dependenciesMeta.*.injected` on `@prisma/app`,
`@prisma/app-node`, `@prisma/app-nextjs`, `@prisma/app-cloud`, and
`@prisma/alchemy`: node-owned loads (`ServiceNode`/`ResourceNode`'s
`loadTarget()`/`loadAssembler()`, `@prisma/app`'s node.ts) do a plain
`import()` from wherever core's OWN file physically lives. Under a plain
`workspace:*` symlink, that's `packages/app` in this repo's source
tree — outside `node_modules` entirely, so there's no ancestor `node_modules`
for the walk-up to find sibling packs in. `injected: true` makes pnpm place a
real, non-symlinked copy of each of these packages directly inside this
package's own `node_modules`, alongside each other — matching what a real end
user's install looks like, where the app's own `node_modules` always ends up
an ancestor of an installed package's real location. `@prisma/app-cli` stays a
plain symlink: it never does a node-owned dynamic import itself, and its own
`@prisma/app-assemble`/`@prisma/app` imports already resolve fine from its
real, un-injected location.
