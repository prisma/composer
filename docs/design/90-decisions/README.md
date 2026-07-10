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

