// rest.ts: the REST v3 surface under /api/v3. Every reply is JSON with a `message` on
// errors; the router in app.ts adds the X-GitHub-Request-Id header and the auth gate.

import { ZERO_OID, isOid, parseCommit } from './gitcore.ts';
import { VIEWER_EMAIL, VIEWER_ID, VIEWER_LOGIN, VIEWER_NAME, type Forge, type Issue, type Pull, type Repo } from './store.ts';

export interface Reply {
  status: number;
  body?: unknown; // undefined = empty body (204)
  headers?: Record<string, string>;
}

export interface RestRequest {
  method: string;
  /** Decoded path segments after /api/v3. */
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown> | null;
  /** The request's own origin, for absolute pagination links. */
  origin: string;
  /** The full path (no query), for pagination links. */
  path: string;
}

const ok = (body: unknown, status = 200): Reply => ({ status, body });
const fail = (status: number, message: string): Reply => ({ status, body: { message } });
const notFound = (): Reply => fail(404, 'Not Found');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function userView(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', site_admin: false, name: VIEWER_NAME, email: VIEWER_EMAIL };
}

export function repoView(forge: Forge, repo: Repo): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: fullName,
    private: repo.isPrivate,
    owner: userView(),
    html_url: `https://forge.invalid/${fullName}`,
    description: repo.description,
    fork: false,
    created_at: forge.isoOf(repo.createdSeq),
    updated_at: forge.isoOf(repo.createdSeq),
    pushed_at: forge.isoOf(repo.createdSeq),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    default_branch: repo.defaultBranch,
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

function labelView(forge: Forge, repo: Repo, name: string): Record<string, unknown> | null {
  const label = repo.labels.get(name);
  if (label === undefined) return null;
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueView(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelView(forge, repo, name)).filter((view) => view !== null),
    user: userView(),
    assignees: [],
    comments: issue.comments.length,
    created_at: forge.isoOf(issue.createdSeq),
    updated_at: forge.isoOf(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? forge.isoOf(issue.updatedSeq) : null,
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullView(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = forge.branchTip(repo, pull.headRef) ?? pull.headShaAtCreate;
  const baseSha = forge.branchTip(repo, pull.baseRef) ?? ZERO_OID;
  const refView = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userView(),
    repo: repoView(forge, repo),
  });
  return {
    id: pull.gid,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: refView(pull.headRef, headSha),
    base: refView(pull.baseRef, baseSha),
    user: userView(),
    labels: [],
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : forge.isoOf(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    created_at: forge.isoOf(pull.createdSeq),
    updated_at: forge.isoOf(pull.updatedSeq),
    html_url: `https://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function commentView(forge: Forge, comment: { id: number; body: string; seq: number }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: userView(),
    created_at: forge.isoOf(comment.seq),
    updated_at: forge.isoOf(comment.seq),
  };
}

/** Slice a list by ?page / ?per_page and build the Link header (rel="next"/"last") when more remain. */
function paginate<T>(req: RestRequest, items: readonly T[]): { page: T[]; headers?: Record<string, string> } {
  const perPageRaw = Number(req.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.max(1, Math.trunc(perPageRaw))) : 30;
  const pageRaw = Number(req.query.get('page') ?? '1');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.trunc(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const link = (target: number, rel: string): string => {
      const params = new URLSearchParams(req.query);
      params.set('page', String(target));
      params.set('per_page', String(perPage));
      return `<${req.origin}${req.path}?${params.toString()}>; rel="${rel}"`;
    };
    headers.link = `${link(page + 1, 'next')}, ${link(lastPage, 'last')}`;
  }
  return { page: slice, headers };
}

// ------------------------------------------------------------------ routing

export function handleRest(forge: Forge, req: RestRequest): Reply {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method === 'GET') {
      return {
        status: 200,
        body: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' },
        headers: { 'x-oauth-scopes': 'repo, read:org' },
      };
    }
    return notFound();
  }

  if (seg[0] === 'meta' && seg.length === 1) {
    if (method === 'GET') return ok({ installed_version: 'forge-1.0.0', github_developer_version: 'forge' });
    return notFound();
  }

  if (seg[0] === 'user' && seg.length === 1) {
    if (method === 'GET') return ok(userView());
    return notFound();
  }

  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'GET') {
      const { page, headers } = paginate(req, forge.viewerRepos());
      return { status: 200, body: page.map((repo) => repoView(forge, repo)), headers };
    }
    if (method === 'POST') return createRepo(forge, req);
    return notFound();
  }

  if (seg[0] === 'repos' && seg.length >= 3) {
    const repo = forge.findRepo(seg[1]!, seg[2]!);
    if (repo === undefined) return notFound();
    return handleRepo(forge, repo, req, seg.slice(3));
  }

  return notFound();
}

function createRepo(forge: Forge, req: RestRequest): Reply {
  const body = req.body ?? {};
  const name = str(body.name);
  if (name === '' || /[\s/]/.test(name)) return fail(422, 'Repository creation failed: name is invalid');
  const created = forge.createRepo(name, body.private !== false, str(body.description));
  if (created === 'exists') return fail(422, `Repository creation failed: a repository named ${name} already exists on this account`);
  return ok(repoView(forge, created), 201);
}

function handleRepo(forge: Forge, repo: Repo, req: RestRequest, rest: string[]): Reply {
  const method = req.method;
  if (rest.length === 0) {
    if (method === 'GET') return ok(repoView(forge, repo));
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      return ok(repoView(forge, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204 };
    }
    return notFound();
  }

  const [head, ...tail] = rest as [string, ...string[]];

  if (head === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      const branches = forge
        .sortedRefNames(repo)
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref)! }, protected: false }));
      const { page, headers } = paginate(req, branches);
      return { status: 200, body: page, headers };
    }
    if (tail.length >= 1 && method === 'GET') {
      const branch = tail.join('/');
      const tip = forge.branchTip(repo, branch);
      if (tip === undefined) return notFound();
      return ok({ name: branch, commit: { sha: tip }, protected: false });
    }
    return notFound();
  }

  if (head === 'commits') {
    if (method !== 'GET' || tail.length !== 0) return notFound();
    const shaParam = req.query.get('sha');
    let tip: string | undefined;
    if (shaParam === null || shaParam === '') tip = forge.branchTip(repo, repo.defaultBranch);
    else if (isOid(shaParam) && forge.commitInfo(shaParam) !== null) tip = shaParam;
    else tip = forge.branchTip(repo, shaParam) ?? repo.refs.get(shaParam);
    if (tip === undefined) return fail(409, 'Git Repository is empty.');
    const peeled = forge.peelToCommit(tip);
    if (peeled === null) return notFound();
    const items = forge.listCommits(peeled).map((oid) => {
      const info = parseCommit(forge.getObject(oid)!.data);
      const person = (line: string): Record<string, unknown> => {
        const match = /^(.*?) <(.*?)> (\d+) /.exec(line);
        return {
          name: match?.[1] ?? '',
          email: match?.[2] ?? '',
          date: new Date(Number(match?.[3] ?? '0') * 1000).toISOString(),
        };
      };
      return {
        sha: oid,
        commit: {
          message: info.message.replace(/\n$/, ''),
          tree: { sha: info.tree },
          author: person(info.author),
          committer: person(info.committer),
        },
        parents: info.parents.map((parent) => ({ sha: parent })),
        html_url: `https://forge.invalid/${repo.owner}/${repo.name}/commit/${oid}`,
      };
    });
    const { page, headers } = paginate(req, items);
    return { status: 200, body: page, headers };
  }

  if (head === 'contents') return handleContents(forge, repo, req, tail.join('/'));
  if (head === 'labels') return handleLabels(forge, repo, req, tail);
  if (head === 'issues') return handleIssues(forge, repo, req, tail);
  if (head === 'pulls') return handlePulls(forge, repo, req, tail);
  if (head === 'git' && tail[0] === 'refs') return handleGitRefs(forge, repo, req, tail.slice(1));
  return notFound();
}

// ------------------------------------------------------------------ contents

/** Resolve a ?ref / branch name / oid to a commit oid. */
function resolveCommit(forge: Forge, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') {
    const tip = forge.branchTip(repo, repo.defaultBranch);
    return tip === undefined ? null : forge.peelToCommit(tip);
  }
  const branchTip = forge.branchTip(repo, ref);
  if (branchTip !== undefined) return forge.peelToCommit(branchTip);
  const anyRef = repo.refs.get(ref) ?? repo.refs.get(`refs/tags/${ref}`);
  if (anyRef !== undefined) return forge.peelToCommit(anyRef);
  if (isOid(ref)) return forge.peelToCommit(ref);
  return null;
}

function handleContents(forge: Forge, repo: Repo, req: RestRequest, path: string): Reply {
  const method = req.method;
  if (method === 'GET') {
    const commit = resolveCommit(forge, repo, req.query.get('ref'));
    if (commit === null) return notFound();
    const info = forge.commitInfo(commit);
    if (info === null) return notFound();
    if (path !== '') {
      const blobOid = forge.blobAtPath(info.tree, path);
      if (blobOid !== null) {
        const blob = forge.getObject(blobOid)!;
        return ok({
          name: path.split('/').pop(),
          path,
          sha: blobOid,
          size: blob.data.length,
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
        });
      }
    }
    const listing = forge.dirListing(info.tree, path);
    if (listing === null) return notFound();
    return ok(
      listing.map((entry) => {
        const view: Record<string, unknown> = { name: entry.name, path: entry.path, sha: entry.oid, type: entry.type };
        if (entry.type === 'file') view.size = forge.getObject(entry.oid)?.data.length ?? 0;
        return view;
      }),
    );
  }

  if (method === 'PUT') {
    const body = req.body ?? {};
    const message = str(body.message);
    const contentBase64 = str(body.content);
    if (message === '' || contentBase64 === '') return fail(422, 'Validation Failed: message and content are required');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = forge.branchTip(repo, branch);
    if (tip === undefined && branch !== repo.defaultBranch) return fail(404, 'Branch not found');
    let existing: string | null = null;
    if (tip !== undefined) {
      const info = forge.commitInfo(tip);
      if (info !== null) existing = forge.blobAtPath(info.tree, path);
    }
    if (existing !== null) {
      if (typeof body.sha !== 'string' || body.sha === '') return fail(422, '"sha" wasn\'t supplied');
      if (body.sha !== existing) return fail(409, `${path} does not match ${body.sha}`);
    }
    const bytes = Buffer.from(contentBase64.replace(/\s+/g, ''), 'base64');
    const commit = forge.commitChanges(repo, branch, new Map([[path, bytes]]), message.endsWith('\n') ? message : `${message}\n`);
    if (commit === null) return fail(404, 'Branch not found');
    const blobOid = forge.putObject('blob', bytes);
    return ok(
      {
        content: { name: path.split('/').pop(), path, sha: blobOid, size: bytes.length, type: 'file', encoding: 'base64' },
        commit: { sha: commit, message },
      },
      existing !== null ? 200 : 201,
    );
  }

  if (method === 'DELETE') {
    const body = req.body ?? {};
    const message = str(body.message) || 'Delete file';
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const tip = forge.branchTip(repo, branch);
    if (tip === undefined) return fail(404, 'Branch not found');
    const info = forge.commitInfo(tip);
    const existing = info === null ? null : forge.blobAtPath(info.tree, path);
    if (existing === null) return notFound();
    if (typeof body.sha === 'string' && body.sha !== '' && body.sha !== existing) return fail(409, `${path} does not match ${body.sha}`);
    const commit = forge.commitChanges(repo, branch, new Map([[path, null]]), message.endsWith('\n') ? message : `${message}\n`);
    if (commit === null) return notFound();
    return ok({ content: null, commit: { sha: commit, message } });
  }

  return notFound();
}

// ------------------------------------------------------------------ labels

function handleLabels(forge: Forge, repo: Repo, req: RestRequest, tail: string[]): Reply {
  if (tail.length === 0) {
    if (req.method === 'GET') return ok([...repo.labels.values()].map((label) => labelView(forge, repo, label.name)));
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const name = str(body.name);
      if (name === '') return fail(422, 'Validation Failed: name is required');
      if (repo.labels.has(name)) return fail(422, 'Validation Failed: label already exists');
      repo.labels.set(name, { name, color: str(body.color) || 'ededed', description: typeof body.description === 'string' ? body.description : null });
      return ok(labelView(forge, repo, name), 201);
    }
  }
  return notFound();
}

// ------------------------------------------------------------------ issues

function handleIssues(forge: Forge, repo: Repo, req: RestRequest, tail: string[]): Reply {
  const method = req.method;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const direction = req.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, headers } = paginate(req, issues);
      return { status: 200, body: page.map((issue) => issueView(forge, repo, issue)), headers };
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const title = str(body.title);
      if (title === '') return fail(422, 'Validation Failed: title is required');
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : isRecord(entry) ? str(entry.name) : '';
          if (name === '') continue;
          if (!repo.labels.has(name)) return fail(422, `Validation Failed: label "${name}" does not exist`);
          labelNames.push(name);
        }
      }
      const issue = forge.createIssue(repo, title, str(body.body), labelNames);
      return ok(issueView(forge, repo, issue), 201);
    }
    return notFound();
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const issue = repo.issues.get(number);

  if (tail.length === 1) {
    if (issue === undefined) return notFound();
    if (method === 'GET') return ok(issueView(forge, repo, issue));
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (body.state === 'closed' || body.state === 'open') {
        issue.state = body.state;
        issue.updatedSeq = forge.tick();
      }
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const names: string[] = [];
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : isRecord(entry) ? str(entry.name) : '';
          if (name !== '' && repo.labels.has(name)) names.push(name);
        }
        issue.labels = names;
      }
      return ok(issueView(forge, repo, issue));
    }
    return notFound();
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) return notFound();
    if (method === 'GET') {
      const { page, headers } = paginate(req, issue.comments);
      return { status: 200, body: page.map((comment) => commentView(forge, comment)), headers };
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const text = str(body.body);
      if (text === '') return fail(422, 'Validation Failed: body is required');
      const comment = { id: forge.allocateCommentId(), body: text, seq: forge.tick() };
      issue.comments.push(comment);
      return ok(commentView(forge, comment), 201);
    }
  }
  return notFound();
}

// ------------------------------------------------------------------ pulls

function normalizeRefName(repo: Repo, ref: string): string {
  let name = ref;
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const labelPrefix = `${repo.owner}:`;
  if (name.startsWith(labelPrefix)) name = name.slice(labelPrefix.length);
  return name;
}

function handlePulls(forge: Forge, repo: Repo, req: RestRequest, tail: string[]): Reply {
  const method = req.method;
  if (tail.length === 0) {
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => b.number - a.number);
      const { page, headers } = paginate(req, pulls);
      return { status: 200, body: page.map((pull) => pullView(forge, repo, pull)), headers };
    }
    if (method === 'POST') {
      const body = req.body ?? {};
      const title = str(body.title);
      const headRaw = str(body.head);
      const baseRaw = str(body.base);
      if (title === '' || headRaw === '' || baseRaw === '') return fail(422, 'Validation Failed: title, head and base are required');
      const head = normalizeRefName(repo, headRaw);
      const base = normalizeRefName(repo, baseRaw);
      if (forge.branchTip(repo, head) === undefined) return fail(422, `Validation Failed: head ref ${head} is invalid`);
      if (forge.branchTip(repo, base) === undefined) return fail(422, `Validation Failed: base ref ${base} is invalid`);
      const pull = forge.createPull(repo, title, str(body.body), head, base);
      return ok(pullView(forge, repo, pull), 201);
    }
    return notFound();
  }

  const number = Number(tail[0]);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const pull = repo.pulls.get(number);

  if (tail.length === 1) {
    if (pull === undefined) return notFound();
    if (method === 'GET') return ok(pullView(forge, repo, pull));
    if (method === 'PATCH') {
      const body = req.body ?? {};
      if (body.state === 'closed' || body.state === 'open') {
        if (!pull.merged) {
          pull.state = body.state;
          pull.updatedSeq = forge.tick();
        }
      }
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      return ok(pullView(forge, repo, pull));
    }
    return notFound();
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) return notFound();
    const { page, headers } = paginate(req, forge.pullFiles(repo, pull));
    return { status: 200, body: page, headers };
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) return notFound();
    if (pull.merged) return fail(405, 'Pull Request is not mergeable: it has already been merged');
    const sha = forge.squashMerge(repo, pull);
    if (sha === null) return fail(405, 'Pull Request is not mergeable: the head and base branches conflict');
    return ok({ sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound();
}

// ------------------------------------------------------------------ git refs

function handleGitRefs(forge: Forge, repo: Repo, req: RestRequest, tail: string[]): Reply {
  if (tail.length === 0) {
    if (req.method === 'GET') {
      return ok(
        forge.sortedRefNames(repo).map((ref) => {
          const oid = repo.refs.get(ref)!;
          return { ref, object: { sha: oid, type: forge.getObject(oid)?.type ?? 'commit' } };
        }),
      );
    }
    if (req.method === 'POST') {
      const body = req.body ?? {};
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (!ref.startsWith('refs/') || !isOid(sha) || forge.getObject(sha) === undefined) {
        return fail(422, 'Validation Failed: ref and a known sha are required');
      }
      if (repo.refs.has(ref)) return fail(422, 'Reference already exists');
      repo.refs.set(ref, sha);
      return ok({ ref, object: { sha, type: forge.getObject(sha)?.type ?? 'commit' } }, 201);
    }
    return notFound();
  }
  const joined = tail.join('/');
  const ref = joined.startsWith('refs/') ? joined : `refs/${joined}`;
  if (req.method === 'GET') {
    const oid = repo.refs.get(ref);
    if (oid === undefined) return notFound();
    return ok({ ref, object: { sha: oid, type: forge.getObject(oid)?.type ?? 'commit' } });
  }
  if (req.method === 'DELETE') {
    if (!repo.refs.has(ref)) return notFound();
    repo.refs.delete(ref);
    return { status: 204 };
  }
  return notFound();
}
