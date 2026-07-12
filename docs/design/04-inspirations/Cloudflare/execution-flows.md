# Cloudflare platform execution flows (research)

This document captures the "always happening" flows: dev, deploy, request handling, and binding resolution. Kept high-signal for Prisma Compose relevance.

Source context: [Cloudflare Workers Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/), [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/)

## Flow 1: Deploy (control plane)

1. **Load config**: Wrangler reads `wrangler.toml` / `wrangler.jsonc`.
2. **Validate**: Check syntax, binding references, route patterns.
3. **Build**: Bundle entry point + dependencies into an artifact (JS/WASM).
4. **Upload**: Send artifact + metadata (bindings, routes, cron) to platform.
5. **Platform provision**: Create/attach resources for declared bindings; attach routes; register cron.
6. **Activate**: New version serves traffic for configured routes.

Key: config is the single source of truth for "what runs" and "what it's bound to."

## Flow 2: Local dev

1. **Start**: `wrangler dev` (optionally `--remote`).
2. **Load**: Same config; local server with hot-reload.
3. **Emulate bindings**: Local D1, KV, R2 substitutes where available; or tunnel to remote.
4. **Request**: Developer hits local URL; request is routed to Worker; handler receives request + env.
5. **Iterate**: Code changes trigger rebuild; dev server refreshes.

## Flow 3: Request handling (HTTP ingress)

1. **Request arrives** at edge (matches route).
2. **Route resolve**: Platform selects Worker (and version) for the route.
3. **Isolate**: Get or create isolate for that Worker.
4. **Bindings resolve**: Platform injects concrete resource stubs into `env`.
5. **Invoke**: Call `fetch(request, env)` on the Worker's export.
6. **Response**: Handler returns `Response`; edge returns to client.

## Flow 4: Cron / scheduled invocation

1. **Schedule fires**: Platform cron triggers Worker.
2. **Invoke**: Call scheduled handler with cron payload (no HTTP `Request`).
3. **Env**: Same binding resolution as HTTP; handler receives `env`.

## Flow 5: Queue consumer

1. **Message arrives** in queue bound as consumer.
2. **Batch**: Platform may batch messages.
3. **Invoke**: Call queue handler with messages + `env`.
4. **Retry**: Platform retries on failure per queue config.

## Flow 6: Binding resource lifecycle

1. **Declare**: User adds binding to wrangler config (e.g. `binding = "MY_BUCKET"`, `bucket_name = "..."`).
2. **Deploy**: Platform ensures resource exists (create or attach to existing).
3. **At request time**: Resolve binding → concrete stub; pass in `env`.
4. **Binding-only change**: Platform may reuse existing isolates (faster deploy, but care needed with global-scope caching of binding-derived state).

---

## Open questions / assumptions

- **Assumption**: HTTP and cron are the primary ingress patterns for Prisma Compose comparison; queues and Durable Objects are secondary.
- **Open question**: Exact isolation model for Workers for Platforms / multi-tenant dispatch.

