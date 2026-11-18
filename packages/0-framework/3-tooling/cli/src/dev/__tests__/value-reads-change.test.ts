import { describe, expect, test } from 'bun:test';
import { appRoot, Load, paramSource, secretSource, service, valueResource } from '@internal/core';
import type { Pointer } from '@internal/foundation/pointer';
import type { SecretString } from '@internal/foundation/secret';
import { valueReadsChange, valueReadsSnapshot } from '../value-reads-change.ts';

interface NodeSpec {
  readonly id: string;
  readonly name: string;
  readonly secret?: boolean;
  /** Whether the node's props hold an object branded under a symbol key, which `structuredClone` drops. */
  readonly brandedProp?: boolean;
  /** Further props of the node. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

interface ReadSpec {
  readonly reader: 'mail' | 'digest';
  readonly node: string;
  readonly path: string;
}

const anyInput = {
  '~standard': {
    version: 1 as const,
    vendor: 'test',
    validate: (value: unknown) => ({ value }),
  },
};

const reader = (name: string) =>
  service({
    name,
    extension: 'test/pack',
    type: 'compute',
    inputs: {},
    params: {},
    input: anyInput,
    build: { extension: 'test/build', type: 'node', module: 'file:///test/app.ts', entry: 'x.js' },
  });

function readsOf(nodes: readonly NodeSpec[], reads: readonly ReadSpec[]) {
  return valueReadsSnapshot(graphOf(nodes, reads));
}

function graphOf(nodes: readonly NodeSpec[], reads: readonly ReadSpec[]) {
  return Load(
    appRoot('shop', ({ provision }) => {
      const values = new Map<string, unknown>();
      for (const node of nodes) {
        const payload = { name: node.name };
        const value =
          node.secret === true
            ? secretSource<typeof payload, Pointer<SecretString>>(payload, {
                label: `the secret ${node.name}`,
                secretsKey: node.name,
              })
            : paramSource<typeof payload, Pointer<string>>(payload, {
                label: `the variable ${node.name}`,
              });
        const resource = valueResource({
          name: node.id,
          extension: 'test/pack',
          type: 'variable',
          props: {
            name: node.name,
            secret: node.secret === true,
            ...(node.brandedProp === true
              ? { kind: { [Symbol.for('test:brand')]: true, name: 'variable' } }
              : {}),
            ...node.extra,
          },
          value,
        });
        values.set(node.id, provision(resource, { id: node.id }));
      }
      for (const name of ['mail', 'digest'] as const) {
        const mine = reads.filter((read) => read.reader === name);
        if (mine.length === 0) continue;
        const input = Object.fromEntries(mine.map((read) => [read.path, values.get(read.node)]));
        provision(reader(name), { id: name, input } as never);
      }
    }),
  );
}

const fromRead: ReadSpec = { reader: 'mail', node: 'emailFrom', path: 'from' };
const emailFrom: NodeSpec = { id: 'emailFrom', name: 'EMAIL_FROM' };
const unread: NodeSpec = { id: 'unread', name: 'UNREAD' };

describe('valueReadsChange', () => {
  test('a snapshot whose read node holds a symbol-branded object in its props is no change from its own structured clone', () => {
    const started = readsOf([{ ...emailFrom, brandedProp: true }], [fromRead]);

    expect(valueReadsChange(structuredClone(started), started)).toBeUndefined();
  });

  test('identical graphs built in another order are no change', () => {
    const token: NodeSpec = { id: 'token', name: 'API_TOKEN' };
    const tokenRead: ReadSpec = { reader: 'digest', node: 'token', path: 'token' };

    expect(
      valueReadsChange(
        readsOf([emailFrom, token], [fromRead, tokenRead]),
        readsOf([token, emailFrom], [tokenRead, fromRead]),
      ),
    ).toBeUndefined();
  });

  test('a new reader of a node already read is an added read', () => {
    expect(
      valueReadsChange(
        readsOf([emailFrom], [fromRead]),
        readsOf([emailFrom], [fromRead, { ...fromRead, reader: 'digest' }]),
      ),
    ).toEqual({ added: ['shop.emailFrom'], removed: [], changed: [] });
  });

  test('a reader removed while another stays is a removed read', () => {
    expect(
      valueReadsChange(
        readsOf([emailFrom], [fromRead, { ...fromRead, reader: 'digest' }]),
        readsOf([emailFrom], [fromRead]),
      ),
    ).toEqual({ added: [], removed: ['shop.emailFrom'], changed: [] });
  });

  test('a read that moves to another field of the same service is a change', () => {
    expect(
      valueReadsChange(
        readsOf([emailFrom], [fromRead]),
        readsOf([emailFrom], [{ ...fromRead, path: 'sender' }]),
      ),
    ).toEqual({ added: [], removed: [], changed: ['shop.emailFrom'] });
  });

  test("a secret node's added read is an added read", () => {
    const key: NodeSpec = { id: 'key', name: 'API_KEY', secret: true };

    expect(
      valueReadsChange(
        readsOf([emailFrom, key], [fromRead]),
        readsOf([emailFrom, key], [fromRead, { ...fromRead, node: 'key', path: 'key' }]),
      ),
    ).toEqual({ added: ['shop.key'], removed: [], changed: [] });
  });

  test('changed props on a read node are a change', () => {
    expect(
      valueReadsChange(
        readsOf([emailFrom], [fromRead]),
        readsOf([{ ...emailFrom, name: 'EMAIL_SENDER' }], [fromRead]),
      ),
    ).toEqual({ added: [], removed: [], changed: ['shop.emailFrom'] });
  });

  test('changed props on a node no service reads are no change', () => {
    expect(
      valueReadsChange(
        readsOf([emailFrom, unread], [fromRead]),
        readsOf([emailFrom, { ...unread, secret: true }], [fromRead]),
      ),
    ).toBeUndefined();
  });

  test('each node is named in one list only', () => {
    const port: NodeSpec = { id: 'smtpPort', name: 'SMTP_PORT' };
    const sender: NodeSpec = { id: 'sender', name: 'EMAIL_SENDER' };
    const senderRead: ReadSpec = { reader: 'mail', node: 'sender', path: 'sender' };

    expect(
      valueReadsChange(
        readsOf([emailFrom, sender, port], [fromRead, senderRead]),
        readsOf(
          [emailFrom, { ...sender, secret: true }, port],
          [senderRead, { reader: 'mail', node: 'smtpPort', path: 'port' }],
        ),
      ),
    ).toEqual({ added: ['shop.smtpPort'], removed: ['shop.emailFrom'], changed: ['shop.sender'] });
  });

  test("two different dates in a read node's props are a change", () => {
    expect(
      valueReadsChange(
        readsOf([{ ...emailFrom, extra: { since: new Date(1) } }], [fromRead]),
        readsOf([{ ...emailFrom, extra: { since: new Date(2) } }], [fromRead]),
      ),
    ).toEqual({ added: [], removed: [], changed: ['shop.emailFrom'] });
  });
});
