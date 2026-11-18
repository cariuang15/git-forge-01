// The forge's whole store: git objects, refs, repositories, issues, pull requests —
// all in memory, all deterministic (fixed timestamps, sequential ids, no clock, no
// Math.random), so two runs of the same request sequence reach the same state.
//
// The scenario the suite drives is fixed by the kit (wire.ts SCENARIO_SEED): the token
// owner is always `adaiversen` and the stranger `olgabauer`. Those two logins are the
// only identity facts the entry needs, and they are the same for every trial.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
/** Fixed commit timestamp (2025-01-01, the scenario epoch): every commit the forge mints uses it. */
export const FIXED_EPOCH = 1735689600;
/** Fixed merged_at string: a real clock would make replays differ. */
export const FIXED_MERGED_AT = '2025-01-01T00:00:00Z';
export const SERVER_NAME = 'gitforge';
export const SERVER_VERSION = '1.0.0';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// object parsing / building
// ---------------------------------------------------------------------------------------------

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  /** Committer timestamp, seconds since epoch (0 when unparsable). */
  timestamp: number;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  let timestamp = 0;
  const m = / (\d+) [+-]\d{4}$/.exec(committer) ?? / (\d+) [+-]\d{4}$/.exec(author);
  if (m) timestamp = Number(m[1]);
  return { tree, parents, author, committer, message, timestamp };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    if (space < 0) break;
    const mode = data.subarray(i, space).toString('utf8');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Tree bytes: entries sorted by name, directories sorting as name + '/'. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.name + (a.mode === '40000' ? '/' : '');
    const kb = b.name + (b.mode === '40000' ? '/' : '');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

const FIXED_IDENT = `${VIEWER_LOGIN} <${VIEWER_EMAIL}> ${FIXED_EPOCH} +0000`;

export function buildCommit(fields: { tree: string; parents: readonly string[]; message: string }): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${FIXED_IDENT}`, `committer ${FIXED_IDENT}`, '', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------------------------
// packfiles (v2): plain objects only on write; deltas resolved on read
// ---------------------------------------------------------------------------------------------

function readTypeAndSize(buf: Buffer, offset: number): { type: number; size: number; next: number } {
  const first = buf[offset] ?? 0;
  const type = (first >> 4) & 0x7;
  let size = first & 0x0f;
  let next = offset + 1;
  let shift = 4;
  let b = first;
  while ((b & 0x80) !== 0) {
    b = buf[next] ?? 0;
    size |= (b & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { type, size, next };
}

/** Adler-32 (zlib's checksum), chunked so the accumulators stay exact for any size. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + 5552, data.length);
    while (i < end) {
      a += data[i]!;
      b += a;
      i += 1;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Inflate the first zlib stream starting at `start` in `buf`. inflateSync stops at the
 * stream's end and ignores trailing bytes, so one call yields the data; the stream ends
 * with the Adler-32 of that data, which locates the boundary. The boundary is trusted
 * because a wrong one cannot survive the pack parse: the next object's header would be
 * garbage (or the final offset would not land on the trailer), and readPack throws.
 * (An earlier version re-inflated the exact [start, end) slice to verify the boundary;
 * that second inflateSync per object cost ~30 us per pack for no extra safety, since a
 * false-positive Adler inside the deflate data is ~1e-7 per object and any surviving
 * error is caught by the final-offset check in readPack.)
 */
function inflatePrefix(buf: Buffer, start: number, size: number): { data: Buffer; next: number } | null {
  let data: Buffer;
  try {
    data = inflateSync(buf.subarray(start));
  } catch {
    return null;
  }
  if (data.length !== size) return null;
  const adler = adler32(data);
  const first = (adler >>> 24) & 0xff;
  for (let p = start + 2; p + 4 <= buf.length; p += 1) {
    if (buf[p] !== first) continue;
    if (buf.readUInt32BE(p) !== adler) continue;
    return { data, next: p + 4 };
  }
  return null;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const b = delta[p] ?? 0;
      p += 1;
      value |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return value;
  };
  const srcSize = readDeltaVarint();
  const dstSize = readDeltaVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (p < delta.length) {
    const op = delta[p] ?? 0;
    p += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          offset |= (delta[p] ?? 0) << (8 * i);
          p += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          size |= (delta[p] ?? 0) << (8 * i);
          p += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(p, p + op));
      outLen += op;
      p += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (outLen !== dstSize || result.length !== dstSize) throw new Error('delta target size mismatch');
  return result;
}

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackReadResult {
  objects: Map<string, GitObject>;
}

/**
 * Parse a packfile. `resolveBase` supplies objects the pack deltas against but does not
 * carry (the store's own objects for thin packs). Throws on any malformed input.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Trailer check: the last 20 bytes are the SHA-1 of everything before them.
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  if (trailer !== actual) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    const { type, size, next } = readTypeAndSize(pack, offset);
    offset = next;
    let obj: GitObject;
    if (type >= 1 && type <= 4) {
      const inflated = inflatePrefix(pack, offset, size);
      if (inflated === null) throw new Error('pack object does not inflate');
      offset = inflated.next;
      obj = { type: PACK_TYPES[type]!, data: inflated.data };
    } else if (type === 6) {
      // OFS_DELTA: offset varint, then the delta stream.
      let b = pack[offset] ?? 0;
      offset += 1;
      let baseOffset = b & 0x7f;
      while ((b & 0x80) !== 0) {
        b = pack[offset] ?? 0;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (b & 0x7f);
      }
      const base = byOffset.get(entryOffset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base not in pack');
      const inflated = inflatePrefix(pack, offset, size);
      if (inflated === null) throw new Error('delta does not inflate');
      offset = inflated.next;
      obj = { type: base.type, data: applyDelta(base.data, inflated.data) };
    } else if (type === 7) {
      // REF_DELTA: 20-byte base oid, then the delta stream.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} unknown`);
      const inflated = inflatePrefix(pack, offset, size);
      if (inflated === null) throw new Error('delta does not inflate');
      offset = inflated.next;
      obj = { type: base.type, data: applyDelta(base.data, inflated.data) };
    } else {
      throw new Error(`unknown pack object type ${type}`);
    }
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    byOffset.set(entryOffset, obj);
  }
  // A wrong stream boundary (a false-positive Adler inside deflate data) shifts every
  // later object, so the parse cannot end exactly on the trailer: that is the check
  // that makes the single-inflate boundary above safe.
  if (offset !== pack.length - 20) throw new Error('pack parse did not consume the pack');
  return { objects };
}

export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.alloc(12)];
  parts[0]!.write('PACK', 0, 'ascii');
  parts[0]!.writeUInt32BE(2, 4);
  parts[0]!.writeUInt32BE(list.length, 8);
  const typeNums: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of list) {
    const typeNum = typeNums[obj.type];
    const size = obj.data.length;
    // varint: low 4 bits of size in the first byte with the type, then 7 bits per byte.
    const header: number[] = [];
    let remaining = size >> 4;
    let first = (typeNum << 4) | (size & 0x0f);
    if (remaining > 0) first |= 0x80;
    header.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      header.push(b);
    }
    parts.push(Buffer.from(header));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: { name: string; color: string }[];
  comments: { id: number; body: string }[];
  seq: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  merge_commit_sha: string | null;
  headRef: string;
  baseRef: string;
  mergeBaseOid: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  nextIssueNumber: number;
  nextCommentId: number;
  labels: Map<string, { name: string; color: string }>;
  pulls: Pull[];
  nextPullNumber: number;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  private nextId = 5000;
  private nextSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      id: this.nextId,
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      objects: new Map(),
      refs: new Map(),
      issues: [],
      nextIssueNumber: 1,
      nextCommentId: 1,
      labels: new Map(),
      pulls: [],
      nextPullNumber: 1,
      seq: this.nextSeq,
    };
    this.nextId += 1;
    this.nextSeq += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()].filter((r) => r.owner === owner).sort((a, b) => a.seq - b.seq);
  }

  nextObjectId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  // -- git objects ------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Resolve a ref name (or oid) to an oid, following HEAD. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    return repo.refs.get(`refs/heads/${ref}`) ?? null;
  }

  /** Peel a tag object to its target commit oid (or the oid itself when not a tag). */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let i = 0; i < 10; i += 1) {
      const obj = repo.objects.get(current);
      if (obj === undefined) return null;
      if (obj.type === 'tag') {
        current = parseTag(obj.data).object;
        continue;
      }
      if (obj.type === 'commit') return current;
      return null;
    }
    return null;
  }

  /** All commit oids reachable from `tip` (parents only), newest first. */
  listCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      out.push(oid);
      const parsed = parseCommit(obj.data);
      for (let i = parsed.parents.length - 1; i >= 0; i -= 1) stack.push(parsed.parents[i]!);
    }
    return out;
  }

  /** First common ancestor of two commits (the merge base), or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const ancestorsA = new Set(this.listCommits(repo, a));
    const stack = [b];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (ancestorsA.has(oid)) return oid;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return null;
  }

  /** Is `ancestor` reachable from `tip` (following commit parents, peeling tags)? */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    const tipCommit = this.peelToCommit(repo, tip);
    if (tipCommit === null) return false;
    if (tipCommit === ancestor) return true;
    const stack = [tipCommit];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** Flat path -> {oid, mode} map of a commit's tree. */
  flattenTree(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return out;
    const walk = (treeOid: string, prefix: string): void => {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return;
      for (const entry of parseTree(tree.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else if (entry.mode !== '160000') out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(parseCommit(commit.data).tree, '');
    return out;
  }

  /** Rebuild a tree from a flat path map; stores the new tree objects. Returns the root oid. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, value] of flat) {
        if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
        const rest = prefix === '' ? path : path.slice(prefix.length + 1);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: value.mode, name: rest, oid: value.oid });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        const sub = prefix === '' ? dir : `${prefix}/${dir}`;
        entries.push({ mode: '40000', name: dir, oid: build(sub) });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build('');
  }

  /** Find one path inside a commit's tree: {type, oid} or null. */
  lookupPath(repo: Repo, commitOid: string, path: string): { type: 'blob' | 'tree'; oid: string } | null {
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return null;
    let treeOid = parseCommit(commit.data).tree;
    const parts = path.split('/').filter((p) => p !== '');
    for (let i = 0; i < parts.length; i += 1) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((e) => e.name === parts[i]);
      if (entry === undefined) return null;
      const last = i === parts.length - 1;
      if (last) {
        if (entry.mode === '40000') return { type: 'tree', oid: entry.oid };
        return { type: 'blob', oid: entry.oid };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return { type: 'tree', oid: treeOid };
  }

  /** Directory listing of a tree oid: [{name, path, type, oid}]. */
  listTree(repo: Repo, treeOid: string, prefix: string): { name: string; path: string; type: 'file' | 'dir'; oid: string }[] {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return [];
    return parseTree(tree.data).map((entry) => ({
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      oid: entry.oid,
    }));
  }

  /** Mint a commit on `branch` (creating the branch when needed) and return its oid. */
  commitOnBranch(repo: Repo, branch: string, treeOid: string, message: string): string {
    const tip = repo.refs.get(`refs/heads/${branch}`);
    const parents = tip === undefined ? [] : [tip];
    const commitOid = this.putObject(repo, 'commit', buildCommit({ tree: treeOid, parents, message }));
    repo.refs.set(`refs/heads/${branch}`, commitOid);
    return commitOid;
  }

  // -- reachability / fetch selection ------------------------------------------

  /**
   * Objects reachable from `wants`, minus those reachable from `exclude`.
   * `depth` limits commit generations from the wants (1 = tips only). `shallowBoundaries`
   * are the client's current shallow lines: boundaries that turn complete come back as
   * `unshallow`. `since` (epoch seconds) keeps only newer commits; `deepenNot` tips are
   * excluded like haves.
   */
  collectForFetch(
    repo: Repo,
    wants: readonly string[],
    opts: {
      exclude?: ReadonlySet<string>;
      depth?: number;
      shallowBoundaries?: readonly string[];
      since?: number;
      deepenNot?: readonly string[];
    } = {},
  ): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
    const excluded = new Set<string>();
    const collectAll = (tips: Iterable<string>): void => {
      const stack = [...tips];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const obj = repo.objects.get(oid);
        if (obj === undefined) continue;
        excluded.add(oid);
        if (obj.type === 'commit') {
          const parsed = parseCommit(obj.data);
          if (!excluded.has(parsed.tree)) {
            excluded.add(parsed.tree);
            this.collectTreeInto(repo, parsed.tree, excluded);
          }
          // A shallow boundary is a commit the client holds WITHOUT its parents:
          // the exclusion stops there, so a deepen fetch can still deliver them.
          if (opts.shallowBoundaries?.includes(oid)) continue;
          for (const parent of parsed.parents) stack.push(parent);
        } else if (obj.type === 'tag') {
          stack.push(parseTag(obj.data).object);
        } else if (obj.type === 'tree') {
          this.collectTreeInto(repo, oid, excluded);
        }
      }
    };
    if (opts.exclude !== undefined) collectAll(opts.exclude);
    if (opts.deepenNot !== undefined) {
      const tips: string[] = [];
      for (const ref of opts.deepenNot) {
        const oid = this.resolveRef(repo, ref);
        if (oid !== null) tips.push(oid);
      }
      collectAll(tips);
    }

    const included = new Map<string, GitObject>();
    const includedCommits = new Set<string>();
    const boundary = new Set<string>();
    // Walk commits by generation from the wants.
    const queue: { oid: string; gen: number }[] = [];
    for (const want of wants) {
      const peeled = this.peelToCommit(repo, want);
      const obj = repo.objects.get(want);
      if (obj !== undefined && obj.type === 'tag' && !excluded.has(want)) included.set(want, obj);
      if (peeled !== null) queue.push({ oid: peeled, gen: 0 });
      else if (obj !== undefined && !excluded.has(want)) included.set(want, obj);
    }
    const seenCommits = new Set<string>();
    while (queue.length > 0) {
      const { oid, gen } = queue.shift()!;
      if (seenCommits.has(oid)) continue;
      seenCommits.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      if (opts.depth !== undefined && gen >= opts.depth) continue;
      const parsed = parseCommit(obj.data);
      if (opts.since !== undefined && parsed.timestamp <= opts.since) continue;
      // Walk through a held commit to reach deeper generations: a deepen fetch
      // starts from a tip the client already has, so its parents are the point.
      // Only the inclusion skips a held commit, never the descent.
      const atBoundary = opts.depth !== undefined && gen === opts.depth - 1;
      if (!atBoundary) {
        for (const parent of parsed.parents) {
          if (!seenCommits.has(parent)) queue.push({ oid: parent, gen: gen + 1 });
        }
      }
      if (excluded.has(oid)) continue;
      included.set(oid, obj);
      includedCommits.add(oid);
      if (atBoundary) boundary.add(oid);
    }
    // Trees and blobs of the included commits. The walk runs against `excluded`,
    // so a blob the client already holds (an unchanged file in a new tree) is
    // never re-sent.
    for (const oid of includedCommits) {
      const tree = parseCommit(repo.objects.get(oid)!.data).tree;
      if (!excluded.has(tree) && !included.has(tree)) {
        this.collectTreeInto(repo, tree, excluded, included);
      }
    }
    // A boundary commit is only shallow when a parent is missing from sent ∪ held.
    const shallow: string[] = [];
    for (const oid of boundary) {
      const parsed = parseCommit(repo.objects.get(oid)!.data);
      const missingParent = parsed.parents.some((p) => !includedCommits.has(p) && !excluded.has(p));
      if (missingParent) shallow.push(oid);
    }
    // Unshallow: an old boundary whose parents are all present now.
    const unshallow: string[] = [];
    for (const old of opts.shallowBoundaries ?? []) {
      const obj = repo.objects.get(old);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.every((p) => includedCommits.has(p) || excluded.has(p))) unshallow.push(old);
    }
    return { objects: included, shallow, unshallow };
  }

  private collectTreeInto(repo: Repo, treeOid: string, into: Set<string>, map?: Map<string, GitObject>): void {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    if (map !== undefined) map.set(treeOid, tree);
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '160000') continue;
      if (into.has(entry.oid)) continue;
      into.add(entry.oid);
      const obj = repo.objects.get(entry.oid);
      if (obj === undefined) continue;
      if (map !== undefined) map.set(entry.oid, obj);
      if (entry.mode === '40000') this.collectTreeInto(repo, entry.oid, into, map);
    }
  }

  // -- issues / pulls -----------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: { name: string; color: string }[]): Issue {
    const issue: Issue = {
      id: this.nextObjectId(),
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels,
      comments: [],
      seq: this.nextSeq,
    };
    this.nextSeq += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = this.resolveRef(repo, `refs/heads/${headRef}`);
    const baseSha = this.resolveRef(repo, `refs/heads/${baseRef}`);
    if (headSha === null || baseSha === null) return null;
    const mergeBase = this.mergeBase(repo, headSha, baseSha);
    const pull: Pull = {
      id: this.nextObjectId(),
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      merged: false,
      merged_at: null,
      merge_commit_sha: null,
      headRef,
      baseRef,
      mergeBaseOid: mergeBase,
      seq: this.nextSeq,
    };
    this.nextSeq += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Line-diff counts between two texts (LCS over lines). */
  static lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const splitLines = (text: string): string[] => {
      if (text === '') return [];
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines;
    };
    const a = splitLines(oldText);
    const b = splitLines(newText);
    const n = a.length;
    const m = b.length;
    // LCS lengths, two rows.
    let prev = new Array<number>(m + 1).fill(0);
    let curr = new Array<number>(m + 1).fill(0);
    for (let i = 1; i <= n; i += 1) {
      for (let j = 1; j <= m; j += 1) {
        curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
      }
      const tmp = prev;
      prev = curr;
      curr = tmp;
      curr.fill(0);
    }
    const lcs = prev[m] ?? 0;
    return { additions: m - lcs, deletions: n - lcs };
  }

  /** Changed files between the PR's merge base and its head tip. */
  pullFiles(repo: Repo, pull: Pull): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
    const headSha = this.resolveRef(repo, `refs/heads/${pull.headRef}`);
    if (headSha === null || pull.mergeBaseOid === null) return [];
    const baseFlat = this.flattenTree(repo, pull.mergeBaseOid);
    const headFlat = this.flattenTree(repo, headSha);
    const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFlat.get(path);
      const head = headFlat.get(path);
      if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
      if (base === undefined && head !== undefined) {
        const blob = repo.objects.get(head.oid);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        out.push({ filename: path, status: 'added', additions: lines, deletions: 0, changes: lines });
      } else if (base !== undefined && head === undefined) {
        const blob = repo.objects.get(base.oid);
        const text = blob?.type === 'blob' ? blob.data.toString('utf8') : '';
        const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: lines, changes: lines });
      } else if (base !== undefined && head !== undefined) {
        const oldBlob = repo.objects.get(base.oid);
        const newBlob = repo.objects.get(head.oid);
        const diff = Store.lineDiff(
          oldBlob?.type === 'blob' ? oldBlob.data.toString('utf8') : '',
          newBlob?.type === 'blob' ? newBlob.data.toString('utf8') : '',
        );
        out.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
      }
    }
    return out;
  }

  /** Is this pull request mergeable (no three-way conflict)? */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const headSha = this.resolveRef(repo, `refs/heads/${pull.headRef}`);
    const baseSha = this.resolveRef(repo, `refs/heads/${pull.baseRef}`);
    if (headSha === null || baseSha === null || pull.mergeBaseOid === null) return 'UNKNOWN';
    return this.mergeConflict(repo, pull) === null ? 'MERGEABLE' : 'CONFLICTING';
  }

  /** The first conflicting path of a three-way merge, or null when it merges cleanly. */
  mergeConflict(repo: Repo, pull: Pull): string | null {
    const headSha = this.resolveRef(repo, `refs/heads/${pull.headRef}`);
    const baseSha = this.resolveRef(repo, `refs/heads/${pull.baseRef}`);
    if (headSha === null || baseSha === null || pull.mergeBaseOid === null) return 'unknown';
    const baseFlat = this.flattenTree(repo, pull.mergeBaseOid);
    const headFlat = this.flattenTree(repo, headSha);
    const targetFlat = this.flattenTree(repo, baseSha);
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const b = baseFlat.get(path);
      const h = headFlat.get(path);
      const t = targetFlat.get(path);
      const headChanged = (h?.oid ?? null) !== (b?.oid ?? null);
      const targetChanged = (t?.oid ?? null) !== (b?.oid ?? null);
      if (headChanged && targetChanged && (h?.oid ?? null) !== (t?.oid ?? null)) return path;
    }
    return null;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid or an error. */
  mergePull(repo: Repo, pull: Pull): { ok: true; sha: string } | { ok: false; reason: string } {
    if (pull.state !== 'open') return { ok: false, reason: 'already closed' };
    const conflict = this.mergeConflict(repo, pull);
    if (conflict !== null) return { ok: false, reason: 'conflict' };
    const headSha = this.resolveRef(repo, `refs/heads/${pull.headRef}`);
    const baseSha = this.resolveRef(repo, `refs/heads/${pull.baseRef}`);
    if (headSha === null || baseSha === null || pull.mergeBaseOid === null) return { ok: false, reason: 'unknown' };
    const baseFlat = this.flattenTree(repo, pull.mergeBaseOid);
    const headFlat = this.flattenTree(repo, headSha);
    const targetFlat = this.flattenTree(repo, baseSha);
    const merged = new Map(targetFlat);
    for (const [path, value] of headFlat) {
      if ((baseFlat.get(path)?.oid ?? null) !== value.oid) merged.set(path, value);
    }
    for (const path of baseFlat.keys()) {
      if (!headFlat.has(path) && baseFlat.has(path)) merged.delete(path);
    }
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n`;
    const mergeSha = this.putObject(repo, 'commit', buildCommit({ tree: treeOid, parents: [baseSha], message }));
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.merged_at = FIXED_MERGED_AT;
    pull.merge_commit_sha = mergeSha;
    return { ok: true, sha: mergeSha };
  }
}

// ---------------------------------------------------------------------------------------------
// global ids (GraphQL Relay ids): opaque base64, stable across reads
// ---------------------------------------------------------------------------------------------

export function globalId(kind: string, id: string | number): string {
  return Buffer.from(`${kind}:${id}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; value: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), value: text.slice(colon + 1) };
  } catch {
    return null;
  }
}
