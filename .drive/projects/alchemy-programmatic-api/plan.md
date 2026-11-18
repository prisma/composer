# Plan: Alchemy in-process

**Spec:** `.drive/projects/alchemy-programmatic-api/spec.md`

Stack: 1 → 2 → 3. Each slice is one PR.

## Slice 1: Alchemy preview and effect 4.1

Move every `alchemy` pin to the preview tarball `https://pkg.alchemy.run/alchemy/972f294ae0c7982a8ebcb551fadd07d29c9c0fca`, and the `effect` set to the 4.1 line, following the `upgrade-alchemy-effect` skill. Fix what breaks between beta.83 and that commit. The subprocess path is unchanged.

- Hands to: a tree where `alchemy/Alchemist` is importable and e2e deploy is green.
- Done when: `pnpm test:packages`, the local-dev integration tests and the e2e deploy workflow pass.

## Slice 2: Deploy in-process

`deploy` lowers the app and calls `Alchemist.plan` / `apply` in the `prisma` process. Alchemy events become engine step events. Ctrl-C interrupts. Credentials per design-notes.md § Credentials. `lower()` takes containers and preflight results as values. New ADR superseding ADR-0007 for deploy; `deploy-cli.md` updated. Destroy and dev still spawn. Rebuild the lowering scratch-stack test harness on `alchemy/Alchemist`, or delete it (slice 1 review S07).

- Builds on: slice 1.
- Hands to: an in-process converge function dev can reuse.
- Done when: e2e deploy workflow passes; `prisma deploy` writes no `alchemy.run.ts`; Ctrl-C manual QA passes.

## Slice 3: Dev in-process

Each `prisma dev` converge runs `plan` / `apply` in-process through slice 2's function. Retires the dev stack file. ADR and `deploy-cli.md` extended to dev.

- Builds on: slice 2.
- Done when: local-dev integration tests pass; `prisma dev` writes no `alchemy.run.ts` and spawns no Alchemy child.

## Close-out

- [ ] Verify the spec's Project DoD.
- [x] Swap the preview URL for the first Alchemy release containing the API: 2.0.0-beta.85, commit 398ed309 on slice 1, merged up. Core-concepts skill sentence updated.
- [ ] Record destroy's migration or deletion in `.drive/deferred.md`.
- [ ] Move the items in this project's `deferred.md` to `.drive/deferred.md` (or Linear) before deleting the project folder.
- [ ] Delete `.drive/projects/alchemy-programmatic-api/`.
