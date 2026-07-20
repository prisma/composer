# Architecture Decision Records (ADRs)

This directory contains append-only decision records.

## When to write an ADR

Write an ADR when we “pick an answer” that future readers will need to understand and reference (even if the decision is provisional).

Keep ADRs short. The sections (see [the template](../99-process/templates/adr.md)):

- Decision
- Reasoning
- Consequences
- Alternatives considered
- Related

**No `Status` section.** A per-ADR "Proposed / Accepted" line goes stale and adds
nothing — the record exists because we made the call. Supersession and
deprecation are recorded where a reader actually looks: the superseding ADR
names what it replaces (in its Decision/Related), and the Index below annotates
the superseded entry. A retired ADR stays in place; the Index says so.

## Index

_Earlier drafts (ADR-0001, ADR-0002) were retired as the high-level design settled._

- [ADR-0003](ADR-0003-deploy-derives-everything-from-the-root-node.md) — `prisma-composer deploy` derives everything from the root node; there is no deploy config file.
- [ADR-0004](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) — Paths resolve relative to the file that writes them; the build adapter carries the authoring module.
- [ADR-0005](ADR-0005-users-build-the-framework-assembles.md) — Users build the app's code; the framework assembles the artifact by documented, deterministic steps (validate, wrap, each app-type's documented deploy step — e.g. Next's static/public copy). No guessing (arithmetic/depth-inference/discovery), no laundering (symlink = hard error); read the build tool's own manifest (Next's `relativeAppDir`), don't walk or compute.
- [ADR-0006](ADR-0006-every-node-is-named.md) — Every node is named; the root's name names the application.
- [ADR-0007](ADR-0007-deploy-drives-alchemy-through-a-generated-stack-file.md) — Deploy drives Alchemy through a generated, inspectable stack file.
- [ADR-0008](ADR-0008-wrapper-inlines-everything-except-runtime-builtins.md) — The boot wrapper inlines everything except runtime built-ins.
- [ADR-0009](ADR-0009-deploy-state-is-hosted-in-the-workspace.md) — Deploy state is hosted in the workspace, not in local files. *(Superseded by ADR-0034: still hosted, now per-stage in the app's own Project.)*
- [ADR-0010](ADR-0010-deploys-hold-a-session-advisory-lock.md) — Deploys hold a session advisory lock per stack and stage.
- [ADR-0011](ADR-0011-targets-supply-the-deploy-state-layer.md) — Targets supply the deploy state layer; core owns no default.
- [ADR-0012](ADR-0012-the-state-store-speaks-sql-directly.md) — The state store speaks SQL directly; Prisma Next adoption is deferred.
- [ADR-0013](ADR-0013-resources-are-provisioned-by-modules-deps-are-declarations.md) — Resources are provisioned by modules; dependencies are uniform contract-checked slots.
- [ADR-0014](ADR-0014-one-authoring-primitive.md) — Establishes one authoring primitive with no separate `app()` (the App is the outermost Module). Its framework, package, and CLI names are superseded by ADR-0026 (**Prisma Composer**) and its unit noun by ADR-0025 (**Module**).
- [ADR-0015](ADR-0015-dependencies-resolve-to-bindings-clients-are-app-side.md) — Dependencies resolve to bindings (a client for protocol-owned kinds, typed config for resources); clients are constructed app-side.
- [ADR-0016](ADR-0016-a-module-has-the-same-boundary-as-a-service.md) — A module has the same boundary as a service: deps in, expose out, forwarding as data flow; reusable modules follow.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — Control-plane code loads through `prisma-composer.config.ts`: the config statically imports extension descriptors; registries are keyed by (extension ID, node ID); nodes are pure data; one explicit state store per deploy.
- [ADR-0018](ADR-0018-config-params-carry-a-caller-owned-schema.md) — A config param is a plain object: a caller-supplied Standard Schema plus facets; the framework keeps no enum of permitted param types, and (like an RPC contract) leaves serialization to the target.
- [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — The deploy target owns config serialization entirely — logic, encoding, and medium; core builds the typed Config and never encodes or reads storage. Params are target-agnostic.
- [ADR-0020](ADR-0020-scheduled-work-is-a-driver-not-a-resource.md) — Scheduled work is a driver, not a resource: a scheduler service depends on the `trigger(jobId)` endpoint it calls, with the schedule as build-time config.
- [ADR-0021](ADR-0021-params-are-read-through-config-not-load.md) — A service reads dependencies through `load()` and config params through a sibling `config()`; the two never share a namespace.
- [ADR-0022](ADR-0022-data-deps-carry-a-prisma-next-contract.md) — Data deps carry a Prisma Next contract: typed client binding, one contract per database via its config, deploys migrate along authored edges to the contract hash. *(Proposed)*
- [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md) — A Prisma App is one Prisma Cloud Project; Modules are Apps/Databases inside it; a Stage is a Branch, and deploy state is per `(Project, Branch)`.
- [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md) — A stage is a deploy-time environment; the CLI resolves the app's Project (by root-module name) and the stage's Branch outside Alchemy before the stack runs.
- [ADR-0025](ADR-0025-name-the-unit-of-composition-module.md) — The unit of composition is a **Module**, authored with `module()`; supersedes ADR-0014's unit noun ("System"). Registers: package (npm's word) / extension (config slot) / Module (composition).
- [ADR-0026](ADR-0026-name-the-framework-prisma-compose.md) — The framework is **Prisma Composer**; "Prisma App" names only the artifact you build. Supersedes ADR-0014's framework, package, and CLI names: `@prisma/composer*` (incl. `compose-alchemy`), `prisma-composer`, `prisma-composer.config.ts`.
- [ADR-0027](ADR-0027-two-packages-compose-and-compose-prisma-cloud.md) — Ship two **public** packages: `@prisma/composer` (core + CLI + agnostic subpaths) and `@prisma/composer-prisma-cloud` (target + first-party modules as entrypoints, cron first). Boundary = the user's one choice: where does it run.
- [ADR-0028](ADR-0028-numbered-domains-and-layers-enforced-by-dependency-cruiser.md) — `packages/` organizes into numbered domains (0-framework, 1-prisma-cloud, 9-public) and layers; planes as config-mapped entrypoints; internals are `@internal/*`; only 9-public publishes; dependency-cruiser enforces.
- [ADR-0029](ADR-0029-secrets-are-a-forwardable-slot.md) — A secret is a distinct forwardable slot (not a param): a service declares a nameless `secret()` need, the root binds it to a platform env-var via `envSecret`, and it reads back as a redacting `SecretBox`; the framework carries only the name (pointer rows + boot double-lookup + preflight). *(Proposed)*
- [ADR-0030](ADR-0030-rpc-callers-verified-with-an-auto-provisioned-service-key.md) — Every RPC binding carries a distinct, framework-minted **service key**: the client sends it, `serve()` rejects a caller without one (401). Auto-provisioned per edge at deploy, carried on the binding's own `COMPOSER_*` env-var rail; its value is minted and kept in the hosted deploy state (a capability token, deliberately not an ADR-0029 name-only secret). *(Proposed)*
- [ADR-0031](ADR-0031-provisioned-param-values-are-a-need-resolved-through-a-target-registry.md) — A framework-minted param value is an opaque, branded **provisioning need** (not a named facet on the param): core forwards it and resolves its brand against the deploy target's `provisions` registry, failing loudly on a miss. The provisioner owns all mint/size/stability/rotation policy; core's surface stays one field. Resolves against the consumer's extension; cross-extension edges fail closed. *(Proposed)*
- [ADR-0032](ADR-0032-params-bind-at-provision-env-sourcing-is-a-target-source.md) — A param can be bound at `provision()` — a schema-validated literal (beats `default`) or a target-owned source (`envParam('NAME')`, mirroring ADR-0029's need/source split): a pointer row on the wire, boot double-lookup, the raw string handed to the param's own schema, read through `config()` unredacted; preflight covers the names like secrets.
- [ADR-0033](ADR-0033-lowering-types-are-defined-by-their-readers.md) — Every value in the lowering pipeline is typed by the code that reads it, not the code that writes it, retiring the shared `LoweredNode` record: a descriptor types the values it passes between its own phases (`ServiceLowering<P, S>`); the application hook's product reaches core as `unknown` and its own extension narrows it with a guard; a node's values for the nodes downstream are name-keyed `WiringOutputs`, resolved against the consumer's connection declaration. The lowering loop is the only party that knows which output feeds which input. Records the alchemy execution facts (a value passed between phases legitimately holds an unresolved `Output<T>`), that the heterogeneous registry's type safety rests on the loop rather than the compiler, and that an unchecked claim is acceptable only when it is named, justified, and singular.
- [ADR-0034](ADR-0034-deploy-state-lives-in-the-stage-branch.md) — Deploy state lives in a framework-owned `prisma-composer-state` database in the stage's own Branch (production: the implicit default Branch). State has the environment's lifetime: platform-side Branch/Project deletion cleans it up with no framework involvement; the CLI deletes it last-among-members on destroy. Supersedes ADR-0009's workspace-level store.
- [ADR-0035](ADR-0035-public-entrypoints-live-in-src-exports.md) — Public entrypoints live in `src/exports/` (one file per subpath; internals stay at the `src/` root); `@internal/tsdown-config` generates `package.json#exports` from object-named entries where safe, with two deliberate exceptions kept hand-maintained (the multi-pass `cron`/`storage`/`streams`, and the two published packages). Completes ADR-0028.
