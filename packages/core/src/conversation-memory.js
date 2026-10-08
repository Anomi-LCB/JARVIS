import { appendFileSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename, extname, win32 } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_JOURNAL = resolve(homedir(), '.jarvis', 'work-journal.jsonl');
const MAX_ENTRIES = 300;
const MAX_OUTPUTS = 10;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
export const WORK_MEMORY_VERSION = 'jarvis-work-memory-v2';
export const WORK_MEMORY_MAX_HASH_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_HASH_BYTES = 32 * 1024 * 1024;
const scopeFields = ['workspaceId', 'conversationId', 'userId'];
const typeHints = [
  { pattern: /엑셀|xlsx|스프레드시트|정산표|가계부/iu, exts: ['.xlsx', '.xls'] },
  { pattern: /워드|docx/iu, exts: ['.docx'] },
  { pattern: /pdf|피디에프/iu, exts: ['.pdf'] },
  { pattern: /한글|hwpx?|아래아/iu, exts: ['.hwp', '.hwpx'] },
  { pattern: /피피티|파워포인트|발표|슬라이드|프레젠테이션|pptx?/iu, exts: ['.pptx', '.ppt'] },
  { pattern: /메모|텍스트|txt/iu, exts: ['.txt'] },
  { pattern: /CSV/iu, exts: ['.csv'] }, { pattern: /JSON/iu, exts: ['.json'] },
  { pattern: /이미지|그림|사진|PNG/iu, exts: ['.png', '.jpg', '.jpeg', '.webp'] }
];
const consumingVerb = /보내|전송|첨부|공유|올려|열어|실행|수정|고쳐|바꿔|편집|이동|옮겨|복사|이름|확인|보여|읽|요약|분석|정리|압축|비교|변환|가져와/u;
const nouns = '(?:파일|문서|산출물|결과물|엑셀|워드|보고서|피피티|발표\\s*자료|pdf|한글|메모|이미지|그림|사진|CSV|JSON)';
const temporalWords = '(?:방금|아까|조금\\s*전|좀\\s*전|마지막(?:에|으로)?|최근에?)';
const creationWords = '(?:만든|작성한|생성한|만들었던|저장한)';
const ordinalPattern = new RegExp(`(첫\\s*번째|첫|두\\s*번째|세\\s*번째|네\\s*번째|다섯\\s*번째|여섯\\s*번째|일곱\\s*번째|여덟\\s*번째|아홉\\s*번째|열\\s*번째|\\d+\\s*번째)\\s*${nouns}(?:[을를은는이가]?)`, 'giu');
const demoPattern = new RegExp(`(?:그\\s*${nouns}|그거|그것|이거)(?:[을를은는이가]?)`, 'giu');
const timePattern = new RegExp(`${temporalWords}\\s*(?:${creationWords}\\s*)?(?:그\\s*)?(?:${nouns})?(?:[을를은는이가]?)`, 'iu');

/** Durable artifact identity with strict workspace/conversation/user boundaries. */
export class WorkMemory {
  constructor({ journalPath = null, clock = () => new Date(), scope = {}, maxHashBytes = WORK_MEMORY_MAX_HASH_BYTES, maxTotalHashBytes = MAX_TOTAL_HASH_BYTES } = {}) {
    this.journalPath = journalPath ?? process.env.JARVIS_WORK_JOURNAL ?? DEFAULT_JOURNAL;
    this.clock = clock;
    this.scope = normalizeScope(scope);
    this.maxHashBytes = boundedInteger(maxHashBytes, 1, WORK_MEMORY_MAX_HASH_BYTES);
    this.maxTotalHashBytes = boundedInteger(maxTotalHashBytes, 1, MAX_TOTAL_HASH_BYTES);
  }
  load() {
    let fd;
    try {
      if (!existsSync(this.journalPath)) return [];
      const size = statSync(this.journalPath).size;
      let text;
      if (size <= MAX_JOURNAL_BYTES) text = readFileSync(this.journalPath, 'utf8');
      else {
        fd = openSync(this.journalPath, 'r');
        const buffer = Buffer.alloc(MAX_JOURNAL_BYTES);
        const length = readSync(fd, buffer, 0, buffer.length, size - buffer.length);
        text = buffer.subarray(0, length).toString('utf8');
        text = text.slice(text.indexOf('\n') + 1);
      }
      return text.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
        try { const entry = JSON.parse(line); return entry && typeof entry === 'object' && !Array.isArray(entry) ? [entry] : []; } catch { return []; }
      });
    } catch { return []; }
    finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
  }
  record(input = {}, options = {}) {
    try {
      const { taskId = null, missionId = null, operationId = null, rawText = '', actionType = null, outputPaths = [], summary = null, status = 'success' } = input;
      const scope = resolveScope(options, resolveScope(input, this.scope));
      const history = this.load();
      const uniquePaths = [...new Map((Array.isArray(outputPaths) ? outputPaths : []).filter((path) => typeof path === 'string' && validPath(path)).map((path) => [pathIdentity(path), path])).values()];
      const paths = uniquePaths.slice(0, MAX_OUTPUTS);
      const budget = { remaining: this.maxTotalHashBytes };
      const at = this.clock().toISOString();
      const previousArtifacts = history.flatMap((entry) => Array.isArray(entry.artifacts) ? entry.artifacts : []);
      const artifacts = paths.map((path, index) => {
        const artifactId = stableArtifactId(scope, path);
        const previous = previousArtifacts.filter((artifact) => artifact.artifactId === artifactId).at(-1);
        const identity = inspectFile(path, this.maxHashBytes, budget);
        const unchanged = previous && previous.sha256 === identity.sha256 && previous.exists === identity.exists && previous.size === identity.size && previous.identityStatus === identity.identityStatus;
        return { artifactId, path, name: fileName(path), ordinal: index + 1,
          version: previous ? Math.max(1, Number(previous.version) || 1) + (unchanged ? 0 : 1) : 1,
          ...identity, observedAt: at };
      });
      const entry = { schemaVersion: WORK_MEMORY_VERSION, at, taskId, missionId, operationId, rawText: String(rawText).slice(0, 300), actionType,
        outputPaths: paths, outputCount: uniquePaths.length, outputsTruncated: uniquePaths.length > MAX_OUTPUTS,
        summary: summary ? String(summary).slice(0, 300) : null, status, scope, artifacts };
      mkdirSync(dirname(this.journalPath), { recursive: true });
      appendFileSync(this.journalPath, `${JSON.stringify(entry)}\n`, 'utf8');
      if (history.length >= MAX_ENTRIES * 2) this.compactIfNeeded();
      return entry;
    } catch { return null; }
  }
  compactIfNeeded() {
    try {
      const entries = this.load();
      if (entries.length <= MAX_ENTRIES * 2) return;
      writeFileSync(this.journalPath, `${entries.slice(-MAX_ENTRIES).map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
    } catch {}
  }
  recent(limit = 20, options = {}) {
    try {
      const scope = resolveScope(options, this.scope);
      return this.load().filter((entry) => sameScope(entry.scope ?? {}, scope)).slice(-boundedInteger(limit, 1, MAX_ENTRIES)).reverse();
    } catch { return []; }
  }
  recentOutputs(limit = 20, options = {}) {
    return this.recent(MAX_ENTRIES, options).filter((entry) => entry.status === 'success' && Array.isArray(entry.outputPaths)
      && entry.outputPaths.length && entry.outputPaths.every((path) => typeof path === 'string' && validPath(path))).slice(0, boundedInteger(limit, 1, MAX_ENTRIES));
  }
  /** Only `resolved` carries a selected path and rewritten command; failures never pick a fallback. */
  resolveArtifactReference(rawText, options = {}) {
    const text = String(rawText ?? '');
    let scope;
    try { scope = resolveScope(options, this.scope); } catch { return { status: 'not_found', reason: 'invalid_scope', candidates: [] }; }
    if (!text || !consumingVerb.test(text)) return { status: 'not_reference', reason: 'no_reference', scope };
    const reference = locateReference(text);
    if (!reference) return { status: 'not_reference', reason: 'no_reference', scope };
    if (hasExplicitSourcePath(text)) return { status: 'not_reference', reason: 'explicit_path', scope };
    if (reference.multiple) return { status: 'ambiguous', reason: 'multiple_reference_phrases', scope, candidates: [] };
    const typedInput = /^(?:["'”’])?\s*(JSON|CSV|텍스트)(?:를|을)\s/iu.exec(text.slice(reference.end));
    const hinted = typeHints.find((hint) => hint.pattern.test(`${reference.matchedPhrase} ${typedInput?.[1] ?? ''}`));
    const entries = this.recentOutputs(MAX_ENTRIES, { scope });
    const entry = entries.find((item) => item.outputPaths.some((path) => !hinted || hinted.exts.includes(extname(path).toLowerCase())));
    if (!entry) return { status: 'not_found', reason: 'no_artifact_in_scope', scope, ...reference, candidates: [] };
    const paths = entry.outputPaths.filter((path) => !hinted || hinted.exts.includes(extname(path).toLowerCase()));
    const recordedArtifacts = Array.isArray(entry.artifacts) ? entry.artifacts.filter((artifact) => artifact && typeof artifact.path === 'string' && validPath(artifact.path)) : [];
    const artifacts = paths.map((path, index) => recordedArtifacts.find((artifact) => pathIdentity(artifact.path) === pathIdentity(path))
      ?? { artifactId: stableArtifactId(scope, path), path, name: fileName(path), ordinal: index + 1, version: 1,
        ...(entry.schemaVersion ? { identityStatus: 'recorded_identity_missing' } : { legacySnapshot: true }) });
    const candidates = artifacts.map(candidateSummary);
    if (entry.outputsTruncated) return { status: 'ambiguous', reason: 'recorded_output_limit', scope, ...reference, taskId: entry.taskId, candidates };
    if (reference.ordinal === undefined && artifacts.length !== 1) return { status: 'ambiguous', reason: 'multiple_outputs_in_latest_task', scope, ...reference, taskId: entry.taskId, candidates };
    const selected = artifacts[(reference.ordinal ?? 1) - 1];
    if (!selected) return { status: 'not_found', reason: 'ordinal_out_of_range', scope, ...reference, candidates };
    const current = inspectFile(selected.path, this.maxHashBytes, { remaining: this.maxTotalHashBytes });
    const common = { scope, ...reference, hintedExts: hinted?.exts ?? null, artifactId: selected.artifactId,
      artifact: { ...selected, scope, currentExists: current.exists, currentIdentityStatus: current.identityStatus }, entry, candidates };
    const issue = identityIssue(selected, current);
    if (issue) return { ...issue, ...common, current: { sha256: current.sha256, size: current.size } };
    const artifact = { ...selected, ...(selected.legacySnapshot ? current : {}), scope, currentExists: true, currentIdentityStatus: 'verified' };
    const rewritten = text.slice(0, reference.start) + `"${fileName(selected.path)}"` + text.slice(reference.end) + ` [파일 경로: ${selected.path}]`;
    return { status: 'resolved', reason: 'verified_artifact_identity', ...common, artifact, path: selected.path, rewritten };
  }
  /** Re-check a saved binding against this scope's journal and actual bytes immediately before use. */
  verifyArtifactReference(binding, options = {}) {
    let scope;
    try { scope = resolveScope(options, this.scope); } catch { return { status: 'not_found', reason: 'invalid_scope' }; }
    const artifact = binding?.artifact ?? binding;
    const boundScope = binding?.scope ?? artifact?.scope ?? scope;
    if (!artifact?.artifactId || !artifact.path || !sameScope(boundScope, scope)) return { status: 'not_found', reason: 'binding_scope_mismatch', scope };
    const entry = this.recentOutputs(MAX_ENTRIES, { scope }).find((item) => item.outputPaths.some((path) => pathIdentity(path) === pathIdentity(artifact.path)));
    if (!entry) return { status: 'not_found', reason: 'binding_not_recorded', scope };
    const known = Array.isArray(entry.artifacts) ? entry.artifacts.find((item) => item && item.artifactId === artifact.artifactId) : null;
    if (known && (known.version !== artifact.version || known.sha256 !== artifact.sha256 || known.size !== artifact.size || pathIdentity(known.path) !== pathIdentity(artifact.path))) return { status: 'stale', reason: 'binding_version_changed', scope };
    if (!known && !(artifact.legacySnapshot && artifact.artifactId === stableArtifactId(scope, artifact.path))) return { status: 'not_found', reason: 'binding_not_recorded', scope };
    const current = inspectFile(artifact.path, this.maxHashBytes, { remaining: this.maxTotalHashBytes });
    const issue = identityIssue({ ...(known ?? artifact), legacySnapshot: false }, current);
    if (issue) return { ...issue, scope, artifactId: artifact.artifactId };
    return { status: 'resolved', reason: 'verified_artifact_identity', scope, artifactId: artifact.artifactId, artifact: { ...(known ?? artifact), scope }, path: artifact.path };
  }
  // Compatibility facade: legacy callers only receive a consumable success or null.
  resolveReference(rawText, options = {}) {
    const resolution = this.resolveArtifactReference(rawText, options);
    return resolution.status === 'resolved' ? resolution : null;
  }
  rewriteWithReference(rawText, options = {}) { return this.resolveReference(rawText, options); }
  contextHints(limit = 5, options = {}) {
    return this.recentOutputs(limit, options).map((entry) => `- ${String(entry.at ?? '').slice(0, 16).replace('T', ' ')} "${entry.rawText ?? ''}" → ${entry.outputPaths.map(fileName).join(', ')}`);
  }
}

function resolveScope(input = {}, fallback = {}) {
  const given = input?.scope && typeof input.scope === 'object' ? input.scope : input;
  return normalizeScope(Object.fromEntries(scopeFields.map((key) => [key, Object.hasOwn(given, key) ? given[key]
    : key === 'workspaceId' && Object.hasOwn(given, 'workspaceRoot') ? given.workspaceRoot : fallback[key] ?? null])));
}
function normalizeScope(value = {}) {
  return Object.fromEntries(scopeFields.map((key) => {
    const raw = key === 'workspaceId' && !Object.hasOwn(value, key) ? value.workspaceRoot : value[key];
    if (raw === undefined || raw === null || raw === '') return [key, null];
    if (typeof raw !== 'string' || raw.length > 4096 || /[\u0000-\u001f\u007f]/u.test(raw)) throw new Error('WORK_MEMORY_SCOPE_INVALID');
    const trimmed = raw.trim();
    return [key, key === 'workspaceId' && (/^[A-Za-z]:[\\/]|^[\\/]/u.test(trimmed)) ? pathIdentity(trimmed) : trimmed];
  }));
}
function sameScope(left, right) { try { return scopeKey(normalizeScope(left)) === scopeKey(right); } catch { return false; } }
function scopeKey(value) { return JSON.stringify(scopeFields.map((key) => value[key] ?? null)); }
function validPath(value) { return Boolean(value.trim()) && value.length <= 32_768 && !/[\u0000-\u001f\u007f]/u.test(value); }
function pathIdentity(value) {
  const path = /^[A-Za-z]:[\\/]|^\\\\/u.test(value) ? win32.resolve(value) : resolve(value);
  return process.platform === 'win32' ? path.toLowerCase() : path;
}
function fileName(path) { return /[\\]/u.test(path) ? win32.basename(path) : basename(path); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function stableArtifactId(scope, path) { return `artifact_${sha256(`${scopeKey(scope)}\0${pathIdentity(path)}`).slice(0, 32)}`; }
function boundedInteger(value, minimum, maximum) { return Number.isInteger(Number(value)) ? Math.min(maximum, Math.max(minimum, Number(value))) : maximum; }
function identityIssue(recorded, current) {
  if (!current.exists) return { status: 'not_found', reason: current.identityStatus === 'missing' ? 'file_missing' : 'file_unavailable' };
  if (current.identityStatus !== 'verified') return { status: 'unverified', reason: current.identityStatus };
  if (!recorded.legacySnapshot && recorded.identityStatus !== 'verified') return { status: 'unverified', reason: 'recorded_identity_unverified' };
  if (!recorded.legacySnapshot && (recorded.sha256 !== current.sha256 || recorded.size !== current.size || recorded.realPath !== current.realPath)) return { status: 'stale', reason: 'artifact_content_changed' };
  return null;
}
function inspectFile(path, maximum, budget) {
  let fd;
  try {
    const linkInfo = lstatSync(path);
    const realPath = realpathSync.native(path);
    const info = statSync(path);
    const base = { exists: true, sha256: null, size: info.size, mtimeMs: info.mtimeMs, realPath, symbolicLink: linkInfo.isSymbolicLink() };
    if (!info.isFile()) return { ...base, identityStatus: 'not_a_file' };
    if (info.size > maximum || info.size > budget.remaining) return { ...base, identityStatus: 'hash_size_limit' };
    budget.remaining -= info.size;
    fd = openSync(path, 'r');
    const opened = fstatSync(fd);
    if (opened.size !== info.size || opened.mtimeMs !== info.mtimeMs || opened.ino !== info.ino || opened.dev !== info.dev) return { ...base, identityStatus: 'changed_during_inspection' };
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(Math.min(64 * 1024, Math.max(1, info.size)));
    let offset = 0;
    while (offset < info.size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, info.size - offset), offset);
      if (!count) return { ...base, identityStatus: 'changed_during_inspection' };
      hash.update(buffer.subarray(0, count)); offset += count;
    }
    const after = fstatSync(fd);
    const currentPathInfo = statSync(path);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || realpathSync.native(path) !== realPath
      || currentPathInfo.ino !== opened.ino || currentPathInfo.dev !== opened.dev || currentPathInfo.size !== after.size || currentPathInfo.mtimeMs !== after.mtimeMs) return { ...base, identityStatus: 'changed_during_inspection' };
    return { ...base, sha256: hash.digest('hex'), identityStatus: 'verified' };
  } catch (error) {
    return { exists: false, sha256: null, size: null, realPath: null, identityStatus: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unavailable', errorCode: error.code ?? 'WORK_MEMORY_FILE_INSPECTION_FAILED' };
  } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}
function hasExplicitSourcePath(text) {
  // Destination paths in a typed save clause do not replace the missing input operand.
  const withoutDestinations = text.replace(/["'“‘][^"'”’\r\n]+["'”’]\s*(?:(?:JSON|CSV|텍스트)(?:으로|로)|(?:으로|로))\s*저장/giu, ' 저장');
  return /[A-Za-z]:[\\/][^\r\n]|\\\\[^\s\\]+\\|(?:^|\s|["'“‘])\.{0,2}[\\/][^\s"'”’]+|(?:[\p{L}\p{N}_ .-]+[\\/])*[\p{L}\p{N}_-][\p{L}\p{N}_ .-]*\.[A-Za-z][A-Za-z0-9]{0,9}(?=$|[\s"'”’),;:!?]|[을를은는이가])/u.test(withoutDestinations);
}
function locateReference(text) {
  const ordinals = [...text.matchAll(ordinalPattern)];
  const demos = [...text.matchAll(demoPattern)];
  if (ordinals.length > 1 || demos.length > 1 || ordinals.length && demos.length) return { multiple: true };
  let phrase;
  let ordinal;
  if (ordinals[0]) {
    phrase = ordinals[0];
    const words = phrase[1].replace(/\s/gu, '');
    ordinal = ({ 첫: 1, 첫번째: 1, 두번째: 2, 세번째: 3, 네번째: 4, 다섯번째: 5, 여섯번째: 6, 일곱번째: 7, 여덟번째: 8, 아홉번째: 9, 열번째: 10 })[words] ?? Number.parseInt(words, 10);
  } else if (demos[0]) {
    const time = text.match(timePattern);
    const end = (time?.index ?? -1) + (time?.[0]?.length ?? 0);
    phrase = time && end >= demos[0].index + demos[0][0].length ? time : demos[0];
  } else {
    phrase = text.match(timePattern);
    if (!phrase || !new RegExp(creationWords, 'u').test(phrase[0]) && !typeHints.some((hint) => hint.pattern.test(phrase[0]))) return null;
  }
  return { matchedPhrase: phrase[0], start: phrase.index, end: phrase.index + phrase[0].length, ...(ordinal !== undefined ? { ordinal } : {}) };
}
function candidateSummary(artifact) {
  return { artifactId: artifact.artifactId, name: artifact.name ?? fileName(artifact.path), path: artifact.path, ordinal: artifact.ordinal, version: artifact.version, exists: artifact.exists ?? null, sha256: artifact.sha256 ?? null, size: artifact.size ?? null };
}
