import type { PlainData } from '@internal/core';
import { isPlainObject, schemaKind } from '@internal/input-document';

export type VariableJsonSchema = { readonly [key: string]: PlainData };

const ONE_SCHEMA: readonly string[] = [
  'not',
  'if',
  'then',
  'else',
  'items',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
];
const SCHEMA_LIST: readonly string[] = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const SCHEMA_MAP: readonly string[] = [
  'properties',
  'patternProperties',
  '$defs',
  'dependentSchemas',
];

const isString = (value: unknown): boolean => typeof value === 'string';
const isNumber = (value: unknown): boolean => typeof value === 'number';
const isStringList = (value: unknown): boolean => Array.isArray(value) && value.every(isString);

const KEPT: ReadonlyMap<string, (value: unknown) => boolean> = new Map([
  ['type', (value: unknown) => isString(value) || isStringList(value)],
  ['const', () => true],
  ['enum', (value: unknown) => Array.isArray(value)],
  ['required', isStringList],
  [
    'dependentRequired',
    (value: unknown) => isPlainObject(value) && Object.values(value).every(isStringList),
  ],
  ['minimum', isNumber],
  ['maximum', isNumber],
  ['exclusiveMinimum', isNumber],
  ['exclusiveMaximum', isNumber],
  ['multipleOf', isNumber],
  ['minLength', isNumber],
  ['maxLength', isNumber],
  ['pattern', isString],
  ['format', isString],
  ['minItems', isNumber],
  ['maxItems', isNumber],
  ['uniqueItems', (value: unknown) => typeof value === 'boolean'],
  ['minContains', isNumber],
  ['maxContains', isNumber],
  ['minProperties', isNumber],
  ['maxProperties', isNumber],
  ['$ref', isString],
]);

const UNFOLLOWED_REFERENCES: readonly string[] = [
  '$dynamicRef',
  '$dynamicAnchor',
  '$anchor',
  '$id',
];
const OLDER_DRAFT_KEYWORDS: readonly string[] = [
  'dependencies',
  'additionalItems',
  '$recursiveRef',
  '$recursiveAnchor',
];

const DEFS_PREFIX = '#/$defs/';

function isPlainData(value: unknown): value is PlainData {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isPlainData);
  return isPlainObject(value) && Object.values(value).every(isPlainData);
}

const isDataObject = (value: PlainData): value is VariableJsonSchema =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function withMember(target: Record<string, PlainData>, key: string, value: PlainData): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

const prefix = (name: string): string => `The schema of the platform variable "${name}"`;

const unfollowedReferenceError = (name: string, reference: unknown): Error =>
  new Error(
    `${prefix(name)} refers to "${typeof reference === 'string' ? reference : JSON.stringify(reference)}", which Composer cannot follow. It reads only references to the schema's own $defs.`,
  );

const olderDraftError = (name: string, keyword: string): Error =>
  new Error(
    `${prefix(name)} uses "${keyword}" in a form that is not JSON Schema draft 2020-12, which is the form Composer reads.`,
  );

function checkPattern(name: string, pattern: string): void {
  try {
    new RegExp(pattern, 'u');
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `${prefix(name)} holds the pattern "${pattern}", which is not valid as a Unicode regular expression: ${message}. Rewrite it; an escape such as \\- outside a character class is the usual cause.`,
    );
  }
}

function isFollowedReference(reference: string, root: Record<string, unknown>): boolean {
  if (reference === '#') return true;
  if (!reference.startsWith(DEFS_PREFIX)) return false;
  const defs = root['$defs'];
  return isPlainObject(defs) && Object.hasOwn(defs, reference.slice(DEFS_PREFIX.length));
}

interface Reading {
  readonly name: string;
  readonly root: Record<string, unknown>;
}

function readSchemaAt(reading: Reading, value: unknown, keyword: string): PlainData {
  if (typeof value === 'boolean') return value;
  if (!isPlainObject(value)) throw olderDraftError(reading.name, keyword);
  return readSchema(reading, value);
}

function readKept(reading: Reading, key: string, value: unknown): PlainData | undefined {
  const fits = KEPT.get(key);
  if (fits === undefined) return undefined;
  if (!fits(value) || !isPlainData(value)) throw olderDraftError(reading.name, key);
  if (typeof value === 'string' && key === '$ref' && !isFollowedReference(value, reading.root)) {
    throw unfollowedReferenceError(reading.name, value);
  }
  if (typeof value === 'string' && key === 'pattern') checkPattern(reading.name, value);
  return value;
}

function readSchema(reading: Reading, schema: Record<string, unknown>): VariableJsonSchema {
  const { name } = reading;
  const reduced: Record<string, PlainData> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNFOLLOWED_REFERENCES.includes(key)) throw unfollowedReferenceError(name, value);
    if (OLDER_DRAFT_KEYWORDS.includes(key)) throw olderDraftError(name, key);
    if (ONE_SCHEMA.includes(key)) {
      withMember(reduced, key, readSchemaAt(reading, value, key));
    } else if (SCHEMA_LIST.includes(key)) {
      if (!Array.isArray(value)) throw olderDraftError(name, key);
      withMember(
        reduced,
        key,
        value.map((member) => readSchemaAt(reading, member, key)),
      );
    } else if (SCHEMA_MAP.includes(key)) {
      if (!isPlainObject(value)) throw olderDraftError(name, key);
      const map: Record<string, PlainData> = {};
      for (const [entry, member] of Object.entries(value)) {
        if (key === 'patternProperties') checkPattern(name, entry);
        withMember(map, entry, readSchemaAt(reading, member, key));
      }
      withMember(reduced, key, map);
    } else {
      const kept = readKept(reading, key, value);
      if (kept !== undefined) withMember(reduced, key, kept);
    }
  }
  return reduced;
}

const DEFS_WALK_ORDER: readonly string[] = [
  ...ONE_SCHEMA,
  ...SCHEMA_LIST,
  ...SCHEMA_MAP.filter((key) => key !== '$defs'),
  '$ref',
];

function renameDefs(root: VariableJsonSchema): VariableJsonSchema {
  const defsValue = root['$defs'];
  const defs: VariableJsonSchema =
    defsValue !== undefined && isDataObject(defsValue) ? defsValue : {};
  const renamed = new Map<string, string>();

  const visit = (schema: PlainData | undefined): void => {
    if (schema === undefined || !isDataObject(schema)) return;
    for (const key of DEFS_WALK_ORDER) {
      const value = schema[key];
      if (value === undefined || !Object.hasOwn(schema, key)) continue;
      if (ONE_SCHEMA.includes(key)) visit(value);
      else if (SCHEMA_LIST.includes(key) && Array.isArray(value)) value.forEach(visit);
      else if (SCHEMA_MAP.includes(key) && isDataObject(value)) {
        for (const entry of Object.keys(value).sort()) visit(value[entry]);
      } else if (typeof value === 'string' && value.startsWith(DEFS_PREFIX)) {
        const original = value.slice(DEFS_PREFIX.length);
        if (renamed.has(original) || !Object.hasOwn(defs, original)) continue;
        renamed.set(original, `d${renamed.size}`);
        visit(defs[original]);
      }
    }
  };
  visit(root);

  const rewriteAt = (value: PlainData): PlainData => (isDataObject(value) ? rewrite(value) : value);
  const rewrite = (schema: VariableJsonSchema): VariableJsonSchema => {
    const out: Record<string, PlainData> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === '$defs') continue;
      if (ONE_SCHEMA.includes(key)) withMember(out, key, rewriteAt(value));
      else if (SCHEMA_LIST.includes(key) && Array.isArray(value)) {
        withMember(out, key, value.map(rewriteAt));
      } else if (SCHEMA_MAP.includes(key) && isDataObject(value)) {
        const map: Record<string, PlainData> = {};
        for (const [entry, member] of Object.entries(value)) {
          withMember(map, entry, rewriteAt(member));
        }
        withMember(out, key, map);
      } else if (key === '$ref' && typeof value === 'string' && value.startsWith(DEFS_PREFIX)) {
        withMember(out, key, `${DEFS_PREFIX}${renamed.get(value.slice(DEFS_PREFIX.length))}`);
      } else withMember(out, key, value);
    }
    return out;
  };

  const top: Record<string, PlainData> = { ...rewrite(root) };
  const reached: Record<string, PlainData> = {};
  for (const [original, short] of renamed) {
    const definition = defs[original];
    if (definition !== undefined) withMember(reached, short, rewriteAt(definition));
  }
  if (renamed.size > 0) withMember(top, '$defs', reached);
  return top;
}

type Same = (key: string, a: PlainData | undefined, b: PlainData | undefined) => boolean;

function sameMap(
  a: VariableJsonSchema,
  b: VariableJsonSchema,
  same: Same,
  ignoredInB?: string,
): boolean {
  const keysOfA = Object.keys(a);
  const keysOfB = Object.keys(b).filter((key) => key !== ignoredInB);
  return (
    keysOfA.length === keysOfB.length &&
    keysOfA.every((key) => Object.hasOwn(b, key) && same(key, a[key], b[key]))
  );
}

const bothObjects = (
  a: PlainData | undefined,
  b: PlainData | undefined,
): [VariableJsonSchema, VariableJsonSchema] | undefined =>
  a !== undefined && b !== undefined && isDataObject(a) && isDataObject(b) ? [a, b] : undefined;

function sameData(a: PlainData | undefined, b: PlainData | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((member, index) => sameData(member, b[index]));
  }
  const objects = bothObjects(a, b);
  if (objects !== undefined) return sameMap(...objects, (_key, x, y) => sameData(x, y));
  return Object.is(a, b);
}

function sameSchema(input: PlainData | undefined, output: PlainData | undefined): boolean {
  const objects = bothObjects(input, output);
  if (objects === undefined) return sameData(input, output);
  const [a, b] = objects;
  const closedOnlyInOutput =
    b['additionalProperties'] === false && !Object.hasOwn(a, 'additionalProperties');
  return sameMap(a, b, sameMember, closedOnlyInOutput ? 'additionalProperties' : undefined);
}

function sameMember(key: string, a: PlainData | undefined, b: PlainData | undefined): boolean {
  if (ONE_SCHEMA.includes(key)) return sameSchema(a, b);
  if (SCHEMA_LIST.includes(key) && Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((member, index) => sameSchema(member, b[index]));
  }
  const objects = bothObjects(a, b);
  if (SCHEMA_MAP.includes(key) && objects !== undefined) {
    return sameMap(...objects, (_entry, x, y) => sameSchema(x, y));
  }
  return sameData(a, b);
}

const isNullSchema = (schema: unknown): boolean =>
  isPlainObject(schema) &&
  (schema['type'] === 'null' || (Object.hasOwn(schema, 'const') && schema['const'] === null));

function isTextOrNull(schema: VariableJsonSchema): boolean {
  const isText = (member: unknown) => schemaKind(member, schema) === 'text-only';
  return ['anyOf', 'oneOf'].some((keyword) => {
    const members = schema[keyword];
    return (
      Array.isArray(members) &&
      members.some(isNullSchema) &&
      members.some(isText) &&
      members.every((member) => isNullSchema(member) || isText(member))
    );
  });
}

function mixedError(name: string, schema: VariableJsonSchema): Error {
  const message = `${prefix(name)} accepts both text and other values, or neither, so Composer cannot tell how to read the variable's text. Declare a text type, or a type that is never text.`;
  return new Error(
    isTextOrNull(schema)
      ? `${message} A variable on the platform cannot hold null as text: declare the text type and make the service's field optional.`
      : message,
  );
}

const TARGET = { target: 'draft-2020-12' } as const;

type Emit = () => unknown;

const isObjectLike = (value: unknown): value is object =>
  (typeof value === 'object' || typeof value === 'function') && value !== null;

function convertersOf(schema: unknown): readonly [Emit, Emit] | undefined {
  if (!isObjectLike(schema)) return undefined;
  const standard: unknown = Reflect.get(schema, '~standard');
  if (!isObjectLike(standard)) return undefined;
  const converter: unknown = Reflect.get(standard, 'jsonSchema');
  if (!isObjectLike(converter)) return undefined;
  const input: unknown = Reflect.get(converter, 'input');
  const output: unknown = Reflect.get(converter, 'output');
  if (typeof input !== 'function' || typeof output !== 'function') return undefined;
  return [
    () => Reflect.apply(input, converter, [TARGET]),
    () => Reflect.apply(output, converter, [TARGET]),
  ];
}

function readEmitted(name: string, emit: Emit): VariableJsonSchema {
  let schema: unknown;
  try {
    schema = emit();
  } catch (cause) {
    const message = (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, ' ');
    throw new Error(
      `${prefix(name)} cannot be written as JSON Schema: ${message}. Declare the type the text holds, and put any other check in the service's own schema.`,
    );
  }
  if (!isPlainObject(schema)) throw mixedError(name, {});
  return renameDefs(readSchema({ name, root: schema }, schema));
}

export function variableJsonSchema(name: string, schema: unknown): VariableJsonSchema {
  const converters = convertersOf(schema);
  if (converters === undefined) {
    throw new Error(
      `${prefix(name)} does not implement Standard JSON Schema. Use a schema from a library that does, such as ArkType or Zod.`,
    );
  }
  const [emitInput, emitOutput] = converters;
  const input = readEmitted(name, emitInput);
  const output = readEmitted(name, emitOutput);
  if (!sameSchema(input, output)) {
    throw new Error(
      `${prefix(name)} gives a different type from the one it takes. No code runs on a platform variable's value, so a transform or a default cannot apply. Declare the type the text holds, such as type('number'), and put a default on the service's field.`,
    );
  }
  if (schemaKind(input) === 'mixed') throw mixedError(name, input);
  return input;
}
