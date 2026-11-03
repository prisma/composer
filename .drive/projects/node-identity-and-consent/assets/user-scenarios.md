# Deployment identity: user scenarios the design must cover

Companion to [logicalid-walkthrough.md](logicalid-walkthrough.md). Each row
is a concrete situation, what the user expects, and which decision covers
it. "Open" marks the ones the discussion has not settled.

Decisions so far, for reference:

- D1. Every node has `logicalId` (identity, required, hand-written) and `name` (label, optional).
- D2. The Project is selected by `logicalId` only. The display-name fallback is removed.
- D3. Composer's graph is the source of truth; labels edited on the platform are set back on the next deploy. Omitting `name` leaves the label alone.
- D4. Creating a Project is explicit: a deploy that would create one needs `--create`.
- D5. Proposed, open: Console creates the Project at connect time, so CI never creates.
- D6. The overwrite case (identity set to another project's) is addressed by scoped CI tokens on the platform, not by Composer.

## A. Getting connected

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| A1 | New user connects a repo with no Composer config in Console, types the app name "store". | Console checks `store` is free in the workspace, reserves it, opens the setup PR with `logicalId = "store"` and `name: "Store"` in `module.mjs`. | D1, D5 |
| A2 | Setup PR's own workflow deploys a preview before merge. | The preview deploys into the reserved Project's branch. Nothing is created by CI. | D5 (open: today CI creates the Project) |
| A3 | User merges the setup PR. | Push to main deploys production into the same Project. Link becomes active. | D2 |
| A4 | User connects a repo that already has a Composer config with `logicalId = "store"`. | Console reads the identifier from the file, checks it is free, reserves it, creates the Project, and links. | D5; needs the Console inspector to read a hoisted constant |
| A5 | Two people connect two repos with the app name "store" in the same workspace. | The second connect is refused with "a project with this name exists." | Existing conflict check; TD-034 covers the concurrent race |
| A6 | A repo connected before this change has a module with a single string `module('store', …)`. | Keeps deploying unchanged until the author adopts the two-field form. The migration rule is open: does a single string mean `logicalId` and `name` both, with no behaviour change? | Open |
| A7 | A Project created before `logicalId` existed, with display name "Bright Peach Wallaby" and no identifier. | After D2 it no longer resolves by name. It needs a backfill from the link's reserved name, or the user sets the Project's `logicalId` in Console once. | Open: backfill vs Console edit |

## B. Day-to-day edits that must be safe

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| B1 | Author changes the root `name` from "Store" to "Storefront". | Console label changes. Same Project, same stages, same data. | D1, D3 |
| B2 | Author changes a database's `name` from "Catalog" to "Catalogue". | Label changes. Same Database, same data. | D1, D3 |
| B3 | Someone renames the Project in Console. | On the next deploy the label returns to the code's `name`. If code has no `name`, the Console label stays. | D3 |
| B4 | Someone renames a Database in Console. | Same as B3. | D3 |
| B5 | Author moves a service into a nested module without changing its `logicalId`. | Its address changes (`api` → `billing.api`), so its identity changes. Plan output says so. Same as today under ADR-0051; not a regression, but should be named. | D1; plan output open |

## C. Identity edits that must be deliberate and visible

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| C1 | Author changes the root `logicalId` from `store` to `storefront`, not understanding the consequence, and runs a local deploy. | Deploy stops: "No Project with logicalId `storefront`. You are creating a new project, not updating `store`. Pass `--create` to proceed." | D4 |
| C2 | Same edit, pushed to a connected repo. | CI deploy fails with the same message. The Project reserved for this repo is `store`; nothing is created. | D4, D5 |
| C3 | Author changes a child `logicalId` (`catalog` → `catalogue`). | Plan output names the consequence: delete `catalog`, create `catalogue`, data lost, use `name` for a label change. Whether this needs a flag is open. | D1; plan output open |
| C4 | Author sets the root `logicalId` to another repo's project (`billing`) by mistake, with a workspace-wide token (hand deploy or today's CI token). | Composer finds `billing` and deploys into it. Composer cannot tell this from C5. The edit is explicit in the diff, which is the improvement over today. The lock is D6. | D6 |
| C5 | Author sets the root `logicalId` to another project on purpose to take it over. | Same as C4. Works. | D2 |
| C6 | Same as C4, with a scoped CI token (future). | The platform refuses the write to `billing`. | D6, platform |

## D. Lifecycle

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| D1 | User forks the repo to make a second, separate app. | They change `logicalId` to `store-eu` and run `prisma deploy --create`, or connect the fork in Console, which reserves the new identifier and creates the Project. | D4, D5 |
| D2 | User deletes the Project in Console, then pushes. | CI deploy fails: no Project with `logicalId` `store`, and CI does not create. The user reconnects in Console or runs `--create` by hand. | D4, D5 |
| D3 | User renames the repo on GitHub. | Nothing changes. The link is by numeric repo id. | Existing |
| D4 | User unlinks the repo in Console and deploys from a laptop with a service token. | Works: the Project is found by `logicalId`. | D2 |
| D5 | User destroys a stage, or production, through the control API. | Found by `logicalId`, find-only. Unchanged. | D2 |
| D6 | User imports an existing database into the module (control plane import spec). | They declare `logicalId: 'catalog'` and bind the row by platform id. Omitting `name` keeps the Console label. | D1, D3 |

## E. Paths without a Console link

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| E1 | Hand-written repo, `PRISMA_SERVICE_TOKEN` in Actions secrets, never connected. | First deploy needs `--create` in the workflow, or the user creates the Project by hand first. Later deploys find it. | D4 |
| E2 | Developer deploys from a laptop with a personal service token into a connected repo's Project. | Found by `logicalId`. Same Project as CI. | D2 |
| E3 | Developer runs `prisma deploy --name demo-42` to deploy under a different app name (documented today). | Open: with two fields, `--name` either overrides the root `logicalId` (and needs `--create`) or is removed. | Open |

## F. Operator-facing

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| F1 | Support looks at a Project and asks which repo deploys to it and under which identifier. | The link row shows repo id and `logicalId`; the Project row shows the same `logicalId`. | D5 |
| F2 | A deploy created a Project nobody expected (today's composer#103 class of incident). | Cannot happen from CI after D5. From a laptop, it required `--create`. | D4, D5 |

## Open items this list surfaces

1. D5: create the Project at connect time for the setup-PR path (A2, C2, D2).
2. A6: migration rule for existing single-string modules.
3. A7: backfill of `logicalId` on old Projects, or a one-time Console edit.
4. C3 and B5: plan output for identity changes below the root, and whether it needs consent.
5. E3: the fate of `--name`.
