# C2 — dispatch plan

Spec: [spec.md](spec.md). Two implementation dispatches run in parallel because they touch disjoint files and the spec pins the interface between them (the `destroy` input, the flags, the error codes, the report field). The orchestrator then sweeps, verifies end to end and reviews.

## D1. The code says environment

- **Outcome:** every package under `packages/` follows the spec's chosen design, with tests for: `--environment` on deploy and `deploy list`; the defaults; dev handing `dev` to the local target; `--stage` redirected; `destroy` requiring a name; production resolving to the default Branch; a non-production name that hits the default Branch refused; the report's `environment` field.
- **Builds on:** main at e2eece27.
- **Hands to:** `pnpm build`, `pnpm typecheck`, `pnpm lint` and the package tests pass; a boundary grep for `stage` in `packages/**/src` finds only Alchemy vocabulary and internal identifiers naming Alchemy stages.

## D2. The words around the code say environment

- **Outcome:** `docs/guides/`, `skills/`, `examples/`, `scripts/`, `.github/`, `website/` copy and the non-ADR design docs follow the spec, including the local-dev doc saying local dev runs as `dev` and per-environment local copies come in C3.
- **Builds on:** the spec (not D1's code).
- **Hands to:** a boundary grep for `stage` over those trees finds only Alchemy vocabulary and links to older ADR filenames; `website` content tests pass.

## D3. Verify (orchestrator)

Full test suite; real `prisma deploy --environment <name>`, `prisma deploy`, `prisma dev`, `--stage` refusal, `destroy` with and without a name; `/drive-code-review` without the walkthrough; fixes.
