# P1 code review: `publicUrl()` with both strategies

Range: `git diff origin/main...HEAD` on `claude/public-url-p1`. Spec: [spec.md](../spec.md). Plan: [plan.md](../plan.md). Lens: principal engineer.

Read for this review: the slice spec and plan, design note 12 in `design-notes.md` (and notes 1 and 2 for the platform's behaviour), `CLAUDE.md`, `.agents/rules/README.md`, `no-bare-casts.mdc`, `exports-entrypoints.mdc` and `user-facing-surface-changes.mdc`, and the pinned Alchemy release's `Prisma/CustomDomain.ts` (2.0.0-beta.83). The worktree has no `node_modules`, so I did not run the tests; every verdict below comes from reading the code and the test assertions.

## Summary

The slice builds what the spec asks for, and the central safety property holds: a hostname change that the platform refuses never deletes the serving custom domain, and a test proves it with the real Alchemy apply engine. The gaps are failure modes the spec did not cover: two public URLs with the same hostname, a hostname on a preview environment, moving a hostname to another service, and a hostname whose TXT record exists but whose CNAME does not.

## What looks solid

- The hostname is part of the custom domain's Alchemy resource id. A hostname change is therefore a create plus a removal, and Alchemy runs every create before it deletes anything. This is the cheapest way to get the protection design note 12 asks for.
- `public-url-apply.test.ts` uses the real `Prisma.CustomDomainProvider`, the real `PrismaClientLive`, the real `Core.scratchStack` apply and in-memory state. Only the HTTP client is fake. It is not a mock of Alchemy's ordering. The third test also proves the opposite case: an accepted change creates the new domain and then deletes the old one.
- `app` comes from `deployment.appId`, not from the App. The custom domain therefore waits for the promote. The lowering test makes the mocked `Deployment` return a distinct `appId`, so the assertion proves which resource the value came from.
- One function, `parseHostname`, normalizes hostnames at construction, in the preflight and in the descriptor. The id and the `hostname` prop use the same normalized string. Alchemy's own `normalizeHostname` applies the same trim, trailing-dot and lowercase rule, so the two never disagree.
- The dev preflight checks every public URL before it writes anything (`publicUrlStrategies` runs before `movePreEnvironmentDevState`). A test asserts that `.prisma-composer` was not created.
- A domain attached in the Console is refused, as spec section 5.4 says. `CustomDomain` is not piped through `asOwnRow`, so Alchemy's `read` returns `Unowned` and the engine refuses to adopt it.

## Findings

### F01. Two public URLs that name the same hostname fail halfway through the apply, with a misleading error

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/public-url.ts` lines 118–127 (`publicUrlStrategies`); `src/preflight.ts` line 367; `src/local-target/preflight.ts` lines 102–108.
- **Issue:** Nothing checks that hostnames are unique. Two public URLs with the hostname `shop.com` get two resource ids (`shop.a.domain.shop.com` and `shop.b.domain.shop.com`). Alchemy reconciles them concurrently. One POST succeeds. The other either finds the domain through `findDomain` and fails with "is not owned by this resource. Import it with explicit adoption", or gets a conflict and fails with "appeared after the adoption check". The service has already been deployed, one custom domain exists, and the error tells the user to adopt something, which Composer cannot do. Every later deploy fails the same way. The same happens across two services. Under `prisma dev` the local provider accepts both, so the mistake shows up only at deploy.
- **Suggestion:** In `publicUrlStrategies`, or in a small helper that both preflights call, fail when two public URLs resolve to the same hostname. Name both addresses and the hostname: `shop.a and shop.b both name the hostname shop.com. One hostname serves one public URL.` Add a test in `public-url.test.ts` (deploy preflight) and one in `local-target-preflight.test.ts`.

### F02. With the pinned Alchemy, a named hostname in a preview environment fails only after the service has been deployed, and the guide does not say so

- **Location:** `src/preflight.ts` line 367; `docs/guides/building-an-app.md` section "Before you name a hostname"; the skill paragraph "Public URLs".
- **Issue:** Alchemy beta.83's `ensureDefaultBranchApp` refuses a custom domain on an App that is not on the default Branch. A deploy of `pr-42` with `url: 'pr-42.preview.shop.com'` builds, uploads and promotes the service, and only then fails with "Prisma custom domains can only be attached to apps on the default Branch." The guide tells the user to publish DNS records, which does not help in this case. Spec section 10 says the pin moves before the PR opens if the release exists. If it does not exist, this case ships.
- **Suggestion:** If the pin still predates alchemy-run/alchemy#2696 when the PR opens, make the deploy preflight fail when a public URL names a hostname and the container has a `branchId` (the same test `classFor` uses for preview). The message should say that a named hostname works only in the production environment for now, and that a preview should use `publicUrl.prismaBuild()`. Add one sentence to the guide and the skill. Remove the check and the sentence when the pin moves. If the pin moves first, this finding is closed.

### F03. The proof that a serving hostname is never replaced covers only a missing TXT record, not a missing CNAME

- **Location:** `src/__tests__/public-url-apply.test.ts` lines 85–98 (the fake refuses only with `domain-ownership-required`); guide section "Before you name a hostname", last paragraph; skill paragraph "Public URLs".
- **Issue:** Design note 12's second rule covers a hostname "whose ownership is not verified or whose DNS does not point at the platform". P1 relies on the platform refusing the POST in both cases. The TXT case is documented (prisma/pdp-control-plane#5785, a 422). The CNAME case rests on design note 1's statement that Foundry's `registerDomain` refuses at once. The Alchemy provider, however, models `status: 'pending_dns'` and `'failed'` on a created domain and retries a failed one. That suggests the platform can store a domain whose DNS is not ready. If the POST succeeds when the TXT record is published but the CNAME is not, the create succeeds, Alchemy deletes the old domain right after, and the serving hostname goes down. That is exactly what design note 12 forbids. The guide and the skill state the protection for both records without qualification.
- **Suggestion:** In the D4 live run, deploy a hostname whose TXT record is published and whose CNAME is not. Record whether the POST is refused. If it is refused, add a second refusal code to the fake and to the second apply test, so both records are covered. If it is accepted, the guide and the skill must say that the protection covers only the ownership record, and design note 12 needs a decision from Will before P1 merges.

### F04. "Before anything is created" is not true for a deploy to a new environment, nor for `prisma dev --fresh`

- **Location:** spec AC 3 and section 4; `docs/guides/building-an-app.md` ("stops `prisma deploy` and `prisma dev` before anything is created"); the skill ("fails deploy and dev before anything is created"); `packages/0-framework/3-tooling/cli/src/operations/execute-deploy-destroy.ts` lines 452–514; `execute-dev.ts` lines 208–220.
- **Issue:** The deploy pipeline runs `extension.container.ensure` before the preflight. For an environment deployed for the first time, that creates the Branch, and with `--create` the Project, before a bad `url` is reported. Under `prisma dev --fresh`, the teardown runs before the preflight, so a bad `url` stops the session after the dev state has been wiped. The tests call `runPreflight` and `runDevPreflight` directly, so they cannot see this.
- **Suggestion:** Do not move the check. That would need a core hook that runs before containers are resolved, which is out of scope. Change the spec's wording, the guide and the skill to what is true and matches the existing preflight contract: the deploy fails "before any of the app's resources is created or changed". If Will wants the stronger guarantee, record it in `.drive/deferred.md` as a core change.

### F05. Moving a hostname to another service fails the deploy, and nothing tells the user how to do it

- **Location:** `src/descriptors/public-url.ts` lines 53–56; guide section "Making a service public".
- **Issue:** The resource id is the address plus the hostname, so rewiring `target` from `web` to `web2` keeps the same id and changes `app`. Alchemy then refuses the change. If the new App id is known when the plan is made, the diff fails with "cannot atomically replace custom domain". Otherwise the reconcile fails with "Refusing to claim convergence; replace the mismatched domain." Both messages talk about Alchemy resources, which the user never declared. Renaming the public URL does not help either: the new domain is created before the old one is deleted, and the platform will not attach the same hostname twice. The only way through is two deploys, one that removes the public URL and one that adds it back, with the hostname down in between.
- **Suggestion:** Add one paragraph to the guide and one sentence to the skill. They should say that moving a hostname to another service takes two deploys in P1, and that the hostname is down between them. Add a lowering or apply test that pins the current refusal, so that P2's in-place move is a visible change in behaviour. The in-place move itself belongs to P2's RoutingUrl and goes under Deferred.

### F06. The example's smoke test crashes, instead of failing cleanly, when the reported URL has no scheme

- **Location:** `examples/env-param/scripts/smoke.ts` lines 123–126; `src/descriptors/public-url.ts` line 49.
- **Issue:** The smoke test already allows for `appEndpointDomain` having no scheme (`domain.startsWith('http') ? domain : \`https://${domain}/\``). The `prisma-build` entity's `url` is that same `appEndpointDomain` output, unchanged, so `new URL(siteUrls[0])` throws `TypeError: Invalid URL` when the domain has no scheme. The two strategies would then also report URLs of different shapes: `https://shop.com` for a hostname, and a bare domain for `prisma-build`. The spec's at-a-glance output shows `https://…` for both.
- **Suggestion:** In the smoke test, normalize `siteUrls[0]` with the same rule before comparing. In the descriptor, map the `prisma-build` URL through `Output.map` so it always has the `https://` scheme, the same shape as the hostname entity. The AC 9 live run settles which form the platform returns.

### F07. No test covers a hostname change under the local providers

- **Location:** `packages/1-prisma-cloud/0-lowering/local-target/src/__tests__/custom-domain-provider.test.ts`.
- **Issue:** The test proves that a second identical run converges and makes no network calls. It does not cover a hostname change, which the brief asked about. Reading the code, the change works: the new id is reconciled, and the old id's `delete` does nothing. Nothing pins that behaviour, though, and a later change to `list` or `delete` could make `prisma dev` call out or fail.
- **Suggestion:** Add a case that deploys `shop.site.domain.shop.com` and then `shop.site.domain.new.shop.com` on the same stack. Assert the second output and that `fetch` was never called. Also make the fixture id use the real id form (`…domain.shop.com`, not `…domain.shop-com`).

### F08. Nothing tests that `executeDev` passes the warning through

- **Location:** `packages/0-framework/3-tooling/cli/src/operations/execute-dev.ts` lines 227–232.
- **Issue:** AC 8 is proven piece by piece. `runDevPreflight` calls `warn`, the command renders a `target-warning` event (through an operations double), and the local provider calls nothing. Nothing tests the line in `executeDev` that connects `warn` to `emit`, and nothing runs `prisma dev` end to end. No test harness for `executeDev` exists, so a unit test would cost more than it is worth here.
- **Suggestion:** Cover this in D4's manual QA. Run `prisma dev` on `examples/env-param` with `url: 'shop.com'`, and confirm three things: the warning prints exactly once, the service serves, and a second `prisma dev` against the persisted dev state converges. Record the output in the slice's QA notes.

### F09. `parseHostname` reports some host-and-port strings as IP addresses

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/public-url.ts` line 33 and lines 43–46.
- **Issue:** `IPV6` accepts any run of hex characters followed by a colon. `cafe:8080` or `abc:443` is therefore reported as "is an IP address" instead of "has a port". The input is still rejected, but the message sends the user the wrong way.
- **Suggestion:** Treat a name as IPv6 only when it starts with `[` or contains at least two colons. Otherwise let the port check run. Add `cafe:8080` to the invalid-hostname table with "has a port". (The single-label case is already rejected for having fewer than two labels, but the message should still be right.)

### F10. The skill says `prisma dev` warns for every public URL

- **Location:** `skills/prisma-composer-core-concepts/SKILL.md`, "Public URLs" paragraph: "`prisma dev` ignores a named hostname and warns once per public URL."
- **Issue:** It warns once per public URL that names a hostname. A `prisma-build` public URL gives no warning. The guide gets this right, and the skill must not disagree with the guide (`user-facing-surface-changes.mdc`).
- **Suggestion:** Change the sentence to "warns once per public URL that names a hostname".

## Deferred (out of scope)

- **An interrupted create leaves a custom domain that Composer then refuses as not its own.** If the deploy process dies after the POST succeeds but before Alchemy saves state, the next deploy's `read` finds the domain by hostname and returns `Unowned`. The deploy then fails with "not owned by this resource. Import it with explicit adoption", and the user has to delete the domain in the Console. Compute rows avoid this with `asOwnRow` and their `logicalId` (ADR-0057). A custom domain has no `logicalId`, and adopting by hostname would also adopt domains attached in the Console, which spec section 5.4 rules out. Out of scope because the fix is P2's RoutingUrl, which carries the address as its `logicalId`. Record it in `.drive/deferred.md` next to the `deploy list` entry so that P2 picks it up.
- **Moving a hostname to another service in one deploy** (see F05). It needs the RoutingUrl to change its service in place, which is P2.
- **Adopting a domain attached in the Console.** Spec section 5.4 defers it to U2 and P2. The behaviour today matches the spec: the domain is refused with Alchemy's error. No test pins it, which is acceptable for a deferred feature.

## Already addressed

None. This is the first review round.

## Acceptance-criteria verification

| AC | Verdict | Detail |
| --- | --- | --- |
| AC1: `publicUrl()` builds a `public-url` resource with one `target` slot and `props.url`; a non-HTTP target is a type error | **PASS** | `public-url.ts` lines 134–162 call `resource()` with `type: 'public-url'`, `inputs: { target: rawHttp() }` and `props: { url }`. `public-url.test.ts` lines 19–41 assert the kind, type, extension, that there is no `provides`, the input keys `['target']`, the props, and the graph edge `shop.web → shop.site` on input `target`. `public-url.test-d.ts` uses `@ts-expect-error` to show that an RPC interface, a Postgres interface and a whole provisioned ref are each rejected. |
| AC2: a missing `url`, or an invalid hostname as a string or through `publicUrl.hostname()`, throws at construction, naming the public URL and the problem | **PASS** | `public-url.test.ts` lines 43–86 assert the exact message for a missing `url`, and for eleven invalid inputs, each as a string, as a `HostnameStrategy` literal and through `publicUrl.hostname()`. Each message names `publicUrl("site")` and the problem. (F09 is a wrong message for an input outside this table.) |
| AC3: a `resolve()` value that resolves to a string or a strategy lowers per section 5; anything else fails deploy and dev before anything is created, naming the address | **WEAK** | Lowering: `control-lowering.test.ts` (`test.each`) asserts one `CustomDomain` for a string or a hostname strategy and none for `prisma-build`. The failure path: `public-url.test.ts` lines 156–193 assert that `runPreflight` throws `shop.site: url resolved to 42 …` with zero platform calls. `local-target-preflight.test.ts` asserts the same for `runDevPreflight` and that nothing was written. The tests call the preflights directly. In the real pipeline, `container.ensure` runs first and can create a Branch, and `dev --fresh` tears down the dev state first (F04). So "before anything is created" is proven for the preflight itself, not for the commands. |
| AC4: `prisma-build` declares no Alchemy resource and reports one `public-url` entity at the target service's URL | **PASS** | `descriptors/public-url.ts` lines 46–51. The `control-lowering.test.ts` test "prisma-build declares no resource…" asserts that no `CustomDomain` was recorded, and that the result is exactly `{ outputs: {}, entities: [{ kind: 'public-url', id: 'svc_123', url: 'https://svc_123.cdg.prisma.build', details: {} }] }`. |
| AC5: a hostname declares one `CustomDomain` whose id contains the hostname and whose `app` comes from the target's deployment; the entity URL is `https://<hostname>` | **PASS** | One test asserts that exactly one `CustomDomain` was recorded, `['shop.site.domain.shop.com', { app: 'svc_123', hostname: 'shop.com' }]` (from the input `Shop.COM.`), and the entity `{ id: …#cloud-id, url: 'https://shop.com', details: { hostname, status } }`. A second test runs core's `lowering()` with the compute descriptor and asserts `app: 'deployment-app-of:shop.web.deployment'`. That value can come only from `deployment.appId`, which the mocked `Deployment` returns. |
| AC6: a public URL wired to a module's forwarded HTTP interface lowers against the concrete service inside it | **PASS** | The test "a module's forwarded HTTP interface…" runs core's `lowering()` over `shop → storefront → web`. It asserts `app: 'deployment-app-of:shop.storefront.web.deployment'`, which proves that the edge resolves to the inner service. |
| AC7: a deploy naming a hostname the platform refuses fails, and the upstream error reaches the user unchanged | **PASS** | `public-url-apply.test.ts` lines 183–195: under the real apply engine and provider, a 422 `domain-ownership-required` makes the deploy fail. The test asserts that the failure contains `Prisma Management API request failed (domain-ownership-required)`, that a POST was made, and that no domain exists. Composer adds no wrapping between Alchemy and the error. AC 11 checks the CLI rendering live. |
| AC8: `prisma dev` with a hostname public URL creates nothing for it, warns once per public URL, and runs | **WEAK** | Each piece has a test. The local provider makes no `fetch` call and converges on a second run (`custom-domain-provider.test.ts`). The dev preflight gives exactly two warnings for two hostname URLs and none for `prisma-build`, in both `dev` and `staging`. The command renders a `target-warning` event as `severity: 'warn'` (through an operations double). Nothing tests the `executeDev` line that connects them, and nothing proves "and runs" end to end (F08). |
| AC9: live, the example deploys to production and to a preview with a `prisma-build` public URL, and the summary and topology show it | **NOT VERIFIED** | A live check that the orchestrator runs in D4. The smoke-test change that supports it has the scheme problem in F06. |
| AC10: changing to a hostname the platform refuses fails and does not delete the old custom domain, under the real Alchemy apply engine | **PASS** | `public-url-apply.test.ts` lines 197–215 use `Core.scratchStack`, the real `Prisma.CustomDomainProvider` and `PrismaClientLive`, and a fake `HttpClient`. The first apply creates `shop.com`. The second, to `new.shop.com`, which the fake refuses with 422, fails with the upstream error. The test asserts that a POST was made, that no `DELETE` request was sent, and that the platform still holds exactly `['shop.com']`. The ordering is Alchemy's own, not a mock. The descriptor runs with a hand-built `lowered` map instead of the compute service, which does not affect the ordering under test. F03 covers what this test cannot cover, the missing-CNAME case. |
| AC11: live, a deploy naming a hostname with no records fails as AC 7 says | **NOT VERIFIED** | A live check that the orchestrator runs in D4. Add the F03 case (TXT published, no CNAME) to the same run. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 7 | AC1, AC2, AC4, AC5, AC6, AC7, AC10 |
| FAIL | 0 | |
| NOT VERIFIED | 2 | AC9, AC11 |
| WEAK | 2 | AC3, AC8 |
