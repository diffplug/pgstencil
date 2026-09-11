import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAuthFetch } from './fetch.ts';
import { HttpError } from './http-error.ts';
export { HttpError } from './http-error.ts';
export type { SessionView, AuthState } from './fetch.ts';
export async function readBody(
  req: IncomingMessage,
  limit = 8192,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request too large.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
export async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json')
    throw new HttpError(415, 'Send JSON.');
  try {
    const value: unknown = JSON.parse((await readBody(req)).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error();
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Invalid JSON.');
  }
}
export function sendJson(res: ServerResponse, value: unknown, status = 200) {
  res
    .writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    .end(JSON.stringify(value));
}

/** Node bridge; Hono/Workers use the same security decisions through the Fetch adapter. */
export function createAuthHttp(
  options: Omit<Parameters<typeof createAuthFetch>[0], 'clientAddress'> & {
    clientAddress?: (req: IncomingMessage) => string;
  },
) {
  const sources = new WeakMap<Request, string>();
  const api = createAuthFetch({
    ...options,
    clientAddress: (req) => sources.get(req) ?? 'unknown',
  });
  function request(req: IncomingMessage, body?: Buffer) {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (Array.isArray(value))
        for (const item of value) headers.append(key, item);
      else if (value !== undefined) headers.set(key, value);
    }
    const value = new Request(
      new URL(req.url ?? '/', options.auth.deps.origin),
      {
        method: req.method ?? 'GET',
        headers,
        ...(body ? { body: new Uint8Array(body) } : {}),
      },
    );
    sources.set(
      value,
      options.clientAddress?.(req) ?? req.socket.remoteAddress ?? 'unknown',
    );
    return value;
  }
  return {
    names: api.names,
    session: (req: IncomingMessage) => api.session(request(req)),
    authorize: (req: IncomingMessage, allowPending = false) =>
      api.authorize(request(req), allowPending),
    checkOrigin: (req: IncomingMessage) => api.checkOrigin(request(req)),
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      const path = new URL(req.url ?? '/', options.auth.deps.origin).pathname;
      if (
        !path.startsWith('/api/auth/') &&
        path !== '/login/link' &&
        !/^\/oauth\/[^/]+\/callback$/.test(path)
      )
        return false;
      const response = await api.handle(
        request(req, req.method === 'POST' ? await readBody(req) : undefined),
      );
      if (!response) return false;
      res.statusCode = response.status;
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') res.setHeader(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
      return true;
    },
  };
}
