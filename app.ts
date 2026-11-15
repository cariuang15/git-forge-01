// The server: one Node http server, in-memory store, four surfaces (git smart HTTP,
// REST v3, GraphQL v4, MCP). No dependencies, no git binary, no network beyond the
// suite. Auth: the trial's bearer token (MAKEFUN_SHOP_TOKEN) when it is set; any
// non-empty bearer when it is not (local practice only).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './src/store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/git.ts';
import { routeRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();
let requestCounter = 0;

function isAuthorized(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length);
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, extraHeaders: Record<string, string> = {}): void {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json',
    'x-github-request-id': requestId,
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...extraHeaders,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
  });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(raw: Buffer): { ok: true; value: Record<string, unknown> | null } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: null };
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return { ok: true, value: value as Record<string, unknown> };
    return { ok: true, value: null };
  } catch {
    return { ok: false };
  }
}

function decodeSegments(pathname: string): string[] | null {
  const parts = pathname.split('/').filter((part) => part !== '');
  const out: string[] = [];
  for (const part of parts) {
    try {
      out.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return out;
}

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = `gf-${(requestCounter += 1)}`;
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        const host = req.headers.host ?? '127.0.0.1';
        const base = `http://${host}`;

        // The env's boot probe: 200 {"ok":true}, no auth.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
        if (gitMatch !== null) {
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const suffix = gitMatch[3] ?? '';
          if (method === 'GET' && suffix === '/info/refs') {
            const service = url.searchParams.get('service') ?? '';
            const isV2 = req.headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
            const reply = handleInfoRefs(store, owner, repoName, service, isV2);
            sendBuffer(res, reply.status, reply.contentType, reply.body, requestId);
            return;
          }
          if (method === 'POST' && suffix === '/git-upload-pack') {
            const body = await readBody(req);
            const isV2 = req.headers['git-protocol'] === 'version=2';
            const reply = handleUploadPack(store, owner, repoName, body, isV2);
            sendBuffer(res, reply.status, reply.contentType, reply.body, requestId);
            return;
          }
          if (method === 'POST' && suffix === '/git-receive-pack') {
            const body = await readBody(req);
            const reply = handleReceivePack(store, owner, repoName, body);
            sendBuffer(res, reply.status, reply.contentType, reply.body, requestId);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // GraphQL v4.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          const body = await readBody(req);
          const reply = handleGraphQL(store, body);
          sendJson(res, reply.status, reply.body, requestId);
          return;
        }

        // MCP.
        if (pathname === '/mcp') {
          if (method === 'DELETE') {
            res.writeHead(204, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
            return;
          }
          if (!isAuthorized(req)) {
            sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, requestId);
            return;
          }
          const body = await readBody(req);
          const reply = handleMcp(store, body);
          if (reply.body === null) {
            res.writeHead(reply.status, { 'content-type': 'application/json', 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.body, requestId);
          return;
        }

        // REST v3.
        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          const segments = decodeSegments(pathname.slice('/api/v3'.length));
          if (segments === null) {
            sendJson(res, 400, { message: 'Bad Request' }, requestId);
            return;
          }
          // The API root and meta are public; everything else needs the token.
          const isPublic = segments.length === 0 || segments[0] === 'meta';
          if (!isPublic && !isAuthorized(req)) {
            sendJson(res, 401, { message: 'Requires authentication' }, requestId);
            return;
          }
          let body: Record<string, unknown> | null = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Malformed JSON body' }, requestId);
              return;
            }
            body = parsed.value;
          }
          const reply = routeRest(store, method, segments, url.searchParams, body, base);
          if (reply === null) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          sendJson(res, reply.status, reply.body, requestId, {
            'x-oauth-scopes': 'repo, read:org',
            ...(reply.headers ?? {}),
          });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (err) {
        process.stderr.write(`[gitforge] request error ${req.method} ${req.url ?? ''}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, requestId);
        } else {
          res.destroy();
        }
      }
    })();
  });
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`[gitforge] uncaught: ${err instanceof Error ? err.message : String(err)}\n`);
});
