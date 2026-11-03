# Walkthrough: `logicalId` and `name` on every node

A working note from the design discussion. Not a spec. Where it differs from
[../design-notes.md](../design-notes.md), the design notes win.

## 1. The system we use throughout

A small shop. One root module, a Postgres database, a web service, an API
service, and a reusable auth module that owns its own database and service.

```
node           kind          platform row   address (= the row's logicalId)
store          root module   Project        store
├── catalog    postgres      Database       store.catalog
├── web        compute       service        store.web
├── api        compute       service        store.api
└── auth       module        (no row)       store.auth
    ├── database   postgres  Database       store.auth.database
    └── service    compute   service        store.auth.service
```

Addresses are full paths from the app name, as the decision record "a node's
address is its full path from the app name" requires.

## 2. Today

```ts
export default module('store', ({ provision }) => {
  const catalog = provision(postgres({ name: 'catalog', contract, config: './prisma.config.ts' }));
  const auth = provision(authModule, { secrets: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });
  provision(web, { deps: { db: catalog, auth: auth.rpc } });
  provision(api, { deps: { db: catalog } });
});
```

One string per node does three jobs: it is the identity (`logicalId` on the
platform row), the label (display name in Console), and the address other
nodes use. The three footguns, all caused by editing that one string:

| Edit | What the author meant | What happens |
| --- | --- | --- |
| `catalog` → `catalogue` | fix spelling | next deploy deletes the `store.catalog` Database and creates an empty `store.catalogue` |
| `store` → `storefront` | nicer name | next deploy creates a second Project; `store` is left behind with its data |
| `store` → `billing` (another repo's project in the workspace) | copy-paste, or a "rename" | next deploy reconciles into the `billing` Project and overwrites its production environment |

The third row is Søren's case. The first two are the same defect.

## 3. Proposed: two fields on every node

Every node has `logicalId` (identity, required) and `name` (label, optional).
Only `logicalId` reaches the platform row's `logicalId` and the topology.
`name` reaches the row's display name and nothing else. Omitting `name`
means Composer does not manage the label.

The fields go on the node's definition, not on the `provision()` call. The
`id` override on `provision()` stays for provisioning the same node twice, or
for a packaged module whose consumer needs a different address.

```ts
// web.ts
export default service({ logicalId: 'web', name: 'Web', … });
// api.ts
export default service({ logicalId: 'api', … });
// auth module, from a package
export default module({ logicalId: 'auth', … }, …);

// module.ts
export default module({ logicalId: 'store', name: 'Store' }, ({ provision }) => {
  const catalog = provision(postgres({ logicalId: 'catalog', name: 'Catalog', contract, config }));
  const auth = provision(authModule, { secrets: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });
  provision(web, { deps: { db: catalog, auth: auth.rpc } });
  provision(api, { deps: { db: catalog } });
});
```

The address is still built the same way: the root's value, then each
ancestor's, joined by dots (`store.auth.database`). Local dev, deploy state,
Alchemy resource IDs and the topology all key off the address already.

**Unsettled: what the field on a child holds.** The decision record "a node's
address is its full path from the app name" makes the full address the
platform `logicalId`. So for a child, the field written on the definition
(`'catalog'`) is one segment of the `logicalId`, not the `logicalId` itself
(`store.catalog`). Only on the root are the two the same. Whether the child's
field should still be called `logicalId`, or something that names the
segment, is open; see the spec's open questions.

Same three edits, re-run:

| Edit | What happens now |
| --- | --- |
| `name: 'Catalog'` → `'Catalogue'` | Console label changes. No structural change. |
| `name: 'Store'` → `'Storefront'` | Console label changes. Same Project. |
| `logicalId: 'store'` → `'billing'` | You changed the identity. Composer finds the `billing` Project and deploys into it. Deliberate. |

The label edits are safe. The identity edit is still possible, and still
destructive, but it no longer looks cosmetic. That is the whole fix.

## 4. What should the root's `logicalId` look like?

The Console connect flow writes the root into the setup PR. Three shapes it
could generate.

### 4a. A user-chosen slug, validated at connect (today's `moduleName`)

```ts
export default module({ logicalId: 'store', name: 'Store' }, …)
```

Console asks for a name, validates the slug format and uniqueness in the
workspace, and reserves it on the link. The user sees the same word in code,
in the Console URL, and in CLI output. Looks like something a human owns.

### 4b. An opaque platform id

```ts
export default module({ logicalId: 'proj_cm3xk9q2a0001', name: 'Store' }, …)
```

Unique by construction, no reservation step, no conflict check. But it reads
as a foreign key that fell into the user's code. It is exactly what ADR-011
rejected for committed config: when the Project is deleted, or the repo is
forked, deploys fail until someone edits a value they did not write and do
not understand.

### 4c. A generated readable slug with a suffix

```ts
export default module({ logicalId: 'store-7f2k', name: 'Store' }, …)
```

Unique without a conflict check, still readable. The suffix is the part
people will "tidy up". See 5c.

## 5. Why a user would change the root `logicalId`, and what it feels like

### 5a. Forking the repo to make a second, separate app

They copy the repo, want a new Project, and must change `logicalId`. With
4a they pick `store-eu`. The first deploy says:

```
No Project with logicalId "store-eu" in workspace wksp_…; creating it.
```

That is the right experience: a new identity, stated, and the system does
what it says. With 4b they have no idea what to type. They either delete
the field and get an error, or copy another project's id from the Console
URL, which is the Søren case by a different road.

### 5b. Moving the repo to an existing Project

They want this repo to take over the `billing` Project. They set
`logicalId: 'billing'`. The deploy finds that Project and reconciles into it.
Composer asks nothing for the switch itself: the author typed the other
project's identity on purpose, and Composer cannot tell a deliberate takeover
from a mistake without reading the platform's build history. Stopping the
mistake is the scoped CI token's job (D6).

The consent model still applies to what the reconcile would do inside
`billing`. Any database or bucket there that this repo's graph does not
declare would be deleted, so the deploy asks one question per subject, such as
`--delete billing.ledger`, and fails in CI until a human answers from a
laptop.

### 5c. "Tidying" a generated value

With 4c, someone sees `store-7f2k`, thinks the suffix is noise, and edits it
to `store`. The next deploy creates a new empty Project and production
stops. The error that would have to catch this is "the Project you were
deploying to has a different logicalId than your code," and Composer cannot
know that without a second identity source. Generated suffixes invite the
edit the field is meant to prevent. This is the argument for 4a.

### 5d. The honest rename

They want the Project to be called "Storefront" everywhere. With two fields
the answer is "change `name`." The URL slug in Console, if it shows the
`logicalId`, keeps saying `store`. That is the one place the model leaks: a
stable identity that is also user-visible will eventually look stale. The
same is true of every slug-based system (GitHub repo names, Vercel project
names) and users accept it.

### 5e. A child rename

`logicalId: 'catalog'` → `'catalogue'` on the database, so its address goes
from `store.catalog` to `store.catalogue`. Today the next deploy deletes the
old database and creates an empty one, silently. With the field explicit, the
deploy asks first, the way the ORM's migration commands do (D8):

```
store.catalog (Database) is no longer declared, and store.catalogue is new.
Its data would be lost. To change only the label, edit `name` instead.
→ Pass --rename store.catalog:store.catalogue to keep the database
→ Pass --delete store.catalog to delete it
```

Non-interactively, as in CI, the deploy fails with `CLI.CONSENT_REQUIRED` and
names both flags. The advice to edit `name` is only possible because the two
fields exist: Composer can tell a label edit from an identity edit.

## 6. Where the value comes from in each flow

| Flow | Who sets the root `logicalId` | Where it lives |
| --- | --- | --- |
| Console connect, setup PR | Console reserves it on the link, writes it into `module.mjs` | the repo |
| Repo with its own Composer config | the author already wrote it; Console reads it at connect and reserves it | the repo |
| Hand-written repo, service token, no link | the author | the repo |
| Composer-created children | the author | the repo |

In every row the value is in the repo. The link record on the platform is a
copy that lets Console validate uniqueness and attach the created Project.
Nothing is supplied at run time, so Composer stays unaware of GitHub.

The alternative, an environment variable from the deploy action, would make
the root's identity come from the platform at run time instead of from code.
It locks CI harder, but it makes the value invisible in the repo, so a
developer reading `module.mjs` cannot tell which Project it deploys to, and a
local deploy and a CI deploy of the same file can target different Projects.
That contradicts "the graph is Composer's image." Not recommended as the
primary path; the token scope is the platform's job (ADR-010).

## 7. How the points this note raised were settled

1. The root value is a hand-written slug that Console validates and reserves
   at connect (4a). It is never generated by the platform.
2. A root `logicalId` that lands on an existing Project proceeds; consent
   covers the data the reconcile would delete there (5b).
3. Identity changes on children are consent questions, answered by
   `--rename` or `--delete` (5e).
4. `--name` is removed.
