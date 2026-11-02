import * as path from 'node:path';
import type {
  ConfigAdapter,
  ConfigPool,
  PrismaAppConfig,
  SecretsPool,
} from '@internal/core/config';
import { CliStructuredError, describeKind, InternalError } from '@internal/foundation/errors';
import { environmentVariables } from './config-adapters.ts';

/** Where a pool is read for. */
export interface PoolReadInput {
  /** The environment's name. */
  readonly environment: string;
  /** The absolute path of the prisma.config.ts that declares the section. */
  readonly configFile: string;
}

type PoolList = 'config' | 'secrets';

function adapterInvalid(
  list: PoolList,
  index: number,
  input: PoolReadInput,
  summary: string,
  fix: string,
): CliStructuredError {
  return new CliStructuredError('CONFIG.ADAPTER_INVALID', summary, {
    fix,
    where: { path: input.configFile },
    meta: { field: `${list}[${index}]` },
  });
}

function isValues(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(pool: Readonly<Record<string, unknown>>): pool is SecretsPool {
  return Object.values(pool).every((value) => typeof value === 'string');
}

async function readPool(
  list: PoolList,
  adapters: readonly ConfigAdapter[],
  input: PoolReadInput,
): Promise<Readonly<Record<string, unknown>>> {
  const adapterInput = Object.freeze({
    environment: input.environment,
    configDirectory: path.dirname(input.configFile),
  });
  // A key such as __proto__ or toString from an adapter is a value like any other, never an inherited property.
  const pool: Record<string, unknown> = Object.create(null);
  for (const [index, adapter] of adapters.entries()) {
    const field = `composer.${list}[${index}]`;
    let values: unknown;
    try {
      values = await adapter(adapterInput);
    } catch (thrown) {
      throw new CliStructuredError(
        'CONFIG.ADAPTER_FAILED',
        `\`${field}\` failed to read the values for the environment "${input.environment}".`,
        {
          why: `It threw: ${thrown instanceof Error ? thrown.message : String(thrown)}`,
          fix: `Fix the adapter, or remove it from \`composer.${list}\` in prisma.config.ts.`,
          where: { path: input.configFile },
          meta: { field: `${list}[${index}]` },
          cause: thrown,
        },
      );
    }
    if (typeof values === 'function') {
      throw adapterInvalid(
        list,
        index,
        input,
        `\`${field}\` returned a function, not an object of values.`,
        'An adapter factory was put in the list instead of the adapter it makes: write `dotenv()`, not `dotenv`.',
      );
    }
    if (!isValues(values)) {
      throw adapterInvalid(
        list,
        index,
        input,
        `\`${field}\` returned ${describeKind(values)}, not an object of values.`,
        "Return an object whose keys are the names of the values, e.g. `{ EMAIL_FROM: 'shop@example.com' }`.",
      );
    }
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      if (list === 'secrets' && typeof value !== 'string') {
        throw adapterInvalid(
          list,
          index,
          input,
          `\`${field}\` returned ${describeKind(value)} for "${key}", but a secret is text.`,
          'Return the secret as a string. A platform variable holds text.',
        );
      }
      pool[key] = value;
    }
  }
  return Object.freeze(pool);
}

/** Calls the section's `config` adapters (default `[environmentVariables()]`) and merges what they return: the config pool. */
export function readConfigPool(
  section: PrismaAppConfig,
  input: PoolReadInput,
): Promise<ConfigPool> {
  return readPool('config', section.config ?? [environmentVariables()], input);
}

/** Calls the section's `secrets` adapters (default `[environmentVariables()]`) and merges what they return: the secrets pool. Every value must be text. */
export async function readSecretsPool(
  section: PrismaAppConfig,
  input: PoolReadInput,
): Promise<SecretsPool> {
  const pool = await readPool('secrets', section.secrets ?? [environmentVariables()], input);
  if (!isText(pool)) throw new InternalError('readPool admitted a secret that is not text');
  return pool;
}
