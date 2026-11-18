import { isPlainObject, setOwn } from './plain-object.ts';
import {
  isVariableJsonSchema,
  readVariableText,
  schemaKind,
  schemaWord,
  type VariableJsonSchema,
} from './variable-schema.ts';

export const PLATFORM_MARKER = '$platform';
export const GENERATED_MARKER = '$generated';

export interface PlatformMarker {
  readonly $platform: {
    readonly name: string;
    readonly secret?: true;
    readonly schema?: VariableJsonSchema;
  };
}

export interface GeneratedMarker {
  readonly $generated: string;
  readonly redacted: boolean;
}

export interface PlatformMarkerUse {
  readonly name: string;
  readonly path: string;
  readonly secret: boolean;
  readonly inArray: boolean;
}

export function platformMarker(name: string, secret: boolean): PlatformMarker;
export function platformMarker(
  name: string,
  secret: false,
  schema: VariableJsonSchema,
): PlatformMarker;
export function platformMarker(
  name: string,
  secret: boolean,
  schema?: VariableJsonSchema,
): PlatformMarker {
  if (secret) return { [PLATFORM_MARKER]: { name, secret: true } };
  return { [PLATFORM_MARKER]: schema === undefined ? { name } : { name, schema } };
}

export const generatedMarker = (name: string, redacted: boolean): GeneratedMarker => ({
  [GENERATED_MARKER]: name,
  redacted,
});

export function isPlatformMarker(value: unknown): value is PlatformMarker {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== PLATFORM_MARKER) return false;
  const body = value[PLATFORM_MARKER];
  if (!isPlainObject(body)) return false;
  const secret = body['secret'];
  const schema = body['schema'];
  return (
    typeof body['name'] === 'string' &&
    (secret === undefined || secret === true) &&
    (schema === undefined ||
      (secret === undefined && isVariableJsonSchema(schema) && schemaKind(schema) !== 'mixed')) &&
    Object.keys(body).every((key) => key === 'name' || key === 'secret' || key === 'schema')
  );
}

export function isGeneratedMarker(value: unknown): value is GeneratedMarker {
  return (
    isPlainObject(value) &&
    Object.keys(value).length === 2 &&
    typeof value[GENERATED_MARKER] === 'string' &&
    typeof value['redacted'] === 'boolean'
  );
}

const ESCAPABLE_KEY = /^\$+(?:platform|generated)$/;
const ESCAPED_KEY = /^\$\$+(?:platform|generated)$/;

/** A user key spelled like a marker gains one `$` when written, so only Composer can place a marker. */
export const escapeKey = (key: string): string => (ESCAPABLE_KEY.test(key) ? `$${key}` : key);

export const unescapeKey = (key: string): string => (ESCAPED_KEY.test(key) ? key.slice(1) : key);

const joinPath = (path: string, segment: string | number): string =>
  path === '' ? String(segment) : `${path}.${segment}`;

function refuseMalformedMarker(value: Record<string, unknown>, path: string): void {
  for (const marker of [PLATFORM_MARKER, GENERATED_MARKER]) {
    if (marker in value) {
      throw new Error(
        `the input document holds a malformed ${marker} marker at "${path || '(root)'}". Composer writes every marker; deploy again to rewrite the document.`,
      );
    }
  }
}

export function collectPlatformMarkers(document: unknown): PlatformMarkerUse[] {
  const uses: PlatformMarkerUse[] = [];
  const walk = (value: unknown, path: string, inArray: boolean): void => {
    if (isPlatformMarker(value)) {
      const { name, secret } = value.$platform;
      uses.push({ name, path, secret: secret === true, inArray });
      return;
    }
    if (isGeneratedMarker(value)) return;
    if (Array.isArray(value)) {
      value.forEach((member, index) => {
        walk(member, joinPath(path, index), true);
      });
      return;
    }
    if (isPlainObject(value)) {
      refuseMalformedMarker(value, path);
      for (const [key, member] of Object.entries(value)) {
        walk(member, joinPath(path, unescapeKey(key)), false);
      }
    }
  };
  walk(document, '', false);
  return uses;
}

export interface ReadDocumentOptions {
  readonly variable: (name: string) => string | undefined;
  readonly secret: (text: string) => unknown;
}

export interface ReadDocument {
  readonly value: unknown;
  /** The platform variables with no value whose keys were left out, each once, in document order. */
  readonly unset: readonly string[];
}

const ABSENT: unique symbol = Symbol('input-document-absent');

export function readDocument(document: unknown, options: ReadDocumentOptions): ReadDocument {
  const unset = new Set<string>();
  const textOf = (name: string): string | undefined => {
    const text = options.variable(name);
    return text === undefined || text === '' ? undefined : text;
  };
  const walk = (value: unknown, path: string, inArray: boolean): unknown => {
    if (isPlatformMarker(value)) {
      const { name, secret, schema } = value.$platform;
      const text = textOf(name);
      if (text === undefined) {
        if (inArray) throw unsetInArrayError(name, path);
        unset.add(name);
        return ABSENT;
      }
      return secret === true ? options.secret(text) : readVariableText(name, text, schema);
    }
    if (isGeneratedMarker(value)) {
      const name = value.$generated;
      const text = textOf(name);
      if (text === undefined) {
        throw new Error(
          `The variable "${name}" on the platform, which the deploy writes, has no value. Deploy again.`,
        );
      }
      return value.redacted ? options.secret(text) : text;
    }
    if (Array.isArray(value)) {
      return value.map((member, index) => walk(member, joinPath(path, index), true));
    }
    if (isPlainObject(value)) {
      refuseMalformedMarker(value, path);
      const out: Record<string, unknown> = {};
      for (const [written, member] of Object.entries(value)) {
        const key = unescapeKey(written);
        const read = walk(member, joinPath(path, key), false);
        if (read !== ABSENT) {
          setOwn(out, key, read);
        }
      }
      return out;
    }
    return value;
  };
  const value = walk(document, '', false);
  return { value: value === ABSENT ? undefined : value, unset: [...unset] };
}

function unsetInArrayError(name: string, path: string): Error {
  return new Error(
    `The input field "${path}" reads the platform variable "${name}", which has no value. An array position cannot be left out: set "${name}" with prisma project env add.`,
  );
}

export function withUnsetVariables(message: string, unset: readonly string[]): string {
  return unset.length === 0
    ? message
    : `${message} (platform variables with no value: ${unset.join(', ')})`;
}

export function describeDocument(document: unknown): string {
  const describe = (value: unknown): string => {
    if (isPlatformMarker(value)) {
      const { name, schema } = value.$platform;
      return schema === undefined
        ? `$platform ${name}`
        : `$platform ${name} (${schemaWord(schema)})`;
    }
    if (isGeneratedMarker(value)) return `$generated ${value.$generated}`;
    if (Array.isArray(value)) return `[${value.map(describe).join(',')}]`;
    if (isPlainObject(value)) {
      const members = Object.entries(value).map(
        ([key, member]) => `${JSON.stringify(key)}:${describe(member)}`,
      );
      return `{${members.join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
  };
  return describe(document);
}
