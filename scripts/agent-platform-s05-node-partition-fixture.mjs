import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { FileMissionStore } from '../packages/core/src/mission/mission-store.js';
import { MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';

const [phase, fixtureRootArg, evidencePathArg] = process.argv.slice(2);
if (!['node-phase', 'pc-resume'].includes(phase) || !fixtureRootArg) {
  throw new Error('usage: node scripts/agent-platform-s05-node-partition-fixture.mjs node-phase|pc-resume <fixture-root> [evidence.json]');
}

const fixtureRoot = resolve(fixtureRootArg);
const nodeWorkspace = join(fixtureRoot, 'always-on-node');
const pcWorkspace = join(fixtureRoot, 'user-pc');
const nodeOutput = join(nodeWorkspace, 'public-research.txt');
const pcOutput = join(pcWorkspace, 'summary.txt');
const missionStorePath = join(fixtureRoot, 'missions.json');
const phaseStatePath = join(fixtureRoot, 'phase-state.json');
const publicResearch = 'Synthetic public research result: source checked and summarized.';
const finalSummary = 'Synthetic public research result: source checked and summarized.\nVerified on the user PC after reconnection.';
const permissionRevision = 'fixture-permissions-v1';
const bindingFor = deviceRef => ({ capabilityId: 'workflow.execute', providerId: 's05-isolated-node-fixture',
  accountRef: 'fixture-owner', deviceRef, scopes: ['fixture.file.write'] });
let summaryRequirementId = null;

await mkdir(nodeWorkspace, { recursive: true });
await mkdir(pcWorkspace, { recursive: true });

const planner = { async planNextWave(context) {
  summaryRequirementId ??= context.mission?.goalContract?.requirements?.[0]?.requirementId ?? null;
  const successful = context.observations.filter(item => item.outcome === 'success');
  const publishedNames = new Set(successful.flatMap(item => item.artifacts ?? []).map(item => item.relativePath));
  if (!publishedNames.has('public-research.txt')) {
    return { decision: 'continue', summary: '상시 노드에서 공개 자료 조사', actions: [{ id: 'public-research',
      title: '공개 자료 조사', command: '공개 자료를 읽고 핵심을 파일로 저장해줘.', expectedToolName: 'filesystem.createTextFile',
      arguments: { path: nodeOutput, content: publicResearch }, dependencies: [], successSignal: '공개 자료 요약을 상시 노드에 저장' }], criteriaAssessment: [] };
  }
  if (!publishedNames.has('summary.txt')) {
    return { decision: 'continue', summary: 'PC 재연결 뒤 파일 생성', actions: [{ id: 'pc-summary',
      title: '사용자 PC 파일 생성', command: 'PC가 연결되면 최신 권한을 확인하고 요약 파일을 만들어줘.',
      expectedToolName: 'filesystem.createTextFile', arguments: { path: pcOutput, content: finalSummary },
      dependencies: [], ...(summaryRequirementId ? { requirementIds: [summaryRequirementId] } : {}),
      successSignal: 'PC 요약 파일을 만들고 다시 읽어 검증' }], criteriaAssessment: [] };
  }
  return { decision: 'complete', summary: '상시 노드 조사와 PC 복귀 후 파일 검증을 마쳤습니다.', actions: [],
    criteriaAssessment: context.mission.successCriteria.map(criterion => ({ criterionId: criterion.criterionId,
      status: 'satisfied', evidenceActionIds: successful.map(item => item.actionId),
      reason: '상시 노드와 PC의 실제 Mission action 및 G 검증 evidence가 보존됐습니다.' })) };
} };

let runtime;
const workspace = phase === 'node-phase' ? nodeWorkspace : pcWorkspace;
const isPcOnline = phase === 'pc-resume';
const now = () => new Date();
// The natural-language goal binds a bare output filename to allowedRoots[0].
// Keep the PC workspace first so the goal contract and physical fixture target agree
// while both processes still share the same immutable root set.
runtime = createAgRuntime({ allowedRoots: [pcWorkspace, nodeWorkspace], auditRoot: join(fixtureRoot, `audit-${phase}`), cwd: () => workspace,
  env: { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' },
  taskEnv: { JARVIS_TEST_MODE: '1', JARVIS_LLM_INTENT: '0', JARVIS_LLM_PLANNER: '0', JARVIS_LLM_CONTENT: '0' },
  missionPlanner: planner, workerDaemonEnabled: false, missionStore: new FileMissionStore({ filePath: missionStorePath, clock: now }),
  capabilityBindingResolver: ({ toolName, action }) => {
    if (toolName !== 'filesystem.createTextFile') return { required: false };
    const path = resolve(action.arguments?.path ?? '');
    const deviceRef = path === resolve(nodeOutput) ? 'always-on-node' : path === resolve(pcOutput) ? 'user-pc' : null;
    return deviceRef ? { required: true, binding: bindingFor(deviceRef), permissionRevision }
      : { required: true, binding: { ...bindingFor('unknown-device'), deviceRef: 'unknown-device' }, permissionRevision };
  },
  capabilityAvailabilityProbe: async ({ binding }) => availabilityObservation(runtime, binding,
    binding.deviceRef === 'always-on-node' ? phase === 'node-phase' : isPcOnline, now().toISOString())
});

function availabilityObservation(targetRuntime, binding, online, observedAt) {
  const codeVersion = targetRuntime.capabilityPackageRegistry.availabilityFor(binding).codeVersion;
  return { ...binding, codeVersion, permissionRevision, observedAt,
    accountStatus: 'connected', observedAccountRef: binding.accountRef,
    deviceStatus: online ? 'online' : 'offline', observedDeviceRef: binding.deviceRef,
    grantedScopes: binding.scopes, verificationLevel: 'live-probe', evidenceRef: `synthetic-s05-${phase}-probe` };
}

try {
  const bindings = [bindingFor('always-on-node'), bindingFor('user-pc')];
  for (const binding of bindings) {
    runtime.capabilityPackageRegistry.recordAvailability(availabilityObservation(runtime, binding,
      binding.deviceRef === 'always-on-node' ? phase === 'node-phase' : isPcOnline, now().toISOString()));
  }

  let missionId;
  if (phase === 'node-phase') {
    const created = runtime.missionRuntime.createMission({ objective: "'summary.txt'를 저장해",
      successCriteria: [{ statement: "'summary.txt'를 저장해", verificationSpec: { version: 1, kind: 'text.equals',
        path: pcOutput, equals: finalSummary } }],
      authorization: { mode: 'supervised', grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE] },
      budgets: { waves: 4, actions: 4, plannerCalls: 6, activeRuntimeMs: 30_000 },
      metadata: { scenarioId: 'S05', fixture: 'isolated-two-runtime-environment-partition' } });
    missionId = created.missionId;
    summaryRequirementId = runtime.missionRuntime.missions.get(missionId)?.goalContract?.requirements?.[0]?.requirementId ?? null;
    if (!summaryRequirementId) throw new Error('S05 success requirement was not captured by the Mission goal contract.');
    let executed = 0;
    const runTask = runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
    runtime.orchestrationWorker.runTask = async (...args) => { executed += 1; return runTask(...args); };
    let result;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      result = await runtime.missionRuntime.runMission(missionId);
      if (result.status !== MissionStatus.PAUSED || result.lastError?.reasons?.some(item => item.code === 'device-offline')) break;
    }
    const nodeBytes = await readFile(nodeOutput);
    let pcFileCreated = false;
    try { await access(pcOutput); pcFileCreated = true; } catch { /* expected while the PC is offline */ }
    const current = result.waves.flatMap(wave => wave.actions);
    if (result.status !== MissionStatus.PAUSED || result.metrics.executedActions !== 1 || executed !== 1
      || !current.some(action => action.title === '공개 자료 조사' && action.status === 'succeeded')
      || !current.some(action => action.title === '사용자 PC 파일 생성' && action.status === 'planned' && action.attempts === 0)
      || !result.lastError?.reasons?.some(item => item.code === 'device-offline') || pcFileCreated) {
      throw new Error(`node/offline-PC phase invariant failed: ${JSON.stringify({ status: result.status, metrics: result.metrics,
        actions: current.map(action => ({ actionId: action.actionId, status: action.status, attempts: action.attempts })),
        lastError: result.lastError, executed })}`);
    }
    await writeFile(phaseStatePath, `${JSON.stringify({ missionId, nodePid: process.pid, nodeStatus: result.status,
      nodeActionExecutions: executed, nodeArtifactSha256: createHash('sha256').update(nodeBytes).digest('hex'),
      pcWasOffline: true, pcFileCreated,
      blockedActionAttemptCount: current.find(action => action.title === '사용자 PC 파일 생성')?.attempts ?? null }, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ phase, pid: process.pid, missionId, status: result.status, nodeActionExecutions: executed,
      pcFileCreated: false, stopReason: result.lastError?.reasons?.map(item => item.code) ?? [] }));
  } else {
    if (!evidencePathArg) throw new Error('pc-resume phase requires evidence output path');
    const phaseState = JSON.parse(await readFile(phaseStatePath, 'utf8'));
    missionId = phaseState.missionId;
    const before = runtime.missionRuntime.getMission(missionId);
    if (!before || before.status !== MissionStatus.PAUSED) throw new Error(`persisted Mission unavailable before PC resume: ${before?.status}`);
    let pcExecutions = 0;
    const runTask = runtime.orchestrationWorker.runTask.bind(runtime.orchestrationWorker);
    runtime.orchestrationWorker.runTask = async (...args) => { pcExecutions += 1; return runTask(...args); };
    let result;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      result = await runtime.missionRuntime.runMission(missionId);
      if (result.status !== MissionStatus.PAUSED) break;
    }
    if (result.status !== MissionStatus.COMPLETED || result.completion?.status !== 'verified' || pcExecutions !== 1) {
      throw new Error(`PC resume did not complete exactly one local action: ${JSON.stringify({ status: result.status,
        completion: result.completion?.status, pcExecutions, lastError: result.lastError })}`);
    }
    const nodeBytes = await readFile(nodeOutput);
    const pcBytes = await readFile(pcOutput);
    const actionList = result.waves.flatMap(wave => wave.actions);
    const actionMap = new Map([
      ['public-research', actionList.find(action => action.title === '공개 자료 조사')],
      ['pc-summary', actionList.find(action => action.title === '사용자 PC 파일 생성')]
    ]);
    const observationMap = new Map(result.observations.map(observation => [observation.actionId, observation]));
    const capture = { schemaVersion: 1, scenarioId: 'S05', fixtureId: 's05-two-runtime-node-pc-offline-rejoin-v1',
      expected: { nodeAction: 'public-research', pcAction: 'pc-summary', finalText: finalSummary },
      processBoundary: { separateProductProcesses: true, nodeProcessPid: phaseState.nodePid, pcResumeProcessPid: process.pid,
        processRestartBetweenPhases: true, nodeProcessStoppedBeforePcResume: true },
      phases: { node: { missionStatusAfterRun: phaseState.nodeStatus, pcWasOffline: phaseState.pcWasOffline,
        pcFileCreated: phaseState.pcFileCreated,
        executedActions: phaseState.nodeActionExecutions, blockedActionAttemptCount: phaseState.blockedActionAttemptCount,
        blockedReason: before.lastError?.reasons?.map(item => item.code) ?? [] },
        pcResume: { missionStatus: result.status, completionStatus: result.completion.status, pcOnlineProbe: true,
          pcActionExecutions: pcExecutions } },
      actions: Object.fromEntries([['publicResearch', actionMap.get('public-research')], ['pcSummary', actionMap.get('pc-summary')]
        ].map(([id, action]) => [id, { actionId: action?.actionId ?? null,
          status: action?.status ?? null, attempts: action?.attempts ?? null,
          taskId: action?.taskId ?? null, observationId: action?.observationId ?? null,
          verificationStatus: observationMap.get(action?.actionId)?.verification?.status
            ?? observationMap.get(action?.actionId)?.verificationStatus ?? null,
          outcome: observationMap.get(action?.actionId)?.outcome ?? null }])),
      artifacts: { node: { relativePath: 'always-on-node/public-research.txt', text: nodeBytes.toString('utf8'),
        byteLength: nodeBytes.length, sha256: createHash('sha256').update(nodeBytes).digest('hex') },
        pc: { relativePath: 'user-pc/summary.txt', text: pcBytes.toString('utf8'), byteLength: pcBytes.length,
          sha256: createHash('sha256').update(pcBytes).digest('hex') } },
      sideEffects: { providerCalls: 0, networkRequests: 0, externalWrites: 0, syntheticAvailabilityProbes: true },
      mission: { missionId, status: result.status, completionStatus: result.completion.status,
        criteria: result.successCriteria.map(item => ({ statement: item.statement, status: item.status ?? null })) },
      limitations: { sharedHostFilesystem: true, physicalCrossDeviceDeploymentVerified: false,
        remoteServiceIdentityVerified: false } };
    await writeFile(evidencePathArg, `${JSON.stringify(capture, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    console.log(JSON.stringify({ phase, pid: process.pid, missionId, status: result.status, pcActionExecutions: pcExecutions,
      nodeHash: capture.artifacts.node.sha256, pcHash: capture.artifacts.pc.sha256 }));
  }
} finally {
  runtime.workerDaemon?.stop?.({ reason: `s05-${phase}-complete` });
  runtime.coreFacade.cognition?.close?.();
}
