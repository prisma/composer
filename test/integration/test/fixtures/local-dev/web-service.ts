/**
 * The local-dev integration fixture's main service (S4 proof, local-dev
 * spec § 4/§ 5): a compute service wired to a Postgres and a bucket, so the
 * fixture exercises every local provider dev.providers registers. Its
 * built entry (`built/web-server.mjs`) is hand-written, not produced by a real
 * bundler — assemble() only needs a real file at `entry`, and bun executes a
 * `.ts` sibling import natively at runtime, so no build step is needed for
 * this fixture to be genuine "built output". (Named `built/`, not `dist/` —
 * the repo's `.gitignore` excludes every `dist/` directory, and this one must
 * be committed.)
 */
import node from '@prisma/composer/node';
import { bucket, compute, postgres } from '@prisma/composer-prisma-cloud';

export default compute({
  name: 'web',
  deps: { db: postgres(), store: bucket() },
  build: node({ module: import.meta.url, entry: 'built/web-server.mjs' }),
});
