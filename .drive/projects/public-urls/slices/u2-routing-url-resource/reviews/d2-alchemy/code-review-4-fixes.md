# Code review, round 4 fixes — `Prisma.RoutingUrl` (alchemy)

Range: `9f6f52c9e..8bd86303a` on `feat/prisma-domain-ownership-status` (fork of alchemy-run/alchemy, no pull request yet). One commit, `8bd86303a`, which answers round 4's `code-review.md` (F19 to F25) and `system-design-review.md` (A01 to A07). A06 and the project-document parts of F25 were left to the orchestrator; F23's question about the Management API fake is left for upstream maintainers.

Expectations: `spec.md`, `design-notes.md` note 12 (a deploy never takes a serving hostname out of service by accident), `RoutingUrls.md`, `platform-routing-urls.md`, `plan.md`; Alchemy's `AGENTS.md` ("Resource and runtime testing conventions") and `.claude/skills/audit/procedure.md`. There is no `.drive/CODE-REVIEW.md`.

What I ran:

- `pnpm test:integration test/Prisma/AuthoritativeDns.test.ts test/Prisma/RoutingUrl.test.ts test/Prisma/DomainOwnership.test.ts` with `ALCHEMY_RUN_LIVE_PRISMA_TESTS` unset: 36 passed, 2 skipped (the two live RoutingUrl cases).
- `tsc --noEmit -p packages/integration-tests`: no errors. `oxfmt --check` and both `oxlint` configs on the touched files: clean.
- The real `waitForSwitchboardDns` against public DNS from a scratch script outside the clone (since deleted), and `node:dns` queries against public authoritative servers. Results are quoted below.
- I compared `waitForAuthoritativeRecord` line by line with `e5373aed2`.

The clone's working tree was left clean.

## Summary

The commit fixes what round 4 asked: one wait for the platform's condition, concurrent queries with their own timeouts, a typed `switchboardDns` field, no invented `ALIAS` type, no label counting, and a unit suite over in-memory DNS. A refusal is back to about a minute and a flattened apex passes in about 100 ms. One new gap matters for design note 12: the address check also passes a hostname that has a CNAME to some other name in its own zone, because authoritative servers follow that CNAME in their A answers. The platform doc says Foundry uses addresses only when a hostname has no CNAME, so this may pass a change Foundry then refuses. The new live case would not catch that, because it stops before checking that the moved hostname becomes active.

## What looks solid

- **No path passes on `unknown`.** Per nameserver the result is `seen` only on a matching CNAME or a matching A/AAAA answer; `combine` needs every server `seen`. A server whose queries failed, or a switchboard whose addresses did not resolve, gives `unknown`, and `ensureCanServe` refuses everything but `owned && seen`.
- **F22 is fixed properly.** The CNAME, A and AAAA queries run concurrently, each with its own 3-second timeout, and a matching A answer counts even when AAAA fails. The unit case "sees a matching A answer when the AAAA query to the same nameserver fails" would fail against the old sequential code.
- **The CNAME pre-check fails safe.** When the local resolver's CNAME query fails or times out, the code treats the name as having no CNAME and asks for NS records at the name itself. For a name that is a CNAME to a non-apex target (the switchboard is one), that returns nothing and the walk falls back to the parent, as before. For a CNAME to another zone's apex, it finds that zone's nameservers, which refuse or answer without the record, so the result is `unknown` or `absent`: a refusal, never a pass.
- **The refusal message only says what is known.** I traced every reachable pair of `visibility` and `cname`. `visibility: "absent"` always comes with `cname: "absent"`, and `cname: "seen"` implies `visibility: "seen"`, so the "Redeploy once it can be checked." branch is only reached when the check really was `unknown`.
- **Timing.** Measured with the real code: a flattened apex (`example.com` against its own addresses) returned `seen` in 101 ms; a refusal returned `absent` after 61.5 s. The worst case is bounded: up to 22 polls of up to 3 s each with 3 s between them (about 2 minutes) when one nameserver times out and another answers without the record, plus the nameserver search (3 s for the CNAME pre-check, up to 6 s per label, 3 s for the switchboard's addresses), plus the 10 s margin when the record appears late.
- **The unit suite tests what the module does, not what RoutingUrl assumes.** It follows the audit procedure's exception for pure utilities over in-memory fixtures, uses `TestClock` so the 60-second wait runs in 63 ms, and asserts the exact query log where that is the point (no `NS api.example.com` for a CNAME'd name; only `NS example.com` for a `parent` search).
- **DomainOwnership's starting point is asserted.** `DomainOwnership.test.ts` now records the options and checks `{ margin: "always", nameservers: "parent" }`.

## Findings

### F26 — The address path passes a hostname whose CNAME points at another name in the same zone

- **Location:** `packages/prisma/src/internal/AuthoritativeDns.ts` lines 256–275 (`answerOf` in `waitForSwitchboardDns`).
- **Issue:** When an authoritative server is asked for the A records of a name that is a CNAME to another name in a zone it serves, it answers with the CNAME and the target's A records, and `resolve4` returns those addresses. I confirmed this against GitHub's authoritative servers: `www.github.com` is a CNAME to `github.com`, and `resolve4("www.github.com")` at `dns1.p08.nsone.net` returns github.com's address. Running the real `waitForSwitchboardDns` for `www.github.com` with a switchboard that resolves to github.com's addresses returned `{ visibility: "seen", cname: "absent" }`. So `new.example.com CNAME edge.example.com` with `edge.example.com A <switchboard addresses>` passes the check. `RoutingUrls.md` says Foundry uses addresses "when a hostname has no CNAME", and `platform-routing-urls.md` says "the first CNAME target is the regional switchboard, or its address records resolve to it". If Foundry follows the first reading, the check passes, the PATCH removes the old custom domain, and Foundry refuses the new one: the serving hostname goes dark, which is what design note 12 forbids. Compared with `e5373aed2` this is a new pass; `9f6f52c9e` had the same gap. The unit suite's fake cannot show it, because it answers each query from a literal table and never follows a CNAME the way a real server does.
- **Suggestion:** Per nameserver, when the CNAME answer is non-empty and is not the switchboard, count the server `absent` whatever its A/AAAA answers say. That is never looser than either reading of Foundry's rule, and it does not affect flattening, because a flattened name has no CNAME answer. Add a unit case: CNAME to `edge.example.com` plus an A answer holding the switchboard's address gives `absent`.

### F27 — The live case does not check that the moved hostname can serve

- **Location:** `packages/integration-tests/test/Prisma/RoutingUrl.test.ts` lines 758–760.
- **Issue:** After the move, the case asserts only that the row's hostname is `b.<base>`. It never checks that Prisma accepts the new hostname. That acceptance is the whole safety of the address path (round 4 F25, first assumption: Foundry accepts a hostname with no CNAME whose A records hold the switchboard's addresses). If Foundry refused it, the hostname would stay `pending`, the old one would already be gone, and the test would still pass. Otherwise the case reads correctly against `Prisma/Website/CustomDomainDns.test.ts`: it starts and ends with `stack.destroy()`, uses the same zone, fixture, `tempRoot` and `active` wait, the wildcard domain ownership covers both hostnames through `wildcardOf`, and the DNS records are created at the same time as the RoutingUrl update but the check's polling covers that. It also type-checks. I did not run it.
- **Suggestion:** After the move, run the same `createUrlCheck` loop and assert `status: "active"`. This is the one place the branch can prove Foundry's address rule for a non-apex hostname. Before then, also assert `firstUnmetCondition` is not `dnsPointsAtSwitchboard` so a failure says why.

### F28 — A failed or slow recursive lookup is treated as "no records", and the new timeouts make that more frequent

- **Location:** `packages/prisma/src/internal/AuthoritativeDns.ts` lines 145–150 and 162–179 (`answersOf`, `authoritativeServers`), 249–255 (the switchboard's addresses).
- **Issue:** The commit message says DomainOwnership and CustomDomain "find nameservers exactly as before". The logic matches `e5373aed2`, but every recursive NS and A lookup now gives up after 3 seconds, where before it waited for the resolver's own timeout. A lookup that fails becomes `?? []`, and the walk then moves one label up. For a record under a delegated subzone (`_prisma-verification.shop.example.com`, with `shop.example.com` delegated), a slow NS lookup for `shop.example.com` sends the walk to `example.com`'s servers. They answer with a referral, `resolveTxt` returns no records, the result is `absent`, and DomainOwnership refuses a published record after a minute. For other names a timeout gives `unknown`, which skips the propagation wait that protects Prisma's caching resolver. The same pattern drops the switchboard's IPv6 addresses without a trace when its AAAA lookup times out: a hostname that points at them through AAAA only is then `absent`, not `unknown`. Before this commit the same conflation existed, but only for real errors.
- **Suggestion:** In the walk, stop with no servers (so the result is `unknown`) when an NS lookup fails or times out, instead of moving up; keep moving up only on a negative answer. Treat a failed switchboard lookup as `unknown` rather than as no addresses. Add a unit case where the first NS lookup times out and assert the walk does not ask the grandparent's servers. Correct the commit message.

### F29 — A change refused for missing ownership still waits a minute on DNS

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 315–321.
- **Issue:** Round 4 F20 also said the DNS check runs when ownership has already decided the refusal. That part is not fixed. A user who has published nothing and has no verified ownership waits about 61 s to be told to publish both records, although the outcome was known after the ownership lookup.
- **Suggestion:** When `owned` is false, run one check without the wait (only to decide whether to list the CNAME) and refuse. That needs a way to ask `waitForSwitchboardDns` for a single check, such as a `wait: "until-seen" | "once"` option. Assert in the fake test that the check was asked for one check.

### F30 — RoutingUrl still asks the local caching resolver about the new hostname, and nothing records why that is accepted

- **Location:** `packages/prisma/src/internal/AuthoritativeDns.ts` lines 34–41 (`NameserverSearch`) and 165–169.
- **Issue:** With `nameservers: "name"`, the check sends two recursive queries for the new hostname through this machine's resolver: CNAME, then NS. On a refused change these run before the user has published anything, so a shared resolver caches "no such name" for the zone's negative TTL. That is the hazard the module's own header comment describes, and round 4 F19's first point. It is now gone for DomainOwnership and CustomDomain, but not for RoutingUrl. The harm still needs Foundry's resolver to share a cache with the deploying machine's, so it is unlikely, and starting at the name is what lets an apex and a delegated subzone find their own nameservers. But the trade-off is not written down.
- **Suggestion:** Say in the `NameserverSearch` comment that `name` sends recursive queries for the name itself, and why RoutingUrl accepts that. Optionally skip the NS query at the name when the CNAME query already answered that the name does not exist, since a zone apex always exists.

### F31 — No test pins CustomDomain's starting point

- **Location:** `packages/prisma/src/CustomDomain.ts` lines 337–341.
- **Issue:** `CustomDomain` calls `waitForAuthoritativeRecord` directly, not through the replaceable `AuthoritativeRecordCheck`, so `CustomDomain.test.ts` cannot see its options. Changing `"parent"` to `"name"` there passes every test, and that change would bring back round 4 F19 for CustomDomain. This is the smaller point of A05, still open.
- **Suggestion:** Call the check through `AuthoritativeRecordCheck` and assert `{ margin: "if-unseen", nameservers: "parent" }` in `CustomDomain.test.ts`, the way `DomainOwnership.test.ts` now does.

## Deferred (out of scope)

- **Typed 409/422 errors (round 3 F13).** Waits for platform slice 8 and the Distilled patch, as `plan.md` records.
- **NS names that resolve only to IPv6 are dropped** (`A` lookups only in the walk). Predates this range and is not made worse here.
- **Whether the switchboard's addresses as this machine sees them are the ones Foundry compares against** (round 4 F25, second assumption). Left to the orchestrator. One data point: in my first run against GitHub, whose authoritative servers hand out different addresses per server, the comparison returned `absent` for 61 s. If the switchboard ever moves to rotating or geographic answers, the check will behave like that.

## Already addressed

| Earlier finding | Status | Where |
| --- | --- | --- |
| F19: nameserver lookup starts at the name for all three resources | Fixed for DomainOwnership and CustomDomain: they pass `nameservers: "parent"`, and the walk is the old one apart from the new 3-second timeouts (F28). The CNAME-following problem is fixed for RoutingUrl by the CNAME pre-check. The caching concern remains for RoutingUrl (F30). The commit message now names all three resources. | `8bd86303a` (partial) |
| F20: apex changes wait a minute on a CNAME; refusals take two | Fixed: one wait over one condition. Measured 101 ms for a passing apex, 61.5 s for a refusal. The wait when ownership already refused remains (F29). | `8bd86303a` (partial) |
| F21: the "could not be checked" message guesses a cause and drops a known-absent CNAME | Fixed. The message says only that it could not be checked; with `cname: "absent"` it says the CNAME is missing and lists it in `records`. Tested by the second half of "refuses a hostname change it could not check". | `8bd86303a` |
| F22: a matching A answer is lost when AAAA fails | Fixed and tested (unit case named above). | `8bd86303a` |
| F23: fake Management API and DNS check | DNS part addressed: the module has a unit suite, and a skipped live case runs the real check (see F27). The Management API fake is left for upstream maintainers. | `8bd86303a` (partial, by agreement) |
| F24: apex decided by counting labels; docs understate the address form | Fixed. `isApex` is gone; the message gives the ALIAS/ANAME/flattened form for any hostname; JSDoc and `apps.mdx` say any hostname passes with either form. | `8bd86303a` |
| F25: the apex acceptance rests on two platform assumptions | Code part partly done: the `waitForSwitchboardDns` JSDoc says the addresses are the ones "this machine resolves the switchboard to", but not that Foundry must see the same ones. Project-document parts left to the orchestrator. F27 would test the first assumption. | `8bd86303a` (partial, by agreement) |
| A01: invented `ALIAS` record type | Fixed. `records[].type` is `TXT` or `CNAME`; the apex forms are in the message and the JSDoc. | `8bd86303a` |
| A02: apex guessed by label count | Fixed (same change as F24). | `8bd86303a` |
| A03: "could not check" has no field | Fixed. `switchboardDns: "seen" \| "absent" \| "unknown"`, asserted in the fake tests. | `8bd86303a` |
| A04: one platform condition modelled as two record checks | Fixed. `ExpectedSwitchboardDns` and `waitForSwitchboardDns` evaluate the condition per nameserver per poll; `combineRouting` is gone; `ExpectedRecord` holds only records again. | `8bd86303a` |
| A05: shared module change untested; JSDoc names one caller; CustomDomain bypasses the replaceable check | Unit suite added; commit message names the shared effect; JSDoc still names DomainOwnership only, which is now accurate for that service. CustomDomain still bypasses it (F31). | `8bd86303a` (partial) |
| A06: client copies Foundry's rule; project docs behind | Left to the orchestrator. | not in this range |
| A07: migration warning only on RoutingUrl, without its condition | Fixed. `CustomDomain`'s JSDoc has the warning, and both state the condition (the backfill). I could not check the backfill date of 2026-11-17 against any document I have. | `8bd86303a` |

## Acceptance-criteria verification

Only the done conditions this commit touches are re-verified. The rest keep their earlier verdicts.

| AC | Verdict | Detail |
| --- | --- | --- |
| A hostname change on an `active` row whose new hostname has no verified domain ownership fails before any PATCH, and a test proves no request was sent | **PASS** | `ensureCanServe` runs before the PATCH when the observed row is `active`, and refuses unless `owned && dns.visibility === "seen"`. "refuses a hostname change on an active row before any PATCH" sets the ownership `unverified` and asserts the typed refusal, its `records`, the check's options, an empty PATCH list and the unchanged row. |
| Design note 12: a serving hostname is never replaced by one that cannot serve | **WEAK** | `unknown` still refuses on every path, and the condition now matches the platform's for a hostname with no CNAME. But F26 lets through a hostname with a CNAME to another in-zone name whose A records hold the switchboard's addresses, which the platform doc says Foundry does not accept that way. The unit suite proves the module's decisions against literal answers, not real servers. The live case that would show Foundry accepting the address form stops before checking that (F27), and is skipped. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 1 | hostname change refused before PATCH |
| WEAK | 1 | design note 12 |
| FAIL | 0 | |
| NOT VERIFIED | 0 | |

## Could not check

- Foundry's actual rule for a hostname that has a CNAME not pointing at the switchboard (F26).
- The live cases: not run, by instruction.
- The backfill date of 2026-11-17 stated in the RoutingUrl and CustomDomain JSDoc and in `apps.mdx`.
- How long Node's default resolver waits before failing a recursive lookup on this and CI machines, which decides how often F28's 3-second cap changes the outcome.
