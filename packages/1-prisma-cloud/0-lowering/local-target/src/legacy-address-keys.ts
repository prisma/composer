/**
 * Records written before ADR-0057 carry no `formatVersion` and key each node by its address
 * without the app name (`uploads`). Every key is now the full address (`shop.uploads`), so a
 * record without the version gets the app's name in front of every node key. Delete this file
 * once no such record remains.
 */
import type { EmulatorInstances, NodeInstance } from './emulator-instances.ts';

function withAppPrefix(
  app: string,
  nodes: Readonly<Record<string, NodeInstance>>,
): Record<string, NodeInstance> {
  return Object.fromEntries(
    Object.entries(nodes).map(([key, instance]) => [`${app}.${key}`, instance]),
  );
}

/** A record written before ADR-0057, with every node keyed by its full address. */
export function withFullAddressKeys(record: EmulatorInstances): EmulatorInstances {
  const apps = Object.fromEntries(
    Object.entries(record.apps).map(([app, { nodes }]) => [app, { nodes: withAppPrefix(app, nodes) }]),
  );
  return { current: record.current, apps };
}
