# MakerKit

MakerKit is a **TypeScript-first framework** for defining and deploying **applications on the Prisma Platform**.

## User flow

1. **Define your app in TypeScript** in terms of **Services**, **Streams**, and **Resources**.
2. **Deploy with MakerKit** to the Prisma Platform.
3. The platform runs your app by invoking MakerKit-managed entrypoints (HTTP, workers, subscribers, cron, etc.).

## What MakerKit does

- **Infers service topology from application structure**: determines what services/resources exist and how they depend on each other.
- **Provides platform entrypoints to execute services**: exposes a stable execution interface for HTTP services, workers, subscribers, cron jobs, and other executable units.

## Why this exists

MakerKit is designed to make apps on the Prisma Platform:

- **Code-first**: the app’s structure in TypeScript is the source of truth (avoid drift-prone parallel manifests).
- **Inspectable**: the platform integration surface is an explicit artifact (diffable, verifiable, automation-friendly).
- **Consistent to execute**: one execution model across HTTP + background + streaming workloads.
- **Tool- and agent-friendly**: primitives are explicit and statically analyzable, making scaffolding and refactors safer.

## What this repository is (today vs later)

This repo serves **two purposes**:

1. **Design docs + research (today)**: architecture, domain modeling, ADRs, and inspiration research.
2. **Framework implementation (later)**: the TypeScript packages and tooling that realize the design.

MakerKit is currently in the **design phase**. The docs in `docs/design/` are the source of truth.

## Start here

- **What is MakerKit?** `docs/design/00-purpose/README.md`
- **Design docs home + reading order:** `docs/design/README.md`
- **Broad overview (longer narrative):** `docs/design/10-domains/makerkit-overview.md`

## Repo map

- `docs/design/`: design docs system (purpose, principles, domain model, deep dives, ADRs)
- `docs/design/04-inspirations/`: research libraries for reference systems (TanStack DB, Cloudflare, Wrangler, Convex) with small `example-app/` scaffolds
- `agent-os/product/`: product planning artifacts (mission/roadmap/tech stack). Design/architecture lives in `docs/design/`.
- `examples/`: reference/example projects used for research and comparison
- `packages/` (planned): where the MakerKit implementation will live as it’s built out

## Contributing

If you’re updating design docs, follow:

- Process: `docs/design/99-process/README.md`
- Templates: `docs/design/99-process/templates/`

Rule of thumb:

- Update **purpose/principles** when the constraint is stable.
- Update **domain docs** when boundaries/interfaces/invariants change.
- Write an **ADR** when a decision is made that should be referenced later.

## Vocabulary

Some terms used in the design docs:

- **Control plane**: inspect/validate TypeScript definitions and emit artifacts for provisioning/orchestration.
- **Execution plane**: run entrypoints and connect them to platform-provided dependencies at runtime.

## Dev tooling

This repo is set up as a `pnpm` + `turbo` workspace (primarily for future implementation work and examples):

```bash
pnpm install
pnpm lint
pnpm test
pnpm typecheck
```

