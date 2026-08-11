/**
 * Carries resolved containers from the CLI process into the alchemy process
 * (ADR-0037). A deploy runs as two processes: the CLI resolves each
 * extension's containers, then spawns `alchemy`, which re-imports the config
 * from scratch and needs those containers back — and env vars are the only
 * channel between the two. So the CLI writes each instance's `serialize()`
 * output into one env var per extension, and in the alchemy process
 * `deserializeContainers` reads each var back through the same extension's
 * descriptor. The framework owns the vars; it never reads their contents.
 */

/** The key an extension resolves a container from: which app, which stage. */
export interface LocateContainerInput {
  /** The application name (root node's name, or `--name`). */
  readonly appName: string;
  /** The USER-FACING stage name — `--stage <name>` as the user typed it (git-ref validated), or `undefined` for the default (production) stage. Alchemy's stage is the container's `alchemyStage` when supplied, with this value as the explicit-user-stage fallback; when neither exists, the CLI fails before Alchemy runs. */
  readonly stage: string | undefined;
}

/**
 * One resolved container. The framework sees only this interface; the
 * extension that produced the instance narrows it back to its own concrete
 * type wherever the framework hands it back (ADR-0037).
 */
export interface ContainerInstance {
  readonly input: LocateContainerInput;
  /** The exact string the CLI hands `alchemy` as its stage — the deploy-state scope. Distinct from `input.stage`, the user-facing name: for Prisma Cloud this is the resolved Branch id (stable across renames, machine-independent). Framework-visible like `input` — NOT part of the `serialize()` payload, which stays extension-owned. */
  readonly alchemyStage?: string | undefined;
  /** Serialize to a non-empty string for the process transport above. The format is the extension's own; only its `deserialize` reads it. */
  serialize(): string;
}

/**
 * What the caller has already authenticated, handed to one container
 * lifecycle call. A caller that holds neither omits the argument, and the
 * extension falls back to whatever credential protocol it defines for
 * itself (for Prisma Cloud, its env vars — which is how the alchemy child
 * process still resolves containers).
 *
 * `C` is the extension's own platform-client type, left as a type parameter
 * because this shared-plane module must not import a platform SDK; the
 * framework only carries the value, never calls it. The framework stores the
 * erased `C = unknown` form and the extension recovers its concrete client
 * through the same method bivariance that erases `I` below.
 */
export interface ContainerCredentials<C = unknown> {
  /** The workspace the container lives in. `undefined` when the caller has no workspace to name — the extension decides whether it can proceed. */
  readonly workspaceId: string | undefined;
  /** An already-authenticated platform API client. Present means the extension must not build its own from the environment. */
  readonly client?: C | undefined;
}

/**
 * The platform containers an app deploys into, as one lifecycle. `I` is
 * the extension's own instance type — the same descriptor produces and
 * consumes it, so the extension gets full typing internally while the
 * framework stores the erased form; `C` erases the same way. METHOD SYNTAX
 * REQUIRED on all four members: the erased assignment into
 * ExtensionDescriptor compiles only through method bivariance;
 * property-arrow members are checked contravariantly and the assignment
 * fails (same rule as ServiceLowering<P, S> — ADR-0033).
 */
export interface ContainerDescriptor<I extends ContainerInstance = ContainerInstance, C = unknown> {
  /** Resolve the container for (appName, stage), creating anything absent. Called by `deploy`. */
  ensure(input: LocateContainerInput, credentials?: ContainerCredentials<C>): Promise<I>;
  /** Find the container for (appName, stage); `undefined` when nothing exists. Called by `destroy` — never creates. */
  locate(
    input: LocateContainerInput,
    credentials?: ContainerCredentials<C>,
  ): Promise<I | undefined>;
  /** Remove the container after a successful destroy, after every extension's `teardown` has run. Failure policy is the extension's. */
  remove(instance: I, credentials?: ContainerCredentials<C>): Promise<void>;
  /** Reconstruct an instance from its own `serialize()` output — the far end of the framework's parent→child transport. */
  deserialize(serialized: string): I;
}

/** '@prisma/composer-prisma-cloud' → 'PRISMA_COMPOSER_CONTAINER_PRISMA_COMPOSER_PRISMA_CLOUD' */
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

/** The env entries the CLI sets on the alchemy process: `{ [containerEnvVarName(id)]: instance.serialize() }` for every resolved instance. */
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
 * The alchemy-process side: for each extension with a container descriptor
 * whose var is present in `env`, call its deserialize. Absent var → no entry.
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
