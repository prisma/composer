# Design notes — Config Params + Cron

The durable design lives in the ADRs and domain docs (see spec § References). This
records how the design was reached and the decisions behind it, for anyone tracing
the project.

## How this came about

The project was carved out of the Forcing-Function Apps cron slice (its old "S3").
Designing cron for datahub revealed that the real blocker wasn't cron at all — it
was that the config model can't carry a structured value (the schedule). So the
foundation (schema-typed params + target serialization) became its own project, with
cron as its first consumer.

## The design conversation, in order

1. **Cron isn't a resource, it's a driver.** The apparent "reverse edge" (a resource
   that calls you) dissolved once we saw the scheduler as a normal consumer of the
   target's exposed endpoint — the storefront→auth shape. No new composition
   capability needed. → ADR-0020.
2. **The schedule must be build-time data.** Runtime `/schedule` registration is lost
   on a stateless instance's recycle and invisible to a future native lowering.
   Baking the jobs in as a param fixes both — and is what makes emulated and native
   realizations share one interface. → ADR-0020.
3. **One clock, `jobId` as data.** A fixed `trigger(jobId)` dependency + a user
   router avoids one-service-per-job; the reusable `cron-scheduler` stays job-agnostic.
   → ADR-0020.
4. **The schedule needs a structured param — the model has none.** `ParamType` is
   `string | number`; a JSON-string hack is graph-blind and weakens native lowering.
   Mirror how `Contract`/`rpc` let the caller own the type: a param carries a Standard
   Schema. → ADR-0018.
5. **Serialization is the target's, not core's.** Env vars aren't the only target
   (a future Compute may take JSON config). The target dictates the encoding,
   destination, and medium; core is blind. (An intermediate framing fixed the
   medium to key/value string pairs and hung `serialize`/`deserialize` on the
   param — both walked back in item 6.) → ADR-0019.
6. **Who serializes? The target that runs the service.** An earlier framing put
   the serializer on the param (a "Compute param type" carrying its own
   serialize/deserialize). Rejected on review as over-built: a param is just a
   schema + facets, and serialization — logic, encoding, and **medium** — is wholly
   the target's, exactly the RPC split (schema on the declaration, wire owned by the
   mover). Params are target-agnostic; the service factory (`compute()` is
   app-cloud's) is what binds a service's config to a target's serialization. Core
   fixes no medium — env key/value strings are app-cloud's choice. → ADR-0019.
7. **Params are read through `config()`, not `load()`.** `load()` currently returns
   deps *and* params merged, which risks a dep/param name collision silently
   clobbering one. Split: `load()` for dependencies, a sibling `config()` for params.
   → ADR-0021.

## Grounding checks done during design (against merged `main`)

- `compute()` today takes **no** user params — only a hardcoded `port`
  (`computeParams`); `service()` is param-general but `compute()` pins it. So opening
  `compute()` to params is a real, needed change.
- Config is stored today as project-scoped, encrypted **env vars** via
  `/v1/environment-variables` (one row per param), keyed `ADDRESS_OWNER_NAME`;
  `stash` does `String(value)` and `coerce` reverses by the `string|number` enum — so
  a structured value would become `"[object Object]"`. That's the hard floor this
  project lifts.

## Open questions

Tracked in [spec.md](spec.md) § Open questions: the Compute-param constructor
surface, and whether S1 splits.

## References

- [spec.md](spec.md), [plan.md](plan.md)
- ADR-0018/0019/0020/0021 and the config-params domain doc
- Sibling: [Forcing-Function Apps](../forcing-function-apps/design-notes.md)
