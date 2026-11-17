// mcp.ts: the Model Context Protocol endpoint at /mcp — JSON-RPC 2.0 over Streamable HTTP.
// Both eras work: modern `server/discover` (2026-07-28) and the legacy initialize handshake
// (2025-11-25 and earlier, with an Mcp-Session-Id). The six tools act on the same store as
// REST and git; tools/list is a fixed array, byte-identical across calls.

import { issueView, pullView, repoView } from './rest.ts';
import type { Forge } from './store.ts';

export interface McpReply {
  status: number;
  body: string; // '' = no body
  headers?: Record<string, string>;
}

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SESSION_ID = 'forge-session-1';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  required: string[];
  run: (forge: Forge, args: Record<string, unknown>) => Record<string, unknown> | unknown[];
}

class ToolFailure extends Error {}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === 'string' ? value : '';
}

function repoOf(forge: Forge, args: Record<string, unknown>) {
  const repo = forge.findRepo(str(args, 'owner'), str(args, 'repo'));
  if (repo === undefined) throw new ToolFailure(`repository ${str(args, 'owner')}/${str(args, 'repo')} not found`);
  return repo;
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
    required: ['name'],
    run: (forge, args) => {
      const name = str(args, 'name');
      const created = forge.createRepo(name, args.private !== false, str(args, 'description'));
      if (created === 'exists') throw new ToolFailure(`a repository named ${name} already exists`);
      return repoView(forge, created);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
      },
      required: ['owner', 'repo'],
    },
    required: ['owner', 'repo'],
    run: (forge, args) => repoView(forge, repoOf(forge, args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
    required: ['owner', 'repo', 'title'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const issue = forge.createIssue(repo, str(args, 'title'), str(args, 'body'), []);
      return issueView(forge, repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
    required: ['owner', 'repo'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const state = str(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return issues.map((issue) => issueView(forge, repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const head = str(args, 'head');
      const base = str(args, 'base');
      if (forge.branchTip(repo, head) === undefined) throw new ToolFailure(`head branch ${head} does not exist`);
      if (forge.branchTip(repo, base) === undefined) throw new ToolFailure(`base branch ${base} does not exist`);
      const pull = forge.createPull(repo, str(args, 'title'), str(args, 'body'), head, base);
      return pullView(forge, repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash)',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login' },
        repo: { type: 'string', description: 'The repository name' },
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (forge, args) => {
      const repo = repoOf(forge, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (pull === undefined) throw new ToolFailure(`pull request #${number} not found`);
      if (!pull.merged) {
        const sha = forge.squashMerge(repo, pull);
        if (sha === null) throw new ToolFailure(`pull request #${number} is not mergeable: conflict`);
      }
      return pullView(forge, repo, pull);
    },
  },
];

const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
};

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Handle one POST /mcp body. Auth has already been enforced by the router. */
export function handleMcp(forge: Forge, method: string, bodyText: string): McpReply {
  if (method === 'DELETE') return { status: 204, body: '' };
  if (method !== 'POST') return rpcError(null, -32601, 'Method not found', 405);

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const entry of parsed) {
      const reply = handleOne(forge, entry);
      if (reply !== null) replies.push(JSON.parse(reply.body));
    }
    return { status: 200, body: JSON.stringify(replies) };
  }
  const reply = handleOne(forge, parsed);
  if (reply === null) return { status: 202, body: '' };
  return reply;
}

function handleOne(forge: Forge, message: unknown): McpReply | null {
  if (typeof message !== 'object' || message === null) return rpcError(null, -32600, 'Invalid Request', 400);
  const request = message as Record<string, unknown>;
  const method = String(request.method ?? '');
  const id = request.id;
  const isNotification = id === undefined;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      const reply = rpcResult(id, { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
      reply.headers = { 'mcp-session-id': SESSION_ID };
      return reply;
    }
    case 'ping':
      return isNotification ? null : rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = String(params.name ?? '');
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return rpcError(id, -32602, `Missing required arguments: ${missing.join(', ')}`);
      try {
        return rpcResult(id, toolResult(tool.run(forge, args)));
      } catch (err) {
        if (err instanceof ToolFailure) return rpcResult(id, toolErrorResult(err.message));
        throw err;
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}
