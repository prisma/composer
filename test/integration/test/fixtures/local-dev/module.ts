/**
 * The local-dev integration fixture's root (S4 proof, local-dev spec § 4/§ 5,
 * plan.md's S4 outcome): compute + postgres + bucket, so a `dev: true`
 * lowering exercises every one of the eight local providers. The package's
 * `prisma.config.ts` carries the `composer` section a real `dev` would read.
 *
 * `bgService` binds two secrets and an env-sourced param. `apiKey` is
 * required, so dev stops when `LOCALDEV_FIXTURE_API_KEY` is unset;
 * `webhookSecret` is optional, so an unset `LOCALDEV_FIXTURE_WEBHOOK_SECRET`
 * reaches the service as absent. The param rides the reserved `port` channel,
 * bound to `LOCALDEV_FIXTURE_GREETING`; dev stops when it is unset. The names
 * are fixture-private, chosen not to collide with any real platform env var.
 */
import { module } from '@prisma/composer';
import { bucket, envParam, envSecret, rawPostgres } from '@prisma/composer-prisma-cloud';
import bgService from './bg-service.ts';
import webService from './web-service.ts';

export default module('localdevs4fixture', ({ provision }) => {
  const db = provision(rawPostgres({ name: 'appdb' }));
  const store = provision(bucket({ name: 'files' }));
  provision(webService, { deps: { db, store } });
  provision(bgService, {
    input: {
      apiKey: envSecret('LOCALDEV_FIXTURE_API_KEY'),
      webhookSecret: envSecret('LOCALDEV_FIXTURE_WEBHOOK_SECRET'),
    },
    params: { port: envParam('LOCALDEV_FIXTURE_GREETING') },
  });
});
