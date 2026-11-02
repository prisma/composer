import { blindCast } from '@internal/foundation/casts';
import { describeKind } from '@internal/foundation/errors';
import { isSecretPointer } from '@internal/foundation/pointer';
import { isSecretString } from '@internal/foundation/secret';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type AppConfigurationRead,
  type InputBindingUse,
  LoadError,
  type NodeId,
  type ParamBinding,
  type RootInputField,
  type SecretSourceUse,
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
  /** True for the root, whose binding is the app configuration. */
  readonly isRoot: boolean;
  /** For the root in the second process: its fields as the first process checked them. The root's schema does not run. */
  readonly checked?: readonly RootInputField[];
}

export interface ValueBindingSite {
  /** The address of the node the binding belongs to. */
  readonly address: NodeId;
  /** `serviceInput` for a service input binding, `moduleInput` for a module's input binding, `param` for a service param, `props` for a resource's props. */
  readonly kind: 'serviceInput' | 'moduleInput' | 'param' | 'props';
  /** The param name for `param`; the dotted path inside the document for `serviceInput`, `moduleInput` and `props` (`''` at the root). Array members by index: `hosts.0`. */
  readonly path: string;
}

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

/** How `value` would not survive `JSON.stringify` and `JSON.parse` unchanged, or `undefined` when it would. A key whose value is `undefined` is dropped, which a body cannot tell from absent. */
function jsonInexactKind(value: unknown): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? undefined : 'a non-finite number';
  if (Array.isArray(value)) {
    for (const member of value) {
      if (member === undefined) return 'an array with a missing member';
      const kind = jsonInexactKind(member);
      if (kind !== undefined) return kind;
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    for (const member of Object.values(value)) {
      if (member === undefined) continue;
      const kind = jsonInexactKind(member);
      if (kind !== undefined) return kind;
    }
    return undefined;
  }
  return describeNotPlain(value) ?? describeKind(value);
}

const SAME_GRAPH_ADVICE =
  'A module body must build the same graph every time; one that reads the process environment, a file or the clock can build a different one.';

function isThenable(value: unknown): boolean {
  if (isValue(value)) return false;
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof value.then === 'function'
  );
}

function canonicalSecret(source: SecretSource): SecretSource {
  const original = sourceOriginOf(source)?.source;
  return isSecretSource(original) ? original : source;
}

function nodeKindOf(site: ValueBindingSite): SecretSourceUse['nodeKind'] {
  switch (site.kind) {
    case 'serviceInput':
    case 'param':
      return 'service';
    case 'moduleInput':
      return 'module';
    case 'props':
      return 'resource';
  }
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
    if (isSecretSource(value) || isParamSource(value)) {
      throw new LoadError(
        `${fnLabel} returned a source${atPath}, such as envSecret() or envParam() called inside the function. resolve() returns plain data; bind a source directly.`,
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

/** The first pointer in `value`, at any depth through arrays and plain objects, with its key path; `undefined` when there is none. */
function firstPointer(
  value: unknown,
  path: readonly string[] = [],
  seen = new WeakSet<object>(),
): { readonly pointer: ParamSource | SecretSource; readonly path: readonly string[] } | undefined {
  if (isSecretSource(value) || isParamSource(value)) return { pointer: value, path };
  if (!Array.isArray(value) && !isPlainObject(value)) return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((member, index) => [String(index), member])
    : Object.entries(value);
  for (const [key, member] of entries) {
    const found = firstPointer(member, [...path, key], seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Refuses a resolve() dependency whose real value is a pointer or holds one at any depth: `fn` computes with deploy-time data only. */
function refusePointerDependency(fnLabel: string, dependency: Value<unknown>, real: unknown): void {
  const found = firstPointer(real);
  if (found === undefined) return;
  const label = sourceOriginOf(found.pointer)?.label ?? 'a value known only at boot';
  const origin = originOf(dependency);
  if (origin.kind !== 'input') {
    throw new LoadError(
      `${fnLabel} lists ${label}, which is known only at boot. A resolve() dependency must be a deploy-time value. Bind ${label} directly into the input of the service that reads it.`,
    );
  }
  const listed = `${inputFieldLabel(origin)} of module "${origin.module}"`;
  const field = inputFieldLabel({ ...origin, path: [...origin.path, ...found.path] });
  const holds =
    found.path.length === 0 ? `whose real value is ${label}` : `which holds ${label} at ${field}`;
  const advice = isSecretPointer(found.pointer)
    ? `A secret has no deploy-time value: pass ${field} on into a binding, and read it in the service.`
    : `To compute with ${field}, declare it plain, without field(), and bind it to deploy-time data.`;
  throw new LoadError(
    `${fnLabel} lists ${listed}, ${holds}, a value known only at boot. A resolve() dependency must be a deploy-time value. ${advice}`,
  );
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
  if (typeof value === 'object') return 'an object that is not plain data';
  return `a ${typeof value}`;
}

/** The data at `origin`'s path inside a validated input; `undefined` where a key or a parent is absent. */
function readPath(data: unknown, origin: InputOrigin): unknown {
  let current = data;
  for (const [index, key] of origin.path.entries()) {
    if (current === undefined || current === null) return undefined;
    const missing = `${inputFieldLabel(origin)} of module "${origin.module}" does not exist`;
    const parent = inputFieldLabel({ ...origin, path: origin.path.slice(0, index) });
    const schemaAdvice = `The module's input schema must output a plain object for its body to read fields.`;
    if (isSecretSource(current) || isParamSource(current)) {
      throw new LoadError(
        `${missing}: ${parent} stands for a value only the platform has at boot, so it has no fields` +
          (index === 0 ? `. ${schemaAdvice}` : ' and can only be passed on unchanged.'),
      );
    }
    if (!isPlainObject(current)) {
      const advice =
        index === 0
          ? schemaAdvice
          : `To compute with it, it must be a plain field, not a wrapped or secret one; list it: resolve([${parent}], ([v]) => …).`;
      throw new LoadError(
        `${missing}: ${parent} is ${describeData(current)}, not a plain object, so it has no fields. ${advice}`,
      );
    }
    if (!Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function refuseSecretBoxes(address: NodeId, value: unknown, path: string): void {
  if (isSecretSource(value) || isParamSource(value)) return;
  if (isSecretString(value)) {
    throw new LoadError(
      `${describeSite({ address, kind: 'moduleInput', path })} is bound to a SecretString. A secret's value never appears in the code; bind envSecret('NAME'), or pass on an input field typed secretString().`,
    );
  }
  if (Array.isArray(value)) {
    for (const [index, member] of value.entries()) {
      refuseSecretBoxes(address, member, joinPath(path, index));
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, member] of Object.entries(value)) {
      refuseSecretBoxes(address, member, joinPath(path, key));
    }
  }
}

/** The original source each runtime value in `value` names, by its path. */
function sourcesByPath(
  value: unknown,
  path = '',
  found = new Map<string, ParamSource | SecretSource>(),
) {
  if (isSecretSource(value) || isParamSource(value)) {
    found.set(path, sourceOriginOf(value)?.source ?? value);
  } else if (Array.isArray(value)) {
    for (const [index, member] of value.entries()) {
      sourcesByPath(member, joinPath(path, index), found);
    }
  } else if (isPlainObject(value)) {
    for (const [key, member] of Object.entries(value)) {
      sourcesByPath(member, joinPath(path, key), found);
    }
  }
  return found;
}

function validateModuleInput(
  entry: ProvisionedModuleInput,
  resolved: unknown,
  environment: EnvironmentRealValues | undefined,
): unknown {
  const address = entry.moduleAddress;
  refuseSecretBoxes(address, resolved, '');
  const result = entry.schema['~standard'].validate(resolved);
  if (result instanceof Promise) {
    throw new LoadError(
      `The input schema of module "${address}" returned a Promise from validate(). A module's input is validated synchronously at Load; use a schema with no asynchronous checks.`,
    );
  }
  if (result.issues !== undefined) {
    const messages = result.issues.map((issue) => issue.message).join('; ');
    if (entry.isRoot) {
      const forEnvironment =
        environment === undefined ? '' : ` for the environment "${environment.name}"`;
      throw new LoadError(
        `The input of root module "${address}" does not match its input schema: ${messages}. A root's input is the values the \`config\` adapters in prisma.config.ts return${forEnvironment}.`,
      );
    }
    throw new LoadError(
      `The input binding of module "${address}" does not match the module's input schema: ${messages}`,
    );
  }
  const bound = sourcesByPath(resolved);
  const onlyChecked =
    "Its value is known only at boot, so a module's schema may check the field but never replace or move it.";
  const restore = (value: unknown, path: string): unknown => {
    const expected = bound.get(path);
    if (isSecretSource(value) || isParamSource(value)) {
      const source = sourceOriginOf(value)?.source ?? value;
      if (source !== expected) {
        throw new LoadError(
          `The input schema of module "${address}" moved ${sourceOriginOf(source)?.label} to input key "${path}". ${onlyChecked}`,
        );
      }
      return source;
    }
    if (expected !== undefined && value !== undefined) {
      throw new LoadError(
        `The input schema of module "${address}" replaced input key "${path}", which is bound to ${sourceOriginOf(expected)?.label}. ${onlyChecked}`,
      );
    }
    if (isSecretString(value)) {
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
  readonly configuration: Readonly<Record<string, unknown>> | undefined;
  readonly appConfigurationRead: AppConfigurationRead | undefined;
  readonly inputBindings: readonly InputBindingUse[];
  readonly params: readonly ParamBinding[];
  readonly moduleInputs: readonly ProvisionedModuleInput[];
  readonly resources: ReadonlyMap<NodeId, ResourceNode>;
}): {
  readonly inputBindings: readonly InputBindingUse[];
  readonly params: readonly ParamBinding[];
  readonly resourceProps: ReadonlyMap<NodeId, ResourceProps>;
  readonly secretSources: readonly SecretSourceUse[];
  readonly appConfigurationRead: AppConfigurationRead;
} {
  const { environment } = input;
  const rootFields = new Map<string, RootInputField>();
  const keysRead = new Map<string, { readonly label: string; readonly text: string | undefined }>();
  /** The text the app configuration holds for `key`, recorded; `undefined` when it holds none or `''`. */
  const configurationText = (
    key: string,
    label: string,
    site: ValueBindingSite,
  ): string | undefined => {
    let raw: unknown;
    if (input.appConfigurationRead !== undefined)
      raw = input.appConfigurationRead.configurationKeyText[key];
    else if (input.configuration !== undefined) raw = input.configuration[key];
    else {
      throw new LoadError(
        `${describeSite(site)} depends on ${label}, but Load was given no app configuration to read "${key}" from. Pass { configuration } to Load; the deploy and dev commands pass the values the \`config\` adapters return.`,
      );
    }
    if (raw !== undefined && raw !== '' && typeof raw !== 'string') {
      throw new LoadError(
        `${describeSite(site)} depends on ${label}, which reads "${key}" from the values the \`config\` adapters return, but they return ${describeKind(raw)} for it, not text. ${label} reads text; to pass other data, declare it in the root module's input.`,
      );
    }
    const text = raw === undefined || raw === '' ? undefined : raw;
    keysRead.set(key, { label, text });
    return text;
  };
  const secretUses = new Map<SecretSource, SecretSourceUse>();
  const recordSecret = (source: SecretSource, site: ValueBindingSite): void => {
    const canonical = canonicalSecret(source);
    if (secretUses.has(canonical)) return;
    secretUses.set(canonical, {
      source: canonical,
      address: site.address,
      nodeKind: nodeKindOf(site),
    });
  };
  const secretSourcesReceivedBy = (
    inputBindings: readonly InputBindingUse[],
    params: readonly ParamBinding[],
  ): readonly SecretSourceUse[] => {
    for (const { serviceAddress, binding } of [...inputBindings, ...params]) {
      for (const pointer of pointersIn(binding)) {
        if (!isSecretSource(pointer)) continue;
        const canonical = canonicalSecret(pointer);
        if (secretUses.get(canonical)?.nodeKind === 'service') continue;
        secretUses.set(canonical, {
          source: canonical,
          address: serviceAddress,
          nodeKind: 'service',
        });
      }
    }
    return [...secretUses.values()];
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
        if (origin.sourceKind === 'secret' || origin.configurationKey === undefined) {
          result = origin.source;
        } else {
          result = configurationText(origin.configurationKey, origin.label, site);
        }
        break;
      }
      case 'computed': {
        const args = origin.dependencies.map((dependency) => {
          const real = resolveOne(dependency, site);
          const source = originOf(dependency);
          if (real === undefined && source.kind === 'source' && source.sourceKind === 'param') {
            throw new LoadError(
              `${fnLabelFor(site)} lists ${source.label}, but "${source.configurationKey}" is unset or empty, so it has no real value. Set "${source.configurationKey}", or bind ${source.label} directly into an input binding, where an absent value leaves the key out and the schema decides.`,
            );
          }
          refusePointerDependency(fnLabelFor(site), dependency, real);
          return real;
        });
        try {
          result = origin.compute(args);
        } catch (thrown) {
          if (thrown instanceof LoadError && !isSourceMisuse(thrown)) throw thrown;
          const message = thrown instanceof Error ? thrown.message : String(thrown);
          throw new LoadError(`${fnLabelFor(site)} threw: ${message}`, { cause: thrown });
        }
        checkResult(result, fnLabelFor(site));
        break;
      }
      case 'input': {
        const entry = moduleInputByAddress.get(origin.module);
        if (entry === undefined) {
          throw new LoadError(
            `${describeSite(site)} depends on ${inputFieldLabel(origin)} of module "${origin.module}", which this Load does not provision. An input field can be passed on only inside the body of the module that received it.`,
          );
        }
        if (origin.path.length === 0) {
          const everyVariable = entry.isRoot
            ? " The root's input is every value the `config` adapters return, which by default is every variable of the process environment, secrets included."
            : '';
          throw new LoadError(
            `${describeSite(site)} depends on the whole input of module "${origin.module}". A module body's input is a dictionary of values, not a value, so it cannot be passed on whole.${everyVariable} Pass its fields on by name, such as input.from.`,
          );
        }
        if (entry.checked !== undefined) {
          const field = entry.checked.find(
            (candidate) => candidate.path.join('\0') === origin.path.join('\0'),
          );
          if (field === undefined) {
            throw new LoadError(
              `${inputFieldLabel(origin)} of root module "${origin.module}" is not in the app configuration file. The first process's root body did not pass it on, so the deploy's two processes built different graphs. ${SAME_GRAPH_ADVICE}`,
            );
          }
          result = field.value;
        } else {
          result = readPath(validatedInputOf(entry), origin);
          if (entry.isRoot) {
            rootFields.set(
              origin.path.join('\0'),
              result === undefined ? { path: origin.path } : { path: origin.path, value: result },
            );
          }
        }
        break;
      }
    }
    visiting.pop();
    results.set(value, result);
    return result;
  };

  const validatedInputOf = (entry: ProvisionedModuleInput): unknown => {
    if (entry.checked !== undefined) return undefined;
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
    const validated = validateModuleInput(entry, resolved, environment);
    validating.delete(entry.moduleAddress);
    validatedInputs.set(entry.moduleAddress, validated);
    return validated;
  };

  const rootModuleAddress = (): string =>
    input.moduleInputs.find((entry) => entry.isRoot)?.moduleAddress ?? '';

  const appConfigurationReadOf = (
    inputBindings: readonly InputBindingUse[],
    params: readonly ParamBinding[],
    secretSources: readonly SecretSourceUse[],
  ): AppConfigurationRead => {
    if (input.configuration !== undefined || input.appConfigurationRead !== undefined) {
      const kept: { readonly binding: unknown; readonly site: ValueBindingSite }[] = [
        ...inputBindings.map(({ serviceAddress, binding }) => ({
          binding,
          site: { address: serviceAddress, kind: 'serviceInput' as const, path: '' },
        })),
        ...params.map(({ serviceAddress, slot, binding }) => ({
          binding,
          site: { address: serviceAddress, kind: 'param' as const, path: slot },
        })),
      ];
      for (const { binding, site } of kept) {
        for (const pointer of pointersIn(binding)) {
          if (!isParamSource(pointer)) continue;
          const origin = sourceOriginOf(pointer);
          if (origin?.sourceKind === 'param' && origin.configurationKey !== undefined) {
            configurationText(origin.configurationKey, origin.label, site);
          }
        }
      }
    }
    for (const use of secretSources) {
      const origin = sourceOriginOf(use.source);
      if (origin?.sourceKind !== 'secret') continue;
      const key = origin.secretsKey;
      const read = key === undefined ? undefined : keysRead.get(key);
      if (key !== undefined && read !== undefined) {
        throw new LoadError(
          `${read.label} reads "${key}" from the app configuration, and ${origin.label} names "${key}" as a secret. A name is a plain value or a secret, not both: Composer hands the deploy's second process every plain value it reads, in a file, and never writes a secret to a file. Give the plain value and the secret different names.`,
        );
      }
      const field = [...rootFields.values()].find((candidate) => candidate.path[0] === key);
      if (key !== undefined && field !== undefined) {
        const label = inputFieldLabel({
          kind: 'input',
          module: rootModuleAddress(),
          path: field.path,
        });
        throw new LoadError(
          `${label} of root module "${rootModuleAddress()}" reads "${key}" from the app configuration, and ${origin.label} names "${key}" as a secret. A name is a plain value or a secret, not both: Composer hands the deploy's second process every root input field the root's body passes on, in a file, and never writes a secret to a file. Read the secret with ${origin.label} only, or give the plain value a different name.`,
        );
      }
    }
    for (const field of rootFields.values()) {
      const kind = 'value' in field ? jsonInexactKind(field.value) : undefined;
      if (kind !== undefined) {
        throw new LoadError(
          `${inputFieldLabel({ kind: 'input', module: rootModuleAddress(), path: field.path })} of root module "${rootModuleAddress()}" holds ${kind}, which JSON cannot hold exactly. The deploy hands the root's input to its second process in a JSON file, so a field the root's body passes on must hold text, a finite number, a boolean, null, or arrays and plain objects of these.`,
        );
      }
    }
    const configurationKeyText: Record<string, string> = {};
    for (const [key, { text }] of keysRead)
      if (text !== undefined) configurationKeyText[key] = text;
    return { rootInput: [...rootFields.values()], configurationKeyText };
  };

  for (const entry of input.moduleInputs) validatedInputOf(entry);
  for (const { value, site } of found) resolveOne(value, site);

  const authoredProps = new Map(
    [...input.resources].map(([address, resource]) => [address, resource.props]),
  );
  if (found.length === 0) {
    for (const [address, props] of authoredProps) refusePointersInProps(address, props);
    const secretSources = secretSourcesReceivedBy(input.inputBindings, input.params);
    return {
      inputBindings: input.inputBindings,
      params: input.params,
      resourceProps: authoredProps,
      secretSources,
      appConfigurationRead: appConfigurationReadOf(
        input.inputBindings,
        input.params,
        secretSources,
      ),
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
            'substitution rebuilds the plain props object, replacing each Value<PlainData> with its real value: an environment or computed value is plain data, which checkResult checked, an input field is its module schema output, and the pointer check above refused any pointer left'
          >(substituted);
    resourceProps.set(address, resolvedProps);
  }
  const inputBindings = input.inputBindings.map((entry) => {
    const binding = substitute(entry.binding, results, inProgress, 'keep');
    return binding === entry.binding
      ? entry
      : {
          serviceAddress: entry.serviceAddress,
          binding: blindCast<
            InputBindingUse['binding'],
            'substitution replaces each value with its real value and keeps every source in place: an environment or computed value is plain data, which checkResult checked, and an input field is its module schema output with each pointer put back; the service schema validates the whole binding again when the target serializes it'
          >(binding),
        };
  });
  const params = input.params.flatMap((entry) => {
    const binding = substitute(entry.binding, results, inProgress, 'keep');
    if (binding === undefined && isValue(entry.binding)) return [];
    return [binding === entry.binding ? entry : { ...entry, binding }];
  });
  const secretSources = secretSourcesReceivedBy(inputBindings, params);
  return {
    resourceProps,
    inputBindings,
    params,
    secretSources,
    appConfigurationRead: appConfigurationReadOf(inputBindings, params, secretSources),
  };
}
