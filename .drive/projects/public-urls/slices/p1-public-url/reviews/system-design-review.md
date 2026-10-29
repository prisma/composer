# P1 system-design review

Range: `git diff origin/main...HEAD` on `claude/public-url-p1`. Spec: [spec.md](../spec.md).

Read for this review: the guiding and architectural principles, the purpose docs, ADR-0057 (a node's address is its identity), ADR-0060 (the public URL) with its amendment, ADR-0062 (`resolve()` and values), ADR-0063 (a node depends on an interface or exposes one), the glossary entries for Resource, Driver, Value, Ingress, Address and Dependency, the project spec, plan and design notes (note 12 in full), and the P1 slice spec.

## What the branch adds

A new node kind, the public URL, in the Prisma Cloud extension. `publicUrl({ name, url, target })` builds a resource node through core's `resource()`, with one `target` dependency slot typed as a raw HTTP interface and `url` in `props`. The two strategies are frozen plain objects, so a `resolve()` callback can return them. A Prisma Cloud descriptor lowers a named hostname to one `Prisma.CustomDomain` and the prisma.build strategy to nothing. The local target registers a stand-in custom domain provider. Core gains one generic field, `PreflightInput.warn`, and the CLI gains one dev event, `target-warning`.

New guarantees:

- `url` is checked in one place (`parseHostname` and `resolvedStrategy`), used at construction, in both preflights and in the descriptor.
- A hostname change cannot take a serving hostname out of service, because the hostname is in the Alchemy resource id and Alchemy deletes only after every create succeeds. A test proves this under the real apply engine.

## What fits well

- **Core stayed free of public-URL knowledge.** The only core change is `warn` on `PreflightInput`, which says nothing about URLs. The CLI's `target-warning` event carries a message and nothing else. This matches "thin core, fat targets" and ADR-0060's "core learns nothing about the platform".
- **The node's shape matches ADR-0060 and ADR-0063.** It is a resource by kind, depends on one exposed HTTP interface, and exposes nothing (`ResourceNode<undefined, …>`). The type test proves that an RPC interface, a Postgres interface or a bare reference is not a valid `target`.
- **The authoring module does not pull control-plane code.** `public-url.ts` is classified as the shared plane, imports only `@internal/core` and `@internal/http` (an authoring-layer package), and imports `Graph` as a type only. The descriptor, a control-plane file, imports from it, which is the right direction. The package root exports only `publicUrl` and its types; `parseHostname`, `resolvedStrategy` and `publicUrlStrategies` stay internal.
- **Vocabulary follows the owning systems.** User-facing words are "public URL" and "strategy", as in ADR-0060. "Custom domain" appears only where the platform and Alchemy resource are meant, which is their own word.
- **Tests are placed at the level of the property they prove.** The ordering property (AC 10) is proved against Alchemy's apply engine with a fake Management API, not by mocking Alchemy. That is the only way to prove a property that depends on the engine's create-before-delete order.

## Findings to fix in this branch

### A01. `warn` is a framework surface that deploy silently drops

- **Location:** `packages/0-framework/1-core/core/src/control/app-config.ts` (the `warn` field); `packages/0-framework/3-tooling/cli/src/operations/execute-deploy-destroy.ts` around line 522.
- **Issue:** `PreflightInput` is shared by the deploy preflight and the dev preflight. Its doc comment says `warn` "shows the user a warning that does not stop the run", but deploy passes no `warn`. Any extension that calls `warn` from its deploy preflight gets nothing shown, with no sign that this happened. The spec chose this ("Deploy passes none"), but the core type does not say so, so the surface promises more than it does.
- **Suggestion:** Wire `warn` in deploy too, to a warning line in the preflight step's output. It is a few lines and makes the surface honest in both commands. If that is not wanted now, say in the doc comment that only `prisma dev` shows it today, so a future extension author is not surprised.

### A02. ADR-0060 still says the opposite of what the guide and skill now teach

- **Location:** `docs/design/90-decisions/ADR-0060-public-traffic-reaches-a-service-through-a-public-url.md`, Consequences, "Changing a hostname replaces it"; `docs/guides/building-an-app.md`, "Before you name a hostname"; `skills/prisma-composer-core-concepts/SKILL.md`.
- **Issue:** The guide and the skill ship the rule from design note 12: a change from a serving hostname to one that cannot serve fails the deploy, and the old one keeps serving. ADR-0060 still says the old hostname stops being served and the new one serves once verified. Design note 12 schedules the amendment "before P2's code merges", but this branch already ships user-facing docs built on the new rule. The project spec's cross-cutting rule is that recorded decisions are updated before the code that depends on them merges.
- **Suggestion:** Add the amendment from design note 12 ("What this amends") to ADR-0060 in this branch, as a dated amendment line at the top like the existing one. This moves the amendment earlier than note 12 planned; it reverses nothing.

### A03. Design note 11 contradicts ADR-0063 on whether a public URL provides anything

- **Location:** `.drive/projects/public-urls/design-notes.md`, note 11.
- **Issue:** Note 11 says "a public URL provides its HTTP ingress point as its own contract". ADR-0063, the ADR-0060 amendment, the glossary and this branch's code all say a public URL exposes nothing. The code is right. The note will mislead whoever specifies P2 or does the project close-out.
- **Suggestion:** Rewrite that clause to say a resource keeps `provides` in general, and a public URL provides nothing (ADR-0063).

### A04. The plan says P1 writes the address as `logicalId`; it does not

- **Location:** `.drive/projects/public-urls/plan.md`, the P1 line: "One `DeployedEntity` per public URL with the node's address as its `logicalId`."
- **Issue:** The slice spec (§ 5.3) and the code key the entity by the node's address in the render only. `Prisma.CustomDomain` has no `logicalId` field, so no platform row carries the address until P2. The branch edits this very line and keeps the wrong claim.
- **Suggestion:** Say "one `DeployedEntity` per public URL, under the node's address; the platform row gets the address as its `logicalId` in P2".

### A05. The deploy preflight calls a function only for the exception it may throw

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/preflight.ts`, first line of `runPreflight`: `publicUrlStrategies(input.graph);`
- **Issue:** The call discards a list it builds. A reader sees a query whose result is unused and may delete it. The intent, "check every public URL's resolved `url` before anything is created", is not in the code.
- **Suggestion:** Add a function named for the check, for example `checkPublicUrls(graph): void`, in `public-url.ts`, and call it here. The dev preflight keeps using `publicUrlStrategies` because it needs the list.

### A06. The extension id is copied into a new constant

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/public-url.ts`, `const EXTENSION = '@prisma/composer-prisma-cloud'`.
- **Issue:** The spec names `PRISMA_CLOUD_EXTENSION_ID` (in `container.ts`). The branch adds a second private constant for the same string. `publicUrlStrategies` matches nodes on it, so a drift would make the preflights skip every public URL without error. Sibling authoring files repeat the literal too, so this is existing debt the branch extends rather than introduces.
- **Suggestion:** Use `PRISMA_CLOUD_EXTENSION_ID` if `container.ts` can be imported from a shared-plane file without pulling control-plane code. If it cannot, move the constant to a small shared file and import it from both.

## Findings for later slices

### A07. P2: switching from `Prisma.CustomDomain` to `Prisma.RoutingUrl` can delete the row P2 just adopted (P2, U2)

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/descriptors/public-url.ts` (resource id `shop.site.domain.<hostname>`); the P2 plan line.
- **Issue:** When P2 changes the lowering, the program stops declaring the custom domain and starts declaring a RoutingUrl. Alchemy creates the RoutingUrl, which adopts the backfilled row for the same hostname and service. Then Alchemy removes the custom domain that the program no longer declares, and its provider calls the platform's delete. Platform slice 2 moves the custom-domain routes onto RoutingUrl records, so that delete can remove the row just adopted and take production's hostname out of service. That breaks the rule in design note 12. Nothing in the plan or `.drive/deferred.md` records it.
- **Suggestion:** Record it now in the P2 plan line: P2 must drop P1's custom domain from Alchemy state without calling delete (a state move, as ADR-0057's migration did for renamed resource ids), and a test must prove the hostname keeps serving through the upgrade. Why later: the RoutingUrl resource does not exist yet.

### A08. A hostname in the resource id departs from "every identifier is built from the address" (P2)

- **Location:** `descriptors/public-url.ts`, `resourceId(address, 'domain', hostname)`.
- **Issue:** ADR-0057 and the glossary build Alchemy resource ids from the address plus a role. This id also carries a value that differs per environment. It is a deliberate step-one choice (spec § 5.1, design note 12) and `resourceId`'s own comment allows an extra part "when a node has several". It is sound for P1. It should not outlive P1.
- **Suggestion:** P2's spec should state that the RoutingUrl's resource id is the address alone, so the deviation ends with `Prisma.CustomDomain`.

### A09. The public URL reads the compute service's outputs outside the connection contract (P2)

- **Location:** `descriptors/public-url.ts`, `targetService`; `descriptors/compute.ts`, the new `serviceId` output.
- **Issue:** Other consumers get a producer's outputs through the connection's declared params, with the presence check core enforces (ADR-0033, `slotConnectionParams`). The public URL reads `serviceId` and `url` from `ctx.lowered` by name and repeats the presence check itself. The coupling stays inside one extension and the spec chose it, so it is acceptable now. If the RoutingUrl also needs the service id, or another target implements public URLs, this private agreement between two descriptors will spread.
- **Suggestion:** In P2, decide whether the platform service id belongs in the raw HTTP connection's params for Prisma Cloud, so the public URL gets it through the normal path. Why later: P1 has one consumer and the RoutingUrl's inputs are not known yet.

### A10. Unprefixed strategy type names in the package root (P3)

- **Location:** `packages/1-prisma-cloud/1-extensions/target/src/exports/index.ts`: `HostnameStrategy`, `PrismaBuildStrategy`.
- **Issue:** They are exported beside `PublicUrlStrategy`, `PublicUrlOption` and `PublicUrlNode`. Read cold in the package root, `HostnameStrategy` does not say it belongs to a public URL. The names match ADR-0060's "two strategies", so this is not a vocabulary error, only a symmetry gap.
- **Suggestion:** Leave them for P1. If P3 or a later slice adds another kind of strategy to the package, rename them to `PublicUrlHostname` and `PublicUrlPrismaBuild` (or similar) then. Why later: renaming public types has a cost, and no collision exists today.

## Out of scope for this pass

- The `blindCast` change in `control/extension.ts` is unrelated to public URLs. It is harmless, but it belongs to the code review or its own commit.
- Error message wording, edge cases of the hostname rule, and whether the dev warning repeats after a re-converge are implementation questions for the code review.
