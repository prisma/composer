/**
 * `@internal/lowering`'s public surface: the Prisma resource providers plus the
 * Management API client, container, and credential helpers. Implementation
 * lives in `../providers.ts` and the modules it re-exports; the compute
 * surface is its own entrypoint. The postgres family (Project, Database,
 * Connection), the compute family (App, Deployment, EnvironmentVariable), and
 * the bucket family (Bucket, BucketAccessKey) are upstream alchemy's —
 * consumers import them via `import * as Prisma from 'alchemy/Prisma'`. What
 * stays here is Composer's own: the artifact packager and `ServiceKey`.
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
export * from './compute.ts';
