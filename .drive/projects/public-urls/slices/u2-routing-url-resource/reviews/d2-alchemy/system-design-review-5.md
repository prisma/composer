# System design review, round 5 — `Prisma.RoutingUrl` `dns` option and DNS check fixes (alchemy)

Range: `8bd86303a7..HEAD` on `feat/prisma-domain-ownership-status` in the alchemy fork. Two commits no reviewer has seen:

- `dcc35d3f48`: the hostname-change check refuses a CNAME to a name other than the switchboard, and a failed nameserver lookup on the RoutingUrl search stays `unknown`. When the domain ownership is not verified, the check asks DNS once and refuses without waiting. `Prisma.CustomDomain` now waits through the replaceable `AuthoritativeRecordCheck`.
- `8645d9bdb3`: `Prisma.RoutingUrl` takes an optional `dns` (an Alchemy DNS adapter config) and publishes the hostname's TXT ownership record and its CNAME to the switchboard. `Prisma.RoutingUrl` becomes a function; the resource moves to `internal/RoutingUrlResource.ts`.

Expectations read: `project-docs/spec.md`, `design-notes.md` (note 7: the platform creates the domain ownership, the resource never creates or deletes one; note 8: DNS publishing as a follow-on; note 12: a deploy never takes a serving hostname out of service by accident), `plan.md` (both the project-docs copy and the newer `.drive/projects/public-urls/slices/u2-routing-url-resource/plan.md`, which says the `dns` option exists so `Prisma.Website` can move off `Prisma.CustomDomain` before Prisma deletes the custom domain routes around 2026-12-21), `RoutingUrls.md` (how a domain ownership is created and verified), `platform-routing-urls.md`, the round 3 and round 4 reviews, the intended pull request description `pr-bodies/alchemy.md`, and the intent of the `dns` commit as given in the dispatch brief. Alchemy's `AGENTS.md` and `.claude/skills/audit/procedure.md` section 3. Code read beyond the diff: `alchemy/DNS/Adapter.ts`, `cloudflare/DNS/RecordList.ts` and `Adapter.ts`, `prisma/Website/FrameworkSite.ts`, `prisma/DomainOwnership.ts`, `prisma/internal/DomainVerification.ts`, `prisma/internal/DomainOwnershipProof.ts`, and the other composites that call a DNS adapter. The repository has no `.drive/CODE-REVIEW.md`.

Tests run: `pnpm test:integration test/Prisma/RoutingUrl.test.ts test/Prisma/AuthoritativeDns.test.ts` at `8645d9bdb3`: 34 passed, 2 skipped (the live tests).

## What changed, in system terms

`Prisma.RoutingUrl` is now a composite, like `Prisma.DomainOwnership`. Without `dns` it declares the RoutingUrl resource and nothing else. With `dns` it also declares, under the namespace of its id:

- `Verification`, the read-only `Prisma.DomainVerification` resource, which reads the workspace's TXT record name and value;
- `Records`, one record set through the adapter's `records` method, holding the TXT and a CNAME to `switchboardTarget(app.appEndpointDomain)`.

The RoutingUrl's `hostname` input is mapped through the record set, so the engine reconciles the records before the RoutingUrl.

## Checked against the intent of the `dns` commit

| Intent | Holds? |
| --- | --- |
| Only publishes two records; never declares, creates, verifies or deletes a domain ownership; no `Prisma.CustomDomain` | Yes. `DomainVerification` only reads `GET .../domain-ownerships/verification`, and its delete does nothing. |
| The record set is the same on every deploy and does not come from the `records` attribute | Yes. Derived from the verification value and the app's endpoint. The test redeploys an active row whose `records` is empty and sees one publish. |
| `logicalId` still defaults to the id the caller passed; existing state still matches | Yes. The resource is declared at `id`, outside the namespace, so its fully qualified name is unchanged. This is a deliberate and correct difference from `Prisma.DomainOwnership`, which wraps its inner resource in the namespace. |
| Records are published before the hostname-change check runs | Yes, but see S01 and S02: publishing the new records also removes the old ones, and publishing cannot make the check pass. |
| The deploy does not wait for `active` | Yes. |
| Destroy removes the two records and sends no domain ownership request | Yes. The RoutingUrl depends on the records, so it is deleted first. |

The `dcc35d3f48` changes match the platform's rule for `dnsPointsAtSwitchboard`: a CNAME to another name fails, and addresses count only for a hostname with no CNAME. Keeping `Prisma.DomainOwnership` and `Prisma.CustomDomain` on the original nameserver search, and routing `CustomDomain` through the replaceable check, answers round 4's A05.

## Findings

### S01 — With `dns`, a refused hostname change removes the serving hostname's records first

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 225–275 (`RoutingUrl` and `publishRecords`; one record set with the fixed id `Records`). The behaviour comes from the adapters' record sets: `packages/cloudflare/src/DNS/RecordList.ts` line 275 removes, during reconcile, every record the set no longer lists. The test adapter in `RoutingUrl.test.ts` (lines 306–335) does the same.
- **What happens:** A RoutingUrl serving `api.example.com` is changed to `new.example.com`. The record set is one resource, so the engine updates it in place first: it adds the new TXT and CNAME and deletes the old ones. Then the RoutingUrl reconciles and the hostname-change check runs. If the check refuses (and S02 shows it refuses for every exact hostname without a verified wildcard), the deploy fails. The row still points at `api.example.com`, but its CNAME is gone, so `api.example.com` stops resolving to the switchboard once resolvers drop the cached record. Its TXT is gone too, so its domain ownership starts expiring.
- **Why it matters:** This is exactly the outage design note 12 forbids: "A serving hostname is never replaced by one that cannot serve … the deploy fails before changing anything." The check exists to prevent it, and the `dns` option undoes it. The plan says `Prisma.Website` moves onto this option, so every Website whose `domain` changes would go through this path.
- **Suggestion:** Give each hostname its own record set, with the resource id derived from the hostname (as `Cloudflare` `WorkerDomainDns` does with `Hostname-${key}`). A hostname change then creates a new record set and leaves the old one as a removed resource. Design note 12 already relies on Alchemy deleting removed resources only after every create and update has succeeded; that keeps the old records in place when the check refuses. This needs the hostname as a plain string when `dns` is set, which `WorkerDomainDns` also requires. Add a fake test for a refused change with `dns` that asserts the old records are still published.

### S02 — For an exact hostname, the ownership half of the check cannot be met, and the `dns` test hides it

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 386–399 (`ensureCanServe` counts only a `verified` domain ownership row); `packages/integration-tests/test/Prisma/RoutingUrl.test.ts` lines 170–177 (`ownershipOf` with `fromZone`) and the test at line 459.
- **What happens:** The check requires a `verified` domain ownership in the workspace that covers the new hostname. For an exact hostname, the only thing in this design that creates one is Prisma itself, as a side effect of the RoutingUrl create or update (`createDomainOwnership`, `RoutingUrls.md`). That update is the `PATCH` the check is guarding. Publishing the TXT record creates no row: Prisma's lookup updates rows that exist and creates none. So:
  - without `dns`, the refusal tells the user to publish the TXT and redeploy, and the redeploy is refused again, forever;
  - with `dns`, the records are published, the check still finds no row, and the deploy is refused (after S01 has removed the old records).
  The only way through is a covering ownership made some other way: a `Prisma.DomainOwnership` for the wildcard (which the live test declares) or one made in the Console. The docs warn against declaring `Prisma.DomainOwnership` for the same exact hostname.
- **How the test hides it:** with `fromZone: true`, the fake management API reports a `verified` domain ownership for any domain whose TXT record is in the fake zone, whether or not a row exists. The platform does not behave that way. So the test "publishes the new hostname's records before the check on an active row's hostname change" proves a flow that cannot happen against Prisma. The audit procedure asks for this to be said plainly: this suite fakes the property it claims to test. The skipped live test does not cover it either, because it uses a verified wildcard.
- **Why it matters:** the dispatch intent assumes that publishing the records before the check lets a hostname change go through. It does not, so the main use the plan names (`Prisma.Website` changing its domain) can never succeed in one deploy without a wildcard ownership.
- **Suggestion:** decide how the ownership half can be met before the `PATCH`. Three options, in the order I recommend:
  1. Count ownership as shown when every authoritative nameserver answers the TXT record with the workspace's value, as `Prisma.DomainOwnership` already checks through `AuthoritativeDns`. The platform looks the record up once when the update creates the domain ownership (`RoutingUrls.md`), so it becomes `verified` at once. This changes no recorded decision.
  2. Have the platform refuse an unservable hostname change itself, or offer a dry run (round 4 A06). It also protects Console users, but it waits on the platform.
  3. Document that moving a serving hostname needs a covering wildcard `Prisma.DomainOwnership`. This keeps the code but leaves the refusal message giving advice that cannot work.
  Creating the exact domain ownership from the resource would reverse design note 7 ("Composer creating the claim … rejected") and needs Will. In any case, change the fake so that a TXT record alone never produces a `verified` row, and fix the refusal message so it does not ask for a step that cannot succeed.
- **Scope note:** the check's ownership rule predates this range. It is reported here because the `dns` commit depends on it and its new test masks it.

### S03 — The same CNAME is published through two different adapter methods in one package

- **Where:** `packages/prisma/src/RoutingUrl.ts` line 259 (`dns.records`); `packages/prisma/src/Website/FrameworkSite.ts` line 182 (`dns.alias` for the same CNAME to `switchboardTarget(compute.appEndpointDomain)`).
- **What is wrong:** `Prisma.Website` points its hostname at the switchboard with the adapter's `alias` method, which exists for "point one hostname at a target". `Prisma.RoutingUrl` publishes the same CNAME as a raw record through `records`, which the adapter documents for "records whose values come from another resource (certificate validation, ownership verification)". The two differ in behaviour, not just in name: `records` is always DNS-only, while Cloudflare's `alias` honours `proxied: true`. A proxied record hides the CNAME, so the check and Prisma would both see Cloudflare's addresses and the hostname would never become active. The plan moves `Prisma.Website` onto this option, so one of the two has to win.
- **Suggestion:** I think `records` is the right choice for Prisma, because Prisma must see the CNAME. Say so in the `dns` JSDoc ("published DNS-only, even when the adapter proxies aliases"), and make `Prisma.Website` use the same path when it moves. If `alias` is preferred instead, refuse `proxied: true`.

### S04 — The required record set is derived on the client, a third copy of the platform's rule

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 245–275; `switchboardTarget` is also used by the check (line 397) and by `Prisma.Website`.
- **What is wrong:** The platform owns which records a hostname needs. It publishes them in `records`, but only the ones still unmet, so the resource cannot use that field for a set that must be the same on every deploy (the intent says so). The client therefore rebuilds the set from the workspace verification value and its own rule for the switchboard name. If the platform's target ever differs from `switchboard.{region}.prisma.build`, a RoutingUrl with `dns` stays `pending` with no error. This is the same drift round 4 A06 raised for the check.
- **Suggestion:** Add a platform request to `plan.md`, next to the error codes: a field that lists every record the hostname needs, met or not (for example `records` with a `met` flag, or a separate `requiredRecords`). Until then, the current derivation is acceptable and should be named as the interim home.

### S05 — The RoutingUrl's hostname is taken from another resource's attribute

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 231–237 (`hostname` mapped to `published.hostname`, which is `verification.domain`).
- **What is wrong:** To make the RoutingUrl depend on the records, the composite replaces the caller's hostname with `DomainVerification`'s `domain` attribute, which that resource normalises its own way. The identity input of the RoutingUrl now depends on a sibling's normalisation rule. Its siblings do this differently: `Prisma.DomainOwnership` and `Prisma.Website` keep the caller's value and use the dependency only to order it (`Output.map(Output.of(published), () => props.domain)`).
- **Suggestion:** Map the record set to the caller's `hostname`, as the siblings do.

### S06 — The resource's new name says how it is built, not what it is

- **Where:** `packages/prisma/src/internal/RoutingUrlResource.ts`; `Providers.ts`; `RoutingUrlProvider` in `RoutingUrl.ts`.
- **What is wrong:** The split mirrors `Prisma.DomainOwnership`, whose inner resource is `DomainOwnershipProof`, named for what it is. Here the inner resource is `RoutingUrlResource`, named for the mechanism; read cold, it does not say how it differs from `RoutingUrl`, which also returns that resource. Two smaller effects: the exported `RoutingUrlProvider` now provides for a type users cannot import, so anyone who registered it with `Provider.collection([Prisma.RoutingUrl])` (as this suite did before the commit) breaks. And the exported `RoutingUrl` interface declares `Omit<RoutingUrlProps, "dns">` while the function takes `RoutingUrlProps`. `Prisma.providers()` users are unaffected, and the resource is unreleased, so the cost is low.
- **Suggestion:** Name the inner resource for what it is (it is the platform's RoutingUrl row; `DomainOwnershipProof` is the model), or keep the name and add one line to the module saying it is the resource the composite declares, kept internal so `Prisma.RoutingUrl` can add `dns`.

### S07 — `waitForSwitchboardDns` with `attempts: "once"` does not wait, and `NameserverSearch` now decides two things

- **Where:** `packages/prisma/src/internal/AuthoritativeDns.ts` lines 36–55, 225–229, 275–332.
- **What is wrong:** A function named "wait for" is now called in a mode that never waits, and `margin` is ignored in that mode. Separately, `NameserverSearch` used to say where the nameserver search starts. Now `"name"` also means "a failed lookup ends `unknown`" and `"parent"` means "a failed lookup moves one label up". The JSDoc says so, but the type name hides the second meaning, and the asymmetry exists only to keep the two older callers unchanged.
- **Suggestion:** Rename to something like `checkSwitchboardDns` with `attempts`, or split a single-check function from the waiting one. For the search, either name the values for both meanings or add a second option for failure handling. This is minor.

### S08 — The `dns` option contradicts the written scope of U2, and the pull request description does not mention it

- **Where:** `spec.md` "Deliberately out" (publishing DNS through an adapter for a RoutingUrl, design note 8: a follow-on) and its done conditions; `pr-bodies/alchemy.md`.
- **What is wrong:** The newer slice `plan.md` records why the option exists (moving `Prisma.Website` before the custom domain routes are deleted). The spec still lists it as out of scope, and its done conditions do not cover it. The pull request description has no `dns` section, its test list misses the two new tests, and it still says the RoutingUrl suite has no DNS publishing. Design note 8 still says publishing DNS is a follow-on; it is about Composer, so ADR-0060's "Composer never publishes DNS" is unaffected until Composer uses the option.
- **Suggestion:** Move the item from "Deliberately out" to scope, with Will's decision and date. Add done conditions: records are published before the check; a redeploy publishes nothing new; destroy removes the records and sends no domain ownership request; and, after S01, a refused change keeps the old records. Add a `dns` section to the pull request description with the example from the JSDoc.

### S09 — The first deploy with `dns` repoints a hostname that may be serving elsewhere

- **Where:** `RoutingUrl.ts` JSDoc for `dns`; `apps.mdx`; `cloudflare/DNS/RecordList.ts` line 129 ("A CNAME is exclusive at its name: overwrite a differing one").
- **What is wrong:** A user moving `api.example.com` to Prisma from another host adds a RoutingUrl with `dns`. The deploy overwrites the existing CNAME at once and does not wait for `active`. The hostname stops serving from the old host before Prisma has verified ownership and issued a certificate, which takes minutes. Design note 12 is written about RoutingUrl rows, but its purpose (a deploy does not take a serving hostname out of service by accident) applies here. For `Prisma.Website`'s own move, the CNAME already points at the switchboard, so nothing changes there.
- **Suggestion:** Say it in the `dns` JSDoc and in `apps.mdx`: for a hostname that serves elsewhere today, publish the TXT first and switch the CNAME once the RoutingUrl's only unmet conditions are the DNS ones, or omit `dns` for the move.

## Out of scope for this pass (for the code-review pass)

- Whether `Predicate.hasProperty(app, "Type")` is right when `app` is an `Output` of an app id, and the cast of `app` to the hostname's type in `publishRecords`.
- `Compute.appEndpointDomain` is `string | undefined`; what `switchboardTarget(undefined)` publishes.
- Whether `App.lookup` at plan time adds a read to every deploy with `dns` and an app id string.
- The record order in the record set, and whether TTLs should be set.

## Could not check

- Real DNS hosts (no live tests were run). The skipped live hostname-change test publishes its records by hand with `Cloudflare.DNS.Record`; using `dns: Cloudflare.DNS.Adapter()` on the RoutingUrl there would give the option a live proof.
- Whether the engine deletes a removed record set only after the RoutingUrl update succeeds, as S01's suggestion assumes. Design note 12 states this engine behaviour for P1; I did not re-verify it in the engine.
