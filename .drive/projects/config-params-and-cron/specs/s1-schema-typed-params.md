# S1 — Config-model change: schema-typed params, target serialization, config()/load() split

One PR. Realizes ADR-0018, ADR-0019, and ADR-0021 (they co-touch the same files
and must land in one green step). Design of record:
[ADR-0018](../../../../docs/design/90-decisions/ADR-0018-config-params-carry-a-caller-owned-schema.md),
[ADR-0019](../../../../docs/design/90-decisions/ADR-0019-the-target-owns-config-serialization.md),
[ADR-0021](../../../../docs/design/90-decisions/ADR-0021-params-are-read-through-config-not-load.md),
[config-params.md](../../../../docs/design/10-domains/config-params.md). Linear: TML-3007.

## Summary

Three coupled changes to the config model:

1. **Schema-typed params** — `ConfigParam` becomes a plain `{ schema, secret?,
   optional?, default? }`; the `ParamType = 'string' | 'number'` enum is deleted.
2. **Target-owned serialization** — the target (`@prisma/app-cloud`) owns all
   encoding, driven by the schema; core never stringifies. `compute()` opens to
   user params.
3. **`config()`/`load()` split** — params are read through a new `config()`;
   `load()` returns dependencies only.

After this slice a service can declare a **structured, schema-typed param** that
round-trips deploy → storage → boot → `config()`, validated, with `configOf`
reporting its schema.

## 1. Schema-typed params (`packages/app/src/config.ts`)

```ts
import type { StandardSchemaV1 } from '@standard-schema/spec';

export interface ConfigParam<S extends StandardSchemaV1 = StandardSchemaV1> {
  readonly schema: S;
  readonly secret?: boolean;
  readonly optional?: boolean;
  readonly default?: StandardSchemaV1.InferOutput<S>;
}
```

- **No `serialize`/`deserialize` on the param.** A param is plain data — schema +
  facets. Serialization is the target's (§2). This is the RPC pattern: schema on
  the declaration, wire owned by the mover.
- Delete `ParamType` and `TypeOf`. `Values<P>` infers each value via
  `StandardSchemaV1.InferOutput<P[K]['schema']>`, keeping the existing
  optional/default widening.
- Add core dep `@standard-schema/spec` (type-only; already used by `@prisma/app-rpc`).
- Core helpers `string(opts?)`, `number(opts?)` (→ `{ schema: type('string'|'number'), ...opts }`)
  and `param(schema, opts?)` (→ `{ schema, ...opts }`). Export from `@prisma/app`.
  Update `packages/app/src/index.ts` (drop `ParamType`/`TypeOf`).
- `ConfigDeclaration` / `configOf` (introspection): replace `type: ParamType` with a
  JSON-Schema projection of the param's schema. Stays pure data.
- `packages/app/src/node.ts` `freezeParams` keeps working over the new shape.

## 2. Target-owned serialization (`@prisma/app-cloud`)

The target owns encoding, logic, and medium; core hands it the typed `Config`.
Two sites in `@prisma/app-cloud` do the work today by hand and must drive off the
schema instead:

- **Deploy encode** — `control.ts` `serialize` (`ServiceLowering.serialize`):
  today `value: typeof value === 'number' ? String(value) : value`. Generalize:
  encode a service-own value so boot can reverse it (JSON for structured/number,
  string as-is), keyed by the existing `configKey`.
- **Boot decode** — `serializer.ts` `deserialize` / `coerce` / `stash`: today
  coerces by `type`. Reverse the encoding and **validate against the param's
  schema** (reuse `standardValidate` from `packages/app-rpc/src/standard-schema.ts`).

The target reads the node's params (which carry the schema); core exposes nothing
new for encoding. There is no framework-fixed medium — env key/value strings are
app-cloud's choice.

### LANDMINE — preserve provisioning-ref pass-through

`control.ts:174` passes dependency-input values through untouched because at
deploy a connection param's value (a `url`) is a **provisioning ref**, not a
literal — Alchemy resolves it and it carries the ordering edge. Only **service-own**
params (`port`, later `jobs`) are literals that get encoded. So the encoder must
branch on owner: **service-own → encode; dependency-input → pass through
unchanged**. A test must prove a dependency `url` still deploys as a ref, not a
stringified object.

## 3. config()/load() split (`packages/app/src/node.ts`, `app-cloud/compute.ts`)

- Add `config(): Values<P>` to the runnable service node, alongside `load()`.
- `load()` returns `HydratedDeps<D>` **only** — drop the param merge. Split the
  `Loaded` type accordingly (deps-only for `load`, `Values<P>` for `config`).
- `compute()`'s `load()` stops spreading `config.service`; a new `config()`
  returns it (memoized, same pattern).
- Migrate read sites: `examples/storefront-auth/systems/auth/src/server.ts` does
  `const { db, port } = service.load()` → `const { db } = service.load(); const
  { port } = service.config();`. Sweep for any other param-from-`load()` reads.

## 4. compute() opens to params (`packages/app-cloud/src/compute.ts`)

- Add an optional `params` field to `compute()`'s `def`, merged with the reserved
  `computeParams` (`port` → `number({ default: 3000 })`). A user `params` key
  colliding with a reserved name fails at authoring, mirroring the dep-collision
  check.

## 5. Migrate existing declarations

Four sites, via the helpers: `http.ts` and `rpc.ts` (`{ url: string() }`),
`postgres.ts` (`{ url: string({ secret: true }) }` + its type annotation),
`compute.ts` (`port` → `number({ default: 3000 })`).

## 6. Doc sync

Update `docs/design/10-domains/core-model.md`'s params section (`ConfigParam`,
`ParamType`, `Values`, `Loaded`, `load()`) to the new shapes. (ADRs + config-params.md
are already correct.)

## Definition of done

- [ ] A service declares a **structured** param (via `param(schema)`) whose value
      round-trips deploy encode → boot decode → schema-validated value out of
      `config()`. A unit test over the target's encode/decode with schema
      validation is enough; no live deploy required.
- [ ] `configOf` reports a structured param's **schema projection**, not "a string".
- [ ] A dependency `url` still deploys as a **provisioning ref** (the landmine
      test); storefront-auth's config shape is unchanged.
- [ ] `load()` returns deps only; `config()` returns params; a dep and a param of
      the same name no longer collide.
- [ ] `compute()` accepts user params; `port` works; a `port` collision throws.
- [ ] Core contains no `ParamType`/`TypeOf`, no `serialize`/`deserialize` on
      `ConfigParam`, and never stringifies — encoding lives entirely in the target.
- [ ] `pnpm build`, `pnpm typecheck`, `pnpm test` green from a clean tree.

## Non-goals (this slice)

- **Cron** — S2.
- **A second target** — only `@prisma/app-cloud` serializes; a second target's
  medium is out of scope.
- **Field-level secrets, provisioning refs inside structured params** — excluded by
  ADR-0018/0019.

## Files in play

`packages/app/src/config.ts`, `index.ts`, `node.ts`;
`packages/app-cloud/src/compute.ts`, `serializer.ts`, `control.ts`, `http.ts`,
`postgres.ts`; `packages/app-rpc/src/rpc.ts` (+ maybe lift `standard-schema.ts`);
`packages/app/package.json` (add `@standard-schema/spec`);
`examples/storefront-auth/systems/auth/src/server.ts` (config() migration);
`docs/design/10-domains/core-model.md` (doc sync). Tests alongside each.
