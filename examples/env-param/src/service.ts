import { string } from '@prisma/composer';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';

/**
 * A single compute service with one required param and no default — the
 * smallest surface that forces a provision-time binding. The root binds
 * `greeting` to a platform env var via `envParam` (module.ts); the server
 * reads it back through `config()`.
 *
 * Its build is the adapter's directory form: `bun build --outdir` emits the
 * server into `dist/server/` and the build script copies `assets/` in beside
 * it, so the built runnable is a tree rather than one self-contained file.
 * `dir` names the tree, `entry` names the file inside it that boots, and
 * assemble copies the tree verbatim — which is what lets the server serve its
 * sibling asset over HTTP.
 */
export default compute({
  name: 'echo',
  deps: {},
  params: { greeting: string() },
  build: node({ module: import.meta.url, dir: '../dist/server', entry: 'server.js' }),
});
