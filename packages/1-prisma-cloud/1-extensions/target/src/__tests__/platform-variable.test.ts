import { describe, expect, test } from 'bun:test';
import {
  appRoot,
  isParamSource,
  isPlainPointer,
  isSecretPointer,
  isSecretSource,
  isValueResource,
  Load,
} from '@internal/core';
import { PRISMA_CLOUD_EXTENSION_ID } from '../extension-id.ts';
import { platformVariableName, variable } from '../platform-variable.ts';

const nodeIds = (root: Parameters<typeof Load>[0]) => Load(root).nodes.map((entry) => entry.id);

describe('variable() and variable.secret()', () => {
  test('build a platform-variable value resource of the Prisma Cloud extension with the name and secrecy in its props', () => {
    for (const [node, secret] of [
      [variable({ name: 'EMAIL_FROM' }), false],
      [variable.secret({ name: 'EMAIL_FROM' }), true],
    ] as const) {
      expect(isValueResource(node)).toBe(true);
      expect(node.kind).toBe('resource');
      expect(node.type).toBe('platform-variable');
      expect(node.extension).toBe(PRISMA_CLOUD_EXTENSION_ID);
      expect(node.props).toEqual({ name: 'EMAIL_FROM', secret });
    }
  });

  test('a plain node provisions a plain param source and a secret node a secret source, each naming the variable', () => {
    let plain: unknown;
    let secret: unknown;
    Load(
      appRoot('shop', ({ provision }) => {
        plain = provision(variable({ name: 'EMAIL_FROM' }));
        secret = provision(variable.secret({ name: 'EMAIL_KEY' }));
      }),
    );

    expect(isParamSource(plain) && isPlainPointer(plain)).toBe(true);
    expect(isSecretSource(secret) && isSecretPointer(secret)).toBe(true);
    if (!isParamSource(plain) || !isSecretSource(secret)) throw new Error('expected two sources');
    expect(platformVariableName(plain, 'here')).toBe('EMAIL_FROM');
    expect(platformVariableName(secret, 'here')).toBe('EMAIL_KEY');
  });

  test('a secret node turned into text names the platform secret', () => {
    expect(() =>
      Load(
        appRoot('shop', ({ provision }) => {
          String(provision(variable.secret({ name: 'EMAIL_KEY' })));
        }),
      ),
    ).toThrow(/^the platform secret "EMAIL_KEY" is known only at boot/);
  });

  test.each([
    ['variable', variable],
    ['variable.secret', variable.secret],
  ] as const)(
    '%s() refuses a name that is not upper case, when the root body runs',
    (factory, build) => {
      expect(() =>
        Load(
          appRoot('shop', ({ provision }) => {
            provision(build({ name: 'email_from' }));
          }),
        ),
      ).toThrow(
        `${factory} name "email_from" is not a platform variable name: it must be an upper-case letter followed by upper-case letters, digits and underscores, for example API_KEY.`,
      );
    },
  );

  test.each([
    ['variable', variable],
    ['variable.secret', variable.secret],
  ] as const)('%s() refuses the reserved name PORT', (factory, build) => {
    expect(() => build({ name: 'PORT' })).toThrow(
      `${factory} name "PORT" is reserved: boot sets PORT to the service's port.`,
    );
  });

  test('the empty-name message shows the call with an options object', () => {
    expect(() => variable({ name: '' })).toThrow(
      "variable() requires a non-empty platform variable name, for example variable({ name: 'API_KEY' }).",
    );
    expect(() => variable.secret({ name: '' })).toThrow(
      "variable.secret() requires a non-empty platform variable name, for example variable.secret({ name: 'API_KEY' }).",
    );
  });

  test('platformVariableName refuses a source that is not a platform variable, naming the place', () => {
    let origin: unknown;
    Load(
      appRoot('shop', ({ provision }) => {
        origin = provision(variable({ name: 'X' }));
      }),
    );
    if (!isParamSource(origin)) throw new Error('expected a param source');
    const foreign = { ...origin, payload: { name: 'X' } };
    expect(() => platformVariableName(foreign, 'input key "from" of service "shop.web"')).toThrow(
      'input key "from" of service "shop.web" is bound to a source that is not a platform variable. Provision variable() or variable.secret() from @prisma/composer-prisma-cloud in the app root and pass its value down.',
    );
  });
});

describe('the default provision id', () => {
  test.each([
    ['EMAIL_FROM', 'emailFrom'],
    ['SMTP_PORT', 'smtpPort'],
    ['EMAIL_2FA', 'email2fa'],
    ['A__B', 'aB'],
  ])('%s gives %s', (name, id) => {
    expect(
      nodeIds(
        appRoot('shop', ({ provision }) => {
          provision(variable({ name }));
        }),
      ),
    ).toContain(`shop.${id}`);
  });

  test('an explicit id replaces it', () => {
    const ids = nodeIds(
      appRoot('shop', ({ provision }) => {
        provision(variable({ name: 'EMAIL_FROM' }), { id: 'sender' });
      }),
    );
    expect(ids).toContain('shop.sender');
    expect(ids).not.toContain('shop.emailFrom');
  });
});
