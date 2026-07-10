# ADR-0008: The boot wrapper inlines everything except runtime built-ins

## Status

Accepted

## Decision

When assembly bundles the service module into the boot wrapper, it inlines
every import except the hosting runtime's own modules: `bun`, `bun:*`, and
`node:*` stay external; everything else — workspace packages, contract
libraries, database clients — is bundled in. There are no per-app bundling
options.

## Reasoning

A service module is not import-free. A typical one pulls in the pack's
vocabulary, a database client factory, and whatever its contracts need:

```ts
// src/service.ts
import { compute, postgres } from "@prisma/app-cloud";
import { SQL } from "bun";
import { authContract } from "@storefront-auth/auth/contract"; // evaluates arktype at import
```

Assembly bundles this module into `main.mjs`, the boot wrapper that runs
before the app's own entry (ADR-0005). The wrapper lands inside the deploy
artifact next to the app's built output — and that artifact's `node_modules`
contains only what the app's *own* build traced (a Next standalone tree
carries Next's dependencies, not arktype). Any import the wrapper doesn't
bundle is an import that fails at boot.

So every wrapper import must be either bundled in or provided by the runtime,
and something has to decide which is which. Per-app configuration is not
available to make that call: the deploy path deliberately has no config file
(ADR-0003), so there is no place for an app to declare "also inline these
two packages" — and inventing one for bundling knobs would reopen the door
ADR-0003 closed. The rule therefore has to be general, and only one general
rule is safe: inline everything the hosting runtime does not itself provide.
Runtime built-ins (`bun`, `bun:*` schemes, `node:*` builtins) resolve inside
the deployed VM by definition; nothing else is guaranteed present, so
everything else gets bundled.

One mechanical note makes the rule implementable: the bundler's explicit
`external` list wins over a match-everything `noExternal` pattern, so runtime
built-ins stay external even under the catch-all — verified empirically
rather than assumed, since the whole boot path depends on it.

## Consequences

- Pure-JavaScript dependencies inline cleanly — workspace packages and
  import-time contract libraries need no declarations anywhere.
- Native addons do not survive inlining: a service module importing a package
  with `.node` bindings gets its JavaScript bundled but not the binary, and
  fails at boot rather than at assembly. Client factories should stick to
  pure-JS drivers or runtime built-ins. Detecting addon-bearing dependencies
  at assembly and failing loudly there is the strengthening this rule wants.
- The wrapper's size grows with the service module's import graph. Service
  modules are declarations plus client factories by design, so the graph
  stays small — but a service module that imports an application's worth of
  code will get an application's worth of wrapper.

## Alternatives considered

- **Per-app bundling configuration** (an externals/inline list the app
  declares) — no home for it: the deploy path has no config file (ADR-0003),
  and adding one for bundler knobs would be the tail wagging the dog.
- **Deriving the external set from the artifact's `node_modules`** (inline
  only what the app's build didn't trace) — couples the wrapper build to the
  internals of each framework's output tracing, which is exactly the kind of
  entanglement ADR-0005 exists to prevent.
- **A curated allow-list of inlinable packages** — a maintenance burden that
  breaks the first time a community app imports something the list hasn't
  met.

## Related

- [`ADR-0005`](ADR-0005-users-build-the-framework-assembles.md) — the wrapper and
  the assembly boundary it lives behind.
- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) —
  why no per-app configuration surface exists.
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md)
