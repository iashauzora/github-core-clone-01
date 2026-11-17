// graphql.ts: a small GraphQL parser + executor for POST /api/graphql — the documented
// surface only: viewer, repository (issue/issues/pullRequest/pullRequests), node, the five
// mutations, batched operations (a JSON array body), and __type introspection over a static
// schema table. Global ids are opaque base64 "Type:key" strings, stable across reads.

import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Forge, type Issue, type Pull, type Repo } from './store.ts';

// ------------------------------------------------------------------ ids

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

// ------------------------------------------------------------------ lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < source.length) {
    const c = source[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=!$@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1]!;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  return tokens;
}

// ------------------------------------------------------------------ parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos++];
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected an operation or fragment');
      if (token.value === 'query' || token.value === 'mutation') {
        this.next();
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && maybeName.kind === 'name') name = this.expectName();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.skipPunct('(')) {
          while (!this.skipPunct(')')) {
            this.expectPunct('$');
            const varName = this.expectName();
            this.expectPunct(':');
            this.parseType();
            if (this.skipPunct('=')) variableDefaults.set(varName, this.parseValue());
            this.skipDirectives();
          }
        }
        this.skipDirectives();
        operations.push({ type: token.value, name, variableDefaults, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.value === 'fragment') {
        this.next();
        const fragName = this.expectName();
        const onToken = this.expectName();
        if (onToken !== 'on') throw new Error('expected "on" in fragment definition');
        this.expectName(); // type condition
        this.skipDirectives();
        fragments.set(fragName, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected definition ${token.value}`);
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skipPunct('[')) {
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.skipPunct('@')) {
      this.expectName();
      if (this.skipPunct('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name' && nextToken.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args: Array<{ name: string; value: ValueNode }> = [];
      if (this.skipPunct('(')) {
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      this.skipDirectives();
      let selectionSet: SelectionNode[] | null = null;
      const brace = this.peek();
      if (brace !== undefined && brace.kind === 'punct' && brace.value === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.skipPunct(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value token');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
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
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema (introspection data)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'search', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description',
    'isPrivate', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'author', 'repository', 'createdAt', 'updatedAt', 'url', 'closed'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'author', 'repository', 'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'target'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'url'],
  Label: ['name', 'color', 'description'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  CommentEdge: ['node', 'cursor'],
  Node: ['id'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  PullRequestOrderField: ['CREATED_AT', 'UPDATED_AT'],
};

// ------------------------------------------------------------------ executor

type Source = Record<string, unknown> & { __typename: string };

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: Array<{ message: string }>;
}

class FieldError extends Error {}

function src(typename: string, fields: Record<string, unknown>): Source {
  return { __typename: typename, ...fields };
}

function viewerSource(): Source {
  return src('User', { login: VIEWER_LOGIN, id: globalId('User', String(VIEWER_ID)), name: VIEWER_NAME, email: VIEWER_EMAIL });
}

function repoSource(repo: Repo): Source {
  return src('Repository', { repo });
}

function issueSource(repo: Repo, issue: Issue): Source {
  return src('Issue', { repo, issue });
}

function pullSource(repo: Repo, pull: Pull): Source {
  return src('PullRequest', { repo, pull });
}

function cursorOf(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberOfCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function connection<T extends { number: number }>(
  items: readonly T[],
  args: Record<string, unknown>,
  wrap: (item: T) => Source,
): Source {
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : 10;
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    const afterNumber = numberOfCursor(args.after);
    const index = afterNumber === null ? -1 : items.findIndex((item) => item.number === afterNumber);
    start = index < 0 ? items.length : index + 1;
  }
  const page = items.slice(start, start + first);
  const hasNextPage = start + first < items.length;
  const pageInfo = src('PageInfo', {
    hasNextPage,
    hasPreviousPage: start > 0,
    endCursor: page.length > 0 ? cursorOf(page[page.length - 1]!.number) : null,
    startCursor: page.length > 0 ? cursorOf(page[0]!.number) : null,
  });
  return src('Connection', { nodes: page.map(wrap), pageInfo, totalCount: items.length });
}

type Resolver = (ctx: ExecContext, source: Source, args: Record<string, unknown>) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: () => viewerSource(),
    repository: (ctx, _source, args) => {
      const repo = ctx.forge.findRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoSource(repo);
    },
    node: (ctx, _source, args) => {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      if (decoded.type === 'Repository') {
        const repo = ctx.forge.repoById(Number(decoded.key));
        return repo === undefined ? null : repoSource(repo);
      }
      if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
        const [repoId, number] = decoded.key.split(':').map(Number);
        const repo = ctx.forge.repoById(repoId ?? NaN);
        if (repo === undefined) return null;
        if (decoded.type === 'Issue') {
          const issue = repo.issues.get(number ?? NaN);
          return issue === undefined ? null : issueSource(repo, issue);
        }
        const pull = repo.pulls.get(number ?? NaN);
        return pull === undefined ? null : pullSource(repo, pull);
      }
      if (decoded.type === 'User') return viewerSource();
      return null;
    },
    search: () => src('SearchResultItemConnection', { nodes: [], pageInfo: src('PageInfo', { hasNextPage: false, hasPreviousPage: false, endCursor: null, startCursor: null }), totalCount: 0 }),
  },
  Mutation: {
    createIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? ctx.forge.repoById(Number(decoded.key)) : undefined;
      if (repo === undefined) throw new FieldError('repository not found for createIssue');
      const issue = ctx.forge.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return src('CreateIssuePayload', { issue: issueSource(repo, issue) });
    },
    closeIssue: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.type !== 'Issue') throw new FieldError('issue not found for closeIssue');
      const [repoId, number] = decoded.key.split(':').map(Number);
      const repo = ctx.forge.repoById(repoId ?? NaN);
      const issue = repo?.issues.get(number ?? NaN);
      if (repo === undefined || issue === undefined) throw new FieldError('issue not found for closeIssue');
      issue.state = 'closed';
      issue.updatedSeq = ctx.forge.tick();
      return src('CloseIssuePayload', { issue: issueSource(repo, issue) });
    },
    createPullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? ctx.forge.repoById(Number(decoded.key)) : undefined;
      if (repo === undefined) throw new FieldError('repository not found for createPullRequest');
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? '');
      if (ctx.forge.branchTip(repo, head) === undefined) throw new FieldError(`head ref ${head} does not exist`);
      if (ctx.forge.branchTip(repo, base) === undefined) throw new FieldError(`base ref ${base} does not exist`);
      const pull = ctx.forge.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      return src('CreatePullRequestPayload', { pullRequest: pullSource(repo, pull) });
    },
    mergePullRequest: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.type !== 'PullRequest') throw new FieldError('pull request not found for mergePullRequest');
      const [repoId, number] = decoded.key.split(':').map(Number);
      const repo = ctx.forge.repoById(repoId ?? NaN);
      const pull = repo?.pulls.get(number ?? NaN);
      if (repo === undefined || pull === undefined) throw new FieldError('pull request not found for mergePullRequest');
      if (!pull.merged) ctx.forge.squashMerge(repo, pull);
      return src('MergePullRequestPayload', { pullRequest: pullSource(repo, pull) });
    },
    addComment: (ctx, _source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.type !== 'Issue') throw new FieldError('subject not found for addComment');
      const [repoId, number] = decoded.key.split(':').map(Number);
      const repo = ctx.forge.repoById(repoId ?? NaN);
      const issue = repo?.issues.get(number ?? NaN);
      if (repo === undefined || issue === undefined) throw new FieldError('subject not found for addComment');
      const comment = { id: ctx.forge.allocateCommentId(), body: String(input.body ?? ''), seq: ctx.forge.tick() };
      issue.comments.push(comment);
      const node = src('IssueComment', {
        id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`),
        body: comment.body,
      });
      return src('AddCommentPayload', { commentEdge: src('CommentEdge', { node }) });
    },
  },
  User: {
    login: (_ctx, source) => source.login,
    id: (_ctx, source) => source.id,
    name: (_ctx, source) => source.name,
    email: (_ctx, source) => source.email,
  },
  Repository: {
    id: (_ctx, source) => repoGlobalId(source.repo as Repo),
    databaseId: (_ctx, source) => (source.repo as Repo).id,
    name: (_ctx, source) => (source.repo as Repo).name,
    nameWithOwner: (_ctx, source) => `${(source.repo as Repo).owner}/${(source.repo as Repo).name}`,
    owner: (_ctx, source) => src('User', { login: (source.repo as Repo).owner, id: globalId('User', String(VIEWER_ID)), name: VIEWER_NAME, email: VIEWER_EMAIL }),
    defaultBranchRef: (_ctx, source) => src('Ref', { name: (source.repo as Repo).defaultBranch }),
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (_ctx, source) => (source.repo as Repo).description,
    isPrivate: (_ctx, source) => (source.repo as Repo).isPrivate,
    issue: (_ctx, source, args) => {
      const repo = source.repo as Repo;
      const issue = repo.issues.get(Number(args.number));
      return issue === undefined ? null : issueSource(repo, issue);
    },
    issues: (ctx, source, args) => {
      const repo = source.repo as Repo;
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : null;
      if (states !== null) {
        const wanted = new Set(states.map((state) => String(state).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const orderBy = (args.orderBy ?? null) as Record<string, unknown> | null;
      const direction = orderBy !== null && typeof orderBy.direction === 'string' ? orderBy.direction : 'DESC';
      issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
      const conn = connection(issues, args, (issue) => issueSource(repo, issue));
      conn.__typename = 'IssueConnection';
      return conn;
    },
    pullRequest: (_ctx, source, args) => {
      const repo = source.repo as Repo;
      const pull = repo.pulls.get(Number(args.number));
      return pull === undefined ? null : pullSource(repo, pull);
    },
    pullRequests: (_ctx, source, args) => {
      const repo = source.repo as Repo;
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
      const wanted = new Set(states.map((state) => String(state).toUpperCase()));
      pulls = pulls.filter((pull) => {
        const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
        return wanted.has(state);
      });
      pulls.sort((a, b) => b.number - a.number);
      const conn = connection(pulls, args, (pull) => pullSource(repo, pull));
      conn.__typename = 'PullRequestConnection';
      return conn;
    },
  },
  Issue: {
    id: (_ctx, source) => issueGlobalId(source.repo as Repo, source.issue as Issue),
    number: (_ctx, source) => (source.issue as Issue).number,
    title: (_ctx, source) => (source.issue as Issue).title,
    body: (_ctx, source) => (source.issue as Issue).body,
    state: (_ctx, source) => (source.issue as Issue).state.toUpperCase(),
    closed: (_ctx, source) => (source.issue as Issue).state === 'closed',
    repository: (_ctx, source) => repoSource(source.repo as Repo),
    author: () => viewerSource(),
    labels: (_ctx, source) => {
      const repo = source.repo as Repo;
      const issue = source.issue as Issue;
      return src('LabelConnection', {
        nodes: issue.labels.map((name) => src('Label', { name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? null })),
      });
    },
    comments: (_ctx, source) => {
      const repo = source.repo as Repo;
      const issue = source.issue as Issue;
      return src('IssueCommentConnection', {
        nodes: issue.comments.map((comment) =>
          src('IssueComment', { id: globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`), body: comment.body }),
        ),
        totalCount: issue.comments.length,
      });
    },
  },
  PullRequest: {
    id: (_ctx, source) => pullGlobalId(source.repo as Repo, source.pull as Pull),
    number: (_ctx, source) => (source.pull as Pull).number,
    title: (_ctx, source) => (source.pull as Pull).title,
    body: (_ctx, source) => (source.pull as Pull).body,
    state: (_ctx, source) => {
      const pull = source.pull as Pull;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (_ctx, source) => (source.pull as Pull).merged,
    mergeable: (ctx, source) => {
      const repo = source.repo as Repo;
      const pull = source.pull as Pull;
      if (pull.merged || pull.state === 'closed') return 'UNKNOWN';
      return ctx.forge.pullMergePlan(repo, pull).conflict ? 'CONFLICTING' : 'MERGEABLE';
    },
    headRefName: (_ctx, source) => (source.pull as Pull).headRef,
    baseRefName: (_ctx, source) => (source.pull as Pull).baseRef,
    repository: (_ctx, source) => repoSource(source.repo as Repo),
    author: () => viewerSource(),
    files: (ctx, source, args) => {
      const repo = source.repo as Repo;
      const pull = source.pull as Pull;
      const files = ctx.forge.pullFiles(repo, pull).map((file, index) => ({
        number: index + 1,
        item: src('PullRequestChangedFile', {
          path: file.filename,
          additions: file.additions,
          deletions: file.deletions,
          changeType: file.status.toUpperCase(),
        }),
      }));
      const conn = connection(files, args, (entry) => entry.item);
      conn.__typename = 'PullRequestChangedFileConnection';
      return conn;
    },
  },
  Ref: {
    name: (_ctx, source) => source.name,
  },
  PageInfo: {
    hasNextPage: (_ctx, source) => source.hasNextPage,
    hasPreviousPage: (_ctx, source) => source.hasPreviousPage,
    endCursor: (_ctx, source) => source.endCursor,
    startCursor: (_ctx, source) => source.startCursor,
  },
};

// Connection-ish types share the nodes/pageInfo/totalCount shape.
for (const typeName of ['IssueConnection', 'PullRequestConnection', 'PullRequestChangedFileConnection', 'SearchResultItemConnection', 'LabelConnection', 'IssueCommentConnection']) {
  RESOLVERS[typeName] = {
    nodes: (_ctx, source) => source.nodes,
    pageInfo: (_ctx, source) => source.pageInfo,
    totalCount: (_ctx, source) => source.totalCount,
  };
}
RESOLVERS['PullRequestChangedFile'] = {
  path: (_ctx, source) => source.path,
  additions: (_ctx, source) => source.additions,
  deletions: (_ctx, source) => source.deletions,
  changeType: (_ctx, source) => source.changeType,
};
RESOLVERS['IssueComment'] = {
  id: (_ctx, source) => source.id,
  body: (_ctx, source) => source.body,
  author: () => viewerSource(),
};
RESOLVERS['Label'] = {
  name: (_ctx, source) => source.name,
  color: (_ctx, source) => source.color,
  description: (_ctx, source) => source.description,
};
RESOLVERS['CreateIssuePayload'] = { issue: (_ctx, source) => source.issue };
RESOLVERS['CloseIssuePayload'] = { issue: (_ctx, source) => source.issue };
RESOLVERS['CreatePullRequestPayload'] = { pullRequest: (_ctx, source) => source.pullRequest };
RESOLVERS['MergePullRequestPayload'] = { pullRequest: (_ctx, source) => source.pullRequest };
RESOLVERS['AddCommentPayload'] = { commentEdge: (_ctx, source) => source.commentEdge };
RESOLVERS['CommentEdge'] = { node: (_ctx, source) => source.node };

function typeSource(typeName: string): Source | null {
  const fields = TYPE_FIELDS[typeName];
  const enums = TYPE_ENUMS[typeName];
  if (fields === undefined && enums === undefined) return null;
  return src('__Type', {
    name: typeName,
    fields: (fields ?? []).map((name) => src('__Field', { name })),
    enumValues: (enums ?? []).map((name) => src('__EnumValue', { name })),
  });
}

function executeSelectionSet(ctx: ExecContext, source: Source, typeName: string, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(ctx, source, typeName, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(ctx, source, typeName, fragment));
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    if (selection.name === '__type' && typeName === 'Query') {
      const args = resolveArgs(ctx, selection);
      const type = typeSource(String(args.name ?? ''));
      out[key] = type === null ? null : executeSelectionSet(ctx, type, '__Type', selection.selectionSet ?? []);
      continue;
    }
    if (selection.name === '__schema') {
      out[key] = null;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[selection.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args = resolveArgs(ctx, selection);
    let value: unknown;
    try {
      value = resolver(ctx, source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, selection);
  }
  return out;
}

function resolveArgs(ctx: ExecContext, field: FieldNode): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
  return args;
}

function completeValue(ctx: ExecContext, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (field.selectionSet === null) return value;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, field));
  if (typeof value === 'object') {
    const source = value as Source;
    return executeSelectionSet(ctx, source, source.__typename, field.selectionSet);
  }
  return value;
}

// __Type / __Field / __EnumValue resolvers.
RESOLVERS['__Type'] = {
  name: (_ctx, source) => source.name,
  fields: (_ctx, source) => source.fields,
  enumValues: (_ctx, source) => source.enumValues,
  kind: (_ctx, source) => (TYPE_ENUMS[String(source.name)] !== undefined ? 'ENUM' : 'OBJECT'),
  description: () => null,
};
RESOLVERS['__Field'] = { name: (_ctx, source) => source.name };
RESOLVERS['__EnumValue'] = { name: (_ctx, source) => source.name };

/** Execute one operation body ({query, variables, operationName}); returns the GraphQL envelope. */
export function executeGraphQL(forge: Forge, body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { errors: [{ message: 'GraphQL request body must be an object' }] };
  }
  const request = body as Record<string, unknown>;
  const query = String(request.query ?? '');
  const variables: Record<string, unknown> = {};
  if (typeof request.variables === 'object' && request.variables !== null) {
    Object.assign(variables, request.variables as Record<string, unknown>);
  }
  let document: Document;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  let operation: Operation | undefined;
  const operationName = typeof request.operationName === 'string' ? request.operationName : null;
  if (operationName !== null) operation = document.operations.find((op) => op.name === operationName);
  else if (document.operations.length === 1) operation = document.operations[0];
  else operation = document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation found' }] };
  for (const [name, defaultNode] of operation.variableDefaults) {
    if (variables[name] === undefined) variables[name] = resolveValue(defaultNode, variables);
  }
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root = src(rootType, {});
  const data = executeSelectionSet(ctx, root, rootType, operation.selectionSet);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
