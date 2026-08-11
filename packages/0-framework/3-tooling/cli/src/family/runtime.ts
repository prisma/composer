/**
 * Everything environmental the engine needs, assembled from a host process.
 *
 * The engine takes no globals: streams, cwd, env, TTY-ness, exit and signal
 * subscription all arrive through `Runtime`, which is what lets a test drive a
 * whole run without touching `process`. Composing one is the substantive part
 * of hosting the engine — `createCli` and `Cli.run` are two calls.
 *
 * `credentialManager` is deliberately absent. The engine's own environment-only
 * manager (PRISMA_SERVICE_TOKEN / PRISMA_WORKSPACE_ID) ships in its next
 * release; until it does, leaving the field off means "this host has no
 * credentials", and every command that declares `needs.credentials` fails as
 * signed out. The skeleton declares none, so nothing is affected yet.
 */
import type { HostProcess, LoadedConfig, Runtime } from '@prisma/cli-engine';

/** Where the management API lives. Matches the lowering client's default origin; the env var is the escape hatch for staging. */
const DEFAULT_MANAGEMENT_API_BASE_URL = 'https://api.prisma.io';

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
    managementApi: {
      baseUrl: env['PRISMA_MANAGEMENT_API_URL'] ?? DEFAULT_MANAGEMENT_API_BASE_URL,
    },
    packageManager: detectPackageManager(env),
  };
}
