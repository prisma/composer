import type { AppConfiguration, AppSecrets } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import type { DeploymentSummary } from './deployment-summary.ts';
import type { DevEvent } from './operations/dev.ts';

export const REDACTED = '[redacted]';

/** Env var names whose values are credentials: the service token, preflight payloads, and the usual secret spellings. */
const SECRET_ENV_NAME =
  /TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|API_?KEY|ACCESS_?KEY|_KEY$|DATABASE_URL|_DSN$|^PRISMA_COMPOSER_PREFLIGHT_/i;

/**
 * The credential-looking values in `variables`: text of eight characters or more under a name
 * that looks like a credential's. The length limit keeps a one-letter placeholder from blanking
 * every matching letter.
 */
export function credentialLookingValues(variables: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(variables).flatMap(([name, value]) =>
    SECRET_ENV_NAME.test(name) && typeof value === 'string' && value.length >= 8 ? [value] : [],
  );
}

/**
 * Finds every secret in a text: one regular expression for all of them, built once. A match
 * is the span of the longest secret that starts at a position, and spans that overlap are
 * merged, so two overlapping secrets are hidden whole.
 */
export class SecretMatcher {
  private readonly starts: RegExp | undefined;
  private readonly prefixes = new Set<string>();
  private readonly longestPrefix: number;

  constructor(values: Iterable<string>) {
    const sorted = [...new Set(values)]
      .filter((value) => value.length > 0)
      .sort((a, b) => b.length - a.length);
    this.starts =
      sorted.length === 0
        ? undefined
        : new RegExp(
            `(?=(${sorted.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`,
            'g',
          );
    for (const value of sorted) {
      for (let length = 1; length < value.length; length++)
        this.prefixes.add(value.slice(0, length));
    }
    this.longestPrefix = Math.max(0, (sorted[0]?.length ?? 0) - 1);
  }

  /** The merged spans of every secret in `text`, in order, as `[start, end)`. */
  spans(text: string): [number, number][] {
    const spans: [number, number][] = [];
    if (this.starts === undefined) return spans;
    for (const match of text.matchAll(this.starts)) {
      const start = match.index;
      const end = start + (match[1]?.length ?? 0);
      const last = spans.at(-1);
      if (last !== undefined && start < last[1]) last[1] = Math.max(last[1], end);
      else spans.push([start, end]);
    }
    return spans;
  }

  /** The length of the longest end of `text` that is the start, not the whole, of a secret. */
  startOfSecretAtEnd(text: string): number {
    for (let length = Math.min(this.longestPrefix, text.length); length > 0; length--) {
      if (this.prefixes.has(text.slice(text.length - length))) return length;
    }
    return 0;
  }

  /** `text` with each span replaced by `[redacted]`. */
  redact(text: string): string {
    let out = '';
    let from = 0;
    for (const [start, end] of this.spans(text)) {
      out += text.slice(from, start) + REDACTED;
      from = end;
    }
    return from === 0 ? text : out + text.slice(from);
  }
}

/** `text` with each value in `values` replaced by `[redacted]`, at any length; an empty one is skipped. Overlapping values are hidden whole. */
export function redactValues(text: string, values: Iterable<string>): string {
  return new SecretMatcher(values).redact(text);
}

/** `text` with bearer and basic tokens, JWTs, the password in a URL, and `token=…`-style pairs replaced by `[redacted]`. */
function redactShapes(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED)
    .replace(/(\b[a-z][\w+.-]*:\/\/[^\s:/@]*:)[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(
      /\b((?:[\w-]*[_-])?(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
      `$1${REDACTED}`,
    );
}

/**
 * `text` with the credential-looking values of `env` and the credential shapes replaced by
 * `[redacted]`. For a process that has no `SecretRedaction`; `SecretRedaction.redact` hides
 * the known secrets too.
 */
export function redactCredentialLooking(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return redactShapes(redactValues(text, credentialLookingValues(env)));
}

/** A value under a secrets key, with that key. */
export interface KnownSecret {
  readonly name: string;
  readonly value: string;
}

/**
 * The shortest known secret the file check looks for inside a longer value. A shorter one, such
 * as a `dev` placeholder, is refused only when it is the whole value.
 */
export const MIN_SECRET_LENGTH_INSIDE_A_VALUE = 8;

/**
 * The known secrets of one command: the values under the secrets keys the graph names, in the app
 * secrets and the app configuration (ADR-0062). The app configuration file must not hold any of them.
 */
export class KnownSecrets {
  readonly #names = new Map<string, string>();

  constructor(secrets: Iterable<KnownSecret> = []) {
    this.add(secrets);
  }

  /** Adds each secret whose value is not empty. A value already known keeps its first name. */
  add(secrets: Iterable<KnownSecret>): void {
    for (const { name, value } of secrets) {
      if (value.length > 0 && !this.#names.has(value)) this.#names.set(value, name);
    }
  }

  values(): ReadonlySet<string> {
    return new Set(this.#names.keys());
  }

  /**
   * The name of a known secret `text` holds, or undefined. A secret of
   * `MIN_SECRET_LENGTH_INSIDE_A_VALUE` characters or more is found anywhere in `text`; a shorter
   * one only when it is all of `text`.
   */
  nameIn(text: string): string | undefined {
    for (const [value, name] of this.#names) {
      if (
        value.length >= MIN_SECRET_LENGTH_INSIDE_A_VALUE ? text.includes(value) : text === value
      ) {
        return name;
      }
    }
    return undefined;
  }
}

/**
 * What one command hides from everything it prints, returns or reports (ADR-0062): its known
 * secrets, and the credential-looking values, which only look like secrets by the name of the
 * variable they are under. It starts with the credential-looking values of the process
 * environment.
 */
export class SecretRedaction {
  readonly knownSecrets = new KnownSecrets();
  private readonly credentialLooking = new Set<string>();
  private matcher: { readonly size: number; readonly matcher: SecretMatcher } | undefined;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.addCredentialLookingValues(credentialLookingValues(env));
  }

  addKnownSecrets(secrets: Iterable<KnownSecret>): void {
    this.knownSecrets.add(secrets);
  }

  addCredentialLookingValues(values: Iterable<string>): void {
    for (const value of values) if (value.length > 0) this.credentialLooking.add(value);
  }

  /** The known secrets and the credential-looking values, longest first. */
  allValues(): readonly string[] {
    return [...new Set([...this.knownSecrets.values(), ...this.credentialLooking])].sort(
      (a, b) => b.length - a.length,
    );
  }

  /** `text` with every known secret and credential-looking value replaced by `[redacted]` at any length, then bearer tokens, JWTs, URL passwords and `token=…` pairs. */
  redact(text: string): string {
    const size = this.knownSecrets.values().size + this.credentialLooking.size;
    if (this.matcher?.size !== size) {
      this.matcher = { size, matcher: new SecretMatcher(this.allValues()) };
    }
    return redactShapes(this.matcher.matcher.redact(text));
  }
}

/** The text under each name in `secretsKeys`, in the app configuration and in the app secrets, at any length. */
export function valuesUnderSecretsKeys(
  configuration: AppConfiguration,
  secrets: AppSecrets,
  secretsKeys: readonly string[],
): KnownSecret[] {
  return secretsKeys.flatMap((name) =>
    [configuration[name], secrets[name]].flatMap((value) =>
      typeof value === 'string' ? [{ name, value }] : [],
    ),
  );
}

function redactData(value: unknown, redaction: SecretRedaction): unknown {
  if (typeof value === 'string') return redaction.redact(value);
  if (Array.isArray(value)) return value.map((member) => redactData(member, redaction));
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, redactData(member, redaction)]),
    );
  }
  return value;
}

/**
 * `error` with every value `redaction` hides removed from its summary, `why`, `fix` and every string in
 * its `meta`. The code, severity, `where` and docs link are kept. The cause is dropped, because
 * it holds the same text unredacted and a renderer may print it.
 */
export function redactError(
  error: CliStructuredError,
  redaction: SecretRedaction,
): CliStructuredError {
  return new CliStructuredError(error.code, redaction.redact(error.message), {
    severity: error.severity,
    ...(error.why === undefined ? {} : { why: redaction.redact(error.why) }),
    ...(error.fix === undefined ? {} : { fix: redaction.redact(error.fix) }),
    ...(error.where === undefined ? {} : { where: error.where }),
    ...(error.meta === undefined
      ? {}
      : {
          meta: Object.fromEntries(
            Object.entries(error.meta).map(([key, value]) => [key, redactData(value, redaction)]),
          ),
        }),
    ...(error.docsUrl === undefined ? {} : { docsUrl: error.docsUrl }),
  });
}

function setOwn(error: Error, name: string, value: unknown): void {
  Object.defineProperty(error, name, { value, writable: true, configurable: true });
}

const UNPRINTABLE = 'A value was thrown that cannot be turned into text.';

function safeString(value: unknown): string {
  try {
    return String(value);
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return UNPRINTABLE;
    }
  }
}

/**
 * The error to rethrow in place of a thrown defect, with every secret removed from its message
 * and stack, and from those of each error in its `cause` chain and in an `AggregateError`'s
 * `errors`. A cause that is text or plain data becomes a redacted copy. Each error is redacted
 * in place where it can be. One whose properties cannot change, such as a frozen error, is
 * replaced by a new error with the redacted message, stack and cause. A thrown value that is not
 * an `Error` becomes an `Error` whose message is its redacted text. Never throws: when reading
 * the error fails, the result is a new `Error` holding the redacted text of what was thrown.
 */
export function redactThrown(thrown: unknown, redaction: SecretRedaction): Error {
  try {
    return thrown instanceof Error
      ? redactErrorChain(thrown, redaction, new Map())
      : new Error(redaction.redact(safeString(thrown)));
  } catch {
    return new Error(redaction.redact(safeString(thrown)));
  }
}

function redactErrorChain(
  error: Error,
  redaction: SecretRedaction,
  seen: Map<Error, Error>,
): Error {
  const done = seen.get(error);
  if (done !== undefined) return done;
  seen.set(error, error);
  const message = redaction.redact(
    typeof error.message === 'string' ? error.message : safeString(error.message),
  );
  const stack = typeof error.stack === 'string' ? redaction.redact(error.stack) : undefined;
  const cause =
    error.cause instanceof Error
      ? redactErrorChain(error.cause, redaction, seen)
      : redactData(error.cause, redaction);
  const members =
    error instanceof AggregateError
      ? error.errors.map((member: unknown) =>
          member instanceof Error
            ? redactErrorChain(member, redaction, seen)
            : redactData(member, redaction),
        )
      : undefined;
  try {
    setOwn(error, 'message', message);
    if (stack !== undefined) setOwn(error, 'stack', stack);
    if (error.cause !== undefined) setOwn(error, 'cause', cause);
    if (members !== undefined) setOwn(error, 'errors', members);
    return error;
  } catch {
    const options = cause === undefined ? undefined : { cause };
    const copy =
      members === undefined
        ? new Error(message, options)
        : new AggregateError(members, message, options);
    copy.name = error.name;
    setOwn(copy, 'stack', stack ?? `${error.name}: ${message}`);
    seen.set(error, copy);
    return copy;
  }
}

/** `event` with every value `redaction` hides removed from the text it carries: a message, an Alchemy log line, a converge failure's reasons, or a dev server's output line. */
export function redactDevEvent(event: DevEvent, redaction: SecretRedaction): DevEvent {
  switch (event.kind) {
    case 'target-warning':
    case 'rebuild-failed':
    case 'watch-error':
    case 'stop-error':
      return { ...event, message: redaction.redact(event.message) };
    case 'message':
      return { ...event, text: redaction.redact(event.text) };
    case 'converge-failed':
      return {
        ...event,
        message: redaction.redact(event.message),
        reasons: event.reasons.map(({ tag, message }) => ({
          tag,
          message: redaction.redact(message),
        })),
      };
    case 'dev-server-output':
      return { ...event, line: redaction.redact(event.line) };
    default:
      return event;
  }
}

/** `summary` with every value `redaction` hides removed from each entity's id, url and details. */
export function redactSummary(
  summary: DeploymentSummary | undefined,
  redaction: SecretRedaction,
): DeploymentSummary | undefined {
  if (summary === undefined) return undefined;
  return {
    app: summary.app,
    nodes: summary.nodes.map((node) => ({
      address: node.address,
      entities: node.entities.map((entity) => ({
        ...entity,
        id: redaction.redact(entity.id),
        ...(entity.url === undefined ? {} : { url: redaction.redact(entity.url) }),
        ...(entity.details === undefined
          ? {}
          : {
              details: Object.fromEntries(
                Object.entries(entity.details).map(([key, value]) => [
                  key,
                  redaction.redact(value),
                ]),
              ),
            }),
      })),
    })),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Redacts a stream of text chunk by chunk: every value in `values` becomes `[redacted]`, and
 * overlapping values are hidden whole. It holds back only the end of the text that could still
 * be part of a value: the longest end that could start one, or a match that a later value could
 * extend. So a value split across two chunks is still replaced, and text that cannot start one,
 * such as a prompt, is returned at once. It never splits a surrogate pair. `push` returns the
 * text that is ready; `end` returns the rest.
 */
export class StreamRedactor {
  private held = '';
  private readonly matcher: SecretMatcher;

  constructor(values: Iterable<string>) {
    this.matcher = new SecretMatcher(values);
  }

  push(chunk: string): string {
    const text = this.held + chunk;
    const cut = text.length - this.matcher.startOfSecretAtEnd(text);
    let out = '';
    let from = 0;
    let ready = cut;
    for (const [start, end] of this.matcher.spans(text)) {
      if (end > cut) {
        ready = Math.min(cut, start);
        break;
      }
      out += text.slice(from, start) + REDACTED;
      from = end;
    }
    if (ready > from && ready < text.length && isHighSurrogate(text.charCodeAt(ready - 1))) {
      ready -= 1;
    }
    this.held = text.slice(ready);
    return out + text.slice(from, ready);
  }

  end(): string {
    const text = this.held;
    this.held = '';
    return this.matcher.redact(text);
  }
}
