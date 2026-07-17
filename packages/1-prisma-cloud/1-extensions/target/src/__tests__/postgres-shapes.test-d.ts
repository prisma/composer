/**
 * postgres()'s two shapes and the binding each dependency yields.
 * `{ name }` is the provisionable identity; `postgres()` is the dependency,
 * whose binding is `PostgresConfig` (the app builds its own client — ADR-0015).
 * No `client` argument exists anymore.
 *
 * Type-only (vitest `--typecheck`, never executed). Positive cases assert the
 * returned role and the binding via `expectTypeOf`; a stray `client` argument
 * keeps a `// @ts-expect-error`.
 */
import type { DependencyEnd, Hydrated, ResourceNode } from '@internal/core';
import { expectTypeOf, test } from 'vitest';
import { postgres, type postgresContract } from '../exports/index.ts';
import type { PostgresConfig } from '../postgres.ts';

const identity = postgres({ name: 'db' });
const dep = postgres();

test('{ name } yields the resource identity providing postgresContract', () => {
  expectTypeOf(identity).toEqualTypeOf<ResourceNode<typeof postgresContract>>();
});

test('postgres() yields the dependency requiring postgresContract; its binding is PostgresConfig', () => {
  expectTypeOf(dep).toEqualTypeOf<DependencyEnd<PostgresConfig, typeof postgresContract>>();
  // The binding load() hands the app is the typed config, not a client.
  expectTypeOf<Hydrated<typeof dep>>().toEqualTypeOf<PostgresConfig>();
});

test('a client argument no longer compiles', () => {
  // @ts-expect-error the dependency takes no arguments — the app builds its own client from the binding
  postgres({ client: ({ url }: { url: string }) => ({ url }) });
  // @ts-expect-error {} is not the identity shape (needs `name`) and postgres() takes no args
  postgres({});
});
