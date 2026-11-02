import { type Graph, LoadError, type LoadOptions } from './graph-types.ts';
import { loadModule } from './load-module.ts';
import { loadService } from './load-service.ts';
import { isNode, type ModuleNode, type ServiceNode, sourceOriginOf } from './node.ts';

export type {
  AuthoredEdge,
  BoundaryPort,
  CheckedConfiguration,
  CheckedRootField,
  Edge,
  Graph,
  GraphNode,
  InputBindingUse,
  LoadOptions,
  NodeId,
  ParamBinding,
  PortEndpoint,
  SecretSourceUse,
} from './graph-types.ts';
export { LoadError, RESOURCE_OUT_PORT } from './graph-types.ts';

const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/**
 * Throws unless `name` can be an app name: the root's address and the first segment of every
 * other address (ADR-0057). A `.` would split it, and it becomes part of every `COMPOSER_` key.
 */
export function assertAppName(name: string): void {
  if (!APP_NAME.test(name)) {
    throw new LoadError(
      `The app name "${name}" is not valid. An app name (the root module's name, or --name) must ` +
        'start with a letter or digit and contain only letters, digits, "-" and "_".',
    );
  }
}

/**
 * Builds the in-memory graph from a root node. A service root walks its own
 * `inputs`; a module root executes its body (wiring, not user code — the
 * designed exception to imports-run-nothing) and recursively flattens every
 * module it provisions into one graph of hierarchical addresses. A malformed
 * graph is a `LoadError` that names its fix; the individual validation rules
 * live with `loadService` / `loadModule` and are covered by name in the Load
 * tests. Executes nothing of the user's own code beyond module bodies and `resolve()`
 * functions.
 */
export function Load(root: ServiceNode | ModuleNode, opts?: LoadOptions): Graph {
  // Brand-check the untrusted root once (a user default-export could be junk
  // TypeScript believes is a node), then route by its discriminant.
  if (!isNode(root)) {
    throw new LoadError(
      'Load expects a branded service or module node (construct it with the service()/module() factories).',
    );
  }
  if (root.kind === 'module') {
    assertAppName(opts?.id ?? root.name);
    return loadModule(root, opts);
  }
  if (root.kind === 'service') return loadService(root, opts?.id ?? 'root');
  throw new LoadError('Load expects a service or module root (received another node kind).');
}

/** The app secrets key of every secret source the graph names, once each, in the order Load met them. A source built without a `secretsKey` is left out. */
export function secretsKeys(graph: Graph): readonly string[] {
  const keys = new Set<string>();
  for (const { source } of graph.secretSources) {
    const key = sourceOriginOf(source)?.secretsKey;
    if (key !== undefined) keys.add(key);
  }
  return [...keys];
}

/** The address of every node in the graph, sorted. Two Loads of the same graph give the same list. */
export function nodeAddresses(graph: Graph): readonly string[] {
  return graph.nodes.map(({ id }) => id).sort();
}
