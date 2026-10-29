/** The `public-url` node kind's descriptor: a named hostname becomes one Prisma custom domain on the target service; the prisma.build strategy declares nothing. */

import type { NodeDescriptor } from '@internal/core/config';
import type { LowerContext, Lowering } from '@internal/core/deploy';
import * as Output from 'alchemy/Output';
import * as Prisma from 'alchemy/Prisma';
import * as Effect from 'effect/Effect';
import { resolvedStrategy } from '../public-url.ts';
import { resourceId } from '../resource-ids.ts';

function outputString(
  outputs: Readonly<Record<string, unknown>>,
  name: string,
  address: string,
  service: string,
): string | Output.Output<string> {
  const value = outputs[name];
  if (typeof value === 'string' || Output.isOutput(value)) return value;
  throw new Error(
    `${address}: the service "${service}" its target is wired to reported no "${name}". ` +
      'A public URL on Prisma Cloud serves a compute service.',
  );
}

function targetService({ id, address, graph, lowered }: LowerContext) {
  const edge = graph.edges.find(
    (e) => e.to === id && e.input === 'target' && e.kind === 'dependency',
  );
  if (edge === undefined) throw new Error(`${address}: its target is wired to nothing.`);
  const outputs = lowered.get(edge.from) ?? {};
  return {
    serviceId: outputString(outputs, 'serviceId', address, edge.from),
    url: outputString(outputs, 'url', address, edge.from),
  };
}

export function publicUrlDescriptor(): NodeDescriptor {
  const lowering: Lowering = (ctx) =>
    Effect.gen(function* () {
      const { address, node } = ctx;
      const strategy = resolvedStrategy(
        node.kind === 'resource' ? node.props['url'] : undefined,
        address,
      );
      const service = targetService(ctx);
      if (strategy.strategy === 'prisma-build') {
        return {
          outputs: {},
          entities: [{ kind: 'public-url', id: service.serviceId, url: service.url, details: {} }],
        };
      }
      const { hostname } = strategy;
      const domain = yield* Prisma.CustomDomain(resourceId(address, 'domain', hostname), {
        app: service.serviceId,
        hostname,
      });
      return {
        outputs: {},
        entities: [
          {
            kind: 'public-url',
            id: domain.customDomainId,
            url: `https://${hostname}`,
            details: { hostname, status: domain.status },
          },
        ],
      };
    });
  return Object.assign(lowering, { kind: 'resource' as const });
}
