// MCP at /mcp: JSON-RPC 2.0 over Streamable HTTP, revision 2026-07-28.
// server/discover answers the identity, capabilities and supported versions; tools/list
// offers the six required tools (plus two small extras); tools/call acts on the same
// store as REST, so an object made over MCP reads back over /api/v3 unchanged.

import { SERVER_NAME, SERVER_VERSION, VIEWER_LOGIN, type Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

export interface McpReply {
  status: number;
  body: unknown;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolOk(result: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

export function handleMcp(store: Store, rawBody: Buffer): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = request.method;
  if (typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');

  // A notification (no id) gets no JSON-RPC answer.
  const isNotification = !('id' in request);

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: 'A GitHub-compatible git forge: repositories, issues, pull requests, git smart HTTP.',
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const negotiated = SUPPORTED_VERSIONS.includes(wanted) ? wanted : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'notifications/initialized') {
    return { status: 202, body: null };
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((t) => t.name === name);
    if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const required = (tool.inputSchema.required ?? []) as string[];
    const missing = required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
    }
    try {
      const result = callTool(store, name, args);
      return rpcResult(id, result);
    } catch (err) {
      return rpcResult(id, toolError(err instanceof Error ? err.message : String(err)));
    }
  }

  void isNotification;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const owner = str(args.owner);
  const repoName = str(args.repo);
  const findRepo = () => {
    if (owner !== VIEWER_LOGIN) return null;
    return store.getRepo(owner, repoName) ?? null;
  };

  switch (name) {
    case 'create_repo': {
      const repoNameArg = str(args.name);
      if (repoNameArg === '') throw new Error('name is required');
      const repo = store.createRepo(VIEWER_LOGIN, repoNameArg, str(args.description), args.private === true);
      if (repo === null) throw new Error('Repository already exists');
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo();
      if (repo === null) throw new Error(`Repository not found: ${owner}/${repoName}`);
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo();
      if (repo === null) throw new Error(`Repository not found: ${owner}/${repoName}`);
      const issue = store.createIssue(repo, str(args.title), str(args.body), []);
      return toolOk(issueJson(issue));
    }
    case 'list_issues': {
      const repo = findRepo();
      if (repo === null) throw new Error(`Repository not found: ${owner}/${repoName}`);
      const state = str(args.state) === '' ? 'open' : str(args.state);
      let issues = repo.issues;
      if (state === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (state === 'closed') issues = issues.filter((i) => i.state === 'closed');
      const list = issues.map(issueJson);
      return toolOk(list);
    }
    case 'create_pull_request': {
      const repo = findRepo();
      if (repo === null) throw new Error(`Repository not found: ${owner}/${repoName}`);
      const head = str(args.head);
      const base = str(args.base);
      if (store.resolveRef(repo, `refs/heads/${head}`) === null) throw new Error(`Unknown head branch: ${head}`);
      if (store.resolveRef(repo, `refs/heads/${base}`) === null) throw new Error(`Unknown base branch: ${base}`);
      const existing = repo.pulls.find((p) => p.headRef === head && p.state === 'open');
      if (existing !== undefined) throw new Error('A pull request already exists for this head branch');
      const pull = store.createPull(repo, str(args.title), str(args.body), head, base);
      if (pull === null) throw new Error('Could not create the pull request');
      return toolOk(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo();
      if (repo === null) throw new Error(`Repository not found: ${owner}/${repoName}`);
      const number = num(args.pull_number);
      const pull = number === null ? undefined : repo.pulls.find((p) => p.number === number);
      if (pull === undefined) throw new Error(`Pull request not found: ${args.pull_number}`);
      if (pull.state !== 'open') throw new Error('Pull request is already closed');
      if (store.mergeConflict(repo, pull) !== null) throw new Error('Merge conflict');
      const merged = store.mergePull(repo, pull);
      if (!merged.ok) throw new Error(merged.reason);
      return toolOk(pullJson(store, repo, pull));
    }
    case 'get_issue': {
      const repo = findRepo();
      if (repo === null) throw new Error(`Repository not found: ${owner}/${repoName}`);
      const number = num(args.issue_number);
      const issue = number === null ? undefined : repo.issues.find((i) => i.number === number);
      if (issue === undefined) throw new Error(`Issue not found: ${args.issue_number}`);
      return toolOk(issueJson(issue));
    }
    case 'list_pull_requests': {
      const repo = findRepo();
      if (repo === null) throw new Error(`Repository not found: ${owner}/${repoName}`);
      const state = str(args.state) === '' ? 'open' : str(args.state);
      let pulls = repo.pulls;
      if (state === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      return toolOk(pulls.map((p) => pullJson(store, repo, p)));
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
