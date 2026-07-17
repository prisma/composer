import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';

export default compute({
  name: 'web',
  deps: {},
  // Nitro's server imports sibling chunks and serves assets from this tree.
  // The directory form preserves the runnable exactly as `vite build` emitted it.
  build: node({
    module: import.meta.url,
    dir: '../.output',
    entry: 'server/index.mjs',
  }),
});
