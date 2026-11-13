#!/usr/bin/env bun
/**
 * After a real deploy, runs `deploy list --json` for the app in the current
 * directory and checks its output against the topology and rows the platform
 * holds for the environment.
 *
 * The installed `prisma` does not mount `deploy list` yet, so this mounts
 * Composer's command family itself, the way the `prisma` host does, with a
 * service-token credential and no OAuth login. It mounts every command of the
 * family with the `deploy`, `dev` and `emulator` groups, because the family's flag
 * redirects name `deploy`, `dev` and `dev stop`, and the engine refuses a flag
 * redirect whose command is not mounted. It also declares the ORM's config
 * section, so a config with an `orm` section loads.
 *
 * Env: STACK_NAME (the `prisma deploy --name` value), PRISMA_SERVICE_TOKEN,
 * PRISMA_WORKSPACE_ID, and ENVIRONMENT (default production).
 */

import {
  createCli,
  defineCommandFamily,
  EnvironmentCredentialManager,
  loadConfig,
} from '@prisma/cli-engine';
import { createComposerFamily } from '@prisma/composer-cli/family';
import { ormConfigSection } from '@prisma/orm-toolchain/cli';
import { deployListMismatches, parseListed } from './deploy-list-check.ts';
import { logPlatformState, readPlatformState } from './platform-state.ts';

const stackName = process.env['STACK_NAME'];
const workspaceId = process.env['PRISMA_WORKSPACE_ID'];
const environment = process.env['ENVIRONMENT'] || 'production';
if (!stackName || !workspaceId) {
  console.error('STACK_NAME and PRISMA_WORKSPACE_ID are required');
  process.exit(1);
}

const apiBaseUrl = process.env['PRISMA_MANAGEMENT_API_URL']?.trim() || 'https://api.prisma.io';

async function runDeployList(args: readonly string[]): Promise<string> {
  const family = createComposerFamily();
  if (family.commands['deploy list'] === undefined) {
    throw new Error('the Composer command family has no deploy list');
  }
  const cli = createCli({
    name: 'prisma',
    version: '0.0.0',
    commandFamilies: [
      family,
      defineCommandFamily({ configSection: ormConfigSection, commands: {} }),
    ],
    groups: {
      deploy: { brief: 'Deploy the app.' },
      dev: { brief: 'Run the app on this machine.' },
      emulator: { brief: 'The local emulators on this machine.' },
    },
    commands: family.commands,
  });

  let stdout = '';
  const cwd = process.cwd();
  const exitCode = await cli.run(['deploy', 'list', ...args], {
    stdout: {
      write: (text) => {
        stdout += text;
      },
    },
    stderr: { write: (text) => process.stderr.write(text) },
    stdin: (async function* () {})(),
    cwd,
    env: process.env,
    isTty: { stdin: false, stdout: false, stderr: false },
    exit: (code) => process.exit(code),
    onSignal: () => () => {},
    loadConfig: (configPath) => loadConfig(cwd, configPath),
    credentialManager: new EnvironmentCredentialManager({ env: process.env }),
    managementApiClientConfig: {
      clientId: '',
      redirectUri: '',
      apiBaseUrl,
      authBaseUrl: process.env['PRISMA_AUTH_BASE_URL']?.trim() || 'https://auth.prisma.io',
    },
    managementApi: { baseUrl: apiBaseUrl },
    host: {
      runtime: { name: 'bun', version: Bun.version },
      platform: process.platform,
      arch: process.arch,
    },
  });
  console.log(`deploy list ${args.join(' ')} exited ${String(exitCode)}:\n${stdout}`);
  if (exitCode !== 0) process.exit(1);
  return stdout;
}

const stdout = await runDeployList(['--name', stackName, '--environment', environment, '--json']);
const listed = parseListed(JSON.parse(stdout.trim().split('\n').at(-1) ?? ''));

const state = await readPlatformState({ workspaceId, appName: stackName, environment });
logPlatformState(state);

const problems = deployListMismatches(listed, state);
if (problems.length > 0) {
  console.error(`deploy list disagrees with the platform:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('deploy list shows every topology node with its platform ID and URL.');
