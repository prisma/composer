import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';

/**
 * A minimal compute service used solely as the target of a .js-extension
 * import in module.ts. Its purpose is to prove that tsx resolves ./service.js
 * to this .ts source under Node — it is not meant to be deployed.
 */
export default compute({
  name: 'js-ext-guard',
  deps: {},
  build: node({ module: import.meta.url, entry: 'server.js' }),
});
