import { describe, expect, test } from 'bun:test';
import {
  appRoot,
  Load,
  module,
  type ServiceNode,
  service,
  type ValueResourceNode,
} from '@internal/core';
import { field as arkField } from '@internal/foundation/arktype';
import { field as zodField } from '@internal/foundation/zod';
import { readDocument } from '@internal/input-document';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { z } from 'zod';
import { type PlainVariableValue, variable } from '../platform-variable.ts';
import { serializeInput } from '../serializer.ts';

const NAME = 'SMTP_PORT';

const handWritten = (input: unknown, output: unknown = input) => ({
  '~standard': {
    version: 1,
    vendor: 'hand-written',
    validate: () => {
      throw new Error('validate must not run');
    },
    jsonSchema: { input: () => input, output: () => output },
  },
});

const schemaOf = (schema: unknown): unknown =>
  variable({ name: NAME, schema: schema as never }).props['schema'];

const refusal = (schema: unknown): string => {
  try {
    schemaOf(schema);
  } catch (cause) {
    if (cause instanceof Error) return cause.message;
    throw cause;
  }
  throw new Error('expected variable() to refuse the schema');
};

const ESCAPED_HYPHEN = '\\-';

const lead = `The schema of the platform variable "${NAME}"`;

describe('variable({ name, schema }) keeps the reduced JSON Schema in its props', () => {
  test('props carry the schema, and a variable without one keeps its old props', () => {
    expect(variable({ name: NAME, schema: type('number') }).props).toEqual({
      name: NAME,
      secret: false,
      schema: { type: 'number' },
    });
    expect(variable({ name: NAME, schema: z.number() }).props).toEqual({
      name: NAME,
      secret: false,
      schema: { type: 'number' },
    });
    expect(variable({ name: NAME }).props).toEqual({ name: NAME, secret: false });
  });

  test('the JSON Schema is read once in each form, and the library never validates', () => {
    const calls: string[] = [];
    const inner = type('number')['~standard'];
    const counted = {
      '~standard': {
        ...inner,
        validate: () => {
          calls.push('validate');
          return { value: 1 };
        },
        jsonSchema: {
          input: (options: { readonly target: string }) => {
            calls.push(`input ${options.target}`);
            return inner.jsonSchema.input({ target: 'draft-2020-12' });
          },
          output: (options: { readonly target: string }) => {
            calls.push(`output ${options.target}`);
            return inner.jsonSchema.output({ target: 'draft-2020-12' });
          },
        },
      },
    };
    expect(schemaOf(counted)).toEqual({ type: 'number' });
    expect(calls).toEqual(['input draft-2020-12', 'output draft-2020-12']);
  });

  test('$schema, annotations and library metadata are removed at every schema position', () => {
    expect(
      schemaOf(
        handWritten({
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          title: 'Settings',
          description: 'd',
          type: 'object',
          properties: {
            port: { type: 'number', default: 587, examples: [587], 'x-library': { id: 1 } },
            hosts: { type: 'array', items: { type: 'string', $comment: 'c', deprecated: true } },
          },
          anyOf: [{ required: ['port'], readOnly: true }, { required: ['hosts'] }],
        }),
      ),
    ).toEqual({
      type: 'object',
      properties: { port: { type: 'number' }, hosts: { type: 'array', items: { type: 'string' } } },
      anyOf: [{ required: ['port'] }, { required: ['hosts'] }],
    });
    expect(schemaOf(z.number().meta({ title: 'Port', description: 'd', examples: [1] }))).toEqual({
      type: 'number',
    });
  });

  test('a property named title or default, and an object inside const or enum, are kept whole', () => {
    const kept = {
      type: 'object',
      properties: {
        title: { type: 'string' },
        default: { enum: [{ title: 'a', default: 1 }] },
        choice: { const: { description: 'kept', $schema: 'kept' } },
      },
      required: ['title', 'default'],
    };
    expect(schemaOf(handWritten(kept))).toEqual(kept);
  });

  test('the same recursive ArkType type gives the same props whatever was created before it', () => {
    const make = () =>
      type.module({
        node: { value: 'number', 'next?': 'node', 'alt?': 'other' },
        other: { 'back?': 'node' },
      }).node;
    const first = schemaOf(make());
    type({ unrelated: 'string' });
    type('number | string[]');
    const second = schemaOf(make());
    expect(second).toEqual(first);
    expect(JSON.stringify(first)).toContain('"#/$defs/d0"');
    expect(JSON.stringify(first)).not.toMatch(/intersection|union/);
  });

  test('$defs are renamed in the order a $ref first reaches them, and an unreached entry is removed', () => {
    expect(
      schemaOf(
        handWritten({
          type: 'object',
          properties: { b: { $ref: '#/$defs/second' }, a: { $ref: '#/$defs/first' } },
          $defs: {
            first: { type: 'number' },
            second: { type: 'string' },
            unused: { type: 'null' },
          },
        }),
      ),
    ).toEqual({
      type: 'object',
      properties: { b: { $ref: '#/$defs/d1' }, a: { $ref: '#/$defs/d0' } },
      $defs: { d0: { type: 'number' }, d1: { type: 'string' } },
    });
  });

  test('a plain z.object(), a z.discriminatedUnion and a recursive z.object are accepted', () => {
    expect(schemaOf(z.object({ host: z.string(), port: z.number().optional() }))).toEqual({
      type: 'object',
      properties: { host: { type: 'string' }, port: { type: 'number' } },
      required: ['host'],
    });
    expect(
      schemaOf(
        z.discriminatedUnion('t', [
          z.object({ t: z.literal('a') }),
          z.object({ t: z.literal('b'), n: z.number() }),
        ]),
      ),
    ).toHaveProperty('oneOf');
    const node: z.ZodType<{ v: number; next?: unknown }> = z.object({
      v: z.number(),
      get next() {
        return node.optional();
      },
    });
    expect(schemaOf(node)).toEqual({
      type: 'object',
      properties: { v: { type: 'number' }, next: { $ref: '#' } },
      required: ['v'],
    });
  });
});

describe('variable({ name, schema }) refuses, when the root body runs, a schema it cannot read', () => {
  test('the library cannot write the schema as JSON Schema', () => {
    const narrowed = refusal(type('number').narrow((n) => n > 0));
    expect(narrowed).toMatch(
      /^The schema of the platform variable "SMTP_PORT" cannot be written as JSON Schema: \{ code: "predicate", base: \{ type: "number" \}, predicate: Function\(\w+\) \}\. Declare the type the text holds, and put any other check in the service's own schema\.$/,
    );
    expect(narrowed).not.toContain('\n');
    expect(refusal(z.number().transform((n) => n + 1))).toBe(
      `${lead} cannot be written as JSON Schema: Transforms cannot be represented in JSON Schema. Declare the type the text holds, and put any other check in the service's own schema.`,
    );
  });

  test('the input and output forms differ', () => {
    const message = `${lead} gives a different type from the one it takes. No code runs on a platform variable's value, so a transform or a default cannot apply. Declare the type the text holds, such as type('number'), and put a default on the service's field.`;
    expect(refusal(type('string.numeric.parse'))).toBe(message);
    expect(refusal(type({ port: 'number = 587' }))).toBe(message);
    expect(refusal(z.object({ port: z.number().default(587) }))).toBe(message);
  });

  test('additionalProperties: false only in the output form is allowed at a schema position, never in a properties map', () => {
    expect(
      schemaOf(handWritten({ type: 'object' }, { type: 'object', additionalProperties: false })),
    ).toEqual({ type: 'object' });
    expect(
      refusal(
        handWritten(
          { type: 'object', properties: { a: {} } },
          { type: 'object', properties: { a: {}, additionalProperties: false } },
        ),
      ),
    ).toStartWith(`${lead} gives a different type`);
  });

  test('a mixed schema, with the null sentence for text or null', () => {
    const mixed = `${lead} accepts both text and other values, or neither, so Composer cannot tell how to read the variable's text. Declare a text type, or a type that is never text.`;
    expect(refusal(type('string | number'))).toBe(mixed);
    expect(refusal(handWritten({}))).toBe(mixed);
    const withNull = `${mixed} A variable on the platform cannot hold null as text: declare the text type and make the service's field optional.`;
    expect(refusal(type('string | null'))).toBe(withNull);
    expect(refusal(z.string().nullable())).toBe(withNull);
  });

  test('a reference Composer cannot follow', () => {
    const refers = (ref: string) =>
      `${lead} refers to "${ref}", which Composer cannot follow. It reads only references to the schema's own $defs.`;
    expect(refusal(handWritten({ $ref: 'https://example.com/port.json' }))).toBe(
      refers('https://example.com/port.json'),
    );
    expect(
      refusal(
        handWritten({
          type: 'object',
          properties: { a: { $ref: '#/$defs/missing' } },
          $defs: {},
        }),
      ),
    ).toBe(refers('#/$defs/missing'));
    expect(refusal(handWritten({ $ref: '#/$defs/toString', $defs: {} }))).toBe(
      refers('#/$defs/toString'),
    );
    expect(
      refusal(
        handWritten({ $dynamicRef: '#p', $defs: { p: { $dynamicAnchor: 'p', type: 'number' } } }),
      ),
    ).toBe(refers('#p'));
    expect(refusal(handWritten({ type: 'number', $id: 'https://example.com/n' }))).toBe(
      refers('https://example.com/n'),
    );
  });

  test('a keyword of an older draft, or a keyword whose value has the wrong shape', () => {
    const uses = (keyword: string) =>
      `${lead} uses "${keyword}" in a form that is not JSON Schema draft 2020-12, which is the form Composer reads.`;
    expect(refusal(handWritten({ type: 'object', dependencies: { a: ['b'] } }))).toBe(
      uses('dependencies'),
    );
    expect(refusal(handWritten({ type: 'array', items: [{ type: 'number' }] }))).toBe(
      uses('items'),
    );
    expect(
      refusal(handWritten({ type: 'object', properties: { a: { additionalItems: false } } })),
    ).toBe(uses('additionalItems'));
    expect(refusal(handWritten({ type: 'number', exclusiveMinimum: true }))).toBe(
      uses('exclusiveMinimum'),
    );
    expect(refusal(handWritten({ type: 'object', properties: [] }))).toBe(uses('properties'));
    expect(refusal(handWritten({ const: undefined }))).toBe(uses('const'));
  });

  test('a pattern that is not valid under the u flag', () => {
    const escapedHyphen = new RegExp(`a${ESCAPED_HYPHEN}b`);
    expect(refusal(z.string().regex(escapedHyphen))).toStartWith(
      `${lead} holds the pattern "a\\-b", which is not valid as a Unicode regular expression: `,
    );
    expect(refusal(z.string().regex(escapedHyphen))).toEndWith(
      '. Rewrite it; an escape such as \\- outside a character class is the usual cause.',
    );
    expect(
      refusal(handWritten({ type: 'object', patternProperties: { 'a\\-b': { type: 'number' } } })),
    ).toStartWith(`${lead} holds the pattern "a\\-b"`);
  });

  test('a schema with no Standard JSON Schema converter', () => {
    const message = `${lead} does not implement Standard JSON Schema. Use a schema from a library that does, such as ArkType or Zod.`;
    expect(
      refusal({ '~standard': { version: 1, vendor: 'x', validate: () => ({ value: 1 }) } }),
    ).toBe(message);
    expect(refusal('number')).toBe(message);
  });

  test('variable.secret() refuses a schema', () => {
    const secretWithSchema: (options: { readonly name: string }) => unknown = variable.secret;
    const options = { name: 'API_KEY', schema: type('string') };
    expect(() => secretWithSchema(options)).toThrow(
      `variable.secret({ name: "API_KEY" }) takes no schema. A platform secret's value arrives as text in a secret box.`,
    );
  });

  test('a refusal fails Load when the root body runs', () => {
    expect(() =>
      Load(
        appRoot('shop', ({ provision }) => {
          provision(variable({ name: NAME, schema: type('string | number') }));
        }),
      ),
    ).toThrow(`${lead} accepts both text and other values`);
  });
});

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const svc = (schema: StandardSchemaV1) =>
  service({
    name: 'mailer',
    extension: '@prisma/composer-prisma-cloud',
    type: 'compute',
    inputs: {},
    params: {},
    input: schema,
    build,
  });

function provisioned<T>(node: ValueResourceNode<PlainVariableValue<T>>): PlainVariableValue<T> {
  let value: PlainVariableValue<T> | undefined;
  Load(
    appRoot('values', ({ provision }) => {
      value = provision(node);
    }),
  );
  if (value === undefined) throw new Error('the root did not provision the variable');
  return value;
}

const boot = (document: string, env: Record<string, string>) =>
  readDocument(JSON.parse(document), { variable: (name) => env[name], secret: (text) => text })
    .value;

describe('a typed platform variable deploys and boots', () => {
  test('the marker carries the schema for a plain variable with one, and none otherwise', () => {
    const port = provisioned(variable({ name: NAME, schema: type('number') }));
    const from = provisioned(variable({ name: 'EMAIL_FROM' }));
    const node = svc(type({ port: arkField(type('number')), from: arkField(type('string')) }));
    const row = serializeInput(node, 'shop.mailer', { port, from });
    expect(JSON.parse(row?.value ?? '')).toEqual({
      port: { $platform: { name: NAME, schema: { type: 'number' } } },
      from: { $platform: { name: 'EMAIL_FROM' } },
    });
    expect(boot(row?.value ?? '', { [NAME]: '587', EMAIL_FROM: 'shop@example.com' })).toEqual({
      port: 587,
      from: 'shop@example.com',
    });
  });

  test('two fields that read one typed variable each hold the full marker', () => {
    const port = provisioned(variable({ name: NAME, schema: type('number') }));
    const node = svc(type({ port: arkField(type('number')), again: arkField(type('number')) }));
    const row = serializeInput(node, 'shop.mailer', { port, again: port });
    const marker = { $platform: { name: NAME, schema: { type: 'number' } } };
    expect(JSON.parse(row?.value ?? '')).toEqual({ port: marker, again: marker });
    expect(boot(row?.value ?? '', { [NAME]: '587' })).toEqual({ port: 587, again: 587 });
  });

  test('an object variable binds to a field of the same object type, as the value, as a literal and through a module', () => {
    const smtpType = type({ host: 'string', port: 'number' });
    const smtp = provisioned(variable({ name: 'SMTP', schema: smtpType }));
    const node = svc(type({ smtp: arkField(smtpType) }));

    const bound = serializeInput(node, 'shop.mailer', { smtp });
    expect(JSON.parse(bound?.value ?? '')).toEqual({
      smtp: {
        $platform: {
          name: 'SMTP',
          schema: {
            type: 'object',
            properties: { host: { type: 'string' }, port: { type: 'number' } },
            required: ['host', 'port'],
          },
        },
      },
    });
    expect(boot(bound?.value ?? '', { SMTP: '{"host":"smtp.example.com","port":587}' })).toEqual({
      smtp: { host: 'smtp.example.com', port: 587 },
    });

    const literal = serializeInput(node, 'shop.mailer', { smtp: { host: 'h', port: 1 } });
    expect(JSON.parse(literal?.value ?? '')).toEqual({ smtp: { host: 'h', port: 1 } });

    const zodSmtp = z.object({ host: z.string(), port: z.number() });
    const mail = module(
      'mail',
      { input: z.object({ smtp: zodField(zodSmtp) }) },
      ({ input, provision }) => {
        provision(svc(z.object({ smtp: zodField(zodSmtp) })), { input: { smtp: input.smtp } });
      },
    );
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(mail, {
          input: { smtp: provision(variable({ name: 'SMTP', schema: zodSmtp })) },
        });
      }),
    );
    const binding = graph.inputBindings[0];
    const address = binding?.serviceAddress ?? '';
    const serviceNode = graph.nodes.find((entry) => entry.id === address)?.node as ServiceNode;
    const forwarded = serializeInput(serviceNode, address, binding?.binding);
    expect(JSON.parse(forwarded?.value ?? '')).toEqual({
      smtp: {
        $platform: {
          name: 'SMTP',
          schema: {
            type: 'object',
            properties: { host: { type: 'string' }, port: { type: 'number' } },
            required: ['host', 'port'],
          },
        },
      },
    });
  });
});
