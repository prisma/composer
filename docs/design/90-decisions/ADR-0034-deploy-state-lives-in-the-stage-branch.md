# ADR-0034: Deploy state lives in a framework-owned database in the stage's Branch

## Decision

Each stage's deploy state — the provisioning engine's record of what exists in
the cloud — lives in a small framework-owned Prisma Postgres database named
`prisma-composer-state`, attached to that stage's **Branch** inside the app's
own Project. Production's state database attaches to the Project's **implicit
default Branch**. This supersedes
[ADR-0009](ADR-0009-deploy-state-is-hosted-in-the-workspace.md)'s
workspace-level store; everything else ADR-0009 decided — hosted state,
automatic bootstrap, mint-per-run connections, ownership verification —
carries over unchanged.

```
Workspace
└── Project "storefront-auth"                  ← the app (ADR-0023)
    ├── Branch "main" (implicit default)       ← production
    │   ├── App "auth" · App "storefront" · Database "database"
    │   └── Database "prisma-composer-state"   ← production's deploy state
    └── Branch "pr-42"                         ← a preview stage
        ├── App "auth" · App "storefront" · Database "database"
        └── Database "prisma-composer-state"   ← pr-42's deploy state
```

State now has exactly the lifetime of the environment it describes. Delete a
Branch — from the CLI, from the Console, or from any future git integration —
and the stage's state goes with it, because it is an ordinary child of the
Branch. Delete the Project and everything goes. The platform needs no
knowledge of the framework for any of this to be true.

## Reasoning

ADR-0009 put state in a dedicated workspace-level project because the app's
own project looked circular — "created and destroyed *by* the deploys whose
state it would hold." That was true when the state engine managed the project.
It stopped being true with
[ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md)/[ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md):
the CLI now creates the Project and Branch via the Management API *before*
Alchemy runs, and deletes them *after* destroy, entirely outside state. A
state database bootstrapped in that same container-ensure phase is not a
circular dependency — it is container-scoped infrastructure, provisioned and
removed on the same side of the state boundary as the containers themselves.

Two platform facts make the placement precise. Every resource belongs to a
Branch: a create call without a `branchId` is resolved by the platform to the
Project's default Branch, and every live Project owns one. So "production
lives at the Project level" (ADR-0024) is an addressing statement, not a
physical one — production's resources, and now its state database, sit on the
implicit default Branch. And a Branch's children are enumerable and deletable
by the platform without reading any of them: which is what makes containment
work. When a Branch is torn down from the platform side, the state database
is deleted like any other database — no special case, no framework hook, no
orphaned rows waiting for a same-named stage to reappear.

The workspace store could not offer that. Platform-side Branch deletion left
the stage's rows stranded in a store the platform doesn't know about, and any
teardown driven from outside the CLI was wrong by default. Under containment,
every teardown path is right by construction, and they obey two deliberate,
opposite ordering rules:

- **The CLI deletes state last.** `destroy` reads state to know what to
  remove, so the state database must outlive every resource the destroy
  removes; and the platform refuses to delete a Branch that still has live
  members, so the state database is removed after the resources and before
  the Branch. Every crash window between those steps converges on re-running
  the destroy: an already-empty or absent store makes the remaining steps
  no-ops.
- **The platform deletes state in any order it likes.** Its teardown
  enumerates children and never reads state. Deleting the state database
  early is even a feature: it severs the session that holds the deploy lock
  ([ADR-0010](ADR-0010-deploys-hold-a-session-advisory-lock.md)), so an
  in-flight deploy of a stage being torn down fails its lease check within
  seconds instead of provisioning into a deleted container.

Discovery keeps ADR-0009's no-guessing discipline, relocated. The database is
found by listing the Branch's databases and matching the well-known name; a
name match alone proves nothing (names are not unique), so adoption requires
the ownership marker, exactly as before. The default Branch is resolved by
its `isDefault` flag — never inferred, and never created: its absence is a
platform-invariant violation reported as an error. Deletion is
ownership-verified too; the framework never deletes a database it cannot
prove is its own.

ADR-0009's second objection — per-app stores fragment workspace-level
questions — has a cleaner answer than a workspace store: those questions
belong to the platform. "Which apps exist" is listing Projects; "what is
provisioned in this stage" is listing a Branch's children. Bootstrap, far
from needing one place to look, gets simpler: the CLI already threads the
resolved Project and Branch ids to the deploy, so the store is addressed
directly instead of discovered by scanning same-named candidate projects
across the workspace.

## Consequences

- **Zero-residue teardown.** Destroying a stage leaves nothing: resources,
  state, Branch. Destroying production removes its state database before the
  best-effort Project removal, so empty Projects still get cleaned up.
  Deleting a Branch or Project from the Console (or any platform surface)
  cleans up state without the platform knowing the framework exists, and a
  recreated stage of the same name starts from genuinely fresh state.
- **One extra small database per stage**, visible in the Console next to the
  user's own databases. A user can delete it, orphaning live resources from
  their state (a later deploy re-provisions from scratch and may duplicate).
  Marking it protected/framework-owned is a platform capability we do not
  have — the same standing limitation as ADR-0009's name-squatting note, at
  smaller blast radius (one stage, not the whole workspace).
- **That database costs a quota slot, not money.** The platform's plan limit on
  databases is workspace-wide, counting every database in every project, so
  each stage's state store consumes one — against a cap of 50 on the free plan
  and 1000 on the paid plans. Nothing bills per database: Postgres bills on
  storage (GiB-hours) and queries, and a store holding a few rows of JSON that
  is read only during deploys rounds to nothing on both. The constraint that
  can actually bite is a free-plan workspace running many concurrent preview
  stages, where the app's own databases compete for the same 50 slots.
- **The lock is unchanged and better scoped.** ADR-0010's per-`(stack,
  stage)` advisory lock now lives inside a per-stage store, so its key is
  redundant — kept anyway, because removing it buys nothing. Cross-stage and
  cross-app contention on a shared store disappears.
- **The store's schema is unchanged**, including its now-redundant
  `stack`/`stage` key columns. The wire shape stays identical to every other
  Alchemy store; nothing in the engine or service layer changes.
- **Platform-side teardown covers platform resources only.** State can track
  resources outside Prisma Cloud (the point of borrowing a general
  provisioning engine); deleting the state database from the platform side
  deletes the only record of them. A graph containing non-platform resources
  must be destroyed through the CLI, which walks state. Documented
  limitation, not an invisible one.
- **No migration.** The legacy workspace store is not read or migrated; the
  cutover is destroy-then-redeploy (see the deploying guide), after which the
  workspace-level `prisma-composer-state` project is inert and can be deleted.
- **Everything a deploy touches is project-scoped.** No state operation needs
  workspace-level reach anymore — which is what a future CD/webhook
  integration needs to hand a build a project-scoped credential instead of a
  workspace-scoped one.

## Alternatives considered

- **Keep the workspace store and repair orphans lazily** — a staleness check
  (state records its Branch id; a mismatch on deploy resets the stage's
  state). Rejected: it patches the one symptom while leaving platform-side
  teardown incorrect by default, and it keeps every deploy needing
  workspace-scoped state access.
- **One state database per Project, holding all stages.** Rejected: deleting
  a Branch would orphan that stage's rows — the platform can enumerate a
  Branch's children, but it cannot reach inside a database.
- **The platform reaches into the store on teardown.** Rejected: couples the
  platform to the store's private schema, the inverse of the
  platform-stays-ignorant property this decision buys.
- **A platform-side state API** — still the end state, as ADR-0009 said. This
  store now proves the *right* shape for it: state scoped as a child of the
  Branch, cascading on delete, rather than workspace-global rows behind
  coarse access control.

## Related

- [ADR-0009](ADR-0009-deploy-state-is-hosted-in-the-workspace.md) — the
  workspace-level store this supersedes; its hosted-state reasoning,
  bootstrap, and credential model carry over.
- [ADR-0010](ADR-0010-deploys-hold-a-session-advisory-lock.md) — the deploy
  lock, now scoped within the per-stage store; state-database deletion severs
  its lease.
- [ADR-0011](ADR-0011-targets-supply-the-deploy-state-layer.md) /
  [ADR-0012](ADR-0012-the-state-store-speaks-sql-directly.md) — unchanged:
  the target still supplies this store; it still speaks SQL.
- [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md) /
  [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)
  — the container model that dissolved the circularity objection.
- [`../03-domain-model/layering.md`](../03-domain-model/layering.md) — the
  provisioning-state spectrum this updates.
