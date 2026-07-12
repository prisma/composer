/**
 * Marks a service as a plain server for deployment. `node({ module, entry })`
 * says the app's built server lives at `entry`, resolved relative to
 * `dirname(module)` — exactly like an import specifier (ADR-0004). `module`
 * is the authoring module's `import.meta.url`. Returns plain data — nothing
 * runs on import. `extension` + `type` are the control-plane registry key:
 * deploy tooling routes assembly through the app's `prisma-compose.config.ts` to
 * this package's `/control` descriptor (ADR-0017) — no module loading here.
 */
import type { BuildAdapter } from '@internal/core';

const nodeBuild = (opts: { module: string; entry: string }): BuildAdapter => ({
  extension: '@prisma/compose/node',
  type: 'node',
  module: opts.module,
  entry: opts.entry,
});

export default nodeBuild;
