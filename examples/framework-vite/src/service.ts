import frameworkBuild from '@prisma/composer-frameworks';
import { compute } from '@prisma/composer-prisma-cloud';

export default compute({
  name: 'web',
  deps: {},
  build: frameworkBuild({ module: import.meta.url, framework: 'vite', root: '..' }),
});
