import type { Graph } from '@internal/core';
import { PRISMA_CLOUD_EXTENSION_ID } from '../container.ts';

export type CustomDomainsConfig = Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
>;

/** Branch names come from the platform, including the current default branch. */
export function domainsForBranch(
  config: CustomDomainsConfig | undefined,
  branch: string,
): Readonly<Record<string, readonly string[]>> {
  return config && Object.hasOwn(config, branch) ? (config[branch] ?? {}) : {};
}

export function validateDomains(config: CustomDomainsConfig | undefined, graph?: Graph): void {
  const seen = new Set<string>();
  for (const services of Object.values(config ?? {})) {
    for (const [address, hostnames] of Object.entries(services ?? {})) {
      if (
        graph &&
        !graph.nodes.some(
          (n) =>
            n.id === address &&
            n.node.kind === 'service' &&
            n.node.extension === PRISMA_CLOUD_EXTENSION_ID &&
            ['compute', 's3-store'].includes(n.node.type),
        )
      ) {
        throw new Error(`Custom domains refer to unknown Compute service "${address}".`);
      }
      for (const hostname of hostnames) {
        if (
          hostname.length > 253 ||
          !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(hostname)
        ) {
          throw new Error(
            `Invalid custom hostname "${hostname}". Use a hostname such as app.example.com.`,
          );
        }
        const normalized = hostname.toLowerCase();
        if (seen.has(normalized))
          throw new Error(
            `Custom hostname "${hostname}" is declared more than once. Each hostname belongs to one service and environment.`,
          );
        seen.add(normalized);
      }
    }
  }
}
