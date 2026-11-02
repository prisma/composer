import { definePrismaConfig } from '@prisma/cli-engine';

const unused = () => {
  throw new Error('runPipeline never lowers');
};

export default definePrismaConfig({
  composer: {
    entry: './module.ts',
    extensions: [
      {
        id: 'fixture-extension',
        nodes: {
          'fixture/compute': {
            kind: 'service' as const,
            provision: unused,
            serialize: unused,
            package: unused,
            deploy: unused,
          },
        },
      },
      { id: 'fixture-build', nodes: { node: { kind: 'build' as const, assemble: unused } } },
    ],
    state: { extension: 'fixture-extension', create: unused },
  },
});
