import { createServer } from 'node:http';
import { once } from 'node:events';
import { getRequestListener } from '@hono/node-server';

export async function listen(
  fetch: (request: Request) => Response | Promise<Response>,
  port = 0,
) {
  const server = createServer(
    getRequestListener((request, env) => {
      // Derive from the actual socket, overwriting any caller-supplied value.
      request.headers.set(
        'x-pgstencil-client-ip',
        env.incoming.socket.remoteAddress ?? '127.0.0.1',
      );
      return fetch(request);
    }),
  );
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected a TCP address');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
