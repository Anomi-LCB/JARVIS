import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';

const reportPath = resolve(readFlag('--report') ?? 'dist/verification/mission-executive-audit.json');
const markdownPath = reportPath.replace(/\.json$/i, '.md');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = resolve(dirname(reportPath), 'mission-executive-audit-runs', runId);
const workspace = join(runRoot, 'workspace');
const auditRoot = join(runRoot, 'audit');
const mainArtifactPath = join(workspace, 'mission-executive-result.txt');
const gatedArtifactPath = join(workspace, 'mission-gated-result.txt');

await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'input-alpha.txt'), 'alpha evidence', 'utf8');
await writeFile(join(workspace, 'input-beta.txt'), 'beta evidence', 'utf8');

class AuditMissionPlanner {
  async planNextWave(context) {
    const isGateMission = context.mission.objective.includes('개별 승인');
    const latestSuccess = context.observations.filter((observation) => observation.outcome === 'success').at(-1);
    if (isGateMission) {
      if (latestSuccess) return complete(context, latestSuccess.actionId);
      return nextWave([{
        id: 'gated_write',
        title: '개별 승인 파일 작성',
        command: 'mission-gated-result 메모 파일을 만들어줘. 내용은 개별 승인 검증 완료',
        expectedToolName: 'filesystem.createTextFile',
        dependencies: [],
        successSignal: 'mission-gated-result.txt 생성'
      }], '쓰기 승인 게이트를 검증합니다.');
    }
    if (context.mission.waveCount === 0) {
      return nextWave([{
        id: 'route_guard_probe',
        title: '라우팅 일치 보호 검사',
        command: '작업 폴더 파일 목록 보여줘',
        expectedToolName: 'browser.search',
        dependencies: [],
        successSignal: '잘못된 도구 예상이 실행 전에 차단됨'
      }], '도구 환각이 실행되지 않는지 검사합니다.');
    }
    if (context.mission.waveCount === 1) {
      return nextWave([
        {
          id: 'parallel_read_a',
          title: '첫 파일 관찰',
          command: '작업 폴더 파일 목록 보여줘',
          expectedToolName: 'filesystem.listFiles',
          dependencies: [],
          successSignal: '파일 메타데이터 반환'
        },
        {
          id: 'parallel_read_b',
          title: '둘째 파일 관찰',
          command: '작업 폴더의 파일 리스트를 다시 보여줘',
          expectedToolName: 'filesystem.listFiles',
          dependencies: [],
          successSignal: '파일 메타데이터 반환'
        }
      ], '독립 관찰을 병렬로 실행합니다.');
    }
    if (context.mission.waveCount === 2) {
      return nextWave([{
        id: 'verified_write',
        title: '미션 결과 작성',
        command: 'mission-executive-result 메모 파일을 만들어줘. 내용은 장기 목표 실행 검증 완료',
        expectedToolName: 'filesystem.createTextFile',
        dependencies: [],
        successSignal: 'mission-executive-result.txt 생성 및 G 검증 통과'
      }], '관찰 결과를 검증 가능한 산출물로 만듭니다.');
    }
    return complete(context, latestSuccess?.actionId);
  }
}

function nextWave(actions, summary) {
  return { decision: 'continue', summary, actions, criteriaAssessment: [] };
}

function complete(context, actionId) {
  return {
    decision: 'complete',
    summary: '모든 성공 기준에 검증된 실행 증거가 연결됐습니다.',
    actions: [],
    criteriaAssessment: context.mission.successCriteria.map((criterion) => ({
      criterionId: criterion.criterionId,
      status: 'satisfied',
      evidenceActionIds: actionId ? [actionId] : [],
      reason: 'A-G 실행 경로와 산출물 검증을 통과했습니다.'
    }))
  };
}

const runtime = createAgRuntime({
  allowedRoots: [workspace],
  auditRoot,
  cwd: () => workspace,
  env: {},
  missionPlanner: new AuditMissionPlanner(),
  workerDaemonEnabled: false
});

const started = performance.now();
const mainMission = runtime.missionRuntime.createMission({
  objective: '작업 폴더를 다각도로 점검하고 검증된 결과 파일을 완성하라.',
  successCriteria: ['mission-executive-result.txt가 생성되고 G 검증을 통과한다.'],
  authorization: { grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] }
});
const mainResult = await runtime.missionRuntime.runMission(mainMission.missionId);

const gatedMission = runtime.missionRuntime.createMission({
  objective: '개별 승인 후에만 결과 파일을 작성하라.',
  successCriteria: ['mission-gated-result.txt가 생성되고 G 검증을 통과한다.'],
  authorization: { grants: [MissionGrant.READ_ONLY] }
});
const gateWaiting = await runtime.missionRuntime.runMission(gatedMission.missionId);
const fileAbsentBeforeApproval = !(await fileExists(gatedArtifactPath));
const pendingGate = gateWaiting.pendingGates[0] ?? null;
const gateDecision = pendingGate
  ? runtime.missionRuntime.decideGate(gatedMission.missionId, pendingGate.gateId, {
      decision: 'approve',
      decidedBy: 'mission-executive-audit'
    })
  : null;
const gatedResult = pendingGate
  ? await runtime.missionRuntime.runMission(gatedMission.missionId)
  : gateWaiting;

const restored = createAgRuntime({
  allowedRoots: [workspace],
  auditRoot,
  cwd: () => workspace,
  env: {},
  missionPlanner: new AuditMissionPlanner(),
  workerDaemonEnabled: false
});
const restoredMain = restored.missionRuntime.getMission(mainMission.missionId);
const restoredGated = restored.missionRuntime.getMission(gatedMission.missionId);
const capabilities = runtime.missionRuntime.capabilityCatalog();
const mainArtifact = await artifactEvidence(mainArtifactPath);
const gatedArtifact = await artifactEvidence(gatedArtifactPath);
const checks = [
  check('main_mission_verified_complete', mainResult.status === MissionStatus.COMPLETED && mainResult.completion?.status === 'verified'),
  check('route_mismatch_blocked_before_execution', mainResult.metrics.routeMismatches === 1
    && mainResult.observations.some((item) => item.error?.code === 'A_MISSION_ROUTE_MISMATCH')),
  check('failure_replanned_and_recovered', mainResult.metrics.replans >= 2 && mainResult.metrics.successfulActions === 3),
  check('independent_reads_parallelized', mainResult.metrics.parallelBatches >= 1 && mainResult.metrics.maxObservedParallelism >= 2),
  check('named_artifact_verified', mainArtifact.exists && mainResult.completion?.criteria?.[0]?.deterministicChecks
    ?.some((item) => item.checkId === 'named_artifacts_match' && item.passed)),
  check('write_stopped_before_gate', gateWaiting.status === MissionStatus.WAITING_APPROVAL && fileAbsentBeforeApproval),
  check('gate_approval_resumed_to_completion', gateDecision?.status === MissionStatus.PAUSED
    && gatedResult.status === MissionStatus.COMPLETED && gatedArtifact.exists),
  check('mission_state_survives_restart', restoredMain?.status === MissionStatus.COMPLETED && restoredGated?.status === MissionStatus.COMPLETED),
  check('live_capability_catalog_connected', capabilities.length >= 16
    && ['desktop.control', 'shell.execute', 'word.create', 'powerpoint.create', 'hwp.create']
      .every((toolName) => capabilities.some((item) => item.toolName === toolName))),
  check('external_commits_not_exercised', [...mainResult.waves, ...gatedResult.waves]
    .flatMap((wave) => wave.actions)
    .every((action) => action.capabilityProfile?.externalTransfer !== true))
];
const passed = checks.every((item) => item.status === 'passed');
const report = {
  reportVersion: 'a-autonomous-mission-executive-audit-v1',
  generatedAt: new Date().toISOString(),
  status: passed ? 'passed' : 'failed',
  runId,
  scope: {
    dedicatedWorkspaceOnly: true,
    userFilesModified: false,
    deterministicMissionPlanner: true,
    realCoreWorker: true,
    realPolicyRuntime: true,
    realPcAgentAdapters: true,
    realVerificationRuntime: true,
    externalNetworkUsed: false
  },
  summary: {
    checksPassed: checks.filter((item) => item.status === 'passed').length,
    checkCount: checks.length,
    missionCount: 2,
    capabilityCount: capabilities.length,
    waveCount: mainResult.waveCount + gatedResult.waveCount,
    executedActionCount: mainResult.metrics.executedActions + gatedResult.metrics.executedActions,
    recoveredRouteMismatchCount: mainResult.metrics.routeMismatches,
    maxObservedParallelism: mainResult.metrics.maxObservedParallelism,
    decisionGateCount: gatedResult.gates.length,
    durationMs: Number((performance.now() - started).toFixed(3))
  },
  checks,
  missions: {
    main: missionEvidence(mainResult),
    gated: missionEvidence(gatedResult)
  },
  artifacts: [mainArtifact, gatedArtifact],
  persistence: restored.missionRuntime.status().persistence,
  capabilityTools: capabilities.map((item) => item.toolName),
  privacy: {
    rawCapabilityTokensStoredInReport: false,
    rawProviderResponsesStoredInReport: false,
    rawObjectivesStoredInReport: false,
    artifactContentsStoredInReport: false
  }
};

await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
await writeFile(markdownPath, renderMarkdown(report), 'utf8');
process.stdout.write(`${JSON.stringify({
  status: report.status,
  checks: `${report.summary.checksPassed}/${report.summary.checkCount}`,
  missions: report.summary.missionCount,
  waves: report.summary.waveCount,
  actions: report.summary.executedActionCount,
  recoveredRouteMismatches: report.summary.recoveredRouteMismatchCount,
  maxObservedParallelism: report.summary.maxObservedParallelism,
  reportPath,
  markdownPath
}, null, 2)}\n`);
if (!passed) process.exitCode = 1;

function missionEvidence(mission) {
  return {
    missionIdHash: sha256(mission.missionId),
    objectiveHash: sha256(mission.objective),
    status: mission.status,
    stopReason: mission.stopReason,
    waveCount: mission.waveCount,
    metrics: mission.metrics,
    completion: mission.completion,
    gateCount: mission.gates.length,
    observationOutcomes: mission.observations.reduce((counts, item) => ({
      ...counts,
      [item.outcome]: (counts[item.outcome] ?? 0) + 1
    }), {})
  };
}

async function artifactEvidence(path) {
  try {
    const info = await stat(path);
    const body = await readFile(path);
    return {
      name: path.split(/[\\/]/).at(-1),
      exists: true,
      size: info.size,
      sha256: createHash('sha256').update(body).digest('hex'),
      rawContentStored: false
    };
  } catch {
    return {
      name: path.split(/[\\/]/).at(-1),
      exists: false,
      size: null,
      sha256: null,
      rawContentStored: false
    };
  }
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function check(checkId, passed) {
  return { checkId, status: passed ? 'passed' : 'failed' };
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function renderMarkdown(report) {
  return [
    '# JARVIS Mission Executive Audit',
    '',
    `Status: **${report.status}**`,
    `Checks: **${report.summary.checksPassed}/${report.summary.checkCount}**`,
    `Missions: **${report.summary.missionCount}**`,
    `Waves: **${report.summary.waveCount}**`,
    `Executed actions: **${report.summary.executedActionCount}**`,
    `Recovered route mismatches: **${report.summary.recoveredRouteMismatchCount}**`,
    `Maximum observed parallelism: **${report.summary.maxObservedParallelism}**`,
    '',
    '## Checks',
    '',
    '| Check | Status |',
    '| --- | --- |',
    ...report.checks.map((item) => `| ${item.checkId} | ${item.status} |`),
    '',
    '## Boundary',
    '',
    '- This audit proves durable multi-wave planning, guarded execution, recovery, parallel reads, evidence-bound completion, and restart persistence.',
    '- It does not prove unrestricted access to unregistered apps, credentials, external accounts, physical devices, or generic icon-only visual interfaces.',
    ''
  ].join('\n');
}

function readFlag(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
