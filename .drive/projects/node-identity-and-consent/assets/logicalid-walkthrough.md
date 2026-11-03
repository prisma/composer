# Walkthrough: `logicalId` and `name` on every node

A working note for the design discussion. Not a spec.

## 1. The system we use throughout

A small shop. One root module, a Postgres database, a web service, an API
service, and a reusable auth module that owns its own database and service.

```
store                         root module → Project
├── catalog                   postgres    → Database
├── web                       compute     → service
├── api                       compute     → service
└── auth                      module      (no row)
    ├── database              postgres    → Database   address auth.database
    └── service               compute     → service    address auth.service
```

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
| `catalog` → `catalogue` | fix spelling | next deploy deletes the `catalog` Database and creates an empty `catalogue` |
| `store` → `storefront` | nicer name | next deploy creates a second Project; `store` is left behind with its data |
| `store` → `billing` (another repo's project in the workspace) | copy-paste, or a "rename" | next deploy reconciles into the `billing` Project and overwrites its production stage |

The third row is Søren's case. The first two are the same defect.

## 3. Proposed: two fields on every node

Every node has `logicalId` (identity, required) and `name` (label, optional).
Only `logicalId` reaches the platform row's `logicalId` and the topology.
`name` reaches the row's display name and nothing else. Omitting `name`
means Composer does not manage the label.

```ts
export default module({ logicalId: 'store', name: 'Store' }, ({ provision }) => {
  const catalog = provision(postgres({ logicalId: 'catalog', name: 'Catalog', contract, config }));
  const auth = provision(authModule, { logicalId: 'auth', secrets: { signingKey: envSecret('AUTH_SIGNING_SECRET') } });
  provision(web, { logicalId: 'web', name: 'Web', deps: { db: catalog, auth: auth.rpc } });
  provision(api, { logicalId: 'api', deps: { db: catalog } });
});
```

The address is still the path of `logicalId`s: `auth.database`. Nothing
else changes in the model. Local dev, state keys, Alchemy naming, and the
topology payload all keyed off the address already.

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
The experience should make the takeover visible before it is irreversible:

```
Project "billing" (proj_…) exists and holds a production deploy from
another source. Continue? (--yes)
```

Whether Composer asks, or just logs, is a separate decision. The point is
that the author typed the other project's identity on purpose.

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

`logicalId: 'catalog'` → `'catalogue'` on the database. Composer plans to
delete `catalog` and create `catalogue`. Today that is silent. With the
field explicit, the plan output should name the consequence:

```
~ catalog (Database): logicalId changed → delete "catalog", create "catalogue".
  Data in "catalog" will be lost. Use `name` to change the label instead.
```

That message is only possible because the two fields exist: Composer can
tell a label edit from an identity edit.

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

## 7. Open points this note surfaces

1. Which shape for the root value: 4a is recommended. 4b and 4c are
   rejected above.
2. Whether a root `logicalId` change that lands on an existing Project with
   deploys from another source should warn, confirm, or just proceed (5b).
3. The plan output for identity changes on children (5e) is a separate,
   valuable slice.
4. `--name` on the CLI today overrides the root's single string. With two
   fields it should become a `logicalId` override, or be removed. The
   generated workflow does not use it.
