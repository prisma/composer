# Public URLs — design notes

The design itself is in the ADRs (0059 to 0062, pdp-control-plane ADR 015) and `docs/design/05-prisma-cloud/public-urls/composer-to-platform.md`. These notes record only the execution decisions from the discussion with Will on 2026-10-27 that the ADRs don't carry.

## 1. Day one, a named hostname may fail the deploy

Until the PDP RoutingUrl record and the Alchemy resource over it exist, `publicUrl.hostname()` lowers to `Prisma.CustomDomain`, which calls Foundry's `registerDomain` at once and is refused when the hostname's CNAME isn't in place. So on day one a hostname without DNS fails the deploy, naming the hostname and the DNS step.

**Why.** It lets `publicUrl()` ship on Composer's timeline and gives authors the model (which service is public, at which URL per environment) now. The failure is the same one a custom domain gives today, so nothing gets worse. When the record lands, `hostname()` switches resource with no change to authored code.

**Rejected.** Waiting for the PDP record before shipping `publicUrl()` at all: it serialises the whole project behind the longest slice. Retrying in the deploy until DNS appears: it hides a user action behind a spinner.

## 2. Lift the upstream default-Branch rule first, and wait for its release

`Prisma.CustomDomain` refuses unless the app is on the Project's default Branch (`ensureDefaultBranchApp`). PDP doesn't enforce that, so the check only blocks named hostnames on staging and preview environments. It goes first, in upstream Alchemy. `publicUrl()` waits for the Alchemy release that carries it; the check is patched out under `patches/` only if the release stalls.

**Why.** The provider is ours to change, the change is a deletion, and a pin bump is cleaner than carrying a patch.

## 3. A prisma.build URL creates nothing on the platform in step one

In step one, `publicUrl.prismaBuild()` reports the service's existing `*.prisma.build` endpoint and creates no record. In step two (P3) it lowers to the platform's `prisma.build` RoutingUrl.

**Why.** Every service already has that hostname. Settled on 2026-10-28: the first platform step covers custom hostnames only; making the platform's hostname an opt-in RoutingUrl is step two, with its scenarios in [step-two-migration-scenarios.md](../../docs/design/05-prisma-cloud/public-urls/step-two-migration-scenarios.md). Old Composer versions cannot describe routing records in their deploy state, so both steps rely on the Alchemy resource adopting a row it never created, by service and hostname; step two applies it to every service's `prisma.build` row at once, which is why it follows.

## 4. Module `input` and config adapters are a follow-on project

The spike on typed per-key input references, `module()` taking `input`, `resolve()` over inputs and the `config` adapters with `dotenv()` are recorded in ADR-0061 and ADR-0062 but are not part of this project. This project ships `resolve()` over `environment.name` and other resolved values only; input references come with that project.

**Why.** They serve a different purpose (how a module is configured), none of the public-URL scenarios needs them, and Will put config adapters off the critical path. Keeping them here would make eleven slices of a project whose own purpose needs eight.

## 5. Who does what

Will and the orchestrating agent designed the platform records (D1) together on 2026-10-27; their implementation goes to the control-plane team under another agent, with `projects/routing-urls/` in pdp-control-plane as the brief. U1 and C2 run in sessions this one started. The remaining slices are dispatched, each in its own session, following the Drive process. Will tracks the work outside Linear.

## 6. Prisma now requires an ownership TXT record before registering a hostname

Since prisma/pdp-control-plane#5785 (2026-10-24), `POST /v1/apps/{appId}/domains` refuses with 422 `domain-ownership-required` unless `_prisma-verification.<hostname>` carries the workspace's value. Composer never publishes DNS, so for Composer this is one more record the author publishes, the ownership proof ADR-0060 already describes. P1's "DNS not ready" error and its live check must cover this record as well as the CNAME. Alchemy's website functions and its live custom-domain test don't publish it; Will handed that to the provider's maintainers on 2026-10-27. It does not block U1.
