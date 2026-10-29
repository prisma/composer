import { rawHttpContract } from '@prisma/composer/http';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

/**
 * A single compute service with two required input keys and no defaults — the
 * smallest surface that forces a provision-time binding. The root binds
 * `greeting` to a platform env var via `envParam` and `environment` to a value
 * computed from the environment's name (module.ts); the server reads both back
 * through `input()` (ADR-0042). It exposes its HTTP interface so the root
 * can make it public.
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
  expose: { http: rawHttpContract },
  input: type({ greeting: 'string', environment: 'string' }),
  build: node({ module: import.meta.url, dir: '../dist/server', entry: 'server.js' }),
});
