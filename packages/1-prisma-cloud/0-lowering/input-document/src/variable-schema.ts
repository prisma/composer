import { type OutputUnit, type Schema, Validator } from '@cfworker/json-schema';
import { isPlainObject } from './plain-object.ts';

export type JsonSchema = Readonly<Record<string, unknown>>;

export type SchemaKind = 'text-only' | 'never-text' | 'mixed';

const NEVER_TEXT_TYPES: ReadonlySet<unknown> = new Set([
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
]);

const DEFS_PREFIX = '#/$defs/';

function resolveRef(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith(DEFS_PREFIX) || !isPlainObject(root)) return undefined;
  const defs = root['$defs'];
  const name = ref.slice(DEFS_PREFIX.length);
  return isPlainObject(defs) && Object.hasOwn(defs, name) ? defs[name] : undefined;
}

function kindAt(schema: unknown, root: unknown, followed: ReadonlySet<string>): SchemaKind {
  if (!isPlainObject(schema)) return 'mixed';
  const ref = schema['$ref'];
  if (typeof ref === 'string') {
    const target = resolveRef(root, ref);
    if (followed.has(ref) || target === undefined) return 'mixed';
    return kindAt(target, root, new Set([...followed, ref]));
  }
  const membersOf = (keyword: string): SchemaKind[] => {
    const members = schema[keyword];
    return Array.isArray(members) ? members.map((member) => kindAt(member, root, followed)) : [];
  };
  const unions = [membersOf('anyOf'), membersOf('oneOf')];
  const allOf = membersOf('allOf');
  const type = schema['type'];
  const hasConst = Object.hasOwn(schema, 'const');
  const constant = schema['const'];
  const enumMembers = schema['enum'];
  const enumOf = (test: (member: unknown) => boolean): boolean =>
    Array.isArray(enumMembers) && enumMembers.length > 0 && enumMembers.every(test);
  const isText = (member: unknown): boolean => typeof member === 'string';
  const unionOf = (kind: SchemaKind): boolean =>
    unions.some((members) => members.length > 0 && members.every((member) => member === kind));

  const textOnly =
    type === 'string' ||
    (Array.isArray(type) && type.length === 1 && type[0] === 'string') ||
    (hasConst && isText(constant)) ||
    enumOf(isText) ||
    unionOf('text-only') ||
    allOf.includes('text-only');
  const neverText =
    NEVER_TEXT_TYPES.has(type) ||
    (Array.isArray(type) && !type.includes('string')) ||
    (hasConst && !isText(constant)) ||
    enumOf((member) => !isText(member)) ||
    unionOf('never-text') ||
    allOf.includes('never-text');

  if (textOnly === neverText) return 'mixed';
  return textOnly ? 'text-only' : 'never-text';
}

export function schemaKind(schema: unknown): SchemaKind {
  return kindAt(schema, schema, new Set());
}

export function schemaWord(schema: JsonSchema): string {
  const type = schema['type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.join(' | ');
  return schemaKind(schema) === 'text-only' ? 'text' : 'json';
}

function topLevelType(schema: JsonSchema): unknown {
  let current: unknown = schema;
  const followed = new Set<string>();
  while (isPlainObject(current)) {
    const ref = current['$ref'];
    if (typeof ref !== 'string' || followed.has(ref)) return current['type'];
    followed.add(ref);
    current = resolveRef(schema, ref);
  }
  return undefined;
}

const EXPECTED: Readonly<Record<string, { readonly expected: string; readonly example: string }>> =
  {
    number: { expected: 'a number', example: '587' },
    integer: { expected: 'a number', example: '587' },
    boolean: { expected: 'true or false', example: 'true' },
    object: { expected: 'an object', example: '{"key":"value"}' },
    array: { expected: 'an array', example: '[1,2]' },
    null: { expected: 'null', example: 'null' },
  };

function notJsonError(name: string, schema: JsonSchema): Error {
  const type = topLevelType(schema);
  const known =
    typeof type === 'string' && Object.hasOwn(EXPECTED, type) ? EXPECTED[type] : undefined;
  const lead = `The platform variable "${name}" does not hold`;
  return new Error(
    known === undefined
      ? `${lead} JSON. Its schema is not a text type, so its text must be JSON.`
      : `${lead} ${known.expected}. Its schema is not a text type, so its text must be JSON, such as ${known.example}.`,
  );
}

const inexactNumberError = (name: string): Error =>
  new Error(
    `The platform variable "${name}" holds a number outside the range Composer reads exactly, which is whole numbers up to 9007199254740991. Declare it as text and keep it as text in the service.`,
  );

const doesNotFitError = (name: string, failure: OutputUnit): Error =>
  new Error(
    `The platform variable "${name}" does not fit its schema: it fails "${failure.keyword}" at ${failure.keywordLocation}.`,
  );

const uncheckedError = (name: string): Error =>
  new Error(`The platform variable "${name}" could not be checked against its schema.`);

function holdsOnlyExactNumbers(value: unknown): boolean {
  if (typeof value === 'number') {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  if (Array.isArray(value)) return value.every(holdsOnlyExactNumbers);
  if (isPlainObject(value)) return Object.values(value).every(holdsOnlyExactNumbers);
  return true;
}

const STOP_KEYWORDS: ReadonlySet<string> = new Set(['anyOf', 'oneOf', 'not', 'if']);

function namedFailure(errors: readonly OutputUnit[]): OutputUnit | undefined {
  let index = 0;
  let current = errors[index];
  while (current !== undefined && !STOP_KEYWORDS.has(current.keyword)) {
    const next = errors[index + 1];
    if (
      next === undefined ||
      next.keyword === 'false' ||
      !next.keywordLocation.startsWith(`${current.keywordLocation}/`)
    ) {
      break;
    }
    index += 1;
    current = next;
  }
  return current;
}

function parseJson(name: string, text: string, schema: JsonSchema): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw cause instanceof SyntaxError ? notJsonError(name, schema) : uncheckedError(name);
  }
}

function failureOf(schema: JsonSchema, value: unknown): OutputUnit | 'valid' | 'unchecked' {
  try {
    const detached: Schema = JSON.parse(JSON.stringify(schema));
    const result = new Validator(detached, '2020-12', true).validate(value);
    if (result.valid) return 'valid';
    return namedFailure(result.errors) ?? 'unchecked';
  } catch {
    return 'unchecked';
  }
}

export function decodeVariableText(
  name: string,
  text: string,
  schema: JsonSchema | undefined,
): unknown {
  if (schema === undefined) return text;
  const kind = schemaKind(schema);
  if (kind === 'mixed') throw uncheckedError(name);
  let value: unknown = text;
  if (kind === 'never-text') {
    value = parseJson(name, text, schema);
    let exact: boolean;
    try {
      exact = holdsOnlyExactNumbers(value);
    } catch {
      throw uncheckedError(name);
    }
    if (!exact) throw inexactNumberError(name);
  }
  const failure = failureOf(schema, value);
  if (failure === 'unchecked') throw uncheckedError(name);
  if (failure !== 'valid') throw doesNotFitError(name, failure);
  return value;
}
