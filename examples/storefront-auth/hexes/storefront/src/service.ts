import nextjs from '@makerkit/nextjs';
import { compute, http } from '@makerkit/prisma-cloud';

export default compute({ deps: { auth: http() }, build: nextjs({ entry: 'server.js' }) });
