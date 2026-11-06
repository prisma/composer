/**
 * Public surface (the `./testing` subpath, republished through
 * `@prisma/composer-cli/testing`): the fixture-backed operations double, and
 * the dev stack-file renderer and the first process's handover to the second
 * process, for integration tests that drive Alchemy directly. `KnownSecrets` is
 * here only to build the known secrets `prepareSecondProcess` refuses to write. Implementation lives in ../testing/operations-double.ts,
 * ../dev/generate-dev-stack.ts, ../app-configuration-file.ts and ../redaction.ts.
 */

export type { SecondProcessHandover } from '../app-configuration-file.ts';
export { prepareSecondProcess } from '../app-configuration-file.ts';
export type { DevStackFileInput } from '../dev/generate-dev-stack.ts';
export { renderDevStackFile } from '../dev/generate-dev-stack.ts';
export { KnownSecrets } from '../redaction.ts';
export type {
  OperationsDouble,
  OperationsDoubleCalls,
  OperationsDoubleFixtures,
} from '../testing/operations-double.ts';
export { createOperationsDouble } from '../testing/operations-double.ts';
