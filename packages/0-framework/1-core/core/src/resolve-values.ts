import { blindCast } from '@internal/foundation/casts';
import { isSecretString, SecretBox } from '@internal/foundation/secret';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  LoadError,
  type NodeId,
  type ParamBinding,
  type SecretSourceUse,
  type ServiceInputBinding,
} from './graph-types.ts';
import { inputFieldLabel } from './module-input.ts';
import {
  isParamSource,
  isSecretSource,
  isSourceMisuse,
  type ParamSource,
  type ResourceNode,
  type ResourceProps,
  type SecretSource,
  sourceOriginOf,
} from './node.ts';
import {
  type EnvironmentRealValues,
  type InputOrigin,
  isPlainObject,
  isValue,
  originOf,
  type Value,
} from './value.ts';

/** A provisioned module's input binding, recorded at its provision() call. Load validates it in the second pass; the graph does not carry it. */
export interface ProvisionedModuleInput {
  /** The module's address. */
  readonly moduleAddress: NodeId;
  /** The module's input schema. */
  readonly schema: StandardSchemaV1;
  /** The binding the provision() call supplied, values in place. */
  readonly binding: unknown;
}

export interface ValueBindingSite {
  /** The address of the node the binding belongs to. */
  readonly address: NodeId;
  /** `serviceInput` for a service input binding, `moduleInput` for a module's input binding, `param` for a service param, `props` for a resource's props. */
  readonly kind: 'serviceInput' | 'moduleInput' | 'param' | 'props';
  /** The param name for `param`; the dotted path inside the document for `serviceInput`, `moduleInput` and `props` (`''` at the root). Array members by index: `hosts.0`. */
  readonly path: string;
}

const SENTINEL_SOURCE = Symbol('prisma:module-input-sentinel');

function joinPath(path: string, key: string | number): string {
  return path === '' ? String(key) : `${path}.${key}`;
}

function describeSite(site: ValueBindingSite): string {
  switch (site.kind) {
    case 'serviceInput':
      return site.path === ''
        ? `the input binding of service "${site.address}"`
        : `input key "${site.path}" of service "${site.address}"`;
    case 'moduleInput':
      return site.path === ''
        ? `the input binding of module "${site.address}"`
        : `input key "${site.path}" of module "${site.address}"`;
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
  recordSecret: (source: SecretSource, site: ValueBindingSite) => void,
): void {
  if (isSecretSource(value) || isParamSource(value)) {
    if (isSecretSource(value) && site.kind !== 'props') recordSecret(value, site);
    if (site.kind === 'serviceInput' || site.kind === 'param' || !isValue(value)) return;
    found.push({ value, site });
    return;
  }
  if (isValue(value)) {
    found.push({ value, site });
    return;
  }
  if (!Array.isArray(value) && !isPlainObject(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  const entries: [string | number, unknown][] = Array.isArray(value)
    ? value.map((member, index) => [index, member])
    : Object.entries(value);
  for (const [key, member] of entries) {
    const path = site.kind === 'param' ? site.path : joinPath(site.path, key);
    collect(member, { ...site, path }, found, seen, recordSecret);
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
  if (isValue(value)) return false;
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function pointersIn(values: unknown): ReadonlySet<object> {
  const pointers = new Set<object>();
  const seen = new WeakSet<object>();
  const walk = (value: unknown): void => {
    if (isSecretSource(value) || isParamSource(value)) {
      pointers.add(value);
      return;
    }
    if (!Array.isArray(value) && !isPlainObject(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    for (const member of Array.isArray(value) ? value : Object.values(value)) walk(member);
  };
  walk(values);
  return pointers;
}

function checkResult(result: unknown, fnLabel: string, received: ReadonlySet<object>): void {
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
    if (isSecretSource(value) || isParamSource(value)) {
      if (received.has(value)) return;
      throw new LoadError(
        `${fnLabel} returned a source${atPath} it did not receive, such as envSecret() or envParam() called inside the function. A resolve() function may return a pointer it received from a dependency, unchanged; bind any other source directly.`,
      );
    }
    if (isValue(value)) {
      throw new LoadError(
        `${fnLabel} returned a value${atPath}, not a real value. List that value as a dependency; fn receives its real value.`,
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
  sources: 'keep' | 'resolve',
): unknown {
  if (isSecretSource(value) || isParamSource(value)) {
    return sources === 'keep' || !isValue(value) ? value : results.get(value);
  }
  if (isValue(value)) return results.get(value);
  if (Array.isArray(value)) {
    if (inProgress.has(value)) return value;
    inProgress.add(value);
    const rebuilt = value.map((member) => substitute(member, results, inProgress, sources));
    inProgress.delete(value);
    return rebuilt.every((member, index) => member === value[index]) ? value : rebuilt;
  }
  if (isPlainObject(value)) {
    if (inProgress.has(value)) return value;
    inProgress.add(value);
    const rebuilt: Record<string, unknown> = {};
    let changed = false;
    for (const [key, member] of Object.entries(value)) {
      const real = substitute(member, results, inProgress, sources);
      if (real === undefined && isValue(member)) {
        changed = true;
        continue;
      }
      rebuilt[key] = real;
      if (real !== member) changed = true;
    }
    inProgress.delete(value);
    return changed ? rebuilt : value;
  }
  return value;
}

function describeData(value: unknown): string {
  if (Array.isArray(value)) return 'an array';
  if (isSecretSource(value)) return 'a secret';
  if (isParamSource(value)) return 'a value known only at boot';
  if (typeof value === 'object') return 'an object that is not plain data';
  return `a ${typeof value}`;
}

/** The data at `origin`'s path inside a validated input; `undefined` where a key or a parent is absent. */
function readPath(data: unknown, origin: InputOrigin): unknown {
  let current = data;
  for (const [index, key] of origin.path.entries()) {
    if (current === undefined || current === null) return undefined;
    if (!isPlainObject(current) || isSecretSource(current) || isParamSource(current)) {
      const parent = inputFieldLabel({ ...origin, path: origin.path.slice(0, index) });
      throw new LoadError(
        `${inputFieldLabel(origin)} of module "${origin.module}" does not exist: ${parent} is ` +
          `${describeData(current)}, not a plain object, so it has no fields. ` +
          `To compute with it, list it: resolve([${parent}], ([v]) => …).`,
      );
    }
    if (!Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function validateModuleInput(entry: ProvisionedModuleInput, resolved: unknown): unknown {
  const address = entry.moduleAddress;
  const textPointers = new Map<string, ParamSource>();
  const taggedBox = (source: SecretSource | ParamSource): SecretBox<string> => {
    const sentinel = new SecretBox('');
    Object.defineProperty(sentinel, SENTINEL_SOURCE, { value: source });
    return sentinel;
  };
  const withSentinels = (value: unknown, path: string): unknown => {
    if (isSecretSource(value)) return taggedBox(value);
    if (isParamSource(value)) {
      const origin = sourceOriginOf(value);
      if (origin?.redacted) return taggedBox(value);
      if (origin?.sentinel !== undefined) {
        textPointers.set(path, value);
        return origin.sentinel;
      }
      throw new LoadError(
        `${describeSite({ address, kind: 'moduleInput', path })} is bound to a param source a module's input cannot take: it names no sentinel for the module's schema to check in its place, as a raw paramSource() does. Bind envParam(), generatedParam() or serviceOrigin(), or a value.`,
      );
    }
    if (isSecretString(value)) {
      throw new LoadError(
        `${describeSite({ address, kind: 'moduleInput', path })} is bound to a SecretString. A secret's value never appears in the code; bind envSecret('NAME'), or pass on an input field typed secretString().`,
      );
    }
    if (Array.isArray(value)) {
      return value.map((member, index) => withSentinels(member, joinPath(path, index)));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [
          key,
          withSentinels(member, joinPath(path, key)),
        ]),
      );
    }
    return value;
  };
  const result = entry.schema['~standard'].validate(withSentinels(resolved, ''));
  if (result instanceof Promise) {
    throw new LoadError(
      `The input schema of module "${address}" returned a Promise from validate(). A module's input is validated synchronously at Load; use a schema with no asynchronous checks.`,
    );
  }
  if (result.issues !== undefined) {
    const messages = result.issues.map((issue) => issue.message).join('; ');
    throw new LoadError(
      `The input binding of module "${address}" does not match the module's input schema: ${messages}`,
    );
  }
  const restore = (value: unknown, path: string): unknown => {
    const pointer = textPointers.get(path);
    if (pointer !== undefined) {
      const origin = sourceOriginOf(pointer);
      if (origin !== undefined && value === origin.sentinel) return pointer;
      throw new LoadError(
        `The input schema of module "${address}" changed input key "${path}", which is bound to ${origin?.label}. Its value is known only at boot, so a module's schema may check the field but never transform it.`,
      );
    }
    if (isSecretString(value)) {
      const tag = blindCast<
        Record<PropertyKey, unknown>,
        'reading the sentinel tag a module input validation put on its own SecretString box'
      >(value)[SENTINEL_SOURCE];
      if (isSecretSource(tag) || isParamSource(tag)) return tag;
      const atPath = path === '' ? '' : ` at "${path}"`;
      throw new LoadError(
        `The input schema of module "${address}" produced a SecretString${atPath} that its binding did not supply. A module's schema may check a secret field, never create one.`,
      );
    }
    if (Array.isArray(value)) {
      return value.map((member, index) => restore(member, joinPath(path, index)));
    }
    if (isPlainObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, member]) => [key, restore(member, joinPath(path, key))]),
      );
    }
    return value;
  };
  return restore(result.value, '');
}

function refusePointersInProps(address: NodeId, props: unknown): void {
  const seen = new WeakSet<object>();
  const walk = (value: unknown, path: string): void => {
    if (isSecretSource(value) || isParamSource(value)) {
      const label =
        sourceOriginOf(value)?.label ??
        (isSecretSource(value) ? 'a secret source' : 'a param source');
      throw new LoadError(
        `${describeSite({ address, kind: 'props', path })} is bound to ${label}, which is known only at boot. A resource's props are read at deploy; bind a value known at deploy.`,
      );
    }
    if (!Array.isArray(value) && !isPlainObject(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    const entries: [string | number, unknown][] = Array.isArray(value)
      ? value.map((member, index) => [index, member])
      : Object.entries(value);
    for (const [key, member] of entries) walk(member, joinPath(path, key));
  };
  walk(props, '');
}

/**
 * Resolves every value the graph binds, dependency-first, once each, and
 * returns each binding with its values replaced by their real values.
 */
export function resolveValues(input: {
  readonly environment: EnvironmentRealValues | undefined;
  readonly configPool: Readonly<Record<string, unknown>> | undefined;
  readonly inputBindings: readonly ServiceInputBinding[];
  readonly params: readonly ParamBinding[];
  readonly moduleInputs: readonly ProvisionedModuleInput[];
  readonly resources: ReadonlyMap<NodeId, ResourceNode>;
}): {
  readonly inputBindings: readonly ServiceInputBinding[];
  readonly params: readonly ParamBinding[];
  readonly resourceProps: ReadonlyMap<NodeId, ResourceProps>;
  readonly secretSources: readonly SecretSourceUse[];
} {
  const { environment, configPool } = input;
  const secretSources: SecretSourceUse[] = [];
  const recorded = new Set<SecretSource>();
  const recordSecret = (source: SecretSource, site: ValueBindingSite): void => {
    const original = sourceOriginOf(source)?.source;
    const canonical = isSecretSource(original) ? original : source;
    if (recorded.has(canonical)) return;
    recorded.add(canonical);
    secretSources.push({
      source: canonical,
      address: site.address,
      nodeKind: site.kind === 'moduleInput' ? 'module' : 'service',
    });
  };

  const found: { value: Value<unknown>; site: ValueBindingSite }[] = [];
  for (const { serviceAddress, binding } of input.inputBindings) {
    const site: ValueBindingSite = { address: serviceAddress, kind: 'serviceInput', path: '' };
    collect(binding, site, found, new WeakSet(), recordSecret);
  }
  for (const { serviceAddress, slot, binding } of input.params) {
    const site: ValueBindingSite = { address: serviceAddress, kind: 'param', path: slot };
    collect(binding, site, found, new WeakSet(), recordSecret);
  }
  for (const [address, resource] of input.resources) {
    const site: ValueBindingSite = { address, kind: 'props', path: '' };
    collect(resource.props, site, found, new WeakSet(), recordSecret);
  }

  const moduleInputByAddress = new Map(
    input.moduleInputs.map((entry) => [entry.moduleAddress, entry]),
  );
  const validatedInputs = new Map<NodeId, unknown>();
  const validating = new Set<NodeId>();

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
      case 'source': {
        if (isSecretSource(origin.source)) recordSecret(origin.source, site);
        if (origin.poolKey === undefined) {
          result = origin.source;
        } else if (configPool === undefined) {
          throw new LoadError(
            `${describeSite(site)} depends on ${origin.label}, but Load was given no config pool to read "${origin.poolKey}" from. Pass { configPool } to Load; the deploy and dev commands pass the process environment.`,
          );
        } else {
          const raw = configPool[origin.poolKey];
          result = raw === undefined || raw === '' ? undefined : raw;
        }
        break;
      }
      case 'computed': {
        const args = origin.dependencies.map((dependency) => {
          const real = resolveOne(dependency, site);
          const source = originOf(dependency);
          if (real === undefined && source.kind === 'source') {
            throw new LoadError(
              `${fnLabelFor(site)} lists ${source.label}, but "${source.poolKey}" is unset or empty, so it has no real value. Set "${source.poolKey}", or bind ${source.label} directly into an input binding, where an absent value leaves the key out and the schema decides.`,
            );
          }
          return real;
        });
        try {
          result = origin.compute(args);
        } catch (thrown) {
          if (thrown instanceof LoadError && !isSourceMisuse(thrown)) throw thrown;
          const message = thrown instanceof Error ? thrown.message : String(thrown);
          throw new LoadError(`${fnLabelFor(site)} threw: ${message}`, { cause: thrown });
        }
        checkResult(result, fnLabelFor(site), pointersIn(args));
        break;
      }
      case 'input': {
        const entry = moduleInputByAddress.get(origin.module);
        if (entry === undefined) {
          throw new LoadError(
            `${describeSite(site)} depends on ${inputFieldLabel(origin)} of module "${origin.module}", which this Load does not provision. An input field can be passed on only inside the body of the module that received it.`,
          );
        }
        result = readPath(validatedInputOf(entry), origin);
        break;
      }
    }
    visiting.pop();
    results.set(value, result);
    return result;
  };

  const validatedInputOf = (entry: ProvisionedModuleInput): unknown => {
    if (validatedInputs.has(entry.moduleAddress)) return validatedInputs.get(entry.moduleAddress);
    if (validating.has(entry.moduleAddress)) {
      throw new LoadError(
        `The input binding of module "${entry.moduleAddress}" depends on that module's own input. Remove the cycle.`,
      );
    }
    validating.add(entry.moduleAddress);
    const site: ValueBindingSite = { address: entry.moduleAddress, kind: 'moduleInput', path: '' };
    const values: { value: Value<unknown>; site: ValueBindingSite }[] = [];
    collect(entry.binding, site, values, new WeakSet(), recordSecret);
    for (const { value, site: valueSite } of values) resolveOne(value, valueSite);
    const resolved = substitute(entry.binding, results, new WeakSet(), 'resolve');
    const validated = validateModuleInput(entry, resolved);
    validating.delete(entry.moduleAddress);
    validatedInputs.set(entry.moduleAddress, validated);
    return validated;
  };

  for (const entry of input.moduleInputs) validatedInputOf(entry);
  for (const { value, site } of found) resolveOne(value, site);

  const authoredProps = new Map(
    [...input.resources].map(([address, resource]) => [address, resource.props]),
  );
  if (found.length === 0) {
    for (const [address, props] of authoredProps) refusePointersInProps(address, props);
    return {
      inputBindings: input.inputBindings,
      params: input.params,
      resourceProps: authoredProps,
      secretSources,
    };
  }

  const inProgress = new WeakSet<object>();
  const resourceProps = new Map<NodeId, ResourceProps>();
  for (const [address, props] of authoredProps) {
    const substituted = substitute(props, results, inProgress, 'resolve');
    refusePointersInProps(address, substituted);
    const resolvedProps =
      substituted === props
        ? props
        : blindCast<
            ResourceProps,
            'substitution rebuilds the plain props object, replacing each Value<PlainData> with its real value: an environment or computed value is plain data or a pointer it received, which checkResult checked, an input field is its module schema output, and the pointer check above refused any pointer left'
          >(substituted);
    resourceProps.set(address, resolvedProps);
  }
  return {
    resourceProps,
    secretSources,
    inputBindings: input.inputBindings.map((entry) => {
      const binding = substitute(entry.binding, results, inProgress, 'keep');
      return binding === entry.binding
        ? entry
        : {
            serviceAddress: entry.serviceAddress,
            binding: blindCast<
              ServiceInputBinding['binding'],
              'substitution replaces each value with its real value and keeps every source in place: an environment or computed value is plain data or a pointer it received, which checkResult checked, and an input field is its module schema output with each pointer put back; the service schema validates the whole binding again when the target serializes it'
            >(binding),
          };
    }),
    params: input.params.flatMap((entry) => {
      const binding = substitute(entry.binding, results, inProgress, 'keep');
      if (binding === undefined && isValue(entry.binding)) return [];
      return [binding === entry.binding ? entry : { ...entry, binding }];
    }),
  };
}
