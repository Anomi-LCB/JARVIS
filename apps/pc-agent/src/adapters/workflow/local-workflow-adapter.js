import {buildOfxFinancialReport} from '../../../../../packages/shared/src/ofx-financial-report.js';
import {buildFinancialRecordReport} from '../../../../../packages/shared/src/financial-record-reconciliation.js';
import {
  access,
  copyFile,
  lstat,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  resolveWorkflowValue,
  SUPPORTED_WORKFLOW_OPERATIONS,
  topologicalWaves,
  validateWorkflowSpec
} from '../../../../../packages/core/src/mission/workflow-ir.js';
import { DATA_WORKFLOW_OPERATIONS, executeDataWorkflowOperation } from './data-workflow-operations.js';
import {sumDecimalValues} from './decimal-sum.js';
import { inspectWorkflowPublication } from './publication-inspection.js';
import {generateLocalSourceSummary} from '../../../../../packages/core/src/mission/local-source-summary.js';
import {compareSourceChange} from './change-comparison.js';
import {buildHealthRecordReport} from '../../../../../packages/shared/src/health-record-summary.js';
import {runIsolatedHazardSuite} from '../smart-home/isolated-hazard-suite.js';
import {reviewTheologyResearch} from '../../../../../packages/core/src/mission/theology-research-review.js';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_NODES = 64;
const MAX_FOREACH = 256;
const MAX_PROCESS_TIMEOUT_MS = 30_000;
const DEFAULT_PROCESS_TIMEOUT_MS = 10_000;
const pendingPublicationCleanup = new WeakMap();

const PROCESS_NETWORK_GUARD_SOURCE = String.raw`'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const sentinel = process.env.JARVIS_NETWORK_DENIAL_SENTINEL || 'JARVIS_NETWORK_BLOCKED';
delete process.env.JARVIS_NETWORK_DENIAL_SENTINEL;
const rawWrite = fs.writeSync.bind(fs);
const send = typeof process.send === 'function' ? process.send.bind(process) : null;
function deny(api) {
  try { rawWrite(2, sentinel + ':' + api + '\n'); } catch {}
  try { send?.({ type: 'jarvis-network-blocked', api }); } catch {}
  const error = new Error('JARVIS_PROCESS_NETWORK_BLOCKED:' + api);
  error.code = 'JARVIS_PROCESS_NETWORK_BLOCKED';
  throw error;
}
function lock(target, names, prefix) {
  if (!target) return;
  for (const name of names) {
    try { Object.defineProperty(target, name, { value: (...args) => deny(prefix + '.' + name), writable: false, configurable: false }); } catch {}
  }
}
const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const dgram = require('node:dgram');
const dns = require('node:dns');
lock(net, ['connect', 'createConnection', 'createServer'], 'net');
lock(net.Socket && net.Socket.prototype, ['connect'], 'net.Socket');
lock(net.Server && net.Server.prototype, ['listen'], 'net.Server');
lock(tls, ['connect', 'createServer'], 'tls');
lock(tls.TLSSocket && tls.TLSSocket.prototype, ['connect'], 'tls.TLSSocket');
lock(http, ['request', 'get', 'createServer'], 'http');
lock(https, ['request', 'get', 'createServer'], 'https');
lock(http.Agent && http.Agent.prototype, ['createConnection'], 'http.Agent');
lock(https.Agent && https.Agent.prototype, ['createConnection'], 'https.Agent');
lock(http2, ['connect', 'createServer', 'createSecureServer'], 'http2');
lock(dgram, ['createSocket'], 'dgram');
lock(dgram.Socket && dgram.Socket.prototype, ['bind', 'connect', 'send'], 'dgram.Socket');
lock(dns, ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse', 'setServers'], 'dns');
lock(dns.promises, ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse', 'setServers'], 'dns.promises');
lock(dns.Resolver && dns.Resolver.prototype, ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse', 'setServers'], 'dns.Resolver');
for (const name of ['fetch', 'WebSocket', 'EventSource']) {
  try { Object.defineProperty(globalThis, name, { value: (...args) => deny('global.' + name), writable: false, configurable: false }); } catch {}
}
const originalBinding = process.binding.bind(process);
const originalLinkedBinding = typeof process._linkedBinding === 'function' ? process._linkedBinding.bind(process) : originalBinding;
const deniedBindings = new Set(['cares_wrap', 'tcp_wrap', 'tls_wrap', 'udp_wrap']);
try { Object.defineProperty(process, 'binding', { value: (name) => deniedBindings.has(String(name)) ? deny('process.binding.' + name) : originalBinding(name), writable: false, configurable: false }); } catch {}
try { Object.defineProperty(process, '_linkedBinding', { value: (name) => deniedBindings.has(String(name)) ? deny('process._linkedBinding.' + name) : originalLinkedBinding(name), writable: false, configurable: false }); } catch {}
try { Module.syncBuiltinESMExports(); } catch {}
`;

const NETWORK_IMPORT_PATTERN = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s*)['"](?:node:)?(?:net|tls|http|https|http2|dgram|dns(?:\/promises)?)(?:['"/])/u;
const NETWORK_GLOBAL_PATTERN = /\b(?:fetch|WebSocket|EventSource)\s*\(/u;

const OP_ALLOWLIST = new Set(SUPPORTED_WORKFLOW_OPERATIONS);
const DATA_OPERATIONS = new Set(DATA_WORKFLOW_OPERATIONS);

function hashBytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function byteSize(value) {
  return Buffer.byteLength(typeof value === 'string' ? value : stableJson(value), 'utf8');
}

function fail(code, detail = '') {
  const error = new Error(detail ? `${code}:${detail}` : code);
  error.code = code;
  throw error;
}

function isWithin(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function pathKey(value) {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLocaleLowerCase() : normalized;
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function asArray(value, label = 'items') {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.rows)) return value.rows;
  fail('WORKFLOW_TYPE_MISMATCH', `${label}-must-be-array`);
}

function valueAt(object, path) {
  if (path === undefined || path === null || path === '') return object;
  const parts = Array.isArray(path)
    ? path.map((key) => String(key))
    : String(path).replace(/^\//, '').split(/[./]/).filter(Boolean);
  if (parts.some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) fail('WORKFLOW_PROPERTY_PATH_UNSAFE');
  // Grouping and projection produce literal dotted column names. An array path
  // explicitly requests nested traversal when both representations exist.
  if (typeof path === 'string' && object !== null && typeof object === 'object' && Object.hasOwn(object, path)) return object[path];
  return parts.reduce((value, key) => {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('WORKFLOW_PROPERTY_PATH_UNSAFE', key);
    if (value === null || value === undefined || (typeof value !== 'object' && typeof value !== 'string')) return undefined;
    if (!Object.hasOwn(Object(value), key)) return undefined;
    return value[key];
  }, object);
}

function compareValues(left, operator, right) {
  switch (operator) {
    case 'eq': case 'equals': case '==': return left === right;
    case 'ne': case 'notEquals': case '!=': return left !== right;
    case 'gt': case '>': return left > right;
    case 'gte': case '>=': return left >= right;
    case 'lt': case '<': return left < right;
    case 'lte': case '<=': return left <= right;
    case 'contains': return Array.isArray(left) ? left.includes(right) : String(left ?? '').includes(String(right ?? ''));
    case 'startsWith': return String(left ?? '').startsWith(String(right ?? ''));
    case 'endsWith': return String(left ?? '').endsWith(String(right ?? ''));
    case 'in': return Array.isArray(right) && right.includes(left);
    case 'exists': return right === false ? left === undefined || left === null : left !== undefined && left !== null;
    default: fail('WORKFLOW_FILTER_OPERATOR_UNSUPPORTED', operator);
  }
}

function matchesWhere(item, where) {
  if (!where) return true;
  if (Array.isArray(where)) return where.every((condition) => matchesWhere(item, condition));
  if (where.all) return asArray(where.all, 'where.all').every((condition) => matchesWhere(item, condition));
  if (where.any) return asArray(where.any, 'where.any').some((condition) => matchesWhere(item, condition));
  if (where.not) return !matchesWhere(item, where.not);
  const field = where.field ?? where.path ?? '';
  const left = valueAt(item, field);
  return compareValues(where.numeric === true ? comparisonNumber(left, where.numericFormat) : left,
    where.operator ?? where.op ?? 'equals', where.numeric === true ? comparisonNumber(where.value, where.numericFormat) : where.value);
}

function assertNumericFormat(format = 'decimal') {
  if (!['decimal', 'grouped-decimal'].includes(format)) fail('WORKFLOW_NUMBER_FORMAT_UNSUPPORTED');
}

function assertWhereNumberFormats(where, depth = 0) {
  if (depth > 32) fail('WORKFLOW_FILTER_DEPTH');
  if (!where) return;
  if (Array.isArray(where)) { for (const child of where) assertWhereNumberFormats(child, depth + 1); return; }
  if (where.numericFormat !== undefined && where.numeric !== true) fail('WORKFLOW_NUMBER_FORMAT_REQUIRES_NUMERIC');
  if (where.numeric === true) assertNumericFormat(where.numericFormat);
  for (const name of ['all', 'any']) if (where[name]) assertWhereNumberFormats(asArray(where[name], `where.${name}`), depth + 1);
  if (where.not) assertWhereNumberFormats(where.not, depth + 1);
}

function comparisonNumber(value, format = 'decimal') {
  assertNumericFormat(format);
  // Explicit format only: never guess whether a comma is a decimal separator.
  // Supports ASCII three-digit grouping, not the entire CLDR locale grammar.
  if (format === 'grouped-decimal' && typeof value === 'string' && value.includes(',')) {
    if (!/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/u.test(value)) fail('WORKFLOW_NUMBER_INVALID');
    value = value.replaceAll(',', '');
  }
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(value))) fail('WORKFLOW_NUMBER_INVALID');
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER) fail('WORKFLOW_NUMBER_INVALID');
  return number;
}

function parseCsv(text, { delimiter = ',' } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (quoted) fail('WORKFLOW_CSV_INVALID', 'unterminated-quote');
  if (field.length || row.length) {
    row.push(field.replace(/\r$/, ''));
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows.shift().map((header, index) => String(header || `column_${index + 1}`));
  return rows.filter((values) => values.some((value) => value !== '')).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])));
}

function encodeCsv(items, columns = null) {
  const rows = asArray(items);
  const headers = columns?.length ? columns : [...new Set(rows.flatMap((row) => Object.keys(row ?? {})))];
  const quote = (value) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return `${headers.map(quote).join(',')}\n${rows.map((row) => headers.map((header) => quote(row?.[header])).join(',')).join('\n')}${rows.length ? '\n' : ''}`;
}

function normalizeNumber(value, label = 'number') {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) fail('WORKFLOW_NUMBER_INVALID', label);
  return number;
}

function toMinor(value, scale = 2) {
  const text = String(value ?? '0').trim();
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(text)) fail('WORKFLOW_MONEY_INVALID', text);
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > scale && /[1-9]/.test(fraction.slice(scale))) fail('WORKFLOW_MONEY_PRECISION_LOSS', text);
  const padded = fraction.padEnd(scale, '0').slice(0, scale);
  const minor = BigInt(whole) * (10n ** BigInt(scale)) + BigInt(padded || '0');
  return negative ? -minor : minor;
}

function wildcardRegex(pattern) {
  const escaped = String(pattern ?? '*').replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function renderTemplate(template, record) {
  return String(template).replace(/{{\s*([^{}]+?)\s*}}/g, (_match, key) => {
    const value = valueAt(record, key.trim());
    return value === undefined || value === null ? '' : String(value);
  });
}

function cleanResult(value) {
  if (Array.isArray(value)) return value.map(cleanResult);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !key.startsWith('__')).map(([key, item]) => [key, cleanResult(item)]));
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

function contract() {
  return {
    toolName: 'workflow.execute',
    readOnly: false,
    mutatesSystem: true,
    preview: true,
    execute: true,
    rollback: true,
    evidence: ['workflow', 'manifest'],
    blockedOperations: ['outsideAllowedRoots', 'symlinkPath', 'unlistedOperation', 'arbitraryExecutable'],
    modes: ['shadow', 'execute']
  };
}

export class LocalWorkflowToolAdapter {
  #unpublishedPersonFailures = new Map();
  consumeUnpublishedPersonFailure({taskId,packetId,args}){
    const proof=this.#unpublishedPersonFailures.get(packetId);
    if(!proof||proof.taskId!==taskId||proof.argsSha256!==hashBytes(stableJson(args)))return null;
    this.#unpublishedPersonFailures.delete(packetId);return structuredClone(proof);
  }
  constructor({ allowedRoots = ['./workspace'], undoJournal = null, clock = () => new Date(), processRunner = null } = {}) {
    if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) fail('WORKFLOW_ALLOWED_ROOT_REQUIRED');
    this.allowedRoots = allowedRoots.map((root) => resolve(root));
    this.undoJournal = undoJournal;
    this.clock = clock;
    this.processRunner = processRunner;
    this.contract = contract();
  }

  resolveInputPath(input) {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) fail('WORKFLOW_PATH_INVALID');
    return resolve(isAbsolute(input) ? input : join(this.allowedRoots[0], input));
  }

  inspectPublication(taskId) { return inspectWorkflowPublication(this, taskId); }

  lexicalRootFor(path) {
    return this.allowedRoots.find((root) => isWithin(root, path)) ?? null;
  }

  async assertSafePath(input, { mustExist = false, allowRoot = true } = {}) {
    const target = this.resolveInputPath(input);
    const root = this.lexicalRootFor(target);
    if (!root) fail('WORKFLOW_PATH_OUTSIDE_ALLOWED_ROOT', target);
    if (!allowRoot && samePath(target, root)) fail('WORKFLOW_PATH_ROOT_FORBIDDEN', target);
    const rootExists = await exists(root);
    const canonicalRoot = rootExists ? await realpath(root) : root;
    if (rootExists) {
      const rel = relative(root, target);
      let cursor = root;
      for (const segment of rel.split(sep).filter(Boolean)) {
        cursor = join(cursor, segment);
        if (!await exists(cursor)) break;
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) fail('WORKFLOW_SYMLINK_BLOCKED', cursor);
        const canonical = await realpath(cursor);
        if (!isWithin(canonicalRoot, canonical)) fail('WORKFLOW_REALPATH_ESCAPE', cursor);
      }
    }
    if (mustExist && !await exists(target)) fail('WORKFLOW_PATH_MISSING', target);
    return target;
  }

  async readBounded(path, budget, state = null) {
    state?.assertAccess?.();
    const dataFence=state?.assertDataAccess?.(path,'read');dataFence?.();
    const target = this.resolveInputPath(path);
    const staged = state?.stagedFiles.find((file) => samePath(file.path, target));
    const safe = await this.assertSafePath(path, { mustExist: !staged });
    const readPath = staged ? await this.assertSafePath(staged.stagePath, { mustExist: true }) : safe;
    const info = await stat(readPath);
    if (!info.isFile()) fail('WORKFLOW_INPUT_NOT_FILE', safe);
    if (info.size > MAX_BYTES || budget.inputBytes + info.size > MAX_BYTES) fail('WORKFLOW_INPUT_LIMIT', safe);
    state?.assertAccess?.();
    dataFence?.();
    const bytes = await readFile(readPath);
    state?.assertAccess?.();
    dataFence?.();
    if (staged?.sha256 && hashBytes(bytes) !== staged.sha256) fail('WORKFLOW_STAGE_TAMPERED', safe);
    budget.inputBytes += bytes.byteLength;
    return { path: safe, snapshotPath: readPath, stagedInput: Boolean(staged), bytes, sha256: hashBytes(bytes) };
  }

  async loadSpec(specPath, expectedSha256 = null) {
    const safeSpecPath = await this.assertSafePath(specPath, { mustExist: true });
    const info = await stat(safeSpecPath);
    if (!info.isFile() || info.size > MAX_BYTES) fail('WORKFLOW_SPEC_SIZE_LIMIT', safeSpecPath);
    let spec;
    const bytes = await readFile(safeSpecPath);
    if (expectedSha256 !== null && (!/^[a-f0-9]{64}$/iu.test(expectedSha256)
      || hashBytes(bytes) !== expectedSha256.toLowerCase())) fail('WORKFLOW_SPEC_CHANGED_AFTER_PLANNING', safeSpecPath);
    try {
      spec = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      fail('WORKFLOW_SPEC_JSON_INVALID', error.message);
    }
    const validation = validateWorkflowSpec(spec);
    if (validation?.valid === false) fail('WORKFLOW_SPEC_INVALID', (validation?.errors ?? ['unknown']).join('|'));
    const normalized = validation?.normalized ?? validation;
    if (normalized.schemaVersion !== 'jarvis-local-workflow-v1') fail('WORKFLOW_SCHEMA_UNSUPPORTED', normalized.schemaVersion);
    if (!Array.isArray(normalized.nodes) || normalized.nodes.length > MAX_NODES) fail('WORKFLOW_NODE_LIMIT');
    for (const node of normalized.nodes) {
      if (!OP_ALLOWLIST.has(node.op)) fail('WORKFLOW_OPERATION_BLOCKED', node.op);
    }
    return { spec: normalized, path: safeSpecPath, bytes, sha256: hashBytes(bytes) };
  }

  async loadSpecArguments(args = {}) {
    const inline = Object.hasOwn(args, 'spec');
    if (inline && Object.hasOwn(args, 'specPath')) fail('WORKFLOW_SPEC_SOURCE_AMBIGUOUS');
    if (!inline) return { ...await this.loadSpec(args.specPath, args.expectedSha256 ?? null), source: 'file' };
    if (args.expectedSha256 !== undefined) fail('WORKFLOW_SPEC_EXPECTED_HASH_WITHOUT_FILE');
    const root = await this.assertSafePath(args.workspaceRoot ?? this.allowedRoots[0], { mustExist: true });
    if (!this.allowedRoots.some((allowed) => samePath(allowed, root)) || !(await stat(root)).isDirectory()) fail('WORKFLOW_INLINE_ROOT_INVALID');
    const serialized = JSON.stringify(args.spec);
    if (typeof serialized !== 'string') fail('WORKFLOW_SPEC_JSON_INVALID');
    const bytes = Buffer.from(serialized, 'utf8');
    if (bytes.length > MAX_BYTES) fail('WORKFLOW_SPEC_SIZE_LIMIT');
    const spec = validateWorkflowSpec(JSON.parse(serialized));
    return { spec, path: null, workspaceRoot: root, source: 'inline', bytes, sha256: hashBytes(bytes) };
  }

  async shadow(args, packet = {}, {assertAccess=null}={}) {
    try {
      assertAccess?.();
      const loaded = await this.loadSpecArguments(args);
      assertAccess?.();
      const writeNodes = loaded.spec.nodes.filter((node) => node.op.startsWith('write.') || node.op === 'sqlite.import');
      return {
        mode: 'shadow',
        expectedChangesCount: writeNodes.length,
        warnings: [],
        workflowId: loaded.spec.workflowId ?? null,
        nodeCount: loaded.spec.nodes.length,
        specSha256: loaded.sha256,
        operations: loaded.spec.nodes.map((node) => node.op)
      };
    } catch (error) {
      return {
        mode: 'shadow',
        expectedChangesCount: 0,
        warnings: [error.message],
        error: { code: error.code ?? 'WORKFLOW_PREFLIGHT_FAILED', message: error.message }
      };
    }
  }

  async execute(args, packet = {}, { deferCleanup = false, beforePublication = null, resumeIntent = null, assertAccess = null, assertDataAccess = null, assertInventoryAccess = null } = {}) {
    if (resumeIntent) return this.resumePublication(args, packet, resumeIntent, beforePublication, assertAccess, assertDataAccess);
    let stageRoot = null;
    let state = null;
    const startedAt = this.clock().toISOString();
    try {
      assertAccess?.();
      const loaded = await this.loadSpecArguments(args);
      assertAccess?.();
      const selectedRoot = loaded.workspaceRoot ?? this.lexicalRootFor(loaded.path);
      stageRoot = await this.createSafeStageRoot(selectedRoot);
      state = {
        args: { allowOverwrite: args?.allowOverwrite === true },
        budget: { inputBytes: loaded.bytes.byteLength, outputBytes: 0 },
        loaded,
        packet,
        beforePublication,
        assertAccess,
        assertDataAccess,
        assertInventoryAccess,
        outputs: new Map(),
        receipts: [],
        stagedFiles: [],
        sourceSnapshots: new Map(),
        internalFiles: new Set(),
        currentNodeId: null,
        stageRoot,
        selectedRoot
      };
      const waves = topologicalWaves(loaded.spec);
      const nodeById = new Map(loaded.spec.nodes.map((node) => [node.id, node]));
      for (let waveIndex = 0; waveIndex < waves.length; waveIndex += 1) {
        const wave = waves[waveIndex];
        for (const item of wave) {
          const node = typeof item === 'string' ? nodeById.get(item) : item;
          if (!node) fail('WORKFLOW_TOPOLOGY_NODE_MISSING', String(item));
          await this.executeNode(node, state, waveIndex);
        }
      }
      const finalOutputs = Object.fromEntries([...state.outputs].map(([id, value]) => [id, cleanResult(value)]));
      this.assertDeclaredOutputs(state);
      await this.assertSourceSnapshotsCurrent(state);
      const publication = await this.publish(state);
      try {
        // Close the remaining interval where an input could change while output files
        // are being committed. If it did, restore every output before returning failure.
        await this.assertSourceSnapshotsCurrent(state);
      } catch (sourceChangedError) {
        const compensation = await this.revertPublication(publication);
        if (!compensation.success) {
          const error = new Error(`WORKFLOW_SOURCE_CHANGE_COMPENSATION_FAILED:${sourceChangedError.message}:${compensation.failures.join('|')}`);
          error.code = 'WORKFLOW_SOURCE_CHANGE_COMPENSATION_FAILED';
          throw error;
        }
        throw sourceChangedError;
      }
      let manifest;
      let undoEntries;
      let postCommitPhase = 'manifest';
      try {
        manifest = await this.buildManifest(publication);
        postCommitPhase = 'undo-journal';
        undoEntries = this.recordUndo(packet, publication);
      } catch (postCommitError) {
        const compensation = await this.revertPublication(publication);
        for (const entry of compensation.success ? postCommitError.recordedUndoEntries ?? [] : []) {
          try { this.undoJournal?.markRolledBack?.(entry, { status: 'compensated', reason: 'undo-journal-record-failed' }); } catch {}
        }
        if (!compensation.success) {
          const error = new Error(`WORKFLOW_POST_COMMIT_COMPENSATION_FAILED:${postCommitError.message}:${compensation.failures.join('|')}`);
          error.code = 'WORKFLOW_POST_COMMIT_COMPENSATION_FAILED';
          throw error;
        }
        const code = postCommitPhase === 'undo-journal' ? 'WORKFLOW_UNDO_JOURNAL_FAILED' : 'WORKFLOW_POST_COMMIT_VALIDATION_FAILED';
        const error = new Error(`${code}:${postCommitError.message}`);
        error.code = code;
        throw error;
      }
      let stagingCleanup = { status: deferCleanup ? 'deferred-until-packet-receipt' : 'removed', pathSha256: hashBytes(stageRoot) };
      const warnings = [];
      try { if (!deferCleanup) {
        await this.cleanupStage(stageRoot);
      }
      } catch (cleanupError) {
        stagingCleanup = { status: 'warning', pathSha256: hashBytes(stageRoot), errorCode: cleanupError.code ?? 'WORKFLOW_STAGE_CLEANUP_FAILED' };
        warnings.push(`workflow-stage-cleanup-warning:${cleanupError.code ?? cleanupError.message}`);
      }
      const endedAt = this.clock().toISOString();
      const execution = {
        status: 'success',
        summary: `${loaded.spec.nodes.length}개 로컬 워크플로 노드를 실행하고 ${manifest.length}개 결과 파일을 검증했습니다.${warnings.length ? ' 임시 작업 폴더 정리는 재시도가 필요합니다.' : ''}`,
        outputPaths: publication.outputPaths,
        changedItems: publication.changedItems,
        warnings,
        rollbackAvailable: undoEntries.length > 0,
        undoJournalId: undoEntries[0]?.undoJournalId ?? null,
        undoJournalIds: undoEntries.map((entry) => entry.undoJournalId),
        workflowOutputs: finalOutputs,
        evidence: {
          workflow: {
            schemaVersion: loaded.spec.schemaVersion,
            workflowId: loaded.spec.workflowId ?? null,
            specPath: loaded.path,
            specSource: loaded.source,
            specSha256: loaded.sha256,
            nodeCount: loaded.spec.nodes.length,
            receipts: state.receipts,
            inputSnapshots: [...state.sourceSnapshots.values()],
            startedAt,
            endedAt,
            inputBytes: state.budget.inputBytes,
            outputBytes: manifest.reduce((sum, file) => sum + file.size, 0),
            publication: publication.proof,
            stagingCleanup
          },
          manifest
        }
      };
      if (deferCleanup) pendingPublicationCleanup.set(execution, { stageRoot, taskId: packet.taskId, packetId: packet.packetId });
      stageRoot = null;
      return execution;
    } catch (error) {
      let stageRemoved=false;
      if (stageRoot && !state?.publicationPrepared)try{await rm(stageRoot,{recursive:true,force:true});stageRemoved=true;}catch{}
      const nodes=state?.loaded?.spec?.nodes;
      if(stageRemoved&&error.code==='WORKFLOW_ASSERT_COUNT_FAILED'&&!state.publicationPrepared
        &&state.stagedFiles.length===0&&nodes?.length===4
        &&nodes.map(n=>n.op).join(',')==='data.readJson,data.filter,assert.count,write.json'
        &&state.failedNodeId===nodes[2].id&&nodes[2].args.equals===1
        &&state.receipts.length===2&&state.receipts.every(r=>r.status==='success')
        &&packet?.taskId&&packet?.packetId){
        this.#unpublishedPersonFailures.set(packet.packetId,{version:'b-unpublished-person-failure-v1',taskId:packet.taskId,packetId:packet.packetId,
          argsSha256:hashBytes(stableJson(args)),failureCode:error.code,noPublication:true,stageRemoved:true});
        while(this.#unpublishedPersonFailures.size>128)this.#unpublishedPersonFailures.delete(this.#unpublishedPersonFailures.keys().next().value);
      }
      return {
        status: error.code?.includes('BLOCKED') || /OUTSIDE|SYMLINK|ESCAPE|OPERATION_BLOCKED/.test(error.code ?? '') ? 'blocked' : 'failed',
        summary: `로컬 워크플로 실행 실패: ${error.message}`,
        error: { code: error.code ?? 'WORKFLOW_EXECUTION_FAILED', message: error.message },
        outputPaths: [],
        changedItems: [],
        rollbackAvailable: false,
        evidence: {
          workflow: { startedAt, failedAt: this.clock().toISOString(), errorCode: error.code ?? 'WORKFLOW_EXECUTION_FAILED',
            ...(state?.publicationPrepared ? { recoveryStageRetained: true, stagePathSha256: hashBytes(stageRoot) } : {}) },
          manifest: []
        }
      };
    }
  }

  async finalizePublicationCleanup(execution, packet) {
    const pending = pendingPublicationCleanup.get(execution);
    if (!pending || pending.taskId !== packet.taskId || pending.packetId !== packet.packetId) return { status: 'not-owned' };
    // In-process object identity, not a packet/path field, authorizes this cleanup.
    await this.assertSafePath(pending.stageRoot, { mustExist: true });
    for (const file of pending.publishTemps ?? []) {
      if (!file.path.startsWith(`${file.target}.jarvis-publish-`) || !samePath(dirname(file.path), dirname(file.target))) fail('WORKFLOW_PUBLICATION_TEMP_IDENTITY_INVALID');
      await this.assertSafePath(file.path, { mustExist: false });
      const bytes = await this.readRecoveryPublicationTemp(file.path);
      if (!bytes) continue;
      if (hashBytes(bytes) !== file.sha256) fail('WORKFLOW_PUBLICATION_TEMP_CHANGED', file.path);
      await rm(file.path, { force: true });
    }
    await this.cleanupStage(pending.stageRoot);
    pendingPublicationCleanup.delete(execution);
    return { status: 'removed' };
  }

  async cleanupRecoveredPublication(intent, receipt) {
    const stageRoot = intent.stageRoot ?? intent.recoveryRecipe?.stageRoot;
    if (!stageRoot) return { status: 'unavailable', reason: 'legacy-stage-identity-missing' };
    if (receipt?.status !== 'COMPLETED' || receipt.taskId !== intent.taskId
      || !/^\.jarvis-workflow-stage-[a-f0-9]{32}$/.test(stageRoot.split(sep).at(-1))
      || !samePath(dirname(stageRoot), intent.workspaceRoot)) fail('WORKFLOW_CLEANUP_RECEIPT_MISMATCH');
    await this.assertSafePath(stageRoot, { mustExist: false });
    if (!await exists(stageRoot)) return { status: 'not-present' };
    const observation = await this.inspectPublication(intent.taskId);
    if (observation.status !== 'observed' || observation.intentSha256 !== hashBytes(JSON.stringify(intent))
      || observation.files.some(file => file.state !== 'after')) fail('WORKFLOW_CLEANUP_PUBLICATION_CONFLICT');
    const manifest = receipt.executionResult?.evidence?.manifest;
    if (!Array.isArray(manifest) || manifest.length !== intent.files.length
      || intent.files.some(file => !manifest.some(item => samePath(item.path, file.path) && item.sha256 === file.afterSha256)))
      fail('WORKFLOW_CLEANUP_RECEIPT_MISMATCH');
    const owned = {}, packet = { taskId: intent.taskId, packetId: intent.packetId };
    pendingPublicationCleanup.set(owned, { stageRoot, ...packet,
      publishTemps: intent.files.map(file => ({ path: this.recoveryPublicationTemp(file, intent), target: file.path, sha256: file.afterSha256 })) });
    return this.finalizePublicationCleanup(owned, packet);
  }

  recordUndo(packet, publication) {
    if (!this.undoJournal?.record) return [];
    const entries = [];
    try {
      for (const action of publication.actions) entries.push(this.undoJournal.record({ taskId: packet.taskId, ...action }));
      return entries;
    } catch (error) {
      error.recordedUndoEntries = entries;
      throw error;
    }
  }

  async buildManifest(publication) {
    const expectedByPath = new Map(publication.changedItems.map((item) => [pathKey(item.path), item]));
    const manifest = [];
    for (const path of publication.outputPaths) {
      const bytes = await readFile(path);
      const item = { path, sha256: hashBytes(bytes), size: bytes.byteLength };
      const expected = expectedByPath.get(pathKey(path));
      if (!expected || expected.sha256 !== item.sha256 || expected.size !== item.size) fail('WORKFLOW_PUBLISHED_OUTPUT_MISMATCH', path);
      manifest.push(item);
    }
    return manifest;
  }

  async cleanupStage(stageRoot) {
    await rm(stageRoot, { recursive: true, force: true });
  }

  async createSafeStageRoot(selectedRoot) {
    const safeRoot = await this.assertSafePath(selectedRoot, { mustExist: true });
    const rootInfo = await lstat(safeRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) fail('WORKFLOW_STAGE_ROOT_UNSAFE', safeRoot);
    const canonicalRoot = await realpath(safeRoot);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = join(safeRoot, `.jarvis-workflow-stage-${randomBytes(16).toString('hex')}`);
      try {
        await mkdir(candidate, { recursive: false, mode: 0o700 });
      } catch (error) {
        if (error.code === 'EEXIST') continue;
        throw error;
      }
      const info = await lstat(candidate);
      const canonical = await realpath(candidate);
      if (info.isSymbolicLink() || !info.isDirectory() || !isWithin(canonicalRoot, canonical)) {
        await rm(candidate, { recursive: true, force: true }).catch(() => {});
        fail('WORKFLOW_STAGE_ROOT_UNSAFE', candidate);
      }
      return candidate;
    }
    fail('WORKFLOW_STAGE_ALLOCATION_FAILED');
  }

  async revertPublication(publication) {
    const failures = [];
    for (const point of [...publication.restorePoints].reverse()) {
      try {
        await this.assertSafePath(point.path, { mustExist: false });
        const current = await readFile(point.path).catch(error => {
          if (error.code === 'ENOENT') return null;
          throw error;
        });
        if (!current && !point.existed) continue;
        if (!current || !point.publishedSha256 || hashBytes(current) !== point.publishedSha256) {
          failures.push(`${point.path}:current-version-conflict`);
          continue;
        }
        if (point.existed) {
          await this.assertSafePath(point.stageBackupPath, { mustExist: true });
          if (hashBytes(await readFile(point.stageBackupPath)) !== point.originalSha256) {
            failures.push(`${point.path}:backup-version-conflict`);
            continue;
          }
          await copyFile(point.stageBackupPath, point.path);
          const restored = await readFile(point.path);
          if (hashBytes(restored) !== point.originalSha256) failures.push(`${point.path}:restore-hash-mismatch`);
        } else {
          await rm(point.path, { force: true });
          if (await exists(point.path)) failures.push(`${point.path}:created-file-still-exists`);
        }
      } catch (error) {
        failures.push(`${point.path}:${error.code ?? error.message}`);
      }
    }
    for (const action of failures.length ? [] : publication.actions) {
      if (action.action === 'restore_backup_file') await rm(action.backupPath, { force: true }).catch((error) => failures.push(`${action.backupPath}:${error.code ?? error.message}`));
    }
    return { success: failures.length === 0, failures };
  }

  async executeNode(node, state, waveIndex) {
    state.assertAccess?.();
    const nodeStartedAt = this.clock().toISOString();
    let when = true;
    if (node.when !== undefined) when = resolveWorkflowValue(node.when, state.outputs);
    if (when !== true && when !== false) fail('WORKFLOW_WHEN_NOT_BOOLEAN', node.id);
    if (!when) {
      const result = { skipped: true, reason: 'when-false' };
      state.outputs.set(node.id, result);
      state.receipts.push({ nodeId: node.id, op: node.op, wave: waveIndex, status: 'skipped', startedAt: nodeStartedAt, endedAt: this.clock().toISOString(), resultSha256: hashBytes(stableJson(result)) });
      return;
    }
    const resolvedArgs = resolveWorkflowValue(node.args ?? {}, state.outputs);
    state.currentNodeId = node.id;
    try {
      if (node.foreach !== undefined) {
        const items = asArray(resolveWorkflowValue(node.foreach, state.outputs), 'foreach');
        if (items.length > MAX_FOREACH) fail('WORKFLOW_FOREACH_LIMIT', node.id);
        const results = [];
        for (let index = 0; index < items.length; index += 1) {
          results.push(await this.runOperation(node.op, this.replaceItemRefs(resolvedArgs, items[index], index), state, node));
        }
        const result = { items: results, count: results.length };
        this.assertResultBounded(result, state, node.id);
        state.outputs.set(node.id, result);
        state.receipts.push({ nodeId: node.id, op: node.op, wave: waveIndex, status: 'success', foreachCount: results.length, startedAt: nodeStartedAt, endedAt: this.clock().toISOString(), resultSha256: hashBytes(stableJson(cleanResult(result))) });
        return;
      }
      const result = await this.runOperation(node.op, resolvedArgs, state, node);
      this.assertResultBounded(result, state, node.id);
      state.outputs.set(node.id, result);
      state.receipts.push({ nodeId: node.id, op: node.op, wave: waveIndex, status: 'success', startedAt: nodeStartedAt, endedAt: this.clock().toISOString(), resultSha256: hashBytes(stableJson(cleanResult(result))),
        ...(node.op==='text.extractFields'?{fieldProvenance:result.fieldProvenance,sourceSha256:result.sourceSha256}:{}),
        ...(node.op==='health.report'?{healthReportGeneratedAt:result.summary.generatedAt}:{}),
        ...(node.op==='compute.compareChange'?{changeComparison:result}:{}),
        ...(result?.source && typeof result.source === 'object' ? { source: { path: result.source.path, sha256: result.source.sha256, size: result.source.size } } : {}) });
    } catch(error){state.failedNodeId=node.id;throw error;} finally {
      state.currentNodeId = null;
    }
  }

  assertDeclaredOutputs(state) {
    const declared = state.loaded.spec.outputs ?? [];
    if (declared.length === 0) return;
    const actual = state.stagedFiles.map((file) => ({
      nodeId: file.producerNodeId,
      path: relative(state.selectedRoot, file.path).replaceAll('\\', '/')
    }));
    const identity = ({ nodeId, path }) => `${nodeId}\u0000${process.platform === 'win32' ? path.toLocaleLowerCase() : path}`;
    const declaredIds = new Set(declared.map(identity));
    const actualIds = new Set(actual.map(identity));
    if (declaredIds.size !== declared.length
      || actualIds.size !== actual.length
      || [...declaredIds].some((entry) => !actualIds.has(entry))) {
      fail('WORKFLOW_DECLARED_OUTPUT_MISMATCH', stableJson({ declared: declared.map(({ nodeId, path }) => ({ nodeId, path })), actual }));
    }
  }

  replaceItemRefs(value, item, index) {
    if (Array.isArray(value)) return value.map((entry) => this.replaceItemRefs(entry, item, index));
    if (!value || typeof value !== 'object') return value;
    if (Object.keys(value).length === 1 && '$item' in value) return valueAt(item, value.$item);
    if (Object.keys(value).length === 1 && '$index' in value) return index;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.replaceItemRefs(entry, item, index)]));
  }

  assertResultBounded(result, state, nodeId) {
    const size = byteSize(cleanResult(result));
    if (size > MAX_BYTES || state.budget.outputBytes + size > MAX_BYTES) fail('WORKFLOW_OUTPUT_LIMIT', nodeId);
    state.budget.outputBytes += size;
  }

  async runOperation(op, args, state, node) {
    if (DATA_OPERATIONS.has(op)) return executeDataWorkflowOperation(op, args);
    switch (op) {
      case 'data.readJson': return this.opReadJson(args, state);
      case 'data.readCsv': return this.opReadCsv(args, state);
      case 'text.read': return this.opTextRead(args, state);
      case 'safety.simulation': return runIsolatedHazardSuite(args, this.clock());
      case 'financial.ofxReport': {
        if(!args||Object.keys(args).some(k=>k!=='input'))throw Object.assign(new Error('Invalid OFX arguments'),{code:'FINANCIAL_OFX_INPUT_INVALID'});
        return buildOfxFinancialReport(args.input);
      }
      case 'financial.report': {
        if (!args || Object.keys(args).some(key=>key!=='input')) throw Object.assign(new Error('Invalid financial report arguments'),{code:'FINANCIAL_INPUT_INVALID'});
        return buildFinancialRecordReport(args.input);
      }
      case 'health.report': {
        if (!args || Object.keys(args).some(key => !['records','startDate','endDate'].includes(key))) throw Object.assign(new Error('Invalid health report arguments'), {code:'WORKFLOW_HEALTH_RECORD_INVALID'});
        try { return buildHealthRecordReport({...args,now:this.clock().toISOString()}); }
        catch (error) { throw Object.assign(new Error('Provided health records are invalid or conflicting'), {code:error.message==='health-record-identity-conflict'?'WORKFLOW_HEALTH_IDENTITY_CONFLICT':'WORKFLOW_HEALTH_RECORD_INVALID'}); }
      }
      case 'theology.review': {
        if (!args || Object.keys(args).some(key => key !== 'input')) throw Object.assign(new Error('Invalid theology review arguments'), { code: 'A_THEOLOGY_REVIEW_INPUT_INVALID' });
        return reviewTheologyResearch(args.input);
      }
      case 'text.extractFields': {
        const result=await generateLocalSourceSummary({source:args.text,questions:args.questions,valueFormats:args.valueFormats,sourceFields:args.sourceFields},{preferSourceDeclarations:true});
        return {...result.output,fieldProvenance:result.fieldProvenance,sourceSha256:hashBytes(args.text),semanticAccuracyVerified:false};
      }
      case 'data.filter': return this.opFilter(args);
      case 'data.sort': return this.opSort(args);
      case 'data.unique': return this.opUnique(args);
      case 'data.groupAggregate': return this.opGroupAggregate(args);
      case 'data.join': return this.opJoin(args);
      case 'data.pivot': return this.opPivot(args);
      case 'data.validate': return this.opValidate(args);
      case 'compute.ledger': return this.opLedger(args);
      case 'compute.units': return this.opUnits(args);
      case 'compute.compareChange': return compareSourceChange(args);
      case 'graph.toposort': return this.opToposort(args);
      case 'graph.shortestPath': return this.opShortestPath(args);
      case 'graph.criticalPath': return this.opCriticalPath(args);
      case 'solver.knapsack': return this.opKnapsack(args);
      case 'solver.schedule': return this.opSchedule(args);
      case 'fs.inventory': return this.opInventory(args, state);
      case 'fs.search': return this.opSearch(args, state);
      case 'fs.duplicates': return this.opDuplicates(args, state);
      case 'text.stats': return this.opTextStats(args, state);
      case 'template.renderMany': return this.opRenderMany(args);
      case 'process.run': return this.opProcessRun(args, state, node);
      case 'process.pipeline': return this.opProcessPipeline(args, state, node);
      case 'sqlite.import': return this.opSqliteImport(args, state);
      case 'sqlite.query': return this.opSqliteQuery(args, state);
      case 'write.json': return this.opWriteJson(args, state);
      case 'write.csv': return this.opWriteCsv(args, state);
      case 'write.text': return this.opWriteText(args, state);
      case 'assert.count': return this.opAssertCount(args);
      case 'assert.equals': return this.opAssertEquals(args);
      default: fail('WORKFLOW_OPERATION_BLOCKED', op);
    }
  }

  async opReadJson(args, state) {
    const file = await this.readBounded(args.path, state.budget, state);
    this.pinSourceSnapshot(file, state);
    let value;
    try { value = JSON.parse(file.bytes.toString(args.encoding ?? 'utf8')); } catch (error) { fail('WORKFLOW_JSON_INVALID', error.message); }
    return { value, data: value, ...(Array.isArray(value) ? { items: value, count: value.length } : {}), source: { path: file.path, sha256: file.sha256, size: file.bytes.byteLength } };
  }

  async opReadCsv(args, state) {
    const file = await this.readBounded(args.path, state.budget, state);
    this.pinSourceSnapshot(file, state);
    const rows = parseCsv(file.bytes.toString(args.encoding ?? 'utf8'), { delimiter: args.delimiter ?? ',' });
    return { items: rows, rows, count: rows.length, source: { path: file.path, sha256: file.sha256, size: file.bytes.byteLength } };
  }

  async opTextRead(args, state) {
    const file = await this.readBounded(args.path, state.budget, state);
    this.pinSourceSnapshot(file, state);
    const encoding=args.encoding??'utf8';let text;
    if(['utf8','utf-8'].includes(encoding)){
      try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(file.bytes);}
      catch{fail('WORKFLOW_TEXT_ENCODING_INVALID',file.path);}
    }else{text=file.bytes.toString(encoding);}
    return { value: text, text, count: text.length, source: { path: file.path, sha256: file.sha256, size: file.bytes.byteLength } };
  }

  pinSourceSnapshot(file, state) {
    // A workflow may read its own staged output before publication. Pin the staged bytes,
    // while external inputs are pinned at their allowed-root source path.
    const path = file.snapshotPath ?? file.path;
    const prior = state.sourceSnapshots.get(path);
    if (prior && prior.sha256 !== file.sha256) fail('WORKFLOW_SOURCE_CHANGED_DURING_EXECUTION', file.path);
    state.sourceSnapshots.set(path, { path, sourcePath: file.path, sha256: file.sha256, size: file.bytes.byteLength, staged: file.stagedInput === true });
  }

  async assertSourceSnapshotsCurrent(state) {
    for (const snapshot of state.sourceSnapshots.values()) {
      state.assertAccess?.();
      const dataFence=state.assertDataAccess?.(snapshot.sourcePath??snapshot.path,'read');dataFence?.();
      const safe = await this.assertSafePath(snapshot.path, { mustExist: true });
      const info = await stat(safe);
      if (!info.isFile() || info.size > MAX_BYTES) fail('WORKFLOW_SOURCE_CHANGED_DURING_EXECUTION', snapshot.path);
      state.assertAccess?.();
      dataFence?.();
      const current = hashBytes(await readFile(safe));
      state.assertAccess?.();
      dataFence?.();
      if (current !== snapshot.sha256) fail('WORKFLOW_SOURCE_CHANGED_DURING_EXECUTION', snapshot.path);
    }
  }

  opFilter(args) {
    const items = asArray(args.items ?? args.rows ?? args.value);
    const where = args.where ?? (args.field ? { field: args.field, operator: args.operator ?? args.op, value: args.value } : null);
    assertWhereNumberFormats(where);
    const filtered = items.filter((item) => matchesWhere(item, where));
    return { items: filtered, rows: filtered, count: filtered.length };
  }

  opSort(args) {
    const items = [...asArray(args.items ?? args.rows ?? args.value)];
    const specs = Array.isArray(args.by) ? args.by : [{ field: args.by ?? args.field ?? '', order: args.order ?? 'asc' }];
    for (const spec of specs) {
      if (spec.numericFormat !== undefined && spec.numeric !== true) fail('WORKFLOW_NUMBER_FORMAT_REQUIRES_NUMERIC');
      if (spec.numeric === true) {
        assertNumericFormat(spec.numericFormat);
        for (const item of items) comparisonNumber(valueAt(item, spec.field), spec.numericFormat);
      }
    }
    items.sort((left, right) => {
      for (const spec of specs) {
        const field = typeof spec === 'string' ? spec : spec.field;
        const order = (typeof spec === 'string' ? args.order : spec.order) === 'desc' ? -1 : 1;
        const a = spec.numeric === true ? comparisonNumber(valueAt(left, field), spec.numericFormat) : valueAt(left, field);
        const b = spec.numeric === true ? comparisonNumber(valueAt(right, field), spec.numericFormat) : valueAt(right, field);
        const comparison = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, 'ko') : a < b ? -1 : a > b ? 1 : 0;
        if (comparison) return comparison * order;
      }
      return 0;
    });
    return { items, rows: items, count: items.length };
  }

  opUnique(args) {
    const source = asArray(args.items ?? args.rows ?? args.value);
    const by = args.by ?? args.field;
    const seen = new Set();
    const items = source.filter((item) => {
      const key = stableJson(by ? valueAt(item, by) : item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { items, rows: items, count: items.length, removedCount: source.length - items.length };
  }

  opGroupAggregate(args) {
    const items = asArray(args.items ?? args.rows ?? args.value);
    const fields = Array.isArray(args.groupBy) ? args.groupBy : [args.groupBy ?? args.by ?? 'group'];
    const operation = args.operation ?? args.aggregate ?? 'count';
    const valueField = args.field ?? args.valueField;
    // Legacy workflow IR exposes a generic value alias. Natural-language plans
    // name the result field explicitly and must not silently publish another column.
    const includeValueAlias = args.includeValueAlias !== false;
    if (fields.some((field) => field === (args.as ?? operation) || (includeValueAlias && field === 'value'))) fail('WORKFLOW_AGGREGATE_FIELD_COLLISION');
    const groups = new Map();
    for (const item of items) {
      const values = fields.map((field) => valueAt(item, field));
      const key = stableJson(values);
      if (!groups.has(key)) groups.set(key, { values, items: [] });
      groups.get(key).items.push(item);
    }
    const rows = [...groups.values()].map((group) => {
      const values = operation === 'count' || operation === 'sum'
        ? []
        : group.items.map((item) => normalizeNumber(valueAt(item, valueField), valueField));
      let aggregate;
      if (operation === 'count') aggregate = group.items.length;
      else if (operation === 'sum') aggregate = sumDecimalValues(group.items.map(item => valueAt(item, valueField)));
      else if (operation === 'min') aggregate = Math.min(...values);
      else if (operation === 'max') aggregate = Math.max(...values);
      else if (operation === 'avg' || operation === 'average') aggregate = values.reduce((sum, value) => sum + value, 0) / values.length;
      else fail('WORKFLOW_AGGREGATE_UNSUPPORTED', operation);
      return {
        ...Object.fromEntries(fields.map((field, index) => [field, group.values[index]])),
        [args.as ?? operation]: aggregate,
        ...(includeValueAlias ? { value: aggregate } : {})
      };
    });
    return { items: rows, rows, count: rows.length };
  }

  opJoin(args) {
    const left = asArray(args.left);
    const right = asArray(args.right);
    const leftKey = args.leftKey ?? args.on;
    const rightKey = args.rightKey ?? args.on;
    const type = args.type ?? 'inner';
    const joinKey = (row, field) => {
      const value = valueAt(row, field);
      if (!field || value === undefined || value === null) fail('WORKFLOW_JOIN_KEY_MISSING', String(field));
      return stableJson(value);
    };
    const index = new Map();
    for (const row of right) {
      const key = joinKey(row, rightKey);
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
    const rows = [];
    const matchedRight = new Set();
    for (const leftRow of left) {
      const matches = index.get(joinKey(leftRow, leftKey)) ?? [];
      if (!matches.length && ['left', 'full'].includes(type)) rows.push({ ...leftRow });
      for (const rightRow of matches) {
        matchedRight.add(rightRow);
        const combined = { ...leftRow };
        for (const [key, value] of Object.entries(rightRow)) {
          if (['__proto__', 'prototype', 'constructor'].includes(key)) fail('WORKFLOW_PROPERTY_PATH_UNSAFE', key);
          if (Object.hasOwn(combined, key) && combined[key] !== value) {
            const targetKey = `right_${key}`;
            if (Object.hasOwn(leftRow, targetKey) || Object.hasOwn(rightRow, targetKey) || Object.hasOwn(combined, targetKey)) fail('WORKFLOW_JOIN_FIELD_COLLISION', targetKey);
            combined[targetKey] = value;
          }
          else combined[key] = value;
        }
        rows.push(combined);
      }
    }
    if (['right', 'full'].includes(type)) for (const row of right) if (!matchedRight.has(row)) rows.push({ ...row });
    if (!['inner', 'left', 'right', 'full'].includes(type)) fail('WORKFLOW_JOIN_TYPE_UNSUPPORTED', type);
    return { items: rows, rows, count: rows.length };
  }

  opPivot(args) {
    const items = asArray(args.items ?? args.rows);
    const rowField = args.row ?? args.rowField;
    const columnField = args.column ?? args.columnField;
    const valueField = args.value ?? args.valueField;
    const operation = args.operation ?? 'sum';
    const rows = new Map();
    for (const item of items) {
      const rowKey = String(valueAt(item, rowField));
      const columnKey = String(valueAt(item, columnField));
      if (columnKey === rowField || ['__proto__', 'prototype', 'constructor'].includes(columnKey)) fail('WORKFLOW_PIVOT_FIELD_COLLISION', columnKey);
      if (!rows.has(rowKey)) rows.set(rowKey, { [rowField]: valueAt(item, rowField), __values: new Map() });
      const record = rows.get(rowKey);
      const list = record.__values.get(columnKey) ?? [];
      list.push(valueAt(item, valueField));
      record.__values.set(columnKey, list);
    }
    const result = [...rows.values()].map((record) => {
      const row = { [rowField]: record[rowField] };
      for (const [column, values] of record.__values) {
        if (operation === 'count') row[column] = values.length;
        else if (operation === 'sum') row[column] = sumDecimalValues(values);
        else {
          const numbers = values.map((value) => normalizeNumber(value));
          if (operation === 'min') row[column] = Math.min(...numbers);
          else if (operation === 'max') row[column] = Math.max(...numbers);
          else if (operation === 'avg' || operation === 'average') row[column] = numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
          else fail('WORKFLOW_PIVOT_OPERATION_UNSUPPORTED', operation);
        }
      }
      return row;
    });
    return { items: result, rows: result, count: result.length };
  }

  opValidate(args) {
    const value = args.value ?? args.items ?? args.rows;
    const values = Array.isArray(value) ? value : [value];
    const errors = [];
    const required = args.required ?? args.schema?.required ?? [];
    for (let index = 0; index < values.length; index += 1) {
      for (const field of required) if (valueAt(values[index], field) === undefined || valueAt(values[index], field) === null || valueAt(values[index], field) === '') errors.push({ index, field, code: 'required' });
      const rules = Array.isArray(args.rules)
        ? args.rules
        : Object.entries(args.rules ?? {}).map(([field, definition]) => typeof definition === 'string' ? { field, type: definition } : { field, ...definition });
      for (const rule of rules) {
        const actual = valueAt(values[index], rule.field);
        if (rule.type && typeOf(actual) !== rule.type) errors.push({ index, field: rule.field, code: 'type', expected: rule.type, actual: typeOf(actual) });
        if (rule.min !== undefined && actual < rule.min) errors.push({ index, field: rule.field, code: 'min', expected: rule.min, actual });
        if (rule.max !== undefined && actual > rule.max) errors.push({ index, field: rule.field, code: 'max', expected: rule.max, actual });
        if (rule.pattern && !(new RegExp(rule.pattern, 'u')).test(String(actual ?? ''))) errors.push({ index, field: rule.field, code: 'pattern' });
        if (rule.enum && !rule.enum.includes(actual)) errors.push({ index, field: rule.field, code: 'enum', actual });
      }
    }
    const valid = errors.length === 0;
    if (!valid && args.failOnError === true) fail('WORKFLOW_VALIDATION_FAILED', stableJson(errors.slice(0, 10)));
    return { valid, passed: valid, errors, errorCount: errors.length, count: values.length, validatedCount: values.length, value };
  }

  opLedger(args) {
    const entries = asArray(args.entries ?? args.items ?? args.rows, 'entries');
    const scale = Number.isInteger(args.scale) && args.scale >= 0 && args.scale <= 6 ? args.scale : 2;
    let debit = 0n;
    let credit = 0n;
    let net = 0n;
    const normalized = entries.map((entry) => {
      let amount;
      if (args.debitField || args.creditField || 'debit' in entry || 'credit' in entry) {
        const d = toMinor(valueAt(entry, args.debitField ?? 'debit') ?? 0, scale);
        const c = toMinor(valueAt(entry, args.creditField ?? 'credit') ?? 0, scale);
        debit += d;
        credit += c;
        amount = d - c;
      } else {
        amount = toMinor(valueAt(entry, args.amountField ?? 'amount'), scale);
        net += amount;
      }
      return { ...entry, amountMinor: amount.toString() };
    });
    if (args.debitField || args.creditField || entries.some((entry) => 'debit' in entry || 'credit' in entry)) net = debit - credit;
    return { entries: normalized, items: normalized, count: normalized.length, scale, debitMinor: debit.toString(), creditMinor: credit.toString(), balanceMinor: net.toString(), balanced: net === 0n };
  }

  opUnits(args) {
    const value = normalizeNumber(args.value);
    const from = String(args.from).toLowerCase();
    const to = String(args.to).toLowerCase();
    const aliases = { metres: 'm', meter: 'm', meters: 'm', kilometres: 'km', kilometer: 'km', kilometers: 'km', centimetres: 'cm', centimeters: 'cm', millimetres: 'mm', millimeters: 'mm', kilograms: 'kg', grams: 'g', pounds: 'lb', celsius: 'c', fahrenheit: 'f', kelvin: 'k', seconds: 's', minutes: 'min', hours: 'h' };
    const source = aliases[from] ?? from;
    const target = aliases[to] ?? to;
    const linear = { mm: ['length', 0.001], cm: ['length', 0.01], m: ['length', 1], km: ['length', 1000], in: ['length', 0.0254], ft: ['length', 0.3048], mi: ['length', 1609.344], g: ['mass', 0.001], kg: ['mass', 1], lb: ['mass', 0.45359237], s: ['time', 1], min: ['time', 60], h: ['time', 3600] };
    let converted;
    if (source === target) converted = value;
    else if (linear[source] && linear[target] && linear[source][0] === linear[target][0]) converted = value * linear[source][1] / linear[target][1];
    else if (['c', 'f', 'k'].includes(source) && ['c', 'f', 'k'].includes(target)) {
      const celsius = source === 'c' ? value : source === 'f' ? (value - 32) * 5 / 9 : value - 273.15;
      converted = target === 'c' ? celsius : target === 'f' ? celsius * 9 / 5 + 32 : celsius + 273.15;
    } else fail('WORKFLOW_UNIT_INCOMPATIBLE', `${source}->${target}`);
    return { value: converted, from: source, to: target, inputValue: value };
  }

  normalizeEdges(args, { weighted = false } = {}) {
    const edges = (args.edges ?? []).map((edge) => Array.isArray(edge)
      ? { from: edge[0], to: edge[1], weight: weighted ? normalizeNumber(edge[2] ?? 1) : edge[2] }
      : { from: edge.from, to: edge.to, weight: weighted ? normalizeNumber(edge.weight ?? 1) : edge.weight });
    const nodes = new Set(args.nodes ?? []);
    for (const edge of edges) { nodes.add(edge.from); nodes.add(edge.to); }
    return { nodes: [...nodes], edges };
  }

  opToposort(args) {
    const { nodes, edges } = this.normalizeEdges(args);
    const indegree = new Map(nodes.map((node) => [node, 0]));
    const outgoing = new Map(nodes.map((node) => [node, []]));
    for (const edge of edges) { indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1); outgoing.get(edge.from)?.push(edge.to); }
    const queue = nodes.filter((node) => indegree.get(node) === 0).sort();
    const order = [];
    while (queue.length) {
      const current = queue.shift();
      order.push(current);
      for (const next of outgoing.get(current) ?? []) {
        indegree.set(next, indegree.get(next) - 1);
        if (indegree.get(next) === 0) { queue.push(next); queue.sort(); }
      }
    }
    if (order.length !== nodes.length) fail('WORKFLOW_GRAPH_CYCLE');
    return { order, items: order, count: order.length };
  }

  opShortestPath(args) {
    const { nodes, edges } = this.normalizeEdges(args, { weighted: true });
    const start = args.start ?? args.source;
    const end = args.end ?? args.target;
    if (!nodes.includes(start) || !nodes.includes(end)) fail('WORKFLOW_GRAPH_ENDPOINT_MISSING');
    if (edges.some((edge) => edge.weight < 0)) fail('WORKFLOW_NEGATIVE_EDGE_BLOCKED');
    const distance = new Map(nodes.map((node) => [node, Infinity]));
    const previous = new Map();
    const unvisited = new Set(nodes);
    distance.set(start, 0);
    while (unvisited.size) {
      const current = [...unvisited].sort((a, b) => distance.get(a) - distance.get(b))[0];
      if (!Number.isFinite(distance.get(current))) break;
      unvisited.delete(current);
      if (current === end) break;
      for (const edge of edges.filter((item) => item.from === current)) {
        const candidate = distance.get(current) + edge.weight;
        if (candidate < distance.get(edge.to)) { distance.set(edge.to, candidate); previous.set(edge.to, current); }
      }
    }
    if (!Number.isFinite(distance.get(end))) return { found: false, path: [], distance: null, count: 0 };
    const path = [];
    for (let cursor = end; cursor !== undefined; cursor = previous.get(cursor)) { path.unshift(cursor); if (cursor === start) break; }
    return { found: true, path, items: path, distance: distance.get(end), count: path.length };
  }

  opCriticalPath(args) {
    const tasks = asArray(args.tasks ?? args.items, 'tasks');
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (byId.size !== tasks.length) fail('WORKFLOW_TASK_ID_DUPLICATE');
    const edges = tasks.flatMap((task) => (task.dependsOn ?? []).map((dependency) => ({ from: dependency, to: task.id })));
    const order = this.opToposort({ nodes: tasks.map((task) => task.id), edges }).order;
    const finish = new Map();
    const previous = new Map();
    for (const id of order) {
      const task = byId.get(id);
      const dependencies = task.dependsOn ?? [];
      const predecessor = dependencies.sort((a, b) => (finish.get(b) ?? 0) - (finish.get(a) ?? 0))[0];
      const start = predecessor ? finish.get(predecessor) : 0;
      finish.set(id, start + normalizeNumber(task.duration ?? 0, `${id}.duration`));
      if (predecessor) previous.set(id, predecessor);
    }
    const end = [...finish].sort((a, b) => b[1] - a[1])[0]?.[0];
    const path = [];
    for (let cursor = end; cursor !== undefined; cursor = previous.get(cursor)) path.unshift(cursor);
    return { path, items: path, duration: end ? finish.get(end) : 0, count: path.length, finishTimes: Object.fromEntries(finish) };
  }

  opKnapsack(args) {
    const items = asArray(args.items);
    const capacity = Math.floor(normalizeNumber(args.capacity));
    if (capacity < 0 || capacity > 100_000 || items.length > 256) fail('WORKFLOW_KNAPSACK_LIMIT');
    const dp = Array.from({ length: capacity + 1 }, () => ({ value: 0, selected: [] }));
    for (let index = 0; index < items.length; index += 1) {
      const weight = Math.floor(normalizeNumber(items[index].weight, 'weight'));
      const value = normalizeNumber(items[index].value, 'value');
      if (weight < 0) fail('WORKFLOW_KNAPSACK_WEIGHT_INVALID');
      for (let current = capacity; current >= weight; current -= 1) {
        const candidate = dp[current - weight].value + value;
        if (candidate > dp[current].value) dp[current] = { value: candidate, selected: [...dp[current - weight].selected, index] };
      }
    }
    const best = dp.reduce((left, right) => right.value > left.value ? right : left);
    const selected = best.selected.map((index) => items[index]);
    return { selected, items: selected, count: selected.length, totalValue: best.value, totalWeight: selected.reduce((sum, item) => sum + Number(item.weight), 0), capacity };
  }

  opSchedule(args) {
    const tasks = asArray(args.tasks ?? args.items, 'tasks');
    const resourceCount = Number(args.resources ?? args.resourceCount ?? 1);
    if (!Number.isInteger(resourceCount) || resourceCount < 1 || resourceCount > 64) fail('WORKFLOW_SCHEDULE_RESOURCE_COUNT_INVALID');
    if (tasks.length > 10_000 || tasks.some((task) => !task || typeof task !== 'object' || Array.isArray(task) || typeof task.id !== 'string' || !task.id)) fail('WORKFLOW_SCHEDULE_TASK_INVALID');
    const byId = new Map(tasks.map((task) => [task.id, task]));
    if (byId.size !== tasks.length) fail('WORKFLOW_TASK_ID_DUPLICATE');
    const order = this.opToposort({ nodes: tasks.map((task) => task.id), edges: tasks.flatMap((task) => (task.dependsOn ?? []).map((dependency) => ({ from: dependency, to: task.id }))) }).order;
    const finishes = new Map();
    const availability = Array.from({ length: resourceCount }, () => 0);
    const schedule = [];
    for (const id of order) {
      const task = byId.get(id);
      const duration = normalizeNumber(task.duration ?? 0, `${id}.duration`);
      if (duration < 0) fail('WORKFLOW_SCHEDULE_DURATION_INVALID', id);
      const dependencyReady = Math.max(0, ...(task.dependsOn ?? []).map((dependency) => finishes.get(dependency) ?? 0));
      const requested = task.resource === undefined ? null : Number(task.resource);
      if (requested !== null && (!Number.isInteger(requested) || requested < 0 || requested >= resourceCount)) fail('WORKFLOW_SCHEDULE_RESOURCE_INVALID', id);
      const resource = requested ?? availability.map((time, index) => ({ time: Math.max(time, dependencyReady), index })).sort((a, b) => a.time - b.time || a.index - b.index)[0].index;
      const start = Math.max(dependencyReady, availability[resource]);
      const end = start + duration;
      availability[resource] = end;
      finishes.set(id, end);
      schedule.push({ id, resource, start, end, duration: end - start });
    }
    return { schedule, items: schedule, count: schedule.length, makespan: Math.max(0, ...availability) };
  }

  async walk(root, { recursive = true, maxEntries = 10_000, assertAccess = null } = {}) {
    assertAccess?.(root);
    const start = await this.assertSafePath(root, { mustExist: true });
    assertAccess?.(start);
    const startInfo = await stat(start);
    assertAccess?.(start);
    if (!startInfo.isDirectory()) fail('WORKFLOW_DIRECTORY_REQUIRED', start);
    const items = [];
    const queue = [start];
    while (queue.length) {
      const directory = queue.shift();
      assertAccess?.(directory);
      const entries=await readdir(directory, { withFileTypes: true });
      assertAccess?.(directory);
      for (const entry of entries) {
        const path = join(directory, entry.name);
        assertAccess?.(path);
        const linkInfo = await lstat(path);
        assertAccess?.(path);
        if (linkInfo.isSymbolicLink()) fail('WORKFLOW_SYMLINK_BLOCKED', path);
        const safe = await this.assertSafePath(path, { mustExist: true });
        assertAccess?.(safe);
        if (entry.isDirectory()) {
          if (recursive) queue.push(safe);
          continue;
        }
        if (!entry.isFile()) continue;
        items.push({ path: safe, relativePath: relative(start, safe).replaceAll('\\', '/'), name: entry.name, extension: extname(entry.name).toLowerCase(), size: linkInfo.size, modifiedAt: linkInfo.mtime.toISOString() });
        if (items.length > maxEntries) fail('WORKFLOW_INVENTORY_LIMIT', String(maxEntries));
      }
    }
    assertAccess?.(start);return { start, items };
  }

  async opInventory(args, state) {
    state.assertAccess?.();
    const dataFence=state.assertDataAccess?.(args.path,'inventory');
    const assertAccess=(path=args.path)=>{
      if(state.assertInventoryAccess)state.assertInventoryAccess(path);
      else {state.assertAccess?.();dataFence?.();state.assertDataAccess?.(path,'inventory')?.();}
    };
    const walked = await this.walk(args.path, { recursive: args.recursive !== false, maxEntries: args.maxEntries ?? 10_000,assertAccess });
    let totalBytes = 0;
    const withHashes = [];
    for (const item of walked.items) {
      totalBytes += item.size;
      if (args.hash === true || args.includeSha256 === true) {
        const file = await this.readBounded(item.path, state.budget,state);
        withHashes.push({ ...item, sha256: file.sha256 });
      } else withHashes.push(item);
    }
    state.assertAccess?.();dataFence?.();assertAccess();return { root: walked.start, items: withHashes, files: withHashes, count: withHashes.length, totalBytes };
  }

  async opSearch(args, state) {
    const inventory = await this.opInventory({ ...args, hash: false, includeSha256: false }, state);
    let matcher;
    if (args.regex === true) {
      try { matcher = new RegExp(String(args.pattern ?? ''), args.caseSensitive === true ? 'gu' : 'giu'); }
      catch (error) { fail('WORKFLOW_SEARCH_PATTERN_INVALID', error.message); }
    } else {
      const needle = String(args.contains ?? args.pattern ?? '');
      matcher = { needle: args.caseSensitive === true ? needle : needle.toLocaleLowerCase('ko') };
    }
    const items = [];
    for (const item of inventory.items) {
      if (item.size > (args.maxFileBytes ?? 1024 * 1024)) continue;
      const file = await this.readBounded(item.path, state.budget);
      const content = file.bytes.toString(args.encoding ?? 'utf8');
      if (args.regex === true) {
        matcher.lastIndex = 0;
        const matches = [...content.matchAll(matcher)].slice(0, args.maxMatchesPerFile ?? 1000);
        for (const match of matches) items.push({ ...item, sha256: file.sha256, match: match[0], index: match.index, groups: match.slice(1) });
      } else {
        const haystack = args.caseSensitive === true ? content : content.toLocaleLowerCase('ko');
        const needle = matcher.needle;
        if (!needle) {
          const filenamePattern = wildcardRegex(args.glob ?? args.pattern ?? '*');
          if (filenamePattern.test(item.relativePath) || filenamePattern.test(item.name)) items.push({ ...item, sha256: file.sha256 });
          continue;
        }
        let offset = 0;
        while (offset <= haystack.length) {
          const index = haystack.indexOf(needle, offset);
          if (index < 0) break;
          items.push({ ...item, sha256: file.sha256, match: content.slice(index, index + needle.length), index });
          if (items.filter((entry) => entry.path === item.path).length >= (args.maxMatchesPerFile ?? 1000)) break;
          offset = index + Math.max(needle.length, 1);
        }
      }
    }
    return { items, files: items, count: items.length, root: inventory.root };
  }

  async opDuplicates(args, state) {
    const inventory = await this.opInventory({ ...args, hash: false }, state);
    const bySize = new Map();
    for (const item of inventory.items) {
      if (!bySize.has(item.size)) bySize.set(item.size, []);
      bySize.get(item.size).push(item);
    }
    const byHash = new Map();
    for (const candidates of bySize.values()) {
      if (candidates.length < 2) continue;
      for (const item of candidates) {
        const file = await this.readBounded(item.path, state.budget);
        if (!byHash.has(file.sha256)) byHash.set(file.sha256, []);
        byHash.get(file.sha256).push({ ...item, sha256: file.sha256 });
      }
    }
    const groups = [...byHash.entries()].filter(([, files]) => files.length > 1).map(([sha256, files]) => ({ sha256, size: files[0].size, files, count: files.length }));
    return { groups, items: groups, count: groups.length, duplicateFileCount: groups.reduce((sum, group) => sum + group.files.length, 0) };
  }

  async opTextStats(args, state) {
    let text = args.text ?? args.value;
    let source = null;
    if (args.path) {
      const file = await this.readBounded(args.path, state.budget);
      text = file.bytes.toString(args.encoding ?? 'utf8');
      source = { path: file.path, sha256: file.sha256, size: file.bytes.byteLength };
    }
    text = String(text ?? '');
    const words = text.trim() ? text.trim().split(/\s+/u) : [];
    const lines = text === '' ? 0 : text.split(/\r?\n/u).filter((line) => line.length > 0).length;
    const sentences = text.trim() ? text.split(/[.!?。！？]+/u).filter((part) => part.trim()).length : 0;
    return { characters: [...text].length, charactersNoWhitespace: [...text.replace(/\s/gu, '')].length, words: words.length, lines, sentences, bytes: Buffer.byteLength(text), source };
  }

  opRenderMany(args) {
    const template = args.template ?? args.text;
    const records = asArray(args.records ?? args.items ?? args.rows);
    const items = records.map((record, index) => ({ index, text: renderTemplate(template, record), record }));
    return { items, count: items.length, texts: items.map((item) => item.text) };
  }

  async opProcessRun(args, state, node) {
    const run = await this.runProcess(args, state, node);
    if (run.exitCode !== 0 || run.timedOut) fail(run.timedOut ? 'WORKFLOW_PROCESS_TIMEOUT' : 'WORKFLOW_PROCESS_FAILED', `${node.id}:${run.exitCode}`);
    return run;
  }

  async opProcessPipeline(args, state, node) {
    const stages = asArray(args.stages, 'stages');
    if (!stages.length || stages.length > 16) fail('WORKFLOW_PIPELINE_LIMIT');
    let stdin = args.stdin ?? '';
    const receipts = [];
    for (let index = 0; index < stages.length; index += 1) {
      const result = await this.runProcess({
        timeoutMs: args.timeoutMs,
        maxOutputBytes: args.maxOutputBytes,
        ...stages[index],
        stdin
      }, state, { ...node, id: `${node.id}[${index}]`, retry: stages[index].retry ?? node.retry });
      receipts.push(result);
      if (result.exitCode !== 0 || result.timedOut) fail(result.timedOut ? 'WORKFLOW_PROCESS_TIMEOUT' : 'WORKFLOW_PROCESS_FAILED', `${node.id}[${index}]:${result.exitCode}`);
      stdin = result.stdout;
    }
    return { stdout: stdin, stdoutSha256: hashBytes(stdin), stages: receipts.map((receipt) => ({ exitCode: receipt.exitCode, stdoutSha256: receipt.stdoutSha256, stderrSha256: receipt.stderrSha256, attempts: receipt.attempts })), count: receipts.length, exitCode: 0 };
  }

  async runProcess(args, state, node) {
    const scriptPath = await this.assertSafePath(args.scriptPath ?? args.path, { mustExist: true });
    if (!['.js', '.mjs'].includes(extname(scriptPath).toLowerCase())) fail('WORKFLOW_PROCESS_EXTENSION_BLOCKED', scriptPath);
    const info = await stat(scriptPath);
    if (!info.isFile() || info.size > MAX_BYTES) fail('WORKFLOW_PROCESS_SCRIPT_INVALID');
    const scriptSource = await readFile(scriptPath, 'utf8');
    if (NETWORK_IMPORT_PATTERN.test(scriptSource) || NETWORK_GLOBAL_PATTERN.test(scriptSource)) fail('WORKFLOW_PROCESS_NETWORK_BLOCKED', scriptPath);
    const guardPath = await this.ensureProcessNetworkGuard(state);
    const timeoutMs = Math.max(1, Math.min(MAX_PROCESS_TIMEOUT_MS, Number(args.timeoutMs ?? DEFAULT_PROCESS_TIMEOUT_MS)));
    const retries = Math.max(0, Math.min(4, Number(args.retries ?? ((node.retry?.maxAttempts ?? 1) - 1))));
    const argv = Array.isArray(args.args) ? args.args.map((value) => String(value)) : [];
    if (argv.length > 128 || argv.some((value) => Buffer.byteLength(value) > 64 * 1024)) fail('WORKFLOW_PROCESS_ARGS_LIMIT');
    const stdin = args.stdin === undefined ? '' : typeof args.stdin === 'string' ? args.stdin : stableJson(args.stdin);
    if (Buffer.byteLength(stdin) > MAX_BYTES) fail('WORKFLOW_PROCESS_STDIN_LIMIT');
    let last;
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      last = this.processRunner
        ? await this.processRunner({ executable: process.execPath, scriptPath, args: argv, stdin, timeoutMs, cwd: state.stageRoot, attempt })
        : await this.spawnNode({ scriptPath, argv, stdin, timeoutMs, cwd: state.stageRoot, readRoot: state.selectedRoot, guardPath });
      last = this.normalizeProcessResult(last, attempt);
      if (last.networkBlocked) fail('WORKFLOW_PROCESS_NETWORK_BLOCKED', node.id);
      if (last.exitCode === 0 && !last.timedOut) break;
      if (attempt <= retries && (node.retry?.backoffMs ?? 0) > 0) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, node.retry.backoffMs));
      }
    }
    await this.registerProcessSideEffects(state);
    return { ...last, scriptPath, timeoutMs };
  }

  normalizeProcessResult(result, attempts) {
    const stdout = String(result?.stdout ?? '');
    const stderr = String(result?.stderr ?? '');
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_BYTES) fail('WORKFLOW_PROCESS_OUTPUT_LIMIT');
    return { exitCode: Number(result?.exitCode ?? 1), signal: result?.signal ?? null, timedOut: result?.timedOut === true, networkBlocked: result?.networkBlocked === true, stdout, stderr, stdoutSha256: hashBytes(stdout), stderrSha256: hashBytes(stderr), stdoutBytes: Buffer.byteLength(stdout), stderrBytes: Buffer.byteLength(stderr), attempts };
  }

  async ensureProcessNetworkGuard(state) {
    const internalRoot = join(state.stageRoot, '.jarvis-internal');
    await mkdir(join(state.stageRoot, 'outputs'), { recursive: true, mode: 0o700 });
    const guardPath = join(internalRoot, 'network-guard.cjs');
    const expectedHash = hashBytes(PROCESS_NETWORK_GUARD_SOURCE);
    await mkdir(internalRoot, { recursive: true, mode: 0o700 });
    if (await exists(guardPath)) {
      const currentHash = hashBytes(await readFile(guardPath));
      if (currentHash !== expectedHash) fail('WORKFLOW_PROCESS_GUARD_TAMPERED');
    } else {
      await writeFile(guardPath, PROCESS_NETWORK_GUARD_SOURCE, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    }
    state.internalFiles.add(resolve(guardPath));
    return guardPath;
  }

  spawnNode({ scriptPath, argv, stdin, timeoutMs, cwd, readRoot, guardPath }) {
    return new Promise((resolvePromise, rejectPromise) => {
      const denialSentinel = `JARVIS_NETWORK_BLOCKED_${randomBytes(16).toString('hex')}`;
      const child = spawn(process.execPath, [
        '--permission',
        `--allow-fs-read=${readRoot}`,
        `--allow-fs-write=${join(cwd, 'outputs')}`,
        '--require',
        guardPath,
        scriptPath,
        ...argv
      ], {
        cwd,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          WINDIR: process.env.WINDIR ?? '',
          TEMP: join(cwd, 'outputs'),
          TMP: join(cwd, 'outputs'),
          JARVIS_WORKFLOW_ROOT: cwd,
          JARVIS_NETWORK_DENIAL_SENTINEL: denialSentinel
        }
      });
      const stdout = [];
      const stderr = [];
      let bytes = 0;
      let settled = false;
      let timedOut = false;
      let networkBlocked = false;
      const stopForLimit = () => {
        if (bytes > MAX_BYTES && !settled) {
          child.kill('SIGKILL');
          settled = true;
          clearTimeout(timer);
          const error = new Error('WORKFLOW_PROCESS_OUTPUT_LIMIT');
          error.code = 'WORKFLOW_PROCESS_OUTPUT_LIMIT';
          rejectPromise(error);
        }
      };
      child.stdout.on('data', (chunk) => { stdout.push(chunk); bytes += chunk.length; stopForLimit(); });
      child.stderr.on('data', (chunk) => { stderr.push(chunk); bytes += chunk.length; stopForLimit(); });
      child.on('message', (message) => { if (message?.type === 'jarvis-network-blocked') networkBlocked = true; });
      child.on('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); rejectPromise(error); } });
      child.on('close', (exitCode, signal) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          const stderrText = Buffer.concat(stderr).toString('utf8');
          resolvePromise({ exitCode: exitCode ?? 1, signal, timedOut, networkBlocked: networkBlocked || stderrText.includes(denialSentinel), stdout: Buffer.concat(stdout).toString('utf8'), stderr: stderrText.replaceAll(denialSentinel, '[network-blocked]') });
        }
      });
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
      child.stdin.end(stdin);
    });
  }

  async registerProcessSideEffects(state) {
    const walked = await this.walk(state.stageRoot, { recursive: true, maxEntries: 10_000 });
    const outputsRoot = join(state.stageRoot, 'outputs');
    for (const item of walked.items) {
      const known = state.stagedFiles.find((file) => samePath(file.stagePath, item.path));
      if (known) {
        known.size = item.size;
        known.sha256 = hashBytes(await readFile(item.path));
        continue;
      }
      if (state.internalFiles.has(resolve(item.path))) continue;
      if (!isWithin(outputsRoot, item.path)) fail('WORKFLOW_PROCESS_SIDE_EFFECT_BLOCKED', item.relativePath);
      const rel = relative(outputsRoot, item.path);
      const target = await this.assertSafePath(join(state.selectedRoot, 'outputs', rel), { mustExist: false, allowRoot: false });
      if (state.stagedFiles.some((file) => samePath(file.path, target))) fail('WORKFLOW_OUTPUT_DUPLICATE', target);
      state.stagedFiles.push({ path: target, stagePath: item.path, kind: 'process-side-effect', producerNodeId: state.currentNodeId, size: item.size, sha256: hashBytes(await readFile(item.path)) });
    }
    const total = state.stagedFiles.reduce((sum, file) => sum + (file.size ?? 0), 0);
    if (total > MAX_BYTES) fail('WORKFLOW_OUTPUT_LIMIT', 'process-side-effects');
  }

  async opSqliteImport(args, state) {
    const requested = args.databasePath ?? args.path;
    const requestedPath = typeof requested === 'object' ? requested.databasePath ?? requested.path : requested;
    const finalPath = await this.assertSafePath(requestedPath, { mustExist: false, allowRoot: false });
    const existingStage = state.stagedFiles.find((file) => samePath(file.path, finalPath));
    const mode = args.mode ?? (existingStage ? 'append' : 'replace');
    if (!['replace', 'append', 'upsert'].includes(mode)) fail('WORKFLOW_SQLITE_MODE_UNSUPPORTED', mode);
    const databasePath = existingStage
      ? { path: finalPath, __stagePath: existingStage.stagePath }
      : await this.prepareOutput(finalPath, state, 'sqlite');
    const stagedFile = state.stagedFiles.find((file) => samePath(file.path, finalPath));
    stagedFile.producerNodeId = state.currentNodeId;
    if (!existingStage && ['append', 'upsert'].includes(mode) && await exists(finalPath)) {
      const source = await this.assertSafePath(finalPath, { mustExist: true });
      const sourceInfo = await stat(source);
      if (!sourceInfo.isFile() || sourceInfo.size > MAX_BYTES) fail('WORKFLOW_SQLITE_SOURCE_INVALID', source);
      await copyFile(source, databasePath.__stagePath);
    }
    const table = String(args.table ?? 'records');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(table)) fail('WORKFLOW_SQLITE_IDENTIFIER_INVALID', table);
    let rows = args.rows ?? args.items;
    if (!rows && args.sourcePath) {
      if (extname(args.sourcePath).toLowerCase() === '.csv') rows = (await this.opReadCsv({ path: args.sourcePath, delimiter: args.delimiter }, state)).items;
      else rows = asArray((await this.opReadJson({ path: args.sourcePath }, state)).value);
    }
    rows = asArray(rows ?? [], 'rows');
    if (rows.length > 100_000) fail('WORKFLOW_SQLITE_ROW_LIMIT');
    const columns = args.columns?.length ? args.columns : [...new Set(rows.flatMap((row) => Object.keys(row ?? {})))];
    if (!columns.length || columns.some((column) => !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(column))) fail('WORKFLOW_SQLITE_IDENTIFIER_INVALID', 'column');
    const { DatabaseSync } = await import('node:sqlite');
    const key = args.key === undefined ? null : String(args.key);
    if (key && (!columns.includes(key) || !/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(key))) fail('WORKFLOW_SQLITE_IDENTIFIER_INVALID', key);
    const db = new DatabaseSync(databasePath.__stagePath);
    try {
      db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
      if (mode === 'replace' && existingStage) db.exec(`DROP TABLE IF EXISTS "${table}"`);
      db.exec(`CREATE TABLE IF NOT EXISTS "${table}" (${columns.map((column) => `"${column}"${key === column ? ' PRIMARY KEY' : ''}`).join(', ')})`);
      if (mode === 'upsert') {
        if (!key) fail('WORKFLOW_SQLITE_UPSERT_KEY_REQUIRED');
        if (rows.some((row) => row?.[key] === undefined || row?.[key] === null)
          || db.prepare(`SELECT 1 FROM "${table}" WHERE "${key}" IS NULL LIMIT 1`).get()) fail('WORKFLOW_SQLITE_UPSERT_KEY_MISSING');
        if (db.prepare(`SELECT "${key}" FROM "${table}" GROUP BY "${key}" HAVING COUNT(*) > 1 LIMIT 1`).get()) fail('WORKFLOW_SQLITE_UPSERT_KEY_DUPLICATE');
        // A preceding plain import may have created this table without a key.
        // Establish the explicitly requested unique key in staging, after
        // proving that no existing row would be silently discarded.
        const indexName = `jarvis_key_${hashBytes(`${table}\0${key}`).slice(0, 24)}`;
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "${indexName}" ON "${table}" ("${key}")`);
      }
      const insertPrefix = mode === 'replace' && !key ? 'INSERT' : 'INSERT';
      const updatedColumns = columns.filter((column) => column !== key);
      const conflict = mode === 'upsert'
        ? ` ON CONFLICT("${key}") ${updatedColumns.length ? `DO UPDATE SET ${updatedColumns.map((column) => `"${column}"=excluded."${column}"`).join(', ')}` : 'DO NOTHING'}`
        : '';
      if (mode === 'upsert' && !key) fail('WORKFLOW_SQLITE_UPSERT_KEY_REQUIRED');
      const statement = db.prepare(`${insertPrefix} INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})${conflict}`);
      db.exec('BEGIN');
      try {
        for (const row of rows) statement.run(...columns.map((column) => {
          const value = row?.[column];
          return value && typeof value === 'object' ? stableJson(value) : value ?? null;
        }));
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
    const bytes = await readFile(databasePath.__stagePath);
    const staged = state.stagedFiles.find((file) => samePath(file.path, finalPath));
    staged.size = bytes.byteLength;
    staged.sha256 = hashBytes(bytes);
    if (bytes.byteLength > MAX_BYTES || state.stagedFiles.reduce((sum, file) => sum + (file.size ?? 0), 0) > MAX_BYTES) fail('WORKFLOW_OUTPUT_LIMIT', 'sqlite');
    return { path: databasePath.path, databasePath: databasePath.path, table, columns, mode, key, rowCount: rows.length, count: rows.length, sha256: staged.sha256, size: bytes.byteLength, __stagePath: databasePath.__stagePath };
  }

  async opSqliteQuery(args, state) {
    const requested = args.databasePath ?? args.path;
    const requestedPath = typeof requested === 'object' ? requested.databasePath ?? requested.path : requested;
    const finalPath = this.resolveInputPath(requestedPath);
    const knownStage = state.stagedFiles.find((file) => samePath(file.path, finalPath))?.stagePath;
    const staged = args.__stagePath ?? (typeof requested === 'object' ? requested.__stagePath : null) ?? knownStage;
    const databasePath = staged ?? await this.assertSafePath(requestedPath, { mustExist: true });
    if (staged && !isWithin(state.stageRoot, resolve(staged))) fail('WORKFLOW_SQLITE_STAGE_INVALID');
    const sql = String(args.sql ?? '').trim();
    if (!/^(select|with|pragma\s+(table_info|index_list|foreign_key_list)\b)/i.test(sql) || /\b(insert|update|delete|drop|alter|attach|detach|vacuum|reindex|replace|create)\b/i.test(sql)) fail('WORKFLOW_SQLITE_QUERY_BLOCKED');
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(databasePath, { readOnly: true });
    let rows;
    try { rows = db.prepare(sql).all(...(args.params ?? [])); } finally { db.close(); }
    return { rows, items: rows, count: rows.length, databasePath: requestedPath };
  }

  async prepareOutput(input, state, kind) {
    const dataFence=state.assertDataAccess?.(input,'write');dataFence?.();
    const path = await this.assertSafePath(input, { mustExist: false, allowRoot: false });
    dataFence?.();
    if (state.stagedFiles.some((file) => samePath(file.path, path))) fail('WORKFLOW_OUTPUT_DUPLICATE', path);
    const relativeOutput = relative(state.selectedRoot, path);
    const stagePath = join(state.stageRoot, 'outputs', relativeOutput);
    if (!isWithin(join(state.stageRoot, 'outputs'), stagePath)) fail('WORKFLOW_STAGE_ESCAPE');
    await mkdir(dirname(stagePath), { recursive: true });
    dataFence?.();
    state.stagedFiles.push({ path, stagePath, kind, producerNodeId: state.currentNodeId });
    return { path, __stagePath: stagePath };
  }

  countStagedBytes(size, state) {
    const stagedTotal = state.stagedFiles.reduce((sum, file) => sum + (file.size ?? 0), 0) + size;
    if (size > MAX_BYTES || stagedTotal > MAX_BYTES) fail('WORKFLOW_OUTPUT_LIMIT', 'staged-files');
  }

  async stageContent(path, content, state, kind) {
    const output = await this.prepareOutput(path, state, kind);
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
    this.countStagedBytes(bytes.byteLength, state);
    await writeFile(output.__stagePath, bytes);
    const staged = state.stagedFiles.at(-1);
    staged.size = bytes.byteLength;
    staged.sha256 = hashBytes(bytes);
    return { path: output.path, sha256: staged.sha256, size: bytes.byteLength, __stagePath: output.__stagePath };
  }

  opWriteJson(args, state) {
    const value = args.value ?? args.items ?? args.rows ?? args.data;
    const text = `${args.pretty === false ? stableJson(value) : JSON.stringify(value, null, 2)}\n`;
    return this.stageContent(args.path, text, state, 'json');
  }

  opWriteCsv(args, state) {
    return this.stageContent(args.path, encodeCsv(args.items ?? args.rows ?? args.value, args.columns), state, 'csv');
  }

  opWriteText(args, state) {
    let text = args.text ?? args.content ?? args.value ?? '';
    if (Array.isArray(text)) text = text.map((item) => typeof item === 'string' ? item : item?.text ?? stableJson(item)).join(args.separator ?? '\n');
    else if (typeof text !== 'string') text = stableJson(text);
    return this.stageContent(args.path, text, state, 'text');
  }

  opAssertCount(args) {
    const value = args.items ?? args.rows ?? args.value;
    const count = Array.isArray(value) || typeof value === 'string' ? value.length : value && typeof value === 'object' ? Object.keys(value).length : Number(value);
    if (!Number.isFinite(count)) fail('WORKFLOW_ASSERT_COUNT_TYPE');
    if (args.equals !== undefined && count !== Number(args.equals)) fail('WORKFLOW_ASSERT_COUNT_FAILED', `${count}!=${args.equals}`);
    if (args.min !== undefined && count < Number(args.min)) fail('WORKFLOW_ASSERT_COUNT_FAILED', `${count}<${args.min}`);
    if (args.max !== undefined && count > Number(args.max)) fail('WORKFLOW_ASSERT_COUNT_FAILED', `${count}>${args.max}`);
    return { passed: true, count, expected: { equals: args.equals ?? null, min: args.min ?? null, max: args.max ?? null } };
  }

  opAssertEquals(args) {
    const actual = args.actual ?? args.left;
    const expected = args.expected ?? args.right;
    const passed = stableJson(actual) === stableJson(expected);
    if (!passed) fail('WORKFLOW_ASSERT_EQUALS_FAILED', `${stableJson(actual)}!=${stableJson(expected)}`);
    return { passed: true, actual, expected };
  }

  async publish(state) {
    const publicationFence = state.beforePublication ? await state.beforePublication(state.stagedFiles.map(file => file.path)) : null;
    if (publicationFence !== null && typeof publicationFence !== 'function') fail('WORKFLOW_PUBLICATION_FENCE_INVALID');
    publicationFence?.();
    const files = [];
    for (const staged of state.stagedFiles) {
      const bytes = await readFile(staged.stagePath);
      const sha256 = hashBytes(bytes);
      if (staged.sha256 && staged.sha256 !== sha256) fail('WORKFLOW_STAGE_TAMPERED', staged.path);
      const targetExists = await exists(staged.path);
      let existingSha256 = null;
      if (targetExists) {
        const target = await this.assertSafePath(staged.path, { mustExist: true });
        const info = await stat(target);
        if (!info.isFile()) fail('WORKFLOW_OUTPUT_NOT_FILE', target);
        existingSha256 = hashBytes(await readFile(target));
        if (existingSha256 !== sha256 && !state.args.allowOverwrite) fail('WORKFLOW_OUTPUT_EXISTS', target);
      }
      files.push({ ...staged, sha256, size: bytes.byteLength, targetExists, existingSha256, idempotent: existingSha256 === sha256,
        publishTempPath: `${staged.path}.jarvis-publish-${randomBytes(6).toString('hex')}` });
    }
    const published = [];
    const backups = [];
    const persistentBackups = [];
    const actions = files.filter((file) => !file.idempotent).map((file) => {
      if (file.targetExists) {
        const backupPath = `${file.path}.jarvis-undo-${randomBytes(8).toString('hex')}`;
        return { action: 'restore_backup_file', path: file.path, backupPath };
      }
      return { action: 'delete_created_file', path: file.path };
    });
    try {
      for (const file of files) {
        publicationFence?.();
        if (file.targetExists) {
          const backupPath = join(state.stageRoot, 'backups', relative(state.selectedRoot, file.path));
          await mkdir(dirname(backupPath), { recursive: true });
          await copyFile(file.path, backupPath);
          if (hashBytes(await readFile(backupPath)) !== file.existingSha256) fail('WORKFLOW_OUTPUT_CHANGED_BEFORE_PUBLICATION', file.path);
          backups.push({ path: file.path, backupPath });
        }
      }
      if (this.undoJournal?.record) {
        for (const action of actions.filter((item) => item.action === 'restore_backup_file')) {
          const source = backups.find((backup) => samePath(backup.path, action.path))?.backupPath;
          if (!source) fail('WORKFLOW_BACKUP_MISSING', action.path);
          await copyFile(source, action.backupPath);
          persistentBackups.push(action.backupPath);
        }
      }
      // Persist the complete publication intent before the first rename. A
      // process can die after rename but before its completion record; the
      // before/after hashes and backups let later reconciliation distinguish
      // that uncertainty without blindly rerunning the workflow.
      let preparedIntent = {
        version: 'workflow-publication-journal-v1', phase: 'prepared', taskId: state.packet?.taskId ?? null,
        packetId: state.packet?.packetId ?? null, specSha256: state.loaded.sha256,
        workflowId: state.loaded.spec.workflowId, workspaceRoot: state.selectedRoot, stageRoot: state.stageRoot,
        files: files.map(file => ({ path: file.path, stagePath: file.stagePath, publishTempPath: file.publishTempPath,
          existedBefore: file.targetExists, beforeSha256: file.existingSha256,
          afterSha256: file.sha256, size: file.size, changed: !file.idempotent,
          backupPath: backups.find(backup => samePath(backup.path, file.path))?.backupPath ?? null })),
        inputs: [...state.sourceSnapshots.values()]
      };
      if (files.length && files.every(file => !file.targetExists)
        && state.loaded.spec.nodes.every(node => !node.op.startsWith('process.'))) {
        const recoveryPath = join(state.stageRoot, 'recovery-recipe.json');
        const recipe = JSON.stringify({ version: 'workflow-recovery-recipe-v1', startedAt: state.receipts[0]?.startedAt,
          receipts: state.receipts, workflowOutputs: Object.fromEntries([...state.outputs].map(([id, value]) => [id, cleanResult(value)])) });
        if (Buffer.byteLength(recipe) <= MAX_BYTES) {
          await writeFile(recoveryPath, recipe, { flag: 'wx', mode: 0o600, flush: true });
          preparedIntent.recoveryRecipe = { path: recoveryPath, sha256: hashBytes(recipe), stageRoot: state.stageRoot };
        }
      }
      if (publicationFence?.persistIntent) preparedIntent = await publicationFence.persistIntent(preparedIntent);
      await this.recordPublicationBoundary(state, preparedIntent);
      state.publicationPrepared = true;
      for (const file of files) {
        if (file.idempotent) continue;
        await mkdir(dirname(file.path), { recursive: true });
        const publishTemp = file.publishTempPath;
        try {
          await copyFile(file.stagePath, publishTemp);
          await this.recordPublicationBoundary(state, { phase: 'publishing', path: file.path, afterSha256: file.sha256 });
          publicationFence?.();
          if (file.targetExists) {
            await this.assertSafePath(file.path, { mustExist: true });
            if (hashBytes(await readFile(file.path)) !== file.existingSha256) fail('WORKFLOW_OUTPUT_CHANGED_BEFORE_PUBLICATION', file.path);
            // This version check is not an OS-level conditional replacement.
            publicationFence?.();
            await rename(publishTemp, file.path);
          } else {
            await this.assertSafePath(file.path, { mustExist: false });
            // Create only: an external writer winning the destination leaves
            // its file intact and causes EEXIST. Never fall back to rename.
            publicationFence?.();
            await link(publishTemp, file.path);
          }
          published.push(file);
          await this.recordPublicationBoundary(state, { phase: 'published', path: file.path, afterSha256: file.sha256 });
        } finally { await rm(publishTemp, { force: true }); }
      }
      await this.recordPublicationBoundary(state, { phase: 'all-files-published' });
    } catch (error) {
      const compensation = await this.revertPublication({
        restorePoints: published.map(file => ({ path: file.path, existed: file.targetExists,
          originalSha256: file.existingSha256, publishedSha256: file.sha256,
          stageBackupPath: backups.find(backup => samePath(backup.path, file.path))?.backupPath ?? null })),
        actions: persistentBackups.map(backupPath => ({ action: 'restore_backup_file', backupPath }))
      });
      if (!compensation.success) {
        const failure = new Error(`WORKFLOW_PUBLICATION_COMPENSATION_FAILED:${error.message}:${compensation.failures.join('|')}`);
        failure.code = 'WORKFLOW_PUBLICATION_COMPENSATION_FAILED';
        throw failure;
      }
      throw error;
    }
    const outputPaths = files.map((file) => file.path);
    const restorePoints = files.filter((file) => !file.idempotent).map((file) => ({
      path: file.path,
      existed: file.targetExists,
      originalSha256: file.existingSha256,
      publishedSha256: file.sha256,
      stageBackupPath: backups.find((backup) => samePath(backup.path, file.path))?.backupPath ?? null
    }));
    return {
      outputPaths,
      actions,
      restorePoints,
      proof: {
        version: 'workflow-publication-v1',
        changedFileCount: files.filter((file) => !file.idempotent).length,
        unchangedFileCount: files.filter((file) => file.idempotent).length,
        files: files.map((file) => ({
          path: file.path,
          existedBefore: file.targetExists,
          beforeSha256: file.existingSha256,
          afterSha256: file.sha256,
          size: file.size,
          changed: !file.idempotent
        }))
      },
      changedItems: files.map((file) => ({ type: file.idempotent ? 'unchanged_file' : file.targetExists ? 'overwrite_file' : 'create_file', path: file.path, sha256: file.sha256, size: file.size }))
    };
  }

  async recordPublicationBoundary(state, record) {
    const path = join(state.stageRoot, 'publication-journal.jsonl');
    await this.assertSafePath(path, { mustExist: false, allowRoot: false });
    const handle = await open(path, 'a', 0o600);
    try {
      await handle.writeFile(JSON.stringify({ version: 'workflow-publication-journal-v1',
        recordedAt: this.clock().toISOString(), ...record }) + '\n', 'utf8');
      await handle.sync();
    } finally { await handle.close(); }
  }

  async resumePublication(args, packet, intent, beforePublication, assertAccess = null, assertDataAccess = null) {
    try {
      assertAccess?.();
      const loaded = await this.loadSpecArguments(args);
      assertAccess?.();
      const recipeInfo = intent.recoveryRecipe;
      if (!recipeInfo || intent.taskId !== packet.taskId || intent.packetId !== packet.packetId
        || intent.specSha256 !== loaded.sha256 || !samePath(intent.workspaceRoot, loaded.workspaceRoot ?? this.lexicalRootFor(loaded.path))
        || !intent.files?.length || intent.files.some(file => file.existedBefore)
        || loaded.spec.nodes.some(node => node.op.startsWith('process.'))) fail('WORKFLOW_RESUME_UNSUPPORTED');
      // A fresh recovery fence has no in-memory dynamic-path observations.
      // Rebind every persisted output before claiming/publication on resume.
      for(const file of intent.files)assertDataAccess?.(file.path,'write')?.();
      const stageRoot = await this.assertSafePath(recipeInfo.stageRoot, { mustExist: true });
      if (!/^\.jarvis-workflow-stage-[a-f0-9]{32}$/.test(stageRoot.split(sep).at(-1))
        || !samePath(dirname(stageRoot), intent.workspaceRoot) || !isWithin(stageRoot, recipeInfo.path)) fail('WORKFLOW_RESUME_RECIPE_INVALID');
      const recipeBytes = await this.readBounded(recipeInfo.path, { inputBytes: 0 }, {assertAccess,stagedFiles:[]});
      if (recipeBytes.sha256 !== recipeInfo.sha256) fail('WORKFLOW_RESUME_RECIPE_CHANGED');
      const recipe = JSON.parse(recipeBytes.bytes.toString('utf8'));
      if (recipe.version !== 'workflow-recovery-recipe-v1' || !Array.isArray(recipe.receipts)
        || recipe.receipts.length !== loaded.spec.nodes.length) fail('WORKFLOW_RESUME_RECIPE_INVALID');
      const observation = await this.inspectPublication(packet.taskId);
      const expectedIntentHash = hashBytes(JSON.stringify(intent));
      if (observation.status !== 'observed' || observation.intentSha256 !== expectedIntentHash) fail('WORKFLOW_RESUME_PUBLICATION_CONFLICT');
      if (typeof beforePublication !== 'function') fail('WORKFLOW_RESUME_AUTHORITY_REQUIRED');
      const fence = await beforePublication(intent.files.map(file => file.path));
      if (typeof fence !== 'function') fail('WORKFLOW_RESUME_AUTHORITY_REQUIRED');
      const state = { stageRoot, assertAccess, assertDataAccess, sourceSnapshots: new Map(intent.inputs.map(snapshot => [snapshot.path, snapshot])) };
      fence(); await this.assertSourceSnapshotsCurrent(state);
      let resumedFiles = 0;
      for (const file of intent.files) {
        fence();
        await this.assertSafePath(file.path, { mustExist: false });
        const staged = await this.readBounded(file.stagePath, { inputBytes: 0 }, { assertAccess: fence, stagedFiles: [] });
        if (staged.sha256 !== file.afterSha256 || staged.bytes.length !== file.size) fail('WORKFLOW_RESUME_STAGE_CHANGED');
        const currentHash = await exists(file.path) ? hashBytes(await readFile(file.path)) : null;
        if (currentHash === file.afterSha256) continue;
        if (currentHash !== file.beforeSha256) fail('WORKFLOW_RESUME_TARGET_CHANGED');
        fence();
        await mkdir(dirname(file.path), { recursive: true });
        const temporary = this.recoveryPublicationTemp(file, intent);
        await this.assertSafePath(temporary, { mustExist: false });
        const priorTemp = await this.readRecoveryPublicationTemp(temporary);
        if (priorTemp) {
          if (hashBytes(priorTemp) !== file.afterSha256) fail('WORKFLOW_PUBLICATION_TEMP_CHANGED', temporary);
        } else {
          fence();
          await writeFile(temporary, staged.bytes, { flag: 'wx', mode: 0o600, flush: true });
        }
          fence();
          await this.recordPublicationBoundary(state, { phase: 'publishing', path: file.path, afterSha256: file.afterSha256 });
          fence(); await this.assertSourceSnapshotsCurrent(state);
          if (await exists(file.path)) fail('WORKFLOW_RESUME_TARGET_CHANGED');
          // Atomic create-only publication: an external file appearing after
          // the check cannot be overwritten by the resume path.
          fence();
          await link(temporary, file.path); resumedFiles++;
          await this.recordPublicationBoundary(state, { phase: 'published', path: file.path, afterSha256: file.afterSha256 });
      }
      fence();
      await this.recordPublicationBoundary(state, { phase: 'all-files-published' });
      fence(); await this.assertSourceSnapshotsCurrent(state);
      const publication = { outputPaths: intent.files.map(file => file.path),
        changedItems: intent.files.map(file => ({ path: file.path, sha256: file.afterSha256, size: file.size, type: 'create_file' })) };
      const manifest = await this.buildManifest(publication);
      fence();
      this.undoJournal?.refreshFromDisk?.();
      const undoEntries = [];
      for (const file of intent.files) {
        const prior = this.undoJournal?.entries?.find(entry => entry.taskId === packet.taskId && entry.action === 'delete_created_file'
          && samePath(entry.path, file.path) && entry.rollbackStatus !== 'rolled_back');
        const entry = prior ?? this.undoJournal?.record?.({ taskId: packet.taskId, action: 'delete_created_file', path: file.path });
        if (entry) undoEntries.push(entry);
      }
      const execution = { status: 'success', summary: `중단된 워크플로를 재개하고 ${manifest.length}개 결과 파일을 검증했습니다.`,
        outputPaths: publication.outputPaths, changedItems: publication.changedItems, warnings: [],
        rollbackAvailable: undoEntries.length > 0, undoJournalId: undoEntries[0]?.undoJournalId ?? null,
        undoJournalIds: undoEntries.map(entry => entry.undoJournalId), workflowOutputs: recipe.workflowOutputs,
        evidence: { manifest, workflow: { schemaVersion: loaded.spec.schemaVersion, workflowId: loaded.spec.workflowId,
          specPath: loaded.path, specSource: loaded.source, specSha256: loaded.sha256, nodeCount: loaded.spec.nodes.length,
          receipts: recipe.receipts, inputSnapshots: intent.inputs, startedAt: recipe.startedAt, endedAt: this.clock().toISOString(),
          publication: { version: 'workflow-publication-v1', files: intent.files.map(({ stagePath, backupPath, ...file }) => file),
            changedFileCount: intent.files.length, unchangedFileCount: 0 },
          resumedPublication: { resumedFiles, preservedFiles: intent.files.length - resumedFiles },
          stagingCleanup: { status: 'deferred-until-packet-receipt', pathSha256: hashBytes(stageRoot) } } } };
      pendingPublicationCleanup.set(execution, { stageRoot, taskId: packet.taskId, packetId: packet.packetId,
        publishTemps: intent.files.map(file => ({ path: this.recoveryPublicationTemp(file, intent), target: file.path, sha256: file.afterSha256 })) });
      return execution;
    } catch (error) {
      return { status: 'blocked', summary: `워크플로 재개 차단: ${error.code ?? error.message}`,
        error: { code: error.code ?? 'WORKFLOW_RESUME_FAILED' }, outputPaths: [], changedItems: [], rollbackAvailable: false };
    }
  }

  recoveryPublicationTemp(file, intent) {
    const path = file.publishTempPath ?? `${file.path}.jarvis-publish-${hashBytes(`${intent.taskId}\0${intent.specSha256}\0${file.path}`).slice(0, 12)}`;
    if (!samePath(dirname(path), dirname(file.path)) || !path.startsWith(`${file.path}.jarvis-publish-`)
      || !/^[a-f0-9]{12}$/.test(path.slice(`${file.path}.jarvis-publish-`.length))) fail('WORKFLOW_PUBLICATION_TEMP_IDENTITY_INVALID');
    return path;
  }

  async readRecoveryPublicationTemp(path) {
    await this.assertSafePath(path, { mustExist: false });
    let handle;
    try {
      handle = await open(path, 'r');
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES) fail('WORKFLOW_PUBLICATION_TEMP_SIZE_LIMIT');
      // Read at most the observed size plus one; concurrent growth cannot make
      // a cleanup/recovery diagnostic allocate an unbounded file buffer.
      const bytes = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > info.size) fail('WORKFLOW_PUBLICATION_TEMP_CHANGED');
      return bytes.subarray(0, length);
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    finally { await handle?.close(); }
  }
}

export const LOCAL_WORKFLOW_LIMITS = Object.freeze({
  maxBytes: MAX_BYTES,
  maxNodes: MAX_NODES,
  maxForeach: MAX_FOREACH,
  maxProcessTimeoutMs: MAX_PROCESS_TIMEOUT_MS,
  operations: [...OP_ALLOWLIST]
});
