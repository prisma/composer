# Purpose

Make it impossible for an edit that looks cosmetic to redirect a deploy. Today the root module's name is the only thing that chooses the Project a deploy lands in, and Composer falls back to matching display names, so renaming the root in a connected repo can deploy into another repository's Project or create a stray one. After this project, a deploy finds its Project by identifier only, never creates one unless told to, and the platform has given every Project an identifier. The rename still fails, but it fails before anything is created or overwritten, with a message that says what would have happened.

This is phase 1 of a larger design (see `node-identity-and-consent`). It solves Søren's reported problem and closes prisma/composer#355 without changing how modules are written.

# At a glance

Four changes, two in Composer and two on the platform:

1. **Find by identifier only.** `resolveProject` in `packages/1-prisma-cloud/0-lowering/lowering/src/container.ts` matches a Project's `logicalId` against the app name and nothing else. The display-name fallback, oldest first, is deleted.
2. **Create only when told.** A deploy whose app name matches no Project stops with a structured error: this would create a new project, not update one; pass `--create`. `prisma deploy` gains that flag and the control API gains the matching option. Destroy is already find-only.
3. **Console creates the Project at connect.** The setup-PR path in the control plane's connect flow creates the Project with the reserved module name as its `logicalId` and links it, as the "connect without a setup PR" path already does. CI never creates a Project. Releasing or abandoning the setup deletes the empty Project it created.
4. **Backfill.** A one-time platform script sets `logicalId` on every linked Project that has none, from the link's reserved module name.

# Non-goals

- Changing the node API. `logicalId` and `name` as separate fields, and refusing the single-string form, are the follow-on project.
- Consent for data-losing deploys. Follow-on project.
- Reading anything GitHub-specific in Composer. The deploy action and the generated workflow are unchanged.
- Preventing a deliberate deploy into another Project with a workspace-wide token. That is scoped CI tokens, a platform follow-up.
- A deprecation period for the display-name fallback. Composer is pre-1.0 and the backfill makes it unnecessary.

# Place in the larger world

- Composer: container resolution, which finds or creates the Project and Branch before Alchemy runs (decision record "a stage is a deploy-time environment resolved to Project and Branch", amended by "a node's address is its logical ID on the platform"), and the `prisma deploy` command.
- Control plane: `connectRepositoryForComposer` in `services/console-compute/lib/composerConnect.server.ts`, `connectWorkspaceToScmRepo`, `createProject` and its `reflectProjectOnLink` step, which becomes unnecessary once the Project exists before the link. The GitHub Actions token exchange and `cloud-deploy-action` are untouched.
- The control plane's decision record "project slug as the deploy-target identity" made the module name the Project's `logicalId`. This project finishes that work by removing the display-name fallback it kept for older Projects.
- prisma/composer#355 is closed in favour of this project. The decision record it proposed, "GitHub project selection checks active repository connections", is not adopted.

# Cross-cutting requirements

- A deploy that cannot find its Project never creates, mutates or reconciles anything before it stops.
- Every repo connected through Console today keeps deploying across the change. The backfill runs before the Composer release that removes the fallback.
- The `--create` refusal is a structured CLI error with a `fix` that names the flag and, for a connected repo, says the Project should already exist and to check the Console connection.
- Composer stays unaware of GitHub.

# Transitional-shape constraints

- Order of landing: the platform changes (create at connect, backfill) ship first. The Composer release that removes the fallback and adds `--create` ships after the backfill has run, or the setup PR's first deploy breaks.
- Until the Composer release ships, a Project created at connect time is found by the old resolver through its `logicalId` match, so the platform change is safe to ship alone.

# Project DoD

- [ ] A renamed root in a connected repo fails its CI deploy with the "would create a new project" error and creates nothing. Proven against a real workspace.
- [ ] A fresh Console connect creates the Project before the setup PR's first deploy, and that deploy lands in it.
- [ ] Releasing a setup ("Remove setup") or closing the setup PR unmerged deletes the Project the connect created, and only that one.
- [ ] Every linked Project in production has a `logicalId`; the backfill reports zero remaining.
- [ ] `prisma deploy --create` creates a Project from a laptop; without the flag the same deploy refuses.
- [ ] The two Composer decision records named above are amended. The deploying guide and the core-concepts skill say that a deploy finds its Project by `logicalId` and needs `--create` to make one. The guide's `prisma deploy module.ts --name demo-42` example still works, with `--create` on its first run.
- [ ] prisma/composer#355 closed with a comment pointing at this project.

# Open questions

- None blocking. Whether Console should also allow editing a Project's `logicalId` by hand for Projects with no link (so a user can fix one the backfill cannot) is answered in the follow-on project if it comes up.

# References

- Design synthesis and scenarios: `.drive/projects/node-identity-and-consent/design-notes.md` and `assets/`.
- Slack thread with Søren, 2026-10-14, and prisma/composer#355.
- Composer decision records, in `docs/design/90-decisions/`: ADR-0006 "every node is named", ADR-0024 "a stage is a deploy-time environment resolved to Project and Branch", ADR-0050 "Composer runs as prisma deploy and prisma dev", ADR-0051 "a node's address is its logical ID on the platform".
- Control plane, prisma/pdp-control-plane: ADR-010 "a connected repository is the trust boundary for CI deploys" (it mints a workspace-wide token), ADR-011 "project slug as the deploy-target identity", `docs/CiOidcTokenExchange.md`, and `docs/compute/GitHubImport.md` for the repository link lifecycle.
- Linear: Deployment identity (Terminal team).
