# Prisma App Framework Design Docs

This directory is the **source of truth** for the Prisma App Framework’s architecture and design. It is intended to be consumed by:

- Humans reading the repository
- The Agent OS workflows in this repo (product planning stays in `agent-os/product/`, but design/architecture lives here)
- Other teams integrating with the Prisma App Framework (platform/orchestration/tools)
- Implementation contributors working in this codebase

## How this documentation system is organized (DDD/Clean-aligned)

We keep docs in **three kinds of artifacts** so we can evolve the design incrementally without one giant “design.md”:

- **North-star docs (low churn)**: goals/purpose, guiding principles, architectural principles.
- **Reference docs (structured)**: example app, domain model map + glossary, domain deep dives.
- **Inspiration library (iterative)**: notes on systems we’re learning from (what to emulate, what to avoid).
- **Decisions (append-only)**: ADRs capturing “we picked an answer”, linked from reference docs.

This structure is intentionally aligned with **DDD + Clean Architecture**:

- **Ubiquitous language** lives in the glossary and domain docs.
- **Bounded contexts** and their relationships are documented in the domain map.
- **Dependency direction** (Clean): low-level primitives stay decoupled; user-facing libraries are the **composition points** that wire primitives together.

## How to evolve these docs (design process)

The process and templates live under `docs/design/99-process/`:

- **Process**: `docs/design/99-process/README.md`
- **Templates**: `docs/design/99-process/templates/`

Rule of thumb during design discussions:

- Update **principles** only when it’s a stable guiding constraint.
- Update **domain docs** when we refine boundaries, interfaces, invariants, or responsibilities.
- Write an **ADR** when we make a decision we want to be able to reference later.

## Reading order

1. `docs/design/00-purpose/README.md` (what the Prisma App Framework is and why it matters)
2. `docs/design/00-purpose/goals.md`
3. `docs/design/01-principles/guiding-principles.md`
4. `docs/design/01-principles/architectural-principles.md`
5. `docs/design/02-example-app/README.md`
6. `docs/design/03-domain-model/domain-map.md`
7. `docs/design/03-domain-model/glossary.md`
8. `docs/design/03-domain-model/authoring-surface.md`
9. `docs/design/04-inspirations/` (systems we’re learning from)
10. `docs/design/05-prisma-cloud/` (the hosting target: PDP data model, Alchemy lowering)
11. `docs/design/10-domains/` (deep dives)
12. `docs/design/90-decisions/` (ADRs)
