/**
 * Public surface (the `./testing` subpath, republished through
 * `@prisma/composer/testing`): the fixture-backed operations double, and
 * the dev stack-file renderer for integration tests that drive Alchemy
 * directly. Implementation lives in ../testing/operations-double.ts and
 * ../dev/generate-dev-stack.ts.
 */

export type { DevStackFileInput } from '../dev/generate-dev-stack.ts';
export { renderDevStackFile } from '../dev/generate-dev-stack.ts';
export type {
  OperationsDouble,
  OperationsDoubleCalls,
  OperationsDoubleFixtures,
} from '../testing/operations-double.ts';
export { createOperationsDouble } from '../testing/operations-double.ts';
