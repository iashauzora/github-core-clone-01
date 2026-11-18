// gitcore.ts: the git object model in pure Node standard library — SHA-1 objects, trees,
// commits, tags, packfiles (read incl. ofs/ref deltas, write plain), delta application and
// pkt-line framing. No state lives here; store.ts owns the forge.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a would-be object: sha1 of "<type> <len>\0" + data. */
export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  // Two updates hash the same byte stream as header++data without copying it.
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string; // '100644', '100755', '120000', '40000' (as stored, no leading zero)
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree entry');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: bytewise by name, directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string; // the full "Name <email> ts tz" line value
  committer: string;
  message: string;
  /** Committer timestamp in seconds, 0 when unparsable. */
  time: number;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  // The committer line ends "... <email> <unix-ts> <±zzzz>": read the timestamp
  // by scanning back from the end instead of running a regex over the line.
  let time = 0;
  const tzStart = committer.lastIndexOf(' ');
  if (tzStart > 0) {
    const tsStart = committer.lastIndexOf(' ', tzStart - 1);
    if (tsStart >= 0) {
      const digits = committer.slice(tsStart + 1, tzStart);
      let allDigits = digits.length > 0;
      for (let i = 0; i < digits.length && allDigits; i += 1) {
        const code = digits.charCodeAt(i);
        if (code < 0x30 || code > 0x39) allDigits = false;
      }
      if (allDigits) time = Number(digits);
    }
  }
  return { tree, parents, author, committer, message, time };
}

export function buildCommit(info: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(info.message, 'utf8')]);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line === '') break;
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
  }
  return { object, type, tag };
}

// ---------------------------------------------------------------- deltas

/** Apply a git delta buffer to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta truncated');
      const byte = delta[offset++]!;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset = delta[offset++]!;
      if (op & 0x02) copyOffset |= delta[offset++]! << 8;
      if (op & 0x04) copyOffset |= delta[offset++]! << 16;
      if (op & 0x08) copyOffset |= delta[offset++]! << 24;
      if (op & 0x10) copySize = delta[offset++]!;
      if (op & 0x20) copySize |= delta[offset++]! << 8;
      if (op & 0x40) copySize |= delta[offset++]! << 16;
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

// ---------------------------------------------------------------- packfiles

interface PackEntry {
  offset: number;
  type: ObjType | 'ofs-delta' | 'ref-delta';
  data: Buffer; // inflated payload (the delta buffer for delta entries)
  baseOffset: number; // ofs-delta: absolute offset of the base entry
  baseOid: string; // ref-delta: oid of the base object
}

/** Inflate the zlib stream starting at `offset`; returns the data and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine?.bytesWritten ?? 0;
  if (!written || written <= 0) throw new Error('zlib stream consumed no bytes');
  return { data: result.buffer, next: offset + written };
}

/**
 * Read a whole packfile into the objects it carries, resolving deltas against the pack itself
 * and, for ref-deltas, `resolveBase` (the receiving store). Verifies the SHA-1 trailer.
 * Returns the resolved objects keyed by oid.
 */
export function readPack(pack: Buffer, resolveBase: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 12 + 20) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK signature');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = pack.subarray(trailerStart).toString('hex');
  const actual = sha1Hex(pack.subarray(0, trailerStart));
  if (expected !== actual) throw new Error('pack checksum mismatch');

  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset++]!;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = 0;
    let baseOid = '';
    if (typeCode === 6) {
      byte = pack[offset++]!;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++]!;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    offset = inflated.next;
    if (typeCode === 6) entries.push({ offset: entryOffset, type: 'ofs-delta', data: inflated.data, baseOffset, baseOid: '' });
    else if (typeCode === 7) entries.push({ offset: entryOffset, type: 'ref-delta', data: inflated.data, baseOffset: 0, baseOid });
    else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      entries.push({ offset: entryOffset, type, data: inflated.data, baseOffset: 0, baseOid: '' });
    }
  }

  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const resolved = new Map<string, GitObject>();
  const resolvedByOffset = new Map<number, GitObject & { oid: string }>();

  const resolveEntry = (entry: PackEntry, depth: number): GitObject & { oid: string } => {
    const memo = resolvedByOffset.get(entry.offset);
    if (memo !== undefined) return memo;
    if (depth > 64) throw new Error('delta chain too deep');
    let object: GitObject;
    if (entry.type === 'ofs-delta') {
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing from pack');
      const base = resolveEntry(baseEntry, depth + 1);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.type === 'ref-delta') {
      let base: GitObject | undefined = resolveBase(entry.baseOid);
      if (base === undefined) {
        for (const candidate of entries) {
          if (candidate === entry) continue;
          const resolvedCandidate = resolveEntry(candidate, depth + 1);
          if (resolvedCandidate.oid === entry.baseOid) {
            base = resolvedCandidate;
            break;
          }
        }
      }
      if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} not found`);
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: entry.type, data: entry.data };
    }
    const withOid = { ...object, oid: hashObject(object.type, object.data) };
    resolvedByOffset.set(entry.offset, withOid);
    resolved.set(withOid.oid, object);
    return withOid;
  };
  for (const entry of entries) resolveEntry(entry, 0);
  return resolved;
}

/** Write a packfile (version 2, no deltas) carrying `objects` in the given order. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeCode = TYPE_CODES[object.type]!;
    let size = object.data.length;
    const first = (size & 0x0f) | (typeCode << 4);
    size >>= 4;
    const headBytes: number[] = [];
    if (size > 0) {
      headBytes.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size >>= 7;
        headBytes.push(size > 0 ? byte | 0x80 : byte);
      }
    } else {
      headBytes.push(first);
    }
    parts.push(Buffer.from(headBytes));
    // Level 1: packs stay valid at any zlib level, and the forge's packs are
    // small and served over loopback — compression effort buys nothing here.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: payload, or the flush/delim markers. */
export type Pkt = Buffer | 'flush' | 'delim' | 'end';

export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');

/** Parse a buffer of pkt-lines; `rest` is whatever follows the last complete line (a pack, usually). */
export function parsePkts(buffer: Buffer, start = 0): { pkts: Pkt[]; rest: Buffer; next: number } {
  const pkts: Pkt[] = [];
  let offset = start;
  while (offset + 4 <= buffer.length) {
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      pkts.push('flush');
      offset += 4;
      // A flush ends the pkt-line stream in every flow we serve; the caller decides what
      // `rest` means (receive-pack: the pack; upload-pack v0: a second pkt section follows,
      // which the caller parses by calling parsePkts again on the rest).
      return { pkts, rest: buffer.subarray(offset), next: offset };
    }
    if (length === 1) {
      pkts.push('delim');
      offset += 4;
      continue;
    }
    if (length === 2) {
      pkts.push('end');
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    pkts.push(buffer.subarray(offset + 4, offset + length));
    offset += length;
  }
  return { pkts, rest: buffer.subarray(offset), next: offset };
}

/** Split a byte stream into side-band-64k pkt-lines of at most `chunk` payload bytes (band byte included). */
export function sidebandPackets(data: Buffer, band = 1, chunk = 65515): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunk) {
    const slice = data.subarray(offset, Math.min(data.length, offset + chunk));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return packets;
}
