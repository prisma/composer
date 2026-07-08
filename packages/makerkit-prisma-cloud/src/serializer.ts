/**
 * The pack's config serializer — the semantic↔physical mapping, private to
 * the pack, SHARED by run() (boot) and /target's serialize (deploy) so writer
 * and reader cannot drift.
 *
 * Keys are unique per service within the shared project namespace: the
 * serializer prefixes them with the deployment address (its segments after the app
 * root — empty for a lone-service deploy, the "unprefixed" case), then the
 * owner (the input name, dropped for the service's own params), then the
 * param name. auth's db.url ↔ AUTH_DB_URL; a lone service's db.url ↔ DB_URL.
 * The platform's DATABASE_URL is never among them — forbidden and poisoned
 * at project provision (see docs/design/05-prisma-cloud/alchemy-lowering.md).
 */
import type { Config, ConfigDeclaration } from '@makerkit/core';

// The ambient environment of whatever runtime hosts the bundle. Declared
// structurally so this entry imports no runtime's types. Writable: stash()
// re-emits the resolved config here under address-free keys.
declare const process: { env: Record<string, string | undefined> };

export const configKey = (address: string, d: ConfigDeclaration): string => {
  const segments = address.split('.').filter((s) => s.length > 0);
  const owner = d.owner === 'service' ? [] : [d.owner.input];
  return [...segments, ...owner, d.name].join('_').toUpperCase();
};

function coerce(raw: string | undefined, d: ConfigDeclaration, key: string): unknown {
  // "" is UNRESOLVED, not a value — falls to the default or, if required, is
  // a loud boot failure; a NON-EMPTY value that fails its declared type is
  // an error regardless of any default (a default substitutes for absence,
  // never for garbage).
  const present = raw !== undefined && raw !== '';
  if (!present) {
    if (d.default !== undefined) return d.default;
    if (d.optional) return undefined;
    throw new Error(`missing required config param "${d.name}" (env ${key})`);
  }
  if (d.type === 'number') {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      throw new Error(
        `invalid number for config param "${d.name}" (env ${key}): ${JSON.stringify(raw)}`,
      );
    }
    return parsed;
  }
  return raw;
}

/**
 * Boot: read each declared param from env by its key, coerce to its type
 * (the pack reversing its own serialization — missing/unparseable fails
 * loudly), assemble the typed Config. The one place in the pack that reads
 * the platform environment.
 */
export const deserialize = (shape: readonly ConfigDeclaration[], address: string): Config => {
  const service: Record<string, unknown> = {};
  const inputs: Record<string, Record<string, unknown>> = {};

  for (const d of shape) {
    const key = configKey(address, d);
    const value = coerce(process.env[key], d, key);
    if (d.owner === 'service') {
      service[d.name] = value;
    } else {
      let bucket = inputs[d.owner.input];
      if (bucket === undefined) {
        bucket = {};
        inputs[d.owner.input] = bucket;
      }
      bucket[d.name] = value;
    }
  }

  return { service, inputs };
};

/**
 * run()'s setup step: write the resolved config to the environment under
 * address-free keys (configKey("", d)), which load() reads back with no address.
 * Uses env, not a module variable, because a framework may fork worker processes
 * that inherit env but not memory. Writes only these keys; nothing else is touched.
 */
export const stash = (shape: readonly ConfigDeclaration[], config: Config): void => {
  for (const d of shape) {
    const value =
      d.owner === 'service' ? config.service[d.name] : config.inputs[d.owner.input]?.[d.name];
    if (value === undefined) continue;
    process.env[configKey('', d)] = String(value);
  }
};
