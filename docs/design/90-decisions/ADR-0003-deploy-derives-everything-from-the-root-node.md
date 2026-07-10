# ADR-0003: `prisma-app deploy` derives everything from the root node — there is no deploy config file

## Status

Accepted

## Decision

The deploy entrypoint is `prisma-app deploy <entry>`, where `entry` is a module
whose default export is a **system** — the application root. Everything else is
derived: the application is the graph reachable from that system, the deployment
target is inferred from the nodes themselves and constructed from the
environment, and the application's name comes from the root node (overridable
with `--name`). There is no `prisma-app.config.ts` and no stack file.

> **Amended 2026-07:** the root must be a **system**, not "a service or a system".
> A single service is deployed by wrapping it in a one-service system; the former
> service-rooted deploy path (and its separate singular-`bundle` shape) was
> removed to keep one deploy pipeline. Everything else in this decision is
> unchanged.

## Reasoning

Start with what an app author actually writes. A service module declares a
service and its dependencies, in vocabulary imported from a target pack:

```ts
// src/service.ts
import { compute, postgres } from "@prisma/app-cloud";
import node from "@prisma/app-node";
import { SQL } from "bun";

const db = postgres({ client: ({ url }) => new SQL({ url }) });

export default compute({
  name: "hello",
  deps: { db },
  build: node({ module: import.meta.url, entry: "../dist/server.js" }),
});

// src/system.ts — the root: the system provisions the database and wires it in (ADR-0013).
import { system } from "@prisma/app";
import { postgres } from "@prisma/app-cloud";
import service from "./service.ts";

export default system("hello", (h) => {
  const db = h.provision("db", postgres({ name: "db" }));
  h.provision("hello", service, { db });
});
```

The application root is a **system** — the composition unit. A single service is
deployed by wrapping it in a one-service system:

```ts
// src/system.ts
import { system } from "@prisma/app";
import service from "./service.ts";

export default system("hello", (h) => h.provision("hello", service));
```

Deploying it is one command:

```sh
prisma-app deploy src/system.ts
```

For that command to work, something has to construct a **Target** — the object
carrying the lowering tables and provisioning glue for one host, e.g.
`prismaCloud({ workspaceId })`. Constructing it is code, and that code lives in
a heavy, deploy-only module (`@prisma/app-cloud/target` pulls in the
provisioning engine). The service module above can never import it: service
modules are bundled into the deployed artifact, so they must stay lean. Some
deploy-side code therefore has to pick the target and construct it — and the
only question is where that code lives.

It can live in the CLI itself, because the graph already knows its target.
Every pack-authored node above — the service, the provisioned resource — was
created by a factory from `@prisma/app-cloud`; the knowledge exists at
authoring time. It doesn't survive into the value on its
own (a JavaScript object carries no record of which package's factory made
it), so the factories stamp it: every pack-authored node carries `pack`, its
pack's **package name** (`"@prisma/app-cloud"`), on one shared base type.
At deploy, the CLI collects the distinct `pack` values across the loaded graph,
requires exactly one (mixed packs are an error naming them), and imports
`${pack}/target`. Because the field holds a real package name rather than a
nickname, a community pack resolves by exactly the same mechanism as a
first-party one, with no registry and no naming convention.

Constructing the target then needs its options — and those are
environment-shaped in practice (a workspace id, a region). So each pack's
`/target` entry exposes one conventional export, `fromEnv(): Target`, which
reads its own environment variables and fails with an error naming any missing
one. That export is the entire contract between the CLI and a pack.

`pack` and `type` are deliberately separate axes. `pack` selects the target;
`type` is each node's own discriminant (`"compute"`, `"postgres"`), which the
selected target's lowering tables key on. A target is already scoped to its
pack, so its table keys carry no pack prefix. And inference cannot silently
pick a wrong target: lowering routes every node's `type` through the target's
tables, so a mismatch fails immediately with an error naming the target, the
type, and the types the target knows.

Deriving everything from the entry module also settles what "the root" means:
**nothing marks a root in the model** beyond its kind — whatever system you point
the CLI at *is* the application, and the graph reachable from its default
export is what deploys. The root must be a system: pointing the CLI at a bare
service is rejected with an error telling you to wrap it in a system. This keeps
one deploy shape rather than a second, service-rooted pipeline path. Two things
follow:

- A **one-service system** is the standalone-deploy story: it deploys as a
  complete application with its own project and its own state. Any slice of a
  larger system can be deployed in isolation, and it cannot collide with the
  composed application because it carries its own name and therefore its own
  project.
- A service with **unwired dependency slots** (which an enclosing system
  normally wires to a provisioned producer — ADR-0013) fails at Load, with
  an error naming the unwired input and pointing at deploying the composing
  system instead.

## Consequences

- The standard deploy is zero-config: `prisma-app deploy src/system.ts` plus
  environment variables.
- Target packs have a small, fixed CLI-facing contract: nodes carry the pack's
  package name, and the `/target` entry exports `fromEnv()`. This is the seam
  a community pack plugs into with zero CLI changes.
- One target per application. Multi-target or heavily parameterized setups
  have no home in this design; if one is ever needed, a config file or flags
  can be introduced as an *optional override* — never the standard path.
- `lower()` in `@prisma/app/deploy` remains the underlying mechanism and
  the escape hatch for hand-composed or mixed Alchemy stacks; the CLI wraps
  it and never replaces it.
- The Load error for unwired inputs is user-facing surface: it is the message
  a user sees when they point the CLI at a component instead of the
  application, and it must keep telling them what to do instead.

## Alternatives considered

- **A declarative `prisma-app.config.ts`** exporting `{ app, target, name }` —
  rejected: every field is derivable. `app` is an import of the entry module;
  `name` belongs on the root node (see ADR-0006); `target` is constructible by
  the CLI as above. The file would drift toward being a second place that
  names the app, against "your code is the source of truth".
- **Naming the target with a CLI flag** (`--target @prisma/app-cloud`) —
  workable but redundant: the nodes already know their pack, and a flag can
  disagree with them.
- **Inferring the pack from a type-id prefix** (a convention mapping a slug
  like `prisma-cloud` to a package name) — breaks for any pack whose package
  name doesn't follow the convention; carrying the real package name costs
  one field and removes the convention entirely.
- **Folding pack identity into the type id** (`type:
  "@prisma/app-cloud/compute"`, one field instead of two) — rejected:
  the two strings have unrelated responsibilities. `pack` selects the target;
  `type` routes within it. Fusing them would make every lowering-table key
  carry resolution information it never uses, and make parsing a string the
  way to answer a question a field answers directly.

## Related

- [`ADR-0004`](ADR-0004-paths-resolve-relative-to-the-authoring-file.md) — how
  paths written in the app resolve at deploy.
- [`ADR-0005`](ADR-0005-users-build-the-framework-assembles.md) — the
  build/assembly ownership split the CLI drives.
- [`ADR-0006`](ADR-0006-every-node-is-named.md) — where the application name
  comes from.
- [`ADR-0013`](ADR-0013-resources-are-provisioned-by-systems-deps-are-declarations.md)
  — why the database lives in the system, not the service's deps.
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) — the full
  pipeline this decision anchors.
