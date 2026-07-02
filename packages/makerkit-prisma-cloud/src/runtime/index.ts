/**
 * The hydrator table. The pack owns the platform convention (Compute injects
 * DATABASE_URL); the client that wraps the connection is app-supplied —
 * MakerKit ships no driver. Imports nothing heavy; no runtime APIs.
 */
import { HydrateError } from "@makerkit/core/runtime";
import type { TargetRuntime } from "@makerkit/core/runtime";

export interface PostgresConfig {
  readonly url: string;
}

// Client factories are per-key OPTIONAL: a service with no postgres input
// needs no factory (no phantom capabilities); a declared input with a missing
// factory is a clear HydrateError at boot, before any traffic.
export interface RuntimeOptions {
  readonly clients?: {
    /** The app's driver choice — e.g. `({ url }) => new SQL({ url })`. */
    readonly postgres?: (config: PostgresConfig) => unknown;
  };
}

function intOr(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const runtime = (o: RuntimeOptions = {}): TargetRuntime => ({
  context: (env) => ({ port: intOr(env.PORT, 3000) }),
  hydrate: {
    "prisma-cloud/postgres": ({ env, input }) => {
      const factory = o.clients?.postgres;
      if (!factory) {
        throw new HydrateError(
          `input "${input}" requires a postgres client factory — pass runtime({ clients: { postgres } })`,
        );
      }
      const url = env.DATABASE_URL;
      if (!url) throw new HydrateError(`input "${input}": DATABASE_URL is not set`);
      return factory({ url });
    },
  },
});
