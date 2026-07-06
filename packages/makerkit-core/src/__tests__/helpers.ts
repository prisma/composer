import type { ConfigAdapter, Connection, Params, Values } from "../config.ts";

/** A test connection: declared params + a recording/simple hydrate. */
export const conn = <P extends Params, C>(
  params: P,
  make: (values: Values<P>) => C | Promise<C>,
): Connection<P, C> => ({ params, hydrate: make });

/**
 * An in-memory ConfigAdapter: values keyed by param path ("input.name" for
 * input params, the bare name for service params). Reads no environment.
 * Records the requests it receives.
 */
export function memoryAdapter(values: Record<string, string>): ConfigAdapter & {
  readonly requested: string[][];
} {
  const requested: string[][] = [];
  return {
    requested,
    async get(requests) {
      requested.push(
        requests.map((r) => (r.owner === "service" ? r.name : `${r.owner.input}.${r.name}`)),
      );
      const out: Record<string, string> = {};
      for (const r of requests) {
        const path = r.owner === "service" ? r.name : `${r.owner.input}.${r.name}`;
        const value = values[path];
        if (value !== undefined) out[r.id] = value;
      }
      return out;
    },
  };
}

/** An adapter that must never be consulted — throws if it is. */
export const untouchableAdapter: ConfigAdapter = {
  get() {
    throw new Error("adapter must not be consulted");
  },
};
