export type ResourceRowKind = 'database' | 'bucket';

/** The platform row each Prisma Cloud resource type deploys to. A type missing here, such as an S3 credentials resource, has no row. */
export const RESOURCE_ROW_KINDS: ReadonlyMap<string, ResourceRowKind> = new Map<
  string,
  ResourceRowKind
>([
  ['postgres', 'database'],
  ['raw-postgres', 'database'],
  ['s3', 'bucket'],
]);
