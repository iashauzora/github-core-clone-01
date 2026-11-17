// store.ts: the forge's state — one shared in-memory store behind REST, git smart HTTP,
// GraphQL and MCP. All timestamps are logical: a monotonic sequence mapped onto ISO strings
// and commit timestamps, so a replayed trial behaves identically (no wall clock, no random).

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitcore.ts';

/** The login the trial token names. The sealed suite's scenario viewer is a fixed constant. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

const EPOCH_BASE_SEC = 1_767_225_600; // 2026-01-01T00:00:00Z
export const DEFAULT_BRANCH = 'main';

export function identityLine(seq: number): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${EPOCH_BASE_SEC + seq} +0000`;
}

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  number: number;
  gid: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdSeq: number;
  updatedSeq: number;
}

export interface Pull {
  number: number;
  gid: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headShaAtCreate: string;
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  updatedSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  refs: Map<string, string>; // full ref name -> commit oid (tags may point at tag objects)
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number; // one sequence shared by issues and pull requests, as on GitHub
  createdSeq: number;
}

export class Forge {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  seq = 0;
  private nextRepoId = 5001;
  private nextGid = 1;
  private nextCommentId = 1;

  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  isoOf(seq: number): string {
    return new Date((EPOCH_BASE_SEC + seq) * 1000).toISOString();
  }

  // -------------------------------------------------------------- objects

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Follow a (possibly annotated) tag chain to the commit it names; null when not a commit. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  commitInfo(oid: string): ReturnType<typeof parseCommit> | null {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  treeEntries(treeOid: string): TreeEntry[] {
    const object = this.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTree(object.data);
  }

  /** Every file (path -> blob oid + mode) under a tree, recursively. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    for (const entry of this.treeEntries(treeOid)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** Build (and store) a tree from a flat path -> blob map; returns the root tree oid. */
  treeFromFlat(flat: ReadonlyMap<string, { oid: string; mode: string }>): string {
    const build = (paths: ReadonlyMap<string, { oid: string; mode: string }>): string => {
      const files: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
      for (const [path, value] of paths) {
        const slash = path.indexOf('/');
        if (slash < 0) {
          files.push({ mode: value.mode, name: path, oid: value.oid });
        } else {
          const dir = path.slice(0, slash);
          const rest = path.slice(slash + 1);
          let bucket = dirs.get(dir);
          if (bucket === undefined) {
            bucket = new Map();
            dirs.set(dir, bucket);
          }
          bucket.set(rest, value);
        }
      }
      const entries: TreeEntry[] = [...files];
      for (const [dir, bucket] of dirs) entries.push({ mode: '40000', name: dir, oid: build(bucket) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(flat);
  }

  /** The blob oid at `path` in a tree, or null. */
  blobAtPath(treeOid: string, path: string): string | null {
    const segments = path.split('/');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const entry = this.treeEntries(current).find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) return entry.mode === '40000' ? null : entry.oid;
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  /** The immediate entries of the directory at `path` ('' = root) in a tree. */
  dirListing(treeOid: string, path: string): Array<{ name: string; path: string; oid: string; type: 'file' | 'dir'; mode: string }> | null {
    let current = treeOid;
    if (path !== '') {
      const segments = path.split('/');
      for (const segment of segments) {
        const entry = this.treeEntries(current).find((candidate) => candidate.name === segment);
        if (entry === undefined || entry.mode !== '40000') return null;
        current = entry.oid;
      }
    }
    return this.treeEntries(current).map((entry) => ({
      name: entry.name,
      path: path === '' ? entry.name : `${path}/${entry.name}`,
      oid: entry.oid,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      mode: entry.mode,
    }));
  }

  // -------------------------------------------------------------- ancestry

  /** All commits reachable from `tip` (inclusive), parents followed. */
  ancestorsOf(tip: string, limit = 100_000): Set<string> {
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && seen.size < limit) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      const info = this.commitInfo(current);
      if (info === null) continue;
      seen.add(current);
      for (const parent of info.parents) stack.push(parent);
    }
    return seen;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestorsOf(descendant).has(ancestor);
  }

  /** A best common ancestor of two commits (BFS from b over a's ancestor set), or null. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const ancestors = this.ancestorsOf(a);
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      if (ancestors.has(current)) return current;
      const info = this.commitInfo(current);
      if (info !== null) queue.push(...info.parents);
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (DFS pre-order, parents in order). */
  listCommits(tip: string, limit = 500): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      const info = this.commitInfo(current);
      if (info === null) continue;
      seen.add(current);
      out.push(current);
      for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i]!);
    }
    return out;
  }

  // -------------------------------------------------------------- repositories

  private repoKey(owner: string, name: string): string {
    return `${owner}/${name}`.toLowerCase();
  }

  /** The repo for (owner, name); only the viewer's own repos exist — anything else is a 404. */
  findRepo(owner: string, name: string): Repo | undefined {
    if (owner.toLowerCase() !== VIEWER_LOGIN) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo | 'exists' {
    const key = this.repoKey(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return 'exists';
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER_LOGIN,
      name,
      isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdSeq: this.tick(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
  }

  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  headTarget(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Sorted ref names (branches then tags), HEAD handled by callers. */
  sortedRefNames(repo: Repo): string[] {
    return [...repo.refs.keys()].sort();
  }

  /**
   * Create a commit on `branch` applying `changes` (path -> bytes, or null to delete) on top of
   * the branch tip (or as a root commit when the branch is unborn). Moves the ref. Returns the
   * commit oid, or null when the branch does not exist and is not the unborn default.
   */
  commitChanges(repo: Repo, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): string | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    if (tip === undefined && branch !== repo.defaultBranch) return null;
    const seq = this.tick();
    let flat = new Map<string, { oid: string; mode: string }>();
    if (tip !== undefined) {
      const info = this.commitInfo(tip);
      if (info === null) return null;
      flat = this.flattenTree(info.tree);
    }
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { oid: this.putObject('blob', content), mode: flat.get(path)?.mode ?? '100644' });
    }
    const tree = this.treeFromFlat(flat);
    const identity = identityLine(seq);
    const commit = this.putObject(
      'commit',
      buildCommit({ tree, parents: tip === undefined ? [] : [tip], author: identity, committer: identity, message }),
    );
    repo.refs.set(ref, commit);
    return commit;
  }

  // -------------------------------------------------------------- merges and diffs

  /**
   * Three-way merge of flat file maps. Returns the merged map, or null on conflict
   * (both sides changed the same path to different contents, or changed vs deleted).
   */
  static mergeFlat(
    base: ReadonlyMap<string, { oid: string; mode: string }>,
    ours: ReadonlyMap<string, { oid: string; mode: string }>,
    theirs: ReadonlyMap<string, { oid: string; mode: string }>,
  ): Map<string, { oid: string; mode: string }> | null {
    const merged = new Map<string, { oid: string; mode: string }>();
    const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const b = base.get(path)?.oid;
      const o = ours.get(path)?.oid;
      const t = theirs.get(path)?.oid;
      if (o === t) {
        const value = ours.get(path) ?? theirs.get(path);
        if (value !== undefined) merged.set(path, value);
      } else if (b === o) {
        const value = theirs.get(path);
        if (value !== undefined) merged.set(path, value);
      } else if (b === t) {
        const value = ours.get(path);
        if (value !== undefined) merged.set(path, value);
      } else {
        return null;
      }
    }
    return merged;
  }

  /** The flat file map of a commit's tree (empty map for a null commit). */
  flatOfCommit(commitOid: string | null): Map<string, { oid: string; mode: string }> {
    if (commitOid === null) return new Map();
    const info = this.commitInfo(commitOid);
    if (info === null) return new Map();
    return this.flattenTree(info.tree);
  }

  /** Whether merging `pull` into its base would conflict, and the merge base used. */
  pullMergePlan(repo: Repo, pull: Pull): { mergeBase: string | null; conflict: boolean; merged: Map<string, { oid: string; mode: string }> | null } {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return { mergeBase: null, conflict: true, merged: null };
    const base = this.mergeBase(baseTip, headTip);
    const merged = Forge.mergeFlat(this.flatOfCommit(base), this.flatOfCommit(baseTip), this.flatOfCommit(headTip));
    return { mergeBase: base, conflict: merged === null, merged };
  }

  /**
   * Squash-merge a pull request: one commit on the base branch whose tree is the three-way
   * merge of (merge-base, base tip, head tip). Returns the commit oid, or null on conflict.
   */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const plan = this.pullMergePlan(repo, pull);
    if (plan.conflict || plan.merged === null) return null;
    const baseTip = this.branchTip(repo, pull.baseRef)!;
    const seq = this.tick();
    const tree = this.treeFromFlat(plan.merged);
    const identity = identityLine(seq);
    const message = pull.body.trim() === '' ? `${pull.title}\n` : `${pull.title}\n\n${pull.body}\n`;
    const commit = this.putObject('commit', buildCommit({ tree, parents: [baseTip], author: identity, committer: identity, message }));
    repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedSeq = seq;
    pull.mergeCommitSha = commit;
    pull.updatedSeq = seq;
    return commit;
  }

  /** The changed files of a pull request, diffed against its merge base. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = this.mergeBase(baseTip, headTip);
    const before = this.flatOfCommit(base);
    const after = this.flatOfCommit(headTip);
    const paths = new Set<string>([...before.keys(), ...after.keys()]);
    const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const b = before.get(path)?.oid;
      const a = after.get(path)?.oid;
      if (a === b) continue;
      const beforeText = b === undefined ? null : (this.objects.get(b)?.data.toString('utf8') ?? '');
      const afterText = a === undefined ? null : (this.objects.get(a)?.data.toString('utf8') ?? '');
      const { additions, deletions } = lineDiff(beforeText, afterText);
      files.push({
        filename: path,
        status: b === undefined ? 'added' : a === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return files;
  }

  // -------------------------------------------------------------- issues and pulls

  allocateGid(): number {
    return this.nextGid++;
  }

  allocateCommentId(): number {
    return this.nextCommentId++;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const seq = this.tick();
    const issue: Issue = {
      number: repo.nextNumber++,
      gid: this.allocateGid(),
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull {
    const seq = this.tick();
    const pull: Pull = {
      number: repo.nextNumber++,
      gid: this.allocateGid(),
      title,
      body,
      state: 'open',
      headRef,
      baseRef,
      headShaAtCreate: this.branchTip(repo, headRef) ?? ZERO_OID,
      merged: false,
      mergedSeq: null,
      mergeCommitSha: null,
      createdSeq: seq,
      updatedSeq: seq,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }
}

/** Line-level diff counts (LCS over lines; large inputs fall back to whole-file counts). */
export function lineDiff(before: string | null, after: string | null): { additions: number; deletions: number } {
  if (before === after) return { additions: 0, deletions: 0 };
  if (before === null) return { additions: splitLines(after ?? '').length, deletions: 0 };
  if (after === null) return { additions: 0, deletions: splitLines(before).length };
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > 1_000_000) {
    const beforeSet = new Map<string, number>();
    for (const line of a) beforeSet.set(line, (beforeSet.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of b) {
      const count = beforeSet.get(line) ?? 0;
      if (count > 0) {
        common += 1;
        beforeSet.set(line, count - 1);
      }
    }
    return { additions: b.length - common, deletions: a.length - common };
  }
  // LCS lengths via dynamic programming over the shorter axis.
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let prev = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = dp[j]!;
      dp[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(dp[j]!, dp[j - 1]!);
      prev = saved;
    }
  }
  const common = dp[b.length]!;
  return { additions: b.length - common, deletions: a.length - common };
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
