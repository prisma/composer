import { test } from 'vitest';
import { type AppConfigurationRead, Load, module } from '../exports/index.ts';

test('Load takes the app configuration or what an earlier Load read, not both', () => {
  const root = module('shop', () => {});
  const configuration = {};
  const appConfigurationRead: AppConfigurationRead = { rootInput: [] };
  Load(root, { configuration });
  Load(root, { appConfigurationRead });
  // @ts-expect-error the first Load passes configuration, a later one appConfigurationRead
  Load(root, { configuration, appConfigurationRead });
});

test('what an earlier Load read holds the root input only', () => {
  const read: AppConfigurationRead = {
    rootInput: [],
    // @ts-expect-error Load reads no configuration key, so there is no key text to record
    configurationKeyText: {},
  };
  void read;
});
