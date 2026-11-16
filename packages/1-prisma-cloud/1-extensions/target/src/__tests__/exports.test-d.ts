import { expectTypeOf, test } from 'vitest';
import type * as surface from '../exports/index.ts';

test('envSecret, envParam and secretName are not exported', () => {
  // @ts-expect-error envSecret is removed: provision variable.secret({ name }) in the app root
  expectTypeOf<typeof surface.envSecret>().not.toBeNever();
  // @ts-expect-error envParam is removed: provision variable({ name }) in the app root, or read a root input field
  expectTypeOf<typeof surface.envParam>().not.toBeNever();
  // @ts-expect-error secretName is removed: find a binding's variable through graph.valueReads
  expectTypeOf<typeof surface.secretName>().not.toBeNever();
});

test('the payload types of envSecret and envParam are not exported, and PlatformVariablePayload is', () => {
  // @ts-expect-error EnvSecretPayload is removed
  expectTypeOf<surface.EnvSecretPayload>().not.toBeNever();
  // @ts-expect-error EnvParamPayload is removed
  expectTypeOf<surface.EnvParamPayload>().not.toBeNever();
  expectTypeOf<surface.PlatformVariablePayload['name']>().toEqualTypeOf<string>();
});
