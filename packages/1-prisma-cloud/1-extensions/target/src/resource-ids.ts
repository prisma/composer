/**
 * Alchemy resource IDs (ADR-0056). A node's main resource uses its address;
 * every other piece adds `.` and a role, then whatever says which one when a
 * node has several. A module has no resources and a service or resource has
 * no children, so no ID built here is another node's address.
 */
export function resourceId(address: string, ...role: readonly string[]): string {
  return [address, ...role].join('.');
}
