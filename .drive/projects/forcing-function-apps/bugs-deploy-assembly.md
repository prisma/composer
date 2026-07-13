# Deploy-assembly bugs surfaced by the datahub live deploy (2026-07-13)

> **DESIGN SETTLED — [ADR-0005](../../../docs/design/90-decisions/ADR-0005-users-build-the-framework-assembles.md). Do not relitigate.**
> The contract: the user's build hands the framework a finished **flat** bundle;
> the framework only wraps it in its bootstrap. No path-string arithmetic, no
> filesystem-derived identity, no layout inference, no absolute paths in
> artifacts. Uniqueness comes from the node's graph address. A symlink in a
> bundle is a **hard error** — producing a flat tree is the user's job, and the
> framework never launders trees. The per-bug fixes below are superseded where
> they conflict; the ADR is authoritative.

The first real out-of-repo deploy (`datahub`, `prisma-compose deploy module.ts`
against the team workspace) surfaced three framework bugs in the deploy path.
All three ship in the published `@prisma/compose@0.1.0` /
`@prisma/compose-prisma-cloud@0.1.0`. None are datahub's fault. CI's
"Deploy, verify, destroy" job never caught them because it deploys only
`storefront-auth` — one layout, no cron, and its tree happens not to trip the
packager.

Each bug was hit live, patched locally in datahub's `node_modules`, and the
deploy re-run to surface the next one. Evidence logs: session scratchpad
`deploy2.log`–`deploy6.log`.

## Bug 1 — node assembler hardcodes the bundle filename

`packages/0-framework/2-authoring/node/src/control.ts` (assemble):

```ts
const built = fs.readdirSync(bundleDir).find((f) => /^service\.m?js$/.test(f));
```

tsdown names its output after the **module's basename**. Every example's
service module is `service.ts` → `service.mjs`, so the regex holds — until the
cron scheduler, whose `build.module` is `scheduler-service.mjs` → tsdown emits
`scheduler-service.mjs` → no match → `tsdown produced no service.js`.

**Impact:** any app using `cron()` cannot deploy — including the framework's
own `examples/cron` (never deployed in CI).

**Fix (ADR-0005):** dictate the output name instead of discovering it —
tsdown object entry (`entry: { main: serviceModule }`) emits `main.mjs`
directly; the readdir hunt, regex, and rename all delete. Stage the wrapper in
a deploy-owned dir keyed by the node's graph address
(`.prisma-compose/artifacts/<address>/`) — never inside `node_modules` (the
scheduler's wrapper currently lands in the installed package's `dist/`) and
never in the user's build output. (An earlier basename-arithmetic patch was
verified live but is superseded: no filesystem-derived identity.)

## Bug 2 — nextjs assembler hardcodes the monorepo depth

`packages/0-framework/2-authoring/nextjs/src/control.ts`:

```ts
const workspaceRoot = path.resolve(resolvedApp, '../../../..');  // exactly 4 up
return path.join(resolvedApp, '.next', 'standalone', rel);
```

Next mirrors the app's path **relative to `outputFileTracingRoot`** inside
`.next/standalone/`. The framework guesses that root as exactly four levels
above the app — true for the examples' `examples/<x>/modules/<app>/` layout,
false for datahub's `apps/web/` (two deep). Observed: framework looks for
`.next/standalone/prisma/datahub/apps/web/server.js`; Next actually wrote
`.next/standalone/apps/web/server.js`.

**Impact:** any Next.js app not exactly 4 directories below its tracing root
cannot deploy. That's most real monorepos.

**Fix (ADR-0005):** no inference of any kind. The user supplies the path to
their standalone app dir on the `nextjs()` adapter (relative resolves against
`dirname(module)`, absolute passes through). Keep the "run `next build` with
output: standalone" error when the declared path has no entry. (Discovery via
glob was considered and rejected — inference is the root cause, not the cure.)

## Bug 3 — artifact packager reads symlinks as files

`packages/1-prisma-cloud/0-lowering/lowering/src/compute/artifact.ts`:

```ts
if (entry.isDirectory()) visit(rel);
else out.push(rel);            // a symlink lands here…
…
content: fs.readFileSync(path.join(dir, relPath))   // …EISDIR on dir symlinks
```

`Dirent.isDirectory()` is false for symlinks, so a symlink-to-directory is
treated as a regular file and `readFileSync` throws `EISDIR`. Next standalone
trees are full of them: datahub's has **118**, all relative, bun-store style
(`node_modules/<pkg>` → `.bun/<pkg>@<ver>/node_modules/<pkg>`), targets inside
the walked tree. Module resolution goes **through** those links, so they can't
be skipped; dereferencing would double the artifact (targets are also walked).

**Impact:** any Next.js app (and anything else with symlinked node_modules)
fails at `packageComputeArtifact`.

**Fix (ADR-0005):** flat bundles are the contract; a symlink in a bundle is
a **hard error** at package time, naming the offending path and the fix
("materialize links in your build, e.g. `cp -RL`"). No dereferencing, no
symlink representation, no cycle/containment machinery — producing a flat tree
is the user's build's job. Consequence: datahub's bun-built standalone gains a
flatten step in its own build (datahub PR, not framework).

## Also observed (not framework bugs)

- datahub lacked deploy-time deps (`alchemy`, `effect`, `@effect/platform-bun`,
  `@effect/platform-node`, root `arktype`) — fixed on the datahub PR (`53db4cf`).
- One real resource was created before bug 3 hit: state project
  `proj_cmriwu1se219gyif8egd8qxdo` (empty ledger; reusable or deletable).

## Coverage gap behind all three

Unit tests never assemble or package a real tree. The fixes should land with:
an assemble test for a non-`service.ts` module (cron scheduler shape), a
standalone-layout test at ≠4 depth, and a packager test over a tree containing
relative dir-symlinks.
