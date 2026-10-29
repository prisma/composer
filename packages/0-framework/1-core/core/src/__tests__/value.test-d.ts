import { expectTypeOf, test } from 'vitest';
import { type number, string } from '../config.ts';
import type {
  InputBinding,
  ModuleContext,
  ParamBindings,
  RefPort,
  SecretSource,
  Value,
} from '../exports/index.ts';
import { dependency, module, resolve, resource, service } from '../exports/index.ts';
import { conn, providerContract } from './helpers.ts';

let name!: Value<string>;
let count!: Value<number>;
let date!: Value<Date>;
let secretValue!: Value<SecretSource>;

test("fn receives its dependencies' real values as a readonly tuple", () => {
  resolve([name], (values) => {
    expectTypeOf(values).toEqualTypeOf<readonly [string]>();
    return values[0];
  });
  resolve([name, count], (values) => {
    expectTypeOf(values).toEqualTypeOf<readonly [string, number]>();
    return values[1];
  });
  // @ts-expect-error a one-member tuple has no second member
  resolve([name], ([, second]) => second);
});

test("resolve() over no dependencies returns a value of fn's return type", () => {
  expectTypeOf(resolve([], () => 42)).toEqualTypeOf<Value<number>>();
});

test('a Value<number> is not a Value<string>, and every value is a Value<unknown>', () => {
  expectTypeOf(count).not.toExtend<Value<string>>();
  expectTypeOf(name).toExtend<Value<unknown>>();
});

test('a value exposes no readable member', () => {
  // @ts-expect-error a value has no origin a module body can read
  void name.origin;
});

test('a value standing for plain data is an input binding leaf; any other value is not', () => {
  expectTypeOf({ greeting: name }).toExtend<InputBinding>();
  expectTypeOf({ when: date }).not.toExtend<InputBinding>();
  expectTypeOf(secretValue).not.toExtend<InputBinding>();
});

test("a param binding accepts a value of the param's own type only", () => {
  type Bindings = ParamBindings<{
    label: ReturnType<typeof string>;
    port: ReturnType<typeof number>;
  }>;
  expectTypeOf({ label: count }).not.toExtend<Bindings>();
  expectTypeOf({ port: count }).toExtend<Bindings>();
  expectTypeOf({ label: name }).toExtend<Bindings>();
});

test("provision() refuses a value as the node's id", () => {
  const plain = service({
    name: 'plain',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: {},
    build: { extension: 'test/build', type: 'node', module: 'file:///x.ts', entry: 'x.js' },
  });
  module('shop', ({ provision }) => {
    // @ts-expect-error an id is a string, never a value
    provision(plain, { id: name });
  });
});

test('the module context carries environment.name as a value', () => {
  expectTypeOf<ModuleContext<Record<never, never>>['environment']['name']>().toEqualTypeOf<
    Value<string>
  >();
});

test('a resource declares its slots and wires them at construction, checked against each contract', () => {
  const http = providerContract('fake/http', { url: '' });
  const db = providerContract('fake/db', { url: '' });
  const target = dependency({
    type: 'fake/http',
    connection: conn({ url: string() }, (v) => ({ url: v.url })),
    required: http,
  });
  let httpRef!: RefPort<typeof http>;
  let dbRef!: RefPort<typeof db>;
  const base = { name: 'site', extension: 'test/pack', provides: providerContract('fake/url', {}) };

  resource({ ...base, inputs: { target }, deps: { target: httpRef } });
  // @ts-expect-error a declared input must be wired in deps
  resource({ ...base, inputs: { target }, deps: {} });
  // @ts-expect-error the ref does not provide the slot's required contract
  resource({ ...base, inputs: { target }, deps: { target: dbRef } });
});
