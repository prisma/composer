import { resource } from "@makerkit/core";
import type { ResourceNode } from "@makerkit/core";

export interface PostgresConfig {
  readonly url: string;
}

/**
 * A Postgres dependency, served on Prisma Cloud by the project's database.
 * The app supplies the client factory; C is inferred from its return type.
 */
export const postgres = <C>(opts: {
  client: (config: PostgresConfig) => C | Promise<C>;
}): ResourceNode<C> =>
  resource({
    type: "prisma-cloud/postgres",
    connection: {
      params: { url: { type: "string", secret: true } },
      // v: { url: string } — enforced by the declaration.
      hydrate: (v) => opts.client({ url: v.url }),
    },
  });
