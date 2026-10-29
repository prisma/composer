import { module, resolve } from '@prisma/composer';
import { envParam, publicUrl } from '@prisma/composer-prisma-cloud';
import echoService from './src/service.ts';

/**
 * The env-param example: one service whose required `greeting` input key is
 * bound to the env var ENV_PARAM_GREETING at provision. The deploy shell's
 * value resolves into the input document at deploy (ADR-0042 — an unset var
 * omits the key, which this schema rejects), and the server reads it back
 * through `input()` at boot. The `environment` key is computed at Load from
 * the environment's name, so each environment serves its own. The public URL
 * `site` makes echo reachable from the internet at its prisma.build hostname.
 *
 * A closed root: no boundary argument, no return — it only provisions.
 */
export default module('env-param-example', ({ environment, provision }) => {
  const label = resolve([environment.name], ([name]) => `deployed to ${name}`);
  const echo = provision(echoService, {
    input: { greeting: envParam('ENV_PARAM_GREETING'), environment: label },
  });
  provision(publicUrl({ name: 'site', url: publicUrl.prismaBuild(), target: echo.http }));
});
