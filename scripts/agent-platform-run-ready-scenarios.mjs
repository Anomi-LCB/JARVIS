import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPreflight, loadPublicScenarioRunHistory } from './agent-platform-evaluation-preflight.mjs';
import { createAgentPlatformScenarioRunners } from './agent-platform-scenario-runners.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evaluation = await import('../config/agent-platform-evaluation.json', { with: { type: 'json' } });
const bindings = await import('../config/agent-platform-evaluation-bindings.json', { with: { type: 'json' } });
const adapters = await import('../config/agent-platform-adapters.json', { with: { type: 'json' } });
const includeLivePublic = process.argv.includes('--include-live-public');
const unknownArgs = process.argv.slice(2).filter(arg => arg !== '--include-live-public');
if (unknownArgs.length) throw new Error(`unknown argument: ${unknownArgs.join(', ')}`);

const runners = createAgentPlatformScenarioRunners();
const history = loadPublicScenarioRunHistory(root);
const preflight = buildPreflight(evaluation.default, bindings.default, new Date().toISOString(), root, adapters.default, history);
const selected = preflight.scenarios.filter(item => item.scenarioExecutionEligible
  && runners.has(item.id) && (item.id !== 'G01' || includeLivePublic));
if (!selected.length) throw new Error('no locally executable scenario adapters selected');

const observedAt = new Date().toISOString();
const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
const directory = resolve(root, 'artifacts/agent-platform-20260929/ready-scenario-runs', runId);
mkdirSync(directory, { recursive: true });
const scenarioResults = [];
for (const scenario of selected) {
  const startedAt = new Date().toISOString();
  try {
    const report = await runners.get(scenario.id)();
    scenarioResults.push({ scenarioId: scenario.id, startedAt, finishedAt: new Date().toISOString(),
      outcome: report.outcome, repetitions: report.measurements?.length ?? 0,
      oraclePasses: report.measurements?.filter(item => item.oracle?.status === 'passed').length ?? 0,
      networkRequests: report.networkRequests ?? 0, externalWrites: report.externalWrites ?? 0,
      costUsd: report.costUsd ?? null, costMeasurement: report.costMeasurement ?? 'unmeasured',
      evidence: report.evidence ?? null, sourceReport: report.evidence?.report ?? null,
      limitations: report.limitations ?? [] });
  } catch (error) {
    scenarioResults.push({ scenarioId: scenario.id, startedAt, finishedAt: new Date().toISOString(),
      outcome: 'failed', repetitions: 0, oraclePasses: 0, networkRequests: 0, externalWrites: 0,
      costUsd: null, costMeasurement: 'unmeasured', evidence: null, sourceReport: null,
      error: error?.message ?? String(error), limitations: ['어댑터가 보고서를 반환하지 못해 완료 여부를 확인하지 못했다.'] });
  }
}
const finishedAt = new Date().toISOString();
const outcomeCounts = Object.fromEntries(['completed', 'failed', 'blocked'].map(outcome =>
  [outcome, scenarioResults.filter(item => item.outcome === outcome).length]));
const report = {
  schemaVersion: 1, runId, observedAt, startedAt: observedAt, finishedAt,
  mode: includeLivePublic ? 'ready-local-adapters-including-allowlisted-live-public-read' : 'ready-local-adapters-no-network',
  selection: { preflightScenarioCount: preflight.counts.total, eligibleScenarioCount: preflight.counts.scenarioExecutionEligible,
    selectedScenarioIds: selected.map(item => item.id), skippedLivePublic: !includeLivePublic && preflight.scenarios.some(item => item.scenarioExecutionEligible && item.id === 'G01') },
  counts: { total: scenarioResults.length, ...outcomeCounts,
    repetitions: scenarioResults.reduce((sum, item) => sum + item.repetitions, 0),
    oraclePasses: scenarioResults.reduce((sum, item) => sum + item.oraclePasses, 0) },
  networkRequests: scenarioResults.reduce((sum, item) => sum + item.networkRequests, 0),
  externalWrites: scenarioResults.reduce((sum, item) => sum + item.externalWrites, 0),
  costUsd: scenarioResults.every(item => item.costUsd !== null) ? scenarioResults.reduce((sum, item) => sum + item.costUsd, 0) : null,
  costMeasurement: scenarioResults.every(item => item.costMeasurement === 'measured') ? 'measured' : 'unmeasured',
  latencyMs: { p50: null, p95: null, note: '시나리오별 전체 지연은 원 보고서에 기록되며 이 집계기는 서로 다른 작업 지연을 하나의 표본으로 합치지 않는다.' },
  scenarios: scenarioResults,
  limitations: [
    '실행 전 정적 준비도와 로컬 어댑터만 검사한다. 외부 계정, 제공자 모델, 독립 인간 평가 또는 실기기 기능은 검증하지 않는다.',
    '각 어댑터의 별도 프로세스 오라클은 같은 저장소의 코드이므로 독립 저자 평가가 아니다.',
    'G01은 --include-live-public를 지정했을 때만 allowlist된 W3C 페이지에 GET 요청을 한다. 사용자 데이터 전송이나 외부 쓰기는 없다.',
    '비용과 사용자 UI 질문·승인 횟수는 측정되지 않는다. 준비되지 않은 시나리오는 실행 대상에서 제외되며 성공으로 계산하지 않는다.'
  ]
};
const jsonPath = resolve(directory, 'report.json');
const markdownPath = resolve(directory, 'report.md');
writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
const rows = scenarioResults.map(item => `| ${item.scenarioId} | ${item.outcome} | ${item.repetitions} | ${item.oraclePasses} | ${item.networkRequests} | ${item.sourceReport ?? item.error ?? ''} |`).join('\n');
writeFileSync(markdownPath, `# 준비된 공개 시나리오 실행 집계\n\n관측: ${observedAt}\n\n- 결과: ${outcomeCounts.completed}/${scenarioResults.length} 완료, ${outcomeCounts.failed} 실패, ${outcomeCounts.blocked} 차단\n- 반복: ${report.counts.repetitions}; 별도 프로세스 오라클 통과: ${report.counts.oraclePasses}\n- 네트워크 요청: ${report.networkRequests}; 외부 쓰기: ${report.externalWrites}; 비용: 미측정\n- 실행 방식: ${report.mode}\n\n| ID | 상태 | 반복 | 오라클 통과 | 네트워크 | 상세 증거 |\n|---|---|---:|---:|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
console.log(JSON.stringify({ runId, outcomeCounts, repetitions: report.counts.repetitions,
  oraclePasses: report.counts.oraclePasses, networkRequests: report.networkRequests,
  report: relativeToRoot(jsonPath), summary: relativeToRoot(markdownPath) }, null, 2));

function relativeToRoot(path) { return path.slice(root.length + 1).replaceAll('\\', '/'); }
