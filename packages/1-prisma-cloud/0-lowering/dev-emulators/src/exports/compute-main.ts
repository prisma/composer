/**
 * Public surface: the Compute emulator daemon program. It exports nothing —
 * importing (or running) it starts the server. `daemon.ts` resolves this
 * subpath via `import.meta.resolve` and spawns it directly. Implementation
 * lives in `../compute-main.ts`.
 */
import '../compute-main.ts';
