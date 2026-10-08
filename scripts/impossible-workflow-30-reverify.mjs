import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256,
  createImpossibleWorkflow30CorpusFingerprint,
  impossibleWorkflow30Cases,
  materializeImpossibleCommand
} from './impossible-workflow-30-cases.mjs';
import {
  IMPOSSIBLE_WORKFLOW_30_FIXTURE_SHA256,
  createImpossibleWorkflow30ExpectedFixtureManifest,
  materializeImpossibleWorkflow30Fixture
} from './impossible-workflow-30-fixtures.mjs';
import {
  IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256,
  impossibleWorkflow30OracleContracts,
  verifyImpossibleWorkflow30Case
} from './impossible-workflow-30-oracle.mjs';

export const IMPOSSIBLE_WORKFLOW_30_REVERIFY_VERSION = 'jarvis-impossible-workflow-30-independent-reverify-v2';
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const AUDIT_V1 = 'jarvis-impossible-workflow-30-product-audit-v1';
const AUDIT_V2 = 'jarvis-impossible-workflow-30-product-audit-v2';
const LEDGER_V2 = 'jarvis-impossible-workflow-30-ledger-v2';
const EVIDENCE_V2 = 'jarvis-impossible-workflow-case-evidence-v2';
const REQUIRED_RAW_AUDIT_FILES = Object.freeze([
  'audit/missions.json',
  'audit/mission-events.jsonl',
  'audit/core-orchestration.jsonl',
  'audit/executions.jsonl',
  'audit/evidence.jsonl',
  'audit/verification.jsonl',
  'audit/packet-journal.jsonl'
]);
const EXPECTED_EVIDENCE_REQUIRED = Object.freeze([
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
const EXECUTION_IMPLEMENTATION_FILES = Object.freeze([
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
const IMPLEMENTATION_ROLES = Object.freeze({
  'scripts/impossible-workflow-30-audit.mjs': 'campaign-runner-and-ledger',
  'scripts/impossible-workflow-30-cases.mjs': 'frozen-command-corpus',
  'scripts/impossible-workflow-30-fixtures.mjs': 'frozen-fixture-generator',
  'scripts/impossible-workflow-30-oracle.mjs': 'independent-byte-oracle',
  'scripts/impossible-workflow-30-reverify.mjs': 'evidence-reverifier-and-negative-suite',
  'packages/core/src/capabilities/capability-package-registry.js': 'atomic-capability-package-registry',
  'packages/core/src/mission/workflow-ir.js': 'typed-workflow-ir',
  'packages/core/src/mission/workflow-natural-compiler.js': 'natural-language-workflow-compiler',
  'packages/core/src/mission/mission-planner.js': 'goal-executive-planner',
  'packages/core/src/mission/mission-runtime.js': 'mission-completion-binding',
  'packages/core/src/planning/mission-action-arguments.js': 'mission-argument-boundary',
  'packages/core/src/routing/default-skill-manifest.js': 'skill-manifest',
  'apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js': 'safe-local-workflow-adapter',
  'apps/pc-agent/src/pc-agent-runtime.js': 'pc-agent-registration',
  'apps/runtime-compose/src/workflow-capability-package.js': 'capability-package-composition',
  'apps/runtime-compose/src/create-runtime.js': 'runtime-composition',
  'apps/verification/src/verification-runtime.js': 'declarative-evidence-schema'
});
const STRUCTURAL_CHANGES = Object.freeze([
  { id: 'S1', title: '원자적 capability package 등록', behavior: 'skill route, PC adapter, G evidence schema를 하나의 활성화 단위로 검사하고 일부만 등록된 상태를 실패 폐쇄한다.', files: ['packages/core/src/capabilities/capability-package-registry.js', 'apps/runtime-compose/src/workflow-capability-package.js', 'apps/runtime-compose/src/create-runtime.js'] },
  { id: 'S2', title: '검증된 typed Workflow IR', behavior: 'DAG, node id, allowlist operation, 의존성, typed JSON Pointer 참조, 조건과 재시도를 실행 전 검증한다.', files: ['packages/core/src/mission/workflow-ir.js'] },
  { id: 'S3', title: '자연어에서 workflow.execute로 결정론 라우팅', behavior: 'objective의 .workflow.json 경로를 추출하고 단일 trusted mission action으로 컴파일하며 shell.execute 강등을 막는다.', files: ['packages/core/src/mission/workflow-natural-compiler.js', 'packages/core/src/mission/mission-planner.js', 'packages/core/src/planning/mission-action-arguments.js'] },
  { id: 'S4', title: '안전한 로컬 workflow 실행기', behavior: 'allowlist primitive를 staging에서 실행하고 경로 경계, 심볼릭 링크, 바이트, 노드, 프로세스 제한을 적용한 뒤 원자 게시한다.', files: ['apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js', 'apps/pc-agent/src/pc-agent-runtime.js'] },
  { id: 'S5', title: '구조화 데이터·그래프·최적화·파일·프로세스·SQLite primitive', behavior: 'CSV/JSON, exact decimal, graph, scheduling, deep filesystem, allowlisted Node subprocess, transactional SQLite를 같은 IR에서 조합한다.', files: ['apps/pc-agent/src/adapters/workflow/local-workflow-adapter.js'] },
  { id: 'S6', title: 'G evidence와 Mission 완료 결합', behavior: 'workflow manifest, output hash, actualToolName을 G가 검증하고 Mission 기준을 실제 workflow.execute 관찰에 연결한다.', files: ['apps/verification/src/verification-runtime.js', 'packages/core/src/mission/mission-runtime.js'] },
  { id: 'S7', title: '외부 출처 판정 경계 보정', behavior: 'resource 같은 단어 내부의 source 문자열을 live web provenance 요구로 오인하지 않도록 영문 단어 경계를 적용한다.', files: ['packages/core/src/mission/mission-runtime.js'] },
  { id: 'S8', title: '실행 증거 체인 실패 폐쇄', behavior: '명령·spec·fixture·제품 소스·Mission 원본·G 원장·독립 oracle·결과·순차 ledger를 해시로 결속하고 누락, 재개 오염, 재해시 위조를 거부한다.', files: ['scripts/impossible-workflow-30-audit.mjs', 'scripts/impossible-workflow-30-reverify.mjs'] }
]);

export async function runImpossibleWorkflow30Reverify(argv = []) {
  const options = parseArguments(argv);
  const baselineRoot = resolve(options.baselineRoot);
  const finalRoot = resolve(options.finalRoot);
  const outputRoot = resolve(options.outputRoot ?? join('artifacts', 'impossible-workflow-30-audit', 'integrated-report-v2'));
  await mkdir(outputRoot, { recursive: true });
  const [baselineCampaign, baselineReport, finalCampaign, finalReport] = await Promise.all([
    readJson(join(baselineRoot, 'campaign.json')),
    readJson(join(baselineRoot, 'report.json')),
    readJson(join(finalRoot, 'campaign.json')),
    readJson(join(finalRoot, 'report.json'))
  ]);
  const frozenChecks = await verifyFrozenContracts({ baselineRoot, finalRoot, baselineCampaign, finalCampaign });
  const finalImplementationBinding = await verifyExecutionImplementationBinding(finalCampaign);
  const baselineEvidence = await verifyCampaignEvidence(baselineRoot, { phase: 'baseline', campaign: baselineCampaign, report: baselineReport });
  const finalEvidence = await verifyCampaignEvidence(finalRoot, { phase: 'final', campaign: finalCampaign, report: finalReport });
  let tamperNegative;
  try {
    tamperNegative = await runTamperNegative({ finalRoot, outputRoot, finalCampaign });
  } catch (error) {
    tamperNegative = { passed: false, error: normalizeError(error), checks: [] };
  }
  const implementationManifest = await createImplementationManifest();
  const comparison = compareCampaigns(baselineEvidence, finalEvidence);
  const gates = [
    gate('frozen_command_corpus_match', frozenChecks.commandCorpusMatch, frozenChecks),
    gate('frozen_oracle_contracts_match', frozenChecks.oracleContractsMatch, frozenChecks),
    gate('frozen_commands_file_match', frozenChecks.commandsFileMatch, frozenChecks),
    gate('same_30_case_ids', comparison.sameCaseIds && comparison.total === 30, comparison),
    gate('baseline_records_30_unsupported', comparison.baselinePassed === 0 && comparison.baselineFailed === 30 && baselineEvidence.valid, baselineEvidence.summary),
    gate('baseline_root_cause_30_capability_missing', baselineEvidence.rootCauses.WORKFLOW_CAPABILITY_NOT_REGISTERED === 30, baselineEvidence.rootCauses),
    gate('final_records_30_success', comparison.finalPassed === 30 && comparison.finalFailed === 0 && finalEvidence.valid, finalEvidence.summary),
    gate('final_execution_source_snapshot_bound', finalImplementationBinding.passed, finalImplementationBinding),
    gate('actual_tool_is_workflow_execute_only', finalEvidence.cases.every((item) => item.routePassed), finalEvidence.cases.filter((item) => !item.routePassed).map(compactCaseFailure)),
    gate('mission_and_raw_g_evidence_30_of_30', finalEvidence.rawProductEvidencePassed === 30, { passed: finalEvidence.rawProductEvidencePassed, total: 30 }),
    gate('independent_oracle_reverification_30_of_30', finalEvidence.oraclePassed === 30, { oraclePassed: finalEvidence.oraclePassed, total: 30 }),
    gate('input_fixture_integrity_30_of_30', finalEvidence.fixturePassed === 30, { fixturePassed: finalEvidence.fixturePassed, total: 30 }),
    gate('case_evidence_manifests_30_of_30', finalEvidence.evidenceManifestPassed === 30, { passed: finalEvidence.evidenceManifestPassed, total: 30 }),
    gate('stored_reports_match_recomputed_evidence', baselineEvidence.reportValid && finalEvidence.reportValid, { baseline: baselineEvidence.reportErrors, final: finalEvidence.reportErrors }),
    gate('ledger_hash_chains_valid', baselineEvidence.ledgerValid && finalEvidence.ledgerValid, { baseline: baselineEvidence.ledgerValid, final: finalEvidence.ledgerValid }),
    gate('tamper_negative_detection', tamperNegative.passed, tamperNegative.summary ?? tamperNegative)
  ];
  const passed = gates.every((item) => item.passed);
  const report = {
    reportVersion: 'jarvis-impossible-workflow-30-integrated-report-v2',
    reverifyVersion: IMPOSSIBLE_WORKFLOW_30_REVERIFY_VERSION,
    generatedAt: new Date().toISOString(), status: passed ? 'PASSED' : 'FAILED',
    scope: {
      frozenNaturalLanguageCommands: 30,
      verifiedExecutionPath: 'createAgRuntime → MissionRuntime → Core worker → PcAgent → G',
      productPathVerifiedByMissionAndRawJournals: finalEvidence.rawProductEvidencePassed === 30,
      selfContainedScenarioEngineUsed: false,
      campaignSpecsPermitExternalNetwork: false,
      externalNetworkTrafficInstrumentedByThisCampaign: false,
      shellFallbackAllowed: false,
      independentOutputByteOracle: true,
      guaranteeBoundary: '고정된 로컬 bounded workflow 30건과 캡처된 실행 환경'
    },
    frozenEvidence: {
      corpusSha256: IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256,
      oracleContractsSha256: IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256,
      fixtureSetSha256: IMPOSSIBLE_WORKFLOW_30_FIXTURE_SHA256,
      baselineRoot, finalRoot,
      baselineLedgerHead: baselineEvidence.ledgerHead,
      finalLedgerHead: finalEvidence.ledgerHead,
      baselineEvidenceTreeSha256: baselineEvidence.evidenceTreeSha256,
      baselineLedgerBinding: 'legacy-v1-result-chain-plus-retrospective-raw-evidence-snapshot',
      finalLedgerBinding: 'v2-command-spec-fixture-source-mission-g-oracle-result-chain'
    },
    beforeAfter: comparison,
    structuralChanges: STRUCTURAL_CHANGES,
    implementationManifest,
    executionImplementationBinding: finalImplementationBinding,
    gates, tamperNegative, cases: comparison.cases,
    conclusion: passed
      ? '고정된 30개 명령은 baseline에서 30건 모두 workflow capability 부재로 실패했고, 구조 개선 후 동일 corpus와 동일 oracle로 30건 모두 실제 제품 경로, Mission/G 원본 증거, 독립 출력 검증을 통과했다.'
      : '한 개 이상의 증거 게이트가 실패했으므로 30건 전체 해결을 주장할 수 없다.',
    limit: '이 판정은 고정 corpus가 다루는 로컬 bounded workflow와 캡처된 실행 환경의 증거다. 임의의 미래 명령, 실제 계정 권한, 외부 사이트 변화, 물리 장치, 네트워크 장애 전체의 무결함을 보장하지 않는다.'
  };
  await writeJson(join(outputRoot, 'integrated-report.json'), report);
  await writeFile(join(outputRoot, 'integrated-report.md'), renderIntegratedReport(report), 'utf8');
  await writeJson(join(outputRoot, 'reverification.json'), {
    version: IMPOSSIBLE_WORKFLOW_30_REVERIFY_VERSION, generatedAt: report.generatedAt, status: report.status,
    frozenChecks, finalImplementationBinding, baselineEvidence, finalEvidence, tamperNegative, gates
  });
  console.log(`INTEGRATED_REPORT_ROOT ${outputRoot}`);
  console.log(`FROZEN_CORPUS_SHA256 ${IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256}`);
  console.log(`FROZEN_ORACLE_SHA256 ${IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256}`);
  console.log(`BASELINE ${comparison.baselinePassed}/${comparison.total}`);
  console.log(`FINAL ${comparison.finalPassed}/${comparison.total}`);
  console.log(`RAW_PRODUCT_EVIDENCE ${finalEvidence.rawProductEvidencePassed}/${comparison.total}`);
  console.log(`REVERIFIED_ORACLES ${finalEvidence.oraclePassed}/${comparison.total}`);
  console.log(`TAMPER_NEGATIVE ${tamperNegative.passed ? 'PASS' : 'FAIL'}`);
  console.log(`STATUS ${report.status}`);
  if (!passed) process.exitCode = 1;
  return report;
}

async function verifyFrozenContracts({ baselineRoot, finalRoot, baselineCampaign, finalCampaign }) {
  const [baselineCorpus, finalCorpus, baselineOracle, finalOracle, baselineCommands, finalCommands] = await Promise.all([
    readJson(join(baselineRoot, 'command-corpus.json')),
    readJson(join(finalRoot, 'command-corpus.json')),
    readJson(join(baselineRoot, 'oracle-contracts.json')),
    readJson(join(finalRoot, 'oracle-contracts.json')),
    readFile(join(baselineRoot, 'commands.md')),
    readFile(join(finalRoot, 'commands.md'))
  ]);
  const baselineCorpusHash = canonicalHash(baselineCorpus);
  const finalCorpusHash = canonicalHash(finalCorpus);
  const baselineOracleHash = canonicalHash(baselineOracle);
  const finalOracleHash = canonicalHash(finalOracle);
  const expectedCommands = Buffer.from(renderCommands(impossibleWorkflow30Cases), 'utf8');
  const expectedIds = impossibleWorkflow30Cases.map((item) => item.id);
  const baselineCampaignIdentity = baselineCampaign.auditVersion === AUDIT_V1 && baselineCampaign.phase === 'baseline' && stableEqual(baselineCampaign.selectedCaseIds, expectedIds);
  const finalPayload = withoutKey(finalCampaign, 'campaignSha256');
  const finalCampaignIdentity = finalCampaign.auditVersion === AUDIT_V2 && finalCampaign.ledgerVersion === LEDGER_V2
    && finalCampaign.phase === 'final' && stableEqual(finalCampaign.selectedCaseIds, expectedIds)
    && finalCampaign.campaignSha256 === canonicalHash(finalPayload)
    && finalCampaign.fixtureSetSha256 === IMPOSSIBLE_WORKFLOW_30_FIXTURE_SHA256;
  const commandCorpusMatch = baselineCorpusHash === IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256
    && finalCorpusHash === IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256
    && baselineCampaign.fullCorpusSha256 === IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256
    && baselineCampaign.selectedCorpusSha256 === IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256
    && finalCampaign.fullCorpusSha256 === IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256
    && finalCampaign.selectedCorpusSha256 === IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256
    && baselineCampaignIdentity && finalCampaignIdentity;
  const oracleContractsMatch = baselineOracleHash === IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256
    && finalOracleHash === IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256
    && baselineCampaign.oracleContractsSha256 === IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256
    && finalCampaign.oracleContractsSha256 === IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256;
  const commandsFileMatch = baselineCommands.equals(expectedCommands) && finalCommands.equals(expectedCommands) && finalCampaign.commandsSha256 === sha256(finalCommands);
  return {
    commandCorpusMatch, oracleContractsMatch, commandsFileMatch,
    baselineCorpusHash, finalCorpusHash, baselineOracleHash, finalOracleHash,
    baselineCommandsSha256: sha256(baselineCommands), finalCommandsSha256: sha256(finalCommands),
    finalCampaignSha256Valid: finalCampaignIdentity
  };
}

export async function verifyCampaignEvidence(root, { phase, campaign: providedCampaign, report: providedReport } = {}) {
  root = resolve(root);
  const campaign = providedCampaign ?? await readJson(join(root, 'campaign.json'));
  const report = providedReport ?? await readJson(join(root, 'report.json'));
  const expectedIds = impossibleWorkflow30Cases.map((item) => item.id);
  const cases = [];
  let previousHash = 'GENESIS';
  for (const [index, testCase] of impossibleWorkflow30Cases.entries()) {
    const caseRoot = join(root, 'cases', testCase.id);
    try {
      const item = phase === 'baseline'
        ? await verifyLegacyBaselineCase({ testCase, caseRoot, sequence: index + 1, previousHash })
        : await verifyFinalCaseEvidence({ testCase, caseRoot, campaign, sequence: index + 1, previousHash });
      cases.push(item);
      previousHash = item.ledgerHash;
    } catch (error) {
      const [result, ledger] = await Promise.all([readJsonOrNull(join(caseRoot, 'result.json')), readJsonOrNull(join(caseRoot, 'ledger-entry.json'))]);
      cases.push({
        caseId: testCase.id, phase, valid: false, errors: [normalizeError(error)], ledgerValid: false,
        ledgerHash: ledger?.hash ?? null, routePassed: false, oraclePassed: false, fixtureIntegrity: false,
        evidenceManifestPassed: false, rawProductEvidencePassed: false, productPass: result?.productPass === true,
        outcome: result?.outcome, missionStatus: result?.missionStatus, actualToolNames: result?.actualToolNames ?? [],
        rootCause: result?.rootCause, durationMs: result?.durationMs, outputArtifacts: []
      });
      previousHash = typeof ledger?.hash === 'string' ? ledger.hash : `BROKEN:${testCase.id}`;
    }
  }
  const reportCheck = verifyStoredReport({ report, phase, cases, ledgerHead: previousHash });
  const selectedIdsValid = stableEqual(campaign.selectedCaseIds, expectedIds);
  const evidenceTreeSha256 = await hashTree(root);
  const rootCauses = countBy(cases.filter((item) => !item.productPass), (item) => item.rootCause?.code ?? 'UNKNOWN');
  const ledgerValid = cases.every((item) => item.ledgerValid) && report.ledgerHead === previousHash;
  const valid = selectedIdsValid && ledgerValid && reportCheck.passed && cases.every((item) => item.valid);
  return {
    phase, valid, selectedIdsValid, ledgerValid, ledgerHead: previousHash,
    reportValid: reportCheck.passed, reportErrors: reportCheck.errors,
    oraclePassed: cases.filter((item) => item.oraclePassed).length,
    fixturePassed: cases.filter((item) => item.fixtureIntegrity).length,
    evidenceManifestPassed: cases.filter((item) => item.evidenceManifestPassed).length,
    rawProductEvidencePassed: cases.filter((item) => item.rawProductEvidencePassed).length,
    rootCauses, evidenceTreeSha256,
    summary: { valid, validCases: cases.filter((item) => item.valid).length, invalidCases: cases.filter((item) => !item.valid).map(compactCaseFailure), reportValid: reportCheck.passed, ledgerValid },
    cases
  };
}

async function verifyLegacyBaselineCase({ testCase, caseRoot, sequence, previousHash }) {
  const [resultBytes, result, ledger, missionBytes, mission] = await Promise.all([
    readFile(join(caseRoot, 'result.json')),
    readJson(join(caseRoot, 'result.json')),
    readJson(join(caseRoot, 'ledger-entry.json')),
    readFile(join(caseRoot, 'mission-result.json')),
    readJson(join(caseRoot, 'mission-result.json'))
  ]);
  const expectedCommand = materializeImpossibleCommand(testCase, caseRoot);
  requireCondition(result.resultVersion === AUDIT_V1, 'BASELINE_RESULT_VERSION');
  requireExactIdentity(result, {
    phase: 'baseline', caseId: testCase.id, title: testCase.title, category: testCase.category,
    command: expectedCommand, corpusSha256: IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256,
    oracleContractsSha256: IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256, outcome: 'BASELINE_UNSUPPORTED',
    productPass: false, capabilityPresent: false, missionStatus: 'BLOCKED'
  }, 'BASELINE_RESULT_IDENTITY');
  requireCondition(result.rootCause?.code === 'WORKFLOW_CAPABILITY_NOT_REGISTERED', 'BASELINE_ROOT_CAUSE');
  const commandBytes = await readRegularFileInside(caseRoot, 'command.txt');
  requireCondition(commandBytes.equals(Buffer.from(`${expectedCommand}\n`, 'utf8')), 'BASELINE_COMMAND_BYTES');
  const fixture = await verifyFixtureBytes(caseRoot, testCase, result);
  const directOracle = await verifyImpossibleWorkflow30Case(testCase.id, caseRoot);
  requireCondition(directOracle.passed === false && result.oraclePass === false && result.oracle?.passed === false, 'BASELINE_ORACLE_MUST_FAIL');
  const missionEvidence = await verifyMissionAndRawAudit({ caseRoot, result, mission, command: expectedCommand, phase: 'baseline' });
  requireCondition(sha256(missionBytes).length === 64, 'BASELINE_MISSION_HASH');
  const expectedLedger = {
    sequence, phase: 'baseline', caseId: testCase.id, outcome: result.outcome,
    productPass: false, resultSha256: sha256(resultBytes), previousHash
  };
  requireCondition(stableEqual(withoutKey(ledger, 'hash'), expectedLedger) && ledger.hash === canonicalHash(expectedLedger), 'BASELINE_LEDGER_BINDING');
  return {
    caseId: testCase.id, phase: 'baseline', valid: true, errors: [], resultSha256: sha256(resultBytes),
    ledgerHash: ledger.hash, ledgerValid: true, routePassed: false, oraclePassed: false,
    oracleCheckCount: directOracle.checks?.length ?? 0, fixtureIntegrity: fixture.passed,
    evidenceManifestPassed: false, rawProductEvidencePassed: missionEvidence.passed,
    productPass: false, outcome: result.outcome, missionStatus: result.missionStatus,
    actualToolNames: result.actualToolNames ?? [], rootCause: result.rootCause, durationMs: result.durationMs,
    legacyEvidenceLimitation: 'mission/audit bytes were not bound by the original v1 ledger; this reverify records a retrospective tree hash',
    outputArtifacts: []
  };
}

async function verifyFinalCaseEvidence({ testCase, caseRoot, campaign, sequence, previousHash, overrides = {} }) {
  const resultBytes = overrides.resultBytes ?? await readFile(join(caseRoot, 'result.json'));
  const result = overrides.result ?? JSON.parse(resultBytes.toString('utf8'));
  const ledger = overrides.ledger ?? await readJson(join(caseRoot, 'ledger-entry.json'));
  const expectedCommand = materializeImpossibleCommand(testCase, caseRoot);
  const expectedFixture = createImpossibleWorkflow30ExpectedFixtureManifest(testCase);
  const expectedSpec = expectedFixture.files.find((item) => item.path === testCase.specFilename);
  requireCondition(result.resultVersion === AUDIT_V2, 'FINAL_RESULT_VERSION');
  requireExactIdentity(result, {
    phase: 'final', caseId: testCase.id, title: testCase.title, category: testCase.category,
    command: expectedCommand, commandSha256: sha256(Buffer.from(`${expectedCommand}\n`, 'utf8')),
    corpusSha256: IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256,
    oracleContractsSha256: IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256,
    fixtureSetSha256: IMPOSSIBLE_WORKFLOW_30_FIXTURE_SHA256,
    workflowSpecSha256: expectedSpec.sha256, inputManifestSha256: expectedFixture.inputManifestSha256,
    outcome: 'SUCCESS', productPass: true, missionPass: true, toolRoutePass: true,
    gEvidencePass: true, productPathEvidencePass: true, oraclePass: true,
    fixtureIntegrityPass: true, missionStatus: 'COMPLETED', capabilityPresent: true
  }, 'FINAL_RESULT_IDENTITY');
  requireCondition(result.rootCause?.code === 'NONE' && result.thrown === null, 'FINAL_ROOT_CAUSE');
  const commandBytes = await readRegularFileInside(caseRoot, 'command.txt');
  requireCondition(commandBytes.equals(Buffer.from(`${expectedCommand}\n`, 'utf8')) && sha256(commandBytes) === result.commandSha256, 'FINAL_COMMAND_BYTES');
  const fixture = await verifyFixtureBytes(caseRoot, testCase, result);
  const [missionBytes, oracleBytes, evidenceManifest] = await Promise.all([
    readRegularFileInside(caseRoot, 'mission-result.json'),
    readRegularFileInside(caseRoot, 'oracle-result.json'),
    readJson(join(caseRoot, 'case-evidence-manifest.json'))
  ]);
  requireCondition(sha256(missionBytes) === result.missionResultSha256 && sha256(oracleBytes) === result.oracleResultSha256, 'FINAL_RESULT_ARTIFACT_HASH');
  const evidenceCheck = await verifyCaseEvidenceManifest(caseRoot, evidenceManifest, result.evidenceManifestSha256);
  const mission = JSON.parse(missionBytes.toString('utf8'));
  const storedOracle = JSON.parse(oracleBytes.toString('utf8'));
  requireCondition(stableEqual(result.oracle, storedOracle), 'FINAL_ORACLE_DUPLICATE_BINDING');
  const directOracle = await verifyImpossibleWorkflow30Case(testCase.id, caseRoot);
  requireCondition(directOracle.passed === true && sameOracleDecision(storedOracle, directOracle), 'FINAL_DIRECT_ORACLE');
  const missionEvidence = await verifyMissionAndRawAudit({ caseRoot, result, mission, command: expectedCommand, phase: 'final', directOracle });
  const expectedLedger = {
    ledgerVersion: LEDGER_V2,
    campaignSha256: campaign.campaignSha256,
    corpusSha256: campaign.selectedCorpusSha256,
    oracleContractsSha256: campaign.oracleContractsSha256,
    fixtureSetSha256: campaign.fixtureSetSha256,
    implementationManifestSha256: campaign.implementationManifest.manifestSha256,
    sequence, phase: 'final', caseId: testCase.id,
    commandSha256: result.commandSha256, workflowSpecSha256: result.workflowSpecSha256,
    inputManifestSha256: result.inputManifestSha256, evidenceManifestSha256: result.evidenceManifestSha256,
    missionResultSha256: result.missionResultSha256, oracleResultSha256: result.oracleResultSha256,
    outcome: result.outcome, productPass: true, resultSha256: sha256(resultBytes), previousHash
  };
  requireCondition(stableEqual(withoutKey(ledger, 'hash'), expectedLedger) && ledger.hash === canonicalHash(expectedLedger), 'FINAL_LEDGER_BINDING');
  return {
    caseId: testCase.id, phase: 'final', valid: true, errors: [], resultSha256: sha256(resultBytes),
    ledgerHash: ledger.hash, ledgerValid: true, routePassed: missionEvidence.routePassed,
    oraclePassed: true, oracleCheckCount: directOracle.checks?.length ?? 0,
    fixtureIntegrity: fixture.passed, evidenceManifestPassed: evidenceCheck.passed,
    rawProductEvidencePassed: missionEvidence.passed, productPass: true, outcome: result.outcome,
    missionStatus: result.missionStatus, actualToolNames: result.actualToolNames,
    rootCause: result.rootCause, durationMs: result.durationMs,
    evidenceManifestSha256: evidenceManifest.manifestSha256,
    missionResultSha256: result.missionResultSha256, oracleResultSha256: result.oracleResultSha256,
    outputArtifacts: directOracle.artifacts.map((item) => ({ path: slash(relative(caseRoot, item.path)), size: item.size, sha256: item.sha256 }))
  };
}

async function verifyFixtureBytes(caseRoot, testCase, result) {
  const expected = createImpossibleWorkflow30ExpectedFixtureManifest(testCase);
  const checks = [];
  for (const entry of expected.files) {
    const bytes = await readRegularFileInside(caseRoot, entry.path);
    checks.push({ path: entry.path, passed: bytes.length === entry.size && sha256(bytes) === entry.sha256 });
  }
  requireCondition(checks.every((item) => item.passed), 'FIXTURE_BYTES_MISMATCH');
  if (result) {
    requireCondition(result.inputManifestSha256 === undefined || result.inputManifestSha256 === expected.inputManifestSha256, 'FIXTURE_MANIFEST_HASH');
    const recorded = result.fixtureIntegrity?.checks ?? [];
    requireCondition(recorded.length === expected.files.length, 'FIXTURE_RECORDED_COUNT');
    for (const entry of expected.files) {
      const item = recorded.find((candidate) => candidate.path === entry.path);
      requireCondition(item?.passed === true && item.expectedSha256 === entry.sha256 && item.actualSha256 === entry.sha256, `FIXTURE_RECORDED_ENTRY:${entry.path}`);
    }
    requireCondition(result.fixtureIntegrity?.passed === true && result.fixtureIntegrityPass === true, 'FIXTURE_RECORDED_PASS');
  }
  return { passed: true, inputManifestSha256: expected.inputManifestSha256, checks };
}

export async function verifyCaseEvidenceManifest(caseRoot, manifest, expectedHash) {
  requireCondition(manifest?.manifestVersion === EVIDENCE_V2, 'EVIDENCE_MANIFEST_VERSION');
  requireCondition(manifest.manifestSha256 === expectedHash, 'EVIDENCE_MANIFEST_RESULT_HASH');
  requireCondition(manifest.manifestSha256 === canonicalHash({ required: manifest.required, entries: manifest.entries }), 'EVIDENCE_MANIFEST_SELF_HASH');
  const paths = (manifest.entries ?? []).map((item) => item.path);
  requireCondition(paths.length > 0 && new Set(paths).size === paths.length, 'EVIDENCE_MANIFEST_DUPLICATE_PATH');
  requireCondition(stableEqual(paths, [...paths].sort()), 'EVIDENCE_MANIFEST_ORDER');
  requireCondition(stableEqual(manifest.required, EXPECTED_EVIDENCE_REQUIRED), 'EVIDENCE_REQUIRED_SET');
  const index = new Map(manifest.entries.map((item) => [item.path, item]));
  for (const required of EXPECTED_EVIDENCE_REQUIRED) requireCondition(index.has(required), `EVIDENCE_REQUIRED_FILE:${required}`);
  for (const entry of manifest.entries) {
    const bytes = await readRegularFileInside(caseRoot, entry.path);
    requireCondition(bytes.length === entry.size && sha256(bytes) === entry.sha256, `EVIDENCE_FILE_HASH:${entry.path}`);
  }
  const actualPaths = (await walkFiles(caseRoot)).map((path) => slash(relative(caseRoot, path)))
    .filter((path) => !['result.json', 'ledger-entry.json', 'case-evidence-manifest.json'].includes(path)).sort();
  requireCondition(stableEqual(paths, actualPaths), 'EVIDENCE_MANIFEST_FILE_SET');
  return { passed: true, count: paths.length, manifestSha256: manifest.manifestSha256 };
}

async function verifyMissionAndRawAudit({ caseRoot, result, mission, command, phase, directOracle }) {
  requireCondition(mission.objective === command && mission.status === result.missionStatus && typeof mission.missionId === 'string' && mission.missionId, 'MISSION_IDENTITY');
  const actions = asArray(mission.waves).flatMap((wave) => asArray(wave.actions));
  const observations = asArray(mission.observations);
  const distilledActions = actions.map((action) => ({
    actionId: action.actionId, taskId: action.taskId ?? null, status: action.status,
    expectedToolName: action.expectedToolName ?? null, actualToolName: action.actualToolName ?? null,
    observationId: action.observationId ?? null, error: action.error ?? null
  }));
  const distilledObservations = observations.map((observation) => ({
    observationId: observation.observationId, actionId: observation.actionId, outcome: observation.outcome,
    toolName: observation.toolName, evidenceId: observation.evidenceId,
    verification: observation.verification, error: observation.error
  }));
  requireCondition(actions.length > 0 && actions.every((action) => typeof action.taskId === 'string' && action.taskId), 'MISSION_ACTION_TASK_ID');
  requireCondition(stableEqual(distilledActions, result.actionEvidence), 'MISSION_ACTION_RESULT_BINDING');
  requireCondition(stableEqual(distilledObservations, result.observationEvidence), 'MISSION_OBSERVATION_RESULT_BINDING');
  const raw = {};
  const requiredForPhase = phase === 'final'
    ? REQUIRED_RAW_AUDIT_FILES
    : REQUIRED_RAW_AUDIT_FILES.filter((path) => !['audit/evidence.jsonl', 'audit/verification.jsonl'].includes(path));
  for (const path of requiredForPhase) {
    const bytes = await readRegularFileInside(caseRoot, path);
    requireCondition(bytes.length > 0, `RAW_AUDIT_EMPTY:${path}`);
    raw[path] = path.endsWith('.jsonl') ? parseJsonl(bytes, path) : JSON.parse(bytes.toString('utf8'));
  }
  const missionRecord = deepFind(raw['audit/missions.json'], (item) => item?.missionId === mission.missionId);
  requireCondition(missionRecord && missionRecord.objective === command && missionRecord.status === mission.status, 'RAW_MISSION_RECORD');
  const missionEvents = raw['audit/mission-events.jsonl'];
  requireCondition(missionEvents.some((event) => event?.missionId === mission.missionId), 'RAW_MISSION_EVENT_ID');
  for (const action of actions) {
    requireCondition(deepContains(raw['audit/core-orchestration.jsonl'], action.taskId), `RAW_CORE_TASK:${action.taskId}`);
    requireCondition(deepContains(raw['audit/executions.jsonl'], action.taskId), `RAW_EXECUTION_TASK:${action.taskId}`);
    requireCondition(deepContains(raw['audit/packet-journal.jsonl'], action.taskId), `RAW_PACKET_TASK:${action.taskId}`);
  }
  if (phase === 'baseline') {
    requireCondition(mission.status === 'BLOCKED' && result.productPass === false, 'BASELINE_MISSION_STATE');
    return { passed: true, routePassed: false };
  }
  requireCondition(actions.length === 1 && observations.length === 1, 'FINAL_SINGLE_ACTION_OBSERVATION');
  const action = actions[0];
  const observation = observations[0];
  requireCondition(action.status === 'succeeded' && action.expectedToolName === 'workflow.execute' && action.actualToolName === 'workflow.execute', 'FINAL_ACTION_ROUTE');
  requireCondition(stableEqual(result.actualToolNames, ['workflow.execute']) && stableEqual(result.expectedToolNames, ['workflow.execute']), 'FINAL_RESULT_ROUTE');
  requireCondition(observation.actionId === action.actionId && observation.taskId === action.taskId && observation.outcome === 'success' && observation.toolName === 'workflow.execute', 'FINAL_OBSERVATION_ROUTE');
  requireCondition(typeof observation.evidenceId === 'string' && observation.evidenceId && observation.verification?.status === 'passed' && observation.verification?.verificationId, 'FINAL_G_OBSERVATION');
  requireCondition(mission.completion?.status === 'verified', 'FINAL_MISSION_COMPLETION');
  const execution = raw['audit/executions.jsonl'].find((item) => item?.taskId === action.taskId
    && item?.status === 'COMPLETED' && item?.executionResult?.status === 'success'
    && item?.executionResult?.executedBy?.toolName === 'workflow.execute');
  requireCondition(execution, 'RAW_EXECUTION_WORKFLOW_SUCCESS');
  const executionEvidence = execution.executionResult?.evidence?.executionEvidence ?? execution.executionResult?.executionEvidence;
  requireCondition(executionEvidence?.taskId === action.taskId && executionEvidence?.evidenceId === observation.evidenceId
    && executionEvidence?.toolName === 'workflow.execute' && executionEvidence?.status === 'success', 'RAW_EXECUTION_EVIDENCE_BINDING');
  const evidence = raw['audit/evidence.jsonl'].find((item) => item?.evidenceId === observation.evidenceId
    && item?.taskId === action.taskId && item?.toolName === 'workflow.execute' && item?.status === 'success');
  requireCondition(evidence?.schemaValidation?.valid === true, 'RAW_G_EVIDENCE_SCHEMA');
  const verification = raw['audit/verification.jsonl'].find((item) => item?.verificationId === observation.verification.verificationId
    && item?.taskId === action.taskId && item?.status === 'passed');
  requireCondition(verification, 'RAW_G_VERIFICATION');
  const packets = raw['audit/packet-journal.jsonl'].filter((item) => item?.taskId === action.taskId && item?.toolName === 'workflow.execute');
  requireCondition(packets.some((item) => item.recordType === 'packet_received')
    && packets.some((item) => item.recordType === 'packet_result' && item.status === 'COMPLETED'), 'RAW_PACKET_LIFECYCLE');
  requireCondition(missionEvents.some((event) => event?.details?.actionId === action.actionId
    && event?.details?.taskId === action.taskId && event?.details?.toolName === 'workflow.execute'
    && event?.details?.verificationStatus === 'passed'), 'RAW_MISSION_ACTION_EVENT');
  requireCondition(!deepContains(raw['audit/executions.jsonl'], 'shell.execute'), 'RAW_SHELL_DOWNGRADE');
  const gFiles = asArray(evidence.files);
  const missionArtifacts = asArray(observation.artifacts);
  for (const artifact of directOracle?.artifacts ?? []) {
    const rel = slash(relative(caseRoot, artifact.path));
    const gMatch = gFiles.find((item) => samePath(item.path, artifact.path));
    const missionMatch = missionArtifacts.find((item) => item.relativePath === rel);
    requireCondition(gMatch?.sha256 === artifact.sha256 && gMatch?.size === artifact.size, `RAW_G_OUTPUT_HASH:${rel}`);
    requireCondition(missionMatch?.contentSha256 === artifact.sha256 && missionMatch?.outsideAllowedRoots === false, `MISSION_OUTPUT_HASH:${rel}`);
  }
  return { passed: true, routePassed: true, taskId: action.taskId, evidenceId: observation.evidenceId };
}

async function verifyExecutionImplementationBinding(campaign) {
  const errors = [];
  if (campaign.auditVersion !== AUDIT_V2 || campaign.ledgerVersion !== LEDGER_V2) errors.push('campaign-version');
  const manifest = campaign.implementationManifest;
  if (!manifest || manifest.manifestSha256 !== canonicalHash(manifest.files)) errors.push('manifest-self-hash');
  const paths = manifest?.files?.map((item) => item.path) ?? [];
  if (!stableEqual(paths, EXECUTION_IMPLEMENTATION_FILES)) errors.push('manifest-file-set-or-order');
  for (const entry of manifest?.files ?? []) {
    try {
      const bytes = await readFile(resolve(REPOSITORY_ROOT, entry.path));
      if (bytes.length !== entry.size || sha256(bytes) !== entry.sha256) errors.push(`source-mismatch:${entry.path}`);
    } catch (error) {
      errors.push(`source-missing:${entry.path}:${error.code ?? error.message}`);
    }
  }
  return { passed: errors.length === 0, manifestSha256: manifest?.manifestSha256 ?? null, errors };
}

function verifyStoredReport({ report, phase, cases, ledgerHead }) {
  const errors = [];
  const passed = cases.filter((item) => item.productPass).length;
  const failed = cases.length - passed;
  const expectedStatus = phase === 'baseline' ? 'BASELINE_CAPTURED' : 'PASSED';
  const forbiddenShell = cases.filter((item) => item.actualToolNames?.includes('shell.execute')).length;
  const rootCauses = countBy(cases.filter((item) => !item.productPass), (item) => item.rootCause?.code ?? 'UNKNOWN');
  if (report.phase !== phase) errors.push('phase');
  if (report.total !== 30 || report.passed !== passed || report.failed !== failed) errors.push('counts');
  if (report.status !== expectedStatus) errors.push('status');
  if (report.ledgerHead !== ledgerHead) errors.push('ledger-head');
  if (report.corpusSha256 !== IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256 || report.oracleContractsSha256 !== IMPOSSIBLE_WORKFLOW_30_ORACLE_SHA256) errors.push('contract-hashes');
  if (report.forbiddenShellDowngrades !== forbiddenShell) errors.push('shell-count');
  if (!stableEqual(report.rootCauses ?? {}, rootCauses)) errors.push('root-cause-counts');
  const reportCases = new Map(asArray(report.cases).map((item) => [item.caseId, item]));
  if (reportCases.size !== 30) errors.push('case-count');
  for (const item of cases) {
    const recorded = reportCases.get(item.caseId);
    if (!recorded || recorded.outcome !== item.outcome || recorded.productPass !== item.productPass
      || recorded.missionStatus !== item.missionStatus || !stableEqual(recorded.actualToolNames ?? [], item.actualToolNames ?? [])
      || recorded.rootCause?.code !== item.rootCause?.code) errors.push(`case-summary:${item.caseId}`);
  }
  return { passed: errors.length === 0, errors };
}

async function runTamperNegative({ finalRoot, outputRoot, finalCampaign }) {
  const tamperRoot = join(outputRoot, 'tamper-negative');
  await rm(tamperRoot, { recursive: true, force: true });
  await mkdir(tamperRoot, { recursive: true });
  const contracts = new Map(impossibleWorkflow30OracleContracts.map((item) => [item.caseId, item]));
  const caseResults = await Promise.all(impossibleWorkflow30Cases.map(async (testCase) => {
    const contract = contracts.get(testCase.id);
    const variants = {};
    for (const mode of ['primary-byte', 'primary-delete', 'proof-empty', 'proof-false']) {
      const root = join(tamperRoot, mode, testCase.id);
      await materializeImpossibleWorkflow30Fixture(testCase, root);
      await cp(join(finalRoot, 'cases', testCase.id, 'outputs'), join(root, 'outputs'), { recursive: true });
      const before = await verifyImpossibleWorkflow30Case(testCase.id, root);
      requireCondition(before.passed === true, `TAMPER_SOURCE_NOT_VALID:${mode}:${testCase.id}`);
      if (mode === 'primary-byte') {
        const path = join(root, 'outputs', contract.primary);
        await writeFile(path, Buffer.from('TAMPERED_PRIMARY_BYTES\n', 'utf8'));
      } else if (mode === 'primary-delete') {
        await rm(join(root, 'outputs', contract.primary), { force: true });
      } else if (mode === 'proof-empty') {
        await writeFile(join(root, 'outputs', contract.proof), '{}\n', 'utf8');
      } else {
        await writeFile(join(root, 'outputs', contract.proof), '{"passed":false}\n', 'utf8');
      }
      const after = await verifyImpossibleWorkflow30Case(testCase.id, root);
      variants[mode] = { detected: after.passed === false, failedCheckIds: after.checks.filter((item) => !item.passed).map((item) => item.checkId) };
    }
    return { caseId: testCase.id, variants };
  }));
  const counts = Object.fromEntries(['primary-byte', 'primary-delete', 'proof-empty', 'proof-false']
    .map((mode) => [mode, caseResults.filter((item) => item.variants[mode].detected).length]));

  const target = impossibleWorkflow30Cases.find((item) => item.id === 'IW10');
  const targetRoot = join(finalRoot, 'cases', target.id);
  const [originalResult, originalLedger] = await Promise.all([
    readJson(join(targetRoot, 'result.json')),
    readJson(join(targetRoot, 'ledger-entry.json'))
  ]);
  const forgedResult = { ...originalResult, actionEvidence: [], observationEvidence: [], productPathEvidencePass: true };
  const forgedResultBytes = Buffer.from(`${JSON.stringify(forgedResult, null, 2)}\n`, 'utf8');
  const forgedUnsignedLedger = { ...withoutKey(originalLedger, 'hash'), resultSha256: sha256(forgedResultBytes) };
  const forgedLedger = { ...forgedUnsignedLedger, hash: canonicalHash(forgedUnsignedLedger) };
  const forgedRehashedResultDetected = await rejects(async () => verifyFinalCaseEvidence({
    testCase: target, caseRoot: targetRoot, campaign: finalCampaign,
    sequence: originalLedger.sequence, previousHash: originalLedger.previousHash,
    overrides: { resultBytes: forgedResultBytes, result: forgedResult, ledger: forgedLedger }
  }));

  const missingMissionRoot = join(tamperRoot, 'missing-mission', 'IW10');
  await cp(targetRoot, missingMissionRoot, { recursive: true });
  await rm(join(missingMissionRoot, 'mission-result.json'), { force: true });
  const missingMissionDetected = await rejects(async () => verifyCaseEvidenceManifest(
    missingMissionRoot,
    await readJson(join(missingMissionRoot, 'case-evidence-manifest.json')),
    originalResult.evidenceManifestSha256
  ));
  const missingRawRoot = join(tamperRoot, 'missing-raw-g', 'IW10');
  await cp(targetRoot, missingRawRoot, { recursive: true });
  await rm(join(missingRawRoot, 'audit', 'verification.jsonl'), { force: true });
  const missingRawGDetected = await rejects(async () => verifyCaseEvidenceManifest(
    missingRawRoot,
    await readJson(join(missingRawRoot, 'case-evidence-manifest.json')),
    originalResult.evidenceManifestSha256
  ));

  const canonicalCorpus = createImpossibleWorkflow30CorpusFingerprint().canonicalPayload;
  const mutatedCorpus = structuredClone(canonicalCorpus);
  mutatedCorpus.cases[0].title = `${mutatedCorpus.cases[0].title} 변조`;
  const corpusMutationDetected = canonicalHash(mutatedCorpus) !== IMPOSSIBLE_WORKFLOW_30_CORPUS_SHA256;
  const checks = [
    gate('primary_byte_tamper_30_of_30', counts['primary-byte'] === 30, counts['primary-byte']),
    gate('primary_delete_30_of_30', counts['primary-delete'] === 30, counts['primary-delete']),
    gate('proof_empty_tamper_30_of_30', counts['proof-empty'] === 30, counts['proof-empty']),
    gate('proof_false_tamper_30_of_30', counts['proof-false'] === 30, counts['proof-false']),
    gate('forged_rehashed_result_rejected', forgedRehashedResultDetected, forgedRehashedResultDetected),
    gate('missing_mission_result_rejected', missingMissionDetected, missingMissionDetected),
    gate('missing_raw_g_journal_rejected', missingRawGDetected, missingRawGDetected),
    gate('mutated_corpus_rejected_by_frozen_hash', corpusMutationDetected, corpusMutationDetected)
  ];
  return {
    passed: checks.every((item) => item.passed), destructiveToEvidence: false, isolatedCopyRoot: tamperRoot,
    summary: { counts, forgedRehashedResultDetected, missingMissionDetected, missingRawGDetected, corpusMutationDetected },
    checks, cases: caseResults
  };
}

function compareCampaigns(baselineEvidence, finalEvidence) {
  const baselineById = new Map(baselineEvidence.cases.map((item) => [item.caseId, item]));
  const finalById = new Map(finalEvidence.cases.map((item) => [item.caseId, item]));
  const expectedIds = impossibleWorkflow30Cases.map((item) => item.id);
  const sameCaseIds = [baselineById, finalById].every((map) => map.size === 30 && expectedIds.every((id) => map.has(id)));
  const cases = impossibleWorkflow30Cases.map((testCase) => {
    const before = baselineById.get(testCase.id);
    const after = finalById.get(testCase.id);
    return {
      caseId: testCase.id, title: testCase.title, category: testCase.category, commandTemplate: testCase.commandTemplate,
      baseline: {
        outcome: before?.outcome, missionStatus: before?.missionStatus, actualToolNames: before?.actualToolNames,
        rootCause: before?.rootCause, durationMs: before?.durationMs, ledgerValid: before?.ledgerValid,
        rawEvidenceInternallyConsistent: before?.rawProductEvidencePassed
      },
      solutionApplied: solutionAppliedFor(testCase.category),
      final: {
        outcome: after?.outcome, missionStatus: after?.missionStatus, actualToolNames: after?.actualToolNames,
        oraclePassed: after?.oraclePassed, oracleCheckCount: after?.oracleCheckCount,
        fixtureIntegrity: after?.fixtureIntegrity, ledgerValid: after?.ledgerValid,
        evidenceManifestPassed: after?.evidenceManifestPassed,
        rawProductEvidencePassed: after?.rawProductEvidencePassed,
        outputArtifacts: after?.outputArtifacts, durationMs: after?.durationMs, errors: after?.errors
      }
    };
  });
  const baselinePassed = baselineEvidence.cases.filter((item) => item.productPass).length;
  const finalPassed = finalEvidence.cases.filter((item) => item.productPass && item.valid).length;
  return {
    total: 30, sameCaseIds, baselinePassed, baselineFailed: 30 - baselinePassed,
    finalPassed, finalFailed: 30 - finalPassed,
    improvementCount: cases.filter((item) => item.baseline.outcome !== 'SUCCESS' && item.final.outcome === 'SUCCESS' && item.final.rawProductEvidencePassed && item.final.oraclePassed).length,
    forbiddenShellDowngrades: finalEvidence.cases.filter((item) => item.actualToolNames?.includes('shell.execute')).length,
    baselineRootCauses: baselineEvidence.rootCauses, finalRootCauses: finalEvidence.rootCauses, cases
  };
}

function solutionAppliedFor(category) {
  const map = {
    'tabular-data': ['S2', 'S4', 'S5', 'S8'],
    'structured-data': ['S2', 'S4', 'S5', 'S8'],
    'exact-compute': ['S2', 'S4', 'S5', 'S8'],
    'workflow-control': ['S2', 'S3', 'S4', 'S6', 'S8'],
    'graph-solver': ['S2', 'S4', 'S5', 'S7', 'S8'],
    'filesystem-analysis': ['S2', 'S4', 'S5', 'S8'],
    'process-orchestration': ['S2', 'S4', 'S5', 'S8'],
    database: ['S2', 'S4', 'S5', 'S8']
  };
  return map[category] ?? ['S1', 'S2', 'S3', 'S4', 'S6', 'S8'];
}

async function createImplementationManifest() {
  const paths = [...new Set([...EXECUTION_IMPLEMENTATION_FILES, 'scripts/impossible-workflow-30-reverify.mjs'])];
  const files = [];
  for (const path of paths) {
    const absolute = resolve(REPOSITORY_ROOT, path);
    const [bytes, info] = await Promise.all([readFile(absolute), stat(absolute)]);
    files.push({ role: IMPLEMENTATION_ROLES[path] ?? 'campaign-implementation', path, size: info.size, sha256: sha256(bytes) });
  }
  return { files, manifestSha256: canonicalHash(files) };
}

function renderIntegratedReport(report) {
  const negative = report.tamperNegative.summary ?? {};
  const lines = [
    '# JARVIS 불가능 명령 30건 구조 개선 통합 보고서', '',
    `- 최종 판정: **${report.status}**`,
    `- 동일 명령 baseline: **${report.beforeAfter.baselinePassed}/30 성공, ${report.beforeAfter.baselineFailed}/30 실패**`,
    `- 구조 개선 후: **${report.beforeAfter.finalPassed}/30 성공, ${report.beforeAfter.finalFailed}/30 실패**`,
    `- 개선 전환: **${report.beforeAfter.improvementCount}/30**`,
    `- Mission/G 원본 증거: **${report.gates.find((item) => item.gateId === 'mission_and_raw_g_evidence_30_of_30')?.passed ? '30/30 통과' : '실패'}**`,
    `- 독립 오라클 재검증: **${report.gates.find((item) => item.gateId === 'independent_oracle_reverification_30_of_30')?.passed ? '30/30 통과' : '실패'}**`,
    `- shell.execute 강등: **${report.beforeAfter.forbiddenShellDowngrades}건**`,
    `- 명령 corpus SHA-256: \`${report.frozenEvidence.corpusSha256}\``,
    `- oracle 계약 SHA-256: \`${report.frozenEvidence.oracleContractsSha256}\``,
    `- fixture set SHA-256: \`${report.frozenEvidence.fixtureSetSha256}\``, '',
    '## 무엇이 바뀌었나', ''
  ];
  for (const change of report.structuralChanges) lines.push(`- **${change.id} ${change.title}**: ${change.behavior}`);
  lines.push('', '## 30개 명령의 전후 결과', '', '| ID | 명령 | 분야 | 개선 전 | 실패 원인 | 적용 구조 | 개선 후 | Mission/G | 오라클 | 산출물 |', '|---|---|---|---:|---|---|---:|---:|---:|---|');
  for (const item of report.cases) {
    const artifacts = item.final.outputArtifacts?.map((artifact) => `${artifact.path} (${artifact.size}B, ${artifact.sha256.slice(0, 10)}…)`).join('<br>') ?? '-';
    lines.push(`| ${item.caseId} | ${cell(item.title)} | ${cell(item.category)} | 실패 | ${cell(item.baseline.rootCause?.code ?? '-')} | ${item.solutionApplied.join(', ')} | ${item.final.outcome === 'SUCCESS' && item.final.oraclePassed ? '성공' : '실패'} | ${item.final.rawProductEvidencePassed ? '통과' : '실패'} | ${item.final.oraclePassed ? '통과' : '실패'} | ${cell(artifacts)} |`);
  }
  lines.push(
    '', '## S8 증거 체인과 공격 검증', '',
    'S8은 저장된 `SUCCESS`나 보고서 합계만 신뢰하지 않는다. command/spec/fixture와 실행 당시 제품 소스, `mission-result.json`, 원본 execution/evidence/verification/packet journal, 독립 oracle 결과, case evidence manifest, 순차 ledger를 다시 해시하고 서로의 식별자를 교차 확인한다.', '',
    `- primary 바이트 변조 탐지: **${negative.counts?.['primary-byte'] ?? 0}/30**`,
    `- primary 삭제 탐지: **${negative.counts?.['primary-delete'] ?? 0}/30**`,
    `- 빈 proof 탐지: **${negative.counts?.['proof-empty'] ?? 0}/30**`,
    `- passed=false proof 탐지: **${negative.counts?.['proof-false'] ?? 0}/30**`,
    `- 결과와 ledger를 함께 재해시한 위조 탐지: **${negative.forgedRehashedResultDetected ? '통과' : '실패'}**`,
    `- Mission 원본 누락 탐지: **${negative.missingMissionDetected ? '통과' : '실패'}**`,
    `- G verification 원장 누락 탐지: **${negative.missingRawGDetected ? '통과' : '실패'}**`, '',
    '## 독립 재검증 게이트', '', '| 게이트 | 결과 |', '|---|---:|'
  );
  for (const gateItem of report.gates) lines.push(`| ${cell(gateItem.gateId)} | ${gateItem.passed ? '통과' : '실패'} |`);
  lines.push(
    '', '## 실패 원인과 해결', '',
    'baseline 30건의 공통 직접 원인은 `WORKFLOW_CAPABILITY_NOT_REGISTERED`였다. 당시 제품에는 workflow 명세를 typed DAG로 읽고 조합 실행하는 제품 경로가 없었다. S1–S7이 실행 경로와 완료 판정을 구현했고, S8이 재개·증거·보고서 위조에 대한 실패 폐쇄 검증을 추가했다.', '',
    'baseline은 v1 결과 ledger가 Mission/audit 원본 바이트를 당시 직접 결속하지 않았다는 한계가 있다. 이번 재검증은 기존 result chain을 검증한 뒤 모든 원본 간 식별자 일관성을 검사하고 현재 전체 증거 트리 SHA-256을 별도로 기록했다. final은 v2 ledger가 그 원본 해시를 실행 시점부터 직접 결속한다.', '',
    '## 30개 전체 자연어 명령 부록', ''
  );
  for (const item of report.cases) lines.push(`### ${item.caseId} — ${item.title}`, '', item.commandTemplate, '');
  lines.push('## 증거 해석', '', report.conclusion, '', report.limit, '');
  return `${lines.join('\n')}\n`;
}

export function canonicalHash(value) { return sha256(Buffer.from(stableStringify(value), 'utf8')); }
export function verifyLedgerEntry(ledger, resultBytes, expectedPreviousHash) {
  const unsigned = withoutKey(ledger, 'hash');
  return ledger.previousHash === expectedPreviousHash && ledger.resultSha256 === sha256(resultBytes) && ledger.hash === canonicalHash(unsigned);
}

function sameOracleDecision(stored, direct) {
  const normalize = (oracle) => ({
    oracleVersion: oracle?.oracleVersion,
    oracleContractsSha256: oracle?.oracleContractsSha256,
    caseId: oracle?.caseId, passed: oracle?.passed,
    checks: asArray(oracle?.checks).map((item) => ({ checkId: item.checkId, passed: item.passed })),
    artifacts: asArray(oracle?.artifacts).map((item) => ({ path: slash(item.path), size: item.size, sha256: item.sha256 }))
  });
  return stableEqual(normalize(stored), normalize(direct));
}

async function readRegularFileInside(root, relativePath) {
  requireCondition(typeof relativePath === 'string' && relativePath && !isAbsolute(relativePath), `UNSAFE_RELATIVE_PATH:${relativePath}`);
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, relativePath);
  const rel = relative(absoluteRoot, target);
  requireCondition(rel !== '..' && !rel.startsWith(`..\\`) && !rel.startsWith('../') && !isAbsolute(rel), `PATH_ESCAPE:${relativePath}`);
  const info = await lstat(target);
  requireCondition(info.isFile() && !info.isSymbolicLink(), `NOT_REGULAR_FILE:${relativePath}`);
  const [rootReal, targetReal] = await Promise.all([realpath(absoluteRoot), realpath(target)]);
  const realRel = relative(rootReal, targetReal);
  requireCondition(realRel !== '..' && !realRel.startsWith(`..\\`) && !realRel.startsWith('../') && !isAbsolute(realRel), `REALPATH_ESCAPE:${relativePath}`);
  return readFile(target);
}

async function walkFiles(root) {
  const output = [];
  const queue = [resolve(root)];
  while (queue.length) {
    const directory = queue.shift();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) queue.push(path);
      else output.push(path);
    }
  }
  return output.sort((a, b) => slash(relative(root, a)).localeCompare(slash(relative(root, b))));
}

async function hashTree(root) {
  const entries = [];
  for (const path of await walkFiles(root)) {
    const rel = slash(relative(root, path));
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) entries.push({ path: rel, type: 'non-regular' });
    else {
      const bytes = await readFile(path);
      entries.push({ path: rel, size: bytes.length, sha256: sha256(bytes) });
    }
  }
  return canonicalHash(entries);
}

function parseJsonl(bytes, path) {
  const lines = bytes.toString('utf8').split(/\r?\n/u).filter((line) => line.trim());
  requireCondition(lines.length > 0, `JSONL_EMPTY:${path}`);
  return lines.map((line, index) => {
    try { return JSON.parse(line); } catch (error) { throw codedError(`JSONL_INVALID:${path}:${index + 1}`, error.message); }
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

function requireExactIdentity(actual, expected, code) {
  for (const [key, value] of Object.entries(expected)) requireCondition(stableEqual(actual[key], value), `${code}:${key}`);
}
function requireCondition(condition, code) { if (!condition) throw codedError(code); }
async function rejects(fn) { try { await fn(); return false; } catch { return true; } }
function compactCaseFailure(item) { return { caseId: item.caseId, errors: item.errors ?? [], outcome: item.outcome }; }
function normalizeError(error) { return { code: error?.code ?? 'ERROR', message: error?.message ?? String(error) }; }
function codedError(code, detail = '') { const error = new Error(detail ? `${code}: ${detail}` : code); error.code = code.split(':')[0]; return error; }
function gate(gateId, passed, evidence) { return { gateId, passed: passed === true, evidence }; }
function cell(value) { return String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/gu, ' '); }
function slash(value) { return String(value).replaceAll('\\', '/'); }
function samePath(left, right) { return resolve(String(left)).toLowerCase() === resolve(String(right)).toLowerCase(); }
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function stableStringify(value) { if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`; if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`; return JSON.stringify(value); }
function stableEqual(left, right) { return stableStringify(left) === stableStringify(right); }
function withoutKey(value, key) { return Object.fromEntries(Object.entries(value).filter(([name]) => name !== key)); }
function asArray(value) { return Array.isArray(value) ? value : value == null ? [] : [value]; }
function countBy(items, keyFn) { return items.reduce((counts, item) => { const key = keyFn(item); counts[key] = (counts[key] ?? 0) + 1; return counts; }, {}); }
function renderCommands(items) { return `# 고정 불가능 명령 30건\n\n${items.map((item) => `## ${item.id} — ${item.title}\n\n${item.commandTemplate}\n`).join('\n')}`; }
async function readJson(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function readJsonOrNull(path) { try { return await readJson(path); } catch { return null; } }
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }

function parseArguments(argv) {
  const baselineRoot = valueAfter(argv, '--baseline-root');
  const finalRoot = valueAfter(argv, '--final-root');
  if (!baselineRoot || !finalRoot) throw new Error('Required: --baseline-root <path> --final-root <path>.');
  return { baselineRoot, finalRoot, outputRoot: valueAfter(argv, '--output-root') };
}
function valueAfter(argv, flag) { const index = argv.indexOf(flag); return index >= 0 ? argv[index + 1] : null; }

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  await runImpossibleWorkflow30Reverify(process.argv.slice(2));
}
