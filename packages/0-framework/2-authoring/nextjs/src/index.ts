/**
 * Marks a service as a Next.js app for deployment. `nextjs({ module,
 * standalone, entry })`: `module` is the authoring module's `import.meta.url`;
 * `standalone` is the path to your finished, flat Next `output: "standalone"`
 * tree (relative to `dirname(module)` — like an import specifier, ADR-0004; or
 * absolute); `entry` is the bootable server's path relative to that standalone
 * root (e.g. `apps/web/server.js`). Your build owns producing that tree
 * complete (static/public copied in) and flat (no symlinks) — the framework
 * only wraps it (ADR-0005). Returns plain data — nothing runs on import.
 * `extension` + `type` are the control-plane registry key: deploy tooling
 * routes assembly through the app's `prisma-compose.config.ts` to this
 * package's `/control` descriptor (ADR-0017) — no module loading here.
 */
import type { BuildAdapter } from '@internal/core';

/** The nextjs build adapter's descriptor — `standalone` is this kind's own extra path input (the finished standalone tree), beyond the shared `{ extension, type, module, entry }`. */
export interface NextjsBuildAdapter extends BuildAdapter {
  readonly type: 'nextjs';
  readonly standalone: string;
}

const nextjsBuild = (opts: {
  module: string;
  standalone: string;
  entry: string;
}): NextjsBuildAdapter => ({
  extension: '@prisma/compose/nextjs',
  type: 'nextjs',
  module: opts.module,
  standalone: opts.standalone,
  entry: opts.entry,
});

export default nextjsBuild;
