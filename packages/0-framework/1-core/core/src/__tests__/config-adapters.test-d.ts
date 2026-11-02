/**
 * The `config` and `secrets` lists of the `composer` section, and the pools preflight receives.
 * Type-only (vitest `--typecheck`, never executed).
 */
import { expectTypeOf, test } from 'vitest';
import {
  type ConfigAdapter,
  type ConfigAdapterInput,
  type ConfigPools,
  defineConfig,
  type PreflightInput,
  type StateDescriptor,
} from '../exports/app-config.ts';

declare const state: StateDescriptor;

test('config and secrets take lists of adapters, sync or async', () => {
  defineConfig({
    extensions: [],
    state,
    config: [() => ({ A: 1 })],
    secrets: [async () => ({ B: 'b' })],
  });
});

test('an adapter list holds functions, and is a list', () => {
  // @ts-expect-error an entry must be an adapter function
  defineConfig({ extensions: [], state, config: [{}] });
  // @ts-expect-error the field is a list of adapters, not one adapter
  defineConfig({ extensions: [], state, config: () => ({}) });
});

test('an adapter receives the environment and the config directory', () => {
  expectTypeOf<Parameters<ConfigAdapter>[0]>().toEqualTypeOf<ConfigAdapterInput>();
});

test('preflight receives both pools', () => {
  expectTypeOf<PreflightInput['pools']>().toEqualTypeOf<ConfigPools>();
});
