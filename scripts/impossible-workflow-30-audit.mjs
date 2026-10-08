import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { createAgRuntime } from '../apps/runtime-compose/src/create-runtime.js';
import { MissionGrant, MissionStatus } from '../packages/core/src/mission/mission-runtime.js';
import {
  IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256,
  IMPOSSIBLE_WORKFLOW_30_CORPUS_VERSION,
  createImpossibleWorkflow30CorpusFingerprint,
  impossibleWorkflow30Cases,
  materializeImpossibleCommand
} from './impossible-workflow-30-cases.mjs';
import {
  IMPOSSIBLE_WORKFLOW_30_FIXTURE_SHA256,
  IMPOSSIBLE_WORKFLOW_30_FIXTURE_VERSION,
  createImpossibleWorkflow30ExpectedFixtureManifest,
  materializeImpossibleWorkflow30Fixture
} from './impossible-workflow-30-fixtures.mjs';
import {
  IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256,
  IMPOSSIBLE_WORKFLOW_30_ORACLE_VERSION,
  impossibleWorkflow30OracleContracts,
  verifyImpossibleWorkflow30Case
} from './impossible-workflow-30-oracle.mjs';

export const IMPOSSIBLE_WORKFLOW_30_AUDIT_VERSION = 'jarvis-impossible-workflow-30-product-audit-v2';
export const IMPOSSIBLE_WORKFLOW_30_LEDGER_VERSION = 'jarvis-impossible-workflow-30-ledger-v2';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const IMPLEMENTATION_FILES = Object.freeze([
  'scripts/impossible-workflow-30-audit.mjs',
  'scripts/impossible-workflow-30-cases.mjs',
  'scripts/impossible-workflow-30-fixtures.mjs',
  'scripts/impossible-workflow-30-oracle.mjs',
  'packages/core/src/capabilities/capability-package-registry.js',
  'packages/core/src/mission/workflow-ir.js',
  'packages/core/src/mission/workflow-natural-compiler.js',
  'packages/core/src/mission/mission-planner.js',
  'packages/core/src/mission/mission-runtime.js',
  'packages/core/src/planning/mission-action-arguments.js',
  'packages/core/src/routing/default-skill-manifest.js',
  'apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js',
  'apps/pc-agent/src/pc-agent-runtime.js',
  'apps/runtime-compose/src/workflow-capability-package.js',
  'apps/runtime-compose/src/create-runtime.js',
  'apps/verification/src/verification-runtime.js'
]);
const REQUIRED_CASE_EVIDENCE = Object.freeze([
  'command.txt',
  'mission-result.json',
  'oracle-result.json',
  'audit/executions.jsonl',
  'audit/evidence.jsonl',
  'audit/verification.jsonl',
  'audit/packet-journal.jsonl',
  'audit/missions.json',
  'audit/mission-events.jsonl',
  'audit/core-orchestration.jsonl'
]);

export async function runImpossibleWorkflow30Audit(argv = []) {
  const options = parseArguments(argv);
  const selected = selectCases(options.caseIds);
  const runRoot = resolve(options.root ?? join('artifacts', 'impossible-workflow-30-audit', options.phase, timestamp()));
  if (await exists(runRoot) && !options.resume) {
    const prior = await import('node:fs/promises').then(({ readdir }) => readdir(runRoot));
    if (prior.length) throw new Error(`Audit root already contains files: ${runRoot}. Use --resume or select another --root.`);
  }
  const corpus = createImpossibleWorkflow30CorpusFingerprint(selected);
  const implementationManifest = await createImplementationManifest();
  const commandsText = renderCommands(selected);
  const campaignPayload = {
    auditVersion: IMPOSSIBLE_WORKFLOW_30_AUDIT_VERSION,
    ledgerVersion: IMPOSSIBLE_WORKFLOW_30_LEDGER_VERSION,
    phase: options.phase,
    corpusVersion: IMPOSSIBLE_WORKFLOW_30_CORPUS_VERSION,
    fullCorpusSha256: IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256,
    selectedCorpusSha256: corpus.corpusSha256,
    oracleVersion: IMPOSSIBLE_WORKFLOW_30_ORACLE_VERSION,
    oracleContractsSha256: IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256,
    fixtureVersion: IMPOSSIBLE_WORKFLOW_30_FIXTURE_VERSION,
    fixtureSetSha256: IMPOSSIBLE_WORKFLOW_30_FIXTURE_SHA256,
    implementationManifest,
    commandsSha256: sha256(Buffer.from(commandsText, 'utf8')),
    selectedCaseIds: selected.map((item) => item.id),
    immutableAfterBaseline: true,
    productPath: ['createAgRuntime', 'MissionRuntime.createMission', 'MissionRuntime.runMission', 'CoreFacade.createMissionActionTask', 'CoreOrchestrationWorker.runTask', 'PcAgentRuntime.receiveExecutionPacket', 'VerificationRuntime'],
    prohibitedFallbacks: ['shell.execute'],
    expectedActualToolName: 'workflow.execute',
    externalNetworkAllowed: false,
    generatedAt: new Date().toISOString()
  };
  const proposedCampaign = { ...campaignPayload, campaignSha256: sha256Json(campaignPayload) };
  let campaign;
  if (options.resume) {
    campaign = await readRequiredJson(join(runRoot, 'campaign.json'), 'RESUME_CAMPAIGN_MISSING');
    await validateResumeCampaign({ runRoot, campaign, proposedCampaign, corpus, commandsText });
  } else {
    await mkdir(runRoot, { recursive: true });
    campaign = proposedCampaign;
    await writeJson(join(runRoot, 'campaign.json'), campaign);
    await writeJson(join(runRoot, 'command-corpus.json'), corpus.canonicalPayload);
    await writeJson(join(runRoot, 'oracle-contracts.json'), { version: IMPOSSIBLE_WORKFLOW_30_ORACLE_VERSION, contracts: impossibleWorkflow30OracleContracts });
    await writeFile(join(runRoot, 'commands.md'), commandsText, 'utf8');
  }

  console.log(`IMPOSSIBLE_WORKFLOW_AUDIT_ROOT ${runRoot}`);
  console.log(`PHASE ${options.phase}`);
  console.log(`CORPUS_SHA256 ${corpus.corpusSha256}`);
  console.log(`ORACLE_SHA256 ${IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256}`);

  const results = [];
  let previousHash = 'GENESIS';
  for (const [index, testCase] of selected.entries()) {
    const caseRoot = join(runRoot, 'cases', testCase.id);
    const resultPath = join(caseRoot, 'result.json');
    let result = options.resume ? await readJsonOrNull(resultPath) : null;
    const ledgerPath = join(caseRoot, 'ledger-entry.json');
    let reused = false;
    if (options.resume && result && !await exists(ledgerPath)) {
      await rm(caseRoot, { recursive: true, force: true });
      result = null;
    }
    if (!result) {
      if (options.resume && await exists(ledgerPath)) throw codedError('RESUME_RESULT_MISSING', `${testCase.id} has a ledger without result.json.`);
      if (await exists(caseRoot)) await rm(caseRoot, { recursive: true, force: true });
      await mkdir(caseRoot, { recursive: true });
      console.log(`START ${index + 1}/${selected.length} ${testCase.id} ${testCase.title}`);
      result = await executeProductCase({ testCase, caseRoot, phase: options.phase });
      await writeJson(resultPath, result);
    } else if (options.resume) {
      const existingLedger = await readRequiredJson(ledgerPath, 'RESUME_LEDGER_MISSING');
      await validateResumableCase({ testCase, caseRoot, result, ledger: existingLedger, campaign, sequence: index + 1, previousHash });
      reused = true;
      console.log(`RESUME ${index + 1}/${selected.length} ${testCase.id} ${result.outcome}`);
    }
    const unsignedLedger = {
      ledgerVersion: IMPOSSIBLE_WORKFLOW_30_LEDGER_VERSION,
      campaignSha256: campaign.campaignSha256,
      corpusSha256: campaign.selectedCorpusSha256,
      oracleContractsSha256: campaign.oracleContractsSha256,
      fixtureSetSha256: campaign.fixtureSetSha256,
      implementationManifestSha256: campaign.implementationManifest.manifestSha256,
      sequence: index + 1,
      phase: options.phase,
      caseId: testCase.id,
      commandSha256: result.commandSha256,
      workflowSpecSha256: result.workflowSpecSha256,
      inputManifestSha256: result.inputManifestSha256,
      evidenceManifestSha256: result.evidenceManifestSha256,
      missionResultSha256: result.missionResultSha256,
      oracleResultSha256: result.oracleResultSha256,
      outcome: result.outcome,
      productPass: result.productPass,
      resultSha256: sha256(await readFile(resultPath)),
      previousHash
    };
    const ledger = { ...unsignedLedger, hash: sha256(Buffer.from(stableStringify(unsignedLedger), 'utf8')) };
    previousHash = ledger.hash;
    if (!reused) await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
    results.push(result);
    console.log(`RESULT ${testCase.id} ${result.outcome} ${result.missionStatus ?? 'NO_MISSION'} ${result.durationMs}ms ${result.rootCause?.code ?? ''}`);
    await writeReports(runRoot, campaign, results, previousHash);
  }

  const report = await writeReports(runRoot, campaign, results, previousHash);
  console.log(`FINAL ${report.passed}/${report.total} PASS ${report.failed} FAILED`);
  if ((options.phase === 'final' && report.failed > 0) || report.status === 'BASELINE_CONTAMINATED') process.exitCode = 1;
  return { runRoot, campaign, report, results };
}

async function executeProductCase({ testCase, caseRoot, phase }) {
  const startedAt = new Date().toISOString();
  const timer = performance.now();
  const fixture = await materializeImpossibleWorkflow30Fixture(testCase, caseRoot);
  const command = materializeImpossibleCommand(testCase, caseRoot);
  await writeFile(join(caseRoot, 'command.txt'), `${command}\n`, 'utf8');
  const env = {
    JARVIS_TEST_MODE: '1',
    JARVIS_MISSION_EXECUTIVE: '0',
    JARVIS_LLM_INTENT: '0',
    JARVIS_LLM_PLANNER: '0',
    JARVIS_LLM_CONTENT: '0'
  };
  let runtime = null;
  let mission = null;
  let thrown = null;
  try {
    runtime = createAgRuntime({
      allowedRoots: [caseRoot],
      auditRoot: join(caseRoot, 'audit'),
      cwd: () => caseRoot,
      env,
      taskEnv: env,
      workerDaemonEnabled: false,
      bridgeRealExecution: true,
      workerDefaultTimeoutMs: 45_000,
      missionMaxActionsPerWave: 4,
      missionMaxPlannerTools: 32
    });
    const owner = runtime.personalOwnerSession.activate({ durationMinutes: 30, requestedBy: 'impossible-workflow-30-audit' });
    const created = runtime.missionRuntime.createMission({
      objective: command,
      successCriteria: [
        `${testCase.workflow.outputs[0].path} 파일이 실제 생성된다.`,
        `${testCase.workflow.outputs[1].path} 파일이 실제 생성된다.`
      ],
      constraints: [
        `허용 루트는 ${caseRoot} 하나뿐이다.`,
        '외부 네트워크와 실제 외부 변경을 사용하지 않는다.',
        '워크플로 정의 파일과 inputs 바이트를 수정하지 않는다.'
      ],
      budgets: { maxWaves: 4, maxActions: 8, maxPlannerCalls: 5, maxConsecutiveFailures: 2, maxActiveRuntimeMs: 60_000 },
      authorization: {
        mode: 'trusted_session',
        grants: [MissionGrant.READ_ONLY, MissionGrant.LOCAL_REVERSIBLE, MissionGrant.HIGH_IMPACT],
        ownerSessionId: owner.session.sessionId
      },
      metadata: { auditCaseId: testCase.id, phase, workflowSpecSha256: fixture.files.find((item) => item.path === testCase.specFilename)?.sha256 }
    });
    mission = await runtime.missionRuntime.runMission(created.missionId);
  } catch (error) {
    thrown = { code: error.code ?? 'UNCAUGHT_ERROR', message: error.message, stack: String(error.stack ?? '').split(/\r?\n/u).slice(0, 8) };
  }

  const oracle = await verifyImpossibleWorkflow30Case(testCase.id, caseRoot);
  const oracleResultPath = join(caseRoot, 'oracle-result.json');
  const missionResultPath = join(caseRoot, 'mission-result.json');
  await writeJson(oracleResultPath, oracle);
  if (mission) await writeJson(missionResultPath, mission);
  const actions = mission?.waves?.flatMap((wave) => wave.actions ?? []) ?? [];
  const actualToolNames = actions.map((action) => action.actualToolName).filter(Boolean);
  const expectedToolNames = actions.map((action) => action.expectedToolName).filter(Boolean);
  const executedActions = actions.filter((action) => action.taskId || ['succeeded', 'failed', 'running'].includes(action.status));
  const successfulObservation = mission?.observations?.find((observation) => observation.actionId === executedActions[0]?.actionId) ?? null;
  const toolRoutePass = executedActions.length === 1
    && executedActions[0].taskId
    && executedActions[0].status === 'succeeded'
    && executedActions[0].actualToolName === 'workflow.execute'
    && expectedToolNames.every((name) => name === 'workflow.execute')
    && !actualToolNames.includes('shell.execute');
  const gEvidencePass = toolRoutePass
    && successfulObservation?.taskId === executedActions[0].taskId
    && successfulObservation?.outcome === 'success'
    && successfulObservation?.toolName === 'workflow.execute'
    && successfulObservation?.verification?.status === 'passed'
    && Boolean(successfulObservation?.evidenceId);
  const missionPass = mission?.status === MissionStatus.COMPLETED && mission.completion?.status === 'verified';
  const fixtureIntegrity = await verifyFixtureIntegrity(caseRoot, fixture.files);
  const productPass = missionPass && toolRoutePass && gEvidencePass && oracle.passed && fixtureIntegrity.passed && !thrown;
  const evidenceManifest = await createCaseEvidenceManifest(caseRoot);
  await writeJson(join(caseRoot, 'case-evidence-manifest.json'), evidenceManifest);
  const missionResultSha256 = mission ? sha256(await readFile(missionResultPath)) : null;
  const oracleResultSha256 = sha256(await readFile(oracleResultPath));
  const rootCause = classifyRootCause({ runtime, mission, actions, actualToolNames, oracle, fixtureIntegrity, thrown, productPass });
  return {
    resultVersion: IMPOSSIBLE_WORKFLOW_30_AUDIT_VERSION,
    phase,
    caseId: testCase.id,
    title: testCase.title,
    category: testCase.category,
    command,
    commandSha256: sha256(Buffer.from(`${command}\n`, 'utf8')),
    corpusSha256: IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256,
    oracleContractsSha256: IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256,
    fixtureSetSha256: IMPOSSIBLE_WORKFLOW_30_FIXTURE_SHA256,
    workflowSpecSha256: fixture.files.find((item) => item.path === testCase.specFilename)?.sha256 ?? null,
    inputManifestSha256: fixture.inputManifestSha256,
    evidenceManifestSha256: evidenceManifest.manifestSha256,
    missionResultSha256,
    oracleResultSha256,
    outcome: productPass ? 'SUCCESS' : phase === 'baseline' ? 'BASELINE_UNSUPPORTED' : 'FAILED',
    productPass,
    missionPass,
    toolRoutePass,
    gEvidencePass,
    productPathEvidencePass: missionPass && toolRoutePass && gEvidencePass,
    oraclePass: oracle.passed,
    fixtureIntegrityPass: fixtureIntegrity.passed,
    missionStatus: mission?.status ?? null,
    stopReason: mission?.stopReason ?? null,
    actualToolNames,
    expectedToolNames,
    actionEvidence: actions.map((action) => ({ actionId: action.actionId, taskId: action.taskId ?? null, status: action.status, expectedToolName: action.expectedToolName ?? null, actualToolName: action.actualToolName ?? null, observationId: action.observationId ?? null, error: action.error ?? null })),
    observationEvidence: (mission?.observations ?? []).map((observation) => ({ observationId: observation.observationId, actionId: observation.actionId, outcome: observation.outcome, toolName: observation.toolName, evidenceId: observation.evidenceId, verification: observation.verification, error: observation.error })),
    oracle,
    fixtureIntegrity,
    capabilityPresent: runtime?.missionRuntime?.capabilityCatalog?.().some((item) => item.toolName === 'workflow.execute') === true,
    rootCause,
    solution: solutionFor(rootCause.code),
    thrown,
    startedAt,
    completedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - timer)
  };
}

function classifyRootCause({ runtime, mission, actions, actualToolNames, oracle, fixtureIntegrity, thrown, productPass }) {
  if (productPass) return { code: 'NONE', message: '제품 MissionRuntime 경로와 독립 오라클이 모두 통과했다.' };
  if (thrown) return { code: 'PRODUCT_RUNTIME_EXCEPTION', message: thrown.message };
  const capability = runtime?.missionRuntime?.capabilityCatalog?.().find((item) => item.toolName === 'workflow.execute');
  if (!capability) return { code: 'WORKFLOW_CAPABILITY_NOT_REGISTERED', message: '제품 capability catalog에 workflow.execute가 없다.' };
  if (actualToolNames.includes('shell.execute')) return { code: 'FORBIDDEN_SHELL_DOWNGRADE', message: '워크플로가 shell.execute로 강등됐다.' };
  if (!actions.some((action) => action.actualToolName === 'workflow.execute')) return { code: 'PLANNER_DID_NOT_ROUTE_WORKFLOW', message: '기본 GoalExecutivePlanner가 workflow.execute 액션을 만들지 못했다.' };
  if (actions.some((action) => action.status === 'failed')) {
    const failed = actions.find((action) => action.status === 'failed');
    return { code: failed?.error?.code ?? mission?.observations?.find((item) => item.outcome === 'failed')?.error?.code ?? 'WORKFLOW_EXECUTION_FAILED', message: failed?.error?.message ?? mission?.stopReason ?? 'workflow.execute 액션 실행이 실패했다.' };
  }
  if (!fixtureIntegrity.passed) return { code: 'INPUT_MUTATION_DETECTED', message: '제품 실행 중 고정 workflow/input fixture 바이트가 변경됐다.' };
  if (!oracle.passed) return { code: 'INDEPENDENT_ORACLE_FAILED', message: oracle.checks.filter((item) => !item.passed).map((item) => item.checkId).join(', ') };
  if (mission?.status !== MissionStatus.COMPLETED) return { code: 'MISSION_NOT_VERIFIED_COMPLETE', message: `${mission?.status ?? 'null'}:${mission?.stopReason ?? ''}` };
  return { code: 'TOOL_ROUTE_CONTRACT_FAILED', message: `actual=${actualToolNames.join(',')}` };
}

function solutionFor(code) {
  const map = {
    NONE: '추가 조치 없음. 고정 corpus와 oracle로 회귀 검증을 유지한다.',
    WORKFLOW_CAPABILITY_NOT_REGISTERED: 'SkillRouter와 PcAgentRuntime에 workflow.execute를 원자적으로 등록하고 manifest/argument schema를 연결한다.',
    PLANNER_DID_NOT_ROUTE_WORKFLOW: 'GoalExecutivePlanner가 objective의 .workflow.json 경로를 인식해 typed action을 생성하도록 결정론 컴파일러를 연결한다.',
    FORBIDDEN_SHELL_DOWNGRADE: 'planner route와 Core route guard에서 workflow objective의 shell fallback을 차단한다.',
    INPUT_MUTATION_DETECTED: 'adapter 입력을 읽기 전용으로 고정하고 write path를 outputs 아래로 제한한다.',
    INDEPENDENT_ORACLE_FAILED: '실패한 primitive의 계산 또는 serialization 계약을 수정한 뒤 같은 고정 corpus로 재실행한다.',
    MISSION_NOT_VERIFIED_COMPLETE: 'G 검증 evidence envelope와 deterministic completion binding을 workflow.execute에 추가한다.',
    TOOL_ROUTE_CONTRACT_FAILED: 'workflow.execute 단일 액션 규칙과 actualToolName 보존을 Core/Mission 경계에서 강제한다.',
    PRODUCT_RUNTIME_EXCEPTION: '예외 stack의 최초 제품 경계를 수정하고 오류를 구조화된 mission observation으로 변환한다.'
  };
  return map[code] ?? 'result.json의 actionEvidence와 observationEvidence를 기준으로 해당 primitive와 검증 계약을 수정한다.';
}

async function verifyFixtureIntegrity(root, manifest) {
  const checks = [];
  for (const expected of manifest) {
    try {
      const bytes = await readRegularFileInside(root, expected.path);
      checks.push({ path: expected.path, passed: bytes.length === expected.size && sha256(bytes) === expected.sha256, expectedSha256: expected.sha256, actualSha256: sha256(bytes) });
    } catch (error) {
      checks.push({ path: expected.path, passed: false, expectedSha256: expected.sha256, actualSha256: null, error: error.code ?? error.message });
    }
  }
  return { passed: checks.every((item) => item.passed), checks };
}

async function createImplementationManifest() {
  const files = [];
  for (const relativePath of IMPLEMENTATION_FILES) {
    const bytes = await readFile(resolve(REPOSITORY_ROOT, relativePath));
    files.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
  }
  return { files, manifestSha256: sha256Json(files) };
}

async function createCaseEvidenceManifest(caseRoot) {
  const entries = [];
  for (const path of await walkFiles(caseRoot)) {
    const relativePath = relative(caseRoot, path).replaceAll('\\', '/');
    if (['result.json', 'ledger-entry.json', 'case-evidence-manifest.json'].includes(relativePath)) continue;
    const bytes = await readRegularFileInside(caseRoot, relativePath);
    entries.push({ path: relativePath, size: bytes.length, sha256: sha256(bytes) });
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  const required = [...REQUIRED_CASE_EVIDENCE];
  return {
    manifestVersion: 'jarvis-impossible-workflow-case-evidence-v2',
    required,
    entries,
    manifestSha256: sha256Json({ required, entries })
  };
}

async function validateResumeCampaign({ runRoot, campaign, proposedCampaign, corpus, commandsText }) {
  if (campaign.campaignSha256 !== sha256Json(withoutKey(campaign, 'campaignSha256'))) throw codedError('RESUME_CAMPAIGN_HASH_MISMATCH');
  const invariantKeys = [
    'auditVersion', 'ledgerVersion', 'phase', 'corpusVersion', 'fullCorpusSha256', 'selectedCorpusSha256',
    'oracleVersion', 'oracleContractsSha256', 'fixtureVersion', 'fixtureSetSha256', 'commandsSha256',
    'selectedCaseIds', 'productPath', 'prohibitedFallbacks', 'expectedActualToolName', 'externalNetworkAllowed'
  ];
  for (const key of invariantKeys) {
    if (stableStringify(campaign[key]) !== stableStringify(proposedCampaign[key])) throw codedError('RESUME_CAMPAIGN_IDENTITY_MISMATCH', key);
  }
  if (campaign.implementationManifest?.manifestSha256 !== proposedCampaign.implementationManifest?.manifestSha256) throw codedError('RESUME_IMPLEMENTATION_CHANGED');
  const [storedCorpus, storedOracle, storedCommands] = await Promise.all([
    readRequiredJson(join(runRoot, 'command-corpus.json'), 'RESUME_CORPUS_MISSING'),
    readRequiredJson(join(runRoot, 'oracle-contracts.json'), 'RESUME_ORACLE_MISSING'),
    readFile(join(runRoot, 'commands.md'), 'utf8')
  ]);
  if (sha256Json(storedCorpus) !== corpus.corpusSha256) throw codedError('RESUME_CORPUS_HASH_MISMATCH');
  if (sha256Json(storedOracle) !== IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256) throw codedError('RESUME_ORACLE_HASH_MISMATCH');
  if (storedCommands !== commandsText || sha256(Buffer.from(storedCommands, 'utf8')) !== campaign.commandsSha256) throw codedError('RESUME_COMMANDS_HASH_MISMATCH');
}

async function validateResumableCase({ testCase, caseRoot, result, ledger, campaign, sequence, previousHash }) {
  const expectedCommand = materializeImpossibleCommand(testCase, caseRoot);
  const expectedFixture = createImpossibleWorkflow30ExpectedFixtureManifest(testCase);
  const identity = {
    resultVersion: IMPOSSIBLE_WORKFLOW_30_AUDIT_VERSION,
    phase: campaign.phase,
    caseId: testCase.id,
    title: testCase.title,
    category: testCase.category,
    command: expectedCommand,
    commandSha256: sha256(Buffer.from(`${expectedCommand}\n`, 'utf8')),
    corpusSha256: IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256,
    oracleContractsSha256: IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256,
    fixtureSetSha256: IMPOSSIBLE_WORKFLOW_30_FIXTURE_SHA256,
    inputManifestSha256: expectedFixture.inputManifestSha256,
    workflowSpecSha256: expectedFixture.files.find((item) => item.path === testCase.specFilename)?.sha256
  };
  for (const [key, expected] of Object.entries(identity)) if (stableStringify(result[key]) !== stableStringify(expected)) throw codedError('RESUME_RESULT_IDENTITY_MISMATCH', `${testCase.id}:${key}`);
  const commandBytes = await readRegularFileInside(caseRoot, 'command.txt');
  if (!commandBytes.equals(Buffer.from(`${expectedCommand}\n`, 'utf8')) || sha256(commandBytes) !== result.commandSha256) throw codedError('RESUME_COMMAND_FILE_MISMATCH', testCase.id);
  const fixtureIntegrity = await verifyFixtureIntegrity(caseRoot, expectedFixture.files);
  if (!fixtureIntegrity.passed || result.fixtureIntegrityPass !== true || result.fixtureIntegrity?.passed !== true || result.fixtureIntegrity?.checks?.length !== expectedFixture.files.length) throw codedError('RESUME_FIXTURE_MISMATCH', testCase.id);
  for (const expected of expectedFixture.files) {
    const recorded = result.fixtureIntegrity.checks.find((item) => item.path === expected.path);
    if (!recorded || recorded.passed !== true || recorded.expectedSha256 !== expected.sha256 || recorded.actualSha256 !== expected.sha256) throw codedError('RESUME_FIXTURE_RECORD_MISMATCH', `${testCase.id}:${expected.path}`);
  }
  const [missionBytes, oracleBytes, evidenceManifest] = await Promise.all([
    readFile(join(caseRoot, 'mission-result.json')),
    readFile(join(caseRoot, 'oracle-result.json')),
    readRequiredJson(join(caseRoot, 'case-evidence-manifest.json'), 'RESUME_EVIDENCE_MANIFEST_MISSING')
  ]);
  if (sha256(missionBytes) !== result.missionResultSha256 || sha256(oracleBytes) !== result.oracleResultSha256) throw codedError('RESUME_RESULT_ARTIFACT_HASH_MISMATCH', testCase.id);
  await verifyCaseEvidenceManifest(caseRoot, evidenceManifest, result.evidenceManifestSha256);
  const mission = JSON.parse(missionBytes.toString('utf8'));
  const storedOracle = JSON.parse(oracleBytes.toString('utf8'));
  if (stableStringify(storedOracle) !== stableStringify(result.oracle)) throw codedError('RESUME_ORACLE_ARTIFACT_MISMATCH', testCase.id);
  const directOracle = await verifyImpossibleWorkflow30Case(testCase.id, caseRoot);
  if (directOracle.passed !== result.oraclePass || directOracle.passed !== result.oracle?.passed || !sameOracleDecision(storedOracle, directOracle)) throw codedError('RESUME_ORACLE_RESULT_MISMATCH', testCase.id);
  const missionBinding = await verifyMissionBinding({ caseRoot, testCase, result, mission, command: expectedCommand, directOracle });
  if (!missionBinding.passed) throw codedError('RESUME_PRODUCT_EVIDENCE_MISMATCH', `${testCase.id}:${missionBinding.failures.join(',')}`);
  const resumedActions = mission.waves?.flatMap((wave) => wave.actions ?? []) ?? [];
  const resumedAction = resumedActions[0];
  const resumedObservation = mission.observations?.find((item) => item.actionId === resumedAction?.actionId);
  const derivedMissionPass = mission.status === MissionStatus.COMPLETED && mission.completion?.status === 'verified';
  const derivedToolRoutePass = resumedActions.length === 1 && Boolean(resumedAction?.taskId) && resumedAction?.status === 'succeeded'
    && resumedAction?.expectedToolName === 'workflow.execute' && resumedAction?.actualToolName === 'workflow.execute';
  const derivedGEvidencePass = derivedToolRoutePass && resumedObservation?.taskId === resumedAction.taskId
    && resumedObservation?.outcome === 'success' && resumedObservation?.toolName === 'workflow.execute'
    && resumedObservation?.verification?.status === 'passed' && Boolean(resumedObservation?.evidenceId);
  if (result.missionPass !== derivedMissionPass || result.toolRoutePass !== derivedToolRoutePass || result.gEvidencePass !== derivedGEvidencePass
    || result.productPathEvidencePass !== (derivedMissionPass && derivedToolRoutePass && derivedGEvidencePass)
    || stableStringify(result.actualToolNames) !== stableStringify(resumedActions.map((item) => item.actualToolName).filter(Boolean))
    || stableStringify(result.expectedToolNames) !== stableStringify(resumedActions.map((item) => item.expectedToolName).filter(Boolean))) {
    throw codedError('RESUME_DERIVED_EVIDENCE_MISMATCH', testCase.id);
  }
  const expectedProductPass = result.missionPass === true && result.toolRoutePass === true && result.gEvidencePass === true && directOracle.passed && fixtureIntegrity.passed && !result.thrown;
  if (result.productPass !== expectedProductPass || (result.productPass && result.outcome !== 'SUCCESS')) throw codedError('RESUME_PRODUCT_PASS_MISMATCH', testCase.id);
  const resultBytes = await readFile(join(caseRoot, 'result.json'));
  const expectedLedger = {
    ledgerVersion: IMPOSSIBLE_WORKFLOW_30_LEDGER_VERSION,
    campaignSha256: campaign.campaignSha256,
    corpusSha256: campaign.selectedCorpusSha256,
    oracleContractsSha256: campaign.oracleContractsSha256,
    fixtureSetSha256: campaign.fixtureSetSha256,
    implementationManifestSha256: campaign.implementationManifest.manifestSha256,
    sequence,
    phase: campaign.phase,
    caseId: testCase.id,
    commandSha256: result.commandSha256,
    workflowSpecSha256: result.workflowSpecSha256,
    inputManifestSha256: result.inputManifestSha256,
    evidenceManifestSha256: result.evidenceManifestSha256,
    missionResultSha256: result.missionResultSha256,
    oracleResultSha256: result.oracleResultSha256,
    outcome: result.outcome,
    productPass: result.productPass,
    resultSha256: sha256(resultBytes),
    previousHash
  };
  if (stableStringify(withoutKey(ledger, 'hash')) !== stableStringify(expectedLedger) || ledger.hash !== sha256Json(expectedLedger)) throw codedError('RESUME_LEDGER_MISMATCH', testCase.id);
}

async function verifyCaseEvidenceManifest(caseRoot, manifest, expectedHash) {
  if (manifest.manifestVersion !== 'jarvis-impossible-workflow-case-evidence-v2') throw codedError('EVIDENCE_MANIFEST_VERSION_MISMATCH');
  if (manifest.manifestSha256 !== expectedHash || manifest.manifestSha256 !== sha256Json({ required: manifest.required, entries: manifest.entries })) throw codedError('EVIDENCE_MANIFEST_HASH_MISMATCH');
  if (stableStringify(manifest.required) !== stableStringify(REQUIRED_CASE_EVIDENCE)) throw codedError('EVIDENCE_REQUIRED_SET_MISMATCH');
  const paths = manifest.entries?.map((item) => item.path) ?? [];
  if (!paths.length || new Set(paths).size !== paths.length || stableStringify(paths) !== stableStringify([...paths].sort())) throw codedError('EVIDENCE_ENTRY_SET_INVALID');
  const indexed = new Map(manifest.entries.map((item) => [item.path, item]));
  for (const required of REQUIRED_CASE_EVIDENCE) if (!indexed.has(required)) throw codedError('EVIDENCE_REQUIRED_FILE_MISSING_FROM_MANIFEST', required);
  for (const entry of manifest.entries) {
    const bytes = await readRegularFileInside(caseRoot, entry.path);
    if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) throw codedError('EVIDENCE_FILE_HASH_MISMATCH', entry.path);
  }
  const actual = (await walkFiles(caseRoot)).map((path) => relative(caseRoot, path).replaceAll('\\', '/'))
    .filter((path) => !['result.json', 'ledger-entry.json', 'case-evidence-manifest.json'].includes(path)).sort();
  if (stableStringify(actual) !== stableStringify(paths)) throw codedError('EVIDENCE_MANIFEST_FILE_SET_MISMATCH');
}

async function verifyMissionBinding({ caseRoot, testCase, result, mission, command, directOracle }) {
  const failures = [];
  if (mission.objective !== command) failures.push('objective');
  if (mission.status !== result.missionStatus) failures.push('status');
  if (typeof mission.missionId !== 'string' || !mission.missionId) failures.push('mission-id');
  const actions = mission.waves?.flatMap((wave) => wave.actions ?? []) ?? [];
  const distilledActions = actions.map((action) => ({ actionId: action.actionId, taskId: action.taskId ?? null, status: action.status, expectedToolName: action.expectedToolName ?? null, actualToolName: action.actualToolName ?? null, observationId: action.observationId ?? null, error: action.error ?? null }));
  if (stableStringify(distilledActions) !== stableStringify(result.actionEvidence)) failures.push('actions');
  if (!actions.length || !actions.every((action) => typeof action.taskId === 'string' && action.taskId)) failures.push('task-id');
  const observations = mission.observations ?? [];
  const distilledObservations = observations.map((observation) => ({ observationId: observation.observationId, actionId: observation.actionId, outcome: observation.outcome, toolName: observation.toolName, evidenceId: observation.evidenceId, verification: observation.verification, error: observation.error }));
  if (stableStringify(distilledObservations) !== stableStringify(result.observationEvidence)) failures.push('observations');
  const raw = {};
  for (const relativePath of REQUIRED_CASE_EVIDENCE.filter((path) => path.startsWith('audit/'))) {
    try {
      const bytes = await readRegularFileInside(caseRoot, relativePath);
      if (!bytes.length) failures.push(`audit-empty:${relativePath}`);
      raw[relativePath] = relativePath.endsWith('.jsonl') ? parseJsonl(bytes, relativePath) : JSON.parse(bytes.toString('utf8'));
    } catch (error) { failures.push(`audit-invalid:${relativePath}:${error.code ?? error.message}`); }
  }
  const missionRecord = deepFind(raw['audit/missions.json'], (item) => item?.missionId === mission.missionId);
  if (!missionRecord || missionRecord.objective !== command || missionRecord.status !== mission.status) failures.push('raw-mission');
  const missionEvents = raw['audit/mission-events.jsonl'] ?? [];
  if (!missionEvents.some((event) => event?.missionId === mission.missionId)) failures.push('raw-mission-event');
  for (const action of actions) {
    if (!deepContains(raw['audit/core-orchestration.jsonl'], action.taskId)) failures.push(`raw-core-task:${action.taskId}`);
    if (!deepContains(raw['audit/executions.jsonl'], action.taskId)) failures.push(`raw-execution-task:${action.taskId}`);
    if (!deepContains(raw['audit/packet-journal.jsonl'], action.taskId)) failures.push(`raw-packet-task:${action.taskId}`);
  }
  if (result.productPass) {
    if (actions.length !== 1 || observations.length !== 1 || actions[0].actualToolName !== 'workflow.execute' || actions[0].expectedToolName !== 'workflow.execute' || actions[0].status !== 'succeeded') failures.push('workflow-route');
    const action = actions[0];
    const observation = observations[0];
    if (!observation || observation.actionId !== action?.actionId || observation.taskId !== action?.taskId || observation.toolName !== 'workflow.execute' || observation.outcome !== 'success' || observation.verification?.status !== 'passed' || !observation.evidenceId) failures.push('g-observation');
    if (mission.completion?.status !== 'verified') failures.push('completion');
    const execution = (raw['audit/executions.jsonl'] ?? []).find((item) => item?.taskId === action?.taskId && item?.status === 'COMPLETED' && item?.executionResult?.status === 'success' && item?.executionResult?.executedBy?.toolName === 'workflow.execute');
    if (!execution) failures.push('raw-execution-success');
    const executionEvidence = execution?.executionResult?.evidence?.executionEvidence ?? execution?.executionResult?.executionEvidence;
    if (executionEvidence?.taskId !== action?.taskId || executionEvidence?.evidenceId !== observation?.evidenceId || executionEvidence?.toolName !== 'workflow.execute' || executionEvidence?.status !== 'success') failures.push('raw-execution-evidence');
    const evidence = (raw['audit/evidence.jsonl'] ?? []).find((item) => item?.evidenceId === observation?.evidenceId && item?.taskId === action?.taskId && item?.toolName === 'workflow.execute' && item?.status === 'success');
    if (!evidence || evidence.schemaValidation?.valid !== true) failures.push('raw-g-evidence');
    if (!(raw['audit/verification.jsonl'] ?? []).some((item) => item?.verificationId === observation?.verification?.verificationId && item?.taskId === action?.taskId && item?.status === 'passed')) failures.push('raw-g-verification');
    const packets = (raw['audit/packet-journal.jsonl'] ?? []).filter((item) => item?.taskId === action?.taskId && item?.toolName === 'workflow.execute');
    if (!packets.some((item) => item.recordType === 'packet_received') || !packets.some((item) => item.recordType === 'packet_result' && item.status === 'COMPLETED')) failures.push('raw-packet-lifecycle');
    if (!missionEvents.some((event) => event?.details?.actionId === action?.actionId && event?.details?.taskId === action?.taskId && event?.details?.toolName === 'workflow.execute' && event?.details?.verificationStatus === 'passed')) failures.push('raw-mission-action-event');
    for (const artifact of directOracle?.artifacts ?? []) {
      const rel = relative(caseRoot, artifact.path).replaceAll('\\', '/');
      const gMatch = (evidence?.files ?? []).find((item) => resolve(item.path).toLowerCase() === resolve(artifact.path).toLowerCase());
      const missionMatch = (observation?.artifacts ?? []).find((item) => item.relativePath === rel);
      if (gMatch?.sha256 !== artifact.sha256 || gMatch?.size !== artifact.size) failures.push(`raw-g-output:${rel}`);
      if (missionMatch?.contentSha256 !== artifact.sha256 || missionMatch?.outsideAllowedRoots !== false) failures.push(`mission-output:${rel}`);
    }
  }
  return { passed: failures.length === 0, failures, caseId: testCase.id };
}

function sameOracleDecision(stored, direct) {
  const normalize = (oracle) => ({
    oracleVersion: oracle?.oracleVersion,
    oracleContractsSha256: oracle?.oracleContractsSha256,
    caseId: oracle?.caseId,
    passed: oracle?.passed,
    checks: (oracle?.checks ?? []).map((item) => ({ checkId: item.checkId, passed: item.passed })),
    artifacts: (oracle?.artifacts ?? []).map((item) => ({ path: String(item.path).replaceAll('\\', '/'), size: item.size, sha256: item.sha256 }))
  });
  return stableStringify(normalize(stored)) === stableStringify(normalize(direct));
}

async function readRegularFileInside(root, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)) throw codedError('UNSAFE_RELATIVE_PATH', relativePath);
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relativePath);
  const lexical = relative(absoluteRoot, target);
  if (lexical === '..' || lexical.startsWith(`..\\`) || lexical.startsWith('../') || isAbsolute(lexical)) throw codedError('EVIDENCE_PATH_ESCAPE', relativePath);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw codedError('EVIDENCE_FILE_NOT_REGULAR', relativePath);
  const [rootReal, targetReal] = await Promise.all([realpath(absoluteRoot), realpath(target)]);
  const resolvedRelative = relative(rootReal, targetReal);
  if (resolvedRelative === '..' || resolvedRelative.startsWith(`..\\`) || resolvedRelative.startsWith('../') || isAbsolute(resolvedRelative)) throw codedError('EVIDENCE_REALPATH_ESCAPE', relativePath);
  return readFile(target);
}

function parseJsonl(bytes, path) {
  const lines = bytes.toString('utf8').split(/\r?\n/u).filter((line) => line.trim());
  if (!lines.length) throw codedError('AUDIT_JSONL_EMPTY', path);
  return lines.map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw codedError('AUDIT_JSONL_INVALID', `${path}:${index + 1}:${error.message}`); }
  });
}

function deepFind(value, predicate) {
  if (value && typeof value === 'object' && predicate(value)) return value;
  if (Array.isArray(value)) {
    for (const item of value) { const found = deepFind(item, predicate); if (found) return found; }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) { const found = deepFind(item, predicate); if (found) return found; }
  }
  return null;
}

function deepContains(value, expected) {
  if (value === expected) return true;
  if (Array.isArray(value)) return value.some((item) => deepContains(item, expected));
  if (value && typeof value === 'object') return Object.values(value).some((item) => deepContains(item, expected));
  return false;
}

async function walkFiles(root) {
  const paths = [];
  const queue = [root];
  while (queue.length) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() || entry.isSymbolicLink()) paths.push(path);
    }
  }
  return paths;
}

async function writeReports(runRoot, campaign, results, ledgerHead) {
  const passed = results.filter((item) => item.productPass).length;
  const failed = results.length - passed;
  const report = {
    reportVersion: 'jarvis-impossible-workflow-30-report-v1',
    phase: campaign.phase,
    generatedAt: new Date().toISOString(),
    corpusSha256: campaign.selectedCorpusSha256,
    fullCorpusSha256: campaign.fullCorpusSha256,
    oracleContractsSha256: campaign.oracleContractsSha256,
    frozenContracts: true,
    total: results.length,
    passed,
    failed,
    status: campaign.phase === 'baseline'
      ? passed > 0 ? 'BASELINE_CONTAMINATED' : results.length === campaign.selectedCaseIds.length ? 'BASELINE_CAPTURED' : 'BASELINE_IN_PROGRESS'
      : failed === 0 && results.length === campaign.selectedCaseIds.length ? 'PASSED' : 'FAILED',
    ledgerHead,
    campaignSha256: campaign.campaignSha256,
    implementationManifestSha256: campaign.implementationManifest.manifestSha256,
    fixtureSetSha256: campaign.fixtureSetSha256,
    productPathAttemptRecorded: results.length > 0 && results.every((item) => item.missionResultSha256 && item.evidenceManifestSha256 && item.actionEvidence.length > 0 && item.actionEvidence.some((action) => Boolean(action.taskId))),
    workflowProductPathVerified: campaign.phase === 'final' && results.length > 0 && results.every((item) => item.productPathEvidencePass === true),
    forbiddenShellDowngrades: results.filter((item) => item.actualToolNames.includes('shell.execute')).length,
    rootCauses: countBy(results.filter((item) => !item.productPass), (item) => item.rootCause.code),
    cases: results.map((item) => ({ caseId: item.caseId, title: item.title, category: item.category, outcome: item.outcome, productPass: item.productPass, productPathEvidencePass: item.productPathEvidencePass, missionStatus: item.missionStatus, actualToolNames: item.actualToolNames, oraclePass: item.oraclePass, fixtureIntegrityPass: item.fixtureIntegrityPass, evidenceManifestSha256: item.evidenceManifestSha256, durationMs: item.durationMs, rootCause: item.rootCause, solution: item.solution }))
  };
  await writeJson(join(runRoot, 'report.json'), report);
  await writeFile(join(runRoot, 'report.md'), renderReport(report), 'utf8');
  return report;
}

function renderReport(report) {
  const lines = [
    `# 불가능 명령 30건 제품 경로 감사 — ${report.phase}`,
    '',
    `- 상태: **${report.status}**`,
    `- 실행: ${report.total}건 / 성공 ${report.passed}건 / 실패 ${report.failed}건`,
    `- 명령 corpus SHA-256: \`${report.corpusSha256}\``,
    `- 독립 oracle SHA-256: \`${report.oracleContractsSha256}\``,
    `- 금지된 shell.execute 강등: ${report.forbiddenShellDowngrades}건`,
    '',
    '| ID | 임무 | 결과 | Mission | 실제 도구 | 독립 오라클 | 원인 | 솔루션 |',
    '|---|---|---:|---|---|---:|---|---|'
  ];
  for (const item of report.cases) lines.push(`| ${item.caseId} | ${escapeCell(item.title)} | ${item.productPass ? '성공' : '실패'} | ${item.missionStatus ?? '-'} | ${escapeCell(item.actualToolNames.join(', ') || '-')} | ${item.oraclePass ? '통과' : '실패'} | ${escapeCell(`${item.rootCause.code}: ${item.rootCause.message}`)} | ${escapeCell(item.solution)} |`);
  lines.push('', '## 판정 기준', '', '성공은 실제 `createAgRuntime → MissionRuntime → Core worker → PcAgent → G` 제품 경로에서 단 하나의 `workflow.execute` 액션이 실행되고, 입력 바이트가 보존되며, 별도 고정 오라클이 실제 출력 바이트를 재계산해 통과한 경우에만 인정한다.', '');
  return `${lines.join('\n')}\n`;
}

function renderCommands(items) {
  return `# 고정 불가능 명령 30건\n\n${items.map((item) => `## ${item.id} — ${item.title}\n\n${item.commandTemplate}\n`).join('\n')}`;
}

function parseArguments(argv) {
  const phase = valueAfter(argv, '--phase') ?? 'final';
  if (!['baseline', 'final'].includes(phase)) throw new Error('--phase must be baseline or final.');
  const cases = valueAfter(argv, '--cases');
  return { phase, root: valueAfter(argv, '--root'), caseIds: cases ? cases.split(',').map((item) => item.trim()).filter(Boolean) : [], resume: argv.includes('--resume') };
}

function selectCases(ids) {
  if (!ids.length) return impossibleWorkflow30Cases;
  const selected = ids.map((id) => impossibleWorkflow30Cases.find((item) => item.id === id)).filter(Boolean);
  if (selected.length !== ids.length) throw new Error(`Unknown case id in --cases: ${ids.join(',')}`);
  return selected;
}

function valueAfter(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; }
function timestamp() { return new Date().toISOString().replace(/[:.]/gu, '-'); }
function countBy(items, keyFn) { return items.reduce((counts, item) => { const key = keyFn(item); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}); }
function escapeCell(value) { return String(value).replaceAll('|', '\\|').replace(/\r?\n/gu, ' '); }
function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function sha256Json(value) { return sha256(Buffer.from(stableStringify(value), 'utf8')); }
function withoutKey(value, key) { return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)); }
function codedError(code, detail = '') { const error = new Error(detail ? `${code}:${detail}` : code); error.code = code; return error; }
async function exists(path) { try { await stat(path); return true; } catch { return false; } }
async function readJsonOrNull(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } }
async function readRequiredJson(path, code) { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { throw codedError(code, error.message); } }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await runImpossibleWorkflow30Audit(process.argv.slice(2));
}
