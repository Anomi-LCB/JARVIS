import { createHash } from 'node:crypto';
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// A deliberately narrow outcome oracle. It has no dependency on the workflow
// compiler or execution engine; unsupported prose always remains unverified.
export const SOURCE_OUTCOME_ORACLE_VERSION = 'source-outcome-v1';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const within = (root, file) => { const rel = relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const q = "'([^'\\r\\n]{1,160})'";

function splitClauses(source) {
  const parts = []; let start = 0, quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "'") quoted = !quoted;
    else if (source[i] === ';' && !quoted) { parts.push({ text: source.slice(start, i).trim(), start, end: i }); start = i + 1; }
  }
  if (quoted) throw new Error('unclosed-quote');
  parts.push({ text: source.slice(start).trim(), start, end: source.length });
  return parts;
}

function parseObjective(source) {
  if (typeof source !== 'string' || source.length > 32768) throw new Error('objective-limit');
  const clauses = splitClauses(source);
  if (clauses.length !== 8) throw new Error('unsupported-clause-count');
  const patterns = [
    new RegExp(`^${q} JSON을 ${q}으로 읽고$`, 'u'),
    new RegExp(`^${q}에 ${q} = ${q} \\* ${q}를 계산해 ${q}으로 만들고$`, 'u'),
    new RegExp(`^${q}을 ${q} 내림차순으로 정렬해 ${q}로 만들고$`, 'u'),
    new RegExp(`^${q}를 ${q} JSON으로 저장하고$`, 'u'),
    new RegExp(`^${q} JSON을 ${q}로 읽고$`, 'u'),
    new RegExp(`^${q}의 ${q} 통계를 계산해 ${q}로 만들고$`, 'u'),
    new RegExp(`^${q}를 ${q} JSON으로 저장하고$`, 'u'),
    new RegExp(`^${q}의 행 수가 (\\d+)인지 검증해$`, 'u')
  ];
  const m = clauses.map((c, i) => patterns[i].exec(c.text));
  if (m.some(x => !x)) throw new Error('unsupported-clause');
  const [inputPath, sourceName] = m[0].slice(1);
  const [deriveName, derivedColumn, leftColumn, rightColumn, derivedName] = m[1].slice(1);
  const [sortName, sortColumn, rankedName] = m[2].slice(1);
  const direction = '내림차순';
  const [rankedWriteName, rankedPath] = m[3].slice(1);
  const [rankedReadPath, rereadName] = m[4].slice(1);
  const [statsInput, statsColumn, statsName] = m[5].slice(1);
  const [statsWriteName, statsPath] = m[6].slice(1);
  const [assertInput, countText] = m[7].slice(1);
  if (new Set([sourceName, derivedName, rankedName, rereadName, statsName]).size !== 5
    || deriveName !== sourceName || sortName !== derivedName || rankedWriteName !== rankedName
    || rankedReadPath !== rankedPath || statsInput !== rereadName || statsWriteName !== statsName
    || assertInput !== rereadName || sortColumn !== derivedColumn || direction !== '내림차순'
    || ![inputPath, rankedPath, statsPath].every(p => p && !p.includes('..') && !p.startsWith('/') && !p.includes('\\'))
    || new Set([inputPath, rankedPath, statsPath]).size !== 3) throw new Error('unsupported-alias-or-path');
  return { inputPath, rankedPath, statsPath, leftColumn, rightColumn, derivedColumn, count: Number(countText), clauses };
}

function safeRows(value) {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('input-must-be-bounded-row-array');
  for (const row of value) {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(k => ['__proto__','prototype','constructor'].includes(k))) throw new Error('unsafe-row');
  }
  return value;
}

export function rejectDuplicateKeys(text) {
  let i = 0;
  const ws = () => { while (/\s/u.test(text[i] ?? '')) i += 1; };
  function stringToken() {
    const start = i++;
    for (; i < text.length; i += 1) {
      if (text[i] === '\\') { i += 1; continue; }
      if (text[i] === '"') { i += 1; return JSON.parse(text.slice(start, i)); }
      if (text.charCodeAt(i) < 0x20) throw new Error('invalid-json-control-character');
    }
    throw new Error('invalid-json-string');
  }
  function value(depth = 0) {
    if (depth > 32) throw new Error('json-depth-limit'); ws(); const c = text[i];
    if (c === '{') {
      i += 1; ws(); const keys = new Set(); if (text[i] === '}') { i += 1; return; }
      while (i < text.length) {
        ws(); if (text[i] !== '"') throw new Error('invalid-json-object-key'); const key = stringToken();
        if (keys.has(key)) throw new Error('duplicate-json-key'); keys.add(key); ws(); if (text[i++] !== ':') throw new Error('invalid-json-object-separator');
        value(depth + 1); ws(); if (text[i] === '}') { i += 1; return; } if (text[i++] !== ',') throw new Error('invalid-json-object-separator');
      }
      throw new Error('invalid-json-object');
    }
    if (c === '[') { i += 1; ws(); if (text[i] === ']') { i += 1; return; } while (i < text.length) { value(depth + 1); ws(); if (text[i] === ']') { i += 1; return; } if (text[i++] !== ',') throw new Error('invalid-json-array-separator'); } throw new Error('invalid-json-array'); }
    if (c === '"') { stringToken(); return; }
    const rest = text.slice(i), primitive = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(rest);
    if (!primitive) throw new Error('invalid-json-value'); i += primitive[0].length;
  }
  value(); ws(); if (i !== text.length) throw new Error('invalid-json-trailing-data');
}

function stats(nums) {
  const a = [...nums].sort((x, y) => x - y), n = a.length;
  const sum = a.reduce((s, x) => s + x, 0), mean = sum / n;
  if (!Number.isSafeInteger(sum)) throw new Error('aggregate-exceeds-safe-integer-range');
  const quantile = p => { const i = (n - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };
  const variance = a.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  return { count: n, min: a[0], max: a[n - 1], sum, mean,
    median: quantile(.5), variance, stddev: Math.sqrt(variance), q1: quantile(.25), q3: quantile(.75) };
}

function readStableJson(root, relativePath) {
  const absolute = resolve(root, relativePath);
  if (!within(root, absolute)) throw new Error('path-outside-allowed-root');
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024) throw new Error('input-file-unsafe-or-too-large');
  const physical = realpathSync(absolute);
  if (!within(realpathSync(root), physical)) throw new Error('physical-path-outside-root');
  const fd = openSync(absolute, 'r');
  try {
    const before = fstatSync(fd); const buffer = Buffer.alloc(before.size);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0); const after = fstatSync(fd);
    if (bytesRead !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || realpathSync(absolute) !== physical) throw new Error('input-changed-during-read');
    const bytes = buffer.subarray(0, bytesRead);
    const text = bytes.toString('utf8'); rejectDuplicateKeys(text);
    return { bytes, sha256: hash(bytes), parsed: JSON.parse(text), physicalPath: physical };
  } finally { closeSync(fd); }
}

export function prepareSourceOutcome({ objective, allowedRoots = [] }) {
  let contract;
  try { contract = parseObjective(objective); }
  catch (error) { return { version: SOURCE_OUTCOME_ORACLE_VERSION, status: 'unsupported', reasons: [error.message], executionAuthority: false }; }
  try {
    if (allowedRoots.length !== 1) throw new Error('single-allowed-root-required');
    const root = resolve(allowedRoots[0]), source = readStableJson(root, contract.inputPath), rows = safeRows(source.parsed);
    if (!rows.length || rows.length !== contract.count) throw new Error('independent-row-count-failed');
    const ranked = rows.map(row => {
      const a = row[contract.leftColumn], b = row[contract.rightColumn];
      if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) throw new Error('input-requires-safe-integer-numbers');
      const amount = a * b; if (!Number.isSafeInteger(amount)) throw new Error('derived-value-exceeds-safe-integer-range');
      return { ...row, [contract.derivedColumn]: amount };
    }).sort((a, b) => b[contract.derivedColumn] - a[contract.derivedColumn]);
    const summary = stats(ranked.map(row => row[contract.derivedColumn]));
    return { version: SOURCE_OUTCOME_ORACLE_VERSION, status: 'prepared', objectiveSha256: hash(Buffer.from(objective)),
      root, inputPath: contract.inputPath, inputSha256: source.sha256, inputSize: source.bytes.length,
      rankedPath: contract.rankedPath, statsPath: contract.statsPath, ranked, summary,
      clauseCount: contract.clauses.length, preparedAt: new Date().toISOString(), executionAuthority: false };
  } catch (error) {
    return { version: SOURCE_OUTCOME_ORACLE_VERSION, status: 'blocked', reasons: [error.message], executionAuthority: false };
  }
}

export function verifySourceOutcome({ objective, statement, observations = [], allowedRoots = [], prepared = null }) {
  const reasons = [];
  try {
    const genericSuffix = ' 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.';
    const acceptedCriterion = statement === `${objective}${genericSuffix}`
      || statement === '요청한 형식과 저장 위치에 실제 산출물이 생성되고 다시 열 수 있음이 확인된다.';
    if (!acceptedCriterion) throw new Error('criterion-not-exact-supported-ui-criterion');
    if (allowedRoots.length !== 1) throw new Error('single-allowed-root-required');
    const expectation = prepared?.status === 'prepared' && prepared.objectiveSha256 === hash(Buffer.from(objective))
      ? prepared : prepareSourceOutcome({ objective, allowedRoots });
    if (expectation.status !== 'prepared') throw new Error(expectation.reasons?.[0] ?? 'source-outcome-preparation-missing');
    const root = resolve(allowedRoots[0]), contract = { inputPath: expectation.inputPath, rankedPath: expectation.rankedPath, statsPath: expectation.statsPath };
    const source = readStableJson(root, contract.inputPath);
    if (source.sha256 !== expectation.inputSha256 || source.bytes.length !== expectation.inputSize) throw new Error('source-changed-after-independent-preparation');
    const workflow = observations.find(o => o.toolName === 'workflow.execute' && o.outcome === 'success' && o.verification?.status === 'passed')?.data?.workflow;
    if (!workflow || !Array.isArray(workflow.receipts) || workflow.receipts.length !== workflow.nodeCount
      || workflow.receipts.some(r => r.status !== 'success')) throw new Error('complete-successful-workflow-receipts-required');
    const readReceipt = workflow.receipts.find(r => r.op === 'data.readJson' && r.source?.path && resolve(r.source.path) === resolve(root, contract.inputPath));
    if (!readReceipt || readReceipt.source.sha256 !== source.sha256 || readReceipt.source.size !== source.bytes.length) throw new Error('actual-input-read-does-not-match-independent-snapshot');
    const artifacts = observations.flatMap(o => o.artifacts ?? []);
    for (const path of [contract.rankedPath, contract.statsPath]) {
      const absolute = resolve(root, path), artifact = artifacts.find(a => a.contentSha256 && a.outsideAllowedRoots === false
        && ((a.path && resolve(a.path) === absolute) || (a.rootIndex === 0 && a.relativePath && resolve(root, a.relativePath) === absolute)));
      if (!artifact) throw new Error(`g-verified-artifact-missing:${path}`);
      const current = readStableJson(root, path);
      const expected = path === contract.rankedPath ? expectation.ranked : expectation.summary;
      if (artifact.contentSha256 !== current.sha256 || JSON.stringify(current.parsed) !== JSON.stringify(expected)) throw new Error(`current-artifact-content-mismatch:${path}`);
    }
    return { version: SOURCE_OUTCOME_ORACLE_VERSION, status: 'passed', reasons, inputSha256: source.sha256,
      rowCount: expectation.ranked.length, verifiedArtifactPaths: [contract.rankedPath, contract.statsPath], executionAuthority: false };
  } catch (error) {
    reasons.push(error.message);
    return { version: SOURCE_OUTCOME_ORACLE_VERSION, status: 'unverified', reasons, executionAuthority: false };
  }
}
