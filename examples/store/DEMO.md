# Standup walkthrough (~5 min)

Order of files to open, with the one point each makes.

## 1. The whole app — [module.ts](module.ts)

The entire application is ~6 lines of composition. Three components, three
edges, no infrastructure config anywhere. Point at the wiring:
`orders` gets `catalog.rpc`, `storefront` gets both.

## 2. A contract — [modules/catalog/src/contract.ts](modules/catalog/src/contract.ts)

The edge type. arktype schemas → a typed client on the consumer side and a
type-checked handler map on the producer side. Validated at the boundary at
runtime.

## 3. A module — [modules/catalog/src/module.ts](modules/catalog/src/module.ts)

catalog owns its own Postgres — a **Prisma Next-typed** one. Three pieces:

- [contract.prisma](modules/catalog/contract.prisma): the data schema. Emit
  turns it into a typed contract; `migration plan` authors
  [migrations/](modules/catalog/migrations), which the deploy applies before
  the service ever starts — no `create table if not exists` in app code.
- [src/service.ts](modules/catalog/src/service.ts): the service declares
  `deps: { db: pnPostgres(catalogData) }` and what it exposes; that's the
  whole declaration.
- [src/server.ts](modules/catalog/src/server.ts): `load()` hands it the typed
  client — `db.orm.public.Product.where({ id }).first()`. No SQL strings, no
  row mappers, and the same contract types the resource end (the deploy
  refuses to wire a service against a database with a different contract).

## 4. The interesting edge — [modules/orders/src/module.ts](modules/orders/src/module.ts)

orders owns a Postgres too, but declares `deps: { catalog }` as a **boundary
input** — the parent supplies any producer of `catalogContract`. In
[src/server.ts](modules/orders/src/server.ts), `placeOrder` calls
`catalog.getProduct()` — a typed async call, no URL, no fetch, no client
setup. It doesn't know or care where catalog runs.

## 5. A shared module — cron rotating the ★ special

[module.ts](module.ts) provisions `cron({ schedule, runner })` — the cron
module ships with the framework
(`@prisma/compose-prisma-cloud/cron`), not this app. Two points:

- [modules/promotions/src/service.ts](modules/promotions/src/service.ts):
  the app supplies only the schedule (`rotateSpecial: '30s'`) and a runner
  whose handler maps the job id to `catalog.rotateSpecial()`
  ([src/server.ts](modules/promotions/src/server.ts)). `serveSchedule` is
  exhaustive over the schedule's ids at compile time.
- The cron module's boundary deps mirror the runner's own deps, so the root
  wires `catalog: catalog.rpc` into it exactly like any other edge — a
  reusable module composes the same way app modules do.

Live proof: watch the ★ move to the next product every 30s on refresh.

## 6. Plain app code — [modules/storefront/app/page.tsx](modules/storefront/app/page.tsx)

A normal Next.js server component. `service.load()` hands it two typed
clients, injected by the root's wiring. The Buy button is a server action
calling `orders.placeOrder`.

## 7. Show it live

Deployed: run the deployed storefront URL, buy a coffee, watch it appear in
recent orders (two RPC hops + two Postgres writes behind one click).

Fallback if the cloud misbehaves: `pnpm dev` here runs the same storefront
against in-memory fakes on loopback — same contracts, zero cloud.

## 8. Testing story (if time)

[page.test.tsx](modules/storefront/app/page.test.tsx): `mockService` swaps
`load()` for typed fakes — the handler maps are type-checked against the same
contracts the real modules serve. No Postgres, no server, no cloud.

## Likely questions

- **"What actually got deployed?"** Each compute service is a Prisma Compute
  VM; each module's `postgres()` is a Prisma Postgres database. The deploy
  derives the graph from the code above — same code could target another
  extension pack.
- **"What's in an edge?"** At runtime: an env var (`CATALOG_URL`) the
  framework injects, plus the contract's validation on both ends.
- **"Why modules and not just services?"** Boundaries. catalog's database can
  never become someone else's dependency — it isn't reachable. Only exposed
  ports are.
