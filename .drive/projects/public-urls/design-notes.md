# Public URLs — design notes

The design itself is in the ADRs (0059 to 0062, pdp-control-plane ADR 015) and `.drive/projects/public-urls/design/composer-to-platform.md`. These notes record only the execution decisions from the discussion with Will on 2026-10-27 that the ADRs don't carry.

## 1. Day one, a named hostname may fail the deploy

Until the PDP RoutingUrl record and the Alchemy resource over it exist, `publicUrl.hostname()` lowers to `Prisma.CustomDomain`, which calls Foundry's `registerDomain` at once and is refused when the hostname's CNAME isn't in place. So on day one a hostname without DNS fails the deploy, naming the hostname and the DNS step.

**Why.** It lets `publicUrl()` ship on Composer's timeline and gives authors the model (which service is public, at which URL per environment) now. The failure is the same one a custom domain gives today, so nothing gets worse. When the record lands, `hostname()` switches resource with no change to authored code.

**Rejected.** Waiting for the PDP record before shipping `publicUrl()` at all: it serialises the whole project behind the longest slice. Retrying in the deploy until DNS appears: it hides a user action behind a spinner.

## 2. Lift the upstream default-Branch rule first, and wait for its release

`Prisma.CustomDomain` refuses unless the app is on the Project's default Branch (`ensureDefaultBranchApp`). PDP doesn't enforce that, so the check only blocks named hostnames on staging and preview environments. It goes first, in upstream Alchemy. `publicUrl()` waits for the Alchemy release that carries it; the check is patched out under `patches/` only if the release stalls.

**Why.** The provider is ours to change, the change is a deletion, and a pin bump is cleaner than carrying a patch.

## 3. A prisma.build URL creates nothing on the platform in step one

In step one, `publicUrl.prismaBuild()` reports the service's existing `*.prisma.build` endpoint and creates no record. In step two (P3) it lowers to the platform's `prisma.build` RoutingUrl.

**Why.** Every service already has that hostname. Settled on 2026-10-28: the first platform step covers custom hostnames only; making the platform's hostname an opt-in RoutingUrl is step two, with its scenarios in [step-two-migration-scenarios.md](../../../.drive/projects/public-urls/design/step-two-migration-scenarios.md). Old Composer versions cannot describe routing records in their deploy state, so both steps rely on the Alchemy resource adopting a row it never created, by service and hostname; step two applies it to every service's `prisma.build` row at once, which is why it follows.

## 4. Module `input` and config adapters are a follow-on project

The spike on typed per-key input references, `module()` taking `input`, `resolve()` over inputs and the `config` adapters with `dotenv()` are recorded in ADR-0061 and ADR-0062 but are not part of this project. This project ships `resolve()` over `environment.name` and other resolved values only; input references come with that project.

**Why.** They serve a different purpose (how a module is configured), none of the public-URL scenarios needs them, and Will put config adapters off the critical path. Keeping them here would make eleven slices of a project whose own purpose needs eight.

## 5. Who does what

Will and the orchestrating agent designed the platform records (D1) together on 2026-10-27; their implementation goes to the control-plane team under another agent, with `projects/routing-urls/` in pdp-control-plane as the brief. U1 and C2 run in sessions this one started. The remaining slices are dispatched, each in its own session, following the Drive process. Will tracks the work outside Linear.

## 6. Prisma now requires an ownership TXT record before registering a hostname

Since prisma/pdp-control-plane#5785 (2026-10-24), `POST /v1/apps/{appId}/domains` refuses with 422 `domain-ownership-required` unless `_prisma-verification.<hostname>` carries the workspace's value. Composer never publishes DNS, so for Composer this is one more record the author publishes, the ownership proof ADR-0060 already describes. P1's "DNS not ready" error and its live check must cover this record as well as the CNAME. Alchemy's website functions and its live custom-domain test don't publish it; Will handed that to the provider's maintainers on 2026-10-27. It does not block U1.

## 7. A deploy prints the records to publish; the platform turns a published record into the claim

Settled 2026-10-29. For a pending hostname the deploy output prints every record the user still has to publish, the ownership TXT record and the CNAME, with name, type and value, not a Console link. On the platform, a RoutingUrl carries the TXT record among its conditions and creates nothing else; when the platform finds the record in DNS it creates the workspace's domain ownership claim, verified. No unverified domain ownership exists: the Console's Domains page shows the record and asks the platform once a minute until the domain ownership is created, and a wildcard domain ownership is created only that way (settled later the same day).

**Why.** A claim belongs to the workspace and outlives any one project or environment, so Composer cannot own one: a destroy of a preview would delete production's proof. Having the platform create the claim on verification gives the deploy-first flow with no second resource and no side effect on create. The pattern matches Cloudflare's custom hostnames and AWS Certificate Manager, which return the validation record from the create and track it on the hostname.

**Rejected.** The RoutingUrl creating an unverified claim as a side effect: it leaves a claim row for every hostname ever declared and creates a resource outside the request's own. Composer creating the claim: it would own something it must not delete.

## 8. Publishing DNS through an adapter is a follow-on, and the foundation is laid now

Settled 2026-10-29. Composer does not publish DNS in this project. The records to publish are exposed twice so that a later feature can: as outputs of the Alchemy RoutingUrl resource, and in the `DeployedEntity` the deploy reports. A follow-on project adds an option on the Prisma Cloud extension naming a DNS provider, lowered to the same Alchemy DNS adapter Alchemy's own sites use, so a hostname on a provider Composer can drive needs no manual step. ADR-0060's statement that Composer never publishes DNS is amended when that lands.

## 9. The thing `resolve()` returns is a value

Settled 2026-10-29. A **value** is an opaque handle in a module body for something that has a real value once the graph is fully evaluated. The body can pass it where a value of its type is accepted and nothing else. A value is **provided or computed**: `environment.name` is provided; `resolve(dependencies, fn)` returns one computed from others. A value is **deploy-time or runtime**: a deploy-time value holds its real value by the end of Load; a runtime value is known only on the deployment system, and its deploy-time form is a pointer to it. The type is `Value<T>`, in place of ADR-0062's `ResolvedValue<T>`.

**Why.** Gradle's `Provider<T>`, Pulumi's `Output<T>` and CDK's `Token` each use one type for a handle whose real value comes later, supplied or derived; nothing that consumes one cares which. "Lazy" was rejected because evaluation on demand is not the point; the point is that the value depends on a calculation over its inputs. Two public types, one for computed values and one for references, were rejected because the distinction is where Load gets the real value, which the body never sees. The data a value stands for is its real value.

## 10. `envParam()` and `envSecret()` become values later, not in this project

Settled 2026-10-29. All four combinations exist in the model: config and secrets, each deploy-time or runtime. `envParam()` and `envSecret()` were the first attempt at this problem; they will return values, the special handling of environment variables will be replaced by config adapters and secret adapters, and the two functions will then create a persisted resource for a value instead of passing it through. That lands with the `module-input` project. In this project, `environment.name` is the only provided value, and the two functions keep their current types; a computed value may return what they return today.

## 11. A public URL is a resource; a resource may carry an edge and options from construction

Settled 2026-10-29. A public URL lowers to a RoutingUrl whose lifecycle Alchemy manages, so by the glossary's test it is a resource by kind; it is a driver by role, since it depends on what it serves and nothing calls it. To build it, core lets a resource declare dependency slots and wire them when the node is constructed (`resource({ inputs, deps })`), and carry plain-data `props` that Load's second pass resolves. The slice spec for C1 pins the mechanism. This amends the resource decision (ADR-0013), which modelled a resource as a producer only, with no dependency slots of its own. Settled with Will after the design review, 2026-10-29: a resource keeps `provides` (a public URL provides its HTTP ingress point as its own contract); the producers are `deps`, with the meaning `deps` has at `provision()`; the configuration is `props`; a computed value may not return a secret or param source. Will also noted that the glossary's Input and Output are inverted against the ports-and-adapters model (what a node is called through is its input port; what it calls is its output port); that rename is its own decision record, written beside C1.
