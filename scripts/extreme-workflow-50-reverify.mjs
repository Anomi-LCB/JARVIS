import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createExtremeWorkflowCorpusFingerprint,
  extremeCases,
  stableStringifyExtremeWorkflow
} from './extreme-workflow-50-cases.mjs';
import { verifyExpectedArtifacts } from './extreme-workflow-artifacts.mjs';

export const EXTREME_WORKFLOW_REVERIFY_VERSION = 'jarvis-extreme-workflow-50-reverify-v1';

export async function reverifyExtremeWorkflowAudit(runRoot) {
  const root = resolve(runRoot);
  const campaign = await readJson(join(root, 'campaign.json'));
  const storedCorpus = await readJson(join(root, 'corpus.json'));
  const selected = campaign.selectedCaseIds.map((id) => extremeCases.find((item) => item.id === id));
  const checks = [];
  const fingerprint = createExtremeWorkflowCorpusFingerprint(selected);
  add(checks, 'selected corpus hash matches campaign', campaign.selectedCorpusSha256 === fingerprint.corpusSha256, { stored: campaign.selectedCorpusSha256, actual: fingerprint.corpusSha256 });
  add(checks, 'stored corpus canonical payload matches source', stableStringifyExtremeWorkflow(storedCorpus) === stableStringifyExtremeWorkflow(fingerprint.canonicalPayload), {});
  add(checks, 'campaign execution count exact', campaign.totalExecutions === selected.length * campaign.cycles, { expected: selected.length * campaign.cycles, actual: campaign.totalExecutions });

  const ledgerPath = join(root, 'sequence-ledger.jsonl');
  const ledgerLines = (await readFile(ledgerPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const ledger = ledgerLines.map((line) => JSON.parse(line));
  add(checks, 'sequence ledger record count exact', ledger.length === campaign.totalExecutions, { expected: campaign.totalExecutions, actual: ledger.length });
  let previousHash = 'GENESIS';
  const results = [];
  for (let index = 0; index < ledger.length; index += 1) {
    const record = ledger[index];
    const expectedCase = selected[index % selected.length];
    const expectedCycle = Math.floor(index / selected.length) + 1;
    const unsigned = { ...record };
    delete unsigned.hash;
    add(checks, `ledger ${index + 1} sequence`, record.sequence === index + 1 && record.caseId === expectedCase?.id && record.cycle === expectedCycle, { record, expectedCaseId: expectedCase?.id, expectedCycle });
    add(checks, `ledger ${index + 1} previous hash`, record.previousHash === previousHash, { expected: previousHash, actual: record.previousHash });
    add(checks, `ledger ${index + 1} record hash`, record.hash === sha256Json(unsigned), { expected: record.hash, actual: sha256Json(unsigned) });
    previousHash = record.hash;
    const resultPath = join(root, `cycle-${String(record.cycle).padStart(2, '0')}`, record.caseId, 'result.json');
    const resultBytes = await readFile(resultPath);
    add(checks, `result ${index + 1} byte hash`, sha256(resultBytes) === record.resultSha256, { expected: record.resultSha256, actual: sha256(resultBytes) });
    const result = JSON.parse(resultBytes.toString('utf8'));
    results.push(result);
    add(checks, `result ${index + 1} identity`, result.caseId === record.caseId && result.cycle === record.cycle, {});
    add(checks, `result ${index + 1} behavioral pass`, result.behavioralPass === true && result.outcome !== 'FAILED', { outcome: result.outcome });
    add(checks, `result ${index + 1} fault consumption`, (result.faultEvidence ?? []).every((fault) => fault.consumed === 1), { faults: result.faultEvidence });
    add(checks, `result ${index + 1} no real external effect`, result.egress?.realAttempts === 0 && result.egress?.realCommits === 0, result.egress ?? {});
    add(checks, `result ${index + 1} semantic digest`, result.semanticDigest === computeSemanticDigest(result), { expected: result.semanticDigest, actual: computeSemanticDigest(result) });

    const workspace = join(dirname(resultPath), 'workspace');
    if (await pathExists(workspace)) {
      const artifactChecks = await verifyExpectedArtifacts(workspace, expectedCase);
      add(checks, `result ${index + 1} independent artifact verification`, artifactChecks.every((item) => item.pass), { failed: artifactChecks.filter((item) => !item.pass) });
    } else {
      add(checks, `result ${index + 1} compacted workspace declared`, campaign.cycles > 1, { workspace });
    }
  }

  const byCase = new Map();
  for (const result of results) {
    if (!byCase.has(result.caseId)) byCase.set(result.caseId, new Set());
    byCase.get(result.caseId).add(result.semanticDigest);
  }
  const mismatches = [...byCase].filter(([, digests]) => digests.size !== 1).map(([caseId, digests]) => ({ caseId, digests: [...digests] }));
  add(checks, 'semantic digest stable across cycles', mismatches.length === 0, { mismatches });

  const report = {
    reverificationVersion: EXTREME_WORKFLOW_REVERIFY_VERSION,
    runRoot: root,
    checkedAt: new Date().toISOString(),
    status: checks.every((item) => item.pass) ? 'passed' : 'failed',
    checkCount: checks.length,
    passed: checks.filter((item) => item.pass).length,
    failed: checks.filter((item) => !item.pass).length,
    corpusSha256: fingerprint.corpusSha256,
    finalLedgerHash: previousHash,
    resultCount: results.length,
    checks
  };
  report.reportSha256 = sha256Json({ ...report, checkedAt: undefined, reportSha256: undefined });
  await writeJson(join(root, 'reverification.json'), report);
  await writeFile(join(root, 'reverification.md'), renderMarkdown(report), 'utf8');
  return report;
}

function computeSemanticDigest(result) {
  return sha256Json({
    caseId: result.caseId,
    terminalState: result.terminalState,
    stopCode: result.stopCode,
    callCounts: sortObject(result.callCounts ?? {}),
    faults: (result.faultEvidence ?? []).map(({ faultId, consumed }) => ({ faultId, consumed })),
    events: result.events ?? [],
    assertions: (result.assertions ?? []).map(({ name, pass }) => ({ name, pass })),
    artifacts: (result.artifacts ?? []).map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest }))
  });
}

function renderMarkdown(report) {
  const failed = report.checks.filter((item) => !item.pass);
  return `# JARVIS 극한 복합 명령 독립 재검증\n\n- 상태: ${report.status}\n- 검사: ${report.passed}/${report.checkCount}\n- 결과 수: ${report.resultCount}\n- corpus SHA-256: \`${report.corpusSha256}\`\n- ledger 마지막 hash: \`${report.finalLedgerHash}\`\n- 보고서 hash: \`${report.reportSha256}\`\n\n## 실패 검사\n\n${failed.length ? failed.map((item) => `- ${item.name}: ${JSON.stringify(item.detail)}`).join('\n') : '- 없음'}\n`;
}

function add(checks, name, pass, detail) { checks.push({ name, pass: Boolean(pass), detail }); }
function sortObject(value) { return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function sha256Json(value) { return sha256(Buffer.from(JSON.stringify(canonicalize(value)), 'utf8')); }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function pathExists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.argv[2];
  if (!root) throw new Error('Usage: node scripts/extreme-workflow-50-reverify.mjs --root <audit-root>');
  const report = await reverifyExtremeWorkflowAudit(root);
  console.log(`REVERIFY ${report.status.toUpperCase()} ${report.passed}/${report.checkCount}`);
  if (report.status !== 'passed') process.exitCode = 1;
}
