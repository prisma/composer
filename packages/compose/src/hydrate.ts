/**
 * The boot-side half of the runtime split (see core-model.md § Runtime:
 * booting a service). Core's job at boot is structural only: turn a
 * concrete, typed Config into hydrated deps by calling each input's
 * connection.hydrate with its value slice. No environment read, no
 * validation, no strings — the pack's `load()` already read the process-local
 * stash into a typed Config before calling this.
 */
import type { Config } from './config.ts';
import type { Deps, HydratedDeps, ServiceNode } from './node.ts';

/**
 * Given a service and a concrete typed Config, hydrate every input
 * (connection.hydrate with its typed value slice). A resource dep and a
 * connection dep hydrate through identical machinery — the loaded client is
 * indistinguishable. The service's own params ride alongside in
 * `config.service`; the node's `load()` merges the two.
 */
export async function hydrate(root: ServiceNode, config: Config): Promise<HydratedDeps<Deps>> {
  const deps: Record<string, unknown> = {};
  for (const [name, inputNode] of Object.entries(root.inputs)) {
    const values = config.inputs[name] ?? {};
    deps[name] = await inputNode.connection.hydrate(values as never);
  }
  return deps as HydratedDeps<Deps>;
}

/**
 * Synchronous hydrate — what the node's `load()` uses so
 * `const { db } = service.load()` reads without `await`. Requires every
 * connection.hydrate to return synchronously; a Promise return is a loud error
 * naming the input (an async client factory must use the async `hydrate` path).
 */
export function hydrateSync(root: ServiceNode, config: Config): HydratedDeps<Deps> {
  const deps: Record<string, unknown> = {};
  for (const [name, inputNode] of Object.entries(root.inputs)) {
    const values = config.inputs[name] ?? {};
    const client = inputNode.connection.hydrate(values as never);
    if (client instanceof Promise) {
      throw new Error(
        `Connection hydrate for input "${name}" returned a Promise; load() requires a synchronous client factory.`,
      );
    }
    deps[name] = client;
  }
  return deps as HydratedDeps<Deps>;
}
