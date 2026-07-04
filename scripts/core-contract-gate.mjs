import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { CoreFacade } from '../packages/core/src/core-facade.js';
import { createCoreOpenApiSpec } from '../packages/core/src/main.mjs';
import {
  createCoreContractGateReport,
  loadCoreContractSnapshot,
  writeCoreContractSnapshot
} from '../packages/core/src/contracts/core-contract-gate.js';

const args = parseArgs(process.argv.slice(2));
const baselinePath = args.baseline ?? 'packages/core/contracts/core-openapi-snapshot.json';
const reportPath = args.report ?? 'dist/core-contract-gate-report.json';
const generatedAt = args.generatedAt ?? new Date().toISOString();
const currentOpenApi = createCoreOpenApiSpec(new CoreFacade());
const baselineSnapshot = await loadCoreContractSnapshot(baselinePath);
const report = createCoreContractGateReport({
  baselineSnapshot,
  currentOpenApi,
  label: 'core-contract-gate',
  generatedAt,
  allowBreaking: args.allowBreaking === true
});

if (args.writeBaseline === true) {
  await writeCoreContractSnapshot(baselinePath, report.currentSnapshot);
  report.status = 'baseline-written';
  report.gatePassed = true;
  report.requiredAction = 'none';
}

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`# JARVIS Core Contract Gate
status: ${report.status}
gatePassed: ${report.gatePassed}
baseline: ${baselinePath}
report: ${reportPath}`);

if (!report.gatePassed) {
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--write-baseline') parsed.writeBaseline = true;
    else if (arg === '--allow-breaking') parsed.allowBreaking = true;
    else if (arg === '--baseline') parsed.baseline = argv[++index];
    else if (arg === '--report') parsed.report = argv[++index];
    else if (arg === '--generated-at') parsed.generatedAt = argv[++index];
  }
  return parsed;
}
