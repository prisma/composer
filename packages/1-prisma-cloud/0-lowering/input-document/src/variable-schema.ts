import { type OutputUnit, Validator } from '@cfworker/json-schema';
import { isJsonData, isPlainObject, type JsonData, setOwn } from './plain-object.ts';

export type VariableJsonSchema = { readonly [key: string]: JsonData };

export const isVariableJsonSchema = (value: unknown): value is VariableJsonSchema =>
  isPlainObject(value) && isJsonData(value);

export type SchemaKind = 'text-only' | 'never-text' | 'mixed';

const NEVER_TEXT_TYPES: ReadonlySet<unknown> = new Set([
  'number',
  'integer',
  'boolean',
  'object',
  'array',
  'null',
]);

export const DEFS_PREFIX = '#/$defs/';

export function resolveSchemaRef(root: unknown, ref: string): unknown {
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
    const target = resolveSchemaRef(root, ref);
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

export function schemaKind(schema: unknown, root: unknown = schema): SchemaKind {
  return kindAt(schema, root, new Set());
}

export function schemaWord(schema: VariableJsonSchema): string {
  const type = schema['type'];
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) return type.join(' | ');
  return schemaKind(schema) === 'text-only' ? 'text' : 'json';
}

function topLevelType(schema: VariableJsonSchema): unknown {
  let current: unknown = schema;
  const followed = new Set<string>();
  while (isPlainObject(current)) {
    const ref = current['$ref'];
    if (typeof ref !== 'string' || followed.has(ref)) return current['type'];
    followed.add(ref);
    current = resolveSchemaRef(schema, ref);
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

function notJsonError(name: string, schema: VariableJsonSchema): Error {
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

const MISSPELT_LOCATION = /\/dependantRequired$/;

function printedLocation(failure: OutputUnit): string {
  return failure.keyword === 'dependentRequired'
    ? failure.keywordLocation.replace(MISSPELT_LOCATION, '/dependentRequired')
    : failure.keywordLocation;
}

const doesNotFitError = (name: string, failure: OutputUnit): Error =>
  new Error(
    `The platform variable "${name}" does not fit its schema: it fails "${failure.keyword}" at ${printedLocation(failure)}.`,
  );

const uncheckedError = (name: string): Error =>
  new Error(`The platform variable "${name}" could not be checked against its schema.`);

export const MAX_DEPTH = 100;

const isExactNumber = (value: number): boolean =>
  Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));

function refuseUnreadable(name: string, parsed: unknown): void {
  const pending: [unknown, number][] = [[parsed, 0]];
  let exact = true;
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const [value, depth] = next;
    if (typeof value === 'number') {
      exact &&= isExactNumber(value);
      continue;
    }
    const members = Array.isArray(value)
      ? value
      : isPlainObject(value)
        ? Object.values(value)
        : undefined;
    if (members === undefined) continue;
    if (depth >= MAX_DEPTH) throw uncheckedError(name);
    for (const member of members) pending.push([member, depth + 1]);
  }
  if (!exact) throw inexactNumberError(name);
}

const STOP_KEYWORDS: ReadonlySet<string> = new Set(['anyOf', 'oneOf', 'not', 'if']);

function namedFailure(errors: readonly OutputUnit[]): OutputUnit | undefined {
  const failures = errors.filter((failure) => failure.keyword !== 'false');
  let index = 0;
  let current = failures[index];
  while (current !== undefined && !STOP_KEYWORDS.has(current.keyword)) {
    const next = failures[index + 1];
    if (next === undefined || !next.keywordLocation.startsWith(`${current.keywordLocation}/`)) {
      break;
    }
    index += 1;
    current = next;
  }
  return current;
}

function parseJson(name: string, text: string, schema: VariableJsonSchema): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw cause instanceof SyntaxError ? notJsonError(name, schema) : uncheckedError(name);
  }
}

const isJsonList = (value: JsonData): value is readonly JsonData[] => Array.isArray(value);

function copyOfValue(value: JsonData): JsonData {
  if (isJsonList(value)) return value.map(copyOfValue);
  return typeof value === 'object' && value !== null ? copyOfSchema(value) : value;
}

function copyOfSchema(schema: VariableJsonSchema): Record<string, JsonData> {
  const copy: Record<string, JsonData> = {};
  for (const [key, member] of Object.entries(schema)) setOwn(copy, key, copyOfValue(member));
  return copy;
}

function failureOf(schema: VariableJsonSchema, value: unknown): OutputUnit | 'valid' | 'unchecked' {
  try {
    const result = new Validator(copyOfSchema(schema), '2020-12', true).validate(value);
    if (result.valid) return 'valid';
    return namedFailure(result.errors) ?? 'unchecked';
  } catch {
    return 'unchecked';
  }
}

export function readVariableText(
  name: string,
  text: string,
  schema: VariableJsonSchema | undefined,
): unknown {
  if (schema === undefined) return text;
  const kind = schemaKind(schema);
  if (kind === 'mixed') throw uncheckedError(name);
  let value: unknown = text;
  if (kind === 'never-text') {
    value = parseJson(name, text, schema);
    refuseUnreadable(name, value);
  }
  const failure = failureOf(schema, value);
  if (failure === 'unchecked') throw uncheckedError(name);
  if (failure !== 'valid') throw doesNotFitError(name, failure);
  return value;
}
