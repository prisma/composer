import type { DepBindings, Graph, ResourceNode, Value } from '@internal/core';
import { isValue, resource } from '@internal/core';
import { rawHttp } from '@internal/http';
import { PRISMA_CLOUD_EXTENSION_ID } from './extension-id.ts';

/** Serve the service at a hostname the author names. */
export type HostnameStrategy = {
  readonly strategy: 'hostname';
  readonly hostname: string;
};

/** Serve the service at the hostname the platform gives it. */
export type PrismaBuildStrategy = {
  readonly strategy: 'prisma-build';
};

export type PublicUrlStrategy = HostnameStrategy | PrismaBuildStrategy;

/** What `url` accepts: a strategy, a bare hostname, or a value that resolves to either. */
export type PublicUrlOption = string | PublicUrlStrategy | Value<string | PublicUrlStrategy>;

type PublicUrlDeps = { readonly target: ReturnType<typeof rawHttp> };

/** A public URL node: it depends on one exposed HTTP interface and exposes nothing. */
export type PublicUrlNode = ResourceNode<
  undefined,
  PublicUrlDeps,
  { readonly url: PublicUrlOption }
>;

const MAX_HOSTNAME_LENGTH = 253;
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^\[?[0-9a-f]*:[0-9a-f:.]*\]?$/;

/** Normalizes a hostname (trimmed, one trailing dot dropped, lowercased), or says why it is not one. */
export function parseHostname(raw: string): string | { error: string } {
  const name = raw.trim().replace(/\.$/, '').toLowerCase();
  const quoted = JSON.stringify(raw);
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(name)) {
    return { error: `${quoted} has a scheme. Pass the hostname alone, without "https://".` };
  }
  if (name.includes('/')) return { error: `${quoted} has a path. Pass the hostname alone.` };
  const ipv6 = (name.startsWith('[') || name.split(':').length > 2) && IPV6.test(name);
  if (ipv6 || IPV4.test(name)) {
    return { error: `${quoted} is an IP address. A public URL needs a hostname.` };
  }
  if (name.includes(':')) return { error: `${quoted} has a port. Pass the hostname alone.` };
  const labels = name.split('.');
  if (labels.includes('*')) {
    return {
      error: `${quoted} has a "*" label. A public URL serves one hostname, not a wildcard.`,
    };
  }
  if (labels.length < 2) {
    return { error: `${quoted} is not a hostname: it needs at least two labels, like "shop.com".` };
  }
  if (name.length > MAX_HOSTNAME_LENGTH) {
    return { error: `${quoted} is longer than ${MAX_HOSTNAME_LENGTH} characters.` };
  }
  const bad = labels.find((label) => !LABEL.test(label));
  if (bad !== undefined) {
    return {
      error:
        `${quoted} has the label ${JSON.stringify(bad)}. Each label is 1 to 63 characters of ` +
        'a-z, 0-9 and "-", and neither starts nor ends with "-".',
    };
  }
  return name;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function hostnameStrategy(hostname: string): HostnameStrategy {
  return Object.freeze({ strategy: 'hostname', hostname });
}

const PRISMA_BUILD: PrismaBuildStrategy = Object.freeze({ strategy: 'prisma-build' });

type Classified =
  | PublicUrlStrategy
  | { readonly invalidHostname: string }
  | { readonly unknown: true };

function classify(url: unknown): Classified {
  const raw =
    typeof url === 'string'
      ? url
      : isRecord(url) && url['strategy'] === 'hostname' && typeof url['hostname'] === 'string'
        ? url['hostname']
        : undefined;
  if (raw !== undefined) {
    const parsed = parseHostname(raw);
    return typeof parsed === 'string'
      ? hostnameStrategy(parsed)
      : { invalidHostname: parsed.error };
  }
  if (isRecord(url) && url['strategy'] === 'prisma-build') return PRISMA_BUILD;
  return { unknown: true };
}

const describe = (value: unknown): string => JSON.stringify(value) ?? String(value);

/** The strategy a public URL's resolved `url` names; throws, naming `address`, for anything else. */
export function resolvedStrategy(url: unknown, address: string): PublicUrlStrategy {
  const classified = classify(url);
  if ('invalidHostname' in classified) throw new Error(`${address}: ${classified.invalidHostname}`);
  if ('unknown' in classified) {
    throw new Error(
      `${address}: url resolved to ${describe(url)}, which is not a hostname or a public URL strategy.`,
    );
  }
  return classified;
}

/** Each public URL in `graph`, with the strategy its resolved `url` names; throws on the first that names none. */
export function publicUrlStrategies(
  graph: Graph,
): { readonly address: string; readonly strategy: PublicUrlStrategy }[] {
  return graph.nodes.flatMap(({ id, node }) =>
    node.kind === 'resource' &&
    node.extension === PRISMA_CLOUD_EXTENSION_ID &&
    node.type === 'public-url'
      ? [{ address: id, strategy: resolvedStrategy(node.props['url'], id) }]
      : [],
  );
}

/** Throws unless every public URL's resolved `url` names a strategy and no two name the same hostname. */
export function checkPublicUrls(graph: Graph): void {
  const owners = new Map<string, string>();
  for (const { address, strategy } of publicUrlStrategies(graph)) {
    if (strategy.strategy !== 'hostname') continue;
    const owner = owners.get(strategy.hostname);
    if (owner !== undefined) {
      throw new Error(
        `${owner} and ${address} both name the hostname ${strategy.hostname}. One hostname serves one public URL.`,
      );
    }
    owners.set(strategy.hostname, address);
  }
}

/**
 * Makes a service reachable from the internet. `target` is the service's
 * exposed HTTP interface; `url` is a hostname, `publicUrl.hostname(…)`,
 * `publicUrl.prismaBuild()`, or a value that resolves to one of them.
 */
export function publicUrl(opts: {
  name: string;
  url: PublicUrlOption;
  target: DepBindings<PublicUrlDeps>['target'];
}): PublicUrlNode {
  const label = `publicUrl(${JSON.stringify(opts.name)})`;
  if (opts.url === undefined) {
    throw new Error(
      `${label}: url is required. Pass a hostname, publicUrl.hostname(…), or publicUrl.prismaBuild().`,
    );
  }
  if (!isValue(opts.url)) {
    const classified = classify(opts.url);
    if ('invalidHostname' in classified) throw new Error(`${label}: ${classified.invalidHostname}`);
    if ('unknown' in classified) {
      throw new Error(
        `${label}: url is ${describe(opts.url)}, which is not a hostname or a public URL strategy.`,
      );
    }
  }
  return resource({
    name: opts.name,
    extension: PRISMA_CLOUD_EXTENSION_ID,
    type: 'public-url',
    inputs: { target: rawHttp() },
    deps: { target: opts.target },
    props: { url: opts.url },
  });
}

/** Serve at `hostname`. A bare string passed as `url` means the same. */
publicUrl.hostname = (hostname: string): HostnameStrategy => {
  const parsed = parseHostname(hostname);
  if (typeof parsed !== 'string') throw new Error(`publicUrl.hostname(): ${parsed.error}`);
  return hostnameStrategy(parsed);
};

/** Serve at the `prisma.build` hostname the platform gives the service. */
publicUrl.prismaBuild = (): PrismaBuildStrategy => PRISMA_BUILD;
