/**
 * A second, dependency-free compute service — its only purpose is proving
 * "a changed artifact restarts exactly one service" (S4 proof): only
 * `web-service.ts`'s artifact changes between converges, so this one's pid
 * must stay stable across both the no-op and the changed-artifact converge.
 *
 * Also carries the fixture's secret + env-sourced param (S5 proof,
 * acceptance criterion 5), migrated to ADR-0042's one-input-schema model:
 * `apiKey` is a `SecretString` input field, bound in module.ts to
 * `LOCALDEV_FIXTURE_API_KEY`; the env-sourced param rides the reserved `port`
 * channel (the only param channel ADR-0042 keeps), bound to
 * `LOCALDEV_FIXTURE_GREETING`.
 */
import { secretString } from '@prisma/composer/arktype';
import node from '@prisma/composer/node';
import { compute } from '@prisma/composer-prisma-cloud';
import { type } from 'arktype';

export default compute({
  name: 'bkg',
  deps: {},
  input: type({ apiKey: secretString() }),
  build: node({ module: import.meta.url, entry: 'built/bg-server.mjs' }),
});
