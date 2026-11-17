// githttp.ts: git smart HTTP at /{owner}/{repo}.git — protocol v2 (ls-refs, fetch) when the
// client asks for it, v0 otherwise, and v0 receive-pack with report-status. One shared
// object store with the REST surface (store.ts), so a commit made either way is visible
// both ways.

import {
  FLUSH_PKT,
  ZERO_OID,
  isOid,
  parsePkts,
  pktLine,
  readPack,
  sidebandPackets,
  writePack,
  type GitObject,
  type Pkt,
} from './gitcore.ts';
import type { Forge, Repo } from './store.ts';

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = `multi_ack_detailed thin-pack side-band side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/main`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function textReply(status: number, text: string): GitReply {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(text, 'utf8') };
}

function jsonReply(status: number, message: string): GitReply {
  return { status, contentType: 'application/json', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

function linePkt(text: string): Buffer {
  return pktLine(Buffer.from(text, 'utf8'));
}

/** Refs in advertisement order: HEAD first (handled by callers), then sorted ref names. */
function refLines(forge: Forge, repo: Repo): Array<{ name: string; oid: string }> {
  return forge.sortedRefNames(repo).map((name) => ({ name, oid: repo.refs.get(name)! }));
}

// ------------------------------------------------------------------ advertisements

function advertiseV0(forge: Forge, repo: Repo, service: string): GitReply {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const parts: Buffer[] = [linePkt(`# service=${service}\n`), FLUSH_PKT];
  const refs = refLines(forge, repo);
  const headTarget = forge.headTarget(repo);
  if (refs.length === 0) {
    parts.push(linePkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(headTarget) ?? ZERO_OID;
    parts.push(linePkt(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(linePkt(`${ref.oid} ${ref.name}\n`));
      const object = forge.getObject(ref.oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = forge.peelToCommit(ref.oid);
        if (peeled !== null) parts.push(linePkt(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(FLUSH_PKT);
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

function advertiseV2(service: string): GitReply {
  const parts: Buffer[] = [
    linePkt('version 2\n'),
    linePkt(`agent=${AGENT}\n`),
    linePkt('ls-refs=unborn\n'),
    linePkt('fetch=shallow\n'),
    linePkt('object-format=sha1\n'),
    FLUSH_PKT,
  ];
  return { status: 200, contentType: `application/x-${service}-advertisement`, body: Buffer.concat(parts) };
}

// ------------------------------------------------------------------ fetch planning

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
  deepenRelative: boolean;
  done: boolean;
}

interface FetchPlan {
  objects: Array<{ oid: string; object: GitObject }>;
  shallow: string[];
  unshallow: string[];
  nothingNew: boolean;
}

/** Every object in a commit's tree (trees and blobs), including the tree itself. */
function treeClosure(forge: Forge, treeOid: string, out: Map<string, GitObject>): void {
  if (out.has(treeOid)) return;
  const tree = forge.getObject(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  out.set(treeOid, tree);
  for (const entry of forge.treeEntries(treeOid)) {
    if (entry.mode === '40000') treeClosure(forge, entry.oid, out);
    else if (!out.has(entry.oid)) {
      const blob = forge.getObject(entry.oid);
      if (blob !== undefined) out.set(entry.oid, blob);
    }
  }
}

/** The full object closure of a commit: itself, all ancestors, and every tree and blob. */
function fullClosure(forge: Forge, tip: string, out: Map<string, GitObject>): void {
  for (const commitOid of forge.ancestorsOf(tip)) {
    if (!out.has(commitOid)) {
      const commit = forge.getObject(commitOid);
      if (commit !== undefined) out.set(commitOid, commit);
    }
    const info = forge.commitInfo(commitOid);
    if (info !== null) treeClosure(forge, info.tree, out);
  }
}

function planFetch(forge: Forge, args: FetchArgs): FetchPlan {
  const clientShallow = new Set(args.shallow);
  const haveCommits = new Set<string>();
  for (const have of args.haves) {
    const commit = forge.peelToCommit(have);
    if (commit !== null) haveCommits.add(commit);
  }

  // What the client already holds: full closure of plain haves, the shallow haves' own
  // commit + tree, and the closure of deepen-not tips.
  const excluded = new Map<string, GitObject>();
  for (const have of haveCommits) {
    if (clientShallow.has(have)) {
      const commit = forge.getObject(have);
      if (commit !== undefined) excluded.set(have, commit);
      const info = forge.commitInfo(have);
      if (info !== null) treeClosure(forge, info.tree, excluded);
    } else {
      fullClosure(forge, have, excluded);
    }
  }
  for (const notRef of args.deepenNot) {
    const commit = forge.peelToCommit(notRef);
    if (commit !== null) fullClosure(forge, commit, excluded);
  }

  // BFS from the wants, distance 1 = a want itself. Each commit also carries a depth
  // budget: `deepen` counted from the wants, except that passing through one of the
  // client's shallow commits with deepen-relative extends the budget to that commit's
  // distance + deepen (git fetch --deepen on an already-shallow clone).
  const distance = new Map<string, number>();
  const budget = new Map<string, number>();
  const queue: string[] = [];
  const extraObjects = new Map<string, GitObject>(); // wanted tags themselves
  for (const want of args.wants) {
    const object = forge.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'tag') extraObjects.set(want, object);
    const commit = forge.peelToCommit(want);
    if (commit === null) {
      if (object.type !== 'tag') extraObjects.set(want, object);
      continue;
    }
    if (!distance.has(commit)) {
      distance.set(commit, 1);
      budget.set(commit, args.deepen ?? Number.POSITIVE_INFINITY);
      queue.push(commit);
    }
  }
  const boundary = new Set<string>();
  const included = new Set<string>();
  const traversedShallow = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    const dist = distance.get(current)!;
    const info = forge.commitInfo(current);
    if (info === null) continue;
    const isShallowHave = clientShallow.has(current) && haveCommits.has(current);
    const isPlainHave = haveCommits.has(current) && !clientShallow.has(current);
    if (isPlainHave) continue; // the client holds this whole line of history
    if (isShallowHave) traversedShallow.add(current);
    else included.add(current);
    let effectiveBudget = budget.get(current) ?? Number.POSITIVE_INFINITY;
    if (isShallowHave && args.deepenRelative && args.deepen !== null) {
      effectiveBudget = Math.max(effectiveBudget, dist + args.deepen);
    }
    const atDepthLimit = args.deepen !== null && dist >= effectiveBudget;
    const beforeSince = args.deepenSince !== null && info.time > 0 && info.time < args.deepenSince;
    if (atDepthLimit || beforeSince) {
      if (info.parents.length > 0 && !isShallowHave) boundary.add(current);
      continue;
    }
    if (isShallowHave && args.deepen === null && args.deepenSince === null) {
      // No deepening asked: the client's shallow copy is the boundary.
      continue;
    }
    for (const parent of info.parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        budget.set(parent, effectiveBudget);
        queue.push(parent);
      }
    }
  }

  const objects = new Map<string, GitObject>();
  for (const [oid, object] of extraObjects) if (!excluded.has(oid)) objects.set(oid, object);
  for (const commitOid of included) {
    const commit = forge.getObject(commitOid);
    if (commit !== undefined && !excluded.has(commitOid)) objects.set(commitOid, commit);
    const info = forge.commitInfo(commitOid);
    if (info !== null) {
      const closure = new Map<string, GitObject>();
      treeClosure(forge, info.tree, closure);
      for (const [oid, object] of closure) if (!excluded.has(oid) && !objects.has(oid)) objects.set(oid, object);
    }
  }

  const shallowOut = [...boundary].filter((oid) => included.has(oid));
  const unshallowOut = [...traversedShallow].filter((oid) => !boundary.has(oid));
  return { objects: [...objects.entries()].map(([oid, object]) => ({ oid, object })), shallow: shallowOut, unshallow: unshallowOut, nothingNew: objects.size === 0 };
}

// ------------------------------------------------------------------ upload-pack

function lsRefs(forge: Forge, repo: Repo, args: string[]): GitReply {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const parts: Buffer[] = [];
  const headTarget = forge.headTarget(repo);
  // HEAD is a ref like any other for prefix purposes: it is listed when no prefix was given
  // or when a prefix matches "HEAD" itself (real git asks with `ref-prefix HEAD`); a prefix
  // of refs/heads/... never matches it.
  const headWanted = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (headWanted) {
    const headOid = repo.refs.get(headTarget);
    if (headOid !== undefined) {
      parts.push(linePkt(`${headOid} HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    } else if (unborn) {
      parts.push(linePkt(`unborn HEAD${symrefs ? ` symref-target:${headTarget}` : ''}\n`));
    }
  }
  for (const ref of refLines(forge, repo)) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    let line = `${ref.oid} ${ref.name}`;
    const object = forge.getObject(ref.oid);
    if (peel && object !== undefined && object.type === 'tag') {
      const peeled = forge.peelToCommit(ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(linePkt(`${line}\n`));
  }
  parts.push(FLUSH_PKT);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV2(forge: Forge, args: FetchArgs): GitReply {
  // Negotiation phase: a request without `done` (real git's first round when it has
  // haves) is answered with an acknowledgments section only — ACK for every have the
  // store holds, NAK when it holds none. The client then re-requests with `done`.
  if (!args.done) {
    const parts: Buffer[] = [linePkt('acknowledgments\n')];
    const acked = args.haves.filter((have) => forge.peelToCommit(have) !== null);
    if (acked.length === 0) parts.push(linePkt('NAK\n'));
    else for (const have of acked) parts.push(linePkt(`ACK ${have}\n`));
    parts.push(FLUSH_PKT);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  const plan = planFetch(forge, args);
  const parts: Buffer[] = [];
  if (plan.nothingNew) {
    const ackOid = args.haves.find((have) => args.wants.includes(have)) ?? args.wants[0] ?? args.haves[0];
    parts.push(linePkt('acknowledgments\n'));
    if (ackOid !== undefined) parts.push(linePkt(`ACK ${ackOid}\n`));
    else parts.push(linePkt('NAK\n'));
    parts.push(FLUSH_PKT);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  // No acknowledgments section when a packfile follows: after `done`, real upload-pack
  // goes straight to shallow-info/packfile (acks belong to the negotiation phase, and to
  // the nothing-new answer above). Real git's fetch-pack rejects an acks section here.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(linePkt('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(linePkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(linePkt(`unshallow ${oid}\n`));
    parts.push(FLUSH_PKT);
  }
  const pack = writePack(plan.objects.map((entry) => entry.object));
  parts.push(linePkt('packfile\n'));
  parts.push(...sidebandPackets(pack, 1));
  parts.push(FLUSH_PKT);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function fetchV0(forge: Forge, args: FetchArgs): GitReply {
  const plan = planFetch(forge, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(linePkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(linePkt(`unshallow ${oid}\n`));
  if (plan.nothingNew) {
    const ackOid = args.haves.find((have) => args.wants.includes(have)) ?? args.wants[0] ?? args.haves[0];
    parts.push(linePkt(ackOid !== undefined ? `ACK ${ackOid}\n` : 'NAK\n'));
    parts.push(FLUSH_PKT);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  parts.push(linePkt('NAK\n'));
  const pack = writePack(plan.objects.map((entry) => entry.object));
  parts.push(...sidebandPackets(pack, 1));
  parts.push(FLUSH_PKT);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [], deepenRelative: false, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number(line.slice(7).trim()) || null;
    else if (line.startsWith('deepen-since ')) args.deepenSince = Number(line.slice(13).trim()) || null;
    else if (line.startsWith('deepen-not ')) args.deepenNot.push(line.slice(11).trim());
    else if (line === 'deepen-relative') args.deepenRelative = true;
    else if (line === 'done') args.done = true;
  }
  return args;
}

function uploadPackPost(forge: Forge, repo: Repo, body: Buffer): GitReply {
  const first = parsePkts(body);
  const payloads = first.pkts.filter((pkt): pkt is Buffer => Buffer.isBuffer(pkt));
  if (payloads.length === 0) return textReply(400, 'malformed pkt-line request');
  const firstLine = payloads[0]!.toString('utf8').replace(/\n$/, '');

  if (firstLine.startsWith('command=')) {
    const command = firstLine.slice('command='.length);
    const delimIndex = first.pkts.findIndex((pkt) => pkt === 'delim');
    const argPkts = delimIndex < 0 ? [] : first.pkts.slice(delimIndex + 1).filter((pkt): pkt is Buffer => Buffer.isBuffer(pkt));
    const argLines = argPkts.map((pkt) => pkt.toString('utf8').replace(/\n$/, ''));
    if (command === 'ls-refs') return lsRefs(forge, repo, argLines);
    if (command === 'fetch') return fetchV2(forge, parseFetchArgs(argLines));
    return textReply(400, `unknown command ${command}`);
  }

  // Protocol v0: a wants section, a flush, then haves/done and a second flush.
  const wantLines = payloads.map((pkt) => pkt.toString('utf8').replace(/\n$/, ''));
  const second = parsePkts(first.rest);
  const haveLines = second.pkts.filter((pkt): pkt is Buffer => Buffer.isBuffer(pkt)).map((pkt) => pkt.toString('utf8').replace(/\n$/, ''));
  const args = parseFetchArgs([...wantLines, ...haveLines]);
  // In v0 the first want line may carry capabilities after the oid; strip them.
  args.wants = args.wants.map((want) => want.split(' ')[0]!);
  return fetchV0(forge, args);
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePackPost(forge: Forge, repo: Repo, body: Buffer): GitReply {
  const parsed = parsePkts(body);
  const payloads = parsed.pkts.filter((pkt): pkt is Buffer => Buffer.isBuffer(pkt));
  if (payloads.length === 0 && parsed.pkts.length === 0) return textReply(400, 'malformed pkt-line request');
  const commands: PushCommand[] = [];
  let capabilities = '';
  payloads.forEach((pkt, index) => {
    let line = pkt.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0]!) && isOid(parts[1]!)) {
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
    }
  });
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const packBytes = parsed.rest;

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => forge.getObject(oid));
      for (const [oid, object] of objects) if (!forge.objects.has(oid)) forge.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'error';
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const refuse = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      refuse('unpacker error');
      continue;
    }
    if (!command.ref.startsWith('refs/')) {
      refuse('invalid ref');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      refuse('stale ref');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      if (command.ref === forge.headTarget(repo)) {
        refuse('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newObject = forge.getObject(command.newOid);
    if (newObject === undefined) {
      refuse('missing object');
      continue;
    }
    const newCommit = forge.peelToCommit(command.newOid);
    if (newCommit === null) {
      refuse('not a commit');
      continue;
    }
    if (command.oldOid !== ZERO_OID) {
      const oldCommit = forge.peelToCommit(command.oldOid);
      if (oldCommit === null || !forge.isAncestor(oldCommit, newCommit)) {
        refuse('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  const inner: Buffer[] = [linePkt(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const result of results) {
    inner.push(linePkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(FLUSH_PKT);
  const innerBytes = Buffer.concat(inner);
  let responseBody: Buffer;
  if (useSideband) {
    responseBody = Buffer.concat([...sidebandPackets(innerBytes, 1), FLUSH_PKT]);
  } else {
    responseBody = innerBytes;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}

// ------------------------------------------------------------------ entry point

export function handleGitHttp(
  forge: Forge,
  method: string,
  owner: string,
  repoName: string,
  sub: string,
  query: URLSearchParams,
  gitProtocolHeader: string | null,
  body: Buffer,
): GitReply {
  const repo = forge.findRepo(owner, repoName);
  if (repo === undefined) return jsonReply(404, 'Not Found');

  if (method === 'GET' && sub === 'info/refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return textReply(400, 'invalid service');
    const wantsV2 = (gitProtocolHeader ?? '').includes('version=2');
    if (service === 'git-upload-pack' && wantsV2) return advertiseV2(service);
    return advertiseV0(forge, repo, service);
  }
  if (method === 'POST' && sub === 'git-upload-pack') return uploadPackPost(forge, repo, body);
  if (method === 'POST' && sub === 'git-receive-pack') return receivePackPost(forge, repo, body);
  return jsonReply(404, 'Not Found');
}
