/**
 * The boot-side half of the runtime split (see core-model.md § Runtime:
 * booting a service). Core's job at boot is structural only: turn a
 * concrete, typed Config into hydrated deps by calling each input's
 * connection.hydrate with its value slice. No environment read, no
 * validation, no strings — the pack's `load()` already read the process-local
 * stash into a typed Config before calling this.
 */
import { blindCast } from '@internal/foundation/casts';
import { SecretBox } from '@internal/foundation/secret';
import type { Config } from './config.ts';
import type { Deps, HydratedDeps, Secrets, SecretValues, ServiceNode } from './node.ts';

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

/**
 * Wraps each of a service's resolved secret values in a redacting `SecretBox`
 * — what the node's `secrets()` accessor returns (ADR-0021, sibling to
 * `load()`/`config()`). The RESOLUTION of a secret's value (the boot
 * double-lookup that reads the platform var the pointer names) is the target
 * pack's job; core is handed the already-resolved strings and only boxes them,
 * so a secret is redacted by TYPE from here on. A declared slot missing from
 * `values` is a target contract violation, named loudly.
 */
export function hydrateSecrets(
  root: ServiceNode,
  values: Record<string, string>,
): SecretValues<Secrets> {
  const boxed: Record<string, SecretBox<string>> = {};
  for (const slot of Object.keys(root.secretSlots)) {
    const value = values[slot];
    if (value === undefined) {
      throw new Error(
        `secret slot "${slot}" has no resolved value — the target must resolve every declared ` +
          'secret before hydrateSecrets().',
      );
    }
    boxed[slot] = new SecretBox(value);
  }
  return blindCast<
    SecretValues<Secrets>,
    'boxed holds one SecretBox<string> per declared secret slot — exactly the SecretValues<S> shape'
  >(boxed);
}
