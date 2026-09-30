import { definePrismaConfig } from '@prisma/cli-engine';

export default definePrismaConfig({
  composer: {
    extensions: [{ id: 'fixture-extension', nodes: {} }],
    state: { extension: 'fixture-extension', create: () => undefined },
  },
});
