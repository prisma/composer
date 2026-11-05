import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type Graph, Load, module, paramSource, secretSource, service } from '@internal/core';
import { nodeAddresses, secretsKeys } from '@internal/core/deploy';
import {
  APP_CONFIGURATION_FILE_ENV,
  deployAppConfigurationFile,
  devAppConfigurationFile,
  LEFTOVER_APP_CONFIGURATION_FILE_AGE_MS,
  NAMED_SECRETS_ENV,
  namedSecretsFromEnvironment,
  prepareSecondProcess,
  readAppConfigurationFile,
  removeLeftoverAppConfigurationFiles,
} from '../app-configuration-file.ts';
import { KnownSecrets } from '../redaction.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const freshDir = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-configuration-file-'));
  dirs.push(dir);
  return dir;
};

const freshFile = (): string => path.join(freshDir(), 'app-configuration-1-run.json');

const anyInput = {
  '~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
} as const;

const echo = service({
  name: 'echo',
  extension: 'test/pack',
  type: 'fake/compute',
  inputs: {},
  params: {},
  input: anyInput,
  build: { extension: 'test/build', type: 'node', module: 'file:///echo.ts', entry: 'e.js' },
});

/** A root `shop` that passes on `EMAIL_FROM`, reads `APP_ORIGIN` as a configuration key, and names `STRIPE_KEY` as a secret. */
function shopGraph(
  configuration: Record<string, unknown>,
  transform: (input: Record<string, unknown>) => Record<string, unknown> = (input) => input,
): Graph {
  const schema = {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => ({ value: transform(value as Record<string, unknown>) }),
    },
  } as const;
  const root = module('shop', { input: schema }, ({ input, provision }) => {
    provision(echo, {
      input: {
        from: (input as never)['EMAIL_FROM'],
        origin: paramSource(
          {},
          { label: "envParam('APP_ORIGIN')", configurationKey: 'APP_ORIGIN' },
        ),
        key: secretSource({}, { label: "envSecret('STRIPE_KEY')", secretsKey: 'STRIPE_KEY' }),
      } as never,
    });
  });
  return Load(root, { configuration });
}

/** What `prepareSecondProcess` takes from `graph`. */
const factsOf = (graph: Graph) => ({
  appConfigurationRead: graph.appConfigurationRead,
  nodeAddresses: nodeAddresses(graph),
  secretsKeys: secretsKeys(graph),
});

const configuration = { EMAIL_FROM: 'shop@example.com', APP_ORIGIN: 'https://origin.example' };

const errorOf = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('expected an error');
};

describe('the app configuration file', () => {
  test('the file holds what Load read and the node addresses, as JSON readable only by its owner', () => {
    const file = freshFile();

    prepareSecondProcess({
      file,
      ...factsOf(shopGraph(configuration)),
      knownSecrets: new KnownSecrets(),
    }).writeFile();

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      appConfigurationRead: {
        rootInput: [{ path: ['EMAIL_FROM'], value: 'shop@example.com' }],
        configurationKeyText: { APP_ORIGIN: 'https://origin.example' },
      },
      nodeAddresses: ['shop', 'shop.echo'],
    });
  });

  test('a file already there is replaced, and gets mode 0600', () => {
    const file = freshFile();
    fs.writeFileSync(file, 'old', { mode: 0o644 });

    prepareSecondProcess({
      file,
      ...factsOf(shopGraph(configuration)),
      knownSecrets: new KnownSecrets(),
    }).writeFile();

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toBe('old');
  });

  test('removeFile deletes the file, and never throws when it is gone', () => {
    const file = freshFile();
    const handover = prepareSecondProcess({
      file,
      ...factsOf(shopGraph(configuration)),
      knownSecrets: new KnownSecrets(),
    });
    handover.writeFile();

    handover.removeFile();
    handover.removeFile();

    expect(fs.existsSync(file)).toBe(false);
  });

  test("the second process's environment names the file, and carries the named secrets only when the app secrets are given", () => {
    const file = freshFile();
    const facts = factsOf(shopGraph(configuration));

    expect(prepareSecondProcess({ file, ...facts, knownSecrets: new KnownSecrets() }).env).toEqual({
      [APP_CONFIGURATION_FILE_ENV]: file,
    });
    expect(
      prepareSecondProcess({
        file,
        ...facts,
        knownSecrets: new KnownSecrets(),
        appSecrets: { STRIPE_KEY: 'sk_test_1', OTHER: 'not named', EMPTY: '' },
      }).env,
    ).toEqual({
      [APP_CONFIGURATION_FILE_ENV]: file,
      [NAMED_SECRETS_ENV]: '{"STRIPE_KEY":"sk_test_1"}',
    });
  });

  const refusal = (graph: Graph, secret: string): Error => {
    const error = errorOf(() =>
      prepareSecondProcess({
        file: freshFile(),
        ...factsOf(graph),
        knownSecrets: new KnownSecrets([{ name: 'SHOP_SECRET', value: secret }]),
      }),
    );
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain(secret);
    return error;
  };
  const refusedBecause = (where: string) =>
    `${where} holds the value of the secret "SHOP_SECRET", which an envSecret() in the graph reads. Composer hands the second process every plain value Load read, in a file, and never writes a secret to a file.`;

  test('prepareSecondProcess refuses a file that would hold a known secret, naming where and never the secret', () => {
    const graph = shopGraph({ ...configuration, EMAIL_FROM: 'secret-text-77' });

    expect(refusal(graph, 'secret-text-77').message).toBe(
      refusedBecause('Root input field input.EMAIL_FROM'),
    );
  });

  test('prepareSecondProcess refuses a known secret inside a longer value, such as the password in a URL', () => {
    const graph = shopGraph({
      ...configuration,
      APP_ORIGIN: 'postgres://shop:secret-pw-77@db.example/shop',
    });

    expect(refusal(graph, 'secret-pw-77').message).toBe(
      refusedBecause('Configuration key "APP_ORIGIN"'),
    );
  });

  test("prepareSecondProcess refuses a root field the root's schema built around a known secret", () => {
    const graph = shopGraph({ ...configuration, TOKEN: 'secret-token-77' }, (input) => ({
      ...input,
      EMAIL_FROM: `Bearer ${String(input['TOKEN'])}`,
    }));

    expect(refusal(graph, 'secret-token-77').message).toBe(
      refusedBecause('Root input field input.EMAIL_FROM'),
    );
  });

  test("prepareSecondProcess refuses a number the root's schema made from a known secret", () => {
    const graph = shopGraph({ ...configuration, PIN: '987654321' }, (input) => ({
      ...input,
      EMAIL_FROM: Number(input['PIN']),
    }));

    expect(refusal(graph, '987654321').message).toBe(
      refusedBecause('Root input field input.EMAIL_FROM'),
    );
  });

  test('prepareSecondProcess looks for a known secret of eight characters or more inside a longer value, and for a shorter one only as the whole value', () => {
    const prepare = (emailFrom: string, secret: string) => () =>
      prepareSecondProcess({
        file: freshFile(),
        ...factsOf(shopGraph({ ...configuration, EMAIL_FROM: emailFrom })),
        knownSecrets: new KnownSecrets([{ name: 'SHOP_SECRET', value: secret }]),
      });

    expect(errorOf(prepare('x-8chars!-x@example.com', '8chars!-')).message).toBe(
      refusedBecause('Root input field input.EMAIL_FROM'),
    );
    expect(prepare('dev@example.com', 'dev-pw7')).not.toThrow();
    expect(prepare('dev@example.com', 'dev')).not.toThrow();
    expect(errorOf(prepare('dev', 'dev')).message).toBe(
      refusedBecause('Root input field input.EMAIL_FROM'),
    );
  });

  test('writeFile deletes the file when the process exits, and removeFile stops that', () => {
    const file = freshFile();
    const handover = prepareSecondProcess({
      file,
      ...factsOf(shopGraph(configuration)),
      knownSecrets: new KnownSecrets(),
    });
    const before = process.listeners('exit');

    handover.writeFile();
    handover.writeFile();
    const added = process.listeners('exit').filter((listener) => !before.includes(listener));
    expect(added).toHaveLength(1);
    added[0]?.(0);
    expect(fs.existsSync(file)).toBe(false);

    handover.removeFile();
    expect(process.listeners('exit')).toEqual(before);
  });

  test('readAppConfigurationFile reads back what was written', () => {
    const file = freshFile();
    const graph = shopGraph(configuration);
    prepareSecondProcess({ file, ...factsOf(graph), knownSecrets: new KnownSecrets() }).writeFile();

    expect(readAppConfigurationFile({ [APP_CONFIGURATION_FILE_ENV]: file })).toEqual({
      appConfigurationRead: graph.appConfigurationRead,
      nodeAddresses: ['shop', 'shop.echo'],
    });
  });

  test('readAppConfigurationFile names the variable when it is not set', () => {
    expect(errorOf(() => readAppConfigurationFile({})).message).toBe(
      'PRISMA_COMPOSER_APP_CONFIGURATION_FILE is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which names the app configuration file it wrote there.',
    );
  });

  test('readAppConfigurationFile says a file it cannot read is deleted when the run ends', () => {
    const file = freshFile();

    const message = errorOf(() =>
      readAppConfigurationFile({ [APP_CONFIGURATION_FILE_ENV]: file }),
    ).message;

    expect(message).toStartWith(`Could not read the app configuration file ${file}: `);
    expect(message).toEndWith('run the command again.');
  });

  test('readAppConfigurationFile refuses a file Composer did not write', () => {
    const file = freshFile();
    const env = { [APP_CONFIGURATION_FILE_ENV]: file };
    const refused = (contents: string) => {
      fs.writeFileSync(file, contents);
      return errorOf(() => readAppConfigurationFile(env)).message;
    };
    const read = (rootInput: unknown, configurationKeyText: unknown, addresses: unknown) =>
      JSON.stringify({
        appConfigurationRead: { rootInput, configurationKeyText },
        nodeAddresses: addresses,
      });
    const prefix = `The app configuration file ${file} is not one Composer wrote: `;

    expect(refused('not json')).toBe(`${prefix}it is not JSON.`);
    expect(refused('{"nodeAddresses":[]}')).toBe(`${prefix}appConfigurationRead is not an object.`);
    expect(refused(read({}, {}, []))).toBe(`${prefix}rootInput is not a list of fields.`);
    expect(refused(read([], { A: 1 }, []))).toBe(
      `${prefix}configurationKeyText is not an object of text.`,
    );
    expect(refused(read([], {}, {}))).toBe(
      `${prefix}nodeAddresses is not a list of node addresses.`,
    );
  });
});

describe('the named secrets', () => {
  test('namedSecretsFromEnvironment reads the object, and refuses one that is not text', () => {
    const secrets = namedSecretsFromEnvironment({ [NAMED_SECRETS_ENV]: '{"KEY":"text"}' });

    expect({ ...secrets }).toEqual({ KEY: 'text' });
    expect(Object.isFrozen(secrets)).toBe(true);
    expect(Object.getPrototypeOf(secrets)).toBeNull();
    expect(
      errorOf(() => namedSecretsFromEnvironment({ [NAMED_SECRETS_ENV]: '{"KEY":1}' })).message,
    ).toBe('PRISMA_COMPOSER_NAMED_SECRETS is not a JSON object of text.');
    expect(errorOf(() => namedSecretsFromEnvironment({})).message).toBe(
      'PRISMA_COMPOSER_NAMED_SECRETS is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which hands the secrets the local services need there.',
    );
  });
});

describe('files earlier runs left', () => {
  test('removeLeftoverAppConfigurationFiles deletes the old files of processes that are no longer running, in .prisma-composer and in each dev environment folder, and keeps the rest', () => {
    const cwd = freshDir();
    const ended = spawnSync(process.execPath, ['-e', '0']).pid;
    const devDir = path.join(cwd, '.prisma-composer', 'dev', 'dev');
    fs.mkdirSync(devDir, { recursive: true });
    const leftovers = [
      path.join(cwd, '.prisma-composer', `app-configuration-${String(ended)}-old-run.json`),
      path.join(devDir, `app-configuration-${String(ended)}.json`),
    ];
    const kept = [
      deployAppConfigurationFile(cwd, 'this-run'),
      devAppConfigurationFile(devDir),
      path.join(cwd, '.prisma-composer', `app-configuration-${String(process.ppid)}-running.json`),
      path.join(cwd, '.prisma-composer', 'deployment-result-1-x.json'),
    ];
    const old = new Date(Date.now() - LEFTOVER_APP_CONFIGURATION_FILE_AGE_MS - 60_000);
    for (const file of [...leftovers, ...kept]) {
      fs.writeFileSync(file, '{}');
      fs.utimesSync(file, old, old);
    }

    removeLeftoverAppConfigurationFiles(cwd);

    expect(leftovers.filter((file) => fs.existsSync(file))).toEqual([]);
    expect(kept.filter((file) => fs.existsSync(file))).toEqual(kept);
  });

  test('removeLeftoverAppConfigurationFiles keeps a recent file whose process is not running here, which may be a run in a container or on another machine', () => {
    const cwd = freshDir();
    const ended = spawnSync(process.execPath, ['-e', '0']).pid;
    const recent = path.join(cwd, '.prisma-composer', `app-configuration-${String(ended)}-x.json`);
    fs.mkdirSync(path.dirname(recent), { recursive: true });
    fs.writeFileSync(recent, '{}');

    removeLeftoverAppConfigurationFiles(cwd);

    expect(fs.existsSync(recent)).toBe(true);
  });

  test('removeLeftoverAppConfigurationFiles does nothing when there is no .prisma-composer folder', () => {
    expect(() => removeLeftoverAppConfigurationFiles(freshDir())).not.toThrow();
  });
});
