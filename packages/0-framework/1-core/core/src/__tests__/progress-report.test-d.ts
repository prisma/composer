/**
 * The progress channels core hands to extensions: assemble and preflight each
 * take an optional `report` callback for a bag of counts and labels, and the
 * assembled artifact itself carries no measurements. Type-only (vitest
 * `--typecheck`, never executed).
 */
import { expectTypeOf, test } from 'vitest';
import type { PreflightInput } from '../exports/app-config.ts';
import type { AssembleInput, Bundle } from '../exports/deploy.ts';

type ProgressReport = ((data: Readonly<Record<string, string | number>>) => void) | undefined;

test('assemble and preflight report through the same optional callback', () => {
  expectTypeOf<AssembleInput['report']>().toEqualTypeOf<ProgressReport>();
  expectTypeOf<PreflightInput['report']>().toEqualTypeOf<
    ((counts: Readonly<Record<string, number>>) => void) | undefined
  >();
});

test('an assembled Bundle carries no measurements', () => {
  expectTypeOf<keyof Bundle>().toEqualTypeOf<'dir' | 'entry' | 'watch'>();
});
