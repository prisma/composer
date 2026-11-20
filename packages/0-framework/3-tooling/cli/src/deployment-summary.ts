/**
 * The deploy result as data. `DeploymentResult` holds live graph nodes
 * (ADR-0033), so the summary keeps only what can be serialized.
 */
import type { PreflightFindings } from '@internal/core/config';
import type { DeployedEntity, DeploymentResult } from '@internal/core/deploy';

/** The serializable projection of DeploymentResult. */
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

/** Bounds the failure summary and the report's failure cause, long enough to keep the advice an error carries. */
const ENGINE_FAILURE_CAUSE_LIMIT = 4000;

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

/** A failure cause capped to fit the platform build's error message. */
export function capFailureCause(cause: string): string {
  return cause.length <= ENGINE_FAILURE_CAUSE_LIMIT
    ? cause
    : `${cause.slice(0, ENGINE_FAILURE_CAUSE_LIMIT - 1)}…`;
}
