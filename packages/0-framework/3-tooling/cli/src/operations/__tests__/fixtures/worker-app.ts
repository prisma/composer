/**
 * An app on disk for `prisma dev`'s converge worker. Its `prisma.config.ts`
 * has one extension that lowers a resource by appending the resource's
 * `label` and the working directory to `seen.txt`; the config imports a
 * sibling `.ts` file by a `.js` specifier. The entry takes the label from
 * `label.ts` and provisions a service that deploys nothing. Its
 * `@prisma/composer` install re-exports this package's own converge entry
 * from source.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { HOST_COMPOSER_VERSION } from '../../../app-converge.ts';
import type { DevConvergeJob } from '../../dev-converge.ts';

const SOURCE = path.resolve(import.meta.dirname, '..', '..', '..');

const url = (specifier: string): string => JSON.stringify(import.meta.resolve(specifier));

const fileUrl = (file: string): string => JSON.stringify(pathToFileURL(file).href);

const RECORD = `import * as fs from 'node:fs';
import * as path from 'node:path';

export const record = (line: string): void =>
  fs.appendFileSync(path.join(process.cwd(), 'seen.txt'), line + '\\n');
`;

const CONFIG = `import { log } from 'node:console';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Effect from ${url('effect/Effect')};
import * as Layer from ${url('effect/Layer')};
import { record } from './record.js';

const container = { input: { appName: 'shop', environment: 'dev' }, serialize: () => 'dev' };
const attachment = {
  startServices: async () => {},
  stopApp: async () => {},
  endpoints: async () => [],
  logs: async function* () {},
};

const printEverywhere = (token) => {
  console.log('log ' + token);
  console.dir({ dir: token });
  console.table([{ table: token }]);
  console.count('count ' + token);
  console.assert(false, 'assert ' + token);
  process.emitWarning('warning ' + token);
  log('named ' + token);
  if (typeof console.write === 'function') console.write('write ' + token + '\\n');
  for (const name of ['timeStamp', 'profile', 'profileEnd']) console[name]('quiet ' + token);
  if (typeof console.createTask === 'function') {
    console.createTask('quiet ' + token).run(() => console.log('createTask ' + token));
  }
};

const thing = Object.assign(
  (ctx) => {
    const { label } = ctx.node.props;
    const token = process.env.FIXTURE_API_TOKEN;
    if (label === 'exit') process.exit(7);
    if (label === 'print') console.log('the token is ' + token);
    if (label === 'print-all') printEverywhere(token);
    if (label === 'throw-later') {
      setTimeout(() => {
        throw new Error('thrown outside the converge');
      }, 0);
      return Effect.never;
    }
    if (label === 'fail') return Effect.fail(new Error('the thing refused'));
    if (label === 'block' || label === 'stubborn') {
      const blocked = Effect.sync(() => record('blocking')).pipe(Effect.andThen(Effect.never));
      return label === 'stubborn' ? Effect.uninterruptible(blocked) : blocked;
    }
    return Effect.sync(() => {
      record(label + ' ' + process.cwd());
      return { outputs: {}, entities: [] };
    });
  },
  { kind: 'resource' },
);

const variable = Object.assign(() => Effect.succeed({ outputs: {}, entities: [] }), {
  kind: 'resource',
});

const done = () => Effect.succeed({});
const web = {
  kind: 'service',
  provision: done,
  serialize: done,
  package: done,
  deploy: () => Effect.succeed({ outputs: {}, entities: [] }),
};
const bundle = { dir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist'), entry: 'server.js' };

export default {
  composer: {
    extensions: [
      {
        id: 'fixture-extension',
        nodes: { 'fake/thing': thing, 'fake/web': web, 'fake/variable': variable },
        localTarget: async () => ({
          providers: () => Layer.empty,
          container: {
            ensure: async () => container,
            locate: async () => container,
            remove: async () => {},
            deserialize: () => container,
          },
          attach: async () => attachment,
        }),
      },
      { id: 'fixture-build', nodes: { node: { kind: 'build', assemble: async () => bundle } } },
    ],
    state: { extension: 'fixture-extension', create: () => Layer.empty },
  },
};
`;

export interface EntryShape {
  /** The resources, each with `label.ts`'s label. */
  readonly ids?: readonly string[];
  /** Whether the service reads the platform variable `SMTP_PORT`. */
  readonly readsVariable?: boolean;
  /** A field of the root's input the root passes on to the service. */
  readonly passesOn?: string;
}

/** The entry's source. */
export function entrySource(shape: EntryShape = {}): string {
  const ids = shape.ids ?? ['thing'];
  return [
    `import { appRoot, paramSource, resource, service, valueResource } from ${url('@internal/core')};`,
    "import { label } from './label.ts';",
    '',
    shape.passesOn === undefined
      ? "export default appRoot('shop', ({ provision }) => {"
      : "export default appRoot('shop', { input: { '~standard': { version: 1, vendor: 'fixture', validate: (value) => ({ value }) } } }, ({ input, provision }) => {",
    ...ids.map(
      (id) =>
        `  provision(resource({ name: ${JSON.stringify(id)}, extension: 'fixture-extension', type: 'fake/thing', props: { label } }), { id: ${JSON.stringify(id)} });`,
    ),
    ...(shape.readsVariable === true
      ? [
          "  const port = provision(valueResource({ name: 'smtp-port', extension: 'fixture-extension', type: 'fake/variable', props: { name: 'SMTP_PORT' }, value: paramSource({ name: 'SMTP_PORT' }, { label: 'the variable SMTP_PORT' }) }), { id: 'smtpPort' });",
        ]
      : []),
    "  const web = service({ name: 'web', extension: 'fixture-extension', type: 'fake/web', inputs: {}, params: {}, input: { '~standard': { version: 1, vendor: 'fixture', validate: (value) => ({ value }) } }, build: { extension: 'fixture-build', type: 'node', module: import.meta.url, entry: 'dist/server.js' } });",
    shape.readsVariable === true
      ? "  provision(web, { id: 'web', input: { port } });"
      : shape.passesOn !== undefined
        ? `  provision(web, { id: 'web', input: { passed: input[${JSON.stringify(shape.passesOn)}] } });`
        : "  provision(web, { id: 'web', input: {} });",
    '});',
    '',
  ].join('\n');
}

export interface WorkerApp {
  readonly dir: string;
  readonly configFile: string;
  readonly entry: string;
  readonly labelFile: string;
  /** Sets the label the next converge's import reads. */
  label(label: string): void;
  /** The lines the lowering appended to `seen.txt`. */
  seen(): readonly string[];
}

export function makeWorkerApp(label = 'v1'): WorkerApp {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'composer-dev-worker-')));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'shop', type: 'module' }),
  );
  const composer = path.join(dir, 'node_modules', '@prisma', 'composer');
  fs.mkdirSync(composer, { recursive: true });
  fs.writeFileSync(
    path.join(composer, 'package.json'),
    JSON.stringify({
      name: '@prisma/composer',
      version: HOST_COMPOSER_VERSION,
      type: 'module',
      exports: {
        './internal/converge': './converge.mjs',
        './internal/converge-contract': './contract.mjs',
        './package.json': './package.json',
      },
    }),
  );
  fs.writeFileSync(
    path.join(composer, 'converge.mjs'),
    `export * from ${fileUrl(path.join(SOURCE, 'exports', 'converge.ts'))};\n`,
  );
  fs.writeFileSync(
    path.join(composer, 'contract.mjs'),
    `export * from ${fileUrl(path.join(SOURCE, 'exports', 'converge-contract.ts'))};\n`,
  );
  fs.writeFileSync(path.join(dir, 'record.ts'), RECORD);
  const configFile = path.join(dir, 'prisma.config.ts');
  fs.writeFileSync(configFile, CONFIG);
  const entry = path.join(dir, 'module.ts');
  fs.writeFileSync(entry, entrySource());
  const labelFile = path.join(dir, 'label.ts');
  const app: WorkerApp = {
    dir,
    configFile,
    entry,
    labelFile,
    label: (next) => fs.writeFileSync(labelFile, `export const label = ${JSON.stringify(next)};\n`),
    seen: () => {
      const file = path.join(dir, 'seen.txt');
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : [];
    },
  };
  app.label(label);
  return app;
}

/** The job the session would hand the worker for `app`, run from `cwd`. */
export function jobFor(app: WorkerApp, cwd: string = app.dir): DevConvergeJob {
  return {
    configFile: app.configFile,
    entry: app.entry,
    appDir: app.dir,
    cwd,
    name: 'shop',
    environment: 'dev',
    appConfigurationRead: { rootInput: [] },
    bundles: { 'shop.web': { dir: path.join(app.dir, 'dist'), entry: 'server.js' } },
    unassembled: [],
    containers: { 'fixture-extension': 'dev' },
    preflightPayloads: {},
    devDir: path.join(app.dir, '.prisma-composer', 'dev', 'dev'),
    plainVariableText: {},
    namedSecrets: {},
    nodeAddresses: ['shop', 'shop.thing', 'shop.web'],
    valueReads: { reads: [], props: {} },
  };
}
