/**
 * The boot pipeline. Core owns config management end to end while caring
 * nothing about the mapping: enumerate the declarations, ask the service's
 * ConfigAdapter for raw values, validate + coerce against the declared types,
 * hydrate each connection with its typed values, call the handler with the
 * service's own param values. Imports nothing; reads no environment — the
 * platform adapter is the single sanctioned reader for its platform.
 */
import {
  type ConfigAdapter,
  type ConfigDeclaration,
  type ConfigRequest,
  configOf,
} from './config.ts';
import { Load } from './graph.ts';
import type { ResourceNode, ServiceNode } from './node.ts';

export interface RunHostOptions {
  /** Swap the platform adapter: in-memory tests, inspection harnesses. */
  readonly config?: ConfigAdapter;
  /** Per-param overrides, applied before the adapter is consulted. */
  readonly overrides?: Record<string, string | number>;
}

/** Names every missing/invalid/unknown param at once — before any hydrate. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// Param path: how overrides address params and how errors name them —
// "input.name" for input params, the bare name for service params. Owners
// discriminate structurally, so the two forms cannot collide (input paths
// always carry a dot).
const paramPath = (entry: ConfigDeclaration): string =>
  entry.owner === 'service' ? entry.name : `${entry.owner.input}.${entry.name}`;

/**
 * Load → configOf → adapter.get(requests) → per-param: override ?? raw ??
 * default → validate + coerce against the declared type. Validation rules:
 * "" is UNRESOLVED, not a value — it falls to the default or, if required,
 * joins the missing set; a NON-EMPTY value that fails its declared type is
 * an ERROR regardless of any default — a default substitutes for absence,
 * never for garbage; unknown override keys are errors. ALL problems reported
 * in one ConfigError, before any hydrate — then per input:
 * await connection.hydrate(typedValues), and finally
 * root.run(deps, serviceParamValues).
 */
export async function runHost(root: ServiceNode, opts?: RunHostOptions): Promise<unknown> {
  const graph = Load(root);
  const declarations = configOf(root);
  const adapter = opts?.config ?? root.config;

  // Overrides are applied first; only unsatisfied params are requested.
  const overrides = new Map<string, string | number>();
  for (const entry of declarations) {
    const value = opts?.overrides?.[paramPath(entry)];
    if (value !== undefined) overrides.set(paramPath(entry), value);
  }

  const requests: ConfigRequest[] = declarations
    .filter((entry) => !overrides.has(paramPath(entry)))
    .map((entry, index) => ({
      id: `${index}:${paramPath(entry)}`,
      owner: entry.owner,
      name: entry.name,
      param: {
        type: entry.type,
        secret: entry.secret,
        optional: entry.optional,
        ...(entry.default !== undefined ? { default: entry.default } : {}),
      },
    }));
  const raw = requests.length > 0 ? await adapter.get(requests) : {};
  const rawByPath = new Map<string, string>();
  for (const request of requests) {
    const value = raw[request.id];
    if (value !== undefined) {
      rawByPath.set(
        request.owner === 'service' ? request.name : `${request.owner.input}.${request.name}`,
        value,
      );
    }
  }

  // Resolve + validate every param; report ALL problems in one error.
  const resolved = new Map<string, string | number | undefined>();
  const problems: string[] = [];

  for (const entry of declarations) {
    const path = paramPath(entry);
    // "" is UNRESOLVED, not a value — uniformly, overrides included.
    let value: string | number | undefined = overrides.get(path) ?? rawByPath.get(path);
    if (value === '') value = undefined;

    if (value === undefined) {
      if (entry.default !== undefined) {
        resolved.set(path, entry.default);
      } else if (entry.optional) {
        resolved.set(path, undefined);
      } else {
        problems.push(`missing required param "${path}" (${entry.type})`);
      }
      continue;
    }

    if (entry.type === 'number') {
      const parsed = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(parsed)) {
        resolved.set(path, parsed);
      } else {
        // A non-empty value that fails its declared type is an error
        // regardless of any default — a default substitutes for absence,
        // never for garbage.
        problems.push(`invalid number for param "${path}": got ${JSON.stringify(value)}`);
      }
    } else {
      resolved.set(path, String(value));
    }
  }

  // A typoed override must not silently fall through to the platform value.
  const knownPaths = new Set(declarations.map(paramPath));
  for (const key of Object.keys(opts?.overrides ?? {})) {
    if (!knownPaths.has(key)) {
      problems.push(`unknown override key "${key}"`);
    }
  }

  if (problems.length > 0) {
    throw new ConfigError(`Config validation failed: ${problems.join('; ')}.`);
  }

  // Hydrate each input with its typed value slice.
  const deps: Record<string, unknown> = {};
  const byId = new Map(graph.nodes.map((entry) => [entry.id, entry]));
  for (const edge of graph.edges) {
    const node = byId.get(edge.from)?.node as ResourceNode;
    const values: Record<string, string | number | undefined> = {};
    for (const name of Object.keys(node.connection.params)) {
      values[name] = resolved.get(`${edge.input}.${name}`);
    }
    deps[edge.input] = await node.connection.hydrate(values as never);
  }

  const ctx: Record<string, string | number | undefined> = {};
  for (const name of Object.keys(root.params)) {
    ctx[name] = resolved.get(name);
  }

  return root.run(deps as Parameters<typeof root.run>[0], ctx as Parameters<typeof root.run>[1]);
}
