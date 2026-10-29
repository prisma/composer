# C1 — dispatch plan

Spec: [spec.md](spec.md). Four dispatches, sequential: D1 and D2 both edit `node.ts` and `load-module.ts`; D3 needs D1's `Load` option; D4 describes what D1 to D3 built. Every dispatch implements its spec sections exactly; an implementer who finds the spec and the code in conflict stops and reports.

## D1. The value type, `resolve()` and the second pass, in core

- **Outcome:** spec §§ 3, 4, 5 and 7.1: `value.ts`, `resolve-values.ts` (over input and param bindings only; D2 adds resources), the module context's `environment`, `InputBinding` and `ParamBindings` accepting a `Value`, the runtime rejections, `LoadOptions.environment`, the sealed `provision`, `LoadError`'s `cause`, `LowerOptions.environment` in place of `stage` (checking `control-lowering.test.ts` in the Prisma Cloud target for `stage:`), the exports.
- **Tests:** spec § 11.1, § 11.2, § 11.4 test 38, § 11.5 (all but the resource lines).
- **Builds on:** this branch at the commit that records the spec.
- **Hands to:** `pnpm --filter @internal/core build`, `typecheck`, `test`, `test:types` green; `pnpm typecheck`, `pnpm lint` and `pnpm lint:casts` green at the root.

## D2. A resource with its edge already set

- **Outcome:** spec § 6: `ResourceNode` with `inputs`, `wiring`, `props`; `resource()` and `ResourceNodeBase` taking them; `dependencySlots` and `boundaryPortsOf` over resources; the resource branch of `provision()`; `resolveValues` over resource props and the resolved copy; `connectionInputs` and the minting loop in `deploy.ts`; the doc-comment changes.
- **Tests:** spec § 11.3, § 11.4 tests 39 and 40, the resource lines of § 11.5.
- **Builds on:** D1.
- **Hands to:** the same checks as D1, green, plus `pnpm --filter @internal/prisma-cloud-lowering test` and `pnpm --filter @internal/prisma-cloud-target test` green (the topology and the Postgres resource node).

## D3. The environment name reaches Load, and the example uses it

- **Outcome:** spec §§ 7.2, 7.3 and 8.
- **Tests:** spec § 11.6 and § 11.7.
- **Builds on:** D1.
- **Hands to:** `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test` green at the root.

## D4. The documents

- **Outcome:** spec § 9, every item.
- **Builds on:** D1 to D3.
- **Hands to:** `pnpm --filter website test` green; `grep -rn ResolvedValue docs skills .drive/projects/public-urls` finds nothing; `pnpm check:skill-packaging` green.

## D5. Verify (orchestrator)

Spec § 12: the full suite; `prisma dev` of `examples/env-param` as two environments; `prisma deploy` to two environments with the deploy credentials; the two failure cases on a scratch copy; `/drive-code-review` without the walkthrough; fixes; the pull request with Auto-fix on.
