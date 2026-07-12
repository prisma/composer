import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { Load, LoadError } from '@prisma/compose';
import { loadEntry } from '../load-entry.ts';

const fixture = (name: string) => path.join(import.meta.dir, 'fixtures', name);

describe('the pipeline surfaces core Load() errors as-is (deploy-cli.md step 2)', () => {
  test('a service with an unwired dependency input fails naming the input and the composing module', async () => {
    const entry = await loadEntry(fixture('unwired-connection.ts'), import.meta.dir);

    expect(() => Load(entry.root)).toThrow(LoadError);
    expect(() => Load(entry.root)).toThrow(/unwired dependency input "auth"/);
    expect(() => Load(entry.root)).toThrow(/deploy the module instead/);
  });

  test('a module root loads its provisioned services under their provision ids', async () => {
    const entry = await loadEntry(fixture('valid-module.ts'), import.meta.dir);

    const graph = Load(entry.root);

    expect(graph.root.node.kind).toBe('module');
    expect(graph.nodes.filter((n) => n.node.kind === 'service').map((n) => n.id)).toEqual([
      'one',
      'two',
    ]);
  });
});
