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
            databasePort: 51_300,
            port: 51_301,
            shadowDatabasePort: 51_302,
            streamsPort: 51_303,
            experimental: { streams: { serverUrl: 'http://127.0.0.1:51304' } },
          },
        ];
      }
    }

    const ports = await registryClaimedPorts({ ServerState });

    expect([...ports].sort((left, right) => left - right)).toEqual([
      51_300, 51_301, 51_302, 51_303, 51_304,
    ]);
    expect(scanOptions).toEqual({ onlyMetadata: true });
  });

  test('falls back to no registry claims when scanning fails', async () => {
    const ServerState = {
      async scan(): Promise<unknown> {
        throw new Error('registry unavailable');
      },
    };

    expect(await registryClaimedPorts({ ServerState })).toEqual(new Set());
  });
});
