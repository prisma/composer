/**
 * The published test double for `@prisma/composer/control`
 * (`@prisma/composer/control/testing`): the four operations with the REAL
 * signatures and `Result` shapes, backed by per-test fixtures — never a
 * config load, an alchemy process, or a container. `ControlOperations` (the
 * annotated return type, built from `typeof` the real operations) is the
 * compile-time conformance check: if an operation's signature drifts, this
 * module stops typechecking.
 *
 * Import-light like `./control` itself — types, the result helpers, and the
 * error class; nothing here reaches the pipeline (pinned by
 * exports/__tests__/control-import.test.ts).
 */
import { blindCast } from '@internal/foundation/casts';
import { CliStructuredError } from '@internal/foundation/errors';
import { notOk, ok, okVoid, type Result } from '@internal/foundation/result';
import type { DeployInput, DeploySuccess, deploy } from './deploy.ts';
import type { DestroyInput, destroy } from './destroy.ts';
import type { DevInput, DevSession, dev } from './dev.ts';
import type { LogAttached, LogInput, LogLine, log } from './log.ts';
import type { ServiceEndpoint } from './shared.ts';

export { notOk, ok, okVoid };

/**
 * Builds a `CliStructuredError` failure for a fixture. Exported because the
 * class itself is deliberately not value-exported from `./control` (hosts
 * recognize failures structurally, ADR-0044) — a test still needs to
 * CONSTRUCT one to script a failing operation.
 */
export function structuredFailure(
  code: `${string}.${string}`,
  summary: string,
  options?: {
    readonly why?: string;
    readonly fix?: string;
    readonly where?: { readonly path?: string; readonly line?: number };
    readonly meta?: Record<string, unknown>;
    readonly cause?: unknown;
  },
): CliStructuredError {
  return new CliStructuredError(code, summary, options);
}

/** The real operations' exact surface — `createControlDouble`'s annotated return type, so signature drift is a compile error here. */
export interface ControlOperations {
  readonly deploy: typeof deploy;
  readonly destroy: typeof destroy;
  readonly dev: typeof dev;
  readonly log: typeof log;
}

/** A fixture is a canned response, or a function of the operation's input (sync or async) for tests that branch per call. */
type Fixture<I, R> = R | ((input: I) => R | Promise<R>);

/** What `dev` should produce: a failure, or the session the double builds — endpoints now, lifecycle handled (stop() emits 'stopping'/'stopped' and settles `closed`). */
export interface DevSessionFixture {
  readonly endpoints?: readonly ServiceEndpoint[];
}

/** What `log` should produce: a failure, or the attachment the double builds — `lines` replay in order (address-filtered like the real operation), then the stream ends. */
export interface LogFixture {
  readonly appName?: string;
  readonly services?: readonly ServiceEndpoint[];
  readonly lines?: readonly LogLine[];
}

export interface ControlDoubleFixtures {
  /** Defaults to `ok({ summary: undefined })` — a converged deploy whose child wrote no summary file. */
  readonly deploy?: Fixture<DeployInput, Result<DeploySuccess, CliStructuredError>>;
  /** Defaults to `okVoid()`. */
  readonly destroy?: Fixture<DestroyInput, Result<void, CliStructuredError>>;
  /** Defaults to a session with no endpoints. */
  readonly dev?: Fixture<DevInput, DevSessionFixture | Result<never, CliStructuredError>>;
  /** Defaults to an attachment with no services and an already-finished stream. */
  readonly log?: Fixture<LogInput, LogFixture | Result<never, CliStructuredError>>;
}

async function resolveFixture<I, R>(fixture: Fixture<I, R>, input: I): Promise<R> {
  if (typeof fixture !== 'function') return fixture;
  const producer = blindCast<
    (input: I) => R | Promise<R>,
    'every R a Fixture is instantiated with here is a Result, a DevSessionFixture, or a LogFixture — plain objects, never functions — so a function can only be the producer arm of the union'
  >(fixture);
  return producer(input);
}

function isResult(value: unknown): value is Result<never, CliStructuredError> {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

function makeDevSession(fixture: DevSessionFixture, input: DevInput): DevSession {
  let stopping: Promise<void> | undefined;
  let settleClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    settleClosed = resolve;
  });
  return {
    endpoints: fixture.endpoints ?? [],
    stop(): Promise<void> {
      stopping ??= Promise.resolve().then(() => {
        input.onEvent?.({ kind: 'stopping' });
        input.onEvent?.({ kind: 'stopped' });
        settleClosed();
      });
      return stopping;
    },
    closed,
  };
}

function makeLogAttachment(fixture: LogFixture, input: LogInput): LogAttached {
  const services = fixture.services ?? [];
  const allLines = fixture.lines ?? [];
  const selected =
    input.address === undefined
      ? allLines
      : allLines.filter((line) => line.service === input.address);
  async function* lines(): AsyncGenerator<LogLine> {
    for (const line of selected) {
      if (input.signal?.aborted === true) return;
      yield line;
    }
  }
  return {
    appName: fixture.appName ?? input.name ?? 'app',
    services,
    lines: lines(),
  };
}

/**
 * A fresh double per test: real signatures, fixture-scripted outcomes.
 * Override any subset of operations; the rest succeed with empty defaults.
 */
export function createControlDouble(fixtures: ControlDoubleFixtures = {}): ControlOperations {
  return {
    deploy: async (input) =>
      resolveFixture(fixtures.deploy ?? ok<DeploySuccess>({ summary: undefined }), input),

    destroy: async (input) => resolveFixture(fixtures.destroy ?? okVoid(), input),

    dev: async (input) => {
      const outcome = await resolveFixture<
        DevInput,
        DevSessionFixture | Result<never, CliStructuredError>
      >(fixtures.dev ?? {}, input);
      if (isResult(outcome)) return outcome;
      return ok(makeDevSession(outcome, input));
    },

    log: async (input) => {
      const outcome = await resolveFixture<
        LogInput,
        LogFixture | Result<never, CliStructuredError>
      >(fixtures.log ?? {}, input);
      if (isResult(outcome)) return outcome;
      return ok(makeLogAttachment(outcome, input));
    },
  };
}
