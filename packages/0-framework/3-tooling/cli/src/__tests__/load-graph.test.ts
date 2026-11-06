import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { Load, LoadError } from '@internal/core';
import { loadEntry } from '../load-entry.ts';
import unwiredService from './fixtures/unwired-connection.ts';

const fixture = (name: string) => path.join(import.meta.dir, 'fixtures', name);

describe('the pipeline surfaces core Load() errors as-is (deploy-cli.md step 2)', () => {
  test('a service with an unwired dependency fails naming it and the composing module', async () => {
    expect(() => Load(unwiredService)).toThrow(LoadError);
    expect(() => Load(unwiredService)).toThrow(/unwired dependency "auth"/);
    expect(() => Load(unwiredService)).toThrow(/deploy the module instead/);
    const error: unknown = (() => {
      try {
        Load(unwiredService);
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();
    expect(error).toBeInstanceOf(LoadError);
    expect((error as LoadError).code).toBe('COMPOSE.GRAPH_INVALID');
  });

  test('a module root loads its provisioned services under addresses that start with the root id', async () => {
    const entry = await loadEntry(fixture('valid-module.ts'), import.meta.dir);

    const graph = Load(entry.root);

    expect(graph.root.node.kind).toBe('module');
    expect(graph.nodes.filter((n) => n.node.kind === 'service').map((n) => n.id)).toEqual([
      'fixture-module.one',
      'fixture-module.two',
    ]);
  });
});
