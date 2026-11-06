const VARIABLE_NAME = /^[A-Z][A-Z0-9_]*$/;

const RESERVED_NAMES: ReadonlyMap<string, string> = new Map([
  [
    'DATABASE_URL',
    'Prisma Cloud sets and manages DATABASE_URL and DATABASE_URL_POOLED itself. Declare the database your service uses and read its url from that connection.',
  ],
  [
    'DATABASE_URL_POOLED',
    'Prisma Cloud sets and manages DATABASE_URL and DATABASE_URL_POOLED itself. Declare the database your service uses and read its url from that connection.',
  ],
  ['PORT', "boot sets PORT to the service's port."],
  [
    'PATH',
    'under prisma dev the local target sets PATH and HOME from your shell, so a value on the platform would never be seen locally.',
  ],
  [
    'HOME',
    'under prisma dev the local target sets PATH and HOME from your shell, so a value on the platform would never be seen locally.',
  ],
]);

/** Throws unless `name` may name a platform variable. `factory` names the function that was given it, for the message. */
export function assertVariableName(name: string, factory: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error(
      `${factory}() requires a non-empty platform variable name, e.g. ${factory}('API_KEY').`,
    );
  }
  if (!VARIABLE_NAME.test(name)) {
    throw new Error(
      `${factory} name "${name}" is not a platform variable name: it must match ${VARIABLE_NAME.source}, an upper-case letter followed by upper-case letters, digits and underscores, because the platform accepts no other key and a process environment compares names with case.`,
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
