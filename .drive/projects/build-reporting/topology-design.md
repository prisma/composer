# Design: the platform persists the application topology

**The decision:** the Prisma platform stores each Branch's full application graph — every module, service, and resource, their ports, and every edge between ports, including module-boundary forwarding — as three generic record types under the Branch. Composer submits the graph as one atomic replace-set per deploy, after the Branch exists and before the apply starts. The payload contains no platform ids: the config address is the only identity, and the platform joins topology nodes to its own typed resource rows at read time. Build Jobs (the run journal) and the topology (the declared shape) are separate models that never couple.

Settled 2026-08-13 between Will (who implements the platform side) and the Composer side. **The canonical handoff copy lives in pdp-control-plane at `projects/branch-topology/spec.md` ([PR #4892](https://github.com/prisma/pdp-control-plane/pull/4892))**; this is the Composer-side mirror, kept for the Composer work items below. Alternatives considered are at the end; read them last.

## Vocabulary

Terms this document uses that a reader new to either codebase needs:

| Term | Meaning |
| --- | --- |
| **Composer** | Prisma's application-definition tool ([prisma/composer](https://github.com/prisma/composer)). A TypeScript program declares the whole application — services, databases, wiring — and `prisma-composer deploy` deploys it through the platform's public API. Per pdp ADR-009, it is *the* way apps are described and deployed. |
| **The graph** | Composer's in-memory model of the application, produced by its Load step. Nodes are **modules** (composites that nest), **services** (the user's code), and **resources** (managed infrastructure). Every node has typed input/output **ports**; every wiring is an edge between two ports. See composer `docs/design/03-domain-model/domain-map.md`. |
| **Config address** | A node's hierarchical identity, parent ids joined with `.` — `shop.auth.api`. Assigned in the config; carried between branches by git. Per the platform resource-model proposal, the config address *is* cross-branch identity: platform ids are stable only within a branch. |
| **Typed rows** | The platform's existing per-resource tables under a Branch: Service (today `App`/`ComputeService`), Database, Bucket, and their children. These record materialised reality and are created by Composer's provisioning during the apply, independently of this design. |
| **Build Job** | The platform's workspace-scoped journal of one deploy run: who ran it, how far it got, how it ended. Written by Composer's reporter (shipped in composer PR #227). Deliberately *not* where topology lives. |
| **Operation state store** | The Alchemy deploy-state the platform already hosts per Branch (`/v1/projects/{p}/branches/{b}/alchemy-state`). Composer's engine-level bookkeeping; opaque to the platform; contains secrets. The topology records are its user-legible sibling, not a replacement. |
| **The deploy lease** | The per-(stack, stage) lock a Composer deploy holds for its duration. Already serialises concurrent deploys to one Branch. |

## The data model

Three tables under Branch. All rows for a Branch are written together and replaced together (see The write protocol).

```
TopologyNode
  branchId      fk Branch
  address       text        — full config address, e.g. 'shop.auth.api'
  kind          enum        — module | service | resource
  type          text | null — extension vocabulary ('compute', 'postgres', 's3',
                              'prisma-next', …); null for modules, which have no
                              extension type. Opaque to the platform.
  unique (branchId, address)

TopologyPort
  branchId      fk Branch
  address       text        — the owning node's address
  direction     enum        — in | out
  name          text        — the port name; '$out' is reserved (see below)
  contractKind  text | null — e.g. 'rpc', 'http', 'postgres', 'prisma-next'. Opaque.
  contractHash  text | null — content hash for data contracts. Opaque.
  unique (branchId, address, direction, name)

TopologyEdge
  branchId      fk Branch
  fromAddress   text
  fromDirection enum        — in | out   (see "endpoints carry direction")
  fromPort      text
  toAddress     text
  toDirection   enum
  toPort        text
  family        enum        — communication | data
  style         text | null — e.g. 'request-response', 'stream'. Opaque.
  unique (branchId, toAddress, toDirection, toPort)
```

Rules that remove the ambiguity an implementer would otherwise hit:

- **Containment is the address.** `shop.auth.api` is inside `shop.auth` is inside `shop`. No parent column exists or is needed.
- **Endpoints carry direction.** A port is identified by `(address, direction, name)`, not by name alone — a module may legally have an input `db` *and* an output `db`. Every edge endpoint therefore names its direction.
- **`$out` names a resource's anonymous output.** Composer's model gives a resource one unnamed output (a consumer wires "the resource", not a named port of it). The persisted representation names it `$out` so every edge endpoint is a complete `(address, direction, name)` triple. `$out` is reserved: Composer rejects it as a user-declared port name.
- **One edge per consumer endpoint.** Every `to` endpoint — a service's input slot, a module's boundary input port, a module's boundary output port — is fed by exactly one edge. That is the uniqueness constraint, and it is what makes the flatten algorithm (below) deterministic.
- **Module forwarding is ordinary edges.** No separate record type. An input flowing down is an edge from the module's boundary `in` port to a child's `in` slot. An output flowing up is an edge from a child's `out` port to the module's boundary `out` port. A pass-through is an edge from a module's own `in` port to its own `out` port.
- **The topology is current-state only.** One graph per Branch, replaced on every deploy. There is no topology history; the history of *runs* is the Build Job's business, and the history of *artifacts* is the Version's.

### Worked example

Config: root module `shop` provisions a Postgres resource `catalog-db`, a module `auth` (boundary: input `db`, output `verify`) whose body provisions service `api`, and a service `web` wired to both.

Nodes:

| address | kind | type |
| --- | --- | --- |
| `shop` | module | — |
| `shop.catalog-db` | resource | `postgres` |
| `shop.auth` | module | — |
| `shop.auth.api` | service | `compute` |
| `shop.web` | service | `compute` |

Ports (contract columns elided):

| address | direction | name |
| --- | --- | --- |
| `shop.catalog-db` | out | `$out` |
| `shop.auth` | in | `db` |
| `shop.auth` | out | `verify` |
| `shop.auth.api` | in | `db` |
| `shop.auth.api` | out | `verify` |
| `shop.web` | in | `db` |
| `shop.web` | in | `verify` |

Edges:

| from | to | meaning |
| --- | --- | --- |
| `shop.catalog-db` out `$out` | `shop.web` in `db` | sibling wiring |
| `shop.catalog-db` out `$out` | `shop.auth` in `db` | enclosing scope feeds the module boundary |
| `shop.auth` in `db` | `shop.auth.api` in `db` | boundary input flows down |
| `shop.auth.api` out `verify` | `shop.auth` out `verify` | child output flows up |
| `shop.auth` out `verify` | `shop.web` in `verify` | consumer wires the module's output |

### The flattened view is derived, never stored

To resolve a consumer endpoint to its concrete producer: follow the unique edge feeding it; while the resulting `from` endpoint is a **module** port (either direction), follow the unique edge feeding *that* port; stop at a service or resource port. In the example, `shop.web` in `verify` resolves through `shop.auth` out `verify` to `shop.auth.api` out `verify`.

Storing the flattened form instead was rejected (see Alternatives): reconstructing the authored form from it is lossy when a module exposes one inner port under two names. The authored form is the information; the flat view is a query.

### What is deliberately not in the topology

- **Params, input bindings, secrets.** Configuration is not a node (composer domain map). Values never appear in topology records.
- **External services the user does not provision** (a Neon database, a third-party API). They are not in Composer's graph — the model's rule is "provision it or wrap it to bring it into the graph" — so they are not persisted. The governing principle: **if it's in the graph, persist it; the graph decides, not this schema.** The moment a user wraps an external in a Resource, it persists like anything else with a `type` the platform doesn't recognise, which is fine.
- **Public URLs / ingress.** Where a service is reachable is a deploy-time fact recorded on the typed Service/Version rows, not a graph edge.
- **Platform ids.** See Reads and joins.

## The write protocol

One submission per deploy run, replacing the Branch's entire topology:

```
PUT /v1/projects/{projectId}/branches/{branchId}/topology
Authorization: Bearer <workspace token>
{ nodes: [...], ports: [...], edges: [...] }
```

- **Atomic replace.** The platform swaps the Branch's full set of all three record types in one transaction. No merging, no diffing, no partial writes. An empty graph is a valid submission and empties the topology.
- **When: after the Branch exists, before the apply starts.** The precise position in Composer's deploy pipeline: Load (graph now fully known) → begin the Build Job → resolve containers (Project/Branch now exist — the write needs the Branch row) → **submit the topology** → preflight → write the stack file → apply. Submitting before the apply is deliberate: a run that dies mid-apply has still recorded what it was deploying, and the declared-vs-materialised comparison (below) stays honest for partial failures.
- **Failure must not fail the deploy.** Like all reporting, the submission is observability: on any error Composer warns and continues. The platform keeps the previous topology.
- **Concurrency.** The deploy lease already serialises deploys per (stack, stage); the platform does not need its own topology-level locking beyond the replace transaction.
- **Validation.** The platform validates shape only (address syntax, endpoint uniqueness, edges referencing submitted ports). It never validates `type`, `contractKind`, `contractHash`, or `style` — extension vocabulary is opaque by design, so new node kinds require no platform change.
- **Deletion.** Topology rows live and die with the Branch. Destroying a stage's Branch removes its topology by containment; no separate cleanup.

## Reads and joins

- `GET /v1/projects/{p}/branches/{b}/topology` returns the stored (authored) graph. A flattened view can be an additive query parameter later.
- **Joining to typed rows.** A topology node materialises as a typed row when the apply succeeds: `kind: service` → Service, `type: postgres` → Database, `type: s3` → Bucket. The join key is the node's **`logicalName`**: a nullable column on each joinable table holding the declaring node's full topology address, verbatim (`shop.auth.api`) — the row stores exactly what the topology stores, and the join is string equality. Composer's provisioning fills it (see Division of work). A row with a null `logicalName` (created before this lands, or created outside Composer) simply joins to nothing, which renders the same as "declared, not created" — honest and harmless.

  The naming, settled 2026-08-13: the platform's entities carry three distinct identifiers. `id` — the physical, platform-minted instance id, stable within a branch. `logicalName` — the declared identity in the config's logical namespace, the same namespace the topology maps; identical logical names pin the config declaration, the topology node, and the typed row together within a branch, and identify "the same" entity across branches. `displayName` — free presentation, no semantics. Project's `slug` (pdp ADR-011) is the first shipped instance of `logicalName` — the root node's address — and should converge on the same field name. Renaming a `logicalName` names a *different* entity; the rename affordance (a Terraform `moved`-block equivalent, reserved in the platform resource-model proposal) is the mechanism that will make "same entity, new name" sayable.
- **Drift is a query, not a stored fact.** Declared-but-not-created = topology nodes whose join finds no row. Created-but-no-longer-declared = typed rows whose address is absent from the topology (an honest state between a config removing a service and its teardown). The Build Job for the run explains *why* either state exists.

## Requirements this design satisfies

| # | Requirement | Satisfied by |
| --- | --- | --- |
| R1 | The Console can draw the whole application — modules, nesting, wiring — for any Branch, without the platform understanding Composer's vocabulary. | Full-fidelity Node/Port/Edge records; opaque `type`/contract fields; containment in addresses. |
| R2 | Cross-branch statements ("this service on every branch") are well-defined. | The config address is the only identity in the payload; same key ⇒ same logical thing, per the resource-model proposal. |
| R3 | Partial and failed deploys are legible: what was *meant* vs what *exists* vs what *happened*. | Three truths in three homes — topology (declared, written pre-apply), typed rows (materialised, converge per-resource), Build Job (the run). Drift is the join between the first two. |
| R4 | The GitHub Action needs no file passed out of Composer to build its PR comment. | Everything it needs is platform-readable: outcome from the Build Job, shape from the topology, URLs from Versions. Composer's `--report` file becomes transitional. |
| R5 | A run that crashes mid-apply still recorded what it was deploying. | The pre-apply write. |
| R6 | No secret material reaches these records. | Params/bindings/secrets excluded by rule; contracts are kinds and hashes only. |
| R7 | Structure is never coupled to runs. | Topology under Branch; journal under Workspace; a Build Job at most *explains* a drift state, never stores shape. |

## Division of work

**Platform (Will):**

1. The three tables and the `PUT`/`GET` endpoints per The write protocol, workspace-token authorised like the builds surface.
2. `logicalName` columns on Service, Database, Bucket, accepted on their create APIs — the per-resource continuation of ADR-011's Project slug. This is the identity track's model change; the topology tables themselves touch no existing model.
3. Console surfaces reading the topology and the drift join.
4. From the resource-model proposal, adjacent but separate: the Deployment→Version rename, Build Job naming.

**Composer:**

1. **Keep the authored graph through Load.** Load currently dereferences module boundaries and discards the traversal; the emitted `Graph` gains the authored ports and edges alongside the flat view downstream consumers keep. Additive change in `packages/0-framework/1-core/core/src/load-module.ts` + `graph-types.ts`. Shape approved 2026-08-13.
2. **The topology submission** at the pipeline position given above, through the same extension seam as the build reporter (`ExtensionDescriptor`), against the new endpoint. Best-effort like all reporting.
3. **Stamp `logicalName`** — the node's full topology address — on the typed rows its providers create, once the platform accepts it.
4. **Retire `--report`** once the Action reads the platform (R4).
5. Reject `$out` as a user port name.

## Alternatives considered

- **Topology as a JSON artifact** (Composer's `--report` file, or a blob column): not queryable, not joinable, invisible to the Console; a versioned-blob contract drifts. Rejected in the discussion that started this design.
- **Topology coupled to Build** (provenance rows as the shape): couples structure to runs; a branch's shape would only be readable through its latest run. Build is a journal, full stop.
- **A single flattened edge list:** drops module structure, boundary forwarding, and connection semantics — not the graph, a shadow of it.
- **Store flattened edges + forwarding as auxiliary records:** lossy — a module exposing one inner port under two output names cannot be reconstructed. The authored form is canonical; flat is derived.
- **Platform ids in the payload** (submit after materialisation, carry `resourceRef`): forces the write to the end of the run, losing R5, and builds a second identity system the config address already provides. Join-by-key at read replaced it.
- **Update topology only on fully successful deploys** ("last known good"): the typed rows move during a failed apply regardless, so a frozen topology would disagree with the materialised rows the Console also shows. The pre-apply replace plus drift-as-a-query is the honest version.
- **Per-link failure outcomes on Build Resources** (and re-keying links by config address): considered while the topology didn't exist; duplicative now — run-level failure lives on the Build row, per-node "declared but not created" falls out of the drift join. Today's id-keyed, success-only Build Resource shape stays.

## Left open, deliberately

- The rename affordance for config-key identity (a `moved`-block equivalent) — named in the resource-model proposal, not designed here.
- Database Versions — reserved concept in the proposal, future.
- A flattened-view query parameter on the GET — additive whenever a consumer wants it.
