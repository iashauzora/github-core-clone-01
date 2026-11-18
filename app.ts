// app.ts: the forge's HTTP surface — one in-memory store (store.ts) behind four faces:
// REST v3 (/api/v3), git smart HTTP (/{owner}/{repo}.git), GraphQL (/api/graphql) and MCP
// (/mcp). main.ts owns the lifecycle; this file owns routing, the bearer-token gate and the
// X-GitHub-Request-Id every reply carries.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGitHttp } from './githttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type Reply } from './rest.ts';
import { Forge } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${((requestCounter * 2654435761) % 0xffffffff).toString(16)}`;
}

function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  // Encode once into a Buffer: handing Node a string makes it re-encode on the
  // socket path (and byteLength would be a second full scan of the text).
  const payload = body === undefined ? EMPTY_BODY : Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': payload.length,
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(payload);
}

const EMPTY_BODY = Buffer.alloc(0);

function sendRaw(res: ServerResponse, requestId: string, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  // Plain data/end accumulation: the async-iterator protocol costs measurably
  // more per request, and most bodies here arrive as a single chunk anyway.
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Build the server. It binds nothing until the caller listens; main.ts binds the ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const expectedAuth = `Bearer ${token}`;

  const authed = (req: IncomingMessage): boolean => {
    if (token === '') return true; // local development without a configured token
    return req.headers.authorization === expectedAuth;
  };

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const requestId = nextRequestId();
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, requestId, 200, { ok: true });
          return;
        }

        const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        // ---- REST v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authed(req)) {
            sendJson(res, requestId, 401, { message: 'Requires authentication' });
            return;
          }
          let parsedBody: Record<string, unknown> | null = null;
          if (body.length > 0) {
            try {
              const parsed: unknown = JSON.parse(body.toString('utf8'));
              parsedBody = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
            } catch {
              sendJson(res, requestId, 400, { message: 'Malformed JSON in request body' });
              return;
            }
          }
          const segments = path
            .slice('/api/v3'.length)
            .split('/')
            .filter((segment) => segment !== '')
            .map(decodeSegment);
          const origin = `http://${req.headers.host ?? '127.0.0.1'}`;
          const reply: Reply = handleRest(forge, { method, segments, query: url.searchParams, body: parsedBody, origin, path });
          if (reply.body === undefined) {
            res.writeHead(reply.status, { 'x-github-request-id': requestId, ...reply.headers });
            res.end();
          } else {
            sendJson(res, requestId, reply.status, reply.body, reply.headers);
          }
          return;
        }

        // ---- GraphQL
        if (path === '/api/graphql') {
          if (!authed(req)) {
            sendJson(res, requestId, 401, { message: 'Requires authentication' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, requestId, 404, { message: 'Not Found' });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, requestId, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
            return;
          }
          if (Array.isArray(parsed)) {
            const results = parsed.map((entry) => executeGraphQL(forge, entry));
            sendJson(res, requestId, 200, results);
          } else {
            sendJson(res, requestId, 200, executeGraphQL(forge, parsed));
          }
          return;
        }

        // ---- MCP
        if (path === '/mcp') {
          if (!authed(req)) {
            sendJson(res, requestId, 401, { message: 'Requires authentication' });
            return;
          }
          const reply = handleMcp(forge, method, body.toString('utf8'));
          const headers: Record<string, string> = { 'x-github-request-id': requestId, ...reply.headers };
          if (reply.body === '') {
            res.writeHead(reply.status, headers);
            res.end();
          } else {
            res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(reply.body), ...headers });
            res.end(reply.body);
          }
          return;
        }

        // ---- git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
        if (gitMatch !== null) {
          if (!authed(req)) {
            sendJson(res, requestId, 401, { message: 'Requires authentication' });
            return;
          }
          const owner = decodeSegment(gitMatch[1]!);
          const repoName = decodeSegment(gitMatch[2]!);
          const sub = gitMatch[3] ?? '';
          const reply = handleGitHttp(forge, method, owner, repoName, sub, url.searchParams, req.headers['git-protocol'] ?? null, body);
          sendRaw(res, requestId, reply.status, reply.contentType, reply.body);
          return;
        }

        sendJson(res, requestId, 404, { message: 'Not Found' });
      } catch (err) {
        // A request must never take the server down with it.
        try {
          sendJson(res, requestId, 500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
        } catch {
          // the socket is already gone
        }
      }
    })();
  });
}
