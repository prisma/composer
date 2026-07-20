# Slice spec — `src/exports/` files are thin re-exports; all implementation lives outside

Branch `claude/exports-thin-surfaces`, based on `origin/main` @ `6ec2625`.
Follows the merged exports/entrypoint slice (PR #130, ADR-0035).

## At a glance

ADR-0035 accepted "implementation may live in `src/exports/`, and internal code
may import up into it" as a documented characteristic. That is now rejected:
**`src/exports/*.ts` must contain nothing but re-exports.** All implementation
moves outside `exports/`, and no internal module may import from `exports/`.

## The layout (decided — driven by a hard constraint)

The plane globs have no precedence and must not overlap, and `core`/`cron`/
`streams` collapsed their root internals to `src/*.ts → shared` (PR #130). So
control- and execution-plane implementation **cannot** sit at the package root —
`src/*.ts → shared` would misclassify it, and a per-file override would overlap.

```
src/
  exports/<name>.ts   # thin re-export ONLY, one per published subpath
  <name>.ts           # shared-plane implementation (root; src/*.ts → shared)
  control/**          # control-plane implementation
  execution/**        # execution-plane implementation
```

Non-overlapping by construction. Uses the repo's own plane vocabulary
(ADR-0017/0028) rather than prisma-next's `core/` naming.

**Note:** this is stricter than prisma-next, whose own
`adapter-postgres/src/exports/column-types.ts` is 185 lines of implementation.
Deliberate — the rule is better than the reference.

## Scope — 21 files across 10 packages

Already compliant, do not touch: both published packages (all 21 files),
`rpc`, `assemble`, `core/exports/index.ts`, `cli/exports/index.ts`,
`lowering/exports/{compute,postgres,state}.ts`, `cron/exports/index.ts`,
`storage/exports/{index,testing}.ts`, `streams/exports/index.ts`,
`target/exports/index.ts`.

| Package | exports file (code lines) | implementation moves to |
| --- | --- | --- |
| foundation | `assertions.ts` (6), `casts.ts` (5), `secret.ts` (18) | `src/<name>.ts` (root, shared) |
| core | `deploy.ts` (327), `app-config.ts` (22) | `src/control/<name>.ts` |
| core | `testing.ts` (34) | `src/testing.ts` (root, shared) |
| node | `index.ts` (13) | `src/node.ts` (root, shared) |
| node | `control.ts` (120) | `src/control/build.ts` |
| nextjs | `index.ts` (10) | `src/nextjs.ts` (root, shared) |
| nextjs | `control.ts` (75) | `src/control/build.ts` |
| cli | `render-deployment.ts` (55) | `src/render-deployment.ts` (root; cli is all-control via `src/**`) |
| lowering | `index.ts` (20) | `src/providers.ts` (root; lowering is all-control via `src/**`) |
| target | `control.ts` (130) | `src/control/<name>.ts` |
| target | `pg-connection.ts` (64), `prisma-next.ts` (101), `testing.ts` (21) | `src/<name>.ts` (root, shared) |
| cron | `scheduler-service.ts` (1), `scheduler-entrypoint.ts` (4) | `src/execution/<name>.ts` |
| storage | `storage-service.ts` (12), `storage-entrypoint.ts` (5) | `src/execution/<name>.ts` |
| streams | `streams-service.ts` (11), `streams-entrypoint.ts` (37) | `src/execution/<name>.ts` |
| streams | `testing.ts` (8) | `src/testing.ts` (root, shared) |

## Invariants (same as PR #130 — non-negotiable)

- **Every published subpath KEY unchanged**, for every package.
- Published packages' exports maps, dist file lists, and `composer`'s `bin`
  field byte-identical.
- Multi-pass packages (`cron`/`storage`/`streams`) keep `exports:false`, their
  hand-maintained maps, and their multi-pass configs. Their runtime
  `import.meta.url` sibling resolution targets dist ENTRY filenames — those must
  not change (internal content-hashed chunks may rehash).
- `pnpm lint:deps` green, including main's fail-closed coverage check — every
  moved module must be classified, non-overlapping.
- Gate is the FULL suite; grep ALL of `src/` plus dynamic `await import()`
  string literals for references to moved files.

## Done conditions

- Every `src/exports/*.ts` in the workspace contains only import/re-export
  statements — zero implementation. Verifiable by the same survey that found
  these 21.
- **No module outside `exports/` imports from `exports/`** (this kills the
  "internal code imports up" characteristic). Verify with a repo-wide grep.
- ADR-0035 amended: the accepted-characteristic passage is replaced with the
  strict rule; `.agents/rules/exports-entrypoints.mdc` updated to match.
- The previous slice's Drive record (`.drive/projects/exports-entrypoint/`) is
  committed in this PR — it rides along with code, so it isn't a docs-only PR.

## Dispatch plan

- **T1** — foundation + core (the heavy one: `deploy.ts` 327 lines; introduces
  `src/control/` and its glob).
- **T2** — node + nextjs + cli + lowering.
- **T3** — target (mixed-plane, 4 files, per-file globs).
- **T4** — cron + storage + streams (multi-pass; introduces `src/execution/`;
  dist ENTRY filenames must not change).
- **T5** — ADR-0035 amendment + rule update + commit the prior Drive record +
  full verification, then PR.
