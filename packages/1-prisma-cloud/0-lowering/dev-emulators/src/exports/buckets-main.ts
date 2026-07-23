/**
 * Public surface: the bucket emulator daemon program. It exports nothing —
 * importing (or running) it starts the server. `daemon.ts` resolves this
 * subpath via `import.meta.resolve` and spawns it directly. Implementation
 * lives in `../buckets-main.ts`.
 */
import '../buckets-main.ts';
