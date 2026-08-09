/**
 * Public surface (the `./control/testing` subpath): the fixture-backed test
 * double for the `./control` operations. A host that drives
 * `@prisma/composer/control` tests against this double — same operation
 * signatures, same `Result` shapes, never an alchemy process or a container.
 * Implementation lives in ../operations/control-double.ts.
 */

export type { CliStructuredError } from '@internal/foundation/errors';
export type { NotOk, Ok, Result } from '@internal/foundation/result';
export type {
  ControlDoubleFixtures,
  ControlOperations,
  DevSessionFixture,
  LogFixture,
} from '../operations/control-double.ts';
export {
  createControlDouble,
  notOk,
  ok,
  okVoid,
  structuredFailure,
} from '../operations/control-double.ts';
