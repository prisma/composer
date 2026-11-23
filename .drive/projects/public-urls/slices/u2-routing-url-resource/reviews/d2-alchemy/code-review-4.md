# Code review, round 4 — `Prisma.RoutingUrl` follow-ups (alchemy)

Range: `e5373aed2..9f6f52c9e` on `feat/prisma-domain-ownership-status` (fork of alchemy-run/alchemy, no pull request yet). Two commits:

- `7de692c41`: the hostname-change refusal says when the CNAME could not be checked, the limits are documented, three new tests.
- `9f6f52c9e`: a hostname change to an apex passes when the A/AAAA answers at every authoritative nameserver include a switchboard address; the authoritative nameserver lookup now starts at the hostname itself.

Expectations: `spec.md`, `plan.md`, `design-notes.md` (note 12), `RoutingUrls.md`, `platform-routing-urls.md`, and the round 3 reviews. Alchemy's `AGENTS.md` ("Resource and runtime testing conventions") and `.claude/skills/audit/procedure.md`. There is no `.drive/CODE-REVIEW.md` in the repository.

What I ran:

- `pnpm test:integration test/Prisma/RoutingUrl.test.ts test/Prisma/DomainOwnership.test.ts`, with `ALCHEMY_RUN_LIVE_PRISMA_TESTS` unset: 23 passed, 1 skipped (the live RoutingUrl test).
- `oxfmt --check` and `oxlint` on the three touched TypeScript files: clean.
- The real `waitForAuthoritativeRecord` from a scratch script outside the clone, against public DNS (no Prisma calls). Results are quoted in the findings below.
- Node's `resolveNs` and `dig` against public names, to see how the new nameserver lookup behaves.

The clone's working tree was left clean.

## Summary

Both commits do what round 3 asked. The refusal no longer tells the user to publish a CNAME it could not check, and a flattened apex now passes, matching what the platform documents. The main problems: the nameserver lookup change affects all three resources that share it, not only RoutingUrl, and it now sends a recursive query for a name that may not exist yet, which is the caching hazard the module was written to avoid. Every apex change also waits a minute on a CNAME that cannot exist. And the new tests replace both the Management API and the DNS check with fakes, which Alchemy's rules forbid, so none of the new DNS code runs in any test.

## What looks solid

- **The three states are kept through to the error.** `combineRouting` returns `seen` only when the addresses are seen, `unknown` when either check is unknown, and `absent` otherwise. The CNAME or ALIAS is put into `records` only on `absent`, so an `unknown` result never tells the user to publish something they may already have published (round 3 F15).
- **The address check works against real DNS.** `ADDRESS example.com → example.com`, `cloudflare.com → cloudflare.com` and `prisma.build → prisma.build` all return `seen` in about 120 ms. `example.com` and `cloudflare.com` both have AAAA records, so the IPv6 path ran too. An unresolvable target (`switchboard.us-east-1.prisma.build`, which does not exist) returns `unknown` at once rather than `absent`.
- **IPv6 text comparison is safe.** Both sides of the comparison come from c-ares (`resolve6` for the target through the system resolver, `Resolver.resolve6` at each authoritative server), which print addresses in the same compressed lowercase form.
- **The switchboard's addresses are stable today.** `switchboard.cdg.prisma.build` returns the same three IPv4 addresses from 1.1.1.1, 8.8.8.8, 9.9.9.9, OpenDNS and its own nameserver (`kiki.bunny.net`, TTL 60), and has no AAAA. So comparing what this machine sees with what a flattening DNS host sees holds for now (see F25 for the assumption).
- **A negative answer on one record type does not fail the server.** `addressesOf` turns ENODATA and ENOTFOUND into an empty list, so an apex with only A records does not become `absent` because its AAAA query found nothing.
- **The new tests can fail.** I checked each one against the code it covers:
  - "could not check": it asserts the "could not be checked from this machine" text, no "Publish", and no PATCH. The round 3 code (`unknown` treated as `absent`) would print "Publish CNAME …" and fail it.
  - "wildcard": the fake now answers only for the `*.` query, so code that checked only the exact hostname would refuse, and the deploy would fail.
  - "pending row": with no ownership and `cname: "absent"`, code that also checked pending rows would refuse, failing the PATCH assertion.
  - "flattened apex": with `cname: "absent"`, code that ignored the address check would refuse.
  - "unrouted apex": it asserts the exact ALIAS wording, which a non-apex classification would not produce.

## Findings

### F19 — The nameserver lookup now queries the record's own name through the local caching resolver, for all three resources that share it

- **Location:** `packages/prisma/src/internal/AuthoritativeDns.ts` lines 53–69 (the loop at line 55 now starts at `i = 0`).
- **Issue:** `waitForAuthoritativeRecord` is shared by `Prisma.RoutingUrl`, `Prisma.DomainOwnership` (through `DomainOwnershipProof.ts`, TXT at `_prisma-verification.<domain>`) and `Prisma.CustomDomain` (`CustomDomain.ts` line 331, CNAME at the hostname). The commit message mentions only RoutingUrl. Starting at the name itself has two effects for the other two resources and for non-apex RoutingUrl hostnames:
  1. **It caches "this name does not exist" for a name that is about to be published.** `dns.resolveNs(name)` is a recursive query through the machine's resolver. Before the record exists, a DNS host that answers NXDOMAIN (bunny.net does: `dig NS zz-nonexistent-q.prisma.build` gives `NXDOMAIN`) makes that resolver cache the name as missing, for every record type, for the zone's negative TTL. The module's own header comment says this is the hazard: Prisma looks records up through a caching resolver, and a cached NXDOMAIN fails every retry for up to 30 minutes. Before this commit, the walk queried only the parent (`example.com`), which exists. The harm needs Prisma's resolver to share a cache with the deploying machine's (for example both on the same public resolver at the same site), so it is unlikely. But when it happens on a RoutingUrl, the Alchemy check passes (it asks the authoritative servers directly), the PATCH removes the old custom domain, and Foundry then cannot see the new CNAME: the serving hostname goes dark, which is what design note 12 forbids. For DomainOwnership and CustomDomain the deploy fails after its retries with the record published.
  2. **It follows a CNAME to the target's zone.** `resolveNs("www.github.com")` returns github.com's eight nameservers, because `www.github.com` is a CNAME to the zone apex `github.com`. When the hostname is a CNAME to a non-apex name (the switchboard is one: `switchboard.cdg.prisma.build` is a record in `prisma.build`), `resolveNs` returns ENODATA and the walk falls back to the parent as before, so the normal case is fine. But a hostname that currently CNAMEs to another provider's zone apex is checked against that provider's nameservers. They refuse or do not answer, the result is `unknown`, and the user is told to redeploy from another machine instead of being told to publish the CNAME. This fails safe (it refuses), but the advice is wrong.
- **Suggestion:** Only query the name itself when the parent walk cannot serve. The smallest change: walk from the parent (`i = 1`) as before, and fall back to the name itself (`i = 0`) only when nothing was found, which is exactly the two-label apex case. An apex always exists, so querying it caches nothing harmful. If delegated subzones (a hostname that is its own zone) also need support, skip `i = 0` when `resolveCname(name)` returns a CNAME, because a name with a CNAME cannot be a zone apex. Either way, say in the commit message that DomainOwnership and CustomDomain go through the same lookup.

### F20 — Every apex hostname change waits a minute on a CNAME that cannot exist, and a refusal now takes two minutes

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 316–330.
- **Issue:** The CNAME check runs first with `margin: "if-unseen"`. An apex has no CNAME, so the first answer is `absent`, and `waitForAuthoritativeRecord` repeats every 3 seconds, 20 times, before it gives up. Only then does the address check run. Measured with the real code against public DNS: `CNAME example.com` took 61.0 s to return `absent`, and `ADDRESS example.com → switchboard.cdg.prisma.build` took 61.8 s to return `absent`. So:
  - an apex change that will pass waits about 61 s first;
  - an apex change that is refused waits about 123 s;
  - a non-apex change with nothing published now waits about 123 s instead of 61 s.
  The DNS checks also run when ownership already decided the refusal (`owned` is false), so a user who has not published anything waits two minutes to be told so.
- **Suggestion:** Run the two checks concurrently and take `seen` from either (`Effect.all` with `concurrency: 2`, or race the two for a `seen`), so a passing apex costs one quick lookup and a refusal costs one minute, as before. Alternatively, for a two-label hostname, skip the CNAME check. Add a test that asserts the address check is reached without the CNAME wait, or at least keep the fake recording the order of checks.

### F21 — The "could not be checked" message names one cause, and drops a CNAME that was definitely absent

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 295–296 (`combineRouting`) and 352–355.
- **Issue:** The message says "no authoritative nameserver for it could be found or reached". `unknown` also comes from: the switchboard name not resolving on this machine (`targetAddresses` empty), every nameserver answering SERVFAIL or REFUSED (which is also what F19's wrong nameservers give), a 3-second timeout, an AAAA query failing after a matching A answer (F22), or a runtime without `node:dns` `Resolver`. And `combineRouting("absent", "unknown")` gives `unknown`: when every nameserver answered without a CNAME but the address check could not run, the CNAME is left out of `records` and the user is told only to redeploy from another machine. For a non-apex hostname, that machine would then tell them to publish the CNAME.
- **Suggestion:** Say what is known without guessing the cause: "Whether '<to>' points at <target> could not be checked from this machine." For a non-apex hostname whose CNAME check returned `absent`, also say that no CNAME to the target was found. Add one fake case for `cname: "absent", address: "unknown"`.

### F22 — A matching A answer is thrown away when the AAAA query to the same nameserver fails

- **Location:** `packages/prisma/src/internal/AuthoritativeDns.ts` lines 101–113.
- **Issue:** For each nameserver, the A query and then the AAAA query run in sequence inside one 3-second timeout. If the A answer already contains a switchboard address but the AAAA query fails with anything other than ENODATA or ENOTFOUND (SERVFAIL, a timeout, a refused query), `DnsQueryFailed` escapes and that server counts as `unknown`. `combine` then makes the whole result `unknown`, and a correctly published apex is refused (F21's message). The two sequential queries also halve the time each one gets before the timeout.
- **Suggestion:** Ask for A first and stop when it matches; ask for AAAA only when it does not. Or run both concurrently and count the server as `seen` if either matched, `unknown` only if neither matched and one failed.

### F23 — The new tests fake the Management API and the DNS check, which Alchemy's testing rules forbid, and none of the new DNS code runs in any test

- **Location:** `packages/integration-tests/test/Prisma/RoutingUrl.test.ts` lines 248–253 (the `AuthoritativeRecordCheck` layer) and the five new cases at lines 410–538.
- **Issue:** Alchemy's `AGENTS.md` says "Do not mock HTTP or SDK responses", and the audit procedure says tests use only `test.provider` with `stack.deploy`/`stack.destroy`, with "No mocked HTTP/SDK/CLI responses, fake layers … A spy that wraps the real service is fine; a fake is not." The five new cases use `makeFakeManagementApi` for every Prisma request and replace `AuthoritativeRecordCheck` with `Layer.succeed(...)` returning canned visibilities. The audit procedure also says to call out an existing suite that fakes what it claims to test. This file does, as do other Prisma suites already on upstream `main` (`Compute.test.ts`, `Resources.test.ts` and others import the same fake), so the new cases follow the package's pattern. But an earlier upstream pull request had a fake-client test rejected under these rules, and this branch adds a whole new fake-backed suite. Separately, because the DNS check is replaced whole, nothing exercises the code these commits changed most: the nameserver walk starting at the hostname (F19), the address comparison, IPv6 handling and the partial-answer rule (F22). Breaking any line in `AuthoritativeDns.ts` leaves all 23 tests passing.
- **Suggestion:** Decide before opening the pull request; it is a convention question for the upstream maintainers, not a code defect. Options, cheapest first:
  1. Keep the fake cases and say in the description that they follow the existing Prisma suites, and why a live hostname change is expensive (the row must first become `active`, which needs real DNS and a certificate).
  2. Add one live `test.provider` case in the existing live block that drives the real check, following `Website/CustomDomainDns.test.ts`: publish the TXT and CNAME for a test hostname on the Cloudflare test zone, wait for `active`, then change to a second hostname with no records and assert the refusal and that `getUrl` still shows the old hostname. Publishing A records with the switchboard's addresses on a third test hostname would exercise the address path without a zone apex.
  3. Replace the fake cases with live ones entirely.
  Option 2 is the one I recommend: it is the only way the DNS changes in this range get any test, and it is what the upstream rules ask for.

### F24 — "Apex" is decided by counting two labels

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 286–287 (`isApex`), 341; the JSDoc at lines 150–158; `apps.mdx` line 188.
- **Issue:** `example.co.uk` is a zone apex with three labels. A refused change to it is told to publish `CNAME example.co.uk = …`, which no DNS host allows at an apex. The check itself still accepts its A/AAAA answers, because `combineRouting` is not limited to apexes, so only the advice is wrong. The opposite gap is in the docs: the JSDoc and guide say an apex passes "instead" with A/AAAA answers, but the code accepts them for any hostname (a subdomain with A records pointing at the switchboard, or a host that flattens every CNAME). That matches the platform ("when a hostname has no CNAME, Foundry accepts it if it resolves to an address that the regional switchboard also has"), so the code is right and the docs understate it.
- **Suggestion:** When a hostname's routing record is absent, describe both forms for every hostname ("a CNAME to <target>, or at a zone apex an ALIAS, ANAME or flattened CNAME") instead of guessing which one applies, and drop `isApex` and the `ALIAS` record type. If the record type must stay, use the nameserver walk's own answer: the name is a zone apex when its own name has NS records. Reword the JSDoc and guide to say that any hostname passes when its A or AAAA answers include a switchboard address.

### F25 — The apex acceptance rests on two platform assumptions, and the plan still contradicts one

- **Location:** `packages/prisma/src/RoutingUrl.ts` lines 316–330; `plan.md` "Platform doc to correct".
- **Issue:** If the Alchemy check passes a hostname that Foundry then refuses, the PATCH has already removed the old custom domain and the serving hostname goes dark. That is the outage design note 12 exists to prevent, so these assumptions carry the whole safety of the new path:
  1. *Foundry accepts a flattened apex.* `RoutingUrls.md` ("Foundry accepts it if it resolves to an address that the regional switchboard also has") and `platform-routing-urls.md` (the condition includes "its address records resolve to it") say yes, and `plan.md` records it as agreed on 2026-11-11. But `plan.md` also still says, under "Platform doc to correct", that Foundry's OpenAPI spec requires a direct CNAME so a flattened apex fails, and that Alchemy refuses apex changes. One of the two paragraphs is stale.
  2. *Foundry's idea of "the switchboard's addresses" is what this machine's resolver returns for `switchboard.<region>.prisma.build`.* Today that holds (three fixed IPv4 addresses, the same from every resolver I tried). If the switchboard ever moves to geographic or rotating answers, a flattening DNS host and this machine can see different subsets, and the check becomes stricter or looser than Foundry.
- **Suggestion:** Before the pull request opens, confirm assumption 1 against Foundry's code or with one real registration of a flattened apex, and delete the stale `plan.md` paragraph. Record assumption 2 in the comment on the `ADDRESS` record type, so whoever changes the switchboard's DNS knows the check depends on it.

## Deferred (out of scope)

- **Typed 409/422 errors (round 3 F13).** Still matched by message text. Waits for platform slice 8's error codes and the Distilled patch, as `plan.md` records; not part of these two commits.
- **The nameserver walk's other gaps that predate this range:** NS names that resolve only to IPv6 are dropped (`resolve4` only), and the system-resolver queries (`resolveNs`, the target lookups) have no timeout of their own. Neither is made worse here except as F19 describes; fixing them belongs with the module, not with the apex change.

## Already addressed

| Round 3 finding | Status | Where |
| --- | --- | --- |
| F15: `unknown` reported as "publish the CNAME" | Fixed. `unknown` now gives the "could not be checked" message and leaves the CNAME out of `records`; tested by "refuses a hostname change it could not check". Wording caveats in F21. | `7de692c41` |
| F16: an apex can never pass | Fixed. A/AAAA answers that include a switchboard address now pass; tested by the two apex cases. Caveats in F19, F20, F24, F25. | `9f6f52c9e` |
| F14: adopting a `Prisma.CustomDomain` row breaks a same-deploy migration | Documented in the JSDoc (lines 159–162) and `apps.mdx` line 190 as the round 3 suggestion asked. The suggested entry in P2/P3's plan is outside this repository and I did not check it. | `7de692c41` |
| F17: a new hostname held in another workspace is not seen | Documented as a known limit in the JSDoc and `apps.mdx`. Not done: design note 12 does not mention it, and `plan.md` has no platform task for a "hostname held" lookup. | `7de692c41` (partial) |
| F18: no generated reference page | The spec's Scope now says `docs:gen` produces none. | spec, not this range |
| Round 3 design review test gaps: `unknown` state, wildcard coverage, pending row change | All three now have tests. | `7de692c41` |

## Acceptance-criteria verification

Only the done conditions these commits touch are re-verified. The rest keep their round 3 verdicts.

| AC | Verdict | Detail |
| --- | --- | --- |
| A hostname change on an `active` row whose new hostname has no verified domain ownership fails before any PATCH, and a test proves no request was sent | **PASS** | `ensureCanServe` still runs before the PATCH for an `active` row and returns the refusal when `owned` is false, whatever DNS says. The round 3 test still asserts the refusal, no PATCH and the unchanged row; the new "could not check" and "unrouted apex" cases also assert no PATCH. The DNS part of the check is faked in every test (F23). |
| Design note 12: a serving hostname is never replaced by one that cannot serve | **WEAK** | The check now passes apexes Foundry is documented to accept, and refuses on `unknown`. Whether it is safe depends on F25's assumptions, and F19 adds a rare path where the check passes while Foundry cannot yet see the record. A new hostname held in another workspace still passes (documented, round 3 F17). No test runs the real DNS check. |
| Other done conditions (pending deploy, no-PATCH redeploy, adoption and conflict, destroy, release, live test) | not touched | Round 3 verdicts stand. |

### Summary

| Result | Count | ACs |
| --- | --- | --- |
| PASS | 1 | hostname change refused before PATCH |
| WEAK | 1 | design note 12 |
| FAIL | 0 | |
| NOT VERIFIED | 0 | |
