import framework from '@prisma/composer/frameworks';
import { rpc } from '@prisma/composer/service-rpc';
import { compute } from '@prisma/composer-prisma-cloud';
import { authContract } from '@storefront-auth/auth/contract';

export default compute({
  name: 'storefront',
  deps: { auth: rpc(authContract) },
  build: framework({ module: import.meta.url, framework: 'nextjs', root: '..' }),
});
