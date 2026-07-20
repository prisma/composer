/**
 * `@internal/lowering`'s public surface: the Prisma resource providers plus the
 * Management API client, container, and credential helpers. Implementation
 * lives in `../providers.ts` and the modules it re-exports; the compute and
 * postgres surfaces are their own entrypoints.
 */
export {
  layer as managementClientLayer,
  type ManagementApiClient,
  ManagementClient,
} from '../client.ts';
export * from '../container.ts';
export * from '../credentials.ts';
export * from '../providers.ts';
export * from './compute.ts';
export * from './postgres.ts';
