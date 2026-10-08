import {open, stat} from 'node:fs/promises';

export class TextReadBoundaryError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const reject = code => { throw new TextReadBoundaryError(code); };
const sameIdentity = (a,b) => a.dev === b.dev && a.ino === b.ino;
const sameVersion = (a,b) => sameIdentity(a,b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

// Pin the opened file and bound allocation/read size independently of preflight.
// Path and metadata checks reject observed changes; this is not an OS write lock.
export async function readFileSnapshot({path, maxBytes, checkAllowedPath}) {
  await checkAllowedPath(path);
  const handle = await open(path, 'r');
  try {
    const before = await handle.stat({bigint:true});
    if (!before.isFile()) reject('read-target-not-file');
    if (before.size > BigInt(maxBytes)) reject('text-file-too-large');
    await checkAllowedPath(path);
    if (!sameIdentity(before, await stat(path,{bigint:true}))) reject('text-source-changed');
    const buffer = Buffer.alloc(Number(before.size)+1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer,size,buffer.length-size,size);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    const after = await handle.stat({bigint:true});
    if (size > maxBytes || after.size > BigInt(maxBytes)) reject('text-file-too-large');
    if (size !== Number(before.size) || !sameVersion(before,after)) reject('text-source-changed');
    await checkAllowedPath(path);
    if (!sameVersion(after,await stat(path,{bigint:true}))) reject('text-source-changed');
    const bytes = buffer.subarray(0,size);
    return {bytes};
  } finally { await handle.close(); }
}

export async function readTextSnapshot(options) {
  const {bytes}=await readFileSnapshot(options);
  let text;
  try {text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}
  catch {reject('text-encoding-invalid');}
  return {bytes,text};
}

export function selectTextRange(text,offset,maxChars) {
  if (offset > text.length) reject('text-offset-out-of-range');
  const low = n => n >= 0xdc00 && n <= 0xdfff;
  const high = n => n >= 0xd800 && n <= 0xdbff;
  if (low(text.charCodeAt(offset))) reject('text-offset-splits-character');
  let end = Math.min(text.length,offset+maxChars);
  if (high(text.charCodeAt(end-1)) && low(text.charCodeAt(end))) end--;
  if (end === offset && offset < text.length) reject('text-range-too-small-for-character');
  return text.slice(offset,end);
}
