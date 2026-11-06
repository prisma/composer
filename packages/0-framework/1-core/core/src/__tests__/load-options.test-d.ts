import { test } from 'vitest';
import { type AppConfigurationRead, Load, module } from '../exports/index.ts';

test('Load takes the app configuration or what the first process read, not both', () => {
  const root = module('shop', () => {});
  const configuration = {};
  const appConfigurationRead: AppConfigurationRead = { rootInput: [], configurationKeyText: {} };
  Load(root, { configuration });
  Load(root, { appConfigurationRead });
  // @ts-expect-error the first process passes configuration, the second appConfigurationRead
  Load(root, { configuration, appConfigurationRead });
});
