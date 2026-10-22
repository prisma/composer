# Node addressing — design notes

Decisions from the design discussion with Will, 2026-10-16 to 2026-10-22. Each has its reason and the alternatives rejected.

## 1. A node's address is fully qualified, and it is the node's only identity

The address is the path of provision IDs starting at the root: `shop`, `shop.catalog`, `shop.auth.api`. The root's address is the app name. The platform `logicalId` of a node's row, and of its node in the application topology, is that address, byte for byte.

**Why.** Today children leave the app name out (`auth.api`), so a reference to a node needs a second piece of context to say which app. With the app name in the address, one string names a node everywhere: in the CLI, in errors, in logs, on the platform. The definition has no special case for the root. If a Branch ever holds more than one app, which the platform topology spec deliberately allows, short addresses would collide and fully qualified ones do not.

**Assumes.** Addresses stay unique within a graph. Provision IDs below the root stay letters and digits only.

**Rejected.**
- Keep children unqualified and resolve the app from context (the linked project, the directory). Needs a second input for every reference.
- Two terms, a full "address" and a shorter "path" for code and internal names. Will rejected any second form of identity.

## 2. Alchemy resource IDs are built from the address with dots

A node's main resource uses the address itself (`shop.catalog`). Its other pieces add a role (`shop.catalog.conn`, `shop.api.deploy`). Today they are `catalog-db`, `catalog-conn`, `api-svc`.

**Why.** The `logicalId` names a node; a resource ID names one of the pieces the node becomes. They do the same job at different sizes, so they should read the same way. There is no value in telling them apart by their characters, which is the only reason `-` was used.

**Why it cannot collide.** Every address is either a module, which has children but no Alchemy resources, or a service or resource, which has resources but no children. So `X.role` is never also a node's address.

**Rejected.** Keep `-` suffixes so a resource ID can be recognised on sight. It only guarded against an old bug where upstream Alchemy wrote its resource ID as the `logicalId`.

## 3. Environment variable keys are built from the full address

`COMPOSER_` plus the address segments, upper-cased, with `-` replaced by `_`: `my-shop.api` gives `COMPOSER_MY_SHOP_API_...`.

**Why.** App names may contain `-`, which is not valid in a POSIX variable name. Replacing it cannot cause a collision, because one app has one root name, and below the root segments are letters and digits only.

## 4. `serviceOrigin` takes the fully qualified address

`serviceOrigin('auth-example.api')`.

**Why.** One form of address everywhere. If the deployed app name differs from the one in the code (`--name`), the deploy fails at Load with an unknown address. That is a loud, data-safe failure the author fixes in one line.

**Rejected.** Resolve the string relative to the module the call is written in. That is a second way to write an address.

## 5. Existing deployments migrate automatically on their next deploy

Every Alchemy resource Composer declares carries a rename declaration from its old ID, which Composer computes from the address: the address without the app name, then `-` and the role. Upstream Alchemy (`2.0.0-beta.83`, `Rename.ts`) moves the state entry instead of deleting and recreating. The `logicalId` change is an in-place update in upstream Alchemy: it sets the field to null, then to the new value, as the Management API requires.

**Why.** Without it, the first deploy after upgrading would create an empty database, delete the old one with its data, regenerate secrets and rotate RPC keys.

**Assumes, to verify first.**
- A rename declaration whose old ID is not in the state, on a new stage, is a no-op.
- A deploy that fails partway through the renames can be run again and finishes them.
- Alchemy and the platform's hosted state accept dots in resource IDs. The ID appears in the state URL path.

**Accepted.** An older Composer deploying a stage after it migrated deletes and recreates resources. Will: not a concern.

**Local dev.** The per-directory record of emulator instances is keyed by address. Composer rewrites its keys on the first `prisma dev` after upgrading, so local databases keep their data.

## 6. Deploy's entry file lives in the config

`composer({ entry: './module.ts', extensions, state })` in `prisma.config.ts`, overridable with `--entry <path>`. The positional entry argument is removed from `deploy` and `dev`.

**Why.** It is an input to the tool, like the ORM section's schema path. It is not an application fact, which stay in code. It also stops every command needing the entry, and stops a subcommand of `deploy` from being mistaken for a file name.

**Changes in the recorded design.** The deploy-from-the-root-node decision says the config carries "no app reference"; the config-section decision lists the allowed fields; the commands decision gives the shape `prisma deploy <entry>`. Each is amended.

## 7. Platform commands accept a node address as their subject

`prisma service logs @pr-42:shop.api`, `prisma postgres delete @shop.catalog --confirm …`. The part before `:` is the stage. With no stage, the address means production. The command finds the row by `logicalId`, then does exactly what it does when given an ID. It never changes the stored topology or the deploy state; the next deploy recreates anything deleted this way.

**Why.** Administering Composer apps through the platform commands needs no second set of commands. The address is positional because the CLI's command principles say a command's subject is positional and flags never name it. Production when no stage is given matches both `prisma deploy` without `--stage` and platform commands without `--branch`.

**API.** No change needed to resolve addresses: the Project, service, database and bucket list endpoints already filter by `logicalId`, and the resource lists accept `branchGitName`. PRO-225 makes the API reject `:` in Branch names, so the address can be split at the first `:`.

**Rejected.** An explicit `--node` flag: flags never name a command's subject.

## 8. `prisma deploy list` lists what is deployed on a stage

`prisma deploy list [--stage <name>]` prints each node's address, kind, platform ID and URL, from the stage's stored topology joined to its rows by `logicalId`.

**Why.** Without it, users and agents can only learn addresses by reading code. `list`, not `show`, because it displays a collection. The stage is a flag because it narrows the scope; it is not the subject.

## 9. Teardown is done with platform commands

- Remove an app and every environment: `prisma project delete <id> --confirm <id>`. It already works while compute is live: the platform soft-deletes the services and a scheduled job deletes their running versions.
- Remove one stage: `prisma branch delete <name> --confirm <name>`. New. The Management API gets a cascading Branch delete that removes the Branch's services, databases and buckets first; today it refuses while they exist. The cascade belongs in the API, not the CLI, so scripts and agents calling the API get it too and it cannot stop halfway.
- Remove one instance: a platform delete with a node address.

**Why.** An unattended agent tried three times to tear down a Composer app and wrote its own scripts against the `destroy` operation. Everything it needed is `project delete` plus documentation. Our CI's workaround for a 409 on live compute is out of date.

**Rejected.** A Composer `destroy` command (a second destructive verb next to `delete`), and `deploy delete` for subtrees (see `deferred.md`).
