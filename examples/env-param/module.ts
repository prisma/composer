import { module } from '@prisma/composer';
import { envParam } from '@prisma/composer-prisma-cloud';
import echoService from './src/service.ts';

/**
 * The env-param example: one service whose required `greeting` input key is
 * bound to the env var ENV_PARAM_GREETING at provision. The deploy shell's
 * value resolves into the input document at deploy (ADR-0042 — an unset var
 * omits the key, which this schema rejects), and the server reads it back
 * through `input()` at boot.
 *
 * A closed root: no boundary argument, no return — it only provisions.
 */
export default module('env-param-example', ({ provision }) => {
  provision(echoService, { input: { greeting: envParam('ENV_PARAM_GREETING') } });
});
