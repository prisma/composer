# ADR-0006: Every node is named; the root's name names the application

## Decision

Every node — module, service, or resource — carries an explicit,
human-readable name, given at authoring. When a node is deployed as the root,
its name becomes the application's name (on Prisma Cloud: the Project name).
`prisma-compose deploy --name` overrides it for a single run. Nothing derives a
name from a `package.json` or a directory.

## Reasoning

Compare two versions of the same deploy log line:

```
lowering postgres         # the node's type
lowering invoices-db      # the node's name
```

A module with three Postgres resources produces three identical lines of the
first kind and three self-describing lines of the second. That contrast is
the first job names do: **diagnostics**. Every node already has an identity —
its deploy address, the graph-position identifier a module assigns at
`provision`, which drives config namespacing and provisioning-resource ids —
but addresses are positional and mechanical. A human-chosen name on every
node makes every log line, progress message, and error self-describing
without the reader reconstructing graph positions in their head.

The root's name does a second, sharper job: it names the **application**. On
Prisma Cloud it becomes the Project — the container everything else is
provisioned into — which makes it a lifecycle boundary: changing it means
"destroy this infrastructure and create new infrastructure". Anything with
those semantics must be pinned deliberately in code. Deriving it from a
`package.json` name or a directory would couple an
infrastructure-replacement trigger to identifiers people rename freely, for
no gain beyond zero-config convenience — and an accidental
infrastructure-replacement is far too expensive a failure for that
convenience to buy.

The `--name` flag exists as the explicit override because shared
environments genuinely need it: an ephemeral end-to-end run deploys the same
app under a per-run name so it can never collide with — or destroy — a
standing deployment in the same workspace.

One nuance at the core layer: a dependency end constructed by an authoring
surface with no room for a name argument (e.g. `rpc(contract)`, which takes
only the contract) defaults its name to the connection's type. Pack factories
that take an options object (`http({ name })`, `postgres({ name, … })`)
require the explicit name.

## Consequences

- Node factories require a name; authoring is slightly more verbose and
  considerably more debuggable.
- Only the root's name has provisioning semantics; every other node's name is
  diagnostic. Identity remains the deploy address.
- Renaming a root is a destructive operation. The documentation says so; a
  guard in the tooling that detects an about-to-be-replaced application would
  strengthen it further.
- There is no name inference anywhere: a root without a name (and no
  `--name`) is a deploy-time error, not a silently derived default.

## Alternatives considered

- **Defaulting the application name from `package.json`** — rejected: couples
  a destroy-and-recreate lifecycle boundary to a field with unrelated churn.
- **Names only at the root** — rejected: leaves every non-root log line and
  error naming nodes by type string and address alone, which is exactly the
  unreadable case the grounding example shows.

## Related

- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) —
  how the root is determined.
- [`../10-domains/core-model.md`](../10-domains/core-model.md) — deploy
  addresses and node identity.
