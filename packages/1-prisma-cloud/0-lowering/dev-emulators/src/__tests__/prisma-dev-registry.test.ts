import { describe, expect, test } from 'bun:test';
import { registryClaimedPorts } from '../prisma-dev-registry.ts';

describe('Prisma Dev server registry', () => {
  test('reads claimed ports from the static scan method on the ServerState class', async () => {
    let scanOptions: unknown;

    // biome-ignore lint/complexity/noStaticOnlyClass: this must mirror @prisma/dev's real runtime export shape.
    class ServerState {
      static async scan(options: { readonly onlyMetadata: true }): Promise<unknown> {
        scanOptions = options;
        return [
          {
            name: 'other-server',
            databasePort: 51_300,
            port: 51_301,
            shadowDatabasePort: 51_302,
            experimental: { streams: { serverUrl: 'http://127.0.0.1:51304' } },
          },
        ];
      }
    }

    const ports = await registryClaimedPorts({ ServerState }, 'this-server');

    expect([...ports].sort((left, right) => left - right)).toEqual([
      51_300, 51_301, 51_302, 51_304,
    ]);
    expect(scanOptions).toEqual({ onlyMetadata: true });
  });

  test("skips the caller's own record — @prisma/dev exempts it from port validation and prefers to reuse its ports", async () => {
    const ServerState = {
      async scan(): Promise<unknown> {
        return [
          { name: 'this-server', databasePort: 51_300, port: 51_301, shadowDatabasePort: 51_302 },
          { name: 'other-server', databasePort: 51_310 },
        ];
      },
    };

    expect(await registryClaimedPorts({ ServerState }, 'this-server')).toEqual(new Set([51_310]));
  });

  test('falls back to no registry claims when the module exposes no ServerState', async () => {
    expect(await registryClaimedPorts({}, 'this-server')).toEqual(new Set());
  });

  test('falls back to no registry claims when scanning fails', async () => {
    const ServerState = {
      async scan(): Promise<unknown> {
        throw new Error('registry unavailable');
      },
    };

    expect(await registryClaimedPorts({ ServerState }, 'this-server')).toEqual(new Set());
  });
});
