# System design review, round 4 — `Prisma.RoutingUrl` follow-ups (alchemy)

Range: `e5373aed2..9f6f52c9e` on `feat/prisma-domain-ownership-status` in the alchemy fork. Two commits: `7de692c41` (the unchecked-CNAME message, the documented limits, three new fake tests) and `9f6f52c9e` (a hostname change to a flattened apex is accepted, and the nameserver lookup starts at the hostname itself). Everything before `e5373aed2` was reviewed in rounds 1 to 3 and is read here only as context.

Expectations read: `spec.md`, `plan.md`, `design-notes.md` (note 12: a deploy never takes a serving hostname out of service by accident; notes 7 and 8), `RoutingUrls.md` (the newer platform copy, including the apex paragraph and the `dnsPointsAtSwitchboard` condition), `platform-routing-urls.md` (the older copy), `code-review-3.md` and `system-design-review-3.md`. Alchemy's `AGENTS.md` (Typed Error Doctrine, Resource and runtime testing conventions) and `.claude/skills/audit/procedure.md` section 3. The repository has no `.drive/CODE-REVIEW.md`.

Tests run: `pnpm test:integration test/Prisma/RoutingUrl.test.ts` at `9f6f52c9e`: 12 passed, 1 skipped (the live test).

## What changed, in system terms

The hostname-change check from design note 12 now answers three round-3 findings:

- **Could not check the CNAME (round 3 F15).** The check still refuses, but the message says the CNAME could not be checked from this machine, and the CNAME is left out of `records`.
- **Apex hostnames (round 3 F16).** The platform agreed that Foundry accepts a hostname with no CNAME when its A or AAAA answers include an address the regional switchboard also has. The check now accepts that, for any hostname. A refused change to a two-label hostname is told to publish "an ALIAS, ANAME or flattened CNAME", and the refusal's `records` carries a new record type, `ALIAS`.
- **Known limits (round 3 F14 and F17).** The JSDoc and `apps.mdx` now say that a RoutingUrl in another workspace holding the new hostname is not seen, and that a `Prisma.CustomDomain` being replaced by a RoutingUrl must be retained or removed in an earlier deploy.

To support the apex case, the shared internal module `internal/AuthoritativeDns.ts` gains a third kind of expectation, `ADDRESS`, and its nameserver search now starts at the full name instead of its parent.

## What is right

- **The check stays conservative.** "Could not check" still refuses a change to a serving row. That is what design note 12 asks for: a serving hostname is never replaced by one that has not been shown to serve.
- **The address rule matches the platform's rule, not a narrower one.** The address check runs for any hostname whose CNAME is not seen, not only for two-label names. That is how `RoutingUrls.md` describes Foundry's acceptance ("when a hostname has no CNAME, Foundry accepts it if it resolves to an address that the regional switchboard also has").
- **The documented limits are honest and placed where a user of `Prisma.RoutingUrl` reads them.**
- **The new tests drive `stack.deploy`** and assert both the outcome and that no `PATCH` was sent on a refusal, in the shape the earlier rounds settled for this suite.

## Findings

### A01 — The refusal invents an `ALIAS` record type that neither DNS nor the platform uses

- **Where:** `packages/prisma/src/RoutingUrl.ts`, `RoutingUrlHostnameChangeRefused.records` (lines 71–76) and its construction (lines 338–346).
- **What is wrong:** `records[].type` was a DNS record type (`TXT`, `CNAME`). It now also takes `ALIAS`, which is not a DNS record type; its JSDoc says it means "an ALIAS, ANAME or flattened CNAME". The platform made the opposite choice: `RoutingUrls.md` says that for an apex "the API names the record `CNAME` either way" and describes the alternatives in prose. So one resource now reports the same record two ways. The `records` attribute, copied from the platform, says `CNAME` for `example.com`. The refusal, for the same hostname, says `ALIAS`. Every consumer of both shapes has to learn that they mean the same thing. Two consumers are already planned: Composer's P2 prints records, and design note 8's follow-on publishes them through a DNS adapter, which has no `ALIAS` record to write.
- **Suggestion:** Keep `type` to the platform's vocabulary (`TXT`, `CNAME`). Put the apex alternative in the message prose that `describeRecord` builds, for example "CNAME example.com = switchboard… (at a zone apex, an ALIAS, ANAME or flattened CNAME)". If a typed distinction is really wanted, ask the platform to add it to its own `records` first, so both surfaces agree.

### A02 — The apex is guessed by counting labels

- **Where:** `packages/prisma/src/RoutingUrl.ts` line 287 (`isApex`).
- **What is wrong:** "A hostname of two labels cannot have a CNAME" is false in both directions. `example.co.uk` and `example.com.au` are zone apexes with three labels, so a refused change to them is told to publish a CNAME, the very record their zone cannot hold. A delegated subzone such as `shop.example.com` is also an apex. The check itself does not depend on this guess; only the advice does.
- **Suggestion:** Taking A01 removes `isApex` entirely, because the prose covers the apex case for every hostname. If the distinction stays, decide it from the zone lookup `AuthoritativeDns` already performs (it now finds whether the name has its own nameservers), not from the label count.

### A03 — "Could not check" has no field, and the message guesses its cause

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 330–361; `RoutingUrlHostnameChangeRefused` (lines 65–77).
- **What is wrong:** Round 3 F15 suggested leaving the CNAME out of `records` or adding a reason field. Only the first was done. A consumer that branches on the error's fields now sees an empty `records` (when ownership is verified) and has to read the message to learn why the change was refused. That is the same message-text dependence round 3 F13 objected to, moved into our own error. The message also states a cause it does not know: it always says "no authoritative nameserver for it could be found or reached". `unknown` also comes back when the switchboard's own addresses cannot be resolved on this machine, when a nameserver times out or refuses, and when `node:dns` is not available.
- **Suggestion:** Add a field to the error that says which condition was not shown and why, for example `dns: "absent" | "unknown"` (or a list of unchecked conditions). Make the message say only what is known ("could not be checked from this machine"), or let `AuthoritativeDns` return the cause with `unknown` so the message can name it.

### A04 — One platform condition is modelled as two independent record checks

- **Where:** `packages/prisma/src/internal/AuthoritativeDns.ts` lines 8–12 (`ExpectedRecord`) and 70–123; `packages/prisma/src/RoutingUrl.ts` lines 294–329 (`combineRouting` and its use).
- **What is wrong:** The platform has one condition, `dnsPointsAtSwitchboard`: the first CNAME target is the switchboard, or the address records resolve to it. The code models it as two separate expectations, each run through the full wait loop, joined afterwards by `combineRouting`. Three consequences follow:
  - `ExpectedRecord` is documented as "the record Prisma is about to look up", but `ADDRESS` is not a record. It is a rule over two record types (A and AAAA) compared against a third name's addresses.
  - The same concept is named differently in sibling variants: the CNAME variant calls the switchboard hostname `value`, the address variant calls it `target`.
  - Each check waits on its own. A hostname with neither record waits out the CNAME poll and then the address poll in turn. The timing itself is for the code-review pass to weigh.
- **Suggestion:** Give `AuthoritativeDns` one expectation for the condition, named after it, for example `{ type: "SWITCHBOARD", name, target }`, evaluated on each nameserver in each poll as "a CNAME to `target`, or an A/AAAA answer among `target`'s addresses". `combineRouting` then disappears, the wait runs once, and the record variants stay records. If the two checks stay separate, at least use one field name for the target hostname.

### A05 — A change to the shared DNS module is untested for all three of its callers

- **Where:** `packages/prisma/src/internal/AuthoritativeDns.ts` line 55 (the loop now starts at `i = 0`) and the new `ADDRESS` branch.
- **What is wrong:** The commit describes the loop change as the apex fix, but the module is shared. `Prisma.CustomDomain` calls `waitForAuthoritativeRecord` directly for its CNAME wait, and `Prisma.DomainOwnership` reaches it through `DomainOwnershipProof` for the TXT record. All three now look for nameservers at the full name first. For a name that is itself a CNAME, the recursive resolver follows the CNAME for that first query. When the target is not a zone apex, nothing comes back and the loop moves on to the parent as before. When it is, the check would ask the target zone's nameservers about the hostname and get `unknown`. That is unlikely for Prisma's switchboard, but it is a change in behaviour for two resources that the commit does not mention. Nothing proves either the old or the new behaviour: every suite replaces the module with a fake (`AuthoritativeRecordCheck` in `RoutingUrl.test.ts` and `DomainOwnership.test.ts`), and the skipped live test covers neither an apex nor a hostname change. So the property this round adds, "an apex is accepted when every authoritative nameserver answers with a switchboard address", is not shown anywhere. The fake only shows that `RoutingUrl` reacts correctly to a `seen` it is handed.
- **Suggestion:** Give the module a unit suite over an injected resolver. The audit procedure's exception for pure utilities with in-memory fixtures allows that. Cover at least: an apex whose nameservers are found at the name itself; a CNAME'd name that falls through to its parent zone; and `ADDRESS` returning `seen`, `absent` and `unknown` (including the switchboard's own addresses not resolving). Mention the shared effect in the commit message. Two smaller points: the JSDoc on `AuthoritativeRecordCheck` still says it is the check `Prisma.DomainOwnership` runs, and `CustomDomain` calls `waitForAuthoritativeRecord` directly instead of through that replaceable service.

### A06 — The client now copies Foundry's acceptance rule and still cannot see `heldBy`; the project docs do not record where this should end up

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 304–362; project `plan.md`, `spec.md`, `design-notes.md` note 12.
- **What is wrong:** Design note 12 offered two homes for its second rule: the RoutingUrl resource checks before it changes a serving row's hostname, or the platform refuses that update itself, "which also protects Console users". U2 chose the client. After this round the client mirrors two pieces of the platform's own knowledge: Foundry's acceptance rule, now including the address variant, and the covering rules for domain ownership. It is still blind to the one case it cannot see from outside, another workspace's row holding the new hostname (round 3 F17), and it can only ever give an answer from this machine's view of DNS. Every time Foundry's rule changes, the client copy drifts silently. Round 3 F17 asked for two things besides the JSDoc: record the limit in design note 12, and add a platform task for a "is this hostname held" check. Neither appears in the copies of `plan.md` and `design-notes.md` provided. The project docs have also fallen behind the code:
  - `spec.md` "Chosen design" still says the check requires "the CNAME to the regional switchboard" and that a refusal "names … the records to publish". Neither holds for the address path or the unknown case.
  - `plan.md` says both "Alchemy accepts a hostname change to an apex whose A/AAAA answers match the switchboard's" and, under "Platform doc to correct", "Alchemy's `Prisma.RoutingUrl` refuses a hostname change to an apex and says so". The second sentence is from before `9f6f52c9e`.
- **Suggestion:** In `plan.md`, add the platform request beside the error-code request: the update route refuses a hostname change on an `active` row when the new hostname cannot serve, or offers a dry-run check that reports it, including `heldBy`. Note in design note 12 that the client check is the interim home and is retired once the platform refuses. Update `spec.md`'s description of the check (address path, the unknown case and what the refusal carries), and delete the stale sentence from `plan.md`.

### A07 — The migration warning sits only on the resource being migrated to

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 159–162 and `apps.mdx`; `packages/prisma/src/CustomDomain.ts` (no mention).
- **What is wrong:** The order for replacing a `Prisma.CustomDomain` with a `Prisma.RoutingUrl` is documented only on `RoutingUrl`. The reader who most needs it is someone looking at their existing `CustomDomain`, and it is `CustomDomain`'s delete that removes the row. Since `docs:gen` produces no page for Prisma resources (round 3 F18), the JSDoc shown on hover is the main place a user sees it. The warning is also stated without a condition ("the RoutingUrl takes over the row the CustomDomain made"). That holds only once the platform serves its legacy domain routes as a view over RoutingUrls and has backfilled them. Whether that is already true could not be checked here.
- **Suggestion:** Add one sentence to `CustomDomain`'s JSDoc pointing at the replacement order. If the view is not yet live, phrase the `RoutingUrl` warning as "once Prisma lists custom domains as RoutingUrls".

## Out of scope for this pass (for the code-review pass)

- How long a refused change takes, given two sequential waits of up to about a minute each (A04).
- Whether the CNAME-following case in A05 can occur for the hostnames real users publish.
- The correctness of the address comparison itself (string equality of IPv6 forms, for example).

## Could not check

- The P2/P3 plans, which round 3 F14 asked to carry the migration order. They are not among the documents provided.
- Whether the canonical `docs/compute/RoutingUrls.md` in pdp-control-plane matches the copy read here, and whether the legacy `/v1/services/{id}/domains` routes are already a view over RoutingUrls.
- Real DNS behaviour (no live tests were run).
