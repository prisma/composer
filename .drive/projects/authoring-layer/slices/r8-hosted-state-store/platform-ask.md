# Platform ask — workspace-scoped Alchemy state API (Management API surface)

Draft for a Linear ticket (agent sessions have no Linear access — file manually
or via the Ignite gotcha/ask workflow). Target project: platform / Management
API.

## Ask

Implement **Alchemy's HTTP state-store API** as a Management API surface,
workspace-scoped, authorized by service tokens / workspace RBAC.

The contract already exists and ships in the `alchemy` package:
`alchemy/State/HttpStateApi.ts` (`alchemy@2.0.0-beta.59`) — a versioned
HTTP API (`STATE_STORE_VERSION = 5`) with bearer-token auth middleware and a
`/version` probe. Endpoints cover exactly the 12-method `StateService`
interface: list stacks/stages, get/set/delete resource state by
`{stack, stage, fqn}`, delete stack/stage, list FQNs, get/set stack output,
and replaced-resource listing. Payloads are JSON; secret values arrive wrapped
in alchemy's `__redacted__` marker envelope.

## Why

MakerKit deploy state (the Alchemy state store — the source of truth for
"what's provisioned") should be hosted, workspace-scoped platform state:
Terraform-Cloud-style. Today MakerKit ships a client-side interim
(`@makerkit/prisma-alchemy/state`, slice R8): a `StateService` speaking
Postgres directly to a reserved `makerkit-state` project's default database in
the user's workspace, bootstrapped through the Management API, with
session-advisory-lock concurrency control. It works, but:

- auth is "holds a workspace service token" — no finer RBAC;
- the store is visible as a user project (`makerkit-state`) rather than
  ambient platform infrastructure;
- every client must embed the store implementation.

When the platform implements the StateApi:

- deployers switch to alchemy's stock `httpStateStore({ url, authToken })` —
  zero MakerKit code beyond handing it the Management API URL + token;
- the `makerkit-state` project disappears;
- the platform can answer "what's provisioned in this project" natively (the
  inspectable-topology goal's platform half), and server-side runs
  (git-push-style deploys) become incremental.

Design context: `docs/design/03-domain-model/layering.md` (the
provisioning-state spectrum — this is Step 1's final form, enabling Step 2).

## Requirements sketch

- Bearer auth: service tokens; scope state to the token's workspace.
- Storage: platform's choice (the interim proves Postgres tables keyed
  `(stack, stage, fqn)` + `(stack, stage)` for outputs are sufficient).
- Locking: the alchemy interface has none; the platform should provide
  per-`(stack, stage)` lease semantics (the interim uses session advisory
  locks). A `409`-on-concurrent-apply is acceptable v1.
- Version probe: `GET /version` → `5` (the store contract version the client
  was built against; alchemy's client checks it).
- Encryption at rest; values contain provisioning secrets today (see the
  MakerKit deferred item "provisioned credentials → transient platform
  secret" for the longer-term shape).
