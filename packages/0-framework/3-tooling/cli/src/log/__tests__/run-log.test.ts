import { describe, expect, test } from 'bun:test';
import type { ContainerInstance, PrismaAppConfig } from '@internal/core/config';
import type { LocalTargetAttachment, LocalTargetDescriptor } from '@internal/core/local-target';
import * as Layer from 'effect/Layer';
import { CliError } from '../../cli-error.ts';
import { runLog } from '../run-log.ts';

interface Endpoint {
  readonly address: string;
  readonly url: string;
}
interface LogLine {
  readonly service: string;
  readonly line: string;
}

const unused = () => {
  throw new Error('descriptor body must not run — run-log only reads endpoints/logs');
};

function container(): ContainerInstance {
  return { input: { appName: 'app', stage: undefined }, serialize: () => 'x' };
}

/** An attachment whose `logs` yields the given lines then completes (a real one runs until abort; completing lets the test drive `runLog` to a natural return). */
function fakeAttachment(
  endpoints: readonly Endpoint[],
  lines: readonly LogLine[],
): LocalTargetAttachment {
  return {
    startServices: () => Promise.resolve(),
    stopServices: () => Promise.resolve(),
    endpoints: () => Promise.resolve(endpoints),
    // eslint-disable-next-line @typescript-eslint/require-await
    logs: async function* () {
      for (const l of lines) yield l;
    },
  };
}

function configWith(attachment: LocalTargetAttachment): PrismaAppConfig {
  const descriptor: LocalTargetDescriptor = {
    providers: () => Layer.empty,
    container: {
      ensure: () => Promise.resolve(container()),
      locate: () => Promise.resolve(undefined),
      remove: () => Promise.resolve(),
      deserialize: () => container(),
    },
    attach: () => Promise.resolve(attachment),
  };
  return {
    extensions: [
      {
        id: 'x',
        nodes: {
          svc: {
            kind: 'service',
            provision: unused,
            serialize: unused,
            package: unused,
            deploy: unused,
          },
        },
        localTarget: () => Promise.resolve(descriptor),
      },
    ],
    state: { extension: 'x', create: unused },
  };
}

async function captureLog(run: () => Promise<unknown>): Promise<{ out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(' '));
  try {
    await run();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return { out, err };
}

function args(overrides: Partial<Parameters<typeof runLog>[0]> = {}): Parameters<typeof runLog>[0] {
  return { entry: 'service.ts', name: undefined, address: undefined, tail: 20, ...overrides };
}

describe('runLog()', () => {
  test('prints every service line with a [service] prefix', async () => {
    const attachment = fakeAttachment(
      [{ address: 'a', url: 'http://a' }],
      [
        { service: 'a', line: 'hello' },
        { service: 'a', line: 'world' },
      ],
    );
    const { out } = await captureLog(() =>
      runLog(args(), {
        identity: { configPath: 'c', config: configWith(attachment), name: 'app' },
      }),
    );
    expect(out).toContain('[a] hello');
    expect(out).toContain('[a] world');
  });

  test('an address filter keeps only that service', async () => {
    const attachment = fakeAttachment(
      [
        { address: 'a', url: 'http://a' },
        { address: 'b', url: 'http://b' },
      ],
      [
        { service: 'a', line: 'from-a' },
        { service: 'b', line: 'from-b' },
      ],
    );
    const { out } = await captureLog(() =>
      runLog(args({ address: 'a' }), {
        identity: { configPath: 'c', config: configWith(attachment), name: 'app' },
      }),
    );
    expect(out).toContain('[a] from-a');
    expect(out).not.toContain('[b] from-b');
  });

  test('an unknown address fails, naming the running services', async () => {
    const attachment = fakeAttachment([{ address: 'a', url: 'http://a' }], []);
    await expect(
      runLog(args({ address: 'nope' }), {
        identity: { configPath: 'c', config: configWith(attachment), name: 'app' },
      }),
    ).rejects.toThrow(CliError);
  });

  test('no running services prints a hint and exits 0', async () => {
    const attachment = fakeAttachment([], []);
    const code = { value: -1 };
    const { err } = await captureLog(async () => {
      code.value = await runLog(args(), {
        identity: { configPath: 'c', config: configWith(attachment), name: 'app' },
      });
    });
    expect(code.value).toBe(0);
    expect(err.join('\n')).toContain('no running services');
  });
});
