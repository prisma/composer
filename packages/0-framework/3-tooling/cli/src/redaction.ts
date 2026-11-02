import type { AppConfiguration, AppSecrets } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import type { DeploymentSummary } from './deployment-summary.ts';
import type { DevEvent } from './operations/dev.ts';

export const REDACTED = '[redacted]';

/** Env var names whose values are credentials: the service token, preflight payloads, and the usual secret spellings. */
const SECRET_ENV_NAME =
  /TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|API_?KEY|ACCESS_?KEY|_KEY$|DATABASE_URL|_DSN$|^PRISMA_COMPOSER_PREFLIGHT_/i;

/** The values of `env`'s variables whose names look like credentials, eight characters or more, so a one-letter placeholder does not blank every matching letter. */
export function secretNamedValues(env: Readonly<Record<string, string | undefined>>): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    SECRET_ENV_NAME.test(name) && value !== undefined && value.length >= 8 ? [value] : [],
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
 * Removes credentials from text that is about to leave the machine: the value
 * of every secret-named env var, bearer/basic tokens, JWTs, the password in a
 * URL, and `token=…`-style pairs. Values shorter than 8 characters are left,
 * so a one-letter placeholder does not blank every matching letter.
 */
export function redactSecrets(
  text: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return redactShapes(redactValues(text, secretNamedValues(env)));
}

/**
 * The secret values one command knows (ADR-0062). It starts with the values of the process
 * environment's credential-looking variables and learns the rest as the command reads them.
 * Everything the command prints, returns or reports passes through `redact`, and the second
 * process's output through a `StreamRedactor` over `values()`, so both hide the same set.
 */
export class KnownSecrets {
  private readonly known = new Set<string>();
  private readonly certain = new Set<string>();
  private matcher: SecretMatcher | undefined;

  constructor(env: Readonly<Record<string, string | undefined>>) {
    this.addByName(secretNamedValues(env));
  }

  /** Adds each value that is not empty and that Composer knows is a secret: one under a secrets key, or one a written `secrets` list returned. */
  add(values: Iterable<string>): void {
    for (const value of values) {
      if (value.length === 0) continue;
      this.known.add(value);
      this.certain.add(value);
      this.matcher = undefined;
    }
  }

  /** Adds each value that is not empty and only looks like a secret, by the name it is under. */
  addByName(values: Iterable<string>): void {
    for (const value of values) {
      if (value.length === 0) continue;
      this.known.add(value);
      this.matcher = undefined;
    }
  }

  /** Every value added so far, longest first. */
  values(): readonly string[] {
    return [...this.known].sort((a, b) => b.length - a.length);
  }

  /** The values added with `add`: those Composer knows are secrets, not only by their name. */
  certainValues(): ReadonlySet<string> {
    return this.certain;
  }

  /** `text` with every known value replaced by `[redacted]` at any length, then bearer tokens, JWTs, URL passwords and `token=…` pairs. */
  redact(text: string): string {
    this.matcher ??= new SecretMatcher(this.known);
    return redactShapes(this.matcher.redact(text));
  }
}

function textOf(configuration: AppConfiguration): Record<string, string> {
  return Object.fromEntries(
    Object.entries(configuration).flatMap(([name, value]) =>
      typeof value === 'string' ? [[name, value]] : [],
    ),
  );
}

/** The value under each name in `secretsKeys`, in the app configuration and in the app secrets, at any length. */
export function valuesUnderSecretsKeys(
  configuration: AppConfiguration,
  secrets: AppSecrets,
  secretsKeys: readonly string[],
): string[] {
  const text = textOf(configuration);
  return secretsKeys.flatMap((key) =>
    [text[key], secrets[key]].filter((value): value is string => value !== undefined),
  );
}

/** Each app configuration value of eight characters or more under a name that looks like a credential. */
export function credentialNamedValuesIn(configuration: AppConfiguration): string[] {
  return secretNamedValues(textOf(configuration));
}

function redactData(value: unknown, known: KnownSecrets): unknown {
  if (typeof value === 'string') return known.redact(value);
  if (Array.isArray(value)) return value.map((member) => redactData(member, known));
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, redactData(member, known)]),
    );
  }
  return value;
}

/**
 * `error` with every known secret removed from its summary, `why`, `fix` and every string in
 * its `meta`. The code, severity, `where` and docs link are kept. The cause is dropped, because
 * it holds the same text unredacted and a renderer may print it.
 */
export function redactError(error: CliStructuredError, known: KnownSecrets): CliStructuredError {
  return new CliStructuredError(error.code, known.redact(error.message), {
    severity: error.severity,
    ...(error.why === undefined ? {} : { why: known.redact(error.why) }),
    ...(error.fix === undefined ? {} : { fix: known.redact(error.fix) }),
    ...(error.where === undefined ? {} : { where: error.where }),
    ...(error.meta === undefined
      ? {}
      : {
          meta: Object.fromEntries(
            Object.entries(error.meta).map(([key, value]) => [key, redactData(value, known)]),
          ),
        }),
    ...(error.docsUrl === undefined ? {} : { docsUrl: error.docsUrl }),
  });
}

/**
 * Redacts a thrown defect in place, since the same error is rethrown: its message and stack,
 * and those of each error in its `cause` chain and in an `AggregateError`'s `errors`. A cause
 * that is text or plain data is replaced by a redacted copy.
 */
export function redactThrown(error: Error, known: KnownSecrets, seen = new Set<Error>()): void {
  if (seen.has(error)) return;
  seen.add(error);
  error.message = known.redact(error.message);
  if (typeof error.stack === 'string') error.stack = known.redact(error.stack);
  if (error.cause instanceof Error) redactThrown(error.cause, known, seen);
  else if (error.cause !== undefined) error.cause = redactData(error.cause, known);
  if (error instanceof AggregateError) {
    for (const member of error.errors)
      if (member instanceof Error) redactThrown(member, known, seen);
  }
}

/** `event` with every known secret removed from the text it carries: a message, or a dev server's output line. */
export function redactDevEvent(event: DevEvent, known: KnownSecrets): DevEvent {
  switch (event.kind) {
    case 'target-warning':
    case 'rebuild-failed':
    case 'watch-error':
    case 'stop-error':
      return { ...event, message: known.redact(event.message) };
    case 'dev-server-output':
      return { ...event, line: known.redact(event.line) };
    default:
      return event;
  }
}

/** `summary` with every known secret removed from each entity's id, url and details. */
export function redactSummary(
  summary: DeploymentSummary | undefined,
  known: KnownSecrets,
): DeploymentSummary | undefined {
  if (summary === undefined) return undefined;
  return {
    app: summary.app,
    nodes: summary.nodes.map((node) => ({
      address: node.address,
      entities: node.entities.map((entity) => ({
        ...entity,
        id: known.redact(entity.id),
        ...(entity.url === undefined ? {} : { url: known.redact(entity.url) }),
        ...(entity.details === undefined
          ? {}
          : {
              details: Object.fromEntries(
                Object.entries(entity.details).map(([key, value]) => [key, known.redact(value)]),
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

/** A transform that redacts one output stream with a `StreamRedactor`, and writes what it held back when the stream ends. */
export function redactingTransform(values: readonly string[]): TransformStream<string, string> {
  const redactor = new StreamRedactor(values);
  return new TransformStream<string, string>({
    transform(chunk, controller) {
      const out = redactor.push(chunk);
      if (out.length > 0) controller.enqueue(out);
    },
    flush(controller) {
      const out = redactor.end();
      if (out.length > 0) controller.enqueue(out);
    },
  });
}
