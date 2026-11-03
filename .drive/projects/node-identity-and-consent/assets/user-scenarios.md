# Deployment identity: user scenarios the design must cover

Companion to [logicalid-walkthrough.md](logicalid-walkthrough.md). Each row
is a concrete situation, what the user expects, and which decision covers
it. The decisions are listed in full, with their reasoning, in
[../design-notes.md](../design-notes.md). Addresses here are full paths from
the app name, as the decision record "a node's address is its full path from
the app name" requires.

Decisions, for reference:

- D1. Every node has `logicalId` (identity, required, hand-written) and `name` (label, optional).
- D2. The Project is selected by `logicalId` only. The display-name fallback is removed.
- D3. Composer's graph is the source of truth; labels edited on the platform are set back on the next deploy. Omitting `name` leaves the label alone.
- D4. Creating a Project is explicit: a deploy that would create one needs `--create`.
- D5. Console creates the Project at connect time, so CI never creates one.
- D6. The overwrite case (identity set to another project's) is addressed by scoped CI tokens on the platform, not by Composer.
- D7. The single-string form stops loading. No deprecation period.
- D8. Data-losing deploys use the ORM's consent model: `--delete <subject>` or `--rename <old>:<new>`, `--yes` never consents, CI fails closed.
- D9. Console approval of consent raised by a CI deploy is the target, deferred.
- D10. A one-time platform script backfills `logicalId` on old linked Projects.

## A. Getting connected

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| A1 | New user connects a repo with no Composer config in Console, types the app name "store". | Console checks `store` is free in the workspace, reserves it, opens the setup PR with `logicalId = "store"` and `name: "Store"` in `module.mjs`. | D1, D5 |
| A2 | Setup PR's own workflow deploys a preview before merge. | The preview deploys into the reserved Project's branch. Nothing is created by CI. | D5 |
| A3 | User merges the setup PR. | Push to main deploys production into the same Project. Link becomes active. | D2 |
| A4 | User connects a repo that already has a Composer config with `logicalId = "store"`. | Console reads the identifier from the file, checks it is free, reserves it, creates the Project, and links. | D5; needs the Console inspector to read a hoisted constant |
| A5 | Two people connect two repos with the app name "store" in the same workspace. | The second connect is refused with "a project with this name exists." | Existing conflict check; TD-034 covers the concurrent race |
| A6 | A repo connected before this change has a module with a single string `module('store', …)`. | The module fails to load with an error naming the two-field form. The author adds the fields and deploys again. | D7 |
| A7 | A Project created before `logicalId` existed, with display name "Bright Peach Wallaby" and no identifier. | After D2 it no longer resolves by name. The backfill sets its `logicalId` from the link's reserved name before the fallback is removed. A Project with no link has no automatic fix. | D10 |

## B. Day-to-day edits that must be safe

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| B1 | Author changes the root `name` from "Store" to "Storefront". | Console label changes. Same Project, same environments, same data. | D1, D3 |
| B2 | Author changes a database's `name` from "Catalog" to "Catalogue". | Label changes. Same Database, same data. | D1, D3 |
| B3 | Someone renames the Project in Console. | On the next deploy the label returns to the code's `name`. If code has no `name`, the Console label stays. | D3 |
| B4 | Someone renames a Database in Console. | Same as B3. | D3 |
| B5 | Author moves a service into a nested module without changing its `logicalId`. | Its address changes (`store.api` → `store.billing.api`), so its identity changes, as it does today. The deploy would delete its rows, so it asks for consent: `--rename store.api:store.billing.api` keeps them, `--delete store.api` replaces them. | D1, D8 |

## C. Identity edits that must be deliberate and visible

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| C1 | Author changes the root `logicalId` from `store` to `storefront`, not understanding the consequence, and runs a local deploy. | Deploy stops: "No Project with logicalId `storefront`. You are creating a new project, not updating `store`. Pass `--create` to proceed." | D4 |
| C2 | Same edit, pushed to a connected repo. | CI deploy fails with the same message. The Project reserved for this repo is `store`; nothing is created. | D4, D5 |
| C3 | Author changes a database's identity, so its address goes from `store.catalog` to `store.catalogue`. | The deploy asks: delete `store.catalog` and lose its data, or rename it to `store.catalogue` and keep it. Answered by `--delete store.catalog` or `--rename store.catalog:store.catalogue`. The question says to use `name` for a label change. In CI the deploy fails and names both flags. | D1, D8 |
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
| D5 | User destroys an environment, such as staging or production, through the control API. | Found by `logicalId`, find-only. Unchanged. | D2 |
| D6 | User imports an existing database into the module (control plane import spec). | They declare `logicalId: 'catalog'` and bind the row by platform id. Omitting `name` keeps the Console label. | D1, D3 |

## E. Paths without a Console link

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| E1 | Hand-written repo, `PRISMA_SERVICE_TOKEN` in Actions secrets, never connected. | First deploy needs `--create` in the workflow, or the user creates the Project by hand first. Later deploys find it. | D4 |
| E2 | Developer deploys from a laptop with a personal service token into a connected repo's Project. | Found by `logicalId`. Same Project as CI. | D2 |
| E3 | Developer runs `prisma deploy --name demo-42` to deploy under a different app name (documented today). | `--name` is removed. Deploying the same code as a second app means changing the root's identity in the code and deploying with `--create`. Re-identifying an existing app is `--rename store:storefront`. | D4, D8 |

## F. Operator-facing

| # | Scenario | Expected | Covered by |
| --- | --- | --- | --- |
| F1 | Support looks at a Project and asks which repo deploys to it and under which identifier. | The link row shows repo id and `logicalId`; the Project row shows the same `logicalId`. | D5 |
| F2 | A deploy created a Project nobody expected (today's composer#103 class of incident). | Cannot happen from CI after D5. From a laptop, it required `--create`. | D4, D5 |

## How the open items were settled

Every item this list first left open was settled later in the same discussion:

1. Console creates the Project at connect time for the setup-PR path (D5).
2. Existing single-string modules stop loading, with an error naming the two-field form. Composer is pre-1.0, so there is no deprecation period (D7).
3. A one-time platform script backfills `logicalId` on linked Projects before the display-name fallback is removed (D10).
4. An identity change below the root is a consent question, answered by `--rename` or `--delete`, using the ORM's consent model (D8).
5. `--name` is removed. Re-identifying the root is `--rename store:storefront`.
