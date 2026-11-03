# Project Plan — node-identity-and-consent

## Summary

Handoff plan. The slices below are the phases from the design, in the order they must ship. The receiving team decomposes each into slices of its own at pickup. Linear project: [Node identity and consent](https://linear.app/prisma-company/project/node-identity-and-consent-9ec5f9f522c0) (P-TML-1157). Builds on `deployment-identity` (P-TML-1156), which must be in production first.

**Spec:** `.drive/projects/node-identity-and-consent/spec.md`

## Phases

### Phase 2 — Separate identity from label (Composer, then control plane)

Every node definition takes `logicalId` (required) and `name` (optional); Load uses `logicalId` for the address; the single-string form fails to load with an error naming the fix; `--name` is removed from `prisma deploy`; guides, examples and the core-concepts skill move to the two-field form; a new decision record states the model and amends the records on node naming, environment resolution and node addresses. Then the control plane: the setup-PR generator writes the two-field root with a hoisted `logicalId` constant and a one-line comment, and the module-file inspector reads that constant. One Composer release.

- **Builds on:** `deployment-identity` in production.
- **Hands to:** phase 3 — Composer can tell a label edit from an identity edit.

### Phase 3 — Ask before losing data (Composer, with a platform dependency)

The ORM's consent model in `prisma deploy`: one question per subject whose row would be deleted or re-identified, answered by `--delete <subject>` or `--rename <old>:<new>`; `--yes` never consents; non-interactive runs fail with `CLI.CONSENT_REQUIRED`. `--delete` can ship first. `--rename` waits on the platform's update path accepting a new `logicalId` on service, database and bucket rows (the import project adds it).

- **Builds on:** phase 2.
- **Hands to:** phase 4 — CI deploys that need consent fail closed with a named question the platform could carry.

### Phase 4 — Platform (control plane)

4a. CI tokens scoped to the Project the repo is connected to (the narrowing the control plane's CI-trust decision record deferred). 4b. Console approval: the build record carries the consent questions, Console shows them, an operator answers, the CI run re-runs with the answers.

- **Builds on:** 4a on nothing beyond `deployment-identity`; 4b on 4a and phase 3.
- **Hands to:** close-out.

## Sequencing

- Stack: 2 → 3 → 4b.
- Parallel: 4a alongside phases 2 and 3.

## Close-out (required)

- [ ] Verify all acceptance criteria in `.drive/projects/node-identity-and-consent/spec.md`
- [ ] Migrate long-lived docs into `docs/` (the ADR; the design notes' decisions and rejected alternatives belong in it)
- [ ] Strip repo-wide references to `.drive/projects/node-identity-and-consent/**`
- [ ] Delete `.drive/projects/node-identity-and-consent/`
