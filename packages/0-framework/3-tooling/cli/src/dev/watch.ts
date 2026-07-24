/**
 * Local-dev spec § 6 `watch.ts`: watches each assembled bundle's declared
 * `watch` paths (a directory watched recursively, a file watched through
 * its parent — see `startWatch`), debounced 300 ms and coalesced across
 * every service — one edit across several files/services still fires
 * exactly one rebuild.
 *
 * The watch ENGINE is `chokidar` v4 (operator decision, design tip 74272d8:
 * don't-reinvent-the-wheel beats the no-new-deps contract here — it absorbs
 * the atomic-rename class and the cross-platform recursive-watch
 * differences; v4 is pure JS, no native code, no glob surface — irrelevant
 * here anyway, since every target is a literal file or directory path,
 * never a pattern). The parent-directory indirection for FILE targets stays
 * OURS (`startWatch` explains why), as does the debounce: chokidar's own
 * `awaitWriteFinish` is a per-file "has this file's size stopped changing"
 * poll, a different semantic from "coalesce a burst across many files into
 * one callback," which is what the dev loop actually needs.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Bundle } from '@internal/core/deploy';
import chokidar, { type FSWatcher } from 'chokidar';

const DEBOUNCE_MS = 300;

export interface WatchTarget {
  readonly address: string;
  readonly paths: readonly string[];
}

/** Bundles → watch targets, plus the addresses with nothing watchable (the pinned one-line startup note). */
export function watchTargetsFrom(bundles: Readonly<Record<string, Bundle>>): {
  readonly targets: readonly WatchTarget[];
  readonly unwatchable: readonly string[];
} {
  const targets: WatchTarget[] = [];
  const unwatchable: string[] = [];
  for (const [address, bundle] of Object.entries(bundles)) {
    const paths = bundle.watch;
    if (paths === undefined || paths.length === 0) {
      unwatchable.push(address);
      continue;
    }
    targets.push({ address, paths });
  }
  return { targets, unwatchable };
}

export interface WatchHandle {
  /** Resolves once chokidar's OS-level watches are attached — a change made before this can be missed entirely. Also resolves on `stop()` so an awaiting caller can never hang. */
  readonly ready: Promise<void>;
  stop(): void;
}

/**
 * Watches every target's paths via chokidar, debounced 300 ms and coalesced
 * across every service, invoking `onChange` once per burst.
 *
 * File targets are watched THROUGH their parent directory, filtered to the
 * exact path: a watch bound directly to a file dies with the file's inode
 * on Linux, so `rm -rf dist && bun build --outfile dist/x.mjs` — every
 * rebuild's shape — would go silently unobserved after the first delete
 * (chokidar absorbs atomic renames, not unlink+recreate of a directly
 * watched file; proven by the delete-recreate test failing on Linux CI
 * only). Directory targets are watched recursively as themselves; a
 * nonexistent path is treated as a file target, so it starts reporting the
 * moment something creates it.
 */
export function startWatch(targets: readonly WatchTarget[], onChange: () => void): WatchHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const trigger = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, DEBOUNCE_MS);
  };

  const fileTargets = new Set<string>();
  const directoryRoots = new Set<string>();
  const parentRoots = new Set<string>();
  for (const target of targets) {
    for (const p of target.paths) {
      const abs = path.resolve(p);
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(abs).isDirectory();
      } catch {
        // nonexistent → file target via its parent
      }
      if (isDirectory) {
        directoryRoots.add(abs);
      } else {
        fileTargets.add(abs);
        parentRoots.add(path.dirname(abs));
      }
    }
  }

  // An 'error' emitted with no listener throws and would take the whole dev
  // session down — a watch error (EMFILE, a vanished directory) is worth a
  // line, not the process.
  const reportError = (error: unknown): void => {
    console.error(`[dev] watch error: ${error instanceof Error ? error.message : String(error)}`);
  };

  const watchers: FSWatcher[] = [];
  if (directoryRoots.size > 0) {
    const directoryWatcher = chokidar.watch([...directoryRoots], { ignoreInitial: true });
    directoryWatcher.on('all', () => trigger());
    directoryWatcher.on('error', reportError);
    watchers.push(directoryWatcher);
  }
  if (parentRoots.size > 0) {
    const parentWatcher = chokidar.watch([...parentRoots], { ignoreInitial: true, depth: 0 });
    parentWatcher.on('all', (_event, eventPath) => {
      if (fileTargets.has(path.resolve(eventPath))) trigger();
    });
    parentWatcher.on('error', reportError);
    watchers.push(parentWatcher);
  }

  let markReady: () => void = () => {};
  const allReady = Promise.all(
    watchers.map((watcher) => new Promise<void>((resolve) => watcher.on('ready', () => resolve()))),
  ).then(() => {});
  const ready = Promise.race([allReady, new Promise<void>((resolve) => (markReady = resolve))]);

  return {
    ready,
    stop: () => {
      if (timer !== undefined) clearTimeout(timer);
      markReady();
      for (const watcher of watchers) void watcher.close();
    },
  };
}
