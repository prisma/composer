/**
 * Finds the `COMPOSER_` keys that the move to full addresses (ADR-0057) gives two rows: the new
 * key of one row is the key the previous release wrote for another. Within one format keys are
 * distinct; across the two they can meet, because every key is upper-cased and `-` becomes `_`.
 * Delete this file with `legacy-resource-ids.ts`.
 */
import type { Graph, ServiceNode } from '@internal/core';
import { addressBelowApp } from './legacy-resource-ids.ts';
import { RESERVED_PROVIDER_PARAMS } from './provider-params.ts';
import {
  configKey,
  generatedParamVarName,
  INPUT_KEY_NAME,
  paramEntries,
  serializeInput,
} from './serializer.ts';

export interface EnvKeyClash {
  /** The variable both rows are written under. */
  readonly key: string;
  /** The node whose new row has this key. */
  readonly newOwner: string;
  /** The node whose row had this key under the previous release. */
  readonly oldOwner: string;
  /** The key the old owner's row moves to in the same deploy. */
  readonly oldOwnerNewKey: string;
}

interface Row {
  readonly address: string;
  readonly newKey: string;
  readonly oldKey: string;
}

/** Every `COMPOSER_` row a service can have, each under both its new and its old key. */
function rowsOf(node: ServiceNode, address: string, app: string, binding: unknown): Row[] {
  const below = addressBelowApp(address, app);
  const names: { owner: 'service' | { input: string }; name: string }[] = [
    ...paramEntries(node),
    { owner: 'service', name: INPUT_KEY_NAME },
    ...RESERVED_PROVIDER_PARAMS.map(({ name }) => ({ owner: 'service' as const, name })),
  ];
  const rows = names.map((d) => ({
    address,
    newKey: configKey(address, d),
    oldKey: configKey(below, d),
  }));
  const generated = serializeInput(node, address, binding)?.generated ?? [];
  for (const { path } of generated) {
    rows.push({
      address,
      newKey: generatedParamVarName(address, path),
      oldKey: generatedParamVarName(below, path),
    });
  }
  return rows;
}

/** Every key that is one row's new key and a different row's old key. */
export function findEnvKeyClashes(graph: Graph): readonly EnvKeyClash[] {
  const app = graph.root.id;
  const rows: Row[] = [];
  for (const { id, node } of graph.nodes) {
    if (node.kind !== 'service') continue;
    const binding = graph.inputBindings.find((b) => b.serviceAddress === id)?.binding;
    rows.push(...rowsOf(node, id, app, binding));
  }
  const byOldKey = new Map(rows.map((row) => [row.oldKey, row]));
  const clashes: EnvKeyClash[] = [];
  for (const row of rows) {
    const old = byOldKey.get(row.newKey);
    if (old === undefined) continue;
    clashes.push({
      key: row.newKey,
      newOwner: row.address,
      oldOwner: old.address,
      oldOwnerNewKey: old.newKey,
    });
  }
  return clashes;
}
