// @ts-nocheck -- service.js resolves to service.ts under tsx; TypeScript sees
// the .js extension as missing (no .js file exists), so this file is excluded
// from type-checking. It acts as a loadability guard: `prisma-composer deploy`
// must be able to import ./service.js via tsx without failing.
import { module } from '@prisma/composer';
import guardService from './service.js';

export default module('js-ext-imports', ({ provision }) => {
  provision(guardService);
});
