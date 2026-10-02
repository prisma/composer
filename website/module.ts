import { module } from '@prisma/composer';
import siteService from './src/service.ts';

/**
 * The docs site app: a single service, no dependencies, no resources. The root
 * provisions the site and nothing else — `prisma deploy module.ts`
 * stands it up as one Compute service.
 */
export default module('composer-docs', ({ provision }) => {
  provision(siteService);
});
