// The server: one in-memory store, four surfaces (git smart HTTP, REST v3, GraphQL v4,
// MCP). No dependencies, no git binary, no network beyond the suite. Auth: the trial's
// bearer token (MAKEFUN_SHOP_TOKEN) when it is set; any non-empty bearer when it is not
// (local practice only).
//
// Transport: a minimal HTTP/1.1 server over node:net, not node:http. The suite's
// workloads are thousands of small sequential requests, and node:http's per-request
// machinery (llhttp, IncomingMessage/ServerResponse objects, stream events) costs
// ~180 us of server CPU per request on this shape — more than the handlers themselves
// for the read/write/clone workloads. A hand-rolled parser that reads a request into
// {method, target, headers, body} and writes one pre-built response buffer costs
// ~50 us. The request handling below is a pure function of that parsed request, so
// the transport and the application logic stay separate and the conformance surface
// is unchanged: same routes, same statuses, same headers, same bodies.

import { createServer, type Server, type Socket } from 'node:net';
import { Store } from './src/store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './src/git.ts';
import { routeRest } from './src/rest.ts';
import { handleGraphQL } from './src/graphql.ts';
import { handleMcp } from './src/mcp.ts';

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const store = new Store();
let requestCounter = 0;

interface Reply {
  status: number;
  contentType: string;
  body: Buffer;
  extraHeaders?: Record<string, string>;
}

function jsonReply(status: number, body: unknown, requestId: string, extraHeaders: Record<string, string> = {}): Reply {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(text, 'utf8'),
    extraHeaders: { 'x-github-request-id': requestId, ...extraHeaders },
  };
}

function bufferReply(status: number, contentType: string, body: Buffer, requestId: string): Reply {
  return { status, contentType, body, extraHeaders: { 'x-github-request-id': requestId } };
}

function isAuthorized(headers: Record<string, string | undefined>): boolean {
  const auth = headers.authorization ?? '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice('Bearer '.length);
  if (token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
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
    // Most segments are plain ASCII: only decode when an escape is present.
    if (part.indexOf('%') < 0) {
      out.push(part);
      continue;
    }
    try {
      out.push(decodeURIComponent(part));
    } catch {
      return null;
    }
  }
  return out;
}

/**
 * The whole application: a pure function of the parsed request. Returns the reply
 * to write on the socket. Anything it throws becomes a 500, as the node:http
 * version's catch did.
 */
function handleRequest(
  method: string,
  pathname: string,
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
  base: string,
): Reply {
  const requestId = `gf-${(requestCounter += 1)}`;
  try {
    // The env's boot probe: 200 {"ok":true}, no auth.
    if (method === 'GET' && pathname === '/healthz') {
      return jsonReply(200, { ok: true }, requestId);
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
    if (gitMatch !== null) {
      if (!isAuthorized(headers)) {
        return jsonReply(401, { message: 'Requires authentication' }, requestId);
      }
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const suffix = gitMatch[3] ?? '';
      if (method === 'GET' && suffix === '/info/refs') {
        const service = query.get('service') ?? '';
        const isV2 = headers['git-protocol'] === 'version=2' && service === 'git-upload-pack';
        const reply = handleInfoRefs(store, owner, repoName, service, isV2);
        return bufferReply(reply.status, reply.contentType, reply.body, requestId);
      }
      if (method === 'POST' && suffix === '/git-upload-pack') {
        const isV2 = headers['git-protocol'] === 'version=2';
        const reply = handleUploadPack(store, owner, repoName, body, isV2);
        return bufferReply(reply.status, reply.contentType, reply.body, requestId);
      }
      if (method === 'POST' && suffix === '/git-receive-pack') {
        const reply = handleReceivePack(store, owner, repoName, body);
        return bufferReply(reply.status, reply.contentType, reply.body, requestId);
      }
      return jsonReply(404, { message: 'Not Found' }, requestId);
    }

    // GraphQL v4.
    if (pathname === '/api/graphql') {
      if (method !== 'POST') {
        return jsonReply(404, { message: 'Not Found' }, requestId);
      }
      if (!isAuthorized(headers)) {
        return jsonReply(401, { message: 'Requires authentication' }, requestId);
      }
      const reply = handleGraphQL(store, body);
      return jsonReply(reply.status, reply.body, requestId);
    }

    // MCP.
    if (pathname === '/mcp') {
      if (method === 'DELETE') {
        return { status: 204, contentType: 'application/json', body: Buffer.alloc(0), extraHeaders: { 'x-github-request-id': requestId } };
      }
      if (method !== 'POST') {
        return jsonReply(405, { message: 'Method Not Allowed' }, requestId);
      }
      if (!isAuthorized(headers)) {
        return jsonReply(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, requestId);
      }
      const reply = handleMcp(store, body);
      if (reply.body === null) {
        return { status: reply.status, contentType: 'application/json', body: Buffer.alloc(0), extraHeaders: { 'x-github-request-id': requestId } };
      }
      return jsonReply(reply.status, reply.body, requestId);
    }

    // REST v3.
    if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
      const segments = decodeSegments(pathname.slice('/api/v3'.length));
      if (segments === null) {
        return jsonReply(400, { message: 'Bad Request' }, requestId);
      }
      // The API root and meta are public; everything else needs the token.
      const isPublic = segments.length === 0 || segments[0] === 'meta';
      if (!isPublic && !isAuthorized(headers)) {
        return jsonReply(401, { message: 'Requires authentication' }, requestId);
      }
      let parsedBody: Record<string, unknown> | null = null;
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          return jsonReply(400, { message: 'Malformed JSON body' }, requestId);
        }
        parsedBody = parsed.value;
      }
      const reply = routeRest(store, method, segments, query, parsedBody, base);
      if (reply === null) {
        return jsonReply(404, { message: 'Not Found' }, requestId);
      }
      return jsonReply(reply.status, reply.body, requestId, {
        'x-oauth-scopes': 'repo, read:org',
        ...(reply.headers ?? {}),
      });
    }

    return jsonReply(404, { message: 'Not Found' }, requestId);
  } catch (err) {
    process.stderr.write(`[gitforge] request error ${method} ${pathname}: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    return jsonReply(500, { message: err instanceof Error ? err.message : 'Internal Server Error' }, requestId);
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP/1.1 transport over node:net
// ---------------------------------------------------------------------------------------------

const REASONS: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

/** Split a request target into pathname and a lazily-built query (parsed only when used). */
function splitTarget(target: string): { pathname: string; query: URLSearchParams } {
  // Absolute-form targets (http://host/path) are rare; normalize them to origin-form.
  let path = target;
  if (path.startsWith('http://') || path.startsWith('https://')) {
    const slash = path.indexOf('/', path.indexOf('://') + 3);
    path = slash < 0 ? '/' : path.slice(slash);
  }
  const q = path.indexOf('?');
  const pathname = q < 0 ? path : path.slice(0, q);
  const query = q < 0 ? new URLSearchParams() : new URLSearchParams(path.slice(q + 1));
  return { pathname, query };
}

/** De-chunk a chunked request body; returns null when the framing is malformed. */
function dechunk(buf: Buffer): Buffer | null {
  const parts: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const lineEnd = buf.indexOf('\r\n', offset);
    if (lineEnd < 0) return null;
    const sizeText = buf.subarray(offset, lineEnd).toString('latin1').split(';', 1)[0]!.trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return null;
    const size = parseInt(sizeText, 16);
    const dataStart = lineEnd + 2;
    if (dataStart + size + 2 > buf.length) return null;
    if (size === 0) return Buffer.concat(parts);
    parts.push(buf.subarray(dataStart, dataStart + size));
    offset = dataStart + size + 2;
  }
}

interface ParsedRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  body: Buffer;
  /** Bytes consumed from the connection buffer (request line + headers + body). */
  consumed: number;
  /** Whether the client asked to close after this response. */
  close: boolean;
}

/**
 * Parse one complete request from the front of `buf`, or null when more bytes are
 * needed. Throws on malformed framing (the caller answers 400 and closes).
 */
function parseRequest(buf: Buffer): ParsedRequest | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    if (buf.length > 64 * 1024) throw new Error('request head too large');
    return null;
  }
  const head = buf.subarray(0, headEnd).toString('latin1');
  const lines = head.split('\r\n');
  const requestLine = lines[0] ?? '';
  const match = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(requestLine);
  if (match === null) throw new Error('malformed request line');
  const method = match[1]!;
  const target = match[2]!;
  const headers: Record<string, string | undefined> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('malformed header');
    headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const connection = (headers.connection ?? '').toLowerCase();
  const close = connection === 'close';
  const transferEncoding = (headers['transfer-encoding'] ?? '').toLowerCase();
  const chunked = transferEncoding.includes('chunked');
  const contentLength = Number(headers['content-length'] ?? '0');
  if (!chunked && (!Number.isFinite(contentLength) || contentLength < 0)) throw new Error('malformed content-length');
  if (!chunked && contentLength > MAX_BODY_BYTES) throw new Error('request body too large');
  const bodyStart = headEnd + 4;
  let body: Buffer;
  let consumed: number;
  if (chunked) {
    const dechunked = dechunk(buf.subarray(bodyStart));
    if (dechunked === null) return null;
    if (dechunked.length > MAX_BODY_BYTES) throw new Error('request body too large');
    body = dechunked;
    // De-chunking consumes through the terminating 0-chunk and its CRLF; recompute
    // the consumed length by walking the chunks again.
    let offset = bodyStart;
    for (;;) {
      const lineEnd = buf.indexOf('\r\n', offset);
      const size = parseInt(buf.subarray(offset, lineEnd).toString('latin1').split(';', 1)[0]!.trim(), 16);
      offset = lineEnd + 2 + size + 2;
      if (size === 0) break;
    }
    // Trailers (if any) run to the next blank line.
    const trailerEnd = buf.indexOf('\r\n', offset);
    consumed = trailerEnd < 0 ? offset : trailerEnd + 2;
  } else {
    if (buf.length < bodyStart + contentLength) return null;
    body = buf.subarray(bodyStart, bodyStart + contentLength);
    consumed = bodyStart + contentLength;
  }
  const { pathname, query } = splitTarget(target);
  return { method, pathname, query, headers, body, consumed, close };
}

function writeReply(socket: Socket, reply: Reply, close: boolean): void {
  const reason = REASONS[reply.status] ?? '';
  const headParts: string[] = [`HTTP/1.1 ${reply.status} ${reason}\r\n`];
  headParts.push(`content-type: ${reply.contentType}\r\n`);
  if (reply.body.length > 0) headParts.push(`content-length: ${reply.body.length}\r\n`);
  for (const [name, value] of Object.entries(reply.extraHeaders ?? {})) {
    headParts.push(`${name}: ${value}\r\n`);
  }
  headParts.push(close ? 'connection: close\r\n' : 'connection: keep-alive\r\n');
  headParts.push('\r\n');
  const head = Buffer.from(headParts.join(''), 'latin1');
  socket.write(reply.body.length > 0 ? Buffer.concat([head, reply.body]) : head);
  if (close) socket.end();
}

export function createApp(): Server {
  const server = createServer((socket: Socket) => {
    let buf = Buffer.alloc(0);
    // Whether a 100 Continue was already sent for the request now being read.
    let sentContinue = false;
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      // Process every complete request already buffered (pipelining-safe).
      for (;;) {
        let parsed: ParsedRequest | null;
        try {
          parsed = parseRequest(buf);
        } catch {
          const requestId = `gf-${(requestCounter += 1)}`;
          const reply = jsonReply(400, { message: 'Bad Request' }, requestId);
          writeReply(socket, reply, true);
          socket.destroy();
          return;
        }
        if (parsed === null) {
          // The head may be complete while the body is still in flight; a
          // client that sent `Expect: 100-continue` (real git/curl do for
          // larger bodies) waits for the 100 before sending it, so answer now.
          if (!sentContinue) {
            const headEnd = buf.indexOf('\r\n\r\n');
            if (headEnd >= 0 && /^expect:\s*100-continue$/m.test(buf.subarray(0, headEnd).toString('latin1').toLowerCase())) {
              socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'));
              sentContinue = true;
            }
          }
          return;
        }
        buf = buf.subarray(parsed.consumed);
        sentContinue = false;
        const host = parsed.headers.host ?? '127.0.0.1';
        const base = `http://${host}`;
        const reply = handleRequest(parsed.method, parsed.pathname, parsed.query, parsed.headers, parsed.body, base);
        writeReply(socket, reply, parsed.close);
        if (parsed.close) return;
        if (buf.length === 0) return;
      }
    });
    socket.on('error', () => undefined);
  });
  return server;
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`[gitforge] uncaught: ${err instanceof Error ? err.message : String(err)}\n`);
});
