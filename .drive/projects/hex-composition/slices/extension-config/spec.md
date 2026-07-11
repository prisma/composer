# Slice spec: control plane loads through `prisma-app.config.ts` extension registries

Replaces the node-owned deploy-module loading on `claude/system-composition`.
Design contract: ADR-0017 (control-plane loads through the app config) +
ADR-0003 (as amended) + `docs/design/10-domains/deploy-cli.md`. Deviations
amend the docs first.

## Why (empirical forcing function)

Node-owned loads (`import(this.targetModule)` from core) resolve from CORE's
install location; core depends on no extension package, so a real workspace
deploy fails: `Cannot resolve the target module "@prisma/app-cloud/target"`.
The same specifier resolves fine from the app root — where the app's
dependencies actually live. The live e2e (deploy, verify, destroy) failed on
exactly this. The fix is structural, not another anchor.

## Requirements (all three must hold)

1. **Firewall by file boundary.** Control-plane code (provisioning, alchemy,
   bundlers) is imported ONLY by `prisma-app.config.ts` and the extensions'
   `/control` entries. App code (service modules, the system entry) imports
   authoring factories only and never the config.
2. **Per-node control-plane lookup keyed by `(extension ID, node ID)`.**
   A node already carries both: `extension` (renamed from `pack`, e.g.
   `"@prisma/app-cloud"`) and `type` (e.g. `"compute"`). Lookup:
   `config.extensions[node.extension].nodes[node.type]`.
3. **Ambient module resolution only.** The config uses ordinary static
   imports, resolved from the app root by the package manager (pnpm, hoisted,
   Yarn PnP, Deno). No specifier construction, no `createRequire`, no path
   anchoring, no `import(variable)` opacity tricks. The only convention is
   finding `prisma-app.config.ts` (walk up from the deploy entry; c12 — the
   same mechanism as prisma-next's config-loader).

## At a glance

```ts
// examples/storefront-auth/prisma-app.config.ts — CLI-only, never imported by app code
import { defineConfig } from '@prisma/app/config';
import { prismaCloud } from '@prisma/app-cloud/control';
import { nodeBuild } from '@prisma/app-node/control';
import { prismaState } from '@prisma/alchemy/state';

export default defineConfig({
  extensions: [prismaCloud(), nodeBuild()],
  state: prismaState(), // ONE state store per deploy; the ledger is platform-agnostic
});
```

## Decisions encoded (operator rulings)

- Terminology: **extension** — not "pack", not "target".
- **The target concept dies.** No `Target` interface as the one lowering
  source, no `fromEnv()` contract, no target inference/selection, no
  one-target-per-application rule. Mixed platforms in one app is intended;
  alchemy orchestrates. Providers compose (union of the used extensions'
  layers); state is the ONE explicit `state:` in config.
- Registries keyed by extension ID then node ID; a build descriptor re-keys
  the same way (`extension` + `type`; `kind`/`assembler` die).
- Nodes revert to **plain frozen data** — no classes-for-methods, no
  `loadTarget()/loadAssembler()/assemble()`, no specifier fields. Identity
  stays the `Symbol.for('prisma:node')` brand via `isNode()`.
- Extension factories (e.g. `prismaCloud()`) read and validate their own env
  at construction, failing with the exact variable name — preserving today's
  fail-fast UX.
- Firewall tests: the variable-import assertions are obsolete; replace with a
  structural guard (nothing reachable from an authoring entry imports a
  `/control` entry) and KEEP app-cloud's real-build token check
  (`invariants.test.ts`) as the end-proof.

## Pipeline (CLI)

parse args → load `prisma-app.config.ts` (c12; walk up from the resolved
entry; missing config is a CliError naming the filename and required export)
→ import entry → `Load` graph → validate every node's and build descriptor's
`(extension, type)` has a registry entry (error names the missing extension
and the config fix) → assemble via registries → generate stack file (the
generated `.prisma-app/alchemy.run.ts` imports the user's config by relative
path and drives `lower()` with its registries + state) → drive alchemy.

## Proof

- All repo gates green (typecheck, test, lint, build, casts delta ≤ 0).
- **The decisive probe:** in `examples/storefront-auth`, running the deploy
  with NO env fails at the missing `PRISMA_WORKSPACE_ID` error — not at
  "Cannot resolve". (The live e2e then proves the full deploy in CI.)
- Grep-clean: no `loadTarget|loadAssembler|targetModule|assembler:` remnants;
  no `createRequire` under packages/.
- `test/integration` reworked to config-based fixtures; drop the pnpm
  `injected` scaffolding if the ordinary layout now resolves (it should —
  resolution moved to the app root).

## Out of scope

- Lowering logic itself (provision/serialize/package/deploy bodies) — re-keyed
  and re-homed, not rewritten.
- H3 (reusable system package + fake, live in CI) — next slice, builds on this.
- Docs/ADRs — orchestrator-owned, amended alongside (ADR-0017 replaced,
  ADR-0003 amended, deploy-cli.md + system-composition.md updated).
