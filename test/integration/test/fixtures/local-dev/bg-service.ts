/**
 * A second, dependency-free compute service — its only purpose is proving
 * "a changed artifact restarts exactly one service" (S4 proof): only
 * `web-service.ts`'s artifact changes between converges, so this one's pid
 * must stay stable across both the no-op and the changed-artifact converge.
 *
 * Also carries the fixture's secret slot + env-sourced param (S5 proof,
 * acceptance criterion 5) — bound in module.ts to `LOCALDEV_FIXTURE_API_KEY`
 * / `LOCALDEV_FIXTURE_GREETING`.
 */
import { secret, string } from '@prisma/composer';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';

export default compute({
  name: 'bkg',
  deps: {},
  secrets: { apiKey: secret() },
  params: { greeting: string() },
  build: node({ module: import.meta.url, entry: 'built/bg-server.mjs' }),
});
