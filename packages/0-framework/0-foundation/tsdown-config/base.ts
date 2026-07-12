import type { UserConfig } from 'tsdown';

/**
 * Base `tsdown` configuration for the workspace. Mirrors prisma-next's
 * `@prisma-next/tsdown`: emit `.mjs` + `.d.mts` to `dist`, keep node_modules
 * external, and let tsdown own each package's `exports`/`main`/`types` so the
 * manifest never drifts from what was built.
 *
 * `exports: true` generates the manifest export map from the built entries.
 * (prisma-next pins tsdown 0.22 and uses `exports: { enabled: 'local-only' }`;
 * the workspace's tsdown is 0.15.x, whose typed API is `exports: true` — same
 * generated map. Packages with a CLI/bin entry opt out with `exports: false`
 * and declare their subpaths by hand.)
 */
export const baseConfig: UserConfig = {
  dts: true,
  exports: true,
  outExtensions: () => ({ js: '.mjs', dts: '.d.mts' }),
  skipNodeModulesBundle: true,
  sourcemap: true,
};

/**
 * Extend/use the base `tsdown` config with custom settings.
 *
 * See {@link baseConfig} for the default configuration object.
 */
export function defineConfig(config?: UserConfig): UserConfig {
  return {
    ...baseConfig,
    ...config,
  };
}
