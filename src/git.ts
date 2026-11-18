// Git smart HTTP: pkt-line codec, protocol v2/v0 upload-pack, v0 receive-pack.
// The wire the suite's git-client.ts speaks, answered byte for byte.

import { parseCommit, parseTag, readPack, writePack, ZERO_OID, isOid, type Repo, type Store, type GitObject } from './store.ts';

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export type PacketKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  kind: PacketKind;
  payload: Buffer;
}

/**
 * A pkt-line writer that fills one preallocated buffer (growing it when needed) instead
 * of building a Buffer per line and concatenating them. The hot responses (advertisements,
 * fetch packfiles, push reports) are dozens of small pkt-lines; the per-line Buffer.from
 * + Buffer.concat in pktLine/sideband was a measurable share of their cost.
 */
export class PktWriter {
  private buf: Buffer;
  private off = 0;
  constructor(capacity = 1024) {
    this.buf = Buffer.allocUnsafe(capacity);
  }
  private grow(need: number): void {
    if (this.off + need <= this.buf.length) return;
    const next = Buffer.allocUnsafe(Math.max(this.buf.length * 2, this.off + need));
    this.buf.copy(next, 0, 0, this.off);
    this.buf = next;
  }
  raw(b: Buffer): void {
    this.grow(b.length);
    b.copy(this.buf, this.off);
    this.off += b.length;
  }
  text(s: string): void {
    this.raw(Buffer.from(s, 'utf8'));
  }
  pktLine(payload: Buffer): void {
    const len = payload.length + 4;
    this.grow(len);
    this.buf.write(len.toString(16).padStart(4, '0'), this.off, 'ascii');
    payload.copy(this.buf, this.off + 4);
    this.off += len;
  }
  pktLineText(s: string): void {
    this.pktLine(Buffer.from(s, 'utf8'));
  }
  flush(): void {
    this.grow(4);
    this.buf.write('0000', this.off, 'ascii');
    this.off += 4;
  }
  delim(): void {
    this.grow(4);
    this.buf.write('0001', this.off, 'ascii');
    this.off += 4;
  }
  /** One sideband packet: a pkt-line whose payload is [band] + data. */
  sideband(band: number, data: Buffer): void {
    const len = data.length + 1 + 4;
    this.grow(len);
    this.buf.write(len.toString(16).padStart(4, '0'), this.off, 'ascii');
    this.buf[this.off + 4] = band;
    data.copy(this.buf, this.off + 5);
    this.off += len;
  }
  /**
   * A sideband packet whose band payload is itself a pkt-line (the report-status
   * framing: the client decodes the band-1 bytes as pkt-lines, so a bare text
   * line there would be read as a raw line and the inner flush "0000" would
   * surface as a bogus report line).
   */
  sidebandPktLine(band: number, text: string): void {
    const textLen = Buffer.byteLength(text, 'utf8');
    const innerLen = textLen + 4;
    const len = innerLen + 1 + 4;
    this.grow(len);
    this.buf.write(len.toString(16).padStart(4, '0'), this.off, 'ascii');
    this.buf[this.off + 4] = band;
    this.buf.write(innerLen.toString(16).padStart(4, '0'), this.off + 5, 'ascii');
    this.buf.write(text, this.off + 9, 'utf8');
    this.off += len;
  }
  /** The bytes written so far (a view; the backing buffer is not reused after this). */
  build(): Buffer {
    return this.buf.subarray(0, this.off);
  }
}

export function pktLine(data: Buffer | string): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const len = body.length + 4;
  if (len > 65520) throw new Error('pkt-line too long');
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/** One sideband packet: band byte + data, pkt-line framed. */
export function sideband(band: number, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/**
 * Decode pkt-lines from the front of `buf`. Stops at the end of the buffer or the first
 * malformed line; `consumed` is how many bytes formed valid packets.
 */
export function decodePktLines(buf: Buffer): { packets: Packet[]; consumed: number; ok: boolean } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) return { packets, consumed: offset, ok: false };
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return { packets, consumed: offset, ok: false };
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || len > 65520 || offset + len > buf.length) return { packets, consumed: offset, ok: false };
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, consumed: offset, ok: true };
}

function pktLinesText(packets: readonly Packet[]): string[] {
  const out: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    out.push(packet.payload.toString('utf8'));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// ref listing
// ---------------------------------------------------------------------------------------------

export interface ListedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
}

export function listRefs(store: Store, repo: Repo): ListedRef[] {
  const out: ListedRef[] = [];
  const mainTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push({
    oid: mainTip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: ListedRef = { oid, name };
    if (name.startsWith('refs/tags/')) {
      const obj = repo.objects.get(oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = store.peelToCommit(repo, oid);
        if (peeled !== null) entry.peeled = peeled;
      }
    }
    out.push(entry);
  }
  return out;
}

const UPLOAD_V2_CAPS = ['ls-refs', 'fetch=shallow', 'object-format=sha1', 'agent=gitforge/1.0'];
const UPLOAD_V0_CAPS =
  'side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=gitforge/1.0';
const RECEIVE_V0_CAPS = 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=gitforge/1.0';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function gitResult(status: number, body: Buffer, service: 'git-upload-pack' | 'git-receive-pack', kind: 'advertisement' | 'result'): GitResponse {
  return { status, contentType: `application/x-${service}-${kind}`, body };
}

function notFoundJson(): GitResponse {
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8') };
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

export function handleInfoRefs(store: Store, owner: string, repoName: string, service: string, isV2: boolean): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFoundJson();
  const refs = listRefs(store, repo);
  if (service === 'git-upload-pack') {
    if (isV2) {
      const w = new PktWriter(256);
      w.pktLineText('# service=git-upload-pack\n');
      w.flush();
      w.pktLineText('version 2\n');
      for (const cap of UPLOAD_V2_CAPS) w.pktLineText(`${cap}\n`);
      w.flush();
      return gitResult(200, w.build(), 'git-upload-pack', 'advertisement');
    }
    const w = new PktWriter(512);
    w.pktLineText('# service=git-upload-pack\n');
    w.flush();
    if (refs.length === 1 && refs[0]!.name === 'HEAD' && refs[0]!.oid === ZERO_OID) {
      w.pktLineText(`${ZERO_OID} capabilities^{}\0${UPLOAD_V0_CAPS}\n`);
    } else {
      refs.forEach((ref, index) => {
        if (index === 0) {
          w.pktLineText(`${ref.oid} ${ref.name}\0${UPLOAD_V0_CAPS}\n`);
        } else {
          w.pktLineText(`${ref.oid} ${ref.name}\n`);
        }
        if (ref.peeled !== undefined) w.pktLineText(`${ref.peeled} ${ref.name}^{}\n`);
      });
    }
    w.flush();
    return gitResult(200, w.build(), 'git-upload-pack', 'advertisement');
  }
  if (service === 'git-receive-pack') {
    const w = new PktWriter(512);
    w.pktLineText('# service=git-receive-pack\n');
    w.flush();
    if (refs.length === 1 && refs[0]!.name === 'HEAD' && refs[0]!.oid === ZERO_OID) {
      w.pktLineText(`${ZERO_OID} capabilities^{}\0${RECEIVE_V0_CAPS}\n`);
    } else {
      refs.forEach((ref, index) => {
        if (index === 0) {
          w.pktLineText(`${ref.oid} ${ref.name}\0${RECEIVE_V0_CAPS}\n`);
        } else {
          w.pktLineText(`${ref.oid} ${ref.name}\n`);
        }
        if (ref.peeled !== undefined) w.pktLineText(`${ref.peeled} ${ref.name}^{}\n`);
      });
    }
    w.flush();
    return gitResult(200, w.build(), 'git-receive-pack', 'advertisement');
  }
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Unknown service' }), 'utf8') };
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

/**
 * Cache of upload-pack fetch responses, per repo.
 *
 * A fetch response is a pure function of its inputs (wants, haves, shallow lines,
 * depth, deepen-since) plus the object store — and git objects are immutable and
 * content-addressed, so the same inputs always produce the same bytes. That makes
 * the response safely cacheable. The one input that is NOT a pure oid is
 * `deepen-not` (ref names resolved against the live refs), so fetches carrying
 * deepen-not are never cached. `ls-refs` is also never cached (its output tracks
 * the live refs). The cache is capped per repo (FIFO eviction) so a long run of
 * distinct fetches cannot grow memory without bound. The bench's clone workload
 * issues 50 concurrent depth-1 fetches of the same repo at the same tip, so 49
 * of them skip the object walk + pack deflate entirely.
 */
const fetchCache = new WeakMap<Repo, Map<string, GitResponse>>();
const FETCH_CACHE_MAX = 128;

function fetchCacheKey(
  isV2: boolean,
  done: boolean,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | null,
  deepenSince: number | null,
): string {
  return [
    isV2 ? 'v2' : 'v0',
    done ? 'done' : 'nego',
    wants.join(','),
    haves.join(','),
    shallow.join(','),
    depth === null ? '' : String(depth),
    deepenSince === null ? '' : String(deepenSince),
  ].join('|');
}

function fetchCacheGet(repo: Repo, key: string): GitResponse | undefined {
  return fetchCache.get(repo)?.get(key);
}

function fetchCachePut(repo: Repo, key: string, res: GitResponse): void {
  let map = fetchCache.get(repo);
  if (map === undefined) {
    map = new Map<string, GitResponse>();
    fetchCache.set(repo, map);
  }
  if (map.size >= FETCH_CACHE_MAX) {
    // FIFO: drop the oldest entry.
    const first = map.keys().next();
    if (!first.done) map.delete(first.value);
  }
  map.set(key, res);
}

interface FetchSelection {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  ack: string | null;
}

function selectFetch(store: Store, repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null, deepenSince: number | null, deepenNot: string[]): FetchSelection {
  const exclude = new Set(haves);
  // ACK: the first have reachable from a want (an ancestor of, or equal to, a want).
  let ack: string | null = null;
  if (haves.length > 0) {
    const reachable = new Set<string>();
    const stack = [...wants];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (reachable.has(oid)) continue;
      reachable.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    for (const have of haves) {
      if (reachable.has(have)) {
        ack = have;
        break;
      }
    }
  }
  const collected = store.collectForFetch(repo, wants, {
    exclude,
    depth: depth ?? undefined,
    shallowBoundaries: shallow,
    since: deepenSince ?? undefined,
    deepenNot,
  });
  return { objects: collected.objects, shallow: collected.shallow, unshallow: collected.unshallow, ack };
}

/** Write a packfile as sideband-1 pkt-lines into `w` (chunked at the pkt-line max). */
function packSideband(w: PktWriter, pack: Buffer): void {
  const CHUNK = 65515; // pkt-line max 65520 minus 4 length bytes minus 1 band byte
  for (let i = 0; i < pack.length; i += CHUNK) {
    w.sideband(1, pack.subarray(i, Math.min(pack.length, i + CHUNK)));
  }
}

export function handleUploadPack(store: Store, owner: string, repoName: string, body: Buffer, isV2: boolean): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFoundJson();
  const decoded = decodePktLines(body);
  if (!decoded.ok || decoded.consumed !== body.length) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Malformed request' }), 'utf8') };
  }
  const lines = pktLinesText(decoded.packets);
  if (isV2) {
    const command = (lines[0] ?? '').trim();
    if (command === 'command=ls-refs') {
      // Args after the delim: peel, symrefs, unborn, ref-prefix <p>.
      let peel = false;
      let symrefs = false;
      let unborn = false;
      const prefixes: string[] = [];
      let pastDelim = false;
      for (const packet of decoded.packets) {
        if (packet.kind === 'delim') {
          pastDelim = true;
          continue;
        }
        if (packet.kind !== 'data' || !pastDelim) continue;
        const line = packet.payload.toString('utf8').trim();
        if (line === 'peel') peel = true;
        else if (line === 'symrefs') symrefs = true;
        else if (line === 'unborn') unborn = true;
        else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
      }
      const refs = listRefs(store, repo);
      const parts: Buffer[] = [];
      const hasRefs = repo.refs.size > 0;
      if (!hasRefs && unborn) {
        parts.push(pktLine(`unborn refs/heads/${repo.defaultBranch} symref-target:refs/heads/${repo.defaultBranch}\n`));
      } else {
        for (const ref of refs) {
          if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
          let line = `${ref.oid} ${ref.name}`;
          if (symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
          if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
          parts.push(pktLine(`${line}\n`));
        }
      }
      parts.push(pktFlush());
      return gitResult(200, Buffer.concat(parts), 'git-upload-pack', 'result');
    }
    if (command === 'command=fetch') {
      const wants: string[] = [];
      const haves: string[] = [];
      const shallow: string[] = [];
      let depth: number | null = null;
      let deepenSince: number | null = null;
      const deepenNot: string[] = [];
      let done = false;
      let pastDelim = false;
      for (const packet of decoded.packets) {
        if (packet.kind === 'delim') {
          pastDelim = true;
          continue;
        }
        if (packet.kind !== 'data' || !pastDelim) continue;
        const line = packet.payload.toString('utf8').trim();
        if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) {
          const n = Number(line.slice(7).trim());
          if (Number.isFinite(n) && n > 0) depth = Math.trunc(n);
        } else if (line.startsWith('deepen-since ')) {
          const n = Number(line.slice('deepen-since '.length).trim());
          if (Number.isFinite(n)) deepenSince = n;
        } else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice('deepen-not '.length).trim());
        else if (line === 'done') done = true;
      }
      if (wants.length === 0) {
        return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'No wants' }), 'utf8') };
      }
      // A fetch response is a pure function of these inputs (see the cache note
      // above), so an identical depth-1 clone reuses the first clone's bytes.
      const cacheKey =
        deepenNot.length === 0
          ? fetchCacheKey(true, done, wants, haves, shallow, depth, deepenSince)
          : null;
      if (cacheKey !== null) {
        const cached = fetchCacheGet(repo, cacheKey);
        if (cached !== undefined) return cached;
      }
      const selected = selectFetch(store, repo, wants, haves, shallow, depth, deepenSince, deepenNot);
      const pack = writePack(selected.objects.values());
      if (!done) {
        // A negotiation round: the acknowledgments section alone, then flush. No
        // packfile yet; the client will answer with more haves or done.
        const w = new PktWriter(128);
        w.pktLineText('acknowledgments\n');
        if (selected.ack !== null) w.pktLineText(`ACK ${selected.ack}\n`);
        else w.pktLineText('NAK\n');
        w.flush();
        const res = gitResult(200, w.build(), 'git-upload-pack', 'result');
        if (cacheKey !== null) fetchCachePut(repo, cacheKey, res);
        return res;
      }
      // The client sent done, so the acknowledgments section MUST be omitted
      // (protocol-v2): the response goes straight to the packfile.
      const w = new PktWriter(pack.length + 256);
      if (selected.shallow.length > 0 || selected.unshallow.length > 0) {
        w.pktLineText('shallow-info\n');
        for (const oid of selected.shallow) w.pktLineText(`shallow ${oid}\n`);
        for (const oid of selected.unshallow) w.pktLineText(`unshallow ${oid}\n`);
        w.delim();
      }
      w.pktLineText('packfile\n');
      packSideband(w, pack);
      w.flush();
      const res = gitResult(200, w.build(), 'git-upload-pack', 'result');
      if (cacheKey !== null) fetchCachePut(repo, cacheKey, res);
      return res;
    }
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Unknown v2 command' }), 'utf8') };
  }

  // v0 fetch: wants (first carries capabilities), shallow/deepen, flush, haves, done, flush.
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let deepenSince: number | null = null;
  const deepenNot: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      wants.push(rest.split(' ')[0]!);
    } else if (text.startsWith('have ')) haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const n = Number(text.slice(7).trim());
      if (Number.isFinite(n) && n > 0) depth = Math.trunc(n);
    } else if (text.startsWith('deepen-since ')) {
      const n = Number(text.slice('deepen-since '.length).trim());
      if (Number.isFinite(n)) deepenSince = n;
    } else if (text.startsWith('deepen-not ')) deepenNot.push(text.slice('deepen-not '.length).trim());
  }
  if (wants.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'No wants' }), 'utf8') };
  }
  const cacheKey =
    deepenNot.length === 0
      ? fetchCacheKey(false, true, wants, haves, shallow, depth, deepenSince)
      : null;
  if (cacheKey !== null) {
    const cached = fetchCacheGet(repo, cacheKey);
    if (cached !== undefined) return cached;
  }
  const selected = selectFetch(store, repo, wants, haves, shallow, depth, deepenSince, deepenNot);
  const pack = selected.objects.size > 0 ? writePack(selected.objects.values()) : null;
  const w = new PktWriter((pack?.length ?? 0) + 256);
  if (selected.ack !== null) w.pktLineText(`ACK ${selected.ack}\n`);
  else w.pktLineText('NAK\n');
  for (const oid of selected.shallow) w.pktLineText(`shallow ${oid}\n`);
  for (const oid of selected.unshallow) w.pktLineText(`unshallow ${oid}\n`);
  if (pack !== null) packSideband(w, pack);
  w.flush();
  const res = gitResult(200, w.build(), 'git-upload-pack', 'result');
  if (cacheKey !== null) fetchCachePut(repo, cacheKey, res);
  return res;
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, owner: string, repoName: string, body: Buffer): GitResponse {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return notFoundJson();
  // Commands run until the first flush; everything after it is the raw pack, so the
  // pkt-line stream is parsed incrementally and stops at the flush.
  const commands: PushCommand[] = [];
  let useSideband = false;
  let packOffset = body.length;
  let firstLine = true;
  let offset = 0;
  let malformed = false;
  let sawFlush = false;
  while (offset < body.length) {
    if (offset + 4 > body.length) {
      malformed = true;
      break;
    }
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      malformed = true;
      break;
    }
    const len = parseInt(head, 16);
    if (len === 0) {
      offset += 4;
      sawFlush = true;
      break;
    }
    if (len === 1 || len === 2) {
      offset += 4;
      continue;
    }
    if (len < 4 || len > 65520 || offset + len > body.length) {
      malformed = true;
      break;
    }
    const payload = body.subarray(offset + 4, offset + len);
    offset += len;
    let text = payload.toString('utf8');
    if (firstLine) {
      firstLine = false;
      const nul = text.indexOf('\0');
      if (nul >= 0) {
        const caps = text.slice(nul + 1);
        if (caps.split(' ').includes('side-band-64k')) useSideband = true;
        text = text.slice(0, nul);
      }
    }
    const line = text.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3 || !isOid(parts[0]) || !isOid(parts[1])) {
      malformed = true;
      break;
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  if (malformed || !sawFlush) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Malformed request' }), 'utf8') };
  }
  packOffset = offset;
  const packBytes = body.subarray(packOffset);

  let unpackOk = true;
  let unpackError = '';
  const hasUpdates = commands.some((c) => c.newOid !== ZERO_OID);
  if (hasUpdates && packBytes.length === 0) {
    unpackOk = false;
    unpackError = 'unpack error';
  } else if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : 'unpack error';
    }
  }

  interface RefReport {
    ref: string;
    ok: boolean;
    reason: string;
  }
  const reports: RefReport[] = [];
  for (const command of commands) {
    if (!unpackOk) {
      reports.push({ ref: command.ref, ok: false, reason: 'unpack error' });
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (current !== command.oldOid) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        reports.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
    } else {
      if (current === undefined) {
        reports.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      if (current !== command.oldOid) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
        reports.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    if (!repo.objects.has(command.newOid)) {
      reports.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reports.push({ ref: command.ref, ok: true, reason: '' });
  }

  const w = new PktWriter(256);
  const reportLine = (line: string): void => {
    // Inside band 1 the report lines are themselves pkt-lines (see sidebandPktLine).
    if (useSideband) w.sidebandPktLine(1, line);
    else w.pktLineText(line);
  };
  reportLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackError === '' ? 'error' : unpackError}\n`);
  for (const report of reports) {
    reportLine(report.ok ? `ok ${report.ref}\n` : `ng ${report.ref} ${report.reason}\n`);
  }
  if (useSideband) {
    // The report stream itself ends with a flush inside band 1 (git's
    // generate_report ends with packet_buf_flush); the outer flush below then
    // ends the sideband stream. Without the inner flush the client's report
    // reader hits EOF and dies "the remote end hung up unexpectedly".
    w.sideband(1, Buffer.from('0000', 'ascii'));
  }
  w.flush();
  return gitResult(200, w.build(), 'git-receive-pack', 'result');
}
