# Glossary (ubiquitous language)

The shared terms used across MakerKit's design docs. This is the **authoring
plane** vocabulary — what a developer writes and thinks in. For how these lower
to the provisioning and hosting planes, see `layering.md`.

## Core nouns

Every element MakerKit provisions carries a **managed lifecycle** — it can be
recreated in a fresh environment and stood up in the local emulator. Two kinds
carry that lifecycle: **Services** (your code) and **Resources** (managed
dependencies); **Hexes** group them into bounded contexts. Anything without a
lifecycle — an API key, an external URL — is **Configuration**, not a node.

### Hex (Subsystem)

The unit of composition: a **bounded context** that wraps some Services,
Resources, and other Hexes, exposes **Inputs** and **Outputs**, and is connected to
other Hexes only through them. A Hex runs **no code of its own** — its behaviour is
the composition of what it wraps.

A Hex **behaves like a Service**: stateless, reprovisionable, and equivalent to its
past incarnations, with typed Inputs and Outputs. That shared behaviour is what
makes nesting work — a nested Hex is wired exactly as a Service is. It stays a
distinct type, with composition behaviours a Service doesn't have.

- "Hex" is the working name; **Subsystem** is the literal fallback.
- A Hex is an *authoring/reasoning* unit. It is not a single deployed object — it
  lowers to a subgraph of hosting primitives (see `layering.md`).
- **Nesting.** A wrapped node's Inputs/Outputs connect either to the parent Hex's
  Inputs/Outputs or to a sibling (Service, Resource, or Hex) inside the same Hex; a
  wrapped node reaches outside the Hex only through the parent's boundary.

### Service

A **provisioned compute unit that runs your code** — an HTTP API, a web app, a
worker. The atomic *runnable*. Lowers to a compute unit on the chosen deployment
target — Prisma Compute on Prisma Cloud, or another target's equivalent (Alchemy
calls it a Platform).

### Resource

A **provisioned dependency with a managed lifecycle** — MakerKit, through a
provider, can create, update, and delete it. Its defining characteristic is the
**state** it holds: a database, a bucket, a cache. Surfaced as a typed
**capability** (via an Alchemy Layer): a Resource's Output provides it, a Hex's
Input requires one, and the wire is valid iff provided satisfies required.

The lifecycle can be implemented by cloud APIs *or* third-party/partner APIs, so a
provisioned third-party account is a Resource too — a Stripe product, a Tigris
bucket, a Prisma-brokered Mailchimp account. The test is whether something manages
its lifecycle, not whether it's first-party.

- **First-class**: Prisma **Postgres** (data, via Prisma Next contracts) —
  MakerKit-native treatment.
- **BYO**: any Alchemy resource (object storage, cache, queue, provisioned
  third-party) exposed through a capability Layer. The Hex depends on the
  capability, not the vendor — swap R2 for S3 by swapping the Layer.

Not Resources: **Compute** is what a Service lowers to (one per deployment target
— Prisma Compute on Prisma Cloud); a **Stream** is a connection style; a service
you call but don't provision is **Configuration**, not a Resource.

See `layering.md` → Resources: first-class vs BYO.

### Configuration

Per-environment values an element needs but that MakerKit does **not** provision —
API keys, connection URLs, secrets for an unmanaged external service. Configuration
is **not a node**: it parameterises Services and Resources, is injected at the
boundary (no-globals), and is supplied afresh per environment. This is where a
genuinely unmanaged external dependency lives — you hold a key to a shared account
nobody provisions. Lowers to Alchemy's `effect/Config` (secrets via
`Config.redacted`), bound to the running environment. To pull such a dependency
*into* the topology as a reproducible node, either provision it (making it a
Resource) or wrap it in a Service that exposes your domain interface.

### Topology

The graph of Hexes and Resources wired together through their Inputs and Outputs.
MakerKit infers it from TypeScript and emits it as a static artifact for the
platform to provision.

Every node in the topology has a managed lifecycle — which is exactly what lets the
whole graph be recreated in a fresh environment and reproduced in the local
emulator (see the [goals](../00-purpose/goals.md)). Anything without a lifecycle is
Configuration, not a node.

## Connections

A **connection** is an edge that wires one node's **Output** to another node's
**Input**. Every node — Hex or Resource — can have Inputs and Outputs. There are
two families of connection.

### Input

A connection point where a node **requires** something. Either a *communication*
Input (consumes another node's Output) or a *Data* Input (consumes a Resource's
Data Output).

### Output

A connection point where a node **provides** something. Communication Outputs are
served by Hexes; Data Outputs are served by Resources.

### Communication connection — style: request/response | stream

A Hex-to-Hex connection — or, at the boundary, public **ingress**. Its **style** is
a property of the connection:

- **request/response** — synchronous. Contract = the API/RPC signatures.
- **stream** — asynchronous, durable events. Contract = the payload schema.

The communication style is *not* mediated by a Resource; the underlying transport
(durable stream infra, etc.) is a lowering detail, never a modeled node.

### Data connection — method: TCP | HTTP

A Hex consuming a Postgres Resource.

- A **Data Input** (on a Hex) = a **connection method** (`TCP` — direct Postgres
  wire; `HTTP` — PostgREST-style) plus a **Data Contract** it must satisfy.
- A **Data Output** (on a Postgres Resource) = the set of **contract hashes** the
  Resource is provisioned (and verifiable) to satisfy.
- The wire is valid iff the Output's offered hashes satisfy the Input's contract.
- The concrete connection (URL) is injected when wired — never embedded in the Hex
  (no-globals).

### Ingress / Egress

**Ingress** = a request/response Output exposed to the public (e.g. the website) —
a real edge at the topology's public boundary. **Egress** = a Service's declared
**outbound dependency** on something outside the topology (an external URL/API).
Egress is *not* an edge to a node — the far end isn't in the graph; it's a property
of the Service plus the Configuration (URL + credentials) it carries. To represent
that external thing as a node, provision it (a Resource) or wrap it in a Service.

## Contracts

### Data Contract

A **Prisma Next** contract — a deterministic, hashable description of the schema
slice a Hex may access (identified by its `storageHash`). A Hex's Data Input
declares the contract it requires; this is also the per-Hex least-privilege scope.

### Aggregate Contract

When several Hexes share one Postgres, the Resource must satisfy the **aggregate**
of their contracts. Ownership overlap is **prohibited** (a Prisma Next concept).
The cloud can verify the live DB satisfies the aggregate via the marker/ledger.

## Planes & process

### Authoring / Provisioning / Hosting planes

The three layers MakerKit spans: what you write (MakerKit), how it's wired and
provisioned (Alchemy/Effect), what runs (Prisma Cloud). See `layering.md`.

### Lowering

The compilation from one plane to the next: authoring topology → provisioning
resource graph → hosting primitives. Analogous to Prisma Next lowering a contract
to a plan.

### Control plane / Execution plane

Two MakerKit modes. **Control plane**: import the topology, validate, build the
graph, emit the artifact, drive provisioning/inspection. **Execution plane**:
instantiate implementations, satisfy the graph, inject dependencies, run
entrypoints. Kept as separate import surfaces to avoid drift (and for
tree-shaking).

### Entrypoint

An addressable unit the platform can execute (by id/kind), defined by an artifact
reference plus its declared required Inputs. The execution-plane handle for a
Service.

## Deferred / open

- **Connection-method taxonomy** — only `TCP` and `HTTP` for now. "Pooled" is a
  URL param on TCP, not its own method; WebSocket and others are deferred until we
  work more examples.
- **Encapsulation as convention** — "one Hex owns a Data Resource" and "a Hex
  never exposes raw data to peers (front it behind communication)" are
  *conventions/policy* we may layer on, not enforced primitives.
- **Input/Output type set** — deliberate and curated, added consciously; not an
  open plugin surface, but not sealed forever either.

## Superseded terms

- **App** → use **Topology** (the wired graph) or **Hex** (a unit).
- **Descriptor** → an internal/substrate term; avoid in the authoring vocabulary
  (and note Prisma Next uses "Descriptor" for its own components).
- **Durable Stream as "the backbone"** → streams are *one of two* transports
  (alongside request/response), not the universal substrate. See the streaming
  reconciliation note in the decisions log.
