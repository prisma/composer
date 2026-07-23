/** `@internal/local-target`'s public surface (local-dev spec § 4): the local deploy target's provider suite — the dev provider bundle plus the dev-instance store and shared plumbing. Implementation lives in `../dev/*`. */
export * from '../app-name.ts';
export * from '../bucket.ts';
export * from '../compute.ts';
export * from '../dev-store.ts';
export * from '../postgres.ts';
export * from '../providers.ts';
export * from '../resolve-package-entry.ts';
export * from '../teardown.ts';
