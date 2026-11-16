/**
 * The local-dev integration fixture's root (S4 proof, local-dev spec § 4/§ 5,
 * plan.md's S4 outcome): compute + postgres + bucket, so a `dev: true`
 * lowering exercises every one of the eight local providers. The package's
 * `prisma.config.ts` carries the `composer` section a real `dev` would read.
 *
 * The root provisions two platform secrets and one plain platform variable,
 * and `bgService` reads them. `apiKey` is required, so dev stops when
 * `LOCALDEV_FIXTURE_API_KEY` is unset; `webhookSecret` is optional, so an unset
 * `LOCALDEV_FIXTURE_WEBHOOK_SECRET` reaches the service as absent. The plain
 * variable `LOCALDEV_FIXTURE_GREETING` is bound to the reserved `port` param;
 * `port` has a default, so dev starts when it is unset. The names are
 * fixture-private, chosen not to collide with any real platform variable.
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
  provision(webService, { deps: { db, store } });
  provision(bgService, {
    input: { apiKey, webhookSecret },
    params: { port: greeting },
  });
});
