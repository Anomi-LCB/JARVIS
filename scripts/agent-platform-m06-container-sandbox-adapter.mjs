import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const relative = path => path.slice(root.length + 1).replaceAll('\\', '/');
const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? null; };
function envFor(evidencePath) {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'ComSpec', 'PATHEXT', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { JARVIS_TEST_MODE: '1', JARVIS_M06_EVIDENCE_PATH: evidencePath });
  return env;
}

export function runM06ContainerSandboxAdapter({ outputRoot = 'artifacts/agent-platform-20260929/public-scenarios' } = {}) {
  const observedAt = new Date().toISOString();
  const runId = `${observedAt.replace(/[-:]/gu, '').replace(/\.\d{3}Z$/u, 'Z')}-${randomUUID()}`;
  const runRelative = `${outputRoot}/M06-local-${runId}`; const runDir = resolve(root, runRelative); mkdirSync(runDir, { recursive: true });
  const measurements = [];
  for (let repetition = 1; repetition <= 3; repetition++) {
    const startedAt = new Date().toISOString(); const repRelative = `${runRelative}/repetition-${repetition}`;
    const repDir = resolve(root, repRelative); mkdirSync(repDir, { recursive: true });
    const evidencePath = resolve(repDir, 'evidence.json'); const oraclePath = resolve(repDir, 'oracle.json'); const logPath = resolve(repDir, 'sandbox-test.log');
    const child = spawnSync(process.execPath, ['--test', 'tests/agent-platform-m06-container-sandbox.test.js'], {
      cwd: root, env: envFor(evidencePath), encoding: 'utf8', timeout: 90_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    writeFileSync(logPath, `${child.stdout ?? ''}${child.stderr ?? ''}`, { encoding: 'utf8', flag: 'wx' });
    let oracle = null; let stopCode = child.error?.code ?? (child.status === 0 ? null : `M06_TEST_EXIT_${child.status ?? 'UNKNOWN'}`);
    if (!stopCode && existsSync(evidencePath)) try {
      const output = execFileSync(process.execPath, ['scripts/agent-platform-independent-oracle.mjs', evidencePath, oraclePath], {
        cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true, env: envFor(evidencePath), maxBuffer: 1024 * 1024 });
      oracle = JSON.parse(output.trim().split(/\r?\n/u).at(-1)); if (oracle.status !== 'passed') stopCode = 'M06_ORACLE_FAILED';
    } catch (error) { stopCode = error?.code ?? 'M06_ORACLE_ERROR'; }
    const finishedAt = new Date().toISOString(); const durationMs = Date.parse(finishedAt) - Date.parse(startedAt); const status = stopCode ? 'failed' : 'completed';
    measurements.push({ scenarioId: 'M06', adapterId: 'm06-docker-desktop-offline-container-boundary',
      executionMode: 'actual-local-linux-container-pinned-image-network-disabled-read-only-root', repetition,
      startedAt, finishedAt, status, scenarioExecutionStatus: status,
      requirementResults: [
        { requirement: '공개 분석 코드를 제한된 Linux 컨테이너에서 실행한다.', status, oracleCheckIds: ['actual_nonroot_container_with_resource_caps'] },
        { requirement: '호스트 자격증명과 다른 프로젝트 경로에 접근하지 못한다.', status, oracleCheckIds: ['host_secret_and_unmounted_workspace_are_inaccessible'] },
        { requirement: '허용 산출물만 회수하고 네트워크를 차단한다.', status, oracleCheckIds: ['offline_container_and_single_output_mount'] }
      ], evidencePaths: [relative(evidencePath), ...(oracle && existsSync(oraclePath) ? [relative(oraclePath)] : []), relative(logPath)],
      oracle: oracle ? { status: oracle.status, name: oracle.oracle, independence: oracle.oracleIndependence, resultPath: relative(oraclePath), checks: oracle.checks } : null,
      durationMs, latencyMs: durationMs, providerCalls: 0, networkRequests: 0, externalWrites: 0, retries: 0,
      questions: null, approvals: null, costUsd: null, costMeasurement: 'unmeasured', stopCode });
  }
  const outcome = measurements.every(item => item.status === 'completed') ? 'completed' : measurements.some(item => item.status === 'failed') ? 'failed' : 'blocked';
  const report = { schemaVersion: 1, runId, observedAt, scenarioId: 'M06', declaredFamily: 'muse', mode: 'public-scenario-local-os-container-isolation',
    executionStatusChangedInCorpus: false, outcome, repetitionsPerConfiguration: 3, measurementKind: 'actual-docker-container-with-synthetic-host-boundary-probes', measurements,
    counts: { total: 3, completed: measurements.filter(item => item.status === 'completed').length, failed: measurements.filter(item => item.status === 'failed').length,
      blocked: measurements.filter(item => item.status === 'blocked').length, independentOracleRuns: measurements.filter(item => item.oracle?.status === 'passed').length },
    latencyMs: { p50: percentile(measurements.map(item => item.latencyMs), .5), p95: percentile(measurements.map(item => item.latencyMs), .95), unit: 'ms', includes: 'docker create/start/inspect/remove, hostile probe and separate-process oracle' },
    providerCalls: 0, networkRequests: 0, externalWrites: 0, costUsd: null, costMeasurement: 'unmeasured',
    limitations: ['실제 코드는 Docker Desktop Linux 컨테이너에서 실행되며 사용자 프로젝트 폴더는 mount하지 않았다. 합성 probe는 실행 디렉터리의 파일 접근 불가, 컨테이너 credential-like 환경변수 부재와 네트워크 차단을 확인한다.',
      '현재 Docker Desktop daemon은 rootless가 아니며 내장 seccomp를 사용한다. Docker daemon 자체는 강력한 호스트 권한 경계이므로 JARVIS의 일반 API/모델에 소켓을 노출하면 안 된다.',
      '컨테이너/Linux 커널 escape, 장기 부하, Windows 네이티브 실행, 별도 VM의 독립 관리, 다양한 프로젝트 payload 안전성은 미검증이다.',
      '오라클은 별도 프로세스지만 같은 저장소의 predicate이며 독립 인간 평가가 아니다. 비용은 미측정.'],
    evidence: { report: `${runRelative}/report.json`, summary: `${runRelative}/report.md` } };
  writeFileSync(resolve(runDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  const rows = measurements.map(item => `| ${item.repetition} | ${item.status} | ${item.latencyMs} ms | ${item.oracle?.status ?? 'not-run'} |`).join('\n');
  writeFileSync(resolve(runDir, 'report.md'), `# M06 로컬 실행 격리 경계 평가\n\n관측: ${observedAt}\n\n- 결과: ${outcome} (${report.counts.completed}/3); 별도 프로세스 오라클 ${report.counts.independentOracleRuns}/3\n- p50 ${report.latencyMs.p50} ms / p95 ${report.latencyMs.p95} ms\n- provider/network/external writes 0; 비용 미측정\n\n| 반복 | 상태 | 지연 | 오라클 |\n|---:|---|---:|---|\n${rows}\n\n## 한계\n\n${report.limitations.map(item => `- ${item}`).join('\n')}\n`, { encoding: 'utf8', flag: 'wx' });
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = runM06ContainerSandboxAdapter();
  console.log(JSON.stringify({ runId: report.runId, outcome: report.outcome, counts: report.counts, latencyMs: report.latencyMs, evidence: report.evidence }, null, 2));
}
