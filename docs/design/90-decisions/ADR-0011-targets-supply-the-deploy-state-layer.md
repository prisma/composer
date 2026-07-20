# ADR-0011: Targets supply the deploy state layer

## Decision

`Target.state` is a required field: every target constructs the Alchemy state
layer its deploys use, and core resolves `opts.state ?? target.state()` with
no fallback of its own. The Prisma Cloud target supplies the branch-hosted
store ([ADR-0034](ADR-0034-deploy-state-lives-in-the-stage-branch.md)); a
caller can still pin a specific layer per stack (CI, tests, air-gapped
work) through `opts.state`, which always wins.

## Reasoning

Consider the opt-in version of hosted state
([ADR-0009](ADR-0009-deploy-state-is-hosted-in-the-workspace.md)): the store
exists, and every deploy entrypoint is supposed to remember one line —

```ts
lower(app, prismaCloud({ workspaceId }), {
  name: "shop",
  state: prismaState({ workspaceId }),   // ← forget this line
});
```

The entrypoint that forgets it gets no error. It gets Alchemy's local-file
default, deploys successfully, and has silently re-created the exact failure
hosted state exists to kill: the next machine to deploy that stack duplicates
it. A safety mechanism you must remember to switch on protects only the
people who least need it.

So the default must flow from somewhere the user doesn't write. The natural
owner is the **Target** — the object a pack constructs carrying everything
core needs to deploy to one platform (its lowering tables, its provisioning
providers). "Where does deploy state live?" is a property of the platform
being deployed to: the Prisma Cloud target knows its platform can host state
and how to reach it, exactly the way it already knows its providers. The
`Target` SPI even has the precedent on it: `providers()` is a layer the
target contributes to every stack it lowers. `state()` is the second such
layer. Core stays target-neutral throughout — the field's type is generic
Alchemy vocabulary, and core never learns what is behind the layer it is
handed.

Making the field *required* rather than defaulted is the sharper half of the
decision. An optional field with a core-owned local-state fallback recreates
the original problem one level down: a target author who forgets the field
ships the footgun to every app on that target, silently. Requiring it forces
each target to make an explicit choice — and a target that genuinely wants
local state (a dev-oriented target, a test harness) writes that in one line,
visibly, where a reviewer sees it. Core consequently owns no state opinion at
all; its only role is precedence.

The per-stack override stays, because the default must be escapable
deliberately rather than accidentally: pinning ephemeral local state in a CI
job, injecting a fake store in a test, working offline. `opts.state` is the
explicit, visible form of the same decision the target made — never a silent
fallback.

## Consequences

- Deploying to Prisma Cloud uses hosted state with zero user wiring; the
  duplicate-stack footgun requires an explicit opt-out to reproduce.
- Every target author must decide their state story at construction time; the
  compiler enforces the decision exists.
- Core imports no state backend and carries no default. Replacing the target
  pack therefore swaps where state lives along with everything else — which is
  correct, not a leak: state hosting is a capability of the platform, so it
  belongs to whatever represents the platform.
- `opts.state` is the sanctioned escape hatch, and its presence in a diff is a
  visible signal that a stack deliberately diverges from its target's default.

## Alternatives considered

- **Optional `Target.state` with a core-owned local fallback** — rejected
  because a silent fallback is itself the failure mode: a target author who
  omits the field ships the forgot-to-opt-in footgun to every app on that
  target, and forgetting becomes indistinguishable from choosing.
- **Per-call opt-in only** (`opts.state` with no target involvement) —
  rejected: every entrypoint must remember, and the one that forgets fails
  silently and destructively.
- **A global configuration file naming the store** — rejected: it adds a
  second source of truth outside the code, and the target already possesses
  the knowledge.

## Related

- [`ADR-0009`](ADR-0009-deploy-state-is-hosted-in-the-workspace.md) — the
  hosted store the Prisma Cloud target supplies.
- [`ADR-0003`](ADR-0003-deploy-derives-everything-from-the-root-node.md) — the
  same philosophy applied to the deploy entrypoint: derive, don't configure.
- [`../10-domains/core-model.md`](../10-domains/core-model.md) — the `Target`
  SPI this field lives on.
