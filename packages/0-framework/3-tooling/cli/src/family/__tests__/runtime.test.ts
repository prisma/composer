/**
 * The Runtime composer. The engine reads nothing from `process` itself, so
 * everything environmental is what this module puts on the Runtime — which
 * makes these assertions the only thing standing between a wrong field and a
 * CLI that misreports its TTY, leaks signal listeners, or never exits.
 */
import { describe, expect, test } from 'bun:test';
import type { HostProcess, LoadedConfig } from '@prisma/cli-engine';
import { createRuntime, detectPackageManager } from '../runtime.ts';

const noConfig = (): Promise<LoadedConfig> =>
  Promise.resolve({ path: '/app/prisma.config.ts', sections: {}, diagnostics: [] });

interface FakeHost extends HostProcess {
  readonly listeners: Map<string, Set<() => void>>;
  readonly out: string[];
  readonly err: string[];
  readonly exits: number[];
}

function fakeHost(
  overrides: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    isTty?: { stdin?: boolean; stdout?: boolean; stderr?: boolean };
    versions?: Record<string, string | undefined>;
  } = {},
): FakeHost {
  const listeners = new Map<string, Set<() => void>>();
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  return {
    listeners,
    out,
    err,
    exits,
    argv: [],
    env: overrides.env ?? {},
    version: 'v24.0.0',
    versions: overrides.versions ?? { node: '24.0.0' },
    platform: 'linux',
    arch: 'x64',
    cwd: () => overrides.cwd ?? '/app',
    stdout: {
      write: (text: string) => out.push(text),
      ...(overrides.isTty?.stdout === undefined ? {} : { isTTY: overrides.isTty.stdout }),
    },
    stderr: {
      write: (text: string) => err.push(text),
      ...(overrides.isTty?.stderr === undefined ? {} : { isTTY: overrides.isTty.stderr }),
    },
    stdin: {
      ...(overrides.isTty?.stdin === undefined ? {} : { isTTY: overrides.isTty.stdin }),
      [Symbol.asyncIterator]: async function* () {
        // No input; the iterator ends immediately.
      },
    },
    on: (event, listener) => {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    off: (event, listener) => {
      listeners.get(event)?.delete(listener);
    },
    exit: (code: number) => {
      exits.push(code);
      throw new Error(`exit(${String(code)})`);
    },
  };
}

describe('detectPackageManager()', () => {
  test('reads the manager out of npm_config_user_agent', () => {
    for (const [agent, expected] of [
      ['pnpm/10.27.0 npm/? node/v24.16.0 darwin arm64', 'pnpm'],
      ['npm/11.0.0 node/v24.16.0 linux x64', 'npm'],
      ['yarn/4.5.0 npm/? node/v24.16.0', 'yarn'],
      ['bun/1.3.13 npm/? node/v24.16.0', 'bun'],
      ['deno/2.0.0', 'deno'],
    ] as const) {
      expect(detectPackageManager({ npm_config_user_agent: agent })).toBe(expected);
    }
  });

  test('a direct invocation reports nothing, so the engine detects it instead', () => {
    expect(detectPackageManager({})).toBeUndefined();
    expect(detectPackageManager({ npm_config_user_agent: 'corepack/0.30.0' })).toBeUndefined();
  });
});

/**
 * CI-ness is no longer composer's to answer: the engine detects it from `env`
 * itself, and `isCIOverride` exists only for hosts where that detection cannot
 * be right. A Runtime that set the override would silence the engine's own
 * detection, so absence is the asserted behavior.
 */
describe('createRuntime() CI reporting', () => {
  test('no CI override is set — the engine detects CI from env itself', () => {
    expect(createRuntime(fakeHost(), noConfig).isCIOverride).toBeUndefined();
  });
});

describe('createRuntime() host description', () => {
  test('reports platform, arch and the Node runtime from the host process', () => {
    expect(createRuntime(fakeHost(), noConfig).host).toEqual({
      runtime: { name: 'node', version: '24.0.0' },
      platform: 'linux',
      arch: 'x64',
    });
  });

  test('a runtime that announces itself in versions names itself', () => {
    const host = fakeHost({ versions: { node: '24.0.0', bun: '1.3.13' } });
    expect(createRuntime(host, noConfig).host.runtime).toEqual({
      name: 'bun',
      version: '1.3.13',
    });
  });
});

describe('createRuntime()', () => {
  test('carries cwd, env and streams from the host', () => {
    const host = fakeHost({ cwd: '/some/app', env: { FOO: 'bar' } });
    const runtime = createRuntime(host, noConfig);
    expect(runtime.cwd).toBe('/some/app');
    expect(runtime.env).toEqual({ FOO: 'bar' });
    runtime.stdout.write('hello');
    runtime.stderr.write('oops');
    expect(host.out).toEqual(['hello']);
    expect(host.err).toEqual(['oops']);
  });

  test('a missing isTTY reads as not a TTY, never as undefined', () => {
    const runtime = createRuntime(fakeHost(), noConfig);
    expect(runtime.isTty).toEqual({ stdin: false, stdout: false, stderr: false });
  });

  test('isTTY comes through per stream', () => {
    const runtime = createRuntime(
      fakeHost({ isTty: { stdin: false, stdout: true, stderr: true } }),
      noConfig,
    );
    expect(runtime.isTty).toEqual({ stdin: false, stdout: true, stderr: true });
  });

  test('onSignal subscribes to both signals and the returned function unsubscribes both', () => {
    const host = fakeHost();
    const runtime = createRuntime(host, noConfig);
    const seen: string[] = [];
    const unsubscribe = runtime.onSignal((signal) => seen.push(signal));

    expect(host.listeners.get('SIGINT')?.size).toBe(1);
    expect(host.listeners.get('SIGTERM')?.size).toBe(1);

    for (const listener of host.listeners.get('SIGINT') ?? []) listener();
    for (const listener of host.listeners.get('SIGTERM') ?? []) listener();
    expect(seen).toEqual(['SIGINT', 'SIGTERM']);

    unsubscribe();
    expect(host.listeners.get('SIGINT')?.size).toBe(0);
    expect(host.listeners.get('SIGTERM')?.size).toBe(0);
  });

  test('two subscriptions are independent — unsubscribing one leaves the other', () => {
    const host = fakeHost();
    const runtime = createRuntime(host, noConfig);
    const first = runtime.onSignal(() => undefined);
    runtime.onSignal(() => undefined);
    first();
    expect(host.listeners.get('SIGINT')?.size).toBe(1);
  });

  test('exit reaches the host', () => {
    const host = fakeHost();
    const runtime = createRuntime(host, noConfig);
    expect(() => runtime.exit(2)).toThrow();
    expect(host.exits).toEqual([2]);
  });

  test('the management API base url defaults to the platform, and the env overrides it', () => {
    expect(createRuntime(fakeHost(), noConfig).managementApi.baseUrl).toBe('https://api.prisma.io');
    expect(
      createRuntime(
        fakeHost({ env: { PRISMA_MANAGEMENT_API_URL: 'https://api.staging.invalid' } }),
        noConfig,
      ).managementApi.baseUrl,
    ).toBe('https://api.staging.invalid');
  });

  test('PRISMA_API_URL wins over PRISMA_MANAGEMENT_API_URL — the same precedence every other client uses', () => {
    expect(
      createRuntime(
        fakeHost({
          env: {
            PRISMA_API_URL: 'https://api.first.invalid',
            PRISMA_MANAGEMENT_API_URL: 'https://api.second.invalid',
          },
        }),
        noConfig,
      ).managementApi.baseUrl,
    ).toBe('https://api.first.invalid');
    expect(
      createRuntime(
        fakeHost({
          env: { PRISMA_API_URL: '', PRISMA_MANAGEMENT_API_URL: 'https://api.second.invalid' },
        }),
        noConfig,
      ).managementApi.baseUrl,
    ).toBe('https://api.second.invalid');
    expect(
      createRuntime(fakeHost({ env: { PRISMA_API_URL: '' } }), noConfig).managementApi.baseUrl,
    ).toBe('https://api.prisma.io');
  });

  test('the environment credential manager is wired, and reads the two protocol variables', async () => {
    const manager = createRuntime(
      fakeHost({ env: { PRISMA_SERVICE_TOKEN: 'token', PRISMA_WORKSPACE_ID: 'ws_1' } }),
      noConfig,
    ).credentialManager;

    const credential = await manager?.activeCredential();
    expect(credential?.workspaceId).toBe('ws_1');
    expect(credential?.origin.source).toBe('environment');
  });

  test('with no service token in the environment there is no active credential', async () => {
    expect(await createRuntime(fakeHost(), noConfig).credentialManager?.activeCredential()).toBe(
      null,
    );
  });

  test('a spawn adapter is wired — without one the engine refuses every spawning command', () => {
    expect(typeof createRuntime(fakeHost(), noConfig).spawn).toBe('function');
  });

  test('the loader is exposed as loadConfig, and its result is passed through untouched', async () => {
    const config: LoadedConfig = {
      path: '/app/prisma.config.ts',
      sections: { composer: { configPath: 'x.ts' } },
      diagnostics: [],
    };
    const runtime = createRuntime(fakeHost(), () => Promise.resolve(config));
    expect(await runtime.loadConfig()).toBe(config);
  });

  /**
   * What `--config` rides on. The engine hands the loader the file the user
   * named; a Runtime that dropped that argument would silently read
   * prisma.config.ts from cwd instead of the file that was asked for.
   */
  test('loadConfig forwards the config path the engine asked for', async () => {
    const asked: (string | undefined)[] = [];
    const runtime = createRuntime(fakeHost(), (configPath) => {
      asked.push(configPath);
      return noConfig();
    });

    await runtime.loadConfig('custom/prisma.config.ts');
    await runtime.loadConfig();

    expect(asked).toEqual(['custom/prisma.config.ts', undefined]);
  });
});
