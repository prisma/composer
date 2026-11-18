import { describe, expect, test } from 'bun:test';
import {
  appRoot,
  GraphCheckError,
  Load,
  type Pointer,
  paramSource,
  valueResource,
} from '@internal/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { prismaCloud } from '../exports/control.ts';
import { compute } from '../exports/index.ts';
import { PRISMA_CLOUD_EXTENSION_ID } from '../extension-id.ts';
import { checkGraph } from '../graph-check.ts';
import { platformVariableNodes, variable } from '../platform-variable.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const anySchema: StandardSchemaV1<unknown, unknown> = {
  '~standard': { version: 1, vendor: 'test', validate: (value) => ({ value }) },
};

const web = () => compute({ name: 'web', deps: {}, input: anySchema, build });

const thrown = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof GraphCheckError)) throw error;
    return error.message;
  }
  throw new Error('expected the check to throw');
};

describe('the Prisma Cloud graph check', () => {
  test('the extension registers it', () => {
    expect(prismaCloud().checkGraph).toBe(checkGraph);
  });
});

const loadError = (run: () => void): string => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return error.message;
  }
  throw new Error('expected Load to throw');
};

describe('the graph check of platform variable nodes', () => {
  test('two nodes with one name and different ids fail, naming both', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(variable({ name: 'EMAIL_FROM' }));
        provision(variable({ name: 'EMAIL_FROM' }), { id: 'sender' });
      }),
    );

    expect(thrown(() => checkGraph(graph))).toBe(
      'The platform variable "EMAIL_FROM" is declared twice in the app root, by "shop.emailFrom" and "shop.sender". Declare each platform variable once and pass its value to every module that needs it.',
    );
  });

  test('a plain node and a secret node with one name fail, saying which is which', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(variable({ name: 'EMAIL_FROM' }));
        provision(variable.secret({ name: 'EMAIL_FROM' }), { id: 'sender' });
      }),
    );

    expect(thrown(() => checkGraph(graph))).toBe(
      'The platform variable "EMAIL_FROM" is declared twice in the app root, by "shop.emailFrom" and "shop.sender". Declare each platform variable once and pass its value to every module that needs it. "shop.emailFrom" is plain and "shop.sender" is a secret.',
    );
  });

  test('three nodes with one name fail, naming every node and which are plain and which are secrets', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(variable({ name: 'EMAIL_FROM' }), { id: 'a' });
        provision(variable.secret({ name: 'EMAIL_FROM' }), { id: 'b' });
        provision(variable({ name: 'EMAIL_FROM' }), { id: 'c' });
      }),
    );

    expect(thrown(() => checkGraph(graph))).toBe(
      'The platform variable "EMAIL_FROM" is declared 3 times in the app root, by "shop.a", "shop.b" and "shop.c". Declare each platform variable once and pass its value to every module that needs it. "shop.a" and "shop.c" are plain and "shop.b" is a secret.',
    );
  });

  test('a value resource of another extension is not a platform variable node', () => {
    const foreign = valueResource({
      name: 'foreign',
      extension: 'other/pack',
      type: 'platform-variable',
      props: { name: 'EMAIL_FROM' },
      value: paramSource<{ readonly name: string }, Pointer<string>>({ name: 'EMAIL_FROM' }),
    });
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(variable({ name: 'EMAIL_FROM' }));
        provision(foreign);
      }),
    );

    expect(() => checkGraph(graph)).not.toThrow();
    expect(platformVariableNodes(graph).map((node) => node.address)).toEqual(['shop.emailFrom']);
  });

  test('a platform variable node whose props hold no name is refused', () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(
          valueResource({
            name: 'broken',
            extension: PRISMA_CLOUD_EXTENSION_ID,
            type: 'platform-variable',
            props: { name: 5 },
            value: paramSource<{ readonly name: string }, Pointer<string>>({ name: 'X' }),
          }),
        );
      }),
    );

    expect(() => checkGraph(graph)).toThrow(
      'The platform variable node "shop.broken" has no name in its props, so Composer cannot tell which platform variable it declares. Build it with variable() or variable.secret().',
    );
  });

  test('one node object provisioned with two ids is declared twice', () => {
    const from = variable({ name: 'EMAIL_FROM' });
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        provision(from, { id: 'from' });
        provision(from, { id: 'sender' });
      }),
    );

    expect(thrown(() => checkGraph(graph))).toBe(
      'The platform variable "EMAIL_FROM" is declared twice in the app root, by "shop.from" and "shop.sender". Declare each platform variable once and pass its value to every module that needs it.',
    );
  });

  test('one node object provisioned twice with the default id fails Load with the duplicate-id error', () => {
    const from = variable({ name: 'EMAIL_FROM' });

    expect(
      loadError(() =>
        Load(
          appRoot('shop', ({ provision }) => {
            provision(from);
            provision(from);
          }),
        ),
      ),
    ).toBe(
      'Duplicate provision id "emailFrom" in module "shop": "shop.emailFrom" already holds the platform variable "EMAIL_FROM", and the platform variable "EMAIL_FROM" takes the same id. Give one of them a different id with provision(node, { id: \'…\' }).',
    );
  });

  test('two names that give one default id fail Load with the duplicate-id error naming both', () => {
    expect(
      loadError(() =>
        Load(
          appRoot('shop', ({ provision }) => {
            provision(variable({ name: 'A_B' }));
            provision(variable.secret({ name: 'A__B' }));
          }),
        ),
      ),
    ).toBe(
      'Duplicate provision id "aB" in module "shop": "shop.aB" already holds the platform variable "A_B", and the platform secret "A__B" takes the same id. Give one of them a different id with provision(node, { id: \'…\' }).',
    );
  });

  test('a plain node and a root input field the body passes on, with one name, fail', () => {
    const graph = Load(
      appRoot('shop', { input: type({ EMAIL_FROM: 'string' }) }, ({ input, provision }) => {
        const from = provision(variable({ name: 'EMAIL_FROM' }));
        provision(web(), { id: 'site', input: { from, replyTo: input.EMAIL_FROM } });
      }),
      { configuration: { EMAIL_FROM: 'shop@example.com' } },
    );

    expect(thrown(() => checkGraph(graph))).toBe(
      '"EMAIL_FROM" is used two ways: as the platform variable "shop.emailFrom", which services read at boot, and as input.EMAIL_FROM of root module "shop", which the deploy reads. A name has one meaning in an app. Use one of them, or give the other a different name.',
    );
  });

  test.each([
    ['read by a service', true],
    ['read by no service', false],
  ])(
    'a secret node and a root input field with one name fail Load, when the node is %s',
    (_, read) => {
      const message = loadError(() =>
        Load(
          appRoot('shop', { input: type({ EMAIL_KEY: 'string' }) }, ({ input, provision }) => {
            const key = provision(variable.secret({ name: 'EMAIL_KEY' }));
            provision(web(), {
              id: 'site',
              input: read ? { key, other: input.EMAIL_KEY } : { other: input.EMAIL_KEY },
            });
          }),
          { configuration: { EMAIL_KEY: 'plain text' } },
        ),
      );

      expect(message).toBe(
        'input.EMAIL_KEY of root module "shop" reads "EMAIL_KEY" from the app configuration, and the platform secret "EMAIL_KEY" names "EMAIL_KEY" as a secret. A name is a plain value or a secret, not both: a root input field is a plain value, which `prisma deploy` sends to the platform as plain configuration, and `prisma dev` hands to its converge worker thread, and `destroy` hands to its second process in a file. Read the secret with the platform secret "EMAIL_KEY" only, or give the plain value a different name.',
      );
    },
  );

  test("a node value bound as a service's whole input fails", () => {
    const graph = Load(
      appRoot('shop', ({ provision }) => {
        const from = provision(variable({ name: 'EMAIL_FROM' }));
        provision(web(), { id: 'site', input: from });
      }),
    );

    expect(thrown(() => checkGraph(graph))).toBe(
      'The platform variable "EMAIL_FROM" is bound as the whole input of service "shop.site". Bind it to one field of the input instead.',
    );
  });

  test('one node read by two services, a root input field of another name, and another secret node pass', () => {
    const graph = Load(
      appRoot('shop', { input: type({ GREETING: 'string' }) }, ({ input, provision }) => {
        const from = provision(variable({ name: 'EMAIL_FROM' }));
        const key = provision(variable.secret({ name: 'EMAIL_KEY' }));
        const other = provision(variable.secret({ name: 'OTHER_KEY' }));
        provision(web(), { id: 'site', input: { from, key, greeting: input.GREETING } });
        provision(web(), { id: 'api', input: { from, other } });
      }),
      { configuration: { GREETING: 'hello' } },
    );

    expect(() => checkGraph(graph)).not.toThrow();
  });
});
