/**
 * The authoring vocabulary for Prisma Cloud — thin wrappers over core's node
 * factories. Data only; imports @makerkit/core and nothing else.
 */
import { resource, service } from "@makerkit/core";
import type { Deps, ResourceNode, ServiceHandler, ServiceNode } from "@makerkit/core";

/**
 * A Postgres dependency, served on Prisma Cloud by the project's database.
 * C is the app-declared client type — whatever the app's client factory (see
 * the /runtime entry) produces. The pack fixes neither the driver nor the JS
 * runtime.
 */
export const postgres = <C = unknown>(): ResourceNode<C> =>
  resource<C>({ type: "prisma-cloud/postgres" });

/** A Prisma Compute service: inputs + handler, inert until run by the host. */
export const compute = <D extends Deps>(deps: D, handler: ServiceHandler<D>): ServiceNode<D> =>
  service({ type: "prisma-cloud/compute", inputs: deps, handler });
