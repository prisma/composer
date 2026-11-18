/**
 * The local-dev integration fixture's root (S4 proof, local-dev spec § 4/§ 5,
 * plan.md's S4 outcome): compute + postgres + bucket, so a `dev: true`
 * lowering exercises every one of the eight local providers. The package's
 * `prisma.config.ts` carries the `composer` section a real `dev` would read.
 *
 * `apiKey` is required, so dev stops when it is unset; `webhookSecret` and
 * `greeting` are not, so dev starts without them.
 */
import { appRoot } from '@prisma/composer';
import { bucket, rawPostgres, variable } from '@prisma/composer-prisma-cloud';
import bgService from './bg-service.ts';
import webService from './web-service.ts';

export default appRoot('localdevs4fixture', ({ provision }) => {
  const db = provision(rawPostgres({ name: 'appdb' }));
  const store = provision(bucket({ name: 'files' }));
  const apiKey = provision(variable.secret({ name: 'LOCALDEV_FIXTURE_API_KEY' }));
  const webhookSecret = provision(variable.secret({ name: 'LOCALDEV_FIXTURE_WEBHOOK_SECRET' }));
  const greeting = provision(variable({ name: 'LOCALDEV_FIXTURE_GREETING' }));
  provision(webService, { deps: { db, store }, input: { greeting } });
  provision(bgService, { input: { apiKey, webhookSecret } });
});
