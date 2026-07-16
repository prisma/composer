# ADR-0032: The deploy reports what each node became, projected by its descriptor

## Decision

`prisma-composer deploy` reports what it did: a map from each graph node to a
small description of the platform entity that node became. It is keyed by the
node's graph id, which is already its deployment address — the same id the
config keys and bundle ids ride.

Each entry is produced by the **descriptor that owns the entity**, not by core.
A descriptor gains a `report()` alongside `provision`/`serialize`/`package`/
`deploy`, returning only what is safe to print. Core assembles the entries; it
never reaches into a `LoweredNode` and decides for itself what to publish.

A compute service reports its public address; a database reports no connection
information at all:

```jsonc
// .prisma-composer/deployment.json — and the same value as the stack's outputs
{
  "site": {
    "kind": "compute",
    "extension": "@prisma/composer-prisma-cloud",
    "id": "cps_m2u4w6w93v8m1hkc8bdl4wzz",
    "name": "site",
    "url": "https://m2u4w6w93v8m1hkc8bdl4wzz.ewr.prisma.build"
  },
  "catalog.database": {
    "kind": "prisma-next",
    "extension": "@prisma/composer-prisma-cloud",
    "id": "db_cmdye4tfpe2xiv84v75tqfsz",
    "name": "database"
    // no url: this node's connection string is a credential
  }
}
```

The rule a descriptor follows is **include, never exclude**: an entry carries
the fields that were deliberately put in it. A field a descriptor does not name
is absent, so a new field is never published by having been forgotten about.

## Reasoning

**The map already exists; we throw it away.** `lowering()` (core's `deploy.ts`)
walks the graph holding `lowered` — a Map from node id to that node's
`descriptor.deploy(...)` result — and then ends with a hardcoded
`return { outputs: {} }`. The print path exists too: the generated stack's
default export *is* `lower(app, config, opts)`, and Alchemy prints a stack's
outputs. The `{ outputs: {} }` at the end of every deploy log is that mechanism
working correctly with nothing in it.

**The interesting value is already computed.** The Prisma Cloud compute
descriptor already returns `outputs: { url: deployment.deployedUrl, projectId }`.
The deployed URL — the single thing a person or a CI job most wants after a
deploy — is derived, used for wiring, and then discarded.

**Recovering it afterwards is archaeology, and it is ambiguous.** Today the only
way to answer "where did that go?" is to query the Management API and match on
names (`website/scripts/verify-deployed.ts` does exactly this). That needs
credentials and an SDK dependency, and it cannot always answer: the API reports
`branchId: null` for every compute service, so a project holding a production
`site` and a staged `site` offers no way to tell which is which. The deploy never
has to ask — it is holding the id it just deployed.

**Safety cannot be decided centrally, because field names do not carry
sensitivity.** A field called `url` is a public HTTP endpoint on a compute node
and a Postgres connection string on a `prisma-next` node. Same name, opposite
sensitivity. A rule phrased over field names would either publish a credential or
suppress the endpoint. Only the descriptor knows which it produced, and
`LoweredNode.outputs` is extension-defined and opaque to core by design — the
core stays thin and target-specific knowledge stays in the pack.

**An allowlist cannot leak what it never held.** Because the report is
constructed rather than filtered, a mistake in it omits a field; it does not
expose one. That matches how this codebase already treats sensitivity — carried
by the type at the source (`SecretBox`, Effect's `Redacted`) rather than scrubbed
out of text at the edge (ADR-0029).

## Consequences

- CI reads the URL from the deploy instead of re-deriving it. The docs site's
  smoke check loses its `@prisma/management-api-sdk` dependency, its
  project-name lookup, and the guard it needs today for two indistinguishable
  `site` services.
- `lower()`'s return value is published surface (`@prisma/composer/deploy`), so
  this changes a public type and the stack's printed outputs.
- A new extension reports nothing until its descriptor opts in. A missing report
  is a visible gap, which is the failure we want; the alternative failure is a
  published credential.
- Adding a field to a report is a deliberate act by the person who owns that
  entity and knows whether it is a secret.
- The report is the deploy-time counterpart to the topology artifact: the
  topology is what you declared, this is what it became.

## Alternatives considered

- **Print the lowered map and redact secrets by string-matching the output.**
  Rejected *as the control for this report*, for three reasons. Some credentials
  do not exist when the deploy starts — `s3Credentials` mints a SigV4 key pair
  mid-run — so a redactor only masks what has been registered by the time a line
  prints, and one missed registration is a leak. Values are transformed before
  they are printed: a password inside a DSN is percent-encoded, and JSON output
  escapes it again, so literal matching misses every encoded form. And it inverts
  the stance the codebase already takes, letting a raw secret exist as a plain
  string and hoping to catch it at the edge. Redaction is still worth having as
  defense-in-depth over the deploy log *at large* — progress lines, errors that
  echo a DSN, stack traces — where we do not author the string. That is a
  separate change; it is not what makes this report safe.
- **Decide safety centrally by field name** (for example: omit `url` on
  resources, keep it on services). Rejected: `url` is public on a compute node
  and a credential on a `prisma-next` node, and the S3 credentials resource's
  secrets are `accessKeyId`/`secretAccessKey` — not named `url` at all — so a
  name rule would print them untouched.
- **Keep querying the Management API afterwards.** The status quo. Rejected as
  the answer: it needs credentials the caller may not have, and `branchId: null`
  makes production and a stage indistinguishable.
- **Report the root module's outputs.** Rejected: a closed root returns nothing,
  and a deployed URL is not an authoring-time value — it does not exist until the
  deploy has run.

## Related

- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) — sensitivity carried by
  the type rather than by scrubbing; the projection keeps that true of the report.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — the
  extension registries a descriptor is routed through.
- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)
  — stages resolve to a Project and Branch; the report removes the need to
  re-derive which one a deploy hit.
- [`deploy-cli.md`](../10-domains/deploy-cli.md) — the pipeline this reports on.
