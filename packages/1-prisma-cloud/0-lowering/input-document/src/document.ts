export const PLATFORM_MARKER = '$platform';
export const GENERATED_MARKER = '$generated';

/** Where a service's input reads a platform variable: `{ "$platform": { "name": "X", "secret": true } }`. */
export interface PlatformMarker {
  readonly $platform: { readonly name: string; readonly secret?: true };
}

/** Where a service's input reads a variable Composer generates: `{ "$generated": "COMPOSER_…", "redacted": true }`. */
export interface GeneratedMarker {
  readonly $generated: string;
  readonly redacted: boolean;
}

/** One `$platform` marker found in a document. `path` is dot-joined, with user keys unescaped. */
export interface PlatformMarkerUse {
  readonly name: string;
  readonly path: string;
  readonly secret: boolean;
  readonly inArray: boolean;
}

export const platformMarker = (name: string, secret: boolean): PlatformMarker => ({
  [PLATFORM_MARKER]: secret ? { name, secret: true } : { name },
});

export const generatedMarker = (name: string, redacted: boolean): GeneratedMarker => ({
  [GENERATED_MARKER]: name,
  redacted,
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function isPlatformMarker(value: unknown): value is PlatformMarker {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== PLATFORM_MARKER) return false;
  const body = value[PLATFORM_MARKER];
  return (
    isPlainObject(body) &&
    typeof body['name'] === 'string' &&
    (body['secret'] === undefined || body['secret'] === true) &&
    Object.keys(body).every((key) => key === 'name' || key === 'secret')
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

const ESCAPABLE_KEY = /^\$+(?:platform|generated|secret)$/;
const ESCAPED_KEY = /^\$\$+(?:platform|generated|secret)$/;

/** A user key spelled like a marker gains one `$` when written, so only Composer can place a marker. */
export const escapeKey = (key: string): string => (ESCAPABLE_KEY.test(key) ? `$${key}` : key);

/** Reverses `escapeKey`. */
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

/** Every `$platform` marker in a document, at any depth. */
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

/** The value a platform variable's text gives: the text itself. */
export const decodeVariableText = (text: string): string => text;

export interface ReadDocumentOptions {
  /** The environment key the document was read from, for error messages. */
  readonly key: string;
  /** A variable's text, or undefined when it is not set. */
  readonly variable: (name: string) => string | undefined;
  /** Puts a secret's text in a secret box. */
  readonly secret: (text: string) => unknown;
}

export interface ReadDocument {
  readonly value: unknown;
  /** The platform variables with no value whose keys were left out, each once, in document order. */
  readonly unset: readonly string[];
}

const ABSENT: unique symbol = Symbol('input-document-absent');

/**
 * Boot's first three steps: a marker whose variable is unset or empty leaves its key out, one with text takes the decoded text, and a secret's text goes in a secret box. User keys are unescaped. The service's schema runs after this, on `value`.
 */
export function readDocument(document: unknown, options: ReadDocumentOptions): ReadDocument {
  const unset = new Set<string>();
  const textOf = (name: string): string | undefined => {
    const text = options.variable(name);
    return text === undefined || text === '' ? undefined : text;
  };
  const walk = (value: unknown, path: string, inArray: boolean): unknown => {
    if (isPlatformMarker(value)) {
      const { name, secret } = value.$platform;
      const text = textOf(name);
      if (text === undefined) {
        if (inArray) throw unsetInArrayError(name, path, options.key);
        unset.add(name);
        return ABSENT;
      }
      const decoded = decodeVariableText(text);
      return secret === true ? options.secret(decoded) : decoded;
    }
    if (isGeneratedMarker(value)) {
      const name = value.$generated;
      const text = textOf(name);
      if (text === undefined) {
        throw new Error(
          `generated input is not provisioned (env ${options.key} → ${name}): the platform variable "${name}" is unset or empty. The deploy writes this variable, so its absence means the deploy and the running service disagree.`,
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
        if (read !== ABSENT) out[key] = read;
      }
      return out;
    }
    return value;
  };
  const value = walk(document, '', false);
  return { value: value === ABSENT ? undefined : value, unset: [...unset] };
}

function unsetInArrayError(name: string, path: string, key: string): Error {
  return new Error(
    `input key "${path}" (env ${key}) reads the platform variable "${name}", which has no value. An array position cannot be left out: set "${name}" with prisma project env add.`,
  );
}

/** A schema failure's message, ending with the platform variables whose keys boot left out, when there are any. */
export function withUnsetVariables(message: string, unset: readonly string[]): string {
  return unset.length === 0
    ? message
    : `${message} (platform variables with no value: ${unset.join(', ')})`;
}

/** The boot error for a required per-key param whose platform variable has no value. */
export function requiredParamUnsetMessage(param: string, key: string, name: string): string {
  return `config param "${param}" (env ${key} → ${name}) has no value: set the platform variable "${name}" with prisma project env add.`;
}

/** The document as compact JSON, with each marker shown as `$platform NAME` or `$generated NAME`. */
export function describeDocument(document: unknown): string {
  const describe = (value: unknown): string => {
    if (isPlatformMarker(value)) return `$platform ${value.$platform.name}`;
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
