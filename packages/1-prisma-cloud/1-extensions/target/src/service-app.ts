/** The `displayName` of a service's `Prisma.App`. Local dev reserves each service's emulator port under this name before converge, so both must come from here. */
export function serviceAppName(address: string): string {
  return address;
}
