import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus, platform, release, tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEvidenceRun, writeEvidence } from './lib/universal-control-evidence.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUTPUT = join(ROOT, 'artifacts/universal-control-v3-latency');
const digest = value => createHash('sha256').update(value).digest('hex');
const rounded = value => Number(value.toFixed(3));
const envSettings = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '0', JARVIS_LLM_INTENT: '0',
  JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0', JARVIS_PERSONAL_IMPORT_ENABLED: '0', JARVIS_GOOGLE_SYNC_ENABLED: '0' };
const duplicate = '격리된 중복 파일 감지 시험\n내용은 읽기 전용입니다.\n';
const CASES = [
  {
    id: 'fixed-csv-aggregate',
    objective: "'inputs/a.csv' CSV를 'A'로 읽고; 'inputs/b.csv' CSV를 'B'로 읽고; 'A'와 'B'를 합쳐 '전체'로 만들고; '전체'에서 'status'가 'paid'인 행만 'paid'로 걸러내고; 'paid'를 'region'별로 'amount' 합계 'total'을 계산해 '요약'으로 만들고; '요약'을 'outputs/summary.csv' CSV로 저장해.",
    inputs: { 'a.csv': 'id,region,status,amount\n1,north,paid,10\n2,north,paid,20\n3,south,void,50\n',
      'b.csv': 'id,region,status,amount\n4,south,paid,5\n5,north,paid,7\n' },
    output: 'outputs/summary.csv',
    criteria: [{ criterionId: 'exact_csv', statement: '지역별 합계가 정확히 일치한다.',
      verificationSpec: { version: 1, kind: 'csv.rows', path: 'outputs/summary.csv',
        equals: [{ region: 'north', total: 37 }, { region: 'south', total: 5 }], numericColumns: ['total'], order: 'unordered' } }],
    verify(bytes) {
      // Independent, deliberately strict oracle for this fixed unquoted CSV fixture.
      // No column projection: an extra value column is a failure.
      const lines = bytes.toString('utf8').trimEnd().split(/\r?\n/u);
      return lines.length === 3 && lines[0] === 'region,total'
        && JSON.stringify(lines.slice(1).sort()) === JSON.stringify(['north,37', 'south,5']);
    }
  },
  {
    id: 'fixed-content-duplicates',
    objective: "'inputs' 폴더의 파일을 재귀 해시 목록으로 조사해 '인벤토리'로 만들고; 'inputs' 폴더의 내용 중복을 찾아 '중복'으로 만들고; '중복'을 'outputs/duplicates.json' JSON으로 저장하고; '중복'의 개수가 1인지 검증해.",
    inputs: { 'a.txt': duplicate, 'nested/copy.txt': duplicate, 'unique.txt': '서로 다른 합성 파일\n' },
    output: 'outputs/duplicates.json',
    criteria: [{ criterionId: 'duplicate_count', statement: '중복 그룹은 두 파일로 구성된다.',
      verificationSpec: { version: 1, kind: 'json.value', path: 'outputs/duplicates.json', pointer: '/0/count', equals: 2 } },
    { criterionId: 'duplicate_hash', statement: '중복 내용 해시가 원본과 일치한다.',
      verificationSpec: { version: 1, kind: 'json.value', path: 'outputs/duplicates.json', pointer: '/0/sha256', equals: digest(duplicate) } }],
    verify(bytes, workspace) {
      const groups = JSON.parse(bytes.toString('utf8'));
      const group = groups?.[0], expected = ['a.txt', 'nested/copy.txt'];
      return Array.isArray(groups) && groups.length === 1 && group.count === 2 && group.size === Buffer.byteLength(duplicate)
        && group.sha256 === digest(duplicate) && Array.isArray(group.files) && group.files.length === 2
        && JSON.stringify(group.files.map(file => file.relativePath).sort()) === JSON.stringify(expected)
        && group.files.every(file => file.sha256 === digest(duplicate) && file.size === Buffer.byteLength(duplicate)
          && resolve(file.path) === resolve(workspace, 'inputs', file.relativePath));
    }
  }
];

export function latencyDistribution(values) {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (!sorted.length) return { samples: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null, meanMs: null };
  const percentile = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)];
  return { samples: sorted.length, minMs: rounded(sorted[0]), p50Ms: rounded(percentile(0.5)),
    p95Ms: rounded(percentile(0.95)), maxMs: rounded(sorted.at(-1)), meanMs: rounded(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
}

async function sourceSnapshot() {
  const files = [];
  for (const folder of ['apps', 'packages', 'src', 'scripts']) {
    for (const file of await readdir(join(ROOT, folder), { recursive: true })) {
      if (/\.(?:js|mjs|ts|tsx|json)$/u.test(file) && !/(?:^|[\\/])(?:node_modules|build)(?:[\\/])/u.test(file)) files.push(`${folder}/${file.replaceAll('\\', '/')}`);
    }
  }
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, digest(await readFile(join(ROOT, file)))])));
}

function instrument(target, method, stage, active) {
  const original = target?.[method];
  if (typeof original !== 'function') throw new Error(`LATENCY_INSTRUMENTATION_MISSING:${stage}`);
  target[method] = function (...args) {
    const sample = active.current, started = performance.now();
    const finish = failed => {
      if (!sample) return;
      const call = { stage, durationMs: rounded(performance.now() - started), failed };
      if (stage === 'B.receiveExecutionPacket') { call.packetId = args[0]?.packetId ?? null; call.taskId = args[0]?.taskId ?? null; }
      if (stage === 'Worker.runTask') call.taskId = args[0];
      sample.stageCalls.push(call);
    };
    try {
      const value = Reflect.apply(original, this, args);
      if (value && typeof value.then === 'function') return value.then(result => { finish(false); return result; }, error => { finish(true); throw error; });
      finish(false); return value;
    } catch (error) { finish(true); throw error; }
  };
}

function summarize(samples) {
  return {
    attempts: samples.length, completedAndVerified: samples.filter(item => item.passed).length,
    blockedOrWaiting: samples.filter(item => ['BLOCKED', 'WAITING_APPROVAL', 'PAUSED'].includes(item.missionStatus)).length,
    failedOrUnverified: samples.filter(item => !item.passed && !['BLOCKED', 'WAITING_APPROVAL', 'PAUSED'].includes(item.missionStatus)).length,
    requestToVerified: latencyDistribution(samples.map(item => item.timings.requestToVerifiedMs)),
    runtimeToVerified: latencyDistribution(samples.map(item => item.timings.runtimeToVerifiedMs)),
    preparation: latencyDistribution(samples.map(item => item.timings.preparationMs)),
    runtimeInitialization: latencyDistribution(samples.map(item => item.timings.runtimeInitializationMs)),
    missionCreation: latencyDistribution(samples.map(item => item.timings.missionCreationMs)),
    missionExecution: latencyDistribution(samples.map(item => item.timings.missionExecutionMs)),
    independentOracle: latencyDistribution(samples.map(item => item.timings.independentOracleMs)),
    stagesInclusive: Object.fromEntries([...new Set(samples.flatMap(item => item.stageCalls.map(call => call.stage)))].sort().map(stage => {
      const calls = samples.flatMap(item => item.stageCalls.filter(call => call.stage === stage));
      return [stage, { calls: calls.length, throwingCalls: calls.filter(call => call.failed).length, ...latencyDistribution(calls.map(call => call.durationMs)) }];
    }))
  };
}

export async function runMissionLocalLatencyAudit({ iterations = 20, outputBase = DEFAULT_OUTPUT } = {}) {
  if (!Number.isInteger(iterations) || iterations < 10 || iterations > 100) throw new Error('iterations must be an integer from 10 to 100 per fixed case');
  if (Object.entries(envSettings).some(([key, value]) => process.env[key] !== value)) throw new Error('Run this audit through its isolated CLI entry point.');
  const startedAt = new Date().toISOString();
  const sourcesBefore = await sourceSnapshot();
  const importAt = performance.now();
  const [{ createAgRuntime }, { MissionGrant }, { clearNaturalWorkflowCompileCache }] = await Promise.all([
    import('../apps/runtime-compose/src/create-runtime.js'), import('../packages/core/src/mission/mission-runtime.js'),
    import('../packages/core/src/mission/natural-workflow-compiler.js')
  ]);
  const moduleImportMs = rounded(performance.now() - importAt);
  const output = await createEvidenceRun(resolve(outputBase), 'mission-latency');
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'jarvis-mission-latency-'));
  const samples = [], cleanupErrors = [];
  let evidencePersistenceMs = 0;
  const cases = CASES.map(({ verify, ...item }) => ({ ...item, commandSha256: digest(item.objective) }));
  await writeEvidence(join(output, 'cases.json'), cases);
  try {
    for (const item of CASES) {
      const workspace = join(temporaryRoot, item.id), active = { current: null };
      let runtime = null, owner = null;
      const initialPreparationAt = performance.now();
      await mkdir(join(workspace, 'inputs'), { recursive: true });
      for (const [name, content] of Object.entries(item.inputs)) {
        const target = join(workspace, 'inputs', name);
        await mkdir(dirname(target), { recursive: true }); await writeEvidence(target, content);
      }
      const initialPreparationMs = performance.now() - initialPreparationAt;
      clearNaturalWorkflowCompileCache();
      try {
        for (let iteration = 1; iteration <= iterations; iteration++) {
          const sample = { caseId: item.id, iteration, observedAt: new Date().toISOString(),
            temperature: runtime ? 'warm-runtime-repeat' : 'cold-runtime-no-explicit-warmup',
            processFirstMeasuredSample: samples.length === 0, missionStatus: null, passed: false,
            timings: { preparationMs: 0, runtimeInitializationMs: 0, authorizationSetupMs: 0,
              missionCreationMs: null, missionExecutionMs: null, independentOracleMs: null, requestToVerifiedMs: null, runtimeToVerifiedMs: null }, stageCalls: [] };
          active.current = sample;
          const preparationAt = performance.now();
          const destination = resolve(workspace, item.output), suffix = relative(workspace, destination);
          if (!suffix || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('UNSAFE_BENCHMARK_OUTPUT');
          // Prior bytes are already preserved in that sample's immutable evidence directory.
          // Only this benchmark-owned output is removed so the exact same command can execute again.
          try { await unlink(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          sample.timings.preparationMs = rounded(performance.now() - preparationAt + (iteration === 1 ? initialPreparationMs : 0));
          const runtimeAt = performance.now();
          let requestAt = null, mission = null, outputBytes = null;
          try {
            if (!runtime) {
              const at = performance.now();
              runtime = createAgRuntime({ allowedRoots: [workspace], auditRoot: join(workspace, 'audit'), cwd: () => workspace,
                env: envSettings, taskEnv: envSettings, workerDaemonEnabled: false, bridgeRealExecution: true, workerDefaultTimeoutMs: 45000 });
              sample.timings.runtimeInitializationMs = rounded(performance.now() - at);
              for (const [target, method, stage] of [
                [runtime.missionPlanner, 'planDeterministicWorkflow', 'A.planDeterministicWorkflow'],
                [runtime.policyRuntime, 'evaluatePlan', 'E.evaluatePlan'],
                [runtime.orchestrationWorker, 'runTask', 'Worker.runTask'],
                [runtime.pcAgent, 'receiveExecutionPacket', 'B.receiveExecutionPacket'],
                [runtime.verificationRuntime, 'verifyExecution', 'G.verifyExecution'],
                [runtime.missionRuntime, 'verifyCriterionEvidence', 'Mission.verifyCriterionEvidence']
              ]) instrument(target, method, stage, active);
              const authorizationAt = performance.now();
              owner = runtime.personalOwnerSession.activate({ durationMinutes: 60, requestedBy: 'mission-local-latency-audit' });
              sample.timings.authorizationSetupMs = rounded(performance.now() - authorizationAt);
            }
            requestAt = performance.now();
            const creationAt = performance.now();
            const created = runtime.missionRuntime.createMission({ objective: item.objective, successCriteria: item.criteria,
              constraints: [`허용 루트는 ${workspace} 하나이다.`, '외부 네트워크·계정·전송을 사용하지 않는다.', '모든 입력은 읽기 전용이며 원본 파일을 이동·삭제·수정하지 않는다.'],
              budgets: { maxWaves: 3, maxActions: 8, maxPlannerCalls: 4, maxConsecutiveFailures: 2, maxActiveRuntimeMs: 60000 },
              authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId, grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] },
              metadata: { latencyFixedCase: item.id, repeatIndex: iteration, externalNetworkAllowed: false },
              idempotencyKey: `latency:${item.id}:${iteration}` });
            sample.timings.missionCreationMs = rounded(performance.now() - creationAt);
            const executionAt = performance.now();
            try { mission = await runtime.missionRuntime.runMission(created.missionId); }
            finally { sample.timings.missionExecutionMs = rounded(performance.now() - executionAt); }
          } catch (error) { sample.error = { code: error.code ?? 'AUDIT_EXECUTION_ERROR', message: error.message }; }
          const oracleAt = performance.now();
          sample.inputIntegrity = {};
          for (const [name, content] of Object.entries(item.inputs)) {
            try { sample.inputIntegrity[name] = digest(await readFile(join(workspace, 'inputs', name))) === digest(content); }
            catch { sample.inputIntegrity[name] = false; }
          }
          try { outputBytes = await readFile(destination); sample.outputMatches = item.verify(outputBytes, workspace); }
          catch (error) { sample.outputMatches = false; sample.outputError = { code: error.code ?? 'ORACLE_ERROR', message: error.message }; }
          sample.timings.independentOracleMs = rounded(performance.now() - oracleAt);
          sample.timings.runtimeToVerifiedMs = rounded(performance.now() - runtimeAt);
          sample.timings.requestToVerifiedMs = requestAt === null ? null : rounded(performance.now() - requestAt);
          sample.missionStatus = mission?.status ?? null;
          sample.metrics = mission?.metrics ?? null;
          sample.compilerCacheObservations = (mission?.planHistory ?? []).map(plan => ({ provider: plan.planning?.provider ?? null, cacheHit: plan.planning?.cacheHit ?? null }));
          sample.outputSha256 = outputBytes ? digest(outputBytes) : null;
          const actions = mission?.waves?.flatMap(wave => wave.actions) ?? [];
          const executed = actions.filter(action => action.taskId);
          const observed = mission?.observations?.filter(observation => executed.some(action => action.actionId === observation.actionId)) ?? [];
          const calls = stage => sample.stageCalls.filter(call => call.stage === stage);
          const packets = calls('B.receiveExecutionPacket'), worker = calls('Worker.runTask');
          sample.calls = { localPlanner: mission?.metrics?.plannerCalls ?? 0, modelAttempts: mission?.metrics?.plannerAttempts ?? null,
            policyEvaluation: calls('E.evaluatePlan').length, worker: worker.length, pcPackets: packets.length,
            GExecutionVerification: calls('G.verifyExecution').length, criterionVerification: calls('Mission.verifyCriterionEvidence').length };
          sample.retries = { planner: mission?.metrics?.plannerRetries ?? null,
            repeatedWorkerTaskCalls: worker.length - new Set(worker.map(call => call.taskId)).size,
            repeatedPcPacketCalls: packets.length - new Set(packets.map(call => call.packetId)).size,
            scope: 'Observed API repeats plus Mission planner retries; not an estimate of hidden OS/provider retries.' };
          sample.passed = !sample.error && mission?.status === 'COMPLETED' && mission.completion?.status === 'verified'
            && mission.verificationStatus === 'passed' && sample.outputMatches && Object.values(sample.inputIntegrity).every(Boolean)
            && executed.length === 1 && executed[0].actualToolName === 'workflow.execute' && observed.length === 1
            && observed[0].verification?.status === 'passed' && Boolean(observed[0].evidenceId)
            && sample.calls.policyEvaluation > 0 && worker.length === 1 && packets.length === 1 && sample.calls.GExecutionVerification > 0
            && sample.calls.modelAttempts === 0;
          samples.push(sample); active.current = null;
          const persistenceAt = performance.now(), sampleDir = join(output, item.id, String(iteration).padStart(3, '0'));
          await mkdir(sampleDir, { recursive: true });
          await writeEvidence(join(sampleDir, 'sample.json'), sample);
          await writeEvidence(join(sampleDir, 'mission.json'), mission);
          if (outputBytes) await writeEvidence(join(sampleDir, item.output.split('/').at(-1)), outputBytes.toString('utf8'));
          evidencePersistenceMs += performance.now() - persistenceAt;
          console.log(JSON.stringify({ caseId: item.id, iteration, passed: sample.passed, status: sample.missionStatus,
            requestToVerifiedMs: sample.timings.requestToVerifiedMs }));
        }
      } finally { active.current = null; runtime?.workerDaemon?.stop({ reason: 'latency-audit-finished' }); runtime?.coreFacade?.cognition?.close(); }
    }
  } finally {
    const checked = resolve(temporaryRoot);
    if (!checked.startsWith(resolve(tmpdir()) + sep) || !checked.includes('jarvis-mission-latency-')) throw new Error('UNSAFE_BENCHMARK_CLEANUP');
    try { await rm(checked, { recursive: true, force: true }); } catch (error) { cleanupErrors.push({ code: error.code, message: error.message }); }
  }
  const sourcesAfter = await sourceSnapshot();
  const sourceChangedDuringRun = [...new Set([...Object.keys(sourcesBefore), ...Object.keys(sourcesAfter)])].filter(file => sourcesBefore[file] !== sourcesAfter[file]);
  const record = { schemaVersion: 'mission-local-latency-audit-v1', startedAt, observedAt: new Date().toISOString(),
    nodeVersion: process.version, machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model ?? null, logicalCpus: cpus().length },
    fixedCommandCount: CASES.length, iterationsPerCommand: iterations, scheduledRuns: CASES.length * iterations, completedMeasurements: samples.length,
    all: summarize(samples), perCase: Object.fromEntries(CASES.map(item => [item.id, summarize(samples.filter(sample => sample.caseId === item.id))])),
    coldRuntime: summarize(samples.filter(item => item.temperature.startsWith('cold'))), warmRuntime: summarize(samples.filter(item => item.temperature.startsWith('warm'))),
    moduleImportMs, evidencePersistenceMs: rounded(evidencePersistenceMs), cleanupErrors, sourcesBefore, sourcesAfter, sourceChangedDuringRun,
    externalModelCost: null, costStatus: '미측정', configuredExternalModelCalls: 0, liveAccountsTested: 0, liveDevicesTested: 0,
    timingContract: { requestToVerified: 'Mission creation + runMission (A/E/B/G/local typed criteria) + independent output and input-preservation oracle; failed/blocked endpoints included.',
      runtimeToVerified: 'Above plus runtime initialization and owner session setup on cold samples; warm samples reuse runtime.',
      excluded: ['fixture preparation/output reset (reported separately)', 'module import (reported separately)', 'evidence persistence/cleanup', 'process spawn and OS startup', 'UI input acknowledgement'],
      stageDurations: 'Inclusive nested method timings; do not sum stages into total.', percentileMethod: 'nearest rank; failures/blocks stay in all timing distributions when a duration exists',
      coldMeaning: 'Fresh runtime in one process, compiler cache cleared once per fixed case; OS file cache was not flushed. Later samples reuse runtime; actual compiler cache flags are recorded.' },
    limitations: ['Two fixed synthetic objectives repeated; not 40 diverse commands or general natural-language success.',
      'Warm samples have accumulated Mission/audit state; this is measured, not normalized away.',
      'Concurrent development and other host processes may contend for CPU or disk; source hash equality does not exclude contention.',
      'No host-wide network monitor; adapters requested only local work and external model/account configuration is disabled.',
      'UI 200 ms acknowledgement, remote models, real accounts/devices, large files and cold OS boot were not measured.',
      'Hashes identify source versions; they do not independently prove quality or activation.'] };
  record.passed = samples.length === record.scheduledRuns && samples.every(item => item.passed) && sourceChangedDuringRun.length === 0 && cleanupErrors.length === 0;
  await writeEvidence(join(output, 'result.json'), record);
  const table = CASES.map(item => { const data = record.perCase[item.id]; return `| ${item.id} | ${data.completedAndVerified}/${data.attempts} | ${data.requestToVerified.p50Ms} | ${data.requestToVerified.p95Ms} |`; });
  await writeEvidence(join(output, 'report.md'), `# 로컬 Mission 종단 지연 측정\n\n관측: ${record.observedAt}\n\n고정 명령 ${record.fixedCommandCount}종을 각각 ${iterations}회 반복했습니다. 총 ${samples.length}회 중 검증 완료 ${record.all.completedAndVerified}회이며 실패·차단을 분모에서 제외하지 않았습니다.\n\n| 고정 명령 | 검증 완료/시도 | 요청→독립검증 p50 ms | p95 ms |\n|---|---:|---:|---:|\n${table.join('\n')}\n\n전체 요청→검증 p50/p95: ${record.all.requestToVerified.p50Ms}/${record.all.requestToVerified.p95Ms} ms. Runtime 초기화 포함 p50/p95: ${record.all.runtimeToVerified.p50Ms}/${record.all.runtimeToVerified.p95Ms} ms.\n\n첫 runtime ${record.coldRuntime.attempts}회와 재사용 ${record.warmRuntime.attempts}회를 분리 집계했습니다. 준비, module import, 증거 저장, 프로세스 시작, UI 입력 응답은 종단 수치에서 제외했습니다. 단계별 시간은 중첩되므로 합산하지 않습니다. 정확한 정의와 개별 표본은 result.json 및 sample.json에 있습니다.\n\n실계정·실기기 0, 외부 모델 기본 비활성화, 비용 미측정. UI 입력 200 ms는 측정하지 않았습니다.\n\n실행 중 소스 변경: ${sourceChangedDuringRun.length}개. 전체 판정: ${record.passed ? '측정 및 독립 결과 검증 통과' : '실패 또는 비교 조건 미충족'}.\n\n${record.limitations.map(value => `- ${value}`).join('\n')}\n`);
  return { output, passed: record.passed, counts: record.all, sourceChangedDuringRun, observedAt: record.observedAt };
}

function parseArguments(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iterations') options.iterations = Number(args[++i]);
    else if (args[i] === '--output-base') { if (!args[i + 1]) throw new Error('--output-base requires a path'); options.outputBase = resolve(args[++i]); }
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--help')) {
    console.log('node scripts/mission-local-latency-audit.mjs [--iterations 20] [--output-base PATH]\nTwo fixed commands, iterations per command (10-100); default 40 Mission executions. Run after source freeze. All evidence uses a new immutable directory.');
  } else if (process.env.JARVIS_LOCAL_LATENCY_ISOLATED !== '1') {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^JARVIS_/iu.test(key)
      && !/(?:API_KEY|ACCESS_TOKEN|REFRESH_TOKEN|CLIENT_SECRET|SMTP_PASS|AUTH_TOKEN)$/iu.test(key)));
    Object.assign(env, envSettings, { JARVIS_LOCAL_LATENCY_ISOLATED: '1' });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { cwd: ROOT, env, stdio: 'inherit', windowsHide: true });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  } else {
    runMissionLocalLatencyAudit(parseArguments(process.argv.slice(2))).then(result => { console.log(JSON.stringify(result)); if (!result.passed) process.exitCode = 1; })
      .catch(error => { console.error(error.stack ?? error); process.exitCode = 1; });
  }
}
