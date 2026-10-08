import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ExcelWorkbookWorker } from '../apps/pc-agent/src/adapters/excel/excel-worker.js';
import { compareTypedCriterionContent } from '../packages/core/src/mission/criteria-evidence.js';

const root = resolve(process.argv[2] ?? 'artifacts/mission-xlsx-charts-20261003-samples');
await mkdir(root, { recursive: true });
const path = resolve(root, 'selected.xlsx');
try { await readFile(path); throw new Error('XLSX_RECHECK_OUTPUT_ALREADY_EXISTS'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const source = { sheetName: "성과 O'Brien", columns: ['제외', '월', '매출', '이익'], rows: [['x', '1월', 100, 10], ['y', '2월', 120, -5], ['z', '3월', 90, 12]],
  charts: [{ type: 'bar', title: '선택 실적', range: 'B1:D3' }, { type: 'line', title: '실적 추세', range: 'B1:D3' }, { type: 'pie', title: '월별 매출', range: 'B1:C4' }] };
const original = JSON.stringify(source), sourceSha256 = createHash('sha256').update(original).digest('hex');
await writeFile(resolve(root, 'source.json'), original + '\n', { flag: 'wx' });
await new ExcelWorkbookWorker().writeWorkbook({ ...source, outputPath: path });
const series = [
  { name: '매출', categoryFormula: "'성과 O''Brien'!$B$2:$B$3", valueFormula: "'성과 O''Brien'!$C$2:$C$3", categories: ['1월', '2월'], values: [100, 120] },
  { name: '이익', categoryFormula: "'성과 O''Brien'!$B$2:$B$3", valueFormula: "'성과 O''Brien'!$D$2:$D$3", categories: ['1월', '2월'], values: [10, -5] }
];
const spec = { version: 1, kind: 'xlsx.charts', path: 'selected.xlsx', sheetName: source.sheetName, equals: [
  { type: 'bar', title: '선택 실적', series }, { type: 'line', title: '실적 추세', series },
  { type: 'pie', title: '월별 매출', series: [{ name: '매출', categoryFormula: "'성과 O''Brien'!$B$2:$B$4", valueFormula: "'성과 O''Brien'!$C$2:$C$4", categories: ['1월', '2월', '3월'], values: [100, 120, 90] }] }
] };
const bytes = await readFile(path), proof = compareTypedCriterionContent({ spec, bytes });
const independent = JSON.parse(execFileSync('python', ['tests/fixtures/inspect-workbook-chart.py', path], { windowsHide: true, encoding: 'utf8' }));
const report = { observedAt: new Date().toISOString(), scope: 'synthetic fixed selected-range charts', sourceSha256,
  sourceUnchanged: JSON.stringify(source) === original, contentSha256: createHash('sha256').update(bytes).digest('hex'), spec, proof, independent, actualRenderingVerified: false };
await writeFile(resolve(root, 'recheck.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
if (proof.status !== 'passed' || independent.charts.length !== 3 || !report.sourceUnchanged) throw new Error('XLSX_CHART_RECHECK_FAILED');
console.log(JSON.stringify({ path, contentSha256: report.contentSha256, deterministicPassed: true, actualRenderingVerified: false }));
