/** The `displayName` of a service's `Prisma.App`. Local dev reserves each service's emulator port under this name before converge, so both must come from here. */
export function serviceAppName(address: string): string {
  return address;
}

/** The `name` of a database's `Prisma.Database` and a bucket's `Prisma.Bucket`. Local dev records each one's emulator instance under this name before converge, and the local providers look it up by it, so both must come from here. */
export function resourceName(nodeId: string): string {
  return nodeId;
}
