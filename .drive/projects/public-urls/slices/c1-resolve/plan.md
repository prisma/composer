# C1 — dispatch plan

Spec: [spec.md](spec.md). Four dispatches, sequential: D1 and D2 both edit `node.ts` and `load-module.ts`; D3 needs D1's `Load` option; D4 describes what D1 to D3 built.

## D1. `resolve()` and the second pass, in core

- **Outcome:** `packages/0-framework/1-core/core` has `ResolvedValue`, `resolve()`, `environment.name` on the module context, the second pass in Load with the sealed `provision`, acceptance in `InputBinding` and `ParamBindings`, rejection everywhere else, `Load(root, { environment })`, and `LowerOptions.environment` in place of `stage`. `@prisma/composer`'s index exports `resolve` and `ResolvedValue`.
- **Tests:** one per spec edge case; the ordering, memoisation and cycle rules; `lowering()` sees substituted bindings; type tests for `fn`'s tuple typing and for a `ResolvedValue` refused as `id`, `deps`, `secrets`.
- **Builds on:** main at 1d4017ce.
- **Hands to:** `pnpm --filter @internal/core build`, `typecheck`, `test`, `test:types` green; `pnpm lint` and `pnpm lint:casts` green on the package.

## D2. A resource with its edge already set

- **Outcome:** `resource({ inputs, deps, options })` carries dependency slots, their wiring and a plain-data options bag whose resolved values the second pass substitutes (prototype preserved); `provision(resource)` records slot nodes and edges, validates the wiring, counts a forwarded module input, records the authored edge; `provision(resource, { deps })` stays rejected.
- **Tests:** the graph shape (slot node, `input` edge, `dependency` edge, topological order after the producer); the unwired slot error; the forwarded-input case; a resource descriptor in `lowering()` reads the producer's outputs through `ctx.lowered` and a resolved option through `ctx.node.options`.
- **Builds on:** D1.
- **Hands to:** the same checks as D1, green.

## D3. The environment name reaches Load, and an example uses it

- **Outcome:** `pipeline.ts` passes the environment into Load (its callers in `execute-deploy-destroy.ts` and `execute-dev.ts` hand it over); `generate-stack.ts` and `generate-dev-stack.ts` render `environment`; `examples/env-param` binds a second input key to a `resolve()` over `environment.name`, and its server echoes it.
- **Tests:** the stack-file renderers assert the `environment` line; the pipeline test passes an environment through; the example's smoke test covers the new key.
- **Builds on:** D1.
- **Hands to:** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` green at the root.

## D4. The docs describe it

- **Outcome:** `docs/guides/building-an-app.md` (a section on values that differ per environment, and the resource change where modules are described), `docs/guides/deploying.md` (the environments section points at it), `skills/prisma-composer-core-concepts/SKILL.md`, the glossary ("Resolved value"), `core-model.md` and `module-composition.md` (the second pass; resources may declare slots wired at construction).
- **Builds on:** D1 to D3 (the docs describe real exports).
- **Hands to:** `website` content tests green; a grep over `docs/` and `skills/` for "resources take no wiring" and "only service-to-service edges" finds nothing stale.

## D5. Verify (orchestrator)

Full suite; `prisma dev` of `examples/env-param` as `dev` and as `test`, each echoing its own name; `prisma deploy` to two environments with the deploy credentials; the structure error and the `undefined` error against a scratch copy; `/drive-code-review` without the walkthrough; fixes; pull request.
