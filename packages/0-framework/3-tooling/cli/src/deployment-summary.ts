/**
 * The deploy result's cross-process protocol, whole in one place: the
 * serializable shape, the env var that names the carrier file, the writer the
 * report hook calls from inside the alchemy child, and the reader the deploy
 * operation runs after the child exits. `DeploymentResult` itself cannot
 * cross the boundary — its `DeployedNode` entries hold live graph-node
 * references (ADR-0033) — so the writer projects it down to what CAN.
 *
 * The summary is best-effort by contract: the writer never fails the child
 * over it, and the reader maps absent or malformed to `undefined`. So is the
 * failure cause the child leaves beside it when it exits non-zero.
 */
import * as fs from 'node:fs';
import { format, stripVTControlCharacters } from 'node:util';
import type { ConfigPools } from '@internal/core/config';
import type { DeployedEntity, DeploymentResult } from '@internal/core/deploy';
import { blindCast } from '@internal/foundation/casts';

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
}

/** Pure projection: keeps app + each node's address/entities, drops the in-process `node`. */
export function toDeploymentSummary(result: DeploymentResult): DeploymentSummary {
  return {
    app: result.app,
    nodes: result.nodes.map((node) => ({ address: node.address, entities: node.entities })),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Reader half, run by the deploy operation after the child exits. Absent or
 * malformed → undefined — the summary is best-effort, never a deploy failure.
 */
export function readDeploymentSummary(resultFilePath: string): DeploymentSummary | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(resultFilePath, 'utf8');
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || typeof parsed['app'] !== 'string' || !Array.isArray(parsed['nodes'])) {
    return undefined;
  }
  for (const node of parsed['nodes']) {
    if (
      !isRecord(node) ||
      typeof node['address'] !== 'string' ||
      !Array.isArray(node['entities'])
    ) {
      return undefined;
    }
    for (const entity of node['entities']) {
      if (
        !isRecord(entity) ||
        typeof entity['kind'] !== 'string' ||
        typeof entity['id'] !== 'string'
      ) {
        return undefined;
      }
    }
  }
  return blindCast<
    DeploymentSummary,
    'the field-by-field checks above validate the runtime shape (string app, nodes with string addresses and kind/id-carrying entities); optional entity fields (url, details) are presentation-only strings the writer serialized from the same type'
  >(parsed);
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
      tail = `${tail}${redactSecrets(shown, process.env)}\n`.slice(-OUTPUT_TAIL_LIMIT);
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

/**
 * Parent half: the cause the child recorded, with every value in `secrets`
 * removed, or undefined when it recorded none. The child redacts only what its
 * own environment names as a secret; the parent knows the pools.
 */
export function readEngineFailureCause(
  resultFilePath: string,
  secrets: readonly string[] = [],
): string | undefined {
  let cause: string;
  try {
    cause = fs.readFileSync(engineFailureFilePath(resultFilePath), 'utf8');
  } catch {
    return undefined;
  }
  return cause.length > 0 ? redactValues(cause, secrets) : undefined;
}

/**
 * The pool values a failure cause must not carry: every config pool value
 * under a secret-named key, and, when the author lists the `secrets` adapters,
 * every secrets pool value and every config pool value under a key the secrets
 * pool also holds. The default `secrets` list is the whole process
 * environment, which the secret-name rule already covers.
 */
export function poolSecrets(pools: ConfigPools, secretsListed: boolean): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(pools.config)) {
    if (typeof value !== 'string') continue;
    if (SECRET_ENV_NAME.test(name) || (secretsListed && Object.hasOwn(pools.secrets, name))) {
      values.push(value);
    }
  }
  if (secretsListed) values.push(...Object.values(pools.secrets));
  return values;
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
  const cause = redactSecrets(kept.map((line) => line.text).join('\n'), env);
  return cause.length <= ENGINE_FAILURE_CAUSE_LIMIT
    ? cause
    : `${cause.slice(0, ENGINE_FAILURE_CAUSE_LIMIT - 1)}…`;
}

/**
 * The cause an in-process converge failed with, fit for a failure message
 * that may leave the machine: Composer's advice in place of Alchemy CLI
 * advice, credentials and pool secrets removed, capped.
 */
export function convergeFailureCause(
  cause: string,
  env: Readonly<Record<string, string | undefined>>,
  secrets: readonly string[],
): string {
  const cleaned = redactValues(redactSecrets(withComposerAdvice(cause), env), secrets);
  return cleaned.length <= ENGINE_FAILURE_CAUSE_LIMIT
    ? cleaned
    : `${cleaned.slice(0, ENGINE_FAILURE_CAUSE_LIMIT - 1)}…`;
}

/** Replaces each value of 8 characters or more, longest first, so a one-letter placeholder does not blank every matching letter. */
function redactValues(text: string, values: readonly string[]): string {
  let redacted = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length >= 8) redacted = redacted.replaceAll(value, REDACTED);
  }
  return redacted;
}

/** Env var names whose values are credentials: the service token, preflight payloads, and the usual secret spellings. */
const SECRET_ENV_NAME =
  /TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|AUTH|API_?KEY|ACCESS_?KEY|_KEY$|DATABASE_URL|_DSN$|^PRISMA_COMPOSER_PREFLIGHT_/i;
const REDACTED = '[redacted]';

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
  const values = Object.entries(env)
    .filter(([name]) => SECRET_ENV_NAME.test(name))
    .map(([, value]) => value ?? '');
  return redactValues(text, values)
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, `$1 ${REDACTED}`)
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED)
    .replace(/(\b[a-z][\w+.-]*:\/\/[^\s:/@]*:)[^\s/@]+@/gi, `$1${REDACTED}@`)
    .replace(
      /\b((?:[\w-]*[_-])?(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
      `$1${REDACTED}`,
    );
}
