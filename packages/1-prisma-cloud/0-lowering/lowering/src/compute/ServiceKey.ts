/**
 * The `ServiceKey` Alchemy resource (ADR-0030) — mints a random 256-bit key
 * ONCE at create and keeps it STABLE across deploys, so an unchanged edge
 * no-ops on redeploy. Same mint-once-stable lifecycle as `S3Credentials`
 * (`packages/1-prisma-cloud/1-extensions/target/src/s3-credentials-resource.ts`):
 * Web Crypto only (`crypto.getRandomValues` — no `node:` import), persisted in
 * Alchemy state; on every later apply the provider returns the persisted
 * attributes (`reconcile`'s `output`) unchanged. One resource per RPC edge;
 * rotation is destroy/recreate.
 */
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';

/** No inputs — the key is generated, not derived. */
export type ServiceKeyProps = Record<never, never>;

export interface ServiceKeyAttributes {
  readonly value: string;
}

export type ServiceKey = Resource<'PrismaCloud.ServiceKey', ServiceKeyProps, ServiceKeyAttributes>;

/** The `ServiceKey` resource constructor — `yield* Prisma.ServiceKey(id, {})` in the lowering. */
export const ServiceKey = Resource<ServiceKey>('PrismaCloud.ServiceKey');

/** A fresh 256-bit key as 64 lowercase hex chars (Web Crypto — no node import). */
export function mintServiceKey(): ServiceKeyAttributes {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return { value: Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') };
}

/**
 * The `ServiceKey` provider service. `reconcile` runs for create and update;
 * it returns the persisted `output` when present (a redeploy reuses the
 * stored key — the no-op property) and mints a fresh key only on first
 * create. Nothing to enumerate (`list` → `[]`) or tear down (`delete` →
 * no-op; the key lives only in state).
 */
export const serviceKeyProviderService: Provider.ProviderService<ServiceKey> = {
  list: () => Effect.succeed([]),
  reconcile: ({ output }) => Effect.sync(() => output ?? mintServiceKey()),
  delete: () => Effect.void,
};

/** The `ServiceKey` provider layer — merged into the Prisma Cloud extension's `providers()`. */
export const ServiceKeyProvider = () =>
  Provider.effect(ServiceKey, Effect.succeed(serviceKeyProviderService));
