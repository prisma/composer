/**
 * `@internal/lowering`'s public surface: the Prisma resource providers plus the
 * Management API client, container, and credential helpers. Implementation
 * lives in `../providers.ts` and the modules it re-exports; the compute and
 * bucket surfaces are their own entrypoints. The postgres family (Project,
 * Database, Connection) is upstream alchemy's — consumers import it via
 * `import * as Prisma from 'alchemy/Prisma'`.
 */
export {
  layer as managementClientLayer,
  type ManagementApiClient,
  ManagementClient,
} from '../client.ts';
export * from '../container.ts';
export * from '../credentials.ts';
export * from '../pagination.ts';
export * from '../providers.ts';
export * from './buckets.ts';
export * from './compute.ts';
