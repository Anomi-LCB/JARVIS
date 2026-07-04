import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCoreApiContractSnapshot, diffCoreApiContractSnapshots } from '../client/core-client.js';

export async function loadCoreContractSnapshot(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function writeCoreContractSnapshot(filePath, snapshot) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  return snapshot;
}

export function createCoreContractGateReport({
  baselineSnapshot = null,
  currentOpenApi,
  label = 'core-contract-gate',
  generatedAt = new Date().toISOString(),
  allowBreaking = false
} = {}) {
  const currentSnapshot = createCoreApiContractSnapshot(currentOpenApi, {
    label: `${label}:current`,
    generatedAt
  });
  if (!baselineSnapshot) {
    return {
      gateVersion: 'a-core-contract-gate-v1',
      label,
      generatedAt,
      status: 'baseline-missing',
      gatePassed: false,
      allowBreaking,
      currentSnapshot,
      diff: null,
      requiredAction: 'write-baseline'
    };
  }
  const diff = diffCoreApiContractSnapshots(baselineSnapshot, currentSnapshot, {
    label,
    generatedAt
  });
  const breaking = diff.status === 'breaking-change';
  return {
    gateVersion: 'a-core-contract-gate-v1',
    label,
    generatedAt,
    status: breaking && !allowBreaking ? 'failed' : 'passed',
    gatePassed: !breaking || allowBreaking,
    allowBreaking,
    currentSnapshot,
    baselineSnapshot,
    diff,
    requiredAction: breaking && !allowBreaking ? 'approve-contract-diff' : 'none'
  };
}
