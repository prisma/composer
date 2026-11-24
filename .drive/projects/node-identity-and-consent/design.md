# Node identity and consent

Status: proposed design. Owner: Terminal (Composer). Platform parts: Portal (the Prisma Data Platform control plane and Console).

## The decision

1. **Every node is declared with an `id`, and only the `id` gives it identity.** A node's `id` is the last segment of its address. The address is the path of `id`s from the app's root (`shop.catalog`), and it stays what it is today: the node's platform `logicalId`. `name` no longer gives a node its identity.
2. **A deploy finds its Project by the root's `id` and nothing else, and never creates a Project unless told to.** The fallback that matches a Project by its display name is removed. A deploy that matches no Project stops and tells you to pass `--create`. Console creates the Project when a repository is connected, so a connected repository's CI never needs `--create`.
3. **A deploy that would delete a database or a bucket asks first, the way Prisma ORM's `migration plan` and `db update` commands do.** The person deploying answers by naming each one: `--delete shop.catalog` to delete it, or `--rename shop.catalog:shop.catalogue` to keep it, with its data, under its new address. `--yes` never answers these questions. A non-interactive deploy, such as CI, stops and lists the flags that would answer them.
4. **`prisma deploy --name` is removed.** The root's `id` in the code is the only thing that names the app.
5. **Later, on the platform:** CI tokens that can reach only the Project their repository is connected to, then a way to answer a CI deploy's questions in Console.

```ts
// Today: identity comes from `name`, which reads like a label.
export default appRoot('shop', ({ provision }) => {
  const catalog = provision(postgres({ name: 'catalog', contract, config }));
  provision(web, { deps: { db: catalog } });          // web.ts: compute({ name: 'web', … })
});

// After: identity comes from `id`, and says so.
export default appRoot({ id: 'shop' }, ({ provision }) => {
  const catalog = provision(postgres({ id: 'catalog', contract, config }));
  provision(web, { deps: { db: catalog } });          // web.ts: compute({ id: 'web', … })
});
```

| Node | Address, and its platform `logicalId` |
| --- | --- |
| the root, `appRoot({ id: 'shop' })` | `shop`, which is also the Project's `logicalId` |
| `postgres({ id: 'catalog' })` | `shop.catalog` |
| `compute({ id: 'web' })` | `shop.web` |

**Moving an existing app over changes nothing deployed.** Write each `id` with the string that forms the node's address segment today: the `id` passed to `provision()` if there is one, otherwise the node's `name`. The addresses then stay the same, and the next deploy changes nothing on the platform.

## Why

Today one string on each node, its `name`, decides three things at once: the node's identity, its Console label and its address. An edit that looks like relabelling changes identity:

| Edit | What the author meant | What the next deploy does today |
| --- | --- | --- |
| a database `name` from `catalog` to `catalogue` | fix the spelling | deletes the `catalog` database with its data and creates an empty `catalogue` |
| the root from `shop` to `storefront` | a nicer name | creates a second, empty Project; `shop` stays behind with its data |
| the root from `shop` to `billing`, a name another repository already uses | copy and paste | deploys into the other repository's Project and overwrites its production environment |

The last row was reported by a user. Two more things make it worse. When no Project's `logicalId` matches, Composer falls back to matching display names, so a rename can land in an unrelated Project. And a deploy that matches nothing quietly creates a Project.

## The design

### Declaring a node

Every node has an `id`. You write it on every node you define with `appRoot`, `module`, `compute`, `postgres`, `rawPostgres` or a bucket. Shared modules, such as `auth()` and `email()`, come with an `id` of their own, so you write one only to change it.

- **Format.** The root's `id` is the app name: letters, digits, `-` and `_`, starting with a letter or digit. Every other `id` is letters and digits only. These are the rules that apply today to the app name and to provision IDs.
- **Address.** A node's address is its parent's address, a dot, and its `id`. The root's address is its `id`. This is the address format that ships today; only the field it is read from changes. Two nodes under one parent cannot have the same `id`; the graph fails to load, as it does today when two addresses collide.
- **Using one definition twice.** `provision(node, { id })` still overrides the definition's `id` where it is provisioned. Its only use is placing the same definition twice in one graph, for example two `email()` modules with the `id`s `mail` and `alerts`.
- **No deprecation period.** A constructor given `name` and no `id` fails to load, with an error that says to write `id`. Composer is not yet at 1.0. Whether `name` is removed entirely, or kept as a label beside `id`, is the first open question; under the recommendation it is removed, and a `name` field is a type error and a load error.
- **Platform names.** Every display name Composer writes on the platform is the node's address, as today (`shop.catalog`).

### How a deploy finds its Project

- The deploy looks up the Project whose `logicalId` equals the root's `id`. It never matches by display name.
- If no Project matches, the deploy stops before it creates or changes anything:

  ```
  No Project with logicalId "storefront" in this workspace. This deploy would create a new
  Project rather than update one. Pass --create to do that. If this repository is connected
  in Console, its Project already exists; check the connection.
  ```

- `prisma deploy --create` finds the Project or creates it with that `logicalId`. `destroy` already only finds, and never creates.
- Changing the root's `id` therefore points the deploy at a different Project. The old Project is left exactly as it was, with its services still running and its databases and buckets untouched. Removing it is a separate `prisma project delete`.
- **Console creates the Project when a repository is connected,** with the app name the user chose as its `logicalId`, on every connect path. CI therefore always finds its Project. If the user removes the setup, or closes the setup pull request without merging it, Console deletes that Project, but only if nothing has been deployed into it.
- **Older Projects get a `logicalId` once.** When a repository is connected, Console stores the app name the user chose on the connection record. A platform script copies that stored name into the `logicalId` of every connected Project that has none. It refuses a value another Project in the same workspace already has, and reports those Projects for a person to fix. It runs before the Composer release that removes the display-name fallback, so no connected repository stops deploying.
- **Deploying into another Project on purpose still works.** If the root's `id` is changed to another existing Project's `logicalId`, the deploy goes into that Project without asking. The difference from today is that the change is explicit in the diff, not a side effect of a label edit or a display-name match. Stopping it needs the scoped CI tokens described below; until they ship, this case stays open.

### Asking before data is lost

Before it changes anything, a deploy works out its plan for the environment it targets. Every database or bucket the plan would delete is a question. That happens when:

- the node was removed from the code, or
- its address changed, because its `id` changed or it moved into another module.

Deleting a service, an environment variable or a database's credentials loses no data, so none of these is a question. The plan output still lists them. A changed root `id` is handled by `--create` above, because it names a different Project.

Interactively, the deploy asks one question per database or bucket:

```
The database shop.catalog would be deleted with its data (environment: production).
  Keep it under a new address:  --rename shop.catalog:<new address>
  Delete it:                    --delete shop.catalog
```

The answers follow the ORM's rules for destructive operations:

- `--delete <address>` lets the deploy delete that database or bucket.
- `--rename <old address>:<new address>` keeps it. The new address must be a node of the same kind that this deploy's plan would otherwise create from nothing: a database for a database, a bucket for a bucket. If it is not, the deploy fails before changing anything and says why. With a valid `--rename`, Composer tells Alchemy, the deploy engine it runs, that the resources at the old address are now at the new one. This is the mechanism Composer already uses internally to move resources between address formats; here it is generated for this one deploy and never written into code. The data stays, and the row's `logicalId` becomes the new address.
- Because names and keys follow the address, a rename also gives the database's credentials and a bucket's access key new values. Composer's own services receive them in the same deploy, together with their `COMPOSER_` environment variables under new keys. Anything outside Composer that holds the old credentials stops working.
- `--yes` never answers a question, and there is no `--force`.
- A `--delete` or `--rename` flag that matches no question fails the deploy with `CLI.CONSENT_UNUSED`.
- A non-interactive deploy with unanswered questions changes nothing and fails with `CLI.CONSENT_REQUIRED`, exit code 2. The error lists each question and the flags that answer it.
- Composer's programmatic API, `@prisma/composer/control`, takes the same answers through a callback, as the ORM's programmatic API does.

**Every environment answers for itself.** The question comes from that environment's plan, so each environment that holds the database asks once. An environment that never had it asks nothing. For example, renaming `catalog` to `catalogue` in a pull request:

1. The pull request's preview environment `pr-42` was created after the change, so it never had `shop.catalog`. Its CI deploy asks nothing and creates `shop.catalogue`.
2. After merging, the production CI deploy would delete production's `shop.catalog`, so it fails with `CLI.CONSENT_REQUIRED` and changes nothing.
3. A person runs `prisma deploy --environment production --rename shop.catalog:shop.catalogue` from a laptop. Production's database keeps its rows under the new address.
4. Production's deploy state now matches the code, so later production CI deploys ask nothing. Deploy state is Composer's record, kept by the platform for each environment, of what it has deployed there. Any other long-lived environment that had `shop.catalog`, such as `staging`, needs the same one-time deploy.

### What is removed

- `name` as a source of identity, on every node.
- `prisma deploy --name`. To deploy a second copy of an app, change the root's `id` and deploy with `--create`.
- Matching a Project by display name.
- Creating a Project without `--create`.

### Later, on the platform

- **Scoped CI tokens.** The token a connected repository's CI receives can reach only that repository's Project. Today it can reach the whole workspace.
- **Answering CI's questions in Console.** The build record would carry the deploy's questions, Console would show them, and a person's answer would let CI run again with it. This needs scoped tokens first.

## Requirements this design meets

| Requirement | How the design meets it |
| --- | --- |
| An edit that looks like relabelling cannot change a node's identity. | Identity comes only from `id`, a field named for what it does. |
| A deploy never creates a Project, or reaches a Project through a display-name match, without saying so. | The Project is found by `logicalId` only; creating one needs `--create`; Console creates connected repositories' Projects. Deploying into another Project by writing its `logicalId` stays possible, and explicit, until scoped CI tokens ship. |
| No deploy deletes a database or bucket unless a person named it. | One question per database or bucket, answered only by `--delete` or `--rename`; `--yes` never answers. |
| Changing a node's identity can keep its data. | `--rename` moves the database or bucket to its new address in place. |
| CI never consents to data loss on its own. | Unanswered questions fail the run before anything changes. |
| A node has one identity, the same in code, CLI and platform. | The `id`s form the address, and the address is the platform `logicalId`. |
| Every connected repository keeps deploying through the change. | The backfill runs before the Composer release that removes the display-name fallback, and writing `id` with today's strings keeps every address. |
| Composer knows nothing about GitHub. | Nothing reads `GITHUB_*` variables or repository ids; the link between a repository and its Project lives on the platform. |

## What this changes in the recorded design

These Composer decision records are amended or superseded when the work lands. Until then they describe what ships.

- [Every node is named; the root's name names the application](../../../docs/design/90-decisions/ADR-0006-every-node-is-named.md): a node's identity comes from `id`, not `name`, and `--name` is removed.
- [A node's address is its full path from the app name](../../../docs/design/90-decisions/ADR-0057-a-nodes-address-is-its-full-path-from-the-app-name.md): the address is the path of `id`s; the display-name fallback is removed; an address change no longer silently deletes a database or bucket.
- [A stage is a deploy-time environment resolved to Project and Branch](../../../docs/design/90-decisions/ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md): the Project is found by `logicalId` only and created only with `--create`.
- [Composer runs as `prisma deploy` and `prisma dev`](../../../docs/design/90-decisions/ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md): `deploy` loses `--name` and gains `--create`, `--delete` and `--rename`.

On the platform, the control plane's decision that made the root module's name the Project's `logicalId` is completed: the display-name fallback it kept for older Projects goes.

## Delivery order

Each part ships on its own.

| Part | What | Where |
| --- | --- | --- |
| 1 | Find the Project by `logicalId` only; `--create`; Console creates the Project at connect; the backfill. No change to how modules are written. | Console and backfill first, then Composer. Linear project "Deployment identity". |
| 2 | `id` on every node; `name` no longer gives identity; `--name` removed. Console generates the setup pull request's module file and reads the app name from a repository's own module file; both switch to `id`. One release, because it breaks every module. | Composer, then Console. |
| 3 | Questions before a database or bucket is deleted; `--delete` and `--rename`. | Composer. |
| 4 | Scoped CI tokens, then answering questions in Console. | Platform. |

## Open questions

1. **Does a node keep `name` as a Console label?** If it did, `name` would set the row's display name and nothing else, and leaving it out would leave the display name alone, so a rename done in Console would survive. Recommendation: no. Every platform name stays the node's address, as it is today. A separate label would be a second name for the node, and relabelling is already harmless once `id` alone carries identity.
2. **How does a Project with no `logicalId` and no connected repository get one?** The backfill has nothing to copy. Console could let a user set it by hand.
3. **Can renaming the root keep its Project?** `--rename shop:storefront` would need the platform to change a Project's `logicalId`. The Management API's Project update accepts only the name and settings today. Until it accepts `logicalId`, changing the root's `id` means a new Project with `--create`.

## Alternatives considered

- **Check the GitHub repository id inside Composer.** Makes Composer depend on GitHub, and re-checks at deploy time what the platform already decided when the repository was connected.
- **Have CI's token exchange return the app name, and the deploy action pass `--name`.** Locks CI to its Project, but the identity disappears from the repository: a person reading the module file cannot tell which Project it deploys to, and a local deploy and a CI deploy of the same file can reach different Projects.
- **A platform-generated root identity**, either an opaque id or a readable name with a random suffix. An opaque id in user code breaks when the Project is deleted or the repository is forked. A random suffix invites someone to "tidy" it, which creates a new Project.
- **A `logicalId` field on each node** holding just that node's segment. The platform `logicalId` is the full address, so the same word would mean two different strings.
- **Default the `id` from `name`.** Brings back the problem one level down: a label edit changes identity again.
- **CI passes `--create` on every deploy.** The flag would then mean nothing in CI. And the generated workflow would only work with Composer versions that accept `--create`, so every connected repository would have to upgrade before its workflow changed.
- **Keep the display-name fallback, with a warning.** The fallback is what lets a rename adopt an unrelated Project. The backfill removes the need for it.
- **Consent written into the code**, such as rename declarations written by the author or Terraform's `moved` blocks. The ORM prototyped and rejected this: once the change has happened, the code still describes a system that no longer exists, when only the command making the change ever needed the information. The rename declarations Composer generates for its own address-format migration are not consent: the author never writes them, and they describe Composer's internal names.
- **A committed consent file tied to a plan hash.** The plan differs per environment, so a consent for production would block every preview deploy on the branch.
- **Ask about services too.** Deleting a service loses no data, so a question would be noise; the plan output lists it instead.
