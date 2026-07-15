import { type Graph, LoadError, type NodeId } from './graph-types.ts';
import { loadModule } from './load-module.ts';
import { loadService } from './load-service.ts';
import { isNode, type ModuleNode, type ServiceNode } from './node.ts';

export type { Edge, Graph, GraphNode, NodeId, SecretBinding } from './graph-types.ts';
export { LoadError } from './graph-types.ts';

/**
 * Builds the in-memory graph from a root node. A service root walks its own
 * `inputs`; a module root executes its body (wiring, not user code — the
 * designed exception to imports-run-nothing) and recursively flattens every
 * module it provisions into one graph of hierarchical addresses. A malformed
 * graph is a `LoadError` that names its fix; the individual validation rules
 * live with `loadService` / `loadModule` and are covered by name in the Load
 * tests. Executes nothing of the user's own code beyond module bodies.
 */
export function Load(root: ServiceNode | ModuleNode, opts?: { id?: NodeId }): Graph {
  // Brand-check the untrusted root once (a user default-export could be junk
  // TypeScript believes is a node), then route by its discriminant.
  if (!isNode(root)) {
    throw new LoadError(
      'Load expects a branded service or module node (construct it with the service()/module() factories).',
    );
  }
  if (root.kind === 'module') return loadModule(root, opts);
  if (root.kind === 'service') return loadService(root, opts?.id ?? 'root');
  throw new LoadError('Load expects a service or module root (received another node kind).');
}
