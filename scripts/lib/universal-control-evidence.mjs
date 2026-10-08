import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EVIDENCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../artifacts/universal-control-extreme-v2');

export async function createEvidenceRun(base = EVIDENCE_ROOT, kind = 'audit') {
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, `${kind}-${new Date().toISOString().replace(/[:.]/gu, '-')}-`));
}

// Evidence is append-only. A rerun allocates a new directory rather than replacing a verdict.
export async function writeEvidence(file, value) {
  await writeFile(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
}

export async function evidenceReference(file) {
  const bytes = await readFile(file);
  return { path: path.resolve(file), sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}

export function summarizeProductRuns(runs) {
  const positive = runs.filter(run => run.controlKind === 'positive');
  const fault = runs.filter(run => run.controlKind === 'fault');
  const full = runs.filter(run => run.coverage?.originalCaseComplete === true && run.productPass);
  const adapters = [...new Set(runs.flatMap(run => run.executedToolNames ?? []).filter(Boolean))].sort();
  return {
    attemptedRuns: runs.length,
    passedRuns: runs.filter(run => run.productPass).length,
    failedRuns: runs.filter(run => !run.productPass).length,
    observedMissionStates: Object.fromEntries([...new Set(runs.map(run => run.missionStatus ?? 'UNKNOWN'))].sort().map(status => [status, runs.filter(run => (run.missionStatus ?? 'UNKNOWN') === status).length])),
    positiveControls: { passed: positive.filter(run => run.productPass).length, attempted: positive.length },
    faultControls: { passed: fault.filter(run => run.productPass).length, attempted: fault.length },
    adaptersExercised: adapters,
    uniqueAdapterCount: adapters.length,
    originalCorpusCasesCompleted: [...new Set(full.map(run => run.parentCaseId ?? run.caseId))],
    partialCoverageRuns: runs.filter(run => run.coverage?.partialCoverage === true).length,
    liveAccountsTested: 0,
    liveDevicesTested: 0,
    cost: '미측정'
  };
}
