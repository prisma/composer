/**
 * The dev session's view of the running app (local-dev spec § 5, ADR-0041 D5)
 * — a Compute-emulator client scoped to this app. Core renders `endpoints()`/
 * `logs()`/`stopServices()` and never learns the emulator's HTTP API
 * (ADR-0038's opacity pattern).
 */
import type { LocalTargetAttachInput, LocalTargetAttachment } from '@internal/core/config';
import { computeClient } from '@internal/dev-emulators';
import {
  type AppScope,
  nodeInstancesOf,
  stopAppInstances,
  withServiceAddresses,
} from '@internal/local-target';
import { prismaCloudContainerOf } from '../container.ts';

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
): AsyncIterable<LogLine> {
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
    for (const { address, instance } of await nodeInstancesOf(scope, 'compute')) {
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
      const nodes = await nodeInstancesOf(scope, 'compute');
      try {
        await client.startInstances(nodes.map(({ instance }) => instance.id));
      } catch (error) {
        throw withServiceAddresses(error, nodes);
      }
    },
    endpoints: async () => {
      const nodes = await nodeInstancesOf(scope, 'compute');
      return nodes.map(({ address, instance }) => ({
        address,
        url: `http://localhost:${String(instance.port)}`,
      }));
    },
    logs: (signal, opts) => mergedLogs(scope, signal, opts?.tail ?? 0),
    // Stops the databases too: when `prisma dev` ends, none of the app's
    // Postgres servers keeps running. Their data and ports are kept.
    stopServices: () => stopAppInstances(scope),
  };
}
