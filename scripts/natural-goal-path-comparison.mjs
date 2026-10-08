import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant } from '../packages/core/src/mission/mission-runtime.js';
import { compileNaturalWorkflowObjective } from '../packages/core/src/mission/natural-workflow-compiler.js';

const SOURCE = '회의는 10월 3일 오전 10시에 시작합니다. 준비물은 인쇄물 12부입니다. 장소는 본당입니다.';
const SUMMARY = '회의는 10월 3일 오전 10시에 본당에서 열리며, 준비물은 인쇄물 12부입니다.';
const OBJECTIVE = "'inputs/meeting.txt'를 읽고 핵심을 요약해 'outputs/meeting-summary.txt'로 저장해줘";
const CASES = [
  { id: 'verified-summary', content: SUMMARY, expectedCompleted: true },
  { id: 'missing-required-preparation', content: '회의는 10월 3일 오전 10시에 본당에서 열립니다.', expectedCompleted: false },
  { id: 'wrong-meeting-time', content: SUMMARY.replace('오전 10시', '오후 2시'), expectedCompleted: false },
  { id: 'typed-unsegmented-summary', content: SUMMARY, expectedCompleted: true,
    objective: "'inputs/meeting.txt' 텍스트를 '원본'으로 읽고 핵심을 요약해 'outputs/meeting-summary.txt' 텍스트로 저장해줘" },
  { id: 'typed-wrong-meeting-time', content: SUMMARY.replace('오전 10시','오후 2시'), expectedCompleted: false,
    objective: "'inputs/meeting.txt' 텍스트를 '원본'으로 읽고 핵심을 요약해 'outputs/meeting-summary.txt' 텍스트로 저장해줘" },
  { id: 'typed-unparsed-extra-demand', content: SUMMARY, expectedCompleted: false, expectedOutputMatches: true,
    objective: "'inputs/meeting.txt' 텍스트를 '원본'으로 읽고 핵심을 요약해 'outputs/meeting-summary.txt' 텍스트로 저장해줘 그리고 결과를 암호화해줘" }
];

export async function runNaturalGoalPathComparison({ repetitions = 3, runtimeFactory = createAgRuntime } = {}) {
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) throw new Error('INVALID_REPETITIONS');
  if (typeof runtimeFactory !== 'function') throw new Error('INVALID_RUNTIME_FACTORY');
  const results = [];
  for (const item of CASES) for (let repetition = 1; repetition <= repetitions; repetition++) {
    const started = performance.now();
    const sampleStartedAt = new Date().toISOString();
    const objective = item.objective ?? OBJECTIVE;
    let root = null, runnerCalls = 0, sourceObserved = false, objectivePreserved = false, sample;
    try {
      root = await mkdtemp(join(tmpdir(), 'jarvis-goal-path-'));
      await mkdir(join(root, 'inputs')); await mkdir(join(root, 'outputs'));
      const sourcePath = join(root, 'inputs/meeting.txt'), outputPath = join(root, 'outputs/meeting-summary.txt');
      await writeFile(sourcePath, SOURCE);
      const missionRunner = async prompt => {
        runnerCalls++;
        objectivePreserved ||= prompt.includes(objective);
        const line = prompt.split('\n').find(value => value.startsWith('실행 관찰: '));
        const observations = line ? JSON.parse(line.slice('실행 관찰: '.length)) : [];
        const contractLine = prompt.split('\n').find(value => value.startsWith('원문 요구사항 계약: '));
        const contract = contractLine ? JSON.parse(contractLine.slice('원문 요구사항 계약: '.length)) : null;
        const read = observations.find(value => value.toolName === 'filesystem.readText');
        const written = observations.find(value => value.toolName === 'filesystem.createTextFile');
        sourceObserved ||= Boolean(read?.evidenceFacts?.stdoutPreview?.includes(SOURCE));
        const action = read ? {
          id: 'write_summary', title: '요약 저장', command: 'meeting-summary.txt 텍스트 파일을 만들어줘',
          expectedToolName: 'filesystem.createTextFile', arguments: { path: outputPath, content: item.content, allowOverwrite: false }
        } : {
          id: 'read_source', title: '원문 읽기', command: 'meeting.txt 내용을 읽어줘',
          expectedToolName: 'filesystem.readText', arguments: { path: sourcePath, maxChars: 12000 }
        };
        const result = { decision: written ? 'complete' : 'continue', summary: '로컬 비교용 계획', question: null, blockedReason: null,
          actions: written ? [] : [{ ...action, dependencies: [],
            requirementIds: contract?.requirements?.filter(value => value.kind !== 'prohibited').map(value => value.requirementId) ?? [],
            successSignal: '파일 상태 검증' }],
          criteriaAssessment: [{ criterionId: 'summary_saved', status: written ? 'satisfied' : 'unsatisfied',
            evidenceActionIds: written ? [written.actionId] : [], reason: '테스트 계획기의 주장; 별도 내용 검증 필요' }] };
        return JSON.stringify({ result: JSON.stringify(result) });
      };
      const env = { JARVIS_TEST_MODE: '1', JARVIS_MISSION_EXECUTIVE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' };
      const runtime = runtimeFactory({ allowedRoots: [root], auditRoot: join(root, 'audit'), env, taskEnv: env, missionRunner, workerDaemonEnabled: false });
      const owner = runtime.personalOwnerSession.activate({ requestedBy: 'local-goal-path-comparison', durationMinutes: 5 });
      const local = compileNaturalWorkflowObjective(objective, { workspaceRoot: root });
      const mission = runtime.missionRuntime.createMission({ objective,
        successCriteria: [{ criterionId: 'summary_saved', statement: '날짜·시간·장소·준비물을 보존한 요약 파일',
          verificationSpec: { version: 1, kind: 'text.equals', path: 'outputs/meeting-summary.txt', equals: SUMMARY } }],
        authorization: { mode: 'trusted_session', ownerSessionId: owner.session.sessionId,
          grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT] } });
      const result = await runtime.missionRuntime.runMission(mission.missionId, { maxWaves: 4 });
      const output = await readFile(outputPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      const completed = result.status === 'COMPLETED';
      const readCount = result.observations.filter(value => value.toolName === 'filesystem.readText').length;
      const writeCount = result.observations.filter(value => value.toolName === 'filesystem.createTextFile').length;
      const oracle = { sourceObserved, objectivePreserved, sourceUnchanged: await readFile(sourcePath, 'utf8') === SOURCE,
        outputMatches: output === SUMMARY, noDuplicateEffects: writeCount === 1, readBeforeWrite: readCount === 1,
        completionMatchesExpected: completed === item.expectedCompleted, noFalseCompletion: !completed || output === SUMMARY };
      sample = { id: item.id, repetition, objective, expectedCompleted: item.expectedCompleted, localCompiler: { status: local.status, code: local.code ?? null },
        missionStatus: result.status, stopReason: result.stopReason ?? null, oracle,
        completionErrors: result.observations.filter(value => value.category === 'completion_guard').map(value => value.error),
        passed: Object.entries(oracle).every(([key, value]) => key === 'outputMatches' ? value === (item.expectedOutputMatches ?? item.expectedCompleted) : value),
        runnerCalls, modelCalls: 0, externalCalls: 0, writeCount, errorCode: null, cleanupErrorCode: null };
    } catch (error) {
      // Never substitute a runtime exception for an expected blocked result.
      // Preserve the scheduled denominator without serializing provider messages.
      sample = { id: item.id, repetition, objective, expectedCompleted: item.expectedCompleted,
        missionStatus: 'ERROR', passed: false, oracle: null, runnerCalls,
        modelCalls: 0, externalCalls: 0, writeCount: null,
        errorCode: safeErrorCode(error), cleanupErrorCode: null };
    } finally {
      if (root) {
        try { await rm(root, { recursive: true, force: true }); }
        catch (error) { sample.passed = false; sample.cleanupErrorCode = safeErrorCode(error); }
      }
    }
    sample.sampleStartedAt = sampleStartedAt;
    sample.sampleFinishedAt = new Date().toISOString();
    sample.latencyMs = Number((performance.now() - started).toFixed(3));
    results.push(sample);
  }
  const times = results.map(value => value.latencyMs).sort((a, b) => a - b);
  return { version: 'natural-goal-path-comparison-v2', observedAt: new Date().toISOString(),
    scope: 'synthetic-planner-real-local-ag-execution', productionActivation: false, repetitions,
    passed: results.every(value => value.passed), scheduledRuns: CASES.length * repetitions, runs: results.length,
    errorRuns: results.filter(value => value.errorCode || value.cleanupErrorCode).length,
    failedIds: [...new Set(results.filter(value => !value.passed).map(value => value.id))],
    completed: results.filter(value => value.missionStatus === 'COMPLETED').length,
    expectedNonCompletion: results.filter(value => !value.expectedCompleted && value.missionStatus !== 'COMPLETED' && value.missionStatus !== 'ERROR').length,
    p50LatencyMs: times[Math.ceil(times.length * .5) - 1], p95LatencyMs: times[Math.ceil(times.length * .95) - 1],
    modelCalls: 0, externalCalls: 0, actualCost: null, costStatus: 'unmeasured-local-resource-cost', results };
}

function safeErrorCode(error) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code)
    ? error.code : 'COMPARISON_SAMPLE_ERROR';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--output' || args[1].startsWith('-')) throw new Error('Usage: node scripts/natural-goal-path-comparison.mjs --output artifacts/report.json');
    const report = await runNaturalGoalPathComparison();
    const destination = resolve(args[1]); await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ output: destination, passed: report.passed, runs: report.runs, completed: report.completed, expectedNonCompletion: report.expectedNonCompletion }));
    if (!report.passed) process.exitCode = 1;
  } catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1; }
}
