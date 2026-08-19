/**
 * Registers tsx's ESM hook once in the CLI process so that user TypeScript —
 * the entry graph and the config file — loads under Node without requiring
 * `allowImportingTsExtensions` in the user's tsconfig. Idempotent and a no-op
 * under Bun, which resolves .ts/.js/extensionless natively.
 */

let registered = false;

export async function registerTsRuntime(): Promise<void> {
  if (registered || typeof process.versions.bun === 'string') return;
  registered = true;
  const { register } = await import('tsx/esm/api');
  register();
}
