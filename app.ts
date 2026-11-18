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
  /** Prebuilt extra header lines (each ending in \r\n), e.g. the request id. */
  extra?: string;
}

function jsonReply(status: number, body: unknown, requestId: string, extra = ''): Reply {
  const text = body === null ? '' : `${JSON.stringify(body)}\n`;
  return {
    status,
    contentType: 'application/json',
    body: Buffer.from(text, 'utf8'),
    extra: `x-github-request-id: ${requestId}\r\n${extra}`,
  };
}

function bufferReply(status: number, contentType: string, body: Buffer, requestId: string): Reply {
  return { status, contentType, body, extra: `x-github-request-id: ${requestId}\r\n` };
}

function isAuthorized(authorization: string | undefined): boolean {
  const auth = authorization ?? '';
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
  head: ParsedHead,
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
    // Fast path: a git path always contains ".git/" or ends in ".git"; REST and
    // GraphQL paths never do, so they skip the regex entirely.
    const gitMatch =
      pathname.indexOf('.git') < 0 ? null : /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
    if (gitMatch !== null) {
      if (!isAuthorized(head.authorization)) {
        return jsonReply(401, { message: 'Requires authentication' }, requestId);
      }
      const owner = decodeURIComponent(gitMatch[1]!);
      const repoName = decodeURIComponent(gitMatch[2]!);
      const suffix = gitMatch[3] ?? '';
      if (method === 'GET' && suffix === '/info/refs') {
        const service = query.get('service') ?? '';
        const isV2 = head.gitProtocol === 'version=2' && service === 'git-upload-pack';
        const reply = handleInfoRefs(store, owner, repoName, service, isV2);
        return bufferReply(reply.status, reply.contentType, reply.body, requestId);
      }
      if (method === 'POST' && suffix === '/git-upload-pack') {
        const isV2 = head.gitProtocol === 'version=2';
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
      if (!isAuthorized(head.authorization)) {
        return jsonReply(401, { message: 'Requires authentication' }, requestId);
      }
      const reply = handleGraphQL(store, body);
      return jsonReply(reply.status, reply.body, requestId);
    }

    // MCP.
    if (pathname === '/mcp') {
      if (method === 'DELETE') {
        return { status: 204, contentType: 'application/json', body: Buffer.alloc(0), extra: `x-github-request-id: ${requestId}\r\n` };
      }
      if (method !== 'POST') {
        return jsonReply(405, { message: 'Method Not Allowed' }, requestId);
      }
      if (!isAuthorized(head.authorization)) {
        return jsonReply(401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, requestId);
      }
      const reply = handleMcp(store, body);
      if (reply.body === null) {
        return { status: reply.status, contentType: 'application/json', body: Buffer.alloc(0), extra: `x-github-request-id: ${requestId}\r\n` };
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
      if (!isPublic && !isAuthorized(head.authorization)) {
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
      // The API root carries x-oauth-scopes in its own headers; every other REST
      // reply gets the default. Emit it exactly once, with the root's own value.
      let extra = '';
      const scopes = reply.headers?.['x-oauth-scopes'];
      extra += `x-oauth-scopes: ${scopes ?? 'repo, read:org'}\r\n`;
      const link = reply.headers?.link;
      if (link !== undefined) extra += `link: ${link}\r\n`;
      return jsonReply(reply.status, reply.body, requestId, extra);
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

/** De-chunk a chunked request body. Returns the body and the bytes the chunked
 * encoding consumed, or null when more data is needed (a malformed chunk also reads
 * as null, so the connection waits, as the old parser did). */
function dechunk(buf: Buffer): { body: Buffer; consumed: number } | null {
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
    if (size === 0) {
      // Trailers (if any) run to the next blank line.
      if (dataStart + 2 <= buf.length && buf[dataStart] === 0x0d && buf[dataStart + 1] === 0x0a) {
        return { body: Buffer.concat(parts), consumed: dataStart + 2 };
      }
      const trailerEnd = buf.indexOf('\r\n\r\n', dataStart);
      if (trailerEnd < 0) return null;
      return { body: Buffer.concat(parts), consumed: trailerEnd + 4 };
    }
    parts.push(buf.subarray(dataStart, dataStart + size));
    offset = dataStart + size + 2;
  }
}

/** A parsed request head: only the headers the app reads are extracted. */
interface ParsedHead {
  method: string;
  pathname: string;
  query: URLSearchParams;
  authorization: string | undefined;
  gitProtocol: string | undefined;
  host: string | undefined;
  contentLength: number;
  chunked: boolean;
  close: boolean;
  expectContinue: boolean;
  /** Offset in the connection buffer where the body starts. */
  bodyStart: number;
}

/**
 * Parse a request head (request line + headers) from buf[0..headEnd). The head is
 * scanned with Buffer.indexOf, never turned into one string, and only the headers
 * the app reads are turned into small strings; the rest are skipped by index
 * arithmetic. Throws on malformed framing.
 */
function parseHead(buf: Buffer, headEnd: number): ParsedHead {
  const lineEnd = buf.indexOf('\r\n', 0);
  if (lineEnd < 0) throw new Error('malformed request line');
  const sp1 = buf.indexOf(0x20, 0);
  if (sp1 < 0 || sp1 >= lineEnd) throw new Error('malformed request line');
  const sp2 = buf.indexOf(0x20, sp1 + 1);
  if (sp2 < 0 || sp2 >= lineEnd) throw new Error('malformed request line');
  const method = buf.subarray(0, sp1).toString('latin1');
  const target = buf.subarray(sp1 + 1, sp2).toString('latin1');
  const version = buf.subarray(sp2 + 1, lineEnd).toString('latin1');
  if (!/^[A-Z]+$/.test(method) || target.length === 0 || (version !== 'HTTP/1.0' && version !== 'HTTP/1.1')) {
    throw new Error('malformed request line');
  }
  let authorization: string | undefined;
  let gitProtocol: string | undefined;
  let host: string | undefined;
  let contentLength = 0;
  let chunked = false;
  let close = false;
  let expectContinue = false;
  let pos = lineEnd + 2;
  while (pos < headEnd) {
    const eol = buf.indexOf('\r\n', pos);
    if (eol < 0 || eol > headEnd) throw new Error('malformed header');
    const colon = buf.indexOf(0x3a, pos);
    if (colon <= pos || colon >= eol) throw new Error('malformed header');
    const name = buf.subarray(pos, colon).toString('latin1').trim().toLowerCase();
    const value = buf.subarray(colon + 1, eol).toString('latin1').trim();
    switch (name) {
      case 'authorization':
        authorization = value;
        break;
      case 'git-protocol':
        gitProtocol = value;
        break;
      case 'host':
        host = value;
        break;
      case 'content-length': {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) throw new Error('malformed content-length');
        contentLength = n;
        break;
      }
      case 'transfer-encoding':
        if (value.toLowerCase().includes('chunked')) chunked = true;
        break;
      case 'connection':
        if (value.toLowerCase() === 'close') close = true;
        break;
      case 'expect':
        if (value.toLowerCase() === '100-continue') expectContinue = true;
        break;
      default:
        break;
    }
    pos = eol + 2;
  }
  if (!chunked && contentLength > MAX_BODY_BYTES) throw new Error('request body too large');
  const { pathname, query } = splitTarget(target);
  return { method, pathname, query, authorization, gitProtocol, host, contentLength, chunked, close, expectContinue, bodyStart: headEnd + 4 };
}

function writeReply(socket: Socket, reply: Reply, close: boolean): void {
  const reason = REASONS[reply.status] ?? '';
  // One string, one Buffer: no head-parts array, no Object.entries over headers.
  const head =
    `HTTP/1.1 ${reply.status} ${reason}\r\n` +
    `content-type: ${reply.contentType}\r\n` +
    (reply.body.length > 0 ? `content-length: ${reply.body.length}\r\n` : '') +
    (reply.extra ?? '') +
    (close ? 'connection: close\r\n' : 'connection: keep-alive\r\n') +
    '\r\n';
  const headBuf = Buffer.from(head, 'latin1');
  socket.write(reply.body.length > 0 ? Buffer.concat([headBuf, reply.body]) : headBuf);
  if (close) socket.end();
}

export function createApp(): Server {
  const server = createServer((socket: Socket) => {
    let buf = Buffer.alloc(0);
    // The head of the request now being read (parsed once; the body may still
    // be in flight, so the head is NOT re-parsed when the next chunk arrives).
    let pendingHead: ParsedHead | null = null;
    // Whether a 100 Continue was already sent for the request now being read.
    let sentContinue = false;
    socket.on('data', (chunk: Buffer) => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      // Process every complete request already buffered (pipelining-safe).
      for (;;) {
        if (pendingHead === null) {
          const headEnd = buf.indexOf('\r\n\r\n');
          if (headEnd < 0) {
            if (buf.length > 64 * 1024) {
              const requestId = `gf-${(requestCounter += 1)}`;
              writeReply(socket, jsonReply(400, { message: 'Bad Request' }, requestId), true);
              socket.destroy();
            }
            return;
          }
          try {
            pendingHead = parseHead(buf, headEnd);
          } catch {
            const requestId = `gf-${(requestCounter += 1)}`;
            writeReply(socket, jsonReply(400, { message: 'Bad Request' }, requestId), true);
            socket.destroy();
            return;
          }
          sentContinue = false;
        }
        const head = pendingHead;
        let body: Buffer;
        let consumed: number;
        if (head.chunked) {
          const d = dechunk(buf.subarray(head.bodyStart));
          if (d === null) {
            // The head is complete while the body is still in flight; a client
            // that sent `Expect: 100-continue` waits for the 100 before sending
            // it, so answer now.
            if (head.expectContinue && !sentContinue) {
              socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'));
              sentContinue = true;
            }
            return;
          }
          if (d.body.length > MAX_BODY_BYTES) {
            const requestId = `gf-${(requestCounter += 1)}`;
            writeReply(socket, jsonReply(400, { message: 'Bad Request' }, requestId), true);
            socket.destroy();
            return;
          }
          body = d.body;
          consumed = head.bodyStart + d.consumed;
        } else {
          if (buf.length < head.bodyStart + head.contentLength) {
            if (head.expectContinue && !sentContinue) {
              socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'latin1'));
              sentContinue = true;
            }
            return;
          }
          body = buf.subarray(head.bodyStart, head.bodyStart + head.contentLength);
          consumed = head.bodyStart + head.contentLength;
        }
        pendingHead = null;
        sentContinue = false;
        buf = buf.subarray(consumed);
        const base = `http://${head.host ?? '127.0.0.1'}`;
        const reply = handleRequest(head.method, head.pathname, head.query, head, body, base);
        writeReply(socket, reply, head.close);
        if (head.close) return;
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
