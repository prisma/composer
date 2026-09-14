/**
 * `runPackPreflight` — the deploy-time enforcement of `requiredPackHead`:
 * wireability says yes to every required pack head, so THIS
 * is the check that the wired resource's `prisma.config.ts` actually
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
import { dataContract, postgres, requiredPackHead } from '../orm-postgres.ts';
import { runPackPreflight } from '../preflight.ts';
import { GADGET_PACK_HEAD_HASH, GADGET_PACK_ID } from './fixtures/packed-contract/pack.ts';
import widgetContractJson from './fixtures/widget-contract/emitted/contract.json' with {
  type: 'json',
};

const packedConfig = path.join(
  import.meta.dir,
  'fixtures',
  'packed-contract',
  'source',
  'prisma.config.ts',
);

/** A service dependency claiming its pn database carries the given pack head. */
const packDep = (packId: string, headHash: string) =>
  dependency({
    type: 'postgres',
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

const spacelessConfig = path.join(
  import.meta.dir,
  'fixtures',
  'packed-contract',
  'source',
  'prisma.spaceless.config.ts',
);

const pnDb = (config: string = packedConfig) =>
  postgres({
    name: 'db',
    contract: dataContract(widgetContractJson),
    config,
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
            deps: { db: postgres(dataContract(widgetContractJson)) },
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
    const graph = graphWith('auth', 'auth-head', pnDb());
    await expect(runPackPreflight(graph)).rejects.toThrow(
      'postgres database "db" does not list extension pack "auth" in its ' +
        'prisma.config.ts extensions — service "api" requires it. ' +
        'Add the pack and run migration plan.',
    );
  });

  test('fails naming the absent contract space when the listed pack declares none', async () => {
    // A pack with no contractSpace carries no head, so it can never satisfy a
    // required one — the message says that rather than printing "undefined".
    const graph = graphWith(GADGET_PACK_ID, 'a-required-head', pnDb(spacelessConfig));
    await expect(runPackPreflight(graph)).rejects.toThrow(
      `postgres database "db" lists extension pack "${GADGET_PACK_ID}" at head ` +
        '(no contract space), but service "api" requires a-required-head. ' +
        'Upgrade the pack and run migration plan.',
    );
  });

  test('fails naming both heads when the config lists the pack at a different head', async () => {
    // The pack IS listed, so the missing-pack check above passes it through —
    // only comparing heads catches a database whose migration step would take
    // it to a head the service is not typed against.
    const graph = graphWith(GADGET_PACK_ID, 'a-different-head', pnDb());
    await expect(runPackPreflight(graph)).rejects.toThrow(
      `postgres database "db" lists extension pack "${GADGET_PACK_ID}" at head ` +
        `${GADGET_PACK_HEAD_HASH}, but service "api" requires a-different-head. ` +
        'Upgrade the pack and run migration plan.',
    );
  });

  test('fails when a pack-requirement edge is wired to a non-postgres provider', async () => {
    // A resource that PROVIDES an orm-postgres contract (so the wiring
    // satisfies) but is not a postgres resource node — it has no config to
    // preflight against.
    const lookalike = resource({
      name: 'imposter',
      extension: '@prisma/composer-prisma-cloud',
      provides: dataContract(widgetContractJson),
    });
    const graph = Load(
      module('root', {}, ({ provision }) => {
        const db = provision(lookalike, { id: 'db' });
        provision(compute({ name: 'api', deps: { db: packDep('auth', 'auth-head') }, build }), {
          id: 'api',
          deps: { db },
        });
        return {};
      }),
      { id: 'root' },
    );
    await expect(runPackPreflight(graph)).rejects.toThrow(
      'service "api" requires extension pack "auth", which only a postgres resource can carry.',
    );
  });
});
