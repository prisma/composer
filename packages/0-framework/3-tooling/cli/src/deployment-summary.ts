/**
 * The deploy result as data, and what a stack file run as a child hands back
 * to the CLI: the summary file the report hook writes, and the failure cause
 * the child records when it exits non-zero. `DeploymentResult` holds live
 * graph nodes (ADR-0033), so the summary keeps only what can be serialized.
 * Both files are best-effort: a write failure never fails the child.
 */
import * as fs from 'node:fs';
import { format, stripVTControlCharacters } from 'node:util';
import type { PreflightFindings } from '@internal/core/config';
import type { DeployedEntity, DeploymentResult } from '@internal/core/deploy';
import { redactCredentialLooking } from './redaction.ts';

/** Env var the deploy operation sets on the alchemy child: when present,
 * the report hook also writes the JSON DeploymentSummary there. */
export const DEPLOYMENT_RESULT_FILE_ENV = 'PRISMA_COMPOSER_DEPLOYMENT_RESULT_FILE';

/** The serializable projection of DeploymentResult — what CAN cross the process
 * boundary. Writer (report hook) and reader (deploy operation) share this shape. */
export interface DeployedNodeSummary {
  readonly address: string;
  readonly entities: readonly DeployedEntity[];
}

export interface DeploymentSummary {
  readonly app: string;
  readonly nodes: readonly DeployedNodeSummary[];
  /** The platform variables with no value that the deploy preflight found. */
  readonly findings: PreflightFindings;
}

/** Pure projection: keeps app, each node's address/entities and the findings, drops the in-process `node`. */
export function toDeploymentSummary(result: DeploymentResult): DeploymentSummary {
  return {
    app: result.app,
    nodes: result.nodes.map((node) => ({ address: node.address, entities: node.entities })),
    findings: result.findings,
  };
}

/**
 * Writer half, called by the report hook inside the alchemy child: when the
 * env var names a file, write the summary there. Best-effort — a write
 * failure must not fail a deploy that already converged, so it is swallowed.
 */
export function writeDeploymentSummaryFile(result: DeploymentResult): void {
  const file = process.env[DEPLOYMENT_RESULT_FILE_ENV];
  if (file === undefined || file.length === 0) return;
  try {
    fs.writeFileSync(file, JSON.stringify(toDeploymentSummary(result)));
  } catch {
    // The console rendering already happened; the summary is a convenience.
  }
}

/** The child's failure cause rides beside the result file, so the one env var names both and the parent's cleanup removes both. */
export function engineFailureFilePath(resultFilePath: string): string {
  return `${resultFilePath}.failure.txt`;
}

/** Enough output to hold the failed resource rows and the final error with its cause chain. */
const OUTPUT_TAIL_LIMIT = 64 * 1024;

/** Fits the platform's 5000-character build `errorMessage` with room for the exit-status prefix. */
const ENGINE_FAILURE_CAUSE_LIMIT = 1000;

/** Alchemy's advice to rerun its own CLI with `--adopt` or to import a resource with adoption, which a Composer user has no way to do. */
const ALCHEMY_ADOPT_ADVICE: readonly (readonly [RegExp, string])[] = [
  [
    /Re-run with `--adopt` \(or wrap the effect in `adopt\(true\)`\) to take it over\./g,
    'Something other than this app holds it. Remove that resource, then deploy again.',
  ],
  [
    /Re-run with `--adopt` \(or wrap the effect in `adopt\(true\)`\) to replace it anyway\./g,
    'Remove that resource, then deploy again.',
  ],
  [/\(re-deploy with --adopt to take ownership, then destroy\)/g, '(remove it by hand)'],
  [
    /Import it with explicit adoption (?:instead of silently taking it over|or choose a different [\w ]+ name)\./g,
    'Something other than this app holds it. Remove that resource, then deploy again.',
  ],
  [
    /; rerun with adoption enabled if it is the intended [\w ]+\./g,
    '. Remove that resource, then deploy again.',
  ],
];

/** Replaces Alchemy CLI advice in engine output with steps that work from Composer. */
export function withComposerAdvice(text: string): string {
  return ALCHEMY_ADOPT_ADVICE.reduce(
    (current, [advice, replacement]) => current.replace(advice, replacement),
    text,
  );
}

const STDOUT_CONSOLE_METHODS: ReadonlySet<string> = new Set(['log', 'info', 'debug']);

/**
 * Child half of the failure protocol, called by the generated stack file.
 * Keeps a bounded tail of everything this process logs through `console`,
 * passing every call through except Alchemy's CLI advice (see
 * {@link withComposerAdvice}), and on a non-zero exit writes the
 * redacted cause beside the result file. `console`, not the output streams:
 * alchemy's logger and its error reporting both go through it, and under Bun
 * `console` does not reach `process.stdout.write`.
 *
 * When stdout is not a terminal it carries the parent's data lines, so
 * everything this process prints goes to stderr instead.
 */
export function captureEngineFailure(): void {
  const resultFile = process.env[DEPLOYMENT_RESULT_FILE_ENV];
  if (resultFile === undefined || resultFile.length === 0) return;
  const stdoutToStderr = process.stdout.isTTY !== true;
  if (stdoutToStderr) process.stdout.write = process.stderr.write.bind(process.stderr);
  let tail = '';
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original =
      stdoutToStderr && STDOUT_CONSOLE_METHODS.has(method) ? console.error : console[method];
    console[method] = (...args: unknown[]) => {
      const text = format(...args);
      const shown = withComposerAdvice(text);
      // Redacted per record, so the tail cut can never leave half a secret behind.
      tail = `${tail}${redactCredentialLooking(shown, process.env)}\n`.slice(-OUTPUT_TAIL_LIMIT);
      if (shown === text) original.apply(console, args);
      else original.call(console, shown);
    };
  }
  process.once('exit', (code) => {
    if (code === 0) return;
    const cause = engineFailureCause(tail, process.env);
    if (cause === undefined) return;
    try {
      fs.writeFileSync(engineFailureFilePath(resultFile), cause);
    } catch {
      // The exit status already says the run failed; the cause is a convenience.
    }
  });
}

/** Parent half: the cause the child recorded, passed through `redact`, or undefined when it recorded none. The child redacts only what its own environment names as a credential; the parent also knows the known secrets. */
export function readEngineFailureCause(
  resultFilePath: string,
  redact: (text: string) => string,
): string | undefined {
  let cause: string;
  try {
    cause = fs.readFileSync(engineFailureFilePath(resultFilePath), 'utf8');
  } catch {
    return undefined;
  }
  return cause.length > 0 ? redact(cause) : undefined;
}

/** Effect's pretty log prefix, e.g. `[10:29:16.556] INFO (#53): `. */
const LOG_PREFIX = /^\[[\d:.]+\] ([A-Z]+) \(#\d+\): ?/;
/** Alchemy's per-resource failure row, e.g. `[web] fail — UnknownError: …`. */
const RESOURCE_FAIL_ROW = /^\[[^\]]+\] fail\b/;
const STACK_FRAME = /^\s*at /;

/**
 * The failure the output describes: every line from the first failure line
 * (a failed resource row, an ERROR log, or an `error:` line) to the end, minus
 * blank lines, stack frames and info logs; the last five lines when there is no
 * failure line. Redacted, then capped.
 */
export function engineFailureCause(
  output: string,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const lines: { text: string; failure: boolean; info: boolean }[] = [];
  for (const raw of stripVTControlCharacters(output).split(/\r\n|\r|\n/)) {
    const clean = raw.replace(/(?![\t])\p{Cc}/gu, '').trimEnd();
    const prefix = LOG_PREFIX.exec(clean);
    const text = (prefix === null ? clean : clean.slice(prefix[0].length)).trim();
    if (text.length === 0 || text === '{' || text === '}' || STACK_FRAME.test(text)) continue;
    const level = prefix?.[1];
    const failure =
      level === 'ERROR' ||
      level === 'FATAL' ||
      RESOURCE_FAIL_ROW.test(text) ||
      /^\W*error:/i.test(text);
    lines.push({ text, failure, info: !failure && level !== undefined });
  }
  const start = lines.findIndex((line) => line.failure);
  const kept = start === -1 ? lines.slice(-5) : lines.slice(start).filter((line) => !line.info);
  if (kept.length === 0) return undefined;
  const cause = redactCredentialLooking(kept.map((line) => line.text).join('\n'), env);
  return cause.length <= ENGINE_FAILURE_CAUSE_LIMIT
    ? cause
    : `${cause.slice(0, ENGINE_FAILURE_CAUSE_LIMIT - 1)}…`;
}

/** A failure cause capped to fit the platform build's error message. */
export function capFailureCause(cause: string): string {
  return cause.length <= ENGINE_FAILURE_CAUSE_LIMIT
    ? cause
    : `${cause.slice(0, ENGINE_FAILURE_CAUSE_LIMIT - 1)}…`;
}
