# Project Plan — node-identity-and-consent

**Spec:** [spec.md](spec.md) · **Design:** [design.md](design.md)

Handoff plan. Each part below is shipped on its own; the team picking it up splits it into slices. Builds on `deployment-identity`, which must be in production first. Linear project: [Node identity and consent](https://linear.app/prisma-company/project/node-identity-and-consent-9ec5f9f522c0).

## Part 2 — `id` on every node (Composer, then Console)

Every node constructor takes a required `id`; Load builds addresses from `id`s; a node declared with `name` and no `id` fails to load, naming `id`; `prisma deploy --name` is removed; guides, examples and the agent skill use `id`; the decision records listed in the design are amended. Then Console: the setup pull request writes `id`, and the module reader reads it. One Composer release.

- **Needs first:** `deployment-identity` in production, and an answer to the design's first open question.
- **Hands to part 3:** Composer can tell an identity change from any other edit.

## Part 3 — Ask before a database or bucket is deleted (Composer)

Before applying, the deploy computes its plan; each database or bucket it would delete is a question answered by `--delete <address>` or `--rename <old>:<new>`, following the ORM's consent rules; non-interactive runs fail with `CLI.CONSENT_REQUIRED`. `--rename` writes Alchemy rename declarations for the run and updates the row's `logicalId` in place, which the platform already allows for services, databases and buckets. `--delete` may ship first.

- **Needs first:** part 2.
- **Hands to part 4:** a CI deploy that needs answers fails with questions the platform could carry.

## Part 4 — Platform (control plane)

4a. CI tokens scoped to the connected repository's Project. 4b. Console shows a CI deploy's questions and re-runs it with the answers.

- **Needs first:** 4a nothing beyond `deployment-identity`; 4b needs 4a and part 3.

## Sequencing

- In order: 2, then 3, then 4b.
- In parallel: 4a alongside 2 and 3.

## Close-out (required)

- [ ] Verify every DoD condition in [spec.md](spec.md).
- [ ] Move the long-lived design into a Composer decision record under `docs/design/90-decisions/`.
- [ ] Remove references to `.drive/projects/node-identity-and-consent/`.
- [ ] Delete `.drive/projects/node-identity-and-consent/`.
