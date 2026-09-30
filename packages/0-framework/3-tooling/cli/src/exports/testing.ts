/**
 * Public surface (the `./testing` subpath, republished through
 * `@prisma/composer/testing`): the fixture-backed control-API double, and
 * the dev stack-file renderer for integration tests that drive Alchemy
 * directly. Implementation lives in ../testing/control-double.ts and
 * ../dev/generate-dev-stack.ts.
 */

export type { DevStackFileInput } from '../dev/generate-dev-stack.ts';
export { renderDevStackFile } from '../dev/generate-dev-stack.ts';
export type {
  ControlDouble,
  ControlDoubleCalls,
  ControlDoubleFixtures,
} from '../testing/control-double.ts';
export { createControlDouble } from '../testing/control-double.ts';
