import { expectTypeOf, test } from 'vitest';
import type * as surface from '../exports/index.ts';

test('envSecret, envParam, secretName, paramName and their payload types are not exported', () => {
  type Removed = {
    // @ts-expect-error envSecret is removed: provision variable.secret({ name }) in the app root
    envSecret: typeof surface.envSecret;
    // @ts-expect-error envParam is removed: provision variable({ name }) in the app root, or read a root input field
    envParam: typeof surface.envParam;
    // @ts-expect-error secretName is removed: find a binding's variable through graph.valueReads
    secretName: typeof surface.secretName;
    // @ts-expect-error paramName is removed: a per-key param takes no platform variable
    paramName: typeof surface.paramName;
    // @ts-expect-error EnvSecretPayload is removed
    EnvSecretPayload: surface.EnvSecretPayload;
    // @ts-expect-error EnvParamPayload is removed
    EnvParamPayload: surface.EnvParamPayload;
  };
  expectTypeOf<keyof Removed>().toEqualTypeOf<
    'envSecret' | 'envParam' | 'secretName' | 'paramName' | 'EnvSecretPayload' | 'EnvParamPayload'
  >();
});

test('PlatformVariablePayload is exported', () => {
  expectTypeOf<surface.PlatformVariablePayload['name']>().toEqualTypeOf<string>();
});
