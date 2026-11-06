import { definePrismaConfig } from '@prisma/cli-engine';

export default definePrismaConfig({
  composer: {
    extensions: [{ id: 'fixture-extension', nodes: {} }],
    state: { extension: 'fixture-extension', create: () => undefined },
    config: [
      () => {
        throw new Error('the second process ran a config adapter');
      },
    ],
    secrets: [
      () => {
        throw new Error('the second process ran a secrets adapter');
      },
    ],
  },
});
