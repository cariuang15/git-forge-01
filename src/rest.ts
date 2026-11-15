// The REST v3 API under /api/v3: repositories, branches, commits, contents, issues,
// labels, pull requests. Every reply is JSON with a non-empty X-GitHub-Request-Id.

import {
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  parseCommit,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestReply => ({ status, body, headers });
const err = (status: number, message: string): RestReply => ({ status, body: { message } });

// ---------------------------------------------------------------------------------------------
// serializers
// ---------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : repo.id },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

export function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = store.resolveRef(repo, `refs/heads/${pull.headRef}`);
  const baseSha = store.resolveRef(repo, `refs/heads/${pull.baseRef}`);
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: headSha ?? '', label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha ?? '', label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.merged_at,
    merge_commit_sha: pull.merge_commit_sha,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const page = Number.isFinite(pageRaw) ? Math.max(1, Math.trunc(pageRaw)) : 1;
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: URLSearchParams, base: string, path: string): { items: T[]; link: string | null } {
  const { perPage, page } = pageParams(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  const link = hasNext ? `<${base}${path}?per_page=${perPage}&page=${page + 1}>; rel="next"` : null;
  return { items: slice, link };
}

// ---------------------------------------------------------------------------------------------
// routing
// ---------------------------------------------------------------------------------------------

type Body = Record<string, unknown> | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Resolve a repo under the token owner; any other owner is a 404, never a 403. */
function findRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, name) ?? null;
}

export function routeRest(store: Store, method: string, segments: string[], query: URLSearchParams, body: Body, base: string): RestReply | null {
  // GET /api/v3/ — the API root (public).
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { current_user_url: '/api/v3/user', user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  const [first, ...rest] = segments as [string, ...string[]];

  if (first === 'meta' && rest.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0' });
  }

  if (first === 'user' && rest.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen', email: VIEWER_EMAIL, type: 'User' });
  }

  if (first === 'user' && rest.length === 1 && rest[0] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER_LOGIN);
      const { items, link } = paginate(repos.map(repoJson), query, base, '/api/v3/user/repos');
      return ok(200, items, link === null ? undefined : { link });
    }
    if (method === 'POST') {
      const name = str(body?.name);
      if (name === '') return err(422, 'Repository name is required');
      const created = store.createRepo(VIEWER_LOGIN, name, str(body?.description), body?.private === true);
      if (created === null) return err(422, 'Repository already exists');
      return ok(201, repoJson(created));
    }
    return err(404, 'Not Found');
  }

  if (first === 'repos' && rest.length >= 2) {
    const [owner, name, ...tail] = rest as [string, string, ...string[]];
    if (tail.length === 0) {
      const repo = findRepo(store, owner, name);
      if (method === 'GET') {
        if (repo === null) return err(404, 'Not Found');
        return ok(200, repoJson(repo));
      }
      if (method === 'PATCH') {
        if (repo === null) return err(404, 'Not Found');
        if (typeof body?.description === 'string') repo.description = body.description;
        if (typeof body?.private === 'boolean') repo.private = body.private;
        return ok(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        if (repo === null) return err(404, 'Not Found');
        store.deleteRepo(owner, name);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }

    const repo = findRepo(store, owner, name);
    if (repo === null) return err(404, 'Not Found');
    const [section, ...sub] = tail as [string, ...string[]];

    if (section === 'branches' && sub.length === 0 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! } }));
      return ok(200, branches);
    }
    if (section === 'branches' && sub.length === 1 && method === 'GET') {
      const sha = repo.refs.get(`refs/heads/${sub[0]}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { name: sub[0], commit: { sha } });
    }

    if (section === 'commits' && sub.length === 0 && method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = store.resolveRef(repo, ref);
      if (tip === null) return err(404, 'Not Found');
      const commits = store.listCommits(repo, tip).map((sha) => {
        const obj = repo.objects.get(sha)!;
        const parsed = obj.data.toString('utf8');
        const message = parsed.split('\n\n').slice(1).join('\n\n');
        return { sha, commit: { message } };
      });
      return ok(200, commits);
    }

    if (section === 'git' && sub[0] === 'refs') {
      if (method === 'POST' && sub.length === 1) {
        const ref = str(body?.ref);
        const sha = str(body?.sha);
        if (!ref.startsWith('refs/') || sha === '') return err(422, 'Invalid ref');
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return ok(201, { ref, object: { sha } });
      }
      if (method === 'GET' && sub.length === 1) {
        return ok(
          200,
          [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha } })),
        );
      }
      if (method === 'GET' && sub.length > 1) {
        const ref = `refs/${sub.slice(1).join('/')}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) return err(404, 'Not Found');
        return ok(200, { ref, object: { sha } });
      }
      return err(404, 'Not Found');
    }

    if (section === 'contents') {
      const path = sub.join('/');
      if (method === 'PUT') {
        const message = str(body?.message);
        const contentB64 = str(body?.content);
        if (contentB64 === '') return err(422, 'Content is required');
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          return err(422, 'Content is not valid base64');
        }
        const branch = str(body?.branch) === '' ? repo.defaultBranch : str(body?.branch);
        let tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) {
          const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          if (defaultTip !== undefined && branch !== repo.defaultBranch) {
            repo.refs.set(`refs/heads/${branch}`, defaultTip);
            tip = defaultTip;
          }
        }
        const flat = tip === undefined ? new Map<string, { oid: string; mode: string }>() : store.flattenTree(repo, tip);
        const current = flat.get(path);
        const givenSha = str(body?.sha);
        if (givenSha !== '') {
          if (current === undefined) return err(422, 'File does not exist');
          if (current.oid !== givenSha) return err(409, 'Conflict: sha does not match the current file');
        }
        const blobOid = store.putObject(repo, 'blob', content);
        const isNew = current === undefined;
        flat.set(path, { oid: blobOid, mode: '100644' });
        const treeOid = store.buildTreeFromFlat(repo, flat);
        const commitSha = store.commitOnBranch(repo, branch, treeOid, message === '' ? 'Update file' : message);
        return ok(isNew ? 201 : 200, {
          content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha },
        });
      }
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const tip = store.resolveRef(repo, ref);
        if (tip === null) return err(404, 'Not Found');
        if (path === '') {
          const commit = repo.objects.get(tip);
          if (commit === undefined || commit.type !== 'commit') return err(404, 'Not Found');
          const entries = store.listTree(repo, parseCommit(commit.data).tree, '');
          return ok(200, entries.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.oid })));
        }
        const found = store.lookupPath(repo, tip, path);
        if (found === null) return err(404, 'Not Found');
        if (found.type === 'tree') {
          const entries = store.listTree(repo, found.oid, path);
          return ok(200, entries.map((e) => ({ type: e.type, name: e.name, path: e.path, sha: e.oid })));
        }
        const blob = repo.objects.get(found.oid);
        if (blob === undefined || blob.type !== 'blob') return err(404, 'Not Found');
        return ok(200, {
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          sha: found.oid,
          size: blob.data.length,
          name: path.split('/').pop() ?? path,
          path,
        });
      }
      if (method === 'DELETE') {
        const branch = str(body?.branch) === '' ? repo.defaultBranch : str(body?.branch);
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return err(404, 'Not Found');
        const flat = store.flattenTree(repo, tip);
        const current = flat.get(path);
        if (current === undefined) return err(404, 'Not Found');
        const givenSha = str(body?.sha);
        if (givenSha !== '' && givenSha !== current.oid) return err(409, 'Conflict: sha does not match the current file');
        flat.delete(path);
        const treeOid = store.buildTreeFromFlat(repo, flat);
        const message = str(body?.message) === '' ? 'Delete file' : str(body?.message);
        const commitSha = store.commitOnBranch(repo, branch, treeOid, message);
        return ok(200, { commit: { sha: commitSha } });
      }
      return err(404, 'Not Found');
    }

    if (section === 'labels' && sub.length === 0 && method === 'POST') {
      const name = str(body?.name);
      if (name === '') return err(422, 'Label name is required');
      const color = typeof body?.color === 'string' && body.color !== '' ? body.color : 'ededed';
      repo.labels.set(name, { name, color });
      return ok(201, { name, color });
    }

    if (section === 'issues' && sub.length === 0) {
      if (method === 'POST') {
        const title = str(body?.title);
        if (title === '') return err(422, 'Title is required');
        const labelNames = Array.isArray(body?.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
        const labels: { name: string; color: string }[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (label === undefined) return err(422, `Unknown label: ${labelName}`);
          labels.push(label);
        }
        const issue = store.createIssue(repo, title, str(body?.body), labels);
        return ok(201, issueJson(issue));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let issues = repo.issues;
        if (state === 'open') issues = issues.filter((i) => i.state === 'open');
        else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
        const direction = query.get('direction') ?? 'desc';
        const sorted = [...issues].sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        const { items, link } = paginate(sorted.map(issueJson), query, base, `/api/v3/repos/${owner}/${name}/issues`);
        return ok(200, items, link === null ? undefined : { link });
      }
      return err(404, 'Not Found');
    }

    if (section === 'issues' && sub.length >= 1) {
      const number = Number(sub[0]);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const issue = repo.issues.find((i) => i.number === number);
      if (issue === undefined) return err(404, 'Not Found');
      if (sub.length === 1) {
        if (method === 'GET') return ok(200, issueJson(issue));
        if (method === 'PATCH') {
          if (typeof body?.state === 'string' && (body.state === 'open' || body.state === 'closed')) issue.state = body.state;
          if (typeof body?.title === 'string') issue.title = body.title;
          if (typeof body?.body === 'string') issue.body = body.body;
          return ok(200, issueJson(issue));
        }
        return err(404, 'Not Found');
      }
      if (sub.length === 2 && sub[1] === 'comments') {
        if (method === 'GET') {
          return ok(200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
        }
        if (method === 'POST') {
          const commentBody = str(body?.body);
          if (commentBody === '') return err(422, 'Comment body is required');
          const comment = { id: repo.nextCommentId, body: commentBody };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          return ok(201, { id: comment.id, body: comment.body });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    if (section === 'pulls' && sub.length === 0) {
      if (method === 'POST') {
        const title = str(body?.title);
        const headRaw = str(body?.head);
        const baseRaw = str(body?.base);
        if (title === '' || headRaw === '' || baseRaw === '') return err(422, 'title, head and base are required');
        const head = headRaw.includes(':') ? headRaw.split(':').pop()! : headRaw;
        const base = baseRaw.includes(':') ? baseRaw.split(':').pop()! : baseRaw;
        if (store.resolveRef(repo, `refs/heads/${head}`) === null) return err(422, `Unknown head branch: ${head}`);
        if (store.resolveRef(repo, `refs/heads/${base}`) === null) return err(422, `Unknown base branch: ${base}`);
        const existing = repo.pulls.find((p) => p.headRef === head && p.state === 'open');
        if (existing !== undefined) return err(422, 'A pull request already exists for this head branch');
        const pull = store.createPull(repo, title, str(body?.body), head, base);
        if (pull === null) return err(422, 'Could not create the pull request');
        return ok(201, pullJson(store, repo, pull));
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = repo.pulls;
        if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
        const { items, link } = paginate(pulls.map((p) => pullJson(store, repo, p)), query, base, `/api/v3/repos/${owner}/${name}/pulls`);
        return ok(200, items, link === null ? undefined : { link });
      }
      return err(404, 'Not Found');
    }

    if (section === 'pulls' && sub.length >= 1) {
      const number = Number(sub[0]);
      if (!Number.isInteger(number)) return err(404, 'Not Found');
      const pull = repo.pulls.find((p) => p.number === number);
      if (pull === undefined) return err(404, 'Not Found');
      if (sub.length === 1) {
        if (method === 'GET') return ok(200, pullJson(store, repo, pull));
        return err(404, 'Not Found');
      }
      if (sub.length === 2 && sub[1] === 'files' && method === 'GET') {
        return ok(200, store.pullFiles(repo, pull));
      }
      if (sub.length === 2 && sub[1] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open') return err(405, 'Pull request is already closed');
        const conflict = store.mergeConflict(repo, pull);
        if (conflict !== null) return err(405, 'Merge conflict');
        const merged = store.mergePull(repo, pull);
        if (!merged.ok) return err(405, merged.reason);
        return ok(200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' });
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return null;
}
