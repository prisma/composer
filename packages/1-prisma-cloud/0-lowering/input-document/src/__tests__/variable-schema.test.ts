import { describe, expect, test } from 'bun:test';
import {
  MAX_DEPTH,
  platformMarker,
  readDocument,
  readVariableText,
  type SchemaKind,
  schemaKind,
  type VariableJsonSchema,
} from '../exports/index.ts';

const NUMBER = { type: 'number' };
const BOOLEAN = { type: 'boolean' };
const OBJECT = {
  type: 'object',
  properties: { host: { type: 'string' }, port: { type: 'number' } },
  required: ['host'],
};
const NUMBER_OR_NULL = { anyOf: [{ type: 'number' }, { type: 'null' }] };
const STRING_ENUM = { type: 'string', enum: ['a', 'b'] };
const RECURSIVE_OBJECT = {
  $ref: '#/$defs/d0',
  $defs: {
    d0: {
      type: 'object',
      properties: { value: { type: 'number' }, next: { $ref: '#/$defs/d0' } },
      required: ['value'],
    },
  },
};
const RECURSIVE_UNION_SELF_REF = {
  anyOf: [{ type: 'number' }, { type: 'array', items: { $ref: '#' } }],
};
const RECURSIVE_UNION_VIA_DEFS = {
  $ref: '#/$defs/d0',
  $defs: {
    d0: { anyOf: [{ type: 'number' }, { $ref: '#/$defs/d1' }] },
    d1: { type: 'array', items: { $ref: '#/$defs/d0' } },
  },
};
const ZOD_JSON = {
  anyOf: [
    { type: 'string' },
    { type: 'number' },
    { type: 'boolean' },
    { type: 'null' },
    { type: 'array', items: { $ref: '#' } },
    { type: 'object', propertyNames: { type: 'string' }, additionalProperties: { $ref: '#' } },
  ],
};
const ZOD_RECORD_OF_ENUM_KEYS = {
  type: 'object',
  propertyNames: { type: 'string', enum: ['a', 'b'] },
  additionalProperties: { type: 'number' },
  required: ['a', 'b'],
};

describe('schemaKind', () => {
  test('a member is judged against the root it came from', () => {
    const root = {
      anyOf: [{ $ref: '#/$defs/d0' }, { type: 'null' }],
      $defs: { d0: { type: 'string' } },
    };
    expect(schemaKind(root.anyOf[0], root)).toBe('text-only');
    expect(schemaKind(root.anyOf[0])).toBe('mixed');
  });

  const cases: [string, unknown, SchemaKind][] = [
    ['type string', { type: 'string' }, 'text-only'],
    ['type ["string"]', { type: ['string'] }, 'text-only'],
    ['a string const', { const: 'a' }, 'text-only'],
    ['an enum of strings', { enum: ['a', 'b'] }, 'text-only'],
    ["Zod's string enum", STRING_ENUM, 'text-only'],
    ['an anyOf of text-only members', { anyOf: [{ type: 'string' }, { const: 'x' }] }, 'text-only'],
    ['a oneOf of text-only members', { oneOf: [{ const: 'a' }, { const: 'b' }] }, 'text-only'],
    [
      'an allOf with a text-only member',
      { allOf: [{ type: 'string' }, { minLength: 1 }] },
      'text-only',
    ],
    ['a string with a format', { type: 'string', format: 'email' }, 'text-only'],

    ['type number', NUMBER, 'never-text'],
    ['type integer', { type: 'integer' }, 'never-text'],
    ['type boolean', BOOLEAN, 'never-text'],
    ['type object', OBJECT, 'never-text'],
    ['type array', { type: 'array', items: { type: 'string' } }, 'never-text'],
    ['type null', { type: 'null' }, 'never-text'],
    ['a type list without string', { type: ['number', 'null'] }, 'never-text'],
    ['a number const', { const: 1 }, 'never-text'],
    ['a null const', { type: 'null', const: null }, 'never-text'],
    ['an enum with no string', { enum: [1, 2, 3] }, 'never-text'],
    ['number | null', NUMBER_OR_NULL, 'never-text'],
    [
      'a oneOf of objects',
      {
        oneOf: [
          { type: 'object', properties: { t: { type: 'string', const: 'a' } }, required: ['t'] },
          { type: 'object', properties: { t: { type: 'string', const: 'b' } }, required: ['t'] },
        ],
      },
      'never-text',
    ],
    [
      'an allOf with a never-text member',
      { allOf: [{ type: 'number' }, { minimum: 1 }] },
      'never-text',
    ],
    [
      'a union with a $ref member',
      { anyOf: [{ $ref: '#/$defs/d0' }, { type: 'boolean' }], $defs: { d0: { type: 'number' } } },
      'never-text',
    ],
    ['a top-level $ref to an anyOf', RECURSIVE_UNION_VIA_DEFS, 'never-text'],
    ['Zod\'s "$ref":"#" in a recursive union', RECURSIVE_UNION_SELF_REF, 'never-text'],
    ['a recursive object behind a $ref', RECURSIVE_OBJECT, 'never-text'],

    ['an empty schema', {}, 'mixed'],
    ['the boolean schema true', true, 'mixed'],
    ['the boolean schema false', false, 'mixed'],
    ['a not', { not: { type: 'string' } }, 'mixed'],
    ['a schema that meets both rules', { type: 'number', const: 'a' }, 'mixed'],
    ['an allOf with both kinds', { allOf: [{ type: 'string' }, { type: 'number' }] }, 'mixed'],
    ['string | null', { anyOf: [{ type: 'string' }, { type: 'null' }] }, 'mixed'],
    ['string | number', { anyOf: [{ type: 'string' }, { type: 'number' }] }, 'mixed'],
    ['an enum of a string and a number', { enum: ['a', 1] }, 'mixed'],
    ['an empty enum', { enum: [] }, 'mixed'],
    ['an empty anyOf', { anyOf: [] }, 'mixed'],
    ["Zod's z.json()", ZOD_JSON, 'mixed'],
    ['a $ref to itself', { $ref: '#' }, 'mixed'],
    ['a $ref that names nothing', { $ref: '#/$defs/missing', $defs: {} }, 'mixed'],
    ['a $ref to a name only the prototype has', { $ref: '#/$defs/toString', $defs: {} }, 'mixed'],
    [
      'a $ref outside $defs',
      { $ref: '#/properties/a', properties: { a: { type: 'number' } } },
      'mixed',
    ],
    ['a schema that is not an object', 'number', 'mixed'],
  ];
  for (const [label, schema, kind] of cases) {
    test(`${label} is ${kind}`, () => {
      expect(schemaKind(schema)).toBe(kind);
    });
  }
});

const boxed = (text: string) => ({ boxed: text });

const bootField = (
  schema: VariableJsonSchema,
  text: string | undefined,
  name = 'SMTP_PORT',
): unknown =>
  readDocument(
    { field: platformMarker(name, false, schema) },
    { variable: () => text, secret: boxed },
  ).value;

const bootValue = (schema: VariableJsonSchema, text: string): unknown => {
  const value = bootField(schema, text);
  if (typeof value !== 'object' || value === null) throw new Error('expected an object');
  return Reflect.get(value, 'field');
};

const bootFailure = (schema: VariableJsonSchema, text: string, name = 'SMTP_PORT'): string => {
  try {
    bootField(schema, text, name);
  } catch (cause) {
    if (cause instanceof Error) return cause.message;
    throw cause;
  }
  throw new Error('expected the read to fail');
};

describe('boot reads a typed platform variable', () => {
  test('each value arrives with its type', () => {
    expect(bootValue(NUMBER, '587')).toBe(587);
    expect(bootValue(BOOLEAN, 'true')).toBe(true);
    expect(bootValue(STRING_ENUM, 'a')).toBe('a');
    expect(bootValue(OBJECT, '{"host":"smtp.example.com","port":587}')).toEqual({
      host: 'smtp.example.com',
      port: 587,
    });
    expect(bootValue(RECURSIVE_OBJECT, '{"value":1,"next":{"value":2}}')).toEqual({
      value: 1,
      next: { value: 2 },
    });
    expect(bootValue(RECURSIVE_UNION_SELF_REF, '[1,[2,[3]]]')).toEqual([1, [2, [3]]]);
    expect(bootValue(NUMBER_OR_NULL, 'null')).toBeNull();
  });

  test('two fields that read one typed variable both receive it', () => {
    const marker = platformMarker('SMTP_PORT', false, NUMBER);
    const { value } = readDocument(
      { a: marker, nested: { b: marker } },
      { variable: () => '587', secret: boxed },
    );
    expect(value).toEqual({ a: 587, nested: { b: 587 } });
  });

  test('a variable with no schema arrives as its text', () => {
    const { value } = readDocument(
      { field: platformMarker('SMTP_PORT', false) },
      { variable: () => '587', secret: boxed },
    );
    expect(value).toEqual({ field: '587' });
  });

  test('a text-only schema gives the text exactly, so a trailing newline fails an enum', () => {
    expect(bootFailure(STRING_ENUM, 'a\n')).toBe(
      'The platform variable "SMTP_PORT" does not fit its schema: it fails "enum" at #/enum.',
    );
    expect(bootValue({ type: 'string' }, ' a\n')).toBe(' a\n');
  });

  test('a never-text schema reads JSON, so surrounding whitespace is allowed', () => {
    expect(bootValue(NUMBER, '587\n')).toBe(587);
    expect(bootValue(NUMBER, ' \t587 ')).toBe(587);
  });

  test('an unset variable with a schema is left out', () => {
    const { value, unset } = readDocument(
      { field: platformMarker('SMTP_PORT', false, NUMBER) },
      { variable: () => undefined, secret: boxed },
    );
    expect(value).toEqual({});
    expect(unset).toEqual(['SMTP_PORT']);
  });

  test('a decoded object that holds a $platform key arrives as data', () => {
    const text = '{"$platform":{"name":"OTHER"},"$$platform":1}';
    const { value } = readDocument(
      { field: platformMarker('CONFIG', false, { type: 'object' }) },
      { variable: (name) => (name === 'CONFIG' ? text : 'other-text'), secret: boxed },
    );
    expect(value).toEqual({ field: { $platform: { name: 'OTHER' }, $$platform: 1 } });
  });

  test('the last of two equal keys wins, and a __proto__ key stays an own key', () => {
    expect(bootValue({ type: 'object' }, '{"a":1,"a":2}')).toEqual({ a: 2 });
    const value = bootValue({ type: 'object' }, '{"__proto__":{"polluted":true}}');
    if (typeof value !== 'object' || value === null) throw new Error('expected an object');
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(value, '__proto__')?.value).toEqual({ polluted: true });
  });

  test('a format the validator does not know is not checked', () => {
    expect(bootValue({ type: 'string', format: 'made-up' }, 'anything')).toBe('anything');
  });
});

describe('boot refuses a typed platform variable whose text does not decode or fit', () => {
  test('text that is not JSON names what the schema expects', () => {
    const tail = 'Its schema is not a text type, so its text must be JSON';
    expect(bootFailure(NUMBER, 'abc')).toBe(
      `The platform variable "SMTP_PORT" does not hold a number. ${tail}, such as 587.`,
    );
    expect(bootFailure({ type: 'integer' }, 'abc')).toBe(
      `The platform variable "SMTP_PORT" does not hold a number. ${tail}, such as 587.`,
    );
    expect(bootFailure(BOOLEAN, 'yes')).toBe(
      `The platform variable "SMTP_PORT" does not hold true or false. ${tail}, such as true.`,
    );
    expect(bootFailure(OBJECT, 'abc')).toBe(
      `The platform variable "SMTP_PORT" does not hold an object. ${tail}, such as {"key":"value"}.`,
    );
    expect(bootFailure({ type: 'array' }, 'abc')).toBe(
      `The platform variable "SMTP_PORT" does not hold an array. ${tail}, such as [1,2].`,
    );
    expect(bootFailure({ type: 'null' }, 'abc')).toBe(
      `The platform variable "SMTP_PORT" does not hold null. ${tail}, such as null.`,
    );
    expect(bootFailure(NUMBER_OR_NULL, 'abc')).toBe(
      `The platform variable "SMTP_PORT" does not hold JSON. ${tail}.`,
    );
    expect(bootFailure(RECURSIVE_OBJECT, 'abc')).toBe(
      `The platform variable "SMTP_PORT" does not hold an object. ${tail}, such as {"key":"value"}.`,
    );
  });

  test('a number Composer cannot read exactly fails, at any depth', () => {
    const message =
      'The platform variable "ORDER_ID" holds a number outside the range Composer reads exactly, which is whole numbers up to 9007199254740991. Declare it as text and keep it as text in the service.';
    for (const text of ['9007199254740993', '9007199254740993.0', '1e21', '1e400', '-1e400']) {
      expect(bootFailure(NUMBER, text, 'ORDER_ID')).toBe(message);
    }
    expect(bootFailure({ type: 'object' }, '{"ids":[1,1e400]}', 'ORDER_ID')).toBe(message);
    expect(bootValue(NUMBER, '9007199254740991')).toBe(9007199254740991);
    expect(bootValue(NUMBER, '0.5')).toBe(0.5);
  });

  test('a value that does not fit names the failing keyword and its place in the schema', () => {
    const fails = (rest: string) =>
      `The platform variable "SMTP_PORT" does not fit its schema: it fails ${rest}.`;
    expect(bootFailure({ type: 'number', minimum: 1 }, '0')).toBe(fails('"minimum" at #/minimum'));
    expect(bootFailure({ anyOf: [{ type: 'number', minimum: 1 }, { type: 'null' }] }, '0')).toBe(
      fails('"anyOf" at #/anyOf'),
    );
    expect(
      bootFailure({ $ref: '#/$defs/d0', $defs: { d0: { type: 'integer', minimum: 1 } } }, '0'),
    ).toBe(fails('"minimum" at #/$ref/minimum'));
    expect(bootFailure(RECURSIVE_OBJECT, '{"value":1,"next":{"value":"x"}}')).toBe(
      fails('"type" at #/$ref/properties/next/$ref/properties/value/type'),
    );
    expect(bootFailure(ZOD_RECORD_OF_ENUM_KEYS, '{"a":1}')).toBe(fails('"required" at #/required'));
    expect(
      bootFailure(
        { type: 'object', properties: { host: { type: 'string' } }, additionalProperties: false },
        '{"host":"h","extra":1}',
      ),
    ).toBe(fails('"additionalProperties" at #/additionalProperties'));
    expect(bootFailure({ type: 'string', format: 'email' }, 'not an address')).toBe(
      fails('"format" at #/format'),
    );
    expect(bootFailure({ type: 'number' }, '"587"')).toBe(fails('"type" at #/type'));
  });

  test(`a value nested more than ${MAX_DEPTH} levels deep fails with the fixed message, whatever the runtime`, () => {
    const nested = (depth: number) => `${'['.repeat(depth)}1${']'.repeat(depth)}`;
    const nestedObject = (depth: number) => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`;
    const message = 'The platform variable "SMTP_PORT" could not be checked against its schema.';
    expect(bootValue({ type: 'array' }, nested(MAX_DEPTH))).toBeArray();
    expect(bootFailure({ type: 'array' }, nested(MAX_DEPTH + 1))).toBe(message);
    expect(bootValue({ type: 'object' }, nestedObject(MAX_DEPTH))).toBeObject();
    expect(bootFailure({ type: 'object' }, nestedObject(MAX_DEPTH + 1))).toBe(message);
    expect(bootFailure({ type: 'array' }, nested(1_000_000))).toBe(message);
  });

  test(`a recursive schema validates a value ${MAX_DEPTH} levels deep, and refuses one level more`, () => {
    const nested = (depth: number) => `${'['.repeat(depth)}1${']'.repeat(depth)}`;
    const nestedNext = (depth: number) => `${'{"next":'.repeat(depth)}{}${'}'.repeat(depth)}`;
    const message = 'The platform variable "SMTP_PORT" could not be checked against its schema.';
    const recursiveNext = {
      $ref: '#/$defs/d0',
      $defs: { d0: { type: 'object', properties: { next: { $ref: '#/$defs/d0' } } } },
    };
    for (const schema of [RECURSIVE_UNION_SELF_REF, RECURSIVE_UNION_VIA_DEFS]) {
      expect(bootValue(schema, nested(MAX_DEPTH))).toBeArray();
      expect(bootFailure(schema, nested(MAX_DEPTH + 1))).toBe(message);
    }
    expect(bootValue(recursiveNext, nestedNext(MAX_DEPTH - 1))).toBeObject();
    expect(bootFailure(recursiveNext, nestedNext(MAX_DEPTH))).toBe(message);
  });

  test('a value too deep fails as too deep, even when it also holds an inexact number', () => {
    const deepInexact = `${'['.repeat(MAX_DEPTH + 1)}1e400${']'.repeat(MAX_DEPTH + 1)}`;
    expect(bootFailure({ type: 'array' }, deepInexact)).toBe(
      'The platform variable "SMTP_PORT" could not be checked against its schema.',
    );
  });

  test('a failed dependentRequired is named at its place in the schema', () => {
    expect(
      bootFailure({ type: 'object', dependentRequired: { card: ['cvv'] } }, '{"card":"x"}'),
    ).toBe(
      'The platform variable "SMTP_PORT" does not fit its schema: it fails "dependentRequired" at #/dependentRequired.',
    );
  });

  test('a failure under a false schema is never named, so its value-built location stays out', () => {
    const fails = (rest: string) =>
      `The platform variable "SMTP_PORT" does not fit its schema: it fails ${rest}.`;
    expect(bootFailure({ type: 'array', contains: false, minContains: 1 }, '[1]')).toBe(
      fails('"minContains" at #/minContains'),
    );
    expect(
      bootFailure(
        {
          type: 'object',
          additionalProperties: { type: 'array', contains: false, minContains: 1 },
        },
        '{"additionalProperties":[1]}',
      ),
    ).toBe(fails('"minContains" at #/additionalProperties/minContains'));
  });
});

describe('no boot message holds any part of the variable text', () => {
  const SECRET = 'a-made-up-secret-7qx9';
  const parts = [SECRET, 'made-up', '7qx9'];
  const cases: [string, VariableJsonSchema, string][] = [
    ['the text, under a number schema', NUMBER, SECRET],
    [
      'a key, under additionalProperties: false',
      { type: 'object', properties: { a: {} }, additionalProperties: false },
      JSON.stringify({ [SECRET]: 1 }),
    ],
    [
      'a key, under unevaluatedProperties: false',
      { type: 'object', properties: { a: {} }, unevaluatedProperties: false },
      JSON.stringify({ [SECRET]: 1 }),
    ],
    [
      'a key, under propertyNames',
      { type: 'object', propertyNames: { pattern: '^[a-z]+$' } },
      JSON.stringify({ [SECRET]: 1 }),
    ],
    [
      'a value at a key named properties, under additionalProperties: false',
      { type: 'object', properties: { a: {} }, additionalProperties: false },
      JSON.stringify({ properties: SECRET }),
    ],
    ['the text, under a pattern', { type: 'string', pattern: '^[0-9]+$' }, SECRET],
    ['the text, as JSON that is not valid', OBJECT, `{"host":"${SECRET}",}`],
  ];
  for (const [label, schema, text] of cases) {
    test(label, () => {
      const message = bootFailure(schema, text);
      expect(message).toStartWith('The platform variable "SMTP_PORT"');
      for (const part of parts) expect(message).not.toContain(part);
    });
  }

  test('the key-named-properties case names the enclosing additionalProperties', () => {
    expect(
      bootFailure(
        { type: 'object', properties: { a: {} }, additionalProperties: false },
        JSON.stringify({ properties: SECRET }),
      ),
    ).toBe(
      'The platform variable "SMTP_PORT" does not fit its schema: it fails "additionalProperties" at #/additionalProperties.',
    );
  });
});

describe('readVariableText', () => {
  test('without a schema it gives the text', () => {
    expect(readVariableText('X', ' 587 ', undefined)).toBe(' 587 ');
  });

  test('a mixed schema fails with the fixed message, since no reading rule applies', () => {
    expect(() =>
      readVariableText('X', '1', { anyOf: [{ type: 'string' }, { type: 'number' }] }),
    ).toThrow('The platform variable "X" could not be checked against its schema.');
  });

  test('it does not change the schema it is given', () => {
    const schema = Object.freeze({ $ref: '#/$defs/d0', $defs: Object.freeze({ d0: NUMBER }) });
    expect(readVariableText('X', '587', schema)).toBe(587);
    expect(Object.getOwnPropertyNames(schema)).toEqual(['$ref', '$defs']);
  });
});
