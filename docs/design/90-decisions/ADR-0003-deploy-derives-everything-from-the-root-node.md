# ADR-0003: `prisma-compose deploy` derives the application from the root node

## Decision

The deploy entrypoint is `prisma-compose deploy <entry>`, where `entry` is a module
whose default export is a **module** — the application root. Everything about
the *application* is derived: it is the graph reachable from that module, and
its name comes from the root node (overridable with `--name`). The one thing
that is not derivable — which control-plane extensions exist, and the deploy's
state store — lives in `prisma-compose.config.ts` (ADR-0017). The config carries
no application settings: no app reference, no name, no per-service options.

> **Amended 2026-07:** the root must be a **module**, not "a service or a module".
> A single service is deployed by wrapping it in a one-service module; the former
> service-rooted deploy path (and its separate singular-`bundle` shape) was
> removed to keep one deploy pipeline. Everything else in this decision is
> unchanged.

## Reasoning

Start with what an app author actually writes. A service module declares a
service and its dependencies, in vocabulary imported from an extension:

```ts
// src/service.ts
import { compute, postgres } from "@prisma/compose-prisma-cloud";
import node from "@prisma/compose/node";
import { SQL } from "bun";

const db = postgres(); // a dependency slot: the binding is typed config (ADR-0015)

export default compute({
  name: "hello",
  deps: { db },
  build: node({ module: import.meta.url, entry: "../dist/server.js" }),
});

// src/module.ts — the root: the module provisions the database and wires it in (ADR-0013).
import { module } from "@prisma/compose";
import { postgres } from "@prisma/compose-prisma-cloud";
import service from "./service.ts";

export default module("hello", {}, ({ provision }) => {
  const db = provision("db", postgres({ name: "db" }));
  provision("hello", service, { db });
  return {};
});
```

The application root is a **module** — the composition unit. A single service is
deployed by wrapping it in a one-service module:

```ts
// src/module.ts
import { module } from "@prisma/compose";
import service from "./service.ts";

export default module("hello", {}, ({ provision }) => {
  provision("hello", service);
  return {};
});
```

Deploying it is one command:

```sh
prisma-compose deploy src/module.ts
```

For that command to work, something has to supply each node's control-plane
behavior — how a `compute` or a `postgres` is provisioned and deployed. That
is code, and it lives in a heavy, deploy-only module (`@prisma/compose-prisma-cloud`'s
control entry pulls in the provisioning engine). The service module above can
never import it: service modules are bundled into the deployed artifact, so
they must stay lean. Some deploy-side code therefore has to bring that code
in — and the only question is where it comes from.

It lives in the app's config file. `prisma-compose.config.ts` statically imports
each extension's control-plane descriptor and hands the CLI its registries
(ADR-0017); the app's own code never imports the config, so the heavy module
never rides into a bundle. Correlation is pure data: every extension-authored node
above carries `extension`, its extension's **package name**
(`"@prisma/compose-prisma-cloud"`), and `type`, its node ID within that extension
(`"compute"`, `"postgres"`). Deploy tooling looks up
`extensions[node.extension].nodes[node.type]` — a map hit, no specifier
construction, no resolution. A community extension plugs in by exactly the
same mechanism as a first-party one: the app imports its descriptor in the
config.

Extension options are environment-shaped in practice (a workspace id, a
region), so an extension factory (`prismaCloud()`) reads and validates its own
environment when the config is evaluated, failing with an error naming any
missing variable — before any slow work.

`extension` and `type` are deliberately separate axes. `extension` selects the
registry; `type` routes within it. A registry is already scoped to its
extension, so its keys carry no package prefix. And a gap cannot pass
silently: a node whose `(extension, type)` has no registry entry fails
immediately with an error naming the extension to add to
`prisma-compose.config.ts`.

Deriving everything from the entry module also settles what "the root" means:
**nothing marks a root in the model** beyond its kind — whatever module you point
the CLI at *is* the application, and the graph reachable from its default
export is what deploys. The root must be a module: pointing the CLI at a bare
service is rejected with an error telling you to wrap it in a module. This keeps
one deploy shape rather than a second, service-rooted pipeline path. Two things
follow:

- A **one-service module** is the standalone-deploy story: it deploys as a
  complete application with its own project and its own state. Any slice of a
  larger module can be deployed in isolation, and it cannot collide with the
  composed application because it carries its own name and therefore its own
  project.
- A service with **unwired dependency slots** (which an enclosing module
  normally wires to a provisioned producer — ADR-0013) fails at Load, with
  an error naming the unwired input and pointing at deploying the composing
  module instead.

## Consequences

- The standard deploy is one command plus environment variables and a
  `prisma-compose.config.ts` listing the app's extensions (ADR-0017).
- Extensions have a small, fixed CLI-facing contract: nodes carry
  `(extension, type)` as data, and the extension's control descriptor provides
  the registry those keys look up. This is the seam a community extension
  plugs into with zero CLI changes.
- Platforms mix freely: nodes lowered by different extensions coexist in one
  application; one deploy still writes one state store (ADR-0017).
- `lower()` in `@prisma/compose/deploy` remains the underlying mechanism and
  the escape hatch for hand-composed or mixed Alchemy stacks; the CLI wraps
  it and never replaces it.
- The Load error for unwired inputs is user-facing surface: it is the message
  a user sees when they point the CLI at a component instead of the
  application, and it must keep telling them what to do instead.

## Alternatives considered

- **A config that names the application** (`{ app, target, name }`) —
  rejected: those fields are derivable. `app` is the entry module; `name`
  belongs on the root node (ADR-0006). The config carries only the
  control-plane extension list and the state store (ADR-0017); application
  facts stay in code, against "your code is the source of truth".
- **Selecting a platform with a CLI flag** (`--target @prisma/compose-prisma-cloud`) —
  redundant and too coarse: the nodes already carry their extension, a flag
  can disagree with them, and one flag cannot express a mixed-platform graph.
- **Inferring the extension from a type-id prefix** (a convention mapping a
  slug like `prisma-cloud` to a package name) — breaks for any extension whose
  package name doesn't follow the convention; carrying the real package name
  costs one field and removes the convention entirely.
- **Folding extension identity into the type id** (`type:
  "@prisma/compose-prisma-cloud/compute"`, one field instead of two) — rejected:
  the two strings have unrelated responsibilities. `extension` selects the
  registry; `type` routes within it. Fusing them would make every registry key
  carry resolution information it never uses, and make parsing a string the
  way to answer a question a field answers directly.

## Related

- [`ADR-0004`](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) — how
  paths written in the app resolve at deploy.
- [`ADR-0005`](ADR-0005-users-build-the-framework-assembles.md) — the
  build/assembly ownership split the CLI drives.
- [`ADR-0006`](ADR-0006-every-node-is-named.md) — where the application name
  comes from.
- [`ADR-0013`](ADR-0013-resources-are-provisioned-by-modules-deps-are-declarations.md)
  — why the database lives in the module, not the service's deps.
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) — the full
  pipeline this decision anchors.
