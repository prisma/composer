import { describe, expect, test } from 'bun:test';
import { RenamePolicy } from 'alchemy/Rename';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import {
  fromLegacyId,
  legacyAddress,
  legacyConfigKey,
  legacyEnvVarId,
  legacyGeneratedParamId,
  legacyGeneratedParamVarName,
  legacyInputKey,
  legacyNodeResourceId,
  legacyServiceKeyId,
  legacyStreamsKeyId,
} from '../legacy-resource-ids.ts';
import { resourceId } from '../resource-ids.ts';
import { resourceLabel } from '../service-app.ts';

describe('resourceId', () => {
  test("is the address for a node's main resource", () => {
    expect(resourceId('shop.catalog')).toBe('shop.catalog');
  });

  test('adds each role segment after a dot', () => {
    expect(resourceId('shop.catalog', 'conn')).toBe('shop.catalog.conn');
    expect(resourceId('shop.web', 'env', 'COMPOSER_SHOP_WEB_PORT')).toBe(
      'shop.web.env.COMPOSER_SHOP_WEB_PORT',
    );
  });
});

describe('resourceLabel', () => {
  test('is the address without the app name', () => {
    expect(resourceLabel('shop.catalog')).toBe('catalog');
    expect(resourceLabel('my-shop.auth.files')).toBe('auth.files');
  });
});

describe('legacy resource IDs', () => {
  test('legacyAddress drops the app name, including one with `-`', () => {
    expect(legacyAddress('shop.auth.api')).toBe('auth.api');
    expect(legacyAddress('my-shop.web')).toBe('web');
    expect(legacyAddress('shop')).toBe('');
  });

  test('legacyNodeResourceId is the legacy address, `-` and the suffix', () => {
    expect(legacyNodeResourceId('shop.web', 'svc')).toBe('web-svc');
    expect(legacyNodeResourceId('shop.auth.api', 'deploy')).toBe('auth.api-deploy');
    expect(legacyNodeResourceId('shop.catalog', 'db')).toBe('catalog-db');
    expect(legacyNodeResourceId('shop.creds', 'creds')).toBe('creds-creds');
  });

  test('legacyEnvVarId is the key and `-var`', () => {
    expect(legacyEnvVarId('COMPOSER_WEB_PORT')).toBe('COMPOSER_WEB_PORT-var');
  });

  test('legacyConfigKey builds the key from the legacy address, for both owners', () => {
    expect(legacyConfigKey('shop.web', { owner: 'service', name: 'port' })).toBe(
      'COMPOSER_WEB_PORT',
    );
    expect(legacyConfigKey('my-shop.auth.api', { owner: { input: 'db' }, name: 'url' })).toBe(
      'COMPOSER_AUTH_API_DB_URL',
    );
  });

  test('legacyInputKey is the input row key under the legacy address', () => {
    expect(legacyInputKey('shop.auth.api')).toBe('COMPOSER_AUTH_API_INPUT');
  });

  test('legacyGeneratedParamVarName is the generated leaf variable under the legacy address', () => {
    expect(legacyGeneratedParamVarName('shop.web', 'stripe.key')).toBe(
      'COMPOSER_WEB_STRIPE_KEY_GENERATED',
    );
  });

  test('legacyGeneratedParamId is the legacy input key, the path and `-generated`', () => {
    expect(legacyGeneratedParamId('shop.web', 'secret')).toBe(
      'COMPOSER_WEB_INPUT:secret-generated',
    );
  });

  test('legacyServiceKeyId is named for the calling service and input', () => {
    expect(legacyServiceKeyId('shop.web', 'auth')).toBe('servicekey-web.auth');
  });

  test('legacyStreamsKeyId is named for the provider', () => {
    expect(legacyStreamsKeyId('shop.auth.events')).toBe('streamskey-auth.events');
  });

  test('fromLegacyId runs the resource under a RenamePolicy naming the legacy ID', () => {
    const policy = Effect.runSync(
      Effect.serviceOption(RenamePolicy).pipe(fromLegacyId('catalog-db')),
    );
    expect(Option.getOrUndefined(policy)).toEqual(['catalog-db']);
  });
});
