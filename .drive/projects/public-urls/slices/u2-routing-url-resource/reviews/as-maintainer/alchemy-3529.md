# Review of alchemy-run/alchemy#3529, as Sam Goodwin would write it

Pull request: `feat(prisma)!: Prisma.RoutingUrl, and Prisma.Website on it` (draft, head `1d015760`, 16 commits, 42 files, +5,351 / −1,088).

## Verdict

I would not merge this. The core idea is right and urgent: `Prisma.Website` has to move off the custom domain routes before Prisma deletes them around 2026-12-21, and `Prisma.RoutingUrl` is the right replacement. But the pull request pins Distilled to a commit marked "not for review or merge", tests almost everything against a fake Prisma API after I asked on #2696 not to do that, and carries a large client-side DNS checker for a problem the Prisma API should solve. It also lets a RoutingUrl take over another stage's row by `logicalId` alone, which `Prisma.App` already refuses to do.

What I would send back, in one line: pin Distilled to `main`, replace the fake suites with live tests that you have run, drop the hostname-change check (fix it in the Prisma API), make `logicalId` ownership work like `Prisma.App`, and move `Prisma.DomainOwnership` and the `Prisma.CustomDomain` extras out.

## What I read

- `AGENTS.md`: Concepts, Reconciler doctrine, Resource and runtime testing conventions, Test Fixtures for Effect-Native Workers / Functions, Typed Error Doctrine, Provider Modes, Pull Request Conventions, Blog / Release Notes Conventions, the speed doctrine and the entitlement pattern.
- `.claude/skills/audit/SKILL.md` and `procedure.md` (followed below), `.claude/skills/alchemy-provider/review.md` (the provider checks), `.claude/skills/release-blog/SKILL.md` (how a breaking change is picked up).
- My earlier comments on this contributor's pull requests (#2696, #1061, #2154, #3101).
- My #2701 and #2698, which this replaces. #2701 deleted the fake-client domain tests (`ManagementLifecycle.test.ts`, part of `Resources.test.ts`) and tested `Prisma.DomainOwnership` live only.
- Merged provider pull requests for the house standard: #3306 (AI Gateway prop), #3298 (Stripe Price tiers), #3326 (Containers dockerfile fix, breaking), #3339 (Stripe idempotency keys, Distilled bump), #3418 (Stripe thin events). Those with behaviour changes extend the resource's existing suite through real deploys (live, or local Docker for #3326) instead of adding a new file; #3339 pins Distilled to a `main` commit and says plainly that the Stripe live tests did not run. Each has a short description that leads with user code. #3326 shows the breaking change as a before/after `diff`.
- Existing mechanisms on `main`: `Prisma.App`'s `logicalId` handling (`packages/prisma/src/App.ts:365-395`), the Website DNS wiring it replaces (`Website/FrameworkSite.ts` on `main`), AWS `domainCertificate` (`packages/aws/src/CustomDomain.ts`), Cloudflare `WorkerDomainDns.ts`, `alchemy/Rename` (`renamedFrom`), `alchemy/DeployRetry`, `Resource` re-yield semantics (`Resource.ts:470-500`).

## Findings, most serious first

### A1. Distilled is pinned to a draft commit that cannot be reproduced

`submodules/distilled` points at `625a8ae46`, whose message is: "draft: typed errors for the RoutingUrl refusals, generated from an unmirrored local spec. Not for review or merge. Generated with DISTILLED_SPECS_LOCAL=1 from the live spec fetched on 2026-11-20, because the spec mirror does not have it yet." It regenerates 2,087 lines of `management.ts` from a spec nobody else can fetch. No Distilled pull request contains the RoutingUrl refusals: alchemy-run/distilled#1348 is a draft, and its head (`f3bce8aa6`) has only the `httpStatus` and domain-ownership changes.

What I would say: "Our rule is that a new typed error lands in its own Distilled pull request, and once merged, the submodule points at a Distilled `main` commit, never a side branch. Please get the spec into the mirror, open the Distilled pull request for the RoutingUrl errors, and re-pin once it merges. Until then this can't merge, and nothing about the typed refusals can be checked."

What to do: blocker. Mirror the spec, open the Distilled pull request, merge it, then bump the pin in this pull request (or a separate `chore: pin submodules/distilled` pull request, as Michael does).

### A2. The tests are the fake-client tests I asked you not to write

About 2,200 lines of new tests run `stack.deploy` against `makeFakeManagementApi` and an in-memory DNS host: `RoutingUrl.test.ts` (lines 1-852), `DomainOwnership.test.ts` (all), `Website/Domain.test.ts` (lines 1-303), `CustomDomain.test.ts` (all, a new one-off file), and the 528-line `fixtures/RoutingUrlCloud.ts`, which re-implements Prisma's RoutingUrl, backfill, hostname-holder and refusal behaviour. The six live tests (`RoutingUrl.test.ts:856`, `:917`; `Website/Domain.test.ts:398`, `:495`, `:578`, `:676`) are all skipped unless `ALCHEMY_RUN_LIVE_PRISMA_TESTS=true`. Nothing in the description or the commits says they ran; commit `a4377d4a` says "A skipped live test moves a serving hostname".

How this stands against the written conventions:

- AGENTS.md, "Resource and runtime testing conventions": "Do not mock HTTP or SDK responses, invoke provider lifecycle methods directly, or call extracted reconciliation helpers as a substitute for a deployment." A fake Management API behind `stack.deploy` is mocked HTTP.
- The audit procedure: "No mocked HTTP/SDK/CLI responses, fake layers … or fake-cloud engine tests", and "A new one-off test file — especially one with mocks — fails the audit."
- My request on #2696: "please don't use fake clients, mocked HTTP/SDK responses or direct `reconcile` calls to test provider changes. … A fake client only checks the provider against our own guess of how the API behaves." This pull request is that case exactly: the fake encodes your reading of how Prisma backfills rows, when it refuses a hostname, and which codes it sends. If that reading is wrong, every test still passes.
- "Keep production logic in its natural resource/provider location. Do not extract one-off reconciliation functions or modules solely to make them directly testable." `internal/AuthoritativeDns.ts:141`, `:356` and `:362` add `DnsLookups`, `AuthoritativeRecordCheck` and `SwitchboardDnsCheck` as replaceable services whose doc comments say "tests replace it".
- They also buy nothing in CI. CI runs no Prisma test at all (`check.yml` runs only the core engine, Domain and CLI suites; the "Test" jobs are Cloudflare Tools). So the fakes only run on a laptop, which is where the live tests can run too.

What I would say: "Same request as on #2696. Please delete the fake suites and the fake cloud, and test through real deploys. Run the live tests and tell me the results in the thread, not in the description."

Which tests the repo wants live, and the smallest shape I would accept:

1. `test/Prisma/RoutingUrl.test.ts`, not skipped, like `App.test.ts` and `Bucket.test.ts`. One `test.provider` case with no DNS: create a RoutingUrl on a real App, check `pending` and the two records through `getUrl`, redeploy unchanged (plan is a no-op), move it to a second App on the same Branch, destroy, check `getUrl` is `NotFound`. This needs no zone and no certificate, so it is cheap.
2. In the same file, not skipped, one probe per refusal Prisma can be made to send cheaply, asserting the typed tag (the entitlement pattern's "ungated probe test"): an invalid hostname, a second RoutingUrl with the same hostname on the Branch (`RoutingUrlHostnameTaken`), and a duplicate `logicalId`. Skip `RoutingUrlQuotaExceeded`; it can't be reached cheaply.
3. With `dns`, one live case against `alchemy-test-2.us` that deploys, checks the TXT and the DNS-only CNAME through Cloudflare's API, waits for `active` with a bounded `Effect.repeat`, and destroys and checks both records and the row are gone. This can sit behind the existing Prisma flag, as my CustomDomain DNS test does, but it must be run before merge.
4. The Website upgrade case (`Website/Domain.test.ts:578`): deploy the released wiring, upgrade, check one row and the CNAME survive. This is the case a reviewer worries about most, so it must have been run.
5. `Prisma.DomainOwnership` stays as in #2701: one live wildcard case.
6. `AuthoritativeDns.test.ts` may stay as a unit suite over in-memory answers if the module stays, because a shared pure utility is the one exception. Where real DNS defines the behaviour, check the cases against the test zone too.

Hostnames in live tests come from `stack.stage`. `Website/Domain.test.ts:310` keeps my fixed `prisma-dns.alchemy-test-2.us`; that is my mistake from #2696, but please fix it while you're there. `RoutingUrl.test.ts:861` uses `routing-url-<stage>.example.com`, which leaves a domain ownership for `example.com` in the test workspace on every run (see A8).

### A3. The hostname-change check belongs in the Prisma API

`RoutingUrl.ts:437-505` (`ensureCanServe`) and most of the 365 lines of `internal/AuthoritativeDns.ts` refuse to `PATCH` the hostname of an `active` RoutingUrl unless this machine sees a verified ownership or the TXT at every authoritative nameserver, and a CNAME to the switchboard or A/AAAA records that include a switchboard address. The description's reason: "Prisma itself would accept the change and stop serving the old hostname at once."

What I would say: "Why can't Prisma do this? You own the API. Last time we needed something from it (#2701), you added the verification record to the response and it was live the next day. A `PATCH` that would take a serving hostname down could be refused with a typed 409 that names the missing records, or Prisma could keep serving the old hostname until the new one is active. Then Alchemy needs no DNS code for this, and Composer and the Console get the same protection."

Problems with doing it on the client:

- It refuses when it can't check. A deploy from a network that blocks DNS to outside nameservers can never change a hostname, and there is no override.
- It can disagree with Prisma's resolver. The apex check compares against the switchboard addresses this machine resolves (`AuthoritativeDns.ts`, `switchboardAddresses`), which the code itself notes is an assumption.
- It waits up to about 70 seconds (20 tries 3 seconds apart, then a 10-second sleep, `AuthoritativeDns.ts:240-244`), above the speed doctrine's bound of about 45-60 seconds.
- It guards one outage path and documents another. With `dns`, the first deploy replaces an existing CNAME at the hostname without waiting for `active`, so "a hostname moving from another host stops serving there first" (JSDoc, `RoutingUrl.ts:252-256`).

What to do: drop `ensureCanServe`, the switchboard check and the `waitForRecords` prop from this pull request. Ask Prisma for the server-side refusal. Until then, a hostname change on an `active` row is a documented limitation, the same way `Prisma.CustomDomain` rejected hostname changes outright.

### A4. A RoutingUrl takes over any row on the Branch with its `logicalId`, with no `--adopt`

`ownRow` (`RoutingUrl.ts:374-386`) returns the first row on the Branch whose `logicalId` matches, whatever its service and hostname. `reconcile` (`:529-572`) then `PATCH`es that row's `serviceId` and `hostname` to its own, and `read` (`:509-528`) returns it as owned, never `Unowned`. The default `logicalId` is the resource's FQN (`Site/Url`), which has no stack or stage in it.

Scenario: two stages of the same stack deploy a `Prisma.Website.StaticSite("Site", { project, domain })` into one Project on its default Branch, with different hostnames. The second stage finds the first stage's `Site/Url` row, moves it to its own App and hostname, and the first stage's hostname stops being served. The next deploy of the first stage moves it back.

What I would say: "`Prisma.App` already solved this in the same package. Its `read` says 'A logical ID alone does not prove ownership: another declaration, stage, or stack on the branch can hold it', and returns `Unowned` unless the row is provably this instance's (`App.ts:365-395`). Please do the same: a row found only by `logicalId` is `Unowned` and needs `--adopt`, or derive the default `logicalId` so it is unique per stack and stage."

Taking over a row with no `logicalId` on the same service and hostname is fine: the service is this stack's own App, and that is the migration path from `Prisma.CustomDomain`.

### A5. The pull request does three or four things; split it

What is needed before 2026-12-21: `Prisma.RoutingUrl`, `Prisma.Website` on it, `Prisma.CustomDomain` marked deprecated, and `Prisma.CustomDomain`'s delete leaving a row a RoutingUrl took over. What is also here:

- The hostname-change check (A3).
- `Prisma.DomainOwnership` for wildcards, with `Prisma.DomainVerification`, `DomainOwnershipProof`, the `--adopt` rules and the verify loop. That is #2701's remaining scope, and RoutingUrl does not need it: Prisma creates the exact-hostname ownership itself.
- Work on a resource that is removed in a month: `Prisma.CustomDomain` moves from `/v1/apps/{id}/domains` to `/v1/services/{id}/domains`, which the description itself lists as deprecated and deleted on the same date; it gains a new `ownership` prop (`CustomDomain.ts:71`), `PrismaDomainOwnershipRequired`, and the `httpStatus` check (`:352`), which is half the reason for the Distilled core change in distilled#1348.

How I would split it, given you want one pull request: keep one pull request, but only for the first list. That removes roughly half the source and most of the tests. `Prisma.DomainOwnership` goes back to #2701 (I'm happy to finish it there once Distilled has the statuses), and the hostname-change protection goes to the Prisma API. If the maintainers must take it as one pull request, the size alone is not the blocker; the review cost is, and that comes from A2 and A3.

### A6. `Prisma.RoutingUrl` is a function, not a resource, and adds a new public pattern

`RoutingUrl` (`RoutingUrl.ts:284-315`) is a function that declares `Prisma.RoutingUrlRequiredRecords`, a DNS record set and the real resource (`RoutingUrlRow`). So `Prisma.RoutingUrl` has no `.Provider` or `.ref`, unlike every other Prisma resource, and the pull request exports a new public array, `RoutingUrlResources` (`:331`), so a hand-built provider list can register what the function declares. Nothing on `main` exports a `…Resources` array.

What I would say: "Why can't this use the existing mechanism? On `main`, a resource is a plain `Resource`, and a composite (the Website, AWS `domainCertificate`, Cloudflare `WorkerDomainDns`) declares the DNS records next to it through the adapter. `Prisma.providers()` already registers everything, so I don't want `RoutingUrlResources` in the public API; on #1061 I said the same about exporting provider internals: if someone wants to override them, they can build a new layer."

Also:

- `waitForRecords` (`RoutingUrl.ts:176-180`) is an internal flag in the resource's persisted props. It goes away with A3.
- `RoutingUrlRequiredRecords` is a second read-only resource next to `DomainVerification`, both stored in state although they create nothing. I see why: the app can be another resource's output, so a plan-time `Resource.lookup` can't read it. But with A3 gone, the TXT value comes from `DomainVerification` and the CNAME from `Output.map(compute.appEndpointDomain, switchboardTarget)`, which is what `main` does today.
- `websiteDomain` declares `requiredRecords(...)` a second time (`internal/WebsiteDomain.ts`) to read the records back. It works because re-yielding the same id returns the registered resource, but it is hard to follow; return what the caller needs instead.

What to do: make `Prisma.RoutingUrl` a plain resource with no `dns` prop, and keep DNS publishing in `Prisma.Website` as it is today. If a standalone RoutingUrl with DNS is wanted, show the user code with the adapter in the JSDoc, as `ACM.Certificate` does.

### A7. The Website upgrade keeps a shim forever

`internal/WebsiteDomain.ts:52-76` keeps declaring the released `DomainAlias` CNAME with `adopt(true)` and `RemovalPolicy.retain()`, because the new record set publishes the same CNAME first. Two resources now own one DNS record, and the comment says the alias "can be removed once they have all redeployed", which we can never know.

What I would say: "Why not leave the CNAME where it is? Keep `DomainAlias` exactly as released, with the same id and resource, and add only the TXT next to it. Then the upgrade changes nothing in DNS, needs no `adopt(true)`, and there is nothing to remove later."

Also:

- The description says "Upgrade first, change the hostname in a later deploy. Doing both at once creates a new row and deletes the old custom domain, with no check." That is an outage that the code can prevent and only the docs warn about.
- `Prisma.CustomDomain`'s delete now reads RoutingUrl rows and skips the delete when one has a `logicalId` (`CustomDomain.ts:380-390`), relying on "Alchemy deletes removed resources after every create and update". That is acceptable for a resource with a month to live, but say in the description that it depends on that order.
- I checked `renamedFrom` (`alchemy/Rename`) for moving `Domain` to `Url`. It does not apply, because the types differ, so the takeover by the RoutingUrl is the right migration.

### A8. Destroying a RoutingUrl leaves a domain ownership behind

The JSDoc and the Compute guide say Prisma creates a domain ownership for the exact hostname and "destroying the RoutingUrl leaves that domain ownership in place". Every live test run, and every user's preview environment, leaves a row in the workspace. When I wrote #2701, the point of one TXT record per hostname was to make cleanup work across stacks.

What I would say: "What cleans these up? The API has `createDomainOwnership: false` on create and update, so the resource could create the ownership itself and delete it on destroy. If Prisma must own it, tell me why and make sure `pnpm nuke` removes the ones the test suite leaves."

### A9. Typed errors: smaller points

- `RoutingUrl.ts:57-98` and `:389-422` catch Distilled's typed refusals and re-raise alchemy classes with the same names and a new message. That is a lot of code for a better message. Letting Distilled's tags through is fine with me, or keep the wrappers but say what they add.
- `:406-409` turns any other `Conflict` or `UnprocessableEntity` into `RoutingUrlOperationFailed`. Under the Typed Error Doctrine, a code we don't know yet is a Distilled patch, not a catch-all in alchemy.
- `internal/DomainOwnership.ts` `ownershipRequiredOf` decodes `error.body` with a hand-written schema to read `verification`. Type `verification` on `DomainOwnershipRequired` in Distilled instead.

### A10. Nits

- `internal/DomainOwnership.ts:81`: a doc comment ("Hostnames compare without case or a trailing dot.") with nothing under it.
- `getProjectBranchUrls` takes a `logicalId` filter; `branchUrls` lists the whole Branch and filters in memory.
- The Compute guide section for RoutingUrl (`website/.../prisma/compute/apps.mdx`) is mostly caveats. Once A3 and A6 are done, most of them go; keep the page to the two snippets and a short list of limits.

## Title and description

The title, `feat(prisma)!: Prisma.RoutingUrl, and Prisma.Website on it`, is a valid conventional commit and the `!` is right. "on it" is unclear. Better: `feat(prisma)!: Prisma.RoutingUrl, and Prisma.Website domains use it`.

Judged against "Pull Request Conventions" in AGENTS.md:

- It opens with a plain sentence and no heading, and the first snippet is good: that is the DX sample I asked for on #1061. Keep it.
- It is far from "the minimal content needed to convey the idea". It is about 1,500 words, with `###` and `####` sections, numbered lists and nested bullets that describe the implementation: lookup order, which `PATCH` is sent, which nameserver is asked, which errors keep which prefix and why. The convention says to cut any sentence that restates the diff. Most of the description does.
- There is no test plan, which is correct. But the description also doesn't need to, and shouldn't, carry the long list of limitations; those belong in the JSDoc and docs (they are already there).
- Remove: "Agent: prospero-20" (internal to the contributor's tooling), the "Also in this pull request" list of what was left out of #2701, and the paragraph about which commit Distilled is rebuilt on.
- Missing: a `**Breaking:**` before/after `diff` of user code, as in #3326. For example:

  ```diff
  - site.domain.dnsRecords
  - site.domain.foundryStatus
  - site.domain.customDomainId
  + site.domain.records
  + site.domain.status
  + site.domain.routingUrlId
  ```

  and, for `Prisma.CustomDomain` users, the one-deploy replacement with `Prisma.RoutingUrl`. The release-blog skill picks up the `!` and the word "Breaking", and the blog's caution callout needs exactly that diff.
- Missing: one line saying that a site whose DNS is not ready now deploys and reports `pending` where it used to fail. That is the user-visible behaviour change most people will notice.
- A reader who has not followed the work can't tell what a "row", "the backfill", "the switchboard" or "taken over" mean, or why `Prisma.DomainVerification` and `Prisma.RoutingUrlRequiredRecords` appear in their state. After A3 and A6, most of that text can go.

Shape I would accept: one sentence on what changes and why (the routes go away on 2026-12-21), the RoutingUrl snippet, the Website snippet with `domain: { name, dns }`, the breaking `diff`, one line on `Prisma.CustomDomain`'s deprecation and migration, one line naming the Distilled pull request.

On the submodule: we would not merge a pin to a fork or side-branch commit, and certainly not one titled "not for review or merge". See A1.

## Breaking changes and the changelog

- `CHANGELOG.md` and the release blog are written at release time from merged pull requests, so no file change is needed here. The `!` in the title is what flags it.
- What is needed is in the description: the before/after `diff` above, and the deprecation date for `Prisma.CustomDomain`.
- The `@deprecated` tag on `Prisma.CustomDomain` is there (`CustomDomain.ts:159`), with the date.

## CI

`gh pr checks 3529` on head `1d015760`: all checks pass (Check, three Cloudflare Tools "Test" jobs, Preview packages; Website skipped). Check covers formatting, the type graph, lint, `docs:check-jsdoc`, `exports:check` and `docs:check`. No Prisma test runs in CI, fake or live, so green CI says only that the code type-checks and lints.

## What I ran

Nothing beyond `gh` and `git` reads. I did not run any test file; no suspicion needed one, because the findings come from the code and the commit history.
