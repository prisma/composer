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
 * The directory form also accepts `standalone: true`, for a build folder that
 * runs without the project's installed packages.
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
  /** Directory form only: ship `dir` as it is, without searching for installed packages the entry uses. */
  readonly standalone?: boolean;
}

/** The two forms an author may write. `dir?: never` on the single-file branch is what makes them exclusive: with `dir`, `entry` is required and names a file inside it. */
type NodeBuildOptions =
  | { module: string; entry: string; dir?: never; standalone?: never }
  | {
      module: string;
      dir: string;
      entry: string;
      /**
       * The build folder runs on its own, without the project's installed
       * packages (for example a fully bundled server, or Next.js
       * `output: 'standalone'`). Composer then ships the folder as it is and
       * skips searching for installed packages the build uses. Default `false`.
       */
      standalone?: boolean;
    };

const nodeBuild = (opts: NodeBuildOptions): NodeBuildAdapter => ({
  extension: '@prisma/composer/node',
  type: 'node',
  module: opts.module,
  entry: opts.entry,
  ...(opts.dir === undefined ? {} : { dir: opts.dir }),
  ...(opts.standalone === undefined ? {} : { standalone: opts.standalone }),
});

export default nodeBuild;
