import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ExcelWorkbookWorker } from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
import { compareTypedCriterionContent } from '../packages/core/src/mission/criteria-evidence.js';

const root = resolve('artifacts/mission-xlsx-cells-20261003-samples');
await mkdir(root, { recursive: true });
const path = resolve(root, 'budget.xlsx');
// Preserve a previous run rather than silently replacing its evidence.
try { await readFile(path); throw new Error('XLSX_RECHECK_OUTPUT_ALREADY_EXISTS'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const source = { sheetName: '예산', columns: ['항목', '금액'], rows: [['인쇄 & 준비', 20000], ['간식', 30000], ['합계', 50000]] };
const sourceBytes = JSON.stringify(source), sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
await writeFile(resolve(root, 'source.json'), sourceBytes + '\n', { flag: 'wx' });
await new ExcelWorkbookWorker().writeWorkbook({ ...source, outputPath: path });
const bytes = await readFile(path), spec = { version: 1, kind: 'xlsx.cells', path: 'budget.xlsx', sheetName: '예산', equals: { A2: '인쇄 & 준비', B2: 20000, B3: 30000, B4: 50000 } };
const independent = JSON.parse(execFileSync('python', ['tests/fixtures/inspect-workbook-chart.py', path], { encoding: 'utf8', windowsHide: true }));
const times = [], outcomes = [];
for (let i = 0; i < 30; i++) { const start = performance.now(); outcomes.push(compareTypedCriterionContent({ spec, bytes }).status); times.push(performance.now() - start); }
times.sort((a, b) => a - b);
const report = { observedAt: new Date().toISOString(), sampleKind: 'synthetic-fixed-budget', sourceSha256,
  sourceUnchanged: createHash('sha256').update(JSON.stringify(source)).digest('hex') === sourceSha256,
  spec, outcomes, wrongTotal: compareTypedCriterionContent({ spec: { ...spec, equals: { B4: 999 } }, bytes }).status,
  independent, contentSha256: createHash('sha256').update(bytes).digest('hex'), actualRenderingVerified: false, formulaRecalculationVerified: false,
  measurement: { scope: 'in-memory content comparator only; excludes G/read/write/planning/UI', repetitions: times.length, p50Ms: times[14], p95Ms: times[28], modelCalls: 0, actualExternalCost: null } };
await writeFile(resolve(root, 'recheck.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
if (outcomes.some(status => status !== 'passed') || report.wrongTotal !== 'failed' || !report.sourceUnchanged || independent.worksheets['예산'].B4 !== 50000) throw new Error('XLSX_RECHECK_FAILED');
console.log(JSON.stringify({ ...report.measurement, passed: true, reportPath: resolve(root, 'recheck.json') }));
