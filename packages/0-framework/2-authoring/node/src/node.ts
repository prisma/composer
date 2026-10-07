/**
 * Marks a service as a plain server for deployment, in one of two forms.
 *
 * `node({ module, entry })` says the app's built server is the single
 * self-contained file at `entry`. `node({ module, dir, entry })` says it is the
 * whole directory `dir` — a server plus the sibling files it needs at runtime,
 * as a build like Bun's HTML import emits — and `entry` names the file inside
 * `dir` that boots.
 *
 * `module` is the authoring module's `import.meta.url`. `entry` (single-file
 * form) and `dir` (directory form) resolve relative to `dirname(module)`, like
 * an import specifier (ADR-0004); in the directory form `entry` then resolves
 * inside `dir` and may be nested. Nothing is discovered: the author names the
 * directory and the entry, and the assembler copies exactly that.
 *
 * Both forms accept `dependencies`. The default, `'bundled'`, ships exactly
 * what was built. `'external'` says the build leaves packages external, so
 * deploy traces `entry` and stages the installed packages it imports.
 *
 * Returns plain data — nothing runs on import. `extension` + `type` are the
 * control-plane registry key: deploy tooling routes assembly through the app's
 * `prisma.config.ts` to this package's `/control` descriptor
 * (ADR-0017).
 */
import type { BuildAdapter } from '@internal/core';

/** The node build adapter's descriptor. `dir` is the directory form's own extra path input (the built tree to copy verbatim), beyond the shared `{ extension, type, module, entry }`; absent, `entry` is the whole built runnable. */
export interface NodeBuildAdapter extends BuildAdapter {
  readonly type: 'node';
  readonly dir?: string;
  /** Whether the build inlined its packages (`'bundled'`, the default) or left them for deploy to stage from `node_modules` (`'external'`). */
  readonly dependencies?: NodeDependencies;
}

/**
 * How the build treats installed packages, in bundler terms (esbuild's and
 * Rollup's `external`, Vite's `ssr.external`). `'bundled'`: the build inlined
 * them, so deploy copies exactly what was built. `'external'`: the build left
 * them as imports, so deploy traces `entry` and stages the installed packages
 * it imports.
 */
export type NodeDependencies = 'bundled' | 'external';

/** The two forms an author may write. `dir?: never` on the single-file branch is what makes them exclusive: with `dir`, `entry` is required and names a file inside it. */
type NodeBuildOptions = (
  | { module: string; entry: string; dir?: never }
  | { module: string; dir: string; entry: string }
) & {
  /** `'bundled'` (default) ships exactly what was built. `'external'` also stages the installed packages `entry` imports. */
  dependencies?: NodeDependencies;
};

const nodeBuild = (opts: NodeBuildOptions): NodeBuildAdapter => ({
  extension: '@prisma/composer/node',
  type: 'node',
  module: opts.module,
  entry: opts.entry,
  ...(opts.dir === undefined ? {} : { dir: opts.dir }),
  ...(opts.dependencies === undefined ? {} : { dependencies: opts.dependencies }),
});

export default nodeBuild;
