/**
 * `@internal/lowering`'s public surface: the Prisma resource providers plus the
 * Management API client, container, and credential helpers. Implementation
 * lives in `../providers.ts` and the modules it re-exports; the compute and
 * bucket surfaces are their own entrypoints. The postgres family (Project,
 * Database, Connection) and the compute family (App, Deployment,
 * EnvironmentVariable) are upstream alchemy's — consumers import them via
 * `import * as Prisma from 'alchemy/Prisma'`. What stays here is Composer's
 * own: the artifact packager, `ServiceKey`, and the bucket resources.
 */
export {
  layer as managementClientLayer,
  type ManagementApiClient,
  ManagementClient,
} from '../client.ts';
export * from '../container.ts';
export * from '../credentials.ts';
export * from '../database-url-claim.ts';
export * from '../pagination.ts';
export * from '../providers.ts';
export * from './buckets.ts';
export * from './compute.ts';
