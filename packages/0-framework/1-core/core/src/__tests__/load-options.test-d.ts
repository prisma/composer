import { test } from 'vitest';
import { type AppConfigurationRead, Load, module } from '../exports/index.ts';

test('Load takes the app configuration or what the first process read, not both', () => {
  const root = module('shop', () => {});
  const configuration = {};
  const appConfigurationRead: AppConfigurationRead = { rootInput: [] };
  Load(root, { configuration });
  Load(root, { appConfigurationRead });
  // @ts-expect-error the first process passes configuration, the second appConfigurationRead
  Load(root, { configuration, appConfigurationRead });
});

test('what the first process read holds the root input only', () => {
  const read: AppConfigurationRead = {
    rootInput: [],
    // @ts-expect-error Load reads no configuration key, so there is no key text to record
    configurationKeyText: {},
  };
  void read;
});
