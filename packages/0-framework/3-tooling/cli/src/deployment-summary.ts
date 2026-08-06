/**
 * The deploy result's cross-process protocol, whole in one place: the
 * serializable shape, the env var that names the carrier file, the writer the
 * report hook calls from inside the alchemy child, and the reader the deploy
 * operation runs after the child exits. `DeploymentResult` itself cannot
 * cross the boundary — its `DeployedNode` entries hold live graph-node
 * references (ADR-0033) — so the writer projects it down to what CAN.
 *
 * The summary is best-effort by contract: the writer never fails the child
 * over it, and the reader maps absent or malformed to `undefined`.
 */
import * as fs from 'node:fs';
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
