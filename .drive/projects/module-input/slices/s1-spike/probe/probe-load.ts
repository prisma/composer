/**
 * A probe-sized Load for modules that take `input`. It reuses core's value
 * brand, `resolve()`, `isValue()` and `originOf()` unchanged and adds only
 * what the spike asks about: the body's `input`, a module child's input
 * binding, and an 'input' case in the second pass.
 */
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  environmentFacts,
  type InputBinding,
  isPlainObject,
  isSecretSource,
  isValue,
  originOf,
  SecretBox,
  type SecretSource,
  type SecretString,
  type Value,
} from './core.ts';
import {
  describeInputOrigin,
  type InputOrigin,
  type InputValues,
  inputOriginOf,
  inputValues,
} from './input-value.ts';

type PlainObject = { readonly [key: string]: unknown };

/** What a binding may hold where the child's schema expects `T`: the data, a value standing for it, or (for a secret) a source. */
export type Bindable<T> =
  | Value<T>
  | (T extends SecretString
      ? T | SecretSource
      : T extends readonly (infer E)[]
        ? T | readonly Bindable<E>[]
        : T extends PlainObject
          ? {
              readonly [K in keyof T]:
                | Bindable<T[K]>
                | ({} extends Pick<T, K> ? Value<T[K] | undefined> : never);
            }
          : T);

export interface ProbeModule<S extends StandardSchemaV1> {
  readonly kind: 'probe-module';
  readonly name: string;
  readonly inputSchema: S;
  readonly body: (ctx: ProbeContext<S>) => void;
}

interface ServiceLike {
  readonly kind: 'service';
  readonly name: string;
  readonly inputSchema: StandardSchemaV1 | undefined;
}

export interface ProbeProvision {
  <S extends StandardSchemaV1>(
    child: ProbeModule<S>,
    opts: { readonly id?: string; readonly input: Bindable<StandardSchemaV1.InferInput<S>> },
  ): void;
  (service: ServiceLike, opts: { readonly id?: string; readonly input: InputBinding }): void;
}

export interface ProbeContext<S extends StandardSchemaV1> {
  readonly input: InputValues<S>;
  readonly environment: typeof environmentFacts;
  readonly provision: ProbeProvision;
}

export function probeModule<S extends StandardSchemaV1>(
  name: string,
  boundary: { readonly input: S },
  body: (ctx: ProbeContext<S>) => void,
): ProbeModule<S> {
  return Object.freeze({ kind: 'probe-module' as const, name, inputSchema: boundary.input, body });
}

export interface Site {
  readonly address: string;
  readonly kind: 'module input' | 'service input';
  readonly path: string;
}

export interface ProbeGraph {
  /** Each provisioned module's input binding, as authored, by address. The root's comes from the config pool. */
  readonly moduleBindings: ReadonlyMap<string, unknown>;
  readonly moduleSchemas: ReadonlyMap<string, StandardSchemaV1>;
  /** Each provisioned service's input binding, as authored. */
  readonly serviceBindings: readonly { readonly address: string; readonly binding: unknown }[];
}

/** First pass: run every module body, recording bindings with their values in place. */
export function loadFirstPass<S extends StandardSchemaV1>(
  rootNode: ProbeModule<S>,
  rootInput: unknown,
): ProbeGraph {
  const root = rootNode as unknown as ProbeModule<StandardSchemaV1>;
  const moduleBindings = new Map<string, unknown>([[root.name, rootInput]]);
  const moduleSchemas = new Map<string, StandardSchemaV1>([[root.name, root.inputSchema]]);
  const serviceBindings: { address: string; binding: unknown }[] = [];

  const run = (node: ProbeModule<StandardSchemaV1>, address: string): void => {
    const provision = (
      child: ProbeModule<StandardSchemaV1> | ServiceLike,
      opts: { id?: string; input: unknown },
    ) => {
      const childAddress = `${address}.${opts.id ?? child.name}`;
      if (child.kind === 'service') {
        serviceBindings.push({ address: childAddress, binding: opts.input });
        return;
      }
      moduleBindings.set(childAddress, opts.input);
      moduleSchemas.set(childAddress, child.inputSchema);
      run(child, childAddress);
    };
    node.body({
      input: inputValues(address),
      environment: environmentFacts,
      provision: provision as ProbeProvision,
    });
  };
  run(root, root.name);
  return { moduleBindings, moduleSchemas, serviceBindings };
}

function joinPath(path: string, key: string | number): string {
  return path === '' ? String(key) : `${path}.${key}`;
}

/** Every value in a binding, with the path it sits at. Stops at a value, as core's collect() does. */
function valuesIn(binding: unknown, path = ''): { path: string; value: Value<unknown> }[] {
  if (isValue(binding)) return [{ path, value: binding }];
  if (isSecretSource(binding)) return [];
  if (Array.isArray(binding))
    return binding.flatMap((member, index) => valuesIn(member, joinPath(path, index)));
  if (isPlainObject(binding)) {
    return Object.entries(binding).flatMap(([key, member]) =>
      valuesIn(member, joinPath(path, key)),
    );
  }
  return [];
}

function describeValue(value: Value<unknown>): string {
  const input = inputOriginOf(value);
  if (input !== undefined) return describeInputOrigin(input);
  const origin = originOf(value);
  if (origin.kind === 'environment') return `environment.${origin.fact}`;
  return `resolve() over [${origin.dependencies.map(describeValue).join(', ')}]`;
}

/** Q2: what Load can report, from the bindings alone, about which input field flows where. */
export function describeFlows(graph: ProbeGraph): string[] {
  const lines: string[] = [];
  const sites: [string, unknown][] = [
    ...[...graph.moduleBindings].map(([address, binding]): [string, unknown] => [
      `module "${address}"`,
      binding,
    ]),
    ...graph.serviceBindings.map(({ address, binding }): [string, unknown] => [
      `service "${address}"`,
      binding,
    ]),
  ];
  for (const [label, binding] of sites) {
    for (const { path, value } of valuesIn(binding)) {
      lines.push(
        `${label} input ${path === '' ? '(whole)' : `"${path}"`} <- ${describeValue(value)}`,
      );
    }
  }
  return lines;
}

export class ProbeLoadError extends Error {
  override readonly name = 'ProbeLoadError';
}

// Carried on each sentinel box as an own property, because ArkType clones its input when the schema has a
// morph, and the clone is a different object: an identity map from sentinel to source would miss it.
const SENTINEL_SOURCE = Symbol('probe:sentinel-source');

/**
 * Validates a module's resolved binding synchronously, as the service input
 * serializer does: each secret source is swapped for a sentinel box, and each
 * sentinel in the output is swapped back for its source.
 */
function validateModuleInput(
  address: string,
  schema: StandardSchemaV1,
  resolved: unknown,
): unknown {
  const withSentinels = (value: unknown): unknown => {
    if (isSecretSource(value)) {
      const sentinel = new SecretBox('');
      Object.defineProperty(sentinel, SENTINEL_SOURCE, { value });
      return sentinel;
    }
    if (Array.isArray(value)) return value.map(withSentinels);
    if (isPlainObject(value))
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withSentinels(v)]));
    return value;
  };
  const result = schema['~standard'].validate(withSentinels(resolved));
  if (result instanceof Promise) {
    throw new ProbeLoadError(
      `The input schema of module "${address}" is async. A module's input is validated synchronously at Load.`,
    );
  }
  if (result.issues !== undefined) {
    const messages = result.issues
      .map(
        (issue) =>
          `${issue.path?.map((p) => (typeof p === 'object' ? p.key : p)).join('.') ?? ''}: ${issue.message}`,
      )
      .join('; ');
    throw new ProbeLoadError(`The input binding of module "${address}" is invalid: ${messages}`);
  }
  const restore = (value: unknown): unknown => {
    if (isSecretSource(value)) return value;
    if (value instanceof SecretBox) {
      const source = (value as unknown as Record<symbol, SecretSource | undefined>)[
        SENTINEL_SOURCE
      ];
      if (source === undefined)
        throw new ProbeLoadError(
          `module "${address}": the schema minted a SecretString the binding did not supply.`,
        );
      return source;
    }
    if (Array.isArray(value)) return value.map(restore);
    if (isPlainObject(value))
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, restore(v)]));
    return value;
  };
  return restore(result.value);
}

function readPath(data: unknown, path: readonly string[]): unknown {
  let current = data;
  for (const key of path) {
    if (!isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * Second pass: every value's real value, dependency-first. The 'environment'
 * and 'computed' cases are core's; 'input' is the case this probe adds.
 */
export function loadSecondPass(
  graph: ProbeGraph,
  environment: { readonly name: string },
): {
  readonly moduleInputs: ReadonlyMap<string, unknown>;
  readonly serviceBindings: readonly { readonly address: string; readonly binding: unknown }[];
} {
  const results = new Map<Value<unknown>, unknown>();
  const moduleInputs = new Map<string, unknown>();

  const moduleInput = (address: string): unknown => {
    if (moduleInputs.has(address)) return moduleInputs.get(address);
    const schema = graph.moduleSchemas.get(address);
    if (schema === undefined) throw new ProbeLoadError(`no module at "${address}"`);
    const validated = validateModuleInput(
      address,
      schema,
      substitute(graph.moduleBindings.get(address)),
    );
    moduleInputs.set(address, validated);
    return validated;
  };

  const resolveOne = (value: Value<unknown>): unknown => {
    if (results.has(value)) return results.get(value);
    const input: InputOrigin | undefined = inputOriginOf(value);
    let result: unknown;
    if (input !== undefined) {
      result = readPath(moduleInput(input.module), input.path);
    } else {
      const origin = originOf(value);
      result =
        origin.kind === 'environment'
          ? environment[origin.fact]
          : origin.compute(origin.dependencies.map(resolveOne));
    }
    results.set(value, result);
    return result;
  };

  // Core's substitute(), plus one rule: an object key whose real value is undefined is left out.
  function substitute(binding: unknown): unknown {
    if (isValue(binding)) return resolveOne(binding);
    if (isSecretSource(binding)) return binding;
    if (Array.isArray(binding)) return binding.map(substitute);
    if (isPlainObject(binding)) {
      const out: Record<string, unknown> = {};
      for (const [key, member] of Object.entries(binding)) {
        const real = substitute(member);
        if (real !== undefined) out[key] = real;
      }
      return out;
    }
    return binding;
  }

  for (const address of graph.moduleBindings.keys()) moduleInput(address);
  const serviceBindings = graph.serviceBindings.map(({ address, binding }) => ({
    address,
    binding: substitute(binding),
  }));
  return { moduleInputs, serviceBindings };
}
