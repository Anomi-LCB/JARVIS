import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { validateWorkflowSpec } from './workflow-ir.js';
import {verifyFieldSummaryResult} from './mission-field-summary-result.js';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const localOps = new Set(['financial.ofxReport', 'financial.report', 'health.report', 'theology.review', 'safety.simulation', 'data.readJson', 'data.readCsv', 'text.read', 'data.filter', 'data.sort', 'data.unique',
  'data.groupAggregate', 'data.join', 'data.pivot', 'data.validate', 'data.project', 'data.derive', 'data.flatten',
  'data.limit', 'data.union', 'data.reconcile', 'data.window', 'data.statistics', 'data.normalize', 'text.replace', 'text.extractFields',
  'text.redact', 'compute.ledger', 'compute.units', 'compute.compareChange', 'graph.toposort', 'graph.shortestPath', 'graph.criticalPath',
  'solver.knapsack', 'solver.schedule', 'fs.inventory', 'fs.search', 'fs.duplicates', 'text.stats',
  'template.renderMany', 'sqlite.import', 'sqlite.query', 'write.json', 'write.csv', 'write.text', 'assert.count', 'assert.equals']);
const inputOps = new Set(['data.readJson', 'data.readCsv', 'text.read']);
const directoryOps = new Set(['fs.inventory', 'fs.search', 'fs.duplicates']);
const outputOps = new Set(['sqlite.import']);
export function isLocalOnlyWorkflowSpec(spec) {
  return Array.isArray(spec?.nodes) && spec.nodes.every(node => localOps.has(node.op)
    && (node.op !== 'sqlite.query' || (typeof node.args?.sql === 'string'
      && /^\s*(?:SELECT|WITH)\b/iu.test(node.args.sql)
      && !/\b(?:insert|update|delete|drop|alter|attach|detach|vacuum|reindex|replace|create)\b/iu.test(node.args.sql)))
    && (node.op !== 'sqlite.import' || ['replace', 'append', 'upsert'].includes(node.args?.mode ?? 'replace')));
}
function inside(root, path) {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}

// These constraints are checked against the exact executed compiler spec and
// built-in adapter contract. This is not host-wide network or disk monitoring.
export function verifyLocalWorkflowConstraints({ mission, action, spec, roots, phase = 'dispatch' }) {
  const constraints = mission.constraints ?? [];
  const checks = [];
  if (!constraints.length) return { passed: true, checks };
  const dispatched = mission.waves.flatMap(wave => wave.actions).filter(item => item.operation?.dispatch);
  let exactExecution = dispatched.length === 1 && dispatched[0].actionId === action.actionId
    && matchesSpecArguments(action.operation.dispatch.arguments ?? {}, spec, roots);
  if (!exactExecution && phase !== 'completion' && action.expectedToolName === 'workflow.execute') {
    const args = action.arguments ?? {};
    if(args.spec!==undefined)exactExecution=dispatched.length===0&&matchesSpecArguments(args,spec,roots);
    else {
    try {
      const candidate = realpathSync.native(args.specPath);
      const bytes = readFileSync(candidate);
      exactExecution = sha256(bytes) === args.expectedSha256
        && digest(validateWorkflowSpec(JSON.parse(bytes.toString('utf8')))) === digest(spec)
        && roots.some(root => inside(root, candidate));
    } catch { exactExecution = false; }
    }
  }
  const localOnly = exactExecution && isLocalOnlyWorkflowSpec(spec);
  const observed=(mission.observations??[]).filter(o=>o.actionId===action.actionId);
  const dynamicSummaryProof=verifyFieldSummaryResult({objective:mission.objective,statement:`${mission.objective} 목표가 실제 실행 결과로 확인되고 G 검증을 통과한다.`,observations:observed,allowedRoots:roots});
  const resolvedInput=node=>dynamicSummaryProof.passed===true&&node.op==='text.read'&&node.args?.path?.$ref
    ? observed.find(o=>o.toolName==='workflow.execute')?.data?.workflow?.receipts?.find(r=>r.nodeId===node.id&&r.op==='text.read'&&r.status==='success')?.source?.path : null;
  const targetPath = node => node.op === 'sqlite.import' ? node.args?.databasePath : node.args?.path;
  const paths = spec.nodes.filter(node => inputOps.has(node.op) || directoryOps.has(node.op)
    || node.op.startsWith('write.') || outputOps.has(node.op))
    .map(node => typeof targetPath(node) === 'string' ? resolve(roots[0], targetPath(node)) : resolvedInput(node)?resolve(resolvedInput(node)):null);
  const insideRoots = roots.length > 0 && paths.every(path => path && roots.some(root => inside(root, path)));
  const originalInputs = new Set(), readDirectories = [], priorOutputs = new Set();
  for (const node of spec.nodes) {
    const rawPath = targetPath(node);
    const path = typeof rawPath === 'string' ? resolve(roots[0], rawPath) : null;
    if (inputOps.has(node.op) && !priorOutputs.has(path)) originalInputs.add(path);
    if (directoryOps.has(node.op)) readDirectories.push(path);
    if (node.op.startsWith('write.') || outputOps.has(node.op)) priorOutputs.add(path);
  }
  const specPath = action.operation?.dispatch?.arguments?.specPath ?? action.arguments?.specPath;
  if (typeof specPath === 'string') {
    try { originalInputs.add(realpathSync.native(specPath)); } catch { originalInputs.add(resolve(specPath)); }
  }
  const allowOverwrite = action.operation?.dispatch?.arguments?.allowOverwrite ?? action.arguments?.allowOverwrite;
  const inputsPreserved = localOnly && insideRoots && !allowOverwrite
    && [...priorOutputs].every(path => !originalInputs.has(path)
      && readDirectories.every(directory => directory && !inside(directory, path)));
  for (const constraint of constraints) {
    const statement = String(typeof constraint === 'string' ? constraint : constraint.statement ?? '').trim();
    const rootMatch = /^허용 루트는 (.+) 하나(?:뿐)?(?:이)?다[.]?$/u.exec(statement);
    let supported = true, passed = false, check;
    if (rootMatch) {
      check = 'single-allowed-root';
      passed = localOnly && insideRoots && roots.length === 1 && resolve(rootMatch[1]) === roots[0];
    } else if (statement === '외부 네트워크·계정·전송을 사용하지 않는다.'
      || statement === '외부 네트워크와 실제 외부 변경을 사용하지 않는다.') {
      check = 'local-adapter-operations-only'; passed = localOnly;
    } else if (statement === '명령에 명시된 입력 파일만 읽고 원본 파일을 수정하지 않는다.'
      || statement === '모든 입력은 읽기 전용이며 원본 파일을 이동·삭제·수정하지 않는다.'
      || statement === '워크플로 정의 파일과 inputs 바이트를 수정하지 않는다.') {
      check = 'declared-inputs-preserved'; passed = inputsPreserved;
    } else if (statement === '허용된 작업공간과 사용자가 명시한 허용 폴더 안에서만 파일을 변경한다.'
      || statement === '작업공간 안의 파일만 읽고 쓴다.') {
      check = 'workspace-only-file-effects';
      passed = localOnly && insideRoots && paths.length > 0 && paths.every(path => roots.some(root => inside(root, path)));
    } else if (statement === '외부 전송은 하지 않는다.' || statement === '외부 전송 금지') {
      check = 'no-external-transfer';
      passed = localOnly && exactExecution;
    } else if (statement === '최신 정보가 필요하면 출처와 조회 시점을 실행 증거에 남긴다.') {
      check = 'fresh-information-provenance-when-required';
      const freshInformationRequested = /(?:최신|오늘|현재|최근|뉴스|실시간|공식\s*출처|조회\s*시점)/u.test(mission.objective);
      passed = !freshInformationRequested || (spec.nodes.some(node => ['browser.search', 'web.search', 'search.web'].includes(node.op))
        && mission.observations.some(observation => observation.data?.webProvenance?.live === true && observation.data.webProvenance.capturedAt));
    } else if (statement === '외부 전송과 되돌릴 수 없는 작업은 행동별 승인을 받는다.') {
      check = 'external-or-irreversible-actions-have-action-approval';
      const externalOrIrreversible = spec.nodes.some(node => !localOps.has(node.op));
      passed = !externalOrIrreversible || dispatched.every(item => item.actionId === action.actionId && item.approval?.status === 'approved');
    } else if(statement==='외부 전송과 되돌릴 수 없는 작업은 기존 정책과 유효한 위임을 확인하고 필요한 행동만 확인받는다.'){
      check='local-workflow-has-no-external-or-irreversible-action';passed=localOnly&&insideRoots;
    } else { supported = false; check = 'constraint-verifier-unavailable'; }
    checks.push({ constraintId: constraint.constraintId ?? null, check, supported, passed,
      basis: 'exact-executed-spec-and-builtin-adapter-contract' });
  }
  return { passed: checks.every(check => check.passed), checks };
}

function sha256(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function matchesSpecArguments(args, spec, roots) {
  if (args.spec !== undefined) return digest(args.spec) === digest(spec);
  if (typeof args.specPath !== 'string' || !/^[a-f0-9]{64}$/iu.test(args.expectedSha256 ?? '')) return false;
  try {
    const path = realpathSync.native(args.specPath);
    if (!roots.some(root => inside(root, path))) return false;
    const bytes = readFileSync(path);
    return sha256(bytes) === args.expectedSha256.toLowerCase()
      && digest(validateWorkflowSpec(JSON.parse(bytes.toString('utf8')))) === digest(spec);
  } catch { return false; }
}
