# Deferred

- Alchemy `packages/prisma/src/RoutingUrl.ts`: remove the `hasNoDomainOwnership` string helper and its `TODO(sdk)` comment, and compare `url.state` with `"no_domain_ownership"` directly, once Distilled is regenerated from a Management API spec that lists that state (prisma/pdp-control-plane#6153).
