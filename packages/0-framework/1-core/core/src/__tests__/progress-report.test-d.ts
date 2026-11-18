import { expectTypeOf, test } from 'vitest';
import type { PlatformVariableCheck, PreflightInput } from '../exports/app-config.ts';
import type { AssembleInput, Bundle } from '../exports/deploy.ts';

type ProgressReport = ((data: Readonly<Record<string, string | number>>) => void) | undefined;

test('assemble reports counts and labels, preflight what it checked and found', () => {
  expectTypeOf<AssembleInput['report']>().toEqualTypeOf<ProgressReport>();
  expectTypeOf<PreflightInput['report']>().toEqualTypeOf<
    ((report: PlatformVariableCheck) => void) | undefined
  >();
});

test('an assembled Bundle carries no measurements', () => {
  expectTypeOf<keyof Bundle>().toEqualTypeOf<'dir' | 'entry' | 'watch'>();
});
