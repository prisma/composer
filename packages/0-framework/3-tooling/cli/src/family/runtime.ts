/**
 * Everything environmental the engine needs, assembled from a host process.
 *
 * The engine takes no globals: streams, cwd, env, TTY-ness, exit and signal
 * subscription all arrive through `Runtime`, which is what lets a test drive a
 * whole run without touching `process`. Composing one is the substantive part
 * of hosting the engine — `createCli` and `Cli.run` are two calls.
 *
 * Credentials come from the engine's own environment-only manager, which
 * composes a session from PRISMA_SERVICE_TOKEN / PRISMA_WORKSPACE_ID and
 * refuses every mutation. That is the whole of composer's standalone auth
 * story: this CLI has no login flow and mounts no auth commands, so there is
 * nothing to store — the two variables ARE the credential.
 */
import { spawn } from 'node:child_process';
import {
  EnvironmentCredentialManager,
  type HostProcess,
  type LoadedConfig,
  type ManagementApiClientConfig,
  type Runtime,
  type SpawnChild,
} from '@prisma/cli-engine';

/** Where the management API lives. Matches the lowering client's default origin; the env var is the escape hatch for staging. */
const DEFAULT_MANAGEMENT_API_BASE_URL = 'https://api.prisma.io';
const DEFAULT_AUTH_BASE_URL = 'https://auth.prisma.io';

/**
 * Starts the converge child: inherited stdio, this process's own group, no
 * `detached` and no new console — which is what lets the terminal deliver
 * Ctrl-C to the child natively instead of the CLI forwarding it. The engine
 * never imports node:child_process; this adapter is the whole of the host's
 * side of that seam.
 */
const spawnChild: SpawnChild = (request) => {
  const child = spawn(request.command, [...request.args], {
    cwd: request.cwd,
    stdio: 'inherit',
    env: request.env,
  });
  return {
    ended: new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (exitCode, signal) => {
        resolve({ exitCode, signal });
      });
    }),
    kill: (signal) => {
      child.kill(signal);
    },
  };
};

/**
 * The SDK's client construction config. The engine requires all four fields
 * whenever a credential manager is wired, but this host reaches none of the
 * login paths: an environment credential carries no refresh token, so nothing
 * ever refreshes and `clientId`/`redirectUri` are never read. They are
 * env-overridable rather than hard-coded so a staging run can point the whole
 * client somewhere else in one place.
 */
function clientConfig(
  env: Readonly<Record<string, string | undefined>>,
  apiBaseUrl: string,
): ManagementApiClientConfig {
  return {
    clientId: env['PRISMA_CLIENT_ID'] ?? 'prisma-composer-cli',
    redirectUri: env['PRISMA_REDIRECT_URI'] ?? 'http://127.0.0.1/callback',
    apiBaseUrl,
    authBaseUrl: env['PRISMA_AUTH_URL'] ?? DEFAULT_AUTH_BASE_URL,
  };
}

type PackageManager = Runtime['packageManager'];

/**
 * Which package manager invoked us, read from the `npm_config_user_agent`
 * every major manager sets (`pnpm/10.27.0 npm/? node/v24.16.0 darwin arm64`).
 * `unknown` when the CLI was run directly rather than through a manager — a
 * normal case, not a failure, so nothing is inferred from the filesystem.
 */
export function detectPackageManager(
  env: Readonly<Record<string, string | undefined>>,
): PackageManager {
  const agent = env['npm_config_user_agent'];
  if (agent === undefined) return 'unknown';
  const name = agent.split('/')[0];
  switch (name) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun':
      return name;
    default:
      return 'unknown';
  }
}

export function createRuntime(host: HostProcess, config: LoadedConfig): Runtime {
  const env = host.env;
  const apiBaseUrl = env['PRISMA_MANAGEMENT_API_URL'] ?? DEFAULT_MANAGEMENT_API_BASE_URL;
  return {
    stdout: host.stdout,
    stderr: host.stderr,
    stdin: host.stdin,
    cwd: host.cwd(),
    env,
    isTty: {
      stdin: host.stdin.isTTY === true,
      stdout: host.stdout.isTTY === true,
      stderr: host.stderr.isTTY === true,
    },
    exit: (code) => host.exit(code),
    onSignal: (cb) => {
      const onSigint = (): void => {
        cb('SIGINT');
      };
      const onSigterm = (): void => {
        cb('SIGTERM');
      };
      host.on('SIGINT', onSigint);
      host.on('SIGTERM', onSigterm);
      return () => {
        host.off('SIGINT', onSigint);
        host.off('SIGTERM', onSigterm);
      };
    },
    config,
    credentialManager: new EnvironmentCredentialManager({ env }),
    managementApiClientConfig: clientConfig(env, apiBaseUrl),
    spawn: spawnChild,
    managementApi: { baseUrl: apiBaseUrl },
    packageManager: detectPackageManager(env),
  };
}
