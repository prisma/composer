# Purpose: what is MakerKit and why should I care?

MakerKit is a **TypeScript-first framework** for defining and running applications on the Prisma Platform.

It’s built for teams (and AI agents) who want to treat an application not as a pile of ad-hoc functions and configs, but as a **coherent graph** of executables and resources that can be:

- **inferred from code**
- **validated**
- **packaged into inspectable artifacts**
- **executed deterministically with explicit bindings**

## The core idea

**Define your app in TypeScript.**

In practice, you define **resources** (databases, streams, buckets, etc.) and **executables** (HTTP APIs, workers, subscribers, cron jobs) using a small set of `define*` functions. Those calls return *descriptors*: serializable declarations that MakerKit can inspect without “running” your app.

MakerKit uses descriptors in two modes:

- **Control-plane mode**: load descriptors, infer the **topology graph**, and emit stable artifacts (e.g. `makerkit.map.json`) for provisioning and orchestration.
- **Execution-plane mode**: run entrypoints with injected bindings (dependency injection), without relying on globals to locate provisioned services.

### A concrete example

Users don’t usually think “I’m creating descriptors.” They think: “I’m defining my app.”

That tends to look like defining things in modules and wiring dependencies by importing and passing them:

```ts
// db.ts
import { definePostgres } from "@prisma/makerkit";

export const db = definePostgres({ name: "main" });

// streams.ts
import { defineStream } from "@prisma/makerkit";

export const userEvents = defineStream<{ type: string; userId: string }>({
  name: "userEvents",
});

// api.ts
import { defineHttpApi } from "@prisma/makerkit";
import { db } from "./db";
import { userEvents } from "./streams";

export const api = defineHttpApi({
  name: "api",
  deps: { db, userEvents },
}).route("POST", "/users", async (ctx, req) => {
  // ctx.db and ctx.userEvents are injected dependencies.
  return new Response("ok");
});
```

From that single definition, MakerKit can infer a topology:

- **Nodes**: `db`, `userEvents`, `api`
- **Edges**: `api → db`, `api → userEvents`

## Why it matters (what MakerKit optimizes for)

- **Code-first topology (avoid config drift)**  
  You don’t maintain a parallel manifest as the source of truth. The topology and its artifacts are compiled from TypeScript descriptors, so the declared structure and the running structure can’t silently diverge.

- **A clear control/runtime split**  
  MakerKit is designed to answer two different questions with two different modes:
  - “What is this app?” (inspect, validate, emit artifacts)
  - “How do I run this app here?” (bind resources, satisfy graph, execute entrypoints)

- **Streaming-first defaults**  
  Realtime and streaming aren’t bolt-ons. The system is biased toward streams as the backbone primitive, with request/response and workflows built as adapters on top where needed.

- **Agent-friendly by construction**  
  Descriptors and artifacts are explicit and statically analyzable, making it easier for agents (and humans) to scaffold, refactor, and verify changes safely.

- **Inspectable integration contract**  
  The platform integration surface is a stable, diffable artifact (e.g. `makerkit.map.json`) instead of implicit runtime behavior.

## What MakerKit is (and is not)

- **MakerKit is**: a framework + tooling surface that helps define app topology and run entrypoints with injected dependencies.
- **MakerKit is not (yet)**: the entire Prisma Platform orchestration API; it should emit metadata/artifacts so orchestration can evolve independently.

## Where to go next

- Goals (high-level aims): `docs/design/00-purpose/goals.md`
- Broad design overview (longer, more detailed): `docs/design/10-domains/makerkit-overview.md`

