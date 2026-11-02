import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  APP_SECRETS_ENV,
  appSecretsFromEnvironment,
  CONFIGURATION_FILE_ENV,
  NODE_ADDRESSES_ENV,
  readCheckedConfiguration,
  secondProcessEnvironment,
  writeConfigurationFile,
} from '../configuration-file.ts';

const freshFile = (): string =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'configuration-file-')), 'configuration.json');

const checked = {
  rootInput: [{ path: ['EMAIL_FROM'], value: 'shop@example.com' }, { path: ['OPTIONAL'] }],
  values: { APP_ORIGIN: 'https://origin.example' },
};

const errorMessage = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected an error');
};

describe('the configuration file', () => {
  test('the configuration file is JSON readable only by its owner', () => {
    const file = freshFile();

    writeConfigurationFile(file, checked);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(checked);
  });

  test('a file already there is replaced, and gets mode 0600', () => {
    const file = freshFile();
    fs.writeFileSync(file, 'old', { mode: 0o644 });

    writeConfigurationFile(file, checked);

    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(checked);
  });

  test('readCheckedConfiguration reads back what was written, with the node addresses', () => {
    const file = freshFile();
    writeConfigurationFile(file, checked);

    const read = readCheckedConfiguration({
      [CONFIGURATION_FILE_ENV]: file,
      [NODE_ADDRESSES_ENV]: JSON.stringify(['shop', 'shop.web']),
    });

    expect(read).toEqual({ configuration: checked, nodeAddresses: ['shop', 'shop.web'] });
    expect('value' in (read.configuration.rootInput[1] ?? {})).toBe(false);
  });

  test('readCheckedConfiguration names the variable when it is not set', () => {
    expect(errorMessage(() => readCheckedConfiguration({}))).toBe(
      'PRISMA_COMPOSER_CONFIGURATION_FILE is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which names the configuration file it wrote there.',
    );
    const file = freshFile();
    writeConfigurationFile(file, checked);
    expect(errorMessage(() => readCheckedConfiguration({ [CONFIGURATION_FILE_ENV]: file }))).toBe(
      'PRISMA_COMPOSER_NODE_ADDRESSES is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which lists the node addresses it checked there.',
    );
    expect(
      errorMessage(() =>
        readCheckedConfiguration({ [CONFIGURATION_FILE_ENV]: file, [NODE_ADDRESSES_ENV]: '{}' }),
      ),
    ).toBe('PRISMA_COMPOSER_NODE_ADDRESSES is not a JSON list of node addresses.');
  });

  test('readCheckedConfiguration says a file it cannot read is deleted when the run ends', () => {
    const file = freshFile();

    const message = errorMessage(() =>
      readCheckedConfiguration({ [CONFIGURATION_FILE_ENV]: file, [NODE_ADDRESSES_ENV]: '[]' }),
    );

    expect(message).toStartWith(`Could not read the configuration file ${file}: `);
    expect(message).toEndWith('run the command again.');
  });

  test('readCheckedConfiguration refuses a file Composer did not write', () => {
    const file = freshFile();
    const env = { [CONFIGURATION_FILE_ENV]: file, [NODE_ADDRESSES_ENV]: '[]' };

    fs.writeFileSync(file, '{"rootInput":{}}');
    expect(errorMessage(() => readCheckedConfiguration(env))).toBe(
      `The configuration file ${file} is not one Composer wrote: rootInput is not a list of fields.`,
    );
    fs.writeFileSync(file, 'not json');
    expect(errorMessage(() => readCheckedConfiguration(env))).toBe(
      `The configuration file ${file} is not one Composer wrote: it is not JSON.`,
    );
    fs.writeFileSync(file, '{"rootInput":[],"values":{"A":1}}');
    expect(errorMessage(() => readCheckedConfiguration(env))).toBe(
      `The configuration file ${file} is not one Composer wrote: values is not an object of text.`,
    );
  });
});

describe("the second process's environment", () => {
  test('secondProcessEnvironment names the file and the node addresses, and the app secrets only when given', () => {
    expect(
      secondProcessEnvironment({ configurationFile: '/app/c.json', nodeAddresses: ['shop'] }),
    ).toEqual({
      [CONFIGURATION_FILE_ENV]: '/app/c.json',
      [NODE_ADDRESSES_ENV]: '["shop"]',
    });
    expect(
      secondProcessEnvironment({
        configurationFile: '/app/c.json',
        nodeAddresses: ['shop'],
        secrets: { KEY: 'value' },
      }),
    ).toEqual({
      [CONFIGURATION_FILE_ENV]: '/app/c.json',
      [NODE_ADDRESSES_ENV]: '["shop"]',
      [APP_SECRETS_ENV]: '{"KEY":"value"}',
    });
  });

  test('appSecretsFromEnvironment reads the object, and refuses one that is not text', () => {
    const secrets = appSecretsFromEnvironment({ [APP_SECRETS_ENV]: '{"KEY":"value"}' });

    expect({ ...secrets }).toEqual({ KEY: 'value' });
    expect(Object.isFrozen(secrets)).toBe(true);
    expect(Object.getPrototypeOf(secrets)).toBeNull();
    expect(errorMessage(() => appSecretsFromEnvironment({ [APP_SECRETS_ENV]: '{"KEY":1}' }))).toBe(
      'PRISMA_COMPOSER_APP_SECRETS is not a JSON object of text.',
    );
    expect(errorMessage(() => appSecretsFromEnvironment({}))).toBe(
      'PRISMA_COMPOSER_APP_SECRETS is not set. This stack file runs as the second process of a Composer deploy, destroy or prisma dev, which hands the app secrets the local services need there.',
    );
  });
});
