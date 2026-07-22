/**
 * A minimal loopback SMTP responder for `delivery-smtp.test.ts` — a lightweight
 * capture in place of a live relay (spec test plan). Implements just enough of
 * the protocol for nodemailer's SMTP client to complete a session: greeting,
 * EHLO, MAIL FROM/RCPT TO (always 250), DATA, and a scripted final response to
 * the terminating `.` — either an accept or an SMTP error code. `refuse`
 * closes the socket before the greeting, simulating a connection failure.
 */
import { createServer, type Socket } from 'node:net';

export type FakeSmtpResponse =
  | { readonly kind: 'accept'; readonly messageId?: string }
  | { readonly kind: 'reject'; readonly code: number; readonly message: string }
  | { readonly kind: 'refuse' };

export interface FakeSmtpServer {
  readonly port: number;
  stop(): Promise<void>;
}

function handleConnection(socket: Socket, response: FakeSmtpResponse): void {
  if (response.kind === 'refuse') {
    socket.destroy();
    return;
  }

  let buffer = '';
  let inData = false;
  const write = (line: string): void => {
    socket.write(`${line}\r\n`);
  };
  write('220 fake-smtp ESMTP');

  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let separatorIndex = buffer.indexOf('\r\n');
    while (separatorIndex !== -1) {
      const line = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);

      if (inData) {
        if (line === '.') {
          inData = false;
          if (response.kind === 'accept') {
            write(`250 OK: queued as ${response.messageId ?? 'fake-message-id'}`);
          } else {
            write(`${response.code} ${response.message}`);
          }
        }
      } else {
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          write('250 fake-smtp greets you');
        } else if (upper === 'DATA') {
          write('354 End data with <CR><LF>.<CR><LF>');
          inData = true;
        } else if (upper === 'QUIT') {
          write('221 Bye');
          socket.end();
        } else {
          // MAIL FROM / RCPT TO / anything else this fake doesn't script.
          write('250 OK');
        }
      }

      separatorIndex = buffer.indexOf('\r\n');
    }
  });
}

export function startFakeSmtpServer(response: FakeSmtpResponse): Promise<FakeSmtpServer> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => handleConnection(socket, response));
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('fake-smtp-server: unexpected server address shape'));
        return;
      }
      resolve({
        port: address.port,
        stop: () =>
          new Promise<void>((res) => {
            server.close(() => res());
          }),
      });
    });
  });
}
