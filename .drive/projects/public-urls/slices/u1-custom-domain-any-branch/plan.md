# U1 — dispatch plan

## D1. Remove the default-Branch rule, with tests and docs

- **Outcome:** `Prisma.CustomDomain` creates a domain on an App on any Branch; the refusal test is replaced by an any-Branch test; no doc or JSDoc states the rule.
- **Builds on:** nothing.
- **Hands to:** slice DoD; PR-open.
- **Focus:** the scope list in [spec.md](spec.md).
- **Validation gate** (run from the alchemy repo root):
  - `pnpm test:integration test/Prisma` (fakes only, no cloud credentials needed)
  - `pnpm exec tsrs -b`
  - `pnpm exec oxfmt --check` and `pnpm exec oxlint` over the touched files (or the repo's `format`/`lint` scripts)
  - `pnpm docs:check-jsdoc` and `pnpm docs:gen`, committing any regenerated Prisma pages
  - `grep -rn "ensureDefaultBranchApp\|only be attached to apps on the default" packages website` returns nothing
