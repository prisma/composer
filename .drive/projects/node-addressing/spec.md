# Purpose

Let people and agents name any deployed part of a Composer app with one string, and administer it through the platform commands they already have. Today a node's identity leaves out the app name, removing an app or one of its environments takes a hand-written script, and nothing lists what is deployed.

# At a glance

```
$ prisma deploy list --stage pr-42
ADDRESS        KIND      PLATFORM ID   URL
shop           project   proj_123
shop.api       service   svc_456       https://…
shop.catalog   postgres  db_789

$ prisma service logs @pr-42:shop.api        # any platform command takes an address
$ prisma branch delete pr-42 --confirm pr-42 # removes the stage and everything on it
$ prisma project delete proj_123 --confirm proj_123   # removes the app and every stage
```

```ts
// prisma.config.ts
composer: composer({ entry: './module.ts', extensions: [...], state: prismaState() })
```

```
$ prisma deploy --stage pr-42     # entry from the config; --entry overrides it
```

Under the hood, a node's address, its platform `logicalId` and its Alchemy resource IDs all become the same fully qualified form (`shop.catalog`, `shop.catalog.conn`). Existing apps move over on their next deploy without losing data.

The decisions and their reasons are in [design-notes.md](design-notes.md).

# Non-goals

- A Composer teardown command, for the whole app or a subtree. Teardown uses platform commands. The subtree design is kept in `.drive/deferred.md`.
- Protecting a stage that has migrated from a later deploy by an older Composer.
- Deploying part of an app by pointing the entry at a submodule. The entry still names the whole application.
- Changing the Project's `logicalId`. It is already the app name.
- Changing how the programmatic `destroy` operation works. Docs stop recommending it for teardown.

# Place in the larger world

The work spans three repositories:

- **prisma/composer**: addresses, resource IDs, environment variable keys, the migration, the entry in the config, `deploy list`, the decision records and docs.
- **prisma/prisma-cli**: resolving `@stage:address` in platform commands, and `branch delete`. Composer's team does this work.
- **prisma/pdp-control-plane**: rejecting `:` in Branch names (PRO-225) and a cascading Branch delete in the Management API.

The platform treats `logicalId` as an opaque string and learns containment from explicit parent links, so it needs no change for the new format. Upstream Alchemy (`2.0.0-beta.83`) provides the rename declaration and updates a changed `logicalId` in place.

# Cross-cutting requirements

- **One form of node identity.** Every surface that names a node uses the fully qualified address: `logicalId`s, the topology, resource IDs, CLI input and output, errors, `serviceOrigin`, `dev url`.
- **No data loss when upgrading.** The first deploy of an existing app with the new Composer keeps its databases' rows, buckets' objects, generated secrets and RPC service keys. Local `prisma dev` keeps its databases.
- **Every new or changed command** follows the CLI's help standard, gives JSON with `--json`, exits non-zero on failure, and has an end-to-end test against the real Management API, as the `prisma` CLI repository requires.
- **Recorded decisions are updated before the code that depends on them merges.** Agents treat the design docs as binding.

# Transitional-shape constraints

- The address format, resource IDs, environment variable keys and the rename migration ship in one Composer release, so existing apps migrate once.
- Address resolution in platform commands may ship before the migration. It matches the `logicalId` exactly, so it works for any stage deployed by a Composer version that writes the format you type.
- `branch delete` in the CLI waits for the cascading delete in the API.

# Project DoD

- A test app deployed with the current Composer release, then redeployed with the new one, keeps its database rows, bucket objects, generated secrets and RPC keys. Its rows' `logicalId`s and its deploy state's resource IDs are in the new form.
- A new stage deployed from scratch with the new Composer works.
- The asks app's production deploy is upgraded the same way with its data intact, as the final production test.
- `prisma deploy list --stage <name>` lists every node, and `prisma service logs @<stage>:<address>` reaches the right service.
- `prisma branch delete <name> --confirm <name>` removes a stage while its services are running.
- An agent given only the docs can deploy an app, remove it with `prisma project delete`, and confirm with `prisma project list` that it is gone.
- The design records, principles, glossary and docs describe the new design, and none describe the old address format as current.

# Open questions

None blocking. The three upstream Alchemy behaviours in design note 5 are verified by the first slice before anything else is built.

# References

- [design-notes.md](design-notes.md)
- `docs/design/90-decisions/ADR-0051-a-nodes-address-is-its-logical-id-on-the-platform.md`: the identity decision this replaces.
- `docs/design/90-decisions/ADR-0003-deploy-derives-everything-from-the-root-node.md`, `ADR-0049-composers-configuration-is-the-composer-section-of-prisma-config.md`, `ADR-0050-composer-runs-as-prisma-deploy-and-prisma-dev.md`: amended for the entry in the config.
- pdp-control-plane `projects/branch-topology/spec.md`: the platform's topology and `logicalId` design.
- prisma-cli `docs/product/command-principles.md`: the rules for subjects, `list` and `delete`.
- PRO-225: reject `:` in Branch names.
