import { module } from '@prisma/composer';
import service from './src/service.ts';

export default module('framework-vite', ({ provision }) => {
  provision(service);
});
