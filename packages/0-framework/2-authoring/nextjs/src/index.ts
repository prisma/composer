/**
 * Marks a service as a Next.js app for deployment. `nextjs({ module, appDir,
 * entry })`: `module` is the authoring module's `import.meta.url`; `appDir`
 * is the Next app's root (the standalone layout root), resolved relative to
 * `dirname(module)` — exactly like an import specifier (ADR-0004); `entry` is
 * the built standalone server's filename, relative to `appDir`'s standalone
 * output. Returns plain data — nothing runs on import. `extension` + `type`
 * are the control-plane registry key: deploy tooling routes assembly through
 * the app's `prisma-compose.config.ts` to this package's `/control` descriptor
 * (ADR-0017) — no module loading here.
 */
import type { BuildAdapter } from '@internal/core';

/** The nextjs build adapter's descriptor — `appDir` is this kind's own extra path input, beyond the shared `{ extension, type, module, entry }`. */
export interface NextjsBuildAdapter extends BuildAdapter {
  readonly type: 'nextjs';
  readonly appDir: string;
}

const nextjsBuild = (opts: {
  module: string;
  appDir: string;
  entry: string;
}): NextjsBuildAdapter => ({
  extension: '@prisma/compose/nextjs',
  type: 'nextjs',
  module: opts.module,
  appDir: opts.appDir,
  entry: opts.entry,
});

export default nextjsBuild;
