import type { Rolldown, UserConfig } from 'tsdown';

// Bundlers do not read a built input's own source map, so bundling another workspace
// package's dist would name that dist as the source. Loading the map lets rolldown compose it.
export const carryIncomingSourceMaps: Rolldown.Plugin = {
  name: 'carry-incoming-source-maps',
  load: {
    filter: { id: { include: /\.(?:m?js|d\.m?ts)$/, exclude: /[\\/]node_modules[\\/]/ } },
    async handler(id) {
      const code = await this.fs.readFile(id, { encoding: 'utf8' });
      const mapUrl = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(code)?.[1];
      if (mapUrl === undefined || mapUrl.startsWith('data:')) return null;
      const directory = id.slice(0, Math.max(id.lastIndexOf('/'), id.lastIndexOf('\\')) + 1);
      return {
        code,
        map: await this.fs.readFile(directory + decodeURI(mapUrl), { encoding: 'utf8' }),
      };
    },
  },
};

/**
 * Base `tsdown` configuration for the workspace. Mirrors prisma/orm's
 * tsdown base: emit `.mjs` + `.d.mts` to `dist`, keep node_modules
 * external, and let tsdown own each package's `exports`/`main`/`types` so the
 * manifest never drifts from what was built.
 *
 * The workspace runs tsdown 0.22.4 — the same version prisma/orm pins —
 * whose typed `exports` API is `{ enabled: 'local-only', customExports,
 * exclude }`, not the `exports: true` shorthand. `customExports` strips the
 * `exports/` prefix that `src/exports/*.ts` entries produce (see below), so
 * `src/exports/control.ts` publishes as `./control`. Packages with a CLI/bin
 * entry opt out with `exports: false` and declare their subpaths by hand.
 */
export const baseConfig: UserConfig = {
  dts: {
    enabled: true,
    // Declaration maps: "go to definition" on a consuming package lands in
    // the source .ts, not the emitted .d.mts.
    sourcemap: true,
  },
  exports: {
    enabled: 'local-only',
    customExports: function stripExportsPrefix(exports) {
      // biome-ignore lint/suspicious/noExplicitAny: matches tsdown's own `customExports` signature (`Record<string, any>`).
      const out: Record<string, any> = {};

      for (let [key, value] of Object.entries(exports)) {
        // Drop the "exports/" prefix so `src/exports/control.ts` publishes
        // as `./control`, not `./exports/control`.
        key = key.replace(/exports\/?/, '');

        // "./" is illegal in package.json exports; the root subpath is ".".
        if (key === './') {
          key = '.';
        }

        // Single-entry packages collapse to "." — derive the subpath from
        // the built filename instead, unless it's the package's own index.
        if (key === '.' && typeof value === 'string') {
          const match = value.match(/\/([^/]+)\.mjs$/);
          if (match && match[1] !== 'index') {
            key = `./${match[1]}`;
          }
        }

        out[key] = value;
      }

      return out;
    },
    // Keep `bin` entries (the CLI executable) out of the importable subpaths.
    // tsdown matches `exclude` against the export name with its extension
    // already stripped, so the pattern must match "bin" exactly.
    exclude: [/^bin$/],
  },
  outExtensions: () => ({ js: '.mjs', dts: '.d.mts' }),
  plugins: [carryIncomingSourceMaps],
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
