# Slice 1 — Deploy identity has one reader in the prisma-cloud extension

**Linear:** TML-3057 · **Branch:** `tml-3057-deploy-identity-one-reader` (off main `1351243`)
**Design:** `../../design-notes.md` § "Slice 1 — prep" (binding; paths re-verified against main `1351243`)

## Outcome

Inside `packages/1-prisma-cloud/1-extensions/target/`, node descriptors no
longer read `projectId`/`branchId` from `ResolvedCloudOptions`; they read the
narrowed application product. After this slice, `exports/control.ts`'s
`application.provision` is the only consumer of the env-fed ids. Pure
refactor: no user-facing change, no behavior change.

## Scope

**In:** `target/src/descriptors/shared.ts`, `descriptors/postgres.ts`,
`descriptors/compute.ts`, `descriptors/prisma-next.ts`,
`target/src/exports/control.ts`, and their tests.

**Out:** everything else — core, CLI, lowering, examples, docs. No SPI
change, no env-var change, no `ResolvedCloudOptions` field removal (that is
slice 2).

## Exact edits (from design-notes § Slice 1)

1. `descriptors/shared.ts`: `CloudApplication` becomes
   `{ readonly projectId: string; readonly branchId: string | undefined }`;
   `isCloudApplication` accepts the new field (string or undefined); add
   `cloudApplicationOf(application: unknown): CloudApplication` (guard +
   named error, same style as `projectIdOf`); `projectIdOf` delegates to it.
2. `exports/control.ts` `application.provision`: return
   `{ projectId, branchId: o.branchId } satisfies CloudApplication`.
3. Replace every descriptor read of `o.branchId` with
   `cloudApplicationOf(ctx.application).branchId`:
   `postgres.ts:25`, `compute.ts:60,72,73`, `prisma-next.ts:29`.
4. Post-condition check:
   `grep -rn "o\.projectId\|o\.branchId" packages/1-prisma-cloud/1-extensions/target/src/descriptors/`
   returns nothing.
5. Tests updated only where they construct `CloudApplication` values or
   stub the application product.

## Definition of done

- [ ] Post-condition grep (above) clean.
- [ ] Validation gate green (below).
- [ ] No file outside the In-scope list touched.
- [ ] Commits follow repo rules (bot identity; `-s` +
      `--trailer "Signed-off-by: Will Madden <madden@prisma.io>"`).

## Validation gate

From repo root: `pnpm typecheck && pnpm test && pnpm lint && pnpm lint:casts && pnpm lint:deps`

## Dispatch plan

One dispatch (D1) — the whole slice is one coherent outcome; splitting it
would separate the type change from its only consumers.

- **D1** — outcome: the slice outcome above. Builds on: nothing.
  Hands to: slice DoD. Focus: mechanical fidelity to design-notes § Slice 1;
  zero scope creep.
