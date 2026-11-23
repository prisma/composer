A caller of Prisma's RoutingUrl API could not tell from `@distilled.cloud/prisma` which refusal it got. Now it can:

```ts
import * as Prisma from "@distilled.cloud/prisma/management";

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

**Refusals told apart only by their message.** `POST /v1/services/{serviceId}/urls` and `PATCH /v1/urls/{id}` answer five different refusals with `409` and `422`. Since 2026-11-20 the spec declares the code of each as an enum on `error.code`:

| route | status | `error.code` |
|---|---|---|
| create, update | 409 | `quota-exceeded`, `logical-id-taken` |
| create | 422 | `invalid-hostname`, `service-not-on-a-branch`, `validation-error` |
| update | 422 | `invalid-hostname`, `service-on-another-branch`, `validation-error` |

The SDK returned all of them as `Conflict` or `UnprocessableEntity`, which keep only the message.

**An error the API no longer returns.** `createWorkspaceDomainOwnership` listed `DomainOwnershipRequired` (422 `domain-ownership-required`). For a valid hostname Prisma now saves the domain ownership and returns it, `verified` when DNS already has the TXT record and `unverified` otherwise; the spec lists a 422 on this route for an invalid hostname only.

Evidence for both is Prisma's published spec, `GET https://api.prisma.io/v1/doc`. No live account was used.

## What changed

Only `packages/prisma`:

- **patch 007**: types the five RoutingUrl refusals on `/error/code`, as patch 005 does for `DomainOwnershipRequired`. `validation-error` and any other code stay `UnprocessableEntity` and `Conflict`.
- **patch 005**: no longer adds `DomainOwnershipRequired` to `createWorkspaceDomainOwnership`. It still types it on `createServiceDomain`, where the spec still documents it.
- **spec mirror** `fc91281` → `e48eb8d` (2026-11-21). Apart from the above, the regeneration adds `Conflict` to `createWorkspace` and a required `state` member to every RoutingUrl output (what the hostname is doing now, such as `waiting_for_dns` or `certificate_failed`); the rest of the diff in `management.ts` is the spec's reworded descriptions of a RoutingUrl's `status` and `records`, and the generator renumbering its schema indexes.

Breaking (`!`): `createWorkspaceDomainOwnership` no longer fails with `DomainOwnershipRequired`; `createServiceUrl` and `updateUrl` can fail with four new typed errors each; `createWorkspace` can fail with `Conflict`; RoutingUrl outputs have a required `state`.

An earlier version of this pull request also exposed the HTTP status of two creates and changed core and the shared generator for it. That is removed, as agreed in the comments.

Checks: `pnpm typecheck:ci`, `pnpm vitest run packages/core packages/prisma`, `pnpm format:check`, `pnpm lint` (0 errors), `pnpm specs:check`, `pnpm patches:audit prisma` (all patches needed).

Agent: prospero-20

🤖 Generated with [Claude Code](https://claude.com/claude-code)

> [!NOTE]
> This comment was left by an agent on behalf of @wmadden
> model: fable 5.2
> harness: Claude Code in the Claude desktop app (Claude Agent SDK 0.3.330)
>
> As an agent I have read the CONTRIBUTING.md and AGENTS.md and understand the risks of getting @wmadden flagged as untrustworthy if I regularly violate the outlined rules
