import { expect, mock, test } from 'bun:test';
import type { ManagementApiClient } from '@internal/lowering';
import * as Effect from 'effect/Effect';
import { databaseIdentityProviderService } from '../database-identity-resource.ts';

function setup(error?: unknown) {
  const patch = mock(async () => ({ error }));
  const provider = databaseIdentityProviderService({
    PATCH: patch,
  } as unknown as ManagementApiClient);
  const reconcile = () =>
    provider.reconcile({
      id: 'catalog-identity',
      fqn: 'catalog-identity',
      instanceId: 'catalog-identity',
      news: { databaseId: 'db_catalog', logicalId: 'catalog' },
      olds: undefined,
      output: undefined,
      session: undefined as never,
      bindings: undefined as never,
    });
  return { patch, provider, reconcile };
}

test('binds the authored name without moving the database to another branch', async () => {
  const { patch, reconcile } = setup();
  expect(await Effect.runPromise(reconcile())).toEqual({
    databaseId: 'db_catalog',
    logicalId: 'catalog',
  });
  expect(patch).toHaveBeenCalledWith('/v1/databases/{databaseId}', {
    params: { path: { databaseId: 'db_catalog' } },
    body: { logicalId: 'catalog' },
  });
});

test('repeating the binding retains the same identity', async () => {
  const { reconcile } = setup();
  expect(await Effect.runPromise(reconcile())).toEqual(await Effect.runPromise(reconcile()));
});

test('fails deployment when the identity is already claimed', async () => {
  const error = { error: 'logicalId catalog is already claimed by another database' };
  const { reconcile } = setup(error);
  await expect(Effect.runPromise(reconcile())).rejects.toThrow(
    `Could not bind database db_catalog to topology node catalog: ${JSON.stringify(error)}`,
  );
});

test('removing the binding resource leaves database deletion to its owner', async () => {
  const { patch, provider } = setup();
  await Effect.runPromise(
    provider.delete({
      id: 'catalog-identity',
      fqn: 'catalog-identity',
      instanceId: 'catalog-identity',
      olds: { databaseId: 'db_catalog', logicalId: 'catalog' },
      output: { databaseId: 'db_catalog', logicalId: 'catalog' },
      session: undefined as never,
      bindings: [],
    }),
  );
  expect(patch).not.toHaveBeenCalled();
});
