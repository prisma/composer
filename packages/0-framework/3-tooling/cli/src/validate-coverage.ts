/**
 * Pipeline step: registry coverage. Every provisioned node's
 * `(extension, type)` — and every service's build descriptor's — must have a
 * registry entry of the right kind in the loaded config, BEFORE any slow
 * assembly work; the error names the missing extension and the config fix.
 * `lower()` re-checks the same relation inside the stack effect (the
 * backstop for programmatic callers); this check is the CLI's fail-fast UX.
 */
import type { Graph } from '@internal/core';
import type { ExtensionDescriptor, NodeDescriptor, PrismaAppConfig } from '@internal/core/config';
import { CliError } from './cli-error.ts';
import { CONFIG_FILENAME } from './load-config.ts';

function lookup(
  extensions: ReadonlyMap<string, ExtensionDescriptor>,
  extension: string,
  type: string,
  expectedKind: NodeDescriptor['kind'],
  what: string,
): void {
  const ext = extensions.get(extension);
  if (ext === undefined) {
    throw new CliError(
      `No extension "${extension}" is configured (needed by ${what}) — add it to ` +
        `${CONFIG_FILENAME}'s \`extensions\` (import its /control entry and list its descriptor).`,
    );
  }
  const descriptor = ext.nodes[type];
  if (descriptor === undefined) {
    throw new CliError(
      `Extension "${extension}" has no descriptor for node type "${type}" (needed by ${what}; ` +
        `known: ${Object.keys(ext.nodes).join(', ')}).`,
    );
  }
  if (descriptor.kind !== expectedKind) {
    throw new CliError(
      `Extension "${extension}"'s descriptor for node type "${type}" is a "${descriptor.kind}" ` +
        `descriptor — ${what} needs a "${expectedKind}" descriptor.`,
    );
  }
}

/** Throws a CliError on the first uncovered `(extension, type)`; silent when the config covers the whole graph. */
export function validateRegistryCoverage(graph: Graph, config: PrismaAppConfig): void {
  const extensions = new Map(config.extensions.map((descriptor) => [descriptor.id, descriptor]));

  for (const { id, node } of graph.nodes) {
    if (node.kind === 'resource') {
      lookup(extensions, node.extension, node.type, 'resource', `resource node "${id}"`);
      continue;
    }
    if (node.kind !== 'service') continue;
    lookup(extensions, node.extension, node.type, 'service', `service node "${id}"`);
    lookup(
      extensions,
      node.build.extension,
      node.build.type,
      'build',
      `service node "${id}"'s build descriptor`,
    );
  }
}
