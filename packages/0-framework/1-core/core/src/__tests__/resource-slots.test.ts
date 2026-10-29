import { describe, expect, test } from 'bun:test';
import { string } from '../config.ts';
import { Load, LoadError } from '../graph.ts';
import {
  type AnyContract,
  dependency,
  freezeNode,
  isNode,
  module,
  ResourceNodeBase,
  type ResourceProps,
  resource,
  service,
} from '../node.ts';
import { resolve } from '../value.ts';
import { conn, providerContract } from './helpers.ts';

const build = {
  extension: '@prisma/composer/node',
  type: 'node',
  module: 'file:///test/service.ts',
  entry: 'server.js',
};

const httpContract = () => providerContract('fake/http', { url: '' });
const urlContract = () => providerContract('fake/url', { url: '' });

const httpDep = () =>
  dependency({
    type: 'fake/http',
    connection: conn({ url: string() }, (v) => ({ url: v.url })),
    required: httpContract(),
  });

const untypedDep = () =>
  dependency({
    type: 'fake/http',
    connection: conn({ url: string() }, (v) => ({ url: v.url })),
  });

const webService = () =>
  service({
    name: 'web',
    extension: 'test/pack',
    type: 'fake/compute',
    inputs: {},
    params: {},
    build,
    expose: { http: httpContract() },
  });

const siteFor = (target: unknown) =>
  resource({
    name: 'site',
    extension: 'test/pack',
    provides: urlContract(),
    inputs: { target: httpDep() },
    deps: { target: target as never },
  });

const loadError = (run: () => unknown): LoadError => {
  try {
    run();
  } catch (error) {
    if (error instanceof LoadError) return error;
    throw error;
  }
  throw new Error('expected a LoadError');
};

const constructionError = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected an Error');
};

const webAndSite = () =>
  module('shop', ({ provision }) => {
    const web = provision(webService(), { id: 'web' });
    provision(siteFor(web.http), { id: 'site' });
  });

describe('a resource with a slot wired at construction', () => {
  test('a resource with a slot wired at construction loads with the slot node, the input edge and the dependency edge', () => {
    const graph = Load(webAndSite());

    const ids = graph.nodes.map((n) => n.id);
    expect(graph.nodes.find((n) => n.id === 'shop.site.target')?.node.kind).toBe('dependency');
    expect(graph.edges).toContainEqual({
      from: 'shop.site.target',
      to: 'shop.site',
      input: 'target',
      kind: 'input',
    });
    expect(graph.edges).toContainEqual({
      from: 'shop.web',
      to: 'shop.site',
      input: 'target',
      kind: 'dependency',
    });
    expect(ids.indexOf('shop.site')).toBeGreaterThan(ids.indexOf('shop.web'));
  });

  test("the resource's slot is an in port and $out stays its out port", () => {
    const graph = Load(webAndSite());

    expect(graph.ports).toContainEqual({
      node: 'shop.site',
      direction: 'in',
      name: 'target',
      contractKind: 'fake/http',
      style: undefined,
    });
    expect(graph.ports).toContainEqual({
      node: 'shop.site',
      direction: 'out',
      name: '$out',
      contractKind: 'fake/url',
      style: undefined,
    });
  });

  test("the authored edge runs from the producer's out port to the resource's in port", () => {
    const graph = Load(webAndSite());

    expect(graph.authoredEdges).toContainEqual({
      from: { node: 'shop.web', direction: 'out', name: 'http' },
      to: { node: 'shop.site', direction: 'in', name: 'target' },
    });
  });

  test("a forwarded module input wired into a resource's slot counts as used and authors the edge from the module's in port", () => {
    const gateway = module('gateway', { deps: { api: httpDep() } }, ({ inputs, provision }) => {
      provision(siteFor(inputs.api), { id: 'site' });
    });
    const root = module('shop', ({ provision }) => {
      const web = provision(webService(), { id: 'web' });
      provision(gateway, { id: 'gateway', deps: { api: web.http } });
    });

    const graph = Load(root);

    expect(graph.authoredEdges).toContainEqual({
      from: { node: 'shop.gateway', direction: 'in', name: 'api' },
      to: { node: 'shop.gateway.site', direction: 'in', name: 'target' },
    });
    expect(graph.edges).toContainEqual({
      from: 'shop.web',
      to: 'shop.gateway.site',
      input: 'target',
      kind: 'dependency',
    });
  });

  test('resource() rejects a declared input with no deps entry, an extra deps entry, and a value in deps', () => {
    const base = { name: 'site', extension: 'test/pack', provides: urlContract() };
    const ref = { id: 'shop.web' };

    expect(
      constructionError(() =>
        resource({ ...base, inputs: { target: httpDep() }, deps: {} as never }),
      ).message,
    ).toBe(
      'resource() declares input "target" but its deps leave it unwired. A resource is wired when it is constructed.',
    );
    expect(
      constructionError(() =>
        resource({
          ...base,
          inputs: { target: httpDep() },
          deps: { target: ref, extra: ref } as never,
        }),
      ).message,
    ).toBe('resource() deps name "extra", which is not a declared input.');
    expect(
      constructionError(() =>
        resource({
          ...base,
          inputs: { target: httpDep() },
          deps: { target: resolve([], () => 'x') } as never,
        }),
      ).message,
    ).toBe(
      'resource() deps wire "target" to a value. A value can configure a node, never decide its edges (ADR-0062).',
    );
  });

  test('provision(resource, { deps }) is still rejected', () => {
    const root = module('shop', ({ provision }) => {
      const web = provision(webService(), { id: 'web' });
      provision(siteFor(web.http), { id: 'site', deps: { target: web.http } } as never);
    });

    expect(loadError(() => Load(root)).message).toBe(
      'provision("site") received deps for a resource — a resource\'s slots are wired when it is constructed, not at provision().',
    );
  });

  test('a resource slot wired to a ref that does not satisfy the required contract fails', () => {
    const root = module('shop', ({ provision }) => {
      const other = provision(
        resource({ name: 'other', extension: 'test/pack', provides: urlContract() }),
        { id: 'other' },
      );
      provision(siteFor(other), { id: 'site' });
    });

    expect(loadError(() => Load(root)).message).toBe(
      'The deps for "shop.site.target" do not satisfy the slot\'s required contract.',
    );
  });

  test('a resource that depends on a service that depends on it is a dependency cycle', () => {
    const backWeb = service({
      name: 'web',
      extension: 'test/pack',
      type: 'fake/compute',
      inputs: { back: untypedDep() },
      params: {},
      build,
      expose: { http: httpContract() },
    });
    const root = module('shop', ({ provision }) => {
      const web = provision(backWeb, { id: 'web', deps: { back: { id: 'shop.site' } } });
      provision(siteFor(web.http), { id: 'site' });
    });

    const message = loadError(() => Load(root)).message;
    expect(message).toMatch(
      /^Dependency cycle: (shop\.web → shop\.site → shop\.web|shop\.site → shop\.web → shop\.site) — no deploy order exists\.$/,
    );
  });
});

describe("a value in a resource's props", () => {
  class SiteNode<C extends AnyContract, P extends ResourceProps> extends ResourceNodeBase<
    C,
    Record<never, never>,
    P
  > {
    constructor(def: { provides: C; props: P }) {
      super({ name: 'site', extension: 'test/pack', provides: def.provides, props: def.props });
      freezeNode(this);
    }

    describe(): string {
      return `site ${this.name}`;
    }
  }

  test("a value in a resource's props is substituted and the graph holds a copy with the prototype kept", () => {
    const url = resolve([], () => 'https://shop.example');
    const authored = new SiteNode({ provides: urlContract(), props: { url } });
    const root = module('shop', ({ provision }) => {
      provision(authored, { id: 'site' });
    });

    const graph = Load(root);

    const node = graph.nodes.find((n) => n.id === 'shop.site')?.node;
    if (!(node instanceof SiteNode))
      throw new Error('expected the copy to keep the SiteNode prototype');
    expect(node.props.url).toBe('https://shop.example');
    expect(node.describe()).toBe('site site');
    expect(isNode(node)).toBe(true);
    expect(node).not.toBe(authored);
    expect(authored.props.url).toBe(url);
  });

  test('a resource whose props hold no value appears in the graph as the authored object', () => {
    const authored = resource({
      name: 'site',
      extension: 'test/pack',
      provides: urlContract(),
      props: { url: 'https://shop.example' },
    });
    const root = module('shop', ({ provision }) => {
      provision(authored, { id: 'site' });
    });

    const graph = Load(root);

    expect(graph.nodes.find((n) => n.id === 'shop.site')?.node).toBe(authored);
  });
});
