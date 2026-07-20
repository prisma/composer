# ADR-0037: Containers are an extension descriptor

## Decision

The platform-side space a service deploys *into* — a container, in this
framework's sense: infrastructure that must exist before Alchemy runs and
that Alchemy itself never creates or destroys — is resolved through an
optional `container` field on `ExtensionDescriptor`, the same way `preflight`
and `teardown` already are (ADR-0017). This deletes the standing
`crossDomainExceptions` entry that let the CLI import `@internal/lowering`
directly: container lifecycle moves fully behind the extension boundary, and
`0-framework` goes back to importing nothing from `1-prisma-cloud`.

```ts
export interface ExtensionDescriptor {
  // ... existing fields unchanged ...
  readonly container?: ContainerDescriptor;
}

export interface ContainerDescriptor<I extends ContainerInstance = ContainerInstance> {
  ensure(input: LocateContainerInput): Promise<I>;
  locate(input: LocateContainerInput): Promise<I | undefined>;
  remove(instance: I): Promise<void>;
  deserialize(serialized: string): I;
}

export interface LocateContainerInput {
  readonly appName: string;
  readonly stage: string | undefined;
}

export interface ContainerInstance {
  readonly input: LocateContainerInput;
  serialize(): string;
}

export interface StateDescriptor {
  readonly extension: string;
  create(container: ContainerInstance | undefined): AlchemyStateLayer;
}
```

**The framework orchestrates containers blind.** It calls `ensure`/`locate`,
holds the product as an opaque value, hands it back to the same extension's
other hooks (`ctx.container` in `LowerContext`, `PreflightInput.container`,
`TeardownInput.container`), and carries it across the parent→child process
boundary using the extension's own `serialize()`/`deserialize()` — the same
opacity rule ADR-0033 established for `ctx.application`, extended to a second
value the framework threads without reading. Core's claim on a
`ContainerInstance` is exactly `input` and `serialize()`; the owning extension
narrows to its own concrete type wherever it reads the value back.

**`ensure`/`locate` split by intent, not one operation with a flag.** `deploy`
calls `ensure` (create-if-absent); `destroy` calls `locate` (find-only,
`undefined` on nothing found) and the CLI itself turns that into "nothing
deployed for `<app>`[`/<stage>`]" — a platform-free error the framework owns
because no extension should have to invent CLI-facing user-copy.

**The transport is core-owned but content-blind.** The CLI writes each
resolved instance's `serialize()` output into one environment variable per
extension, named `PRISMA_COMPOSER_CONTAINER_<mangled extension id>`
(`containerEnvVarName`/`containerEnv` in `container-transport.ts`); the
alchemy child reads the same variable back and calls that extension's own
`deserialize`. Core writes and reads the variable's *name*; it never
interprets the *value*. Extension code never touches `process.env` and never
knows a process boundary exists — its container arrives as a parameter
everywhere.

**`StateDescriptor` names its owning extension.** `PrismaAppConfig.state`
changes from a bare `() => AlchemyStateLayer` factory to a `StateDescriptor`
whose `extension` field is matched against `ExtensionDescriptor.id`, so core
can look up that extension's resolved container and hand it to `create()`.
The state store construction that used to read `PRISMA_PROJECT_ID`/
`PRISMA_BRANCH_ID` straight from the environment now receives its ids as a
parameter, like every other extension-side read of deploy identity.

**Stage-name validation stays in the CLI, not any extension.** `--stage` must
pass `git check-ref-format`; this is the framework's own documented contract
(deploy-cli.md), platform-free and uniform regardless of which extensions are
configured, so it runs once, before any container is resolved, rather than
being an extension's responsibility to reimplement or forget.

**Method syntax is required on every `ContainerDescriptor` member** — exactly
the bivariance argument ADR-0033 already made for `ServiceLowering<P, S>`. A
config's `extensions` array is heterogeneous; each extension's own instance
type `I` is erased to `ContainerInstance` on assignment into
`ExtensionDescriptor`, and only method syntax survives that assignment
through TypeScript's method bivariance (a property-arrow form is checked
contravariantly and the assignment fails to typecheck). As with
`ServiceLowering`, **this is unsound by construction and deliberately
accepted**: nothing but the CLI's own ensure/locate → remove loop guarantees
that `remove` receives the same instance `ensure`/`locate`/`deserialize`
produced for that extension. The loop is correct today; nothing but the loop
makes it correct.

**Core's one exception to "core never reads the environment."** Reading the
container transport back is core's own job — `exports/deploy.ts` calls
`deserializeContainers(config.extensions, process.env)` once per lowering (and
once more in `lower()`, to build the state layer) — and this is the *only*
place core touches `process.env`, confined to variables in the framework's
own `PRISMA_COMPOSER_CONTAINER_*` namespace. It is not a relapse into reading
a target's environment: core still never learns `PRISMA_WORKSPACE_ID`,
`PRISMA_PROJECT_ID`, or any other extension-owned variable — it reads back
exactly the bytes it (the CLI, also core code) wrote, and hands them
untouched to the deserializer that produced them.

## Reasoning

`packages/0-framework` is defined as importing nothing
(`architecture.config.json`: `mayImportFrom: []`), but before this decision
the deploy CLI knew Prisma Cloud by name in four places, held together by one
recorded `crossDomainExceptions` entry: `cli/src/ensure-containers.ts`
imported `@internal/lowering` directly to resolve the app's Project and stage
Branch before Alchemy ran and to delete them after destroy;
`core/src/exports/app-config.ts`'s hook inputs carried literal
`projectId`/`branchId` fields; `cli/src/run-alchemy.ts` set
`PRISMA_PROJECT_ID`/`PRISMA_BRANCH_ID` directly on the alchemy child process;
and `cli/src/main.ts` orchestrated all of it. None of that is Prisma-Cloud
work the framework needs to understand — it is exactly the shape
[ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) already
solved for `preflight`/`teardown`: an extension supplies platform-specific
behavior behind a hook the CLI calls at a moment it chooses, never
implementing the behavior itself. PR #113 already applied that pattern once,
to state-database deletion (the `teardown` hook); this decision completes it
for the two remaining pieces — container lifecycle and the identity that
state construction reads.

A deploy is two processes: the CLI parent, which loads
`prisma-composer.config.ts`, builds the graph, assembles bundles, and writes
the generated stack file; and the alchemy child, which re-imports the config
from scratch and drives `lower()`. Nothing crosses from parent to child
except argv and env. Before this decision, the parent resolved the Project
and Branch and passed them to the child as
`PRISMA_PROJECT_ID`/`PRISMA_BRANCH_ID`, and the extension's own code (and the
state layer) read those variables from `process.env` directly — the
"targets read the ids at lowering time, not construction" contract
deploy-cli.md documented as a workaround for the fact that the id-bearing
values did not yet exist when the parent constructed the extension. Making
the container itself the thing that crosses the process boundary, rather
than two ad hoc strings, removes that workaround: the extension's
`application.provision` and its node lowerings now read `ctx.container`
(or `ctx.application`, itself now built from `ctx.container`) like any other
threaded value, with no special-casing for "this field might not exist yet."

`ensure`/`locate` as two named operations (rather than one
`resolve({ ensure: boolean })`) states the create-if-absent-vs-find-only
split directly at the call site instead of inside a parameter, and lets
`locate → undefined` be a legitimate, typed outcome the CLI turns into its
own error — rather than the extension inventing (or being asked to invent)
user-facing copy for a case that is really a CLI concern ("you asked to
destroy something that was never deployed").

## Consequences

- **`0-framework` imports nothing from `1-prisma-cloud` again.** The
  `crossDomainExceptions` entry for `cli → lowering` is deleted; `pnpm
  lint:deps` enforces the domain boundary with no standing carve-out.
- **A successor platform's container model needs no framework change.** The
  pinned/no-create mode a future GitHub-App-based successor will want lives
  entirely inside that extension's own `ensure`/`locate` — the SPI already
  expresses "create if absent" vs. "find only"; a third mode is an
  extension-internal decision, not an interface change.
- **No privileged platform.** Any extension may supply a `container`
  descriptor; the framework holds no assumption that exactly one, or that
  Prisma Cloud specifically, ever will (ADR-0017's no-privileged-target rule,
  now extended to containers).
- **Behavior is preserved, not rewritten.** Every Management API call, every
  error text, and every ordering guarantee (containers before Alchemy;
  state-database deletion before Branch deletion) carries over unchanged —
  relocated behind the descriptor, not reimplemented.
- **One more thing core must get right without the compiler's help.** The
  method-bivariance soundness gap `ServiceLowering<P, S>` already carried is
  now shared by `ContainerDescriptor<I>`. Anyone editing the CLI's
  ensure/locate/remove loop is extending the set of code the *loop*, not the
  type system, must keep correct.
- **The old identifiers are gone from the codebase, not just relocated.**
  `PRISMA_PROJECT_ID`, `PRISMA_BRANCH_ID`, `ensureContainers`, and a bare
  `state: () => …` factory appear nowhere in the shipped source or docs —
  not even in `container.ts` or `container-transport.ts` — verified by a
  repo-wide sweep as part of the slice that shipped this decision. They
  survive only in this ADR's own account of what it replaced.

## Alternatives considered

- **One `resolve(command)` / `resolve({ ensure })` operation** instead of
  `ensure`/`locate`. Rejected: "resolve a destroy command" reads as resolving
  commands, not containers; two named operations state the create-if-absent
  vs. find-only split directly, and `locate → undefined` lets the CLI own a
  platform-free not-found error instead of pushing that copy into every
  extension.
- **An env map as part of the resolution product** (`{ container, env }`).
  Rejected: environment variables are not a property of a container — they
  were an accident of the old transport. Keeping the taxonomy clean: the
  extension owns the payload, the framework owns the pipe.
- **The framework JSON-serializes the opaque value** instead of the
  extension's own `serialize()`/`deserialize()`. Rejected: the extension owns
  its wire format ([ADR-0019](ADR-0019-the-target-owns-config-serialization.md)'s
  precedent — the target owns config serialization), and core should not
  introspect a value it is contracted to treat as opaque.
- **A child-side pull function** (`containerFor(extensionId)`) instead of
  injecting the value. Rejected: it is a global lookup, which the
  architectural principles ban, and it would preserve import-time identity
  reads inside the extension factory — deploy-cli.md already documented
  "ids at lowering time, not construction" as a workaround to route around
  exactly that; injection makes the fix structural instead of a convention.
- **One keyed environment variable for all extensions**, instead of one
  variable per extension. Rejected in favor of one var per extension
  (operator preference — simpler to inspect from outside the process); the
  keyed map survives only as core's own in-process bookkeeping
  (`ReadonlyMap<string, ContainerInstance>`), never on the wire.
- **Folding container removal into `teardown`.** Rejected: `teardown` (the
  hook PR #113 introduced) stays exactly as it is; `ensure`/`locate`/`remove`
  is one lifecycle on one descriptor, and the CLI's two-loop order (every
  teardown, then every removal) is what structurally guarantees
  [ADR-0034](ADR-0034-deploy-state-lives-in-the-stage-branch.md)'s
  state-before-Branch deletion ordering, rather than leaving it to
  per-extension convention.
- **Extension-supplied stage-name validation.** Rejected: git-ref validity is
  the framework's own stage contract — platform-free and uniform — and
  letting each extension validate it would fragment the error surface across
  however many extensions a config lists.

## Related

- [ADR-0011](ADR-0011-targets-supply-the-deploy-state-layer.md) — targets
  (now extensions) supply the deploy state layer; `StateDescriptor` is this
  decision's update to how that layer is constructed.
- [ADR-0017](ADR-0017-control-plane-loads-through-the-app-config.md) — the
  extension-descriptor pattern (`preflight`/`teardown`) this decision extends
  to container lifecycle.
- [ADR-0019](ADR-0019-the-target-owns-config-serialization.md) — the
  target-owns-its-own-wire-format precedent `serialize()`/`deserialize()`
  follows.
- [ADR-0023](ADR-0023-a-prisma-app-is-one-project-a-stage-is-a-branch.md) /
  [ADR-0024](ADR-0024-a-stage-is-a-deploy-time-environment-resolved-to-project-and-branch.md)
  — Prisma Cloud's own containers (Project, Branch) and their resolution
  mechanics, unchanged by this decision and now expressed through it.
- [ADR-0028](ADR-0028-numbered-domains-and-layers-enforced-by-dependency-cruiser.md)
  — the domain boundary (`0-framework` imports nothing) this decision
  restores by deleting the `crossDomainExceptions` entry.
- [ADR-0033](ADR-0033-lowering-types-are-defined-by-their-readers.md) — the
  opacity rule (`ctx.application`, a runtime guard, not the compiler) this
  decision extends to `ctx.container`, and the method-bivariance argument
  `ContainerDescriptor<I>` shares with `ServiceLowering<P, S>`.
- [ADR-0034](ADR-0034-deploy-state-lives-in-the-stage-branch.md) — deploy
  state's placement on the stage's Branch, and the state-before-Branch
  deletion ordering the CLI's two-loop teardown/removal structure preserves.
- [`../10-domains/deploy-cli.md`](../10-domains/deploy-cli.md) — the pipeline
  steps and § Stages and containers this decision rewrites.
