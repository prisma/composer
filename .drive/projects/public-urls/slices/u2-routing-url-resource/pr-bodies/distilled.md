Let REST outputs read the HTTP status, and use it in `@distilled.cloud/prisma` so a caller can tell whether a create created anything.

```ts
const created = yield* createWorkspaceDomainOwnership({ workspaceId, domain: "api.example.com" });
created.httpStatus; // 201 when this call created it, 200 when the workspace already had it
created.data.status; // "unverified" | "verified" | "expiring"
```

This pull request carries a core runtime change and a Prisma change together. Distilled's rules prefer them apart; they are together on purpose, so the Alchemy team reviews one Distilled pull request for this work instead of two.

### Core: `T.ResponseCode()` in the REST protocol

`makeRestProtocol` now fills an output member marked `T.ResponseCode()` with the HTTP status.

```ts
const CreatedOutput = S.Struct({
  id: S.optional(S.String),
  httpStatus: S.optional(S.Number.pipe(T.ResponseCode())),
});
// 201 -> { id: "t1", httpStatus: 201 }
// 200 -> { id: "t1", httpStatus: 200 }
```

1. The decode plan records which output member, if any, carries `T.ResponseCode()`. The trait already existed in core and the Cloudflare protocol reads it; the generic REST protocol did not.
2. After the body is mapped and the response headers are copied in, that member is set to the status. Outputs without the member are unchanged, and an array or scalar body is returned as it is.

The change does nothing without a `T.ResponseCode()` member, and only the Prisma generator binds `smithy.api#httpResponseCode`, so no other REST client changes.

`makeRestProtocol` always fills a `T.ResponseCode()` member on a successful response with an object body, so consumers may rely on it being set.

Why: some APIs answer an idempotent create with 201 when they create the resource and 200 when it already existed, with the same body in both cases. Without the status a caller cannot tell whether it owns what came back.

### Prisma

1. `createServiceDomain` and `createWorkspaceDomainOwnership` responses get an `httpStatus` member (patch 006). The spec documents 201 when the call created the resource and 200 when it already existed. `scripts/generate.ts` maps `smithy.api#httpResponseCode` to `T.ResponseCode()`.
2. `createWorkspaceDomainOwnership` no longer fails with `DomainOwnershipRequired`. The platform now always saves the domain ownership and returns it as `unverified` until DNS has the record. Patch 005 no longer adds the error to that operation. It still types the error on `createServiceDomain`, where the spec still documents the `domain-ownership-required` 422. This removal is why the title has `!`.
3. The spec mirror moves to 2026-11-19 (`fb28505`). That regeneration also adds `Conflict` to `createWorkspace`.

No exported operation was renamed or removed. The RoutingUrl 409 and 422 errors stay the generic `Conflict` and `UnprocessableEntity`.

Evidence: the spec mirror at 2026-11-19, which matches the live `GET https://api.prisma.io/v1/doc`. The platform change behind item 2 is prisma/pdp-control-plane `routes/v1/workspaces/domain-ownerships.ts`.

Checked:

- `pnpm typecheck:ci`
- `pnpm vitest run packages/core` and `pnpm vitest run packages/prisma` (four new cases in `packages/core/test/protocol-rest.test.ts`: a 201 and a 200 reach the member; the member sits next to a `T.RawResponse()` member; an array body comes back unchanged; an output without the member is unchanged)
- `pnpm format:check`, `pnpm lint`, `pnpm specs:check`
- `pnpm patches:audit prisma`: patches 005 and 006 are both needed

The companion alchemy-run/alchemy pull request, `Prisma.RoutingUrl` and `Prisma.DomainOwnership`, depends on this one.

Agent: prospero-20

🤖 Generated with [Claude Code](https://claude.com/claude-code)
