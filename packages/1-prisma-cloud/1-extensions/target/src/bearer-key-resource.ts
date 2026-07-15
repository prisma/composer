/**
 * The `BearerKey` Alchemy resource — mints a random bearer API key ONCE at
 * create and keeps it STABLE across deploys, so an unchanged module no-ops on
 * redeploy (the s3-credentials mint's exact shape). The key is generated with
 * the Web Crypto global (`crypto.getRandomValues` — no `node:` import,
 * matching this package's runtime-coupling invariant) and persisted in Alchemy
 * state; every later apply returns the persisted attributes unchanged.
 * Rotation is destroy/recreate (a platform ask, not solved here).
 *
 * This is a module-level credential (ADR-0030's "mint the value, keep it in
 * deploy state" rail), distinct from the rpc-service-key project's planned
 * per-edge ServiceKey.
 *
 * Deploy-time only: imports `alchemy`. Imported by `control.ts` and tests,
 * never by `index.ts` / the authoring entry.
 */
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';

/** No inputs — the key is generated, not derived. */
export type BearerKeyProps = Record<never, never>;

export interface BearerKeyAttributes {
  readonly apiKey: string;
}

export type BearerKey = Resource<'PrismaCloud.BearerKey', BearerKeyProps, BearerKeyAttributes>;

/** The `BearerKey` resource constructor — `yield* BearerKey(id, {})` in the lowering. */
export const BearerKey = Resource<BearerKey>('PrismaCloud.BearerKey');

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A fresh bearer key: 48 hex chars (24 random bytes) — far above the server's 10-char minimum. */
export function mintBearerKey(): BearerKeyAttributes {
  return { apiKey: toHex(crypto.getRandomValues(new Uint8Array(24))) };
}

/**
 * The `BearerKey` provider service. `reconcile` returns the persisted `output`
 * when present (a redeploy reuses the stored key — the no-op property) and
 * mints a fresh key only on first create. Nothing to enumerate or tear down
 * (the key lives only in state). Exported so tests can drive it directly.
 */
export const bearerKeyProviderService: Provider.ProviderService<BearerKey> = {
  list: () => Effect.succeed([]),
  reconcile: ({ output }) => Effect.sync(() => output ?? mintBearerKey()),
  delete: () => Effect.void,
};

/** The `BearerKey` provider layer — merged into the extension descriptor's `providers()`. */
export const BearerKeyProvider = () =>
  Provider.effect(BearerKey, Effect.succeed(bearerKeyProviderService));
