# Design process and documentation workflow

This directory documents **how this documentation system works** and the **expected design process** for evolving MakerKit over time.

## The documentation system

We keep design docs split into three artifact types:

- **North-star docs (low churn)**: `docs/design/00-purpose/` and `docs/design/01-principles/`
- **Reference docs (structured)**: `docs/design/02-example-app/`, `docs/design/03-domain-model/`, `docs/design/10-domains/`
- **Decisions (append-only ADRs)**: `docs/design/90-decisions/`

This prevents the “single giant design doc” problem and makes it easy to incrementally add design outcomes.

## Relationship to DDD/Clean Architecture

We use DDD/Clean as organizing principles for documentation and design:

- **Ubiquitous language**: terms are defined in `docs/design/03-domain-model/glossary.md` and referenced consistently.
- **Bounded contexts**: captured in the domain map; each domain deep dive describes its boundaries and interfaces.
- **Dependency direction (Clean)**: primitives stay decoupled; “composition points” live in user-facing packages that wire domains together.
- **Interfaces first**: domains define contracts (ports) that other domains depend on, not concrete implementations.

## Expected design process (how to evolve docs)

During design discussions:

1. **Anchor on the example app** (`docs/design/02-example-app/`) whenever possible to keep discussion concrete.
2. **Update principles only when warranted**:
   - Guiding principles: long-lived constraints (e.g. streaming-first)
   - Architectural principles: structural rules (e.g. no globals, control/execution split)
3. **Update domain docs for boundaries/interfaces/invariants**:
   - Add or refine bounded contexts
   - Clarify responsibilities and contracts
   - Specify control-plane vs execution-plane responsibilities
4. **Write an ADR when we “pick an answer”**:
   - Keep ADRs short and specific
   - Link ADRs from the relevant domain doc(s)
5. **Prefer small, frequent updates**:
   - Don’t wait for perfect completeness
   - Keep docs consistent with current understanding

## Document templates

Use the ADR template in `docs/design/99-process/templates/` when recording a decision.

