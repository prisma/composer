/**
 * The local-dev integration fixture's root (S4 proof, local-dev spec § 4/§ 5,
 * plan.md's S4 outcome): compute + postgres + bucket, so a `dev: true`
 * lowering exercises every one of the eight local providers. The package's
 * `prisma.config.ts` carries the `composer` section a real `dev` would read.
 *
 * `apiKey` is required, so dev stops when it is unset; `webhookSecret`,
 * `greeting` and `smtpPort` are not, so dev starts without them. `smtpPort` is
 * typed `number`, so the web service receives a number.
 */
import { appRoot } from '@prisma/composer';
import { bucket, rawPostgres, variable } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';
import bgService from './bg-service.ts';
import webService from './web-service.ts';

export default appRoot('localdevs4fixture', ({ provision }) => {
  const db = provision(rawPostgres({ name: 'appdb' }));
  const store = provision(bucket({ name: 'files' }));
  const apiKey = provision(variable.secret({ name: 'LOCALDEV_FIXTURE_API_KEY' }));
  const webhookSecret = provision(variable.secret({ name: 'LOCALDEV_FIXTURE_WEBHOOK_SECRET' }));
  const greeting = provision(variable({ name: 'LOCALDEV_FIXTURE_GREETING' }));
  const smtpPort = provision(
    variable({ name: 'LOCALDEV_FIXTURE_SMTP_PORT', schema: type('number') }),
  );
  provision(webService, { deps: { db, store }, input: { greeting, smtpPort } });
  provision(bgService, { input: { apiKey, webhookSecret } });
});
