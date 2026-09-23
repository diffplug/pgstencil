import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  getRequestListener,
  type Http2Bindings,
  type HttpBindings,
} from '@hono/node-server';

export async function listen(
  fetch: (
    request: Request,
    env: HttpBindings | Http2Bindings,
  ) => Response | Promise<Response>,
  port = 0,
) {
  // createAuthApp reads the client IP from env.incoming's socket.
  const server = createServer(getRequestListener(fetch));
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
