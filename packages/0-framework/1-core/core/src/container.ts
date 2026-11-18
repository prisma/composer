/** The platform containers an extension resolves an app's environment into (ADR-0037, ADR-0038). */

import type { CallerCredentials } from './caller-credentials.ts';

/** The key an extension resolves a container from: which app, which environment. */
export interface LocateContainerInput {
  /** The application name (root node's name, or `--name`). */
  readonly appName: string;
  /** The environment name, git-ref validated. Core never interprets it; the extension maps it onto its platform. */
  readonly environment: string;
}

/**
 * One resolved container. The framework sees only this interface; the
 * extension that produced the instance narrows it back to its own concrete
 * type wherever the framework hands it back (ADR-0037).
 */
export interface ContainerInstance {
  readonly input: LocateContainerInput;
  /** The exact string the CLI hands `alchemy` as its stage — the deploy-state scope. Distinct from `input.environment`: for Prisma Cloud this is the resolved Branch id (stable across renames, machine-independent). Framework-visible like `input` — NOT part of the `serialize()` payload, which stays extension-owned. */
  readonly alchemyStage?: string | undefined;
  /** Serialize to a non-empty string. The format is the extension's own; only its `deserialize` reads it. */
  serialize(): string;
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
  /** Resolve the container for (appName, environment), creating anything absent. Called by `deploy`. */
  ensure(input: LocateContainerInput, credentials?: CallerCredentials<C>): Promise<I>;
  /** Find the container for (appName, environment); `undefined` when nothing exists. Called by `destroy` — never creates. */
  locate(input: LocateContainerInput, credentials?: CallerCredentials<C>): Promise<I | undefined>;
  /** Remove the container after a successful destroy, after every extension's `teardown` has run. Failure policy is the extension's. */
  remove(instance: I, credentials?: CallerCredentials<C>): Promise<void>;
  /** Reconstruct an instance from its own `serialize()` output. */
  deserialize(serialized: string): I;
}
