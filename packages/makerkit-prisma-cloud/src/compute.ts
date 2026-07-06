import { service } from "@makerkit/core";
import type { ConfigAdapter, Deps, ServiceHandler, ServiceNode } from "@makerkit/core";

const computeParams = { port: { type: "number", default: 3000 } } as const;

/**
 * A Prisma Compute service: inputs + handler, inert until run by the host.
 * Declares its own params (port) — handlers receive ({ ...deps }, { port }).
 */
export const compute = <D extends Deps>(
  deps: D,
  handler: ServiceHandler<D, typeof computeParams>,
): ServiceNode<D, typeof computeParams> =>
  service({
    type: "prisma-cloud/compute",
    inputs: deps,
    params: computeParams,
    config: computeAdapter,
    handler,
  });

// The platform adapter — the pack's single environment reader. The semantic↔
// physical mapping (url ↔ DATABASE_URL, port ↔ PORT; per-input naming when
// multiple databases arrive) lives HERE, private to the pack.
const physicalKey = (name: string): string => (name === "url" ? "DATABASE_URL" : name.toUpperCase());

// The ambient environment of whatever runtime hosts the bundle. Declared
// structurally so this entry imports no runtime's types.
declare const process: { readonly env: Record<string, string | undefined> };

const computeAdapter: ConfigAdapter = {
  async get(requests) {
    const values: Record<string, string> = {};
    for (const request of requests) {
      const raw = process.env[physicalKey(request.name)];
      if (raw !== undefined) values[request.id] = raw;
    }
    return values;
  },
  async describe(request) {
    return { location: `env:${physicalKey(request.name)}` };
  },
};
