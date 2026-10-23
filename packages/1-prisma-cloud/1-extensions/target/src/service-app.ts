/** The `displayName` of a service's `Prisma.App`. Local dev reserves each service's emulator port under this name before converge, so both must come from here. */
export function serviceAppName(address: string): string {
  return address;
}

/**
 * The `name` of a database's `Prisma.Database` and `Prisma.Connection`, and of a bucket's
 * `Prisma.Bucket` and `Prisma.BucketAccessKey`: the address without the app name. A name is
 * a label, not identity (ADR-0056). It stays in the form earlier releases wrote, because a
 * new Connection or access key `name` replaces the resource and mints new credentials.
 */
export function resourceLabel(address: string): string {
  const dot = address.indexOf('.');
  return dot === -1 ? address : address.slice(dot + 1);
}
