/**
 * `runPackPreflight` — the deploy-time enforcement of `requiredPackHead`:
 * wireability says yes to every required pack head, so THIS
 * is the check that the wired resource's `prisma-next.config.ts` actually
 * lists the pack at the required head. Driven against real `Load` graphs
 * (real wiring, real satisfies path) with the packed-contract fixture's
 * on-disk config; no database, no Prisma Cloud.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
  dependency,
  type Graph,
  Load,
  module,
  type ResourceNode,
  resource,
  string,
} from '@internal/core';
import { compute } from '../compute.ts';
import { runPackPreflight } from '../preflight.ts';
import { pnContract, pnPostgres, requiredPackHead } from '../prisma-next.ts';
import { GADGET_PACK_HEAD_HASH, GADGET_PACK_ID } from './fixtures/packed-contract/pack.ts';
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};

const packedConfig = path.join(
  import.meta.dir,
  'fixtures',
  'packed-contract',
  'source',
  'prisma-next.config.ts',
);

/** A service dependency claiming its pn database carries the given pack head. */
const packDep = (packId: string, headHash: string) =>
  dependency({
    type: 'prisma-next',
    connection: { params: { url: string() }, hydrate: (v) => v },
    required: requiredPackHead({ packId, headHash }),
  });

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

/** One consumer service with a pack-requirement dep, wired to `provider`. */
const graphWith = (packId: string, headHash: string, provider: ResourceNode): Graph =>
  Load(
    module('root', {}, ({ provision }) => {
      const db = provision(provider, { id: 'db' });
      provision(compute({ name: 'api', deps: { db: packDep(packId, headHash) }, build }), {
        id: 'api',
        deps: { db },
      });
      return {};
    }),
    { id: 'root' },
  );

const pnDb = () =>
  pnPostgres({
    name: 'db',
    contract: pnContract(widgetContractJson),
    config: packedConfig,
  });

describe('runPackPreflight', () => {
  test('passes when the wired config lists the pack at the required head', async () => {
    const graph = graphWith(GADGET_PACK_ID, GADGET_PACK_HEAD_HASH, pnDb());
    await expect(runPackPreflight(graph)).resolves.toBeUndefined();
  });

  test('ignores graphs with no pack-requirement edges', async () => {
    const graph = Load(
      module('root', {}, ({ provision }) => {
        const db = provision(pnDb(), { id: 'db' });
        provision(
          compute({
            name: 'api',
            deps: { db: pnPostgres(pnContract(widgetContractJson)) },
            build,
          }),
          { id: 'api', deps: { db } },
        );
        return {};
      }),
      { id: 'root' },
    );
    await expect(runPackPreflight(graph)).resolves.toBeUndefined();
  });

  test('fails naming resource, pack, and consumer when the config does not list the pack', async () => {
    const graph = graphWith('auth', 'sha256:auth-head', pnDb());
    await expect(runPackPreflight(graph)).rejects.toThrow(
      'prisma-next database "db" does not list extension pack "auth" in its ' +
        'prisma-next.config.ts extensionPacks — service "api" requires it. ' +
        'Add the pack and run migration plan.',
    );
  });

  test('fails naming found vs required heads when the pack is listed at another head', async () => {
    const graph = graphWith(GADGET_PACK_ID, 'sha256:required-but-newer', pnDb());
    await expect(runPackPreflight(graph)).rejects.toThrow(
      `extension pack "${GADGET_PACK_ID}" in "${packedConfig}" is at head ` +
        `${GADGET_PACK_HEAD_HASH}, but the installed package requires ` +
        "sha256:required-but-newer. Re-run migration plan so the pack's shipped migrations " +
        'are materialised, then redeploy.',
    );
  });

  test('fails when a pack-requirement edge is wired to a non-pnPostgres provider', async () => {
    // A resource that PROVIDES a prisma-next contract (so the wiring
    // satisfies) but is not a pnPostgres resource node — it has no config to
    // preflight against.
    const lookalike = resource({
      name: 'imposter',
      extension: '@prisma/composer-prisma-cloud',
      provides: pnContract(widgetContractJson),
    });
    const graph = Load(
      module('root', {}, ({ provision }) => {
        const db = provision(lookalike, { id: 'db' });
        provision(
          compute({ name: 'api', deps: { db: packDep('auth', 'sha256:auth-head') }, build }),
          { id: 'api', deps: { db } },
        );
        return {};
      }),
      { id: 'root' },
    );
    await expect(runPackPreflight(graph)).rejects.toThrow(
      'service "api" requires extension pack "auth", which only a pnPostgres resource can carry.',
    );
  });
});
