# Purpose

Make deploy-state lifetime equal the lifetime of the environment it describes,
so that every teardown path — CLI destroy, Console branch/project deletion,
and (in the successor project) GitHub-webhook branch deletion — cleans up
state correctly **without the platform knowing Composer exists**. This removes
the one place where Composer state can outlive or orphan the thing it
describes, and it is the prerequisite that shrinks the future GitHub App
integration's sandbox credential from workspace-scoped to project-scoped.

# At a glance

Alchemy state moves from the workspace-level `prisma-composer-state` Project
(ADR-0009) into a framework-owned database named `prisma-composer-state`
attached to each stage's own Branch; production's attaches to the Project's
implicit default Branch. The CLI's destroy tail gains one explicit step —
delete the state database after `alchemy destroy`, before deleting the
Branch/Project. Everything else in the store (schema, lock, connection
minting, ownership verification) is retained.

The full, binding design is in [design-notes.md](design-notes.md); it is
implementation-grade and the slices execute it without reinterpretation.

# Non-goals

- **The GitHub App / webhook integration.** Recorded as the successor project
  in [plan.md](plan.md) § Successor project; nothing here depends on it.
- **A platform-side state API** (ADR-0009's declared end state). This project
  proves the Branch-scoped shape the eventual API should inherit; it does not
  build the API. Likewise no delegation of state-DB deletion to the
  Management API's branch delete — noted as a future platform ask.
- **Automated migration from the workspace store.** Manual cutover only
  (design-notes § Legacy workspace store).
- **Any change to resource lowering.** Production resources keep omitting
  `branchId`; the platform's implicit default Branch receives them. Only the
  state layer changes.
- **A platform "protected/framework-owned database" flag.** Filed as a
  platform ask, not built.

# Place in the larger world

Supersedes ADR-0009; leaves ADR-0010 (lock), ADR-0011 (targets supply the
state layer), and ADR-0012 (store speaks SQL) standing with consequence notes
only. Corrects ADR-0024's description of where production resources
physically live (platform's implicit default Branch). Direct successor:
**Compute GitHub App integration** (see plan), which consumes this project's
containment guarantee for webhook-driven teardown and credential scoping.

# Cross-cutting requirements

- **No guessing (ADR-0005 discipline applied to state):** the state database
  is found by branch-scoped listing + exact name + ownership-marker
  verification; it is deleted only after the same verification; the default
  Branch is resolved by `isDefault: true`, never inferred; no region literal
  is hard-coded (`region: 'inherit'`).
- **Retry convergence:** every crash window in deploy bootstrap and in the
  destroy tail must converge on command re-run (documented per-window in
  design-notes § Destroy ordering).
- **Output wording:** state bootstrap/teardown log lines follow the existing
  "provisioned"/"using"/"removed" vocabulary. (An earlier draft justified this
  with an end-to-end noop assertion that greps deploy output for bare
  create/update verbs. That assertion was deleted along with the
  `makerkit-hello` example and no longer exists anywhere in the repo — the
  vocabulary stays because it reads well and matches the surrounding code, not
  because a check enforces it.)

# Project-DoD

- [ ] ADR-0034 merged; ADR-0009 marked superseded; consequence/correction
      notes landed on ADR-0010 and ADR-0024; deploying guide carries the
      upgrade cutover note.
- [ ] A named-stage deploy → destroy round-trip against a real workspace
      leaves the workspace with **zero** residue: no state project, no state
      database, no Branch, and (when it was the only stage) no Project.
- [ ] A production deploy places state on the implicit default Branch
      (verified via the Management API), and `destroy --production` removes
      the state database before the best-effort project delete.
- [ ] Deleting a stage's Branch from Console while nothing is in flight, then
      re-deploying the same stage name, produces a working stage from fresh
      state (the orphan-state scenario ADR-0009 could not handle).
- [ ] The workspace-level `prisma-composer-state` project is no longer
      created by any code path.

# Open questions

Tracked in design-notes § Open questions: OQ-1 (per-stage DB quota/billing —
non-blocking), OQ-2 (project-delete dependency contract — blocking only for
the production-destroy leg of S2 sign-off). Both are asks on the PDP team,
owned by the operator.

# References

[design-notes.md](design-notes.md) · [plan.md](plan.md) · tracker:
[Prisma Composer: State Under Branch](https://linear.app/prisma-company/project/prisma-composer-state-under-branch-5754597a6981)
