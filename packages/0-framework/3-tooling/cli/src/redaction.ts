import type { AppConfiguration, AppSecrets } from '@internal/core/config';
import { CliStructuredError } from '@internal/foundation/errors';
import {
  type DeploymentSummary,
  REDACTED,
  redactSecrets,
  redactValues,
  secretNamedValues,
} from './deployment-summary.ts';
import type { DevEvent } from './operations/dev.ts';

/**
 * The secret values one command knows (ADR-0062). It learns them as the command reads them,
 * and everything the command prints, returns or reports passes through `redact`.
 */
export class KnownSecrets {
  private readonly known = new Set<string>();
  private readonly certain = new Set<string>();

  /** Adds each value that is not empty and that Composer knows is a secret: one under a secrets key, or one a written `secrets` list returned. */
  add(values: Iterable<string>): void {
    for (const value of values) {
      if (value.length === 0) continue;
      this.known.add(value);
      this.certain.add(value);
    }
  }

  /** Adds each value that is not empty and only looks like a secret, by the name it is under. */
  addByName(values: Iterable<string>): void {
    for (const value of values) if (value.length > 0) this.known.add(value);
  }

  /** Every value added so far, longest first. */
  values(): readonly string[] {
    return [...this.known].sort((a, b) => b.length - a.length);
  }

  /** The values added with `add`: those Composer knows are secrets, not only by their name. */
  certainValues(): ReadonlySet<string> {
    return this.certain;
  }

  /** `text` with every known value replaced by `[redacted]` at any length, then whatever `redactSecrets` finds by name and by shape. */
  redact(text: string): string {
    return redactSecrets(redactValues(text, this.known), process.env);
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
 * Redacts a stream of text chunk by chunk: every value in `values` becomes `[redacted]`. It holds
 * back only the longest end of the text that could be the start of a value, so a value split
 * across two chunks is still replaced, and text that cannot start one, such as a prompt, is
 * returned at once. It never splits a surrogate pair. `push` returns the text that is ready;
 * `end` returns the rest.
 */
export class StreamRedactor {
  private held = '';
  private readonly sorted: readonly string[];
  private readonly pattern: RegExp | undefined;

  constructor(values: readonly string[]) {
    this.sorted = [...new Set(values)]
      .filter((value) => value.length > 0)
      .sort((a, b) => b.length - a.length);
    this.pattern =
      this.sorted.length === 0
        ? undefined
        : new RegExp(
            this.sorted.map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
            'g',
          );
  }

  /** The length of the longest end of `text` that is the start, not the whole, of a value. */
  private startOfValueAtEnd(text: string): number {
    let longest = 0;
    for (const value of this.sorted) {
      for (let length = Math.min(value.length - 1, text.length); length > longest; length--) {
        if (text.endsWith(value.slice(0, length))) {
          longest = length;
          break;
        }
      }
    }
    return longest;
  }

  push(chunk: string): string {
    let text = this.held + chunk;
    let out = '';
    for (;;) {
      let cut = text.length - this.startOfValueAtEnd(text);
      let from = 0;
      let crossed = false;
      if (this.pattern !== undefined) {
        for (const match of text.matchAll(this.pattern)) {
          if (match.index >= cut) break;
          out += text.slice(from, match.index) + REDACTED;
          from = match.index + match[0].length;
          if (from > cut) {
            crossed = true;
            break;
          }
        }
      }
      if (crossed) {
        text = text.slice(from);
        continue;
      }
      if (cut > from && cut < text.length && isHighSurrogate(text.charCodeAt(cut - 1))) cut -= 1;
      out += text.slice(from, cut);
      this.held = text.slice(cut);
      return out;
    }
  }

  end(): string {
    const text = this.held;
    this.held = '';
    return this.pattern === undefined ? text : text.replace(this.pattern, REDACTED);
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
