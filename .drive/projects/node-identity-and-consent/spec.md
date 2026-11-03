# Purpose

Make every identity change in a Composer graph deliberate and every data-losing deploy consented. Today one string on each node is at once its identity, its label and its address, so an edit that looks cosmetic re-identifies a node and the next deploy deletes a database or forks a Project. After this project, a node's identity and its label are two fields, a label edit changes nothing structural, an identity edit is visible in the diff and asks before it destroys anything, and the platform's CI credential can only reach the Project it was issued for.

This project builds on `deployment-identity`, which already makes Composer find a Project by identifier only and create one only when told. That project closes the reported problem; this one makes the model right. It is written for handoff to another team.

# At a glance

Three phases, each shipping on its own.

**Phase 2: separate identity from label.**
Every node definition carries a required `logicalId` and an optional `name`. `logicalId` is hand-written, stable over time, and the only value that reaches the platform row's `logicalId` and the application topology. `name` reaches the display name and nothing else; absent, Composer does not manage the label. The provision-time `id` override stays for provisioning the same node twice or a packaged module whose consumer needs a different address. The single-string form, `module('store', …)` and `postgres({ name })`, stops loading with an error naming the two-field form. `--name` on `prisma deploy` goes away. The generated setup files and the Console's reader of the module file follow.

**Phase 3: ask before losing data.**
A deploy whose plan would delete a Database or Bucket, or re-identify a node, uses the ORM's consent model: one question per subject, answered by `--delete <subject>` or `--rename <old>:<new>`; `--yes` never consents; there is no `--force`; non-interactive runs fail with `CLI.CONSENT_REQUIRED` naming the flags. CI fails closed and a human consents from a laptop. `--rename` updates the platform row's `logicalId` in place, which is the survivable rename the branch-topology design left open.

**Phase 4: platform.**
CI tokens scoped to the Project the repo is connected to, then Console approval of consent questions raised by a CI deploy.

# Non-goals

- Conveniences that derive `logicalId` from `name`. Required everywhere first; conveniences only if that proves necessary, and never a default from `name`.
- Consent recorded in code (`renamedFrom`, `retired(...)`, Terraform-style `moved` blocks). Rejected; see design notes.
- A committed consent file bound to a plan hash. Rejected; see design notes.
- A deprecation period for the single-string form. Composer is pre-1.0.
- Changing the deploy action or the generated workflow for anything in phases 2 and 3.

# Place in the larger world

- Composer: the node constructors in `@prisma/composer` and the Prisma Cloud extension; Load, which assigns each node its address; the `prisma deploy` command; and container resolution, which finds the Project before Alchemy runs.
- Control plane: the setup-PR generator (`planComposerSetup.ts`, `buildModule`), the module-file inspector that reads the declared name at connect, and the resource update path that the import project (`projects/composer-import/spec.md`) adds for binding rows by platform id. Phase 3's `--rename` depends on that path accepting a new `logicalId` on service, database and bucket rows.
- The control plane's decision record on CI trust ("a connected repository is the trust boundary for CI deploys") mints a workspace-wide token and defers narrowing it. Phase 4 is where that narrowing lands. The control plane's CI-builds spec requires that every screen a user acts on is in Console, which is why consent approval belongs there rather than in GitHub.
- The ORM's CLI Style Guide, "Destructive operation confirmation", is the consent model to copy exactly.

# Cross-cutting requirements

- `logicalId` is the only identity. No code path may match a platform row by display name.
- Every node kind that lowers to a platform row passes its `logicalId`. A new node kind is not done until it does. Composer's decision record "a node's address is its logical ID on the platform" already requires this; it is restated here because phase 2 touches every constructor.
- Consent is per subject and never defaulted. `--yes` and `-y` accept prompt defaults only.
- The graph is Composer's image of the system: values edited on the platform are set back on the next deploy. The one deliberate exception is a label whose declaration omits `name`.
- Composer stays unaware of GitHub.

# Transitional-shape constraints

- Phase 2 lands in one Composer release, because it breaks every existing module. The generated setup files and the Console inspector ship before or with it.
- Phase 3's `--delete` can ship before `--rename`; `--rename` waits on the platform update path. Until then a re-identified node is delete-and-create with consent.
- Phase 4's two halves are independent: scoped tokens first, approval second.

# Project DoD

- [ ] A module written with the two-field form deploys; the same module with a single-string node fails to load with an error naming the fix.
- [ ] Renaming a database's `name` and deploying changes its Console label and nothing else. Renaming its `logicalId` without a statement fails with `CLI.CONSENT_REQUIRED`; with `--rename old:new` the same row keeps its data and carries the new identifier; with `--delete old` the row is deleted and a new one created. Each proven against a real Project.
- [ ] A push-to-deploy run whose plan would delete a database fails closed and names the flags; no row changes.
- [ ] A fresh Console connect writes the two-field root with a hoisted `logicalId` constant, and connecting a repo that brings its own two-field config reads the identifier correctly.
- [ ] A CI token minted for a connected repo cannot read or write another Project in the workspace.
- [ ] A new Composer decision record states the two-field model and the consent model, and amends the records on node naming, stage resolution and node addresses. The guides, examples and the core-concepts skill use the two-field form throughout.

# Open questions

- Whether Console approval (phase 4b) is built in this project or spun out once scoped tokens exist. Decide at phase 4 planning.
- Whether the plan output for an identity change below the root needs its own flag beyond the consent question. Decide in phase 3 slice planning.

# References

- Design notes with every decision, its reasoning, and the rejected alternatives: [design-notes.md](design-notes.md).
- User scenarios the design must cover: [assets/user-scenarios.md](assets/user-scenarios.md).
- Worked example of the two-field model: [assets/logicalid-walkthrough.md](assets/logicalid-walkthrough.md).
- Predecessor project: `.drive/projects/deployment-identity/`.
- ORM consent model: prisma/orm `docs/CLI Style Guide.md`, section "Destructive operation confirmation". The two ORM changes that introduced it are "migration plan asks before a lossy type change" (commit 07a7bc06) and "migration plan requires consent for destructive auto-baselines" (commit c5a8b5ad).
- Composer decision records, in `docs/design/90-decisions/`: ADR-0006 "every node is named", ADR-0024 "a stage is a deploy-time environment resolved to Project and Branch", ADR-0050 "Composer runs as prisma deploy and prisma dev", ADR-0051 "a node's address is its logical ID on the platform".
- Control plane, prisma/pdp-control-plane: ADR-010 "a connected repository is the trust boundary for CI deploys", ADR-011 "project slug as the deploy-target identity", `projects/branch-topology/spec.md`, `projects/composer-import/spec.md`, and `docs/compute/GitHubImport.md`.
- Linear: Node identity and consent (Terminal team).
