import { describe, expect, test } from 'bun:test';
import { secretString } from '@internal/foundation/arktype';
import { SecretBox } from '@internal/foundation/secret';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { type } from 'arktype';
import { string } from '../config.ts';
import { type Graph, Load, LoadError } from '../graph.ts';
import {
  dependency,
  type ModuleNode,
  module,
  paramSource,
  type SecretSource,
  secret,
  secretSource,
  service,
} from '../node.ts';
import { isValue, resolve } from '../value.ts';
import { anyInputSchema, conn, providerContract } from './helpers.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const echoService = () =>
  service({
    name: 'echo',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: { label: string() },
    input: anyInputSchema,
    build,
  });

const plainService = () =>
  service({
    name: 'plain',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: {},
    build,
  });

const staging = { environment: { name: 'staging' } };

const loadError = (run: () => unknown): LoadError => {
  try {
    run();
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error('expected a LoadError');
};

const recording = (seen: unknown[]): StandardSchemaV1 => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => {
      seen.push(value);
      return { value };
    },
  },
});

const refusing = (message: string): StandardSchemaV1 => ({
  '~standard': { version: 1, vendor: 'test', validate: () => ({ issues: [{ message }] }) },
});

const forgedInputField = (moduleAddress: string): never =>
  ({
    [Symbol.for('prisma:value')]: true,
    [Symbol.for('prisma:value-origin')]: { kind: 'input', module: moduleAddress, path: ['from'] },
  }) as never;

/** A root `shop` that provisions `child` as `email` with `input`. */
const shopWith = (child: ModuleNode, input: unknown): ModuleNode =>
  module('shop', ({ provision }) => {
    provision(child as never, { id: 'email', input } as never);
  });

const bindingOf = (graph: Graph, index = 0): Record<string, unknown> =>
  graph.inputBindings[index]?.binding as unknown as Record<string, unknown>;

describe("the body's input", () => {
  test('a module body receives one value per input field, and the same path gives the same value', () => {
    const seen: boolean[] = [];
    const email = module(
      'email',
      { input: type({ from: 'string', smtp: { host: 'string' } }) },
      ({ input }) => {
        const first = input.smtp.host;
        const second = input.smtp.host;
        seen.push(isValue(input.from), isValue(input), first === second);
      },
    );

    Load(shopWith(email, { from: 'a', smtp: { host: 'h' } }), staging);

    expect(seen).toEqual([true, true, true]);
  });

  test('a module that declares no input receives undefined', () => {
    let received: unknown = 'not called';
    const child = module('child', {}, ({ input }) => {
      received = input;
    });

    Load(
      module('shop', ({ provision }) => {
        provision(child);
      }),
    );

    expect(received).toBeUndefined();
  });

  test('turning an input field into text fails naming the field', () => {
    const email = module('email', { input: type({ domain: 'string' }) }, ({ input, provision }) => {
      provision(echoService(), { input: { from: `noreply@${input.domain}` } });
    });

    expect(loadError(() => Load(shopWith(email, { domain: 'shop.com' }))).message).toBe(
      'input.domain of module "shop.email" is a value, not its real value, and it was turned ' +
        'into text (a template literal or String()). A module body can only pass an input field ' +
        'on: into a provision() binding or as a resolve() dependency. To compute with it, list ' +
        'it: resolve([input.domain], ([v]) => …).',
    );
  });

  test('each way of reading an input field fails naming the field and what was done', () => {
    // biome-ignore lint/suspicious/noExplicitAny: each operation reads the field as whatever it needs to be.
    const operations: [string, (f: any) => unknown, string][] = [
      ['String(f)', (f) => String(f), 'it was turned into text (a template literal or String())'],
      [
        'template literal',
        (f) => `${f}`,
        'it was turned into text (a template literal or String())',
      ],
      [
        'f * 2',
        (f) => f * 2,
        'it was turned into a number (arithmetic, or a comparison such as <)',
      ],
      ['f + 1', (f) => f + 1, 'it was combined with + or compared with =='],
      ['f.toString()', (f) => f.toString(), 'its toString() was called'],
      ['f.valueOf()', (f) => f.valueOf(), 'its valueOf() was called'],
      ['JSON.stringify(f)', (f) => JSON.stringify(f), 'it was serialized with JSON.stringify'],
      [
        'Object.keys(f)',
        (f) => Object.keys(f),
        'its keys were listed (Object.keys, object spread, for…in or Object.entries)',
      ],
      [
        '({ ...f })',
        (f) => ({ ...f }),
        'its keys were listed (Object.keys, object spread, for…in or Object.entries)',
      ],
      [
        'for (const k in f)',
        (f) => {
          const keys: string[] = [];
          for (const k in f) keys.push(k);
          return keys;
        },
        'its keys were listed (Object.keys, object spread, for…in or Object.entries)',
      ],
      ['[...f]', (f) => [...f], 'it was iterated (array spread, for…of or array destructuring)'],
      ["'x' in f", (f) => 'x' in f, 'it was checked with the in operator ("x" in …)'],
      [
        'f.x = 1',
        (f) => {
          f.x = 1;
        },
        'its field "x" was assigned to',
      ],
      [
        'delete f.x',
        (f) => {
          delete f.x;
        },
        'a property was deleted from it',
      ],
      ['Object.freeze(f)', (f) => Object.freeze(f), 'it was frozen or sealed'],
      [
        'Object.setPrototypeOf(f, null)',
        (f) => Object.setPrototypeOf(f, null),
        'its prototype was changed',
      ],
    ];

    for (const [label, operation, what] of operations) {
      const email = module('email', { input: type({ f: 'string' }) }, ({ input }) => {
        operation(input.f);
      });
      const error = loadError(() => Load(shopWith(email, { f: 'x' })));
      expect(error.message, label).toContain(
        `input.f of module "shop.email" is a value, not its real value, and ${what}.`,
      );
    }
  });

  test('a truthiness check on an input field always takes the branch', () => {
    const child = module(
      'child',
      { input: type({ enabled: 'boolean' }) },
      ({ input, provision }) => {
        if (input.enabled) provision(plainService(), { id: 'extra' });
      },
    );

    const graph = Load(
      module('shop', ({ provision }) => {
        provision(child, { input: { enabled: false } });
      }),
    );

    expect(graph.nodes.map((entry) => entry.id)).toContain('shop.child.extra');
  });
});

describe('forwarding and the second pass', () => {
  test("a field forwarded into a service's input reaches it as the bound literal", () => {
    const email = module('email', { input: type({ from: 'string' }) }, ({ input, provision }) => {
      provision(echoService(), { input: { from: input.from } });
    });

    const graph = Load(shopWith(email, { from: 'shop@example.com' }), staging);

    expect(bindingOf(graph)).toEqual({ from: 'shop@example.com' });
  });

  test("the whole input forwarded into a service reaches it as the module's validated input", () => {
    const email = module(
      'email',
      { input: type({ from: 'string', count: 'string.integer.parse' }) },
      ({ input, provision }) => {
        provision(echoService(), { input });
      },
    );

    const graph = Load(shopWith(email, { from: 'shop@example.com', count: '2' }), staging);

    expect(bindingOf(graph)).toEqual({ from: 'shop@example.com', count: 2 });
  });

  test('a field forwarded through two modules reaches the service', () => {
    const email = module('email', { input: type({ from: 'string' }) }, ({ input, provision }) => {
      provision(echoService(), { input: { from: input.from } });
    });
    const relay = module('relay', { input: type({ from: 'string' }) }, ({ input, provision }) => {
      provision(email, { input: { from: input.from } });
    });

    const graph = Load(
      module('shop', ({ provision }) => {
        provision(relay, { input: { from: 'shop@example.com' } });
      }),
      staging,
    );

    expect(graph.inputBindings[0]?.serviceAddress).toBe('shop.relay.email.echo');
    expect(bindingOf(graph)).toEqual({ from: 'shop@example.com' });
  });

  test('a secret source forwarded through two module schemas with an ArkType morph reaches the service by identity', () => {
    const schema = () => type({ key: secretString(), n: 'string.integer.parse' });
    const email = module('email', { input: schema() }, ({ input, provision }) => {
      provision(echoService(), { input: { key: input.key, n: input.n } });
    });
    const relay = module('relay', { input: schema() }, ({ input, provision }) => {
      provision(email, { input: { key: input.key, n: '4' } });
    });
    const source = secretSource({ name: 'EMAIL_KEY' });

    const graph = Load(
      module('shop', ({ provision }) => {
        provision(relay, { input: { key: source, n: '4' } });
      }),
    );

    expect(bindingOf(graph)['key']).toBe(source);
  });

  test("a real value is the schema's output", () => {
    const email = module(
      'email',
      { input: type({ n: 'string.integer.parse' }) },
      ({ input, provision }) => {
        provision(echoService(), { input: { n: input.n } });
      },
    );

    const graph = Load(shopWith(email, { n: '4' }));

    expect(bindingOf(graph)['n']).toBe(4);
  });

  test('an optional field the binding leaves out is a key left out of the service binding', () => {
    const email = module(
      'email',
      { input: type({ from: 'string', 'replyTo?': 'string' }) },
      ({ input, provision }) => {
        provision(echoService(), { input: { from: input.from, replyTo: input.replyTo } });
      },
    );

    const graph = Load(shopWith(email, { from: 'shop@example.com' }));

    expect('replyTo' in bindingOf(graph)).toBe(false);
    expect(bindingOf(graph)).toEqual({ from: 'shop@example.com' });
  });

  test("environment.name and a resolve() result in a module's binding are resolved before the module's schema runs", () => {
    const seen: unknown[] = [];
    const child = module('child', { input: recording(seen) }, () => {});

    Load(
      module('shop', ({ environment, provision }) => {
        provision(child, {
          input: { label: resolve([environment.name], ([name]) => `hi ${name}`) },
        });
      }),
      staging,
    );

    expect(seen).toEqual([{ label: 'hi staging' }]);
  });

  test('resolve() over input fields receives their real values', () => {
    const email = module(
      'email',
      { input: type({ host: 'string' }) },
      ({ input, environment, provision }) => {
        const url = resolve([input.host, environment.name], ([host, name]) => `${name}.${host}`);
        provision(echoService(), { input: { url } });
      },
    );

    const graph = Load(shopWith(email, { host: 'shop.com' }), staging);

    expect(bindingOf(graph)).toEqual({ url: 'staging.shop.com' });
  });

  test('resolve() over a secret field receives the secret source', () => {
    let received: unknown;
    const email = module(
      'email',
      { input: type({ key: secretString() }) },
      ({ input, provision }) => {
        const marker = resolve([input.key], ([key]) => {
          received = key;
          return 'x';
        });
        provision(echoService(), { input: { marker } });
      },
    );
    const source = secretSource({ name: 'EMAIL_KEY' });

    Load(shopWith(email, { key: source }));

    expect(received).toBe(source);
  });

  test('a resolve() function that returns an input field fails as returning a value', () => {
    const child = module(
      'child',
      { input: type({ host: 'string' }) },
      ({ input, environment, provision }) => {
        provision(echoService(), {
          input: { host: resolve([environment.name], () => input.host) as never },
        });
      },
    );

    const error = loadError(() =>
      Load(
        module('shop', ({ provision }) => {
          provision(child, { input: { host: 'shop.com' } });
        }),
        staging,
      ),
    );

    expect(error.message).toBe(
      'The resolve() function for input key "host" of service "shop.child.echo" returned a ' +
        'value, not a real value. List that value as a dependency; fn receives its real value.',
    );
  });

  test("a module's schema runs once per Load, however many fields are read", () => {
    const seen: unknown[] = [];
    const schema = recording(seen) as StandardSchemaV1<{ a: string; b: string; c: string }>;
    const email = module('email', { input: schema }, ({ input, provision }) => {
      provision(echoService(), { id: 'one', input: { a: input.a } });
      provision(echoService(), { id: 'two', input: { b: input.b, c: input.c } });
    });

    Load(shopWith(email, { a: 'a', b: 'b', c: 'c' }));

    expect(seen).toHaveLength(1);
  });

  test("every provisioned module's binding is validated, even when the body uses no field", () => {
    const email = module('email', { input: refusing('nope') }, () => {});

    expect(loadError(() => Load(shopWith(email, {}))).message).toBe(
      'The input binding of module "shop.email" does not match the module\'s input schema: nope',
    );
  });

  test("a forwarded secrets slot inside a module's input binding counts as used", () => {
    const email = module(
      'email',
      { input: type({ from: 'string', key: secretString() }) },
      ({ input, provision }) => {
        provision(echoService(), { input: { from: input.from, key: input.key } });
      },
    );
    const relay = module(
      'relay',
      { secrets: { key: secret() }, input: type({ from: 'string' }) },
      ({ input, secrets, provision }) => {
        provision(email, { input: { from: input.from, key: secrets.key } });
      },
    );
    const source = secretSource({ name: 'EMAIL_KEY' });

    const graph = Load(
      module('shop', ({ provision }) => {
        provision(relay, { input: { from: 'shop@example.com' }, secrets: { key: source } });
      }),
    );

    const key = bindingOf(graph)['key'] as SecretSource;
    expect(key.payload).toBe(source.payload);
  });
});

describe('errors', () => {
  test("a binding the module's schema refuses fails naming the module", () => {
    const email = module('email', { input: refusing('from is required') }, () => {});

    expect(loadError(() => Load(shopWith(email, {}))).message).toBe(
      'The input binding of module "shop.email" does not match the module\'s input schema: ' +
        'from is required',
    );
  });

  test('an async module schema fails the Load', () => {
    const asyncSchema: StandardSchemaV1 = {
      '~standard': { version: 1, vendor: 'test', validate: async (value) => ({ value }) },
    };
    const email = module('email', { input: asyncSchema }, () => {});

    expect(loadError(() => Load(shopWith(email, {}))).message).toBe(
      'The input schema of module "shop.email" returned a Promise from validate(). A module\'s ' +
        'input is validated synchronously at Load; use a schema with no asynchronous checks.',
    );
  });

  test("a plain string where an ArkType secretString() field is expected fails with the schema's message", () => {
    const email = module('email', { input: type({ key: secretString() }) }, () => {});

    expect(loadError(() => Load(shopWith(email, { key: 'plain' }))).message).toStartWith(
      'The input binding of module "shop.email" does not match the module\'s input schema: ',
    );
  });

  test("a param source in a module's input binding fails naming the key", () => {
    const email = module('email', { input: anyInputSchema }, () => {});

    expect(
      loadError(() => Load(shopWith(email, { from: paramSource({ name: 'X' }) }))).message,
    ).toBe(
      'input key "from" of module "shop.email" is bound to a param source, such as envParam(). ' +
        "A module's input does not take a param source yet; bind it on the service's input " +
        "inside the module, or forward it through the module's params slot.",
    );
  });

  test("a SecretString in a module's input binding fails naming the key", () => {
    const email = module('email', { input: anyInputSchema }, () => {});

    expect(loadError(() => Load(shopWith(email, { key: new SecretBox('x') }))).message).toBe(
      'input key "key" of module "shop.email" is bound to a SecretString. A secret\'s value ' +
        "never appears in the code; bind envSecret('NAME'), or pass on an input field typed " +
        'secretString().',
    );
  });

  test('a schema that produces a SecretString its binding did not supply fails', () => {
    const minting: StandardSchemaV1 = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: { key: new SecretBox('x') } }),
      },
    };
    const email = module('email', { input: minting }, () => {});

    expect(loadError(() => Load(shopWith(email, {}))).message).toBe(
      'The input schema of module "shop.email" produced a SecretString at "key" that its ' +
        "binding did not supply. A module's schema may check a secret field, never create one.",
    );
  });

  test('a module that declares input but is provisioned without one fails', () => {
    const email = module('email', { input: anyInputSchema }, () => {});

    expect(loadError(() => Load(shopWith(email, undefined))).message).toBe(
      'Input of provisioned module "email" is not bound (module "shop") — the module declares ' +
        'an input schema; bind it with `input: { … }` on its provision() call.',
    );
  });

  test('an input binding for a module that declares no input fails', () => {
    const email = module('email', {}, () => {});

    expect(loadError(() => Load(shopWith(email, {}))).message).toBe(
      'provision("email") received an input binding, but the module declares no input schema ' +
        '(module "shop").',
    );
  });

  test('a root that declares input fails', () => {
    const shop = module('shop', { input: anyInputSchema }, () => {});

    expect(loadError(() => Load(shop)).message).toBe(
      'Module "shop" declares input but is being deployed as the root. Composer cannot fill a ' +
        'root\'s input yet; provision "shop" from another module and bind its input there.',
    );
  });

  test('module() refuses an input that is not a Standard Schema', () => {
    expect(() => module('email', { input: {} as never }, () => {})).toThrow(
      'module() `input` must be a Standard Schema (an object with a "~standard".validate ' +
        'function) — see https://standardschema.dev (ADR-0061).',
    );
  });

  test('an input field of a module this Load does not provision fails', () => {
    const shop = module('shop', ({ provision }) => {
      provision(echoService(), { input: { from: forgedInputField('shop.gone') } });
    });

    expect(loadError(() => Load(shop)).message).toBe(
      'input key "from" of service "shop.echo" depends on input.from of module "shop.gone", ' +
        'which this Load does not provision. An input field can be passed on only inside the ' +
        'body of the module that received it.',
    );
  });

  test("a module's binding that holds its own input field is a cycle", () => {
    const email = module('email', { input: anyInputSchema }, () => {});

    expect(
      loadError(() => Load(shopWith(email, { from: forgedInputField('shop.email') }))).message,
    ).toBe(
      'The input binding of module "shop.email" depends on that module\'s own input. Remove the cycle.',
    );
  });

  test('an input field returned as an exposed interface fails', () => {
    const email = module(
      'email',
      { input: type({ from: 'string' }), expose: { send: providerContract('fake/send', {}) } },
      ({ input }) => ({ send: input.from as never }),
    );

    expect(loadError(() => Load(shopWith(email, { from: 'a' }))).message).toBe(
      'Module "email" returned a value for expose "send". A value can configure a node, never ' +
        'decide its edges: return a port of a node the body provisions.',
    );
  });

  test("an input field in a service's deps fails with the existing deps message", () => {
    const svc = service({
      name: 'svc',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: { target: dependency({ type: 'fake/target', connection: conn({}, () => ({})) }) },
      params: {},
      build,
    });
    const email = module('email', { input: type({ from: 'string' }) }, ({ input, provision }) => {
      provision(svc, { deps: { target: input.from } });
    });

    expect(loadError(() => Load(shopWith(email, { from: 'a' }))).message).toBe(
      'The deps for "shop.email.svc.target" are bound to a value. A value can configure a node, ' +
        'never decide its edges: the graph is the same whatever inputs Composer is given (ADR-0062).',
    );
  });

  test("an input field bound to a module's secrets slot fails with the existing message", () => {
    const auth = module('auth', { secrets: { key: secret() } }, ({ secrets, provision }) => {
      provision(echoService(), { input: { key: secrets.key } });
    });
    const email = module(
      'email',
      { input: type({ key: secretString() }) },
      ({ input, provision }) => {
        provision(auth, { secrets: { key: input.key as never } });
      },
    );

    expect(
      loadError(() => Load(shopWith(email, { key: secretSource({ name: 'K' }) }))).message,
    ).toBe(
      'The secrets for "shop.email.auth" bind "key" to a value. A value is not a secret source; ' +
        "bind envSecret('NAME') or a forwarded ctx.secrets ref.",
    );
  });
});
