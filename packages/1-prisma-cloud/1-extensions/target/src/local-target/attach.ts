/**
 * The dev session's view of the running app (local-dev spec § 5, ADR-0041 D5)
 * — a Compute-emulator client scoped to this app. Core renders `endpoints()`/
 * `logs()`/`stopServices()` and never learns the emulator's HTTP API
 * (ADR-0038's opacity pattern).
 */
import type { LocalTargetAttachInput, LocalTargetAttachment } from '@internal/core/config';
import { computeClient } from '@internal/dev-emulators';
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
async function* mergedLogs(app: string, signal: AbortSignal): AsyncIterable<LogLine> {
  const client = computeClient();
  const followed = new Set<string>();
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
    void (async () => {
      try {
        let buffer = '';
        for await (const chunk of client.followLogs(app, id, signal)) {
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
    const services = await client.listServices(app);
    // The emulator's `id` is the (path-segment-safe) key `followLogs` needs;
    // the log line is labelled with the real, dotted address — the same
    // identity the front door prints, so a service's endpoint line and its
    // log lines name it identically (a nested module's service address
    // contains dots the emulator's own id path segment cannot carry — see
    // compute.ts's `slugServiceId`).
    for (const svc of services) follow(svc.id, svc.address);
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
  const app = prismaCloudContainerOf(input.container).input.appName;
  const client = computeClient();

  return {
    startServices: () => client.startApp(app),
    endpoints: async () => {
      const services = await client.listServices(app);
      return services.map((svc) => ({ address: svc.address, url: svc.url }));
    },
    logs: (signal) => mergedLogs(app, signal),
    stopServices: () => client.stopApp(app),
  };
}
