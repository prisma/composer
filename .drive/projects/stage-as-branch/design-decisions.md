# Design decisions — stage-as-branch slice

Numbered log of mid-flight decisions that amend the spec/plan. Each records the
trigger, what was learned, the decision, and the affected artefacts (Drive I12).

## 1. Branch idempotency is client-side; the API has no `ifExists` field

- **Trigger:** falsified assumption, found during D1 implementation. Spec §4 and plan
  D1 described creating a Branch "via `POST /v1/projects/:id/branches` (`ifExists:
  "return"`)" as if server-side create-or-return idempotency existed.
- **Learned:** it does not. Verified against `@prisma/management-api-sdk@1.47.0` (and
  the live OpenAPI): `POST /v1/projects/{projectId}/branches` accepts only `gitName` +
  `isDefault` (`additionalProperties: false`); a duplicate `gitName` returns `409`. The
  matching read, `GET …/branches?gitName=X`, **is** a real server-side exact-match
  filter returning ≤1 row.
- **Decision:** keep the spec's *outcome* (idempotent create-if-absent keyed by
  `gitName`) and implement idempotency client-side: observe via `GET ?gitName=`, `POST`
  only when absent, and on a racing `409` re-observe and adopt the winner. This mirrors
  the adopt-oldest/tolerate-races idiom already in `state/bootstrap.ts`. The mechanism
  changed; no architectural decision changed.
- **Affected:** spec §4 (rewritten), plan D1 (rewritten), `packages/alchemy/src/container.ts`
  (`resolveBranch`). Confirms spec §4's positional-role note: the API doc states the first
  Branch is `role=production`, later Branches `role=preview`, server-owned regardless of
  body — so explicit role control stays deferred.
