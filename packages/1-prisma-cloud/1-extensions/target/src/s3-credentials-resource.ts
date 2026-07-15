/**
 * The `S3Credentials` Alchemy resource (S5) — mints a random SigV4 key pair
 * ONCE at create and keeps it STABLE across deploys, so an unchanged module
 * no-ops on redeploy. The pair is generated with the Web Crypto global
 * (`crypto.getRandomValues` — no `node:` import, matching this package's
 * runtime-coupling invariant) and persisted in Alchemy state; on every later
 * apply the provider returns the persisted attributes (`reconcile`'s `output`)
 * unchanged — the same way the postgres resource keeps a Connection stable.
 * Rotation is destroy/recreate (a platform ask, not solved here).
 *
 * Deploy-time only: imports `alchemy`. Imported by `control.ts` and tests,
 * never by `index.ts` / the authoring entry.
 */
import { Resource } from 'alchemy';
import * as Provider from 'alchemy/Provider';
import * as Effect from 'effect/Effect';

/** No inputs — the pair is generated, not derived. */
export type S3CredentialsProps = Record<never, never>;

export interface S3CredentialsAttributes {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export type S3Credentials = Resource<
  'PrismaCloud.S3Credentials',
  S3CredentialsProps,
  S3CredentialsAttributes
>;

/** The `S3Credentials` resource constructor — `yield* S3Credentials(id, {})` in the lowering. */
export const S3Credentials = Resource<S3Credentials>('PrismaCloud.S3Credentials');

function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n));
}

function toHexUpper(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

/** A fresh SigV4 key pair: an AKIA-prefixed id and a 40-char base64 secret. */
export function mintKeyPair(): S3CredentialsAttributes {
  const accessKeyId = `AKIA${toHexUpper(randomBytes(8))}`;
  const secretAccessKey = btoa(String.fromCharCode(...randomBytes(30)));
  return { accessKeyId, secretAccessKey };
}

/**
 * The `S3Credentials` provider service. `reconcile` runs for create and update;
 * it returns the persisted `output` when present (a redeploy reuses the stored
 * pair — the no-op property) and mints a fresh pair only on first create.
 * Nothing to enumerate (`list` → `[]`) or tear down (`delete` → no-op; the pair
 * lives only in state). Exported so tests can drive it directly.
 */
export const s3CredentialsProviderService: Provider.ProviderService<S3Credentials> = {
  list: () => Effect.succeed([]),
  reconcile: ({ output }) => Effect.sync(() => output ?? mintKeyPair()),
  delete: () => Effect.void,
};

/** The `S3Credentials` provider layer — merged into the extension descriptor's `providers()`. */
export const S3CredentialsProvider = () =>
  Provider.effect(S3Credentials, Effect.succeed(s3CredentialsProviderService));
