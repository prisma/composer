import { StateStoreError } from 'alchemy/State';

/** Collapses any thrown value (postgres.js failures included) into a {@link StateStoreError}. */
export const toStateStoreError = (cause: unknown): StateStoreError =>
  cause instanceof Error
    ? new StateStoreError({ message: cause.message, cause })
    : new StateStoreError({ message: String(cause) });
