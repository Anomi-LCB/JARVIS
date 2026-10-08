import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluateWearablePhysicalFieldReport } from '../apps/wearable-hud/src/field-lab.js';

const defaultEvidencePath = 'dist/wearable-hud-field-kit/field-evidence/latest-field-evidence.json';
const defaultJsonPath = 'dist/wearable-physical-field-gate.json';
const defaultMarkdownPath = 'dist/wearable-physical-field-gate.md';

export async function runWearablePhysicalFieldGate({
  workspaceRoot = process.cwd(),
  evidencePath = resolve(workspaceRoot, defaultEvidencePath),
  jsonPath = resolve(workspaceRoot, defaultJsonPath),
  markdownPath = resolve(workspaceRoot, defaultMarkdownPath),
  now = new Date()
} = {}) {
  const evidence = await readEvidenceEnvelope(evidencePath);
  const evaluation = evaluateWearablePhysicalFieldReport(evidence.envelope?.report ?? {});
  const integrity = evaluateEvidenceIntegrity(evidence.envelope);
  const status = evidence.state === 'missing'
    ? 'ready-for-physical-device'
    : integrity.passed
      ? evaluation.status
      : 'blocked';
  const report = {
    reportVersion: 'c-d-wearable-physical-field-gate-report-v1',
    generatedAt: toIso(now),
    status,
    physicalValidationPassed: status === 'passed',
    evidence: {
      state: evidence.state,
      path: resolve(evidencePath),
      evidenceId: evidence.envelope?.evidenceId ?? null,
      receivedAt: evidence.envelope?.receivedAt ?? null,
      reportStatus: evidence.envelope?.report?.status ?? null
    },
    integrity,
    evaluation,
    nextAction: nextActionFor(status),
    privacy: {
      rawFieldContentIncluded: false,
      rawTranscriptStored: false,
      rawAudioStored: false
    },
    artifacts: {
      jsonPath: resolve(jsonPath),
      markdownPath: resolve(markdownPath)
    }
  };
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(markdownPath, renderMarkdown(report), 'utf8');
  return report;
}

export function evaluateEvidenceIntegrity(envelope) {
  if (!envelope) {
    return {
      passed: false,
      state: 'not-present',
      checks: [integrityCheck('evidence_present', false), integrityCheck('evidence_hash_valid', false)]
    };
  }
  const schemaReady = envelope.envelopeVersion === 'c-d-wearable-field-evidence-envelope-v1'
    && typeof envelope.evidenceId === 'string'
    && envelope.report && typeof envelope.report === 'object';
  const calculatedId = envelope.report
    ? createHash('sha256').update(JSON.stringify(envelope.report)).digest('hex')
    : null;
  const hashReady = schemaReady && calculatedId === envelope.evidenceId;
  const checks = [
    integrityCheck('evidence_present', true),
    integrityCheck('evidence_envelope_schema_valid', schemaReady),
    integrityCheck('evidence_hash_valid', hashReady)
  ];
  return {
    passed: checks.every((item) => item.passed),
    state: checks.every((item) => item.passed) ? 'verified' : 'invalid',
    checks
  };
}

async function readEvidenceEnvelope(path) {
  try {
    return { state: 'available', envelope: JSON.parse(await readFile(path, 'utf8')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing', envelope: null };
    return {
      state: 'invalid',
      envelope: {
        envelopeVersion: 'invalid',
        evidenceId: null,
        report: null
      }
    };
  }
}

function integrityCheck(checkId, passed) {
  return { checkId, passed: Boolean(passed) };
}

function nextActionFor(status) {
  if (status === 'passed') return '현장 검증 증거가 유효합니다. 릴리스 증거 묶음에 포함할 수 있습니다.';
  if (status === 'blocked') return '필드 랩에서 실패 항목을 보정한 뒤 새 증거를 저장하세요.';
  return '실제 안경에서 field-calibration.html을 열고 전체 측정을 완료하세요.';
}

function renderMarkdown(report) {
  return [
    '# JARVIS Wearable Physical Field Gate',
    '',
    `Status: **${report.status}**`,
    `Physical validation passed: **${report.physicalValidationPassed}**`,
    `Evidence: ${report.evidence.state}`,
    `Integrity: ${report.integrity.state}`,
    `Next: ${report.nextAction}`,
    '',
    '## Integrity',
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...report.integrity.checks.map((item) => `| ${item.checkId} | ${item.passed ? 'yes' : 'no'} |`),
    '',
    '## Field Checks',
    '',
    '| Check | Passed |',
    '| --- | --- |',
    ...(report.evaluation.checks ?? []).map((item) => `| ${item.checkId} | ${item.passed ? 'yes' : 'no'} |`),
    ''
  ].join('\n');
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--workspace-root') args.workspaceRoot = argv[++index];
    else if (argv[index] === '--evidence') args.evidencePath = argv[++index];
    else if (argv[index] === '--json' || argv[index] === '--output') args.jsonPath = argv[++index];
    else if (argv[index] === '--markdown') args.markdownPath = argv[++index];
  }
  if (args.workspaceRoot) {
    if (args.evidencePath) args.evidencePath = resolve(args.workspaceRoot, args.evidencePath);
    if (args.jsonPath) args.jsonPath = resolve(args.workspaceRoot, args.jsonPath);
    if (args.markdownPath) args.markdownPath = resolve(args.workspaceRoot, args.markdownPath);
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await runWearablePhysicalFieldGate(parseArgs(process.argv.slice(2)));
  console.log('# JARVIS Wearable Physical Field Gate');
  console.log(`Status: ${report.status}`);
  console.log(`Evidence: ${report.evidence.state}`);
  console.log(`Next: ${report.nextAction}`);
  if (report.status === 'blocked') process.exitCode = 1;
}
