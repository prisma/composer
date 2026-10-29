/**
 * A second, dependency-free compute service — its only purpose is proving
 * "a changed artifact restarts exactly one service" (S4 proof): only
 * `web-service.ts`'s artifact changes between converges, so this one's pid
 * must stay stable across both the no-op and the changed-artifact converge.
 *
 * Also carries the fixture's secrets and env-sourced param: a required
 * `apiKey` and an optional `webhookSecret`, bound in module.ts; the param
 * rides the reserved `port` channel.
 */
import { secretString } from '@prisma/composer/arktype';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

export default compute({
  name: 'bkg',
  deps: {},
  input: type({ apiKey: secretString(), 'webhookSecret?': secretString() }),
  build: node({ module: import.meta.url, entry: 'built/bg-server.mjs' }),
});
