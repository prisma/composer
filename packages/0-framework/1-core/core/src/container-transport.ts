/** The parent→child transport for resolved containers (ADR-0033-style opacity): the CLI parent writes each instance's `serialize()` output into one env var per extension; the alchemy child reads it back and calls the same descriptor's `deserialize`. */

/** What the framework knows about the deploy target — the container lookup key. */
export interface LocateContainerInput {
  /** The application name (root node's name, or `--name`). */
  readonly appName: string;
  /** The named stage, or `undefined` for the default (production) stage. */
  readonly stage: string | undefined;
}

/**
 * One resolved container. Core's claim is minimal; the owning extension
 * narrows to its concrete type where it reads the instance back (ADR-0033).
 */
export interface ContainerInstance {
  readonly input: LocateContainerInput;
  /** Serialize to a non-empty string for the parent→child transport. The format is the extension's own; only its `deserialize` reads it. */
  serialize(): string;
}

/**
 * The platform containers an app deploys into, as one lifecycle. `I` is
 * the extension's own instance type — the same descriptor produces and
 * consumes it, so the generic is compiler-checked within the extension
 * (ADR-0033). METHOD SYNTAX REQUIRED on all four members: the erased
 * assignment into ExtensionDescriptor relies on method bivariance, exactly
 * as ServiceLowering<P, S> does.
 */
export interface ContainerDescriptor<I extends ContainerInstance = ContainerInstance> {
  /** Resolve the container for (appName, stage), creating anything absent. Called by `deploy`. */
  ensure(input: LocateContainerInput): Promise<I>;
  /** Find the container for (appName, stage); `undefined` when nothing exists. Called by `destroy` — never creates. */
  locate(input: LocateContainerInput): Promise<I | undefined>;
  /** Remove the container after a successful destroy, after every extension's `teardown` has run. Failure policy is the extension's. */
  remove(instance: I): Promise<void>;
  /** Reconstruct an instance from its own `serialize()` output — the far end of the framework's parent→child transport. */
  deserialize(serialized: string): I;
}

/**
 * 'PRISMA_COMPOSER_CONTAINER_' + extensionId.toUpperCase()
 *   .replace(/[^A-Z0-9]+/g, '_') with leading/trailing '_' trimmed
 *   from the mangled id.
 * '@prisma/composer-prisma-cloud' →
 * 'PRISMA_COMPOSER_CONTAINER_PRISMA_COMPOSER_PRISMA_CLOUD'
 */
export function containerEnvVarName(extensionId: string): string {
  const mangled = extensionId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return `PRISMA_COMPOSER_CONTAINER_${mangled}`;
}

function collisionError(a: string, b: string, varName: string): Error {
  return new Error(
    `Extension ids "${a}" and "${b}" both mangle to the container transport variable ` +
      `"${varName}" — rename one of the extensions.`,
  );
}

function emptySerializeError(extensionId: string): Error {
  return new Error(
    `Extension "${extensionId}"'s container instance serialized to an empty string — ` +
      'ContainerInstance.serialize() must return a non-empty string.',
  );
}

/**
 * { [containerEnvVarName(id)]: instance.serialize() } for every resolved
 * instance. Throws Error naming BOTH extension ids when two ids mangle to
 * one var name; throws Error naming the extension id when serialize()
 * returns ''.
 */
export function containerEnv(
  instances: ReadonlyMap<string, ContainerInstance>,
): Record<string, string> {
  const env: Record<string, string> = {};
  const ownerByVarName = new Map<string, string>();
  for (const [extensionId, instance] of instances) {
    const varName = containerEnvVarName(extensionId);
    const owner = ownerByVarName.get(varName);
    if (owner !== undefined) throw collisionError(owner, extensionId, varName);
    ownerByVarName.set(varName, extensionId);

    const serialized = instance.serialize();
    if (serialized.length === 0) throw emptySerializeError(extensionId);
    env[varName] = serialized;
  }
  return env;
}

/** The slice of `PrismaAppConfig.extensions` this module needs — kept narrow so this shared-plane module never imports the control-plane `ExtensionDescriptor`/`PrismaAppConfig` types (ADR-0028's plane split). */
export interface ContainerTransportExtension {
  readonly id: string;
  readonly container?: ContainerDescriptor;
}

/**
 * Child side: for each extension with a container descriptor whose var is
 * present in `env`, call its deserialize. Absent var → no entry.
 */
export function deserializeContainers(
  extensions: readonly ContainerTransportExtension[],
  env: Readonly<Record<string, string | undefined>>,
): ReadonlyMap<string, ContainerInstance> {
  const instances = new Map<string, ContainerInstance>();
  for (const extension of extensions) {
    const descriptor = extension.container;
    if (descriptor === undefined) continue;
    const serialized = env[containerEnvVarName(extension.id)];
    if (serialized === undefined) continue;
    instances.set(extension.id, descriptor.deserialize(serialized));
  }
  return instances;
}
