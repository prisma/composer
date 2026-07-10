# Design notes — package publishing

The prisma-next pipeline is well-understood (source read directly). These notes
capture the decisions where makerkit differs from prisma-next and cannot copy
verbatim.

## The prisma-next pipeline, in one paragraph

Root `package.json` `version` is the source of truth. `set-version.ts` walks
every workspace `package.json` and stamps that version, rewriting internal
`workspace:*` deps to `workspace:<version>` (pnpm turns that into an exact
`X.Y.Z` pin at publish). `bump-minor.ts` reads the root version at HEAD and
computes the next minor. On CI, `determine-version.ts` decides: root version
changed since the previous push → publish `<base>` under `latest` + cut a GitHub
Release; unchanged → publish `<base>-dev.N` under `dev`. `publish-packages.mjs`
fans `pnpm publish` across 8 workers, treating "already published" as a no-op so
re-runs are idempotent. `check-publish-deps.mjs` packs every tarball and fails if
a `workspace:`/`catalog:` specifier or a non-exact internal pin would ship.
`preview-publish.yml` pushes per-PR previews to `pkg.pr.new`. Auth is npm OIDC
trusted publishing — no stored token — with provenance attestations.

## Decision 1 — Build model: follow prisma-next exactly (build-always, exports → dist)

**Operator directive (settled):** match prisma-next's packaging/bundling exactly.
No `publishConfig.exports` override, no divergence.

**What this means.** Each publishable package builds with tsdown to `dist/`
(`.mjs` + `.d.mts`), and its `exports` / `types` point at `./dist` in **every**
context — dev, test, and publish alike — exactly as prisma-next does. `files`
lists `["dist", "src"]`. There is no source-vs-published exports split.

**Consequence for makerkit's dev/test loop (the real cost).** Today makerkit has
no build: `exports` → `./src/*.ts`, tests run via `bun test` straight off
TypeScript, and examples import the framework as source. Flipping `exports` to
`dist` means **anything crossing a package boundary now needs `dist` built
first** — the same constraint prisma-next lives with. Concretely, mirror
prisma-next's structure:

- **Dev:** a `dev` script running `turbo watch build` so `dist` stays current as
  source changes (prisma-next: `turbo watch build --filter='./packages/**'`).
- **CI/local test:** build packages before running tests that cross package
  boundaries (prisma-next's `test:packages` = `turbo run build … && vitest run`).
  Within-package tests still import relative `./src` files directly.

**Test runner boundary (explicit, correctable).** "Packaging/bundling exactly"
covers the tsdown build, the `exports`→`dist` model, `files`, `publishConfig`,
and workspace-dep pinning — all adopted verbatim. It does **not** by itself mean
swapping makerkit's `bun test` for prisma-next's vitest; that's a separate
runner choice. Plan keeps `bun test` and adds the build-first step so
cross-package imports resolve to `dist`. If the operator also wants vitest
parity, that's a follow-on decision — flagged here so the boundary is visible
rather than silently drawn.

## Decision 2 — Identifying "our" packages without a clean scope prefix

prisma-next filters internal packages by the `@prisma-next/` prefix in
`set-version-utils.ts` (workspace-dep rewrite) and `check-publish-deps.mjs`
(exact-pin rule). makerkit has **no single prefix**: packages are `@prisma/app`,
`@prisma/app-nextjs`, …, and `@prisma/alchemy`, and the `@prisma/` scope is
**shared with external Prisma ORM packages** (`@prisma/client`, `@prisma/engines`)
that must NOT be treated as internal.

**Decision.** Identify the internal set by workspace membership, not by name
prefix:

- **Workspace-dep rewrite** (`set-version-utils`): the existing guard already
  requires `spec.startsWith('workspace:')`. Drop the `@prisma/` name-prefix
  filter and rewrite any `workspace:` spec. External `@prisma/*` deps use real
  version ranges, never `workspace:`, so they are untouched. This is safe and
  simpler than a prefix.
- **Exact-pin check** (`check-publish-deps`): compute the set of workspace
  package names dynamically (from `pnpm list -r --json` /
  `list-publishable-packages.mjs`) and apply the exact-pin rule only to deps whose
  name is in that set. Do **not** apply it to `@prisma/`-prefixed names, or it
  would wrongly demand exact pins on `@prisma/client`.

## Decision 3 — `PACKAGE_NAME` for dev-build numbering

`determine-version.ts` queries `npm view <PACKAGE_NAME> dist-tags.dev` to compute
the next `-dev.N`. prisma-next defaults it to `@prisma-next/contract`. Set
makerkit's default to `@prisma/app` (the anchor package). The value only affects
dev build-number sequencing.

## Decision 4 — Which packages publish vs stay private

Publishable (remove `private`, add publish manifest) — **9**: `@prisma/app`,
`@prisma/app-nextjs`, `@prisma/app-node`, `@prisma/app-cloud`, `@prisma/app-rpc`,
`@prisma/app-assemble`, `@prisma/app-cli`, `@prisma/alchemy`, and the unscoped
`prisma-app` launcher (Decision 7).

Stays private (versions in lockstep, `private: true`, never published): the new
shared tsdown-config package, and all `test/**` / example / fixture packages.
`list-publishable-packages.mjs` and `publish-packages.mjs` both skip
`private: true`, so lockstep-but-private is the correct shape for these.

## Decision 5 — Test runner for the new scripts

The version/publish helper scripts are ported as-is and are pure Node. Keep their
tests on `node --test` (as prisma-next does), wired into a root `test:scripts`
script, independent of makerkit's `bun test` package tests. `pathe` and `tsx`
(or node's native TS) are needed to run the `.ts` scripts — mirror prisma-next's
devDeps.

## Decision 6 — mise vs `.tool-versions`

prisma-next's workflows use `jdx/mise-action`; makerkit pins tools via
`.tool-versions` (`node 24.16.0`, `bun 1.3.13`). mise reads `.tool-versions`
natively, so adopt `mise-action` in the new workflows and keep `.tool-versions`
as the pin file — no `mise.toml` needed. Existing makerkit CI uses its own Node
setup; leave it, only the new publish/preview workflows use mise.

## Decision 7 — CLI packaging and bun consumers

**One build serves node and bun.** Bun consumes ordinary npm packages through
`exports` / `bin`; a single ESM `dist` (`.mjs` + `.d.mts`) runs identically under
node ≥ engines-floor and under bun. No separate bun target, and **no `"bun"`
export condition** — grep confirms no shipped source calls `Bun.*` or imports
`bun` / `bun:` at runtime. The only bun references in shipped source are in
`makerkit-assemble/src/wrapper-inline.ts`: a comment and a regex that keeps
`bun:*` specifiers external (so bun users *can* reach `bun:sqlite`, but we never
force it). `@types/bun` and `bun test` are dev-only and never ship.

**The one real fix: stop shipping raw `.ts` as the bin.** Today
`@prisma/app-cli` sets `bin: { makerkit: "./src/bin.ts" }` with a
`#!/usr/bin/env node` shebang, relying on the consumer's node doing TS
type-stripping (works only on node ≥22.18 with stripping enabled, and drags
`src/*.ts` into the runtime path). Build the CLI to `dist/bin.mjs` (plain JS,
tsdown emits the shebang) and point `publishConfig.bin` at it. Then the installed
command runs under any node ≥ the engines floor and under bun with no
type-stripping dependency.

**How bun users invoke the CLI** (once published):

- `bunx @prisma/app-cli <args>` — one-shot, no install (bun's npx). The common path.
- `bun add -g @prisma/app-cli` → `makerkit <args>` on PATH. The installed shim
  runs via the `#!/usr/bin/env node` shebang, so it executes under **node** —
  the safe cross-runtime default.
- Project-local: `bun add -d @prisma/app-cli`, then `bunx makerkit` or a script.
- To force execution *by bun* (e.g. to pick up `bun:sqlite`): the user runs the
  entry through bun directly (`bun run $(bun pm bin)/makerkit`). We don't need a
  bun shebang for this; keeping the node shebang maximizes portability.

**Command name (settled): `prisma-app`.** The published bin key is `prisma-app`
(replacing `makerkit`).

**Two CLI packages, exactly like prisma-next.** prisma-next ships the CLI as
both `@prisma-next/cli` (scoped, library + bin) and an **unscoped `prisma-next`**
launcher (bin-only, `files: ["dist"]`, no library exports) — both with
`bin: { "prisma-next": "./dist/cli.js" }`. The unscoped package is what makes
`bunx prisma-next` work (rather than `bunx @prisma-next/cli`): `bunx <name>`
resolves `<name>` to a package and runs its bin, so the ergonomic command must be
a package name. Mirror this exactly:

- `@prisma/app-cli` — scoped, library + bin, `bin: { "prisma-app": "./dist/bin.mjs" }`.
  Internal packages depend on this one.
- **`prisma-app`** — new unscoped, bin-only launcher, same bin entry. This is the
  `bunx prisma-app` target. Unscoped name is a free E404 on npm; claim it.

**Why not `bunx @prisma/app`.** That would require giving the core library
package `@prisma/app` its own `bin`, merging the CLI into the library so every
consumer who only `import`s `@prisma/app` also installs clipanion + the
loader/assemble runtime. prisma-next deliberately keeps library and CLI separate;
`@prisma/app` stays a pure library. The clean, prisma-next-exact short command is
`bunx prisma-app`, not `bunx @prisma/app`.

**Bun invocation (settled):** `bunx prisma-app <args>` (one-shot), or
`bun add -g prisma-app && prisma-app <args>`. `bunx @prisma/app-cli` also works.

## External prerequisites (owned outside this project)

1. **npm trusted publishing.** A Prisma npm admin must enable OIDC trusted
   publishing for the 8 scoped `@prisma/*` names **and** the unscoped `prisma-app`
   launcher, pointing at `prisma/makerkit` + the `Publish to npm` workflow. Claim
   the unscoped `prisma-app` name first (currently a free E404). Without this,
   real publish 403s. Everything up to and including dry-run works without it.
2. **Repo visibility.** npm provenance rejects private repos and `prisma/makerkit`
   is private. Either make the repo public before first release (enables
   provenance) or ship first releases with `NPM_CONFIG_PROVENANCE` unset and turn
   it on later.

## Alternatives considered

- **Changesets.** prisma-next does not use changesets (root-version-as-trigger
  instead); adopting changesets would not be "the same setup." Rejected.
- **`npm publish` instead of `pnpm publish`.** `npm publish` does not rewrite
  `workspace:`/`catalog:` — the exact failure `check-publish-deps` guards against.
  Use `pnpm publish`, as prisma-next does.

## References

- Spec: `.drive/projects/package-publishing/spec.md`
- Plan: `.drive/projects/package-publishing/plan.md`
