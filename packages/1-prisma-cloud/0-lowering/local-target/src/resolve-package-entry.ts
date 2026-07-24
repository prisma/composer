/**
 * `import.meta.resolve(specifier)` + `fileURLToPath` in one call (local-dev
 * spec § 2's publish note). Lives here, not in the target extension's own
 * `src/local-target/emulators.ts`, because that extension's shipped source must stay
 * free of `node:`/`bun:` imports (invariant 5,
 * `src/__tests__/invariants.test.ts`) — every actual filesystem/runtime
 * touch is delegated to `@internal/local-target`, which runs in the CLI
 * parent and carries no such restriction.
 */
import { fileURLToPath } from 'node:url';

export function resolvePackageEntry(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier));
}
