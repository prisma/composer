# Project plan — Decouple CLI from Prisma Cloud

## Summary

Two stacked slices. Slice 1 is a behavior-invariant refactor inside the
prisma-cloud extension that consolidates deploy-identity reads to one place;
slice 2 moves the boundary: SPI + CLI orchestration + transport + prisma-cloud
container descriptor + state descriptor + ADR + docs, deleting the
cross-domain exception. The design is fully prescribed in `design-notes.md`;
slice specs add nothing to it beyond dispatch packaging.

**Spec:** `.drive/projects/decouple-cli-from-prisma-cloud/spec.md`

## Slices

### Slice 1 — Deploy identity has one reader in the extension

**Outcome:** inside `packages/1-prisma-cloud/1-extensions/target/`, only
`control.ts`'s `application.provision` consumes `projectId`/`branchId` from
`ResolvedCloudOptions`; node descriptors read them from the narrowed
application product (`CloudApplication` grows `branchId`;
`cloudApplicationOf` added). Pure refactor, no user-facing change, all
checks green. Exact edits: design-notes § "Slice 1 (prep)".

- **Builds on:** nothing.
- **Hands to slice 2:** exactly one env-read site to swap to
  `ctx.container`; descriptors already application-product-driven.
- **Linear:** [TML-3057](https://linear.app/prisma-company/issue/TML-3057)

### Slice 2 — The container boundary moves; the exception is deleted

**Outcome:** the full design of `design-notes.md`: core SPI
(`ContainerDescriptor`/`ContainerInstance`/`StateDescriptor`, hook-input
opacity), transport (`container-transport.ts`), CLI cutover (delete
`ensure-containers.ts`, new step-7 loops, `containerEnv` to the child),
`lower()` threading (`ctx.container`, state injection), prisma-cloud
implementation (`target/src/container.ts`, control/preflight/teardown/state
rewiring), config surface change (`state: prismaState()` — ten call sites),
ADR + doc updates, `crossDomainExceptions` deletion, and deletion of
`.drive/projects/state-under-branch/`. One PR; live deploy → destroy proof
before opening it.

- **Builds on:** slice 1.
- **Hands to close-out:** project DoD fully checkable.
- **Linear:** [TML-3058](https://linear.app/prisma-company/issue/TML-3058)
  (blocked by TML-3057)

## Sequencing

Stack: slice 1 → slice 2. No parallel groups (slice 2 edits the same
extension files slice 1 touches).

## Close-out (required)

- [ ] Verify all acceptance criteria in `spec.md` (project DoD).
- [ ] Final retro.
- [ ] Long-lived docs already land in `docs/` via slice 2's PR (ADR + domain
      docs); verify nothing else needs migration.
- [ ] Strip repo-wide references to `.drive/projects/decouple-cli-from-prisma-cloud/**`.
- [ ] Delete `.drive/projects/decouple-cli-from-prisma-cloud/`.
- [ ] Close-out review open.
