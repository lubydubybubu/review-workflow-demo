import http from 'node:http';
import { Readable } from 'node:stream';

/**
 * BACKEND ROUTE ADAPTER (test-only, P-M001 replay). Not a Next.js server and not a browser deployment.
 *
 * A loopback-only node:http listener that turns each request into a Web `Request` (raw headers kept
 * as sent, Host included; body streamed, never pre-read) and hands it to the route handler it was
 * given — the unmodified `POST` export of src/app/api/ingest/mail-candidates/route.ts — then writes the
 * handler's `Response` back unchanged. It adds no auth, no parsing and no checks of its own. Not covered:
 * Next middleware/proxy, the peer-address preload (so OPS_INGEST_ALLOWED_CIDRS is not exercised).
 */

export const ADAPTER_KIND = 'backend-route-adapter (not Next/browser deployment)';

export type RouteHandler = (request: Request) => Promise<Response>;

export interface Exchange {
  method: string;
  path: string;
  status: number;
  body: unknown;
}

export interface RouteAdapter {
  port: number;
  handler: RouteHandler | null;
  /** every request/response pair, in order (response bodies are the route's own fixed JSON) */
  exchanges: Exchange[];
  close(): Promise<void>;
}

function parseBody(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
}

export function startRouteAdapter(handler: RouteHandler, routePath: string, port: number): Promise<RouteAdapter> {
  const exchanges: Exchange[] = [];

  async function forward(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    let status: number;
    let headers: [string, string][] = [['content-type', 'application/json']];
    let bytes: Buffer;
    if (url.pathname !== routePath) {
      status = 404;
      bytes = Buffer.from('{"error":"not_found"}');
    } else if (req.method !== 'POST') {
      status = 405;
      bytes = Buffer.from('{"error":"method_not_allowed"}');
    } else {
      const forwarded = new Headers();
      for (let i = 0; i < req.rawHeaders.length; i += 2) forwarded.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
      const request = new Request(url, {
        method: 'POST',
        headers: forwarded,
        body: Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>,
        duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      try {
        const response = await handler(request);
        status = response.status;
        headers = [...response.headers.entries()];
        bytes = Buffer.from(await response.arrayBuffer());
      } catch {
        status = 500;
        bytes = Buffer.from('{"error":"adapter_handler_threw"}');
      }
    }
    exchanges.push({ method: req.method ?? '', path: url.pathname, status, body: parseBody(bytes) });
    if (!req.complete) req.resume(); // the route may stop reading an oversized body; drain the rest
    res.writeHead(status, headers).end(bytes);
  }

  const server = http.createServer((req, res) => void forward(req, res));
  return new Promise((resolve, reject) => {
    // a fixed, task-owned port: a busy port is refused, never replaced by another one
    server.once('error', (error: NodeJS.ErrnoException) =>
      reject(error.code === 'EADDRINUSE' ? new Error(`refusing busy port ${port}`) : error),
    );
    server.listen(port, '127.0.0.1', () =>
      resolve({ port, handler, exchanges, close: () => new Promise((done) => server.close(() => done())) }),
    );
  });
}
