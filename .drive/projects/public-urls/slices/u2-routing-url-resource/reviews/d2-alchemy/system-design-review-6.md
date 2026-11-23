# System design review, round 6 — `Prisma.RoutingUrl` `dns` fixes and `Prisma.Website` on RoutingUrl (alchemy)

Range: `8645d9bdb3..HEAD` on `feat/prisma-domain-ownership-status` in the alchemy fork. Three commits no reviewer has seen:

- `f1f2b6d875`: one record set per hostname; ownership counts as proved by a verified domain ownership or by the TXT record at every authoritative nameserver; nothing is published under `alchemy dev`; `RoutingUrlResources` is exported; a new read-only resource `Prisma.RoutingUrlDnsRecords` computes the two records.
- `62df778dd2`: the TXT check waits only when this deploy publishes the records.
- `a3bb2c6d42`: `Prisma.Website` attaches its hostname with `Prisma.RoutingUrl`; `Prisma.CustomDomain` is deprecated, and its delete skips a row a RoutingUrl has taken over.

What I read: the slice `spec.md` (updated 2026-11-20), `plan.md`, `design-notes.md` (notes 7, 8 and 12), `RoutingUrls.md` and `platform-routing-urls.md` (how `updateRoutingUrl` creates and looks up a domain ownership), the round 5 system design and code reviews, Alchemy's `AGENTS.md`, and the Composer `.drive/CODE-REVIEW.md` (jargon sweep). Code beyond the diff: `alchemy/src/DNS/Adapter.ts`; the Cloudflare `DNS/Adapter.ts`, `DNS/Records.ts` and `DNS/RecordList.ts`; the Route 53 and Hetzner adapters and their record resources; `alchemy/src/Plan.ts` and `Apply.ts` (when the engine checks whether a resource already exists, and refuses one it does not own); `alchemy/src/RemovalPolicy.ts`; `prisma/src/internal/DomainOwnershipProof.ts` and `AuthoritativeDns.ts`; the released `Website/FrameworkSite.ts` on upstream `main`.

Tests run: `pnpm test:integration test/Prisma/RoutingUrl.test.ts test/Prisma/Website/Domain.test.ts test/Prisma/PublicSurface.test.ts --retry 0`: 36 passed, 5 skipped (the live tests). No live tests were run.

## What changed, in system terms

`Prisma.RoutingUrl` is a composite. Without `dns` it declares one resource, the platform RoutingUrl (type `Prisma.RoutingUrl`, held privately as `RoutingUrlRow`). With `dns` it also declares, in the namespace of its id and keyed by the hostname:

- `RequiredRecords-<hostname>`, a `Prisma.RoutingUrlDnsRecords`: reads the workspace's verification record and the app's switchboard from Prisma, and owns nothing;
- `Records-<hostname>`, the DNS host's record set holding the TXT and the CNAME.

The RoutingUrl waits on the record set, and is told through a new prop, `recordsPublished`, to wait for the TXT before refusing a hostname change.

`Prisma.Website` with `domain` now declares that composite as `Url`. With `domain.dns` it also keeps the released `DomainAlias` (the adapter's `alias` method, `proxied` removed), which now waits on the RoutingUrl. So with `dns`, the hostname's CNAME has two owners: `Url/Records-<hostname>` and `DomainAlias`.

`Prisma.CustomDomain` is deprecated. Its delete lists the app's RoutingUrls and skips the custom domain when a RoutingUrl with a `logicalId` holds the same hostname.

## Round 5 findings

| Finding | Status | Where |
| --- | --- | --- |
| S01 (F32): a refused hostname change had already removed the serving hostname's records | Resolved. The record set's id comes from the hostname, so a change creates a new set and the old one is deleted only after the deploy succeeds. Tests: "with dns, a refused hostname change leaves the serving hostname's records published" (RoutingUrl and Website). One gap: S18. | `f1f2b6d875` |
| S02 (F33): the ownership half of the check could never pass for an exact hostname, and the fake hid it | Resolved. The TXT at every authoritative nameserver now counts, and the platform's `updateRoutingUrl` looks the record up when it creates the domain ownership (`RoutingUrls.md`, "Ownership is read from domain ownerships only"). The fake no longer reports a `verified` row because a TXT is in the zone. | `f1f2b6d875` |
| S03: the same CNAME through two adapter methods | Resolved for `Prisma.RoutingUrl` (DNS-only, documented). For `Prisma.Website` the CNAME is now written through both methods on purpose; see S10 and S11. | `a3bb2c6d42` |
| S04: the record set is derived on the client | Accepted as interim. `Prisma.RoutingUrlDnsRecords` is now the one place that derives it, and `plan.md` records the platform request. | `f1f2b6d875` |
| S05: the hostname taken from a sibling's attribute | Resolved. The caller's `hostname` is used; the record set only orders it. | `f1f2b6d875` |
| S06: the inner resource named for the mechanism | Partly. The private constant is `RoutingUrlRow`, but the public props type is `RoutingUrlRowProps` (S15). `Prisma.RoutingUrl` still has no `.ref`, `.Provider` or `.Self`. | `f1f2b6d875` |
| S07: `waitFor…` called in a mode that does not wait | Open. `attempts` is now on `WaitOptions` too, so both checks have the mode the name contradicts. Minor. | `62df778dd2` |
| S08: `dns` outside the written scope | Resolved in `spec.md`. The pull request description was not checked. | spec |
| S09: the first deploy with `dns` repoints a hostname serving elsewhere | Resolved in the `dns` JSDoc and `apps.mdx`. | `f1f2b6d875` |
| F34 dev publishes live DNS; F35 Composer cannot register the provider; F36 `App.lookup` at plan time; F38 removing `dns`; F39 casts and missing endpoint; F40 missing evidence; F41 spec | Resolved, each with a fake test (`inDev`, `PublicSurface`, `appOutput`, `addDns`, `unpublishable`). F37 partly: a wildcard is refused before publishing; the docs still do not say that the record set treats an existing record with the same value as its own and removes it on destroy. | `f1f2b6d875` |

## Findings

### S10 — A new site with `domain.dns` on Cloudflare most likely fails its first deploy

- **Where:** `packages/prisma/src/Website/FrameworkSite.ts` lines 179–201 (`websiteDomain`); `packages/cloudflare/src/DNS/Records.ts` lines 245–281 (`read` with no state); `packages/alchemy/src/Apply.ts` lines 945–980 and `Plan.ts` lines 1842–1854 (the ownership check for a create whose props resolve during the deploy).
- **What happens:** On a first deploy, `Url/Records-<hostname>` (a Cloudflare `RecordList`) publishes the CNAME. `DomainAlias` (a Cloudflare `Records` set) waits on the RoutingUrl, so its props are unresolved at plan time. The engine therefore asks its provider, during the deploy, whether the record already exists. Cloudflare's `Records.read` finds the CNAME that `Records-<hostname>` has just published, and reports it as not owned by this stack. The engine stops with `OwnedBySomeoneElse` unless the user passed `--adopt`. The same happens on any redeploy after a first deploy that published the records but stopped before `DomainAlias` (for example a refused create).
- **Why this was not caught:** the fake DNS host's alias has no `read`, so it never refuses an existing record; the live test that covers this (`Cloudflare DNS publishes a site's TXT and CNAME…`) was not run. Route 53's `Record.read` adopts an existing record silently and Hetzner's `RecordList` has no such check, so only Cloudflare, the host the docs use as the example, is affected.
- **Confidence:** from reading the engine and the Cloudflare provider; not run.
- **Suggestion:** Declare `DomainAlias` with `adopt(true)`: the record it would take over is one this composite published a moment earlier, and `Records-<hostname>` already overwrites a foreign CNAME without asking, so this loses no protection. Give the fake alias a `read` that reports an existing CNAME at its name as not owned, as Cloudflare's does, so the fake test fails today. Run the live Website test before handover.

### S11 — Two resources own the site's CNAME, for every site and with no end date

- **Where:** `packages/prisma/src/Website/FrameworkSite.ts` lines 179–201.
- **Why the second owner exists:** a site deployed by the released Alchemy has `DomainAlias` in its state. If the new code stopped declaring it, Alchemy would delete it at the end of the upgrade deploy, and every adapter's delete removes the CNAME at the name, which `Records-<hostname>` has just published. Keeping it declared under the released id avoids that. Given the deadline (Prisma deletes the custom domain routes about 2026-12-21), this is a reasonable shape for the upgrade.
- **What happens in each case I checked:**
  - Hostname change: `Records-<new>` publishes first; the RoutingUrl check and `PATCH` run; then `DomainAlias` moves to the new name, removing the old CNAME; then the orphaned `Records-<old>` is deleted. A refused change touches neither the alias nor the old set. This is correct on Cloudflare, Route 53 (both writes are `UPSERT`; a `DELETE` of a record already gone is tolerated) and Hetzner (both add and remove values in the same RRSet).
  - Destroy: `DomainAlias` is deleted first, because it waits on the RoutingUrl, so the CNAME goes before the RoutingUrl row. Harmless during a destroy. `Records-<hostname>` then deletes a record already gone.
  - Removing `dns`: both owners are removed; the CNAME goes, as documented.
- **What is wrong with the shape:**
  1. It applies to every site, including new ones that have no released state to protect. Every new site carries a migration artefact.
  2. It can never simply be removed. Removing the declaration later reproduces the deletion it exists to prevent. The only clean exit is to give `DomainAlias` `RemovalPolicy.retain()` now (the policy is stored on the state row), and remove the declaration in a later release; a site that skips the release that wrote the policy would still lose its CNAME until its next deploy. Nothing in the code, `plan.md` or the spec says this.
  3. The CNAME value is computed twice: the alias from `compute.appEndpointDomain`, the record set from Prisma's `getService`. Both go through `switchboardTarget`, so they agree today. If they ever differ, each owner overwrites the other on every deploy (Cloudflare's `RecordList` and `Records` both replace a differing CNAME), and the hostname flips between targets.
  4. The spec says the Website declares "no `Prisma.CustomDomain` and no `Prisma.DomainOwnership`", but not that it keeps a second CNAME owner. That decision is not recorded.
- **Suggestion:** Keep the shape for this release, and: add `RemovalPolicy.retain()` to `DomainAlias`, so `Records-<hostname>` alone decides when the CNAME is deleted and the alias can be dropped later; take the alias target from the record set's CNAME (expose it from the composite, or from `RoutingUrlDnsRecords`), so there is one derivation; and record in `plan.md` and a one-line code comment when and how `DomainAlias` can be removed (together with `Prisma.CustomDomain`, after a release that wrote the retain policy).

### S12 — `CustomDomain`'s delete restates the RoutingUrl's takeover rule

- **Where:** `packages/prisma/src/CustomDomain.ts` lines 399–406.
- **What it does:** before deleting, it lists the app's RoutingUrls and skips the delete when one with a non-null `logicalId` holds the same hostname. Because Prisma keeps one row per hostname and records every custom domain as a RoutingUrl, that row is the custom domain itself, now managed by a RoutingUrl (this stack's, another stack's, or Composer's). Skipping is the right outcome in all three cases.
- **Fit:** the deprecated resource now depends on the new one's concept. That direction is acceptable for a resource whose routes disappear in about a month. It also relies on Alchemy deleting removed resources only after every create and update, so the RoutingUrl has written its `logicalId` before the CustomDomain's delete reads it; design note 12 relies on the same property.
- **What is weak:** "has a `logicalId`" is how `Prisma.RoutingUrl` decides a row is managed, and the CustomDomain now encodes that rule inline. If the RoutingUrl's takeover rule changes, this copy will not. The cleaner owner of the rule is the platform (`DELETE /v1/domains/{id}` leaving a row a RoutingUrl manages), which would also protect the `prisma service domain` commands, but those routes are being deleted, so it is not worth asking for.
- **Suggestion:** Name the rule once, next to the RoutingUrl's takeover code (for example `isManagedByRoutingUrl(url)` in an internal module), and use it in both places. Say in the CustomDomain's delete comment or JSDoc that it depends on removed resources being deleted last.

### S13 — `recordsPublished` is the composite's instruction, stored as a public prop of the resource

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 156–160 (`RoutingUrlRowProps`), 246–268, 548–556.
- **What is wrong:** the prop is part of the exported `RoutingUrl` resource interface and is saved in state, but it describes what the caller did ("This deploy publishes the hostname's records"), not what the resource does. Read cold, a user of `RoutingUrlResources` (Composer) sees a prop that claims something about the deploy. What the resource actually does with it is choose whether the ownership check waits for the TXT to appear or asks once.
- **Suggestion:** Name it for the behaviour, for example `waitForRecords?: boolean` with "Wait up to about a minute for the new hostname's records to appear at its authoritative nameservers before refusing a hostname change." The distinction itself is real (round 4 F29 removed the wait when nobody is publishing), so the prop should stay.

### S14 — `Prisma.RoutingUrlDnsRecords` and `RoutingUrl.records` use "records" for two different sets

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 283–341 and 590–637.
- **What is wrong:** `RoutingUrl.records` is the records Prisma still lists as unmet. `RoutingUrlDnsRecords.records` is every record the hostname needs, met or not; its whole reason to exist is that difference (round 5 S04). The same word now names both. The composite already declares it as `RequiredRecords-<hostname>`, and the platform request in `plan.md` calls the missing field "every record the hostname needs". The type string `Prisma.RoutingUrlDnsRecords` goes into every user's state with `dns`, so a later rename is a state migration.
- **Suggestion:** Rename the type to `Prisma.RoutingUrlRequiredRecords` (interface and props to match) before release. In its JSDoc, say it reads the same verification endpoint as the internal `DomainVerification` and why it is a separate resource (it also reads the app's switchboard inside the provider, which avoided round 5 F36).

### S15 — Three props types for one resource, and "Row" in a public name

- **Where:** `packages/prisma/src/RoutingUrl.ts`: `RoutingUrlProps` (lines ~120–154), `RoutingUrlRowProps` (156–160), `RoutingUrlInput` (270–272).
- **What is wrong:** all three are exported. `RoutingUrlProps` carries the field JSDoc users read but is no longer the parameter type of anything; `RoutingUrlInput` is the function's parameter type; `RoutingUrlRowProps` is the resource's. A fresh reader cannot tell which to use. "Row" names how the platform stores a RoutingUrl, not what the resource is, and the resource's type string and interface both say `RoutingUrl`.
- **Suggestion:** Make `RoutingUrlProps` the function's parameter type (with the "`dns` needs a plain `hostname`" union folded in) and drop `RoutingUrlInput`. Give the resource's props a name without "Row", or define them inline in the `RoutingUrl` interface as `Omit<RoutingUrlProps, "dns"> & { waitForRecords?: boolean }`.

### S16 — `RoutingUrlResources` solves Composer's problem for one composite only

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 343–347; `PublicSurface.test.ts`.
- **Judgement:** it does what Composer needs: `Provider.collection([...Prisma.RoutingUrlResources])` plus `Prisma.RoutingUrlProvider()`, and a test pins the list. There is no other export like it in Alchemy, and `Prisma.DomainOwnership` has the same gap (its inner resources are internal). The plural reads cold as "the RoutingUrls that exist", not "the resource types this composite declares".
- **Suggestion:** Keep it; it is the smallest change. Say in its JSDoc that it is for a hand-built provider list, as now, and name the pairing with `RoutingUrlProvider()` in one example. If another composite needs the same, make it a convention then, not now.

### S17 — The ownership rule lives in one place, but its two halves search DNS differently

- **Where:** `packages/prisma/src/RoutingUrl.ts` lines 436–497 (`ensureCanServe`); `internal/AuthoritativeDns.ts` lines 165–211 and 341–352; `internal/DomainOwnershipProof.ts` lines 225–240.
- **Answer to the question:** yes, "a verified covering domain ownership, or the TXT at every authoritative nameserver" is decided once, in `ensureCanServe`, and the JSDoc, `apps.mdx` and the error type say the same thing. `Prisma.DomainOwnership` applies a related rule before it creates or verifies a domain ownership, and there a TXT that could not be checked lets it go on, because Prisma's own lookup then decides and nothing stops serving. That difference is right, but it is written nowhere.
- **What is weak:**
  1. In one decision, the TXT half searches nameservers from the parent (`nameservers: "parent"`), the switchboard half from the name itself (`"name"`). The parent search treats a failed nameserver lookup as "no nameservers here" and moves one label up. Round 4 F28 fixed exactly this for the switchboard half: a failed lookup must give `unknown`. With the parent search, a delegated subdomain whose nameserver lookup times out is checked against the parent zone's servers and can come back `absent`, so the error says the TXT is missing when it could not be checked. The direction is safe (the change is refused), but the message is wrong.
  2. The error field `ownershipDns` mixes a platform status (`verified`) with DNS evidence (`seen`, `absent`, `unknown`); its name says DNS.
  3. `AuthoritativeRecordCheck`'s JSDoc still says only `Prisma.DomainOwnership` and `Prisma.CustomDomain` run it.
- **Suggestion:** Use the `"name"` search for the TXT name too, or a parent search that stops on a failed lookup. Rename the field to `ownership`. Fix the JSDoc, and add one sentence to `DomainOwnershipProof` saying why `unknown` lets it continue while the RoutingUrl check refuses.

### S18 — The record set's id is not one-to-one with the hostname

- **Where:** `packages/prisma/src/RoutingUrl.ts` line 254 (`hostname.replaceAll(/[^a-z0-9-]/g, "-")`).
- **What happens:** `a-b.example.com` and `a.b-example.com` both give `a-b-example-com`. A change between two such hostnames updates the same record set in place and removes the old records before the check, which is round 5's S01 again. Unlikely, but the fix exists only to make this impossible.
- **Suggestion:** Use an encoding that cannot collide (for example replace `.` with `--` after refusing `--` in labels, or the hostname itself if Alchemy ids allow dots).

### S19 — The upgrade guarantee is tested against a hand copy of the released wiring

- **Where:** `packages/integration-tests/test/Prisma/Website/Domain.test.ts` lines 52–76 (`siteDomain`, `releasedSiteDomain`); `FrameworkSite.ts` line 179 (`websiteDomain`, now exported).
- **What is weak:** the spec's upgrade condition is proven by deploying a hand copy of the released code inside `Namespace.push("Site")`, then `websiteDomain` in the same namespace. Nothing checks that the real `Prisma.Website` declares `DomainAlias` and `Domain` under those same fully qualified names; if it nests them differently, the test passes and real upgrades lose the CNAME and the row. `websiteDomain` is exported from a public module path (`@alchemy.run/prisma/Website/FrameworkSite`) so the test can call it, which `AGENTS.md` discourages. The fake alias also hides S10.
- **Suggestion:** Add one assertion that ties the copy to the real ids (for example a unit test that reads the names `deployWebsite` declares, or the live Website test checking the state's resource names before and after). Keep `websiteDomain` unexported from the package's public surface if the test can reach it another way.

### S20 — The spec still states the old ownership rule in a done condition, and omits the second CNAME owner

- **Where:** `project-docs/spec.md`, done conditions 4 and 7.
- **What is wrong:** condition 4 says a change "whose new hostname has no verified domain ownership fails before any `PATCH`"; the paragraph above it now allows the TXT at every authoritative nameserver. Condition 7 says the Website "declares a RoutingUrl and no CustomDomain or DomainOwnership", but not that it also keeps `DomainAlias`.
- **Suggestion:** Reword condition 4 to "cannot be shown to be owned (no verified domain ownership and the TXT not seen at every authoritative nameserver)". Add the S11 decision to the `Prisma.Website` paragraph.

### S21 — Jargon sweep

Most new text reads plainly. To rewrite:

- Test name "a hostname change publishes the new records, passes on the TXT, and removes the old records after the PATCH": say "goes through because the new hostname's TXT is seen".
- `RoutingUrlDnsRecords` JSDoc "Nothing exists in Prisma for it; deleting it is a no-op.": say "It creates nothing in Prisma, so deleting it does nothing."
- `RoutingUrlRowProps.recordsPublished` JSDoc: see S13.
- `FrameworkSite.ts` comment above `DomainAlias`: three sentences where one will do once S11's comment replaces it ("Keeps the CNAME a site from an earlier version published under this id, so the upgrade does not delete it.").

## Out of scope for this pass (for the code-review pass)

- `websiteDomain` turns every RoutingUrl error, including the composite's own `RoutingUrlInvalidHostname`, into a defect with `Effect.orDie`.
- Whether `getServiceUrls` in `CustomDomain`'s delete pages through more than one page.
- Whether `RecordList` and `Records` deletes tolerate a record the other owner already removed, on each host.
- `RoutingUrlDnsRecords.read` returns its stored output without reading Prisma again.

## Could not check

- Real DNS hosts and Prisma: no live tests were run. S10 rests on reading the engine and the Cloudflare provider.
- Whether the certificate for the new hostname is issued before traffic shifts. Design note 12's check covers ownership and DNS, not the certificate, so an allowed hostname change still has a few minutes without TLS on the new name while the old one is already removed. This predates the range.
