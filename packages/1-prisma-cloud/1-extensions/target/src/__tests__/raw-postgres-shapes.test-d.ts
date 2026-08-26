/**
 * rawPostgres()'s two shapes and the binding each dependency yields.
 * `{ name }` is the provisionable identity; `rawPostgres()` is the dependency,
 * whose binding is `RawPostgresConfig` (the app builds its own client — ADR-0015).
 * No `client` argument exists anymore.
 *
 * Type-only (vitest `--typecheck`, never executed). Positive cases assert the
 * returned role and the binding via `expectTypeOf`; a stray `client` argument
 * keeps a `// @ts-expect-error`.
 */
import type { DependencyEnd, Hydrated, ResourceNode } from '@internal/core';
import { expectTypeOf, test } from 'vitest';
import { rawPostgres, type rawPostgresContract } from '../exports/index.ts';
import type { RawPostgresConfig } from '../raw-postgres.ts';

const identity = rawPostgres({ name: 'db' });
const dep = rawPostgres();

test('{ name } yields the resource identity providing rawPostgresContract', () => {
  expectTypeOf(identity).toEqualTypeOf<ResourceNode<typeof rawPostgresContract>>();
});

test('rawPostgres() yields the dependency requiring rawPostgresContract; its binding is RawPostgresConfig', () => {
  expectTypeOf(dep).toEqualTypeOf<DependencyEnd<RawPostgresConfig, typeof rawPostgresContract>>();
  // The binding load() hands the app is the typed config, not a client.
  expectTypeOf<Hydrated<typeof dep>>().toEqualTypeOf<RawPostgresConfig>();
});

test('a client argument no longer compiles', () => {
  // @ts-expect-error the dependency takes no arguments — the app builds its own client from the binding
  rawPostgres({ client: ({ url }: { url: string }) => ({ url }) });
  // @ts-expect-error {} is not the identity shape (needs `name`) and rawPostgres() takes no args
  rawPostgres({});
});
