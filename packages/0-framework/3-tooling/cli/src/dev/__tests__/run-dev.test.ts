import { describe, expect, test } from 'bun:test';
import { createDevShutdownController, renderFrontDoor } from '../run-dev.ts';

describe('renderFrontDoor()', () => {
  test('starts with "[dev] ready:", then orders by address depth (fewest dots first), then lexicographic', () => {
    const lines = renderFrontDoor([
      { address: 'storefront.web', url: 'http://localhost:3002' },
      { address: 'web', url: 'http://localhost:3000' },
      { address: 'api', url: 'http://localhost:3001' },
      { address: 'storefront.admin', url: 'http://localhost:3003' },
    ]);

    expect(lines).toEqual([
      '[dev] ready:',
      '[dev] api  http://localhost:3001',
      '[dev] web  http://localhost:3000',
      '[dev] storefront.admin  http://localhost:3003',
      '[dev] storefront.web  http://localhost:3002',
    ]);
  });

  test('an empty endpoint list still prints the ready line alone', () => {
    expect(renderFrontDoor([])).toEqual(['[dev] ready:']);
  });
});

describe('createDevShutdownController()', () => {
  test('waits for graceful cleanup and ignores signals after it completes', async () => {
    const cleanup = Promise.withResolvers<void>();
    let cleanupCalls = 0;
    const forcedExitCodes: number[] = [];
    const shutdown = createDevShutdownController(
      () => {
        cleanupCalls += 1;
        return cleanup.promise;
      },
      (code) => forcedExitCodes.push(code),
    );

    let stopped = false;
    void shutdown.done.then(() => {
      stopped = true;
    });

    shutdown.handle('SIGINT');
    await Promise.resolve();
    expect(cleanupCalls).toBe(1);
    expect(stopped).toBe(false);

    cleanup.resolve();
    await shutdown.done;
    shutdown.handle('SIGINT');

    expect(stopped).toBe(true);
    expect(forcedExitCodes).toEqual([]);
  });

  test('a second signal during cleanup forces the conventional signal exit code', async () => {
    for (const [signal, exitCode] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const) {
      const cleanup = Promise.withResolvers<void>();
      const forcedExitCodes: number[] = [];
      const shutdown = createDevShutdownController(
        () => cleanup.promise,
        (code) => forcedExitCodes.push(code),
      );

      shutdown.handle(signal);
      shutdown.handle(signal);

      expect(forcedExitCodes).toEqual([exitCode]);
      cleanup.resolve();
      await shutdown.done;
    }
  });
});
