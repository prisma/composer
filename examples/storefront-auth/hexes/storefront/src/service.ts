import nextjs from '@makerkit/nextjs';
import { compute } from '@makerkit/prisma-cloud';
import { rpc } from '@makerkit/rpc';
import { authContract } from '@storefront-auth/auth/contract';

export default compute({
  deps: { auth: rpc(authContract) },
  build: nextjs({ entry: 'server.js' }),
});
