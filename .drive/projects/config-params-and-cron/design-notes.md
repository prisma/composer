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
   (a future Compute may take JSON config). The serializer returns arbitrary values
   the target stores; the target dictates the encoding and destination; core is
   blind. The medium is fixed as key/value string pairs (what env storage is); the
   string form inside a value is the target's business. → ADR-0019.
6. **No ambiguity about who serializes, because the param type is the target's.**
   `compute()` is app-cloud's and accepts Compute params; a scheduler is a `compute()`
   service, so its `jobs` is a Compute param carrying app-cloud's serializer;
   `defineSchedule` returns that type; the requirement floats up through the types.
   → ADR-0019.

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
- ADR-0018/0019/0020 and the config-params / scheduled-work domain docs
- Sibling: [Forcing-Function Apps](../forcing-function-apps/design-notes.md)
