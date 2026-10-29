import { blindCast } from '@internal/foundation/casts';
import {
  LoadError,
  type NodeId,
  type ParamBinding,
  type ServiceInputBinding,
} from './graph-types.ts';
import { isParamSource, isSecretSource, type ResourceNode, type ResourceProps } from './node.ts';
import { isPlainObject, isValue, originOf, type Value } from './value.ts';

export interface ValueBindingSite {
  /** The address of the node the binding belongs to. */
  readonly address: NodeId;
  /** `input` for a service input binding, `param` for a service param, `props` for a resource's props. */
  readonly channel: 'input' | 'param' | 'props';
  /** The param name for `param`; the dotted path inside the document for `input` and `props` (`''` at the root). Array members by index: `hosts.0`. */
  readonly path: string;
}

function joinPath(path: string, key: string | number): string {
  return path === '' ? String(key) : `${path}.${key}`;
}

function describeSite(site: ValueBindingSite): string {
  switch (site.channel) {
    case 'input':
      return site.path === ''
        ? `the input binding of service "${site.address}"`
        : `input key "${site.path}" of service "${site.address}"`;
    case 'param':
      return `param "${site.path}" of service "${site.address}"`;
    case 'props':
      return site.path === ''
        ? `the props of resource "${site.address}"`
        : `prop "${site.path}" of resource "${site.address}"`;
  }
}

function collect(
  value: unknown,
  site: ValueBindingSite,
  found: { value: Value<unknown>; site: ValueBindingSite }[],
  seen: WeakSet<object>,
): void {
  if (isValue(value)) {
    found.push({ value, site });
    return;
  }
  if (isSecretSource(value) || isParamSource(value)) return;
  if (!Array.isArray(value) && !isPlainObject(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((member, index) => [index, member])
    : Object.entries(value);
  for (const [key, member] of entries) {
    const path = site.channel === 'param' ? site.path : joinPath(site.path, key);
    collect(member, { ...site, path }, found, seen);
  }
}

function describeNotPlain(value: unknown): string | undefined {
  switch (typeof value) {
    case 'function':
      return 'a function';
    case 'symbol':
      return 'a symbol';
    case 'bigint':
      return 'a bigint';
    case 'number':
      return Number.isFinite(value) ? undefined : 'a non-finite number';
    case 'object':
      return value === null || Array.isArray(value) || isPlainObject(value)
        ? undefined
        : 'an object that is not plain data';
    default:
      return undefined;
  }
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function checkResult(result: unknown, fnLabel: string): void {
  if (isThenable(result)) {
    throw new LoadError(`${fnLabel} returned a Promise. resolve() runs synchronously at Load.`);
  }
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string): void => {
    const atPath = path === '' ? '' : ` at "${path}"`;
    if (value === undefined) {
      throw new LoadError(
        `${fnLabel} returned undefined${atPath}. Return a result for every environment; Composer never picks a default.`,
      );
    }
    if (isValue(value)) {
      throw new LoadError(
        `${fnLabel} returned a value${atPath}, not a real value. List that value as a dependency; fn receives its real value.`,
      );
    }
    if (isSecretSource(value) || isParamSource(value)) {
      throw new LoadError(
        `${fnLabel} returned a secret or param source${atPath}. Bind envSecret() or envParam() directly; resolve() returns plain data.`,
      );
    }
    const notPlain = describeNotPlain(value);
    if (notPlain !== undefined) {
      throw new LoadError(
        `${fnLabel} returned ${notPlain}${atPath}. resolve() returns plain data: strings, finite numbers, booleans, null, arrays and plain objects.`,
      );
    }
    if (typeof value !== 'object' || value === null || seen.has(value)) return;
    seen.add(value);
    const entries: [string | number, unknown][] = Array.isArray(value)
      ? value.map((member, index) => [index, member])
      : Object.entries(value);
    for (const [key, member] of entries) walk(member, joinPath(path, key));
  };
  walk(result, '');
}

function substitute(
  value: unknown,
  results: ReadonlyMap<Value<unknown>, unknown>,
  inProgress: WeakSet<object>,
): unknown {
  if (isValue(value)) return results.get(value);
  if (isSecretSource(value) || isParamSource(value)) return value;
  if (Array.isArray(value)) {
    if (inProgress.has(value)) return value;
    inProgress.add(value);
    const rebuilt = value.map((member) => substitute(member, results, inProgress));
    inProgress.delete(value);
    return rebuilt.every((member, index) => member === value[index]) ? value : rebuilt;
  }
  if (isPlainObject(value)) {
    if (inProgress.has(value)) return value;
    inProgress.add(value);
    const rebuilt: Record<string, unknown> = {};
    let changed = false;
    for (const [key, member] of Object.entries(value)) {
      rebuilt[key] = substitute(member, results, inProgress);
      if (rebuilt[key] !== member) changed = true;
    }
    inProgress.delete(value);
    return changed ? rebuilt : value;
  }
  return value;
}

/**
 * Resolves every value the graph binds, dependency-first, once each, and
 * returns each binding with its values replaced by their real values.
 */
export function resolveValues(input: {
  readonly environment: { readonly name: string } | undefined;
  readonly inputBindings: readonly ServiceInputBinding[];
  readonly params: readonly ParamBinding[];
  readonly resources: ReadonlyMap<NodeId, ResourceNode>;
}): {
  readonly inputBindings: readonly ServiceInputBinding[];
  readonly params: readonly ParamBinding[];
  readonly resourceProps: ReadonlyMap<NodeId, ResourceProps>;
} {
  const { environment } = input;
  const found: { value: Value<unknown>; site: ValueBindingSite }[] = [];
  for (const { serviceAddress, binding } of input.inputBindings) {
    const site: ValueBindingSite = { address: serviceAddress, channel: 'input', path: '' };
    collect(binding, site, found, new WeakSet());
  }
  for (const { serviceAddress, slot, binding } of input.params) {
    const site: ValueBindingSite = { address: serviceAddress, channel: 'param', path: slot };
    collect(binding, site, found, new WeakSet());
  }
  for (const [address, resource] of input.resources) {
    const site: ValueBindingSite = { address, channel: 'props', path: '' };
    collect(resource.props, site, found, new WeakSet());
  }

  const results = new Map<Value<unknown>, unknown>();
  const visiting: Value<unknown>[] = [];

  const fnLabelFor = (site: ValueBindingSite): string =>
    visiting.length === 1
      ? `The resolve() function for ${describeSite(site)}`
      : `A resolve() function that ${describeSite(site)} depends on`;

  const resolveOne = (value: Value<unknown>, site: ValueBindingSite): unknown => {
    if (results.has(value)) return results.get(value);
    if (visiting.includes(value)) {
      throw new LoadError(
        `${describeSite(site)} depends on itself: a computed value's dependencies lead back to it. Remove the cycle.`,
      );
    }
    visiting.push(value);
    const origin = originOf(value);
    let result: unknown;
    switch (origin.kind) {
      case 'environment':
        if (environment === undefined) {
          throw new LoadError(
            `${describeSite(site)} depends on environment.name, but Load was given no environment. Pass { environment: { name } } to Load; the deploy and dev commands do.`,
          );
        }
        result = environment[origin.fact];
        break;
      case 'computed': {
        const args = origin.dependencies.map((dependency) => resolveOne(dependency, site));
        try {
          result = origin.compute(args);
        } catch (thrown) {
          if (thrown instanceof LoadError) throw thrown;
          const message = thrown instanceof Error ? thrown.message : String(thrown);
          throw new LoadError(`${fnLabelFor(site)} threw: ${message}`, { cause: thrown });
        }
        checkResult(result, fnLabelFor(site));
        break;
      }
    }
    visiting.pop();
    results.set(value, result);
    return result;
  };

  for (const { value, site } of found) resolveOne(value, site);

  const authoredProps = new Map(
    [...input.resources].map(([address, resource]) => [address, resource.props]),
  );
  if (found.length === 0) {
    return {
      inputBindings: input.inputBindings,
      params: input.params,
      resourceProps: authoredProps,
    };
  }

  const inProgress = new WeakSet<object>();
  const resourceProps = new Map<NodeId, ResourceProps>();
  for (const [address, props] of authoredProps) {
    const substituted = substitute(props, results, inProgress);
    resourceProps.set(
      address,
      substituted === props
        ? props
        : blindCast<
            ResourceProps,
            'substitution rebuilds the plain props object, replacing each Value<PlainValue> with its real value, which checkResult proved plain data, so ResourceProps stays ResourceProps'
          >(substituted),
    );
  }
  return {
    resourceProps,
    inputBindings: input.inputBindings.map((entry) => {
      const binding = substitute(entry.binding, results, inProgress);
      return binding === entry.binding
        ? entry
        : {
            serviceAddress: entry.serviceAddress,
            binding: blindCast<
              ServiceInputBinding['binding'],
              'substitution replaces each Value<PlainValue> with its real value, which checkResult proved plain data, and keeps every other member, so an InputBinding stays an InputBinding'
            >(binding),
          };
    }),
    params: input.params.map((entry) => {
      const binding = substitute(entry.binding, results, inProgress);
      return binding === entry.binding ? entry : { ...entry, binding };
    }),
  };
}
