import { createHmac } from 'node:crypto';

export const keyCheckValue = (signingKey: string): string =>
  createHmac('sha256', signingKey).update('storefront-auth signing key check').digest('hex');
