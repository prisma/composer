# Architecture Decision Records (ADRs)

This directory contains append-only decision records.

## When to write an ADR

Write an ADR when we “pick an answer” that future readers will need to understand and reference (even if the decision is provisional).

Keep ADRs short:

- Context
- Decision
- Rationale
- Consequences
- Alternatives

## Index

_Earlier drafts (ADR-0001, ADR-0002) were retired as the high-level design settled._

- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md) — `prisma-app deploy` derives everything from the root node; there is no deploy config file.
- [ADR-0004](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) — Paths resolve relative to the file that writes them; the build adapter carries the authoring module.
- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md) — Users build their app; the framework assembles deploy artifacts from built output.
- [ADR-0006](ADR-0006-every-node-is-named.md) — Every node is named; the root's name names the application.
- [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) — Deploy drives Alchemy through a generated, inspectable stack file.
- [ADR-0008](ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md) — The boot wrapper inlines everything except runtime built-ins.
- [ADR-0009](ADR-0009-deploy-state-is-hosted-in-the-workspace.md) — Deploy state is hosted in the workspace, not in local files.
- [ADR-0010](ADR-0010-deploys-hold-a-session-advisory-lock.md) — Deploys hold a session advisory lock per stack and stage.
- [ADR-0011](ADR-0011-targets-supply-the-deploy-state-layer.md) — Targets supply the deploy state layer; core owns no default.
- [ADR-0012](ADR-0012-the-state-store-speaks-sql-directly.md) — The state store speaks SQL directly; Prisma Next adoption is deferred.
- [ADR-0013](ADR-0013-resources-are-provisioned-by-systems-deps-are-declarations.md) — Resources are provisioned by systems; dependencies are uniform contract-checked slots.
- [ADR-0014](ADR-0014-name-the-framework-prisma-app-and-its-unit-system.md) — Name the framework "Prisma App" (`@prisma/app`), its unit "System" with one `system()` primitive, the CLI `prisma-app`.
- [ADR-0015](ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md) — Dependencies resolve to bindings (a client for protocol-owned kinds, typed config for resources); clients are constructed app-side.
- [ADR-0016](ADR-0016-a-system-has-the-same-boundary-as-a-service.md) — A system has the same boundary as a service: deps in, expose out, forwarding as data flow; reusable systems follow.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — Control-plane code loads through `prisma-app.config.ts`: the config statically imports extension descriptors; registries are keyed by (extension ID, node ID); nodes are pure data; one explicit state store per deploy.
- [ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md) — A config param's type is a caller-supplied Standard Schema; the framework maintains no enum of permitted param types.
- [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — The deploy target owns config serialization over key/value string pairs; a param is the target's type by construction, so its serializer is the target's.
- [ADR-0020](ADR-0020-scheduled-work-is-a-driver-not-a-resource.md) — Scheduled work is a driver, not a resource: a scheduler service depends on the `trigger(jobId)` endpoint it calls, with the schedule as build-time config.
