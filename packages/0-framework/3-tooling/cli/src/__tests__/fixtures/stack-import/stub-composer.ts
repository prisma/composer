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
        'export const lower = (app, config, opts) => { console.log(JSON.stringify({ app: app.name, extensions: config.extensions.map((e) => e.id), state: config.state.extension, environment: opts.environment, configPool: opts.configPool, ...(globalThis.stubPools === undefined ? {} : { pools: globalThis.stubPools }) })); return {}; };',
      ),
    );
    build.module(
      '@prisma/composer/report',
      js('export const deploymentReport = () => {}; export const captureEngineFailure = () => {};'),
    );
    build.module(
      '@prisma/composer/config',
      js(
        "export const deserializeContainers = () => new Map(); export const readConfigPool = async (section, input) => ({ read: 'config', environment: input.environment, configFile: input.configFile }); export const readSecretsPool = async () => ({ read: 'secrets' });",
      ),
    );
    build.module(
      '@prisma/composer/local-target',
      js(
        "export const devEnvironmentDir = (environment) => '.dev/' + environment; export const devState = () => ({}); export const localTargetProviders = (resolved, containers, devDir, pools) => { globalThis.stubPools = pools; return {}; }; export const resolveLocalTargets = async () => new Map();",
      ),
    );
  },
});
