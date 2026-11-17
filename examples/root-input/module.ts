import { appRoot, resolve } from '@prisma/composer';
import { publicUrl } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';
import echoService from './src/service.ts';

/**
 * The root-input example: one service whose required `greeting` input key is
 * bound to ROOT_INPUT_GREETING, a field of the root's input. The deploy reads
 * the field from the `config` adapters, by default the deploy shell, so each
 * environment can be deployed with its own greeting. The root's schema refuses
 * an unset value before anything is created. The value goes into the input
 * document at deploy, and the server reads it back through `input()` at boot.
 * The `environment` key is computed at Load from the environment's name, so
 * each environment serves its own. The public URL `site` makes echo reachable
 * from the internet at its prisma.build hostname.
 */
export default appRoot(
  'root-input-example',
  { input: type({ ROOT_INPUT_GREETING: 'string' }) },
  ({ environment, input, provision }) => {
    const label = resolve([environment.name], ([name]) => `deployed to ${name}`);
    const echo = provision(echoService, {
      input: { greeting: input.ROOT_INPUT_GREETING, environment: label },
    });
    provision(publicUrl({ id: 'site', url: publicUrl.prismaBuild(), target: echo.http }));
  },
);
