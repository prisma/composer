# Cloudflare platform → Prisma Compose takeaways (evolving)

This doc is explicitly **not** "research." It records what we currently believe Prisma Compose should emulate/adapt from the Cloudflare platform, and it is expected to change as the framework's design evolves.

Primary references: [Cloudflare Workers Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/), [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)

## Control-plane vs runtime split

**What Cloudflare does:** Wrangler (control plane) operates on config + code; it produces artifacts and metadata. The platform runs Workers (runtime) with injected bindings. Config never runs in the isolate.

**Takeaway for Prisma Compose:** Maintain a clear boundary. Control plane: load descriptors, validate, build topology, emit manifest + bundles. Runtime: receive bindings from platform, execute entrypoints. No control-plane code in the execution path.

## Artifacts and manifest

**What Cloudflare does:** Wrangler emits a bundle per Worker; config (or equivalent metadata) describes bindings, routes, cron. The platform consumes both.

**Takeaway for Prisma Compose:** Emit a stable manifest (`prisma-compose.map.json`) with entrypoints, required bindings, artifact references. Keep it generated from TypeScript descriptors, not hand-authored. Single deployment unit per entrypoint (or a coherent story for multi-entrypoint bundles).

## Explicit bindings

**What Cloudflare does:** Bindings are declared in config; `env` is the only way to access resources. No ambient globals. Permission is embedded in the binding.

**Takeaway for Prisma Compose:** Entrypoints declare required bindings; platform provides instances at execution time. Inject via DI, not env vars or globals. The framework's `requires` in the manifest plays the role of Cloudflare's binding blocks.

## Ingress / routing

**What Cloudflare does:** Routes map HTTP patterns to Workers. Cron and queues are additional ingress mechanisms. All are declared in config.

**Takeaway for Prisma Compose:** Model ingress as first-class. HTTP routes, cron, and stream/queue consumers should be explicit in the topology. The manifest should describe how traffic/events reach entrypoints.

## Observability

**What Cloudflare does:** `wrangler tail` for logs; dashboard for metrics, errors, invocations. Structured at the boundary.

**Takeaway for Prisma Compose:** Define observability boundaries (logs, metrics, errors) at entrypoint execution. Platform may add its own; the framework should not block it.

## What we likely need to adapt

- **Config-first vs code-first**: Cloudflare is config-centric (wrangler.toml); Prisma Compose infers from TypeScript descriptors. Our manifest is generated.
- **Edge vs general compute**: Cloudflare is edge-first; Prisma Compose targets Prisma Platform (e.g. Bun on VM). Routing and locality matter less; binding model still applies.
- **Single Worker vs multi-entrypoint**: Cloudflare typically deploys one Worker per config; Prisma Compose has multiple entrypoints (http-service, worker, subscriber, cron) in one app. Manifest must enumerate them.

## Near-term design questions

- How does `prisma-compose.map.json` map to Wrangler's config shape (entrypoints, bindings, routes)?
- What is the minimal "binding declaration" surface in descriptors (resource refs, system bindings like ingress)?
- How do we achieve "wrangler dev" parity for local development (emulated resources, hot reload)?

---

## Open questions / assumptions

- **Assumption**: We want Wrangler's product shape (workflow clarity, explicit bindings, artifact discipline) more than copying its implementation.
- **Open question**: Should Prisma Compose have a CLI that mirrors wrangler commands (`dev`, `deploy`, `tail`), or is the primary interface different (e.g. framework + platform API)?

