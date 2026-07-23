/**
 * The local-dev integration fixture's root (S4 proof, local-dev spec § 4/§ 5,
 * plan.md's S4 outcome): compute + postgres + bucket, so a `dev: true`
 * lowering exercises every one of the eight local providers. Discovered by
 * walking up from this file (a real `prisma-composer.config.ts` sits at the
 * repo root of this package).
 */
import { module } from '@prisma/composer';
import { bucket, postgres } from '@prisma/composer-prisma-cloud';
import bgService from './bg-service.ts';
import webService from './web-service.ts';

export default module('localdevs4fixture', ({ provision }) => {
  const db = provision(postgres({ name: 'appdb' }));
  const store = provision(bucket({ name: 'files' }));
  provision(webService, { deps: { db, store } });
  provision(bgService, {});
});
