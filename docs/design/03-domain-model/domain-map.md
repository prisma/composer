# Domain map

The conceptual map of MakerKit's **authoring plane** — the things a developer
models and how they relate. For how these lower to Alchemy and Prisma Cloud, see
`layering.md`; for definitions, see `glossary.md`.

(MakerKit's *own* internal architecture — its control/execution-plane contexts,
emitter, runtime — is a separate concern for the architecture phase, not this
map.)

```mermaid
flowchart TB
  Topology["Topology — the emitted artifact"]
  Hex["Hex (Subsystem)"]
  Service["Service — your code (compute)"]
  Resource["Resource — managed lifecycle (Postgres + BYO)"]
  Config["Configuration — per-env, not a node"]
  Input["Input — requires"]
  Output["Output — provides"]
  Conn["Connection"]
  DC["Data Contract — Prisma Next"]

  Topology -->|contains| Hex
  Topology -->|contains| Resource
  Topology -->|contains| Conn

  Hex -->|wraps| Service
  Hex -->|wraps or uses| Resource
  Hex -->|nests| Hex
  Hex -->|has| Input
  Hex -->|has| Output
  Resource -->|has| Output

  Conn -->|from| Output
  Conn -->|to| Input

  Conn -.->|communication style| CS["request/response · stream"]
  Conn -.->|data method| DM["TCP · HTTP"]
  Input -.->|data: must satisfy| DC
  Output -.->|data: offers hashes of| DC

  Service -.->|configured by| Config
  Resource -.->|configured by| Config
```

## How to read it

- **A Hex wraps Services and Resources** and is reachable from the outside *only*
  through its Inputs and Outputs. That boundary is what makes the topology
  truthful — every cross-Hex dependency is an edge.
- **Nesting isn't a special case.** A Hex behaves like a Service — stateless, with
  typed I/O — so a nested Hex is wired exactly as a Service is. A wrapped node's
  Inputs/Outputs connect to the parent Hex's boundary or to a sibling inside the
  Hex; it reaches outside only through the parent's Inputs/Outputs.
- **Every node — Hex or Resource — can have Inputs and Outputs.** A connection
  always wires an Output to an Input.
- **Every node carries a managed lifecycle** — Services (your code) and Resources
  (managed dependencies). That's what lets the whole topology be recreated in a new
  environment and reproduced in the local emulator.
- **Configuration is not a node.** Keys, URLs, and secrets parameterise Services
  and Resources and are injected per environment. An external service you don't
  provision lives here — surfaced as a Service's **egress** (an outbound dependency
  plus its config), never an edge to a node. Provision it (a Resource) or wrap it
  in a Service to bring it into the graph.
- **Two families of connection:**
  - **communication** (Hex ↔ Hex, or public **ingress**) with a **style**:
    `request/response` or `stream`. The style is a property of the connection; no
    Resource sits "in" it.
  - **data** (Hex → Postgres Resource) with a **method** (`TCP` / `HTTP`) and a
    **Data Contract**. The Postgres exposes a **Data Output** (the contract hashes
    it satisfies); the Hex's **Data Input** requires a contract; the wire is valid
    iff the offered hashes satisfy it.
- **The Topology is the artifact.** MakerKit infers the graph from TypeScript and
  emits it.

## Dependency direction

The clean-architecture intent carries over: low-level Resources don't depend on
Hexes; Hexes depend on Resources and on each other's Outputs. Composition (the
wiring) is explicit and lives in the topology, not in ambient/global state.

## Open questions

- **Resource placement** — a Resource may be owned inside one Hex (private) or
  stand alone and be shared by several Hexes' Data Inputs. "One owner" is a
  convention, not an enforced rule (see `glossary.md` → Deferred).
- **Stream attributes** — since a stream is a connection *style* and never a
  Resource node, attributes like retention and consumer groups would live on the
  connection. Where exactly is TBD.
