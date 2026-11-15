// GraphQL v4 at /api/graphql: a small parser and executor for the documents gh and
// github-mcp-server send (viewer, repository reads, issue/PR reads, the five mutations,
// __type introspection, node(id:), cursor pagination, operation batching). Unknown fields
// are HTTP 200 with an `errors` array naming the field, as GitHub answers them.

import {
  FIXED_MERGED_AT,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  globalId,
  parseGlobalId,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type TokenKind = 'punct' | 'name' | 'int' | 'float' | 'string' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (input.slice(i, i + 3) === '"""') {
        const end = input.indexOf('"""', i + 3);
        const raw = end < 0 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: raw.replace(/\\"""/g, '"""') });
        i = end < 0 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\') {
          const esc = input[j + 1] ?? '';
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '"': '"', '\\': '\\', '/': '/' };
          if (esc === 'u') {
            out += String.fromCharCode(parseInt(input.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            out += map[esc] ?? esc;
            j += 2;
          }
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (c === '-' || /[0-9]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      let isFloat = false;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// AST + parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selectionSet?: SelectionNode[];
}

interface FragmentSpreadNode {
  kind: 'fragmentSpread';
  name: string;
}

interface InlineFragmentNode {
  kind: 'inlineFragment';
  typeCondition?: string;
  selectionSet: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentSpreadNode | InlineFragmentNode;

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation' | 'subscription';
  name?: string;
  variableDefinitions: { name: string; defaultValue?: ValueNode }[];
  selectionSet: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = lex(input);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    return this.tokens[this.pos++]!;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${token.value}`);
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`expected name ${value ?? ''}, got ${token.value}`);
    }
    return token.value;
  }

  parseDocument(): DefinitionNode[] {
    const defs: DefinitionNode[] = [];
    while (this.peek().kind !== 'eof') defs.push(this.parseDefinition());
    return defs;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', variableDefinitions: [], selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      return { kind: 'fragment', name, typeCondition, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && ['query', 'mutation', 'subscription'].includes(token.value)) {
      const operation = this.next().value as 'query' | 'mutation' | 'subscription';
      let name: string | undefined;
      if (this.peek().kind === 'name') name = this.next().value;
      const variableDefinitions = this.parseVariableDefinitions();
      return { kind: 'operation', operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() };
    }
    throw new Error(`unexpected token ${token.value} at document level`);
  }

  private parseVariableDefinitions(): { name: string; defaultValue?: ValueNode }[] {
    const defs: { name: string; defaultValue?: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        this.expectPunct('$');
        const name = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek().kind === 'punct' && this.peek().value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        defs.push({ name, defaultValue });
        if (this.peek().kind === 'eof') break;
      }
      this.expectPunct(')');
    }
    return defs;
  }

  private parseType(): void {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek().kind === 'punct' && this.peek().value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      selections.push(this.parseSelection());
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next.kind === 'name' && next.value !== 'on') {
        return { kind: 'fragmentSpread', name: this.next().value };
      }
      let typeCondition: string | undefined;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | undefined;
    let name = first;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
        if (this.peek().kind === 'eof') break;
      }
      this.expectPunct(')');
    }
    // Directives (@...) are skipped: the suite sends none.
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        let depth = 1;
        while (depth > 0) {
          const t = this.next();
          if (t.kind === 'punct' && t.value === '(') depth += 1;
          else if (t.kind === 'punct' && t.value === ')') depth -= 1;
          else if (t.kind === 'eof') break;
        }
      }
    }
    let selectionSet: SelectionNode[] | undefined;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'field', alias, name, args, selectionSet };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) {
        values.push(this.parseValue());
        if (this.peek().kind === 'eof') break;
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        if (this.peek().kind === 'eof') break;
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

type Variables = Record<string, unknown>;

function resolveValue(node: ValueNode, variables: Variables): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Variables): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// ---------------------------------------------------------------------------------------------
// schema (for __type introspection)
// ---------------------------------------------------------------------------------------------

const SCHEMA: Record<string, { kind: 'OBJECT' | 'ENUM'; fields?: string[]; enumValues?: string[] }> = {
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'labels', 'comments', 'closedAt', 'assignees'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'mergeCommit', 'isDraft'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt', 'updatedAt', 'forkCount', 'stargazerCount'],
  },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION', 'CODE', 'ORGANIZATION', 'PACKAGE', 'MARKETPLACE', 'TOPIC'] },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name', 'email', 'url', 'avatarUrl'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'target', 'associatedPullRequests'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface GqlObject {
  __type: string;
  [key: string]: unknown;
}

class FieldError extends Error {}

interface ExecContext {
  store: Store;
  variables: Variables;
  fragments: Map<string, FragmentNode>;
  errors: { message: string; path?: (string | number)[] }[];
}

function userObject(login: string): GqlObject {
  return { __type: 'User', login, id: globalId('User', login) };
}

function repoObject(repo: Repo): GqlObject {
  return { __type: 'Repository', repo };
}

function issueObject(repo: Repo, issue: Issue): GqlObject {
  return { __type: 'Issue', repo, issue };
}

function pullObject(repo: Repo, pull: Pull): GqlObject {
  return { __type: 'PullRequest', repo, pull };
}

function cursorFor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('issue:')) return null;
    const n = Number(text.slice('issue:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function findRepoById(store: Store, id: number): Repo | null {
  for (const repo of store.repos.values()) if (repo.id === id) return repo;
  return null;
}

function findIssueByGlobalId(store: Store, global: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(global);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.value.split(':');
  const repo = findRepoById(store, Number(repoId));
  if (repo === undefined || repo === null) return null;
  const issue = repo.issues.find((i) => i.number === Number(number));
  return issue === undefined ? null : { repo, issue };
}

function findPullByGlobalId(store: Store, global: string): { repo: Repo; pull: Pull } | null {
  const parsed = parseGlobalId(global);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.value.split(':');
  const repo = findRepoById(store, Number(repoId));
  if (repo === undefined || repo === null) return null;
  const pull = repo.pulls.find((p) => p.number === Number(number));
  return pull === undefined ? null : { repo, pull };
}

function executeSelectionSet(
  ctx: ExecContext,
  obj: GqlObject,
  selections: SelectionNode[],
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".`, path });
        continue;
      }
      if (fragment.typeCondition !== obj.__type) continue;
      Object.assign(out, executeSelectionSet(ctx, obj, fragment.selectionSet, path));
      continue;
    }
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== obj.__type) continue;
      Object.assign(out, executeSelectionSet(ctx, obj, selection.selectionSet, path));
      continue;
    }
    const key = selection.alias ?? selection.name;
    try {
      out[key] = resolveField(ctx, obj, selection, [...path, key]);
    } catch (err) {
      if (err instanceof FieldError) {
        ctx.errors.push({ message: err.message, path: [...path, key] });
        out[key] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function requireSelection(field: FieldNode, typeName: string): SelectionNode[] {
  if (field.selectionSet === undefined) throw new FieldError(`Field "${field.name}" of type "${typeName}" must have a selection of subfields.`);
  return field.selectionSet;
}

function resolveField(ctx: ExecContext, obj: GqlObject, field: FieldNode, path: (string | number)[]): unknown {
  const type = obj.__type;
  if (field.name === '__typename') return type;
  const args = resolveArgs(field, ctx.variables);
  const store = ctx.store;

  if (type === 'Query') {
    if (field.name === 'viewer') {
      const user = userObject(VIEWER_LOGIN);
      return executeSelectionSet(ctx, user, requireSelection(field, 'Query'), path);
    }
    if (field.name === 'repository') {
      const owner = args.owner;
      const name = args.name;
      const repo = typeof owner === 'string' && typeof name === 'string' ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) return null;
      return executeSelectionSet(ctx, repoObject(repo), requireSelection(field, 'Query'), path);
    }
    if (field.name === 'node') {
      const id = args.id;
      if (typeof id !== 'string') return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      let target: GqlObject | null = null;
      if (parsed.kind === 'Repository') {
        const repo = findRepoById(store, Number(parsed.value));
        if (repo !== null) target = repoObject(repo);
      } else if (parsed.kind === 'Issue') {
        const found = findIssueByGlobalId(store, id);
        if (found !== null) target = issueObject(found.repo, found.issue);
      } else if (parsed.kind === 'PullRequest') {
        const found = findPullByGlobalId(store, id);
        if (found !== null) target = pullObject(found.repo, found.pull);
      } else if (parsed.kind === 'User') {
        target = userObject(parsed.value);
      }
      if (target === null) return null;
      return executeSelectionSet(ctx, target, requireSelection(field, 'Query'), path);
    }
    if (field.name === '__type') {
      const name = args.name;
      if (typeof name !== 'string') return null;
      const entry = SCHEMA[name];
      if (entry === undefined) return null;
      return executeSelectionSet(ctx, { __type: '__Type', name, kind: entry.kind, fields: entry.fields ?? [], enumValues: entry.enumValues ?? [] }, requireSelection(field, 'Query'), path);
    }
    throw new FieldError(`Cannot query field "${field.name}" on type "Query".`);
  }

  if (type === 'Mutation') {
    if (field.name === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'Repository' ? findRepoById(store, Number(parsed.value)) : null;
      if (repo === null) throw new FieldError('createIssue: unknown repository.');
      const title = typeof input.title === 'string' ? input.title : '';
      const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
      return executeSelectionSet(ctx, { __type: 'CreateIssuePayload', issue: issueObject(repo, issue) }, requireSelection(field, 'Mutation'), path);
    }
    if (field.name === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? findIssueByGlobalId(store, input.issueId) : null;
      if (found === null) throw new FieldError('closeIssue: unknown issue.');
      found.issue.state = 'closed';
      return executeSelectionSet(ctx, { __type: 'CloseIssuePayload', issue: issueObject(found.repo, found.issue) }, requireSelection(field, 'Mutation'), path);
    }
    if (field.name === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      const repo = parsed !== null && parsed.kind === 'Repository' ? findRepoById(store, Number(parsed.value)) : null;
      if (repo === null) throw new FieldError('createPullRequest: unknown repository.');
      const head = typeof input.headRefName === 'string' ? input.headRefName : '';
      const base = typeof input.baseRefName === 'string' ? input.baseRefName : '';
      const existing = repo.pulls.find((p) => p.headRef === head && p.state === 'open');
      if (existing !== undefined) throw new FieldError('createPullRequest: a pull request already exists for this head branch.');
      const pull = store.createPull(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', head, base);
      if (pull === null) throw new FieldError('createPullRequest: unknown head or base branch.');
      return executeSelectionSet(ctx, { __type: 'CreatePullRequestPayload', pullRequest: pullObject(repo, pull) }, requireSelection(field, 'Mutation'), path);
    }
    if (field.name === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(store, input.pullRequestId) : null;
      if (found === null) throw new FieldError('mergePullRequest: unknown pull request.');
      if (found.pull.state !== 'open') throw new FieldError('mergePullRequest: the pull request is already closed.');
      if (store.mergeConflict(found.repo, found.pull) !== null) throw new FieldError('mergePullRequest: merge conflict.');
      const merged = store.mergePull(found.repo, found.pull);
      if (!merged.ok) throw new FieldError(`mergePullRequest: ${merged.reason}.`);
      return executeSelectionSet(ctx, { __type: 'MergePullRequestPayload', pullRequest: pullObject(found.repo, found.pull) }, requireSelection(field, 'Mutation'), path);
    }
    if (field.name === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.subjectId === 'string' ? findIssueByGlobalId(store, input.subjectId) : null;
      if (found === null) throw new FieldError('addComment: unknown subject.');
      const body = typeof input.body === 'string' ? input.body : '';
      const comment = { id: found.repo.nextCommentId, body };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      const node: GqlObject = {
        __type: 'IssueComment',
        id: globalId('IssueComment', `${found.repo.id}:${found.issue.number}:${comment.id}`),
        body,
      };
      return executeSelectionSet(ctx, { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node } }, requireSelection(field, 'Mutation'), path);
    }
    throw new FieldError(`Cannot query field "${field.name}" on type "Mutation".`);
  }

  if (type === 'User') {
    if (field.name === 'login') return obj.login;
    if (field.name === 'id') return obj.id;
    if (field.name === 'name') return 'ada iversen';
    if (field.name === 'email') return VIEWER_EMAIL;
    if (field.name === 'url') return '';
    throw new FieldError(`Cannot query field "${field.name}" on type "User".`);
  }

  if (type === 'Repository') {
    const repo = obj.repo as Repo;
    switch (field.name) {
      case 'id':
        return globalId('Repository', repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return executeSelectionSet(ctx, userObject(repo.owner), requireSelection(field, 'Repository'), path);
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return executeSelectionSet(ctx, { __type: 'Ref', name: repo.defaultBranch }, requireSelection(field, 'Repository'), path);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.private;
      case 'url':
        return '';
      case 'issue': {
        const number = args.number;
        const issue = typeof number === 'number' ? repo.issues.find((i) => i.number === number) : undefined;
        if (issue === undefined) return null;
        return executeSelectionSet(ctx, issueObject(repo, issue), requireSelection(field, 'Repository'), path);
      }
      case 'issues': {
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        let issues = repo.issues;
        if (states !== null) {
          const wanted = new Set(states.map((s) => String(s).toUpperCase()));
          issues = issues.filter((i) => wanted.has(i.state.toUpperCase()));
        }
        const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
        const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
        const sorted = [...issues].sort((a, b) => (direction === 'DESC' ? b.seq - a.seq : a.seq - b.seq));
        return issueConnection(ctx, repo, sorted, args, field, path);
      }
      case 'pullRequests': {
        const pulls = repo.pulls.filter((p) => p.state === 'open');
        return pullConnection(ctx, repo, pulls, args, field, path);
      }
      case 'pullRequest': {
        const number = args.number;
        const pull = typeof number === 'number' ? repo.pulls.find((p) => p.number === number) : undefined;
        if (pull === undefined) return null;
        return executeSelectionSet(ctx, pullObject(repo, pull), requireSelection(field, 'Repository'), path);
      }
      default:
        throw new FieldError(`Cannot query field "${field.name}" on type "Repository".`);
    }
  }

  if (type === 'Issue') {
    const issue = obj.issue as Issue;
    const repo = obj.repo as Repo;
    switch (field.name) {
      case 'id':
        return globalId('Issue', `${repo.id}:${issue.number}`);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'author':
        return executeSelectionSet(ctx, userObject(VIEWER_LOGIN), requireSelection(field, 'Issue'), path);
      case 'createdAt':
      case 'updatedAt':
        return '2025-01-01T00:00:00Z';
      case 'url':
        return '';
      default:
        throw new FieldError(`Cannot query field "${field.name}" on type "Issue".`);
    }
  }

  if (type === 'PullRequest') {
    const pull = obj.pull as Pull;
    const repo = obj.repo as Repo;
    switch (field.name) {
      case 'id':
        return globalId('PullRequest', `${repo.id}:${pull.number}`);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return store.pullMergeable(repo, pull);
      case 'files': {
        const files = store.pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : files.length;
        const nodes = files.slice(0, first).map((f) => ({ __type: 'PullRequestChangedFile', path: f.filename, additions: f.additions, deletions: f.deletions }));
        return executeSelectionSet(ctx, { __type: 'PullRequestChangedFileConnection', nodes }, requireSelection(field, 'PullRequest'), path);
      }
      case 'author':
        return executeSelectionSet(ctx, userObject(VIEWER_LOGIN), requireSelection(field, 'PullRequest'), path);
      case 'createdAt':
      case 'updatedAt':
        return '2025-01-01T00:00:00Z';
      case 'url':
        return '';
      default:
        throw new FieldError(`Cannot query field "${field.name}" on type "PullRequest".`);
    }
  }

  if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'PullRequestChangedFileConnection') {
    const nodes = (obj.nodes ?? []) as unknown[];
    switch (field.name) {
      case 'nodes':
        return nodes.map((node) => {
          const nodeObj = node as GqlObject;
          return executeSelectionSet(ctx, nodeObj, requireSelection(field, type), path);
        });
      case 'pageInfo': {
        const pageInfo = (obj.pageInfo ?? {}) as Record<string, unknown>;
        return executeSelectionSet(ctx, { __type: 'PageInfo', ...pageInfo }, requireSelection(field, type), path);
      }
      case 'totalCount':
        return nodes.length;
      default:
        throw new FieldError(`Cannot query field "${field.name}" on type "${type}".`);
    }
  }

  if (type === 'PullRequestChangedFile') {
    if (field.name === 'path') return obj.path;
    if (field.name === 'additions') return obj.additions ?? 0;
    if (field.name === 'deletions') return obj.deletions ?? 0;
    throw new FieldError(`Cannot query field "${field.name}" on type "PullRequestChangedFile".`);
  }

  if (type === 'PageInfo') {
    if (field.name === 'hasNextPage') return obj.hasNextPage ?? false;
    if (field.name === 'hasPreviousPage') return false;
    if (field.name === 'endCursor') return obj.endCursor ?? null;
    if (field.name === 'startCursor') return obj.startCursor ?? null;
    throw new FieldError(`Cannot query field "${field.name}" on type "PageInfo".`);
  }

  if (type === 'Ref') {
    if (field.name === 'name') return obj.name;
    throw new FieldError(`Cannot query field "${field.name}" on type "Ref".`);
  }

  if (type === '__Type') {
    switch (field.name) {
      case 'name':
        return obj.name;
      case 'kind':
        return obj.kind;
      case 'description':
        return null;
      case 'fields': {
        const fields = (obj.fields ?? []) as string[];
        const selections = requireSelection(field, '__Type');
        return fields.map((name) => executeSelectionSet(ctx, { __type: '__Field', name }, selections, path));
      }
      case 'enumValues': {
        const values = (obj.enumValues ?? []) as string[];
        const selections = requireSelection(field, '__Type');
        return values.map((name) => executeSelectionSet(ctx, { __type: '__EnumValue', name }, selections, path));
      }
      default:
        throw new FieldError(`Cannot query field "${field.name}" on type "__Type".`);
    }
  }

  if (type === '__Field' || type === '__EnumValue') {
    if (field.name === 'name') return obj.name;
    if (field.name === 'description') return null;
    if (field.name === 'isDeprecated') return false;
    if (field.name === 'deprecationReason') return null;
    throw new FieldError(`Cannot query field "${field.name}" on type "${type}".`);
  }

  if (type === 'CreateIssuePayload' || type === 'CloseIssuePayload') {
    if (field.name === 'issue') {
      const issue = obj.issue as GqlObject;
      return executeSelectionSet(ctx, issue, requireSelection(field, type), path);
    }
    throw new FieldError(`Cannot query field "${field.name}" on type "${type}".`);
  }

  if (type === 'CreatePullRequestPayload' || type === 'MergePullRequestPayload') {
    if (field.name === 'pullRequest') {
      const pull = obj.pullRequest as GqlObject;
      return executeSelectionSet(ctx, pull, requireSelection(field, type), path);
    }
    throw new FieldError(`Cannot query field "${field.name}" on type "${type}".`);
  }

  if (type === 'AddCommentPayload') {
    if (field.name === 'commentEdge') {
      const edge = obj.commentEdge as GqlObject;
      return executeSelectionSet(ctx, edge, requireSelection(field, type), path);
    }
    throw new FieldError(`Cannot query field "${field.name}" on type "${type}".`);
  }

  if (type === 'IssueCommentEdge') {
    if (field.name === 'node') {
      const node = obj.node as GqlObject;
      return executeSelectionSet(ctx, node, requireSelection(field, type), path);
    }
    if (field.name === 'cursor') return null;
    throw new FieldError(`Cannot query field "${field.name}" on type "${type}".`);
  }

  if (type === 'IssueComment') {
    if (field.name === 'id') return obj.id;
    if (field.name === 'body') return obj.body;
    throw new FieldError(`Cannot query field "${field.name}" on type "IssueComment".`);
  }

  throw new FieldError(`Cannot query field "${field.name}" on type "${type}".`);
}

function issueConnection(
  ctx: ExecContext,
  repo: Repo,
  sorted: Issue[],
  args: Record<string, unknown>,
  field: FieldNode,
  path: (string | number)[],
): unknown {
  const after = cursorNumber(args.after);
  let items = sorted;
  if (after !== null) {
    // The cursor names the last issue seen, so keep only what follows it in this order.
    const index = sorted.findIndex((i) => i.number === after);
    items = index < 0 ? sorted : sorted.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : items.length;
  const page = items.slice(0, first);
  const hasNextPage = items.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
  const connection: GqlObject = {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueObject(repo, issue)),
    pageInfo: { hasNextPage, endCursor, startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null },
  };
  return executeSelectionSet(ctx, connection, requireSelection(field, 'Repository'), path);
}

function pullConnection(
  ctx: ExecContext,
  repo: Repo,
  pulls: Pull[],
  args: Record<string, unknown>,
  field: FieldNode,
  path: (string | number)[],
): unknown {
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  const connection: GqlObject = {
    __type: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(repo, pull)),
    pageInfo: { hasNextPage: pulls.length > page.length, endCursor: null, startCursor: null },
  };
  return executeSelectionSet(ctx, connection, requireSelection(field, 'Repository'), path);
}

// ---------------------------------------------------------------------------------------------
// one operation / batching / HTTP
// ---------------------------------------------------------------------------------------------

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function executeOperation(store: Store, query: string, variables: Variables, operationName?: string): { data: unknown; errors?: { message: string; path?: (string | number)[] }[] } {
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Syntax error' }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const def of definitions) {
    if (def.kind === 'fragment') fragments.set(def.name, def);
    else operations.push(def);
  }
  let operation: OperationNode | undefined;
  if (operations.length === 1) operation = operations[0];
  else if (operationName !== undefined) operation = operations.find((o) => o.name === operationName);
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation to execute.' }] };
  }
  const vars: Variables = { ...variables };
  for (const def of operation.variableDefinitions) {
    if (!(def.name in vars) && def.defaultValue !== undefined) vars[def.name] = resolveValue(def.defaultValue, vars);
  }
  const ctx: ExecContext = { store, variables: vars, fragments, errors: [] };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: GqlObject = { __type: rootType };
  let data: Record<string, unknown>;
  try {
    data = executeSelectionSet(ctx, root, operation.selectionSet, []);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export function handleGraphQL(store: Store, rawBody: Buffer): GraphQLReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { status: 400, body: { message: 'Malformed JSON body' } };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (typeof entry !== 'object' || entry === null || typeof (entry as Record<string, unknown>).query !== 'string') {
        return { data: null, errors: [{ message: 'Each batched operation needs a query string.' }] };
      }
      const op = entry as Record<string, unknown>;
      return executeOperation(store, op.query as string, (op.variables ?? {}) as Variables, typeof op.operationName === 'string' ? op.operationName : undefined);
    });
    return { status: 200, body: results };
  }
  if (typeof parsed !== 'object' || parsed === null || typeof (parsed as Record<string, unknown>).query !== 'string') {
    return { status: 400, body: { message: 'A GraphQL request needs a query string' } };
  }
  const op = parsed as Record<string, unknown>;
  const result = executeOperation(store, op.query as string, (op.variables ?? {}) as Variables, typeof op.operationName === 'string' ? op.operationName : undefined);
  return { status: 200, body: result };
}

// Keep the merged-at import referenced (merged pull requests report it in REST).
void FIXED_MERGED_AT;
