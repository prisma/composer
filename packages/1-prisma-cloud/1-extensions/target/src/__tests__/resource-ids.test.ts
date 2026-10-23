import { describe, expect, test } from 'bun:test';
import { RenamePolicy } from 'alchemy/Rename';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import {
  addressBelowApp,
  fromLegacyId,
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
import { configKey } from '../serializer.ts';

describe('resourceId', () => {
  test("is the address for a node's main resource", () => {
    expect(resourceId('shop.catalog')).toBe('shop.catalog');
  });

  test('adds each role segment after a dot', () => {
    expect(resourceId('shop.catalog', 'connection')).toBe('shop.catalog.connection');
    expect(resourceId('shop.web', 'env', 'COMPOSER_SHOP_WEB_PORT')).toBe(
      'shop.web.env.COMPOSER_SHOP_WEB_PORT',
    );
  });
});

describe('addressBelowApp', () => {
  test('removes the app name and its dot', () => {
    expect(addressBelowApp('shop.catalog', 'shop')).toBe('catalog');
    expect(addressBelowApp('shop.auth.api', 'shop')).toBe('auth.api');
  });

  test('removes an app name that contains `-` or `_`', () => {
    expect(addressBelowApp('my-shop.auth.files', 'my-shop')).toBe('auth.files');
    expect(addressBelowApp('my_shop.web', 'my_shop')).toBe('web');
  });

  test('removes only the app name when a child is named like the app', () => {
    expect(addressBelowApp('shop.shop.db', 'shop')).toBe('shop.db');
    expect(addressBelowApp('shop.shop', 'shop')).toBe('shop');
  });

  test('throws for an address that is not inside the app', () => {
    expect(() => addressBelowApp('shop', 'shop')).toThrow(
      'prisma-cloud: the address "shop" is not inside the app "shop".',
    );
    expect(() => addressBelowApp('shopping.web', 'shop')).toThrow(
      'the address "shopping.web" is not inside the app "shop"',
    );
    expect(() => addressBelowApp('other.web', 'shop')).toThrow('is not inside the app "shop"');
  });
});

describe('legacy resource IDs', () => {
  test('legacyNodeResourceId is the address below the app, `-` and the suffix', () => {
    expect(legacyNodeResourceId('shop', 'shop.web', 'svc')).toBe('web-svc');
    expect(legacyNodeResourceId('shop', 'shop.auth.api', 'deploy')).toBe('auth.api-deploy');
    expect(legacyNodeResourceId('shop', 'shop.catalog', 'db')).toBe('catalog-db');
    expect(legacyNodeResourceId('shop', 'shop.creds', 'creds')).toBe('creds-creds');
    expect(legacyNodeResourceId('my-shop', 'my-shop.web', 'svc')).toBe('web-svc');
    expect(legacyNodeResourceId('shop', 'shop.shop.db', 'db')).toBe('shop.db-db');
  });

  test('legacyNodeResourceId throws for an address outside the app', () => {
    expect(() => legacyNodeResourceId('shop', 'other.web', 'svc')).toThrow(
      'is not inside the app "shop"',
    );
  });

  test('legacyEnvVarId is the key and `-var`', () => {
    expect(legacyEnvVarId('COMPOSER_WEB_PORT')).toBe('COMPOSER_WEB_PORT-var');
  });

  test('legacyConfigKey builds the key from the address below the app, for both owners', () => {
    expect(legacyConfigKey('shop', 'shop.web', { owner: 'service', name: 'port' })).toBe(
      'COMPOSER_WEB_PORT',
    );
    expect(
      legacyConfigKey('my-shop', 'my-shop.auth.api', { owner: { input: 'db' }, name: 'url' }),
    ).toBe('COMPOSER_AUTH_API_DB_URL');
  });

  test("a module named like the app makes a node's new key equal another node's old key", () => {
    const port = { owner: 'service', name: 'port' } as const;
    // The upgrade deploy of such an app fails with a conflict on this key and deletes nothing (ADR-0057).
    expect(configKey('shop.x', port)).toBe(legacyConfigKey('shop', 'shop.shop.x', port));
    expect(configKey('shop.x', port)).toBe('COMPOSER_SHOP_X_PORT');
  });

  test('legacyInputKey is the input row key below the app', () => {
    expect(legacyInputKey('shop', 'shop.auth.api')).toBe('COMPOSER_AUTH_API_INPUT');
  });

  test('legacyGeneratedParamVarName is the generated leaf variable below the app', () => {
    expect(legacyGeneratedParamVarName('shop', 'shop.web', 'stripe.key')).toBe(
      'COMPOSER_WEB_STRIPE_KEY_GENERATED',
    );
  });

  test('legacyGeneratedParamId is the legacy input key, the path and `-generated`', () => {
    expect(legacyGeneratedParamId('shop', 'shop.web', 'secret')).toBe(
      'COMPOSER_WEB_INPUT:secret-generated',
    );
  });

  test('legacyServiceKeyId is named for the calling service and input', () => {
    expect(legacyServiceKeyId('shop', 'shop.web', 'auth')).toBe('servicekey-web.auth');
  });

  test('legacyStreamsKeyId is named for the provider', () => {
    expect(legacyStreamsKeyId('shop', 'shop.auth.events')).toBe('streamskey-auth.events');
  });

  test('fromLegacyId runs the resource under a RenamePolicy naming the legacy ID', () => {
    const policy = Effect.runSync(
      Effect.serviceOption(RenamePolicy).pipe(fromLegacyId('catalog-db')),
    );
    expect(Option.getOrUndefined(policy)).toEqual(['catalog-db']);
  });
});
