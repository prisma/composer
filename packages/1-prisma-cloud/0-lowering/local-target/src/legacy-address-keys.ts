/**
 * Records written before ADR-0056 keyed each node by its address without the
 * app name (`uploads`). Every key is now the full address (`shop.uploads`).
 * A key that is neither the app's name nor starts with `<app>.` is an old key,
 * and gets the app's name in front. A record already in the new form is
 * unchanged. Delete this file once no such record remains.
 */
import type { EmulatorInstances, NodeInstance } from './emulator-instances.ts';

function isFullAddress(app: string, key: string): boolean {
  return key === app || key.startsWith(`${app}.`);
}

function withFullKeys(
  app: string,
  nodes: Readonly<Record<string, NodeInstance>>,
): Record<string, NodeInstance> {
  const rewritten: Record<string, NodeInstance> = {};
  for (const [key, instance] of Object.entries(nodes)) {
    if (isFullAddress(app, key)) rewritten[key] = instance;
  }
  for (const [key, instance] of Object.entries(nodes)) {
    if (isFullAddress(app, key)) continue;
    // A node already recorded under its full address keeps that newer entry.
    rewritten[`${app}.${key}`] ??= instance;
  }
  return rewritten;
}

/** The record with every node keyed by its full address. */
export function withFullAddressKeys(record: EmulatorInstances): EmulatorInstances {
  const apps = Object.fromEntries(
    Object.entries(record.apps).map(([app, { nodes }]) => [
      app,
      { nodes: withFullKeys(app, nodes) },
    ]),
  );
  return { current: record.current, apps };
}
