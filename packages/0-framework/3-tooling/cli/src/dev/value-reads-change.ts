import { isDeepStrictEqual } from 'node:util';
import type { Graph, ValueRead } from '@internal/core';
import { comparableProps } from '@internal/core/deploy';

/** A graph's value reads and the props of each value resource they read, as data a worker thread can receive. */
export interface ValueReadsSnapshot {
  readonly reads: readonly ValueRead[];
  readonly props: Readonly<Record<string, unknown>>;
}

export interface ValueReadsChange {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

const readKey = (read: ValueRead): string =>
  JSON.stringify([read.reader, read.resource, read.path]);

function readsByResource(snapshot: ValueReadsSnapshot): Map<string, Set<string>> {
  const byResource = new Map<string, Set<string>>();
  for (const read of snapshot.reads) {
    const keys = byResource.get(read.resource) ?? new Set<string>();
    keys.add(readKey(read));
    byResource.set(read.resource, keys);
  }
  return byResource;
}

function propsAt(graph: Graph, address: string): unknown {
  const found = graph.nodes.find((entry) => entry.id === address)?.node;
  return found?.kind === 'resource' ? found.props : undefined;
}

export function valueReadsSnapshot(graph: Graph): ValueReadsSnapshot {
  return {
    reads: graph.valueReads.map(({ reader, resource, path }) => ({ reader, resource, path })),
    props: Object.fromEntries(
      graph.valueReads.map(({ resource }) => [resource, comparableProps(propsAt(graph, resource))]),
    ),
  };
}

const hasMemberNotIn = (keys: ReadonlySet<string>, other: ReadonlySet<string>): boolean =>
  [...keys].some((key) => !other.has(key));

export function valueReadsChange(
  started: ValueReadsSnapshot,
  rebuilt: ValueReadsSnapshot,
): ValueReadsChange | undefined {
  const before = readsByResource(started);
  const after = readsByResource(rebuilt);
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const address of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(address) ?? new Set<string>();
    const is = after.get(address) ?? new Set<string>();
    const gained = hasMemberNotIn(is, was);
    const lost = hasMemberNotIn(was, is);
    const propsDiffer =
      was.size > 0 &&
      is.size > 0 &&
      !isDeepStrictEqual(started.props[address], rebuilt.props[address]);
    if (propsDiffer || (gained && lost)) changed.push(address);
    else if (gained) added.push(address);
    else if (lost) removed.push(address);
  }
  if (added.length + removed.length + changed.length === 0) return undefined;
  return { added, removed, changed };
}
