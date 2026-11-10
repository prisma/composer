const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

const DATABASE_URL_REASON =
  'Prisma Cloud sets and manages DATABASE_URL and DATABASE_URL_POOLED itself. Declare the database your service uses and read its url from that connection.';
const SHELL_REASON =
  'under prisma dev the local target sets PATH and HOME from your shell, so a value on the platform would never be seen locally.';

const RESERVED_NAMES: ReadonlyMap<string, string> = new Map([
  ['DATABASE_URL', DATABASE_URL_REASON],
  ['DATABASE_URL_POOLED', DATABASE_URL_REASON],
  ['PORT', "boot sets PORT to the service's port."],
  ['PATH', SHELL_REASON],
  ['HOME', SHELL_REASON],
]);

export function assertVariableName(name: string, factory: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(
      `${factory}() requires a non-empty platform variable name, for example ${factory}('API_KEY').`,
    );
  }
  if (!VARIABLE_NAME.test(name)) {
    throw new Error(
      `${factory} name "${name}" is not a platform variable name: it must be an upper-case letter followed by upper-case letters, digits and underscores, for example API_KEY.`,
    );
  }
  if (name.startsWith('COMPOSER_')) {
    throw new Error(
      `${factory} name "${name}" is reserved: names starting with COMPOSER_ are Composer's own platform variables.`,
    );
  }
  const reason = RESERVED_NAMES.get(name);
  if (reason !== undefined) {
    throw new Error(`${factory} name "${name}" is reserved: ${reason}`);
  }
}
