import { prismaTsDownConfig } from '@prisma/compose/tsdown';

// The app's own build (ADR-0005): a self-contained ESM bundle of its runnable.
// `prismaTsDownConfig` inlines everything except runtime built-ins, so
// node_modules is never shipped and boot never leans on bun auto-install.
export default prismaTsDownConfig({ entry: { server: 'src/server.ts' } });
