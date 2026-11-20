# Review of alchemy-run/distilled#1348, as a distilled maintainer would read it

Pull request: `feat(core,prisma)!: HTTP status on REST outputs, and Prisma domain ownership statuses` (draft, head `f3bce8aa6`, base `main` at `51ba3a2c6`). Also reviewed: the planned fifth commit on `draft/routing-url-error-codes` (`625a8ae46`, patch `007-type-routing-url-refusals.patch.json`).

What I read first: `CONTRIBUTING.md`, `AGENTS.md` (all 15 numbered rules), the `distilled-sdk-patch` and `distilled-sdk-update` skills, the maintainers' comments on this contributor's earlier pull requests, and these merged pull requests for the house standard: #1164 and #1195 (core change plus the one provider that needs it, both by Mkassabov), #1310, #1263 and #1303 (provider patches and a runtime fix), and the history of `packages/core/src/protocol-rest.ts`.

## Verdict

The core change is small, correct for every response shape the REST protocol handles, and matches what the AWS, S3 and Cloudflare protocols already do with the same core trait, so the maintainers would likely accept it together with patch 006, as they did for #1164 and #1195. They would not accept the rest in the same pull request: the spec refresh, the patch 005 correction and the planned patch 007 are separate, breaking changes, and the evidence and the description both fall short of rule 7 and of the house style; and the headline promise, that `httpStatus` tells a caller whether it created the resource, is not true once the SDK's own retry policy retries a create.

## Findings, most serious first

### D1. A retried create returns 200 for a resource this call created

Location: patch 006 (member documentation "201 when the call created it, 200 when it already existed"), the pull request body ("so a caller can tell whether a create created anything", "whether it owns what came back").

What happens: the default retry policy (`packages/core/src/retry.ts`, `defaultOptions`) retries every retryable error up to two times without telling the caller. `ServiceUnavailable` (503) is retryable (`packages/core/src/errors.ts:152`), and so is a dropped connection. The spec itself documents this case for `POST /v1/workspaces/{workspaceId}/domain-ownerships`: 503 "The domain ownership was saved with its status, but the platform could not queue the work... Retry the request; it returns the domain ownership with 200." So the first attempt creates the domain ownership, answers 503, the SDK retries, and the caller gets `httpStatus: 200`, meaning "already existed", for a resource it just created. The same happens on either operation when the connection drops after the server has saved the row.

What the maintainer would say: "This is the status of the last attempt, not a record of what the call did. Don't document it as ownership." Sam has pushed back before when an Alchemy-facing design rests on a guess about the wire (alchemy#2696, #3101); he would ask how the Alchemy resource behaves after a retried create.

What I would do: change the member documentation in patch 006 to "The HTTP status of the last attempt: 201 when it created the resource, 200 when the resource already existed. After a retry, a resource this call created can come back with 200." Remove "owns what came back" from the description. Tell the Alchemy pull request (alchemy-run/alchemy#3529) not to treat 200 alone as "someone else's resource". Because Prisma owns this API, the reliable fix is on the platform: an idempotency key, or a body field that says which request created the resource. That would also remove the need for the core change (see "Could this be done without a core change" below).

### D2. Four changes in one pull request, justified by the wrong reason (rule 10)

Location: the whole pull request, and the paragraph "This pull request carries a core runtime change and a Prisma change together... so the Alchemy team reviews one Distilled pull request for this work instead of two."

What it carries:

1. Core: `makeRestProtocol` fills `T.ResponseCode()` members, with four tests.
2. Prisma: the generator binds `smithy.api#httpResponseCode`, and patch 006 adds `httpStatus` to two creates.
3. Prisma: the spec mirror moves from `fc91281` to `fb28505`, which adds `Conflict` to `createWorkspace`, and patch 005 drops `DomainOwnershipRequired` from `createWorkspaceDomainOwnership`.
4. Planned: patch 007, five new error classes on `createServiceUrl` and `updateUrl`, generated from a newer spec than the mirror has.

What the maintainer would say: items 1 and 2 together are fine. Mkassabov's own #1164 (`feat(core,digitalocean)`) and #1195 (`feat(core,boat-dev)`) put a core feature and the one provider patch that needs it in one pull request. Items 3 and 4 have nothing to do with reading the status. They are the breaking parts, and they are what rule 10's example forbids: "patches plus a new credentials precedence are two PRs." The reason given is about the reviewers' convenience, and the reviewers are the same two people either way. When the maintainers have related changes, they stack them (#1310: "Stack 1/5 (#1310 → #1311 → ...)").

Item 3 does not depend on items 1 and 2, and items 1 and 2 do not depend on item 3. The old mirror commit `fc91281` already documents both the 200 and 201 answers on both operations, and already lists the domain-ownerships 422 only as "The domain is not a hostname or a wildcard". So patch 006 applies to `main`'s spec, and the patch 005 correction was already due against `main`'s spec.

What I would do: split into two stacked pull requests.

- `feat(core,prisma): read the HTTP status into T.ResponseCode() members; httpStatus on two Prisma creates`, items 1 and 2. Not breaking, so no `!`.
- `fix(prisma)!: regenerate from the 2026-11-2x spec; drop DomainOwnershipRequired from createWorkspaceDomainOwnership; type the RoutingUrl refusals`, items 3 and 4, once the mirror has the new codes. The skill names patch commits `fix(<pkg>)`, and the merged patch pull requests use `fix` too.

Delete the paragraph about reviewing one pull request instead of two in either case.

### D3. No real request and response anywhere (rule 7)

Location: the "Evidence" paragraph of the body; the descriptions of patches 005, 006 and 007.

What is there: the spec mirror, the statement that it matches the live `GET /v1/doc`, and "the platform change behind item 2 is prisma/pdp-control-plane `routes/v1/workspaces/domain-ownerships.ts`". That repository is private (`gh api repos/prisma/pdp-control-plane` reports `private: true`), so the maintainers cannot open it.

What the maintainer would say: rule 7 asks for "the operation, the request and the real response". The merged patch pull requests show a dated table of live responses (#1310), or say exactly which mocked or local responses they checked and why there was no live account (#1195, #1263). This pull request removes an error from a signature on the strength of a link nobody outside Prisma can read.

What I would do: add a dated table of live calls with the same throwaway hostname:

| Call | Status | Body (trimmed) |
|---|---|---|
| `POST /v1/workspaces/{id}/domain-ownerships` `{ "domain": "<new host>" }`, no TXT record | 201 | `{ "data": { "status": "unverified", "verification": { ... } } }` |
| the same call again | 200 | the same body |
| `POST /v1/services/{id}/domains` `{ "hostname": "<host>" }`, first time | 201 | ... |
| the same call again | 200 | ... |

The first row is the evidence that the 422 is gone. Remove the private repository reference. For patch 007, the spec's enum is acceptable evidence under rule 7 ("the provider's docs"), but show at least one real refusal body so the reader can see that `/error/code` is the right pointer; patch 005's 2026-10-29 probe shows the `{ "error": { "code": ... } }` shape, and saying so is enough.

### D4. The breaking changes are not all named (rule 11)

Location: the body ("This removal is why the title has `!`") and the planned 007.

What is missing: rule 11 counts "a new error type in a signature" as breaking. The regeneration adds `Conflict` to `CreateWorkspaceError`, and patch 007 adds four errors to `CreateServiceUrlError` and four to `UpdateUrlError`. The body names only the 005 removal. It also says "The RoutingUrl 409 and 422 errors stay the generic Conflict and UnprocessableEntity", which becomes false the moment 007 is added.

The title puts `!` on `feat(core,prisma)`, so a reader expects the core change to be breaking. It is not.

What I would do: write the breaking line the way #1310 and #1303 do: "Breaking (`!`): `createWorkspaceDomainOwnership` no longer has `DomainOwnershipRequired`; `createWorkspace` can fail with `Conflict`; `createServiceUrl` and `updateUrl` can fail with `RoutingUrlQuotaExceeded`, `RoutingUrlLogicalIdTaken`, `RoutingUrlInvalidHostname`, and `RoutingUrlServiceNotOnABranch` or `RoutingUrlServiceOnAnotherBranch`." After the split in D2, only the second pull request carries `!`.

### D5. The standard Smithy trait is bound in Prisma's script, not in the shared generator (rules 5 and 6)

Location: `packages/prisma/scripts/generate.ts`, the new `extraBindings` entry.

This does not break rule 3: the entry names a trait, not a member, shape or operation. But `smithy.api#httpResponseCode` is a standard Smithy binding, like `httpLabel`, `httpQuery` and `httpHeader`, which the shared `bindingOf` cascade in `packages/dev/src/codegen/generator.ts` already handles. `extraBindings` exists for provider traits such as `com.distilled.openapi#rawResponse`. The AWS generator already maps the same Smithy trait to the same core symbol (`packages/aws/scripts/spec.ts:250`; `packages/s3/src/traits.ts:152` aliases the core `responseCodeSymbol`).

What the maintainer would say: "Every SDK's `traits.ts` already re-exports `ResponseCode`. Put the binding in the shared cascade, so the next provider that needs it only writes a patch." Rule 6: a problem every SDK has goes in core. Moving it changes no other SDK, because no converter emits the trait; only a patch adds it.

What I would do: move the binding into the shared generator's cascade (next to `httpHeader`) and drop the Prisma entry. The body's line "only the Prisma generator binds `smithy.api#httpResponseCode`, so no other REST client changes" then becomes "no spec converter emits the trait, so no other SDK changes".

### D6. Patch 006: the type says optional, the body says always set; and the description is not a spec bug report

Location: patch 006, generated `httpStatus?: number | undefined`; the body ("consumers may rely on it being set").

The protocol always sets the member on a successful response with an object body, but the patch adds it without `smithy.api#required`, so callers must still handle `undefined`. Either add `"smithy.api#required": {}` to both members, giving `httpStatus: number`, or drop the "may rely on it" sentence. Adding `required` is better: the value is always there.

The skill says each patch description "is the bug report sent upstream". Patch 006 does not correct a wrong spec, since the spec documents 200 and 201 correctly. It adds an SDK feature. A maintainer may ask whether convert should add the member to every operation that documents two 2xx answers. I would keep it as an opt-in patch, since adding it everywhere changes many SDKs, but say plainly in the description that the spec is right and the patch exposes what the spec documents. Also remove "alchemy-run/alchemy's Prisma.CustomDomain refused a 200 before it moved to distilled", which is Alchemy history, not something a provider can act on.

### D7. Patch 007: categories, and the source of the generation

Location: `draft/routing-url-error-codes`, `007-type-routing-url-refusals.patch.json`.

- `RoutingUrlQuotaExceeded` is a 409, so it gets the `ConflictError` category. It is a quota. The skill says a category the status cannot express goes in `distilled.errors#categories`, and core has `QuotaError`. Add `["QuotaError"]`.
- `RoutingUrlLogicalIdTaken` means "already exists". The skill's own example for this is `["AlreadyExistsError"]` on a 409.
- The draft is generated from an unmirrored local spec (rule 8). The commit message says so and says it will be regenerated from the mirror, which is right. The real commit must come from the mirror, and its body should say "the rest of the generated diff is chunk renumbering", as #1263 and #1310 do. The draft's 2,087-line diff is almost all renumbering.
- Matching on `/error/code` with the 409 and 422 statuses follows patch 005 and rule 1's Clerk example. Good.

### D8. Tests were added without asking, and one asserts a mismatched schema (rule 9)

Location: `packages/core/test/protocol-rest.test.ts`, `describe("makeRestProtocol response code members")`.

Rule 9 says "Ask first before you add a test for new runtime behaviour." The maintainers apply this both ways: #1252 and #1152 committed core tests, while #1303 kept its test out "(not committed, rule 9)". A reviewer might accept the 201/200 test and the `T.RawResponse()` test. The "an array body is returned unchanged" test declares a structure output and feeds it an array body, so it asserts behaviour for a schema that contradicts its own response, which no generated SDK produces. A real array body with a status member uses `T.RawResponse()`, which the second test already covers. I would drop the third test, and say in the body that the tests were added without an earlier ask, so the maintainers can drop them if they prefer.

### D9. Smaller points on the core change

- `withResponseCode` and `responseCodeKey` sit in `protocol-rest.ts`. The matching helpers for headers (`withResponseHeaders`, `responseHeaderMembers`) live in `protocol-http.ts` and are shared by protocols. Putting the new helpers next to them matches rule 5. This is a nit.
- The body says "the Cloudflare protocol reads it". The AWS restJson1 protocol (`packages/aws/src/protocols/rest-json.ts:298`) and the S3 restXml protocol (`packages/s3/src/protocols/rest-xml.ts:247`) read it too, and AWS SDKs use it in nine generated files. That is the stronger precedent; cite it.

### D10. The companion Alchemy pull request is not linked (rule 13)

Location: the last paragraph of the body.

It says "The companion alchemy-run/alchemy pull request, `Prisma.RoutingUrl` and `Prisma.DomainOwnership`, depends on this one." Rule 13 asks for a link. The companion is alchemy-run/alchemy#3529, titled "Prisma.RoutingUrl, and Prisma.Website on it", which is not what the body calls it. Link it by number.

## The core change, checked shape by shape

`decodeSuccess` now applies `withResponseCode` after `withResponseHeaders` and before the strict check and the `Redacted` wrapping.

| Response shape | Behaviour | Correct? |
|---|---|---|
| Object body, member present | `{ ...body, [key]: status }` | Yes. A wire key with the same name is overwritten, as Cloudflare does. |
| Empty body (`json === undefined`) | body becomes `{}`, then gets the status | Yes. A 201 or 204 with no body still reports its status. |
| Bare string output (`plan.text`) | unchanged | Yes. There is no member to fill. |
| Array or scalar body without `T.RawResponse()` | unchanged | Yes, but see D8. |
| `T.RawResponse()` member next to the status member | body goes to the raw member, status added | Yes, tested. |
| Binary output | goes through `arrayBuffer` and never reaches `decodeSuccess` | Yes. A binary output is the bytes alone and has no members. |
| Error status (400 and up) | goes through the error path, unchanged | Yes. Errors already carry the status (#1151). |
| Collected framed body (`framing.collect`) | status passed in | Yes. |
| Streamed frames, `items` schema | each frame gets the status if its schema has the member | Harmless. No frame schema has one. |
| Streamed frames, `{ items: [json] }` | status added, then `.items[0]` taken, so it is dropped | Harmless. |
| Paginated operations | each page's output gets its own status | Yes. Prisma has no paginated variants. |
| Strict response validation | the status is in the value before the check | Yes. With `required` (D6) it still passes. |

Cost: the plan computes the member once per schema in a `WeakMap`. For outputs without the member, each response pays one `undefined` check. For the two Prisma outputs, it pays one object spread. The benchmark comment on the pull request shows core bundle +77 B (+0.1%), runtime "same as main", import objects +2, and the Prisma tarball +0.1%. The timing moves it flags with yellow are improvements and are marked as possible runner noise. There is no performance concern.

## Could this be done without a core change?

- Prisma owns the API, so the platform could return a body field that says the call created the resource, or accept an idempotency key. That needs no core change, and it is the only option that also fixes D1.
- A caller could list domain ownerships before creating. That costs two calls and has a race between them.
- The core change as written is small and generic. The generic REST protocol was the only one of the four that ignored a trait core already defines. I would accept it on its own merits, but present it as "the REST protocol now reads `T.ResponseCode()` like the AWS, S3 and Cloudflare protocols", not as the way to learn ownership.

## Rules checked

| Rule | Status |
|---|---|
| 1. Fix a spec with a patch | Met. 005, 006 and 007 are patches. |
| 2. Do not edit generated files | Met. `management.ts` changes come from regeneration. |
| 3. No special case in a script | Met, but see D5: the binding is generic, in the wrong layer. |
| 4. Never crash a fiber | Met. The new code cannot throw. Lint passes. |
| 5. Reuse core | Met: it uses the existing `T.ResponseCode()`. Nit in D9. |
| 6. Fix it where the problem lives | Strained, see D5. |
| 7. Show the failing call | Broken, see D3. |
| 8. Official spec through the mirror | Met for commits 1 to 4. The 007 draft is from an unmirrored spec; it must be regenerated (D7). |
| 9. No tests without asking | Strained, see D8. |
| 10. One change per pull request | Broken, see D2. |
| 11. Mark breaking changes | `!` is present, but the breaking changes are not all named, and the core part is wrongly marked (D4). |
| 12. Regenerate, stamp and format | Met. `generatedAt` and `specUpdatedAt` are 2026-11-19, and the format check passes. |
| 13. Pair with the Alchemy pull request | Strained: not linked by number (D10). |
| 14. Allow edits by maintainers | Met (`maintainerCanModify: true`). |
| 15. Routing value is a param and a layer | Not relevant. |

## CI

All 16 checks pass: Benchmarks, Bundlers, formatting, the five compatibility jobs, Lint, the preview packages, Test, both Typecheck jobs, and Website. Cleanup and Deploy were skipped, which is normal for a pull request. The merge state is `CLEAN`. There are no failures to report.

## Title and description

Title: `feat(core,prisma)!: HTTP status on REST outputs, and Prisma domain ownership statuses`.

- "Prisma domain ownership statuses" does not describe any change. The `status` field (`unverified`, `verified`, `expiring`) is already on `main`. What changed is that one create no longer fails with `DomainOwnershipRequired`, and two creates gain `httpStatus`.
- `!` on `core,prisma` suggests the core change breaks something. It does not.
- Merged titles name the operation and what callers gain, for example `fix(cloudflare)!: type user.verifyToken's 401 code 1000 as InvalidApiToken`. After the split in D2, use the two titles proposed there.

Description, what must go:

- The paragraph that justifies bundling for the reviewers' convenience (D2).
- The private `prisma/pdp-control-plane` reference (D3).
- "so consumers may rely on it being set", unless `required` is added (D6).
- "The RoutingUrl 409 and 422 errors stay the generic Conflict and UnprocessableEntity", which 007 makes false.
- "Agent: prospero-20" means nothing to a distilled maintainer. If the author's process requires it, keep it, but know it reads as noise upstream.

What is missing:

- The live request and response table (D3), with a date.
- A complete "Breaking (`!`):" line (D4).
- The spec update record the update skill asks for: mirror `fc91281` → `fb28505`, the operation count before and after, and the patches kept with what the spec still gets wrong.
- The AWS and S3 precedent for the trait (D9).
- The companion link, alchemy-run/alchemy#3529 (D10).
- The retry limitation (D1).
- A note that the rest of the generated diff is chunk renumbering.

What a reader who has not followed the work cannot understand:

- What "owns what came back" means. It is Alchemy's question of whether to adopt an existing resource, and the body never says so.
- Why `createWorkspaceDomainOwnership` used to fail with `DomainOwnershipRequired` and what replaced it. The body should say: before 2026-11-06 the platform answered 422 `domain-ownership-required` for a hostname with no TXT record; now it saves the domain ownership as `unverified` and answers 201.
- What "RoutingUrl" is. No operation is named; the operations are `createServiceUrl` and `updateUrl`.

What it does well: it opens with a code example of what a caller gets, as #1164 and #1195 do; it lists the exact checks run; and the core section explains the mechanism in two numbered steps. The order should change so the problem comes first (the "Why:" paragraph sits after the mechanism), and the merged pull requests' "The failing call" section is the model to follow.
