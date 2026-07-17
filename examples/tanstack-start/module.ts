import { module } from '@prisma/composer';
import webService from './src/service.ts';

export default module('tanstack-start-example', ({ provision }) => {
  provision(webService);
});
