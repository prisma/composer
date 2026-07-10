# Hex Composition — Project Spec

## Purpose

Make hexes reusable components. Concretely: after this project, an Auth hex
exists as a workspace package, the storefront-auth example installs it and
consumes it through one typed contract port, and a same-contract fake drops
into the same slot without the storefront changing a line.

## At a glance — the code this project makes possible

The reusable component (new package `examples/auth-hex`):

```ts
// examples/auth-hex/src/hex.ts — the package's main export
import { hex } from "@prisma/app";
import { authContract } from "./contract";
import authService from "./service";           // the existing auth service, moved here

export default hex("auth", { expose: { verify: authContract } }, ({ provision }) => {
  const db = provision("db", postgres(/* … */));      // the hex provisions the resource…
  const api = provision("api", authService, { db });  // …and passes it to the service
  return { verify: api.verify };                      // child's exposed port becomes the hex's output
});
// (resource-wiring syntax illustrative — follows the resource-decoupling design;
// packaging a service together with its resource is exactly what a hex is for)
```

The app consuming it (`examples/storefront-auth/hex.ts` rewritten):

```ts
import authHex from "@prisma-examples/auth-hex";   // installed, workspace:*
import storefrontService from "./hexes/storefront/src/service";

export default hex("storefront-auth", {}, ({ provision }) => {
  const auth = provision("auth", authHex);                            // a hex, provisioned like a service
  provision("storefront", storefrontService, { auth: auth.verify }); // wired by contract port
  return {};
});
```

The fake (new `examples/storefront-auth/fake/` + an alternate topology file):

```ts
// hex.fake.ts — same slot, same contract, no database; storefront untouched
const auth = provision("auth", fakeAuthService);
provision("storefront", storefrontService, { auth: auth.verify });
```

`makerkit deploy hex.ts` deploys the composed topology; `makerkit deploy
hex.fake.ts` deploys (or Load-checks) the faked one. Design contract:
[ADR-0014](../../../docs/design/90-decisions/ADR-0014-a-hex-has-the-same-boundary-as-a-service.md)
+ [hex-composition.md](../../../docs/design/10-domains/hex-composition.md)
(exact signatures, Load rules, addresses).

## What gets built, by file

1. **Core** (`packages/app/src/node.ts`, `graph.ts`):
   - `hex(name, { deps?, expose? }, body)` replacing `hex(name, body)`;
     `HexContext` (`inputs` + `provision`), `HexOutputs`, `InputRef`;
     `HexNode<D, E>` carrying the boundary types.
   - `provision()` overload accepting `HexNode<D, E>` → `ProvisionedRef<E>`.
   - Load: recursive flatten; hierarchical dot-joined addresses; four
     validation errors (exact texts in hex-composition.md § Load), e.g.:
     `Hex "auth" declares input "db" but never forwards it into a provision.`
   - Type-level tests (R6 `test-d` pattern) incl. a 3-level nesting case.
2. **Pipeline** (`packages/app-assemble`, `packages/app-cli`,
   `packages/app/src/deploy.ts`):
   - Bundle correlation keys become full addresses (`auth.api`, not `api`)
     through assembly → generated stack file → `lower()` lookup.
   - `${build.pack}/assemble` resolves from `build.module` instead of the
     deploy entry (ADR-0004 as amended) — an installed hex's adapter never
     becomes the app's dependency.
3. **The example proof**:
   - New workspace package `examples/auth-hex` (`@prisma-examples/auth-hex`):
     the existing auth service + contract move in; own `build` script
     producing `dist/server.js`; `@prisma/app*` + `@prisma/app-cloud` as
     peer dependencies (exactly as a published hex would declare them).
   - `examples/storefront-auth` rewired per the code above; its
     `hexes/auth/` directory dissolves into the package.
   - `fake/` service exposing `authContract` from in-memory state + the
     `hex.fake.ts` topology.
   - `.github/workflows/e2e-deploy.yml` keeps deploying `hex.ts` — now a
     nested topology — unchanged in shape.

## Non-goals

- Target-neutral hexes; shared resources (tree→DAG); hex-level params —
  named as extension points in the domain doc, not built here.
- Publishing to the real npm registry (the workspace package exercises the
  same resolution and peer-dep mechanics).
- Changing the resource-provisioning model (see Dependencies).

## Dependencies & coordination

Hex-composition rebases onto two already-in-flight branches, in order:
- **PR #21 — resource decoupling.** Services declare resource-input slots;
  hexes `provision()` resources. **H3 hard-depends on it** — the auth hex
  provisions its db at hex level and passes it to the service (resources are
  never service-internal). H1/H2 need only ConnectionEnd inputs.
- **PR #22 — always-hex root.** The deploy root must be a hex; bare services
  are not independently deployable (Load errors with "wrap it in a hex"). The
  service-root pipeline path, `examples/makerkit-hello`, and the e2e hello job
  are already removed on #22's line. Baseline to build against: always-hex
  root, bundles-keyed-by-address only. The ADR-0003 amendment for this is
  operator-owned on the #22 line — not ours to edit.

Full rebase facts and the makerkit-hello/redeploy-noop fallout are in
design-notes.md § Coordination facts.

## Cross-cutting requirements

- Every validation rule is a tested, fix-naming error (the CLI project's
  error-surface standard).
- Compile-time checks primary, Load `satisfies()` backstop; `lint:casts`
  delta ≤ 0; plane-separation and runtime-portability invariants hold
  (composition adds nothing to runtime bundles).
- Doc-first covenant: deviations from ADR-0014/hex-composition.md amend the
  doc, never silently diverge.

## Project DoD

- [ ] The three code blocks under "At a glance" compile and run verbatim
      (module specifiers aside) in the repo.
- [ ] CI e2e deploys the composed topology live: nested auth hex, storefront
      round trip renders, destroy clean.
- [ ] The fake topology passes typecheck + an integration test driving the
      real CLI through Load; `git diff` between real and fake topologies
      touches no storefront file.
- [ ] Integration test proves an installed package's service can use an
      adapter the consuming app does not declare (build.module-anchored
      resolution).
- [ ] All four Load validation errors exercised by tests asserting message
      content; 3-level nesting type-test green.
- [ ] Gates green; docs match shipped reality.

## Open questions

None. All four held points are resolved: the breaking `hex()` reshape and
the validation-rule set are confirmed; the auth hex provisions its db at hex
level (never service-internal); H3 queues behind the resource-decoupling
landing and adopts its wiring syntax.
