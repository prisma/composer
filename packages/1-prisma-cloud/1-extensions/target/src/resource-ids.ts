/**
 * Alchemy resource IDs (ADR-0057). A node's main resource uses its address;
 * every other piece adds `.` and a role, then whatever says which one when a
 * node has several. A module has no resources and a service or resource has
 * no children, so no ID built here is another node's address.
 */
export function resourceId(address: string, ...role: readonly string[]): string {
  return [address, ...role].join('.');
}

/**
 * The address without its first segment, the app name: `shop.auth.api` in the app `shop` is
 * `auth.api`. Every platform name Composer writes is built from it, and so is every ID an earlier
 * release wrote (ADR-0057).
 */
export function addressBelowApp(address: string, app: string): string {
  const prefix = `${app}.`;
  if (!address.startsWith(prefix)) {
    throw new Error(`prisma-cloud: the address "${address}" is not inside the app "${app}".`);
  }
  return address.slice(prefix.length);
}
