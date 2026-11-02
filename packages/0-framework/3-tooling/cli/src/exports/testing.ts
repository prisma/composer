/**
 * Public surface (the `./testing` subpath, republished through
 * `@prisma/composer-cli/testing`): the fixture-backed operations double, and
 * the dev stack-file renderer and configuration-file writers for integration
 * tests that drive Alchemy directly. Implementation lives in
 * ../testing/operations-double.ts, ../dev/generate-dev-stack.ts and
 * ../configuration-file.ts.
 */

export {
  removeConfigurationFile,
  secondProcessEnvironment,
  writeConfigurationFile,
} from '../configuration-file.ts';

export type { DevStackFileInput } from '../dev/generate-dev-stack.ts';
export { renderDevStackFile } from '../dev/generate-dev-stack.ts';
export type {
  OperationsDouble,
  OperationsDoubleCalls,
  OperationsDoubleFixtures,
} from '../testing/operations-double.ts';
export { createOperationsDouble } from '../testing/operations-double.ts';
