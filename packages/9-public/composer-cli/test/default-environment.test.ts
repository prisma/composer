import { expect, test } from 'bun:test';
import { DEFAULT_DEPLOY_ENVIRONMENT } from '@internal/cli/family';
import { PRODUCTION_ENVIRONMENT } from '@internal/lowering';

test("a bare deploy's environment is the one Prisma Cloud maps to the default Branch", () => {
  expect(DEFAULT_DEPLOY_ENVIRONMENT).toBe(PRODUCTION_ENVIRONMENT);
});
