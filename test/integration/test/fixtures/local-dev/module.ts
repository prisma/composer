/**
 * The local-dev integration fixture's root (S4 proof, local-dev spec § 4/§ 5,
 * plan.md's S4 outcome): compute + postgres + bucket, so a `dev: true`
 * lowering exercises every one of the eight local providers. Discovered by
 * walking up from this file (a real `prisma-composer.config.ts` sits at the
 * repo root of this package).
 *
 * `bgService`'s secret/env-param binding (S5 proof, spec's acceptance
 * criterion 5), on ADR-0042's input model: `apiKey` is an `envSecret` leaf of
 * the input binding — absent from the shell, dev mints a placeholder and
 * warns; the env-sourced param rides the reserved `port` channel, bound to
 * `LOCALDEV_FIXTURE_GREETING` — absent from the shell, dev hard-errors. Both
 * names are fixture-private, chosen not to collide with any real platform env
 * var.
 */
import { module } from '@prisma/composer';
import { bucket, envParam, envSecret, postgres } from '@prisma/composer-prisma-cloud';
import bgService from './bg-service.ts';
import webService from './web-service.ts';

export default module('localdevs4fixture', ({ provision }) => {
  const db = provision(postgres({ name: 'appdb' }));
  const store = provision(bucket({ name: 'files' }));
  provision(webService, { deps: { db, store } });
  provision(bgService, {
    input: { apiKey: envSecret('LOCALDEV_FIXTURE_API_KEY') },
    params: { port: envParam('LOCALDEV_FIXTURE_GREETING') },
  });
});
