/**
 * Public surface (the `./family` subpath): composer's engine `CommandFamily`,
 * for hosts that mount composer's commands into their own CLI — the `prisma`
 * bin does exactly this.
 *
 * Kept apart from `@prisma/composer`'s `./control` on purpose. `./control` is
 * the programmatic deploy pipeline; this is the command surface: grammar, help
 * and arg validation belong to the engine, and the handlers behind them are
 * the same operations `./control` exposes.
 *
 * Its static graph is alchemy-free and effect-free, so importing it costs a
 * host nothing until a composer command actually runs.
 */
export * from '@internal/cli/family';
