/**
 * Preloaded into the child that runs a generated stack file. It stands in for
 * the modules the stack imports from @prisma/composer, and its
 * `lower` prints what it was given, so the test sees the config the stack's
 * `prisma.config.ts` import produced.
 */
import { plugin } from 'bun';

const js = (contents: string) => () => ({ contents, loader: 'js' as const });

plugin({
  name: 'stub-composer',
  setup(build) {
    build.module(
      '@prisma/composer/deploy',
      js(
        'export const lower = (app, config, opts) => { console.log(JSON.stringify({ app: app.name, extensions: config.extensions.map((e) => e.id), state: config.state.extension, environment: opts.environment, appConfigurationRead: opts.appConfigurationRead, firstProcessNodeAddresses: opts.firstProcessNodeAddresses, ...(globalThis.stubLocal === undefined ? {} : { local: globalThis.stubLocal }) })); return {}; }; export const transportedLowerInputs = () => ({ containers: new Map(), preflight: new Map() });',
      ),
    );
    build.module(
      '@prisma/composer/report',
      js('export const deploymentReport = () => {}; export const captureEngineFailure = () => {};'),
    );
    build.module(
      '@prisma/composer/internal/app-configuration-file',
      js(
        "export const readAppConfigurationFile = () => ({ appConfigurationRead: { rootInput: [], configurationKeyText: { read: 'from-file' } }, nodeAddresses: ['stub-address'] }); export const namedSecretsFromEnvironment = () => ({ read: 'secrets' });",
      ),
    );
    build.module(
      '@prisma/composer/local-target',
      js(
        "export const devEnvironmentDir = (environment) => '.dev/' + environment; export const devState = () => ({}); export const localTargetProviders = (resolved, containers, devDir, configurationKeyText, namedSecrets) => { globalThis.stubLocal = { configurationKeyText, namedSecrets }; return {}; }; export const resolveLocalTargets = async () => new Map();",
      ),
    );
  },
});
