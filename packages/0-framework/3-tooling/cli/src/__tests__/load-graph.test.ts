import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { Load, LoadError } from '@internal/core';
import { loadEntry } from '../load-entry.ts';

const fixture = (name: string) => path.join(import.meta.dir, 'fixtures', name);

describe('the pipeline surfaces core Load() errors as-is (deploy-cli.md step 2)', () => {
  test('a provisioned service with an unwired dependency fails naming it and the composing module', async () => {
    const entry = await loadEntry(fixture('unwired-connection.ts'), import.meta.dir);

    const error: unknown = (() => {
      try {
        Load(entry.root);
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(LoadError);
    if (!(error instanceof LoadError)) throw new Error('unreachable');
    expect(error.code).toBe('COMPOSE.GRAPH_INVALID');
    expect(error.message).toBe(
      'Dependency "auth" of provisioned service "fixture-unwired.svc" is not wired to a producer (module "fixture-unwired").',
    );
  });

  test('a module root loads its provisioned services under addresses that start with the root id', async () => {
    const entry = await loadEntry(fixture('valid-root.ts'), import.meta.dir);

    const graph = Load(entry.root);

    expect(graph.root.node.kind).toBe('module');
    expect(graph.nodes.filter((n) => n.node.kind === 'service').map((n) => n.id)).toEqual([
      'fixture-root.one',
      'fixture-root.two',
    ]);
  });
});
