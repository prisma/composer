/**
 * The extension's dev control-plane entry (ADR-0041, operator directive) —
 * a SEPARATE entry from `./control`, loaded only via the lazy
 * `dev: () => import('@prisma/composer-prisma-cloud/dev').then(...)`
 * reference `control/extension.ts` carries. Implementation lives in
 * `../dev/descriptor.ts`.
 */
export { devDescriptor } from '../dev/descriptor.ts';
