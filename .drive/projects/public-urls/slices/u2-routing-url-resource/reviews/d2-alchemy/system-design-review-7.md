# System design review, round 7 — the whole Alchemy branch before it goes upstream

Range: `upstream/main...HEAD~1` on `feat/prisma-domain-ownership-status` in the Alchemy clone (merge base `dbfd0ddb9c`). The last commit, `bf238ca7db`, pins `submodules/distilled` to a local draft and is not part of the change. Most attention went to the two commits no reviewer had seen, `0ce9f5db0f` (round 6 fixes) and `7208f801b1` (typed refusals), and to how the branch reads as one change.

What I read: the pull request description (`pr-bodies/alchemy.md`); `spec.md`, `plan.md` in `wip/u2/project-docs/`; the round 6 system design review; Alchemy's `AGENTS.md` (package boundaries, Typed Error Doctrine, test conventions, pull request conventions); the Composer `.drive/CODE-REVIEW.md` jargon sweep. Code: every file under `packages/prisma/src` the branch touches, `alchemy/src/Resource.ts` (what happens when a resource id is declared twice), the error classes already in `packages/prisma/src` on upstream `main`, Distilled patch `007-type-routing-url-refusals.patch.json` and the generated error classes, the test files `RoutingUrl.test.ts`, `Website/Domain.test.ts`, `PublicSurface.test.ts` and the fixture `RoutingUrlCloud.ts`, and the docs diffs (`apps.mdx`, `websites.mdx`, `vite.mdx`, `dns-adapters.mdx`).

Tests run: `pnpm test:integration test/Prisma/RoutingUrl.test.ts test/Prisma/Website/Domain.test.ts test/Prisma/PublicSurface.test.ts --retry 0`: 46 passed, 6 skipped (live). No live tests were run.

## What the branch adds, in system terms

Read cold, the branch makes four moves in `packages/prisma`:

1. **`Prisma.RoutingUrl`**, a function that declares the platform RoutingUrl (type `Prisma.RoutingUrl`). With `dns` it also declares, under the RoutingUrl's id and per hostname, `RequiredRecords-<hostname>` (type `Prisma.RoutingUrlRequiredRecords`, reads the two records from Prisma) and `Records-<hostname>` (the DNS host's record set). Before a hostname change on an `active` row it checks ownership and switchboard DNS itself. Prisma's refusals become eight exported Alchemy errors.
2. **`Prisma.Website`** declares that RoutingUrl as `Url`. With `dns` it also keeps the released `DomainAlias` (now `adopt(true)` and `RemovalPolicy.retain()`), whose CNAME value comes from the same `RequiredRecords-<hostname>` resource, declared a second time by id.
3. **`Prisma.CustomDomain`** is deprecated, moves from the hand-written client to Distilled, and its delete skips a row a RoutingUrl manages.
4. **`Prisma.DomainOwnership`**, carried from #2701: a function that declares `Prisma.DomainVerification` and `Prisma.DomainOwnership` (internal modules), plus the shared `internal/AuthoritativeDns`.

The core, moves 1 and 2, now reads as one design: one takeover rule, one source for the CNAME value, one place that decides "can serve". What still reads as an earlier layer is move 4's coupling to move 3: the branch adds new ways to use the resource it deprecates (S22).

Size: about 2,100 changed lines of source in 13 files, about 2,800 lines of tests and fixture, about 250 lines of docs. Upstream squash-merges, so commit history does not matter. One pull request is reviewable if the description leads with RoutingUrl and the Website move, which it does. Removing the S22 material makes it smaller and removes the one part a maintainer would ask "why add this to something you are deprecating?".

## The public surface a maintainer is asked to accept

| Surface | Judgement |
| --- | --- |
| `Prisma.RoutingUrl` as a function, not a `Resource` class | Accept. `Prisma.DomainOwnership` and every `Prisma.Website.*` are functions too. The cost is no `.ref`, `.Provider` or lookup, and the description says so. |
| `Prisma.RoutingUrlResources` + `Prisma.RoutingUrlProvider()` | Accept. They exist because the function hides its resource classes; `PublicSurface.test.ts` pins the list. No other export like it in Alchemy, so it should stay one-off until a second composite needs it. |
| `Prisma.RoutingUrlRequiredRecords` | Accept the resource. Its type string goes into the state of every user with `dns`, so it is contract, yet the description never names it (S23). |
| The eight error classes | Accept the set. Two typology problems: one name covers a props error (S25), and the naming rule differs from the DomainOwnership error added in the same branch (S24). |
| `site.domain` from `CustomDomain` to `RoutingUrl` | Accept. It is a breaking type change; the description explains it but does not mark the change breaking (S23). |

## Findings

### S22 — The branch adds new uses of the resource it deprecates, and teaches them in the guide

- **Where:** `packages/prisma/src/CustomDomain.ts` lines 66–70 (`ownership` prop) and 159–172 (new "Proving Ownership of a Hostname" example); `website/src/content/docs/prisma/compute/apps.mdx`, section "Custom domains (deprecated)"; `packages/integration-tests/test/Prisma/Website/Domain.test.ts` lines 623 onward (live test "Prisma.DomainOwnership proves a hostname that a CustomDomain then attaches").
- **What happens:** `ownership` is a new prop on `Prisma.CustomDomain`. The provider never reads it; it only makes the CustomDomain wait for the DomainOwnership. The same branch marks CustomDomain `@deprecated`, with a month left before Prisma deletes its routes. The Compute guide's deprecated section then teaches two new patterns with it, exact and wildcard. Meanwhile the live use of `Prisma.DomainOwnership` (prove a wildcard once so RoutingUrls under it need no TXT each, which its JSDoc teaches since `0ce9f5db0f`) appears nowhere in the guide; the Routing URLs section mentions DomainOwnership only as a warning. The live test for DomainOwnership exercises only the deprecated pairing, and sits in the Website suite.
- **Why it matters:** this is #2701's design, where DomainOwnership existed so a CustomDomain could be created, kept beside the new one. A maintainer reading cold is asked to accept a new prop and new docs on a resource the same change retires, and the guide steers readers to the retired path.
- **Suggestion:** remove the `ownership` prop, its JSDoc example, the two code samples in the deprecated guide section, and that live test. Keep the deprecated section to the caution and a pointer to Routing URLs. Add two sentences and the wildcard example to the Routing URLs section. If a live DomainOwnership test is wanted, put it in `DomainOwnership.test.ts`, paired with a RoutingUrl. Keep the CustomDomain error mapping (`PrismaDomainOwnershipRequired`): that improves an existing failure and is not a new feature.

### S23 — The description leaves out contract the code adds, and two claims are wrong

- **Where:** `pr-bodies/alchemy.md`.
- **Not said, but contract:**
  1. Two new resource type strings in users' state: `Prisma.RoutingUrlRequiredRecords` (every RoutingUrl with `dns`, every Website with `domain.dns`) and `Prisma.DomainVerification` (every DomainOwnership with `dns`). Renaming either later is a state migration.
  2. `RoutingUrlServiceNotOnABranch` is also raised before any request, on read and on every reconcile, when Prisma reports the service on no Branch; it is not only Prisma's refusal on create.
  3. The `site.domain` type change and "a site whose DNS is not ready now deploys" are breaking for anyone typing or relying on the old behaviour. Upstream marks such pull requests with `!` (for example `feat(state)!:`). The title should be `feat(prisma)!: ...`.
- **Claims the code does not meet:**
  1. "Identity is the `logicalId`, which defaults to the resource's name." The code defaults to the fully qualified name (`news.logicalId ?? fqn`), which includes namespaces, so a Website's RoutingUrl gets `<site id>/Url`. The JSDoc says "fully qualified name"; `apps.mdx` repeats the wrong wording.
  2. "`Prisma.CustomDomain` ... Its only other changes: ..." CustomDomain also fails with the new `PrismaDomainOwnershipRequired`, retries its create on `DomainOwnershipRequired`, replaces its own nameserver wait with `internal/AuthoritativeDns`, and pages through every app in `list`. Either list them or drop "only".
- **Suggestion:** add one line under "Also in this pull request" naming the two type strings; fix the two claims; use the `!` title.

### S24 — Two naming rules for Alchemy errors that replace a Distilled error, added in the same branch

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 54–96 and 382–416; `packages/prisma/src/internal/DomainOwnership.ts` lines 16–27.
- **What the code does:** RoutingUrl's errors carry exactly the tags Distilled generates (`RoutingUrlQuotaExceeded`, `RoutingUrlLogicalIdTaken`, `RoutingUrlInvalidHostname`, `RoutingUrlServiceNotOnABranch`, `RoutingUrlServiceOnAnotherBranch`), and each Alchemy error's `cause` is the Distilled error with the same tag. The DomainOwnership error added in the same branch is prefixed to avoid that: Alchemy `PrismaDomainOwnershipRequired` for Distilled `DomainOwnershipRequired`. The package already has both styles (`PrismaAppLogicalIdTaken`, `CustomDomainConflict`).
- **Is the shared tag a problem?** Not a defect. Effect matches errors by tag. Inside the provider, `catchTags` replaces each Distilled error with the Alchemy one, so only Alchemy's class reaches the caller. The refusal tests check `instanceof` the Alchemy class, so a Distilled error that slipped through would fail them. What it does cost: an error printed with its cause shows the same name twice, and a search for the name finds two definitions in two packages. A maintainer will ask why the branch does it one way for RoutingUrl and the other way for DomainOwnership.
- **Suggestion:** keep the RoutingUrl names; they match Prisma's error codes and the names Composer will match on. Add one sentence to the description: "Alchemy's RoutingUrl errors keep the tags of the Distilled errors they replace; the Distilled errors never leave the provider." Leave `PrismaDomainOwnershipRequired` as it is, since it follows the package's older `Prisma*` style. That way each name has a reason the reader can see.

### S25 — `RoutingUrlInvalidHostname` also reports a props error

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 73–77 (class JSDoc "Prisma refused the hostname"), 286–296 (raised by the function with no request to Prisma); `internal/WebsiteDomain.ts` lines 22–27.
- **What happens:** one class covers three cases: Prisma refused the hostname; the hostname is a wildcard and `dns` is set; the hostname is an Output and `dns` is set. The third is a wrong prop shape, not a bad hostname. The package's convention for that is `<Resource>InvalidProps` (`CustomDomainInvalidProps`, `AppInvalidProps`, `ComputeInvalidProps` on upstream `main`). The class JSDoc says only "Prisma refused", which is false for two of the three.
- **Suggestion:** raise `RoutingUrlInvalidProps` for the Output case. Reword the JSDoc to "The hostname cannot be served by a RoutingUrl: Prisma refused it, or it is a wildcard and `dns` is set." `Prisma.Website` turns this error into a defect (its signature has no error channel). That difference from `Prisma.RoutingUrl` is fine, and its JSDoc already says why.

### S26 — The slice spec and plan now contradict the code on errors

- **Where:** `wip/u2/project-docs/spec.md` line 29 ("Errors are matched on Distilled's generic errors, so U2 needs no second Distilled pull request"); `plan.md` line 32 ("No typed RoutingUrl errors").
- **What is wrong:** since `7208f801b1` the resource catches the typed errors Distilled patch 007 generates and depends on that patch. The spec's "Coherence rationale" (two upstream pull requests) still holds, but its stated reason does not. Not upstream-facing, but it is the contract later rounds review against.
- **Suggestion:** replace line 29 with the rule the code follows: Distilled types each refusal by its error code; the resource maps each to its own Alchemy error, and any other 409 or 422 to `RoutingUrlOperationFailed`. Fix plan D1 to match.

### S27 — `isManagedByRoutingUrl` says more than it checks

- **Where:** `packages/prisma/src/internal/RoutingUrlTakeover.ts`; used in `RoutingUrl.ts` line 371 and in `CustomDomain.ts`'s `delete`.
- **What happens:** the predicate is `logicalId !== null`. Any client that writes a `logicalId` sets it: this stack's RoutingUrl, another stack's, or Composer. Read cold, the name says "an Alchemy `Prisma.RoutingUrl` resource manages this row". The behaviour is right in every case round 6 checked; only the name overclaims. Next to it, `ownRow`'s JSDoc says the takeover covers rows "Prisma's backfill made", while the takeover module says Console rows have no `logicalId` either, so they are taken over too.
- **Suggestion:** name it for what it checks, for example `isClaimed(row)`, with the JSDoc "A client that writes `logicalId`, such as `Prisma.RoutingUrl` or Composer, has claimed the row." Make `ownRow`'s JSDoc say "a row with no `logicalId` for the same service and hostname".

### S28 — RoutingUrl's shared pieces live in a module named after one inner resource

- **Where:** `packages/prisma/src/internal/RoutingUrlRequiredRecords.ts` lines 18–37; `internal/WebsiteDomain.ts` lines 44–48; `internal/DomainOwnership.ts` line 82; `CustomDomain.ts` (`sameHostname`).
- **What is there:** the module defines `RoutingUrlOperationFailed` (the RoutingUrl's general error, re-exported from `RoutingUrl.ts`), `AppReference`, `normalizeHostname`, `appIdValue` and `resolveServiceId`, beside the `RoutingUrlRequiredRecords` resource. That keeps imports free of a cycle, but a reader looking for the RoutingUrl's errors will not look there. Hostname normalization now exists three times: `normalizeHostname`, `normalizeDomain`, and CustomDomain's `sameHostname`. And `websiteDomain` reaches the composite's inner resource by redeclaring its id (`Url/RequiredRecords-<hostname>`); Alchemy returns the existing resource for a repeated id, so this works, but it ties the Website to the composite's internal naming.
- **Suggestion:** move the error and helpers to `internal/RoutingUrl.ts`, and use one hostname normalizer. Leave the redeclaration: the shared `requiredRecords` helper is the one place that knows the id scheme, which is enough.

### S29 — `AuthoritativeDns` is still named for waiting, and its options grow one per caller

- **Where:** `packages/prisma/src/internal/AuthoritativeDns.ts` lines 44–60 (`WaitOptions`, `SwitchboardWaitOptions`), the JSDoc of `checkAuthoritativeRecord` ("Wait until every authoritative nameserver ..."), `waitUntilVisible`.
- **What is wrong:** round 5's naming point was fixed for the two functions (`check*`), not for their option types and JSDoc. Four callers now use four combinations of `margin`, `nameservers`, `attempts` and the new `serversOf`. That is acceptable for an internal module, but the leftover "wait" names describe the module from #2701, before it became the check that refuses a hostname change.
- **Suggestion:** rename to `CheckOptions` and `SwitchboardCheckOptions`, and fix the JSDoc to "Whether every authoritative nameserver for `record.name` returns the record, waiting for it when `attempts` is `until-seen`."

### S30 — Jargon sweep

Most new text reads plainly, including every error message added in `7208f801b1`. To rewrite:

- `RoutingUrlRequiredRecords` JSDoc: "from inside the provider so an app id from any source works". Say: "It reads the app's switchboard during the deploy, so `app` can be another resource's output."
- `invalidConfiguration` JSDoc in `WebsiteDomain.ts`: "A hostname a RoutingUrl cannot serve is invalid configuration, raised while the stack is built, as `DNS.resolve` does." Say: "A site's hostname that a RoutingUrl cannot serve stops the deploy while the stack is built, as a bad DNS adapter does."
- `ownRow` JSDoc: see S27.
- `DomainOwnership` JSDoc, "so every `Prisma.RoutingUrl` under it serves without a `TXT` record of its own": true only without `dns`; a RoutingUrl with `dns` publishes its TXT anyway. Add "A RoutingUrl with `dns` still publishes its own; that is harmless."
- `RoutingUrlRequiredRecords` JSDoc names `Prisma.DomainVerification`, an internal type no user sees. Say "the same verification endpoint `Prisma.DomainOwnership` reads".

## Round 6 findings

| Finding | Status | Where |
| --- | --- | --- |
| S10: a new site with `dns` on Cloudflare fails its first deploy | Resolved in code: `DomainAlias` is declared with `adopt(true)`, and the fake alias now reports an existing CNAME as not owned, so the fake test would fail without it. Not run live. | `0ce9f5db0f`, `internal/WebsiteDomain.ts` |
| S11: two owners of the site's CNAME, with no end date | Resolved: `RemovalPolicy.retain()` on the alias, its value from `RequiredRecords-<hostname>`, the exit recorded in the code comment and spec done condition 7. | `0ce9f5db0f` |
| S12: CustomDomain restates the takeover rule | Resolved: one predicate in `internal/RoutingUrlTakeover.ts`, and the delete comment states the deletion-order dependency. Its name overclaims (S27). | `0ce9f5db0f` |
| S13: `recordsPublished` named for the caller | Resolved: `waitForRecords`, named for what it does. | `0ce9f5db0f` |
| S14: "records" for two sets | Resolved: `Prisma.RoutingUrlRequiredRecords`, with a JSDoc on why it is separate. Wording nit in S30. | `0ce9f5db0f` |
| S15: three props types, "Row" in a public name | Resolved: `RoutingUrlProps` is the function's parameter type; the resource's props are inline; no public "Row". | `0ce9f5db0f` |
| S16: `RoutingUrlResources` for one composite | Kept as suggested; JSDoc names the pairing with `RoutingUrlProvider()`. | — |
| S17: the two DNS checks search differently; `ownershipDns`; stale JSDoc | Resolved: the TXT search starts at the new hostname's own nameservers (`serversOf`), the field is `ownership`, the JSDoc is updated, and `DomainOwnershipProof` says why `unknown` lets it go on. Leftover names in S29. | `0ce9f5db0f` |
| S18: record set id not one-to-one with the hostname | Resolved: ids use the hostname itself; a test covers `a-b.example.com` and `a.b-example.com`. | `0ce9f5db0f` |
| S19: upgrade tested against a hand copy | Partly. The ids are shared constants and `websiteDomain` moved to `internal/`, so the copy and the real code cannot drift on ids. Nothing yet ties the namespace (`Site`) to the real Website; only the unrun live upgrade test does. | `0ce9f5db0f` |
| S20: spec done conditions | Resolved (conditions 4 and 7). The spec has a new stale line on errors (S26). | spec |
| S21: jargon | Resolved for the items listed; new items in S30. | `0ce9f5db0f` |
| Round 5 S07: "wait" in names that do not wait | Resolved for the functions; option types remain (S29). | `0ce9f5db0f` |

## Out of scope for this pass (for the code-review pass)

- Whether `Prisma.CustomDomain` needs the new retry on `DomainOwnershipRequired` for it to keep working until the routes go, or whether that is also #2701 carry-over (it bears on how much of S22 can go).
- Whether the RoutingUrl's `logicalId` default (fully qualified name, not stage-qualified) lets two stages on one Branch claim each other's row. `Prisma.App` uses the same default, so this is not new to the branch.
- `RoutingUrlRequiredRecords.read` returns stored output without reading Prisma.

## Could not check

- Real DNS hosts and Prisma: no live tests were run, so the Cloudflare adoption in S10 and the upgrade rest on the fake.
- Distilled patch 007 was generated from an unmirrored local spec; whether the real regeneration produces the same five tags is for the Distilled pull request.
