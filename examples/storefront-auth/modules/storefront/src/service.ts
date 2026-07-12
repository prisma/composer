import nextjs from '@prisma/compose/nextjs';
import { rpc } from '@prisma/compose/rpc';
import { compute } from '@prisma/compose-prisma-cloud';
import { authContract } from '@storefront-auth/auth/contract';

export default compute({
  name: 'storefront',
  deps: { auth: rpc(authContract) },
  build: nextjs({ module: import.meta.url, appDir: '..', entry: 'server.js' }),
});
