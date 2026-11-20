Two things a caller of Prisma's hostname API could not tell from `@distilled.cloud/prisma`, and now can: whether a create made the resource or found it, and which refusal it got.

```ts
import * as Prisma from "@distilled.cloud/prisma/management";

// 1. did this call create it?
const ownership = yield* Prisma.createWorkspaceDomainOwnership({ workspaceId, domain: "*.example.com" });
ownership.httpStatus; // 201 created, 200 the workspace already had it

// 2. which refusal?
yield* Prisma.createServiceUrl({ serviceId, hostname: "api.example.com", logicalId: "api" }).pipe(
  Effect.catchTags({
    RoutingUrlQuotaExceeded: () => …,       // 409 quota-exceeded
    RoutingUrlLogicalIdTaken: () => …,      // 409 logical-id-taken
    RoutingUrlInvalidHostname: () => …,     // 422 invalid-hostname
    RoutingUrlServiceNotOnABranch: () => …, // 422 service-not-on-a-branch
  }),
);
```

alchemy-run/alchemy#3529 (`Prisma.RoutingUrl`, `Prisma.DomainOwnership`) is the caller, and depends on this.

## The failing calls

**A create that answers 201 or 200 with the same body.** `POST /v1/workspaces/{workspaceId}/domain-ownerships` and `POST /v1/services/{serviceId}/domains` are idempotent. The spec documents `201` when the call created the resource and `200` when it already existed, and the body is the same in both. The SDK returned only the body, so Alchemy could not tell a domain ownership it had just created from one another stack or a person had made, which decides whether it may delete it later.

**Refusals told apart only by their message.** `POST /v1/services/{serviceId}/urls` and `PATCH /v1/urls/{id}` answer five different refusals with `409` and `422`. Since 2026-11-20 the spec declares the code of each as an enum on `error.code`:

| route | status | `error.code` |
|---|---|---|
| create, update | 409 | `quota-exceeded`, `logical-id-taken` |
| create | 422 | `invalid-hostname`, `service-not-on-a-branch`, `validation-error` |
| update | 422 | `invalid-hostname`, `service-on-another-branch`, `validation-error` |

The SDK returned all of them as `Conflict` or `UnprocessableEntity`, which keep only the message.

**An error the API no longer returns.** `createWorkspaceDomainOwnership` listed `DomainOwnershipRequired` (422 `domain-ownership-required`). Prisma now always saves the domain ownership and returns it with `status: "unverified"` until DNS has the TXT record; the spec lists that 422 on this route for an invalid hostname only.

Evidence for all three is Prisma's published spec, `GET https://api.prisma.io/v1/doc`, at the mirror commit below. No live account was used.

## What changed

- **core/protocol-rest**: an output member marked `T.ResponseCode()` is filled with the response's status. The trait already existed, and the AWS restJson1, S3 and Cloudflare protocols already read it; the generic REST protocol did not. An output without the member is unchanged, and so is an array, scalar, raw or streamed body.
- **dev/codegen**: `smithy.api#httpResponseCode` binds to `T.ResponseCode()` in the shared binding cascade, next to `httpHeader`. No converter or other patch emits the trait, so no other SDK's output changes (checked by regenerating AWS, the one SDK whose models contain it).
- **prisma, patch 006**: adds a required `httpStatus` member to the two create responses above. The spec is correct; this is an SDK addition.
- **prisma, patch 007**: types the five RoutingUrl refusals on `/error/code`, as patch 005 does for `DomainOwnershipRequired`. `validation-error` and any other code stay `UnprocessableEntity` and `Conflict`.
- **prisma, patch 005**: no longer adds `DomainOwnershipRequired` to `createWorkspaceDomainOwnership`. It still types it on `createServiceDomain`, where the spec still documents it.
- **prisma, spec mirror** `fc91281` → `<mirror commit>`. Apart from the above, the regeneration adds `Conflict` to `createWorkspace`; the rest of the diff in `management.ts` is the generator renumbering its schema indexes.

`httpStatus` is the status of the last attempt. The client retries a create on its own after a `503` or a dropped connection, so a resource this call created can come back with `200`. A caller that must know for certain passes a retry policy that does not retry the create; Alchemy does.

Breaking (`!`), all in `@distilled.cloud/prisma`: `createWorkspaceDomainOwnership` no longer fails with `DomainOwnershipRequired`; `createServiceUrl` and `updateUrl` can fail with four new typed errors each; `createWorkspace` can fail with `Conflict`. The core change breaks nothing.

Three new cases in `packages/core/test/protocol-rest.test.ts` cover the new runtime behaviour (a 201 and a 200 reach the member; it sits beside a `T.RawResponse()` member; an output without it is unchanged). I did not ask first; say if you would rather not have them.

Checks: `pnpm typecheck:ci`, `pnpm vitest run packages/core packages/prisma`, `pnpm format:check`, `pnpm lint` (0 errors), `pnpm specs:check`, `pnpm patches:audit prisma` (all patches needed).

## Alternatives considered

- **Two pull requests**, the status in one and the Prisma spec changes in the other. They are together because Alchemy's hostname resources need both at once and one companion pull request pins one Distilled commit. The commits are separate if you want them split.
- **A `created` field in Prisma's response body**, so no status is needed. It is the better long-term answer and would also survive a retry; it is a platform change we have not made, and other APIs answer creates the same way.
- **Reading the status from `T.RawResponse()`** in the caller. It works, but every caller would then decode the body itself.

Agent: prospero-20

🤖 Generated with [Claude Code](https://claude.com/claude-code)
