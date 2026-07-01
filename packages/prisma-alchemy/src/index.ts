import * as Layer from "effect/Layer";
import * as Provider from "alchemy/Provider";
import * as client from "./client.ts";
import { fromEnv } from "./credentials.ts";
import { Connection, ConnectionProvider } from "./postgres/Connection.ts";
import { Database, DatabaseProvider } from "./postgres/Database.ts";
import { Project, ProjectProvider } from "./postgres/Project.ts";

export * from "./credentials.ts";
export { ManagementClient } from "./client.ts";
export * from "./postgres/index.ts";

/** The collection of Prisma resource providers. */
export class Providers extends Provider.ProviderCollection<Providers>()("Prisma") {}

/**
 * The Prisma provider bundle: every resource provider, the Management API
 * client, and env-based credentials. Plug into a stack with
 * `{ providers: Prisma.providers() }`.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([Project, Database, Connection]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(ProjectProvider(), DatabaseProvider(), ConnectionProvider()),
    ),
    Layer.provideMerge(client.layer()),
    Layer.provideMerge(fromEnv()),
    Layer.orDie,
  );
