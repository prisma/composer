import { expectTypeOf, test } from 'bun:test';
import type { DeployStep } from '../operations/deploy.ts';
import type { DestroyEvent, DestroyStep, NoLocalDeployStateEvent } from '../operations/destroy.ts';
import type { StepEvent } from '../operations/steps.ts';

test('a destroy step is every deploy step except preflight', () => {
  expectTypeOf<DestroyStep>().toEqualTypeOf<Exclude<DeployStep, { readonly name: 'preflight' }>>();
});

test('a destroy event is a step event over its own steps, or the missing local state notice', () => {
  expectTypeOf<DestroyEvent>().toEqualTypeOf<StepEvent<DestroyStep> | NoLocalDeployStateEvent>();
});
