/**
 * Pipeline step 8: renders a deploy's result as the app's own topology.
 *
 * Presentation lives here, beside the CLI that owns the terminal — core
 * assembles the `DeploymentResult` and never formats (ADR-0033). The rendered
 * values are the entities each descriptor deliberately NAMED and apply
 * resolved; nothing here is scraped from a node's outputs, which are checked
 * for presence but never for truth.
 */
import type { DeployedEntity, DeployedNode, DeploymentResult } from '@internal/core/deploy';

/** Gap between the deepest tree label and the entity column. */
const LABEL_GAP = 3;

interface TreeNode {
  readonly segment: string;
  readonly children: Map<string, TreeNode>;
  /** The deployed node at exactly this address, if one deployed here. Absent for a pure path segment (`auth` when only `auth.api` deployed). */
  deployed?: DeployedNode;
}

const emptyNode = (segment: string): TreeNode => ({ segment, children: new Map() });

/** Builds the address tree, splitting each dot-address into its segments. */
function buildTree(nodes: readonly DeployedNode[]): TreeNode {
  const root = emptyNode('');
  for (const deployed of nodes) {
    let node = root;
    for (const segment of deployed.address.split('.')) {
      let child = node.children.get(segment);
      if (child === undefined) {
        child = emptyNode(segment);
        node.children.set(segment, child);
      }
      node = child;
    }
    node.deployed = deployed;
  }
  return root;
}

interface Row {
  /** Tree guides + connector + segment name — what occupies the left column. */
  readonly label: string;
  /** Guides only, with this row's own connector blanked — the prefix a wrapped line carries. */
  readonly continuation: string;
  readonly deployed: DeployedNode | undefined;
}

/** Flattens the tree to rows in address order, drawing the box guides. */
function toRows(node: TreeNode, guides: string, rows: Row[]): void {
  const children = Array.from(node.children.values());
  children.forEach((child, index) => {
    const isLast = index === children.length - 1;
    rows.push({
      label: `${guides}${isLast ? '└─ ' : '├─ '}${child.segment}`,
      // A wrapped line under this row keeps the ancestors' guides but not the
      // connector: the branch has already been drawn.
      continuation: `${guides}${isLast ? '   ' : '│  '}`,
      deployed: child.deployed,
    });
    toRows(child, `${guides}${isLast ? '   ' : '│  '}`, rows);
  });
}

/** `kind id` — the one line an entity gets. */
const entityLine = (entity: DeployedEntity): string => `${entity.kind} ${entity.id}`;

/** Pads `prefix` out to `width`, so every entity starts in the same column. */
const pad = (prefix: string, width: number): string => prefix.padEnd(width, ' ');

/**
 * Renders a deploy's result as the app's own topology. Pure — returns the
 * string; the caller prints.
 */
export function renderDeployment(result: DeploymentResult): string {
  const rows: Row[] = [];
  toRows(buildTree(result.nodes), '', rows);

  // One column for every entity in the tree, set by the widest label — so
  // the ids line up regardless of nesting depth.
  const column = Math.max(0, ...rows.map((row) => row.label.length)) + LABEL_GAP;

  const lines = [result.app];
  for (const row of rows) {
    if (row.deployed === undefined) {
      // A pure path segment (`auth` when only `auth.api` deployed) — structure,
      // not a deployed node. Nothing to report against it.
      lines.push(row.label);
      continue;
    }
    if (row.deployed.entities.length === 0) {
      lines.push(`${pad(row.label, column)}(no entities reported)`);
      continue;
    }
    // The first entity shares the label's line; the rest wrap into the
    // same column, as does a url.
    row.deployed.entities.forEach((entity, index) => {
      const prefix = index === 0 ? row.label : row.continuation;
      lines.push(`${pad(prefix, column)}${entityLine(entity)}`);
      if (entity.url !== undefined) {
        lines.push(`${pad(row.continuation, column)}${entity.url}`);
      }
    });
  }
  return lines.join('\n');
}

/**
 * The report hook the generated stack file wires into `LowerOptions`. Prints a
 * leading blank line so the summary separates from alchemy's own apply output.
 */
export function deploymentReport(result: DeploymentResult): void {
  console.log('');
  console.log(renderDeployment(result));
}
