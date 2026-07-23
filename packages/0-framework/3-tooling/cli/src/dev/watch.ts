/**
 * Local-dev spec § 6 `watch.ts`: watches each assembled bundle's declared
 * `watch` paths (a directory watched recursively, a file watched plainly),
 * debounced 300 ms and coalesced across every service — one edit across
 * several files/services still fires exactly one rebuild.
 *
 * The watch ENGINE is `chokidar` v4 (operator decision, design tip 74272d8:
 * don't-reinvent-the-wheel beats the no-new-deps contract here — chokidar
 * absorbs the atomic-rename/inode-swap class this module used to hand-fix
 * with a parent-directory workaround, plus the cross-platform
 * recursive-watch differences; v4 is pure JS, no native code, no glob
 * surface — irrelevant here anyway, since every target is a literal file or
 * directory path, never a pattern). The debounce stays OURS: chokidar's own
 * `awaitWriteFinish` is a per-file "has this file's size stopped changing"
 * poll, a different semantic from "coalesce a burst across many files into
 * one callback," which is what the dev loop actually needs.
 */
import type { Bundle } from '@internal/core/deploy';
import { watch as chokidarWatch, type FSWatcher } from 'chokidar';

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

/**
 * Watches every target's paths via chokidar, debounced 300 ms and coalesced
 * across every service, invoking `onChange` once per burst. Returns a stop
 * function. A path that doesn't exist on disk is simply never reported by
 * chokidar (nothing to watch) — no explicit existence check needed, unlike
 * the old `fs.watch`-based implementation.
 */
export function startWatch(targets: readonly WatchTarget[], onChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const trigger = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      onChange();
    }, DEBOUNCE_MS);
  };

  const allPaths = targets.flatMap((target) => target.paths);
  const watcher: FSWatcher = chokidarWatch(allPaths, { ignoreInitial: true });
  watcher.on('all', () => trigger());

  return () => {
    if (timer !== undefined) clearTimeout(timer);
    void watcher.close();
  };
}
