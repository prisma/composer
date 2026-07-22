# ADR-0039: A compute service's own origin is a target-resolved property

## Decision

A compute service's own platform-assigned public origin is a property of the
service, resolved by the Prisma Cloud target — never a declared param, never
operator-supplied config. Nothing is declared; app code reads it from the
service node:

```ts
const chat = compute({ name: 'chat', deps: { /* … */ }, build: node({ /* … */ }) });

// inside the service:
const url = chat.origin();   // "https://<id>.<site>.prisma.build"
```

The value rides ADR-0031's reserved provider-param channel end to end: an
`ORIGIN` entry (brand `SELF_ORIGIN`) on the target's reserved list, a
deploy-side value function that reads the provisioned service's own
`endpointDomain`, the generic descriptor loop writing the row
(`COMPOSER_<addr>_ORIGIN`) for **every** compute service, and the existing
boot loop stashing it address-free. `origin()` is a memoized method on the
`ComputeService` class beside `run`/`load`/`config`/`secrets` — a fourth
accessor, because the origin is neither a dep, a param, nor a secret
(ADR-0021). It never appears in `config()`.

`envParam(…)` remains the right shape for a *genuinely operator-known* origin
— a custom domain the operator provisioned themselves. This ADR covers only
the origin the platform assigns.

## Reasoning

**Operator input was a category error.** The first port that needed its own
URL at boot (Better Auth `baseURL`, Stripe redirects) modelled it as
`envParam('APP_ORIGIN')`. But no operator knows this value — the platform
assigns it at deploy. Putting a platform output in an operator-input slot
forced a five-step manual loop: deploy with a placeholder, read the assigned
URL from the deploy report, PATCH the platform variable, force an artifact-hash
change so the redeploy isn't a no-op, revert. The manual PATCH also wrote a
bare string where the deserializer expects JSON, crash-looping the service.

**The value is knowable before the version exists.** The compute *service*
(the stable endpoint, hence the URL) is a separate resource from the *version*
(the running code and its env). Order is service-create → version-create →
boot → promote, so a service-resource attribute can feed its own version's env
without a cycle. The self-reference only looks circular.

**The platform owns the answer; the framework reads it verbatim.** The
create-time endpoint domain used to be a wrong-region placeholder (PRO-200);
the Management API now composes it from the service's actual region and
documents it as a contract: the pre-promote endpoint domain names the domain
the service will serve on. The framework never string-builds the URL from a
region map — that would couple it to the platform's URL convention and break
silently if the scheme changed (the no-guessing rule, ADR-0005).

**The framework supplies the value in every environment**, like any other
config: deploy writes the row unconditionally; a test harness sets
`COMPOSER_ORIGIN` exactly as it sets other `COMPOSER_*` rows; a local runner
writes it because it binds the port. Calling `origin()` where nothing supplied
the row is an ordinary loud missing-config error, raised lazily at the call so
services that never read it are unaffected.

## Consequences

1. `compute()` returns a concrete exported `ComputeService` class implementing
   core's `RunnableServiceNode` (the brand made nameable by core's type-only
   `NODE` export). App code holding its own service module sees `origin()`
   directly.
2. `origin` is a reserved name in the service-own key space: a user param or
   secret slot named `origin` (any casing) fails at authoring.
3. The reserved provider-param channel now has two entry kinds: edge-derived
   (`value(refs)`, written only for exposing services) and service-derived
   (`valueForService(provisioned, address)`, written for every compute
   service). Origin is the first service-derived entry.
4. When custom domains land, they bind as ordinary params (operator-known);
   `origin()` keeps meaning the platform-assigned origin.

## Alternatives considered

- **Keep `envParam('APP_ORIGIN')` + manual correction** — every step of the
  workaround was self-inflicted by the wrong category, and the manual PATCH
  crash-looped the service.
- **Framework builds the URL from a region→subdomain map** — guessing
  (ADR-0005), and couples the framework to a URL scheme the platform owns.
- **Framework-driven two-pass deploy** (write env post-promote) — better than
  the manual loop but redeploys every service on first deploy; unnecessary
  once the create-time value is contractual.
- **A platform-injected well-known env var** (the `VERCEL_URL` pattern) —
  workable, but a larger platform change, and it hands the value only to the
  process, not to the deploy-time graph.

## Related

- ADR-0005 (no guessing), ADR-0021 (separate accessors), ADR-0031 (reserved
  provider params), ADR-0032 (operator-bound params — the shape this ADR
  narrows for self origins).
- [PRO-200](https://linear.app/prisma-company/issue/PRO-200/compute-services-create-returns-a-placeholder-region)
  — the placeholder-domain bug; fixed upstream by
  [pdp-control-plane#4650](https://github.com/prisma/pdp-control-plane/pull/4650),
  which made the pre-promote domain contractual.
- gotchas.md § "compute-services create returns a placeholder-region
  serviceEndpointDomain" — the field report behind PRO-200.
