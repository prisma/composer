# Design notes — node-identity-and-consent

This is the full design from the discussion on 2026-10-14, written for handoff. Phase 1 ("Delivery order" below) is delivered by the `deployment-identity` project; this project delivers phases 2 to 4. Companion material: [assets/user-scenarios.md](assets/user-scenarios.md) and [assets/logicalid-walkthrough.md](assets/logicalid-walkthrough.md).

## The refined topic

Søren's concern was that renaming a Composer root module can redirect a
deploy into another repository's Project. The discussion reframed it: the
defect is that one string on every node is at once the identity, the label
and the address, so an edit that looks cosmetic changes identity. The fix is
to separate identity from label on every node and make every identity change
and every data-losing deploy an explicit act. The security boundary Søren
also named, the workspace-wide CI token, is a platform concern and is left to
scoped tokens.

## Decisions

### D1. Every node has `logicalId` and `name`

`logicalId` is the node's identity: required, hand-written, stable over time.
`name` is a label: optional. Only `logicalId` reaches the platform row's
`logicalId` and the topology. `name` reaches the display name and nothing
else. Absent `name` means Composer does not manage the label.

`logicalId` lives on the node definition (`postgres({ logicalId })`,
`module({ logicalId, name }, …)`), not on the `provision()` call. The
provision-time `id` override stays for its one purpose: provisioning the
same node twice, or a reusable module from a package whose consumer needs a
different address. Platform rows already have ids; these are not those.

*Why:* with two fields, a label edit is harmless and an identity edit is
visibly deliberate in the diff. Composer can tell the two apart, which it
cannot today, so it can also name the consequence.

*Assumes:* authors accept writing both fields. Conveniences are added only
if that proves necessary.

### D2. The Project is selected by `logicalId` only

The display-name fallback in container resolution is removed.

*Why:* the fallback is what let a name match adopt an unrelated Project.
The decision record "a node's address is its full path from the app name" already calls it a compatibility path.

*Assumes:* D10 backfills old Projects first.

### D3. The graph is Composer's image of the system

Values edited on the platform are set back on the next deploy. This
includes labels, when `name` is set.

*Why:* one writer per field. Two writers fight on every deploy.

*Consequence to record:* the control plane's import spec says an adopted
resource keeps its label. Under D3 that holds when the declaration omits
`name`.

### D4. Creating a Project is explicit: `--create`

A deploy whose root `logicalId` matches no Project refuses, says it would
create a new project rather than update one, and names `--create`. This is a
mode flag making a non-default action explicit, not a consent; nothing is
lost by creating.

*Why:* a mistaken identity edit lands on "you are about to create a project"
instead of a silent empty Project and a production outage.

### D5. Console creates the Project at connect time

The setup-PR path adopts what the "connect without a setup PR" path already
does: create the Project with the reserved `logicalId` and the link together.
CI never creates a Project.

*Why:* it sets the Project's `logicalId` and the module's in tandem, avoids
any change to the generated workflow or the deploy action, and has no
coupling to a Composer version that knows `--create`. Old and new Composer
both find the Project by `logicalId`.

*Consequences to record:* a pending link carries a `projectId` from the
start, so "Remove setup" and the abandoned-PR archive path must delete the
empty Project deliberately. Console passes a region at create.

### D6. Overwriting another repo's Project is a platform concern

Setting the root `logicalId` to another project's identifier and deploying
is an explicit instruction. Composer cannot distinguish a mistake from a
takeover without reading build history, which would drag GitHub back in.
The lock is scoped CI tokens, which the control plane's ADR-010 defers.

### D7. The single-string form stops loading

`module('store', …)` and `postgres({ name })` fail with an error naming the
two-field form. No deprecation period: Composer is pre-1.0.

### D8. Data-losing deploys use the ORM's consent model

A deploy whose plan would delete a Database or Bucket, or re-identify a node,
asks one question per subject, answered by `--delete <subject>` or
`--rename <old>:<new>`. `--yes` never consents. There is no `--force`.
Non-interactive runs fail with `CLI.CONSENT_REQUIRED` naming the flags. The
first implementation is laptop-only for destructive deploys: CI fails
closed and a human consents interactively.

`--rename` is the survivable-rename mechanism the branch-topology spec left
open. It depends on the platform's update path accepting a new `logicalId`
on service, database and bucket rows, which the import project is adding.

*Why:* consistency with the ORM, and the ORM's reasoning holds here: consent
describes a transition, and only the command performing it needs the
description.

### D9. Console approval of CI consent is the target, deferred

The build record would carry the questions, Console would show them, and a
click would answer. It needs scoped tokens to be safe. Rejected for now as
a large piece of platform work.

### D10. Backfill `logicalId` on old Projects once

A platform script sets `logicalId` from the link's reserved module name on
every linked Project that has none. A Project with neither a `logicalId` nor a
link has no automatic fix. Whether Console lets a user set one by hand is an
open question.

### Smaller consequences

- `--name` on `prisma deploy` goes away. Re-identifying the root is
  `--rename store:storefront`.
- The generated `module.mjs` hoists the root `logicalId` into a named
  constant with a one-line comment. The Console inspector must read that
  constant, not only the `module("…")` literal.
- Composer stays unaware of GitHub. No `GITHUB_*` reads, no
  source-repository lookups.

## Alternatives rejected

- **PR 355's approach**: Composer reads `GITHUB_REPOSITORY_ID` and checks
  the source-repository listing. Makes Composer GitHub-aware, re-verifies at
  deploy time what the platform decided at connect time, and is only a
  safeguard by its own admission.
- **The OIDC exchange returns the app name and the action passes `--name`.**
  Locks CI but makes the identity invisible in the repo, so a developer
  cannot tell which Project `module.mjs` deploys to, and a local and a CI
  deploy of the same file can target different Projects.
- **A platform-generated root `logicalId`** (opaque id, or readable slug with
  a suffix). An opaque id is a foreign key in user code and fails on fork or
  delete, which the control plane's ADR-011 already rejected. A suffixed slug
  invites "tidying," which silently creates a new Project.
- **`logicalId` defaulting from `name`.** Reintroduces the footgun one level
  down.
- **CI passes `--create`.** Makes the flag meaningless in CI and couples the
  generated workflow to a Composer version.
- **Consent in code** (`renamedFrom`, `retired(...)` declarations, Terraform's
  `moved` blocks). Prototyped and rejected in the ORM: the code would carry an
  obsolete representation of the system after the transition, when only the
  command performing it ever needed it. The hint goes to the command instead.
- **A committed consent file bound to a plan hash.** The hash differs per
  environment, so a production consent blocks every preview deploy on the branch.

## Open items and accepted trade-offs

- A human with a workspace token can still deploy into any Project. Accepted
  until scoped tokens exist.
- Destructive deploys cannot run from push-to-deploy. Accepted; D9 is the
  path out.
- Plan output for identity changes below the root is part of D8, not a
  separate slice.
- TD-034 in the control plane (two concurrent connects reserving the same
  module name) is unchanged by this design.

## Persona cross-pollination

The architect pass settled shape: two fields, identity on the definition,
`logicalId` kept as the shared vocabulary with the platform. The principal
engineer concerns surfaced during it and were settled by adopting an
existing mechanism each time: the ORM's consent model for data loss, the
Console's existing create-and-link path for D5, and the resolver's existing
find-only mode for `--create`.

## Where the work lands

| Change | Repo |
| --- | --- |
| `logicalId` and `name` on every node; single-string form refused; `--create`; ORM consent model; `--name` removed; a decision record amending the records on node naming, environment resolution and full-path addresses | prisma/composer |
| Console creates the Project at connect for the setup-PR path; empty-Project cleanup on release; inspector reads the hoisted constant; generated `module.mjs` uses the two-field form; backfill script | prisma/pdp-control-plane |
| Nothing required. Close PR 355. | prisma/cloud-deploy-action |
| Scoped CI tokens; Console approval of consent | platform, later |

## Delivery order

Agreed 2026-10-14. Each phase ships on its own.

1. **Close the immediate problem.** Composer finds the project only by its
   identifier (the display-name fallback goes). A one-time platform script
   gives old projects an identifier from the name the repo was connected
   under. Composer refuses to create a project unless `--create` is passed.
   Console creates the project when the repo is connected, so CI never
   creates one. No change to how modules are written. PR 355 closes.
2. **Separate identity from label.** Every node gets a required `logicalId`
   and an optional `name`. The single-string form stops loading. `--name`
   on deploy goes away. The generated setup files and the Console's reader
   of the module file follow. One release, because it breaks the API.
3. **Ask before losing data.** The ORM's consent model: `--delete` and
   `--rename` per subject, `--yes` never consents, CI fails closed and a
   human consents from a laptop. Waits on the platform allowing a row's
   identifier to change, which the import project adds.
4. **Platform.** CI tokens scoped to one project, then Console approval of
   consent from CI.
