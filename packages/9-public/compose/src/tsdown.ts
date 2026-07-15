import type { UserConfig } from 'tsdown';

/**
 * `tsdown` config for a Prisma App's own runnable — the build ADR-0005 expects
 * an app to produce before deploy. Its one job is a **self-contained** ESM
 * bundle: `node_modules` is never shipped, so everything the entry touches at
 * runtime must be inlined, and the artifact must not lean on bun's runtime
 * auto-install to fill gaps. So it inlines EVERYTHING except the runtime's own
 * built-ins (`bun`, `bun:*`, `node:*`) — a denylist, not a per-package
 * allowlist. Allowlists are the trap: `noExternal: [/^pg$/]` inlines `pg` but
 * misses its subpath imports (`pg/lib/*`), which then vanish from the bundle and
 * crash the service at boot. This mirrors the deploy wrapper's own inline
 * policy, so app and wrapper are self-contained the same way.
 *
 * Pass your `entry` (and any override); everything else is dictated.
 */
const appBaseConfig: UserConfig = {
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  external: ['bun'],
  // Inline everything except runtime built-ins (bun/bun:/node:).
  noExternal: [/^(?!bun$)(?!bun:)(?!node:).+/],
  dts: false,
  sourcemap: false,
  clean: true,
};

export function prismaTsDownConfig(
  config: UserConfig & { entry: NonNullable<UserConfig['entry']> },
): UserConfig {
  return {
    ...appBaseConfig,
    ...config,
  };
}
