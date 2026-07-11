# System Composition — closed (complete)

The system-composition project (workspace name `hex-composition`) shipped and is
closed. This file is the completion record. The design and implementation are
durable in the ADRs, the domain docs, and the code; this workspace's scratch
(plan, spec, slice specs) has been removed.

## What shipped

- **A System has a service's typed boundary** — `system(name, { deps?, expose? },
  body)`, nesting, forwarding as data flow across the boundary.
  **ADR-0016**; `docs/design/10-domains/system-composition.md`.
- **The control plane loads through `prisma-app.config.ts`** — the config
  statically imports extension descriptors; registries are keyed by
  `(extension, node type)`; nodes are pure data; one explicit state store per
  deploy. **ADR-0017**; `docs/design/10-domains/deploy-cli.md`. (This replaced a
  failed node-owned-loads approach that the live e2e caught.)
- **A reusable System, proven, plus the testing seam** — auth becomes a System
  that owns its own database and exposes only its contract; `mockService`
  (`@prisma/app/testing`, unit) and `bootstrapService` (`@prisma/app-cloud/testing`,
  integration), with no test code in the production node. Proven by a unit test,
  an integration test, and a live "Deploy, verify, destroy" e2e.
  `docs/design/10-domains/testing.md`; `skills/testing-prisma-apps`; PR #39.

Built on the merged model: unified dependency slots (#21), always-system root
(#22), the `@prisma/app*` / System naming (#24 = ADR-0014), and
dependencies-resolve-to-bindings (#26 = ADR-0015).

## Deferred follow-ups (off the critical path, not started)

- **A `ControlClient`.** Replace the three duplicated `(extension, type)`
  lookups (in `deploy.ts`, `validate-coverage.ts`, `assemble-services.ts`) with
  one in-memory client that *performs* control-plane operations — not a state
  map. Open design; raised in the PR #39 review.
- **Fold `@prisma/alchemy` into `@prisma/app-cloud`.** One consumer, a
  misleading generic name; the firewall that matters is a file boundary, so the
  package boundary earns nothing. Needs a slice note plus a mechanical PR.

## Downstream note

`forcing-function-apps` consumes this project's output (ADR-0016, the unified
model, the H3 swap-the-backing pattern) — those references point at the durable
ADRs and remain valid. Its one open coordination item, the **cron reverse-edge**
(a resource that invokes its consumer on a schedule), is answered by **ADR-0020**:
scheduled work is a *driver*, not a new composition primitive — a scheduler
service depends on the endpoint it triggers. No further composition capability is
owed to that project.
