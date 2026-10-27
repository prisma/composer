/**
 * The dev session's view of the running app (local-dev spec § 5, ADR-0041 D5)
 * — a Compute-emulator client scoped to this app. Core renders `endpoints()`/
 * `logs()`/`stopApp()`, asks `serve()` to run a dev server (ADR-0056), and
 * never learns the emulator's HTTP API (ADR-0038's opacity pattern).
 */
import type { ServiceNode } from '@internal/core';
import type { LocalTargetAttachInput, LocalTargetAttachment } from '@internal/core/config';
import { computeClient } from '@internal/dev-emulators';
import {
  type AppScope,
  ensureServiceInstance,
  materializeEnv,
  nodeInstancesOf,
  stopAppInstances,
  withServiceAddresses,
} from '@internal/local-target';
import { prismaCloudContainerOf } from '../container.ts';
import { stashRows } from '../serializer.ts';

/**
 * The developer's shell environment, which a dev server keeps (ADR-0056): unlike a
 * deployed artifact, it runs on this machine and needs `NODE_OPTIONS`, proxy
 * settings and its framework's own `.env` loading. Composer's rows are laid over it.
 */
function shellEnv(): Readonly<Record<string, string | undefined>> {
  return process.env;
}

/** `compute({ listens: false })`, read structurally: the node may be a copy made by another bundle of this package, so `instanceof` cannot be relied on. */
function listensOn(node: ServiceNode): boolean {
  return !('listens' in node && node.listens === false);
}

const RELIST_INTERVAL_MS = 2000;

interface LogLine {
  readonly service: string;
  readonly line: string;
}

/**
 * Merges every listed service's `logs?follow=1` stream into one queue,
 * re-listing every 2 s so a service that appears after a later converge gets
 * its own follower attached, and re-attaching any follower whose connection
 * dropped (an emulator restart shows a gap in that service's stream, never a
 * dead session).
 */
async function* mergedLogs(
  scope: AppScope,
  signal: AbortSignal,
  tail: number,
  addresses: readonly string[] | undefined,
): AsyncIterable<LogLine> {
  const only = addresses === undefined ? undefined : new Set(addresses);
  const client = computeClient();
  const followed = new Set<string>();
  // Backlog is emitted once per service, on its FIRST follow — a follower
  // that drops and re-attaches (an emulator restart) resumes from the end, so
  // history is not replayed on every reconnect.
  const backlogged = new Set<string>();
  const queue: LogLine[] = [];
  let wake: (() => void) | undefined;

  const push = (item: LogLine): void => {
    queue.push(item);
    wake?.();
    wake = undefined;
  };

  const follow = (id: string, address: string): void => {
    if (followed.has(id)) return;
    followed.add(id);
    const followTail = backlogged.has(id) ? 0 : tail;
    backlogged.add(id);
    void (async () => {
      try {
        let buffer = '';
        for await (const chunk of client.followLogs(id, signal, { tail: followTail })) {
          buffer += chunk;
          let newlineAt = buffer.indexOf('\n');
          while (newlineAt !== -1) {
            push({ service: address, line: buffer.slice(0, newlineAt) });
            buffer = buffer.slice(newlineAt + 1);
            newlineAt = buffer.indexOf('\n');
          }
        }
      } catch {
        // the connection dropped — the next relist re-attaches it below
      } finally {
        followed.delete(id);
      }
    })();
  };

  const relist = async (): Promise<void> => {
    // Log lines are labelled with the service's address — the identity the
    // front door prints, so a service's endpoint line and its log lines name
    // it identically.
    for (const { address, instance } of await nodeInstancesOf(scope, 'service')) {
      if (only !== undefined && !only.has(address)) continue;
      follow(instance.id, address);
    }
  };

  await relist();
  const timer = setInterval(() => void relist(), RELIST_INTERVAL_MS);
  signal.addEventListener('abort', () => {
    clearInterval(timer);
    wake?.();
    wake = undefined;
  });

  try {
    while (!signal.aborted) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    clearInterval(timer);
  }
}

export async function devAttach(input: LocalTargetAttachInput): Promise<LocalTargetAttachment> {
  const scope = {
    devDir: input.devDir,
    app: prismaCloudContainerOf(input.container).input.appName,
  };
  const client = computeClient();

  return {
    startServices: async () => {
      const nodes = await nodeInstancesOf(scope, 'service');
      try {
        await client.startInstances(nodes.map(({ instance }) => instance.id));
      } catch (error) {
        throw withServiceAddresses(error, nodes);
      }
    },
    endpoints: async () => {
      const nodes = await nodeInstancesOf(scope, 'service');
      return nodes.map(({ address, instance }) => ({
        address,
        url: `http://localhost:${String(instance.port)}`,
      }));
    },
    logs: (signal, opts) => mergedLogs(scope, signal, opts?.tail ?? 0, opts?.addresses),
    // ADR-0056: the dev server runs on the service's instance as a command
    // deployment, with the environment the artifact's deployment would get,
    // stashed address-free as run() would, laid over the shell's own.
    serve: async ({ address, node, server }) => {
      const { instance } = await ensureServiceInstance(scope, address);
      const materialized = await materializeEnv(input.devDir, address, instance.port);
      const stashed = stashRows(node, address, materialized);
      const env: Record<string, string> = {};
      for (const layer of [shellEnv(), materialized, stashed]) {
        for (const [key, value] of Object.entries(layer)) {
          if (value !== undefined) env[key] = value;
        }
      }
      const argv = server.argv({ port: instance.port, host: '0.0.0.0' });
      try {
        const { started } = await client.putDeployment(instance.id, {
          command: { cwd: server.cwd, argv },
          env,
          listens: listensOn(node),
        });
        return { restarted: started };
      } catch (error) {
        throw withServiceAddresses(error, [{ address, instance }]);
      }
    },
    // Service processes and database servers; their data and ports are kept.
    stopApp: async () => {
      await stopAppInstances(scope);
    },
  };
}
